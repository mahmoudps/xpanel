/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

export type UpgradeHistoryRow = { id: string; fromVersion: string; toVersion: string; fromSchemaVersion: number | null; toSchemaVersion: number | null; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back'; phase: string | null; error: string | null; actor: string; createdAt: string; startedAt: string | null; finishedAt: string | null }
export type UpgradeLockView = { present: boolean | null; state: string | null; to: string | null; at: string | null }
export type StagedReleaseView = { manifest: string; version: string | null; schemaVersion: number | null; bytes: number | null; sha256: string | null; keyId: string | null; signatureState: 'verified' | 'unverified' | 'invalid' | 'no-trusted-keys'; reason: string | null }
export type UpgradeGate = { enabled: boolean; reasons: string[] }
export type UpgradeObservationView = {
  observedAt: string; revision: string
  current: { state: 'read' | 'unavailable'; version: string | null; releasePath: string | null }
  schemaVersion: number | null; os: { id: string; versionId: string; prettyName: string } | null
  freeBytes: number | null; freeBytesPath: string; activeTransfers: number | null
  lock: UpgradeLockView; retirementPending: boolean | null; maintenance: boolean | null; lastUpgrade: UpgradeHistoryRow | null
  trust: { state: 'configured' | 'missing' | 'invalid'; keysConfigured: number; keyIds: string[]; source: string; reason: string | null }
  staged: { directory: string; state: 'read' | 'missing' | 'unavailable'; truncated: boolean; releases: StagedReleaseView[] }
  coordinator: { available: boolean; reason: string | null }
  availability: { preflight: UpgradeGate; start: UpgradeGate; candidates: string[] }
  snapshotsDir: string
}
export type UpgradeCheckView = { id: string; ok: boolean; message: string; detail: Record<string, string | number | boolean | null> }
export type UpgradePreflightView = { observedAt: string; revision: string; targetVersion: string; fromVersion: string | null; report: { ok: boolean; checks: UpgradeCheckView[] }; start: UpgradeGate }
export type UpgradeStartView = { accepted: true; handoffId: string; upgradeId: string | null; targetVersion: string; fromVersion: string | null }
export type UpgradeStatusView = { observedAt: string; revision: string; lock: UpgradeLockView; retirementPending: boolean | null; maintenance: boolean | null; current: UpgradeObservationView['current']; latest: UpgradeHistoryRow | null; history: UpgradeHistoryRow[] }

/** Self-contained strict readers; the binding embeds this function's source. */
export function createUpgradeParsers() {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const bad = (what: string): never => { throw new Error('invalid_upgrade_' + what) }
  const isVersion = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(v)
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v))
  const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f\u202A-\u202E\u2066-\u2069]/.test(v)
  const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v)
  const isCode = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v)
  const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
  const isRevision = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  const or = <T>(v: unknown, check: (x: unknown) => boolean, what: string): T | null => v === null ? null : check(v) ? v as T : bad(what)
  const gate = (v: unknown): { enabled: boolean; reasons: string[] } => object(v) && typeof v.enabled === 'boolean' && Array.isArray(v.reasons) && v.reasons.length <= 32 && v.reasons.every(isCode) && v.enabled === (v.reasons.length === 0) ? { enabled: v.enabled, reasons: [...v.reasons as string[]] } : bad('gate')
  const lock = (v: unknown) => {
    if (!object(v) || ![true, false, null].includes(v.present as boolean | null) || !(v.state === null || ['running', 'rollback-failed', 'retirement-pending', 'unreadable'].includes(String(v.state)))) return bad('lock')
    return { present: v.present as boolean | null, state: v.state as string | null, to: or<string>(v.to, x => isText(x, 64), 'lock'), at: or<string>(v.at, x => isText(x, 64), 'lock') }
  }
  const current = (v: unknown) => {
    if (!object(v) || !['read', 'unavailable'].includes(String(v.state)) || (v.state === 'read') !== isVersion(v.version) || v.state === 'unavailable' && (v.version !== null || v.releasePath !== null)) return bad('current')
    return { state: v.state as 'read' | 'unavailable', version: v.version as string | null, releasePath: or<string>(v.releasePath, isPath, 'current') }
  }
  const row = (v: unknown): UpgradeHistoryRow => {
    if (!object(v) || !isUuid(v.id) || !isText(v.fromVersion, 128) || !isText(v.toVersion, 128) || !['pending', 'running', 'succeeded', 'failed', 'rolled_back'].includes(String(v.status))
      || !(v.phase === null || ['precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback'].includes(String(v.phase))) || !isText(v.actor, 255) || !isTime(v.createdAt)) return bad('history')
    return { id: v.id, fromVersion: v.fromVersion, toVersion: v.toVersion, fromSchemaVersion: or<number>(v.fromSchemaVersion, isCount, 'history'), toSchemaVersion: or<number>(v.toSchemaVersion, isCount, 'history'), status: v.status as UpgradeHistoryRow['status'], phase: v.phase as string | null,
      error: or<string>(v.error, x => isText(x, 2000), 'history'), actor: v.actor, createdAt: v.createdAt, startedAt: or<string>(v.startedAt, isTime, 'history'), finishedAt: or<string>(v.finishedAt, isTime, 'history') }
  }
  const staged = (v: unknown): StagedReleaseView => {
    if (!object(v) || !isText(v.manifest, 160) || !/\.manifest\.json$/.test(v.manifest) || !['verified', 'unverified', 'invalid', 'no-trusted-keys'].includes(String(v.signatureState)) || !(v.reason === null || isCode(v.reason))) return bad('staged')
    const sha = or<string>(v.sha256, x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x), 'staged')
    const result = { manifest: v.manifest, version: or<string>(v.version, isVersion, 'staged'), schemaVersion: or<number>(v.schemaVersion, isCount, 'staged'), bytes: or<number>(v.bytes, isCount, 'staged'), sha256: sha, keyId: or<string>(v.keyId, x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x), 'staged'), signatureState: v.signatureState as StagedReleaseView['signatureState'], reason: v.reason as string | null }
    if (result.signatureState === 'verified' && (result.version === null || result.sha256 === null || result.reason !== null)) return bad('staged')
    return result
  }
  return {
    observation(value: unknown): UpgradeObservationView {
      const v = value
      if (!object(v) || !isTime(v.observedAt) || !isRevision(v.revision) || !object(v.trust) || !object(v.staged) || !object(v.coordinator) || !object(v.availability) || !isPath(v.freeBytesPath) || !isPath(v.snapshotsDir)) return bad('observation')
      const os = v.os === null ? null : object(v.os) && isText(v.os.id, 64) && isText(v.os.versionId, 64) && isText(v.os.prettyName, 256) ? { id: v.os.id, versionId: v.os.versionId, prettyName: v.os.prettyName } : bad('os')
      const trust = v.trust, stagedBlock = v.staged, availability = v.availability
      if (!['configured', 'missing', 'invalid'].includes(String(trust.state)) || !isCount(trust.keysConfigured) || !Array.isArray(trust.keyIds) || trust.keyIds.length !== trust.keysConfigured || trust.keyIds.length > 8 || !trust.keyIds.every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) || !isPath(trust.source) || !(trust.reason === null || isCode(trust.reason)) || (trust.state === 'configured') !== (trust.reason === null)) return bad('trust')
      if (!isPath(stagedBlock.directory) || !['read', 'missing', 'unavailable'].includes(String(stagedBlock.state)) || typeof stagedBlock.truncated !== 'boolean' || !Array.isArray(stagedBlock.releases) || stagedBlock.releases.length > 16) return bad('staged')
      if (typeof v.coordinator.available !== 'boolean' || !(v.coordinator.reason === null || isCode(v.coordinator.reason))) return bad('coordinator')
      if (!Array.isArray(availability.candidates) || availability.candidates.length > 16 || !availability.candidates.every(isVersion)) return bad('availability')
      const releases = stagedBlock.releases.map(staged)
      const candidates = [...availability.candidates as string[]]
      if (candidates.some(version => !releases.some(item => item.version === version && item.signatureState === 'verified'))) return bad('availability')
      return {
        observedAt: v.observedAt, revision: v.revision, current: current(v.current), schemaVersion: or<number>(v.schemaVersion, isCount, 'schema'), os,
        freeBytes: or<number>(v.freeBytes, isCount, 'free'), freeBytesPath: v.freeBytesPath, activeTransfers: or<number>(v.activeTransfers, isCount, 'transfers'),
        lock: lock(v.lock), retirementPending: or<boolean>(v.retirementPending, x => typeof x === 'boolean', 'retirement'), maintenance: or<boolean>(v.maintenance, x => typeof x === 'boolean', 'maintenance'),
        lastUpgrade: v.lastUpgrade === null ? null : row(v.lastUpgrade),
        trust: { state: trust.state as 'configured' | 'missing' | 'invalid', keysConfigured: trust.keysConfigured, keyIds: [...trust.keyIds as string[]], source: trust.source, reason: trust.reason as string | null },
        staged: { directory: stagedBlock.directory, state: stagedBlock.state as 'read' | 'missing' | 'unavailable', truncated: stagedBlock.truncated, releases },
        coordinator: { available: v.coordinator.available, reason: v.coordinator.reason as string | null },
        availability: { preflight: gate(availability.preflight), start: gate(availability.start), candidates },
        snapshotsDir: v.snapshotsDir,
      }
    },
    preflight(value: unknown): UpgradePreflightView {
      const v = value
      if (!object(v) || !isTime(v.observedAt) || !isRevision(v.revision) || !isVersion(v.targetVersion) || !(v.fromVersion === null || isVersion(v.fromVersion)) || !object(v.report) || typeof v.report.ok !== 'boolean' || !Array.isArray(v.report.checks) || v.report.checks.length > 16) return bad('preflight')
      const checks = v.report.checks.map(raw => {
        if (!object(raw) || !isCode(raw.id) || typeof raw.ok !== 'boolean' || !isText(raw.message, 500) || !object(raw.detail)) return bad('check')
        const detail: Record<string, string | number | boolean | null> = {}
        for (const [key, item] of Object.entries(raw.detail).slice(0, 8)) if (/^[a-zA-Z]{1,32}$/.test(key) && (item === null || typeof item === 'boolean' || isCount(item) || isText(item, 128))) detail[key] = item as string | number | boolean | null
        return { id: raw.id, ok: raw.ok, message: raw.message, detail }
      })
      if (v.report.ok !== checks.every(check => check.ok)) return bad('preflight')
      return { observedAt: v.observedAt, revision: v.revision, targetVersion: v.targetVersion, fromVersion: v.fromVersion as string | null, report: { ok: v.report.ok, checks }, start: gate(v.start) }
    },
    start(value: unknown): UpgradeStartView {
      const v = value
      if (!object(v) || v.accepted !== true || !isUuid(v.handoffId) || !(v.upgradeId === null || isUuid(v.upgradeId)) || !isVersion(v.targetVersion) || !(v.fromVersion === null || isVersion(v.fromVersion))) return bad('start')
      return { accepted: true, handoffId: v.handoffId, upgradeId: v.upgradeId as string | null, targetVersion: v.targetVersion, fromVersion: v.fromVersion as string | null }
    },
    status(value: unknown): UpgradeStatusView {
      const v = value
      if (!object(v) || !isTime(v.observedAt) || !isRevision(v.revision) || !Array.isArray(v.history) || v.history.length > 20) return bad('status')
      const history = v.history.map(row)
      const latest = v.latest === null ? null : row(v.latest)
      if ((latest?.id ?? null) !== (history[0]?.id ?? null)) return bad('status')
      return { observedAt: v.observedAt, revision: v.revision, lock: lock(v.lock), retirementPending: or<boolean>(v.retirementPending, x => typeof x === 'boolean', 'retirement'), maintenance: or<boolean>(v.maintenance, x => typeof x === 'boolean', 'maintenance'), current: current(v.current), latest, history }
    },
  }
}

