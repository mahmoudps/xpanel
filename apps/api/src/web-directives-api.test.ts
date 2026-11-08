import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentApp, FakeHostExecutor, HostReconciler } from '@xpanel/agent'
import { defaultServerWebSettings, suggestServerSettings } from '@xpanel/core'
import type { ConfigTest, ServerSettings } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id } from './auth.ts'
import { createApiApp } from './server.ts'
import { TEST_AGENT_TOKEN, TEST_SERVER_SECRET } from './testing.ts'

const ORIGIN = 'https://panel.example.test'
const PASSWORD = 'SyntheticRootPassword!2026'
const OS = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

/** nginx -t reads the live tree, so an unknown directive fails once its file is switched in. */
class LiveTreeExecutor extends FakeHostExecutor {
  override async runTest(test: ConfigTest) {
    if (test.name === 'nginx' && [...this.files.values()].some(file => file.content.includes('bogus_directive'))) return { ok: false, code: 1, stdout: '', stderr: 'nginx: [emerg] unknown directive "bogus_directive"' }
    return super.runTest(test)
  }
}

describe('web stack directives through the server settings', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  let executor: LiveTreeExecutor
  beforeEach(async () => { db = await createTestDb(); state = await createTestStateStore(); executor = new LiveTreeExecutor() })
  afterEach(async () => { await state.close(); await db.close() })

  const app = () => {
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os: OS })
    const agentApp = createAgentApp({ agentToken: TEST_AGENT_TOKEN, reconciler, store: state.store, db: db.db, executor, os: { id: OS.id, versionId: OS.versionId, family: OS.family } })
    return createApiApp({ db: db.db, store: state.store, serverSecret: TEST_SERVER_SECRET, allowedOrigins: [ORIGIN], agentApp, agentToken: TEST_AGENT_TOKEN, os: OS })
  }
  const settings = (web: ServerSettings['web']): ServerSettings => {
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    return { hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk',
      panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443, web }
  }

  it('keeps the previous directives saved and running when the web server refuses an include', { tags: ['slow'] }, async () => {
    await createRootPrincipal(db.db, { username: 'root', passwordHash: await hashPasswordArgon2id(PASSWORD), forcePasswordChange: false })
    const api = app()
    const login = await api.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'root', password: PASSWORD }) }))
    const { csrfToken } = await login.json() as { csrfToken: string }
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const put = (body: unknown) => api.fetch(new Request(ORIGIN + '/api/server/settings', { method: 'PUT', headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: JSON.stringify(body) }))

    const good = { ...defaultServerWebSettings(), directoryIndex: ['index.html', 'index.php'], gzip: { enabled: true, level: 5 } }
    const saved = await put(settings(good))
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ settings: { web: good }, reconcile: { status: 'applied' } })
    expect(executor.files.get('/etc/apache2/sites-enabled/000-xpanel-base.conf')!.content).toContain('DirectoryIndex index.html index.php\n')

    const refused = await put(settings({ ...good, includes: { ...good.includes, nginxHttp: 'bogus_directive on;' } }))
    expect(refused.status).toBe(422)
    expect(await refused.json()).toMatchObject({ code: 'CONFIG_TEST_FAILED', details: { stateChanged: false, failedTest: 'nginx' } })
    expect((await state.store.getServerSettings())?.web).toEqual(good)
    expect(executor.files.get('/etc/nginx/nginx.conf')!.content).not.toContain('bogus_directive')
    expect(executor.files.get('/etc/nginx/nginx.conf')!.content).toContain('gzip_comp_level 5;')
  })
})
