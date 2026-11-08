/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate

export interface DavClientAddress { domain: string; url: string }
export interface WebDiskClientLogin { kind: 'main' | 'user'; id: string | null; login: string; directory: string; access: 'read-write' | 'read-only'; otherServices: ('email' | 'ftp')[] }
export interface WebDiskClientView { addresses: DavClientAddress[]; unsecuredDomains: string[]; logins: WebDiskClientLogin[] }
export interface DavClientPrincipal { login: string; server: string | null; principal: string | null; calendar: string | null; addressBook: string | null; profile: string | null }
export interface DavClientView { unsecuredDomains: string[]; principals: DavClientPrincipal[] }

const DAV_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAV_DOMAIN = /^[a-z0-9.-]{1,253}$/
const DAV_LOCAL_PART = /^[a-z0-9][a-z0-9._+-]{0,63}$/
const DAV_DIRECTORY = /^[^\s/][^\s]{0,239}$/
const DAV_MIN_PASSWORD = 8
const DAV_PROFILE = /^\/api\/(?:webmail\/dav-config\/apple\.mobileconfig|account\/calendars-contacts\/connection\/apple\.mobileconfig\?principal=(?:main|[0-9a-f-]{36}))$/
function davObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function davLogin(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 254 && !/[\s\u0000-\u001f]/.test(value) }
function davHttps(value: unknown): value is string { return typeof value === 'string' && value.length <= 512 && value.startsWith('https://') && !/\s/.test(value) }
function davDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(name => typeof name !== 'string' || !DAV_DOMAIN.test(name))) throw new Error('invalid_dav_domains')
  return value as string[]
}
function davAddresses(value: unknown): DavClientAddress[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(item => !davObject(item) || typeof item.domain !== 'string' || !DAV_DOMAIN.test(item.domain) || !davHttps(item.url))) throw new Error('invalid_dav_addresses')
  return (value as DavClientAddress[]).map(item => ({ domain: item.domain, url: item.url }))
}
function davPrincipal(raw: unknown): DavClientPrincipal {
  if (!davObject(raw) || !davLogin(raw.login)) throw new Error('invalid_dav_principal')
  const urls = [raw.server, raw.principal, raw.calendar, raw.addressBook]
  // A login without a served address has no URL at all; a partial set would send a device to the wrong place.
  if (!urls.every(url => url === null) && !urls.every(davHttps)) throw new Error('invalid_dav_principal')
  if (raw.server === null ? raw.profile !== null : typeof raw.profile !== 'string' || !DAV_PROFILE.test(raw.profile)) throw new Error('invalid_dav_principal')
  return { login: raw.login, server: raw.server as string | null, principal: raw.principal as string | null, calendar: raw.calendar as string | null, addressBook: raw.addressBook as string | null, profile: raw.profile as string | null }
}

/** The text behind Download connection settings. It never holds a password. */
export function webDiskSettingsText(view: WebDiskClientView, heading: string): string {
  return [heading, '', ...view.addresses.map(address => address.url), '', ...view.logins.map(login => `${login.login} (${login.access}) ${login.directory}`.trimEnd())].join('\n') + '\n'
}

/** Reader of GET /api/account/web-disk, bound to the account of this document. */
export function readWebDiskClientView(raw: unknown, accountId: string): WebDiskClientView {
  if (!davObject(raw) || !davObject(raw.context) || raw.context.accountId !== accountId || !Array.isArray(raw.logins) || raw.logins.length > 10000) throw new Error('invalid_web_disk_view')
  const logins = raw.logins.map((item: unknown): WebDiskClientLogin => {
    if (!davObject(item) || !['main', 'user'].includes(item.kind as string) || !davLogin(item.login) || typeof item.directory !== 'string' || item.directory.length > 240 || !['read-write', 'read-only'].includes(item.access as string)
      || !Array.isArray(item.otherServices) || item.otherServices.some(service => service !== 'email' && service !== 'ftp')
      || (item.kind === 'main' ? item.id !== null : typeof item.id !== 'string' || !DAV_ACCOUNT_ID.test(item.id))) throw new Error('invalid_web_disk_login')
    return { kind: item.kind as 'main' | 'user', id: item.id as string | null, login: item.login, directory: item.directory, access: item.access as 'read-write' | 'read-only', otherServices: item.otherServices as ('email' | 'ftp')[] }
  })
  if (logins[0]?.kind !== 'main') throw new Error('invalid_web_disk_login')
  return { addresses: davAddresses(raw.addresses), unsecuredDomains: davDomains(raw.unsecuredDomains), logins }
}

