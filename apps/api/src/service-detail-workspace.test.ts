import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleServiceDetailWorkspaceRoute, projectCertificatesDetail, projectDnsDetail, projectFtpDetail, projectZoneCheck } from './service-detail-workspace.ts'
import type { ServiceDetailWorkspaceHelpers } from './service-detail-workspace.ts'

const root = { principal: { kind: 'root', id: 'root-1', username: 'root' } } as AuthenticatedCaller
const at = '2026-10-27T10:00:00.000Z'
const pdns = { id: 'pdns', label: 'PowerDNS', unit: 'pdns.service', state: 'active' }
const dns = (overrides: Record<string, unknown> = {}) => ({ kind: 'dns', observedAt: at, service: pdns, control: { state: 'reachable', version: '4.8.3' }, zoneDir: '/var/lib/powerdns/zones', directory: 'read', savedState: 'read', otherEntries: 1, truncated: false,
  zones: [{ zone: 'example.com', desired: true, stateSerial: 2026102701, file: 'parsed', fileSerial: 2026102701, sizeBytes: 300 }, { zone: 'other.net', desired: false, stateSerial: null, file: 'malformed', fileSerial: null, sizeBytes: 20 }], ...overrides })
const ftp = (overrides: Record<string, unknown> = {}) => ({ kind: 'ftp', observedAt: at, service: { id: 'pure-ftpd', label: 'pure-ftpd', unit: 'pure-ftpd.service', state: 'active' }, confDir: '/etc/pure-ftpd/conf', ftpAccounts: 2,
  settings: [{ name: 'TLS', desired: '2', observed: '2', state: 'match' }, { name: 'NoAnonymous', desired: 'yes', observed: 'no', state: 'drift' }, { name: 'PureDB', desired: '/etc/pure-ftpd/pureftpd.pdb', observed: null, state: 'missing' }], ...overrides })
const cert = { subject: 'CN=panel.example.test', issuer: 'CN=Test CA', names: ['panel.example.test'], notBefore: '2026-10-01T00:00:00.000Z', notAfter: '2026-12-30T00:00:00.000Z', daysLeft: 63, fingerprint256: Array.from({ length: 32 }, () => 'AB').join(':'), chainLength: 1, coversHostname: true }
const path = '/etc/xpanel/management-certificates/' + 'a'.repeat(64)
const panel = (overrides: Record<string, unknown> = {}) => ({ id: 'panel', ports: [443, 2083], configPath: '/etc/nginx/conf.d/xpanel-management.conf', state: 'observed', reason: null, certPath: path + '/fullchain.pem', keyPath: path + '/privkey.pem', keyPresent: true, certificate: cert, warnings: [], ...overrides })
const notRendered = (id: string) => ({ id, ports: [], configPath: null, state: 'not-rendered', reason: null, certPath: null, keyPath: null, keyPresent: null, certificate: null, warnings: [] })
const certificates = (endpoints: unknown[] = [panel(), notRendered('postfix')]) => ({ kind: 'certificates', observedAt: at, hostname: 'panel.example.test', endpoints })
const check = (overrides: Record<string, unknown> = {}) => ({ zone: 'example.com', observedAt: at, state: 'passed', records: 4, errors: 0, warnings: 0, messages: [], ...overrides })
const get = (path: string, method = 'GET') => new Request('http://localhost' + path, { method })
const call = (req: Request, helpers: ServiceDetailWorkspaceHelpers) => handleServiceDetailWorkspaceRoute(req, new URL(req.url), req.method, helpers)
const helpers = (reply: (path: string) => unknown = path => path.endsWith('/dns') ? dns() : path.endsWith('/ftp') ? ftp() : path.includes('zone-check') ? check() : certificates()) => {
  const events: string[] = []
  const value: ServiceDetailWorkspaceHelpers = {
    requireCaller: vi.fn(async () => { events.push('auth'); return root }), assertRoot: vi.fn(async (_caller, action: string) => { events.push('root:' + action) }),
    readDetail: vi.fn(async (_caller, path: string) => { events.push('agent:' + path); return reply(path) }),
  }
  return { value, events }
}

