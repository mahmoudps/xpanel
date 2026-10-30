import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { v2Messages } from '../../../messages.ts'
import { renderV2WhmOverview } from './index.ts'

const t = v2Messages.translator('en')
const principal: Principal = { kind: 'root', id: 'internal-root', username: 'operator' }
const base = { principal, visibility: { principal } }

describe('v2 server overview observations', () => {
  it('retains unknown resource and reconcile states without invented healthy samples', () => {
    const html = renderV2WhmOverview(t, base)
    expect(html).toContain('Performance history has not been read.')
    expect(html).toContain('The applied state has not been read.')
    expect(html).toContain('Background jobs have not been read.')
    expect(html).not.toContain('>In sync<')
    expect(html).not.toContain('gen 142')
    expect(html).not.toContain('>28<')
  })

  it('shows only measured host and service states, with escaped technical values', () => {
    const html = renderV2WhmOverview(t, { ...base, generationId: 4, driftCount: 0, hostSample: { hostname: '<bad>', memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 6 * 1024 ** 3 }, load1: 0.25, cores: 4 }, services: [{ name: 'nginx', unit: 'nginx.service', version: '1', active: false, enabled: true, rssMb: 0, role: 'web' }, { name: 'redis', unit: 'redis.service', version: '', active: false, enabled: false, rssMb: 0, role: 'cache', checked: false }] })
    expect(html).toContain('>In sync<')
    expect(html).toContain('>2 GiB<')
    expect(html).toContain('&lt;bad&gt;')
    expect(html).toContain('>Stopped<')
    expect(html).toContain('>Not checked<')
  })

  it('does not expose a server overview to an account principal', () => {
    expect(renderV2WhmOverview(t, { principal: { kind: 'user', id: 'u', username: 'u', accountId: 'a' }, hostname: 'private-host' })).not.toContain('private-host')
  })

  it('preserves actual audit events through human labels and hides opaque target references', () => {
    const html = renderV2WhmOverview(t, { ...base, auditEntries: [
      { id: 'private-ledger-id', at: '2026-10-29T18:05:00Z', actor: 'root', action: 'account.suspended', target: 'account:alpha', detail: {}, outcome: 'ok' },
      { id: 'private-ledger-id-2', at: '2026-10-29T18:04:00Z', actor: 'user:mbx0123456789abcdef', action: 'private.unrecognized.code', target: 'account:7fe33780-3d88-4ea3-bc66-c633ac39c141', detail: { private: 'not-rendered' }, outcome: 'failed' },
    ] })
    expect(html).toContain('Suspended an account')
    expect(html).toContain('alpha')
    expect(html).toContain('Recorded event')
    expect(html).toContain('2026-10-29T18:05:00Z')
    for (const internal of ['private-ledger-id', 'private.unrecognized.code', '7fe33780-3d88-4ea3-bc66-c633ac39c141', 'mbx0123456789abcdef', 'not-rendered']) expect(html).not.toContain(internal)
    expect(renderV2WhmOverview(t, { ...base, auditEntries: [] })).toContain('No audit entries yet')
  })
})
