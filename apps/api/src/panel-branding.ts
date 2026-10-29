import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readLimitedBody, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'

export type BrandingAssetKind = 'logo' | 'favicon'
export interface BrandingAsset { sha256: string; contentType: 'image/png' | 'image/jpeg' | 'image/x-icon'; bytes: number; width: number; height: number; uploadedAt: string }
export interface PanelBrandingFields {
  companyName: string
  productName: string
  footerText: string
  hidePoweredBy: boolean
  /** `#rrggbb`, or empty for the theme's own colour */
  primaryColor: string
  accentColor: string
  supportUrl: string
  supportEmail: string
  /** What a person sees before choosing their own appearance and table spacing. */
  defaultTheme: 'light' | 'dark'
  defaultDensity: 'comfortable' | 'compact'
}
export interface PanelBrandingValue extends PanelBrandingFields { logo: BrandingAsset | null; favicon: BrandingAsset | null }
export interface PanelBrandingView { state: 'default' | 'saved' | 'invalid'; branding: PanelBrandingValue | null; updatedAt: string | null; revision: string }

const ROUTE = '/api/server/panel/branding'
const ASSET_ROUTE = /^\/api\/server\/panel\/branding\/(logo|favicon)$/
const NAMESPACE = 'panel-branding:v1'
const TEXT_FIELDS = ['companyName', 'productName', 'footerText', 'hidePoweredBy', 'primaryColor', 'accentColor', 'supportUrl', 'supportEmail', 'defaultTheme', 'defaultDensity'] as const
export const BRANDING_LIMITS = {
  companyName: 80, productName: 40, footerText: 200, supportUrl: 2048, supportEmail: 254,
  logo: { bytes: 512 * 1024, min: 16, max: 4096 }, favicon: { bytes: 128 * 1024, min: 16, max: 512 },
} as const
const unchanged = { stateChanged: false }
const invalid = (field: string, message: string, code = 'invalid'): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field, code }] })
export const DEFAULT_PANEL_BRANDING = (): PanelBrandingValue => ({ companyName: '', productName: '', footerText: '', hidePoweredBy: false, primaryColor: '', accentColor: '',
  supportUrl: '', supportEmail: '', defaultTheme: 'light', defaultDensity: 'comfortable', logo: null, favicon: null })

const plain = (field: keyof typeof BRANDING_LIMITS, value: unknown): string => {
  const max = BRANDING_LIMITS[field] as number
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]/u.test(value) || value.trim() !== value) {
    return invalid(field, `${field} is plain text of at most ${max} characters, without "<" or ">"`)
  }
  return value
}

export function parseBrandingFields(value: Record<string, unknown>): PanelBrandingFields {
  const color = (field: 'primaryColor' | 'accentColor'): string => {
    const raw = value[field]
    return raw === '' ? '' : typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : invalid(field, `${field} is a #RRGGBB colour or empty`)
  }
  const supportUrl = plain('supportUrl', value.supportUrl)
  if (supportUrl) {
    let parsed: URL | null = null
    try { parsed = new URL(supportUrl) } catch { parsed = null }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || /["'\s]/.test(supportUrl)) invalid('supportUrl', 'the support URL is an https:// address')
  }
  const supportEmail = plain('supportEmail', value.supportEmail)
  if (supportEmail && !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(supportEmail)) {
    invalid('supportEmail', 'the support email is one address like help@example.com')
  }
  if (typeof value.hidePoweredBy !== 'boolean') invalid('hidePoweredBy', 'hidePoweredBy must be true or false')
  if (value.defaultTheme !== 'light' && value.defaultTheme !== 'dark') invalid('defaultTheme', 'the default appearance is light or dark')
  if (value.defaultDensity !== 'comfortable' && value.defaultDensity !== 'compact') invalid('defaultDensity', 'the default table spacing is comfortable or compact')
  return { companyName: plain('companyName', value.companyName), productName: plain('productName', value.productName), footerText: plain('footerText', value.footerText),
    hidePoweredBy: value.hidePoweredBy as boolean, primaryColor: color('primaryColor'), accentColor: color('accentColor'), supportUrl, supportEmail,
    defaultTheme: value.defaultTheme as 'light' | 'dark', defaultDensity: value.defaultDensity as 'comfortable' | 'compact' }
}

const ASSET_TYPES: Readonly<Record<BrandingAssetKind, readonly BrandingAsset['contentType'][]>> = { logo: ['image/png', 'image/jpeg'], favicon: ['image/png', 'image/x-icon'] }
const parseAsset = (kind: BrandingAssetKind, raw: unknown): BrandingAsset | null => {
  if (raw === null) return null
  const a = raw as Record<string, unknown>, limit = BRANDING_LIMITS[kind]
  if (!a || typeof a !== 'object' || !exactKeys(a, ['sha256', 'contentType', 'bytes', 'width', 'height', 'uploadedAt']) || typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256)
    || !ASSET_TYPES[kind].includes(a.contentType as BrandingAsset['contentType']) || !Number.isSafeInteger(a.bytes) || (a.bytes as number) < 1 || (a.bytes as number) > limit.bytes
    || [a.width, a.height].some(n => !Number.isSafeInteger(n) || (n as number) < limit.min || (n as number) > limit.max)
    || typeof a.uploadedAt !== 'string' || new Date(a.uploadedAt).toISOString() !== a.uploadedAt) throw new Error('invalid_asset')
  return a as unknown as BrandingAsset
}
const parseRecord = (raw: unknown): PanelBrandingValue | null => {
  try {
    const r = raw as Record<string, unknown>
    if (!r || typeof r !== 'object' || Array.isArray(r) || !exactKeys(r, [...TEXT_FIELDS, 'logo', 'favicon', 'version', 'updatedAt']) || r.version !== 1
      || typeof r.updatedAt !== 'string' || new Date(r.updatedAt).toISOString() !== r.updatedAt) return null
    return { ...parseBrandingFields(r), logo: parseAsset('logo', r.logo), favicon: parseAsset('favicon', r.favicon) }
  } catch { return null }
}

