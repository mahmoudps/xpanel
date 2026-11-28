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

export const PROXY_PROJECTS_STATE_DIR = 'extended/edge/proxy-projects'
export const PROXY_PROJECTS_MAX = 32
export const PROXY_PROJECT_RULES_MAX = 32
const PROXY_PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROXY_PROJECT_CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export interface ProxyProjectRule {
  id: string
  path: string
  target: string
  websocket: boolean
  hostHeader: 'client' | 'upstream'
  headers: { name: string; value: string }[]
}

export interface ProxyProjectRecord {
  id: string
  accountId: string
  name: string
  domains: string[]
  note: string
  ssl: { enabled: boolean; certificateId: string | null }
  cache: boolean
  gzip: boolean
  rules: ProxyProjectRule[]
  createdAt: string
  updatedAt: string
}

export interface ProxyProjectsFileRecord {
  rulesVersion: 1
  projects: ProxyProjectRecord[]
  updatedAt: string
}

export const proxyProjectsPath = (accountId: string): string =>
  PROXY_PROJECT_UUID.test(accountId) ? `${PROXY_PROJECTS_STATE_DIR}/${accountId}.json` : fail('VALIDATION', 'account id is invalid', { stateChanged: false })

export function readProxyProjectsRecord(raw: unknown): ProxyProjectsFileRecord | null {
  if (!object(raw) || raw.rulesVersion !== 1 || !Array.isArray(raw.projects) || raw.projects.length > PROXY_PROJECTS_MAX
    || typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt))) return null
  for (const project of raw.projects) {
    if (!object(project) || typeof project.id !== 'string' || !PROXY_PROJECT_UUID.test(project.id)
      || typeof project.accountId !== 'string' || !PROXY_PROJECT_UUID.test(project.accountId)
      || typeof project.name !== 'string' || project.name.length < 1 || project.name.length > 64 || PROXY_PROJECT_CONTROL_CHARS.test(project.name)
      || !Array.isArray(project.domains) || project.domains.length < 1 || project.domains.length > 16
      || typeof project.note !== 'string' || project.note.length > 256 || PROXY_PROJECT_CONTROL_CHARS.test(project.note)
      || !object(project.ssl) || typeof project.ssl.enabled !== 'boolean' || !(project.ssl.certificateId === null || typeof project.ssl.certificateId === 'string')
      || typeof project.cache !== 'boolean' || typeof project.gzip !== 'boolean'
      || !Array.isArray(project.rules) || project.rules.length < 1 || project.rules.length > PROXY_PROJECT_RULES_MAX
      || typeof project.createdAt !== 'string' || typeof project.updatedAt !== 'string') return null
    for (const name of project.domains) {
      if (typeof name !== 'string') return null
      try { if (validateDomainName(name) !== name) return null } catch { return null }
    }
    for (const rule of project.rules) {
      if (!object(rule) || typeof rule.id !== 'string' || !PROXY_PROJECT_UUID.test(rule.id)
        || typeof rule.path !== 'string' || !edge.PROXY_RULE_PATH.test(rule.path)
        || typeof rule.target !== 'string') return null
      try {
        edge.parseUpstream(rule.target, 'proxy rule target')
        assertProxyOptions({ websocket: rule.websocket, hostHeader: rule.hostHeader, headers: rule.headers })
      } catch { return null }
    }
  }
  return raw as unknown as ProxyProjectsFileRecord
}
