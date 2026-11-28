import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import {
  ACCOUNT_PROXY_PROJECTS_PATH,
  ACCOUNT_PROXY_RULES_PATH,
  handleAccountProxyProjectsRoute,
  type AccountProxyProjectsPorts,
} from './account-proxy-projects-routes.ts'
import { proxyRulesPath } from '../../agent/src/proxy-rules.ts'

const ALICE: Account = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'alice',
  uid: 2001,
  gid: 2001,
  home: '/home/alice',
  primaryDomain: 'alice.example',
  planId: 'plan-1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'alice@alice.example',
  ipv4: '198.51.100.8',
  ipv6: '2001:db8::8',
  shell: 'none',
  createdAt: '2026-11-01T00:00:00.000Z',
}

const BOB: Account = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'bob',
  uid: 2002,
  gid: 2002,
  home: '/home/bob',
  primaryDomain: 'bob.example',
  planId: 'plan-1',
  ownerId: null,
  status: 'active',
  suspendReason: null,
  contactEmail: 'bob@bob.example',
  ipv4: '198.51.100.9',
  shell: 'none',
  createdAt: '2026-11-01T00:00:00.000Z',
}

const DOMAINS: Domain[] = [
  { id: '10000000-0000-4000-8000-000000000001', accountId: ALICE.id, name: 'alice.example', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' },
  { id: '10000000-0000-4000-8000-000000000002', accountId: ALICE.id, name: 'alias.example', kind: 'alias', parentId: '10000000-0000-4000-8000-000000000001', docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' },
  { id: '10000000-0000-4000-8000-000000000003', accountId: ALICE.id, name: 'moved.example', kind: 'addon', parentId: null, docRoot: '/home/alice/domains/moved.example/public_html', siteType: 'php', upstream: null, redirect: { to: 'https://elsewhere.example/', code: 301 }, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' },
  { id: '10000000-0000-4000-8000-000000000004', accountId: BOB.id, name: 'bob.example', kind: 'primary', parentId: null, docRoot: '/home/bob/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' },
]

const SETTINGS: ServerSettings = {
  hostname: 'host.example.test',
  nameservers: ['ns1.example.test'],
  adminEmail: 'ops@example.test',
  engine: 'apache',
  apacheMpm: 'itk',
  panelPort: 2087,
  backendPort: 8080,
  backendTlsPort: 8443,
  sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
  edge: { resolvers: ['192.0.2.53'] },
} as ServerSettings

const callerFor = (kind: 'user' | 'root' | 'reseller' | 'mailbox', account?: Account): AuthenticatedCaller => ({
  principal: kind === 'user'
    ? { kind: 'user', id: 'user-' + account!.id, username: account!.username, accountId: account!.id }
    : kind === 'mailbox'
      ? { kind: 'mailbox', id: 'mbox-1', username: 'info@alice.example', accountId: ALICE.id, mailbox: 'info@alice.example' }
      : { kind, id: kind + '-1', username: kind },
  sessionId: 'sess-1',
  apiTokenId: null,
  scopes: ['*'],
  csrfValid: true,
  mfaVerified: true,
  principalRecord: {},
}) as unknown as AuthenticatedCaller

const ALICE_CALLER = callerFor('user', ALICE)
const BOB_CALLER = callerFor('user', BOB)
const ROOT_CALLER = callerFor('root')
const RESELLER_CALLER = callerFor('reseller')
const MAILBOX_CALLER = callerFor('mailbox')

let rootDir = ''
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'xp-acct-proxy-')) })
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })

