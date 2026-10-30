import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

/** Strict boundary parsers for the software center API. Self-contained: serialized into the page. */
export function parseSoftwareCenterResponse(kind: 'view' | 'preview' | 'job', value: unknown): any {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_software_center_' + kind) }
  const text = (item: unknown, max: number): string => typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff<>]/.test(item) ? item : bad()
  const hash = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const id = (item: unknown): string => typeof item === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(item) ? item : bad()
  const pkg = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,127}$/.test(item) ? item : bad()
  const version = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9.+~:_-]{1,256}$/.test(item) ? item : bad()
  const list = <T>(item: unknown, max: number, each: (entry: unknown) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(each) : bad()
  const count = (item: unknown): number => Number.isSafeInteger(item) && (item as number) >= 0 ? item as number : bad()
  const size = (item: unknown): number | null => item === null ? null : Number.isSafeInteger(item) ? item as number : bad()
  const oneOf = <T extends string>(item: unknown, values: readonly T[]): T => values.includes(item as T) ? item as T : bad()
  const estimate = (item: unknown) => object(item) ? { memoryMb: count(item.memoryMb), diskMb: count(item.diskMb) } : bad()
  if (kind === 'job') {
    if (!object(value) || !object(value.job)) return bad()
    return { job: { id: typeof value.job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.job.id) ? value.job.id : bad(), kind: oneOf(value.job.kind, ['software.component.install', 'software.component.remove'] as const), status: oneOf(value.job.status, ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) } }
  }
  if (kind === 'preview') {
    const raw = object(value) && object(value.preview) ? value.preview : bad()
    const change = (item: unknown) => object(item) ? { name: pkg(item.name), from: item.from === null ? null : version(item.from), to: item.to === null ? null : version(item.to) } : bad()
    if (!object(raw.packages) || !object(raw.observed)) return bad()
    const preview = {
      state: oneOf(raw.state, ['ready', 'refused', 'unavailable'] as const),
      reason: raw.reason === null ? null : oneOf(raw.reason, ['nothing-to-do', 'unknown-component', 'unavailable-on-this-os', 'protected-package', 'required-by-installed', 'conflict', 'too-many-packages', 'package-not-found', 'dependency-problem', 'simulation-unavailable', 'invalid-simulation'] as const),
      blockers: list(raw.blockers, 64, entry => text(entry, 160)), action: oneOf(raw.action, ['install', 'remove'] as const), family: oneOf(raw.family, ['debian', 'rhel'] as const), revision: hash(raw.revision),
      componentIds: list(raw.componentIds, 16, id), resolvedComponentIds: list(raw.resolvedComponentIds, 64, id), pulledComponentIds: list(raw.pulledComponentIds, 64, id), requestedPackages: list(raw.requestedPackages, 64, pkg),
      packages: { install: list(raw.packages.install, 2000, change), upgrade: list(raw.packages.upgrade, 2000, change), remove: list(raw.packages.remove, 2000, change), configure: list(raw.packages.configure, 2000, pkg) },
      extraRemovals: list(raw.extraRemovals, 2000, pkg), extraRemovalsFingerprint: raw.extraRemovalsFingerprint === null ? null : hash(raw.extraRemovalsFingerprint), protectedUpgrades: list(raw.protectedUpgrades, 2000, pkg),
      estimate: estimate(raw.estimate), observed: { downloadBytes: size(raw.observed.downloadBytes), sizeDeltaBytes: size(raw.observed.sizeDeltaBytes) }, fingerprint: hash(raw.fingerprint),
    }
    if ((preview.extraRemovals.length > 0) !== (preview.extraRemovalsFingerprint !== null) || preview.state === 'ready' && (preview.reason !== null || preview.requestedPackages.length === 0) || preview.state !== 'ready' && preview.reason === null) return bad()
    return { preview }
  }
  if (!object(value) || !object(value.actions) || typeof value.actions.manage !== 'boolean') return bad()
  const page = oneOf(value.page, ['catalog', 'module', 'runtime'] as const)
  const state = oneOf(value.state, ['read', 'unavailable'] as const)
  const observedAt = typeof value.observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.observedAt) && Number.isFinite(Date.parse(value.observedAt)) ? value.observedAt : bad()
  const seen = new Set<string>()
  const components = list(value.components, 512, raw => {
    if (!object(raw) || typeof raw.needsReview !== 'boolean') return bad()
    const item = {
      id: id(raw.id), page: raw.page === page ? page : bad(), category: typeof raw.category === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(raw.category) ? raw.category : bad(), name: text(raw.name, 80),
      description: text(raw.description, 400), phpVersion: raw.phpVersion === null ? null : typeof raw.phpVersion === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(raw.phpVersion) ? raw.phpVersion : bad(),
      packages: list(raw.packages, 8, pkg), state: oneOf(raw.state, ['installed', 'partial', 'absent', 'unavailable'] as const), needsReview: raw.needsReview,
      installed: list(raw.installed, 8, entry => object(entry) ? { name: pkg(entry.name), versions: list(entry.versions, 8, version) } : bad()),
      candidates: raw.candidates === null ? null : list(raw.candidates, 8, entry => object(entry) ? { name: pkg(entry.name), version: entry.version === null ? null : version(entry.version) } : bad()),
      services: list(raw.services, 8, entry => text(entry, 128)), requires: list(raw.requires, 16, id), conflicts: list(raw.conflicts, 16, id), requiredBy: list(raw.requiredBy, 64, id), estimate: estimate(raw.estimate),
    }
    if (seen.has(item.id) || item.state === 'unavailable' && item.packages.length !== 0 || item.state !== 'unavailable' && item.packages.length === 0 || item.installed.some(entry => !item.packages.includes(entry.name))) return bad()
    seen.add(item.id)
    return item
  })
  const view = {
    state, page, observedAt, reason: value.reason === null ? null : oneOf(value.reason, ['unsupported-host', 'package-database-unavailable', 'invalid-package-database'] as const),
    family: value.family === null ? null : oneOf(value.family, ['debian', 'rhel'] as const), revision: value.revision === null ? null : hash(value.revision),
    phpVersions: list(value.phpVersions, 16, entry => typeof entry === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(entry) ? entry : bad()), candidates: oneOf(value.candidates, ['read', 'unavailable', 'not-read'] as const), components, manage: value.actions.manage,
  }
  if (state === 'read' && (view.revision === null || view.family === null || view.reason !== null) || state === 'unavailable' && (view.revision !== null || components.length !== 0 || view.manage)) return bad()
  return view
}

