import { createHash } from 'node:crypto'
import { effectiveServerSshSettings, fail, firewallRuleSetErrors, MANAGEMENT_PUBLIC_PORTS, sshLockoutReason, validateServerSettings, validateServerSshSettings, validateShellJailPolicy } from '@xpanel/core'
import type { FirewallRule, ServerSettings, ServerSshSettings, SshAccessFacts } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { configuredChannels } from './alert-delivery.ts'
import type { DeliveryChannels } from './alert-delivery.ts'
import { SSH_ALARM_FILE } from './ssh-login-alarm.ts'

export interface SshWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'getServerSettings' | 'saveServerSettings' | 'getFirewallState' | 'getFirewallPending' | 'replaceFirewall'>
  /** Protected agent transport; a body sends a POST mutation. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  reconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
  /** Trusted transport peer of the request; never a browser-supplied header. */
  clientIp: (req: Request) => string | null
  readChannels: () => Promise<DeliveryChannels | null>
  writeAlarmState: (file: string, value: unknown) => Promise<unknown>
}

export const SSH_TRANSITION_RULE = 'ssh-port-transition'
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const stateText = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[a-z-]{1,32}$/.test(value)
const unverified = (): never => fail('PRECONDITION_FAILED', 'the SSH host read could not be verified', { stateChanged: false, verificationRequired: true })
const review = (): never => fail('SERVICE_UNAVAILABLE', 'the SSH change outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })

export interface SshCountView { accepted: number; failed: number; complete: boolean }
const countOf = (value: unknown): SshCountView => object(value) && count(value.accepted) && count(value.failed) && typeof value.complete === 'boolean' ? { accepted: value.accepted, failed: value.failed, complete: value.complete } : unverified()
export function projectSshCounters(value: unknown): { observedAt: string; service: { active: string | null; substate: string | null; enabled: string | null }; today: SshCountView; total: SshCountView } {
  if (!object(value) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || !object(value.service) || ![value.service.active, value.service.substate, value.service.enabled].every(stateText)) return unverified()
  return { observedAt: value.observedAt, service: { active: value.service.active as string | null, substate: value.service.substate as string | null, enabled: value.service.enabled as string | null }, today: countOf(value.today), total: countOf(value.total) }
}
export function projectSshPrepared(value: unknown): { access: SshAccessFacts; portInUse: boolean | null } {
  const access = object(value) ? value.access : null
  if (!object(value) || !object(access) || ![true, false, null].includes(value.portInUse as boolean | null) || ![true, false, null].includes(access.rootPassword as boolean | null) || !(access.rootKeys === null || count(access.rootKeys)) || !(access.otherAdministrators === null || count(access.otherAdministrators))) return unverified()
  return { access: { rootKeys: access.rootKeys as number | null, rootPassword: access.rootPassword as boolean | null, otherAdministrators: access.otherAdministrators as number | null }, portInUse: value.portInUse as boolean | null }
}

/** What the page reviewed; the login alarm and the jail have their own routes and never collide with a sign-in change. */
export const sshRevision = (settings: ServerSettings): string => {
  const { passwordAuth, pubkeyAuth, rootLogin } = effectiveServerSshSettings(settings)
  return createHash('sha256').update(JSON.stringify({ port: settings.sshPort, passwordAuth, pubkeyAuth, rootLogin })).digest('hex')
}
export const shellJailRevision = (settings: ServerSettings): string => createHash('sha256').update(JSON.stringify(effectiveServerSshSettings(settings).jail)).digest('hex')

const settingsView = (settings: ServerSettings) => {
  const { passwordAuth, pubkeyAuth, rootLogin, loginAlarm, previousPort } = effectiveServerSshSettings(settings)
  return { port: settings.sshPort, passwordAuth, pubkeyAuth, rootLogin, loginAlarm, previousPort: previousPort ?? null, revision: sshRevision(settings) }
}

async function readBody(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const raw = await request.text()
  if (raw.length > 64 * 1024) return fail('VALIDATION', 'SSH request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(body) || Object.keys(body).length !== fields.length || fields.some(key => !Object.hasOwn(body as object, key))) return fail('VALIDATION', 'unsupported SSH request field', unchanged)
  return body
}

const POLICY = '/api/server/security-tools/isolation/policy', VERIFY = '/api/server/security-tools/isolation/verify'
const ROUTES: Readonly<Record<string, readonly string[]>> = { '/api/server/ssh': ['GET', 'PUT'], '/api/server/ssh/service': ['POST'], '/api/server/ssh/login-alarm': ['PUT'], [POLICY]: ['GET', 'PUT'], [VERIFY]: ['POST'] }

/** Root-only SSH sign-in policy, daemon control, login alarm and shell jail. Every change is tested, and a port change proves the new port before the old one closes. */
export async function handleSshWorkspaceRoute(request: Request, url: URL, method: string, helpers: SshWorkspaceHelpers): Promise<Response | null> {
  const path = url.pathname, methods = Object.hasOwn(ROUTES, path) ? ROUTES[path]! : null
  if (!methods) return null
  const jail = path === POLICY || path === VERIFY
  const action = method === 'GET' ? 'server.ssh.read' : jail ? 'server.ssh.jail' : path.endsWith('/service') ? 'server.ssh.service' : 'server.ssh.settings'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (!methods.includes(method)) return new Response(null, { status: 405, headers: { allow: methods.join(', ') } })
  if (url.search) return fail('VALIDATION', 'SSH routes do not accept selectors', unchanged)
  const settings = await helpers.store.getServerSettings() ?? fail('PRECONDITION_FAILED', 'save the server settings first', unchanged)
  const host = (path: string, body?: Record<string, unknown>): Promise<unknown> => helpers.callHost ? helpers.callHost(caller, path, body) : fail('PRECONDITION_FAILED', 'SSH changes require a connected host agent', unchanged)
  const audit = (name: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: name, target, outcome, detail })
  const fresh = async (): Promise<void> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) fail('FORBIDDEN', 'SSH authority changed', unchanged)
  }
  const save = (next: ServerSettings): Promise<ServerSettings> => helpers.store.saveServerSettings(next, { settingsGuard: fresh })
  const applied = async (): Promise<boolean> => {
    const result = await helpers.reconcile(caller)
    return !!result && result.ok && ['applied', 'noop'].includes(String(result.body.status))
  }

  if (path === POLICY) {
    if (method === 'GET') return json({ policy: effectiveServerSshSettings(settings).jail, revision: shellJailRevision(settings) })
    const body = await readBody(request, ['privateTmp', 'hiddenHomes', 'systemView', 'exceptions', 'expectedRevision'])
    if (body.expectedRevision !== shellJailRevision(settings)) return fail('CONFLICT', 'the isolation policy changed since it was read; reload before saving', unchanged)
    const { expectedRevision: _, ...policy } = body
    const next = { ...settings, ssh: { ...effectiveServerSshSettings(settings), jail: validateShellJailPolicy(policy) } }
    await save(next)
    if (!await applied()) {
      await save({ ...settings, ssh: effectiveServerSshSettings(settings) })
      await applied()
      return fail('CONFIG_TEST_FAILED', 'the host refused the isolation policy; the previous policy stays in force', unchanged)
    }
    await audit('server.ssh.jail.updated', 'ssh:shell-jail', { privateTmp: next.ssh.jail.privateTmp, hiddenHomes: next.ssh.jail.hiddenHomes, systemView: next.ssh.jail.systemView, exceptions: next.ssh.jail.exceptions.map(entry => entry.username) })
    return json({ policy: next.ssh.jail, revision: shellJailRevision(next) })
  }
  if (path === VERIFY) {
    const body = await readBody(request, ['account'])
    if (typeof body.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(body.account)) return fail('VALIDATION', 'an account username is required', unchanged)
    return json(await host('/host/security-tools/isolation/verify', { account: body.account }))
  }

  if (path === '/api/server/ssh') {
    if (method === 'GET') {
      const channels = configuredChannels(await helpers.readChannels(), true)
      return json({ settings: settingsView(settings), alarmChannels: channels, host: helpers.callHost ? projectSshCounters(await host('/host/security/ssh/counters')) : null })
    }
    const body = await readBody(request, ['port', 'passwordAuth', 'pubkeyAuth', 'rootLogin', 'expectedRevision'])
    if (body.expectedRevision !== sshRevision(settings)) return fail('CONFLICT', 'the SSH settings changed since they were read; reload before saving', unchanged)
    const before = effectiveServerSshSettings(settings), original = { ...settings, ssh: before }
    const ssh: ServerSshSettings = validateServerSshSettings({ passwordAuth: body.passwordAuth, pubkeyAuth: body.pubkeyAuth, rootLogin: body.rootLogin, loginAlarm: before.loginAlarm, jail: before.jail })
    const port = body.port as number, moving = port !== settings.sshPort
    const final = validateServerSettings({ ...settings, sshPort: port, ssh })
    const firewall = await helpers.store.getFirewallState()
    if (await helpers.store.getFirewallPending()) return fail('CONFLICT', 'a firewall change is waiting for confirmation; confirm it before changing SSH', unchanged)
    const lists = Object.fromEntries(firewall.prefixLists.map(item => [item.name, item.entries]))
    const portErrors = firewallRuleSetErrors(firewall.rules, { ...final, managementPorts: MANAGEMENT_PUBLIC_PORTS, prefixLists: lists })
    if (portErrors.length) return fail('VALIDATION', portErrors[0]!, { ...unchanged, errors: portErrors.slice(0, 8) })
    if (sshRevision(final) === sshRevision(settings) && before.previousPort === undefined) return json({ settings: settingsView(settings), application: { changed: false } })
    const prepared = projectSshPrepared(await host('/host/security/ssh/prepare', { port: moving ? port : null }))
    const reason = sshLockoutReason(ssh, prepared.access)
    if (reason) return fail('SELF_LOCKOUT', 'this policy would leave no way to sign in over SSH', { ...unchanged, reason })
    if (moving && prepared.portInUse !== false) return fail('CONFLICT', prepared.portInUse === null ? 'the listening ports could not be read' : 'another service listens on that port', { ...unchanged, reason: prepared.portInUse === null ? 'port_unread' : 'port_in_use' })
    await fresh()

    if (!moving) {
      await save(final)
      if (!await applied()) {
        await save(original)
        await applied()
        await audit('server.ssh.settings.refused', 'ssh:settings', { port }, 'failed')
        return fail('CONFIG_TEST_FAILED', 'sshd refused the new policy; the previous policy stays in force', unchanged)
      }
    } else {
      const sessionIp = helpers.clientIp(request) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for SSH port changes', unchanged)
      const system = firewall.rules.find(rule => rule.id === 'default-ssh') ?? null, others = firewall.rules.filter(rule => rule.id !== SSH_TRANSITION_RULE)
      const opening: FirewallRule[] = system ? others.flatMap(rule => rule.id === 'default-ssh' ? [{ ...rule, id: SSH_TRANSITION_RULE, port: String(port), comment: 'SSH during a port change' }, rule] : [rule]) : others
      const writeRules = (rules: FirewallRule[], sshPort: number) => firewall.rules.length ? helpers.store.replaceFirewall({ rules, prefixLists: firewall.prefixLists }, { lockout: { sessionIp, panelPort: settings.panelPort, managementPorts: MANAGEMENT_PUBLIC_PORTS, sshPort } }) : Promise.resolve(null)
      const undo = async (): Promise<void> => { await writeRules(firewall.rules, settings.sshPort); await save(original); await applied() }
      // New port first: the firewall opens it, sshd listens on both, and only an answer on the new port closes the old one.
      await writeRules(opening, port)
      const both = { ...final, ssh: { ...ssh, previousPort: before.previousPort ?? settings.sshPort } }
      await save(both)
      if (!await applied()) {
        await undo()
        await audit('server.ssh.settings.refused', 'ssh:settings', { port }, 'failed')
        return fail('CONFIG_TEST_FAILED', 'sshd refused the new port; the previous port stays in use', unchanged)
      }
      const proof = await host('/host/security/ssh/probe', { port }).catch(() => null)
      if (!object(proof) || proof.answer !== 'banner') {
        await undo()
        await audit('server.ssh.settings.refused', 'ssh:settings', { port, answer: object(proof) ? proof.answer : null }, 'failed')
        return fail('SERVICE_UNAVAILABLE', 'sshd did not answer on the new port; the previous port stays in use', { ...unchanged, reason: 'port_not_answering' })
      }
      await writeRules(others.map(rule => rule.id === 'default-ssh' ? { ...rule, port: String(port) } : rule), port)
      await save(final)
      if (!await applied()) {
        await writeRules(opening, port)
        await save(both)
        await applied()
        await audit('server.ssh.settings.refused', 'ssh:settings', { port, closingOldPort: false }, 'failed')
        return fail('SERVICE_UNAVAILABLE', 'the old port could not be closed; both ports stay open until the change is retried', { stateChanged: true, verificationRequired: true, reason: 'old_port_open' })
      }
    }
    await fresh().catch(() => review())
    await audit('server.ssh.settings.updated', 'ssh:settings', { port, passwordAuth: ssh.passwordAuth, pubkeyAuth: ssh.pubkeyAuth, rootLogin: ssh.rootLogin })
    return json({ settings: settingsView(final), application: { changed: true, ...moving ? { portAnswered: true } : {} } })
  }

  if (path === '/api/server/ssh/service') {
    const body = await readBody(request, ['action'])
    if (body.action !== 'start' && body.action !== 'stop') return fail('VALIDATION', 'action must be start or stop', unchanged)
    await fresh()
    const result = await host('/host/security/ssh/service', { action: body.action })
    if (!object(result) || result.action !== body.action || typeof result.verified !== 'boolean' || !['banner', 'refused', 'silent'].includes(String(result.answer)) || !stateText(result.active)) return review()
    return json({ action: result.action, active: result.active, answer: result.answer, verified: result.verified })
  }

  const body = await readBody(request, ['enabled'])
  if (typeof body.enabled !== 'boolean') return fail('VALIDATION', 'enabled must be a boolean', unchanged)
  const current = effectiveServerSshSettings(settings)
  if (body.enabled && !configuredChannels(await helpers.readChannels(), true).length) return fail('PRECONDITION_FAILED', 'add a notification recipient or webhook first', { ...unchanged, reason: 'no_notification_channel' })
  if (body.enabled) {
    // The cursor marks the present: an alarm reports logins from now on, never history.
    const start = await host('/host/security/ssh/logins')
    await helpers.writeAlarmState(SSH_ALARM_FILE, { cursor: object(start) && typeof start.cursor === 'string' ? start.cursor : null })
  }
  await save({ ...settings, ssh: { ...current, loginAlarm: body.enabled } })
  await audit('server.ssh.login_alarm', 'ssh:login-alarm', { enabled: body.enabled })
  return json({ enabled: body.enabled })
}
