// Compiler Access (cPanel WHM "Compiler Access"): when restricted, the C/C++ compilers, assemblers
// and linkers are 0750 root:xpanel-compilers, so only root and the group's members can run them.
// Package updates reinstall them as 0755 root:root, so the same script runs from the package
// manager hook after every transaction and from every reconciliation (it is idempotent).
// This is a speed bump, not a sandbox: an account can still upload a binary built elsewhere.

import { fail } from '@xpanel/core'
import type { HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import { assertUsername } from './validate.ts'

export const COMPILER_GROUP = 'xpanel-compilers'
export const COMPILER_ACCESS_SCRIPT = '/usr/local/sbin/xpanel-compiler-access'
/** dpkg runs post-invoke after every unpack/configure/remove; the dnf plugin after matching packages. */
export const COMPILER_ACCESS_HOOKS = {
  debian: '/etc/dpkg/dpkg.cfg.d/xpanel-compiler-access',
  rhel: '/etc/dnf/plugins/post-transaction-actions.d/xpanel-compiler-access.action',
} as const
/** The commands whose effective permissions an observation reports. */
export const COMPILER_COMMANDS: readonly string[] = ['gcc', 'cc', 'c++', 'g++', 'as', 'ld']

// Debian installs the real drivers as <triplet>-gcc-<N> behind symlinks; EL installs plain names and
// <triplet>-redhat-linux-* hard links. Only regular files are changed, so a symlink never redirects a chmod.
const BINARY_GLOBS: readonly string[] = [
  '/usr/bin/gcc', '/usr/bin/gcc-[0-9]*', '/usr/bin/cc', '/usr/bin/c++', '/usr/bin/g++', '/usr/bin/g++-[0-9]*',
  '/usr/bin/as', '/usr/bin/ld', '/usr/bin/ld.bfd', '/usr/bin/ld.gold',
  ...['linux-gnu', 'redhat-linux'].flatMap(triplet => ['gcc', 'gcc-[0-9]*', 'g++', 'g++-[0-9]*', 'c++', 'as', 'ld', 'ld.bfd', 'ld.gold'].map(name => `/usr/bin/*-${triplet}-${name}`)),
]

export interface CompilerAccessInput {
  /** true: root and members only; false: give every compiler back to all users (0755 root:root) */
  restricted: boolean
  /** account usernames in the group; the caller has already left out accounts that must stay restricted */
  members: readonly string[]
  /** the package-manager hook directory exists (always on Debian; EL needs the dnf post-transaction-actions plugin) */
  packageHook: boolean
}

const script = (input: CompilerAccessInput): string => {
  const loop = (body: string[]): string[] => [`for f in ${BINARY_GLOBS.join(' ')}; do`, '  [ -f "$f" ] && [ ! -L "$f" ] || continue', ...body.map(line => '  ' + line), 'done']
  const lines = input.restricted
    ? [
        `# Managed by xPanel: Compiler Access, restricted to root and ${COMPILER_GROUP}.`,
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        'status=0',
        `getent group ${COMPILER_GROUP} >/dev/null 2>&1 || groupadd -r ${COMPILER_GROUP} || status=1`,
        `[ "\${1-}" = --hook ] || gpasswd -M '${input.members.join(',')}' ${COMPILER_GROUP} >/dev/null || status=1`,
        ...loop([
          `[ "$(stat -c %u:%G:%a "$f")" = 0:${COMPILER_GROUP}:750 ] && continue`,
          `chown root:${COMPILER_GROUP} "$f" && chmod 0750 "$f" || status=1`,
        ]),
      ]
    : [
        '# Managed by xPanel: Compiler Access, enabled for all users.',
        'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
        'status=0',
        // only files this tool restricted are given back; other local permissions are left alone
        ...loop([
          `[ "$(stat -c %G "$f")" = ${COMPILER_GROUP} ] || continue`,
          'chown root:root "$f" && chmod 0755 "$f" || status=1',
        ]),
        `[ "\${1-}" = --hook ] || [ "$status" != 0 ] || ! getent group ${COMPILER_GROUP} >/dev/null 2>&1 || groupdel ${COMPILER_GROUP} >/dev/null 2>&1 || true`,
      ]
  // A failing dpkg post-invoke hook fails the whole package transaction, so the hook never reports an error.
  return ['#!/bin/sh', ...lines, '[ "${1-}" = --hook ] && exit 0', 'exit "$status"', ''].join('\n')
}

const hookFile = (family: 'debian' | 'rhel'): RenderedFile => {
  const command = `${COMPILER_ACCESS_SCRIPT} --hook`
  const content = family === 'debian'
    // dpkg runs the value through sh -c; the test keeps a half-removed configuration from failing dpkg
    ? `# Managed by xPanel: re-applies Compiler Access after every dpkg run.\npost-invoke="if [ -x ${COMPILER_ACCESS_SCRIPT} ]; then ${command}; fi"\n`
    : `# Managed by xPanel: re-applies Compiler Access after compiler packages change.\ngcc*:in:${command}\nbinutils*:in:${command}\n`
  return { path: COMPILER_ACCESS_HOOKS[family], content, mode: 0o644, owner: 'root', group: 'root' }
}

/** The script, the package hook (restricted mode only) and the reconcile run of the script. */
export const renderCompilerAccess = (os: Pick<OsProfile, 'family'>, input: CompilerAccessInput): { files: RenderedFile[]; actions: HostAction[] } => {
  if (os.family !== 'debian' && os.family !== 'rhel') return fail('UNSUPPORTED_OS', 'unknown os family', { family: os.family })
  if (typeof input?.restricted !== 'boolean' || typeof input.packageHook !== 'boolean' || !Array.isArray(input.members)) return fail('VALIDATION', 'compiler access input is invalid')
  const members = [...new Set(input.members.map(name => assertUsername(name)))].sort()
  const files: RenderedFile[] = [{ path: COMPILER_ACCESS_SCRIPT, content: script({ ...input, members }), mode: 0o700, owner: 'root', group: 'root' }]
  if (input.restricted && input.packageHook) files.push(hookFile(os.family))
  return { files, actions: [{ kind: 'exec', argv: [COMPILER_ACCESS_SCRIPT] }] }
}
