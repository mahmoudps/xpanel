import { assertProxyOptions, MANAGEMENT_BACKEND_PORTS, MANAGEMENT_PUBLIC_PORTS } from '@xpanel/core'
import type { ProxyOptions, ServerSettings } from '@xpanel/core'
import { block, extras } from './nginx-syntax.ts'
import { assertBackendPort, formatCidr, parseCidr, parseUpstream } from './validate.ts'

/** One reverse proxy rule of a site, saved by the server administrator (NGINX Reverse Proxy Manager). */
export interface ProxyRule {
  /** '/' replaces the site; any other path keeps the rest of the site on its backend */
  path: string
  /** http(s)://host[:port] without a path: the upstream receives the request path unchanged */
  target: string
  options: ProxyOptions
}

export type ProxyRuleRefusal = 'invalid' | 'loopback' | 'forbidden_range' | 'panel_port' | 'resolver_unavailable'
export const PROXY_RULE_PATH = /^\/(?:[a-z0-9][a-z0-9._-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,62}){0,3})?$/

/** Resolver addresses for the nginx directive; a block or an unreadable entry would fail the configuration test of every site. */
const usableResolvers = (settings: ServerSettings): string[] => {
  try { const list = (extras(settings).resolvers ?? []).map(entry => formatCidr(parseCidr(entry, 'resolver'))); return list.some(entry => entry.includes('/')) ? [] : list } catch { return [] }
}
const panelPorts = (settings: ServerSettings): number[] => [settings.panelPort, assertBackendPort(settings), settings.backendTlsPort, ...MANAGEMENT_PUBLIC_PORTS, ...MANAGEMENT_BACKEND_PORTS]

/**
 * Why a target may not be proxied, or null. Unlike an owner's application upstream, a rule never reaches this server:
 * loopback would publish a local service, and a panel port is refused on every host because the server's own public
 * address is also a host. A named target needs a resolver, since nginx resolves it per request.
 */
export const proxyRuleRefusal = (target: unknown, settings: ServerSettings): ProxyRuleRefusal | null => {
  let upstream: ReturnType<typeof parseUpstream>
  try { upstream = parseUpstream(target, 'proxy rule target') } catch { return 'invalid' }
  if (upstream.path) return 'invalid'
  if (upstream.addressClass === 'loopback') return 'loopback'
  if (upstream.addressClass === 'forbidden') return 'forbidden_range'
  if (panelPorts(settings).includes(upstream.port)) return 'panel_port'
  return upstream.hostKind === 'name' && !usableResolvers(settings).length ? 'resolver_unavailable' : null
}

interface Locations { paths: string[]; root: string[] | null }
export interface ProxyRuleTarget { url: string; tls: boolean; options: ProxyOptions; pre?: string[] }

const ruleTarget = (rule: ProxyRule, settings: ServerSettings): ProxyRuleTarget => {
  const upstream = parseUpstream(rule.target, 'proxy rule target'), options = assertProxyOptions(rule.options), tls = upstream.scheme === 'https'
  if (upstream.hostKind === 'ip') return { url: upstream.url, tls, options }
  return { url: upstream.url + '$request_uri', tls, options, pre: [`resolver ${usableResolvers(settings).map(entry => entry.includes(':') ? `[${entry}]` : entry).join(' ')} valid=300s;`, 'resolver_timeout 5s;'] }
}

/**
 * Adds a site's rules to its application locations. A rule the server no longer admits, or a path something else
 * already answers, is left out with a comment: a duplicate location would fail the configuration test of every site.
 */
export const withProxyRules = (apps: Locations, served: readonly string[], rules: readonly ProxyRule[] | undefined, settings: ServerSettings, locate: (target: ProxyRuleTarget, at: string) => string[]): Locations => {
  const taken = new Set([...served, ...apps.paths].map(line => line.trim()))
  let root = apps.root
  const paths = [...apps.paths]
  for (const rule of rules ?? []) {
    const refusal = PROXY_RULE_PATH.test(rule.path) ? proxyRuleRefusal(rule.target, settings) : 'invalid'
    const heads = [`location = ${rule.path} {`, `location ^~ ${rule.path}/ {`]
    if (refusal || (rule.path === '/' ? root : heads.some(head => taken.has(head)))) { paths.push(`# proxy rule skipped: ${PROXY_RULE_PATH.test(rule.path) ? rule.path : 'invalid path'} (${refusal ?? 'path already served'})`); continue }
    if (rule.path === '/') root = locate(ruleTarget(rule, settings), '/')
    else paths.push(...block(`location = ${rule.path}`, [`return 308 ${rule.path}/$is_args$args;`]), ...locate(ruleTarget(rule, settings), rule.path))
  }
  return { paths, root }
}
