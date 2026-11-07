import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCALES, SOURCE_LOCALE, fail, isLocale, localeDirection, localeInfo } from '@xpanel/core'
import type { Locale } from '@xpanel/core'
import { atomicRemove, atomicWriteJson } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { MAX_CATALOG_BYTES, copiedLocalePo, effectiveMessageCount, installLocaleOverrides, installRuntimeLocale, localeCatalogPo, setLocalePolicy, validateLocaleCatalog } from '../../web/src/i18n.ts'
import type { LocalePolicy } from '../../web/src/i18n.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/**
 * Server languages: which registry locales the panels offer, the fallback locale, and administrator-uploaded
 * gettext catalogs merged over the release catalogs. The policy applies at once; catalogs apply at the next
 * panel start (client catalogs are cached assets), and the view says which one is in use.
 *
 * State: extended/locales/policy.json and extended/locales/<tag>.json (metadata with the PO text, one atomic file).
 */
export interface PanelLanguagesHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Applies a saved policy to page rendering; defaults to the web runtime's setLocalePolicy. */
  onPolicySaved?: (policy: LocalePolicy) => void
  now?: () => Date
}
export interface LanguageOverrideView { uploadedAt: string; uploadedBy: string; sha256: string; entries: number }
export interface LanguageView {
  tag: Locale; name: string; nativeName: string; dir: 'ltr' | 'rtl'; source: boolean; offered: boolean; messages: number
  override: LanguageOverrideView | null; overrideState: 'none' | 'saved' | 'invalid'; runtime: 'applied' | 'restart_required' | 'rejected'
}
export interface LocaleCopyView { tag: string; name: string; source: string; messages: number; active: boolean }
export interface PanelLanguagesView { locales: LanguageView[]; defaultLocale: Locale; policyState: 'default' | 'saved' | 'invalid'; updatedAt: string | null; revision: string; copies: LocaleCopyView[] }
interface PolicyRecord { version: 1; offered: Locale[]; defaultLocale: Locale; updatedAt: string; updatedBy: string }
interface OverrideRecord extends LanguageOverrideView { version: 1; locale: Locale; catalog: string }
interface CopyRecord { version: 1; tag: string; name: string; nativeName: string; dir: 'ltr' | 'rtl'; script: string; source: Locale; messages: number; po: string; sha256: string; createdAt: string; createdBy: string }
export const MAX_LOCALE_COPIES = 8
const TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/

const ROUTE = '/api/server/panel/languages'
const CATALOG_ROUTE = /^\/api\/server\/panel\/languages\/([A-Za-z0-9-]{1,35})\/catalog$/
const COPY_ROUTE = /^\/api\/server\/panel\/languages\/copies(?:\/([A-Za-z0-9-]{1,35}))?$/
const unchanged = { stateChanged: false }
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, ACTOR = /^[A-Za-z0-9_.@-]{1,64}$/
const invalid = (message: string, detail: Record<string, unknown> = {}): never => fail('VALIDATION', message, { ...detail, ...unchanged })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const translated = (): Locale[] => LOCALES.map(info => info.tag).filter(tag => tag !== SOURCE_LOCALE)
const policyPath = (rootDir: string): string => join(rootDir, 'extended', 'locales', 'policy.json')
const overridePath = (rootDir: string, tag: Locale): string => join(rootDir, 'extended', 'locales', tag + '.json')
const copyDir = (rootDir: string): string => join(rootDir, 'extended', 'locales', 'copies')
const copyPath = (rootDir: string, tag: string): string => join(copyDir(rootDir), tag + '.json')

const readText = async (path: string): Promise<string | null> => {
  try { return await readFile(path, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'saved language settings cannot be read; review the saved files before retrying', unchanged)
  }
}
const parsed = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text) } catch { return undefined } }
const offeredList = (value: unknown): Locale[] | null => Array.isArray(value) && value.length > 0 && value.every(isLocale) && new Set(value).size === value.length
  ? LOCALES.map(info => info.tag).filter(tag => value.includes(tag)) : null

