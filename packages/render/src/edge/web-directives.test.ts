import { describe, expect, it } from 'vitest'
import { defaultServerWebSettings } from '@xpanel/core'
import type { ServerWebSettings } from '@xpanel/core'
import { renderApacheBase, renderApachePostVhostInclude } from './apache.ts'
import { renderNginxMain } from './nginx-main.ts'
import { codeOf, debianOs, rhelOs, settings } from './testkit.ts'

const web = (change: Partial<ServerWebSettings> = {}): ServerWebSettings => ({ ...defaultServerWebSettings(), ...change })
const lines = (text: string): string[] => text.split('\n').map(line => line.trim())

describe('web stack directives', { tags: ['unit'] }, () => {
  it('renders the long-standing values while nothing is saved', () => {
    const nginx = lines(renderNginxMain(settings(), debianOs).content)
    for (const line of ['client_max_body_size 128m;', 'ssl_protocols TLSv1.2 TLSv1.3;', 'ssl_ciphers HIGH:!aNULL:!MD5;', 'gzip on;', 'gzip_comp_level 1;', 'proxy_read_timeout 300s;', 'proxy_send_timeout 300s;']) expect(nginx).toContain(line)
    const apache = lines(renderApacheBase(settings(), debianOs).content)
    expect(apache).toContain('Timeout 300')
    expect(apache).toContain('DirectoryIndex index.php index.html index.htm')
    expect(apache.some(line => line.startsWith('RLimit'))).toBe(false)
    expect(renderApachePostVhostInclude(settings(), debianOs)).toBeNull()
  })

  it('renders saved Global Configuration, compression, DirectoryIndex order and memory limits', () => {
    const saved = settings({ web: web({ timeoutSec: 90, clientMaxBodyMb: 512, tlsProtocols: ['TLSv1.3'], tlsCiphers: 'ECDHE-ECDSA-AES128-GCM-SHA256', gzip: { enabled: true, level: 6 },
      directoryIndex: ['index.html', 'index.php', 'default.htm'], rlimitMemMb: 512, rlimitCpuSec: 240 }) })
    const nginx = lines(renderNginxMain(saved, debianOs).content)
    for (const line of ['client_max_body_size 512m;', 'ssl_protocols TLSv1.3;', 'ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256;', 'gzip_comp_level 6;', 'proxy_read_timeout 90s;']) expect(nginx).toContain(line)
    const apache = lines(renderApacheBase(saved, rhelOs).content)
    for (const line of ['Timeout 90', 'DirectoryIndex index.html index.php default.htm', 'RLimitMEM 536870912', 'RLimitCPU 240']) expect(apache).toContain(line)
    const off = lines(renderNginxMain(settings({ web: web({ gzip: { enabled: false, level: 6 } }) }), debianOs).content)
    expect(off).toContain('gzip off;')
    expect(off.some(line => line.startsWith('gzip_comp_level'))).toBe(false)
  })

  it('places Include Editor text at its insertion points', () => {
    const saved = settings({ web: web({ includes: { apachePreMain: 'Define XPANEL_PRE_MAIN', apachePreVhost: 'TraceEnable Off\r\nServerSignature Off\n', apachePostVhost: '<Location "/server-status">\n    Require local\n</Location>', nginxHttp: 'server_tokens off;' } }) })
    const nginx = renderNginxMain(saved, debianOs).content
    expect(nginx.indexOf('# Include Editor: http')).toBeGreaterThan(-1)
    expect(nginx.indexOf('server_tokens off;', nginx.indexOf('# Include Editor: http'))).toBeLessThan(nginx.indexOf('include /etc/nginx/conf.d/*.conf;'))
    const base = renderApacheBase(saved, debianOs).content
    expect(base.indexOf('Define XPANEL_PRE_MAIN')).toBeLessThan(base.indexOf('Listen 127.0.0.1:'))
    expect(base.indexOf('# Include Editor: pre-vhost')).toBeGreaterThan(base.indexOf('DirectoryIndex'))
    expect(base.indexOf('TraceEnable Off\nServerSignature Off\n\n# first vhost')).toBeGreaterThan(base.indexOf('# Include Editor: pre-vhost'))
    expect(base).not.toContain('\r')
    const post = renderApachePostVhostInclude(saved, debianOs)!
    expect(post.path).toBe('/etc/apache2/sites-enabled/zzz-xpanel-post-vhost.conf')
    expect(post.content).toBe('# Managed by xPanel: Include Editor post-vhost text\n# Include Editor: post-vhost\n<Location "/server-status">\n    Require local\n</Location>\n')
  })

  it('validates saved directives again before rendering them', () => {
    expect(codeOf(() => renderNginxMain(settings({ web: { ...web(), tlsCiphers: 'HIGH; include /etc/shadow' } }), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheBase(settings({ web: { ...web(), directoryIndex: ['../index.php'] } }), debianOs))).toBe('VALIDATION')
  })
})
