import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { stepPaths } from '../steps.ts'
import type { ExecIoStep, LifecycleStep, ManifestStep } from '../steps.ts'
import { buildTar, chunked } from '../testing/tar.ts'
import { isUnder } from '../validate.ts'
import { expandParts, parseManifest } from './manifest.ts'
import { mailConfigFor, mergeMailConfig, parseMailConfig } from './mail-config.ts'
import type { MailConfig } from './mail-config.ts'
import { computeManifest, createBackupPlan } from './plan.ts'
import type { BackupRequest } from './plan.ts'
import { inspectBackupArchive } from './restore.ts'

const NUL = String.fromCharCode(0)

const mail: MailConfig = {
  domains: [{ domain: 'alice.example', forwarders: [{ local: 'info', to: ['alice@gmail.com', 'ops+alerts@alice.example'] }], defaultAddress: { kind: 'reject' } }],
  mailboxes: [{
    address: 'info@alice.example',
    filters: [{ name: 'spam', match: 'any', tests: [{ field: 'subject', op: 'contains', value: '[SPAM]' }], actions: [{ kind: 'fileinto', folder: 'Junk' }, { kind: 'stop' }] }],
  }],
}

const req = (over: Partial<BackupRequest> = {}): BackupRequest => ({
  os: { family: 'debian' },
  account: { username: 'alice', home: '/home/alice', primaryDomain: 'alice.example', domains: ['alice.example', 'shop.example'] },
  parts: ['full'],
  destination: 'account-dir',
  databases: ['alice_wp', 'alice_shop'],
  mail,
  createdAt: '2026-10-22T01:35:00.000Z',
  ...over,
})

const WORK = '/var/lib/xpanel/backups/work/alice-20261022T013500Z'
const execIo = (steps: LifecycleStep[]): ExecIoStep[] => steps.filter((s): s is ExecIoStep => s.kind === 'exec-io')

/** Root must never act on a path inside the home; only steps run as the account may. */
const rootTouchesHome = (steps: LifecycleStep[], home: string): LifecycleStep[] =>
  steps.filter((s) => stepPaths(s).some((p) => isUnder(p, home)) && !(s.kind === 'exec-io' && s.runAsUser === 'alice'))

describe('expandParts', () => {
  it('expands full and dedupes', () => {
    expect(expandParts(['full'])).toEqual(['home', 'databases', 'mail-config'])
    expect(expandParts(['mail-config', 'home', 'home'])).toEqual(['home', 'mail-config'])
    expect(() => expandParts([])).toThrow(XpanelError)
    expect(() => expandParts(['home', 'etc' as 'home'])).toThrow(/unknown backup part/)
  })
})

