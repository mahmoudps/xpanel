import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { FeatureList, Plan, Reseller, ServerSettings } from '@xpanel/core'
import { parseYaml, stringifyYaml } from '@xpanel/lifecycle'
import { resellerPolicy, type StateSnapshot, type StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { panelJson, readPanelConfigBody } from './panel-config-file.ts'

/**
 * Configuration as code: the desired state as reviewable YAML files, without secrets. An import overlays the files it
 * names: a missing file changes nothing and nothing is deleted. The preview runs each change against the same store
 * validators the API uses (on a parsed copy) and the apply writes through those mutators, then the normal reconcile.
 */
const EXPORT_ROUTE = '/api/server/config-as-code/export', PREVIEW_ROUTE = '/api/server/config-as-code/preview', APPLY_ROUTE = '/api/server/config-as-code/apply'
const unchanged = { stateChanged: false }
const MAX_BODY = 2 * 1024 * 1024, MAX_FILES = 2000, MAX_FILE_BYTES = 256 * 1024
const FILE = /^(?:server\.yaml|(?:feature-lists|plans|resellers|accounts)\/[A-Za-z0-9._@-]{1,128}\.yaml)$/
const SECRET_KEY = /pass|secret|token|hash|key$|private/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fileName = (value: string): string => value.replace(/[^A-Za-z0-9._@-]/g, '-').slice(0, 128)
const withoutSecrets = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutSecrets) : object(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, withoutSecrets(item)])) : value
const sortedKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortedKeys) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value
const yaml = (value: unknown): string => stringifyYaml(sortedKeys(withoutSecrets(value)), { lineWidth: 0 })

/** The exportable tree: one file per object, keyed so the same state always gives the same bytes. */
export function exportTree(snapshot: Pick<StateSnapshot, 'server' | 'featureLists' | 'plans' | 'resellers' | 'accounts'>): Record<string, string> {
  const files: Record<string, string> = {}
  if (snapshot.server) files['server.yaml'] = yaml(snapshot.server.settings)
  // Names are unique per owner, so a reseller's object carries its owner in the file name.
  const owned = (item: { name: string; ownerId: string | null }): string => fileName(item.ownerId ? item.name + '@' + item.ownerId.slice(0, 8) : item.name)
  for (const item of snapshot.featureLists) files[`feature-lists/${owned(item)}.yaml`] = yaml(item)
  for (const item of snapshot.plans) files[`plans/${owned(item)}.yaml`] = yaml(item)
  for (const item of snapshot.resellers.map(resellerPolicy)) files[`resellers/${fileName(item.username)}.yaml`] = yaml(item)
  for (const item of snapshot.accounts) files[`accounts/${fileName(item.username)}.yaml`] = yaml({ id: item.id, username: item.username, primaryDomain: item.primaryDomain, planId: item.planId, ownerId: item.ownerId, status: item.status })
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1))
}
export const treeRevision = (files: Record<string, string>): string => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1))).digest('hex')

