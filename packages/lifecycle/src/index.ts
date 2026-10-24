// Long-running product flows as testable state machines and planners. Side effects happen
// only through the injected ports (upgrade) or the returned steps (backup, restore, transfer),
// which apps/agent executes.

export type { AuditPort, ClockPort, ExecResult, FsPort, HostPort } from './ports.ts'
export { lifecycleTools } from './tools.ts'
export type { LifecycleTools } from './tools.ts'
export { assertExecSteps, stepPaths } from './steps.ts'
export type {
  DesiredStateStep,
  ExecIoStep,
  LifecycleStep,
  ManifestSource,
  ManifestStep,
  ReconcileStep,
  RemoteUploadStep,
  VerifyArchiveStep,
  WriteFileStep,
} from './steps.ts'
export type { ByteSource, Body } from './archive/reader.ts'
export type { FileRef, ImportSink, SinkItem, SinkPart } from './archive/sink.ts'
export type { EntryType, GuardOptions } from './archive/guard.ts'

// upgrade: side-by-side release switch with snapshot, health gate and rollback
export { compareSemver, parseSemver, assertSemver } from './upgrade/semver.ts'
export type { SemVer } from './upgrade/semver.ts'
export { preflight } from './upgrade/preflight.ts'
export type { PreflightCheck, PreflightCheckId, PreflightInput, PreflightReport } from './upgrade/preflight.ts'
export { assertHotPathMigrations } from './upgrade/migrations.ts'
export type { PendingMigration } from './upgrade/migrations.ts'
export { DEFAULT_LAYOUT, DEFAULT_PANEL_UNITS, UPGRADE_UNIT, isCustomerDataPath, normalizeUpgradePlan, readLock, recoverUpgrade, runUpgrade } from './upgrade/machine.ts'
export type {
  LockInfo,
  LockState,
  RecoverInput,
  RecoverResult,
  ReleaseInfo,
  UpgradeLayout,
  UpgradeOutcome,
  UpgradeHostOutcome,
  UpgradePlan,
  UpgradeResult,
  UpgradeStepLog,
} from './upgrade/machine.ts'
export type {
  AccountIdentity,
  GenerationId,
  HealthPort,
  MigratorPort,
  ReconcilerPort,
  SystemProbePort,
  TransferProbePort,
  UnitChange,
  UpgradeHistoryPort,
  UpgradePhase,
  UpgradePorts,
  UpgradeRow,
  UpgradeStatus,
  UpgradeSafetyPort,
} from './upgrade/ports.ts'

// backup and restore (the account backup wizard)
export { ALL_PARTS, BACKUP_FORMAT, BACKUP_VERSION, buildManifest, expandParts, parseManifest } from './backup/manifest.ts'
export type { BackupManifest, BackupPart, BackupScope, ManifestFile, ManifestHeader } from './backup/manifest.ts'
export { BACKUP_DESTINATIONS, DEFAULT_BACKUP_ROOTS, computeManifest, createBackupPlan, validateBackupAccount } from './backup/plan.ts'
export type { BackupAccount, BackupDestination, BackupPlan, BackupRequest, BackupRoots } from './backup/plan.ts'
export { MAX_ARGV_PATHS, diffArchive, inspectBackupArchive, restorePlan } from './backup/restore.ts'
export type { ArchiveDiff, InspectResult, ListingEntry, RestorePlan, RestoreRequest } from './backup/restore.ts'
export { mailConfigFor, mergeMailConfig, parseMailConfig } from './backup/mail-config.ts'
export type { DomainMail, MailConfig, MailMergeResult, MailboxFilters } from './backup/mail-config.ts'

// xPanel -> xPanel transfer
export {
  assertNoSecrets,
  buildReview,
  countActiveTransfers,
  createTransferSession,
  detectConflicts,
  isActiveTransfer,
  isPlanName,
  itemPercent,
  itemStatus,
  parseTransferAuth,
  reviewDigest,
  targetUsername,
  transferStatus,
  transition,
} from './transfer/session.ts'
export type {
  AccountPhase,
  AccountProgress,
  Conflict,
  ConflictKind,
  LocalInventory,
  Resolution,
  ResolutionAction,
  ReviewAccount,
  SessionState,
  SourceAccount,
  SourcePlan,
  TransferAuth,
  TransferEvent,
  TransferItemStatus,
  TransferReview,
  TransferSession,
  TransferStatus,
} from './transfer/session.ts'
export { assertNoSharedRestart, buildApplyPlan, sharedUnits, transferReloadUnits } from './transfer/apply.ts'
export type { ApplyPlanOptions, CreatePlanStep, ImportArchiveStep, TransferFetchStep, TransferStep } from './transfer/apply.ts'
export { allocateUid, exportAccountArchive, importAccountArchive } from './transfer/archive.ts'
export type { AccountExportSource, AccountImportOptions, ChecksumEntry, ExportEntry, ExportSummary, ImportedAccount, ImportedDbUser } from './transfer/archive.ts'
export { parseAccountManifest } from './transfer/manifest.ts'
export type { AccountArchiveManifest, ArchiveDbUser, ArchiveDomain } from './transfer/manifest.ts'

// cPanel account backup import (public cpmove layout)
export { readCpanelArchive } from './cpanel-import/import.ts'
export type { CpanelImportOptions } from './cpanel-import/import.ts'
export type {
  ImportAccount,
  ImportCertificate,
  ImportDatabase,
  ImportDbUser,
  ImportDomain,
  ImportMailbox,
  ImportPlan,
  ImportWarning,
  ImportZone,
} from './cpanel-import/types.ts'
