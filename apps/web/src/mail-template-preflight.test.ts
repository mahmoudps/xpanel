/// <reference lib="dom" />
import { createRequire } from 'node:module'
import { TextDecoder, TextEncoder } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msgctxt, msgid } from '@xpanel/core'
import { translator } from './i18n.ts'
import { classicMailClientTemplates } from './board-port/mail-client-templates.ts'
import { v2MailClientTemplates } from './themes/v2/pages/xmail/client-templates.ts'
import { accountMailingListClientTemplates as classicAccountTemplates } from './board-port/account-routing-client-templates.ts'
import { accountMailingListClientTemplates as v2AccountTemplates } from './themes/v2/pages/xpanel/email-tools/routing-client-templates.ts'
import { renderMailAttachments } from './board-port/xmail-attachments.ts'
import { renderMailContactsTools } from './board-port/xmail-contacts-tools.ts'
import { renderMailIdentitiesWorkspace } from './board-port/xmail-identities.ts'
import { renderMailForwarders } from './board-port/xmail-mailbox-forwarders.ts'
import { renderMailMailingLists } from './board-port/xmail-mailing-lists.ts'
import { renderMailCalendarWorkspace } from './board-port/xmail-calendar.ts'
import { renderMailContactsWorkspace } from './board-port/xmail-contacts.ts'
import { renderMailFolders } from './board-port/xmail-folders.ts'
import { renderMailSearchWorkspace } from './board-port/xmail-search.ts'
import { renderMailTrackDelivery } from './board-port/xmail-track-delivery.ts'
import { renderXmailInbox, xmailInboxFromProps } from './board-port/xmail-inbox.ts'
import { renderAccountMailingLists } from './board-port/extensions/account-mailing-lists.ts'
import { MAIL_ATTACHMENTS_CLIENT_BINDING } from './mail-attachments-client.ts'
import { MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING, readComposeAttachmentPayload } from './mail-compose-attachments-client.ts'
import { MAIL_CONTACTS_TOOLS_CLIENT_BINDING } from './mail-contacts-tools-client.ts'
import { MAIL_IDENTITIES_CLIENT_BINDING } from './mail-identities-client.ts'
import { MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING } from './mail-mailbox-forwarders-client.ts'
import { MAIL_MAILING_LISTS_CLIENT_BINDING } from './mail-mailing-lists-client.ts'
import { MAIL_CALENDAR_CLIENT_BINDING } from './mail-calendar-client.ts'
import { MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING } from './mail-contacts-workspace-client.ts'
import { MAIL_FOLDERS_CLIENT_BINDING } from './mail-folders-client.ts'
import { MAIL_SEARCH_CLIENT_BINDING } from './mail-search-client.ts'
import { MAIL_TRACK_DELIVERY_CLIENT_BINDING } from './mail-track-delivery-client.ts'
import { MAIL_FOLDER_WORKSPACE_CLIENT_BINDING } from './mail-folder-workspace-client.ts'
import { ACCOUNT_MAILING_LISTS_CLIENT_BINDING } from './account-mailing-lists-client.ts'

