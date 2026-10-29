import { describe, expect, it, vi } from 'vitest'
import type { HostJobView } from './host-job-contract.ts'
import { isSupportRedacted } from './support-bundle-redaction.ts'
import { buildSupportBundle, handleSupportRoute, readPanelRelease, readSupportSummary, SUPPORT_BUNDLE_MANIFEST, SUPPORT_BUNDLE_SECTIONS, SUPPORT_LIMITS } from './support-bundle.ts'
import type { SupportRouteContext } from './support-bundle.ts'
import type { UpgradeHostFs } from './upgrade-observation.ts'

const now = () => new Date('2026-10-27T10:00:00.000Z')
const SPACE = 'Filesystem     Type     1-blocks        Used   Available Capacity Mounted on\n/dev/vda1      ext4  52521566208 20971520000 29393936384      42% /\n198.51.100.9:/export nfs4 1000 10 990 1% /mnt/share\n'
const INODES = 'Filesystem      Inodes  IUsed   IFree IUse% Mounted on\n/dev/vda1      3276800 250000 3026800    8% /\n198.51.100.9:/export 0 0 0 - /mnt/share\n'
const FILES: Record<string, string> = {
  '/proc/uptime': '93784.52 180000.00\n',
  '/proc/meminfo': 'MemTotal:        2048000 kB\nMemFree:          100000 kB\nMemAvailable:    1024000 kB\nSwapTotal:        512000 kB\nSwapFree:         256000 kB\n',
  '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n',
}
const journalLine = (message: string, index: number) => JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.UTC(2026, 9, 27, 9, 0, index) * 1000), PRIORITY: '6', _SYSTEMD_UNIT: 'xpanel-agent.service', _PID: '41', MESSAGE: message })
const SECRET_LINES = [
  'request from 203.0.113.5 user owner@example.test',
  'Authorization: Bearer abcdefghijklmnop',
  'Cookie: xpanel_session=abcdef0123456789',
  'agentToken=zzzzzzzzzzzz loaded',
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
  'peer 2001:db8::5 closed',
]
const releaseFs = (link: string | null = '/opt/xpanel/releases/1.4.2', marker = '1.4.2\n'): UpgradeHostFs => ({
  readlink: vi.fn(async (path: string) => path === '/opt/xpanel/current' ? link : null),
  read: vi.fn(async (path: string) => { if (path !== link + '/VERSION') throw new Error('ENOENT'); return { facts: { kind: 'file' as const, uid: 0, mode: 0o644, size: marker.length, nlink: 1, dev: 1, ino: 1, mtimeMs: 0, ctimeMs: 0 }, bytes: Buffer.from(marker) } }),
  lstat: vi.fn(async () => null), sha256: vi.fn(async () => { throw new Error('unused') }), list: vi.fn(async () => null), freeBytes: vi.fn(async () => 0),
})
const job = (id: string, status: HostJobView['status'], error: string | null): HostJobView => ({
  id, referenceCode: 'XP-JOB-2026-000123', kind: 'system-updates.apply', status, progress: 100, summary: 'Update packages for owner@example.test', accountId: 'acct-1', actor: 'root', createdAt: '2026-10-27T08:00:00.000Z',
  startedAt: '2026-10-27T08:00:01.000Z', finishedAt: '2026-10-27T08:01:00.000Z', steps: [{ id: 'apt-upgrade', title: 'Upgrade', state: 'failed', exitCode: 100 }],
  error, failureClass: 'permanent', cancelRequested: false, verification: null, logBytes: 10,
})

function context(overrides: Partial<SupportRouteContext> = {}, journal: (unit: string) => string = () => SECRET_LINES.map(journalLine).join('\n') + '\n') {
  const events: string[] = []
  const run = vi.fn(async (argv: string[]) => {
    const command = argv.join(' ')
    if (argv[0] === '/usr/bin/systemctl') { const unit = argv.at(-1)!; return { ok: true, stdout: ['nginx.service', 'xpanel-agent.service', 'xpanel-api.service'].includes(unit) ? 'loaded\nactive\n' : unit === 'postfix.service' ? 'loaded\nfailed\n' : 'not-found\ninactive\n', stderr: '' } }
    if (command === '/usr/bin/df -B1 -P -T') return { ok: true, stdout: SPACE, stderr: '' }
    if (command === '/usr/bin/df -i -P') return { ok: true, stdout: INODES, stderr: '' }
    if (argv[0] === '/usr/bin/journalctl') { events.push('journal:' + argv[argv.indexOf('-u') + 1] + ':' + argv[argv.indexOf('-n') + 1]); return { ok: true, stdout: journal(argv[argv.indexOf('-u') + 1]!), stderr: '' } }
    events.push('unexpected:' + command)
    return { ok: false, stdout: '', stderr: '' }
  })
  const readFile = vi.fn(async (path: string) => { events.push('read:' + path); return FILES[path] ?? null })
  const listFailedJobs = vi.fn(async (limit: number) => { events.push('jobs:' + limit); return [job('11111111-1111-4111-8111-111111111111', 'failed', 'step apt-upgrade exited 100 from 192.0.2.44')] })
  const ctx: SupportRouteContext = {
    assertRoot: vi.fn(async (action: string) => { events.push('root:' + action); return { actor: 'root' } }),
    host: { run, readFile, releaseFs: releaseFs() },
    os: { id: 'ubuntu', versionId: '24.04', family: 'debian' },
    latestGeneration: vi.fn(async () => ({ id: 7, createdAt: '2026-10-27T07:00:00.000Z', status: 'active' as const, checksum: 'a'.repeat(64), error: null, actor: 'root', testedAt: '2026-10-27T07:00:01.000Z', activatedAt: '2026-10-27T07:00:02.000Z' })),
    readDrift: vi.fn(async () => ({ hasDrift: true, manifestMissing: false, generationId: 7, items: [{ path: '/etc/nginx/sites/alpha.example.test.conf', reason: 'content_mismatch' }, { path: '/etc/x', reason: 'missing' }, { path: '/etc/y', reason: 'missing' }] })),
    listFailedJobs, now, redactionKey: new Uint8Array(32).fill(3),
    ...overrides,
  }
  return { ctx, events, run, readFile }
}

