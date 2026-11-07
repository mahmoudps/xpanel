import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultFirewallRules, suggestServerSettings } from '@xpanel/core'
import type { ServerSshSettings } from '@xpanel/core'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { compileDesiredGeneration } from './reconciler.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="22.04"\n')
const rules = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })
const jail = { privateTmp: false, hiddenHomes: false, systemView: false, exceptions: [] }
const ssh: ServerSshSettings = { passwordAuth: true, pubkeyAuth: true, rootLogin: 'no', loginAlarm: false, jail }
let state: TestStateStoreHandle
const save = async (patch: { ssh?: ServerSshSettings } = {}): Promise<void> => {
  const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443, ...patch })
}
const compiled = async () => compileDesiredGeneration(await state.store.readSnapshot(), { os })
const file = (generation: Awaited<ReturnType<typeof compiled>>, path: string) => generation.files.find(item => item.path === path)?.content
const NFT = os.paths.nftablesConf

beforeEach(async () => { state = await createTestStateStore() })
afterEach(async () => { await state.close() })

describe('host policy in a generation', () => {
  it('renders the saved sign-in policy and, by default, the policy the host always had', async () => {
    await save()
    expect(file(await compiled(), '/etc/ssh/sshd_config.d/00-xpanel.conf')).toContain('PasswordAuthentication no\n')
    await save({ ssh })
    const content = file(await compiled(), '/etc/ssh/sshd_config.d/00-xpanel.conf')
    expect(content).toContain('PasswordAuthentication yes\n')
    expect(content).toContain('PermitRootLogin no\n')
  })

  it('adds the shell jail, its sudoers test and the entry to the shell only when a switch is on', async () => {
    await save()
    const plain = await compiled()
    expect(file(plain, '/etc/sudoers.d/xpanel-shell-jail')).toBeUndefined()
    expect(file(plain, '/opt/xpanel/bin/jailshell')).not.toContain('sudo')
    await save({ ssh: { ...ssh, jail: { ...jail, privateTmp: true } } })
    const jailed = await compiled()
    expect(file(jailed, '/etc/sudoers.d/xpanel-shell-jail')).toContain('NOPASSWD')
    expect(file(jailed, '/usr/local/sbin/xpanel-jail-enter')).toContain('tmpfs /tmp')
    expect(file(jailed, '/opt/xpanel/bin/jailshell')).toContain('/usr/bin/sudo -n')
    expect(jailed.tests.map(test => test.name)).toContain('sudoers')
  })

  it('renders nothing for a firewall that never started, and carries the switch and the ping block otherwise', async () => {
    await save()
    expect(file(await compiled(), NFT)).toBeUndefined()
    await state.store.replaceFirewall({ rules: [], prefixLists: [], enabled: false, blockPing: true }, { lockout: null })
    expect(file(await compiled(), NFT)).toContain('xpanel: ping blocked')
    await state.store.replaceFirewall({ rules, prefixLists: [], enabled: true, blockPing: false }, { lockout: null })
    expect(file(await compiled(), NFT)).toContain('policy drop;')
    await state.store.replaceFirewall({ rules, prefixLists: [], enabled: false, blockPing: false }, { lockout: null })
    const off = file(await compiled(), NFT)
    expect(off).toContain('hook input priority filter; policy accept;')
    expect(off).not.toContain('tcp dport 2087 accept')
  })
})
