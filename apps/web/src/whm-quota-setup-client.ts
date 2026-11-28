/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
const frameAccess = canonicalFrameAccess
const formatDisplayDateTime = sharedFormatDisplayDateTime

export const QUOTA_FILESYSTEM_OPTIONS = [
  '/home',
  ...Array.from({ length: 100 }, (_, index) => `/home${index}`),
] as const

export function isAllowedQuotaFilesystem(value: unknown): value is string {
  return typeof value === 'string' && (value === '/home' || /^\/home(?:[0-9]|[1-9][0-9])$/.test(value))
}

export interface QuotaSetupObservation {
  status: 'enabled' | 'disabled' | 'unavailable' | 'not_requested'
  reason: string | null
  filesystem: string | null
  filesystemType: string | null
  observedAt: string | null
  selectedFilesystem: string | null
  settings: Record<string, unknown> | null
  defaultSuggested: Record<string, unknown> | null
}

type AskDialog = (options: Record<string, unknown>) => Promise<unknown>
type RequestTransport = (method: string, path: string, body?: unknown) => Promise<unknown>

export function readQuotaSetupStatus(raw: unknown): QuotaSetupObservation {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!obj) throw new Error('invalid_quota_setup_reply')
  const wizard = obj.wizardState && typeof obj.wizardState === 'object' && !Array.isArray(obj.wizardState)
    ? obj.wizardState as Record<string, unknown>
    : null
  const init = obj.quotaInitialization && typeof obj.quotaInitialization === 'object' && !Array.isArray(obj.quotaInitialization)
    ? obj.quotaInitialization as Record<string, unknown>
    : null
  const rawStatus = init?.status
  const status: QuotaSetupObservation['status'] =
    rawStatus === 'enabled' || rawStatus === 'disabled' || rawStatus === 'unavailable' || rawStatus === 'not_requested'
      ? rawStatus
      : 'unavailable'
  const filesystem = typeof init?.filesystem === 'string' ? init.filesystem : null
  const filesystemType = typeof init?.filesystemType === 'string' ? init.filesystemType : null
  const reason = typeof init?.reason === 'string' ? init.reason : null
  const observedAt = typeof init?.observedAt === 'string' ? init.observedAt : null
  const selectedFilesystem = isAllowedQuotaFilesystem(wizard?.quotaFilesystem) ? wizard.quotaFilesystem : null
  const settings = obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings) ? obj.settings as Record<string, unknown> : null
  const defaultSuggested = obj.defaultSuggested && typeof obj.defaultSuggested === 'object' && !Array.isArray(obj.defaultSuggested) ? obj.defaultSuggested as Record<string, unknown> : null
  return { status, reason, filesystem, filesystemType, observedAt, selectedFilesystem, settings, defaultSuggested }
}

