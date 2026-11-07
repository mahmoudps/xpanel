import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { request } from 'node:http'

/** Root-only: the path Apache serves mod_status on. Outside the state tree, which the API user reads. */
export const WEB_STATUS_TOKEN_PATH = '/var/lib/xpanel/svc/web-status-token'
const MAX_BODY = 2 * 1024 * 1024

export async function readWebStatusToken(path = WEB_STATUS_TOKEN_PATH): Promise<string> {
  try { const token = (await readFile(path, 'utf8')).trim(); if (/^[0-9a-f]{64}$/.test(token)) return token } catch { /* First run: created below. */ }
  const token = randomBytes(32).toString('hex'), staged = path + '.new'
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(staged, token + '\n', { mode: 0o600 })
  await chmod(staged, 0o600)
  await rename(staged, path)
  return token
}

export interface WebStatusWorker { slot: string; pid: number | null; accesses: string; mode: string; cpu: number | null; secondsSinceRequest: number | null; lastRequestMs: number | null; connKb: number | null; childMb: number | null; slotMb: number | null; client: string | null; protocol: string | null; vhost: string | null; request: string | null; internal: boolean }
export interface WebStatusSummary { serverVersion: string | null; mpm: string | null; currentTime: string | null; restartTime: string | null; generation: number | null; uptimeSeconds: number | null; totalAccesses: number | null; totalKb: number | null; cpuLoad: number | null; requestsPerSecond: number | null; bytesPerSecond: number | null; bytesPerRequest: number | null; busyWorkers: number | null; idleWorkers: number | null; scoreboard: string | null }
export interface WebStatusObservation {
  observedAt: string
  engine: string
  apache: { state: 'read' | 'unsupported_engine' | 'unavailable'; reason: string | null; summary: WebStatusSummary | null; workers: WebStatusWorker[] }
  nginx: { state: 'read' | 'unavailable'; activeConnections: number | null; accepted: number | null; handled: number | null; requests: number | null; reading: number | null; writing: number | null; waiting: number | null }
}

const number = (value: string | undefined): number | null => { const parsed = value === undefined ? NaN : Number(value); return Number.isFinite(parsed) ? parsed : null }
/** mod_status ?auto: one "Key: value" per line. */
export function parseApacheAuto(text: string): WebStatusSummary {
  const fields = new Map(text.split('\n').flatMap(line => { const split = line.indexOf(': '); return split > 0 ? [[line.slice(0, split), line.slice(split + 2).trim()] as const] : [] }))
  return { serverVersion: fields.get('ServerVersion') ?? null, mpm: fields.get('ServerMPM') ?? null, currentTime: fields.get('CurrentTime') ?? null, restartTime: fields.get('RestartTime') ?? null, generation: number(fields.get('ParentServerConfigGeneration')),
    uptimeSeconds: number(fields.get('ServerUptimeSeconds') ?? fields.get('Uptime')), totalAccesses: number(fields.get('Total Accesses')), totalKb: number(fields.get('Total kBytes')), cpuLoad: number(fields.get('CPULoad')),
    requestsPerSecond: number(fields.get('ReqPerSec')), bytesPerSecond: number(fields.get('BytesPerSec')), bytesPerRequest: number(fields.get('BytesPerReq')), busyWorkers: number(fields.get('BusyWorkers')), idleWorkers: number(fields.get('IdleWorkers')), scoreboard: fields.get('Scoreboard') ?? null }
}

const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
const cell = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]!).replace(/\s+/g, ' ').trim()
const MODES: Readonly<Record<string, string>> = { _: 'waiting', S: 'starting', R: 'reading', W: 'sending', K: 'keep-alive', D: 'dns', C: 'closing', L: 'logging', G: 'finishing', I: 'idle', '.': 'open' }

