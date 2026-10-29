import { describe, expect, it } from 'vitest'
import { MAIL_QUEUE_LIST_ARGV, isMailQueueCommand, isMailQueueId, mailQueueActionArgv } from './mail-queue-command.ts'

describe('reviewed Postfix queue grammar', () => {
  it('admits exactly the listing, per-id postsuper actions and per-id deliver', () => {
    expect(isMailQueueCommand([...MAIL_QUEUE_LIST_ARGV])).toBe(true)
    for (const queue of ['incoming', 'active', 'deferred', 'hold'] as const) {
      for (const action of ['requeue', 'hold', 'release', 'delete'] as const) expect(isMailQueueCommand(mailQueueActionArgv(action, '4F2A1B3C9D', queue))).toBe(true)
    }
    expect(mailQueueActionArgv('delete', '4F2A1B3C9D', 'deferred')).toEqual(['/usr/sbin/postsuper', '-d', '4F2A1B3C9D', 'deferred'])
    expect(mailQueueActionArgv('release', '4F2A1B3C9D', 'hold')).toEqual(['/usr/sbin/postsuper', '-H', '4F2A1B3C9D', 'hold'])
    expect(mailQueueActionArgv('deliver', '3wbzPq1Ttkz5Zfx', 'deferred')).toEqual(['/usr/sbin/postqueue', '-i', '3wbzPq1Ttkz5Zfx'])
  })
  it('accepts short hex and long queue ids only', () => {
    for (const id of ['A1B2C3', '0123456789ABCDEF', '3wbzPq1Ttkz5Zfx', '4XyZbcdfgh']) expect(isMailQueueId(id)).toBe(true)
    for (const id of ['ALL', '-', '', 'a1b2c3', 'A1B2C', 'A1B2C3*', 'A1B2C3!', '3wbzPq1Ttkz5Zfx\n', 'aeiouAEIOU', '../hold', '-d', 'G'.repeat(27), 7]) expect(isMailQueueId(id)).toBe(false)
  })
  it('refuses ALL, stdin, option injection, extra operands and unknown queues', () => {
    for (const argv of [
      ['/usr/sbin/postsuper', '-d', 'ALL'], ['/usr/sbin/postsuper', '-d', 'ALL', 'deferred'], ['/usr/sbin/postsuper', '-d', '-', 'deferred'],
      ['/usr/sbin/postsuper', '-d', 'A1B2C3'], ['/usr/sbin/postsuper', '-d', 'A1B2C3', 'maildrop'], ['/usr/sbin/postsuper', '-d', 'A1B2C3', 'corrupt'],
      ['/usr/sbin/postsuper', '-d', 'A1B2C3', '/var/spool/postfix/deferred'], ['/usr/sbin/postsuper', '-s'], ['/usr/sbin/postsuper', '-p'],
      ['/usr/sbin/postsuper', '-e', 'A1B2C3', 'deferred'], ['/usr/sbin/postsuper', '-f', 'A1B2C3', 'deferred'],
      ['/usr/sbin/postsuper', '-c', '/tmp', '-d', 'A1B2C3', 'deferred'], ['/usr/sbin/postsuper', '-d', 'A1B2C3', 'deferred', 'hold'],
      ['/usr/sbin/postqueue', '-f'], ['/usr/sbin/postqueue', '-p'], ['/usr/sbin/postqueue', '-s', 'example.test'], ['/usr/sbin/postqueue', '-j', '-v'],
      ['/usr/sbin/postqueue', '-c', '/tmp', '-j'], ['/usr/sbin/postqueue', '-i', 'ALL'], ['/usr/sbin/postqueue', '-i', '-'], ['/usr/sbin/postqueue', '-i', 'A1B2C3', 'deferred'],
      ['postqueue', '-j'], ['/usr/bin/postqueue', '-j'], ['/bin/sh', '-c', 'postqueue -j'], [], ['/usr/sbin/postqueue', 7],
    ]) expect(isMailQueueCommand(argv)).toBe(false)
    expect(() => mailQueueActionArgv('delete', 'ALL', 'deferred')).toThrow()
    expect(() => mailQueueActionArgv('delete', 'A1B2C3', 'maildrop' as never)).toThrow()
    expect(() => mailQueueActionArgv('flush' as never, 'A1B2C3', 'deferred')).toThrow()
  })
})
