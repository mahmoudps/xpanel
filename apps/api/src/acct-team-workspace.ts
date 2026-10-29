import { randomBytes, randomUUID } from 'node:crypto'
import { fail, parseServiceLogin, validateEmailLocalPart } from '@xpanel/core'
import type { TeamRole } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { TEAM_ROLES, teamToolIds } from './team-access.ts'
import { clearTeamPasswordLink, deleteTeamCredential, listTeamCredentials, revokeTeamMemberSessions, saveTeamPasswordLink } from './team-store.ts'

/** catalog spec manage-team: default role-holder limit 7; role-less members are unlimited (bounded here by file size). */
export const TEAM_LIMITS = { members: 100, roleHolders: 7, notes: 100, reason: 100 } as const
export interface TeamMember {
  id: string; username: string; roles: TeamRole[]; contactEmail: string; notes: string; expiresAt: string | null; expiryReason: string | null
  status: 'active' | 'suspended'; suspendReason: string | null; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string
}
export interface TeamHelpers extends AccountOwnerPorts, Pick<ExtendedRouteHelpers, 'emitAudit'> {
  /** ext.readOrDefault(`accounts/team/${accountId}.json`, null) */
  readTeam: (accountId: string) => Promise<unknown>
  /** ext.write(`accounts/team/${accountId}.json`, value) */
  writeTeam: (accountId: string, value: unknown) => Promise<unknown>
  /** Team sign-in credentials and sessions (migration 0005). Without it team sign-in is reported unavailable and no link is issued. */
  db?: Db
  now?: () => Date
}
/** A password link works once and for 72 hours. The owner sees it once and never sees the password. */
export const TEAM_PASSWORD_LINK_TTL_MS = 72 * 3600_000
export const teamPasswordLinkPath = (secret: string): string => `/login?target=xpanel#team-password=${secret}`

const ROUTE = /^\/api\/account\/team(?:\/([^/]+)(?:\/(suspend|reinstate|password-link))?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u
const MAX_BODY_BYTES = 8 * 1024
const RECORD_KEYS = 'contactEmail,createdAt,createdBy,expiresAt,expiryReason,id,notes,roles,status,suspendReason,updatedAt,updatedBy,username'
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))
const revisionField = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the observed team revision is required')

const plain = (value: unknown, what: string, max: number, empty: boolean): string => {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalid(`${what} must be text`)
  const text = value.trim()
  if ((!empty && !text) || [...text].length > max || FORBIDDEN.test(text)) return invalid(`${what} must be ${empty ? 'at most' : '1 to'} ${max} characters of plain single-line text`)
  return text
}
const usernameOf = (value: unknown): string => {
  let name: string
  try { name = validateEmailLocalPart(value) } catch { return invalid('the team username may use a-z, 0-9, ".", "_" and "-" and must start with a letter or digit') }
  return name === value && name.length <= 32 ? name : invalid('the team username must be lowercase and at most 32 characters')
}
const emailOf = (value: unknown): string => {
  try { const { local, domain } = parseServiceLogin(value); if (`${local}@${domain}` === value) return value as string } catch { /* reported below */ }
  return invalid('the contact email must be a lowercase address such as name@example.com')
}
const rolesOf = (value: unknown): TeamRole[] => {
  if (!Array.isArray(value) || value.length > TEAM_ROLES.length || new Set(value).size !== value.length || value.some(role => !(TEAM_ROLES as readonly unknown[]).includes(role))) return invalid('roles must be distinct values from administrator, database, email and web')
  return TEAM_ROLES.filter(role => value.includes(role))
}
const expiryOf = (value: unknown): string | null => {
  if (value === null) return null
  const parsed = typeof value === 'string' && STAMP.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value as string : invalid('expiresAt must be a UTC time such as 2026-12-31T00:00:00.000Z, or null')
}
type Fields = Pick<TeamMember, 'roles' | 'contactEmail' | 'notes' | 'expiresAt' | 'expiryReason'>
const fieldsOf = (value: Record<string, unknown>): Fields => {
  const expiresAt = expiryOf(value.expiresAt)
  const expiryReason = value.expiryReason === null ? null : plain(value.expiryReason, 'the expiry reason', TEAM_LIMITS.reason, true) || null
  if (expiresAt === null && expiryReason !== null) return invalid('an expiry reason needs an expiry time')
  return { roles: rolesOf(value.roles), contactEmail: emailOf(value.contactEmail), notes: plain(value.notes, 'notes', TEAM_LIMITS.notes, true), expiresAt, expiryReason }
}

