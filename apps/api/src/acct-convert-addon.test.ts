import { describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { addonConversionRevision, handleConvertAddonRoute, parseConvertAddonInput, planAddonConversion } from './acct-convert-addon.ts'
import type { ConvertAddonSnapshot } from './acct-convert-addon.ts'
import type { AuthenticatedCaller } from './auth.ts'

const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
const ADDON = id(1), SUB = id(2), PRIMARY = id(3), PLAN = id(4), ACCOUNT = id(5)
const snapshot = (): ConvertAddonSnapshot => ({
  plans: [{ id: PLAN, name: 'gold', caps: { subdomains: 5, aliasDomains: 5, mailboxes: 5 } }] as never,
  revision: 7,
  accounts: [{ id: ACCOUNT, username: 'alice', home: '/home/alice', status: 'active' }] as never,
  domains: [
    { id: PRIMARY, accountId: ACCOUNT, name: 'alice.example.test', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', certificateId: null },
    { id: ADDON, accountId: ACCOUNT, name: 'shop.example.test', kind: 'addon', parentId: null, docRoot: '/home/alice/shop.example.test', certificateId: id(6) },
    { id: SUB, accountId: ACCOUNT, name: 'blog.shop.example.test', kind: 'subdomain', parentId: ADDON, docRoot: '/home/alice/shop.example.test/blog', certificateId: null },
  ] as never,
  serviceUsers: [
    { login: 'info@shop.example.test', domainId: ADDON, services: { email: true } }, { login: 'ftp@shop.example.test', domainId: ADDON, services: { email: false } },
    { login: 'me@alice.example.test', domainId: PRIMARY, services: { email: true } },
  ] as never,
  zones: [{ name: 'shop.example.test', records: [{}, {}] }, { name: 'alice.example.test', records: [{}] }] as never,
})
const input = { domainId: ADDON, username: 'shop', planId: PLAN }

describe('addon domain conversion review', () => {
  it('moves the addon with its subtree, mailboxes, service users, zone and certificate', () => {
    const plan = planAddonConversion(snapshot(), input, false)
    expect(plan.conflicts).toEqual([])
    expect(plan.domains.map(domain => domain.name)).toEqual(['shop.example.test', 'blog.shop.example.test'])
    expect(plan.mail).toEqual({ mailboxes: ['info@shop.example.test'], otherServiceUsers: ['ftp@shop.example.test'] })
    expect(plan.dns).toEqual([{ zone: 'shop.example.test', records: 2 }])
    expect(plan.certificates).toBe(1)
    expect(plan.target).toEqual({ username: 'shop', planId: PLAN, planName: 'gold', home: '/home/shop', documentRoot: '/home/shop/public_html' })
  })
  it('lists every blocking conflict instead of guessing', () => {
    const shared = snapshot()
    ;(shared.domains as { docRoot: string }[])[1]!.docRoot = '/home/alice/public_html/shop'
    ;(shared.accounts as { status: string }[])[0]!.status = 'suspended'
    const plan = planAddonConversion(shared, { ...input, planId: id(7) }, true)
    expect(plan.conflicts.map(item => item.kind)).toEqual(['username-taken', 'plan-missing', 'account-inactive', 'docroot-shared', 'subdomain-docroot-outside'])
    expect(planAddonConversion(snapshot(), { ...input, username: 'root' }, false).conflicts.map(item => item.kind)).toContain('username-invalid')
    const outside = snapshot(); (outside.domains as { docRoot: string }[])[1]!.docRoot = '/var/www/shop'
    expect(planAddonConversion(outside, input, false).conflicts.map(item => item.kind)).toEqual(['docroot-outside-home', 'subdomain-docroot-outside'])
    const busy = snapshot()
    ;(busy.serviceUsers as { services: Record<string, boolean> }[])[1]!.services = { email: false, ftp: true }
    ;(busy.domains as { certificateId: string | null }[])[0]!.certificateId = id(6)
    ;(busy as { domainCustomConfigs: unknown[] }).domainCustomConfigs = [{ domainId: SUB }]
    ;(busy.plans as unknown as { caps: Record<string, number> }[])[0]!.caps.subdomains = 0
    expect(planAddonConversion(busy, input, false).conflicts).toEqual([{ kind: 'service-user-not-mail', value: 'ftp@shop.example.test' }, { kind: 'certificate-shared', value: 'alice.example.test' },
      { kind: 'custom-configuration', value: 'blog.shop.example.test' }, { kind: 'plan-capacity', value: 'subdomains' }])
    expect(() => planAddonConversion(snapshot(), { ...input, domainId: PRIMARY }, false)).toThrow(/addon domain not found/)
  })
  it('binds the revision to the saved facts', () => {
    const base = snapshot(), plan = planAddonConversion(base, input, false), changed = snapshot()
    ;(changed.serviceUsers as unknown[]).push({ login: 'new@shop.example.test', domainId: ADDON, services: { email: true } })
    expect(addonConversionRevision(plan, base)).toBe(addonConversionRevision(planAddonConversion(snapshot(), input, false), snapshot()))
    expect(addonConversionRevision(planAddonConversion(changed, input, false), changed)).not.toBe(addonConversionRevision(plan, base))
  })
  it('accepts only the exact request grammar', () => {
    expect(parseConvertAddonInput(input, false)).toEqual(input)
    for (const body of [{ ...input, extra: 1 }, { ...input, username: 'Shop' }, { ...input, domainId: 'x' }, null, []]) expect(() => parseConvertAddonInput(body, false)).toThrow()
    expect(() => parseConvertAddonInput(input, true)).toThrow(/expectedRevision/)
  })
})

describe('addon domain conversion route', () => {
  const ports = (kind = 'root', audits: string[] = [], execute?: (caller: AuthenticatedCaller, plan: unknown, state: unknown) => Promise<Response>) => ({
    requireCaller: async () => ({ principal: { kind, id: 'p', username: 'root' }, sessionId: 's', apiTokenId: null }) as unknown as AuthenticatedCaller,
    assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async (entry: { action: string }) => { audits.push(entry.action) },
    readSnapshot: async () => snapshot(), usernameTaken: async () => false, readJournal: async () => null,
    ...(execute ? { execute } : {}),
  })
  const call = (p: ReturnType<typeof ports>, path: string, method = 'GET', body?: unknown) => {
    const url = new URL('http://x' + path)
    return handleConvertAddonRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, p)
  }
  it('lists addon candidates, plans and the journal, with apply unavailable without the host ports', async () => {
    const value = await (await call(ports(), '/api/transfers/convert-addon'))!.json()
    expect(value.candidates).toEqual([{ domainId: ADDON, domain: 'shop.example.test', docRoot: '/home/alice/shop.example.test', account: { id: ACCOUNT, username: 'alice', status: 'active' } }])
    expect(value.capabilities).toEqual({ preview: true, apply: false, reason: 'host-agent-unavailable' })
    expect(value.journal).toEqual([])
    expect((await (await call(ports('root', [], async () => new Response()), '/api/transfers/convert-addon'))!.json()).capabilities).toEqual({ preview: true, apply: true, reason: 'journaled-move' })
  })
  it('previews, then hands apply to the journaled executor only after confirmation and CAS checks', async () => {
    const calls: unknown[] = [], p = ports('root', [], async (_caller, plan, state) => { calls.push([plan, (state as { revision: number }).revision]); return Response.json({ converted: true }) })
    const preview = await (await call(p, '/api/transfers/convert-addon/preview', 'POST', input))!.json()
    expect(preview.revision).toMatch(/^[0-9a-f]{64}$/)
    await expect(call(p, '/api/transfers/convert-addon/apply', 'POST', { ...input, expectedRevision: preview.revision, confirm: 'convert other' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(p, '/api/transfers/convert-addon/apply', 'POST', { ...input, expectedRevision: '0'.repeat(64), confirm: 'convert shop.example.test' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(calls).toEqual([])
    expect(await (await call(p, '/api/transfers/convert-addon/apply', 'POST', { ...input, expectedRevision: preview.revision, confirm: 'convert shop.example.test' }))!.json()).toEqual({ converted: true })
    expect(calls).toEqual([[expect.objectContaining({ source: expect.objectContaining({ domain: 'shop.example.test' }) }), 7]])
    await expect(call(ports(), '/api/transfers/convert-addon/apply', 'POST', { ...input, expectedRevision: preview.revision, confirm: 'convert shop.example.test' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('refuses non-root callers, selectors and wrong methods', async () => {
    await expect(call(ports('reseller'), '/api/transfers/convert-addon')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(ports(), '/api/transfers/convert-addon?domain=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(ports(), '/api/transfers/convert-addon/preview', 'GET'))!.status).toBe(405)
    expect(await call(ports(), '/api/transfers/convert-addon/other')).toBeNull()
  })
})
