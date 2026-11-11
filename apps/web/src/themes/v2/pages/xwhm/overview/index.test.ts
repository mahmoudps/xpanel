import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { v2Messages } from '../../../messages.ts'
import { renderV2WhmOverview } from './index.ts'
import { renderV2WhmSecurityOverview } from '../security/overview.ts'

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
    expect(renderV2WhmOverview(t, { ...base, hostSample: { hostname: 'h', uptimeSeconds: 90_000 } })).toContain('1 d 1 h')
  })

  it('draws stored performance history and leaves out intervals without a sample', () => {
    const html = renderV2WhmOverview(t, { ...base, hostSample: { hostname: 'host.example.test', memory: { totalBytes: 2 * 1024 ** 3, availableBytes: 1024 ** 3 } },
      performanceHistory: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', cpuPercent: [10, null, 40, 20], memoryMb: [512, null, 1024, 768] } })
    expect(html).toContain('<figure class="v2-chart">')
    expect(html).toContain('CPU, peak 40%')
    expect(html).toContain('Memory, peak 50%')
    expect(html).toContain('3 of 4 intervals have samples.')
    expect(html).toContain('d="M0 90L0 90M192 60L288 80"')
    expect(html).toContain('d="M192 60L288 80L288 100L192 100Z"')
    expect(html).not.toContain('Performance history has not been read.')
    // Recent samples keep their end-of-window bucket positions instead of stretching across 24 hours.
    const recent = renderV2WhmOverview(t, { ...base, performanceHistory: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', cpuPercent: [null, null, 10, 20], memoryMb: [null, null, 512, 1024] } })
    expect(recent).toContain('2 of 4 intervals have samples.')
    expect(recent).toContain('d="M192 90L288 80"')
    expect(recent).not.toContain('d="M0 90L288 80"')
    // Memory needs the host total to become a percentage; without it only CPU is drawn.
    const cpuOnly = renderV2WhmOverview(t, { ...base, performanceHistory: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', cpuPercent: [10, 40], memoryMb: [512, 1024] } })
    expect(cpuOnly).toContain('CPU, peak 40%')
    expect(cpuOnly).not.toContain('Memory, peak')
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

  it('renders the dashboard TLS certificate renewal strip and live panel-access policy snapshot on /whm/security', () => {
    const healthyIso = new Date(Date.now() + 60 * 86_400_000).toISOString()
    const overview = renderV2WhmOverview(t, {
      ...base,
      certificates: [{
        accountId: 'acct-1',
        names: ['host.example.test'],
        notAfter: healthyIso,
      }],
      autoSsl: { state: 'active', nextRunAt: '2026-11-12T04:00:00.000Z', lastRunAt: null, renewDays: 30 },
    })
    expect(overview).toContain('data-cert-renewal-strip')
    expect(overview).toContain('1 TLS certificates healthy (0 expiring within 30 days)')
    expect(overview).toContain('Next AutoSSL renewal check: 2026-11-12 04:00 UTC')

    const secOverview = renderV2WhmSecurityOverview({
      locale: 'en',
      observationAuthority: { presentation: 'live', canRead: true, canManage: true },
      panelAccessSummary: {
        state: 'read',
        entrancePath: '/gate-secret',
        entranceListeners: ['xwhm'],
        listeners: { xwhm: 2, xpanel: 1, xmail: 0 },
      },
    })
    expect(secOverview).toContain('data-panel-access-entrance')
    expect(secOverview).toContain('/gate-secret')
    expect(secOverview).toContain('xWHM: 2, xPanel: 1, xMail: 0')
  })
})
