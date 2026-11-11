import { readFile } from 'node:fs/promises'
import net, { isIP } from 'node:net'
import { fail } from '@xpanel/core'
import type { OsProfile, SshAccessFacts } from '@xpanel/core'
import { system } from '@xpanel/render'
import { isSshJournalCursor, sshCountArgv, sshLoginsArgv, sshPortLabelArgv, sshServiceArgv, SSH_COUNT_LINES, SSH_LOGIN_LINES, SSH_PORT_LIST, SSH_SOCKET_UNIT } from '../../../packages/os/src/ssh-host-command.ts'
import { observeActiveSshSessions, type SshOpenSessionsView } from './ssh-sessions.ts'

export interface SshLogin { id: string; at: string; address: string; port: number; username: string; method: string }
export interface SshLoginRead { cursor: string | null; items: SshLogin[]; complete: boolean }
export interface SshLoginCount { accepted: number; failed: number; complete: boolean }
export interface SshCounters { observedAt: string; service: { active: string | null; substate: string | null; enabled: string | null }; today: SshLoginCount; total: SshLoginCount; openSessions?: SshOpenSessionsView }
export interface SshPrepared { access: SshAccessFacts; portInUse: boolean | null; portLabel: 'labeled' | 'not_needed' }
export type SshPortAnswer = 'banner' | 'refused' | 'silent'
export interface SshServiceResult { action: 'start' | 'stop'; active: string | null; answer: SshPortAnswer; verified: boolean }

type Run = (argv: string[]) => Promise<{ ok: boolean; code?: number; stdout: string; stderr: string }>
export interface SshHostContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host commands only; null keeps every route unavailable instead of simulating one. */
  run: Run | null
  os: () => Promise<Pick<OsProfile, 'id' | 'versionId' | 'services'>>
  /** Authorized root keys counted by the managed key observation; null when unread. */
  rootKeys: () => Promise<number | null>
  openSessions?: () => Promise<SshOpenSessionsView>
  audit?: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  selinux: () => Promise<boolean>
  readText?: (path: string) => Promise<string | null>
  probe?: (port: number) => Promise<SshPortAnswer>
  settle?: () => Promise<void>
  now?: () => Date
}

const unchanged = { stateChanged: false }
const showUnit = (unit: string): string[] => ['/usr/bin/systemctl', 'show', unit, '--property=ActiveState,SubState,UnitFileState,LoadState']
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const fileText = (path: string): Promise<string | null> => readFile(path, 'utf8').catch(() => null)
export const sshUnit = (os: Pick<OsProfile, 'services'>): string => os.services.sshd.endsWith('.service') ? os.services.sshd : os.services.sshd + '.service'

/** A journal entry is trusted only from the root sshd of this unit; a user cannot write these fields. */
const trusted = (entry: Record<string, unknown>, unit: string): boolean => entry._UID === '0' && entry._SYSTEMD_UNIT === unit && ['sshd', 'sshd-session'].includes(String(entry._COMM)) && ['/usr/sbin/sshd', '/usr/lib/openssh/sshd-session', '/usr/libexec/openssh/sshd-session'].includes(String(entry._EXE))

const ACCEPTED = /^Accepted ([a-zA-Z0-9@/_-]{1,64}) for (\S{1,64}) from ([0-9a-fA-F:.]+) port (\d{1,5})(?: ssh2)?(?:: .*)?$/

/** Accepted logins in journal order, plus the cursor to read after them. */
export function parseSshLogins(stdout: string, unit: string): SshLoginRead {
  if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) return fail('PRECONDITION_FAILED', 'SSH journal response exceeds its bound')
  const lines = stdout.split('\n').filter(Boolean), items: SshLogin[] = []
  let cursor: string | null = null
  for (const line of lines) {
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) as Record<string, unknown> } catch { return fail('PRECONDITION_FAILED', 'SSH journal output is not structured JSON') }
    if (!entry || typeof entry !== 'object') continue
    if (isSshJournalCursor(entry.__CURSOR)) cursor = entry.__CURSOR
    if (!trusted(entry, unit) || typeof entry.MESSAGE !== 'string' || entry.MESSAGE.length > 2048 || UNSAFE.test(entry.MESSAGE) || typeof entry.__REALTIME_TIMESTAMP !== 'string' || !/^\d{10,20}$/.test(entry.__REALTIME_TIMESTAMP)) continue
    const match = ACCEPTED.exec(entry.MESSAGE)
    if (!match || !isIP(match[3]!) || Number(match[4]) > 65535 || !isSshJournalCursor(entry.__CURSOR)) continue
    const at = new Date(Number(BigInt(entry.__REALTIME_TIMESTAMP) / 1000n))
    if (Number.isFinite(at.getTime())) items.push({ id: entry.__CURSOR, at: at.toISOString(), address: match[3]!, port: Number(match[4]), username: match[2]!, method: match[1]! })
  }
  return { cursor, items, complete: lines.length < SSH_LOGIN_LINES }
}