const parsers = createUpgradeParsers()
export const readUpgradeObservationView = parsers.observation
export const readUpgradePreflightView = parsers.preflight
export const readUpgradeStartView = parsers.start
export const readUpgradeStatusView = parsers.status

type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

function bindWhmUpgrade(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const reasonCopy: Record<string, string> = {
    'no-trusted-release-keys': msgid('No trusted Ed25519 release keys are configured in the root-owned key file.'),
    'hmac-release-key-refused': msgid('The key file holds an HMAC secret; only Ed25519 public keys are accepted.'),
    'release-keys-file-unsafe': msgid('The release key file is not root-owned, is writable by others, or is a symbolic link.'),
    'release-keys-invalid': msgid('The release key file could not be parsed.'),
    'no-verified-staged-release': msgid('No staged release newer than the current one has a verified signature.'),
    'current-release-unreadable': msgid('The current release link or its VERSION marker could not be read.'),
    'os-release-unreadable': msgid('The host operating system could not be read.'),
    'schema-unreadable': msgid('The control-database schema could not be read.'),
    'free-space-unreadable': msgid('Free space on the release filesystem could not be read.'),
    'active-transfers-unreadable': msgid('Queued and running jobs could not be counted.'),
    'upgrade-lock-present': msgid('An upgrade lock is present.'),
    'retirement-pending': msgid('A previous upgrade still awaits lifecycle retirement.'),
    'maintenance-retained': msgid('A retained maintenance marker needs lifecycle recovery.'),
    'upgrade-in-flight': msgid('An upgrade is still pending or running.'),
    'upgrade-coordinator-unavailable': msgid('The native upgrade coordinator is not connected on this host, so no upgrade can start from this page.'),
    'upgrade-native-provider-unqualified': msgid('The out-of-process upgrade launcher has not passed its native safety qualification.'),
    'upgrade-hosted-uid-unqualified': msgid('Hosted-request user identity proof is unavailable; upgrades remain held.'),
    'preflight-failed': msgid('Preflight did not pass.'),
    'staged-release-not-verified': msgid('The selected release is no longer a verified staged release.'),
    'untrusted-key': msgid('Signed by a key that is not trusted.'),
    'signature-mismatch': msgid('The signature does not verify.'),
    'archive-missing': msgid('The release archive is missing.'),
    'archive-unsafe': msgid('The archive is not a root-owned regular file.'),
    'archive-checksum-mismatch': msgid('The archive checksum differs from the manifest.'),
    'archive-unreadable': msgid('The archive could not be read.'),
    'manifest-invalid': msgid('The manifest is malformed or carries unsigned fields.'),
    'manifest-not-regular-file': msgid('The manifest is not a regular file.'),
    'duplicate-version': msgid('Another manifest already stages this version.'),
  }
  const reasons = (list: readonly string[]): string => list.map(code => ((reasonCopy[code]) ? t(reasonCopy[code]!) : null) ?? code).join(' ')
  const statusCopy: Record<string, string> = { pending: msgctxt('whm-upgrade-client', 'Pending'), running: msgid('Running'), succeeded: msgctxt('whm-upgrade-client', 'Done'), failed: msgid('Failed'), rolled_back: msgid('Rolled back') }
  const signatureCopy: Record<string, string> = { verified: msgid('Verified'), unverified: msgid('Untrusted key'), invalid: msgid('Invalid'), 'no-trusted-keys': msgid('Not checked: no trusted keys') }
  const bytes = (value: number | null): string => value === null ? t('Not read') : value >= 1073741824 ? (value / 1073741824).toFixed(1) + ' GB' : (value / 1048576).toFixed(1) + ' MB'
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-whm-upgrade-workspace]').forEach(root => {
    if (root.dataset.upgradeBound === 'true') return
    root.dataset.upgradeBound = 'true'
    const page = root.closest<HTMLElement>('[data-whm-detail-route="/whm/server/upgrade"]')
    const send = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!page) return
    const q = <T extends HTMLElement>(selector: string): T | null => page.querySelector<T>(selector)
    const fact = (key: string, value: string | number | null | undefined): void => { const node = q('[data-upgrade-fact="' + key + '"]'); if (node) node.textContent = value === null || value === undefined ? t('Not read') : String(value) }
    const banner = q('[data-upgrade-banner]'), note = q('[data-upgrade-status]'), summary = q('[data-upgrade-preflight-summary]'), progress = q('[data-upgrade-progress]')
    const select = q<HTMLSelectElement>('[data-upgrade-target]'), confirm = q<HTMLDetailsElement>('[data-upgrade-confirm]'), phrase = q<HTMLInputElement>('[data-upgrade-confirm-input]')
    const buttons = { refresh: q<HTMLButtonElement>('[data-upgrade-refresh]'), preflight: q<HTMLButtonElement>('[data-upgrade-preflight]'), open: q<HTMLButtonElement>('[data-upgrade-open-confirm]'), cancel: q<HTMLButtonElement>('[data-upgrade-cancel]'), start: q<HTMLButtonElement>('[data-upgrade-start]') }
    if (!banner || !note || !summary || !progress || !select || !confirm || !phrase || Object.values(buttons).some(button => !button)) return
    const admitted = (): boolean => root.isConnected && root.dataset.upgradeCanManage === 'true' && !root.closest(denied)
    let observation: UpgradeObservationView | null = null, checked: UpgradePreflightView | null = null, busy = false, polls = 0, timer: ReturnType<typeof setTimeout> | null = null
    const say = (node: HTMLElement, state: string, message: string): void => { node.dataset.state = state; node.textContent = message; node.setAttribute('role', ['failed', 'stale'].includes(state) ? 'alert' : 'status') }
    const cell = (row: HTMLTableRowElement, value: string, technical = false): void => { const td = document.createElement('td'), text = document.createElement(technical ? 'bdi' : 'span'); if (technical) text.dir = 'ltr'; text.textContent = value; td.append(text); row.append(td) }
    const fill = (selector: string, columns: number, rows: string[][], technical: number[], empty: string): void => {
      const body = q(selector)
      if (!body) return
      body.textContent = ''
      for (const values of rows) { const row = document.createElement('tr'); values.forEach((value, index) => cell(row, value, technical.includes(index))); body.append(row) }
      if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); body.append(row) }
    }
    const ready = (): boolean => !!observation && !!checked && checked.revision === observation.revision && checked.targetVersion === select.value && checked.report.ok && checked.start.enabled
    const controls = (): void => {
      const ok = admitted() && !busy
      buttons.refresh!.disabled = !ok || !send
      select.disabled = !ok || !observation || observation.availability.candidates.length === 0
      buttons.preflight!.disabled = !ok || !observation?.availability.preflight.enabled || !select.value
      buttons.open!.disabled = !ok || !ready()
      phrase.disabled = !ok || !ready() || !confirm.open
      buttons.cancel!.disabled = !ok || !confirm.open
      buttons.start!.disabled = !ok || !ready() || !confirm.open || phrase.value !== 'upgrade ' + select.value
      root.setAttribute('aria-busy', String(busy))
    }
    const paintTarget = (): void => {
      const item = observation?.staged.releases.find(release => release.version === select.value && release.signatureState === 'verified')
      fact('available-version', item?.version); fact('available-schema', item?.schemaVersion); fact('available-bytes', item ? bytes(item.bytes) : null)
      fact('available-signature', item ? t('Verified with key {key}', { key: String(item.keyId) }) : null)
      fact('confirm-from', observation?.current.version); fact('confirm-to', item?.version); fact('confirm-phrase', item ? 'upgrade ' + item.version : 'upgrade')
      fact('added-release', item?.version && observation?.current.releasePath ? observation.current.releasePath.replace(/[^/]+$/, item.version) : null)
      fact('added-schema', item && observation?.schemaVersion !== null && observation ? observation.schemaVersion + ' → ' + item.schemaVersion : null)
      const migrations = q('[data-upgrade-migrations]')
      if (migrations && item && observation?.schemaVersion !== null && observation) migrations.textContent = item.schemaVersion === observation.schemaVersion
        ? t('Migrations in this release: none; the schema stays at {schema}.', { schema: String(item.schemaVersion) })
        : t('Migrations in this release: schema {from} → {to}. Each migration is checked as expand only by the upgrade machine after unpacking.', { from: String(observation.schemaVersion), to: String(item.schemaVersion) })
    }
    const paintHistory = (history: UpgradeHistoryRow[]): void => fill('[data-upgrade-history]', 6, history.map(row => [row.fromVersion + ' → ' + row.toVersion, (row.fromSchemaVersion ?? '?') + ' → ' + (row.toSchemaVersion ?? '?'), formatDisplayDateTime(row.startedAt ?? row.createdAt), ((statusCopy[row.status]) ? t(statusCopy[row.status]!) : null) ?? row.status, row.actor, row.error ?? '']), [0, 1, 2, 4], t('No upgrade has been recorded.'))
    const inFlight = (row: UpgradeHistoryRow | null): boolean => !!row && (row.status === 'pending' || row.status === 'running')
    const paintProgress = (lock: UpgradeLockView, latest: UpgradeHistoryRow | null, retirement: boolean | null): void => {
      const holder = progress.parentElement
      const order = ['precheck', 'snapshot', 'stage', 'migrate', 'switch', 'health-check', 'rollback']
      const at = latest?.phase ? order.indexOf(latest.phase) : -1
      page.querySelectorAll<HTMLElement>('[data-upgrade-phase]').forEach(row => {
        const index = order.indexOf(row.dataset.upgradePhase ?? ''), state = row.querySelector('[data-upgrade-phase-state]')
        if (!state) return
        state.textContent = !latest || at < 0 ? t('Not reached') : index === at ? (inFlight(latest) ? t(msgctxt('whm-upgrade-client', 'Current')) : ((statusCopy[latest.status]) ? t(statusCopy[latest.status]!) : null) ?? latest.status) : index < at && (index !== order.length - 1) ? t('Passed through') : t('Not reached')
      })
      const running = inFlight(latest) || lock.present === true
      if (holder) holder.dataset.upgradeProgressState = running ? 'running' : retirement ? 'attention' : latest ? 'finished' : 'idle'
      const label = latest ? ((statusCopy[latest.status]) ? t(statusCopy[latest.status]!) : null) ?? latest.status : ''
      say(progress, running ? 'running' : 'read', running ? (!latest ? t('An upgrade is recorded as locked.') : latest.phase ? t('An upgrade is recorded as {status} · {phase}.', { status: label, phase: latest.phase }) : t('An upgrade is recorded as {status}.', { status: label }))
        : latest ? t('The last upgrade is {status}.', { status: label }) : t('No upgrade has been recorded on this server.'))
    }
    const paintObservation = (value: UpgradeObservationView): void => {
      observation = value
      if (checked && checked.revision !== value.revision) checked = null
      fact('current-version', value.current.version); fact('current-schema', value.schemaVersion); fact('current-path', value.current.releasePath)
      const last = value.lastUpgrade
      fact('current-since', last && last.status === 'succeeded' && last.toVersion === value.current.version ? formatDisplayDateTime(last.finishedAt ?? last.createdAt) : null)
      fact('trust-keys', value.trust.keysConfigured ? value.trust.keyIds.join(', ') : t(msgctxt('whm-upgrade-client', 'None'))); fact('trust-source', value.trust.source); fact('staged-directory', value.staged.directory)
      fact('coordinator', value.coordinator.available ? t(msgctxt('whm-upgrade-client', 'Connected')) : t('Not connected')); fact('snapshot-dir', value.snapshotsDir)
      const previous = select.value
      select.textContent = ''
      for (const version of value.availability.candidates) { const option = document.createElement('option'); option.value = version; option.textContent = version; select.append(option) }
      if (!value.availability.candidates.length) { const option = document.createElement('option'); option.value = ''; option.textContent = t('No verified staged release is newer than the current one'); select.append(option) }
      if (value.availability.candidates.includes(previous)) select.value = previous
      fill('[data-upgrade-staged]', 4, value.staged.releases.map(item => [item.manifest, item.version ?? '?', item.schemaVersion === null ? '?' : String(item.schemaVersion), (((signatureCopy[item.signatureState]) ? t(signatureCopy[item.signatureState]!) : null) ?? item.signatureState) + (item.reason ? ' · ' + reasons([item.reason]) : '')]), [0, 1, 2],
        value.staged.state === 'read' ? t('No release manifest is staged.') : t('The staging folder is not present or could not be read.'))
      const candidate = value.availability.candidates[0]
      say(banner, value.availability.preflight.enabled ? 'read' : 'unavailable', value.availability.preflight.enabled
        ? t('Version {version} is staged and its signature verified. Nothing changes until you start.', { version: String(candidate) }) + (value.availability.start.enabled ? '' : ' ' + reasons(value.availability.start.reasons))
        : t('No upgrade can be prepared: {reasons}', { reasons: reasons(value.availability.preflight.reasons) }))
      if (value.lastUpgrade) paintHistory([value.lastUpgrade])
      paintProgress(value.lock, value.lastUpgrade, value.retirementPending)
      paintTarget()
    }
    const paintChecks = (value: UpgradePreflightView | null): void => {
      page.querySelectorAll<HTMLElement>('[data-upgrade-check]').forEach(row => {
        const check = value?.report.checks.find(item => item.id === row.dataset.upgradeCheck), result = row.querySelector('[data-upgrade-check-result]'), detail = row.querySelector('[data-upgrade-check-detail]')
        if (result) result.textContent = !check ? t('Not run') : check.ok ? t('Passed') : t('Failed')
        if (!detail) return
        const d = check?.detail ?? {}
        detail.textContent = !check ? t('Not run')
          : check.id === 'disk-space' ? t('{required} needed on {path}, {free} free', { required: bytes(typeof d.required === 'number' ? d.required : null), path: observation?.freeBytesPath ?? '', free: bytes(typeof d.free === 'number' ? d.free : null) })
            : check.id === 'os-supported' ? String(d.id ?? '') + ' ' + String(d.versionId ?? '')
              : check.id === 'no-active-transfer' ? t('{count} active', { count: String(d.active ?? '') })
                : String(d.current ?? '') + ' → ' + String(d.target ?? '')
      })
    }
    const failure = (error: unknown): { state: string; message: string } => {
      const problem = error as { status?: number; details?: { reasons?: unknown; reason?: unknown } }
      const list = Array.isArray(problem?.details?.reasons) ? (problem.details!.reasons as unknown[]).filter((item): item is string => typeof item === 'string') : typeof problem?.details?.reason === 'string' ? [problem.details.reason] : []
      if (problem?.status === 409) return { state: 'stale', message: t('Host observations changed. They were read again; review them before continuing.') }
      return { state: 'failed', message: (list.length ? reasons(list) : t('The request was refused or the host could not be reached. Nothing is assumed to have changed.')) + (problem?.status ? ' (' + problem.status + ')' : '') }
    }
    const poll = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        timer = null
        if (!root.isConnected || !send || polls++ > 360) return
        try {
          const status = readUpgradeStatusView(await send('GET', '/api/server/upgrade/status'))
          paintHistory(status.history); paintProgress(status.lock, status.latest, status.retirementPending)
          if (inFlight(status.latest) || status.lock.present === true) poll(); else void load()
        } catch { say(progress, 'running', t('Waiting for the panel to answer while the upgrade restarts its services…')); poll() }
      }, 5000)
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !send) return
      busy = true; controls(); say(banner, 'reading', t('Reading release state from this server…'))
      const [observed, status] = await Promise.allSettled([send('GET', '/api/server/upgrade').then(readUpgradeObservationView), send('GET', '/api/server/upgrade/status').then(readUpgradeStatusView)])
      busy = false
      if (!admitted()) { controls(); return }
      if (observed.status === 'fulfilled') paintObservation(observed.value); else say(banner, 'failed', failure(observed.reason).message)
      if (status.status === 'fulfilled') { paintHistory(status.value.history); paintProgress(status.value.lock, status.value.latest, status.value.retirementPending); if (inFlight(status.value.latest) || status.value.lock.present === true) poll() }
      controls()
    }
    const preflight = async (): Promise<void> => {
      if (busy || !admitted() || !send || !observation || !select.value) return
      const body = { targetVersion: select.value, expectedRevision: observation.revision }
      busy = true; checked = null; confirm.open = false; controls(); say(summary, 'reading', t('Running preflight on observed host values…'))
      try {
        checked = readUpgradePreflightView(await send('POST', '/api/server/upgrade/preflight', body))
        paintChecks(checked)
        const passed = checked.report.checks.filter(check => check.ok).length
        say(summary, checked.report.ok ? 'read' : 'failed', t('{passed} of {total} passed · {time} UTC', { passed, total: checked.report.checks.length, time: checked.observedAt.slice(11, 16) }) + (checked.report.ok && !checked.start.enabled ? '. ' + reasons(checked.start.reasons.filter(code => code !== 'preflight-failed')) : ''))
      } catch (error) {
        const problem = failure(error); say(summary, problem.state, problem.message); paintChecks(null)
        if (problem.state === 'stale') { busy = false; await load(); return }
      }
      busy = false; controls()
    }
    const start = async (): Promise<void> => {
      if (busy || !admitted() || !send || !observation || !ready() || phrase.value !== 'upgrade ' + select.value) return
      const body = { targetVersion: select.value, expectedRevision: observation.revision, confirm: phrase.value }
      busy = true; controls(); say(note, 'reading', t('Handing the verified release to the upgrade coordinator…'))
      try {
        const accepted = readUpgradeStartView(await send('POST', '/api/server/upgrade/start', body))
        say(note, 'accepted', t('Upgrade to {version} was handed off. The upgrade machine records each phase below; sign-in pauses while services restart.', { version: accepted.targetVersion }))
        checked = null; confirm.open = false; phrase.value = ''; polls = 0; poll()
      } catch (error) {
        const problem = failure(error); say(note, problem.state, problem.message)
        if (problem.state === 'stale') { checked = null; busy = false; await load(); return }
      }
      busy = false; controls()
    }
    if (!send || !admitted()) { say(banner, 'unavailable', t('The upgrade workspace is unavailable here. Nothing was read or changed.')); controls(); return }
    select.addEventListener('change', () => { checked = null; paintChecks(null); confirm.open = false; paintTarget(); controls() })
    confirm.addEventListener('toggle', () => { if (confirm.open && !ready()) confirm.open = false; controls() })
    phrase.addEventListener('input', controls)
    buttons.refresh!.addEventListener('click', () => { void load() })
    buttons.preflight!.addEventListener('click', () => { void preflight() })
    buttons.open!.addEventListener('click', () => { if (ready()) { confirm.open = true; controls(); phrase.focus() } })
    buttons.cancel!.addEventListener('click', () => { confirm.open = false; phrase.value = ''; controls() })
    buttons.start!.addEventListener('click', () => { void start() })
    void load()
  })
}

export const WHM_UPGRADE_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const createUpgradeParsers=${createUpgradeParsers.toString()};const parsers=createUpgradeParsers();const readUpgradeObservationView=parsers.observation;const readUpgradePreflightView=parsers.preflight;const readUpgradeStartView=parsers.start;const readUpgradeStatusView=parsers.status;return ${bindWhmUpgrade.toString()};})()`
