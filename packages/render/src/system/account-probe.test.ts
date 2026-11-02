import { describe, expect, it } from 'vitest'
import type { Domain } from '@xpanel/core'
import { ACCOUNT_PROBE_ASSET, ACCOUNT_PROBE_PHP, ACCOUNT_PROBE_ROUTE, accountProbeDirectories, accountProbeNamespace, accountProbeNginxLocation, accountProbePaths, assertAccountProbeIngress, renderAccountProbeAsset } from './account-probe.ts'
import { renderFpmUnit } from './units.ts'
import { debianOs, makeAccount } from './testkit.ts'
import { renderNginxSite } from '../edge/nginx.ts'
import { account as edgeAccount, cert, domain, settings } from '../edge/testkit.ts'
const account = { username: 'alice', uid: 1000, home: '/home/alice' }
describe('immutable account probe renderer', { tags: ['unit'] }, () => {
  it('keeps the asset Root-owned and read-only with no reported process identity', () => {
    expect(renderAccountProbeAsset()).toEqual({ path: ACCOUNT_PROBE_ASSET, content: ACCOUNT_PROBE_PHP, mode: 0o444, owner: 'root', group: 'root' })
    expect(ACCOUNT_PROBE_PHP).not.toMatch(/getmypid|posix_getuid|posix_getgid|shell_exec|fastcgi_finish_request/)
    expect(ACCOUNT_PROBE_PHP).toContain("$release !== \"release\\n\"")
  })
  it('keeps the canary inside the existing admitted home and tmp confinement', () => {
    expect(accountProbeNamespace(account)).toEqual(['BindReadOnlyPaths=/etc/xpanel/account-probe:/home/alice/.xpanel-probe', 'BindReadOnlyPaths=/run/xpanel-account-probe/1000:/home/alice/.xpanel-probe/runtime'])
    expect(accountProbePaths(account).callbackInNamespace).toBe('/home/alice/.xpanel-probe/runtime/callback.sock')
  })
  it('assembles both readonly mounts into the actual FPM unit without widening writable paths', () => {
    const actual = makeAccount(), unit = renderFpmUnit(actual, '8.3', debianOs).content
    for (const mount of accountProbeNamespace(actual)) expect(unit.split('\n').filter(line => line === mount)).toHaveLength(1)
    expect(unit).toContain('ProtectHome=tmpfs')
    expect(unit).toContain('PrivateTmp=yes')
    expect(unit.split('\n').filter(line => line.startsWith('ReadWritePaths=')).join('\n')).not.toContain('/etc/xpanel/account-probe')
  })
  it('preserves an approved custom home base and the existing numeric identity limits', () => {
    expect(accountProbePaths({ ...account, uid: 60000, home: '/srv/accounts/alice' }).script).toBe('/srv/accounts/alice/.xpanel-probe/probe.php')
    for (const uid of [999, 60001, 1.5]) expect(() => accountProbePaths({ ...account, uid })).toThrow()
    expect(() => accountProbePaths({ ...account, home: '/var/alice' })).toThrow()
    expect(() => accountProbePaths({ ...account, home: '/home/foreign' })).toThrow()
  })
  it('creates only Root-owned non-listable runtime parents and fixed source directories', () => {
    const actions = accountProbeDirectories([account])
    expect(actions).toHaveLength(4)
    expect(actions.every(action => action.kind === 'ensure-dir' && action.owner === 'root' && action.group === 'root')).toBe(true)
    expect(actions.filter(action => action.kind === 'ensure-dir' && action.path.startsWith('/run/')).every(action => action.kind === 'ensure-dir' && action.mode === 0o711)).toBe(true)
  })
  it('emits an exact path over Unix sockets with no caller script authority', () => {
    const content = accountProbeNginxLocation(account).join('\n')
    expect(content).toContain('location = ' + ACCOUNT_PROBE_ROUTE + ' {')
    expect(content).toContain('fastcgi_pass unix:/run/xpanel-account-probe/1000/ingress.sock;')
    expect(content).toContain('access_log off;')
    // The agent's ingress admits exactly seven parameters; no request header may add an eighth.
    expect(content).toContain('fastcgi_pass_request_headers off;')
    expect(accountProbeNginxLocation(account).filter(line => line.trim().startsWith('fastcgi_param '))).toHaveLength(7)
    expect(content).not.toMatch(/SCRIPT_FILENAME|PHP_VALUE|PHP_ADMIN_VALUE|proxy_pass|127[.]0[.]0[.]1:[0-9]+/)
  })
  it('assembles the actual FPM vhost while preserving suspended and bandwidth denial', () => {
    const actual = edgeAccount(), storedDomain = domain(), fpm: Domain = { ...storedDomain, php: { ...storedDomain.php, handler: 'fpm' } }
    const content = renderNginxSite(actual, [fpm], settings(), cert(), { forceHttps: true })
    expect(content).toContain('return 301 https://$host$request_uri;')
    expect(renderNginxSite(actual, [fpm], settings(), [], { forceHttps: true })).not.toContain('return 301 https://$host$request_uri;')
    expect(() => assertAccountProbeIngress(content, actual)).not.toThrow()
    expect(renderNginxSite({ ...actual, status: 'suspended' }, [fpm], settings())).not.toContain(ACCOUNT_PROBE_ROUTE)
    expect(renderNginxSite({ ...actual, bandwidthLimitedMonth: '2026-10' }, [fpm], settings())).not.toContain(ACCOUNT_PROBE_ROUTE)
  })
  it('refuses a changed ingress, arbitrary include and replay-capable rewrite or subrequest', () => {
    const expected = accountProbeNginxLocation(account).map(line => '    ' + line).join('\n')
    expect(() => assertAccountProbeIngress('server {\n' + expected + '\n}', account)).not.toThrow()
    expect(() => assertAccountProbeIngress('server {\nserver_name rewrite.example.test;\n' + expected + '\n}', account)).not.toThrow()
    for (const extra of ['include /home/alice/nginx.conf;', 'rewrite ^ /index.php last;', 'server { rewrite ^ /index.php last; }', 'r\\ewrite ^ /index.php last;', 'auth_request /auth;', 'mirror /mirror;', 'rewrite_by_lua_file /home/alice/a.lua;', 'js_access tenant;']) {
      expect(() => assertAccountProbeIngress('server {\n' + extra + '\n' + expected + '\n}', account)).toThrow()
    }
    expect(() => assertAccountProbeIngress(expected.replace('ingress.sock', 'foreign.sock'), account)).toThrow()
  })
})
