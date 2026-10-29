import { createHash } from 'node:crypto'

/** Persisted cron fields shared by the API and the independently guarded agent. */
export interface CronWorkspaceJob {
  id: string
  accountId: string
  schedule: string
  command: string
  comment: string
  enabled: boolean
  maxRuntimeSec?: number
}

/** No command, identity, unit name or admission flag is accepted from the request. */
export interface CronJobIntent {
  readonly accountId: string
  readonly jobId: string
  readonly expectedRevision: string
}

export const cronJobFields = (job: CronWorkspaceJob) => ({ id: job.id, accountId: job.accountId, schedule: job.schedule, command: job.command, comment: job.comment, enabled: job.enabled, maxRuntimeSec: job.maxRuntimeSec ?? null })

export const cronWorkspaceRevision = (accountId: string, jobs: readonly CronWorkspaceJob[]): string => createHash('sha256')
  .update(JSON.stringify({ accountId, jobs: [...jobs].sort((left, right) => left.id.localeCompare(right.id)).map(cronJobFields) })).digest('hex')

/** Preserve the established technical unit identity for stored UUIDs. */
export const cronJobUnitId = (storedJobId: string): string => storedJobId.replace(/[^a-z0-9]/gi, '').slice(0, 16) || 'job'

export interface CronExecutionStatus {
  username: string
  jobId: string
  timerUnit: string
  serviceUnit: string
  slice: string
  timerEnabled: boolean
  timerActive: boolean
  serviceRunning: boolean
  lastTriggerAt: string | null
  lastStartedAt: string | null
  nextRunAt: string | null
  durationMs: number | null
  lastExitCode: number | null
  lastResult: string
}

export interface CronJobObservationReceipt {
  context: { accountId: string; jobId: string }
  revision: string
  observation: CronExecutionStatus
}
