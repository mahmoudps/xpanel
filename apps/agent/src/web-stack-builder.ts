import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail, validateApacheWorkers, type ApacheMpm, type Engine, type OsProfile, type ServerSettings } from '@xpanel/core'
import { apacheConfigTest, apacheMpmFile, renderApacheMpm } from '../../../packages/render/src/edge/apache.ts'
import { nginxConfigTest } from '../../../packages/render/src/edge/nginx-main.ts'
import { renderOlsListener, renderOlsServerBase } from '../../../packages/render/src/edge/ols.ts'

const unchanged = { stateChanged: false } as const
const MAX_BODY_BYTES = 64 * 1024
const SAFE_IDENT = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const SAFE_PHP_VERSION = /^(?:7\.4|8\.[0-4])$/
const SAFE_SHA256 = /^[0-9a-f]{64}$/
const STATE_RELATIVE_PATH = 'extended/server/web-stack.json'

export type SelectableApacheMpm = 'itk' | 'prefork' | 'event' | 'worker'

export interface WebStackProfile {
  readonly id: string
  readonly name: string
  readonly engine: Engine
  readonly mpm: 'itk'
  readonly edge: 'nginx'
  readonly modules: readonly string[]
  readonly phpVersions: readonly string[]
  readonly phpExtensions: readonly string[]
  readonly extraPackages: readonly string[]
  readonly summary: string
}

export const WEB_STACK_MODULES: readonly string[] = Object.freeze([
  'mod_rewrite',
  'mod_ssl',
  'mod_headers',
  'mod_proxy_fcgi',
  'mod_remoteip',
  'mod_expires',
  'mod_deflate',
  'mod_security2',
  'mod_evasive',
])

export const WEB_STACK_PHP_VERSIONS: readonly string[] = Object.freeze(['7.4', '8.0', '8.1', '8.2', '8.3', '8.4'])

export const WEB_STACK_PHP_EXTENSIONS: readonly string[] = Object.freeze([
  'mbstring',
  'intl',
  'gd',
  'curl',
  'xml',
  'zip',
  'pdo_mysql',
  'opcache',
  'bcmath',
  'imagick',
])

export const WEB_STACK_PROFILES: readonly WebStackProfile[] = Object.freeze([
  {
    id: 'apache-itk-fpm',
    name: 'Nginx Edge + Apache mpm_itk + PHP-FPM',
    engine: 'apache',
    mpm: 'itk',
    edge: 'nginx',
    modules: ['mod_rewrite', 'mod_ssl', 'mod_headers', 'mod_proxy_fcgi', 'mod_remoteip'],
    phpVersions: ['8.3'],
    phpExtensions: ['mbstring', 'intl', 'gd', 'curl', 'xml', 'zip', 'pdo_mysql', 'opcache'],
    extraPackages: ['nginx-edge'],
    summary: 'Per-account Apache process isolation via mpm_itk behind Nginx reverse proxy.',
  },
  {
    id: 'apache-itk-hardened',
    name: 'Nginx Edge + Hardened Apache mpm_itk + PHP-FPM',
    engine: 'apache',
    mpm: 'itk',
    edge: 'nginx',
    modules: ['mod_rewrite', 'mod_ssl', 'mod_headers', 'mod_proxy_fcgi', 'mod_remoteip', 'mod_security2', 'mod_evasive'],
    phpVersions: ['8.3', '8.4'],
    phpExtensions: ['mbstring', 'intl', 'gd', 'curl', 'xml', 'zip', 'pdo_mysql', 'opcache', 'bcmath'],
    extraPackages: ['nginx-edge', 'modsecurity'],
    summary: 'Isolated mpm_itk stack with ModSecurity and evasive rate-limiting modules.',
  },
  {
    id: 'openlitespeed-lsphp',
    name: 'Nginx Edge + OpenLiteSpeed + LSPHP',
    engine: 'openlitespeed',
    mpm: 'itk',
    edge: 'nginx',
    modules: ['mod_rewrite', 'mod_ssl', 'mod_headers'],
    phpVersions: ['8.3'],
    phpExtensions: ['mbstring', 'intl', 'gd', 'curl', 'xml', 'zip', 'pdo_mysql', 'opcache'],
    extraPackages: ['nginx-edge', 'openlitespeed'],
    summary: 'Event-driven OpenLiteSpeed backend with per-account lsphp external processors.',
  },
])

