import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { TeamPrincipal, TeamRole } from '@xpanel/core'
import { assertTeamRequestAllowed, teamRolesAllowTool, teamToolIds } from './team-access.ts'

const tool = (id: string) => tools.find(item => item.id === id)!
const team = (roles: TeamRole[]): TeamPrincipal => ({ kind: 'team', id: '77777777-7777-4777-8777-000000000001', username: 'sam', login: 'sam@alice.example', accountId: '55555555-5555-4555-8555-555555555555', roles })
const allowed = (roles: TeamRole[], method: string, path: string): boolean => { try { assertTeamRequestAllowed(team(roles), path, method); return true } catch { return false } }
const ID = '11111111-1111-4111-8111-111111111111'

describe('team role rule', () => {
  it('grants role groups and keeps owner-only and owner-identity tools out of every role', () => {
    expect(teamRolesAllowTool(['email'], tool('email-accounts'))).toBe(true)
    expect(teamRolesAllowTool(['email'], tool('mysql-databases'))).toBe(false)
    expect(teamRolesAllowTool(['database'], tool('mysql-databases'))).toBe(true)
    expect(teamRolesAllowTool(['web'], tool('file-manager'))).toBe(true)
    expect(teamRolesAllowTool(['administrator'], tool('ssh-access'))).toBe(true)
    const all: TeamRole[] = ['administrator', 'database', 'email', 'web']
    for (const id of ['manage-team', 'team-audit-log', 'user-manager', 'account-preferences', 'password-security', 'api-tokens', 'two-factor-auth', 'change-language'])
      expect(teamRolesAllowTool(all, tool(id)), id).toBe(false)
    expect(teamRolesAllowTool(['administrator'], tool('calendars-contacts-management'))).toBe(false)
    expect(teamToolIds([])).toEqual([])
    expect(tools.filter(item => item.surface !== 'xpanel' || item.rootOnly).some(item => teamRolesAllowTool(all, item))).toBe(false)
  })
})

describe('team request gate', () => {
  it('admits only its own identity and UI preference, sign-out and the static catalog without a tool', () => {
    expect(allowed([], 'GET', '/api/auth/me')).toBe(true)
    expect(allowed([], 'POST', '/api/auth/logout')).toBe(true)
    expect(allowed([], 'GET', '/api/catalog')).toBe(true)
    expect(allowed([], 'GET', '/api/auth/ui-preferences')).toBe(true)
    expect(allowed([], 'PUT', '/api/auth/ui-preferences')).toBe(true)
    for (const [method, path] of [['POST', '/api/auth/ui-preferences'], ['PATCH', '/api/auth/ui-preferences'], ['GET', '/api/auth/ui-preferences/other'], ['PUT', '/api/admin/preferences']])
      expect(allowed(['administrator'], method!, path!), path).toBe(false)
    for (const [method, path] of [['POST', '/api/auth/change-password'], ['POST', '/api/auth/2fa/setup'], ['GET', '/api/auth/sessions'], ['POST', '/api/auth/sessions/revoke-others'], ['DELETE', `/api/auth/sessions/${ID}`], ['POST', '/api/auth/team/password']])
      expect(allowed(['administrator'], method!, path!), path).toBe(false)
  })
  it('refuses every root-only and reseller administration route whatever the roles', () => {
    const all: TeamRole[] = ['administrator', 'database', 'email', 'web']
    for (const [method, path] of [
      ['GET', '/api/server/settings'], ['PUT', '/api/server/sec/waf'], ['GET', '/api/jobs'], ['POST', '/api/firewall/rules'], ['GET', '/api/resellers'], ['POST', '/api/resellers'],
      ['GET', '/api/plans'], ['GET', '/api/feature-lists'], ['GET', '/api/accounts'], ['POST', '/api/accounts'], [`POST`, `/api/accounts/${ID}/suspend`], ['GET', `/api/accounts/${ID}`],
      ['GET', '/api/ips'], ['GET', '/api/audit'], ['GET', '/api/search'], ['GET', '/api/service-users'], ['GET', '/api/events/recent'], ['POST', '/api/transfers/credentials'],
      ['GET', '/api/backups/workspace/runs'], ['GET', '/api/server/nodes'], ['POST', '/api/server/terminal'], ['GET', '/api/server/software/containers'],
      ['GET', '/api/account/team'], ['POST', `/api/account/team/${ID}/password-link`], ['PATCH', '/api/account/preferences'], ['GET', '/api/no-such-route'], ['GET', '/panel'],
    ]) expect(allowed(all, method!, path!), `${method} ${path}`).toBe(false)
  })
  it('admits account tools only for the roles that grant them', () => {
    expect(allowed(['email'], 'GET', '/api/mail/forwarders')).toBe(true)
    expect(allowed(['database'], 'GET', '/api/mail/forwarders')).toBe(false)
    expect(allowed(['database'], 'GET', '/api/databases')).toBe(true)
    expect(allowed(['email'], 'POST', '/api/databases')).toBe(false)
    expect(allowed(['web'], 'POST', '/api/accounts/alice/files')).toBe(true)
    expect(allowed(['email'], 'POST', '/api/accounts/alice/files')).toBe(false)
    expect(allowed(['web'], 'GET', '/api/domains')).toBe(true)
    expect(allowed(['administrator'], 'GET', '/api/account/cron')).toBe(true)
    expect(allowed(['web'], 'GET', '/api/account/cron')).toBe(false)
    expect(allowed([], 'GET', '/api/domains')).toBe(false)
  })
})