describe('createBackupPlan', () => {
  it('plans a full backup into the account directory', () => {
    const p = createBackupPlan(req())
    expect(p.id).toBe('alice-20261022T013500Z')
    expect(p.parts).toEqual(['home', 'databases', 'mail-config'])
    expect(p.artifact).toBe('/home/alice/backups/xpanel-backup-alice-20261022T013500Z.tar.gz')
    expect(p.steps[0]).toEqual({ kind: 'ensure-dir', path: WORK, mode: 0o700, owner: 'root', group: 'root' })
    const io = execIo(p.steps)
    expect(io[0]).toEqual({
      kind: 'exec-io',
      argv: ['/usr/bin/tar', '--create', '--gzip', '--file=-', '--directory=/home/alice', '--exclude=./backups/xpanel-backup-*', '.'],
      runAsUser: 'alice',
      stdoutTo: { path: `${WORK}/home.tar.gz`, mode: 0o600 },
      okExitCodes: [0, 1],
    })
    const dumps = io.filter((s) => s.argv[0] === '/usr/bin/mariadb-dump')
    expect(dumps.map((d) => [d.argv.at(-1), d.runAsUser, d.stdoutTo?.path])).toEqual([
      ['alice_shop', 'alice', `${WORK}/mysql/alice_shop.sql`],
      ['alice_wp', 'alice', `${WORK}/mysql/alice_wp.sql`],
    ])
    expect(dumps[0]?.argv.slice(1, 4)).toEqual(['--no-defaults', '--user=alice', '--single-transaction'])
    const mailStep = p.steps.find((s) => s.kind === 'write-file')
    expect(mailStep?.kind === 'write-file' && JSON.parse(mailStep.file.content)).toEqual(mail)
    expect(mailStep?.kind === 'write-file' && mailStep.file).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    const pack = p.steps.find((s) => s.kind === 'exec' && s.argv[0] === '/usr/bin/tar')
    expect(pack).toEqual({ kind: 'exec', argv: ['/usr/bin/tar', '--create', '--gzip', '--file=/var/lib/xpanel/backups/work/xpanel-backup-alice-20261022T013500Z.tar.gz', `--directory=${WORK}`, '--', 'manifest.json', 'home.tar.gz', 'mysql', 'mail-config.json'] })
    const dd = io.find((s) => s.argv[0] === '/usr/bin/dd')
    expect(dd).toMatchObject({ runAsUser: 'alice', stdinFrom: '/var/lib/xpanel/backups/work/xpanel-backup-alice-20261022T013500Z.tar.gz' })
    expect(dd?.argv).toEqual(['/usr/bin/dd', 'of=/home/alice/backups/xpanel-backup-alice-20261022T013500Z.tar.gz', 'bs=1M', 'conv=excl', 'oflag=nofollow', 'status=none'])
    expect(p.steps.at(-1)).toEqual({ kind: 'remove-path', path: WORK })
    expect(rootTouchesHome(p.steps, '/home/alice')).toEqual([])
  })

  it('writes a manifest step over every staged part', () => {
    const m = createBackupPlan(req()).steps.find((s): s is ManifestStep => s.kind === 'write-manifest')
    expect(m).toMatchObject({ root: WORK, output: `${WORK}/manifest.json` })
    expect(m?.header).toEqual({ format: 'xpanel-backup', version: 1, account: { username: 'alice', primaryDomain: 'alice.example' }, parts: ['home', 'databases', 'mail-config'], created: '2026-10-22T01:35:00.000Z', databases: ['alice_shop', 'alice_wp'] })
    expect(m?.sources).toEqual([
      { part: 'home', tarGz: 'home.tar.gz' },
      { part: 'databases', file: 'mysql/alice_shop.sql' },
      { part: 'databases', file: 'mysql/alice_wp.sql' },
      { part: 'mail-config', file: 'mail-config.json' },
    ])
  })

  it('keeps downloads in a root-owned area and never touches the home from root', () => {
    const p = createBackupPlan(req({ destination: 'download' }))
    expect(p.artifact).toBe('/var/lib/xpanel/backups/downloads/alice/xpanel-backup-alice-20261022T013500Z.tar.gz')
    expect(p.steps).toContainEqual({ kind: 'ensure-dir', path: '/var/lib/xpanel/backups/downloads/alice', mode: 0o700, owner: 'root', group: 'root' })
    expect(execIo(p.steps).some((s) => s.argv[0] === '/usr/bin/dd')).toBe(false)
    expect(rootTouchesHome(p.steps, '/home/alice')).toEqual([])
  })

  it('uploads to a stored remote target by id only', () => {
    const p = createBackupPlan(req({ destination: 'remote', remote: { targetId: 'b2-offsite' } }))
    expect(p.steps).toContainEqual({ kind: 'remote-upload', from: '/var/lib/xpanel/backups/work/xpanel-backup-alice-20261022T013500Z.tar.gz', targetId: 'b2-offsite', objectKey: 'alice/xpanel-backup-alice-20261022T013500Z.tar.gz' })
    expect(p.artifact).toBe('remote:b2-offsite/alice/xpanel-backup-alice-20261022T013500Z.tar.gz')
    expect(() => createBackupPlan(req({ destination: 'remote' }))).toThrow(XpanelError)
    expect(() => createBackupPlan(req({ destination: 'remote', remote: { targetId: 'https://key:secret@host' } }))).toThrow(XpanelError)
  })

  it('a databases-only backup never mentions the home', () => {
    const p = createBackupPlan(req({ parts: ['databases'], destination: 'download' }))
    expect(p.steps.flatMap(stepPaths).filter((x) => isUnder(x, '/home/alice'))).toEqual([])
    expect(execIo(p.steps).map((s) => s.argv[0])).toEqual(['/usr/bin/mariadb-dump', '/usr/bin/mariadb-dump'])
  })

  it('a home-only or mail-only backup does only that', () => {
    expect(execIo(createBackupPlan(req({ parts: ['home'] })).steps).map((s) => s.argv[0])).toEqual(['/usr/bin/tar', '/usr/bin/mkdir', '/usr/bin/dd'])
    const m = createBackupPlan(req({ parts: ['mail-config'], destination: 'download' }))
    expect(execIo(m.steps)).toEqual([])
    expect(m.header).toMatchObject({ parts: ['mail-config'], databases: [] })
  })

  it('an account without databases still backs up the rest', () => {
    const p = createBackupPlan(req({ databases: [] }))
    expect(p.steps.some((s) => s.kind === 'ensure-dir' && s.path.endsWith('/mysql'))).toBe(false)
    const pack = p.steps.find((s) => s.kind === 'exec')
    expect(pack?.kind === 'exec' && pack.argv.slice(-3)).toEqual(['manifest.json', 'home.tar.gz', 'mail-config.json'])
  })

  it('plans the same absolute tools on the EL family', () => {
    expect(execIo(createBackupPlan(req({ os: { family: 'rhel' } })).steps).map((s) => s.argv[0])).toContain('/usr/bin/mariadb-dump')
    expect(() => createBackupPlan(req({ os: { family: 'suse' as never } }))).toThrow(/unknown os family/)
  })

  it('rejects hostile input', () => {
    const fwd = (local: string, to: string[]): MailConfig => ({ domains: [{ domain: 'alice.example', forwarders: [{ local, to }], defaultAddress: { kind: 'reject' } }], mailboxes: [] })
    const bad: Partial<BackupRequest>[] = [
      { account: { ...req().account, username: 'root', home: '/home/root' } },
      { account: { ...req().account, home: '/home/bob' } },
      { account: { ...req().account, home: '/home/../root/alice' } },
      { account: { ...req().account, home: '/etc/alice' } },
      { account: { ...req().account, primaryDomain: 'alice.example;reboot' } },
      { account: { ...req().account, primaryDomain: 'ALICE.example' } },
      { databases: ['bob_wp'] },
      { databases: ['alice_wp; DROP DATABASE mysql'] },
      { databases: ['alice_'] },
      { databases: ['alice_WP'] },
      { mail: { domains: [{ domain: 'victim.example', forwarders: [], defaultAddress: { kind: 'reject' } }], mailboxes: [] } },
      { mail: fwd('info', ['|/bin/sh -c id']) },
      { mail: fwd('info', ['/home/alice/mbox']) },
      { mail: fwd('../x', ['a@b.example']) },
      { mail: fwd('info', []) },
      { mail: { ...mail, mailboxes: [{ address: 'info@alice.example', filters: [{ name: 'x', match: 'any', tests: [{ field: 'subject', op: 'is', value: 'a' }], actions: [{ kind: 'fileinto', folder: '../../.ssh' }] }] }] } },
      { createdAt: 'yesterday' },
      { destination: 'ftp' as 'download' },
      { roots: { work: '/home/alice/tmp' } },
      { roots: { work: '/var/lib/xpanel/backups', downloads: '/var/lib/xpanel/backups/downloads' } },
    ]
    for (const b of bad) expect(() => createBackupPlan(req(b)), JSON.stringify(b)).toThrow(XpanelError)
  })
})

