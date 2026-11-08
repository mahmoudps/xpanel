import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, listAudit } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { PANEL_GATE_DEFAULT } from '../../agent/src/panel-gate-policy.ts'
import { readSecRecord, SEC_STATE_PATHS } from '../../agent/src/sec-policy.ts'
import { classifyCliInvocation } from './cli-privilege.ts'
import { runCli } from './cli.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const fixture = async () => {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const save = async (kind: 'panel-access' | 'panel-gate' | 'panel-temporary-logins', policy: unknown) => {
    const file = join(state.store.rootDir, SEC_STATE_PATHS[kind])
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, policy, updatedAt: '2026-11-07T10:00:00.000Z' }))
  }
  const read = async (kind: 'panel-access' | 'panel-gate' | 'panel-temporary-logins') => readSecRecord(kind, JSON.parse(await readFile(join(state.store.rootDir, SEC_STATE_PATHS[kind]), 'utf8')))?.policy
  return { database, state, save, read, run: (...args: string[]) => runCli(['panel-access', ...args], { db: database.db, store: state.store }) }
}
const gate = { ...PANEL_GATE_DEFAULT, entrance: { path: 'door-2026-x', listeners: ['xwhm'] }, stopped: ['xmail'] }

describe('xpanel panel-access', () => {
  it('shows the entrance a locked-out owner needs, without the password hash', async () => {
    const f = await fixture()
    await f.save('panel-gate', { ...gate, basicAuth: { username: 'guard', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV', listeners: ['xwhm'] } })
    const shown = await f.run('show')
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain('door-2026-x')
    expect(shown.stdout).not.toContain('argon2')
  })

  it('clears the allow list so the panel is reachable from any address', async () => {
    const f = await fixture()
    await f.save('panel-access', { listeners: { xpanel: [], xwhm: [{ cidr: '203.0.113.0/24', note: '' }], xmail: [] } })
    expect((await f.run('reset', 'allowlist')).code).toBe(0)
    expect(await f.read('panel-access')).toEqual({ listeners: { xpanel: [], xwhm: [], xmail: [] } })
    expect((await listAudit(f.database.db, { limit: 5 })).map(row => row.action)).toContain('server.panel_access.reset')
  })

  it('resets one part and leaves the others, and all repairs a broken file', async () => {
    const f = await fixture()
    await f.save('panel-gate', gate)
    await f.run('reset', 'entrance')
    expect(await f.read('panel-gate')).toMatchObject({ entrance: null, stopped: ['xmail'] })
    await writeFile(join(f.state.store.rootDir, SEC_STATE_PATHS['panel-gate']), '{broken')
    await f.run('reset', 'all')
    expect(await f.read('panel-gate')).toEqual(PANEL_GATE_DEFAULT)
  })

  it('revokes every temporary link', async () => {
    const f = await fixture()
    await f.save('panel-temporary-logins', { logins: [{ id: 'a'.repeat(16), tokenHash: 'b'.repeat(64), note: '', issuerId: 'root', issuer: 'root', createdAt: '2026-11-07T10:00:00.000Z', expiresAt: '2036-11-07T10:00:00.000Z', usedAt: null, revokedAt: null }] })
    await f.run('reset', 'temporary-logins')
    expect(await f.read('panel-temporary-logins')).toMatchObject({ logins: [{ revokedAt: expect.any(String) }] })
  })

  it('refuses a wrong part and any user but root or the service account', async () => {
    const f = await fixture()
    expect((await f.run('reset', 'everything')).code).not.toBe(0)
    expect(classifyCliInvocation({ platform: 'linux', uid: 1000, command: 'panel-access', serviceUid: 999 })).toBe('refuse')
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'panel-access', serviceUid: 999 })).toBe('drop-to-xpanel')
  })
})
