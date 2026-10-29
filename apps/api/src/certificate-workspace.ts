import { fail } from '@xpanel/core'
import type { Account, Domain, Id } from '@xpanel/core'
import type { StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { ownedAccounts } from './authorization.ts'
import { services } from '@xpanel/render'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export interface CertificateWorkspaceInstall {
  username: string; domain: string; expectedRevision: number; fullchainPem: string; privateKeyPem: string; requiredNames?: string[]
}
export interface CertificateWorkspaceHelpers {
  issueAvailable?: boolean
  removeAvailable?: boolean
  readObservations?: (input: { caller: AuthenticatedCaller; accounts: readonly Account[]; domains: readonly Domain[]; certificates: readonly StoredCertificate[] }) => Promise<unknown>
  store: StateStore
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertAdministrator: (caller: AuthenticatedCaller) => Promise<void>
  assertCanReadAccount: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  assertCanWriteAccount: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  /** Account-owner admission for /api/accounts/:username/certificates; absent means the account routes are not mounted. */
  assertAccountCaller?: (caller: AuthenticatedCaller, account: Account, method: string) => Promise<void>
  /** Trusted mutation port enforces fresh authorization/CAS under the writer lease, audit and reconcile. */
  removeCertificate: (input: { request: Request; caller: AuthenticatedCaller; certificate: StoredCertificate; expectedRevision: number; scope: CertificateRouteScope }) => Promise<unknown>
  /** Agent material must remain on the trusted API-to-agent boundary; never echo PEM to HTTP. */
  installCertificate?: (input: { request: Request; caller: AuthenticatedCaller; account: Account; domain: Domain; body: CertificateWorkspaceInstall; scope: CertificateRouteScope }) => Promise<{ certificate: StoredCertificate; reconcile?: unknown }>
}
/** "workspace" is the root/reseller WHM view; "account" is one account owner's own certificates. */
export type CertificateRouteScope = 'workspace' | 'account'
const ACCOUNT_CERTIFICATES = /^\/api\/accounts\/([a-z][a-z0-9]{0,15})\/certificates(?:\/([0-9a-f-]{36}|install))?$/

export const projectWorkspaceCertificate = (certificate: StoredCertificate, accounts: ReadonlyMap<Id, Account>, domains: readonly Domain[]) => ({
  id: certificate.id, accountId: certificate.accountId,
  username: certificate.accountId ? accounts.get(certificate.accountId)?.username ?? null : null,
  names: [...certificate.names], source: certificate.source, challenge: certificate.challenge,
  notBefore: certificate.notBefore, notAfter: certificate.notAfter, autoRenew: certificate.autoRenew,
  fingerprintSha256: certificate.fingerprintSha256, renewedAt: certificate.renewedAt,
  assignedDomains: domains.filter(domain => domain.certificateId === certificate.id).map(domain => domain.name).sort(),
})

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'certificate workspace body must be an object', { stateChanged: false })
  return value as Record<string, unknown>
}
async function readWorkspaceBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'certificate workspace requires JSON', { stateChanged: false })
  let value: unknown
  try { value = await request.json() } catch { return fail('VALIDATION', 'invalid certificate workspace JSON', { stateChanged: false }) }
  return objectBody(value)
}
export function certificateWorkspaceRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail('VALIDATION', 'expectedRevision must be a saved authority revision', { stateChanged: false })
  return value
}

