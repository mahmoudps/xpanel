// Traceroute Access and Shell Fork Bomb Protection (WHM Security Center). Both are host files applied by
// reconcile, so a change that a package update or an operator reverts shows as drift and returns on the next run.

import { fail } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { assertUsername } from './validate.ts'

export const TRACEROUTE_ACCESS_SCRIPT = '/usr/local/sbin/xpanel-traceroute-access'
/** Debian installs the real tools as *.db behind alternatives; EL installs plain names. Symlinks are never followed. */
export const TRACEROUTE_BINARIES: readonly string[] = ['/usr/bin/traceroute', '/usr/bin/traceroute6', '/usr/bin/traceroute.db', '/usr/bin/traceroute6.db', '/usr/bin/tcptraceroute.db', '/usr/bin/tracepath', '/usr/bin/tracepath6', '/bin/traceroute', '/usr/sbin/traceroute']
export const TRACEROUTE_MODE_ALLOWED = 0o755
export const TRACEROUTE_MODE_BLOCKED = 0o700

/** The script and its run; `allowed` false leaves the tools to root only, as cPanel's mode 0700. */
export const renderTracerouteAccess = (allowed: boolean): { file: RenderedFile; actions: HostAction[] } => {
  if (typeof allowed !== 'boolean') return fail('VALIDATION', 'traceroute access input is invalid')
  const mode = (allowed ? TRACEROUTE_MODE_ALLOWED : TRACEROUTE_MODE_BLOCKED).toString(8)
  const content = [
    '#!/bin/sh',
    `# Managed by xPanel: Traceroute Access, ${allowed ? 'open to all users' : 'root only'}.`,
    'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    'status=0',
    `for f in ${TRACEROUTE_BINARIES.join(' ')}; do`,
    '  [ -f "$f" ] && [ ! -L "$f" ] || continue',
    `  [ "$(stat -c %a "$f")" = ${mode} ] && continue`,
    `  chown root:root "$f" && chmod 0${mode} "$f" || status=1`,
    'done',
    'exit "$status"',
    '',
  ].join('\n')
  return { file: { path: TRACEROUTE_ACCESS_SCRIPT, content, mode: 0o700, owner: 'root', group: 'root' }, actions: [{ kind: 'exec', argv: [TRACEROUTE_ACCESS_SCRIPT] }] }
}

export const FORK_BOMB_LIMITS_FILE = '/etc/security/limits.d/90-xpanel-fork-bomb.conf'
/** cPanel's values. pam_limits(8) units: KB except nofile and nproc. RSS is left out because Linux does not enforce RLIMIT_RSS. */
export const FORK_BOMB_LIMITS = Object.freeze({ core: 200_000, data: 200_000, nofile: 100, stack: 8192, nproc: 35 })
/** The same limits for a session systemd starts directly (no PAM): systemd takes bytes. */
export const forkBombSystemdLimits = (): string[] => [
  `LimitCORE=${FORK_BOMB_LIMITS.core * 1024}`, `LimitDATA=${FORK_BOMB_LIMITS.data * 1024}`, `LimitNOFILE=${FORK_BOMB_LIMITS.nofile}`,
  `LimitSTACK=${FORK_BOMB_LIMITS.stack * 1024}`, `LimitNPROC=${FORK_BOMB_LIMITS.nproc}`,
]

/** pam_limits entries for each shell account, so every PAM session (SSH included) carries them and root stays unlimited. */
export const renderForkBombLimits = (usernames: readonly string[]): RenderedFile => {
  const users = [...new Set(usernames.map(name => assertUsername(name)))].sort()
  const lines = users.flatMap(user => Object.entries(FORK_BOMB_LIMITS).map(([item, value]) => `${user} - ${item} ${value}`))
  return { path: FORK_BOMB_LIMITS_FILE, content: ['# Managed by xPanel: Shell Fork Bomb Protection', ...lines, ''].join('\n'), mode: 0o644, owner: 'root', group: 'root' }
}
