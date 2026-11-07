import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { assertNoSecrets } from '@xpanel/lifecycle'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { NODE_IDENTITY_PATH, NODE_PEER_PREFIX } from './node-link.ts'
import type { ManagedNode, NodeLink } from './node-link.ts'
import { assertExpectedRevision, exactKeys, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { serverOperationFiles } from './server-operations-workspace.ts'
import { signInPolicyFile } from './sign-in-policy.ts'
import { tweakSettingsFile } from './tweak-settings-workspace.ts'

/**
 * WHM Configuration Cluster: this server is the master of the linked nodes chosen as members. A version is an immutable
 * snapshot of chosen configuration files; a push applies it to a member through that member's own file validators, and
 * the member keeps what each file held before, so a push can be rolled back there. Only the master knows its members;
 * a member that leaves keeps what it received.
 */
export const CLUSTER_ROUTE = '/api/server/cluster'
export const CLUSTER_APPLY_PATH = NODE_PEER_PREFIX + '/config/apply'
export const CLUSTER_ROLLBACK_PATH = NODE_PEER_PREFIX + '/config/rollback'
export const MAX_CLUSTER_VERSIONS = 20
const MAX_RECEIVED = 20
const PUSH_TIMEOUT_MS = 60_000
const MAX_SECTION_BODY = 2 * 1024 * 1024
const VERSION_ROUTE = /^\/api\/server\/cluster\/versions\/([1-9][0-9]{0,8})\/(push|rollback)$/
const HEX = /^[0-9a-f]{64}$/
const unchanged = { stateChanged: false }
const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason, ...extra })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digestOf = (sections: Record<string, unknown>): string => createHash('sha256').update(JSON.stringify(Object.keys(sections).sort().map(id => [id, sections[id]]))).digest('hex')
const sent = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const reasonOf = (error: unknown): string => isXpanelError(error) && typeof error.detail.reason === 'string' ? error.detail.reason : 'node_unreachable'

export interface ClusterSection {
  file: PanelConfigFile<unknown>
  /** Fields a member keeps from its own file: an identity on one server means nothing on another. */
  keep?: (incoming: Record<string, unknown>, local: Record<string, unknown>) => unknown
}
type Store = Pick<StateStore, 'rootDir' | 'getWriterLock'>
/** Portable files only: nothing here names an address, a certificate or a credential of one server. */
export const clusterSections = (store: Store): Record<string, ClusterSection> => ({
  'tweak-settings': { file: tweakSettingsFile(store) as PanelConfigFile<unknown> },
  'update-preferences': { file: serverOperationFiles(store).updates as PanelConfigFile<unknown>, keep: (incoming, local) => ({ ...incoming, owner: local.owner ?? null }) },
  'maintenance-schedule': { file: serverOperationFiles(store).maintenance as PanelConfigFile<unknown> },
  'sign-in-policy': { file: signInPolicyFile(store) as unknown as PanelConfigFile<unknown> },
})

export interface ClusterPush { state: 'pushing' | 'applied' | 'failed' | 'rolled_back'; at: string; reason: string | null }
export interface ClusterVersion { number: number; createdAt: string; actor: string; note: string; sections: Record<string, unknown>; digest: string; pushes: Record<string, ClusterPush> }
interface ClusterDocument { version: 1; members: string[]; next: number; versions: ClusterVersion[] }
interface ReceivedApply { master: string; version: number; digest: string; appliedAt: string; sections: Record<string, { before: unknown; after: string }> }
interface ReceivedDocument { version: 1; applied: ReceivedApply[] }

