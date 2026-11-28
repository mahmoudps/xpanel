import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail, type OsProfile, type ServerSettings } from '@xpanel/core'
import { renderOlsListener, renderOlsServerBase } from '../../../packages/render/src/edge/ols.ts'

const unchanged = { stateChanged: false } as const
const MAX_BODY_BYTES = 512 * 1024
const MAX_CONFIG_BYTES = 256 * 1024
const LOG_TAIL_BYTES = 65536
const SAFE_SHA256 = /^[0-9a-f]{64}$/
const SAFE_BACKUP_ID = /^[0-9]{13}-[0-9a-f]{8}$/
const BACKUP_SUBDIR = 'extended/server/ols-backups'

export const OLS_SERVICE_ACTIONS = ['start', 'stop', 'restart', 'enable', 'disable'] as const
export type OlsServiceAction = (typeof OLS_SERVICE_ACTIONS)[number]

export type OlsLifecycleState = 'active' | 'inactive' | 'failed' | 'not_installed'

export interface OlsBackupEntry {
  id: string
  createdAt: string
  actor: string
  checksum: string
  configPath: string
}

export interface OlsConfigValidation {
  valid: true
  linesCount: number
  directivesCount: number
  warnings: string[]
}

export interface OlsView {
  observedAt: string
  installed: boolean
  state: OlsLifecycleState
  unit: string | null
  active: string | null
  enabled: string | null
  binaryPath: string
  configPath: string
  config: string | null
  revision: string | null
  backups: OlsBackupEntry[]
  logTail: string[]
  renderedReference: string
}

export interface OlsActionResult {
  action: OlsServiceAction
  unit: string
  active: string | null
  enabled: string | null
  state: Exclude<OlsLifecycleState, 'not_installed'>
  stateChanged: true
}

export interface OlsPreviewResult {
  valid: true
  stateChanged: false
  installed: boolean
  revision: string
  currentRevision: string | null
  changed: boolean
  linesCount: number
  directivesCount: number
  warnings: string[]
  renderedText: string
}

export interface OlsApplyResult {
  applied: true
  stateChanged: true
  backupId: string
  revision: string
  configPath: string
  active: string | null
}

export interface OlsRollbackResult {
  rolledBack: true
  stateChanged: true
  backupId: string
  revision: string
  configPath: string
  active: string | null
}

export interface OlsHostFs {
  readFile(path: string): Promise<string | null>
  writeFile(file: { path: string; content: string; mode: number; owner: string; group: string }): Promise<unknown>
  stat(path: string): Promise<{ uid: number; gid: number; mode: number } | null>
  tail(path: string, bytes: number): Promise<string | null>
}

export interface OlsRunResult {
  ok: boolean
  code?: number | null
  stdout: string
  stderr: string
}

export interface OlsRouteDeps {
  assertRoot: (action: string) => Promise<{ actor: string }>
  os: OsProfile
  stateRoot: string
  readServerSettings: () => Promise<ServerSettings | null>
  run: ((argv: readonly string[]) => Promise<OlsRunResult>) | null
  fs?: OlsHostFs
  audit?: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  now?: () => Date
}

interface StoredOlsBackup extends OlsBackupEntry {
  content: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const defaultOlsSettings = (): ServerSettings => ({
  hostname: 'localhost.localdomain',
  nameservers: ['ns1.localhost.localdomain'],
  adminEmail: 'root@localhost.localdomain',
  engine: 'openlitespeed',
  apacheMpm: 'itk',
  panelPort: 2087,
  sshPort: 22,
  backendPort: 8080,
  backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 150, serverLimit: 150, maxConnectionsPerChild: 0 },
})

const defaultHostFs: OlsHostFs = {
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
  async tail(path, bytes) {
    let handle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, bytes)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      return buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  },
}

