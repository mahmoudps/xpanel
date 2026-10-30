import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { WHM_SSL_OBSERVATIONS_BINDING } from './whm-ssl-observations-client.ts'
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
const SSL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SSL_NAME = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
export interface SslCertificateView {
  id: string; accountId: string | null; username: string | null; names: string[]
  source: 'acme' | 'upload' | 'self-signed'; challenge: 'http-01' | 'dns-01' | null
  notBefore: string | null; notAfter: string; autoRenew: boolean; fingerprintSha256: string | null
  renewedAt: string | null; assignedDomains: string[]
}
export interface SslWorkspaceView {
  revision: number
  accounts: { id: string; username: string; status: string }[]
  domains: { id: string; accountId: string; name: string; certificateId: string | null }[]
  certificates: SslCertificateView[]
  capabilities: { issue: boolean; renew: boolean; install: boolean; remove: boolean }
}
export function sslObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
const sslId = (value: unknown): string => { if (typeof value !== 'string' || !SSL_ID.test(value)) throw new Error('invalid_certificate_identity'); return value.toLowerCase() }
const sslDate = (value: unknown, optional = false): string | null => { if (optional && value === null) return null; if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('invalid_certificate_date'); return value }
const sslNames = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some(name => typeof name !== 'string' || !SSL_NAME.test(name))) throw new Error('invalid_certificate_names')
  if (new Set(value).size !== value.length) throw new Error('duplicate_certificate_names')
  return value as string[]
}
export const sslCoversHost = (names: readonly string[], host: string): boolean => names.some(name => name === host || name.startsWith('*.') && host.endsWith(name.slice(1)) && host.split('.').length === name.split('.').length)
export function readSslWorkspace(value: unknown): SslWorkspaceView {
  if (!sslObject(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.accounts) || !Array.isArray(value.domains) || !Array.isArray(value.certificates) || !sslObject(value.capabilities)) throw new Error('invalid_certificate_workspace')
  if (Math.max(value.accounts.length, value.domains.length, value.certificates.length) > 10000) throw new Error('certificate_workspace_too_large')
  const accounts = value.accounts.map(raw => {
    if (!sslObject(raw) || typeof raw.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.username) || typeof raw.status !== 'string') throw new Error('invalid_certificate_account')
    return { id: sslId(raw.id), username: raw.username, status: raw.status }
  })
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new Error('duplicate_certificate_account')
  const domains = value.domains.map(raw => {
    if (!sslObject(raw) || typeof raw.name !== 'string' || !SSL_NAME.test(raw.name) || raw.name.startsWith('*.')) throw new Error('invalid_certificate_domain')
    const domain = { id: sslId(raw.id), accountId: sslId(raw.accountId), name: raw.name, certificateId: raw.certificateId === null ? null : sslId(raw.certificateId) }
    if (!accounts.some(account => account.id === domain.accountId)) throw new Error('foreign_certificate_domain')
    return domain
  })
  const certificates = value.certificates.map(raw => {
    if (!sslObject(raw) || !['acme', 'upload', 'self-signed'].includes(String(raw.source)) || ![null, 'http-01', 'dns-01'].includes(raw.challenge as null | string) || typeof raw.autoRenew !== 'boolean') throw new Error('invalid_certificate')
    const accountId = raw.accountId === null ? null : sslId(raw.accountId)
    const account = accounts.find(account => account.id === accountId)
    if (accountId !== null && (!account || raw.username !== account.username)) throw new Error('foreign_certificate')
    if (raw.fingerprintSha256 !== null && (typeof raw.fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.fingerprintSha256))) throw new Error('invalid_certificate_fingerprint')
    const names = sslNames(raw.names)
    if (!names.length) throw new Error('invalid_certificate_names')
    return { id: sslId(raw.id), accountId, username: account?.username ?? null, names,
      source: raw.source as SslCertificateView['source'], challenge: raw.challenge as SslCertificateView['challenge'],
      notBefore: sslDate(raw.notBefore, true), notAfter: sslDate(raw.notAfter)!, autoRenew: raw.autoRenew,
      fingerprintSha256: raw.fingerprintSha256 as string | null, renewedAt: sslDate(raw.renewedAt, true), assignedDomains: sslNames(raw.assignedDomains) }
  })
  if (new Set(certificates.map(certificate => certificate.id)).size !== certificates.length || new Set(domains.map(domain => domain.id)).size !== domains.length) throw new Error('duplicate_certificate_record')
  const capabilities = {} as SslWorkspaceView['capabilities']
  for (const key of ['issue', 'renew', 'install', 'remove'] as const) { if (typeof value.capabilities[key] !== 'boolean') throw new Error('invalid_certificate_capability'); capabilities[key] = value.capabilities[key] }
  return { revision: value.revision as number, accounts, domains, certificates, capabilities }
}
export function sslWriteUncertain(error: unknown): boolean {
  const value = sslObject(error) ? error : {}, details = sslObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true)) return true
  if (details.stateChanged === false || value.stateChanged === false) return false
  return typeof value.status !== 'number' || value.status >= 500
}

