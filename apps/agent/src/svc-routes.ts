import { mkdir } from 'node:fs/promises'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { SEC_MODSEC_PATHS } from '../../../packages/os/src/sec-host-command.ts'
import { readJsonIfExists } from '@xpanel/state'
import { pearLibraryDir } from '../../../packages/os/src/pear-command.ts'
import type { AgentExecutor } from './executor.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { secPresent, secReadText } from './sec-waf.ts'
import type { SecPresent, SecReadText } from './sec-waf.ts'
import { observeForkBomb, observeSmtpRestriction, observeTraceroute } from './svc-host-access.ts'
import { PACKAGE_CHECK_PATH } from './svc-nightly.ts'
import { observeSourceBuilds } from './source-builds.ts'
import { assertPearVersion, buildPearPlan, buildPearSetupPlan, observePear, searchPear } from './svc-pear.ts'
import type { PearHost } from './svc-pear.ts'
import { appendKillerRun, parseKillerReports, PROCESS_KILLER_REPORT_PATH, runProcessKiller } from './svc-process-killer.ts'
import { parseProcessLog, PROCESS_LOG_PATH, processLogReport } from './svc-process-log.ts'
import { observePhpFpmPools } from './svc-php-fpm.ts'
import { readSvcPolicy, shellAccounts, writeSvcState } from './svc-reconcile.ts'
import { fetchVendorMetadata, installVendor, listRuleFiles, parseInstalledVendors, readModsecHits, recordInstalledVendor, WAF_VENDOR_INSTALLED_PATH } from './svc-waf.ts'
import type { VendorFetch } from './svc-waf.ts'
import { isVendorId, SVC_DEFAULTS } from './svc-policy.ts'
import { observeWebStatus } from './svc-web-status.ts'
import type { WebStatusGet } from './svc-web-status.ts'

export interface SvcAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface SvcRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  executor: AgentExecutor | null
  family: 'debian' | 'rhel' | null
  phpBinary: ((version: string) => string) | null
  rootDir: string
  accounts: () => Promise<readonly Account[]>
  /** account and PHP version of every saved FPM pool */
  fpmPools: () => Promise<readonly { account: string; version: string }[]>
  server: () => Promise<{ engine: string; backendPort: number } | null>
  /** The Apache status path of this host, read from root-only state. */
  webStatusPath: (() => Promise<string>) | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit?: (entry: SvcAuditEntry) => Promise<unknown>
  self?: { pid: number; ppid: number }
  present?: SecPresent
  readText?: SecReadText
  webStatusGet?: WebStatusGet
  vendorGet?: VendorFetch
  readReports?: () => Promise<unknown>
  writeReports?: (value: unknown) => Promise<void>
  readProcessLog?: () => Promise<unknown>
  now?: () => Date
}
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const READS: Readonly<Record<string, string>> = {
  '/host/svc/traceroute': 'security.traceroute.read', '/host/svc/smtp-restrictions': 'security.smtp_restrictions.read', '/host/svc/fork-bomb': 'security.fork_bomb.read',
  '/host/svc/process-killer': 'monitoring.process_killer.read', '/host/svc/process-log': 'monitoring.process_log.read', '/host/svc/web-status': 'monitoring.web_status.read',
  '/host/svc/php-fpm-defaults': 'php.fpm.read', '/host/svc/pear': 'php.pear.read', '/host/svc/waf-hits': 'security.waf.read', '/host/svc/waf-files': 'security.waf.read', '/host/svc/package-check': 'monitoring.package_check.read', '/host/svc/source-builds': 'monitoring.source_builds.read',
}
const WRITES: Readonly<Record<string, string>> = {
  '/host/svc/process-killer/run': 'monitoring.process_killer.run', '/host/svc/process-killer/reports/mailed': 'monitoring.process_killer.report',
  '/host/svc/pear/search': 'php.pear.read', '/host/svc/pear/change': 'php.pear.change',
  '/host/svc/waf-vendors/preview': 'security.waf.vendor', '/host/svc/waf-vendors/install': 'security.waf.vendor', '/host/svc/waf-vendors/remove': 'security.waf.vendor',
}
const bodyOf = async (req: Request, fields: readonly string[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 2048 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join() !== [...fields].sort().join()) return fail('VALIDATION', 'unsupported services request field', unchanged)
  return body as Record<string, unknown>
}
const utcDay = (date: Date): string => date.toISOString().slice(0, 10)

