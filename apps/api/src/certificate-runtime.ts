import { fail, isUuid, assertAcl, isXpanelError } from '@xpanel/core'
import { createManualCertificateInstall } from './certificate-install.ts'
import type { Account, AuditEntry, Domain, Id, LiveEventScope, Reseller } from '@xpanel/core'
import { services } from '@xpanel/render'
import { validateCertificateRenewalTarget } from '@xpanel/agent'
import type { NewAuditEntry } from '@xpanel/db'
import type { NewCertificate, StateStore, StoredCertificate } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { assertApiScope, isMailboxPrincipal } from './authorization.ts'
import { createCertificateWorkspaceRouter, certificateWorkspaceRevision, projectWorkspaceCertificate } from './certificate-workspace.ts'
import type { CertificateRouteScope, CertificateWorkspaceInstall } from './certificate-workspace.ts'

export interface CertificateRuntimeHelpers {
  store: StateStore
  hostAvailable: boolean
  requireCaller: (request: Request, options?: { deferDeniedAudit?: (input: NewAuditEntry) => void }) => Promise<AuthenticatedCaller>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
  assertCanBindCertificate: (caller: AuthenticatedCaller, account: Account) => Promise<void>
  resolveResellerForCaller: (caller: AuthenticatedCaller) => Promise<Reseller | null>
  callAgent: (path: string, options: { method?: string; body?: unknown; caller: AuthenticatedCaller }) => Promise<Response>
  triggerReconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
  emitAudit: (input: NewAuditEntry, scope?: LiveEventScope) => Promise<AuditEntry>
  requireHostAgent: () => void
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>
  jsonResponse: (body: unknown) => Response
}

