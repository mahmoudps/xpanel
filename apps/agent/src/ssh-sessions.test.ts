import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countLoginctlSshSessions,
  countWhoSshSessions,
  isProcSshSessionWorker,
  observeActiveSshSessions,
} from './ssh-sessions.ts'

describe('SSH active session observation', () => {
  it('identifies active sshd user session workers in /proc while ignoring master and privilege-separation processes', () => {
    const workerStatus = 'Name:\tsshd\nPPid:\t900\nUid:\t2005\t2005\t2005\t2005\n'
    const masterStatus = 'Name:\tsshd\nPPid:\t1\nUid:\t0\t0\t0\t0\n'
    expect(isProcSshSessionWorker(workerStatus, 'sshd: alice@pts/0\0', 'host')).toBe(true)
    expect(isProcSshSessionWorker(workerStatus, 'sshd: alice@pts/0\0', { uid: 2005, username: 'alice' })).toBe(true)
    expect(isProcSshSessionWorker(workerStatus, 'sshd: alice@pts/0\0', { uid: 2006, username: 'alice' })).toBe(false)
    expect(isProcSshSessionWorker(workerStatus, 'sshd: alice@pts/0\0', { uid: 2005, username: 'bob' })).toBe(false)
    expect(isProcSshSessionWorker(masterStatus, 'sshd: /usr/sbin/sshd -D\0', 'host')).toBe(false)
    expect(isProcSshSessionWorker(workerStatus, 'sshd: alice [priv]\0', 'host')).toBe(false)
    expect(isProcSshSessionWorker(workerStatus, 'sshd: [accepted]\0', 'host')).toBe(false)
  })

  it('counts loginctl and who SSH sessions scoped to host or account identity', () => {
    const loginctlJson = JSON.stringify([
      { session: '4', uid: 0, user: 'root', service: 'sshd', tty: 'pts/0', state: 'active' },
      { session: '7', uid: 2005, user: 'alice', service: 'sshd', tty: 'pts/1', state: 'active' },
      { session: '8', uid: 2005, user: 'alice', service: 'sshd', tty: 'pts/2', state: 'closing' },
      { session: '9', uid: 2005, user: 'alice', service: 'cron', tty: '', state: 'active' },
    ])
    expect(countLoginctlSshSessions(loginctlJson, 'host')).toBe(2)
    expect(countLoginctlSshSessions(loginctlJson, { uid: 2005, username: 'alice' })).toBe(1)
    expect(countLoginctlSshSessions('not-json', 'host')).toBeNull()

    const whoText = [
      'root     pts/0        2026-11-11 09:00 (198.51.100.10)',
      'alice    pts/1        2026-11-11 09:05 (198.51.100.25)',
      'alice    tty1         2026-11-11 09:06',
    ].join('\n')
    expect(countWhoSshSessions(whoText, 'host')).toBe(2)
    expect(countWhoSshSessions(whoText, { uid: 2005, username: 'alice' })).toBe(1)
  })

  it('reads from a proc directory when present and returns honest unavailable when no source is readable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xp-ssh-proc-'))
    try {
      await mkdir(join(dir, '1200'))
      await writeFile(join(dir, '1200', 'status'), 'Name:\tsshd-session\nPPid:\t800\nUid:\t2010\t2010\t2010\t2010\n')
      await writeFile(join(dir, '1200', 'cmdline'), 'sshd-session: dana@pts/0\0')
      await mkdir(join(dir, '1201'))
      await writeFile(join(dir, '1201', 'status'), 'Name:\tsshd-session\nPPid:\t800\nUid:\t0\t0\t0\t0\n')
      await writeFile(join(dir, '1201', 'cmdline'), 'sshd-session: root@pts/1\0')

      expect(await observeActiveSshSessions({ scope: 'host', procRoot: dir, run: null })).toEqual({ state: 'read', count: 2 })
      expect(await observeActiveSshSessions({ scope: { uid: 2010, username: 'dana' }, procRoot: dir, run: null })).toEqual({ state: 'read', count: 1 })
      expect(await observeActiveSshSessions({ scope: { uid: 2099, username: 'nobody' }, procRoot: dir, run: null })).toEqual({ state: 'read', count: 0 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }

    expect(await observeActiveSshSessions({ scope: 'host', procRoot: null, run: null })).toEqual({ state: 'unavailable', count: null })
    expect(await observeActiveSshSessions({
      scope: 'host',
      procRoot: null,
      run: async argv => argv[0]?.endsWith('loginctl')
        ? { ok: true, stdout: JSON.stringify([{ uid: 0, user: 'root', service: 'sshd', state: 'active' }]), stderr: '' }
        : { ok: false, stdout: '', stderr: 'unavailable' },
    })).toEqual({ state: 'read', count: 1 })
  })
})
