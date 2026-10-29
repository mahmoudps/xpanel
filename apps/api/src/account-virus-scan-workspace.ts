import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { ACCOUNT_SCAN_COOLDOWN_MINUTES, ACCOUNT_SCAN_HISTORY } from '../../agent/src/account-virus-scan.ts'
import type { AccountScanView, AccountVirusScanView } from '../../agent/src/account-virus-scan.ts'
import { SCAN_FINDINGS_LIMIT } from '../../agent/src/security-tools-antivirus.ts'

export const ACCOUNT_VIRUS_SCAN_PATH = '/api/account/virus-scan'
/** Catalog tool of the /security/virus-scanner navigation entry. */
export const ACCOUNT_VIRUS_SCAN_TOOL = 'virus-scanner'
export type AccountVirusScanPorts = AccountSshPorts
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max = 64): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !UNSAFE.test(value)
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const nullable = <T>(value: unknown, check: (value: unknown) => value is T): value is T | null => value === null || check(value)
/** '.' or a path below the home: never absolute, never a parent or empty segment. */
export const isHomeRelativePath = (value: unknown): value is string => text(value, 1024) && (value === '.' || !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))

function scan(raw: unknown): AccountScanView | null {
  if (!object(raw) || typeof raw.jobId !== 'string' || !UUID.test(raw.jobId) || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(raw.status as string) || !['pending', 'clean', 'infected', 'error', 'cancelled', 'unknown'].includes(raw.result as string)
    || !time(raw.createdAt) || !nullable(raw.finishedAt, time) || typeof raw.listComplete !== 'boolean' || !Array.isArray(raw.infected) || raw.infected.length > SCAN_FINDINGS_LIMIT) return null
  const infected = raw.infected.map(item => object(item) && isHomeRelativePath(item.path) && typeof item.signature === 'string' && /^[A-Za-z0-9._:{}+-]{1,160}$/.test(item.signature) ? { path: item.path, signature: item.signature } : null)
  const s = raw.summary
  if (infected.includes(null) || !(s === null || object(s) && int(s.infectedFiles) && [s.knownViruses, s.scannedDirectories, s.scannedFiles].every(value => nullable(value, int)) && [s.engineVersion, s.dataScanned, s.time].every(value => nullable(value, text)))) return null
  return { jobId: raw.jobId, status: raw.status as AccountScanView['status'], result: raw.result as AccountScanView['result'], createdAt: raw.createdAt, finishedAt: raw.finishedAt, listComplete: raw.listComplete, infected: infected as AccountScanView['infected'],
    summary: s === null ? null : { knownViruses: s.knownViruses as number | null, engineVersion: s.engineVersion as string | null, scannedDirectories: s.scannedDirectories as number | null, scannedFiles: s.scannedFiles as number | null, infectedFiles: s.infectedFiles as number, dataScanned: s.dataScanned as string | null, time: s.time as string | null } }
}

/** Agent reply pinned to the session account and rebuilt field by field, independent of the browser's own checks. */
export function projectAccountVirusScan(raw: unknown, account: Account, started: boolean): AccountVirusScanView | null {
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || !time(raw.observedAt) || !object(raw.engine) || !object(raw.limits) || !object(raw.start) || !Array.isArray(raw.scans) || raw.scans.length > ACCOUNT_SCAN_HISTORY) return null
  const { engine, limits, start } = raw
  if (!['read', 'not_installed', 'unavailable'].includes(engine.state as string) || !nullable(engine.version, text) || !nullable(engine.signatureVersion, int) || !nullable(engine.signatureDate, text) || engine.state !== 'read' && engine.version !== null
    || typeof raw.jobsAvailable !== 'boolean' || limits.history !== ACCOUNT_SCAN_HISTORY || limits.cooldownMinutes !== ACCOUNT_SCAN_COOLDOWN_MINUTES || limits.findingsPerScan !== SCAN_FINDINGS_LIMIT
    || typeof start.allowed !== 'boolean' || !(start.reason === null || ['engine_unavailable', 'jobs_unavailable', 'scan_active', 'cooldown'].includes(start.reason as string)) || start.allowed !== (start.reason === null) || !nullable(start.availableAt, time) || (start.availableAt !== null) !== (start.reason === 'cooldown')) return null
  const scans = raw.scans.map(scan)
  const startedId = object(raw.started) && typeof raw.started.jobId === 'string' && UUID.test(raw.started.jobId) ? raw.started.jobId : null
  if (scans.includes(null) || (started ? !startedId || !scans.some(item => item?.jobId === startedId) : raw.started !== null)) return null
  return { context: { accountId: account.id, username: account.username }, observedAt: raw.observedAt, jobsAvailable: raw.jobsAvailable,
    engine: { state: engine.state as AccountVirusScanView['engine']['state'], version: engine.version as string | null, signatureVersion: engine.signatureVersion as number | null, signatureDate: engine.signatureDate as string | null },
    limits: { history: ACCOUNT_SCAN_HISTORY, cooldownMinutes: ACCOUNT_SCAN_COOLDOWN_MINUTES, findingsPerScan: SCAN_FINDINGS_LIMIT }, start: { allowed: start.allowed, reason: start.reason as AccountVirusScanView['start']['reason'], availableAt: start.availableAt as string | null },
    scans: scans as AccountScanView[], started: startedId ? { jobId: startedId } : null }
}

/** GET reads the engine and own scan history; POST queues one scan of the session account's home. Nothing is selected by the request. */
export async function handleAccountVirusScanRoute(req: Request, url: URL, method: string, ports: AccountVirusScanPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_VIRUS_SCAN_PATH) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'the virus scanner does not accept account or path selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, [ACCOUNT_VIRUS_SCAN_TOOL], 'The virus scanner')
  const agentPath = '/accounts/' + first.account.username + '/virus-scan'
  if (method === 'GET') {
    const view = projectAccountVirusScan(await ports.readAgent(first.caller, agentPath), first.account, false)
    return view ? workspaceJson(view) : fail('SERVICE_UNAVAILABLE', 'the virus scan status could not be verified', { stateChanged: false })
  }
  let raw: unknown
  try { raw = await req.json() } catch { return fail('VALIDATION', 'a scan request must be an empty JSON object', { stateChanged: false }) }
  if (!object(raw) || Object.keys(raw).length !== 0) return fail('VALIDATION', 'a scan request takes no fields; the target is your home directory', { stateChanged: false })
  // Fresh authority immediately before the submission; the agent re-checks again inside the account lease.
  const fresh = await authorizeAccountOwner(ports, req, [ACCOUNT_VIRUS_SCAN_TOOL], 'The virus scanner')
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id || fresh.account.username !== first.account.username) return fail('CONFLICT', 'the account binding changed before starting the scan', { stateChanged: false })
  const view = projectAccountVirusScan(await ports.readAgent(fresh.caller, agentPath, {}, true, 'POST'), fresh.account, true)
  return view ? workspaceJson(view, 202) : fail('SERVICE_UNAVAILABLE', 'the scan start requires review in the scan history', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
}
