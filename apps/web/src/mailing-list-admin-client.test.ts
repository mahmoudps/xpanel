import { describe, expect, it } from 'vitest'
import { renderClassicListAdminSection, renderClassicListPasswordSection, renderClassicListResetSection } from './board-port/mailing-list-admin-sections.ts'
import { MAILING_LIST_ADMIN_CLIENT_BINDING, listAdminEmail, listAdminMembers, listAdminRows } from './mailing-list-admin-client.ts'
import { v2ListAdminBody, v2ListPasswordSection, v2ListResetSection } from './themes/v2/pages/xpanel/email-tools/list-admin.ts'

describe('mailing list administration client', { tags: ['unit'] }, () => {
  it('reads only the pinned replies and one list address', () => {
    expect(listAdminEmail(' News@Alice.Test ')).toBe('news@alice.test')
    expect(() => listAdminEmail('not an address')).toThrow()
    expect(listAdminMembers({ address: 'news@alice.test', members: ['a@x.test'] }, 'news@alice.test')).toEqual(['a@x.test'])
    expect(() => listAdminMembers({ address: 'other@alice.test', members: [] }, 'news@alice.test')).toThrow()
    expect(listAdminRows({ lists: [{ id: '11111111-1111-4111-8111-111111111111', address: 'news@alice.test', account: 'alice', passwordSet: true, members: 2 }] })).toHaveLength(1)
    expect(() => new Function('return ' + MAILING_LIST_ADMIN_CLIENT_BINDING)).not.toThrow()
  })
  it('renders the same hooks in both themes and keeps an unverified tool disconnected', () => {
    const t = (message: string) => message
    for (const [classic, v2, hooks] of [
      [renderClassicListPasswordSection('en', true), v2ListPasswordSection(t, true), ['data-list-password-list', 'data-list-password-input', 'data-list-password-save']],
      [renderClassicListAdminSection('ar', true), v2ListAdminBody(t, true), ['data-list-admin-address', 'data-list-admin-password', 'data-list-admin-members', 'data-xp-template="list-admin-member"']],
      [renderClassicListResetSection('en', { reset: true, restart: true }), v2ListResetSection(t, { reset: true, restart: true }), ['data-list-reset-rows', 'data-list-reset-password', 'data-list-restart']],
    ] as const) for (const hook of hooks) { expect(classic).toContain(hook); expect(v2).toContain(hook) }
    expect(renderClassicListPasswordSection('en', false)).toContain('data-capability-unavailable="true"')
    expect(v2ListAdminBody(t, false)).toContain('data-capability-unavailable="true"')
    expect(renderClassicListAdminSection('en', true)).not.toContain('Open archives')
  })
})
