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
})
