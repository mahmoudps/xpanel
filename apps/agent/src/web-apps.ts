import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { system } from '@xpanel/render'
import type { WebAppCategory, WebAppDetectionView, WebAppSourceName, WebAppStatus } from '../../../packages/os/src/account-runtime-command.ts'

/**
 * cPanel Web Apps on the one-unit-per-application runtime: a source is staged into ~/apps/<name> as the account,
 * configured, then deployed by a transient oneshot that installs dependencies and builds. The app unit starts
 * only through that oneshot's OnSuccess=, guarded by a stamp, so a reconcile during a build never starts half a tree.
 */
export const WEB_APPS_FEATURE = 'web-apps'
export interface WebAppRecord {
  source: WebAppSourceName; category: WebAppCategory; framework: string; startCommand: string | null; buildCommand: string | null
  outputDir: string | null; mode: 'production' | 'development'; deployedAt: string | null
}
type WebAppAccount = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>
interface DeployableApp { name: string; runtime: system.RuntimeKind; root: string; webapp: WebAppRecord }

export const webAppRoot = (name: string): string => 'apps/' + name
export const stageUnitName = (username: string, app: string): string => `xpanel-webstage-${system.assertUsername(username)}-${app}.service`
export const deployUnitName = (username: string, app: string): string => `xpanel-webdeploy-${system.assertUsername(username)}-${app}.service`

const NPM_BINARY = '/usr/bin/npm'
const GIT_BINARY = '/usr/bin/git'
const PY_DEPS = "import os,subprocess,sys,venv;r=os.getcwd();v=os.path.join(r,'.venv');os.path.exists(os.path.join(v,'bin','python')) or venv.create(v,with_pip=True);sys.exit(subprocess.call([os.path.join(v,'bin','pip'),'install','--no-input','-r','requirements.txt']))"
// tar needs its target first; unzip and git create theirs. Both paths travel as $1 and $2, never as shell text.
const EXTRACT_TAR = 'mkdir -p -- "$1" && exec /usr/bin/tar --no-same-owner --extract --file="$2" --directory="$1"'

const stageCommand = (home: string, name: string, source: WebAppSourceName): string[] => {
  const root = home + '/' + webAppRoot(name)
  if (source.kind === 'git') return [GIT_BINARY, 'clone', '--depth=1', '--single-branch', ...(source.branch ? ['--branch=' + source.branch] : []), '--', source.url, root]
  const archive = home + '/' + source.path
  return source.path.endsWith('.zip') ? ['/usr/bin/unzip', '-q', archive, '-d', root] : ['/bin/sh', '-c', EXTRACT_TAR, 'sh', root, archive]
}

const depsLine = (runtime: system.RuntimeKind): string => runtime === 'node' ? `[ ! -f package.json ] || ${NPM_BINARY} install --no-audit --no-fund`
  : runtime === 'python' ? `[ ! -f requirements.txt ] || ${system.RUNTIME_BINARIES.python} -c "${PY_DEPS}"`
    : `[ ! -f Gemfile ] || BUNDLE_GEMFILE="$PWD/Gemfile" BUNDLE_PATH="$PWD/vendor/bundle" ${system.RUBY_BUNDLE_BINARY} install`

/** The one script a deployment runs. Build text comes from the account and runs as the account, like its app. */
export function deployScript(app: DeployableApp, redeploy: boolean): string {
  const w = app.webapp, pull = redeploy && w.source.kind === 'git' ? [`${GIT_BINARY} pull --ff-only`] : []
  const deps = w.category === 'static' && !w.buildCommand ? [] : [depsLine(app.runtime)]
  return ['set -e', `rm -f ${system.WEB_APP_DEPLOYED_STAMP}`, ...pull, ...deps, ...(w.buildCommand ? [w.buildCommand] : []), `: > ${system.WEB_APP_DEPLOYED_STAMP}`].join('\n')
}