function bindWhmSsl(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-ssl]').forEach(root => {
    if (root.dataset.sslBound === 'true') return
    root.dataset.sslBound = 'true'
    const control = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-ssl-' + key + ']')!
    const account = control<HTMLSelectElement>('account'), domain = control<HTMLSelectElement>('domain'), renewal = control<HTMLSelectElement>('renewal')
    const search = control<HTMLInputElement>('search'), accountFilter = control<HTMLSelectElement>('account-filter'), statusFilter = control<HTMLSelectElement>('status-filter')
    const chain = control<HTMLTextAreaElement>('chain'), key = control<HTMLTextAreaElement>('key'), status = control<HTMLElement>('status'), rows = control<HTMLElement>('rows')
    if (![account, domain, renewal, search, accountFilter, statusFilter, chain, key, status, rows, control('refresh'), control('issue'), control('install')].every(Boolean)) return
    const rowSlots=['names','account','source','challenge','expires','renewal','status','actions'] as const
    const templates={row:clientTemplate(root,'whm-ssl-row'),empty:clientTemplate(root,'whm-ssl-empty'),fact:clientTemplate(root,'whm-ssl-fact'),action:clientTemplate(root,'whm-ssl-action')}
    cloneClientTemplate(templates.row,'tr',rowSlots);cloneClientTemplate(templates.empty,'tr',['message']);cloneClientTemplate(templates.fact,'div',['label','value']);cloneClientTemplate(templates.action,'button',['label'])
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.sslCanManage === 'true' && !root.closest(denied)
    let workspace: SslWorkspaceView | null = null, busy = false, confirming = false, review = false
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !transport || !admitted() ? Promise.reject({ stateChanged: false }) : body === undefined ? transport(method, path) : transport(method, path, body)
    const read = async (): Promise<SslWorkspaceView> => readSslWorkspace(await request('GET', '/api/certificate-workspace'))
    const lock = (): void => {
      const blocked = !admitted() || busy || confirming || !workspace
      root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button').forEach(element => { element.disabled = blocked || review })
      control<HTMLButtonElement>('refresh').disabled = !admitted() || busy || confirming
      control<HTMLButtonElement>('issue').disabled = blocked || review || !domain.value || !workspace?.capabilities[renewal.value ? 'renew' : 'issue']
      control<HTMLButtonElement>('install').disabled = blocked || review || !domain.value || !workspace?.capabilities.install
      chain.disabled = blocked || review || !workspace?.capabilities.install; key.disabled = chain.disabled
      root.setAttribute('aria-busy', String(busy || confirming))
      rows.querySelectorAll<HTMLButtonElement>('[data-ssl-renew]').forEach(button => { button.disabled ||= !workspace?.capabilities[button.dataset.sslOperation === 'install' ? 'install' : 'renew'] || button.dataset.sslActionAvailable !== 'true' })
      rows.querySelectorAll<HTMLButtonElement>('[data-ssl-remove]').forEach(button => { button.disabled ||= !workspace?.capabilities.remove })
    }
    const option = (select: HTMLSelectElement, value: string, label: string): void => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item) }
    const renewOptions = (): void => {
      const previous = renewal.value; renewal.textContent = ''; option(renewal, '', t('Issue a new certificate'))
      for (const certificate of workspace?.certificates ?? []) if (certificate.source === 'acme' && certificate.challenge === 'http-01' && certificate.username === account.value && certificate.assignedDomains.includes(domain.value) && sslCoversHost(certificate.names, domain.value)) option(renewal, certificate.id, certificate.names.join(', '))
      if (Array.from(renewal.options).some(item => item.value === previous)) renewal.value = previous
    }
    const domainOptions = (): void => {
      const previous = domain.value; domain.textContent = ''
      const owner = workspace?.accounts.find(item => item.username === account.value)
      for (const item of workspace?.domains ?? []) if (item.accountId === owner?.id) option(domain, item.name, item.name)
      if (Array.from(domain.options).some(item => item.value === previous)) domain.value = previous
      renewOptions(); lock()
    }
    const details = (certificate: SslCertificateView): void => {
      const panel = control<HTMLElement>('detail'), facts = control<HTMLElement>('facts'); facts.textContent = ''
      const values = [[t('Names'), certificate.names.join(', ')], [t('Account'), certificate.username ?? t(msgctxt('whm-ssl-client', 'Unassigned'))], [t('Assigned domains'), certificate.assignedDomains.join(', ') || t('None')], [t('Not before (UTC)'), certificate.notBefore === null ? t('Not read') : displayDateTime(certificate.notBefore)], [t('Expires (UTC)'), displayDateTime(certificate.notAfter)], ['SHA-256', certificate.fingerprintSha256 ?? t('Not read')]]
      for(const [label,text]of values){const group=cloneClientTemplate(templates.fact,'div',['label','value']);clientTemplateSlot(group,'label').textContent=label!;clientTemplateSlot(group,'value').textContent=text!;facts.append(group)}
      panel.hidden = false
    }
    const showRows = (): void => {
      rows.textContent = ''
      const now = Date.now(), query = search.value.trim().toLowerCase()
      const certificates = (workspace?.certificates ?? []).filter(certificate => {
        const remaining = Date.parse(certificate.notAfter) - now
        return (!query || certificate.names.some(name => name.includes(query))) && (!accountFilter.value || certificate.accountId === accountFilter.value)
          && (statusFilter.value === 'all' || statusFilter.value === 'expired' && remaining <= 0 || statusFilter.value === 'expiring' && remaining > 0 && remaining <= 30 * 86400000 || statusFilter.value === 'later' && remaining > 30 * 86400000)
      })
      for (const certificate of certificates) {
        const row=cloneClientTemplate(templates.row,'tr',rowSlots)
        const source = certificate.source === 'acme' ? 'ACME' : certificate.source === 'upload' ? t(msgctxt('whm-ssl-client', 'Uploaded')) : t('Self-signed')
        const values = [certificate.names.join(', '), certificate.username ?? t(msgctxt('whm-ssl-client', 'Unassigned')), source, certificate.challenge ?? t(msgctxt('whm-ssl-client', 'Not configured')), displayDateTime(certificate.notAfter), certificate.autoRenew ? t(msgctxt('whm-ssl-client', 'Requested on')) : t(msgctxt('whm-ssl-client', 'Requested off')), t('Stored; served TLS unverified')]
        const fieldSlots=['names','account','source','challenge','expires','renewal','status'] as const
        fieldSlots.forEach((slot,index)=>{clientTemplateSlot(row,slot).textContent=values[index]!})
        const group=clientTemplateSlot(row,'actions')
        const action=(label:string,callback:()=>void):HTMLButtonElement=>{const button=cloneClientTemplate(templates.action,'button',['label']) as HTMLButtonElement;clientTemplateSlot(button,'label').textContent=label;button.addEventListener('click',()=>{if(!button.disabled&&admitted())callback()});group.append(button);return button}
        action(t('Details'), () => details(certificate))
        const renew = action(certificate.source === 'acme' ? t('Renew') : t('Replace'), () => {
          if (!certificate.username || !certificate.assignedDomains.length) return
          account.value = certificate.username; domainOptions(); domain.value = certificate.assignedDomains[0]!; renewOptions()
          renewal.value = certificate.source === 'acme' ? certificate.id : ''; lock()
          ;(certificate.source === 'acme' ? control<HTMLButtonElement>('issue') : chain).focus()
        })
        renew.dataset.sslRenew = certificate.id; renew.dataset.sslActionAvailable = String(!!certificate.username && certificate.assignedDomains.length > 0 && (certificate.source === 'acme' ? certificate.challenge === 'http-01' : workspace?.capabilities.install === true))
        renew.dataset.sslOperation = certificate.source === 'acme' ? 'renew' : 'install'
        const remove = action(t('Remove stored certificate'), () => { void mutate('remove', certificate) }); remove.dataset.sslRemove = certificate.id
        rows.append(row)
      }
      if(!certificates.length){const row=cloneClientTemplate(templates.empty,'tr',['message']);clientTemplateSlot(row,'message','td').textContent=t('No stored certificates match these filters.');rows.append(row)}
      lock()
    }
    const installRead = (value: SslWorkspaceView): void => {
      const previous = account.value; workspace = value; account.textContent = ''; accountFilter.textContent = ''
      control<HTMLElement>('install-limit').textContent = value.capabilities.install
        ? t('The private key is sent once to the authorized host and cleared from this form after submission. Site TLS is verified separately.')
        : t('Manual installation is unavailable on this host. Nothing will be uploaded.')
      option(accountFilter, '', t(msgctxt('whm-ssl-client', 'All accounts')))
      for (const item of value.accounts) { option(account, item.username, item.username); option(accountFilter, item.id, item.username) }
      if (Array.from(account.options).some(item => item.value === previous)) account.value = previous
      control<HTMLElement>('detail').hidden = true
      domainOptions(); showRows(); lock()
    }
    const confirm = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog || confirming) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      confirming = true; lock()
      try { return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true } catch { return false } finally { confirming = false; lock() }
    }
    const refresh = async (): Promise<void> => {
      if (busy || confirming || !admitted()) return
      if ((review || chain.value || key.value) && !await confirm(t('Discard upload draft and read stored certificates?'), t('Certificate input is cleared. No previous request is retried.'), true)) return
      if (busy || confirming || !admitted()) return
      busy = true; lock()
      try { const value = await read(); chain.value = ''; key.value = ''; review = false; installRead(value); announce('read', t('Stored certificates read. Served TLS and renewal scheduling remain unverified.')) }
      catch { announce('failed', t('Stored certificates could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function mutate(kind: 'issue' | 'install' | 'remove', target?: SslCertificateView): Promise<void> {
      if (!admitted() || busy || confirming || review || !workspace) return
      const baseline = workspace, owner = baseline.accounts.find(item => item.username === account.value)
      const selectedDomain = baseline.domains.find(item => item.accountId === owner?.id && item.name === domain.value)
      const renewing = renewal.value ? baseline.certificates.find(item => item.id === renewal.value) : undefined
      if (kind !== 'remove' && (!owner || !selectedDomain)) return
      if (kind === 'remove' ? !target || !baseline.capabilities.remove : kind === 'install' ? !baseline.capabilities.install : !baseline.capabilities[renewing ? 'renew' : 'issue']) return
      if (kind === 'install' && (!chain.value || !key.value || chain.value.length > 256 * 1024 || key.value.length > 32 * 1024)) { announce('failed', t('A bounded PEM certificate chain and private key are required. Nothing was sent.')); return }
      const label = kind === 'remove' ? target!.names.join(', ') : domain.value
      const title = kind === 'remove' ? t('Remove stored certificate') : kind === 'install' ? t('Install certificate') : renewing ? t('Renew certificate') : t('Request certificate')
      if (!await confirm(title, label + '\n' + (kind === 'remove' ? t('Its saved domain assignments are removed. This does not revoke the certificate at the CA.') : t('This changes certificate configuration for this domain. External served TLS is verified separately.')), kind === 'remove')) return
      if (!admitted() || busy) return
      busy = true; lock(); let submitted = false
      try {
        const current = await read()
        if (current.revision !== baseline.revision) { review = true; announce('stale', t('Certificate configuration changed. Read and review it before another request.')); return }
        let response: unknown
        submitted = true
        if (kind === 'remove') response = await request('DELETE', '/api/certificate-workspace/' + encodeURIComponent(target!.id), { expectedRevision: baseline.revision })
        else if (kind === 'install') {
          const body = { username: owner!.username, domain: selectedDomain!.name, expectedRevision: baseline.revision, fullchainPem: chain.value, privateKeyPem: key.value }
          key.value = ''
          response = await request('POST', '/api/certificate-workspace/install', body)
        } else response = await request('POST', '/api/accounts/' + encodeURIComponent(owner!.username) + '/certificates', { domain: selectedDomain!.name, expectedRevision: baseline.revision, ...(renewing ? { certificateId: renewing.id } : {}) })
        if (!sslObject(response) || [response, sslObject(response.details) ? response.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true)) throw new Error('certificate_acknowledgement_unknown')
        const observed = await read()
        if (kind === 'remove') {
          if (response.ok !== true || response.removedCertificateId !== target!.id || observed.certificates.some(item => item.id === target!.id) || observed.domains.some(item => item.certificateId === target!.id)) throw new Error('certificate_removal_readback_mismatch')
        } else {
          const ack = response.certificate
          if (!sslObject(ack) || typeof ack.id !== 'string' || ack.accountId !== owner!.id || !Array.isArray(ack.names) || !sslCoversHost(sslNames(ack.names), selectedDomain!.name)) throw new Error('certificate_acknowledgement_mismatch')
          const found = observed.certificates.find(item => item.id === ack.id)
          if (!found || found.accountId !== owner!.id || found.notAfter !== ack.notAfter || found.source !== ack.source || found.challenge !== ack.challenge || found.autoRenew !== ack.autoRenew || found.fingerprintSha256 !== (ack.fingerprintSha256 ?? null) || [...found.names].sort().join('\n') !== [...ack.names].sort().join('\n') || !observed.domains.some(item => item.id === selectedDomain!.id && item.certificateId === found.id)) throw new Error('certificate_saved_readback_mismatch')
          if (renewing && (found.id !== renewing.id || [...found.names].sort().join('\n') !== [...renewing.names].sort().join('\n'))) throw new Error('certificate_renewal_identity_changed')
        }
        if (kind === 'install') { chain.value = ''; key.value = '' }
        installRead(observed)
        announce('saved', t('Stored certificate configuration and readback verified. Served TLS remains unverified.'))
      } catch (error) {
        review = submitted && sslWriteUncertain(error)
        if (sslObject(error) && error.status === 409) review = true
        announce(review ? 'uncertain' : 'failed', review ? t('The outcome requires review. No retry was sent. Read stored configuration before continuing.') : t('The request was refused or could not be read. No retry was sent. A submitted private key has been cleared.'))
      } finally { busy = false; lock() }
    }
    if (!transport || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button').forEach(element => { element.disabled = true }); announce('unavailable', t('Certificate management is unavailable here. Nothing was read or changed.')); return }
    account.addEventListener('change', domainOptions); domain.addEventListener('change', () => { renewOptions(); lock() }); renewal.addEventListener('change', lock)
    search.addEventListener('input', showRows); accountFilter.addEventListener('change', showRows); statusFilter.addEventListener('change', showRows)
    control('clear-filters').addEventListener('click', () => { search.value = ''; accountFilter.value = ''; statusFilter.value = 'all'; showRows() })
    control('refresh').addEventListener('click', () => { void refresh() }); control('issue').addEventListener('click', () => { void mutate('issue') }); control('install').addEventListener('click', () => { void mutate('install') })
    window.addEventListener('beforeunload', event => { if (review || chain.value || key.value) { event.preventDefault(); event.returnValue = '' } })
    void refresh()
  })
}

/** Browser declarations of the shared certificate read/acknowledgement parsers, reused by the account SSL page. */
export const WHM_SSL_PARSER_BINDING = `const SSL_ID=${SSL_ID.toString()};const SSL_NAME=${SSL_NAME.toString()};const sslObject=${sslObject.toString()};const sslId=${sslId.toString()};const sslDate=${sslDate.toString()};const sslNames=${sslNames.toString()};const sslCoversHost=${sslCoversHost.toString()};const readSslWorkspace=${readSslWorkspace.toString()};const sslWriteUncertain=${sslWriteUncertain.toString()}`
export const WHM_SSL_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const displayDateTime=${DISPLAY_DATETIME_BINDING};${WHM_SSL_PARSER_BINDING};const bindMain=${bindWhmSsl.toString()};const bindObservations=${WHM_SSL_OBSERVATIONS_BINDING};return(askDialog)=>{bindMain(askDialog);bindObservations(readSslWorkspace)};})()`
