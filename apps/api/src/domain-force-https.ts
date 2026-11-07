import { fail, isUuid } from '@xpanel/core'
import type { Account, Certificate, Domain, Id } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { DomainMutationOptions } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'

export const FORCE_HTTPS_BATCH = 200
const ROUTE = '/api/domains/force-https'
const unchanged = { stateChanged: false }

export interface ForceHttpsPorts {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  getDomain: (id: Id) => Promise<Domain | null>
  getAccount: (id: Id) => Promise<Account | null>
  listCertificates: (account: Account) => Promise<Certificate[]>
  assertCanModify: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  mutate: (request: Request, caller: AuthenticatedCaller, account: Account, expected: unknown, change: (options: DomainMutationOptions) => Promise<Domain[]>) => Promise<{ reconcile: unknown; view: Record<string, unknown> }>
  setForceHttps: (accountId: Id, ids: readonly Id[], enabled: boolean, options: DomainMutationOptions) => Promise<Domain[]>
  now?: () => Date
}

/** The certificate the edge would serve for the name, if it is still valid. */
export const httpsCovered = (domain: Domain, certificates: Certificate[], now: Date): boolean => {
  const certificate = edge.certForName(domain.name, domain, domain, certificates)
  return !!certificate && Date.parse(certificate.notAfter) > now.getTime()
}

/** POST /api/domains/force-https: one or many sites of one account in a single state change and reconcile. */
export async function handleForceHttpsRoute(request: Request, url: URL, method: string, ports: ForceHttpsPorts): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await ports.requireCaller(request)
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'the HTTPS redirect takes no selectors', unchanged)
  const body = await ports.readJsonBody(request)
  if (Object.keys(body).some(key => !['domainIds', 'enabled', 'expectedRevision'].includes(key)) || typeof body.enabled !== 'boolean') return fail('VALIDATION', 'exactly domainIds, enabled and expectedRevision are accepted', unchanged)
  const ids = body.domainIds
  if (!Array.isArray(ids) || !ids.length || ids.length > FORCE_HTTPS_BATCH || !ids.every(id => typeof id === 'string' && isUuid(id)) || new Set(ids).size !== ids.length) return fail('VALIDATION', `1 to ${FORCE_HTTPS_BATCH} distinct domain ids are required`, unchanged)
  const domains: Domain[] = []
  for (const id of ids as Id[]) domains.push(await ports.getDomain(id) ?? fail('NOT_FOUND', 'domain not found', unchanged))
  const accountId = domains[0]!.accountId
  if (domains.some(domain => domain.accountId !== accountId)) return fail('VALIDATION', 'the sites must belong to one account', unchanged)
  const account = await ports.getAccount(accountId) ?? fail('NOT_FOUND', 'account not found', unchanged)
  await ports.assertCanModify(caller, account)
  if (body.enabled) {
    const certificates = await ports.listCertificates(account), now = ports.now?.() ?? new Date()
    const missing = domains.filter(domain => !httpsCovered(domain, certificates, now)).map(domain => domain.name)
    if (missing.length) return fail('PRECONDITION_FAILED', 'a valid certificate must cover the domain first', { ...unchanged, reason: 'cert_required', domains: missing.slice(0, 10) })
  }
  const { reconcile, view } = await ports.mutate(request, caller, account, body.expectedRevision, options => ports.setForceHttps(accountId, ids as Id[], body.enabled as boolean, options))
  return new Response(JSON.stringify({ ...view, stateChanged: true, reconcile }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
