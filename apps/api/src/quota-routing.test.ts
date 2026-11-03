import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { ARGON2 } from '../../../packages/db/src/testing.ts'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor, LinuxHostExecutor } from '../../agent/src/executor.ts'
import { agentCallerHeaders, createAgentApp } from '../../agent/src/server.ts'
import type { AgentServerDeps } from '../../agent/src/server.ts'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

// Mounted API and agent routing with persisted identities; only the subprocess primitive is simulated.
// This proves neither native filesystem enforcement nor a real installation.
describe('mounted setup quota observation', () => {
  it('reads current enforcement through the protected native route without initializing quotas or trusting the saved flag', async () => {
    const db = await createTestDb(), state = await createTestStateStore()
    try {
      const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: ARGON2, forcePasswordChange: false })
      const owner = await createUserPrincipal(db.db, { username: 'quotaowner', accountId: randomUUID(), passwordHash: ARGON2 })
      const executor = new LinuxHostExecutor(), commands: string[][] = []
      let enabled = true
      vi.spyOn(executor, 'runCommand').mockImplementation(async argv => {
        commands.push(argv)
        if (argv[0] === '/usr/bin/findmnt') return { ok: true, code: 0, stderr: '', stdout: ({ TARGET: '/', SOURCE: '/dev/sda1', FSTYPE: 'ext4' } as Record<string, string>)[argv[4]!]! + '\n' }
        if (argv[0] === '/usr/sbin/quotaon' && argv.slice(1, 4).join(' ') === '--print-state --verbose --user') return { ok: !enabled, code: enabled ? 1 : 0, stderr: '', stdout: 'user quota on / (/dev/sda1) is ' + (enabled ? 'on' : 'off') + '\n' }
        throw new Error('unexpected mutating quota command')
      })
      const writeFile = vi.spyOn(executor, 'writeFile').mockRejectedValue(new Error('quota observation cannot write host files'))
      const runAction = vi.spyOn(executor, 'runAction').mockRejectedValue(new Error('quota observation cannot execute host actions'))
      const reconcile = vi.fn(async () => ({ status: 'noop' }))
      const dependencies = { db: db.db, store: state.store, os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), agentToken: TEST_AGENT_TOKEN,
        reconciler: { subscribe: () => () => {}, reconcile } as unknown as AgentServerDeps['reconciler'] }
      const agent = createAgentApp({ ...dependencies, executor })
      const direct = (path: string, principalId = root.id) => agent.fetch(new Request('http://agent.local' + path, { headers: agentCallerHeaders({ principalId, token: TEST_AGENT_TOKEN }) }))
      expect((await direct('/host/quota?path=/home', owner.id)).status).toBe(403)
      expect((await direct('/host/quota?path=/home&path=/tmp')).status).toBe(422)
      expect(commands).toHaveLength(0)
      const fake = createAgentApp({ ...dependencies, executor: new FakeHostExecutor() })
      expect((await fake.fetch(new Request('http://agent.local/host/quota?path=/home', { headers: agentCallerHeaders({ principalId: root.id, token: TEST_AGENT_TOKEN }) }))).status).toBe(412)

      const raw = randomUUID() + randomUUID(), origin = 'https://whm.example.test:2087'
      await createSession(db.db, { principalId: root.id, tokenHash: sessionTokenHash(raw, 'xwhm'), expiresAt: new Date(Date.now() + 3600000).toISOString(), mfaVerified: true })
      const hostCalls: { method: string; path: string }[] = []
      const app = createApiApp({ db: db.db, store: state.store, serverSecret: TEST_SERVER_SECRET, entryPoint: 'xwhm', publicOrigin: origin, allowedOrigins: [origin],
        secureCookies: true, requireSecureCookies: true, agentToken: TEST_AGENT_TOKEN,
        agentApp: { subscribe: agent.subscribe, fetch: async request => { const url = new URL(request.url); hostCalls.push({ method: request.method, path: url.pathname + url.search }); return agent.fetch(request) } } })
      const request = (method = 'GET', body?: unknown) => app.fetch(new Request(origin + '/api/setup/wizard', { method,
        headers: { origin, cookie: sessionCookieName('xwhm', true) + '=' + raw, 'x-csrf-token': deriveCsrfToken(raw, TEST_SERVER_SECRET, 'xwhm'), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }), { tls: true, remoteAddress: '198.51.100.9' })
      const ext = new ExtendedFeaturesStore(state.store.rootDir)
      await ext.write('setup-wizard.json', { quotaFilesystem: '/home', quotaInitialized: false, quotaInitialization: { status: 'unavailable' } })
      const writes = vi.spyOn(ExtendedFeaturesStore.prototype, 'write'), revision = await state.store.getRevision()
      const get = await request()
      expect(get.status).toBe(200)
      expect(await get.json()).toMatchObject({ quotaInitialized: true, wizardState: { quotaInitialized: true }, quotaInitialization: { status: 'enabled', filesystem: '/', filesystemType: 'ext4' } })
      expect(hostCalls).toEqual([{ method: 'GET', path: '/host/quota?path=%2Fhome' }])
      expect(writes).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled(); expect(await state.store.getRevision()).toBe(revision)
      expect(await ext.readOrDefault('setup-wizard.json', {})).toMatchObject({ quotaInitialized: false })

      const post = await request('POST', { hostname: 'panel.example.test', primaryIpv4: '192.0.2.12', initQuotas: false })
      expect(post.status).toBe(200)
      expect(await post.json()).toMatchObject({ quotaInitialized: true, quotaInitialization: { status: 'enabled', filesystem: '/' } })
      expect(await ext.readOrDefault('setup-wizard.json', {})).toMatchObject({ quotaInitializationRequested: false, quotaInitialized: true })
      expect(hostCalls.filter(call => call.path.startsWith('/host/quota'))).toEqual([{ method: 'GET', path: '/host/quota?path=%2Fhome' }, { method: 'GET', path: '/host/quota?path=%2Fhome' }])
      writes.mockClear(); reconcile.mockClear(); enabled = false
      expect(await (await request()).json()).toMatchObject({ quotaInitialized: false, wizardState: { quotaInitialized: false }, quotaInitialization: { status: 'disabled' } })
      expect(writes).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled()
      expect(await ext.readOrDefault('setup-wizard.json', {})).toMatchObject({ quotaInitialized: true })
      expect(writeFile).not.toHaveBeenCalled(); expect(runAction).not.toHaveBeenCalled()
      expect(commands.every(argv => argv[0] === '/usr/bin/findmnt' || argv[0] === '/usr/sbin/quotaon' && argv.includes('--print-state'))).toBe(true)
    } finally { vi.restoreAllMocks(); await state.close(); await db.close() }
  })
})
