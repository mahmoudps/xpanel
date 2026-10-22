import { describe, expect, it } from 'vitest'
import {
  accountSliceCgroupPath,
  accountSliceName,
  describeWorkloadCgroupContract,
  parseCgroupControllers,
  renderAccountSlice,
  sliceEnforcement,
  sliceProperties,
  sliceUpdateActions,
} from '../system/slice.ts'
import {
  renderAppUnit,
  renderCronUnits,
  renderFpmUnit,
  renderLoginSliceDropin,
  verifyFpmUnitIsolation,
} from '../system/units.ts'
import {
  apacheMpmFile,
  assertHtaccessIsolation,
  inspectHtaccessIsolation,
  renderApacheBase,
  renderApacheMpm,
  renderApacheVhost,
  verifyApacheBackendIsolation,
} from './apache.ts'
import {
  assertNginxEdgeHeaderSanitization,
  assertNginxZeroHomeAccess,
  defaultSiteFile,
  renderDefaultSite,
  renderNginxMain,
  renderNginxSite,
  verifyNginxEdgeIsolation,
  type EdgeSettings,
} from './nginx.ts'
import {
  canIdentityConnectFpmSocket,
  renderFpmMaster,
  renderFpmPool,
  verifyFpmPoolIsolation,
} from './phpfpm.ts'
import { account, cert, codeOf, debianOs, domain, php, rhelOs, settings } from './testkit.ts'

