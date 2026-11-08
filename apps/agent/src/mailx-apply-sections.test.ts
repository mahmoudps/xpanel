import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { MAILX_DEFAULTS, mailxCompositeRevision } from './mailx-policy.ts'
import { handleMailxRoute, readMailxSaved } from './mailx-routes.ts'
import type { MailxCommandResult, MailxHostFiles, MailxRouteContext } from './mailx-routes.ts'
import type { MailxGeoipPort } from './mail-country-filter.ts'
import type { MailxSnapshot } from './mailfx-render.ts'

const ok = (stdout = ''): MailxCommandResult => ({ ok: true, code: 0, stdout, stderr: '' })
const failed: MailxCommandResult = { ok: false, code: 1, stdout: '', stderr: 'x' }
const at = { updatedAt: '2026-11-07T10:00:00.000Z', updatedBy: 'root' }
const snapshot: MailxSnapshot = { accounts: [], domains: [], serviceUsers: [], plans: [], featureLists: [] }
let root = ''
const save = async (name: string, value: unknown) => { const path = join(root, 'extended', 'mailx', name + '.json'); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)) }

function host(options: { engine?: 'rspamd' | 'spamd.service' | null; defaults?: string; restrictions?: string; failCheck?: boolean } = {}) {
  const main = new Map<string, string>([['myhostname', 'mail.example']]), disk = new Map<string, string>(), calls: string[][] = []
  if (options.restrictions) main.set('smtpd_client_restrictions', options.restrictions)
  const run = async (argv: string[]): Promise<MailxCommandResult> => {
    calls.push(argv)
    const command = argv.join(' ')
    if (command === '/usr/sbin/postconf -n') return ok([...main].map(([key, value]) => value ? `${key} = ${value}` : `${key} =`).join('\n') + '\n')
    if (command === '/usr/sbin/postconf -d') return ok(options.defaults ?? 'smtp_connect_timeout = 30s\nmyhostname = x\n')
    if (argv[1] === '-e') { for (const pair of argv.slice(2)) main.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)); return ok() }
    if (argv[1] === '-X') { for (const key of argv.slice(2)) main.delete(key); return ok() }
    if (command === '/usr/sbin/postfix check') return options.failCheck && main.has('smtp_connect_timeout') ? failed : ok()
    if (argv[1] === 'show') { const unit = options.engine === 'rspamd' ? 'rspamd.service' : options.engine; return ok(argv[5] === unit ? 'LoadState=loaded\nActiveState=active\n' : 'LoadState=not-found\nActiveState=inactive\n') }
    return ok()
  }
  const files: MailxHostFiles = { read: async path => disk.get(path) ?? null, write: async file => { disk.set(file.path, file.content) }, remove: async path => { disk.delete(path) }, ensureMapDir: async () => {} }
  return { run, files, main, disk, calls }
}
const context = (h: ReturnType<typeof host>, geoip: MailxGeoipPort | null = null): MailxRouteContext => ({ assertRoot: async () => ({ actor: 'root' }), assertAccount: async () => ({ actor: 'a', accountId: 'a' }), stateRoot: root, run: h.run, files: h.files, readSnapshot: async () => snapshot, submitJob: null, geoip, now: () => new Date('2026-11-07T10:00:00.000Z') })
const apply = async (h: ReturnType<typeof host>, extra: Record<string, unknown> = {}, geoip: MailxGeoipPort | null = null) => {
  const body = { revision: mailxCompositeRevision(await readMailxSaved(root)), ...extra }, url = 'http://agent/host/mailx/apply'
  return (await handleMailxRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), new URL(url), 'POST', context(h, geoip)))!.json()
}
const code = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => isXpanelError(error) ? error.detail?.reason ?? error.code : error)
const geoip: MailxGeoipPort = { status: async () => ({ installed: true, month: '2026-11' }), read: async () => { const db = Buffer.alloc(12); db.writeUIntBE(2, 0, 3); db.writeUIntBE(1, 3, 3); db.writeUIntBE(18, 6, 3); db.writeUIntBE(34, 9, 3); return db },
  metadata: () => ({ ipVersion: 4, recordSize: 24, nodeCount: 2 }), lookup: (_db, ip) => Number(ip.split('.')[0]) >= 192 ? 'BB' : 'AA' }

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mailx-sections-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('advanced options', () => {
  it('sets a known parameter and removes a released one', async () => {
    const h = host()
    h.main.set('smtp_helo_timeout', '60s')
    await save('advanced', { section: 'advanced', policy: { postfix: { smtp_connect_timeout: '10s' } }, ...at })
    expect(await apply(h, { unset: ['smtp_helo_timeout'] })).toMatchObject({ outcome: 'applied' })
    expect(h.main.get('smtp_connect_timeout')).toBe('10s')
    expect(h.main.has('smtp_helo_timeout')).toBe(false)
  })
  it('refuses a parameter this Postfix does not know before anything changes', async () => {
    const h = host({ defaults: 'myhostname = x\n' })
    await save('advanced', { section: 'advanced', policy: { postfix: { smtp_connect_timeout: '10s' } }, ...at })
    expect(await code(apply(h))).toBe('unknown_postfix_parameter')
    expect(h.main.has('smtp_connect_timeout')).toBe(false)
  })
  it('restores the previous values when postfix check fails', async () => {
    const h = host({ failCheck: true })
    h.main.set('smtp_helo_timeout', '60s')
    await save('advanced', { section: 'advanced', policy: { postfix: { smtp_connect_timeout: '10s' } }, ...at })
    expect(await apply(h, { unset: ['smtp_helo_timeout'] })).toMatchObject({ outcome: 'rolled-back', failedCheck: 'postfix' })
    expect(h.main.has('smtp_connect_timeout')).toBe(false)
    expect(h.main.get('smtp_helo_timeout')).toBe('60s')
  })
  it('refuses to release a privileged or reconciler key', async () => {
    const h = host()
    for (const key of ['mailbox_command', 'smtpd_milters']) expect(await code(apply(h, { unset: [key] }))).toBe('VALIDATION')
  })
})