export const panelBrandingFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<PanelBrandingValue> =>
  panelConfigFile(store, 'branding.json', NAMESPACE, parseRecord, DEFAULT_PANEL_BRANDING)
const EXTENSIONS: Readonly<Record<BrandingAsset['contentType'], string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/x-icon': 'ico' }
export const brandingAssetPath = (file: PanelConfigFile<unknown>, kind: BrandingAssetKind, asset: BrandingAsset): string =>
  join(dirname(file.path), 'branding', `${kind}-${asset.sha256}.${EXTENSIONS[asset.contentType]}`)

/** Reads the dimensions from the image header; anything that is not a well-formed PNG, JPEG or ICO header is refused. */
export function inspectBrandingImage(kind: BrandingAssetKind, bytes: Uint8Array, declared: string): { contentType: BrandingAsset['contentType']; width: number; height: number } {
  const limit = BRANDING_LIMITS[kind], b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b.length < 8 || b.length > limit.bytes) return invalid(kind, `the ${kind} must be at most ${limit.bytes / 1024} KiB`, 'size')
  let found: { contentType: BrandingAsset['contentType']; width: number; height: number } | null = null
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR') {
    found = { contentType: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) break
      const marker = b[i + 1]!, size = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { found = { contentType: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }; break }
      if (size < 2) break
      i += 2 + size
    }
  } else if (b.readUInt32BE(0) === 0x00000100 && b.readUInt16LE(4) >= 1 && b.length >= 22) {
    found = { contentType: 'image/x-icon', width: b[6] || 256, height: b[7] || 256 }
  }
  if (!found || !ASSET_TYPES[kind].includes(found.contentType)) return invalid(kind, kind === 'logo' ? 'the logo must be a PNG or JPEG image' : 'the favicon must be a PNG or ICO image', 'type')
  if (declared !== found.contentType && !(found.contentType === 'image/x-icon' && declared === 'image/vnd.microsoft.icon')) return invalid(kind, 'the declared type does not match the image', 'type')
  if ([found.width, found.height].some(n => n < limit.min || n > limit.max) || (kind === 'favicon' && found.width !== found.height)) {
    return invalid(kind, kind === 'favicon' ? `the favicon must be square, ${limit.min} to ${limit.max} pixels` : `the logo must be ${limit.min} to ${limit.max} pixels on each side`, 'dimensions')
  }
  return found
}

const writeAsset = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o750 })
  const temp = `${path}.${process.pid}.tmp`
  try { await writeFile(temp, bytes, { mode: 0o644, flush: true }); await rename(temp, path) }
  finally { await rm(temp, { force: true }).catch(() => undefined) }
}

const viewOf = (raw: unknown, value: PanelBrandingValue | null): PanelBrandingView => ({
  state: raw === null ? 'default' : value ? 'saved' : 'invalid', branding: value,
  updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null, revision: panelConfigRevision(NAMESPACE, raw),
})

export interface PanelBrandingHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  now?: () => Date
}

