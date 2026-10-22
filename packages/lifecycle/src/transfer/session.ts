import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { DB_NAME_MAX, assertDomainUnique, defaultPlan, fail, isXpanelError, planErrors } from '@xpanel/core'
import { isPhpVersion } from '@xpanel/os'
import { parseSemver } from '../upgrade/semver.ts'
import { assertDomain, assertId, assertSourceDbName, assertText, exactKeys, isDomain, isIsoDate, isNonNegInt, isObj, isUsername, isUsernameSyntax } from '../validate.ts'

// xPanel -> xPanel transfer session: a pure reducer over explicit events. The executor
// performs the side effects and feeds results back as events, so every state the UI
// shows is reproducible from the event log.

export type TransferAuth =
  | { kind: 'ssh-key'; host: string; port: number; user: string; keyId: string; hostKeyFingerprint: string }
  | { kind: 'api-token'; url: string; tokenId: string; tlsFingerprint: string | null }

export interface SourceAccount {
  username: string
  uid: number
  primaryDomain: string
  domains: string[]
  plan: string
  diskBytes: number
  databases: string[]
  mailboxes: number
  phpVersions: string[]
}

export interface SourcePlan {
  name: string
}

/** What already exists on this server. */
export interface LocalInventory {
  usernames: string[]
  domains: string[]
  uids: number[]
  plans: string[]
}

export type ConflictKind = 'username' | 'domain' | 'uid' | 'plan'
export type ResolutionAction = 'rename' | 'skip' | 'new-uid' | 'drop-domain' | 'map-plan'
export type Resolution =
  | { action: 'rename'; to: string }
  | { action: 'skip' }
  | { action: 'new-uid' }
  | { action: 'drop-domain' }
  | { action: 'map-plan'; to: string }

export interface Conflict {
  id: string
  kind: ConflictKind
  /** source account username, or plan name for plan conflicts */
  subject: string
  value: string
  choices: ResolutionAction[]
  detail: string
}

export type SessionState = 'created' | 'connected' | 'inventoried' | 'selected' | 'reviewed' | 'applying' | 'completed' | 'failed' | 'cancelled'
export type AccountPhase = 'pending' | 'exporting' | 'copying' | 'importing' | 'reconciling' | 'done' | 'failed' | 'skipped'

export interface AccountProgress {
  targetUsername: string
  phase: AccountPhase
  bytes: number
  totalBytes: number
  error: string | null
}

export interface TransferSession {
  id: string
  actor: string
  createdAt: string
  updatedAt: string
  state: SessionState
  auth: TransferAuth
  source: { hostname: string; version: string } | null
  inventory: { accounts: SourceAccount[]; plans: SourcePlan[] } | null
  local: LocalInventory | null
  selection: { accounts: string[]; plans: string[] }
  conflicts: Conflict[]
  resolutions: Record<string, Resolution>
  reviewDigest: string | null
  progress: Record<string, AccountProgress>
  log: { at: string; event: string; detail: string }[]
  error: string | null
}

export type TransferEvent =
  | { type: 'connected'; source: { hostname: string; version: string } }
  | { type: 'inventory'; accounts: SourceAccount[]; plans: SourcePlan[] }
  | { type: 'select'; accounts: string[]; plans: string[]; local: LocalInventory }
  | { type: 'resolve'; conflictId: string; resolution: Resolution }
  | { type: 'review' }
  | { type: 'confirm'; digest: string }
  | { type: 'progress'; account: string; phase: AccountPhase; bytes?: number; error?: string }
  | { type: 'complete' }
  | { type: 'fail'; reason: string }
  | { type: 'cancel' }

const TERMINAL: ReadonlySet<SessionState> = new Set(['completed', 'failed', 'cancelled'])
const FINISHED_PHASES: ReadonlySet<AccountPhase> = new Set(['done', 'failed', 'skipped'])
const PHASE_ORDER: readonly AccountPhase[] = ['pending', 'exporting', 'copying', 'importing', 'reconciling', 'done']
/** Field names that would carry a password or raw secret; the session stores ids of stored keys only. */
const SECRET_KEY = /pass(word|wd|phrase)?$|^pwd$|secret|^token$|private.?key|^key$|credential/i
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/
const TLS_FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/
const MAX_ACCOUNTS = 5000
const MAX_LOG = 5000

