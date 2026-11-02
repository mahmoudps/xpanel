import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { domainCanonicalName, domainObject, domainPhpSettings, domainRoot, domainSafeText, domainStable, domainWriteUncertain, readDomainWorkspace } from './domain-workspace-client.ts'
import type { DomainWorkspaceRow, DomainWorkspaceView } from './domain-workspace-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const RP_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Module-local aliases keep the stringified functions free of bundler import rewrites.
const rpObject = domainObject, rpStable = domainStable, rpUncertain = domainWriteUncertain, rpReadWorkspace = readDomainWorkspace
const RP_UPSTREAM = /^https?:\/\/(127\.0\.0\.1|\[::1\]|[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,39}\])(?::([0-9]{1,5}))?(\/[A-Za-z0-9._~%/-]*)?$/
const RP_HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const RP_RESERVED_HEADERS = ['host', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'forwarded', 'upgrade', 'connection', 'proxy', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'content-length', 'expect', 'proxy-authorization', 'proxy-connection']
export type ReverseProxyBlock = 'alias' | 'aliases' | 'app' | 'redirect' | null
export interface ReverseProxyOptions { websocket: boolean; hostHeader: 'client' | 'upstream'; headers: { name: string; value: string }[] }
/** Format hint only; the server applies the authoritative loopback, allowed-host, ownership and reserved-port rules. */
export function reverseProxyUpstreamDraft(value: unknown): string | null {
  const match = typeof value === 'string' ? RP_UPSTREAM.exec(value) : null
  if (!match) return null
  const local = match[1] === '127.0.0.1' || match[1] === '[::1]', port = match[2] === undefined ? null : Number(match[2])
  if (local ? port === null || port < 1024 || port > 65535 : port !== null && (port < 1 || port > 65535)) return null
  return (match[3] ?? '').split('/').some(part => part === '.' || part === '..') ? null : value as string
}
/** Saved options of a row; absence on the server means the defaults. */
export function reverseProxyOptionsOf(row: { proxy?: unknown }): ReverseProxyOptions {
  const raw = row.proxy as ReverseProxyOptions | undefined
  return raw ? { websocket: raw.websocket, hostHeader: raw.hostHeader, headers: raw.headers.map(h => ({ name: h.name, value: h.value })) } : { websocket: true, hostHeader: 'client', headers: [] }
}
/** Mirrors the server grammar so a typo is caught before anything is sent; returns the first problem, or null. */
export function reverseProxyHeadersProblem(headers: readonly { name: string; value: string }[]): 'count' | 'name' | 'reserved' | 'duplicate' | 'value' | null {
  if (headers.length > 8) return 'count'
  const seen = new Set<string>()
  for (const header of headers) {
    if (!RP_HEADER_NAME.test(header.name)) return 'name'
    const key = header.name.toLowerCase()
    if (RP_RESERVED_HEADERS.includes(key)) return 'reserved'
    if (seen.has(key)) return 'duplicate'
    seen.add(key)
    if (!/^[\x20-\x7e]{1,256}$/.test(header.value) || header.value.includes('$') || header.value.trim() !== header.value) return 'value'
  }
  return null
}
export function reverseProxyBlocked(row: DomainWorkspaceRow, rows: readonly DomainWorkspaceRow[]): ReverseProxyBlock {
  if (row.kind === 'alias') return 'alias'
  if (!['php', 'static', 'proxy'].includes(row.siteType)) return 'app'
  if (row.redirect) return 'redirect'
  return rows.some(other => other.kind === 'alias' && other.parentId === row.id) ? 'aliases' : null
}
/** The acknowledgement must change exactly this row's site type and upstream and report its application truthfully. */
export function reverseProxyAcknowledged(raw: unknown, accepted: DomainWorkspaceView, before: DomainWorkspaceView, id: string, siteType: string, upstream: string | null, options: ReverseProxyOptions | null = null): number | null | false {
  if (!rpObject(raw) || raw.stateChanged !== true || !rpObject(raw.domain)) return false
  const row = accepted.domains.find(entry => entry.id === id), previous = before.domains.find(entry => entry.id === id)
  const withoutProxy = (entry: object): Record<string, unknown> => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'proxy'))
  const expectedProxy = siteType === 'proxy' && options && rpStable(options) !== rpStable(reverseProxyOptionsOf({})) ? options : null
  if (!row || !previous || rpStable(row) !== rpStable(raw.domain) || row.siteType !== siteType || row.upstream !== upstream
    || rpStable((row as { proxy?: unknown }).proxy ?? null) !== rpStable(expectedProxy)
    || rpStable({ ...withoutProxy(row), siteType: previous.siteType, upstream: previous.upstream }) !== rpStable(withoutProxy(previous))
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
    const optionsBox = find('options'), websocket = find<HTMLInputElement>('websocket'), hostHeader = find<HTMLSelectElement>('host'), headerRows = find('header-rows'), addHeader = find<HTMLButtonElement>('add-header'), headersError = find('headers-error')
    if (!status || !rows || !application || !refreshButton || !mode || !upstream || !upstreamField || !error || !save || !cancel || !selectedName || !current || !docRoot
      || !optionsBox || !websocket || !hostHeader || !headerRows || !addHeader || !headersError) return
    const rowSlots = ['name', 'kind', 'mode', 'upstream', 'configure', 'reason'] as const
    const rowTemplate = clientTemplate(root, 'proxy-row'), headerTemplate = clientTemplate(root, 'proxy-header'), emptyTemplate = clientTemplate(root, 'proxy-empty')
    cloneClientTemplate(rowTemplate, 'tr', rowSlots); cloneClientTemplate(headerTemplate, 'tr', ['name', 'value', 'remove']); cloneClientTemplate(emptyTemplate, 'tr', ['message'])
    let view: DomainWorkspaceView | null = null, selected: string | null = null, busy = false, confirming = false, review = false
    const MODES: Record<string, string> = { php: t('PHP files'), static: t('Static files'), proxy: t(msgctxt('account-reverse-proxy-client', 'Reverse proxy')), node: t('Node application'), python: t('Python application') }
    const KINDS: Record<string, string> = { primary: t('Primary'), addon: t('Addon'), subdomain: t(msgctxt('account-reverse-proxy-client', 'Subdomain')), alias: t('Alias') }
    const BLOCKS: Record<string, string> = { alias: t('Follows the domain it points at'), aliases: t('Has aliases; unavailable here'), app: t('Application site; unavailable here'), redirect: t('Redirects; unavailable here') }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain', 'fields'].includes(state) ? 'alert' : 'status') }
    const row = (): DomainWorkspaceRow | undefined => view?.domains.find(entry => entry.id === selected)
    const fieldError = (message: string): void => { error.textContent = message; error.hidden = !message; upstream.setAttribute('aria-invalid', String(!!message)) }
    const lock = (): void => {
      const target = row(), blocked = !eligible() || !view || busy || confirming || review || !target || reverseProxyBlocked(target, view.domains) !== null
      mode.disabled = blocked; upstream.disabled = blocked || mode.value !== 'proxy'; upstreamField.hidden = mode.value !== 'proxy'; optionsBox.hidden = mode.value !== 'proxy'
      websocket.disabled = upstream.disabled; hostHeader.disabled = upstream.disabled
      headerRows.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => { control.disabled = upstream.disabled })
      addHeader.disabled = upstream.disabled || headerRows.querySelectorAll('[data-rp-header]').length >= 8
      save.disabled = blocked; cancel.disabled = !eligible() || busy || confirming || !target
      refreshButton.disabled = !eligible() || busy || confirming
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !eligible() || busy || confirming || review || button.dataset.rpBlocked === 'true' })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !send || !eligible() ? Promise.reject({ details: { stateChanged: false } }) : body === undefined ? send(method, path) : send(method, path, body)
    const read = async (): Promise<DomainWorkspaceView> => rpReadWorkspace(await request('GET', '/api/domains'), { accountId, home })
    const fill = (): void => {
      const target = row()
      selectedName.textContent = target ? target.name : t('None selected')
      current.textContent = target ? MODES[target.siteType] + (target.upstream ? ' · ' + target.upstream : '') : t(msgctxt('account-reverse-proxy-client', 'Not read'))
      docRoot.textContent = target ? target.docRoot : t(msgctxt('account-reverse-proxy-client', 'Not read'))
      mode.value = target && ['php', 'static', 'proxy'].includes(target.siteType) ? target.siteType : 'proxy'
      upstream.value = target?.upstream ?? ''; fieldError('')
      const options = reverseProxyOptionsOf(target ?? {})
      websocket.checked = options.websocket; hostHeader.value = options.hostHeader
      headerRows.querySelectorAll('[data-rp-header]').forEach(entry => entry.remove())
      for (const header of options.headers) headerRow(header.name, header.value)
      headersNote('')
    }
    function headersNote(message: string): void {
      headersError.textContent = message; headersError.hidden = !message
      headerRows.querySelector<HTMLElement>('[data-rp-header-empty]')?.toggleAttribute('hidden', !!headerRows.querySelector('[data-rp-header]'))
    }
    function headerRow(name: string, value: string): void {
      const tr = cloneClientTemplate(headerTemplate, 'tr', ['name', 'value', 'remove'])
      for (const [slot, text] of [['name', name], ['value', value]] as const) (clientTemplateSlot(tr, slot, 'input') as HTMLInputElement).value = text
      const remove = clientTemplateSlot(tr, 'remove', 'button') as HTMLButtonElement
      remove.addEventListener('click', () => { if (!remove.disabled) { tr.remove(); headersNote(''); lock() } })
      headerRows.append(tr); headersNote('')
    }
    const headersOf = (): { name: string; value: string }[] => [...headerRows.querySelectorAll<HTMLElement>('[data-rp-header]')].map(tr => ({
      name: tr.querySelector<HTMLInputElement>('[data-rp-header-field="name"]')!.value.trim(), value: tr.querySelector<HTMLInputElement>('[data-rp-header-field="value"]')!.value.trim() }))
    const paint = (next: DomainWorkspaceView): void => {
      view = next; review = false; rows.textContent = ''
      if (selected && !next.domains.some(entry => entry.id === selected)) selected = null
      for (const domain of next.domains) {
        const tr = cloneClientTemplate(rowTemplate, 'tr', rowSlots), block = reverseProxyBlocked(domain, next.domains)
        for (const [slot, text] of [['name', domain.name], ['kind', KINDS[domain.kind] ?? domain.kind], ['mode', MODES[domain.siteType] ?? domain.siteType], ['upstream', domain.upstream ?? '-']] as const) clientTemplateSlot(tr, slot).textContent = text
        const button = clientTemplateSlot(tr, 'configure', 'button') as HTMLButtonElement
        button.setAttribute('aria-label', t('Configure: {domain}', { domain: domain.name }))
        button.dataset.rpBlocked = String(block !== null)
        button.addEventListener('click', () => { if (button.disabled) return; selected = domain.id; fill(); lock(); mode.focus() })
        const reason = clientTemplateSlot(tr, 'reason'); reason.hidden = !block; reason.textContent = block ? BLOCKS[block]! : ''
        rows.append(tr)
      }
      if (!next.domains.length) { const tr = cloneClientTemplate(emptyTemplate, 'tr', ['message']); clientTemplateSlot(tr, 'message', 'td').textContent = t('This account has no domains.'); rows.append(tr) }
      fill()
    }
    const fieldMessage = (code: string): string => ({
      invalid: t('Enter an address like http://127.0.0.1:3000, with an optional path and no user name, query or spaces.'),
      not_loopback: t('Only 127.0.0.1 and [::1] are available in this version.'),
      reserved_port: t('This port is below 1024 or used by a server service. Choose another port for your application.'),
      port_taken: t('Another account already uses this local port. Choose another port for your application.'),
      host_not_allowed: t('This host is not allowed. Use 127.0.0.1 or [::1], or ask the server administrator to allow the remote host.'),
      resolver_unavailable: t('This server cannot resolve host names for a proxy. Use the IP address of the remote host.'),
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
      const field = rpObject(first) && typeof first.field === 'string' ? first.field : ''
      if (code && details.stateChanged === false && ['headers', 'websocket', 'hostHeader', 'proxy'].includes(field)) {
        const message = t('The proxy options were refused. Check the headers and try again.'); note('fields', message); headersNote(message); return
      }
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
      const options: ReverseProxyOptions | null = siteType === 'proxy' ? { websocket: websocket.checked, hostHeader: hostHeader.value === 'upstream' ? 'upstream' : 'client', headers: headersOf() } : null
      const problem = options ? reverseProxyHeadersProblem(options.headers) : null
      if (problem) {
        const message = ({ count: t('Up to 8 headers can be sent.'), name: t('Header names use letters, digits and "-" only.'), reserved: t('This header is set by the server and cannot be replaced.'),
          duplicate: t('Each header can be listed once.'), value: t('Header values are plain text without "$" and without leading or trailing spaces.') } as Record<string, string>)[problem]!
        headersNote(message); note('fields', message); return
      }
      if (siteType === target.siteType && address === target.upstream && (!options || rpStable(options) === rpStable(reverseProxyOptionsOf(target)))) { note('fields', fieldMessage('unchanged')); return }
      fieldError('')
      headersNote('')
      if (!askDialog) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      note('read', t('Saved domain configuration read.'))
      confirming = true; lock()
      let approved = false
      try { approved = await askDialog({ title: t('Change how this domain is served?'), danger: false, confirm: t('Save'),
        body: target.name + '\n' + MODES[siteType] + (address ? ': ' + address : '') + '\n' + (options ? (options.websocket ? t('WebSocket connections are relayed.') : t('WebSocket connections are not relayed.')) + ' ' + t('Extra headers: {count}', { count: options.headers.length }) + '\n' : '') + (siteType === 'proxy' ? t('Its document root and PHP settings are kept but not used while proxied.') : t('Files are served from the saved document root again.')) }) === true }
      catch { approved = false } finally { confirming = false; lock() }
      if (!approved || view !== before || !eligible()) return
      busy = true; lock(); note('saving', t('Checking the saved configuration, then saving…'))
      let dispatched = false
      try {
        const fresh = await read()
        if (fresh.revision !== before.revision) { review = true; note('stale', t('The domain configuration changed elsewhere. Nothing was sent. Read domains before trying again.')); return }
        dispatched = true
        const raw = await request('PUT', '/api/domains/' + encodeURIComponent(target.id) + '/reverse-proxy', { expectedRevision: before.revision, siteType, ...(options ? { upstream: address, proxy: options } : {}) })
        const accepted = rpReadWorkspace(raw, { accountId, home }), generation = reverseProxyAcknowledged(raw, accepted, before, target.id, siteType, address, options)
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
    addHeader.addEventListener('click', () => { if (addHeader.disabled) return; headerRow('', ''); lock(); headerRows.querySelector<HTMLInputElement>('[data-rp-header]:last-child [data-rp-header-field="name"]')?.focus() })
    refreshButton.addEventListener('click', () => { void refresh() })
    cancel.addEventListener('click', () => { if (!cancel.disabled) { selected = null; fill(); lock() } })
    save.addEventListener('click', () => { if (!save.disabled) void submit() })
    lock(); void refresh()
  })
}

