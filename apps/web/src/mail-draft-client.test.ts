// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_DRAFT_CLIENT_BINDING } from './mail-draft-client.ts'
import { MAIL_SEND_CLIENT_BINDING, readMailSendPayload, type MailSendPayload } from './mail-send-client.ts'

const mailbox = 'sender@example.test'
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const group = () => document.querySelector<HTMLElement>('[data-compose-identities]')!
const save = () => document.querySelector<HTMLButtonElement>('[data-mail-action="save-draft"]')!
const send = () => document.querySelector<HTMLButtonElement>('[data-mail-send]')!
const body = () => document.getElementById('compose-body')!
const status = () => document.querySelector<HTMLElement>('[data-mail-draft-status]')!
const ack = (uid = 10, previousDraft = 'none') => ({ mailbox, folder: 'Drafts', status: previousDraft === 'review_required' ? 'partial' : 'saved', draft: { uid, uidValidity: 7, revision: 'a'.repeat(64), messageId: '<server-draft@example.test>' }, previousDraft, reviewRequired: previousDraft === 'review_required' })
const boot = (request?: Transport) => {
  if (request) (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest = request
  new Function('return ' + MAIL_DRAFT_CLIENT_BINDING)()()
}
const edit = (text: string) => { body().textContent = text; body().dispatchEvent(new Event('input', { bubbles: true })) }
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = `<section data-compose-identities data-compose-mailbox="${mailbox}" data-compose-identities-state="ready" data-compose-draft-enabled="true"><select id="compose-from"><option value="">${mailbox}</option></select><input id="compose-to" value="recipient@example.test"><input id="compose-cc"><input id="compose-bcc" value="hidden@example.test"><input id="compose-subject" value="Draft subject"><div id="compose-body" contenteditable="true"><p><strong>Original</strong> rich body</p></div><button type="button" data-mail-action="save-draft" disabled>Save draft</button><p data-mail-draft-status></p><button type="button" data-mail-send="true">Send</button><p id="mail-send-status"></p></section>`
  delete (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
})
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('real native draft client contract', () => {
  it('serializes a standalone binding and never uses direct fetch or HTML assignment', () => {
    expect(() => new Function('return ' + MAIL_DRAFT_CLIENT_BINDING)).not.toThrow()
    expect(MAIL_DRAFT_CLIENT_BINDING).not.toMatch(/\bfetch\s*\(|\.innerHTML\s*=/)
  })
  it('requires real transport and explicit scoped draft capability', async () => {
    boot(); expect(save().disabled).toBe(true); expect(status().dataset.state).toBe('unavailable')
    delete group().dataset.composeDraftBound; group().dataset.composeDraftEnabled = 'false'
    const request = vi.fn(async () => ack()); boot(request); save().dispatchEvent(new Event('click')); await tick()
    expect(request).not.toHaveBeenCalled(); expect(save().disabled).toBe(true)
  })
  it('posts the shared body/envelope once, verifies native identity and keeps the editor', async () => {
    const request = vi.fn(async () => ack()), original = body().querySelector('strong')!
    boot(request); save().click(); await tick()
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/webmail/drafts', { to: 'recipient@example.test', cc: '', bcc: 'hidden@example.test', subject: 'Draft subject', text: 'Original rich body', html: '<p><strong>Original</strong> rich body</p>' })
    expect(body().querySelector('strong')).toBe(original); expect(status().dataset.state).toBe('saved'); expect(save().disabled).toBe(true)
    save().dispatchEvent(new Event('click')); await tick(); expect(request).toHaveBeenCalledTimes(1)
  })
  it('pins the exact server draft reference only when replacing edited content', async () => {
    const request = vi.fn<Transport>().mockResolvedValueOnce(ack()).mockResolvedValueOnce(ack(11, 'retired'))
    boot(request); save().click(); await tick(); edit('New draft version'); expect(save().disabled).toBe(false)
    save().click(); await tick()
    expect(request.mock.calls[1]![2]).toMatchObject({ text: 'New draft version', expectedDraft: { uid: 10, uidValidity: 7, revision: 'a'.repeat(64) } })
    expect(status().dataset.state).toBe('saved'); expect(save().disabled).toBe(true); expect(body().textContent).toBe('New draft version')
  })
  it('preserves edits made while a save is pending and refuses overlapping requests', async () => {
    const pending = deferred(), request = vi.fn(async () => pending.promise)
    boot(request); save().click(); expect(send().disabled).toBe(true); edit('Newer unsaved edits')
    save().dispatchEvent(new Event('click')); expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(ack()); await tick()
    expect(body().textContent).toBe('Newer unsaved edits'); expect(status().textContent).toContain('newer edits'); expect(save().disabled).toBe(false); expect(send().disabled).toBe(false)
  })
  it('waits while Send is in flight and becomes available after that state clears', () => {
    boot(async () => ack()); send().dataset.mailSendBusy = 'true'; send().dispatchEvent(new Event('xpanel:mail-send-state', { bubbles: true })); expect(save().disabled).toBe(true)
    send().dataset.mailSendBusy = 'false'; send().dispatchEvent(new Event('xpanel:mail-send-state', { bubbles: true })); expect(save().disabled).toBe(false)
  })
  it('keeps a definite refusal editable without silently retrying', async () => {
    const request = vi.fn(async () => { throw { status: 403, details: { stateChanged: false } } })
    boot(request); save().click(); await tick()
    expect(status().dataset.state).toBe('failed'); expect(save().disabled).toBe(false); expect(body().textContent).toBe('Original rich body'); expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([
    { status: 409, details: { stateChanged: false, draftConflict: true } },
    { status: 412, details: { stateChanged: false, draftVerificationRequired: true } },
    { details: { stateChanged: true, unknownOutcome: true } }, new Error('Synthetic lost reply'),
  ])('locks stale or uncertain outcomes without clearing or retrying: %j', async failure => {
    const request = vi.fn(async () => { throw failure }); boot(request); save().click(); await tick()
    expect(['stale', 'uncertain']).toContain(status().dataset.state); expect(save().disabled).toBe(true); expect(body().textContent).toBe('Original rich body')
    save().dispatchEvent(new Event('click')); await tick(); expect(request).toHaveBeenCalledTimes(1)
  })
  it.each([
    {}, { ...ack(), mailbox: 'foreign@example.test' }, { ...ack(), folder: 'INBOX' },
    { ...ack(), draft: { ...ack().draft, uid: 0 } }, { ...ack(), draft: { ...ack().draft, revision: 'fabricated' } },
    { ...ack(), status: 'partial', previousDraft: 'review_required', reviewRequired: true },
  ])('requires a scoped complete native save acknowledgement: %j', async reply => {
    const request = vi.fn(async () => reply); boot(request); save().click(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(save().disabled).toBe(true); expect(body().querySelector('strong')).not.toBeNull(); expect(request).toHaveBeenCalledTimes(1)
  })
  it('keeps a verified new copy and locks replacement when prior-copy cleanup needs review', async () => {
    const request = vi.fn<Transport>().mockResolvedValueOnce(ack()).mockResolvedValueOnce(ack(11, 'review_required'))
    boot(request); save().click(); await tick(); edit('Keep this new copy'); save().click(); await tick()
    expect(status().dataset.state).toBe('partial'); expect(save().disabled).toBe(true); expect(body().textContent).toBe('Keep this new copy')
  })
  it('requires selected saved identity revision in the draft acknowledgement', async () => {
    const option = document.querySelector<HTMLOptionElement>('#compose-from option')!
    option.value = option.dataset.identityId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; option.dataset.identityRevision = 'b'.repeat(64)
    boot(async () => ack()); save().click(); await tick(); expect(status().dataset.state).toBe('uncertain'); expect(body().textContent).toBe('Original rich body')
  })
  it('accepts the matching saved identity acknowledgement', async () => {
    const option = document.querySelector<HTMLOptionElement>('#compose-from option')!
    option.value = option.dataset.identityId = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'; option.dataset.identityRevision = 'b'.repeat(64)
    boot(async () => ({ ...ack(), identityId: option.value, identityRevision: option.dataset.identityRevision })); save().click(); await tick()
    expect(status().dataset.state).toBe('saved'); expect(save().disabled).toBe(true)
  })
  it('keeps Send disabled when only draft saving is authorized', async () => {
    group().dataset.composeSendEnabled = 'false'; send().disabled = true; boot(async () => ack())
    save().click(); await tick(); expect(status().dataset.state).toBe('saved'); expect(send().disabled).toBe(true)
  })
  it('uses one real attachment snapshot and includes expectedDraft in request-byte validation', async () => {
    const widget = document.createElement('section'); widget.dataset.composeAttachments = ''; group().appendChild(widget)
    const file = Object.freeze({ filename: 'actual.txt', contentType: 'text/plain', contentBase64: 'YWJj' }), snapshots: MailSendPayload[] = []
    let ready = false
    Object.defineProperty(group(), 'xpanelReadComposeAttachments', { value: (payload: MailSendPayload) => { if (!ready) throw new Error('pending_file_read'); snapshots.push(structuredClone(payload)); return Object.freeze([file]) } })
    const request = vi.fn<Transport>().mockResolvedValueOnce(ack()).mockResolvedValueOnce(ack(11, 'retired'))
    boot(request); expect(save().disabled).toBe(true)
    ready = true; group().dispatchEvent(new Event('xpanel:compose-attachments-state')); expect(save().disabled).toBe(false)
    save().click(); await tick(); edit('With attachments'); save().click(); await tick()
    expect(request.mock.calls[1]![2]).toMatchObject({ attachments: [file], expectedDraft: { uid: 10, uidValidity: 7, revision: 'a'.repeat(64) } })
    expect(snapshots.some(value => value.expectedDraft?.uid === 10)).toBe(true)
  })
  it('keeps text whitespace intact in the shared native payload', () => {
    const input = document.createElement('textarea'); input.id = 'compose-body'; input.value = '  indented\ntrailing  \n'; body().replaceWith(input)
    expect(readMailSendPayload().text).toBe('  indented\ntrailing  \n'); expect(readMailSendPayload().html).toBeUndefined()
  })
})

describe('accepted Send preserves later compose edits', () => {
  it('keeps newer rich nodes, subject and recipients and emits draftCleared=false', async () => {
    const pending = deferred(), request = vi.fn(async () => pending.promise), accepted = vi.fn()
    ;(window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest = request
    group().addEventListener('xpanel:mail-send-accepted', accepted)
    new Function(MAIL_SEND_CLIENT_BINDING)(); send().click()
    const original = body().querySelector('strong')!, newer = document.createElement('em'); newer.textContent = 'Newer text'; body().appendChild(newer)
    const subject = document.getElementById('compose-subject') as HTMLInputElement, to = document.getElementById('compose-to') as HTMLInputElement
    subject.value = 'Newer subject'; to.value = 'newer@example.test'
    pending.resolve({ mailbox, messageId: '<sent@example.test>', savedToSent: true }); await tick()
    expect(body().querySelector('strong')).toBe(original); expect(body().querySelector('em')).toBe(newer); expect(subject.value).toBe('Newer subject'); expect(to.value).toBe('newer@example.test')
    expect(accepted).toHaveBeenCalledTimes(1); expect((accepted.mock.calls[0]![0] as CustomEvent).detail).toEqual({ draftCleared: false })
    expect(document.getElementById('mail-send-status')!.textContent).toContain('newer draft'); expect(request).toHaveBeenCalledTimes(1)
  })
})
