import { effectiveServerSshSettings } from '@xpanel/core'
import type { ServerSettings } from '@xpanel/core'
import { dispatchAlertNotices, EMPTY_DELIVERY_STATE, loginNotice, readSavedDeliveryState, serialDelivery } from './alert-delivery.ts'
import type { AlertNotice, DeliveryChannels, DeliveryState, DeliveryTransports } from './alert-delivery.ts'

/** Extended state: the journal cursor of the last reported login. Desired state, the switch, lives in server.json. */
export const SSH_ALARM_FILE = 'security/ssh-login-alarm.json'
export const SSH_ALARM_EVERY_MS = 60_000

export interface SshAlarmCycle {
  readSettings: () => Promise<ServerSettings | null>
  readState: () => Promise<unknown>
  writeState: (value: { cursor: string | null }) => Promise<unknown>
  /** GET /host/security/ssh/logins as root, from the cursor when there is one. */
  readLogins: (cursor: string | null) => Promise<unknown>
  readDelivery: () => Promise<unknown>
  writeDelivery: (value: unknown) => Promise<unknown>
  readChannels: () => Promise<DeliveryChannels | null>
  transports: DeliveryTransports
  now?: () => Date
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const cursorOf = (value: unknown): string | null => object(value) && typeof value.cursor === 'string' ? value.cursor : null

/** The journal entry names each notice, so a retried cycle cannot report one login twice. */
export function loginNoticesOf(value: unknown, now: Date): { cursor: string | null; notices: AlertNotice[] } | null {
  if (!object(value) || !(value.cursor === null || text(value.cursor, 256)) || !Array.isArray(value.items) || value.items.length > 2000) return null
  const notices: AlertNotice[] = []
  for (const raw of value.items) {
    if (!object(raw) || !text(raw.id, 256) || !text(raw.at, 40) || !Number.isFinite(Date.parse(raw.at)) || !text(raw.address, 64) || !text(raw.username, 64) || !text(raw.method, 64) || !Number.isInteger(raw.port)) return null
    notices.push(loginNotice({ id: raw.id, at: new Date(raw.at).toISOString(), address: raw.address, port: raw.port as number, username: raw.username, method: raw.method }, now))
  }
  return { cursor: value.cursor as string | null, notices }
}

/** One cycle: nothing runs while the switch is off; each new login becomes one notice on the panel's channels, and the cursor then moves past it. */
export async function runSshLoginAlarmCycle(helpers: SshAlarmCycle): Promise<void> {
  if (!effectiveServerSshSettings(await helpers.readSettings()).loginAlarm) return
  const cursor = cursorOf(await helpers.readState()), now = (helpers.now ?? (() => new Date()))()
  const read = loginNoticesOf(await helpers.readLogins(cursor), now)
  if (!read) return
  await serialDelivery(async () => {
    const delivery: DeliveryState = readSavedDeliveryState(await helpers.readDelivery()) ?? EMPTY_DELIVERY_STATE
    const told = new Set([...delivery.log.map(entry => entry.noticeId), ...delivery.outbox.map(entry => entry.notice.id)])
    // quiet holds every other alert for its window; a login is reported at once.
    await helpers.writeDelivery(await dispatchAlertNotices({ state: delivery, notices: read.notices.filter(notice => !told.has(notice.id)), channels: await helpers.readChannels(), transports: helpers.transports, now, quiet: true }))
    if (read.cursor !== null) await helpers.writeState({ cursor: read.cursor })
  })
}