export function createCertificateWorkspaceRouter(helpers: CertificateWorkspaceHelpers) {
  return async (request: Request, url: URL, method: string): Promise<Response | null> => {
    const workspaceMatch = /^\/api\/certificate-workspace(?:\/([0-9a-f-]{36}|install|observations))?$/.exec(url.pathname)
    const accountMatch = workspaceMatch || !helpers.assertAccountCaller ? null : ACCOUNT_CERTIFICATES.exec(url.pathname)
    // A POST to the bare account path is the ACME issue/renew route, served by the certificate runtime.
    if (!workspaceMatch && (!accountMatch || (!accountMatch[2] && method === 'POST'))) return null
    const scope: CertificateRouteScope = workspaceMatch ? 'workspace' : 'account'
    const match = [url.pathname, workspaceMatch ? workspaceMatch[1] : accountMatch![2]] as const
    const caller = await helpers.requireCaller(request)
    let allowedIds: Set<Id>
    if (accountMatch) {
      const target = await helpers.store.getAccountByUsername(accountMatch[1]!)
      if (!target) return fail('NOT_FOUND', 'certificate account not found', { stateChanged: false })
      await helpers.assertAccountCaller!(caller, target, method)
      allowedIds = new Set([target.id])
    } else {
      await helpers.assertAdministrator(caller)
      allowedIds = new Set((await ownedAccounts(helpers.store, caller)).map(account => account.id))
    }
    if (url.search) return fail('VALIDATION', 'certificate workspace does not accept account selectors', { stateChanged: false })
    const snapshot = await helpers.store.readSnapshot()
    const accounts = snapshot.accounts.filter(account => allowedIds.has(account.id) && (scope === 'account' || caller.principal.kind === 'root' || account.ownerId === caller.principal.id))
    if (scope === 'account' && accounts.length !== 1) return fail('CONFLICT', 'certificate account changed; reload before retrying', { stateChanged: false })
    for (const account of accounts) await helpers.assertCanReadAccount(caller, account)
    const byId = new Map(accounts.map(account => [account.id, account]))
    const revision = certificateWorkspaceRevision(snapshot.revision)
    const domains = snapshot.domains.filter(domain => byId.has(domain.accountId))
    const certificates = snapshot.certificates.filter(certificate => certificate.accountId === null ? scope === 'workspace' && caller.principal.kind === 'root' : byId.has(certificate.accountId))
    const project = (certificate: StoredCertificate) => projectWorkspaceCertificate(certificate, byId, domains)
    const response = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    if (scope === 'workspace' && match[1] === 'observations' && method === 'GET') {
      if (!helpers.readObservations) return response({ state: 'unavailable', scope: 'authorized_saved_certificate_ids', inventoryComplete: false, accounts: [], managementTls: { state: 'unavailable' } })
      return response(await helpers.readObservations({ caller, accounts, domains, certificates }))
    }
    if (!match[1] && method === 'GET') return response({ revision,
      accounts: accounts.map(account => ({ id: account.id, username: account.username, status: account.status })),
      domains: domains.map(domain => ({ id: domain.id, accountId: domain.accountId, name: domain.name, certificateId: domain.certificateId })),
      certificates: certificates.map(project),
      capabilities: { issue: helpers.issueAvailable === true, renew: helpers.issueAvailable === true, install: !!helpers.installCertificate, remove: helpers.removeAvailable !== false },
      application: { scope: 'stored_configuration', servedTlsVerified: false },
      // No daily AutoSSL job is wired to certsForAutoRenew yet; the page must not promise automatic renewal.
      renewalScheduler: { state: 'unavailable', nextRunAt: null, reason: 'site_scheduler_not_connected' },
    })
    if (match[1] && ID.test(match[1]) && method === 'DELETE') {
      const body = await readWorkspaceBody(request)
      if (Object.keys(body).some(key => key !== 'expectedRevision')) return fail('VALIDATION', 'unsupported certificate removal field', { stateChanged: false })
      const expectedRevision = certificateWorkspaceRevision(body.expectedRevision)
      const certificate = certificates.find(item => item.id === match[1]!.toLowerCase())
      if (!certificate) return fail('NOT_FOUND', 'certificate not found', { stateChanged: false })
      if (expectedRevision !== revision) return fail('CONFLICT', 'certificate workspace changed; reload before retrying', { stateChanged: false })
      if (certificate.accountId) await helpers.assertCanWriteAccount(caller, byId.get(certificate.accountId)!)
      const reconcile = await helpers.removeCertificate({ request, caller, certificate, expectedRevision, scope })
      const after = await helpers.store.readSnapshot()
      if (after.certificates.some(item => item.id === certificate.id) || after.domains.some(domain => domain.certificateId === certificate.id)) return fail('SERVICE_UNAVAILABLE', 'certificate removal readback requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      return response({ ok: true, removedCertificateId: certificate.id, reconcile,
        application: { scope: 'stored_configuration', servedTlsVerified: false, revocationPerformed: false } })
    }
    if (match[1] === 'install' && method === 'POST') {
      if (!helpers.installCertificate) return fail('PRECONDITION_FAILED', 'manual certificate installation is not connected', { stateChanged: false })
      const body = await readWorkspaceBody(request)
      // The account route takes its account from the path; only the workspace names one in the body.
      if (scope === 'account') {
        if (Object.hasOwn(body, 'username')) return fail('VALIDATION', 'unsupported manual certificate field', { stateChanged: false })
        body.username = accounts[0]!.username
      }
      if (Object.keys(body).some(key => !['username', 'domain', 'expectedRevision', 'fullchainPem', 'privateKeyPem', 'requiredNames'].includes(key))) return fail('VALIDATION', 'unsupported manual certificate field', { stateChanged: false })
      if (body.requiredNames !== undefined && (!Array.isArray(body.requiredNames) || body.requiredNames.length > 20 || body.requiredNames.some(name => typeof name !== 'string'))) return fail('VALIDATION', 'requiredNames must be a list of at most 20 host names', { stateChanged: false })
      const expectedRevision = certificateWorkspaceRevision(body.expectedRevision)
      if (typeof body.username !== 'string' || typeof body.domain !== 'string' || typeof body.fullchainPem !== 'string' || typeof body.privateKeyPem !== 'string') return fail('VALIDATION', 'account, domain, certificate chain and private key are required', { stateChanged: false })
      if (!body.fullchainPem || Buffer.byteLength(body.fullchainPem, 'utf8') > 256 * 1024 || !body.privateKeyPem || Buffer.byteLength(body.privateKeyPem, 'utf8') > 32 * 1024) return fail('VALIDATION', 'certificate or private key is missing or exceeds its size limit', { stateChanged: false })
      if (expectedRevision !== revision) return fail('CONFLICT', 'certificate workspace changed; reload before retrying', { stateChanged: false })
      const account = accounts.find(account => account.username === body.username)
      const domain = account && domains.find(domain => domain.accountId === account.id && domain.name === body.domain)
      if (!account || !domain) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
      await helpers.assertCanWriteAccount(caller, account)
      const result = await helpers.installCertificate({ request, caller, account, domain, body: { username: body.username, domain: domain.name, expectedRevision, fullchainPem: body.fullchainPem, privateKeyPem: body.privateKeyPem, ...(body.requiredNames !== undefined ? { requiredNames: body.requiredNames as string[] } : {}) }, scope })
      if (result.certificate.accountId !== account.id || !services.coversHost(result.certificate.names, domain.name)) return fail('SERVICE_UNAVAILABLE', 'certificate installation result requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      const after = await helpers.store.readSnapshot()
      const persisted = after.certificates.find(certificate => certificate.id === result.certificate.id)
      if (!persisted || persisted.accountId !== account.id || persisted.notAfter !== result.certificate.notAfter || persisted.fingerprintSha256 !== result.certificate.fingerprintSha256 || JSON.stringify(persisted.names) !== JSON.stringify(result.certificate.names) || !after.domains.some(item => item.id === domain.id && item.accountId === account.id && item.certificateId === persisted.id)) return fail('SERVICE_UNAVAILABLE', 'certificate installation readback requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      return response({ certificate: projectWorkspaceCertificate(persisted, byId, after.domains.filter(item => byId.has(item.accountId))), reconcile: result.reconcile,
        application: { scope: 'stored_configuration', servedTlsVerified: false } })
    }
    return fail('NOT_FOUND', 'certificate workspace operation not found', { stateChanged: false })
  }
}
