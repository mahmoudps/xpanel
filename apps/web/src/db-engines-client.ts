/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

const dbObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const dbExact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
/** Browser-side pinning of every protected database reply; anything unexpected is an unavailable read. */
function dbReadReply(kind: string, raw: unknown, accountId: string, username: string): Record<string, unknown> {
  const bad = (): never => { throw new Error('invalid_database_reply') }
  const text = (value: unknown, max: number, min = 1): string => typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value) ? value : bad()
  const nullable = (value: unknown, read: (item: unknown) => unknown): unknown => value === null ? null : read(value)
  const bool = (value: unknown): boolean => typeof value === 'boolean' ? value : bad()
  const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : bad()
  const stamp = (value: unknown): string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : bad()
  const shape = (value: unknown, keys: readonly string[]): Record<string, unknown> => dbObject(value) && dbExact(value, keys) ? value : bad()
  const context = (value: Record<string, unknown>): void => { const ctx = shape(value.context, ['accountId', 'username']); if (ctx.accountId !== accountId || ctx.username !== username) bad() }
  if (!dbObject(raw)) return bad()
  if (kind === 'engines') {
    shape(raw, ['observedAt', 'family', 'packages', 'products', 'redisConfig', 'mongodbConfig', 'postgresqlVersion']); stamp(raw.observedAt)
    const products = shape(raw.products, ['mariadb', 'postgresql', 'redis', 'mongodb', 'phpmyadmin', 'phppgadmin'])
    for (const product of Object.values(products)) {
      const item = shape(product, ['installed', 'package', 'service']); nullable(item.installed, bool)
      nullable(item.package, value => { const pkg = shape(value, ['name', 'version']); text(pkg.name, 128); text(pkg.version, 256, 0) })
      if (item.service !== 'unavailable') nullable(item.service, value => { const unit = shape(value, ['unit', 'active', 'sub', 'enabled']); for (const key of ['unit', 'active', 'sub', 'enabled']) text(unit[key], 128) })
    }
    for (const key of ['redisConfig', 'mongodbConfig']) nullable(raw[key], value => { const config = shape(value, ['path', 'state', 'facts']); nullable(config.path, item => text(item, 255)); if (!['read', 'missing', 'unreadable', 'unsupported'].includes(config.state as string) || (config.state === 'read') !== (config.facts !== null) || config.facts !== null && !dbObject(config.facts)) bad() })
    return raw
  }
  if (kind === 'web-client' || kind === 'account-phpmyadmin') {
    const account = kind === 'account-phpmyadmin'
    shape(raw, account ? ['context', 'client', 'installed', 'signon', 'databases', 'ticketSeconds', 'sessionSeconds'] : ['client', 'installed', 'signon', 'databases', 'ticketSeconds', 'sessionSeconds', 'phppgadmin'])
    if (account) { context(raw); count(raw.databases) } else { if (raw.databases !== null) bad(); nullable(raw.phppgadmin, bool) }
    const signon = shape(raw.signon, ['state', 'reason'])
    if (raw.client !== 'phpmyadmin' || raw.ticketSeconds !== 60 || raw.sessionSeconds !== 1800 || !['ready', 'not-installed', 'not-configured', 'unavailable'].includes(signon.state as string) || (signon.state === 'ready') !== (signon.reason === null) || signon.reason !== null && !/^[a-z-]{1,40}$/.test(String(signon.reason))) bad()
    nullable(raw.installed, bool)
    return raw
  }
  if (kind === 'account-phppgadmin') {
    shape(raw, ['context', 'client', 'installed', 'signon', 'postgresql']); context(raw)
    const signon = shape(raw.signon, ['state', 'reason'])
    if (raw.client !== 'phppgadmin' || signon.state !== 'unsupported' || signon.reason !== 'no-documented-signon') bad()
    nullable(raw.installed, bool); nullable(raw.postgresql, bool)
    return raw
  }
  const owned = (name: unknown): string => { const value = text(name, 63); return value === username || value.startsWith(username + '_') ? value : bad() }
  if (kind === 'account-postgresql') {
    shape(raw, ['context', 'observedAt', 'state', 'version', 'databases', 'roles', 'provisioning', 'saved']); context(raw); stamp(raw.observedAt); nullable(raw.version, value => text(value, 160))
    if (raw.provisioning !== (raw.state === 'read' ? 'available' : 'unavailable') || !['read', 'not-installed', 'stopped', 'unavailable'].includes(raw.state as string) || !Array.isArray(raw.databases) || !Array.isArray(raw.roles) || raw.databases.length > 1000 || raw.roles.length > 1000 || raw.state !== 'read' && (raw.databases.length || raw.roles.length)) bad()
    for (const row of raw.databases as unknown[]) { const item = shape(row, ['name', 'owner', 'sizeBytes']); owned(item.name); text(item.owner, 63); count(item.sizeBytes) }
    for (const row of raw.roles as unknown[]) { const item = shape(row, ['name', 'login']); owned(item.name); bool(item.login) }
    const saved = shape(raw.saved, ['databases', 'users', 'limit']), uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : bad()
    if (!Array.isArray(saved.databases) || !Array.isArray(saved.users) || saved.databases.length > 1000 || saved.users.length > 1000) bad()
    for (const row of saved.databases as unknown[]) { const item = shape(row, ['id', 'name', 'owner', 'trashedAt']); uuid(item.id); owned(item.name); owned(item.owner); nullable(item.trashedAt, stamp) }
    for (const row of saved.users as unknown[]) { const item = shape(row, ['id', 'name']); uuid(item.id); owned(item.name) }
    const limit = shape(saved.limit, ['used', 'max']); count(limit.used); nullable(limit.max, count)
    return raw
  }
  if (kind === 'pg-change') {
    shape(raw, ['stateChanged', 'kind', 'name', 'application']); owned(raw.name)
    const application = shape(raw.application, ['status', 'targetVerified'])
    if (raw.stateChanged !== true || !['user', 'database'].includes(raw.kind as string) || !['not_requested', 'global_configuration_applied'].includes(application.status as string) || application.targetVerified !== false) bad()
    return raw
  }
  if (kind === 'upgrade') {
    shape(raw, ['state', 'reason', 'observedAt', 'revision', 'family', 'installed', 'running', 'unit', 'packages', 'blocked', 'backupDirectory', 'canApply']); stamp(raw.observedAt)
    if (!['read', 'unavailable'].includes(raw.state as string) || (raw.state === 'read') !== (typeof raw.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.revision)) || raw.backupDirectory !== '/var/backups/xpanel/mariadb-upgrade' || !Array.isArray(raw.packages) || !Array.isArray(raw.blocked) || raw.packages.length > 500 || raw.blocked.length > 500) bad()
    for (const row of raw.packages as unknown[]) { const item = shape(row, ['name', 'current', 'candidate', 'origin', 'security', 'kernel', 'held', 'newInstall']); text(item.name, 160); nullable(item.current, value => text(value, 256)); text(item.candidate, 256); text(item.origin, 1024, 0); bool(item.security) }
    for (const name of raw.blocked as unknown[]) text(name, 160)
    nullable(raw.installed, value => { const item = shape(value, ['name', 'version']); text(item.name, 128); text(item.version, 256, 0) }); nullable(raw.running, value => text(value, 160)); nullable(raw.unit, value => { const item = shape(value, ['unit', 'active']); text(item.unit, 64); text(item.active, 64) })
    if (bool(raw.canApply) && (raw.state !== 'read' || raw.reason !== null || !(raw.packages as unknown[]).length || (raw.blocked as unknown[]).length)) bad()
    return raw
  }
  if (kind === 'signon') {
    shape(raw, ['client', 'action', 'ticket', 'expiresAt', 'sessionExpiresAt']); stamp(raw.expiresAt); stamp(raw.sessionExpiresAt)
    const action = new URL(text(raw.action, 512))
    if (raw.client !== 'phpmyadmin' || action.protocol !== 'https:' || action.username || action.password || action.search || action.hash || typeof raw.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.ticket)) bad()
    return raw
  }
  if (kind === 'job') {
    const job = shape(shape(raw, ['job']).job, ['id', 'kind', 'referenceCode', 'status'])
    if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(job.id) || job.kind !== 'database.mariadb.upgrade') bad()
    nullable(job.referenceCode, value => text(value, 64))
    return raw
  }
  return bad()
}

