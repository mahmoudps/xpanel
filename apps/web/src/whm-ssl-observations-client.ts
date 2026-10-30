import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import type { SslWorkspaceView } from './whm-ssl-client.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
const displayDateTime = formatDisplayDateTime

export function readSslObservationView(value: unknown, workspace: SslWorkspaceView) {
  const object = (part: unknown): part is Record<string, unknown> => !!part && typeof part === 'object' && !Array.isArray(part)
  const date = (part: unknown, optional = false): string | null => { if (optional && part === null) return null; if (typeof part !== 'string' || !Number.isFinite(Date.parse(part))) throw new Error('invalid_observed_certificate_date'); return new Date(part).toISOString() }
  if (!object(value) || value.scope !== 'authorized_saved_certificate_ids' || value.inventoryComplete !== false || !Array.isArray(value.accounts) || value.accounts.length > 50) throw new Error('invalid_certificate_observation_scope')
  const orders: { certificateId: string; names: string[]; phase: string; challenge: string; attempts: number; nextRetryAt: string | null; updatedAt: string; failureRecorded: boolean }[] = []
  let missing = 0, invalid = 0, unavailable = 0, unavailableAccounts = 0, inspected = 0
  const accounts = new Set<string>(), identities = new Set<string>()
  for (const entry of value.accounts) {
    if (!object(entry) || typeof entry.accountId !== 'string' || accounts.has(entry.accountId) || !workspace.accounts.some(account => account.id === entry.accountId && account.username === entry.username)) throw new Error('foreign_certificate_observation_account')
    accounts.add(entry.accountId)
    if (entry.state === 'unavailable') { unavailableAccounts++; continue }
    const observation = entry.observation
    if (entry.state !== 'observed' || !object(observation) || observation.scope !== value.scope || observation.inventoryComplete !== false || !Array.isArray(observation.rows)) throw new Error('invalid_certificate_order_observation')
    for (const row of observation.rows) {
      if (++inspected > 50 || !object(row) || typeof row.certificateId !== 'string' || identities.has(row.certificateId)) throw new Error('invalid_certificate_observation_identity')
      const certificate = workspace.certificates.find(certificate => certificate.id === row.certificateId && certificate.accountId === entry.accountId && certificate.source === 'acme')
      if (!certificate) throw new Error('foreign_certificate_order')
      identities.add(certificate.id)
      if (row.state === 'missing') { missing++; continue }
      if (row.state === 'invalid') { invalid++; continue }
      if (row.state === 'unavailable') { unavailable++; continue }
      const order = row.order
      if (row.state !== 'observed' || !object(order) || order.certificateId !== certificate.id || !Array.isArray(order.names) || order.names.length > 100
        || JSON.stringify([...order.names].sort()) !== JSON.stringify([...certificate.names].sort()) || order.challenge !== certificate.challenge
        || !['planned', 'challenged', 'issued', 'installed', 'failed'].includes(String(order.phase)) || !Number.isSafeInteger(order.attempts) || Number(order.attempts) < 0 || Number(order.attempts) > 1_000_000
        || typeof order.failureRecorded !== 'boolean' || order.servedTlsVerified !== false) throw new Error('invalid_certificate_order_checkpoint')
      orders.push({ certificateId: certificate.id, names: [...certificate.names], phase: String(order.phase), challenge: String(order.challenge), attempts: Number(order.attempts), nextRetryAt: date(order.nextRetryAt, true), updatedAt: date(order.updatedAt)!, failureRecorded: order.failureRecorded })
    }
  }
  const management = value.managementTls
  if (!object(management) || !['observed', 'missing', 'invalid', 'unavailable', 'restricted'].includes(String(management.state))) throw new Error('invalid_management_tls_observation')
  let status: { recordedAt: string; status: string; expiresAt: string | null } | null = null
  if (management.state === 'observed') {
    const saved = management.status
    if (!object(saved) || saved.historical !== true || saved.servedTlsVerified !== false || saved.renewalQualified !== false || !['tls-ready', 'ingress-observed-ready', 'failed'].includes(String(saved.status))) throw new Error('invalid_management_tls_status')
    status = { recordedAt: date(saved.recordedAt)!, status: String(saved.status), expiresAt: date(saved.expiresAt, true) }
  }
  let timer: { active: boolean; enabled: boolean } | null = null
  if (object(management.timer) && management.timer.state === 'observed') {
    const observed = management.timer.observation
    if (!object(observed) || typeof observed.active !== 'boolean' || typeof observed.enabled !== 'boolean' || observed.renewalQualified !== false) throw new Error('invalid_management_tls_timer')
    timer = { active: observed.active, enabled: observed.enabled }
  }
  return { orders, missing, invalid, unavailable, unavailableAccounts, inspected, inventoryComplete: false as const, management: { state: String(management.state), status, timer } }
}

