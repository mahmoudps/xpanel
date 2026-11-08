import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { buildAccountPearCommand, handleAccountPackagesRoute, isAccountPearCommand, parseAccountPackageRequest, parsePearRegistryFile, readPearInventory } from './account-packages.ts'
import type { AccountPackageFiles, AccountPackageRouteDeps } from './account-packages.ts'

const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const plan = { id: 'plan', featureListId: 'list' } as Plan
const reg = (name: string, version: string): string => `a:3:{s:4:"name";s:${name.length}:"${name}";s:7:"version";a:2:{s:7:"release";s:${version.length}:"${version}";s:3:"api";s:3:"1.0";}}`
const PHP = '/usr/bin/php8.3', PEARCMD = '/usr/share/php/pearcmd.php'
const principal = { kind: 'user', id: 'p', username: 'alpha', accountId: account.id, disabled: false }

const fixture = (over: Partial<AccountPackageRouteDeps> = {}) => {
  const registry = new Map<string, string>()
  const files: AccountPackageFiles = {
    list: (async () => [...registry.keys()].map(name => ({ name, kind: 'file' }))) as never,
    readText: (async (path: string) => ({ content: registry.get(path.split('/').at(-1)!) ?? '' })) as never,
  }
  const run = vi.fn(async (argv: string[]) => {
    if (argv.includes('/usr/bin/systemd-run')) { if (argv.at(-2) === 'uninstall') registry.delete('config_lite.reg'); else registry.set('config_lite.reg', reg('Config_Lite', '0.2.6')); return { ok: true, stdout: '' } }
    return { ok: true, stdout: '' }
  })
  const audit = vi.fn(async () => {})
  const deps: AccountPackageRouteDeps = {
    caller: { role: 'user', accountId: account.id, principalId: 'p', actor: 'alpha' } as never, files: () => files, audit, currentPrincipal: async () => principal,
    store: { getAccountByUsername: async () => account, withAccountLifecycleLease: async (_id, action) => action(account) as never, getPlan: async () => plan, getFeatureList: async () => ({ disabled: [] }) as unknown as FeatureList, listDomains: async () => [{ accountId: account.id, name: 'example.test', php: { version: '8.3' } } as Domain] },
    host: { family: 'debian', phpBinary: () => PHP, present: async () => true, run, journal: async () => ['failed line'] }, ...over,
  }
  return { deps, run, audit, registry }
}
const call = async (deps: AccountPackageRouteDeps, body?: unknown) => {
  const url = new URL('http://agent/accounts/alpha/packages')
  const response = await handleAccountPackagesRoute(new Request(url, { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) }), url, body ? 'POST' : 'GET', deps)
  return await response!.json() as { revision: string; packages: { name: string }[]; system: { name: string }[]; includeSnippet: string; library: string; engine: boolean }
}

describe('owner PEAR packages', () => {
  it('reads name and release from a pear registry file and ignores anything else', () => {
    expect(parsePearRegistryFile(reg('Config_Lite', '0.2.6'))).toEqual({ name: 'Config_Lite', version: '0.2.6' })
    expect(parsePearRegistryFile('not a registry')).toBeNull()
  })
  it('reads an absent library as empty', async () => {
    const files = { list: async () => { throw Object.assign(new Error('x'), { code: 'NOT_FOUND', detail: {}, name: 'XpanelError' }) }, readText: async () => ({ content: '' }) }
    await expect(readPearInventory(files as never)).rejects.toBeDefined()
  })
  it('builds the installer as the numeric account with every directory in the home', () => {
    const argv = buildAccountPearCommand(account, PHP, PEARCMD, 'install', 'Config_Lite')
    expect(argv).toContain('User=20001'); expect(argv).toContain('--wait'); expect(argv).not.toContain('--no-block')
    const tail = argv.slice(argv.lastIndexOf('--') + 1)
    expect(tail.slice(0, 2)).toEqual([PHP, PEARCMD]); expect(tail.slice(-2)).toEqual(['install', 'Config_Lite'])
    expect(tail.filter(value => value.includes('_dir=')).every(value => value.split('=')[1]!.startsWith('/home/alpha/'))).toBe(true)
    expect(buildAccountPearCommand(account, PHP, PEARCMD, 'reinstall', 'Config_Lite').slice(-3)).toEqual(['install', '--force', 'Config_Lite'])
  })
  it('admits exactly what it builds', () => {
    for (const op of ['install', 'update', 'reinstall', 'remove'] as const) expect(isAccountPearCommand(buildAccountPearCommand(account, PHP, PEARCMD, op, 'Config_Lite'))).toBe(true)
    const argv = buildAccountPearCommand(account, PHP, PEARCMD, 'install', 'Config_Lite')
    expect(isAccountPearCommand(argv.map(value => value === 'User=20001' ? 'User=0' : value).map(value => value.startsWith('--working-directory=') ? '--working-directory=/root' : value))).toBe(false)
    expect(isAccountPearCommand(argv.map(value => value === 'Config_Lite' ? '--config=/etc/shadow' : value))).toBe(false)
    expect(isAccountPearCommand([...argv.slice(0, -2), '/bin/sh', 'x'])).toBe(false)
  })
  it('refuses unknown requests', () => {
    for (const body of [{ op: 'install', name: 'a b', expectedRevision: 'x' }, { op: 'exec' }, { op: 'search', query: '../x' }]) expect(() => parseAccountPackageRequest('POST', body)).toThrow()
  })
  it('installs into the account library and lists it, and removes it again', async () => {
    const f = fixture(), before = await call(f.deps)
    expect(before.library).toBe('/home/alpha/php'); expect(before.includeSnippet).toContain('/home/alpha/php'); expect(before.packages).toEqual([])
    const after = await call(f.deps, { op: 'install', name: 'Config_Lite', expectedRevision: before.revision })
    expect(after.packages).toEqual([{ name: 'Config_Lite', version: '0.2.6' }])
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.packages.install', outcome: 'ok' }))
    expect((await call(f.deps, { op: 'remove', name: 'Config_Lite', expectedRevision: after.revision })).packages).toEqual([])
  })
  it('refuses a system package with FORBIDDEN', async () => {
    const f = fixture(), before = await call(f.deps)
    await expect(call(f.deps, { op: 'remove', name: 'PEAR', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'system_package' } })
  })
  it('refuses every path when the plan lacks the feature', async () => {
    const f = fixture()
    f.deps.store.getFeatureList = async () => ({ disabled: ['php-pear-packages'] }) as unknown as FeatureList
    await expect(call(f.deps)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('reports a failed run with the installer log and never claims the change', async () => {
    const f = fixture(), before = await call(f.deps)
    f.run.mockImplementation(async argv => ({ ok: !argv.includes('/usr/bin/systemd-run'), stdout: '' }))
    await expect(call(f.deps, { op: 'install', name: 'Config_Lite', expectedRevision: before.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'pear_failed', log: ['failed line'] } })
  })
})
