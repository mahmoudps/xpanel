import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
export type WhmDatabaseDrift = 'in-sync' | 'saved-only' | 'server-only' | 'system' | 'unverified'
type ObservedState = { state: 'read' | 'partial' | 'unavailable'; observedAt: string | null }
type DriftCounts = { savedOnly: number; serverOnly: number } | null
export type WhmDatabaseProcess = { id: number; user: string; host: string; db: string | null; command: string; timeSeconds: number; threadState: string; protected: boolean; protectedReason: string | null; account: string | null }
export type WhmDatabasesView =
  | { kind: 'overview'; observed: ObservedState & { version: string | null; status: Record<string, number> | null; schemaCount: number | null; totalSizeBytes: number | null }
    saved: { accounts: { account: string; owner: string | null; status: string; databases: number; trashedDatabases: number; users: number; grants: number; observedSizeBytes: number | null }[]; totals: Record<'accounts' | 'databases' | 'trashedDatabases' | 'users' | 'grants', number> }
    databases: { name: string; account: string | null; trashed: boolean | null; sizeBytes: number | null; tables: number | null; drift: WhmDatabaseDrift }[]; drift: DriftCounts }
  | { kind: 'users'; observed: ObservedState; users: { user: string; host: string; account: string | null; role: boolean | null; grants: { database: string; privileges: string[] }[] | null; drift: WhmDatabaseDrift }[]; drift: DriftCounts }
  | { kind: 'processes'; observed: ObservedState; processes: WhmDatabaseProcess[] | null }
  | { kind: 'servers'; engine: { savedDatabases: number; service: { state: string; unit: string | null } | null; configuration: { protocol: string; socket: string | null } | null; observed: ObservedState & { version: string | null; variables: { port: number; socket: string; bind_address: string; skip_networking: string; max_connections: number } | null } } }
export type WhmDatabaseKillRequest = { id: number; mode: 'query' | 'connection'; user: string; db: string | null }

