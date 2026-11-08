import dgram from 'node:dgram'
import net from 'node:net'
import { defaultHostWatchdog, defaultPhpGuardian, HOST_TOOLS_STATE, isXpanelError, validateHostWatchdog, validatePhpGuardian, WATCHED_SERVICES } from '@xpanel/core'
import type { HostWatchdog, OsProfile, PhpGuardian } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { edge, system } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { hostUnitVerbArgv } from '../../../packages/os/src/host-tools-command.ts'
import type { AgentExecutor } from './executor.ts'
import { restartHostService } from './host-services.ts'
import { sendmailAlert } from './leech-protection.ts'
import { disabledRoleUnits, readSaved, readServerRoles } from './server-operations.ts'
import { writeSvcState } from './svc-reconcile.ts'

export const HOST_WATCH_PATH = '/var/lib/xpanel/svc/host-watch.json'
export const FPM_PING_PATH = edge.FPM_PING_PATH
const EVENTS_KEPT = 200
const PROBE_TIMEOUT_MS = 3000
const HOUR_MS = 3_600_000
const LOOPBACK = '127.0.0.1'

export type WatchEventKind = 'failure' | 'restart' | 'recovered' | 'alert' | 'config_test_failed' | 'restart_failed'
export interface WatchEvent { at: string; target: string; kind: WatchEventKind }
interface WatchEntry { failing: boolean; nextAt: number; restarts: number[]; alerted: boolean }
export interface HostWatchState { services: Record<string, WatchEntry>; pools: Record<string, number>; events: WatchEvent[] }
const emptyState = (): HostWatchState => ({ services: {}, pools: {}, events: [] })
export const parseHostWatchState = (raw: unknown): HostWatchState => {
  const value = raw as Partial<HostWatchState> | null
  return value && typeof value === 'object' && Array.isArray(value.events) && value.services && value.pools ? { services: value.services, pools: value.pools, events: value.events } : emptyState()
}

