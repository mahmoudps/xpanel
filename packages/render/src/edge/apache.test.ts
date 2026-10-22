import { describe, expect, it } from 'vitest'
import {
  apacheConfigTest,
  apacheMpmFile,
  cgiWrapperDirs,
  phpWiring,
  renderApacheBase,
  renderApacheMpm,
  renderApacheVhost,
  renderApacheVhosts,
  renderPhpCgiWrapper,
  requiredApacheModules,
} from './apache.ts'
import { account, codeOf, debianOs, domain, php, rhelOs, settings } from './testkit.ts'

const prefork = settings({ apacheMpm: 'prefork' })

describe('renderApacheMpm', () => {
  it('renders all prefork-family fields for itk and refuses to run without itk', () => {
    const c = renderApacheMpm(settings())
    for (const l of ['StartServers 5', 'MinSpareServers 5', 'MaxSpareServers 10', 'ServerLimit 256', 'MaxRequestWorkers 150', 'MaxConnectionsPerChild 0']) {
      expect(c).toContain(l)
    }
    expect(c).toContain('<IfModule !mpm_itk_module>')
    expect(c).toContain('Error "xPanel: mpm_itk is selected but not loaded')
    expect(c).not.toMatch(/<IfModule mpm_itk_module>/)
  })

  it('renders prefork and refuses a stray itk module', () => {
    const c = renderApacheMpm(prefork)
    expect(c).toContain('MaxRequestWorkers 150')
    expect(c).toContain('<IfModule mpm_itk_module>')
    expect(c).not.toContain('<IfModule !mpm_itk_module>')
  })

  it('adds itk UID/GID ranges on request only', () => {
    const c = renderApacheMpm(settings(), { uidRange: [1000, 60000], gidRange: [1000, 60000] })
    expect(c).toContain('LimitUIDRange 1000 60000')
    expect(c).toContain('LimitGIDRange 1000 60000')
    expect(codeOf(() => renderApacheMpm(prefork, { uidRange: [1000, 2000] }))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheMpm(settings(), { uidRange: [2000, 1000] }))).toBe('VALIDATION')
  })

  it('validates the worker relations and caps', () => {
    const bad = (a: Partial<ReturnType<typeof settings>['apache']>) =>
      codeOf(() => renderApacheMpm(settings({ apache: { ...settings().apache, ...a } })))
    expect(bad({ maxRequestWorkers: 300 })).toBe('VALIDATION')
    expect(bad({ minSpareServers: 20, maxSpareServers: 10 })).toBe('VALIDATION')
    expect(bad({ startServers: 0 })).toBe('VALIDATION')
    expect(bad({ startServers: 300 })).toBe('VALIDATION')
    expect(bad({ serverLimit: 20001, maxRequestWorkers: 150 })).toBe('VALIDATION')
    expect(bad({ maxConnectionsPerChild: -1 })).toBe('VALIDATION')
    expect(bad({ maxSpareServers: 151, minSpareServers: 5 })).toBe('VALIDATION')
    // prefork silently raises MaxSpareServers to MinSpareServers + 1; the saved value must be what runs
    expect(bad({ minSpareServers: 10, maxSpareServers: 10, startServers: 10 })).toBe('VALIDATION')
    expect(bad({ serverLimit: 20000, maxRequestWorkers: 20000 })).toBeNull()
    expect(bad({ maxRequestWorkers: 256 })).toBeNull()
  })

  it('throws ENGINE_UNAVAILABLE under OpenLiteSpeed', () => {
    expect(codeOf(() => renderApacheMpm(settings({ engine: 'openlitespeed' })))).toBe('ENGINE_UNAVAILABLE')
  })

  it('writes to the distro vhost dir', () => {
    expect(apacheMpmFile(settings(), rhelOs).path).toBe('/etc/httpd/conf.d/000-xpanel-mpm.conf')
    expect(apacheMpmFile(settings(), debianOs).path).toBe('/etc/apache2/sites-enabled/000-xpanel-mpm.conf')
  })
})

