export type RetentionItem = { kind: 'release' | 'prepared' | 'staging'; name: string; version: string | null }
export type RetentionResult = { trigger: 'operator' | 'upgrade'; dryRun: boolean; current: string; kept: { kind: 'release' | 'staging'; name: string; reasons: string[] }[]; remove: RetentionItem[]; removed: RetentionItem[]; resumed: RetentionItem[] }
export function retentionEntrySafe(info: { dev: bigint; uid: bigint; mode: bigint; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }, device: bigint, uid: number): boolean
export function planReleaseRetention(facts: Record<string, unknown>): { current: string; kept: RetentionResult['kept']; remove: (RetentionItem & { path: string })[] }
export function observeReleaseRetention(host: object): Promise<Record<string, unknown>>
export function pruneReleases(host: object, options?: { dryRun?: boolean; trigger?: 'operator' | 'upgrade' }): Promise<RetentionResult>
export function nativeRetentionHost(): object
export function stableRetentionCode(error: unknown): string
export function runReleaseRetentionCommand(options: { dryRun: boolean }, host?: object): Promise<{ exitCode: number; code: string; outcome: string; details?: RetentionResult }>
export function formatReleaseRetention(result: { code: string; details: RetentionResult }): string
/** After a settled successful native upgrade only; a refusal is journaled and never changes the upgrade outcome. */
export function pruneReleasesAfterUpgrade(): Promise<void>
