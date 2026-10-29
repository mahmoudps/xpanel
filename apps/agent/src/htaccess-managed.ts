import { BlockList, isIPv4, isIPv6 } from 'node:net'
import { fail, validateDomainName } from '@xpanel/core'
import { inspectHtaccess } from './htaccess-policy.ts'

/** xPanel-owned marked blocks inside the checked domain .htaccess; every other byte stays untouched. */
export const WEB_DIRECTIVE_FEATURES = ['error-pages', 'indexes', 'mime-types', 'hotlink', 'ip-blocker', 'redirects'] as const
export type WebDirectiveFeature = typeof WEB_DIRECTIVE_FEATURES[number]
export const ERROR_PAGE_CODES = [400, 401, 403, 404, 500, 502, 503] as const
export interface ErrorPagesModel { entries: { code: number; path: string }[] }
export interface IndexesModel { listing: 'inherit' | 'enabled' | 'disabled' }
export interface MimeTypesModel { entries: { type: string; extensions: string[] }[] }
export interface HotlinkModel { enabled: boolean; allowedHosts: string[]; extensions: string[]; allowEmptyReferrer: boolean; redirectUrl: string | null }
export interface IpBlockerModel { entries: string[] }
export interface RedirectsModel { entries: { status: 301 | 302; path: string; target: string }[] }
export interface WebDirectiveModels { 'error-pages': ErrorPagesModel; indexes: IndexesModel; 'mime-types': MimeTypesModel; hotlink: HotlinkModel; 'ip-blocker': IpBlockerModel; redirects: RedirectsModel }
export interface WebDirectiveContext { domainName: string }
export interface WebDirectiveFieldIssue { field: string; code: string }
export interface WebDirectiveConflict { code: string; line: number }
interface Rec { text: string; eol: string }
export interface ManagedHtaccessDocument {
  records: Rec[]; eol: string; blocks: Map<WebDirectiveFeature, { start: number; end: number }>
  conflict: WebDirectiveConflict | null; unmanagedLines: number; accessRules: number; rewriteDisabled: number
}
export const WEB_DIRECTIVE_LIMITS = { 'error-pages': ERROR_PAGE_CODES.length, 'mime-types': 100, hotlinkHosts: 32, hotlinkExtensions: 32, 'ip-blocker': 500, redirects: 200 } as const

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
// RFC 3986 pchar without pct-encoding, quotes, parentheses or "$" (Apache word and variable syntax).
const PCHAR = '[A-Za-z0-9._~!*+,;=:@-]'
const FILE_PATH = new RegExp(`^(?:/${PCHAR}+)+$`), PREFIX_PATH = new RegExp(`^(?:/|(?:/${PCHAR}+)+/?)$`)
const dotFree = (path: string): boolean => !path.split('/').some(part => part === '.' || part === '..')
// RFC 6838 section 4.2 restricted-name, lower-cased; top-level names from the IANA media type registry.
const MIME = /^([a-z0-9][a-z0-9!#$&^_.+-]{0,126})\/([a-z0-9][a-z0-9!#$&^_.+-]{0,126})$/
const MIME_TOP = new Set(['application', 'audio', 'font', 'image', 'message', 'model', 'multipart', 'text', 'video'])
const EXECUTABLE_TYPE = /(?:x-httpd|cgi|php|perl|python|ruby)/i
const EXECUTABLE_EXTENSION = /^(?:php[0-9]*|phtml|phar|pht|phps|cgi|fcgi|pl|py|rb|sh|shtml|asp|aspx|jsp|htaccess|htpasswd|ini)$/
const LOOPBACK = new BlockList(); LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4'); LOOPBACK.addAddress('::1', 'ipv6')
const MARKER_LIKE = /^\s*#\s*(?:BEGIN|END)\s+xpanel\b/i
const ACCESS_RULE = /^(?:require|order|allow|deny|satisfy|auth[a-z]*)\b/i

function absoluteUrl(value: unknown, rewrite: boolean): string | null {
  const allowed = /^[A-Za-z0-9._~:/?#@!&*+,;=%-]+$/
  if (typeof value !== 'string' || value.length > 2048 || !allowed.test(value)) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  try { validateDomainName(url.hostname) } catch { return null }
  // RewriteRule substitutions expand "%N" and "$N"; mod_alias targets keep only well-formed escapes.
  if (url.href.length > 2048 || !allowed.test(url.href) || (rewrite ? url.href.includes('%') : /%(?![0-9A-Fa-f]{2})/.test(url.href))) return null
  return url.href
}
function address(value: unknown): { canonical: string; protectedRange: boolean } | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const [ip = '', prefix, extra] = value.split('/')
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) && !ip.includes('%') ? 'ipv6' : null
  if (!family || extra !== undefined || prefix !== undefined && (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefix) || Number(prefix) > (family === 'ipv4' ? 32 : 128))) return null
  const range = new BlockList()
  if (prefix === undefined) range.addAddress(ip, family); else range.addSubnet(ip, Number(prefix), family)
  // Apache sees the edge proxy on loopback; a blocked loopback range takes the whole site down.
  const protectedRange = LOOPBACK.check(ip, family) || range.check('127.0.0.1', 'ipv4') || range.check('::1', 'ipv6')
  return { canonical: (family === 'ipv6' ? ip.toLowerCase() : ip) + (prefix === undefined ? '' : '/' + prefix), protectedRange }
}
const extension = (value: unknown, dotted: boolean): string | null => {
  const match = typeof value === 'string' ? (dotted ? /^\.?([A-Za-z0-9][A-Za-z0-9_-]{0,15})$/ : /^\.?([A-Za-z0-9]{1,10})$/).exec(value) : null
  return match ? (dotted ? '.' : '') + match[1]!.toLowerCase() : null
}
const host = (value: unknown): string | null => { try { return validateDomainName(value) } catch { return null } }
const loops = (target: string, path: string, context: WebDirectiveContext): boolean => {
  const url = new URL(target), domain = context.domainName.toLowerCase()
  if (url.hostname !== domain && url.hostname !== 'www.' + domain) return false
  // mod_alias Redirect matches whole leading path segments.
  return path === '/' || url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : path + '/')
}