function createHarness(options: {
  caller?: AuthenticatedCaller
  runtimePorts?: Record<string, number[]>
  resolveHost?: (name: string) => Promise<string[]>
  verifyNginxConfig?: AccountProxyProjectsPorts['verifyNginxConfig']
  triggerReconcile?: AccountProxyProjectsPorts['triggerReconcile']
} = {}) {
  let activeCaller = options.caller ?? ALICE_CALLER
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const ports: AccountProxyProjectsPorts = {
    store: {
      rootDir,
      getWriterLock: () => ({ acquire: async () => lease }) as never,
      getAccount: async id => [ALICE, BOB].find(a => a.id === id) ?? null,
      getAccountByUsername: async username => [ALICE, BOB].find(a => a.username === username) ?? null,
      listAccounts: async () => [ALICE, BOB],
      getDomain: async id => DOMAINS.find(d => d.id === id) ?? null,
      listDomains: async () => DOMAINS,
      getServerSettings: async () => SETTINGS,
      listServerIps: async () => [{ address: '198.51.100.4' } as never],
    },
    requireCaller: vi.fn(async () => activeCaller),
    assertRoot: vi.fn(async caller => {
      if (caller.principal.kind !== 'root') throw Object.assign(new Error('root required'), { code: 'FORBIDDEN' })
    }),
    assertCanAccessAccount: vi.fn(async (caller, account) => {
      if (caller.principal.kind === 'user' && caller.principal.accountId !== account.id) {
        throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' })
      }
    }),
    emitAudit: vi.fn(async () => undefined),
    triggerReconcile: options.triggerReconcile ?? vi.fn(async () => ({ ok: true, status: 200, body: {} })),
    resolveHost: options.resolveHost ?? (async name => {
      if (name === 'public.example.net') return ['203.0.113.10']
      if (name === 'private.example.net') return ['10.0.0.5']
      if (name === 'loopback.example.net') return ['127.0.0.1']
      if (name === 'metadata.example.net') return ['169.254.169.254']
      return []
    }),
    listAccountRuntimePorts: async accountId => options.runtimePorts?.[accountId] ?? [],
    ...(options.verifyNginxConfig ? { verifyNginxConfig: options.verifyNginxConfig } : {}),
    now: () => new Date('2026-11-27T12:00:00.000Z'),
  }
  const call = (path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://api.test' + path)
    return handleAccountProxyProjectsRoute(
      new Request(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      url,
      method,
      ports,
    )
  }
  const jsonCall = async (path: string, method = 'GET', body?: unknown) => {
    const response = await call(path, method, body)
    return { status: response!.status, data: await response!.json() as Record<string, any> }
  }
  return {
    ports,
    call,
    jsonCall,
    as: (caller: AuthenticatedCaller) => { activeCaller = caller },
  }
}

describe('account path-scoped site reverse-proxy rules', () => {
  it('adds, updates and deletes path-scoped rules for owned domains with owned runtime loopback ports and audits each change', async () => {
    const h = createHarness({ runtimePorts: { [ALICE.id]: [3000] } })
    const initial = await h.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    expect(initial.status).toBe(200)
    expect(initial.data.rules).toEqual([])
    expect(initial.data.runtimePorts).toEqual([3000])

    const added = await h.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: initial.data.revision,
      domainId: DOMAINS[0]!.id,
      path: '/api/',
      target: 'http://127.0.0.1:3000',
      websocket: true,
      hostHeader: 'client',
      headers: [{ name: 'X-App-Proxy', value: 'edge' }],
    })
    expect(added.status).toBe(201)
    expect(added.data.reconcile).toBe('requested')
    expect(added.data.rules).toHaveLength(1)
    expect(added.data.rules[0]).toMatchObject({
      domain: 'alice.example',
      path: '/api',
      target: 'http://127.0.0.1:3000',
      websocket: true,
      hostHeader: 'client',
    })
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.proxy_rule.added',
      target: 'domain:alice.example',
    }))

    const updated = await h.jsonCall(`${ACCOUNT_PROXY_RULES_PATH}/${DOMAINS[0]!.id}`, 'PUT', {
      expectedRevision: added.data.revision,
      path: '/api',
      target: 'https://203.0.113.20:9443',
      websocket: false,
      hostHeader: 'upstream',
    })
    expect(updated.status).toBe(200)
    expect(updated.data.rules[0]).toMatchObject({
      target: 'https://203.0.113.20:9443',
      websocket: false,
      hostHeader: 'upstream',
    })
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.proxy_rule.updated',
    }))

    const removed = await h.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'DELETE', {
      expectedRevision: updated.data.revision,
      domain: 'alice.example',
      path: '/api',
    })
    expect(removed.status).toBe(200)
    expect(removed.data.rules).toEqual([])
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'account.proxy_rule.removed',
    }))
  })

  it('enforces tenant isolation across accounts and blocks unauthorized principals', async () => {
    const h = createHarness()
    const empty = await h.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    await expect(h.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: empty.data.revision,
      domainId: DOMAINS[3]!.id,
      path: '/api',
      target: 'https://203.0.113.20',
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.jsonCall(`${ACCOUNT_PROXY_RULES_PATH}?accountId=${BOB.id}`)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    h.as(MAILBOX_CALLER)
    await expect(h.jsonCall(ACCOUNT_PROXY_RULES_PATH)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    h.as(RESELLER_CALLER)
    await expect(h.jsonCall(ACCOUNT_PROXY_RULES_PATH)).rejects.toMatchObject({ code: 'FORBIDDEN' })

    h.as(ROOT_CALLER)
    const rootRead = await h.jsonCall(`${ACCOUNT_PROXY_RULES_PATH}?account=alice`)
    expect(rootRead.data.context.accountId).toBe(ALICE.id)
  })

  it.each([
    ['ftp://203.0.113.10:21', 'invalid', 'INVALID_TARGET'],
    ['http://10.0.0.5:9000', 'private_address', 'INVALID_TARGET'],
    ['http://192.168.1.20:3000', 'private_address', 'INVALID_TARGET'],
    ['http://127.0.0.1:9000', 'loopback', 'INVALID_TARGET'],
    ['http://[::1]:9000', 'loopback', 'INVALID_TARGET'],
    ['http://localhost:3000', 'loopback', 'INVALID_TARGET'],
    ['http://169.254.169.254', 'forbidden_range', 'INVALID_TARGET'],
    ['http://198.51.100.4:9000', 'own_address', 'INVALID_TARGET'],
    ['http://203.0.113.20:2087', 'panel_port', 'INVALID_TARGET'],
    ['https://private.example.net', 'resolves_internal', 'INVALID_TARGET'],
    ['https://loopback.example.net', 'resolves_internal', 'INVALID_TARGET'],
    ['https://metadata.example.net', 'resolves_internal', 'INVALID_TARGET'],
  ])('blocks SSRF target %s (%s)', async (target, fieldCode, reason) => {
    const h = createHarness({ runtimePorts: { [ALICE.id]: [3000] } })
    const initial = await h.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    await expect(h.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: initial.data.revision,
      domainId: DOMAINS[0]!.id,
      path: '/api',
      target,
    })).rejects.toMatchObject({
      code: 'VALIDATION',
      detail: { stateChanged: false, reason, fields: [{ field: 'target', code: fieldCode }] },
    })
  })

  it('rolls back and refuses commit when nginx -t or reconcile verification fails', async () => {
    const prefail = createHarness({
      verifyNginxConfig: async () => ({ ok: false, error: 'nginx: [emerg] invalid upstream directive' }),
    })
    const initial = await prefail.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    await expect(prefail.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: initial.data.revision,
      domainId: DOMAINS[0]!.id,
      path: '/api',
      target: 'https://203.0.113.20',
    })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, reason: 'nginx_config_test_failed' } })
    await expect(readFile(join(rootDir, proxyRulesPath(ALICE.id)))).rejects.toMatchObject({ code: 'ENOENT' })

    let failReconcile = false
    const reconcileFail = createHarness({
      triggerReconcile: async () => failReconcile ? { ok: false, status: 500, body: { error: 'nginx -t failed' } } : { ok: true, status: 200, body: {} },
    })
    const first = await reconcileFail.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    const saved = await reconcileFail.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: first.data.revision,
      domainId: DOMAINS[0]!.id,
      path: '/one',
      target: 'https://203.0.113.20',
    })
    failReconcile = true
    await expect(reconcileFail.jsonCall(ACCOUNT_PROXY_RULES_PATH, 'POST', {
      expectedRevision: saved.data.revision,
      domainId: DOMAINS[0]!.id,
      path: '/two',
      target: 'https://203.0.113.21',
    })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { stateChanged: false, reason: 'nginx_config_test_failed' } })
    const afterRollback = await reconcileFail.jsonCall(ACCOUNT_PROXY_RULES_PATH)
    expect(afterRollback.data.rules).toHaveLength(1)
    expect(afterRollback.data.rules[0].path).toBe('/one')
  })
})

