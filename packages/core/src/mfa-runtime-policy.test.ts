import { describe, expect, it, vi, afterEach } from 'vitest'
import { bindMfaRuntimePolicy, captureMfaRuntimePolicy, resolveMfaRuntimePolicy } from './mfa-runtime-policy.ts'

afterEach(() => vi.unstubAllEnvs())
describe('trusted MFA runtime policy', () => {
  it.each([undefined, '', 'production', 'test', 'staging', 'Development', ' development ', 'disabled'])('keeps %s optional', environment => {
    expect(resolveMfaRuntimePolicy(environment)).toEqual({ mode: 'optional' })
  })
  it('captures only exact development and freezes the decision', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const policy = captureMfaRuntimePolicy()
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('XPANEL_MFA_MODE', 'disabled')
    expect(policy.mode).toBe('disabled')
    expect(Object.isFrozen(policy)).toBe(true)
    expect(captureMfaRuntimePolicy().mode).toBe('optional')
    expect(bindMfaRuntimePolicy(policy)).toBe(policy)
    expect(() => bindMfaRuntimePolicy({ mode: 'disabled' })).toThrow('trusted process')
    expect(() => bindMfaRuntimePolicy(resolveMfaRuntimePolicy('development'))).toThrow('trusted process')
  })
})
