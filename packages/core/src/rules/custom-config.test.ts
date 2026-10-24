import { describe, expect, it } from 'vitest'
import {
  assertJailedShellAllowed,
  validateApacheCustomInclude,
  validateCacheBypassPaths,
  validateCustomHeaders,
  validateDomainCustomConfig,
  validateNginxCustomInclude,
} from './custom-config.ts'

describe('custom account & domain configuration (userdata) rules', () => {
  it.each([
    'add_header X-Safe "ok"; root /etc;',
    'location /assets { alias /etc/; }',
    'location /admin { proxy_pass http://127.0.0.1:7400; }',
    'expires 7d;\nproxy_pass\nhttp://127.0.0.1:7400;',
    '"proxy_pass" http://127.0.0.1:7400;',
    'pr\\oxy_pass http://127.0.0.1:7400;',
    'expires 7d; listen 8443;',
    'expires 7d; server_name another.example.invalid;',
    'location / { content_by_lua_block { ngx.say("hello") } }',
    'add_header X-Test foo#bar;\nproxy_pass http://127.0.0.1:7400;',
  ])('rejects a non-root nginx directive at every statement boundary: %s', snippet => {
    expect(() => validateNginxCustomInclude(snippet)).toThrow(/root privileges/)
  })

  it('handles nginx quoted delimiters and comments without hiding statements', () => {
    const snippet = 'add_header X-Pattern "root /etc; # literal }";\n# alias /etc;\nexpires 7d;'
    expect(validateNginxCustomInclude(snippet)).toBe(snippet)
    expect(validateNginxCustomInclude('set $cache_control "${request_method}";')).toContain('${request_method}')
    expect(validateNginxCustomInclude('add_header X-Test foo#bar;')).toContain('foo#bar;')
    expect(validateNginxCustomInclude('expires 7d; # root /etc;\nadd_header X-Test ok;')).toContain('add_header X-Test ok;')
    expect(() => validateNginxCustomInclude('expires 7d; http { }', { allowRootDirectives: true })).toThrow(/not allowed/)
    expect(() => validateNginxCustomInclude('add_header X-Test "unterminated;')).toThrow(/unterminated/)
  })

  it('checks each privileged nginx path after decoding and normalization', () => {
    const opts = { allowRootDirectives: true, accountHome: '/home/alice' }
    expect(() => validateNginxCustomInclude('location /files { alias /home/alice/../bob/; }', opts)).toThrow(/must stay inside account home/)
    expect(() => validateNginxCustomInclude('root "/home/alice/../bob";', opts)).toThrow(/must stay inside account home/)
    expect(() => validateNginxCustomInclude('root /home/alice/$target;', opts)).toThrow(/must stay inside account home/)
    expect(validateNginxCustomInclude('location /files { alias "/home/alice/www/assets/"; }', opts)).toContain('alias')
    expect(validateNginxCustomInclude('location /api { proxy_pass http://127.0.0.1:8080; }', opts)).toContain('proxy_pass')
  })

  it.each([
    'ProxyPass /admin http://127.0.0.1:7400/',
    '"ProxyPass" /admin http://127.0.0.1:7400/',
    'ProxyRequests On',
    '<Proxy "*">\nRequire all granted\n</Proxy>',
    'Alias /files /etc/',
    'Define XP_PROXY_FLAG P\nRewriteRule ^/admin http://127.0.0.1:7400/ [${XP_PROXY_FLAG},L]',
    '"Define" XP_PROXY_FLAG P',
    'De\\\nfine XP_PROXY_FLAG P',
    'UnDefine XP_PROXY_FLAG',
    'RewriteRule ^/admin http://127.0.0.1:7400/ [${XP_PROXY_FLAG},L]',
    'RewriteRule ^/admin "${XP_PROXY_TARGET}"',
    'Options +ExecCGI\nRewriteRule ^/payload$ - [H=cgi-script,L]',
    'RewriteRule ^/payload$ - "[L,handler=application/x-httpd-php]"',
    '<IfModule mod_proxy.c>\nProxyPass /admin http://127.0.0.1:7400/\n</IfModule>',
    'Prox\\\nyPass /admin http://127.0.0.1:7400/',
    'RewriteRule ^/admin http://127.0.0.1:7400/ [P,L]',
    'RewriteRule ^/admin http://127.0.0.1:7400/ "[L,proxy]"',
    'Rewrit\\\neRule ^/admin http://127.0.0.1:7400/ [P]',
    '<DirectoryMatch "^/etc">\nRequire all granted\n</DirectoryMatch>',
  ])('rejects non-root Apache proxy instructions after logical-line parsing: %s', snippet => {
    expect(() => validateApacheCustomInclude(snippet)).toThrow(/root privileges/)
  })

  it('preserves safe Apache arguments, redirects and continued comments', () => {
    const header = 'Header set X-Pattern "literal # ProxyPass /admin"'
    expect(validateApacheCustomInclude(header)).toBe(header)
    expect(validateApacheCustomInclude('RewriteRule ^/old /new [R=302,L]')).toContain('R=302')
    const comment = '# continued comment \\\nProxyPass /admin http://127.0.0.1:7400/'
    expect(validateApacheCustomInclude(comment)).toBe(comment)
    expect(validateApacheCustomInclude('ProxyPass /api http://127.0.0.1:8080/', { allowRootDirectives: true })).toContain('ProxyPass')
    expect(validateApacheCustomInclude('RewriteRule ^/payload$ - [H=cgi-script]', { allowRootDirectives: true })).toContain('H=cgi-script')
    expect(() => validateApacheCustomInclude('"LoadModule" example_module modules/example.so', { allowRootDirectives: true })).toThrow(/forbidden/)
    expect(() => validateApacheCustomInclude('${DIRECTIVE} /admin http://127.0.0.1:7400/')).toThrow(/invalid apache directive/)
    expect(validateApacheCustomInclude('<IfModule mod_headers.c>\nHeader set X-Test "ok"\n</IfModule>')).toContain('Header set')
  })

  it.each([
    '</VirtualHost>\nHeader set X-Test "outside"',
    '<IfModule mod_headers.c>\nHeader set X-Test "unclosed"',
  ])('keeps Apache sections inside the supplied include: %s', snippet => {
    expect(() => validateApacheCustomInclude(snippet, { allowRootDirectives: true })).toThrow(/unbalanced apache section/)
  })

  it('accepts safe nginx location and header rules and rejects top-level or escaping directives', () => {
    const valid = validateNginxCustomInclude(`
      # Custom static caching
      location ~* \\.(?:avif|webp)$ {
        expires 30d;
      }
    `)
    expect(valid).toContain('expires 30d;')

    expect(() => validateNginxCustomInclude('worker_processes 8;')).toThrow(/not allowed/)
    expect(() => validateNginxCustomInclude('root /etc/passwd;')).toThrow(/root privileges/)
    expect(() =>
      validateNginxCustomInclude('alias /etc/shadow;', {
        allowRootDirectives: true,
        accountHome: '/home/alice',
      }),
    ).toThrow(/must stay inside account home/)
    expect(() => validateNginxCustomInclude('location / { return 200;')).toThrow(/unbalanced/)
  })

  it('blocks AssignUserId, SuexecUserGroup, and Listen in Apache custom includes', () => {
    const valid = validateApacheCustomInclude('Header always set X-Frame-Options "SAMEORIGIN"')
    expect(valid).toBe('Header always set X-Frame-Options "SAMEORIGIN"')

    expect(() => validateApacheCustomInclude('AssignUserId root root')).toThrow(/forbidden/)
    expect(() => validateApacheCustomInclude('SuexecUserGroup root root')).toThrow(/forbidden/)
    expect(() => validateApacheCustomInclude('Listen 0.0.0.0:9999')).toThrow(/forbidden/)
    expect(() => validateApacheCustomInclude('SetHandler server-status')).toThrow(/root privileges/)
  })

  it('validates custom headers, cache bypass paths, and full domain custom config', () => {
    const cfg = validateDomainCustomConfig({
      domainId: '00000000-0000-4000-8000-000000000001',
      accountId: '00000000-0000-4000-8000-000000000002',
      domainName: 'alice-shop.com',
      nginxInclude: 'expires 7d;',
      apacheInclude: 'Header set X-Tenant "alice"',
      userIni: { memory_limit: '256M', max_execution_time: '120' },
      customHeaders: { 'X-Content-Type-Options': 'nosniff' },
      cacheBypassPaths: ['/cart', '/checkout'],
      updatedBy: 'user',
    })
    expect(cfg.customHeaders['X-Content-Type-Options']).toBe('nosniff')
    expect(cfg.cacheBypassPaths).toEqual(['/cart', '/checkout'])

    expect(() => validateCustomHeaders({ 'Transfer-Encoding': 'chunked' })).toThrow(/reserved/)
    expect(() => validateCacheBypassPaths(['relative/path'])).toThrow(/start with "\/"/)
  })

  it('enforces jailed shell eligibility across account status, plan shell, and account shell', () => {
    expect(() =>
      assertJailedShellAllowed(
        { username: 'alice', status: 'active', shell: 'jailed' },
        { name: 'Pro', shell: 'jailed' },
      ),
    ).not.toThrow()

    expect(() =>
      assertJailedShellAllowed(
        { username: 'alice', status: 'suspended', shell: 'jailed' },
        { name: 'Pro', shell: 'jailed' },
      ),
    ).toThrow(/suspended/)

    expect(() =>
      assertJailedShellAllowed(
        { username: 'alice', status: 'active', shell: 'jailed' },
        { name: 'Starter', shell: 'none' },
      ),
    ).toThrow(/shell: none/)

    expect(() =>
      assertJailedShellAllowed(
        { username: 'alice', status: 'active', shell: 'none' },
        { name: 'Pro', shell: 'jailed' },
      ),
    ).toThrow(/disabled on account/)
  })
})
