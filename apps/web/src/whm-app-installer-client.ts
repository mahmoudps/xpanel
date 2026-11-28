/// <reference lib="dom" />
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'

const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatClientBytes = canonicalFormatClientBytes
const frameRequest = canonicalFrameRequest

export interface DistroPackageComponent {
  id: string
  page: 'catalog' | 'module' | 'runtime'
  category: string
  name: string
  description: string
  packages: string[]
  state: 'installed' | 'partial' | 'absent' | 'unavailable'
  needsReview: boolean
  installed: { name: string; versions: string[] }[]
  estimate: { memoryMb: number; diskMb: number }
}

export interface DistroPackagesView {
  state: 'read' | 'unavailable'
  reason: string | null
  family: 'debian' | 'rhel' | null
  observedAt: string | null
  revision: string | null
  components: DistroPackageComponent[]
  manage: boolean
}

export interface DistroPackagePreview {
  state: 'ready' | 'refused' | 'unavailable'
  reason: string | null
  blockers: string[]
  action: 'install' | 'remove'
  revision: string
  componentIds: string[]
  resolvedComponentIds: string[]
  extraRemovals: string[]
  extraRemovalsFingerprint: string | null
}

export interface SiteCatalogApp {
  id: string
  name: string
  versions: string[]
  stored: string[]
}

export interface SiteInstallerTarget {
  accountId: string
  username: string
  domainId: string
  domain: string
  docRoot: string
  siteType: string
}

export interface SiteInstallerInstance {
  username: string
  accountId: string
  domainId: string
  domain: string
  path: string
  appId: string
  version: string
  revision: string | null
}

export interface SiteInstallerView {
  state: 'read' | 'unavailable'
  reason: string | null
  catalogRevision: string | null
  catalogState: 'read' | 'unavailable'
  applications: SiteCatalogApp[]
  offered: string[]
  targets: SiteInstallerTarget[]
  instances: SiteInstallerInstance[]
}

export interface InstallerJobResult {
  job: {
    id: string
    kind: string
    status: string
  }
}

/** Strict boundary parser for /api/server/software/distro-packages* responses. */
export function parseDistroPackagesResponse(kind: 'view' | 'preview' | 'job', raw: unknown): any {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_distro_packages_' + kind) }
  const safeText = (item: unknown, max: number): string =>
    typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff<>]/.test(item) ? item : bad()
  const hash = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const id = (item: unknown): string => typeof item === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(item) ? item : bad()
  const pkg = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9+._:-]{0,127}$/.test(item) ? item : bad()
  const ver = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9.+~:_-]{1,256}$/.test(item) ? item : bad()
  const list = <T>(item: unknown, max: number, each: (entry: unknown) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(each) : bad()
  const oneOf = <T extends string>(item: unknown, values: readonly T[]): T => values.includes(item as T) ? item as T : bad()
  const count = (item: unknown): number => Number.isSafeInteger(item) && (item as number) >= 0 ? item as number : bad()

  if (kind === 'job') {
    if (!object(raw) || !object(raw.job)) return bad()
    return {
      job: {
        id: typeof raw.job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.job.id) ? raw.job.id : bad(),
        kind: oneOf(raw.job.kind, ['software.component.install', 'software.component.remove'] as const),
        status: oneOf(raw.job.status, ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const),
      },
    } satisfies InstallerJobResult
  }

  if (kind === 'preview') {
    const p = object(raw) && object(raw.preview) ? raw.preview : bad()
    const preview: DistroPackagePreview = {
      state: oneOf(p.state, ['ready', 'refused', 'unavailable'] as const),
      reason: p.reason === null || p.reason === undefined ? null : safeText(p.reason, 128),
      blockers: Array.isArray(p.blockers) ? list(p.blockers, 64, entry => safeText(entry, 160)) : [],
      action: oneOf(p.action, ['install', 'remove'] as const),
      revision: hash(p.revision),
      componentIds: list(p.componentIds, 16, id),
      resolvedComponentIds: list(p.resolvedComponentIds ?? p.componentIds, 64, id),
      extraRemovals: Array.isArray(p.extraRemovals) ? list(p.extraRemovals, 2000, pkg) : [],
      extraRemovalsFingerprint: p.extraRemovalsFingerprint === null || p.extraRemovalsFingerprint === undefined ? null : hash(p.extraRemovalsFingerprint),
    }
    if ((preview.extraRemovals.length > 0) !== (preview.extraRemovalsFingerprint !== null)) return bad()
    return { preview }
  }

  if (!object(raw) || !object(raw.actions) || typeof raw.actions.manage !== 'boolean') return bad()
  const state = oneOf(raw.state, ['read', 'unavailable'] as const)
  const seen = new Set<string>()
  const components = list(raw.components, 512, entry => {
    if (!object(entry) || typeof entry.needsReview !== 'boolean' || !object(entry.estimate)) return bad()
    const item: DistroPackageComponent = {
      id: id(entry.id),
      page: oneOf(entry.page, ['catalog', 'module', 'runtime'] as const),
      category: typeof entry.category === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(entry.category) ? entry.category : bad(),
      name: safeText(entry.name, 80),
      description: safeText(entry.description, 400),
      packages: list(entry.packages, 16, pkg),
      state: oneOf(entry.state, ['installed', 'partial', 'absent', 'unavailable'] as const),
      needsReview: entry.needsReview,
      installed: list(entry.installed, 16, inst => object(inst) ? { name: pkg(inst.name), versions: list(inst.versions, 8, ver) } : bad()),
      estimate: { memoryMb: count(entry.estimate.memoryMb), diskMb: count(entry.estimate.diskMb) },
    }
    if (seen.has(item.id)) return bad()
    seen.add(item.id)
    return item
  })
  const view: DistroPackagesView = {
    state,
    reason: raw.reason === null || raw.reason === undefined ? null : safeText(raw.reason, 128),
    family: raw.family === null || raw.family === undefined ? null : oneOf(raw.family, ['debian', 'rhel'] as const),
    observedAt: raw.observedAt === null || raw.observedAt === undefined ? null : safeText(raw.observedAt, 64),
    revision: raw.revision === null || raw.revision === undefined ? null : hash(raw.revision),
    components,
    manage: raw.actions.manage,
  }
  if (view.state === 'read' && view.revision === null) return bad()
  return view
}