const alice = account({ id: 'acc-alice', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.com' })
const bob = account({ id: 'acc-bob', username: 'bob', uid: 1002, gid: 1002, home: '/home/bob', primaryDomain: 'bob.example.com' })

const aliceDomain = domain({
  id: 'dom-alice',
  accountId: 'acc-alice',
  name: 'alice.example.com',
  docRoot: '/home/alice/public_html',
  php: php({ version: '8.3', handler: 'fpm' }),
})

const bobDomain = domain({
  id: 'dom-bob',
  accountId: 'acc-bob',
  name: 'bob.example.com',
  docRoot: '/home/bob/public_html',
  php: php({ version: '8.3', handler: 'fpm' }),
})

describe('H05: End-to-end hosting process topology & UID/GID isolation (A31, A35)', () => {
  it('binds Nginx -> Apache mpm_itk -> per-account PHP-FPM socket with matching UID/GID and slice', () => {
    const srv = settings({ engine: 'apache', apacheMpm: 'itk', backendPort: 8080 })

    const nginxProof = verifyNginxEdgeIsolation(alice, [aliceDomain], srv, debianOs)
    expect(nginxProof.zeroHomeAccess).toBe(true)
    expect(nginxProof.headersSanitized).toBe(true)
    expect(nginxProof.trustedProxiesConfigured).toBe(false)
    expect(nginxProof.cacheKeyIncludesHost).toBe(true)
    expect(nginxProof.defaultCatchall).toEqual({
      file: '/etc/nginx/conf.d/000-xpanel-default.conf',
      defaultServer80: true,
      defaultServer443: true,
      returns404: true,
      noProxyPass: true,
    })

    const apacheProof = verifyApacheBackendIsolation(alice, aliceDomain, srv, debianOs, { maxClientsVHost: 25 })
    expect(apacheProof.listenAddress).toBe('127.0.0.1:8080')
    expect(apacheProof.mpm).toBe('itk')
    expect(apacheProof.refusesMissingItk).toBe(true)
    expect(apacheProof.keepAliveOff).toBe(true)
    expect(apacheProof.defaultCatchallVhost).toEqual({
      file: '/etc/apache2/sites-enabled/000-xpanel-base.conf',
      documentRoot: '/usr/share/xpanel/default',
      allowOverrideNone: true,
      phpHandlerAbsent: true,
    })
    expect(apacheProof.tenantVhost).toEqual({
      file: '/etc/apache2/sites-enabled/xpanel-site-alice.example.com.conf',
      accountUsername: 'alice',
      assignUserId: 'alice alice',
      maxClientsVHost: 25,
      documentRoot: '/home/alice/public_html',
      fpmSocketPath: '/run/xpanel/fpm/alice-8.3/php-fpm.sock',
    })

    const fpmContract = verifyFpmPoolIsolation(alice, aliceDomain.php, debianOs, {
      workerCap: 10,
      maxMemoryMb: 512,
      apacheMpm: 'itk',
    })
    expect(fpmContract).toEqual({
      accountUsername: 'alice',
      uid: 1001,
      gid: 1001,
      version: '8.3',
      unit: 'xpanel-php-fpm-alice-8.3.service',
      slice: 'xpanel-1001.slice',
      runtimeDir: '/run/xpanel/fpm/alice-8.3',
      runtimeDirMode: '0750',
      socketPath: '/run/xpanel/fpm/alice-8.3/php-fpm.sock',
      listenOwner: 'alice',
      listenGroup: 'alice',
      listenMode: '0660',
      aclUsers: [],
      pmMode: 'ondemand',
      maxChildren: 5,
      openBasedir: ['/home/alice', '/home/alice/tmp'],
    })

    const unitRendered = renderFpmUnit(alice, '8.3', debianOs)
    const unitProof = verifyFpmUnitIsolation(alice, '8.3', unitRendered, debianOs)
    expect(unitProof.slice).toBe('xpanel-1001.slice')
    expect(unitProof.user).toBe('alice')
    expect(unitProof.group).toBe('alice')
    expect(unitProof.socketPath).toBe(apacheProof.tenantVhost.fpmSocketPath)
    expect(unitProof.noNewPrivileges).toBe(true)
    expect(unitProof.privateTmp).toBe(true)
    expect(unitProof.protectHome).toBe('tmpfs')
    expect(unitProof.protectSystem).toBe('strict')
    expect(unitProof.tcpListenDenied).toBe(true)
  })

  it('enforces kernel DAC EACCES when tenant B or Nginx attempts to connect to tenant A PHP-FPM socket', () => {
    const aliceFpm = verifyFpmPoolIsolation(alice, aliceDomain.php, debianOs, { apacheMpm: 'itk' })
    const bobFpm = verifyFpmPoolIsolation(bob, bobDomain.php, debianOs, { apacheMpm: 'itk' })

    // Alice's mpm_itk worker (UID 1001, GID 1001) can connect to Alice's socket
    expect(canIdentityConnectFpmSocket(aliceFpm, { username: 'alice', uid: 1001, gid: 1001 })).toMatchObject({
      allowed: true,
      errno: null,
    })

    // Bob's mpm_itk worker (UID 1002, GID 1002) is rejected with EACCES on Alice's socket
    const bobToAlice = canIdentityConnectFpmSocket(aliceFpm, { username: 'bob', uid: 1002, gid: 1002 })
    expect(bobToAlice.allowed).toBe(false)
    expect(bobToAlice.errno).toBe('EACCES')
    expect(bobToAlice.reason).toContain('Permission denied (EACCES)')

    // Alice's worker is rejected with EACCES on Bob's socket
    const aliceToBob = canIdentityConnectFpmSocket(bobFpm, { username: 'alice', uid: 1001, gid: 1001 })
    expect(aliceToBob.allowed).toBe(false)
    expect(aliceToBob.errno).toBe('EACCES')

    // Shared www-data / nginx worker (UID 33, GID 33) is rejected with EACCES under mpm_itk
    const nginxToAlice = canIdentityConnectFpmSocket(aliceFpm, { username: 'www-data', uid: 33, gid: 33 })
    expect(nginxToAlice.allowed).toBe(false)
    expect(nginxToAlice.errno).toBe('EACCES')

    // Under prefork only, the distribution's apacheUser gets explicit POSIX ACL access
    const preforkFpm = verifyFpmPoolIsolation(alice, aliceDomain.php, rhelOs, { apacheMpm: 'prefork' })
    expect(preforkFpm.aclUsers).toEqual(['apache'])
    expect(canIdentityConnectFpmSocket(preforkFpm, { username: 'apache', uid: 48, gid: 48 }).allowed).toBe(true)
    expect(canIdentityConnectFpmSocket(preforkFpm, { username: 'bob', uid: 1002, gid: 1002 }).errno).toBe('EACCES')
  })

  it('rejects cross-tenant FPM socket bindings, ProxyPass, RewriteRule [P], and identity directives in .htaccess', () => {
    const maliciousCases = [
      // Tenant B trying to point .htaccess at Tenant A's PHP-FPM socket
      '<FilesMatch "\\.php$">\n  SetHandler "proxy:unix:/run/xpanel/fpm/alice-8.3/php-fpm.sock|fcgi://localhost"\n</FilesMatch>',
      // Backslash line-continuation smuggling of SetHandler
      'SetHandler \\\n  "proxy:unix:/run/xpanel/fpm/alice-8.3/php-fpm.sock|fcgi://localhost"',
      // Attempting to proxy to a system or custom socket
      'AddHandler proxy:unix:/run/php/php8.3-fpm.sock|fcgi://localhost .php',
      // Attempting to proxy to loopback backend or another tenant's app port via RewriteRule [P]
      'RewriteEngine On\nRewriteRule ^api/(.*)$ http://127.0.0.1:3000/$1 [P,L]',
      'RewriteRule ^(.*\\.php)$ unix:/run/xpanel/fpm/alice-8.3/php-fpm.sock|fcgi://localhost/home/alice/public_html/$1 [NC,P]',
      // Attempting ProxyPass / ProxyPassMatch in .htaccess
      'ProxyPass /app http://127.0.0.1:8080/',
      'ProxyPassMatch ^/(.*\\.php)$ fcgi://127.0.0.1:9000/home/alice/public_html/$1',
      // Attempting to switch UID/GID or suexec wrapper in .htaccess
      'AssignUserId alice alice',
      'AssignUserID root root',
      'SuexecUserGroup alice alice',
      'FcgidWrapper /var/www/xpanel-cgi/alice/php8.3.fcgi .php',
      'Action xpanel-php83 /.xpanel-php/php8.3.cgi',
      'ScriptAlias /cgi-bin/ /home/alice/cgi-bin/',
    ]

    for (const payload of maliciousCases) {
      const violations = inspectHtaccessIsolation(bob, payload)
      expect(violations.length, payload).toBeGreaterThan(0)
      expect(codeOf(() => assertHtaccessIsolation(bob, payload)), payload).toBe('VALIDATION')
    }

    // Legitimate tenant .htaccess rules pass cleanly
    const cleanHtaccess = [
      '# Standard WordPress / Laravel rewrite rules',
      'RewriteEngine On',
      'RewriteCond %{REQUEST_FILENAME} !-f',
      'RewriteCond %{REQUEST_FILENAME} !-d',
      'RewriteRule ^ index.php [L]',
      'Header always set X-Frame-Options "SAMEORIGIN"',
      'Options -Indexes',
    ].join('\n')
    expect(inspectHtaccessIsolation(bob, cleanHtaccess)).toEqual([])
    expect(assertHtaccessIsolation(bob, cleanHtaccess)).toBe(cleanHtaccess)
  })
})

describe('H05: Backend bypass, forged Host/SNI, and Nginx edge isolation (A31, A35)', () => {
  it('enforces MaxClientsVHost and LimitUIDRange under mpm_itk and refuses missing mpm_itk', () => {
    const mpmContent = renderApacheMpm(settings(), {
      uidRange: [1000, 60000],
      gidRange: [1000, 60000],
      maxClientsVHost: 30,
    })
    expect(mpmContent).toContain('<IfModule !mpm_itk_module>')
    expect(mpmContent).toContain('Error "xPanel: mpm_itk is selected but not loaded; refusing to serve accounts as the shared Apache user"')
    expect(mpmContent).toContain('LimitUIDRange 1000 60000')
    expect(mpmContent).toContain('LimitGIDRange 1000 60000')
    expect(mpmContent).toContain('MaxClientsVHost 30')

    const vhostContent = renderApacheVhost(alice, aliceDomain, settings(), debianOs, { maxClientsVHost: 20 }).content
    expect(vhostContent).toContain('AssignUserId alice alice')
    expect(vhostContent).toContain('MaxClientsVHost 20')

    // Rejects MaxClientsVHost under prefork or above MaxRequestWorkers
    const preforkSettings = settings({ apacheMpm: 'prefork' })
    expect(codeOf(() => renderApacheMpm(preforkSettings, { maxClientsVHost: 20 }))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheVhost(alice, aliceDomain, preforkSettings, debianOs, { maxClientsVHost: 20 }))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheMpm(settings(), { maxClientsVHost: 999 }))).toBe('VALIDATION')
    expect(codeOf(() => renderApacheVhost(alice, aliceDomain, settings(), debianOs, { maxClientsVHost: 0 }))).toBe('VALIDATION')
  })

  it('catches forged Host headers on both Nginx (80/443) and Apache (127.0.0.1:8080) before any tenant vhost', () => {
    const edgeStrict: EdgeSettings = { ...settings(), edge: { sslRejectHandshake: true } }
    const nginxDefault = renderDefaultSite({ settings: edgeStrict })
    expect(nginxDefault).toContain('listen 80 default_server;')
    expect(nginxDefault).toContain('listen 443 ssl http2 default_server;')
    expect(nginxDefault).toContain('ssl_reject_handshake on;')
    expect(nginxDefault).toContain('return 404;')
    expect(nginxDefault).not.toContain('proxy_pass')

    const apacheBase = renderApacheBase(settings(), debianOs)
    const aliceVhost = renderApacheVhost(alice, aliceDomain, settings(), debianOs)
    const bobVhost = renderApacheVhost(bob, bobDomain, settings(), debianOs)

    // Lexicographical load order places 000-xpanel-base.conf first so Apache's name-based vhost
    // resolution routes any unknown/forged Host header to /usr/share/xpanel/default
    const loadOrder = [apacheBase.path, bobVhost.path, aliceVhost.path].sort()
    expect(loadOrder[0]).toBe('/etc/apache2/sites-enabled/000-xpanel-base.conf')
    expect(apacheBase.content).toContain('DocumentRoot "/usr/share/xpanel/default"')
    expect(apacheBase.content).toContain('AllowOverride None')
    expect(apacheBase.content).not.toContain('SetHandler')
    expect(apacheBase.content).not.toContain('AssignUserId')
  })

  it('verifies Nginx never touches /home and strips untrusted forwarded/Proxy headers', () => {
    const siteContent = renderNginxSite(alice, [aliceDomain], settings(), cert({ accountId: 'acc-alice' }))
    expect(() => assertNginxZeroHomeAccess(siteContent, ['/home', '/home2'])).not.toThrow()
    expect(() => assertNginxEdgeHeaderSanitization(siteContent)).not.toThrow()

    // Tampered Nginx configs referencing /home or missing Proxy header stripping are rejected
    expect(codeOf(() => assertNginxZeroHomeAccess('server { root /home/alice/public_html; }'))).toBe('VALIDATION')
    expect(codeOf(() => assertNginxZeroHomeAccess('server { alias /home2/bob/public_html/; }', ['/home', '/home2']))).toBe('VALIDATION')
    expect(codeOf(() => assertNginxZeroHomeAccess('server { root /var/www/html; }'))).toBe('VALIDATION')
    expect(codeOf(() => assertNginxEdgeHeaderSanitization('server { location / { proxy_pass http://127.0.0.1:8080; } }'))).toBe('VALIDATION')
  })
})