export type TeamRequest =
  | { op: 'create'; expectedRevision: string; username: string; fields: Fields }
  | { op: 'update'; expectedRevision: string; fields: Fields }
  | { op: 'suspend'; expectedRevision: string; reason: string }
  | { op: 'reinstate'; expectedRevision: string }
  | { op: 'delete'; expectedRevision: string; confirmUsername: string }
  | { op: 'password-link'; expectedRevision: string }
/** Strict body grammar per operation; unknown or missing keys are refused. */
export function parseTeamRequest<Op extends TeamRequest['op']>(op: Op, body: unknown): Extract<TeamRequest, { op: Op }>
export function parseTeamRequest(op: TeamRequest['op'], body: unknown): TeamRequest {
  const shapes: Record<TeamRequest['op'], string> = {
    create: 'contactEmail,expectedRevision,expiresAt,expiryReason,notes,roles,username', update: 'contactEmail,expectedRevision,expiresAt,expiryReason,notes,roles',
    suspend: 'expectedRevision,reason', reinstate: 'expectedRevision', delete: 'confirmUsername,expectedRevision', 'password-link': 'expectedRevision',
  }
  if (!object(body) || keys(body) !== shapes[op]) return invalid(`exactly ${shapes[op].split(',').join(', ')} are required`)
  const expectedRevision = revisionField(body.expectedRevision)
  if (op === 'create') return { op, expectedRevision, username: usernameOf(body.username), fields: fieldsOf(body) }
  if (op === 'update') return { op, expectedRevision, fields: fieldsOf(body) }
  if (op === 'suspend') return { op, expectedRevision, reason: plain(body.reason, 'the suspension reason', TEAM_LIMITS.reason, false) }
  if (op === 'delete') return { op, expectedRevision, confirmUsername: usernameOf(body.confirmUsername) }
  return { op, expectedRevision }
}

const memberOf = (raw: unknown): TeamMember | null => {
  try {
    if (!object(raw) || keys(raw) !== RECORD_KEYS || typeof raw.id !== 'string' || !UUID.test(raw.id) || (raw.status !== 'active' && raw.status !== 'suspended')
      || [raw.createdAt, raw.updatedAt].some(stamp => typeof stamp !== 'string' || expiryOf(stamp) === null) || [raw.createdBy, raw.updatedBy].some(actor => typeof actor !== 'string' || !ACTOR.test(actor))) return null
    const fields = fieldsOf(raw), username = usernameOf(raw.username)
    const suspendReason = raw.suspendReason === null ? null : plain(raw.suspendReason, 'reason', TEAM_LIMITS.reason, false)
    if ((raw.status === 'suspended') !== (suspendReason !== null) || fields.notes !== raw.notes || JSON.stringify(fields.roles) !== JSON.stringify(raw.roles)) return null
    return { id: raw.id, username, ...fields, status: raw.status, suspendReason, createdAt: raw.createdAt as string, createdBy: raw.createdBy as string, updatedAt: raw.updatedAt as string, updatedBy: raw.updatedBy as string }
  } catch { return null }
}
/** Strict saved-file reader. null is "nothing saved"; anything unreadable returns null so it is never shown or overwritten as valid. */
export function readSavedTeam(raw: unknown): TeamMember[] | null {
  if (raw === null) return []
  if (!Array.isArray(raw) || raw.length > TEAM_LIMITS.members) return null
  const members = raw.map(memberOf)
  if (members.some(member => member === null)) return null
  const list = members as TeamMember[]
  return new Set(list.map(member => member.id)).size === list.length && new Set(list.map(member => member.username)).size === list.length && roleHolders(list) <= TEAM_LIMITS.roleHolders ? list : null
}
export const roleHolders = (list: readonly TeamMember[], except?: string): number => list.filter(member => member.id !== except && member.roles.length > 0).length
export const teamMemberPhase = (member: TeamMember, now: number): 'active' | 'suspended' | 'expired' =>
  member.status === 'suspended' ? 'suspended' : member.expiresAt !== null && Date.parse(member.expiresAt) <= now ? 'expired' : 'active'

