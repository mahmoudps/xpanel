import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { services } from '@xpanel/render'
import { LIST_POLICY_DEFAULTS, listGateProgram, listGateRules, listGated, parseListPolicy } from './list-moderation-policy.ts'
import { handleListModerationRoute } from './list-moderation-routes.ts'
import { mailfxListAliasLine, readMailfxLists } from './mailfx-render.ts'

const os = { paths: { dovecotDir: '/etc/dovecot' } } as never
const ACC = '22222222-2222-4222-8222-222222222222', LIST = '11111111-1111-4111-8111-111111111111', address = 'team@alice.test'
const account = { username: 'alice', uid: 2001, gid: 2001, home: '/home/alice' }
const gate = services.listGateAddress(ACC, address)
const rules = listGateRules({ address, members: ['a@x.test'], moderation: 'members', policy: LIST_POLICY_DEFAULTS }, '/home/alice')
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function saved(list: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-list-mod-')); dirs.push(root)
  await mkdir(join(root, 'extended', 'mail'), { recursive: true })
  await writeFile(join(root, 'extended', 'mail', 'mailing-lists.json'), JSON.stringify([{ id: LIST, accountId: ACC, name: 'team', domain: 'alice.test', address, members: ['a@x.test'], moderation: 'members', archiveEnabled: false, createdAt: '2026-11-07T10:00:00.000Z', ...list }]))
  return root
}
const snapshot = { accounts: [{ id: ACC, username: 'alice', status: 'active', home: '/home/alice', uid: 2001, gid: 2001, planId: 'plan' }], domains: [{ id: 'd', name: 'alice.test', accountId: ACC }], serviceUsers: [], plans: [{ id: 'plan', featureListId: 'f' }], featureLists: [{ id: 'f', disabled: [] }] } as never
const forwarding = { forwarders: [], domainForwarders: [] }

