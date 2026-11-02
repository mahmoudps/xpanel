/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { WHM_DIAGNOSTIC_TEMPLATE_BINDING, whmDiagnosticNode as canonicalDiagnosticNode, assertWhmDiagnosticTemplates as canonicalAssertDiagnosticTemplates } from './whm-diagnostic-client-templates.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const whmDiagnosticNode = canonicalDiagnosticNode
const assertWhmDiagnosticTemplates = canonicalAssertDiagnosticTemplates
export type RepairDiagnosticView = {
  id: string
  area: 'packages' | 'services' | 'configuration'
  state: 'ok' | 'problem' | 'unavailable'
  /** English source message or msgctxt key, translated with xpT. */
  cause: string
  evidence: string
  repair: { id: string; available: boolean; reason?: string; kind: 'job' | 'existing-workflow'; href?: string }
}
export type RepairReportView = { observedAt: string; family: 'debian' | 'rhel'; revision: string; diagnostics: RepairDiagnosticView[] }
export type RepairPreviewView = {
  repairId: 'dpkg-configure' | 'apt-fix-broken' | 'dnf-cache-refresh' | 'rpmdb-rebuild'
  source: 'apt-simulation' | 'dpkg-audit' | 'dnf-cache-only' | 'rpm-database'
  state: 'ready' | 'unavailable'
  reason?: string
  install: string[]
  remove: string[]
  configure: string[]
  removalFingerprint: string
  evidence: string
}
export type RepairJobAckView = { revision: string; jobId: string; referenceCode: string | null; kind: string; status: string }

export function readRepairReport(value: unknown): RepairReportView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number, multiline = false): item is string => typeof item === 'string' && item.length <= max && item.isWellFormed() && !(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/ : /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/).test(item)
  if (!object(value) || typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || !['debian', 'rhel'].includes(String(value.family)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !Array.isArray(value.diagnostics) || value.diagnostics.length > 32) throw new Error('invalid_repair_report')
  const seen = new Set<string>()
  const diagnostics = value.diagnostics.map(raw => {
    if (!object(raw) || typeof raw.id !== 'string' || !/^(?:dpkg-interrupted|apt-broken-dependencies|dnf-package-problems|rpm-database-integrity|dnf-metadata-cache|configuration-drift|service-config:[a-z][a-z0-9-]{0,31})$/.test(raw.id) || seen.has(raw.id)
      || !['packages', 'services', 'configuration'].includes(String(raw.area)) || !['ok', 'problem', 'unavailable'].includes(String(raw.state))
      || typeof raw.cause !== 'string' || !raw.cause || !text(raw.cause.replace(/^[a-z][a-z0-9-]{0,63}\u0004/, ''), 600) || !text(raw.evidence, 8192, true) || !object(raw.repair)) throw new Error('invalid_repair_diagnostic')
    seen.add(raw.id)
    const repair = raw.repair
    const job = repair.kind === 'job', workflow = repair.kind === 'existing-workflow'
    if (!(job ? ['dpkg-configure', 'apt-fix-broken', 'dnf-repair', 'dnf-cache-refresh', 'rpmdb-rebuild'] : ['configuration-generations']).includes(String(repair.id)) || !job && !workflow || typeof repair.available !== 'boolean'
      || repair.reason !== undefined && (typeof repair.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(repair.reason))
      || (workflow ? repair.href !== '/whm/services/web' : repair.href !== undefined) || raw.state !== 'problem' && repair.available) throw new Error('invalid_repair_action')
    if (repair.id === 'dnf-cache-refresh' && (value.family !== 'rhel' || raw.id !== 'dnf-metadata-cache') || repair.id === 'rpmdb-rebuild' && (value.family !== 'rhel' || raw.id !== 'rpm-database-integrity') || ['rpm-database-integrity', 'dnf-metadata-cache'].includes(raw.id) && value.family !== 'rhel') throw new Error('invalid_repair_action')
    return {
      id: raw.id, area: raw.area as RepairDiagnosticView['area'], state: raw.state as RepairDiagnosticView['state'], cause: raw.cause as string, evidence: raw.evidence as string,
      repair: { id: String(repair.id), available: repair.available, kind: repair.kind as 'job' | 'existing-workflow', ...(typeof repair.reason === 'string' ? { reason: repair.reason } : {}), ...(workflow ? { href: '/whm/services/web' } : {}) },
    }
  })
  return { observedAt: value.observedAt, family: value.family as 'debian' | 'rhel', revision: value.revision, diagnostics }
}

