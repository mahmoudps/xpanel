import { createHmac } from 'node:crypto'
import { DEFAULT_INDEX_FILES, fail, isXpanelError, validateDomainIndexFiles, validateDomainName } from '@xpanel/core'
import type { Account, Domain, DomainWorkspaceTransition } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

type Audit = Parameters<ExtendedRouteHelpers['emitAudit']>[0]
export interface DefaultIndexWorkspaceHelpers {
  store: Pick<StateStore, 'listDomains' | 'getDomainByName' | 'getAccount' | 'getServerSettings' | 'getRevision' | 'readDomainWorkspace' | 'updateDomain'>
  serverSecret: string
  requireCaller: (req: Request, options?: { deferDeniedAudit?: (input: Audit) => void }) => Promise<AuthenticatedCaller>
  assertRoot: ExtendedRouteHelpers['assertRoot']
  emitAudit: ExtendedRouteHelpers['emitAudit']
  /** Admission belongs to actual configured capability/host qualification, never request hints. */
  assertMutationQualified: (caller: AuthenticatedCaller, account: Account, domain: Domain) => Promise<void>
  prepareProjection?: (transition: DomainWorkspaceTransition) => Promise<{ apply: () => Promise<void>; rollback: () => Promise<void> }>
  applyConfiguration?: (caller: AuthenticatedCaller, account: Account, revision: number) => Promise<{ status: 'global_configuration_applied'; targetVerified: false }>
}
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } })
const unknown = (): never => fail('SERVICE_UNAVAILABLE', 'index configuration requires inspection before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
export function parseDefaultIndexList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length > 1055 || !raw.isWellFormed()) return fail('VALIDATION', 'a bounded comma-separated index list is required', { stateChanged: false })
  return validateDomainIndexFiles(raw.split(',').map(value => value.trim()))
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !req.body) return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) { await reader.cancel(); return fail('VALIDATION', 'index request is too large', { stateChanged: false }) } chunks.push(part.value) }
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return fail('VALIDATION', 'valid UTF-8 JSON is required', { stateChanged: false }) }
    if (!object(raw)) return fail('VALIDATION', 'index request must be an object', { stateChanged: false })
    return raw
  } finally { reader.releaseLock() }
}

