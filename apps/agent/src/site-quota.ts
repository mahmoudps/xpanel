import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Domain, HostAction } from '@xpanel/core'
import { validateQuotaFilesystem } from './services/quota.ts'
import type { QuotaCommandRunner } from './services/quota.ts'

/**
 * Site path quota: an XFS project quota on the document root. XFS mounted with `prjquota` is the only
 * filesystem it runs on; anything else is reported, and refused at save, instead of a limit that is not enforced.
 */
const XFS_QUOTA = '/usr/sbin/xfs_quota'
const SITE_QUOTA_ROUTE = /^\/accounts\/([a-z][a-z0-9_-]{0,31})\/site-quota$/

// shortcut: a hash can collide (two sites of 28 bits share a limit), allocate ids from a ledger if a host ever nears 10000 quota sites.
export const siteProjectId = (domainId: string): number => 1 + Number.parseInt(createHash('sha256').update(domainId).digest('hex').slice(0, 7), 16)

export type SiteQuotaObservation = { state: 'ready'; mount: string } | { state: 'unsupported'; reason: 'filesystem' | 'mount_option' | 'unread' }

export const observeSiteQuota = async (run: QuotaCommandRunner, path: string): Promise<SiteQuotaObservation> => {
  const field = async (name: string): Promise<string | null> => {
    const result = await run(['/usr/bin/findmnt', '--noheadings', '--raw', '--output', name, '--target', validateQuotaFilesystem(path)])
    const text = result.stdout.trim()
    return result.ok && text && !/[\r\n]/.test(text) ? text : null
  }
  const [type, options, mount] = [await field('FSTYPE'), await field('OPTIONS'), await field('TARGET')]
  if (!type || !options || !mount) return { state: 'unsupported', reason: 'unread' }
  if (type !== 'xfs') return { state: 'unsupported', reason: 'filesystem' }
  return options.split(',').some(option => option === 'prjquota' || option === 'pquota' || option === 'pqnoenforce') ? { state: 'ready', mount } : { state: 'unsupported', reason: 'mount_option' }
}

const COMMAND = /^(?:project -[sC] -p \/[A-Za-z0-9_./+-]{0,1024} [1-9][0-9]{0,9}|limit -p bhard=[0-9]{1,10}m [1-9][0-9]{0,9})$/

/** The finite xfs_quota grammar; its -c script is one argument with spaces, so the generic argument check cannot read it. */
export const isSiteQuotaCommand = (argv: readonly string[]): boolean => {
  if (argv.length !== 5 || argv[0] !== XFS_QUOTA || argv[1] !== '-x' || argv[2] !== '-c' || !COMMAND.test(argv[3] ?? '')) return false
  try { validateQuotaFilesystem(argv[4]); return true } catch { return false }
}

/** Sets or, at limit 0, clears the project of a document root. A host that cannot enforce it keeps serving; the page says so. */
export const applySiteQuota = async (run: QuotaCommandRunner, action: Extract<HostAction, { kind: 'site-quota' }>): Promise<void> => {
  const observed = await observeSiteQuota(run, action.path)
  if (observed.state !== 'ready') return
  const steps = action.limitMb > 0
    ? [`project -s -p ${action.path} ${action.projectId}`, `limit -p bhard=${action.limitMb}m ${action.projectId}`]
    : [`limit -p bhard=0m ${action.projectId}`, `project -C -p ${action.path} ${action.projectId}`]
  for (const step of steps) {
    const result = await run([XFS_QUOTA, '-x', '-c', step, observed.mount])
    if (!result.ok) fail('CONFIG_TEST_FAILED', `the site path quota was not applied: ${step.split(' ')[0]}`, { stateChanged: true, verificationRequired: true })
  }
}

const quotaOf = (domain: Domain): string => `${domain.docRoot} ${domain.pathQuotaMb}`

/** Quota changes since the applied generation; it runs per change, because setting a project walks the whole tree. */
export const siteQuotaActions = (current: readonly Domain[], applied: readonly Domain[]): HostAction[] => {
  const before = new Map(applied.map(domain => [domain.id, domain])), now = new Set(current.map(domain => domain.id))
  const action = (domain: Domain, limitMb: number): HostAction => ({ kind: 'site-quota', path: domain.docRoot, projectId: siteProjectId(domain.id), limitMb })
  return [
    ...current.flatMap(domain => {
      const old = before.get(domain.id)
      if (old ? quotaOf(old) === quotaOf(domain) : domain.pathQuotaMb === 'unlimited') return []
      return [action(domain, domain.pathQuotaMb === 'unlimited' ? 0 : domain.pathQuotaMb)]
    }),
    ...applied.filter(domain => !now.has(domain.id) && domain.pathQuotaMb !== 'unlimited').map(domain => action(domain, 0)),
  ]
}

export interface SiteQuotaRouteDeps {
  caller: { role: string; accountId?: string | null }
  store: { getAccountByUsername(name: string): Promise<{ id: string } | null>; getDomain(id: string): Promise<Domain | null> }
  run: QuotaCommandRunner
}

/** Whether this site's path quota can be enforced here; the API admits the account and domain before asking. */
export async function handleSiteQuotaRoute(url: URL, method: string, deps: SiteQuotaRouteDeps): Promise<Response | null> {
  const match = SITE_QUOTA_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const account = await deps.store.getAccountByUsername(match[1]!), domain = await deps.store.getDomain(url.searchParams.get('domain') ?? '')
  if (!account || !domain || domain.accountId !== account.id || deps.caller.role === 'user' && deps.caller.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const observed = await observeSiteQuota(deps.run, domain.docRoot).catch(() => ({ state: 'unsupported', reason: 'unread' }) as const)
  return new Response(JSON.stringify(observed.state === 'ready' ? { state: 'ready' } : observed), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
