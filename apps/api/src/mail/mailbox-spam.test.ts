import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { handleMailboxSpamRoute, parseMailboxSpamFields } from './mailbox-spam.ts'
import { cleanupMailboxToolsFixtures, mailboxToolsFixture, toolsAuthority, TOOLS_ACCOUNT, TOOLS_MAILBOX, TOOLS_OTHER } from './mailbox-spam-fixture.ts'
const fields = { inherit: false, enabled: true, addHeaderScore: 8, spamBoxEnabled: true, allowlist: ['safe@example.test'], blocklist: ['bad@example.test'] }
afterEach(cleanupMailboxToolsFixtures)
async function harness() {
  const f = await mailboxToolsFixture()
  const send = async (method = 'GET', body?: unknown, query = '') => handleMailboxSpamRoute(new Request('http://local/api/webmail/spam-preferences' + query, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://local/api/webmail/spam-preferences' + query), method, f.ports)
  const view = async () => (await (await send())!.json()) as Record<string, any>
  return { ...f, send, view }
}
describe('sealed mailbox spam preferences', () => {
  it('inherits actual account spam settings without exposing account sender lists or claiming activation', async () => {
    const h = await harness()
    await h.write(['mail', 'accounts', TOOLS_ACCOUNT, 'spam-settings.json'], { enabled: false, addHeaderScore: 9, spamBoxEnabled: true, allowlist: ['private@account.test'] })
    const view = await h.view()
    expect(view).toMatchObject({ inherited: { source: 'account', enabled: false, addHeaderScore: 9 }, preferences: null, effective: { enabled: false, addHeaderScore: 9 }, application: { status: 'saved_only', applied: false } })
    expect(JSON.stringify(view)).not.toContain('private@account.test'); expect(JSON.stringify(view)).not.toContain('ownerAuthority'); expect(h.lease.release).toHaveBeenCalled()
  })
  it('saves only the current mailbox record, with immutable binding and exact readback', async () => {
    const h = await harness(), before = await h.view(), accountFile = ['mail', 'accounts', TOOLS_ACCOUNT, 'spam-settings.json']
    await h.write(accountFile, { enabled: true, addHeaderScore: 5, spamBoxEnabled: true }); const oldAccount = await readFile(h.path(...accountFile), 'utf8'), current = await h.view()
    const reply: any = await (await h.send('PUT', { ...fields, expectedRevision: current.revision }))!.json()
    expect(reply).toMatchObject({ preferences: { ...fields, updatedAt: '2026-10-27T12:00:00.000Z' }, stateChanged: true }); expect(reply.revision).not.toBe(before.revision)
    expect(await h.read(['webmail', 'spam-preferences', encodeURIComponent(TOOLS_MAILBOX) + '.json'])).toEqual({ ...fields, mailbox: TOOLS_MAILBOX, ownerAuthority: toolsAuthority, updatedAt: '2026-10-27T12:00:00.000Z' })
    expect(await readFile(h.path(...accountFile), 'utf8')).toBe(oldAccount); expect(h.audit).toHaveBeenCalledTimes(1)
  })
  it('rejects stale account policy revisions without creating a mailbox override', async () => {
    const h = await harness(), before = await h.view()
    await h.write(['mail', 'accounts', TOOLS_ACCOUNT, 'spam-settings.json'], { enabled: true, addHeaderScore: 12, spamBoxEnabled: true })
    await expect(h.send('PUT', { ...fields, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(readFile(h.path('webmail', 'spam-preferences', encodeURIComponent(TOOLS_MAILBOX) + '.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('hides legacy/recreated mailbox preferences and refuses silent rebinding', async () => {
    const h = await harness()
    await h.write(['webmail', 'spam-preferences', encodeURIComponent(TOOLS_MAILBOX) + '.json'], { ...fields, mailbox: TOOLS_MAILBOX, ownerAuthority: { ...toolsAuthority, serviceUserId: TOOLS_OTHER }, updatedAt: '2026-10-27T12:00:00.000Z' })
    const view = await h.view(); expect(view).toMatchObject({ preferences: null, review: 'mailbox_metadata_binding_unverified', capabilities: { canSave: false } }); expect(JSON.stringify(view)).not.toContain('safe@example.test')
    await expect(h.send('PUT', { ...fields, expectedRevision: view.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('refuses selectors, unknown fields, invalid scores and contradictory sender lists', async () => {
    const h = await harness()
    await expect(h.send('GET', undefined, '?mailbox=other@example.test')).rejects.toMatchObject({ code: 'VALIDATION' })
    for (const value of [{ ...fields, addHeaderScore: -1 }, { ...fields, addHeaderScore: 101 }, { ...fields, blocklist: fields.allowlist }, { ...fields, allowlist: ['*@example.test'] }, { ...fields, allowlist: ['a@example.test', 'a@example.test'] }]) expect(() => parseMailboxSpamFields(value)).toThrow()
    await expect(h.send('PUT', { ...fields, expectedRevision: 'a'.repeat(64), accountId: TOOLS_ACCOUNT })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await h.send('DELETE'))!.status).toBe(405)
  })
  it('rejects a recreated or suspended current mailbox before reading saved data', async () => {
    const h = await harness(); h.recreate(); await expect(h.view()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const other = await harness(); other.suspend(); await expect(other.view()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('marks an audit failure after a verified save as uncertain and leaves inspectable saved state', async () => {
    const h = await harness(), before = await h.view(); h.audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(h.send('PUT', { ...fields, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, stateChanged: true } })
    expect((await h.view()).preferences).toMatchObject(fields)
  })
})
