import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_SERVER_FTP_SETTINGS, defaultFirewallRules, hostingServiceFirewallRules, suggestServerSettings } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { profileFor, SUPPORTED_OS } from '@xpanel/os'
import { services } from '@xpanel/render'
import { atomicWriteJson, createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { readAccountPages } from './account-pages.ts'
import { observeMariadbHost } from './db-server-config.ts'
import { createProductionHostTargetMatcher, SYSTEMD_DROPIN_DIR_RE, type HostTargetOperation } from './executor.ts'
import { observeFtpHost } from './ftp-server.ts'
import { readHostTools } from './host-tools.ts'
import { NATIVE_TRUSTED_HOST_TARGETS } from './lifecycle/native-runtime.ts'
import { LIST_POLICY_DEFAULTS, listGateRules } from './list-moderation-policy.ts'
import { readMailForwardingConfiguration, readMailfxRenderInput } from './mailfx-render.ts'
import { observePhpMyAdminHost } from './phpmyadmin-access.ts'
import { compileDesiredGeneration, type CompiledGeneration } from './reconciler.ts'
import { readSecEdgeConfiguration } from './sec-waf.ts'
import { readServerOperations } from './server-operations.ts'
import { readSvcHostInput } from './svc-reconcile.ts'
import { MAILX_RSPAMD_MILTER } from '../../../packages/os/src/mailx-command.ts'

// Every path and operation a generation asks the executor for must be admitted by the production policy the
// native agent and the lifecycle runner build. A refusal here is the first /state/apply refusal on that host.
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const RELEASES = SUPPORTED_OS.flatMap(entry => entry.versions.map(version => `${entry.id} ${version}`))
// An installed host as the observers see it: every probed binary and file is present.
const installed = { runCommand: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }), readFile: async () => null }
const matcher = createProductionHostTargetMatcher()
const admitted = (path: string, operation: HostTargetOperation): boolean =>
  matcher(path, operation) || NATIVE_TRUSTED_HOST_TARGETS.some(target => target.path === path && target.operations.includes(operation))

/** The executor's own requests for one plan: preflight's file and action checks, and the drop-in directory writeFile creates. */
const hostTargets = (plan: Pick<CompiledGeneration, 'files' | 'preActions' | 'postActions'>): [string, HostTargetOperation][] => [
  ...plan.files.flatMap(file => [
    ...(['read', 'write', 'remove'] as const).map((operation): [string, HostTargetOperation] => [file.path, operation]),
    ...(SYSTEMD_DROPIN_DIR_RE.test(dirname(file.path)) ? [[dirname(file.path), 'ensure-directory'] as [string, HostTargetOperation]] : []),
  ]),
  ...[...plan.preActions, ...plan.postActions].flatMap((action): [string, HostTargetOperation][] =>
    action.kind === 'ensure-dir' ? [[action.path, 'ensure-directory']] : action.kind === 'remove-path' ? [[action.path, 'remove']] : []),
]

let state: TestStateStoreHandle
let seeded: Awaited<ReturnType<typeof seed>>
beforeAll(async () => { state = await createTestStateStore(); seeded = await seed() })
afterAll(async () => { await state.close() })

