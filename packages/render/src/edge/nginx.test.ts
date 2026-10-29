import { describe, expect, it } from 'vitest'
import { admitTrustedProxyRenderPolicy } from '../../../core/src/trusted-proxies.ts'
import type { TrustedProxyRenderAuthority } from '../../../core/src/trusted-proxies.ts'
import {
  assertNginxEdgeHeaderSanitization,
  defaultSiteFile,
  nginxConfigTest,
  nginxEdgeDirs,
  nginxSiteFile,
  renderDefaultSite,
  renderNginxMain,
  renderNginxSite,
  type EdgeSettings,
} from './nginx.ts'
import { account, blockOf, cert, codeOf, debianOs, domain, rhelOs, serverBlocks, settings } from './testkit.ts'

const edge = (e: EdgeSettings['edge']): EdgeSettings => ({ ...settings(), edge: e })

describe('renderNginxMain', () => {
  it('renders worker tuning from settings', () => {
    const f = renderNginxMain(
      settings({ nginx: { workerProcesses: 8, workerConnections: 8192, workerRlimitNofile: 100000, multiAccept: false, keepaliveTimeoutSec: 15 } }),
      debianOs,
    )
    expect(f.path).toBe('/etc/nginx/nginx.conf')
    expect(f.mode).toBe(0o644)
    expect(f.content).toContain('worker_processes 8;')
    expect(f.content).toContain('worker_rlimit_nofile 100000;')
    expect(f.content).toContain('worker_connections 8192;')
    expect(f.content).toContain('multi_accept off;')
    expect(f.content).toContain('keepalive_timeout 15s;')
  })

  it('uses auto workers, the distro nginx user and module dirs', () => {
    const deb = renderNginxMain(settings(), debianOs).content
    expect(deb).toContain('worker_processes auto;')
    expect(deb).toContain('user www-data;')
    expect(deb).toContain('include /etc/nginx/modules-enabled/*.conf;')
    expect(deb).toContain('include /etc/nginx/conf.d/*.conf;')
    const rh = renderNginxMain(settings(), rhelOs).content
    expect(rh).toContain('user nginx;')
    expect(rh).toContain('include /usr/share/nginx/modules/*.conf;')
    expect(rh).not.toContain('modules-enabled')
  })

  it('declares the response cache under /var/cache/xpanel/nginx and owns it by the nginx user', () => {
    const c = renderNginxMain(settings(), rhelOs).content
    expect(c).toMatch(/proxy_cache_path \/var\/cache\/xpanel\/nginx levels=1:2 keys_zone=xpanel_cache:64m max_size=1024m/)
    const dirs = nginxEdgeDirs(rhelOs)
    expect(dirs).toContainEqual({ kind: 'ensure-dir', path: '/var/cache/xpanel/nginx', mode: 0o700, owner: 'nginx', group: 'nginx' })
    expect(dirs.some((d) => d.kind === 'ensure-dir' && d.path === '/var/lib/xpanel/acme')).toBe(true)
  })

  it('sizes the server-name hash for the longest legal domain', () => {
    const c = renderNginxMain(settings(), debianOs).content
    const bucket = Number(/server_names_hash_bucket_size (\d+);/.exec(c)?.[1])
    // nginx stores each name plus a pointer in one bucket; a 253-char name must fit
    expect(bucket).toBeGreaterThanOrEqual(253 + 8)
  })

  it('logs metrics as JSON with host, status, bytes and request time to xPanel log dir', () => {
    const c = renderNginxMain(settings(), debianOs).content
    expect(c).toContain('log_format xpanel_metrics escape=json')
    for (const v of ['$host', '$status', '$body_bytes_sent', '$bytes_sent', '$request_time', '$upstream_cache_status']) {
      expect(c).toContain(v)
    }
    expect(c).toContain('access_log /var/log/xpanel/nginx/access.log xpanel_metrics;')
    expect(c).not.toContain('/home')
  })

  it('trusts no client-IP header without protected process-local canonical authority', () => {
    expect(renderNginxMain(settings(), debianOs).content).not.toContain('set_real_ip_from')
    const policy = { cidrs: ['173.245.48.0/20', '2400:cb00::/32'], header: 'X-Forwarded-For' as const }
    const authority = admitTrustedProxyRenderPolicy(policy, { kind: 'protected-dedicated-ingress-v1', localAddresses: ['127.0.0.1', '192.0.2.1'], managementClient: '198.51.100.50', dedicatedCidrs: policy.cidrs })
    const c = renderNginxMain(settings(), debianOs, authority).content
    expect(c).toContain('set_real_ip_from 173.245.48.0/20;')
    expect(c).toContain('set_real_ip_from 2400:cb00::/32;')
    expect(c).toContain('real_ip_header X-Forwarded-For;')
    expect(c).toContain('real_ip_recursive off;')
    expect(codeOf(() => renderNginxMain(settings(), debianOs, { kind: 'trusted-proxy-render-authority' } as TrustedProxyRenderAuthority))).toBe('PRECONDITION_FAILED')
    expect(codeOf(() => renderNginxMain(edge({ trustedProxies: policy.cidrs, realIpHeader: 'CF-Connecting-IP' }), debianOs))).toBe('VALIDATION')
  })
  it('rejects bad proxies and headers', () => {
    expect(codeOf(() => renderNginxMain(edge({ trustedProxies: ['1.2.3.4; evil'] }), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxMain(edge({ trustedProxies: ['10.0.0.0/8'], realIpHeader: 'X-A;b' }), debianOs))).toBe('VALIDATION')
  })

  it('always defines the WAF variables site files reference', () => {
    const c = renderNginxMain(settings(), debianOs).content
    for (const v of ['$xpanel_waf_deny_ip', '$xpanel_waf_deny_ua', '$xpanel_waf_deny_path', '$xpanel_waf_key']) expect(c).toContain(v)
    expect(c).not.toContain('modsecurity')
  })

  it('wires ModSecurity only when settings say it is present', () => {
    const c = renderNginxMain(edge({ modsecurity: { engineConf: '/etc/nginx/modsec/modsecurity.conf', crsDir: '/usr/share/modsecurity-crs' } }), debianOs).content
    expect(c).toContain('modsecurity on;')
    expect(c).toContain('modsecurity_rules_file /etc/xpanel/modsecurity/main.conf;')
  })

  it('validates worker numbers', () => {
    const bad = (n: Partial<ReturnType<typeof settings>['nginx']>) =>
      codeOf(() => renderNginxMain(settings({ nginx: { ...settings().nginx, ...n } }), debianOs))
    expect(bad({ workerProcesses: 0 })).toBe('VALIDATION')
    expect(bad({ workerConnections: 10 })).toBe('VALIDATION')
    expect(bad({ workerConnections: 70000, workerRlimitNofile: 65535 })).toBe('VALIDATION')
    expect(bad({ keepaliveTimeoutSec: -1 })).toBe('VALIDATION')
    expect(bad({ workerRlimitNofile: 1048577 })).toBe('VALIDATION')
    // every proxied connection holds a client and an upstream descriptor
    expect(bad({ workerConnections: 4096, workerRlimitNofile: 8191 })).toBe('VALIDATION')
    expect(bad({ workerConnections: 524288, workerRlimitNofile: 1048576 })).toBeNull()
  })

  it('rejects a hostile nginx user from the profile', () => {
    const os = { ...debianOs, paths: { ...debianOs.paths, nginxUser: 'www-data; daemon off' } }
    expect(codeOf(() => renderNginxMain(settings(), os))).toBe('VALIDATION')
  })

  it('builds a config test argv without a shell, with the profile binary when it names one', () => {
    expect(nginxConfigTest(debianOs).argv).toEqual(['nginx', '-t', '-q', '-c', '/etc/nginx/nginx.conf'])
    const withBin = { ...rhelOs, bin: { nginx: '/usr/sbin/nginx' } }
    expect(nginxConfigTest(withBin).argv[0]).toBe('/usr/sbin/nginx')
    const hostile = { ...rhelOs, bin: { nginx: 'nginx; reboot' } }
    expect(codeOf(() => nginxConfigTest(hostile))).toBe('VALIDATION')
  })
})

describe('renderNginxSite', () => {
  const a = account()

  it('proxies to the loopback backend preserving host and client address', () => {
    const c = renderNginxSite(a, [domain()], settings())
    expect(c).toContain('listen 80;')
    expect(c).toContain('server_name example.com www.example.com;')
    expect(c).toContain('proxy_pass http://127.0.0.1:8080;')
    expect(c).toContain('proxy_set_header Host $host;')
    expect(c).toContain('proxy_set_header X-Real-IP $remote_addr;')
    expect(c).toContain('proxy_set_header X-Forwarded-For $remote_addr;')
    expect(c).toContain('proxy_set_header Forwarded "";')
    expect(c).not.toContain('$proxy_add_x_forwarded_for')
    expect(c).toContain('proxy_set_header X-Forwarded-Proto $scheme;')
    expect(c).toContain('access_log /var/log/xpanel/nginx/example.com.access.log xpanel_metrics;')
    expect(c).not.toContain('listen 443')
  })

  it('never lets nginx open the home: no root/alias into /home or the account home anywhere', () => {
    const doms = [
      domain(),
      domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', parentId: 'd1', docRoot: '/home/alice/public_html/blog' }),
      domain({ id: 'd3', name: 'shop.example', kind: 'addon', docRoot: '/home/alice/shop', siteType: 'static' }),
      domain({ id: 'd4', name: 'old.example', kind: 'addon', docRoot: '/home/alice/old', redirect: { to: 'https://example.com/', code: 301 } }),
      domain({ id: 'd5', name: 'off.example', kind: 'addon', docRoot: '/home/alice/off', suspended: true }),
      domain({ id: 'd6', name: 'app.example', kind: 'addon', docRoot: '/home/alice/app', siteType: 'node', upstream: 'http://127.0.0.1:3000' }),
    ]
    for (const acc of [a, account({ status: 'suspended' })]) {
      const c = renderNginxSite(acc, doms, settings(), cert(), { forceHttps: true })
      expect(c).not.toMatch(/\b(root|alias)\s+\/home/)
      expect(c).not.toContain(acc.home)
      expect(c).not.toContain('/home/')
      for (const m of c.matchAll(/\b(?:root|alias)\s+(\S+);/g)) {
        expect(['/var/lib/xpanel/acme/', '/usr/share/xpanel/suspended']).toContain(m[1])
      }
    }
  })

  it('strips the httpoxy Proxy header before the backend sees it', () => {
    for (const d of [domain(), domain({ siteType: 'node', upstream: 'http://127.0.0.1:3000' })]) {
      expect(renderNginxSite(a, [d], settings())).toContain('proxy_set_header Proxy "";')
    }
  })

  it('serves ACME http-01 from the xPanel-owned dir on every site, even redirects and suspended', () => {
    const c = renderNginxSite(
      a,
      [domain({ redirect: { to: 'https://elsewhere.example/', code: 302 } }), domain({ id: 'd2', name: 'off.example', kind: 'addon', docRoot: '/home/alice/off', suspended: true })],
      settings(),
    )
    for (const b of serverBlocks(c)) {
      expect(b).toContain('location ^~ /.well-known/acme-challenge/ {')
      expect(b).toContain('alias /var/lib/xpanel/acme/;')
      // try_files resolves $uri against an alias inconsistently; the alias alone is enough
      expect(blockOf(b, 'location ^~ /.well-known/acme-challenge/')).not.toContain('try_files')
    }
  })

  it('adds *.name for wildcard domains and keeps explicit subdomains in their own block', () => {
    const c = renderNginxSite(
      a,
      [domain({ wildcard: true }), domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', parentId: 'd1', docRoot: '/home/alice/public_html/blog' })],
      settings(),
    )
    const blocks = serverBlocks(c)
    expect(blocks).toHaveLength(2)
    const main = blocks.find((b) => b.includes('server_name example.com'))
    const sub = blocks.find((b) => b.includes('server_name blog.example.com'))
    expect(main).toContain('server_name example.com www.example.com *.example.com;')
    // exact name in a separate block: nginx prefers exact names over wildcards
    expect(sub).toContain('server_name blog.example.com www.blog.example.com;')
    expect(sub).not.toContain('*.')
    expect(main).not.toContain('blog.example.com')
  })

  it('does not add www.<name> when that name is an explicit domain', () => {
    const c = renderNginxSite(
      a,
      [domain(), domain({ id: 'd2', name: 'www.example.com', kind: 'subdomain', parentId: 'd1', docRoot: '/home/alice/public_html/www' })],
      settings(),
    )
    expect(c).toContain('server_name example.com;')
    expect(c).toContain('server_name www.example.com;')
  })

  it('puts alias (parked) domains in the parent server_name', () => {
    const c = renderNginxSite(
      a,
      [domain(), domain({ id: 'd2', name: 'example.net', kind: 'alias', parentId: 'd1', docRoot: '/home/alice/public_html', wildcard: true })],
      settings(),
    )
    expect(serverBlocks(c)).toHaveLength(1)
    expect(c).toContain('server_name example.com www.example.com example.net www.example.net *.example.net;')
  })

  it('renders a 443 http2 block with the covering wildcard certificate', () => {
    const c = renderNginxSite(a, [domain({ wildcard: true }), domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', docRoot: '/home/alice/public_html/blog' })], settings(), [cert()])
    const blocks = serverBlocks(c)
    expect(blocks).toHaveLength(4)
    const tls = blocks.filter((b) => b.includes('listen 443 ssl http2;'))
    expect(tls).toHaveLength(2)
    for (const b of tls) {
      expect(b).toContain('listen [::]:443 ssl http2;')
      expect(b).toContain('ssl_certificate /etc/xpanel/ssl/cert1/fullchain.pem;')
      expect(b).toContain('ssl_certificate_key /etc/xpanel/ssl/cert1/privkey.pem;')
    }
  })

  it('prefers the domain certificateId and notes a missing one', () => {
    const own = cert({ id: 'own2', names: ['example.com'] })
    const c = renderNginxSite(a, [domain({ certificateId: 'own2' })], settings(), [cert(), own])
    expect(c).toContain('ssl_certificate /etc/xpanel/ssl/own2/fullchain.pem;')
    const missing = renderNginxSite(a, [domain({ certificateId: 'gone' })], settings(), [])
    expect(missing).not.toContain('listen 443')
    expect(missing).toContain('# tls: certificate gone of example.com was not supplied')
  })

  it('serves each parked domain with the certificate that covers it', () => {
    const own = cert({ id: 'main', names: ['example.com', 'www.example.com'] })
    const parked = cert({ id: 'parked', names: ['example.net', 'www.example.net'] })
    const c = renderNginxSite(
      a,
      [domain({ certificateId: 'main' }), domain({ id: 'd2', name: 'example.net', kind: 'alias', parentId: 'd1', certificateId: 'parked' }), domain({ id: 'd3', name: 'example.org', kind: 'alias', parentId: 'd1' })],
      settings(),
      [own, parked],
    )
    const tls = serverBlocks(c).filter((b) => b.includes('listen 443'))
    expect(tls).toHaveLength(2)
    const byCert = (id: string) => tls.find((b) => b.includes(`/etc/xpanel/ssl/${id}/fullchain.pem`)) ?? ''
    expect(byCert('main')).toContain('server_name example.com www.example.com;')
    expect(byCert('parked')).toContain('server_name example.net www.example.net;')
    // no certificate covers example.org: it is never served with a mismatched one
    expect(tls.some((b) => b.includes('example.org'))).toBe(false)
    const [http] = serverBlocks(c)
    expect(http).toContain('server_name example.com www.example.com example.net www.example.net example.org www.example.org;')
  })

  it('never serves an assigned certificate for names it does not cover', () => {
    const c = renderNginxSite(a, [domain({ certificateId: 'narrow' })], settings(), [cert({ id: 'narrow', names: ['other.example'] })])
    expect(c).not.toContain('listen 443')
  })

  it('forces HTTPS only for names that have a certificate', () => {
    const c = renderNginxSite(
      a,
      [domain(), domain({ id: 'd2', name: 'example.org', kind: 'alias', parentId: 'd1' })],
      settings(),
      cert(),
      { forceHttps: true },
    )
    const http = serverBlocks(c).filter((b) => b.includes('listen 80;'))
    expect(http).toHaveLength(2)
    const redirect = http.find((b) => b.includes('return 301 https://'))
    const plain = http.find((b) => b.includes('proxy_pass'))
    expect(redirect).toContain('server_name example.com www.example.com;')
    expect(plain).toContain('server_name example.org www.example.org;')
  })

  it('never installs another account certificate, but accepts root-owned ones', () => {
    expect(renderNginxSite(a, [domain()], settings(), cert({ accountId: 'acc2' }))).not.toContain('listen 443')
    expect(renderNginxSite(a, [domain()], settings(), cert({ accountId: null }))).toContain('listen 443 ssl http2;')
  })

  it('supports the http2 directive style and IPv4-only listeners', () => {
    const c = renderNginxSite(a, [domain()], edge({ http2: 'directive', ipv6: false }), cert())
    expect(c).toContain('listen 443 ssl;')
    expect(c).toContain('http2 on;')
    expect(c).not.toContain('[::]')
  })

  it('forces HTTPS while keeping ACME on port 80', () => {
    const c = renderNginxSite(a, [domain()], settings(), cert(), { forceHttps: true })
    const [http] = serverBlocks(c)
    expect(http).toContain('listen 80;')
    expect(http).toContain('return 301 https://$host$request_uri;')
    expect(http).toContain('/.well-known/acme-challenge/')
    expect(http).not.toContain('proxy_pass')
  })

  it('renders redirects as return 301/302', () => {
    const c = renderNginxSite(a, [domain({ redirect: { to: 'https://new.example/path?x=1', code: 302 } })], settings())
    expect(c).toContain('return 302 "https://new.example/path?x=1";')
    expect(c).not.toContain('proxy_pass')
  })

  it('serves the static suspended page for suspended accounts, domains and expired sites', () => {
    const cases = [
      renderNginxSite(account({ status: 'suspended' }), [domain()], settings()),
      renderNginxSite(account({ status: 'terminating' }), [domain()], settings()),
      renderNginxSite(a, [domain({ suspended: true })], settings()),
      renderNginxSite(a, [domain({ expiresAt: '2026-01-01T00:00:00Z' })], settings(), null, { now: '2026-10-22T00:00:00Z' }),
    ]
    for (const c of cases) {
      expect(c).toContain('root /usr/share/xpanel/suspended;')
      expect(c).toContain('return 503;')
      expect(c).not.toContain('proxy_pass')
    }
    const notYet = renderNginxSite(a, [domain({ expiresAt: '2027-01-01T00:00:00Z' })], settings(), null, { now: '2026-10-22T00:00:00Z' })
    expect(notYet).toContain('proxy_pass')
  })

  it('stops expired sites even when the caller passes no time, and fails closed on a bad expiry', () => {
    for (const expiresAt of ['2020-01-01T00:00:00Z', 'not a date']) {
      const c = renderNginxSite(a, [domain({ expiresAt })], settings())
      expect(c).toContain('return 503;')
      expect(c).not.toContain('proxy_pass')
    }
  })

  it('caches responses only, keyed by host, bypassing cookies, POST and auth', () => {
    const c = renderNginxSite(a, [domain()], settings())
    expect(c).toContain('proxy_cache xpanel_cache;')
    expect(c).toContain('proxy_cache_key $scheme$host$request_uri;')
    expect(c).toContain('proxy_cache_bypass $xpanel_nocache_method $xpanel_nocache_cookie $http_authorization;')
    expect(c).toContain('$upstream_http_set_cookie')
    expect(c).not.toContain('proxy_ignore_headers')
    expect(c).not.toContain('proxy_cache_valid')
    expect(renderNginxSite(a, [domain()], settings(), null, { cache: false })).not.toContain('proxy_cache ')
  })

  it('applies a default client_max_body_size and the edge override', () => {
    expect(renderNginxSite(a, [domain()], settings())).toContain('client_max_body_size 128m;')
    expect(renderNginxSite(a, [domain()], edge({ clientMaxBodyMb: 512 }))).toContain('client_max_body_size 512m;')
    expect(renderNginxSite(a, [domain()], edge({ clientMaxBodyMb: 'unlimited' }))).toContain('client_max_body_size 0;')
  })

  it('proxies node/python apps to their loopback upstream directly', () => {
    const c = renderNginxSite(a, [domain({ siteType: 'node', upstream: 'http://127.0.0.1:3000' })], settings())
    expect(c).toContain('proxy_pass http://127.0.0.1:3000;')
    expect(c).not.toContain('127.0.0.1:8080')
    const withPath = renderNginxSite(a, [domain({ siteType: 'proxy', upstream: 'http://203.0.113.5:8000/app' })], settings())
    expect(withPath).toContain('proxy_pass http://203.0.113.5:8000/app/;')
    const v6 = renderNginxSite(a, [domain({ siteType: 'python', upstream: 'http://[::1]:5000' })], settings())
    expect(v6).toContain('proxy_pass http://[::1]:5000;')
  })

  it('resolves hostname upstreams per request and only with configured resolvers', () => {
    const d = domain({ siteType: 'proxy', upstream: 'https://origin.example.org/base' })
    expect(codeOf(() => renderNginxSite(a, [d], settings()))).toBe('VALIDATION')
    const c = renderNginxSite(a, [d], edge({ resolvers: ['127.0.0.53', '::1'] }))
    expect(c).toContain('resolver 127.0.0.53 [::1] valid=300s;')
    expect(c).toContain('proxy_pass https://origin.example.org:443/base$request_uri;')
    expect(c).toContain('proxy_ssl_server_name on;')
  })

  it('rejects SSRF-style and reserved upstreams', () => {
    const bad = (upstream: string, siteType: 'proxy' | 'node' = 'proxy') =>
      codeOf(() => renderNginxSite(a, [domain({ siteType, upstream })], settings()))
    expect(bad('http://169.254.169.254/latest')).toBe('VALIDATION')
    expect(bad('http://[::ffff:169.254.169.254]:80')).toBe('VALIDATION')
    expect(bad('http://[fe80::1]:80')).toBe('VALIDATION')
    expect(bad('http://0.0.0.0:3000')).toBe('VALIDATION')
    expect(bad('http://10.0.0.5:80')).toBe('VALIDATION')
    expect(bad('http://203.0.113.5:3000', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.1:8080', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.1:2087', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.1:80', 'node')).toBe('VALIDATION')
    expect(bad('http://user:pw@127.0.0.1:3000', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.1:3000/a;proxy_pass http://x', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.1:3000$request_uri', 'node')).toBe('VALIDATION')
    expect(bad('http://127.0.0.01:3000', 'node')).toBe('VALIDATION')
    // loopback service ports: the edge must never relay public requests to MariaDB, Redis, PostgreSQL ...
    for (const port of [3306, 5432, 6379, 11211, 8081]) expect(bad(`http://127.0.0.1:${port}`, 'node')).toBe('VALIDATION')
    expect(bad('http://localhost:6379')).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain({ siteType: 'node', upstream: 'http://127.0.0.1:9000' })], settings(), null, { reservedPorts: [9000] }))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain({ siteType: 'node', upstream: null })], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain({ siteType: 'proxy', upstream: 'http://10.0.0.5:80' })], settings(), null, { allowPrivateUpstreams: true }))).toBeNull()
  })

  it('rejects injection attempts in server names', () => {
    const names = ['example.com; return 200', 'example.com\nserver_name evil', 'EXAMPLE.com', '*.example.com', 'example', '-a.example.com', 'a..b.com', 'exa mple.com', 'example.com{', 'münchen.de', 'example.com.', 'example.0x7f']
    for (const name of names) expect(codeOf(() => renderNginxSite(a, [domain({ name })], settings()))).toBe('VALIDATION')
  })

  it('rejects redirect targets that could break out or interpolate', () => {
    for (const to of ['https://x.example/"; return 200 "', 'https://x.example/$request_uri', 'javascript:alert(1)', 'https://x.example/ a', 'https://x.example/\n', '//x.example/', 'https://x.example/{a}']) {
      expect(codeOf(() => renderNginxSite(a, [domain({ redirect: { to, code: 301 } })], settings()))).toBe('VALIDATION')
    }
    expect(codeOf(() => renderNginxSite(a, [domain({ redirect: { to: 'https://x.example/', code: 307 as 301 } })], settings()))).toBe('VALIDATION')
  })

  it('rejects docroots outside the home even though nginx never uses them', () => {
    for (const docRoot of ['/home/bob/public_html', '/home/alice', '/home/alice/../bob', '/etc', '/home/alice/.ssh', '/home/alice/tmp/x', '/home/alice/public_html;']) {
      expect(codeOf(() => renderNginxSite(a, [domain({ docRoot })], settings()))).toBe('VALIDATION')
    }
  })

  it('rejects foreign domains, duplicate names and dangling aliases', () => {
    expect(codeOf(() => renderNginxSite(a, [domain({ accountId: 'other' })], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain(), domain({ id: 'd2', kind: 'addon' })], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain({ id: 'd2', name: 'x.example', kind: 'alias', parentId: 'nope' })], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain(), domain({ id: 'd1', name: 'y.example', kind: 'addon', docRoot: '/home/alice/y' })], settings()))).toBe('VALIDATION')
  })

  it('rejects hostile accounts and certificate ids', () => {
    expect(codeOf(() => renderNginxSite(account({ username: 'root' }), [domain()], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(account({ uid: 0 }), [domain()], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(account({ home: '/etc/alice' }), [domain()], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain({ certificateId: '../../etc/passwd' })], settings()))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain()], settings(), cert({ id: 'x/../../y' })))).toBe('VALIDATION')
  })

  it('refuses a backend port that collides with the panel', () => {
    expect(codeOf(() => renderNginxSite(a, [domain()], settings({ backendPort: 2087 })))).toBe('VALIDATION')
    expect(codeOf(() => renderNginxSite(a, [domain()], settings({ backendPort: 80 })))).toBe('VALIDATION')
  })

  it('embeds the per-site WAF policy', () => {
    const c = renderNginxSite(a, [domain()], settings(), null, {
      waf: { 'example.com': { denyIps: ['198.51.100.0/24'], rateLimit: { requests: 10, per: 'second', burst: 20 }, maxBodyMb: 16 } },
    })
    expect(c).toMatch(/^limit_req_zone \$xpanel_waf_key zone=xpw_r_[0-9a-f]{12}:1m rate=10r\/s;$/m)
    expect(c).toContain('deny 198.51.100.0/24;')
    expect(c).toContain('client_max_body_size 16m;')
    expect(c).not.toContain('client_max_body_size 128m;')
  })

  it('writes the site file into the distro vhost dir', () => {
    const f = nginxSiteFile(a, [domain()], settings(), rhelOs)
    expect(f.path).toBe('/etc/nginx/conf.d/xpanel-alice.conf')
    expect(f.owner).toBe('root')
  })
})