/** Shared strict parser for one-click deploy and app-installer payloads. */
export function parseSiteCatalogPayload(kind: 'view' | 'job', raw: unknown): SiteInstallerView | InstallerJobResult {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_app_installer_' + kind) }
  const safeText = (item: unknown, max: number): string =>
    typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff<>]/.test(item) ? item : bad()
  const nonEmptyText = (item: unknown, max: number): string => {
    const value = safeText(item, max)
    return value.length > 0 ? value : bad()
  }
  const hash = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item) ? item : bad()
  const appId = (item: unknown): string => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item) ? item : bad()
  const appVer = (item: unknown): string => typeof item === 'string' && /^[A-Za-z0-9.+_-]{1,64}$/.test(item) ? item : bad()
  const uuid = (item: unknown): string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item) ? item : bad()
  const list = <T>(item: unknown, max: number, each: (entry: unknown) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(each) : bad()
  const oneOf = <T extends string>(item: unknown, values: readonly T[]): T => values.includes(item as T) ? item as T : bad()

  if (kind === 'job') {
    if (!object(raw) || !object(raw.job)) return bad()
    return {
      job: {
        id: typeof raw.job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.job.id) ? raw.job.id : bad(),
        kind: oneOf(raw.job.kind, ['application.install', 'application.remove'] as const),
        status: oneOf(raw.job.status, ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const),
      },
    }
  }

  if (!object(raw)) return bad()
  const state = oneOf(raw.state, ['read', 'unavailable'] as const)
  const reason = raw.reason === null || raw.reason === undefined ? null : safeText(raw.reason, 128)
  const offered = list(raw.offered ?? [], 64, appId)
  const targets = list(raw.targets ?? [], 512, entry => {
    if (!object(entry)) return bad()
    return {
      accountId: uuid(entry.accountId),
      username: nonEmptyText(entry.username, 32),
      domainId: uuid(entry.domainId),
      domain: nonEmptyText(entry.domain, 253),
      docRoot: nonEmptyText(entry.docRoot, 512),
      siteType: nonEmptyText(entry.siteType, 32),
    }
  })
  const instances = list(raw.instances ?? [], 1024, entry => {
    if (!object(entry)) return bad()
    return {
      username: nonEmptyText(entry.username, 32),
      accountId: typeof entry.accountId === 'string' && entry.accountId.length > 0 ? uuid(entry.accountId) : '',
      domainId: uuid(entry.domainId),
      domain: nonEmptyText(entry.domain, 253),
      path: typeof entry.path === 'string' ? safeText(entry.path, 256) : '',
      appId: appId(entry.appId),
      version: appVer(entry.version),
      revision: typeof entry.revision === 'string' ? hash(entry.revision) : null,
    }
  })

  let catalogRevision: string | null = null
  let catalogState: 'read' | 'unavailable' = 'unavailable'
  let applications: SiteCatalogApp[] = []
  if (raw.host !== null && raw.host !== undefined) {
    if (!object(raw.host) || !object(raw.host.catalog)) return bad()
    const cat = raw.host.catalog
    catalogState = oneOf(cat.state, ['read', 'unavailable'] as const)
    catalogRevision = cat.revision === null || cat.revision === undefined ? null : hash(cat.revision)
    applications = list(cat.applications ?? [], 64, entry => {
      if (!object(entry)) return bad()
      const versions = list(entry.versions ?? [], 16, appVer)
      const stored = Array.isArray(entry.stored) ? list(entry.stored, 16, appVer) : []
      return { id: appId(entry.id), name: nonEmptyText(entry.name, 120), versions, stored }
    })
  }

  return { state, reason, catalogRevision, catalogState, applications, offered, targets, instances }
}

