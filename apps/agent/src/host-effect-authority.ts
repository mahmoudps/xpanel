import { AsyncLocalStorage } from 'node:async_hooks'
import { fail, isXpanelError } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'

/** Trusted operation context, never constructed from an agent request body. */
export interface HostEffectAuthority {
  readonly signal: AbortSignal
  readonly readOnly?: boolean
  assertAuthority(): Promise<void>
}

interface AdmittedAuthority {
  readonly executor: AgentExecutor
  readonly authority: HostEffectAuthority
  changed: boolean
  retired: boolean
  readonly pending: Set<Promise<unknown>>
  failure?: unknown
}

const admitted = new AsyncLocalStorage<AdmittedAuthority>()

/**
 * A context applies only to this executor and this awaited async invocation.
 * Normal daemon work and other executor instances retain their own authority.
 */
export async function withHostEffectAuthority<T>(
  executor: AgentExecutor,
  authority: HostEffectAuthority,
  work: () => Promise<T>,
): Promise<T> {
  const existing = admitted.getStore()
  if (existing) return fail('PRECONDITION_FAILED', 'nested host effect authority is not permitted', { stateChanged: existing.changed, verificationRequired: true })
  const current: AdmittedAuthority = { executor, authority, changed: false, retired: false, pending: new Set() }
  return admitted.run(current, async () => {
    try {
      await assertHostEffectAuthority(executor)
      const result = await work()
      // Await any primitive a caller started before returning; late callbacks are
      // refused once this context retires. No detached operation retains a lease.
      while (current.pending.size) {
        const results = await Promise.allSettled([...current.pending])
        const failed = results.find(item => item.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      // The finished operation is acknowledged only under authority that still holds.
      await verifyAuthority(current)
      return result
    } finally {
      while (current.pending.size) await Promise.allSettled([...current.pending])
      current.retired = true
    }
  })
}

/**
 * Restores captured host state after an admitted change failed. Restoration must not
 * depend on the caller's authority: once that authority lapses, a half-applied host is worse.
 */
export function withoutHostEffectAuthority<T>(work: () => Promise<T>): Promise<T> {
  return admitted.exit(work)
}

/** Call under the existing generation/writer admission and immediately before an effect. */
export async function assertHostEffectAuthority(executor: AgentExecutor): Promise<void> {
  const current = admitted.getStore()
  if (!current || current.executor !== executor) return
  if (current.failure !== undefined) throw current.failure
  // Once a primitive started, the admitted operation runs to its end: its desired state is already saved, and a
  // stop half way (a signed-out session, a dropped request, a terminated account) left the host for an operator.
  if (current.changed && !current.retired) return
  await verifyAuthority(current)
}

async function verifyAuthority(current: AdmittedAuthority): Promise<void> {
  if (current.failure !== undefined) throw current.failure
  try {
    if (current.retired || current.authority.signal.aborted) return fail('PRECONDITION_FAILED', 'account provisioning was cancelled or retired', { stateChanged: current.changed, ...(current.changed ? { verificationRequired: true } : {}) })
    await current.authority.assertAuthority()
    if (current.retired || current.authority.signal.aborted) return fail('PRECONDITION_FAILED', 'account provisioning was cancelled or retired', { stateChanged: current.changed, ...(current.changed ? { verificationRequired: true } : {}) })
  } catch (error) {
    // The public failure is generic; operators still need the actual lapsed check in the journal.
    console.error('xpanel-agent host operation authority lapsed:', isXpanelError(error) ? `${error.code}: ${error.message}` : 'unexpected authority error')
    try {
      return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'host operation authority is no longer current', {
        stateChanged: current.changed,
        ...(current.changed ? { verificationRequired: true } : {}),
      })
    } catch (closed) {
      current.failure = closed
      throw closed
    }
  }
}

/** The first primitive is admitted by a full check; a loss afterwards is refused when the operation acknowledges. */
export function authorizedHostEffect<T>(executor: AgentExecutor, work: () => Promise<T>): Promise<T> {
  const current = admitted.getStore()
  if (!current || current.executor !== executor) return work()
  const effect = (async () => {
    await assertHostEffectAuthority(executor)
    if (current.authority.readOnly) return fail('PRECONDITION_FAILED', 'native account observation does not permit host mutations', { stateChanged: current.changed, ...(current.changed ? { verificationRequired: true } : {}) })
    current.changed = true
    const result = await work()
    await assertHostEffectAuthority(executor)
    return result
  })()
  const tracked: Promise<T> = effect.finally(() => { current.pending.delete(tracked) })
  current.pending.add(tracked)
  return tracked
}

/** Refusal reason of an admitted operation stopped before any host primitive started: nothing to verify, retryable. */
export const HOST_EFFECT_NOT_STARTED = 'host_effect_not_started'

/** Whether an admitted host primitive started in this executor's context; null outside an admitted context. */
export const hostEffectsStarted = (executor: AgentExecutor): boolean | null => {
  const current = admitted.getStore()
  return current?.executor === executor ? current.changed : null
}

/** Operator recovery must acquire its own admission, outside an expired request context. */
export const hasHostEffectAuthority = (executor: AgentExecutor): boolean => admitted.getStore()?.executor === executor
