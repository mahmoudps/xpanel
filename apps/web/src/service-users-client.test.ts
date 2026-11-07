// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderServiceUsersManager } from './board-port/service-users-workspace.ts'
import { SERVICE_USERS_CLIENT_BINDING, SERVICE_USER_NAME, readServiceUsers } from './service-users-client.ts'

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const bob = { id: '11111111-1111-4111-8111-111111111111', login: 'bob@example.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 512, ftpDir: 'public_html' }
const domains = { domains: [{ id: 'dddddddd-1111-4111-8111-111111111111', name: 'example.com' }] }
const request = vi.fn(async (method: string, path: string, _body?: unknown): Promise<unknown> => path === '/api/domains' ? domains : method === 'GET' ? { serviceUsers: [bob] } : { ok: true })
async function bind(canManage = true, ask: unknown = async () => true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderServiceUsersManager({ locale: 'en', canManage, owner: 'alice' })
  ;(new Function('return ' + SERVICE_USERS_CLIENT_BINDING)() as (input: unknown) => void)(ask)
  await settle()
}
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); request.mockClear() })

describe('User Manager client', () => {
  it('stays inert without authority and reads nothing', async () => {
    await bind(false); expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-service-user-save]').disabled).toBe(true)
  })
  it('lists the owner as special and each user with services', async () => {
    await bind(); const rows = document.querySelectorAll('[data-service-users-rows] tr')
    expect(rows[0]!.textContent).toContain('alice'); expect(rows[0]!.querySelector('button')).toBeNull()
    expect(rows[1]!.textContent).toContain('bob@example.com'); expect(rows[1]!.querySelectorAll('button')).toHaveLength(2)
  })
  it('creates one login across the chosen services', async () => {
    await bind()
    $<HTMLInputElement>('[data-service-user-local]').value = 'Carol'; $<HTMLSelectElement>('[data-service-user-domain]').value = domains.domains[0]!.id; $<HTMLInputElement>('[data-service-user-password]').value = 'pw-pw-pw-pw'; $<HTMLInputElement>('[data-service-user-ftp]').checked = true
    $<HTMLButtonElement>('[data-service-user-save]').click(); await settle()
    expect(request).toHaveBeenCalledWith('POST', '/api/service-users', { services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html', webdiskReadOnly: false, localPart: 'carol', domainId: domains.domains[0]!.id, password: 'pw-pw-pw-pw' })
    expect($('[data-service-users-status]').textContent).toContain('Saved')
  })
  it('refuses a bad username and no services before any request', async () => {
    await bind(); const before = request.mock.calls.length
    $<HTMLInputElement>('[data-service-user-local]').value = 'bo b'; $<HTMLButtonElement>('[data-service-user-save]').click(); await settle()
    expect($('[data-service-users-status]').textContent).toContain('letters, digits')
    $<HTMLInputElement>('[data-service-user-email]').checked = false; $<HTMLButtonElement>('[data-service-user-save]').click(); await settle()
    expect($('[data-service-users-status]').textContent).toContain('at least one service'); expect(request.mock.calls.length).toBe(before)
  })
  it('edits services without sending an unchanged password', async () => {
    await bind(); document.querySelectorAll<HTMLButtonElement>('[data-service-users-rows] tr:nth-child(2) button')[0]!.click()
    expect($<HTMLInputElement>('[data-service-user-local]').disabled).toBe(true); expect($<HTMLInputElement>('[data-service-user-quota]').value).toBe('512')
    $<HTMLInputElement>('[data-service-user-webdisk]').checked = true; $<HTMLButtonElement>('[data-service-user-save]').click(); await settle()
    expect(request).toHaveBeenCalledWith('PATCH', '/api/service-users/' + bob.id, { services: { email: true, ftp: true, webdisk: true }, mailboxQuotaMb: 512, ftpDir: 'public_html', webdiskReadOnly: false })
  })
  it('deletes only after confirmation and shows a plan refusal', async () => {
    await bind(true, async () => false); document.querySelectorAll<HTMLButtonElement>('[data-service-users-rows] tr:nth-child(2) button')[1]!.click(); await settle()
    expect(request.mock.calls.some(call => call[0] === 'DELETE')).toBe(false)
    request.mockImplementationOnce(async () => { throw { code: 'LIMIT_EXCEEDED' } })
    $<HTMLInputElement>('[data-service-user-local]').value = 'carol'; $<HTMLSelectElement>('[data-service-user-domain]').value = domains.domains[0]!.id; $<HTMLInputElement>('[data-service-user-password]').value = 'x'
    $<HTMLButtonElement>('[data-service-user-save]').click(); await settle()
    expect($('[data-service-users-status]').textContent).toContain('plan does not allow')
  })
  it('validates names and replies', () => {
    for (const good of ['bob', 'a.b-c_d', '0x']) expect(SERVICE_USER_NAME.test(good), good).toBe(true)
    for (const bad of ['bo b', '.bob', 'bob.', 'a@b', '']) expect(SERVICE_USER_NAME.test(bad), bad).toBe(false)
    expect(() => readServiceUsers({ serviceUsers: [{ id: 1 }] })).toThrow()
  })
})
