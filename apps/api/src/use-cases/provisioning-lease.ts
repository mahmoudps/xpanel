import { fail } from '@xpanel/core'
import type { DurableJobRecord } from '@xpanel/db'

/** One renewal at a time; lease loss poisons the operation and aborts its transport. */
export class ProvisioningLease {
  readonly abort = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> = Promise.resolve()
  private failure: unknown
  private stopped = false
  private currentLease: DurableJobRecord
  private readonly renew: () => Promise<DurableJobRecord>
  private readonly intervalMs: number
  constructor(initial: DurableJobRecord, renew: () => Promise<DurableJobRecord>, intervalMs = 20_000) {
    this.renew = renew
    this.intervalMs = intervalMs
    this.currentLease = initial
    this.schedule()
  }
  get current(): DurableJobRecord { return this.currentLease }
  private schedule(): void {
    if (this.stopped || this.failure) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.assert().catch(() => undefined).finally(() => this.schedule())
    }, this.intervalMs)
    this.timer.unref?.()
  }
  async assert(): Promise<void> {
    if (this.failure) throw this.failure
    this.pending = this.pending.then(async () => {
      if (this.failure) throw this.failure
      const next = await this.renew()
      if (next.id !== this.currentLease.id || next.leaseOwner !== this.currentLease.leaseOwner
        || next.fencingToken !== this.currentLease.fencingToken || next.status !== 'running'
        || next.cancelRequested || next.needsAttention || !next.leaseExpiresAt
        || Date.parse(next.leaseExpiresAt) <= Date.now()) {
        fail('CONFLICT', 'account provisioning lease authority was lost', { verificationRequired: true })
      }
      this.currentLease = next
    }).catch(error => { this.failure = error; this.abort.abort(); throw error })
    return this.pending
  }
  /** Settle heartbeat before job completion; an explicit final assertion may still renew once. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.pending
    if (this.failure) throw this.failure
  }
  get lost(): boolean { return this.failure !== undefined }
}
