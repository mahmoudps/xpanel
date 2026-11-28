import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { compileDesiredGeneration } from './reconciler.ts'
import {
  DEFAULT_SSH_AUTOBAN_POLICY,
  enforceSshAutoban,
  PHP_FUNCTIONS_STATE,
  readGlobalPhpDisabledFunctions,
  readSshAutobanPolicy,
  SSH_AUTOBAN_BANS_STATE,
  SSH_AUTOBAN_STATE,
  toFirewallBans,
} from './ssh-autoban.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const PLACEHOLDER_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const emptySetJson = JSON.stringify({ nftables: [{ set: { family: 'inet', table: 'xpanel', name: 'xpanel_banned', elem: [] } }] })
const failedLine = (ip: string, tsSec: number, uid = '0') =>
  JSON.stringify({
    _UID: uid,
    _SYSTEMD_UNIT: 'ssh.service',
    _COMM: 'sshd',
    _EXE: '/usr/sbin/sshd',
    __REALTIME_TIMESTAMP: String(BigInt(tsSec) * 1_000_000n),
    MESSAGE: `Failed password for root from ${ip} port 44100 ssh2`,
  })

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'xp-ssh-autoban-'))
  await mkdir(join(root, 'extended/server'), { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('WHM security controls host enforcement', () => {
  it('reads global PHP disabled functions and fails closed on malformed policy files', async () => {
    expect(await readGlobalPhpDisabledFunctions(root)).toBeUndefined()
    await writeFile(join(root, PHP_FUNCTIONS_STATE), JSON.stringify({ version: 1, disabled: ['system', 'passthru'], updatedAt: '2026-11-28T00:00:00.000Z' }))
    expect(await readGlobalPhpDisabledFunctions(root)).toEqual(['passthru', 'system'])

    await writeFile(join(root, PHP_FUNCTIONS_STATE), '{"version":1,"disabled":["strlen"],"updatedAt":"2026-11-28T00:00:00.000Z"}')
    await expect(readGlobalPhpDisabledFunctions(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await writeFile(join(root, PHP_FUNCTIONS_STATE), '{not-json')
    await expect(readGlobalPhpDisabledFunctions(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('reads SSH auto-ban rules strictly with default fallback when absent', async () => {
    expect(await readSshAutobanPolicy(root)).toEqual(DEFAULT_SSH_AUTOBAN_POLICY)
    await writeFile(join(root, SSH_AUTOBAN_STATE), JSON.stringify({ version: 1, enabled: true, failures: 4, windowMin: 15, banMin: 120, updatedAt: '2026-11-28T00:00:00.000Z' }))
    expect(await readSshAutobanPolicy(root)).toEqual({ enabled: true, failures: 4, windowMin: 15, banMin: 120 })

    await writeFile(join(root, SSH_AUTOBAN_STATE), JSON.stringify({ version: 1, enabled: true, failures: 0, windowMin: 15, banMin: 120, updatedAt: '2026-11-28T00:00:00.000Z' }))
    await expect(readSshAutobanPolicy(root)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('enforces trusted sshd failures into nftables ban sets and clears managed bans when disabled', async () => {
    const nowDate = new Date('2026-11-28T04:00:00.000Z')
    const nowSec = Math.floor(nowDate.getTime() / 1000)
    await writeFile(join(root, SSH_AUTOBAN_STATE), JSON.stringify({ version: 1, enabled: true, failures: 3, windowMin: 10, banMin: 90, updatedAt: '2026-11-28T03:00:00.000Z' }))
    await writeFile(join(root, 'extended/server/sec-panel-access.json'), JSON.stringify({
      version: 1,
      policy: { listeners: { xpanel: [], xwhm: [{ cidr: '198.51.100.0/24', note: 'office' }], xmail: [] } },
      updatedAt: '2026-11-28T00:00:00.000Z',
    }))

    const journalLines = [
      failedLine('203.0.113.50', nowSec - 60),
      failedLine('203.0.113.50', nowSec - 40),
      failedLine('203.0.113.50', nowSec - 20),
      // Forged non-root journal line must never trigger a ban.
      failedLine('203.0.113.99', nowSec - 30, '20001'),
      failedLine('203.0.113.99', nowSec - 20, '20001'),
      failedLine('203.0.113.99', nowSec - 10, '20001'),
      // Allowlisted office CIDR and loopback must be skipped.
      failedLine('198.51.100.42', nowSec - 30),
      failedLine('198.51.100.42', nowSec - 20),
      failedLine('198.51.100.42', nowSec - 10),
      failedLine('127.0.0.1', nowSec - 30),
      failedLine('127.0.0.1', nowSec - 20),
      failedLine('127.0.0.1', nowSec - 10),
    ].join('\n')

    const liveBanned = new Set<string>()
    const calls: string[][] = []
    const executor = {
      runCommand: vi.fn(async (argv: string[]) => {
        calls.push(argv)
        if (argv[0] === '/usr/bin/journalctl') return { ok: true, code: 0, stdout: journalLines, stderr: '' }
        if (argv[0] === '/usr/sbin/nft' && argv[1] === '-j') {
          const elem = argv.at(-1) === 'xpanel_banned' ? [...liveBanned] : []
          return { ok: true, code: 0, stdout: JSON.stringify({ nftables: [{ set: { family: 'inet', table: 'xpanel', name: argv.at(-1), elem } }] }), stderr: '' }
        }
        if (argv[0] === '/usr/sbin/nft' && argv[1] === 'add') {
          liveBanned.add(argv[7]!)
          return { ok: true, code: 0, stdout: '', stderr: '' }
        }
        if (argv[0] === '/usr/sbin/nft' && argv[1] === 'delete') {
          liveBanned.delete(argv[7]!)
          return { ok: true, code: 0, stdout: '', stderr: '' }
        }
        return { ok: false, code: 1, stdout: '', stderr: 'unexpected' }
      }),
    }

    const enabledRes = await enforceSshAutoban({ rootDir: root, executor, os, now: () => nowDate })
    expect(enabledRes).toEqual({ enabled: true, banned: ['203.0.113.50'], unbanned: [] })
    expect(calls).toContainEqual(['/usr/sbin/nft', 'add', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '203.0.113.50', 'timeout', '5400s', '}'])
    const stored = JSON.parse(await readFile(join(root, SSH_AUTOBAN_BANS_STATE), 'utf8')) as Array<{ address: string; until: string }>
    expect(stored.map(item => item.address)).toEqual(['203.0.113.50'])
    expect(toFirewallBans(stored, nowDate)).toEqual([{ ip: '203.0.113.50', expiresAt: nowSec + 5400 }])

    // Disabling the policy removes panel-managed bans from nftables and clears state.
    await writeFile(join(root, SSH_AUTOBAN_STATE), JSON.stringify({ version: 1, enabled: false, failures: 3, windowMin: 10, banMin: 90, updatedAt: '2026-11-28T04:01:00.000Z' }))
    const disabledRes = await enforceSshAutoban({ rootDir: root, executor, os, now: () => nowDate })
    expect(disabledRes).toEqual({ enabled: false, banned: [], unbanned: ['203.0.113.50'] })
    expect(JSON.parse(await readFile(join(root, SSH_AUTOBAN_BANS_STATE), 'utf8'))).toEqual([])
    expect(liveBanned.size).toBe(0)
    expect(emptySetJson).toContain('xpanel_banned')
  })

  it('compiles globalPhpDisabled into FPM pools and sshAutoban timeout + active bans into nftables.conf', async () => {
    const stateHandle = await createTestStateStore()
    try {
      const now = new Date('2026-11-28T04:00:00.000Z')
      const suggested = suggestServerSettings({ cores: 2, memoryMb: 4096 })
      await stateHandle.store.saveServerSettings({
        hostname: 'panel.example.test',
        nameservers: ['ns1.example.test', 'ns2.example.test'],
        adminEmail: 'ops@example.test',
        engine: 'apache',
        apacheMpm: 'itk',
        panelPort: 2087,
        sshPort: 22,
        nginx: suggested.nginx,
        apache: suggested.apache,
        backendPort: 8080,
        backendTlsPort: 8443,
        phpFunctionExceptions: [{ account: 'alice', functions: ['exec'], reason: 'worker', grantedAt: now.toISOString(), grantedBy: 'root' }],
      })
      for (const rule of defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })) {
        await stateHandle.store.createFirewallRule(rule, { lockout: null })
      }
      const fl = await stateHandle.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
      const plan = await stateHandle.store.createPlan({
        name: 'Starter',
        ownerId: null,
        featureListId: fl.id,
        resources: { diskMb: 2048, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
        caps: { addonDomains: 2, aliasDomains: 2, subdomains: 5, mailboxes: 5, forwarders: 5, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 4 },
        dedicatedIp: false,
        shell: 'jailed',
        defaultMailboxQuotaMb: 256,
      })
      await stateHandle.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: 'panel.example.test', isPrimary: true, notes: '' })
      await stateHandle.store.createAccount({
        username: 'alice',
        passwordHash: PLACEHOLDER_HASH,
        primaryDomain: 'alice.example.test',
        planId: plan.id,
        ownerId: null,
        contactEmail: 'alice@example.test',
        ipv4: '203.0.113.10',
        shell: 'jailed',
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 30 }, ini: {} },
      })

      const snap = await stateHandle.store.readSnapshot()
      const compiled = compileDesiredGeneration(snap, {
        os,
        now,
        globalPhpDisabled: ['exec', 'system'],
        sshAutoban: {
          enabled: true,
          banTimeoutSec: 5400,
          activeBans: [{ ip: '203.0.113.50', expiresAt: Math.floor(now.getTime() / 1000) + 1200 }],
        },
      })

      const pool = compiled.files.find(file => file.path.includes('alice') && file.content.includes('php_admin_value[disable_functions]'))!.content
      const disabledLine = /php_admin_value\[disable_functions\] = ([^\n]+)/.exec(pool)![1]!.split(',')
      expect(disabledLine).toContain('system')
      expect(disabledLine).not.toContain('shell_exec')
      expect(disabledLine).not.toContain('exec')
      expect(disabledLine).toContain('openlog')

      const nft = compiled.files.find(file => file.path === '/etc/nftables.conf')!.content
      expect(nft).toContain('timeout 5400s')
      expect(nft).toContain('203.0.113.50 timeout 1200s')
    } finally {
      await stateHandle.close()
    }
  })
})
