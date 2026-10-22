import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { groups, specs, tools } from './data/index.ts'
import { catalogKeys } from './i18n.ts'
import arCatalog from './locales/ar.json' with { type: 'json' }

const ar: Record<string, string> = arCatalog
import { readyTools } from './data/ready.ts'
import { isVisible } from './visibility.ts'
import type { CatalogTool } from './types.ts'

const ACLS = new Set([
  'create-account', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan', 'manage-plans',
  'manage-feature-lists', 'manage-dns', 'manage-ssl', 'change-password', 'list-accounts', 'allow-unlimited-plans',
  'allow-oversell', 'transfer',
])

const root: Principal = { kind: 'root', id: 'r', username: 'root' }
const reseller: Principal = { kind: 'reseller', id: 'rs1', username: 'reseller1' }
const user: Principal = { kind: 'user', id: 'u1', username: 'alice', accountId: 'a1' }

const ready = (over: Partial<CatalogTool>): CatalogTool => ({
  id: 't', surface: 'xpanel', groupId: 'files', name: 'T', summary: '', featureKey: 'filemanager',
  resellerAcl: null, rootOnly: false, entity: 'file', acceptanceTest: 'test', status: 'ready', ...over,
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

  it('only declares readiness for existing, in-scope tools', () => {
    const byId = new Map(tools.map(t => [t.id, t]))
    for (const id of Object.keys(readyTools)) expect(byId.get(id)?.status, id).toBe('ready')
  })
})

describe('visibility', () => {
  it('never shows planned or out-of-scope tools', () => {
    expect(isVisible(ready({ status: 'planned' }), { principal: root })).toBe(false)
    expect(isVisible(ready({ status: 'out-of-scope' }), { principal: user })).toBe(false)
  })

  it('hides xPanel tools disabled by the feature list', () => {
    const t = ready({})
    expect(isVisible(t, { principal: user })).toBe(true)
    expect(isVisible(t, { principal: user, disabledFeatures: new Set(['filemanager']) })).toBe(false)
  })

  it('shows account tools only to account owners and server tools only to root/resellers', () => {
    expect(isVisible(ready({}), { principal: root })).toBe(false)
    expect(isVisible(ready({ surface: 'xwhm', featureKey: null }), { principal: user })).toBe(false)
  })

  it('gates xWHM tools by reseller ACL and hides root-only tools from resellers', () => {
    const dns = ready({ surface: 'xwhm', featureKey: null, resellerAcl: 'manage-dns' })
    expect(isVisible(dns, { principal: reseller, reseller: { acl: [] } })).toBe(false)
    expect(isVisible(dns, { principal: reseller, reseller: { acl: ['manage-dns'] } })).toBe(true)
    expect(isVisible(ready({ surface: 'xwhm', featureKey: null, rootOnly: true }), { principal: reseller, reseller: { acl: ['manage-dns'] } })).toBe(false)
    expect(isVisible(ready({ surface: 'aapanel', featureKey: null, rootOnly: true }), { principal: root })).toBe(true)
  })
})
