import { describe, expect, it } from 'vitest'
import { isSettledControlPlaneProjection } from './lifecycle-root-safety.mjs'

const unit = (Id: string, ActiveState: string, MainPID = '0') => ({ Id, ActiveState, MainPID, ControlPID: '0' })
const api = unit('xpanel-api.service', 'active', '10')
const agent = unit('xpanel-agent.service', 'active', '11')
const timer = unit('xpanel-management-tls.timer', 'active')
const renewal = unit('xpanel-management-tls.service', 'inactive')
const settled = (...units: unknown[]) => isSettledControlPlaneProjection({ observations: [{ units }] })

describe('settled control plane projection', () => {
  it('accepts a running control plane beside a renewal run that finished, even a failed one', () => {
    expect(settled(api, agent, renewal, timer)).toBe(true)
    expect(settled(api, agent, unit('xpanel-management-tls.service', 'failed'), timer)).toBe(true)
  })

  it('refuses a failed renewal run that still holds a process', () => {
    expect(settled(api, agent, unit('xpanel-management-tls.service', 'failed', '12'), timer)).toBe(false)
    expect(settled(api, agent, { ...unit('xpanel-management-tls.service', 'failed'), ControlPID: '13' }, timer)).toBe(false)
  })

  it('refuses a stopped or failed writer and a failed timer', () => {
    expect(settled(unit('xpanel-api.service', 'failed'), agent, renewal, timer)).toBe(false)
    expect(settled(api, unit('xpanel-agent.service', 'inactive'), renewal, timer)).toBe(false)
    expect(settled(api, agent, renewal, unit('xpanel-management-tls.timer', 'failed'))).toBe(false)
  })

  it('refuses a missing unit', () => {
    expect(settled(api, agent, renewal)).toBe(false)
  })
})
