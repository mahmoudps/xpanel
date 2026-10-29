import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { OsFamily } from '@xpanel/core'
import { services } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import { MAILX_RSPAMD_MILTER, MAILX_SPAMASS_MILTERS, MAILX_SPAMASS_MILTER_UNIT, mailxEngineShowArgv } from '../../../packages/os/src/mailx-command.ts'
import type { MailxShowUnit } from '../../../packages/os/src/mailx-command.ts'
import { isMailxInvalid, mailxMailboxEffects, mailxStatePath, readMailxMailboxSpam, readMailxStored } from './mailx-policy.ts'
import type { MailxMailboxSpam } from './mailx-policy.ts'

/**
 * Mail policy inputs the reconciler renders: the spam filter milter in the Postfix main.cf block, one Dovecot
 * Sieve policy script per mailbox, and mailing list addresses in virtual_alias_maps. Saved state stays in the
 * API's files; this module only reads, admits and reports it.
 */
export interface MailxSnapshot {
  accounts: readonly { id: string; username: string; status: string; home: string; uid?: number; gid?: number; planId?: string }[]
  domains: readonly { id: string; name: string; accountId: string }[]
  serviceUsers: readonly { id: string; accountId: string; login: string; domainId?: string; localPart?: string; services: { email: boolean } }[]
  plans?: readonly { id: string; featureListId: string }[]
  featureLists?: readonly { id: string; disabled: readonly string[] }[]
}
export type MailfxRun = (argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>

export const mailxStdout = async (run: MailfxRun, argv: readonly string[]): Promise<string | null> => {
  try { const result = await run([...argv]); return result && result.ok && result.code === 0 && typeof result.stdout === 'string' ? result.stdout : null } catch { return null }
}
export type MailxEngineState = 'active' | 'inactive' | 'not-installed' | 'unknown'
// systemctl(1) show: LoadState=not-found means the unit file does not exist.
export const parseMailxEngineShow = (text: string | null): MailxEngineState => {
  if (text === null) return 'unknown'
  const props = new Map(text.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const))
  const load = props.get('LoadState'), active = props.get('ActiveState')
  if (!load || !active || text.split('\n').filter(Boolean).length !== 2) return 'unknown'
  return load === 'not-found' ? 'not-installed' : load !== 'loaded' ? 'unknown' : active === 'active' ? 'active' : 'inactive'
}
export const mailxUnitState = async (run: MailfxRun, unit: MailxShowUnit): Promise<MailxEngineState> => parseMailxEngineShow(await mailxStdout(run, mailxEngineShowArgv(unit)))
const installed = (state: MailxEngineState): boolean => state === 'active' || state === 'inactive'

/**
 * The milter Postfix should pass mail to while the saved spam policy is enabled: the running engine the policy
 * applier also writes (rspamd first), else an installed rspamd. SpamAssassin needs spamass-milter installed.
 */
export async function mailfxSpamMilter(stateRoot: string, family: OsFamily, run: MailfxRun): Promise<string | null> {
  let enabled = false
  try {
    const raw = await readJsonIfExists<unknown>(join(stateRoot, ...mailxStatePath('spam.json')))
    enabled = raw !== null && readMailxStored('spam', raw).policy.enabled
  } catch (error) {
    // A saved policy that needs review is reported by the policy status; it never fails a reconcile here.
    if (isMailxInvalid(error) || error instanceof SyntaxError) return null
    throw error
  }
  if (!enabled) return null
  const rspamd = await mailxUnitState(run, 'rspamd.service')
  if (rspamd === 'active') return MAILX_RSPAMD_MILTER
  if (await mailxUnitState(run, 'spamassassin.service') === 'active' || await mailxUnitState(run, 'spamd.service') === 'active')
    return installed(await mailxUnitState(run, MAILX_SPAMASS_MILTER_UNIT)) ? MAILX_SPAMASS_MILTERS[family] : null
  return installed(rspamd) ? MAILX_RSPAMD_MILTER : null
}
/** Any milter address the policy can render; status reads `wired` only when Postfix lists one of them. */
export const MAILFX_MILTERS = { rspamd: [MAILX_RSPAMD_MILTER], spamassassin: Object.values(MAILX_SPAMASS_MILTERS) } as const
export const mailfxMilterListed = (main: ReadonlyMap<string, string>, milters: readonly string[]): boolean =>
  ['smtpd_milters', 'non_smtpd_milters'].every(key => (main.get(key) ?? '').split(/[\s,]+/).some(item => milters.includes(item)))