describe('spam filter startup', () => {
  const spamd = { section: 'spamd', policy: { ...MAILX_DEFAULTS.spamd, children: 2 }, ...at }
  it('writes the drop-in, reloads systemd and restarts SpamAssassin', async () => {
    const h = host({ engine: 'spamd.service' })
    await save('spamd', spamd)
    await apply(h)
    expect(h.disk.get('/etc/systemd/system/spamd.service.d/xpanel-startup.env')).toContain('--max-children=2')
    const commands = h.calls.map(argv => argv.join(' '))
    expect(commands.indexOf('/usr/bin/systemctl daemon-reload')).toBeLessThan(commands.indexOf('/usr/bin/systemctl try-restart -- spamd.service'))
    expect(commands).toContain('/usr/bin/systemctl try-restart -- spamd.service')
  })
  it('restarts rspamd without a unit reload', async () => {
    const h = host({ engine: 'rspamd' })
    await save('spamd', spamd)
    await apply(h)
    expect(h.disk.get('/etc/rspamd/local.d/worker-normal.inc')).toContain('count = 2;')
    expect(h.calls.map(argv => argv.join(' '))).toContain('/usr/bin/systemctl try-restart -- rspamd.service')
  })
  it('does not restart when the files already match', async () => {
    const h = host({ engine: 'rspamd' })
    await save('spamd', spamd)
    await apply(h); h.calls.length = 0
    await apply(h)
    expect(h.calls.map(argv => argv.join(' '))).not.toContain('/usr/bin/systemctl try-restart -- rspamd.service')
  })
})

describe('country filter', () => {
  const country = { section: 'country', policy: { blocked: ['BB'] }, ...at }
  it('renders the table and the restriction, and reports the section applied', async () => {
    const h = host()
    await save('country', country)
    expect(await apply(h, {}, geoip)).toMatchObject({ outcome: 'applied' })
    expect(h.disk.get('/etc/postfix/xpanel/mailx/country_block')).toContain('192.0.0.0/2 REJECT')
    expect(h.main.get('smtpd_client_restrictions')).toContain('check_client_access cidr:/etc/postfix/xpanel/mailx/country_block')
    const url = 'http://agent/host/mailx/state', state = await (await handleMailxRoute(new Request(url), new URL(url), 'GET', context(h, geoip)))!.json() as { sections: Record<string, string>; geoip: unknown }
    expect(state.sections.country).toBe('applied')
    expect(state.geoip).toEqual({ installed: true, month: '2026-11' })
  })
  it('refuses with a stable reason while no database is connected', async () => {
    const h = host()
    await save('country', country)
    expect(await code(apply(h))).toBe('geoip_unavailable')
    expect(h.main.has('smtpd_client_restrictions')).toBe(false)
  })
  it('never replaces client restrictions it does not manage', async () => {
    const h = host({ restrictions: 'permit_mynetworks, check_client_access hash:/etc/postfix/mine' })
    await save('country', country)
    expect(await code(apply(h, {}, geoip))).toBe('unmanaged_client_restrictions')
  })
})

describe('greylisting and score header', () => {
  it('writes the domain rule into the rspamd settings and reports it to the owner', async () => {
    const h = host({ engine: 'rspamd' })
    await save('greylist', { section: 'greylist', policy: { domains: ['on.test'] }, ...at })
    await apply(h)
    expect(h.disk.get('/etc/rspamd/local.d/settings.conf')).toContain('rcpt = "@on.test";')
  })
  it('leaves the file alone without rspamd', async () => {
    const h = host()
    await save('greylist', { section: 'greylist', policy: { domains: ['on.test'] }, ...at })
    await apply(h)
    expect(h.disk.has('/etc/rspamd/local.d/settings.conf')).toBe(false)
  })
})
