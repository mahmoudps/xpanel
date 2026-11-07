/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import type { LogSecurityReport } from '../../agent/src/log-security-analysis.ts'
import type { DatabaseErrorEntry, DatabaseLogView, SlowQueryEntry } from '../../agent/src/database-logs.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export function readLogAnalysis(raw: unknown): LogSecurityReport {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  const text = (v: unknown): boolean => typeof v === 'string' && v.length <= 512
  const bad = (): never => { throw new Error('invalid_log_analysis') }
  if (!object(raw) || !text(raw.site) || !text(raw.observedAt) || !object(raw.scan) || !Array.isArray(raw.findings) || !Array.isArray(raw.topClients)) return bad()
  if (['sizeBytes', 'scannedBytes', 'requests', 'unparsed', 'flagged'].some(key => !count((raw.scan as Record<string, unknown>)[key])) || typeof raw.scan.complete !== 'boolean' || typeof raw.scan.fileExists !== 'boolean') return bad()
  for (const finding of raw.findings) {
    if (!object(finding) || !text(finding.type) || !count(finding.count) || !count(finding.clients) || !Array.isArray(finding.samples)) return bad()
    for (const sample of finding.samples) if (!object(sample) || !text(sample.time) || !text(sample.ip) || !text(sample.method) || !text(sample.uri) || !count(sample.status)) return bad()
  }
  for (const client of raw.topClients) if (!object(client) || !text(client.ip) || !count(client.requests)) return bad()
  return raw as unknown as LogSecurityReport
}

export function readDatabaseLogView(raw: unknown, log: string): DatabaseLogView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const optional = (v: unknown): boolean => v === null || typeof v === 'string'
  const bad = (): never => { throw new Error('invalid_database_log') }
  if (!object(raw) || raw.log !== log || (raw.state !== 'read' && raw.state !== 'unavailable') || !optional(raw.reason) || !optional(raw.path) || !optional(raw.source) || typeof raw.truncated !== 'boolean' || !Array.isArray(raw.entries)) return bad()
  if (raw.recording !== null && (!object(raw.recording) || typeof raw.recording.slowQueryLog !== 'boolean' || typeof raw.recording.longQueryTime !== 'number')) return bad()
  for (const entry of raw.entries) if (!object(entry) || !optional(entry.at) || (log === 'slow' ? typeof entry.sql !== 'string' || typeof entry.queryTime !== 'number' : typeof entry.message !== 'string')) return bad()
  return raw as unknown as DatabaseLogView
}

