// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSecurityEvidence } from './board-port/whm-security-components.ts'
import { WHM_SECURITY_CLIENT_BINDING } from './whm-security-client.ts'

const payload = () => ({ overall: 'not-qualified', configuration: { state: 'read', source: 'saved-configuration', panelPort: 2087, sshPort: 22, engine: 'apache' }, checks: ['ssh-service', 'ssh-public-key', 'ssh-password', 'ssh-root-login', 'ssh-attempts'].map(id => ({ id, state: 'unavailable', value: null as string | null, source: 'host-observation' })) })
const status = () => document.querySelector<HTMLElement>('[data-whm-security-status]')!
const boot = (send?: ReturnType<typeof vi.fn>) => { if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + WHM_SECURITY_CLIENT_BINDING)()() }
beforeEach(() => { document.body.innerHTML = renderWhmSecurityEvidence({ locale: 'en' }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('root security observation controller', () => {
  it('refuses reads under the canonical unavailable capability wrapper', () => {
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.capabilityState = 'unavailable'
    const send = vi.fn(); boot(send)
    expect(send).not.toHaveBeenCalled(); expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.disabled).toBe(true)
  })
  it('keeps missing transport or unavailable admission explicit without issuing a check', async () => {
    boot(); expect(status().dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.securityBound = ''
    document.querySelector<HTMLElement>('[data-whm-security-evidence]')!.dataset.capabilityUnavailable = 'true'
    const send = vi.fn(); boot(send); expect(send).not.toHaveBeenCalled()
  })
  it('renders saved configuration separately and never marks unknown checks healthy', async () => {
    const send = vi.fn(async () => payload()); boot(send)
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    expect(document.querySelectorAll('[data-check-state="unavailable"]')).toHaveLength(5)
    expect(document.querySelector('[data-whm-security-configuration]')!.textContent).toContain('Saved SSH port22')
    expect(send.mock.calls).toEqual([['GET', '/api/security/workspace']])
    expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_SECURITY_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('renders returned values as text and rejects an invented overall pass while retaining prior observations', async () => {
    const current = payload(); current.checks[0] = { ...current.checks[0]!, state: 'attention', value: '<img src=x>' }
    const send = vi.fn(async () => current); boot(send)
    await vi.waitFor(() => expect(status().dataset.state).toBe('read'))
    expect(document.querySelector('img')).toBeNull()
    const before = document.querySelector('[data-whm-security-check-rows]')!.textContent
    current.overall = 'verified'
    document.querySelector<HTMLButtonElement>('[data-whm-security-refresh]')!.click()
    await vi.waitFor(() => expect(status().dataset.state).toBe('failed'))
    expect(document.querySelector('[data-whm-security-check-rows]')!.textContent).toBe(before)
  })
})