describe('H05: Per-account cgroup v2 slice isolation & workload boundary contracts (A32, A33, A41)', () => {
  const planLimits = {
    diskMb: 10240,
    bandwidthMbMonth: 102400,
    ioReadBps: 20971520,
    ioWriteBps: 10485760,
    ioReadIops: 2000,
    ioWriteIops: 1000,
    memoryMb: 1024,
    maxProcesses: 64,
    cpuPercent: 200,
  } as const

  it('renders xpanel-<uid>.slice with CPUWeight, CPUQuota, MemoryMax, MemoryHigh, MemorySwapMax=0, TasksMax, and IO*Max', () => {
    expect(accountSliceName(alice.uid)).toBe('xpanel-1001.slice')
    expect(accountSliceCgroupPath(alice.uid)).toBe('/sys/fs/cgroup/xpanel.slice/xpanel-1001.slice')

    const sliceFile = renderAccountSlice(alice, planLimits, ['/dev/sda', '259:0'], { cpuWeight: 200 })
    expect(sliceFile.path).toBe('/etc/systemd/system/xpanel-1001.slice')
    expect(sliceFile.content).toContain('MemoryAccounting=yes')
    expect(sliceFile.content).toContain('MemoryHigh=921M')
    expect(sliceFile.content).toContain('MemoryMax=1024M')
    expect(sliceFile.content).toContain('MemorySwapMax=0')
    expect(sliceFile.content).toContain('TasksAccounting=yes')
    expect(sliceFile.content).toContain('TasksMax=64')
    expect(sliceFile.content).toContain('CPUAccounting=yes')
    expect(sliceFile.content).toContain('CPUWeight=200')
    expect(sliceFile.content).toContain('CPUQuota=200%')
    expect(sliceFile.content).toContain('IOAccounting=yes')
    expect(sliceFile.content).toContain('IOReadBandwidthMax=/dev/sda 20971520')
    expect(sliceFile.content).toContain('IOReadBandwidthMax=/dev/block/259:0 20971520')
    expect(sliceFile.content).toContain('IOWriteBandwidthMax=/dev/sda 10485760')
    expect(sliceFile.content).toContain('IOReadIOPSMax=/dev/sda 2000')
    expect(sliceFile.content).toContain('IOWriteIOPSMax=/dev/sda 1000')

    const [scalarProps, devSda, devNvme] = sliceProperties(planLimits, ['/dev/sda', '259:0'], { cpuWeight: 200 })
    expect(scalarProps).toEqual({
      MemoryHigh: '921M',
      MemoryMax: '1024M',
      MemorySwapMax: '0',
      TasksMax: '64',
      CPUWeight: '200',
      CPUQuota: '200%',
    })
    expect(devSda?.IOReadBandwidthMax).toBe('/dev/sda 20971520')
    expect(devNvme?.IOWriteIOPSMax).toBe('/dev/block/259:0 1000')

    const updateActions = sliceUpdateActions(alice, planLimits, ['/dev/sda'], { cpuWeight: 200 })
    expect(updateActions).toHaveLength(2)
    expect(updateActions[0]).toMatchObject({ kind: 'systemd-set-property', unit: 'xpanel-1001.slice' })

    expect(codeOf(() => renderAccountSlice(alice, planLimits, ['/dev/sda'], { cpuWeight: 0 }))).toBe('VALIDATION')
    expect(codeOf(() => renderAccountSlice(alice, planLimits, ['/dev/sda'], { cpuWeight: 10001 }))).toBe('VALIDATION')
  })

  it('distinguishes cgroup-enforced account units (PHP-FPM, apps, cron, SSH) from shared Apache mpm_itk workers', () => {
    const fpmContract = describeWorkloadCgroupContract(alice, 'php-fpm', 'itk')
    expect(fpmContract).toEqual({
      workload: 'php-fpm',
      username: 'alice',
      effectiveUid: 1001,
      effectiveGid: 1001,
      slice: 'xpanel-1001.slice',
      cgroupPath: '/sys/fs/cgroup/xpanel.slice/xpanel-1001.slice',
      cgroupEnforced: true,
      isolatedMountNamespace: true,
      sharedProcessLimitation: null,
    })

    const appContract = describeWorkloadCgroupContract(alice, 'app', 'itk')
    expect(appContract.cgroupEnforced).toBe(true)
    expect(appContract.slice).toBe('xpanel-1001.slice')

    const cronContract = describeWorkloadCgroupContract(alice, 'cron', 'itk')
    expect(cronContract.cgroupEnforced).toBe(true)
    expect(cronContract.slice).toBe('xpanel-1001.slice')

    const sshContract = describeWorkloadCgroupContract(alice, 'ssh-login', 'itk')
    expect(sshContract).toMatchObject({
      workload: 'ssh-login',
      effectiveUid: 1001,
      effectiveGid: 1001,
      slice: 'user-1001.slice',
      cgroupEnforced: true,
      sharedProcessLimitation: null,
    })

    const apacheItkContract = describeWorkloadCgroupContract(alice, 'apache-itk', 'itk')
    expect(apacheItkContract.effectiveUid).toBe(1001)
    expect(apacheItkContract.effectiveGid).toBe(1001)
    expect(apacheItkContract.slice).toBe('system.slice')
    expect(apacheItkContract.cgroupEnforced).toBe(false)
    expect(apacheItkContract.sharedProcessLimitation).toContain('AssignUserId')

    const apacheCgiContract = describeWorkloadCgroupContract(alice, 'apache-cgi', 'itk')
    expect(apacheCgiContract.cgroupEnforced).toBe(false)
    expect(apacheCgiContract.sharedProcessLimitation).toContain('PHP-FPM')

    expect(codeOf(() => describeWorkloadCgroupContract(alice, 'apache-itk', 'prefork'))).toBe('VALIDATION')
  })

  it('binds PHP-FPM, Node/Python app, cron timer, and SSH logind drop-in to the account UID/GID and slice', () => {
    const fpmUnit = renderFpmUnit(alice, '8.3', debianOs)
    const appRendered = renderAppUnit(
      alice,
      {
        name: 'web',
        kind: 'node',
        port: 3100,
        execStart: ['/usr/bin/node', 'server.js'],
        workingDir: '/home/alice/app',
      },
      debianOs,
      { reservedPorts: [8080, 2087] },
    )
    const cronRendered = renderCronUnits(
      alice,
      { id: 'cleanup', schedule: '0 * * * *', command: 'php /home/alice/artisan schedule:run' },
      debianOs,
    )
    const loginDropin = renderLoginSliceDropin(alice, planLimits, ['/dev/sda'])

    for (const u of [fpmUnit.content, appRendered.unit.content, cronRendered.service.content]) {
      expect(u).toContain('User=alice')
      expect(u).toContain('Group=alice')
      expect(u).toContain('Slice=xpanel-1001.slice')
      expect(u).toContain('ProtectHome=tmpfs')
      expect(u).toContain('BindPaths=/home/alice')
      expect(u).toContain('NoNewPrivileges=yes')
    }

    expect(loginDropin.path).toBe('/etc/systemd/system/user-1001.slice.d/50-xpanel.conf')
    expect(loginDropin.content).toContain('MemoryMax=1024M')
    expect(loginDropin.content).toContain('TasksMax=64')

    // Missing cgroup controller reports applied: false with reason controller-unavailable (never fake success)
    const degraded = parseCgroupControllers('cpu memory pids')
    const enforcement = sliceEnforcement(planLimits, ['/dev/sda'], { controllers: degraded })
    expect(enforcement.memoryMb).toEqual({ applied: true, unlimited: false, value: '1024M' })
    expect(enforcement.ioReadBps).toEqual({ applied: false, reason: 'controller-unavailable' })
    expect(enforcement.ioWriteIops).toEqual({ applied: false, reason: 'controller-unavailable' })
  })
})
