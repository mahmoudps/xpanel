import { describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { defaultPlan, type Account } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import * as hostIdentity from './host-identity.ts'
import { createAgentApp } from './server.ts'
import { HostReconciler } from './reconciler.ts'
import { createProductionHostTargetMatcher, LinuxHostExecutor, MAILDIR_BOX_RE } from './executor.ts'
import { parseLoadavg, parseMeminfo } from './host-info.ts'
import { classifyHostBinaries, probeAuditLog, readHostMeasurements } from './host-probes.ts'

describe('host capability probes', () => {
  it('reports host limit evidence unavailable when the account or plan read fails, despite all controllers', async () => {
    const state = await createTestStateStore()
    const database = await createTestDb()
    const certificate = vi.spyOn(hostIdentity, 'readServedCertificatePem').mockResolvedValue(null)
    class Reader extends LinuxHostExecutor {
      ioMax = '8:2 rbps=1 wbps=1 riops=1 wiops=1'
      override async readFile(path: string): Promise<string | null> {
        if (path === '/proc/loadavg') return '0.1 0.2 0.3 1/100 1'
        if (path === '/proc/meminfo') return 'MemTotal: 2048 kB\nMemAvailable: 1024 kB\n'
        if (path.endsWith('/cgroup.subtree_control')) return 'cpu memory io pids'
        if (path === '/proc/self/mountinfo') return '1 0 8:2 / /home rw - ext4 /dev/sda2 rw\n'
        return null
      }
      override async runCommand(argv: string[]) {
        if (argv[0] === '/usr/sbin/repquota') return { ok: true, code: 0, stdout: 'Block limits\nalice -- 0 0 1048576 0 0 0\n', stderr: '' }
        return { ok: argv[0] === '/usr/bin/df', code: 0, stdout: 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 100000 20000 80000 20% /\n', stderr: '' }
      }
      override async readSliceMetrics(uid: number) { return { uid, cpuUsageUsec: 0, memoryCurrentBytes: 1234, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 4, memoryMax: '1', pidsMax: '1', cpuMax: '1 100000', ioMax: this.ioMax } }
    }
    try {
      const principal = await createRootPrincipal(database.db, { username: 'root', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo' })
      const executor = new Reader()
      const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
      const app = createAgentApp({ store: state.store, db: database.db, executor, reconciler: new HostReconciler({ store: state.store, db: database.db, executor, os }), os, agentToken: 'a'.repeat(64) })
      for (const method of ['listAccounts', 'listPlans'] as const) {
        const failed = vi.spyOn(state.store, method).mockRejectedValueOnce(new Error('unread'))
        const response = await app.fetch(new Request('http://agent.local/host/info', { headers: { 'x-xpanel-agent-token': 'a'.repeat(64), 'x-xpanel-principal-id': principal.id } }))
        expect(response.status).toBe(200)
        const body = await response.json() as { identity: hostIdentity.HostIdentity }
        expect(body.identity.enforcedLimits).toEqual({ cpu: true, memory: true, io: true, pids: true })
        expect(body.identity.observedLimits?.status).toBe('unavailable')
        failed.mockRestore()
      }
      const plan = defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' })
      plan.resources = { ...plan.resources, diskMb: 1024, memoryMb: 1024, maxProcesses: 64, cpuPercent: 100, ioReadBps: 1000, ioWriteBps: 1000, ioReadIops: 10, ioWriteIops: 10 }
      const accounts = vi.spyOn(state.store, 'listAccounts').mockResolvedValue([{ id: 'account', username: 'alice', uid: 20001, home: '/home/alice', planId: 'plan', status: 'active' } as Account])
      const plans = vi.spyOn(state.store, 'listPlans').mockResolvedValue([plan])
      const mismatch = await app.fetch(new Request('http://agent.local/host/info', { headers: { 'x-xpanel-agent-token': 'a'.repeat(64), 'x-xpanel-principal-id': principal.id } }))
      expect(mismatch.status).toBe(200)
      const evidence = await mismatch.json() as { identity: hostIdentity.HostIdentity }
      expect(evidence.identity.observedLimits).toEqual({ status: 'gaps', checkedAccounts: 1, unavailableAccounts: 0, gaps: ['memory', 'pids', 'io', 'cpu'] })
      const owned = vi.spyOn(state.store, 'getAccountByUsername').mockResolvedValue({ id: 'account', username: 'alice', uid: 20001, home: '/home/alice', planId: 'plan', status: 'active' } as Account)
      const assigned = vi.spyOn(state.store, 'getPlan').mockResolvedValue(plan)
      const usage = async () => {
        const response = await app.fetch(new Request('http://agent.local/host/account-usage?username=alice', { headers: { 'x-xpanel-agent-token': 'a'.repeat(64), 'x-xpanel-principal-id': principal.id } }))
        expect(response.status).toBe(200)
        return response.json() as Promise<{ ioEnforced: boolean | null; memoryBytes: number; processCount: number }>
      }
      expect((await usage()).ioEnforced).toBe(false)
      executor.ioMax = '8:2 rbps=1000 wbps=1000 riops=10 wiops=10'
      expect(await usage()).toMatchObject({ ioEnforced: true, memoryBytes: 1234, processCount: 4 })
      assigned.mockResolvedValueOnce(null)
      expect((await usage()).ioEnforced).toBeNull()
      assigned.mockRejectedValueOnce(new Error('unread plan'))
      expect((await usage()).ioEnforced).toBeNull()
      executor.ioMax = '8:9 rbps=1000 wbps=1000 riops=10 wiops=10'
      expect((await usage()).ioEnforced).toBe(false)
      owned.mockRestore()
      assigned.mockRestore()
      accounts.mockRestore()
      plans.mockRestore()
    } finally {
      certificate.mockRestore()
      await state.close()
      await database.close()
    }
  })

  it('passes a probe only when its binary is present', async () => {
    const present = new Set(['/usr/sbin/useradd', '/usr/sbin/apache2', '/usr/bin/mariadb'])
    const probes = classifyHostBinaries(path => present.has(path), false)
    expect(probes['linux-account']).toBe('passed')
    expect(probes.apache).toBe('passed')
    expect(probes.mariadb).toBe('passed')
    expect(probes.mail).toBe('failed')
    expect(probes.files).toBe('failed')
    expect(probes.acme).toBe('failed')
    expect(probes.pdns).toBe('failed')
    expect(probes.systemd).toBe('failed')
    expect(probes.backups).toBe('failed')
    expect(probes['host-info']).toBe('failed')
    expect(probes.audit_log).toBe('failed')
    expect(classifyHostBinaries(() => false, false, false, { auditLog: true }).audit_log).toBe('passed')
    await expect(probeAuditLog(async () => [])).resolves.toBe(true)
    await expect(probeAuditLog(async () => { throw new Error('unread') })).resolves.toBe(false)
  })

  it('requires both postfix and dovecot, and the confined file runner', () => {
    const present = new Set(['/usr/sbin/postfix', '/usr/sbin/dovecot', '/usr/bin/certbot'])
    expect(classifyHostBinaries(path => present.has(path), false).mail).toBe('passed')
    expect(classifyHostBinaries(path => present.has(path), false).files).toBe('failed')
    expect(classifyHostBinaries(path => present.has(path), true).files).toBe('passed')
    expect(classifyHostBinaries(path => present.has(path), true).acme).toBe('passed')
    expect(classifyHostBinaries(() => false, true).mail).toBe('failed')
    expect(classifyHostBinaries(() => false, false, true).acme).toBe('passed')
  })

  it('passes PowerDNS, backups and systemd from the paths this server already has', () => {
    const present = new Set(['/usr/bin/pdnsutil', '/var/lib/xpanel', '/usr/bin/systemctl', '/proc/loadavg'])
    const probes = classifyHostBinaries(path => present.has(path), false)
    expect(probes.pdns).toBe('passed')
    expect(probes.backups).toBe('passed')
    expect(probes.systemd).toBe('passed')
    expect(probes['host-info']).toBe('failed')
    expect(classifyHostBinaries(path => path === '/usr/sbin/pdns_server', false).pdns).toBe('passed')
  })

  it('passes host info only after the measurements were read, and fails ACME when nginx cannot traverse', () => {
    const present = new Set(['/proc/loadavg', '/proc/meminfo'])
    expect(classifyHostBinaries(path => present.has(path), false, true)['host-info']).toBe('failed')
    expect(classifyHostBinaries(path => present.has(path), false, true, { hostInfo: true })['host-info']).toBe('passed')
    expect(classifyHostBinaries(() => false, false, true).acme).toBe('passed')
    expect(classifyHostBinaries(() => false, false, true, { acmeReachable: false }).acme).toBe('failed')
  })

  it('fails host info when the reader is denied and passes it when both files parse', async () => {
    const denied = await readHostMeasurements({
      readFile: async () => { throw new Error('allowlist denied') },
      runCommand: async () => ({ ok: true }),
    })
    expect(denied.hostInfo).toBe(false)
    expect(classifyHostBinaries(() => true, true, true, denied)['host-info']).toBe('failed')
    const readable = await readHostMeasurements({
      readFile: async (path) => path.endsWith('loadavg')
        ? '0.10 0.20 0.30 1/100 10\n'
        : 'MemTotal: 2048 kB\nMemAvailable: 1024 kB\n',
      runCommand: async () => ({ ok: false }),
    })
    expect(readable.hostInfo).toBe(true)
    expect(readable.acmeReachable).toBe(false)
    expect(parseLoadavg('0.10 0.20 0.30 1/100 10').load1).toBeCloseTo(0.1)
    expect(parseMeminfo('MemTotal: 2048 kB\nMemAvailable: 1024 kB\n').totalBytes).toBe(2048 * 1024)
  })

  it('lets the production matcher read loadavg and meminfo and refuses every other proc path', async () => {
    const match = createProductionHostTargetMatcher()
    expect(match('/proc/loadavg', 'read')).toBe(true)
    expect(match('/proc/meminfo', 'read')).toBe(true)
    expect(match('/proc/uptime', 'read')).toBe(true)
    expect(match('/etc/os-release', 'read')).toBe(true)
    expect(match('/proc/loadavg', 'write')).toBe(false)
    expect(match('/proc/uptime', 'write')).toBe(false)
    expect(match('/etc/os-release', 'write')).toBe(false)
    expect(match('/etc/passwd', 'read')).toBe(false)
    expect(match('/etc/opendkim/keys/demo.example.test/xp202610.private', 'write')).toBe(true)
    expect(match('/etc/opendkim.conf', 'write')).toBe(true)
    expect(match('/etc/opendkim.conf.bak.20261024T000000Z', 'read')).toBe(true)
    expect(match('/var/spool/postfix/opendkim', 'ensure-directory')).toBe(true)
    expect(match('/var/spool/postfix/opendkim', 'write')).toBe(false)
    expect(match('/var/spool/postfix/etc', 'write')).toBe(false)
    expect(match('/proc/cpuinfo', 'read')).toBe(true)
    expect(match('/proc/cpuinfo', 'write')).toBe(false)
    expect(match('/proc/self/mountinfo', 'read')).toBe(true)
    expect(match('/proc/self/mountinfo', 'write')).toBe(false)
    expect(match('/proc/self/mountinfo', 'remove')).toBe(false)
    expect(match('/proc/1/mountinfo', 'read')).toBe(false)
    expect(match('/proc/stat', 'read')).toBe(false)
    expect(match('/etc/xpanel/runtime.env', 'read')).toBe(true)
    expect(match('/etc/xpanel/runtime.env', 'write')).toBe(true)
    expect(match('/etc/xpanel/runtime.env.bak.20261024T000000Z', 'write')).toBe(true)
    expect(match('/etc/xpanel/api.env', 'read')).toBe(true)
    expect(match('/etc/xpanel/api.env', 'write')).toBe(false)
    expect(match('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control', 'read')).toBe(true)
    expect(match('/sys/fs/cgroup/cgroup.subtree_control', 'read')).toBe(true)
    expect(match('/sys/fs/cgroup/cgroup.subtree_control', 'write')).toBe(false)
    const maildir = '/home/alice/mail/alice.example.com/ftp_and_mail'
    expect(MAILDIR_BOX_RE.test(maildir)).toBe(true)
    expect(match(maildir, 'remove')).toBe(true)
    expect(match(maildir, 'read')).toBe(false)
    expect(match(`${maildir}/cur`, 'remove')).toBe(false)
    expect(match('/home/alice/public_html/index.php', 'remove')).toBe(false)
    if (process.platform !== 'linux') return
    const executor = new LinuxHostExecutor({ trustedHostTargetMatcher: match })
    const load = await executor.readFile('/proc/loadavg')
    const memory = await executor.readFile('/proc/meminfo')
    expect(load).toBeTruthy()
    expect(parseLoadavg(load!).load1).toBeGreaterThanOrEqual(0)
    expect(parseMeminfo(memory!).totalBytes).toBeGreaterThan(0)
    const cpu = await executor.readFile('/proc/cpuinfo')
    expect(cpu).toContain('processor')
    await expect(executor.readFile('/proc/stat')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
