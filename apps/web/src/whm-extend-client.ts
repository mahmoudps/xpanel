/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest

type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>
const displayDateTime = formatDisplayDateTime
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate

/**
 * Root workspaces of WHM Demo Mode, Hooks, Registered Applications, Plugins, Theme Manager and Site Software, and the
 * plugin icons on the account home page. Each binds by its data-* root in either theme, paints text only (cells,
 * options and statuses carry no styling; home links clone the theme's template), sends one revision-bound change at
 * a time and repaints from the server's answer, never from its own guess.
 */
function bindWhmExtend(askDialog: Ask | undefined): void {
  const t = (message: string, values?: Record<string, string | number>): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  // A spread of one argument per byte overflows the stack on an archive of 1 MiB.
  const base64 = (bytes: Uint8Array): string => { let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return btoa(text) }
  const when = (value: unknown): string => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? displayDateTime(value) : t('Not read')
  const REASONS: Record<string, string> = {
    demo_mode_readonly: t('This account is in demo mode. It can be viewed but not changed.'),
    unknown_account: t('One of the accounts no longer exists. Reload and try again.'),
    hook_path_not_reviewed: t('Only files in the reviewed hook directory can be registered.'),
    hook_executable_missing: t('The executable does not exist in the reviewed hook directory.'),
    hook_executable_untrusted: t('The executable or one of its folders is not owned by root or can be changed by other users.'),
    hook_executable_mode: t('The executable must be readable and executable by everyone, and must not be setuid or setgid.'),
    hook_executable_changed: t('The file changed after it was registered, so it does not run. Register it again after review.'),
    hooks_unavailable: t('Hooks need the host agent on this server.'),
    hook_blocked: t('A pre-stage hook refused this action.'),
    package_format: t('The file is not an xPanel theme package.'),
    package_id: t('The theme id must be 2 to 32 lowercase letters, digits and dashes, starting with a letter.'),
    theme_id_reserved: t('A built-in theme already uses this id.'),
    package_name: t('The theme name must be plain text of up to 40 characters.'),
    package_version: t('The version must be MAJOR.MINOR.PATCH.'),
    package_base: t('The base must be a built-in theme.'),
    package_tokens: t('The package must list light and dark token values.'),
    token_not_allowed: t('The package changes a token the base theme does not allow.'),
    token_value_invalid: t('A token value is not a #rrggbb color or a 0px to 32px radius.'),
    missing_required_token: t('The package is missing a required token value.'),
    insufficient_contrast: t('Text and its background need a contrast ratio of at least 4.5:1.'),
    theme_exists: t('A theme with this id is installed. Delete it first.'),
    theme_limit: t('The most theme packages are installed. Delete one first.'),
    built_in_theme: t('Built-in themes cannot be changed or downloaded.'),
    catalog_invalid: t('The catalog is not correctly signed, is older than the stored one or has expired.'),
    catalog_signer_untrusted: t('The catalog is signed by a key that is not a trusted release key.'),
    release_keys_unavailable: t('No trusted release signing key is configured on this server.'),
    application_not_in_catalog: t('Only applications of the verified signed catalog can be offered.'),
    installed_release_unavailable: t('The signed catalog needs an installed release.'),
    host_agent_unavailable: t('This needs the host agent on this server.'),
    plugin_package_format: t('The file is not an xPanel plugin package.'),
    plugin_name: t('The plugin name must be 1 to 64 lowercase letters, digits, hyphens and underscores.'),
    plugin_items: t('A plugin has 1 to 16 items.'),
    plugin_item_format: t('An item of this package is not complete.'),
    plugin_item_id: t('The item id must be 1 to 64 lowercase letters, digits, hyphens and underscores.'),
    plugin_item_duplicate: t('Item ids must be unique in a plugin.'),
    plugin_item_name: t('The item name must be plain text of up to 80 characters.'),
    plugin_item_group: t('The group must be plain text of up to 40 characters.'),
    plugin_item_priority: t('The priority must be 1 to 99.'),
    plugin_item_uri: t('The address must be a panel path or an https address.'),
    plugin_item_feature: t('The plan feature must be empty, an xPanel tool id or plugin: and a new key.'),
    plugin_archive_format: t('The file is not a cPanel plugin archive with one install.json.'),
    plugin_archive_entry: t('The archive holds a link or a device. A plugin archive holds only files and directories.'),
    plugin_archive_item: t('install.json holds an entry that is not a group or a link.'),
    plugin_archive_code: t('A link points to a program inside the plugin, and this panel runs no plugin code.'),
    plugin_icon_format: t('The icon must be a PNG or a plain SVG without scripts, styles or links.'),
    plugin_icon_size: t('The icon must be exactly 48 by 48 pixels.'),
    plugin_exists: t('A plugin with this name is installed. Choose to replace it first.'),
    plugin_item_exists: t('Another plugin uses one of these item ids.'),
    plugin_limit: t('The most plugins are installed. Delete one first.'),
  }
  const failure = (error: unknown): { kind: string; message: string } => {
    const problem = object(error) ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}
    const details = object(problem.details) ? problem.details : {}, reason = typeof details.reason === 'string' ? details.reason : ''
    if (details.unknownOutcome === true || details.verificationRequired === true) return { kind: 'unknown', message: t('The outcome is unknown. Reload and review before trying again.') }
    if (REASONS[reason]) return { kind: 'refused', message: REASONS[reason]! }
    if (problem.status === 401 || problem.status === 403) return { kind: 'denied', message: t('Authorization is no longer valid. Nothing was changed.') }
    if (problem.status === 409 || problem.code === 'CONFLICT') return { kind: 'conflict', message: t('The saved configuration changed before this action. Nothing was changed; reload and review.') }
    if (problem.status === 400 || problem.status === 422 || problem.code === 'VALIDATION') return { kind: 'invalid', message: t('The server refused the values. Nothing was changed; check the fields and try again.') }
    return details.stateChanged === false ? { kind: 'refused', message: t('The request was refused. Nothing was changed.') } : { kind: 'unknown', message: t('The outcome is unknown. Reload and review before trying again.') }
  }
  const confirm = async (title: string, body: string, label: string): Promise<boolean> => {
    if (!askDialog) return false
    try { return await askDialog({ title, body, confirm: label }) === true } catch { return false }
  }
  /** Common frame of one workspace root: status lines, single-flight work and admission. */
  // A reader (registered applications) also reads inside a read-only frame; frameRequest refuses its writes there.
  const frame = (root: HTMLElement, status: HTMLElement | null, result: HTMLElement | null, canManage: boolean, reads = false) => {
    let busy = false
    const request = frameRequest(root)
    const controls: (() => void)[] = []
    const admitted = (): boolean => root.isConnected && typeof request === 'function'
      && (reads || !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],fieldset:disabled'))
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const show = (kind: string, message: string): void => { if (!result) return; result.hidden = false; result.dataset.outcome = kind; result.textContent = message; result.setAttribute('role', kind === 'read' ? 'status' : 'alert') }
    const lock = (): void => { root.setAttribute('aria-busy', String(busy)); for (const control of controls) control() }
    const guarded = async (work: () => Promise<void>): Promise<void> => { if (busy || !admitted()) return; busy = true; lock(); try { await work() } finally { busy = false; lock() } }
    const send = (method: string, path: string, body?: unknown): Promise<unknown> => request!(method, path, body)
    const editable = (): boolean => !busy && canManage && admitted()
    return { admitted, note, show, lock, guarded, send, editable, controls }
  }
  const rows = (body: HTMLElement | null, data: string[][], empty: string, columns: number): void => {
    if (!body) return
    body.textContent = ''
    for (const cells of data) { const row = document.createElement('tr'); for (const content of cells) { const cell = document.createElement('td'); cell.textContent = content; row.append(cell) } body.append(row) }
    if (!data.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = empty; row.append(cell); body.append(row) }
  }
  const options = (select: HTMLSelectElement | null, items: [string, string][], placeholder: string): void => {
    if (!select) return
    const current = select.value
    select.textContent = ''
    const first = document.createElement('option'); first.value = ''; first.textContent = placeholder; select.append(first)
    for (const [value, label] of items) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option) }
    select.value = items.some(([value]) => value === current) ? current : ''
  }
  const unavailable = t('This page is unavailable here. Nothing was read or changed.')

  document.querySelectorAll<HTMLElement>('[data-demo-mode-workspace]').forEach(root => {
    if (root.dataset.demoModeBound === 'true') return
    root.dataset.demoModeBound = 'true'
    const f = frame(root, root.querySelector('[data-demo-mode-status]'), root.querySelector('[data-demo-mode-result]'), root.dataset.demoModeCanManage === 'true')
    const select = root.querySelector<HTMLSelectElement>('[data-demo-mode-account]'), enable = root.querySelector<HTMLButtonElement>('[data-demo-mode-enable]')
    const disable = root.querySelector<HTMLButtonElement>('[data-demo-mode-disable]'), refresh = root.querySelector<HTMLButtonElement>('[data-demo-mode-refresh]')
    type Account = { id: string; username: string; primaryDomain: string; status: string }
    let view: { state: string; accountIds: string[] | null; revision: string; accounts: Account[] } | null = null
    f.controls.push(() => {
      const ids = view?.accountIds ?? null, id = select?.value ?? '', ready = !!view && view.state !== 'invalid' && !!ids && f.editable() && !!view.accounts.find(item => item.id === id)
      if (select) select.disabled = !view || !f.editable()
      if (enable) enable.disabled = !ready || ids!.includes(id)
      if (disable) disable.disabled = !ready || !ids!.includes(id)
      if (refresh) refresh.disabled = !f.admitted()
    })
    if (!f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const read = (value: unknown): NonNullable<typeof view> => {
      if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !Array.isArray(value.accounts)
        || !(value.accountIds === null || Array.isArray(value.accountIds) && value.accountIds.every(id => typeof id === 'string'))) throw new Error('invalid_demo_mode_view')
      const accounts = value.accounts.map(item => object(item) && typeof item.id === 'string' && typeof item.username === 'string' && typeof item.primaryDomain === 'string' && typeof item.status === 'string'
        ? { id: item.id, username: item.username, primaryDomain: item.primaryDomain, status: item.status } : null)
      if (accounts.some(item => item === null)) throw new Error('invalid_demo_mode_view')
      return { state: value.state as string, accountIds: value.accountIds as string[] | null, revision: value.revision, accounts: accounts as Account[] }
    }
    const paint = (next: NonNullable<typeof view>): void => {
      view = next
      const demo = next.accountIds ?? []
      rows(root.querySelector('[data-demo-mode-rows]'), next.accounts.filter(account => demo.includes(account.id)).map(account => [account.username, account.primaryDomain, account.status === 'active' ? t('Active') : account.status === 'suspended' ? t('Suspended') : account.status]),
        next.state === 'invalid' ? t('The saved demo mode list could not be verified. Changes by account users are refused until it is reviewed.') : t('No account is in demo mode.'), 3)
      options(select, next.accounts.map(account => [account.id, demo.includes(account.id) ? t('{name} (demo mode)', { name: account.username }) : account.username]), t('Select an account'))
      f.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved demo mode list could not be verified. Changes by account users are refused until it is reviewed.') : t('Read from this server.'))
    }
    const load = (): Promise<void> => f.guarded(async () => { f.note('reading', t('Reading…')); try { paint(read(await f.send('GET', '/api/server/demo-mode'))) } catch (error) { view = null; f.note('failed', failure(error).message) } })
    const change = (on: boolean): Promise<void> => f.guarded(async () => {
      const current = view, id = select?.value ?? '', account = current?.accounts.find(item => item.id === id)
      if (!current || !current.accountIds || !account) return
      if (!await confirm(on ? t('Turn on demo mode?') : t('Turn off demo mode?'), on ? t('Users of {name} can still sign in and look around, but every change through the panels, the API and the command line is refused.', { name: account.username }) : t('Users of {name} can change their account again.', { name: account.username }), on ? t('Turn on demo mode') : t('Turn off demo mode'))) return
      const known = current.accountIds.filter(item => current.accounts.some(other => other.id === item))
      try {
        const saved = read(await f.send('PUT', '/api/server/demo-mode', { accountIds: on ? [...new Set([...known, id])] : known.filter(item => item !== id), expectedRevision: current.revision }))
        paint(read(await f.send('GET', '/api/server/demo-mode')))
        if (view!.revision !== saved.revision) throw Object.assign(new Error('readback'), { details: { unknownOutcome: true } })
        f.show('read', on ? t('Demo mode is on for {name}.', { name: account.username }) : t('Demo mode is off for {name}.', { name: account.username }))
      } catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    })
    select?.addEventListener('change', () => f.lock())
    enable?.addEventListener('click', () => void change(true))
    disable?.addEventListener('click', () => void change(false))
    refresh?.addEventListener('click', () => void load())
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-hooks-workspace]').forEach(root => {
    if (root.dataset.hooksBound === 'true') return
    root.dataset.hooksBound = 'true'
    const f = frame(root, root.querySelector('[data-hooks-status]'), root.querySelector('[data-hooks-result]'), root.dataset.hooksCanManage === 'true')
    const select = root.querySelector<HTMLSelectElement>('[data-hooks-select]')
    const buttons = { enable: root.querySelector<HTMLButtonElement>('[data-hooks-action="enable"]'), disable: root.querySelector<HTMLButtonElement>('[data-hooks-action="disable"]'),
      up: root.querySelector<HTMLButtonElement>('[data-hooks-action="up"]'), down: root.querySelector<HTMLButtonElement>('[data-hooks-action="down"]'), remove: root.querySelector<HTMLButtonElement>('[data-hooks-action="delete"]') }
    const refresh = root.querySelector<HTMLButtonElement>('[data-hooks-action="refresh"]'), directory = root.querySelector('[data-hooks-directory]')
    type Hook = { id: string; point: string; stage: string; executable: string; enabled: boolean; blocking: boolean; timeoutSeconds: number; description: string }
    let view: { state: string; hooks: Hook[] | null; revision: string; observation: { state: string; hooks: { id: string; state: string }[] } } | null = null
    const selected = (): Hook | undefined => view?.hooks?.find(hook => hook.id === select?.value)
    const peers = (hook: Hook): Hook[] => (view?.hooks ?? []).filter(item => item.point === hook.point && item.stage === hook.stage)
    f.controls.push(() => {
      const hook = selected(), ready = !!hook && f.editable() && view?.state !== 'invalid'
      if (select) select.disabled = !view?.hooks || !f.editable()
      if (buttons.enable) buttons.enable.disabled = !ready || hook!.enabled
      if (buttons.disable) buttons.disable.disabled = !ready || !hook!.enabled
      if (buttons.up) buttons.up.disabled = !ready || peers(hook!)[0]?.id === hook!.id
      if (buttons.down) buttons.down.disabled = !ready || peers(hook!).at(-1)?.id === hook!.id
      if (buttons.remove) buttons.remove.disabled = !ready
      if (refresh) refresh.disabled = !f.admitted()
    })
    if (!f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const read = (value: unknown): NonNullable<typeof view> => {
      if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.observation)
        || !(value.hooks === null || Array.isArray(value.hooks)) || !Array.isArray(value.observation.hooks)) throw new Error('invalid_hooks_view')
      const hooks = value.hooks === null ? null : (value.hooks as unknown[]).map(item => object(item) && typeof item.id === 'string' && typeof item.point === 'string' && typeof item.stage === 'string' && typeof item.executable === 'string'
        && typeof item.enabled === 'boolean' && typeof item.blocking === 'boolean' && typeof item.timeoutSeconds === 'number' && typeof item.description === 'string'
        ? { id: item.id, point: item.point, stage: item.stage, executable: item.executable, enabled: item.enabled, blocking: item.blocking, timeoutSeconds: item.timeoutSeconds, description: item.description } : null)
      if (hooks?.some(item => item === null)) throw new Error('invalid_hooks_view')
      if (directory && typeof value.directory === 'string') directory.textContent = value.directory
      return { state: value.state as string, hooks: hooks as Hook[] | null, revision: value.revision, observation: value.observation as NonNullable<typeof view>['observation'] }
    }
    const events: Record<string, string> = { 'account.create': t('Account created'), 'account.suspend': t('Account suspended'), 'account.unsuspend': t('Account unsuspended'), 'account.terminate': t('Account terminated') }
    const review = (id: string): string => {
      const state = view?.observation.state === 'read' ? view.observation.hooks.find(item => item.id === id)?.state : undefined
      return state === undefined ? t('Not read') : state === 'reviewed' ? t('Unchanged since registration') : REASONS[state] ?? t('Refused')
    }
    const paint = (next: NonNullable<typeof view>): void => {
      view = next
      const hooks = next.hooks ?? []
      rows(root.querySelector('[data-hooks-rows]'), hooks.map(hook => [events[hook.point] ?? hook.point, hook.stage === 'pre' ? t('Before') : t('After'), hook.executable,
        [hook.enabled ? t('Enabled') : t('Disabled'), hook.blocking ? t('Blocking') : t('Not blocking'), t('{seconds} s timeout', { seconds: hook.timeoutSeconds })].join(', '), review(hook.id)]),
        next.state === 'invalid' ? t('The saved hook registry could not be verified. Actions with hooks are refused until it is reviewed.') : t('No hooks are registered.'), 5)
      options(select, hooks.map((hook, index) => [hook.id, `${index + 1}. ${events[hook.point] ?? hook.point} · ${hook.stage === 'pre' ? t('Before') : t('After')} · ${hook.executable.split('/').at(-1)}`]), t('Select a hook'))
      f.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved hook registry could not be verified. Actions with hooks are refused until it is reviewed.')
        : next.observation.state === 'read' ? t('Read from this server.') : t('Saved hooks read. The host agent did not report the executables.'))
    }
    const load = (): Promise<void> => f.guarded(async () => { f.note('reading', t('Reading…')); try { paint(read(await f.send('GET', '/api/server/hooks'))) } catch (error) { view = null; f.note('failed', failure(error).message) } })
    const act = (kind: 'enable' | 'disable' | 'up' | 'down' | 'delete'): Promise<void> => f.guarded(async () => {
      const hook = selected(), current = view
      if (!hook || !current) return
      if (kind === 'delete' && !await confirm(t('Delete this hook?'), t('{file} stops running for its event. The file itself stays on the server.', { file: hook.executable }), t('Delete hook'))) return
      if (kind === 'disable' && !await confirm(t('Disable this hook?'), t('{file} stays registered but does not run until it is enabled again.', { file: hook.executable }), t('Disable hook'))) return
      try {
        const base = '/api/server/hooks/' + hook.id
        paint(read(kind === 'delete' ? await f.send('DELETE', base, { expectedRevision: current.revision })
          : kind === 'up' || kind === 'down' ? await f.send('POST', base + '/move', { direction: kind, expectedRevision: current.revision })
            : await f.send('PATCH', base, { enabled: kind === 'enable', expectedRevision: current.revision })))
        f.show('read', kind === 'delete' ? t('The hook was deleted.') : kind === 'enable' ? t('The hook is enabled.') : kind === 'disable' ? t('The hook is disabled.') : t('The hook order was saved.'))
      } catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    })
    select?.addEventListener('change', () => f.lock())
    buttons.enable?.addEventListener('click', () => void act('enable'))
    buttons.disable?.addEventListener('click', () => void act('disable'))
    buttons.up?.addEventListener('click', () => void act('up'))
    buttons.down?.addEventListener('click', () => void act('down'))
    buttons.remove?.addEventListener('click', () => void act('delete'))
    refresh?.addEventListener('click', () => void load())
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-registered-apps-workspace]').forEach(root => {
    if (root.dataset.registeredAppsBound === 'true') return
    root.dataset.registeredAppsBound = 'true'
    const f = frame(root, root.querySelector('[data-registered-apps-status]'), null, false, true)
    const refresh = root.querySelector<HTMLButtonElement>('[data-registered-apps-refresh]')
    f.controls.push(() => { if (refresh) refresh.disabled = !f.admitted() })
    if (root.dataset.registeredAppsCanRead !== 'true' || !f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const surfaces: Record<string, string> = { xwhm: 'xWHM', xpanel: 'xPanel', xmail: 'xMail' }
    const load = (): Promise<void> => f.guarded(async () => {
      f.note('reading', t('Reading…'))
      try {
        const value = await f.send('GET', '/api/server/registered-apps')
        if (!object(value) || !Array.isArray(value.apps)) throw new Error('invalid_registered_apps')
        rows(root.querySelector('[data-registered-apps-rows]'), (value.apps as unknown[]).filter(object).map(app => app.state === 'registered'
          ? [String(app.displayName), surfaces[String(app.surface)] ?? String(app.surface), [...(app.acls as string[]), ...(app.features as string[])].join(', ') || t('None'), String(app.entryUrl), app.origin === 'internal' ? t('Built in') : String(app.origin), t('Registered')]
          : [String(app.name), t('Not read'), t('Not read'), t('Not read'), String(app.origin), t('Invalid registration ({reason})', { reason: String(app.reason) })]), t('No applications are registered.'), 6)
        f.note('read', value.truncated === true ? t('Read from this server. Only the first 128 registration files are shown.') : t('Read from this server.'))
      } catch (error) { f.note('failed', failure(error).message) }
    })
    refresh?.addEventListener('click', () => void load())
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-plugin-packages-workspace]').forEach(root => {
    if (root.dataset.pluginPackagesBound === 'true') return
    root.dataset.pluginPackagesBound = 'true'
    const f = frame(root, root.querySelector('[data-plugin-packages-status]'), root.querySelector('[data-plugin-packages-result]'), root.dataset.pluginPackagesCanManage === 'true')
    const file = root.querySelector<HTMLInputElement>('[data-plugin-packages-file]'), select = root.querySelector<HTMLSelectElement>('[data-plugin-packages-select]')
    const overwrite = root.querySelector<HTMLInputElement>('[data-plugin-packages-overwrite]'), icon = root.querySelector<HTMLInputElement>('[data-plugin-generator-icon]')
    const inputs = { name: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="name"]'), id: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="id"]'), item: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="item"]'),
      group: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="group"]'), priority: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="priority"]'), uri: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="uri"]'), feature: root.querySelector<HTMLInputElement>('[data-plugin-generator-input="feature"]') }
    const buttons = { install: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="install"]'), download: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="download"]'), remove: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="delete"]'),
      refresh: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="refresh"]'), add: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="add"]'), clear: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="clear"]'), generate: root.querySelector<HTMLButtonElement>('[data-plugin-packages-action="generate"]') }
    type Plugin = { name: string; state: string; items: unknown[]; installedAt: string | null }
    type Item = { id: string; name: string; group: string; priority: number; uri: string; feature: string | null; icon: { type: string; data: string } }
    let plugins: Plugin[] | null = null
    const items: Item[] = []
    const selected = (): Plugin | undefined => plugins?.find(plugin => plugin.name === select?.value)
    const value = (key: keyof typeof inputs): string => inputs[key]?.value.trim() ?? ''
    f.controls.push(() => {
      const plugin = selected(), ready = !!plugins && f.editable()
      for (const control of [file, select, overwrite, icon, ...Object.values(inputs)]) if (control) control.disabled = !ready
      if (buttons.install) buttons.install.disabled = !ready || !file?.files?.length
      if (buttons.download) buttons.download.disabled = !ready || plugin?.state !== 'installed'
      if (buttons.remove) buttons.remove.disabled = !ready || !plugin
      if (buttons.add) buttons.add.disabled = !ready || !value('id') || !value('item') || !value('group') || !value('priority') || !value('uri') || !icon?.files?.length
      if (buttons.clear) buttons.clear.disabled = !ready || !items.length
      if (buttons.generate) buttons.generate.disabled = !ready || !items.length || !value('name')
      if (buttons.refresh) buttons.refresh.disabled = !f.admitted()
    })
    if (!f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const paintItems = (): void => rows(root.querySelector('[data-plugin-generator-rows]'), items.map(item => [item.id, item.name, item.group, String(item.priority), item.uri]), t('No items have been added.'), 5)
    const read = (result: unknown): Plugin[] => {
      if (!object(result) || !Array.isArray(result.plugins)) throw new Error('invalid_plugins')
      const list = (result.plugins as unknown[]).map(item => object(item) && typeof item.name === 'string' && typeof item.state === 'string' && Array.isArray(item.items) ? { name: item.name, state: item.state, items: item.items, installedAt: typeof item.installedAt === 'string' ? item.installedAt : null } : null)
      if (list.some(item => item === null)) throw new Error('invalid_plugins')
      return list as Plugin[]
    }
    const paint = (next: Plugin[]): void => {
      plugins = next
      rows(root.querySelector('[data-plugin-packages-rows]'), next.map(plugin => [plugin.name, String(plugin.items.length), when(plugin.installedAt), plugin.state === 'installed' ? t('Installed') : t('Invalid package file; not loaded')]), t('No plugins are installed.'), 4)
      options(select, next.map(plugin => [plugin.name, plugin.name]), t('Select a plugin'))
      f.note('read', t('Read from this server.'))
    }
    const load = (): Promise<void> => f.guarded(async () => { f.note('reading', t('Reading…')); try { paint(read(await f.send('GET', '/api/server/plugins'))) } catch (error) { plugins = null; f.note('failed', failure(error).message) } })
    buttons.install?.addEventListener('click', () => void f.guarded(async () => {
      const chosen = file?.files?.[0]
      if (!chosen) return
      const archive = /\.(?:tar\.gz|tgz)$/i.test(chosen.name)
      if (chosen.size > (archive ? 1024 : 384) * 1024) { f.show('invalid', archive ? t('A plugin archive is at most 1 MiB.') : t('A plugin package is at most 384 KiB.')); return }
      let parsed: unknown
      if (!archive) try { parsed = JSON.parse(await chosen.text()) } catch { f.show('invalid', REASONS.plugin_package_format!); return }
      const body = archive ? { archive: base64(new Uint8Array(await chosen.arrayBuffer())), name: chosen.name.replace(/\.(?:tar\.gz|tgz)$/i, '').toLowerCase() } : { package: parsed }
      try { paint(read(await f.send('POST', '/api/server/plugins', { ...body, overwrite: overwrite?.checked === true }))); if (file) file.value = ''; f.show('read', t('The plugin was installed. Its icons appear on the home page of account owners.')) }
      catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    buttons.download?.addEventListener('click', () => { const plugin = selected(); if (plugin) window.location.assign('/api/server/plugins/' + encodeURIComponent(plugin.name) + '/package') })
    buttons.remove?.addEventListener('click', () => void f.guarded(async () => {
      const plugin = selected()
      if (!plugin || !await confirm(t('Delete this plugin?'), t('Its icons disappear from the home page of every account owner.'), t('Delete plugin'))) return
      try { paint(read(await f.send('DELETE', '/api/server/plugins/' + encodeURIComponent(plugin.name)))); f.show('read', t('The plugin was deleted.')) }
      catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    buttons.add?.addEventListener('click', () => void f.guarded(async () => {
      const chosen = icon?.files?.[0]
      if (!chosen) return
      if (chosen.size > 16 * 1024 || (chosen.type !== 'image/png' && chosen.type !== 'image/svg+xml')) { f.show('invalid', REASONS.plugin_icon_format!); return }
      const bytes = new Uint8Array(await chosen.arrayBuffer())
      items.push({ id: value('id'), name: value('item'), group: value('group'), priority: Number(value('priority')), uri: value('uri'), feature: value('feature') || null, icon: { type: chosen.type, data: base64(bytes) } })
      for (const control of [inputs.id, inputs.item, inputs.uri, inputs.feature, icon]) if (control) control.value = ''
      paintItems()
      f.show('read', t('{count, plural, one {# item is} other {# items are}} ready for the package.', { count: items.length }))
    }))
    buttons.clear?.addEventListener('click', () => void f.guarded(async () => { items.length = 0; paintItems() }))
    buttons.generate?.addEventListener('click', () => void f.guarded(async () => {
      if (typeof URL.createObjectURL !== 'function') { f.show('failed', t('File downloads are unavailable in this browser.')); return }
      try {
        const pkg = await f.send('POST', '/api/server/plugin-generator', { name: value('name'), items, overwrite: overwrite?.checked === true })
        if (!object(pkg) || pkg.format !== 'xpanel-plugin-package-v1') throw new Error('invalid_plugin_package')
        const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2) + '\n'], { type: 'application/json' })), link = document.createElement('a')
        link.href = url; link.download = value('name') + '.xpanel-plugin.json'; link.click(); URL.revokeObjectURL(url)
        f.show('read', t('The package was generated. Install it here or on another server.'))
      } catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    for (const control of [file, select, overwrite, icon]) control?.addEventListener('change', () => f.lock())
    for (const control of Object.values(inputs)) control?.addEventListener('input', () => f.lock())
    buttons.refresh?.addEventListener('click', () => void load())
    paintItems()
    void load()
  })

  const pluginRoots = [...document.querySelectorAll<HTMLElement>('[data-account-plugins]')].filter(root => root.dataset.accountPluginsBound !== 'true' && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"]'))
  const request = pluginRoots.length ? frameRequest(pluginRoots[0]!) : undefined
  if (request) {
    for (const root of pluginRoots) root.dataset.accountPluginsBound = 'true'
    type Link = { name: string; group: string; uri: string; icon: string }
    const readLinks = (value: unknown): Link[] => {
      if (!object(value) || !Array.isArray(value.items)) throw new Error('invalid_plugins')
      return (value.items as unknown[]).map(item => {
        if (!object(item) || typeof item.name !== 'string' || typeof item.group !== 'string' || typeof item.uri !== 'string' || !/^(?:https:\/\/|\/[A-Za-z0-9])/.test(item.uri)
          || typeof item.icon !== 'string' || !/^\/api\/account\/plugins\/[a-z0-9_-]+\/[a-z0-9_-]+\/icon$/.test(item.icon)) throw new Error('invalid_plugins')
        return { name: item.name, group: item.group, uri: item.uri, icon: item.icon }
      })
    }
    const entry = (root: HTMLElement, link: Link): HTMLElement => {
      const item = cloneClientTemplate(clientTemplate(root, 'account-plugin-link'), 'li', ['link', 'icon', 'name'])
      const anchor = clientTemplateSlot(item, 'link', 'a') as HTMLAnchorElement
      anchor.href = link.uri
      if (link.uri.startsWith('https://')) { anchor.target = '_blank'; anchor.rel = 'noopener noreferrer' }
      ;(clientTemplateSlot(item, 'icon', 'img') as HTMLImageElement).src = link.icon
      clientTemplateSlot(item, 'name', 'span').textContent = link.name
      return item
    }
    const paintGroups = (root: HTMLElement, links: Link[]): void => {
      const groups = new Map<string, Link[]>()
      for (const link of links) groups.set(link.group, [...groups.get(link.group) ?? [], link])
      root.querySelector('[data-account-plugins-list]')?.replaceChildren(...[...groups].map(([title, members]) => {
        const group = cloneClientTemplate(clientTemplate(root, 'account-plugin-group'), 'section', ['title', 'items'])
        clientTemplateSlot(group, 'title', 'h2').textContent = title
        clientTemplateSlot(group, 'items', 'ul').replaceChildren(...members.map(link => entry(root, link)))
        return group
      }))
      root.hidden = links.length === 0
      root.dataset.state = 'read'
    }
    void (async () => {
      try { const links = readLinks(await request('GET', '/api/account/plugins')); for (const root of pluginRoots) paintGroups(root, links) }
      catch (error) {
        // A team member has no owner read; the section stays hidden instead of reporting a failure.
        const denied = object(error) && (error.status === 403 || error.status === 404)
        for (const root of pluginRoots) {
          root.dataset.state = denied ? 'unavailable' : 'failed'
          const status = root.querySelector<HTMLElement>('[data-account-plugins-status]')
          if (denied || !status) continue
          status.hidden = false; status.setAttribute('role', 'alert'); status.textContent = t('Plugins could not be read. Nothing was changed.'); root.hidden = false
        }
      }
    })()
  }

  document.querySelectorAll<HTMLElement>('[data-theme-packages-workspace]').forEach(root => {
    if (root.dataset.themePackagesBound === 'true') return
    root.dataset.themePackagesBound = 'true'
    const f = frame(root, root.querySelector('[data-theme-packages-status]'), root.querySelector('[data-theme-packages-result]'), root.dataset.themePackagesCanManage === 'true')
    const file = root.querySelector<HTMLInputElement>('[data-theme-packages-file]'), select = root.querySelector<HTMLSelectElement>('[data-theme-packages-select]')
    const cloneId = root.querySelector<HTMLInputElement>('[data-theme-packages-clone-id]'), cloneName = root.querySelector<HTMLInputElement>('[data-theme-packages-clone-name]')
    const buttons = { upload: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="upload"]'), clone: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="clone"]'),
      preview: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="preview"]'), download: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="download"]'), remove: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="delete"]'), refresh: root.querySelector<HTMLButtonElement>('[data-theme-packages-action="refresh"]') }
    type Theme = { id: string; name: string | null; version: string | null; base: string | null; builtIn: boolean; state: string; installedAt: string | null }
    let themes: Theme[] | null = null
    const selected = (): Theme | undefined => themes?.find(theme => theme.id === select?.value)
    f.controls.push(() => {
      const theme = selected(), ready = !!themes && f.editable()
      for (const control of [file, select, cloneId, cloneName]) if (control) control.disabled = !ready
      if (buttons.upload) buttons.upload.disabled = !ready || !file?.files?.length
      if (buttons.clone) buttons.clone.disabled = !ready || !theme || theme.state !== 'installed' || !cloneId?.value.trim() || !cloneName?.value.trim()
      if (buttons.preview) buttons.preview.disabled = !ready || !theme || theme.state !== 'installed'
      if (buttons.download) buttons.download.disabled = !ready || !theme || theme.builtIn || theme.state !== 'installed'
      if (buttons.remove) buttons.remove.disabled = !ready || !theme || theme.builtIn
      if (buttons.refresh) buttons.refresh.disabled = !f.admitted()
    })
    if (!f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const builtInName = (id: string): string => id === 'classic' ? t('Classic') : id === 'v2' ? 'V2' : id
    const read = (value: unknown): Theme[] => {
      if (!object(value) || !Array.isArray(value.themes)) throw new Error('invalid_theme_packages')
      const list = (value.themes as unknown[]).map(item => object(item) && typeof item.id === 'string' && typeof item.builtIn === 'boolean' && typeof item.state === 'string'
        ? { id: item.id, name: typeof item.name === 'string' ? item.name : null, version: typeof item.version === 'string' ? item.version : null, base: typeof item.base === 'string' ? item.base : null,
          builtIn: item.builtIn, state: item.state, installedAt: typeof item.installedAt === 'string' ? item.installedAt : null } : null)
      if (list.some(item => item === null)) throw new Error('invalid_theme_packages')
      return list as Theme[]
    }
    const paint = (next: Theme[]): void => {
      themes = next
      rows(root.querySelector('[data-theme-packages-rows]'), next.map(theme => [theme.builtIn ? builtInName(theme.id) : theme.name ?? theme.id, theme.builtIn ? t('Built in') : theme.base ? builtInName(theme.base) : t('Not read'),
        theme.version ?? t('Not read'), theme.builtIn ? t('With this release') : when(theme.installedAt), theme.state === 'installed' ? t('Installed') : t('Invalid package file; not loaded')]), t('No themes are installed.'), 5)
      options(select, next.map(theme => [theme.id, theme.builtIn ? builtInName(theme.id) : theme.name ?? theme.id]), t('Select a theme'))
      f.note('read', t('Read from this server.'))
    }
    const load = (): Promise<void> => f.guarded(async () => { f.note('reading', t('Reading…')); try { paint(read(await f.send('GET', '/api/server/themes'))) } catch (error) { themes = null; f.note('failed', failure(error).message) } })
    buttons.upload?.addEventListener('click', () => void f.guarded(async () => {
      const chosen = file?.files?.[0]
      if (!chosen) return
      if (chosen.size > 64 * 1024) { f.show('invalid', t('A theme package is at most 64 KiB.')); return }
      let parsed: unknown
      try { parsed = JSON.parse(await chosen.text()) } catch { f.show('invalid', REASONS.package_format!); return }
      try { paint(read(await f.send('POST', '/api/server/themes', parsed))); if (file) file.value = ''; f.show('read', t('The theme package was installed. People can choose it in their display preferences.')) }
      catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    buttons.clone?.addEventListener('click', () => void f.guarded(async () => {
      const theme = selected()
      if (!theme) return
      try { paint(read(await f.send('POST', '/api/server/themes/' + theme.id + '/clone', { id: cloneId?.value.trim() ?? '', name: cloneName?.value.trim() ?? '' }))); f.show('read', t('The theme was cloned.')) }
      catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    buttons.preview?.addEventListener('click', () => { const theme = selected(); if (theme) window.open('/whm/panel/branding?previewTheme=' + encodeURIComponent(theme.id), '_blank', 'noopener') })
    buttons.download?.addEventListener('click', () => { const theme = selected(); if (theme && !theme.builtIn) window.location.assign('/api/server/themes/' + encodeURIComponent(theme.id) + '/package') })
    buttons.remove?.addEventListener('click', () => void f.guarded(async () => {
      const theme = selected()
      if (!theme || theme.builtIn || !await confirm(t('Delete this theme?'), t('People who chose {name} see the default theme from their next page.', { name: theme.name ?? theme.id }), t('Delete theme'))) return
      try { paint(read(await f.send('DELETE', '/api/server/themes/' + theme.id))); f.show('read', t('The theme was deleted.')) }
      catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    for (const control of [file, select, cloneId, cloneName]) control?.addEventListener(control === file || control === select ? 'change' : 'input', () => f.lock())
    buttons.refresh?.addEventListener('click', () => void load())
    void load()
  })

  document.querySelectorAll<HTMLElement>('[data-site-software-workspace]').forEach(root => {
    if (root.dataset.siteSoftwareBound === 'true') return
    root.dataset.siteSoftwareBound = 'true'
    const f = frame(root, root.querySelector('[data-site-software-status]'), root.querySelector('[data-site-software-result]'), root.dataset.siteSoftwareCanManage === 'true')
    const file = root.querySelector<HTMLInputElement>('[data-site-software-file]'), select = root.querySelector<HTMLSelectElement>('[data-site-software-select]')
    const buttons = { import: root.querySelector<HTMLButtonElement>('[data-site-software-action="import"]'), offer: root.querySelector<HTMLButtonElement>('[data-site-software-action="offer"]'),
      withdraw: root.querySelector<HTMLButtonElement>('[data-site-software-action="withdraw"]'), refresh: root.querySelector<HTMLButtonElement>('[data-site-software-action="refresh"]') }
    type App = { id: string; name: string; versions: string[] }
    let view: { host: null | { trust: { state: string; keyIds: string[]; reason: string | null }; catalog: { state: string; reason: string | null; keyId: string | null; sequence: number | null; issuedAt: string | null; expiresAt: string | null; applications: App[] } }; offer: { state: string; offered: string[] | null; revision: string } } | null = null
    const facts = { trust: root.querySelector('[data-site-software-fact="trust"]'), keys: root.querySelector('[data-site-software-fact="keys"]'), sequence: root.querySelector('[data-site-software-fact="sequence"]'),
      issued: root.querySelector('[data-site-software-fact="issued"]'), expires: root.querySelector('[data-site-software-fact="expires"]') }
    const fact = (key: keyof typeof facts, value: string): void => { const node = facts[key]; if (node) node.textContent = value }
    const apps = (): App[] => view?.host?.catalog.state === 'read' ? view.host.catalog.applications : []
    f.controls.push(() => {
      const ready = !!view && f.editable() && view.offer.state !== 'invalid', id = select?.value ?? '', offered = view?.offer.offered ?? []
      if (file) file.disabled = !view || !f.editable()
      if (buttons.import) buttons.import.disabled = !view || !f.editable() || !file?.files?.length
      if (select) select.disabled = !ready
      if (buttons.offer) buttons.offer.disabled = !ready || !apps().some(app => app.id === id) || offered.includes(id)
      if (buttons.withdraw) buttons.withdraw.disabled = !ready || !offered.includes(id)
      if (buttons.refresh) buttons.refresh.disabled = !f.admitted()
    })
    if (!f.admitted()) { f.note('unavailable', unavailable); f.lock(); return }
    const read = (value: unknown): NonNullable<typeof view> => {
      if (!object(value) || !object(value.offer) || typeof value.offer.revision !== 'string' || !(value.offer.offered === null || Array.isArray(value.offer.offered)) || !(value.host === null || object(value.host) && object(value.host.trust) && object(value.host.catalog) && Array.isArray(value.host.catalog.applications))) throw new Error('invalid_site_software')
      return value as NonNullable<typeof view>
    }
    const paint = (next: NonNullable<typeof view>): void => {
      view = next
      const host = next.host, catalog = host?.catalog, offered = next.offer.offered ?? []
      fact('trust', !host ? t('Not read') : host.trust.state === 'configured' ? t('Release signing key configured') : REASONS[host.trust.reason ?? ''] ?? t('No trusted release signing key'))
      fact('keys', host?.trust.keyIds.join(', ') || t('None'))
      fact('sequence', catalog?.state === 'read' ? String(catalog.sequence) + ' · ' + String(catalog.keyId) : catalog ? REASONS[catalog.reason ?? ''] ?? t('No signed catalog is stored.') : t('Not read'))
      fact('issued', catalog?.state === 'read' ? when(catalog.issuedAt) : t('Not read'))
      fact('expires', catalog?.state === 'read' ? when(catalog.expiresAt) : t('Not read'))
      const listed = [...apps().map(app => [app.id, app.name, app.versions.join(', ')] as const), ...offered.filter(id => !apps().some(app => app.id === id)).map(id => [id, id, t('Not in the stored catalog')] as const)]
      rows(root.querySelector('[data-site-software-rows]'), listed.map(([id, name, versions]) => [name, versions, offered.includes(id) ? t('Offered to accounts') : t('Not offered')]), t('The verified catalog lists no applications.'), 3)
      options(select, listed.map(([id, name]) => [id, name]), t('Select an application'))
      f.note(next.offer.state === 'invalid' ? 'failed' : 'read', next.offer.state === 'invalid' ? t('The saved offer could not be verified, so no application is offered.') : host ? t('Read from this server.') : t('Saved offer read. The host agent did not report the signed catalog.'))
    }
    const load = (): Promise<void> => f.guarded(async () => { f.note('reading', t('Reading…')); try { paint(read(await f.send('GET', '/api/server/site-software'))) } catch (error) { view = null; f.note('failed', failure(error).message) } })
    buttons.import?.addEventListener('click', () => void f.guarded(async () => {
      const chosen = file?.files?.[0]
      if (!chosen) return
      if (chosen.size > 1024 * 1024) { f.show('invalid', t('A signed catalog is at most 1 MiB.')); return }
      try {
        const result = await f.send('POST', '/api/server/site-software/catalog', { envelope: await chosen.text() })
        paint(read(result))
        const outcome = object(result) && object(result.import) ? result.import : null
        if (outcome?.outcome === 'imported') { if (file) file.value = ''; f.show('read', t('The signed catalog was verified with the release key and stored.')) }
        else f.show('refused', REASONS[String(outcome?.reason)] ?? t('The catalog was refused. The stored catalog is unchanged.'))
      } catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    }))
    const change = (offer: boolean): Promise<void> => f.guarded(async () => {
      const current = view, id = select?.value ?? ''
      if (!current?.offer.offered) return
      if (!offer && !await confirm(t('Stop offering this application?'), t('Accounts can no longer install or update it. Existing installations can still be removed.'), t('Stop offering'))) return
      try {
        paint(read(await f.send('PUT', '/api/server/site-software', { offered: offer ? [...new Set([...current.offer.offered, id])] : current.offer.offered.filter(item => item !== id), expectedRevision: current.offer.revision })))
        f.show('read', offer ? t('The application is offered to accounts.') : t('The application is no longer offered.'))
      } catch (error) { const result = failure(error); f.show(result.kind, result.message) }
    })
    select?.addEventListener('change', () => f.lock())
    file?.addEventListener('change', () => f.lock())
    buttons.offer?.addEventListener('click', () => void change(true))
    buttons.withdraw?.addEventListener('click', () => void change(false))
    buttons.refresh?.addEventListener('click', () => void load())
    void load()
  })
}

export const WHM_EXTEND_CLIENT_BINDING = withFrameRequest(`(()=>{const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};return ${bindWhmExtend.toString()};})()`)