function sanitizeLogLines(text: string | null, max = 150): string[] {
  if (text === null) return []
  const lines = text.split('\n')
  if (text.length >= LOG_TAIL_BYTES) lines.shift()
  return lines
    .filter(Boolean)
    .slice(-max)
    .map(line => line
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')
      .replace(/((?:pwd|password|pass|secret|token)"?\s*[:=]\s*)"?[^"\s]+"?/gi, '$1[REDACTED]')
      .slice(0, 1000))
}

/**
 * Validates OpenLiteSpeed httpd_config.conf text:
 * - Bounded UTF-8 text without control characters or NUL bytes.
 * - Rejects shell metacharacters (`backticks`, `$(`, `${`, `;`, `|`, `&`, `<`, `>`) outside comments.
 * - Rejects unsafe `include` targets outside `<olsRoot>/conf/*.conf` or containing traversal (`..`).
 * - Verifies balanced `{` / `}` block structure.
 */
export function validateOlsConfigText(text: unknown, olsRoot = '/usr/local/lsws'): OlsConfigValidation {
  if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    return fail('VALIDATION', 'OpenLiteSpeed configuration text must be a non-empty string within 256 KB', {
      ...unchanged,
      reason: 'invalid_ols_config_text',
    })
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    return fail('VALIDATION', 'OpenLiteSpeed configuration contains unsupported control characters', {
      ...unchanged,
      reason: 'invalid_ols_config_text',
    })
  }

  const normalizedRoot = olsRoot.replace(/\/+$/, '')
  const allowedIncludePrefix = `${normalizedRoot}/conf/`
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const warnings: string[] = []
  let depth = 0
  let directivesCount = 0

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const trimmed = lines[index]!.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    if (/[`$;|&<>]/.test(trimmed) || /\$\(/.test(trimmed) || /\$\{/.test(trimmed)) {
      return fail('VALIDATION', `disallowed shell metacharacter on line ${lineNo}`, {
        ...unchanged,
        reason: 'unsafe_ols_directive',
        line: lineNo,
      })
    }

    const includeMatch = /^include\s+(.+)$/i.exec(trimmed)
    if (includeMatch) {
      const target = includeMatch[1]!.trim().replace(/^["']|["']$/g, '')
      if (
        !target.startsWith(allowedIncludePrefix)
        || target.includes('..')
        || target.includes('*')
        || target.includes('?')
        || target.includes('://')
        || !target.endsWith('.conf')
        || !/^[A-Za-z0-9/_.-]+$/.test(target)
      ) {
        return fail('VALIDATION', `unsafe OpenLiteSpeed include path on line ${lineNo}`, {
          ...unchanged,
          reason: 'unsafe_ols_include',
          line: lineNo,
        })
      }
    }

    for (const ch of trimmed) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth < 0) {
          return fail('VALIDATION', `unmatched closing brace on line ${lineNo}`, {
            ...unchanged,
            reason: 'ols_config_syntax_invalid',
            line: lineNo,
          })
        }
      }
    }
    directivesCount++
  }

  if (depth !== 0) {
    return fail('VALIDATION', 'unclosed configuration block in OpenLiteSpeed configuration', {
      ...unchanged,
      reason: 'ols_config_syntax_invalid',
    })
  }

  if (!lines.some(line => /^\s*listener\b/i.test(line))) {
    warnings.push('No listener block present in httpd_config.conf.')
  }

  return { valid: true, linesCount: lines.length, directivesCount, warnings }
}

/** Reuses @xpanel/render OLS generators to build the canonical base + loopback listener block. */
export function renderOlsManagedPreview(settings: ServerSettings | null, maps: { vhost: string; names: string[] }[] = []): string {
  const effective: ServerSettings = { ...(settings ?? defaultOlsSettings()), engine: 'openlitespeed' }
  return `${renderOlsServerBase(effective)}${renderOlsListener(effective, maps)}`
}

interface ProbedService {
  installed: boolean
  unit: string | null
  active: string | null
  enabled: string | null
  state: OlsLifecycleState
  binaryPath: string
  configPath: string
  logPath: string
}

function parseSystemctlShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

async function probeOpenLiteSpeed(deps: OlsRouteDeps, fs: OlsHostFs): Promise<ProbedService> {
  const olsRoot = deps.os.paths.olsRoot.replace(/\/+$/, '')
  const binaryPath = `${olsRoot}/bin/lshttpd`
  const configPath = `${olsRoot}/conf/httpd_config.conf`
  const logPath = `${olsRoot}/logs/error.log`

  const binStat = await fs.stat(binaryPath)
  const candidates = [...new Set([deps.os.services.openlitespeed, 'lshttpd.service', 'lsws.service'])]
  let foundUnit: string | null = null
  let active: string | null = null
  let enabled: string | null = null

  if (deps.run) {
    for (const unit of candidates) {
      const res = await deps.run(['/usr/bin/systemctl', 'show', '--no-pager', '--property=Id,LoadState,ActiveState,UnitFileState', '--', unit]).catch(() => null)
      if (!res?.ok) continue
      const props = parseSystemctlShow(res.stdout)
      if (props.LoadState && props.LoadState !== 'not-found') {
        foundUnit = props.Id || unit
        active = props.ActiveState || null
        enabled = props.UnitFileState || null
        break
      }
    }
  }

  const installed = binStat !== null || foundUnit !== null
  if (!installed) {
    return { installed: false, unit: null, active: null, enabled: null, state: 'not_installed', binaryPath, configPath, logPath }
  }
  const state: OlsLifecycleState = active === 'active' ? 'active' : active === 'failed' ? 'failed' : 'inactive'
  return { installed: true, unit: foundUnit, active, enabled, state, binaryPath, configPath, logPath }
}

async function listBackups(stateRoot: string): Promise<StoredOlsBackup[]> {
  const dir = join(stateRoot, BACKUP_SUBDIR)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const items: StoredOlsBackup[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<StoredOlsBackup>
      if (
        typeof parsed.id === 'string'
        && SAFE_BACKUP_ID.test(parsed.id)
        && typeof parsed.createdAt === 'string'
        && typeof parsed.actor === 'string'
        && typeof parsed.checksum === 'string'
        && SAFE_SHA256.test(parsed.checksum)
        && typeof parsed.configPath === 'string'
        && typeof parsed.content === 'string'
      ) {
        items.push(parsed as StoredOlsBackup)
      }
    } catch {
      /* ignore malformed backup record */
    }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
}

async function saveBackup(stateRoot: string, entry: StoredOlsBackup): Promise<void> {
  const dir = join(stateRoot, BACKUP_SUBDIR)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  const target = join(dir, `${entry.id}.json`)
  const staged = `${target}.tmp`
  await writeFile(staged, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 })
  await rename(staged, target)
}

async function reloadAndVerifyOls(deps: OlsRouteDeps, unit: string | null, action: 'reload' | 'restart' = 'restart'): Promise<{ ok: boolean; active: string | null }> {
  if (!deps.run || !unit) {
    return { ok: true, active: unit ? 'unknown' : null }
  }
  const res = await deps.run(['/usr/bin/systemctl', action, '--', unit])
  if (!res.ok) return { ok: false, active: null }
  const show = await deps.run(['/usr/bin/systemctl', 'show', '--no-pager', '--property=ActiveState', '--', unit]).catch(() => null)
  const active = show?.ok ? (parseSystemctlShow(show.stdout).ActiveState ?? null) : null
  return { ok: active === 'active', active }
}

export async function readOlsView(deps: OlsRouteDeps): Promise<OlsView> {
  const now = (deps.now ?? (() => new Date()))()
  const fs = deps.fs ?? defaultHostFs
  const settings = await deps.readServerSettings()
  const probed = await probeOpenLiteSpeed(deps, fs)
  const renderedReference = renderOlsManagedPreview(settings)

  if (!probed.installed) {
    return {
      observedAt: now.toISOString(),
      installed: false,
      state: 'not_installed',
      unit: null,
      active: null,
      enabled: null,
      binaryPath: probed.binaryPath,
      configPath: probed.configPath,
      config: null,
      revision: null,
      backups: [],
      logTail: [],
      renderedReference,
    }
  }

  const config = await fs.readFile(probed.configPath)
  const backups = (await listBackups(deps.stateRoot)).map(({ content: _content, ...meta }) => meta)
  const logTail = sanitizeLogLines(await fs.tail(probed.logPath, LOG_TAIL_BYTES).catch(() => null))
  return {
    observedAt: now.toISOString(),
    installed: true,
    state: probed.state,
    unit: probed.unit,
    active: probed.active,
    enabled: probed.enabled,
    binaryPath: probed.binaryPath,
    configPath: probed.configPath,
    config,
    revision: config === null ? null : sha256(config),
    backups,
    logTail,
    renderedReference,
  }
}

export async function controlOlsService(deps: OlsRouteDeps, body: unknown, actor: string): Promise<OlsActionResult> {
  if (!isRecord(body) || typeof body.action !== 'string' || !(OLS_SERVICE_ACTIONS as readonly string[]).includes(body.action)) {
    return fail('VALIDATION', 'action must be one of start, stop, restart, enable, disable', { ...unchanged, reason: 'unsupported_ols_action' })
  }
  const action = body.action as OlsServiceAction
  const fs = deps.fs ?? defaultHostFs
  const probed = await probeOpenLiteSpeed(deps, fs)
  if (!probed.installed || !probed.unit) {
    return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed on this host', { ...unchanged, reason: 'openlitespeed_not_installed' })
  }
  if (!deps.run) {
    return fail('PRECONDITION_FAILED', 'native Linux executor is unavailable', { ...unchanged, reason: 'native_host_required' })
  }

  const execRes = await deps.run(['/usr/bin/systemctl', action, '--', probed.unit])
  if (!execRes.ok) {
    await deps.audit?.({
      actor,
      action: 'server.openlitespeed.service_action',
      target: `service:${probed.unit}`,
      outcome: 'failed',
      detail: { action, stderr: execRes.stderr.slice(0, 200) },
    }).catch(() => undefined)
    return fail('CONFIG_TEST_FAILED', `systemctl ${action} failed for ${probed.unit}`, { stateChanged: true, verificationRequired: true, reason: 'ols_service_control_failed' })
  }

  const after = await probeOpenLiteSpeed(deps, fs)
  const expectedOk =
    action === 'stop' ? after.active !== 'active'
      : action === 'enable' ? after.enabled === 'enabled'
        : action === 'disable' ? after.enabled === 'disabled'
          : after.active === 'active'
  if (!expectedOk) {
    return fail('SERVICE_UNAVAILABLE', `OpenLiteSpeed did not reach expected state after ${action}`, { stateChanged: true, verificationRequired: true, reason: 'ols_control_unverified' })
  }

  await deps.audit?.({
    actor,
    action: 'server.openlitespeed.service_action',
    target: `service:${probed.unit}`,
    outcome: 'ok',
    detail: { action, active: after.active, enabled: after.enabled },
  }).catch(() => undefined)

  return {
    action,
    unit: probed.unit,
    active: after.active,
    enabled: after.enabled,
    state: after.state === 'not_installed' ? 'inactive' : after.state,
    stateChanged: true,
  }
}

export async function previewOlsConfig(deps: OlsRouteDeps, body: unknown): Promise<OlsPreviewResult> {
  if (!isRecord(body)) {
    return fail('VALIDATION', 'OpenLiteSpeed config preview requires a JSON object', { ...unchanged, reason: 'invalid_ols_payload' })
  }
  const fs = deps.fs ?? defaultHostFs
  const settings = await deps.readServerSettings()
  const olsRoot = deps.os.paths.olsRoot.replace(/\/+$/, '')
  const candidate = body.generateBase === true && body.text === undefined
    ? renderOlsManagedPreview(settings)
    : body.text

  const validation = validateOlsConfigText(candidate, olsRoot)
  const renderedText = candidate as string
  const probed = await probeOpenLiteSpeed(deps, fs)
  const currentText = probed.installed ? await fs.readFile(probed.configPath) : null
  const currentRevision = currentText === null ? null : sha256(currentText)
  const revision = sha256(renderedText)

  return {
    valid: validation.valid,
    stateChanged: false,
    installed: probed.installed,
    revision,
    currentRevision,
    changed: currentRevision !== revision,
    linesCount: validation.linesCount,
    directivesCount: validation.directivesCount,
    warnings: validation.warnings,
    renderedText,
  }
}

export async function applyOlsConfig(deps: OlsRouteDeps, body: unknown, actor: string): Promise<OlsApplyResult> {
  if (!isRecord(body)) {
    return fail('VALIDATION', 'OpenLiteSpeed config apply requires a JSON object', { ...unchanged, reason: 'invalid_ols_payload' })
  }
  const fs = deps.fs ?? defaultHostFs
  const probed = await probeOpenLiteSpeed(deps, fs)
  if (!probed.installed) {
    return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed on this host', { ...unchanged, reason: 'openlitespeed_not_installed' })
  }

  const olsRoot = deps.os.paths.olsRoot.replace(/\/+$/, '')
  validateOlsConfigText(body.text, olsRoot)
  const candidate = body.text as string
  const current = await fs.readFile(probed.configPath)
  const currentInfo = await fs.stat(probed.configPath)
  const currentRevision = current === null ? null : sha256(current)

  if (body.expectedRevision !== undefined) {
    if (typeof body.expectedRevision !== 'string' || !SAFE_SHA256.test(body.expectedRevision)) {
      return fail('VALIDATION', 'expectedRevision must be a 64-character hex digest', { ...unchanged, reason: 'invalid_revision' })
    }
    if (currentRevision !== null && body.expectedRevision !== currentRevision) {
      return fail('CONFLICT', 'OpenLiteSpeed configuration changed since it was read', { ...unchanged, reason: 'config_changed' })
    }
  }

  const now = (deps.now ?? (() => new Date()))()
  const backupId = `${String(now.getTime()).padStart(13, '0')}-${sha256(current ?? '').slice(0, 8)}`
  if (current !== null) {
    await saveBackup(deps.stateRoot, {
      id: backupId,
      createdAt: now.toISOString(),
      actor,
      checksum: sha256(current),
      configPath: probed.configPath,
      content: current,
    })
  }

  const restore = async (): Promise<boolean> => {
    if (current === null) return false
    try {
      await fs.writeFile({
        path: probed.configPath,
        content: current,
        mode: currentInfo?.mode ?? 0o644,
        owner: String(currentInfo?.uid ?? 'root'),
        group: String(currentInfo?.gid ?? 'root'),
      })
      const rel = await reloadAndVerifyOls(deps, probed.unit, 'restart')
      return rel.ok
    } catch {
      return false
    }
  }

  await fs.writeFile({
    path: probed.configPath,
    content: candidate,
    mode: currentInfo?.mode ?? 0o644,
    owner: String(currentInfo?.uid ?? 'root'),
    group: String(currentInfo?.gid ?? 'root'),
  })

  if (deps.run && probed.unit) {
    const lswsctrl = `${olsRoot}/bin/lswsctrl`
    const ctrlStat = await fs.stat(lswsctrl)
    if (ctrlStat) {
      const cfgTest = await deps.run([lswsctrl, 'configtest']).catch(() => null)
      if (cfgTest && !cfgTest.ok) {
        const restored = await restore()
        return fail('CONFIG_TEST_FAILED', 'OpenLiteSpeed rejected the configuration; previous file restored', restored
          ? { stateChanged: false, restored: true, reason: 'openlitespeed_config_rejected', output: (cfgTest.stderr || cfgTest.stdout).slice(0, 400) }
          : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'openlitespeed_rollback_failed' })
      }
    }

    const wasActive = probed.active === 'active'
    if (wasActive) {
      const reloaded = await reloadAndVerifyOls(deps, probed.unit, 'restart')
      if (!reloaded.ok) {
        const restored = await restore()
        return fail('CONFIG_TEST_FAILED', 'OpenLiteSpeed failed to restart with new configuration; previous file restored', restored
          ? { stateChanged: false, restored: true, reason: 'openlitespeed_config_rejected' }
          : { stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'openlitespeed_rollback_failed' })
      }
    }
  }

  const after = await probeOpenLiteSpeed(deps, fs)
  await deps.audit?.({
    actor,
    action: 'server.openlitespeed.config_applied',
    target: `config:${probed.configPath}`,
    outcome: 'ok',
    detail: { backupId, revision: sha256(candidate) },
  }).catch(() => undefined)

  return {
    applied: true,
    stateChanged: true,
    backupId,
    revision: sha256(candidate),
    configPath: probed.configPath,
    active: after.active,
  }
}

export async function rollbackOlsConfig(deps: OlsRouteDeps, body: unknown, actor: string): Promise<OlsRollbackResult> {
  if (!isRecord(body)) {
    return fail('VALIDATION', 'OpenLiteSpeed config rollback requires a JSON object', { ...unchanged, reason: 'invalid_ols_payload' })
  }
  const fs = deps.fs ?? defaultHostFs
  const probed = await probeOpenLiteSpeed(deps, fs)
  if (!probed.installed) {
    return fail('PRECONDITION_FAILED', 'OpenLiteSpeed is not installed on this host', { ...unchanged, reason: 'openlitespeed_not_installed' })
  }

  const backups = await listBackups(deps.stateRoot)
  const target = body.backupId === undefined
    ? backups[0]
    : typeof body.backupId === 'string' && SAFE_BACKUP_ID.test(body.backupId)
      ? backups.find(item => item.id === body.backupId)
      : fail('VALIDATION', 'invalid backupId format', { ...unchanged, reason: 'invalid_backup_id' })

  if (!target) {
    return fail('NOT_FOUND', 'no OpenLiteSpeed configuration backup is available to restore', { ...unchanged, reason: 'ols_backup_not_found' })
  }

  const current = await fs.readFile(probed.configPath)
  const currentInfo = await fs.stat(probed.configPath)
  if (body.expectedRevision !== undefined) {
    if (typeof body.expectedRevision !== 'string' || !SAFE_SHA256.test(body.expectedRevision)) {
      return fail('VALIDATION', 'expectedRevision must be a 64-character hex digest', { ...unchanged, reason: 'invalid_revision' })
    }
    if (current !== null && sha256(current) !== body.expectedRevision) {
      return fail('CONFLICT', 'OpenLiteSpeed configuration changed since last read', { ...unchanged, reason: 'config_changed' })
    }
  }

  const olsRoot = deps.os.paths.olsRoot.replace(/\/+$/, '')
  validateOlsConfigText(target.content, olsRoot)

  await fs.writeFile({
    path: probed.configPath,
    content: target.content,
    mode: currentInfo?.mode ?? 0o644,
    owner: String(currentInfo?.uid ?? 'root'),
    group: String(currentInfo?.gid ?? 'root'),
  })

  if (deps.run && probed.unit && probed.active === 'active') {
    const reloaded = await reloadAndVerifyOls(deps, probed.unit, 'restart')
    if (!reloaded.ok) {
      if (current !== null) {
        await fs.writeFile({
          path: probed.configPath,
          content: current,
          mode: currentInfo?.mode ?? 0o644,
          owner: String(currentInfo?.uid ?? 'root'),
          group: String(currentInfo?.gid ?? 'root'),
        }).catch(() => undefined)
        await reloadAndVerifyOls(deps, probed.unit, 'restart').catch(() => undefined)
      }
      return fail('CONFIG_TEST_FAILED', 'OpenLiteSpeed failed to restart after rollback', {
        stateChanged: true,
        unknownOutcome: true,
        verificationRequired: true,
        reason: 'openlitespeed_rollback_failed',
      })
    }
  }

  const after = await probeOpenLiteSpeed(deps, fs)
  await deps.audit?.({
    actor,
    action: 'server.openlitespeed.config_rolled_back',
    target: `config:${probed.configPath}`,
    outcome: 'ok',
    detail: { backupId: target.id, revision: sha256(target.content) },
  }).catch(() => undefined)

  return {
    rolledBack: true,
    stateChanged: true,
    backupId: target.id,
    revision: sha256(target.content),
    configPath: probed.configPath,
    active: after.active,
  }
}

export async function handleOlsManagerRoute(req: Request, url: URL, method: string, deps: OlsRouteDeps): Promise<Response | null> {
  const path = url.pathname
  const prefix = '/host/services/openlitespeed'
  if (path !== prefix && !path.startsWith(prefix + '/')) {
    return null
  }
  const op = path.slice(prefix.length)
  const isRead = op === ''
  const isWrite = op === '/action' || op === '/config/preview' || op === '/config/apply' || op === '/config/rollback'
  if (!isRead && !isWrite) {
    return new Response(null, { status: 404 })
  }
  const expectedMethod = isRead ? 'GET' : 'POST'
  if (method !== expectedMethod) {
    return new Response(null, { status: 405, headers: { allow: expectedMethod } })
  }
  if (url.search) {
    return fail('VALIDATION', 'OpenLiteSpeed routes do not accept query selectors', unchanged)
  }

  const action = isRead ? 'host.services.openlitespeed.read' : `host.services.openlitespeed.${op.slice(1).replace(/\//g, '.')}`
  const first = await deps.assertRoot(action)

  if (isRead) {
    return jsonResponse(await readOlsView(deps))
  }

  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return fail('VALIDATION', 'JSON request body is required', unchanged)
  }
  const raw = await req.text()
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return fail('VALIDATION', 'OpenLiteSpeed request exceeds size limit', unchanged)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail('VALIDATION', 'request body must be valid JSON', unchanged)
  }

  if (op === '/config/preview') {
    return jsonResponse(await previewOlsConfig(deps, body))
  }

  const fresh = await deps.assertRoot(action)
  if (fresh.actor !== first.actor) {
    return fail('FORBIDDEN', 'OpenLiteSpeed authority changed', unchanged)
  }

  if (op === '/action') return jsonResponse(await controlOlsService(deps, body, fresh.actor))
  if (op === '/config/apply') return jsonResponse(await applyOlsConfig(deps, body, fresh.actor))
  return jsonResponse(await rollbackOlsConfig(deps, body, fresh.actor))
}