export function readRepairPreview(value: unknown, expectedRevision: string, repairId: string): RepairPreviewView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const names = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 2000 && new Set(item).size === item.length && item.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9+.:-]{0,160}$/.test(name))
  if (!object(value) || value.revision !== expectedRevision || !object(value.preview)) throw new Error('invalid_repair_preview')
  const preview = value.preview
  if (preview.repairId !== repairId || !['dpkg-configure', 'apt-fix-broken', 'dnf-cache-refresh', 'rpmdb-rebuild'].includes(String(preview.repairId)) || !['apt-simulation', 'dpkg-audit', 'dnf-cache-only', 'rpm-database'].includes(String(preview.source)) || !['ready', 'unavailable'].includes(String(preview.state))
    || preview.reason !== undefined && (typeof preview.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(preview.reason)) || !names(preview.install) || !names(preview.remove) || !names(preview.configure)
    || !object(preview.counts) || preview.counts.install !== preview.install.length || preview.counts.remove !== preview.remove.length || preview.counts.configure !== preview.configure.length
    || typeof preview.removalFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(preview.removalFingerprint) || typeof preview.evidence !== 'string' || preview.evidence.length > 8192 || !preview.evidence.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/.test(preview.evidence)
    || preview.state === 'unavailable' && (preview.install.length + preview.remove.length + preview.configure.length !== 0 || preview.reason === undefined)
    || preview.repairId === 'dpkg-configure' && (preview.install.length !== 0 || preview.remove.length !== 0)
    || preview.repairId === 'dnf-cache-refresh' && (preview.source !== 'dnf-cache-only' || preview.install.length + preview.remove.length + preview.configure.length !== 0)
    || preview.repairId !== 'dnf-cache-refresh' && preview.source === 'dnf-cache-only'
    || (preview.repairId === 'rpmdb-rebuild') !== (preview.source === 'rpm-database') || preview.repairId === 'rpmdb-rebuild' && preview.install.length + preview.remove.length + preview.configure.length !== 0) throw new Error('invalid_repair_preview')
  return { repairId: preview.repairId as RepairPreviewView['repairId'], source: preview.source as RepairPreviewView['source'], state: preview.state as RepairPreviewView['state'], ...(typeof preview.reason === 'string' ? { reason: preview.reason } : {}), install: preview.install, remove: preview.remove, configure: preview.configure, removalFingerprint: preview.removalFingerprint, evidence: preview.evidence }
}

export function readRepairJobAck(value: unknown, expectedRevision: string, repairId: string): RepairJobAckView {
  const reference = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(item) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) && item !== 'XP-JOB-000000'
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || value.revision !== expectedRevision || !object(value.job) || !reference(value.job.referenceCode) || typeof value.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.job.id)
    || value.job.kind !== 'system.repair.' + repairId || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.job.status))) throw new Error('invalid_repair_job')
  return { revision: value.revision, jobId: value.job.id, referenceCode: value.job.referenceCode, kind: value.job.kind, status: String(value.job.status) }
}

