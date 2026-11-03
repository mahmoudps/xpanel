/** Pure durable image projections, never native readiness or mutation capabilities. */
export interface CompletedInstallationImages {
  bootstrapBytes: string; receiptBytes: string; dependencyBytes: string; headBytes: string; journalBytes: string; terminalBytes: string
}
export interface NoSourceChangeInstallationImages {
  bootstrapBytes: string; receiptBytes: string; dependencyBytes: string; headBytes: string; admissionBytes: string; terminalBytes: string
}
export function inspectCompletedInstallationTransition(input: unknown): Readonly<{
  bootstrap: import('./install-bootstrap.mjs').PreparedInstallBootstrap;
  receipt: import('./lifecycle-ownership.mjs').InstallationReceipt;
  head: Readonly<Record<string, unknown>>; journal: Readonly<Record<string, unknown>>; terminal: Readonly<Record<string, unknown>>; terminalSha256: string
}>;
export function inspectNoSourceChangeInstallation(input: unknown): Readonly<{
  bootstrap: import('./install-bootstrap.mjs').PreparedInstallBootstrap;
  receipt: import('./lifecycle-ownership.mjs').InstallationReceipt;
  head: Readonly<Record<string, unknown>>;
  admission: Readonly<Record<string, unknown> & { parentHead: { bytes: string } }>;
  terminal: Readonly<Record<string, unknown>>
}>;
export function withActiveInstallationObservation<T>(bootstrapBytes: string, callback: (observation: Readonly<{
  bootstrap: import('./install-bootstrap.mjs').PreparedInstallBootstrap; assertCurrent(): Promise<void>
}>) => Promise<T>): Promise<T>;
