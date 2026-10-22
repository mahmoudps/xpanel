// Compiler access: gcc and friends usable only by root and the xpanel-compilers group.
// chown/chmod follow symlinks, so /usr/bin/gcc -> gcc-12 -> x86_64-linux-gnu-gcc-12 restricts the real
// driver, which also closes the versioned names. Package updates restore 0755, so the reconciler
// re-applies these actions after every apt/dnf transaction (they are idempotent).
// This is a speed bump, not a sandbox: an account can still upload a binary built elsewhere.

import { fail } from '@xpanel/core'
import type { HostAction, OsProfile, Principal } from '@xpanel/core'
import { assertAbsPath, assertInt, assertUsername, invalid } from './validate.ts'

export const COMPILER_GROUP = 'xpanel-compilers'

/** Both families install the toolchain drivers under /usr/bin. */
export const DEFAULT_COMPILER_BINARIES: readonly string[] = [
  '/usr/bin/gcc',
  '/usr/bin/cc',
  '/usr/bin/g++',
  '/usr/bin/c++',
  '/usr/bin/make',
  '/usr/bin/as',
  '/usr/bin/ld',
  '/usr/bin/ld.bfd',
  '/usr/bin/ld.gold',
]

export interface CompilerLockOptions {
  /** system gid for xpanel-compilers (below 1000, so it never collides with an account) */
  gid: number
  /** binaries present on this host (the agent drops missing ones); defaults to the list above */
  binaries?: readonly string[]
}

export const compilerLockActions = (os: Pick<OsProfile, 'family'>, opts: CompilerLockOptions): HostAction[] => {
  if (os.family !== 'debian' && os.family !== 'rhel') return fail('UNSUPPORTED_OS', 'unknown os family', { family: os.family })
  const gid = assertInt('compiler group gid', opts.gid, 100, 999)
  const binaries = [...new Set((opts.binaries ?? DEFAULT_COMPILER_BINARIES).map((b) => assertAbsPath('compiler binary', b)))]
  if (binaries.length === 0) return invalid('no compiler binaries to restrict')
  return [
    { kind: 'ensure-group', name: COMPILER_GROUP, gid },
    ...binaries.flatMap((path): HostAction[] => [
      { kind: 'exec', argv: ['/usr/bin/chown', `root:${COMPILER_GROUP}`, path] },
      { kind: 'exec', argv: ['/usr/bin/chmod', '0750', path] },
    ]),
  ]
}

/**
 * Root-approved exception: adds or removes one account from xpanel-compilers. Running units keep their
 * old supplementary groups until restarted. `gpasswd -d` fails when the user is not a member, so
 * executors should treat that exit as success when revoking.
 */
export const compilerAccessActions = (username: string, grant: boolean, approvedBy: Principal): HostAction[] => {
  if (approvedBy.kind !== 'root') return fail('FORBIDDEN', 'only root may change compiler access', { by: approvedBy.kind })
  const user = assertUsername(username)
  return grant
    ? [{ kind: 'exec', argv: ['/usr/sbin/usermod', '--append', '--groups', COMPILER_GROUP, user] }]
    : [{ kind: 'exec', argv: ['/usr/bin/gpasswd', '--delete', user, COMPILER_GROUP] }]
}
