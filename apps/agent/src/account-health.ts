import { lstat } from 'node:fs/promises'
import { assertAcl, availableHandlers, fail } from '@xpanel/core'
import type { Account, ApacheMpm, Certificate, Domain, Engine, FeatureList, Plan, Reseller, ServiceUser } from '@xpanel/core'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { parseRepquotaUsage } from './host-monitoring.ts'
import { ioMountForTarget } from './io-device.ts'

export const MAX_HEALTH_BATCH = 50
const MAX_DOMAIN_ITEMS = 25
const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const SUPPORTED_PHP: ReadonlySet<string> = new Set(SUPPORTED_PHP_VERSIONS)

export type HealthState = 'ok' | 'problem' | 'unavailable'
export type HealthCheckId = 'status' | 'plan' | 'disk' | 'system-user' | 'home' | 'mailboxes' | 'certificates' | 'dns' | 'php'
export interface HealthDomainItem { name: string; state: HealthState; reason: string; evidence: string }
export interface HealthCheck { id: HealthCheckId; state: HealthState; reason: string; evidence: string; items?: HealthDomainItem[]; omitted?: number }
export interface AccountHealth { username: string; primaryDomain: string; status: Account['status']; problems: number; unavailable: number; checks: HealthCheck[] }
export interface AccountHealthReport { observedAt: string; host: 'read' | 'unavailable'; accounts: AccountHealth[] }