export interface WebStackSelection {
  profileId: string
  engine: Engine
  mpm: 'itk'
  modules: string[]
  phpVersions: string[]
  phpExtensions: string[]
  extraPackages: string[]
}

export interface WebStackGenerationRecord {
  id: number
  createdAt: string
  actor: string
  profileId: string
  engine: Engine
  mpm: 'itk'
  checksum: string
  configPath: string | null
  previousContent: string | null
  appliedContent: string | null
  status: 'active' | 'rolled_back'
}

interface StoredWebStackState {
  version: 1
  selection: WebStackSelection
  updatedAt: string
  generations: WebStackGenerationRecord[]
}

export interface WebStackView {
  observedAt: string
  engine: Engine
  apacheMpm: ApacheMpm
  isolationPolicy: 'mpm_itk'
  isolationEnforced: true
  activeProfile: WebStackSelection
  profiles: readonly WebStackProfile[]
  availableModules: readonly string[]
  availablePhpVersions: readonly string[]
  availablePhpExtensions: readonly string[]
  mpmConfigPath: string
  mpmConfigPreview: string | null
  installed: {
    observed: boolean
    nginxUnit: string | null
    apacheUnit: string | null
    olsUnit: string | null
    loadedModules: string[]
  }
  generations: Omit<WebStackGenerationRecord, 'previousContent' | 'appliedContent'>[]
  revision: string
}

export interface WebStackPreview {
  valid: true
  stateChanged: false
  isolationPolicy: 'mpm_itk'
  selection: WebStackSelection
  diff: {
    addModules: string[]
    removeModules: string[]
    addPhpVersions: string[]
    removePhpVersions: string[]
    engineChanged: boolean
  }
  renderedFiles: { path: string; content: string }[]
}

export interface WebStackApplyResult {
  applied: true
  stateChanged: true
  isolationPolicy: 'mpm_itk'
  generationId: number
  revision: string
  selection: WebStackSelection
  tests: {
    nginx: { ok: boolean; skipped: boolean; output: string }
    apache: { ok: boolean; skipped: boolean; output: string }
  }
}

export interface WebStackHostFs {
  readFile(path: string): Promise<string | null>
  writeFile(file: { path: string; content: string; mode: number; owner: string; group: string }): Promise<unknown>
  stat(path: string): Promise<{ uid: number; gid: number; mode: number } | null>
}

export interface WebStackRunResult {
  ok: boolean
  code?: number | null
  stdout: string
  stderr: string
}

export interface WebStackRouteDeps {
  assertRoot: (action: string) => Promise<{ actor: string }>
  os: OsProfile
  stateRoot: string
  readServerSettings: () => Promise<ServerSettings | null>
  updateServerSettings?: (patch: { engine: Engine; apacheMpm: ApacheMpm }, actor: string) => Promise<void>
  renderOlsConfig?: (settings: ServerSettings) => Promise<string>
  reconcile?: (actor: string) => Promise<unknown>
  run: ((argv: readonly string[]) => Promise<WebStackRunResult>) | null
  fs?: WebStackHostFs
  audit?: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  now?: () => Date
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const MPM_ALIASES: Readonly<Record<string, SelectableApacheMpm>> = {
  itk: 'itk',
  mpm_itk: 'itk',
  'mpm-itk': 'itk',
  prefork: 'prefork',
  mpm_prefork: 'prefork',
  'mpm-prefork': 'prefork',
  event: 'event',
  mpm_event: 'event',
  'mpm-event': 'event',
  worker: 'worker',
  mpm_worker: 'worker',
  'mpm-worker': 'worker',
}

function normalizeMpmToken(value: unknown): SelectableApacheMpm | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return MPM_ALIASES[normalized] ?? null
}

function validateSafeList(value: unknown, field: string, pattern: RegExp, max = 64): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) {
    return fail('VALIDATION', `${field} must be an array of at most ${max} items`, { ...unchanged, reason: `invalid_${field}` })
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      return fail('VALIDATION', `${field} contains an unsupported entry`, { ...unchanged, reason: `invalid_${field}` })
    }
    seen.add(entry)
  }
  return [...seen]
}

/**
 * Validates web-stack builder input and strictly enforces mpm_itk per-account isolation.
 * - Selecting 2+ MPMs simultaneously fails closed with 409 CONFLICT (reason: multiple_mpms_selected).
 * - Selecting prefork, event, or worker without mpm_itk fails closed with 422 VALIDATION (reason: mpm_isolation_required).
 */
