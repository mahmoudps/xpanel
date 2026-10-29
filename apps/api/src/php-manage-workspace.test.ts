import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { exceptionsRevision, handlePhpManageRoute, phpLifecycle } from './php-workspace.ts'
import type { PhpManageHelpers } from './php-workspace.ts'

const caller = { principal: { kind: 'root', id: 'root-id', username: 'root' } } as AuthenticatedCaller
const REVISION = 'a'.repeat(64)
const domain = (name: string, accountId: string, version: string) => ({ id: name, name, accountId, siteType: 'php', php: { version, handler: 'fpm', fpm: {}, ini: {} } }) as unknown as Domain
const observation = { state: 'read', revision: REVISION, family: 'debian', versions: [{ version: '7.4', fpmInstalled: true }, { version: '8.3', fpmInstalled: true }, { version: '8.4', fpmInstalled: true }, { version: '8.2', fpmInstalled: false }], installable: ['8.2'], capabilities: { extensions: true }, actions: { manage: true } }

function setup(over: Partial<PhpManageHelpers> = {}) {
  const audits: string[] = []
  let settings = { hostname: 'srv.example.test', defaultPhpVersion: '8.3' } as ServerSettings
  const agent = vi.fn(async (_caller: AuthenticatedCaller, path: string) => path === '/host/php/manage' ? Response.json(observation) : Response.json({ job: { id: 'job-7' } }, { status: 202 }))
  const helpers: PhpManageHelpers = {
    requireCaller: async () => caller, assertRoot: vi.fn(async () => {}), agent,
    listDomains: async () => [domain('a.test', 'acc-a', '8.3'), domain('b.test', 'acc-a', '7.4'), domain('c.test', 'acc-b', '8.4')],
    listAccounts: async () => [{ id: 'acc-a', username: 'karim' }, { id: 'acc-b', username: 'nour' }] as Account[],
    getServerSettings: async () => settings, saveServerSettings: vi.fn(async next => { settings = next; return next }),
    updateDomainPhp: vi.fn(async () => {}), reconcile: vi.fn(async () => ({ ok: true, body: { generation: 143 } })),
    audit: async (_caller, action) => { audits.push(action) }, now: () => new Date('2026-10-29T00:00:00Z'), ...over,
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL('https://panel.test' + path)
    return (await handlePhpManageRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers))!
  }
  return { helpers, call, audits, agent, settings: () => settings }
}

