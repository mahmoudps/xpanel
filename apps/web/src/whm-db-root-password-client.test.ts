// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDatabasesWorkspace } from './board-port/whm-databases-workspace.ts'
import { readWhmDbRootPasswordOutcome, rootPasswordStrength, WHM_DB_ROOT_PASSWORD_CLIENT_BINDING } from './whm-db-root-password-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const outcome = { observedAt: '2026-11-07T10:00:00.000Z', serverPassword: 'verified', clientFile: { path: '/root/.my.cnf', state: 'written' }, socketAccess: 'verified', verificationRequired: false }
const mount = (canRootPassword = true) => { document.body.innerHTML = `<section data-capability-state="authorized">${renderWhmDatabasesWorkspace({ kind: 'servers', locale: 'en', canRead: true, canKill: false, canRootPassword })}</section>` }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + WHM_DB_ROOT_PASSWORD_CLIENT_BINDING)()(ask); return ask }
const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('MariaDB root password client', () => {
  it('rates strength with the agent character rule and refuses inconsistent outcomes', () => {
    expect(rootPasswordStrength('short')).toBe('invalid'); expect(rootPasswordStrength('with space 123')).toBe('invalid')
    expect(rootPasswordStrength('abcdefgh')).toBe('weak'); expect(rootPasswordStrength('Abcdefgh1234')).toBe('fair'); expect(rootPasswordStrength('Abcdefgh1234!xyz')).toBe('strong')
    expect(() => readWhmDbRootPasswordOutcome({ ...outcome, verificationRequired: true })).toThrow()
  })
  it('enables the form only for a writable client file, sends the password once and clears it', async () => {
    mount()
    const send = vi.fn(async (method: string) => method === 'GET' ? { clientFile: { path: '/root/.my.cnf', state: 'absent' }, mariadb: 'connected' } : outcome)
    const ask = boot(send); await tick()
    const password = el<HTMLInputElement>('[data-db-root-new]'), confirm = el<HTMLInputElement>('[data-db-root-confirm]'), submit = el<HTMLButtonElement>('[data-db-root-submit]')
    expect(password.disabled).toBe(false); expect(submit.disabled).toBe(true)
    password.value = 'Abcdefgh1234!xyz'; password.dispatchEvent(new Event('input')); expect(submit.disabled).toBe(true)
    confirm.value = 'Abcdefgh1234!xyz'; confirm.dispatchEvent(new Event('input')); expect(submit.disabled).toBe(false)
    submit.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/server/databases/root-password', { password: 'Abcdefgh1234!xyz' }]])
    expect(password.value).toBe(''); expect(el('[data-db-root-status]').dataset.state).toBe('read')
    expect(el('[data-db-root-status]').textContent).not.toContain('Abcdefgh1234')
  })
  it('keeps the form disabled for an unmanaged file or a session without the verified tool', async () => {
    mount(); boot(async () => ({ clientFile: { path: '/root/.my.cnf', state: 'unmanaged' }, mariadb: 'connected' })); await tick()
    expect(el<HTMLInputElement>('[data-db-root-new]').disabled).toBe(true); expect(el('[data-db-root-fact="clientFile"]').textContent).toContain('Edited outside xPanel')
    mount(false); const send = vi.fn(async () => ({})); boot(send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(el('[data-db-root-status]').dataset.state).toBe('unavailable')
  })
})
