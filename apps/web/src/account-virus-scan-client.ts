/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const displayDateTime = formatDisplayDateTime
const VSCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VSCAN_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
export type AccountScanResult = 'pending' | 'clean' | 'infected' | 'error' | 'cancelled' | 'unknown'
export interface AccountScanEntry {
  jobId: string; status: string; result: AccountScanResult; createdAt: string; finishedAt: string | null; scannedFiles: number | null; infectedFiles: number | null
  infected: { path: string; signature: string }[]; listComplete: boolean
}
export interface AccountVirusScanClientView {
  observedAt: string; engine: { state: 'read' | 'not_installed' | 'unavailable'; version: string | null; signatureVersion: number | null; signatureDate: string | null }
  start: { allowed: boolean; reason: string | null; availableAt: string | null }; scans: AccountScanEntry[]; startedJobId: string | null
}
export function vscanObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const vscanInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const vscanText = (value: unknown, max = 64): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !VSCAN_UNSAFE.test(value)
const vscanTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
/** Pinned to the page account; infected paths must stay relative to the home. */
export function readAccountVirusScanView(value: unknown, accountId: string, started = false): AccountVirusScanClientView {
  if (!VSCAN_ID.test(accountId) || !vscanObject(value) || !vscanObject(value.context) || value.context.accountId !== accountId || !vscanObject(value.engine) || !vscanObject(value.start) || !vscanObject(value.limits) || !Array.isArray(value.scans) || value.scans.length > 10) throw new Error('invalid_vscan_scope')
  const { engine, start, limits } = value
  if (!vscanTime(value.observedAt) || !['read', 'not_installed', 'unavailable'].includes(engine.state as string) || ![engine.version, engine.signatureDate].every(item => item === null || vscanText(item)) || !(engine.signatureVersion === null || vscanInt(engine.signatureVersion))
    || limits.history !== 10 || limits.cooldownMinutes !== 15 || limits.findingsPerScan !== 50 || typeof start.allowed !== 'boolean' || ![null, 'engine_unavailable', 'jobs_unavailable', 'scan_active', 'cooldown'].includes(start.reason as string | null)
    || start.allowed !== (start.reason === null) || (start.reason === 'cooldown' ? !vscanTime(start.availableAt) : start.availableAt !== null)) throw new Error('invalid_vscan_state')
  const scans = value.scans.map((raw): AccountScanEntry => {
    if (!vscanObject(raw) || typeof raw.jobId !== 'string' || !VSCAN_ID.test(raw.jobId) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(raw.status as string) || !['pending', 'clean', 'infected', 'error', 'cancelled', 'unknown'].includes(raw.result as string)
      || !vscanTime(raw.createdAt) || !(raw.finishedAt === null || vscanTime(raw.finishedAt)) || typeof raw.listComplete !== 'boolean' || !Array.isArray(raw.infected) || raw.infected.length > 50 || !(raw.summary === null || vscanObject(raw.summary) && vscanInt(raw.summary.infectedFiles) && (raw.summary.scannedFiles === null || vscanInt(raw.summary.scannedFiles)))) throw new Error('invalid_vscan_scan')
    const infected = raw.infected.map(item => {
      if (!vscanObject(item) || !vscanText(item.path, 1024) || !(item.path === '.' || !item.path.startsWith('/') && item.path.split('/').every(part => part !== '' && part !== '.' && part !== '..')) || typeof item.signature !== 'string' || !/^[A-Za-z0-9._:{}+-]{1,160}$/.test(item.signature)) throw new Error('invalid_vscan_finding')
      return { path: item.path, signature: item.signature }
    })
    const summary = raw.summary as Record<string, unknown> | null
    return { jobId: raw.jobId, status: raw.status as string, result: raw.result as AccountScanResult, createdAt: raw.createdAt, finishedAt: raw.finishedAt as string | null, scannedFiles: (summary?.scannedFiles as number | null | undefined) ?? null, infectedFiles: (summary?.infectedFiles as number | undefined) ?? null, infected, listComplete: raw.listComplete }
  })
  const startedJobId = vscanObject(value.started) && typeof value.started.jobId === 'string' && VSCAN_ID.test(value.started.jobId) ? value.started.jobId : null
  if (started ? !startedJobId || !scans.some(scan => scan.jobId === startedJobId) : value.started !== null) throw new Error('invalid_vscan_start')
  return { observedAt: value.observedAt, engine: { state: engine.state as 'read', version: engine.version as string | null, signatureVersion: engine.signatureVersion as number | null, signatureDate: engine.signatureDate as string | null },
    start: { allowed: start.allowed, reason: start.reason as string | null, availableAt: start.availableAt as string | null }, scans, startedJobId }
}
export function vscanUncertain(error: unknown): boolean {
  const value = vscanObject(error) ? error : {}, details = vscanObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true)) return true
  if ([value, details].some(part => part.stateChanged === false)) return false
  return typeof value.status !== 'number' || value.status >= 500
}

