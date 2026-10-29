import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { MAX_BINARY_BYTES, MAX_DIR_MODE, MAX_FILE_MODE } from './file-manager.ts'
import type { JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

/** Same socket budget as file restore: no new file starts after 20 s. */
export const STAGING_TIME_BUDGET_MS = 20_000
export const STAGING_LIMITS = { files: 500, directories: 200, bytes: 64 * 1024 * 1024, fileBytes: MAX_BINARY_BYTES } as const
export const STAGING_ROOT = 'staging'
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/staging\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(copy|review|promote|discard))?$/
const unchanged = { stateChanged: false }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export type StagingFiles = Pick<JailedFileManager, 'list' | 'mkdir' | 'putBytes' | 'getBytes' | 'moveToTrash' | 'restoreFromTrash'>
export interface StagingEntry { path: string; bytes: number; mode: number; sha256: string }
export interface StagingTree { exists: boolean; files: StagingEntry[]; directories: string[]; links: number }
export type StagingChange = 'add' | 'change' | 'remove'
export interface StagingDiffRow { path: string; change: StagingChange; bytes: number }

/** Home-relative document root of an owned, served domain; aliases share their parent's files and redirects serve none. */
export function stagingSource(account: Pick<Account, 'id' | 'home'>, domain: Domain, all: readonly Domain[]): { live: string; staging: string } {
  if (domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', unchanged)
  if (domain.kind === 'alias' || domain.redirect !== null || domain.suspended) return fail('PRECONDITION_FAILED', 'only an active domain with its own document root can be staged', unchanged)
  const relative = (root: string): string | null => root.startsWith(account.home + '/') && !root.slice(account.home.length + 1).split('/').some(part => !part || part === '.' || part === '..') ? root.slice(account.home.length + 1) : null
  const live = relative(domain.docRoot), staging = STAGING_ROOT + '/' + domain.name
  if (!live) return fail('PRECONDITION_FAILED', 'the domain document root is not inside the account home', unchanged)
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
  if (all.some(item => item.accountId === account.id && overlaps(relative(item.docRoot) ?? '', staging))) return fail('CONFLICT', 'a document root overlaps the staging folder; staging is unavailable for this domain', unchanged)
  return { live, staging }
}

/** Added, changed and removed regular files between the live and staging trees, path-sorted. */
export function stagingDiff(live: readonly StagingEntry[], staging: readonly StagingEntry[]): StagingDiffRow[] {
  const current = new Map(live.map(file => [file.path, file])), next = new Map(staging.map(file => [file.path, file]))
  const rows: StagingDiffRow[] = []
  for (const file of staging) { const was = current.get(file.path); if (!was) rows.push({ path: file.path, change: 'add', bytes: file.bytes }); else if (was.sha256 !== file.sha256 || was.mode !== file.mode) rows.push({ path: file.path, change: 'change', bytes: file.bytes }) }
  for (const file of live) if (!next.has(file.path)) rows.push({ path: file.path, change: 'remove', bytes: file.bytes })
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

/** Bounded confined walk; content is hashed through the account writer, links are counted and never followed. */
export async function readStagingTree(files: StagingFiles, base: string): Promise<StagingTree> {
  const tree: StagingTree = { exists: true, files: [], directories: [], links: 0 }
  const queue = [''], listed: { path: string; mode: number }[] = []
  let bytes = 0
  while (queue.length) {
    const directory = queue.shift()!
    let entries
    try { entries = await files.list(directory ? base + '/' + directory : base, { showHidden: true }) }
    catch (error) { if (!directory && isXpanelError(error) && error.code === 'NOT_FOUND') return { exists: false, files: [], directories: [], links: 0 }; throw error }
    for (const entry of entries) {
      const path = directory ? directory + '/' + entry.name : entry.name
      if (entry.kind === 'symlink') { tree.links++; continue }
      if (entry.kind === 'directory') {
        if (tree.directories.push(path) > STAGING_LIMITS.directories) return fail('LIMIT_EXCEEDED', `a staging copy holds at most ${STAGING_LIMITS.directories} folders`, unchanged)
        queue.push(path); continue
      }
      bytes += entry.sizeBytes
      if (entry.sizeBytes > STAGING_LIMITS.fileBytes || listed.length >= STAGING_LIMITS.files || bytes > STAGING_LIMITS.bytes) return fail('LIMIT_EXCEEDED', `a staging copy holds at most ${STAGING_LIMITS.files} files of up to 2 MiB each and 64 MiB in total`, unchanged)
      listed.push({ path, mode: (entry.mode & MAX_FILE_MODE) || 0o600 })
    }
  }
  // Contents are read only after the listing fits every bound.
  for (const item of listed) {
    const content = await files.getBytes(base + '/' + item.path), raw = Buffer.from(content.contentBase64, 'base64')
    if (raw.length !== content.sizeBytes) return fail('CONFLICT', 'a file changed while it was read', unchanged)
    tree.files.push({ path: item.path, bytes: raw.length, mode: item.mode, sha256: sha(raw) })
  }
  tree.files.sort((a, b) => a.path.localeCompare(b.path)); tree.directories.sort()
  return tree
}

export interface StagingRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccount(id: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>
    listDomains(filter: { accountId: string }): Promise<Domain[]>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T> }
  /** Direct local principal read; no API self-RPC inside the lease. */
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId?: string | null; disabled: boolean } | null>
  /** Confined account writer, or null when the native file runner is not installed. */
  files(account: Account, plan: Plan): StagingFiles | null
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
  now?: () => number
}
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON staging request is required', unchanged)
  const text = await req.text()
  if (Buffer.byteLength(text) > 4096) return fail('LIMIT_EXCEEDED', 'the staging request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'the staging request must be valid JSON', unchanged) }
  return !!body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : fail('VALIDATION', 'the staging request must be an object', unchanged)
}