const statePath = (store: Store): string => join(store.rootDir, 'extended', 'server', 'cluster', 'state.json')
const receivedPath = (store: Store): string => join(store.rootDir, 'extended', 'server', 'cluster', 'received.json')
const readState = async (store: Store): Promise<ClusterDocument> => {
  const raw = await readJsonIfExists<ClusterDocument>(statePath(store))
  if (raw === null) return { version: 1, members: [], next: 1, versions: [] }
  return raw.version === 1 && Array.isArray(raw.members) && Array.isArray(raw.versions) && Number.isSafeInteger(raw.next) ? raw : fail('PRECONDITION_FAILED', 'the saved cluster state requires inspection', unchanged)
}
const readReceived = async (store: Store): Promise<ReceivedDocument> => {
  const raw = await readJsonIfExists<ReceivedDocument>(receivedPath(store))
  if (raw === null) return { version: 1, applied: [] }
  return raw.version === 1 && Array.isArray(raw.applied) ? raw : fail('PRECONDITION_FAILED', 'the received cluster state requires inspection', unchanged)
}
const writeUnder = async <T, D>(store: Store, read: () => Promise<D>, path: string, change: (document: D) => T | Promise<T>): Promise<T> => {
  const lease = await store.getWriterLock().acquire()
  try {
    const document = await read(), result = await change(document)
    await atomicWriteJson(path, document, 0o600, () => lease.assertFencingToken())
    await lease.commitAuthority()
    return result
  } finally { await lease.release() }
}
const changeState = <T>(store: Store, change: (document: ClusterDocument) => T | Promise<T>): Promise<T> => writeUnder(store, () => readState(store), statePath(store), change)
const changeReceived = <T>(store: Store, change: (document: ReceivedDocument) => T | Promise<T>): Promise<T> => writeUnder(store, () => readReceived(store), receivedPath(store), change)

/** Writes one file to `next`, or back to no file at all, so a server on its defaults returns to its defaults. */
const writeSection = async (store: Store, file: PanelConfigFile<unknown>, current: unknown, next: unknown, authority: () => Promise<void>): Promise<void> => {
  if (next !== null) { await file.write(next, panelConfigRevision(file.namespace, current), authority); return }
  const lease = await store.getWriterLock().acquire()
  try { await authority(); await lease.assertFencingToken(); await rm(file.path, { force: true }); await lease.commitAuthority() } finally { await lease.release() }
}

export interface ClusterHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Store
  link: NodeLink
  sections?: Record<string, ClusterSection>
}

/** Pushes run one member at a time and survive the request; a restart reads the unfinished ones back as interrupted. */
const pushing = new Set<string>()
const pushKey = (store: Store, number: number): string => store.rootDir + ':' + number

const markPush = (store: Store, number: number, member: string, push: ClusterPush): Promise<void> => changeState(store, document => {
  const version = document.versions.find(item => item.number === number)
  if (version) version.pushes[member] = push
})

const startPush = (helpers: ClusterHelpers, version: ClusterVersion, members: readonly ManagedNode[], actor: AuthenticatedCaller): void => {
  const { store, link } = helpers, key = pushKey(store, version.number)
  pushing.add(key)
  void (async () => {
    try {
      for (const member of members) {
        const at = (): string => link.now().toISOString()
        await markPush(store, version.number, member.id, { state: 'pushing', at: at(), reason: null })
        let outcome: 'ok' | 'failed' = 'ok', reason: string | null = null
        try { await link.call(member, CLUSTER_APPLY_PATH, { method: 'POST', timeoutMs: PUSH_TIMEOUT_MS, body: { version: version.number, digest: version.digest, sections: version.sections } }) }
        catch (error) { outcome = 'failed'; reason = reasonOf(error) }
        await markPush(store, version.number, member.id, { state: outcome === 'ok' ? 'applied' : 'failed', at: at(), reason })
        await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: outcome === 'ok' ? 'cluster.push.applied' : 'cluster.push.failed', target: 'node:' + member.hostname, detail: { version: version.number, reason }, outcome }).catch(() => undefined)
      }
    } catch { /* the member stays in the pushing state, which the next read reports as interrupted */ } finally { pushing.delete(key) }
  })()
}

