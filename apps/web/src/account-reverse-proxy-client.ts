/// <reference lib="dom" />
import { domainCanonicalName, domainObject, domainPhpSettings, domainRoot, domainSafeText, domainStable, domainWriteUncertain, readDomainWorkspace } from './domain-workspace-client.ts'
import type { DomainWorkspaceRow, DomainWorkspaceView } from './domain-workspace-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const RP_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Module-local aliases keep the stringified functions free of bundler import rewrites.
const rpObject = domainObject, rpStable = domainStable, rpUncertain = domainWriteUncertain, rpReadWorkspace = readDomainWorkspace
const RP_UPSTREAM = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]):([0-9]{1,5})(\/[A-Za-z0-9._~%/-]*)?$/
export type ReverseProxyBlock = 'alias' | 'aliases' | 'app' | 'redirect' | null
/** Format hint only; the server applies the authoritative loopback and reserved-port rules. */
export function reverseProxyUpstreamDraft(value: unknown): string | null {
  const match = typeof value === 'string' ? RP_UPSTREAM.exec(value) : null
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535 || (match[2] ?? '').split('/').some(part => part === '.' || part === '..')) return null
  return value as string
}
export function reverseProxyBlocked(row: DomainWorkspaceRow, rows: readonly DomainWorkspaceRow[]): ReverseProxyBlock {
  if (row.kind === 'alias') return 'alias'
  if (!['php', 'static', 'proxy'].includes(row.siteType)) return 'app'
  if (row.redirect) return 'redirect'
  return rows.some(other => other.kind === 'alias' && other.parentId === row.id) ? 'aliases' : null
}
/** The acknowledgement must change exactly this row's site type and upstream and report its application truthfully. */
export function reverseProxyAcknowledged(raw: unknown, accepted: DomainWorkspaceView, before: DomainWorkspaceView, id: string, siteType: string, upstream: string | null): number | null | false {
  if (!rpObject(raw) || raw.stateChanged !== true || !rpObject(raw.domain)) return false
  const row = accepted.domains.find(entry => entry.id === id), previous = before.domains.find(entry => entry.id === id)
  if (!row || !previous || rpStable(row) !== rpStable(raw.domain) || row.siteType !== siteType || row.upstream !== upstream
    || rpStable({ ...row, siteType: previous.siteType, upstream: previous.upstream }) !== rpStable(previous)
    || accepted.domains.length !== before.domains.length || !before.domains.every(old => old.id === id || accepted.domains.some(entry => rpStable(entry) === rpStable(old)))) return false
  if (accepted.application.status === 'not_requested') return raw.reconcile === null ? null : false
  const reconcile = raw.reconcile, generation = rpObject(reconcile) ? reconcile.generation : null
  return accepted.application.status === 'global_configuration_applied' && rpObject(reconcile) && reconcile.status === 'applied' && rpObject(generation)
    && typeof generation.id === 'number' && Number.isSafeInteger(generation.id) && generation.id >= 1 ? generation.id : false
}

