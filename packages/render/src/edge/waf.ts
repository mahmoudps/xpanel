// xPanel's own Nginx WAF: rate and connection limits, IP/CIDR, path and user-agent deny lists,
// body size limit. ModSecurity + OWASP CRS is wired in only when it is installed.
import { createHash } from 'node:crypto'
import type { Limit, RenderedFile } from '@xpanel/core'
import { XP_PATHS } from './paths.ts'
import { nginxRegexQuote } from './quote.ts'
import {
  assertIncludeGlob,
  assertInt,
  assertRegex,
  assertSafeAbsPath,
  formatCidr,
  invalid,
  parseCidr,
} from './validate.ts'

export interface WafLists {
  /** IP or CIDR, v4 or v6 */
  denyIps?: string[]
  /** PCRE matched against the normalized, decoded URI ($uri), case-sensitive */
  denyPaths?: string[]
  /** PCRE matched against User-Agent, case-insensitive */
  denyUserAgents?: string[]
}

export interface WafGlobalPolicy extends WafLists {
  /** exempt from every rate and connection limit (monitoring, office IPs) */
  trustedIps?: string[]
  /** answer for denied requests: 403, or 444 (nginx closes the connection without a response) */
  denyStatus?: 403 | 444
}

export interface WafRateLimit {
  requests: number
  per: 'second' | 'minute'
  burst: number
  /** serve the burst immediately instead of pacing it (default true) */
  nodelay?: boolean
}

export interface WafSitePolicy extends WafLists {
  /** default true; when false only the server-wide lists apply */
  enabled?: boolean
  rateLimit?: WafRateLimit | null
  /** concurrent connections per client IP */
  connLimit?: number | null
  /** request body cap in MB; 'unlimited' is explicit */
  maxBodyMb?: Limit | null
  /** per-site ModSecurity switch, honoured only when ModSecurity is present */
  modsecurity?: boolean
}

/** ModSecurity v3 + nginx connector, present only when the reconciler found it installed. */
export interface ModsecuritySettings {
  /** engine config, e.g. the distribution's modsecurity.conf */
  engineConf: string
  /** OWASP CRS directory containing crs-setup.conf and rules/ */
  crsDir: string | null
}

const MAX_LIST = 5000

const list = <T>(what: string, v: T[] | undefined, each: (x: unknown) => T): T[] => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) return invalid(what, v, 'must be an array')
  if (v.length > MAX_LIST) return invalid(what, v.length, `more than ${MAX_LIST} entries`)
  return v.map(each)
}

const cidrs = (what: string, v: string[] | undefined): string[] =>
  [...new Set(list(what, v, (x) => formatCidr(parseCidr(x, what))))]

const regexes = (what: string, v: string[] | undefined): string[] => [...new Set(list(what, v, (x) => assertRegex(x, what)))]

const block = (head: string, entries: string[]): string[] => [`${head} {`, ...entries.map((e) => `    ${e}`), '}']

/** http{} level: always defines the variables site snippets reference, even when lists are empty. */
export const renderWafHttp = (policy?: WafGlobalPolicy | null, modsec?: ModsecuritySettings | null): string => {
  const p = policy ?? {}
  const trusted = cidrs('trusted IP', p.trustedIps)
  const ips = cidrs('denied IP', p.denyIps)
  const uas = regexes('denied user agent', p.denyUserAgents)
  const paths = regexes('denied path', p.denyPaths)
  const lines = [
    '# xPanel WAF: server-wide lists',
    'limit_req_status 429;',
    'limit_conn_status 429;',
    ...block('geo $xpanel_waf_trusted', ['default 0;', ...trusted.map((ip) => `${ip} 1;`)]),
    ...block('map $xpanel_waf_trusted $xpanel_waf_key', ['1 "";', 'default $binary_remote_addr;']),
    ...block('geo $xpanel_waf_deny_ip', ['default 0;', ...ips.map((ip) => `${ip} 1;`)]),
    ...block('map $http_user_agent $xpanel_waf_deny_ua', [
      'default 0;',
      ...uas.map((r) => `${nginxRegexQuote(`~*${r}`)} 1;`),
    ]),
    ...block('map $uri $xpanel_waf_deny_path', ['default 0;', ...paths.map((r) => `${nginxRegexQuote(`~${r}`)} 1;`)]),
  ]
  if (modsec) {
    assertModsec(modsec)
    lines.push('modsecurity on;', `modsecurity_rules_file ${modsecMainPath};`)
  }
  return `${lines.join('\n')}\n`
}