export function validateWebStackSelection(raw: unknown, fallbackProfileId = 'apache-itk-fpm'): WebStackSelection {
  if (!isRecord(raw)) {
    return fail('VALIDATION', 'web stack payload must be a JSON object', { ...unchanged, reason: 'invalid_web_stack_payload' })
  }

  const profileIdRaw = raw.profileId === undefined ? fallbackProfileId : raw.profileId
  if (typeof profileIdRaw !== 'string' || (!SAFE_IDENT.test(profileIdRaw) && profileIdRaw !== 'custom')) {
    return fail('VALIDATION', 'invalid web stack profile identifier', { ...unchanged, reason: 'unknown_web_stack_profile' })
  }

  const preset = WEB_STACK_PROFILES.find(item => item.id === profileIdRaw)
  if (!preset && profileIdRaw !== 'custom') {
    return fail('VALIDATION', `unknown web stack profile: ${profileIdRaw}`, { ...unchanged, reason: 'unknown_web_stack_profile' })
  }

  const engineRaw = raw.engine === undefined ? (preset?.engine ?? 'apache') : raw.engine
  if (engineRaw !== 'apache' && engineRaw !== 'openlitespeed') {
    return fail('VALIDATION', 'engine must be apache or openlitespeed', { ...unchanged, reason: 'unsupported_engine' })
  }

  const rawModules = raw.modules === undefined ? [...(preset?.modules ?? [])] : validateSafeList(raw.modules, 'modules', SAFE_IDENT)
  const moduleMpms: SelectableApacheMpm[] = []
  const cleanModules: string[] = []
  for (const mod of rawModules) {
    const mapped = normalizeMpmToken(mod)
    if (mapped) moduleMpms.push(mapped)
    else cleanModules.push(mod)
  }

  const explicitMpms: SelectableApacheMpm[] = []
  if (raw.mpms !== undefined) {
    if (!Array.isArray(raw.mpms) || raw.mpms.length > 8) {
      return fail('VALIDATION', 'mpms must be an array of Apache MPM identifiers', { ...unchanged, reason: 'invalid_mpm' })
    }
    for (const item of raw.mpms) {
      const mapped = normalizeMpmToken(item)
      if (!mapped) {
        return fail('VALIDATION', 'unsupported Apache MPM specified', { ...unchanged, reason: 'invalid_mpm' })
      }
      explicitMpms.push(mapped)
    }
  }
  for (const key of ['mpm', 'apacheMpm'] as const) {
    if (raw[key] !== undefined) {
      const mapped = normalizeMpmToken(raw[key])
      if (!mapped) {
        return fail('VALIDATION', `unsupported Apache MPM in ${key}`, { ...unchanged, reason: 'invalid_mpm' })
      }
      explicitMpms.push(mapped)
    }
  }

  const distinctMpms = [...new Set([...explicitMpms, ...moduleMpms])]
  if (distinctMpms.length > 1 || (Array.isArray(raw.mpms) && raw.mpms.length > 1)) {
    return fail('CONFLICT', 'Multiple Apache MPMs cannot be selected simultaneously.', {
      ...unchanged,
      reason: 'multiple_mpms_selected',
      mpms: distinctMpms,
    })
  }

  if (Array.isArray(raw.mpms) && raw.mpms.length === 0 && engineRaw === 'apache') {
    return fail('VALIDATION', 'Apache requires mpm_itk per-account process isolation.', {
      ...unchanged,
      reason: 'mpm_isolation_required',
    })
  }

  const selectedMpm = distinctMpms[0] ?? 'itk'
  if (selectedMpm !== 'itk') {
    return fail('VALIDATION', 'Apache requires mpm_itk per-account process isolation; non-isolated MPMs are refused.', {
      ...unchanged,
      reason: 'mpm_isolation_required',
      selectedMpm,
    })
  }

  const phpVersions = raw.phpVersions === undefined
    ? [...(preset?.phpVersions ?? ['8.3'])]
    : validateSafeList(raw.phpVersions, 'phpVersions', SAFE_PHP_VERSION, 16)
  const phpExtensions = raw.phpExtensions === undefined
    ? [...(preset?.phpExtensions ?? [])]
    : validateSafeList(raw.phpExtensions, 'phpExtensions', SAFE_IDENT, 64)
  const extraPackages = raw.extraPackages === undefined
    ? [...(preset?.extraPackages ?? ['nginx-edge'])]
    : validateSafeList(raw.extraPackages, 'extraPackages', SAFE_IDENT, 64)

  return {
    profileId: profileIdRaw,
    engine: engineRaw,
    mpm: 'itk',
    modules: cleanModules,
    phpVersions,
    phpExtensions,
    extraPackages,
  }
}

