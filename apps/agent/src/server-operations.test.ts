import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultServerRoles, SERVER_OPERATIONS_STATE } from '@xpanel/core'
import type { HostAction, RenderedFile, ServerRoleState } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { isServerRoleCommand, serverRoleRuntimeArgv, serverRoleSwitchArgv } from '../../../packages/os/src/server-role-command.ts'
import { applyServerOperations, buildRoleApplyPlan, disabledRoleUnits, handleServerOperationsRoute, readServerOperations, renderZoneCatalog, roleUnitChanges, scanDnsCatalog } from './server-operations.ts'
import type { ServerOperationsHost, ServerOperationsRouteContext } from './server-operations.ts'
import { createUpdater } from './update-policy.ts'
import type { UpgradeCoordinator } from './upgrade-routes.ts'
import { DEFAULT_NAMED_ZONES_CONF } from './services/dns.ts'
import type { Db } from '@xpanel/db'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const roots: string[] = []
const stateRoot = async (files: Record<string, unknown> = {}): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'w5-server-')); roots.push(root)
  await mkdir(join(root, 'extended', 'server'), { recursive: true })
  for (const [path, value] of Object.entries(files)) await writeFile(join(root, path), JSON.stringify(value))
  return root
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const hostFor = (files: Record<string, string> = {}) => {
  const written: RenderedFile[] = [], removed: string[] = [], actions: HostAction[] = [], commands: string[][] = []
  const host: ServerOperationsHost = {
    readFile: async path => files[path] ?? null,
    writeFile: async file => { written.push(file); files[file.path] = file.content },
    removePath: async path => { removed.push(path) },
    runAction: async action => { actions.push(action) },
    runCommand: async argv => { commands.push(argv); return { ok: true, stdout: 'loaded\n', stderr: '' } },
  }
  return { host, written, removed, actions, commands }
}
const context = (over: Partial<ServerOperationsRouteContext>): ServerOperationsRouteContext => ({
  assertRoot: async () => ({ actor: 'root' }), host: null, family: 'debian', rootDir: '/nonexistent', savedZones: async () => [],
  listZoneFiles: async () => ({ state: 'read', entries: [], truncated: false }), submitJob: null, reconcile: async () => ({ ok: true, status: 'applied' }), ...over,
})
const route = (path: string, method: string, ctx: ServerOperationsRouteContext, body?: unknown) =>
  handleServerOperationsRoute(new Request('http://agent.local' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('http://agent.local' + path), method, ctx)

describe('server operations on the host', { tags: ['unit'] }, () => {
  it('keeps a disabled role daemon out of the generation and leaves nginx alone', () => {
    const roles: ServerRoleState = { profile: 'dns-only', optional: [], dnsServer: 'disabled', ftpServer: 'pure-ftpd' }
    expect(disabledRoleUnits(roles)).toContain('pdns.service')
    expect(disabledRoleUnits(roles)).not.toContain('nginx.service')
    const actions: HostAction[] = [{ kind: 'systemd', verb: 'reload', unit: 'nginx' }, { kind: 'systemd', verb: 'reload', unit: 'apache2' }, { kind: 'systemd', verb: 'start', unit: 'postfix.service' }, { kind: 'exec', argv: ['/usr/bin/pdns_control', 'reload'] }]
    const files: RenderedFile[] = []
    applyServerOperations(files, actions, { roles, forwards: [], systemMail: null, panelTls: null }, os)
    expect(actions).toEqual([{ kind: 'systemd', verb: 'reload', unit: 'nginx' }])
    expect(files).toEqual([])
  })

  it('adds the saved forwards, panel TLS and aliases', () => {
    const files: RenderedFile[] = [], actions: HostAction[] = []
    applyServerOperations(files, actions, { roles: defaultServerRoles(), forwards: [{ domain: 'example.org', url: 'https://example.net/', ip: '192.0.2.3', createdAt: '2026-11-07T00:00:00.000Z' }],
      systemMail: { root: 'admin@example.net', nobody: null, xpanel: null }, panelTls: { protocols: ['TLSv1.3'], ciphers: 'HIGH' }, etcAliases: 'root: ubuntu\n' }, os)
    expect(files.map(file => file.path)).toEqual([`${os.paths.nginxVhostDir}/001-xpanel-domain-forwards.conf`, '/etc/nginx/xpanel-management/tls-policy.conf', '/etc/aliases'])
    expect(actions).toEqual([{ kind: 'exec', argv: ['/usr/bin/newaliases'] }])
  })

  it('reads missing state as defaults and refuses an invalid saved file', async () => {
    expect(await readServerOperations(await stateRoot())).toEqual({ roles: defaultServerRoles(), forwards: [], systemMail: null, panelTls: null })
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.roles]: { profile: 'bind' } })
    await expect(readServerOperations(root)).rejects.toMatchObject({ detail: { reason: 'server_setting_invalid' } })
  })

  it('admits only role units in the reviewed systemctl grammar', () => {
    expect(isServerRoleCommand(serverRoleSwitchArgv('disable', 'pure-ftpd.service'))).toBe(true)
    expect(isServerRoleCommand(serverRoleRuntimeArgv('stop', 'pure-ftpd.service'))).toBe(true)
    expect(isServerRoleCommand(serverRoleRuntimeArgv('start', 'pure-ftpd.service'))).toBe(true)
    expect(isServerRoleCommand(serverRoleSwitchArgv('disable', 'nginx.service'))).toBe(false)
    expect(isServerRoleCommand(serverRoleRuntimeArgv('stop', 'nginx.service'))).toBe(false)
    expect(isServerRoleCommand(serverRoleSwitchArgv('disable', 'xpanel-api.service'))).toBe(false)
    expect(isServerRoleCommand(['/usr/bin/systemctl', 'mask', '--', 'pure-ftpd.service'])).toBe(false)
  })

  it('switches installed units only and reconciles after the host agrees', async () => {
    const shown = new Map([['pure-ftpd.service', 'loaded']])
    const units = await roleUnitChanges(async argv => ({ ok: true, stdout: (shown.get(argv.at(-1)!) ?? 'not-found') + '\n' }), [{ role: 'ftp', change: 'disable' }, { role: 'mysql', change: 'disable' }])
    expect(units).toEqual([{ role: 'ftp', change: 'disable', unit: 'pure-ftpd.service' }])
    let reconciled = 0
    const plan = buildRoleApplyPlan(units, async () => { reconciled += 1; return { ok: true, status: 'applied' } })
    expect(plan.steps.map(step => step.argv)).toEqual([
      ['/usr/bin/systemctl', 'disable', '--now', '--', 'pure-ftpd.service'],
      ['/usr/bin/systemctl', 'stop', '--', 'pure-ftpd.service'],
    ])
    expect(plan.policy(['/usr/bin/systemctl', 'stop', '--', 'pure-ftpd.service'])).toBe(true)
    expect(plan.policy(['/usr/bin/systemctl', 'disable', '--now', '--', 'mariadb.service'])).toBe(false)
    expect(await plan.verify!(async () => ({ ok: true, code: 0, stdout: 'active\n', stderr: '', timedOut: false }))).toMatchObject({ ok: false, detail: { failed: 'pure-ftpd.service' } })
    expect(reconciled).toBe(0)
    expect(await plan.verify!(async () => ({ ok: true, code: 0, stdout: 'inactive\n', stderr: '', timedOut: false }))).toMatchObject({ ok: true, detail: { reconcile: 'applied' } })
    expect(reconciled).toBe(1)
  })

  it('refuses role changes that disagree with the saved roles', async () => {
    const { host } = hostFor()
    await expect(route('/host/server/roles/apply', 'POST', context({ host, rootDir: await stateRoot() }), { changes: [{ role: 'ftp', change: 'disable' }] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('writes the saved resolvers and reports the read-back', async () => {
    const { host, written } = hostFor({ '/etc/resolv.conf': 'nameserver 127.0.0.53\nsearch example.net\n' })
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.resolvers]: { resolvers: ['192.0.2.1', '192.0.2.2'] } })
    const response = await route('/host/server/resolvers/apply', 'POST', context({ host, rootDir: root }), {})
    expect(await response!.json()).toEqual({ applied: true, resolvers: ['192.0.2.1', '192.0.2.2'] })
    expect(written[0]!.content).toContain('nameserver 192.0.2.1\nnameserver 192.0.2.2\nsearch example.net\n')
  })

  it('opts NetworkManager out on EL before writing resolv.conf', async () => {
    const { host, written, commands } = hostFor()
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.resolvers]: { resolvers: ['192.0.2.1', '192.0.2.2'] } })
    await route('/host/server/resolvers/apply', 'POST', context({ host, rootDir: root, family: 'rhel' }), {})
    expect(written.map(file => file.path)).toEqual(['/etc/NetworkManager/conf.d/90-xpanel-dns.conf', '/etc/resolv.conf'])
    expect(commands.at(-1)).toEqual(['/usr/sbin/restorecon', '/etc/resolv.conf'])
  })

  it('finds duplicate and unsaved stanzas and orphan zone files', () => {
    const catalog = renderZoneCatalog(['a.test', 'a.test', 'gone.test'], '/z')
    expect(scanDnsCatalog(catalog, ['a.test'], ['a.test.zone', 'old.test.zone', 'readme'], new Date(0))).toMatchObject({ stanzas: 3, duplicates: ['a.test'], orphanStanzas: ['gone.test'], orphanFiles: ['old.test.zone'] })
  })

  it('cleans the catalog back to the reconciler rendering and reloads PowerDNS', async () => {
    const stale = renderZoneCatalog(['a.test', 'a.test'], '/var/lib/powerdns/zones')
    const { host, written, actions } = hostFor({ [DEFAULT_NAMED_ZONES_CONF]: stale })
    const response = await route('/host/dns-ops/cleanup', 'POST', context({ host, rootDir: await stateRoot(), savedZones: async () => ['a.test'] }), {})
    expect(await response!.json()).toMatchObject({ cleaned: 1, after: { duplicates: [], orphanStanzas: [] } })
    expect(written[0]!.content).toBe(renderZoneCatalog(['a.test'], '/var/lib/powerdns/zones'))
    expect(actions.map(action => action.kind === 'exec' ? action.argv[1] : '')).toEqual(['rediscover', 'reload'])
  })

  it('refuses a cleanup while the DNS role is off', async () => {
    const { host } = hostFor()
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.roles]: { ...defaultServerRoles(), dnsServer: 'disabled' } })
    await expect(route('/host/dns-ops/cleanup', 'POST', context({ host, rootDir: root }), {})).rejects.toMatchObject({ detail: { reason: 'dns_role_disabled' } })
  })

  it('refuses every route without the native executor', async () => {
    await expect(route('/host/server/resolvers/apply', 'POST', context({}), {})).rejects.toMatchObject({ detail: { reason: 'host_executor_unavailable' } })
    expect(await route('/host/other', 'GET', context({}))).toBeNull()
  })
})

