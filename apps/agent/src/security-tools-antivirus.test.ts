import { describe, expect, it, vi } from 'vitest'
import type { HostJobView } from './host-job-contract.ts'
import { validateHostJobPlan } from './host-jobs.ts'
import { buildAntivirusScanPlan, buildSignatureUpdatePlan, parseClamscanReport, parseClamscanVersion, readAntivirus } from './security-tools-antivirus.ts'
import type { AntivirusJobs } from './security-tools-antivirus.ts'

const command = '$ /usr/bin/nice -n 19 /usr/bin/clamscan --recursive --infected --follow-dir-symlinks=0 --follow-file-symlinks=0 --max-filesize=100M --max-scansize=400M /home/alice'
const summary = (infected: number) => `\n----------- SCAN SUMMARY -----------\nKnown viruses: 8693452\nEngine version: 1.0.7\nScanned directories: 41\nScanned files: 312\nInfected files: ${infected}\nData scanned: 12.40 MB\nData read: 6.10 MB (ratio 2.03:1)\nTime: 21.512 sec (0 m 21 s)\nStart Date: 2026:10:27 10:00:00\nEnd Date:   2026:10:27 10:00:21\n`
const log = (stdout: string, exit: number, stderr = '') => `2026-10-27T10:00:00.000Z queued security.antivirus.scan for root: Antivirus scan of account alice\n2026-10-27T10:00:00.100Z started (attempt 1)\n\n2026-10-27T10:00:00.200Z step 1/1 scan\n${command}\n${stdout}${stderr ? '[stderr]\n' + stderr : ''}[exit ${exit}]\n2026-10-27T10:00:22.000Z job done\n`
const infectedLog = log('/home/alice/public_html/x.php: Php.Webshell.Generic-1 FOUND\n/home/alice/tmp/eicar.com: Win.Test.EICAR_HDB-1 FOUND\n' + summary(2), 1, 'LibClamAV Warning: cannot read a file\n')
const job = (id: string, kind: string, status: HostJobView['status'], exitCode: number | null, extra: Partial<HostJobView> = {}): HostJobView => ({
  id, referenceCode: 'XP-JOB-2026-000123', kind, status, progress: 100, summary: 'x', accountId: null, actor: 'root', createdAt: '2026-10-27T10:00:00.000Z', startedAt: null, finishedAt: status === 'running' ? null : '2026-10-27T10:00:22.000Z',
  steps: [{ id: kind.endsWith('scan') ? 'scan' : 'update', title: 'x', state: 'succeeded', exitCode }], error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 10, ...extra })