const buildBackup = async (opts: { tamperHome?: boolean; extra?: { name: string; content?: string; type?: 'symlink'; linkname?: string }[]; manifestLast?: boolean } = {}) => {
  const home = await buildTar([
    { name: './', type: 'directory' },
    { name: './public_html/', type: 'directory' },
    { name: './public_html/index.php', content: '<?php echo "hi";' },
    { name: './www', type: 'symlink', linkname: 'public_html' },
    { name: './same.php', type: 'link', linkname: './public_html/index.php' },
  ], { gzip: true })
  const sql = Buffer.from('CREATE TABLE t (id int);\n')
  const mailJson = Buffer.from(JSON.stringify(mail))
  const plan = createBackupPlan(req({ databases: ['alice_wp'] }))
  const step = plan.steps.find((s): s is ManifestStep => s.kind === 'write-manifest') as ManifestStep
  const files: Record<string, Buffer> = {
    [`${step.root}/home.tar.gz`]: home,
    [`${step.root}/mysql/alice_wp.sql`]: sql,
    [`${step.root}/mail-config.json`]: mailJson,
  }
  const manifest = await computeManifest(step, (p) => chunked(files[p] as Buffer))
  const homeInArchive = opts.tamperHome
    ? await buildTar([{ name: './public_html/index.php', content: '<?php system($_GET[1]);' }, { name: './www', type: 'symlink', linkname: 'public_html' }, { name: './same.php', type: 'link', linkname: './public_html/index.php' }], { gzip: true })
    : home
  const members = [
    { name: 'home.tar.gz', content: homeInArchive },
    { name: 'mysql/', type: 'directory' as const },
    { name: 'mysql/alice_wp.sql', content: sql },
    { name: 'mail-config.json', content: mailJson },
    ...(opts.extra ?? []),
  ]
  const m = { name: 'manifest.json', content: JSON.stringify(manifest) }
  const archive = await buildTar(opts.manifestLast ? [...members, m] : [m, ...members], { gzip: true })
  return { manifest, archive }
}

