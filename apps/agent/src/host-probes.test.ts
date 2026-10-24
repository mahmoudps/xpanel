import { describe, expect, it } from 'vitest'
import { createProductionHostTargetMatcher, LinuxHostExecutor, MAILDIR_BOX_RE } from './executor.ts'
import { parseLoadavg, parseMeminfo } from './host-info.ts'
import { classifyHostBinaries, probeAuditLog, readHostMeasurements } from './host-probes.ts'

describe('host capability probes', () => {
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
    expect(match('/proc/cpuinfo', 'read')).toBe(true)
    expect(match('/proc/cpuinfo', 'write')).toBe(false)
    expect(match('/proc/stat', 'read')).toBe(false)
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