/** Reader of GET /api/account/calendars-contacts/connection. */
export function readDavClientView(raw: unknown, accountId: string): DavClientView {
  if (!davObject(raw) || !davObject(raw.context) || raw.context.accountId !== accountId || !Array.isArray(raw.principals) || raw.principals.length > 10000) throw new Error('invalid_dav_view')
  return { unsecuredDomains: davDomains(raw.unsecuredDomains), principals: raw.principals.map(davPrincipal) }
}

/** Reader of GET /api/webmail/dav-config: exactly the signed-in mailbox, never another one. */
export function readMailDavClientView(raw: unknown, mailbox: string): DavClientView {
  const own = mailbox.toLowerCase()
  if (!davObject(raw) || typeof raw.mailbox !== 'string' || raw.mailbox.toLowerCase() !== own) throw new Error('invalid_mail_dav_view')
  const principal = davPrincipal(raw)
  if (principal.login !== own) throw new Error('invalid_mail_dav_view')
  return { unsecuredDomains: [], principals: [principal] }
}

export function davOutcomeUncertain(error: unknown): boolean {
  const value = davObject(error) ? error : {}, details = davObject(value.details) ? value.details : {}
  if ([value, details].some(part => part.stateChanged === true || part.unknownOutcome === true || part.verificationRequired === true)) return true
  if ([value, details].some(part => part.stateChanged === false)) return false
  return typeof value.status !== 'number' || value.status >= 500
}

