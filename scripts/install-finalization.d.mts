import type { FsPort, ClockPort } from '@xpanel/lifecycle'

export const INSTALL_FINALIZATION_PATHS: Readonly<{bootstrap: string; receipt: string; head: string}>
export interface InstallFinalizationContext {
  readonly source: Readonly<{root: '/opt/xpanel'; version: string; archiveSha256: string; manifestSha256: string; dependencyReceiptSha256: string; controlDbSchemaVersion: number}>
  readonly runtime: Readonly<{nodePath: string; nodeVersion: '26.12.1'; nodeSha256: string; systemctlSha256: string; nginxSha256: string}>
  readonly database: Readonly<{file: '/var/lib/xpanel/control.db'; device: string; inode: string; issuerId: string}>
  readonly rootPrincipalId: string
  readonly state: Readonly<{revision: number; checksum: string; accountCount: 0}>
  readonly admissionFingerprint: string
}
export interface InstallFinalizationIntent {
  readonly schemaVersion: 1
  readonly jobId: string
  readonly reference: string
  readonly subjectDigest: string
  readonly previousReceiptSha256: string
  readonly expectedActiveSha256: string
  readonly phase: 'intent' | 'verified' | 'receipt_published' | 'complete'
  readonly observationDigest: string | null
  readonly createdAt: string
}
export interface InstallFinalizationObservation {
  readonly subjectDigest: string
  readonly observedAt: string
  readonly expiresAt: string
  readonly mode: 'normal'
  readonly processes: readonly Readonly<{role: 'api'|'agent'; pid:number; start:string; uid:number; executable:string; cwd:string; cgroup:string; invocationId:string; socketDevice:string; socketInode:string}>[]
  readonly ingress: Readonly<{configSha256:string; certificateSha256:string; audiences:readonly string[]}>
}
/** Internal composition only. Structural types and isolated port tests are not native authority. */
export interface InstallFinalizationPorts {
  readonly fs: Pick<FsPort, 'readFile'|'writeFileExclusive'|'rename'>
  readonly clock: Pick<ClockPort, 'now'>
  syncPath(path: string): Promise<void>
  withSharedAdmission<T>(callback:()=>Promise<T>):Promise<T>
  /** Owns the real EX admission/host exclusion and awaits FD/child retirement before return. */
  withExclusiveAdmission<T>(callback:()=>Promise<T>):Promise<T>
  /** I/O data is unknown until the protocol revalidates its exact current schema. */
  capturePrepared():Promise<unknown>
  /** Completes actual HTTP observations before any EX acquisition. */
  observeReady(context:InstallFinalizationContext,subjectDigest:string):Promise<unknown>
  /** Reobserves root/source/receipt/origin/process/lease after queue and at each actual native effect. */
  assertCurrent(context:InstallFinalizationContext,observation:InstallFinalizationObservation,intent:InstallFinalizationIntent|null):Promise<void>
  readonly jobs: {
    /** Existing durable enqueue/dedupe plus genuine root intent authority; reply loss is unknown. */
    begin(input:Readonly<{kind:'lifecycle.adopt';requestFingerprint:string;rootPrincipalId:string}>):Promise<Readonly<{id:string;referenceCode:string;createdAt:string}>>
    /** Idempotent exact job/checkpoint acknowledgement after receipt readback; never a synthetic reference. */
    complete(intent:InstallFinalizationIntent,proof:Readonly<{receiptSha256:string;observationDigest:string|null}>):Promise<void>
    assertComplete(intent:InstallFinalizationIntent,subjectDigest:string):Promise<void>
  }
}
export function runPreparedInstallFinalization(ports:InstallFinalizationPorts):Promise<Readonly<{exitCode:0|3|6;code:string;outcome:'committed'|'blocked'|'attention';details:Readonly<Record<string,unknown>>}>>
export function inspectInstallFinalizationRecovery(value:Readonly<{bootstrapBytes:string;receiptBytes:string;headBytes:string}>):Readonly<{bootstrap:Readonly<Record<string,unknown>>;receipt:Readonly<Record<string,unknown>>;head:Readonly<Record<string,unknown>>;intent:InstallFinalizationIntent}>
export function installFinalizationSubjectDigest(context:InstallFinalizationContext,previousReceiptSha256:string):string
