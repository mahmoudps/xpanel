import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'

/**
 * WHM Change Root Password and Manage Wheel/Sudo Group Users, root only. The administrator group is the one the
 * distribution grants elevation to: `wheel` on EL (su through pam_wheel and the sudoers %wheel rule), `sudo` on
 * Debian and Ubuntu. Only hosting accounts with a regular (non-system) UID are added or removed; any other member
 * was put there outside the panel and stays untouched. /etc/group is the state, as in cPanel.
 */
export const ADMIN_GROUPS: Readonly<Record<'debian' | 'rhel', 'sudo' | 'wheel'>> = { debian: 'sudo', rhel: 'wheel' }
const ACCOUNT_USER = /^[a-z][a-z0-9]{0,15}$/
// login.defs UID_MIN on all five profiles; 65534 is nobody.
const REGULAR_UID_MIN = 1000
const NOBODY_UID = 65534
const PASSWORD_TIMEOUT_MS = 15_000

export type RootIdentityRun = (argv: string[]) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
/** Writes `root:<password>` to chpasswd's standard input; the password never appears in an argv or a log. */
export type RootPasswordWriter = (password: string) => Promise<{ ok: boolean; code: number }>
export type ShadowReader = () => Promise<string>

export interface AdminGroupObservation {
  observedAt: string
  family: string
  group: 'sudo' | 'wheel' | null
  state: 'read' | 'group_missing' | 'unsupported'
  members: { username: string; account: boolean }[]
  accounts: { username: string; member: boolean }[]
}

const unchanged = { stateChanged: false }

async function groupMembers(run: RootIdentityRun, group: string): Promise<string[] | null> {
  // getent(1): name:password:GID:member,member; exit 2 means the group does not exist.
  const entry = await run(['/usr/bin/getent', 'group', group]).catch(() => null)
  if (!entry || entry.code === 2) return null
  const fields = entry.ok ? entry.stdout.trim().split(':') : []
  if (fields.length !== 4 || fields[0] !== group || !/^[0-9]+$/.test(fields[2]!)) return fail('SERVICE_UNAVAILABLE', 'the group entry could not be read', { ...unchanged, verificationRequired: true })
  return fields[3] ? fields[3].split(',').filter(Boolean).sort() : []
}

export async function observeAdminGroup(input: { family: string; run: RootIdentityRun; accounts: readonly Account[]; now?: () => Date }): Promise<AdminGroupObservation> {
  const group = input.family === 'debian' || input.family === 'rhel' ? ADMIN_GROUPS[input.family] : null
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const active = input.accounts.filter(account => account.status === 'active' && ACCOUNT_USER.test(account.username)).map(account => account.username).sort()
  if (!group) return { observedAt, family: input.family, group, state: 'unsupported', members: [], accounts: active.map(username => ({ username, member: false })) }
  const members = await groupMembers(input.run, group)
  const names = new Set(input.accounts.map(account => account.username))
  return { observedAt, family: input.family, group, state: members ? 'read' : 'group_missing',
    members: (members ?? []).map(username => ({ username, account: names.has(username) })),
    accounts: active.map(username => ({ username, member: members?.includes(username) ?? false })) }
}

/** Adds or removes one active hosting account and reads the group back; the change is reported only when observed. */
export async function changeAdminGroup(input: { family: string; run: RootIdentityRun; accounts: readonly Account[]; action: unknown; username: unknown; now?: () => Date }): Promise<{ outcome: 'applied' | 'unchanged'; observation: AdminGroupObservation }> {
  const group = input.family === 'debian' || input.family === 'rhel' ? ADMIN_GROUPS[input.family] : null
  if (!group) return fail('UNSUPPORTED_OS', 'this distribution has no supported administrator group', { ...unchanged, reason: 'admin_group_unsupported' })
  if (input.action !== 'add' && input.action !== 'remove') return fail('VALIDATION', 'action must be add or remove', unchanged)
  if (typeof input.username !== 'string' || !ACCOUNT_USER.test(input.username)) return fail('VALIDATION', 'a hosting account username is required', unchanged)
  const username = input.username
  const account = input.accounts.find(item => item.username === username)
  if (!account) return fail('FORBIDDEN', 'only hosting accounts are managed here; other members stay as they are', { ...unchanged, reason: 'not_a_hosting_account' })
  if (input.action === 'add' && account.status !== 'active') return fail('PRECONDITION_FAILED', `account "${username}" is ${account.status}`, { ...unchanged, reason: 'account_not_active' })
  // getent(1) passwd: name:password:UID:GID:gecos:home:shell; a system UID is never granted elevation.
  const passwd = await input.run(['/usr/bin/getent', 'passwd', username]).catch(() => null)
  const fields = passwd?.ok ? passwd.stdout.trim().split(':') : []
  if (fields.length !== 7 || fields[0] !== username || !/^[0-9]+$/.test(fields[2]!)) return fail('PRECONDITION_FAILED', 'the system user of this account was not found', { ...unchanged, reason: 'system_user_missing' })
  const uid = Number(fields[2])
  if (uid < REGULAR_UID_MIN || uid === NOBODY_UID) return fail('FORBIDDEN', 'system accounts are never added to or removed from the administrator group', { ...unchanged, reason: 'system_account' })
  const before = await groupMembers(input.run, group)
  if (!before) return fail('PRECONDITION_FAILED', `the ${group} group does not exist on this server`, { ...unchanged, reason: 'group_missing' })
  const wanted = input.action === 'add'
  if (before.includes(username) === wanted) return { outcome: 'unchanged', observation: await observeAdminGroup(input) }
  const result = await input.run(['/usr/bin/gpasswd', wanted ? '-a' : '-d', username, group]).catch(() => null)
  const observation = await observeAdminGroup(input).catch(() => null)
  const member = observation?.members.some(item => item.username === username)
  if (!result?.ok || member !== wanted) return fail('SERVICE_UNAVAILABLE', 'the group change could not be verified; review the group before retrying', { stateChanged: result?.ok === true, verificationRequired: true })
  return { outcome: 'applied', observation: observation! }
}

