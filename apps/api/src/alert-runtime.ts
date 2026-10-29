import { hostname } from 'node:os'
import { join } from 'node:path'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { fail } from '@xpanel/core'
import { findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { ALERT_SCHEDULE_MINUTES, createHttpsWebhookSender, createLocalMtaEmailSender } from './alert-delivery.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { runScheduledAlertCycle } from './monitoring-alerts.ts'
import { deliveryChannelsOf } from './panel-notifications.ts'

/** Alert and notification state files under extended state. The signing key file is 0600: only the API service user reads it. */
export const ALERT_FILES = {
  rules: 'monitoring/alerts.json', state: 'monitoring/alerts-state.json', delivery: 'monitoring/alerts-delivery.json',
  notifications: 'panel/notifications.json', signingKey: 'panel/notification-signing-key.json',
} as const
type Store = Pick<StateStore, 'rootDir' | 'getServerSettings'>

export function alertStateFiles(store: Pick<StateStore, 'rootDir'>) {
  const path = (name: keyof typeof ALERT_FILES): string => join(store.rootDir, 'extended', ALERT_FILES[name])
  const read = (name: keyof typeof ALERT_FILES) => () => readJsonIfExists<unknown>(path(name))
  const write = (name: keyof typeof ALERT_FILES, mode?: number) => (value: unknown) => atomicWriteJson(path(name), value, mode)
  return {
    readRules: read('rules'), writeRules: write('rules'), readState: read('state'), writeState: write('state'), readDelivery: read('delivery'), writeDelivery: write('delivery'),
    readSaved: read('notifications'), writeSaved: write('notifications'), readSigningKey: read('signingKey'), writeSigningKey: write('signingKey', 0o600),
    readChannels: async () => deliveryChannelsOf(await read('notifications')(), await read('signingKey')()),
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
export async function readServerHealthAsRoot(input: { db: Db; agentApp: AgentApp; agentToken: string }): Promise<unknown> {
  const principal = await findPrincipalByUsername(input.db, 'root')
  if (!principal || principal.disabled || principal.kind !== 'root') return fail('PRECONDITION_FAILED', 'an active root principal is required for scheduled alert checks')
  const response = await input.agentApp.fetch(new Request('http://agent.local/host/server-health', { headers: agentCallerHeaders({ principalId: principal.id, token: input.agentToken }) }))
  const text = await response.text()
  if (!response.ok || text.length > 1024 * 1024) return fail('SERVICE_UNAVAILABLE', 'the protected host response could not be verified')
  return JSON.parse(text)
}

/**
 * In-process schedule in the API service (no extra daemon or timer unit): one cycle every ALERT_SCHEDULE_MINUTES, never two at once.
 * Each cycle runs under a fresh lifecycle writer admission, as long-lived timers must (scripts/lifecycle-admission.mjs).
 */
export function startAlertScheduler(input: {
  db: Db; store: Store; agentApp: AgentApp; agentToken: string; admit: <T>(task: () => Promise<T>) => Promise<T>; everyMs?: number; onError?: (error: unknown) => void
  /** Tests replace the network transports; production builds them from the server hostname on every cycle. */
  transports?: DeliveryTransports
}): { stop: () => Promise<void> } {
  let running: Promise<unknown> | null = null, stopped = false
  const tick = (): void => {
    if (running || stopped) return
    running = input.admit(async () => runScheduledAlertCycle({ ...alertStateFiles(input.store), transports: input.transports ?? await alertTransports(input.store), readHost: () => readServerHealthAsRoot(input) }))
      .catch(error => input.onError?.(error)).finally(() => { running = null })
  }
  const timer = setInterval(tick, input.everyMs ?? ALERT_SCHEDULE_MINUTES * 60_000)
  timer.unref()
  return { stop: async () => { stopped = true; clearInterval(timer); await running } }
}