describe('manifest', () => {
  it('computes per-file digests for home content (hardlinks included), dumps and mail config', async () => {
    const { manifest } = await buildBackup()
    expect(manifest.files.map((f) => [f.path, f.part, f.type])).toEqual([
      ['home/public_html/index.php', 'home', 'file'],
      ['home/same.php', 'home', 'file'],
      ['home/www', 'home', 'symlink'],
      ['mail-config.json', 'mail-config', 'file'],
      ['mysql/alice_wp.sql', 'databases', 'file'],
    ])
    expect(manifest.files[0]?.size).toBe(16)
    expect(manifest.files[1]?.sha256).toBe(manifest.files[0]?.sha256)
  })

  it('inspects a good archive and catches tampering', async () => {
    const good = await buildBackup()
    const r = await inspectBackupArchive(chunked(good.archive), 'alice')
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)

    const tampered = await inspectBackupArchive(chunked((await buildBackup({ tamperHome: true })).archive))
    expect(tampered.ok).toBe(false)
    expect(tampered.problems).toContain('digest mismatch for home member public_html/index.php')

    const extra = await inspectBackupArchive(chunked((await buildBackup({ extra: [{ name: 'etc/cron.d/x', content: 'evil' }] })).archive))
    expect(extra.problems).toContain('unexpected member etc/cron.d/x')

    const traversal = await inspectBackupArchive(chunked((await buildBackup({ extra: [{ name: '../../root/.ssh/authorized_keys', content: 'k' }] })).archive))
    expect(traversal.ok).toBe(false)
    expect(traversal.problems.join()).toMatch(/path traversal/)

    const link = await inspectBackupArchive(chunked((await buildBackup({ extra: [{ name: 'mysql/x.sql', type: 'symlink', linkname: '/etc/shadow' }] })).archive))
    expect(link.ok).toBe(false)

    const late = await inspectBackupArchive(chunked((await buildBackup({ manifestLast: true })).archive))
    expect(late.problems.join()).toMatch(/first member/)

    const other = await inspectBackupArchive(chunked(good.archive), 'bob')
    expect(other.ok).toBe(false)

    const empty = await inspectBackupArchive(chunked(await buildTar([{ name: 'mysql/', type: 'directory' }])))
    expect(empty).toMatchObject({ ok: false, manifest: null })
  })

  it('backs up and verifies homes with symlink chains and absolute links (the account made them)', async () => {
    const home = await buildTar([
      { name: './', type: 'directory' },
      { name: './releases/', type: 'directory' },
      { name: './releases/2/', type: 'directory' },
      { name: './releases/2/index.php', content: '<?php echo 2;' },
      { name: './live', type: 'symlink', linkname: 'current' },
      { name: './current', type: 'symlink', linkname: 'releases/2' },
      { name: './www', type: 'symlink', linkname: '/home/alice/public_html' },
      { name: './up', type: 'symlink', linkname: '../../etc' },
    ], { gzip: true })
    const plan = createBackupPlan(req({ parts: ['home'], destination: 'download' }))
    const step = plan.steps.find((s): s is ManifestStep => s.kind === 'write-manifest') as ManifestStep
    const manifest = await computeManifest(step, () => chunked(home))
    expect(manifest.files.map((f) => [f.path, f.type])).toEqual([
      ['home/current', 'symlink'], ['home/live', 'symlink'], ['home/releases/2/index.php', 'file'], ['home/up', 'symlink'], ['home/www', 'symlink'],
    ])
    const archive = await buildTar([{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'home.tar.gz', content: home }], { gzip: true })
    expect(await inspectBackupArchive(chunked(archive), 'alice')).toMatchObject({ ok: true, problems: [] })

    // a link re-pointed inside home.tar.gz is caught by its target digest
    const repointed = await buildTar([
      { name: './releases/2/index.php', content: '<?php echo 2;' },
      { name: './live', type: 'symlink', linkname: 'current' },
      { name: './current', type: 'symlink', linkname: 'releases/2' },
      { name: './www', type: 'symlink', linkname: '/home/bob/public_html' },
      { name: './up', type: 'symlink', linkname: '../../etc' },
    ], { gzip: true })
    const bad = await buildTar([{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'home.tar.gz', content: repointed }], { gzip: true })
    expect((await inspectBackupArchive(chunked(bad))).problems).toEqual(['digest mismatch for home member www'])

    // a member written through a link inside home.tar.gz fails verification
    const through = await buildTar([{ name: './www', type: 'symlink', linkname: '/home/bob' }, { name: './www/.bashrc', content: 'x' }], { gzip: true })
    const evil = await buildTar([{ name: 'manifest.json', content: JSON.stringify(manifest) }, { name: 'home.tar.gz', content: through }], { gzip: true })
    expect((await inspectBackupArchive(chunked(evil))).ok).toBe(false)
  })

  it('reports missing members', async () => {
    const { manifest } = await buildBackup()
    const archive = await buildTar([{ name: 'manifest.json', content: JSON.stringify(manifest) }], { gzip: true })
    const r = await inspectBackupArchive(chunked(archive))
    expect(r.problems).toEqual(expect.arrayContaining(['member mail-config.json missing', 'member mysql/alice_wp.sql missing', 'home.tar.gz missing']))
  })

  it('parses manifests strictly', async () => {
    const { manifest } = await buildBackup()
    const mut = (f: (m: Record<string, unknown>) => void): unknown => { const c = structuredClone(manifest) as unknown as Record<string, unknown>; f(c); return c }
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest)
    const files = (m: Record<string, unknown>) => m.files as Record<string, unknown>[]
    const bad = [
      mut((m) => { m.extra = 1 }),
      mut((m) => { m.version = 2 }),
      mut((m) => { m.format = 'cpmove' }),
      mut((m) => { (m.account as Record<string, unknown>).username = 'root' }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).path = 'home/../../etc/passwd' }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).path = '/etc/passwd' }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).path = `home/a${NUL}b` }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).part = 'databases' }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).sha256 = 'zz' }),
      mut((m) => { (files(m)[0] as Record<string, unknown>).size = -1 }),
      mut((m) => { files(m).push({ ...(files(m)[0] as object) }) }),
      mut((m) => { m.databases = ['bob_wp'] }),
      mut((m) => { m.databases = ['alice_wp', 'alice_missing'] }),
      mut((m) => { m.parts = ['full'] }),
      mut((m) => { m.created = 'now' }),
      mut((m) => { m.files = files(m).filter((f) => f.path !== 'mail-config.json') }),
      mut((m) => { (files(m)[3] as Record<string, unknown>).type = 'symlink' }),
    ]
    for (const b of bad) expect(() => parseManifest(b), JSON.stringify(b).slice(0, 200)).toThrow(XpanelError)
    expect(() => parseManifest({ ...manifest, version: 9 })).toThrow(/newer xPanel/)
  })
})