/** A snapshot of the chosen files as they are saved here; null stands for a file on its defaults. */
const snapshot = async (helpers: ClusterHelpers, ids: readonly string[], note: string, actor: AuthenticatedCaller): Promise<ClusterVersion> => {
  const registry = helpers.sections ?? clusterSections(helpers.store), sections: Record<string, unknown> = {}
  for (const id of ids) {
    const { raw, value } = await (registry[id] ?? fail('VALIDATION', 'unknown configuration section', { ...unchanged, reason: 'section_unknown' })).file.read()
    if (raw !== null && value === null) refuse('section_invalid', 'a chosen file fails validation here; fix it before pushing', { section: id })
    sections[id] = raw
  }
  assertNoSecrets(sections, 'sections')
  const created = await changeState(helpers.store, document => {
    const version: ClusterVersion = { number: document.next, createdAt: helpers.link.now().toISOString(), actor: actor.principal.username, note, sections, digest: digestOf(sections), pushes: {} }
    document.next += 1
    document.versions.push(version)
    if (document.versions.length > MAX_CLUSTER_VERSIONS) document.versions.splice(0, document.versions.length - MAX_CLUSTER_VERSIONS)
    return version
  })
  await helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'cluster.version.created', target: 'cluster-version:' + created.number, detail: { sections: ids, digest: created.digest }, outcome: 'ok' })
  return created
}

/** 'Send to cluster' of another page: a new version of the named files, pushed to every member. Null when there are no members. */
export async function pushSectionsToCluster(helpers: ClusterHelpers, ids: readonly string[], note: string, actor: AuthenticatedCaller): Promise<{ version: number; members: number } | null> {
  const { members } = await readState(helpers.store), links = await helpers.link.nodes()
  const chosen = links.filter(node => members.includes(node.id))
  if (!chosen.length) return null
  const version = await snapshot(helpers, ids, note, actor)
  startPush(helpers, version, chosen, actor)
  return { version: version.number, members: chosen.length }
}