export function readSavedLanguagePolicy(raw: unknown): PolicyRecord | null {
  if (!object(raw) || keys(raw) !== 'defaultLocale,offered,updatedAt,updatedBy,version' || raw.version !== 1) return null
  const offered = offeredList(raw.offered)
  if (!offered || !isLocale(raw.defaultLocale) || !offered.includes(raw.defaultLocale) || typeof raw.updatedAt !== 'string' || !STAMP.test(raw.updatedAt)
    || typeof raw.updatedBy !== 'string' || !ACTOR.test(raw.updatedBy)) return null
  return { version: 1, offered, defaultLocale: raw.defaultLocale, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy }
}
export function readSavedLanguageOverride(raw: unknown, tag: Locale): OverrideRecord | null {
  if (!object(raw) || keys(raw) !== 'catalog,entries,locale,sha256,uploadedAt,uploadedBy,version' || raw.version !== 1 || raw.locale !== tag || tag === SOURCE_LOCALE
    || typeof raw.catalog !== 'string' || typeof raw.sha256 !== 'string' || raw.sha256 !== sha256(raw.catalog) || !Number.isSafeInteger(raw.entries) || (raw.entries as number) < 0
    || typeof raw.uploadedAt !== 'string' || !STAMP.test(raw.uploadedAt) || typeof raw.uploadedBy !== 'string' || !ACTOR.test(raw.uploadedBy)) return null
  return { version: 1, locale: tag, catalog: raw.catalog, sha256: raw.sha256, entries: raw.entries as number, uploadedAt: raw.uploadedAt, uploadedBy: raw.uploadedBy }
}

const copyOf = (text: string | null): CopyRecord | null => {
  const raw = parsed(text)
  if (!object(raw) || keys(raw) !== 'createdAt,createdBy,dir,messages,name,nativeName,po,script,sha256,source,tag,version' || raw.version !== 1 || typeof raw.tag !== 'string' || !TAG.test(raw.tag) || typeof raw.po !== 'string' || raw.sha256 !== sha256(raw.po) || !isLocale(raw.source) || (raw.dir !== 'ltr' && raw.dir !== 'rtl')) return null
  return raw as unknown as CopyRecord
}
const readCopies = async (rootDir: string): Promise<Map<string, string>> => {
  let names: string[]
  try { names = await readdir(copyDir(rootDir)) } catch { return new Map() }
  const copies = new Map<string, string>()
  for (const name of names.sort()) { const text = name.endsWith('.json') ? await readText(join(copyDir(rootDir), name)) : null; if (text !== null) copies.set(name.slice(0, -5), text) }
  return copies
}

interface SavedState { policyText: string | null; overrideTexts: Map<Locale, string | null>; copyTexts: Map<string, string> }
const readState = async (rootDir: string): Promise<SavedState> => {
  const overrideTexts = new Map<Locale, string | null>()
  for (const tag of translated()) overrideTexts.set(tag, await readText(overridePath(rootDir, tag)))
  return { policyText: await readText(policyPath(rootDir)), overrideTexts, copyTexts: await readCopies(rootDir) }
}
export const panelLanguagesRevision = (state: SavedState): string => sha256(JSON.stringify({ namespace: 'panel-languages:v1',
  policy: state.policyText === null ? null : sha256(state.policyText), overrides: [...state.overrideTexts].map(([tag, text]) => [tag, text === null ? null : sha256(text)]), copies: [...state.copyTexts].map(([tag, text]) => [tag, sha256(text)]) }))
const savedOverride = (state: SavedState, tag: Locale): OverrideRecord | null => readSavedLanguageOverride(parsed(state.overrideTexts.get(tag) ?? null), tag)

// What this process applied at start: the digest of each installed override and whether it validated.
const startup = new Map<Locale, { digest: string; applied: boolean }>()
const runtimeOf = (tag: Locale, record: OverrideRecord | null): LanguageView['runtime'] => {
  const running = startup.get(tag), saved = record?.sha256 ?? null
  if (running && running.digest === saved) return running.applied ? 'applied' : 'rejected'
  return !running && saved === null ? 'applied' : 'restart_required'
}

