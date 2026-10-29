import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { assertAccountFeatures } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { executeHtaccessWorkspaceRequest } from './htaccess-workspace.ts'
import { HTACCESS_MAX_BYTES } from '../../agent/src/htaccess-policy.ts'
import type { HtaccessRequest, HtaccessView } from '../../agent/src/htaccess-workspace.ts'
import { mergeWebDirective, parseManagedHtaccess, parseWebDirectiveModel, readWebDirective, webDirectivePolicyAllows } from '../../agent/src/htaccess-managed.ts'
import type { WebDirectiveFeature } from '../../agent/src/htaccess-managed.ts'

export const WEB_DIRECTIVES_ROUTE = /^\/api\/domains\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/web-directives\/(error-pages|indexes|mime-types|hotlink|ip-blocker|redirects)$/
/** Plan features per page; the agent's .htaccess route separately enforces aapanel-url-rewrite. */
export const WEB_DIRECTIVE_TOOL_IDS: Readonly<Record<WebDirectiveFeature, string>> = { 'error-pages': 'error-pages', indexes: 'indexes', 'mime-types': 'mime-types', hotlink: 'hotlink-protection', 'ip-blocker': 'ip-blocker', redirects: 'redirects' }
export interface WebDirectivesPorts {
  store: StateStore
  requireCaller(req: Request): Promise<AuthenticatedCaller>
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  readJsonBody(req: Request): Promise<Record<string, unknown>>
  callAgent(path: string, options: { caller: AuthenticatedCaller; method: string; body: unknown }): Promise<Response>
}
export type WebDirectiveReason = 'review_required' | 'engine' | 'inactive' | 'validator' | 'unavailable' | 'policy' | 'conflict' | null

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
// Fixed agent reasons from HtaccessWorkspace.view; anything else stays a generic unavailable state.
const AGENT_REASONS: Readonly<Record<string, WebDirectiveReason>> = { 'The domain is not an active file-backed site.': 'inactive', 'The protected Apache validation service is unavailable.': 'validator' }

/** Feature projection of the checked .htaccess view; the file content itself is not returned. */
export function projectWebDirective(feature: WebDirectiveFeature, view: HtaccessView) {
  const document = parseManagedHtaccess(view.document.content), current = readWebDirective(document, feature, { domainName: view.context.domainName })
  const reason: WebDirectiveReason = view.reviewRequired ? 'review_required' : view.context.engine !== 'apache' ? 'engine' : !view.capabilities.canSave ? AGENT_REASONS[view.capabilities.reason ?? ''] ?? 'unavailable'
    : !webDirectivePolicyAllows(feature) ? 'policy' : current.conflict ? 'conflict' : null
  return { feature, context: { accountId: view.context.accountId, domainId: view.context.domainId, domainName: view.context.domainName, path: view.context.path, engine: view.context.engine },
    document: { exists: view.document.exists, revision: view.document.revision, sizeBytes: view.document.sizeBytes, unmanagedLines: document.unmanagedLines, managedFeatures: [...document.blocks.keys()].sort() },
    managed: current.managed, model: current.model, conflict: current.conflict, capabilities: { canSave: reason === null, reason },
    application: { status: view.application.status, syntaxChecked: view.application.syntaxChecked, httpStatus: view.application.httpStatus, nativeQualified: false as const },
    ...(view.validation ? { validation: { valid: view.validation.valid, nativeChecked: view.validation.nativeChecked, issues: view.validation.issues.slice(0, 50).map(issue => ({ line: issue.line, code: issue.code })) } } : {}),
    ...(feature === 'error-pages' ? { existence: 'not-checked' as const } : {}) }
}