describe('standalone proxy projects', () => {
  it('creates, updates, adds rules, enforces 409 LAST_PROXY_RULE on last rule delete, and deletes projects', async () => {
    const h = createHarness({ runtimePorts: { [ALICE.id]: [4100] } })
    const initial = await h.jsonCall(ACCOUNT_PROXY_PROJECTS_PATH)
    expect(initial.data.projects).toEqual([])

    const created = await h.jsonCall(ACCOUNT_PROXY_PROJECTS_PATH, 'POST', {
      expectedRevision: initial.data.revision,
      name: 'Edge API Gateway',
      domains: ['gateway.alice.example'],
      path: '/',
      target: 'http://127.0.0.1:4100',
      note: 'Owned runtime gateway',
      cache: false,
      gzip: true,
      ssl: true,
    })
    expect(created.status).toBe(201)
    const projectId = created.data.project.id as string
    expect(created.data.project).toMatchObject({
      name: 'Edge API Gateway',
      domains: ['gateway.alice.example'],
      cache: false,
      gzip: true,
      ssl: { enabled: true },
    })

    // Deleting the last/only proxy rule returns 409 LAST_PROXY_RULE.
    await expect(h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}/rules`, 'DELETE', {
      expectedRevision: created.data.revision,
      path: '/',
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      detail: { stateChanged: false, reason: 'LAST_PROXY_RULE' },
    })

    const withSecondRule = await h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}/rules`, 'POST', {
      expectedRevision: created.data.revision,
      path: '/metrics',
      target: 'https://203.0.113.50:9443',
      websocket: false,
      hostHeader: 'upstream',
    })
    expect(withSecondRule.data.project.rules).toHaveLength(2)

    const removedSecond = await h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}/rules`, 'DELETE', {
      expectedRevision: withSecondRule.data.revision,
      path: '/metrics',
    })
    expect(removedSecond.data.project.rules).toHaveLength(1)

    const updated = await h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}`, 'PUT', {
      expectedRevision: removedSecond.data.revision,
      name: 'Renamed Gateway',
      note: 'Updated note',
    })
    expect(updated.data.project.name).toBe('Renamed Gateway')

    // Foreign tenant cannot read, modify, or delete Alice's proxy project.
    h.as(BOB_CALLER)
    await expect(h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}`)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}`, 'DELETE', {
      expectedRevision: updated.data.revision,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })

    h.as(ALICE_CALLER)
    const deleted = await h.jsonCall(`${ACCOUNT_PROXY_PROJECTS_PATH}/${projectId}`, 'DELETE', {
      expectedRevision: updated.data.revision,
    })
    expect(deleted.status).toBe(200)
    expect(deleted.data.projects).toEqual([])
  })

  it('prevents assigning domains owned by another account to a proxy project', async () => {
    const h = createHarness()
    const initial = await h.jsonCall(ACCOUNT_PROXY_PROJECTS_PATH)
    await expect(h.jsonCall(ACCOUNT_PROXY_PROJECTS_PATH, 'POST', {
      expectedRevision: initial.data.revision,
      name: 'Hijack attempt',
      domains: ['bob.example'],
      target: 'https://203.0.113.20',
    })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
