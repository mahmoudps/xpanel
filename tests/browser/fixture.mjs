import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createAgentApp, FakeHostExecutor, HostReconciler } from '../../apps/agent/src/index.ts'
import { startPanelServer } from '../../apps/api/src/main.ts'
import { hashPasswordArgon2id } from '../../apps/api/src/auth.ts'
import { createDb, createUserPrincipal, findPrincipalByUsername, migrate } from '../../packages/db/src/index.ts'
import { profileFor } from '../../packages/os/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { StateStore } from '../../packages/state/src/index.ts'

/** Disposable application fixture. Host services are fake; the browser and HTTP server are real. */
export async function createBrowserFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'xpanel-browser-'))
  const db = createDb(join(directory, 'control.db'))
  let server
  const close = async () => {
    await server?.close()
    await db.close()
    const target = resolve(directory)
    if (!target.startsWith(`${resolve(tmpdir())}${sep}`) || !target.split(sep).at(-1).startsWith('xpanel-browser-')) {
      throw new Error('Refusing cleanup outside the browser fixture directory')
    }
    await rm(target, { recursive: true, force: true })
  }
  try {
    await migrate(db.runner)
    const stateDir = join(directory, 'state')
    await mkdir(stateDir, { recursive: true })
    const store = new StateStore(stateDir)
    const rootPassword = `R!${randomBytes(18).toString('base64url')}`
    const replacementPassword = `N!${randomBytes(18).toString('base64url')}`
    const ownerPassword = `U!${randomBytes(18).toString('base64url')}`
    const features = await store.createFeatureList({ name: 'Browser fixture', ownerId: null, disabled: [] })
    const { id: fixturePlanId, ...planInput } = defaultPlan({ name: 'Browser fixture', featureListId: features.id })
    const plan = await store.createPlan(planInput)
    const ownerHash = await hashPasswordArgon2id(ownerPassword)
    await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const owner = await store.createAccount({
      username: 'browserowner', passwordHash: ownerHash, primaryDomain: 'browserowner.test',
      planId: plan.id, ownerId: null, contactEmail: 'owner@browserowner.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} },
    })
    await createUserPrincipal(db.db, { username: owner.username, accountId: owner.id, passwordHash: ownerHash, forcePasswordChange: false })
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble')
    const executor = new FakeHostExecutor()
    const reconciler = new HostReconciler({ db: db.db, store, executor, os })
    const agentToken = randomBytes(32).toString('hex')
    const agentApp = createAgentApp({ db: db.db, store, executor, reconciler, agentToken, os: { id: os.id, versionId: os.versionId, family: os.family }, homeBaseDir: join(directory, 'host') })
    server = await startPanelServer({
      // Let the actual bootstrap factory create root; do not seed its forced-change flag in the test.
      host: '127.0.0.1', port: 0, rootPassword, dbPath: join(directory, 'control.db'), stateDir,
      os, agentApp, agentToken, serverSecret: randomBytes(32).toString('hex'), homeBaseDir: join(directory, 'host'),
    })
    const rootState = async () => {
      const principal = await findPrincipalByUsername(db.db, 'root')
      return { exists: principal !== null, force_password_change: principal?.forcePasswordChange, mfa_enabled: principal?.totpEnabled }
    }
    return { baseUrl: `http://127.0.0.1:${server.port}`, rootPassword, replacementPassword, ownerPassword, store: server.store, rootState, close }
  } catch (error) {
    await close()
    throw error
  }
}
