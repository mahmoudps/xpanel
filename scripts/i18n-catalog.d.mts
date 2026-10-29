export const WEB_CATALOG_DIR: string
export const SOURCE_ROOTS: readonly string[]
export interface ScannedCall { id: string; context?: string; line: number }
export function scanSource(src: string): { calls: ScannedCall[]; literals: Set<string> }
export function sourceFiles(root?: string): string[]
export function collectMessages(root?: string): {
  used: Map<string, { id: string; context?: string; files: Set<string> }>
  literals: Set<string>
}
