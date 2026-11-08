/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { generateMailboxPassword } from './password-generate-client.ts'

export type DbServicesRequest = (method: string, path: string, body?: unknown) => Promise<unknown>
export const dbServiceBytes = (value: unknown): string => {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return '—'
  const mib = bytes / 1048576
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`
}
/** redis.conf(5): k and m are powers of 1000, kb and mb of 1024; the form holds whole MB, so a value never rounds down to no limit. */
export const dbServiceRedisMb = (value: unknown): number | null => {
  const match = /^([0-9]+)(k|kb|m|mb|g|gb)?$/.exec(String(value ?? '0'))
  if (!match) return null
  const unit = ({ k: 1e3, kb: 1024, m: 1e6, mb: 1048576, g: 1e9, gb: 1073741824 } as Record<string, number>)[match[2] ?? ''] ?? 1, bytes = Number(match[1]) * unit
  return bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1048576))
}
/** pg_settings reports a size in its own unit; the form takes it back as text such as 128MB. */
export const dbServicePgSize = (setting: unknown): string => {
  const row = setting as { value?: unknown; unit?: unknown } | undefined, kib = Number(row?.value) * (row?.unit === '8kB' ? 8 : 1)
  return !Number.isFinite(kib) || kib <= 0 ? '' : kib % 1024 === 0 ? `${kib / 1024}MB` : `${kib}kB`
}
/** Binds the three engine workspaces, database size limits and phpMyAdmin access. Every value comes from a fresh protected read. */
function bindDbServices(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: DbServicesRequest }).xpanelSessionRequest
  const record = (value: unknown): Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : []
  const blocked = (root: HTMLElement): boolean => !transport || !!root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')
  const say = (node: HTMLElement | null, state: string, message: string): void => { if (!node) return; node.dataset.state = state; node.textContent = message; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
  const details = (error: unknown): Record<string, unknown> => record(record(error).details)
  const confirmed = async (title: string, body: string, confirm: string): Promise<boolean> => { try { return await askDialog?.({ title, body, danger: true, confirm }) === true } catch { return false } }
  const refusal = (error: unknown): string => {
    const detail = details(error), reason = String(detail.reason ?? '')
    const known: Record<string, string> = {
      redis_not_installed: t('Redis is not installed on this server. Nothing was changed.'), redis_not_running: t('Redis must be running for this. Start it, then try again.'), redis_auth_refused: t('Redis refused the saved password. Check the configuration file.'),
      redis_remote_requires_password: t('Set a password before opening Redis to remote clients.'), redis_password_rejected: t('Use 12 to 128 letters, digits or symbols, without spaces, quotes or backslashes.'), redis_restore_requires_rdb: t('Switch persistence to snapshots before restoring. Redis loads the append-only file first.'),
      secret_line_changed: t('Secret lines stay as they are in this editor. Use the password form.'), redis_data_path_unsupported: t('The Redis data file is outside the reviewed paths.'), config_changed: t('The file changed since it was read. Load it again before saving.'),
      mongodb_not_installed: t('MongoDB is not installed on this server. Install the vendor packages first.'), mongodb_not_running: t('MongoDB must be running for this. Start it, then try again.'), mongodb_admin_missing: t('Access control is on and xPanel holds no administrator. Nothing was changed.'), mongodb_admin_refused: t('MongoDB refused the saved administrator.'),
      mongodb_remote_requires_auth: t('Turn on access control before opening MongoDB to remote clients.'), mongodb_loopback_required: t('Keep 127.0.0.1 in the list: xPanel reaches the server there.'), mongodb_bind_rejected: t('Use IP addresses separated by commas.'), mongodb_tools_missing: t('Install mongodb-database-tools from the MongoDB repository first.'),
      mongodb_name_rejected: t('Use a lowercase name. admin, local and config are reserved.'), mongodb_password_rejected: t('Use 12 to 128 letters, digits or symbols, without spaces, quotes or backslashes.'), mongodb_database_exists: t('This database already exists.'), database_server_profiles_deferred: t('Remote servers need a registered server profile, which this release does not offer.'),
      postgresql_not_installed: t('PostgreSQL is not installed on this server.'), postgresql_not_running: t('PostgreSQL must be running for this. Start it, then try again.'), postgresql_admin_rule_required: t('Keep a local peer rule for the postgres user: xPanel signs in with it.'), postgresql_size_rejected: t('Use a size such as 128MB.'),
      phpmyadmin_not_installed: t('phpMyAdmin is not installed. Install it from the software catalog first.'), phpmyadmin_port_reserved: t('Choose a free port that no panel or mail service uses.'), phpmyadmin_port_selinux: t('With SELinux enforcing, nginx may bind only ports 81, 488, 8008, 8009 and 9000 here.'), phpmyadmin_php_missing: t('This PHP version has no PHP-FPM on the server.'), phpmyadmin_password_required: t('A password is required for the access user.'),
      redis_version_not_offered: t('The repositories do not offer this version.'), redis_rollback_unavailable: t('The installed version is no longer in a repository, so a failed switch could not be undone. Nothing was changed.'), redis_switch_requires_rdb: t('Switch persistence to snapshots first: an append-only file may not load in the other version.'),
      postgresql_version_not_offered: t('The repositories do not offer this major version.'), postgresql_space_short: t('There is not enough free disk space. Nothing was changed.'), postgresql_target_rejected: t('Choose a lowercase absolute path under /srv, /data, /mnt, /opt or /var/lib, outside the current data directory.'), postgresql_target_exists: t('The target already exists. Choose a path that does not.'), postgresql_target_parent_closed: t('The parent folder must exist and let the postgres user through.'), postgresql_size_unread: t('The size of the data directory could not be read.'),
      mongodb_archive_rejected: t('This file is not a gzipped mongodump archive.'), mongodb_import_too_large: t('The file size is not accepted.'), mongodb_import_no_space: t('There is not enough free disk space for this file.'), mongodb_import_expired: t('This upload is no longer open. Send the file again.'),
      database_not_saved: t('This database is not saved for an account.'), mariadb_admin_missing: t('MariaDB administration is not connected on this server.'), host_jobs_unavailable: t('The host job runner is unavailable. Nothing was submitted.'), database_backup_missing: t('This backup is not on the server.'),
    }
    if (known[reason]) return known[reason]!
    if (reason.endsWith('_rejected')) return t('The server refused this change and the previous configuration is back in place.') + (record(error).message ? ' ' + String(record(error).message) : '')
    return detail.stateChanged === false ? t('Nothing was changed.') : t('The outcome is unknown. Read the page again before you retry.')
  }
  const failed = (error: unknown): string => details(error).stateChanged === false || details(error).restored === true ? 'failed' : 'uncertain'
  const fill = (body: HTMLElement | null, rows: readonly (readonly (string | Node)[])[], columns: number, empty: string): void => {
    if (!body) return
    const line = (cells: readonly (string | Node)[]): HTMLTableRowElement => { const row = document.createElement('tr'); for (const value of cells) { const cell = document.createElement('td'); cell.append(value); row.append(cell) } return row }
    if (rows.length) { body.replaceChildren(...rows.map(line)); return }
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = empty; row.append(cell); body.replaceChildren(row)
  }
  const stamp = (value: unknown): string => String(value ?? '').slice(0, 16).replace('T', ' ') + ' UTC'
  const action = (label: string, data: Record<string, string>, disabled: boolean): HTMLButtonElement => { const node = document.createElement('button'); node.type = 'button'; node.className = 'xp-btn v2-btn'; node.textContent = label; node.disabled = disabled; Object.assign(node.dataset, data); return node }

  document.querySelectorAll<HTMLElement>('[data-db-service]').forEach(root => {
    if (root.dataset.dbServiceBound === 'true') return
    root.dataset.dbServiceBound = 'true'
    const engine = root.dataset.dbService!, base = `/api/server/databases/services/${engine}`, canManage = root.dataset.canManage === 'true'
    const status = root.querySelector<HTMLElement>('[data-dbs-status]'), fields = new Map([...root.querySelectorAll<HTMLInputElement>('[data-dbs-field]')].map(node => [node.dataset.dbsField!, node])), field = (name: string): HTMLInputElement | null => fields.get(name) ?? null
    const facts = new Map([...root.querySelectorAll<HTMLElement>('[data-dbs-fact]')].map(node => [node.dataset.dbsFact!, node]))
    let view: Record<string, unknown> = {}
    const lock = (on: boolean): void => root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(node => { node.disabled = on || !canManage })
    const fact = (key: string, value: unknown): void => { const node = facts.get(key); if (node) node.textContent = value === null || value === undefined || value === '' ? t('Not read') : String(value) }
    const run = async (message: string, work: () => Promise<string | undefined>, reread = true): Promise<void> => {
      lock(true); say(status, 'reading', message)
      try { const done = await work(); if (reread) await read(); if (done) say(status, 'read', done) }
      catch (error) { say(status, failed(error), refusal(error)) } finally { lock(false) }
    }
    const applyFacts = (): void => {
      const service = record(view.service), runtime = record(view.runtime), config = record(record(view.config).facts), files = record(view.files), settings = record(view.settings)
      fact('state', service.active ? ({ active: t('Running'), inactive: t('Stopped'), failed: t('Failed') } as Record<string, string>)[String(service.active)] ?? String(service.active) : view.installed === false ? t('Not installed') : null)
      fact('boot', service.enabled); fact('version', runtime.version ?? view.version); fact('usedMemory', runtime.usedMemory === undefined ? null : dbServiceBytes(runtime.usedMemory)); fact('clients', runtime.connectedClients)
      fact('password', view.passwordConfigured === true ? t('Set') : view.passwordConfigured === false ? t('Not set') : null); fact('authorization', config.authorization === 'enabled' ? t('On') : view.installed ? t('Off') : null); fact('admin', view.admin === 'present' ? t('Held by xPanel') : view.admin === 'absent' ? t('Not created') : null)
      fact('dataDirectory', files.data ?? config.dbPath); fact('pending', Array.isArray(view.pendingRestart) && view.pendingRestart.length ? (view.pendingRestart as string[]).join(', ') : view.settings ? t('None') : null)
      if (engine === 'redis') { const set = (name: string, value: unknown): void => { const node = field(name); if (node && value !== null && value !== undefined) node.value = String(value) }; set('port', config.port ?? 6379); set('maxmemoryMb', dbServiceRedisMb(config.maxmemory)); set('maxclients', runtime.maxclients); set('maxmemoryPolicy', config.maxmemoryPolicy ?? 'noeviction'); set('persistence', config.appendOnly === 'yes' ? 'aof' : runtime.snapshots === false ? 'none' : 'rdb'); const remote = field('remoteAccess'); if (remote) remote.checked = Array.isArray(config.bind) && (config.bind as string[]).some(item => !/^-?(?:127\.0\.0\.1|::1)$/.test(item)) }
      if (engine === 'mongodb') { const port = field('port'), bind = field('bindIp'); if (port) port.value = String(config.port ?? 27017); if (bind) bind.value = String(config.bindIp ?? '127.0.0.1') }
      if (engine === 'postgresql') {
        for (const [name, key] of [['port', 'port'], ['maxConnections', 'max_connections'], ['logMinDurationMs', 'log_min_duration_statement']] as const) { const node = field(name), value = record(settings[key]).value; if (node && value !== undefined) node.value = String(value) }
        for (const [name, key] of [['sharedBuffers', 'shared_buffers'], ['workMem', 'work_mem'], ['maintenanceWorkMem', 'maintenance_work_mem'], ['effectiveCacheSize', 'effective_cache_size']] as const) { const node = field(name); if (node && settings[key]) node.value = dbServicePgSize(settings[key]) }
      }
      const backups = root.querySelector<HTMLElement>('[data-dbs-rows="backups"]')
      fill(backups, list(view.backups).map(row => { const name = String(row.name); return [name, dbServiceBytes(row.sizeBytes), stamp(row.modifiedAt), action(t('Restore'), { dbsRow: 'restore', name }, !canManage), action(t('Delete'), { dbsRow: 'backup-delete', name }, !canManage)] }), 5, t('No backups yet.'))
      const databases = root.querySelector<HTMLElement>('[data-dbs-rows="databases"]')
      fill(databases, list(runtime.databases).filter(row => !['admin', 'local', 'config'].includes(String(row.name))).map(row => { const name = String(row.name), box = document.createElement('input'); box.type = 'checkbox'; box.value = name; box.dataset.dbsPick = 'true'; box.setAttribute('aria-label', name); return [box, name, dbServiceBytes(row.sizeBytes), (row.users as string[] | undefined ?? []).join(', '), action(t('Back up'), { dbsRow: 'database-backup', name }, !canManage)] }), 5, t('No databases yet.'))
      const select = root.querySelector<HTMLSelectElement>('[data-dbs-keys-db]')
      if (select && runtime.state === 'read') { const counts = new Map(list(runtime.keyspace).map(row => [Number(row.db), Number(row.keys)])), current = select.value || '0'; select.replaceChildren(...Array.from({ length: Math.min(Number(runtime.databases) || 16, 256) }, (_, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = t('Database {db} ({count} keys)', { db: String(index), count: String(counts.get(index) ?? 0) }); return option })); select.value = current }
    }
    const submitted = (reply: unknown, done: string): string => record(reply).job ? t('The job was submitted. Follow it on the jobs page; it is not complete until the job verifies it.') : done
    const versionTarget = root.querySelector<HTMLSelectElement>('[data-dbs-version-target]')
    const readVersions = async (): Promise<void> => {
      if (!versionTarget || view.installed === false) return
      const reply = record(await transport!('GET', base + '/versions').catch(() => ({}))), list = (Array.isArray(reply.available) ? reply.available as unknown[] : []).filter(item => item !== reply.current).map(String)
      versionTarget.replaceChildren(...(list.length ? list : ['']).map(item => { const option = document.createElement('option'); option.value = item; option.textContent = item || t('No other version is offered'); return option }))
    }
    const read = async (): Promise<void> => { view = record(await transport!('GET', base)); applyFacts(); await readVersions() }
    root.querySelectorAll<HTMLButtonElement>('[data-dbs-control]').forEach(button => button.addEventListener('click', () => { void (async () => {
      const verb = button.dataset.dbsControl!
      if ((verb === 'stop' || verb === 'restart') && !await confirmed(t('Change this database service?'), t('Connected clients lose their connections.'), button.textContent ?? '')) return
      await run(t('Sending the request to the service…'), async () => { await transport!('POST', base + '/control', { action: verb }); return t('The service reached the requested state.') })
    })() }))
    root.querySelector<HTMLButtonElement>('[data-dbs-settings-save]')?.addEventListener('click', () => { void (async () => {
      const number = (name: string): number => Number(field(name)?.value), text = (name: string): string => field(name)?.value.trim() ?? ''
      const body = engine === 'redis' ? { port: number('port'), maxmemoryMb: number('maxmemoryMb'), maxclients: number('maxclients'), maxmemoryPolicy: text('maxmemoryPolicy'), persistence: text('persistence'), remoteAccess: field('remoteAccess')?.checked === true }
        : engine === 'mongodb' ? { port: number('port'), bindIp: text('bindIp') } : { port: number('port'), maxConnections: number('maxConnections'), sharedBuffers: text('sharedBuffers'), workMem: text('workMem'), maintenanceWorkMem: text('maintenanceWorkMem'), effectiveCacheSize: text('effectiveCacheSize'), logMinDurationMs: number('logMinDurationMs') }
      if (!await confirmed(t('Save and restart?'), t('The service restarts when a setting needs it, and connected clients lose their connections.'), t('Save'))) return
      await run(t('Saving the settings and checking the service…'), async () => { await transport!('POST', base + '/settings', body); return t('The settings are saved and the service answers.') })
    })() })
    root.querySelectorAll<HTMLElement>('[data-dbs-file]').forEach(block => {
      const kind = block.dataset.dbsFile!, text = block.querySelector<HTMLTextAreaElement>('[data-dbs-file-text]'), load = block.querySelector<HTMLButtonElement>('[data-dbs-file-load]'), save = block.querySelector<HTMLButtonElement>('[data-dbs-file-save]')
      let revision = ''
      load?.addEventListener('click', () => { void run(t('Reading the file…'), async () => { const reply = record(await transport!('GET', `${base}/${kind}`)); revision = String(reply.revision); if (text) text.value = String(reply.text); return t('Read from {path}.', { path: String(reply.path) }) }, false) })
      save?.addEventListener('click', () => { void (async () => {
        if (!revision || !text) { say(status, 'failed', t('Load the file before saving it.')); return }
        if (!await confirmed(t('Save this file?'), t('The file is checked, loaded by the service and put back if the service refuses it.'), t('Save'))) return
        await run(t('Saving the file and checking the service…'), async () => { await transport!('POST', `${base}/${kind}`, { text: text.value, expectedRevision: revision }); revision = ''; return t('The file is saved and the service answers. Load it again to edit it.') })
      })() })
    })
    root.querySelector<HTMLButtonElement>('[data-dbs-log-read]')?.addEventListener('click', () => { void run(t('Reading the log…'), async () => { const reply = record(await transport!('GET', base + '/log')), node = root.querySelector<HTMLElement>('[data-dbs-log]'); if (node) node.textContent = (reply.lines as string[]).join('\n'); return t('Last lines of {path}.', { path: String(reply.path) }) }, false) })
    root.querySelector<HTMLButtonElement>('[data-dbs-password-generate]')?.addEventListener('click', () => { const node = field('password'); if (node) { node.type = 'text'; node.value = generateMailboxPassword() } })
    root.querySelector<HTMLButtonElement>('[data-dbs-password-save]')?.addEventListener('click', () => { const node = field('password'), value = node?.value ?? ''; void run(t('Setting the password and restarting Redis…'), async () => { await transport!('POST', base + '/password', { password: value }); if (node) { node.value = ''; node.type = 'password' } return t('The password is set. Clients without it are refused.') }) })
    root.querySelector<HTMLButtonElement>('[data-dbs-password-clear]')?.addEventListener('click', () => { void (async () => { if (await confirmed(t('Remove the Redis password?'), t('Local clients connect without a password afterwards.'), t('Remove'))) await run(t('Removing the password…'), async () => { await transport!('POST', base + '/password', { password: null }); return t('The password is removed.') }) })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-version-switch]')?.addEventListener('click', () => { void (async () => {
      const chosen = versionTarget?.value ?? ''
      if (!chosen) { say(status, 'failed', t('Your repositories offer no other version.')); return }
      if (!await confirmed(t('Switch to {version}?', { version: chosen }), t('The service stops during the switch. The backup comes first, and a failed switch goes back to the current version.'), t('Switch version'))) return
      await run(t('Backing up and submitting the switch…'), async () => submitted(await transport!('POST', base + '/version', engine === 'redis' ? { version: chosen } : { major: Number(chosen), confirmation: chosen }), t('The version is switched.')))
    })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-data-move]')?.addEventListener('click', () => { void (async () => {
      const target = field('dataTarget')?.value.trim() ?? ''
      if (await confirmed(t('Move the data directory?'), t('PostgreSQL stops until the copy is finished and checked. {path}', { path: target }), t('Move data directory'))) await run(t('Checking the target and submitting the move…'), async () => submitted(await transport!('POST', base + '/data-directory', { target, confirmation: target }), t('The data directory is moved.')))
    })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-import-upload]')?.addEventListener('click', () => { void (async () => {
      const file = root.querySelector<HTMLInputElement>('[data-dbs-import-file]')?.files?.[0]
      if (!file) { say(status, 'failed', t('Choose a file first.')); return }
      await run(t('Uploading: {percent}%', { percent: '0' }), async () => {
        const started = record(await transport!('POST', base + '/import', { filename: file.name, bytes: file.size })), size = Number(started.chunkBytes)
        for (let offset = 0; offset < file.size; offset += size) {
          const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()); let binary = ''
          for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384))
          say(status, 'reading', t('Uploading: {percent}%', { percent: String(Math.floor(offset / file.size * 100)) }))
          await transport!('PUT', `${base}/import/${String(started.id)}`, { offset, data: btoa(binary) })
        }
        return t('The archive is uploaded. Restore it from the list when you are ready.')
      })
    })() })
    const keys = root.querySelector<HTMLElement>('[data-dbs-rows="keys"]'), db = root.querySelector<HTMLSelectElement>('[data-dbs-keys-db]'), match = root.querySelector<HTMLInputElement>('[data-dbs-keys-match]'), more = root.querySelector<HTMLButtonElement>('[data-dbs-keys-more]')
    let cursor = '0', shown: (readonly (string | Node)[])[] = []
    if (more) more.hidden = true
    const page = async (from: string): Promise<string | undefined> => {
      const reply = record(await transport!('POST', base + '/keys', { db: Number(db?.value ?? 0), cursor: from, match: match?.value ?? '' }))
      if (from === '0') shown = []
      shown.push(...list(reply.keys).map(row => { const key = row.key === null ? t('(binary name)') : String(row.key); return [key, String(row.type), row.length === null ? '—' : String(row.length), row.ttlSeconds === null ? t('No expiry') : t('{seconds} s', { seconds: String(row.ttlSeconds) }), row.value === null ? '—' : String(row.value) + (row.truncated ? '…' : ''), row.key === null ? '' : action(t('Delete'), { dbsRow: 'key-delete', name: key }, !canManage)] }))
      fill(keys, shown, 6, t('No keys match.'))
      cursor = String(reply.cursor)
      if (more) more.hidden = cursor === '0'
      return t('{count} keys shown.', { count: String(shown.length) })
    }
    root.querySelector<HTMLButtonElement>('[data-dbs-keys-read]')?.addEventListener('click', () => { void run(t('Reading keys…'), () => page('0'), false) })
    more?.addEventListener('click', () => { void run(t('Reading keys…'), () => page(cursor), false) })
    root.querySelector<HTMLButtonElement>('[data-dbs-key-save]')?.addEventListener('click', () => { const ttl = field('ttl')?.value.trim() ?? ''; void run(t('Saving the key…'), async () => { await transport!('POST', base + '/key', { db: Number(db?.value ?? 0), key: field('keyName')?.value ?? '', value: field('keyValue')?.value ?? '', ttlSeconds: ttl ? Number(ttl) : null }); await page('0'); return t('The key is saved.') }, false) })
    root.querySelector<HTMLButtonElement>('[data-dbs-flush]')?.addEventListener('click', () => { void (async () => { const number = Number(db?.value ?? 0); if (await confirmed(t('Clear database {db}?', { db: String(number) }), t('Every key in this database is deleted. This cannot be undone.'), t('Clear'))) await run(t('Clearing the database…'), async () => { await transport!('POST', base + '/flush', { db: number, confirmation: String(number) }); return t('The database is empty.') }) })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-flush-all]')?.addEventListener('click', () => { void (async () => { if (await confirmed(t('Clear every database?'), t('Every key on this server is deleted. This cannot be undone.'), t('Clear all'))) await run(t('Clearing every database…'), async () => { await transport!('POST', base + '/flush', { db: null, confirmation: 'all' }); return t('Every database is empty.') }) })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-backup]')?.addEventListener('click', () => { void run(t('Creating the backup…'), async () => submitted(await transport!('POST', base + '/backup', engine === 'mongodb' ? { database: null } : {}), t('The backup is saved.'))) })
    root.querySelector<HTMLButtonElement>('[data-dbs-auth-on]')?.addEventListener('click', () => { void (async () => { if (await confirmed(t('Turn on access control?'), t('MongoDB restarts, and every client must then sign in.'), t('Turn on'))) await run(t('Turning on access control…'), async () => { await transport!('POST', base + '/auth', { enabled: true }); return t('Access control is on. A client without a user can no longer list databases.') }) })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-auth-off]')?.addEventListener('click', () => { void (async () => { if (await confirmed(t('Turn off access control?'), t('MongoDB restarts, and local clients no longer need to sign in.'), t('Turn off'))) await run(t('Turning off access control…'), async () => { await transport!('POST', base + '/auth', { enabled: false }); return t('Access control is off.') }) })() })
    root.querySelector<HTMLButtonElement>('[data-dbs-db-create]')?.addEventListener('click', () => { void run(t('Creating the database…'), async () => { const reply = record(await transport!('POST', base + '/database', { name: field('dbName')?.value.trim() ?? '', user: field('dbUser')?.value.trim() ?? '', password: field('dbPassword')?.value ?? '', server: 'local' })); const secret = field('dbPassword'); if (secret) secret.value = ''; return t('Database {name} is ready.', { name: String(reply.name) }) }) })
    root.querySelector<HTMLButtonElement>('[data-dbs-db-delete]')?.addEventListener('click', () => { void (async () => {
      const names = [...root.querySelectorAll<HTMLInputElement>('[data-dbs-pick]')].filter(box => box.checked).map(box => box.value)
      if (names.length === 0) { say(status, 'failed', t('Choose at least one database.')); return }
      if (await confirmed(t('Delete the selected databases?'), names.join(', ') + ' ' + t('Their data and users are deleted. This cannot be undone.'), t('Delete'))) await run(t('Deleting…'), async () => { await transport!('POST', base + '/database-delete', { names, confirmation: names.join(',') }); return t('The databases are deleted.') })
    })() })
    root.addEventListener('click', event => {
      const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-dbs-row]')
      if (!button || button.disabled) return
      const { dbsRow: kind = '', name = '' } = button.dataset
      void (async () => {
        if (kind === 'key-delete') { if (await confirmed(t('Delete this key?'), name, t('Delete'))) await run(t('Deleting…'), async () => { await transport!('POST', base + '/key-delete', { db: Number(db?.value ?? 0), key: name }); await page('0'); return t('The key is deleted.') }, false) }
        else if (kind === 'backup-delete') { if (await confirmed(t('Delete this backup?'), name, t('Delete'))) await run(t('Deleting…'), async () => { await transport!('POST', base + '/backup-delete', { name }); return t('The backup is deleted.') }) }
        else if (kind === 'restore') { if (await confirmed(t('Restore this backup?'), t('Current data is replaced. {name}', { name }), t('Restore'))) await run(t('Restoring the backup…'), async () => submitted(await transport!('POST', base + '/restore', { name }), t('The backup is restored and the service answers.'))) }
        else if (kind === 'database-backup') await run(t('Creating the backup…'), async () => submitted(await transport!('POST', base + '/backup', { database: name }), t('The backup is saved.')))
      })()
    })
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('This tool is unavailable here. Nothing was read or changed.')); return }
    void read().then(() => { lock(false); say(status, 'read', view.installed === false ? t('This service is not installed. Tools stay closed until an operator installs it.') : canManage ? t('Read from the server.') : t('Read-only until this tool is verified on this release.')); if (view.installed === false) root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true }) }).catch(error => say(status, 'failed', refusal(error)))
  })

  document.querySelectorAll<HTMLElement>('[data-db-quota-tool]').forEach(root => {
    if (root.dataset.dbServiceBound === 'true') return
    root.dataset.dbServiceBound = 'true'
    const body = root.querySelector<HTMLElement>('[data-db-quota-rows]'), database = root.querySelector<HTMLSelectElement>('[data-db-quota-database]'), limit = root.querySelector<HTMLInputElement>('[data-db-quota-limit]'), save = root.querySelector<HTMLButtonElement>('[data-db-quota-save]'), clear = root.querySelector<HTMLButtonElement>('[data-db-quota-clear]'), status = root.querySelector<HTMLElement>('[data-db-quota-status]')
    if (!body || !database || !limit || !save || !clear || !status) return
    const manage = root.dataset.canManage === 'true'
    let revision = ''
    const lock = (on: boolean): void => { database.disabled = limit.disabled = save.disabled = clear.disabled = on || !manage }
    const show = (reply: Record<string, unknown>): void => {
      revision = String(reply.revision); const rows = list(reply.rows)
      fill(body, rows.map(row => [String(row.database), String(row.account), row.sizeBytes === null ? t('Not read') : dbServiceBytes(row.sizeBytes), row.limitMb === null ? t('No limit') : t('{limit} MB', { limit: String(row.limitMb) }), row.locked === true ? t('Over the limit: writes blocked') : row.limitMb === null ? '—' : t('Within the limit')]), 5, t('No saved databases.'))
      const current = database.value
      database.replaceChildren(...rows.map(row => { const option = document.createElement('option'); option.value = option.textContent = String(row.database); return option }))
      if (current) database.value = current
    }
    const send = (limitMb: number | null): void => { void (async () => {
      lock(true); say(status, 'reading', t('Saving the limit and measuring…'))
      try { show(record(await transport!('PUT', '/api/server/databases/quota', { database: database.value, limitMb, expectedRevision: revision }))); say(status, 'read', t('Saved. Sizes are measured again every five minutes.')) }
      catch (error) { say(status, failed(error), refusal(error)) } finally { lock(false) }
    })() }
    save.addEventListener('click', () => send(Number(limit.value)))
    clear.addEventListener('click', () => send(null))
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('This tool is unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/server/databases/quota').then(reply => { show(record(reply)); lock(false); say(status, 'read', manage ? t('A database over its limit keeps reads and deletes until it is back under the limit.') : t('Read-only until this tool is verified on this release.')) }).catch(error => say(status, 'failed', refusal(error)))
  })

  document.querySelectorAll<HTMLElement>('[data-db-pma-access]').forEach(root => {
    if (root.dataset.dbServiceBound === 'true') return
    root.dataset.dbServiceBound = 'true'
    const open = root.querySelector<HTMLInputElement>('[data-pma-public]'), http = root.querySelector<HTMLInputElement>('[data-pma-http]'), https = root.querySelector<HTMLInputElement>('[data-pma-https]'), php = root.querySelector<HTMLSelectElement>('[data-pma-php]'), user = root.querySelector<HTMLInputElement>('[data-pma-user]'), password = root.querySelector<HTMLInputElement>('[data-pma-password]'), save = root.querySelector<HTMLButtonElement>('[data-pma-save]'), status = root.querySelector<HTMLElement>('[data-pma-status]')
    if (!open || !http || !https || !php || !user || !password || !save || !status) return
    const manage = root.dataset.canManage === 'true'
    let revision = '', installed = false
    const lock = (on: boolean): void => { open.disabled = http.disabled = https.disabled = php.disabled = user.disabled = password.disabled = save.disabled = on || !manage || !installed }
    const show = (reply: Record<string, unknown>): void => {
      const host = record(reply.host); revision = String(reply.revision); installed = host.installed === true
      open.checked = reply.publicAccess === true; http.value = reply.httpPort === null ? '' : String(reply.httpPort); https.value = String(reply.httpsPort ?? ''); user.value = String(reply.basicAuthUser ?? ''); password.value = ''
      const none = document.createElement('option'); none.value = ''; none.textContent = t('Newest available')
      php.replaceChildren(none, ...(Array.isArray(host.phpVersions) ? host.phpVersions as string[] : []).map(version => { const option = document.createElement('option'); option.value = option.textContent = version; return option }))
      php.value = String(reply.phpVersion ?? '')
    }
    save.addEventListener('click', () => { void (async () => {
      lock(true); say(status, 'reading', t('Saving and applying the access settings…'))
      try {
        const name = user.value.trim(), reply = record(await transport!('PUT', '/api/server/databases/phpmyadmin-access', { publicAccess: open.checked, httpPort: http.value.trim() ? Number(http.value) : null, httpsPort: Number(https.value), phpVersion: php.value || null, basicAuthUser: name || null, basicAuthPassword: name && password.value ? password.value : null, expectedRevision: revision }))
        show(reply)
        say(status, record(reply.application).status === 'failed' ? 'uncertain' : 'read', record(reply.application).status === 'failed' ? t('The settings were saved, but the host did not apply them. Check configuration health.') : t('The access settings are saved and applied.'))
      } catch (error) { say(status, failed(error), refusal(error)) } finally { lock(false) }
    })() })
    lock(true)
    if (blocked(root)) { say(status, 'unavailable', t('This tool is unavailable here. Nothing was read or changed.')); return }
    void transport!('GET', '/api/server/databases/phpmyadmin-access').then(reply => { show(record(reply)); lock(false); say(status, installed ? 'read' : 'unavailable', !installed ? t('phpMyAdmin is not installed. Install it from the software catalog first.') : manage ? t('With public access off, only this server can open the client, and sign-on from the panel stays closed.') : t('Read-only until this tool is verified on this release.')) }).catch(error => say(status, 'failed', refusal(error)))
  })
}

export const WHM_DB_SERVICES_CLIENT_BINDING = `(()=>{const generateMailboxPassword=${generateMailboxPassword.toString()};const dbServiceBytes=${dbServiceBytes.toString()};const dbServicePgSize=${dbServicePgSize.toString()};const dbServiceRedisMb=${dbServiceRedisMb.toString()};return ${bindDbServices.toString()};})()`
