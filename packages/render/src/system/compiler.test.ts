import { describe, expect, it } from 'vitest'
import type { HostAction, OsProfile } from '@xpanel/core'
import { XpanelError } from '@xpanel/core'
import { COMPILER_GROUP, compilerAccessActions, compilerLockActions, DEFAULT_COMPILER_BINARIES } from './compiler.ts'
import { debianOs, rhelOs } from './testkit.ts'

const root = { kind: 'root', id: 'r', username: 'root' } as const

describe('compilerLockActions', () => {
  it('creates the group and restricts every compiler to root and the group', () => {
    for (const os of [debianOs, rhelOs]) {
      const actions = compilerLockActions(os, { gid: 950 })
      expect(actions[0]).toEqual({ kind: 'ensure-group', name: COMPILER_GROUP, gid: 950 })
      const execs = actions.slice(1) as Extract<HostAction, { kind: 'exec' }>[]
      expect(execs).toHaveLength(DEFAULT_COMPILER_BINARIES.length * 2)
      for (const bin of ['/usr/bin/gcc', '/usr/bin/cc', '/usr/bin/g++', '/usr/bin/make', '/usr/bin/as', '/usr/bin/ld']) {
        expect(execs).toContainEqual({ kind: 'exec', argv: ['/usr/bin/chown', 'root:xpanel-compilers', bin] })
        expect(execs).toContainEqual({ kind: 'exec', argv: ['/usr/bin/chmod', '0750', bin] })
      }
      for (const a of execs) expect(a.runAsUser).toBeUndefined()
    }
  })

  it('takes the binaries the agent found, deduplicated and validated', () => {
    const actions = compilerLockActions(debianOs, { gid: 950, binaries: ['/usr/bin/clang', '/usr/bin/clang'] })
    expect(actions).toHaveLength(3)
    for (const binaries of [['gcc'], ['/usr/bin/gcc; rm -rf /'], ['/usr/bin/../../etc/shadow'], []]) {
      expect(() => compilerLockActions(debianOs, { gid: 950, binaries }), JSON.stringify(binaries)).toThrowError(XpanelError)
    }
  })

  it('keeps the group gid in the system range', () => {
    for (const gid of [0, 99, 1000, 1001, 1.5]) expect(() => compilerLockActions(debianOs, { gid }), String(gid)).toThrowError(XpanelError)
    expect(() => compilerLockActions({ family: 'bsd' } as unknown as OsProfile, { gid: 950 })).toThrowError(XpanelError)
  })
})

describe('compilerAccessActions', () => {
  it('grants and revokes membership for root-approved accounts', () => {
    expect(compilerAccessActions('alice', true, root)).toEqual([{ kind: 'exec', argv: ['/usr/sbin/usermod', '--append', '--groups', 'xpanel-compilers', 'alice'] }])
    expect(compilerAccessActions('alice', false, root)).toEqual([{ kind: 'exec', argv: ['/usr/bin/gpasswd', '--delete', 'alice', 'xpanel-compilers'] }])
  })

  it('refuses resellers, users and invalid names', () => {
    expect(() => compilerAccessActions('alice', true, { kind: 'reseller', id: 'x', username: 'res' })).toThrowError(XpanelError)
    expect(() => compilerAccessActions('alice', true, { kind: 'user', id: 'x', username: 'alice', accountId: 'a' })).toThrowError(XpanelError)
    for (const name of ['root', 'alice bob', '-G wheel', 'Alice']) expect(() => compilerAccessActions(name, true, root), name).toThrowError(XpanelError)
  })
})