describe('API service detail workspace', () => {
  it('leaves unrelated routes untouched', async () => {
    const { value } = helpers()
    for (const path of ['/api/server/services', '/api/server/services/pdns/restart', '/api/server/services/mail', '/api/server/mail-queue']) expect(await call(get(path), value)).toBeNull()
    expect(value.requireCaller).not.toHaveBeenCalled()
  })
  it('forwards root reads to the agent and projects only typed facts', async () => {
    const { value, events } = helpers(path => path.endsWith('/dns') ? { ...dns(), extra: 'internal', zones: dns().zones.map(row => ({ ...row, content: 'zone body' })) } : certificates([{ ...panel(), pem: '-----BEGIN CERTIFICATE-----' }]))
    const response = (await call(get('/api/server/services/dns'), value))!
    const body = await response.json()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual(dns())
    expect(events).toEqual(['auth', 'root:server.services.detail', 'agent:/host/services/detail/dns'])
    const certs = await (await call(get('/api/server/services/certificates'), value))!.json()
    expect(JSON.stringify(certs)).not.toContain('BEGIN CERTIFICATE')
  })
  it('forwards a zone check with the exact canonical zone', async () => {
    const { value, events } = helpers()
    expect(await (await call(get('/api/server/services/dns/zone-check?zone=example.com'), value))!.json()).toEqual(check())
    expect(events).toEqual(['auth', 'root:server.services.dns.check', 'agent:/host/services/detail/dns/zone-check?zone=example.com'])
  })
  it('returns 403 for non-root callers before contacting the agent', async () => {
    const { value } = helpers()
    value.assertRoot = async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN', status: 403 }) }
    for (const path of ['/api/server/services/dns', '/api/server/services/ftp', '/api/server/services/certificates', '/api/server/services/dns/zone-check?zone=example.com']) await expect(call(get(path), value)).rejects.toMatchObject({ status: 403 })
    expect(value.readDetail).not.toHaveBeenCalled()
  })
  it('rejects selectors, bad zone grammar and methods with 400-class errors before dispatch', async () => {
    const { value } = helpers()
    for (const path of ['/api/server/services/dns?zone=example.com', '/api/server/services/certificates?path=/etc/shadow', '/api/server/services/dns/zone-check', '/api/server/services/dns/zone-check?zone=Example.com',
      '/api/server/services/dns/zone-check?zone=--help', '/api/server/services/dns/zone-check?zone=example.com&zone=b.net', '/api/server/services/dns/zone-check?zone=example.com&x=1']) {
      await expect(call(get(path), value)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    }
    expect((await call(get('/api/server/services/ftp', 'POST'), value))!.status).toBe(405)
    expect(value.readDetail).not.toHaveBeenCalled()
    await expect(call(get('/api/server/services/dns'), { ...value, readDetail: undefined })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('refuses inconsistent DNS observations', () => {
    const row = dns().zones[0]!
    for (const bad of [dns({ zoneDir: '/etc' }), dns({ control: { state: 'unreachable', version: '4.8.3' } }), dns({ zones: [row, row] }), dns({ zones: [{ ...row, zone: '../etc' }] }), dns({ zones: [{ ...row, fileSerial: null }] }),
      dns({ zones: [{ ...row, file: 'malformed' }] }), dns({ zones: [{ ...row, desired: false }] }), dns({ savedState: 'unavailable' }), dns({ directory: 'unavailable' }), dns({ zones: Array.from({ length: 2001 }, () => row) }), dns({ service: { ...pdns, id: 'nginx' } }),
      dns({ service: { ...pdns, unit: null } }), { ...dns(), kind: 'ftp' }]) expect(() => projectDnsDetail(bad)).toThrow()
    expect(projectDnsDetail(dns({ service: null, control: { state: 'unreachable', version: null } })).service).toBeNull()
  })
  it('refuses inconsistent FTP, zone check and certificate observations', () => {
    for (const bad of [ftp({ confDir: '/tmp' }), ftp({ settings: [{ name: 'TLS', desired: '2', observed: '1', state: 'match' }] }), ftp({ settings: [{ name: 'TLS', desired: '2', observed: null, state: 'drift' }] }), ftp({ ftpAccounts: -1 })]) expect(() => projectFtpDetail(bad)).toThrow()
    for (const bad of [check({ zone: 'other.net' }), check({ errors: 1 }), check({ state: 'failed' }), check({ state: 'unavailable' }), check({ messages: ['x'.repeat(301)] })]) expect(() => projectZoneCheck(bad, 'example.com')).toThrow()
    expect(projectZoneCheck(check({ state: 'unavailable', records: null, errors: null, warnings: null }), 'example.com').state).toBe('unavailable')
    for (const endpoints of [[panel({ certificate: null })], [panel({ reason: 'not_pem' })], [panel({ state: 'unavailable', reason: null, certificate: null })], [{ ...notRendered('postfix'), certPath: '/etc/ssl/x.pem' }],
      [panel({ certificate: { ...cert, fingerprint256: 'x' } })], [panel({ certPath: '/etc/../shadow' })], [panel({ warnings: ['expired', 'expired'] })], [panel(), panel()], [panel({ id: 'nginx' })], [panel({ keyPath: null })]]) {
      expect(() => projectCertificatesDetail(certificates(endpoints))).toThrow()
    }
    expect(projectCertificatesDetail(certificates([panel({ state: 'missing', reason: 'config_missing', certPath: null, keyPath: null, keyPresent: null, certificate: null, ports: [] })])).endpoints[0]!.state).toBe('missing')
  })
})
