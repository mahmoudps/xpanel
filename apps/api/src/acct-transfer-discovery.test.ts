import { describe, expect, it, vi } from 'vitest'
import { createTransferSession, transition } from '@xpanel/lifecycle'
import { createTransferSourceDiscovery, parseTransferSourceInventory, peerMatchesPin, TRANSFER_SOURCE_INVENTORY_PATH } from './acct-transfer-discovery.ts'
import type { TransferSourceTransport } from './acct-transfer-discovery.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Synthetic transport only: no network. The production HTTPS transport is not exercised here.
const PIN = Array.from({ length: 32 }, () => 'AB').join(':')
const auth = { kind: 'api-token' as const, url: 'https://source.example.test', tokenId: '11111111-1111-4111-8111-111111111111', tlsFingerprint: PIN }
const inventory = () => ({ source: { hostname: 'source.example.test', version: '0.1.0' }, plans: [{ name: 'gold' }], accounts: [{ username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', domains: ['alice.example.test'], plan: 'gold', diskBytes: 4096, databases: ['alice_wp'], mailboxes: 2, phpVersions: ['8.3'] }] })
const caller = {} as AuthenticatedCaller
const reply = (body: unknown, status = 200, contentType = 'application/json; charset=utf-8') => ({ status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body) })

describe('transfer source discovery', () => {
  it('parses an exact inventory reply that the transfer reducer accepts', () => {
    const parsed = parseTransferSourceInventory(inventory())
    const session = transition(transition(createTransferSession({ id: '22222222-2222-4222-8222-222222222222', actor: 'root', now: '2026-10-28T00:00:00.000Z', auth }), { type: 'connected', source: parsed.source }, '2026-10-28T00:00:01.000Z'),
      { type: 'inventory', accounts: parsed.accounts, plans: parsed.plans }, '2026-10-28T00:00:02.000Z')
    expect(session.state).toBe('inventoried')
    expect(session.inventory?.accounts[0]?.diskBytes).toBe(4096)
  })
  it.each([
    ['extra top-level key', { ...inventory(), token: 'x' }],
    ['missing account field', { ...inventory(), accounts: [{ ...inventory().accounts[0], diskBytes: undefined }] }],
    ['negative disk', { ...inventory(), accounts: [{ ...inventory().accounts[0], diskBytes: -1 }] }],
    ['extra plan key', { ...inventory(), plans: [{ name: 'gold', owner: 'x' }] }],
    ['non-array accounts', { ...inventory(), accounts: {} }],
  ])('refuses a reply with %s', (_name, raw) => { expect(() => parseTransferSourceInventory(raw)).toThrow(/invalid inventory reply/) })
  it('sends only the stored token to the fixed inventory path with the pin', async () => {
    const transport = vi.fn<TransferSourceTransport>(async () => reply(inventory()))
    const discover = createTransferSourceDiscovery({ readToken: async id => id === auth.tokenId ? 'xp_secret' : null, transport })
    await expect(discover(caller, auth)).resolves.toMatchObject({ source: { hostname: 'source.example.test' } })
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://source.example.test' + TRANSFER_SOURCE_INVENTORY_PATH, token: 'xp_secret', tlsFingerprint: PIN }))
  })
  it.each([
    ['ssh credential', { kind: 'ssh-key', host: 'h.example.test', port: 22, user: 'root', keyId: auth.tokenId, hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43) }, async () => reply(inventory()), /SSH source discovery is unavailable/],
    ['missing credential', { ...auth, tokenId: '33333333-3333-4333-8333-333333333333' }, async () => reply(inventory()), /no longer exists/],
    ['network failure', auth, async () => { throw new Error('tls_pin_mismatch') }, /authenticated HTTPS channel/],
    ['refused token', auth, async () => reply({ code: 'FORBIDDEN' }, 403), /refused the stored credential/],
    ['HTML reply', auth, async () => reply('<html>', 200, 'text/html'), /did not return an inventory/],
    ['malformed JSON', auth, async () => reply('{', 200), /invalid inventory reply/],
  ] as const)('reports %s as a precondition without inventing inventory', async (_name, input, transport, message) => {
    const discover = createTransferSourceDiscovery({ readToken: async id => id === auth.tokenId ? 'xp_secret' : null, transport: transport as TransferSourceTransport })
    await expect(discover(caller, input as never)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: expect.stringMatching(message) })
  })
  it('matches the peer only by its exact SHA-256 fingerprint', () => {
    expect(peerMatchesPin({ getPeerCertificate: () => ({ fingerprint256: PIN }) } as never, PIN)).toBe(true)
    expect(peerMatchesPin({ getPeerCertificate: () => ({ fingerprint256: PIN.toLowerCase() }) } as never, PIN)).toBe(false)
    expect(peerMatchesPin({ getPeerCertificate: () => ({}) } as never, PIN)).toBe(false)
  })
})