/** One mounted runtime for the existing account endpoint and the WHM certificate workspace. */
export function createCertificateRuntimeRouter(helpers: CertificateRuntimeHelpers) {
  const { requireCaller, assertCanAccessAccount, assertCanBindCertificate, resolveResellerForCaller,
    callAgent, triggerReconcile, emitAudit, readJsonBody, jsonResponse, requireHostAgent: requireAccountHostAgent } = helpers
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const pathname = url.pathname
      const accountCertificatesMatch = /^\/api\/accounts\/([a-z][a-z0-9]{0,15})\/certificates(\/[^/]+)?$/.exec(pathname)
      const workspacePath = pathname === '/api/certificate-workspace' || pathname.startsWith('/api/certificate-workspace/')
      if (workspacePath || accountCertificatesMatch) {
        const asObject = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
        const assertAdministrator = async (caller: AuthenticatedCaller): Promise<void> => {
          if (isMailboxPrincipal(caller) || !['root', 'reseller'].includes(caller.principal.kind)) return fail('FORBIDDEN', 'root or reseller certificate access is required', { stateChanged: false })
          if (caller.apiTokenId !== null) assertApiScope(caller, method === 'GET' ? 'tls:read' : 'tls:write')
          if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'manage-ssl')
        }
        /** Account routes: no administrator role, but never a mailbox session and always a TLS-scoped token. */
        const assertAccountScope = (caller: AuthenticatedCaller, write: boolean): void => {
          if (isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'account certificate access is required', { stateChanged: false })
          if (caller.apiTokenId !== null) assertApiScope(caller, write ? 'tls:write' : 'tls:read')
        }
        const assertRouteScope = async (caller: AuthenticatedCaller, scope: CertificateRouteScope): Promise<void> => {
          if (scope === 'workspace') await assertAdministrator(caller)
          else assertAccountScope(caller, true)
        }
        const freshAccount = async (request: Request, initial: AuthenticatedCaller, accountId: Id,
          deferred?: Parameters<typeof emitAudit>[0][], administrator = false): Promise<{ caller: AuthenticatedCaller; account: Account }> => {
          const caller = await requireCaller(request, deferred ? { deferDeniedAudit: input => { deferred.push(input) } } : undefined)
          if (caller.principal.id !== initial.principal.id || caller.principal.kind !== initial.principal.kind || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'certificate authorization changed', { stateChanged: false })
          if (administrator) await assertAdministrator(caller)
          const account = await helpers.store.getAccount(accountId)
          if (!account) return fail('NOT_FOUND', 'certificate account not found', { stateChanged: false })
          if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'an active account is required for certificate changes', { stateChanged: false })
          await assertCanAccessAccount(caller, account, 'certificates')
          await assertCanBindCertificate(caller, account)
          return { caller, account }
        }
        const applyCertificateChange = async (caller: AuthenticatedCaller, expectedRevision: number) => {
          const result = await triggerReconcile(caller)
          if (!result || !result.ok || !['applied', 'noop'].includes(String(result.body.status)) || await helpers.store.getRevision() !== expectedRevision) return fail('SERVICE_UNAVAILABLE', 'certificate configuration application requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          const generation = asObject(result.body.generation)
          if (result.body.status === 'applied' && (!generation || !Number.isSafeInteger(generation.id) || Number(generation.id) < 1 || generation.status !== 'active' || typeof generation.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(generation.checksum))) return fail('SERVICE_UNAVAILABLE', 'certificate configuration generation requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          return { status: result.body.status, scope: 'global_configuration', targetVerified: false,
            ...(generation && Number.isSafeInteger(generation.id) && typeof generation.checksum === 'string'
              ? { generation: { id: generation.id, status: generation.status, checksum: generation.checksum } } : {}) }
        }
        const requestCertificateMaterial = async (caller: AuthenticatedCaller, username: string, body: Record<string, unknown>) => {
          let response: Response
          try { response = await callAgent('/accounts/' + username + '/certificates', { method: 'POST', caller, body }) }
          catch { return fail('SERVICE_UNAVAILABLE', 'certificate host request requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
          let value: Record<string, unknown> | null
          try { value = asObject(await response.json()) } catch { value = null }
          if (!response.ok) {
            const details = asObject(value?.details)
            // An unreachable CA leaves no certificate material; report it without the raw transport text.
            if (value?.code === 'CONFIG_TEST_FAILED' && typeof value.detail === 'string' && value.detail.startsWith('the certificate authority could not be reached')) return fail('CONFIG_TEST_FAILED', 'the certificate authority could not be reached', { stateChanged: false })
            if (details?.stateChanged === false) return fail('PRECONDITION_FAILED', 'certificate host request was rejected', { stateChanged: false })
            return fail('SERVICE_UNAVAILABLE', 'certificate host request requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          }
          const certificate = asObject(value?.certificate)
          if (!certificate || !isUuid(certificate.id) || !Array.isArray(certificate.names) || !certificate.names.length || certificate.names.length > 100
            || !certificate.names.every(name => typeof name === 'string') || typeof certificate.notAfter !== 'string' || !Number.isFinite(Date.parse(certificate.notAfter))
            || typeof certificate.fingerprintSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(certificate.fingerprintSha256)) return fail('SERVICE_UNAVAILABLE', 'certificate host acknowledgement requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          const paths = services.certFiles(certificate.id)
          if (certificate.certPath !== paths.fullchain || certificate.keyPath !== paths.privkey) return fail('SERVICE_UNAVAILABLE', 'certificate host paths require verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          return { id: certificate.id, names: certificate.names as string[], notAfter: certificate.notAfter,
            notBefore: typeof certificate.notBefore === 'string' ? certificate.notBefore : null,
            certPath: paths.fullchain, keyPath: paths.privkey, fingerprintSha256: certificate.fingerprintSha256 }
        }
        const commitCertificate = async (input: { request: Request; caller: AuthenticatedCaller; account: Account; domain: Domain;
          expectedRevision: number; material: Awaited<ReturnType<typeof requestCertificateMaterial>>; source: 'upload' | 'acme';
          renewalId?: string; administrator: boolean }) => {
          const deferred: Parameters<typeof emitAudit>[0][] = []
          let currentCaller = input.caller
          try {
            let certificate: StoredCertificate
            try {
              const saved: NewCertificate = { ...input.material, accountId: input.account.id, source: input.source,
                challenge: input.source === 'acme' ? 'http-01' : null, autoRenew: input.source === 'acme' }
              certificate = await helpers.store.saveCertificateBinding(saved, input.domain.id, { expectedRevision: input.expectedRevision,
                certificateGuard: async (current, domains) => {
                  const fresh = await freshAccount(input.request, input.caller, input.account.id, deferred, input.administrator)
                  currentCaller = fresh.caller
                  const domain = domains.find(row => row.id === input.domain.id && row.accountId === fresh.account.id && row.name === input.domain.name)
                  if (!domain) return fail('CONFLICT', 'certificate domain changed', { stateChanged: false })
                  if (input.renewalId) validateCertificateRenewalTarget({ certificateId: input.renewalId, certificate: current, accountId: fresh.account.id, domain, domains })
                  else if (current) return fail('CONFLICT', 'fresh certificate identity already exists', { stateChanged: false })
                } })
            } finally { for (const denied of deferred) await emitAudit(denied) }
            const fresh = await freshAccount(input.request, currentCaller, input.account.id, undefined, input.administrator)
            const reconcile = await applyCertificateChange(fresh.caller, input.expectedRevision + 1)
            await emitAudit({ actor: fresh.caller.principal.username, action: input.source === 'upload' ? 'certificate.installed' : input.renewalId ? 'certificate.renewed' : 'certificate.issued',
              target: 'domain:' + input.domain.name, detail: { certificateId: certificate.id, names: certificate.names, notAfter: certificate.notAfter },
              outcome: 'ok', principalId: fresh.caller.principal.id }, { accountId: input.account.id, resellerId: fresh.account.ownerId })
            return { certificate, reconcile }
          } catch {
            return fail('SERVICE_UNAVAILABLE', 'certificate files or configuration require verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
          }
        }
        {
          const router = createCertificateWorkspaceRouter({ store: helpers.store, requireCaller, assertAdministrator, issueAvailable: helpers.hostAvailable, removeAvailable: helpers.hostAvailable,
            assertAccountCaller: async (caller, account, routeMethod) => {
              assertAccountScope(caller, routeMethod !== 'GET')
              await assertCanAccessAccount(caller, account, 'certificates')
              if (routeMethod !== 'GET') await assertCanBindCertificate(caller, account)
            },
            readObservations: async ({ caller, accounts, certificates }) => {
              const inspected: { accountId: string; username: string; state: 'observed' | 'unavailable'; observation?: Record<string, unknown> }[] = []
              const baseline = await helpers.store.getRevision()
              let remaining = 50
              const eligible = accounts.filter(account => certificates.some(certificate => certificate.accountId === account.id && certificate.source === 'acme'))
              for (const account of eligible) {
                if (remaining < 1) break
                const limit = Math.min(remaining, certificates.filter(certificate => certificate.accountId === account.id && certificate.source === 'acme').length)
                remaining -= limit
                try {
                  const response = await callAgent('/accounts/' + account.username + '/certificates?limit=' + limit, { caller })
                  const observation = response.ok ? asObject(await response.json()) : null
                  if (!observation || observation.scope !== 'authorized_saved_certificate_ids' || observation.inventoryComplete !== false || !Array.isArray(observation.rows) || observation.rows.length > limit) throw new Error('invalid_certificate_observation')
                  inspected.push({ accountId: account.id, username: account.username, state: 'observed', observation })
                } catch { inspected.push({ accountId: account.id, username: account.username, state: 'unavailable' }) }
              }
              let managementTls: Record<string, unknown> = { state: caller.principal.kind === 'root' ? 'unavailable' : 'restricted' }
              if (caller.principal.kind === 'root') {
                try { const response = await callAgent('/host/management-tls-observation', { caller }); if (response.ok) managementTls = asObject(await response.json()) ?? managementTls } catch { /* Missing read capability remains unavailable. */ }
              }
              const current = await requireCaller(req)
              if (current.principal.id !== caller.principal.id || current.principal.kind !== caller.principal.kind || await helpers.store.getRevision() !== baseline) return fail('CONFLICT', 'certificate observation scope changed', { stateChanged: false })
              await assertAdministrator(current)
              return { scope: 'authorized_saved_certificate_ids', inventoryComplete: false, totalEligibleAccounts: eligible.length,
                inspectedAccounts: inspected.length, accounts: inspected, managementTls, scheduler: { state: 'unavailable', nextRunAt: null, reason: 'site_scheduler_not_connected' } }
            },
            assertCanReadAccount: (caller, account) => assertCanAccessAccount(caller, account, 'certificates'),
            assertCanWriteAccount: async (caller, account) => { await assertCanAccessAccount(caller, account, 'certificates'); await assertCanBindCertificate(caller, account) },
            removeCertificate: async ({ request, caller, certificate, expectedRevision, scope }) => {
              requireAccountHostAgent()
              const deferred: Parameters<typeof emitAudit>[0][] = []
              let currentCaller = caller
              let changed = false
              try {
                try {
                  const removed = await helpers.store.deleteCertificate(certificate.id, { expectedRevision,
                    certificateGuard: async (current, domains) => {
                      const fresh = await requireCaller(request, { deferDeniedAudit: input => { deferred.push(input) } })
                      if (fresh.principal.id !== caller.principal.id || fresh.principal.kind !== caller.principal.kind) return fail('FORBIDDEN', 'certificate authorization changed', { stateChanged: false })
                      await assertRouteScope(fresh, scope); currentCaller = fresh
                      if (!current || current.accountId !== certificate.accountId || current.fingerprintSha256 !== certificate.fingerprintSha256) return fail('CONFLICT', 'certificate target changed', { stateChanged: false })
                      const affected = new Set(domains.filter(domain => domain.certificateId === current.id).map(domain => domain.accountId))
                      if (current.accountId) affected.add(current.accountId)
                      for (const id of affected) {
                        const account = await helpers.store.getAccount(id)
                        if (!account || (current.accountId !== null && account.id !== current.accountId)) return fail('CONFLICT', 'certificate assignments require review', { stateChanged: false })
                        await assertCanAccessAccount(fresh, account, 'certificates'); await assertCanBindCertificate(fresh, account)
                      }
                    } })
                  if (!removed) return fail('CONFLICT', 'certificate target changed', { stateChanged: false })
                  changed = true
                } finally { for (const denied of deferred) await emitAudit(denied) }
                const fresh = await requireCaller(request)
                if (fresh.principal.id !== currentCaller.principal.id || fresh.principal.kind !== currentCaller.principal.kind) return fail('FORBIDDEN', 'certificate authorization changed')
                await assertRouteScope(fresh, scope)
                const owner = certificate.accountId ? await helpers.store.getAccount(certificate.accountId) : null
                if (scope === 'account' && owner) await assertCanAccessAccount(fresh, owner, 'certificates')
                const reconcile = await applyCertificateChange(fresh, expectedRevision + 1)
                await emitAudit({ actor: fresh.principal.username, action: 'certificate.removed', target: 'certificate:' + certificate.names.join(','),
                  detail: { certificateId: certificate.id, names: certificate.names, revocationPerformed: false }, outcome: 'ok', principalId: fresh.principal.id },
                certificate.accountId ? { accountId: certificate.accountId } : undefined)
                return reconcile
              } catch (error) {
                if (!changed && isXpanelError(error) && error.detail.stateChanged === false) throw error
                return fail('SERVICE_UNAVAILABLE', 'certificate removal requires verification', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
              }
            },
            ...(helpers.hostAvailable ? { installCertificate: createManualCertificateInstall({ store: helpers.store, install: async ({ request, caller, account, domain, body, scope }: { request: Request; caller: AuthenticatedCaller; account: Account; domain: Domain; body: CertificateWorkspaceInstall; scope: CertificateRouteScope }) => {
              const administrator = scope === 'workspace'
              const fresh = await freshAccount(request, caller, account.id, undefined, administrator)
              if (!administrator) assertAccountScope(fresh.caller, true)
              if (await helpers.store.getRevision() !== body.expectedRevision) return fail('CONFLICT', 'certificate workspace changed; reload before retrying', { stateChanged: false })
              const material = await requestCertificateMaterial(fresh.caller, fresh.account.username, { operation: 'install', domain: domain.name,
                expectedRevision: body.expectedRevision, fullchainPem: body.fullchainPem, privateKeyPem: body.privateKeyPem })
              return commitCertificate({ request, caller: fresh.caller, account: fresh.account, domain, expectedRevision: body.expectedRevision, material, source: 'upload', administrator })
            } }) } : {}),
          })
          const routed = await router(req, url, method)
          if (routed) return routed
          if (workspacePath || accountCertificatesMatch![2] || method !== 'POST') return fail('NOT_FOUND', 'certificate workspace operation not found', { stateChanged: false })
        }
        const caller = await requireCaller(req)
        const username = accountCertificatesMatch![1]!
        const account = await helpers.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', 'certificate account not found', { stateChanged: false })
        const body = await readJsonBody(req)
        if (!asObject(body) || Object.keys(body).some(key => !['domain', 'certificateId', 'directoryUrl', 'expectedRevision'].includes(key))) return fail('VALIDATION', 'unsupported certificate request field', { stateChanged: false })
        const fresh = await freshAccount(req, caller, account.id)
        const snapshot = await helpers.store.readSnapshot()
        const sourceRevision = certificateWorkspaceRevision(snapshot.revision)
        const expectedRevision = body.expectedRevision === undefined ? sourceRevision : certificateWorkspaceRevision(body.expectedRevision)
        if (expectedRevision !== sourceRevision) return fail('CONFLICT', 'certificate workspace changed; reload before retrying', { stateChanged: false })
        const domainName = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
        if (!domainName) return fail('VALIDATION', 'a certificate domain is required', { stateChanged: false })
        const domain = snapshot.domains.find(row => row.accountId === fresh.account.id && row.name === domainName)
        if (!domain) return fail('NOT_FOUND', 'certificate domain not found', { stateChanged: false })
        const renewal = Object.hasOwn(body, 'certificateId') ? validateCertificateRenewalTarget({ certificateId: body.certificateId,
          certificate: snapshot.certificates.find(row => row.id === String(body.certificateId).toLowerCase()) ?? null,
          accountId: fresh.account.id, domain, domains: snapshot.domains }) : null
        if (renewal && snapshot.certificates.find(certificate => certificate.id === renewal.certificateId)?.challenge !== 'http-01') return fail('PRECONDITION_FAILED', 'DNS certificate renewal is not connected to this endpoint', { stateChanged: false })
        requireAccountHostAgent()
        const directoryUrl = fresh.caller.principal.kind === 'root' && typeof body.directoryUrl === 'string' && body.directoryUrl.startsWith('http://127.0.0.1:') ? body.directoryUrl : undefined
        const material = await requestCertificateMaterial(fresh.caller, username, { domain: domain.name, expectedRevision,
          ...(renewal ? { certificateId: renewal.certificateId } : {}), ...(directoryUrl ? { directoryUrl } : {}) })
        const expectedNames = renewal?.names ?? [domain.name]
        if ((renewal && material.id !== renewal.certificateId) || JSON.stringify([...material.names].sort()) !== JSON.stringify([...expectedNames].sort())) return fail('SERVICE_UNAVAILABLE', 'certificate host acknowledgement does not match the reviewed names', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
        const result = await commitCertificate({ request: req, caller: fresh.caller, account: fresh.account, domain, expectedRevision,
          material, source: 'acme', ...(renewal ? { renewalId: renewal.certificateId } : {}), administrator: false })
        return jsonResponse({ certificate: projectWorkspaceCertificate(result.certificate, new Map([[fresh.account.id, fresh.account]]), await helpers.store.listDomains({ accountId: fresh.account.id })),
          reconcile: result.reconcile, application: { scope: 'stored_configuration', servedTlsVerified: false } })
      }

    return null
  }
}
