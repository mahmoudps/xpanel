import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { services } from '@xpanel/render'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { readRemoteServiceIps } from '../../agent/src/remote-service-ips.ts'
import { renderSecDnsClusterDropIn } from '../../agent/src/sec-dns-cluster.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleRemoteServiceIpsRoute } from './remote-service-ips-workspace.ts'

const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' } } as unknown as AuthenticatedCaller
const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })

describe('Remote Service IPs workspace', { tags: ['feature'] }, () => {
  it('saves the lists, reconciles mail, re-applies DNS, and the saved lists render into both configurations', async () => {
    const h = await createTestStateStore(); handles.push(h)
    const audits: Record<string, unknown>[] = [], applyDns = vi.fn(async () => ({ outcome: 'applied' }))
    const helpers = { requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root') }),
      emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }), store: h.store, reconcile: vi.fn(async () => ({ body: { status: 'applied' } })), applyDns }
    const call = async (method: string, body?: unknown) => { const url = new URL('http://localhost/api/server/remote-service-ips'); return (await handleRemoteServiceIpsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, helpers))!.json() }
    expect(await call('GET')).toEqual({ lists: { smtp: [], nameservers: [] } })
    expect(await call('PUT', { smtp: ['198.51.100.0/24'], nameservers: ['203.0.113.53'] })).toMatchObject({ lists: { smtp: ['198.51.100.0/24'], nameservers: ['203.0.113.53'] }, reconcile: { status: 'applied' }, dns: { outcome: 'applied' } })
    expect(applyDns).toHaveBeenCalledWith(root, expect.stringMatching(/^[0-9a-f]{64}$/))
    expect(audits.at(-1)).toMatchObject({ action: 'server.remote_service_ips.saved' })
    const saved = (await readRemoteServiceIps(h.store.rootDir))!
    expect(services.postfixMainSettings(profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), { limitExceptions: saved.smtp }).smtpd_client_event_limit_exceptions).toBe('$mynetworks, 198.51.100.0/24')
    expect(renderSecDnsClusterDropIn([], saved.nameservers)).toContain('allow-axfr-ips=127.0.0.0/8,::1,203.0.113.53')
    await expect(call('PUT', { smtp: ['not-an-address'], nameservers: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
