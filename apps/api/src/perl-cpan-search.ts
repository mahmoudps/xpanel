import { fail } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'

/**
 * CPAN keyword search for the Perl Modules tool, through MetaCPAN's public search API. It reads only, and what it
 * finds installs through the exact-name route: nothing from the answer reaches a command. The answer is untrusted,
 * so it is size-bounded and every field is checked.
 */
export const CPAN_SEARCH_PATH = '/api/account/perl-modules/search'
const SEARCH_URL = 'https://fastapi.metacpan.org/v1/search/web'
const QUERY = /^[A-Za-z0-9_:. +-]{2,100}$/
const MODULE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:::[A-Za-z_][A-Za-z0-9_]{0,63}){0,8}$/
const VERSION = /^v?[0-9][0-9._]{0,31}$/
const MAX_RESULTS = 20, MAX_RESPONSE_BYTES = 2 * 1024 * 1024, TIMEOUT_MS = 8000
const unavailable = (): never => fail('SERVICE_UNAVAILABLE', 'CPAN search is unavailable right now', { stateChanged: false, reason: 'cpan_search_unavailable' })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export interface CpanModule { name: string; version: string | null; description: string }

/** One row per distribution, its documented module first; a hit without a usable module name is left out. */
export const readCpanResults = (raw: unknown): CpanModule[] | null => {
  if (!object(raw) || !Array.isArray(raw.results)) return null
  const found: CpanModule[] = []
  for (const result of raw.results.slice(0, MAX_RESULTS)) {
    if (!object(result) || !Array.isArray(result.hits)) return null
    const hit = result.hits.find((item: unknown): item is Record<string, unknown> => object(item) && typeof item.documentation === 'string' && MODULE.test(item.documentation))
    if (!hit) continue
    const modules: unknown[] = Array.isArray(hit.module) ? hit.module : []
    const version = modules.flatMap(item => object(item) && item.name === hit.documentation ? [item.version] : [])[0]
    found.push({ name: hit.documentation as string, version: typeof version === 'string' && VERSION.test(version) ? version : null,
      description: typeof hit.abstract === 'string' ? hit.abstract.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '' })
  }
  return found
}

const bodyOf = async (response: Response): Promise<string> => {
  if (!response.ok || !response.body) return unavailable()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) return Buffer.concat(chunks).toString('utf8')
    bytes += next.value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return unavailable() }
    chunks.push(next.value)
  }
}

/** One search at a time per account, so a loop in one page cannot hold memory or wear out the shared service. */
const searching = new Set<string>()

/** GET /api/account/perl-modules/search?q=<words> for the signed-in account owner. */
export async function handleCpanSearchRoute(req: Request, url: URL, method: string, ports: AccountSshPorts, fetcher: typeof fetch = fetch): Promise<Response> {
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const { account } = await authorizeAccountOwner(ports, req, ['perl-modules'], 'Perl modules')
  const query = url.searchParams.get('q') ?? ''
  if (url.searchParams.size !== 1 || !QUERY.test(query)) return fail('VALIDATION', 'search for 2 to 100 letters, digits or module name characters', { stateChanged: false, reason: 'invalid_search' })
  if (searching.has(account.id)) return fail('CONFLICT', 'a search is already running', { stateChanged: false, reason: 'OPERATION_IN_PROGRESS' })
  searching.add(account.id)
  try {
    const address = `${SEARCH_URL}?q=${encodeURIComponent(query)}&size=${MAX_RESULTS}`
    const text = await fetcher(address, { redirect: 'error', headers: { accept: 'application/json', 'user-agent': 'xPanel' }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then(bodyOf).catch(() => unavailable())
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return unavailable() }
    const modules = readCpanResults(parsed)
    return modules ? workspaceJson({ context: { accountId: account.id }, query, modules }) : unavailable()
  } finally { searching.delete(account.id) }
}