export type ConfigChange = { path: string; kind: 'added' | 'changed'; fields: { field: string; from: unknown; to: unknown }[]; apply: 'server' | 'feature-list' | 'plan' | 'reseller' | 'account-plan' | 'not-importable'; reason: string | null }
const flat = (value: unknown, prefix = ''): Record<string, unknown> => !object(value) ? { [prefix]: value } : Object.fromEntries(Object.entries(value).flatMap(([key, item]) => Object.entries(flat(item, prefix ? prefix + '.' + key : key))))
const differences = (before: unknown, after: unknown): ConfigChange['fields'] => {
  const a = flat(before), b = flat(after)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap(field => JSON.stringify(a[field]) === JSON.stringify(b[field]) ? [] : [{ field, from: a[field] ?? null, to: b[field] ?? null }])
}
function parseFiles(raw: unknown): Record<string, unknown> {
  if (!object(raw) || Object.keys(raw).length > MAX_FILES) return fail('VALIDATION', 'a bounded set of files is required', unchanged)
  const out: Record<string, unknown> = {}
  for (const [path, text] of Object.entries(raw)) {
    if (!FILE.test(path) || typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) return fail('VALIDATION', 'unknown configuration file ' + path.slice(0, 160), { ...unchanged, reason: 'unknown_config_file' })
    try { out[path] = parseYaml(text, { maxAliasCount: 0 }) } catch { return fail('VALIDATION', 'invalid YAML in ' + path, { ...unchanged, reason: 'invalid_yaml', path }) }
    if (!object(out[path])) return fail('VALIDATION', path + ' must hold one mapping', { ...unchanged, reason: 'invalid_yaml', path })
  }
  return out
}
type Stateful = Pick<StateSnapshot, 'server' | 'featureLists' | 'plans' | 'resellers' | 'accounts'>
/** What each file would change, compared with the exported form of the same object. */
export function diffTree(files: Record<string, unknown>, state: Stateful): ConfigChange[] {
  const current = exportTree(state), changes: ConfigChange[] = [], known = new Map<string, unknown>()
  for (const [path, text] of Object.entries(current)) { const value = parseYaml(text) as { id?: unknown }; known.set(path === 'server.yaml' ? path : path.split('/')[0] + ':' + String(value.id), value) }
  for (const [path, next] of Object.entries(files)) {
    const area = path.split('/')[0]!, id = object(next) ? next.id : undefined
    const before = known.get(area === 'server.yaml' ? area : area + ':' + String(id)) ?? null
    const fields = differences(before, next)
    if (!fields.length) continue
    const apply: ConfigChange['apply'] = area === 'server.yaml' ? 'server' : area === 'feature-lists' ? 'feature-list' : area === 'plans' ? 'plan' : area === 'resellers' ? 'reseller' : 'account-plan'
    const only = (names: readonly string[]): boolean => fields.every(row => names.includes(row.field))
    // Accounts and resellers hold passwords the export leaves out, so a new one cannot come from a file.
    const refused = area === 'accounts' && (!before || !only(['planId'])) ? 'account_change_not_importable' : area === 'resellers' && !before ? 'reseller_create_not_importable' : area === 'resellers' && fields.some(row => row.field === 'username' || row.field === 'id') ? 'reseller_identity_fixed' : null
    changes.push({ path, kind: before ? 'changed' : 'added', fields, apply: refused ? 'not-importable' : apply, reason: refused })
  }
  return changes
}

export interface ConfigAsCodeHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  /** The normal reconcile; a failed one has already rolled the host back. */
  reconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
}

async function applyOne(store: StateStore, change: ConfigChange, value: Record<string, unknown>): Promise<void> {
  if (change.apply === 'plan') {
    const { id, name, featureListId, resources, caps, dedicatedIp, shell, defaultMailboxQuotaMb, enforceBandwidth, ownerId } = value as unknown as Plan
    const patch = { name, featureListId, resources, caps, dedicatedIp, shell, defaultMailboxQuotaMb, ...(enforceBandwidth === undefined ? {} : { enforceBandwidth }) }
    if (change.kind === 'changed') await store.updatePlan(id, patch)
    else await store.createPlan({ ...patch, ownerId: ownerId ?? null })
  } else if (change.apply === 'feature-list') {
    const { id, name, disabled, ownerId } = value as unknown as FeatureList
    if (change.kind === 'changed') await store.updateFeatureList(id, { name, disabled })
    else await store.createFeatureList({ name, disabled, ownerId: ownerId ?? null })
  } else if (change.apply === 'reseller') {
    const { id, username: _username, ...patch } = value as unknown as Reseller
    await store.updateReseller(id, patch)
  } else if (change.apply === 'account-plan') {
    await store.changePlan(String(value.id), String(value.planId))
  } else if (change.apply === 'server') {
    await store.saveServerSettings({ ...(await store.getServerSettings()), ...value } as unknown as ServerSettings)
  }
}

