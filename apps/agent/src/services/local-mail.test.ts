import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import { services } from '@xpanel/render'
import { FakeHostExecutor } from '../executor.ts'
import { applyPostfixLocalDelivery, ensureInstalledMail } from './local-mail.ts'

const os = {
  family: 'debian',
  id: 'ubuntu',
  versionId: '24.04',
  packageManager: 'apt',
  packages: {},
  services: { postfix: 'postfix.service', dovecot: 'dovecot.service' },
  phpPackages: () => [],
  phpFpmService: (version: string) => `php${version}-fpm`,
  phpFpmPoolDir: (version: string) => `/etc/php/${version}/fpm/pool.d`,
  phpFpmSocketDir: '/run/php',
  phpBinary: (version: string) => `/usr/bin/php${version}`,
  paths: { postfixDir: '/etc/postfix', dovecotDir: '/etc/dovecot' },
} as unknown as OsProfile

const seed = (executor: FakeHostExecutor, path: string, content: string): void => {
  executor.files.set(path, { path, content, mode: 0o644, owner: 'root', group: 'root' })
}

const backups = (executor: FakeHostExecutor, path: string): string[] =>
  [...executor.files.keys()].filter((key) => key.startsWith(`${path}.bak.`))

describe('live mail writer', () => {
  it('writes the OpenDKIM milter and special-use folders through applyPostfixLocalDelivery', async () => {
    const executor = new FakeHostExecutor()
    const main = '/etc/postfix/main.cf'
    const master = '/etc/postfix/master.cf'
    const folders = '/etc/dovecot/conf.d/15-mailboxes.conf'
    seed(executor, main, 'compatibility_level = 3.6\n')
    seed(executor, master, '# master\n')
    seed(executor, folders, 'namespace inbox {\n  inbox = yes\n}\n')

    await applyPostfixLocalDelivery(executor, os)

    const written = executor.files.get(main)?.content ?? ''
    expect(written).toContain('smtpd_milters = local:/run/opendkim/opendkim.sock')
    expect(written).toContain('non_smtpd_milters = local:/run/opendkim/opendkim.sock')
    expect(written).toContain('milter_protocol = 6')
    expect(written).toContain('milter_default_action = accept')
    expect(written).toContain('smtpd_sasl_auth_enable = no')
    expect(written).not.toContain('message_size_limit')
    expect(written).toContain('compatibility_level = 3.6')
    const special = executor.files.get(folders)?.content ?? ''
    expect(special).toContain('auto = subscribe')
    expect(special.match(/auto = /g)).toHaveLength(5)
    expect(special).toContain('special_use = \\Sent')
    expect(special).toContain('special_use = \\Drafts')
    expect(special).toContain('special_use = \\Junk')
    expect(special).toContain('special_use = \\Trash')
    expect(special).toContain('special_use = \\Archive')
    expect(special.match(/namespace inbox/g)).toHaveLength(1)
    const quota = executor.files.get('/etc/dovecot/conf.d/99-xpanel-quota.conf')?.content ?? ''
    expect(quota).toContain('quota = count:User quota')
    expect(quota).toContain('quota_vsizes = yes')
    expect(quota).toContain('mail_plugins = $mail_plugins quota')
    const mainBackups = backups(executor, main)
    expect(mainBackups).toHaveLength(1)
    expect(executor.files.get(mainBackups[0]!)?.content).toBe('compatibility_level = 3.6\n')
    expect(backups(executor, folders)).toHaveLength(1)

    const before = executor.files.size
    await applyPostfixLocalDelivery(executor, os)
    expect(executor.files.size).toBe(before)
    expect(backups(executor, main)).toHaveLength(1)
    expect(backups(executor, folders)).toHaveLength(1)
  })

  it('keeps the reconciler postmaster when the agent restarts without a dotted hostname', async () => {
    const executor = new FakeHostExecutor()
    seed(executor, '/etc/postfix/main.cf', 'compatibility_level = 3.6\n')
    seed(executor, '/etc/postfix/master.cf', '# master\n')
    const mailbox = '/etc/dovecot/conf.d/11-xpanel-mailboxes.conf'
    seed(executor, mailbox, 'protocol lmtp {\n  postmaster_address = postmaster@mail.example.test\n}\n')

    await ensureInstalledMail(executor, os)
    expect(executor.files.get(mailbox)?.content).toContain('postmaster_address = postmaster@mail.example.test')
    expect(executor.files.get('/etc/postfix/main.cf')?.content).toContain('smtpd_milters = local:/run/opendkim/opendkim.sock')

    const before = backups(executor, '/etc/postfix/main.cf').length
    await ensureInstalledMail(executor, os, 'localhost')
    expect(executor.files.get(mailbox)?.content).toContain('postmaster_address = postmaster@mail.example.test')
    expect(backups(executor, '/etc/postfix/main.cf')).toHaveLength(before)

    await ensureInstalledMail(executor, os, 'other.example.test')
    expect(executor.files.get(mailbox)?.content).toContain('postmaster_address = postmaster@other.example.test')
  })

  it('leaves a generation-owned mailbox file unchanged when a restart would differ', async () => {
    const executor = new FakeHostExecutor()
    seed(executor, '/etc/postfix/main.cf', 'compatibility_level = 3.6\n')
    seed(executor, '/etc/postfix/master.cf', '# master\n')
    const mailbox = services.renderDovecotMailboxConf(os, { postmaster: 'postmaster@mail.example.test' })
    seed(executor, mailbox.path, mailbox.content)
    const sha = createHash('sha256').update(mailbox.content, 'utf8').digest('hex')
    await ensureInstalledMail(executor, os, 'other.example.test', new Map([[mailbox.path, sha]]))
    expect(executor.files.get(mailbox.path)?.content).toBe(mailbox.content)
    expect(backups(executor, mailbox.path)).toHaveLength(0)
  })

  it('repairs a generation-owned mailbox file when the render matches the generation', async () => {
    const executor = new FakeHostExecutor()
    seed(executor, '/etc/postfix/main.cf', 'compatibility_level = 3.6\n')
    seed(executor, '/etc/postfix/master.cf', '# master\n')
    const mailbox = services.renderDovecotMailboxConf(os, { postmaster: 'postmaster@mail.example.test' })
    seed(executor, mailbox.path, 'protocol lmtp {\n  postmaster_address = postmaster@wrong.example.test\n}\n')
    const sha = createHash('sha256').update(mailbox.content, 'utf8').digest('hex')
    await ensureInstalledMail(executor, os, 'mail.example.test', new Map([[mailbox.path, sha]]))
    expect(executor.files.get(mailbox.path)?.content).toBe(mailbox.content)
  })
})