/** The saved desired state (StateSnapshot satisfies this). */
export interface AccountHealthState {
  accounts: readonly Account[]; plans: readonly Plan[]; featureLists: readonly FeatureList[]; resellers: readonly Reseller[]
  domains: readonly Domain[]; serviceUsers: readonly ServiceUser[]; certificates: readonly Certificate[]
  zones: readonly { name: string }[]; server: { settings: { engine: Engine; apacheMpm: ApacheMpm } } | null
}
export interface HomeStat { uid: number; gid: number; mode: number; directory: boolean; symlink: boolean }
export interface AccountHealthHost {
  run(argv: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
  readFile(path: string): Promise<string | null>
  /** lstat(2) of a saved home directory; null only for ENOENT. */
  lstat(path: string): Promise<HomeStat | null>
}
export interface AccountHealthCaller { principalId: string; actor: string; role: string; resellerId: string | null }
export interface AccountHealthRouteContext {
  /** Re-authenticates this request's caller from the current principal record. */
  authenticate(): Promise<AccountHealthCaller>
  readState(): Promise<AccountHealthState>
  /** Null keeps every host observation unavailable instead of simulating one. */
  host: AccountHealthHost | null
  now?: () => Date
}

/** getent(1) passwd lookup for one saved username; the grammar excludes option-like keys. */
export const accountHealthPasswdArgv = (username: string): string[] => USERNAME.test(username) ? ['/usr/bin/getent', 'passwd', username] : fail('VALIDATION', 'invalid account username')

export const nativeAccountHealthHost = (executor: { runCommand(argv: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>; readFile(path: string): Promise<string | null> }): AccountHealthHost => ({
  run: argv => executor.runCommand(argv),
  readFile: path => executor.readFile(path),
  lstat: async path => {
    try { const info = await lstat(path); return { uid: info.uid, gid: info.gid, mode: info.mode, directory: info.isDirectory(), symlink: info.isSymbolicLink() } }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  },
})

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g
const clean = (text: string, max: number): string => { const value = text.replace(UNSAFE, '?').toWellFormed(); return value.length > max ? value.slice(0, max - 3).toWellFormed() + '...' : value }
const check = (id: HealthCheckId, state: HealthState, reason: string, evidence: string): HealthCheck => ({ id, state, reason, evidence: clean(evidence, 512) })
const item = (name: string, state: HealthState, reason: string, evidence: string): HealthDomainItem => ({ name, state, reason, evidence: clean(evidence, 256) })
const RANK: Readonly<Record<HealthState, number>> = { problem: 0, unavailable: 1, ok: 2 }

function domainCheck(id: HealthCheckId, items: HealthDomainItem[], empty: [HealthState, string]): HealthCheck {
  const problems = items.filter(entry => entry.state === 'problem').length, unknown = items.filter(entry => entry.state === 'unavailable').length
  const state: HealthState = !items.length ? empty[0] : problems ? 'problem' : unknown ? 'unavailable' : 'ok'
  const reason = !items.length ? empty[1] : state === 'problem' ? 'domains_problem' : state === 'unavailable' ? 'domains_unavailable' : 'domains_ok'
  const sorted = [...items].sort((left, right) => RANK[left.state] - RANK[right.state] || left.name.localeCompare(right.name))
  return { ...check(id, state, reason, `${items.length} checked, ${problems} with problems, ${unknown} not verified`), items: sorted.slice(0, MAX_DOMAIN_ITEMS), omitted: Math.max(0, sorted.length - MAX_DOMAIN_ITEMS) }
}

/** A certificate name covers a host exactly or by a single-label wildcard (RFC 6125 section 6.4.3). */
const covers = (names: readonly string[], host: string): boolean => names.some(raw => {
  const name = raw.toLowerCase(), dot = host.indexOf('.')
  return name === host || name.startsWith('*.') && dot > 0 && host.slice(dot + 1) === name.slice(2)
})

type QuotaRead = { mount: string | null; report: Map<string, { usedBytes: number; hardBytes: number | null }> | null }
function quotaReader(host: AccountHealthHost): (home: string) => Promise<QuotaRead> {
  let mountinfo: Promise<string | null> | undefined
  const reports = new Map<string, QuotaRead['report']>()
  return async home => {
    mountinfo ??= host.readFile('/proc/self/mountinfo').catch(() => null)
    const text = await mountinfo
    const mount = text ? ioMountForTarget(text, home)?.mountPoint ?? null : null
    if (!mount) return { mount: null, report: null }
    if (!reports.has(mount)) {
      let report: QuotaRead['report'] = null
      try { const result = await host.run(['/usr/sbin/repquota', '-u', mount]); if (result.ok) report = parseRepquotaUsage(result.stdout) } catch { /* An unread report is unavailable, never quota evidence. */ }
      reports.set(mount, report)
    }
    return { mount, report: reports.get(mount) ?? null }
  }
}

async function accountChecks(account: Account, state: AccountHealthState, host: AccountHealthHost | null, quota: ((home: string) => Promise<QuotaRead>) | null, now: number): Promise<HealthCheck[]> {
  const plan = state.plans.find(entry => entry.id === account.planId)
  const features = plan ? state.featureLists.find(entry => entry.id === plan.featureListId) : undefined
  const noHost = (id: HealthCheckId): HealthCheck => check(id, 'unavailable', 'host_unavailable', 'native host observation is unavailable')
  const checks: HealthCheck[] = [
    account.status === 'active' ? check('status', 'ok', 'active', 'status=active') : check('status', 'problem', account.status, 'status=' + account.status),
    !plan ? check('plan', 'problem', 'plan_missing', 'the assigned plan is not in saved state')
      : !features ? check('plan', 'problem', 'feature_list_missing', `plan=${plan.name}; its feature list is not in saved state`)
        : check('plan', 'ok', 'plan_ok', `plan=${plan.name} featureList=${features.name}`),
  ]

  if (!plan) checks.push(check('disk', 'unavailable', 'plan_missing', 'no saved plan to compare with'))
  else if (!host || !quota) checks.push(noHost('disk'))
  else {
    const { mount, report } = await quota(account.home)
    const row = report?.get(account.username)
    if (!mount || !report || !row) checks.push(check('disk', 'unavailable', 'quota_unread', !mount ? `no quota filesystem was identified for ${account.home}` : !report ? `repquota -u ${mount}: report unavailable` : `repquota -u ${mount}: no row for ${account.username}`))
    else {
      const limit = plan.resources.diskMb, planBytes = limit === 'unlimited' ? null : limit * 1024 * 1024
      const evidence = `repquota -u ${mount}: used=${row.usedBytes / 1024} KiB hard=${row.hardBytes === null ? 'none' : `${row.hardBytes / 1024} KiB`}; plan diskMb=${limit}`
      checks.push(planBytes !== null && row.usedBytes >= planBytes ? check('disk', 'problem', 'over_quota', evidence)
        : row.hardBytes !== planBytes ? check('disk', 'problem', 'quota_mismatch', evidence)
          : check('disk', 'ok', limit === 'unlimited' ? 'unlimited_plan' : 'within_quota', evidence))
    }
  }

  if (!host) checks.push(noHost('system-user'), noHost('home'))
  else {
    let lookup: Awaited<ReturnType<AccountHealthHost['run']>> | null = null
    try { lookup = await host.run(accountHealthPasswdArgv(account.username)) } catch { /* Unread identity stays unavailable. */ }
    // passwd(5): name:password:UID:GID:GECOS:directory:shell. getent(1) exits 2 when the key is absent.
    const fields = lookup?.ok ? lookup.stdout.split('\n').filter(Boolean) : []
    const entry = fields.length === 1 ? fields[0]!.split(':') : []
    if (!lookup) checks.push(check('system-user', 'unavailable', 'user_unread', 'getent passwd could not run'))
    else if (!lookup.ok) checks.push(lookup.code === 2 ? check('system-user', 'problem', 'user_missing', `getent passwd ${account.username}: exit 2 (no such user)`) : check('system-user', 'unavailable', 'user_unread', `getent passwd ${account.username}: exit ${lookup.code}`))
    else if (entry.length !== 7 || entry[0] !== account.username || !/^\d{1,10}$/.test(entry[2]!) || !/^\d{1,10}$/.test(entry[3]!)) checks.push(check('system-user', 'unavailable', 'user_unread', `getent passwd ${account.username}: unexpected output`))
    else {
      const evidence = `getent passwd: uid=${entry[2]} gid=${entry[3]} home=${entry[5]}; saved uid=${account.uid} gid=${account.gid} home=${account.home}`
      checks.push(Number(entry[2]) === account.uid && Number(entry[3]) === account.gid && entry[5] === account.home ? check('system-user', 'ok', 'user_ok', evidence) : check('system-user', 'problem', 'user_mismatch', evidence))
    }
    if (!/^(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/.test(account.home) || account.home.split('/').includes('..')) checks.push(check('home', 'unavailable', 'home_unread', 'the saved home is not a normalized absolute path'))
    else {
      let info: HomeStat | null | undefined
      try { info = await host.lstat(account.home) } catch { info = undefined }
      if (info === undefined) checks.push(check('home', 'unavailable', 'home_unread', `lstat ${account.home} failed`))
      else if (info === null) checks.push(check('home', 'problem', 'home_missing', `lstat ${account.home}: no such directory`))
      else {
        const evidence = `lstat ${account.home}: type=${info.symlink ? 'symlink' : info.directory ? 'directory' : 'other'} uid=${info.uid} gid=${info.gid} mode=${(info.mode & 0o7777).toString(8).padStart(4, '0')}; saved uid=${account.uid}`
        checks.push(info.symlink || !info.directory ? check('home', 'problem', 'home_not_directory', evidence)
          : info.uid !== account.uid ? check('home', 'problem', 'home_wrong_owner', evidence)
            : info.mode & 0o002 ? check('home', 'problem', 'home_world_writable', evidence) : check('home', 'ok', 'home_ok', evidence))
      }
    }
  }

  const mailboxes = state.serviceUsers.filter(user => user.accountId === account.id && user.services.email).length
  const mailboxLimit = plan?.caps.mailboxes
  checks.push(mailboxLimit === undefined ? check('mailboxes', 'unavailable', 'plan_missing', `mailboxes=${mailboxes}; no saved plan to compare with`)
    : mailboxLimit !== 'unlimited' && mailboxes > mailboxLimit ? check('mailboxes', 'problem', 'over_limit', `mailboxes=${mailboxes} plan limit=${mailboxLimit}`)
      : check('mailboxes', 'ok', 'within_limit', `mailboxes=${mailboxes} plan limit=${mailboxLimit}`))

  const domains = state.domains.filter(domain => domain.accountId === account.id).map(domain => ({ domain, name: domain.name.toLowerCase() })).sort((left, right) => left.name.localeCompare(right.name))
  checks.push(domainCheck('certificates', domains.map(({ domain, name }) => {
    const certificate = domain.certificateId ? state.certificates.find(entry => entry.id === domain.certificateId) : undefined
    if (!certificate) return item(name, 'problem', 'cert_missing', domain.certificateId ? 'the assigned certificate is not in saved state' : 'no certificate is assigned')
    const evidence = `source=${certificate.source} notAfter=${certificate.notAfter} autoRenew=${certificate.autoRenew} names=${certificate.names.join(',')}`
    const notAfter = Date.parse(certificate.notAfter)
    return !covers(certificate.names, name) ? item(name, 'problem', 'cert_not_covering', evidence)
      : !Number.isFinite(notAfter) ? item(name, 'unavailable', 'cert_unread', evidence)
        : notAfter <= now ? item(name, 'problem', 'cert_expired', evidence)
          : notAfter - now < EXPIRY_WARNING_MS ? item(name, 'problem', 'cert_expiring', evidence) : item(name, 'ok', 'cert_valid', evidence)
  }), ['unavailable', 'no_domains']))
  checks.push(domainCheck('dns', domains.map(({ name }) => {
    const zone = state.zones.map(entry => entry.name.toLowerCase()).filter(zoneName => name === zoneName || name.endsWith('.' + zoneName)).sort((left, right) => right.length - left.length)[0]
    return zone ? item(name, 'ok', 'zone_present', 'zone=' + zone) : item(name, 'problem', 'zone_missing', 'no saved zone for this name or a parent name')
  }), ['unavailable', 'no_domains']))
  const settings = state.server?.settings
  checks.push(domainCheck('php', domains.filter(({ domain }) => domain.siteType === 'php').map(({ domain, name }) => {
    const { version, handler } = domain.php
    const evidence = `version=${version} handler=${handler}` + (settings ? ` engine=${settings.engine} mpm=${settings.apacheMpm}` : '')
    if (!SUPPORTED_PHP.has(version)) return item(name, 'problem', 'php_unsupported_version', evidence)
    if (!settings) return item(name, 'unavailable', 'php_engine_unread', evidence + '; server settings are not saved')
    // mpm_itk installation is a setup-time host fact; this compares the handler with the saved engine and MPM only.
    let available: boolean
    try { available = availableHandlers({ engine: settings.engine, mpm: settings.apacheMpm, itkAvailable: true }).handlers.some(option => option.handler === handler && option.available) }
    catch { return item(name, 'unavailable', 'php_engine_unread', evidence) }
    return available ? item(name, 'ok', 'php_ok', evidence) : item(name, 'problem', 'php_handler_unavailable', evidence)
  }), ['ok', 'no_php_sites']))
  return checks
}

/** Read-only checks for the given saved accounts. Host reads run once per quota mount and once per account. */
export async function evaluateAccountHealth(input: { state: AccountHealthState; accounts: readonly Account[]; host: AccountHealthHost | null; now?: () => Date }): Promise<AccountHealthReport> {
  const observed = (input.now ?? (() => new Date()))()
  const quota = input.host ? quotaReader(input.host) : null
  const accounts: AccountHealth[] = []
  for (const account of input.accounts) {
    const checks = await accountChecks(account, input.state, input.host, quota, observed.getTime())
    accounts.push({ username: account.username, primaryDomain: account.primaryDomain.toLowerCase(), status: account.status,
      problems: checks.filter(entry => entry.state === 'problem').length, unavailable: checks.filter(entry => entry.state === 'unavailable').length, checks })
  }
  return { observedAt: observed.toISOString(), host: input.host ? 'read' : 'unavailable', accounts }
}

const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

function readHealthUsernames(url: URL): string[] {
  if (url.search.length > 2048 || [...url.searchParams.keys()].some(key => key !== 'username')) return fail('VALIDATION', 'account health accepts only username selectors', unchanged)
  const usernames = url.searchParams.getAll('username')
  if (!usernames.length || usernames.length > MAX_HEALTH_BATCH || new Set(usernames).size !== usernames.length || usernames.some(name => !USERNAME.test(name)))
    return fail('VALIDATION', `between 1 and ${MAX_HEALTH_BATCH} distinct account usernames are required`, unchanged)
  return usernames
}

/** Root sees every account; a reseller with list-accounts sees only its own. Others look absent. */
function scopedAccounts(caller: AccountHealthCaller, state: AccountHealthState, usernames: readonly string[]): Account[] {
  if (caller.role !== 'root' && caller.role !== 'reseller') return fail('FORBIDDEN', 'account health requires root or a reseller', unchanged)
  if (caller.role === 'reseller') assertAcl({ kind: 'reseller', id: caller.principalId, username: caller.actor }, state.resellers.find(entry => entry.id === caller.resellerId), 'list-accounts')
  return usernames.map(username => {
    const account = state.accounts.find(entry => entry.username === username)
    if (!account || caller.role === 'reseller' && account.ownerId !== caller.resellerId) return fail('NOT_FOUND', 'account not found', unchanged)
    return account
  })
}

/** GET /host/accounts/health?username=... (1..50). Returns null for other paths. */
export async function handleAccountHealthRoute(_req: Request, url: URL, method: string, ctx: AccountHealthRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/accounts/health') return null
  const first = await ctx.authenticate()
  if (first.role !== 'root' && first.role !== 'reseller') return fail('FORBIDDEN', 'account health requires root or a reseller', unchanged)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const usernames = readHealthUsernames(url)
  const state = await ctx.readState()
  const report = await evaluateAccountHealth({ state, accounts: scopedAccounts(first, state, usernames), host: ctx.host, ...(ctx.now ? { now: ctx.now } : {}) })
  const fresh = await ctx.authenticate()
  if (fresh.principalId !== first.principalId || fresh.role !== first.role || fresh.resellerId !== first.resellerId) return fail('FORBIDDEN', 'account health authority changed', unchanged)
  scopedAccounts(fresh, await ctx.readState(), usernames)
  return json(report)
}
