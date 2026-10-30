/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
import { readSwAddonServicesView } from '../../../packages/os/src/sw-addon-command.ts'
import type { SwAddonServicesView } from '../../../packages/os/src/sw-addon-command.ts'
export { readSwAddonServicesView }

type Ask = (options: Record<string, unknown>) => Promise<unknown>
/** Package state comes from the existing software center catalog read; only the two fields used here are accepted. */
export function readAddonPackageStates(value: unknown): Record<string, 'installed' | 'partial' | 'absent' | 'unavailable'> {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || value.page !== 'catalog' || !['read', 'unavailable'].includes(value.state) || !Array.isArray(value.components) || value.components.length > 512) throw new Error('invalid_catalog')
  const states: Record<string, 'installed' | 'partial' | 'absent' | 'unavailable'> = {}
  for (const item of value.components) {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{1,48}$/.test(item.id) || !['installed', 'partial', 'absent', 'unavailable'].includes(item.state)) throw new Error('invalid_catalog')
    if (value.state === 'read') states[item.id] = item.state
  }
  return states
}

function bindSwAddons(askDialog: Ask | undefined, parse: typeof readSwAddonServicesView, parsePackages: typeof readAddonPackageStates): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const blocked = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  document.querySelectorAll<HTMLElement>('[data-sw-addons]').forEach(root => {
    if (root.dataset.swBound === 'true') return
    root.dataset.swBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-sw-addons-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-sw-addons-refresh]'), body = root.querySelector<HTMLElement>('[data-sw-addons-rows]')
    const job = root.querySelector<HTMLElement>('[data-sw-addons-job]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-sw-addons-job-link]')
    if (!status || !refresh || !body || !job || !jobLink) return
    const admitted = (): boolean => root.isConnected && root.dataset.swCanRead === 'true' && !root.closest(blocked) && typeof transport === 'function'
    let busy = false, review = false, view: SwAddonServicesView | null = null, packages: Record<string, string> | null = null
    const manageable = (): boolean => admitted() && root.dataset.swCanManage === 'true' && view?.state === 'read' && view.actions.control && typeof askDialog === 'function' && !review
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status') }
    const name = (id: string): string => ({ memcached: 'Memcached', rabbitmq: 'RabbitMQ', elasticsearch: 'Elasticsearch', opensearch: 'OpenSearch' } as Record<string, string>)[id] ?? id
    const kind = (id: string): string => id === 'memcached' ? t('Memory cache') : id === 'rabbitmq' ? t('Message broker') : t('Search engine')
    const lock = (): void => { refresh.disabled = busy || !admitted(); for (const button of body.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || !manageable() || button.dataset.swAllowed !== 'true' }
    const paint = (): void => {
      body.textContent = ''
      for (const service of view?.services ?? []) {
        const installed = service.state === 'read' && service.load === 'loaded'
        const pkg = service.componentId === null ? t('No reviewed package') : packages === null ? t('Not read') : packages[service.componentId] === 'installed' ? t('Installed') : packages[service.componentId] === 'partial' ? t('Partially installed') : packages[service.componentId] === 'absent' ? t('Not installed') : t('Unavailable on this system')
        const row = cloneViewRecord(root, 'software-addon-row', 'tr', { service: name(service.id), kind: kind(service.id), package: pkg, unit: service.unit,
          state: service.state !== 'read' ? t('Could not be read') : service.load === 'not-found' ? t('Not installed') : service.active === 'active' ? t('Running') : service.active === 'failed' ? t('Failed') : service.active === 'inactive' ? t('Stopped') : (service.active ?? ''),
          boot: service.boot === null ? t('Not read') : service.boot === 'enabled' ? t('Yes') : service.boot === 'disabled' ? t('No') : service.boot, 'start-label': t('Start'), 'stop-label': t('Stop'), 'restart-label': t('Restart') })
        for (const action of ['start', 'stop', 'restart'] as const) {
          const button = viewAction(row, action); button.dataset.swAction = action
          button.setAttribute('aria-label', action === 'start' ? t('Start {service}', { service: name(service.id) }) : action === 'stop' ? t('Stop {service}', { service: name(service.id) }) : t('Restart {service}', { service: name(service.id) }))
          button.dataset.swAllowed = String(installed && service.boot !== 'masked' && (action === 'start' ? service.active !== 'active' : service.active === 'active'))
          button.addEventListener('click', () => { void change(service, action) })
        }
        body.append(row)
      }
      if (!body.childElementCount) body.append(cloneViewRecord(root, 'software-addon-empty', 'tr', { message: view ? t('Add-on services cannot be read on this host. Nothing was read or changed.') : t('No services have been read.') }))
      lock()
    }
    const failure = (error: unknown, change: boolean): void => {
      const detail = error && typeof error === 'object' ? (error as Record<string, any>).details ?? (error as Record<string, any>).detail : null
      const code = error && typeof error === 'object' ? Number((error as Record<string, any>).status) : NaN
      if (change && !(detail && detail.stateChanged === false)) { review = true; note('uncertain', t('The submission outcome is unknown. Check the jobs page before trying again; actions stay locked until you read services again.')); return }
      note('failed', code === 409 ? t('The service changed since it was read. Read services again before changing it.') : code === 412 ? t('The change is unavailable on this host right now. Nothing was changed.') : t('The request failed. Nothing was changed.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock(); note('reading', t('Reading add-on services…'))
      const [services, catalog] = await Promise.allSettled([transport!('GET', '/api/server/software/addon-services').then(parse), transport!('GET', '/api/server/software-center?page=catalog').then(parsePackages)])
      if (admitted()) {
        view = services.status === 'fulfilled' ? services.value : null; review = false
        packages = catalog.status === 'fulfilled' ? catalog.value : null
        if (!view) failure(services.status === 'rejected' ? services.reason : null, false)
        else note(view.state === 'read' ? 'read' : 'unavailable', view.state !== 'read' ? t('Add-on services cannot be read on this host. Nothing was read or changed.')
          : t('Service units read from systemd. Changes run as host jobs that re-read the unit before they succeed.') + (view.actions.control ? '' : ' ' + t('Changes are unavailable: the host job runner is not connected.')) + (packages === null ? ' ' + t('Package states could not be read from the software center.') : ''))
      }
      busy = false; paint()
    }
    const change = async (service: SwAddonServicesView['services'][number], action: 'start' | 'stop' | 'restart'): Promise<void> => {
      if (busy || !manageable() || !service.revision) return
      busy = true; lock()
      const label = name(service.id)
      let approved = false
      try { approved = await askDialog!({ title: action === 'start' ? t('Start {service}?', { service: label }) : action === 'stop' ? t('Stop {service}?', { service: label }) : t('Restart {service}?', { service: label }), body: action === 'start' ? t('systemd starts {unit}. The job succeeds only when the unit is running.', { unit: service.unit }) : action === 'stop' ? t('systemd stops {unit}. Applications that use it lose their connection.', { unit: service.unit }) : t('systemd restarts {unit}. Applications that use it briefly lose their connection.', { unit: service.unit }), danger: action !== 'start', confirm: t('Submit host job') }) === true } catch { approved = false }
      if (!approved || !manageable()) { busy = false; lock(); return }
      note('reading', t('Submitting the host job…'))
      try {
        const result = await transport!('POST', '/api/server/software/addon-services/action', { serviceId: service.id, action, expectedRevision: service.revision }) as { job?: { id?: unknown; kind?: unknown } }
        if (!result || typeof result.job?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'software.addon.' + action) throw { details: {} }
        review = true; jobLink.href = '/whm/jobs?job=' + encodeURIComponent(result.job.id); job.hidden = false
        note('submitted', t('Host job submitted. Service states are unchanged here until you read them again after the job finishes.'))
      } catch (error) { failure(error, true) }
      finally { busy = false; lock() }
    }
    if (!admitted()) { refresh.disabled = true; note('unavailable', t('Add-on services are unavailable here. Nothing was read or changed.')); return }
    refresh.addEventListener('click', () => { void load() })
    void load()
  })
}
export const SW_ADDON_SERVICES_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const parse=${readSwAddonServicesView.toString()};const parsePackages=${readAddonPackageStates.toString()};const bind=${bindSwAddons.toString()};return (ask)=>bind(ask,parse,parsePackages);})()`