export const isPlanName = (v: unknown): v is string => typeof v === 'string' && planErrors(defaultPlan({ name: v })).length === 0

/** Sessions that block an upgrade: anything past creation and not finished. */
export const isActiveTransfer = (s: TransferSession): boolean => !TERMINAL.has(s.state) && s.state !== 'created'
export const countActiveTransfers = (sessions: TransferSession[]): number => sessions.filter(isActiveTransfer).length

/** Rejects any field that looks like a password or raw secret, at any depth. */
export const assertNoSecrets = (v: unknown, path = 'input', depth = 0): void => {
  if (depth > 8 || typeof v !== 'object' || v === null) return
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEY.test(k)) fail('VALIDATION', `${path}.${k} looks like a secret; store it in the secret store and pass its id`, { field: `${path}.${k}` })
    assertNoSecrets(x, `${path}.${k}`, depth + 1)
  }
}

const isRemoteHost = (v: unknown): v is string => typeof v === 'string' && (isDomain(v) || isIP(v) !== 0)

const parseSshAuth = (a: Record<string, unknown>): TransferAuth => {
  exactKeys(a, ['kind', 'host', 'port', 'user', 'keyId', 'hostKeyFingerprint'], 'ssh auth')
  if (!isRemoteHost(a.host)) fail('VALIDATION', 'invalid source host')
  if (!Number.isInteger(a.port) || (a.port as number) < 1 || (a.port as number) > 65535) fail('VALIDATION', 'invalid ssh port')
  if (typeof a.user !== 'string' || !(a.user === 'root' || isUsername(a.user))) fail('VALIDATION', 'invalid ssh user')
  if (typeof a.hostKeyFingerprint !== 'string' || !SSH_FINGERPRINT.test(a.hostKeyFingerprint)) fail('VALIDATION', 'a pinned SHA256 host key fingerprint is required')
  return { kind: 'ssh-key', host: a.host as string, port: a.port as number, user: a.user as string, keyId: assertId(a.keyId, 'key id'), hostKeyFingerprint: a.hostKeyFingerprint as string }
}

