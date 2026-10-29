import { describe, expect, it } from 'vitest'
import {
  assertAccountDomainGraph, assertDomainWorkspaceRevision, domainWorkspaceRevision,
  type DomainWorkspaceSource, type DomainWorkspaceTransition,
} from './domain-workspace.ts'
import { isXpanelError } from './errors.ts'
import type { Account, Domain, Plan } from './types.ts'

const id = (n: number): string => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
const account: Account = {
  id: id(1), username: 'owner', uid: 10000, gid: 10000, home: '/home/owner', primaryDomain: 'owner.example.test',
  planId: id(2), ownerId: null, status: 'active', suspendReason: null, contactEmail: 'Alice@example.test',
  ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-26T00:00:00.000Z',
}
const plan: Plan = {
  id: account.planId, name: 'Domain plan', ownerId: null, featureListId: id(3),
  resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
  caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
  dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
}
const domain = (number: number, patch: Partial<Domain> = {}): Domain => ({
  id: id(number), accountId: account.id, name: `domain${number}.example.test`, kind: 'addon', parentId: null,
  docRoot: `/home/owner/domains/domain${number}.example.test/public_html`, siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ...patch,
})
const root = domain(10, { kind: 'primary', name: account.primaryDomain, docRoot: '/home/owner/public_html' })
const addon = domain(11)
const alias = domain(12, { kind: 'alias', parentId: root.id, docRoot: root.docRoot })
const source = (): DomainWorkspaceSource => ({
  account: { ...account }, plan: structuredClone(plan), disabledFeatures: ['terminal', 'backups'],
  domains: structuredClone([root, addon, alias]),
  dependencies: [
    { domainId: root.id, childCount: 1, serviceUserCount: 2 },
    { domainId: addon.id, childCount: 0, serviceUserCount: 0 },
    { domainId: alias.id, childCount: 0, serviceUserCount: 0 },
  ],
  managedConfigDigests: { [root.id]: 'a'.repeat(64), [addon.id]: 'b'.repeat(64) },
})
const codeOf = (fn: () => unknown): string => {
  try { fn(); return 'ok' } catch (error) { return isXpanelError(error) ? error.code : 'raw' }
}

