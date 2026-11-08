/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import { readCtrView } from '../../../packages/os/src/ctr-view.ts'
import type { CtrAccountsView, CtrDetailView, CtrOp, CtrPolicyView, CtrScopeView, CtrStackRow } from '../../../packages/os/src/ctr-view.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Control = HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement
/** Rootless container workspace. A row belongs to the selected account; nothing crosses accounts on this page. */
function bindCtr(askDialog: Ask | undefined, parse: typeof readCtrView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const BASE = '/api/server/software/containers'
  document.querySelectorAll<HTMLElement>('[data-ctr-workspace]').forEach(root => {
    if (root.dataset.ctrBound === 'true') return
    root.dataset.ctrBound = 'true'
    const index = (nodes: NodeListOf<HTMLElement>, key: string): Record<string, HTMLElement> => Object.fromEntries([...nodes].map(node => [node.dataset[key]!, node]))
    const field = index(root.querySelectorAll<HTMLElement>('[data-ctr-field]'), 'ctrField'), rows = index(root.querySelectorAll<HTMLElement>('[data-ctr-rows]'), 'ctrRows'), action = index(root.querySelectorAll<HTMLElement>('[data-ctr-do]'), 'ctrDo')
    const input = (key: string): Control => field[key] as Control
    const value = (key: string): string => input(key).value.trim()
    const optional = (key: string): string | null => value(key) || null
    const words = (key: string): string[] => value(key).split(/[,\n]/).map(item => item.trim()).filter(Boolean)
    const number = (key: string): number | null => value(key) ? Number(value(key)) : null
    const status = field.status, account = input('account'), job = field.job, jobLink = field['job-link'] as HTMLAnchorElement | undefined
    if (!status || !account || !action.read || !job || !jobLink) return
    let follow: AbortController | null = null, busy = false, review = false, scope: CtrScopeView | null = null, policy: CtrPolicyView | null = null, accounts: CtrAccountsView | null = null, editing: CtrStackRow | null = null, detail: CtrDetailView | null = null
    const admitted = (): boolean => root.isConnected && root.dataset.ctrCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    const manageable = (): boolean => admitted() && root.dataset.ctrCanManage === 'true' && scope?.scope === 'account' && scope.state === 'read' && !review && typeof askDialog === 'function'
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const lock = (): void => {
      for (const [key, node] of Object.entries(action)) (node as HTMLButtonElement).disabled = busy || !admitted() || (!['read', 'detail-logs', 'registry-save', 'catalog-update'].includes(key) && !manageable())
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-ctr-rows] button')) button.disabled = busy || !admitted() || button.dataset.ctrOpen !== 'true' && !manageable()
    }
    const fill = (key: string, items: readonly Record<string, string>[], message: string, bind?: (row: HTMLElement, index: number) => void): void => {
      const body = rows[key]
      if (!body) return
      body.textContent = ''
      items.forEach((values, position) => { const row = cloneViewRecord(root, 'ctr-' + key + '-row', 'tr', values); bind?.(row, position); body.append(row) })
      if (!items.length) body.append(cloneViewRecord(root, 'ctr-' + key + '-empty', 'tr', { message }))
    }
    const stateLabel = (state: string): string => ({ running: t('Running'), starting: t('Starting'), stopped: t('Stopped'), failed: t('Failed'), exited: t('Exited'), created: t('Created'), paused: t('Paused'), unknown: t('Not read') } as Record<string, string>)[state] ?? state
    const reasonText = (reason: string | null): string => ({ 'not-installed': t('Podman is not installed. Install it from the software center; the engine stays off until then.'), 'newuidmap-missing': t('Rootless containers need newuidmap, which is not installed.'), 'no-subordinate-ids': t('This account has no subordinate IDs, so rootless containers cannot start.'), 'unsupported-host': t('Container engines cannot be read on this host. Nothing was read or changed.'), 'no-engine': t('No Podman or Docker engine is installed. Install Podman from the software center to run containers.') } as Record<string, string>)[reason ?? ''] ?? t('The container store could not be read or its output could not be verified.')
    const refusal = (error: unknown, change: boolean): void => {
      const raw = (error && typeof error === 'object' ? error : {}) as Record<string, any>, detailed = raw.details ?? raw.detail ?? {}, code = Number(raw.status)
      if (change && detailed.stateChanged !== false) { review = true; note('uncertain', t('The outcome is unknown. Check the jobs page; changes stay locked until you read the store again.')); return }
      const known: Record<string, string> = { PORT_IN_USE: t('This host port is already in use. Nothing was changed.'), IN_USE: t('A container or stack still uses this. Nothing was changed.'), AUTH_FAILED: t('The registry refused these credentials. Nothing was saved.'), untrusted_registry: t('The trust policy does not admit this registry. Add it on the Container engine page first.'), invalid_compose: t('The compose file was refused at {field}: {message}', { field: String(detailed.field ?? 'yaml'), message: String(raw.message ?? '') }), subnet_overlap: t('This subnet overlaps an existing network. Nothing was changed.'), registry_unreachable: t('The registry could not be reached. Nothing was saved.'), registry_search_unavailable: t('This registry does not answer searches.'), catalog_stale: t('This catalog has expired or is older than the stored one. Nothing was changed.'), catalog_invalid: t('This catalog is malformed or its signature is wrong. Nothing was changed.'), catalog_untrusted: t('The release keys do not trust the signer of this catalog. Nothing was changed.'), catalog_unreachable: t('The catalog feed could not be reached. Nothing was changed.'), release_keys_unavailable: t('No release signing key is configured, so no catalog can be verified.'), log_viewers: t('Four live logs are already open on this server. Close one first.') }
      note('failed', known[String(detailed.reason)] ?? (code === 409 ? t('The store changed since it was read. Read it again.') : code === 412 ? t('The change is unavailable right now. Nothing was changed.') : t('The request failed. Nothing was changed.')))
    }
    const paintAccounts = (): void => {
      const list = accounts?.accounts ?? [], current = account.value
      account.replaceChildren(new Option(t('Host engines'), ''), ...list.map(row => new Option(row.username, row.username)))
      account.value = list.some(row => row.username === current) ? current : ''
      const total = (key: 'stacks' | 'services' | 'running'): string => String(list.reduce((sum, row) => sum + row[key], 0))
      if (field['total-accounts']) field['total-accounts'].textContent = String(list.length)
      if (field['total-stacks']) field['total-stacks'].textContent = total('stacks')
      if (field['total-services']) field['total-services'].textContent = total('services')
      if (field['total-running']) field['total-running'].textContent = total('running')
      fill('accounts', list.map(row => ({ account: row.username, engine: row.available ? t('Available') : reasonText(row.reason), stacks: String(row.stacks), services: String(row.services), running: String(row.running) })), t('No active accounts.'), (row, position) => {
        const button = viewAction(row, 'select'); button.dataset.ctrOpen = 'true'; button.setAttribute('aria-label', t('Show the containers of {name}', { name: list[position]!.username }))
        button.addEventListener('click', () => { account.value = list[position]!.username; void load() })
      })
    }
    const paintStacks = (): void => {
      const stacks = scope?.stacks ?? []
      fill('stacks', stacks.map(stack => ({ name: stack.name, kind: stack.app ?? t('Compose'), services: stack.services.map(item => item.name + ': ' + stateLabel(item.state)).join(', '), ports: stack.services.flatMap(item => item.ports).join(', ') || t('None'), updated: formatDisplayDateTime(stack.updatedAt) })), scope?.scope === 'account' ? t('This account has no stacks.') : t('Choose an account to see its stacks.'), (row, position) => {
        const stack = stacks[position]!
        for (const [key, op] of [['start', 'stack.start'], ['stop', 'stack.stop'], ['restart', 'stack.restart'], ['update', 'stack.update']] as const) {
          const button = viewAction(row, key); button.setAttribute('aria-label', t('{action} stack {name}', { action: key === 'start' ? t('Start') : key === 'stop' ? t('Stop') : key === 'restart' ? t('Restart') : t('Update images'), name: stack.name }))
          button.addEventListener('click', () => { void run({ op, name: stack.name }) })
        }
        const edit = viewAction(row, 'edit'); edit.addEventListener('click', () => {
          editing = stack; input('stack-name').value = stack.name; input('stack-yaml').value = stack.yaml; input('stack-env').value = ''; input('stack-env').placeholder = stack.envKeys.join(', '); input('stack-notes').value = stack.notes; note('read', t('Editing {name}. Leave env empty to keep its saved values ({count} names).', { name: stack.name, count: stack.envKeys.length }))
        })
        const logs = viewAction(row, 'logs'); logs.dataset.ctrOpen = 'true'; logs.addEventListener('click', () => { void stackLogs(stack.name) })
        viewAction(row, 'remove').addEventListener('click', () => { void run({ op: 'stack.remove', name: stack.name }, [t('Remove stack {name}?', { name: stack.name }), t('Its containers stop and its units go away. The folder {folder} and the named volumes stay.', { folder: stack.folder })]) })
      })
    }
    const paintTemplates = (): void => {
      const term = field['template-search'] ? value('template-search').toLowerCase() : '', list = (policy?.templates ?? []).filter(item => !term || item.name.includes(term) || item.description.toLowerCase().includes(term))
      fill('templates', list.map(item => ({ name: item.name, description: item.description })), t('No templates match.'), (row, position) => {
        const template = list[position]!, use = viewAction(row, 'use'); use.dataset.ctrOpen = 'true'
        use.addEventListener('click', () => { editing = null; input('stack-yaml').value = template.yaml; input('stack-env').value = template.env; input('stack-env').placeholder = ''; note('read', t('Template {name} copied to the stack form.', { name: template.name })) })
        const remove = viewAction(row, 'remove'); remove.dataset.ctrOpen = 'true'
        remove.addEventListener('click', () => { void savePolicy({ templates: policy!.templates.filter(item => item.name !== template.name) }) })
      })
    }
    const paintPolicy = (): void => {
      if (field['config-path']) field['config-path'].textContent = policy?.configPath ?? t('Not read')
      if (field['catalog-source'] && policy) {
        field['catalog-source'].textContent = policy.catalog.source === 'signed' ? t('Signed feed, sequence {sequence}', { sequence: policy.catalog.sequence ?? 0 }) : policy.catalog.reason ? t('Shipped apps: the stored feed is not valid ({reason})', { reason: policy.catalog.reason }) : t('Shipped with the panel')
        field['catalog-expires']!.textContent = policy.catalog.expiresAt ? formatDisplayDateTime(policy.catalog.expiresAt) : t('Does not expire')
        if (!value('feed-url')) input('feed-url').value = policy.feedUrl ?? ''
      }
      if (field['search-registry'] && policy) { const current = input('search-registry').value; input('search-registry').replaceChildren(...policy.registries.map(item => new Option(item.host, item.host))); if (current) input('search-registry').value = current }
      if (field['stack-path']) field['stack-path'].textContent = policy?.stackPath ?? t('Not read')
      const list = policy?.registries ?? []
      fill('registries', list.map(item => ({ host: item.host, namespace: item.namespace ?? t('Any'), mirror: item.mirror ?? t('None') })), t('No registry is trusted, so no image can be pulled.'), (row, position) => {
        const item = list[position]!, edit = viewAction(row, 'edit'); edit.dataset.ctrOpen = 'true'
        edit.addEventListener('click', () => { input('registry-host').value = item.host; input('registry-namespace').value = item.namespace ?? ''; input('registry-mirror').value = item.mirror ?? '' })
        const remove = viewAction(row, 'remove'); remove.dataset.ctrOpen = 'true'
        remove.addEventListener('click', () => { void savePolicy({ registries: list.filter(entry => entry !== item) }) })
      })
      if (field.app && policy) { const current = input('app').value; input('app').replaceChildren(...policy.apps.map(app => new Option(app.name, app.id))); if (current) input('app').value = current }
      const apps = policy?.apps ?? []
      fill('apps', apps.map(app => ({ name: app.name, description: t(app.description), version: app.version })), t('The catalog has not been read.'), (row, position) => {
        const app = apps[position]!, choose = viewAction(row, 'choose'); choose.dataset.ctrOpen = 'true'
        choose.addEventListener('click', () => { input('app').value = app.id; input('app-version').value = app.version; input('app-name').value = app.id; input('app-name').focus() })
      })
      paintTemplates()
    }
    const paintScope = (): void => {
      const stats = scope?.stats ?? []
      fill('stats', stats.map(row => ({ name: row.name, state: stateLabel(row.state), cpu: row.cpu === 'Not read' ? t('Not read') : row.cpu, memory: row.memory === 'Not read' ? t('Not read') : row.memory, network: row.network === 'Not read' ? t('Not read') : row.network })), scope ? t('This scope reports no containers.') : t('No containers have been read.'), (row, position) => {
        const button = viewAction(row, 'details'); button.dataset.ctrOpen = 'true'; button.setAttribute('aria-label', t('Details of {name}', { name: stats[position]!.name }))
        button.addEventListener('click', () => { void openDetail(stats[position]!.id) })
      })
      paintStacks()
      const images = scope?.images ?? []
      const store = scope?.scope === 'account' ? t('This account store is empty.') : t('Choose an account to manage its store.')
      fill('images', images.map(image => ({ reference: image.id.slice(0, 12), tags: image.tags.join(', ') || t('Untagged'), size: image.size ?? t('Not read') })), store, (row, position) => {
        const image = images[position]!
        viewAction(row, 'push').addEventListener('click', () => { if (value('push-destination')) void run({ op: 'image.push', id: image.id, destination: value('push-destination') }) })
        viewAction(row, 'export').addEventListener('click', () => { if (value('archive-path')) void run({ op: 'image.export', id: image.id, path: value('archive-path') }) })
        viewAction(row, 'remove').addEventListener('click', () => { void run({ op: 'image.remove', id: image.id }, [t('Remove image {name}?', { name: image.tags[0] ?? image.id.slice(0, 12) }), t('The image leaves this account store. A container that uses it blocks the removal.')]) })
      })
      const networks = scope?.networks ?? []
      fill('networks', networks.map(item => ({ name: item.name, driver: item.driver ?? t('Not read'), subnets: item.subnets.join(', ') || t('None') })), store, (row, position) => {
        const item = networks[position]!; viewAction(row, 'remove').addEventListener('click', () => { void run({ op: 'network.remove', name: item.name }, [t('Remove network {name}?', { name: item.name }), t('Containers attached to it block the removal.')]) })
      })
      const volumes = scope?.volumes ?? []
      fill('volumes', volumes.map(item => ({ name: item.name, driver: item.driver })), store, (row, position) => {
        const item = volumes[position]!; viewAction(row, 'remove').addEventListener('click', () => { void run({ op: 'volume.remove', name: item.name }, [t('Remove volume {name}?', { name: item.name }), t('Its data is deleted and cannot be recovered.')]) })
      })
      const logins = scope?.logins ?? []
      fill('logins', logins.map(item => ({ host: item.host, username: item.username })), t('No registry login is saved for this scope.'), (row, position) => {
        const item = logins[position]!; viewAction(row, 'logout').addEventListener('click', () => { void run({ op: 'registry.logout', host: item.host }) })
      })
      if (field.network) input('network').replaceChildren(...networks.filter(item => item.name !== 'podman').map(item => new Option(item.name, item.name)))
      if (field.detail && detail && scope && detail.account !== scope.account) { field.detail.hidden = true; detail = null }
    }
    const paint = (): void => { paintAccounts(); paintPolicy(); paintScope(); lock() }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading the container store…'))
      try {
        accounts = parse('accounts', await transport!('GET', BASE + '/accounts')); policy = parse('policy', await transport!('GET', BASE + '/policy'))
        paintAccounts()
        const wanted = account.value
        scope = parse('scope', await transport!('GET', BASE + '/scope' + (wanted ? '?account=' + encodeURIComponent(wanted) : '')))
        if (!admitted()) return
        review = false
        note(scope!.state === 'read' ? 'read' : 'unavailable', scope!.state === 'read' ? (scope!.scope === 'account' ? t('Store of {name} read. Changes run as this account and are verified.', { name: wanted }) : t('Host engines read. Choose an account to change a store.')) : reasonText(scope!.reason))
      } catch (error) { if (admitted()) { scope = null; refusal(error, false) } }
      finally { busy = false; paint() }
    }
    const done = (result: unknown): void => {
      const id = (result as { job?: { id?: unknown } } | null)?.job?.id
      if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) { review = true; jobLink.href = '/whm/jobs?job=' + encodeURIComponent(id); job.hidden = false; note('submitted', t('Host job submitted. Read the store again after it finishes.')); return }
      note('read', t('Saved. Unit states show the result after the next read.'))
    }
    async function run(change: CtrOp, confirm?: [string, string]): Promise<boolean> {
      if (busy || !manageable()) return false
      busy = true; lock()
      let saved = false
      try {
        if (confirm && await askDialog!({ title: confirm[0], body: confirm[1], danger: true, confirm: t('Continue') }).catch(() => false) !== true) return false
        note('reading', t('Submitting the change…'))
        done(await transport!('POST', BASE + '/op', { account: scope!.account, expectedRevision: scope!.revision, action: change }))
        saved = true
        return true
      } catch (error) { refusal(error, true); return false }
      finally {
        busy = false; lock()
        if (saved && !review) void load()
      }
    }
    async function savePolicy(change: Partial<Pick<CtrPolicyView, 'registries' | 'templates'>>): Promise<void> {
      if (busy || !admitted() || !policy) return
      busy = true; lock(); note('reading', t('Saving the trust policy…'))
      try { policy = parse('policy', await transport!('POST', BASE + '/policy', { expectedRevision: policy.revision, policy: { registries: policy.registries, templates: policy.templates, feedUrl: policy.feedUrl, ...change } })); note('read', t('Trust policy saved. Pulls use it now; no restart is needed.')); paintPolicy() }
      catch (error) { refusal(error, true) }
      finally { busy = false; lock() }
    }
    async function updateCatalog(): Promise<void> {
      const envelope = input('catalog-envelope').value.trim(), url = value('feed-url')
      if (busy || !admitted() || !envelope && !url) return
      busy = true; lock(); note('reading', t('Verifying the catalog…'))
      try { policy = parse('policy', await transport!('POST', BASE + '/catalog', envelope ? { envelope, url: null } : { envelope: null, url })); input('catalog-envelope').value = ''; note('read', t('Catalog verified and stored.')); paintPolicy() }
      catch (error) { refusal(error, false) }
      finally { busy = false; lock() }
    }
    async function searchRegistry(): Promise<void> {
      if (busy || !scope?.account || !value('search-term')) return
      busy = true; lock(); note('reading', t('Searching the registry…'))
      try {
        const view = parse('search', await transport!('GET', BASE + '/search?account=' + encodeURIComponent(scope.account) + '&registry=' + encodeURIComponent(value('search-registry')) + '&term=' + encodeURIComponent(value('search-term'))))
        const results: { name: string; description: string; stars: number; official: boolean }[] = view.results
        fill('search', results.map(row => ({ name: row.name + (row.official ? ' (' + t('official') + ')' : ''), description: row.description, stars: String(row.stars) })), t('The registry found nothing. Only trusted names are listed.'), (row, position) => {
          const use = viewAction(row, 'use'); use.dataset.ctrOpen = 'true'; use.addEventListener('click', () => { input('image').value = results[position]!.name + ':latest'; input('image').focus() })
        })
        note('read', t('Search finished. Pick a tag before you pull.'))
      } catch (error) { refusal(error, false) }
      finally { busy = false; lock() }
    }
    const logsState = (message: string): void => { if (field['logs-state']) field['logs-state'].textContent = message }
    const stopFollow = (): void => { follow?.abort(); follow = null }
    /** Keeps the newest lines on screen while the server streams; the stream ends by itself after ten minutes. */
    async function followLogs(query: string, target: HTMLElement): Promise<void> {
      stopFollow()
      const control = new AbortController(), lines: string[] = []
      follow = control; logsState(t('Following live.'))
      try {
        const response = await fetch(BASE + '/log-stream' + query, { credentials: 'same-origin', signal: control.signal })
        if (!response.ok || !response.body) throw new Error('log_stream_unavailable')
        const reader = response.body.getReader(), decoder = new TextDecoder()
        let pending = ''
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          pending += decoder.decode(next.value, { stream: true })
          const parts = pending.split('\n')
          pending = parts.pop() ?? ''
          for (const part of parts) { const item = JSON.parse(part) as { line?: unknown }; if (typeof item.line === 'string') lines.push(item.line) }
          lines.splice(0, Math.max(0, lines.length - 1000))
          if (lines.length) { target.textContent = lines.join('\n'); target.scrollTop = target.scrollHeight }
        }
        if (follow === control) { follow = null; logsState(t('The live log ended. Follow it again to continue.')) }
      } catch { if (!control.signal.aborted) { follow = null; logsState(t('The live log could not be read.')) } else logsState(t('Logs are not being followed.')) }
    }
    async function openDetail(id: string): Promise<void> {
      if (!admitted() || !field.detail) return
      try {
        const row = scope?.stats.find(item => item.id === id)
        const query = scope?.scope === 'account' ? '?account=' + encodeURIComponent(scope.account!) + '&id=' + id : '?engine=' + encodeURIComponent(row?.engine ?? 'podman') + '&id=' + id
        detail = parse('detail', await transport!('GET', BASE + '/detail' + query))
        const d = detail!, set = (key: string, text: string): void => { field[key]!.textContent = text }
        set('detail-name', d.name); set('detail-image', d.image); set('detail-state', stateLabel(d.state)); set('detail-started', d.startedAt ?? t('Not read')); set('detail-ips', d.ips.join(', ') || t('None')); set('detail-ports', d.ports.join(', ') || t('None'))
        set('detail-networks', d.networks.join(', ') || t('None')); set('detail-restart', d.restart ?? t('Not read')); set('detail-mounts', d.mounts.map(m => m.source + ' -> ' + m.target + (m.readOnly ? ' (ro)' : '')).join(', ') || t('None')); set('detail-logs', d.logs.join('\n') || t('No log lines.'))
        field.detail.hidden = false; field.managed!.hidden = d.managed === null; field.terminal!.hidden = d.scope !== 'account'
        terminalLink()
        void followLogs(logQuery(), field['detail-logs']!)
        if (d.managed) input('restart').value = d.managed.restart
        field.detail.scrollIntoView({ block: 'nearest' })
      } catch (error) { refusal(error, false) }
    }
    const logQuery = (): string => detail?.scope === 'account' ? '?account=' + encodeURIComponent(detail.account!) + '&id=' + detail.id : '?engine=' + encodeURIComponent(scope?.stats.find(item => item.id === detail?.id)?.engine ?? 'podman') + '&id=' + detail!.id
    const terminalLink = (): void => {
      const link = field['terminal-link'] as HTMLAnchorElement | undefined
      if (!link || !detail?.account) return
      const url = new URL(link.href, location.href)
      url.searchParams.set('account', detail.account); url.searchParams.set('container', detail.id); url.searchParams.set('shell', value('terminal-shell')); url.searchParams.set('user', value('terminal-user'))
      link.href = url.pathname + url.search
    }
    async function stackLogs(name: string): Promise<void> {
      if (!scope?.account || !field['stack-logs']) return
      field['stack-logs'].hidden = false
      void followLogs('?account=' + encodeURIComponent(scope.account) + '&stack=' + encodeURIComponent(name), field['stack-logs'])
    }
    const handlers: Record<string, () => void> = {
      read: () => { void load() },
      'detail-logs': () => { if (follow) stopFollow(); else if (detail) void followLogs(logQuery(), field['detail-logs']!) },
      'restart-save': () => { if (detail?.managed) void run({ op: 'stack.restart-policy', name: detail.managed.stack, service: detail.managed.service, restart: input('restart').value as 'no' | 'on-failure' | 'always' }) },
      'network-join': () => { if (detail?.managed && value('network')) void run({ op: 'stack.network', name: detail.managed.stack, network: value('network'), connected: true }, [t('Join network {name}?', { name: value('network') }), t('The stack restarts to join the network.')]) },
      'network-leave': () => { if (detail?.managed && value('network')) void run({ op: 'stack.network', name: detail.managed.stack, network: value('network'), connected: false }, [t('Leave network {name}?', { name: value('network') }), t('The stack restarts to leave the network.')]) },
      commit: () => { if (detail && value('commit-tag')) void run({ op: 'container.commit', id: detail.id, tag: value('commit-tag') }) },
      'stack-save': () => { void run({ op: 'stack.save', name: value('stack-name'), yaml: input('stack-yaml').value, env: editing && !input('stack-env').value ? null : input('stack-env').value, notes: value('stack-notes'), template: optional('stack-template') }).then(ok => { if (ok) editing = null }) },
      'stack-clear': () => { editing = null; for (const key of ['stack-name', 'stack-yaml', 'stack-env', 'stack-notes', 'stack-template']) { input(key).value = ''; input(key).placeholder = '' } },
      'app-install': () => { void run({ op: 'app.install', app: value('app'), name: value('app-name'), version: value('app-version'), bind: value('app-bind') === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1', port: Number(value('app-port')), memoryMb: number('app-memory'), cpuPercent: number('app-cpu') }) },
      search: () => { void searchRegistry() },
      'catalog-update': () => { void updateCatalog() },
      'image-import': () => { if (value('archive-path')) void run({ op: 'image.import', path: value('archive-path') }) },
      'image-build': () => { void run({ op: 'image.build', tag: value('build-tag'), context: value('build-context'), containerfile: input('build-file').value.trim() ? input('build-file').value : null }) },
      'image-pull': () => { if (value('image')) void run({ op: 'image.pull', image: value('image') }) },
      'image-prune': () => { void run({ op: 'image.prune' }, [t('Remove unused images?'), t('Images no container uses leave this account store. A stopped stack pulls its images again when it starts.')]) },
      repair: () => { void run({ op: 'engine.repair' }, [t('Repair container storage?'), t('Podman re-reads its storage for this account. Running containers stop during the repair. Restart any stack that does not come back.')]) },
      'registry-save': () => { if (policy && value('registry-host')) { const next = { host: value('registry-host'), namespace: optional('registry-namespace'), mirror: optional('registry-mirror') }; void savePolicy({ registries: [...policy.registries.filter(item => item.host !== next.host || item.namespace !== next.namespace), next] }) } },
      login: () => { const password = input('login-password').value; input('login-password').value = ''; if (value('login-host') && password) void run({ op: 'registry.login', host: value('login-host'), username: value('login-username'), password }) },
      'network-create': () => { void run({ op: 'network.create', name: value('network-name'), subnet: optional('network-subnet'), gateway: optional('network-gateway'), range: optional('network-range'), ipv6Subnet: optional('network-ipv6'), labels: words('network-labels') }) },
      'network-prune': () => { void run({ op: 'network.prune' }, [t('Remove unused networks?'), t('Networks no container uses leave this account store.')]) },
      'volume-create': () => { void run({ op: 'volume.create', name: value('volume-name'), options: words('volume-options'), labels: words('volume-labels') }) },
      'volume-prune': () => { void run({ op: 'volume.prune' }, [t('Remove unused volumes?'), t('Volumes no container mounts are deleted, except volumes a saved stack declares. Their data cannot be recovered.')]) },
    }
    if (!admitted()) { (action.read as HTMLButtonElement).disabled = true; note('unavailable', t('Container reads are unavailable here. Nothing was read or changed.')); return }
    for (const [key, node] of Object.entries(action)) node.addEventListener('click', () => { handlers[key]?.() })
    account.addEventListener('change', () => { stopFollow(); job.hidden = true; editing = null; void load() })
    field['terminal-shell']?.addEventListener('change', terminalLink); field['terminal-user']?.addEventListener('change', terminalLink)
    window.addEventListener('pagehide', stopFollow)
    field['template-search']?.addEventListener('input', () => { paintTemplates(); lock() })
    void load()
  })
}

export const CTR_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parse=${readCtrView.toString()};const bind=${bindCtr.toString()};return (ask)=>bind(ask,parse);})()`
