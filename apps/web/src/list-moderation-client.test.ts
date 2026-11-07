import { describe, expect, it } from 'vitest'
import { renderClassicListModerationSection, renderClassicModerationQueue } from './board-port/list-moderation-section.ts'
import { renderClassicListAdminSection } from './board-port/mailing-list-admin-sections.ts'
import { LIST_MODERATION_CLIENT_BINDING, moderationLines, moderationTime, moderationWhole, readHeldMessage, readListModeration, readModerationQueue } from './list-moderation-client.ts'
import { v2ListAdminBody } from './themes/v2/pages/xpanel/email-tools/list-admin.ts'
import { v2ListModerationSection, v2ModerationQueue } from './themes/v2/pages/xpanel/email-tools/list-moderation.ts'

const row = { id: `20261107-${'a'.repeat(32)}`, at: '2026-11-07T10:05:09.000Z', from: 'x@y.test', subject: 'Hello', size: 2048, reason: 'non_member' }
const t = (message: string) => message

describe('list moderation client', { tags: ['unit'] }, () => {
  it('reads only the pinned replies', () => {
    expect(readModerationQueue({ total: 1, rows: [row] }).rows[0]!.from).toBe('x@y.test')
    expect(() => readModerationQueue({ total: 1, rows: [{ ...row, id: '../x' }] })).toThrow()
    expect(readHeldMessage({ ...row, headers: 'H', body: 'B', truncated: true }).truncated).toBe(true)
    expect(() => readHeldMessage(row)).toThrow()
    expect(readListModeration({ id: 'i', address: 'a@b.test', moderation: 'members', selfSubscription: 'closed', policy: {}, revision: 'a'.repeat(64), gated: true, host: {} }).gated).toBe(true)
    expect(() => readListModeration({ id: 'i', address: 'a@b.test', moderation: 'everyone', selfSubscription: 'closed', policy: {}, revision: 'a'.repeat(64), gated: true, host: {} })).toThrow()
  })
  it('parses form text', () => {
    expect(moderationLines(' A@x.test\n\nb@x.test, a@x.test ')).toEqual(['a@x.test', 'b@x.test'])
    expect(moderationWhole(' 40 ', 100)).toBe(40)
    expect(() => moderationWhole('1.5', 100)).toThrow()
    expect(() => moderationWhole('101', 100)).toThrow()
    expect(moderationTime(row.at)).toBe('2026-11-07 10:05 UTC')
  })
  it('compiles its browser binding', () => {
    expect(() => new Function('return ' + LIST_MODERATION_CLIENT_BINDING)).not.toThrow()
  })
  it('renders the same hooks in both themes and stays off when it cannot manage', () => {
    const queue = ['data-moderation-queue', 'data-moderation-status', 'data-moderation-rows', 'data-moderation-reason', 'data-moderation-approve', 'data-moderation-reject', 'data-moderation-discard', 'data-moderation-message', 'data-xp-template="list-moderation-row"']
    for (const hook of queue) { expect(renderClassicModerationQueue('en')).toContain(hook); expect(v2ModerationQueue(t)).toContain(hook) }
    const policy = ['data-moderation-list', 'data-moderation-posting', 'data-moderation-subscription', 'data-moderation-non-member', 'data-moderation-member', 'data-moderation-moderators', 'data-moderation-moderated', 'data-moderation-accept', 'data-moderation-hold', 'data-moderation-reject-senders', 'data-moderation-discard-senders', 'data-moderation-size', 'data-moderation-retention', 'data-moderation-notify-moderators', 'data-moderation-notify-sender', 'data-moderation-save', 'data-moderation-state', 'data-moderation-held']
    for (const hook of policy) { expect(renderClassicListModerationSection('ar', true)).toContain(hook); expect(v2ListModerationSection(t, true)).toContain(hook) }
    expect(renderClassicListModerationSection('en', false)).toContain('data-moderation-can-manage="false"')
    expect(v2ListModerationSection(t, false)).toMatch(/data-moderation-save disabled/)
    for (const card of [renderClassicListAdminSection('en', true), v2ListAdminBody(t, true)]) { expect(card).toContain('data-moderation-open'); expect(card).toContain('data-moderation-queue') }
  })
})
