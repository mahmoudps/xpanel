/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
export type IntrusionJailView = { name: string; state: 'read' | 'unavailable'; currentlyFailed: number | null; totalFailed: number | null; currentlyBanned: number | null; totalBanned: number | null; banned: string[]; truncated: boolean }
export type IntrusionView = { state: 'read' | 'not_installed' | 'unavailable'; observedAt: string; reason: string | null; jails: IntrusionJailView[]; unsupportedJails: number; jailsTruncated: boolean }
export type AntivirusScanItem = { jobId: string; referenceCode: string | null; account: string | null; status: string; result: string; createdAt: string; scannedFiles: number | null; infectedFiles: number | null; infected: { path: string; signature: string }[]; listComplete: boolean }
export type AntivirusView = { observedAt: string; engine: { state: string; version: string | null; signatureVersion: number | null; signatureDate: string | null }; updater: boolean | null; jobsAvailable: boolean; accounts: { username: string; status: string }[]; scans: AntivirusScanItem[]; updates: { jobId: string; referenceCode: string | null; result: string; createdAt: string; signatureVersion: number | null }[] }
export type IsolationView = { accounts: { username: string; status: string }[]; report: null | { username: string; uid: number; status: string; observedAt: string; state: 'ok' | 'drift' | 'unavailable'; checks: { id: string; state: 'ok' | 'drift' | 'unavailable'; expected: string | null; observed: string | null }[] } }
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>

/** Strict reader for GET /api/server/security-tools/intrusion. */
export function readIntrusionView(value: unknown): IntrusionView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const count = (item: unknown): boolean => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const entry = (item: unknown): boolean => typeof item === 'string' && /^[0-9A-Fa-f:.]{2,45}(?:\/[0-9]{1,3})?$/.test(item)
  if (!object(value) || !['read', 'not_installed', 'unavailable'].includes(String(value.state)) || !iso(value.observedAt) || !Array.isArray(value.jails) || value.jails.length > 64 || !count(value.unsupportedJails) || typeof value.jailsTruncated !== 'boolean') throw new Error('invalid_intrusion')
  if (value.state !== 'read' && value.jails.length) throw new Error('invalid_intrusion')
  let total = 0
  const jails = value.jails.map(raw => {
    if (!object(raw) || typeof raw.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.name) || !['read', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.banned) || !raw.banned.every(entry) || typeof raw.truncated !== 'boolean') throw new Error('invalid_intrusion_jail')
    const counts = [raw.currentlyFailed, raw.totalFailed, raw.currentlyBanned, raw.totalBanned]
    if (raw.state === 'read' ? !counts.every(count) : !counts.every(item => item === null) || raw.banned.length) throw new Error('invalid_intrusion_jail')
    total += raw.banned.length
    return { name: raw.name, state: raw.state as 'read' | 'unavailable', currentlyFailed: raw.currentlyFailed as number | null, totalFailed: raw.totalFailed as number | null, currentlyBanned: raw.currentlyBanned as number | null, totalBanned: raw.totalBanned as number | null, banned: [...raw.banned as string[]], truncated: raw.truncated }
  })
  if (total > 5000) throw new Error('invalid_intrusion')
  return { state: value.state as IntrusionView['state'], observedAt: value.observedAt, reason: typeof value.reason === 'string' ? value.reason : null, jails, unsupportedJails: value.unsupportedJails as number, jailsTruncated: value.jailsTruncated }
}

