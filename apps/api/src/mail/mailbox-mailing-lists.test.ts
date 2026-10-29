import { afterEach, describe, expect, it } from 'vitest'
import { handleMailboxMailingListsRoute } from './mailbox-mailing-lists.ts'
import { cleanupMailboxToolsFixtures, mailboxToolsFixture, toolsAuthority, TOOLS_ACCOUNT, TOOLS_LIST, TOOLS_MAILBOX, TOOLS_OTHER } from './mailbox-spam-fixture.ts'
const list = (change: Record<string, unknown> = {}) => ({ id: TOOLS_LIST, accountId: TOOLS_ACCOUNT, address: 'news@example.test', domain: 'example.test', name: 'News', members: ['bob@example.test'], moderation: 'members', archiveEnabled: true, createdAt: '2026-10-27T00:00:00.000Z', selfSubscription: 'open', ...change })
afterEach(cleanupMailboxToolsFixtures)
async function harness(records: unknown[] = [list()]) {
  const f = await mailboxToolsFixture(); await f.write(['mail', 'mailing-lists.json'], records)
  const send = async (method = 'GET', body?: unknown, id?: string, query = '') => { const path = '/api/webmail/mailing-lists' + (id ? '/' + id + '/subscription' : '') + query; return handleMailboxMailingListsRoute(new Request('http://local' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://local' + path), method, f.ports) }
  const view = async () => (await (await send())!.json()) as Record<string, any>
  return { ...f, send, view }
}
describe('sealed mailbox mailing-list subscriptions', () => {
  it('shows only public or current bound memberships, with no member addresses or counts', async () => {
    const h = await harness([list(), list({ id: TOOLS_OTHER, accountId: TOOLS_OTHER, address: 'foreign@other.test', domain: 'other.test' })]), view = await h.view()
    expect(view.lists).toHaveLength(1); expect(view.lists[0]).toMatchObject({ address: 'news@example.test', membership: 'not_subscribed', canSubscribe: true, canUnsubscribe: false }); expect(view.application).toEqual({ status: 'configuration_only', nativeApplied: false })
    expect(JSON.stringify(view)).not.toContain('bob@example.test'); expect(JSON.stringify(view)).not.toContain('membersCount'); expect(JSON.stringify(view)).not.toContain('memberAuthorities'); expect(JSON.stringify(view)).not.toContain('foreign@other.test')
  })
  it('subscribes only the sealed address and verifies exact canonical-list readback', async () => {
    const h = await harness(), before = await h.view(), revision = before.lists[0].revision
    const ack: any = await (await h.send('PUT', { subscribed: true, expectedRevision: revision }, TOOLS_LIST))!.json()
    expect(ack.lists[0]).toMatchObject({ membership: 'subscribed', canSubscribe: false, canUnsubscribe: true }); expect(ack.stateChanged).toBe(true)
    expect(await h.read(['mail', 'mailing-lists.json'])).toEqual([list({ members: ['bob@example.test', TOOLS_MAILBOX], memberAuthorities: { [TOOLS_MAILBOX]: toolsAuthority } })]); expect(h.audit).toHaveBeenCalledTimes(1)
    const unsubscribe: any = await (await h.send('PUT', { subscribed: false, expectedRevision: ack.lists[0].revision }, TOOLS_LIST))!.json()
    expect(unsubscribe.lists[0].membership).toBe('not_subscribed'); expect(await h.read(['mail', 'mailing-lists.json'])).toEqual([list({ memberAuthorities: {} })])
  })
  it('never infers subscription permission from open posting policy', async () => {
    const h = await harness([list({ selfSubscription: undefined, moderation: 'open' })])
    expect((await h.view()).lists).toEqual([])
    await expect(h.send('PUT', { subscribed: true, expectedRevision: 'a'.repeat(64) }, TOOLS_LIST)).rejects.toMatchObject({ code: 'NOT_FOUND', detail: { stateChanged: false } })
  })
  it('allows a verified own unsubscribe from a closed list without exposing other private members', async () => {
    const h = await harness([list({ selfSubscription: 'closed', members: ['bob@example.test', TOOLS_MAILBOX], memberAuthorities: { [TOOLS_MAILBOX]: toolsAuthority } })]), before = await h.view()
    expect(before.lists[0]).toMatchObject({ subscriptionPolicy: 'closed', canSubscribe: false, canUnsubscribe: true })
    const after: any = await (await h.send('PUT', { subscribed: false, expectedRevision: before.lists[0].revision }, TOOLS_LIST))!.json()
    expect(after.lists).toEqual([]); expect(JSON.stringify(after)).not.toContain('bob@example.test')
  })
  it('hides unbound private membership and refuses to adopt legacy/recreated membership', async () => {
    for (const selfSubscription of ['open', 'closed']) {
      const h = await harness([list({ selfSubscription, members: [TOOLS_MAILBOX], memberAuthorities: { [TOOLS_MAILBOX]: { ...toolsAuthority, serviceUserId: TOOLS_OTHER } } })]), before = await h.view()
      if (selfSubscription === 'closed') expect(before.lists).toEqual([])
      else expect(before.lists[0]).toMatchObject({ membership: 'review_required', canSubscribe: false, canUnsubscribe: false })
      await expect(h.send('PUT', { subscribed: false, expectedRevision: 'a'.repeat(64) }, TOOLS_LIST)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    }
  })
  it('refuses stale revisions and injection of another address/account', async () => {
    const h = await harness()
    await expect(h.send('PUT', { subscribed: true, expectedRevision: 'a'.repeat(64) }, TOOLS_LIST)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(h.send('PUT', { subscribed: true, expectedRevision: 'a'.repeat(64), mailbox: 'bob@example.test' }, TOOLS_LIST)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('GET', undefined, undefined, '?accountId=' + TOOLS_ACCOUNT)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await h.read(['mail', 'mailing-lists.json'])).toEqual([list()]); expect(h.audit).not.toHaveBeenCalled()
  })
  it('rechecks current mailbox lifetime and reports audit-after-save failures as uncertain', async () => {
    const h = await harness(), before = await h.view(); h.audit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(h.send('PUT', { subscribed: true, expectedRevision: before.lists[0].revision }, TOOLS_LIST)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    expect((await h.view()).lists[0].membership).toBe('subscribed'); h.recreate(); await expect(h.view()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
