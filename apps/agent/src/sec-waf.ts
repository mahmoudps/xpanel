import { readFile as fsReadFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { edge, system } from '@xpanel/render'
import { SEC_CRS_HEADER_FILE, SEC_MODSEC_PATHS } from '../../../packages/os/src/sec-host-command.ts'
import type { SecFamily } from '../../../packages/os/src/sec-host-command.ts'
import { effectiveSecPolicy, SEC_FLOOD_STATE, SEC_WAF_SITES_STATE, SEC_WAF_STATE } from './sec-policy.ts'

/** true/false from a fixed-path stat; null when existence could not be determined. */
export type SecPresent = (path: string, kind: 'file' | 'directory') => Promise<boolean | null>
/** Bounded read of a fixed path; null when absent or unreadable. */
export type SecReadText = (path: string) => Promise<string | null>
export interface SecWafObservation {
  observedAt: string
  family: SecFamily | null
  connector: { nginx: boolean | null; apache: boolean | null }
  engineConf: { path: string | null; ruleEngine: 'On' | 'Off' | 'DetectionOnly' | null }
  crs: { dir: string | null; version: string | null }
  /** read from the live nginx.conf, never from saved state */
  active: { lists: boolean | null; modsecurity: boolean | null }
}

const MAX_TEXT = 512 * 1024
export const secPresent: SecPresent = (path, kind) => stat(path).then(facts => kind === 'file' ? facts.isFile() : facts.isDirectory(), error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null)
export const secReadText: SecReadText = async path => {
  try { const facts = await stat(path); if (!facts.isFile() || facts.size > MAX_TEXT) return null; return await fsReadFile(path, 'utf8') } catch { return null }
}
const first = async (paths: readonly string[], present: SecPresent, kind: 'file' | 'directory'): Promise<string | null> => {
  for (const path of paths) if (await present(path, kind).catch(() => null) === true) return path
  return null
}
// ModSecurity reference manual: SecRuleEngine On|Off|DetectionOnly; the last uncommented directive wins.
export function parseRuleEngine(text: string | null): SecWafObservation['engineConf']['ruleEngine'] {
  if (text === null) return null
  let mode: SecWafObservation['engineConf']['ruleEngine'] = null
  for (const line of text.split(/\r?\n/)) { const match = /^\s*SecRuleEngine\s+(On|Off|DetectionOnly)\s*$/.exec(line); if (match) mode = match[1] as 'On' | 'Off' | 'DetectionOnly' }
  return mode
}
export function parseCrsVersion(text: string | null): string | null {
  const head = text?.split(/\r?\n/).slice(0, 12).join('\n') ?? ''
  return /(?:Core Rule Set|OWASP CRS) ver\.([0-9]{1,2}\.[0-9]{1,3}\.[0-9]{1,3})\b/.exec(head)?.[1] ?? null
}

export async function observeSecWaf(input: { family: string; readNginxMain: () => Promise<string | null>; present?: SecPresent; readText?: SecReadText; now?: () => Date }): Promise<SecWafObservation> {
  const observedAt = (input.now?.() ?? new Date()).toISOString(), present = input.present ?? secPresent, readText = input.readText ?? secReadText
  const family = input.family === 'debian' || input.family === 'rhel' ? input.family : null
  let main: string | null = null
  try { main = await input.readNginxMain() } catch { main = null }
  // These two lines are rendered by renderWafHttp; their presence in the live file is the activation evidence.
  const active = { lists: main === null ? null : main.includes('# xPanel WAF: server-wide lists'), modsecurity: main === null ? null : /^\s*modsecurity on;\s*$/m.test(main) }
  if (!family) return { observedAt, family, connector: { nginx: null, apache: null }, engineConf: { path: null, ruleEngine: null }, crs: { dir: null, version: null }, active }
  const paths = SEC_MODSEC_PATHS[family]
  const [nginx, apache, conf, crsDir] = await Promise.all([present(paths.nginxModule, 'file').catch(() => null), present(paths.apacheModule, 'file').catch(() => null), first(paths.engineConf, present, 'file'), first(paths.crsDirs, present, 'directory')])
  return { observedAt, family, connector: { nginx, apache }, engineConf: { path: conf, ruleEngine: conf ? parseRuleEngine(await readText(conf)) : null },
    crs: { dir: crsDir, version: crsDir ? parseCrsVersion(await readText(posix.join(crsDir, SEC_CRS_HEADER_FILE))) : null }, active }
}

export interface SecEdgeConfiguration {
  edge: { waf: edge.WafGlobalPolicy; modsecurity: edge.ModsecuritySettings | null; clientMaxBodyMb: number | 'unlimited' }
  sites: Record<string, edge.WafSitePolicy>
  flood: system.NftFloodSettings | null
}
const readState = async (root: string, path: string): Promise<unknown> => {
  let text: string
  try { text = await fsReadFile(join(root, path), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'saved security configuration is unreadable; review it before reconciliation')
  }
  try { return JSON.parse(text) } catch { return fail('PRECONDITION_FAILED', 'saved security configuration is invalid; review it before reconciliation') }
}

/** Reconciler input: saved WAF, site switches and flood limits, plus ModSecurity only when the Nginx connector, an engine file and the policy all allow it. */
export async function readSecEdgeConfiguration(root: string, input: { family: string; domains: readonly { name: string; accountId: string }[]; present?: SecPresent }): Promise<SecEdgeConfiguration> {
  const present = input.present ?? secPresent
  const waf = effectiveSecPolicy('waf', await readState(root, SEC_WAF_STATE))
  const flood = effectiveSecPolicy('flood', await readState(root, SEC_FLOOD_STATE))
  const switches = effectiveSecPolicy('waf-sites', await readState(root, SEC_WAF_SITES_STATE)).sites
  let modsecurity: edge.ModsecuritySettings | null = null
  if (waf.modsecurity && (input.family === 'debian' || input.family === 'rhel')) {
    const paths = SEC_MODSEC_PATHS[input.family]
    const engineConf = await present(paths.nginxModule, 'file').catch(() => null) === true ? await first(paths.engineConf, present, 'file') : null
    if (engineConf) modsecurity = { engineConf, crsDir: await first(paths.crsDirs, present, 'directory') }
  }
  const sites: Record<string, edge.WafSitePolicy> = {}
  for (const domain of input.domains) {
    // A switch saved for a domain that later moved to another account is ignored rather than inherited.
    const own = switches[domain.name]?.accountId === domain.accountId ? switches[domain.name] : undefined
    sites[domain.name] = {
      rateLimit: waf.requestsPerSecond === null ? null : { requests: waf.requestsPerSecond, per: 'second', burst: waf.burst ?? 0, nodelay: true },
      connLimit: flood.enabled ? flood.webConnectionsPerAddress : null,
      ...(own ? { modsecurity: own.modsecurity } : {}),
    }
  }
  return {
    edge: { waf: { denyIps: waf.denyIps, denyPaths: waf.denyPaths, denyUserAgents: waf.denyUserAgents, denyStatus: waf.deniedResponse }, modsecurity, clientMaxBodyMb: waf.maxBodyMb ?? 'unlimited' },
    sites,
    flood: flood.enabled ? { connectionsPerAddress: flood.connectionsPerAddress, newPerSecond: flood.newConnectionsPerSecond, newBurst: flood.newConnectionsBurst, pingPerSecond: flood.pingPerSecond } : null,
  }
}