/** Pure state transition; the caller has already checked revision and authority. */
export function applyTeamRequest(list: readonly TeamMember[], request: Exclude<TeamRequest, { op: 'password-link' }>, target: string | undefined, actor: string, stamp: string, newId: string): { next: TeamMember[]; changed: TeamMember | null } {
  const index = target === undefined ? -1 : list.findIndex(member => member.id === target)
  if (request.op !== 'create' && index < 0) return fail('NOT_FOUND', 'team member not found', { stateChanged: false })
  const current = index >= 0 ? list[index]! : null, next = [...list]
  if (request.op === 'create' || request.op === 'update') {
    const fields = request.fields
    if (fields.expiresAt !== null && Date.parse(fields.expiresAt) <= Date.parse(stamp) && fields.expiresAt !== current?.expiresAt) return invalid('the expiry time must be in the future')
    if (fields.roles.length > 0 && roleHolders(list, current?.id) >= TEAM_LIMITS.roleHolders) return fail('LIMIT_EXCEEDED', `at most ${TEAM_LIMITS.roleHolders} team members can hold a role`, { stateChanged: false, limit: TEAM_LIMITS.roleHolders })
    if (request.op === 'create') {
      if (list.length >= TEAM_LIMITS.members) return fail('LIMIT_EXCEEDED', `at most ${TEAM_LIMITS.members} team members can be saved`, { stateChanged: false })
      if (list.some(member => member.username === request.username)) return fail('CONFLICT', 'a team member with this username already exists', { stateChanged: false })
      const created: TeamMember = { id: newId, username: request.username, ...fields, status: 'active', suspendReason: null, createdAt: stamp, createdBy: actor, updatedAt: stamp, updatedBy: actor }
      return { next: [...list, created], changed: created }
    }
    next[index] = { ...current!, ...fields, updatedAt: stamp, updatedBy: actor }
    return { next, changed: next[index]! }
  }
  if (request.op === 'suspend') {
    if (current!.status === 'suspended') return fail('CONFLICT', 'the team member is already suspended', { stateChanged: false })
    next[index] = { ...current!, status: 'suspended', suspendReason: request.reason, updatedAt: stamp, updatedBy: actor }
    return { next, changed: next[index]! }
  }
  if (request.op === 'reinstate') {
    if (current!.status !== 'suspended') return fail('CONFLICT', 'the team member is not suspended', { stateChanged: false })
    next[index] = { ...current!, status: 'active', suspendReason: null, updatedAt: stamp, updatedBy: actor }
    return { next, changed: next[index]! }
  }
  if (request.confirmUsername !== current!.username) return invalid('type the team username exactly to delete it')
  next.splice(index, 1)
  return { next, changed: null }
}

const view = async (raw: unknown, account: { id: string; username: string; primaryDomain: string }, now: number, db: Db | undefined) => {
  const list = readSavedTeam(raw)
  const credentials = new Map(db ? (await listTeamCredentials(db, account.id)).map(row => [row.memberId, row] as const) : [])
  return {
    state: raw === null ? 'default' : list ? 'saved' : 'invalid', revision: revisionOf(raw),
    account: { username: account.username, primaryDomain: account.primaryDomain },
    limits: { roleHolders: TEAM_LIMITS.roleHolders, members: TEAM_LIMITS.members, roleHoldersUsed: list ? roleHolders(list) : 0 },
    members: (list ?? []).map(member => {
      const credential = credentials.get(member.id), link = credential?.linkExpiresAt ?? null
      return { ...member, phase: teamMemberPhase(member, now), toolCount: teamToolIds(member.roles).length,
        signIn: { password: credential?.passwordHash ? 'set' : 'not-set', linkExpiresAt: link !== null && Date.parse(link) > now ? link : null, lastLoginAt: credential?.lastLoginAt ?? null } }
    }),
    signIn: { available: db !== undefined },
  }
}
// Sessions end when a member is suspended, deleted or loses a role; the per-request role check already narrows them.
const endAccess = async (db: Db, op: TeamRequest['op'], before: TeamMember, after: TeamMember | null, now: Date): Promise<number> => {
  if (op === 'delete') { await deleteTeamCredential(db, before.id); return 0 }
  if (op === 'suspend') { await clearTeamPasswordLink(db, before.id, now); return revokeTeamMemberSessions(db, before.id, now) }
  if (op === 'update' && before.roles.some(role => !after!.roles.includes(role))) return revokeTeamMemberSessions(db, before.id, now)
  return 0
}
const readJson = async (request: Request): Promise<unknown> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}
const sameAuthority = (a: AuthenticatedCaller, b: AuthenticatedCaller): boolean => a.principal.id === b.principal.id && a.sessionId === b.sessionId && a.apiTokenId === b.apiTokenId

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

const ownerOnly = async (helpers: TeamHelpers, request: Request): ReturnType<typeof authorizeAccountOwner> => {
  const owner = await authorizeAccountOwner(helpers, request, ['manage-team'], 'team management')
  return owner.caller.team ? fail('FORBIDDEN', 'team management requires the signed-in account owner', { stateChanged: false }) : owner
}

