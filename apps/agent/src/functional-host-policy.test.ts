import { describe, expect, it } from 'vitest'
import { FakeHostExecutor, createProductionHostTargetMatcher } from './executor.ts'
import type { HostTargetOperation } from './executor.ts'
import { securityObservationCommands, isSecurityObservationCommand } from '@xpanel/os'
import { isMailQuarantineArgv, QUARANTINE_STATUS_FIELDS, QUARANTINE_SUMMARY_FIELDS, QUARANTINE_RAW_FIELDS, QUARANTINE_ID_FIELDS, quarantineStagePath, quarantineBayesPath } from '../../../packages/os/src/mail-quarantine-command.ts'

// Production path/argv policy with a declared memory-only executor. These tests
// perform no host file access, commands, native authentication or qualification.
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const operationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const otherId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const operations: HostTargetOperation[] = ['read', 'write', 'remove', 'ensure-directory']
const matcher = createProductionHostTargetMatcher()
const only = (path: string, allowed: readonly HostTargetOperation[]) => {
  for (const operation of operations) expect(matcher(path, operation), path + ' ' + operation).toBe(allowed.includes(operation))
}
const denied = (paths: readonly string[]) => { for (const path of paths) only(path, []) }

describe('functional production host target admission', () => {
  it('keeps SSH directories, compensatable files and retained backups distinct', () => {
    for (const path of ['/root/.ssh', '/var/lib/xpanel-agent/security']) only(path, ['ensure-directory'])
    for (const path of ['/root/.ssh/authorized_keys', '/var/lib/xpanel-agent/security/root-managed-keys.json', '/var/lib/xpanel-agent/security/root-key-write.json']) only(path, ['read', 'write', 'remove'])
    const suffix = '20261026150000000-' + operationId
    for (const path of ['/root/.ssh/authorized_keys.bak.' + suffix, '/var/lib/xpanel-agent/security/root-managed-keys.json.bak.' + suffix]) only(path, ['read', 'write'])
    denied(['/root/.ssh/id_ed25519', '/root/.ssh/authorized_keys/extra', '/root/.ssh/../authorized_keys', '/root/.ssh/authorized_keys.bak.' + '1'.repeat(17) + '-' + '-'.repeat(36), '/var/lib/xpanel-agent/security/arbitrary.json', '/var/lib/xpanel-agent/security/root-key-write.json.bak.' + suffix])
  })

  it('admits only backup scaffolding and exact disposable staging-file removal', () => {
    for (const path of ['/var/lib/xpanel/backups', '/var/lib/xpanel/backups/account-workspaces', '/var/lib/xpanel/backups/account-workspaces/' + accountId, '/var/lib/xpanel/backups/account-workspaces/' + accountId + '/alice', '/run/xpanel/account-restores', '/run/xpanel/account-restores/alice']) only(path, ['ensure-directory'])
    for (const path of ['/home/alice/.xpanel-backup-20261026T100000Z.tar.gz', '/home/alice/.xpanel-backup-20261026T100000Z-abcdef012345.tar.gz', '/run/xpanel/account-restores/alice/' + operationId + '.tar.gz']) only(path, ['remove'])
    denied(['/var/lib/xpanel/backups/account-workspaces/' + '-'.repeat(36), '/var/lib/xpanel/backups/account-workspaces/' + accountId + '/alice/extra', '/var/lib/xpanel/backups/account-workspaces/' + accountId.toUpperCase(), '/home/alice/arbitrary.txt', '/home/alice/.xpanel-backup-20261026T100000Z-ABCDEF012345.tar.gz', '/home/alice/../bob/.xpanel-backup-20261026T100000Z.tar.gz', '/run/xpanel/account-restores/alice/not-a-uuid.tar.gz', '/var/lib/xpanel/backups/account-workspaces/' + accountId + '/alice/archive.tar.gz'])
  })

  it('confines cron command files to their account directory and required suffix', () => {
    only('/etc/xpanel/cron', ['ensure-directory']); only('/etc/xpanel/cron/alice', ['ensure-directory'])
    only('/etc/xpanel/cron/alice/aaaaaaaaaaaa4aaa.command', ['read', 'write', 'remove'])
    denied(['/etc/xpanel/cron/alice/../bob/aaaaaaaaaaaa4aaa.command', '/etc/xpanel/cron/alice/aaaaaaaaaaaa4aaa.command/extra', '/etc/xpanel/cron/alice/aaaaaaaaaaaa4aaa.service', '/etc/xpanel/cron/alice/.command', '/etc/xpanel/cron/alice/command.txt', '/etc/xpanel/cron/ALICE/aaaaaaaaaaaa4aaa.command'])
  })

  it('keeps quarantine stage directories and exact canonical message files separate', () => {
    for (const path of ['/var/lib/xpanel/mail-quarantine', '/var/lib/xpanel/mail-quarantine/' + accountId, '/var/lib/xpanel/mail-quarantine/' + accountId + '/stage']) only(path, ['ensure-directory'])
    only(quarantineStagePath(accountId, operationId), ['read', 'write', 'remove'])
    denied(['/var/lib/xpanel/mail-quarantine/' + '-'.repeat(36), '/var/lib/xpanel/mail-quarantine/' + accountId.toUpperCase() + '/stage', quarantineStagePath(accountId, operationId) + '/extra', '/var/lib/xpanel/mail-quarantine/' + accountId + '/stage/' + operationId + '.json', '/var/lib/xpanel/mail-quarantine/' + accountId + '/stage/../' + operationId + '.eml', quarantineBayesPath(accountId)])
  })

  it('grants ACME key/order persistence and management status only their real operations', () => {
    for (const path of ['/var/lib/xpanel/acme-account', '/var/lib/xpanel/acme-orders']) only(path, ['ensure-directory'])
    only('/var/lib/xpanel/acme-account/account-key.pem', ['read', 'write'])
    only('/var/lib/xpanel/acme-orders/' + operationId + '.json', ['read', 'write'])
    only('/var/lib/xpanel-management-tls/status.json', ['read'])
    denied(['/var/lib/xpanel/acme-account/other.pem', '/var/lib/xpanel/acme-account/account-key.pem/extra', '/var/lib/xpanel/acme-orders/' + operationId.toUpperCase() + '.json', '/var/lib/xpanel/acme-orders/' + '-'.repeat(36) + '.json', '/var/lib/xpanel/acme-orders/../account-key.pem', '/var/lib/xpanel-management-tls/other.json'])
  })
})

