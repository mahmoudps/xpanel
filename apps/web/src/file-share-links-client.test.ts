// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderFileShareLinks } from './board-port/file-share-links-workspace.ts'
import { FILE_SHARE_LINKS_CLIENT_BINDING, readFileShareLinks, shareLinkUrl } from './file-share-links-client.ts'

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const revision = 'a'.repeat(64), row = { id: 'fsl_0123456789abcdef', username: 'alice', file: 'public_html/<b>.pdf', sizeBytes: 5, expiresAt: '2026-11-08T12:00:00.000Z', createdAt: '2026-11-07T12:00:00.000Z', createdBy: 'root', state: 'active' }
const request = vi.fn(async (method: string, _path: string, _body?: unknown): Promise<unknown> => method === 'GET' ? { revision, invalid: false, links: [row] } : method === 'POST' ? { path: '/share/' + 'a'.repeat(43), link: row } : { revoked: row.id })
async function bind(ask: unknown = async () => true, canManage = true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderFileShareLinks({ locale: 'en', canManage })
  ;(new Function('return ' + FILE_SHARE_LINKS_CLIENT_BINDING)() as (input: unknown) => void)(ask)
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); request.mockClear() })

describe('File share links client', () => {
  it('stays inert without root', async () => { await bind(undefined, false); expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-file-share-create]').disabled).toBe(true) })
  it('lists links as text and offers no way to read a token back', async () => {
    await bind(); expect($('[data-file-share-rows]').textContent).toContain('public_html/<b>.pdf'); expect($('[data-file-share-rows] b')).toBeNull()
    expect($<HTMLElement>('[data-file-share-result]').hidden).toBe(true)
  })
  it('sends the required expiry, shows the link once and on the account port', async () => {
    await bind(); $<HTMLInputElement>('[data-file-share-path]').value = '/home/alice/public_html/a.pdf'; $<HTMLSelectElement>('[data-file-share-hours]').value = '168'
    $<HTMLButtonElement>('[data-file-share-create]').click(); await settle()
    expect(request).toHaveBeenCalledWith('POST', '/api/server/file-sharing/links', { path: '/home/alice/public_html/a.pdf', expiresHours: 168, expectedRevision: revision })
    expect($<HTMLInputElement>('[data-file-share-url]').value).toContain(':2083/share/'); expect($<HTMLElement>('[data-file-share-result]').hidden).toBe(false)
    expect($('[data-file-share-status]').textContent).toContain('shown only once')
  })
  it('refuses a relative path before any request', async () => {
    await bind(); const before = request.mock.calls.length; $<HTMLInputElement>('[data-file-share-path]').value = 'public_html/a'; $<HTMLButtonElement>('[data-file-share-create]').click(); await settle()
    expect(request.mock.calls.length).toBe(before); expect($('[data-file-share-status]').textContent).toContain('full path')
  })
  it('revokes only after confirmation', async () => {
    const ask = vi.fn(async () => false); await bind(ask); $<HTMLButtonElement>('[data-file-share-rows] button').click(); await settle()
    expect(ask).toHaveBeenCalledOnce(); expect(request.mock.calls.some(call => call[0] === 'DELETE')).toBe(false)
    ask.mockResolvedValue(true as never); $<HTMLButtonElement>('[data-file-share-rows] button').click(); await settle()
    expect(request).toHaveBeenCalledWith('DELETE', '/api/server/file-sharing/links/' + row.id)
  })
  it('states a refused path and reads replies strictly', async () => {
    request.mockImplementationOnce(async () => ({ revision, invalid: false, links: [] })).mockImplementationOnce(async () => { throw { code: 'NOT_FOUND' } })
    await bind(); $<HTMLInputElement>('[data-file-share-path]').value = '/etc/passwd'; $<HTMLButtonElement>('[data-file-share-create]').click(); await settle()
    expect($('[data-file-share-status]').textContent).toContain('not one regular file')
    expect(() => readFileShareLinks({ revision: 'x', invalid: false, links: [] })).toThrow()
    expect(shareLinkUrl('/share/x', 'https://host.example:2087/whm/server/file-sharing')).toBe('https://host.example:2083/share/x')
  })
})