describe('mail config', () => {
  it('round-trips through the strict parser', () => {
    expect(parseMailConfig(structuredClone(mail), ['alice.example'])).toEqual(mail)
  })

  it('merges without deleting anything that exists only now', () => {
    const current: MailConfig = {
      domains: [
        { domain: 'alice.example', forwarders: [{ local: 'info', to: ['ops@alice.example'] }, { local: 'new', to: ['x@y.example'] }], defaultAddress: { kind: 'discard' } },
        { domain: 'shop.example', forwarders: [{ local: 'orders', to: ['a@b.example'] }], defaultAddress: { kind: 'reject' } },
      ],
      mailboxes: [{
        address: 'info@alice.example',
        filters: [
          { name: 'spam', match: 'any', tests: [{ field: 'subject', op: 'contains', value: '[SPAM]' }], actions: [{ kind: 'discard' }] },
          { name: 'keep', match: 'all', tests: [{ field: 'from', op: 'is', value: 'a@b.example' }], actions: [{ kind: 'stop' }] },
        ],
      }],
    }
    const r = mergeMailConfig(current, mail)
    expect(r.merged.domains).toEqual([
      { domain: 'alice.example', forwarders: [{ local: 'info', to: ['ops@alice.example', 'alice@gmail.com', 'ops+alerts@alice.example'] }, { local: 'new', to: ['x@y.example'] }], defaultAddress: { kind: 'reject' } },
      current.domains[1],
    ])
    expect(r.merged.mailboxes[0]?.filters.map((f) => f.name)).toEqual(['spam', 'keep'])
    expect(r.merged.mailboxes[0]?.filters[0]?.actions).toEqual([{ kind: 'fileinto', folder: 'Junk' }, { kind: 'stop' }])
    expect(r).toMatchObject({ addedDestinations: 2, addedForwarders: 0, addedFilters: 0, replacedFilters: 1, changedDefaults: ['alice.example'] })
    expect(current.domains[0]?.forwarders[0]?.to).toEqual(['ops@alice.example'])
  })

  it('adds forwarders, domains and mailboxes that do not exist yet', () => {
    const r = mergeMailConfig({ domains: [], mailboxes: [] }, mail)
    expect(r.merged).toEqual(mail)
    expect(r).toMatchObject({ addedForwarders: 1, addedDestinations: 2, addedFilters: 1 })
  })

  it('refuses a merge that breaks the per-script redirect limit', () => {
    const redirect = (name: string) => ({ name, match: 'any' as const, tests: [{ field: 'subject' as const, op: 'is' as const, value: name }], actions: [{ kind: 'redirect' as const, to: `${name}@x.example` }] })
    const a: MailConfig = { domains: [], mailboxes: [{ address: 'info@alice.example', filters: ['a', 'b', 'c'].map(redirect) }] }
    const b: MailConfig = { domains: [], mailboxes: [{ address: 'info@alice.example', filters: ['d', 'e'].map(redirect) }] }
    expect(() => mergeMailConfig(a, b)).toThrow(XpanelError)
  })

  it('filters by kept domains', () => {
    expect(mailConfigFor(mail, new Set(['shop.example']))).toEqual({ domains: [], mailboxes: [] })
    expect(mailConfigFor(mail, new Set(['alice.example']))).toEqual(mail)
  })

  it('validates filters with the Sieve renderer rules, enabled or not', () => {
    const f = (filter: object) => ({ domains: [], mailboxes: [{ address: 'info@alice.example', filters: [filter] }] })
    const base = (mail.mailboxes[0]?.filters[0] ?? {}) as object
    const parse = (raw: unknown) => parseMailConfig(raw, ['alice.example'])
    expect(() => parse(f({ ...base, tests: [{ field: 'header', header: 'X-Evil\nInjected', op: 'is', value: '1' }] }))).toThrow(XpanelError)
    expect(() => parse(f({ ...base, tests: [{ field: 'subject', op: 'regex-dos', value: '1' }] }))).toThrow(XpanelError)
    expect(() => parse(f({ ...base, actions: [{ kind: 'pipe', to: '/bin/sh' }] }))).toThrow(XpanelError)
    expect(() => parse(f({ ...base, actions: [{ kind: 'fileinto', folder: 'Junk', script: 'x' }] }))).toThrow(/unknown fields/)
    expect(() => parse(f({ ...base, tests: [{ field: 'subject', op: 'is', value: `a${NUL}b` }] }))).toThrow(XpanelError)
    expect(() => parse(f({ ...base, enabled: false, actions: [{ kind: 'redirect', to: '|/bin/sh' }] }))).toThrow(XpanelError)
    expect(() => parse(f({ ...base, enabled: 'yes' }))).toThrow(XpanelError)
    expect(parse(f({ ...base, tests: [{ field: 'header', header: 'X-Spam-Flag', op: 'is', value: 'YES' }] })).mailboxes[0]?.filters[0]?.tests[0]).toEqual({ field: 'header', header: 'X-Spam-Flag', op: 'is', value: 'YES' })
  })

  it('rejects mailboxes and domains off the account, duplicates and non-canonical names', () => {
    const parse = (raw: unknown) => parseMailConfig(raw, ['alice.example'])
    expect(() => parse({ domains: [], mailboxes: [{ address: 'ceo@victim.example', filters: [] }] })).toThrow(/not on this account/)
    expect(() => parse({ domains: [...mail.domains, ...mail.domains], mailboxes: [] })).toThrow(/listed twice/)
    expect(() => parse({ domains: [{ ...mail.domains[0], forwarders: [{ local: 'Info', to: ['a@b.example'] }] }], mailboxes: [] })).toThrow(/canonical/)
    expect(() => parse({ domains: [{ ...mail.domains[0], defaultAddress: { kind: 'pipe', to: '/bin/sh' } }], mailboxes: [] })).toThrow(XpanelError)
    expect(() => parse({ domains: [], mailboxes: [], extra: 1 })).toThrow(/unknown fields/)
  })
})
