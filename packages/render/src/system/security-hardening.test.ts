import { describe, expect, it } from 'vitest'
import {
  assertSafeAccountRootChain,
  buildJailedFileOpArgv,
  buildJailedShellArgv,
  homeBaseProtectionActions,
  renderDomainCustomIncludes,
  renderJailShellBinary,
  renderPostfixOutboundIpTransports,
  renderSymlinkProtectionSysctl,
} from './security-hardening.ts'

describe('symlink protection, account root protection, and jailed shell', () => {
  const alice = {
    username: 'alice',
    uid: 20000,
    gid: 20000,
    home: '/home/alice',
    status: 'active' as const,
    shell: 'jailed' as const,
  }

  it('renders kernel symlink and hardlink protection sysctls', () => {
    const sysctl = renderSymlinkProtectionSysctl()
    expect(sysctl.path).toBe('/etc/sysctl.d/90-xpanel-symlink-protection.conf')
    expect(sysctl.content).toContain('fs.protected_symlinks = 1')
    expect(sysctl.content).toContain('fs.protected_hardlinks = 1')
    expect(sysctl.content).toContain('fs.protected_fifos = 2')
    expect(sysctl.content).toContain('fs.protected_regular = 2')

    const homeActions = homeBaseProtectionActions(['/home'])
    expect(homeActions).toEqual([{ kind: 'ensure-dir', path: '/home', mode: 0o711, owner: 'root', group: 'root' }])
  })

  it('verifies account root stat chain and blocks symlinked /home, symlinked /home/<user>, and cross-UID symlinks', () => {
    const validHomeBase = { path: '/home', isSymbolicLink: false, isDirectory: true, uid: 0, gid: 0, mode: 0o711 }
    const validAccountRoot = { path: '/home/alice', isSymbolicLink: false, isDirectory: true, uid: 20000, gid: 20000, mode: 0o750 }

    expect(() =>
      assertSafeAccountRootChain({
        account: alice,
        homeBaseStat: validHomeBase,
        accountRootStat: validAccountRoot,
        subpathStats: [
          {
            path: '/home/alice/public_html',
            isSymbolicLink: false,
            isDirectory: true,
            uid: 20000,
            gid: 20000,
            mode: 0o750,
          },
        ],
      }),
    ).not.toThrow()

    // Attack 1: account root /home/alice replaced with a symlink
    expect(() =>
      assertSafeAccountRootChain({
        account: alice,
        homeBaseStat: validHomeBase,
        accountRootStat: { ...validAccountRoot, isSymbolicLink: true, realTargetPath: '/home/bob' },
      }),
    ).toThrow(/account root \/home\/alice is a symbolic link/)

    // Attack 2: /home/alice has world-writable permissions
    expect(() =>
      assertSafeAccountRootChain({
        account: alice,
        homeBaseStat: validHomeBase,
        accountRootStat: { ...validAccountRoot, mode: 0o777 },
      }),
    ).toThrow(/unsafe permissions/)

    // Attack 3: subpath inside /home/alice is a symlink pointing to /etc/shadow
    expect(() =>
      assertSafeAccountRootChain({
        account: alice,
        homeBaseStat: validHomeBase,
        accountRootStat: validAccountRoot,
        subpathStats: [
          {
            path: '/home/alice/public_html/config.php',
            isSymbolicLink: true,
            isDirectory: false,
            uid: 20000,
            gid: 20000,
            mode: 0o777,
            realTargetPath: '/etc/shadow',
            targetUid: 0,
          },
        ],
      }),
    ).toThrow(/points outside account root/)

    // Attack 4: symlink inside /home/alice points to a root-owned file inside /home/alice (SymLinksIfOwnerMatch violation)
    expect(() =>
      assertSafeAccountRootChain({
        account: alice,
        homeBaseStat: validHomeBase,
        accountRootStat: validAccountRoot,
        subpathStats: [
          {
            path: '/home/alice/public_html/leak',
            isSymbolicLink: true,
            isDirectory: false,
            uid: 20000,
            gid: 20000,
            mode: 0o777,
            realTargetPath: '/home/alice/root-secret',
            targetUid: 0,
          },
        ],
      }),
    ).toThrow(/SymLinksIfOwnerMatch/)
  })

  it('builds isolated systemd-run jailed shell argv without bash -c and rejects shell metacharacters or unapproved binaries', () => {
    const bin = renderJailShellBinary()
    expect(bin.path).toBe('/opt/xpanel/bin/jailshell')
    expect(bin.content).toContain('if [ -L "$HOME" ]; then')

    const argv = buildJailedShellArgv(alice, { name: 'Pro', shell: 'jailed' }, ['composer', 'install', '--no-dev'], {
      cwdRel: 'public_html',
      env: { APP_ENV: 'production' },
    })
    expect(argv[0]).toBe('/usr/bin/systemd-run')
    expect(argv).toContain('--working-directory=/home/alice/public_html')
    expect(argv).toContain('Slice=xpanel-20000.slice')
    expect(argv).toContain('ProtectHome=tmpfs')
    expect(argv).toContain('BindPaths=/home/alice')
    expect(argv).toContain('ProtectProc=invisible')
    expect(argv).toContain('SocketBindDeny=any')
    expect(argv).not.toContain('/bin/bash')
    expect(argv).not.toContain('-c')
    expect(argv.slice(-3)).toEqual(['/usr/bin/composer', 'install', '--no-dev'])

    // Reject shell metacharacters and bash/sh execution
    expect(() => buildJailedShellArgv(alice, { name: 'Pro', shell: 'jailed' }, 'php -v; id')).toThrow(/metacharacters/)
    expect(() => buildJailedShellArgv(alice, { name: 'Pro', shell: 'jailed' }, ['bash', '-c', 'id'])).toThrow(/not permitted/)

    // Jailed file operation argv runs inside the account's slice and UID
    const fileOpArgv = buildJailedFileOpArgv(alice, ['chmod', '0640', 'public_html/index.php'])
    expect(fileOpArgv).toContain('User=alice')
    expect(fileOpArgv).toContain('Slice=xpanel-20000.slice')
    expect(fileOpArgv.slice(-3)).toEqual(['/bin/chmod', '0640', 'public_html/index.php'])
  })

  it('renders per-domain custom userdata includes and Postfix outbound multi-IP transport maps', () => {
    const files = renderDomainCustomIncludes(alice, '/home/alice/public_html', {
      domainId: '00000000-0000-4000-8000-000000000001',
      accountId: '00000000-0000-4000-8000-000000000002',
      domainName: 'alice-shop.com',
      nginxInclude: 'expires 30d;',
      apacheInclude: 'Header set X-Shop "1"',
      userIni: { memory_limit: '256M' },
      customHeaders: { 'X-Frame-Options': 'SAMEORIGIN' },
      cacheBypassPaths: ['/checkout'],
      updatedAt: '2026-10-22T06:00:00Z',
      updatedBy: 'user',
    })
    expect(files.map((f) => f.path)).toEqual([
      '/etc/xpanel/userdata/alice/alice-shop.com/nginx.conf',
      '/etc/xpanel/userdata/alice/alice-shop.com/apache.conf',
      '/home/alice/public_html/.user.ini',
    ])

    const postfixOut = renderPostfixOutboundIpTransports(
      [{ name: 'alice-shop.com', accountId: 'acc-1', ipv4: '203.0.113.77', ipv6: '2001:db8::77' }],
      new Map([['acc-1', { id: 'acc-1', ipv4: '203.0.113.10', ipv6: '2001:db8::10' }]]),
      {
        mode: 'domain-ip',
        defaultIpv4: '203.0.113.10',
        defaultIpv6: '2001:db8::10',
        defaultHelo: 'srv1.example.com',
        domainOverrides: [],
      },
      { ipv4: '203.0.113.10', ipv6: '2001:db8::10', hostname: 'srv1.example.com' },
    )
    expect(postfixOut.files[0]?.content).toContain('@alice-shop.com  xpanel-smtp-203-0-113-77:')
    expect(postfixOut.files[1]?.content).toContain('-o smtp_bind_address=203.0.113.77')
    expect(postfixOut.files[1]?.content).toContain('-o smtp_bind_address6=2001:db8::77')
    expect(postfixOut.files[1]?.content).toContain('-o smtp_helo_name=mail.alice-shop.com')
  })
})
