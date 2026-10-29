/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { readAccountRuntimeView } from '../../../packages/os/src/account-runtime-command.ts'
import type { AccountRuntimeClientView } from '../../../packages/os/src/account-runtime-command.ts'
export { readAccountRuntimeView }
const formatDisplayDateTime = sharedFormatDisplayDateTime

type Ask = (options: Record<string, unknown>) => Promise<unknown>
/** Apps, containers and caches of the signed-in account; every change is revision-checked and read back from the server. */
function bindAccountRuntime(askDialog: Ask | undefined, parse: typeof readAccountRuntimeView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-runtime-workspace]').forEach(root => {
    if (root.dataset.runtimeBound === 'true') return
    root.dataset.runtimeBound = 'true'
    const kind = root.dataset.runtimeWorkspace
    const q = <T extends HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-runtime-status]'), refresh = q<HTMLButtonElement>('[data-runtime-refresh]'), log = q<HTMLElement>('[data-runtime-log]')
    if (!status || !refresh || !log || !['apps', 'containers', 'cache'].includes(kind ?? '')) return
    const field = <T extends HTMLInputElement | HTMLSelectElement>(key: string): T => root.querySelector<T>('[data-runtime-input="' + key + '"]')!
    const action = (key: string): HTMLButtonElement | null => q<HTMLButtonElement>('[data-runtime-action="' + key + '"]')
    const admitted = (): boolean => root.isConnected && root.dataset.runtimeCanManage === 'true' && !root.closest(blocked) && typeof transport === 'function'
    let view: AccountRuntimeClientView | null = null, busy = false, editing: string | null = null
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const make = (tag: string, text = '', attrs: Record<string, string> = {}): HTMLElement => { const node = document.createElement(tag); node.textContent = text; for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node }
    const ltr = (text: string): HTMLElement => make('bdi', text, { dir: 'ltr' })
    const stateLabel = (state: string): string => state === 'running' ? t('Running') : state === 'starting' ? t('Starting') : state === 'stopped' ? t('Stopped') : state === 'failed' ? t('Failed') : t('Unknown')
    const chip = (text: string, tone: string): HTMLElement => make('span', text, { 'data-state-chip': tone })
    const stateChip = (state: string): HTMLElement => chip(stateLabel(state), state === 'running' ? 'ok' : state === 'failed' ? 'problem' : 'unavailable')
    const megabytes = (bytes: number | null): string => bytes === null ? t('Not read') : t('{value} MB', { value: (bytes / 1048576).toFixed(1) })
    const row = (cells: (string | HTMLElement)[]): HTMLTableRowElement => { const tr = document.createElement('tr'); for (const cell of cells) { const td = document.createElement('td'); td.append(cell); tr.append(td) } return tr }
    const empty = (body: HTMLElement, colspan: number, text: string): void => { body.replaceChildren(row([text])); body.querySelector('td')!.colSpan = colspan }
    const rowButton = (label: string, op: string, name: string, enabled: boolean): HTMLButtonElement => { const b = make('button', label, { type: 'button', class: 'xp-btn xp-btn--ghost' }) as HTMLButtonElement; b.dataset.runtimeRow = op; b.dataset.runtimeName = name; b.dataset.runtimeBlocked = String(!enabled); b.disabled = true; return b }
    const actions = (...buttons: HTMLButtonElement[]): HTMLElement => { const wrap = make('div', '', { class: 'xp-acct-tool__actions' }); wrap.append(...buttons); return wrap }
    const envBody = q<HTMLElement>('[data-runtime-env]')
    const envRow = (name = '', value = ''): void => {
      if (!envBody) return
      if (!envBody.querySelector('input')) envBody.replaceChildren()
      const n = make('input', '', { class: 'xp-input', dir: 'ltr', maxlength: '64', 'aria-label': t('Name') }) as HTMLInputElement, v = make('input', '', { class: 'xp-input', dir: 'ltr', maxlength: '1024', 'aria-label': t('Value') }) as HTMLInputElement
      n.value = name; v.value = value
      const remove = make('button', t('Remove'), { type: 'button', class: 'xp-btn xp-btn--ghost' }) as HTMLButtonElement
      const tr = row([n, v, remove]); remove.addEventListener('click', () => { tr.remove(); if (!envBody.querySelector('input')) empty(envBody, 3, t('No variables.')) })
      envBody.append(tr)
    }
    const envValue = (): Record<string, string> => { const out: Record<string, string> = {}; for (const tr of envBody?.querySelectorAll('tr') ?? []) { const [n, v] = [...tr.querySelectorAll('input')]; if (n && v && n.value.trim()) out[n.value.trim()] = v.value } return out }
    const fillEnv = (entries: { name: string; value: string }[]): void => { if (!envBody) return; empty(envBody, 3, t('No variables.')); for (const e of entries) envRow(e.name, e.value) }
    const failure = (error: unknown): void => {
      const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
      const code = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
      if (detail && detail.stateChanged === false) note('failed', code === 409 ? t('The configuration changed. Read again before changing it.') : code === 412 ? t('This is unavailable on this server right now. Nothing was changed.') : code === 403 ? t('Your plan does not allow this. Nothing was changed.')
        : code === 422 ? t('A plan limit was reached. Nothing was changed.') : code === 500 ? t('The change did not pass the server configuration tests and was undone.') : code === 404 ? t('It no longer exists. Read again.') : t('The change was refused. Nothing was changed.'))
      else note('uncertain', t('The outcome is unknown. Read again before retrying.'))
    }
    const paintApps = (v: AccountRuntimeClientView): void => {
      for (const r of v.host.runtimes) { const node = q<HTMLElement>('[data-runtime-version="' + r.kind + '"]'); if (node) node.textContent = r.available ? t('Version {version}', { version: r.version ?? '' }) : r.reason === 'bundler-missing' ? t('Bundler is not installed') : r.reason === 'proxy-unavailable' ? t('Unavailable: systemd socket proxy missing') : r.reason === 'venv-missing' ? t('Unavailable: python3-venv is not installed') : t('Not installed') }
      const body = q<HTMLElement>('[data-runtime-apps]')!, domains = new Map(v.domains.map(d => [d.id, d.name]))
      if (!v.apps.length) empty(body, 6, v.plan.apps ? t('No application yet.') : t('Your plan does not include applications.'))
      else body.replaceChildren(...v.apps.map(a => row([ltr(a.name), a.runtime === 'node' ? 'Node.js' : a.runtime === 'python' ? 'Python' : 'Ruby', ltr((domains.get(a.domainId) ?? t('Domain removed')) + (a.path === '/' ? '' : a.path)),
        a.preflight?.length && !a.enabled ? chip(t('Needs setup'), 'problem') : stateChip(a.state),
        a.health === null ? t('Not checked') : chip(String(a.health), a.health < 500 ? 'ok' : 'problem'),
        actions(rowButton(t('Edit'), 'edit', a.name, true), rowButton(a.enabled ? t('Stop') : t('Start'), a.enabled ? 'app.stop' : 'app.start', a.name, a.enabled || !a.preflight?.length), rowButton(t('Restart'), 'app.restart', a.name, a.enabled), rowButton(t('Remove'), 'app.remove', a.name, true))])))
      const domain = field<HTMLSelectElement>('domain'), keep = domain.value
      domain.replaceChildren(...v.domains.map(d => { const o = make('option', d.name) as HTMLOptionElement; o.value = d.id; return o }))
      if (v.domains.some(d => d.id === keep)) domain.value = keep
      const current = v.apps.find(a => a.name === editing)
      const deps = q<HTMLElement>('[data-runtime-deps]')
      const ready = q<HTMLElement>('[data-runtime-preflight]')
      if (ready) {
        const fix = (p: string): string => p === 'root-missing' ? t('The application root does not exist. Upload the code first, for example with Git & deployments.') : p === 'startup-missing' ? t('The startup file is not in the application root.')
          : p === 'node-modules-missing' ? t('package.json lists packages that are not installed. Run Install dependencies.') : p === 'venv-missing' ? t('The Python environment .venv is missing. Run Install dependencies.')
          : p === 'gemfile-missing' ? t('Ruby apps need a Gemfile in the application root, with gem "puma".') : p === 'puma-missing' ? t('puma is not in the Gemfile. Add gem "puma", then run Install dependencies.') : t('The gems are not installed. Run Install dependencies.')
        ready.replaceChildren(!current ? make('p', t('Save the application first')) : current.preflight === null ? make('p', t('Readiness could not be checked on this server.')) : !current.preflight.length ? make('p', t('Ready to start: every file the runtime needs is in place.'))
          : (() => { const list = make('ul'); list.append(...current.preflight!.map(p => make('li', fix(p)))); return list })())
      }
      if (deps) deps.textContent = !current ? t('Save the application first') : current.deps === 'none' ? t('Never run') : current.deps === 'running' ? t('Running') : current.deps === 'succeeded' ? t('Succeeded') : t('Failed')
    }
    const paintContainers = (v: AccountRuntimeClientView): void => {
      const stat = (key: string, text: string): void => { const node = q<HTMLElement>('[data-runtime-stat="' + key + '"]'); if (node) node.textContent = text }
      const h = v.host.containers
      stat('engine', h.available ? t('Podman {version}, rootless', { version: h.version ?? '' }) : h.reason === 'no-subordinate-ids' ? t('Unavailable: no subordinate IDs for this account') : h.reason === 'newuidmap-missing' ? t('Unavailable: newuidmap is not installed') : t('Podman is not installed'))
      stat('count', t('{used} of {max}', { used: v.containers.length, max: v.plan.maxContainers }))
      stat('cleanup', v.imageCleanup === 'none' ? t('Never run') : v.imageCleanup === 'running' ? t('Running') : v.imageCleanup === 'succeeded' ? t('Succeeded') : t('Failed'))
      stat('memory', megabytes(v.containers.reduce<number | null>((sum, c) => c.memoryBytes === null ? sum : (sum ?? 0) + c.memoryBytes, null)))
      stat('limits', t('Memory {memory} · CPU {cpu} · Processes {processes}', { memory: v.plan.memoryMb === null ? t('Unlimited') : v.plan.memoryMb + ' MB', cpu: v.plan.cpuPercent === null ? t('Unlimited') : v.plan.cpuPercent + '%', processes: v.plan.maxProcesses ?? t('Unlimited') }))
      const body = q<HTMLElement>('[data-runtime-containers]')!
      if (!v.containers.length) empty(body, 6, v.plan.containers ? t('No container yet.') : t('Your plan does not include containers.'))
      else body.replaceChildren(...v.containers.map(c => row([ltr(c.name), ltr(c.image), stateChip(c.state), c.since ? formatDisplayDateTime(c.since) : '—', t('None published'),
        actions(rowButton(c.enabled ? t('Stop') : t('Start'), c.enabled ? 'container.stop' : 'container.start', c.name, true), rowButton(t('Restart'), 'container.restart', c.name, c.enabled), rowButton(t('Log'), 'log:ctr', c.name, true), rowButton(t('Remove'), 'container.remove', c.name, true))])))
    }
    const paintCache = (v: AccountRuntimeClientView): void => {
      const stat = (key: string, text: string): void => { const node = q<HTMLElement>('[data-runtime-stat="' + key + '"]'); if (node) node.textContent = text }
      for (const c of v.cache) stat(c.service, c.enabled ? stateLabel(c.state) : t('Disabled'))
      stat('memory', megabytes(v.cache.reduce<number | null>((sum, c) => c.memoryBytes === null ? sum : (sum ?? 0) + c.memoryBytes, null)))
      stat('cap', t('{value} MB', { value: String(v.plan.cacheMaxMb) }))
      const body = q<HTMLElement>('[data-runtime-cache]')!
      body.replaceChildren(...v.cache.map(c => {
        const host = v.host.cache.find(h => h.service === c.service)!
        return row([c.service === 'redis' ? 'Redis' : 'Memcached', host.available || c.enabled ? stateChip(c.enabled ? c.state : 'stopped') : chip(t('Not installed'), 'unavailable'), host.version ?? t('Not read'), ltr(c.socket),
          c.memoryMb === null ? t('Not set') : t('{value} MB', { value: String(c.memoryMb) }),
          actions(rowButton(c.enabled ? t('Disable') : t('Enable'), c.enabled ? 'cache.disable' : 'cache.enable', c.service, v.plan.cache && (c.enabled || host.available)), rowButton(t('Log'), 'log:cache', c.service, true))])
      }))
      const chosen = v.cache.find(c => c.service === field<HTMLSelectElement>('service').value) ?? v.cache[0]!
      field<HTMLInputElement>('socket').value = chosen.socket
      field<HTMLInputElement>('memory').max = String(v.plan.cacheMaxMb)
      if (!field<HTMLInputElement>('memory').value) field<HTMLInputElement>('memory').value = String(chosen.memoryMb ?? Math.min(64, v.plan.cacheMaxMb))
    }
    const lock = (): void => {
      const on = admitted() && !busy && view !== null
      refresh.disabled = busy || !admitted()
      for (const node of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-runtime-input]')) if (!(node instanceof HTMLInputElement && node.readOnly)) node.disabled = !on
      const can = (key: string, allowed: boolean): void => { const b = action(key); if (b) b.disabled = !on || !allowed }
      const app = view?.apps.find(a => a.name === editing)
      can('app-new', !!view?.plan.apps && view.apps.length < view.plan.maxApps); can('app-save', !!view?.plan.apps && !!view?.domains.length); can('env-add', true)
      can('app-deps', !!app); can('app-log', !!app); can('deps-log', !!app); can('ctr-run', !!view?.plan.containers && !!view?.host.containers.available && view.containers.length < view.plan.maxContainers); can('ctr-prune', !!view?.host.containers.available && view?.imageCleanup !== 'running')
      const cache = view?.cache.find(c => c.service === (root.querySelector<HTMLSelectElement>('[data-runtime-input="service"]')?.value ?? ''))
      can('cache-save', !!view?.plan.cache); can('cache-flush', !!cache?.enabled)
      if (kind === 'apps' && editing !== null) field<HTMLInputElement>('name').disabled = true
      for (const b of root.querySelectorAll<HTMLButtonElement>('[data-runtime-row]')) b.disabled = !on || b.dataset.runtimeBlocked === 'true'
    }
    const load = async (message?: string): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); if (!message) note('reading', t('Reading…'))
      try {
        const next = parse(await transport!('GET', '/api/account/runtime'))
        if (!admitted()) return
        view = next
        if (kind === 'apps') paintApps(next); else if (kind === 'containers') paintContainers(next); else paintCache(next)
        note('read', message ?? t('Read from the server.'))
      } catch { if (admitted()) note('failed', t('The services could not be read. Read again; nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const send = async (body: Record<string, unknown>, done: string, confirm?: { title: string; body: string }): Promise<void> => {
      if (busy || !admitted() || !view) return
      if (confirm) {
        let approved = false
        try { approved = typeof askDialog === 'function' && await askDialog({ title: confirm.title, body: confirm.body, danger: true, confirm: t('Confirm') }) === true } catch { approved = false }
        if (!approved) return
      }
      busy = true; lock(); note('reading', t('Applying the change…'))
      let ok = false
      try { await transport!('POST', '/api/account/runtime', { ...body, expectedRevision: view.revision }); ok = true } catch (error) { failure(error) }
      finally { busy = false }
      if (ok) await load(done); else lock()
    }
    const readLog = async (target: string): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); log.textContent = t('Reading…')
      try {
        const reply = await transport!('GET', '/api/account/runtime/log?target=' + encodeURIComponent(target)) as { lines?: unknown }
        const lines = Array.isArray(reply?.lines) ? reply.lines.filter((line): line is string => typeof line === 'string') : null
        log.textContent = lines === null ? t('The log could not be read.') : lines.length ? lines.join('\n') : t('The log is empty.')
      } catch { log.textContent = t('The log could not be read.') }
      finally { busy = false; lock() }
    }
    root.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-runtime-row]')
      if (!target || target.disabled || !view) return
      const op = target.dataset.runtimeRow!, name = target.dataset.runtimeName!
      if (op === 'edit') {
        const a = view.apps.find(x => x.name === name)
        if (!a) return
        editing = a.name
        field<HTMLSelectElement>('runtime').value = a.runtime; field<HTMLInputElement>('name').value = a.name; field<HTMLInputElement>('root').value = a.root; field<HTMLInputElement>('startup').value = a.startup
        field<HTMLSelectElement>('domain').value = a.domainId; field<HTMLInputElement>('path').value = a.path; fillEnv(a.env)
        const setup = q<HTMLElement>('[data-runtime-setup]'); if (setup) { setup.hidden = false; paintApps(view) }
        lock(); return
      }
      if (op === 'log:ctr') { void readLog('ctr:' + name); return }
      if (op === 'log:cache') { void readLog('cache:' + name); return }
      if (op === 'cache.enable' || op === 'cache.disable') {
        const c = view.cache.find(x => x.service === name)!
        void send({ op: 'cache.save', service: name, enabled: op === 'cache.enable', memoryMb: c.memoryMb ?? Math.min(64, view.plan.cacheMaxMb) }, op === 'cache.enable' ? t('The cache is enabled.') : t('The cache is disabled.'))
        return
      }
      const removing = op.endsWith('.remove'), stopping = op.endsWith('.stop')
      void send({ op, name }, removing ? t('Removed.') : stopping ? t('Stopped.') : t('Done. The state below is read from the server.'), removing ? { title: t('Remove {name}?', { name }), body: t('Its service stops and its saved settings are deleted. Files in your home directory stay.') } : stopping ? { title: t('Stop {name}?', { name }), body: t('It stays stopped until you start it again.') } : undefined)
    })
    for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-runtime-tab]')) tab.addEventListener('click', () => {
      for (const other of root.querySelectorAll<HTMLButtonElement>('[data-runtime-tab]')) other.setAttribute('aria-selected', String(other === tab))
      for (const panel of root.querySelectorAll<HTMLElement>('[data-runtime-panel]')) panel.hidden = panel.dataset.runtimePanel !== tab.dataset.runtimeTab
    })
    action('env-add')?.addEventListener('click', () => envRow())
    action('app-new')?.addEventListener('click', () => {
      editing = null
      for (const key of ['name', 'root', 'startup']) field<HTMLInputElement>(key).value = ''
      field<HTMLInputElement>('path').value = '/'; fillEnv([])
      const setup = q<HTMLElement>('[data-runtime-setup]'); if (setup) setup.hidden = false
      if (view) paintApps(view); lock(); field<HTMLInputElement>('name').focus()
    })
    action('app-save')?.addEventListener('click', () => {
      const app = { name: field<HTMLInputElement>('name').value.trim(), runtime: field<HTMLSelectElement>('runtime').value, root: field<HTMLInputElement>('root').value.trim().replace(/^\/+|\/+$/g, ''), startup: field<HTMLInputElement>('startup').value.trim(), domainId: field<HTMLSelectElement>('domain').value, path: field<HTMLInputElement>('path').value.trim().replace(/(.)\/+$/, '$1') || '/', env: envValue() }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(app.name) || !app.root || !app.startup || !app.domainId) { note('failed', t('Enter a name, an application root, a startup file and a domain. Nothing was saved.')); return }
      const saved = editing === null ? t('Saved stopped. Install its dependencies, then start it.') : t('Saved. A running application was restarted with the new settings.')
      void send({ op: 'app.save', app }, saved).then(() => { if (view?.apps.some(a => a.name === app.name)) { editing = app.name; paintApps(view); lock() } })
    })
    action('app-deps')?.addEventListener('click', () => { if (editing) void send({ op: 'app.deps', name: editing }, t('The dependency install started. Read the install log for its progress.')) })
    action('app-log')?.addEventListener('click', () => { if (editing) void readLog('app:' + editing) })
    action('deps-log')?.addEventListener('click', () => { if (editing) void readLog('deps:' + editing) })
    action('ctr-run')?.addEventListener('click', () => {
      const container = { name: field<HTMLInputElement>('name').value.trim(), image: field<HTMLInputElement>('image').value.trim(), env: envValue() }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(container.name) || !container.image) { note('failed', t('Enter a container name and an image. Nothing was started.')); return }
      void send({ op: 'container.run', container }, t('The container is starting; the image is pulled first. Read its log for progress.'))
    })
    action('ctr-prune')?.addEventListener('click', () => { void send({ op: 'container.prune' }, t('Image cleanup started. Read again to see when it is done.'), { title: t('Reclaim image space?'), body: t('Every image no running container uses is removed. A stopped container pulls its image again when it starts.') }) })
    root.querySelector<HTMLSelectElement>('[data-runtime-input="service"]')?.addEventListener('change', () => { if (!view) return; const c = view.cache.find(x => x.service === field<HTMLSelectElement>('service').value)!; field<HTMLInputElement>('socket').value = c.socket; field<HTMLInputElement>('memory').value = String(c.memoryMb ?? Math.min(64, view.plan.cacheMaxMb)); lock() })
    action('cache-save')?.addEventListener('click', () => {
      if (!view) return
      const service = field<HTMLSelectElement>('service').value, memoryMb = Number(field<HTMLInputElement>('memory').value), c = view.cache.find(x => x.service === service)!
      if (!Number.isInteger(memoryMb) || memoryMb < 8 || memoryMb > view.plan.cacheMaxMb) { note('failed', t('Choose a memory limit from 8 to {max} MB. Nothing was saved.', { max: view.plan.cacheMaxMb })); return }
      void send({ op: 'cache.save', service, enabled: c.enabled, memoryMb }, t('Settings saved.'))
    })
    action('cache-flush')?.addEventListener('click', () => { const service = field<HTMLSelectElement>('service').value; void send({ op: 'cache.flush', service }, t('The cache was flushed.'), { title: t('Flush {name}?', { name: service === 'redis' ? 'Redis' : 'Memcached' }), body: t('Every cached value is removed.') }) })
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('These services are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}
export const ACCOUNT_RUNTIME_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parse=${readAccountRuntimeView.toString()};const bind=${bindAccountRuntime.toString()};return (ask)=>bind(ask,parse);})()`