describe('account domain related graph preflight', () => {
  it('accepts an owned forest, existing structural name grammar and unrelated foreign corruption', () => {
    const child = domain(13, { kind: 'subdomain', parentId: addon.id, name: 'legacy.example.test' })
    const foreign = domain(20, { accountId: id(90), parentId: id(999) })
    expect(() => assertAccountDomainGraph([root, addon, alias, child, foreign], account.id)).not.toThrow()
    expect(() => assertAccountDomainGraph([foreign], account.id)).not.toThrow()
  })

  it.each([
    ['missing parent', [root, domain(13, { kind: 'subdomain', parentId: id(999) })]],
    ['foreign parent', [root, domain(13, { kind: 'subdomain', parentId: id(20) }), domain(20, { accountId: id(90) })]],
    ['foreign incoming edge', [root, domain(20, { accountId: id(90), parentId: root.id })]],
    ['duplicate owned id', [root, { ...root }]],
    ['duplicate id across tenants', [root, { ...root, accountId: id(90), name: 'foreign.example.test' }]],
    ['self link', [domain(13, { kind: 'subdomain', parentId: id(13) })]],
    ['two node cycle', [domain(13, { kind: 'subdomain', parentId: id(14) }), domain(14, { kind: 'subdomain', parentId: id(13) })]],
    ['three node cycle', [domain(13, { kind: 'subdomain', parentId: id(14) }), domain(14, { kind: 'subdomain', parentId: id(15) }), domain(15, { kind: 'subdomain', parentId: id(13) })]],
  ] as const)('rejects %s before effects', (_name, domains) => {
    expect(codeOf(() => assertAccountDomainGraph(domains, account.id))).toBe('PRECONDITION_FAILED')
  })

  it('ignores duplicate ids in an unrelated foreign component', () => {
    const foreign = domain(20, { accountId: id(90) })
    expect(() => assertAccountDomainGraph([root, foreign, { ...foreign }], account.id)).not.toThrow()
  })

  it('does not disclose a foreign name or identifier in diagnostics', () => {
    const foreign = domain(20, { accountId: id(90), name: 'private-foreign.example.test', parentId: root.id })
    try {
      assertAccountDomainGraph([root, foreign], account.id)
      expect.fail('corrupt graph accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'domain_graph_invalid', stateChanged: false } })
      const diagnostic = `${(error as Error).message} ${JSON.stringify(error)}`
      expect(diagnostic).not.toContain(foreign.name)
      expect(diagnostic).not.toContain(foreign.id)
      expect(diagnostic).not.toContain(foreign.accountId)
    }
  })

  it('walks a long chain iteratively without a recursive stack or arbitrary depth limit', () => {
    const domains = Array.from({ length: 20000 }, (_, index) => domain(index + 100, {
      kind: index === 0 ? 'addon' : 'subdomain', parentId: index === 0 ? null : id(index + 99),
    }))
    expect(() => assertAccountDomainGraph([...domains].reverse(), account.id)).not.toThrow()
  })
})

describe('trusted domain workspace current-value revision', () => {
  it('returns deterministic lowercase64hex without changing the source', () => {
    const input = source(), before = structuredClone(input)
    const revision = domainWorkspaceRevision(input)
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(domainWorkspaceRevision(input)).toBe(revision)
    expect(input).toEqual(before)
  })

  it('stabilizes rows, dependencies, feature sets, digests and nested object keys', () => {
    const input = source()
    const reordered = source()
    input.domains = input.domains.map(row => ({ ...row, php: { ...row.php, ini: { memory_limit: '64M', display_errors: 'Off' } } }))
    reordered.domains = [...reordered.domains].reverse().map(row => ({ ...row, php: { ...row.php, ini: { display_errors: 'Off', memory_limit: '64M' } } }))
    reordered.dependencies = [...reordered.dependencies].reverse()
    reordered.disabledFeatures = ['backups', 'terminal', 'backups']
    reordered.managedConfigDigests = { [addon.id]: 'b'.repeat(64), [root.id]: 'a'.repeat(64) }
    expect(domainWorkspaceRevision(reordered)).toBe(domainWorkspaceRevision(input))
  })

  it('canonicalizes absent optional IP values and sorts additional account addresses', () => {
    const first = source(), second = source()
    first.account.extraIps = ['192.0.2.12', '192.0.2.11']
    second.account.extraIps = ['192.0.2.11', '192.0.2.12']
    second.account.ipv6 = null
    second.domains = second.domains.map(row => ({ ...row, ipv4: null, ipv6: null }))
    expect(domainWorkspaceRevision(first)).toBe(domainWorkspaceRevision(second))
  })

  it('excludes contact and unrelated shell/suspension text or foreign domains', () => {
    const input = source(), changed = source()
    changed.account.contactEmail = 'Changed@example.test'
    changed.account.shell = 'jailed'
    changed.account.suspendReason = 'unrelated display text'
    changed.domains = [...changed.domains, domain(20, { accountId: id(90) })]
    expect(domainWorkspaceRevision(changed)).toBe(domainWorkspaceRevision(input))
  })

  it.each<[string, Partial<Account>]>([
    ['username', { username: 'different' }], ['uid', { uid: 10001 }], ['gid', { gid: 10001 }],
    ['home', { home: '/home/different' }], ['primaryDomain', { primaryDomain: 'other.example.test' }],
    ['planId', { planId: id(50) }], ['ownerId', { ownerId: id(51) }], ['status', { status: 'suspended' }],
    ['createdAt', { createdAt: '2026-10-26T00:00:01.000Z' }], ['ipv4', { ipv4: '192.0.2.11' }],
    ['ipv6', { ipv6: '2001:db8::1' }], ['extraIps', { extraIps: ['192.0.2.12'] }],
  ])('binds account %s', (_field, patch) => {
    const input = source()
    expect(domainWorkspaceRevision({ ...input, account: { ...input.account, ...patch } })).not.toBe(domainWorkspaceRevision(input))
  })

  it('binds account identity while keeping each source internally owned', () => {
    const input = source(), changed = source()
    changed.account.id = id(91)
    changed.domains = changed.domains.map(row => ({ ...row, accountId: changed.account.id }))
    expect(domainWorkspaceRevision(changed)).not.toBe(domainWorkspaceRevision(input))
  })

  it.each<[string, Partial<Domain>]>([
    ['name', { name: 'changed.example.test' }], ['docRoot', { docRoot: '/home/owner/changed' }],
    ['siteType', { siteType: 'static' }], ['upstream', { siteType: 'proxy', upstream: 'http://127.0.0.1:3000' }],
    ['redirect', { redirect: { to: 'https://example.test/', code: 301 } }], ['wildcard', { wildcard: true }],
    ['certificateId', { certificateId: id(60) }], ['suspended', { suspended: true }],
    ['expiresAt', { expiresAt: '2027-01-01T00:00:00.000Z' }], ['pathQuotaMb', { pathQuotaMb: 100 }],
    ['ipv4', { ipv4: '192.0.2.10' }], ['ipv6', { ipv6: '2001:db8::1' }],
    ['kind', { kind: 'addon' }],
  ])('binds domain %s', (_field, patch) => {
    const input = source()
    const changed = { ...input, domains: input.domains.map(row => row.id === root.id ? { ...row, ...patch } : row) }
    expect(domainWorkspaceRevision(changed)).not.toBe(domainWorkspaceRevision(input))
  })

  it('binds parent links and nested PHP settings', () => {
    const input = source()
    const parent = { ...input, domains: input.domains.map(row => row.id === alias.id ? { ...row, parentId: addon.id } : row) }
    const php = { ...input, domains: input.domains.map(row => ({ ...row, php: { ...row.php, fpm: { ...row.php.fpm, maxChildren: 3 } } })) }
    const ini = { ...input, domains: input.domains.map(row => ({ ...row, php: { ...row.php, ini: { memory_limit: '64M' } } })) }
    for (const changed of [parent, php, ini]) expect(domainWorkspaceRevision(changed)).not.toBe(domainWorkspaceRevision(input))
  })

  it.each<[string, (value: DomainWorkspaceSource) => void]>([
    ['plan name', value => { value.plan.name = 'Changed plan' }],
    ['plan ownership', value => { value.plan.ownerId = id(61) }],
    ['feature policy', value => { value.plan.featureListId = id(62) }],
    ['domain cap', value => { value.plan.caps.addonDomains = 6 }],
    ['PHP cap', value => { value.plan.caps.phpWorkers = 6 }],
    ['resource policy', value => { value.plan.resources.diskMb = 2000 }],
    ['dedicated IP policy', value => { value.plan.dedicatedIp = true }],
    ['plan shell policy', value => { value.plan.shell = 'jailed' }],
    ['mailbox policy', value => { value.plan.defaultMailboxQuotaMb = 200 }],
    ['disabled feature', value => { value.disabledFeatures = ['domains'] }],
    ['child dependency', value => { value.dependencies = [{ domainId: root.id, childCount: 2, serviceUserCount: 2 }] }],
    ['service dependency', value => { value.dependencies = [{ domainId: root.id, childCount: 1, serviceUserCount: 3 }] }],
    ['managed configuration', value => { value.managedConfigDigests = { [root.id]: 'c'.repeat(64) } }],
  ])('binds %s', (_field, change) => {
    const input = source(), changed = source()
    change(changed)
    expect(domainWorkspaceRevision(changed)).not.toBe(domainWorkspaceRevision(input))
  })

  it('rejects a corrupt related graph instead of hashing a filtered partial success', () => {
    const input = source()
    input.domains = [...input.domains, domain(20, { accountId: id(90), parentId: root.id })]
    expect(codeOf(() => domainWorkspaceRevision(input))).toBe('PRECONDITION_FAILED')
  })

  it('explicitly permits current-value ABA and preserves the transition type contract', () => {
    const input = source(), original = domainWorkspaceRevision(input)
    const changed = { ...input, domains: input.domains.map(row => ({ ...row, docRoot: '/home/owner/changed' })) }
    expect(domainWorkspaceRevision(changed)).not.toBe(original)
    expect(domainWorkspaceRevision(source())).toBe(original)
    const transition: DomainWorkspaceTransition = { account, before: [root], after: [root], affectedIds: [root.id] }
    expect(transition.affectedIds).toEqual([root.id])
  })
})

describe('domain workspace revision input', () => {
  it.each(['0'.repeat(64), '0123456789abcdef'.repeat(4)])('accepts exact lowercase64hex %s', value => {
    expect(assertDomainWorkspaceRevision(value)).toBe(value)
  })
  it.each([
    null, undefined, 42, {}, [], new String('a'.repeat(64)), '', 'a'.repeat(63), 'a'.repeat(65),
    'A'.repeat(64), 'g'.repeat(64), ` ${'a'.repeat(64)}`, `${'a'.repeat(64)} `, `${'a'.repeat(64)}\n`,
    `${'a'.repeat(63)}\u0000`, String.fromCharCode(0xff10).repeat(64),
  ])('rejects malformed input without normalization %j', value => {
    expect(codeOf(() => assertDomainWorkspaceRevision(value))).toBe('VALIDATION')
  })
})