function bindDbEngines(ask: ((options: Record<string, unknown>) => Promise<unknown>) | undefined, _rtl: boolean): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-db-engine]').forEach(root => {
    if (root.dataset.dbBound === 'true') return
    root.dataset.dbBound = 'true'
    const page = root.dataset.dbEngine ?? '', account = page.startsWith('account-'), accountId = root.dataset.account ?? '', username = root.dataset.username ?? ''
    const status = root.querySelector<HTMLElement>('[data-db-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-db-action="refresh"]'), open = root.querySelector<HTMLButtonElement>('[data-db-action="open"]'), upgrade = root.querySelector<HTMLButtonElement>('[data-db-action="upgrade"]')
    if (!status) return
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const eligible = (): boolean => root.isConnected && root.dataset.dbCanRead === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let busy = false, ready = false, revision: string | null = null, uncertain = false, pgReady = false, pgUsers = 0
    const note = (message: string, state: string): void => { status.textContent = message; status.dataset.state = state; status.setAttribute('role', state === 'error' ? 'alert' : 'status') }
    const lock = (): void => {
      if (refresh) refresh.disabled = !eligible() || busy
      if (open) open.disabled = !eligible() || busy || !ready
      if (upgrade) upgrade.disabled = !eligible() || busy || !ready || uncertain || root.dataset.dbCanManage !== 'true'
      // PostgreSQL changes need a running server; database and password forms also need a saved user.
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-db-pg-form] input, [data-db-pg-form] select, [data-db-pg-form] button, [data-db-pg-act]').forEach(control => {
        control.disabled = !eligible() || busy || !pgReady || root.dataset.dbCanManage !== 'true' || !pgUsers && !!control.closest('[data-db-pg-form="database"], [data-db-pg-form="password"]')
      })
      root.setAttribute('aria-busy', String(busy))
    }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const fact = (key: string, value: string | HTMLElement): void => { const dd = root.querySelector<HTMLElement>('[data-db-fact="' + key + '"]'); if (dd) dd.replaceChildren(value) }
    const notSet = (): string => t('Not set (server default)')
    const yes = (value: boolean): string => value ? t(msgctxt('db-engines-client', 'Yes')) : t(msgctxt('db-engines-client', 'No'))
    const unknown = (): string => t(msgctxt('db-engines-client', 'Unknown'))
    const rows = (name: string, items: readonly (readonly (string | HTMLElement)[])[], empty: string): void => {
      const body = root.querySelector<HTMLElement>('[data-db-rows="' + name + '"]')
      if (!body) return
      body.replaceChildren()
      for (const cells of items) { const tr = document.createElement('tr'); for (const cell of cells) { const td = document.createElement('td'); td.append(cell); tr.append(td) } body.append(tr) }
      if (!items.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = Number(body.dataset.columns ?? '1'); td.textContent = empty; tr.append(td); body.append(tr) }
    }
    const bytes = (value: number): string => { const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let size = value, unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ } return (unit === 0 ? String(size) : size.toFixed(1)) + ' ' + units[unit] }
    const serviceState = (active: string): string => ({ active: t(msgctxt('db-engines-client', 'Running')), inactive: t(msgctxt('db-engines-client', 'Stopped')), failed: t(msgctxt('db-engines-client', 'Failed')), activating: t('Starting'), deactivating: t('Stopping') } as Record<string, string>)[active] ?? active
    const bootState = (enabled: string): string => ({ enabled: t(msgctxt('db-engines-client', 'Yes')), disabled: t(msgctxt('db-engines-client', 'No')), static: t(msgctxt('db-engines-client', 'Static')), masked: t('Masked') } as Record<string, string>)[enabled] ?? enabled
    const signonState = (state: unknown): string => ({ ready: t('Ready'), 'not-installed': t('Not installed'), 'not-configured': t('Not configured'), unavailable: t(msgctxt('db-engines-client', 'Unavailable')) } as Record<string, string>)[String(state)] ?? unknown()
    const REASONS: Record<string, string> = {
      'packages-unread': t('The package database could not be read.'), 'package-missing': t('phpMyAdmin is not installed on this server.'),
      'config-missing': t('The sign-on configuration file is missing.'), 'config-invalid': t('The sign-on configuration file is not valid.'),
      'bridge-missing': t('The reviewed sign-on bridge is not installed.'), 'bridge-modified': t('The sign-on bridge differs from the reviewed file.'),
      'phpmyadmin-config-missing': t('The phpMyAdmin sign-on configuration is not installed.'), 'phpmyadmin-config-modified': t('The phpMyAdmin sign-on configuration differs from the reviewed file.'),
      'ticket-directory-unsafe': t('The sign-on ticket directory is missing or has unsafe ownership or permissions.'), 'database-admin-unavailable': t('MariaDB administration is not connected.'),
    }
    const paintSignon = (view: Record<string, unknown>): void => {
      const signon = view.signon as { state: string; reason: string | null }
      ready = signon.state === 'ready'
      fact('installed', view.installed === null ? unknown() : yes(view.installed as boolean)); fact('signon', signonState(signon.state))
      fact('session', t('{n, plural, one {# minute} other {# minutes}}', { n: 30 })); fact('ticket', t('{n, plural, one {# second} other {# seconds}}', { n: 60 }))
      if (account) fact('databases', String(view.databases))
      else fact('phppgadmin', view.phppgadmin === null ? unknown() : yes(view.phppgadmin as boolean))
      const checks = root.querySelector<HTMLElement>('[data-db-checks]')
      if (checks) {
        const steps: [string[], string][] = [[['packages-unread', 'package-missing'], t('phpMyAdmin package installed')], [['config-missing', 'config-invalid'], t('Sign-on configuration file is valid')], [['bridge-missing', 'bridge-modified'], t('Reviewed sign-on bridge installed')], [['phpmyadmin-config-missing', 'phpmyadmin-config-modified'], t('phpMyAdmin sign-on configuration installed')], [['ticket-directory-unsafe'], t('Ticket directory owned by root with mode 0730')], [['database-admin-unavailable'], t('MariaDB administration connected')]]
        const failed = signon.reason === null ? steps.length : steps.findIndex(([reasons]) => reasons.includes(signon.reason!))
        checks.replaceChildren(...steps.map(([, label], index) => { const li = document.createElement('li'); li.textContent = label + ': ' + (index < failed ? t('Passed') : index === failed ? t(msgctxt('db-engines-client', 'Failed')) : t('Not checked')); return li }))
      }
      note(ready ? t('phpMyAdmin sign-on is ready.') : REASONS[signon.reason ?? ''] ?? t('phpMyAdmin sign-on is unavailable.'), ready ? 'ready' : 'unavailable')
    }
    const paintProduct = (view: Record<string, unknown>, id: 'redis' | 'mongodb'): void => {
      const product = (view.products as Record<string, { installed: boolean | null; package: { name: string; version: string } | null; service: { unit: string; active: string; enabled: string } | null | 'unavailable' }>)[id]!
      const service = product.service !== 'unavailable' ? product.service : null
      fact('package', product.package ? technical(product.package.name) : product.installed === false ? t('Not installed') : unknown()); fact('version', product.package ? technical(product.package.version) : '—')
      fact('unit', service ? technical(service.unit) : '—'); fact('active', service ? serviceState(service.active) : product.service === 'unavailable' && product.installed ? unknown() : '—'); fact('enabled', service ? bootState(service.enabled) : '—')
      fact('observedAt', technical(formatDisplayDateTime(view.observedAt as string)))
      const config = view[id === 'redis' ? 'redisConfig' : 'mongodbConfig'] as { path: string | null; state: string; facts: Record<string, unknown> | null } | null
      fact('configPath', config?.path ? technical(config.path) : '—')
      fact('configState', !config ? '—' : ({ read: t(msgctxt('db-engines-client', 'Read')), missing: t('Not found'), unreadable: t('Could not be read'), unsupported: t('Uses syntax this page does not read') } as Record<string, string>)[config.state] ?? unknown())
      const values = config?.facts ?? null, put = (key: string, render: (value: unknown) => string | HTMLElement): void => fact(key, !values ? '—' : values[key] === null ? notSet() : render(values[key]))
      if (id === 'redis') {
        put('port', value => technical(String(value))); put('bind', value => technical((value as string[]).join(' '))); put('protectedMode', value => yes(value === 'yes')); put('unixSocket', value => technical(String(value)))
        put('maxmemory', value => technical(String(value))); put('maxmemoryPolicy', value => technical(String(value))); put('requirePass', value => yes(value === true)); put('appendOnly', value => yes(value === 'yes'))
      } else { put('port', value => technical(String(value))); put('bindIp', value => technical(String(value))); put('authorization', value => value === 'enabled' ? t('Enabled') : t('Disabled')); put('dbPath', value => technical(String(value))) }
      const next = root.querySelector<HTMLElement>('[data-db-next]')
      const message = view.packages !== 'read' ? t('The package database could not be read.')
        : !product.installed ? (id === 'redis' ? t('Redis is not installed on this server. Install Redis or Valkey from the distribution repositories, then read again.') : t('MongoDB is not installed on this server. It is not in the distribution repositories; install it from the vendor repository, then read again.'))
          : service?.active === 'active' ? t('The service is running. Change settings in the configuration file, then restart the service.') : t('The service is not running. Start it on the service manager page.')
      if (next) next.textContent = message
      note(product.installed ? t('Server information read.') : message, product.installed && service?.active === 'active' ? 'ready' : 'unavailable')
    }
    const paintUpgrade = (view: Record<string, unknown>): void => {
      const installed = view.installed as { name: string; version: string } | null, unit = view.unit as { unit: string; active: string } | null, packages = view.packages as { name: string; current: string | null; candidate: string; origin: string; security: boolean }[]
      fact('installed', installed ? technical(installed.name + ' ' + installed.version) : '—'); fact('running', view.running ? technical(String(view.running)) : '—'); fact('unit', unit ? technical(unit.unit) : '—'); fact('active', unit ? serviceState(unit.active) : '—')
      fact('family', view.family === 'debian' ? technical('apt') : view.family === 'rhel' ? technical('dnf') : '—'); fact('observedAt', technical(formatDisplayDateTime(view.observedAt as string)))
      rows('packages', packages.map(item => [technical(item.name), technical(item.current ?? '—'), technical(item.candidate), item.origin || '—', yes(item.security)]), view.state === 'read' ? t('No MariaDB package upgrade is pending.') : t('Not read'))
      const blocked = root.querySelector<HTMLElement>('[data-db-blocked]'), names = view.blocked as string[]
      if (blocked) { blocked.hidden = !names.length; blocked.textContent = names.length ? t('Held or new packages block the upgrade: {names}', { names: names.join(', ') }) : '' }
      ready = view.canApply === true; revision = typeof view.revision === 'string' ? view.revision : null
      const reasons: Record<string, string> = { 'unsupported-host': t('Database upgrades need a supported native Linux host.'), 'not-installed': t('MariaDB is not installed on this server.'), 'package-manager-unavailable': t('The package manager could not be read.'), 'package-manager-busy': t('Another package operation is running. Try again later.'), 'invalid-package-manager-output': t('The package manager output could not be verified.'), 'admin-credentials-unsupported': t('The backup needs the default xPanel MariaDB credential file.') }
      const plan = ready ? t('{n, plural, one {# MariaDB package is ready to upgrade.} other {# MariaDB packages are ready to upgrade.}}', { n: packages.length })
        : typeof view.reason === 'string' ? reasons[view.reason] ?? t('The upgrade cannot start on this server right now.')
          : !packages.length ? t('MariaDB is current for the configured repositories.') : names.length ? t('Release the held packages before upgrading.') : t('MariaDB must be running and the host job runner available before the upgrade can start.')
      const target = root.querySelector<HTMLElement>('[data-db-plan]'); if (target) target.textContent = plan
      note(view.state === 'read' ? t('Upgrade plan read.') : plan, ready ? 'ready' : 'unavailable')
    }
    const paintPostgresql = (view: Record<string, unknown>): void => {
      const state = String(view.state), saved = view.saved as { databases: { id: string; name: string; owner: string; trashedAt: string | null }[]; users: { id: string; name: string }[]; limit: { used: number; max: number | null } }
      fact('state', ({ read: t(msgctxt('db-engines-client', 'Running')), 'not-installed': t('Not installed'), stopped: t(msgctxt('db-engines-client', 'Stopped')), unavailable: t(msgctxt('db-engines-client', 'Unavailable')) } as Record<string, string>)[state] ?? unknown())
      fact('version', view.version ? technical(String(view.version)) : '—'); fact('observedAt', technical(formatDisplayDateTime(view.observedAt as string)))
      fact('limit', saved.limit.max === null ? t('{used} of unlimited', { used: saved.limit.used }) : t('{used} of {max}', { used: saved.limit.used, max: saved.limit.max }))
      pgReady = state === 'read'; pgUsers = saved.users.length
      const sizes = new Map((view.databases as { name: string; owner: string; sizeBytes: number }[]).map(item => [item.name, item])), logins = new Map((view.roles as { name: string; login: boolean }[]).map(item => [item.name, item.login]))
      const act = (label: string, action: string, id: string, name: string, trashedAt?: string): HTMLButtonElement => { const button = document.createElement('button'); button.type = 'button'; button.className = 'xp-btn'; button.textContent = label; Object.assign(button.dataset, { dbPgAct: action, id, name }, trashedAt ? { trashedAt } : {}); return button }
      const actions = (...buttons: HTMLButtonElement[]): HTMLElement => { const box = document.createElement('div'); box.className = 'xp-acct-tool__actions'; box.append(...buttons); return box }
      const waiting = (): string => pgReady ? t('Waiting to be created on the server') : unknown()
      rows('databases', [
        ...saved.databases.map(db => [technical(db.name), technical(db.owner), sizes.has(db.name) ? technical(bytes(sizes.get(db.name)!.sizeBytes)) : '—',
          db.trashedAt ? t('In the trash since {at}', { at: formatDisplayDateTime(db.trashedAt) }) : sizes.has(db.name) ? t('Active') : waiting(),
          actions(...db.trashedAt ? [act(t('Restore'), 'restore', db.id, db.name, db.trashedAt), act(t('Delete permanently'), 'purge', db.id, db.name)] : [act(t('Move to trash'), 'trash', db.id, db.name)])]),
        ...[...sizes.values()].filter(item => !saved.databases.some(db => db.name === item.name)).map(item => [technical(item.name), technical(item.owner), technical(bytes(item.sizeBytes)), t('Not saved in xPanel'), '—']),
      ], t('No PostgreSQL databases are saved for your account.'))
      rows('roles', [
        ...saved.users.map(user => [technical(user.name), logins.has(user.name) ? yes(logins.get(user.name)!) : waiting(), actions(act(t('Delete'), 'delete-user', user.id, user.name))]),
        ...[...logins].filter(([name]) => !saved.users.some(user => user.name === name)).map(([name, login]) => [technical(name), yes(login), t('Not saved in xPanel')]),
      ], t('No PostgreSQL users are saved for your account.'))
      for (const [selector, value] of [['#db-pg-owner', 'name'], ['#db-pg-password-user', 'id']] as const) {
        const select = root.querySelector<HTMLSelectElement>(selector)
        select?.replaceChildren(...saved.users.map(user => { const option = document.createElement('option'); option.value = user[value]; option.textContent = user.name; return option }))
      }
      note(({ read: t('PostgreSQL databases read from the server.'), 'not-installed': t('PostgreSQL is not installed on this server. Nothing can be created until it is installed and running.'), stopped: t('The PostgreSQL server is not running. Start it before making changes.'), unavailable: t('The PostgreSQL server could not be read.') } as Record<string, string>)[state] ?? t('The PostgreSQL server could not be read.'), state === 'read' ? 'ready' : 'unavailable')
    }
    const paintPhpPgAdmin = (view: Record<string, unknown>): void => {
      fact('installed', view.installed === null ? unknown() : yes(view.installed as boolean)); fact('postgresql', view.postgresql === null ? unknown() : view.postgresql ? t(msgctxt('db-engines-client', 'Installed')) : t('Not installed'))
      fact('signon', t('Unavailable: no documented sign-on method'))
      note(view.installed ? t('phpPgAdmin is installed, but it cannot be opened without a password, so it stays unavailable.') : t('phpPgAdmin is not available on this server.'), 'unavailable')
    }
    const read = async (): Promise<boolean> => {
      if (!eligible() || busy || !send) return false
      busy = true; ready = false; pgReady = false; lock(); note(t('Reading server information…'), 'loading')
      try {
        const path = page === 'whm-phpmyadmin' ? '/api/server/databases/web-clients' : page === 'whm-upgrade' ? '/api/server/databases/upgrade' : page.startsWith('whm-') ? '/api/server/databases/engines' : '/api/account/database-engines/' + page.slice(8)
        const kind = page === 'whm-phpmyadmin' ? 'web-client' : page === 'whm-upgrade' ? 'upgrade' : page.startsWith('whm-') ? 'engines' : page
        const view = dbReadReply(kind, await send('GET', path), accountId, username)
        if (!eligible()) return false
        if (kind === 'web-client' || kind === 'account-phpmyadmin') paintSignon(view)
        else if (kind === 'upgrade') { uncertain = false; paintUpgrade(view) }
        else if (kind === 'engines') paintProduct(view, page === 'whm-redis' ? 'redis' : 'mongodb')
        else if (kind === 'account-postgresql') paintPostgresql(view)
        else paintPhpPgAdmin(view)
        return true
      } catch (error) {
        ready = false
        note(dbObject(error) && error.code === 'FORBIDDEN' ? t('This database page requires the current authorized owner.') : t('Server information could not be read. Try reading again.'), 'error')
        return false
      } finally { busy = false; lock() }
    }
    open?.addEventListener('click', async () => {
      if (!eligible() || busy || !ready || !send) return
      busy = true; lock(); note(t('Preparing a single-use sign-on…'), 'loading')
      try {
        const issued = dbReadReply('signon', await send('POST', account ? '/api/account/database-engines/phpmyadmin/sign-on' : '/api/server/databases/web-clients/phpmyadmin/sign-on', {}), accountId, username) as { action: string; ticket: string }
        // A form POST keeps the ticket out of the address bar, history and Referer.
        const form = document.createElement('form'), field = document.createElement('input')
        form.method = 'post'; form.action = issued.action; form.target = '_blank'; form.rel = 'noopener noreferrer'; form.hidden = true
        field.type = 'hidden'; field.name = 'ticket'; field.value = issued.ticket; form.append(field); document.body.append(form)
        try { form.submit() } finally { form.remove() }
        note(t('phpMyAdmin opened in a new tab. The sign-on link works once and expires in 60 seconds.'), 'ready')
      } catch { note(t('The sign-on could not be prepared. No password was shown. Read again before retrying.'), 'error') }
      finally { busy = false; lock() }
    })
    upgrade?.addEventListener('click', async () => {
      if (!eligible() || busy || !ready || !revision || !send || uncertain) return
      const expected = revision
      if (!ask || await ask({ title: t('Start the MariaDB upgrade?'), body: t('All databases are backed up first. MariaDB restarts during the upgrade, so sites that use it are briefly unavailable.'), danger: true, confirm: t('Start upgrade') }) !== true) return
      if (!eligible() || busy || revision !== expected) return
      busy = true; lock(); note(t('Submitting the upgrade job…'), 'loading')
      try {
        const reply = dbReadReply('job', await send('POST', '/api/server/databases/upgrade/apply', { expectedRevision: expected }), accountId, username) as { job: { id: string; referenceCode: string | null } }
        uncertain = true
        const job = root.querySelector<HTMLElement>('[data-db-job]')
        if (job) { job.hidden = false; job.replaceChildren(t('Upgrade job {job} was submitted. Follow its progress on', { job: reply.job.referenceCode ?? reply.job.id }) + ' ', technical('/whm/jobs')) }
        note(t('The upgrade job was submitted. It is not complete until the job verifies the new version.'), 'ready')
      } catch (error) {
        uncertain = !(dbObject(error) && (error.code === 'CONFLICT' || error.code === 'VALIDATION' || error.code === 'PRECONDITION_FAILED'))
        note(dbObject(error) && error.code === 'CONFLICT' ? t('The upgrade plan changed. Read again and review it before starting.') : uncertain ? t('The upgrade submission could not be confirmed. Check the jobs page before trying again.') : t('The upgrade could not start. Nothing was submitted.'), 'error')
      } finally { busy = false; lock() }
    })
    const pgPath = '/api/account/database-engines/postgresql'
    const pgError = (error: unknown): string => {
      const code = dbObject(error) ? error.code : null, details = dbObject(error) && dbObject(error.details) ? error.details : {}
      if (details.verificationRequired === true || details.unknownOutcome === true) return t('The change could not be confirmed. Read again and check the lists before retrying.')
      return code === 'CONFLICT' ? t('That name is already in use, or the item changed. Read again, then retry.')
        : code === 'PRECONDITION_FAILED' ? t('Nothing was changed. PostgreSQL must be running, the plan must allow another database, and a user can be deleted only after the databases it owns.')
          : code === 'VALIDATION' ? t('Nothing was changed. Check the names and the password, then try again.')
            : code === 'FORBIDDEN' ? t('This database page requires the current authorized owner.') : t('The change could not be saved. Read again before retrying.')
    }
    const pgChange = async (method: string, path: string, body: Record<string, unknown>, done: string, form?: HTMLFormElement): Promise<void> => {
      if (!eligible() || busy || !pgReady || !send || root.dataset.dbCanManage !== 'true') return
      busy = true; lock(); note(t('Saving the change…'), 'loading')
      let message = done, state = 'ready'
      try { dbReadReply('pg-change', await send(method, path, body), accountId, username); form?.reset() } catch (error) { message = pgError(error); state = 'error' } finally { busy = false }
      // The lists come from a fresh read; the change message replaces its status unless that read failed.
      if (await read() || state === 'error') note(message, state)
    }
    const owned = (value: string): string => value.startsWith(username + '_') ? value : username + '_' + value
    root.querySelectorAll<HTMLFormElement>('form[data-db-pg-form]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const field = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value ?? ''
      const kind = form.dataset.dbPgForm
      if (kind === 'database') void pgChange('POST', pgPath + '/databases', { name: owned(field('name').trim().toLowerCase()), owner: field('owner') }, t('The database was saved. It is created on the server when the configuration is applied.'), form)
      else if (kind === 'user') void pgChange('POST', pgPath + '/users', { name: owned(field('name').trim().toLowerCase()), password: field('password') }, t('The user was saved. It is created on the server when the configuration is applied.'), form)
      else if (kind === 'password') void pgChange('POST', pgPath + '/users/' + field('user') + '/password', { password: field('password') }, t('The new password was saved.'), form)
    }))
    root.addEventListener('click', async event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-db-pg-act]')
      if (!button || button.disabled || busy) return
      const { dbPgAct: action = '', id = '', name = '' } = button.dataset
      const db = pgPath + '/databases/' + id
      const plan: Record<string, [string, string, Record<string, unknown>, string, string, string]> = {
        trash: ['POST', db + '/trash', { expectedTrashedAt: null, confirmation: name }, t('Move this database to the trash?'), t('It stops accepting connections until you restore it.'), t('The database was moved to the trash.')],
        restore: ['POST', db + '/restore', { expectedTrashedAt: button.dataset.trashedAt ?? null, confirmation: name }, t('Restore this database?'), t('It accepts connections again once the configuration is applied.'), t('The database was restored.')],
        purge: ['DELETE', db, { confirmation: name }, t('Delete this database permanently?'), t('It is dropped from the PostgreSQL server with all its data. This cannot be undone.'), t('The database was deleted from the server.')],
        'delete-user': ['DELETE', pgPath + '/users/' + id, { confirmation: name }, t('Delete this PostgreSQL user?'), t('It is dropped from the PostgreSQL server and can no longer sign in.'), t('The user was deleted from the server.')],
      }
      const step = plan[action]
      if (!step || !ask || await ask({ title: step[3], body: step[4] + ' ' + name, danger: action !== 'restore', confirm: button.textContent ?? '' }) !== true) return
      await pgChange(step[0], step[1], step[2], step[5])
    })
    refresh?.addEventListener('click', () => { void read() })
    if (!eligible() || !send) { lock(); note(t('This database page is unavailable here. Nothing was read or changed.'), 'unavailable'); return }
    void read()
  })
}
export { dbReadReply }
export const DB_ENGINES_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const dbObject=${dbObject.toString()};const dbExact=${dbExact.toString()};const dbReadReply=${dbReadReply.toString()};return ${bindDbEngines.toString()};})()`