function bindAccountReverseProxy(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-reverse-proxy]').forEach(root => {
    if (root.dataset.rpBound === 'true') return
    root.dataset.rpBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const accountId = root.dataset.rpAccount ?? '', home = root.dataset.rpHome ?? ''
    const eligible = (): boolean => root.isConnected && root.dataset.rpManage === 'true' && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-rp-' + key + ']')!
    const status = find('status'), rows = find('rows'), application = find('application'), refreshButton = find<HTMLButtonElement>('refresh'), mode = find<HTMLSelectElement>('mode'), upstream = find<HTMLInputElement>('upstream')
    const upstreamField = find('upstream-field'), error = find('error'), save = find<HTMLButtonElement>('save'), cancel = find<HTMLButtonElement>('cancel'), selectedName = find('selected'), current = find('current'), docRoot = find('root')
    if (!status || !rows || !application || !refreshButton || !mode || !upstream || !upstreamField || !error || !save || !cancel || !selectedName || !current || !docRoot) return
    let view: DomainWorkspaceView | null = null, selected: string | null = null, busy = false, confirming = false, review = false
    const MODES: Record<string, string> = { php: t('PHP files'), static: t('Static files'), proxy: t(msgctxt('account-reverse-proxy-client', 'Reverse proxy')), node: t('Node application'), python: t('Python application') }
    const KINDS: Record<string, string> = { primary: t('Primary'), addon: t('Addon'), subdomain: t(msgctxt('account-reverse-proxy-client', 'Subdomain')), alias: t('Alias') }
    const BLOCKS: Record<string, string> = { alias: t('Follows the domain it points at'), aliases: t('Has aliases; unavailable here'), app: t('Application site; unavailable here'), redirect: t('Redirects; unavailable here') }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain', 'fields'].includes(state) ? 'alert' : 'status') }
    const row = (): DomainWorkspaceRow | undefined => view?.domains.find(entry => entry.id === selected)
    const fieldError = (message: string): void => { error.textContent = message; error.hidden = !message; upstream.setAttribute('aria-invalid', String(!!message)) }
    const lock = (): void => {
      const target = row(), blocked = !eligible() || !view || busy || confirming || review || !target || reverseProxyBlocked(target, view.domains) !== null
      mode.disabled = blocked; upstream.disabled = blocked || mode.value !== 'proxy'; upstreamField.hidden = mode.value !== 'proxy'
      save.disabled = blocked; cancel.disabled = !eligible() || busy || confirming || !target
      refreshButton.disabled = !eligible() || busy || confirming
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !eligible() || busy || confirming || review || button.dataset.rpBlocked === 'true' })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !send || !eligible() ? Promise.reject({ details: { stateChanged: false } }) : body === undefined ? send(method, path) : send(method, path, body)
    const read = async (): Promise<DomainWorkspaceView> => rpReadWorkspace(await request('GET', '/api/domains'), { accountId, home })
    const cell = (tr: HTMLTableRowElement, text: string, technical: boolean): HTMLTableCellElement => { const td = document.createElement('td'), content = document.createElement(technical ? 'bdi' : 'span'); content.dir = technical ? 'ltr' : 'auto'; content.textContent = text; td.append(content); tr.append(td); return td }
    const fill = (): void => {
      const target = row()
      selectedName.textContent = target ? target.name : t('None selected')
      current.textContent = target ? MODES[target.siteType] + (target.upstream ? ' · ' + target.upstream : '') : t(msgctxt('account-reverse-proxy-client', 'Not read'))
      docRoot.textContent = target ? target.docRoot : t(msgctxt('account-reverse-proxy-client', 'Not read'))
      mode.value = target && ['php', 'static', 'proxy'].includes(target.siteType) ? target.siteType : 'proxy'
      upstream.value = target?.upstream ?? ''; fieldError('')
    }
    const paint = (next: DomainWorkspaceView): void => {
      view = next; review = false; rows.textContent = ''
      if (selected && !next.domains.some(entry => entry.id === selected)) selected = null
      for (const domain of next.domains) {
        const tr = document.createElement('tr'), block = reverseProxyBlocked(domain, next.domains)
        cell(tr, domain.name, true); cell(tr, KINDS[domain.kind] ?? domain.kind, false); cell(tr, MODES[domain.siteType] ?? domain.siteType, false); cell(tr, domain.upstream ?? '-', domain.upstream !== null)
        const td = document.createElement('td'), button = document.createElement('button')
        button.type = 'button'; button.className = 'xp-btn'; button.textContent = t('Configure'); button.setAttribute('aria-label', t('Configure: {domain}', { domain: domain.name }))
        button.dataset.rpBlocked = String(block !== null)
        button.addEventListener('click', () => { if (button.disabled) return; selected = domain.id; fill(); lock(); mode.focus() })
        td.append(button)
        if (block) { const reason = document.createElement('p'); reason.className = 'xp-help'; reason.textContent = BLOCKS[block]!; td.append(reason) }
        tr.append(td); rows.append(tr)
      }
      if (!next.domains.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = t('This account has no domains.'); tr.append(td); rows.append(tr) }
      fill()
    }
    const fieldMessage = (code: string): string => ({
      invalid: t('Enter an address like http://127.0.0.1:3000, with an optional path and no user name, query or spaces.'),
      not_loopback: t('Only 127.0.0.1 and [::1] are available in this version.'),
      reserved_port: t('This port is below 1024 or used by a server service. Choose another port for your application.'),
      unchanged: t('This domain already uses this mode. There is nothing to save.'),
    } as Record<string, string>)[code] ?? t('The address was refused. Nothing was changed.')
    const applied = (generation: number | null): void => {
      application.textContent = generation === null
        ? t('The server configuration was not applied by this request; the site keeps its previous serving until it is applied.')
        : t('The server configuration was applied as generation {generation}. Whether the site answers through its upstream has not been checked.', { generation })
    }
    const failed = (dispatched: boolean, cause: unknown): void => {
      const value = rpObject(cause) ? cause : {}, details = rpObject(value.details) ? value.details : {}, first = Array.isArray(details.fields) ? details.fields[0] : null
      const code = rpObject(first) && typeof first.code === 'string' && /^[a-z_]{1,32}$/.test(first.code) ? first.code : null
      if (code && details.stateChanged === false) { note('fields', fieldMessage(code)); if (code !== 'unchanged') fieldError(fieldMessage(code)); return }
      if (value.status === 409) { review = true; note('stale', t('The domain configuration changed elsewhere. Nothing was saved. Read domains before trying again.')); return }
      if (dispatched && rpUncertain(cause)) { review = true; note('uncertain', t('The outcome requires review: the change may be saved while the server configuration is not applied. No retry was sent. Read domains before continuing.')); return }
      const reason = details.reason
      note('failed', reason === 'has_aliases' ? BLOCKS.aliases! : reason === 'domain_redirect' ? BLOCKS.redirect! : t(msgctxt('account-reverse-proxy-client', 'The request was refused. Nothing was changed.')))
    }
    async function refresh(): Promise<void> {
      if (!eligible() || busy || confirming) return
      busy = true; lock(); note('reading', t('Reading saved domain configuration…'))
      try { paint(await read()); note('read', t('Saved domain configuration read.')) }
      catch { note('failed', t('Domains could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function submit(): Promise<void> {
      const before = view, target = row()
      if (!before || !target || !eligible() || busy || confirming || review || reverseProxyBlocked(target, before.domains)) return
      const siteType = mode.value, address = siteType === 'proxy' ? upstream.value.trim() : null
      if (!['proxy', 'php', 'static'].includes(siteType)) return
      if (siteType === 'proxy' && !reverseProxyUpstreamDraft(address)) { fieldError(fieldMessage('invalid')); note('fields', fieldMessage('invalid')); return }
      if (siteType === target.siteType && address === target.upstream) { note('fields', fieldMessage('unchanged')); return }
      fieldError('')
      if (!askDialog) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      confirming = true; lock()
      let approved = false
      try { approved = await askDialog({ title: t('Change how this domain is served?'), danger: false, confirm: t('Save'),
        body: target.name + '\n' + MODES[siteType] + (address ? ': ' + address : '') + '\n' + (siteType === 'proxy' ? t('Its document root and PHP settings are kept but not used while proxied.') : t('Files are served from the saved document root again.')) }) === true }
      catch { approved = false } finally { confirming = false; lock() }
      if (!approved || view !== before || !eligible()) return
      busy = true; lock(); note('saving', t('Checking the saved configuration, then saving…'))
      let dispatched = false
      try {
        const fresh = await read()
        if (fresh.revision !== before.revision) { review = true; note('stale', t('The domain configuration changed elsewhere. Nothing was sent. Read domains before trying again.')); return }
        dispatched = true
        const raw = await request('PUT', '/api/domains/' + encodeURIComponent(target.id) + '/reverse-proxy', { expectedRevision: before.revision, siteType, ...(siteType === 'proxy' ? { upstream: address } : {}) })
        const accepted = rpReadWorkspace(raw, { accountId, home }), generation = reverseProxyAcknowledged(raw, accepted, before, target.id, siteType, address)
        if (generation === false) throw new Error('wrong_reverse_proxy_ack')
        const observed = await read()
        if (observed.revision !== accepted.revision || rpStable(observed.domains) !== rpStable(accepted.domains)) throw new Error('reverse_proxy_readback_mismatch')
        paint(observed); applied(generation)
        note('saved', t('Saved and read back from the domain configuration.'))
      } catch (cause) { failed(dispatched, cause) }
      finally { busy = false; lock() }
    }
    if (!send || !eligible() || !RP_ACCOUNT_ID.test(accountId) || !home.startsWith('/')) {
      for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) control.disabled = true
      note('unavailable', t('Reverse proxy changes are unavailable here. Nothing was read or changed.')); return
    }
    mode.addEventListener('change', () => { fieldError(''); lock(); if (mode.value === 'proxy') upstream.focus() })
    refreshButton.addEventListener('click', () => { void refresh() })
    cancel.addEventListener('click', () => { if (!cancel.disabled) { selected = null; fill(); lock() } })
    save.addEventListener('click', () => { if (!save.disabled) void submit() })
    lock(); void refresh()
  })
}

export const ACCOUNT_REVERSE_PROXY_CLIENT_BINDING = `(()=>{const domainObject=${domainObject.toString()};const domainSafeText=${domainSafeText.toString()};const domainCanonicalName=${domainCanonicalName.toString()};const domainRoot=${domainRoot.toString()};const domainStable=${domainStable.toString()};const domainWriteUncertain=${domainWriteUncertain.toString()};const domainPhpSettings=${domainPhpSettings.toString()};const readDomainWorkspace=${readDomainWorkspace.toString()};const rpObject=domainObject;const rpStable=domainStable;const rpUncertain=domainWriteUncertain;const rpReadWorkspace=readDomainWorkspace;const RP_ACCOUNT_ID=${RP_ACCOUNT_ID.toString()};const RP_UPSTREAM=${RP_UPSTREAM.toString()};const reverseProxyUpstreamDraft=${reverseProxyUpstreamDraft.toString()};const reverseProxyBlocked=${reverseProxyBlocked.toString()};const reverseProxyAcknowledged=${reverseProxyAcknowledged.toString()};return ${bindAccountReverseProxy.toString()};})()`