function bindWhmSoftwareCenter(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-software-center]').forEach(root => {
    if (root.dataset.scBound === 'true') return
    root.dataset.scBound = 'true'
    const page = root.dataset.scPage ?? ''
    const q = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = q<HTMLElement>('[data-sc-status]'), refresh = q<HTMLButtonElement>('[data-sc-refresh]'), groups = q<HTMLElement>('[data-sc-groups]')
    const category = q<HTMLSelectElement>('[data-sc-category]'), search = q<HTMLInputElement>('[data-sc-search]')
    const panel = q<HTMLElement>('[data-sc-preview]'), confirm = q<HTMLButtonElement>('[data-sc-confirm]'), cancel = q<HTMLButtonElement>('[data-sc-cancel]'), accept = q<HTMLInputElement>('[data-sc-accept-extra]')
    const jobNote = q<HTMLElement>('[data-sc-job]'), jobLink = q<HTMLAnchorElement>('[data-sc-job-link]')
    if (!['catalog', 'module', 'runtime'].includes(page) || !status || !refresh || !groups || !category || !search || !panel || !confirm || !cancel || !accept || !jobNote || !jobLink) return
    const clone = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(root, name), tag, slots)
    try {
      clone('software-center-row', 'tr', ['name','description','packages','state','installed','candidate','estimate','relations','install','remove'])
      clone('software-center-group', 'section', ['title','scroll','head','body'])
      clone('software-center-empty', 'p', ['message'])
    } catch { root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(control => { control.disabled = true }); status.textContent = t('The software center is unavailable here. Nothing was read or changed.'); status.dataset.state = 'unavailable'; return }
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.scCanRead === 'true' && !root.closest(denied)
    let view: any = null, preview: any = null, busy = false, review = false
    const manageable = (): boolean => admitted() && root.dataset.scCanManage === 'true' && view?.state === 'read' && view.manage === true && typeof askDialog === 'function' && !review
    const columns: string[] = (() => { try { const parsed = JSON.parse(groups.dataset.scColumns ?? '[]'); return Array.isArray(parsed) && parsed.length === 7 ? parsed.map(String) : [] } catch { return [] } })()
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, technical = false): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); if (value !== undefined) { if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; node.append(bdi) } else node.textContent = value }; return node }
    const mb = (bytes: number | null): string => bytes === null ? t('Not reported by the simulation') : (bytes < 0 ? '-' : '') + (Math.abs(bytes) / 1000000).toFixed(1) + ' MB'
    const categoryLabel = (value: string): string => [...category.options].find(option => option.value === value)?.textContent ?? value
    const names = (ids: string[]): string => ids.map(item => view?.components.find((entry: any) => entry.id === item)?.name ?? item).join(', ')
    const lock = (): void => {
      refresh.disabled = busy || !admitted(); category.disabled = !view || view.state !== 'read'; search.disabled = category.disabled
      groups.querySelectorAll<HTMLButtonElement>('[data-sc-action]').forEach(button => { button.disabled = busy || !manageable() || button.dataset.scAllowed !== 'true' })
      const extras = preview?.extraRemovals.length > 0
      confirm.disabled = busy || !manageable() || preview?.state !== 'ready' || extras && !accept.checked
      cancel.disabled = busy; accept.disabled = busy || !extras
      root.setAttribute('aria-busy', String(busy))
    }
    const mixed = (parts: [string, boolean][]): HTMLTableCellElement => { const td = el('td'); for (const [value, technical] of parts) td.append(technical ? el('bdi', value) : document.createTextNode(value)); td.querySelectorAll('bdi').forEach(node => { node.dir = 'ltr' }); return td }
    // One whole message split at its {placeholders}; placeholder parts are technical values.
    const filled = (message: string, values: Record<string, string>): [string, boolean][] => message.split(/(\{\w+\})/).filter(Boolean).map((part): [string, boolean] => part in values ? [values[part]!, true] : [part, false])
    const stateBadge = (item: any): string => {
      const map: Record<string, [string, string]> = { installed: ['ok', t(msgctxt('whm-software-center-client', 'Installed'))], partial: ['warn', t('Partly installed')], absent: ['suspended', t(msgctxt('whm-software-center-client', 'Not installed'))], unavailable: ['suspended', t('Not available on this operating system')] }
      const [tone, label] = map[item.state]!
      return item.needsReview ? t('Needs review: inconsistent package state') : label
    }
    const relations = (item: any): string => {
      const parts: string[] = []
      if (item.requires.length) parts.push(t('Requires: {names}', { names: names(item.requires) }))
      if (item.requiredBy.length) parts.push(t('Required by: {names}', { names: names(item.requiredBy) }))
      if (item.conflicts.length) parts.push(t('Conflicts with: {names}', { names: names(item.conflicts) }))
      if (item.services.length) parts.push(t('Provides: {services}', { services: item.services.join(', ') }))
      return parts.length ? parts.join(' · ') : t('None')
    }
    const row = (item: any): HTMLTableRowElement => {
      const tr = clone('software-center-row', 'tr', ['name','description','packages','state','installed','candidate','estimate','relations','install','remove']) as HTMLTableRowElement
      tr.dataset.scComponent = item.id; tr.dataset.scRowCategory = item.category
      tr.dataset.scRowSearch = [item.id, item.name, t(item.description), ...item.packages].join(' ').toLowerCase()
      const set = (slot: string, text: string) => { clientTemplateSlot(tr, slot).textContent = text }
      set('name', item.name); set('description', t(item.description)); set('packages', item.packages.join(' '))
      const badge = stateBadge(item), state = clientTemplateSlot(tr, 'state'); state.textContent = badge; state.dataset.state = item.needsReview ? 'critical' : item.state
      set('installed', item.installed.length ? item.installed.map((entry: any) => entry.name + ' ' + entry.versions.join(', ')).join(' · ') : t(msgctxt('whm-software-center-client', 'Not installed')))
      clientTemplateSlot(tr, 'candidate').replaceChildren(...(view.candidates === 'read' && item.candidates ? mixed(item.candidates.flatMap((entry: any, index: number): [string, boolean][] => [...(index ? [[' · ', false] as [string, boolean]] : []), ...(entry.version === null ? filled(t('{name} not in repositories'), { '{name}': entry.name }) : [[entry.name + ' ' + entry.version, true] as [string, boolean]])])) : el('td', view.candidates === 'not-read' ? t('Read by the change preview') : t('Repository versions are unavailable'))).childNodes)
      clientTemplateSlot(tr, 'estimate').replaceChildren(...mixed(filled(t('Estimate: memory {memory} · disk {disk}'), { '{memory}': item.estimate.memoryMb + ' MB', '{disk}': item.estimate.diskMb + ' MB' })).childNodes)
      set('relations', relations(item))
      for (const action of ['install', 'remove'] as const) {
        const button = clientTemplateSlot(tr, action, 'button') as HTMLButtonElement
        button.textContent = action === 'install' ? t('Install') : t('Remove'); button.dataset.scAction = action
        button.dataset.scAllowed = String(action === 'install' ? ['absent', 'partial'].includes(item.state) : ['installed', 'partial'].includes(item.state))
        button.addEventListener('click', () => { if (!button.disabled) void runPreview(action, item.id) })
      }
      return tr
    }
    const applyFilters = (): void => {
      const wanted = category.value, term = search.value.trim().toLowerCase()
      groups.querySelectorAll<HTMLElement>('[data-sc-group]').forEach(group => {
        let visible = 0
        group.querySelectorAll<HTMLTableRowElement>('tr[data-sc-component]').forEach(tr => { const show = (!wanted || tr.dataset.scRowCategory === wanted) && (!term || (tr.dataset.scRowSearch ?? '').includes(term)); tr.hidden = !show; if (show) visible++ })
        group.hidden = visible === 0
      })
      const none = groups.querySelector<HTMLElement>('[data-sc-no-match]')
      if (none) none.hidden = !!groups.querySelector('[data-sc-group]:not([hidden])') || !view?.components.length
    }
    const paint = (): void => {
      groups.textContent = ''
      const family = q<HTMLElement>('[data-sc-family]'), observedAt = q<HTMLElement>('[data-sc-observed-at]'), php = q<HTMLElement>('[data-sc-php-versions]')
      if (family) family.textContent = view.family === 'debian' ? 'dpkg / apt' : view.family === 'rhel' ? 'rpm / dnf' : t('Unavailable')
      if (observedAt) observedAt.textContent = formatDisplayDateTime(view.observedAt)
      if (php) php.textContent = view.state !== 'read' ? t('Not read') : view.phpVersions.length ? view.phpVersions.join(', ') : t('No supported PHP version is installed')
      const buckets = new Map<string, any[]>()
      for (const item of view.components) {
        const key = page === 'module' && item.phpVersion ? 'php-' + item.phpVersion : item.category
        buckets.set(key, [...(buckets.get(key) ?? []), item])
      }
      for (const [key, items] of buckets) {
        const section = clone('software-center-group', 'section', ['title','scroll','head','body']); section.dataset.scGroup = key
        const title = key.startsWith('php-') ? 'PHP ' + key.slice(4) : categoryLabel(key)
        clientTemplateSlot(section, 'title').textContent = title; clientTemplateSlot(section, 'scroll').setAttribute('aria-label', title)
        for (const label of columns) { const th = el('th', label); th.scope = 'col'; clientTemplateSlot(section, 'head').append(th) }
        for (const item of items) clientTemplateSlot(section, 'body').append(row(item))
        groups.append(section)
      }
      const none = clone('software-center-empty', 'p', ['message']); clientTemplateSlot(none, 'message').textContent = view.components.length ? t('No components match the filters.') : view.state === 'read' ? t('No components apply to this host.') : t('No components are shown because installed packages could not be read.'); groups.append(none)
      applyFilters(); lock()
    }
    const clearPreview = (): void => { preview = null; panel.hidden = true; accept.checked = false; lock() }
    const fill = (selector: string, items: string[], fallback: string, flagged: string[] = []): void => {
      const list = q<HTMLElement>(selector)
      if (!list) return
      list.textContent = ''
      if (!items.length) { list.append(el('li', fallback)); return }
      for (const item of items) { const li = el('li', item, true); if (flagged.includes(item.split(' ')[0]!)) li.append(' ', el('span', t('Panel stack package'))); list.append(li) }
    }
    const reasonText = (reason: string | null): string => ({
      'nothing-to-do': t('Nothing to change: the component is already in the requested state.'),
      'unknown-component': t('The component is not in this host’s reviewed catalog.'),
      'unavailable-on-this-os': t('No reviewed package exists for this operating system.'),
      'protected-package': t('Refused: the change would remove or replace a protected panel stack or system package.'),
      'required-by-installed': t('Refused: another installed component requires it. Remove that component first or together.'),
      'conflict': t('Refused: the catalog marks a conflict with an installed or selected component.'),
      'too-many-packages': t('Refused: the selection names too many packages for one job.'),
      'package-not-found': t('The package manager found no candidate in the configured repositories.'),
      'dependency-problem': t('The package manager reported a dependency problem. Nothing was changed.'),
      'simulation-unavailable': t('The package manager simulation could not be run. Nothing was changed.'),
      'invalid-simulation': t('The simulation output could not be verified. Nothing was changed.'),
    } as Record<string, string>)[reason ?? ''] ?? ''
    const paintPreview = (): void => {
      const summary = q<HTMLElement>('[data-sc-preview-summary]'), extra = q<HTMLElement>('[data-sc-preview-extra]')
      const parts = { names: names(preview.resolvedComponentIds), pulled: names(preview.pulledComponentIds) }, install = preview.action === 'install', pulled = preview.pulledComponentIds.length > 0
      if (summary) summary.textContent = preview.state === 'ready'
        ? install
          ? pulled ? t('Install {names} (also required: {pulled}). Simulated by the package manager; nothing has changed yet.', parts) : t('Install {names}. Simulated by the package manager; nothing has changed yet.', parts)
          : pulled ? t('Remove {names} (also required: {pulled}). Simulated by the package manager; nothing has changed yet.', parts) : t('Remove {names}. Simulated by the package manager; nothing has changed yet.', parts)
        :reasonText(preview.reason) + (preview.blockers.length ? ' ' + preview.blockers.join(', ') : '')
      const memory = q<HTMLElement>('[data-sc-preview-memory]'), disk = q<HTMLElement>('[data-sc-preview-disk]'), download = q<HTMLElement>('[data-sc-preview-download]'), delta = q<HTMLElement>('[data-sc-preview-size]')
      if (memory) memory.textContent = preview.estimate.memoryMb + ' MB'
      if (disk) disk.textContent = preview.estimate.diskMb + ' MB'
      for (const [node, value] of [[download, preview.observed.downloadBytes], [delta, preview.observed.sizeDeltaBytes]] as const) if (node) { node.textContent = ''; node.append(value === null ? document.createTextNode(mb(null)) : el('span', mb(value), true)) }
      const changes = (items: any[]): string[] => items.map(change => change.name + (change.from && change.to ? ' ' + change.from + ' > ' + change.to : change.to ? ' ' + change.to : change.from ? ' ' + change.from : ''))
      fill('[data-sc-preview-install]', changes(preview.packages.install), t('None'))
      fill('[data-sc-preview-upgrade]', changes(preview.packages.upgrade), t('None'), preview.protectedUpgrades)
      fill('[data-sc-preview-remove]', changes(preview.packages.remove), t('None'))
      fill('[data-sc-preview-extra-list]', preview.extraRemovals, '')
      if (extra) extra.hidden = preview.extraRemovals.length === 0
      accept.checked = false; jobNote.hidden = true; panel.hidden = false; lock()
    }
    const failure = (error: unknown, change: boolean): void => {
      const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
      const statusCode = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
      if (change && !(detail && detail.stateChanged === false)) { review = true; note('uncertain', t('The submission outcome is unknown. Check the jobs page before trying again; actions stay locked until you read installed packages.')); return }
      note('failed', statusCode === 409 ? t('Installed packages changed since they were read. Read them again and review a new preview.') : statusCode === 412 ? t('The change is unavailable on this host right now. Nothing was changed.') : t('The request failed. Nothing was changed.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; clearPreview(); lock(); note('reading', t('Reading installed packages and repository candidates…'))
      try {
        const next = parseSoftwareCenterResponse('view', await transport!('GET', '/api/server/software-center?page=' + page))
        if (next.page !== page) throw new Error('page_mismatch')
        if (!admitted()) return
        view = next; review = false
        note(view.state === 'read' ? 'read' : 'failed', view.state === 'read'
          ? t('Installed state read from the package database. Install and remove are previewed by the package manager before any job is submitted.') + (view.manage ? '' : ' ' + t('Changes are unavailable: the host job runner is not connected.'))
          : view.reason === 'invalid-package-database' ? t('The package database output could not be verified. Nothing is shown as installed.') : t('The package database could not be read. Nothing is shown as installed.'))
        paint()
      } catch (error) { if (admitted()) failure(error, false) }
      finally { busy = false; lock() }
    }
    const runPreview = async (action: 'install' | 'remove', id: string): Promise<void> => {
      if (busy || !manageable() || !view?.revision) return
      busy = true; lock(); note('reading', t('Simulating the change with the package manager…'))
      try {
        const next = parseSoftwareCenterResponse('preview', await transport!('POST', '/api/server/software-center/preview', { action, componentIds: [id], expectedRevision: view.revision })).preview
        if (next.revision !== view.revision || next.action !== action || next.componentIds.join() !== id) throw new Error('preview_mismatch')
        if (!admitted()) return
        preview = next; paintPreview()
        note(preview.state === 'ready' ? 'read' : 'failed', preview.state === 'ready' ? t('Preview ready. Review the packages before submitting the host job.') : reasonText(preview.reason))
      } catch (error) { if (admitted()) failure(error, false) }
      finally { busy = false; lock() }
    }
    const submit = async (): Promise<void> => {
      if (busy || !manageable() || preview?.state !== 'ready' || preview.extraRemovals.length && !accept.checked) return
      const reviewed = preview
      busy = true; lock()
      let approved = false
      try { approved = await askDialog!({ title: reviewed.action === 'install' ? t('Install {name}', { name: names(reviewed.resolvedComponentIds) }) : t('Remove {name}', { name: names(reviewed.resolvedComponentIds) }), body: t('{install} to install, {upgrade} to upgrade, {remove} to remove. The job succeeds only after the package database confirms the result.', { install: reviewed.packages.install.length, upgrade: reviewed.packages.upgrade.length, remove: reviewed.packages.remove.length }), danger: reviewed.action === 'remove' || reviewed.extraRemovals.length > 0, confirm: t('Submit host job') }) === true } catch { approved = false }
      if (!approved || preview !== reviewed || !manageable()) { busy = false; lock(); return }
      note('reading', t('Submitting the reviewed host job…'))
      try {
        const body: Record<string, unknown> = { action: reviewed.action, componentIds: reviewed.componentIds, expectedRevision: reviewed.revision }
        if (reviewed.extraRemovalsFingerprint) body.acceptExtraRemovals = reviewed.extraRemovalsFingerprint
        const { job } = parseSoftwareCenterResponse('job', await transport!('POST', '/api/server/software-center/apply', body))
        if (job.kind !== 'software.component.' + reviewed.action) throw { details: {} }
        review = true; preview = null; panel.hidden = true
        jobLink.href = '/whm/jobs?job=' + encodeURIComponent(job.id); jobNote.hidden = false
        note('submitted', t('Host job submitted. Installed state is unchanged here until the job re-reads the package database; read installed packages again after it finishes.'))
      } catch (error) { failure(error, true) }
      finally { busy = false; lock() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('The software center is unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    category.addEventListener('change', applyFilters); search.addEventListener('input', applyFilters)
    cancel.addEventListener('click', clearPreview); accept.addEventListener('change', lock); confirm.addEventListener('click', () => { void submit() })
    void load()
  })
}

export const WHM_SOFTWARE_CENTER_CLIENT_BINDING = `(()=>{const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parseSoftwareCenterResponse=${parseSoftwareCenterResponse.toString()};return ${bindWhmSoftwareCenter.toString()};})()`