const defaultHostFs: WebStackHostFs = {
  async readFile(path) {
    try { return await readFile(path, 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  async writeFile(file) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o755 })
    const staged = `${file.path}.xpanel-stage`
    await writeFile(staged, file.content, { mode: file.mode })
    await rename(staged, file.path)
  },
  async stat(path) {
    try {
      const info = await stat(path)
      return { uid: info.uid, gid: info.gid, mode: info.mode & 0o777 }
    } catch {
      return null
    }
  },
}

const defaultSettings = (): ServerSettings => ({
  hostname: 'localhost.localdomain',
  nameservers: ['ns1.localhost.localdomain'],
  adminEmail: 'root@localhost.localdomain',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  backendPort: 8080,
  backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 150, serverLimit: 150, maxConnectionsPerChild: 0 },
})

function defaultSelectionFor(settings: ServerSettings): WebStackSelection {
  const preset = settings.engine === 'openlitespeed' ? WEB_STACK_PROFILES[2]! : WEB_STACK_PROFILES[0]!
  return {
    profileId: preset.id,
    engine: settings.engine,
    mpm: 'itk',
    modules: [...preset.modules],
    phpVersions: [...preset.phpVersions],
    phpExtensions: [...preset.phpExtensions],
    extraPackages: [...preset.extraPackages],
  }
}

async function readStoredState(stateRoot: string, settings: ServerSettings): Promise<StoredWebStackState> {
  const filePath = join(stateRoot, STATE_RELATIVE_PATH)
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StoredWebStackState>
    if (raw && raw.version === 1 && isRecord(raw.selection)) {
      const selection = validateWebStackSelection(raw.selection)
      const generations = Array.isArray(raw.generations) ? raw.generations.slice(0, 50) : []
      return { version: 1, selection, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(), generations }
    }
  } catch {
    /* initialize from current settings */
  }
  return {
    version: 1,
    selection: defaultSelectionFor(settings),
    updatedAt: new Date(0).toISOString(),
    generations: [],
  }
}

async function writeStoredState(stateRoot: string, state: StoredWebStackState): Promise<void> {
  const filePath = join(stateRoot, STATE_RELATIVE_PATH)
  await mkdir(dirname(filePath), { recursive: true, mode: 0o750 })
  const staged = `${filePath}.tmp`
  await writeFile(staged, JSON.stringify(state, null, 2) + '\n', { mode: 0o640 })
  await rename(staged, filePath)
}

function stateRevision(state: StoredWebStackState, settings: ServerSettings): string {
  return sha256(JSON.stringify({
    engine: settings.engine,
    apacheMpm: settings.apacheMpm,
    selection: state.selection,
    latestGeneration: state.generations[0]?.id ?? 0,
  }))
}

export function renderWebStackArtifacts(selection: WebStackSelection, baseSettings: ServerSettings, os: OsProfile, existingOlsContent?: string | null): { path: string; content: string }[] {
  const mergedApache = validateApacheWorkers(baseSettings.apache)
  const settings: ServerSettings = {
    ...baseSettings,
    engine: selection.engine,
    apacheMpm: 'itk',
    apache: mergedApache,
  }
  if (selection.engine === 'apache') {
    const mpm = apacheMpmFile(settings, os)
    return [{ path: mpm.path, content: mpm.content }]
  }
  const olsPath = `${os.paths.olsRoot}/conf/httpd_config.conf`
  if (existingOlsContent && /(?:^|\n)(?:virtualhost|extprocessor)\s+/m.test(existingOlsContent)) {
    return [{ path: olsPath, content: existingOlsContent }]
  }
  return [{
    path: olsPath,
    content: `${renderOlsServerBase(settings)}${renderOlsListener(settings, [])}`,
  }]
}

