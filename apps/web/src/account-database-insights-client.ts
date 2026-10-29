/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
const INSIGHTS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INSIGHTS_SERVER = [null, 'present', 'absent']
export interface DatabaseInsightsTableView { name: string; engine: string | null; rows: number | null; dataBytes: number | null; indexBytes: number | null; freeBytes: number | null }
export interface DatabaseInsightsDatabaseView { name: string; server: 'present' | 'absent' | null; characterSet: string | null; collation: string | null; tables: number | null; dataBytes: number | null; indexBytes: number | null; freeBytes: number | null; largestTables: DatabaseInsightsTableView[] | null }
export interface DatabaseInsightsClientView {
  state: 'read' | 'partial' | 'unavailable'; observedAt: string; omitted: { databases: number; users: number }
  databases: DatabaseInsightsDatabaseView[]; users: { name: string; server: 'present' | 'absent' | null; hosts: number | null }[]
}
export function insightsObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const insightsSize = (value: unknown, min = 0): value is number | null => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const insightsText = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value)

/** Strict reply for this account: owned-name grammar, documented bounds and no unknown fields. */
export function readDatabaseInsightsView(value: unknown, accountId: string): DatabaseInsightsClientView {
  if (!INSIGHTS_ID.test(accountId) || !insightsObject(value) || Object.keys(value).length !== 7 || !insightsObject(value.context) || value.context.accountId !== accountId || !['read', 'partial', 'unavailable'].includes(value.state as string)
    || !insightsText(value.observedAt, /^[0-9T:.Z-]{20,30}$/) || !insightsObject(value.limits) || value.limits.maxDatabases !== 50 || value.limits.maxUsers !== 200 || value.limits.tablesPerDatabase !== 20
    || !insightsObject(value.omitted) || value.omitted.databases === null || !insightsSize(value.omitted.databases) || value.omitted.users === null || !insightsSize(value.omitted.users)
    || !Array.isArray(value.databases) || value.databases.length > 50 || !Array.isArray(value.users) || value.users.length > 200) throw new Error('invalid_insights_scope')
  const databases = value.databases.map(row => {
    if (!insightsObject(row) || Object.keys(row).length !== 9 || !insightsText(row.name, /^[a-z][a-z0-9_]{0,63}$/) || !INSIGHTS_SERVER.includes(row.server as string | null) || ![row.characterSet, row.collation].every(item => item === null || insightsText(item, /^[a-z0-9_]{1,64}$/))
      || ![row.tables, row.dataBytes, row.indexBytes, row.freeBytes].every(item => insightsSize(item)) || !(row.largestTables === null || Array.isArray(row.largestTables) && row.largestTables.length <= 20)) throw new Error('invalid_insights_database')
    const largestTables = row.largestTables === null ? null : (row.largestTables as unknown[]).map(table => {
      if (!insightsObject(table) || Object.keys(table).length !== 6 || typeof table.name !== 'string' || table.name.length < 1 || [...table.name].length > 64 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(table.name)
        || !(table.engine === null || insightsText(table.engine, /^[A-Za-z0-9_]{1,64}$/)) || ![table.rows, table.dataBytes, table.indexBytes, table.freeBytes].every(item => insightsSize(item))) throw new Error('invalid_insights_table')
      return { name: table.name, engine: table.engine as string | null, rows: table.rows as number | null, dataBytes: table.dataBytes as number | null, indexBytes: table.indexBytes as number | null, freeBytes: table.freeBytes as number | null }
    })
    return { name: row.name, server: row.server as 'present' | 'absent' | null, characterSet: row.characterSet as string | null, collation: row.collation as string | null, tables: row.tables as number | null,
      dataBytes: row.dataBytes as number | null, indexBytes: row.indexBytes as number | null, freeBytes: row.freeBytes as number | null, largestTables }
  })
  const users = value.users.map(row => {
    if (!insightsObject(row) || Object.keys(row).length !== 3 || !insightsText(row.name, /^[a-z][a-z0-9_]{0,31}$/) || !INSIGHTS_SERVER.includes(row.server as string | null) || !insightsSize(row.hosts, 1) || (row.server === 'present') !== (row.hosts !== null)) throw new Error('invalid_insights_user')
    return { name: row.name, server: row.server as 'present' | 'absent' | null, hosts: row.hosts as number | null }
  })
  if (new Set(databases.map(row => row.name)).size !== databases.length || new Set(users.map(row => row.name)).size !== users.length) throw new Error('invalid_insights_duplicate')
  return { state: value.state as DatabaseInsightsClientView['state'], observedAt: value.observedAt, omitted: { databases: value.omitted.databases as number, users: value.omitted.users as number }, databases, users }
}
/** Decimal units, like formatAsciiBytes in tokens.ts; null is a value the server did not report. */
export function insightsBytes(bytes: number | null): string {
  if (bytes === null) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, unit = 0
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++ }
  return value.toFixed(unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2) + ' ' + units[unit]
}

