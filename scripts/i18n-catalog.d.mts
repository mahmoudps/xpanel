export const WEB_CATALOG_DIR: string
export const SOURCE_ROOTS: readonly string[]
export interface ScannedCall { id: string; context?: string; line: number }
export function scanSource(src: string): { calls: ScannedCall[]; literals: Set<string> }
export function sourceFiles(root?: string): string[]
export function collectMessages(root?: string): {
  used: Map<string, { id: string; context?: string; files: Set<string> }>
  literals: Set<string>
}

export interface JavaScriptSourceToken {
  type: 'str' | 'tpl' | 'regex' | 'ident' | 'num' | 'punct'
  start: number
  end: number
  text: string
  exprs?: readonly { start: number; end: number; tokens: JavaScriptSourceToken[] }[]
}
export function lexJavaScriptSource(source: string, start?: number, end?: number, interpolation?: boolean): { tokens: JavaScriptSourceToken[]; end: number }
export function sourceLiteral(token?: JavaScriptSourceToken): string | undefined
export function cookedJavaScriptTemplate(source: string, token: JavaScriptSourceToken): string
export function splitMessageCalls(file: string, calls: readonly ScannedCall[]): { core: ScannedCall[]; theme: ScannedCall[]; themeId?: string }
export function collectThemeMessages(themeId: string, root?: string): ReturnType<typeof collectMessages>
export function themeCatalogDirectories(root?: string): { id: string; directory: string }[]
