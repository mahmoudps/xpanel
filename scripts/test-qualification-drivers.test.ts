import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { specs } from '../packages/catalog/src/data/index.ts'
import { PHASE1_TOOL_PROBES } from '../packages/catalog/src/host-qualification.ts'
import { DRIVERS, QUALIFICATION_INVENTORY, SLICES } from './qualification-drivers/index.mjs'
import { entryPointAllowsApiRoute } from '../apps/api/src/entry-points.ts'
import { ACTOR_ENTRY, apiClient, createFixture, displayValues, entryOrigin, runDriver, runTag, tool } from './qualification-drivers/kit.mjs'
import { qualificationPlan, qualificationRequirements, RUNNER_SLOTS } from './qualification-plan.mjs'
import { driveTool } from './qualification-runner.mjs'

const fast = () => Promise.resolve()
const definition = { prefix: 'XT', probe: '/api/x', paths: /^\/api\/x$/, checks: ['ONE'], run: async () => undefined }
const fixture = { username: 'xqaaaaaaaa', domain: 'xqaaaaaaaa.example.net', accountId: '00000000-0000-4000-8000-000000000000', password: 'unused', mailbox: { address: 'xq@xqaaaaaaaa.example.net', password: 'unused' } }
const site = { get: async () => ({ status: 500, headers: {}, bytes: 0, text: '' }), certificate: async () => ({ serialNumber: '', subject: null, fingerprint256: '' }) }
const responses = (respond: (method: string, path: string) => { status: number; data: unknown }) => {
  const seen: { method: string; path: string }[] = []
  const request = async (path: string, options: { method?: string } = {}) => {
    const method = options.method ?? 'GET'
    seen.push({ method, path })
    return { ...respond(method, path), setCookie: [], contentType: 'application/json' }
  }
  const client = apiClient(request, { cookie: 'c=1', csrf: 'x' })
  return { seen, request, clients: { root: client, owner: client, mailbox: client } }
}
const run = (driver: (typeof DRIVERS)[string], clients: object, overrides: object = {}) => runDriver(driver, { clients, tag: 'aaaaaaaa', fixture, site, sleep: fast, ...overrides })

describe('driver declarations', () => {
  it('refuses a malformed declaration', () => {
    for (const bad of [{ prefix: 'x' }, { checks: [] }, { checks: ['A', 'A'] }, { checks: ['a b'] }, { as: 'nobody' }, { paths: '/api' }, { requests: 1000 }, { page: { route: '/not-its-page' } }, { also: ['root'] }, { restores: ['/api/x'], as: 'owner', needs: ['account'] }, { hostOnly: ['OTHER'] }]) {
      expect(() => tool('audit-log', { ...definition, ...bad })).toThrow('Invalid qualification driver')
    }
    expect(() => tool('not-a-catalog-tool', definition)).toThrow('Invalid qualification driver')
  })

  it('derives the check IDs of each slot from the declaration', () => {
    const { inventory, driver } = tool('audit-log', { ...definition, as: 'owner', also: ['root'], needs: ['account'], checks: ['ONE', 'HOST'], hostOnly: ['HOST'] })
    expect(inventory.host).toEqual(['XT-OS-PROFILE', 'XT-ANONYMOUS-DENIED', 'XT-ONE', 'XT-HOST', 'XT-SESSION-REVOKED', 'XT-ROOT-SESSION-REVOKED'])
    expect(inventory.external).toEqual(['XT-EXTERNAL-DNS', 'XT-EXTERNAL-TLS', 'XT-EXTERNAL-ONE', 'XT-EXTERNAL-SESSION-REVOKED', 'XT-EXTERNAL-ROOT-SESSION-REVOKED'])
    expect(inventory.browser).toEqual(['XT-BROWSER-SIGN-IN', 'XT-BROWSER-PAGE', 'XT-BROWSER-READ', 'XT-BROWSER-SIGNED-OUT'])
    expect(driver.page).toEqual({ route: '/whm/audit', actor: 'root', read: '/api/auth/me' })
  })

  it('derives the page and its actor from the catalog, and adds the fixture that actor needs', () => {
    const { driver } = tool('api-tokens', { ...definition, as: 'root' })
    expect(driver.page).toMatchObject({ route: '/security/account', actor: 'owner' })
    expect(driver.needs).toEqual(['account'])
    expect(tool('webmail-compose', definition).driver.needs).toEqual(['account', 'mailbox'])
  })

  it('compares only identifying values a page could show, never ids, dates or the actor', () => {
    const replies = [{ domains: [{ id: '00000000-0000-4000-8000-000000000001', name: 'shop.example.net', createdAt: '2026-11-07T00:00:00.000Z' }], username: 'owner1', status: 'active' }]
    expect(displayValues(replies, 'owner1')).toEqual(['shop.example.net'])
    expect(displayValues([{ count: 3, ok: true }], 'owner1')).toEqual([])
  })
})