type TestDom = { window: Window & typeof globalThis }
type Slot = { template: string; name: string; type?: 'button' | 'checkbox' }
type Subject = { name: string; root: string; kind: string; html: () => string; binding: string; slots: readonly Slot[]; compose?: boolean; activate?: (document: Document, window: TestDom['window']) => void }
const harnessRequire = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = harnessRequire('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const doms: TestDom[] = []
const mailbox = 'owner@example.test'
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const slot = (template: string, name: string, type?: Slot['type']): Slot => ({ template, name, ...(type ? { type } : {}) })
const subjects: readonly Subject[] = [
  { name: 'attachment manifest', root: '[data-mail-attachments]', kind: 'attachments', binding: MAIL_ATTACHMENTS_CLIENT_BINDING,
    html: () => renderMailAttachments({ lang: 'en', mailbox, folder: 'INBOX', uid: 17, canRead: true }),
    slots: ['link', 'name', 'size'].map(name => slot('mail-attachment-row', name)) },
  { name: 'compose attachment bytes', root: '[data-compose-attachments]', kind: 'compose-attachments', binding: MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING, compose: true,
    html: () => '<section data-compose-form="true" data-compose-identities data-compose-mailbox="owner@example.test"><section data-compose-attachments data-compose-attachment-enabled="true"><span data-compose-attachment-summary>0 files</span><button type="button" data-compose-attachment-open>Attach</button><input hidden type="file" multiple data-compose-attachment-input><ul data-compose-attachment-list></ul><div role="status" data-compose-attachment-status></div></section><button type="button" data-mail-send data-mail-send-busy="false">Send</button></section>',
    slots: [slot('mail-compose-attachment-row', 'name'), slot('mail-compose-attachment-row', 'size'), slot('mail-compose-attachment-row', 'remove', 'button'), slot('mail-compose-attachment-dismiss', 'label', 'button')] },
  { name: 'contact sharing', root: '[data-mail-contacts-tools]', kind: 'contact-tools', binding: MAIL_CONTACTS_TOOLS_CLIENT_BINDING,
    html: () => renderMailContactsTools({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-contact-share', 'address'), slot('mail-contact-share', 'remove', 'button')] },
  { name: 'identities', root: '[data-mail-identities]', kind: 'identities', binding: MAIL_IDENTITIES_CLIENT_BINDING,
    html: () => renderMailIdentitiesWorkspace({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-identity-card', 'facts'), slot('mail-identity-fact', 'label'), slot('mail-identity-fact', 'value'), slot('mail-identity-action', 'label', 'button')] },
  { name: 'mailbox forwarders', root: '[data-mail-forwarders]', kind: 'forwarders', binding: MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING,
    html: () => renderMailForwarders({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-forwarder-row', 'address'), slot('mail-forwarder-row', 'remove', 'button')] },
  { name: 'mailing-list memberships', root: '[data-mail-mailing-lists]', kind: 'mailing-lists', binding: MAIL_MAILING_LISTS_CLIENT_BINDING,
    html: () => renderMailMailingLists({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-membership-row', 'action', 'button')] },
  { name: 'calendar sharing', root: '[data-mail-calendar]', kind: 'calendar-settings', binding: MAIL_CALENDAR_CLIENT_BINDING,
    html: () => renderMailCalendarWorkspace({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-calendar-share', 'address'), slot('mail-calendar-share', 'remove', 'button')] },
  { name: 'contacts workspace', root: '[data-mail-contacts]', kind: 'contacts', binding: MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING,
    html: () => renderMailContactsWorkspace({ locale: 'en', mailbox, canManage: true }),
    slots: [slot('mail-contact-row', 'select', 'button'), slot('mail-contact-row', 'email')] },
  { name: 'folder administration', root: '[data-mail-folders]', kind: 'folders', binding: MAIL_FOLDERS_CLIENT_BINDING,
    html: () => renderMailFolders({ locale: 'en', mailbox, canManage: true }),
    slots: ['name', 'messages', 'unseen'].map(name => slot('mail-folder-admin-row', name)).concat([slot('mail-folder-admin-row', 'subscription', 'checkbox'), slot('mail-folder-admin-action', 'label', 'button')]) },
  { name: 'mail search', root: '[data-mail-search-workspace]', kind: 'search', binding: MAIL_SEARCH_CLIENT_BINDING,
    html: () => renderMailSearchWorkspace({ locale: 'en', mailbox, available: true }),
    slots: [slot('mail-search-row', 'open', 'button'), ...['subject', 'sender', 'date'].map(name => slot('mail-search-row', name))],
    activate(document, window) { const input = document.querySelector<HTMLInputElement>('[data-mail-search-query]')!; input.value = 'needle'; input.dispatchEvent(new window.Event('input', { bubbles: true })); document.querySelector('form[data-mail-search-form]')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) } },
  { name: 'delivery tracking', root: '[data-mail-track-delivery]', kind: 'track', binding: MAIL_TRACK_DELIVERY_CLIENT_BINDING,
    html: () => renderMailTrackDelivery({ locale: 'en', mailbox, canRead: true }),
    slots: [slot('mail-track-row', 'time'), slot('mail-track-row', 'dsn'), slot('mail-track-row', 'view', 'button')] },
  { name: 'message folder workspace', root: '[data-mail-folder-workspace]', kind: 'folder-workspace', binding: MAIL_FOLDER_WORKSPACE_CLIENT_BINDING,
    html: () => renderXmailInbox(xmailInboxFromProps({ locale: 'en', mailbox, activeFolder: 'INBOX', folderWorkspace: true, messages: [] })),
    slots: [slot('mail-folder-attachment-info', 'button', 'button'), slot('mail-folder-attachment-info', 'name'), slot('mail-folder-attachment-info', 'size'), slot('mail-folder-move-choice', 'label', 'button')] },
  { name: 'account mailing lists', root: '[data-mailing-lists]', kind: 'account-mailing-lists', binding: ACCOUNT_MAILING_LISTS_CLIENT_BINDING,
    html: () => renderAccountMailingLists({ lang: 'en', expectedAccountId: accountId, canManage: true, domains: ['acct.example.test'] }),
    slots: [slot('account-mailing-list-row', 'remove', 'button')] },
]
function fragments(subject: Subject, theme: 'classic' | 'v2'): string {
  if (subject.kind === 'account-mailing-lists') return theme === 'v2' ? v2AccountTemplates() : classicAccountTemplates()
  return (theme === 'v2' ? v2MailClientTemplates : classicMailClientTemplates)(subject.kind)
}
function template(root: HTMLElement, name: string): HTMLTemplateElement {
  const result = root.querySelector<HTMLTemplateElement>(`template[data-xp-template="${name}"]`)
  if (!result) throw new Error('Missing real factory template: ' + name)
  return result
}
function element(root: HTMLElement, requirement: Slot): Element {
  const source = template(root, requirement.template)
  const selector = `[data-xp-slot="${requirement.name}"]`
  const node = source.content.firstElementChild?.matches(selector) ? source.content.firstElementChild : source.content.querySelector(selector)
  if (!node) throw new Error('Missing real factory slot: ' + requirement.name)
  return node
}
function replaceTag(document: Document, previous: Element, tag: string): void {
  const next = document.createElement(tag)
  for (const attribute of previous.attributes) next.setAttribute(attribute.name, attribute.value)
  next.append(...Array.from(previous.childNodes)); previous.replaceWith(next)
}
function mount(subject: Subject, theme: 'classic' | 'v2', mutate?: (document: Document, root: HTMLElement) => void) {
  // The admitted SSR frame stays fixed; the fragments under test are the real selected-theme factories.
  const dom = new JSDOM(subject.html(), { url: 'https://mail.example.test/mail/inbox', runScripts: 'outside-only' }); doms.push(dom)
  const document = dom.window.document, root = document.querySelector<HTMLElement>(subject.root)
  if (!root) throw new Error('Missing admitted workspace: ' + subject.name)
  const holder = document.createElement('template'); holder.innerHTML = fragments(subject, theme)
  for (const replacement of holder.content.querySelectorAll<HTMLTemplateElement>('template[data-xp-template]')) {
    const name = replacement.getAttribute('data-xp-template')!
    const old = root.querySelector(`template[data-xp-template="${name}"]`)
    if (old) old.replaceWith(replacement.cloneNode(true)); else root.append(replacement.cloneNode(true))
  }
  mutate?.(document, root)
  const send = vi.fn((_method: string, _path: string, _body?: unknown) => new Promise<unknown>(() => {}))
  Object.assign(dom.window, { msgid, msgctxt, TextDecoder, TextEncoder, xpT: translator('en'), xpanelSessionRequest: send })
  dom.window.Function('return ' + subject.binding)()(async () => true, false)
  const bytes = new dom.window.Uint8Array([0, 255, 128, 13, 10])
  const file = new dom.window.File([bytes], 'actual.bin', { type: 'application/octet-stream' })
  const readBytes = vi.fn(async () => bytes.slice().buffer)
  Object.defineProperty(file, 'arrayBuffer', { value: readBytes, configurable: true })
  function activate(): void {
    if (subject.compose) {
      const input = root!.querySelector<HTMLInputElement>('[data-compose-attachment-input]')!
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    } else subject.activate?.(document, dom.window)
  }
  return { document, window: dom.window, root, send, readBytes, activate }
}
async function expectNoAdmission(subject: Subject, theme: 'classic' | 'v2', mutate: (document: Document, root: HTMLElement) => void): Promise<void> {
  const mounted = mount(subject, theme, mutate)
  mounted.activate(); await tick()
  expect(mounted.send).not.toHaveBeenCalled(); expect(mounted.readBytes).not.toHaveBeenCalled()
  if (subject.compose) {
    const group = mounted.root.closest<HTMLElement>('[data-compose-form]')!
    expect(() => readComposeAttachmentPayload(group)).toThrow('ATTACHMENTS_UNBOUND')
    expect(mounted.root.querySelector<HTMLInputElement>('[data-compose-attachment-input]')!.disabled).toBe(true)
    expect(mounted.root.querySelector<HTMLButtonElement>('[data-compose-attachment-open]')!.disabled).toBe(true)
  } else expect(mounted.root.querySelector('[data-state="unavailable"]')).not.toBeNull()
}
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close() })

describe.each(['classic', 'v2'] as const)('%s actual emitted mailbox preflight', theme => {
  for (const subject of subjects) describe(subject.name, () => {
    it('admits the unmodified real fragments before requests or selected-file bytes', async () => {
      const mounted = mount(subject, theme); mounted.activate(); await tick()
      if (subject.compose) {
        expect(mounted.readBytes).toHaveBeenCalledTimes(1); expect(mounted.send).not.toHaveBeenCalled()
        const group = mounted.root.closest<HTMLElement>('[data-compose-form]')!
        expect(readComposeAttachmentPayload(group)).toEqual([{ filename: 'actual.bin', contentType: 'application/octet-stream', contentBase64: 'AP+ADQo=' }])
      }
      else { expect(mounted.send).toHaveBeenCalled(); expect(mounted.send.mock.calls.every(call => call[0] === 'GET')).toBe(true) }
    })
    it.each(['missing', 'duplicate', 'wrong root', 'missing slot', 'duplicate slot'] as const)('rejects %s before any request or byte read', async disposition => {
      await expectNoAdmission(subject, theme, (document, root) => {
        const first = subject.slots[0]!, source = template(root, first.template)
        if (disposition === 'missing') source.remove()
        else if (disposition === 'duplicate') root.append(source.cloneNode(true))
        else if (disposition === 'wrong root') replaceTag(document, source.content.firstElementChild!, 'div')
        else if (disposition === 'missing slot') element(root, first).remove()
        else { const slot = element(root, first); slot.after(slot.cloneNode(true)) }
      })
    })
    it.each(subject.slots.map(requirement => [requirement.template, requirement.name, requirement] as const))('rejects wrong native tag at %s/%s before any request or byte read', async (_template, _name, requirement) => {
      await expectNoAdmission(subject, theme, (document, root) => replaceTag(document, element(root, requirement), 'span'))
    })
    const controlCases = subject.slots.filter(requirement => requirement.type).flatMap(requirement => (['missing', 'wrong'] as const).map(disposition => [requirement.template, requirement.name, disposition, requirement] as const))
    if (controlCases.length) it.each(controlCases)('rejects %s/%s %s native control type before any request or byte read', async (_template, _name, disposition, requirement) => {
      await expectNoAdmission(subject, theme, (_document, root) => {
        if (disposition === 'missing') element(root, requirement).removeAttribute('type')
        else element(root, requirement).setAttribute('type', requirement.type === 'checkbox' ? 'text' : 'submit')
      })
    })
  })
})