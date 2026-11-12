import { rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { fail } from '@xpanel/core'
import { findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { createHttpsWebhookSender, createLocalMtaEmailSender } from './alert-delivery.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { runScheduledAlertCycle } from './monitoring-alerts.ts'
import { dispatchWebhooks } from './webhook-dispatch.ts'
import { deliverProcessKillerReports } from './svc-killer-report.ts'
import { runSshLoginAlarmCycle, SSH_ALARM_EVERY_MS, SSH_ALARM_FILE } from './ssh-login-alarm.ts'
import { deliveryChannelsOf } from './panel-notifications.ts'
import { tweakValue } from './tweak-settings-workspace.ts'

/** Alert and notification state files under extended state. The signing key file is 0600: only the API service user reads it. */
export const ALERT_FILES = {
  rules: 'monitoring/alerts.json', state: 'monitoring/alerts-state.json', delivery: 'monitoring/alerts-delivery.json',
  notifications: 'panel/notifications.json', signingKey: 'panel/notification-signing-key.json',
} as const
type Store = Pick<StateStore, 'rootDir' | 'getServerSettings' | 'getWriterLock'>

export function alertStateFiles(store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) {
  const path = (name: keyof typeof ALERT_FILES): string => join(store.rootDir, 'extended', ALERT_FILES[name])
  const read = (name: keyof typeof ALERT_FILES) => () => readJsonIfExists<unknown>(path(name))
  const write = (name: keyof typeof ALERT_FILES, mode?: number) => (value: unknown) => value === null ? rm(path(name), { force: true }) : atomicWriteJson(path(name), value, mode)
  return {
    readRules: read('rules'), writeRules: write('rules'), readState: read('state'), writeState: write('state'), readDelivery: read('delivery'), writeDelivery: write('delivery'),
    readSaved: read('notifications'), writeSaved: write('notifications'), readSigningKey: read('signingKey'), writeSigningKey: write('signingKey', 0o600),
    readChannels: async () => deliveryChannelsOf(await read('notifications')(), await read('signingKey')()),
    readEveryMinutes: async () => await tweakValue(store, 'server.healthCheckMinutes') as number,
  }
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
/** System mail comes from xpanel@<server hostname> through the local MTA; webhooks use the reviewed HTTPS egress. */
export async function alertTransports(store: Store): Promise<DeliveryTransports> {
  let name: string
  try { name = (await store.getServerSettings())?.hostname ?? hostname() } catch { name = hostname() }
  const serverName = HOST_NAME.test(name) ? name.toLowerCase() : 'localhost'
  return { serverName, email: createLocalMtaEmailSender({ from: 'xpanel@' + (serverName.includes('.') ? serverName : 'localhost'), helo: serverName }), webhook: createHttpsWebhookSender() }
}

/** Scheduled checks read host health as the built-in root principal, like the administrative CLI (cli.ts). */
export const readServerHealthAsRoot = (input: { db: Db; agentApp: AgentApp; agentToken: string }): Promise<unknown> => readHostAsRoot(input, '/host/server-health')

async function readHostAsRoot(input: { db: Db; agentApp: AgentApp; agentToken: string }, path: string): Promise<unknown> {
  const principal = await findPrincipalByUsername(input.db, 'root')
  if (!principal || principal.disabled || principal.kind !== 'root') return fail('PRECONDITION_FAILED', 'an active root principal is required for scheduled alert checks')
  const response = await input.agentApp.fetch(new Request('http://agent.local' + path, { headers: agentCallerHeaders({ principalId: principal.id, token: input.agentToken }) }))
  const text = await response.text()
  if (!response.ok || text.length > 1024 * 1024) return fail('SERVICE_UNAVAILABLE', 'the protected host response could not be verified')
  return JSON.parse(text)
}

/**
 * In-process schedule in the API service (no extra daemon or timer unit): one cycle every server.healthCheckMinutes (Tweak Settings,
 * read again before each wait), never two at once.
 * Each cycle runs under a fresh lifecycle writer admission, as long-lived timers must (scripts/lifecycle-admission.mjs).
 */
export function startAlertScheduler(input: {
  db: Db; store: Store; agentApp: AgentApp; agentToken: string; admit: <T>(task: () => Promise<T>) => Promise<T>; everyMs?: number; onError?: (error: unknown) => void
  /** Tests replace the network transports; production builds them from the server hostname on every cycle. */
  transports?: DeliveryTransports
}): { stop: () => Promise<void> } {
  let running: Promise<unknown> | null = null, stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  const files = alertStateFiles(input.store)
  const schedule = async (): Promise<void> => {
    const everyMs = input.everyMs ?? await files.readEveryMinutes() * 60_000
    if (stopped) return
    timer = setTimeout(tick, everyMs)
    timer.unref()
  }
  const tick = (): void => {
    if (running || stopped) return
    running = input.admit(async () => {
      const transports = input.transports ?? await alertTransports(input.store)
      await runScheduledAlertCycle({ ...files, transports, readHost: () => readServerHealthAsRoot(input) })
      await deliverProcessKillerReports({ ...input, readChannels: files.readChannels, email: transports.email })
    })
      .catch(error => input.onError?.(error)).finally(() => { running = null; void schedule() })
  }
  void schedule()
  const alarmFile = join(input.store.rootDir, 'extended', SSH_ALARM_FILE)
  const alarm = setInterval(() => { void input.admit(async () => runSshLoginAlarmCycle({ ...files, readSettings: () => input.store.getServerSettings(), readState: () => readJsonIfExists<unknown>(alarmFile), writeState: value => atomicWriteJson(alarmFile, value),
    readLogins: cursor => readHostAsRoot(input, '/host/security/ssh/logins' + (cursor ? '?after=' + encodeURIComponent(cursor) : '')), transports: input.transports ?? await alertTransports(input.store) })).catch(error => input.onError?.(error)) }, input.everyMs ?? SSH_ALARM_EVERY_MS)
  alarm.unref()
  // Webhooks keep their own short cycle: their retry schedule starts at 30 seconds, and an idle pass reads one small file.
  let dispatching: Promise<unknown> | null = null
  const webhooks = setInterval(() => {
    if (dispatching || stopped) return
    dispatching = input.admit(async () => dispatchWebhooks({ db: input.db, store: input.store, send: (input.transports ?? await alertTransports(input.store)).webhook }))
      .catch(error => input.onError?.(error)).finally(() => { dispatching = null })
  }, 30_000)
  webhooks.unref()
  return { stop: async () => { stopped = true; clearTimeout(timer); clearInterval(alarm); clearInterval(webhooks); await running; await dispatching } }
}
