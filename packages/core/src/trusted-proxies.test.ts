import { describe, expect, it } from 'vitest'
import { admitTrustedProxyRenderPolicy, assertTrustedProxyAdmission, parseTrustedProxyPolicy, readAdmittedTrustedProxyPolicy, readTrustedProxyRecord, renderTrustedProxyRealIp, resolveTrustedProxyClient, trustedProxyRevision } from './trusted-proxies.ts'
import type { ProtectedProxyIngress, TrustedProxyRenderAuthority } from './trusted-proxies.ts'

const policy = { cidrs: ['173.245.48.0/20', '2400:cb00::/32'], header: 'X-Forwarded-For' as const }
const proof = (): ProtectedProxyIngress => ({ kind: 'protected-dedicated-ingress-v1', localAddresses: ['127.0.0.1', '192.0.2.1'], managementClient: '198.51.100.50', dedicatedCidrs: policy.cidrs })
describe('canonical proxy policy', () => {
  it('accepts a bounded canonical list and a default-deny empty list', () => {
    expect(parseTrustedProxyPolicy({ ...policy, cidrs: [...policy.cidrs].reverse() })).toEqual(policy)
    expect(parseTrustedProxyPolicy({ cidrs: [], header: 'X-Forwarded-For' })).toEqual({ cidrs: [], header: 'X-Forwarded-For' })
  })
  it('rejects all alternate grammar, local/shared and ambiguous networks', () => {
    for (const cidr of ['0.0.0.0/0', '10.0.0.0/8', '100.64.0.1/32', '127.0.0.1/32', '169.254.0.1/32', '172.16.0.0/16', '192.168.1.1/32', '224.0.0.1/32', '240.0.0.1/32', '::/0', '::1/128', 'fc00::/32', 'fe80::/64', 'ff00::/32', '::ffff:127.0.0.1/128', '::127.0.0.1/128', '173.245.48.1/20', '173.245.48.0', '173.245.48.0/020', '173.245.48.0/20;evil', '2400:CB00::/32']) {
      expect(() => parseTrustedProxyPolicy({ cidrs: [cidr], header: 'X-Forwarded-For' }), cidr).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    }
    expect(() => parseTrustedProxyPolicy({ ...policy, header: 'CF-Connecting-IP' })).toThrow()
    expect(() => parseTrustedProxyPolicy({ ...policy, providerApproved: true })).toThrow()
    expect(() => parseTrustedProxyPolicy({ ...policy, cidrs: ['173.245.48.0/20', '173.245.48.1/32'] })).toThrow()
    expect(() => parseTrustedProxyPolicy({ ...policy, cidrs: ['173.245.48.0/20', '173.245.48.0/20'] })).toThrow()
  })
  it('refuses local interfaces, direct management clients and networks without protected dedicated proof', () => {
    expect(() => parseTrustedProxyPolicy(policy, ['173.245.48.2'])).toThrow()
    expect(() => parseTrustedProxyPolicy(policy, ['::ffff:173.245.48.2'])).toThrow()
    expect(() => assertTrustedProxyAdmission(policy, { ...proof(), managementClient: '173.245.48.5' })).toThrow()
    expect(() => assertTrustedProxyAdmission(policy, { ...proof(), dedicatedCidrs: [] })).toThrow()
    expect(() => assertTrustedProxyAdmission(policy, { ...proof(), localAddresses: [] })).toThrow()
  })
  it('reads only the exact canonical versioned record', () => {
    const record = { version: 1 as const, policy, updatedAt: '2026-10-27T12:00:00.000Z' }
    expect(readTrustedProxyRecord(record)).toEqual(record)
    expect(readTrustedProxyRecord({ ...record, active: true })).toBeNull()
    expect(readTrustedProxyRecord({ ...record, updatedAt: 'today' })).toBeNull()
    expect(readTrustedProxyRecord({ ...record, policy: { ...policy, cidrs: [...policy.cidrs].reverse() } })).toBeNull()
    expect(trustedProxyRevision(record)).not.toBe(trustedProxyRevision(null))
  })
  it('renders finite fixed-header directives but gives saved JSON no activation authority', () => {
    expect(renderTrustedProxyRealIp(policy)).toBe('set_real_ip_from 173.245.48.0/20;\nset_real_ip_from 2400:cb00::/32;\nreal_ip_header X-Forwarded-For;\nreal_ip_recursive off;\n')
    expect(renderTrustedProxyRealIp({ cidrs: [], header: 'X-Forwarded-For' })).not.toContain('set_real_ip_from')
    const admitted = admitTrustedProxyRenderPolicy(policy, proof())
    expect(readAdmittedTrustedProxyPolicy(admitted)).toEqual(policy)
    const forged = JSON.parse(JSON.stringify(admitted)) as TrustedProxyRenderAuthority
    expect(() => readAdmittedTrustedProxyPolicy(forged)).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED' }))
    const copy = readAdmittedTrustedProxyPolicy(admitted); copy.cidrs.push('8.8.8.8/32')
    expect(readAdmittedTrustedProxyPolicy(admitted)).toEqual(policy)
  })
})
describe('forwarding-chain boundary', () => {
  it('ignores every forged identity/protocol header from an untrusted socket peer', () => {
    expect(resolveTrustedProxyClient(policy, '198.51.100.55', new Headers({ 'x-forwarded-for': '173.245.48.1', 'x-real-ip': '8.8.8.8', 'x-forwarded-proto': 'https', forwarded: 'for=8.8.8.8;proto=https' }), proof())).toEqual({ clientIp: '198.51.100.55', trusted: false, forwardedHttps: false })
  })
  it('accepts only one overwritten address/protocol from a protected dedicated peer', () => {
    expect(resolveTrustedProxyClient(policy, '173.245.48.1', new Headers({ 'x-forwarded-for': '198.51.100.55', 'x-forwarded-proto': 'https', forwarded: 'for=8.8.8.8' }), proof())).toEqual({ clientIp: '198.51.100.55', trusted: true, forwardedHttps: true })
    const rejectedHeaders: ReadonlyArray<Record<string, string>> = [{ 'x-forwarded-for': '8.8.8.8,198.51.100.55', 'x-forwarded-proto': 'https' }, { 'x-forwarded-for': 'invalid', 'x-forwarded-proto': 'https' }, { 'x-real-ip': '198.51.100.55', 'x-forwarded-proto': 'https' }, { 'x-forwarded-for': '198.51.100.55', 'x-forwarded-proto': 'javascript' }]
    for (const values of rejectedHeaders)
      expect(() => resolveTrustedProxyClient(policy, '173.245.48.1', new Headers(values), proof())).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }))
  })
})
