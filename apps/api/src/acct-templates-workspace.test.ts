import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPrincipalUsername, fail } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { ExtendedFeaturesStore } from './extended-routes.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { sha256Hex } from './auth.ts'
import { accountTemplateZoneRecords, formatZoneTemplate, handleAccountTemplatesRoute, templateForNewAccount, parseTemplateInput, parseZoneTemplate, previewTemplateZone, readSavedTemplates, renderTemplateRecords, templateForPlan, TEMPLATE_SAMPLE } from './acct-templates-workspace.ts'
import type { AccountTemplate, TemplatesHelpers } from './acct-templates-workspace.ts'

const PLAN = '33333333-3333-4333-8333-333333333333', PRO = '44444444-4444-4444-8444-444444444444'
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' }, sessionId: 's2', apiTokenId: null } as unknown as AuthenticatedCaller
const EMPTY = sha256Hex('null'), NOW = new Date('2026-10-28T12:00:00.000Z')
const page = { title: 'Welcome', body: 'This site is being set up.' }
const input = (overrides: Record<string, unknown> = {}) => ({ name: 'Shared', zone: 'shop 3600 CNAME www.%domain%.\n@ 3600 TXT "google-site-verification=abc"\n', defaultPage: page, suspendedPage: { title: 'Suspended', body: 'Contact %domain% support.' }, planIds: [PLAN], expectedRevision: EMPTY, ...overrides })
const closeQueue: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of closeQueue.splice(0).reverse()) await close(); vi.restoreAllMocks() })

const helpers = (initial: unknown = null, callers: AuthenticatedCaller[] = [root]) => {
  let saved: unknown = initial, calls = 0
  const audits: Record<string, unknown>[] = []
  const h = {
    store: { listPlans: vi.fn(async () => [{ id: PLAN, name: 'Starter' }, { id: PRO, name: 'Pro' }]),
      getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => ({ revision: 0 }), release: async () => undefined }) }) },
    requireCaller: vi.fn(async () => callers[Math.min(calls++, callers.length - 1)]!),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    readSaved: vi.fn(async () => saved === null ? null : JSON.parse(JSON.stringify(saved))),
    writeSaved: vi.fn(async (value: unknown) => { saved = JSON.parse(JSON.stringify(value)); return value }),
    now: () => NOW,
  } as unknown as TemplatesHelpers
  return { h, audits, saved: () => saved }
}
const call = (method: string, h: TemplatesHelpers, path = '/api/server/account-templates', body?: unknown) => {
  const url = new URL('http://localhost' + path)
  return handleAccountTemplatesRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, h)
}