describe('renderDefaultSite', () => {
  it('catches unbound names on 80 and 443 with a 404 notice', () => {
    const c = renderDefaultSite()
    expect(c).toContain('listen 80 default_server;')
    expect(c).toContain('listen 443 ssl http2 default_server;')
    expect(c).toContain('server_name _;')
    expect(c).toContain('ssl_certificate /etc/xpanel/ssl/default/fullchain.pem;')
    expect(c).toContain('root /usr/share/xpanel/default;')
    expect(c).toContain('return 404;')
    expect(c).toContain('/.well-known/acme-challenge/')
    expect(c).not.toContain('/home')
    expect(c).not.toContain('proxy_pass')
  })

  it('can reject TLS handshakes for unknown names and answer for the hostname', () => {
    const c = renderDefaultSite({ settings: edge({ sslRejectHandshake: true }) })
    expect(c).toContain('ssl_reject_handshake on;')
    expect(c).not.toContain('ssl_certificate ')
    expect(c).toContain('server_name _ server1.host.example;')
    const withCert = renderDefaultSite({ settings: edge({ sslRejectHandshake: true }), cert: cert({ id: 'host' }) })
    expect(withCert).toContain('ssl_certificate /etc/xpanel/ssl/host/fullchain.pem;')
  })

  it('is written first in the vhost dir', () => {
    expect(defaultSiteFile(debianOs).path).toBe('/etc/nginx/conf.d/000-xpanel-default.conf')
  })

  it('has balanced braces', () => {
    const c = renderDefaultSite()
    expect(blockOf(c, 'server').length).toBe(c.trimEnd().length - c.indexOf('server {'))
  })
})

