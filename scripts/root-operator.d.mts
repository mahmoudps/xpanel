export interface RootOperatorRequest { readonly operationId: string; readonly kind: 'upgrade' | 'recover'; readonly expectedArchiveSha256: string }
export function parseRootOperatorRequest(value: unknown): Readonly<RootOperatorRequest>
export function rootOperatorAttentionLine(kind: string, result: unknown): string
export function currentRootOperatorBinding(): Promise<Readonly<{ purpose: string; operationId: string; requestSha256: string; origin: { file: string; device: string; inode: string; issuerId: string } }> | null>
export function runNativeRootOperatorCommand(value: unknown, dispatch: unknown): Promise<Readonly<{ operationId: string; kind: 'upgrade' | 'recover'; phase: 'succeeded' | 'attention'; resultDigest: string; exitCode: number }>>
