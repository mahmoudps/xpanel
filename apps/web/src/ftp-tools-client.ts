/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
// Module-local alias: the binding source defines it again from ASCII_BYTES_BINDING.
const formatClientBytes = canonicalFormatClientBytes

export interface FtpSettingsForm { enabled: boolean; tls: string; tlsCipherSuite: string; anonymous: boolean; anonymousUploads: boolean; maxIdleMinutes: number; maxConnections: number; maxConnectionsPerIp: number; passivePorts: { min: number; max: number }; brokenClients: boolean; listingLimit: number }
export type FtpRequest = (method: string, path: string, body?: unknown) => Promise<unknown>
const record = (value: unknown): Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** The form holds strings and booleans; the numbers and pair come back typed, or null when one is not a whole number. */
export function readFtpSettingsForm(values: Record<string, string | boolean>): FtpSettingsForm | null {
  const whole = (key: string): number | null => { const text = String(values[key] ?? ''); return /^[0-9]{1,6}$/.test(text) ? Number(text) : null }
  const maxIdleMinutes = whole('maxIdleMinutes'), maxConnections = whole('maxConnections'), maxConnectionsPerIp = whole('maxConnectionsPerIp'), min = whole('passiveMin'), max = whole('passiveMax'), listingLimit = whole('listingLimit')
  if (maxIdleMinutes === null || maxConnections === null || maxConnectionsPerIp === null || min === null || max === null || listingLimit === null) return null
  const anonymous = values.anonymous === true
  return { enabled: values.enabled === true, tls: String(values.tls), tlsCipherSuite: String(values.tlsCipherSuite), anonymous, anonymousUploads: anonymous && values.anonymousUploads === true, maxIdleMinutes, maxConnections, maxConnectionsPerIp, passivePorts: { min, max }, brokenClients: values.brokenClients === true, listingLimit }
}