function bindWhmRepair(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-repair-workspace]').forEach(root => {
    if (root.dataset.repairBound === 'true') return
    root.dataset.repairBound = 'true'
    const find = <T extends HTMLElement>(name: string): T | null => root.querySelector<T>('[data-whm-repair-' + name + ']')
    const diagnose = find<HTMLButtonElement>('diagnose'), status = find('status'), listRoot = find('list'), previewPanel = find('preview'), start = find<HTMLButtonElement>('start'), cancel = find<HTMLButtonElement>('cancel')
    const jobPanel = find('job'), jobStatus = find('job-status'), jobLink = find<HTMLAnchorElement>('job-link'), rerun = find<HTMLButtonElement>('rerun')
    if (!diagnose || !status || !listRoot || !previewPanel || !start || !cancel || !jobPanel || !jobStatus || !jobLink || !rerun) return
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.repairCanRead === 'true' && !root.closest(denied)
    const repairable = (): boolean => admitted() && root.dataset.repairCanRepair === 'true'
    let busy = false, report: RepairReportView | null = null, preview: RepairPreviewView | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const titles: Record<string, string> = {
      'dpkg-interrupted': msgid('Interrupted package configuration'), 'apt-broken-dependencies': msgid('Broken package dependencies'),
      'dnf-package-problems': msgid('Package database problems'), 'configuration-drift': msgid('Configuration drift'),
      'rpm-database-integrity': msgid('RPM database integrity'), 'dnf-metadata-cache': msgid('Repository metadata cache'),
    }
    const reasons: Record<string, string> = {
      no_problem: msgid('No repair is needed.'),
      diagnostic_unavailable: msgid('Repair is unavailable until this check can be read.'),
      package_database_locked: msgid('Repair is unavailable while another process holds the package lock.'),
      blocked_by_dpkg: msgid('Complete the interrupted package configuration first.'),
      reinstall_required: msgid('These packages need reinstallation; no reviewed automatic repair covers this state.'),
      rhel_repair_not_reviewed: msgid('No reviewed automatic repair exists for this platform yet. Review the evidence and repair manually.'),
      cache_recovery_unavailable: msgid('Metadata refresh requires a qualified cache snapshot and recovery provider. It is unavailable here.'),
      rpm_recovery_unavailable: msgid('RPM database repair is unavailable. A metadata refresh cannot repair installed packages or rebuild the database.'),
      rpm_headers_unreadable: msgid('The installed package list cannot be read, so a rebuild could lose package records. Review the evidence and repair manually.'),
      unresolvable: msgid('APT cannot find a set of changes that corrects these dependencies.'),
      removals_require_acceptance: msgid('This repair removes packages. Preview it again and confirm the removal list.'),
    }
    const reasonText = (reason: string | undefined): string => { const known: string = reason && Object.hasOwn(reasons, reason) ? reasons[reason]! : msgid('This repair is unavailable.'); return t(known) }
    const lock = (): void => {
      diagnose.disabled = busy || !admitted(); rerun.disabled = busy || !admitted(); cancel.disabled = busy
      start.disabled = busy || !repairable() || !preview || preview.state !== 'ready' || !report
      root.querySelectorAll<HTMLButtonElement>('[data-whm-repair-preview-action]').forEach(button => { button.disabled = busy || !repairable() || !report })
      root.setAttribute('aria-busy', String(busy))
    }
    try { assertWhmDiagnosticTemplates(root) } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'failed'; status.textContent = t('The server response could not be verified. Nothing is assumed.'); return
    }
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, textValue?: string, templateName?: string): HTMLElementTagNameMap[K] => whmDiagnosticNode(root, tag, textValue, templateName)
    const technical = (value: string): HTMLElement => { const node = element('bdi', value); node.dir = 'ltr'; return node }
    const setFact = (name: string, value: string): void => { const node = find(name); if (node) node.textContent = value }
    const fillList = (name: string, items: readonly string[]): void => {
      const target = find(name + '-list'), group = find(name + '-group')
      if (target) { target.textContent = ''; for (const item of items) target.append(element('li', item)) }
      if (group) group.hidden = items.length === 0
    }
    const hidePreview = (): void => { preview = null; previewPanel.hidden = true; lock() }
    const paintReport = (value: RepairReportView): void => {
      report = value
      const count = (state: string): string => String(value.diagnostics.filter(item => item.state === state).length)
      setFact('count-problem', count('problem')); setFact('count-ok', count('ok')); setFact('count-unavailable', count('unavailable'))
      setFact('observed-at', formatDisplayDateTime(value.observedAt))
      listRoot.textContent = ''
      if (!value.diagnostics.length) listRoot.append(element('p', t('The host returned no diagnostics. Nothing is assumed healthy.'), 'note'))
      for (const item of value.diagnostics) {
        const card = element('article', undefined, 'repair-item'), header = element('header', undefined, 'repair-head'), heading = element('h3')
        card.dataset.whmRepairDiagnostic = item.id; card.dataset.state = item.state
        if (item.id.startsWith('service-config:')) { const [before = '', after = ''] = t('Service configuration test {service}').split('{service}'); heading.append(before, technical(item.id.slice('service-config:'.length)), after) }
        else { const title = titles[item.id]; heading.textContent = title ? t(title) : item.id }
        const badge = element('span', item.state === 'ok' ? t('No problem found') : item.state === 'problem' ? t('Problem found') : t('Not verified'), item.state === 'ok' ? 'badge-ok' : item.state === 'problem' ? 'badge-critical' : 'badge-warn')
        header.append(heading, badge); card.append(header, element('p', t(item.cause)))
        if (item.evidence) { const details = element('details'), pre = element('pre', item.evidence, 'evidence'); pre.dir = 'ltr'; pre.tabIndex = 0; details.append(element('summary', t('Evidence')), pre); card.append(details) }
        const actions = element('div', undefined, 'actions')
        if (item.repair.available && item.repair.kind === 'existing-workflow' && item.repair.href === '/whm/services/web') { const link = element('a', t('Review configuration generations'), 'link'); link.href = '/whm/services/web'; actions.append(link) }
        else if (item.repair.available && item.repair.kind === 'job' && (item.repair.id === 'dpkg-configure' || item.repair.id === 'apt-fix-broken' || item.repair.id === 'dnf-cache-refresh' || item.repair.id === 'rpmdb-rebuild')) {
          const repairId = item.repair.id
          if (root.dataset.repairCanRepair === 'true') { const button = element('button', t('Preview repair'), 'action'); button.type = 'button'; button.dataset.whmRepairPreviewAction = repairId; button.addEventListener('click', () => { if (!button.disabled) void requestPreview(repairId) }); actions.append(button) }
          else actions.append(element('p', t('Repairs are unavailable in this session.'), 'note'))
        } else if (item.state !== 'ok') actions.append(element('p', reasonText(item.repair.reason), 'note'))
        if (actions.childElementCount) card.append(actions)
        listRoot.append(card)
      }
      lock()
    }
    const failure = (error: unknown, fallback: string): void => {
      const problem = error && typeof error === 'object' ? error as { code?: unknown; details?: { stateChanged?: unknown; reason?: unknown } } : {}
      if (problem.code === 'CONFLICT') { note('stale', t('Host state changed since diagnostics ran. Run diagnostics again before repairing.')); hidePreview(); return }
      if (problem.details?.stateChanged === false) { note('failed', fallback + ' ' + reasonText(typeof problem.details.reason === 'string' ? problem.details.reason : undefined)); return }
      note('uncertain', t('The outcome is unknown. Review host jobs before retrying.'))
    }
    const runDiagnostics = async (): Promise<void> => {
      if (busy || !admitted() || !transport) return
      busy = true; hidePreview(); lock(); note('reading', t('Running read-only diagnostics on the host…'))
      try {
        const value = readRepairReport(await transport('GET', '/api/server/repair/diagnostics'))
        if (admitted()) { paintReport(value); const problems = value.diagnostics.filter(item => item.state === 'problem').length, unknown = value.diagnostics.filter(item => item.state === 'unavailable').length
          note(problems ? 'problem' : unknown ? 'partial' : 'read', problems ? t('Diagnostics found problems. Review each finding before repairing.') : unknown ? t('No problem was found, but some checks could not be verified.') : t('Diagnostics found no problems.')) }
      } catch (error) { failure(error, t('Diagnostics could not be read. Nothing was changed.')) }
      busy = false; lock()
    }
    const requestPreview = async (repairId: RepairPreviewView['repairId']): Promise<void> => {
      if (busy || !repairable() || !report || !transport) return
      const revision = report.revision
      busy = true; hidePreview(); lock(); note('reading', t('Previewing the repair without changing the host…'))
      try {
        const value = readRepairPreview(await transport('POST', '/api/server/repair/preview', { repairId, expectedRevision: revision }), revision, repairId)
        if (admitted() && report?.revision === revision) {
          preview = value
          const summary = find('preview-summary')
          if (summary) summary.textContent = value.state !== 'ready' ? reasonText(value.reason) : value.source === 'dnf-cache-only' ? t('Refresh repository metadata using a verified recovery snapshot. No installed package will be installed, removed or reconfigured.') : value.source === 'apt-simulation' ? t('APT simulated these changes. Nothing has been changed yet.') : t('Package configuration will be completed for these packages. Nothing has been changed yet.')
          setFact('preview-install', String(value.install.length)); setFact('preview-remove', String(value.remove.length)); setFact('preview-configure', String(value.configure.length))
          fillList('install', value.install); fillList('configure', value.configure); fillList('remove', value.remove)
          const removals = find('removals'), removalText = find('removals-text')
          if (removals) removals.hidden = value.remove.length === 0
          if (removalText) removalText.textContent = t('This repair removes packages ({count}). Removed packages stop working until they are reinstalled.', { count: String(value.remove.length) })
          const evidence = find('preview-evidence'); if (evidence) evidence.textContent = value.evidence
          start.textContent = value.remove.length ? t('Run repair and remove packages') : t('Run repair')
          start.dataset.severity = value.remove.length ? 'danger' : 'normal'
          previewPanel.hidden = false
          note(value.state === 'ready' ? 'previewed' : 'failed', value.state === 'ready' ? t('Preview ready. Review it before running the repair.') : reasonText(value.reason))
        }
      } catch (error) { failure(error, t('The repair could not be previewed. Nothing was changed.')) }
      busy = false; lock()
    }
    const startRepair = async (): Promise<void> => {
      if (busy || !repairable() || !report || !preview || preview.state !== 'ready' || !transport) return
      if (!askDialog) { note('failed', t('Confirmation is unavailable; no repair was started.')); return }
      const current = preview, revision = report.revision
      const command = current.repairId === 'dnf-cache-refresh' ? 'dnf clean metadata / makecache --refresh' : current.repairId === 'rpmdb-rebuild' ? 'rpmdb --rebuilddb' : current.repairId === 'dpkg-configure' ? 'dpkg --configure -a' : current.remove.length ? 'apt-get -f install' : 'apt-get -f install --no-remove'
      const body = (current.repairId === 'dnf-cache-refresh' ? t('Refresh repository metadata only. Existing cache is snapshotted and restored on an unverified result. Installed packages and RPM database repair are outside this action.') : current.repairId === 'rpmdb-rebuild' ? t('Rebuild the RPM database with {command}. The database is snapshotted first and restored unless the integrity check passes and exactly the same packages remain installed.', { command }) : t('Start a host job that runs {command}. Locally modified configuration files are kept. The repair is confirmed only when the re-run diagnostic passes.', { command }))
        + (current.remove.length ? ' ' + t('It will remove these packages: {packages}', { packages: current.remove.join(', ') }) : '')
      busy = true; lock()
      let confirmed = false
      try { confirmed = await askDialog({ title: t('Run this repair?'), body, danger: current.remove.length > 0, confirm: current.remove.length ? t('Remove packages and repair') : t('Run repair') }) === true } catch { confirmed = false }
      if (!confirmed || !admitted() || preview !== current || report?.revision !== revision) { busy = false; lock(); note('previewed', t('No repair was started.')); return }
      note('submitting', t('Submitting the repair job…'))
      try {
        const intent = { repairId: current.repairId, expectedRevision: revision, ...(current.remove.length ? { acceptRemovals: true, expectedRemovals: current.removalFingerprint } : {}) }
        const ack = readRepairJobAck(await transport('POST', '/api/server/repair/run', intent), revision, current.repairId)
        hidePreview(); report = null
        root.querySelectorAll<HTMLButtonElement>('[data-whm-repair-preview-action]').forEach(button => { button.disabled = true })
        jobLink.href = '/whm/jobs?job=' + encodeURIComponent(ack.jobId)
        jobStatus.textContent = ''
        const [before, after] = t('Repair job {reference} was submitted. It is confirmed only if its verification passes; re-run diagnostics after it finishes.').split('{reference}')
        jobStatus.append(before ?? '', ack.referenceCode === null ? t('Unnumbered') : technical(ack.referenceCode), after ?? '')
        jobPanel.hidden = false
        note('submitted', t('Repair job submitted. Follow it in Jobs.'))
      } catch (error) { failure(error, t('The repair was not started.')) }
      busy = false; lock()
    }
    if (!admitted()) { diagnose.disabled = true; rerun.disabled = true; start.disabled = true; note('unavailable', t('Repair diagnostics are unavailable here. Nothing was read or changed.')); return }
    diagnose.addEventListener('click', () => { void runDiagnostics() })
    rerun.addEventListener('click', () => { jobPanel.hidden = true; void runDiagnostics() })
    cancel.addEventListener('click', () => { if (!busy) { hidePreview(); note('read', t('Preview closed. No repair was started.')) } })
    start.addEventListener('click', () => { if (!start.disabled) void startRepair() })
    lock()
  })
}

export const WHM_REPAIR_CLIENT_BINDING = `(()=>{${WHM_DIAGNOSTIC_TEMPLATE_BINDING};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readRepairReport=${readRepairReport.toString()};const readRepairPreview=${readRepairPreview.toString()};const readRepairJobAck=${readRepairJobAck.toString()};return ${bindWhmRepair.toString()};})()`
