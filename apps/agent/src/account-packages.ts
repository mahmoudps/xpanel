import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { ACCOUNT_PEAR_LIBRARY as LIBRARY, ACCOUNT_PEAR_REGISTRY as REGISTRY, ACCOUNT_PEAR_TRANSACTION as TRANSACTION, ACCOUNT_PEAR_LIMITS as LIMITS, isPearFile, isPearName, isPearVersion, pearSource } from '../../../packages/os/src/account-package-command.ts'
import type { FileText, JailedFileManager } from './file-manager.ts'
import type { AgentCallerIdentity } from './server.ts'

export const ACCOUNT_PACKAGE_FEATURE = 'php-pear-packages'
export type AccountPackageFiles = Pick<JailedFileManager, 'list' | 'readText' | 'writeTextChecked' | 'mkdir'>
interface Requirement { name: string; version: string }
export interface PearPackage { name: string; version: string; source: string; archiveSha256: string; requires: Requirement[]; files: { path: string; sha256: string }[] }
export interface PearArtifact extends PearPackage { summary: string; files: { path: string; sha256: string; content: string }[] }
export interface VerifiedPearCatalog { revision: string; packages: PearArtifact[] }
export type AccountPackageRequest = { op: 'read' } | { op: 'install' | 'remove'; name: string; expectedRevision: string } | { op: 'recover'; expectedRevision: string }
export interface AccountPackagesView {
  context: { accountId: string; username: string }; ecosystem: 'pear'; scope: 'managed-private-library'; library: typeof LIBRARY
  revision: string; catalogRevision: string | null; inventory: 'verified' | 'recovery-required'; packages: PearPackage[]
  available: { name: string; version: string; summary: string; source: string; requires: Requirement[] }[]
  recovery: 'none' | 'prepared' | 'needs-review' | 'committed' | 'rolled-back'; capabilities: { install: boolean; remove: boolean; recover: boolean }
  application: { op: AccountPackageRequest['op']; state: 'read' | 'verified'; verificationRequired: false }
}
type Registry = { schema: 1; accountId: string; packages: PearPackage[] }
type Change = { path: string; before: FileText | null; beforeMode: number; content: string | null }
interface Journal { schema: 1; accountId: string; phase: Exclude<AccountPackagesView['recovery'], 'none'>; changes: Change[] }
const SHA = /^[0-9a-f]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const invalid = (): never => fail('VALIDATION', 'invalid private PEAR package request', { stateChanged: false })
const unsupported = (message = 'private PEAR library observation is incomplete'): never => fail('PRECONDITION_FAILED', message, { stateChanged: false })
const unknown = (): never => fail('SERVICE_UNAVAILABLE', 'package operation needs recovery or inspection before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= maximum
const requirements = (raw: unknown): Requirement[] => {
  if (!Array.isArray(raw) || raw.length > LIMITS.packages) return unsupported()
  const result = raw.map(item => { if (!object(item) || !exact(item, ['name', 'version']) || !isPearName(item.name) || !isPearVersion(item.version)) return unsupported(); return { name: item.name, version: item.version } })
  if (new Set(result.map(item => item.name)).size !== result.length) return unsupported()
  return result
}
function packageRecord(raw: unknown, artifact: boolean): PearArtifact {
  if (!object(raw) || !exact(raw, artifact ? ['name', 'version', 'source', 'archiveSha256', 'requires', 'files', 'summary'] : ['name', 'version', 'source', 'archiveSha256', 'requires', 'files']) || !isPearName(raw.name) || !isPearVersion(raw.version) || raw.source !== pearSource(raw.name, raw.version) || typeof raw.archiveSha256 !== 'string' || !SHA.test(raw.archiveSha256) || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > LIMITS.files) return unsupported()
  let bytes = 0
  const files = raw.files.map(file => {
    if (!object(file) || !exact(file, artifact ? ['path', 'sha256', 'content'] : ['path', 'sha256']) || !isPearFile(file.path) || typeof file.sha256 !== 'string' || !SHA.test(file.sha256)) return unsupported()
    if (artifact && (!text(file.content, LIMITS.fileBytes) || digest(file.content) !== file.sha256)) return unsupported('catalog PHP file checksum did not match')
    const content = artifact ? file.content as string : ''; bytes += Buffer.byteLength(content)
    return { path: file.path, sha256: file.sha256, content }
  })
  if (bytes > LIMITS.packageBytes || new Set(files.map(file => file.path)).size !== files.length || artifact && (!text(raw.summary, 300) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw.summary))) return unsupported()
  return { name: raw.name, version: raw.version, source: raw.source as string, archiveSha256: raw.archiveSha256, requires: requirements(raw.requires), files, summary: artifact ? raw.summary as string : '' }
}
/** Only a protected daemon digest can authorize this exact catalog payload; HTTP never supplies artifacts or URLs. */
export function verifyPearCatalog(payload: string, expectedSha256: string): VerifiedPearCatalog {
  if (!text(payload, LIMITS.catalogBytes) || !SHA.test(expectedSha256) || digest(payload) !== expectedSha256) return unsupported('the pinned PEAR catalog digest did not match')
  let raw: unknown; try { raw = JSON.parse(payload) } catch { return unsupported('the pinned PEAR catalog is malformed') }
  if (!object(raw) || !exact(raw, ['schema', 'channel', 'packages']) || raw.schema !== 1 || raw.channel !== 'pear.php.net' || !Array.isArray(raw.packages) || raw.packages.length > LIMITS.packages) return unsupported()
  const packages = raw.packages.map(item => packageRecord(item, true)), byName = new Map(packages.map(item => [item.name, item]))
  if (byName.size !== packages.length) return unsupported()
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (item: PearArtifact): void => { if (visiting.has(item.name)) return unsupported('the PEAR catalog has cyclic dependencies'); if (visited.has(item.name)) return; visiting.add(item.name)
    for (const dependency of item.requires) { const target = byName.get(dependency.name); if (!target || target.version !== dependency.version) return unsupported('the PEAR catalog dependency is not pinned'); visit(target) }
    visiting.delete(item.name); visited.add(item.name)
  }
  for (const item of packages) visit(item)
  for (const item of packages) { item.files.forEach(file => Object.freeze(file)); item.requires.forEach(dependency => Object.freeze(dependency)); Object.freeze(item.files); Object.freeze(item.requires); Object.freeze(item) }
  Object.freeze(packages)
  return { revision: expectedSha256, packages }
}
const publicPackage = (item: PearPackage): PearPackage => ({ name: item.name, version: item.version, source: item.source, archiveSha256: item.archiveSha256, requires: item.requires.map(value => ({ ...value })), files: item.files.map(({ path, sha256 }) => ({ path, sha256 })) })
export function parseAccountPackageRequest(method: string, raw?: unknown): AccountPackageRequest {
  if (method === 'GET') return { op: 'read' }
  if (method !== 'POST' || !object(raw) || typeof raw.expectedRevision !== 'string' || !SHA.test(raw.expectedRevision)) return invalid()
  if (raw.op === 'recover' && exact(raw, ['op', 'expectedRevision'])) return { op: 'recover', expectedRevision: raw.expectedRevision }
  if (['install', 'remove'].includes(raw.op as string) && exact(raw, ['op', 'name', 'expectedRevision']) && isPearName(raw.name)) return raw as unknown as AccountPackageRequest
  return invalid()
}
async function readOptional(files: AccountPackageFiles, path: string): Promise<FileText | null> {
  const parts = path.split('/'); let parent = ''
  for (let index = 0; index < parts.length; index++) {
    const entry = (await files.list(parent, { showHidden: true })).find(value => value.name === parts[index])
    if (!entry) return null
    if (entry.kind !== (index === parts.length - 1 ? 'file' : 'directory')) return unsupported('package paths must be regular files in directories without symlinks')
    parent = parent ? parent + '/' + parts[index] : parts[index]!
  }
  return files.readText(path)
}
async function readMode(files: AccountPackageFiles, path: string): Promise<number> {
  const parts = path.split('/'), entry = (await files.list(parts.slice(0, -1).join('/'), { showHidden: true })).find(value => value.name === parts.at(-1))
  if (!entry || entry.kind !== 'file' || !Number.isSafeInteger(entry.mode) || entry.mode <= 0 || (entry.mode & ~0o640) !== 0) return unsupported('managed package file permissions cannot be safely preserved')
  return entry.mode
}
function parseRegistry(document: FileText | null, accountId: string): Registry {
  if (!document) return { schema: 1, accountId, packages: [] }
  if (!text(document.content, LIMITS.registryBytes)) return unsupported()
  let raw: unknown; try { raw = JSON.parse(document.content) } catch { return unsupported('the managed package registry is malformed') }
  if (!object(raw) || !exact(raw, ['schema', 'accountId', 'packages']) || raw.schema !== 1 || raw.accountId !== accountId || !Array.isArray(raw.packages) || raw.packages.length > LIMITS.packages) return unsupported()
  const packages = raw.packages.map(item => publicPackage(packageRecord(item, false))), paths = packages.flatMap(item => item.files.map(file => file.path))
  if (new Set(packages.map(item => item.name)).size !== packages.length || new Set(paths).size !== paths.length || packages.some(item => item.requires.some(dependency => !packages.some(target => target.name === dependency.name && target.version === dependency.version)))) return unsupported('the managed package dependency registry is inconsistent')
  return { schema: 1, accountId, packages }
}
function parseJournal(document: FileText | null, accountId: string): Journal | null {
  if (!document) return null
  if (!text(document.content, LIMITS.snapshotBytes)) return unsupported()
  let raw: unknown; try { raw = JSON.parse(document.content) } catch { return unsupported('the package recovery snapshot is malformed') }
  if (!object(raw) || !exact(raw, ['schema', 'accountId', 'phase', 'changes']) || raw.schema !== 1 || raw.accountId !== accountId || !['prepared', 'needs-review', 'committed', 'rolled-back'].includes(raw.phase as string) || !Array.isArray(raw.changes) || !raw.changes.length || raw.changes.length > LIMITS.files + 1) return unsupported()
  const changes = raw.changes.map(change => {
    if (!object(change) || !exact(change, ['path', 'before', 'beforeMode', 'content']) || typeof change.path !== 'string' || !(change.path === REGISTRY || change.path.startsWith(LIBRARY + '/') && isPearFile(change.path.slice(LIBRARY.length + 1))) || typeof change.beforeMode !== 'number' || !Number.isSafeInteger(change.beforeMode) || change.beforeMode <= 0 || (change.beforeMode & ~0o640) !== 0 || !(change.content === null || text(change.content, change.path === REGISTRY ? LIMITS.registryBytes : LIMITS.fileBytes))) return unsupported()
    const before = change.before
    if (before !== null && (!object(before) || !exact(before, ['path', 'content', 'sizeBytes', 'mtime']) || before.path !== change.path || !text(before.content, change.path === REGISTRY ? LIMITS.registryBytes : LIMITS.fileBytes) || before.sizeBytes !== Buffer.byteLength(before.content) || typeof before.mtime !== 'string' || !Number.isFinite(Date.parse(before.mtime)))) return unsupported()
    return { path: change.path, before: before as unknown as FileText | null, beforeMode: change.beforeMode, content: change.content as string | null }
  })
  if (new Set(changes.map(change => change.path)).size !== changes.length || changes.filter(change => change.path === REGISTRY).length !== 1) return unsupported()
  return { schema: 1, accountId, phase: raw.phase as Journal['phase'], changes }
}
async function ensureParents(files: AccountPackageFiles, path: string, authorize: () => Promise<void>): Promise<void> {
  let parent = ''
  for (const part of path.split('/').slice(0, -1)) { const entry = (await files.list(parent, { showHidden: true })).find(value => value.name === part); parent = parent ? parent + '/' + part : part
    if (entry && entry.kind !== 'directory') return unsupported('a package directory is not a regular directory')
    if (!entry) { await authorize(); await files.mkdir(parent, 0o750) }
  }
}
async function observe(input: { account: Account; files: AccountPackageFiles; catalog: VerifiedPearCatalog | null; qualified: boolean; request: AccountPackageRequest; authorize(): Promise<void> }): Promise<{ view: AccountPackagesView; registry: Registry; document: FileText | null; journal: Journal | null; journalDocument: FileText | null }> {
  const { account, files, catalog, request } = input
  await input.authorize()
  const document = await readOptional(files, REGISTRY), journalDocument = await readOptional(files, TRANSACTION), journal = parseJournal(journalDocument, account.id), pending = !!journal && ['prepared', 'needs-review'].includes(journal.phase)
  const registry = pending ? { schema: 1 as const, accountId: account.id, packages: [] } : parseRegistry(document, account.id)
  if (!pending) for (const item of registry.packages) for (const file of item.files) { const current = await readOptional(files, LIBRARY + '/' + file.path); if (!current || digest(current.content) !== file.sha256) return unsupported('managed package files changed; inspect the private library before continuing') }
  await input.authorize()
  const revision = digest(JSON.stringify([account.id, document?.content ?? null, journalDocument?.content ?? null]))
  return { document, journalDocument, journal, registry, view: { context: { accountId: account.id, username: account.username }, ecosystem: 'pear', scope: 'managed-private-library', library: LIBRARY, revision, catalogRevision: catalog?.revision ?? null, inventory: pending ? 'recovery-required' : 'verified', packages: registry.packages,
    available: (catalog?.packages ?? []).map(item => ({ name: item.name, version: item.version, summary: item.summary, source: item.source, requires: item.requires.map(value => ({ ...value })) })), recovery: journal?.phase ?? 'none', capabilities: { install: input.qualified && !!catalog && !pending, remove: input.qualified && !pending, recover: input.qualified && pending }, application: { op: request.op, state: request.op === 'read' ? 'read' : 'verified', verificationRequired: false } } }
}
async function saveJournal(files: AccountPackageFiles, journal: Journal, before: FileText | null, authorize: () => Promise<void>): Promise<FileText> {
  const content = JSON.stringify(journal) + '\n'
  if (!text(content, LIMITS.snapshotBytes)) return unsupported('the package recovery snapshot is too large')
  await ensureParents(files, TRANSACTION, authorize); await authorize(); await files.writeTextChecked(TRANSACTION, content, before, 0o600)
  const after = await readOptional(files, TRANSACTION); if (!after || after.content !== content) return unknown(); return after
}
async function restoreJournal(files: AccountPackageFiles, journal: Journal, journalDocument: FileText, authorize: () => Promise<void>): Promise<void> {
  for (const change of [...journal.changes].reverse()) {
    const current = await readOptional(files, change.path), before = change.before?.content ?? null
    if ((current?.content ?? null) === before) continue
    if ((current?.content ?? null) !== change.content) return unknown()
    await authorize(); await files.writeTextChecked(change.path, before, current, change.beforeMode)
    if ((await readOptional(files, change.path))?.content !== change.before?.content) return unknown()
  }
  await saveJournal(files, { ...journal, phase: 'rolled-back' }, journalDocument, authorize)
}
export async function runAccountPackageRequest(input: { account: Account; files: AccountPackageFiles; catalog: VerifiedPearCatalog | null; admitMutation?: () => Promise<void>; request: AccountPackageRequest; authorize(): Promise<void> }): Promise<AccountPackagesView> {
  const initial = await observe({ ...input, qualified: !!input.admitMutation }), { request, files } = input
  if (request.op === 'read') return initial.view
  if (request.expectedRevision !== initial.view.revision) return fail('CONFLICT', 'private package library changed; read it again', { stateChanged: false })
  if (!input.admitMutation) return unsupported('the account-confined package mutation provider is not qualified')
  const writeAuthority = async (): Promise<void> => { await input.authorize(); await input.admitMutation!(); await input.authorize() }
  await writeAuthority()
  if (request.op === 'recover') {
    if (!initial.journal || !initial.journalDocument || !initial.view.capabilities.recover) return unsupported('there is no pending package operation to recover')
    try { await restoreJournal(files, initial.journal, initial.journalDocument, writeAuthority); return (await observe({ ...input, qualified: true })).view } catch { return unknown() }
  }
  if (initial.view.inventory !== 'verified') return unsupported('recover the pending package operation before changing the library')
  const installed = initial.registry.packages.find(item => item.name === request.name), artifact = input.catalog?.packages.find(item => item.name === request.name)
  let packages: PearPackage[], changes: Change[]
  if (request.op === 'install') {
    if (!artifact || installed || initial.registry.packages.length >= LIMITS.packages) return unsupported('choose an uninstalled package from the pinned catalog within the account limit')
    if (artifact.requires.some(dependency => !initial.registry.packages.some(item => item.name === dependency.name && item.version === dependency.version))) return fail('CONFLICT', 'install the exact pinned dependencies first', { stateChanged: false })
    packages = [...initial.registry.packages, publicPackage(artifact)]; changes = []
    for (const file of artifact.files) { const path = LIBRARY + '/' + file.path, before = await readOptional(files, path); if (before || initial.registry.packages.some(item => item.files.some(owned => owned.path === file.path))) return fail('CONFLICT', 'package file is already present; unmanaged files are never overwritten', { stateChanged: false }); changes.push({ path, before, beforeMode: 0o640, content: file.content }) }
  } else {
    if (!installed) return fail('NOT_FOUND', 'managed private package is not installed', { stateChanged: false })
    if (initial.registry.packages.some(item => item.requires.some(dependency => dependency.name === installed.name))) return fail('CONFLICT', 'another installed package depends on this package', { stateChanged: false })
    packages = initial.registry.packages.filter(item => item.name !== installed.name); changes = []
    for (const file of installed.files) { const path = LIBRARY + '/' + file.path, before = await readOptional(files, path); if (!before || digest(before.content) !== file.sha256) return unsupported('package contents changed before removal'); changes.push({ path, before, beforeMode: await readMode(files, path), content: null }) }
  }
  changes.push({ path: REGISTRY, before: initial.document, beforeMode: initial.document ? await readMode(files, REGISTRY) : 0o640, content: JSON.stringify({ schema: 1, accountId: input.account.id, packages }) + '\n' })
  if (!text(changes.at(-1)!.content, LIMITS.registryBytes)) return unsupported('the managed package registry capacity would be exceeded')
  const journal: Journal = { schema: 1, accountId: input.account.id, phase: 'prepared', changes }
  let snapshot: FileText | null = null
  try {
    snapshot = await saveJournal(files, journal, initial.journalDocument, writeAuthority)
    for (const change of changes) { await ensureParents(files, change.path, writeAuthority); await writeAuthority(); await files.writeTextChecked(change.path, change.content, change.before, 0o640); if ((await readOptional(files, change.path))?.content !== (change.content ?? undefined)) throw new Error('package_readback_mismatch') }
    await saveJournal(files, { ...journal, phase: 'committed' }, snapshot, writeAuthority)
    return (await observe({ ...input, qualified: true })).view
  } catch {
    if (snapshot) try { await restoreJournal(files, journal, snapshot, writeAuthority); return fail('CONFIG_TEST_FAILED', 'the package action failed and its library preimage was restored', { stateChanged: true, rollbackVerified: true, verificationRequired: false }) } catch (error) { if (isXpanelError(error) && error.detail?.rollbackVerified === true) throw error }
    return unknown()
  }
}
export interface AccountPackageRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, action: (account: Account) => Promise<T>): Promise<T>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  files(account: Account, plan: Plan): AccountPackageFiles
  catalog: VerifiedPearCatalog | null
  admitMutation?: (account: Account) => Promise<void>
  audit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok' | 'failed'; principalId: string }): Promise<unknown>
}
export async function handleAccountPackagesRoute(req: Request, url: URL, method: string, deps: AccountPackageRouteDeps): Promise<Response | null> {
  const match = /^\/accounts\/([a-z][a-z0-9]{0,15})\/packages$/.exec(url.pathname); if (!match) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return invalid()
  if (deps.caller.role !== 'user' || !deps.caller.accountId) return fail('FORBIDDEN', 'package workspace requires the signed-in account owner', { stateChanged: false })
  let raw: unknown
  if (method === 'POST') { const body = await req.text(); if (body.length > 1024) return invalid(); try { raw = JSON.parse(body) } catch { return invalid() } }
  const request = parseAccountPackageRequest(method, raw), caller = deps.caller, account = await deps.store.getAccountByUsername(match[1]!)
  if (!account || account.id !== caller.accountId) return fail('FORBIDDEN', 'package account does not match the current owner', { stateChanged: false })
  return deps.store.withAccountLifecycleLease(account.id, async fresh => {
    const authorize = async (): Promise<Plan> => { const principal = await deps.currentPrincipal(), plan = await deps.store.getPlan(fresh.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
      if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || fresh.id !== caller.accountId || principal.accountId !== fresh.id || principal.username !== fresh.username || fresh.username !== match[1] || fresh.status !== 'active' || !plan || !features || [ACCOUNT_PACKAGE_FEATURE, 'modules-php-pear'].some(id => features.disabled.includes(id))) return fail('FORBIDDEN', 'current account owner cannot manage private PEAR packages', { stateChanged: false }); return plan
    }
    const plan = await authorize(), mutation = request.op !== 'read'
    try {
      const view = await runAccountPackageRequest({ account: fresh, files: deps.files(fresh, plan), catalog: deps.catalog, request, authorize: async () => { await authorize() }, ...(deps.admitMutation ? { admitMutation: () => deps.admitMutation!(fresh) } : {}) })
      if (mutation) try { await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.packages.' + request.op, target: 'account:' + fresh.username, detail: { ecosystem: 'pear', ...(request.op === 'install' || request.op === 'remove' ? { name: request.name } : {}) }, outcome: 'ok' }) } catch { return unknown() }
      return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    } catch (error) { if (mutation) await deps.audit({ actor: caller.actor, principalId: caller.principalId, action: 'account.packages.' + request.op, target: 'account:' + fresh.username, detail: { verificationRequired: isXpanelError(error) && error.detail?.verificationRequired === true }, outcome: 'failed' }).catch(() => {}); throw error }
  })
}
