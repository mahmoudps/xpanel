/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Script } from 'node:vm'
import { MAIL_SEND_CLIENT_BINDING, readMailSendPayload, mailSubmissionAcknowledged } from './mail-send-client.ts'

type Request = (method: string, path: string, body: unknown) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const request = (fn: Request) => { (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = fn }
const editor = () => document.getElementById('compose-body')!
const button = () => document.querySelector<HTMLButtonElement>('[data-mail-send]')!
const status = () => document.getElementById('mail-send-status')!
const boot = () => {
  document.body.innerHTML = `<main><input id="compose-to" value="typed-to@example.test"><span data-mail-chip="to" data-addr="chip-to@example.test"></span><input id="compose-cc" value="typed-cc@example.test"><span data-mail-chip="cc" data-addr="chip-cc@example.test"></span><input id="compose-bcc" value="typed-bcc@example.test"><span data-mail-chip="bcc" data-addr="chip-bcc@example.test"></span><input id="compose-subject" value="Draft subject"><div id="compose-body" contenteditable="true"><p><strong>Draft body</strong> <a href="https://example.test">link</a></p></div><button type="button" data-mail-send="true">Send</button><p id="mail-send-status"></p></main>`
  new Function(MAIL_SEND_CLIENT_BINDING)()
}
beforeEach(() => { document.documentElement.lang = 'en' })
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('real mail compose submission', () => {
  it('emits standalone browser JS', () => { expect(() => new Script(MAIL_SEND_CLIENT_BINDING)).not.toThrow() })
  it('collects chips and typed To/Cc/Bcc independently with real HTML and plain fallback', () => {
    boot()
    expect(readMailSendPayload()).toEqual({ to: 'chip-to@example.test, typed-to@example.test', cc: 'chip-cc@example.test, typed-cc@example.test', bcc: 'chip-bcc@example.test, typed-bcc@example.test', subject: 'Draft subject', text: 'Draft body link', html: '<p><strong>Draft body</strong> <a href="https://example.test">link</a></p>' })
  })
  it('does not invent HTML for a plain text editor', () => {
    boot(); editor().outerHTML = '<textarea id="compose-body">Plain draft</textarea>'
    expect(readMailSendPayload().text).toBe('Plain draft'); expect(readMailSendPayload()).not.toHaveProperty('html')
  })
  it.each([true, false])('clears the draft only after actual accepted submission; Sent-copy result %s', async savedToSent => {
    const send = vi.fn<Request>().mockResolvedValue({ mailbox: 'mailbox@example.test', messageId: '<receipt@example.test>', savedToSent }); request(send); boot()
    const expected = readMailSendPayload(); button().click(); await tick()
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/webmail/send', expected)
    expect(status().dataset.state).toBe('accepted'); expect(status().textContent).not.toContain('delivered')
    expect(editor().textContent).toBe(''); expect(document.querySelector('[data-mail-chip]')).toBeNull()
    for (const id of ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject']) expect((document.getElementById(id) as HTMLInputElement).value).toBe('')
    expect(button().disabled).toBe(false)
  })
  it.each([{ status: 400, details: { stateChanged: false } }, { status: 403 }])('keeps the complete draft after a definite refusal: %j', async error => {
    const send = vi.fn<Request>().mockRejectedValue(error); request(send); boot(); const before = readMailSendPayload()
    button().click(); await tick(); expect(readMailSendPayload()).toEqual(before); expect(status().dataset.state).toBe('failed'); expect(button().disabled).toBe(false)
  })
  it.each([{}, { messageId: '<receipt@example.test>' }, { mailbox: 'mailbox@example.test', messageId: 'not-an-id', savedToSent: true }])('preserves draft and blocks retry on unverifiable response: %j', async result => {
    const send = vi.fn<Request>().mockResolvedValue(result); request(send); boot(); const before = readMailSendPayload()
    button().click(); await tick(); button().click(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(readMailSendPayload()).toEqual(before); expect(status().dataset.state).toBe('uncertain'); expect(button().disabled).toBe(true)
  })
  it.each([new Error('transport'), { status: 503 }, { status: 412, details: { stateChanged: true } }, { status: 409, unknownOutcome: true, details: { stateChanged: false } }, { status: 412, needsAttention: true, details: { stateChanged: false } }])('preserves draft and locks retry for an unknown outcome: %j', async error => {
    const send = vi.fn<Request>().mockRejectedValue(error); request(send); boot(); const before = readMailSendPayload()
    button().click(); await tick(); button().click(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(readMailSendPayload()).toEqual(before); expect(button().disabled).toBe(true)
  })
  it('does not submit a disabled composer or submit twice while pending', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn<Request>().mockImplementation(() => new Promise(done => { resolve = done })); request(send); boot()
    button().disabled = true; button().click(); expect(send).not.toHaveBeenCalled()
    button().disabled = false; button().click(); button().dispatchEvent(new MouseEvent('click')); expect(send).toHaveBeenCalledTimes(1)
    resolve({ mailbox: 'mailbox@example.test', messageId: '<receipt@example.test>', savedToSent: true }); await tick()
  })
  it('recognizes existing acknowledgement fields rather than invented ok/delivery flags', () => {
    expect(mailSubmissionAcknowledged({ mailbox: 'mailbox@example.test', messageId: '<receipt@example.test>', savedToSent: false })).toBe(true)
    expect(mailSubmissionAcknowledged({ ok: true, delivered: true })).toBe(false)
  })
})
