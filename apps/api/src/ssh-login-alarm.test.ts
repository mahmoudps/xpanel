import { describe, expect, it, vi } from 'vitest'
import { alertMessage, alertPayload, EMPTY_DELIVERY_STATE, readSavedDeliveryState } from './alert-delivery.ts'
import type { DeliveryState } from './alert-delivery.ts'
import { runSshLoginAlarmCycle } from './ssh-login-alarm.ts'

const login = (id: string) => ({ id, at: '2026-11-07T10:00:00.000Z', address: '203.0.113.7', port: 50022, username: 'root', method: 'publickey' })
const on = { ssh: { loginAlarm: true } } as never
const channels = { alerts: false, recipients: [], webhook: { url: 'https://hooks.example.test/x', key: 'k'.repeat(32) } }
const setup = (settings: unknown = on) => {
  const webhook = vi.fn(async (_: { body: string }) => ({ status: 200 })), saved: { delivery: DeliveryState | null; cursor: unknown } = { delivery: null, cursor: { cursor: 'c0' } }
  const read = vi.fn(async (_cursor: string | null): Promise<unknown> => ({ cursor: 'c1', items: [login('e1')], complete: true }))
  const helpers = { readSettings: async () => settings as never, readState: async () => saved.cursor, writeState: async (value: unknown) => { saved.cursor = value }, readLogins: read,
    readDelivery: async () => saved.delivery, writeDelivery: async (value: unknown) => { saved.delivery = value as DeliveryState }, readChannels: async () => channels,
    transports: { serverName: 'srv.example.test', email: vi.fn(async () => {}), webhook } as never, now: () => new Date('2026-11-07T10:01:00.000Z') }
  return { helpers, webhook, read, saved }
}

describe('SSH login alarm', { tags: ['unit'] }, () => {
  it('reads nothing while the switch is off', async () => {
    const { helpers, read } = setup({})
    await runSshLoginAlarmCycle(helpers)
    expect(read).not.toHaveBeenCalled()
  })

  it('sends one webhook per login with the address, and moves the cursor past it', async () => {
    const { helpers, webhook, read, saved } = setup()
    await runSshLoginAlarmCycle(helpers)
    expect(read).toHaveBeenCalledWith('c0')
    expect(webhook).toHaveBeenCalledTimes(1)
    expect(JSON.parse(webhook.mock.calls[0]![0].body)).toMatchObject({ event: 'ssh.login', server: 'srv.example.test', login: { user: 'root', address: '203.0.113.7', port: 50022, method: 'publickey', at: '2026-11-07T10:00:00.000Z' } })
    expect(saved.cursor).toEqual({ cursor: 'c1' })
    expect(readSavedDeliveryState(saved.delivery)).not.toBeNull()
  })

  it('never reports one journal entry twice, even when the cursor write was lost', async () => {
    const { helpers, webhook, saved } = setup()
    await runSshLoginAlarmCycle(helpers)
    saved.cursor = { cursor: 'c0' }
    await runSshLoginAlarmCycle(helpers)
    expect(webhook).toHaveBeenCalledTimes(1)
  })

  it('holds the cursor when the host read cannot be verified', async () => {
    const { helpers, read, saved, webhook } = setup()
    read.mockResolvedValueOnce({ cursor: 'c9', items: [{ id: 'x' }] })
    await runSshLoginAlarmCycle(helpers)
    expect(webhook).not.toHaveBeenCalled()
    expect(saved.cursor).toEqual({ cursor: 'c0' })
  })

  it('logs a login with no channel as no_channel, and retries a refused delivery', async () => {
    const { helpers, saved, webhook } = setup()
    await runSshLoginAlarmCycle({ ...helpers, readChannels: async () => null })
    expect(saved.delivery?.log[0]).toMatchObject({ kind: 'login', result: 'no_channel' })
    saved.delivery = EMPTY_DELIVERY_STATE
    webhook.mockResolvedValueOnce({ status: 500 })
    await runSshLoginAlarmCycle(helpers)
    expect(saved.delivery?.outbox).toHaveLength(1)
  })

  it('keeps other alerts held in their quiet window', async () => {
    const { helpers, saved, webhook } = setup()
    const firing = { id: 'aln_' + 'a'.repeat(24), kind: 'firing', ruleId: 'load', severity: 'warning', firstFiredAt: '2026-11-07T09:00:00.000Z', evaluatedAt: '2026-11-07T09:00:00.000Z', value: null, threshold: null, matches: [], evidence: '' } as const
    saved.delivery = { ...EMPTY_DELIVERY_STATE, outbox: [{ notice: { ...firing, matches: [] }, channel: 'webhook', attempts: 0, nextAt: '2026-11-07T09:00:00.000Z' }] }
    await runSshLoginAlarmCycle(helpers)
    expect(webhook).toHaveBeenCalledTimes(1)
    expect(saved.delivery?.outbox.map(item => item.notice.kind)).toEqual(['firing'])
  })

  it('writes the mail with the source address, user and time', () => {
    const notice = { id: 'aln_' + 'b'.repeat(24), kind: 'login', ruleId: null, severity: null, firstFiredAt: '2026-11-07T10:00:00.000Z', evaluatedAt: '2026-11-07T10:01:00.000Z', value: null, threshold: null, matches: ['root', '203.0.113.7', '50022', 'publickey'], evidence: '' } as const
    const mail = alertMessage({ ...notice, matches: [...notice.matches] }, 'srv.example.test')
    expect(mail.subject).toContain('root from 203.0.113.7')
    expect(mail.text).toContain('Time: 2026-11-07 10:00 UTC')
    expect(alertPayload({ ...notice, matches: [...notice.matches] }, 'srv.example.test').alert).toBeNull()
  })
})