async function resolveWebStackArtifacts(selection: WebStackSelection, settings: ServerSettings, deps: WebStackRouteDeps): Promise<{ path: string; content: string }[]> {
  if (selection.engine === 'openlitespeed') {
    const nextSettings: ServerSettings = {
      ...settings,
      engine: 'openlitespeed',
      apacheMpm: 'itk',
      apache: validateApacheWorkers(settings.apache),
    }
    if (deps.renderOlsConfig) {
      return [{ path: `${deps.os.paths.olsRoot}/conf/httpd_config.conf`, content: await deps.renderOlsConfig(nextSettings) }]
    }
    const existing = deps.fs ? await deps.fs.readFile(`${deps.os.paths.olsRoot}/conf/httpd_config.conf`).catch(() => null) : null
    return renderWebStackArtifacts(selection, settings, deps.os, existing)
  }
  return renderWebStackArtifacts(selection, settings, deps.os)
}

async function probeInstalledStack(deps: WebStackRouteDeps): Promise<WebStackView['installed']> {
  if (!deps.run) {
    return { observed: false, nginxUnit: null, apacheUnit: null, olsUnit: null, loadedModules: [] }
  }
  const unitActive = async (unit: string): Promise<string | null> => {
    const res = await deps.run!(['/usr/bin/systemctl', 'show', '--no-pager', '--property=LoadState', '--', unit]).catch(() => null)
    if (!res?.ok) return null
    return res.stdout.includes('LoadState=loaded') ? unit : null
  }
  const [nginxUnit, apacheUnit, olsUnit] = await Promise.all([
    unitActive('nginx.service'),
    unitActive(deps.os.services.apache),
    unitActive(deps.os.services.openlitespeed),
  ])
  const loadedModules: string[] = []
  if (apacheUnit) {
    const ctl = await deps.run([deps.os.family === 'debian' ? '/usr/sbin/apache2ctl' : '/usr/sbin/apachectl', '-M']).catch(() => null)
    if (ctl?.ok) {
      for (const line of ctl.stdout.split('\n')) {
        const match = /^\s*([a-z0-9_]+)_module\b/i.exec(line)
        if (match) loadedModules.push(match[1]!)
      }
    }
  }
  return { observed: true, nginxUnit, apacheUnit, olsUnit, loadedModules }
}

export async function readWebStack(deps: WebStackRouteDeps): Promise<WebStackView> {
  const now = (deps.now ?? (() => new Date()))()
  const settings = (await deps.readServerSettings()) ?? defaultSettings()
  const stored = await readStoredState(deps.stateRoot, settings)
  const installed = await probeInstalledStack(deps)
  const effectiveApache: ServerSettings = { ...settings, engine: 'apache', apacheMpm: 'itk' }
  const mpmFile = apacheMpmFile(effectiveApache, deps.os)
  return {
    observedAt: now.toISOString(),
    engine: settings.engine,
    apacheMpm: settings.apacheMpm,
    isolationPolicy: 'mpm_itk',
    isolationEnforced: true,
    activeProfile: stored.selection,
    profiles: WEB_STACK_PROFILES,
    availableModules: WEB_STACK_MODULES,
    availablePhpVersions: WEB_STACK_PHP_VERSIONS,
    availablePhpExtensions: WEB_STACK_PHP_EXTENSIONS,
    mpmConfigPath: mpmFile.path,
    mpmConfigPreview: settings.engine === 'apache' ? renderApacheMpm(effectiveApache) : null,
    installed,
    generations: stored.generations.map(({ previousContent: _prev, appliedContent: _next, ...rest }) => rest),
    revision: stateRevision(stored, settings),
  }
}

export async function previewWebStack(deps: WebStackRouteDeps, body: unknown): Promise<WebStackPreview> {
  const settings = (await deps.readServerSettings()) ?? defaultSettings()
  const stored = await readStoredState(deps.stateRoot, settings)
  const selection = validateWebStackSelection(body, stored.selection.profileId)
  const currentModules = new Set(stored.selection.modules)
  const nextModules = new Set(selection.modules)
  const currentPhp = new Set(stored.selection.phpVersions)
  const nextPhp = new Set(selection.phpVersions)
  return {
    valid: true,
    stateChanged: false,
    isolationPolicy: 'mpm_itk',
    selection,
    diff: {
      addModules: selection.modules.filter(item => !currentModules.has(item)),
      removeModules: stored.selection.modules.filter(item => !nextModules.has(item)),
      addPhpVersions: selection.phpVersions.filter(item => !currentPhp.has(item)),
      removePhpVersions: stored.selection.phpVersions.filter(item => !nextPhp.has(item)),
      engineChanged: selection.engine !== settings.engine,
    },
    renderedFiles: await resolveWebStackArtifacts(selection, settings, deps),
  }
}