describe('list gate host render', { tags: ['unit'] }, () => {
  it('renders the program, rule file and compiled script for the owning account only', () => {
    expect(services.renderListGate(os, undefined)).toEqual({ files: [], preActions: [], postActions: [], execute: false })
    const out = services.renderListGate(os, { program: '#!x', lists: [{ gate, account, rules }] }), paths = services.listGatePaths('/etc/dovecot/xpanel/sieve', gate)
    expect(out.execute).toBe(true)
    expect(out.files.find(file => file.path === services.LIST_GATE_PROGRAM)).toMatchObject({ mode: 0o755, owner: 'root' })
    expect(out.files.find(file => file.path === paths.rules)).toMatchObject({ mode: 0o640, owner: 'root', group: 'alice' })
    expect(out.files.find(file => file.path === paths.script)!.content).toContain(`if execute :pipe "xpanel-list-gate" ["filter", "${paths.rules}"] {\n  discard;\n  stop;\n}`)
    expect(out.postActions).toContainEqual({ kind: 'exec', argv: ['/usr/bin/sievec', '-P', 'sieve_extprograms', '-x', '+vnd.dovecot.execute', paths.script] })
    expect(out.postActions).toContainEqual({ kind: 'exec', argv: ['/usr/bin/chown', 'root:alice', paths.binary] })
    expect(services.listGateMaildir('/home/alice', gate)).toBe(`/home/alice/mail/${gate.slice(gate.indexOf('@') + 1)}/${gate.slice(0, gate.indexOf('@'))}`)
    expect(gate).not.toBe(services.autoreplyAddress(ACC, address))
  })
  it('points the list address at the hidden user while its members stay out of the alias table', () => {
    const domain = { domain: 'alice.test', account, mailboxes: [], lists: [{ local: 'team', members: ['a@x.test'], gate }] }
    const internal = { domain: services.autoreplyDomain(ACC), account, internal: true, mailboxes: [{ local: gate.slice(0, gate.indexOf('@')), passwordHash: services.LOCKED_MAILBOX_HASH, quotaMb: services.LIST_GATE_QUOTA_MB, suspendLogin: true }] }
    const maps = services.renderPostfixMaps({ paths: { postfixDir: '/etc/postfix' }, services: { postfix: 'postfix' } } as never, [domain, internal])
    const aliases = maps.files.find(file => file.path.endsWith('virtual_aliases'))!
    expect(aliases.content).toContain(`team@alice.test\t${gate}`)
    expect(aliases.content).not.toContain('a@x.test')
    expect(maps.files.flatMap(file => file.content.split('\n')).some(line => line.startsWith(gate) && line.includes('REJECT'))).toBe(true)
  })
  it('installs the program with the JIT off, which delivery needs under SELinux', async () => {
    expect(await listGateProgram('/opt/node')).toMatch(/^#!\/opt\/node --jitless\n'use strict'/)
  })
})

describe('list policy', { tags: ['unit'] }, () => {
  it('keeps an open list with no stopping rule a plain alias', () => {
    expect(listGated('open', LIST_POLICY_DEFAULTS)).toBe(false)
    expect(listGated('open', { ...LIST_POLICY_DEFAULTS, acceptSenders: ['*@x.test'], moderators: ['m@x.test'] })).toBe(false)
    expect(listGated('members', LIST_POLICY_DEFAULTS)).toBe(true)
    expect(listGated('open', { ...LIST_POLICY_DEFAULTS, maxMessageKb: 40 })).toBe(true)
    expect(listGated('open', { ...LIST_POLICY_DEFAULTS, discardSenders: ['*@x.test'] })).toBe(true)
  })
  it('normalizes entries and refuses bad fields', () => {
    expect(parseListPolicy({ ...LIST_POLICY_DEFAULTS, moderators: [' M@X.test '] }).moderators).toEqual(['m@x.test'])
    for (const bad of [{ moderators: ['no address'] }, { moderators: ['a@x.test', 'A@x.test'] }, { nonMemberAction: 'accept' }, { retentionDays: 366 }, { maxMessageKb: -1 }, { holdSenders: ['two words'] }, { notifySender: 'yes' }, { extra: 1 }])
      expect(() => parseListPolicy({ ...LIST_POLICY_DEFAULTS, ...bad }), JSON.stringify(bad)).toThrow()
    expect(() => parseListPolicy({})).toThrow()
  })
})

describe('list delivery admission', { tags: ['unit'] }, () => {
  it('delivers a limited list through its hidden user when the host can check posts, and not at all when it cannot', async () => {
    const root = await saved({})
    const ready = await readMailfxLists(root, snapshot, forwarding, true)
    expect(ready.rows[0]).toMatchObject({ state: 'pending' })
    expect(ready.lists[0]!.gate).toMatchObject({ gate, account: { username: 'alice' }, rules: { posting: 'members', members: ['a@x.test'], store: '/home/alice/mail/alice.test/team/listgate' } })
    expect(mailfxListAliasLine(ready.lists[0]!)).toBe(`${address}\t${gate}`)
    const missing = await readMailfxLists(root, snapshot, forwarding, false)
    expect(missing).toMatchObject({ lists: [], rows: [{ state: 'restricted' }] })
  })
  it('leaves an open list without rules on the alias table and sends an unreadable policy to review', async () => {
    const open = await readMailfxLists(await saved({ moderation: 'open', policy: LIST_POLICY_DEFAULTS }), snapshot, forwarding, false)
    expect(open.lists[0]!.gate).toBeUndefined()
    expect(mailfxListAliasLine(open.lists[0]!)).toBe(`${address}\ta@x.test`)
    await expect(readMailfxLists(await saved({ policy: { moderators: 'x' } }), snapshot, forwarding, true)).rejects.toMatchObject({ detail: { reason: 'saved_lists_review' } })
  })
})

describe('list moderation host route', { tags: ['feature'] }, () => {
  const post = (root: string, call: unknown, target = address, run: ((argv: string[]) => Promise<{ ok: boolean; code: number | null; stdout: string }>) | null = async () => ({ ok: true, code: 0, stdout: '{"total":0,"rows":[]}' })) =>
    handleListModerationRoute(new Request('http://agent/host/mailx/accounts/alice/list-moderation', { method: 'POST', body: JSON.stringify({ address: target, call }) }), new URL('http://agent/host/mailx/accounts/alice/list-moderation'), 'POST', {
      stateRoot: root, assertAccount: async () => ({ id: ACC, username: 'alice', home: '/home/alice' }) as never, readSnapshot: async () => ({ domains: [{ accountId: ACC, name: 'alice.test' }] }), run, read: async path => path.endsWith('.list.json') ? '{}' : null })

  it('answers status truthfully and refuses a list of another account or a missing executor', async () => {
    const root = await saved({})
    const status = await (await post(root, { op: 'status' }))!.json() as { active: boolean; ready: boolean }
    expect(status.active).toBe(true)
    expect(typeof status.ready).toBe('boolean')
    await expect(post(await saved({ accountId: '44444444-4444-4444-8444-444444444444' }), { op: 'queue' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(post(root, { op: 'status' }, 'other@alice.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(post(root, { op: 'status' }, address, null)).rejects.toMatchObject({ detail: { reason: 'host_executor_unavailable' } })
    await expect(post(root, { op: 'filter' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(post(root, { op: 'act', action: 'approve', reason: '-', ids: ['../x'] })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('purges only after the list is gone, on a domain of the account', async () => {
    const root = await saved({})
    await expect(post(root, { op: 'purge' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await writeFile(join(root, 'extended', 'mail', 'mailing-lists.json'), '[]')
    await expect(post(root, { op: 'purge' }, 'team@other.test')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