/** Strict request/body grammar. Field issues name the request position for the form. */
export function parseWebDirectiveModel<F extends WebDirectiveFeature>(feature: F, raw: unknown, context: WebDirectiveContext): WebDirectiveModels[F] {
  const issues: WebDirectiveFieldIssue[] = [], issue = (field: string, code: string): void => { issues.push({ field, code }) }
  const list = (value: unknown, field: string, max: number): unknown[] => {
    if (!Array.isArray(value)) { issue(field, 'type'); return [] }
    if (value.length > max) { issue(field, 'too_many'); return [] }
    return value
  }
  let model: unknown
  if (feature === 'indexes') {
    if (!exact(raw, ['listing']) || !['inherit', 'enabled', 'disabled'].includes(String(raw.listing))) issue('listing', 'listing')
    else model = { listing: raw.listing }
  } else if (feature === 'hotlink') {
    if (!exact(raw, ['enabled', 'allowedHosts', 'extensions', 'allowEmptyReferrer', 'redirectUrl'])) issue('model', 'type')
    else {
      if (typeof raw.enabled !== 'boolean') issue('enabled', 'type')
      if (typeof raw.allowEmptyReferrer !== 'boolean') issue('allowEmptyReferrer', 'type')
      const hosts: string[] = [], extensions: string[] = []
      list(raw.allowedHosts, 'allowedHosts', WEB_DIRECTIVE_LIMITS.hotlinkHosts).forEach((value, index) => {
        const name = host(value)
        if (!name) issue('allowedHosts.' + index, 'host'); else if (hosts.includes(name)) issue('allowedHosts.' + index, 'duplicate'); else hosts.push(name)
      })
      list(raw.extensions, 'extensions', WEB_DIRECTIVE_LIMITS.hotlinkExtensions).forEach((value, index) => {
        const name = extension(value, false)
        if (!name) issue('extensions.' + index, 'extension'); else if (extensions.includes(name)) issue('extensions.' + index, 'duplicate'); else extensions.push(name)
      })
      if (raw.enabled === true && Array.isArray(raw.allowedHosts) && !raw.allowedHosts.length) issue('allowedHosts', 'required')
      if (raw.enabled === true && Array.isArray(raw.extensions) && !raw.extensions.length) issue('extensions', 'required')
      const redirectUrl = raw.redirectUrl === null ? null : absoluteUrl(raw.redirectUrl, true)
      if (raw.redirectUrl !== null && !redirectUrl) issue('redirectUrl', 'url')
      // The browser fetches the redirect as the same embedded resource; a protected target loops.
      else if (redirectUrl && extensions.some(name => new URL(redirectUrl).pathname.toLowerCase().endsWith('.' + name))) issue('redirectUrl', 'redirect_loop')
      model = { enabled: raw.enabled, allowedHosts: hosts, extensions, allowEmptyReferrer: raw.allowEmptyReferrer, redirectUrl }
    }
  } else if (!exact(raw, ['entries'])) issue('model', 'type')
  else if (feature === 'error-pages') {
    const entries: ErrorPagesModel['entries'] = []
    list(raw.entries, 'entries', WEB_DIRECTIVE_LIMITS['error-pages']).forEach((entry, index) => {
      const at = 'entries.' + index
      if (!exact(entry, ['code', 'path'])) { issue(at, 'type'); return }
      const code = ERROR_PAGE_CODES.find(value => value === entry.code), path = typeof entry.path === 'string' && entry.path.length <= 512 && FILE_PATH.test(entry.path) && dotFree(entry.path) ? entry.path : null
      if (!code) issue(at + '.code', 'code'); else if (entries.some(item => item.code === code)) issue(at + '.code', 'duplicate')
      if (!path) issue(at + '.path', 'path')
      if (code && path) entries.push({ code, path })
    })
    model = { entries: entries.sort((left, right) => left.code - right.code) }
  } else if (feature === 'mime-types') {
    const entries: MimeTypesModel['entries'] = [], seen: string[] = []
    list(raw.entries, 'entries', WEB_DIRECTIVE_LIMITS['mime-types']).forEach((entry, index) => {
      const at = 'entries.' + index
      if (!exact(entry, ['type', 'extensions'])) { issue(at, 'type'); return }
      const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : '', match = MIME.exec(type)
      let valid = true
      if (!match || !MIME_TOP.has(match[1]!)) { issue(at + '.type', 'mime_type'); valid = false }
      else if (EXECUTABLE_TYPE.test(type)) { issue(at + '.type', 'executable_type'); valid = false }
      else if (entries.some(item => item.type === type)) { issue(at + '.type', 'duplicate'); valid = false }
      const extensions: string[] = []
      const values = list(entry.extensions, at + '.extensions', 16)
      if (Array.isArray(entry.extensions) && !entry.extensions.length) { issue(at + '.extensions', 'required'); valid = false }
      values.forEach((value, position) => {
        const name = extension(value, true), field = at + '.extensions.' + position
        if (!name) { issue(field, 'extension'); valid = false }
        else if (EXECUTABLE_EXTENSION.test(name.slice(1))) { issue(field, 'executable_extension'); valid = false }
        else if (seen.includes(name) || extensions.includes(name)) { issue(field, 'duplicate'); valid = false }
        else extensions.push(name)
      })
      if (valid) { entries.push({ type, extensions }); seen.push(...extensions) }
    })
    model = { entries }
  } else if (feature === 'ip-blocker') {
    const entries: string[] = []
    list(raw.entries, 'entries', WEB_DIRECTIVE_LIMITS['ip-blocker']).forEach((value, index) => {
      const parsed = address(value)
      if (!parsed) issue('entries.' + index, 'address'); else if (parsed.protectedRange) issue('entries.' + index, 'protected_address')
      else if (entries.includes(parsed.canonical)) issue('entries.' + index, 'duplicate'); else entries.push(parsed.canonical)
    })
    model = { entries }
  } else {
    const entries: RedirectsModel['entries'] = []
    list(raw.entries, 'entries', WEB_DIRECTIVE_LIMITS.redirects).forEach((entry, index) => {
      const at = 'entries.' + index
      if (!exact(entry, ['status', 'path', 'target'])) { issue(at, 'type'); return }
      const status = entry.status === 301 || entry.status === 302 ? entry.status : null
      const path = typeof entry.path === 'string' && entry.path.length <= 512 && PREFIX_PATH.test(entry.path) && dotFree(entry.path) ? entry.path : null
      const target = absoluteUrl(entry.target, false)
      if (!status) issue(at + '.status', 'status')
      if (!path) issue(at + '.path', 'path'); else if (entries.some(item => item.path === path)) issue(at + '.path', 'duplicate')
      if (!target) issue(at + '.target', 'url'); else if (path && loops(target, path, context)) issue(at + '.target', 'redirect_loop')
      if (status && path && target) entries.push({ status, path, target })
    })
    // Longest path first: an earlier shorter prefix would otherwise shadow a more specific redirect.
    model = { entries: entries.sort((left, right) => right.path.length - left.path.length || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) }
  }
  if (issues.length) return fail('VALIDATION', 'web directive fields are invalid', { stateChanged: false, fields: issues.slice(0, 100) })
  return model as WebDirectiveModels[F]
}

