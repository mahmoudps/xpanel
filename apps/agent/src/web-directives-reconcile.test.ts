import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultServerWebSettings, suggestServerSettings } from '@xpanel/core'
import type { ConfigTest, HostAction, ServerSettings } from '@xpanel/core'
import { createTestDb, latestActive, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor, type ConfigTestResult } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

/** nginx -t of the live tree: an unknown directive in a file written so far fails, as on a host. */
class LiveTreeExecutor extends FakeHostExecutor {
  override async runTest(test: ConfigTest): Promise<ConfigTestResult> {
    if (test.name === 'nginx' && [...this.files.values()].some(file => file.content.includes('bogus_directive'))) {
      this.executedTests.push(test)
      return { ok: false, code: 1, stdout: '', stderr: 'nginx: [emerg] unknown directive "bogus_directive"' }
    }
    return super.runTest(test)
  }

  reloadedBroken = false
  override async runAction(action: HostAction): Promise<void> {
    if (action.kind === 'systemd' && (action.verb === 'reload' || action.verb === 'restart') && action.unit.startsWith('nginx')
      && [...this.files.values()].some(file => file.content.includes('bogus_directive'))) this.reloadedBroken = true
    return super.runAction(action)
  }
}

describe('web stack directives in a configuration generation', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
  beforeEach(async () => { state = await createTestStateStore(); db = await createTestDb() })
  afterEach(async () => { await state.close(); await db.close() })

  const save = (web: ServerSettings['web']) => {
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    return state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk',
      panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443, ...(web ? { web } : {}) })
  }

  it('applies saved directives and keeps the previous generation when the switched nginx files fail their test', { tags: ['slow'] }, async () => {
    const executor = new LiveTreeExecutor()
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    await save({ ...defaultServerWebSettings(), directoryIndex: ['index.html', 'index.php'], includes: { ...defaultServerWebSettings().includes, nginxHttp: 'server_tokens off;', apachePostVhost: 'ServerSignature Off' } })
    expect((await reconciler.reconcile()).status).toBe('applied')
    const nginxConf = executor.files.get('/etc/nginx/nginx.conf')!.content
    expect(nginxConf).toMatch(/# Include Editor: http\n +server_tokens off;\n/)
    expect(executor.files.get('/etc/apache2/sites-enabled/000-xpanel-base.conf')!.content).toContain('DirectoryIndex index.html index.php\n')
    expect(executor.files.get('/etc/apache2/sites-enabled/zzz-xpanel-post-vhost.conf')!.content).toContain('ServerSignature Off')
    const active = await latestActive(db.db)

    await save({ ...defaultServerWebSettings(), includes: { ...defaultServerWebSettings().includes, nginxHttp: 'bogus_directive on;' } })
    const failed = await reconciler.reconcile()
    expect(failed).toMatchObject({ status: 'failed', failedTest: 'nginx', rolledBack: true })
    expect(executor.files.get('/etc/nginx/nginx.conf')!.content).toBe(nginxConf)
    expect(executor.files.get('/etc/apache2/sites-enabled/zzz-xpanel-post-vhost.conf')!.content).toContain('ServerSignature Off')
    expect((await latestActive(db.db))?.id).toBe(active?.id)
    expect(executor.reloadedBroken).toBe(false)
  })
})
