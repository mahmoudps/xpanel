import { describe, expect, it } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '../packages/core/src/index.ts'
import {
  SAFE_ARG,
  installBundle,
  installPlan,
  isSafeArg,
  profileFor,
  type InstallOptions,
} from '../packages/os/src/index.ts'
import { createTestStateStore } from '../packages/state/src/index.ts'
import { compileDesiredGeneration } from '../apps/agent/src/reconciler.ts'

const SHELL_METACHAR_RE = /[;&|<>`$(){}[\]*?~#\\\r\n\u0000-\u001f\u007f]/

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

describe('Portable Ubuntu and RHEL configuration plans (no host or browser proof)', () => {
  it('renders Ubuntu UID, slice and backend-port configuration without asserting host behavior', async () => {
    // 1. Compile the desired generation for xpalice (UID 29101) on Ubuntu 24.04 LTS
    const ubuntuOs = profileFor('ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n')
    const stateHandle = await createTestStateStore()
    try {
      const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
      await stateHandle.store.saveServerSettings({
        hostname: 'ubuntu24.xpanel.internal',
        nameservers: ['ns1.xpanel.internal', 'ns2.xpanel.internal'],
        adminEmail: 'root@xpanel.internal',
        engine: 'apache',
        apacheMpm: 'itk',
        panelPort: 2087,
        sshPort: 22,
        nginx: suggested.nginx,
        apache: suggested.apache,
        backendPort: 8080,
        backendTlsPort: 8443,
      })
      for (const rule of defaultFirewallRules({
        panelPort: 2087,
        sshPort: 22,
        backendPort: 8080,
        backendTlsPort: 8443,
      })) {
        await stateHandle.store.createFirewallRule(rule, { lockout: null })
      }
      const fl = await stateHandle.store.createFeatureList({
        name: 'Default',
        ownerId: null,
        disabled: [],
      })
      const plan = await stateHandle.store.createPlan({
        name: 'IsolatedPro',
        ownerId: null,
        featureListId: fl.id,
        resources: {
          diskMb: 10_240,
          bandwidthMbMonth: 102_400,
          ioReadBps: 50_000_000,
          ioWriteBps: 50_000_000,
          ioReadIops: 2000,
          ioWriteIops: 2000,
          memoryMb: 1024,
          maxProcesses: 64,
          cpuPercent: 200,
        },
        caps: {
          addonDomains: 10,
          aliasDomains: 10,
          subdomains: 20,
          mailboxes: 20,
          forwarders: 20,
          mailingLists: 5,
          ftpAccounts: 10,
          databases: 10,
          phpWorkers: 8,
        },
        dedicatedIp: false,
        shell: 'jailed',
        defaultMailboxQuotaMb: 1024,
      })
      await stateHandle.store.createAccount({
        username: 'xpalice',
        passwordHash: ARGON2,
        primaryDomain: 'xpalice.example.com',
        planId: plan.id,
        ownerId: null,
        contactEmail: 'xpalice@example.com',
        ipv4: '203.0.113.10',
        shell: 'jailed',
        php: {
          version: '8.3',
          handler: 'fpm',
          fpm: {
            mode: 'ondemand',
            maxChildren: 4,
            startServers: 2,
            minSpareServers: 1,
            maxSpareServers: 3,
            maxRequests: 500,
            processIdleTimeoutSec: 10,
          },
          ini: {},
        },
      })

      const rawSnapshot = await stateHandle.store.readSnapshot()
      const snapshot = {
        ...rawSnapshot,
        accounts: rawSnapshot.accounts.map((a) =>
          a.username === 'xpalice' ? { ...a, uid: 29101, gid: 29101 } : a,
        ),
      }
      const compiled = compileDesiredGeneration(snapshot, {
        os: ubuntuOs,
        ioDevices: ['/dev/sda'],
      })

      // Verify compiled Apache vhost has AssignUserId xpalice xpalice and PHP-FPM pool has user = xpalice
      const apacheVhost = compiled.files.find((f) => f.path.endsWith('xpanel-site-xpalice.example.com.conf'))
      expect(apacheVhost).toBeDefined()
      expect(apacheVhost!.content).toMatch(/AssignUserId xpalice xpalice/i)

      const fpmPool = compiled.files.find((f) => f.path.endsWith('xpalice.pool.conf'))
      expect(fpmPool).toBeDefined()
      expect(fpmPool!.content).toContain('user = xpalice')
      expect(fpmPool!.content).toContain('group = xpalice')

      // Verify compiled systemd cgroup v2 slice for xpalice (xpanel-29101.slice)
      const sliceFile = compiled.files.find((f) => f.path === '/etc/systemd/system/xpanel-29101.slice')
      expect(sliceFile).toBeDefined()
      expect(sliceFile!.content).toContain('MemoryMax=1024M')
      expect(sliceFile!.content).toContain('TasksMax=64')
      expect(sliceFile!.content).toContain('IOReadBandwidthMax=/dev/sda 50000000')
      expect(sliceFile!.content).toContain('IOWriteBandwidthMax=/dev/sda 50000000')

      // Verify compiled nftables firewall keeps Apache backend port 8080 closed to external interfaces
      const nftFile = compiled.files.find((f) => f.path === ubuntuOs.paths.nftablesConf)
      expect(nftFile).toBeDefined()
      expect(nftFile!.content).toContain('iif "lo" accept')
      expect(nftFile!.content).toContain('tcp dport { 8080, 8443, 12083, 12087, 12096 } drop comment "xpanel: backend is loopback-only"')
      expect(nftFile!.content).toContain('tcp dport 80 accept')
      expect(nftFile!.content).toContain('tcp dport 443 accept')
      expect(nftFile!.content).toContain('tcp dport 2087 accept')
      expect(nftFile!.content).toContain('tcp dport 2083 accept')
      expect(nftFile!.content).toContain('tcp dport 2096 accept')
      expect(nftFile!.content).toContain('ip saddr @xpanel_banned tcp dport { 22, 2087, 2083, 2096 } drop')
      expect(nftFile!.content).toContain('ip6 saddr @xpanel_banned6 tcp dport { 22, 2087, 2083, 2096 } drop')
      for (const port of [12083, 12087, 12096]) expect(nftFile!.content).not.toMatch(new RegExp(`^\\s*tcp dport ${port} accept`, 'm'))
      expect(nftFile!.content).toContain('tcp dport 22 accept')
      expect(nftFile!.content).toContain('tcp dport 8080 drop comment "web backend closed to the network"')
      // Confirm no unrestricted rule accepts 8080 on external interfaces
      expect(nftFile!.content).not.toMatch(/^\s*tcp dport 8080 accept/m)
    } finally {
      await stateHandle.close()
    }

  }, 30_000)

  it('renders CentOS Stream, AlmaLinux and Rocky Linux plans with safe argv vectors', async () => {
    const rhelReleases = [
      {
        label: 'CentOS Stream 9',
        osRelease: 'ID="centos"\nVERSION_ID="9"\nPLATFORM_ID="platform:el9"\nPRETTY_NAME="CentOS Stream 9"\n',
        expectedMajor: 9,
      },
      {
        label: 'CentOS Stream 10',
        osRelease: 'ID="centos"\nVERSION_ID="10"\nPLATFORM_ID="platform:el10"\nPRETTY_NAME="CentOS Stream 10"\n',
        expectedMajor: 10,
      },
      {
        label: 'AlmaLinux 9',
        osRelease: 'ID="almalinux"\nVERSION_ID="9.4"\nPLATFORM_ID="platform:el9"\nPRETTY_NAME="AlmaLinux 9.4"\n',
        expectedMajor: 9,
      },
      {
        label: 'Rocky Linux 9',
        osRelease: 'ID="rocky"\nVERSION_ID="9.4"\nPLATFORM_ID="platform:el9"\nPRETTY_NAME="Rocky Linux 9.4"\n',
        expectedMajor: 9,
      },
    ] as const

    const installOpts: InstallOptions = {
      engine: 'apache',
      apacheMpm: 'prefork',
      phpVersions: ['8.3'],
      withMail: true,
      withDns: true,
      withFtp: true,
      withModSecurity: true,
    }

    for (const rel of rhelReleases) {
      const profile = profileFor(rel.osRelease)
      expect(profile.family).toBe('rhel')
      expect(profile.packageManager).toBe('dnf')
      expect(profile.major).toBe(rel.expectedMajor)

      // Verify package mappings on dnf (rhel family)
      expect(profile.packages.apache).toContain('httpd')
      expect(profile.phpPackages('8.3')).toContain('php83-php-fpm')
      expect(profile.packages.mariadb).toContain('mariadb-server')
      expect(profile.packages.dovecot).toContain('dovecot')
      expect(profile.packages.postfix).toContain('postfix')
      expect(profile.packages.powerdns).toContain('pdns')
      expect(profile.packages.nftables).toContain('nftables')
      expect(profile.packages.quota).toContain('quota')

      const actions = installPlan(profile, installOpts)
      const bundle = installBundle(profile, installOpts)
      expect(actions.length).toBeGreaterThan(0)
      expect(bundle.files.some((f) => f.path === '/etc/httpd/conf/httpd.conf')).toBe(true)

      // Collect all installed package arguments across dnf install actions
      const dnfExecs = actions.filter(
        (a): a is Extract<typeof a, { kind: 'exec' }> => a.kind === 'exec' && a.argv[0] === '/usr/bin/dnf',
      )
      expect(dnfExecs.length).toBeGreaterThan(0)
      const allDnfArgs = dnfExecs.flatMap((a) => a.argv)
      expect(allDnfArgs).toContain('httpd')
      expect(allDnfArgs).toContain('php83-php-fpm')
      expect(allDnfArgs).toContain('mariadb-server')
      expect(allDnfArgs).toContain('dovecot')
      expect(allDnfArgs).toContain('postfix')
      expect(allDnfArgs).toContain('pdns')
      expect(allDnfArgs).toContain('nftables')
      expect(allDnfArgs).toContain('quota')

      // Every argv element in the install plan must be 100% shell-metacharacter-free
      for (const action of actions) {
        if (action.kind === 'exec') {
          expect(action.argv.length).toBeGreaterThan(0)
          for (const arg of action.argv) {
            expect(isSafeArg(arg)).toBe(true)
            expect(SAFE_ARG.test(arg)).toBe(true)
            expect(SHELL_METACHAR_RE.test(arg)).toBe(false)
          }
        }
      }

      // Compile a desired generation for this RHEL profile and verify all config tests and actions
      const stateHandle = await createTestStateStore()
      try {
        const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
        await stateHandle.store.saveServerSettings({
          hostname: 'el.xpanel.internal',
          nameservers: ['ns1.xpanel.internal', 'ns2.xpanel.internal'],
          adminEmail: 'ops@xpanel.internal',
          engine: 'apache',
          apacheMpm: 'itk',
          panelPort: 2087,
          sshPort: 22,
          nginx: suggested.nginx,
          apache: suggested.apache,
          backendPort: 8080,
          backendTlsPort: 8443,
        })
        for (const rule of defaultFirewallRules({
          panelPort: 2087,
          sshPort: 22,
          backendPort: 8080,
          backendTlsPort: 8443,
        })) {
          await stateHandle.store.createFirewallRule(rule, { lockout: null })
        }
        const fl = await stateHandle.store.createFeatureList({
          name: 'Default',
          ownerId: null,
          disabled: [],
        })
        const plan = await stateHandle.store.createPlan({
          name: 'RhelPlan',
          ownerId: null,
          featureListId: fl.id,
          resources: {
            diskMb: 10_240,
            bandwidthMbMonth: 102_400,
            ioReadBps: 50_000_000,
            ioWriteBps: 50_000_000,
            ioReadIops: 2000,
            ioWriteIops: 2000,
            memoryMb: 1024,
            maxProcesses: 64,
            cpuPercent: 200,
          },
          caps: {
            addonDomains: 5,
            aliasDomains: 5,
            subdomains: 10,
            mailboxes: 10,
            forwarders: 10,
            mailingLists: 2,
            ftpAccounts: 5,
            databases: 5,
            phpWorkers: 8,
          },
          dedicatedIp: false,
          shell: 'jailed',
          defaultMailboxQuotaMb: 1024,
        })
        await stateHandle.store.createAccount({
          username: 'eluser',
          passwordHash: ARGON2,
          primaryDomain: 'eluser.example.com',
          planId: plan.id,
          ownerId: null,
          contactEmail: 'eluser@example.com',
          ipv4: '203.0.113.20',
          shell: 'jailed',
          php: {
            version: '8.3',
            handler: 'fpm',
            fpm: {
              mode: 'ondemand',
              maxChildren: 4,
              startServers: 2,
              minSpareServers: 1,
              maxSpareServers: 3,
              maxRequests: 500,
              processIdleTimeoutSec: 10,
            },
            ini: {},
          },
        })

        const snapshot = await stateHandle.store.readSnapshot()
        const compiled = compileDesiredGeneration(snapshot, {
          os: profile,
          ioDevices: ['/dev/sda'],
        })

        const testNames = compiled.tests.map((t) => t.name)
        expect(testNames).toContain('nginx')
        expect(testNames).toContain('apache')
        expect(testNames).toContain('nftables')
        expect(testNames).toContain('sshd')

        for (const test of compiled.tests) {
          expect(test.argv.length).toBeGreaterThan(0)
          for (const arg of test.argv) {
            expect(SHELL_METACHAR_RE.test(arg)).toBe(false)
            expect(SAFE_ARG.test(arg)).toBe(true)
          }
        }
      } finally {
        await stateHandle.close()
      }
    }

  }, 30_000)
})
