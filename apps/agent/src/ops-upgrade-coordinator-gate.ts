// Process-local serialization only. Native scopes and durable journals remain the authority.
export {}
let active: symbol | undefined
let attention = false
export const coordinatorRequestActive = (): boolean => active !== undefined
export function claimCoordinatorRequest(purpose: 'ordinary'|'recovery' = 'ordinary') {
  if (active || attention && purpose !== 'recovery') throw new Error('COORDINATOR_BUSY_OR_ATTENTION')
  const token = Symbol('coordinator request'); active = token
  let retained = false
  const release = () => { if (!retained && active === token) active = undefined }
  return {
    release,
    attention() { attention = true },
    recovered() { if (purpose !== 'recovery' || active !== token) throw new Error('COORDINATOR_RECOVERY_NOT_HELD'); attention = false },
    retainUntil(pending: Promise<unknown>) {
      if (retained || active !== token) throw new Error('COORDINATOR_REQUEST_RETIRED')
      retained = true
      // Publish rejection attention in the same reaction before releasing the
      // slot. A sibling promise reaction must never observe ordinary readiness.
      void pending.then(
        () => { retained = false; release() },
        () => { attention = true; retained = false; release() },
      )
    },
  }
}