type ApplyResult = 'applied' | 'failed' | 'not-attempted'
/** /accounts/<username>/staging/<domainId>[/copy|review|promote|discard]: the signed-in active account owner only. */
export async function handleStagingRoute(req: Request, url: URL, method: string, deps: StagingRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, username, domainId, op] = match as unknown as [string, string, string, 'copy' | 'review' | 'promote' | 'discard' | undefined]
  if (method !== (op ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: op ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'staging requests do not accept query selectors', unchanged)
  const caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId || caller.actor !== username) return fail('FORBIDDEN', 'staging requires the signed-in account owner', unchanged)
  const body = op ? await readBody(req) : {}
  const keys = op === 'promote' ? ['expectedRevision'] : []
  if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key)) || op === 'promote' && (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision))) return fail('VALIDATION', op === 'promote' ? 'promote takes only the reviewed expectedRevision' : 'this staging request takes no fields', unchanged)
  const now = deps.now ?? Date.now, deadline = now() + STAGING_TIME_BUDGET_MS, expired = (): boolean => now() > deadline
  /** Fresh owner authority: same enabled principal bound to this active account, staging enabled by its plan. */
  const authorize = async (account: Account): Promise<{ plan: Plan; files: StagingFiles; paths: { live: string; staging: string }; domain: Domain }> => {
    const principal = await deps.currentPrincipal()
    if (!principal || principal.disabled || principal.id !== caller.principalId || principal.kind !== 'user' || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is no longer authorized', unchanged)
    if (account.id !== caller.accountId || account.username !== username || account.status !== 'active') return fail('FORBIDDEN', 'staging requires the active signed-in account', unchanged)
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!plan || !features) return fail('PRECONDITION_FAILED', 'the account plan is unavailable', unchanged)
    if (features.disabled.includes('site-staging')) return fail('FORBIDDEN', 'staging sites are disabled by the account plan', unchanged)
    const domains = await deps.store.listDomains({ accountId: account.id }), domain = domains.find(item => item.id === domainId)
    if (!domain) return fail('NOT_FOUND', 'domain not found', unchanged)
    const files = deps.files(account, plan)
    if (!files) return fail('PRECONDITION_FAILED', 'the confined account file writer is not installed on this server', unchanged)
    return { plan, files, paths: stagingSource(account, domain, domains), domain }
  }
  const context = (account: Account, domain: Domain) => ({ accountId: account.id, username: account.username, domainId: domain.id, domain: domain.name })
  const review = async (files: StagingFiles, paths: { live: string; staging: string }, domain: Domain) => {
    const live = await readStagingTree(files, paths.live), staging = await readStagingTree(files, paths.staging)
    const rows = staging.exists ? stagingDiff(live.files, staging.files) : []
    return { live, staging, rows, revision: sha(JSON.stringify({ domainId: domain.id, live: paths.live, staging: paths.staging, a: live.files, b: staging.exists ? staging.files : null })) }
  }
  const initial = await deps.store.getAccount(caller.accountId)
  if (!initial) return fail('NOT_FOUND', 'account not found', unchanged)
  if (!op || op === 'review') {
    const first = await authorize(initial), reviewed = await review(first.files, first.paths, first.domain)
    await authorize((await deps.store.getAccount(initial.id)) ?? initial)
    return json({ context: context(initial, first.domain), live: { path: first.paths.live, files: reviewed.live.files.length, bytes: reviewed.live.files.reduce((sum, file) => sum + file.bytes, 0), links: reviewed.live.links },
      staging: { path: first.paths.staging, exists: reviewed.staging.exists, files: reviewed.staging.files.length, bytes: reviewed.staging.files.reduce((sum, file) => sum + file.bytes, 0), links: reviewed.staging.links },
      ...(op ? { rows: reviewed.rows, revision: reviewed.revision } : {}), limits: STAGING_LIMITS })
  }
  return deps.store.withAccountLifecycleLease(initial.id, async fresh => {
    const { files, paths, domain } = await authorize(fresh)
    const guard = (): Promise<unknown> => authorize(fresh)
    const record = async (action: string, detail: Record<string, unknown>, ok: boolean): Promise<void> => {
      try { await deps.audit({ actor: caller.actor, action: 'staging.' + action, target: 'domain:' + domain.name, detail, outcome: ok ? 'ok' : 'failed', principalId: caller.principalId }) }
      catch { fail('SERVICE_UNAVAILABLE', 'the staging change and its audit require inspection', { stateChanged: true, verificationRequired: true }) }
    }
    if (op === 'discard') {
      const staging = await readStagingTree(files, paths.staging).catch(error => { if (isXpanelError(error) && error.code === 'LIMIT_EXCEEDED') return { exists: true } as StagingTree; throw error })
      if (!staging.exists) return fail('NOT_FOUND', 'no staging copy exists for this domain', unchanged)
      await guard()
      let trashId: string | null = null, verified = false
      try { trashId = (await files.moveToTrash(paths.staging)).id } catch (error) { if (!isXpanelError(error) || error.code === 'SERVICE_UNAVAILABLE') return fail('SERVICE_UNAVAILABLE', 'the discard outcome requires inspection', { stateChanged: true, verificationRequired: true }); throw error }
      try { verified = !(await files.list(STAGING_ROOT, { showHidden: true })).some(entry => entry.name === domain.name) } catch (error) { verified = isXpanelError(error) && error.code === 'NOT_FOUND' }
      await record('discarded', { trashId, verified }, verified)
      return json({ context: context(fresh, domain), outcome: verified ? 'discarded' : 'unknown', trashId, verificationRequired: !verified })
    }
    if (op === 'copy') {
      const live = await readStagingTree(files, paths.live)
      if (!live.exists) return fail('PRECONDITION_FAILED', 'the domain document root does not exist', unchanged)
      if (live.links) return fail('PRECONDITION_FAILED', 'the site contains links; a staging copy holds regular files and folders only', { ...unchanged, links: live.links })
      if ((await readStagingTree(files, paths.staging).catch(() => ({ exists: true }) as StagingTree)).exists) return fail('CONFLICT', 'a staging copy already exists for this domain; discard it first', unchanged)
      let attempted = false, copied = 0, failed = 0, notAttempted = 0, verificationRequired = false
      const mkdir = async (path: string): Promise<void> => { try { await files.mkdir(path, MAX_DIR_MODE) } catch (error) { if (!isXpanelError(error) || error.code !== 'CONFLICT') throw error } }
      try {
        await guard()
        await mkdir(STAGING_ROOT)
        await files.mkdir(paths.staging, MAX_DIR_MODE)
        attempted = true
        for (const directory of live.directories) await files.mkdir(paths.staging + '/' + directory, MAX_DIR_MODE)
        for (const file of live.files) {
          if (expired()) { notAttempted++; continue }
          await guard()
          const raw = Buffer.from((await files.getBytes(paths.live + '/' + file.path)).contentBase64, 'base64')
          if (sha(raw) !== file.sha256) { failed++; continue }
          await files.putBytes(paths.staging + '/' + file.path, raw.toString('base64'), { overwrite: false, mode: file.mode })
          const back = Buffer.from((await files.getBytes(paths.staging + '/' + file.path)).contentBase64, 'base64')
          if (sha(back) === file.sha256) copied++; else { failed++; verificationRequired = true }
        }
      } catch (error) {
        if (!attempted) throw error
        verificationRequired = true
      }
      const complete = copied === live.files.length && !verificationRequired
      await record('copied', { files: live.files.length, copied, failed, notAttempted, complete }, complete)
      return json({ context: context(fresh, domain), outcome: complete ? 'copied' : verificationRequired ? 'unknown' : 'incomplete', counts: { files: live.files.length, copied, failed, notAttempted }, verificationRequired })
    }
    const reviewed = await review(files, paths, domain)
    if (!reviewed.staging.exists) return fail('NOT_FOUND', 'no staging copy exists for this domain', unchanged)
    if (reviewed.revision !== body.expectedRevision) return fail('CONFLICT', 'the live site or the staging copy changed; review the changes again', unchanged)
    if (reviewed.staging.links) return fail('PRECONDITION_FAILED', 'the staging copy contains links; remove them before promoting', unchanged)
    if (!reviewed.rows.length) return fail('PRECONDITION_FAILED', 'the staging copy matches the live site; nothing to promote', unchanged)
    const wanted = new Map(reviewed.staging.files.map(file => [file.path, file]))
    const results: { path: string; change: StagingChange; result: ApplyResult; trashId: string | null; verificationRequired: boolean }[] = []
    for (const row of reviewed.rows) {
      const add = (result: ApplyResult, trashId: string | null = null, verificationRequired = false): void => { results.push({ path: row.path, change: row.change, result, trashId, verificationRequired }) }
      if (expired()) { add('not-attempted'); continue }
      let trashId: string | null = null
      try {
        await guard()
        const target = paths.live + '/' + row.path
        // Every replaced or removed live file goes to the account trash first, so the previous site stays recoverable.
        if (row.change !== 'add') trashId = (await files.moveToTrash(target)).id
        if (row.change === 'remove') { add('applied', trashId); continue }
        const file = wanted.get(row.path)!, raw = Buffer.from((await files.getBytes(paths.staging + '/' + row.path)).contentBase64, 'base64')
        if (sha(raw) !== file.sha256) throw Object.assign(new Error('staging_changed'), { stagingChanged: true })
        const parts = row.path.split('/')
        for (let index = 1; index < parts.length; index++) { try { await files.mkdir(paths.live + '/' + parts.slice(0, index).join('/'), MAX_DIR_MODE) } catch (error) { if (!isXpanelError(error) || error.code !== 'CONFLICT') throw error } }
        await files.putBytes(target, raw.toString('base64'), { overwrite: false, mode: file.mode })
        const back = Buffer.from((await files.getBytes(target)).contentBase64, 'base64')
        add(sha(back) === file.sha256 ? 'applied' : 'failed', trashId, sha(back) !== file.sha256)
      } catch {
        // Put the previous live file back when the new one could not be written; otherwise the outcome needs inspection.
        let restored = false
        if (trashId) try { await files.restoreFromTrash(trashId, { overwrite: false }); restored = true } catch { restored = false }
        add('failed', restored ? null : trashId, !!trashId && !restored)
      }
    }
    const counts: Record<ApplyResult, number> = { applied: 0, failed: 0, 'not-attempted': 0 }
    for (const row of results) counts[row.result]++
    const verificationRequired = results.some(row => row.verificationRequired)
    await record('promoted', { revision: reviewed.revision, counts, verificationRequired }, !counts.failed && !verificationRequired)
    return json({ context: context(fresh, domain), outcome: counts.applied === results.length ? 'promoted' : verificationRequired ? 'unknown' : 'incomplete', results, counts, revision: reviewed.revision, verificationRequired })
  })
}
