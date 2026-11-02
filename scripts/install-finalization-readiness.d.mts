import type { InstallFinalizationContext, InstallFinalizationObservation } from './install-finalization.mjs'

/** Root/Linux-only observation. Caller owns genuine SH; this function grants no mutation authority. */
export function captureInstallFinalizationReadiness(context: InstallFinalizationContext, subjectDigest: string): Promise<InstallFinalizationObservation>
/** Root/Linux-only reobservation under the caller's EX; no HTTP/DNS or SH acquisition. */
export function assertInstallFinalizationReadinessCurrent(context: InstallFinalizationContext, observation: InstallFinalizationObservation): Promise<void>
/** Retires only private capture-cache metadata; never changes a service, file, session or key. */
export function releaseInstallFinalizationReadiness(observation: InstallFinalizationObservation): void