/** Strict reader for the four root database workspace replies; anything unexpected is refused, never painted. */
export function readWhmDatabasesView(kind: string, value: unknown): WhmDatabasesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_whm_databases_view') }
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
  const text = (item: unknown, max: number, min = 0): string => typeof item === 'string' && item.length >= min && item.length <= max && item.isWellFormed() && !unsafe.test(item) ? item : bad()
  const count = (item: unknown): number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : bad()
  const flag = (item: unknown): boolean => typeof item === 'boolean' ? item : bad()
  const maybe = <T>(item: unknown, read: (raw: unknown) => T): T | null => item === null ? null : read(item)
  const account = (item: unknown): string => typeof item === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item) ? item : bad()
  const when = (item: unknown): string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(item) && Number.isFinite(Date.parse(item)) ? item : bad()
  const version = (item: unknown): string => typeof item === 'string' && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(item) ? item : bad()
  const oneOf = <T extends string>(item: unknown, allowed: readonly T[]): T => allowed.includes(item as T) ? item as T : bad()
  const rows = <T>(item: unknown, read: (raw: Record<string, unknown>) => T, max = 5000): T[] => Array.isArray(item) && item.length <= max ? item.map(raw => object(raw) ? read(raw) : bad()) : bad()
  const drift = (item: unknown): WhmDatabaseDrift => oneOf(item, ['in-sync', 'saved-only', 'server-only', 'system', 'unverified'] as const)
  const observed = (item: unknown): ObservedState => {
    if (!object(item)) return bad()
    const state = oneOf(item.state, ['read', 'partial', 'unavailable'] as const), observedAt = maybe(item.observedAt, when)
    return observedAt === null && state !== 'unavailable' ? bad() : { state, observedAt }
  }
  const counts = (item: unknown): DriftCounts => maybe(item, raw => object(raw) ? { savedOnly: count(raw.savedOnly), serverOnly: count(raw.serverOnly) } : bad())
  const scoped = (item: unknown, saved: boolean): void => { if (!object(item) || item.observed !== 'host-observation' || (saved ? item.saved !== 'saved-configuration' : 'saved' in item)) bad() }
  if (!object(value)) return bad()
  if (kind === 'overview') {
    scoped(value.scope, true)
    const o = value.observed, saved = value.saved
    if (!object(o) || !object(saved) || !object(saved.totals)) return bad()
    const names = ['Uptime', 'Threads_connected', 'Threads_running', 'Connections', 'Max_used_connections', 'Aborted_connects', 'Questions', 'Slow_queries']
    const status = maybe(o.status, raw => object(raw) && Object.keys(raw).length === names.length ? Object.fromEntries(names.map(name => [name, count(raw[name])])) : bad())
    const totals = saved.totals
    const view = {
      kind: 'overview' as const,
      observed: { ...observed(o), version: maybe(o.version, version), status, schemaCount: maybe(o.schemaCount, count), totalSizeBytes: maybe(o.totalSizeBytes, count) },
      saved: {
        accounts: rows(saved.accounts, raw => ({ account: account(raw.account), owner: maybe(raw.owner, item => text(item, 64, 1)), status: oneOf(raw.status, ['active', 'suspended', 'terminating'] as const), databases: count(raw.databases), trashedDatabases: count(raw.trashedDatabases), users: count(raw.users), grants: count(raw.grants), observedSizeBytes: maybe(raw.observedSizeBytes, count) }), 10000),
        totals: { accounts: count(totals.accounts), databases: count(totals.databases), trashedDatabases: count(totals.trashedDatabases), users: count(totals.users), grants: count(totals.grants) },
      },
      databases: rows(value.databases, raw => ({ name: text(raw.name, 64, 1), account: maybe(raw.account, account), trashed: maybe(raw.trashed, flag), sizeBytes: maybe(raw.sizeBytes, count), tables: maybe(raw.tables, count), drift: drift(raw.drift) }), 55000),
      drift: counts(value.drift),
    }
    if ((view.drift === null) !== (view.observed.schemaCount === null) || view.drift === null && view.databases.some(row => row.drift !== 'unverified') || view.saved.totals.accounts !== view.saved.accounts.length) return bad()
    return view
  }
  if (kind === 'users') {
    scoped(value.scope, true)
    if (value.ownerPage !== '/databases/mariadb') return bad()
    const view = {
      kind: 'users' as const, observed: observed(value.observed),
      users: rows(value.users, raw => ({ user: text(raw.user, 128), host: text(raw.host, 255), account: maybe(raw.account, account), role: maybe(raw.role, flag),
        grants: maybe(raw.grants, item => rows(item, grant => ({ database: text(grant.database, 64, 1), privileges: Array.isArray(grant.privileges) && grant.privileges.length <= 32 ? grant.privileges.map(privilege => text(privilege, 32, 1)) : bad() }))), drift: drift(raw.drift) }), 55000),
      drift: counts(value.drift),
    }
    if (view.drift === null && view.users.some(row => row.drift !== 'unverified')) return bad()
    return view
  }
  if (kind === 'processes') {
    scoped(value.scope, false)
    if (value.queryText !== 'not-read') return bad()
    const view = {
      kind: 'processes' as const, observed: observed(value.observed),
      processes: maybe(value.processes, item => rows(item, raw => {
        const id = typeof raw.id === 'number' && Number.isSafeInteger(raw.id) && raw.id >= 1 ? raw.id : bad(), isProtected = flag(raw.protected)
        return { id, user: text(raw.user, 128), host: text(raw.host, 255), db: maybe(raw.db, db => text(db, 64, 1)), command: text(raw.command, 32, 1), timeSeconds: count(raw.timeSeconds), threadState: text(raw.threadState, 128),
          protected: isProtected, protectedReason: isProtected ? oneOf(raw.protectedReason, ['agent-session', 'agent-account', 'system-account', 'replication-or-daemon'] as const) : raw.protectedReason === null ? null : bad(), account: maybe(raw.account, account) }
      })),
    }
    if ((view.processes === null) !== (view.observed.state === 'unavailable') || view.processes && new Set(view.processes.map(row => row.id)).size !== view.processes.length) return bad()
    return view
  }
  if (kind === 'servers') {
    if (!Array.isArray(value.engines) || value.engines.length !== 1 || !object(value.engines[0])) return bad()
    const raw = value.engines[0], o = raw.observed
    if (raw.engine !== 'mariadb' || raw.label !== 'MariaDB' || !object(o)) return bad()
    return {
      kind: 'servers', engine: {
        savedDatabases: count(raw.savedDatabases),
        service: maybe(raw.service, item => object(item) ? { state: oneOf(item.state, ['active', 'inactive', 'failed', 'not-installed', 'unchecked'] as const), unit: maybe(item.unit, unit => text(unit, 128, 1)) } : bad()),
        configuration: maybe(raw.configuration, item => object(item) && item.source === 'agent-client-configuration' ? { protocol: oneOf(item.protocol, ['socket', 'default'] as const), socket: maybe(item.socket, socket => text(socket, 1024, 1)) } : bad()),
        observed: { ...observed(o), version: maybe(o.version, version), variables: maybe(o.variables, item => object(item) ? { port: count(item.port), socket: text(item.socket, 1024), bind_address: text(item.bind_address, 255), skip_networking: oneOf(item.skip_networking, ['ON', 'OFF'] as const), max_connections: count(item.max_connections) } : bad()) },
      },
    }
  }
  return bad()
}

