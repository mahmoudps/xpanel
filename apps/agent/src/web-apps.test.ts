import { describe, expect, it } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { parseEnvText, readRuntimeOp } from '../../../packages/os/src/account-runtime-command.ts'
import { applyRuntimeOp, compileAccountRuntime, EMPTY_RUNTIME, isAccountRuntimeCommand, parseRuntimeRegistry, type RuntimeAppRecord, type RuntimeHostFacts, type RuntimeRegistry } from './account-runtime.ts'
import { buildDeployCommand, buildStageCommand, deployScript, detectWebApp, readWebAppDetection, webAppStatus, type WebAppRecord } from './web-apps.ts'

const DOMAIN_ID = '22222222-2222-4222-8222-222222222222', REV = 'a'.repeat(64)
const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com', planId: 'plan', status: 'active' } as Account
const plan = { id: 'plan', resources: { memoryMb: 1024, cpuPercent: 100, maxProcesses: 100, diskMb: 1024 } } as unknown as Plan
const domain = { id: DOMAIN_ID, accountId: account.id, name: 'alice-shop.com', kind: 'primary', suspended: false } as Domain
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const facts: RuntimeHostFacts = { jdks: [], python: [], runtimes: (['node', 'python', 'ruby'] as const).map(kind => ({ kind, available: true, version: '1.0', reason: null })), cache: [], containers: { available: false, version: null, reason: 'not-installed' } }
const input = { account, plan, disabled: [] as string[], facts, domains: [domain], now: '2026-11-07T00:00:00.000Z' }
const source = { kind: 'git' as const, url: 'https://example.com/acme/shop.git', branch: 'main' }
const web: WebAppRecord = { source, category: 'server', framework: 'express', startCommand: 'npm start', buildCommand: 'npm run build', outputDir: null, mode: 'production', deployedAt: null }
const stage = (reg: RuntimeRegistry, name = 'shop', path = '/'): RuntimeRegistry => applyRuntimeOp({ op: 'webapp.stage', expectedRevision: REV, app: { name, source, subfolder: null, domainId: DOMAIN_ID, path } }, reg, input)
const config = { domainId: DOMAIN_ID, path: '/', runtime: 'node' as const, category: 'static' as const, framework: 'vite', startup: 'index.html', startCommand: null, buildCommand: 'npm run build', outputDir: 'dist', env: {} }

