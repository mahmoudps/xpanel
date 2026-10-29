import { tools } from '@xpanel/catalog'
import { fail } from '@xpanel/core'
import type { TeamPrincipal, TeamRole } from '@xpanel/core'
import { policyForRequest } from './authorization.ts'

export const TEAM_ROLES = ['administrator', 'database', 'email', 'web'] as const satisfies readonly TeamRole[]

// Groups follow the catalog spec: administrator is everything except collaboration pages, User Manager and the team itself.
const ROLE_GROUPS: Readonly<Record<Exclude<TeamRole, 'administrator'>, readonly string[]>> = { database: ['databases'], email: ['email'], web: ['files', 'domains', 'software'] }
const ADMINISTRATOR_EXCLUDED = new Set(['user-manager', 'calendars-contacts-management', 'calendars-contacts-sharing', 'calendars-contacts-config'])
// A team session carries the owner's account authority, so the owner's own sign-in identity (password, two-factor,
// API tokens, contact and interface preferences, the team itself) is never delegated to any role.
const OWNER_IDENTITY = new Set(['api-tokens', 'two-factor-auth'])
const OWNER_IDENTITY_GROUP = 'preferences'
const toolById = new Map(tools.map(tool => [tool.id, tool]))

/** Pure role rule: may a team member holding these roles use this xPanel catalog tool? Role-less members get no tools. */
export function teamRolesAllowTool(roles: readonly TeamRole[], tool: { id: string; surface: string; groupId: string; rootOnly: boolean }): boolean {
  if (tool.surface !== 'xpanel' || tool.rootOnly || tool.groupId === OWNER_IDENTITY_GROUP || OWNER_IDENTITY.has(tool.id)) return false
  if (roles.includes('administrator') && !ADMINISTRATOR_EXCLUDED.has(tool.id)) return true
  return roles.some(role => role !== 'administrator' && ROLE_GROUPS[role].includes(tool.groupId))
}
/** Catalog tool ids a role set grants, for display and for the signed-in member's navigation. */
export const teamToolIds = (roles: readonly TeamRole[]): string[] => tools.filter(tool => teamRolesAllowTool(roles, tool)).map(tool => tool.id).sort()

// The only routes without a catalog tool that a team session may call: its own identity, sign-out and the static catalog.
const TEAM_ROUTES_WITHOUT_TOOL = new Set(['GET /api/auth/me', 'POST /api/auth/logout', 'GET /api/catalog'])

/**
 * Checked for every request a team session authenticates. The route's declared policy must be account-scoped and
 * every catalog tool it names must be granted by the member's current roles; anything else, including routes with
 * no declared tool, root-only routes and every other /api/auth route, is refused.
 */
export function assertTeamRequestAllowed(team: TeamPrincipal, pathname: string, method: string): void {
  if (TEAM_ROUTES_WITHOUT_TOOL.has(`${method} ${pathname}`)) return
  const refuse = (): never => fail('FORBIDDEN', 'the team member roles do not include this operation', { stateChanged: false, team: true })
  if (!pathname.startsWith('/api/') || pathname.startsWith('/api/auth/')) return refuse()
  let policy: ReturnType<typeof policyForRequest>
  try { policy = policyForRequest(pathname, method) } catch { return refuse() }
  if (policy.rootOnly || !policy.toolIds?.length) return refuse()
  for (const id of policy.toolIds) {
    const tool = toolById.get(id)
    if (!tool || !teamRolesAllowTool(team.roles, tool)) return refuse()
  }
}