/** Strict reader for GET /api/server/security-tools/antivirus; results always follow the recorded job outcome. */
export function readAntivirusView(value: unknown): AntivirusView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const intOrNull = (item: unknown): item is number | null => item === null || typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const time = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item) && Number.isFinite(Date.parse(item))
  const job = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const reference = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(item) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) && item !== 'XP-JOB-000000'
  const user = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item)
  if (!object(value) || !time(value.observedAt) || !object(value.engine) || !object(value.updater) || typeof value.jobsAvailable !== 'boolean' || !Array.isArray(value.accounts) || value.accounts.length > 5000 || !Array.isArray(value.scans) || value.scans.length > 10 || !Array.isArray(value.updates) || value.updates.length > 5) throw new Error('invalid_antivirus')
  const engine = value.engine
  if (!['read', 'not_installed', 'unavailable'].includes(String(engine.state)) || (engine.state === 'read' ? !text(engine.version, 64) : engine.version !== null) || !intOrNull(engine.signatureVersion) || engine.signatureDate !== null && !text(engine.signatureDate, 64) || ![true, false, null].includes(value.updater.present as boolean | null)) throw new Error('invalid_antivirus_engine')
  const accounts = value.accounts.map(item => { if (!object(item) || !user(item.username) || !text(item.status, 32)) throw new Error('invalid_antivirus_account'); return { username: item.username, status: item.status } })
  const scans = value.scans.map(raw => {
    if (!object(raw) || !job(raw.jobId) || !reference(raw.referenceCode) || raw.account !== null && !user(raw.account) || !text(raw.status, 16) || !['pending', 'clean', 'infected', 'error', 'cancelled', 'unknown'].includes(String(raw.result)) || !time(raw.createdAt) || !Array.isArray(raw.infected) || raw.infected.length > 50 || typeof raw.listComplete !== 'boolean' || raw.summary !== null && !object(raw.summary)) throw new Error('invalid_antivirus_scan')
    const summary = raw.summary as Record<string, unknown> | null
    if (summary && (!intOrNull(summary.scannedFiles) || !intOrNull(summary.infectedFiles) || summary.infectedFiles === null || raw.result === 'clean' && summary.infectedFiles !== 0 || raw.result === 'infected' && summary.infectedFiles === 0)) throw new Error('invalid_antivirus_scan')
    const infected = raw.infected.map(item => { if (!object(item) || !text(item.path, 1024) || !item.path.startsWith('/') || !text(item.signature, 160)) throw new Error('invalid_antivirus_finding'); return { path: item.path, signature: item.signature } })
    if (infected.length && raw.result !== 'infected') throw new Error('invalid_antivirus_scan')
    return { jobId: raw.jobId, referenceCode: raw.referenceCode, account: raw.account as string | null, status: raw.status, result: String(raw.result), createdAt: raw.createdAt, scannedFiles: summary ? summary.scannedFiles as number | null : null, infectedFiles: summary ? summary.infectedFiles as number : null, infected, listComplete: raw.listComplete }
  })
  const updates = value.updates.map(raw => {
    if (!object(raw) || !job(raw.jobId) || !reference(raw.referenceCode) || !['pending', 'updated', 'up_to_date', 'error', 'cancelled', 'unknown'].includes(String(raw.result)) || !time(raw.createdAt) || !intOrNull(raw.signatureVersion)) throw new Error('invalid_antivirus_update')
    return { jobId: raw.jobId, referenceCode: raw.referenceCode, result: String(raw.result), createdAt: raw.createdAt, signatureVersion: raw.signatureVersion as number | null }
  })
  return { observedAt: value.observedAt, engine: { state: String(engine.state), version: engine.version as string | null, signatureVersion: engine.signatureVersion as number | null, signatureDate: engine.signatureDate as string | null }, updater: value.updater.present as boolean | null, jobsAvailable: value.jobsAvailable, accounts, scans, updates }
}

/** Strict reader for GET /api/server/security-tools/isolation; the overall state must follow the checks. */
export function readIsolationView(value: unknown, username: string | null): IsolationView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const textOrNull = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 256
  if (!object(value) || !Array.isArray(value.accounts) || value.accounts.length > 5000) throw new Error('invalid_isolation')
  const accounts = value.accounts.map(item => { if (!object(item) || typeof item.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(item.username) || typeof item.status !== 'string' || item.status.length > 32) throw new Error('invalid_isolation_account'); return { username: item.username, status: item.status } })
  if (username === null) { if (value.report !== null) throw new Error('invalid_isolation'); return { accounts, report: null } }
  const raw = value.report
  if (!object(raw) || raw.username !== username || typeof raw.uid !== 'number' || !Number.isSafeInteger(raw.uid) || typeof raw.status !== 'string' || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || !Array.isArray(raw.checks) || raw.checks.length > 64) throw new Error('invalid_isolation_report')
  const checks = raw.checks.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/.test(item.id) || !['ok', 'drift', 'unavailable'].includes(String(item.state)) || !textOrNull(item.expected) || !textOrNull(item.observed)) throw new Error('invalid_isolation_check')
    return { id: item.id, state: item.state as 'ok' | 'drift' | 'unavailable', expected: item.expected, observed: item.observed }
  })
  const state = checks.some(item => item.state === 'drift') ? 'drift' : checks.some(item => item.state === 'unavailable') ? 'unavailable' : 'ok'
  if (raw.state !== state) throw new Error('invalid_isolation_report')
  return { accounts, report: { username, uid: raw.uid, status: raw.status, observedAt: raw.observedAt, state, checks } }
}