describe('web app staging and configuration', () => {
  it('registers a staged app that serves nothing and gets a suffix on a name collision', () => {
    const first = stage(EMPTY_RUNTIME)
    expect(first.apps[0]).toMatchObject({ name: 'shop', root: 'apps/shop', enabled: false })
    expect(compileAccountRuntime(account, plan, [domain], first, os).units).toEqual([])
    expect(stage(first, 'shop', '/two').apps[1]).toMatchObject({ name: 'shop-2', root: 'apps/shop-2' })
    expect(parseRuntimeRegistry(JSON.parse(JSON.stringify(first))).apps[0]!.webapp).toEqual(first.apps[0]!.webapp)
  })

  it('refuses a second app on one domain path, a static app with a run mode and a disabled feature', () => {
    const first = stage(EMPTY_RUNTIME)
    expect(() => stage(first, 'other')).toThrow(/already serves/)
    const fixed = applyRuntimeOp({ op: 'webapp.configure', expectedRevision: REV, name: 'shop', config }, first, input)
    let reason = ''
    try { applyRuntimeOp({ op: 'webapp.mode', expectedRevision: REV, name: 'shop', mode: 'development' }, fixed, input) } catch (error) { reason = (error as { detail?: { reason?: string } }).detail?.reason ?? '' }
    expect(reason).toBe('INVALID_CATEGORY')
    expect(() => applyRuntimeOp({ op: 'webapp.deploy', expectedRevision: REV, name: 'shop' }, first, { ...input, disabled: ['web-apps'] })).toThrow(/plan does not allow/)
    expect(() => applyRuntimeOp({ op: 'app.start', expectedRevision: REV, name: 'shop' }, first, input)).toThrow(/deploy the application first/)
    expect(() => applyRuntimeOp({ op: 'app.save', expectedRevision: REV, app: { name: 'shop', runtime: 'node', root: 'apps/shop', startup: 's.js', domainId: DOMAIN_ID, path: '/', env: {} } }, first, input)).toThrow(/own settings/)
  })

  it('renders a deployed static site as one unit gated by the deployment stamp', () => {
    const deployed = applyRuntimeOp({ op: 'webapp.deploy', expectedRevision: REV, name: 'shop' }, applyRuntimeOp({ op: 'webapp.configure', expectedRevision: REV, name: 'shop', config }, stage(EMPTY_RUNTIME), input), input)
    const compiled = compileAccountRuntime(account, plan, [domain], deployed, os)
    const unit = compiled.files.find(file => file.path.endsWith('xpanel-app-alice-shop.service'))!
    expect(unit.content).toContain('ConditionPathExists=/home/alice/apps/shop/.xpanel-deployed')
    expect(unit.content).toContain('/etc/xpanel/runtime/static-wsgi.py')
    expect(unit.content).toContain('XPANEL_STATIC_ROOT=/home/alice/apps/shop/dist')
    expect(compiled.python).toBe(true)
  })

  it('runs a Node start command through the shell as the app, in the chosen mode', () => {
    const reg = { ...EMPTY_RUNTIME, apps: [{ name: 'shop', runtime: 'node', root: 'apps/shop', startup: 'server.js', domainId: DOMAIN_ID, path: '/', env: {}, enabled: true, updatedAt: input.now, webapp: { ...web, mode: 'development', deployedAt: input.now } } as RuntimeAppRecord] }
    const unit = compileAccountRuntime(account, plan, [domain], reg, os).files.find(file => file.path.endsWith('xpanel-app-alice-shop.service'))!
    expect(unit.content).toContain('ExecStart=/bin/sh -c "exec npm start"')
    expect(unit.content).toContain('NODE_ENV=development')
  })
})

describe('web app commands', () => {
  const app = { name: 'shop', runtime: 'node' as const, root: 'apps/shop', webapp: web }

  it('admits exactly what it builds and starts the app only on build success', () => {
    const deploy = buildDeployCommand(account, app, deployScript(app, true))
    expect(deploy).toContain('OnSuccess=xpanel-app-alice-shop.service')
    expect(deploy.at(-1)).toContain('/usr/bin/git pull --ff-only')
    expect(deploy.at(-1)!.split('\n').at(-1)).toBe(': > .xpanel-deployed')
    for (const argv of [deploy, buildStageCommand(account, 'shop', source), buildStageCommand(account, 'shop', { kind: 'archive', path: 'up/site.tar.gz' }), buildStageCommand(account, 'shop', { kind: 'archive', path: 'up/site.zip' })]) {
      expect(isAccountRuntimeCommand(argv)).toBe(true)
      expect(isAccountRuntimeCommand(argv.map(v => v === 'User=20014' ? 'User=0' : v))).toBe(false)
      expect(isAccountRuntimeCommand(argv.map(v => v === 'Type=oneshot' ? 'Type=forking' : v))).toBe(false)
    }
    expect(isAccountRuntimeCommand(deploy.map(v => v.startsWith('OnSuccess=') ? 'OnSuccess=sshd.service' : v))).toBe(false)
    expect(isAccountRuntimeCommand(deploy.map(v => v === deploy[1] ? '--unit=xpanel-webdeploy-bob-shop.service' : v))).toBe(false)
    expect(isAccountRuntimeCommand(buildStageCommand(account, 'shop', source).map(v => v === '/usr/bin/git' ? '/usr/bin/curl' : v))).toBe(false)
  })

  it('skips dependency install for a static site without a build', () => {
    expect(deployScript({ ...app, webapp: { ...web, category: 'static', buildCommand: null, outputDir: '.' } }, false)).not.toContain('npm install')
  })
})

