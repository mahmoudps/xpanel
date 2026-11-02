import { describe, expect, it } from 'vitest'
import { applyObservedUserQuota, enableExistingUserQuota, observeUserQuota, parseUserQuotaState, validateQuotaFilesystem } from './quota.ts'
import type { QuotaCommandRunner } from './quota.ts'

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
const fixture = (initial: 'on' | 'off' = 'on') => {
  const commands: string[][] = []
  let state = initial
  const run: QuotaCommandRunner = async argv => {
    commands.push(argv)
    if (argv[0] === '/usr/bin/findmnt') return ok(({ TARGET: '/home', SOURCE: '/dev/loop7', FSTYPE: 'ext4' } as Record<string, string>)[argv[4]!]!)
    if (argv.includes('--print-state')) return { ok: state === 'off', code: state === 'on' ? 1 : 0, stdout: `user quota on /home (/dev/loop7) is ${state}\n`, stderr: '' }
    if (argv[0] === '/usr/sbin/quotaon') state = 'on'
    return ok()
  }
  return { run, commands }
}
const action = { kind: 'set-quota' as const, user: 'alice', filesystem: '/home', blockSoftKb: 1024, blockHardKb: 2048 }

describe('observed user quota enforcement', () => {
  it.each(['/home/../etc', 'home', '/home/', '/home;id', '/home\n'])('rejects unsafe filesystem %j before commands', value => {
    expect(() => validateQuotaFilesystem(value)).toThrow()
  })
  it('never treats empty, fake, duplicate or wrong-mount output as enabled', () => {
    for (const output of ['', '[jailshell] quotaon', 'user quota on /other (/dev/loop7) is on', 'user quota on /home (/dev/other) is on', 'user quota on /home (/dev/loop7) is on\nuser quota on /home (/dev/loop7) is on']) {
      expect(parseUserQuotaState(output, '/home', '/dev/loop7')).toBe('unavailable')
    }
  })
  it('observes the exact mount and applies limits only while enforcement remains enabled', async () => {
    const host = fixture()
    await applyObservedUserQuota(host.run, action)
    expect(host.commands.filter(argv => argv[0] === '/usr/sbin/setquota')).toEqual([
      ['/usr/sbin/setquota', '-u', 'alice', '1024', '2048', '0', '0', '/home'],
    ])
    expect(host.commands.filter(argv => argv.includes('--print-state'))).toHaveLength(2)
  })
  it.each([0, 2, 124])('rejects enabled text with incoherent exit status %s', async code => {
    const host = fixture()
    const result = await observeUserQuota(async argv => argv.includes('--print-state')
      ? { ok: code === 0, code, stdout: 'user quota on /home (/dev/loop7) is on\n', stderr: '' } : host.run(argv), '/home')
    expect(result.status).toBe('unavailable')
  })
  it('requires XFS enforcement and does not mistake accounting-only or nonverbose on for enforcement', async () => {
    const host = fixture()
    for (const [state, expected] of [['on (accounting)', 'disabled'], ['on', 'unavailable'], ['on (enforced)', 'enabled']] as const) {
      const result = await observeUserQuota(async argv => {
        if (argv[4] === 'FSTYPE') return ok('xfs')
        if (argv.includes('--print-state')) return { ok: false, code: 1, stdout: `user quota on /home (/dev/loop7) is ${state}\n`, stderr: '' }
        return host.run(argv)
      }, '/home')
      expect(result.status).toBe(expected)
    }
  })
  it('rejects disabled enforcement before any limit mutation', async () => {
    const host = fixture('off')
    await expect(applyObservedUserQuota(host.run, action)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(host.commands.some(argv => argv[0] === '/usr/sbin/setquota')).toBe(false)
  })
  it('treats failed post-mutation observation as unknown rather than success', async () => {
    const host = fixture()
    let changed = false
    await expect(applyObservedUserQuota(async argv => {
      if (argv[0] === '/usr/sbin/setquota') changed = true
      if (changed && argv[0] === '/usr/bin/findmnt') return { ...ok(), ok: false, code: 124 }
      return host.run(argv)
    }, action)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
  })
  it('does not modify an ancestor mount or unsupported filesystem', async () => {
    const host = fixture()
    const result = await observeUserQuota(async argv => argv[4] === 'TARGET' ? ok('/') : host.run(argv), '/home')
    expect(result).toMatchObject({ status: 'unavailable', reason: 'exact_mount_required' })
    const unsupported = await observeUserQuota(async argv => argv[4] === 'FSTYPE' ? ok('overlay') : host.run(argv), '/home')
    expect(unsupported).toMatchObject({ status: 'unavailable', reason: 'filesystem_not_supported' })
  })
  it('enables existing accounting once and performs no quota rebuild or remount', async () => {
    const host = fixture('off')
    expect((await enableExistingUserQuota(host.run, '/home')).status).toBe('enabled')
    await enableExistingUserQuota(host.run, '/home')
    expect(host.commands.filter(argv => argv[0] === '/usr/sbin/quotaon' && !argv.includes('--print-state'))).toEqual([
      ['/usr/sbin/quotaon', '--user', '/home'],
    ])
    expect(host.commands.some(argv => argv.some(arg => /quotacheck|remount/.test(arg)))).toBe(false)
  })
  it('rejects an unconfirmed enablement even when its command exits successfully', async () => {
    const host = fixture('off')
    await expect(enableExistingUserQuota(async argv => argv[0] === '/usr/sbin/quotaon' && !argv.includes('--print-state') ? ok() : host.run(argv), '/home'))
      .rejects.toMatchObject({ detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
