import { describe, expect, it, vi } from 'vitest'
import { validateHostJobPlan } from './host-jobs.ts'
import { translator } from '../../web/src/i18n.ts'
import { buildMailboxMaintenancePlan, maintenanceMailboxes, parseMailPlugins, parseMailboxStatus, parseQuotaGet, readMailboxMaintenance } from './mailbox-maintenance.ts'
import type { MaintenanceSnapshot } from './mailbox-maintenance.ts'

const ok = (stdout: string) => ({ ok: true, code: 0, stdout })
const quota = JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: '2048', limit: '10240', percent: '20' }, { root: 'User quota', type: 'MESSAGE', value: '12', limit: '-', percent: '0' }])
const folders = JSON.stringify([{ mailbox: 'INBOX', messages: '10', vsize: '4096' }, { mailbox: 'Sent', messages: '2', vsize: '1024' }])
const snapshot: MaintenanceSnapshot = {
  accounts: [{ id: 'a1', username: 'alice', status: 'active' }, { id: 'a2', username: 'bob', status: 'terminating' }, { id: 'a3', username: 'carol', status: 'suspended' }],
  serviceUsers: [
    { accountId: 'a1', login: 'info@alice.example', services: { email: true }, mailboxQuotaMb: 1024 },
    { accountId: 'a1', login: 'ftp@alice.example', services: { email: false }, mailboxQuotaMb: 'unlimited' },
    { accountId: 'a2', login: 'gone@bob.example', services: { email: true }, mailboxQuotaMb: 10 },
    { accountId: 'a3', login: 'boss@carol.example', services: { email: true }, mailboxQuotaMb: 'unlimited' },
    { accountId: 'missing', login: 'orphan@x.example', services: { email: true }, mailboxQuotaMb: 10 },
    { accountId: 'a1', login: '*@alice.example', services: { email: true }, mailboxQuotaMb: 10 },
  ],
}

describe('mailbox maintenance parsers', () => {
  it('reads doveadm quota rows with kilobyte storage and unlimited limits', () => {
    expect(parseQuotaGet(ok(quota))).toEqual({ state: 'read', reason: null, resources: [{ root: 'User quota', type: 'STORAGE', value: 2048, limit: 10240, percent: 20 }, { root: 'User quota', type: 'MESSAGE', value: 12, limit: null, percent: 0 }] })
    expect(parseQuotaGet(ok('[]'))).toEqual({ state: 'read', reason: null, resources: [] })
    expect(parseQuotaGet(ok(JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: 5, limit: 10, percent: 50 }]))).resources[0]!.value).toBe(5)
  })
  it('turns failed, error and malformed quota output into unavailable states', () => {
    expect(parseQuotaGet({ ok: false, code: 67, stdout: '' })).toMatchObject({ state: 'unavailable', reason: 'user_unknown', resources: [] })
    expect(parseQuotaGet({ ok: false, code: 75, stdout: quota })).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
    expect(parseQuotaGet(null)).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
    expect(parseQuotaGet(ok(JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: 'error', limit: 'error', percent: 'error' }]))).reason).toBe('quota_error')
    for (const bad of ['not json', '{"root":"x"}', '[1]', JSON.stringify([{ root: 'User quota', type: 'BYTES', value: '1', limit: '-', percent: '0' }]), JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: '-1', limit: '-', percent: '0' }]),
      JSON.stringify([{ root: 'User quota', type: 'STORAGE', value: '1', limit: 'none', percent: '0' }]), JSON.stringify([{ root: 'a\u202eb', type: 'STORAGE', value: '1', limit: '-', percent: '0' }]), JSON.stringify([{ type: 'STORAGE', value: '1', limit: '-', percent: '0' }]),
      JSON.stringify(Array.from({ length: 33 }, () => ({ root: 'r', type: 'STORAGE', value: '1', limit: '-', percent: '0' })))]) expect(parseQuotaGet(ok(bad))).toMatchObject({ state: 'unavailable', reason: 'malformed_output', resources: [] })
  })
  it('reads folder usage with totals, bounds rows and neutralises unsafe folder names', () => {
    expect(parseMailboxStatus(ok(folders))).toEqual({ state: 'read', reason: null, folders: [{ name: 'INBOX', messages: 10, vsizeBytes: 4096 }, { name: 'Sent', messages: 2, vsizeBytes: 1024 }], truncated: false, totalMessages: 12, totalVsizeBytes: 5120 })
    const many = parseMailboxStatus(ok(JSON.stringify(Array.from({ length: 201 }, (_, index) => ({ mailbox: 'F' + index, messages: '1', vsize: '10' })))))
    expect(many).toMatchObject({ state: 'read', truncated: true, totalMessages: 201, totalVsizeBytes: 2010 })
    expect(many.folders).toHaveLength(200)
    expect(parseMailboxStatus(ok(JSON.stringify([{ mailbox: 'evil\u202e\nname', messages: '1', vsize: '1' }]))).folders[0]!.name).toBe('evil\ufffd\ufffdname')
    for (const bad of ['', '[{"mailbox":"INBOX"}]', JSON.stringify([{ mailbox: 'INBOX', messages: '1.5', vsize: '1' }]), JSON.stringify([{ mailbox: '', messages: '1', vsize: '1' }]), JSON.stringify([{ mailbox: 7, messages: '1', vsize: '1' }])])
      expect(parseMailboxStatus(ok(bad))).toMatchObject({ state: 'unavailable', reason: 'malformed_output', folders: [], totalMessages: null })
    expect(parseMailboxStatus({ ok: false, code: 68, stdout: folders })).toMatchObject({ state: 'unavailable', reason: 'command_failed', folders: [] })
  })
  it('detects FTS only from the global plugin list', () => {
    expect(parseMailPlugins(ok(' quota fts fts_solr\n'))).toBe('configured')
    expect(parseMailPlugins(ok(' quota\n'))).toBe('not_configured')
    expect(parseMailPlugins(ok('quota fts_lucene_like\n'))).toBe('not_configured')
    expect(parseMailPlugins({ ok: false, code: 1, stdout: '' })).toBe('unavailable')
    expect(parseMailPlugins(ok('quota\u0000fts'))).toBe('unavailable')
  })
})

