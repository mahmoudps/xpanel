import { fail, isUuid, type Account, type Domain } from '@xpanel/core'
import { getDurableJob, type Db, type DurableJobRecord } from '@xpanel/db'
import { parseProvisioningCheckpointObservation } from '../../../packages/core/src/account-provisioning-contract.ts'
import type { AuthenticatedCaller } from './auth.ts'

const ROUTE = /^\/api\/accounts\/operations\/([^/]+)$/
const unchanged = { stateChanged: false } as const

/** The answer POST /api/accounts gives once the operation ends: its 201 body, or its problem document. */
export type AccountCreateOutcome = { readonly result: unknown } | { readonly problem: unknown }

/**
 * Public view of one account creation. POST /api/accounts answers 202 with it once the host step starts, and
 * GET /api/accounts/operations/:id returns it until `operation.status` is final. `local` is this process's own record of
 * the request: null while it runs, then the answer the POST would have given. Without one (the API restarted since),
 * the job alone answers, with its recorded native observation. Agent diagnostics stay out.
 */
export function accountCreateOperationView(job: DurableJobRecord, account: Account | null, primaryDomain: Domain | null, local: AccountCreateOutcome | null | undefined) {
  const operation = (status: string, needsAttention: boolean) => ({ id: job.id, reference: job.referenceCode, status, needsAttention })
  if (local === null) return { operation: operation('running', job.needsAttention), account, primaryDomain }
  if (local !== undefined) return { operation: operation('result' in local ? 'succeeded' : 'failed', job.needsAttention), ...local }
  const lapsed = job.status === 'running' && !(Date.parse(job.leaseExpiresAt ?? '') > Date.now())
  let execution = null
  if (job.status === 'succeeded') {
    try {
      const observation = parseProvisioningCheckpointObservation(job.checkpointData.observedContext).execution
      if (account && observation.accountId === account.id) execution = { status: 'account_verified', scope: 'account', targetVerified: true, verificationRequired: false, observation }
    } catch { /* No recorded native observation: the client reports the creation as unverified. */ }
  }
  return { operation: operation(lapsed ? 'interrupted' : job.status, job.needsAttention || lapsed), account, primaryDomain, execution }
}

/** Root reads any account creation; a reseller only the ones it started. Any other job answers as absent. */
export async function handleAccountCreateOperationRoute(request: Request, url: URL, method: string, ports: {
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  db: Db
  getAccount(id: string): Promise<Account | null>
  primaryDomain(accountId: string): Promise<Domain | null>
  local(jobId: string): AccountCreateOutcome | null | undefined
}): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const caller = await ports.requireCaller(request)
  const { kind, username } = caller.principal
  if (kind !== 'root' && kind !== 'reseller') return fail('FORBIDDEN', 'a hosting administrator is required', unchanged)
  if (url.search || !isUuid(match[1])) return fail('VALIDATION', 'an account operation id is required', unchanged)
  const job = await getDurableJob(ports.db, match[1]!)
  if (!job || job.kind !== 'account.provision' || kind === 'reseller' && job.actor !== `reseller:${username}`) return fail('NOT_FOUND', 'account operation not found', unchanged)
  // A settled answer carries its own account; state is read only for a running or restarted operation.
  const local = ports.local(job.id), accountId = job.checkpointData.accountId
  const account = local || typeof accountId !== 'string' ? null : await ports.getAccount(accountId)
  const primaryDomain = account ? await ports.primaryDomain(account.id) : null
  return new Response(JSON.stringify(accountCreateOperationView(job, account, primaryDomain, local)), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
