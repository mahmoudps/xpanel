import { fail } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import type { AgentCallerIdentity } from './server.ts'
import type { JailedFileManager } from './file-manager.ts'
import { deriveSitePublisherTarget, parseSitePublisherDraft, renderSitePublisherDraft, SitePublisherWorkspace } from './site-publisher.ts'

export interface SitePublisherAgentDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getDomain(id: string): Promise<Domain | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  files(account: Account, plan: Plan): Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'> | null
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown>; principalId: string }): Promise<unknown>
}
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/site-publisher\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(preview|publish|rollback))?$/
const unchanged = { stateChanged: false }
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
export async function readSitePublisherBody(req: Request): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const declared = req.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) return fail('VALIDATION', 'site publisher request is too large', unchanged)
  if (!req.body) return fail('VALIDATION', 'site publisher request must be valid JSON', unchanged)
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: string
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 16_384) { await reader.cancel(); return fail('VALIDATION', 'site publisher request is too large', unchanged) } chunks.push(chunk.value) }
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) } catch { return fail('VALIDATION', 'site publisher request must be UTF-8', unchanged) }
  } finally { reader.releaseLock() }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail('VALIDATION', 'site publisher request must be valid JSON', unchanged) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'site publisher request must be an object', unchanged)
  return value as Record<string, unknown>
}
export function parseSitePublisherMutation(body: Record<string, unknown>, operation: string) {
  const keys = operation === 'publish' ? ['expectedRevision', 'draft'] : ['expectedRevision']
  if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'site publisher mutation requires the captured revision', unchanged)
  return { expectedRevision: body.expectedRevision, ...(operation === 'publish' ? { draft: parseSitePublisherDraft(body.draft) } : {}) }
}
/** Owner-only route; identity, domain binding and feature authority are rechecked before each confined write. */
export async function handleSitePublisherAgentRoute(req: Request, url: URL, method: string, deps: SitePublisherAgentDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const username = match[1]!, domainId = match[2]!, operation = match[3] ?? 'read', caller = deps.caller
  if (method !== (operation === 'read' ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: operation === 'read' ? 'GET' : 'POST' } })
  if (url.search) return fail('VALIDATION', 'site publisher does not accept query selectors', unchanged)
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'site publisher requires the account owner', unchanged)
  const account = await deps.store.getAccountByUsername(username)
  if (!account || account.id !== caller.accountId) return fail('NOT_FOUND', 'account not found', unchanged)
  const authorize = async (fresh: Account) => {
    const principal = await deps.currentPrincipal(), domain = await deps.store.getDomain(domainId)
    if (fresh.id !== account.id || fresh.username !== username || fresh.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== fresh.id || principal.username !== username) return fail('FORBIDDEN', 'the current owner is not authorized', unchanged)
    if (!domain || domain.accountId !== fresh.id) return fail('NOT_FOUND', 'domain not found', unchanged)
    const plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!plan || !features || features.disabled.includes('site-publisher')) return fail('FORBIDDEN', 'site publisher is disabled by the account plan', unchanged)
    return { target: deriveSitePublisherTarget(fresh, domain), plan }
  }
  const first = await authorize(account), body = operation === 'read' ? null : await readSitePublisherBody(req)
  const mutation = operation === 'publish' || operation === 'rollback' ? parseSitePublisherMutation(body!, operation) : null
  const draft = operation === 'preview' ? parseSitePublisherDraft(body) : null
  if (operation === 'preview') { await authorize(account); return json(renderSitePublisherDraft(draft)) }
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const latest = await authorize(fresh)
    if (JSON.stringify(latest.target) !== JSON.stringify(first.target)) return fail('CONFLICT', 'domain changed; reload before publishing', unchanged)
    const files = deps.files(fresh, latest.plan)
    if (!files) return fail('PRECONDITION_FAILED', 'confined account file service is unavailable', unchanged)
    const check = async () => {
      const current = await authorize(fresh)
      if (JSON.stringify(current.target) !== JSON.stringify(latest.target)) return fail('CONFLICT', 'domain changed during publication', unchanged)
    }
    const workspace = new SitePublisherWorkspace(latest.target, files, check)
    const view = operation === 'read' ? await workspace.inspect() : operation === 'publish' ? await workspace.publish(mutation!.expectedRevision, mutation!.draft!) : await workspace.rollback(mutation!.expectedRevision)
    if (operation !== 'read') {
      try { await deps.audit({ actor: caller.actor, action: 'domain.site_publisher.' + operation, target: 'domain:' + latest.target.domainName, outcome: 'ok', detail: { file: 'index.html', previousIndexCount: 3, recovery: view.recovery.status, revision: view.revision }, principalId: caller.principalId }) }
      catch { return fail('SERVICE_UNAVAILABLE', 'site publisher completed but its audit requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
    }
    return json(view)
  })
}