/** The extended scoreboard table of mod_status: Srv PID Acc M CPU SS Req Dur Conn Child Slot Client Protocol VHost Request. Only busy rows are kept. */
export function parseApacheScoreboard(html: string, statusPath: string): WebStatusWorker[] {
  const workers: WebStatusWorker[] = []
  for (const row of html.matchAll(/<tr>(.*?)<\/tr>/gis)) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(match => cell(match[1]!))
    if (cells.length !== 15 || !/^\d+-\d+$/.test(cells[0]!)) continue
    const mode = MODES[cells[3]!] ?? cells[3]!, request = cells[14] || null, client = cells[11] || null
    if (mode === 'waiting' || mode === 'open') continue
    workers.push({ slot: cells[0]!, pid: number(cells[1]), accesses: cells[2]!, mode, cpu: number(cells[4]), secondsSinceRequest: number(cells[5]), lastRequestMs: number(cells[6]), connKb: number(cells[8]), childMb: number(cells[9]), slotMb: number(cells[10]), client, protocol: cells[12] || null, vhost: cells[13] || null,
      // the status read itself, and anything else from loopback that names it, is noise of this page
      request: request?.includes(statusPath) ? null : request, internal: (client === '127.0.0.1' || client === '::1') && (request === null || request.includes(statusPath)) })
  }
  return workers
}

/** nginx stub_status: "Active connections: N", "server accepts handled requests", the three counters, "Reading: R Writing: W Waiting: W". */
export function parseStubStatus(text: string): Omit<WebStatusObservation['nginx'], 'state'> | null {
  const match = /^Active connections:\s*(\d+)\s*\nserver accepts handled requests\s*\n\s*(\d+)\s+(\d+)\s+(\d+)\s*\nReading:\s*(\d+)\s+Writing:\s*(\d+)\s+Waiting:\s*(\d+)/.exec(text)
  return match ? { activeConnections: Number(match[1]), accepted: Number(match[2]), handled: Number(match[3]), requests: Number(match[4]), reading: Number(match[5]), writing: Number(match[6]), waiting: Number(match[7]) } : null
}

export type WebStatusGet = (target: { port: number; path: string } | { socket: string; path: string }) => Promise<{ status: number; body: string }>
export const webStatusGet: WebStatusGet = target => new Promise((resolve, reject) => {
  const req = request({ method: 'GET', path: target.path, timeout: 5000, headers: { host: 'localhost' }, ...('socket' in target ? { socketPath: target.socket } : { host: '127.0.0.1', port: target.port }) }, response => {
    const chunks: Buffer[] = []; let bytes = 0
    response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BODY) { req.destroy(new Error('web_status_too_large')); return } chunks.push(chunk) })
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    response.on('error', reject)
  })
  req.on('timeout', () => req.destroy(new Error('web_status_timeout')))
  req.on('error', reject)
  req.end()
})

const NO_NGINX = { activeConnections: null, accepted: null, handled: null, requests: null, reading: null, writing: null, waiting: null }
/** Two reads of mod_status (machine summary, then the scoreboard table) and one of stub_status; each stays unavailable on its own. */
export async function observeWebStatus(input: { engine: string; backendPort: number; statusPath: string; nginxSocket: string; get?: WebStatusGet; now?: () => Date }): Promise<WebStatusObservation> {
  const get = input.get ?? webStatusGet, observedAt = (input.now?.() ?? new Date()).toISOString()
  const stub = await get({ socket: input.nginxSocket, path: '/status' }).catch(() => null)
  const parsedStub = stub?.status === 200 ? parseStubStatus(stub.body) : null
  const nginx: WebStatusObservation['nginx'] = parsedStub ? { state: 'read', ...parsedStub } : { state: 'unavailable', ...NO_NGINX }
  if (input.engine !== 'apache') return { observedAt, engine: input.engine, apache: { state: 'unsupported_engine', reason: 'another_web_server', summary: null, workers: [] }, nginx }
  const auto = await get({ port: input.backendPort, path: input.statusPath + '?auto' }).catch(() => null)
  if (auto?.status !== 200 || !auto.body.includes('Scoreboard: ')) return { observedAt, engine: input.engine, apache: { state: 'unavailable', reason: auto === null ? 'backend_unreachable' : 'status_module_unavailable', summary: null, workers: [] }, nginx }
  const table = await get({ port: input.backendPort, path: input.statusPath }).catch(() => null)
  return { observedAt, engine: input.engine, apache: { state: 'read', reason: null, summary: parseApacheAuto(auto.body), workers: table?.status === 200 ? parseApacheScoreboard(table.body, input.statusPath) : [] }, nginx }
}
