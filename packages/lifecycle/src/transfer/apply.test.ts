import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { OsProfile, ServiceRole } from '@xpanel/core'
import { aptProfile, dnfProfile, parseOsRelease } from '@xpanel/os'
import { assertNoSharedRestart, buildApplyPlan, sharedUnits, transferReloadUnits } from './apply.ts'
import type { TransferStep } from './apply.ts'
import { buildReview, createTransferSession, reviewDigest, transition } from './session.ts'
import type { SourceAccount, TransferSession } from './session.ts'

const T0 = '2026-10-22T01:35:00.000Z'
const ubuntu: OsProfile = aptProfile(parseOsRelease('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n'))
const centos: OsProfile = dnfProfile(parseOsRelease('ID="centos"\nVERSION_ID="9"\nPLATFORM_ID="platform:el9"\n'))
const FULL: ServiceRole[] = ['nginx', 'apache', 'openlitespeed', 'mariadb', 'postfix', 'dovecot', 'powerdns', 'nftables', 'sshd']
const WEB_ONLY: ServiceRole[] = ['nginx', 'apache', 'mariadb', 'nftables', 'sshd']

const alice: SourceAccount = { username: 'alice', uid: 1001, primaryDomain: 'alice.example', domains: ['alice.example', 'shop.example'], plan: 'gold', diskBytes: 5_000, databases: ['alice_wp'], mailboxes: 1, phpVersions: ['8.3'] }
const bob: SourceAccount = { username: 'bob', uid: 1002, primaryDomain: 'bob.example', domains: ['bob.example'], plan: 'silver', diskBytes: 1_000, databases: [], mailboxes: 0, phpVersions: ['8.2'] }

const confirmed = (): TransferSession => {
  let s = createTransferSession({ id: 'tr-9', actor: 'root:root', now: T0, auth: { kind: 'api-token', url: 'https://old.example.net:2087', tokenId: 'tok-1', tlsFingerprint: null } })
  for (const e of [
    { type: 'connected', source: { hostname: 'old.example.net', version: '1.4.2' } },
    { type: 'inventory', accounts: [alice, bob], plans: [{ name: 'gold' }, { name: 'silver' }] },
    { type: 'select', accounts: ['alice', 'bob'], plans: ['silver'], local: { usernames: [], domains: ['shop.example'], uids: [], plans: ['gold'] } },
    { type: 'resolve', conflictId: 'domain:alice:shop.example', resolution: { action: 'drop-domain' } },
    { type: 'review' },
  ] as const) s = transition(s, e as never, T0)
  return transition(s, { type: 'confirm', digest: s.reviewDigest as string }, T0)
}