const parseApiAuth = (a: Record<string, unknown>): TransferAuth => {
  exactKeys(a, ['kind', 'url', 'tokenId', 'tlsFingerprint'], 'api auth')
  let u: URL
  try {
    u = new URL(String(a.url))
  } catch {
    return fail('VALIDATION', 'invalid source url')
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail('VALIDATION', 'source url must be https without credentials, query or fragment')
  if (!isRemoteHost(u.hostname.replace(/^\[|\]$/g, ''))) fail('VALIDATION', 'invalid source url host')
  const fp = a.tlsFingerprint ?? null
  if (fp !== null && (typeof fp !== 'string' || !TLS_FINGERPRINT.test(fp))) fail('VALIDATION', 'invalid TLS fingerprint')
  return { kind: 'api-token', url: u.origin + u.pathname.replace(/\/+$/, ''), tokenId: assertId(a.tokenId, 'token id'), tlsFingerprint: fp as string | null }
}

/** SSH key or API token, both by reference to the secret store: no source password is ever kept. */
export const parseTransferAuth = (raw: unknown): TransferAuth => {
  assertNoSecrets(raw, 'auth')
  if (!isObj(raw)) return fail('VALIDATION', 'auth must be ssh-key or api-token')
  if (raw.kind === 'ssh-key') return parseSshAuth(raw)
  if (raw.kind === 'api-token') return parseApiAuth(raw)
  return fail('VALIDATION', 'auth must be ssh-key or api-token')
}

const assertNow = (now: unknown): string => (isIsoDate(now) ? now : fail('VALIDATION', 'now must be an RFC 3339 UTC timestamp'))

export const createTransferSession = (input: { id: string; actor: string; now: string; auth: unknown }): TransferSession => ({
  id: assertId(input.id, 'session id'),
  actor: assertText(input.actor, 'actor', 128),
  createdAt: assertNow(input.now),
  updatedAt: input.now,
  state: 'created',
  auth: parseTransferAuth(input.auth),
  source: null,
  inventory: null,
  local: null,
  selection: { accounts: [], plans: [] },
  conflicts: [],
  resolutions: {},
  reviewDigest: null,
  progress: {},
  log: [],
  error: null,
})

const checkSourceAccount = (a: SourceAccount): void => {
  // source names follow the shared syntax; local reservations surface as conflicts instead
  if (!isUsernameSyntax(a?.username)) fail('VALIDATION', 'invalid source account name')
  const who = a.username
  if (!isNonNegInt(a.uid)) fail('VALIDATION', `invalid uid for ${who}`)
  assertDomain(a.primaryDomain, `primary domain of ${who}`)
  if (!Array.isArray(a.domains) || a.domains.length > 5000 || !a.domains.includes(a.primaryDomain)) fail('VALIDATION', `invalid domains for ${who}`)
  for (const d of a.domains) assertDomain(d, `domain of ${who}`)
  if (new Set(a.domains).size !== a.domains.length) fail('VALIDATION', `duplicate domain for ${who}`)
  if (!isPlanName(a.plan)) fail('VALIDATION', `invalid plan for ${who}`)
  if (!isNonNegInt(a.diskBytes) || !isNonNegInt(a.mailboxes)) fail('VALIDATION', `invalid sizes for ${who}`)
  if (!Array.isArray(a.databases) || a.databases.length > 10_000) fail('VALIDATION', `invalid databases for ${who}`)
  for (const d of a.databases) assertSourceDbName(d, who, DB_NAME_MAX)
  if (!Array.isArray(a.phpVersions) || !a.phpVersions.every((v) => typeof v === 'string' && /^\d\.\d{1,2}$/.test(v))) fail('VALIDATION', `invalid PHP versions for ${who}`)
}

const checkInventory = (accounts: SourceAccount[], plans: SourcePlan[]): void => {
  if (!Array.isArray(accounts) || !Array.isArray(plans) || accounts.length > MAX_ACCOUNTS || plans.length > MAX_ACCOUNTS) fail('VALIDATION', 'invalid inventory')
  const names = new Set<string>()
  const owner = new Map<string, string>()
  for (const a of accounts) {
    checkSourceAccount(a)
    if (names.has(a.username)) fail('VALIDATION', `duplicate source account ${a.username}`)
    names.add(a.username)
    for (const d of a.domains) {
      const prev = owner.get(d)
      if (prev) fail('VALIDATION', `source lists ${d} under both ${prev} and ${a.username}`)
      owner.set(d, a.username)
    }
  }
  if (plans.some((p) => !isPlanName(p?.name)) || new Set(plans.map((p) => p.name)).size !== plans.length) fail('VALIDATION', 'invalid source plan list')
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

export const checkLocalInventory = (l: LocalInventory): LocalInventory => {
  const ok = isObj(l) && isStringList(l.usernames) && isStringList(l.domains) && isStringList(l.plans) && Array.isArray(l.uids) && l.uids.every(isNonNegInt)
  return ok ? { usernames: [...l.usernames], domains: [...l.domains], uids: [...l.uids], plans: [...l.plans] } : fail('VALIDATION', 'local inventory required')
}

interface LocalDomainIndex {
  owned: { name: string; accountId: string }[]
  names: ReadonlySet<string>
  /** every proper parent of a local name, to find source names that sit above one */
  parents: ReadonlySet<string>
}

/** a.b.example.com -> [b.example.com, example.com]; never the bare TLD */
const parentsOf = (d: string): string[] => {
  const labels = d.split('.')
  const out: string[] = []
  for (let i = 1; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'))
  return out
}

const indexLocalDomains = (domains: readonly string[]): LocalDomainIndex => ({
  owned: domains.map((name) => ({ name, accountId: 'local' })),
  names: new Set(domains),
  parents: new Set(domains.flatMap(parentsOf)),
})

/**
 * Exact names, www twins and names above or below a local domain conflict (core rule:
 * another tenant could take over the zone). The index only finds candidates quickly;
 * the verdict and its message come from core assertDomainUnique.
 */
const domainClash = (d: string, local: LocalDomainIndex): string | null => {
  const candidate = local.names.has(d) || local.names.has(`www.${d}`) || (d.startsWith('www.') && local.names.has(d.slice(4))) ||
    local.parents.has(d) || parentsOf(d).some((p) => local.names.has(p))
  if (!candidate) return null
  try {
    assertDomainUnique(d, local.owned)
    return null
  } catch (e) {
    if (isXpanelError(e) && e.code === 'CONFLICT') return e.message
    throw e
  }
}

/** For each name that may not be created next to the local domains: the name and why (core rule). */
export const localDomainConflicts = (names: readonly string[], localDomains: readonly string[]): { name: string; detail: string }[] => {
  const index = indexLocalDomains(localDomains)
  return names.flatMap((name) => {
    const detail = domainClash(name, index)
    return detail ? [{ name, detail }] : []
  })
}

/** Collisions between the selection and this server; uid clashes are pre-resolved to a new uid. */
export const detectConflicts = (accounts: SourceAccount[], plans: string[], local: LocalInventory): Conflict[] => {
  const out: Conflict[] = []
  const users = new Set(local.usernames)
  const uids = new Set(local.uids)
  const localPlans = new Set(local.plans)
  const localDomains = indexLocalDomains(local.domains)
  for (const a of accounts) {
    if (users.has(a.username) || !isUsername(a.username)) {
      out.push({ id: `username:${a.username}`, kind: 'username', subject: a.username, value: a.username, choices: ['rename', 'skip'], detail: users.has(a.username) ? 'an account with this name exists here' : 'this name is reserved here' })
    }
    if (uids.has(a.uid)) out.push({ id: `uid:${a.username}`, kind: 'uid', subject: a.username, value: String(a.uid), choices: ['new-uid', 'skip'], detail: 'uid is taken here; a new uid is allocated on import' })
    for (const d of a.domains) {
      const clash = domainClash(d, localDomains)
      if (clash) out.push({ id: `domain:${a.username}:${d}`, kind: 'domain', subject: a.username, value: d, choices: d === a.primaryDomain ? ['skip'] : ['drop-domain', 'skip'], detail: clash })
    }
    if (!plans.includes(a.plan) && !localPlans.has(a.plan)) {
      out.push({ id: `plan-missing:${a.username}`, kind: 'plan', subject: a.username, value: a.plan, choices: ['map-plan', 'skip'], detail: 'plan is neither selected nor present here' })
    }
  }
  for (const p of plans) {
    if (localPlans.has(p)) out.push({ id: `plan:${p}`, kind: 'plan', subject: p, value: p, choices: ['map-plan', 'rename', 'skip'], detail: 'a plan with this name exists here' })
  }
  return out
}

const skippedAccounts = (s: TransferSession): Set<string> => {
  const out = new Set<string>()
  for (const c of s.conflicts) {
    if (s.resolutions[c.id]?.action !== 'skip') continue
    if (c.id.startsWith('plan:')) {
      for (const a of s.inventory?.accounts ?? []) if (a.plan === c.subject && s.selection.accounts.includes(a.username)) out.add(a.username)
    } else out.add(c.subject)
  }
  return out
}

export const targetUsername = (s: TransferSession, source: string): string => {
  const r = s.resolutions[`username:${source}`]
  return r?.action === 'rename' ? r.to : source
}

const validateResolution = (s: TransferSession, c: Conflict, r: Resolution): void => {
  if (!isObj(r) || !c.choices.includes(r.action)) fail('VALIDATION', `${String((r as { action?: unknown })?.action)} is not a valid choice for ${c.id}`)
  const local = s.local as LocalInventory
  exactKeys(r as unknown as Record<string, unknown>, r.action === 'rename' || r.action === 'map-plan' ? ['action', 'to'] : ['action'], 'resolution')
  if (r.action === 'rename' && c.kind === 'username') {
    if (!isUsername(r.to)) fail('VALIDATION', `invalid new username ${String(r.to).slice(0, 40)}`)
    if (local.usernames.includes(r.to)) fail('CONFLICT', `${r.to} already exists here`)
    const taken = s.selection.accounts.filter((a) => a !== c.subject).map((a) => targetUsername(s, a))
    if (taken.includes(r.to)) fail('CONFLICT', `${r.to} is already used by another transferred account`)
  }
  if (r.action === 'rename' && c.kind === 'plan') {
    if (!isPlanName(r.to)) fail('VALIDATION', 'invalid plan name')
    if (local.plans.includes(r.to) || s.selection.plans.includes(r.to)) fail('CONFLICT', `plan ${r.to} already exists`)
  }
  if (r.action === 'map-plan' && !(local.plans.includes(r.to) || s.selection.plans.includes(r.to))) fail('VALIDATION', `plan ${String(r.to).slice(0, 64)} does not exist`)
}

export interface ReviewAccount {
  source: string
  target: string
  plan: string
  domains: string[]
  droppedDomains: string[]
  databases: string[]
  mailboxes: number
  diskBytes: number
  /** imports always allocate a fresh uid, slice and vhosts here */
  uid: 'new'
  /** source PHP versions this server does not ship; those sites get the default version */
  phpFallback: string[]
}

export interface TransferReview {
  source: { hostname: string; version: string }
  accounts: ReviewAccount[]
  skipped: string[]
  plans: { source: string; action: 'create' | 'map' | 'rename'; target: string }[]
  sharedServices: 'reload-only'
}

export const buildReview = (s: TransferSession): TransferReview => {
  const skipped = skippedAccounts(s)
  const planTarget = (p: string): string => {
    const r = s.resolutions[`plan:${p}`]
    return r?.action === 'map-plan' || r?.action === 'rename' ? r.to : p
  }
  const accounts = (s.inventory?.accounts ?? [])
    .filter((a) => s.selection.accounts.includes(a.username) && !skipped.has(a.username))
    .map((a): ReviewAccount => {
      const dropped = a.domains.filter((d) => s.resolutions[`domain:${a.username}:${d}`]?.action === 'drop-domain')
      const missing = s.resolutions[`plan-missing:${a.username}`]
      return {
        source: a.username,
        target: targetUsername(s, a.username),
        // a mapping names a plan as it is called here after the transfer (a local name wins: a selected
        // source plan of the same name is renamed, mapped or skipped because of it)
        plan: missing?.action === 'map-plan' ? missing.to : planTarget(a.plan),
        domains: a.domains.filter((d) => !dropped.includes(d)),
        droppedDomains: dropped,
        databases: [...a.databases],
        mailboxes: a.mailboxes,
        diskBytes: a.diskBytes,
        uid: 'new',
        phpFallback: a.phpVersions.filter((v) => !isPhpVersion(v)),
      }
    })
  const plans = s.selection.plans.flatMap((p) => {
    const r = s.resolutions[`plan:${p}`]
    if (r?.action === 'skip') return []
    return [{ source: p, action: r?.action === 'map-plan' ? 'map' as const : r?.action === 'rename' ? 'rename' as const : 'create' as const, target: planTarget(p) }]
  })
  return { source: s.source as { hostname: string; version: string }, accounts, skipped: [...skipped].sort(), plans, sharedServices: 'reload-only' }
}

export const reviewDigest = (r: TransferReview): string => createHash('sha256').update(JSON.stringify(r)).digest('hex')

const reviewProblems = (r: TransferReview, local: LocalInventory): string[] => {
  const problems: string[] = []
  const targets = new Set<string>()
  for (const a of r.accounts) {
    if (!isUsername(a.target)) problems.push(`${a.target} is not a valid account name here`)
    if (local.usernames.includes(a.target)) problems.push(`account ${a.target} already exists here`)
    if (targets.has(a.target)) problems.push(`two accounts would be named ${a.target}`)
    targets.add(a.target)
  }
  const plans = new Set([...local.plans, ...r.plans.filter((p) => p.action !== 'map').map((p) => p.target)])
  for (const p of r.plans) if (p.action === 'map' && !local.plans.includes(p.target)) problems.push(`plan ${p.target} does not exist here`)
  for (const a of r.accounts) if (!plans.has(a.plan)) problems.push(`plan ${a.plan} of ${a.source} would not exist here`)
  return problems
}

/**
 * What apply relies on, checked on the review and again on the stored session before apply:
 * every target name is a valid, free and unique local name, and every account lands on a
 * plan that exists here or is created by the transfer.
 */
export const assertApplicable = (r: TransferReview, local: LocalInventory | null): void => {
  const problems = local ? reviewProblems(r, local) : ['the local inventory is missing']
  if (problems.length) fail('PRECONDITION_FAILED', `the transfer cannot be applied: ${problems.join('; ')}`, { problems })
}

const unresolved = (s: TransferSession): Conflict[] => s.conflicts.filter((c) => !s.resolutions[c.id])

const deny = (s: TransferSession, e: TransferEvent): never =>
  fail('CONFLICT', `cannot ${e.type} a transfer session in state ${s.state}`, { state: s.state, event: e.type })

const select = (s: TransferSession, prev: TransferSession, e: Extract<TransferEvent, { type: 'select' }>): string => {
  const inv = s.inventory as NonNullable<TransferSession['inventory']>
  const accounts = [...new Set(e.accounts)]
  const plans = [...new Set(e.plans)]
  if (accounts.length === 0 && plans.length === 0) fail('VALIDATION', 'select at least one account or plan')
  for (const a of accounts) if (!inv.accounts.some((x) => x.username === a)) fail('NOT_FOUND', `source account ${String(a).slice(0, 32)} not found`)
  for (const p of plans) if (!inv.plans.some((x) => x.name === p)) fail('NOT_FOUND', `source plan ${String(p).slice(0, 64)} not found`)
  s.local = checkLocalInventory(e.local)
  s.selection = { accounts, plans }
  s.conflicts = detectConflicts(inv.accounts.filter((a) => accounts.includes(a.username)), plans, s.local)
  s.resolutions = {}
  for (const c of s.conflicts) {
    const r = prev.resolutions[c.id]
    if (r && c.choices.includes(r.action)) s.resolutions[c.id] = r
    else if (c.kind === 'uid') s.resolutions[c.id] = { action: 'new-uid' }
  }
  // a kept choice may clash with the new selection (a rename onto a newly selected account): it is dropped and asked again
  for (const c of s.conflicts) {
    const r = s.resolutions[c.id]
    if (!r) continue
    try {
      validateResolution(s, c, r)
    } catch (e) {
      if (!isXpanelError(e)) throw e
      delete s.resolutions[c.id]
    }
  }
  s.reviewDigest = null
  s.state = 'selected'
  return `${accounts.length} accounts, ${plans.length} plans, ${s.conflicts.length} conflicts`
}

const progress = (s: TransferSession, e: Extract<TransferEvent, { type: 'progress' }>): string => {
  const p = s.progress[e.account]
  if (!p) return fail('NOT_FOUND', `account ${String(e.account).slice(0, 32)} is not part of this transfer`)
  if (FINISHED_PHASES.has(p.phase)) fail('CONFLICT', `${e.account} already ${p.phase}`)
  if (e.phase === 'failed') {
    p.phase = 'failed'
    p.error = typeof e.error === 'string' && e.error.length > 0 ? e.error.slice(0, 1000) : 'failed'
  } else {
    if (!PHASE_ORDER.includes(e.phase) || PHASE_ORDER.indexOf(e.phase) <= PHASE_ORDER.indexOf(p.phase)) fail('CONFLICT', `${e.account} cannot go from ${p.phase} to ${String(e.phase)}`)
    p.phase = e.phase
  }
  if (e.bytes !== undefined) {
    if (!isNonNegInt(e.bytes) || e.bytes < p.bytes) fail('VALIDATION', 'progress bytes must be an integer that never decreases')
    p.bytes = e.bytes
  }
  return `${e.account} ${p.phase}`
}

/** Pure state transition; throws on events that are not valid in the current state. */
export const transition = (prev: TransferSession, e: TransferEvent, now: string): TransferSession => {
  const s: TransferSession = structuredClone(prev)
  s.updatedAt = assertNow(now)
  const note = (detail: string): TransferSession => {
    s.log.push({ at: now, event: e.type, detail })
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
    return s
  }
  switch (e.type) {
    case 'connected': {
      if (s.state !== 'created') return deny(s, e)
      if (!isRemoteHost(e.source?.hostname) || !parseSemver(e.source.version)) fail('VALIDATION', 'invalid source identity')
      s.source = { hostname: e.source.hostname, version: e.source.version }
      s.state = 'connected'
      return note(`${e.source.hostname} ${e.source.version}`)
    }
    case 'inventory':
      if (s.state !== 'connected' && s.state !== 'inventoried') return deny(s, e)
      checkInventory(e.accounts, e.plans)
      s.inventory = { accounts: structuredClone(e.accounts), plans: structuredClone(e.plans) }
      s.state = 'inventoried'
      return note(`${e.accounts.length} accounts, ${e.plans.length} plans`)
    case 'select':
      if (!['inventoried', 'selected', 'reviewed'].includes(s.state)) return deny(s, e)
      return note(select(s, prev, e))
    case 'resolve': {
      if (s.state !== 'selected' && s.state !== 'reviewed') return deny(s, e)
      const c = s.conflicts.find((x) => x.id === e.conflictId)
      if (!c) return fail('NOT_FOUND', `no conflict ${String(e.conflictId).slice(0, 80)}`)
      validateResolution(s, c, e.resolution)
      s.resolutions[c.id] = structuredClone(e.resolution)
      s.reviewDigest = null
      s.state = 'selected'
      return note(`${c.id} -> ${e.resolution.action}`)
    }
    case 'review': {
      if (s.state !== 'selected') return deny(s, e)
      const open = unresolved(s)
      if (open.length) fail('PRECONDITION_FAILED', `unresolved conflicts: ${open.map((c) => c.id).join(', ')}`, { conflicts: open.map((c) => c.id) })
      const r = buildReview(s)
      if (r.accounts.length === 0 && r.plans.length === 0) fail('PRECONDITION_FAILED', 'nothing left to transfer')
      assertApplicable(r, s.local)
      s.reviewDigest = reviewDigest(r)
      s.state = 'reviewed'
      return note(s.reviewDigest)
    }
    case 'confirm': {
      if (s.state !== 'reviewed') return deny(s, e)
      const r = buildReview(s)
      if (e.digest !== s.reviewDigest || reviewDigest(r) !== s.reviewDigest) fail('CONFLICT', 'the review changed since it was shown; review again')
      s.progress = {}
      for (const a of r.accounts) s.progress[a.source] = { targetUsername: a.target, phase: 'pending', bytes: 0, totalBytes: a.diskBytes, error: null }
      for (const a of r.skipped) s.progress[a] = { targetUsername: a, phase: 'skipped', bytes: 0, totalBytes: 0, error: null }
      s.state = 'applying'
      return note(`${r.accounts.length} accounts`)
    }
    case 'progress':
      if (s.state !== 'applying') return deny(s, e)
      return note(progress(s, e))
    case 'complete': {
      if (s.state !== 'applying') return deny(s, e)
      const open = Object.entries(s.progress).filter(([, p]) => !FINISHED_PHASES.has(p.phase))
      if (open.length) fail('PRECONDITION_FAILED', `accounts still running: ${open.map(([a]) => a).join(', ')}`)
      s.state = 'completed'
      return note(`${Object.values(s.progress).filter((p) => p.phase === 'done').length} done`)
    }
    case 'fail':
      if (TERMINAL.has(s.state)) return deny(s, e)
      s.state = 'failed'
      s.error = String(e.reason).slice(0, 1000)
      return note(s.error)
    case 'cancel':
      if (TERMINAL.has(s.state)) return deny(s, e)
      for (const p of Object.values(s.progress)) if (p.phase === 'pending') p.phase = 'skipped'
      s.state = 'cancelled'
      return note('cancelled')
    default:
      return fail('VALIDATION', `unknown transfer event ${String((e as { type?: unknown }).type).slice(0, 40)}`)
  }
}

// Mirrors the control DB `transfers.status` / `transfer_items.status` enums.
export type TransferStatus = 'pending' | 'scanning' | 'review' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type TransferItemStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'

const STATUS: Record<SessionState, TransferStatus> = {
  created: 'pending',
  connected: 'scanning',
  inventoried: 'scanning',
  selected: 'review',
  reviewed: 'review',
  applying: 'running',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
}

export const transferStatus = (s: Pick<TransferSession, 'state'>): TransferStatus => STATUS[s.state]

export const itemStatus = (p: Pick<AccountProgress, 'phase'>): TransferItemStatus =>
  p.phase === 'done' ? 'succeeded' : p.phase === 'pending' || p.phase === 'failed' || p.phase === 'skipped' ? p.phase : 'running'

/** 0..100 for transfer_items.progress: bytes copied when known, else the phase reached. */
export const itemPercent = (p: AccountProgress): number => {
  if (p.phase === 'done' || p.phase === 'skipped') return 100
  const byPhase = Math.round((Math.max(0, PHASE_ORDER.indexOf(p.phase)) / (PHASE_ORDER.length - 1)) * 100)
  if (p.phase === 'copying' && p.totalBytes > 0) return Math.min(99, Math.max(byPhase, Math.floor((p.bytes / p.totalBytes) * 100)))
  return Math.min(99, byPhase)
}
