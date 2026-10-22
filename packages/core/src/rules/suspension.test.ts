import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { AccountStatus } from '../types.ts'
import { LOGIN_SUBSYSTEMS, domainServingState, isSuspended, sliceUnit, suspensionEffects } from './suspension.ts'
import type { SuspensionEffect } from './suspension.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const byKey = (effects: SuspensionEffect[]) => Object.fromEntries(effects.map((e) => [e.subsystem, e.state]))
const acct = (status: AccountStatus, uid = 1001) => ({ status, uid })

describe('suspensionEffects', () => {
  it('suspended: site shows the suspended page, units stop, cron off, logins denied, mail still delivered', () => {
    const fx = suspensionEffects(acct('suspended'))
    expect(byKey(fx)).toEqual({
      'panel-login': 'denied',
      'shell-login': 'denied',
      'ftp-login': 'denied',
      'webdisk-login': 'denied',
      'mail-login': 'denied',
      'database-login': 'denied',
      cron: 'disabled',
      slice: 'stopped',
      vhost: 'suspended-page',
      'mail-delivery': 'accept',
    })
    expect(fx.find((e) => e.subsystem === 'slice')).toMatchObject({ unit: 'xpanel-1001.slice' })
  })

  it('active: everything back on', () => {
    const fx = byKey(suspensionEffects(acct('active')))
    expect(fx.vhost).toBe('serving')
    expect(fx.slice).toBe('running')
    expect(fx.cron).toBe('enabled')
    expect(fx['mail-delivery']).toBe('accept')
    for (const s of LOGIN_SUBSYSTEMS) expect(fx[s]).toBe('allowed')
  })

  it('terminating behaves as suspended but defers mail', () => {
    const fx = byKey(suspensionEffects(acct('terminating')))
    expect(fx.vhost).toBe('suspended-page')
    expect(fx['mail-login']).toBe('denied')
    expect(fx['mail-delivery']).toBe('defer')
  })

  it('covers every subsystem exactly once in both states', () => {
    const subsystems = (s: AccountStatus) => suspensionEffects(acct(s)).map((e) => e.subsystem).sort()
    expect(subsystems('active')).toEqual(subsystems('suspended'))
    expect(new Set(subsystems('active')).size).toBe(subsystems('active').length)
  })

  it('orders suspension as cut access, stop processes, then swap the site', () => {
    const order = suspensionEffects(acct('suspended')).map((e) => e.subsystem)
    expect(order.indexOf('panel-login')).toBeLessThan(order.indexOf('slice'))
    expect(order.indexOf('cron')).toBeLessThan(order.indexOf('slice'))
    expect(order.indexOf('slice')).toBeLessThan(order.indexOf('vhost'))
    const up = suspensionEffects(acct('active')).map((e) => e.subsystem)
    expect(up.indexOf('slice')).toBeLessThan(up.indexOf('vhost'))
    expect(up.indexOf('vhost')).toBeLessThan(up.indexOf('panel-login'))
  })

  it('rejects bad uids and unknown statuses', () => {
    for (const uid of [0, 999, -1, 1.5, 4_294_967_295, Number.NaN]) expect(code(() => suspensionEffects(acct('active', uid)))).toBe('VALIDATION')
    expect(code(() => suspensionEffects(acct('frozen' as AccountStatus)))).toBe('VALIDATION')
    expect(code(() => suspensionEffects(null as unknown as ReturnType<typeof acct>))).toBe('VALIDATION')
    expect(sliceUnit(1000)).toBe('xpanel-1000.slice')
  })

  it('refuses uids that belong to nobody, the 16-bit -1 or systemd reserved ranges', () => {
    expect(sliceUnit(60_000)).toBe('xpanel-60000.slice')
    for (const uid of [60_001, 61_184, 65_534, 65_535, 524_288, 4_294_967_294]) expect(code(() => sliceUnit(uid))).toBe('VALIDATION')
    expect(code(() => sliceUnit('1001' as unknown as number))).toBe('VALIDATION')
  })

  it('isSuspended is true for anything but active', () => {
    expect(isSuspended({ status: 'active' })).toBe(false)
    expect(isSuspended({ status: 'suspended' })).toBe(true)
    expect(isSuspended({ status: 'terminating' })).toBe(true)
  })
})

describe('domainServingState', () => {
  const now = new Date('2026-10-22T00:00:00Z')

  it('account flag wins over the domain', () => {
    expect(domainServingState({ status: 'suspended' }, { suspended: false, expiresAt: null }, now)).toBe('suspended')
  })

  it('domain stop and expiry', () => {
    expect(domainServingState({ status: 'active' }, { suspended: true, expiresAt: null }, now)).toBe('suspended')
    expect(domainServingState({ status: 'active' }, { suspended: false, expiresAt: '2026-10-21T23:59:59Z' }, now)).toBe('expired')
    expect(domainServingState({ status: 'active' }, { suspended: false, expiresAt: '2026-10-22T00:00:00Z' }, now)).toBe('expired')
    expect(domainServingState({ status: 'active' }, { suspended: false, expiresAt: '2027-01-01T00:00:00Z' }, now)).toBe('serving')
    expect(domainServingState({ status: 'active' }, { suspended: false, expiresAt: null }, now)).toBe('serving')
  })

  it('fails closed on an unparsable expiry', () => {
    expect(domainServingState({ status: 'active' }, { suspended: false, expiresAt: 'soon' }, now)).toBe('expired')
  })
})