/** Only an echo of the exact request is accepted, and confirmed always means a re-read proved the effect. */
export function readWhmDatabaseKillOutcome(value: unknown, request: WhmDatabaseKillRequest): { outcome: 'confirmed' | 'attempted'; after: string } {
  const item = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!item || item.id !== request.id || item.mode !== request.mode || item.user !== request.user || item.db !== request.db || !['confirmed', 'attempted'].includes(String(item.outcome)) || !['absent', 'idle', 'active', 'unread'].includes(String(item.after))
    || typeof item.statementAccepted !== 'boolean' || item.verificationRequired !== (item.outcome !== 'confirmed') || item.outcome === 'confirmed' && item.statementAccepted !== true) throw new Error('invalid_whm_database_kill')
  return { outcome: item.outcome as 'confirmed' | 'attempted', after: item.after as string }
}

function bindWhmDatabases(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-databases]').forEach(root => {
    if (root.dataset.dbBound === 'true') return
    root.dataset.dbBound = 'true'
    const kind = root.dataset.dbKind ?? ''
    const status = root.querySelector<HTMLElement>('[data-whm-db-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-whm-db-refresh]')
    const search = root.querySelector<HTMLInputElement>('[data-whm-db-search]'), driftFilter = root.querySelector<HTMLSelectElement>('[data-whm-db-drift-filter]'), filterEmpty = root.querySelector<HTMLElement>('[data-whm-db-filter-empty]')
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !refresh || !['overview', 'users', 'processes', 'servers'].includes(kind)) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.dbCanRead === 'true' && !root.closest(denied)
    const killable = (): boolean => admitted() && root.dataset.dbCanKill === 'true' && typeof askDialog === 'function'
    const notObserved = t('Not observed')
    let busy = false, confirming = false, readState = 'unread'
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const lock = (): void => {
      refresh.disabled = busy || confirming || !admitted()
      if (search) search.disabled = !admitted() || readState === 'unread'
      if (driftFilter) driftFilter.disabled = !admitted() || readState === 'unread'
      root.querySelectorAll<HTMLButtonElement>('[data-whm-db-kill]').forEach(button => { button.disabled = busy || confirming || !killable() })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const fact = (key: string, value: string | null, technical = false): void => {
      const target = root.querySelector<HTMLElement>('[data-whm-db-fact="' + key + '"]')
      if (!target) return
      target.textContent = ''
      const node = document.createElement(technical && value !== null ? 'bdi' : 'span')
      if (technical && value !== null) node.dir = 'ltr'
      node.textContent = value ?? notObserved; target.append(node)
    }
    const tbody=(name:string):HTMLElement|null=>root.querySelector<HTMLElement>('[data-whm-db-rows="'+name+'"]')
    const rowSlots:Readonly<Record<string,readonly string[]>>={accounts:['account','owner','status','databases','trash','users','grants','size'],databases:['name','account','state','size','tables','drift'],users:['user','host','account','grants','role','drift'],processes:['connection','user','account','host','database','command','seconds','state','actions'],engines:['engine','state','unit','version','databases']}
    const templates=new Map([...root.querySelectorAll<HTMLElement>('[data-whm-db-rows]')].map(body=>{const name=body.dataset.whmDbRows!,slots=rowSlots[name];if(!slots)throw new Error('unknown_whm_database_table');const row=clientTemplate(root,'whm-db-'+name+'-row'),empty=clientTemplate(root,'whm-db-'+name+'-empty');cloneClientTemplate(row,'tr',slots);cloneClientTemplate(empty,'tr',['message']);return[name,{body,slots,row,empty}] as const}))
    const killTemplate=clientTemplate(root,'whm-db-kill');cloneClientTemplate(killTemplate,'button',['label'])
    const driftLabels:Record<string,string>={'in-sync':t('In sync'),'saved-only':t('Saved only'),'server-only':t('Server only'),system:t(msgctxt('whm-databases-client','System')),unverified:t(msgctxt('whm-databases-client','Not verified'))}
    const drifts=new Map(Object.keys(driftLabels).map(state=>{const template=clientTemplate(root,'whm-db-drift-'+state);cloneClientTemplate(template,'span',['label']);return[state,template] as const}))
    const placeholder=(body:HTMLElement|null,message:string):void=>{if(!body)return;const contract=templates.get(body.dataset.whmDbRows!)!;const row=cloneClientTemplate(contract.empty,'tr',['message']);clientTemplateSlot(row,'message','td').textContent=message;body.replaceChildren(row)}
    const paintRow=(name:string,values:Record<string,string>,search?:string,drift?:string):HTMLTableRowElement=>{
      const contract=templates.get(name)!,row=cloneClientTemplate(contract.row,'tr',contract.slots) as HTMLTableRowElement
      for(const [slot,text]of Object.entries(values))clientTemplateSlot(row,slot).textContent=text
      if(search!==undefined){row.dataset.whmDbRow='';row.dataset.search=search.toLowerCase()}
      if(drift){const chip=cloneClientTemplate(drifts.get(drift)!,'span',['label']);clientTemplateSlot(chip,'label').textContent=driftLabels[drift]!;clientTemplateSlot(row,'drift').replaceChildren(chip);row.dataset.drift=drift}
      return row
    }
    const bytes = (value: number | null): string => {
      if (value === null) return notObserved
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
      let size = value, unit = 0
      while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
      return (unit === 0 ? String(size) : size.toFixed(1)) + ' ' + units[unit]
    }
    const amount = (value: number | null): string => value === null ? notObserved : String(value)
    const applyFilter = (): void => {
      const query = (search?.value ?? '').trim().toLowerCase(), wanted = driftFilter?.value ?? ''
      let total = 0, shown = 0
      root.querySelectorAll<HTMLTableRowElement>('tr[data-whm-db-row]').forEach(row => {
        total++
        const match = (!query || (row.dataset.search ?? '').includes(query)) && (!wanted || row.dataset.drift === wanted)
        row.hidden = !match; if (match) shown++
      })
      if (filterEmpty) filterEmpty.hidden = !(total > 0 && shown === 0)
    }
    const fill = <T>(name: string, items: readonly T[] | null, empty: string, unavailable: string, paint: (item: T) => HTMLTableRowElement): void => {
      const body = tbody(name)
      if (!body) return
      if (items === null) { placeholder(body, unavailable); return }
      if (!items.length) { placeholder(body, empty); return }
      body.textContent = ''
      for (const item of items) body.append(paint(item))
    }
    const accountStatus: Record<string, string> = { active: t('Active'), suspended: t(msgctxt('whm-databases-client', 'Suspended')), terminating: t('Terminating') }
    const protectedLabels: Record<string, string> = { 'agent-session': t('Protected: this panel’s session'), 'agent-account': t('Protected: panel administration account'), 'system-account': t('Protected: system account'), 'replication-or-daemon': t('Protected: replication or server thread') }
    const serviceLabels: Record<string, string> = { active: t(msgctxt('whm-databases-client', 'Active')), inactive: t('Inactive'), failed: t(msgctxt('whm-databases-client', 'Failed')), 'not-installed': t('Not installed'), unchecked: t(msgctxt('whm-databases-client', 'Not checked')) }
    const paint = (view: WhmDatabasesView): void => {
      if (view.kind === 'overview') {
        const o = view.observed
        fact('version', o.version, true); fact('observedAt', o.observedAt === null ? null : displayDateTime(o.observedAt), true); fact('schemaCount', o.schemaCount === null ? null : String(o.schemaCount)); fact('totalSizeBytes', o.totalSizeBytes === null ? null : bytes(o.totalSizeBytes))
        for (const name of ['Uptime', 'Threads_connected', 'Threads_running', 'Connections', 'Max_used_connections', 'Aborted_connects', 'Questions', 'Slow_queries']) {
          const value = o.status ? o.status[name] ?? null : null
          fact(name, value === null ? null : name === 'Uptime' ? t('{count} seconds', { count: value }) : String(value))
        }
        for (const [key, value] of Object.entries(view.saved.totals)) fact(key, String(value))
        fact('savedOnly', view.drift ? String(view.drift.savedOnly) : null); fact('serverOnly', view.drift ? String(view.drift.serverOnly) : null)
        fill('accounts', view.saved.accounts, t('No hosting accounts are saved.'), '', item => {
          return paintRow('accounts',{account:item.account,owner:item.owner??'root',status:accountStatus[item.status]??item.status,databases:String(item.databases),trash:String(item.trashedDatabases),users:String(item.users),grants:String(item.grants),size:bytes(item.observedSizeBytes)})
        })
        fill('databases', view.databases, t('No databases are saved or observed.'), '', item => {
          return paintRow('databases',{name:item.name,account:item.account??t(msgctxt('whm-databases-client','Not attributed')),state:item.trashed===null?t(msgctxt('whm-databases-client','Not saved')):item.trashed?t('In trash'):t(msgctxt('whm-databases-client','Live')),size:bytes(item.sizeBytes),tables:amount(item.tables)},item.name+' '+(item.account??''),item.drift)
        })
      } else if (view.kind === 'users') {
        fact('observedAt', view.observed.observedAt === null ? null : displayDateTime(view.observed.observedAt), true); fact('savedOnly', view.drift ? String(view.drift.savedOnly) : null); fact('serverOnly', view.drift ? String(view.drift.serverOnly) : null)
        fill('users', view.users, t('No database users are saved or observed.'), '', item => {
          return paintRow('users',{user:item.user||t('(anonymous)'),host:item.host||t('(no host)'),account:item.account??t('Not attributed'),grants:item.grants===null?t(msgctxt('whm-databases-client','Not saved')):item.grants.length?item.grants.map(grant=>grant.database+': '+grant.privileges.join(', ')).join('; '):t('No grants'),role:item.role===null?notObserved:item.role?t('Yes'):t('No')},item.user+' '+item.host+' '+(item.account??''),item.drift)
        })
      } else if (view.kind === 'processes') {
        fact('observedAt', view.observed.observedAt === null ? null : displayDateTime(view.observed.observedAt), true); fact('count', view.processes ? String(view.processes.length) : null)
        fill('processes', view.processes, t('No database processes were returned.'), t('The process list is unavailable. Nothing can be killed until it is read.'), item => {
          const row=paintRow('processes',{connection:String(item.id),user:item.user||t('(anonymous)'),account:item.account??t('Not attributed'),host:item.host,database:item.db??t('None'),command:item.command,seconds:String(item.timeSeconds),state:item.threadState||'-'},[item.id,item.user,item.host,item.db??'',item.command,item.account??''].join(' '))
          const actions=clientTemplateSlot(row,'actions','td')
          if(item.protected)actions.textContent=protectedLabels[item.protectedReason??'']??t('Protected')
          else for(const mode of(item.command==='Sleep'?['connection']:['query','connection']) as ('query'|'connection')[]){const button=cloneClientTemplate(killTemplate,'button',['label']) as HTMLButtonElement;button.dataset.whmDbKill=mode;clientTemplateSlot(button,'label').textContent=mode==='query'?t('Kill query'):t('Kill connection');button.addEventListener('click',()=>{if(!button.disabled)void kill(item,mode)});actions.append(button)}
          return row
        })
      } else {
        const engine = view.engine, o = engine.observed
        fill('engines', [engine], '', '', item => {
          return paintRow('engines',{engine:'MariaDB',state:item.service?serviceLabels[item.service.state]??item.service.state:notObserved,unit:item.service?.unit??notObserved,version:o.version??notObserved,databases:String(item.savedDatabases)})
        })
        fact('protocol', engine.configuration ? engine.configuration.protocol === 'socket' ? t('Unix socket') : t('Client default') : null)
        fact('clientSocket', engine.configuration?.socket ?? null, true); fact('observedAt', o.observedAt === null ? null : displayDateTime(o.observedAt), true)
        const variables = o.variables
        fact('port', variables ? String(variables.port) : null, true); fact('socket', variables ? variables.socket || '-' : null, true); fact('bind_address', variables ? variables.bind_address || '-' : null, true)
        fact('skip_networking', variables ? variables.skip_networking === 'ON' ? t('Yes') : t('No') : null); fact('max_connections', variables ? String(variables.max_connections) : null, true)
      }
      applyFilter()
    }
    const stateOf = (view: WhmDatabasesView): string => view.kind === 'servers' ? view.engine.observed.state : view.observed.state
    const load = async (): Promise<void> => {
      if (busy || confirming || !admitted() || !transport) return
      busy = true; lock(); note('reading', t('Reading saved configuration and server observations…'))
      try {
        const view = readWhmDatabasesView(kind, await transport('GET', '/api/server/databases/' + kind))
        if (!admitted()) return
        paint(view); readState = stateOf(view)
        note(readState, readState === 'read' ? t('Read complete. Saved configuration and server observations are labelled separately.')
          : readState === 'partial' ? t('Some server observations are unavailable. Unread values are marked and drift is shown only where it was read.')
            : t('Server observations are unavailable. Only saved configuration is shown and drift is not computed.'))
      } catch { if (admitted()) note('failed', t('Database information could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function kill(item: WhmDatabaseProcess, mode: 'query' | 'connection'): Promise<void> {
      if (busy || confirming || !killable() || item.protected || !transport) return
      confirming = true; lock()
      let confirmed = false
      const identity = t('Process {id} · user {user} · database {database}', { id: item.id, user: item.user || t('(anonymous)'), database: item.db ?? t(msgctxt('whm-databases-client', 'none')) })
      try {
        confirmed = await askDialog!({ title: mode === 'query' ? t('Kill the running query?') : t('Close this connection?'),
          body: identity + '. ' + t('The process is read again first; if its id, user or database changed, nothing is killed.'),
          danger: true, confirm: mode === 'query' ? t('Kill query') : t('Kill connection') }) === true
      } catch { confirmed = false } finally { confirming = false; lock() }
      if (!confirmed || busy || !killable()) return
      busy = true; lock(); note('reading', t('Sending the kill and reading the process again…'))
      const request = { id: item.id, mode, user: item.user, db: item.db }
      let result: [string, string]
      try {
        const outcome = readWhmDatabaseKillOutcome(await transport('POST', '/api/server/databases/processes/kill', request), request)
        result = outcome.outcome === 'confirmed' ? ['read', t('{process}: the kill was confirmed by a fresh read.', { process: identity })]
          : ['uncertain', t('{process}: the kill was attempted, but a fresh read did not prove its effect. Review the list before retrying.', { process: identity })]
      } catch (error) {
        const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}, details = value.details && typeof value.details === 'object' ? value.details as Record<string, unknown> : {}
        result = value.status === 409 ? ['failed', t('The process changed before the kill. Nothing was killed.')]
          : value.status === 403 ? ['failed', t('This process is protected or your authority changed. Nothing was killed.')]
            : details.stateChanged === false ? ['failed', t('The kill was not sent. Nothing was changed.')]
              : ['uncertain', t('The kill outcome is unknown. Read the list again before retrying.')]
      }
      busy = false
      await load()
      note(result[0], result[1])
    }
    search?.addEventListener('input', applyFilter); driftFilter?.addEventListener('change', applyFilter)
    refresh.addEventListener('click', () => { void load() })
    if (!transport || !admitted()) { lock(); refresh.disabled = true; note('unavailable', t('Database information is unavailable here. Nothing was read or changed.')); return }
    void load()
  })
}

export const WHM_DATABASES_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmDatabasesView=${readWhmDatabasesView.toString()};const readWhmDatabaseKillOutcome=${readWhmDatabaseKillOutcome.toString()};return ${bindWhmDatabases.toString()};})()`
