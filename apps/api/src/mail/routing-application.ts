import { fail } from '@xpanel/core'
import { latestActive, listGenerations, type Db } from '@xpanel/db'
import { services } from '@xpanel/render'
import { atomicRemove, atomicWriteJson } from '@xpanel/state'
import type { StateSnapshot, StateStore, WriterLease } from '@xpanel/state'

export type MailRoutingState = 'applied' | 'pending' | 'failed'

export interface MailRoutingRecordState {
  state: MailRoutingState
  reason: string | null
}

/** Where a record takes effect: a domain's Postfix routing, one mailbox script, or every mailbox of an account. */
export type MailRoutingTarget = { domain: string } | { mailbox: string } | { accountId: string }

export interface MailRoutingStatusView {
  /** the active generation compared with current state; null before the first apply */
  generationId: number | null
  /** state of one saved record: its own render issue first, then whether the host runs it */
  record: (kind: services.MailRoutingKind, id: string, target: MailRoutingTarget) => MailRoutingRecordState
}

type RoutingSource = Pick<StateSnapshot, 'domains' | 'serviceUsers' | 'mailRouting'>

const planOf = (snapshot: RoutingSource): services.MailRoutingPlan => services.planMailRouting({
  domains: snapshot.domains,
  mailboxes: snapshot.serviceUsers.filter(user => user.services.email).map(user => ({ login: user.login, accountId: user.accountId, id: user.id })),
}, snapshot.mailRouting)

/** A generation snapshot never changes after it is saved, so its plan is parsed once per active generation. */
const appliedPlans = new WeakMap<StateStore, { id: number; plan: services.MailRoutingPlan | null }>()
const appliedPlan = async (store: StateStore, id: number): Promise<services.MailRoutingPlan | null> => {
  const cached = appliedPlans.get(store)
  if (cached?.id === id) return cached.plan
  const snapshot = await store.readGenerationSnapshot(id)
  const plan = snapshot ? planOf(snapshot) : null
  appliedPlans.set(store, { id, plan })
  return plan
}

const domainShape = (plan: services.MailRoutingPlan, domain: string): string => JSON.stringify(plan.domains.get(domain) ?? null)
const scriptOf = (plan: services.MailRoutingPlan, mailbox: string): string | null => plan.scripts.find(script => script.address === mailbox)?.script ?? null

/**
 * Compares what current state renders with what the active generation rendered, per
 * domain and per mailbox. `failedApply` is the error of an apply this request just ran.
 */
export const readMailRoutingStatus = async (store: StateStore, db: Db, failedApply: string | null = null): Promise<MailRoutingStatusView> => {
  const snapshot = await store.readSnapshot()
  const plan = planOf(snapshot)
  const active = await latestActive(db)
  const applied = active ? await appliedPlan(store, active.id) : null
  const [latest] = await listGenerations(db, { limit: 1 })
  const lastFailure = failedApply
    ?? (latest && latest.status === 'failed' && (!active || latest.id > active.id) ? latest.error ?? 'the last mail configuration apply failed' : null)
  const issues = new Map<string, string>()
  for (const issue of plan.issues) {
    const key = `${issue.kind}\0${issue.id.toLowerCase()}`
    if (!issues.has(key)) issues.set(key, issue.reason)
  }
  const live = (target: MailRoutingTarget): boolean => {
    if (!applied) return false
    if ('domain' in target) return domainShape(applied, target.domain) === domainShape(plan, target.domain)
    const mailboxes = 'mailbox' in target ? [target.mailbox]
      : snapshot.serviceUsers.filter(user => user.accountId === target.accountId && user.services.email).map(user => user.login)
    return mailboxes.every(mailbox => scriptOf(applied, mailbox) === scriptOf(plan, mailbox))
  }
  return {
    generationId: active?.id ?? null,
    record: (kind, id, target) => {
      const reason = issues.get(`${kind}\0${id.toLowerCase()}`)
      if (reason !== undefined) return { state: 'failed', reason }
      const normalized: MailRoutingTarget = 'domain' in target ? { domain: target.domain.toLowerCase() }
        : 'mailbox' in target ? { mailbox: target.mailbox.toLowerCase() } : target
      if (failedApply === null && live(normalized)) return { state: 'applied', reason: null }
      if (lastFailure !== null) return { state: 'failed', reason: lastFailure }
      return { state: 'pending', reason: 'Saved. The host agent has not applied this change yet.' }
    },
  }
}

/** Mail routing writes advance the state revision so the agent renders them, bound to that revision. */
export const commitRoutingRevision = async (lease: WriterLease): Promise<number> => (await lease.commitAuthority({ incrementRevision: true })).revision

export interface MailRoutingApplyPorts {
  store: StateStore
  db: Db
  /** the agent apply; null when no host agent is connected */
  reconcile: () => Promise<{ body: Record<string, unknown> } | null>
  audit: (reason: string) => Promise<unknown>
}

/**
 * Applies committed mail routing on the host and reads back what the host runs. A failed
 * configuration test restores the previous saved file (absolute path; null removes it), so
 * the server keeps its last working mail configuration, and refuses the change.
 */
export const applyMailRoutingChange = async (ports: MailRoutingApplyPorts, revision: number, restore: { path: string; previous: unknown }): Promise<MailRoutingStatusView & { revision: number }> => {
  let reconcile: { body: Record<string, unknown> } | null = null
  try { reconcile = await ports.reconcile() }
  catch { return { ...await readMailRoutingStatus(ports.store, ports.db), revision } }
  if (reconcile?.body.status !== 'failed') return { ...await readMailRoutingStatus(ports.store, ports.db), revision }
  const reason = String(reconcile.body.error ?? reconcile.body.failedTest ?? 'mail configuration test failed').slice(0, 500)
  try {
    const lease = await ports.store.getWriterLock().acquire()
    try {
      await lease.assertFencingToken()
      if (restore.previous === null) await atomicRemove(restore.path, () => lease.assertFencingToken())
      else await atomicWriteJson(restore.path, restore.previous, 0o640, () => lease.assertFencingToken())
      await commitRoutingRevision(lease)
    } finally { await lease.release() }
    await ports.reconcile()
  } catch {
    return fail('SERVICE_UNAVAILABLE', 'the mail configuration test failed and restoring the previous configuration requires verification', { stateChanged: true, verificationRequired: true, reason })
  }
  await ports.audit(reason)
  return fail('CONFIG_TEST_FAILED', 'the mail configuration test failed; the change was not applied and the previous configuration was restored', { stateChanged: false, rolledBack: true, reason })
}