/** GET reads one feature; PUT re-reads, merges its block and submits the existing checked .htaccess save. */
export async function handleWebDirectivesRoute(req: Request, url: URL, method: string, ports: WebDirectivesPorts): Promise<Response | null> {
  const match = WEB_DIRECTIVES_ROUTE.exec(url.pathname)
  if (!match) return null
  if (url.search) return fail('VALIDATION', 'web directives do not accept query selectors', { stateChanged: false })
  if (method !== 'GET' && method !== 'PUT') return fail('VALIDATION', 'unsupported web directive method', { stateChanged: false })
  const domainId = match[1]!, feature = match[2] as WebDirectiveFeature
  const authorize = async (): Promise<{ caller: AuthenticatedCaller; account: Account; domain: Domain }> => {
    const caller = await ports.requireCaller(req)
    const domain = await ports.store.getDomain(domainId), account = domain ? await ports.store.getAccount(domain.accountId) : null
    if (!domain || !account) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
    await ports.assertCanAccessAccount(caller, account, 'domain.web-directives.' + feature)
    await assertAccountFeatures(ports.store, caller, account, ['aapanel-url-rewrite', WEB_DIRECTIVE_TOOL_IDS[feature]])
    return { caller, account, domain }
  }
  const first = await authorize(), target = { accountId: first.account.id, domainId: first.domain.id }
  const agentPath = '/accounts/' + first.account.username + '/htaccess/' + first.domain.id
  const send = (caller: AuthenticatedCaller, request: HtaccessRequest): Promise<Response> => executeHtaccessWorkspaceRequest(target, request, () => ports.callAgent(agentPath, { caller, method: 'POST', body: request }))
  const read = await send(first.caller, { op: 'read' })
  if (read.status !== 200) return read
  const view = await read.json() as HtaccessView, projected = projectWebDirective(feature, view)
  if (method === 'GET') return json(projected)
  const body = await ports.readJsonBody(req)
  if (!object(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'expectedRevision') || !Object.hasOwn(body, 'model')) return fail('VALIDATION', 'web directive saves take only expectedRevision and model', { stateChanged: false })
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'a saved .htaccess revision is required', { stateChanged: false })
  const model = parseWebDirectiveModel(feature, body.model, { domainName: view.context.domainName })
  if (view.document.revision !== body.expectedRevision) return fail('CONFLICT', '.htaccess changed; read it before saving', { stateChanged: false })
  if (!projected.capabilities.canSave) return fail('PRECONDITION_FAILED', 'this web directive cannot be saved now', { stateChanged: false, reason: projected.capabilities.reason, conflict: projected.conflict })
  const content = mergeWebDirective(view.document.content, feature, model, { domainName: view.context.domainName })
  if (content === view.document.content) return fail('VALIDATION', 'there is no managed change to save', { stateChanged: false, fields: [{ field: 'model', code: 'unchanged' }] })
  if (Buffer.byteLength(content, 'utf8') > HTACCESS_MAX_BYTES) return fail('LIMIT_EXCEEDED', 'the .htaccess file would exceed 64 KiB', { stateChanged: false, fields: [{ field: 'model', code: 'too_large' }] })
  // Fresh authority immediately before the mutation; the agent re-checks again inside its account lease.
  const fresh = await authorize()
  if (fresh.account.id !== first.account.id || fresh.account.username !== first.account.username || fresh.domain.id !== first.domain.id || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'the domain binding changed before saving', { stateChanged: false })
  const saved = await send(fresh.caller, { op: 'save', content, expectedRevision: body.expectedRevision })
  if (saved.status !== 200) return saved
  const result = await saved.json() as HtaccessView
  // The agent reply is its own post-write re-read; an unexpected body is not reported as success.
  if (!['saved', 'validated', 'rolled_back'].includes(result.application.status) || result.application.status === 'saved' && (result.document.content !== content || !result.application.syntaxChecked)
    || result.application.status === 'validated' && (result.document.revision !== body.expectedRevision || result.validation?.valid !== false)) return fail('SERVICE_UNAVAILABLE', 'web directive outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(projectWebDirective(feature, result))
}
