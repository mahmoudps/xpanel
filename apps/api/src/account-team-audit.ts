import { fail } from '@xpanel/core'
import type { AuditEntry } from '@xpanel/core'
import { listAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountOwnerPorts } from './account-ssh-workspace.ts'

export interface TeamAuditPorts extends AccountOwnerPorts { db: Db }
export const TEAM_AUDIT_PAGE = 50
export interface TeamAuditRow { id: string; at: string; caller: string; kind: 'owner' | 'team'; action: string; target: string; outcome: AuditEntry['outcome'] }

/** Newest first; a team member's own login comes from the audit scope of the request. */
export function teamAuditPage(list: readonly AuditEntry[], owner: string, q: string): { rows: TeamAuditRow[]; nextBefore: string | null } {
  const needle = q.trim().toLowerCase()
  const caller = (entry: AuditEntry): string => typeof entry.detail?.team === 'string' ? entry.detail.team : entry.actor
  const all = list.filter(entry => !needle || [caller(entry), entry.action, entry.target].some(value => value.toLowerCase().includes(needle)))
  const page = all.slice(0, TEAM_AUDIT_PAGE)
  return { rows: page.map(entry => ({ id: String(entry.id), at: entry.at, caller: caller(entry), kind: caller(entry) === owner ? 'owner' : 'team', action: entry.action, target: entry.target, outcome: entry.outcome })), nextBefore: all.length > TEAM_AUDIT_PAGE ? String(page.at(-1)!.id) : null }
}

/** GET /api/account/team-audit: the owner's view of what the account's team did. */
export async function handleTeamAuditRoute(request: Request, url: URL, method: string, ports: TeamAuditPorts): Promise<Response | null> {
  if (url.pathname !== '/api/account/team-audit') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const { caller, account } = await authorizeAccountOwner(ports, request, [], 'Team audit')
  if (caller.team) return fail('FORBIDDEN', 'the team audit log is for the account owner', { stateChanged: false })
  const before = url.searchParams.get('before') ?? undefined, q = (url.searchParams.get('q') ?? '').slice(0, 128)
  if (before !== undefined && !/^[1-9][0-9]{0,14}$/.test(before)) return fail('VALIDATION', 'before must be an entry id', { stateChanged: false })
  return workspaceJson({ context: { accountId: account.id }, ...teamAuditPage(await listAudit(ports.db, { limit: 500, mentions: account.username, ...(before ? { beforeId: before } : {}) }), account.username, q) })
}