/** A background oneshot as the account, in its slice and sandbox; failed runs stay readable until reset. */
export function accountUnitArgv(account: WebAppAccount, unit: string, cwdRel: string, tail: string[], properties: string[], env: Record<string, string>): string[] {
  const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'], { cwdRel, env })
  const prefix = skeleton.slice(0, skeleton.lastIndexOf('--')).filter(v => !['--pipe', '--wait', '--collect', '--quiet'].includes(v))
    .map(v => v === 'User=' + account.username ? 'User=' + account.uid : v === 'Group=' + account.username ? 'Group=' + account.gid : v)
  return [prefix[0]!, '--unit=' + unit, '--no-block', '--quiet', ...prefix.slice(1), '--property', 'Type=oneshot', '--property', 'TimeoutStartSec=900s', '--property', 'TasksMax=256', ...properties.flatMap(p => ['--property', p]), '--', ...tail]
}

export function buildStageCommand(account: WebAppAccount, name: string, source: WebAppSourceName): string[] {
  return accountUnitArgv(account, stageUnitName(account.username, name), '', stageCommand(account.home, name, source), [], source.kind === 'git' ? { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' } : {})
}

export function buildDeployCommand(account: WebAppAccount, app: { name: string; root: string }, script: string): string[] {
  const paths = system.appPaths(account.username, app.name)
  return accountUnitArgv(account, deployUnitName(account.username, app.name), app.root, ['/bin/sh', '-c', script], ['EnvironmentFile=' + paths.envFile, 'OnSuccess=' + paths.service], {})
}

/** Exact outer admission: unit, identity, sandbox and OnSuccess= are rebuilt; only the command text the account owns stays free. */
export function isWebAppCommand(argv: readonly string[]): boolean {
  const unit = /^--unit=xpanel-web(stage|deploy)-([a-z][a-z0-9]{0,15})-([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)\.service$/.exec(argv[1] ?? '')
  const uid = argv.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = argv.find(v => /^Group=[0-9]+$/.test(v))?.slice(6)
  if (!unit || !uid || !gid) return false
  const account = { username: unit[2]!, uid: Number(uid), gid: Number(gid), home: '/home/' + unit[2] }, name = unit[3]!
  const tail = argv.slice(argv.indexOf('--') + 1)
  try {
    if (unit[1] === 'deploy') {
      const cwd = argv.find(v => v.startsWith('--working-directory=' + account.home + '/'))?.slice(20)
      return tail.length === 3 && !!cwd && JSON.stringify(argv) === JSON.stringify(buildDeployCommand(account, { name, root: cwd.slice(account.home.length + 1) }, tail[2]!))
    }
    const source: WebAppSourceName | null = tail[0] === GIT_BINARY ? { kind: 'git', url: tail.at(-2)!, branch: tail.find(v => v.startsWith('--branch='))?.slice(9) ?? null }
      : tail[0] === '/usr/bin/unzip' ? { kind: 'archive', path: tail[2]!.slice(account.home.length + 1) } : tail[0] === '/bin/sh' ? { kind: 'archive', path: tail[5]!.slice(account.home.length + 1) } : null
    return !!source && JSON.stringify(argv) === JSON.stringify(buildStageCommand(account, name, source))
  } catch { return false }
}

export interface WebAppFiles {
  list(path: string, opts?: { showHidden?: boolean }): Promise<readonly { name: string; kind: string }[]>
  readText(path: string): Promise<{ content: string }>
}

const STATIC_BUILDS: readonly [string, string, string][] = [['vite', 'vite', 'dist'], ['astro', 'astro', 'dist'], ['react-scripts', 'create-react-app', 'build'], ['gatsby', 'gatsby', 'public'], ['@vue/cli-service', 'vue-cli', 'dist']]

/** Framework and category from the staged files, with defaults the page offers; staging itself never deploys. */
export function detectWebApp(names: ReadonlySet<string>, packageJson: string | null, gemfile: string | null): WebAppDetectionView {
  const server = (framework: string, runtime: WebAppDetectionView['runtime'], startup: string, confidence: WebAppDetectionView['confidence'], startCommand: string | null = null, buildCommand: string | null = null): WebAppDetectionView =>
    ({ framework, category: 'server', runtime, confidence, startup, startCommand, buildCommand, outputDir: null })
  if (packageJson !== null) {
    let manifest: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown>; main?: unknown } = {}
    try { manifest = JSON.parse(packageJson) } catch { return server('node', 'node', 'server.js', 'low') }
    const deps = { ...manifest.dependencies, ...manifest.devDependencies }, build = typeof manifest.scripts?.build === 'string' ? 'npm run build' : null
    const known = STATIC_BUILDS.find(([dep]) => Object.hasOwn(deps, dep))
    if (known) return { framework: known[1], category: 'static', runtime: 'node', confidence: 'high', startup: 'index.html', startCommand: null, buildCommand: build, outputDir: known[2] }
    const start = typeof manifest.scripts?.start === 'string' ? 'npm start' : null, main = typeof manifest.main === 'string' ? manifest.main : names.has('server.js') ? 'server.js' : 'index.js'
    // next start takes a TCP port only and app units have no TCP bind, so a Next.js app needs its own server on PORT.
    if (Object.hasOwn(deps, 'next')) return server('next', 'node', main, 'low', start, build)
    return server(Object.hasOwn(deps, 'express') ? 'express' : Object.hasOwn(deps, 'fastify') ? 'fastify' : 'node', 'node', main, start ? 'high' : 'medium', start, build)
  }
  if (names.has('requirements.txt') || names.has('passenger_wsgi.py') || names.has('wsgi.py') || names.has('app.py')) {
    const startup = ['passenger_wsgi.py', 'wsgi.py', 'app.py'].find(file => names.has(file))
    return server(names.has('manage.py') ? 'django' : 'wsgi', 'python', startup ?? 'wsgi.py', startup ? 'high' : 'low')
  }
  if (names.has('config.ru')) return server(/\brails\b/.test(gemfile ?? '') ? 'rails' : 'rack', 'ruby', 'config.ru', gemfile !== null ? 'high' : 'medium')
  return { framework: names.has('index.html') ? 'html' : 'unknown', category: 'static', runtime: 'python', confidence: names.has('index.html') ? 'high' : 'low', startup: 'index.html', startCommand: null, buildCommand: null, outputDir: '.' }
}

/** Reads what detection needs through the confined file runner; null while nothing is staged. */
export async function readWebAppDetection(files: WebAppFiles, root: string): Promise<WebAppDetectionView | null> {
  let names: Set<string>
  try { names = new Set((await files.list(root, { showHidden: true })).map(entry => entry.name)) } catch { return null }
  if (!names.size) return null
  const text = async (name: string): Promise<string | null> => names.has(name) ? (await files.readText(root + '/' + name)).content.slice(0, 262144) : null
  return detectWebApp(names, await text('package.json'), await text('Gemfile'))
}

type Oneshot = 'none' | 'running' | 'succeeded' | 'failed'
/** Status the page shows, derived only from saved state and observed unit states. */
export function webAppStatus(app: { enabled: boolean; webapp: WebAppRecord }, service: 'running' | 'starting' | 'stopped' | 'failed' | 'unknown', stage: Oneshot, deploy: Oneshot): { status: WebAppStatus; failure: null | 'stage' | 'build' | 'start' } {
  if (stage === 'running') return { status: 'staging', failure: null }
  if (stage === 'failed') return { status: 'errored', failure: 'stage' }
  if (deploy === 'running') return { status: 'deploying', failure: null }
  if (deploy === 'failed') return { status: 'errored', failure: 'build' }
  if (!app.enabled) return { status: app.webapp.deployedAt ? 'stopped' : 'staged', failure: null }
  return service === 'failed' ? { status: 'errored', failure: 'start' } : service === 'running' || service === 'starting' ? { status: 'running', failure: null } : { status: 'stopped', failure: null }
}

export const assertWebAppConfig = (config: { category: WebAppCategory; outputDir: string | null }): void => {
  if (config.category === 'static' && !config.outputDir) fail('VALIDATION', 'a static application needs an output directory', { stateChanged: false, reason: 'output_dir_required' })
}
