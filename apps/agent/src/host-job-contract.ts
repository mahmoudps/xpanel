/**
 * Reviewed host job plans. A plan is data: the runner admits a step only when its
 * exact argv passes the finite grammar supplied with the plan, both at submission
 * and again immediately before execution. No shell, no caller-selected binary.
 */
export type HostJobTitleValues = Readonly<Record<string, string>>

export type HostJobEnvName = 'DEBIAN_FRONTEND' | 'NEEDRESTART_MODE' | 'APT_LISTCHANGES_FRONTEND' | 'LC_ALL'

export interface HostJobCommandStep {
  /** /^[a-z][a-z0-9-]{0,63}$/, unique inside the plan */
  id: string
  /** English source message (ICU MessageFormat, 1..160 characters); the web UI translates it. */
  title: string
  /** Values for the title's `{placeholders}`, each at most 160 characters. */
  titleValues?: HostJobTitleValues
  argv: readonly string[]
  env?: Readonly<Partial<Record<HostJobEnvName, string>>>
  /** 1..3_600_000 */
  timeoutMs: number
  /** A failed, interrupted or timed-out mutating step is an unknown outcome, never a clean failure. */
  mutates: boolean
  /** Documented non-zero exits that still mean the step completed, e.g. clamscan(1) 1 = infected files found. */
  successExitCodes?: readonly number[]
}

export interface HostJobCommandResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type HostJobRun = (argv: readonly string[], options?: { env?: HostJobCommandStep['env']; timeoutMs?: number }) => Promise<HostJobCommandResult>
export type HostJobCommandPolicy = (argv: readonly string[]) => boolean

export interface HostJobVerification { ok: boolean; detail: Record<string, unknown> }

/** Commands supplied to finalization have the same bounded shape and policy as normal steps. */
export type HostJobStepRun = (step: HostJobCommandStep) => Promise<HostJobCommandResult>
export interface HostJobStepResult {
  readonly id: string
  /** Null means execution threw. Captured stdout/stderr are each limited to 64 KiB. */
  readonly result: Readonly<HostJobCommandResult> | null
}

export interface HostJobPlan {
  /** /^[a-z][a-z0-9_.:-]{0,127}$/, for example system.packages.upgrade */
  kind: string
  /** <= 512 characters */
  summary: string
  accountId: string | null
  /** Reviewed selection plus the observed plan revision it was built from. */
  fingerprint: Record<string, unknown>
  detail: Record<string, unknown>
  /** 1..32 steps */
  steps: readonly HostJobCommandStep[]
  policy: HostJobCommandPolicy
  /** Re-checks fresh authority after queueing and immediately before each normal step. */
  beforeStep?: (step: HostJobCommandStep) => Promise<void>
  /** Re-observes the host after the last step. The job succeeds only when this returns ok. */
  verify?: (run: HostJobRun) => Promise<HostJobVerification>
  /**
   * Runs once before settling an active plan, including failure, cancellation and graceful close.
   * Only attempted normal steps are included, in order, at most 32. Cleanup may run after authority
   * revocation but must pass policy and current lease fencing. A failed finalizer is unknown_outcome;
   * success never overrides an earlier failure. Unstarted or lost plans cannot invoke this callback.
   */
  finalize?: (run: HostJobStepRun, results: readonly HostJobStepResult[]) => Promise<HostJobVerification>
}

export type HostJobStepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'unknown'

export interface HostJobView {
  id: string
  /** Official persisted number; null means no reference has been issued. Internal id is routing only. */
  referenceCode: string | null
  kind: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  summary: string
  accountId: string | null
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  steps: { id: string; title: string; titleValues?: HostJobTitleValues; state: HostJobStepState; exitCode: number | null }[]
  error: string | null
  failureClass: 'retryable' | 'permanent' | 'unknown_outcome' | null
  cancelRequested: boolean
  verification: HostJobVerification | null
  logBytes: number
}