/** Each sign-in attempt logs one Accepted or Failed line; the journal keeps only what its retention keeps. */
export function countSshLogins(stdout: string): SshLoginCount {
  const lines = stdout.split('\n').filter(Boolean)
  return { accepted: lines.filter(line => line.startsWith('Accepted ')).length, failed: lines.filter(line => line.startsWith('Failed ')).length, complete: lines.length < SSH_COUNT_LINES }
}

/** /proc/net/tcp{,6}: local address is hex addr:port, state 0A is LISTEN. */
export function listeningPorts(tables: readonly string[]): Set<number> {
  const ports = new Set<number>()
  for (const table of tables) for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields[3] === '0A') ports.add(parseInt(fields[1]!.split(':')[1]!, 16))
  }
  return ports
}

const LOGIN_SHELL = (shell: string | undefined): boolean => !!shell && !/\/(?:nologin|false)$/.test(shell) && !shell.endsWith('/jailshell')
/** sudo and wheel members who are not root and have an ordinary login shell. */
export function otherAdministrators(group: string, passwd: string): number {
  const shells = new Map(passwd.split('\n').map(line => line.split(':')).filter(fields => fields.length === 7).map(fields => [fields[0]!, fields[6]!]))
  const members = group.split('\n').map(line => line.split(':')).filter(fields => fields.length === 4 && ['sudo', 'wheel'].includes(fields[0]!)).flatMap(fields => fields[3]!.split(',').filter(Boolean))
  return new Set(members.filter(name => name !== 'root' && LOGIN_SHELL(shells.get(name)))).size
}

/** A usable crypt(3) hash starts with $; ! and * mark a locked or empty password. Only the verdict leaves this function. */
export const rootPasswordUsable = (shadow: string): boolean => { const hash = shadow.split('\n').find(line => line.startsWith('root:'))?.split(':')[1]; return !!hash && hash.startsWith('$') }

const addressOf = (host: string, port: number): Promise<SshPortAnswer> => new Promise(resolve => {
  const socket = net.connect({ host, port }), done = (answer: SshPortAnswer): void => { socket.destroy(); clearTimeout(timer); resolve(answer) }
  const timer = setTimeout(() => done('silent'), 3000)
  socket.once('data', chunk => done(chunk.toString('latin1').startsWith('SSH-2.0-') ? 'banner' : 'silent'))
  socket.once('error', error => done((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'silent'))
})
/** Asks the daemon itself: a port answers with an SSH banner, or it refuses. */
export const probeSshPort = async (port: number): Promise<SshPortAnswer> => { const v4 = await addressOf('127.0.0.1', port); return v4 === 'banner' ? v4 : (await addressOf('::1', port)) === 'banner' ? 'banner' : v4 }

const readJson = async (req: Request, field: string): Promise<unknown> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  if (text.length > 256) return fail('VALIDATION', 'SSH request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== field) return fail('VALIDATION', 'unsupported SSH request field', unchanged)
  return (body as Record<string, unknown>)[field]
}
const portOf = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : fail('VALIDATION', 'an SSH port from 1 to 65535 is required', unchanged)

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/security/ssh/logins': { method: 'GET', action: 'security.observe' },
  '/host/security/ssh/counters': { method: 'GET', action: 'security.observe' },
  '/host/security/ssh/service': { method: 'POST', action: 'security.ssh.service' },
  '/host/security/ssh/prepare': { method: 'POST', action: 'security.ssh.settings' },
  '/host/security/ssh/probe': { method: 'POST', action: 'security.ssh.settings' },
}

