import { createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { HostAction } from '@xpanel/core'
import { FakeHostExecutor } from '../executor.ts'
import { currentDkimSelector, ensureOpenDkimSigning, mailAuthZoneAdditions, parseOpenDkimSigning } from './opendkim-live.ts'

const backups = (executor: FakeHostExecutor, path: string): string[] =>
  [...executor.files.keys()].filter(key => key.startsWith(`${path}.bak.`))

describe('live OpenDKIM writer', () => {
  it('writes a 2048-bit domain key, the chroot socket, and the postfix group', async () => {
    const executor = new FakeHostExecutor()
    const argv: string[][] = []
    const run = executor.runAction.bind(executor)
    const verbs: string[] = []
    executor.runAction = async (action: HostAction) => {
      if (action.kind === 'exec') argv.push(action.argv)
      if (action.kind === 'systemd') verbs.push(`${action.verb} ${action.unit}`)
      await run(action)
    }
    executor.files.set('/etc/opendkim.conf', { path: '/etc/opendkim.conf', content: 'Syslog yes\n', mode: 0o644, owner: 'root', group: 'root' })
    const now = new Date('2026-10-24T00:00:00.000Z')
    const first = await ensureOpenDkimSigning(executor, ['Demo.Example.Test'], now)
    const selector = currentDkimSelector(now)
    expect(selector).toBe('xp202610')
    expect(first.signing.domains['demo.example.test']?.selector).toBe(selector)
    const keyPath = `/etc/opendkim/keys/demo.example.test/${selector}.private`
    const key = executor.files.get(keyPath)
    expect(key?.mode).toBe(0o600)
    expect(key?.owner).toBe('opendkim')
    expect(key?.group).toBe('opendkim')
    expect(createPublicKey(key?.content ?? '').asymmetricKeyDetails?.modulusLength).toBe(2048)
    const signing = executor.files.get('/etc/opendkim/signing.json')?.content ?? ''
    expect(signing).not.toContain('PRIVATE KEY')
    expect(parseOpenDkimSigning(signing).domains['demo.example.test']?.dnsTxt).toContain('v=DKIM1')
    expect(executor.files.get('/etc/opendkim/KeyTable')?.content).toContain(`${selector}._domainkey.demo.example.test demo.example.test:${selector}:${keyPath}`)
    expect(executor.files.get('/etc/opendkim/SigningTable')?.content).toContain(`*@demo.example.test`)
    expect(executor.files.get('/etc/opendkim/TrustedHosts')?.content).toContain('127.0.0.1')
    expect(executor.files.get('/etc/opendkim/TrustedHosts')?.content).toContain('demo.example.test')
    const conf = executor.files.get('/etc/opendkim.conf')?.content ?? ''
    expect(conf).toContain('Syslog yes')
    expect(conf).toContain('Socket local:/var/spool/postfix/opendkim/opendkim.sock')
    expect(conf).toContain('KeyTable refile:/etc/opendkim/KeyTable')
    expect(conf).toContain('SigningTable refile:/etc/opendkim/SigningTable')
    expect(executor.dirs.get('/var/spool/postfix/opendkim')).toEqual({ mode: 0o750, owner: 'opendkim', group: 'postfix' })
    expect(argv).toContainEqual(['/usr/sbin/usermod', '-a', '-G', 'opendkim', 'postfix'])
    expect(executor.units.get('opendkim.service')?.active).toBe(true)
    expect(verbs).toContain('restart opendkim.service')
    expect(verbs).not.toContain('reload opendkim.service')
    expect(executor.executedCommands.some(command => command[0] === '/usr/bin/systemctl' && command[1] === 'is-active' && command[2] === 'opendkim.service')).toBe(true)
    expect(backups(executor, '/etc/opendkim.conf')).toHaveLength(1)

    const again = await ensureOpenDkimSigning(executor, ['demo.example.test'], new Date('2026-11-02T00:00:00.000Z'))
    expect(again.signing.domains['demo.example.test']?.selector).toBe(selector)
    expect(backups(executor, '/etc/opendkim.conf')).toHaveLength(1)
    expect(executor.files.get(keyPath)?.content).toBe(key?.content)
    expect(verbs.filter(verb => verb === 'restart opendkim.service')).toHaveLength(1)
  })

  it('adds DKIM, SPF, and DMARC without replacing records the zone already has', () => {
    const signing = {
      domains: {
        'demo.example.test': { selector: 'xp202610', publicKeyPem: 'pem', dnsTxt: 'v=DKIM1; k=rsa; p=abc' },
      },
    }
    const added = mailAuthZoneAdditions('demo.example.test', [], signing)
    expect(added.map(record => [record.name, record.content])).toEqual([
      ['xp202610._domainkey', 'v=DKIM1; k=rsa; p=abc'],
      ['@', 'v=spf1 a mx ~all'],
      ['_dmarc', 'v=DMARC1; p=none'],
    ])
    const kept = mailAuthZoneAdditions('demo.example.test', [
      { name: '@', type: 'TXT', content: 'v=spf1 mx -all' },
      { name: '_dmarc', type: 'TXT', content: 'v=DMARC1; p=reject' },
      { name: 'xp202610._domainkey', type: 'TXT', content: 'v=DKIM1; k=rsa; p=abc' },
    ], signing)
    expect(kept).toEqual([])
  })
})