describe('zone template grammar', () => {
  it('parses BIND-order lines with priorities and round-trips', () => {
    const records = parseZoneTemplate('; comment\n\nshop 3600 CNAME www\n@ 300 mx 20 backup.%domain%.\n_sip._tcp 3600 SRV 10 5 5060 sip.%domain%.\nv6 3600 AAAA %ipv6%')
    expect(records).toEqual([
      { name: 'shop', ttl: 3600, type: 'CNAME', priority: null, content: 'www' },
      { name: '@', ttl: 300, type: 'MX', priority: 20, content: 'backup.%domain%.' },
      { name: '_sip._tcp', ttl: 3600, type: 'SRV', priority: 10, content: '5 5060 sip.%domain%.' },
      { name: 'v6', ttl: 3600, type: 'AAAA', priority: null, content: '%ipv6%' },
    ])
    expect(parseZoneTemplate(formatZoneTemplate(records))).toEqual(records)
  })
  it('refuses unknown placeholders, SOA/NS, absolute names, missing priority and oversize templates', () => {
    for (const text of ['@ 3600 TXT %owner%', '@ 3600 NS ns1.%domain%.', 'www.example.com. 3600 A %ipv4%', '%domain% 3600 A %ipv4%', '@ 3600 MX mail.%domain%.', '@ x A %ipv4%', 'www 3600 A', Array.from({ length: 51 }, (_, i) => `h${i} 3600 A %ipv4%`).join('\n')])
      expect(() => parseZoneTemplate(text)).toThrow()
  })
  it('substitutes per account and drops IPv6 lines without an IPv6 address', () => {
    const records = parseZoneTemplate('v6 3600 AAAA %ipv6%\nshop 3600 A %ipv4%')
    expect(renderTemplateRecords(records, { ...TEMPLATE_SAMPLE, ipv6: null })).toEqual([{ zone: 'example.com', name: 'shop', type: 'A', ttl: 3600, priority: null, content: '192.0.2.10' }])
    expect(renderTemplateRecords(records, TEMPLATE_SAMPLE)[0]!.content).toBe('2001:db8::10')
  })
  it('validates the template together with the default zone', () => {
    expect(previewTemplateZone(parseZoneTemplate('shop 3600 CNAME www.%domain%.')).some(record => record.name === 'shop' && record.type === 'CNAME')).toBe(true)
    expect(() => previewTemplateZone(parseZoneTemplate('www 3600 CNAME shop.%domain%.'))).toThrow(/CNAME/)
    expect(() => parseTemplateInput(input({ zone: 'www 3600 CNAME shop.%domain%.' }))).toThrow(/valid zone/)
    expect(() => parseTemplateInput(input({ zone: '@ 3600 A 300.1.1.1' }))).toThrow()
  })
  it('requires exact input and plain page text', () => {
    expect(parseTemplateInput(input()).planIds).toEqual([PLAN])
    for (const bad of [input({ extra: 1 }), input({ defaultPage: { title: '<b>x</b>', body: '' } }), input({ name: '' }), input({ planIds: [PLAN, PLAN] }), input({ suspendedPage: { title: 'a\nb', body: '' } })])
      expect(() => parseTemplateInput(bad)).toThrow()
  })
})

describe('saved templates', () => {
  const template = (overrides: Partial<AccountTemplate> = {}): AccountTemplate => ({ id: '77777777-7777-4777-8777-000000000001', name: 'Shared', records: parseZoneTemplate('shop 3600 CNAME www.%domain%.'), defaultPage: page, suspendedPage: page, planIds: [PLAN], updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'root', ...overrides })
  it('reads strictly and finds the plan binding', () => {
    expect(readSavedTemplates(null)).toEqual([])
    const list = readSavedTemplates([template()])!
    expect(templateForPlan(list, PLAN)?.name).toBe('Shared')
    expect(templateForPlan(list, PRO)).toBeNull()
    expect(readSavedTemplates([template(), template({ id: '77777777-7777-4777-8777-000000000002', name: 'Other' })])).toBeNull()
    expect(readSavedTemplates([{ ...template(), records: [{ name: 'www', ttl: 1, type: 'CNAME', priority: null, content: 'shop.example.com.' }] }])).toBeNull()
    expect(readSavedTemplates([{ ...template(), secret: 1 }])).toBeNull()
  })
})

