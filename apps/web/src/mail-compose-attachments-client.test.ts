// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING, readComposeAttachmentPayload } from './mail-compose-attachments-client.ts'
import type { ComposeAttachmentPayload } from '@xpanel/core'

type Group = HTMLElement & { xpanelReadComposeAttachments: (payload?: Record<string, unknown>) => readonly ComposeAttachmentPayload[] }
const group = () => document.querySelector<Group>('[data-compose-form]')!
const input = () => document.querySelector<HTMLInputElement>('[data-compose-attachment-input]')!
const status = () => document.querySelector<HTMLElement>('[data-compose-attachment-status]')!
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = () => new Function('return ' + MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING)()(undefined)
const realFile = (bytes = Uint8Array.from([0, 255, 128, 13, 10]), name = 'invoice.bin', type = 'application/octet-stream') => {
  const file = new File([bytes], name, { type })
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => bytes.slice().buffer), configurable: true })
  return file
}
const choose = (files: readonly File[]) => { Object.defineProperty(input(), 'files', { value: files, configurable: true }); input().dispatchEvent(new Event('change', { bubbles: true })) }
beforeEach(() => {
  document.body.innerHTML = '<section data-compose-form="true" data-compose-identities data-compose-mailbox="owner@example.test"><section data-compose-attachments data-compose-attachment-enabled="true"><span data-compose-attachment-summary>0 files</span><button type="button" data-compose-attachment-open>Attach</button><input hidden type="file" multiple data-compose-attachment-input><ul data-compose-attachment-list></ul><div role="status" data-compose-attachment-status></div></section><button data-mail-send data-mail-send-busy="false">Send</button></section>'
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('one browser attachment collector for Send and Save draft', () => {
  it('fails closed before binding and returns an immutable actual-byte snapshot after binding', async () => {
    expect(() => readComposeAttachmentPayload(group())).toThrow('ATTACHMENTS_UNBOUND')
    boot(); choose([realFile()]); await tick()
    const snapshot = readComposeAttachmentPayload(group(), { text: 'Attached', expectedDraft: { folder: 'Drafts', uid: 3, uidValidity: 10 } })
    expect(snapshot).toEqual([{ filename: 'invoice.bin', contentType: 'application/octet-stream', contentBase64: 'AP+ADQo=' }])
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(document.body.innerHTML).not.toContain('AP+ADQo=')
    expect(document.querySelectorAll('[data-compose-attachment-remove]')).toHaveLength(1)
    expect(document.querySelector('[data-compose-attachment-summary]')!.textContent).toBe('1 files · 5 B')
    expect(Object.getOwnPropertyDescriptor(group(), 'xpanelReadComposeAttachments')).toMatchObject({ writable: false, configurable: false, enumerable: false })
  })
  it('serializes all dependencies and never injects selected content as HTML or sends a request', () => {
    expect(() => new Function('return ' + MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING).not.toContain('fetch(')
    boot(); const method = group().xpanelReadComposeAttachments; boot(); expect(group().xpanelReadComposeAttachments).toBe(method)
    expect(status().textContent).toContain('10 files, 512 KiB')
  })
  it('accepts the exact decoded boundary and refuses noncanonical byte encodings', () => {
    const file = { filename: 'full.bin', contentType: 'application/octet-stream', contentBase64: btoa('x'.repeat(524288)) }
    expect(readComposeAttachmentPayload(group(), undefined, () => ({ pending: false, error: null, files: [file] }))).toHaveLength(1)
    expect(() => readComposeAttachmentPayload(group(), undefined, () => ({ pending: false, error: null, files: [{ ...file, contentBase64: 'AB==' }] }))).toThrow('ATTACHMENT_ENCODING')
  })
  it('refuses pending reads and freezes chooser/removal until actual bytes arrive', async () => {
    boot(); const file = realFile(); let resolve!: (value: ArrayBuffer) => void
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(done => { resolve = done }), configurable: true })
    choose([file])
    expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_PENDING')
    expect(input().disabled).toBe(true); expect(status().textContent).toContain('Reading file bytes')
    expect(document.querySelectorAll('[data-compose-attachment-remove]')).toHaveLength(0)
    resolve(Uint8Array.from([0, 255, 128, 13, 10]).buffer); await tick()
    expect(group().xpanelReadComposeAttachments()).toHaveLength(1); expect(input().disabled).toBe(false)
  })
  it('keeps successful files when another selection fails, and requires explicit dismissal', async () => {
    boot(); choose([realFile()]); await tick()
    const tooLarge = realFile(new Uint8Array(524289), 'oversize.bin')
    choose([tooLarge]); await tick()
    expect(tooLarge.arrayBuffer).not.toHaveBeenCalled()
    expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_INVALID')
    expect(document.querySelectorAll('[data-compose-attachment-remove]')).toHaveLength(1)
    document.querySelector<HTMLButtonElement>('[data-compose-attachment-dismiss]')!.click()
    expect(group().xpanelReadComposeAttachments()).toHaveLength(1)
  })
  it('checks actual read length and unsafe filename before exposing a payload', async () => {
    boot(); const file = realFile()
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(0), configurable: true })
    choose([file]); await tick()
    expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_INVALID')
    expect(document.querySelectorAll('[data-compose-attachment-remove]')).toHaveLength(0)
    document.querySelector<HTMLButtonElement>('[data-compose-attachment-dismiss]')!.click()
    choose([realFile(undefined, 'x\u202e.pdf')]); await tick()
    expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_INVALID')
  })
  it('locks mutations while Send is busy while allowing exact snapshot comparison', async () => {
    boot(); choose([realFile()]); await tick()
    const send = document.querySelector<HTMLButtonElement>('[data-mail-send]')!
    send.dataset.mailSendBusy = 'true'; await tick()
    expect(input().disabled).toBe(true)
    expect(group().xpanelReadComposeAttachments()).toHaveLength(1)
    const remove = document.querySelector<HTMLButtonElement>('[data-compose-attachment-remove]')!
    expect(remove.disabled).toBe(true); remove.dispatchEvent(new Event('click')); expect(group().xpanelReadComposeAttachments()).toHaveLength(1)
    send.dataset.mailSendBusy = 'false'; await tick(); remove.click(); expect(group().xpanelReadComposeAttachments()).toEqual([])
  })
  it('preserves newer files on accepted-send false and clears only an unchanged accepted draft', async () => {
    boot(); choose([realFile()]); await tick()
    const send = document.querySelector<HTMLButtonElement>('[data-mail-send]')!
    send.dispatchEvent(new CustomEvent('xpanel:mail-send-accepted', { bubbles: true, detail: { draftCleared: false } }))
    expect(group().xpanelReadComposeAttachments()).toHaveLength(1)
    send.dispatchEvent(new CustomEvent('xpanel:mail-send-accepted', { bubbles: true, detail: { draftCleared: true } }))
    expect(group().xpanelReadComposeAttachments()).toEqual([])
    expect(document.querySelectorAll('[data-compose-attachment-remove]')).toHaveLength(0)
  })
  it('enforces capability admission and reports pending/invalid/ready events', async () => {
    const states: string[] = []
    group().addEventListener('xpanel:compose-attachments-state', event => states.push((event as CustomEvent<{ state: string }>).detail.state))
    boot(); choose([realFile()]); await tick()
    expect(states).toContain('pending'); expect(states.at(-1)).toBe('ready')
    document.querySelector<HTMLElement>('[data-compose-attachments]')!.dataset.composeAttachmentEnabled = 'false'; await tick()
    expect(input().disabled).toBe(true); expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_UNAVAILABLE')
    expect(states.at(-1)).toBe('unavailable')
  })
  it('pins local file state to the original compose mailbox', async () => {
    boot(); choose([realFile()]); await tick()
    group().dataset.composeMailbox = 'other@example.test'; await tick()
    expect(input().disabled).toBe(true)
    expect(() => group().xpanelReadComposeAttachments()).toThrow('ATTACHMENTS_UNAVAILABLE')
  })
  it('measures exact full-request UTF-8 bytes and fallback MIME types while keeping ASCII display digits', async () => {
    boot(); choose([realFile(new Uint8Array(0), 'فاتورة\u0661.txt', 'text/plain; charset=utf-8')]); await tick()
    expect(group().xpanelReadComposeAttachments()[0]).toMatchObject({ filename: 'فاتورة\u0661.txt', contentType: 'application/octet-stream', contentBase64: '' })
    expect(document.querySelector('[data-compose-attachment-list]')!.textContent).toContain('فاتورة1.txt')
    expect(() => group().xpanelReadComposeAttachments({ text: 'ع'.repeat(600000) })).toThrow('COMPOSE_REQUEST_TOO_LARGE')
    expect(() => group().xpanelReadComposeAttachments({ text: '\\'.repeat(600000) })).toThrow('COMPOSE_REQUEST_TOO_LARGE')
    expect(status().textContent).toContain('512 KiB')
  })
  it('keeps the file count and size isolated inside the Arabic summary sentence', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    try {
      boot(); choose([realFile()]); await tick()
      const summary = document.querySelector('[data-compose-attachment-summary]')!
      expect(summary.textContent).toBe('1 ملفات · 5 B'); expect([...summary.querySelectorAll('bdi[dir="ltr"]')].map(node => node.textContent)).toEqual(['1', '5 B'])
      expect(document.querySelector('[data-compose-attachment-remove]')!.getAttribute('aria-label')).toBe('إزالة invoice.bin')
    } finally { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' }
  })
})