function bindWhmLogTools(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const bytes = (value: number): string => { const units = ['B', 'KiB', 'MiB', 'GiB']; let size = value, index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return (index ? size.toFixed(1) : String(size)) + ' ' + units[index] }
  document.querySelectorAll<HTMLElement>('[data-whm-log-tools]').forEach(root => {
    if (root.dataset.logToolsBound === 'true') return
    root.dataset.logToolsBound = 'true'
    const one = <T extends HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const site = one<HTMLSelectElement>('[data-log-analysis-site]'), run = one<HTMLButtonElement>('[data-log-analysis-run]'), analysisStatus = one('[data-log-analysis-status]'), findings = one('[data-log-analysis-rows]'), samples = one('[data-log-analysis-samples]')
    const kind = one<HTMLSelectElement>('[data-database-log-kind]'), read = one<HTMLButtonElement>('[data-database-log-read]'), databaseStatus = one('[data-database-log-status]'), slow = one('[data-database-log-rows="slow"]'), errors = one('[data-database-log-rows="error"]')
    const domain = one<HTMLSelectElement>('[data-raw-ftp-domain]'), hours = one<HTMLSelectElement>('[data-raw-ftp-hours]'), download = one<HTMLButtonElement>('[data-raw-ftp-download]'), ftpStatus = one('[data-raw-ftp-status]')
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select')]
    const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    if (!send || root.dataset.logToolsCanRead !== 'true' || !site || !run || !findings || !samples || !kind || !read || !slow || !errors || !domain || !hours || !download || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      for (const node of [analysisStatus, databaseStatus, ftpStatus]) say(node, 'unavailable', t('Log tools are unavailable here. Nothing was read.'))
      return
    }
    const cell = (value: string, technical = false, numeric = false): HTMLTableCellElement => { const td = document.createElement('td'); if (numeric) td.dataset.numeric = 'true'; if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) } else td.textContent = value; return td }
    const fill = (target: HTMLElement, rows: readonly HTMLTableCellElement[][], empty: string): void => {
      target.replaceChildren()
      if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = target.closest('table')?.querySelectorAll('thead th').length ?? 1; td.textContent = empty; row.append(td); target.append(row); return }
      for (const cells of rows) { const row = document.createElement('tr'); row.append(...cells); target.append(row) }
    }
    const fact = (name: string, value: string): void => { const node = root.querySelector<HTMLElement>(`[data-log-tools-fact="${name}"]`); if (node) node.textContent = value }
    const FINDING_LABELS: Record<string, string> = { 'sql-injection': t('SQL injection'), 'cross-site-scripting': t('Cross-site scripting'), 'path-traversal': t('Path traversal'), 'remote-file-inclusion': t('File inclusion'), 'command-injection': t('Command injection'), 'webshell-probe': t('Webshell or sensitive file probe'), 'vulnerability-scanner': t('Vulnerability scanner') }
    const analyse = async (): Promise<void> => {
      if (!site.value) return
      run.disabled = true; say(analysisStatus, 'reading', t('Scanning the access log…'))
      try {
        const report = readLogAnalysis(await send('GET', '/api/server/logs/security-analysis?domainId=' + encodeURIComponent(site.value)))
        fact('requests', String(report.scan.requests)); fact('flagged', String(report.scan.flagged)); fact('scanned', bytes(report.scan.scannedBytes)); fact('observed', formatDisplayDateTime(report.observedAt))
        fill(findings, report.findings.map(finding => [cell(FINDING_LABELS[finding.type] ?? finding.type), cell(String(finding.count), false, true), cell(String(finding.clients), false, true)]), t('No attack patterns were found in the part of the log that was scanned.'))
        fill(samples, report.findings.flatMap(finding => finding.samples.map(sample => [cell(FINDING_LABELS[finding.type] ?? finding.type), cell(sample.time, true), cell(sample.ip, true), cell(sample.method + ' ' + sample.uri, true), cell(String(sample.status), true, true)])), t('No sample requests.'))
        say(analysisStatus, 'read', !report.scan.fileExists ? t('This site has no access log yet, so nothing was scanned.') : report.scan.complete ? t('The whole current access log was scanned.') : t('Only the latest {size} of {total} were scanned.', { size: bytes(report.scan.scannedBytes), total: bytes(report.scan.sizeBytes) }))
      } catch { say(analysisStatus, 'failed', t('The access log could not be scanned. Nothing was changed.')) }
      finally { run.disabled = false }
    }
    const REASONS: Record<string, string> = { mariadb_unavailable: t('MariaDB could not be reached.'), slow_log_not_in_a_file: t('MariaDB records slow queries in a table, not a file.'), journal_unavailable: t('The service journal could not be read.'), log_path_not_reviewed: t('MariaDB reports a log path outside its log and data directories, so it was not opened.'), log_unreadable: t('The log file could not be opened safely.') }
    const readDatabase = async (): Promise<void> => {
      const log = kind.value === 'error' ? 'error' : 'slow'
      read.disabled = true; say(databaseStatus, 'reading', t('Reading the database log…'))
      for (const panel of root.querySelectorAll<HTMLElement>('[data-database-log-panel]')) panel.hidden = panel.dataset.databaseLogPanel !== log
      try {
        const view = readDatabaseLogView(await send('GET', '/api/server/logs/database?log=' + log), log)
        fact('recording', view.recording === null ? t('Not read') : view.recording.slowQueryLog ? t('On') : t('Off'))
        fact('threshold', view.recording === null ? t('Not read') : t('{seconds} s', { seconds: view.recording.longQueryTime }))
        fact('source', view.source === 'journal' ? t('Service journal') : view.path ?? t('Not read'))
        if (log === 'slow') fill(slow, (view.entries as SlowQueryEntry[]).map(entry => [cell(entry.at ? formatDisplayDateTime(entry.at) : t('Unknown'), true), cell(entry.queryTime.toFixed(3), true, true), cell(entry.user, true), cell(entry.schema ?? '', true), cell(String(entry.rowsExamined), true, true), cell(entry.sql, true)]), t('No slow queries are recorded.'))
        else fill(errors, (view.entries as DatabaseErrorEntry[]).map(entry => [cell(entry.at ?? t('Unknown'), true), cell(entry.level === 'error' ? t('Error') : entry.level === 'warning' ? t('Warning') : entry.level === 'note' ? t('Note') : ''), cell(entry.message, true)]), t('The error log has no entries.'))
        if (view.state !== 'read') say(databaseStatus, 'unavailable', REASONS[view.reason ?? ''] ?? t('The database log could not be read.'))
        else if (log === 'slow' && view.recording?.slowQueryLog === false) say(databaseStatus, 'read', t('Slow query recording is off. Turn it on in Tweak Settings under SQL. Past entries stay listed.'))
        else say(databaseStatus, 'read', view.truncated ? t('The latest entries are shown; older ones are in the file on the server.') : t('Database log read.'))
      } catch { say(databaseStatus, 'failed', t('The database log could not be read. Nothing was changed.')) }
      finally { read.disabled = false }
    }
    const fetchRaw = async (): Promise<void> => {
      if (!domain.value) return
      download.disabled = true; say(ftpStatus, 'reading', t('Preparing the download…'))
      try {
        const response = await fetch('/api/server/ftp-log/raw?' + new URLSearchParams({ domain: domain.value, hours: hours.value }).toString(), { credentials: 'same-origin' })
        if (!response.ok) { const problem = await response.json().catch(() => null) as { code?: unknown } | null; say(ftpStatus, 'failed', problem?.code === 'SERVICE_DISABLED' ? t('The FTP service is disabled on this server.') : t('The FTP log could not be read. Nothing was changed.')); return }
        const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a')
        link.href = url; link.download = domain.value + '.ftp.log.gz'; root.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
        say(ftpStatus, 'read', t('The download has started.'))
      } catch { say(ftpStatus, 'failed', t('The FTP log could not be read. Nothing was changed.')) }
      finally { download.disabled = false }
    }
    run.addEventListener('click', () => { void analyse() }); read.addEventListener('click', () => { void readDatabase() }); download.addEventListener('click', () => { void fetchRaw() })
    run.disabled = true; download.disabled = true
    void (async () => {
      try {
        const raw = await send('GET', '/api/domains') as { domains?: { id?: unknown; name?: unknown }[] }
        const domains = (Array.isArray(raw?.domains) ? raw.domains : []).filter((item): item is { id: string; name: string } => typeof item.id === 'string' && typeof item.name === 'string').sort((a, b) => a.name < b.name ? -1 : 1)
        for (const item of domains) { site.append(new Option(item.name, item.id)); domain.append(new Option(item.name, item.name)) }
        run.disabled = domain.disabled = site.disabled = !domains.length; download.disabled = !domains.length
        if (!domains.length) { say(analysisStatus, 'unavailable', t('No sites exist yet.')); say(ftpStatus, 'unavailable', t('No sites exist yet.')) }
      } catch { say(analysisStatus, 'failed', t('The site list could not be read.')); say(ftpStatus, 'failed', t('The site list could not be read.')) }
    })()
  })
}

export const WHM_LOG_TOOLS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readLogAnalysis=${readLogAnalysis.toString()};const readDatabaseLogView=${readDatabaseLogView.toString()};return ${bindWhmLogTools.toString()}})()`
