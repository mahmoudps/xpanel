import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadAgentCredentialFile } from '@xpanel/agent'
import { captureMfaRuntimePolicy, fail } from '@xpanel/core'
import { createDb, initializeOperationalMetadata, migrate } from '@xpanel/db'
import { StateStore } from '@xpanel/state'
import { awaitLifecycleWriterDrain, createLifecycleBackgroundResources, withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'
import { createAgentClient } from './agent-client.ts'
import { closeApiLifecycleParticipant, createDefaultWebRenderer, createQuarantinedApiApp, detectHostOsProfile, prepareApiLifecycleStartup, type PanelServerOptions } from './main.ts'
import { createApiApp, ensureRootPrincipal, listenApiServer } from './server.ts'
import { assertStateWritable } from './state-access.ts'

/**
 * Test-only combined listener: one unbound application without an entry-point profile, origin or handoff
 * configuration. Production starts only `startPanelEntrypoints`; nothing outside tests imports this module.
 */
export const startPanelServer = async (opts: PanelServerOptions = {}) => {
  const mfaRuntimePolicy = captureMfaRuntimePolicy()
  const port = opts.port ?? (Number(process.env.XPANEL_PORT ?? '2087') || 2087)
  const host = opts.host ?? process.env.XPANEL_HOST ?? '127.0.0.1'
  const defaultBaseDir = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
  const dbPath = opts.dbPath ?? process.env.XPANEL_DB_PATH ?? `${defaultBaseDir}/control.db`
  const stateDir = opts.stateDir ?? process.env.XPANEL_STATE_DIR ?? `${defaultBaseDir}/state`
  if (!opts.agentApp && (process.platform !== 'linux' || process.getuid?.() === 0)) {
    fail('PRECONDITION_FAILED', 'the API must run as an unprivileged Linux service with a separate agent')
  }
  const lifecycle = await prepareApiLifecycleStartup()
  let dbHandle: ReturnType<typeof createDb> | undefined
  let client: ReturnType<typeof createAgentClient> | undefined
  let listener: Awaited<ReturnType<typeof listenApiServer>> | undefined
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const errors: unknown[] = []
      try { await listener?.close() } catch (error) { errors.push(error) }
      try { client?.close() } catch (error) { errors.push(error) }
      try { await awaitLifecycleWriterDrain() } catch (error) { errors.push(error) }
      try { await dbHandle?.close() } catch (error) { errors.push(error) }
      try { await closeApiLifecycleParticipant(lifecycle.participant) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'API shutdown requires operational inspection')
    })()
    return closePromise
  }
  try {
    if (lifecycle.quarantined) {
      const app = createQuarantinedApiApp()
      listener = await createLifecycleBackgroundResources(() => listenApiServer(app, { port, host }))
      return { quarantined: true as const, app, port: listener.port, host, close }
    }
    const serverSecret = opts.serverSecret ?? await loadAgentCredentialFile(opts.serverSecretFile ?? process.env.XPANEL_SERVER_SECRET_FILE ?? '/etc/xpanel/server.secret')
    const agentToken = opts.agentToken ?? await loadAgentCredentialFile(opts.agentTokenFile ?? process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token')
    const os = opts.os ?? await detectHostOsProfile()
    const handle = await withLifecycleWriterAdmission(async () => {
      if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true })
      await mkdir(stateDir, { recursive: true })
      await assertStateWritable(stateDir)
      const opened = createDb(dbPath, lifecycle.managed ? { durability: 'strict' } : {})
      dbHandle = opened
      await migrate(opened.runner)
      await initializeOperationalMetadata(opened.db)
      await ensureRootPrincipal(opened.db, { ...(opts.rootPassword ? { password: opts.rootPassword } : {}) })
      return opened
    })
    const store = new StateStore(stateDir)
    if (!opts.agentApp) client = createLifecycleBackgroundResources(() => createAgentClient({ socketPath: opts.agentSocket ?? process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken }))
    const agentApp = opts.agentApp ?? client!
    const webRenderer = opts.webRenderer ?? await createDefaultWebRenderer({
      store, db: handle.db, serverSecret, mfaRuntimePolicy, agent: { fetch: request => agentApp.fetch(request), token: agentToken },
    })
    const app = createLifecycleBackgroundResources(() => createApiApp({
      db: handle.db, store, agentApp, agentToken, os, webRenderer, serverSecret, mfaRuntimePolicy,
      secureCookies: !opts.agentApp,
      allowedOrigins: opts.allowedOrigins ?? (process.env.XPANEL_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? []),
      trustedProxyAddresses: opts.trustedProxyAddresses ?? (process.env.XPANEL_TRUSTED_PROXIES?.split(',').filter(Boolean) ?? []),
      ...(opts.homeBaseDir ? { homeBaseDir: opts.homeBaseDir } : {}),
    }))
    listener = await createLifecycleBackgroundResources(() => listenApiServer(app, { port, host }))
    return {
      quarantined: false as const, app, port: listener.port, host, db: handle.db, store, close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
