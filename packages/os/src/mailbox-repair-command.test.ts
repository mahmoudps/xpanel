import { describe, expect, it } from 'vitest'
import { MAILBOX_REPAIR_STEPS, isMailboxRepairCommand, mailboxRepairArgv, mailboxRepairCheckArgv } from './mailbox-repair-command.ts'

const alice = { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }

describe('mailbox repair grammar', () => {
  it('admits exactly the argv it builds', () => {
    for (const step of MAILBOX_REPAIR_STEPS) expect(isMailboxRepairCommand(mailboxRepairArgv(alice, step))).toBe(true)
    expect(isMailboxRepairCommand(mailboxRepairCheckArgv(alice))).toBe(true)
  })
  it('never follows a symlink as root and changes modes only as the account', () => {
    const owner = mailboxRepairArgv(alice, 'owner')
    expect(owner.slice(0, 2)).toEqual(['/usr/bin/find', '/home/alice/mail'])
    expect(owner).toContain('-execdir')
    expect(owner).toContain('-h')
    expect(owner).toEqual(expect.arrayContaining(['-links', '1']))
    for (const step of ['directories', 'files'] as const) expect(mailboxRepairArgv(alice, step).slice(0, 8)).toEqual(['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--clear-groups', '--no-new-privs', '--'])
  })
  it('refuses other trees, identities and edited commands', () => {
    expect(() => mailboxRepairArgv({ ...alice, home: '/root' }, 'owner')).toThrow()
    expect(() => mailboxRepairArgv({ ...alice, uid: 0 }, 'owner')).toThrow()
    expect(isMailboxRepairCommand(['/usr/bin/find', '/etc', '-print'])).toBe(false)
    const edited = mailboxRepairArgv(alice, 'owner'); edited[1] = '/home/alice/mail/../../etc'
    expect(isMailboxRepairCommand(edited)).toBe(false)
    const delete_ = mailboxRepairArgv(alice, 'owner'); delete_.splice(-1, 0, '-delete')
    expect(isMailboxRepairCommand(delete_)).toBe(false)
    expect(isMailboxRepairCommand(mailboxRepairArgv(alice, 'files').map(item => item === '1001' ? '0' : item))).toBe(false)
  })
})