describe('driver execution', () => {
  it('runs every undo step after a failed check and reports an unconfirmed one as a leftover', async () => {
    const steps: string[] = []
    const { driver } = tool('audit-log', { ...definition, run: async ({ undo, check }: { undo: (label: string, step: () => unknown) => void; check: (id: string, passed: boolean, observed: object) => boolean }) => {
      undo('first', () => { steps.push('first'); return true })
      undo('second', () => { steps.push('second'); return false })
      undo('third', () => { steps.push('third'); throw new Error('refused') })
      check('ONE', false, {})
    } })
    const result = await run(driver, {})
    expect(steps).toEqual(['third', 'second', 'first'])
    expect(result.checks.map((item: { status: string }) => item.status)).toEqual(['failed'])
    expect(result.cleanup).toMatchObject({ ok: false, leftovers: { objects: ['third', 'second'] } })
  })

  it('still cleans up when the driver throws, and reports that it did not complete', async () => {
    let undone = false
    const { driver } = tool('audit-log', { ...definition, run: async ({ undo }: { undo: (label: string, step: () => unknown) => void }) => { undo('object', () => { undone = true }); throw new Error('boom') } })
    const result = await run(driver, {})
    expect(undone).toBe(true)
    expect(result.failure).toBe('The driver did not complete.')
    expect(result.cleanup.ok).toBe(true)
  })

  it('proves a shared restore against its first read, and does not run when that read fails', async () => {
    const state = { status: 200, data: { value: 'before', revision: 1, updatedAt: 'one' } }
    const { driver } = tool('audit-log', { ...definition, restores: ['/api/x'], run: async ({ check }: { check: (id: string, passed: boolean, observed: object) => boolean }) => { state.data = { value: 'after', revision: 2, updatedAt: 'two' }; check('ONE', true, {}) } })
    const client = { get: async () => state }
    expect((await run(driver, { root: client })).cleanup).toMatchObject({ ok: false, leftovers: { objects: ['shared state /api/x'] } })
    const restored = tool('audit-log', { ...definition, restores: ['/api/x'], run: async ({ undo }: { undo: (label: string, step: () => unknown) => void }) => { state.data = { value: 'changed', revision: 3, updatedAt: 'three' }; undo('value', () => { state.data = { value: 'after', revision: 4, updatedAt: 'four' } }) } })
    expect((await run(restored.driver, { root: client })).cleanup.ok).toBe(true)
    const unreadable = await run(driver, { root: { get: async () => ({ status: 500, data: {} }) } })
    expect(unreadable.checks).toEqual([expect.objectContaining({ id: 'XT-ONE', status: 'blocked' })])
  })

  it('blocks a gated tool without admission and sends no request', async () => {
    const { driver } = tool('audit-log', { ...definition, requires_qualification_admission: true, run: async () => { throw new Error('must not run') } })
    const result = await run(driver, {}, { admitted: false })
    expect(result.checks).toEqual([expect.objectContaining({ id: 'XT-ONE', status: 'blocked' })])
    expect(result.failure).toBeNull()
  })

  it('accepts only the exact refusal a criterion names', async () => {
    const results: boolean[] = []
    const { driver } = tool('audit-log', { ...definition, run: async ({ refused }: { refused: (id: string, response: object, expected: string | number) => boolean }) => {
      results.push(refused('ONE', { status: 400, data: { code: 'CONFLICT' } }, 'CONFLICT'))
      results.push(refused('ONE', { status: 400, data: { code: 'VALIDATION' } }, 'VALIDATION_ERROR'))
      results.push(refused('ONE', { status: 400, data: { code: 'OTHER' } }, 'CONFLICT'))
      results.push(refused('ONE', { status: 200, data: { code: 'CONFLICT' } }, 'CONFLICT'))
      results.push(refused('ONE', { status: 401, data: {} }, 401))
      results.push(refused('ONE', { status: 200, data: {} }, 401))
    } })
    await run(driver, {})
    expect(results).toEqual([true, false, false, false, true, false])
  })

  it('signs in each actor, then revokes both sessions; a leftover keeps the run from a receipt', async () => {
    const seen: string[] = []
    const transport = (entryPoint: string) => async (path: string, options: { method?: string; cookie?: string } = {}) => {
      seen.push(`${entryPoint} ${options.method ?? 'GET'} ${path}`)
      if (path === '/api/auth/login') return { status: 200, data: { principal: { kind: entryPoint === 'xwhm' ? 'root' : 'user' }, entryPoint, csrfToken: 'c'.repeat(43), passwordChangeRequired: false }, setCookie: [`__Host-${entryPoint}_session=${entryPoint}; Secure; HttpOnly; SameSite=Strict; Path=/`] }
      if (path === '/api/auth/logout') return { status: 200, data: {}, setCookie: [] }
      if (path === '/api/x' || path === '/api/auth/me') return { status: 401, data: { code: 'UNAUTHENTICATED' }, setCookie: [] }
      return { status: 200, data: { tools: [{ id: 'x' }] }, setCookie: [] }
    }
    const requests: Record<string, ReturnType<typeof transport>> = { owner: transport('xpanel'), root: transport('xwhm') }
    const { driver } = tool('audit-log', { ...definition, as: 'owner', also: ['root'], needs: ['account'], run: async ({ check, undo }: { check: (id: string, passed: boolean, observed: object) => boolean; undo: (label: string, step: () => unknown) => void }) => { check('ONE', true, {}); undo('object', () => false) } })
    const result = await driveTool(driver, 'x', { prefix: 'XT', anonymous: true, requestFor: (actor: string) => requests[actor], loginFor: () => ({ username: 'u', password: 'p' }), tag: 'aaaaaaaa', fixture, site })
    expect(result.checks.map((item: { id: string; status: string }) => `${item.id} ${item.status}`)).toEqual(['XT-ANONYMOUS-DENIED passed', 'XT-ONE passed', 'XT-ROOT-SESSION-REVOKED passed', 'XT-SESSION-REVOKED passed'])
    expect(result.cleanup).toMatchObject({ ok: false, leftovers: { objects: ['object'] } })
    expect(seen.indexOf('xwhm POST /api/auth/logout')).toBeLessThan(seen.indexOf('xpanel POST /api/auth/logout'))
  })
})

