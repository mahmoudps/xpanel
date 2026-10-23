import { describe, expect, it } from 'vitest'
import { classifyHostBinaries } from './host-probes.ts'

describe('host capability probes', () => {
  it('passes a probe only when its binary is present', () => {
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

  it('passes PowerDNS, backups, systemd and host info from the paths this server already has', () => {
    const present = new Set(['/usr/bin/pdnsutil', '/var/lib/xpanel', '/usr/bin/systemctl', '/proc/loadavg'])
    const probes = classifyHostBinaries(path => present.has(path), false)
    expect(probes.pdns).toBe('passed')
    expect(probes.backups).toBe('passed')
    expect(probes.systemd).toBe('passed')
    expect(probes['host-info']).toBe('passed')
    expect(classifyHostBinaries(path => path === '/usr/sbin/pdns_server', false).pdns).toBe('passed')
  })
})
