import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { assertEnhancementsAgainstDirectory, effectiveEnhancements, handleAccountEnhancementsRoute, parseEnhancementsDocument, readSavedEnhancements, resellerUsage } from './acct-enhancements-workspace.ts'
import type { EnhancementsDirectory, EnhancementsHelpers } from './acct-enhancements-workspace.ts'

const PLAN = '33333333-3333-4333-8333-333333333333', RESELLER = '22222222-2222-4222-8222-222222222222'
const A = '55555555-5555-4555-8555-555555555551', B = '55555555-5555-4555-8555-555555555552', C = '55555555-5555-4555-8555-555555555553'
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: RESELLER, username: 'res1' }, sessionId: 's2', apiTokenId: null } as unknown as AuthenticatedCaller
const EMPTY = sha256Hex('null')
const directory: EnhancementsDirectory = {
  plans: [{ id: PLAN, name: 'Starter' }], resellers: [{ id: RESELLER, username: 'res1' }],
  accounts: [{ id: A, username: 'alice', planId: PLAN, ownerId: RESELLER }, { id: B, username: 'bob', planId: PLAN, ownerId: RESELLER }, { id: C, username: 'carol', planId: PLAN, ownerId: null }],
}
const definitions = [{ id: 'priority-support', label: 'Priority support', kind: 'flag', min: null, max: null }, { id: 'extra-sites', label: 'Extra sites', kind: 'limit', min: 0, max: 10 }]
const doc = (overrides: Record<string, unknown> = {}) => ({ definitions, planAssignments: { [PLAN]: { 'extra-sites': 2 } }, accountAssignments: { [A]: { 'priority-support': true, 'extra-sites': 5 } }, resellerLimits: { [RESELLER]: { 'priority-support': 2 } }, ...overrides })