/** Root branding: text and colours by PUT, logo and favicon as raw image uploads; every write is revision-bound and read back. */
export async function handlePanelBrandingRoute(request: Request, url: URL, method: string, helpers: PanelBrandingHelpers): Promise<Response | null> {
  const assetMatch = ASSET_ROUTE.exec(url.pathname)
  if (url.pathname !== ROUTE && !assetMatch) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'panel.branding')
  const file = panelBrandingFile(helpers.store), now = (helpers.now ?? (() => new Date()))().toISOString()
  const authority = async (): Promise<void> => { await helpers.assertRoot(await helpers.requireCaller(request), 'panel.branding') }
  const audit = async (action: string, detail: Record<string, unknown>): Promise<void> => {
    try { await helpers.emitAudit({ actor: caller.principal.username, action, target: 'panel-branding', outcome: 'ok', principalId: caller.principal.id, detail }) }
    catch { fail('SERVICE_UNAVAILABLE', 'branding was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  }
  const current = async (): Promise<PanelBrandingValue> => {
    const { raw, value } = await file.read()
    return value ?? (raw === null ? DEFAULT_PANEL_BRANDING() : fail('PRECONDITION_FAILED', 'the saved branding requires review before it can be changed', unchanged))
  }
  if (!assetMatch) {
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (url.search) return fail('VALIDATION', 'branding accepts no query selectors', unchanged)
    if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value)) }
    const body = await readPanelConfigBody(request)
    if (!exactKeys(body, [...TEXT_FIELDS, 'expectedRevision'])) return fail('VALIDATION', `exactly ${TEXT_FIELDS.join(', ')} and expectedRevision are required`, unchanged)
    const expected = assertExpectedRevision(body.expectedRevision), fields = parseBrandingFields(body), before = await current()
    const saved = await file.write({ version: 1, ...fields, logo: before.logo, favicon: before.favicon, updatedAt: now } as unknown as PanelBrandingValue, expected, authority)
    await audit('panel.branding.updated', { fields: TEXT_FIELDS.filter(key => before[key] !== fields[key]) })
    return panelJson(viewOf(saved.raw, saved.value))
  }
  const kind = assetMatch[1] as BrandingAssetKind
  if (method !== 'PUT' && method !== 'DELETE') return new Response(null, { status: 405, headers: { allow: 'PUT, DELETE' } })
  if ([...url.searchParams.keys()].join() !== 'expectedRevision') return fail('VALIDATION', 'the upload takes only ?expectedRevision=', unchanged)
  const expected = assertExpectedRevision(url.searchParams.get('expectedRevision'))
  const before = await current(), previous = before[kind]
  let asset: BrandingAsset | null = null, bytes: Uint8Array | null = null
  if (method === 'PUT') {
    bytes = await readLimitedBody(request, BRANDING_LIMITS[kind].bytes)
    const image = inspectBrandingImage(kind, bytes, request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '')
    asset = { sha256: createHash('sha256').update(bytes).digest('hex'), contentType: image.contentType, bytes: bytes.byteLength, width: image.width, height: image.height, uploadedAt: now }
    // The content-addressed image lands before the record names it; an orphan from a failed save is harmless.
    await writeAsset(brandingAssetPath(file, kind, asset), bytes)
  } else if (!previous) return fail('VALIDATION', `no ${kind} is saved`, unchanged)
  const { logo, favicon, ...text } = before
  const next = { version: 1, ...text, logo, favicon, [kind]: asset, updatedAt: now }
  const saved = await file.write(next as unknown as PanelBrandingValue, expected, authority)
  if (previous && previous.sha256 !== asset?.sha256) await rm(brandingAssetPath(file, kind, previous), { force: true }).catch(() => undefined)
  await audit(method === 'PUT' ? `panel.branding.${kind}_uploaded` : `panel.branding.${kind}_removed`, asset ? { sha256: asset.sha256, bytes: asset.bytes, contentType: asset.contentType } : {})
  return panelJson(viewOf(saved.raw, saved.value))
}

/** Public, unauthenticated: the sign-in page shows the logo too. Only the saved, re-hashed image is ever served. */
export async function servePanelBrandingAsset(store: Pick<StateStore, 'rootDir' | 'getWriterLock'>, pathname: string): Promise<Response | null> {
  const match = /^\/branding\/(logo|favicon)$/.exec(pathname)
  if (!match) return null
  const kind = match[1] as BrandingAssetKind, file = panelBrandingFile(store)
  const asset = (await file.current())[kind]
  const missing = new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  if (!asset) return missing
  let body: Buffer
  try { body = await readFile(brandingAssetPath(file, kind, asset)) } catch { return missing }
  if (createHash('sha256').update(body).digest('hex') !== asset.sha256) return missing
  return new Response(new Uint8Array(body), { headers: { 'content-type': asset.contentType, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'", 'cross-origin-resource-policy': 'same-origin', etag: `"${asset.sha256}"` } })
}

/** The branding every rendered page receives; `v` keys the browser cache to the image content. */
export function brandingForDocuments(value: PanelBrandingValue): {
  companyName: string; productName: string; footerText: string; hidePoweredBy: boolean; primaryColor: string; accentColor: string
  supportUrl: string; supportEmail: string; logoUrl: string | null; faviconUrl: string | null
} {
  return { companyName: value.companyName, productName: value.productName, footerText: value.footerText, hidePoweredBy: value.hidePoweredBy,
    primaryColor: value.primaryColor, accentColor: value.accentColor, supportUrl: value.supportUrl, supportEmail: value.supportEmail,
    logoUrl: value.logo ? `/branding/logo?v=${value.logo.sha256.slice(0, 16)}` : null, faviconUrl: value.favicon ? `/branding/favicon?v=${value.favicon.sha256.slice(0, 16)}` : null }
}
