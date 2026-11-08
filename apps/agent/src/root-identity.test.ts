import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { changeAdminGroup, handleRootIdentityRoute, observeAdminGroup, setRootPassword } from './root-identity.ts'
import type { RootIdentityRun } from './root-identity.ts'

const account = (username: string, status: Account['status'] = 'active') => ({ username, status }) as Account
const accounts = [account('alice'), account('bob'), account('carol', 'suspended')]
const refusal = async (run: () => Promise<unknown>) => { try { await run(); return 'accepted' } catch (error) { return isXpanelError(error) ? `${error.code}:${String(error.detail.reason ?? '')}` : error } }

/** A host with /etc/passwd and /etc/group entries that gpasswd edits like the real one. */
function host(group: string, members: string[], uids: Record<string, number>, opts: { gpasswdFails?: boolean } = {}) {
  const calls: string[][] = []
  const run: RootIdentityRun = async argv => {
    calls.push(argv)
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'group') return argv[2] === group ? { ok: true, code: 0, stdout: `${group}:x:10:${members.join(',')}\n`, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: '' }
    if (argv[0] === '/usr/bin/getent' && argv[1] === 'passwd') return argv[2]! in uids ? { ok: true, code: 0, stdout: `${argv[2]}:x:${uids[argv[2]!]}:${uids[argv[2]!]}::/home/${argv[2]}:/bin/bash\n`, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: '' }
    if (argv[0] === '/usr/bin/gpasswd' && !opts.gpasswdFails) {
      if (argv[1] === '-a') members.push(argv[2]!); else members.splice(members.indexOf(argv[2]!), 1)
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    return { ok: false, code: 1, stdout: '', stderr: 'refused' }
  }
  return { run, calls, members }
}

describe('administrator group membership', () => {
  it('reads the distribution group and marks which members are hosting accounts', async () => {
    const { run } = host('wheel', ['rocky', 'alice'], {})
    const observed = await observeAdminGroup({ family: 'rhel', run, accounts, now: () => new Date('2026-11-07T00:00:00Z') })
    expect(observed).toEqual({ observedAt: '2026-11-07T00:00:00.000Z', family: 'rhel', group: 'wheel', state: 'read',
      members: [{ username: 'alice', account: true }, { username: 'rocky', account: false }], accounts: [{ username: 'alice', member: true }, { username: 'bob', member: false }] })
    expect((await observeAdminGroup({ family: 'debian', run: host('sudo', [], {}).run, accounts })).group).toBe('sudo')
    expect((await observeAdminGroup({ family: 'arch', run, accounts })).state).toBe('unsupported')
  })

  it('adds and removes a hosting account with gpasswd and reports only an observed change', async () => {
    const h = host('sudo', ['ubuntu'], { bob: 1001, alice: 1000 })
    expect((await changeAdminGroup({ family: 'debian', run: h.run, accounts, action: 'add', username: 'bob' })).outcome).toBe('applied')
    expect(h.calls).toContainEqual(['/usr/bin/gpasswd', '-a', 'bob', 'sudo'])
    expect((await changeAdminGroup({ family: 'debian', run: h.run, accounts, action: 'add', username: 'bob' })).outcome).toBe('unchanged')
    expect((await changeAdminGroup({ family: 'debian', run: h.run, accounts, action: 'remove', username: 'bob' })).observation).toMatchObject({ members: [{ username: 'ubuntu', account: false }] })
    expect(h.members).toEqual(['ubuntu'])
  })

  it('never touches system users, other members or a group that is missing, and flags an unverified change', async () => {
    const h = host('wheel', ['rocky'], { bob: 998, alice: 1000, carol: 1002 })
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: h.run, accounts, action: 'add', username: 'bob' }))).toBe('FORBIDDEN:system_account')
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: h.run, accounts, action: 'remove', username: 'rocky' }))).toBe('FORBIDDEN:not_a_hosting_account')
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: h.run, accounts, action: 'add', username: 'carol' }))).toBe('PRECONDITION_FAILED:account_not_active')
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: h.run, accounts, action: 'add', username: 'root' }))).toBe('FORBIDDEN:not_a_hosting_account')
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: h.run, accounts, action: 'add', username: 'Alice;id' }))).toBe('VALIDATION:')
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: host('sudo', [], { alice: 1000 }).run, accounts, action: 'add', username: 'alice' }))).toBe('PRECONDITION_FAILED:group_missing')
    expect(await refusal(() => changeAdminGroup({ family: 'arch', run: h.run, accounts, action: 'add', username: 'alice' }))).toBe('UNSUPPORTED_OS:admin_group_unsupported')
    expect(h.calls.some(argv => argv[0] === '/usr/bin/gpasswd')).toBe(false)
    expect(await refusal(() => changeAdminGroup({ family: 'rhel', run: host('wheel', [], { alice: 1000 }, { gpasswdFails: true }).run, accounts, action: 'add', username: 'alice' }))).toBe('SERVICE_UNAVAILABLE:')
  })
})

describe('root password', () => {
  const shadow = (hash: string) => `daemon:*:19000:0:99999:7:::\nroot:${hash}:19000:0:99999:7:::\n`
  it('writes through chpasswd and proves the shadow hash changed', async () => {
    let current = shadow('!'), written = ''
    const result = await setRootPassword({ password: 'correct horse battery', readShadow: async () => current,
      write: async password => { written = password; current = shadow('$y$j9T$salt$hash'); return { ok: true, code: 0 } } })
    expect(result).toEqual({ outcome: 'applied', scheme: 'y' })
    expect(written).toBe('correct horse battery')
  })

  it('refuses a malformed password and reports an unverified change truthfully', async () => {
    const same = async () => shadow('$6$a$b')
    expect(await refusal(() => setRootPassword({ password: 'short', readShadow: same, write: async () => ({ ok: true, code: 0 }) }))).toBe('VALIDATION:')
    expect(await refusal(() => setRootPassword({ password: 'two\nlines here', readShadow: same, write: async () => ({ ok: true, code: 0 }) }))).toBe('VALIDATION:')
    expect(await refusal(() => setRootPassword({ password: 'long enough value', readShadow: same, write: async () => ({ ok: true, code: 0 }) }))).toBe('SERVICE_UNAVAILABLE:')
    expect(await refusal(() => setRootPassword({ password: 'long enough value', readShadow: async () => 'daemon:*:1::::::\n', write: async () => ({ ok: true, code: 0 }) }))).toBe('PRECONDITION_FAILED:shadow_unreadable')
  })

  it('serves both routes to root only and never simulates a host', async () => {
    const request = (path: string, body?: unknown) => new Request('http://agent' + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const denied = { assertRoot: async () => { throw new Error('not root') }, family: 'rhel', run: host('wheel', [], {}).run, accounts: async () => accounts }
    await expect(handleRootIdentityRoute(request('/host/identity/admin-group'), new URL('http://agent/host/identity/admin-group'), 'GET', denied)).rejects.toThrow('not root')
    const offline = { ...denied, assertRoot: async () => ({ actor: 'root' }), run: null }
    expect(await refusal(() => handleRootIdentityRoute(request('/host/identity/root-password', { password: 'x'.repeat(12) }), new URL('http://agent/host/identity/root-password'), 'POST', offline))).toBe('PRECONDITION_FAILED:')
    expect((await handleRootIdentityRoute(request('/host/identity/root-password'), new URL('http://agent/host/identity/root-password'), 'GET', offline))!.status).toBe(405)
    expect(await handleRootIdentityRoute(request('/host/other'), new URL('http://agent/host/other'), 'GET', offline)).toBeNull()
  })
})