describe('mailbox maintenance reads and plans', () => {
  it('lists only saved email-enabled mailboxes of live accounts', () => {
    expect(maintenanceMailboxes(snapshot)).toEqual({ mailboxes: [{ login: 'boss@carol.example', account: 'carol', savedQuotaMb: null }, { login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }], truncated: false })
  })
  it('reads FTS, quota and folders for the selected mailbox only', async () => {
    const run = vi.fn(async (argv: string[]) => argv[0] === '/usr/bin/doveconf' ? ok(' quota\n') : argv[3] === 'quota' ? ok(quota) : ok(folders))
    const read = await readMailboxMaintenance({ run, snapshot, mailbox: { login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }, jobsAvailable: true, now: () => new Date('2026-10-27T10:00:00Z') })
    expect(read).toMatchObject({ observedAt: '2026-10-27T10:00:00.000Z', fts: 'not_configured', jobsAvailable: true, mailboxes: [{ login: 'info@alice.example', account: 'alice', savedQuotaMb: 1024 }], mailboxesTruncated: false, report: { mailbox: 'info@alice.example', account: 'alice', quota: { state: 'read' }, folders: { state: 'read', totalMessages: 12 } } })
    expect(run.mock.calls.map(([argv]) => argv.join(' '))).toEqual(['/usr/bin/doveconf -h mail_plugins', '/usr/bin/doveadm -f json quota get -u info@alice.example', '/usr/bin/doveadm -f json mailbox status -u info@alice.example messages vsize *'])
    const failing = await readMailboxMaintenance({ run: async () => { throw new Error('spawn') }, snapshot, mailbox: null, jobsAvailable: false })
    expect(failing).toMatchObject({ fts: 'unavailable', report: null, jobsAvailable: false, mailboxes: [{ login: 'boss@carol.example' }, { login: 'info@alice.example' }] })
  })
  it('builds one reviewed job with one mutating step per mailbox and verifies each with a fresh read', async () => {
    const plan = buildMailboxMaintenancePlan({ operation: 'resync', mailboxes: ['info@alice.example', 'boss@carol.example'] })
    const steps = validateHostJobPlan(plan)
    expect(plan).toMatchObject({ kind: 'mail.maintenance.resync', accountId: null, summary: 'Rebuild Dovecot mailbox indexes for 2 mailboxes', fingerprint: { operation: 'resync', mailboxes: ['info@alice.example', 'boss@carol.example'] } })
    expect(steps.map(step => [step.id, step.argv.join(' '), step.mutates])).toEqual([['mailbox-1', '/usr/bin/doveadm force-resync -u info@alice.example *', true], ['mailbox-2', '/usr/bin/doveadm force-resync -u boss@carol.example *', true]])
    expect(steps[0]).toMatchObject({ title: 'Rebuild mailbox indexes: {mailbox}', titleValues: { mailbox: 'info@alice.example' } })
    expect(translator()(steps[0]!.title, steps[0]!.titleValues)).toBe('Rebuild mailbox indexes: info@alice.example')
    expect(translator('ar')(steps[0]!.title, steps[0]!.titleValues)).toBe('إعادة بناء فهارس الصندوق: info@alice.example')
    for (const step of steps) expect(plan.policy(step.argv)).toBe(true)
    expect(plan.policy(['/usr/bin/doveadm', 'quota', 'recalc', '-u', 'info@alice.example'])).toBe(false)
    const reads: string[] = []
    const verified = await plan.verify!(async argv => { reads.push(argv.join(' ')); return { ...ok(folders), stderr: '', timedOut: false } })
    expect(verified).toEqual({ ok: true, detail: { operation: 'resync', checked: 2, results: [{ mailbox: 'info@alice.example', ok: true }, { mailbox: 'boss@carol.example', ok: true }] } })
    expect(reads).toEqual(['/usr/bin/doveadm -f json mailbox status -u info@alice.example messages vsize *', '/usr/bin/doveadm -f json mailbox status -u boss@carol.example messages vsize *'])
    const partial = await plan.verify!(async argv => argv.includes('boss@carol.example') ? { ok: true, code: 0, stdout: 'garbage', stderr: '', timedOut: false } : { ...ok(folders), stderr: '', timedOut: false })
    expect(partial.ok).toBe(false)
    expect((await plan.verify!(async () => { throw new Error('spawn') })).ok).toBe(false)
  })
  it('verifies quota recalculation with quota get and keeps long logins out of step titles', async () => {
    const long = 'a'.repeat(60) + '@' + 'b'.repeat(60) + '.example.com'
    const plan = buildMailboxMaintenancePlan({ operation: 'quota-recalc', mailboxes: [long] })
    expect(validateHostJobPlan(plan)[0]).toMatchObject({ argv: ['/usr/bin/doveadm', 'quota', 'recalc', '-u', long], title: 'Recalculate quota: {mailbox}', titleValues: { mailbox: long } })
    expect(buildMailboxMaintenancePlan({ operation: 'index', mailboxes: ['x'.repeat(64) + '@' + 'y'.repeat(63) + '.' + 'z'.repeat(40) + '.example'] }).steps[0]!).toMatchObject({ title: 'Update the search index: mailbox {number}', titleValues: { number: '1' } })
    expect(await plan.verify!(async argv => ({ ...ok(argv[3] === 'quota' ? quota : ''), stderr: '', timedOut: false }))).toMatchObject({ ok: true })
    expect((await plan.verify!(async () => ({ ok: false, code: 75, stdout: '', stderr: '', timedOut: false }))).ok).toBe(false)
  })
  it('refuses empty, duplicate, oversized and wildcard selections', () => {
    for (const mailboxes of [[], ['info@alice.example', 'info@alice.example'], ['*@alice.example'], ['-A'], Array.from({ length: 33 }, (_, index) => 'm' + index + '@alice.example')])
      expect(() => buildMailboxMaintenancePlan({ operation: 'resync', mailboxes })).toThrow()
    expect(() => buildMailboxMaintenancePlan({ operation: 'purge' as 'resync', mailboxes: ['info@alice.example'] })).toThrow()
    expect(validateHostJobPlan(buildMailboxMaintenancePlan({ operation: 'index', mailboxes: Array.from({ length: 32 }, (_, index) => 'm' + index + '@alice.example') }))).toHaveLength(32)
  })
})