/** Owner team directory: GET/POST /api/account/team, PUT/DELETE /api/account/team/:id, POST /api/account/team/:id/(suspend|reinstate|password-link). */
export async function handleTeamRoute(request: Request, url: URL, method: string, helpers: TeamHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, id, action] = match
  const first = await ownerOnly(helpers, request)
  const allow = id === undefined ? 'GET, POST' : action ? 'POST' : 'PUT, DELETE'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !UUID.test(id)) return fail('NOT_FOUND', 'team member not found', { stateChanged: false })
  if (url.search) return invalid('the team route does not accept selectors')
  const now = (): Date => helpers.now?.() ?? new Date()
  if (method === 'GET') return json(200, await view(await helpers.readTeam(first.account.id), first.account, now().getTime(), helpers.db))
  const op: TeamRequest['op'] = id === undefined ? 'create' : action === 'suspend' ? 'suspend' : action === 'reinstate' ? 'reinstate' : action === 'password-link' ? 'password-link' : method === 'DELETE' ? 'delete' : 'update'
  const parsed = parseTeamRequest(op, await readJson(request))
  return serial(async () => {
    const raw = await helpers.readTeam(first.account.id)
    if (revisionOf(raw) !== parsed.expectedRevision) return fail('CONFLICT', 'the team changed since it was read; reload before saving', { stateChanged: false })
    const list = readSavedTeam(raw)
    if (!list) return fail('PRECONDITION_FAILED', 'the saved team file requires review before it can be changed', { stateChanged: false })
    const fresh = await ownerOnly(helpers, request)
    if (!sameAuthority(fresh.caller, first.caller) || fresh.account.id !== first.account.id) return fail('FORBIDDEN', 'team authority changed', { stateChanged: false })
    const stamp = now().toISOString(), actor = fresh.caller.principal.username
    if (parsed.op === 'password-link') return issuePasswordLink(helpers, list, id!, first.account, fresh.caller, now())
    const { next, changed } = applyTeamRequest(list, parsed, id, actor, stamp, randomUUID())
    const removed = op === 'delete' ? list.find(member => member.id === id)! : null
    try { await helpers.writeTeam(first.account.id, next) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the team write requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    const saved = await helpers.readTeam(first.account.id)
    if (revisionOf(saved) !== revisionOf(next) || !readSavedTeam(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved team could not be verified', { stateChanged: true, verificationRequired: true })
    const member = changed ?? removed!
    let endedSessions = 0
    if (helpers.db && op !== 'create') {
      try { endedSessions = await endAccess(helpers.db, op, list.find(item => item.id === id)!, changed, now()) }
      catch { return fail('SERVICE_UNAVAILABLE', 'the team change is saved but ending the member sign-in requires review', { stateChanged: true, verificationRequired: true }) }
    }
    try { await helpers.emitAudit({ actor, principalId: fresh.caller.principal.id, action: `account.team.${op === 'create' ? 'created' : op === 'update' ? 'updated' : op === 'delete' ? 'deleted' : op === 'suspend' ? 'suspended' : 'reinstated'}`, target: `team-member:${first.account.username}/${member.username}`, detail: { roles: member.roles, endedSessions }, outcome: 'ok' }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the team change is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(op === 'create' ? 201 : 200, { ...await view(saved, first.account, now().getTime(), helpers.db), changed: member.id })
  })
}

/** Only an active member gets a link. The secret is returned once; only its SHA-256 is stored. */
async function issuePasswordLink(helpers: TeamHelpers, list: readonly TeamMember[], id: string, account: { id: string; username: string; primaryDomain: string }, caller: AuthenticatedCaller, now: Date): Promise<Response> {
  if (!helpers.db) return fail('PRECONDITION_FAILED', 'team sign-in is unavailable on this server', { stateChanged: false })
  const member = list.find(item => item.id === id)
  if (!member) return fail('NOT_FOUND', 'team member not found', { stateChanged: false })
  const phase = teamMemberPhase(member, now.getTime())
  if (phase !== 'active') return fail('CONFLICT', `a ${phase} team member cannot have the password changed`, { stateChanged: false, phase })
  const secret = randomBytes(32).toString('base64url'), expiresAt = new Date(now.getTime() + TEAM_PASSWORD_LINK_TTL_MS)
  try { await saveTeamPasswordLink(helpers.db, { memberId: member.id, accountId: account.id, linkHash: sha256Hex(secret), expiresAt, now }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the password link could not be saved', { stateChanged: false, verificationRequired: true }) }
  try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'account.team.password_link_created', target: `team-member:${account.username}/${member.username}`, detail: { expiresAt: expiresAt.toISOString() }, outcome: 'ok' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the password link is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  return json(200, { ...await view(await helpers.readTeam(account.id), account, now.getTime(), helpers.db), changed: member.id, passwordLink: { path: teamPasswordLinkPath(secret), expiresAt: expiresAt.toISOString() } })
}
