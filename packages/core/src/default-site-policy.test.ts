import { describe, expect, it } from 'vitest'
import { validateDefaultSitePolicy, validatePhpFunctionExceptions, validateServerSettings } from './schemas.ts'
import type { ServerSettings } from './types.ts'

const settings = (): ServerSettings => ({ hostname: 'server.example.test', nameservers: ['ns1.example.test'], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 }, backendPort: 8080, backendTlsPort: 8443 })

describe('persisted explicit default-site policy', () => {
  it('preserves the complete legacy settings value without allocating a default policy on read', () => {
    const source = settings()
    expect(validateServerSettings(source)).toEqual(source)
    expect(validateServerSettings(source)).not.toHaveProperty('defaultSite')
  })
  it('normalizes rejection without a target and preserves optional HTTPS refusal', () => {
    expect(validateDefaultSitePolicy({ response: 'reject', refuseHttps: true })).toEqual({ response: 'reject', redirectTo: null, refuseHttps: true })
    expect(validateServerSettings({ ...settings(), defaultSite: { response: 'reject', redirectTo: null, refuseHttps: false } }).defaultSite).toEqual({ response: 'reject', redirectTo: null, refuseHttps: false })
  })
  it('persists a canonical fixed HTTP or HTTPS URL without interpreting request variables', () => {
    expect(validateDefaultSitePolicy({ response: 'redirect', redirectTo: 'HTTPS://Example.TEST/path?q=%24host', refuseHttps: false })).toEqual({ response: 'redirect', redirectTo: 'https://example.test/path?q=%24host', refuseHttps: false })
    expect(validateDefaultSitePolicy({ response: 'redirect', redirectTo: 'http://example.test:8080/', refuseHttps: true }).redirectTo).toBe('http://example.test:8080/')
    const canonical = validateDefaultSitePolicy({ response: 'redirect', redirectTo: 'https://example.test/' + 'é'.repeat(100), refuseHttps: false })
    expect(validateDefaultSitePolicy(canonical)).toEqual(canonical)
    expect(() => validateDefaultSitePolicy({ response: 'redirect', redirectTo: 'https://example.test/' + 'é'.repeat(400), refuseHttps: false })).toThrow()
  })
  it.each(['javascript:alert(1)', 'file:///etc/passwd', '//example.test/', '/relative', 'https://user:password@example.test/', 'https://user@example.test/', 'https://example.test/\r\nInjected:yes', 'https://example.test/$host', 'https:\\example.test\\path', 'https://example.test/a b', '', 'https://example.test/' + 'x'.repeat(2048), 'https://example.test/\ud800'])('refuses unsafe or ambiguous fixed redirect %j', redirectTo => {
    expect(() => validateDefaultSitePolicy({ response: 'redirect', redirectTo, refuseHttps: false })).toThrow()
  })
  it.each([null, [], { response: 'proxy', refuseHttps: false }, { response: 'reject', redirectTo: 'https://example.test/', refuseHttps: false }, { response: 'reject', refuseHttps: 'false' }, { response: 'reject', refuseHttps: false, upstream: 'http://127.0.0.1/' }])('refuses unsupported policy shape %j', raw => {
    expect(() => validateDefaultSitePolicy(raw)).toThrow()
  })
})

describe('server default PHP version', () => {
  it('keeps a valid default for new domains and refuses anything else', () => {
    expect(validateServerSettings({ ...settings(), defaultPhpVersion: '8.4' }).defaultPhpVersion).toBe('8.4')
    expect(validateServerSettings(settings())).not.toHaveProperty('defaultPhpVersion')
    expect(() => validateServerSettings({ ...settings(), defaultPhpVersion: '8.4; rm' })).toThrow()
  })
})

describe('PHP function exceptions', () => {
  const grant = { account: 'karim', functions: ['proc_open', 'exec'], reason: ' queue worker ', grantedAt: '2026-10-29T00:00:00Z', grantedBy: 'root' }
  it('keeps one canonical entry per account from the six allowed functions', () => {
    expect(validatePhpFunctionExceptions([grant])).toEqual([{ ...grant, functions: ['exec', 'proc_open'], reason: 'queue worker', grantedAt: '2026-10-29T00:00:00.000Z' }])
    expect(validateServerSettings({ ...settings(), phpFunctionExceptions: [grant] } as never).phpFunctionExceptions).toHaveLength(1)
  })
  it.each([
    [{ ...grant, functions: ['dl'] }], [{ ...grant, functions: [] }], [{ ...grant, reason: '' }], [{ ...grant, account: 'Root' }], [{ ...grant, extra: true }], [grant, grant],
  ])('refuses %j', (...list) => { expect(() => validatePhpFunctionExceptions(list)).toThrow() })
})