function bindAccountDatabaseInsights(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-account-database-insights]').forEach(root => {
    if (root.dataset.insightsBound === 'true') return
    root.dataset.insightsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.account ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.insightsManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(selector: string): T => root.querySelector<T>(selector)!
    const read = find<HTMLButtonElement>('[data-insights-read]'), picker = find<HTMLSelectElement>('[data-insights-database]'), status = find('[data-insights-status]')
    const dbRows = find('[data-insights-databases]'), tableRows = find('[data-insights-tables]'), userRows = find('[data-insights-users]')
    const fact = (key: string): HTMLElement => find('[data-insights-fact="' + key + '"]')
    if (!read || !picker || !status || !dbRows || !tableRows || !userRows || !fact('databases') || !fact('size') || !fact('tables') || !fact('users') || !fact('at')) return
    let view: DatabaseInsightsClientView | null = null, busy = false
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const lock = (): void => { read.disabled = !eligible() || busy; picker.disabled = !eligible() || busy || !picker.options.length; root.setAttribute('aria-busy', String(busy)) }
    const server = (state: 'present' | 'absent' | null): HTMLElement => {
      const chip = document.createElement('span')
      chip.dataset.stateChip = state === 'present' ? 'ok' : state === 'absent' ? 'problem' : 'unavailable'
      chip.textContent = state === 'present' ? t(msgctxt('account-database-insights-client', 'Present')) : state === 'absent' ? t(msgctxt('account-database-insights-client', 'Missing')) : t(msgctxt('account-database-insights-client', 'Not observed'))
      return chip
    }
    const cell = (content: string | HTMLElement): HTMLTableCellElement => {
      const td = document.createElement('td')
      if (typeof content === 'string') { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = content; td.append(bdi) } else td.append(content)
      return td
    }
    const fill = (body: HTMLElement, rows: (string | HTMLElement)[][], columns: number, empty: string): void => {
      body.textContent = ''
      for (const row of rows) { const tr = document.createElement('tr'); for (const content of row) tr.append(cell(content)); body.append(tr) }
      if (!rows.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; tr.append(td); body.append(tr) }
    }
    const count = (value: number | null): string => value === null ? '-' : String(value)
    const paintTables = (): void => {
      const selected = view?.databases.find(row => row.name === picker.value)
      fill(tableRows, (selected?.largestTables ?? []).map(table => [table.name, table.engine ?? '-', count(table.rows), insightsBytes(table.dataBytes), insightsBytes(table.indexBytes), insightsBytes(table.freeBytes)]), 6,
        !selected ? t('No database on the server to show.') : selected.largestTables === null ? t('The tables of this database could not be read.') : t('This database has no tables.'))
    }
    const paint = (next: DatabaseInsightsClientView): void => {
      view = next
      fill(dbRows, next.databases.map(row => [row.name, server(row.server), count(row.tables), insightsBytes(row.dataBytes), insightsBytes(row.indexBytes), insightsBytes(row.freeBytes), row.collation ?? '-']), 7, t('This account has no MariaDB databases.'))
      fill(userRows, next.users.map(row => [row.name, server(row.server), count(row.hosts)]), 3, t('This account has no database users.'))
      const previous = picker.value, present = next.databases.filter(row => row.server === 'present')
      picker.textContent = ''
      for (const row of present) { const option = document.createElement('option'); option.value = row.name; option.textContent = row.name; picker.append(option) }
      if (present.some(row => row.name === previous)) picker.value = previous
      paintTables()
      // A total is shown only when every database on the server reported its sizes.
      const known = next.databases.every(row => row.server === 'absent' || row.dataBytes !== null && row.indexBytes !== null && row.tables !== null)
      fact('databases').textContent = String(next.databases.length); fact('users').textContent = String(next.users.length); fact('at').textContent = displayDateTime(next.observedAt)
      fact('size').textContent = known ? insightsBytes(present.reduce((sum, row) => sum + row.dataBytes! + row.indexBytes!, 0)) : t(msgctxt('account-database-insights-client', 'Not observed'))
      fact('tables').textContent = known ? String(present.reduce((sum, row) => sum + row.tables!, 0)) : t(msgctxt('account-database-insights-client', 'Not observed'))
      const missing = next.databases.filter(row => row.server === 'absent').length + next.users.filter(row => row.server === 'absent').length
      const extra = (missing ? ' ' + t('{count} saved databases or users were not found on the server.', { count: missing }) : '')
        + (next.omitted.databases || next.omitted.users ? ' ' + t('{count} saved names were not checked.', { count: next.omitted.databases + next.omitted.users }) : '')
      if (next.state === 'read') { const [before = '', after = ''] = t('Read at {time}.').split('{time}'); note('read', before); const observed = document.createElement('bdi'); observed.dir = 'ltr'; observed.textContent = displayDateTime(next.observedAt); status.append(observed, after + extra) }
      else if (next.state === 'partial') note('partial', t('Some values could not be read from the database server and are shown as not observed.') + extra)
      else note('unavailable', t('The database server could not be read. Nothing was changed.'))
    }
    async function load(): Promise<void> {
      if (!eligible() || busy || !send) return
      busy = true; lock(); note('reading', t('Reading database insights…'))
      try { paint(readDatabaseInsightsView(await send('GET', '/api/account/database-insights'), accountId)) }
      catch { note('failed', t('Database insights could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    if (!send || !eligible() || !INSIGHTS_ID.test(accountId)) {
      read.disabled = true; picker.disabled = true
      note('unavailable', t('Database insights are unavailable here. Nothing was read.')); return
    }
    read.addEventListener('click', () => { void load() })
    picker.addEventListener('change', paintTables)
    void load()
  })
}

export const ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const INSIGHTS_ID=${INSIGHTS_ID.toString()};const INSIGHTS_SERVER=${JSON.stringify(INSIGHTS_SERVER)};const insightsObject=${insightsObject.toString()};const insightsSize=${insightsSize.toString()};const insightsText=${insightsText.toString()};const readDatabaseInsightsView=${readDatabaseInsightsView.toString()};const insightsBytes=${insightsBytes.toString()};return ${bindAccountDatabaseInsights.toString()};})()`
