import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleWhmSecurityControlsRoute, SSH_AUTOBAN_BANS_STATE, SSH_AUTOBAN_UNBANS_STATE } from './whm-security-controls-routes.ts'
import type { WhmSecurityControlsHelpers } from './whm-security-controls-routes.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const USER = { principal: { kind: 'user', id: '22222222-2222-4222-8222-222222222222', username: 'alice', accountId: '33333333-3333-4333-8333-333333333333' }, sessionId: 'two', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-sec-ctrl-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function setup(overrides: Partial<WhmSecurityControlsHelpers> = {}, caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers: WhmSecurityControlsHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }),
    emitAudit: vi.fn(async () => undefined),
    triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    store: {
      rootDir: root,
      getWriterLock: (() => ({ acquire: async () => lease })) as never,
      getServerSettings: async () => ({
        phpFunctionExceptions: [{ account: 'alice', functions: ['exec'], reason: 'queue worker', grantedAt: '2026-11-01T00:00:00.000Z', grantedBy: 'root' }],
      }) as never,
    },
    now: () => new Date('2026-11-20T10:00:00.000Z'),
    ...overrides,
  }
  const send = (path: string, method = 'GET', body?: unknown) =>
    handleWhmSecurityControlsRoute(
      new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }),
      new URL('http://api.test' + path),
      method,
      helpers,
    )
  return { helpers, send }
}

