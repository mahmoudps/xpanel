import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { services } from '@xpanel/render'
import { atomicWriteJson, createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const SIEVE = '/home/alice/mail/alice-shop.com/info/.dovecot.sieve'

describe('account mail routing applied by the reconciler', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let executor: FakeHostExecutor
  let reconciler: HostReconciler
  let accountId: string
  let mailboxId: string

  const save = (rel: string[], value: unknown) => atomicWriteJson(join(state.rootDir, 'extended', ...rel), value)
  const file = (path: string) => executor.files.get(path)?.content

  beforeEach(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    executor = new FakeHostExecutor()
    reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    const features = await state.store.createFeatureList({ name: 'Mail', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Mail plan', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice-shop.com', planId: plan.id, ownerId: null,
      contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    accountId = account.id
    mailboxId = (await state.store.createServiceUser({ accountId, login: 'info@alice-shop.com', passwordHash: `{ARGON2ID}${ARGON2}`,
      services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' })).id
  })
  afterEach(async () => { await state.close(); await db.close() })

  it('writes forwarders, rejects, the default address and the mailbox script, then repeats without change', async () => {
    await save(['mail', 'forwarders.json'], [
      { id: 'f1', accountId, sourceAddress: 'orders@alice-shop.com', destinations: ['info@alice-shop.com', 'warehouse@partner.example'], createdAt: '2026-10-28T00:00:00.000Z' },
      { id: 'f2', accountId, sourceAddress: 'old@alice-shop.com', action: 'reject', destinations: [], rejectMessage: 'No longer used', createdAt: '2026-10-28T00:00:00.000Z' },
    ])
    await save(['mail', 'default-addresses.json'], [{ accountId, domain: 'alice-shop.com', kind: 'discard', destination: null, updatedAt: '2026-10-28T00:00:00.000Z' }])
    await save(['mail', 'filters.json'], [{ id: 'r1', accountId, scope: 'mailbox', mailbox: 'info@alice-shop.com', name: 'Suppliers', priority: 1, enabled: true, matchAll: true,
      conditions: [{ field: 'from', comparator: 'contains', value: '@atlas-pack.example' }], actions: [{ type: 'fileinto', target: 'Suppliers' }], createdAt: '2026-10-28T00:00:00.000Z' }])
    await save(['webmail', 'vacation', `${encodeURIComponent('info@alice-shop.com')}.json`], { mailbox: 'info@alice-shop.com', ownerAuthority: { accountId, serviceUserId: mailboxId, mailbox: 'info@alice-shop.com' }, enabled: true, subject: 'Away', body: 'Back on Monday.',
      htmlBody: '', startDate: null, endDate: null, replyIntervalHours: 24, compiledSieve: '', updatedAt: '2026-10-28T00:00:00.000Z' })

    const first = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(first.status).toBe('applied')
    expect(file('/etc/postfix/xpanel/virtual_aliases')).toContain('orders@alice-shop.com\tinfo@alice-shop.com,warehouse@partner.example\n')
    expect(file('/etc/postfix/xpanel/virtual_aliases')).toContain('@alice-shop.com\tdiscard@xpanel-discard.invalid\n')
    expect(file('/etc/postfix/xpanel/recipient_access')).toContain('old@alice-shop.com\tREJECT 5.1.1 No longer used\n')
    expect(file('/etc/dovecot/conf.d/95-xpanel-sieve.conf')).toContain('sieve_extensions = +vacation-seconds')
    expect(executor.files.get(SIEVE)).toMatchObject({ owner: 'alice', group: 'alice', mode: 0o600 })
    expect(file(SIEVE)).toContain('fileinto :create "Suppliers";')
    expect(file(SIEVE)).toContain('vacation :days 1 :subject "Away"')
    expect(executor.dirs.get('/home/alice/mail/alice-shop.com/info')).toMatchObject({ owner: 'alice', mode: 0o700 })
    expect(executor.executedTests.map(test => test.name)).toContain('sieve')

    const again = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(again.status).toBe('noop')
  })

  it('removes the mailbox script when the last rule goes and keeps the previous generation when sievec refuses', async () => {
    const rule = { id: 'r1', accountId, scope: 'global', mailbox: null, name: 'Invoices', priority: 1, enabled: true, matchAll: true,
      conditions: [{ field: 'subject', comparator: 'contains', value: 'Invoice' }], actions: [{ type: 'fileinto', target: 'Invoices' }], createdAt: '2026-10-28T00:00:00.000Z' }
    await save(['mail', 'filters.json'], [rule])
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    const applied = file(SIEVE)
    expect(applied).toContain('# rule: Invoices')

    executor.failConfigTest('sieve', 'Invoices.sieve: line 4: error: unknown extension')
    await save(['mail', 'filters.json'], [{ ...rule, name: 'Receipts' }])
    const refused = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(refused).toMatchObject({ status: 'failed', failedTest: 'sieve' })
    expect(file(SIEVE)).toBe(applied)

    executor.clearConfigTestFailures()
    await save(['mail', 'filters.json'], [])
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    expect(executor.files.has(SIEVE)).toBe(false)
  })

  it('refuses to reconcile a forwarder that names a domain of another account', async () => {
    await save(['mail', 'forwarders.json'], [{ id: 'x', accountId: 'another-account', sourceAddress: 'info@alice-shop.com', destinations: ['thief@evil.example'], createdAt: '2026-10-28T00:00:00.000Z' }])
    await expect(reconciler.reconcile({ actor: 'root', mailAuth: null })).rejects.toThrow(/Saved mail forwarding configuration is invalid/)
    expect(file('/etc/postfix/xpanel/virtual_aliases')).toBeUndefined()
  })

  it('answers for addresses without a mailbox through a hidden login-less user that replies and keeps nothing', async () => {
    await save(['mail', 'forwarders.json'], [{ id: 'f1', accountId, sourceAddress: 'sales@alice-shop.com', destinations: ['desk@partner.example'], createdAt: '2026-10-28T00:00:00.000Z' }])
    const responder = (address: string) => ({ id: address, accountId, address, enabled: true, subject: 'Thanks for writing', body: 'We answer within a day.', htmlBody: '',
      startDate: null, endDate: null, replyIntervalHours: 24, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z' })
    await save(['mail', 'autoresponders.json'], [responder('sales@alice-shop.com'), responder('events@alice-shop.com')])
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    const hiddenDomain = services.autoreplyDomain(accountId)
    const sales = services.autoreplyAddress(accountId, 'sales@alice-shop.com'), events = services.autoreplyAddress(accountId, 'events@alice-shop.com')
    expect(file('/etc/postfix/xpanel/virtual_aliases')).toContain(`sales@alice-shop.com\tdesk@partner.example,${sales}\n`)
    expect(file('/etc/postfix/xpanel/virtual_aliases')).toContain(`events@alice-shop.com\t${events}\n`)
    expect(file('/etc/postfix/xpanel/virtual_domains')).toContain(hiddenDomain)
    // smtpd refuses the hidden users from outside; only alias expansion reaches them
    expect(file('/etc/postfix/xpanel/recipient_access')).toContain(`${hiddenDomain}\tREJECT 5.7.1 internal address\n`)
    expect(file('/etc/postfix/xpanel/recipient_access')).toContain(`${sales}\tREJECT 5.7.1 internal address\n`)
    const passwd = file(`/etc/dovecot/xpanel/domains/${hiddenDomain}.passwd`) ?? ''
    expect(passwd.split('\n').filter(line => line.includes('@'))).toHaveLength(2)
    expect(passwd.split('\n').filter(line => line.includes('@')).every(line => line.includes('nologin=y'))).toBe(true)
    const script = file(`/home/alice/mail/${hiddenDomain}/${sales.slice(0, sales.indexOf('@'))}/.dovecot.sieve`) ?? ''
    expect(script).toContain('vacation :days 1 :subject "Thanks for writing" :from "sales@alice-shop.com" :addresses ["sales@alice-shop.com"]')
    expect(script.trimEnd().endsWith('discard;')).toBe(true)
  })
})