const viewOf = (state: SavedState): PanelLanguagesView => {
  const raw = parsed(state.policyText), policy = readSavedLanguagePolicy(raw)
  const offered = policy?.offered ?? LOCALES.map(info => info.tag)
  return {
    locales: LOCALES.map(info => {
      const record = info.tag === SOURCE_LOCALE ? null : savedOverride(state, info.tag)
      const present = info.tag !== SOURCE_LOCALE && state.overrideTexts.get(info.tag) != null
      return { tag: info.tag, name: info.name, nativeName: info.nativeName, dir: info.dir, source: info.tag === SOURCE_LOCALE, offered: offered.includes(info.tag),
        messages: effectiveMessageCount(info.tag), override: record && { uploadedAt: record.uploadedAt, uploadedBy: record.uploadedBy, sha256: record.sha256, entries: record.entries },
        overrideState: record ? 'saved' : present ? 'invalid' : 'none', runtime: runtimeOf(info.tag, record) }
    }),
    defaultLocale: policy?.defaultLocale ?? SOURCE_LOCALE,
    policyState: state.policyText === null ? 'default' : policy ? 'saved' : 'invalid',
    updatedAt: policy?.updatedAt ?? null,
    revision: panelLanguagesRevision(state),
    copies: [...state.copyTexts.values()].flatMap(text => { const copy = copyOf(text); return copy ? [{ tag: copy.tag, name: copy.name, source: copy.source, messages: copy.messages, active: isLocale(copy.tag) }] : [] }),
  }
}

/**
 * Panel start: installs the saved policy and every valid saved catalog before pages render. Never throws;
 * unreadable or invalid saved state leaves the release defaults in force and is reported by the API view.
 */
export async function installSavedLanguages(rootDir: string): Promise<{ policy: 'default' | 'saved' | 'invalid'; applied: Locale[]; rejected: Locale[] }> {
  let state: SavedState
  try {
    for (const text of (await readCopies(rootDir)).values()) { const copy = copyOf(text); if (copy) installRuntimeLocale({ tag: copy.tag, name: copy.name, nativeName: copy.nativeName, dir: copy.dir, script: copy.script, base: copy.source }, copy.po) }
    state = await readState(rootDir)
  } catch { return { policy: 'invalid', applied: [], rejected: [] } }
  const policy = readSavedLanguagePolicy(parsed(state.policyText))
  setLocalePolicy(policy && { offered: policy.offered, defaultLocale: policy.defaultLocale })
  const records = translated().map(tag => savedOverride(state, tag)).filter((record): record is OverrideRecord => record !== null)
  const result = installLocaleOverrides(Object.fromEntries(records.map(record => [record.locale, record.catalog])))
  startup.clear()
  for (const record of records) startup.set(record.locale, { digest: record.sha256, applied: result.applied.includes(record.locale) })
  return { policy: state.policyText === null ? 'default' : policy ? 'saved' : 'invalid', ...result }
}

const PO_TYPES = ['text/x-gettext-translation', 'text/x-po', 'text/plain']
const readBody = async (request: Request, types: readonly string[], limit: number): Promise<Buffer> => {
  if (!types.includes(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '')) return invalid(`the request body must be ${types.join(' or ')}`)
  if (!request.body) return invalid('a request body is required')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0
  for (;;) {
    const next = await reader.read(); if (next.done) break
    bytes += next.value.byteLength
    if (bytes > limit) { await reader.cancel(); return invalid('the request body is too large', { fields: [{ field: 'catalog', code: 'too_large' }] }) }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks)
}
const readJsonBody = async (request: Request, limit: number): Promise<unknown> => {
  const body = await readBody(request, ['application/json'], limit)
  try { return JSON.parse(body.toString('utf8')) } catch { return invalid('request body is not valid JSON') }
}
const revisionOf = (value: Record<string, unknown>): string =>
  typeof value.expectedRevision === 'string' && /^[0-9a-f]{64}$/.test(value.expectedRevision) ? value.expectedRevision : invalid('the observed languages revision is required')

