import { describe, expect, it } from 'vitest'
import type { CatalogTool } from './types.ts'
import { isToolAuthorized, isVisible, type VisibilityContext } from './visibility.ts'

const tool = (more: Partial<CatalogTool> = {}): CatalogTool => ({
  id: 'files', name: 'Files', summary: '', groupId: 'files', surface: 'xpanel', entity: 'file',
  featureKey: 'files', resellerAcl: null, rootOnly: false, status: 'verified',
  delivery: { status: 'verified', reason: 'Synthetic visibility fixture.', evidence: [] }, ...more,
})
const owner: VisibilityContext = { principal: { kind: 'user', id: 'user', username: 'sam', accountId: 'account' }, disabledFeatures: new Set() }
const root: VisibilityContext = { principal: { kind: 'root', id: 'root', username: 'root' } }
const reseller: VisibilityContext = { principal: { kind: 'reseller', id: 'reseller', username: 'reseller' }, reseller: { acl: ['list-accounts'] } }

describe('catalog authorization and qualification', () => {
  it('distinguishes an authorized disabled capability from a qualified visible tool', () => {
    const unqualified = tool({ status: 'implemented', delivery: { status: 'implemented', reason: 'Not host qualified.', evidence: [] } })
    expect(isToolAuthorized(unqualified, owner)).toBe(true)
    expect(isVisible(unqualified, owner)).toBe(false)
    expect(isVisible(tool(), owner)).toBe(true)
  })

  it('retains both delivery status requirements', () => {
    expect(isVisible(tool({ status: 'implemented' }), owner)).toBe(false)
    expect(isVisible(tool({ delivery: { status: 'implemented', reason: '', evidence: [] } }), owner)).toBe(false)
  })

  it('preserves surface boundaries for every principal kind', () => {
    expect(isToolAuthorized(tool({ surface: 'xwhm' }), owner)).toBe(false)
    expect(isToolAuthorized(tool(), root)).toBe(false)
    expect(isToolAuthorized(tool(), reseller)).toBe(false)
    expect(isToolAuthorized(tool({ surface: 'xwhm' }), root)).toBe(true)
  })

  it('keeps absent and explicitly disabled owner features denied', () => {
    expect(isToolAuthorized(tool(), { principal: owner.principal })).toBe(false)
    expect(isToolAuthorized(tool(), { ...owner, disabledFeatures: new Set(['files']) })).toBe(false)
    expect(isToolAuthorized(tool({ featureKey: null }), { principal: owner.principal })).toBe(true)
  })

  it('keeps team restrictions in addition to the feature policy', () => {
    expect(isToolAuthorized(tool(), { ...owner, allowedToolIds: new Set() })).toBe(false)
    expect(isToolAuthorized(tool(), { ...owner, allowedToolIds: new Set(['files']) })).toBe(true)
    expect(isToolAuthorized(tool(), { ...owner, allowedToolIds: new Set(['files']), disabledFeatures: new Set(['files']) })).toBe(false)
  })

  it('preserves reseller root-only and privilege checks', () => {
    expect(isToolAuthorized(tool({ surface: 'xwhm', resellerAcl: 'list-accounts' }), reseller)).toBe(true)
    expect(isToolAuthorized(tool({ surface: 'xwhm', resellerAcl: 'manage-plans' }), reseller)).toBe(false)
    expect(isToolAuthorized(tool({ surface: 'xwhm', resellerAcl: 'list-accounts', rootOnly: true }), reseller)).toBe(false)
    expect(isToolAuthorized(tool({ surface: 'xwhm', resellerAcl: 'list-accounts' }), { principal: reseller.principal })).toBe(false)
  })
})