describe('buildApplyPlan', () => {
  it('fetches, imports and reconciles each account, and only ever reloads shared services', () => {
    const steps = buildApplyPlan(confirmed(), { os: ubuntu, engine: 'apache', services: FULL })
    expect(steps.map((s) => s.kind)).toEqual([
      'ensure-dir', 'create-plan',
      'transfer-fetch', 'import-archive', 'reconcile', 'systemd', 'systemd', 'systemd', 'systemd', 'systemd', 'remove-path',
      'transfer-fetch', 'import-archive', 'reconcile', 'systemd', 'systemd', 'systemd', 'systemd', 'systemd', 'remove-path',
      'remove-path',
    ])
    const systemd = steps.flatMap((s) => (s.kind === 'systemd' ? [`${s.verb} ${s.unit}`] : []))
    expect(new Set(systemd)).toEqual(new Set(['reload nginx', 'reload apache2', 'reload postfix', 'reload dovecot', 'reload pdns']))
    expect(steps.every((s) => s.kind !== 'reconcile' || s.sharedUnits === 'reload-only')).toBe(true)
    expect(steps).toContainEqual({ kind: 'import-archive', sessionId: 'tr-9', path: '/var/lib/xpanel/transfers/tr-9/alice.tar.gz', sourceUsername: 'alice', targetUsername: 'alice', plan: 'gold', dropDomains: ['shop.example'] })
    expect(steps).toContainEqual({ kind: 'create-plan', sessionId: 'tr-9', source: 'silver', target: 'silver' })
    expect(steps[0]).toEqual({ kind: 'ensure-dir', path: '/var/lib/xpanel/transfers/tr-9', mode: 0o700, owner: 'root', group: 'root' })
  })

  it('takes unit names from the OS profile and the engine', () => {
    const steps = buildApplyPlan(confirmed(), { os: centos, engine: 'openlitespeed', services: FULL })
    const units = new Set(steps.flatMap((s) => (s.kind === 'systemd' ? [s.unit] : [])))
    expect(units).toEqual(new Set(transferReloadUnits(centos, 'openlitespeed', FULL)))
    expect(units.has(centos.services.openlitespeed)).toBe(true)
    expect(units.has(centos.services.apache)).toBe(false)
    expect(transferReloadUnits(centos, 'apache', FULL)).toContain('httpd')
  })

  it('reloads mail and DNS only where they are installed (both are opt-in)', () => {
    expect(transferReloadUnits(ubuntu, 'apache', WEB_ONLY)).toEqual(['nginx', 'apache2'])
    expect(transferReloadUnits(ubuntu, 'apache', [...WEB_ONLY, 'powerdns'])).toEqual(['nginx', 'apache2', 'pdns'])
    const steps = buildApplyPlan(confirmed(), { os: ubuntu, engine: 'apache', services: WEB_ONLY })
    expect(new Set(steps.flatMap((s) => (s.kind === 'systemd' ? [`${s.verb} ${s.unit}`] : [])))).toEqual(new Set(['reload nginx', 'reload apache2']))
    expect(() => transferReloadUnits(ubuntu, 'openlitespeed', WEB_ONLY)).toThrow(/openlitespeed is not installed/)
    expect(() => transferReloadUnits(ubuntu, 'apache', ['apache'])).toThrow(/nginx is not installed/)
  })

  it('refuses unconfirmed or changed sessions and unsafe staging', () => {
    const s = confirmed()
    const tampered = structuredClone(s)
    tampered.resolutions['domain:alice:shop.example'] = { action: 'skip' }
    expect(() => buildApplyPlan(tampered, { os: ubuntu, engine: 'apache', services: FULL })).toThrow(/changed since review/)
    // a stored session edited behind the reducer's back, digest recomputed to match
    const forged = structuredClone(s)
    forged.local = { ...(forged.local as NonNullable<typeof forged.local>), usernames: ['bob'] }
    forged.reviewDigest = reviewDigest(buildReview(forged))
    expect(() => buildApplyPlan(forged, { os: ubuntu, engine: 'apache', services: FULL })).toThrow(/account bob already exists here/)
    const fresh = createTransferSession({ id: 'tr-1', actor: 'root:root', now: T0, auth: { kind: 'api-token', url: 'https://h.example', tokenId: 't', tlsFingerprint: null } })
    expect(() => buildApplyPlan(fresh, { os: ubuntu, engine: 'apache', services: FULL })).toThrow(/review and confirm first/)
    expect(() => buildApplyPlan(s, { os: ubuntu, engine: 'apache', services: FULL, stagingRoot: '/home/alice/x' })).toThrow(XpanelError)
    expect(() => buildApplyPlan(s, { os: ubuntu, engine: 'apache', services: FULL, stagingRoot: '/home2/x' })).toThrow(XpanelError)
    expect(() => buildApplyPlan(s, { os: ubuntu, engine: 'apache', services: FULL, stagingRoot: 'relative' })).toThrow(XpanelError)
    expect(() => buildApplyPlan(s, { os: ubuntu, engine: 'iis' as never, services: FULL })).toThrow(XpanelError)
  })
})

describe('assertNoSharedRestart', () => {
  const shared = sharedUnits(ubuntu)

  it('lists every shared unit of the profile', () => {
    expect(shared).toEqual(expect.arrayContaining(['nginx', 'apache2', 'mariadb', 'postfix', 'dovecot', 'pdns', 'redis-server', 'ssh', 'nftables']))
  })

  it('refuses any restart, stop or disable of a shared service, in any form', () => {
    const bad: TransferStep[] = [
      { kind: 'systemd', verb: 'restart', unit: 'nginx' },
      { kind: 'systemd', verb: 'stop', unit: 'mariadb' },
      { kind: 'systemd', verb: 'disable', unit: 'postfix' },
      { kind: 'systemd', verb: 'start', unit: 'apache2' },
      { kind: 'systemd', verb: 'restart', unit: 'xpanel-php-fpm-alice-8.3.service' },
      { kind: 'exec', argv: ['/usr/bin/systemctl', 'restart', 'nginx'] },
      { kind: 'exec', argv: ['/usr/bin/systemctl', 'try-reload-or-restart', 'apache2'] },
      { kind: 'exec-io', argv: ['/usr/sbin/service', 'mariadb', 'stop'] },
      { kind: 'exec', argv: ['/usr/sbin/apachectl', 'graceful-stop'] },
      { kind: 'exec', argv: ['/usr/sbin/nginx', '-s', 'quit'] },
      { kind: 'reconcile', reason: 'x', sharedUnits: 'full' as never },
    ]
    for (const s of bad) expect(() => assertNoSharedRestart([s], shared), JSON.stringify(s)).toThrow(XpanelError)
  })

  it('allows reloads and starting a new account unit', () => {
    expect(() => assertNoSharedRestart([
      { kind: 'systemd', verb: 'reload', unit: 'nginx' },
      { kind: 'systemd', verb: 'start', unit: 'xpanel-php-fpm-alice-8.3.service' },
      { kind: 'systemd', verb: 'enable', unit: 'xpanel-php-fpm-alice-8.3.service' },
      { kind: 'exec', argv: ['/usr/sbin/nginx', '-s', 'reload'] },
      { kind: 'exec', argv: ['/usr/bin/systemctl', 'reload', 'apache2'] },
      { kind: 'reconcile', reason: 'x', sharedUnits: 'reload-only' },
    ], shared)).not.toThrow()
  })
})
