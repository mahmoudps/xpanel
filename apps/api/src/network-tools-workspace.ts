import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { DNS_MAX_RECORDS, DNS_RECORD_MAX_CHARS, PING_MAX_TRANSMITTED, PORT_TIMEOUT_MS, networkToolQuery, parseNetworkToolRequest } from '../../agent/src/network-tools.ts'
import type { NetworkTool, NetworkToolRequest, NetworkToolView } from '../../agent/src/network-tools.ts'
import { TRACEROUTE_MAX_HOPS, canonicalIp, isPublicAddress } from '../../../packages/os/src/network-tools-command.ts'

export const ACCOUNT_NETWORK_TOOLS_ROUTE = /^\/api\/account\/network-tools\/(dns|ping|traceroute|port)$/
export const NETWORK_TOOLS_RUNS_PER_MINUTE = 10
export type NetworkToolsGate = <T>(accountId: string, operation: () => Promise<T>) => Promise<T>
export interface NetworkToolsPorts extends AccountSshPorts { networkToolsGate: NetworkToolsGate }

/** In-process admission: one run at a time and at most `limit` runs per rolling window for each account. */
export function createNetworkToolsGate(limit = NETWORK_TOOLS_RUNS_PER_MINUTE, windowMs = 60_000, now: () => number = Date.now): NetworkToolsGate {
  const started = new Map<string, number[]>(), running = new Set<string>()
  return async (accountId, operation) => {
    if (running.has(accountId)) return fail('CONFLICT', 'another network diagnostic is already running for this account', { stateChanged: false })
    const at = now(), recent = (started.get(accountId) ?? []).filter(time => at - time < windowMs)
    if (recent.length >= limit) return fail('LIMIT_EXCEEDED', 'at most ' + limit + ' network diagnostics can run per minute', { stateChanged: false, retryAfterSeconds: Math.ceil((recent[0]! + windowMs - at) / 1000) })
    started.set(accountId, [...recent, at]); running.add(accountId)
    try { return await operation() } finally { running.delete(accountId) }
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const ms = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e6
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const DNS_STATUSES = ['answer', 'nxdomain', 'nodata', 'servfail', 'refused', 'timeout', 'failed']

function validResult(tool: NetworkTool, result: Record<string, unknown>, target: { address: string } | null): boolean {
  if (tool === 'dns') return keys(result, ['status', 'records', 'truncated']) && DNS_STATUSES.includes(result.status as string) && typeof result.truncated === 'boolean' && Array.isArray(result.records)
    && result.records.length <= DNS_MAX_RECORDS && (result.status === 'answer') === (result.records.length > 0)
    && result.records.every(record => typeof record === 'string' && record.length > 0 && record.length <= DNS_RECORD_MAX_CHARS + 1 && !/[\u0000-\u001f\u007f]/.test(record))
  if (tool === 'ping') {
    const rtt = result.rtt
    return keys(result, ['transmitted', 'received', 'errors', 'lossPercent', 'rtt']) && int(result.transmitted, 1, PING_MAX_TRANSMITTED) && int(result.received, 0, result.transmitted) && int(result.errors, 0, 999)
      && typeof result.lossPercent === 'number' && result.lossPercent >= 0 && result.lossPercent <= 100 && (rtt === null ? result.received === 0 : result.received > 0 && object(rtt) && keys(rtt, ['minMs', 'avgMs', 'maxMs'])
      && ms(rtt.minMs) && ms(rtt.avgMs) && ms(rtt.maxMs) && rtt.minMs <= rtt.avgMs && rtt.avgMs <= rtt.maxMs)
  }
  if (tool === 'traceroute') return keys(result, ['hops', 'reached']) && Array.isArray(result.hops) && result.hops.length >= 1 && result.hops.length <= TRACEROUTE_MAX_HOPS
    && result.hops.every((hop, index) => object(hop) && keys(hop, ['hop', 'address', 'nonPublic', 'rttMs', 'note']) && hop.hop === index + 1 && typeof hop.nonPublic === 'boolean'
      && (hop.address === null || !hop.nonPublic && isPublicAddress(hop.address)) && (hop.rttMs === null || ms(hop.rttMs)) && (hop.note === null || typeof hop.note === 'string' && /^!\S{0,8}$/.test(hop.note)))
    && result.reached === (target !== null && (result.hops.at(-1) as Record<string, unknown>).address === target.address)
  return keys(result, ['state', 'elapsedMs']) && ['open', 'closed', 'filtered'].includes(result.state as string) && int(result.elapsedMs, 0, PORT_TIMEOUT_MS * 10)
}

/** Agent reply pinning, independent of the browser's own checks: same account, tool and query; a public target only. */
export function validateNetworkToolView(raw: unknown, account: Account, request: NetworkToolRequest): NetworkToolView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'network diagnostic reply is invalid')
  if (!object(raw) || !keys(raw, ['context', 'query', 'outcome', 'target', 'result', 'observedAt']) || !object(raw.context) || !keys(raw.context, ['accountId', 'tool']) || raw.context.accountId !== account.id || raw.context.tool !== request.tool
    || JSON.stringify(raw.query) !== JSON.stringify(networkToolQuery(request)) || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))) return bad()
  const { outcome, target, result } = raw
  if (request.tool === 'dns') return outcome === 'completed' && target === null && object(result) && validResult('dns', result, null) ? raw as unknown as NetworkToolView : bad()
  if (outcome === 'refused' || outcome === 'unresolved') return target === null && result === null && !(outcome === 'unresolved' && canonicalIp(request.host)) ? raw as unknown as NetworkToolView : bad()
  const literal = canonicalIp(request.host)?.address
  if (outcome !== 'completed' || !object(target) || !keys(target, ['address', 'family']) || !isPublicAddress(target.address) || target.family !== (target.address.includes(':') ? 6 : 4)
    || literal !== undefined && target.address !== literal || !object(result) || !validResult(request.tool, result, { address: target.address })) return bad()
  return raw as unknown as NetworkToolView
}

/** POST only. The signed-in owner runs one diagnostic; the agent resolves, checks and runs it from the server. */
export async function handleNetworkToolsRoute(req: Request, url: URL, method: string, ports: NetworkToolsPorts): Promise<Response | null> {
  const match = ACCOUNT_NETWORK_TOOLS_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'network diagnostics do not accept query selectors', { stateChanged: false })
  const { caller, account } = await authorizeAccountOwner(ports, req, ['track-dns'], 'Network tools')
  const text = await req.text()
  if (text.length > 1024) return fail('LIMIT_EXCEEDED', 'the diagnostic request is too large', { stateChanged: false })
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('VALIDATION', 'the diagnostic request must be valid JSON', { stateChanged: false }) }
  const request = parseNetworkToolRequest(match[1]!, raw)
  return ports.networkToolsGate(account.id, async () => {
    const reply = await ports.readAgent(caller, '/accounts/' + account.username + '/network-tools/' + request.tool, networkToolQuery(request))
    try { return workspaceJson(validateNetworkToolView(reply, account, request)) }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the network diagnostic result could not be verified', { stateChanged: false }) }
  })
}
