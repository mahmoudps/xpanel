import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '@xpanel/core'
import { TEAM_AUDIT_PAGE, teamAuditPage } from './account-team-audit.ts'

const entry = (id: number, over: Partial<AuditEntry> = {}): AuditEntry => ({ id: String(id), at: '2026-11-07T10:00:00.000Z', actor: 'alice', action: 'mail.account.created', target: 'account:alice', detail: {}, outcome: 'ok', ...over }) as AuditEntry

describe('team audit page', () => {
  it('names the team login when the request came from a member', () => {
    const { rows } = teamAuditPage([entry(2, { detail: { team: 'sam@alice-shop.com' } }), entry(1)], 'alice', '')
    expect(rows.map(row => [row.caller, row.kind])).toEqual([['sam@alice-shop.com', 'team'], ['alice', 'owner']])
  })

  it('searches caller, action and target', () => {
    const list = [entry(2, { detail: { team: 'sam@alice-shop.com' } }), entry(1, { action: 'dns.zone.updated' })]
    expect(teamAuditPage(list, 'alice', 'SAM').rows).toHaveLength(1)
    expect(teamAuditPage(list, 'alice', 'dns.zone').rows[0]!.id).toBe('1')
    expect(teamAuditPage(list, 'alice', 'nothing').rows).toEqual([])
  })

  it('pages by the last id shown', () => {
    const list = Array.from({ length: TEAM_AUDIT_PAGE + 1 }, (_, index) => entry(TEAM_AUDIT_PAGE + 1 - index))
    const page = teamAuditPage(list, 'alice', '')
    expect(page.rows).toHaveLength(TEAM_AUDIT_PAGE)
    expect(page.nextBefore).toBe(page.rows.at(-1)!.id)
    expect(teamAuditPage(list.slice(0, 3), 'alice', '').nextBefore).toBeNull()
  })
})