export const modsecMainPath = `${XP_PATHS.modsecDir}/main.conf`

const assertModsec = (m: ModsecuritySettings): ModsecuritySettings => {
  if (!m || typeof m !== 'object') return invalid('modsecurity', m, 'must be an object')
  assertSafeAbsPath(m.engineConf, 'ModSecurity engine config')
  if (m.crsDir !== null) assertSafeAbsPath(m.crsDir, 'OWASP CRS directory')
  return m
}

/** The rules file nginx loads: engine config, then OWASP CRS when present. */
export const renderModsecurityMain = (modsec: ModsecuritySettings): RenderedFile => {
  const m = assertModsec(modsec)
  const lines = ['# Managed by xPanel: ModSecurity rules for Nginx', `Include ${m.engineConf}`]
  if (m.crsDir) {
    lines.push(`Include ${assertIncludeGlob(`${m.crsDir}/crs-setup.conf`)}`, `Include ${assertIncludeGlob(`${m.crsDir}/rules/*.conf`)}`)
  }
  return { path: modsecMainPath, content: `${lines.join('\n')}\n`, mode: 0o644, owner: 'root', group: 'root' }
}

/** Stable short id for per-site zone names. */
export const siteZoneId = (siteName: string): string => createHash('sha256').update(siteName).digest('hex').slice(0, 12)

export interface WafSiteRender {
  /** http{} level lines (zones), placed before the server blocks */
  http: string[]
  /** server{} level lines */
  server: string[]
}

export interface WafSiteContext {
  defaultBodyMb: Limit
  modsecurityPresent: boolean
  denyStatus?: 403 | 444
}

const bodySize = (mb: Limit): string => {
  if (mb === 'unlimited') return '0'
  return `${assertInt('client_max_body_size (MB)', mb, 1, 102400)}m`
}

export const renderWafSite = (siteName: string, policy: WafSitePolicy | null | undefined, ctx: WafSiteContext): WafSiteRender => {
  const p = policy ?? {}
  const status = ctx.denyStatus ?? 403
  if (status !== 403 && status !== 444) invalid('denied response', status, 'must be 403 or 444')
  const server = [
    `if ($xpanel_waf_deny_ip) { return ${status}; }`,
    `if ($xpanel_waf_deny_ua) { return ${status}; }`,
    `if ($xpanel_waf_deny_path) { return ${status}; }`,
  ]
  const http: string[] = []
  const enabled = p.enabled !== false
  const body = enabled && p.maxBodyMb !== undefined && p.maxBodyMb !== null ? p.maxBodyMb : ctx.defaultBodyMb
  if (enabled) {
    const id = siteZoneId(siteName)
    for (const ip of cidrs('denied IP', p.denyIps)) server.push(`deny ${ip};`)
    for (const r of regexes('denied user agent', p.denyUserAgents)) {
      server.push(`if ($http_user_agent ~* ${nginxRegexQuote(r)}) { return ${status}; }`)
    }
    for (const r of regexes('denied path', p.denyPaths)) server.push(`if ($uri ~ ${nginxRegexQuote(r)}) { return ${status}; }`)
    if (p.rateLimit) {
      const rl = p.rateLimit
      const n = assertInt('rate limit', rl.requests, 1, 100000)
      if (rl.per !== 'second' && rl.per !== 'minute') invalid('rate limit period', rl.per, 'must be second or minute')
      const burst = assertInt('rate limit burst', rl.burst, 0, 100000)
      http.push(`limit_req_zone $xpanel_waf_key zone=xpw_r_${id}:1m rate=${n}r/${rl.per === 'second' ? 's' : 'm'};`)
      server.push(`limit_req zone=xpw_r_${id} burst=${burst}${rl.nodelay === false ? '' : ' nodelay'};`)
    }
    if (p.connLimit !== undefined && p.connLimit !== null) {
      const c = assertInt('connection limit', p.connLimit, 1, 100000)
      http.push(`limit_conn_zone $xpanel_waf_key zone=xpw_c_${id}:1m;`)
      server.push(`limit_conn xpw_c_${id} ${c};`)
    }
  }
  server.push(`client_max_body_size ${bodySize(body)};`)
  if (ctx.modsecurityPresent && p.modsecurity === false) server.push('modsecurity off;')
  return { http, server }
}
