import { describe, expect, it } from 'vitest'
import { accountWarnings } from './account-notices.ts'

const MB = 1024 * 1024
describe('account warnings', () => {
  it('warns from 80 percent and is critical from 95', () => {
    expect(accountWarnings({ diskBytes: 79 * MB, diskMb: 100 })).toEqual([])
    expect(accountWarnings({ diskBytes: 80 * MB, diskMb: 100 })).toEqual([{ id: 'disk', level: 'warning', percent: 80 }])
    expect(accountWarnings({ bandwidthBytes: 96 * MB, bandwidthMb: 100 })).toEqual([{ id: 'bandwidth', level: 'critical', percent: 96 }])
  })

  it('invents nothing from a missing measurement or an unlimited plan', () => {
    expect(accountWarnings({ diskBytes: null, diskMb: 100 })).toEqual([])
    expect(accountWarnings({ diskBytes: 999 * MB, diskMb: 'unlimited' })).toEqual([])
    expect(accountWarnings({ diskBytes: 999 * MB, diskMb: 0 })).toEqual([])
  })

  it('honours the switches', () => {
    expect(accountWarnings({ diskBytes: 99 * MB, diskMb: 100 }, { notifications: { disk: false, bandwidth: true, announcements: true }, onboardingDismissed: false })).toEqual([])
  })
})
