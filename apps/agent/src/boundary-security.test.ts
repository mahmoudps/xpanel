import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { createRootPrincipal, createTestDb, createUserPrincipal, listAudit, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import {
  assertValidKernelPeerCredentials,
  bindVerifiedRequestPeer,
  createAgentApp,
  listenAgentSocket,
  loadAgentCredentialFile,
  normalizeAllowedPeerUids,
  resolveProvisionedPeerUids,
  stripForgedPeerHeaders,
  type PeerIdentityDecisionEvent,
} from './server.ts'

const TOKEN = 'a'.repeat(64)
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'

describe('agent service authentication and authoritative caller identity', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

  beforeEach(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
  })
  afterEach(async () => {
    await state.close()
    await db.close()
  })

  const dependencies = () => ({
    store: state.store,
    db: db.db,
    reconciler: new HostReconciler({ store: state.store, db: db.db, executor: new FakeHostExecutor(), os }),
    os: { id: os.id, versionId: os.versionId, family: os.family },
  })

  it('refuses to construct an agent with a missing or predictable service credential', () => {
    assert.throws(() => createAgentApp({ ...dependencies(), agentToken: undefined as unknown as string }))
    assert.throws(() => createAgentApp({ ...dependencies(), agentToken: 'xpanel-internal-agent-token' }))
  })

  it('requires service authentication for health and rejects role headers without a credential', async () => {
    const app = createAgentApp({ ...dependencies(), agentToken: TOKEN })
    const health = await app.fetch(new Request('http://agent.local/health'))
    assert.equal(health.status, 401)
    const forged = await app.fetch(new Request('http://agent.local/reconcile', {
      method: 'POST', headers: { 'x-xpanel-role': 'root', 'x-xpanel-actor': 'root' },
    }))
    assert.equal(forged.status, 401)
    const badToken = await app.fetch(new Request('http://agent.local/health', {
      headers: { 'x-xpanel-agent-token': 'b'.repeat(64) },
    }))
    assert.equal(badToken.status, 401)
  })

  it('refuses unsafe listener and credential paths without trying to provision a host', async () => {
    const app = createAgentApp({ ...dependencies(), agentToken: TOKEN })
    await assert.rejects(() => listenAgentSocket(app, '/unused-agent.sock', { gid: 0 }))
    await assert.rejects(() => loadAgentCredentialFile('relative-token-file'))
  })

  it('requires an existing enabled principal even when the service credential is valid', async () => {
    const app = createAgentApp({ ...dependencies(), agentToken: TOKEN })
    for (const principalId of [undefined, randomUUID(), 'root']) {
      const response = await app.fetch(new Request('http://agent.local/reconcile', {
        method: 'POST', headers: {
          'x-xpanel-agent-token': TOKEN,
          ...(principalId ? { 'x-xpanel-principal-id': principalId } : {}),
          'x-xpanel-role': 'root',
        },
      }))
      assert.equal(response.status, 401)
    }
    const disabled = await createUserPrincipal(db.db, {
      username: 'disabled', passwordHash: HASH, accountId: randomUUID(), disabled: true,
    })
    const response = await app.fetch(new Request('http://agent.local/reconcile', {
      method: 'POST', headers: { 'x-xpanel-agent-token': TOKEN, 'x-xpanel-principal-id': disabled.id },
    }))
    assert.equal(response.status, 401)
  })

  it('does not elevate a user through role, actor, account or reseller headers', async () => {
    const user = await createUserPrincipal(db.db, {
      username: 'alice', passwordHash: HASH, accountId: randomUUID(),
    })
    const app = createAgentApp({ ...dependencies(), agentToken: TOKEN })
    const response = await app.fetch(new Request('http://agent.local/reconcile', {
      method: 'POST', headers: {
        'x-xpanel-agent-token': TOKEN, 'x-xpanel-principal-id': user.id,
        'x-xpanel-role': 'root', 'x-xpanel-actor': 'root',
        'x-xpanel-account-id': randomUUID(), 'x-xpanel-reseller-id': randomUUID(),
      },
    }))
    assert.equal(response.status, 403)
  })

  it('binds reconcile audit attribution to the stored principal rather than caller headers', async () => {
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const deps = dependencies()
    let observed: Parameters<HostReconciler['reconcile']>[0]
    deps.reconciler.reconcile = async (options) => {
      observed = options
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }
    const app = createAgentApp({ ...deps, agentToken: TOKEN })
    const response = await app.fetch(new Request('http://agent.local/reconcile', {
      method: 'POST', headers: {
        'x-xpanel-agent-token': TOKEN, 'x-xpanel-principal-id': root.id,
        'x-xpanel-actor': 'victim',
        'content-type': 'application/json',
      }, body: JSON.stringify({ force: true }),
    }))
    assert.equal(response.status, 200)
    assert.equal(observed?.actor, root.username)
    assert.equal(observed?.force, true)
  })

  it('rejects malformed or unknown reconcile JSON before a host call', async () => {
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const deps = dependencies()
    let called = false
    deps.reconciler.reconcile = async () => { called = true; throw new Error('must not execute') }
    const app = createAgentApp({ ...deps, agentToken: TOKEN })
    for (const body of ['{', '{"actor":"victim"}', '{"scope":{"accountId":"forged"}}', '{"force":"yes"}']) {
      const response = await app.fetch(new Request('http://agent.local/reconcile', {
        method: 'POST', headers: { 'x-xpanel-agent-token': TOKEN, 'x-xpanel-principal-id': root.id }, body,
      }))
      assert.equal(response.status, 422)
    }
    assert.equal(called, false)
  })

  it('fails closed (412) when expectedPeerUid is configured and kernel SO_PEERCRED identity is missing or forged via headers', async () => {
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const deps = dependencies()
    let called = false
    deps.reconciler.reconcile = async () => {
      called = true
      throw new Error('must not execute without kernel peer verification')
    }
    const app = createAgentApp({ ...deps, agentToken: TOKEN, expectedPeerUid: 999 })

    const headers = new Headers({
      'x-xpanel-agent-token': TOKEN,
      'x-xpanel-principal-id': root.id,
      'x-xpanel-peer-uid': '999',
      'x-xpanel-peer-pid': '1234',
      'x-peer-uid': '999',
    })
    stripForgedPeerHeaders(headers)
    assert.equal(headers.has('x-xpanel-peer-uid'), false)
    assert.equal(headers.has('x-peer-uid'), false)

    const response = await app.fetch(
      new Request('http://agent.local/reconcile', {
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': TOKEN,
          'x-xpanel-principal-id': root.id,
          'x-xpanel-peer-uid': '999',
        },
      }),
    )
    assert.equal(response.status, 412)
    const body = (await response.json()) as { code: string; detail: string }
    assert.equal(body.code, 'PRECONDITION_FAILED')
    assert.match(body.detail, /kernel socket peer identity verification is required/)
    assert.equal(called, false)
  })

  it('rejects an unauthorized peer UID with HTTP 403 before route execution even when the service token and root principal are valid', async () => {
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const deps = dependencies()
    let called = false
    deps.reconciler.reconcile = async () => {
      called = true
      throw new Error('must not execute for unauthorized socket peer UID')
    }
    const decisions: PeerIdentityDecisionEvent[] = []
    const app = createAgentApp({
      ...deps,
      agentToken: TOKEN,
      expectedPeerUid: 999,
      onPeerDecision: (event) => decisions.push(event),
    })

    const request = bindVerifiedRequestPeer(
      new Request('http://agent.local/reconcile', {
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': TOKEN,
          'x-xpanel-principal-id': root.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ force: true }),
      }),
      {
        peer: { uid: 996, gid: 986, pid: 4321 },
        allowedPeerUids: normalizeAllowedPeerUids(999),
        credentialSource: 'SO_PEERCRED',
      },
    )

    const response = await app.fetch(request)
    assert.equal(response.status, 403)
    const problem = (await response.json()) as {
      code: string
      detail: string
      details?: { peerUid: number; peerGid: number; peerPid: number; credentialSource: string }
    }
    assert.equal(problem.code, 'FORBIDDEN')
    assert.equal(problem.details?.peerUid, 996)
    assert.equal(problem.details?.peerGid, 986)
    assert.equal(problem.details?.peerPid, 4321)
    assert.equal(problem.details?.credentialSource, 'SO_PEERCRED')
    assert.equal(called, false)
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]?.allowed, false)
    assert.equal(decisions[0]?.peer.uid, 996)

    const audits = await listAudit(db.db, { limit: 10 })
    const denied = audits.find((entry) => entry.action === 'agent.peer_denied')
    assert.ok(denied)
    assert.equal(denied.outcome, 'denied')
    assert.equal(denied.actor, 'uid:996')
    assert.equal((denied.detail as { peerUid?: number }).peerUid, 996)
    assert.equal((denied.detail as { peerSource?: string }).peerSource, 'SO_PEERCRED')
  })

  it('allows an authorized peer UID with a valid token (200) and rejects an authorized peer UID with a missing or wrong token (401)', async () => {
    const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const deps = dependencies()
    let reconcileCount = 0
    deps.reconciler.reconcile = async () => {
      reconcileCount += 1
      return { status: 'noop', generation: null, stateChecksum: 'a'.repeat(64) }
    }
    const app = createAgentApp({
      ...deps,
      agentToken: TOKEN,
      expectedPeerUid: 999,
    })

    const authorizedHealth = bindVerifiedRequestPeer(
      new Request('http://agent.local/health', {
        headers: { 'x-xpanel-agent-token': TOKEN },
      }),
      {
        peer: { uid: 999, gid: 988, pid: 5432 },
        allowedPeerUids: normalizeAllowedPeerUids(999),
        credentialSource: 'SO_PEERCRED',
      },
    )
    const healthRes = await app.fetch(authorizedHealth)
    assert.equal(healthRes.status, 200)
    const healthBody = (await healthRes.json()) as {
      ok: boolean
      peer?: { uid: number; gid: number; pid: number; source: string }
    }
    assert.equal(healthBody.ok, true)
    assert.deepEqual(healthBody.peer, { uid: 999, gid: 988, pid: 5432, source: 'SO_PEERCRED' })

    const authorizedNoToken = bindVerifiedRequestPeer(
      new Request('http://agent.local/reconcile', {
        method: 'POST',
        headers: { 'x-xpanel-principal-id': root.id },
      }),
      {
        peer: { uid: 999, gid: 988, pid: 5432 },
        allowedPeerUids: normalizeAllowedPeerUids(999),
        credentialSource: 'SO_PEERCRED',
      },
    )
    const noTokenRes = await app.fetch(authorizedNoToken)
    assert.equal(noTokenRes.status, 401)
    assert.equal(reconcileCount, 0)

    const authorizedReconcile = bindVerifiedRequestPeer(
      new Request('http://agent.local/reconcile', {
        method: 'POST',
        headers: {
          'x-xpanel-agent-token': TOKEN,
          'x-xpanel-principal-id': root.id,
        },
      }),
      {
        peer: { uid: 999, gid: 988, pid: 5432 },
        allowedPeerUids: normalizeAllowedPeerUids(999),
        credentialSource: 'SO_PEERCRED',
      },
    )
    const reconcileRes = await app.fetch(authorizedReconcile)
    assert.equal(reconcileRes.status, 200)
    assert.equal(reconcileCount, 1)
  })

  it('resolves the unique provisioned API service UID from /etc/group and /etc/passwd and fails closed on ambiguous or invalid group membership', async () => {
    const passwd = [
      'root:x:0:0:root:/root:/bin/bash',
      'xpanel:x:999:988:xPanel API:/var/lib/xpanel:/usr/sbin/nologin',
      'outsider:x:996:996:Outsider:/nonexistent:/usr/sbin/nologin',
    ].join('\n')
    const validGroup = [
      'root:x:0:',
      'xpanel:x:988:',
      'xpanel-agent:x:986:xpanel',
    ].join('\n')

    const allowed = await resolveProvisionedPeerUids({
      gid: 986,
      etcGroupContent: validGroup,
      etcPasswdContent: passwd,
    })
    assert.equal(allowed.has(999), true)
    assert.equal(allowed.has(0), true)
    assert.equal(allowed.has(996), false)

    const strictNonRoot = await resolveProvisionedPeerUids({
      gid: 986,
      allowRootPeer: false,
      etcGroupContent: validGroup,
      etcPasswdContent: passwd,
    })
    assert.deepEqual([...strictNonRoot], [999])

    const ambiguousGroup = [
      'xpanel-agent:x:986:xpanel,outsider',
    ].join('\n')
    await assert.rejects(() =>
      resolveProvisionedPeerUids({
        gid: 986,
        etcGroupContent: ambiguousGroup,
        etcPasswdContent: passwd,
      }),
    )

    const emptyGroup = ['xpanel-agent:x:986:'].join('\n')
    await assert.rejects(() =>
      resolveProvisionedPeerUids({
        gid: 986,
        etcGroupContent: emptyGroup,
        etcPasswdContent: passwd,
      }),
    )

    assert.throws(() => assertValidKernelPeerCredentials({ uid: -1, gid: 988, pid: 100 }))
    assert.throws(() => assertValidKernelPeerCredentials({ uid: 999, gid: 988, pid: 0 }))
    assert.throws(() => normalizeAllowedPeerUids([]))
  })
})
