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
