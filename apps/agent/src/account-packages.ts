import { createHash } from 'node:crypto'
import { fail, isAccountHome, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { system } from '@xpanel/render'
import { SUPPORTED_PHP_VERSIONS } from '@xpanel/os'
import { phpBinaryProbeArgv } from '../../../packages/os/src/php-inventory-command.ts'
import { isPearPackageName, pearCommandPath, pearPackageName } from '../../../packages/os/src/pear-command.ts'
import type { FileText, JailedFileManager } from './file-manager.ts'
import { accountUnitArgv } from './web-apps.ts'
import { LinuxHostExecutor } from './executor.ts'
import { secPresent } from './sec-waf.ts'
import type { AgentCallerIdentity } from './server.ts'
import type { PearHost, PearSearchRow } from './svc-pear.ts'
import { observePear, searchPear } from './svc-pear.ts'

/**
 * cPanel PHP PEAR Packages: PHP's own pear installer runs as the account inside its slice and sandbox, and writes only
 * to ~/php and ~/.pear in the account home. The inventory comes from pear's registry files in that home.
 */
export const ACCOUNT_PACKAGE_FEATURE = 'php-pear-packages'
export const ACCOUNT_PEAR_LIBRARY = 'php'
const PEAR_STATE = '.pear'
export type AccountPackageFiles = Pick<JailedFileManager, 'list' | 'readText'>
/** The packages PHP's own PEAR installer ships; a private library never holds them. */
export const SYSTEM_PEAR_PACKAGES: readonly string[] = ['PEAR', 'Archive_Tar', 'Console_Getopt', 'Structures_Graph', 'XML_Util']
export type AccountPackageOp = 'install' | 'update' | 'reinstall' | 'remove'
export type AccountPackageRequest = { op: 'read' } | { op: AccountPackageOp; name: string; expectedRevision: string } | { op: 'search'; query: string }
export interface AccountPackageRow { name: string; version: string }
export interface AccountPackagesView {
  context: { accountId: string; username: string }; ecosystem: 'pear'; library: string; includeSnippet: string; phpVersion: string | null; engine: boolean; requiredPackage: string | null
  revision: string; packages: AccountPackageRow[]; system: { name: string; version: string | null }[]; results: PearSearchRow[]
}
const unchanged = { stateChanged: false }
const invalid = (): never => fail('VALIDATION', 'invalid PEAR package request', unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function parseAccountPackageRequest(method: string, value: unknown): AccountPackageRequest {
  if (method === 'GET') return value === undefined ? { op: 'read' } : invalid()
  if (!object(value)) return invalid()
  if (value.op === 'search') return Object.keys(value).length === 2 && isPearPackageName(value.query) ? { op: 'search', query: value.query } : invalid()
  if (!['install', 'update', 'reinstall', 'remove'].includes(String(value.op)) || Object.keys(value).length !== 3 || !isPearPackageName(value.name) || typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return invalid()
  return { op: value.op as AccountPackageOp, name: value.name, expectedRevision: value.expectedRevision }
}

/** pear's serialized registry records carry `"name"` and `"release"` as PHP strings; nothing else is read from them. */
export function parsePearRegistryFile(text: string): AccountPackageRow | null {
  const name = /s:4:"name";s:[0-9]+:"([A-Za-z][A-Za-z0-9_]{0,63})";/.exec(text)?.[1]
  const version = /s:7:"version";a:2:\{s:7:"release";s:[0-9]+:"([0-9A-Za-z.]{1,32})";/.exec(text)?.[1] ?? /s:7:"version";s:[0-9]+:"([0-9A-Za-z.]{1,32})";/.exec(text)?.[1]
  return name && version ? { name, version } : null
}
export async function readPearInventory(files: AccountPackageFiles): Promise<AccountPackageRow[]> {
  let names: readonly { name: string; kind: string }[]
  try { names = await files.list(ACCOUNT_PEAR_LIBRARY + '/.registry', { showHidden: true }) }
  catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return []; throw error }
  const rows: AccountPackageRow[] = []
  for (const entry of names.filter(item => item.kind === 'file' && item.name.endsWith('.reg')).slice(0, 256)) {
    const text: FileText | null = await files.readText(ACCOUNT_PEAR_LIBRARY + '/.registry/' + entry.name).catch(() => null)
    const row = text ? parsePearRegistryFile(text.content) : null
    if (row) rows.push(row)
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

export const pearUnitName = (username: string): string => `xpanel-pear-${system.assertUsername(username)}.service`
const pearDirs = (home: string): string[] => ['php_dir=' + home + '/' + ACCOUNT_PEAR_LIBRARY, ...['data', 'doc', 'test', 'www', 'cfg', 'bin', 'cache', 'download', 'temp'].map(key => key + '_dir=' + home + '/' + PEAR_STATE + '/' + key)].flatMap(value => ['-d', value])
const VERBS: Readonly<Record<AccountPackageOp, readonly string[]>> = { install: ['install'], update: ['upgrade'], reinstall: ['install', '--force'], remove: ['uninstall'] }
const PHP = /^(?:\/usr\/bin\/php[5-9]\.[0-9]{1,2}|\/opt\/remi\/php[5-9][0-9]{1,2}\/root\/usr\/bin\/php)$/
const PEARCMD = /^(?:\/usr\/share\/php\/pearcmd\.php|\/opt\/remi\/php[5-9][0-9]{1,2}\/root\/usr\/share\/pear\/pearcmd\.php)$/
/** Waits for the unit: the page and the qualification both read the library right after the answer. */
export function buildAccountPearCommand(account: Pick<Account, 'username' | 'uid' | 'gid' | 'home'>, php: string, pearcmd: string, op: AccountPackageOp, name: string): string[] {
  if (!PHP.test(php) || !PEARCMD.test(pearcmd) || !isPearPackageName(name) || !isAccountHome(account.home, account.username)) return invalid()
  return accountUnitArgv(account, pearUnitName(account.username), '', [php, pearcmd, ...pearDirs(account.home), ...VERBS[op], name], [], { HOME: account.home }).map(value => value === '--no-block' ? '--wait' : value)
}
export function isAccountPearCommand(argv: readonly unknown[]): boolean {
  const unit = typeof argv[1] === 'string' ? /^--unit=xpanel-pear-([a-z][a-z0-9]{0,15})\.service$/.exec(argv[1])?.[1] : undefined
  if (!unit || !argv.every(value => typeof value === 'string')) return false
  const list = argv as string[], uid = list.find(v => /^User=[0-9]+$/.test(v))?.slice(5), gid = list.find(v => /^Group=[0-9]+$/.test(v))?.slice(6), home = list.find(v => v.startsWith('--working-directory='))?.slice(20)
  const tail = list.slice(list.lastIndexOf('--') + 1), op = (Object.keys(VERBS) as AccountPackageOp[]).find(key => tail.slice(-1 - VERBS[key].length, -1).join() === VERBS[key].join())
  if (!uid || !gid || !home || !op) return false
  try { return JSON.stringify(list) === JSON.stringify(buildAccountPearCommand({ username: unit, uid: Number(uid), gid: Number(gid), home }, tail[0]!, tail[1]!, op, tail.at(-1)!)) } catch { return false }
}

const phpBinary = (family: 'debian' | 'rhel', version: string): string => phpBinaryProbeArgv(version, family === 'debian' ? 'dpkg' : 'rpm')[0]!
/** The installed PHP series: a CLI binary answers for each. */
export async function installedPhpVersions(family: 'debian' | 'rhel' | null): Promise<string[]> {
  if (!family) return []
  const rows = await Promise.all(SUPPORTED_PHP_VERSIONS.map(async version => await secPresent(phpBinary(family, version), 'file').catch(() => false) === true ? [version as string] : []))
  return rows.flat()
}
/** Pear and journal reads through the executor's reviewed admission. */
export const accountPearHost = (executor: { runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string }> }, family: 'debian' | 'rhel'): PearHost & { journal(unit: string): Promise<string[]> } => {
  // A pear run fetches over the network, past the default command deadline.
  const slow = new LinuxHostExecutor({ timeoutMs: 180_000 })
  return { family, phpBinary: version => phpBinary(family, version), present: secPresent, run: argv => slow.runCommand(argv),
    journal: async unit => (await executor.runCommand(['/usr/bin/journalctl', '--unit=' + unit, '--lines=20', '--no-pager', '--output=cat', '--quiet'])).stdout.split('\n').filter(Boolean).map(line => line.slice(0, 300)) }
}

export interface AccountPackageRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, action: (account: Account) => Promise<T>): Promise<T>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listDomains(): Promise<Domain[]> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  files(account: Account, plan: Plan): AccountPackageFiles
  /** Host reads and the pear unit; null off a Linux host. */
  host: (PearHost & { journal(unit: string): Promise<string[]> }) | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
const digest = (rows: readonly AccountPackageRow[]): string => createHash('sha256').update(JSON.stringify(rows)).digest('hex')

async function observe(deps: AccountPackageRouteDeps, account: Account, plan: Plan, results: PearSearchRow[]): Promise<AccountPackagesView> {
  const packages = await readPearInventory(deps.files(account, plan)), host = deps.host
  const primary = (await deps.store.listDomains()).find(domain => domain.accountId === account.id && domain.name === account.primaryDomain)
  const phpVersion = primary?.php.version ?? null, base = account.home + '/' + ACCOUNT_PEAR_LIBRARY
  const server = host && phpVersion ? await observePear(host, phpVersion).catch(() => null) : null
  return {
    context: { accountId: account.id, username: account.username }, ecosystem: 'pear', library: base, includeSnippet: `ini_set('include_path', '${base}' . PATH_SEPARATOR . ini_get('include_path'));`,
    phpVersion, engine: server !== null && server.state !== 'not_installed', requiredPackage: host && phpVersion ? pearPackageName(host.family, phpVersion) : null, revision: digest(packages), packages, results,
    system: [...SYSTEM_PEAR_PACKAGES.map(name => ({ name, version: null })), ...(server?.packages ?? []).filter(row => !SYSTEM_PEAR_PACKAGES.includes(row.name)).map(row => ({ name: row.name, version: row.version }))],
  }
}

export async function handleAccountPackagesRoute(req: Request, url: URL, method: string, deps: AccountPackageRouteDeps): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/packages$/.exec(url.pathname); if (!match) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return invalid()
  if (deps.caller.role !== 'user' || !deps.caller.accountId) return fail('FORBIDDEN', 'package workspace requires the signed-in account owner', unchanged)
  let raw: unknown
  if (method === 'POST') { const body = await req.text(); if (body.length > 1024) return invalid(); try { raw = JSON.parse(body) } catch { return invalid() } }
  const request = parseAccountPackageRequest(method, raw), caller = deps.caller, account = await deps.store.getAccountByUsername(match[1]!)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'package account does not match the current owner', unchanged)
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<Plan> => {
      const principal = await deps.currentPrincipal(), plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== fresh.id || fresh.status !== 'active' || !plan || !features || features.disabled.includes(ACCOUNT_PACKAGE_FEATURE)) return fail('FORBIDDEN', 'this account may not manage PEAR packages', unchanged)
      return plan
    }
    const plan = await authorize(), view = (results: PearSearchRow[] = []): Promise<AccountPackagesView> => observe(deps, fresh, plan, results)
    const reply = (value: AccountPackagesView): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    if (request.op === 'read') return reply(await view())
    const host = deps.host, primary = (await deps.store.listDomains()).find(domain => domain.accountId === fresh.id && domain.name === fresh.primaryDomain), phpVersion = primary?.php.version
    if (!host || !phpVersion) return fail('PRECONDITION_FAILED', 'PEAR needs a Linux host and a PHP site', { ...unchanged, reason: 'pear_unavailable' })
    if (request.op === 'search') return reply(await view(await searchPear(host, phpVersion, request.query)))
    if (request.op === 'remove' && SYSTEM_PEAR_PACKAGES.includes(request.name)) return fail('FORBIDDEN', 'this package belongs to the server PHP installation', { ...unchanged, reason: 'system_package' })
    const before = await view()
    if (request.expectedRevision !== before.revision) return fail('CONFLICT', 'the PEAR library changed; read it again', unchanged)
    if (!before.engine) return fail('PRECONDITION_FAILED', 'PEAR is not installed for this PHP version', { ...unchanged, reason: 'pear_not_installed', requiredPackage: before.requiredPackage })
    const installed = before.packages.some(row => row.name === request.name)
    if (request.op === 'install' && installed) return fail('CONFLICT', 'this package is installed', unchanged)
    if (request.op !== 'install' && !installed) return fail('NOT_FOUND', 'this package is not installed', unchanged)
    const unit = pearUnitName(fresh.username)
    await host.run(['/usr/bin/systemctl', 'reset-failed', '--', unit]).catch(() => undefined)
    const ran = await host.run(buildAccountPearCommand(fresh, host.phpBinary(phpVersion), pearCommandPath(host.family, phpVersion), request.op, request.name)).catch(() => ({ ok: false, stdout: '' }))
    await authorize()
    const after = await view()
    const present = after.packages.some(row => row.name === request.name), done = ran.ok && (request.op === 'remove' ? !present : present)
    await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.packages.' + request.op, target: 'account:' + fresh.username, detail: { ecosystem: 'pear', name: request.name }, outcome: done ? 'ok' : 'failed' }).catch(() => undefined)
    if (!done) return fail('PRECONDITION_FAILED', 'the pear installer did not finish this change', { stateChanged: after.revision !== before.revision, reason: 'pear_failed', log: (await host.journal(unit).catch(() => [])).slice(-5) })
    return reply(after)
  })
}