export function bindWhmQuotaSetup(root: HTMLElement, send?: RequestTransport, askDialog?: AskDialog): void {
  if (root.dataset.quotaSetupBound === 'true') return
  root.dataset.quotaSetupBound = 'true'
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const fsSelect = root.closest('[data-setup-stepper]')?.querySelector<HTMLSelectElement>('[data-quota-filesystem]')
    ?? root.querySelector<HTMLSelectElement>('[data-quota-filesystem]')
  const refreshBtn = root.querySelector<HTMLButtonElement>('[data-quota-refresh]')
  const initBtn = root.querySelector<HTMLButtonElement>('[data-quota-init]')
  const statusNode = root.querySelector<HTMLElement>('[data-quota-status]')
  const factNodes = new Map([...root.querySelectorAll<HTMLElement>('[data-quota-fact]')].map(node => [node.dataset.quotaFact!, node]))

  const stepper = root.closest('[data-setup-stepper]')
  const unlimitedChild = stepper?.querySelector<HTMLInputElement>('[data-setup-unlimited-child]') ?? null
  const maxChildrenInput = stepper?.querySelector<HTMLInputElement>('input[name="apache.maxConnectionsPerChild"]') ?? null
  const flowEngineNode = stepper?.querySelector<HTMLElement>('[data-setup-flow-engine]') ?? null
  const diffRowsNode = stepper?.querySelector<HTMLElement>('[data-setup-diff-rows]') ?? null

  const access = frameAccess(root, 'data-quota-can-read', 'data-quota-can-manage')
  const transport = send ?? access.request
  let busy = false
  let lastNonZeroChildLimit = '1000'
  let latestSetup: QuotaSetupObservation | null = null

  const readable = (): boolean => root.isConnected && root.dataset.quotaCanRead === 'true'
  const manageable = (): boolean => readable() && root.dataset.quotaCanManage === 'true'
    && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[data-tool-availability="unverified"],[data-workspace-mode="read-only"],[aria-disabled="true"],fieldset:disabled')

  const note = (state: string, message: string): void => {
    if (!statusNode) return
    statusNode.dataset.state = state
    statusNode.textContent = message
    statusNode.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
  }

  const paintFact = (key: string, value: string | null, technical = false): void => {
    const node = factNodes.get(key)
    if (!node) return
    if (technical && value !== null) {
      if (node.tagName === 'BDI') { node.dir = 'ltr'; node.textContent = value; return }
      const bdi = document.createElement('bdi')
      bdi.dir = 'ltr'
      bdi.textContent = value
      node.replaceChildren(bdi)
      return
    }
    node.textContent = value ?? t('Unavailable')
  }

  const statusLabel = (status: QuotaSetupObservation['status']): string => {
    if (status === 'enabled') return t('Enforced')
    if (status === 'disabled') return t('Not enforced')
    if (status === 'not_requested') return t('Not requested')
    return t('Unavailable')
  }

  const paintDifference = (obs: QuotaSetupObservation | null): void => {
    if (!diffRowsNode || !obs?.settings || !obs?.defaultSuggested) return
    const currentNginx = obs.settings.nginx as Record<string, unknown> | undefined
    const suggestedNginx = obs.defaultSuggested.nginx as Record<string, unknown> | undefined
    const currentApache = obs.settings.apache as Record<string, unknown> | undefined
    const suggestedApache = obs.defaultSuggested.apache as Record<string, unknown> | undefined
    if (!currentNginx || !suggestedNginx || !currentApache || !suggestedApache) return
    const pairs: [string, unknown, unknown][] = [
      ['nginx.workerConnections', currentNginx.workerConnections, suggestedNginx.workerConnections],
      ['nginx.workerRlimitNofile', currentNginx.workerRlimitNofile, suggestedNginx.workerRlimitNofile],
      ['apache.maxRequestWorkers', currentApache.maxRequestWorkers, suggestedApache.maxRequestWorkers],
      ['apache.serverLimit', currentApache.serverLimit, suggestedApache.serverLimit],
    ]
    diffRowsNode.replaceChildren(...pairs.map(([label, currentValue, proposedValue]) => {
      const tr = document.createElement('tr')
      const th = document.createElement('th')
      th.scope = 'row'
      const bdi = document.createElement('bdi')
      bdi.dir = 'ltr'
      bdi.textContent = label
      th.append(bdi)
      const tdCur = document.createElement('td')
      tdCur.textContent = currentValue === undefined ? '—' : String(currentValue)
      const tdProp = document.createElement('td')
      tdProp.textContent = proposedValue === undefined ? '—' : String(proposedValue)
      const tdState = document.createElement('td')
      tdState.textContent = String(currentValue) === String(proposedValue) ? t('Matches default') : t('Custom value')
      tr.append(th, tdCur, tdProp, tdState)
      return tr
    }))
  }

  const paintObservation = (obs: QuotaSetupObservation): void => {
    latestSetup = obs
    paintFact('filesystem', obs.filesystem, true)
    paintFact('filesystemType', obs.filesystemType, true)
    paintFact('quotaStatus', statusLabel(obs.status))
    paintFact('observedAt', obs.observedAt ? formatDisplayDateTime(obs.observedAt) : null, true)
    if (fsSelect && obs.selectedFilesystem && !fsSelect.value) fsSelect.value = obs.selectedFilesystem
    if (flowEngineNode && typeof obs.settings?.engine === 'string') flowEngineNode.textContent = obs.settings.engine
    paintDifference(obs)
    if (obs.status === 'enabled') note('read', t('User quotas are active and enforced on {filesystem}.', { filesystem: obs.filesystem ?? '/home' }))
    else if (obs.status === 'disabled') note('read', t('User quotas are not enforced on {filesystem}. Select the filesystem and initialize quotas.', { filesystem: obs.filesystem ?? '/home' }))
    else note('unavailable', obs.reason ? t('Quota mount observation unavailable: {reason}.', { reason: obs.reason }) : t('Quota mount observation is unavailable on this host.'))
  }

  const lock = (): void => {
    const canRead = readable() && !!transport
    const canEdit = manageable() && !!transport
    if (refreshBtn) refreshBtn.disabled = busy || !canRead
    if (fsSelect) fsSelect.disabled = busy || !canEdit
    if (initBtn) initBtn.disabled = busy || !canEdit
    root.setAttribute('aria-busy', String(busy))
  }

  const syncUnlimitedChild = (): void => {
    if (!unlimitedChild || !maxChildrenInput) return
    const current = maxChildrenInput.value.trim()
    if (current && current !== '0') lastNonZeroChildLimit = current
    unlimitedChild.checked = current === '0'
  }

  if (unlimitedChild && maxChildrenInput) {
    syncUnlimitedChild()
    unlimitedChild.addEventListener('change', () => {
      if (maxChildrenInput.disabled) return
      maxChildrenInput.value = unlimitedChild.checked ? '0' : lastNonZeroChildLimit
      maxChildrenInput.dispatchEvent(new Event('input', { bubbles: true }))
      maxChildrenInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    maxChildrenInput.addEventListener('input', syncUnlimitedChild)
  }

  stepper?.querySelectorAll<HTMLInputElement>('input[name="engine"]').forEach(radio => {
    radio.addEventListener('change', () => {
      if (radio.checked && flowEngineNode) flowEngineNode.textContent = radio.value
    })
  })

  async function inspect(): Promise<void> {
    if (busy || !readable() || !transport) return
    busy = true
    lock()
    note('reading', t('Inspecting quota mount status…'))
    try {
      const obs = readQuotaSetupStatus(await transport('GET', '/api/setup/wizard'))
      if (readable()) paintObservation(obs)
    } catch {
      if (readable()) {
        for (const key of ['filesystem', 'filesystemType', 'quotaStatus', 'observedAt']) paintFact(key, null)
        note('failed', t('Quota mount status could not be read from the server.'))
      }
    } finally {
      busy = false
      lock()
    }
  }

  initBtn?.addEventListener('click', () => {
    void (async () => {
      if (busy || !manageable() || !transport) return
      const filesystem = fsSelect?.value.trim() || '/home'
      if (!isAllowedQuotaFilesystem(filesystem)) {
        note('failed', t('Select /home or /home0 through /home99.'))
        return
      }
      const confirmed = await askDialog?.({
        title: t('Initialize user disk quotas on {filesystem}?', { filesystem }),
        body: t('Backs up /etc/fstab, enables journaled user quota mount options, runs quotacheck, and turns on quota enforcement.'),
        confirm: t('Initialize quotas'),
        danger: true,
      }).catch(() => false) === true
      if (!confirmed) return
      busy = true
      lock()
      note('reading', t('Initializing user quotas on {filesystem}…', { filesystem }))
      try {
        const reply = await transport('POST', '/api/server/quotas/init', { filesystem }) as Record<string, unknown>
        const changed = reply?.changed === true
        const backup = typeof reply?.fstabBackup === 'string' ? reply.fstabBackup : null
        busy = false
        await inspect()
        note('read', changed
          ? (backup ? t('Quotas initialized on {filesystem}. Backup saved at {backup}.', { filesystem, backup }) : t('Quotas initialized on {filesystem}.', { filesystem }))
          : t('Quotas are already active and enforced on {filesystem}.', { filesystem }))
      } catch (error) {
        const err = error && typeof error === 'object' ? error as Record<string, unknown> : {}
        const details = err.details && typeof err.details === 'object' ? err.details as Record<string, unknown> : {}
        const state = details.stateChanged === false ? 'failed' : 'uncertain'
        note(state, typeof err.message === 'string' && err.message ? err.message : t('Quota initialization failed. Inspect the mount status before retrying.'))
        busy = false
        lock()
      }
    })()
  })

  refreshBtn?.addEventListener('click', () => { void inspect() })
  lock()
  if (!readable() || !transport) {
    note('unavailable', t('Quota setup is unavailable here. Nothing was read or changed.'))
    return
  }
  if (!latestSetup) void inspect()
}

function bindWhmQuotaSetupPage(askDialog?: AskDialog): void {
  document.querySelectorAll<HTMLElement>('[data-quota-setup]').forEach(root => {
    bindWhmQuotaSetup(root, frameAccess(root, 'data-quota-can-read', 'data-quota-can-manage').request, askDialog)
  })
}

export const WHM_QUOTA_SETUP_CLIENT_BINDING = withFrameRequest(`(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const QUOTA_FILESYSTEM_OPTIONS=${JSON.stringify(QUOTA_FILESYSTEM_OPTIONS)};const isAllowedQuotaFilesystem=${isAllowedQuotaFilesystem.toString()};const readQuotaSetupStatus=${readQuotaSetupStatus.toString()};const bindWhmQuotaSetup=${bindWhmQuotaSetup.toString()};return ${bindWhmQuotaSetupPage.toString()};})()`)
