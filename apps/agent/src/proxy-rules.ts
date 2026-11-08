import { assertProxyOptions, fail, validateDomainName } from '@xpanel/core'
import { edge } from '@xpanel/render'

/**
 * Reverse proxy rules one account's sites carry at the nginx edge, saved by the server administrator
 * (NGINX Reverse Proxy Manager). One file per account under the state root; the reconciler renders them into the
 * account's nginx sites, so the generation's nginx configuration test runs before any reload.
 */
export const PROXY_RULES_STATE_DIR = 'extended/edge/proxy-rules'
export const PROXY_RULES_MAX = 64

export interface ProxyRuleEntry extends edge.ProxyRule { domain: string }
export interface ProxyRulesRecord { version: 1; rules: ProxyRuleEntry[]; updatedAt: string }
export const proxyRulesPath = (accountId: string): string => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId)
  ? PROXY_RULES_STATE_DIR + '/' + accountId + '.json' : fail('VALIDATION', 'account id is invalid')

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const validEntry = (value: unknown): value is ProxyRuleEntry => {
  if (!object(value) || !exact(value, ['domain', 'path', 'target', 'options']) || typeof value.path !== 'string' || !edge.PROXY_RULE_PATH.test(value.path)) return false
  try { validateDomainName(value.domain); assertProxyOptions(value.options); return edge.parseUpstream(value.target, 'proxy rule target').path === '' } catch { return false }
}
/** Null for anything but a canonical record; a saved rule is checked against the server's ports when it is rendered. */
export function readProxyRulesRecord(raw: unknown): ProxyRulesRecord | null {
  if (!object(raw) || !exact(raw, ['version', 'rules', 'updatedAt']) || raw.version !== 1 || typeof raw.updatedAt !== 'string' || raw.updatedAt.length > 40 || !Number.isFinite(Date.parse(raw.updatedAt))
    || !Array.isArray(raw.rules) || raw.rules.length > PROXY_RULES_MAX || !raw.rules.every(validEntry)) return null
  const rules = raw.rules as ProxyRuleEntry[]
  return new Set(rules.map(rule => rule.domain + ' ' + rule.path)).size === rules.length ? { version: 1, rules, updatedAt: raw.updatedAt } : null
}
// shortcut: a removed domain's rules stay in the file and render nowhere; prune them if a removal hook ever reaches this state.
export const proxyRulesByDomain = (record: ProxyRulesRecord): Record<string, edge.ProxyRule[]> => {
  const out: Record<string, edge.ProxyRule[]> = {}
  for (const { domain, ...rule } of record.rules) (out[domain] ??= []).push(rule)
  return out
}