/** Root-only services and security centre host routes. Everything a host command names comes from saved state or a reviewed grammar. */
export async function handleSvcRoute(req: Request, url: URL, method: string, ctx: SvcRouteContext): Promise<Response | null> {
  const read = Object.hasOwn(READS, url.pathname) ? READS[url.pathname]! : null, write = Object.hasOwn(WRITES, url.pathname) ? WRITES[url.pathname]! : null
  if (!read && !write) return null
  const { actor } = await ctx.assertRoot(read ?? write!)
  if (method !== (read ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: read ? 'GET' : 'POST' } })
  const executor = ctx.executor
  if (!executor) return fail('PRECONDITION_FAILED', 'services observations require the native Linux host executor', unchanged)
  const now = ctx.now ?? (() => new Date()), present = ctx.present ?? secPresent, readText = ctx.readText ?? secReadText
  const run = (argv: string[]) => executor.runCommand(argv)
  const self = ctx.self ?? { pid: process.pid, ppid: process.ppid }
  const readReports = ctx.readReports ?? (() => readJsonIfExists<unknown>(PROCESS_KILLER_REPORT_PATH))
  const pearHost = (): PearHost => ctx.family && ctx.phpBinary ? { family: ctx.family, phpBinary: ctx.phpBinary, present, run } : fail('PRECONDITION_FAILED', 'PEAR needs a supported distribution', unchanged)

  switch (url.pathname) {
    case '/host/svc/traceroute': return json(await observeTraceroute({ allowed: (await readSvcPolicy(ctx.rootDir, 'traceroute'))?.allowed ?? null, now }))
    case '/host/svc/smtp-restrictions': return json(await observeSmtpRestriction({ enabled: (await readSvcPolicy(ctx.rootDir, 'smtp-restrictions'))?.enabled === true, run, present, now }))
    case '/host/svc/fork-bomb': return json(await observeForkBomb({ enabled: (await readSvcPolicy(ctx.rootDir, 'fork-bomb'))?.enabled === true, users: shellAccounts(await ctx.accounts()), readText, now }))
    case '/host/svc/process-log': {
      const day = url.searchParams.get('day') ?? 'today', at = now()
      if ([...url.searchParams.keys()].some(key => key !== 'day') || (day !== 'today' && day !== 'yesterday')) return fail('VALIDATION', 'day must be today or yesterday', unchanged)
      const name = utcDay(day === 'today' ? at : new Date(at.getTime() - 86_400_000))
      return json({ day: name, report: processLogReport(parseProcessLog(await (ctx.readProcessLog ?? (() => readJsonIfExists<unknown>(PROCESS_LOG_PATH)))()), name) })
    }
    case '/host/svc/process-killer': return json({ runs: parseKillerReports(await readReports()).runs.slice(-10).reverse() })
    case '/host/svc/process-killer/run': {
      const policy = await readSvcPolicy(ctx.rootDir, 'process-killer') ?? SVC_DEFAULTS['process-killer']
      const result = await runProcessKiller({ run, policy, accounts: await ctx.accounts(), self, trigger: 'manual', now })
      await ctx.writeReports?.(appendKillerRun(parseKillerReports(await readReports()), result))
      await ctx.audit?.({ actor, action: 'monitoring.process_killer.run', target: 'server:process-killer', outcome: result.state === 'completed' ? 'ok' : 'failed', detail: { killed: result.killed.length, trustedSkipped: result.trustedSkipped } })
      return json(result)
    }
    case '/host/svc/process-killer/reports/mailed': {
      const { at } = await bodyOf(req, ['at'])
      const reports = parseKillerReports(await readReports())
      await ctx.writeReports?.({ runs: reports.runs.map(item => item.at === at ? { ...item, mailed: true } : item) })
      return json({ ok: true })
    }
    case '/host/svc/web-status': {
      const server = await ctx.server()
      if (!server || !ctx.webStatusPath) return fail('PRECONDITION_FAILED', 'web status needs the saved server settings', unchanged)
      return json(await observeWebStatus({ engine: server.engine, backendPort: server.backendPort, statusPath: await ctx.webStatusPath(), nginxSocket: edge.WEB_STATUS_NGINX_SOCKET, ...(ctx.webStatusGet ? { get: ctx.webStatusGet } : {}), now }))
    }
    case '/host/svc/php-fpm-defaults': return json(await observePhpFpmPools({ pools: await ctx.fpmPools(), now }))
    case '/host/svc/pear': return json(await observePear(pearHost(), assertPearVersion(url.searchParams.get('version'))))
    case '/host/svc/pear/search': { const body = await bodyOf(req, ['version', 'name']); return json({ results: await searchPear(pearHost(), assertPearVersion(body.version), body.name) }) }
    case '/host/svc/pear/change': {
      const body = await bodyOf(req, ['version', 'operation', 'name']), version = assertPearVersion(body.version)
      if (body.operation !== 'setup' && body.operation !== 'install' && body.operation !== 'upgrade' && body.operation !== 'uninstall') return fail('VALIDATION', 'operation must be setup, install, upgrade or uninstall', unchanged)
      if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'host jobs are not available', unchanged)
      const host = pearHost()
      if (body.operation === 'setup') return json({ job: await ctx.submitJob(buildPearSetupPlan(host, version), actor) }, 202)
      if ((await observePear(host, version)).state === 'not_installed') return fail('PRECONDITION_FAILED', 'install PEAR for this PHP version first', { ...unchanged, reason: 'pear_not_installed' })
      // The pool lists this directory once it exists; the API reconciles after this returns.
      await mkdir(pearLibraryDir(version), { recursive: true, mode: 0o755 })
      const job = await ctx.submitJob(buildPearPlan(host, { version, operation: body.operation, name: String(body.name) }), actor)
      return json({ job }, 202)
    }
    case '/host/svc/waf-hits': return json(await readModsecHits())
    case '/host/svc/waf-files': {
      let crsDir: string | null = null
      if (ctx.family) for (const path of SEC_MODSEC_PATHS[ctx.family].crsDirs) if (await present(path, 'directory') === true) { crsDir = path; break }
      const vendors = (await readSvcPolicy(ctx.rootDir, 'waf-vendors'))?.vendors ?? []
      return json({ installed: parseInstalledVendors(await readJsonIfExists<unknown>(WAF_VENDOR_INSTALLED_PATH)), crs: crsDir ? await listRuleFiles(crsDir + '/rules') : [], vendors: Object.fromEntries(await Promise.all(vendors.map(async vendor => [vendor.id, await listRuleFiles(`${edge.modsecVendorDir}/${vendor.id}`)] as const))) })
    }
    case '/host/svc/package-check': return json(await readJsonIfExists<unknown>(PACKAGE_CHECK_PATH))
    case '/host/svc/source-builds': return json(ctx.family === 'rhel' ? await observeSourceBuilds(run) : { hook: false, modules: [] })
    case '/host/svc/waf-vendors/preview': { const { url: target } = await bodyOf(req, ['url']); return json(await fetchVendorMetadata(String(target), ctx.vendorGet)) }
    case '/host/svc/waf-vendors/install': {
      const { url: target } = await bodyOf(req, ['url'])
      const installed = await installVendor(String(target), { writeFile: file => executor.writeFile(file), removePath: path => executor.removePath(path) }, ctx.vendorGet)
      await recordInstalledVendor(installed, { read: () => readJsonIfExists<unknown>(WAF_VENDOR_INSTALLED_PATH), write: value => writeSvcState(WAF_VENDOR_INSTALLED_PATH, value) })
      return json(installed)
    }
    default: {
      const { id } = await bodyOf(req, ['id'])
      if (!isVendorId(id)) return fail('VALIDATION', 'a vendor id is required', unchanged)
      await executor.removePath(`${edge.modsecVendorDir}/${id}`)
      return json({ removed: id })
    }
  }
}
