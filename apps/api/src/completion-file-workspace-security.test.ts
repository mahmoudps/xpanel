import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createResellerPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { AgentApp } from '@xpanel/agent'
import { sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const stamp = '2026-01-01T00:00:00.000Z'
const path = 'public_html/index.txt'
const editLimit = 1024 * 1024
const cleanup: Array<() => Promise<unknown>> = []
type Body = Record<string, unknown>
interface Entry { name: string; path: string; kind: 'file' | 'directory' | 'symlink'; sizeBytes: number; mode: number; mtime: string }
const entry = (target = path, patch: Partial<Entry> = {}): Entry => ({ name: target.split('/').at(-1)!, path: target, kind: 'file', sizeBytes: 9, mode: 0o640, mtime: stamp, ...patch })

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const features = await state.store.createFeatureList({ name: 'File workspace policy', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'File workspace plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = async (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null,
    contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const owner = await account('browse9'), other = await account('other9')
  const principal = await createUserPrincipal(database.db, { username: owner.username, accountId: owner.id, passwordHash: HASH })
  const mailbox = await state.store.createServiceUser({ accountId: owner.id, login: `inbox@${owner.primaryDomain}`, passwordHash: HASH,
    services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html' })
  const token = async (scopes: string[], principalId = principal.id) => {
    const raw = `xp_${randomUUID()}`
    await createApiToken(database.db, { principalId, name: 'Synthetic file workspace', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const credential = await token(['files:read', 'files:write'])
  const files = new Map<string, string>([[path, 'Original\n']])
  const directories = new Set(['public_html'])
  const trash = new Map<string, { id: string; originalPath: string; name: string; sizeBytes: number; deletedAt: string; content: string }>()
  const seen: Array<{ path: string; method: string; body: Body; principalId: string | null }> = []
  let override: ((body: Body, result: unknown) => Response | Promise<Response>) | undefined
  let applyBeforeOverride = true
  const text = (target: string) => ({ path: target, content: files.get(target) ?? '', sizeBytes: Buffer.byteLength(files.get(target) ?? '', 'utf8'), mtime: stamp })
  const perform = (body: Body): unknown => {
    const target = typeof body.path === 'string' ? body.path : ''
    switch (body.op) {
      case 'list': {
        const prefix = target ? target + '/' : ''
        return { entries: [...directories].filter(item => item.startsWith(prefix) && !item.slice(prefix.length).includes('/')).map(item => entry(item, { kind: 'directory', sizeBytes: 0, mode: 0o750 }))
          .concat([...files].filter(([item]) => item.startsWith(prefix) && !item.slice(prefix.length).includes('/')).map(([item, content]) => entry(item, { sizeBytes: Buffer.byteLength(content) }))) }
      }
      case 'read': return text(target)
      case 'write': files.set(target, typeof body.content === 'string' ? body.content : ''); return entry(target, { sizeBytes: Buffer.byteLength(files.get(target)!), mode: typeof body.mode === 'number' ? body.mode : 0o640 })
      case 'get-bytes': { const content = Buffer.from(files.get(target) ?? ''); return { path: target, contentBase64: content.toString('base64'), sizeBytes: content.length, mtime: stamp } }
      case 'put-bytes': { const bytes = Buffer.from(typeof body.contentBase64 === 'string' ? body.contentBase64 : '', 'base64'); files.set(target, bytes.toString('utf8')); return entry(target, { sizeBytes: bytes.length, mode: typeof body.mode === 'number' ? body.mode : 0o640 }) }
      case 'mkdir': directories.add(target); return entry(target, { kind: 'directory', sizeBytes: 0, mode: typeof body.mode === 'number' ? body.mode : 0o750 })
      case 'chmod': return entry(target, { sizeBytes: Buffer.byteLength(files.get(target) ?? ''), mode: Number(body.mode) })
      case 'trash': {
        const value = { id: randomUUID(), originalPath: target, name: target.split('/').at(-1)!, sizeBytes: Buffer.byteLength(files.get(target) ?? ''), deletedAt: stamp, content: files.get(target) ?? '' }
        files.delete(target); trash.set(value.id, value)
        const { content: _content, ...metadata } = value; return metadata }
      case 'list-trash': return { items: [...trash.values()].map(({ content: _content, ...metadata }) => metadata) }
      case 'restore': {
        const item = trash.get(String(body.trashId))!
        if (!item) return {}
        files.set(item.originalPath, item.content); trash.delete(item.id); return entry(item.originalPath, { sizeBytes: item.sizeBytes }) }
      case 'empty-trash': { const removed = trash.size; trash.clear(); return { removed } }
      default: return {}
    }
  }
  // Deliberately fake in-memory RPC transport: no filesystem, confined runner, socket or Linux identity is exercised.
  const agent: AgentApp = { subscribe: () => () => {}, fetch: async request => {
    const body = await request.json() as Body
    seen.push({ path: new URL(request.url).pathname, method: request.method, body, principalId: request.headers.get('x-xpanel-principal-id') })
    const result = !override || applyBeforeOverride ? perform(body) : undefined
    return override ? override(body, result) : Response.json(result)
  } }
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET, agentToken: TEST_AGENT_TOKEN, agentApp: agent })
  const endpoint = `/api/accounts/${owner.username}/files`
  const request = (body?: unknown, options: { token?: string; endpoint?: string; method?: string; headers?: Record<string, string> } = {}) => app.fetch(new Request('http://localhost' + (options.endpoint ?? endpoint), {
    method: options.method ?? 'POST', headers: { ...options.headers, authorization: `Bearer ${options.token ?? credential}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))
  return { database, state, features, owner, other, principal, mailbox, token, credential, files, seen, request, endpoint, agent,
    override: (value: typeof override, applyEffect = true) => { override = value; applyBeforeOverride = applyEffect } }
}

describe('file workspace API boundary with explicitly fake agent transport', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic file workspace cleanup failed')
  })

  it('preserves exact browse/read/bare-write DTOs and allows explicit saved-content readback', async () => {
    const listed = await f.request({ op: 'list', path: 'public_html', showHidden: true })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ entries: [entry()] })
    const read = await f.request({ op: 'read', path })
    expect(await read.json()).toEqual({ path, content: 'Original\n', sizeBytes: 9, mtime: stamp })
    const saved = await f.request({ op: 'write', path, content: 'Edited\n', overwrite: true, mode: 0o640 })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(entry(path, { sizeBytes: 7 }))
    const verified = await f.request({ op: 'read', path })
    expect(await verified.json()).toEqual({ path, content: 'Edited\n', sizeBytes: 7, mtime: stamp })
    expect(f.seen.map(item => item.body.op)).toEqual(['list', 'read', 'write', 'read'])
  })

  it('preserves existing binary, directory, permission and trash RPC shapes', async () => {
    for (const body of [{ op: 'mkdir', path: 'public_html/new', mode: 0o750 }, { op: 'put-bytes', path: 'public_html/upload.txt', contentBase64: 'aGVsbG8=', overwrite: false, mode: 0o640 },
      { op: 'get-bytes', path: 'public_html/upload.txt' }, { op: 'chmod', path: 'public_html/upload.txt', mode: 0o600 }]) expect((await f.request(body)).status).toBe(200)
    const removed = await f.request({ op: 'trash', path: 'public_html/upload.txt' })
    expect(removed.status).toBe(200)
    const metadata = await removed.json() as { id: string }
    expect((await f.request({ op: 'list-trash' })).status).toBe(200)
    expect((await f.request({ op: 'restore', trashId: metadata.id, overwrite: false })).status).toBe(200)
    expect((await f.request({ op: 'empty-trash', olderThanDays: 7 })).status).toBe(200)
  })

  it('classifies binary download as a read and never grants writes to a read-only token', async () => {
    const raw = await f.token(['files:read'])
    for (const body of [{ op: 'list', path: '' }, { op: 'read', path }, { op: 'get-bytes', path }, { op: 'list-trash' }]) expect((await f.request(body, { token: raw })).status).toBe(200)
    const before = f.seen.length
    for (const body of [{ op: 'write', path, content: 'Denied' }, { op: 'trash', path }, { op: 'put-bytes', path, contentBase64: 'eA==' }]) expect((await f.request(body, { token: raw })).status).toBe(403)
    expect(f.seen).toHaveLength(before)
    expect(f.files.get(path)).toBe('Original\n')
  })

  it('derives the RPC principal and account from authentication and the authorized path despite hostile hints', async () => {
    const response = await f.request({ op: 'read', path }, { endpoint: f.endpoint + `?accountId=${f.other.id}&username=${f.other.username}&role=root`,
      headers: { 'x-xpanel-principal-id': randomUUID(), 'x-role': 'root', 'x-http-method-override': 'DELETE' } })
    expect(response.status).toBe(200)
    expect(f.seen).toEqual([{ path: `/accounts/${f.owner.username}/files`, method: 'POST', principalId: f.principal.id, body: { op: 'read', path } }])
  })

  it('denies another tenant before dispatch', async () => {
    expect((await f.request({ op: 'read', path }, { endpoint: `/api/accounts/${f.other.username}/files` })).status).toBe(404)
    expect(f.seen).toEqual([])
  })

  it('keeps mailbox principals out of hosting file administration', async () => {
    const raw = await f.token([`mailbox:${f.mailbox.id}`, 'files:read', 'files:write'])
    expect((await f.request({ op: 'read', path }, { token: raw })).status).toBe(403)
    expect(f.seen).toEqual([])
  })

  it('separates reseller listing permission from edit permission and observes ACL revocation', async () => {
    const reseller = await f.state.store.createReseller({ username: 'fileseller', passwordHash: HASH, acl: ['list-accounts'], maxAccounts: 5,
      totalDiskMb: 10000, totalBandwidthMb: 'unlimited', oversell: false, nameservers: [], delegatedIps: [] })
    await f.state.store.changeOwner(f.owner.id, reseller.id)
    const principal = await createResellerPrincipal(f.database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
    const raw = await f.token(['files:read', 'files:write'], principal.id)
    expect((await f.request({ op: 'read', path }, { token: raw })).status).toBe(200)
    const before = f.seen.length
    expect((await f.request({ op: 'write', path, content: 'Denied' }, { token: raw })).status).toBe(403)
    await f.state.store.updateReseller(reseller.id, { acl: [] })
    expect((await f.request({ op: 'read', path }, { token: raw })).status).toBe(403)
    expect(f.seen).toHaveLength(before)
  })

  it.each(['feature', 'suspension'] as const)('observes current account %s refusal before forwarding another file request', async state => {
    expect((await f.request({ op: 'read', path })).status).toBe(200)
    if (state === 'feature') await f.state.store.updateFeatureList(f.features.id, { disabled: ['file-manager'] })
    else await f.state.store.suspendAccount(f.owner.id, 'Synthetic workspace hold')
    const before = f.seen.length
    expect((await f.request({ op: 'read', path })).status).toBe(403)
    expect(f.seen).toHaveLength(before)
  })

  it.each(['GET', 'PUT', 'PATCH', 'DELETE'])('never dispatches a file RPC through unsupported HTTP %s', async method => {
    const response = await f.request(undefined, { method })
    expect([404, 405]).toContain(response.status)
    expect(f.seen).toEqual([])
  })

  const invalidRequests = [null, [], { op: 'unknown', path }, { op: 'read', path: 42 }, { op: 'write', path, content: 42 },
    { op: 'list', path: '', showHidden: 'yes' }, { op: 'write', path, content: 'Denied', accountId: 'untrusted-target' },
    { op: 'read', path: '/etc/passwd' }, { op: 'read', path: '../other' }, { op: 'read', path: 'public_html\\index.txt' },
    { op: 'read', path: '.trash/index.txt' }, { op: 'read', path: '' },
    { op: 'write', path, content: 'ع'.repeat(editLimit / 2 + 1) }, { op: 'read', path: 'public_html/\ud800.txt' },
    { op: 'read', path: 'x'.repeat(4097) }, { op: 'write', path, content: 'Denied', mode: 0o777 }, { op: { toString: 'read' }, path }]
  it.each(invalidRequests.map((body, index) => ({ body, index })))('rejects malformed or unsafe request $index before transport', async ({ body }) => {
    const response = await f.request(body)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(f.seen).toEqual([])
    expect(f.files.get(path)).toBe('Original\n')
  })

  const invalidReadReplies = [
    { path: 'other/private.txt', content: 'FOREIGN_AGENT_MARKER', sizeBytes: 20, mtime: stamp },
    { path, sizeBytes: 0, mtime: stamp }, { path, content: null, sizeBytes: 0, mtime: stamp },
    { path, content: 'ع', sizeBytes: 1, mtime: stamp }, { path, content: 'Original\n', sizeBytes: 9, mtime: 'not-a-date' },
    { path, content: 'x'.repeat(editLimit + 1), sizeBytes: editLimit + 1, mtime: stamp },
  ]
  it.each(invalidReadReplies.map((reply, index) => ({ reply, index })))('rejects malformed or wrong-target text reply $index without returning file data', async ({ reply }) => {
    f.override(() => Response.json(reply))
    const response = await f.request({ op: 'read', path })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain('FOREIGN_AGENT_MARKER')
    expect(f.seen).toHaveLength(1)
  })

  it.each(['outside-parent', 'duplicate', 'over-limit'] as const)('rejects %s directory results rather than populating a false listing', async mode => {
    const entries = mode === 'outside-parent' ? [entry('other/private.txt')] : mode === 'duplicate' ? [entry(), entry()]
      : Array.from({ length: 10001 }, (_, index) => entry(`public_html/file-${index}.txt`))
    f.override(() => Response.json({ entries }))
    const response = await f.request({ op: 'list', path: 'public_html' })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(f.seen).toHaveLength(1)
  })

  it('preserves symlink visibility and observed existing permission metadata without treating it as an editable file', async () => {
    const observed = entry('public_html/link', { kind: 'symlink', mode: 0o777 })
    f.override(() => Response.json({ entries: [observed, entry(path, { mode: 0o644 })] }))
    const response = await f.request({ op: 'list', path: 'public_html' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ entries: [observed, entry(path, { mode: 0o644 })] })
  })

  it.each(['transport', 'wrong-ack', 'accepted', 'empty'] as const)('marks a dispatched %s write as uncertain without retrying or echoing host errors', async mode => {
    f.override((_body, result) => {
      if (mode === 'transport') throw new Error('PRIVATE_HOST_ERROR_MARKER')
      if (mode === 'wrong-ack') return Response.json(entry('other/private.txt', { sizeBytes: 7 }))
      if (mode === 'accepted') return Response.json(result, { status: 202 })
      return new Response(null, { status: 204 })
    })
    const response = await f.request({ op: 'write', path, content: 'Edited\n', overwrite: true })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(JSON.stringify(body)).not.toContain('PRIVATE_HOST_ERROR_MARKER')
    expect(f.files.get(path)).toBe('Edited\n')
    expect(f.seen).toHaveLength(1)
  })

  it.each(['verificationRequired', 'unknownOutcome', 'needsAttention'] as const)('keeps %s ahead of a contradictory no-change flag on a refused write', async flag => {
    f.override(() => Response.json({ code: 'FORBIDDEN', error: 'PRIVATE_HOST_ERROR_MARKER', details: { stateChanged: false, [flag]: true } }, { status: 403 }))
    const response = await f.request({ op: 'write', path, content: 'Edited\n', overwrite: true })
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ details: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    expect(JSON.stringify(body)).not.toContain('PRIVATE_HOST_ERROR_MARKER')
    expect(f.seen).toHaveLength(1)
  })

  it('preserves an explicit known no-change refusal with no uncertainty flags', async () => {
    f.override(() => Response.json({ code: 'FORBIDDEN', error: 'PRIVATE_HOST_ERROR_MARKER', details: { stateChanged: false } }, { status: 403 }), false)
    const response = await f.request({ op: 'write', path, content: 'Edited\n', overwrite: true })
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body).toMatchObject({ details: { stateChanged: false } })
    expect(JSON.stringify(body)).not.toContain('PRIVATE_HOST_ERROR_MARKER')
    expect(f.seen).toHaveLength(1)
    expect(f.files.get(path)).toBe('Original\n')
  })

  it('does not replace a failed read with an empty successful document', async () => {
    f.override(() => Response.json({ error: 'PRIVATE_READ_ERROR_MARKER' }, { status: 500 }))
    const response = await f.request({ op: 'read', path })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(await response.text()).not.toContain('PRIVATE_READ_ERROR_MARKER')
    expect(f.seen).toHaveLength(1)
  })
})
