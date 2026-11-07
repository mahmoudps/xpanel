import { describe, expect, it } from 'vitest'
import type { Account, Certificate, Domain } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { services, system } from '@xpanel/render'
import { compileAccountDav, davPrincipals, davUnitNames, davZoneAdditions, readDavIngress, webDiskLogins } from './account-dav.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '44444444-4444-4444-8444-444444444444'
const account = { id: ACCOUNT_ID, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', status: 'active' } as Account
const cert = { id: '55555555-5555-4555-8555-555555555555', accountId: ACCOUNT_ID, names: ['alice-shop.com'] } as Certificate
const domain = { id: '22222222-2222-4222-8222-222222222222', accountId: ACCOUNT_ID, name: 'alice-shop.com', kind: 'primary', suspended: false, certificateId: cert.id } as Domain
const users = [
  { id: USER_ID, services: { email: true, webdisk: true }, ftpDir: 'public_html/docs', webdiskReadOnly: true },
  { id: '66666666-6666-4666-8666-666666666666', services: { email: true, webdisk: false }, ftpDir: 'public_html' },
]
const input = { account, domains: [domain], users, certs: [cert], os, ingress: { panelHost: 'server.example.com:2083' }, disabled: [] }

describe('compileAccountDav', () => {
  it('renders the main login, each Web Disk user, one Radicale and the edge for an active account', () => {
    const r = compileAccountDav(input)
    const main = system.webDiskInstance({ subject: 'main', dir: '', readOnly: false })
    const docs = system.webDiskInstance({ subject: USER_ID, dir: 'public_html/docs', readOnly: true })
    const paths = r.files.map(f => f.path)
    expect(paths).toContain(`/etc/systemd/system/xpanel-webdiskd-alice-${main}.service`)
    expect(paths).toContain(`/etc/systemd/system/xpanel-webdiskd-alice-${docs}.service`)
    expect(paths.filter(p => p.startsWith('/etc/systemd/system/xpanel-webdiskd-') && p.endsWith('.service'))).toHaveLength(2)
    expect(paths).toContain('/etc/systemd/system/xpanel-caldav-alice.socket')
    expect(paths).toContain(system.DAV_LAUNCHER_PATH)
    expect(paths).toContain('/etc/nginx/conf.d/xpanel-dav-alice.conf')
    expect(paths).toContain('/etc/nginx/conf.d/xpanel-dav.conf')
    const started = r.postActions.flatMap(a => a.kind === 'systemd' && a.verb === 'start' ? [a.unit] : [])
    expect(started).toEqual([
      'xpanel-caldav-alice.socket',
      `xpanel-webdiskd-alice-${main}.socket`, `xpanel-webdisk-alice-${main}.socket`,
      `xpanel-webdiskd-alice-${docs}.socket`, `xpanel-webdisk-alice-${docs}.socket`,
    ])
    expect(new Set(r.units)).toEqual(new Set(davUnitNames(account, users)))
    expect(r.files.find(f => f.path.endsWith(`webdisk-${docs}.conf`))!.content).toContain('webdav.is-readonly = "enable"')
  })

  it('keeps the calendar store but no edge without the management ingress or a covering certificate', () => {
    for (const changed of [{ ingress: null }, { certs: [] }]) {
      const r = compileAccountDav({ ...input, ...changed })
      expect(r.units).toEqual(['xpanel-caldav-alice.socket', 'xpanel-caldav-alice.service'])
      expect(r.files.some(f => f.path.includes('xpanel-dav'))).toBe(false)
    }
  })

  it('runs no server for a suspended account and nothing at all for a terminating one, whose home goes with it', () => {
    const suspended = compileAccountDav({ ...input, account: { ...account, status: 'suspended' } as Account })
    expect(suspended.units).toEqual([])
    expect(suspended.postActions).toEqual([system.calDavPruneAction(account, davPrincipals(users))])
    expect(compileAccountDav({ ...input, account: { ...account, status: 'terminating' } as Account })).toEqual({ files: [], preActions: [], postActions: [], units: [], calDavNames: [] })
  })

  it('deletes the collections of every mailbox that is gone, as the account', () => {
    const prune = (list: typeof users) => compileAccountDav({ ...input, users: list }).postActions.find(a => a.kind === 'exec')
    expect(prune(users)).toEqual({ kind: 'exec', runAsUser: 'alice', argv: ['/usr/bin/python3', '-I', '-S', system.DAV_LAUNCHER_PATH, '--prune', '/home/alice/.caldav', 'main', USER_ID, '66666666-6666-4666-8666-666666666666'] })
    // mailbox deleted, or removed with its domain: the state no longer lists it
    expect(prune([users[0]!])).toMatchObject({ argv: expect.not.arrayContaining(['66666666-6666-4666-8666-666666666666']) })
    // the mailbox service turned off on a login that stays for Web Disk
    expect(prune([{ ...users[0]!, services: { email: false, webdisk: true } }])).toMatchObject({ argv: expect.not.arrayContaining([USER_ID]) })
  })

  it('leaves out the service its plan disables', () => {
    const noDisk = compileAccountDav({ ...input, disabled: ['web-disk'] })
    expect(noDisk.files.some(f => f.path.includes('webdisk'))).toBe(false)
    expect(noDisk.files.find(f => f.path.endsWith('xpanel-dav-alice.conf'))!.content).not.toContain('2078')
    const noCal = compileAccountDav({ ...input, disabled: ['Calendars and Contacts'] })
    expect(noCal.files.find(f => f.path.endsWith('xpanel-dav-alice.conf'))!.content).not.toContain('2080')
    expect(noCal.units).toContain('xpanel-caldav-alice.service')
  })
})

describe('device discovery', () => {
  it('creates the directories of the Web Disk users as the account, once each', () => {
    const made = compileAccountDav({ ...input, users: [...users, { ...users[0]!, id: '77777777-7777-4777-8777-777777777777' }] }).postActions.filter(action => action.kind === 'exec' && action.argv.includes('--webdisk-dirs'))
    expect(made).toEqual([system.webDiskDirsAction(account, ['public_html/docs'])])
    expect(compileAccountDav({ ...input, disabled: ['web-disk'] }).postActions.some(action => action.kind === 'exec' && action.argv.includes('--webdisk-dirs'))).toBe(false)
  })

  it('advertises only what this generation serves on the calendar port', () => {
    expect(compileAccountDav(input).calDavNames).toEqual(['alice-shop.com'])
    for (const changed of [{ ingress: null }, { certs: [] }, { disabled: ['calendars-contacts-config'] }, { account: { ...account, status: 'suspended' } as Account }]) expect(compileAccountDav({ ...input, ...changed }).calDavNames).toEqual([])
  })

  it('publishes SRV and path records beside the zone and keeps a service the zone already has', () => {
    const added = davZoneAdditions('alice.test', [], ['alice.test', 'blog.alice.test', 'other.test'])
    expect(added.map(record => [record.name, record.type, record.priority, record.content])).toEqual([
      ['_caldavs._tcp', 'SRV', 0, '0 2080 alice.test.'], ['_caldavs._tcp', 'TXT', null, 'path=/'], ['_carddavs._tcp', 'SRV', 0, '0 2080 alice.test.'], ['_carddavs._tcp', 'TXT', null, 'path=/'],
      ['_caldavs._tcp.blog', 'SRV', 0, '0 2080 blog.alice.test.'], ['_caldavs._tcp.blog', 'TXT', null, 'path=/'], ['_carddavs._tcp.blog', 'SRV', 0, '0 2080 blog.alice.test.'], ['_carddavs._tcp.blog', 'TXT', null, 'path=/'],
    ])
    expect(davZoneAdditions('alice.test', [{ name: '_caldavs._tcp.alice.test.', type: 'SRV' }], ['alice.test']).map(record => record.name)).toEqual(['_carddavs._tcp', '_carddavs._tcp'])
    expect(davZoneAdditions('alice.test', [], [])).toEqual([])
    expect(services.renderBindZone(added)).toContain('_caldavs._tcp\t3600\tIN\tSRV\t0 0 2080 alice.test.')
  })
})

describe('webDiskLogins', () => {
  it('lists the main login first and only users with Web Disk', () => {
    expect(webDiskLogins(users)).toEqual([{ subject: 'main', dir: '', readOnly: false }, { subject: USER_ID, dir: 'public_html/docs', readOnly: true }])
  })
})

describe('readDavIngress', () => {
  const executor = (text: string | null) => ({ readFile: async () => text })
  it('takes the host of an exact HTTPS panel origin', async () => {
    expect(await readDavIngress(executor('XPANEL_PANEL_PUBLIC_ORIGIN=https://server.example.com:2083\n'))).toEqual({ panelHost: 'server.example.com:2083' })
  })
  it('is absent before management TLS and for anything but an exact HTTPS origin', async () => {
    for (const text of [null, '', 'XPANEL_PANEL_PUBLIC_ORIGIN=http://server.example.com:2083\n', 'XPANEL_PANEL_PUBLIC_ORIGIN=https://server.example.com:2083/x\n']) {
      expect(await readDavIngress(executor(text))).toBeNull()
    }
  })
})