describe('account template shared StateStore writer fence', { tags: ['feature'] }, () => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
  const persistent = async () => {
    const state = await createTestStateStore(); closeQueue.push(() => state.close())
    const ext = new ExtendedFeaturesStore(state.rootDir), f = helpers()
    f.h.store.getWriterLock = () => state.store.getWriterLock()
    f.h.readSaved = vi.fn(() => ext.readOrDefault<unknown>('accounts/templates.json', null))
    f.h.writeSaved = vi.fn((value, writer) => ext.write('accounts/templates.json', value, { templateWriter: writer }))
    return { ...f, state, ext }
  }

  it.each(['POST', 'PUT', 'DELETE'] as const)('queues %s behind the account writer and checks CAS after admission', async method => {
    const f = await persistent()
    let path = '/api/server/account-templates', revision = EMPTY
    if (method !== 'POST') {
      const created = await (await call('POST', f.h, path, input()))!.json() as { changed: string; revision: string }
      path += '/' + created.changed; revision = created.revision
    }
    vi.mocked(f.h.readSaved).mockClear(); vi.mocked(f.h.writeSaved).mockClear()
    const writer = f.state.store.getWriterLock(), held = await writer.acquire(), requested = deferred()
    let released = false
    const release = async () => { if (!released) { released = true; await held.release() } }
    const acquire = writer.acquire.bind(writer)
    vi.spyOn(writer, 'acquire').mockImplementation(() => { requested.resolve(); return acquire() })
    const pending = call(method, f.h, path, method === 'DELETE' ? { expectedRevision: revision } : input({ expectedRevision: revision }))
      .then(response => ({ response }), error => ({ error }))
    closeQueue.push(async () => { await pending }); closeQueue.push(release)
    await requested.promise
    expect(f.h.readSaved).not.toHaveBeenCalled()
    expect(f.h.writeSaved).not.toHaveBeenCalled()
    // The currently admitted operation can change this same source before the queued request obtains it.
    await f.ext.write('accounts/templates.json', [], { templateWriter: held })
    await release()
    expect(await pending).toMatchObject({ error: { code: 'CONFLICT', detail: { stateChanged: false } } })
    expect(f.h.writeSaved).not.toHaveBeenCalled()
    expect(await f.ext.readOrDefault('accounts/templates.json', null)).toEqual([])
  })

  it('rechecks the original root credential after waiting for the writer', async () => {
    const f = await persistent(), writer = f.state.store.getWriterLock(), held = await writer.acquire(), requested = deferred()
    let released = false
    const release = async () => { if (!released) { released = true; await held.release() } }
    const acquire = writer.acquire.bind(writer)
    vi.spyOn(writer, 'acquire').mockImplementation(() => { requested.resolve(); return acquire() })
    vi.mocked(f.h.requireCaller).mockResolvedValueOnce(root).mockResolvedValueOnce(reseller)
    const pending = call('POST', f.h, '/api/server/account-templates', input()).then(response => ({ response }), error => ({ error }))
    closeQueue.push(async () => { await pending }); closeQueue.push(release)
    await requested.promise
    expect(f.h.writeSaved).not.toHaveBeenCalled()
    await release()
    expect(await pending).toMatchObject({ error: { code: 'FORBIDDEN' } })
    expect(f.h.writeSaved).not.toHaveBeenCalled()
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('releases the actual writer before snapshot-reading audit for %s', async method => {
    const f = await persistent()
    const actor: AuthenticatedCaller = { ...root, principal: { kind: 'root', id: root.principal.id, username: assertPrincipalUsername('mbxdeadbeef') } }
    vi.mocked(f.h.requireCaller).mockResolvedValue(actor)
    let path = '/api/server/account-templates', revision = EMPTY
    if (method !== 'POST') {
      const created = await (await call('POST', f.h, path, input()))!.json() as { changed: string; revision: string }
      path += '/' + created.changed; revision = created.revision
    }
    const writer = f.state.store.getWriterLock(), acquire = writer.acquire.bind(writer)
    let released = false
    vi.spyOn(writer, 'acquire').mockImplementation(async () => {
      const held = await acquire()
      return { ...held, release: async () => { await held.release(); released = true } }
    })
    const recordAudit = vi.mocked(f.h.emitAudit).getMockImplementation()!
    const snapshot = vi.spyOn(f.state.store, 'readSnapshot')
    vi.mocked(f.h.emitAudit).mockImplementation(async entry => {
      // Fail before entering a barrier if a regression still holds its writer; no timeout wait.
      expect(released).toBe(true)
      await f.state.store.readSnapshot()
      return recordAudit(entry)
    })
    const response = await call(method, f.h, path, method === 'DELETE' ? { expectedRevision: revision } : input({ expectedRevision: revision }))
    expect(response!.status).toBe(method === 'POST' ? 201 : 200)
    const result = await response!.json() as { revision: string; changed: string }
    const saved = await f.ext.readOrDefault<unknown>('accounts/templates.json', null)
    expect(snapshot).toHaveBeenCalledOnce()
    expect(result.revision).toBe(sha256Hex(JSON.stringify(saved)))
    expect(f.audits.at(-1)).toMatchObject({ actor: 'mbxdeadbeef', principalId: root.principal.id, target: 'account-template:' + result.changed, detail: { revision: result.revision } })
  })

  it('reports a verified saved template when snapshot-reading audit fails after writer release', async () => {
    const f = await persistent(), writer = f.state.store.getWriterLock(), acquire = writer.acquire.bind(writer)
    let released = false, releasedAtAudit = false
    vi.spyOn(writer, 'acquire').mockImplementation(async () => {
      const held = await acquire()
      return { ...held, release: async () => { await held.release(); released = true } }
    })
    vi.mocked(f.h.emitAudit).mockImplementation(async () => {
      releasedAtAudit = released
      if (!releasedAtAudit) throw new Error('audit entered a held writer')
      await f.state.store.readSnapshot()
      throw new Error('audit destination unavailable')
    })
    await expect(call('POST', f.h, '/api/server/account-templates', input())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true },
    })
    const saved = await f.ext.readOrDefault<unknown>('accounts/templates.json', null)
    expect(readSavedTemplates(saved)).toEqual([expect.objectContaining({ name: 'Shared', updatedBy: 'root' })])
    expect(releasedAtAudit).toBe(true)
    expect(f.h.writeSaved).toHaveBeenCalledOnce()
    expect(f.h.emitAudit).toHaveBeenCalledOnce()
    const held = await f.state.store.getWriterLock().acquire()
    try { await held.assertFencingToken() } finally { await held.release() }
  })
  it('guards only the canonical account-template target, including normalized aliases', async () => {
    const f = await persistent()
    for (const path of ['accounts/templates.json', 'accounts/../accounts/templates.json']) {
      await expect(f.ext.write(path, [])).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    }
    expect(await f.ext.readOrDefault('accounts/templates.json', null)).toBeNull()
    await expect(f.ext.write('unrelated/fixture.json', { value: 1 })).resolves.toEqual({ value: 1 })
    const held = await f.state.store.getWriterLock().acquire()
    try { await expect(f.ext.write('accounts/templates.json', [], { templateWriter: held })).resolves.toEqual([]) }
    finally { await held.release() }
  })
})

