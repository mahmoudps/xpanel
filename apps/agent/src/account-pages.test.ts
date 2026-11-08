import { describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { edge } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import { resolveAccountPages } from './account-pages.ts'
import { compileDesiredGeneration } from './reconciler.ts'

const reseller = '11111111-1111-4111-8111-111111111111', template = '22222222-2222-4222-8222-222222222222'
const base = { resellers: [{ id: reseller, contactEmail: 'help@reseller.test' }], adminEmail: 'root@host.test', root: {}, byReseller: new Map(), templates: [] }
const account = (id: string, ownerId: string | null, planId = 'p') => ({ id, planId, ownerId })
const pageOf = (pages: ReturnType<typeof resolveAccountPages>, id: string, kind: edge.AccountPageKind): string => pages.scopes.find(item => item.scope === pages.scopeOf.get(id))!.pages[kind]

describe('account pages', () => {
  it('ships a page with the server contact', () => {
    const pages = resolveAccountPages({ ...base, accounts: [account('a', null)] })
    expect(pages.scopes).toHaveLength(1)
    expect(pageOf(pages, 'a', 'suspended')).toContain('root@host.test')
  })
  it("renders a reseller's template for its accounts only", () => {
    const byReseller = new Map([[reseller, { suspended: { html: '<h1>R is closed</h1> %contact%' } }]])
    const pages = resolveAccountPages({ ...base, byReseller, accounts: [account('mine', reseller), account('root', null)] })
    expect(pageOf(pages, 'mine', 'suspended')).toBe('<h1>R is closed</h1> help@reseller.test')
    expect(pageOf(pages, 'root', 'suspended')).toContain('This account has been suspended')
    expect(pageOf(pages, 'mine', 'default')).toContain('Default web site page')
    expect(pages.scopeOf.get('mine')).toBe('r-' + reseller)
  })
  it("gives a plan template's text first place and escapes it", () => {
    const saved = { id: template, planIds: ['p'], defaultPage: { title: 'A & B', body: 'one\ntwo' }, suspendedPage: { title: '', body: '' } }
    const byReseller = new Map([[reseller, { suspended: { html: 'owner page' } }]])
    const pages = resolveAccountPages({ ...base, byReseller, templates: [saved], accounts: [account('a', reseller)] })
    expect(pageOf(pages, 'a', 'default')).toContain('<title>A &amp; B</title>')
    expect(pageOf(pages, 'a', 'default')).toContain('<p>one</p><p>two</p>')
    expect(pageOf(pages, 'a', 'suspended')).toBe('owner page')
    expect(pages.scopeOf.get('a')).toBe(`t-${template}-${reseller}`)
  })
  it('keeps the page files root-owned and out of every home', () => {
    const { files, dirs } = edge.accountPageFiles([{ scope: '', pages: edge.SHIPPED_ACCOUNT_PAGES }, { scope: 'r-x', pages: edge.SHIPPED_ACCOUNT_PAGES }])
    expect(files.map(file => file.path)).toEqual(['/usr/share/xpanel/default/index.html', '/usr/share/xpanel/suspended/index.html', '/usr/share/xpanel/default/r-x/index.html', '/usr/share/xpanel/suspended/r-x/index.html'])
    expect(files.every(file => file.owner === 'root' && file.mode === 0o644)).toBe(true)
    expect(dirs.map(item => (item as { path: string }).path)).toEqual(['/usr/share/xpanel/default/r-x', '/usr/share/xpanel/suspended/r-x'])
    expect(() => edge.accountPageDir('default', '../x')).toThrow()
  })
})

describe('account pages and home roots in a generation', () => {
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
  const moved = async () => {
    const state = await createTestStateStore()
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'fixture.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'ops@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const features = await state.store.createFeatureList({ name: 'Fixture', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Fixture', ownerId: null, featureListId: features.id, shell: 'none', defaultMailboxQuotaMb: 100, dedicatedIp: false,
      resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 2 } })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, note: null } as never)
    // Shape-only state fixture; never authenticated.
    const account = await state.store.createAccount({ username: 'alice', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } } })
    await state.store.beginHomeMove(account.id, '/home2/alice')
    await state.store.finishHomeMove(account.id)
    return { state, snapshot: await state.store.readSnapshot(), account }
  }
  const page = (html: string) => ({ scopes: [{ scope: '', pages: { default: html, suspended: 'closed' } }], scopeOf: new Map<string, string>() })

  it('publishes a saved page as a new root file the vhost points at', async () => {
    const { state, snapshot } = await moved()
    try {
      const first = compileDesiredGeneration(snapshot, { os, quotaFilesystem: '/home', accountPages: page('one') })
      const second = compileDesiredGeneration(snapshot, { os, quotaFilesystem: '/home', accountPages: page('two') })
      const content = (compiled: typeof first) => compiled.files.find(file => file.path === '/usr/share/xpanel/default/index.html')!.content
      expect([content(first), content(second)]).toEqual(['one', 'two'])
      const vhost = first.files.find(file => file.content.includes('/home2/alice/public_html') && file.content.includes('<VirtualHost'))!
      expect(vhost.content).toContain(edge.ACCOUNT_PAGE_ALIAS)
      expect(first.files.some(file => file.path.startsWith('/home'))).toBe(false)
    } finally { await state.close() }
  })
  it('limits an account on the quota of its own home root, or not at all', async () => {
    const { state, snapshot } = await moved()
    try {
      const quotas = (filesystem: string | null) => compileDesiredGeneration(snapshot, { os, quotaFilesystem: '/home', quotaFilesystems: new Map([['/home2', filesystem]]) }).preActions
        .flatMap(action => action.kind === 'set-quota' ? [action.filesystem] : [])
      expect(quotas('/data')).toEqual(['/data'])
      expect(quotas(null)).toEqual([])
    } finally { await state.close() }
  })
})