export async function applyWebStack(deps: WebStackRouteDeps, body: unknown, actor: string): Promise<WebStackApplyResult> {
  if (!isRecord(body)) {
    return fail('VALIDATION', 'web stack apply payload must be a JSON object', { ...unchanged, reason: 'invalid_web_stack_payload' })
  }
  const settings = (await deps.readServerSettings()) ?? defaultSettings()
  const stored = await readStoredState(deps.stateRoot, settings)
  const expectedRevision = body.expectedRevision
  if (expectedRevision !== undefined) {
    if (typeof expectedRevision !== 'string' || !SAFE_SHA256.test(expectedRevision)) {
      return fail('VALIDATION', 'expectedRevision must be a 64-character hex digest', { ...unchanged, reason: 'invalid_revision' })
    }
    if (expectedRevision !== stateRevision(stored, settings)) {
      return fail('CONFLICT', 'web stack configuration changed since last read', { ...unchanged, reason: 'stack_changed' })
    }
  }

  const selection = validateWebStackSelection(body, stored.selection.profileId)
  const fs = deps.fs ?? defaultHostFs
  const artifacts = await resolveWebStackArtifacts(selection, settings, { ...deps, fs })
  const target = artifacts[0]!
  const previousContent = await fs.readFile(target.path)
  const previousInfo = await fs.stat(target.path)

  const restorePrevious = async (): Promise<boolean> => {
    try {
      if (previousContent !== null) {
        await fs.writeFile({
          path: target.path,
          content: previousContent,
          mode: previousInfo?.mode ?? 0o644,
          owner: 'root',
          group: 'root',
        })
      }
      return true
    } catch {
      return false
    }
  }

  await fs.writeFile({ path: target.path, content: target.content, mode: 0o644, owner: 'root', group: 'root' })

  const nginxTest = { ok: true, skipped: true, output: 'not_run' }
  const apacheTest = { ok: true, skipped: true, output: 'not_run' }

  if (deps.run) {
    const ngCmd = nginxConfigTest(deps.os)
    const ngRes = await deps.run(ngCmd.argv)
    nginxTest.skipped = false
    nginxTest.ok = ngRes.ok
    nginxTest.output = (ngRes.stderr || ngRes.stdout || '').slice(0, 500)
    if (!ngRes.ok) {
      const restored = await restorePrevious()
      await deps.audit?.({
        actor,
        action: 'server.web_stack.applied',
        target: `web-stack:${selection.profileId}`,
        outcome: 'failed',
        detail: { reason: 'nginx_configtest_failed', restored },
      }).catch(() => undefined)
      return fail('CONFIG_TEST_FAILED', 'nginx -t failed; previous web stack configuration restored', restored
        ? { stateChanged: false, restored: true, reason: 'web_stack_config_test_failed', failedTest: 'nginx', output: nginxTest.output }
        : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'web_stack_rollback_failed', failedTest: 'nginx' })
    }

    if (selection.engine === 'apache') {
      const apCmd = apacheConfigTest(deps.os)
      const apRes = await deps.run(apCmd.argv)
      apacheTest.skipped = false
      apacheTest.ok = apRes.ok
      apacheTest.output = (apRes.stderr || apRes.stdout || '').slice(0, 500)
      if (!apRes.ok) {
        const restored = await restorePrevious()
        await deps.audit?.({
          actor,
          action: 'server.web_stack.applied',
          target: `web-stack:${selection.profileId}`,
          outcome: 'failed',
          detail: { reason: 'apache_configtest_failed', restored },
        }).catch(() => undefined)
        return fail('CONFIG_TEST_FAILED', 'apachectl configtest failed; previous web stack configuration restored', restored
          ? { stateChanged: false, restored: true, reason: 'web_stack_config_test_failed', failedTest: 'apache', output: apacheTest.output }
          : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'web_stack_rollback_failed', failedTest: 'apache' })
      }
    }

    const reloadUnit = selection.engine === 'apache' ? deps.os.services.apache : deps.os.services.openlitespeed
    const reloadCheck = await deps.run(['/usr/bin/systemctl', 'show', '--no-pager', '--property=LoadState,ActiveState', '--', reloadUnit]).catch(() => null)
    if (reloadCheck?.ok && reloadCheck.stdout.includes('LoadState=loaded') && reloadCheck.stdout.includes('ActiveState=active')) {
      const reloaded = await deps.run(['/usr/bin/systemctl', 'reload', '--', reloadUnit])
      if (!reloaded.ok) {
        const restored = await restorePrevious()
        if (restored) await deps.run(['/usr/bin/systemctl', 'reload', '--', reloadUnit]).catch(() => undefined)
        return fail('CONFIG_TEST_FAILED', 'web server reload failed; previous configuration restored', restored
          ? { stateChanged: false, restored: true, reason: 'web_stack_reload_failed' }
          : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'web_stack_rollback_failed' })
      }
    }
  }

  const engineChanged = selection.engine !== settings.engine
  if (deps.updateServerSettings) {
    await deps.updateServerSettings({ engine: selection.engine, apacheMpm: 'itk' }, actor)
  }
  if (deps.reconcile && engineChanged) {
    try {
      await deps.reconcile(actor)
    } catch (error) {
      await deps.updateServerSettings?.({ engine: settings.engine, apacheMpm: settings.apacheMpm }, actor).catch(() => undefined)
      await restorePrevious().catch(() => undefined)
      throw error
    }
  }

  const now = (deps.now ?? (() => new Date()))()
  const nextGenId = (stored.generations[0]?.id ?? 0) + 1
  const checksum = sha256(JSON.stringify({ selection, content: target.content }))
  const generation: WebStackGenerationRecord = {
    id: nextGenId,
    createdAt: now.toISOString(),
    actor,
    profileId: selection.profileId,
    engine: selection.engine,
    mpm: 'itk',
    checksum,
    configPath: target.path,
    previousContent,
    appliedContent: target.content,
    status: 'active',
  }
  const nextState: StoredWebStackState = {
    version: 1,
    selection,
    updatedAt: now.toISOString(),
    generations: [generation, ...stored.generations].slice(0, 50),
  }
  await writeStoredState(deps.stateRoot, nextState)
  const updatedSettings: ServerSettings = { ...settings, engine: selection.engine, apacheMpm: 'itk' }
  const revision = stateRevision(nextState, updatedSettings)

  await deps.audit?.({
    actor,
    action: 'server.web_stack.applied',
    target: `web-stack:${selection.profileId}`,
    outcome: 'ok',
    detail: { engine: selection.engine, mpm: 'itk', generationId: nextGenId, modules: selection.modules, phpVersions: selection.phpVersions },
  }).catch(() => undefined)

  return {
    applied: true,
    stateChanged: true,
    isolationPolicy: 'mpm_itk',
    generationId: nextGenId,
    revision,
    selection,
    tests: { nginx: nginxTest, apache: apacheTest },
  }
}

