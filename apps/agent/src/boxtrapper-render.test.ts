import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { services } from '@xpanel/render'
import { BOXTRAPPER_DEFAULTS, BOXTRAPPER_DEFAULT_TEMPLATES, boxTrapperRules, parseBoxTrapperConfig } from './boxtrapper-policy.ts'
import { boxTrapperProgram, boxTrapperStateDir, boxTrapperStore, readBoxTrapperRows } from './boxtrapper-render.ts'
import { admitMailxMailboxRows } from './mailfx-render.ts'
import { handleBoxTrapperRoute } from './boxtrapper-routes.ts'

const os = { paths: { dovecotDir: '/etc/dovecot' } } as never
const ACC = '22222222-2222-4222-8222-222222222222', SU = '33333333-3333-4333-8333-333333333333'
const account = { username: 'alice', uid: 2001, gid: 2001, home: '/home/alice' }
const rules = boxTrapperRules({ ...BOXTRAPPER_DEFAULTS, enabled: true }, 'me@alice.test', boxTrapperStore('/home/alice', 'me@alice.test'), false)
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('BoxTrapper host render', { tags: ['unit'] }, () => {
  it('renders nothing without input, and only the program while no mailbox has it on', () => {
    expect(services.renderBoxTrapper(os, undefined)).toEqual({ files: [], preActions: [], postActions: [], execute: false })
    const idle = services.renderBoxTrapper(os, { program: '#!x', mailboxes: [] })
    expect(idle.execute).toBe(false)
    expect(idle.files).toEqual([{ path: services.BOXTRAPPER_PROGRAM, content: '#!x', mode: 0o755, owner: 'root', group: 'root' }])
    expect(services.renderDovecotSieveConf(os).content).not.toContain('sieve_extprograms')
  })

  it('renders the rule file and script for the owning account and compiles the script', () => {
    const out = services.renderBoxTrapper(os, { program: '#!x', mailboxes: [{ address: 'me@alice.test', account, rules, forward: ['copy@elsewhere.test'] }] })
    expect(out.execute).toBe(true)
    const script = out.files.find(file => file.path === '/etc/dovecot/xpanel/sieve/alice.test/me.boxtrapper.sieve')!
    expect(script).toMatchObject({ mode: 0o640, owner: 'root', group: 'alice' })
    expect(script.content).toContain('require ["vnd.dovecot.execute", "variables", "copy"];')
    expect(script.content).toContain('if execute :pipe :output "boxtrapper" "xpanel-boxtrapper" ["filter", "/etc/dovecot/xpanel/sieve/alice.test/me.boxtrapper.json"] {')
    expect(script.content).toContain('if string :is "${boxtrapper}" "hold" {\n    discard;')
    expect(script.content).toContain('redirect :copy "copy@elsewhere.test";')
    const file = out.files.find(item => item.path.endsWith('.boxtrapper.json'))!
    expect(file).toMatchObject({ mode: 0o640, owner: 'root', group: 'alice' })
    expect(JSON.parse(file.content)).toMatchObject({ mailbox: 'me@alice.test', store: '/home/alice/mail/alice.test/me/boxtrapper', spamBypass: null, templates: BOXTRAPPER_DEFAULT_TEMPLATES })
    expect(out.postActions).toContainEqual({ kind: 'exec', argv: ['/usr/bin/sievec', '-P', 'sieve_extprograms', '-x', '+vnd.dovecot.execute', '/etc/dovecot/xpanel/sieve/alice.test/me.boxtrapper.sieve'] })
    expect(out.preActions).toContainEqual({ kind: 'ensure-dir', path: '/etc/dovecot/xpanel/sieve/alice.test', mode: 0o750, owner: 'root', group: 'alice' })
    expect(services.renderBoxTrapperScript('/r.json', [])).not.toContain('copy')
    const conf = services.renderDovecotSieveConf(os, true).content
    expect(conf).toContain('sieve_before2 = /etc/dovecot/xpanel/sieve/%Ld/%Ln.boxtrapper.sieve')
    expect(conf).toContain('sieve_plugins = sieve_extprograms')
    expect(conf).toContain('sieve_global_extensions = +vnd.dovecot.execute')
    expect(conf).toContain(`sieve_execute_bin_dir = ${services.BOXTRAPPER_BIN_DIR}`)
    expect(conf).not.toContain('sieve_extensions = +vnd.dovecot.execute')
  })

  it('trusts the spam score only with a wired filter', () => {
    expect(boxTrapperRules(BOXTRAPPER_DEFAULTS, 'me@alice.test', '/s', true).spamBypass).toBe(-2.5)
    expect(boxTrapperRules(BOXTRAPPER_DEFAULTS, 'me@alice.test', '/s', false).spamBypass).toBeNull()
  })

  it('installs the program with a pinned runtime and no JIT', async () => {
    const text = await boxTrapperProgram('/usr/bin/node')
    expect(text.split('\n')[0]).toBe('#!/usr/bin/node --jitless')
    expect(text).toContain("require.main === module")
  })

  it('rejects settings that would break a header or a reply', () => {
    expect(() => parseBoxTrapperConfig({ ...BOXTRAPPER_DEFAULTS, displayName: 'a\r\nBcc: x@y.test' })).toThrow()
    expect(() => parseBoxTrapperConfig({ ...BOXTRAPPER_DEFAULTS, displayName: 'a" <x@y.test>' })).toThrow()
    expect(() => parseBoxTrapperConfig({ ...BOXTRAPPER_DEFAULTS, templates: { ...BOXTRAPPER_DEFAULTS.templates, deny: { subject: 'a\nb', body: 'x' } } })).toThrow()
    expect(parseBoxTrapperConfig({ ...BOXTRAPPER_DEFAULTS, templates: { ...BOXTRAPPER_DEFAULTS.templates, deny: { subject: 'No', body: 'one\r\ntwo' } } }).templates.deny).toEqual({ subject: 'No', body: 'one\ntwo' })
  })

  it('admits saved rows of live mailboxes only and skips malformed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'boxtrapper-state-')); dirs.push(root)
    const dir = boxTrapperStateDir(root), authority = { accountId: ACC, serviceUserId: SU, mailbox: 'me@alice.test' }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, encodeURIComponent('me@alice.test') + '.json'), JSON.stringify({ ...BOXTRAPPER_DEFAULTS, enabled: true, mailbox: 'me@alice.test', ownerAuthority: authority }))
    await writeFile(join(dir, encodeURIComponent('old@alice.test') + '.json'), JSON.stringify({ ...BOXTRAPPER_DEFAULTS, enabled: true, mailbox: 'me@alice.test', ownerAuthority: authority }))
    await writeFile(join(dir, encodeURIComponent('bad@alice.test') + '.json'), '{')
    const rows = await readBoxTrapperRows(root)
    expect(rows.map(row => row.mailbox)).toEqual(['me@alice.test'])
    const snapshot = { accounts: [{ id: ACC, username: 'alice', status: 'active', home: '/home/alice' }], domains: [], serviceUsers: [{ id: SU, accountId: ACC, login: 'me@alice.test', services: { email: true } }] }
    expect(admitMailxMailboxRows(rows, snapshot)).toHaveLength(1)
    expect(admitMailxMailboxRows(rows, { ...snapshot, accounts: [{ ...snapshot.accounts[0]!, status: 'suspended' }] })).toHaveLength(0)
    expect(admitMailxMailboxRows(rows, { ...snapshot, serviceUsers: [{ ...snapshot.serviceUsers[0]!, id: 'recreated' }] })).toHaveLength(0)
  })
})