describe('finite command exceptions through the shared argv validator', () => {
  it('admits fixed SSH observation literals without granting arbitrary unit/config/flag exceptions', async () => {
    const fake = new FakeHostExecutor(), commands = securityObservationCommands({ family: 'debian', services: { sshd: 'ssh' }, paths: { sshdConfig: '/etc/ssh/sshd_config' } })
    for (const argv of [commands.effective, commands.service, commands.failures]) { await fake.runCommand(argv); expect(fake.executedCommands).toContainEqual(argv) }
    for (const argv of [[...commands.service, '--property=ExecStart,User'], commands.service.map(arg => arg === 'ssh.service' ? 'nginx.service' : arg)]) {
      expect(isSecurityObservationCommand(argv)).toBe(false); await expect(fake.runCommand(argv)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(isSecurityObservationCommand(['/usr/sbin/sshd', '-T', '-f', '/tmp/custom'])).toBe(false)
    expect(isSecurityObservationCommand(['/usr/bin/systemctl', 'restart', 'ssh.service'])).toBe(false)
  })

  it('admits literal quarantine fields and bounds identity-qualified UID operations', async () => {
    const fake = new FakeHostExecutor(), mailbox = 'alice@example.test', guid = 'a'.repeat(32), message = 'b'.repeat(32)
    const summary = ['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', mailbox, QUARANTINE_SUMMARY_FIELDS, 'mailbox-guid', guid, 'uid', '1:100']
    const raw = ['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', mailbox, QUARANTINE_RAW_FIELDS, 'mailbox-guid', guid, 'uid', '1', 'guid', message]
    const learn = ['/usr/sbin/runuser', '-u', 'alice', '--', '/usr/bin/sa-learn', '--ham', '--dbpath', quarantineBayesPath(accountId), quarantineStagePath(accountId, operationId)]
    const accepted = [summary, raw, ['/usr/bin/doveadm', '-f', 'json', 'mailbox', 'status', '-u', mailbox, QUARANTINE_STATUS_FIELDS, 'Spam'], ['/usr/bin/doveadm', '-f', 'json', 'fetch', '-u', mailbox, QUARANTINE_ID_FIELDS, 'mailbox', 'INBOX', 'guid', message], ['/usr/bin/doveadm', 'move', '-u', mailbox, 'INBOX', 'mailbox-guid', guid, 'uid', '1', 'guid', message], ['/usr/bin/doveadm', 'expunge', '-u', mailbox, 'mailbox-guid', guid, 'uid', '1', 'guid', message], learn]
    for (const argv of accepted) { expect(isMailQuarantineArgv(argv)).toBe(true); await fake.runCommand(argv) }
    for (const argv of [summary.map(arg => arg === '1:100' ? '1:101' : arg), [...summary, 'guid', message], raw.slice(0, -2), raw.map(arg => arg === '1' ? '1:2' : arg), [...raw, 'stdin'], summary.map(arg => arg === mailbox ? mailbox + ';id' : arg)]) {
      expect(isMailQuarantineArgv(argv)).toBe(false); await expect(fake.runCommand(argv)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    // Safe tokens remain available to other trusted callers; this predicate is
    // the quarantine-specific identity boundary, not a general exec allowlist.
    expect(isMailQuarantineArgv(learn.map(arg => arg === quarantineStagePath(accountId, operationId) ? quarantineStagePath(otherId, operationId) : arg))).toBe(false)
  })

  it('preserves scalar cron commands and rejects punctuation outside reviewed grammars', async () => {
    const fake = new FakeHostExecutor(), unit = 'xpanel-cron-alice-aaaaaaaaaaaa4aaa.service', path = '/etc/systemd/system/' + unit
    fake.files.set(path, { path, content: '[Service]\nType=oneshot\n', mode: 0o644 })
    await fake.runCommand(['/usr/bin/systemctl', 'show', unit, '--property=LoadState', '--property=ActiveState', '--property=SubState', '--property=Result'])
    await fake.runCommand(['/usr/bin/systemctl', 'start', '--no-block', unit])
    for (const argv of [['/usr/bin/systemctl', 'start', '--no-block', unit + ';id'], ['/usr/bin/printf', QUARANTINE_STATUS_FIELDS], ['/usr/bin/printf', 'a,b']]) await expect(fake.runCommand(argv)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
