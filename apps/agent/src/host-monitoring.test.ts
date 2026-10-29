import { describe, expect, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { MONITORING_PS_ARGV } from '../../../packages/os/src/monitoring-command.ts'
import {
  parseDfInodeTable, parseDfSpace, parseJournalJson, parsePsOutput, parseRepquotaUsage, processProtection,
  readDisk, readLogs, readProcesses, signalProcess,
} from './host-monitoring.ts'
import type { MonitoringRun } from './host-monitoring.ts'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const now = () => new Date(NOW)
const self = { pid: 900, ppid: 899 }
const PS = [
  '      1       0     0 root       0.0  0.1 12000   86400 Ss   systemd',
  '      2       0     0 root       0.0  0.0     0   86400 S    kthreadd',
  '     40       2     0 root       0.0  0.0     0   86400 I<   kworker/0:0H',
  '    899       1     0 root       0.0  0.2  2000    3600 Ss   node',
  '    900     899     0 root       1.0  2.0 40000    3600 Sl   node',
  '   1200       1   998 xpanel     0.5  3.0 60000    3600 Ssl  node',
  '   1300       1    33 www-data   0.0  0.5  8000     600 S    nginx',
  '   1301       1     0 root       0.0  0.5  8000     600 Ss   nginx',
  '   1400    1301   106 mysql      2.0  9.0 90000    7200 Ssl  mariadbd',
  '   4242       1 20001 alice      1.5  1.0 20480     120 S    php-fpm8.3',
  '   4243       1 20001 alice      0.5  0.5 10240      60 R    Web Content',
  '   5000       1 20002 20002      0.0  0.1  1024      30 S    bash',
].join('\n') + '\n'
const accounts = [{ username: 'alice', uid: 20001, status: 'active' }, { username: 'longaccount01', uid: 20002, status: 'active' }]
const reviewed = { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: new Date(NOW - 120_000).toISOString(), signal: 'TERM' as const }
const runner = (outputs: Record<string, { ok: boolean; stdout: string } | (() => { ok: boolean; stdout: string })>): MonitoringRun & { calls: string[][] } => {
  const calls: string[][] = []
  const run = (async (argv: string[]) => {
    calls.push(argv)
    const value = outputs[argv[0] === '/usr/bin/kill' ? 'kill' : argv.join(' ')]
    const result = typeof value === 'function' ? value() : value
    return result ? { ...result, stderr: '' } : { ok: false, stdout: '', stderr: 'unexpected' }
  }) as MonitoringRun & { calls: string[][] }
  run.calls = calls
  return run
}
const psKey = MONITORING_PS_ARGV.join(' ')

describe('process observation', () => {
  it('parses procps rows with spaced command names and derives the start from etimes', () => {
    const rows = parsePsOutput(PS, NOW)
    expect(rows).toHaveLength(12)
    expect(rows.find(row => row.pid === 4243)).toMatchObject({ comm: 'Web Content', uid: 20001, rssBytes: 10240 * 1024, stat: 'R', startedAt: new Date(NOW - 60_000).toISOString() })
    expect(rows.find(row => row.pid === 5000)!.user).toBe('20002')
  })
  it('rejects malformed, duplicate, control-character and impossible rows', () => {
    for (const bad of ['abc', '  1 0 0 root x 0.1 1 1 S init', '  4242 1 0 root 0.0 0.0 1 1 S a\n  4242 1 0 root 0.0 0.0 1 1 S b', '  7 1 0 root 0.0 0.0 1 1 Q x', '  7 1 0 root 0.0 0.0 1 99999999999 S x', '  7 1 0 root 0.0 0.0 1 1 S \u001b[2Jx', 'a\u0000b'])
      expect(() => parsePsOutput(bad, NOW)).toThrow()
  })
  it('protects init, kernel threads, the agent, root, the panel and core service masters', () => {
    const rows = parsePsOutput(PS, NOW), protection = Object.fromEntries(rows.map(row => [row.pid, processProtection(row, self)]))
    expect(protection).toEqual({ 1: 'init', 2: 'kernel', 40: 'kernel', 899: 'agent', 900: 'agent', 1200: 'panel', 1300: 'protected-command', 1301: 'root', 1400: 'protected-command', 4242: null, 4243: null, 5000: null })
    for (const comm of ['sshd', 'systemd-journal', 'xpanel-worker', 'dovecot', 'pdns_server', 'master', 'nft']) expect(processProtection({ pid: 7000, ppid: 1, uid: 1000, user: 'svc', comm }, self)).toBe('protected-command')
    expect(processProtection({ pid: 7000, ppid: 1300, uid: 33, user: 'www-data', comm: 'nginx' }, self)).toBeNull()
  })
  it('groups by numeric account uid and reports truthful unavailable states', async () => {
    const view = await readProcesses(runner({ [psKey]: { ok: true, stdout: PS } }), accounts, self, now)
    expect(view).toMatchObject({ state: 'read', total: 12, truncated: false, observedAt: new Date(NOW).toISOString() })
    expect(view.accounts).toEqual([{ username: 'alice', processes: 2, cpuPercent: 2, rssBytes: 30720 * 1024 }, { username: 'longaccount01', processes: 1, cpuPercent: 0, rssBytes: 1024 * 1024 }])
    expect(view.items.find(row => row.pid === 5000)!.account).toBe('longaccount01')
    expect(await readProcesses(runner({ [psKey]: { ok: false, stdout: '' } }), accounts, self, now)).toMatchObject({ state: 'unavailable', items: [], reason: 'process-list-unavailable' })
    expect(await readProcesses(runner({ [psKey]: { ok: true, stdout: 'garbage\n' } }), accounts, self, now)).toMatchObject({ state: 'unavailable', items: [], reason: 'invalid-process-list' })
    const many = Array.from({ length: 4001 }, (_, index) => `${index + 10} 1 20001 alice 0.0 0.0 1 1 S sleep`).join('\n')
    const capped = await readProcesses(runner({ [psKey]: { ok: true, stdout: many } }), accounts, self, now)
    expect([capped.items.length, capped.total, capped.truncated, capped.accounts[0]!.processes]).toEqual([4000, 4001, true, 4001])
  })
})

describe('identity-bound process signal', () => {
  const gone = PS.split('\n').filter(line => !line.includes(' 4242 ')).join('\n')
  const options = (beforeDispatch = vi.fn(async () => {})) => ({ self, beforeDispatch, now, sleep: async () => {} })
  const code = async (promise: Promise<unknown>) => { try { await promise; return 'resolved' } catch (error) { return isXpanelError(error) ? [error.code, error.detail.stateChanged, error.detail.reason] : 'other' } }

  it('confirms only when a re-read no longer shows the reviewed process', async () => {
    let reads = 0
    const run = runner({ [psKey]: () => ({ ok: true, stdout: reads++ ? gone : PS }), kill: { ok: true, stdout: '' } })
    const dispatch = vi.fn(async () => {})
    expect(await signalProcess(run, reviewed, options(dispatch))).toEqual({ state: 'confirmed', signal: 'TERM', pid: 4242, commandOk: true, observedAt: new Date(NOW).toISOString(), verificationRequired: false })
    expect(run.calls.filter(argv => argv[0] === '/usr/bin/kill')).toEqual([['/usr/bin/kill', '-s', 'TERM', '4242']])
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('reports attempted while the process remains and unknown when it cannot be re-read', async () => {
    const still = runner({ [psKey]: { ok: true, stdout: PS }, kill: { ok: true, stdout: '' } })
    expect(await signalProcess(still, { ...reviewed, signal: 'KILL' }, options())).toMatchObject({ state: 'attempted', signal: 'KILL', verificationRequired: true })
    expect(still.calls.filter(argv => argv[0] === '/usr/bin/ps')).toHaveLength(5)
    let reads = 0
    const blind = runner({ [psKey]: () => reads++ ? { ok: false, stdout: '' } : { ok: true, stdout: PS }, kill: { ok: false, stdout: '' } })
    expect(await signalProcess(blind, reviewed, options())).toMatchObject({ state: 'unknown', commandOk: false, verificationRequired: true })
  })
  it('refuses a changed identity with 409 and protected processes before dispatch', async () => {
    const run = runner({ [psKey]: { ok: true, stdout: PS }, kill: { ok: true, stdout: '' } })
    const dispatch = vi.fn(async () => {})
    for (const changed of [{ ...reviewed, comm: 'php-fpm8.2' }, { ...reviewed, uid: 20002 }, { ...reviewed, startedAt: new Date(NOW - 130_000).toISOString() }, { ...reviewed, pid: 4244 }])
      expect(await code(signalProcess(run, changed, options(dispatch)))).toEqual(['CONFLICT', false, 'process-changed'])
    expect(await code(signalProcess(run, { ...reviewed, startedAt: new Date(NOW - 121_000).toISOString() }, { ...options(), rereads: 1 }))).toBe('resolved')
    for (const target of [
      { pid: 1301, uid: 0, comm: 'nginx', startedAt: new Date(NOW - 600_000).toISOString() }, { pid: 1400, uid: 106, comm: 'mariadbd', startedAt: new Date(NOW - 7_200_000).toISOString() },
      { pid: 1200, uid: 998, comm: 'node', startedAt: new Date(NOW - 3_600_000).toISOString() }, { pid: 900, uid: 0, comm: 'node', startedAt: new Date(NOW - 3_600_000).toISOString() },
    ]) expect(await code(signalProcess(run, { ...target, signal: 'TERM' }, options(dispatch)))).toEqual(['FORBIDDEN', false, 'protected-process'])
    expect(dispatch).not.toHaveBeenCalled()
    expect(await code(signalProcess(runner({ [psKey]: { ok: false, stdout: '' } }), reviewed, options(dispatch)))).toEqual(['PRECONDITION_FAILED', false, undefined])
    expect(run.calls.filter(argv => argv[0] === '/usr/bin/kill')).toHaveLength(1)
  })
  it('does not signal when the pre-dispatch authority check fails', async () => {
    const run = runner({ [psKey]: { ok: true, stdout: PS }, kill: { ok: true, stdout: '' } })
    await expect(signalProcess(run, reviewed, options(vi.fn(async () => { throw new Error('denied') })))).rejects.toThrow('denied')
    expect(run.calls.some(argv => argv[0] === '/usr/bin/kill')).toBe(false)
  })
})

describe('disk observation', () => {
  const SPACE = 'Filesystem     Type     1-blocks        Used   Available Capacity Mounted on\n/dev/vda1      ext4  52521566208 20971520000 29393936384      42% /\ntmpfs          tmpfs   104857600       12288   104845312       1% /run\n/dev/vdb1      xfs  107374182400  1073741824 106300440576       1% /srv/My Data\n'
  const INODES = 'Filesystem      Inodes  IUsed   IFree IUse% Mounted on\n/dev/vda1      3276800 250000 3026800    8% /\ntmpfs           256000    900  255100    1% /run\n/dev/vdb1            0      0       0     - /srv/My Data\n'
  const MOUNTINFO = '29 1 252:1 / / rw,relatime shared:1 - ext4 /dev/vda1 rw\n'
  const REPQUOTA = '*** Report for user quotas on device /dev/vda1\nBlock grace time: 7days; Inode grace time: 7days\n                        Block limits                File limits\nUser            used    soft    hard  grace    used  soft  hard  grace\n----------------------------------------------------------------------\nroot      --  1234567       0       0          12345     0     0\nalice     +-   204800  102400  102400  6days     10     0     0\n'
  it('parses POSIX df with spaced mount points and joins inode counts', async () => {
    expect(parseDfSpace(SPACE)[2]).toEqual({ filesystem: '/dev/vdb1', type: 'xfs', mount: '/srv/My Data', totalBytes: 107374182400, usedBytes: 1073741824, availableBytes: 106300440576 })
    expect(parseDfInodeTable(INODES).get('/')).toEqual({ total: 3276800, used: 250000, free: 3026800 })
    const run = runner({ '/usr/bin/df -B1 -P -T': { ok: true, stdout: SPACE }, '/usr/bin/df -i -P': { ok: true, stdout: INODES }, '/usr/sbin/repquota -u /': { ok: true, stdout: REPQUOTA } })
    const disk = await readDisk(run, async () => MOUNTINFO, accounts, now)
    expect(disk.filesystems.state).toBe('read')
    expect(disk.filesystems.items.map(item => item.inodes)).toEqual([{ total: 3276800, used: 250000, free: 3026800 }, { total: 256000, used: 900, free: 255100 }, null])
    expect(disk.accounts).toEqual({ state: 'read', source: 'repquota', mount: '/', items: [{ username: 'alice', usedBytes: 204800 * 1024, limitBytes: 102400 * 1024 }, { username: 'longaccount01', usedBytes: null, limitBytes: null }] })
    expect(run.calls.some(argv => argv[0] === '/usr/bin/du')).toBe(false)
  })
  it('keeps malformed or missing sources unavailable, never zero', async () => {
    for (const bad of ['', 'Filesystem only\n', SPACE + '/dev/x ext4 12 abc 1 1% /x\n', SPACE + '/dev/vda1 ext4 1 1 1 1% /\n', SPACE.replace('/srv/My Data', 'relative')]) expect(() => parseDfSpace(bad)).toThrow()
    expect(() => parseDfInodeTable(INODES + '/dev/x 10 11 0 100% /x\n')).toThrow()
    for (const bad of ['', 'no header\nalice -- 1 2 3\n', REPQUOTA.replace('Block limits', 'Block limits (MB)'), REPQUOTA + 'alice -- 1 1 1\n']) expect(() => parseRepquotaUsage(bad)).toThrow()
    const run = runner({ '/usr/bin/df -B1 -P -T': { ok: true, stdout: SPACE }, '/usr/bin/df -i -P': { ok: true, stdout: 'broken' } })
    const partial = await readDisk(run, async () => MOUNTINFO, accounts, now)
    expect([partial.filesystems.state, partial.filesystems.inodes, partial.filesystems.items[0]!.inodes]).toEqual(['read', 'unavailable', null])
    expect(partial.accounts).toMatchObject({ state: 'unavailable', mount: '/', reason: 'quota-report-unavailable', items: [] })
    expect((await readDisk(runner({}), async () => null, accounts, now))).toMatchObject({ filesystems: { state: 'unavailable', reason: 'filesystems-unavailable' }, accounts: { state: 'unavailable', reason: 'quota-mount-unavailable' } })
    const invalid = await readDisk(runner({ '/usr/bin/df -B1 -P -T': { ok: true, stdout: 'x\ny\n' } }), async () => MOUNTINFO, accounts, now)
    expect(invalid.filesystems).toEqual({ state: 'unavailable', items: [], inodes: 'unavailable', reason: 'invalid-filesystems' })
  })
})

describe('journal observation', () => {
  const entry = (fields: Record<string, unknown>) => JSON.stringify({ __REALTIME_TIMESTAMP: String(NOW * 1000), PRIORITY: '6', _SYSTEMD_UNIT: 'nginx.service', _PID: '1301', MESSAGE: 'started', ...fields })
  const query = { unit: 'nginx.service', lines: 10, since: null, priority: null }
  it('decodes byte-array and repeated messages, keeps null fields explicit and caps at 4 KiB', () => {
    const items = parseJournalJson([entry({}), entry({ MESSAGE: [104, 105, 0xff] }), entry({ MESSAGE: ['a', 'b'] }), entry({ MESSAGE: null, PRIORITY: undefined, _PID: undefined }), entry({ MESSAGE: 'é'.repeat(3000) })].join('\n'))
    expect(items.map(item => item.message?.slice(0, 3))).toEqual(['sta', 'hi�', 'a\nb', undefined, 'ééé'])
    expect(items[3]).toEqual({ at: new Date(NOW).toISOString(), priority: null, unit: 'nginx.service', pid: null, message: null, messageTruncated: false })
    expect([Buffer.byteLength(items[4]!.message!), items[4]!.messageTruncated]).toEqual([4096, true])
  })
  it('refuses malformed journal output as a whole', () => {
    for (const bad of ['not json', '[]', entry({ __REALTIME_TIMESTAMP: 12 }), entry({ PRIORITY: '9' }), entry({ MESSAGE: { x: 1 } }), entry({ MESSAGE: [256] }), entry({ _PID: 'abc' }), entry({ _SYSTEMD_UNIT: 'a\nb' })])
      expect(() => parseJournalJson(bad)).toThrow()
  })
  it('runs the reviewed argv, returns newest first and bounds the total response', async () => {
    const lines = [entry({ MESSAGE: 'first', __REALTIME_TIMESTAMP: String((NOW - 1000) * 1000) }), entry({ MESSAGE: 'second' })].join('\n')
    const run = runner({ '/usr/bin/journalctl --no-pager -o json --output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID -n 10 -u nginx.service': { ok: true, stdout: lines } })
    const view = await readLogs(run, query, now)
    expect(view).toMatchObject({ state: 'read', unit: 'nginx.service', order: 'newest-first', truncated: false })
    expect(view.items.map(item => item.message)).toEqual(['second', 'first'])
    const big = Array.from({ length: 300 }, (_, index) => entry({ MESSAGE: 'x'.repeat(4000) + index })).join('\n')
    const capped = await readLogs(runner({ '/usr/bin/journalctl --no-pager -o json --output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID -n 500 -u nginx.service': { ok: true, stdout: big } }), { ...query, lines: 500 }, now)
    expect(capped.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThan(1024 * 1024)
    expect(capped.items[0]!.message!.endsWith('299')).toBe(true)
    expect(await readLogs(runner({}), query, now)).toMatchObject({ state: 'unavailable', items: [], reason: 'journal-unavailable' })
    expect(await readLogs(runner({ '/usr/bin/journalctl --no-pager -o json --output-fields=MESSAGE,PRIORITY,_SYSTEMD_UNIT,_PID -n 1 -u nginx.service': { ok: true, stdout: lines } }), { ...query, lines: 1 }, now)).toMatchObject({ state: 'unavailable', reason: 'invalid-journal' })
  })
})