/** Accepts an unban only for the requested pair; "confirmed" must carry a re-read without the address. */
export function readUnbanResult(value: unknown, input: { jail: string; address: string }): { outcome: 'confirmed' | 'unknown' } {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || value.jail !== input.jail || value.address !== input.address || !['confirmed', 'unknown'].includes(String(value.outcome)) || !object(value.after) || value.outcome === 'confirmed' && value.after.banned !== false) throw new Error('invalid_unban_result')
  return { outcome: value.outcome as 'confirmed' | 'unknown' }
}

export function readJobAck(value: unknown, kind: string): { id: string; referenceCode: string | null; status: string } {
  const reference = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(item) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item) && item !== 'XP-JOB-000000'
  const job = value && typeof value === 'object' ? (value as { job?: Record<string, unknown> }).job : undefined
  if (!job || !reference(job.referenceCode) || typeof job.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) || job.kind !== kind || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(job.status))) throw new Error('invalid_job_ack')
  return { id: job.id, referenceCode: job.referenceCode, status: String(job.status) }
}

function bindWhmSecurityTools(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-security-tools-workspace]').forEach(root => {
    if (root.dataset.securityToolsBound === 'true') return
    root.dataset.securityToolsBound = 'true'
    const page = root.dataset.securityToolsPage ?? ''
    const q = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q('[data-whm-security-tools-status]'), refresh = q<HTMLButtonElement>('[data-whm-security-tools-refresh]'), banner = q('[data-whm-security-tools-result]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!status || !refresh || !['intrusion', 'antivirus', 'isolation'].includes(page)) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.securityToolsCanRead === 'true' && !root.closest(denied) && !!request
    const manageable = (): boolean => admitted() && root.dataset.securityToolsCanManage === 'true'
    let busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (kind: string, message: string): void => { if (!banner) return; banner.hidden = false; banner.dataset.outcome = kind; banner.textContent = message; banner.setAttribute('role', ['unknown', 'denied'].includes(kind) ? 'alert' : 'status') }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const fact = (key: string, value: string | null): void => { const cell = q('[data-whm-security-tools-fact="' + key + '"]'); if (cell) cell.textContent = value ?? t('Not read') }
    const toggle = (selector: string, visible: boolean): void => { const node = q(selector); if (node) node.hidden = !visible }
    const fill = (key: string, rows: (string | Node)[][], empty: string, columns: number): void => {
      const body = q('[data-whm-security-tools-rows="' + key + '"]')
      if (!body) return
      body.textContent = ''
      for (const cells of rows) { const row = document.createElement('tr'); for (const content of cells) { const td = document.createElement('td'); td.append(content); row.append(td) } body.append(row) }
      if (!rows.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); body.append(row) }
    }
    const jobLink = (id: string, reference: string | null): HTMLAnchorElement => { const link = document.createElement('a'); link.href = '/whm/jobs?job=' + encodeURIComponent(id); link.append(reference === null ? t('Unnumbered') : technical(reference)); link.setAttribute('aria-label', t('Open job {reference}', { reference: reference ?? t('Unnumbered') })); return link }
    const outcome = (error: unknown): string => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      if (details.unknownOutcome === true || details.verificationRequired === true) return 'unknown'
      if (problem.status === 401 || problem.status === 403) return 'denied'
      if (problem.status === 409 || problem.code === 'CONFLICT') return 'conflict'
      return details.stateChanged === false ? 'refused' : 'unknown'
    }
    const failure = (kind: string): string => kind === 'denied' ? t('Authorization is no longer valid. Nothing was changed.')
      : kind === 'conflict' ? t('The host state changed before the action. Nothing was changed; reload and review.')
      : kind === 'refused' ? t('The request was refused. Nothing was changed.')
      : t('The outcome is unknown. Reload and review host jobs before trying again.')
    const confirm = async (options: Record<string, unknown>): Promise<boolean> => {
      if (!askDialog) { show('refused', t('Confirmation is unavailable; nothing was changed.')); return false }
      try { return await askDialog(options) === true } catch { return false }
    }
    const options = (select: HTMLSelectElement | null, accounts: { username: string; status: string }[]): void => {
      if (!select) return
      const current = select.value, first = select.options[0]
      select.textContent = ''
      if (first) select.append(first)
      for (const account of accounts) { const option = document.createElement('option'); option.value = account.username; option.textContent = account.username + (account.status === 'active' ? '' : ' (' + (account.status === 'suspended' ? t('suspended') : account.status) + ')'); select.append(option) }
      select.value = accounts.some(account => account.username === current) ? current : ''
    }
    const read = async (path: string): Promise<unknown> => request!('GET', path)
    const guarded = async (work: () => Promise<void>): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls()
      try { await work() } finally { busy = false; controls() }
    }
    let controls = (): void => { refresh.disabled = busy || !admitted() }

    if (page === 'intrusion') {
      let view: IntrusionView | null = null
      const jailFilter = q<HTMLSelectElement>('[data-whm-security-tools-filter="jail"]'), textFilter = q<HTMLInputElement>('[data-whm-security-tools-filter="text"]')
      const paint = (): void => {
        const current = view
        fact('service', !current ? null : current.state === 'not_installed' ? t(msgctxt('whm-security-tools-client', 'Not installed')) : current.state === 'unavailable' ? t('Not answering') : t('Answering'))
        fact('jails', current?.state === 'read' ? String(current.jails.length) : null)
        fact('banned', current?.state === 'read' ? String(current.jails.reduce((sum, jail) => sum + (jail.currentlyBanned ?? 0), 0)) : null)
        fact('observed-at', current ? displayDateTime(current.observedAt) : null)
        toggle('[data-whm-security-tools-install]', current?.state === 'not_installed')
        toggle('[data-whm-security-tools-unsupported]', !!current && (current.unsupportedJails > 0 || current.jailsTruncated))
        toggle('[data-whm-security-tools-truncated]', !!current?.jails.some(jail => jail.truncated))
        if (jailFilter) {
          const selected = jailFilter.value, first = jailFilter.options[0]
          jailFilter.textContent = ''; if (first) jailFilter.append(first)
          for (const jail of current?.jails ?? []) { const option = document.createElement('option'); option.value = jail.name; option.textContent = jail.name; jailFilter.append(option) }
          jailFilter.value = current?.jails.some(jail => jail.name === selected) ? selected : ''
        }
        const number = (value: number | null): string => value === null ? t('Not read') : String(value)
        fill('jails', (current?.jails ?? []).map(jail => [technical(jail.name), number(jail.currentlyFailed), number(jail.totalFailed), number(jail.currentlyBanned), number(jail.totalBanned), jail.state === 'read' ? t(msgctxt('whm-security-tools-client', 'Read')) : t('Unavailable')]),
          !current ? t('No jails have been read.') : current.state === 'read' ? t('Fail2ban reports no jails.') : t('Jails are unavailable.'), 6)
        const jailName = jailFilter?.value ?? '', needle = (textFilter?.value ?? '').trim().toLowerCase()
        const pairs = (current?.jails ?? []).flatMap(jail => jail.banned.map(address => ({ jail: jail.name, address }))).filter(pair => (!jailName || pair.jail === jailName) && (!needle || pair.address.toLowerCase().includes(needle)))
        fill('banned', pairs.map(pair => {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = t('Unban')
          button.dataset.whmSecurityToolsUnban = 'true'; button.dataset.jail = pair.jail; button.dataset.address = pair.address; button.setAttribute('aria-label', t('Unban {address} · {jail}', { address: pair.address, jail: pair.jail }))
          return [technical(pair.address), technical(pair.jail), button]
        }), !current ? t('No banned addresses have been read.') : t('No banned addresses match.'), 3)
        controls()
      }
      controls = (): void => {
        refresh.disabled = busy || !admitted()
        if (jailFilter) jailFilter.disabled = !admitted()
        if (textFilter) textFilter.disabled = !admitted()
        root.querySelectorAll<HTMLButtonElement>('[data-whm-security-tools-unban]').forEach(button => { button.disabled = busy || !manageable() || (button.dataset.address ?? '').includes('/') })
        root.setAttribute('aria-busy', String(busy))
      }
      const load = (): Promise<void> => guarded(async () => {
        note('reading', t('Reading fail2ban…'))
        try {
          const next = readIntrusionView(await read('/api/server/security-tools/intrusion'))
          if (!admitted()) return
          view = next
          note(next.state === 'read' ? 'read' : 'unavailable', next.state === 'read' ? t('Fail2ban status read from the server.') : next.state === 'not_installed' ? t('Fail2ban is not installed. Nothing was changed.')
            : t('Fail2ban did not answer; check that its service is running. Nothing was changed.'))
        } catch { if (admitted()) note('failed', t('Fail2ban could not be read. Any rows shown are from the last successful read.')) }
        finally { paint() }
      })
      const unban = async (jail: string, address: string): Promise<void> => {
        if (busy || !manageable()) return
        if (!await confirm({ title: t('Unban address?'), body: address + ' · ' + jail + '\n' + t('Fail2ban bans it again if the failures continue.'), confirm: t('Unban') }) || !manageable()) return
        busy = true; controls()
        let kind: string
        try { kind = readUnbanResult(await request!('POST', '/api/server/security-tools/intrusion/unban', { jail, address }), { jail, address }).outcome } catch (error) { kind = error instanceof Error && error.message === 'invalid_unban_result' ? 'unknown' : outcome(error) }
        busy = false
        show(kind, kind === 'confirmed' ? t('Unbanned: a fresh read no longer lists the address in this jail.') : kind === 'conflict' ? t('The address is no longer banned in this jail. Nothing was changed.') : failure(kind))
        await load()
      }
      q('[data-whm-security-tools-rows="banned"]')?.addEventListener('click', event => {
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-whm-security-tools-unban]')
        if (button && !button.disabled) void unban(button.dataset.jail ?? '', button.dataset.address ?? '')
      })
      jailFilter?.addEventListener('change', () => { if (view) paint() })
      textFilter?.addEventListener('input', () => { if (view) paint() })
      refresh.addEventListener('click', () => { void load() })
      if (!admitted()) { controls(); note('unavailable', t('Intrusion detection is unavailable here. Nothing was read or changed.')); return }
      void load()
      return
    }

    if (page === 'antivirus') {
      let view: AntivirusView | null = null
      const account = q<HTMLSelectElement>('[data-whm-security-tools-account]'), scan = q<HTMLButtonElement>('[data-whm-security-tools-scan]'), update = q<HTMLButtonElement>('[data-whm-security-tools-update]'), link = q<HTMLAnchorElement>('[data-whm-security-tools-job-link]')
      const results: Record<string, string> = { pending: t('Queued or running'), clean: t('No infection found'), infected: t(msgctxt('whm-security-tools-client', 'Infected files found')), error: t('Scan error'), cancelled: t('Cancelled'), unknown: t('Outcome unknown'),
        updated: t(msgctxt('whm-security-tools-client', 'Updated')), up_to_date: t('Already up to date') }
      controls = (): void => {
        const ready = !busy && manageable() && !!view?.jobsAvailable
        refresh.disabled = busy || !admitted()
        if (account) account.disabled = busy || !admitted() || !view
        if (scan) scan.disabled = !ready || view?.engine.state !== 'read' || !account?.value
        if (update) update.disabled = !ready || view?.engine.state === 'not_installed' || view?.updater === false
        root.setAttribute('aria-busy', String(busy))
      }
      const paint = (): void => {
        const current = view
        fact('engine', current ? current.engine.version ?? (current.engine.state === 'not_installed' ? t(msgctxt('whm-security-tools-client', 'Not installed')) : t('Unavailable')) : null)
        fact('signatures', current ? current.engine.signatureVersion === null ? t('Not reported') : String(current.engine.signatureVersion) : null)
        fact('signature-date', current ? current.engine.signatureDate ?? t('Not reported') : null)
        fact('updater', current ? current.updater === true ? 'freshclam' : current.updater === false ? t(msgctxt('whm-security-tools-client', 'Not installed')) : t('Unknown') : null)
        fact('observed-at', current ? displayDateTime(current.observedAt) : null)
        toggle('[data-whm-security-tools-install]', current?.engine.state === 'not_installed')
        toggle('[data-whm-security-tools-incomplete]', !!current?.scans.some(item => item.result === 'infected' && !item.listComplete))
        options(account, current?.accounts ?? [])
        const number = (value: number | null): string => value === null ? t('Not reported') : String(value)
        fill('scans', (current?.scans ?? []).map(item => [technical(displayDateTime(item.createdAt)), item.account ? technical(item.account) : t('Unknown'), results[item.result] ?? item.result, number(item.scannedFiles), number(item.infectedFiles), jobLink(item.jobId, item.referenceCode)]),
          !current ? t('No scans have been read.') : current.jobsAvailable ? t('No scans have run yet.') : t('Host jobs are unavailable, so no scans are listed.'), 6)
        fill('findings', (current?.scans ?? []).flatMap(item => item.infected.map(finding => [item.account ? technical(item.account) : t('Unknown'), technical(finding.path), technical(finding.signature)])),
          t('No infected files have been read.'), 3)
        fill('updates', (current?.updates ?? []).map(item => [technical(displayDateTime(item.createdAt)), results[item.result] ?? (item.result === 'error' ? t('Update failed') : item.result), item.signatureVersion === null ? t('Not reported') : technical(String(item.signatureVersion)), jobLink(item.jobId, item.referenceCode)]),
          t('No signature updates have been read.'), 4)
        controls()
      }
      const load = (): Promise<void> => guarded(async () => {
        note('reading', t('Reading ClamAV…'))
        try {
          const next = readAntivirusView(await read('/api/server/security-tools/antivirus'))
          if (!admitted()) return
          view = next
          note(next.engine.state === 'read' ? 'read' : 'unavailable', next.engine.state === 'not_installed' ? t('ClamAV is not installed. Nothing was changed.') : next.engine.state !== 'read' ? t('The ClamAV engine could not be read. Nothing was changed.')
            : next.jobsAvailable ? t('ClamAV read from the server.') : t('ClamAV was read. Host jobs are unavailable, so scans and updates cannot start.'))
        } catch { if (admitted()) note('failed', t('ClamAV could not be read. Any rows shown are from the last successful read.')) }
        finally { paint() }
      })
      const submit = async (path: string, body: Record<string, unknown>, kind: string, title: string, message: string): Promise<void> => {
        if (busy || !manageable()) return
        if (!await confirm({ title, body: message, confirm: title }) || !manageable()) return
        busy = true; controls()
        try {
          const ack = readJobAck(await request!('POST', path, body), kind)
          if (link) { link.href = '/whm/jobs?job=' + encodeURIComponent(ack.id); link.hidden = false }
          show('submitted', t('Host job submitted. Its result appears here when it finishes.'))
        } catch (error) { show(error instanceof Error && error.message === 'invalid_job_ack' ? 'unknown' : outcome(error), failure(error instanceof Error && error.message === 'invalid_job_ack' ? 'unknown' : outcome(error))) }
        finally { busy = false }
        await load()
      }
      scan?.addEventListener('click', () => { const username = account?.value ?? ''; if (/^[a-z][a-z0-9]{0,15}$/.test(username)) void submit('/api/server/security-tools/antivirus/scan', { account: username }, 'security.antivirus.scan', t('Start scan'), username + '\n' + t('ClamAV scans this account home as a host job. Nothing is quarantined or deleted.')) })
      update?.addEventListener('click', () => { void submit('/api/server/security-tools/antivirus/update', {}, 'security.antivirus.signatures', t('Update signatures'), t('freshclam downloads signature updates as a host job.')) })
      account?.addEventListener('change', () => controls())
      refresh.addEventListener('click', () => { void load() })
      if (!admitted()) { controls(); note('unavailable', t('Antivirus is unavailable here. Nothing was read or changed.')); return }
      void load()
      return
    }

    let view: IsolationView | null = null
    const account = q<HTMLSelectElement>('[data-whm-security-tools-account]'), inspect = q<HTMLButtonElement>('[data-whm-security-tools-inspect]')
    const labels: Record<string, string> = { passwd: t('User identity'), shell: t('Login shell'), home: t('Home directory'), slice: t('Resource slice unit'), memory: t('Memory limit'), processes: t('Process limit'), cpu: t('CPU limit'), io: t('Disk I/O limit'), plan: t('Plan') }
    const states: Record<string, string> = { ok: t('Matches'), drift: t(msgctxt('whm-security-tools-client', 'Drift')), unavailable: t(msgctxt('whm-security-tools-client', 'Not verified')) }
    controls = (): void => {
      refresh.disabled = busy || !admitted()
      if (account) account.disabled = busy || !admitted() || !view
      if (inspect) inspect.disabled = busy || !admitted() || !account?.value
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      const report = view?.report ?? null
      options(account, view?.accounts ?? [])
      fact('account', report?.username ?? null); fact('uid', report ? String(report.uid) : null); fact('account-status', report?.status ?? null)
      fact('state', report ? states[report.state]! : null); fact('observed-at', report ? displayDateTime(report.observedAt) : null)
      toggle('[data-whm-security-tools-drift]', report?.state === 'drift')
      fill('checks', (report?.checks ?? []).map(item => [labels[item.id] ?? (item.id.startsWith('fpm-') ? t('PHP-FPM identity {name}', { name: item.id.slice(4) }) : item.id), item.expected === null ? t('Not known') : technical(item.expected), item.observed === null ? t('Not read') : technical(item.observed), states[item.state]!]),
        t('No account has been inspected.'), 4)
      controls()
    }
    const load = (username: string | null): Promise<void> => guarded(async () => {
      note('reading', username ? t('Reading account isolation…') : t('Reading accounts…'))
      try {
        const next = readIsolationView(await read('/api/server/security-tools/isolation' + (username ? '?account=' + encodeURIComponent(username) : '')), username)
        if (!admitted()) return
        view = next
        note(next.report ? next.report.state === 'ok' ? 'read' : next.report.state : 'read', !next.report ? t('Select an account to inspect.') : next.report.state === 'ok' ? t('Every observed control matches the rendered configuration.')
          : next.report.state === 'drift' ? t('Drift found. The host differs from the rendered configuration.') : t('Some controls could not be verified.'))
      } catch { if (admitted()) note('failed', t('Isolation could not be read. Any rows shown are from the last successful read.')) }
      finally { paint() }
    })
    inspect?.addEventListener('click', () => { const username = account?.value ?? ''; if (/^[a-z][a-z0-9]{0,15}$/.test(username)) void load(username) })
    account?.addEventListener('change', () => controls())
    refresh.addEventListener('click', () => { void load(view?.report?.username ?? null) })
    if (!admitted()) { controls(); note('unavailable', t('Account isolation is unavailable here. Nothing was read.')); return }
    void load(null)
  })
}

export const WHM_SECURITY_TOOLS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readIntrusionView=${readIntrusionView.toString()};const readAntivirusView=${readAntivirusView.toString()};const readIsolationView=${readIsolationView.toString()};const readUnbanResult=${readUnbanResult.toString()};const readJobAck=${readJobAck.toString()};return ${bindWhmSecurityTools.toString()};})()`