describe('WHM security C1 controls routes', () => {
  it('enforces root-only access and handles GET/PUT /api/server/sec/php-functions', async () => {
    const denied = setup({}, USER)
    await expect(denied.send('/api/server/sec/php-functions')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const h = setup()
    const initial = await (await h.send('/api/server/sec/php-functions'))!.json()
    expect(initial.state).toBe('default')
    expect(initial.disabled).toEqual(['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen'])
    expect(initial.exceptions).toHaveLength(1)

    await expect(h.send('/api/server/sec/php-functions', 'PUT', { expectedRevision: initial.revision, disabled: ['strlen'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    const saved = await (await h.send('/api/server/sec/php-functions', 'PUT', { expectedRevision: initial.revision, disabled: ['shell_exec', 'system', 'passthru'] }))!.json()
    expect(saved.state).toBe('saved')
    expect(saved.disabled).toEqual(['passthru', 'shell_exec', 'system'])
    expect(saved.reconcile).toBe('requested')
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.sec.php_functions.updated', outcome: 'ok' }))
    await expect(h.send('/api/server/sec/php-functions', 'PUT', { expectedRevision: initial.revision, disabled: ['exec'] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('handles GET/PUT /api/server/sec/ssh-autoban and POST /api/server/sec/ssh-autoban/unban with audit', async () => {
    await mkdir(join(root, 'extended/server'), { recursive: true })
    await writeFile(join(root, SSH_AUTOBAN_BANS_STATE), JSON.stringify([{ address: '203.0.113.10', since: '2026-11-20T09:00:00.000Z', until: '2026-11-20T11:00:00.000Z', reason: 'sshd', jail: 'sshd' }]))
    const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => {
      if (path === '/host/security-tools/intrusion') {
        return { observedAt: '2026-11-20T09:59:00.000Z', state: 'read', jails: [{ name: 'sshd', state: 'read', currentlyFailed: 3, totalFailed: 12, currentlyBanned: 1, totalBanned: 4, banned: ['198.51.100.22'], truncated: false }], unsupportedJails: 0, jailsTruncated: false }
      }
      if (path === '/host/firewall/bans') {
        return { observedAt: '2026-11-20T09:59:00.000Z', state: 'read', bans: [{ address: '203.0.113.10', timeoutSec: 1800, expiresSec: 1800 }, { address: '192.0.2.88', timeoutSec: 1800, expiresSec: 1800 }] }
      }
      if (path === '/host/firewall/bans/unban') {
        return { unbanned: body?.addresses ?? [], stillBanned: [] }
      }
      return { jail: body?.jail, address: body?.address, outcome: 'confirmed', verificationRequired: false, after: { banned: false }, observedAt: '2026-11-20T10:00:00.000Z' }
    })
    const h = setup({ callHost })
    const initial = await (await h.send('/api/server/sec/ssh-autoban'))!.json()
    expect(initial.state).toBe('default')
    expect(initial.policy).toEqual({ enabled: false, failures: 5, windowMin: 10, banMin: 60 })
    expect(initial.banned.map((row: { address: string }) => row.address)).toEqual(['203.0.113.10', '198.51.100.22', '192.0.2.88'])

    await expect(h.send('/api/server/sec/ssh-autoban', 'PUT', { expectedRevision: initial.revision, policy: { enabled: true, failures: 501, windowMin: 15, banMin: 120 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    const updated = await (await h.send('/api/server/sec/ssh-autoban', 'PUT', { expectedRevision: initial.revision, policy: { enabled: true, failures: 500, windowMin: 15, banMin: 120 } }))!.json()
    expect(updated.state).toBe('saved')
    expect(updated.policy).toEqual({ enabled: true, failures: 500, windowMin: 15, banMin: 120 })

    const unbanned = await (await h.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: '203.0.113.10', jail: 'sshd' }))!.json()
    expect(unbanned).toEqual({ address: '203.0.113.10', jail: 'sshd', outcome: 'confirmed' })
    expect(callHost).toHaveBeenCalledWith(expect.anything(), '/host/firewall/bans/unban', { addresses: ['203.0.113.10'] })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.sec.ssh_autoban.unban', outcome: 'ok' }))
    const unbanCutoffs = JSON.parse(await readFile(join(root, SSH_AUTOBAN_UNBANS_STATE), 'utf8')) as { version: number; cutoffs: Record<string, string> }
    expect(unbanCutoffs).toEqual({ version: 1, cutoffs: { '203.0.113.10': '2026-11-20T10:00:00.000Z' } })
    await expect(h.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: 'not-an-ip' })).rejects.toMatchObject({ code: 'VALIDATION' })

    const isolated = setup({})
    await expect(isolated.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: '203.0.113.11', jail: 'sshd' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const unbanCutoffsAfter404 = JSON.parse(await readFile(join(root, SSH_AUTOBAN_UNBANS_STATE), 'utf8')) as { version: number; cutoffs: Record<string, string> }
    expect(unbanCutoffsAfter404.cutoffs['203.0.113.11']).toBeUndefined()

    await writeFile(join(root, SSH_AUTOBAN_BANS_STATE), JSON.stringify([{ address: '203.0.113.55', since: '2026-11-20T09:00:00.000Z', until: '2026-11-20T11:00:00.000Z', reason: 'sshd', jail: 'sshd' }]))
    const fail2banRejected = setup({
      callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
        if (path === '/host/security-tools/intrusion') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'read', jails: [{ name: 'sshd', state: 'read', currentlyFailed: 1, totalFailed: 1, currentlyBanned: 1, totalBanned: 1, banned: ['203.0.113.55'], truncated: false }], unsupportedJails: 0, jailsTruncated: false }
        }
        if (path === '/host/security-tools/intrusion/unban') {
          return fail('PRECONDITION_FAILED', 'fail2ban did not accept the unban; the address is still banned', { stateChanged: false })
        }
        if (path === '/host/firewall/bans') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'read', bans: [{ address: '203.0.113.55', timeoutSec: 1800, expiresSec: 1800 }] }
        }
        return { unbanned: ['203.0.113.55'], stillBanned: [] }
      }),
    })
    await expect(fail2banRejected.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: '203.0.113.55', jail: 'sshd' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(fail2banRejected.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.sec.ssh_autoban.unban', outcome: 'failed' }))
    const bansAfterRejection = JSON.parse(await readFile(join(root, SSH_AUTOBAN_BANS_STATE), 'utf8')) as Array<{ address: string }>
    expect(bansAfterRejection.map(row => row.address)).toEqual(['203.0.113.55'])

    const nftOnlyHost = setup({
      callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
        if (path === '/host/security-tools/intrusion') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'not_installed', jails: [], unsupportedJails: 0, jailsTruncated: false }
        }
        if (path === '/host/security-tools/intrusion/unban') {
          return fail('PRECONDITION_FAILED', 'the protected host request was refused', { stateChanged: false })
        }
        if (path === '/host/firewall/bans') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'read', bans: [{ address: '203.0.113.55', timeoutSec: 1800, expiresSec: 1800 }] }
        }
        return { unbanned: ['203.0.113.55'], stillBanned: [] }
      }),
    })
    const nftOnlyRes = await (await nftOnlyHost.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: '203.0.113.55', jail: 'sshd' }))!.json()
    expect(nftOnlyRes).toEqual({ address: '203.0.113.55', jail: 'sshd', outcome: 'confirmed' })
    const bansAfterNftOnly = JSON.parse(await readFile(join(root, SSH_AUTOBAN_BANS_STATE), 'utf8')) as Array<{ address: string }>
    expect(bansAfterNftOnly).toEqual([])

    await writeFile(join(root, SSH_AUTOBAN_BANS_STATE), JSON.stringify([{ address: '203.0.113.66', since: '2026-11-20T09:00:00.000Z', until: '2026-11-20T11:00:00.000Z', reason: 'sshd', jail: 'sshd' }]))
    const fwUnavailableHost = setup({
      callHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
        if (path === '/host/security-tools/intrusion') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'not_installed', jails: [], unsupportedJails: 0, jailsTruncated: false }
        }
        if (path === '/host/firewall/bans') {
          return { observedAt: '2026-11-20T09:59:00.000Z', state: 'unavailable', bans: [] }
        }
        return {}
      }),
    })
    const fwUnavailableRes = await (await fwUnavailableHost.send('/api/server/sec/ssh-autoban/unban', 'POST', { address: '203.0.113.66', jail: 'sshd' }))!.json()
    expect(fwUnavailableRes).toEqual({ address: '203.0.113.66', jail: 'sshd', outcome: 'unknown' })
    const bansAfterFwUnavailable = JSON.parse(await readFile(join(root, SSH_AUTOBAN_BANS_STATE), 'utf8')) as Array<{ address: string }>
    expect(bansAfterFwUnavailable.map(row => row.address)).toEqual(['203.0.113.66'])
  })
})
