import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderV2PanelResources } from './resources.ts'
import type { PanelPageProps } from './home.ts'

const account: Account = {
  id: 'private-account-key', username: 'sam', uid: 20031, gid: 20031, home: '/home/sam', primaryDomain: 'sam.test',
  planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@sam.test',
  ipv4: '192.0.2.31', shell: 'none', createdAt: '2026-10-22T00:00:00Z',
}
const plan = defaultPlan({ id: account.planId })
const props = (more: Partial<PanelPageProps> = {}): PanelPageProps => ({ account, plan, ...more })

describe('v2 account resources', () => {
  it('labels the real matching stored plan without accepting a foreign plan name', () => {
    const saved = { ...plan, name: 'Saved plan' }
    expect(renderV2PanelResources(props({ plan: saved }))).toContain('Saved plan')
    expect(renderV2PanelResources(props({ plan: { ...saved, id: 'foreign-plan' } }))).not.toContain('Saved plan')
    expect(renderV2PanelResources({ plan: saved })).not.toContain('Saved plan')
  })
  it('retains history, limits, events, processes and folder sections without manufacturing readings', () => {
    const html = renderV2PanelResources(props())
    for (const heading of ['CPU usage', 'Memory usage', 'Plan, applied limit and usage', 'Disk IO history', 'Limit events', 'Site service configuration', 'Processes in your slice', 'Disk usage by folder']) expect(html).toContain(heading)
    expect(html).toContain('No samples or peak values are inferred')
    expect(html).toContain('A file listing is not a recursive quota measurement.')
    expect(html).not.toContain('<svg role="img"')
    expect(html).not.toContain('14:05')
    expect(html).not.toContain('Every 10')
  })

  it('separates plan values, applied readback and measured values', () => {
    const html = renderV2PanelResources(props({ usage: { phpVersion: '8.3', diskBytes: 1048576, memoryBytes: 0, processCount: 0, bandwidth: 'unmeasured', ioEnforced: true } }))
    expect(html).toContain('5120 MiB')
    expect(html).toContain('<bdi dir="ltr" data-resource-value>1 MiB</bdi>')
    expect(html).toContain('<bdi dir="ltr" data-resource-value>0 MiB</bdi>')
    expect(html).toContain('Applied values need host readback.')
    expect(html).toContain('Verified for this sample')
    expect(html).not.toContain('Filesystem quota enforced')
    expect(html).not.toContain('MemoryMax on your slice')
  })

  it('rejects invalid numeric readings without turning them into measured zero', () => {
    const html = renderV2PanelResources(props({ usage: { phpVersion: null, diskBytes: -1, memoryBytes: NaN, processCount: 1.5, bandwidth: 'unmeasured' } }))
    expect(html).not.toContain('data-resource-state="measured"')
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('-1 B')
    expect(html).not.toContain('1.5</bdi>')
  })

  it('keeps unlimited and zero limits distinct and does not apply a foreign plan', () => {
    const html = renderV2PanelResources(props({ plan: { ...plan, resources: { ...plan.resources, diskMb: 'unlimited', memoryMb: 0 } } }))
    expect(html).toContain('Unlimited')
    expect(html).toContain('<bdi dir="ltr">0 MiB</bdi>')
    expect(renderV2PanelResources(props({ plan: { ...plan, id: 'foreign' } }))).not.toContain('5120 MiB')
  })

  it('does not expose refresh as an executable action without a real reader', () => {
    const html = renderV2PanelResources(props())
    expect(html).toContain('disabled data-wiring="soon" aria-describedby="v2-resource-refresh-note"')
    expect(html).toContain('id="v2-resource-refresh-note"')
    expect(html).not.toContain('data-action="refresh"')
  })

  it('shows the observed IO mismatch rather than assuming an enforced cap', () => {
    const html = renderV2PanelResources(props({ usage: { phpVersion: null, diskBytes: null, memoryBytes: null, processCount: null, bandwidth: 'unmeasured', ioEnforced: false } }))
    expect(html).toContain('Observed mismatch')
    expect(html).toContain('Not reported by the agent')
    expect(html).not.toContain('IO cap enforced')
  })

  it('renders no selected account values when the core account is absent', () => {
    const html = renderV2PanelResources({})
    expect(html).toContain('v2-resource-limits')
    expect(html).toContain('v2-resource-processes-title')
    expect(html).toContain('Not read')
    expect(html).not.toContain('xpanel-')
  })

  it('keeps slice and account limits in semantic row groups with aligned columns', () => {
    const html = renderV2PanelResources(props())
    expect(html.match(/scope="rowgroup" colspan="5"/g)).toHaveLength(2)
    expect(html.match(/scope="row"/g)).toHaveLength(12)
    expect(html).toContain('Slice limits')
    expect(html).toContain('Account quotas')
    expect(html).toContain('aria-labelledby="v2-resource-limits-caption"')
  })
})