export function createDefaultIndexWorkspaceRoutes(helpers: DefaultIndexWorkspaceHelpers) {
  const root = async (req: Request, action: string, original?: AuthenticatedCaller, deferred?: Audit[]) => {
    const caller = await helpers.requireCaller(req, deferred ? { deferDeniedAudit: input => { deferred.push(input) } } : undefined)
    if (caller.principal.kind !== 'root' || original && (caller.principal.id !== original.principal.id || caller.sessionId !== original.sessionId || caller.apiTokenId !== original.apiTokenId)) return fail('FORBIDDEN', 'the current root administrator is required', { stateChanged: false })
    await helpers.assertRoot(caller, action)
    return caller
  }
  const capture = async (name: string) => {
    const before = await helpers.store.getRevision(), domain = await helpers.store.getDomainByName(name)
    if (!domain) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
    const [workspace, settings] = await Promise.all([helpers.store.readDomainWorkspace(domain.accountId), helpers.store.getServerSettings()])
    const after = await helpers.store.getRevision(), current = workspace.source.domains.find(item => item.id === domain.id && item.name === name)
    if (before !== after || !current || workspace.source.account.id !== domain.accountId) return fail('CONFLICT', 'domain configuration changed during read; explicitly reload', { stateChanged: false })
    if (!settings || !['apache', 'openlitespeed'].includes(settings.engine)) return fail('PRECONDITION_FAILED', 'the configured web engine is unavailable', { stateChanged: false })
    const account = workspace.source.account
    const supported = current.kind !== 'alias' && ['static', 'php'].includes(current.siteType) && current.redirect === null && account.status === 'active' && !current.suspended && (current.expiresAt === null || Date.parse(current.expiresAt) > Date.now())
    const indexFiles = validateDomainIndexFiles(current.indexFiles ?? [...DEFAULT_INDEX_FILES])
    const revision = createHmac('sha256', helpers.serverSecret).update('xpanel-default-index:v1\0').update(JSON.stringify({ authority: after, domain: current.id, workspace: workspace.revision, engine: settings.engine })).digest('hex')
    return { domain: current, account, workspace, settings, authority: after, indexFiles, revision, supported }
  }
  const project = (saved: Awaited<ReturnType<typeof capture>>, qualified: boolean, application: 'unverified' | 'not_requested' | 'global_configuration_applied' = 'unverified') => ({
    configuration: { state: 'read', source: 'saved-domain-configuration', domain: { name: saved.domain.name, siteType: saved.domain.siteType, kind: saved.domain.kind }, engine: saved.settings.engine,
      indexFiles: saved.indexFiles, explicit: saved.domain.indexFiles !== undefined, revision: saved.revision },
    actions: { preview: saved.supported, save: saved.supported && qualified, reset: saved.supported && qualified }, application: { status: application, targetVerified: false },
  })
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/server/default-index' && !url.pathname.startsWith('/api/server/default-index/')) return null
    const caller = await root(req, method === 'PUT' || url.pathname.endsWith('/reset') ? 'server.default_index.update' : 'server.default_index.read')
    if (url.searchParams.size) return fail('VALIDATION', 'index operations accept no account, path or command selectors', { stateChanged: false })
    if (url.pathname === '/api/server/default-index') {
      if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
      const domains = await helpers.store.listDomains()
      if (domains.length > 10000) return fail('PRECONDITION_FAILED', 'domain inventory exceeds workspace capacity', { stateChanged: false })
      await root(req, 'server.default_index.read', caller)
      return json({ source: 'saved-domain-configuration', domains: domains.map(domain => ({ name: domain.name, kind: domain.kind, siteType: domain.siteType })) })
    }
    const match = /^\/api\/server\/default-index\/([^/]+)(?:\/(preview|reset))?$/.exec(url.pathname)
    if (!match) return fail('NOT_FOUND', 'index workspace route not found', { stateChanged: false })
    let name: string
    try { const decoded = decodeURIComponent(match[1]!); name = validateDomainName(decoded); if (decoded !== name) return fail('VALIDATION', 'a canonical domain name is required', { stateChanged: false }) } catch { return fail('VALIDATION', 'a canonical domain name is required', { stateChanged: false }) }
    const operation = match[2], save = method === 'PUT' && !operation, reset = method === 'POST' && operation === 'reset', preview = method === 'POST' && operation === 'preview'
    if (!(method === 'GET' && !operation || save || reset || preview)) return new Response(null, { status: 405, headers: { allow: operation ? 'POST' : 'GET, PUT' } })
    const current = await capture(name)
    if (method === 'GET') {
      let qualified = false
      if (current.supported) try { await helpers.assertMutationQualified(caller, current.account, current.domain); qualified = true } catch { /* Reading desired state grants no native qualification. */ }
      await root(req, 'server.default_index.read', caller)
      return json(project(current, qualified))
    }
    const raw = await body(req), keys = reset ? ['expectedRevision', 'confirmation'] : preview ? ['expectedRevision', 'indexFiles'] : ['expectedRevision', 'indexFiles', 'confirmation']
    if (Object.keys(raw).some(key => !keys.includes(key)) || typeof raw.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.expectedRevision)) return fail('VALIDATION', 'a saved index revision and supported fields are required', { stateChanged: false })
    if (raw.expectedRevision !== current.revision) return fail('CONFLICT', 'index configuration changed; explicitly reload before retrying', { stateChanged: false })
    if (!current.supported) return fail('PRECONDITION_FAILED', 'index editing requires an active static or PHP serving domain; aliases inherit their serving vhost', { stateChanged: false })
    const indexFiles = reset ? [...DEFAULT_INDEX_FILES] : parseDefaultIndexList(raw.indexFiles)
    if (preview) {
      await root(req, 'server.default_index.read', caller)
      return json({ ...project(current, false), preview: { indexFiles, revision: current.revision, engine: current.settings.engine, syntaxChecked: false,
        lines: current.settings.engine === 'apache' ? ['DirectoryIndex disabled', 'DirectoryIndex ' + indexFiles.join(' ')] : ['useServer 0', 'indexFiles ' + indexFiles.join(', ')] } })
    }
    if (raw.confirmation !== name) return fail('VALIDATION', 'confirmation must match the selected domain name', { stateChanged: false })
    await helpers.assertMutationQualified(caller, current.account, current.domain)
    let committed: number | undefined, attempted = false, freshCaller = caller
    const deferred: Audit[] = []
    try {
      try {
        await helpers.store.updateDomain(current.domain.id, { indexFiles }, { expectedRevision: current.authority, domainGuard: {
          accountId: current.account.id, expectedRevision: current.workspace.revision,
          authorize: async (account, domain) => {
            freshCaller = await root(req, 'server.default_index.update', caller, deferred)
            if (!domain || domain.id !== current.domain.id || domain.name !== name || domain.accountId !== account.id || domain.kind === 'alias' || !['static', 'php'].includes(domain.siteType) || domain.redirect !== null || domain.suspended || account.status !== 'active' || domain.expiresAt !== null && Date.parse(domain.expiresAt) <= Date.now()) return fail('CONFLICT', 'the selected serving domain changed; explicitly reload', { stateChanged: false })
            await helpers.assertMutationQualified(freshCaller, account, domain)
            freshCaller = await root(req, 'server.default_index.update', caller, deferred)
            attempted = true
          },
          ...(helpers.prepareProjection ? { prepareProjection: helpers.prepareProjection } : {}),
          onCommitted: revision => { committed = revision },
        } })
      } finally { for (const audit of deferred) await helpers.emitAudit(audit) }
      const saved = await capture(name)
      if (committed === undefined || saved.authority !== committed || JSON.stringify(saved.domain.indexFiles) !== JSON.stringify(indexFiles)) return unknown()
      freshCaller = await root(req, 'server.default_index.update', caller)
      let application: 'not_requested' | 'global_configuration_applied' = 'not_requested'
      if (helpers.applyConfiguration) {
        await helpers.assertMutationQualified(freshCaller, saved.account, saved.domain)
        freshCaller = await root(req, 'server.default_index.update', caller)
        const applied = await helpers.applyConfiguration(freshCaller, saved.account, committed)
        if (!object(applied) || applied.status !== 'global_configuration_applied' || applied.targetVerified !== false) return unknown()
        application = 'global_configuration_applied'
        const readback = await capture(name)
        if (readback.revision !== saved.revision) return unknown()
      }
      await root(req, 'server.default_index.update', caller)
      await helpers.emitAudit({ actor: freshCaller.principal.username, action: reset ? 'server.default_index.reset' : 'server.default_index.updated', target: 'domain:' + name, detail: { indexFiles, nativeTargetVerified: false }, outcome: 'ok', principalId: freshCaller.principal.id }, { accountId: saved.account.id, resellerId: saved.account.ownerId })
      return json({ ...project(saved, true, application), stateChanged: true })
    } catch (error) {
      if (committed === undefined && (!attempted || isXpanelError(error) && error.detail?.stateChanged === false)) throw error
      return unknown()
    }
  }
}