export async function handleConfigAsCodeRoute(request: Request, url: URL, method: string, helpers: ConfigAsCodeHelpers): Promise<Response | null> {
  const route = url.pathname
  if (![EXPORT_ROUTE, PREVIEW_ROUTE, APPLY_ROUTE].includes(route)) return null
  const action = route === APPLY_ROUTE ? 'server.config_as_code.apply' : route === PREVIEW_ROUTE ? 'server.config_as_code.preview' : 'server.config_as_code.export'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'configuration routes accept no selectors', unchanged)
  if (route === EXPORT_ROUTE) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const files = exportTree(await helpers.store.readSnapshot())
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.config_as_code.exported', target: 'server:config-as-code', detail: { files: Object.keys(files).length }, outcome: 'ok' })
    return panelJson({ files, revision: treeRevision(files) })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const body = await readPanelConfigBody(request, MAX_BODY)
  const files = parseFiles(body.files), snapshot = await helpers.store.readSnapshot(), revision = treeRevision(exportTree(snapshot))
  const changes = diffTree(files, snapshot), refused = changes.filter(change => change.apply === 'not-importable')
  if (route === PREVIEW_ROUTE) return panelJson({ changes, revision, applicable: refused.length === 0, dryRun: { reconcile: changes.length ? 'required' : 'none', configTests: 'run at apply' } })
  if (body.expectedRevision !== revision) return fail('CONFLICT', 'the configuration changed since the preview; preview again', unchanged)
  if (refused.length) return fail('PRECONDITION_FAILED', 'a change in this import cannot come from a file', { ...unchanged, reason: refused[0]!.reason, path: refused[0]!.path })
  if (!changes.length) return panelJson({ applied: 0, revision })
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, action)
  let done = 0
  try {
    for (const change of changes) { await applyOne(helpers.store, change, files[change.path] as Record<string, unknown>); done++ }
  } catch (error) {
    await restoreChanged(helpers.store, snapshot, changes.slice(0, done), files)
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'the import could not be written and was undone', { stateChanged: false })
  }
  const reconciled = await helpers.reconcile(fresh).catch(() => ({ ok: false, status: 0, body: {} }))
  if (reconciled && !reconciled.ok) {
    await restoreChanged(helpers.store, snapshot, changes, files)
    await helpers.reconcile(fresh).catch(() => null)
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.config_as_code.applied', target: 'server:config-as-code', detail: { changes: changes.length, undone: true }, outcome: 'failed' })
    return fail('CONFIG_TEST_FAILED', 'the import did not pass the server configuration tests and was undone', unchanged)
  }
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.config_as_code.applied', target: 'server:config-as-code', detail: { changes: changes.length, paths: changes.map(change => change.path).slice(0, 50) }, outcome: 'ok' })
  return panelJson({ applied: changes.length, revision: treeRevision(exportTree(await helpers.store.readSnapshot())) })
}

/** Puts back each object an import touched, from the snapshot it started from; an added object is removed. */
async function restoreChanged(store: StateStore, snapshot: StateSnapshot, changes: readonly ConfigChange[], files: Record<string, unknown>): Promise<void> {
  for (const change of changes) {
    const value = files[change.path] as { id?: string; name?: string }
    if (change.apply === 'plan') {
      const before = snapshot.plans.find(item => item.id === value.id)
      if (before) await store.updatePlan(before.id, { name: before.name, featureListId: before.featureListId, resources: before.resources, caps: before.caps, dedicatedIp: before.dedicatedIp, shell: before.shell, defaultMailboxQuotaMb: before.defaultMailboxQuotaMb })
      else { const made = (await store.listPlans()).find(item => item.name === value.name); if (made) await store.deletePlan(made.id) }
    } else if (change.apply === 'feature-list') {
      const before = snapshot.featureLists.find(item => item.id === value.id)
      if (before) await store.updateFeatureList(before.id, { name: before.name, disabled: before.disabled })
      else { const made = (await store.listFeatureLists()).find(item => item.name === value.name); if (made) await store.deleteFeatureList(made.id) }
    } else if (change.apply === 'reseller') {
      const before = snapshot.resellers.find(item => item.id === value.id)
      if (before) { const { id, username: _username, ...patch } = resellerPolicy(before); await store.updateReseller(id, patch) }
    } else if (change.apply === 'account-plan') {
      const before = snapshot.accounts.find(item => item.id === value.id)
      if (before) await store.changePlan(before.id, before.planId)
    } else if (change.apply === 'server' && snapshot.server) await store.saveServerSettings(snapshot.server.settings)
  }
}