/** Mailbox spam preference files; a malformed or foreign-bound file is reported for review and never rendered. */
export async function readMailxMailboxRows(stateRoot: string): Promise<{ rows: MailxMailboxSpam[]; review: string[] }> {
  const dir = join(stateRoot, 'extended', 'webmail', 'spam-preferences')
  const names = (await readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))).filter(name => !name.startsWith('.')).sort()
  if (names.length > 100000) return fail('PRECONDITION_FAILED', 'saved mailbox preferences exceed their bound', { stateChanged: false, reason: 'saved_policy_review' })
  const rows: MailxMailboxSpam[] = [], review: string[] = []
  for (const name of names) {
    let mailbox = ''
    try { mailbox = decodeURIComponent(name.slice(0, -5)) } catch { /* reported below */ }
    try {
      const row = readMailxMailboxSpam(await readJsonIfExists<unknown>(join(dir, name)))
      if (!name.endsWith('.json') || row.mailbox !== mailbox) throw new Error('mailx_mailbox_name')
      rows.push(row)
    } catch { review.push(mailbox || name) }
  }
  return { rows, review }
}
export const admitMailxMailboxRows = (rows: readonly MailxMailboxSpam[], snapshot: MailxSnapshot): MailxMailboxSpam[] => rows.filter(row => {
  const user = snapshot.serviceUsers.find(item => item.id === row.serviceUserId), account = snapshot.accounts.find(item => item.id === row.accountId)
  return !!user && !!account && account.status === 'active' && user.accountId === row.accountId && user.services.email && user.login.toLowerCase() === row.mailbox
})
const accountRef = (account: MailxSnapshot['accounts'][number]): services.AccountRef => ({ username: account.username, uid: account.uid ?? -1, gid: account.gid ?? -1, home: account.home })

/** Sieve policy input for every admitted mailbox whose saved preference blocks senders or files spam into Junk. */
export const mailfxSieveInputs = (rows: readonly MailxMailboxSpam[], snapshot: MailxSnapshot): services.MailboxPolicySieveInput[] =>
  admitMailxMailboxRows(rows, snapshot).flatMap(row => {
    const effects = mailxMailboxEffects(row), account = snapshot.accounts.find(item => item.id === row.accountId)!
    return effects.blocklist || effects.spamBox ? [{ address: row.mailbox, account: accountRef(account), blockedSenders: [...row.blocklist], spamToJunk: effects.spamBox }] : []
  }).sort((a, b) => a.address.localeCompare(b.address))

export interface MailfxRenderInput { spamMilter: string | null; sieve: services.MailboxPolicySieveInput[] }
/**
 * Read for each compile. `run` is null before the executor preflight, which keeps the milter off for that first
 * pass; without systemd answers the milter stays off and the Sieve scripts still render.
 */
export async function readMailfxRenderInput(stateRoot: string, snapshot: MailxSnapshot, family: OsFamily, run: MailfxRun | null): Promise<MailfxRenderInput> {
  return { spamMilter: run ? await mailfxSpamMilter(stateRoot, family, run) : null, sieve: mailfxSieveInputs((await readMailxMailboxRows(stateRoot)).rows, snapshot) }
}

// ---- mailing lists ------------------------------------------------------------------------