export function parseLanguagePolicyUpdate(value: unknown): { offered: Locale[]; defaultLocale: Locale; expectedRevision: string } {
  if (!object(value) || keys(value) !== 'defaultLocale,expectedRevision,offered') return invalid('exactly offered, defaultLocale and expectedRevision are required')
  const offered = offeredList(value.offered)
  if (!offered) return invalid(`offered must list one or more of ${LOCALES.map(info => info.tag).join(', ')} once each`, { fields: [{ field: 'offered', code: 'invalid' }] })
  if (!isLocale(value.defaultLocale) || !offered.includes(value.defaultLocale)) return invalid('the default language must be one of the offered languages', { fields: [{ field: 'defaultLocale', code: 'not_offered' }] })
  return { offered, defaultLocale: value.defaultLocale, expectedRevision: revisionOf(value) }
}

const sameCaller = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id
  && left.principal.kind === right.principal.kind && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

/** The name of a language in another language, from CLDR, or its tag when CLDR has none. */
const cldrName = (tag: string, inLocale: string): string => { try { return new Intl.DisplayNames([inLocale], { type: 'language' }).of(tag) ?? tag } catch { return tag } }

/** POST .../languages/copies copies a locale under a new code; DELETE .../languages/copies/<tag> removes a copy. Both apply at the next panel start. */
async function handleLocaleCopy(request: Request, url: URL, method: string, helpers: PanelLanguagesHelpers, tag: string | undefined): Promise<Response> {
  const action = tag ? 'panel.languages.copy_remove' : 'panel.languages.copy_create', allow = tag ? 'DELETE' : 'POST'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return invalid('language settings accept no query selectors')
  const body = await readJsonBody(request, 4096), rootDir = helpers.store.rootDir
  if (!object(body) || keys(body) !== (tag ? 'expectedRevision' : 'expectedRevision,source,tag')) return invalid(tag ? 'exactly expectedRevision is required' : 'exactly source, tag and expectedRevision are required')
  const expected = revisionOf(body)
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false, view: PanelLanguagesView, audit: Record<string, unknown>
  try {
    const state = await readState(rootDir)
    if (panelLanguagesRevision(state) !== expected) return fail('CONFLICT', 'language settings changed; reload before saving', unchanged)
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (!sameCaller(caller, current)) return fail('FORBIDDEN', 'administrator authority changed; sign in again', unchanged)
    await lease.assertFencingToken()
    if (tag) {
      if (!state.copyTexts.has(tag)) return fail('NOT_FOUND', 'no such locale copy', unchanged)
      const policy = readSavedLanguagePolicy(parsed(state.policyText))
      if (policy?.defaultLocale === tag) return fail('CONFLICT', 'the default language cannot be deleted', { ...unchanged, reason: 'protected_locale' })
      attempted = true
      if (policy?.offered.includes(tag as Locale)) await atomicWriteJson(policyPath(rootDir), { ...policy, offered: policy.offered.filter(item => item !== tag) }, 0o640)
      await atomicRemove(copyPath(rootDir, tag))
      await atomicRemove(overridePath(rootDir, tag as Locale)).catch(() => undefined)
      audit = { locale: tag }
    } else {
      const wanted = body.tag, source = body.source
      if (typeof wanted !== 'string' || !TAG.test(wanted)) return invalid('the new code must be a language tag such as fr or pt-BR', { fields: [{ field: 'tag', code: 'invalid' }] })
      if (!isLocale(source)) return invalid('the source must be a locale of this panel', { fields: [{ field: 'source', code: 'invalid' }] })
      if (isLocale(wanted) || state.copyTexts.has(wanted)) return fail('CONFLICT', 'a locale with this code already exists', { ...unchanged, reason: 'locale_exists' })
      if (state.copyTexts.size >= MAX_LOCALE_COPIES) return fail('LIMIT_EXCEEDED', `at most ${MAX_LOCALE_COPIES} locale copies can be saved`, { ...unchanged, reason: 'too_many_locales' })
      const { po, messages } = copiedLocalePo(source, wanted, savedOverride(state, source)?.catalog)
      const record: CopyRecord = { version: 1, tag: wanted, name: cldrName(wanted, 'en'), nativeName: cldrName(wanted, wanted), dir: localeDirection(source), script: localeInfo(source).script, source, messages, po, sha256: sha256(po), createdAt: (helpers.now ?? (() => new Date()))().toISOString(), createdBy: caller.principal.username }
      attempted = true
      await atomicWriteJson(copyPath(rootDir, wanted), record, 0o640)
      audit = { locale: wanted, source, messages }
    }
    view = viewOf(await readState(rootDir))
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the language change could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, action: tag ? 'panel.languages.copy_removed' : 'panel.languages.copied', target: `locale:${audit!.locale}`, detail: audit!, outcome: 'ok', principalId: caller.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the language change was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return json(view!)
}

/**
 * GET/PUT /api/server/panel/languages (view; offered locales and default locale).
 * GET/PUT/DELETE /api/server/panel/languages/<tag>/catalog: download the effective catalog (PO attachment, or JSON
 * `{ locale, filename, catalog }` when the client accepts JSON), upload the raw PO file (`text/x-gettext-translation`,
 * UTF-8, at most 4 MiB) with `?expectedRevision=<revision>`, and remove the upload (JSON `{ expectedRevision }`).
 */
export async function handlePanelLanguagesRoute(request: Request, url: URL, method: string, helpers: PanelLanguagesHelpers): Promise<Response | null> {
  const copyMatch = COPY_ROUTE.exec(url.pathname)
  if (copyMatch) return handleLocaleCopy(request, url, method, helpers, copyMatch[1])
  const match = url.pathname === ROUTE ? null : CATALOG_ROUTE.exec(url.pathname)
  if (url.pathname !== ROUTE && !match) return null
  const catalogRoute = match !== null, allowed = catalogRoute ? ['GET', 'PUT', 'DELETE'] : ['GET', 'PUT']
  const action = !catalogRoute ? (method === 'PUT' ? 'panel.languages.update' : 'panel.languages.read')
    : method === 'PUT' ? 'panel.languages.catalog_upload' : method === 'DELETE' ? 'panel.languages.catalog_remove' : 'panel.languages.catalog_download'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  // Only a catalog upload takes a query: its revision, because the body is the raw PO file.
  const uploadQuery = catalogRoute && method === 'PUT' && [...url.searchParams.keys()].join() === 'expectedRevision'
  if (url.search && !uploadQuery) return invalid('language settings accept no query selectors')
  const tag = match?.[1]
  if (tag !== undefined && !isLocale(tag)) return fail('NOT_FOUND', 'no such locale in this release', unchanged)
  const rootDir = helpers.store.rootDir
  const fresh = async (): Promise<void> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (!sameCaller(caller, current)) fail('FORBIDDEN', 'administrator authority changed; sign in again', unchanged)
  }

  if (method === 'GET' && !tag) { const state = await readState(rootDir); await fresh(); return json(viewOf(state)) }
  if (method === 'GET') {
    const state = await readState(rootDir); await fresh()
    const locale = tag as Locale, catalog = localeCatalogPo(locale, savedOverride(state, locale)?.catalog), filename = `${locale}.${locale === SOURCE_LOCALE ? 'pot' : 'po'}`
    if (/\bapplication\/json\b/i.test(request.headers.get('accept') ?? '')) return json({ locale, filename, catalog })
    return new Response(catalog, { headers: { 'content-type': 'text/x-gettext-translation; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }

  // Mutations: validate the body before taking the writer lease.
  let commit: (state: SavedState) => { path: string; next: PolicyRecord | OverrideRecord | null; audit: Record<string, unknown> }
  const stamp = (): string => (helpers.now ?? (() => new Date()))().toISOString()
  let applyPolicy = null as LocalePolicy | null
  if (!tag) {
    const input = parseLanguagePolicyUpdate(await readJsonBody(request, 4096))
    commit = state => {
      if (panelLanguagesRevision(state) !== input.expectedRevision) return fail('CONFLICT', 'language settings changed; reload before saving', unchanged)
      applyPolicy = { offered: input.offered, defaultLocale: input.defaultLocale }
      return { path: policyPath(rootDir), next: { version: 1, offered: input.offered, defaultLocale: input.defaultLocale, updatedAt: stamp(), updatedBy: caller.principal.username }, audit: { offered: input.offered, defaultLocale: input.defaultLocale } }
    }
  } else if (method === 'PUT') {
    const locale = tag as Locale
    if (locale === SOURCE_LOCALE) return invalid('the source locale has no catalog to upload', { fields: [{ field: 'catalog', code: 'source_locale' }] })
    const expectedRevision = revisionOf({ expectedRevision: url.searchParams.get('expectedRevision') })
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readBody(request, PO_TYPES, MAX_CATALOG_BYTES)) }
    catch (error) { if ((error as { code?: unknown }).code === 'VALIDATION') throw error; return invalid('the catalog must be UTF-8 text', { fields: [{ field: 'catalog', code: 'encoding' }] }) }
    const check = validateLocaleCatalog(locale, text)
    if (check.problemCount) return invalid(`the catalog was refused: ${check.problemCount} problem(s)`, { fields: check.problems, problemCount: check.problemCount })
    const entries = check.entries.filter(entry => entry.translation !== '').length
    commit = state => {
      if (panelLanguagesRevision(state) !== expectedRevision) return fail('CONFLICT', 'language settings changed; reload before uploading', unchanged)
      const next: OverrideRecord = { version: 1, locale, catalog: text, sha256: sha256(text), entries, uploadedAt: stamp(), uploadedBy: caller.principal.username }
      return { path: overridePath(rootDir, locale), next, audit: { locale, sha256: next.sha256, entries } }
    }
  } else {
    const locale = tag as Locale, body = await readJsonBody(request, 4096)
    if (!object(body) || keys(body) !== 'expectedRevision') return invalid('exactly expectedRevision is required')
    const expectedRevision = revisionOf(body)
    commit = state => {
      if (panelLanguagesRevision(state) !== expectedRevision) return fail('CONFLICT', 'language settings changed; reload before removing', unchanged)
      if (locale === (readSavedLanguagePolicy(parsed(state.policyText))?.defaultLocale ?? SOURCE_LOCALE)) return fail('CONFLICT', 'the default language cannot be deleted', { ...unchanged, reason: 'protected_locale' })
      if (locale === SOURCE_LOCALE || state.overrideTexts.get(locale) == null) return invalid('this locale has no uploaded catalog')
      return { path: overridePath(rootDir, locale), next: null, audit: { locale } }
    }
  }

  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false, result: PanelLanguagesView, audit: Record<string, unknown>
  try {
    await fresh()
    const plan = commit(await readState(rootDir))
    audit = plan.audit
    await fresh()
    await lease.assertFencingToken()
    attempted = true
    const guard = async (): Promise<void> => { await fresh(); await lease.assertFencingToken() }
    if (plan.next) await atomicWriteJson(plan.path, plan.next, 0o640, guard)
    else await atomicRemove(plan.path, guard)
    const saved = await readText(plan.path)
    if (plan.next ? saved === null || JSON.stringify(JSON.parse(saved)) !== JSON.stringify(plan.next) : saved !== null) throw new Error('languages_readback_failed')
    result = viewOf(await readState(rootDir))
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the language change could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  if (applyPolicy) (helpers.onPolicySaved ?? setLocalePolicy)(applyPolicy)
  const auditAction = !tag ? 'panel.languages.updated' : method === 'PUT' ? 'panel.languages.catalog_uploaded' : 'panel.languages.catalog_removed'
  try { await helpers.emitAudit({ actor: caller.principal.username, action: auditAction, target: tag ? `locale:${tag}` : 'application-locales', detail: audit!, outcome: 'ok', principalId: caller.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the language change was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return json(result!)
}
