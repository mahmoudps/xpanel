/// <reference lib="dom" />
import './i18n.ts'

/**
 * Shared browser controllers of the runtime, developer and panel-data cards. Each binds by its data-* root in either
 * theme, paints text only and repaints from the server's answer. A read that fails leaves the controls disabled.
 */
function bindPanelTools(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
  type Rec = Record<string, any>
  const t = (message: string, values?: Record<string, string | number>): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  const pick = <T extends HTMLElement>(scope: HTMLElement, selector: string): T | null => scope.querySelector<T>(selector)
  const reasonText = (error: unknown): string => {
    const value = (error ?? {}) as Rec, details = value.details ?? value.detail ?? {}, reason = details.reason ?? value.reason
    const known: Record<string, string> = {
      plugin_package_format: t('The file is not an xPanel plugin package.'), plugin_exists: t('A plugin with this name is installed.'),
      system_package: t('This package belongs to the server PHP installation.'), pear_not_installed: t('PEAR is not installed for this PHP version.'), pear_failed: t('The pear installer did not finish this change.'),
      NOT_EXECUTABLE: t('This file has no execute permission.'), RUNTIME_MISSING: t('This runtime version is not installed on the server.'), INVALID_PACKAGE: t('The file is not a valid package.'),
      port_in_use: t('Another project holds this port.'), domain_in_use: t('Another application already serves this domain path.'), env_exists: t('An environment with this name exists.'), env_in_use: t('An application uses this environment.'),
      metrics_disabled: t('The metrics endpoint is turned off.'), dsn_not_configured: t('Save a DSN first. Nothing was sent.'), delivery_failed: t('The DSN host did not accept the test event.'), api_shell_disabled: t('The API shell is turned off on this server.'),
      account_change_not_importable: t('An import can change the package of an existing account only.'), reseller_create_not_importable: t('An import cannot create a reseller.'), invalid_yaml: t('A file in this import is not valid YAML.'), snapshot_unavailable: t('Snapshots are unavailable on this host.'),
    }
    return known[reason as string] ?? (typeof value.message === 'string' && value.message ? value.message : t('The request was refused. Nothing was changed.'))
  }
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const allowed = (root: HTMLElement): boolean => root.isConnected && !root.closest(blocked) && typeof send === 'function' && root.dataset.toolCanManage !== 'false'
  const setup = (root: HTMLElement, bound: string): boolean => { if (root.dataset[bound] === 'true') return false; root.dataset[bound] = 'true'; return true }
  const noteOf = (element: HTMLElement | null) => (state: string, message: string): void => { if (!element) return; element.dataset.state = state; element.textContent = message; element.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const options = (select: HTMLSelectElement | null, rows: readonly (readonly [string, string])[], placeholder: string): void => {
    if (!select) return
    const keep = select.value
    select.replaceChildren(...[['', placeholder] as const, ...rows].map(([value, label]) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item }))
    if (rows.some(([value]) => value === keep)) select.value = keep
  }
  const rows = (body: HTMLElement | null, lines: readonly (readonly (string | number)[])[], empty: string, columns: number): void => {
    if (!body) return
    if (!lines.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = empty; row.append(cell); body.replaceChildren(row); return }
    body.replaceChildren(...lines.map(line => { const row = document.createElement('tr'); for (const value of line) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell) } return row }))
  }
  const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ')
  const size = (bytes: number): string => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.ceil(bytes / 1024) + ' KB'
  const save = (name: string, data: BlobPart, type: string): void => { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([data], { type })); link.download = name; link.click(); URL.revokeObjectURL(link.href) }
  const confirmed = async (title: string, body: string): Promise<boolean> => typeof askDialog === 'function' && await askDialog({ title, body, confirmLabel: t('Continue'), tone: 'danger' }) === true

  document.querySelectorAll<HTMLElement>('[data-metrics-export]').forEach(root => {
    if (!setup(root, 'metricsBound')) return
    const status = noteOf(root.querySelector('[data-metrics-status]')), enabled = root.querySelector<HTMLInputElement>('[data-metrics-enabled]'), allow = root.querySelector<HTMLTextAreaElement>('[data-metrics-allow]')
    const saveButton = root.querySelector<HTMLButtonElement>('[data-metrics-save]'), refresh = root.querySelector<HTMLButtonElement>('[data-metrics-refresh]')
    let revision = ''
    const paint = (view: Rec): void => {
      revision = view.revision
      root.querySelectorAll<HTMLElement>('[data-metrics-fact]').forEach(cell => { cell.textContent = String(view[cell.dataset.metricsFact as string] ?? '') })
      if (enabled) { enabled.checked = view.config?.enabled === true; enabled.disabled = false }
      if (allow) { allow.value = (view.config?.allow ?? []).join('\n'); allow.disabled = false }
      if (saveButton) saveButton.disabled = false
      status('read', view.invalid ? t('The saved file needs review.') : view.config?.enabled ? t('The endpoint is on.') : t('The endpoint is off.'))
    }
    const load = async (): Promise<void> => { try { paint(await send!('GET', '/api/server/metrics-export') as Rec) } catch (error) { status('failed', reasonText(error)) } }
    saveButton?.addEventListener('click', () => { void (async () => { try { paint(await send!('PUT', '/api/server/metrics-export', { config: { enabled: enabled?.checked === true, allow: (allow?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean) }, expectedRevision: revision }) as Rec) } catch (error) { status('failed', reasonText(error)) } })() })
    refresh?.addEventListener('click', () => { void load() })
    if (allowed(root)) { if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-error-reporting]').forEach(root => {
    if (!setup(root, 'errorBound')) return
    const status = noteOf(root.querySelector('[data-error-status]')), dsn = root.querySelector<HTMLInputElement>('[data-error-dsn]'), environment = root.querySelector<HTMLInputElement>('[data-error-environment]'), rate = root.querySelector<HTMLInputElement>('[data-error-rate]')
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-error-save],[data-error-test]')], refresh = root.querySelector<HTMLButtonElement>('[data-error-refresh]')
    let revision = ''
    const paint = (view: Rec): void => {
      revision = view.revision
      if (dsn) { dsn.value = view.config?.dsn ?? ''; dsn.disabled = false }
      if (environment) { environment.value = view.config?.environment ?? 'production'; environment.disabled = false }
      if (rate) { rate.value = String(view.config?.sampleRate ?? 1); rate.disabled = false }
      for (const button of buttons) button.disabled = false
      status('read', view.config?.dsn ? t('Reporting is on.') : t('Reporting is off.'))
    }
    const load = async (): Promise<void> => { try { paint(await send!('GET', '/api/server/error-reporting') as Rec) } catch (error) { status('failed', reasonText(error)) } }
    root.querySelector('[data-error-save]')?.addEventListener('click', () => { void (async () => { try { paint(await send!('PUT', '/api/server/error-reporting', { config: { dsn: dsn?.value.trim() || null, environment: environment?.value.trim() ?? '', sampleRate: Number(rate?.value) }, expectedRevision: revision }) as Rec) } catch (error) { status('failed', reasonText(error)) } })() })
    root.querySelector('[data-error-test]')?.addEventListener('click', () => { void (async () => { try { await send!('POST', '/api/server/error-reporting/test', {}); status('read', t('The test event was accepted.')) } catch (error) { status('failed', reasonText(error)) } })() })
    refresh?.addEventListener('click', () => { void load() })
    if (allowed(root)) { if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-config-code]').forEach(root => {
    if (!setup(root, 'configBound')) return
    const status = noteOf(root.querySelector('[data-config-status]')), file = root.querySelector<HTMLInputElement>('[data-config-file]'), body = root.querySelector<HTMLElement>('[data-config-changes]')
    const exportButton = root.querySelector<HTMLButtonElement>('[data-config-export]'), preview = root.querySelector<HTMLButtonElement>('[data-config-preview]'), apply = root.querySelector<HTMLButtonElement>('[data-config-apply]')
    let reviewed: { files: Record<string, string>; revision: string } | null = null
    const MARK = '# xpanel-file: '
    const read = async (): Promise<Record<string, string>> => {
      const text = await file!.files![0]!.text(), files: Record<string, string> = {}
      for (const part of text.split(MARK).slice(1)) { const at = part.indexOf('\n'); files[part.slice(0, at).trim()] = part.slice(at + 1) }
      return files
    }
    exportButton?.addEventListener('click', () => { void (async () => {
      try { const view = await send!('GET', '/api/server/config-as-code/export') as { files: Record<string, string> }; save('xpanel-configuration.yaml', Object.entries(view.files).map(([path, text]) => MARK + path + '\n' + text).join(''), 'text/yaml'); status('read', t('The configuration was exported.')) }
      catch (error) { status('failed', reasonText(error)) }
    })() })
    preview?.addEventListener('click', () => { void (async () => {
      if (!file?.files?.[0]) { status('failed', t('Choose a file first.')); return }
      try {
        const files = await read(), view = await send!('POST', '/api/server/config-as-code/preview', { files }) as Rec
        reviewed = { files, revision: view.revision }
        rows(body, view.changes.flatMap((change: Rec) => change.fields.map((row: Rec) => [change.path, row.field, JSON.stringify(row.from), JSON.stringify(row.to), change.reason ? t('Cannot be imported') : change.kind === 'added' ? t('Added') : t('Changed')])), t('The import changes nothing.'), 5)
        if (apply) apply.disabled = !view.applicable || !view.changes.length
        status('read', t('{count} files change.', { count: view.changes.length }))
      } catch (error) { reviewed = null; if (apply) apply.disabled = true; status('failed', reasonText(error)) }
    })() })
    apply?.addEventListener('click', () => { void (async () => {
      if (!reviewed || !await confirmed(t('Apply this import?'), t('The changes go through the normal reconcile, with configuration tests and rollback.'))) return
      try { const view = await send!('POST', '/api/server/config-as-code/apply', { files: reviewed.files, expectedRevision: reviewed.revision }) as Rec; reviewed = null; apply.disabled = true; status('read', t('{count} changes applied.', { count: view.applied })) }
      catch (error) { status('failed', reasonText(error)) }
    })() })
    if (allowed(root)) { if (exportButton) exportButton.disabled = false; if (preview) preview.disabled = false; if (file) file.disabled = false; status('unread', t('No import has been previewed.')) }
  })

  document.querySelectorAll<HTMLElement>('[data-panel-backups]').forEach(root => {
    if (!setup(root, 'panelBackupsBound')) return
    const status = noteOf(root.querySelector('[data-panel-backup-status]')), select = root.querySelector<HTMLSelectElement>('[data-panel-backup-select]'), body = root.querySelector<HTMLElement>('[data-panel-backup-rows]')
    const file = root.querySelector<HTMLInputElement>('[data-panel-backup-file]'), overwrite = root.querySelector<HTMLInputElement>('[data-panel-backup-overwrite]'), report = root.querySelector<HTMLElement>('[data-panel-backup-report]'), folder = root.querySelector<HTMLElement>('[data-panel-backup-folder]')
    const load = async (): Promise<void> => {
      try {
        const view = await send!('GET', '/api/server/panel-backups') as Rec
        if (folder) folder.textContent = view.folder
        rows(body, view.backups.map((row: Rec) => [row.file, when(row.createdAt), size(row.bytes)]), t('No snapshots exist.'), 3)
        options(select, view.backups.map((row: Rec) => [row.file, row.file] as const), t('Select a snapshot'))
        for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = false
        status('read', t('{count} snapshots.', { count: view.backups.length }))
      } catch (error) { status('failed', reasonText(error)) }
    }
    const act = async (key: string): Promise<void> => {
      const name = select?.value ?? ''
      if (key === 'refresh') return load()
      try {
        if (key === 'create') { status('reading', t('Building a snapshot…')); await send!('POST', '/api/server/panel-backups', { op: 'create' }); await load(); return }
        if (key === 'upload') {
          const chosen = file?.files?.[0]
          if (!chosen || !/^xpanel-control-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.(?:gz|zst)$/.test(chosen.name)) { status('failed', t('Choose an xPanel snapshot file.')); return }
          const bytes = new Uint8Array(await chosen.arrayBuffer()), digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(item => item.toString(16).padStart(2, '0')).join(''), chunk = 1048576
          for (let offset = 0; offset < bytes.length; offset += chunk) {
            const piece = bytes.subarray(offset, offset + chunk), done = offset + chunk >= bytes.length
            await send!('POST', '/api/server/panel-backups', { op: 'upload', file: chosen.name, offset, data: btoa(String.fromCharCode(...piece)), done, ...(done ? { sha256: digest } : {}) })
            status('reading', t('Uploading {percent}%', { percent: Math.min(100, Math.round((offset + piece.length) / bytes.length * 100)) }))
          }
          await load(); return
        }
        if (!name) { status('failed', t('Select a snapshot.')); return }
        if (key === 'download') { const response = await fetch('/api/server/panel-backups/' + encodeURIComponent(name), { credentials: 'same-origin' }); if (!response.ok) throw await response.json().catch(() => ({})); save(name, await response.blob(), 'application/octet-stream'); return }
        if (key === 'delete') { if (await confirmed(t('Delete {name}?', { name }), t('This cannot be undone.'))) { await send!('POST', '/api/server/panel-backups', { op: 'delete', file: name }); await load() } return }
        if (await confirmed(t('Restore {name}?', { name }), overwrite?.checked ? t('Existing items with the same name are replaced.') : t('Existing items with the same name stay unchanged and are reported as skipped.'))) {
          status('reading', t('Restoring…'))
          const view = await send!('POST', '/api/server/panel-backups', { op: 'restore', file: name, overwrite: overwrite?.checked === true }) as Rec
          if (report) { report.textContent = view.skippedItems.join('\n'); report.hidden = !view.skippedItems.length }
          status(view.reconcile === 'failed' ? 'failed' : 'read', t('{restored} restored, {skipped} skipped.', { restored: view.restored, skipped: view.skipped }))
        }
      } catch (error) { status('failed', reasonText(error)) }
    }
    root.querySelectorAll<HTMLButtonElement>('[data-panel-backup-action]').forEach(control => { control.addEventListener('click', () => { void act(control.dataset.panelBackupAction as string) }) })
    if (allowed(root)) { const refresh = root.querySelector<HTMLButtonElement>('[data-panel-backup-action="refresh"]'); if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-api-shell]').forEach(root => {
    if (!setup(root, 'shellBound')) return
    const surface = root.dataset.apiShellSurface, base = surface === 'account' ? '/api/account/developer' : '/api/server/panel/developer'
    const q = <T extends HTMLElement>(selector: string): T | null => pick<T>(root, selector)
    const status = noteOf(q('[data-shell-status]')), fn = q<HTMLSelectElement>('[data-shell-function]'), params = q<HTMLTextAreaElement>('[data-shell-params]'), run = q<HTMLButtonElement>('[data-shell-run]'), refresh = q<HTMLButtonElement>('[data-shell-refresh]'), openapi = q<HTMLButtonElement>('[data-shell-openapi]')
    const tree = q('[data-shell-tree]'), table = q('[data-shell-table]'), headers = q('[data-shell-headers]'), raw = q('[data-shell-raw]'), view = q<HTMLSelectElement>('[data-shell-view]'), token = q<HTMLInputElement>('[data-shell-token]')
    const field = (selector: string): string => (q<HTMLInputElement>(selector)?.value ?? '').trim()
    let list: Rec[] = [], command = 'xwhmapi', last: Rec | null = null
    const chosen = (): Rec | undefined => list.find(item => item.module + '.' + item.fn === fn?.value)
    const parsed = (): Record<string, string> => Object.fromEntries((params?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => { const at = line.indexOf('='); return at < 1 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)] }))
    const url = (item: Rec, values: Record<string, string>): { path: string; rest: Record<string, string> } => {
      const rest = { ...values }
      const path = item.path.replace(/\{([a-zA-Z]+)\}/g, (_: string, name: string) => { const value = rest[name] ?? '{' + name + '}'; delete rest[name]; return encodeURIComponent(value).replace(/%7B|%7D/g, '') })
      return { path, rest }
    }
    const preview = (): void => {
      const item = chosen(), values = parsed(), set = (selector: string, text: string): void => { const cell = q(selector); if (cell) cell.textContent = text }
      if (!item) { for (const selector of ['[data-shell-preview]', '[data-shell-cli]', '[data-shell-curl]']) set(selector, ''); return }
      const { path, rest } = url(item, values), query = item.method === 'GET' || item.method === 'DELETE' ? new URLSearchParams(rest).toString() : '', body = query || !Object.keys(rest).length ? '' : JSON.stringify(rest), target = path + (query ? '?' + query : '')
      set('[data-shell-preview]', item.method + ' ' + target + (body ? ' ' + body : ''))
      set('[data-shell-cli]', [command, item.module, item.fn, ...Object.entries(values).map(([key, value]) => key + '=' + value)].join(' '))
      set('[data-shell-curl]', `curl -X ${item.method} -H 'authorization: Bearer $TOKEN'${body ? ` -H 'content-type: application/json' -d '${body}'` : ''} '${location.origin}${target}'`)
    }
    const node = (value: unknown, name: string): HTMLElement => {
      const item = document.createElement('li')
      if (value && typeof value === 'object') { const details = document.createElement('details'), summary = document.createElement('summary'), list2 = document.createElement('ul'); summary.textContent = name; details.append(summary, list2); for (const [key, child] of Object.entries(value).slice(0, 500)) list2.append(node(child, key)); item.append(details) }
      else item.textContent = name + ': ' + String(value)
      return item
    }
    const paintView = (): void => { const mode = view?.value ?? 'tree'; if (tree) tree.hidden = mode !== 'tree'; const wrap = table?.closest('table')?.parentElement; if (wrap) wrap.hidden = mode !== 'table'; if (raw) raw.hidden = mode !== 'raw' || !last; if (headers) headers.hidden = mode !== 'raw' || !last }
    const paint = (reply: Rec): void => {
      last = reply
      const data = reply.json as unknown, records = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data as Rec).find(Array.isArray) as unknown[] | undefined : undefined
      if (tree) { const list3 = document.createElement('ul'); list3.append(node(data, t('Response'))); tree.replaceChildren(list3) }
      if (table) {
        const flat = Array.isArray(records) && records.every(row => row && typeof row === 'object') ? records as Rec[] : null, columns = flat ? [...new Set(flat.flatMap(row => Object.keys(row)))].slice(0, 16) : []
        const headRow = table.closest('table')?.querySelector('thead tr')
        if (headRow && flat) headRow.replaceChildren(...columns.map(name => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = name; return cell }))
        rows(table, flat ? flat.map(row => columns.map(name => { const value = row[name]; return value && typeof value === 'object' ? JSON.stringify(value) : value === undefined || value === null ? '' : String(value) })) : [], t('This result has no table.'), Math.max(1, columns.length))
      }
      if (headers) headers.textContent = 'HTTP ' + reply.status + '\n' + reply.headers.map(([name, value]: string[]) => name + ': ' + value).join('\n')
      if (raw) raw.textContent = reply.raw
      paintView()
      status(reply.status < 400 ? 'read' : 'failed', reply.pagination ? t('HTTP {status}: {returned} of {total} records.', { status: reply.status, returned: reply.pagination.returned, total: reply.pagination.total }) : t('HTTP {status}.', { status: reply.status }))
    }
    const shape = (): Rec => {
      const out: Rec = { start: Number(field('[data-shell-start]')) || 0, limit: Number(field('[data-shell-limit]')) || 0 }
      if (field('[data-shell-filter-column]')) out.filters = [{ column: field('[data-shell-filter-column]'), type: field('[data-shell-filter-type]'), value: field('[data-shell-filter-value]') }]
      if (field('[data-shell-sort-column]')) out.sorts = [{ column: field('[data-shell-sort-column]'), method: field('[data-shell-sort-method]'), reverse: q<HTMLInputElement>('[data-shell-sort-reverse]')?.checked === true }]
      if (field('[data-shell-columns]')) out.columns = field('[data-shell-columns]').split(',').map(name => name.trim()).filter(Boolean)
      return out
    }
    const load = async (): Promise<void> => {
      try {
        const reply = await send!('GET', base + '/functions') as Rec
        list = reply.functions; command = reply.command
        options(fn, list.map(item => [item.module + '.' + item.fn, item.module + ' ' + item.fn + ' (' + item.method + ')'] as const), t('Select a function'))
        for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) control.disabled = false
        status('read', t('{count} functions.', { count: list.length }))
      } catch (error) { status('failed', reasonText(error)) }
    }
    const direct = async (item: Rec): Promise<void> => {
      const { path, rest } = url(item, parsed()), query = item.method === 'GET' || item.method === 'DELETE' ? new URLSearchParams(rest).toString() : '', hasBody = !query && Object.keys(rest).length > 0
      const response = await fetch(path + (query ? '?' + query : ''), { method: item.method, credentials: 'omit', headers: { authorization: 'Bearer ' + token!.value.trim(), ...(hasBody ? { 'content-type': 'application/json' } : {}) }, ...(hasBody ? { body: JSON.stringify(rest) } : {}) })
      const text = await response.text()
      let json: unknown = null
      try { json = JSON.parse(text) } catch { json = null }
      paint({ status: response.status, headers: [...response.headers].filter(([name]) => name !== 'set-cookie'), json, raw: json === null ? text : JSON.stringify(json, null, 2), pagination: null })
    }
    run?.addEventListener('click', () => { void (async () => {
      const item = chosen()
      if (!item) { status('failed', t('Select a function.')); return }
      if (item.method !== 'GET' && !await confirmed(t('Run this call?'), t('This call changes real data.'))) return
      try { if (token?.value.trim()) await direct(item); else paint(await send!('POST', base + '/call', { module: item.module, fn: item.fn, params: parsed(), shape: shape() }) as Rec) }
      catch (error) { status('failed', reasonText(error)) }
    })() })
    openapi?.addEventListener('click', () => { void (async () => { try { save('xpanel-openapi.json', JSON.stringify(await send!('GET', base + '/openapi'), null, 2), 'application/json') } catch (error) { status('failed', reasonText(error)) } })() })
    fn?.addEventListener('change', preview); params?.addEventListener('input', preview); view?.addEventListener('change', paintView); refresh?.addEventListener('click', () => { void load() })
    paintView()
    if (allowed(root)) { if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-account-packages]').forEach(root => {
    if (!setup(root, 'packagesBound')) return
    const q = <T extends HTMLElement>(selector: string): T | null => pick<T>(root, selector)
    const status = noteOf(q('[data-packages-status]')), select = q<HTMLSelectElement>('[data-packages-select]'), name = q<HTMLInputElement>('[data-packages-name]'), search = q<HTMLInputElement>('[data-packages-search]')
    let view: Rec | null = null
    const paint = (value: Rec): void => {
      view = value
      const set = (selector: string, text: string): void => { const cell = q(selector); if (cell) cell.textContent = text }
      set('[data-packages-library]', value.library); set('[data-packages-php]', value.phpVersion ?? t('Not read')); set('[data-packages-snippet]', value.includeSnippet)
      rows(q('[data-packages-installed]'), value.packages.map((row: Rec) => [row.name, row.version]), t('No packages are installed.'), 2)
      rows(q('[data-packages-system]'), value.system.map((row: Rec) => [row.name, row.version ?? t('System')]), t('No packages were read.'), 2)
      if (value.results.length) rows(q('[data-packages-results]'), value.results.map((row: Rec) => [row.name, row.version, row.summary]), '', 3)
      options(select, value.packages.map((row: Rec) => [row.name, row.name] as const), t('Select a package'))
      for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = !value.engine
      const refresh = q<HTMLButtonElement>('[data-packages-refresh]'); if (refresh) refresh.disabled = false
      status(value.engine ? 'read' : 'failed', value.engine ? t('{count} packages installed.', { count: value.packages.length }) : t('PEAR is not installed for this PHP version. Ask your host to install {name}.', { name: value.requiredPackage ?? 'php-pear' }))
    }
    const load = async (): Promise<void> => { try { paint(await send!('GET', '/api/account/packages') as Rec) } catch (error) { status('failed', reasonText(error)) } }
    root.querySelectorAll<HTMLButtonElement>('[data-package-op]').forEach(control => { control.addEventListener('click', () => { void (async () => {
      const op = control.dataset.packageOp as string, target = op === 'install' ? name?.value.trim() : select?.value
      if (!target || !view) { status('failed', t('Choose a package.')); return }
      if (op === 'remove' && !await confirmed(t('Uninstall {name}?', { name: target }), t('Its files are removed from your library.'))) return
      status('reading', t('The installer is running…'))
      try { paint(await send!('POST', '/api/account/packages', { op, name: target, expectedRevision: view.revision }) as Rec) } catch (error) { status('failed', reasonText(error)) }
    })() }) })
    q('[data-packages-search-run]')?.addEventListener('click', () => { void (async () => {
      if (!search?.value.trim()) { status('failed', t('Enter a search word.')); return }
      try { const reply = await send!('POST', '/api/account/packages', { op: 'search', query: search.value.trim() }) as Rec; paint(reply); if (!reply.results.length) rows(q('[data-packages-results]'), [], t('No package matched.'), 3) } catch (error) { status('failed', reasonText(error)) }
    })() })
    q('[data-packages-docs]')?.addEventListener('click', () => { if (select?.value) window.open('https://pear.php.net/package/' + encodeURIComponent(select.value), '_blank', 'noopener') })
    q('[data-packages-refresh]')?.addEventListener('click', () => { void load() })
    if (allowed(root)) { const refresh = q<HTMLButtonElement>('[data-packages-refresh]'); if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-plugin-import]').forEach(root => {
    if (!setup(root, 'pluginImportBound')) return
    const q = <T extends HTMLElement>(selector: string): T | null => pick<T>(root, selector)
    const status = noteOf(q('[data-plugin-import-status]')), file = q<HTMLInputElement>('[data-plugin-import-file]'), overwrite = q<HTMLInputElement>('[data-plugin-import-overwrite]'), run = q<HTMLButtonElement>('[data-plugin-import-run]')
    run?.addEventListener('click', () => { void (async () => {
      const chosen = file?.files?.[0]
      if (!chosen) { status('failed', t('Choose a package file.')); return }
      let parsed: unknown
      try { parsed = JSON.parse(await chosen.text()) } catch { status('failed', t('The file is not an xPanel plugin package.')); return }
      try { await send!('POST', '/api/server/plugins', { package: parsed, overwrite: overwrite?.checked === true }); status('read', t('The plugin was installed.')) } catch (error) { status('failed', reasonText(error)) }
    })() })
    if (allowed(root)) { for (const control of [file, overwrite, run]) if (control) control.disabled = false }
  })

  document.querySelectorAll<HTMLElement>('[data-sw-projects-manager]').forEach(root => {
    if (!setup(root, 'projectsBound')) return
    const q = <T extends HTMLElement>(selector: string): T | null => pick<T>(root, selector)
    const status = noteOf(q('[data-sw-project-status]')), select = q<HTMLSelectElement>('[data-sw-project-select]'), account = q<HTMLSelectElement>('[data-sw-project-account]'), domain = q<HTMLSelectElement>('[data-sw-project-domain]'), log = q('[data-sw-project-log]')
    const value = (selector: string): string => (q<HTMLInputElement>(selector)?.value ?? '').trim()
    let view: Rec | null = null
    const found = (): { row: Rec; project: Rec } | null => { const [user, name] = (select?.value ?? '').split('/'); const row = view?.accounts.find((item: Rec) => item.account === user), project = row?.projects.find((item: Rec) => item.name === name); return row && project ? { row, project } : null }
    const domains = (): void => { const row = view?.accounts.find((item: Rec) => item.account === account?.value); options(domain, (row?.domains ?? []).map((item: Rec) => [item.id, item.name] as const), t('Select a domain')) }
    const load = async (): Promise<void> => {
      try {
        view = await send!('GET', '/api/server/application-projects') as Rec
        const projects: Rec[] = view!.accounts.flatMap((row: Rec) => row.projects.map((project: Rec) => ({ ...project, account: row.account })))
        rows(q('[data-sw-projects-rows]'), projects.map(item => [item.name, item.account, item.runtime === 'go' ? 'Go' : 'Java' + (item.jdk ? ' ' + item.jdk : ''), item.port, (item.domain ?? '') + item.path, item.state]), t('No projects exist.'), 6)
        options(select, projects.map(item => [item.account + '/' + item.name, item.account + ' / ' + item.name] as const), t('Select a project'))
        options(account, view!.accounts.map((row: Rec) => [row.account, row.account] as const), t('Select an account'))
        domains()
        for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) control.disabled = !view!.available
        const refresh = q<HTMLButtonElement>('[data-sw-project-refresh]'); if (refresh) refresh.disabled = false
        status('read', view!.available ? t('{count} projects.', { count: projects.length }) : t('Projects need a Linux host with the reconciler.'))
      } catch (error) { status('failed', reasonText(error)) }
    }
    const apply = async (user: string, op: Rec): Promise<void> => { await send!('POST', '/api/server/application-projects', { account: user, op }); await load() }
    q('[data-sw-project-save]')?.addEventListener('click', () => { void (async () => {
      const row = view?.accounts.find((item: Rec) => item.account === account?.value)
      if (!row) { status('failed', t('Select an account.')); return }
      const env = Object.fromEntries(value('[data-sw-project-env]').split('\n').map(line => line.trim()).filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
      try { await apply(row.account, { op: 'project.save', expectedRevision: row.revision, app: { name: value('[data-sw-project-name]'), runtime: value('[data-sw-project-runtime]'), root: value('[data-sw-project-root]'), startup: value('[data-sw-project-startup]'), domainId: value('[data-sw-project-domain]'), path: value('[data-sw-project-path]') || '/', env, port: value('[data-sw-project-port]') ? Number(value('[data-sw-project-port]')) : null, openPort: q<HTMLInputElement>('[data-sw-project-open]')?.checked === true, jdk: value('[data-sw-project-runtime]') === 'java' && value('[data-sw-project-jdk]') ? value('[data-sw-project-jdk]') : null, command: value('[data-sw-project-command]') || null } }); status('read', t('The project was saved.')) }
      catch (error) { status('failed', reasonText(error)) }
    })() })
    root.querySelectorAll<HTMLButtonElement>('[data-sw-project-action]').forEach(control => { control.addEventListener('click', () => { void (async () => {
      const chosen = found()
      if (!chosen) { status('failed', t('Select a project.')); return }
      const op = control.dataset.swProjectAction as string
      if (op === 'app.remove' && !await confirmed(t('Remove {name}?', { name: chosen.project.name }), t('The service stops and its saved settings are removed. Its files stay in the account home.'))) return
      try { await apply(chosen.row.account, { op, expectedRevision: chosen.row.revision, name: chosen.project.name }) } catch (error) { status('failed', reasonText(error)) }
    })() }) })
    q('[data-sw-project-log-read]')?.addEventListener('click', () => { void (async () => {
      const chosen = found()
      if (!chosen) { status('failed', t('Select a project.')); return }
      try { const reply = await send!('GET', '/api/server/application-projects/log?account=' + encodeURIComponent(chosen.row.account) + '&target=' + encodeURIComponent('app:' + chosen.project.name)) as Rec; if (log) { log.textContent = reply.lines.join('\n') || t('The log is empty.'); log.hidden = false } }
      catch (error) { status('failed', reasonText(error)) }
    })() })
    account?.addEventListener('change', domains); q('[data-sw-project-refresh]')?.addEventListener('click', () => { void load() })
    if (allowed(root)) { const refresh = q<HTMLButtonElement>('[data-sw-project-refresh]'); if (refresh) refresh.disabled = false; void load() }
  })

  document.querySelectorAll<HTMLElement>('[data-python-runtimes]').forEach(root => {
    if (!setup(root, 'pythonBound')) return
    const q = <T extends HTMLElement>(selector: string): T | null => pick<T>(root, selector)
    const status = noteOf(q('[data-python-status]')), select = q<HTMLSelectElement>('[data-python-env-select]'), account = q<HTMLSelectElement>('[data-python-env-account]'), version = q<HTMLSelectElement>('[data-python-env-version]'), name = q<HTMLInputElement>('[data-python-env-name]')
    let view: Rec | null = null
    const load = async (): Promise<void> => {
      try {
        view = await send!('GET', '/api/server/application-projects') as Rec
        const envs: Rec[] = view!.accounts.flatMap((row: Rec) => row.environments.map((env: Rec) => ({ ...env, account: row.account })))
        rows(q('[data-python-versions]'), view!.python.map((row: Rec) => ['Python ' + row.version, row.installed ? t('Installed') : t('Not installed'), row.full ?? '']), t('No interpreter was read.'), 3)
        rows(q('[data-python-envs]'), envs.map(env => [env.name, env.account, env.version, env.state === 'failed' ? t('Failed') : env.state === 'running' ? t('Creating') : t('Ready')]), t('No environments exist.'), 4)
        options(select, envs.map(env => [env.account + '/' + env.name, env.account + ' / ' + env.name] as const), t('Select an environment'))
        options(account, view!.accounts.map((row: Rec) => [row.account, row.account] as const), t('Select an account'))
        options(version, view!.python.filter((row: Rec) => row.installed).map((row: Rec) => [row.version, 'Python ' + row.version] as const), t('Select a version'))
        for (const control of root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button')) control.disabled = !view!.available
        const refresh = q<HTMLButtonElement>('[data-python-refresh]'); if (refresh) refresh.disabled = false
        status('read', t('{count} environments.', { count: envs.length }))
      } catch (error) { status('failed', reasonText(error)) }
    }
    const apply = async (user: string, op: Rec): Promise<void> => { await send!('POST', '/api/server/application-projects', { account: user, op }); await load() }
    q('[data-python-env-create]')?.addEventListener('click', () => { void (async () => {
      const row = view?.accounts.find((item: Rec) => item.account === account?.value)
      if (!row || !name?.value.trim() || !version?.value) { status('failed', t('Choose an account, a name and a version.')); return }
      try { await apply(row.account, { op: 'pyenv.create', expectedRevision: row.revision, name: name.value.trim(), version: version.value }) } catch (error) { status('failed', reasonText(error)) }
    })() })
    q('[data-python-env-remove]')?.addEventListener('click', () => { void (async () => {
      const [user, env] = (select?.value ?? '').split('/'), row = view?.accounts.find((item: Rec) => item.account === user)
      if (!row || !env) { status('failed', t('Select an environment.')); return }
      if (await confirmed(t('Remove {name}?', { name: env }), t('The environment folder is deleted from the account home.'))) try { await apply(row.account, { op: 'pyenv.remove', expectedRevision: row.revision, name: env }) } catch (error) { status('failed', reasonText(error)) }
    })() })
    q('[data-python-refresh]')?.addEventListener('click', () => { void load() })
    if (allowed(root)) { const refresh = q<HTMLButtonElement>('[data-python-refresh]'); if (refresh) refresh.disabled = false; void load() }
  })
}

export const PANEL_TOOLS_CLIENT_BINDING = bindPanelTools.toString()