describe('web app grammar', () => {
  const stageBody = (url: string): unknown => ({ op: 'webapp.stage', expectedRevision: REV, app: { name: 'shop', source: { kind: 'git', url, branch: null }, subfolder: null, domainId: DOMAIN_ID, path: '/' } })

  it('refuses URLs with credentials, other protocols and option text', () => {
    expect(readRuntimeOp(stageBody('https://example.com/acme/shop.git')).op).toBe('webapp.stage')
    expect(readRuntimeOp(stageBody('git@example.com:acme/shop.git')).op).toBe('webapp.stage')
    for (const url of ['https://user:secret@example.com/x.git', 'file:///etc/passwd', 'ext::sh -c id', '--upload-pack=id', 'http://example.com/x.git']) expect(() => readRuntimeOp(stageBody(url))).toThrow(/invalid runtime operation/)
  })

  it('refuses env and envText together and reads pasted env text', () => {
    const { env: _env, ...base } = config
    const body = (extra: object): unknown => ({ op: 'webapp.configure', expectedRevision: REV, name: 'shop', config: { ...base, ...extra } })
    expect(() => readRuntimeOp({ ...(body({ env: {}, envText: 'A=1' }) as object) })).toThrow(/not both/)
    expect(readRuntimeOp(body({ envText: '# c\nexport A=1\nB="two words"\n' }))).toMatchObject({ config: { env: { A: '1', B: 'two words' } } })
    expect(parseEnvText('no equals sign')).toBeNull()
  })
})

describe('web app detection and status', () => {
  it('detects category, framework and defaults from the staged files', async () => {
    expect(detectWebApp(new Set(['package.json']), JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '6' } }), null)).toMatchObject({ framework: 'vite', category: 'static', outputDir: 'dist', buildCommand: 'npm run build', confidence: 'high' })
    expect(detectWebApp(new Set(['package.json']), JSON.stringify({ scripts: { start: 'node s.js' }, dependencies: { express: '5' } }), null)).toMatchObject({ framework: 'express', category: 'server', startCommand: 'npm start' })
    expect(detectWebApp(new Set(['requirements.txt', 'wsgi.py', 'manage.py']), null, null)).toMatchObject({ framework: 'django', runtime: 'python', startup: 'wsgi.py' })
    expect(detectWebApp(new Set(['config.ru']), null, "gem 'rails'")).toMatchObject({ framework: 'rails', runtime: 'ruby' })
    expect(detectWebApp(new Set(['index.html']), null, null)).toMatchObject({ category: 'static', outputDir: '.' })
    expect(detectWebApp(new Set(['package.json']), '{', null).confidence).toBe('low')
    expect(await readWebAppDetection({ list: async () => { throw new Error('missing') }, readText: async () => ({ content: '' }) }, 'apps/x')).toBeNull()
  })

  it('reports status only from saved state and unit states', () => {
    const app = { enabled: false, webapp: web }
    expect(webAppStatus(app, 'stopped', 'running', 'none').status).toBe('staging')
    expect(webAppStatus(app, 'stopped', 'failed', 'none')).toEqual({ status: 'errored', failure: 'stage' })
    expect(webAppStatus(app, 'stopped', 'none', 'none').status).toBe('staged')
    expect(webAppStatus({ enabled: true, webapp: { ...web, deployedAt: input.now } }, 'stopped', 'none', 'running').status).toBe('deploying')
    expect(webAppStatus({ enabled: true, webapp: { ...web, deployedAt: input.now } }, 'stopped', 'none', 'failed')).toEqual({ status: 'errored', failure: 'build' })
    expect(webAppStatus({ enabled: true, webapp: { ...web, deployedAt: input.now } }, 'failed', 'none', 'none')).toEqual({ status: 'errored', failure: 'start' })
    expect(webAppStatus({ enabled: true, webapp: { ...web, deployedAt: input.now } }, 'running', 'none', 'none').status).toBe('running')
    expect(webAppStatus({ enabled: false, webapp: { ...web, deployedAt: input.now } }, 'stopped', 'none', 'none').status).toBe('stopped')
  })
})
