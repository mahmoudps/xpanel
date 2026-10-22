import { describe, expect, it } from 'vitest'
import {
  errorLevelValue,
  lsphpAppName,
  renderOlsAccount,
  renderOlsExtProcessor,
  renderOlsListener,
  renderOlsServerBase,
  renderOlsVhost,
} from './ols.ts'
import { account, codeOf, debianOs, domain, php, rhelOs, settings } from './testkit.ts'

const ols = settings({ engine: 'openlitespeed' })
const lsphp = (over = {}) => php({ handler: 'lsphp', ...over })
const a = account()

describe('renderOlsExtProcessor', () => {
  it('runs lsphp as the account with its worker numbers and version path', () => {
    const c = renderOlsExtProcessor(a, lsphp({ fpm: { ...php().fpm, maxChildren: 12 } }), ols, debianOs)
    expect(c).toMatch(/^extprocessor lsphp-alice-83 \{$/m)
    expect(c).toMatch(/^\s+type\s+lsapi$/m)
    expect(c).toMatch(/^\s+extUser\s+alice$/m)
    expect(c).toMatch(/^\s+extGroup\s+alice$/m)
    expect(c).toMatch(/^\s+maxConns\s+12$/m)
    expect(c).toMatch(/^\s+env\s+PHP_LSAPI_CHILDREN=12$/m)
    expect(c).toMatch(/^\s+path\s+\/usr\/local\/lsws\/lsphp83\/bin\/lsphp$/m)
    expect(c).toMatch(/^\s+address\s+uds:\/\/tmp\/lshttpd\/xpanel-alice-83\.sock$/m)
    expect(c).toMatch(/^\s+autoStart\s+2$/m)
  })

  it('uses the profile lsphp binary when it provides one', () => {
    const os = { ...rhelOs, lsphpBinary: (v: string) => `/usr/local/lsws/lsphp${v.replace('.', '')}/bin/lsphp` }
    expect(renderOlsExtProcessor(a, lsphp({ version: '8.2' }), ols, os)).toContain('/usr/local/lsws/lsphp82/bin/lsphp')
  })

  it('throws ENGINE_UNAVAILABLE for Apache handlers or the Apache engine', () => {
    expect(codeOf(() => renderOlsExtProcessor(a, php(), ols, debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => renderOlsExtProcessor(a, lsphp(), settings(), debianOs))).toBe('ENGINE_UNAVAILABLE')
  })

  it('enforces the plan worker cap', () => {
    expect(codeOf(() => renderOlsExtProcessor(a, lsphp(), ols, debianOs, { workerCap: 2 }))).toBe('LIMIT_EXCEEDED')
  })
})

describe('renderOlsVhost', () => {
  it('declares the vhost and writes vhconf with docRoot, names, rewrite and lsphp', () => {
    const v = renderOlsVhost(a, domain({ wildcard: true, php: lsphp() }), ols, debianOs)
    expect(v.server).toMatch(/^virtualhost example\.com \{$/m)
    expect(v.server).toMatch(/^\s+vhRoot\s+\/home\/alice$/m)
    expect(v.server).toMatch(/^\s+configFile\s+\/usr\/local\/lsws\/conf\/vhosts\/example\.com\/vhconf\.conf$/m)
    expect(v.server).toMatch(/^\s+restrained\s+1$/m)
    expect(v.vhconf.path).toBe('/usr/local/lsws/conf/vhosts/example.com/vhconf.conf')
    const c = v.vhconf.content
    expect(c).toMatch(/^docRoot\s+\/home\/alice\/public_html$/m)
    expect(c).toMatch(/^vhDomain\s+example\.com$/m)
    expect(c).toMatch(/^vhAliases\s+www\.example\.com, \*\.example\.com$/m)
    expect(c).toMatch(/rewrite \{\n\s+enable\s+1\n\s+autoLoadHtaccess\s+1\n\}/)
    expect(c).toMatch(/add\s+lsapi:lsphp-alice-83 php/)
    expect(c).toContain('php_admin_value open_basedir "/home/alice:/home/alice/tmp"')
    expect(v.map).toEqual({ vhost: 'example.com', names: ['example.com', 'www.example.com', '*.example.com'] })
  })

  it('applies isolation and startup-only keys as admin values, the rest per directory', () => {
    const c = renderOlsVhost(a, domain({ php: lsphp({ ini: { memory_limit: '256M', allow_url_fopen: 'off' } }) }), ols, debianOs).vhconf.content
    expect(c).toContain('php_admin_value disable_functions "exec,')
    expect(c).toContain('php_admin_value allow_url_fopen "Off"')
    expect(c).toContain('php_value memory_limit "256M"')
    expect(codeOf(() => renderOlsVhost(a, domain({ php: lsphp({ ini: { auto_prepend_file: '/tmp/x' } }) }), ols, debianOs))).toBe('VALIDATION')
  })

  it('evaluates error_reporting constants, which OLS php_value would pass on as text', () => {
    const c = renderOlsVhost(a, domain({ php: lsphp({ ini: { error_reporting: 'E_ALL & ~E_NOTICE & ~E_DEPRECATED' } }) }), ols, debianOs).vhconf.content
    expect(c).toContain('php_value error_reporting "24567"')
    expect(errorLevelValue('E_ALL')).toBe('32767')
    expect(errorLevelValue('E_ERROR | E_WARNING | E_PARSE')).toBe('7')
    // INI operators share one precedence level and associate left to right
    expect(errorLevelValue('E_ALL ^ E_NOTICE & E_WARNING')).toBe(String((32767 ^ 8) & 2))
    expect(errorLevelValue('-1')).toBe('-1')
    expect(codeOf(() => errorLevelValue('E_BOGUS'))).toBe('VALIDATION')
  })

  it('serves the suspended page from the xPanel dir', () => {
    const v = renderOlsVhost(account({ status: 'suspended' }), domain({ php: lsphp() }), ols, debianOs)
    // restrained=1 confines the vhost to vhRoot, so the suspended page must be inside it
    expect(v.server).toMatch(/^\s+vhRoot\s+\/usr\/share\/xpanel\/suspended$/m)
    expect(v.server).not.toContain('/home/alice')
    const c = v.vhconf.content
    expect(c).toMatch(/^docRoot\s+\/usr\/share\/xpanel\/suspended$/m)
    expect(c).toContain(String.raw`RewriteRule ^(?!index\.html$) /index.html [R=302,L]`)
    expect(c).not.toContain('scripthandler')
  })

  it('rejects Apache handlers on PHP sites and injection in names', () => {
    expect(codeOf(() => renderOlsVhost(a, domain(), ols, debianOs))).toBe('ENGINE_UNAVAILABLE')
    expect(codeOf(() => renderOlsVhost(a, domain({ name: 'a.example}\nvirtualhost x {', php: lsphp() }), ols, debianOs))).toBe('VALIDATION')
    expect(codeOf(() => renderOlsVhost(a, domain({ docRoot: '/home/alice/x}', php: lsphp() }), ols, debianOs))).toBe('VALIDATION')
  })

  it('renders static sites without a script handler', () => {
    const c = renderOlsVhost(a, domain({ siteType: 'static' }), ols, debianOs).vhconf.content
    expect(c).not.toContain('scripthandler')
  })
})

describe('renderOlsAccount and listener', () => {
  it('emits one lsphp app per version in use and a vhost per site', () => {
    const r = renderOlsAccount(
      a,
      [
        domain({ php: lsphp() }),
        domain({ id: 'd2', name: 'blog.example.com', kind: 'subdomain', docRoot: '/home/alice/public_html/blog', php: lsphp() }),
        domain({ id: 'd3', name: 'old.example', kind: 'addon', docRoot: '/home/alice/old', php: lsphp({ version: '7.4' }) }),
      ],
      ols,
      debianOs,
    )
    expect(r.server.match(/^extprocessor /gm)).toHaveLength(2)
    expect(r.server).toContain(`extprocessor ${lsphpAppName('alice', '8.3')} {`)
    expect(r.server).toContain(`extprocessor ${lsphpAppName('alice', '7.4')} {`)
    expect(r.vhconfs).toHaveLength(3)
    const l = renderOlsListener(ols, r.maps)
    expect(l).toMatch(/^\s+address\s+127\.0\.0\.1:8080$/m)
    expect(l).toMatch(/^\s+map\s+blog\.example\.com blog\.example\.com, www\.blog\.example\.com$/m)
    expect(l).not.toMatch(/address\s+(\*|0\.0\.0\.0)/)
  })

  it('refuses a name mapped twice', () => {
    expect(codeOf(() => renderOlsListener(ols, [{ vhost: 'a.example', names: ['a.example'] }, { vhost: 'b.example', names: ['a.example'] }]))).toBe('VALIDATION')
    expect(codeOf(() => renderOlsListener(ols, [{ vhost: 'a.example', names: ['a.example'] }, { vhost: 'a.example', names: ['b.example'] }]))).toBe('VALIDATION')
  })

  it('validates every vhost and name that reaches the listener', () => {
    const bad = [
      [{ vhost: 'a.example', names: ['a.example, evil.example'] }],
      [{ vhost: 'a.example\n}', names: ['a.example'] }],
      [{ vhost: 'a.example', names: ['*.*.example'] }],
      [{ vhost: 'a.example', names: [] }],
      [{ vhost: 'A.example', names: ['a.example'] }],
    ]
    for (const maps of bad) expect(codeOf(() => renderOlsListener(ols, maps))).toBe('VALIDATION')
    expect(renderOlsListener(ols, [{ vhost: 'a.example', names: ['a.example', '*.a.example'] }])).toMatch(/map\s+a\.example a\.example, \*\.a\.example/)
  })

  it('trusts loopback for the client IP header', () => {
    const c = renderOlsServerBase(ols)
    expect(c).toMatch(/useIpInProxyHeader\s+2/)
    expect(c).toContain('127.0.0.1T')
    expect(codeOf(() => renderOlsServerBase(settings()))).toBe('ENGINE_UNAVAILABLE')
  })
})
