import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderJailShellBinary } from './security-hardening.ts'
import { renderShellJail, SHELL_JAIL_ENTER, SHELL_JAIL_SUDOERS } from './shell-jail.ts'

const off = { privateTmp: false, hiddenHomes: false, systemView: false, exceptions: [] }

describe('shell jail', { tags: ['unit'] }, () => {
  it('renders nothing and leaves the login shell alone while every switch is off', () => {
    expect(renderShellJail(off, ['/home'])).toEqual({ files: [], tests: [], active: false })
    expect(renderJailShellBinary().content).not.toContain('sudo')
  })

  it('enters through one sudo rule that visudo checks, as root-owned files', () => {
    const jail = renderShellJail({ ...off, privateTmp: true }, ['/home'])
    const sudoers = jail.files.find(file => file.path === SHELL_JAIL_SUDOERS)!, script = jail.files.find(file => file.path === SHELL_JAIL_ENTER)!
    expect(jail.tests).toEqual([{ name: 'sudoers', argv: ['/usr/sbin/visudo', '-cf', SHELL_JAIL_SUDOERS] }])
    expect(sudoers).toMatchObject({ mode: 0o440, owner: 'root', group: 'root' })
    expect(sudoers.content).toContain('ALL ALL=(root) NOPASSWD: /usr/local/sbin/xpanel-jail-enter ""\n')
    expect(sudoers.content).toContain('closefrom=4')
    expect(sudoers.content.match(/NOPASSWD/g)).toHaveLength(1)
    expect(script).toMatchObject({ mode: 0o750, owner: 'root', group: 'root' })
    const jailshell = renderJailShellBinary(undefined, true).content
    expect(jailshell).toContain('exec /usr/bin/sudo -n /usr/local/sbin/xpanel-jail-enter\n')
    expect(jailshell).toContain('exec /usr/bin/sudo -n /usr/local/sbin/xpanel-jail-enter; }')
    expect(jailshell).not.toMatch(/xpanel-jail-enter [^;\n]/)
  })

  it('gives the root script no account argument, and brings the command back only past the privilege drop', () => {
    const script = renderShellJail({ ...off, hiddenHomes: true, exceptions: [{ username: 'alice', reason: 'x' }] }, ['/home']).files[0]!.content
    expect(script).not.toContain('"$@"')
    expect(script).toContain(`' xpanel-jail "$uid" "$gid" "$user" "$home"\n`)
    expect(script.match(/XPANEL_JAIL_ARGV=3 /g)).toHaveLength(2)
    const dir = mkdtempSync(join(tmpdir(), 'xpanel-jail-argv-'))
    try {
      const shell = join(dir, 'shell'), argv = join(dir, 'argv')
      writeFileSync(shell, '#!/bin/bash\nfor item in "$@"; do printf "[%s]" "$item"; done\nprintf "%s" "${XPANEL_JAIL_ARGV:-unset}"\n'); chmodSync(shell, 0o755)
      writeFileSync(argv, Buffer.from('-c\0a b; c\n\0\0'))
      const line = renderJailShellBinary(undefined, true).content.split('\n').find(item => item.includes('mapfile'))!
      const body = /-c '(.*)' \/opt/.exec(line)![1]!
      const run = spawnSync('/bin/bash', ['--norc', '--noprofile', '-c', body, shell], { env: { XPANEL_JAIL_ARGV: '3', PATH: process.env.PATH! }, stdio: ['ignore', 'pipe', 'pipe', openSync(argv, 'r')], encoding: 'utf8' })
      expect(run.stdout, run.stderr).toBe('[-c][a b; c\n][]unset')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('drops every privilege before the shell and refuses a caller outside the account range', () => {
    const script = renderShellJail({ ...off, privateTmp: true }, ['/home']).files[0]!.content
    expect(script).toContain('--inh-caps=-all --bounding-set=-all --no-new-privs')
    expect(script).toContain('[ "$uid" -lt 20000 ]')
    expect(script).toContain(`exec unshare --mount --propagation private -- /bin/sh -c '`)
    // The namespaced body is one single-quoted argument: a quote inside would end it.
    expect(script.slice(script.indexOf(`-c '`) + 4, script.lastIndexOf(`' xpanel-jail`))).not.toContain(`'`)
  })

  it('mounts only what each switch asks for', () => {
    const body = (policy: Partial<typeof off>) => renderShellJail({ ...off, ...policy }, ['/home', '/home2', '/home']).files[0]!.content
    expect(body({ privateTmp: true })).toContain('tmpfs /tmp')
    expect(body({ privateTmp: true })).not.toContain('mount --move')
    const hidden = body({ hiddenHomes: true })
    expect(hidden.match(/\[ ! -d \/home2? \]/g)).toHaveLength(2)
    expect(hidden.indexOf('mount --bind "$home" "$keep"')).toBeLessThan(hidden.indexOf('tmpfs /home'))
    expect(hidden).toContain('mount --move "$keep" "$home"')
    const view = body({ systemView: true })
    expect(view).toContain('hidepid=2')
    expect(view).toContain('mount --bind "$view/passwd" /etc/passwd')
    expect(view).toContain('tmpfs /etc/xpanel')
  })

  it('exempts a listed account from the namespace without keeping any privilege', () => {
    const script = renderShellJail({ ...off, hiddenHomes: true, exceptions: [{ username: 'alice', reason: 'x' }, { username: 'bob', reason: 'y' }] }, ['/home']).files[0]!.content
    expect(script).toContain('case "$user" in alice|bob)')
    expect(script.indexOf('case "$user"')).toBeLessThan(script.indexOf('exec unshare'))
  })

  it('refuses a base that is not a home root and an unsafe exception', () => {
    expect(() => renderShellJail({ ...off, hiddenHomes: true }, ['/etc'])).toThrow()
    expect(() => renderShellJail({ ...off, hiddenHomes: true, exceptions: [{ username: 'a b', reason: 'x' }] }, ['/home'])).toThrow()
  })
})