const rootHash = (shadow: string): string | null => {
  const line = shadow.split('\n').find(item => item.startsWith('root:'))
  return line ? line.split(':')[1] ?? null : null
}

/** Sets root's system password with the distribution's own hashing (chpasswd) and proves the shadow entry changed. */
export async function setRootPassword(input: { password: unknown; write?: RootPasswordWriter; readShadow?: ShadowReader }): Promise<{ outcome: 'applied'; scheme: string }> {
  const password = input.password
  // The API applies the sign-in policy strength rule; this bound keeps chpasswd's one-line input format intact.
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(password))
    return fail('VALIDATION', 'the password must be one line of 8 to 1024 bytes', unchanged)
  const readShadow = input.readShadow ?? (() => readFile('/etc/shadow', 'utf8'))
  const before = rootHash(await readShadow().catch(() => ''))
  if (before === null) return fail('PRECONDITION_FAILED', 'the root shadow entry could not be read', { ...unchanged, reason: 'shadow_unreadable' })
  const result = await (input.write ?? chpasswdRoot)(password).catch(() => null)
  const after = rootHash(await readShadow().catch(() => ''))
  const changed = after !== null && after !== before && /^\$[0-9a-z]+\$/.test(after)
  if (!result?.ok || !changed) return fail('SERVICE_UNAVAILABLE', 'the root password change could not be verified', { stateChanged: after !== before, verificationRequired: true, ...(result ? { exitCode: result.code } : {}) })
  return { outcome: 'applied', scheme: after.split('$')[1]! }
}

/** The password travels on standard input only, so it never reaches an argv or a log. */
export const chpasswdUser = (user: string, password: string): Promise<{ ok: boolean; code: number }> => new Promise(resolve => {
  const child = spawn('/usr/sbin/chpasswd', [], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, shell: false, windowsHide: true })
  const timer = setTimeout(() => child.kill('SIGKILL'), PASSWORD_TIMEOUT_MS)
  child.on('error', () => { clearTimeout(timer); resolve({ ok: false, code: 127 }) })
  child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, code: code ?? 124 }) })
  child.stdin.on('error', () => undefined)
  child.stdin.end(user + ':' + password + '\n', 'utf8')
})
const chpasswdRoot: RootPasswordWriter = password => chpasswdUser('root', password)

export interface RootIdentityRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  family: string
  /** Native Linux host only; null keeps every route unavailable instead of simulating one. */
  run: RootIdentityRun | null
  accounts: () => Promise<readonly Account[]>
  writePassword?: RootPasswordWriter
  readShadow?: ShadowReader
  now?: () => Date
}
const ROUTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/host/identity/admin-group': { GET: 'security.admin_group.read', POST: 'security.admin_group.update' },
  '/host/identity/root-password': { POST: 'security.root_password.update' },
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function readBody(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 4096 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== [...keys].sort().join()) return fail('VALIDATION', `only ${keys.join(', ')} are accepted`, unchanged)
  return body as Record<string, unknown>
}

export async function handleRootIdentityRoute(req: Request, url: URL, method: string, ctx: RootIdentityRouteContext): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const action = Object.hasOwn(route, method) ? route[method]! : null
  if (!action) return new Response(null, { status: 405, headers: { allow: Object.keys(route).join(', ') } })
  await ctx.assertRoot(action)
  if (url.search) return fail('VALIDATION', 'identity routes accept no selectors', unchanged)
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'root identity changes require the native Linux host executor', unchanged)
  const run = ctx.run
  if (url.pathname === '/host/identity/root-password') {
    const body = await readBody(req, ['password'])
    await ctx.assertRoot(action)
    return json(await setRootPassword({ password: body.password, ...(ctx.writePassword ? { write: ctx.writePassword } : {}), ...(ctx.readShadow ? { readShadow: ctx.readShadow } : {}) }))
  }
  if (method === 'GET') return json(await observeAdminGroup({ family: ctx.family, run, accounts: await ctx.accounts(), ...(ctx.now ? { now: ctx.now } : {}) }))
  const body = await readBody(req, ['action', 'username'])
  await ctx.assertRoot(action)
  return json(await changeAdminGroup({ family: ctx.family, run, accounts: await ctx.accounts(), action: body.action, username: body.username, ...(ctx.now ? { now: ctx.now } : {}) }))
}
