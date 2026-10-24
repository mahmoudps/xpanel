import { describe, expect, it } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { ioDeviceForMount, ioDevicesByAccount, resolveAccountIoDevices, resolveHomeIoDevice } from './io-device.ts'
import { compileDesiredGeneration } from './reconciler.ts'

const mountinfo = [
  '36 35 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
  '37 36 8:2 / /home rw,relatime - ext4 /dev/sda2 rw',
  '38 36 0:40 / /dev rw - devtmpfs none rw',
].join('\n')

describe('account home IO device', () => {
  it('uses the longest mount that holds the home path', () => {
    expect(ioDeviceForMount(mountinfo, '/home')).toBe('/dev/block/8:2')
    expect(ioDeviceForMount(mountinfo, '/home/alice')).toBe('/dev/block/8:2')
    expect(ioDeviceForMount(mountinfo, '/')).toBe('/dev/block/8:1')
    expect(ioDeviceForMount('not mountinfo', '/home')).toBeNull()
  })

  it('returns a device only when the io controller is delegated', async () => {
    const executor = new FakeHostExecutor()
    const file = (path: string, content: string) => {
      executor.files.set(path, { path, content, mode: 0o644, owner: 'root', group: 'root' })
    }
    file('/proc/self/mountinfo', `${mountinfo}\n`)
    file('/sys/fs/cgroup/cgroup.subtree_control', 'cpu memory pids\n')
    expect(await resolveHomeIoDevice(executor, '/home')).toBeNull()
    file('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control', 'cpu io memory pids\n')
    expect(await resolveHomeIoDevice(executor, '/home')).toBe('/dev/block/8:2')
  })

  it('resolves a device per home and leaves an unmounted home unset', async () => {
    const split = [
      '37 36 8:2 / /home rw,relatime - ext4 /dev/sda2 rw',
      '39 36 8:3 / /data rw,relatime - ext4 /dev/sda3 rw',
      '38 36 0:40 / /dev rw - devtmpfs none rw',
    ].join('\n')
    const accounts = [
      { id: 'alice', username: 'alice', home: '/home/alice' },
      { id: 'bob', username: 'bob', home: '/data/mail/bob' },
      { id: 'cara', username: 'cara', home: '/srv/cara' },
    ]
    const devices = ioDevicesByAccount(split, accounts, '/home')
    expect(devices.get('alice')).toEqual(['/dev/block/8:2'])
    expect(devices.get('bob')).toEqual(['/dev/block/8:3'])
    expect(devices.get('cara')).toEqual([])
    expect(ioDevicesByAccount(split, [{ id: 'qu', username: 'qu', home: '' }], '/data').get('qu')).toEqual(['/dev/block/8:3'])

    const state = await createTestStateStore()
    const features = await state.store.createFeatureList({ name: 'Fixture', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Fixture', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10_000_000, ioWriteBps: 10_000_000,
        ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 100 },
      caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1,
        mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1024,
    })
    const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({
      hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com',
      engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
      nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443,
    })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const php = { version: '8.3' as const, handler: 'fpm' as const, ini: {}, fpm: { mode: 'ondemand' as const, maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 500, processIdleTimeoutSec: 10 } }
    const alice = await state.store.createAccount({ username: 'alice', passwordHash, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'a@alice.example.com', ipv4: '203.0.113.10', shell: 'none', php })
    const cara = await state.store.createAccount({ username: 'cara', passwordHash, primaryDomain: 'cara.example.com', planId: plan.id, ownerId: null, contactEmail: 'c@cara.example.com', ipv4: '203.0.113.10', shell: 'none', php })
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    const byAccount = new Map<string, string[]>([
      [alice.id, ['/dev/block/8:2']],
      [cara.id, []],
    ])
    const compiled = compileDesiredGeneration(await state.store.readSnapshot(), { os, ioDevicesByAccount: byAccount })
    const slice = (username: string) => compiled.files.find(file => file.path.endsWith('.slice') && file.content.includes(`account ${username}`))
    expect(slice('alice')?.content).toContain('IOWriteBandwidthMax=/dev/block/8:2')
    expect(slice('cara')?.content).not.toContain('IOWriteBandwidthMax=')
    await state.close()

    const executor = new FakeHostExecutor()
    const file = (path: string, content: string) => {
      executor.files.set(path, { path, content, mode: 0o644, owner: 'root', group: 'root' })
    }
    file('/proc/self/mountinfo', `${split}\n`)
    file('/sys/fs/cgroup/cgroup.subtree_control', 'cpu memory pids\n')
    expect(await resolveAccountIoDevices(executor, accounts, '/home')).toBeNull()
    file('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control', 'cpu io memory pids\n')
    const resolved = await resolveAccountIoDevices(executor, accounts, '/home')
    expect(resolved?.get('alice')).toEqual(['/dev/block/8:2'])
    expect(resolved?.get('cara')).toEqual([])
  })
})
