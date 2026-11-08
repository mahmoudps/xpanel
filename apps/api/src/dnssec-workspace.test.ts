import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDnssecRoute, parseDnssecBody } from './dnssec-workspace.ts'

const zone = 'alice.example.test'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const key = (id: number, type: 'KSK' | 'ZSK' | 'CSK', active = true) => ({ id, type, active, published: true, bits: 256, algorithm: 'ECDSAP256SHA256', tag: 1000 + id, dnskey: null, ds: [] })
const view = (keys: ReturnType<typeof key>[]) => ({ zone, store: 'ready', served: true, signing: keys.length ? 'signed' : 'unsigned', nsec: keys.length ? { mode: 'nsec', optOut: false, narrow: false } : null, keys, publication: keys.length ? 'current' : 'none', dnskeyTtl: 3600, observedAt: '2026-11-07T10:00:00.000Z' })

async function fixture(options: { owner?: boolean; agent?: (body: Record<string, unknown>) => Response } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-dnssec-')); dirs.push(rootDir)
  const account = { id: 'acc-1', username: 'alice', status: 'active' }
  const caller = { principal: { id: 'p-1', kind: 'user', username: 'alice', accountId: account.id } } as unknown as AuthenticatedCaller
  let clock = Date.parse('2026-11-07T10:00:00.000Z')
  const calls: Record<string, unknown>[] = []
  const store = { rootDir, getDnsZone: async (name: string) => name === zone ? { name, accountId: account.id } : null, getAccount: async () => account,
    getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }) } as unknown as StateStore
  const ports = { store, requireCaller: async () => caller, assertRoot: async () => fail('FORBIDDEN', 'root'),
    assertCanAccessAccount: async () => { if (options.owner === false) fail('FORBIDDEN', 'not yours') },
    callAgent: async (_path: string, { body }: { body: unknown }) => { calls.push(body as Record<string, unknown>); return options.agent!(body as Record<string, unknown>) },
    now: () => new Date(clock) }
  const send = (method: string, body?: unknown) => handleDnssecRoute(new Request(`http://panel.local/api/dns/zones/${zone}/dnssec`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), new URL(`http://panel.local/api/dns/zones/${zone}/dnssec`), method, ports)
  return { send, calls, rootDir, advance: (ms: number) => { clock += ms } }
}
const ok = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

describe('DNSSEC workspace', { tags: ['feature'] }, () => {
  it('records a KSK rollover, waits for caches and the registrar, then finishes it', async () => {
    let keys = [key(1, 'CSK')]
    const t = await fixture({ agent: body => {
      if (body.op === 'rollover-start') { keys = [...keys, key(2, 'CSK')]; return ok({ view: view(keys), addedKeyIds: [2] }) }
      if (body.op === 'rollover-finish') { keys = [key(2, 'CSK')]; return ok({ view: view(keys), addedKeyIds: [] }) }
      return ok({ view: view(keys), addedKeyIds: [] })
    } })
    const started = await t.send('POST', { op: 'rollover-start', keyId: 1 })
    expect(await started!.json()).toMatchObject({ rollovers: [{ keyId: 1, newKeyId: 2, type: 'CSK', notBefore: '2026-11-07T11:01:30.000Z', ready: false }] })
    await expect(t.send('POST', { op: 'rollover-finish', keyId: 1, newKeyId: 2, dsUpdated: true })).rejects.toMatchObject({ detail: { reason: 'rollover_wait', notBefore: '2026-11-07T11:01:30.000Z' } })
    t.advance(3_700_000)
    await expect(t.send('POST', { op: 'rollover-finish', keyId: 1, newKeyId: 2 })).rejects.toMatchObject({ detail: { reason: 'rollover_ds_unconfirmed' } })
    expect(t.calls.filter(call => call.op === 'rollover-finish')).toHaveLength(0)
    const finished = await t.send('POST', { op: 'rollover-finish', keyId: 1, newKeyId: 2, dsUpdated: true })
    expect(await finished!.json()).toMatchObject({ rollovers: [], view: { keys: [{ id: 2 }] } })
    expect(t.calls.at(-1)).toEqual({ op: 'rollover-finish', keyId: 1, newKeyId: 2 })
    expect(JSON.parse(await readFile(join(t.rootDir, 'extended', 'dns', 'dnssec', zone + '.json'), 'utf8'))).toEqual({ zone, rollovers: [] })
  })
  it('keeps the agent reason of a refusal and marks an unreadable mutation reply as uncertain', async () => {
    const refused = await fixture({ agent: () => new Response(JSON.stringify({ details: { reason: 'last_active_key', stateChanged: false } }), { status: 412 }) })
    await expect(refused.send('POST', { op: 'key', verb: 'remove', keyId: 1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'last_active_key', stateChanged: false } })
    const garbled = await fixture({ agent: () => ok({ view: { zone: 'other.test' }, addedKeyIds: [] }) })
    await expect(garbled.send('POST', { op: 'enable', algorithm: 'ecdsa256', layout: 'csk' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
  })
  it('refuses another account before reaching the agent, and turning DNSSEC off without the typed zone', async () => {
    const t = await fixture({ owner: false, agent: () => ok({}) })
    await expect(t.send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.calls).toHaveLength(0)
    expect(() => parseDnssecBody({ op: 'disable' }, zone)).toThrow()
    expect(parseDnssecBody({ op: 'disable', confirm: zone }, zone)).toEqual({ request: { op: 'disable' }, dsUpdated: false })
    expect(() => parseDnssecBody({ op: 'read' }, zone)).toThrow()
    expect(() => parseDnssecBody({ op: 'enable', algorithm: 'ecdsa256', layout: 'csk', extra: 1 }, zone)).toThrow()
  })
})