export function defaultWebDirectiveModel<F extends WebDirectiveFeature>(feature: F, context: WebDirectiveContext): WebDirectiveModels[F] {
  const domain = context.domainName.toLowerCase()
  const models: WebDirectiveModels = { 'error-pages': { entries: [] }, indexes: { listing: 'inherit' }, 'mime-types': { entries: [] }, 'ip-blocker': { entries: [] }, redirects: { entries: [] },
    hotlink: { enabled: false, allowedHosts: domain.startsWith('www.') ? [domain] : [domain, 'www.' + domain], extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'], allowEmptyReferrer: true, redirectUrl: null } }
  return models[feature]
}

/** Canonical body lines; an empty result removes the block. */
export function renderWebDirectiveBody<F extends WebDirectiveFeature>(feature: F, value: WebDirectiveModels[F]): string[] {
  const model = value as WebDirectiveModels[WebDirectiveFeature]
  if (feature === 'error-pages') return (model as ErrorPagesModel).entries.map(entry => `ErrorDocument ${entry.code} ${entry.path}`)
  if (feature === 'indexes') { const listing = (model as IndexesModel).listing; return listing === 'inherit' ? [] : [listing === 'enabled' ? 'Options +Indexes' : 'Options -Indexes'] }
  if (feature === 'mime-types') return (model as MimeTypesModel).entries.map(entry => `AddType ${entry.type} ${entry.extensions.join(' ')}`)
  if (feature === 'ip-blocker') { const entries = (model as IpBlockerModel).entries; return entries.length ? ['<RequireAll>', 'Require all granted', ...entries.map(entry => 'Require not ip ' + entry), '</RequireAll>'] : [] }
  if (feature === 'redirects') return (model as RedirectsModel).entries.map(entry => `Redirect ${entry.status} ${entry.path} ${entry.target}`)
  const hotlink = model as HotlinkModel
  if (!hotlink.enabled) return []
  return ['RewriteEngine On', ...(hotlink.allowEmptyReferrer ? ['RewriteCond %{HTTP_REFERER} !^$'] : []),
    ...hotlink.allowedHosts.map(name => `RewriteCond %{HTTP_REFERER} !^https?://${name.replace(/\./g, '\\.')}(?::[0-9]+)?(?:/|$) [NC]`),
    `RewriteRule \\.(?:${hotlink.extensions.join('|')})$ ${hotlink.redirectUrl ?? '-'} [${hotlink.redirectUrl ? 'R=302,NC,L' : 'F,NC'}]`]
}
function bodyToRaw(feature: WebDirectiveFeature, lines: string[]): unknown {
  const all = <T>(pattern: RegExp, map: (match: RegExpExecArray) => T): T[] | null => { const out: T[] = []; for (const line of lines) { const match = pattern.exec(line); if (!match) return null; out.push(map(match)) } return out }
  if (feature === 'error-pages') { const entries = all(/^ErrorDocument ([0-9]{3}) (\S+)$/, match => ({ code: Number(match[1]), path: match[2] })); return entries && { entries } }
  if (feature === 'indexes') return lines.length === 1 && /^Options [+-]Indexes$/.test(lines[0]!) ? { listing: lines[0]![8] === '+' ? 'enabled' : 'disabled' } : null
  if (feature === 'mime-types') { const entries = all(/^AddType (\S+) (\S+(?: \S+)*)$/, match => ({ type: match[1], extensions: match[2]!.split(' ') })); return entries && { entries } }
  if (feature === 'redirects') { const entries = all(/^Redirect (301|302) (\S+) (\S+)$/, match => ({ status: Number(match[1]), path: match[2], target: match[3] })); return entries && { entries } }
  // The canonical re-render below proves the RequireAll wrapper lines.
  if (feature === 'ip-blocker') { const inner = lines.slice(2, -1).map(line => /^Require not ip (\S+)$/.exec(line)?.[1]); return lines.length > 3 && inner.every(Boolean) ? { entries: inner } : null }
  const rule = /^RewriteRule \\\.\(\?:([a-z0-9|]+)\)\$ (\S+) \[(?:F,NC|R=302,NC,L)\]$/.exec(lines.at(-1) ?? '')
  if (!rule) return null
  const hosts = lines.flatMap(line => { const match = /^RewriteCond %\{HTTP_REFERER\} !\^https\?:\/\/(\S+?)\(\?::\[0-9\]\+\)\?\(\?:\/\|\$\) \[NC\]$/.exec(line); return match ? [match[1]!.replace(/\\\./g, '.')] : [] })
  return { enabled: true, allowedHosts: hosts, extensions: rule[1]!.split('|'), allowEmptyReferrer: lines.includes('RewriteCond %{HTTP_REFERER} !^$'), redirectUrl: rule[2] === '-' ? null : rule[2] }
}

/** Splits records exactly like the PHP migration planner; markers must be exact and top level. */
export function parseManagedHtaccess(content: string): ManagedHtaccessDocument {
  const records = [...content.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(match => match[0] !== '').map(match => ({ text: match[1]!, eol: match[2]! }))
  const blocks = new Map<WebDirectiveFeature, { start: number; end: number }>(), stack: string[] = []
  let open: { feature: WebDirectiveFeature; start: number } | null = null, conflict: WebDirectiveConflict | null = null, unmanagedLines = 0, accessRules = 0, rewriteDisabled = 0
  for (let index = 0; index < records.length && !conflict; index++) {
    const text = records[index]!.text, line = index + 1, continued = index > 0 && records[index - 1]!.text.endsWith('\\')
    const marker = /^# (BEGIN|END) xPanel ([a-z-]+)$/.exec(text), feature = WEB_DIRECTIVE_FEATURES.find(name => name === marker?.[2])
    if (MARKER_LIKE.test(text) && !feature) conflict = { code: 'marker_malformed', line }
    else if (marker?.[1] === 'BEGIN' && feature) {
      if (open) conflict = { code: 'marker_nested', line }
      else if (blocks.has(feature)) conflict = { code: 'marker_duplicate', line }
      else if (stack.length || continued) conflict = { code: 'marker_scope', line }
      else open = { feature, start: index }
    } else if (marker && feature) {
      if (!open || open.feature !== feature) conflict = { code: 'marker_unbalanced', line }
      else if (continued) conflict = { code: 'marker_scope', line }
      else { blocks.set(feature, { start: open.start, end: index }); open = null }
    } else if (!open) {
      const trimmed = text.trim()
      if (trimmed) unmanagedLines++
      if (/^<\//.test(trimmed)) stack.pop(); else if (/^<[A-Za-z]/.test(trimmed)) stack.push(/^<([A-Za-z]+)/.exec(trimmed)![1]!.toLowerCase())
      // Files sections merge after the directory; same-level access rules combine with ours as RequireAny.
      if (!accessRules && ACCESS_RULE.test(trimmed) && !stack.some(kind => kind === 'files' || kind === 'filesmatch')) accessRules = line
      if (!rewriteDisabled && /^rewriteengine\s+off\b/i.test(trimmed)) rewriteDisabled = line
    }
  }
  if (!conflict && open) conflict = { code: 'marker_unbalanced', line: open.start + 1 }
  return { records, eol: /\r\n|\r|\n/.exec(content)?.[0] ?? '\n', blocks, conflict, unmanagedLines, accessRules, rewriteDisabled }
}

export function readWebDirective<F extends WebDirectiveFeature>(document: ManagedHtaccessDocument, feature: F, context: WebDirectiveContext): { model: WebDirectiveModels[F]; managed: boolean; conflict: WebDirectiveConflict | null } {
  const empty = defaultWebDirectiveModel(feature, context), block = document.conflict ? undefined : document.blocks.get(feature)
  const environment = document.conflict ?? (feature === 'ip-blocker' && document.accessRules ? { code: 'access_rules_present', line: document.accessRules } : feature === 'hotlink' && document.rewriteDisabled ? { code: 'rewrite_disabled', line: document.rewriteDisabled } : null)
  if (!block) return { model: empty, managed: false, conflict: environment }
  const lines = document.records.slice(block.start + 1, block.end).map(record => record.text)
  try {
    const model = parseWebDirectiveModel(feature, bodyToRaw(feature, lines), context), rendered = renderWebDirectiveBody(feature, model)
    if (lines.length && rendered.length === lines.length && rendered.every((line, index) => line === lines[index])) return { model, managed: true, conflict: environment }
  } catch { /* A hand-edited block is reported, never reinterpreted. */ }
  return { model: empty, managed: true, conflict: { code: 'block_modified', line: block.start + 1 } }
}

/** Replaces, inserts (top of file) or removes one block; all unmanaged bytes and line endings are preserved. */
export function mergeWebDirective<F extends WebDirectiveFeature>(content: string, feature: F, model: WebDirectiveModels[F], context: WebDirectiveContext): string {
  const document = parseManagedHtaccess(content), current = readWebDirective(document, feature, context)
  if (current.conflict) return fail('CONFLICT', 'the managed .htaccess block requires review', { stateChanged: false, conflict: current.conflict })
  const body = renderWebDirectiveBody(feature, model), block = document.blocks.get(feature)
  const lines = body.length ? ['# BEGIN xPanel ' + feature, ...body, '# END xPanel ' + feature] : []
  const join = (records: Rec[]): string => records.map(record => record.text + record.eol).join('')
  if (block) return join(document.records.slice(0, block.start)) + (lines.length ? lines.join(document.eol) + document.records[block.end]!.eol : '') + join(document.records.slice(block.end + 1))
  return lines.length ? lines.join(document.eol) + document.eol + content : content
}

const POLICY_SAMPLES: WebDirectiveModels = { 'error-pages': { entries: [{ code: 404, path: '/404.html' }] }, indexes: { listing: 'disabled' }, 'mime-types': { entries: [{ type: 'text/markdown', extensions: ['.md'] }] },
  hotlink: { enabled: true, allowedHosts: ['example.com'], extensions: ['png'], allowEmptyReferrer: true, redirectUrl: 'https://example.com/' }, 'ip-blocker': { entries: ['192.0.2.1'] }, redirects: { entries: [{ status: 301, path: '/a', target: 'https://example.com/' }] } }
/** The reviewed account policy decides availability; a feature it refuses is never offered as saveable. */
export const webDirectivePolicyAllows = (feature: WebDirectiveFeature): boolean => inspectHtaccess(['# BEGIN xPanel ' + feature, ...renderWebDirectiveBody(feature, POLICY_SAMPLES[feature]), '# END xPanel ' + feature, ''].join('\n')).valid