export const ACCOUNT_REVERSE_PROXY_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const domainObject=${domainObject.toString()};const domainSafeText=${domainSafeText.toString()};const domainCanonicalName=${domainCanonicalName.toString()};const domainRoot=${domainRoot.toString()};const domainStable=${domainStable.toString()};const domainWriteUncertain=${domainWriteUncertain.toString()};const domainPhpSettings=${domainPhpSettings.toString()};const readDomainWorkspace=${readDomainWorkspace.toString()};const rpObject=domainObject;const rpStable=domainStable;const rpUncertain=domainWriteUncertain;const rpReadWorkspace=readDomainWorkspace;const RP_ACCOUNT_ID=${RP_ACCOUNT_ID.toString()};const RP_UPSTREAM=${RP_UPSTREAM.toString()};const RP_HEADER_NAME=${RP_HEADER_NAME.toString()};const RP_RESERVED_HEADERS=${JSON.stringify(RP_RESERVED_HEADERS)};const reverseProxyUpstreamDraft=${reverseProxyUpstreamDraft.toString()};const reverseProxyOptionsOf=${reverseProxyOptionsOf.toString()};const reverseProxyHeadersProblem=${reverseProxyHeadersProblem.toString()};const reverseProxyBlocked=${reverseProxyBlocked.toString()};const reverseProxyAcknowledged=${reverseProxyAcknowledged.toString()};return ${bindAccountReverseProxy.toString()};})()`