/** Not delivered: `restricted` lists limit posting, which needs a list manager; `conflict` covers used addresses and loops. */
export type MailfxListState = 'pending' | 'disabled' | 'restricted' | 'empty' | 'review' | 'conflict'
export interface MailfxListRow { id: string; accountId: string | null; address: string; members: number; state: MailfxListState }
export interface MailfxDeliveredList { accountId: string; address: string; members: string[] }
export interface MailfxForwarding {
  forwarders: readonly { accountId: string; sourceAddress: string; destinations: readonly string[] }[]
  domainForwarders: readonly { accountId: string; sourceDomain: string; targetDomain: string }[]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIST_KEYS = new Set(['id', 'accountId', 'name', 'domain', 'address', 'members', 'moderation', 'archiveEnabled', 'createdAt', 'selfSubscription', 'memberAuthorities'])
// The tool id and the catalog feature key the plan editor may store (apps/api assertAccountFeatures).
const LIST_FEATURES = ['mailing-lists', 'Mailing Lists']

/** The saved mailing-list file as written by the list routes; a malformed file needs review before any reconcile. */
async function readListFile(stateRoot: string): Promise<{ id: string; accountId: string | null; address: string; members: string[]; moderation: string }[]> {
  const raw = await readJsonIfExists<unknown>(join(stateRoot, 'extended', 'mail', 'mailing-lists.json'))
  if (raw === null) return []
  const bad = (): never => fail('PRECONDITION_FAILED', 'saved mailing lists require review', { stateChanged: false, reason: 'saved_lists_review' })
  if (!Array.isArray(raw) || raw.length > 10000) return bad()
  const lists = raw.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !LIST_KEYS.has(key))) return bad()
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !UUID.test(row.id) || !(row.accountId === null || typeof row.accountId === 'string' && UUID.test(row.accountId)) || typeof row.address !== 'string' || row.address.length > 254
      || typeof row.domain !== 'string' || row.address.split('@')[1] !== row.domain || !Array.isArray(row.members) || row.members.length > 10000 || row.members.some(member => typeof member !== 'string' || member.length > 320)
      || !['open', 'members', 'moderated'].includes(String(row.moderation))) return bad()
    return { id: row.id, accountId: row.accountId as string | null, address: row.address, members: row.members as string[], moderation: row.moderation as string }
  })
  return new Set(lists.map(list => list.id)).size === lists.length ? lists : bad()
}

/**
 * Admits lists in saved order: an open-posting list of an active plan feature, with valid members inside the
 * member limit, on a domain of its account, whose address is free and whose members close no forwarding loop.
 * Domain inputs mirror the reconciler's mail section so admission and render agree.
 */
export async function readMailfxLists(stateRoot: string, snapshot: MailxSnapshot, forwarding: MailfxForwarding): Promise<{ lists: MailfxDeliveredList[]; rows: MailfxListRow[] }> {
  const saved = await readListFile(stateRoot)
  if (!saved.length) return { lists: [], rows: [] }
  const live = snapshot.accounts.filter(account => account.status !== 'terminating')
  const domains: services.MailDomainInput[] = live.flatMap(account => snapshot.domains.filter(domain => domain.accountId === account.id).map(domain => {
    const domainForward = forwarding.domainForwarders.find(item => item.accountId === account.id && item.sourceDomain === domain.name)?.targetDomain
    return {
      domain: domain.name, account: accountRef(account),
      mailboxes: snapshot.serviceUsers.filter(user => user.accountId === account.id && user.domainId === domain.id && user.services.email).map(user => ({ local: user.localPart ?? user.login.slice(0, user.login.lastIndexOf('@')), passwordHash: '', quotaMb: 0 })),
      forwarders: forwarding.forwarders.filter(item => item.accountId === account.id && item.sourceAddress.endsWith(`@${domain.name}`)).map(item => ({ local: item.sourceAddress.slice(0, item.sourceAddress.lastIndexOf('@')), to: [...item.destinations] })),
      ...(domainForward ? { domainForward } : {}),
    }
  }))
  const featureOn = (accountId: string): boolean => {
    const account = live.find(item => item.id === accountId), plan = snapshot.plans?.find(item => item.id === account?.planId)
    const list = plan && snapshot.featureLists?.find(item => item.id === plan.featureListId)
    return !!list && !LIST_FEATURES.some(key => list.disabled.includes(key))
  }
  const rows: MailfxListRow[] = saved.map(list => {
    const owned = list.accountId !== null && live.some(account => account.id === list.accountId) && snapshot.domains.some(domain => domain.accountId === list.accountId && domain.name === list.address.split('@')[1])
    const state: MailfxListState = !owned ? 'review' : !featureOn(list.accountId!) ? 'disabled' : list.moderation !== 'open' ? 'restricted' : !list.members.length ? 'empty' : 'pending'
    return { id: list.id, accountId: list.accountId, address: list.address, members: list.members.length, state }
  })
  const candidates = saved.filter((_, index) => rows[index]!.state === 'pending')
  const outcomes = services.admitMailingLists(domains, candidates.map(list => ({ domain: list.address.split('@')[1]!, local: list.address.split('@')[0]!, members: list.members })))
  const lists: MailfxDeliveredList[] = []
  candidates.forEach((list, index) => {
    const row = rows.find(item => item.id === list.id)!, outcome = outcomes[index]
    if (outcome === 'admitted') lists.push({ accountId: list.accountId!, address: list.address.toLowerCase(), members: services.mailingListTargets(list.members) })
    else row.state = outcome === 'invalid' ? 'review' : 'conflict'
  })
  return { lists, rows }
}
/** The exact virtual_aliases line the reconciler renders for an admitted list. */
export const mailfxListAliasLine = (list: MailfxDeliveredList): string => `${list.address}\t${list.members.join(',')}`