function bindAccountVirusScan(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const PATH = '/api/account/virus-scan'
  document.querySelectorAll<HTMLElement>('[data-account-virus-scan]').forEach(root => {
    if (root.dataset.vscanBound === 'true') return
    root.dataset.vscanBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.vscanManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-vscan-' + key + ']')!
    const start = find<HTMLButtonElement>('start'), refreshButton = find<HTMLButtonElement>('refresh'), rows = find('rows'), status = find('status')
    const facts = { engine: find('engine'), version: find('version'), signatures: find('signatures'), date: find('signature-date'), next: find('next') }
    if (!start || !refreshButton || !rows || !status || Object.values(facts).some(item => !item)) return
    let view: AccountVirusScanClientView | null = null, busy = false, review = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'refused'].includes(state) ? 'alert' : 'status') }
    const instant = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = displayDateTime(value); return bdi }
    const lock = (): void => { start.disabled = !eligible() || busy || review || !view?.start.allowed; refreshButton.disabled = !eligible() || busy; root.setAttribute('aria-busy', String(busy)) }
    let templates: { row: HTMLTemplateElement; detail: HTMLTemplateElement; file: HTMLTemplateElement; empty: HTMLTemplateElement }
    try {
      templates = { row: clientTemplate(root, 'virus-scan-row'), detail: clientTemplate(root, 'virus-scan-detail'), file: clientTemplate(root, 'virus-scan-file'), empty: clientTemplate(root, 'virus-scan-empty') }
      cloneClientTemplate(templates.row, 'tr', ['started', 'status', 'result', 'scanned', 'infected'])
      cloneClientTemplate(templates.detail, 'tr', ['files', 'notice'])
      cloneClientTemplate(templates.file, 'li', ['path', 'signature'])
      cloneClientTemplate(templates.empty, 'tr', ['message'])
    } catch {
      start.disabled = true; refreshButton.disabled = true
      note('unavailable', t('The scanner has not been read.')); return
    }
    const message = (value: string): void => { const row = cloneClientTemplate(templates.empty, 'tr', ['message']); clientTemplateSlot(row, 'message', 'td').textContent = value; rows.append(row) }
    const paint = (next: AccountVirusScanClientView): void => {
      const engine = next.engine
      facts.engine.textContent = engine.state === 'read' ? t('Available') : engine.state === 'not_installed' ? t('Not installed on this server') : t('Unavailable')
      facts.version.textContent = engine.version ?? '-'; facts.signatures.textContent = engine.signatureVersion === null ? '-' : String(engine.signatureVersion); facts.date.textContent = engine.signatureDate ?? '-'
      const reason = next.start.reason
      facts.next.textContent = reason === null ? t('Available now') : reason === 'scan_active' ? t('After the current scan finishes') : reason === 'cooldown' ? ''
        : reason === 'engine_unavailable' ? t('Unavailable: ClamAV cannot be used on this server') : t('Unavailable: background jobs are not running')
      if (reason === 'cooldown') { const [before = '', after = ''] = t('After {time}').split('{time}'); facts.next.replaceChildren(before, instant(next.start.availableAt!), after) }
      const latest = [...next.scans].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      const finished = [...next.scans].filter(scan => scan.status === 'succeeded' || scan.status === 'failed' || scan.status === 'cancelled').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      for (const [key, value] of [['last-scan', latest ? displayDateTime(latest.createdAt) : '—'], ['infected', finished?.infectedFiles === null || finished?.infectedFiles === undefined ? '—' : String(finished.infectedFiles)], ['signatures', engine.signatureVersion === null ? '—' : String(engine.signatureVersion)], ['next-scan', facts.next.textContent ?? '—']] as const) {
        const node = root.querySelector<HTMLElement>(`[data-vscan-kpi="${key}"]`); if (node) node.textContent = value
      }
      rows.textContent = ''
      const statuses: Record<string, string> = { queued: t(msgctxt('account-virus-scan-client', 'Queued')), running: t('Running'), succeeded: t('Finished'), failed: t('Failed'), cancelled: t('Cancelled') }
      const results: Record<AccountScanResult, [string, string | undefined]> = { pending: [t('Pending'), undefined], clean: [t(msgctxt('account-virus-scan-client', 'Clean')), 'ok'], infected: [t('Infected files found'), 'problem'], error: [t('Scan error'), 'unavailable'], cancelled: [t('Cancelled'), undefined], unknown: [t('Outcome unknown'), 'unavailable'] }
      for (const scan of next.scans) {
        const row = cloneClientTemplate(templates.row, 'tr', ['started', 'status', 'result', 'scanned', 'infected']); row.dataset.state = scan.result
        const started = clientTemplateSlot(row, 'started', 'time'); started.setAttribute('datetime', scan.createdAt); started.textContent = displayDateTime(scan.createdAt)
        clientTemplateSlot(row, 'status').textContent = statuses[scan.status] ?? scan.status
        const result = clientTemplateSlot(row, 'result'); result.textContent = results[scan.result][0]
        if (results[scan.result][1]) result.dataset.stateChip = results[scan.result][1]
        clientTemplateSlot(row, 'scanned').textContent = scan.scannedFiles === null ? '-' : String(scan.scannedFiles)
        clientTemplateSlot(row, 'infected').textContent = scan.infectedFiles === null ? '-' : String(scan.infectedFiles); rows.append(row)
        if (!scan.infected.length && (scan.result !== 'infected' || scan.listComplete)) continue
        const detail = cloneClientTemplate(templates.detail, 'tr', ['files', 'notice']), list = clientTemplateSlot(detail, 'files', 'ul')
        list.setAttribute('aria-label', t('Infected files'))
        for (const item of scan.infected) {
          const li = cloneClientTemplate(templates.file, 'li', ['path', 'signature'])
          clientTemplateSlot(li, 'path').textContent = item.path === '.' ? '~' : '~/' + item.path
          clientTemplateSlot(li, 'signature').textContent = item.signature; list.append(li)
        }
        const notice = clientTemplateSlot(detail, 'notice'); notice.hidden = scan.listComplete; notice.textContent = scan.listComplete ? '' : t('This list may be incomplete.')
        rows.append(detail)
      }
      if (!next.scans.length) message(t('No scans have been started for this account.'))
    }
    async function refresh(): Promise<void> {
      if (!eligible() || busy || !send) return
      busy = true; lock(); note('reading', t('Reading the scanner…'))
      try { view = readAccountVirusScanView(await send('GET', PATH), accountId); review = false; paint(view); const [before = '', after = ''] = t(msgctxt('account-virus-scan-client', 'Read at {time}.')).split('{time}'); note('read', before); status.append(instant(view.observedAt), after) }
      catch { note('failed', t('The scanner could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function startScan(): Promise<void> {
      if (!eligible() || busy || review || !send || !view?.start.allowed) return
      busy = true; lock(); note('starting', t('Starting the scan…'))
      try { view = readAccountVirusScanView(await send('POST', PATH, {}), accountId, true); paint(view); note('started', t('The scan is queued. Refresh to follow it.')) }
      catch (error) {
        review = vscanUncertain(error)
        note(review ? 'uncertain' : 'refused', review ? t('The scan start could not be confirmed. No retry was sent. Refresh before starting again.') : t('The scan was not started. Refresh to see when the next scan is available.'))
      } finally { busy = false; lock() }
    }
    if (!send || !eligible() || !VSCAN_ID.test(accountId)) {
      for (const control of root.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true
      note('unavailable', t('The virus scanner is unavailable here. Nothing was read or started.')); return
    }
    start.addEventListener('click', () => { void startScan() })
    refreshButton.addEventListener('click', () => { void refresh() })
    lock(); void refresh()
  })
}

export const ACCOUNT_VIRUS_SCAN_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};const VSCAN_ID=${VSCAN_ID.toString()};const VSCAN_UNSAFE=${VSCAN_UNSAFE.toString()};const vscanObject=${vscanObject.toString()};const vscanInt=${vscanInt.toString()};const vscanText=${vscanText.toString()};const vscanTime=${vscanTime.toString()};const readAccountVirusScanView=${readAccountVirusScanView.toString()};const vscanUncertain=${vscanUncertain.toString()};return ${bindAccountVirusScan.toString()};})()`