describe('PHP management workspace', () => {
  it('dates support from the php.net lifecycle', () => {
    const now = new Date('2026-10-29T00:00:00Z')
    expect(phpLifecycle('7.4', now).state).toBe('end-of-life')
    expect(phpLifecycle('8.1', now).state).toBe('end-of-life')
    expect(phpLifecycle('8.2', now).state).toBe('security')
    expect(phpLifecycle('8.4', now).state).toBe('active')
  })

  it('adds the saved default, lifecycle and domain usage to the host observation', async () => {
    const { call } = setup()
    const body = await (await call('GET', '/api/server/php/manage')).json() as { defaultVersion: string; versions: { version: string; domainCount: number; lifecycle: { state: string } }[] }
    expect(body.defaultVersion).toBe('8.3')
    expect(body.versions.find(item => item.version === '7.4')).toMatchObject({ domainCount: 1, lifecycle: { state: 'end-of-life' } })
  })

  it('changes the default for new domains only after a revision-bound check that it is installed and supported', async () => {
    const { call, settings, audits } = setup()
    await expect(call('PUT', '/api/server/php/default', { version: '8.4', expectedRevision: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('PUT', '/api/server/php/default', { version: '7.4', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call('PUT', '/api/server/php/default', { version: '8.2', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const response = await call('PUT', '/api/server/php/default', { version: '8.4', expectedRevision: REVISION })
    expect(await response.json()).toMatchObject({ defaultVersion: '8.4', scope: 'new-domains-only' })
    expect(settings().defaultPhpVersion).toBe('8.4')
    expect(audits).toEqual(['server.php.default.changed'])
  })

  it('moves every PHP domain of one account to an installed version and reconciles once', async () => {
    const { call, helpers, audits } = setup()
    const body = await (await call('POST', '/api/server/php/assign', { account: 'karim', version: '8.4', expectedRevision: REVISION })).json() as { changed: string[] }
    expect(body.changed).toEqual(['a.test', 'b.test'])
    expect(helpers.updateDomainPhp).toHaveBeenCalledTimes(2)
    expect(helpers.reconcile).toHaveBeenCalledTimes(1)
    expect(audits).toEqual(['server.php.account.assigned'])
    await expect(call('POST', '/api/server/php/assign', { account: 'karim', version: '8.2', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call('POST', '/api/server/php/assign', { account: 'ghost', version: '8.4', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to remove a version in use or the default before asking the host', async () => {
    const { call, agent } = setup()
    await expect(call('POST', '/api/server/php/manage/apply', { operation: 'remove-version', version: '7.4', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Move them first') })
    await expect(call('POST', '/api/server/php/manage/apply', { operation: 'remove-version', version: '8.3', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(agent).not.toHaveBeenCalled()
  })

  it('forwards previews and audits every submitted job', async () => {
    const { call, agent, audits } = setup()
    const response = await call('POST', '/api/server/php/manage/apply', { operation: 'set-extension', version: '8.3', extension: 'redis', enabled: true, expectedRevision: REVISION })
    expect(response.status).toBe(202)
    expect(agent).toHaveBeenCalledWith(caller, '/host/php/manage/apply', expect.objectContaining({ extension: 'redis' }))
    expect(audits).toEqual(['server.php.set-extension.submitted'])
    await expect(call('POST', '/api/server/php/manage/apply', { operation: 'set-ini', version: '8.3', path: '/etc/passwd', expectedRevision: REVISION })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('previews, grants and revokes a function exception per account, bound to the read list, audited and verified by the pools', async () => {
    const { call, helpers, audits, settings } = setup()
    const empty = exceptionsRevision([])
    const preview = await (await call('POST', '/api/server/php/exceptions', { account: 'karim', functions: ['proc_open', 'exec'], reason: 'queue worker', expectedRevision: empty, dryRun: true })).json() as { disableFunctions: string; allowed: string[] }
    expect(preview.allowed).toEqual(['exec', 'proc_open'])
    expect(preview.disableFunctions.split(',')).not.toContain('exec')
    expect(preview.disableFunctions.split(',')).toContain('shell_exec')
    expect(settings().phpFunctionExceptions).toBeUndefined()
    const granted = await (await call('POST', '/api/server/php/exceptions', { account: 'karim', functions: ['proc_open', 'exec'], reason: 'queue worker', expectedRevision: empty })).json() as { exceptionsRevision: string }
    expect(settings().phpFunctionExceptions).toMatchObject([{ account: 'karim', functions: ['exec', 'proc_open'], reason: 'queue worker', grantedBy: 'root' }])
    expect(helpers.reconcile).toHaveBeenCalledTimes(1)
    await expect(call('POST', '/api/server/php/exceptions', { account: 'karim', functions: ['dl'], reason: 'x', expectedRevision: granted.exceptionsRevision })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('DELETE', '/api/server/php/exceptions/karim', { expectedRevision: empty })).rejects.toMatchObject({ code: 'CONFLICT' })
    await call('DELETE', '/api/server/php/exceptions/karim', { expectedRevision: granted.exceptionsRevision })
    expect(settings().phpFunctionExceptions).toEqual([])
    expect(audits).toEqual(['server.php.exception.granted', 'server.php.exception.revoked'])
  })

  it('restores the previous exceptions when the pools refuse the change', async () => {
    const { call, settings, audits } = setup({ reconcile: vi.fn(async () => ({ ok: false, body: { error: 'php-fpm --test failed' } })) })
    await expect(call('POST', '/api/server/php/exceptions', { account: 'nour', functions: ['exec'], reason: 'thumbnails', expectedRevision: exceptionsRevision([]) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reverted: true } })
    expect(settings().phpFunctionExceptions).toEqual([])
    expect(audits).toEqual(['server.php.exception.granted'])
  })

  it('asserts root and modify authority before any read or write', async () => {
    const { call, helpers } = setup({ assertRoot: vi.fn(async () => { throw new Error('denied') }) })
    await expect(call('GET', '/api/server/php/manage')).rejects.toThrow('denied')
    expect(helpers.agent).not.toHaveBeenCalled()
  })
})