export async function handleWebStackRoute(req: Request, url: URL, method: string, deps: WebStackRouteDeps): Promise<Response | null> {
  const path = url.pathname
  if (path !== '/host/web-stack' && path !== '/host/web-stack/preview' && path !== '/host/web-stack/apply') {
    return null
  }
  const isRead = path === '/host/web-stack'
  const expectedMethod = isRead ? 'GET' : 'POST'
  if (method !== expectedMethod) {
    return new Response(null, { status: 405, headers: { allow: expectedMethod } })
  }
  if (url.search) {
    return fail('VALIDATION', 'web stack routes do not accept query selectors', unchanged)
  }

  const action = isRead ? 'host.web_stack.read' : path === '/host/web-stack/preview' ? 'host.web_stack.preview' : 'host.web_stack.apply'
  const first = await deps.assertRoot(action)

  if (isRead) {
    return jsonResponse(await readWebStack(deps))
  }

  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return fail('VALIDATION', 'JSON request body is required', unchanged)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return fail('VALIDATION', 'web stack request exceeds size limit', unchanged)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail('VALIDATION', 'request body must be valid JSON', unchanged)
  }

  if (path === '/host/web-stack/preview') {
    return jsonResponse(await previewWebStack(deps, body))
  }

  const fresh = await deps.assertRoot(action)
  if (fresh.actor !== first.actor) {
    return fail('FORBIDDEN', 'web stack authority changed', unchanged)
  }
  return jsonResponse(await applyWebStack(deps, body, fresh.actor))
}