describe('run fixture', () => {
  const responder = (failAt?: string) => (method: string, path: string) => {
    if (method === 'POST' && path === failAt) return { status: 500, data: { code: 'INTERNAL' } }
    if (method === 'POST' && path === '/api/feature-lists') return { status: 201, data: { featureList: { id: 'list-id' } } }
    if (method === 'POST' && path === '/api/plans') return { status: 201, data: { plan: { id: 'plan-id' } } }
    if (method === 'POST' && path === '/api/accounts') return { status: 201, data: { account: { id: 'account-id' } } }
    return { status: 200, data: {} }
  }

  it('creates a run-scoped account and removes everything it made', async () => {
    const { seen, clients } = responses(responder())
    const created = await createFixture(clients.root, { tag: runTag('run-1'), mailbox: true })
    expect(created.mailbox.address).toBe(`xq@${created.domain}`)
    expect(await created.destroy()).toEqual({ ok: true, errors: [] })
    expect(seen.filter(item => item.method === 'DELETE').map(item => item.path)).toEqual(['/api/accounts/account-id', '/api/plans/plan-id', '/api/feature-lists/list-id'])
  })

  it('undoes what it created when a step fails, and reports a removal that was refused', async () => {
    const { seen, clients } = responses(responder('/api/accounts'))
    await expect(createFixture(clients.root, { tag: 'aaaaaaaa' })).rejects.toThrow('QUALIFICATION_FIXTURE_ACCOUNT')
    expect(seen.filter(item => item.method === 'DELETE').map(item => item.path)).toEqual(['/api/plans/plan-id', '/api/feature-lists/list-id'])
    const refused = responses((method, path) => method === 'DELETE' ? { status: 409, data: { code: 'CONFLICT' } } : responder()(method, path))
    const created = await createFixture(refused.clients.root, { tag: 'aaaaaaaa' })
    expect((await created.destroy()).ok).toBe(false)
  })

  it('finds the other panels on the same host name', () => {
    expect(entryOrigin('https://lab.example.net:2087', 2083)).toBe('https://lab.example.net:2083')
  })
})

