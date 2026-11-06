import { describe, expect, it } from 'vitest'
import type { OsProfile } from '@xpanel/core'
import { XpanelError } from '@xpanel/core'
import { COMPILER_ACCESS_HOOKS, COMPILER_ACCESS_SCRIPT, renderCompilerAccess } from './compiler.ts'
import { debianOs, rhelOs } from './testkit.ts'

describe('renderCompilerAccess', { tags: ['unit'] }, () => {
  it('restricts every compiler, assembler and linker to root and the group, and sets the exact members', () => {
    const { files, actions } = renderCompilerAccess(debianOs, { restricted: true, members: ['bob', 'alice', 'bob'], packageHook: true })
    const body = files[0]!
    expect(body).toMatchObject({ path: COMPILER_ACCESS_SCRIPT, mode: 0o700, owner: 'root', group: 'root' })
    expect(body.content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(body.content).toContain("gpasswd -M 'alice,bob' xpanel-compilers")
    expect(body.content).toContain('groupadd -r xpanel-compilers')
    expect(body.content).toContain('chown root:xpanel-compilers "$f" && chmod 0750 "$f"')
    for (const glob of ['/usr/bin/gcc', '/usr/bin/gcc-[0-9]*', '/usr/bin/cc', '/usr/bin/c++', '/usr/bin/g++', '/usr/bin/as', '/usr/bin/ld', '/usr/bin/*-linux-gnu-gcc-[0-9]*', '/usr/bin/*-redhat-linux-g++']) expect(body.content).toContain(' ' + glob)
    // never the dynamic loader or make
    expect(body.content).not.toMatch(/ld\.\*|ld\.so|\/make\b/)
    expect(body.content).toContain('[ -f "$f" ] && [ ! -L "$f" ] || continue')
    expect(actions).toEqual([{ kind: 'exec', argv: [COMPILER_ACCESS_SCRIPT] }])
  })

  it('installs the dpkg post-invoke hook on Debian and the dnf post-transaction action on EL', () => {
    const debian = renderCompilerAccess(debianOs, { restricted: true, members: [], packageHook: true }).files[1]!
    expect(debian.path).toBe(COMPILER_ACCESS_HOOKS.debian)
    expect(debian.content).toContain(`post-invoke="if [ -x ${COMPILER_ACCESS_SCRIPT} ]; then ${COMPILER_ACCESS_SCRIPT} --hook; fi"`)
    const rhel = renderCompilerAccess(rhelOs, { restricted: true, members: [], packageHook: true }).files[1]!
    expect(rhel.path).toBe(COMPILER_ACCESS_HOOKS.rhel)
    expect(rhel.content).toContain(`gcc*:in:${COMPILER_ACCESS_SCRIPT} --hook\nbinutils*:in:${COMPILER_ACCESS_SCRIPT} --hook\n`)
    expect(renderCompilerAccess(rhelOs, { restricted: true, members: [], packageHook: false }).files.map(file => file.path)).toEqual([COMPILER_ACCESS_SCRIPT])
    expect(renderCompilerAccess(rhelOs, { restricted: true, members: [], packageHook: false }).files[0]!.content).toContain("gpasswd -M '' xpanel-compilers")
  })

  it('the hook never fails the package transaction, the reconcile run reports failures', () => {
    const { content } = renderCompilerAccess(debianOs, { restricted: true, members: ['alice'], packageHook: true }).files[0]!
    expect(content.trimEnd().split('\n').slice(-2)).toEqual(['[ "${1-}" = --hook ] && exit 0', 'exit "$status"'])
    expect(content).toContain('[ "${1-}" = --hook ] || gpasswd')
  })

  it('enabling for all gives back only the files this tool restricted and drops the hook', () => {
    const { files, actions } = renderCompilerAccess(debianOs, { restricted: false, members: ['alice'], packageHook: true })
    expect(files.map(file => file.path)).toEqual([COMPILER_ACCESS_SCRIPT])
    expect(files[0]!.content).toContain('[ "$(stat -c %G "$f")" = xpanel-compilers ] || continue')
    expect(files[0]!.content).toContain('chown root:root "$f" && chmod 0755 "$f"')
    expect(files[0]!.content).not.toContain('gpasswd')
    expect(actions).toEqual([{ kind: 'exec', argv: [COMPILER_ACCESS_SCRIPT] }])
  })

  it('refuses invalid members, input and unknown OS families', () => {
    for (const name of ['root', 'alice bob', "a'b", '-G', 'Alice']) {
      expect(() => renderCompilerAccess(debianOs, { restricted: true, members: [name], packageHook: true }), name).toThrowError(XpanelError)
    }
    expect(() => renderCompilerAccess(debianOs, { restricted: 'yes', members: [], packageHook: true } as never)).toThrowError(XpanelError)
    expect(() => renderCompilerAccess({ family: 'bsd' } as unknown as OsProfile, { restricted: true, members: [], packageHook: true })).toThrowError(XpanelError)
  })
})