const banner = (port: number, expect: RegExp, send?: string): Promise<boolean> => new Promise(resolve => {
  const socket = net.connect({ host: LOOPBACK, port }), done = (ok: boolean): void => { socket.destroy(); resolve(ok) }
  socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
  socket.once('error', () => done(false))
  socket.once('connect', () => { if (send) socket.write(send) })
  socket.once('data', chunk => done(expect.test(chunk.toString('latin1'))))
})
const tcpOpen = (port: number): Promise<boolean> => new Promise(resolve => {
  const socket = net.connect({ host: LOOPBACK, port }), done = (ok: boolean): void => { socket.destroy(); resolve(ok) }
  socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
  socket.once('error', () => done(false))
  socket.once('connect', () => done(true))
})
/** Any reply carrying our query id proves the daemon answers, whatever its authority for the root zone. */
const dnsAnswers = (port: number): Promise<boolean> => new Promise(resolve => {
  const socket = dgram.createSocket('udp4'), id = Buffer.from([0x78, 0x70]), done = (ok: boolean): void => { clearTimeout(timer); socket.close(); resolve(ok) }
  const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
  socket.once('error', () => done(false))
  socket.once('message', reply => done(reply.subarray(0, 2).equals(id)))
  socket.send(Buffer.concat([id, Buffer.from([1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 1])]), port, LOOPBACK)
})
export const probeWatchedService = (kind: string, port: number): Promise<boolean> =>
  kind === 'smtp' ? banner(port, /^220[ -]/) : kind === 'imap' ? banner(port, /^\* (?:OK|PREAUTH)/) : kind === 'http' ? banner(port, /^HTTP\//, `HEAD / HTTP/1.0\r\nHost: localhost\r\n\r\n`) : kind === 'dns' ? dnsAnswers(port) : tcpOpen(port)

const fcgiRecord = (type: number, content: Buffer): Buffer => {
  const header = Buffer.from([1, type, 0, 1, content.length >> 8, content.length & 255, 0, 0])
  return Buffer.concat([header, content])
}
const fcgiParams = (params: Readonly<Record<string, string>>): Buffer => Buffer.concat(Object.entries(params).map(([key, value]) => Buffer.concat([Buffer.from([key.length, value.length]), Buffer.from(key + value)])))
/** A minimal FastCGI ping request: a worker that takes the request and writes anything back is alive. */
export const pingFpmPool = (socketPath: string, timeoutMs: number): Promise<boolean> => new Promise(resolve => {
  const socket = net.connect({ path: socketPath }), done = (ok: boolean): void => { socket.destroy(); resolve(ok) }
  socket.setTimeout(timeoutMs, () => done(false))
  socket.once('error', () => done(false))
  socket.once('connect', () => socket.write(Buffer.concat([
    fcgiRecord(1, Buffer.from([0, 1, 0, 0, 0, 0, 0, 0])),
    fcgiRecord(4, fcgiParams({ REQUEST_METHOD: 'GET', SCRIPT_NAME: FPM_PING_PATH, SCRIPT_FILENAME: FPM_PING_PATH, QUERY_STRING: '' })), fcgiRecord(4, Buffer.alloc(0)), fcgiRecord(5, Buffer.alloc(0)),
  ])))
  socket.once('data', chunk => done(chunk[1] === 6))
})

export interface HostWatchDeps {
  rootDir: string
  restartService: (id: string) => Promise<unknown>
  restartPool: (account: string, version: string) => Promise<boolean>
  pools: () => Promise<readonly { account: string; version: string }[]>
  alert: (subject: string, text: string) => Promise<void>
  probe?: typeof probeWatchedService
  ping?: typeof pingFpmPool
  readState?: () => Promise<unknown>
  writeState?: (state: HostWatchState) => Promise<void>
  now?: () => Date
}

export async function readHostWatchSettings(rootDir: string): Promise<{ watchdog: HostWatchdog; guardian: PhpGuardian }> {
  return { watchdog: await readSaved(rootDir, HOST_TOOLS_STATE.watchdog, validateHostWatchdog) ?? defaultHostWatchdog(), guardian: await readSaved(rootDir, HOST_TOOLS_STATE.guardian, validatePhpGuardian) ?? defaultPhpGuardian() }
}

/** Runs from the agent's minute timer, so an unset watchdog costs two small file reads and no process of its own. */
export function createHostWatch(deps: HostWatchDeps): { tick: () => Promise<void> } {
  const now = deps.now ?? (() => new Date()), probe = deps.probe ?? probeWatchedService, ping = deps.ping ?? pingFpmPool
  let running = false
  const event = (state: HostWatchState, target: string, kind: WatchEventKind): void => { state.events = [...state.events, { at: now().toISOString(), target, kind }].slice(-EVENTS_KEPT) }
  const alert = (subject: string, text: string): Promise<void> => deps.alert(subject, text).catch(() => undefined)

  async function checkService(state: HostWatchState, id: string, settings: HostWatchdog, at: number): Promise<void> {
    const row = settings.services[id]!, spec = WATCHED_SERVICES[id as keyof typeof WATCHED_SERVICES]
    const entry = state.services[id] ??= { failing: false, nextAt: 0, restarts: [], alerted: false }
    if (at < entry.nextAt) return
    entry.nextAt = at + row.intervalSec * 1000
    if (await probe(spec.probe, spec.port)) {
      if (entry.failing) event(state, id, 'recovered')
      entry.failing = false; entry.alerted = false
      return
    }
    if (!entry.failing) event(state, id, 'failure')
    entry.failing = true
    if (!row.autoRestart) return
    entry.restarts = entry.restarts.filter(time => at - time < HOUR_MS)
    if (entry.restarts.length >= settings.budgetPerHour) {
      if (!entry.alerted) { entry.alerted = true; event(state, id, 'alert'); await alert(`xPanel watchdog: ${id} keeps failing`, `${id} failed its ${spec.probe} probe again after ${entry.restarts.length} restarts this hour. No further restart will be tried until the budget clears.`) }
      return
    }
    // Each restart inside the hour doubles the wait before the next probe, so a crash loop backs off by itself.
    entry.nextAt = at + row.intervalSec * 1000 * 2 ** entry.restarts.length
    try { await deps.restartService(id); entry.restarts.push(at); event(state, id, 'restart') } catch (error) {
      const refused = isXpanelError(error) && error.code === 'CONFIG_TEST_FAILED'
      event(state, id, refused ? 'config_test_failed' : 'restart_failed')
      if (!entry.alerted) { entry.alerted = true; await alert(`xPanel watchdog: ${id} was not restarted`, refused ? `${id} failed its probe and its configuration test, so it was not restarted.` : `${id} failed its probe and the restart did not complete.`) }
    }
  }

  async function checkPools(state: HostWatchState, guardian: PhpGuardian, at: number): Promise<void> {
    for (const { account, version } of await deps.pools()) {
      const key = `${account}:${version}`
      if (at < (state.pools[key] ?? 0)) continue
      state.pools[key] = at + guardian.intervalSec * 1000
      if (await ping(edge.fpmSocketPath(account, version), guardian.timeoutSec * 1000)) continue
      event(state, key, 'failure')
      event(state, key, await deps.restartPool(account, version).catch(() => false) ? 'restart' : 'restart_failed')
    }
  }

  return {
    tick: async () => {
      if (running) return
      running = true
      try {
        const { watchdog, guardian } = await readHostWatchSettings(deps.rootDir)
        const watched = Object.keys(watchdog.services).filter(id => watchdog.services[id]!.enabled)
        if (!watched.length && !guardian.enabled) return
        const state = parseHostWatchState(await (deps.readState ?? (() => readJsonIfExists<unknown>(HOST_WATCH_PATH)))()), at = now().getTime()
        for (const id of watched) await checkService(state, id, watchdog, at)
        if (guardian.enabled) await checkPools(state, guardian, at)
        await (deps.writeState ?? (value => writeSvcState(HOST_WATCH_PATH, value)))(state)
      } finally { running = false }
    },
  }
}

/** The daemon's watch: saved pools of active accounts, the reviewed restart path, and alerts to root's mail. */
export const createNativeHostWatch = (deps: { store: Pick<StateStore, 'rootDir' | 'readSnapshot' | 'getServerSettings'>; executor: Pick<AgentExecutor, 'runCommand'>; os: OsProfile }): { tick: () => Promise<void> } => createHostWatch({
  rootDir: deps.store.rootDir,
  restartService: async id => restartHostService(argv => deps.executor.runCommand(argv), id, profileFor(`ID=${deps.os.id}
VERSION_ID=${deps.os.versionId}`), disabledRoleUnits(await readServerRoles(deps.store.rootDir))),
  restartPool: async (account, version) => (await deps.executor.runCommand(hostUnitVerbArgv('restart', system.fpmUnitName(account, version)))).ok,
  pools: async () => {
    const snapshot = await deps.store.readSnapshot(), owners = new Map(snapshot.accounts.filter(account => account.status === 'active').map(account => [account.id, account.username])), seen = new Map<string, { account: string; version: string }>()
    for (const domain of snapshot.domains) { const account = owners.get(domain.accountId); if (account && domain.siteType === 'php' && domain.php.handler === 'fpm') seen.set(`${account} ${domain.php.version}`, { account, version: domain.php.version }) }
    return [...seen.values()]
  },
  alert: async (subject, text) => { const name = (await deps.store.getServerSettings())?.hostname; if (name) await sendmailAlert(`xpanel@${name}`, `root@${name}`, subject, text) },
})
