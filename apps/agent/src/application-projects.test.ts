import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import type { Account, Domain, OsProfile } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { system } from '@xpanel/render'
import { applyRuntimeOp, buildDepsCommand, buildPythonEnvCommand, compileAccountRuntime, EMPTY_RUNTIME, isAccountRuntimeCommand, parseRuntimeRegistry, preflightApp, runtimeAppPorts } from './account-runtime.ts'
import type { RuntimeHostFacts, RuntimeRegistry } from './account-runtime.ts'
import { handlePanelBackupsRoute, listPanelBackups, restorePanelSnapshot } from './panel-backups.ts'
import { readRuntimeOp } from '../../../packages/os/src/account-runtime-command.ts'

const domainId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', rev = 'a'.repeat(64)
const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', status: 'active' } as Account
const domain = { id: domainId, accountId: account.id, name: 'example.test', suspended: false, kind: 'primary' } as Domain
const plan = defaultPlan({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Default', ownerId: null, featureListId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
const facts: RuntimeHostFacts = { runtimes: [{ kind: 'go', available: true, version: null, reason: null }, { kind: 'java', available: true, version: '21.0', reason: null }, { kind: 'python', available: true, version: '3.12', reason: null }] as never, cache: [], containers: { available: false, version: null, reason: 'not-installed' }, jdks: [{ version: '17', binary: null }, { version: '21', binary: '/usr/lib/jvm/jre-21/bin/java' }], python: [{ version: '3.12', binary: '/usr/bin/python3.12', installed: true, full: '3.12.1' }, { version: '3.11', binary: '/usr/bin/python3.11', installed: false, full: null }] }
const input = { account, plan, disabled: [], facts, domains: [domain], now: '2026-11-07T00:00:00.000Z', root: true, usedPorts: new Set<number>() }
const project = (over: Record<string, unknown> = {}) => readRuntimeOp({ op: 'project.save', expectedRevision: rev, app: { name: 'svc', runtime: 'go', root: 'apps/svc', startup: 'server', domainId, path: '/', env: {}, port: null, openPort: false, jdk: null, command: null, ...over } })

describe('Go and Java projects', () => {
  it('saves one project with the lowest free private port, per host', () => {
    const next = applyRuntimeOp(project(), EMPTY_RUNTIME, { ...input, usedPorts: new Set([20000]) })
    expect(next.apps[0]).toMatchObject({ runtime: 'go', enabled: false, project: { port: 20001, openPort: false } })
    expect(parseRuntimeRegistry(JSON.parse(JSON.stringify(next))).apps[0]!.project!.port).toBe(20001)
  })
  it('refuses a port another project holds, and only root may save', () => {
    expect(() => applyRuntimeOp(project({ port: 20005 }), EMPTY_RUNTIME, { ...input, usedPorts: new Set([20005]) })).toThrow(expect.objectContaining({ code: 'CONFLICT', detail: expect.objectContaining({ reason: 'port_in_use' }) }))
    expect(() => applyRuntimeOp(project(), EMPTY_RUNTIME, { ...input, root: false })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
  it('refuses a JDK that is not installed with RUNTIME_MISSING', () => {
    expect(() => applyRuntimeOp(project({ runtime: 'java', startup: 'app.jar', jdk: '17' }), EMPTY_RUNTIME, input)).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED', detail: expect.objectContaining({ reason: 'RUNTIME_MISSING' }) }))
    expect(applyRuntimeOp(project({ runtime: 'java', startup: 'app.jar', jdk: '21' }), EMPTY_RUNTIME, input).apps[0]!.project!.javaBinary).toBe('/usr/lib/jvm/jre-21/bin/java')
  })
  it('finds a file without execute permission, and a missing one', async () => {
    const files = (mode: number) => ({ list: async () => [{ name: 'server', kind: 'file', mode }], readText: async () => ({ content: '' }) })
    expect(await preflightApp(files(0o644), { runtime: 'go', root: 'apps/svc', startup: 'server' })).toEqual(['not-executable'])
    expect(await preflightApp(files(0o755), { runtime: 'go', root: 'apps/svc', startup: 'server' })).toEqual([])
    expect(await preflightApp(files(0o644), { runtime: 'java', root: 'apps/svc', startup: 'app.jar' })).toEqual(['startup-missing'])
  })
  const compiled = (app: RuntimeRegistry['apps'][number]) => compileAccountRuntime(account, plan, [domain], { ...EMPTY_RUNTIME, apps: [app] }, profileFor('ID=ubuntu\nVERSION_ID=24.04\n') as OsProfile)
  it('renders one service in the account slice with its one port, and a front socket to it', () => {
    const saved = applyRuntimeOp(project({ env: { MODE: 'x' } }), EMPTY_RUNTIME, input).apps[0]!
    const out = compiled({ ...saved, enabled: true }), service = out.files.find(file => file.path.endsWith('xpanel-app-alpha-svc.service'))!.content, proxy = out.files.find(file => file.path.endsWith('xpanel-appproxy-alpha-svc.service'))!.content
    expect(service).toMatch(/ExecStart="?\/home\/alpha\/apps\/svc\/server/); expect(service).toContain('SocketBindAllow=tcp:20000'); expect(service).toContain('SocketBindDeny=any')
    expect(service).toContain('PORT=20000'); expect(service).toContain('HOST=127.0.0.1'); expect(service).toContain('User=alpha'); expect(service).toContain('Slice=' + system.accountSliceName(account.uid))
    expect(proxy).toContain('127.0.0.1:20000')
    expect(out.routes['example.test']).toEqual([{ path: '/', socket: system.appPaths('alpha', 'svc').proxySocket }])
  })
  it('runs a JAR with the chosen JDK, or the saved start command', () => {
    const saved = applyRuntimeOp(project({ runtime: 'java', startup: 'app.jar', jdk: '21' }), EMPTY_RUNTIME, input).apps[0]!
    expect(compiled({ ...saved, enabled: true }).files.find(file => file.path.endsWith('.service') && file.path.includes('xpanel-app-'))!.content).toMatch(/ExecStart="?\/usr\/lib\/jvm\/jre-21\/bin\/java"? -jar "?\/home\/alpha\/apps\/svc\/app\.jar/)
    const command = applyRuntimeOp(project({ command: './server --flag' }), EMPTY_RUNTIME, input).apps[0]!
    expect(compiled({ ...command, enabled: true }).files.find(file => file.path.endsWith('.service') && file.path.includes('xpanel-app-'))!.content).toContain('exec ./server --flag')
  })
  it('reports running projects to the firewall and nothing for a stopped one', () => {
    const app = applyRuntimeOp(project({ openPort: true }), EMPTY_RUNTIME, input).apps[0]!, map = (enabled: boolean) => new Map([[account.id, { ...EMPTY_RUNTIME, apps: [{ ...app, enabled }] }]])
    expect(runtimeAppPorts([account], map(true))).toEqual([{ port: 20000, uid: 20001, open: true }])
    expect(runtimeAppPorts([account], map(false))).toEqual([])
    expect(runtimeAppPorts([{ ...account, status: 'suspended' }], map(true))).toEqual([])
  })
  it('has no dependency step', () => {
    const reg = applyRuntimeOp(project(), EMPTY_RUNTIME, input)
    expect(() => applyRuntimeOp({ op: 'app.deps', expectedRevision: rev, name: 'svc' }, reg, input)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: 'no_dependency_step' }) }))
  })
})

describe('named Python environments', () => {
  const create = (name: string, version: string) => readRuntimeOp({ op: 'pyenv.create', expectedRevision: rev, name, version })
  it('refuses a name that exists with CONFLICT and a version not installed', () => {
    const reg = applyRuntimeOp(create('web', '3.12'), EMPTY_RUNTIME, input)
    expect(reg.pythonEnvs).toEqual([{ name: 'web', version: '3.12', updatedAt: input.now }])
    expect(parseRuntimeRegistry(JSON.parse(JSON.stringify(reg))).pythonEnvs).toHaveLength(1)
    expect(() => applyRuntimeOp(create('web', '3.12'), reg, input)).toThrow(expect.objectContaining({ code: 'CONFLICT', detail: expect.objectContaining({ reason: 'env_exists' }) }))
    expect(() => applyRuntimeOp(create('other', '3.11'), reg, input)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: 'RUNTIME_MISSING' }) }))
  })
  it('creates and removes as the account, in its home', () => {
    const made = buildPythonEnvCommand(account, 'web', '3.12'), removed = buildPythonEnvCommand(account, 'web', null)
    expect(made).toContain('User=20001'); expect(made.slice(-4)).toEqual(['/usr/bin/python3.12', '-m', 'venv', '/home/alpha/python-envs/web'])
    expect(removed.slice(-3)).toEqual(['/usr/bin/rm', '-rf', '/home/alpha/python-envs/web'])
    expect(isAccountRuntimeCommand(made)).toBe(true); expect(isAccountRuntimeCommand(removed)).toBe(true)
    expect(isAccountRuntimeCommand(made.map(value => value === '/home/alpha/python-envs/web' ? '/etc/shadow' : value))).toBe(false)
  })
  it('runs an application and its pip install in the chosen environment', () => {
    const reg = applyRuntimeOp(create('web', '3.12'), EMPTY_RUNTIME, input)
    const saved = applyRuntimeOp(readRuntimeOp({ op: 'app.save', expectedRevision: rev, app: { name: 'site', runtime: 'python', root: 'apps/site', startup: 'wsgi.py', domainId, path: '/', env: {}, pythonEnv: 'web' } }), reg, input)
    expect(saved.apps[0]!.pythonEnv).toBe('web')
    const out = compileAccountRuntime(account, plan, [domain], { ...saved, apps: [{ ...saved.apps[0]!, enabled: true }] }, profileFor('ID=ubuntu\nVERSION_ID=24.04\n') as OsProfile)
    expect(out.files.find(file => file.path.endsWith('xpanel-app-alpha-site.service'))!.content).toMatch(/ExecStart="?\/home\/alpha\/python-envs\/web\/bin\/python/)
    const deps = buildDepsCommand(account, saved.apps[0]!)
    expect(deps.slice(-7)[0]).toBe('/home/alpha/python-envs/web/bin/python'); expect(isAccountRuntimeCommand(deps)).toBe(true)
    expect(() => applyRuntimeOp({ op: 'pyenv.remove', expectedRevision: rev, name: 'web' }, saved, input)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: 'env_in_use' }) }))
    expect(() => applyRuntimeOp(readRuntimeOp({ op: 'app.save', expectedRevision: rev, app: { name: 'x', runtime: 'python', root: 'apps/x', startup: 'wsgi.py', domainId, path: '/x', env: {}, pythonEnv: 'none' } }), reg, input)).toThrow(expect.objectContaining({ detail: expect.objectContaining({ reason: 'env_missing' }) }))
  })
})