describe('renderApacheBase', () => {
  it('listens only on 127.0.0.1:<backendPort>', () => {
    const c = renderApacheBase(settings({ backendPort: 8181 }), debianOs).content
    const listens = c.split('\n').filter((l) => /^\s*Listen\b/.test(l))
    expect(listens).toEqual(['Listen 127.0.0.1:8181'])
    expect(c).not.toMatch(/Listen (80|443|\*|0\.0\.0\.0|\[::\])/)
    expect(c).toContain('<VirtualHost 127.0.0.1:8181>')
  })

  it('trusts Nginx on loopback for the client IP and HTTPS flag', () => {
    const c = renderApacheBase(settings(), rhelOs).content
    expect(c).toContain('RemoteIPHeader X-Real-IP')
    expect(c).toContain('RemoteIPInternalProxy 127.0.0.1 ::1')
    expect(c).toContain('SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on')
    expect(c).toMatch(/LogFormat "%a /)
    expect(c).toContain('CustomLog "/var/log/xpanel/apache/access.log" xpanel_vhost')
    expect(c).toContain('KeepAlive Off')
  })

  it('protects INI and htaccess files and serves a default vhost first', () => {
    const f = renderApacheBase(settings(), debianOs)
    expect(f.path).toBe('/etc/apache2/sites-enabled/000-xpanel-base.conf')
    expect(f.content).toContain(String.raw`<FilesMatch "^(\.ht.*|\.user\.ini|php\.ini)$">`)
    expect(f.content).toContain('DocumentRoot "/usr/share/xpanel/default"')
    expect(f.content).toContain('UserDir disabled')
  })

  it('rejects bad ports and hostnames', () => {
    expect(codeOf(() => renderApacheBase(settings({ backendPort: 443 }), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheBase(settings({ backendPort: 70000 }), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheBase(settings({ backendPort: 22, sshPort: 2222 }), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheBase(settings({ hostname: 'host\nListen 80' }), debianOs))).toBe('VALIDATION')
  })

  it('builds the configtest argv from the profile', () => {
    expect(apacheConfigTest(rhelOs).argv).toEqual(['/usr/sbin/apachectl', 'configtest'])
  })
})

describe('renderApacheVhost', () => {
  const a = account()

  it('renders names, docroot, directory rules and itk identity', () => {
    const f = renderApacheVhost(a, domain({ wildcard: true }), settings(), debianOs)
    const c = f.content
    expect(f.path).toBe('/etc/apache2/sites-enabled/xpanel-wild-197-example.com.conf')
    expect(c).toContain('<VirtualHost 127.0.0.1:8080>')
    expect(c).toContain('ServerName example.com')
    expect(c).toContain('ServerAlias www.example.com *.example.com')
    expect(c).toContain('DocumentRoot "/home/alice/public_html"')
    expect(c).toContain('<Directory "/home/alice/public_html">')
    expect(c).toContain('AllowOverride All')
    expect(c).toContain('Options -Indexes +SymLinksIfOwnerMatch')
    expect(c).toContain('AssignUserId alice alice')
    expect(c).not.toContain('<IfModule mpm_itk_module>')
  })

  it('includes alias domains passed in options', () => {
    const c = renderApacheVhost(a, domain(), settings(), debianOs, {
      aliases: [domain({ id: 'd2', name: 'example.net', kind: 'alias', parentId: 'd1' })],
    }).content
    expect(c).toContain('ServerAlias www.example.com example.net www.example.net')
    expect(
      codeOf(() =>
        renderApacheVhost(a, domain(), settings(), debianOs, { aliases: [domain({ id: 'd2', name: 'other.example', kind: 'addon', docRoot: '/home/alice/o' })] }),
      ),
    ).toBe('VALIDATION')
  })

  it('wires PHP-FPM through proxy_fcgi to the account socket', () => {
    const c = renderApacheVhost(a, domain(), settings(), debianOs).content
    expect(c).toContain(String.raw`<FilesMatch "\.php$">`)
    expect(c).toContain('SetHandler "proxy:unix:/run/xpanel/fpm/alice-8.3/php-fpm.sock|fcgi://localhost"')
    expect(c).not.toContain('SuexecUserGroup')
  })

  it('wires CGI under itk with Action and no suexec (the child already is the account)', () => {
    const c = renderApacheVhost(a, domain({ php: php({ handler: 'cgi' }) }), settings(), debianOs).content
    expect(c).toContain('ScriptAlias /.xpanel-php/ "/var/www/xpanel-cgi/alice/"')
    expect(c).toContain('Action xpanel-php83 /.xpanel-php/php8.3.cgi')
    expect(c).toContain('SetHandler xpanel-php83')
    expect(c).toContain('Require env REDIRECT_STATUS')
    expect(c).toContain('AssignUserId alice alice')
    expect(c).not.toContain('SuexecUserGroup')
  })

  it('wires CGI under prefork through suexec + mod_fcgid', () => {
    const c = renderApacheVhost(a, domain({ php: php({ handler: 'cgi' }) }), prefork, rhelOs).content
    expect(c).toContain('SuexecUserGroup alice alice')
    expect(c).toContain('FcgidWrapper "/var/www/xpanel-cgi/alice/php8.3.fcgi" .php')
    expect(c).toContain('SetHandler fcgid-script')
    expect(c).toContain('Options -Indexes +SymLinksIfOwnerMatch +ExecCGI')
    expect(c).not.toContain('AssignUserId')
  })

  it('implements suPHP with suexec and a php-cgi wrapper when itk is off', () => {
    const c = renderApacheVhost(a, domain({ php: php({ handler: 'suphp' }) }), prefork, debianOs).content
    expect(c).toContain('SuexecUserGroup alice alice')
    expect(c).toContain('Action xpanel-php83 /.xpanel-php/php8.3.cgi')
    expect(c).not.toMatch(/suPHP_|mod_suphp/)
  })

  it('throws ENGINE_UNAVAILABLE for suPHP with itk and lsphp on Apache', () => {
    expect(codeOf(() => renderApacheVhost(a, domain({ php: php({ handler: 'suphp' }) }), settings(), debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => renderApacheVhost(a, domain({ php: php({ handler: 'lsphp' }) }), settings(), debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => renderApacheVhost(a, domain(), settings({ engine: 'openlitespeed' }), debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => phpWiring('suphp', 'itk'))).toBe('ENGINE_UNAVAILABLE')
    expect(phpWiring('suphp', 'prefork')).toBe('suphp-action')
  })

  it('redirects suspended sites to the static suspended page without touching the home', () => {
    for (const [acc, d] of [
      [account({ status: 'suspended' }), domain()],
      [a, domain({ suspended: true })],
    ] as const) {
      const c = renderApacheVhost(acc, d, settings(), debianOs).content
      expect(c).toContain('DocumentRoot "/usr/share/xpanel/suspended"')
      expect(c).toContain(String.raw`RedirectMatch 302 "^/(?!index\.html$)" "/index.html"`)
      expect(c).not.toContain('/home/alice')
      expect(c).not.toContain('SetHandler')
    }
  })

  it('renders redirect sites with RedirectMatch', () => {
    const c = renderApacheVhost(a, domain({ redirect: { to: 'https://new.example/', code: 301 } }), settings(), debianOs).content
    expect(c).toContain('RedirectMatch 301 "^/" "https://new.example/"')
  })

  it('denies PHP source on static and app sites', () => {
    const s = renderApacheVhost(a, domain({ siteType: 'static' }), settings(), debianOs).content
    expect(s).toContain('Require all denied')
    expect(s).not.toContain('SetHandler')
    const n = renderApacheVhost(a, domain({ siteType: 'node', upstream: 'http://127.0.0.1:3000' }), settings(), debianOs).content
    expect(n).toContain('Nginx proxies it')
    expect(n).not.toContain('SetHandler')
  })

  it('rejects injection in names and document roots', () => {
    for (const docRoot of ['/home/alice/public_html" \nDocumentRoot "/', '/home/alice/a b', '/home/alice/${APACHE_LOG_DIR}', '/home/bob/x', '/var/www', '/home/alice/./x']) {
      expect(codeOf(() => renderApacheVhost(a, domain({ docRoot }), settings(), debianOs))).toBe('VALIDATION')
    }
    for (const name of ['example.com\n<Directory />', 'example.com example.org', 'exa"mple.com']) {
      expect(codeOf(() => renderApacheVhost(a, domain({ name }), settings(), debianOs))).toBe('VALIDATION')
    }
    expect(codeOf(() => renderApacheVhost(account({ username: 'alice bob' }), domain(), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheVhost(a, domain({ php: php({ version: '8.3; rm' }) }), settings(), debianOs))).toBe('VALIDATION')
  })

  it('renders one vhost per site of an account', () => {
    const files = renderApacheVhosts(
      a,
      [domain({ wildcard: true }), domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', docRoot: '/home/alice/public_html/blog' })],
      settings(),
      rhelOs,
    )
    expect(files.map((f) => f.path)).toEqual(['/etc/httpd/conf.d/xpanel-wild-197-example.com.conf', '/etc/httpd/conf.d/xpanel-site-blog.example.com.conf'])
    expect(files[1]?.content).toContain('ServerName blog.example.com')
  })

  it('loads exact vhosts before wildcard ones and deeper wildcards first (Apache takes the first match)', () => {
    const files = renderApacheVhosts(
      a,
      [
        domain({ wildcard: true }),
        domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', docRoot: '/home/alice/public_html/blog' }),
        domain({ id: 'd3', name: 'eu.example.com', kind: 'subdomain', docRoot: '/home/alice/eu', wildcard: true }),
        domain({ id: 'd4', name: 'zz.example.org', kind: 'addon', docRoot: '/home/alice/zz' }),
      ],
      settings(),
      debianOs,
    )
    // the order Apache's IncludeOptional reads them in
    const order = files.map((f) => f.path.slice(f.path.lastIndexOf('/') + 1)).sort()
    expect(order).toEqual([
      'xpanel-site-blog.example.com.conf',
      'xpanel-site-zz.example.org.conf',
      'xpanel-wild-196-eu.example.com.conf',
      'xpanel-wild-197-example.com.conf',
    ])
    // the base vhost (default for unknown names) still sorts before every site
    expect(['000-xpanel-base.conf', ...order].sort()[0]).toBe('000-xpanel-base.conf')
  })

  it('splits long alias lists over several ServerAlias lines', () => {
    const aliases = Array.from({ length: 40 }, (_, i) => domain({ id: `p${i}`, name: `parked${i}.example`, kind: 'alias', parentId: 'd1' }))
    const c = renderApacheVhost(a, domain(), settings(), debianOs, { aliases }).content
    const lines = c.split('\n').filter((l) => l.trim().startsWith('ServerAlias '))
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThan(8192)
    expect(lines.join(' ')).toContain('www.parked39.example')
  })
})

describe('renderPhpCgiWrapper', () => {
  const a = account()

  it('passes isolation values to php-cgi and is root-owned under itk', () => {
    const f = renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { memory_limit: '256M' } }) }), settings(), debianOs)
    expect(f.path).toBe('/var/www/xpanel-cgi/alice/php8.3.cgi')
    expect(f.mode).toBe(0o755)
    expect(f.owner).toBe('root')
    expect(f.content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(f.content).toContain("exec '/usr/bin/php-cgi8.3' \\")
    expect(f.content).toContain("-d 'open_basedir=/home/alice:/home/alice/tmp'")
    expect(f.content).toMatch(/-d 'disable_functions=exec,passthru,shell_exec,system,/)
    expect(f.content).toContain("-d 'cgi.force_redirect=1'")
    expect(f.content).toContain("-d 'memory_limit=256M'")
    expect(f.content.trimEnd().endsWith('\\')).toBe(false)
  })

  it('is account-owned for suexec under prefork and uses fcgid env', () => {
    const f = renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi' }) }), prefork, rhelOs)
    expect(f.path).toBe('/var/www/xpanel-cgi/alice/php8.3.fcgi')
    expect(f.owner).toBe('alice')
    expect(f.group).toBe('alice')
    expect(f.content).toContain("exec '/opt/remi/php83/root/usr/bin/php-cgi' \\")
    expect(f.content).toContain('export PHP_FCGI_CHILDREN=0')
    expect(f.content).toContain('export PHP_FCGI_MAX_REQUESTS=500')
    expect(f.content).not.toContain('cgi.force_redirect')
  })

  it('applies suPHP rules: ownership, no group/other write, per-directory php.ini', () => {
    const c = renderPhpCgiWrapper(a, domain({ php: php({ handler: 'suphp' }) }), prefork, debianOs).content
    expect(c.startsWith('#!/bin/bash\n')).toBe(true)
    expect(c).toContain(`home='/home/alice'`)
    expect(c).toContain('case "$script" in "$home"/*) ;; *) deny ;; esac')
    expect(c).toContain('[ -O "$script" ]')
    expect(c).toContain('-perm /022')
    expect(c).toContain('export PHPRC="$dir"')
    expect(c).toContain('Status: 403 Forbidden')
  })

  it('refuses FPM, suPHP under itk and hostile ini values', () => {
    expect(codeOf(() => renderPhpCgiWrapper(a, domain(), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'suphp' }) }), settings(), debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { 'date.timezone': "1'; rm -rf / #" } }) }), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { auto_prepend_file: '/tmp/x.php' } }) }), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { memory_limit: '$(reboot)' } }) }), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { memory_limit: '1\nextension=evil.so' } }) }), settings(), debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderPhpCgiWrapper(a, domain({ php: php({ handler: 'cgi', ini: { open_basedir: '/' } }) }), settings(), debianOs))).toBe('VALIDATION')
  })

  it('creates wrapper directories with suexec-compatible ownership', () => {
    expect(cgiWrapperDirs(a, prefork, debianOs)).toEqual([
      { kind: 'ensure-dir', path: '/var/www/xpanel-cgi', mode: 0o755, owner: 'root', group: 'root' },
      { kind: 'ensure-dir', path: '/var/www/xpanel-cgi/alice', mode: 0o755, owner: 'alice', group: 'alice' },
    ])
    expect(cgiWrapperDirs(a, settings(), debianOs)[1]).toMatchObject({ owner: 'root' })
  })
})

describe('requiredApacheModules', () => {
  it('lists modules per handler and MPM', () => {
    const itk = requiredApacheModules(settings(), [domain(), domain({ id: 'd2', name: 'b.example', php: php({ handler: 'cgi' }) })])
    expect(itk).toEqual(expect.arrayContaining(['mpm_itk', 'mpm_prefork', 'remoteip', 'proxy_fcgi', 'actions', 'cgi']))
    expect(itk).not.toContain('suexec')
    const pf = requiredApacheModules(prefork, [domain({ php: php({ handler: 'suphp' }) })])
    expect(pf).toEqual(expect.arrayContaining(['suexec', 'actions', 'cgi']))
    expect(pf).not.toContain('mpm_itk')
  })
})