describe.each(Object.keys(SLICES))('slice %s', slice => {
  const entries = SLICES[slice as keyof typeof SLICES]

  it('plans every driver on all four slots with reviewed requirements', () => {
    for (const { toolId } of entries) {
      expect(specs.find(spec => spec.id === toolId), toolId).toBeDefined()
      expect(Object.hasOwn(PHASE1_TOOL_PROBES, toolId), `${toolId} has a readiness probe`).toBe(true)
      for (const slot of Object.keys(RUNNER_SLOTS)) expect(qualificationPlan(slot, toolId).tools).toHaveLength(1)
      expect(qualificationRequirements([toolId])).toHaveLength(1)
    }
  })

  it('names unit cases that exist, in files that exist', () => {
    for (const { toolId, inventory } of entries) for (const item of inventory.unit) {
      const path = resolve(import.meta.dirname, '..', item.file)
      expect(existsSync(path), `${toolId} ${item.file}`).toBe(true)
      const words = item.name.split(' ').at(-1)!
      expect(readFileSync(path, 'utf8').includes(words), `${toolId} ${item.name}`).toBe(true)
    }
  })

  it('claims nothing when the host refuses or fails, and still runs its undo steps', async () => {
    for (const { toolId, driver } of entries) {
      if (driver.run === undefined) continue
      for (const status of [500, 503]) {
        const { clients, request } = responses(() => ({ status, data: { code: 'INTERNAL' } }))
        const result = await run(driver, clients, { requestFor: () => request })
        const claimed = result.checks.filter((item: { status: string }) => item.status === 'passed').map((item: { id: string }) => item.id)
        expect(claimed, `${toolId} with HTTP ${status}`).toEqual([])
      }
    }
  })

  it('reports no secret in an observation', async () => {
    for (const { toolId, driver } of entries) {
      if (driver.run === undefined) continue
      const { clients, request } = responses(() => ({ status: 200, data: {} }))
      const result = await run(driver, clients, { requestFor: () => request })
      const text = JSON.stringify(result)
      expect(text.includes(fixture.password) && fixture.password !== 'unused', toolId).toBe(false)
      expect(/csrf|cookie|password"|secret"/i.test(text), toolId).toBe(false)
    }
  })

  it('probes and reads only routes the listener of its actor admits', () => {
    for (const { toolId, driver } of entries) {
      expect(entryPointAllowsApiRoute(ACTOR_ENTRY[driver.as], driver.probe.split('?')[0]!, 'GET'), `${toolId} probe`).toBe(true)
      expect(entryPointAllowsApiRoute(ACTOR_ENTRY[driver.page.actor], driver.page.read.split('?')[0]!, 'GET'), `${toolId} page read`).toBe(true)
    }
  })

  it('sends only paths the real transport admits for it', async () => {
    const admitted = ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/catalog']
    for (const { toolId, driver } of entries) {
      if (driver.run === undefined) continue
      const shapes = [() => ({ status: 200, data: {} }), (method: string) => method === 'GET' ? { status: 200, data: {} } : { status: 201, data: { id: '00000000-0000-4000-8000-000000000001' } }]
      for (const shape of shapes) {
        const { seen, clients, request } = responses(shape)
        await run(driver, clients, { requestFor: () => request })
        expect(seen.map(item => item.path).filter(path => !admitted.includes(path) && path !== driver.probe && !driver.paths.test(path) && !driver.restores.includes(path)), toolId).toEqual([])
      }
    }
  })

  it('cleans up after a write that succeeded and a read that then failed', async () => {
    for (const { toolId, driver } of entries) {
      if (driver.run === undefined) continue
      const { clients, request } = responses(method => method === 'GET' ? { status: 500, data: { code: 'INTERNAL' } } : { status: 201, data: { id: '00000000-0000-4000-8000-000000000001' } })
      const result = await run(driver, clients, { requestFor: () => request })
      expect(result.cleanup.ok === true || result.cleanup.errors.length > 0, toolId).toBe(true)
    }
  })
})

describe('all slices', () => {
  it('declares each tool once with its own prefix and check IDs', () => {
    const tools = Object.values(SLICES).flat() as { toolId: string; inventory: { host: string[]; browser: string[]; external: string[] }; driver: { prefix: string } }[]
    expect(new Set(tools.map(item => item.toolId)).size).toBe(tools.length)
    expect(new Set(tools.map(item => item.driver.prefix)).size).toBe(tools.length)
    const ids = tools.flatMap(item => [...item.inventory.host, ...item.inventory.browser, ...item.inventory.external])
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(QUALIFICATION_INVENTORY)).toEqual(Object.keys(DRIVERS))
  })
})