describe('forwarded identity sanitization', () => {
  it('overwrites every emitted proxy location and rejects forged alternate forwarding chains', () => {
    const c = renderNginxSite(account(), [domain()], settings(), cert(), { forceHttps: true })
    const proxyCount = [...c.matchAll(/proxy_pass /g)].length
    expect(proxyCount).toBeGreaterThan(0)
    expect([...c.matchAll(/proxy_set_header X-Forwarded-For \$remote_addr;/g)]).toHaveLength(proxyCount)
    expect([...c.matchAll(/proxy_set_header Forwarded "";/g)]).toHaveLength(proxyCount)
    expect(() => assertNginxEdgeHeaderSanitization(c)).not.toThrow()
    expect(codeOf(() => assertNginxEdgeHeaderSanitization(c.replace('X-Forwarded-For $remote_addr;', 'X-Forwarded-For $proxy_add_x_forwarded_for;')))).toBe('VALIDATION')
    expect(codeOf(() => assertNginxEdgeHeaderSanitization(c + '\nproxy_set_header Forwarded $http_forwarded;'))).toBe('VALIDATION')
    expect(codeOf(() => assertNginxEdgeHeaderSanitization(c + '\nproxy_set_header x-forwarded-for $http_x_forwarded_for;'))).toBe('VALIDATION')
  })
})