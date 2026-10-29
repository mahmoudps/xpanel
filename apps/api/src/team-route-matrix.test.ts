import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { assertTeamRequestAllowed } from './team-access.ts'

// The matrix rows that carry a concrete `sample` request are checked against the live policy functions, so a
// policy change that is not reflected in docs/planning/authorization-route-matrix.json fails here.
interface Row { method: string; path: string; sample?: string; surface: string; resource: string; requiredScope: string | null; resellerAcl: string | null; featureEntitlement: string[]; allowedPrincipals: string[]; listeners?: string[]; enforcementPoint: string }
const matrix = JSON.parse(readFileSync(join(process.cwd(), 'docs/planning/authorization-route-matrix.json'), 'utf8')) as { routes: Row[] }
const checked = matrix.routes.filter(row => row.sample !== undefined)
const ID = '11111111-1111-4111-8111-111111111111'
const teamAdmits = (method: string, path: string): boolean => {
  try { assertTeamRequestAllowed({ kind: 'team', id: ID, username: 'm', login: 'm@x.test', accountId: ID, roles: ['administrator', 'database', 'email', 'web'] }, path, method); return true } catch { return false }
}

describe('authorization route matrix', () => {
  it('lists every route once', () => {
    const keys = matrix.routes.map(row => `${row.surface} ${row.method} ${row.path}`)
    expect(keys.length - new Set(keys).size).toBe(0)
  })
  it('covers every registered workspace route family and the team sign-in routes', () => {
    for (const family of ['/api/server/mailx/', '/api/account/mailx/', '/api/account/team', '/api/auth/team/password', '/api/account/staging', '/api/backups/components/', '/api/backups/workspace/',
      '/api/transfers/credentials', '/api/transfers/source/', '/api/transfers/convert-addon', '/api/server/account-templates', '/api/server/account-enhancements', '/api/server/databases/',
      '/api/account/database-engines/', '/api/server/software/', '/api/account/optimize', '/api/account/applications', '/api/server/file-sharing', '/api/server/terminal', '/api/server/nodes', '/api/server/integrations'])
      expect(checked.some(row => row.path.startsWith(family)), family).toBe(true)
  })
  it('matches the declared policy, scope, listener admission and team admission of each sampled row', () => {
    expect(checked.length).toBeGreaterThanOrEqual(79)
    for (const row of checked) {
      const label = `${row.method} ${row.path}`
      expect(new RegExp('^' + row.path.replace(/:[a-z]+/g, '[^/]+') + '$').test(row.sample!), label).toBe(true)
      const policy = policyForRequest(row.sample!, row.method)
      const read = policy.scopeAccess === undefined ? ['GET', 'HEAD', 'OPTIONS'].includes(row.method) : policy.scopeAccess === 'read'
      expect({ resource: row.resource, acl: row.resellerAcl, tools: row.featureEntitlement }, label).toEqual({ resource: policy.resource, acl: policy.rootOnly ? null : policy.acl ?? null, tools: [...(policy.toolIds ?? [])] })
      if (row.allowedPrincipals.includes('anonymous')) expect(row.requiredScope, label).toBeNull()
      else expect(row.requiredScope, label).toBe(`${policy.resource}:${read ? 'read' : 'write'}`)
      if (policy.rootOnly) expect(row.allowedPrincipals, label).toEqual(['root'])
      expect(row.allowedPrincipals.includes('team'), label).toBe(!row.allowedPrincipals.includes('anonymous') && teamAdmits(row.method, row.sample!))
      expect(row.listeners, label).toEqual((['xpanel', 'xwhm', 'xmail'] as const).filter(entry => entryPointAllowsApiRoute(entry, row.sample!, row.method)))
    }
  })
  it('records that a team session reaches only its identity and sign-out among the auth routes', () => {
    const auth = matrix.routes.filter(row => row.surface === 'api' && row.path.startsWith('/api/auth/'))
    expect(auth.filter(row => row.allowedPrincipals.includes('team')).map(row => `${row.method} ${row.path}`).sort()).toEqual(['GET /api/auth/me', 'POST /api/auth/logout'])
  })
})