const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`

describe('ClamAV output parsing', () => {
  it('reads the documented version line with and without a signature database', () => {
    expect(parseClamscanVersion('ClamAV 1.0.7/27440/Mon Oct 26 08:21:44 2026\n')).toEqual({ version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' })
    expect(parseClamscanVersion('ClamAV 0.103.11\n')).toEqual({ version: '0.103.11', signatureVersion: null, signatureDate: null })
    for (const bad of ['', 'clamscan: command not found', 'ClamAV 1.0.7/x/y', 'ClamAV 1.0.7\nextra', 'ClamAV 1.0.7/1/\u202edate', 7]) expect(parseClamscanVersion(bad as string)).toBeNull()
  })
  it('lists infected files under the logged target and checks them against the final summary', () => {
    const report = parseClamscanReport(infectedLog)
    expect(report).toEqual({ target: '/home/alice', matched: 2, infected: [{ path: '/home/alice/public_html/x.php', signature: 'Php.Webshell.Generic-1' }, { path: '/home/alice/tmp/eicar.com', signature: 'Win.Test.EICAR_HDB-1' }],
      summary: { knownViruses: 8693452, engineVersion: '1.0.7', scannedDirectories: 41, scannedFiles: 312, infectedFiles: 2, dataScanned: '12.40 MB', time: '21.512 sec (0 m 21 s)' } })
    expect(parseClamscanReport(log(summary(0), 0))).toMatchObject({ target: '/home/alice', matched: 0, infected: [], summary: { infectedFiles: 0 } })
  })
  it('ignores crafted names: outside paths, early forged summaries and an unlogged target', () => {
    const forged = log('/home/alice/a\n----------- SCAN SUMMARY -----------\nInfected files: 0: Eicar FOUND\n/home/bob/secret.php: Php.Webshell-1 FOUND\n/home/alice2/x: Eicar FOUND\n/home/alice/b: Bad Sig FOUND\n' + summary(1), 1)
    const report = parseClamscanReport(forged)
    expect(report.summary!.infectedFiles).toBe(1)
    expect(report.infected.map(item => item.path)).toEqual([])
    expect(parseClamscanReport(infectedLog.replace(command, command.replace('--follow-dir-symlinks=0', '--follow-dir-symlinks=2'))).target).toBeNull()
    expect(parseClamscanReport(infectedLog.replace(command, '$ /usr/bin/clamscan /home/alice')).infected).toEqual([])
    expect(parseClamscanReport('garbage')).toEqual({ target: null, summary: null, infected: [], matched: 0 })
  })
})

describe('antivirus job plans', () => {
  it('scans exactly one account home as a reviewed non-mutating job', () => {
    const plan = buildAntivirusScanPlan({ accountId: id(1), username: 'alice', target: '/home/alice' })
    const [step] = validateHostJobPlan(plan)
    expect(plan).toMatchObject({ kind: 'security.antivirus.scan', accountId: id(1), fingerprint: { username: 'alice', target: '/home/alice' } })
    expect(step).toMatchObject({ id: 'scan', mutates: false, timeoutMs: 3_600_000, argv: command.slice(2).split(' ') })
    expect(plan.policy(step!.argv)).toBe(true)
    for (const [username, target] of [['alice', '/home/bob'], ['alice', '/etc'], ['alice', '/home/alice/public_html'], ['root', '/root'], ['alice', '/home/../alice'], ['alice', '/']] as [string, string][]) expect(() => buildAntivirusScanPlan({ accountId: id(1), username, target })).toThrow()
  })
  it('updates signatures with freshclam and verifies the engine afterwards', async () => {
    const plan = buildSignatureUpdatePlan()
    expect(validateHostJobPlan(plan)[0]).toMatchObject({ id: 'update', argv: ['/usr/bin/freshclam', '--quiet'], mutates: false })
    expect(await plan.verify!(async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7/27441/Tue Oct 27 08:00:00 2026\n', stderr: '', timedOut: false }))).toEqual({ ok: true, detail: { version: '1.0.7', signatureVersion: 27441, signatureDate: 'Tue Oct 27 08:00:00 2026' } })
    expect((await plan.verify!(async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7\n', stderr: '', timedOut: false }))).ok).toBe(false)
    expect((await plan.verify!(async () => { throw new Error('spawn') })).ok).toBe(false)
  })
})

describe('antivirus observation', () => {
  const present = async () => true
  const accounts = [{ username: 'bob', status: 'active' }, { username: 'alice', status: 'suspended' }, { username: 'gone', status: 'terminating' }]
  it('reports a missing engine truthfully and keeps scans unavailable without a job runner', async () => {
    const run = vi.fn()
    expect(await readAntivirus({ run, present: async () => false, accounts, jobs: null, now: () => new Date('2026-10-27T10:00:00Z') })).toEqual({
      observedAt: '2026-10-27T10:00:00.000Z', engine: { state: 'not_installed', version: null, signatureVersion: null, signatureDate: null }, updater: { present: false }, jobsAvailable: false,
      accounts: [{ username: 'alice', status: 'suspended' }, { username: 'bob', status: 'active' }], scans: [], updates: [] })
    expect(run).not.toHaveBeenCalled()
    expect((await readAntivirus({ run: async () => ({ ok: false, code: 2, stdout: '', stderr: 'x' }), present, accounts, jobs: null })).engine.state).toBe('unavailable')
  })
  it('classifies scan and update jobs by their recorded exit codes and parses bounded results', async () => {
    const logs: Record<string, string> = { [id(1)]: infectedLog, [id(2)]: log(summary(0), 0), [id(3)]: log('', 2, 'ERROR: Can\'t access file /home/alice\n') }
    const jobs: AntivirusJobs = {
      list: vi.fn(async ({ kindPrefix }: { kindPrefix?: string }) => kindPrefix === 'security.antivirus.scan'
        ? [job(id(1), 'security.antivirus.scan', 'succeeded', 1), job(id(2), 'security.antivirus.scan', 'succeeded', 0), job(id(3), 'security.antivirus.scan', 'failed', 2), job(id(4), 'security.antivirus.scan', 'running', null), job(id(5), 'security.antivirus.scan', 'failed', null, { failureClass: 'unknown_outcome' })]
        : [job(id(6), 'security.antivirus.signatures', 'succeeded', 0, { verification: { ok: true, detail: { signatureVersion: 27441 } } }), job(id(7), 'security.antivirus.signatures', 'succeeded', 1), job(id(8), 'security.antivirus.signatures', 'failed', 52)]) as AntivirusJobs['list'],
      readLog: vi.fn(async (jobId: string) => ({ id: jobId, available: true, offset: 0, nextOffset: logs[jobId]!.length, total: logs[jobId]!.length, truncated: false, text: logs[jobId]! })) as AntivirusJobs['readLog'],
    }
    const read = await readAntivirus({ run: async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7/27440/Mon Oct 26 08:21:44 2026\n', stderr: '' }), present, accounts, jobs })
    expect(read.engine).toEqual({ state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' })
    expect(read.scans.map(scan => [scan.result, scan.account, scan.listComplete])).toEqual([['infected', 'alice', true], ['clean', 'alice', true], ['error', 'alice', false], ['pending', null, false], ['unknown', null, false]])
    expect(read.scans[0]!.infected).toHaveLength(2)
    expect(read.scans[0]!.referenceCode).toBe('XP-JOB-2026-000123')
    expect(read.updates[0]!.referenceCode).toBe('XP-JOB-2026-000123')
    expect(read.updates.map(update => [update.result, update.signatureVersion])).toEqual([['updated', 27441], ['up_to_date', null], ['error', null]])
    expect(jobs.readLog).toHaveBeenCalledTimes(3)
  })
  it('never reports a summary that contradicts the exit code, and marks partial logs incomplete', async () => {
    const big = infectedLog
    const jobs: AntivirusJobs = {
      list: (async ({ kindPrefix }: { kindPrefix?: string }) => kindPrefix === 'security.antivirus.scan' ? [job(id(1), 'security.antivirus.scan', 'succeeded', 0), job(id(2), 'security.antivirus.scan', 'succeeded', 1)] : []) as AntivirusJobs['list'],
      readLog: (async (jobId: string, offset: number) => jobId === id(1) ? { id: jobId, available: true, offset: 0, nextOffset: big.length, total: big.length, truncated: false, text: big }
        : { id: jobId, available: true, offset, nextOffset: offset + 10, total: 5_000_000, truncated: true, text: offset === 0 ? big.slice(0, 400) : big.slice(400) }) as AntivirusJobs['readLog'],
    }
    const read = await readAntivirus({ run: async () => ({ ok: true, code: 0, stdout: 'ClamAV 1.0.7\n', stderr: '' }), present, accounts, jobs })
    expect(read.scans[0]).toMatchObject({ result: 'clean', summary: null, listComplete: false })
    expect(read.scans[1]).toMatchObject({ result: 'infected', listComplete: false })
  })
})
