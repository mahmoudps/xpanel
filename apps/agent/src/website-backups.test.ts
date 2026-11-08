import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { BackupCommand, BackupCommandResult } from './backup-low-priority.ts'
import { createWebsiteBackup, extractWebsiteBackup, handleWebsiteBackupsRoute, listWebsiteBackups, restoreWebsiteBackup, websiteBackupNotice, websiteJob, type WebsiteBackupsContext, type WebsiteDatabases } from './website-backups.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', DOMAIN = '22222222-2222-4222-8222-222222222222', PRINCIPAL = '33333333-3333-4333-8333-333333333333'
const account = { id: ACCOUNT, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'alice-shop.com' } as Account
const domain = { id: DOMAIN, accountId: ACCOUNT, name: 'alice-shop.com', kind: 'primary', suspended: false, docRoot: '/home/alice/public_html', siteType: 'php' } as unknown as Domain
const plan = { id: 'plan', featureListId: 'fl', resources: { diskMb: 1024 } } as unknown as Plan
const site = { domainId: DOMAIN, path: 'public_html' }
const ok = (over: Partial<BackupCommandResult> = {}): BackupCommandResult => ({ ok: true, code: 0, stdout: '', stderr: '', stdoutBytes: 100, killed: null, ...over })

describe('website backups', () => {
  let root: string
  let calls: BackupCommand[]
  let run: ReturnType<typeof vi.fn<(command: BackupCommand) => Promise<BackupCommandResult>>>
  const databases: WebsiteDatabases = { list: async () => ['alice_wp'], dump: async () => ({ bytes: 1, sha256: 'a'.repeat(64) }), restore: async () => undefined }
  const deps = () => ({ run, root, databases, now: () => new Date('2026-11-07T10:00:00.000Z') })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'xp-website-')); calls = []
    run = vi.fn(async command => { calls.push(command); return ok() })
  })
  afterEach(() => rm(root, { recursive: true, force: true }))
  // Root owns the store on a host; the unprivileged test user cannot chown.
  const chownSafe = process.getuid?.() === 0

  it.runIf(chownSafe)('archives the site as the account and lists it only once complete', async () => {
    const made = await createWebsiteBackup(deps(), account, site, ['alice_wp'])
    expect(calls[0]).toMatchObject({ runAsUser: 'alice' })
    expect((await listWebsiteBackups(root, 'alice', DOMAIN)).map(item => item.id)).toEqual([made.id])
  })

  it('merges with keep-newer and cleans only after a rollback archive', async () => {
    const manifest = { id: '20261107T100000Z-aaaaaaaa', createdAt: '2026-11-07T10:00:00.000Z', path: 'public_html', bytes: 1, databases: [] }
    await restoreWebsiteBackup(deps(), account, DOMAIN, manifest, 'merge', true)
    expect(calls.map(call => call.argv[0])).toEqual(['/usr/bin/tar'])
    expect(calls[0]!.argv).toContain('--keep-newer-files')
    calls.length = 0
    await restoreWebsiteBackup(deps(), account, DOMAIN, manifest, 'clean', true).catch(() => undefined)
    expect(calls.map(call => call.argv[0])).toEqual(['/usr/bin/tar', '/usr/bin/find', '/usr/bin/tar'])
    expect(calls[0]!.argv).toContain('--create')
    expect(calls[1]!.argv).toEqual(['/usr/bin/find', '/home/alice/public_html', '-mindepth', '1', '-delete'])
    expect(calls[2]!.argv).not.toContain('--keep-newer-files')
    expect(calls.every(call => call.runAsUser === 'alice')).toBe(true)
  })

  it('stops a clean restore before touching the site when the rollback cannot be made, and puts it back on failure', async () => {
    const manifest = { id: '20261107T100000Z-aaaaaaaa', createdAt: '2026-11-07T10:00:00.000Z', path: 'public_html', bytes: 1, databases: [] }
    run.mockImplementationOnce(async command => { calls.push(command); return ok({ ok: false, code: 2 }) })
    await expect(restoreWebsiteBackup(deps(), account, DOMAIN, manifest, 'clean', false)).rejects.toThrow(/nothing was changed/)
    expect(calls).toHaveLength(1)
    calls.length = 0
    run.mockImplementation(async command => { calls.push(command); return ok({ ok: calls.length !== 3 }) })
    await expect(restoreWebsiteBackup(deps(), account, DOMAIN, manifest, 'clean', false)).rejects.toThrow(/could not be restored/)
    expect(calls).toHaveLength(4)
    expect(calls[3]!.stdinPath).toContain('.rollback-')
  })

  it('rolls a database back when its restore fails', async () => {
    const manifest = { id: '20261107T100000Z-aaaaaaaa', createdAt: '2026-11-07T10:00:00.000Z', path: 'public_html', bytes: 1, databases: [{ name: 'alice_wp', sha256: 'b'.repeat(64) }] }
    const restore = vi.fn(async (_account: Account, _name: string, path: string) => { if (!path.includes('.rollback-')) throw new Error('bad dump') })
    expect(await restoreWebsiteBackup({ ...deps(), databases: { ...databases, restore } }, account, DOMAIN, manifest, 'merge', true)).toEqual({ restored: [], failed: ['alice_wp'] })
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('extracts into a new folder and leaves the site alone', async () => {
    const manifest = { id: '20261107T100000Z-aaaaaaaa', createdAt: '2026-11-07T10:00:00.000Z', path: 'public_html', bytes: 1, databases: [] }
    expect(await extractWebsiteBackup(deps(), account, DOMAIN, manifest)).toBe('website-restore-20261107T100000Z-aaaaaaaa')
    expect(calls[1]!.argv).toContain('--directory=/home/alice/website-restore-20261107T100000Z-aaaaaaaa')
  })

  it('refuses a second job for the account and a foreign database', async () => {
    let release = (): void => undefined
    run.mockImplementation(() => new Promise(resolve => { release = () => resolve(ok()) }))
    const ctx: WebsiteBackupsContext = { caller: { role: 'user', accountId: ACCOUNT, principalId: PRINCIPAL, actor: 'alice' } as WebsiteBackupsContext['caller'], databases, linuxHost: true, run, root, audit: async () => undefined, sendEmail: async () => undefined,
      store: { getAccountByUsername: async () => account, getPlan: async () => plan, getFeatureList: async () => ({ disabled: [] }) as never, listDomains: async () => [domain] },
      currentPrincipal: async () => ({ kind: 'user', id: PRINCIPAL, username: 'alice', accountId: ACCOUNT, disabled: false }) }
    const post = (body: unknown) => { const url = new URL('http://agent/accounts/alice/website-backups'); return handleWebsiteBackupsRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', ctx) }
    await expect(post({ op: 'create', domainId: DOMAIN, databases: ['bob_wp'] })).rejects.toMatchObject({ detail: { reason: 'foreign_database' } })
    expect((await post({ op: 'create', domainId: DOMAIN, databases: [] }))!.status).toBe(202)
    await expect(post({ op: 'create', domainId: DOMAIN, databases: [] })).rejects.toMatchObject({ detail: { reason: 'OPERATION_IN_PROGRESS' } })
    release()
    await vi.waitFor(async () => { run.mockImplementation(async () => ok()); release(); expect(await readdir(root).catch(() => [])).toBeDefined() })
  })

  it('writes a fixed notice in UTC for either outcome', () => {
    const at = new Date('2026-11-07T10:05:30.000Z')
    expect(websiteBackupNotice('alice-shop.com', true, at)).toEqual({ subject: 'Website backup finished: alice-shop.com', text: 'The backup of alice-shop.com finished at 2026-11-07 10:05 UTC.\nIt is listed under Website backups in your control panel.\n' })
    expect(websiteBackupNotice('alice-shop.com', false, at).subject).toBe('Website backup failed: alice-shop.com')
  })

  it('reports the end of a backup to the address given, and records a mail failure without changing the outcome', async () => {
    run.mockImplementation(async () => ok({ code: 2, ok: false }))
    const entries: Record<string, unknown>[] = [], sendEmail = vi.fn(async () => { throw new Error('sendmail_failed') })
    const ctx: WebsiteBackupsContext = { caller: { role: 'user', accountId: ACCOUNT, principalId: PRINCIPAL, actor: 'alice' } as WebsiteBackupsContext['caller'], databases, linuxHost: true, run, root, sendEmail, audit: async entry => { entries.push(entry.detail) },
      store: { getAccountByUsername: async () => account, getPlan: async () => plan, getFeatureList: async () => ({ disabled: [] }) as never, listDomains: async () => [domain] },
      currentPrincipal: async () => ({ kind: 'user', id: PRINCIPAL, username: 'alice', accountId: ACCOUNT, disabled: false }) }
    const post = (body: unknown) => { const url = new URL('http://agent/accounts/alice/website-backups'); return handleWebsiteBackupsRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', ctx) }
    await expect(post({ op: 'create', domainId: DOMAIN, databases: [], notify: 'not an address' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'invalid_email' } })
    expect(websiteJob('alice')).toBeNull()
    expect((await post({ op: 'create', domainId: DOMAIN, databases: [], notify: 'owner@example.test' }))!.status).toBe(202)
    await vi.waitFor(() => expect(websiteJob('alice')).toBeNull())
    expect(sendEmail).toHaveBeenCalledWith('owner@example.test', 'Website backup failed: alice-shop.com', expect.stringContaining('alice-shop.com failed at'))
    expect(entries.at(-1)).toMatchObject({ emailed: false })
    sendEmail.mockClear()
    expect((await post({ op: 'create', domainId: DOMAIN, databases: [], notify: null }))!.status).toBe(202)
    await vi.waitFor(() => expect(websiteJob('alice')).toBeNull())
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
