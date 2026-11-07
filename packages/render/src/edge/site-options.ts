// Edge rendering of the per-site settings: deny rules, traffic limits, visitor logging and the stopped page.
// Nginx fronts every engine, so these hold for Apache and OpenLiteSpeed sites alike.
import { createHash } from 'node:crypto'
import { assertSiteOptions, servedDocRoot } from '@xpanel/core'
import type { Account, Domain, SiteDenyRule } from '@xpanel/core'
import { block } from './nginx-syntax.ts'
import { nginxQuote, nginxRegexQuote } from './quote.ts'
import { siteZoneId } from './waf.ts'

export interface SiteEdgeRender {
  /** http{} level lines (zones), placed before the server blocks */
  http: string[]
  /** server{} level lines */
  server: string[]
  /** the log_format of the site's access log */
  logFormat: 'xpanel_metrics' | 'xpanel_usage'
}

const regexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// `/` after the extension closes PATH_INFO: /uploads/x.php/y.jpg still runs x.php.
const denyLine = (rule: SiteDenyRule): string =>
  `if ($uri ~* ${nginxRegexQuote(`^${rule.directory === '/' ? '' : regexLiteral(rule.directory)}/(?:.*/)?[^/]*\\.(?:${rule.extensions.join('|')})(?:/|$)`)}) { return 403; }`

/** `serving` is false while the stopped page answers: limits and rules then have nothing to guard. */
export const renderSiteEdge = (domain: Domain, serving: boolean): SiteEdgeRender => {
  const settled = [domain.expiresAt, domain.pathQuotaMb === 'unlimited' ? null : domain.pathQuotaMb, domain.site ?? null]
  const site = assertSiteOptions(domain.site ?? {})
  // Settings without a line of their own still change the file, so each save passes the config test and applies.
  const http: string[] = settled.some(item => item !== null) ? [`# site settings ${createHash('sha256').update(JSON.stringify(settled)).digest('hex').slice(0, 16)}`] : []
  const server: string[] = []
  const limits = site.traffic
  if (serving) {
    server.push(...(site.denyRules ?? []).map(denyLine))
    if (limits) {
      const id = siteZoneId(domain.name)
      server.push('limit_conn_status 503;')
      if (limits.siteConnections !== null) {
        // The zone holds one site, so a constant key counts all of its connections.
        http.push(`limit_conn_zone $hostname zone=xps_s_${id}:1m;`)
        server.push(`limit_conn xps_s_${id} ${limits.siteConnections};`)
      }
      if (limits.ipConnections !== null) {
        http.push(`limit_conn_zone $xpanel_waf_key zone=xps_i_${id}:1m;`)
        server.push(`limit_conn xps_i_${id} ${limits.ipConnections};`)
      }
      if (limits.rateKbPerConnection !== null) server.push(`limit_rate ${limits.rateKbPerConnection}k;`)
    }
  }
  return { http, server, logFormat: site.visitorLogOff ? 'xpanel_usage' : 'xpanel_metrics' }
}

const pageText = (text: string): string => text.replace(/[&<>"'$]/g, char => `&#${char.charCodeAt(0)};`)

/** The owner's message replaces the stopped page; an account suspension keeps the administrator's page. */
export const siteStoppedLocations = (account: Pick<Account, 'status'>, domain: Domain): string[] | null => {
  const message = domain.site?.stoppedMessage
  if (message === undefined || account.status !== 'active') return null
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>This website is stopped</title></head><body><h1>This website is stopped</h1><p dir="auto">${pageText(message)}</p></body></html>`
  return block('location /', ['default_type text/html;', 'add_header Cache-Control "no-store" always;', 'add_header Retry-After 3600 always;', `return 503 ${nginxQuote(page, 'stopped page')};`])
}

/** Inside the account's PHP confinement: this site's tree and the account tmp, which .user.ini may set because it only narrows. */
export const siteOpenBasedir = (account: Pick<Account, 'home'>, domain: Pick<Domain, 'docRoot'>): string => `${domain.docRoot}:${account.home}/tmp`

/** What the web server serves for each site; the renderers read the served directory as the document root. */
export const servedDomains = (domains: readonly Domain[]): Domain[] => domains.map(domain => ({ ...domain, docRoot: servedDocRoot(domain) }))