const helpers = (initial: unknown = null, callers: AuthenticatedCaller[] = [root]) => {
  let saved: unknown = initial, calls = 0
  const audits: Record<string, unknown>[] = []
  const h = {
    store: { readSnapshot: vi.fn(async () => ({ plans: directory.plans, resellers: directory.resellers, accounts: directory.accounts })) },
    requireCaller: vi.fn(async () => callers[Math.min(calls++, callers.length - 1)]!),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readSaved: vi.fn(async () => saved === null ? null : JSON.parse(JSON.stringify(saved))),
    writeSaved: vi.fn(async (value: unknown) => { saved = JSON.parse(JSON.stringify(value)); return value }),
  } as unknown as EnhancementsHelpers
  return { h, audits, saved: () => saved }
}
const call = (method: string, h: EnhancementsHelpers, body?: unknown, path = '/api/server/account-enhancements') => {
  const url = new URL('http://localhost' + path)
  return handleAccountEnhancementsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('enhancement grammar', () => {
  it('accepts flags and bounded limits', () => {
    expect(parseEnhancementsDocument(doc()).accountAssignments[A]).toEqual({ 'extra-sites': 5, 'priority-support': true })
  })
  it('refuses bad ids, kinds, bounds, values and undefined references', () => {
    for (const bad of [
      doc({ definitions: [{ ...definitions[0], id: 'Bad' }] }),
      doc({ definitions: [{ ...definitions[1], min: 5, max: 1 }] }),
      doc({ definitions: [{ ...definitions[0], min: 0 }] }),
      doc({ definitions: [definitions[0], definitions[0]] }),
      doc({ definitions: [{ ...definitions[0], label: '<b>x</b>' }] }),
      doc({ accountAssignments: { [A]: { 'priority-support': false } } }),
      doc({ accountAssignments: { [A]: { 'extra-sites': 11 } } }),
      doc({ accountAssignments: { [A]: { unknown: true } } }),
      doc({ accountAssignments: { alice: { 'priority-support': true } } }),
      doc({ accountAssignments: { [A]: {} } }),
      doc({ resellerLimits: { [RESELLER]: { 'priority-support': -1 } } }),
      { ...doc(), extra: {} },
    ]) expect(() => parseEnhancementsDocument(bad)).toThrow()
  })
})

describe('enhancement resolution', () => {
  const parsed = parseEnhancementsDocument(doc())
  it('overlays account values on plan values', () => {
    expect(effectiveEnhancements(parsed, { id: PLAN }, { id: A, planId: PLAN })).toEqual({ 'extra-sites': 5, 'priority-support': true })
    expect(effectiveEnhancements(parsed, { id: PLAN }, { id: C, planId: PLAN })).toEqual({ 'extra-sites': 2 })
    expect(() => effectiveEnhancements(parsed, { id: PLAN }, { id: C, planId: RESELLER })).toThrow()
  })
  it('caps direct assignments on reseller accounts, with 0 refusing the first', () => {
    expect(resellerUsage(parsed, directory.accounts, RESELLER)).toEqual({ 'priority-support': 1, 'extra-sites': 1 })
    expect(() => assertEnhancementsAgainstDirectory(parsed, directory)).not.toThrow()
    const three = parseEnhancementsDocument(doc({ accountAssignments: { [A]: { 'priority-support': true }, [B]: { 'priority-support': true } }, resellerLimits: { [RESELLER]: { 'priority-support': 1 } } }))
    expect(() => assertEnhancementsAgainstDirectory(three, directory)).toThrow(/limit is 1/)
    const zero = parseEnhancementsDocument(doc({ resellerLimits: { [RESELLER]: { 'priority-support': 0 } } }))
    expect(() => assertEnhancementsAgainstDirectory(zero, directory)).toThrow(/limit is 0/)
    const unlimited = parseEnhancementsDocument(doc({ resellerLimits: { [RESELLER]: { 'priority-support': null } } }))
    expect(() => assertEnhancementsAgainstDirectory(unlimited, directory)).not.toThrow()
    const missing = parseEnhancementsDocument(doc({ planAssignments: { '66666666-6666-4666-8666-666666666666': { 'extra-sites': 1 } } }))
    expect(() => assertEnhancementsAgainstDirectory(missing, directory)).toThrow(/no longer exist/)
  })
  it('reads saved documents strictly', () => {
    expect(readSavedEnhancements(null)).toEqual({ definitions: [], planAssignments: {}, accountAssignments: {}, resellerLimits: {} })
    expect(readSavedEnhancements(parseEnhancementsDocument(doc()))).not.toBeNull()
    expect(readSavedEnhancements({ ...doc(), extra: 1 })).toBeNull()
  })
})

describe('account enhancements route', () => {
  it('is root only and reports truthful application state', async () => {
    await expect(call('GET', helpers(null, [reseller]).h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await call('POST', helpers().h))!.status).toBe(405)
    await expect(call('GET', helpers().h, undefined, '/api/server/account-enhancements?plan=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    const body = await (await call('GET', helpers().h))!.json() as Record<string, unknown>
    expect(body).toMatchObject({ state: 'default', revision: EMPTY, application: { enforced: false, resellerAssignment: false } })
  })
  it('saves with CAS, readback and audit', async () => {
    const { h, audits } = helpers()
    const body = await (await call('PUT', h, { expectedRevision: EMPTY, ...doc() }))!.json() as { state: string; revision: string; document: { accountAssignments: Record<string, unknown> } }
    expect(body.state).toBe('saved')
    expect(body.document.accountAssignments[A]).toEqual({ 'extra-sites': 5, 'priority-support': true })
    expect(audits[0]).toMatchObject({ action: 'server.account-enhancements.updated', outcome: 'ok' })
    await expect(call('PUT', h, { expectedRevision: EMPTY, ...doc() })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('PUT', h, { expectedRevision: body.revision, ...doc({ resellerLimits: { [RESELLER]: { 'priority-support': 0 } } }) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
  it('refuses changed authority and unreadable files', async () => {
    const { h, saved } = helpers(null, [root, { ...root, sessionId: 'other' } as AuthenticatedCaller])
    await expect(call('PUT', h, { expectedRevision: EMPTY, ...doc() })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(saved()).toBeNull()
    const bad = { definitions: 'x' }
    await expect(call('PUT', helpers(bad).h, { expectedRevision: sha256Hex(JSON.stringify(bad)), ...doc() })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
