/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderMailAttachments } from './board-port/xmail-attachments.ts'

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
const boot = () => new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)

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
    for (const selector of ['[data-account-backup]', '[data-account-cron]', '[data-htaccess-workspace]', '[data-account-quarantine]', '[data-mail-contact-groups]', '[data-mail-search-workspace]', '[data-mail-attachments]', '[data-mail-calendar]', '[data-compose-identities]', '[data-whm-domains-workspace]', '[data-default-site-workspace]', '[data-approved-whm-backups]', '[data-whm-ssl]', '[data-whm-security-evidence]', '[data-whm-detail-route="/whm/security/ssh"]', '[data-whm-php-workspace]', '[data-whm-web-readback]', '[data-transfer-workspace]']) expect(selectors).toContain(selector)
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
