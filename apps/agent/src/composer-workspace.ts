import { fail } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import { COMPOSER_VERSION_ARGV } from '../../../packages/os/src/composer-command.ts'
import { readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import type { ComposerPackageView, ComposerProjectTarget, ComposerProjectView, ComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import type { JailedFileManager } from './file-manager.ts'
import { handleComposerJobRoute, isComposerJobProviderQualified } from './composer-job.ts'
import type { ComposerJobServices } from './composer-job.ts'

type ComposerFiles = Pick<JailedFileManager, 'list' | 'readText'>
export interface ComposerWorkspaceContext {
  assertRoot(action: string): Promise<{ actor: string }>
  store: { listAccounts(): Promise<Account[]>; listDomains(): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; withAccountLifecycleLease<T>(id: string, operation: (account: Account) => Promise<T>): Promise<T> }
  /** null without qualified descriptor-confined native account file operations. */
  files(account: Account, plan: Plan): ComposerFiles | null
  /** null without a qualified Linux executor; only the fixed version command is used. */
  run: ((argv: string[]) => Promise<{ ok: boolean; code?: number | null; stdout: string; stderr: string }>) | null
  now?: () => Date
  /** Absent until the descriptor-confined transaction provider passes native qualification. */
  composerJobs?: ComposerJobServices | null
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const packageName = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/
const safeVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9.+_~^*<>=!|, /:-]{1,128}$/.test(value) && !value.includes('://')
const unavailable = (selector: string, reason: 'invalid-project-data' | 'project-read-unavailable'): ComposerProjectView => ({ selector, state: 'unavailable', reason, manifest: 'unavailable', lock: 'unavailable', vendor: 'unavailable', lockMatch: 'not-verified', lockFreshness: 'not-verified', packages: [] })
const invalid = (): never => { throw new Error('invalid_composer_data') }

/** Composer documents are data only: no config, repositories, URLs, scripts or credentials are returned. */
export function parseComposerDocuments(manifestText: string, lockText: string | null, installedText: string | null): ComposerPackageView[] {
  const decode = (text: string): unknown => { if (Buffer.byteLength(text) > 1024 * 1024) return invalid(); return JSON.parse(text) }
  const manifest = decode(manifestText)
  if (!object(manifest)) return invalid()
  const rows = new Map<string, ComposerPackageView>()
  const row = (name: string): ComposerPackageView => {
    if (!packageName.test(name) || name.length > 200) return invalid()
    const current = rows.get(name) ?? { name, requirement: null, locked: null, installed: null, development: false }
    rows.set(name, current)
    if (rows.size > 1000) return invalid()
    return current
  }
  const required = new Set<string>()
  for (const key of ['require', 'require-dev']) {
    if (manifest[key] === undefined) continue
    const dependencies = manifest[key]
    if (!object(dependencies) || Object.keys(dependencies).length > 1000) return invalid()
    for (const [name, requirement] of Object.entries(dependencies)) {
      if (!safeVersion(requirement) || required.has(name)) return invalid()
      required.add(name)
      if (!packageName.test(name)) {
        if (!/^(?:php(?:-64bit|-ipv6|-zts|-debug)?|(?:ext|lib)-[a-z0-9_.-]+|composer(?:-plugin-api|-runtime-api)?)$/.test(name)) return invalid()
        continue
      }
      const item = row(name); item.requirement = requirement; item.development = key === 'require-dev'
    }
  }
  const parsePackages = (items: unknown, kind: 'locked' | 'installed', dev: boolean, seen: Set<string>): void => {
    if (!Array.isArray(items) || items.length > 1000) return invalid()
    for (const raw of items) {
      if (!object(raw) || typeof raw.name !== 'string' || !safeVersion(raw.version) || seen.has(raw.name)) return invalid()
      seen.add(raw.name)
      const current = row(raw.name); current[kind] = raw.version; current.development ||= dev
    }
  }
  if (lockText !== null) {
    const lock = decode(lockText), seen = new Set<string>()
    if (!object(lock) || !Object.hasOwn(lock, 'packages') || !Object.hasOwn(lock, 'packages-dev')) return invalid()
    parsePackages(lock.packages, 'locked', false, seen); parsePackages(lock['packages-dev'], 'locked', true, seen)
  }
  // Composer installed.json supports the Composer 1 list and Composer 2 {packages:[...]} format.
  if (installedText !== null) {
    const installed = decode(installedText)
    parsePackages(Array.isArray(installed) ? installed : object(installed) ? installed.packages : null, 'installed', false, new Set())
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))
}

async function inspectProject(target: ComposerProjectTarget, files: ComposerFiles): Promise<ComposerProjectView> {
  const relative = target.directory.slice(('/home/' + target.account + '/').length)
  const parts = relative.split('/'); let parent = ''
  const documents = new Map<string, string>()
  const read = async (path: string): Promise<string | null> => {
    const boundary = path.lastIndexOf('/'), directory = path.slice(0, boundary), name = path.slice(boundary + 1)
    const entry = (await files.list(directory, { showHidden: true })).find(item => item.name === name)
    if (!entry) return null
    if (entry.kind !== 'file' || entry.sizeBytes > 1024 * 1024) return invalid()
    const result = await files.readText(path)
    if (Buffer.byteLength(result.content) > 1024 * 1024 || result.sizeBytes !== entry.sizeBytes || result.mtime !== entry.mtime) return invalid()
    documents.set(path, result.content); return result.content
  }
  try {
    for (const part of parts) {
      const entry = (await files.list(parent, { showHidden: true })).find(item => item.name === part)
      if (!entry || entry.kind !== 'directory') return unavailable(target.selector, 'project-read-unavailable')
      parent = parent ? parent + '/' + part : part
    }
    const manifest = await read(relative + '/composer.json')
    if (manifest === null) return { selector: target.selector, state: 'missing', reason: 'composer-json-missing', manifest: 'missing', lock: 'unavailable', vendor: 'unavailable', lockMatch: 'not-verified', lockFreshness: 'not-verified', packages: [] }
    const lock = await read(relative + '/composer.lock')
    const vendor = (await files.list(relative, { showHidden: true })).find(item => item.name === 'vendor')
    if (vendor && vendor.kind !== 'directory') return invalid()
    let installed: string | null = null
    if (vendor) {
      const metadata = (await files.list(relative + '/vendor', { showHidden: true })).find(item => item.name === 'composer')
      if (metadata && metadata.kind !== 'directory') return invalid()
      if (metadata) installed = await read(relative + '/vendor/composer/installed.json')
    }
    const packages = parseComposerDocuments(manifest, lock, installed)
    // Re-read the same bounded documents before returning; a changing project is never a healthy snapshot.
    for (const [path, content] of documents) if ((await files.readText(path)).content !== content) return invalid()
    const locked = packages.filter(item => item.locked !== null), present = packages.filter(item => item.installed !== null)
    const lockMatch = lock === null || installed === null ? 'not-verified' : locked.length === present.length && locked.every(item => item.locked === item.installed) ? 'matches' : 'differs'
    return { selector: target.selector, state: 'read', reason: null, manifest: 'present', lock: lock === null ? 'missing' : 'present', vendor: installed === null ? 'missing' : 'present', lockMatch, lockFreshness: 'not-verified', packages }
  } catch (error) {
    return unavailable(target.selector, error instanceof Error && (error.message === 'invalid_composer_data' || error instanceof SyntaxError) ? 'invalid-project-data' : 'project-read-unavailable')
  }
}

export async function handleComposerWorkspaceRoute(_request: Request, url: URL, method: string, ctx: ComposerWorkspaceContext): Promise<Response | null> {
  const jobResponse = await handleComposerJobRoute(_request, url, method, ctx, ctx.composerJobs)
  if (jobResponse) return jobResponse
  if (url.pathname !== '/host/composer') return null
  const first = await ctx.assertRoot('software.composer.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const keys = [...url.searchParams.keys()], selector = url.searchParams.get('domainId')
  if (keys.length > 1 || keys.length === 1 && keys[0] !== 'domainId' || selector !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(selector)) return fail('VALIDATION', 'select one saved site; paths, commands, URLs and additional selectors are not accepted', { stateChanged: false })
  const fresh = async (): Promise<void> => { if ((await ctx.assertRoot('software.composer.read')).actor !== first.actor) return fail('FORBIDDEN', 'Composer authority changed', { stateChanged: false }) }
  const [accounts, domains] = await Promise.all([ctx.store.listAccounts(), ctx.store.listDomains()])
  if (accounts.length > 10000 || domains.length > 1000) return fail('PRECONDITION_FAILED', 'Composer target inventory exceeds the workspace bound', { stateChanged: false })
  const owners = new Map(accounts.map(account => [account.id, account]))
  const projects: ComposerProjectTarget[] = []
  for (const domain of domains) {
    const account = owners.get(domain.accountId)
    if (!account || account.status !== 'active' || domain.suspended || domain.siteType !== 'php' || account.home !== '/home/' + account.username || !domain.docRoot.startsWith(account.home + '/') || !/^\/home\/[a-z][a-z0-9]{0,15}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(domain.docRoot) || domain.docRoot.split('/').some(part => part === '.' || part === '..')) continue
    projects.push({ selector: domain.id, domain: domain.name, account: account.username, directory: domain.docRoot, phpVersion: domain.php.version })
  }
  projects.sort((a, b) => a.domain.localeCompare(b.domain, 'en'))
  const target = selector === null ? null : projects.find(item => item.selector === selector)
  if (selector !== null && !target) return fail('NOT_FOUND', 'the selected active PHP site is unavailable', { stateChanged: false })
  let binary: ComposerWorkspaceView['binary'] = { state: 'unavailable', executable: '/usr/bin/composer', version: null }
  if (ctx.run) {
    try {
      const result = await ctx.run([...COMPOSER_VERSION_ARGV])
      // Composer CLI documents --version; accept a complete version line, never raw stdout/stderr.
      const match = /^Composer (?:version )?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?: [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2})?\r?\n?$/.exec(result.stdout)
      if (result.ok && (result.code === undefined || result.code === 0) && Buffer.byteLength(result.stdout) <= 1024 && match) binary = { state: 'read', executable: '/usr/bin/composer', version: match[1]! }
    } catch { /* The unavailable binary state remains truthful. */ }
  }
  let selected: ComposerProjectView | null = null
  if (target) {
    const domain = domains.find(item => item.id === target.selector)!, owner = owners.get(domain.accountId)!
    selected = await ctx.store.withAccountLifecycleLease(owner.id, async account => {
      await fresh()
      const current = (await ctx.store.listDomains()).find(item => item.id === target.selector), plan = await ctx.store.getPlan(account.planId)
      if (!current || account.status !== 'active' || current.suspended || current.accountId !== account.id || current.docRoot !== target.directory || current.siteType !== 'php' || current.php.version !== target.phpVersion || account.username !== target.account || account.home !== '/home/' + target.account) return fail('CONFLICT', 'the selected site changed; read targets again', { stateChanged: false })
      const files = plan ? ctx.files(account, plan) : null
      const view = files ? await inspectProject(target, files) : unavailable(target.selector, 'project-read-unavailable')
      await fresh(); return view
    })
  }
  await fresh()
  const jobs = ctx.composerJobs, runnable = !!jobs && !!jobs.family && !!jobs.submitJob && isComposerJobProviderQualified(jobs.provider)
  const view = readComposerWorkspaceView({ scope: 'saved-site-document-roots', observedAt: (ctx.now?.() ?? new Date()).toISOString(), binary, projects, selected, actions: runnable ? { install: true, update: true, mirror: false, reason: null } : { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } })
  return Response.json(view, { headers: { 'cache-control': 'no-store' } })
}