/** One account with web, mail, FTP, DNS, databases, DAV and cron; saved once, compiled per OS profile. */
async function seed() {
  const store = state.store, root = state.rootDir, suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
    nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443, ftp: { ...DEFAULT_SERVER_FTP_SETTINGS, anonymous: true, anonymousUploads: true } })
  await store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const features = await store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id,
    resources: { diskMb: 10_240, bandwidthMbMonth: 102_400, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 2000, ioWriteIops: 2000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 200 },
    caps: { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 1024 })
  const account = await store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'jailed',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  await store.createServiceUser({ accountId: account.id, login: 'info@alice.example.com', services: { email: true, ftp: true, webdisk: true }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: `{ARGON2ID}${ARGON2}` })
  await store.createDatabase({ accountId: account.id, name: 'alice_shop' })
  await store.saveCronJobs(account.id, [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', accountId: account.id, schedule: '@daily', command: 'php artisan schedule:run', comment: 'Fixture work', enabled: true, maxRuntimeSec: 300 }])
  await store.saveDnsZone({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', accountId: account.id, name: 'alice.example.com', serial: 2026110901,
    records: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', zone: 'alice.example.com', name: '@', type: 'A', ttl: 300, content: '203.0.113.10', priority: null }] })
  const save = (rel: string[], value: unknown) => atomicWriteJson(join(root, 'extended', ...rel), value)
  await save(['mail', 'forwarders.json'], [{ id: 'f1', accountId: account.id, sourceAddress: 'orders@alice.example.com', destinations: ['info@alice.example.com'], createdAt: '2026-11-09T00:00:00.000Z' }])
  await save(['mail', 'filters.json'], [{ id: 'r1', accountId: account.id, scope: 'mailbox', mailbox: 'info@alice.example.com', name: 'Suppliers', priority: 1, enabled: true, matchAll: true,
    conditions: [{ field: 'from', comparator: 'contains', value: '@supplier.example' }], actions: [{ type: 'fileinto', target: 'Suppliers' }], createdAt: '2026-11-09T00:00:00.000Z' }])
  const saved = await store.readSnapshot()
  // A CGI addon site, a certificate that covers the account's names (Web Disk and calendar edge) and the firewall the operator
  // turns on with its defaults and the hosting service ports.
  const snapshot = { ...saved,
    firewall: { ...saved.firewall, rules: [...defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }), ...hostingServiceFirewallRules()] },
    domains: [...saved.domains, { ...saved.domains[0]!, id: 'abababab-abab-4bab-8bab-abababababab', name: 'shop.example.com', kind: 'addon' as const, docRoot: '/home/alice/shop.example.com', php: { ...saved.domains[0]!.php, handler: 'cgi' as const } }],
    certificates: [{ id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', accountId: account.id, names: ['alice.example.com', '*.alice.example.com', 'shop.example.com'], source: 'acme' as const, challenge: 'http-01' as const, notAfter: '2099-01-01T00:00:00.000Z', autoRenew: true,
      notBefore: null, certPath: '/etc/xpanel/ssl/cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd/fullchain.pem', keyPath: '/etc/xpanel/ssl/cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd/privkey.pem', chainPath: null, fingerprintSha256: null, lastError: null, renewedAt: null }] }
  const address = 'team@alice.example.com', gate = services.listGateAddress(account.id, address)
  const forwarding = await readMailForwardingConfiguration(root, snapshot)
  return { snapshot, account, forwarding: { ...forwarding, lists: [{ accountId: account.id, address, members: ['a@remote.example'], gate: { gate, account: { username: account.username, uid: account.uid, gid: account.gid, home: account.home },
    rules: listGateRules({ address, members: ['a@remote.example'], moderation: 'members', policy: LIST_POLICY_DEFAULTS }, account.home) } }] } }
}

/** The generation the reconciler compiles on an installed host of this profile, with the server-wide tools it reads from saved state. */
async function generation(os: OsProfile): Promise<CompiledGeneration> {
  const { snapshot, account, forwarding } = seeded, root = state.rootDir
  const ftp = await observeFtpHost(installed, os, root), mariadb = await observeMariadbHost(installed, root)
  const phpMyAdmin = await observePhpMyAdminHost(installed, os, root, { hostname: 'srv1.example.com', panelPort: 2087 })
  const accountPages = await readAccountPages(root, { accounts: snapshot.accounts, resellers: snapshot.resellers, settings: snapshot.server!.settings })
  return compileDesiredGeneration(snapshot, {
    os, quotaFilesystem: '/home', selinux: os.family === 'rhel', sourceBuildHook: os.family === 'rhel',
    managementHosts: ['panel.example.com'], managementPorts: [2087], davIngress: { panelHost: 'panel.example.com' }, ...(accountPages ? { accountPages } : {}),
    mailForwarding: forwarding,
    mailFx: { ...await readMailfxRenderInput(root, snapshot, os.family, null), spamMilter: MAILX_RSPAMD_MILTER, fts: true, listGateProgram: '#!/bin/sh\n' },
    mailTls: { certFile: '/etc/xpanel/ssl/mail/fullchain.pem', keyFile: '/etc/xpanel/ssl/mail/privkey.pem' },
    secEdge: await readSecEdgeConfiguration(root, { family: os.family, domains: snapshot.domains }),
    svcHost: { ...await readSvcHostInput(root, snapshot, false), tracerouteAllowed: false, smtpRestricted: true, forkBombUsers: ['alice'], webStatusToken: 'a'.repeat(64) },
    compilerAccess: { restricted: true, members: ['alice'], packageHook: true },
    serverOperations: { ...await readServerOperations(root), systemMail: { root: 'admin@example.net', nobody: 'root', xpanel: null }, panelTls: { protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'HIGH:!aNULL' }, hostTools: await readHostTools(root) },
    etcHosts: '127.0.0.1 localhost\n', observedHostname: 'old-vm\n', nfsClients: ['198.51.100.7'],
    ...(ftp && { ftpServer: { ...ftp, certPresent: false, anonymous: { [account.id]: { enabled: true, uploads: true } }, roleEnabled: true } }),
    ...(mariadb && { mariadbServer: mariadb }), ...(phpMyAdmin && { phpMyAdminAccess: phpMyAdmin }),
  })
}

describe('reconcile plan host targets on every supported OS profile', { tags: ['feature'] }, () => {
  it.each(RELEASES)('admits every path and operation of an all-roles generation on %s', async release => {
    const [id, versionId] = release.split(' ')
    const os = profileFor(`ID=${id}\nVERSION_ID="${versionId}"\n`)
    const targets = hostTargets(await generation(os)), paths = targets.map(([path]) => path)
    // The plan really carries each role, so an empty generation cannot pass.
    for (const role of [/\/pure-ftpd\//, /\/dovecot\//, /\/postfix\//, /\.zone$/, /alice\.example\.com/, /000-xpanel-status\.conf$/, /90-xpanel\.cnf$/, /phpmyadmin/i, /xpanel-dav/, /xpanel-cron-alice-/, /\.dovecot\.sieve$/, /nftables/]) {
      expect(paths.some(path => role.test(path)), String(role)).toBe(true)
    }
    const refused = [...new Set(targets.filter(([path, operation]) => !admitted(path, operation)).map(([path, operation]) => `${operation} ${path}`))]
    expect(refused).toEqual([])
  })

  it('admits the firewall table, the EL pure-ftpd directory and the CGI wrapper tree exactly', () => {
    const operations: HostTargetOperation[] = ['read', 'write', 'remove', 'ensure-directory']
    const only = (path: string, allowed: HostTargetOperation[]) => expect(operations.filter(operation => matcher(path, operation)), path).toEqual(allowed)
    for (const path of ['/etc/nftables.conf', '/etc/sysconfig/nftables.conf']) only(path, ['read', 'write', 'remove'])
    for (const path of ['/etc/sysconfig', '/etc/sysconfig/network', '/etc/nftables.conf.bak', '/etc/sysconfig/nftables.conf/x']) only(path, [])
    only('/etc/pki/pure-ftpd', ['ensure-directory'])
    for (const path of ['/etc/pki', '/etc/pki/pure-ftpd/pure-ftpd.pem', '/etc/pki/pure-ftpd/other', '/etc/pki/tls/private/localhost.key']) only(path, [])
    for (const root of ['/home/xpanel-cgi', '/var/www/xpanel-cgi']) {
      for (const path of [root, root + '/alice']) only(path, ['ensure-directory'])
      for (const path of [root + '/alice/php8.3.cgi', root + '/alice/php7.4.fcgi']) only(path, ['read', 'write', 'remove'])
      for (const path of [root + '/alice/index.php', root + '/alice/php8.3.cgi/x', root + '/alice/sub/php8.3.cgi', root + '/../alice/php8.3.cgi', root + '/Alice/php8.3.cgi']) only(path, [])
    }
    for (const path of ['/var/www', '/var/www/html', '/var/www/html/index.php', '/srv/xpanel-cgi/alice']) only(path, [])
  })
})