describe('BoxTrapper host route', { tags: ['unit'] }, () => {
  const post = (body: unknown, path = '/host/mailx/accounts/alice/boxtrapper') => [new Request('http://agent' + path, { method: 'POST', body: JSON.stringify(body) }), new URL('http://agent' + path), 'POST'] as const
  const context = (overrides: Record<string, unknown> = {}) => ({ family: 'none', assertAccount: async () => ({ id: ACC, username: 'alice', home: '/home/alice' }) as never, readSnapshot: async () => ({ serviceUsers: [{ accountId: ACC, login: 'me@alice.test', services: { email: true } }] }),
    run: async () => ({ ok: true, code: 0, stdout: '{}' }), read: async () => null, ...overrides })

  it('reports readiness, and refuses the queue without the module or the native executor', async () => {
    const reply = await handleBoxTrapperRoute(...post({ mailbox: 'me@alice.test', call: { op: 'status' } }), context())
    expect(await reply!.json()).toEqual({ ready: false, script: false })
    await expect(handleBoxTrapperRoute(...post({ mailbox: 'me@alice.test', call: { op: 'lists' } }), context())).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'sieve_extprograms_missing' }) })
    await expect(handleBoxTrapperRoute(...post({ mailbox: 'me@alice.test', call: { op: 'status' } }), context({ run: null, read: null }))).rejects.toMatchObject({ detail: expect.objectContaining({ reason: 'host_executor_unavailable' }) })
  })

  it('refuses a mailbox of another account and an unknown operation', async () => {
    await expect(handleBoxTrapperRoute(...post({ mailbox: 'other@alice.test', call: { op: 'status' } }), context())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(handleBoxTrapperRoute(...post({ mailbox: 'me@alice.test', call: { op: 'filter' } }), context())).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(handleBoxTrapperRoute(...post({ mailbox: 'me@alice.test', call: { op: 'act', action: 'allow', ids: ['../x'] } }), context())).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handleBoxTrapperRoute(...post({}, '/host/mailx/accounts/alice/other'), context())).toBeNull()
  })
})
