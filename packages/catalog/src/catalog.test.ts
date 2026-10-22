import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { groups, specs, tools } from './data/index.ts'
import { catalogKeys } from './i18n.ts'
import arCatalog from './locales/ar.json' with { type: 'json' }

const ar: Record<string, string> = arCatalog
import { isVisible, visibleTools } from './visibility.ts'
import type { CatalogTool } from './types.ts'

const ACLS = new Set([
  'create-account', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan', 'manage-plans',
  'manage-feature-lists', 'manage-dns', 'manage-ssl', 'change-password', 'list-accounts', 'allow-unlimited-plans',
  'allow-oversell', 'transfer',
])

const root: Principal = { kind: 'root', id: 'r', username: 'root' }
const reseller: Principal = { kind: 'reseller', id: 'rs1', username: 'reseller1' }
const user: Principal = { kind: 'user', id: 'u1', username: 'alice', accountId: 'a1' }

const verified = (over: Partial<CatalogTool>): CatalogTool => ({
  id: 't', surface: 'xpanel', groupId: 'files', name: 'T', summary: '', featureKey: 'filemanager',
  resellerAcl: null, rootOnly: false, entity: 'file', status: 'verified', delivery: { status: 'verified', reason: 'Synthetic visibility fixture.', evidence: [] }, ...over,
})

describe('catalog data', () => {
  it('has unique tool and group ids', () => {
    expect(new Set(tools.map(t => t.id)).size).toBe(tools.length)
    expect(new Set(groups.map(g => g.id)).size).toBe(groups.length)
  })

  it('places every tool in a known group of the same surface', () => {
    const bySurface = new Map(groups.map(g => [g.id, g.surface]))
    for (const t of tools) expect(bySurface.get(t.groupId), t.id).toBe(t.surface)
  })

  it('gives every account-facing tool a feature key and every ACL a known value', () => {
    for (const t of tools) {
      if (t.surface === 'xpanel' || t.surface === 'xmail') expect(t.featureKey, t.id).toBeTruthy()
      if (t.resellerAcl !== null) expect(ACLS.has(t.resellerAcl), t.id).toBe(true)
    }
  })

  it('keeps one spec per tool', () => {
    expect(specs.map(s => s.id).sort()).toEqual(tools.map(t => t.id).sort())
  })

  it('marks excluded products out of scope', () => {
    const excluded = tools.filter(t => /wp toolkit|imunify|sitejet|softaculous/i.test(t.name))
    expect(excluded.length).toBeGreaterThan(0)
    for (const t of excluded) expect(t.status, t.id).toBe('out-of-scope')
  })

  it('has an Arabic translation for every group and in-scope tool name', () => {
    const missing = [
      ...groups.map(g => catalogKeys.groupName(g.id)),
      ...tools.filter(t => t.status !== 'out-of-scope').map(t => catalogKeys.toolName(t.id)),
    ].filter(key => !ar[key]?.trim())
    expect(missing).toEqual([])
  })

  it('reviews every definition without promoting declarations to verified delivery', () => {
    expect(tools).toHaveLength(593)
    expect(tools.filter(tool => tool.status === 'researched')).toHaveLength(530)
    expect(tools.filter(tool => tool.status === 'out-of-scope')).toHaveLength(63)
    expect(tools.filter(tool => tool.status === 'verified')).toEqual([])
    for (const tool of tools) {
      expect(tool.status).toBe(tool.delivery.status)
      expect(tool.delivery.reason.trim(), tool.id).not.toBe('')
      expect(tool.delivery.evidence, tool.id).toEqual([])
    }
  })
})

describe('visibility', () => {
  it('never shows unverified or out-of-scope tools', () => {
    expect(isVisible(verified({ status: 'researched' }), { principal: root })).toBe(false)
    expect(isVisible(verified({ status: 'out-of-scope' }), { principal: user, disabledFeatures: new Set() })).toBe(false)
  })

  it('denies feature-gated verified tools when feature authority is missing', () => {
    expect(isVisible(verified({}), { principal: user })).toBe(false)
    expect(isVisible(verified({}), { principal: user, disabledFeatures: new Set() })).toBe(true)
    expect(isVisible(verified({ featureKey: null }), { principal: user })).toBe(true)
  })

  it('hides xPanel tools disabled by the feature list', () => {
    const t = verified({})
    expect(isVisible(t, { principal: user, disabledFeatures: new Set() })).toBe(true)
    expect(isVisible(t, { principal: user, disabledFeatures: new Set(['filemanager']) })).toBe(false)
  })

  it('shows account tools only to account owners and server tools only to root/resellers', () => {
    expect(isVisible(verified({}), { principal: root })).toBe(false)
    expect(isVisible(verified({ surface: 'xwhm', featureKey: null }), { principal: user, disabledFeatures: new Set() })).toBe(false)
  })

  it('gates xWHM tools by reseller ACL and hides root-only tools from resellers', () => {
    const dns = verified({ surface: 'xwhm', featureKey: null, resellerAcl: 'manage-dns' })
    expect(isVisible(dns, { principal: reseller, reseller: { acl: [] } })).toBe(false)
    expect(isVisible(dns, { principal: reseller, reseller: { acl: ['manage-dns'] } })).toBe(true)
    expect(isVisible(verified({ surface: 'xwhm', featureKey: null, rootOnly: true }), { principal: reseller, reseller: { acl: ['manage-dns'] } })).toBe(false)
    expect(isVisible(verified({ surface: 'aapanel', featureKey: null, rootOnly: true }), { principal: root })).toBe(true)
  })

  it('does not display the unverified production catalog', () => {
    expect(visibleTools(tools, { principal: root })).toEqual([])
    expect(visibleTools(tools, { principal: reseller, reseller: { acl: ['manage-dns'] } })).toEqual([])
    expect(visibleTools(tools, { principal: user, disabledFeatures: new Set() })).toEqual([])
  })

  it('filters verified fixtures by role, ACL and feature state', () => {
    const fixtures = [
      verified({ id: 'file-manager' }),
      verified({ id: 'dns', surface: 'xwhm', featureKey: null, resellerAcl: 'manage-dns' }),
      verified({ id: 'root', surface: 'xwhm', featureKey: null, rootOnly: true }),
    ]
    expect(visibleTools(fixtures, { principal: root }).map(tool => tool.id)).toEqual(['dns', 'root'])
    expect(visibleTools(fixtures, { principal: reseller, reseller: { acl: [] } })).toEqual([])
    expect(visibleTools(fixtures, { principal: reseller, reseller: { acl: ['manage-dns'] } }).map(tool => tool.id)).toEqual(['dns'])
    expect(visibleTools(fixtures, { principal: user, disabledFeatures: new Set() }).map(tool => tool.id)).toEqual(['file-manager'])
    expect(visibleTools(fixtures, { principal: user, disabledFeatures: new Set(['filemanager']) })).toEqual([])
  })

  it('does not accept a status label that disagrees with delivery evidence', () => {
    expect(isVisible(verified({ delivery: { status: 'researched', reason: 'No evidence.', evidence: [] } }), { principal: user, disabledFeatures: new Set() })).toBe(false)
  })
})