/** Strict parser for /api/server/software/one-click* responses. */
export function parseOneClickResponse(kind: 'view' | 'job', raw: unknown): any {
  return parseSiteCatalogPayload(kind, raw)
}

/** Strict parser for /api/server/software/app-installer* responses. */
export function parseAppInstallerResponse(kind: 'view' | 'job', raw: unknown): any {
  return parseSiteCatalogPayload(kind, raw)
}

function bindWhmAppInstaller(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const cleanSubPath = (raw: string): string => {
    const trimmed = raw.trim().replace(/^\/+|\/+$/g, '')
    if (!trimmed) return ''
    if (trimmed.length > 64 || trimmed.includes('..') || !/^[a-z0-9._-]+(?:\/[a-z0-9._-]+){0,3}$/i.test(trimmed)) {
      throw new Error('invalid_subpath')
    }
    return trimmed
  }
  const formatErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message === 'invalid_subpath') {
      return t('Subdirectory path may contain only alphanumeric segments separated by single slashes.')
    }
    const statusCode = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
    if (statusCode === 409) return t('Catalog or instance state changed since it was read. Refresh and try again.')
    if (statusCode === 412) return t('This host operation is currently unavailable. Nothing was changed.')
    if (statusCode === 404) return t('The requested target domain or offered application was not found.')
    return fallback
  }

  // 1. Bind OS Distribution Packages section ([data-whm-distro-packages]).
  document.querySelectorAll<HTMLElement>('[data-whm-distro-packages]').forEach(root => {
    if (root.dataset.dpBound === 'true') return
    root.dataset.dpBound = 'true'

    const pageSelect = root.querySelector<HTMLSelectElement>('[data-dp-page]')
    const searchInput = root.querySelector<HTMLInputElement>('[data-dp-search]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-dp-refresh]')
    const statusEl = root.querySelector<HTMLElement>('[data-dp-status]')
    const rowsEl = root.querySelector<HTMLElement>('[data-dp-rows]')
    const previewPanel = root.querySelector<HTMLElement>('[data-dp-preview]')
    const previewSummary = root.querySelector<HTMLElement>('[data-dp-preview-summary]')
    const acceptExtra = root.querySelector<HTMLInputElement>('[data-dp-accept-extra]')
    const confirmBtn = root.querySelector<HTMLButtonElement>('[data-dp-confirm]')
    const cancelBtn = root.querySelector<HTMLButtonElement>('[data-dp-cancel]')
    const jobEl = root.querySelector<HTMLElement>('[data-dp-job]')
    const jobLink = root.querySelector<HTMLAnchorElement>('[data-dp-job-link]')
    if (!pageSelect || !searchInput || !refreshBtn || !statusEl || !rowsEl || !previewPanel || !previewSummary || !acceptExtra || !confirmBtn || !cancelBtn || !jobEl || !jobLink) return

    const clone = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(root, name), tag, slots)
    try {
      clone('distro-pkg-row', 'tr', ['name', 'packages', 'state', 'installed', 'estimate', 'install', 'remove'])
      clone('distro-pkg-empty', 'tr', ['message'])
    } catch {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(ctrl => { ctrl.disabled = true })
      statusEl.textContent = t('Distribution packages are unavailable here. Nothing was read or changed.')
      statusEl.dataset.state = 'unavailable'
      return
    }

    const transport = frameRequest(root)
    const admitted = (): boolean => typeof transport === 'function' && root.isConnected && root.dataset.dpCanRead === 'true'
    let view: DistroPackagesView | null = null
    let activePreview: DistroPackagePreview | null = null
    let busy = false

    const inDeniedFrame = (): boolean =>
      root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null
    const canManage = (): boolean =>
      admitted() && root.dataset.dpCanManage === 'true' && view?.state === 'read' && view.manage && typeof askDialog === 'function' && !inDeniedFrame()

    const setStatus = (state: string, text: string): void => {
      statusEl.dataset.state = state
      statusEl.textContent = text
    }

    const syncControls = (): void => {
      const readAllowed = admitted()
      const frozen = inDeniedFrame()
      const locked = busy || !readAllowed || frozen
      refreshBtn.disabled = locked
      pageSelect.disabled = locked || view === null
      searchInput.disabled = locked || view === null
      const readyPreview = !busy && activePreview !== null && activePreview.state === 'ready' && canManage()
      const extraAccepted = !activePreview || activePreview.extraRemovals.length === 0 || acceptExtra.checked
      acceptExtra.disabled = busy || !activePreview || activePreview.extraRemovals.length === 0 || !canManage()
      confirmBtn.disabled = !readyPreview || !extraAccepted
      cancelBtn.disabled = busy || activePreview === null
      rowsEl.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
        if (!canManage() || busy) btn.disabled = true
      })
    }

    const clearPreview = (): void => {
      activePreview = null
      acceptExtra.checked = false
      previewSummary.textContent = ''
      previewPanel.hidden = true
      syncControls()
    }

    const renderRows = (): void => {
      rowsEl.replaceChildren()
      if (!view || view.components.length === 0) {
        const empty = clone('distro-pkg-empty', 'tr', ['message'])
        clientTemplateSlot(empty, 'message').textContent = t('No matching distribution packages found.')
        rowsEl.append(empty)
        return
      }
      const manageNow = canManage()
      const stateLabels: Record<string, string> = {
        installed: t('Installed'),
        partial: t('Partial'),
        absent: t('Available'),
        unavailable: t('Unavailable'),
      }
      for (const comp of view.components) {
        const row = clone('distro-pkg-row', 'tr', ['name', 'packages', 'state', 'installed', 'estimate', 'install', 'remove'])
        clientTemplateSlot(row, 'name').textContent = comp.name
        clientTemplateSlot(row, 'packages').textContent = comp.packages.join(', ')
        clientTemplateSlot(row, 'state').textContent = stateLabels[comp.state] ?? comp.state
        clientTemplateSlot(row, 'installed').textContent = comp.installed.length > 0
          ? comp.installed.map(inst => inst.name + '@' + inst.versions.join('/')).join(', ')
          : '-'
        clientTemplateSlot(row, 'estimate').textContent = formatClientBytes(comp.estimate.diskMb * 1048576)
        const installBtn = clientTemplateSlot(row, 'install') as HTMLButtonElement
        const removeBtn = clientTemplateSlot(row, 'remove') as HTMLButtonElement
        installBtn.textContent = t('Install')
        removeBtn.textContent = t('Remove')
        installBtn.disabled = !manageNow || comp.state === 'installed' || comp.state === 'unavailable'
        removeBtn.disabled = !manageNow || comp.state === 'absent' || comp.state === 'unavailable'
        installBtn.addEventListener('click', () => { void runPreview('install', comp.id) })
        removeBtn.addEventListener('click', () => { void runPreview('remove', comp.id) })
        rowsEl.append(row)
      }
    }

    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true
      clearPreview()
      syncControls()
      setStatus('reading', t('Reading distribution packages…'))
      try {
        const params = new URLSearchParams()
        const page = pageSelect.value
        const term = searchInput.value.trim()
        if (page === 'catalog' || page === 'module' || page === 'runtime') params.set('page', page)
        if (term && /^[A-Za-z0-9.+_-]{1,64}$/.test(term)) params.set('q', term)
        const suffix = params.toString() ? '?' + params.toString() : ''
        const next = parseDistroPackagesResponse('view', await transport!('GET', '/api/server/software/distro-packages' + suffix)) as DistroPackagesView
        if (!admitted()) return
        view = next
        setStatus(
          next.state === 'read' ? 'read' : 'unavailable',
          next.state === 'read'
            ? t('Distribution package state read ({count} components).', { count: next.components.length })
            : t('Host package database is unavailable; displaying reviewed catalog entries only.'),
        )
        renderRows()
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Failed to read distribution packages. Nothing was changed.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    const runPreview = async (action: 'install' | 'remove', componentId: string): Promise<void> => {
      if (busy || !canManage() || !view?.revision) return
      busy = true
      syncControls()
      setStatus('reading', t('Simulating distribution package change…'))
      try {
        const parsed = parseDistroPackagesResponse('preview', await transport!('POST', '/api/server/software/distro-packages/preview', {
          action,
          componentIds: [componentId],
          expectedRevision: view.revision,
        })) as { preview: DistroPackagePreview }
        if (!admitted()) return
        activePreview = parsed.preview
        acceptExtra.checked = false
        jobEl.hidden = true
        previewSummary.textContent = parsed.preview.state === 'ready'
          ? t('{action} {components}. Extra removals: {extra}.', {
            action: parsed.preview.action === 'install' ? t('Install') : t('Remove'),
            components: parsed.preview.resolvedComponentIds.join(', '),
            extra: parsed.preview.extraRemovals.length,
          })
          : (parsed.preview.reason ?? t('Change refused by package manager.')) + (parsed.preview.blockers.length ? ' ' + parsed.preview.blockers.join(', ') : '')
        previewPanel.hidden = false
        setStatus(parsed.preview.state === 'ready' ? 'read' : 'failed', previewSummary.textContent)
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Failed to preview package change. Nothing was changed.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    const applyPreview = async (): Promise<void> => {
      if (busy || !canManage() || !activePreview || activePreview.state !== 'ready') return
      if (activePreview.extraRemovals.length > 0 && !acceptExtra.checked) return
      const reviewed = activePreview
      busy = true
      syncControls()
      let confirmed = false
      try {
        confirmed = await askDialog!({
          title: reviewed.action === 'install' ? t('Install distribution packages') : t('Remove distribution packages'),
          body: t('Apply reviewed change for {components}?', { components: reviewed.resolvedComponentIds.join(', ') }),
          danger: reviewed.action === 'remove' || reviewed.extraRemovals.length > 0,
          confirm: t('Apply package change'),
        }) === true
      } catch {
        confirmed = false
      }
      if (!confirmed || !admitted()) {
        busy = false
        syncControls()
        return
      }
      setStatus('reading', t('Submitting distribution package job…'))
      try {
        const payload: Record<string, unknown> = {
          action: reviewed.action,
          componentIds: reviewed.componentIds,
          expectedRevision: reviewed.revision,
        }
        if (reviewed.extraRemovalsFingerprint) payload.acceptExtraRemovals = reviewed.extraRemovalsFingerprint
        const { job } = parseDistroPackagesResponse('job', await transport!('POST', '/api/server/software/distro-packages/apply', payload)) as InstallerJobResult
        activePreview = null
        acceptExtra.checked = false
        previewPanel.hidden = true
        jobLink.href = '/whm/jobs?job=' + encodeURIComponent(job.id)
        jobEl.hidden = false
        setStatus('submitted', t('Package job submitted ({id}).', { id: job.id }))
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Package job submission failed. Check jobs before retrying.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    if (!admitted()) {
      refreshBtn.disabled = true
      setStatus('unavailable', t('Distribution packages are unavailable here. Nothing was read or changed.'))
      return
    }
    refreshBtn.addEventListener('click', () => { void load() })
    pageSelect.addEventListener('change', () => { void load() })
    searchInput.addEventListener('change', () => { void load() })
    acceptExtra.addEventListener('change', syncControls)
    cancelBtn.addEventListener('click', clearPreview)
    confirmBtn.addEventListener('click', () => { void applyPreview() })
    void load()
  })

  // Shared binder for One-Click Deploy and App Installer sections (all selectors passed as resolved elements).
  interface SiteInstallerElements {
    root: HTMLElement
    mode: 'one-click' | 'app-installer'
    canReadAttr: 'ocdCanRead' | 'aiCanRead'
    canManageAttr: 'ocdCanManage' | 'aiCanManage'
    readPath: string
    submitPath: string
    removePath?: string
    domainSelect: HTMLSelectElement
    appSelect: HTMLSelectElement
    versionSelect: HTMLSelectElement
    pathInput: HTMLInputElement
    submitBtn: HTMLButtonElement
    refreshBtn: HTMLButtonElement
    statusEl: HTMLElement
    rowsEl: HTMLElement
    jobEl: HTMLElement
    jobLink: HTMLAnchorElement
    rowTemplate: string
    emptyTemplate: string
  }

  const bindSiteInstallerPanel = (els: SiteInstallerElements): void => {
    const clone = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(els.root, name), tag, slots)
    const rowSlots = els.mode === 'one-click'
      ? ['domain', 'account', 'docroot', 'app', 'version']
      : ['account', 'site', 'app', 'version', 'remove']
    try {
      clone(els.rowTemplate, 'tr', rowSlots)
      clone(els.emptyTemplate, 'tr', ['message'])
    } catch {
      els.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select').forEach(ctrl => { ctrl.disabled = true })
      els.statusEl.textContent = t('Application installer is unavailable here. Nothing was read or changed.')
      els.statusEl.dataset.state = 'unavailable'
      return
    }

    const transport = frameRequest(els.root)
    const admitted = (): boolean => typeof transport === 'function' && els.root.isConnected && els.root.dataset[els.canReadAttr] === 'true'
    const parseView = (raw: unknown): SiteInstallerView =>
      (els.mode === 'one-click' ? parseOneClickResponse('view', raw) : parseAppInstallerResponse('view', raw)) as SiteInstallerView
    const parseJob = (raw: unknown): InstallerJobResult =>
      (els.mode === 'one-click' ? parseOneClickResponse('job', raw) : parseAppInstallerResponse('job', raw)) as InstallerJobResult

    let view: SiteInstallerView | null = null
    let busy = false

    const inDeniedFrame = (): boolean =>
      els.root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled') !== null

    const canManage = (): boolean =>
      admitted()
      && els.root.dataset[els.canManageAttr] === 'true'
      && view?.state === 'read'
      && view.catalogState === 'read'
      && typeof view.catalogRevision === 'string'
      && typeof askDialog === 'function'
      && !inDeniedFrame()

    const setStatus = (state: string, text: string): void => {
      els.statusEl.dataset.state = state
      els.statusEl.textContent = text
    }

    const syncVersions = (): void => {
      const selectedAppId = els.appSelect.value
      const currentVer = els.versionSelect.value
      const app = view?.applications.find(item => item.id === selectedAppId)
      const versions = app ? (app.stored.length > 0 ? app.stored : app.versions) : []
      els.versionSelect.replaceChildren()
      const blank = document.createElement('option')
      blank.value = ''
      blank.textContent = t('Select a version')
      els.versionSelect.append(blank)
      for (const version of versions) {
        const option = document.createElement('option')
        option.value = version
        option.textContent = version
        els.versionSelect.append(option)
      }
      if (versions.includes(currentVer)) els.versionSelect.value = currentVer
      else if (versions.length > 0) els.versionSelect.value = versions[0]!
    }

    const syncControls = (): void => {
      const readAllowed = admitted()
      const manageNow = canManage()
      els.refreshBtn.disabled = busy || !readAllowed || inDeniedFrame()
      els.domainSelect.disabled = busy || !manageNow || (view?.targets.length ?? 0) === 0
      els.appSelect.disabled = busy || !manageNow || els.appSelect.options.length <= 1
      els.versionSelect.disabled = busy || !manageNow || els.versionSelect.options.length <= 1
      els.pathInput.disabled = busy || !manageNow
      els.submitBtn.disabled = busy || !manageNow || !els.domainSelect.value || !els.appSelect.value || !els.versionSelect.value
      els.rowsEl.querySelectorAll<HTMLButtonElement>('button').forEach(btn => {
        if (!manageNow || busy) btn.disabled = true
      })
    }

    const populateSelectors = (): void => {
      const prevDomain = els.domainSelect.value
      const prevApp = els.appSelect.value
      els.domainSelect.replaceChildren()
      const domainBlank = document.createElement('option')
      domainBlank.value = ''
      domainBlank.textContent = t('Select a target domain')
      els.domainSelect.append(domainBlank)
      for (const target of view?.targets ?? []) {
        const option = document.createElement('option')
        option.value = target.domainId
        option.textContent = target.domain + ' (' + target.username + ')'
        els.domainSelect.append(option)
      }
      if (view?.targets.some(item => item.domainId === prevDomain)) els.domainSelect.value = prevDomain
      else if ((view?.targets.length ?? 0) > 0) els.domainSelect.value = view!.targets[0]!.domainId

      const offeredApps = (view?.applications ?? []).filter(app => view?.offered.includes(app.id))
      els.appSelect.replaceChildren()
      const appBlank = document.createElement('option')
      appBlank.value = ''
      appBlank.textContent = t('Select an application')
      els.appSelect.append(appBlank)
      for (const app of offeredApps) {
        const option = document.createElement('option')
        option.value = app.id
        option.textContent = app.name
        els.appSelect.append(option)
      }
      if (offeredApps.some(item => item.id === prevApp)) els.appSelect.value = prevApp
      else if (offeredApps.length > 0) els.appSelect.value = offeredApps[0]!.id
      syncVersions()
    }

    const renderRows = (): void => {
      els.rowsEl.replaceChildren()
      if (els.mode === 'one-click') {
        const targets = view?.targets ?? []
        if (targets.length === 0) {
          const empty = clone(els.emptyTemplate, 'tr', ['message'])
          clientTemplateSlot(empty, 'message').textContent = t('No eligible active domain document roots were found.')
          els.rowsEl.append(empty)
          return
        }
        for (const target of targets) {
          const row = clone(els.rowTemplate, 'tr', ['domain', 'account', 'docroot', 'app', 'version'])
          const installed = view?.instances.find(inst => inst.domainId === target.domainId)
          clientTemplateSlot(row, 'domain').textContent = target.domain
          clientTemplateSlot(row, 'account').textContent = target.username
          clientTemplateSlot(row, 'docroot').textContent = target.docRoot
          clientTemplateSlot(row, 'app').textContent = installed ? installed.appId : t('Available')
          clientTemplateSlot(row, 'version').textContent = installed ? installed.version : '-'
          els.rowsEl.append(row)
        }
        return
      }

      const instances = view?.instances ?? []
      if (instances.length === 0) {
        const empty = clone(els.emptyTemplate, 'tr', ['message'])
        clientTemplateSlot(empty, 'message').textContent = t('No installed site applications were reported.')
        els.rowsEl.append(empty)
        return
      }
      const manageNow = canManage()
      for (const inst of instances) {
        const row = clone(els.rowTemplate, 'tr', ['account', 'site', 'app', 'version', 'remove'])
        clientTemplateSlot(row, 'account').textContent = inst.username
        clientTemplateSlot(row, 'site').textContent = inst.path ? inst.domain + '/' + inst.path : inst.domain
        clientTemplateSlot(row, 'app').textContent = inst.appId
        clientTemplateSlot(row, 'version').textContent = inst.version
        const removeBtn = clientTemplateSlot(row, 'remove') as HTMLButtonElement
        removeBtn.textContent = t('Uninstall')
        removeBtn.disabled = !manageNow || !inst.revision
        removeBtn.addEventListener('click', () => { void submitRemove(inst) })
        els.rowsEl.append(row)
      }
    }

    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true
      syncControls()
      setStatus('reading', els.mode === 'one-click' ? t('Reading deployment targets and offered catalog…') : t('Reading application installer catalog and instances…'))
      try {
        const next = parseView(await transport!('GET', els.readPath))
        if (!admitted()) return
        view = next
        populateSelectors()
        renderRows()
        setStatus(
          next.state === 'read' ? 'read' : 'unavailable',
          next.state === 'read'
            ? t('Catalog loaded ({targets} targets, {instances} installed).', { targets: next.targets.length, instances: next.instances.length })
            : t('Signed application catalog is currently unavailable on the host.'),
        )
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Failed to read application installer catalog. Nothing was changed.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    const submitInstall = async (): Promise<void> => {
      if (busy || !canManage() || !view?.catalogRevision) return
      const domainId = els.domainSelect.value
      const appId = els.appSelect.value
      const version = els.versionSelect.value
      if (!domainId || !appId || !version) return
      let subPath = ''
      try {
        subPath = cleanSubPath(els.pathInput.value)
      } catch (error) {
        setStatus('failed', formatErrorMessage(error, t('Invalid subdirectory path.')))
        return
      }
      busy = true
      syncControls()
      let confirmed = false
      try {
        confirmed = await askDialog!({
          title: els.mode === 'one-click' ? t('Deploy application') : t('Install application'),
          body: t('Submit verified host job to deploy {app} {version}?', { app: appId, version }),
          danger: false,
          confirm: els.mode === 'one-click' ? t('Deploy application') : t('Install application'),
        }) === true
      } catch {
        confirmed = false
      }
      if (!confirmed || !admitted()) {
        busy = false
        syncControls()
        return
      }
      setStatus('reading', t('Submitting application deployment job…'))
      try {
        const payload: Record<string, unknown> = {
          domainId,
          appId,
          version,
          expectedRevision: view.catalogRevision,
          expectedCatalogRevision: view.catalogRevision,
        }
        if (subPath) payload.path = subPath
        const { job } = parseJob(await transport!('POST', els.submitPath, payload))
        els.jobLink.href = '/whm/jobs?job=' + encodeURIComponent(job.id)
        els.jobEl.hidden = false
        setStatus('submitted', t('Application job submitted ({id}).', { id: job.id }))
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Application deployment failed. Nothing was changed.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    const submitRemove = async (inst: SiteInstallerInstance): Promise<void> => {
      if (busy || !canManage() || !els.removePath || !inst.revision) return
      busy = true
      syncControls()
      let confirmed = false
      try {
        confirmed = await askDialog!({
          title: t('Uninstall application'),
          body: t('Remove {app} {version} from {site}?', { app: inst.appId, version: inst.version, site: inst.path ? inst.domain + '/' + inst.path : inst.domain }),
          danger: true,
          confirm: t('Uninstall'),
        }) === true
      } catch {
        confirmed = false
      }
      if (!confirmed || !admitted()) {
        busy = false
        syncControls()
        return
      }
      setStatus('reading', t('Submitting application removal job…'))
      try {
        const payload: Record<string, unknown> = {
          username: inst.username,
          domainId: inst.domainId,
          expectedRecord: inst.revision,
        }
        if (inst.path) payload.path = inst.path
        const { job } = parseJob(await transport!('POST', els.removePath, payload))
        els.jobLink.href = '/whm/jobs?job=' + encodeURIComponent(job.id)
        els.jobEl.hidden = false
        setStatus('submitted', t('Removal job submitted ({id}).', { id: job.id }))
      } catch (error) {
        if (admitted()) setStatus('failed', formatErrorMessage(error, t('Application removal failed. Check jobs before retrying.')))
      } finally {
        busy = false
        syncControls()
      }
    }

    if (!admitted()) {
      els.refreshBtn.disabled = true
      setStatus('unavailable', t('Application installer is unavailable here. Nothing was read or changed.'))
      return
    }
    els.refreshBtn.addEventListener('click', () => { void load() })
    els.appSelect.addEventListener('change', () => { syncVersions(); syncControls() })
    els.domainSelect.addEventListener('change', syncControls)
    els.versionSelect.addEventListener('change', syncControls)
    els.submitBtn.addEventListener('click', () => { void submitInstall() })
    void load()
  }

  // 2. Bind One-Click Deploy section ([data-whm-one-click-deploy]).
  document.querySelectorAll<HTMLElement>('[data-whm-one-click-deploy]').forEach(root => {
    if (root.dataset.ocdBound === 'true') return
    root.dataset.ocdBound = 'true'
    const domainSelect = root.querySelector<HTMLSelectElement>('[data-ocd-domain]')
    const appSelect = root.querySelector<HTMLSelectElement>('[data-ocd-app]')
    const versionSelect = root.querySelector<HTMLSelectElement>('[data-ocd-version]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-ocd-path]')
    const submitBtn = root.querySelector<HTMLButtonElement>('[data-ocd-deploy]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-ocd-refresh]')
    const statusEl = root.querySelector<HTMLElement>('[data-ocd-status]')
    const rowsEl = root.querySelector<HTMLElement>('[data-ocd-rows]')
    const jobEl = root.querySelector<HTMLElement>('[data-ocd-job]')
    const jobLink = root.querySelector<HTMLAnchorElement>('[data-ocd-job-link]')
    if (!domainSelect || !appSelect || !versionSelect || !pathInput || !submitBtn || !refreshBtn || !statusEl || !rowsEl || !jobEl || !jobLink) return
    bindSiteInstallerPanel({
      root,
      mode: 'one-click',
      canReadAttr: 'ocdCanRead',
      canManageAttr: 'ocdCanManage',
      readPath: '/api/server/software/one-click',
      submitPath: '/api/server/software/one-click/deploy',
      domainSelect,
      appSelect,
      versionSelect,
      pathInput,
      submitBtn,
      refreshBtn,
      statusEl,
      rowsEl,
      jobEl,
      jobLink,
      rowTemplate: 'one-click-row',
      emptyTemplate: 'one-click-empty',
    })
  })

  // 3. Bind App Installer section ([data-whm-app-installer]).
  document.querySelectorAll<HTMLElement>('[data-whm-app-installer]').forEach(root => {
    if (root.dataset.aiBound === 'true') return
    root.dataset.aiBound = 'true'
    const domainSelect = root.querySelector<HTMLSelectElement>('[data-ai-domain]')
    const appSelect = root.querySelector<HTMLSelectElement>('[data-ai-app]')
    const versionSelect = root.querySelector<HTMLSelectElement>('[data-ai-version]')
    const pathInput = root.querySelector<HTMLInputElement>('[data-ai-path]')
    const submitBtn = root.querySelector<HTMLButtonElement>('[data-ai-install]')
    const refreshBtn = root.querySelector<HTMLButtonElement>('[data-ai-refresh]')
    const statusEl = root.querySelector<HTMLElement>('[data-ai-status]')
    const rowsEl = root.querySelector<HTMLElement>('[data-ai-rows]')
    const jobEl = root.querySelector<HTMLElement>('[data-ai-job]')
    const jobLink = root.querySelector<HTMLAnchorElement>('[data-ai-job-link]')
    if (!domainSelect || !appSelect || !versionSelect || !pathInput || !submitBtn || !refreshBtn || !statusEl || !rowsEl || !jobEl || !jobLink) return
    bindSiteInstallerPanel({
      root,
      mode: 'app-installer',
      canReadAttr: 'aiCanRead',
      canManageAttr: 'aiCanManage',
      readPath: '/api/server/software/app-installer',
      submitPath: '/api/server/software/app-installer/install',
      removePath: '/api/server/software/app-installer/remove',
      domainSelect,
      appSelect,
      versionSelect,
      pathInput,
      submitBtn,
      refreshBtn,
      statusEl,
      rowsEl,
      jobEl,
      jobLink,
      rowTemplate: 'app-installer-row',
      emptyTemplate: 'app-installer-empty',
    })
  })
}

export const WHM_APP_INSTALLER_CLIENT_BINDING = withFrameRequest(
  `(()=>{const formatClientBytes=${ASCII_BYTES_BINDING};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const parseDistroPackagesResponse=${parseDistroPackagesResponse.toString()};const parseSiteCatalogPayload=${parseSiteCatalogPayload.toString()};const parseOneClickResponse=${parseOneClickResponse.toString()};const parseAppInstallerResponse=${parseAppInstallerResponse.toString()};return ${bindWhmAppInstaller.toString()};})()`,
)