describe('panel data backups', () => {
  const file = 'xpanel-control-20261107T000000Z.tar.gz'
  const setup = async () => {
    const base = await mkdtemp(join(tmpdir(), 'xpanel-panel-')), backups = join(base, 'backups', '_control'), state = join(base, 'state')
    await mkdir(backups, { recursive: true }); await mkdir(join(state, 'plans'), { recursive: true })
    // The extraction is the stage folder the fake tar fills.
    const run = vi.fn(async (command: { argv: string[] }) => {
      const stage = command.argv.find(value => value.startsWith('--directory='))?.slice(12)
      if (command.argv.includes('--extract') && stage) { await mkdir(join(stage, 'plans'), { recursive: true }); await writeFile(join(stage, 'plans', 'a.json'), 'snapshot'); await writeFile(join(stage, 'plans', 'b.json'), 'snapshot'); await writeFile(join(stage, 'authority.json'), 'never'); return { ok: true, code: 0, stdout: '', stderr: '' } }
      if (command.argv.includes('--list')) return { ok: true, code: 0, stdout: 'control.db\n./plans/a.json\n', stderr: '' }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    })
    await writeFile(join(backups, file), 'archive'); await writeFile(join(state, 'plans', 'a.json'), 'current')
    return { base, backups, state, run: run as never }
  }
  it('keeps same-named items without overwrite and reports them as skipped', async () => {
    const f = await setup(), report = await restorePanelSnapshot({ directory: f.backups, file, stateDir: f.state, overwrite: false, run: f.run, assertFencing: async () => undefined })
    expect(report).toEqual({ restored: 1, skipped: 1, skippedItems: ['plans/a.json'], total: 2 })
    expect(await readFile(join(f.state, 'plans', 'a.json'), 'utf8')).toBe('current'); expect(await readFile(join(f.state, 'plans', 'b.json'), 'utf8')).toBe('snapshot')
    await rm(f.base, { recursive: true, force: true })
  })
  it('replaces them with overwrite and never restores the lease authority', async () => {
    const f = await setup(), report = await restorePanelSnapshot({ directory: f.backups, file, stateDir: f.state, overwrite: true, run: f.run, assertFencing: async () => undefined })
    expect(report).toMatchObject({ restored: 2, skipped: 0 }); expect(await readFile(join(f.state, 'plans', 'a.json'), 'utf8')).toBe('snapshot')
    await expect(readFile(join(f.state, 'authority.json'), 'utf8')).rejects.toBeDefined()
    await rm(f.base, { recursive: true, force: true })
  })
  it('lists, restores through the state mutation and reconciles, audited', async () => {
    const f = await setup(), audit = vi.fn(async () => undefined), reconcile = vi.fn(async () => ({ status: 'applied' as const })), mutate = vi.fn(async (write: (fence: () => Promise<void>) => Promise<void>) => { await write(async () => undefined) })
    const ctx = { assertRoot: async () => ({ actor: 'root' }), root: join(f.base, 'backups'), stateDir: f.state, run: f.run, build: null, mutate, reconcile, audit }
    expect((await listPanelBackups(f.backups)).map(row => row.file)).toEqual([file])
    const url = new URL('http://agent/host/panel-backups')
    const reply = await handlePanelBackupsRoute(new Request(url, { method: 'POST', body: JSON.stringify({ op: 'restore', file, overwrite: false }) }), url, 'POST', ctx)
    expect(await reply!.json()).toMatchObject({ restored: 1, skipped: 1, reconcile: 'applied', overwrite: false })
    expect(mutate).toHaveBeenCalledOnce(); expect(reconcile).toHaveBeenCalledOnce()
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'panel.backups.restored', outcome: 'ok' }))
    await expect(handlePanelBackupsRoute(new Request(url, { method: 'POST', body: JSON.stringify({ op: 'restore', file: '../x', overwrite: false }) }), url, 'POST', ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(handlePanelBackupsRoute(new Request(url, { method: 'POST', body: JSON.stringify({ op: 'create' }) }), url, 'POST', ctx)).rejects.toMatchObject({ detail: { reason: 'snapshot_unavailable' } })
    await rm(f.base, { recursive: true, force: true })
  })
})
