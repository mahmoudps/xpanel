import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { deliveryTarget } from './data/delivery.ts'
import { specs, tools, unqualifiedTools } from './data/index.ts'
import { visibleNavigation } from './navigation.ts'
import { HOST_PROBES, PHASE1_TOOL_PROBES, qualifyHostTools } from './host-qualification.ts'
import { isToolAuthorized, isVisible } from './visibility.ts'
import type { CatalogTool } from './types.ts'

const owner: Principal = { kind: 'user', id: 'owner-id', username: 'alice', accountId: 'account-id' }
const ownerContext = { principal: owner, disabledFeatures: new Set<string>() }
const definition = (id: string): CatalogTool => { const found = unqualifiedTools.find(tool => tool.id === id); if (!found) throw new Error('Missing real catalog entry ' + id); return found }
const bounded = () => definition('domain-htaccess')
const legacy = () => definition('aapanel-url-rewrite')
// Synthetic qualification exercises policy only; no delivery evidence is manufactured.
const qualified = (tool: CatalogTool): CatalogTool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified', evidence: [] } })
const routes = (catalog: readonly CatalogTool[], context = ownerContext): string[] => visibleNavigation(context, catalog).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))

describe('bounded account rewrite contract', () => {
  it('adds a researched owner file workflow without promoting it or the broad server contract', () => {
    expect(bounded()).toMatchObject({ surface: 'xpanel', groupId: 'software', featureKey: 'aapanel-url-rewrite', rootOnly: false, status: 'researched', delivery: { status: 'researched', evidence: [] } })
    expect(legacy()).toMatchObject({ surface: 'aapanel', rootOnly: true, status: 'researched', delivery: { status: 'researched', evidence: [] } })
    expect(specs.filter(spec => spec.id === 'domain-htaccess')).toHaveLength(1)
    expect(specs.find(spec => spec.id === 'domain-htaccess')!.source).toBe('xpanel:native')
    if (deliveryTarget === null) {
      expect(tools.filter(tool => tool.status === 'verified')).toEqual([])
      expect(tools.find(tool => tool.id === 'aapanel-url-rewrite')?.status).toBe('researched')
    }
    expect(isToolAuthorized(bounded(), ownerContext)).toBe(true)
    expect(isVisible(bounded(), ownerContext)).toBe(false)
    expect(routes([bounded(), legacy()])).not.toContain('/software/htaccess')
  })
  it('does not change the aaPanel audience even under synthetic qualification', () => {
    expect(isToolAuthorized(qualified(legacy()), ownerContext)).toBe(false)
    expect(isToolAuthorized(qualified(legacy()), { principal: { kind: 'root', id: 'root-id', username: 'root' } })).toBe(true)
    expect(isToolAuthorized(qualified(legacy()), { principal: { kind: 'reseller', id: 'rs-id', username: 'reseller' }, reseller: { acl: ['edit-account'] } })).toBe(false)
    expect(routes([qualified(legacy())])).not.toContain('/software/htaccess')
  })
  it('opens only the owner core when it has independently supplied synthetic delivery status', () => {
    expect(routes([qualified(bounded()), legacy()])).toContain('/software/htaccess')
    expect(routes([qualified(bounded())])).toContain('/software/htaccess')
    expect(routes([qualified(legacy())])).not.toContain('/software/htaccess')
    expect(routes([{ ...qualified(bounded()), delivery: { ...bounded().delivery, status: 'researched' } }])).not.toContain('/software/htaccess')
  })
  it.each(['domain-htaccess', 'aapanel-url-rewrite'])('preserves an explicit %s feature denial in metadata and live navigation', id => {
    const context = { principal: owner, disabledFeatures: new Set([id]) }
    expect(isToolAuthorized(bounded(), context)).toBe(false)
    expect(routes([qualified(bounded())], context)).not.toContain('/software/htaccess')
  })
  it('fails closed for missing policy and a team-derived empty tool grant', () => {
    expect(isToolAuthorized(bounded(), { principal: owner })).toBe(false)
    expect(isToolAuthorized(bounded(), { ...ownerContext, allowedToolIds: new Set<string>() })).toBe(false)
  })
})


it('does not certify the bounded rewrite contract from a synthetic healthy host report', () => {
  const report = { executor: 'linux' as const, probes: Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed' as const])) }
  expect(PHASE1_TOOL_PROBES['domain-htaccess']).toEqual(['control-plane', 'files', 'apache'])
  const observed = qualifyHostTools([bounded()], report, true)
  expect(observed[0]!.status).toBe('researched')
  expect(observed[0]!.delivery.status).toBe('researched')
  // Separately supplied acceptance is retained only while the confined file helper and Apache probes pass.
  expect(qualifyHostTools([qualified(bounded())], report, true)[0]!.status).toBe('verified')
  for (const probe of ['files', 'apache'] as const) {
    expect(qualifyHostTools([qualified(bounded())], { ...report, probes: { ...report.probes, [probe]: 'failed' as const } }, true)[0]!.status, probe).toBe('researched')
  }
})
