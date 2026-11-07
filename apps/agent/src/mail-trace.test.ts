import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleMailTraceRoute, readDnssecFlag, traceMailRoute } from './mail-trace.ts'
import type { MailTraceDns, MailTracePorts } from './mail-trace.ts'
import { isMailTraceCommand, mailTraceDigArgv } from '../../../packages/os/src/mail-trace-command.ts'
import type { MailxSaved } from './mailx-policy.ts'

const none = Object.assign(new Error('none'), { code: 'ENODATA' })
const dns = (overrides: Partial<MailTraceDns> = {}): MailTraceDns => ({ mx: async () => [{ exchange: 'mx2.remote.test', priority: 20 }, { exchange: 'mx1.remote.test', priority: 10 }], v4: async () => ['192.0.2.25'], v6: async () => { throw none }, ...overrides })
const saved = (relay = false): MailxSaved => ({ archives: [], sections: { spam: null, relay: relay ? { section: 'relay', policy: { enabled: true, host: 'smtp.relay.test', port: 587, username: null }, secret: null, updatedAt: '', updatedBy: '' } : null, bcc: null, marketing: null, server: null,
  routing: { section: 'routing', policy: { domains: [{ domain: 'moved.test', mode: 'remote' }] }, updatedAt: '', updatedBy: '' } } } as never)
const snapshot = { accounts: [{ id: 'a', username: 'alice', status: 'active', home: '/home/alice' }], domains: [{ id: 'd', name: 'alice.test', accountId: 'a' }, { id: 'e', name: 'moved.test', accountId: 'a' }],
  serviceUsers: [{ id: 'u', accountId: 'a', login: 'info@alice.test', services: { email: true } }] }
let stateRoot = ''
beforeAll(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'mail-trace-'))
  await mkdir(join(stateRoot, 'extended', 'mail'), { recursive: true })
  await writeFile(join(stateRoot, 'extended', 'mail', 'forwarders.json'), JSON.stringify([{ id: 'f', accountId: 'a', sourceAddress: 'sales@alice.test', destinations: ['boss@remote.test'], createdAt: '2026-11-07T00:00:00.000Z' }]))
})
afterAll(() => rm(stateRoot, { recursive: true, force: true }))
const ports = (overrides: Partial<MailTracePorts> = {}): MailTracePorts => ({ dns: dns(), connect: async () => true, run: async () => ({ ok: true, code: 0, stdout: ';; flags: qr rd ra ad; QUERY: 1, ANSWER: 1\n' }), saved: saved(), snapshot, stateRoot, now: () => new Date('2026-11-07T10:00:00Z'), ...overrides })

describe('mail route trace', () => {
  it('fails at the remote domain lookup when a domain has no MX or address', async () => {
    const result = await traceMailRoute('x@nowhere.test', ports({ dns: dns({ mx: async () => { throw none }, v4: async () => { throw none } }) }))
    expect(result).toMatchObject({ deliverable: false, failedStep: 'remote-domain-lookup', route: 'remote' })
    expect(result.steps.at(-1)).toEqual({ step: 'remote-domain-lookup', state: 'failed', reason: 'no_mx_or_address' })
  })
  it('returns the MX hosts by priority with their addresses and DNSSEC state', async () => {
    const result = await traceMailRoute('x@remote.test', ports())
    expect(result).toMatchObject({ deliverable: true, failedStep: null, dnssec: 'validated', route: 'remote' })
    expect(result.hosts[0]).toEqual({ host: 'mx1.remote.test', priority: 10, addresses: ['192.0.2.25'], connected: true })
  })
  it('uses the domain itself without MX records and honours a null MX', async () => {
    expect((await traceMailRoute('x@remote.test', ports({ dns: dns({ mx: async () => { throw none } }) }))).hosts).toEqual([{ host: 'remote.test', priority: 0, addresses: ['192.0.2.25'], connected: true }])
    expect((await traceMailRoute('x@remote.test', ports({ dns: dns({ mx: async () => [{ exchange: '', priority: 0 }] }) }))).steps.at(-1)).toMatchObject({ reason: 'null_mx' })
  })
  it('names the host address and connect steps when they fail', async () => {
    expect(await traceMailRoute('x@remote.test', ports({ dns: dns({ v4: async () => { throw none } }) }))).toMatchObject({ failedStep: 'remote-host-address' })
    expect(await traceMailRoute('x@remote.test', ports({ connect: async () => false }))).toMatchObject({ failedStep: 'remote-host-connect', deliverable: false })
  })
  it('stops at a failed lookup, never reports a timeout as no records', async () => {
    const result = await traceMailRoute('x@remote.test', ports({ dns: dns({ mx: async () => { throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }) } }) }))
    expect(result.steps.at(-1)).toEqual({ step: 'remote-domain-lookup', state: 'failed', reason: 'lookup_failed' })
  })
  it('routes hosted addresses from saved state without DNS', async () => {
    const quiet = dns({ mx: async () => { throw new Error('no lookup expected') } })
    expect(await traceMailRoute('info@alice.test', ports({ dns: quiet }))).toMatchObject({ route: 'local-mailbox', deliverable: true })
    expect(await traceMailRoute('sales@alice.test', ports({ dns: quiet }))).toMatchObject({ route: 'forwarder', destination: 'boss@remote.test' })
    expect(await traceMailRoute('ghost@alice.test', ports({ dns: quiet }))).toMatchObject({ route: 'not-accepted', failedStep: 'local-route' })
  })
  it('treats a remote-routed domain as remote and a smart host as the next hop', async () => {
    expect(await traceMailRoute('info@moved.test', ports())).toMatchObject({ route: 'remote', deliverable: true })
    const connect = async () => { throw new Error('no connect expected') }
    expect(await traceMailRoute('x@remote.test', ports({ saved: saved(true), connect }))).toMatchObject({ route: 'relay-host', relayHost: 'smtp.relay.test', deliverable: true })
  })
  it('keeps DNSSEC unknown when dig is unavailable and reads the flag exactly', async () => {
    expect((await traceMailRoute('x@remote.test', ports({ run: null }))).dnssec).toBe('unknown')
    expect(readDnssecFlag(';; flags: qr rd ra; QUERY: 1\n')).toBe('not-validated')
    expect(readDnssecFlag('garbage')).toBe('unknown')
  })
  it('refuses an invalid address at the first step', async () => {
    expect(await traceMailRoute('not an address', ports())).toMatchObject({ failedStep: 'address', deliverable: false })
  })
})

describe('mail trace grammar and route', () => {
  it('admits only the reviewed dig call', () => {
    expect(isMailTraceCommand(mailTraceDigArgv('remote.test'))).toBe(true)
    expect(isMailTraceCommand(['/usr/bin/dig', '+time=3', '+tries=1', '+adflag', '+noall', '+comments', 'MX', '-f/etc/shadow'])).toBe(false)
    expect(() => mailTraceDigArgv('-x')).toThrow()
  })
  it('requires root and one address', async () => {
    const ctx = { ...ports(), assertRoot: async () => ({ actor: 'root' }), readSaved: async () => saved(), readSnapshot: async () => snapshot }
    const call = (body: string, method = 'POST') => { const req = new Request('http://agent/host/mail/trace', { method, ...(method === 'POST' ? { body } : {}) }); return handleMailTraceRoute(req, new URL(req.url), method, ctx) }
    expect((await call('', 'GET'))!.status).toBe(405)
    await expect(call('{"address":"x@remote.test","extra":1}')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await (await call('{"address":"X@Remote.test"}'))!.json()).toMatchObject({ address: 'x@remote.test', deliverable: true })
  })
})