function bindFtpTools(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: FtpRequest }).xpanelSessionRequest
  const blocked = (root: HTMLElement): boolean => !transport || !!root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')
  const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
  const reason = (error: unknown): string => { const details = record(record(error).details); return details.stateChanged === false ? t('Nothing was changed.') : t('The outcome is unknown. Read the page again before you retry.') }
  // A technical value sits in its own left-to-right run; the cell keeps the page direction and its phone label.
  const cell = (row: HTMLTableRowElement, value: string, ltr = false): void => { const td = row.insertCell(); if (!ltr) { td.textContent = value; return } const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) }
  const size = (bytes: number): string => formatClientBytes(bytes)

  document.querySelectorAll<HTMLElement>('[data-ftp-server-settings]').forEach(root => {
    if (root.dataset.ftpBound === 'true') return
    root.dataset.ftpBound = 'true'
    const inputs = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-ftp-setting]')], save = root.querySelector<HTMLButtonElement>('[data-ftp-settings-save]'), status = root.querySelector<HTMLElement>('[data-ftp-settings-status]')
    if (!save || !status) return
    const manage = root.dataset.canManage === 'true'
    const lock = (on: boolean): void => { for (const input of inputs) input.disabled = on || !manage; save.disabled = on || !manage }
    const fill = (settings: Record<string, unknown>): void => {
      const passive = record(settings.passivePorts), values: Record<string, unknown> = { ...settings, passiveMin: passive.min, passiveMax: passive.max }
      for (const input of inputs) { const value = values[input.dataset.ftpSetting ?? '']; if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true; else input.value = String(value ?? '') }
    }
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('FTP settings are unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/server/ftp/settings').then(view => { fill(record(record(view).settings)); lock(false); say(status, 'read', manage ? t('Change a setting and save it. Saving restarts pure-ftpd only when its configuration changed.') : t('These settings are read-only until this tool is verified on this release.')) })
      .catch(() => say(status, 'failed', t('FTP settings could not be read.')))
    save.addEventListener('click', () => { void (async () => {
      if (save.disabled) return
      const values: Record<string, string | boolean> = {}
      for (const input of inputs) values[input.dataset.ftpSetting ?? ''] = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value
      const settings = readFtpSettingsForm(values)
      if (!settings) { say(status, 'failed', t('Enter whole numbers for the limits and ports.')); return }
      if (!settings.enabled) {
        let confirmed = false
        try { confirmed = await askDialog?.({ title: t('Disable FTP?'), body: t('pure-ftpd stops and does not start again until FTP is enabled here. Open sessions end.'), danger: true, confirm: t('Disable FTP') }) === true } catch { confirmed = false }
        if (!confirmed) return
      }
      lock(true); say(status, 'reading', t('Saving and applying the FTP settings…'))
      try {
        const view = record(await transport!('PUT', '/api/server/ftp/settings', { settings }))
        fill(record(view.settings)); say(status, record(view.application).status === 'failed' ? 'uncertain' : 'read', record(view.application).status === 'failed' ? t('The settings were saved, but the host did not apply them. Check configuration health.') : t('The FTP settings are saved and applied.'))
      } catch (error) { say(status, 'failed', t('The settings were not saved.') + ' ' + reason(error)) } finally { lock(false) }
    })() })
  })

  document.querySelectorAll<HTMLElement>('[data-ftp-sessions-tool]').forEach(root => {
    if (root.dataset.ftpBound === 'true') return
    root.dataset.ftpBound = 'true'
    const rows = root.querySelector<HTMLTableSectionElement>('[data-ftp-sessions]'), status = root.querySelector<HTMLElement>('[data-ftp-sessions-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-ftp-sessions-refresh]'), all = root.querySelector<HTMLButtonElement>('[data-ftp-sessions-all]')
    if (!rows || !status || !refresh || !all) return
    const manage = root.dataset.canManage === 'true', states: Record<string, string> = { idle: t('Idle'), download: t('Downloading'), upload: t('Uploading'), active: t('Active') }
    const disconnect = async (target: number | 'all', message: string): Promise<void> => {
      let confirmed = false
      try { confirmed = await askDialog?.({ title: t('Disconnect FTP sessions?'), body: message, danger: true, confirm: t('Disconnect') }) === true } catch { confirmed = false }
      if (!confirmed) return
      try { await transport!('POST', '/api/account/ftp/sessions/disconnect', { target }); await load() } catch (error) { say(status, 'failed', t('The session was not disconnected.') + ' ' + reason(error)) }
    }
    const load = async (): Promise<void> => {
      refresh.disabled = true; say(status, 'reading', t('Reading FTP sessions…'))
      try {
        const view = record(await transport!('GET', '/api/account/ftp/sessions')), sessions = Array.isArray(view.sessions) ? view.sessions.map(record) : []
        rows.replaceChildren()
        for (const session of sessions) {
          const row = rows.insertRow()
          cell(row, String(session.login), true); cell(row, String(session.client), true); cell(row, states[String(session.state)] ?? String(session.state)); cell(row, String(session.seconds), true); cell(row, String(session.pid), true)
          const button = document.createElement('button'); button.type = 'button'; button.className = root.dataset.buttonClass ?? ''; button.textContent = t('Disconnect'); button.disabled = !manage
          button.addEventListener('click', () => { void disconnect(Number(session.pid), t('Session {pid} of {login} ends now.', { pid: String(session.pid), login: String(session.login) })) })
          row.insertCell().append(button)
        }
        all.disabled = !manage || sessions.length === 0
        say(status, view.state === 'read' ? 'read' : 'unavailable', view.state === 'read' ? t('{count} open FTP sessions at {at} UTC.', { count: String(sessions.length), at: String(view.observedAt).slice(0, 16).replace('T', ' ') }) : t('FTP sessions could not be read on this server.'))
      } catch { say(status, 'failed', t('FTP sessions could not be read.')) } finally { refresh.disabled = false }
    }
    refresh.addEventListener('click', () => { void load() })
    all.addEventListener('click', () => { void disconnect('all', t('Every open FTP session of this account ends now.')) })
    if (blocked(root)) { say(status, 'unavailable', t('FTP sessions are unavailable here.')); refresh.disabled = all.disabled = true; return }
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-ftp-anonymous-tool]').forEach(root => {
    if (root.dataset.ftpBound === 'true') return
    root.dataset.ftpBound = 'true'
    const enabled = root.querySelector<HTMLInputElement>('[data-ftp-anonymous-enabled]'), uploads = root.querySelector<HTMLInputElement>('[data-ftp-anonymous-uploads]'), welcome = root.querySelector<HTMLTextAreaElement>('[data-ftp-anonymous-welcome]')
    const save = root.querySelector<HTMLButtonElement>('[data-ftp-anonymous-save]'), status = root.querySelector<HTMLElement>('[data-ftp-anonymous-status]'), logins = root.querySelector<HTMLElement>('[data-ftp-anonymous-logins]')
    if (!enabled || !uploads || !welcome || !save || !status || !logins) return
    const manage = root.dataset.canManage === 'true'
    let revision = '', server: Record<string, unknown> = {}
    const lock = (on: boolean): void => {
      const open = !on && manage && server.enabled === true && server.anonymous === true
      enabled.disabled = welcome.disabled = save.disabled = !open
      uploads.disabled = !open || !enabled.checked || server.anonymousUploads !== true
      if (uploads.disabled && !enabled.checked) uploads.checked = false
    }
    const fill = (view: Record<string, unknown>): void => {
      revision = String(view.revision); server = record(view.server); enabled.checked = view.enabled === true; uploads.checked = view.uploads === true; welcome.value = typeof view.welcome === 'string' ? view.welcome : ''
      logins.textContent = Array.isArray(view.logins) ? view.logins.join(', ') : ''
      lock(false)
      if (server.enabled !== true || server.anonymous !== true) say(status, 'unavailable', t('The server does not allow anonymous FTP. The administrator enables it in FTP server settings.'))
      else say(status, 'read', view.enabled === true ? t('Anonymous access is on. Files in public_ftp are public.') : t('Anonymous access is off.'))
    }
    enabled.addEventListener('change', () => lock(false))
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('Anonymous FTP is unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/account/ftp/anonymous').then(view => fill(record(view))).catch(() => say(status, 'failed', t('Anonymous FTP could not be read.')))
    save.addEventListener('click', () => { void (async () => {
      if (save.disabled) return
      lock(true); say(status, 'reading', t('Saving and applying Anonymous FTP…'))
      try {
        const view = record(await transport!('PUT', '/api/account/ftp/anonymous', { enabled: enabled.checked, uploads: uploads.checked, welcome: welcome.value, expectedRevision: revision }))
        fill(view)
        if (record(view.application).status === 'failed') say(status, 'uncertain', t('The setting was saved, but the host did not apply it. Ask the server administrator to check configuration health.'))
      } catch (error) { say(status, 'failed', t('Anonymous FTP was not changed.') + ' ' + reason(error)); lock(false) }
    })() })
  })

  document.querySelectorAll<HTMLElement>('[data-ftp-report]').forEach(root => {
    if (root.dataset.ftpBound === 'true') return
    root.dataset.ftpBound = 'true'
    const month = root.querySelector<HTMLInputElement>('[data-ftp-report-month]'), read = root.querySelector<HTMLButtonElement>('[data-ftp-report-read]'), status = root.querySelector<HTMLElement>('[data-ftp-report-status]')
    const days = root.querySelector<HTMLTableSectionElement>('[data-ftp-report-days]'), hours = root.querySelector<HTMLTableSectionElement>('[data-ftp-report-hours]'), users = root.querySelector<HTMLTableSectionElement>('[data-ftp-report-users]'), facts = [...root.querySelectorAll<HTMLElement>('[data-ftp-report-fact]')]
    if (!month || !read || !status || !days || !hours || !users) return
    month.value = month.value || new Date().toISOString().slice(0, 7)
    const load = async (): Promise<void> => {
      read.disabled = true; say(status, 'reading', t('Reading the FTP report…'))
      try {
        const report = record(await transport!('GET', '/api/account/ftp/monthly-report?month=' + encodeURIComponent(month.value))), totals = record(report.totals)
        for (const fact of facts) { const key = fact.dataset.ftpReportFact ?? ''; fact.textContent = key === 'bytes' ? size(Number(totals.bytes ?? 0)) : String(totals[key] ?? 0) }
        const fillRows = (body: HTMLTableSectionElement, list: unknown, line: (row: HTMLTableRowElement, item: Record<string, unknown>) => void): void => { body.replaceChildren(); for (const item of Array.isArray(list) ? list.map(record) : []) line(body.insertRow(), item) }
        fillRows(days, report.days, (row, item) => { cell(row, String(item.day), true); cell(row, String(item.transfers), true); cell(row, size(Number(item.bytes)), true) })
        fillRows(hours, report.hours, (row, item) => { cell(row, String(item.hour).padStart(2, '0') + ':00', true); cell(row, String(item.transfers), true); cell(row, size(Number(item.bytes)), true) })
        fillRows(users, report.users, (row, item) => { cell(row, String(item.user), true); cell(row, String(item.downloads), true); cell(row, String(item.uploads), true); cell(row, size(Number(item.bytes)), true) })
        say(status, report.state === 'read' ? 'read' : 'unavailable', report.state === 'read' ? t('Transfers from the system journal for this month.') : report.state === 'partial' ? t('The system journal covers only part of this month, so these totals are partial.') : t('The system journal could not be read.'))
      } catch { say(status, 'failed', t('The FTP report could not be read.')) } finally { read.disabled = false }
    }
    read.addEventListener('click', () => { void load() })
    if (blocked(root)) { say(status, 'unavailable', t('The FTP report is unavailable here.')); read.disabled = true; return }
    void load()
  })
}

export const FTP_TOOLS_CLIENT_BINDING = `(()=>{const formatClientBytes=${ASCII_BYTES_BINDING};const record=${record.toString()};const readFtpSettingsForm=${readFtpSettingsForm.toString()};return ${bindFtpTools.toString()};})()`
