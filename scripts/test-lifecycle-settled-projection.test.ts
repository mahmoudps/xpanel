import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { isSettledControlPlaneProjection, queueWriterRestart } from './lifecycle-root-safety.mjs'

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

describe('writers after retirement', () => {
  it('queues the agent, then the API, out of quarantine', async () => {
    const calls: string[][] = []
    await queueWriterRestart(async (path, args) => { calls.push([path, ...args]); return { code: 0 } })
    expect(calls).toEqual([
      ['/usr/bin/systemctl', 'restart', '--no-block', 'xpanel-agent.service'],
      ['/usr/bin/systemctl', 'restart', '--no-block', 'xpanel-api.service'],
    ])
  })

  it('reports a refused restart and still tries the next writer, because retirement is already final', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const calls: string[] = []
    await queueWriterRestart(async (_path, args) => { calls.push(args.at(-1)!); if (calls.length === 1) throw new Error('refused'); return { code: 1 } })
    expect(calls).toEqual(['xpanel-agent.service', 'xpanel-api.service'])
    expect(stderr.mock.calls.filter(call => String(call[0]).includes('LIFECYCLE_WRITER_RESTART_REFUSED'))).toHaveLength(2)
    stderr.mockRestore()
  })

  it('restarts only after settlement removed the barrier', () => {
    const source = readFileSync(new URL('./lifecycle-root-safety.mjs', import.meta.url), 'utf8')
    expect(source.indexOf('await queueWriterRestart(')).toBeGreaterThan(source.indexOf("ROOT + '/writer-barrier.json']) {"))
  })
})
