import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleComposerWorkspaceRoute } from './composer-workspace.ts'
const caller = { principal: { id: 'root-a', username: 'root', kind: 'root' } } as AuthenticatedCaller
const view = () => ({ scope: 'saved-site-document-roots', observedAt: '2026-10-27T00:00:00.000Z', binary: { state: 'read', executable: '/usr/bin/composer', version: '2.8.12' }, projects: [{ selector: 'site-a', domain: 'example.test', account: 'alpha', directory: '/home/alpha/public_html', phpVersion: '8.3' }], selected: null, actions: { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } })
const fixture = () => ({ requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async () => {}), callHost: vi.fn(async () => view()) })
const read = async (helpers: ReturnType<typeof fixture>, query = '', method = 'GET') => { const url = new URL('http://local/api/server/composer' + query); return handleComposerWorkspaceRoute(new Request(url), url, method, helpers) }
describe('Composer root API observation', () => {
  it('rechecks authority and projects only the sanitized observation contract', async () => {
    const f = fixture(); f.callHost.mockResolvedValue({ ...view(), credentials: 'private-credential', logs: 'private-log' } as never)
    const response = await read(f), body = await response!.json()
    expect(f.callHost).toHaveBeenCalledWith(caller, '/host/composer'); expect(f.requireCaller).toHaveBeenCalledTimes(2); expect(f.assertRoot).toHaveBeenCalledTimes(2)
    expect(body).toEqual(view()); expect(JSON.stringify(body)).not.toContain('private-'); expect(response!.headers.get('cache-control')).toBe('no-store')
  })
  it.each(['?path=/home/alpha', '?domainId=site-a&domainId=site-a', '?domainId=../bad', '?command=install'])('refuses caller paths, duplicate/unknown query fields %s', async query => {
    const f = fixture(); await expect(read(f, query)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.callHost).not.toHaveBeenCalled()
  })
  it('refuses wrong-target responses and malformed successful capabilities', async () => {
    const f = fixture(); await expect(read(f, '?domainId=site-a')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    f.callHost.mockResolvedValue({ ...view(), actions: { ...view().actions, install: true } } as never)
    await expect(read(f)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('requires root before transport and refuses identity changes during the observation', async () => {
    const f = fixture(); f.assertRoot.mockRejectedValue(new Error('denied'))
    await expect(read(f)).rejects.toThrow('denied'); expect(f.callHost).not.toHaveBeenCalled()
    const g = fixture(); g.requireCaller.mockResolvedValueOnce(caller).mockResolvedValueOnce({ principal: { ...caller.principal, id: 'root-b' } } as AuthenticatedCaller)
    await expect(read(g)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('returns 405 for changes and leaves unrelated routes untouched', async () => {
    const f = fixture(); expect((await read(f, '', 'POST'))!.status).toBe(405); expect(f.callHost).not.toHaveBeenCalled()
    const url = new URL('http://local/api/other'); expect(await handleComposerWorkspaceRoute(new Request(url), url, 'GET', f)).toBeNull()
  })
})
