import { describe, expect, it } from 'vitest'
import { debianOs as os } from './testkit.ts'
import { domainForwardsFile, panelTlsPolicyFile } from '../edge/domain-forwarding.ts'
import { renderSystemAliases } from './aliases.ts'
import { renderResolvConf } from './resolver.ts'

describe('server operation renderers', { tags: ['unit'] }, () => {
  it('writes the saved resolvers in order and keeps search and options', () => {
    const file = renderResolvConf(['192.0.2.2', '192.0.2.1', '2001:db8::1'], 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch example.net\n# comment\n')
    expect(file.content.split('\n').filter(line => line.startsWith('nameserver'))).toEqual(['nameserver 192.0.2.2', 'nameserver 192.0.2.1', 'nameserver 2001:db8::1'])
    expect(file.content).toContain('options edns0 trust-ad\nsearch example.net\n')
    expect(file.content).not.toContain('127.0.0.53')
  })

  it('replaces only the system users in aliases and is stable on a second render', () => {
    const live = '# See man 5 aliases\npostmaster: root\nroot: ubuntu\nnobody:root\nwebmaster: root\n'
    const first = renderSystemAliases({ root: 'admin@example.net', nobody: 'root', xpanel: null }, live)
    expect(first.file.content).toBe('# See man 5 aliases\npostmaster: root\nwebmaster: root\n# xpanel-system-mail-begin\nroot: admin@example.net\nnobody: root\n# xpanel-system-mail-end\n')
    expect(renderSystemAliases({ root: 'admin@example.net', nobody: 'root', xpanel: null }, first.file.content).file.content).toBe(first.file.content)
    expect(renderSystemAliases({ root: null, nobody: null, xpanel: null }, first.file.content).file.content).toBe('# See man 5 aliases\npostmaster: root\nwebmaster: root\n# xpanel-system-mail-begin\n# xpanel-system-mail-end\n')
    expect(first.action).toEqual({ kind: 'exec', argv: ['/usr/bin/newaliases'] })
  })

  it('renders one 301 server per forward on its own address', () => {
    const file = domainForwardsFile([{ domain: 'example.org', url: 'https://example.net/landing', ip: '192.0.2.3', createdAt: '2026-11-07T00:00:00.000Z' }], os)
    expect(file.content).toContain('listen 192.0.2.3:80;\n    server_name example.org;')
    expect(file.content).toContain('return 301 "https://example.net/landing";')
  })

  it('renders the panel TLS policy with the lifecycle marker', () => {
    const file = panelTlsPolicyFile({ protocols: ['TLSv1.3'], ciphers: 'HIGH:!aNULL' })
    expect(file.content).toBe('# Managed by xPanel management TLS lifecycle v1.\nssl_protocols TLSv1.3;\nssl_ciphers HIGH:!aNULL;\nssl_prefer_server_ciphers on;\n')
    expect(() => panelTlsPolicyFile({ protocols: [], ciphers: 'HIGH' })).toThrow()
  })
})
