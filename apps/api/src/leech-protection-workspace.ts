import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { readEdgeBody } from './account-edge-workspace.ts'
import { authorizeAccountOwner, workspaceJson, type ReadAgent } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { LEECH_MAX_FOLDERS, leechRevision, leechStatePath, parseLeechFolder, readLeechRecord } from '../../agent/src/leech-protection.ts'
import type { LeechAgentView, LeechFolder, LeechRecord } from '../../agent/src/leech-protection.ts'

export const LEECH_PROTECTION_PATH = '/api/account/leech-protection'
export interface LeechProtectionPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit'> {
  store: StateStore
  /** Protected agent transport; null without a connected host agent. */
  readAgent: ReadAgent | null
  now?: () => Date
}
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const field = (message: string, name: string, code: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field: name, code }] })
const STATES = new Set(['applied', 'not_protected', 'conflict', 'outside_document_root', 'pending'])
const USERNAME = /^[A-Za-z0-9._-]{1,64}$/

const readRaw = async (store: Pick<StateStore, 'rootDir'>, account: Account): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, leechStatePath(account.id))) } catch { return fail('PRECONDITION_FAILED', 'saved leech protection settings are unreadable; review them before changing them', unchanged) }
}

/** Agent reply pinning; anything unexpected is an unverified host answer, never shown as state. */
export function validateLeechAgentView(raw: unknown, account: Pick<Account, 'id' | 'username'>): LeechAgentView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected leech protection reply is invalid')
  const names = (value: unknown): boolean => Array.isArray(value) && value.length <= 1000 && value.every(name => typeof name === 'string' && USERNAME.test(name))
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || !object(raw.capabilities) || typeof raw.capabilities.canSave !== 'boolean'
    || ![null, 'engine', 'monitor'].includes(raw.capabilities.reason as string | null) || !Array.isArray(raw.folders) || raw.folders.length > LEECH_MAX_FOLDERS) return bad()
  for (const item of raw.folders) {
    if (!object(item) || !STATES.has(item.state as string) || !names(item.flagged) || !names(item.disabled)) return bad()
    const { state: _state, flagged: _flagged, disabled: _disabled, ...settings } = item
    try { parseLeechFolder(settings) } catch { return bad() }
  }
  return raw as unknown as LeechAgentView
}

export function leechView(account: Pick<Account, 'id' | 'username'>, raw: unknown, agent: LeechAgentView | null) {
  const record = raw === null ? null : readLeechRecord(raw)
  return { context: { accountId: account.id, username: account.username }, state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const, revision: leechRevision(raw), limit: LEECH_MAX_FOLDERS,
    updatedAt: record?.updatedAt ?? null, capabilities: agent?.capabilities ?? { canSave: false, reason: null }, folders: agent?.folders ?? [] }
}

/** Leech Protection of the signed-in account owner. POST saves one folder or removes it; the agent then renders the folder file. */
export async function handleLeechProtectionRoute(request: Request, url: URL, method: string, ports: LeechProtectionPorts): Promise<Response | null> {
  if (url.pathname !== LEECH_PROTECTION_PATH) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'leech protection accepts no query selectors', unchanged)
  const authorize = () => authorizeAccountOwner(ports, request, ['directory-privacy', 'leech-protection'], 'Leech Protection')
  const first = await authorize(), readAgent = ports.readAgent
  if (!readAgent) return fail('PRECONDITION_FAILED', 'leech protection needs the protected host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const agentPath = '/accounts/' + first.account.username + '/leech-protection'
  if (method === 'GET') {
    const raw = await readRaw(ports.store, first.account)
    if (raw !== null && !readLeechRecord(raw)) return workspaceJson(leechView(first.account, raw, null))
    try { return workspaceJson(leechView(first.account, raw, validateLeechAgentView(await readAgent(first.caller, agentPath, { op: 'status' }), first.account))) }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the leech protection status could not be verified', unchanged) }
  }
  const body = await readEdgeBody(request, 8192)
  const keys = Object.keys(body).sort().join()
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return field('the exact read revision is required', 'expectedRevision', 'revision')
  if (keys !== 'expectedRevision,folder' && keys !== 'expectedRevision,remove') return fail('VALIDATION', 'a change takes expectedRevision and exactly one of folder or remove', unchanged)
  const folder: LeechFolder | null = keys === 'expectedRevision,folder' ? parseLeechFolder(body.folder) : null
  const removed = folder ? null : body.remove
  if (!folder && typeof removed !== 'string') return field('the folder is not saved', 'remove', 'not_found')
  const path = folder?.path ?? removed as string
  const now = (ports.now ?? (() => new Date()))()
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const again = await authorize()
    return again.caller.principal.id === first.caller.principal.id && again.account.id === first.account.id ? again.caller : fail('CONFLICT', 'the account binding changed before saving', unchanged)
  }
  const build = (raw: unknown): LeechRecord => {
    const current = raw === null ? [] : readLeechRecord(raw)?.folders ?? fail('PRECONDITION_FAILED', 'saved leech protection settings require review before changing them', unchanged)
    if (!folder && !current.some(item => item.path === path)) return field('the folder is not saved', 'remove', 'not_found')
    const folders = [...current.filter(item => item.path !== path), ...(folder ? [folder] : [])].sort((left, right) => left.path < right.path ? -1 : 1)
    if (folders.length > LEECH_MAX_FOLDERS) return field(`at most ${LEECH_MAX_FOLDERS} folders are saved`, 'folder', 'too_many')
    return { version: 1, folders, updatedAt: now.toISOString() }
  }
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false, saved: unknown
  try {
    await fresh()
    const raw = await readRaw(ports.store, first.account)
    if (leechRevision(raw) !== body.expectedRevision) return fail('CONFLICT', 'saved leech protection settings changed; read them before saving', unchanged)
    const record = build(raw)
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(ports.store.rootDir, leechStatePath(first.account.id)), record, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    saved = await readRaw(ports.store, first.account)
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('readback_mismatch')
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved leech protection settings could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await ports.emitAudit({ actor: first.caller.principal.username, action: folder ? 'account.leech_protection.saved' : 'account.leech_protection.removed', target: 'account:' + first.account.username, principalId: first.caller.principal.id, outcome: 'ok', detail: { path, ...(folder ? { maxLogins: folder.maxLogins, disableUsers: folder.disableUsers, alert: folder.alertEmail !== null } : {}) } }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  let applied: LeechAgentView
  try { applied = validateLeechAgentView(await readAgent(await fresh(), agentPath, { op: 'apply', path }, true), first.account) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the settings were saved but the folder could not be updated; read them before retrying', { stateChanged: true, verificationRequired: true }) }
  return workspaceJson(leechView(first.account, saved, applied))
}