describe('account templates route', () => {
  it('is root only and refuses selectors and wrong methods', async () => {
    await expect(call('GET', helpers(null, [reseller]).h)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('GET', helpers().h, '/api/server/account-templates?plan=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('PATCH', helpers().h))!.status).toBe(405)
  })
  it('creates, updates and deletes with CAS, readback and audit, and states that creation applies zone records only', async () => {
    const { h, audits } = helpers()
    const read = await (await call('GET', h))!.json() as { state: string; application: Record<string, boolean> }
    expect(read).toMatchObject({ state: 'default', application: { appliedToNewAccounts: true, defaultPagePublished: false, suspendedPagePublished: false } })
    const created = await call('POST', h, '/api/server/account-templates', input())
    expect(created!.status).toBe(201)
    const body = await created!.json() as { revision: string; changed: string; templates: { id: string; zone: string; preview: { name: string }[] }[] }
    expect(body.templates[0]!.zone).toBe('shop 3600 CNAME www.%domain%.\n@ 3600 TXT "google-site-verification=abc"')
    expect(body.templates[0]!.preview.some(record => record.name === 'shop')).toBe(true)
    await expect(call('POST', h, '/api/server/account-templates', input({ name: 'Other', expectedRevision: body.revision }))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('POST', h, '/api/server/account-templates', input({ name: 'Other', planIds: ['55555555-5555-4555-8555-555555555555'], expectedRevision: body.revision }))).rejects.toMatchObject({ code: 'VALIDATION' })
    const updated = await (await call('PUT', h, '/api/server/account-templates/' + body.changed, input({ name: 'Renamed', planIds: [PRO], expectedRevision: body.revision })))!.json() as { revision: string; templates: { name: string; planIds: string[] }[] }
    expect(updated.templates[0]).toMatchObject({ name: 'Renamed', planIds: [PRO] })
    await expect(call('DELETE', h, '/api/server/account-templates/' + body.changed, { expectedRevision: body.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const removed = await (await call('DELETE', h, '/api/server/account-templates/' + body.changed, { expectedRevision: updated.revision }))!.json() as { templates: unknown[] }
    expect(removed.templates).toEqual([])
    expect(audits.map(entry => entry.action)).toEqual(['server.account-template.created', 'server.account-template.updated', 'server.account-template.deleted'])
  })
  it('refuses changed authority and unreadable files', async () => {
    const other = { ...root, sessionId: 'other' } as AuthenticatedCaller
    const { h, saved } = helpers(null, [root, other])
    await expect(call('POST', h, '/api/server/account-templates', input())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(saved()).toBeNull()
    const bad = [{ id: 'x' }]
    await expect(call('POST', helpers(bad).h, '/api/server/account-templates', input({ expectedRevision: sha256Hex(JSON.stringify(bad)) }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('templates at account creation', () => {
  const saved = (records = 'shop 3600 CNAME www.%domain%.\nv6 3600 AAAA %ipv6%') => [{ id: '66666666-6666-4666-8666-666666666666', name: 'Shared', records: parseZoneTemplate(records), defaultPage: page, suspendedPage: page, planIds: [PLAN], updatedAt: NOW.toISOString(), updatedBy: 'root' }]
  it('finds the plan template, ignores other plans and treats a missing file as none', () => {
    expect(templateForNewAccount(null, PLAN, 'shop.test', [])).toBeNull()
    expect(templateForNewAccount(saved(), PRO, 'shop.test', [])).toBeNull()
    expect(templateForNewAccount(saved(), PLAN, 'shop.test', ['ns1.host.test'])!.name).toBe('Shared')
  })
  it('fails closed on an unreadable file or records that cannot form the domain zone', () => {
    expect(() => templateForNewAccount([{ id: 'x' }], PLAN, 'shop.test', [])).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED', detail: expect.objectContaining({ stateChanged: false, reason: 'account_templates_invalid' }) }))
    expect(() => templateForNewAccount(saved('dns 3600 CNAME other.%domain%.'), PLAN, 'shop.test', ['dns.shop.test'])).toThrow(expect.objectContaining({ code: 'PRECONDITION_FAILED', detail: expect.objectContaining({ reason: 'account_template_zone_invalid' }) }))
  })
  it('renders the default zone plus template records with the real addresses and nameservers, without SOA', () => {
    const template = saved()[0]! as unknown as AccountTemplate
    const records = accountTemplateZoneRecords(template, { primaryDomain: 'shop.test', ipv4: '203.0.113.7', ipv6: null }, ['ns1.host.test', 'ns2.host.test'])
    expect(records.some(record => (record.type as string) === 'SOA')).toBe(false)
    expect(records).toContainEqual(expect.objectContaining({ name: 'shop', type: 'CNAME', content: 'www.shop.test.' }))
    expect(records).toContainEqual(expect.objectContaining({ name: '@', type: 'NS', content: 'ns1.host.test.' }))
    expect(records.filter(record => record.type === 'AAAA')).toEqual([])
    expect(records).toContainEqual(expect.objectContaining({ name: '@', type: 'A', content: '203.0.113.7' }))
    const v6 = accountTemplateZoneRecords(template, { primaryDomain: 'shop.test', ipv4: '203.0.113.7', ipv6: '2001:db8::7' }, [])
    expect(v6).toContainEqual(expect.objectContaining({ name: 'v6', type: 'AAAA', content: '2001:db8::7' }))
  })
})