describe('support summary', () => {
  it('reports observed release, OS profile, uptime, services, generation, drift and failed jobs', async () => {
    const { ctx, events } = context()
    const summary = await readSupportSummary(ctx)
    expect(summary).toMatchObject({
      observedAt: '2026-10-27T10:00:00.000Z', host: 'read',
      versions: { panel: { state: 'read', version: '1.4.2', releasePath: '/opt/xpanel/releases/1.4.2' }, node: process.version },
      os: { profile: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, release: { state: 'read', prettyName: 'Ubuntu 24.04.1 LTS', versionId: '24.04' } },
      uptime: { state: 'read', seconds: 93784 },
      generation: { state: 'read', id: 7, checksum: 'a'.repeat(64), activatedAt: '2026-10-27T07:00:02.000Z' },
      drift: { state: 'read', generationId: 7, count: 3, byReason: { content_mismatch: 1, missing: 2 } },
      failedJobs: { state: 'read', items: [{ id: '11111111-1111-4111-8111-111111111111', referenceCode: 'XP-JOB-2026-000123', failureClass: 'permanent', steps: [{ id: 'apt-upgrade', state: 'failed', exitCode: 100 }] }] },
    })
    expect(summary.services.items.find(row => row.id === 'postfix')).toMatchObject({ state: 'failed', unit: 'postfix.service' })
    expect(summary.services.items.find(row => row.id === 'nginx')).toMatchObject({ state: 'active' })
    expect(JSON.stringify(summary)).not.toMatch(/actor|summary"|acct-1|alpha\.example/)
    expect(events).toContain('jobs:10')
    expect(events.some(event => event.startsWith('journal:'))).toBe(false)
  })

  it('keeps every observation unavailable without a native host and never invents a version', async () => {
    const summary = await readSupportSummary(context({ host: null, readDrift: null, listFailedJobs: null }).ctx)
    expect(summary).toMatchObject({ host: 'unavailable', versions: { panel: { state: 'unavailable', version: null } }, os: { release: { state: 'unavailable' } }, uptime: { state: 'unavailable' },
      services: { state: 'unavailable', items: [] }, drift: { state: 'unavailable' }, failedJobs: { state: 'unavailable', items: [] }, generation: { state: 'read' } })
    const failing = await readSupportSummary(context({ latestGeneration: vi.fn(async () => { throw new Error('db') }) }).ctx)
    expect(failing.generation.state).toBe('unavailable')
    expect((await readSupportSummary(context({ latestGeneration: vi.fn(async () => null) }).ctx)).generation.state).toBe('none')
  })

  it('reads the release only through a current link into releases/<version> with an agreeing VERSION marker', async () => {
    expect(await readPanelRelease(releaseFs())).toEqual({ state: 'read', version: '1.4.2', releasePath: '/opt/xpanel/releases/1.4.2' })
    for (const fs of [releaseFs(null), releaseFs('/tmp/1.4.2'), releaseFs('/opt/xpanel/releases/latest'), releaseFs('/opt/xpanel/releases/1.4.2', '1.4.3\n')])
      expect(await readPanelRelease(fs)).toEqual({ state: 'unavailable', version: null, releasePath: null })
  })
})

describe('support bundle', () => {
  it('contains exactly the manifest sections and the bounded journals of the two panel units', async () => {
    const { ctx, events } = context()
    const bundle = await buildSupportBundle(ctx)
    expect(Object.keys(bundle)).toEqual(['manifest', 'generatedAt', ...SUPPORT_BUNDLE_SECTIONS.map(section => section.id)])
    expect(bundle.manifest).toBe(SUPPORT_BUNDLE_MANIFEST)
    expect(SUPPORT_BUNDLE_MANIFEST.id).toMatch(/^[0-9a-f]{16}$/)
    expect(Object.keys(bundle.journal)).toEqual(['xpanel-agent.service', 'xpanel-api.service'])
    expect(events).toEqual(expect.arrayContaining(['journal:xpanel-agent.service:500', 'journal:xpanel-api.service:500']))
    expect(bundle.journal['xpanel-agent.service']).toMatchObject({ state: 'read', truncated: false })
    expect(bundle.journal['xpanel-agent.service'].items).toHaveLength(SECRET_LINES.length)
    expect(bundle.resources.memory).toMatchObject({ state: 'read', totalBytes: 2048000 * 1024, availableBytes: 1024000 * 1024, swapTotalBytes: 512000 * 1024, swapFreeBytes: 256000 * 1024 })
    expect(bundle.resources.filesystems.items.map(fs => fs.mount)).toEqual(['/', '/mnt/share'])
    expect(bundle.drift).toEqual({ state: 'read', generationId: 7, manifestMissing: false, count: 3, byReason: { content_mismatch: 1, missing: 2 } })
    // Only fixed observers ran: no state file, database, key or account path was opened.
    expect(events.filter(event => event.startsWith('read:'))).toEqual(expect.arrayContaining(['read:/proc/meminfo', 'read:/proc/uptime', 'read:/etc/os-release']))
    expect(events.filter(event => event.startsWith('read:') && !['read:/proc/meminfo', 'read:/proc/uptime', 'read:/etc/os-release'].includes(event))).toEqual([])
    expect(events.filter(event => event.startsWith('unexpected:'))).toEqual([])
  })

  it('redacts tokens, cookies, Authorization, PEM blocks, emails and IPv4/IPv6 everywhere in the content', async () => {
    const bundle = await buildSupportBundle(context().ctx)
    const text = JSON.stringify({ ...bundle, manifest: null })
    for (const secret of ['203.0.113.5', 'owner@example.test', 'abcdefghijklmnop', 'abcdef0123456789', 'zzzzzzzzzzzz', 'MIIEvQIBADANBg', '2001:db8::5', '198.51.100.9', '192.0.2.44', 'Update packages']) expect(text).not.toContain(secret)
    expect(text).toMatch(/\[ipv4:[0-9a-f]{12}\]:\/export/)
    expect(text).toContain('[redacted:pem]')
    expect(isSupportRedacted({ ...bundle, manifest: null })).toBe(true)
    const again = await buildSupportBundle(context().ctx)
    expect(JSON.stringify(again.journal)).toBe(JSON.stringify(bundle.journal))
  })

  it('bounds each journal unit after redaction and marks it truncated', async () => {
    const long = Array.from({ length: 500 }, (_, index) => journalLine('x'.repeat(3000) + ' from 192.0.2.' + (index % 250), index)).join('\n') + '\n'
    const bundle = await buildSupportBundle(context({}, () => long).ctx)
    const unit = bundle.journal['xpanel-api.service']
    expect(unit.truncated).toBe(true)
    expect(unit.items.length).toBeGreaterThan(0)
    expect(unit.items.length).toBeLessThan(500)
    expect(Buffer.byteLength(JSON.stringify(unit.items))).toBeLessThanOrEqual(SUPPORT_LIMITS.journalBytesPerUnit)
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThanOrEqual(SUPPORT_LIMITS.bundleBytes)
  })

  it('reports a malformed journal as unavailable instead of empty success', async () => {
    const bundle = await buildSupportBundle(context({}, () => 'not json\n').ctx)
    expect(bundle.journal['xpanel-agent.service']).toEqual({ state: 'unavailable', reason: 'invalid-journal', truncated: false, items: [] })
  })
})

describe('support route', () => {
  it('authorizes root before and after the read, returns no-store JSON and leaves other paths alone', async () => {
    const { ctx, events } = context()
    expect(await handleSupportRoute(new Request('http://agent/host/supports'), new URL('http://agent/host/supports'), 'GET', ctx)).toBeNull()
    const response = (await handleSupportRoute(new Request('http://agent/host/support'), new URL('http://agent/host/support'), 'GET', ctx))!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.json() as { host: string }).host).toBe('read')
    expect(events[0]).toBe('root:server.support.read')
    expect(events.at(-1)).toBe('root:server.support.read')
  })

  it('refuses non-root callers before any host read and rejects selectors, bodies and other methods', async () => {
    const denied = context({ assertRoot: vi.fn(async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) }) })
    await expect(handleSupportRoute(new Request('http://agent/host/support/bundle'), new URL('http://agent/host/support/bundle'), 'GET', denied.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.run).not.toHaveBeenCalled()
    const { ctx, run } = context()
    expect((await handleSupportRoute(new Request('http://agent/host/support', { method: 'POST', body: '{}' }), new URL('http://agent/host/support'), 'POST', ctx))!.status).toBe(405)
    await expect(handleSupportRoute(new Request('http://agent/host/support?unit=x'), new URL('http://agent/host/support?unit=x'), 'GET', ctx)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(run).not.toHaveBeenCalled()
  })
})