// ---- forwarding configuration --------------------------------------------------------------

export interface MailForwardingConfiguration {
  forwarders: { accountId: string; sourceAddress: string; destinations: string[] }[]
  domainForwarders: { accountId: string; sourceDomain: string; targetDomain: string }[]
  /** Only admitted lists; the others are reported by the mail policy status and never rendered. */
  lists: MailfxDeliveredList[]
}

/** The API's extended records are not part of StateSnapshot; never silently omit invalid rows. */
export const readMailForwardingConfiguration = async (root: string, snapshot: MailxSnapshot): Promise<MailForwardingConfiguration> => {
  const domains = new Map(snapshot.domains.map(domain => [domain.name, domain.accountId]))
  const invalid = (): never => fail('PRECONDITION_FAILED', 'Saved mail forwarding configuration is invalid; review it before reconciliation')
  const list = async (name: string, keys: readonly string[]): Promise<Record<string, unknown>[]> => {
    let text: string
    try { text = await readFile(join(root, 'extended', 'mail', name), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return invalid()
    }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return invalid()
    let value: unknown
    try { value = JSON.parse(text) } catch { return invalid() }
    if (!Array.isArray(value) || value.length > 10000) return invalid()
    return value.map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid()
      const item = row as Record<string, unknown>
      if (Object.keys(item).some(key => !keys.includes(key)) || keys.some(key => !(key in item))
        || typeof item.id !== 'string' || !item.id || item.id.length > 128
        || typeof item.accountId !== 'string' || !item.accountId || item.accountId.length > 128
        || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return invalid()
      return item
    })
  }
  const own = (domain: string, accountId: unknown): string => {
    if (typeof accountId !== 'string' || domains.get(domain) !== accountId) return invalid()
    return accountId
  }
  try {
    const forwarders = (await list('forwarders.json', ['id', 'accountId', 'sourceAddress', 'destinations', 'createdAt'])).map(item => {
      const source = services.normalizeHostedEmail(item.sourceAddress, 'saved forwarder source')
      if (!Array.isArray(item.destinations) || item.destinations.length === 0 || item.destinations.length > services.MAX_FORWARD_TARGETS) return invalid()
      const destinations = item.destinations.map(target => services.normalizeEmail(target, 'saved forwarder destination').address)
      if (new Set(destinations).size !== destinations.length) return invalid()
      return { accountId: own(source.domain, item.accountId), sourceAddress: source.address, destinations }
    })
    const domainForwarders = (await list('domain-forwarders.json', ['id', 'accountId', 'sourceDomain', 'targetDomain', 'createdAt'])).map(item => {
      const sourceDomain = services.normalizeHostname(item.sourceDomain, 'saved domain forwarder source')
      const targetDomain = services.normalizeHostname(item.targetDomain, 'saved domain forwarder destination')
      if (sourceDomain === targetDomain) return invalid()
      return { accountId: own(sourceDomain, item.accountId), sourceDomain, targetDomain }
    })
    if (new Set(forwarders.map(item => item.sourceAddress)).size !== forwarders.length
      || new Set(domainForwarders.map(item => item.sourceDomain)).size !== domainForwarders.length) return invalid()
    return { forwarders, domainForwarders, lists: (await readMailfxLists(root, snapshot, { forwarders, domainForwarders })).lists }
  } catch { return invalid() }
}