/** Root-only SSH reads and service control. Requests carry a cursor, a port or a verb; argv comes from the reviewed command module. */
export async function handleSshHostRoute(req: Request, url: URL, method: string, ctx: SshHostContext): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const { actor } = await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const logins = url.pathname === '/host/security/ssh/logins', query = [...url.searchParams]
  if (url.search && !(logins && query.length === 1 && query[0]![0] === 'after' && isSshJournalCursor(query[0]![1]))) return fail('VALIDATION', 'SSH routes accept only a journal cursor on logins', unchanged)
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'SSH host control requires the native Linux host executor', unchanged)
  const run = ctx.run, os = await ctx.os(), unit = sshUnit(os), now = ctx.now ?? (() => new Date()), read = ctx.readText ?? fileText, probe = ctx.probe ?? probeSshPort
  const sure = async (argv: string[]): Promise<string> => {
    const result = await run(argv)
    return result.ok ? result.stdout : fail('PRECONDITION_FAILED', 'the SSH journal could not be read', unchanged)
  }

  if (logins) {
    const cursor = url.searchParams.get('after'), parsed = parseSshLogins(await sure(sshLoginsArgv(unit, cursor)), unit)
    // No cursor reads one line to find the present; nothing older is reported.
    return json(cursor === null ? { cursor: parsed.cursor, items: [], complete: true } : parsed.cursor === null ? { cursor, items: [], complete: true } : parsed)
  }
  if (url.pathname === '/host/security/ssh/counters') {
    const [today, total, shown, openSessions] = await Promise.all([
      sure(sshCountArgv(unit, 'today')),
      sure(sshCountArgv(unit, 'all')),
      run(showUnit(unit)),
      ctx.openSessions ? ctx.openSessions().catch(() => ({ state: 'unavailable' as const, count: null })) : observeActiveSshSessions({ scope: 'host', procRoot: process.platform === 'linux' ? '/proc' : null }),
    ])
    const value = (key: string): string | null => shown.ok ? new RegExp('^' + key + '=([a-z-]{1,32})$', 'm').exec(shown.stdout)?.[1] ?? null : null
    return json({ observedAt: now().toISOString(), service: { active: value('ActiveState'), substate: value('SubState'), enabled: value('UnitFileState') }, today: countSshLogins(today), total: countSshLogins(total), openSessions } satisfies SshCounters)
  }
  if (url.pathname === '/host/security/ssh/probe') return json({ answer: await probe(portOf(await readJson(req, 'port'))) })
  if (url.pathname === '/host/security/ssh/prepare') {
    const raw = await readJson(req, 'port'), port = raw === null ? null : portOf(raw)
    const [group, passwd, shadow, tcp, tcp6, rootKeys] = await Promise.all([read('/etc/group'), read('/etc/passwd'), read('/etc/shadow'), read('/proc/net/tcp'), read('/proc/net/tcp6'), ctx.rootKeys().catch(() => null)])
    let portLabel: SshPrepared['portLabel'] = 'not_needed'
    if (port !== null && await ctx.selinux()) {
      const listed = await run([...SSH_PORT_LIST])
      if (!listed.ok) return fail('PRECONDITION_FAILED', 'the SELinux port labels could not be read', { ...unchanged, reason: 'selinux_port_unread' })
      const ownedBySsh = listed.stdout.split('\n').some(line => /^ssh_port_t\s+tcp\s/.test(line) && line.split(/\s+/).slice(2).join('').split(',').includes(String(port)))
      if (!ownedBySsh) {
        const defined = listed.stdout.split('\n').some(line => /\stcp\s/.test(line) && line.trim().split(/\s+/).slice(2).join('').split(',').includes(String(port)))
        const labeled = await run(sshPortLabelArgv(defined ? '-m' : '-a', port))
        if (!labeled.ok) return fail('PRECONDITION_FAILED', 'SELinux refused the new SSH port', { ...unchanged, reason: 'selinux_port_refused' })
      }
      portLabel = 'labeled'
    }
    const listening = tcp === null ? null : listeningPorts([tcp, tcp6 ?? ''])
    return json({ access: { rootKeys, rootPassword: shadow === null ? null : rootPasswordUsable(shadow), otherAdministrators: group === null || passwd === null ? null : otherAdministrators(group, passwd) },
      portInUse: port === null || listening === null ? null : listening.has(port), portLabel } satisfies SshPrepared)
  }

  const verb = await readJson(req, 'action')
  if (verb !== 'start' && verb !== 'stop') return fail('VALIDATION', 'action must be start or stop', unchanged)
  // The unit stays enabled, so a stopped daemon comes back with the next boot.
  const socketActivated = system.sshdSocketActivated(os)
  for (const target of [...(socketActivated ? [SSH_SOCKET_UNIT] : []), unit]) {
    if (!(await run(sshServiceArgv(verb, target))).ok) {
      await ctx.audit?.({ actor, action: 'security.ssh.service', target: 'ssh', outcome: 'failed', detail: { action: verb, unit: target } }).catch(() => {})
      return fail('SERVICE_UNAVAILABLE', `systemctl ${verb} ${target} failed`, { stateChanged: true, verificationRequired: true })
    }
  }
  await ctx.settle?.()
  const shown = await run(showUnit(unit))
  const active = shown.ok ? /^ActiveState=(\S+)/m.exec(shown.stdout)?.[1] ?? null : null
  const sshd = await run([system.SSHD_BINARY, '-T', '-f', '/etc/ssh/sshd_config'])
  const port = Number(/^port (\d+)$/m.exec(sshd.stdout)?.[1] ?? 22), answer = await probe(port)
  const verified = verb === 'stop' ? active !== 'active' && answer === 'refused' : answer === 'banner'
  await ctx.audit?.({ actor, action: 'security.ssh.service', target: 'ssh', outcome: verified ? 'ok' : 'failed', detail: { action: verb, active, answer } }).catch(() => {})
  return json({ action: verb, active, answer, verified } satisfies SshServiceResult)
}