function bindWhmSslObservations(readWorkspace: (value: unknown) => SslWorkspaceView): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-ssl]').forEach(root => {
    const route = root.closest<HTMLElement>('[data-whm-detail-route="/whm/ssl"]'), button = route?.querySelector<HTMLButtonElement>('[data-ssl-observations-refresh]')
    if (!route || !button || button.dataset.sslBound === 'true') return
    const queueSlots=['names','next','reason','attempts','state','actions'] as const,logSlots=['when','names','challenge','result','message'] as const
    const templates={queue:clientTemplate(route,'ssl-observation-queue-row'),log:clientTemplate(route,'ssl-observation-log-row'),queueEmpty:clientTemplate(route,'ssl-observation-queue-empty'),logEmpty:clientTemplate(route,'ssl-observation-log-empty'),action:clientTemplate(route,'ssl-observation-action')}
    cloneClientTemplate(templates.queue,'tr',queueSlots);cloneClientTemplate(templates.log,'tr',logSlots);cloneClientTemplate(templates.queueEmpty,'tr',['message']);cloneClientTemplate(templates.logEmpty,'tr',['message']);cloneClientTemplate(templates.action,'button',['label'])
    button.dataset.sslBound = 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    const admitted = (): boolean => root.isConnected && root.dataset.sslCanManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[aria-disabled="true"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],fieldset:disabled')
    button.disabled = !transport || !admitted()
    const instant = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = displayDateTime(value); return node }
    const message = (selector: string, text: string | (string | Node)[]): void => { const target = route.querySelector<HTMLElement>(selector); if (target) { if (typeof text === 'string') target.textContent = text; else target.replaceChildren(...text) } }
    const row=(target:Element|null,values:string[]):HTMLElement|null=>{
      if(!target)return null
      const queue=target.hasAttribute('data-ssl-queue-rows'),slots=queue?queueSlots.slice(0,-1):logSlots,item=cloneClientTemplate(queue?templates.queue:templates.log,'tr',queue?queueSlots:logSlots)
      slots.forEach((slot,index)=>{clientTemplateSlot(item,slot).textContent=values[index]!});target.append(item);return item
    }
    const empty=(target:Element|null,queue:boolean,message:string):void=>{if(!target||target.children.length)return;const item=cloneClientTemplate(queue?templates.queueEmpty:templates.logEmpty,'tr',['message']);clientTemplateSlot(item,'message','td').textContent=message;target.append(item)}
    const phase = (value: string): string => (({ planned: t('Planned checkpoint'), challenged: t('Challenge checkpoint'), issued: t('Issued; installation unverified'), installed: t('Installed checkpoint'), failed: t('Provider recorded failure') } as Record<string, string>)[value] ?? t('Not read'))
    let busy = false
    button.addEventListener('click', () => { void (async () => {
      if (busy || !transport || !admitted()) return
      busy = true; button.disabled = true
      message('[data-ssl-queue-status]', t('Reading saved order checkpoints…'))
      try {
        const before = readWorkspace(await transport('GET', '/api/certificate-workspace'))
        const value = await transport('GET', '/api/certificate-workspace/observations')
        const after = readWorkspace(await transport('GET', '/api/certificate-workspace'))
        if (!admitted() || before.revision !== after.revision) throw new Error('certificate_observation_scope_changed')
        const observed = readSslObservationView(value, after), queue = route.querySelector('[data-ssl-queue-rows]'), log = route.querySelector('[data-ssl-order-log-rows]')
        queue?.replaceChildren(); log?.replaceChildren()
        for (const order of observed.orders) {
          if (order.phase !== 'installed') {
            const entry = row(queue, [order.names.join(', '), order.nextRetryAt === null ? t('Not recorded') : displayDateTime(order.nextRetryAt), order.failureRecorded ? t('Failure recorded') : t('Saved checkpoint'), String(order.attempts), phase(order.phase)])
            if (entry) {
              const review=cloneClientTemplate(templates.action,'button',['label']) as HTMLButtonElement;clientTemplateSlot(review,'label').textContent=t('Review renewal')
              const certificate = after.certificates.find(certificate => certificate.id === order.certificateId)!
              review.disabled = certificate.challenge !== 'http-01' || !certificate.username || !certificate.assignedDomains.length || !after.capabilities.renew
              review.addEventListener('click', () => {
                if (review.disabled || !admitted()) return
                const account = root.querySelector<HTMLSelectElement>('[data-ssl-account]'), domain = root.querySelector<HTMLSelectElement>('[data-ssl-domain]'), renewal = root.querySelector<HTMLSelectElement>('[data-ssl-renewal]')
                if (!account || !domain || !renewal) return
                account.value = certificate.username!; account.dispatchEvent(new Event('change', { bubbles: true }))
                domain.value = certificate.assignedDomains[0]!; domain.dispatchEvent(new Event('change', { bubbles: true })); renewal.value = certificate.id; renewal.dispatchEvent(new Event('change', { bubbles: true }))
                root.querySelector<HTMLButtonElement>('[data-ssl-issue]')?.focus()
              })
              clientTemplateSlot(entry,'actions','td').append(review)
            }
          }
          row(log, [displayDateTime(order.updatedAt), order.names.join(', '), order.challenge, phase(order.phase), t('Latest saved order checkpoint; full history has not been read.')])
        }
        empty(queue,true,t('No pending checkpoint was read in this limited scope.'))
        empty(log,false,t('No saved order checkpoint was read in this limited scope.'))
        message('[data-ssl-queue-status]', t('Partial inventory of saved certificate assignments. Site scheduling is not connected. Missing records: {missing}; invalid or unavailable records: {invalid}; unavailable account sources: {accounts}', { missing: observed.missing, invalid: observed.invalid + observed.unavailable, accounts: observed.unavailableAccounts }))
        message('[data-ssl-order-log-status]', t('Latest saved order checkpoints only; this is not a complete renewal history.'))
        const saved = observed.management.status, timer = observed.management.timer
        // The message keeps {recorded}/{expires} literal; each is replaced by its instant node.
        const placed = (text: string, nodes: Record<string, Node>): (string | Node)[] => text.split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) && nodes[part.slice(1, -1)] || part)
        const lifecycle: (string | Node)[] = observed.management.state === 'restricted' ? [t('Management TLS observations require root access.')] : saved ? placed(saved.status === 'failed'
          ? saved.expiresAt ? t('Historical management lifecycle record: failure recorded, {recorded}; saved expiry: {expires}') : t('Historical management lifecycle record: failure recorded, {recorded}')
          : saved.expiresAt ? t('Historical management lifecycle record: TLS readiness reported, {recorded}; saved expiry: {expires}') : t('Historical management lifecycle record: TLS readiness reported, {recorded}'),
        { recorded: instant(saved.recordedAt), ...(saved.expiresAt ? { expires: instant(saved.expiresAt) } : {}) }) : [t('Management lifecycle status is missing, unreadable or unavailable.')]
        message('[data-ssl-management-status]', [...lifecycle, ' ' + (timer ? t('Timer active: {active}; enabled: {enabled}', { active: timer.active ? t('Yes') : t('No'), enabled: timer.enabled ? t('Yes') : t('No') }) : t('Timer state has not been observed.')) + ' ' + t('Current served TLS and successful automatic renewal remain unverified.')])
      } catch {
        route.querySelector('[data-ssl-queue-rows]')?.replaceChildren(); route.querySelector('[data-ssl-order-log-rows]')?.replaceChildren()
        for (const selector of ['[data-ssl-queue-status]', '[data-ssl-order-log-status]', '[data-ssl-management-status]']) message(selector, t('Observation failed or authorization changed. No operation was submitted.'))
      } finally { busy = false; button.disabled = !transport || !admitted() }
    })() })
  })
}

export const WHM_SSL_OBSERVATIONS_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};const readSslObservationView=${readSslObservationView.toString()};return ${bindWhmSslObservations.toString()};})()`