function davBlocked(root: HTMLElement): boolean { return root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"]') !== null }

function bindAccountDav(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const say = (status: HTMLElement, state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'fields'].includes(state) ? 'alert' : 'status') }
  const unsecuredNote = (domains: readonly string[]): string => domains.length ? t('These domains have no installed certificate, so they are not served: {domains}', { domains: domains.join(', ') }) : ''

  document.querySelectorAll<HTMLElement>('[data-account-web-disk]').forEach(root => {
    if (root.dataset.webDiskBound === 'true') return
    root.dataset.webDiskBound = 'true'
    const PATH = '/api/account/web-disk', accountId = root.dataset.account ?? ''
    const status = root.querySelector<HTMLElement>('[data-web-disk-status]')!, rows = root.querySelector<HTMLElement>('[data-web-disk-rows]')!, addresses = root.querySelector<HTMLElement>('[data-web-disk-addresses]')!
    const unsecured = root.querySelector<HTMLElement>('[data-web-disk-unsecured]')!, title = root.querySelector<HTMLElement>('[data-web-disk-form-title]')!, refreshButton = root.querySelector<HTMLButtonElement>('[data-web-disk-refresh]')!
    const local = root.querySelector<HTMLInputElement>('[data-web-disk-local]')!, domain = root.querySelector<HTMLSelectElement>('[data-web-disk-domain]')!, password = root.querySelector<HTMLInputElement>('[data-web-disk-password]')!
    const directory = root.querySelector<HTMLInputElement>('[data-web-disk-directory]')!, readOnly = root.querySelector<HTMLInputElement>('[data-web-disk-read-only]')!
    const save = root.querySelector<HTMLButtonElement>('[data-web-disk-save]')!, cancel = root.querySelector<HTMLButtonElement>('[data-web-disk-cancel]')!
    const download = root.querySelector<HTMLButtonElement>('[data-web-disk-download]')!
    if (![status, rows, addresses, unsecured, title, refreshButton, local, domain, password, directory, readOnly, save, cancel, download].every(Boolean)) return
    const close = (): void => { for (const control of [refreshButton, local, domain, password, directory, readOnly, save, cancel]) control.disabled = true; say(status, 'unavailable', t('Web Disk is unavailable here. Nothing was read or changed.')) }
    const eligible = (): boolean => root.isConnected && root.dataset.webDiskManage === 'true' && !davBlocked(root)
    let templates: { row: HTMLTemplateElement; action: HTMLTemplateElement; address: HTMLTemplateElement }
    try {
      templates = { row: clientTemplate(root, 'web-disk-login-row'), action: clientTemplate(root, 'web-disk-login-action'), address: clientTemplate(root, 'web-disk-address') }
      cloneClientTemplate(templates.row, 'tr', ['login', 'directory', 'access', 'actions'])
      cloneClientTemplate(templates.action, 'button', ['label'])
      cloneClientTemplate(templates.address, 'li', ['url'])
    } catch { close(); return }
    let view: WebDiskClientView | null = null, editing: WebDiskClientLogin | null = null, busy = false, confirming = false, review = false
    const directoryValue = (): string => directory.value.trim()
    const complete = (): boolean => DAV_DIRECTORY.test(directoryValue()) && (editing
      ? password.value === '' || password.value.length >= DAV_MIN_PASSWORD
      : DAV_LOCAL_PART.test(local.value.trim().toLowerCase()) && DAV_DOMAIN.test(domain.value) && password.value.length >= DAV_MIN_PASSWORD)
    const lock = (): void => {
      const blocked = !eligible() || !view || busy || confirming || review
      local.disabled = domain.disabled = blocked || editing !== null
      password.disabled = directory.disabled = readOnly.disabled = blocked
      save.disabled = blocked || !complete()
      cancel.hidden = editing === null
      cancel.disabled = busy || confirming
      refreshButton.disabled = !eligible() || busy || confirming
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = blocked })
      root.setAttribute('aria-busy', String(busy || confirming))
    }
    const reset = (): void => {
      editing = null; local.value = ''; password.value = ''; directory.value = 'public_html'; readOnly.checked = false
      title.textContent = t('Add a Web Disk login'); save.textContent = t('Add login')
    }
    const edit = (login: WebDiskClientLogin): void => {
      editing = login; local.value = login.login.slice(0, login.login.indexOf('@')); password.value = ''; directory.value = login.directory; readOnly.checked = login.access === 'read-only'
      domain.value = login.login.slice(login.login.indexOf('@') + 1)
      title.textContent = t('Change {login}', { login: login.login }); save.textContent = t('Save changes')
      lock(); directory.focus()
    }
    const action = (label: string, target: string, run: () => void): HTMLElement => {
      const button = cloneClientTemplate(templates.action, 'button', ['label'])
      clientTemplateSlot(button, 'label').textContent = label
      button.setAttribute('aria-label', label + ': ' + target)
      button.addEventListener('click', () => { if (!(button as HTMLButtonElement).disabled) run() })
      return button
    }
    const paint = (next: WebDiskClientView): void => {
      view = next; review = false; rows.textContent = ''; addresses.textContent = ''; download.disabled = !next.addresses.length
      for (const login of next.logins) {
        const row = cloneClientTemplate(templates.row, 'tr', ['login', 'directory', 'access', 'actions'])
        clientTemplateSlot(row, 'login').textContent = login.login
        clientTemplateSlot(row, 'directory').textContent = login.kind === 'main' ? root.dataset.webDiskHome ?? '' : login.directory
        clientTemplateSlot(row, 'access').textContent = login.access === 'read-only' ? t('Read only') : t('Read and write')
        const cell = clientTemplateSlot(row, 'actions')
        if (login.kind === 'main') cell.textContent = t('Uses the account password')
        else cell.append(action(t('Change'), login.login, () => edit(login)), action(t('Remove'), login.login, () => { void remove(login) }))
        rows.append(row)
      }
      for (const address of next.addresses) {
        const item = cloneClientTemplate(templates.address, 'li', ['url'])
        clientTemplateSlot(item, 'url').textContent = address.url
        addresses.append(item)
      }
      unsecured.textContent = unsecuredNote(next.unsecuredDomains)
      unsecured.hidden = !next.unsecuredDomains.length
      const chosen = domain.value
      domain.replaceChildren(...[...next.addresses.map(address => address.domain), ...next.unsecuredDomains].map(name => new Option(name, name)))
      if (chosen) domain.value = chosen
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !send || !eligible() ? Promise.reject({ stateChanged: false }) : body === undefined ? send(method, path) : send(method, path, body)
    const failed = (error: unknown): void => {
      review = davOutcomeUncertain(error)
      if (review) { say(status, 'uncertain', t('The outcome requires review. No retry was sent. Read the logins before continuing.')); return }
      say(status, 'failed', davObject(error) && error.status === 409 ? t('A login with this address already exists. Manage it under Service users.') : t(msgctxt('account-dav-client', 'The request was refused. Nothing was changed.')))
    }
    async function refresh(): Promise<void> {
      if (!eligible() || busy || confirming) return
      busy = true; lock(); say(status, 'reading', t('Reading Web Disk logins…'))
      try { paint(readWebDiskClientView(await request('GET', PATH), accountId)); say(status, 'read', t('Web Disk logins read from the account.')) }
      catch { say(status, 'failed', t('Web Disk logins could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    async function submit(): Promise<void> {
      if (save.disabled) return
      const target = editing, login = target ? target.login : local.value.trim().toLowerCase() + '@' + domain.value, path = directoryValue(), limited = readOnly.checked
      busy = true; lock(); say(status, 'saving', t('Saving and reading the logins back…'))
      try {
        if (target) await request('PATCH', '/api/service-users/' + target.id, { ftpDir: path, webdiskReadOnly: limited, ...(password.value ? { password: password.value } : {}) })
        else await request('POST', '/api/service-users', { login, password: password.value, services: { email: false, ftp: false, webdisk: true }, mailboxQuotaMb: 1, ftpDir: path, webdiskReadOnly: limited })
        const observed = readWebDiskClientView(await request('GET', PATH), accountId), found = observed.logins.find(item => item.login === login)
        if (!found || found.directory !== path || (found.access === 'read-only') !== limited) throw new Error('web_disk_readback_mismatch')
        paint(observed); reset(); say(status, 'saved', t('The login was saved and read back.'))
      } catch (error) { failed(error) }
      finally { busy = false; lock() }
    }
    async function remove(login: WebDiskClientLogin): Promise<void> {
      if (busy || confirming || review) return
      if (!askDialog) { say(status, 'failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      const kept = login.otherServices.length > 0
      confirming = true; lock()
      let confirmed = false
      try { confirmed = await askDialog({ title: t('Remove Web Disk from this login?'), body: login.login + '\n' + (kept ? t('The login keeps its other services.') : t('The login is deleted. Files in its directory stay in place.')), danger: true, confirm: t('Confirm') }) === true } catch { confirmed = false } finally { confirming = false; lock() }
      if (!confirmed || !eligible()) return
      busy = true; lock(); say(status, 'saving', t('Saving and reading the logins back…'))
      try {
        if (kept) await request('PATCH', '/api/service-users/' + login.id, { services: { email: login.otherServices.includes('email'), ftp: login.otherServices.includes('ftp'), webdisk: false } })
        else await request('DELETE', '/api/service-users/' + login.id)
        const observed = readWebDiskClientView(await request('GET', PATH), accountId)
        if (observed.logins.some(item => item.login === login.login)) throw new Error('web_disk_readback_mismatch')
        if (editing?.id === login.id) reset()
        paint(observed); say(status, 'saved', t('Web Disk was removed from this login and read back.'))
      } catch (error) { failed(error) }
      finally { busy = false; lock() }
    }
    if (!send || !eligible() || !DAV_ACCOUNT_ID.test(accountId)) { close(); return }
    for (const control of [local, password, directory]) control.addEventListener('input', () => { if (!busy) lock() })
    domain.addEventListener('change', lock)
    refreshButton.addEventListener('click', () => { void refresh() })
    download.addEventListener('click', () => {
      if (!view) return
      const link = document.createElement('a'), url = URL.createObjectURL(new Blob([webDiskSettingsText(view, t('Web Disk connection settings. Sign in with a login below and its password.'))], { type: 'text/plain;charset=utf-8' }))
      link.href = url; link.download = 'web-disk-settings.txt'; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url)
    })
    save.addEventListener('click', () => { void submit() })
    cancel.addEventListener('click', () => { reset(); lock() })
    reset(); lock(); void refresh()
  })

  document.querySelectorAll<HTMLElement>('[data-dav-connection]').forEach(root => {
    if (root.dataset.davBound === 'true') return
    root.dataset.davBound = 'true'
    const mailbox = root.dataset.davMailbox ?? '', accountId = root.dataset.account ?? ''
    const status = root.querySelector<HTMLElement>('[data-dav-status]')!, rows = root.querySelector<HTMLElement>('[data-dav-rows]')!, unsecured = root.querySelector<HTMLElement>('[data-dav-unsecured]')!, refreshButton = root.querySelector<HTMLButtonElement>('[data-dav-refresh]')!
    if (![status, rows, unsecured, refreshButton].every(Boolean)) return
    const eligible = (): boolean => root.isConnected && root.dataset.davEnabled === 'true' && !davBlocked(root) && (mailbox !== '' || DAV_ACCOUNT_ID.test(accountId))
    let template: HTMLTemplateElement
    try { template = clientTemplate(root, 'dav-principal-row'); cloneClientTemplate(template, 'tr', ['login', 'server', 'principal', 'calendar', 'address-book', 'profile']) }
    catch { refreshButton.disabled = true; say(status, 'unavailable', t('Device connection details are unavailable here. Nothing was read.')); return }
    const paint = (view: DavClientView): void => {
      rows.textContent = ''
      const none = t(msgctxt('account-dav-client', 'Not available'))
      for (const principal of view.principals) {
        const row = cloneClientTemplate(template, 'tr', ['login', 'server', 'principal', 'calendar', 'address-book', 'profile'])
        clientTemplateSlot(row, 'login').textContent = principal.login
        clientTemplateSlot(row, 'server').textContent = principal.server ?? none
        clientTemplateSlot(row, 'principal').textContent = principal.principal ?? none
        clientTemplateSlot(row, 'calendar').textContent = principal.calendar ?? none
        clientTemplateSlot(row, 'address-book').textContent = principal.addressBook ?? none
        const profile = clientTemplateSlot(row, 'profile') as HTMLAnchorElement
        if (principal.profile) profile.href = principal.profile
        else profile.remove()
        rows.append(row)
      }
      const served = view.principals.some(principal => principal.server !== null)
      unsecured.textContent = served ? unsecuredNote(view.unsecuredDomains) : t('No domain of this account has an installed certificate, so devices cannot connect yet.')
      unsecured.hidden = served && !view.unsecuredDomains.length
    }
    async function refresh(): Promise<void> {
      if (!eligible() || !send || refreshButton.disabled) return
      refreshButton.disabled = true; say(status, 'reading', t('Reading device connection details…'))
      try {
        const raw = await send('GET', mailbox ? '/api/webmail/dav-config' : '/api/account/calendars-contacts/connection')
        paint(mailbox ? readMailDavClientView(raw, mailbox) : readDavClientView(raw, accountId))
        say(status, 'read', t('Device connection details read.'))
      } catch { say(status, 'failed', t('Device connection details could not be read. Nothing was changed.')) }
      finally { refreshButton.disabled = false }
    }
    if (!send || !eligible()) { refreshButton.disabled = true; say(status, 'unavailable', t('Device sync is not available on this server yet. Nothing was read.')); return }
    refreshButton.addEventListener('click', () => { void refresh() })
    void refresh()
  })
}

export const ACCOUNT_DAV_CLIENT_BINDING = `(()=>{const webDiskSettingsText=${webDiskSettingsText.toString()};${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const DAV_ACCOUNT_ID=${DAV_ACCOUNT_ID.toString()};const DAV_DOMAIN=${DAV_DOMAIN.toString()};const DAV_LOCAL_PART=${DAV_LOCAL_PART.toString()};const DAV_DIRECTORY=${DAV_DIRECTORY.toString()};const DAV_MIN_PASSWORD=${DAV_MIN_PASSWORD};const DAV_PROFILE=${DAV_PROFILE.toString()};${davObject.toString()};${davLogin.toString()};${davHttps.toString()};${davDomains.toString()};${davAddresses.toString()};${davPrincipal.toString()};${readWebDiskClientView.toString()};${readDavClientView.toString()};${readMailDavClientView.toString()};${davOutcomeUncertain.toString()};${davBlocked.toString()};return ${bindAccountDav.toString()}})()`
