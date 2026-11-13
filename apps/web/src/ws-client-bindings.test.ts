/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH } from '@xpanel/core'
import { renderMailAttachments } from './board-port/xmail-attachments.ts'
import { classicMailClientTemplates } from './board-port/mail-client-templates.ts'
import { accountApiTokenClientTemplates } from './account-api-tokens-templates.ts'

type Listener = [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
let documentListeners: Listener[], windowListeners: Listener[]
let send: ReturnType<typeof vi.fn>
const mailbox = 'reader@example.test'
const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const attachment = (owner = mailbox) => renderMailAttachments({ lang: 'en', mailbox: owner, canRead: true })
const fixture = (body = attachment()) => `<section data-mail-search-workspace data-search-mailbox="${mailbox}" data-search-enabled="true"><article data-mail-search-message>${body}</article></section>`
const article = () => document.querySelector<HTMLElement>('[data-mail-search-message]')!
const selected = () => article().querySelector<HTMLElement>('[data-mail-attachments]')!
const selection = (detail: unknown, source: Element = article()) => source.dispatchEvent(new CustomEvent('xpanel:mail-search-selection', { detail, bubbles: true }))
const detail = { mailbox, folder: 'INBOX', uid: 23, uidValidity: 56 }
const inboxFixture = (content = attachment()) => '<section data-board-port="xmail-inbox" data-product="true" data-mailbox="reader@example.test" data-mail-folder="INBOX"><article data-mail-pane="reading-pane" data-mail-article="true">' + content + '</article><button data-summary-row>Summary</button></section>'
const reading = () => document.querySelector<HTMLElement>('[data-mail-article="true"]')!
const readSelection = (value: unknown, source: Element = reading()) => source.dispatchEvent(new CustomEvent('xpanel:mail-message-read', { detail: value, bubbles: true }))
const runRealtimeScript = new Function('window', 'document', BROWSER_REALTIME_SCRIPT) as (w: Window & typeof globalThis, d: Document) => void
const boot = () => runRealtimeScript(window, document)
const observeWindowErrors = (): ErrorEvent[] => {
  const errors: ErrorEvent[] = []
  window.addEventListener('error', event => { errors.push(event) })
  return errors
}

// The actual neutral prototypes exercise the exported, serialized binding, not a parallel template parser.
const ownerTokens = (state = 'ready', canRead = true, canManage = true): string => {
  const scopes = ['files', 'databases', 'dns', 'mail', 'backups', 'cron'].flatMap(resource => ['read', 'write'].map(mode =>
    '<input type="checkbox" data-account-tokens-scope value="' + resource + ':' + mode + '" disabled>')).join('')
  return '<section data-account-api-tokens data-auth-personal-state="' + state + '" data-tokens-can-read="' + canRead + '" data-tokens-can-manage="' + canManage + '">'
    + accountApiTokenClientTemplates({ buttonClass: '', badgeClass: '' })
    + '<p data-account-tokens-status></p><p data-account-tokens-loading hidden></p><p data-account-tokens-empty hidden></p>'
    + '<button type="button" data-account-tokens-refresh disabled>Refresh</button><button type="button" data-account-tokens-bulk-revoke disabled>Revoke</button>'
    + '<table><thead><tr><th><input type="checkbox" data-account-tokens-select-all disabled></th></tr></thead><tbody data-account-tokens-rows></tbody></table>'
    + '<form method="post" action="/api/auth/api-tokens" data-account-tokens-create><input type="text" data-account-tokens-name disabled>'
    + '<select data-account-tokens-expiry disabled><option value="30">30</option><option value="90" selected>90</option><option value="180">180</option><option value="365">365</option></select>'
    + '<input type="text" data-account-tokens-allowed-ips disabled><input type="checkbox" data-account-tokens-read-only disabled>' + scopes
    + '<button type="submit" data-account-tokens-submit disabled>Create</button><button type="button" data-account-tokens-clear disabled>Clear</button><p data-account-tokens-mutation-status></p></form>'
    + '<div data-account-tokens-reveal hidden><p data-account-tokens-reveal-text></p><code data-account-tokens-secret></code>'
    + '<button type="button" data-account-tokens-copy disabled>Copy</button><button type="button" data-account-tokens-done disabled>Done</button><p data-account-tokens-copy-status></p></div></section>'
}


beforeEach(() => {
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  document.documentElement.dataset.realtimeEnabled = 'false'
  delete document.documentElement.dataset.mailSearchAttachmentsBound
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  send = vi.fn(async () => { throw { status: 403 } })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  documentListeners = []; windowListeners = []
  const addDocument = document.addEventListener.bind(document), addWindow = window.addEventListener.bind(window)
  vi.spyOn(document, 'addEventListener').mockImplementation((name, listener, options) => { documentListeners.push([name, listener, options]); addDocument(name, listener, options) })
  vi.spyOn(window, 'addEventListener').mockImplementation((name, listener, options) => { windowListeners.push([name, listener, options]); addWindow(name, listener, options) })
})
afterEach(() => {
  for (const [name, listener, options] of documentListeners) document.removeEventListener(name, listener, options)
  for (const [name, listener, options] of windowListeners) window.removeEventListener(name, listener, options)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren()
  delete document.documentElement.dataset.mailSearchAttachmentsBound
  delete document.documentElement.dataset.realtimeEnabled
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})

describe('integrated worker client mounts', () => {
  it('emits executable browser syntax and mounts each stable workspace without reading absent pages', () => {
    expect(() => new Script(BROWSER_REALTIME_SCRIPT)).not.toThrow()
    const scan = vi.spyOn(document, 'querySelectorAll')
    boot()
    const selectors = scan.mock.calls.map(([selector]) => selector)
    for (const selector of ['[data-account-password]', '[data-account-api-tokens]', '[data-account-backup]', '[data-account-cron]', '[data-htaccess-workspace]', '[data-account-quarantine]', '[data-mail-contact-groups]', '[data-mail-search-workspace]', '[data-mail-attachments]', '[data-mail-calendar]', '[data-compose-identities]', '[data-whm-domains-workspace]', '[data-default-site-workspace]', '[data-approved-whm-backups]', '[data-whm-ssl]', '[data-whm-security-evidence]', '[data-whm-detail-route="/whm/security/ssh"]', '[data-whm-php-workspace]', '[data-whm-web-readback]', '[data-transfer-workspace]']) expect(selectors).toContain(selector)
    expect(send).not.toHaveBeenCalled()
  })

  it('passes Arabic locale before bindings run and installs one global selection listener', () => {
    document.documentElement.lang = 'ar'; document.body.innerHTML = fixture()
    boot(); boot()
    expect(selected().querySelector('[data-attachment-status]')!.textContent).toBe('اختر رسالة لقراءة مرفقاتها.')
    expect(documentListeners.filter(([name]) => name === 'xpanel:mail-search-selection')).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('updates the selected message root and lets its existing observer perform one scoped read', async () => {
    document.body.innerHTML = fixture(attachment() + attachment('foreign@example.test')) + fixture(attachment())
    boot(); selection(detail); await tick()
    expect(selected().dataset).toMatchObject({ mailbox, folder: 'INBOX', uid: '23', uidValidity: '56' })
    const roots = document.querySelectorAll<HTMLElement>('[data-mail-attachments]')
    expect(roots[1]!.dataset.uid).toBe(''); expect(roots[2]!.dataset.uid).toBe('')
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/attachment-workspace?uid=23&folder=INBOX&uidValidity=56')
    selection(detail); await tick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('mounts a newly inserted same-mailbox attachment root after a verified selection', async () => {
    document.body.innerHTML = fixture(''); boot()
    article().innerHTML = attachment()
    selection({ ...detail, folder: 'Archive', uid: 4294967295, uidValidity: 4294967295 }); await tick()
    expect(selected().dataset.attachmentsBound).toBe('true')
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/attachment-workspace?uid=4294967295&folder=Archive&uidValidity=4294967295')
  })

  it('mounts compose file controls with the real locale and preserves unavailable capability', () => {
    document.documentElement.lang = 'ar'
    document.body.innerHTML = '<div data-compose-form="true" data-compose-mailbox="reader@example.test"><section data-compose-attachments data-compose-attachment-enabled="false"><button type="button" data-compose-attachment-open disabled>Attach</button><input type="file" data-compose-attachment-input disabled><ul data-compose-attachment-list></ul><p data-compose-attachment-status></p></section></div>'
    const attachments = document.querySelector<HTMLElement>('[data-compose-attachments]')
    if (!attachments) throw new Error('missing_compose_fixture')
    attachments.insertAdjacentHTML('beforeend', classicMailClientTemplates('compose-attachments'))
    boot()
    const group = document.querySelector<HTMLElement>('[data-compose-form]')!, root = group.querySelector<HTMLElement>('[data-compose-attachments]')!
    expect(root.dataset.composeAttachmentsBound).toBe('true')
    expect(root.dataset.composeAttachmentState).toBe('unavailable')
    expect(root.querySelector('[data-compose-attachment-status]')!.textContent).toBe('المرفقات غير متاحة هنا.')
    expect(root.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('input')!.disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('mounts Draft with the Arabic flag while trusted draft/send capabilities remain unavailable', () => {
    document.documentElement.lang = 'ar'
    document.body.innerHTML = '<div data-compose-form="true" data-compose-identities data-compose-mailbox="reader@example.test" data-compose-draft-enabled="false" data-compose-send-enabled="false"><button type="button" data-mail-action="save-draft" disabled>Save draft</button><p data-mail-draft-status></p><button type="button" data-mail-send="true" disabled>Send</button></div>'
    boot()
    const root = document.querySelector<HTMLElement>('[data-compose-identities]')!
    expect(root.dataset.composeDraftBound).toBe('true')
    expect(root.querySelector('[data-mail-draft-status]')!.textContent).toBe('حفظ المسودات في الصندوق غير متاح هنا. احتُفظ بالمحرر.')
    expect(root.querySelector<HTMLButtonElement>('[data-mail-action="save-draft"]')!.disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('[data-mail-send]')!.disabled).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('routes only a verified observed Inbox read to its current attachment root once', async () => {
    document.body.innerHTML = inboxFixture(); boot(); boot()
    readSelection({ ...detail, uidValidityObserved: true }); await tick()
    const root = reading().querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(root.dataset).toMatchObject({ mailbox, uid: '23', uidValidity: '56', folder: 'INBOX' })
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/attachment-workspace?uid=23&folder=INBOX&uidValidity=56')
    expect(documentListeners.filter(([name]) => name === 'xpanel:mail-message-read')).toHaveLength(1)
    readSelection({ ...detail, uidValidityObserved: true }); await tick(); expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses unobserved, wrong-envelope and summary-only Inbox contexts without a default UIDVALIDITY', async () => {
    document.body.innerHTML = inboxFixture(); boot()
    for (const value of [detail, { ...detail, uidValidityObserved: false }, { ...detail, uidValidityObserved: 'true' }, { ...detail, uidValidityObserved: true, uidValidity: 0 }, { ...detail, uidValidityObserved: true, uid: '23' }, { ...detail, uidValidityObserved: true, mailbox: 'foreign@example.test' }, { ...detail, uidValidityObserved: true, folder: 'Sent' }]) readSelection(value)
    readSelection({ ...detail, uidValidityObserved: true }, document.querySelector('[data-summary-row]')!)
    reading().closest<HTMLElement>('[data-board-port]')!.dataset.product = 'false'; readSelection({ ...detail, uidValidityObserved: true })
    await tick(); const root = reading().querySelector<HTMLElement>('[data-mail-attachments]')!
    expect(root.dataset.uid).toBe(''); expect(root.dataset.uidValidity).toBe(''); expect(send).not.toHaveBeenCalled()
  })

  it('mounts the newly installed reading widget only after the verified Inbox event', async () => {
    document.body.innerHTML = inboxFixture(''); boot(); reading().innerHTML = attachment()
    expect(send).not.toHaveBeenCalled(); readSelection({ ...detail, uidValidityObserved: true }); await tick()
    expect(reading().querySelector<HTMLElement>('[data-mail-attachments]')!.dataset.attachmentsBound).toBe('true')
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/attachment-workspace?uid=23&folder=INBOX&uidValidity=56')
  })

  it('does not let a read captured in an old folder retarget the current folder widget', async () => {
    document.body.innerHTML = inboxFixture(); boot()
    const workspace = reading().closest<HTMLElement>('[data-board-port]')!; workspace.dataset.mailFolder = 'Sent'
    readSelection({ ...detail, uidValidityObserved: true }); await tick(); expect(send).not.toHaveBeenCalled()
    readSelection({ ...detail, folder: 'Sent', uid: 24, uidValidityObserved: true }); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/attachment-workspace?uid=24&folder=Sent&uidValidity=56')
  })

  it('refuses foreign, malformed, disabled and non-article selection contexts without reads', async () => {
    document.body.innerHTML = fixture(); boot()
    for (const value of [{ ...detail, mailbox: 'foreign@example.test' }, { ...detail, uid: '23' }, { ...detail, uid: 0 }, { ...detail, uid: 1.5 }, { ...detail, uidValidity: 4294967296 }, { ...detail, folder: '../INBOX' }, { ...detail, folder: 'INBOX' + String.fromCharCode(10) }, null, {}]) selection(value)
    selection(detail, selected())
    article().closest<HTMLElement>('[data-mail-search-workspace]')!.dataset.searchEnabled = 'false'; selection(detail)
    await tick()
    expect(selected().dataset.uid).toBe(''); expect(selected().dataset.uidValidity).toBe('')
    expect(send).not.toHaveBeenCalled()
  })
})


describe('integrated personal token binding', () => {
  it('reads the current owner list once through the complete serialized asset while management stays denied', async () => {
    send.mockResolvedValue({ tokens: [], usageRecorded: true })
    document.body.innerHTML = ownerTokens('ready', true, false)
    boot(); boot(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('GET', '/api/auth/api-tokens', undefined)
    const root = document.querySelector<HTMLElement>('[data-account-api-tokens]')
    if (!root) throw new Error('missing owner token fixture')
    expect(root.dataset.accountTokensBound).toBe('true')
    expect(root.querySelector<HTMLElement>('[data-account-tokens-status]')?.dataset.state).toBe('read')
    expect(root.querySelector('[data-account-tokens-rows] td[colspan="7"]')?.textContent).toBe('No API tokens yet')
    expect(root.querySelector<HTMLButtonElement>('[data-account-tokens-refresh]')?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('[data-account-tokens-submit]')?.disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('[data-account-tokens-name]')?.disabled).toBe(true)
    expect(root.querySelector<HTMLElement>('[data-account-tokens-secret]')?.textContent).toBe('')
  })

  it.each([
    { state: 'denied', canRead: true, ancestor: false },
    { state: 'unavailable', canRead: false, ancestor: false },
    { state: 'ready', canRead: false, ancestor: false },
    { state: 'ready', canRead: true, ancestor: true },
  ])('does not read a $state token root with read=$canRead and denied ancestor=$ancestor', async ({ state, canRead, ancestor }) => {
    const html = ownerTokens(state, canRead, true)
    document.body.innerHTML = ancestor ? '<div data-readonly="true">' + html + '</div>' : html
    boot(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLButtonElement>('[data-account-tokens-refresh]')?.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-account-tokens-submit]')?.disabled).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-account-tokens-secret]')?.textContent).toBe('')
  })

  it('fails before the first request when a canonical owner token prototype is absent', async () => {
    document.body.innerHTML = ownerTokens()
    const template = document.querySelector('template[data-xp-template="account-token-row"]')
    if (!template) throw new Error('missing owner token prototype fixture')
    template.remove(); boot(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLElement>('[data-account-tokens-status]')?.dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-account-tokens-submit]')?.disabled).toBe(true)
  })
})


const ownerPassword = (canChange = true): string => '<section data-account-password data-account-password-can-change="' + canChange + '">'
  + '<form method="post" action="/api/auth/change-password" data-account-password-form><input type="password" name="currentPassword" required autocomplete="current-password">'
  + '<input type="password" name="newPassword" required autocomplete="new-password" minlength="' + ACCOUNT_SELF_PASSWORD_MIN_LENGTH + '">'
  + '<input type="password" name="confirmPassword" required autocomplete="new-password" minlength="' + ACCOUNT_SELF_PASSWORD_MIN_LENGTH + '">'
  + '<button type="submit" data-account-password-submit disabled>Change</button></form><p data-account-password-status></p></section>'

describe('integrated personal password binding', () => {
  it('mounts once after the session transport and uses only the canonical self-password endpoint', async () => {
    const errors = observeWindowErrors()
    send.mockRejectedValue({ status: 403, code: 'FORBIDDEN', details: { stateChanged: false } })
    document.body.innerHTML = ownerPassword()
    boot(); boot()
    const root = document.querySelector<HTMLElement>('[data-account-password]')
    const form = root?.querySelector<HTMLFormElement>('[data-account-password-form]')
    const current = form?.querySelector<HTMLInputElement>('[name="currentPassword"]')
    const next = form?.querySelector<HTMLInputElement>('[name="newPassword"]')
    const confirm = form?.querySelector<HTMLInputElement>('[name="confirmPassword"]')
    if (!root || !form || !current || !next || !confirm) throw new Error('missing integrated Password fixture')
    expect(root.dataset.accountPasswordBound).toBe('true')
    expect(current.disabled).toBe(false)
    expect(next.minLength).toBe(ACCOUNT_SELF_PASSWORD_MIN_LENGTH)
    current.value = 'synthetic-current'; next.value = confirm.value = 'synthetic-replacement'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/auth/change-password', { currentPassword: 'synthetic-current', newPassword: 'synthetic-replacement' })
    expect(root.dataset.accountPasswordState).toBe('failed')
    expect([current.value, next.value, confirm.value]).toEqual(['', '', ''])
    expect(errors).toEqual([])
  })

  it('mounts a denied Password root without issuing a request or enabling its controls', async () => {
    const errors = observeWindowErrors()
    document.body.innerHTML = ownerPassword(false)
    boot()
    const form = document.querySelector<HTMLFormElement>('[data-account-password-form]')
    if (!form) throw new Error('missing denied integrated Password fixture')
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick()
    expect(send).not.toHaveBeenCalled()
    expect([...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(control => control.disabled)).toBe(true)
    expect(errors).toEqual([])
  })

  it('keeps the administrative account-id password reset on its separate endpoint', async () => {
    const errors = observeWindowErrors()
    const accountId = '11111111-1111-4111-8111-111111111111'
    document.body.innerHTML = '<form data-account-password-form="true" data-account-id="' + accountId + '">'
      + '<input name="password" type="password" minlength="8" required autocomplete="new-password">'
      + '<p data-account-password-status role="status" hidden></p><button type="submit">Change password</button></form>'
    boot()
    const form = document.querySelector<HTMLFormElement>('[data-account-password-form][data-account-id]')
    const password = form?.querySelector<HTMLInputElement>('[name="password"]')
    if (!form || !password) throw new Error('missing administrative Password fixture')
    password.value = 'synthetic-admin-replacement'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/accounts/' + accountId + '/password', { password: 'synthetic-admin-replacement' })
    expect(password.value).toBe('')
    expect(errors).toEqual([])
  })
})
