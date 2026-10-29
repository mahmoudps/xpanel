/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const remoteObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const remoteExact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
const remoteHost = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 64) return false
  if (value.includes(':')) { try { return !value.includes('/') && new URL('http://[' + value + ']/').hostname === '[' + value + ']' } catch { return false } }
  const parts = value.split('/'), octets = parts[0]?.split('.') ?? []
  if (parts.length > 2 || octets.length !== 4 || octets.some(part => !/^(?:0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255)) return false
  if (parts.length === 1) return true
  if (!/^(?:[1-9]|[12][0-9]|3[01])$/.test(parts[1]!)) return false
  const ip = octets.reduce((total, part) => total * 256 + Number(part), 0), size = 2 ** (32 - Number(parts[1]))
  return ip % size === 0
}
const remoteInputHost = (value: string): string => {
  let candidate = value
  const wildcard = /^((?:[0-9]{1,3}\.){1,3})%$/.exec(value)
  if (wildcard) { const octets = wildcard[1]!.slice(0, -1).split('.'); candidate = [...octets, ...Array<string>(4 - octets.length).fill('0')].join('.') + '/' + String(octets.length * 8) }
  if (candidate.includes(':')) {
    try { candidate = new URL('http://[' + candidate + ']/').hostname.slice(1, -1) } catch { throw new Error('invalid_remote_host') }
    const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(candidate)
    if (mapped) { const ip = parseInt(mapped[1]!, 16) * 65536 + parseInt(mapped[2]!, 16); candidate = [24, 16, 8, 0].map(shift => String(Math.floor(ip / 2 ** shift) % 256)).join('.') }
  }
  if (candidate.endsWith('/32')) candidate = candidate.slice(0, -3)
  if (!remoteHost(candidate)) throw new Error('invalid_remote_host')
  return candidate
}
const remoteStamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
export interface DatabaseRemoteClientEntry { host: string; comment: string; createdAt: string; firewall: 'verified' | 'unavailable'; grants: 'verified' | 'unavailable' }
export interface DatabaseRemoteClientView { context: { accountId: string; username: string }; revision: string; entries: DatabaseRemoteClientEntry[]; limit: 100; users: number; databases: number; capability: { canChange: boolean; reason: 'qualified' | 'native_provider_unavailable' | 'native_drift' }; application: { status: 'read' | 'applied'; nativeQualified: boolean } }
export function readDatabaseRemoteClientView(raw: unknown, accountId: string, username: string, mutation: boolean): DatabaseRemoteClientView {
  const bad = (): never => { throw new Error('invalid_remote_database_reply') }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId) || !/^[a-z][a-z0-9]{0,15}$/.test(username) || !remoteObject(raw) || !remoteExact(raw, ['context', 'revision', 'entries', 'limit', 'users', 'databases', 'capability', 'application'])
    || !remoteObject(raw.context) || !remoteExact(raw.context, ['accountId', 'username']) || raw.context.accountId !== accountId || raw.context.username !== username || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)
    || raw.limit !== 100 || ![raw.users, raw.databases].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000) || !Array.isArray(raw.entries) || raw.entries.length > 100
    || !remoteObject(raw.capability) || !remoteExact(raw.capability, ['canChange', 'reason']) || typeof raw.capability.canChange !== 'boolean' || !['qualified', 'native_provider_unavailable', 'native_drift'].includes(raw.capability.reason as string)
    || !remoteObject(raw.application) || !remoteExact(raw.application, ['status', 'nativeQualified']) || raw.application.status !== (mutation ? 'applied' : 'read') || typeof raw.application.nativeQualified !== 'boolean') return bad()
  const proven = raw.application.nativeQualified, seen = new Set<string>()
  if (raw.capability.canChange !== proven || (raw.capability.reason === 'qualified') !== proven || mutation && !proven) return bad()
  for (const row of raw.entries) {
    if (!remoteObject(row) || !remoteExact(row, ['host', 'comment', 'createdAt', 'firewall', 'grants']) || !remoteHost(row.host) || seen.has(row.host) || typeof row.comment !== 'string' || row.comment.length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069<>]/u.test(row.comment) || !remoteStamp(row.createdAt)
      || row.firewall !== (proven ? 'verified' : 'unavailable') || row.grants !== (proven ? 'verified' : 'unavailable')) return bad()
    seen.add(row.host)
  }
  return raw as unknown as DatabaseRemoteClientView
}
function bindAccountDatabaseRemote(_ask: unknown): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-database-remote]').forEach(root => {
    if (root.dataset.remoteBound === 'true') return
    root.dataset.remoteBound = 'true'
    const find = <T extends HTMLElement>(name: string): T => root.querySelector<T>('[data-remote-' + name + ']')!
    const rows = find('rows'), status = find('status'), host = find<HTMLInputElement>('host'), comment = find<HTMLInputElement>('comment'), confirmation = find<HTMLInputElement>('confirmation'), selectedPanel = find('selected-panel'), refresh = find<HTMLButtonElement>('refresh'), save = find<HTMLButtonElement>('save'), remove = find<HTMLButtonElement>('remove')
    if (!rows || !status || !host || !comment || !confirmation || !selectedPanel || !refresh || !save || !remove) return
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const eligible = (): boolean => root.isConnected && root.dataset.remoteManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let view: DatabaseRemoteClientView | null = null, selected: string | null = null, busy = false, uncertain = false
    const note = (message: string, state: string): void => { status.textContent = message; status.dataset.state = state; status.setAttribute('role', state === 'error' ? 'alert' : 'status') }
    const canWrite = (): boolean => eligible() && !busy && !uncertain && view?.capability.canChange === true
    const lock = (): void => {
      refresh.disabled = !eligible() || busy
      host.disabled = comment.disabled = confirmation.disabled = !canWrite()
      save.disabled = !canWrite() || (!selected && (view?.entries.length ?? 0) >= 100) || !!selected && confirmation.value !== selected
      remove.disabled = !canWrite() || !selected || confirmation.value !== selected
      find<HTMLButtonElement>('cancel').disabled = !eligible() || busy
      for (const button of rows.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !canWrite()
      root.setAttribute('aria-busy', String(busy))
    }
    const resetSelection = (): void => { selected = null; selectedPanel.hidden = true; confirmation.value = ''; host.value = ''; comment.value = ''; save.textContent = t('Add host'); lock() }
    // Hosts, ranges and timestamps are indivisible tokens inside the scrolling table.
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.className = 'xp-technical-token'; bdi.textContent = value; return bdi }
    const paint = (): void => {
      if (!view) return
      rows.replaceChildren()
      find('scope').textContent = t('{users} database users · {databases} active databases', { users: view.users, databases: view.databases })
      find('count').textContent = String(view.entries.length) + ' / 100'
      for (const item of view.entries) {
        const row = document.createElement('tr')
        for (const [text, isolated] of [[item.host, true], [item.comment || '—', false], [formatDisplayDateTime(item.createdAt), true], [item.firewall === 'verified' ? t('TCP/3306 verified') : t(msgctxt('account-database-remote-client', 'Not verified')), false], [item.grants === 'verified' ? t(msgctxt('account-database-remote-client', 'Verified')) : t(msgctxt('account-database-remote-client', 'Not verified')), false]] as const) { const td = document.createElement('td'); if (isolated) td.append(technical(text)); else td.textContent = text; row.append(td) }
        const td = document.createElement('td'), button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = t('Manage'); button.setAttribute('aria-label', t('Manage {host}', { host: item.host }))
        button.addEventListener('click', () => { if (!canWrite()) return; selected = item.host; host.value = item.host; comment.value = item.comment; confirmation.value = ''; find('selected').textContent = item.host; selectedPanel.hidden = false; save.textContent = t('Save host'); confirmation.focus(); lock() }); td.append(button); row.append(td); rows.append(row)
      }
      if (!view.entries.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6; td.textContent = t('No remote hosts are saved. Localhost remains available to your database users.'); row.append(td); rows.append(row) }
      lock()
    }
    const run = async (body?: Record<string, unknown>): Promise<void> => {
      if (!eligible() || busy || !send || body && !canWrite()) return
      busy = true; lock(); note(body ? t('Applying and verifying host policy…') : t('Reading host policy…'), 'loading')
      try {
        const result = readDatabaseRemoteClientView(await send(body ? 'POST' : 'GET', '/api/account/database-remote-access', body), root.dataset.account ?? '', root.dataset.username ?? '', !!body)
        if (!eligible()) return
        if (body) {
          if (result.revision === body.expectedRevision || body.action === 'remove' && result.entries.some(row => row.host === body.host) || body.action !== 'remove' && !result.entries.some(row => row.host === (body.action === 'edit' ? body.replacement : body.host) && row.comment === body.comment)) throw new Error('unverified_remote_mutation')
        }
        view = result; uncertain = false; resetSelection(); paint()
        note(body ? t('Remote host policy applied and verified.') : result.capability.canChange ? t('Saved hosts, database grants and firewall policy verified.') : t('Saved policy loaded. Native grants, firewall and recovery are unavailable or need review; changes are disabled.'), result.capability.canChange ? 'ready' : 'unavailable')
      } catch (error) {
        if (body) uncertain = true
        const code = remoteObject(error) ? error.code : null
        note(code === 'CONFLICT' ? t('The host policy changed. Refresh and review before trying again.') : body ? t('The host change could not be confirmed. Refresh and review recovery status before another change.') : t('The host policy could not be read. Try refreshing.'), 'error')
      } finally { busy = false; lock() }
    }
    refresh.addEventListener('click', () => { void run() })
    confirmation.addEventListener('input', lock)
    save.addEventListener('click', () => {
      if (!view || !canWrite() || selected && confirmation.value !== selected) return
      let target: string
      try { target = remoteInputHost(host.value) } catch { note(t('Enter an exact IP address or a valid IPv4 network with zero host bits.'), 'error'); return }
      const request = selected ? { action: 'edit', host: selected, replacement: target, comment: comment.value, expectedRevision: view.revision } : { action: 'add', host: target, comment: comment.value, expectedRevision: view.revision }
      void run(request)
    })
    remove.addEventListener('click', () => { if (view && selected && canWrite() && confirmation.value === selected) void run({ action: 'remove', host: selected, expectedRevision: view.revision }) })
    find('cancel').addEventListener('click', resetSelection)
    if (!eligible() || !send) { lock(); note(t('Remote database access is unavailable here. No host policy was read or changed.'), 'unavailable'); return }
    void run()
  })
}
export const ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const remoteObject=${remoteObject.toString()};const remoteExact=${remoteExact.toString()};const remoteHost=${remoteHost.toString()};const remoteInputHost=${remoteInputHost.toString()};const remoteStamp=${remoteStamp.toString()};const readDatabaseRemoteClientView=${readDatabaseRemoteClientView.toString()};return ${bindAccountDatabaseRemote.toString()};})()`