describe('panel updater', { tags: ['unit'] }, () => {
  const observation = { revision: 'a'.repeat(64), current: { version: '1.2.3' }, availability: { candidates: ['1.2.4', '2.0.0'] } }
  const owner = { principalId: '33333333-3333-4333-8333-333333333333', username: 'root' }
  const db = { query: async () => [] } as unknown as Db
  const coordinator = {} as UpgradeCoordinator

  it('arms on the first tick, then hands off only a patch of the same minor', async () => {
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.updates]: { tier: 'release', updates: 'manual', securityPatches: true, owner } })
    const calls: string[] = []
    let at = new Date('2026-11-07T10:00:00.000Z')
    const updater = createUpdater({ rootDir: root, db, coordinator, now: () => at, call: async (_owner, path, body) => { calls.push(path + (body ? ':' + body.targetVersion : '')); return path.endsWith('start') ? new Response('{}', { status: 202 }) : Response.json(observation) } })
    expect(await updater.tick()).toEqual({ skipped: 'armed' })
    at = new Date('2026-11-07T10:30:00.000Z')
    expect(await updater.tick()).toEqual({ skipped: 'not_due' })
    expect(calls).toEqual([])
  })

  const due = async (saved: object) => {
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.updates]: { tier: 'release', updates: 'manual', securityPatches: true, owner, ...saved }, [SERVER_OPERATIONS_STATE.updateLedger]: { lastRunAt: '2026-11-07T09:59:00.000Z', lastSecurityAt: '2026-11-07T08:00:00.000Z', outcome: 'armed', target: null } })
    const started: unknown[] = []
    const updater = createUpdater({ rootDir: root, db, coordinator, now: () => new Date('2026-11-07T10:00:00.000Z'), readPrincipal: async () => ({ disabled: false, kind: 'root', username: 'root' }),
      call: async (_owner, path, body) => { if (body) started.push(body); return path.endsWith('start') ? new Response('{}', { status: 202 }) : Response.json(observation) } })
    return { tick: updater.tick, started }
  }

  it('the hourly run hands off the newest patch of the same minor and never a new major', async () => {
    const { tick, started } = await due({})
    expect(await tick()).toEqual({ started: '1.2.4' })
    expect(started).toEqual([{ targetVersion: '1.2.4', expectedRevision: 'a'.repeat(64), confirm: 'upgrade 1.2.4' }])
  })

  it('refuses to act for a disabled or changed owner', async () => {
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.updates]: { tier: 'release', updates: 'manual', securityPatches: true, owner }, [SERVER_OPERATIONS_STATE.updateLedger]: { lastRunAt: '2026-11-07T09:59:00.000Z', lastSecurityAt: '2026-11-07T08:00:00.000Z', outcome: 'armed', target: null } })
    const updater = createUpdater({ rootDir: root, db, coordinator, now: () => new Date('2026-11-07T10:00:00.000Z'), readPrincipal: async () => ({ disabled: true, kind: 'root', username: 'root' }), call: async () => { throw new Error('must not be called') } })
    expect(await updater.tick()).toEqual({ skipped: 'owner_unavailable' })
  })

  it('does nothing while updates are manual and security patches are off', async () => {
    const root = await stateRoot({ [SERVER_OPERATIONS_STATE.updates]: { tier: 'release', updates: 'manual', securityPatches: false, owner } })
    expect(await createUpdater({ rootDir: root, db, coordinator }).tick()).toEqual({ skipped: 'disabled' })
  })
})
