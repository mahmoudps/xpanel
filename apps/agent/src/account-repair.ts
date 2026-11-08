import { fail, isXpanelError, msgid } from '@xpanel/core'
import type { HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'
import { accountOwnerCheckArgv, accountOwnerRepairArgv, isAccountRepairCommand } from '../../../packages/os/src/account-repair-command.ts'
import type { AccountRepairIdentity } from '../../../packages/os/src/account-repair-command.ts'

export const ACCOUNT_REPAIR_JOB_KIND = 'accounts.repair.ownership'
/** validateHostJobPlan admits 1..32 steps. */
export const ACCOUNT_REPAIR_MAX = 32
const STEP_TIMEOUT_MS = 1_800_000
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export interface AccountRepairPreview { username: string; ownership: 'ok' | 'problem' | 'unavailable'; sample: string | null }
export function buildAccountRepairPlan(accounts: readonly AccountRepairIdentity[]): HostJobPlan {
  return { kind: ACCOUNT_REPAIR_JOB_KIND, summary: `Restore file ownership for ${accounts.length} accounts`, accountId: null, fingerprint: { accounts: accounts.map(account => account.username) }, detail: { accounts: accounts.map(account => account.username) },
    steps: accounts.map((account, index) => ({ id: `owner-${index + 1}`, title: msgid('Restore file ownership for {account}'), titleValues: { account: account.username }, argv: accountOwnerRepairArgv(account), timeoutMs: STEP_TIMEOUT_MS, mutates: true })),
    policy: isAccountRepairCommand,
    verify: async (run: HostJobRun) => {
      const results: { account: string; ok: boolean }[] = []
      for (const account of accounts) { const result = await run(accountOwnerCheckArgv(account), { timeoutMs: 600_000 }).catch(() => null); results.push({ account: account.username, ok: !!result && !result.timedOut && result.ok && result.stdout.trim() === '' }) }
      return { ok: results.every(item => item.ok), detail: { checked: results.length, results } }
    } }
}

export interface AccountRepairRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  readSnapshot: () => Promise<{ accounts: readonly (AccountRepairIdentity & { status: string })[] }>
  /** Null off a native host: nothing is reported as healthy or repaired. */
  run: ((argv: string[]) => Promise<{ ok: boolean; stdout: string }>) | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
}

/** POST /host/accounts/repair/preview and /run, root only; identities always come from saved state. */
export async function handleAccountRepairRoute(req: Request, url: URL, method: string, ctx: AccountRepairRouteContext): Promise<Response | null> {
  const preview = url.pathname === '/host/accounts/repair/preview'
  if (!preview && url.pathname !== '/host/accounts/repair/run') return null
  const { actor } = await ctx.assertRoot('accounts.repair')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'account repair accepts no selectors', unchanged)
  const text = await req.text()
  if (text.length > 4096) return fail('VALIDATION', 'account repair request exceeds its bound', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  const names = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).join() === 'accounts' ? (body as { accounts: unknown }).accounts : undefined
  if (!Array.isArray(names) || names.length < 1 || names.length > ACCOUNT_REPAIR_MAX || new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !USERNAME.test(name))) return fail('VALIDATION', `choose 1 to ${ACCOUNT_REPAIR_MAX} accounts`, unchanged)
  const saved = (await ctx.readSnapshot()).accounts.filter(account => account.status !== 'terminating')
  const chosen = (names as string[]).map(name => saved.find(account => account.username === name) ?? fail('NOT_FOUND', 'account not found', unchanged)).map(({ username, uid, gid, home }) => ({ username, uid, gid, home }))
  if (preview) {
    if (!ctx.run) return fail('PRECONDITION_FAILED', 'account files cannot be read on this host', unchanged)
    const accounts: AccountRepairPreview[] = []
    for (const account of chosen) {
      const result = await ctx.run(accountOwnerCheckArgv(account)).catch(() => null), sample = result?.stdout.split('\n')[0]?.trim() || null
      accounts.push({ username: account.username, ownership: !result?.ok ? 'unavailable' : sample ? 'problem' : 'ok', sample })
    }
    return json({ accounts })
  }
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  const plan = buildAccountRepairPlan(chosen)
  if ((await ctx.assertRoot('accounts.repair')).actor !== actor) return fail('FORBIDDEN', 'account repair authority changed', unchanged)
  try { const job = await ctx.submitJob(plan, actor); return json({ accounts: chosen.length, job: { id: job.id, kind: job.kind, status: job.status } }, 202) }
  catch (error) { if (isXpanelError(error) && error.detail.stateChanged === false) throw error; return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
}