/** Root's cluster page: member choice, versions, push and rollback. */
export async function handleClusterRoute(request: Request, url: URL, method: string, helpers: ClusterHelpers): Promise<Response | null> {
  const { pathname } = url
  if (pathname === CLUSTER_APPLY_PATH || pathname === CLUSTER_ROLLBACK_PATH) return peerRoute(request, url, method, helpers)
  const match = VERSION_ROUTE.exec(pathname)
  if (pathname !== CLUSTER_ROUTE && pathname !== CLUSTER_ROUTE + '/members' && pathname !== CLUSTER_ROUTE + '/versions' && !match) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.cluster')
  if (url.search) return fail('VALIDATION', 'cluster routes accept no selectors', unchanged)
  const { store, link } = helpers
  const allow = pathname === CLUSTER_ROUTE ? 'GET' : pathname === CLUSTER_ROUTE + '/members' ? 'PUT' : 'POST'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  const audit = (action: string, target: string, detail: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok') => helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target, detail, outcome })
  const view = async () => {
    const document = await readState(store), links = await link.nodes(), registry = helpers.sections ?? clusterSections(store)
    return { revision: createHash('sha256').update(JSON.stringify([document.members, document.next])).digest('hex'), sections: Object.keys(registry), members: document.members.filter(id => links.some(node => node.id === id)),
      nodes: links.map(node => ({ id: node.id, label: node.label, hostname: node.hostname })),
      versions: document.versions.slice().reverse().map(({ sections, pushes, ...version }) => ({ ...version, sections: Object.keys(sections),
        pushes: Object.fromEntries(Object.entries(pushes).map(([id, push]) => [id, push.state === 'pushing' && !pushing.has(pushKey(store, version.number)) ? { ...push, state: 'interrupted' } : push])) })) }
  }
  if (method === 'GET') return panelJson(await view())
  const expected = async (body: Record<string, unknown>): Promise<void> => { if (assertExpectedRevision(body.expectedRevision) !== (await view()).revision) fail('CONFLICT', 'the cluster changed since it was read; reload before saving', unchanged) }
  const body = await readPanelConfigBody(request)
  if (pathname === CLUSTER_ROUTE + '/members') {
    if (!exactKeys(body, ['members', 'expectedRevision'])) return fail('VALIDATION', 'exactly members and expectedRevision are required', unchanged)
    if (!Array.isArray(body.members) || body.members.length > 64 || new Set(body.members).size !== body.members.length) return fail('VALIDATION', 'members must be a list of linked nodes', unchanged)
    await expected(body)
    const links = await link.nodes(), current = (await readState(store)).members
    for (const id of body.members as unknown[]) {
      const node = links.find(item => item.id === id) ?? fail('NOT_FOUND', 'the node is not linked', { ...unchanged, reason: 'node_not_linked' })
      if (current.includes(node.id)) continue
      try { await link.call(node, NODE_IDENTITY_PATH) } catch (error) {
        if (reasonOf(error) === 'auth_refused') return fail('FORBIDDEN', 'the node credential lacks the privileges a member needs', { ...unchanged, reason: 'insufficient_privileges' })
        throw error
      }
    }
    await changeState(store, document => { document.members = body.members as string[] })
    await audit('cluster.members.saved', 'server:cluster', { members: (body.members as string[]).length })
    return panelJson(await view())
  }
  if (pathname === CLUSTER_ROUTE + '/versions') {
    if (!exactKeys(body, ['sections', 'note'])) return fail('VALIDATION', 'exactly sections and note are required', unchanged)
    if (!Array.isArray(body.sections) || !body.sections.length || body.sections.some(id => typeof id !== 'string') || new Set(body.sections).size !== body.sections.length) return fail('VALIDATION', 'choose at least one configuration section', unchanged)
    if (typeof body.note !== 'string' || body.note.length > 200 || /[\u0000-\u001f\u007f]/.test(body.note)) return fail('VALIDATION', 'the note is one line of at most 200 characters', unchanged)
    await snapshot(helpers, body.sections as string[], body.note, caller)
    return sent(201, await view())
  }
  const number = Number(match![1])
  const version = (await readState(store)).versions.find(item => item.number === number) ?? fail('NOT_FOUND', 'cluster version not found', unchanged)
  if (match![2] === 'push') {
    if (!exactKeys(body, ['members'])) return fail('VALIDATION', 'exactly members is required', unchanged)
    if (pushing.has(pushKey(store, number))) return fail('CONFLICT', 'this version is being pushed', unchanged)
    const links = await link.nodes(), saved = (await readState(store)).members
    if (!Array.isArray(body.members) || !body.members.length || body.members.length > 64) return fail('VALIDATION', 'choose at least one member', unchanged)
    const chosen = (body.members as unknown[]).map(id => saved.includes(id as string) ? links.find(node => node.id === id) : undefined).map(node => node ?? fail('VALIDATION', 'only cluster members receive a push', { ...unchanged, reason: 'not_a_member' }))
    await audit('cluster.push.started', 'cluster-version:' + number, { members: chosen.length })
    startPush(helpers, version, chosen, caller)
    return sent(202, await view())
  }
  if (!exactKeys(body, ['member', 'overwrite'])) return fail('VALIDATION', 'exactly member and overwrite are required', unchanged)
  if (typeof body.member !== 'string' || typeof body.overwrite !== 'boolean') return fail('VALIDATION', 'a member and overwrite are required', unchanged)
  const node = await link.node(body.member)
  if (!Object.hasOwn(version.pushes, node.id)) return refuse('not_pushed', 'this version was not pushed to that member')
  await link.call(node, CLUSTER_ROLLBACK_PATH, { method: 'POST', timeoutMs: PUSH_TIMEOUT_MS, body: { version: number, overwrite: body.overwrite } })
  await markPush(store, number, node.id, { state: 'rolled_back', at: link.now().toISOString(), reason: null })
  await audit('cluster.push.rolled_back', 'node:' + node.hostname, { version: number, overwrite: body.overwrite })
  return panelJson(await view())
}

/** What a member does for its master, identified by the link token alone. */
async function peerRoute(request: Request, url: URL, method: string, helpers: ClusterHelpers): Promise<Response> {
  const { store, link } = helpers
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.cluster.peer')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'cluster routes accept no selectors', unchanged)
  const master = await link.peerOf(caller), body = await readPanelConfigBody(request, MAX_SECTION_BODY)
  const authority = async (): Promise<void> => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.cluster.peer') }
  const registry = helpers.sections ?? clusterSections(store)
  const audit = (action: string, detail: Record<string, unknown>) => helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action, target: 'node:' + master.hostname, detail, outcome: 'ok' })

  if (url.pathname === CLUSTER_APPLY_PATH) {
    if (!exactKeys(body, ['version', 'digest', 'sections'])) return fail('VALIDATION', 'exactly version, digest and sections are required', unchanged)
    if (!Number.isSafeInteger(body.version) || (body.version as number) < 1 || typeof body.digest !== 'string' || !HEX.test(body.digest) || !object(body.sections)) return fail('VALIDATION', 'a version, digest and sections are required', unchanged)
    const version = body.version as number, digest = body.digest, incoming = body.sections
    if (digestOf(incoming) !== digest) return refuse('digest_mismatch', 'the pushed configuration does not match its digest')
    assertNoSecrets(incoming, 'sections')
    const latest = (await readReceived(store)).applied.at(-1)
    if (latest?.master === master.id && latest.version === version && latest.digest === digest) return panelJson({ applied: true, repeated: true })
    // every file is validated before the first one changes
    const prepared: { id: string; file: PanelConfigFile<unknown>; before: unknown; next: unknown }[] = []
    for (const [id, value] of Object.entries(incoming)) {
      const section = registry[id] ?? refuse('section_unknown', 'this server does not know that configuration section', { section: id })
      const { raw, value: local } = await section.file.read()
      const next = value !== null && section.keep && object(value) && object(local) ? section.keep(value, local) : value
      if (next !== null && section.file.parse(next) === null) return refuse('section_invalid', 'a pushed file fails validation here; nothing was changed', { section: id })
      prepared.push({ id, file: section.file, before: raw, next })
    }
    // what each file held is saved first: a crash between files must still leave a way back
    await changeReceived(store, document => {
      document.applied.push({ master: master.id, version, digest, appliedAt: link.now().toISOString(), sections: Object.fromEntries(prepared.map(item => [item.id, { before: item.before, after: panelConfigRevision(item.file.namespace, item.next) }])) })
      if (document.applied.length > MAX_RECEIVED) document.applied.splice(0, document.applied.length - MAX_RECEIVED)
    })
    const written: typeof prepared = []
    try {
      for (const item of prepared) { await writeSection(store, item.file, item.before, item.next, authority); written.push(item) }
    } catch (error) {
      for (const item of written.reverse()) await writeSection(store, item.file, item.next, item.before, authority).catch(() => undefined)
      await changeReceived(store, document => { document.applied.pop() }).catch(() => undefined)
      throw error
    }
    await audit('cluster.config.applied', { version, digest, sections: prepared.map(item => item.id) })
    return panelJson({ applied: true, repeated: false })
  }

  if (!exactKeys(body, ['version', 'overwrite'])) return fail('VALIDATION', 'exactly version and overwrite are required', unchanged)
  if (!Number.isSafeInteger(body.version) || typeof body.overwrite !== 'boolean') return fail('VALIDATION', 'a version and overwrite are required', unchanged)
  const latest = (await readReceived(store)).applied.at(-1)
  if (!latest || latest.master !== master.id || latest.version !== body.version) return refuse('not_latest', 'only the newest push on this server can be rolled back')
  const restore: { file: PanelConfigFile<unknown>; current: unknown; before: unknown }[] = []
  for (const [id, entry] of Object.entries(latest.sections)) {
    const file = (registry[id] ?? refuse('section_unknown', 'this server no longer knows that configuration section', { section: id })).file
    const { raw } = await file.read()
    if (panelConfigRevision(file.namespace, raw) !== entry.after && body.overwrite !== true) return fail('CONFLICT', 'this server changed the file after the push', { ...unchanged, reason: 'local_changes', section: id })
    restore.push({ file, current: raw, before: entry.before })
  }
  for (const item of restore) await writeSection(store, item.file, item.current, item.before, authority)
  await changeReceived(store, document => { document.applied.pop() })
  await audit('cluster.config.rolled_back', { version: latest.version, overwrite: body.overwrite })
  return panelJson({ rolledBack: true })
}
