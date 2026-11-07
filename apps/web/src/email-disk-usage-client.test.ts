// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderEmailDiskUsageCard } from './board-port/email-disk-usage-workspace.ts'
import { EMAIL_DISK_USAGE_CLIENT_BINDING, readEmailDiskUsage } from './email-disk-usage-client.ts'

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const view = (freedBytes?: number) => ({ mailbox: 'bob@example.com', observedAt: '2026-11-07T10:00:00.000Z', folders: { state: 'read', reason: null, truncated: false, totalMessages: 3, totalVsizeBytes: 3000, folders: [{ name: 'INBOX', messages: 2, vsizeBytes: 2000 }, { name: 'Sent', messages: 1, vsizeBytes: 9000 }] }, ...(freedBytes === undefined ? {} : { freedBytes }) })
const request = vi.fn(async (method: string, _path: string, _body?: unknown): Promise<unknown> => method === 'POST' ? view(1024) : view())
async function bind(ask: unknown = async () => true, mailboxes = ['bob@example.com'], canManage = true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderEmailDiskUsageCard({ locale: 'en', canManage, mailboxes })
  ;(new Function('return ' + EMAIL_DISK_USAGE_CLIENT_BINDING)() as (input: unknown) => void)(ask)
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); request.mockClear() })

describe('Email Disk Usage client', () => {
  it('stays inert without authority or mailboxes', async () => {
    await bind(undefined, ['bob@example.com'], false); expect($<HTMLButtonElement>('[data-email-usage-read]').disabled).toBe(true)
    await bind(undefined, []); expect($('[data-email-usage-status]').textContent).toContain('no mailboxes')
  })
  it('lists folders by size, sorts and filters them', async () => {
    await bind(); $<HTMLButtonElement>('[data-email-usage-read]').click(); await settle()
    expect(request.mock.calls[0]![1]).toBe('/api/account/email/disk-usage?mailbox=bob%40example.com')
    expect($('[data-email-usage-rows] tr:first-child').textContent).toContain('Sent')
    $<HTMLButtonElement>('button[data-email-usage-sort="name"]').click()
    expect($('[data-email-usage-rows] tr:first-child').textContent).toContain('INBOX')
    $<HTMLInputElement>('[data-email-usage-search]').value = 'sen'; $<HTMLInputElement>('[data-email-usage-search]').dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('[data-email-usage-rows] tr')).toHaveLength(1)
  })
  it('deletes only after confirmation and reports what was freed', async () => {
    const ask = vi.fn(async () => false); await bind(ask); $<HTMLButtonElement>('[data-email-usage-read]').click(); await settle()
    $<HTMLButtonElement>('[data-email-usage-run]').click(); await settle()
    expect(ask).toHaveBeenCalledOnce(); expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(false)
    ask.mockResolvedValue(true as never); $<HTMLButtonElement>('[data-email-usage-run]').click(); await settle()
    expect(request).toHaveBeenCalledWith('POST', '/api/account/email/disk-usage/cleanup', { mailbox: 'bob@example.com', folder: 'INBOX', preset: 'older-than-year', query: null, confirmFolder: 'INBOX' })
    expect($('[data-email-usage-status]').textContent).toContain('1.0 KiB freed')
  })
  it('refuses an empty custom search before asking', async () => {
    const ask = vi.fn(); await bind(ask); $<HTMLButtonElement>('[data-email-usage-read]').click(); await settle()
    const preset = $<HTMLSelectElement>('[data-email-usage-preset]'); preset.value = 'custom'; preset.dispatchEvent(new Event('change'))
    expect($<HTMLElement>('[data-email-usage-custom]').hidden).toBe(false)
    $<HTMLButtonElement>('[data-email-usage-run]').click(); await settle()
    expect(ask).not.toHaveBeenCalled(); expect($('[data-email-usage-status]').textContent).toContain('empty search is refused')
  })
  it('refuses a reply for another mailbox', () => { expect(() => readEmailDiskUsage(view(), 'eve@other.test')).toThrow() })
})
