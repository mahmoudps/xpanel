import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { ACCOUNT_PEAR_LIBRARY, ACCOUNT_PEAR_LIMITS, isPearFile, isPearName, isPearVersion, pearSource } from '../../../packages/os/src/account-package-command.ts'
import { ACCOUNT_PACKAGE_FEATURE, parseAccountPackageRequest } from '../../agent/src/account-packages.ts'
import type { AccountPackagesView, AccountPackageRequest, PearPackage } from '../../agent/src/account-packages.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'

export const ACCOUNT_PACKAGES_PATH = '/api/account/packages'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
/** Field-by-field projection excludes package source contents and recovery preimages from every HTTP response. */
export function projectAccountPackagesView(raw: unknown, account: Pick<Account, 'id' | 'username'>, request: AccountPackageRequest): AccountPackagesView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'the private package reply could not be verified')
  if (!object(raw) || [raw, object(raw.detail) ? raw.detail : {}, object(raw.details) ? raw.details : {}].some(part => part.unknownOutcome === true || part.verificationRequired === true) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || raw.ecosystem !== 'pear' || raw.scope !== 'managed-private-library' || raw.library !== ACCOUNT_PEAR_LIBRARY || !sha(raw.revision) || !(raw.catalogRevision === null || sha(raw.catalogRevision)) || !['verified', 'recovery-required'].includes(raw.inventory as string) || !['none', 'prepared', 'needs-review', 'committed', 'rolled-back'].includes(raw.recovery as string) || !Array.isArray(raw.packages) || raw.packages.length > ACCOUNT_PEAR_LIMITS.packages || !Array.isArray(raw.available) || raw.available.length > ACCOUNT_PEAR_LIMITS.packages || !object(raw.capabilities) || ['install', 'remove', 'recover'].some(key => typeof (raw.capabilities as Record<string, unknown>)[key] !== 'boolean') || !object(raw.application) || raw.application.op !== request.op || raw.application.state !== (request.op === 'read' ? 'read' : 'verified') || raw.application.verificationRequired !== false) return bad()
  const requirements = (value: unknown): { name: string; version: string }[] => {
    if (!Array.isArray(value) || value.length > ACCOUNT_PEAR_LIMITS.packages) return bad()
    const result = value.map(item => { if (!object(item) || !isPearName(item.name) || !isPearVersion(item.version)) return bad(); return { name: item.name, version: item.version } })
    if (new Set(result.map(item => item.name)).size !== result.length) return bad(); return result
  }
  const packages: PearPackage[] = raw.packages.map(item => {
    if (!object(item) || !isPearName(item.name) || !isPearVersion(item.version) || item.source !== pearSource(item.name, item.version) || !sha(item.archiveSha256) || !Array.isArray(item.files) || !item.files.length || item.files.length > ACCOUNT_PEAR_LIMITS.files) return bad()
    const files = item.files.map(file => { if (!object(file) || !isPearFile(file.path) || !sha(file.sha256)) return bad(); return { path: file.path, sha256: file.sha256 } })
    return { name: item.name, version: item.version, source: item.source as string, archiveSha256: item.archiveSha256, files, requires: requirements(item.requires) }
  })
  const available = raw.available.map(item => { if (!object(item) || !isPearName(item.name) || !isPearVersion(item.version) || item.source !== pearSource(item.name, item.version) || typeof item.summary !== 'string' || item.summary.length > 300 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(item.summary)) return bad(); return { name: item.name, version: item.version, source: item.source as string, summary: item.summary, requires: requirements(item.requires) } })
  const files = packages.flatMap(item => item.files.map(file => file.path)), pending = ['prepared', 'needs-review'].includes(raw.recovery as string)
  if (new Set(packages.map(item => item.name)).size !== packages.length || new Set(available.map(item => item.name)).size !== available.length || new Set(files).size !== files.length || packages.some(item => item.requires.some(dependency => !packages.some(target => target.name === dependency.name && target.version === dependency.version))) || pending !== (raw.inventory === 'recovery-required') || pending && packages.length !== 0 || raw.catalogRevision === null && (available.length !== 0 || raw.capabilities.install) || pending && (raw.capabilities.install || raw.capabilities.remove) || raw.capabilities.recover && !pending) return bad()
  if (request.op !== 'read' && (raw.revision === request.expectedRevision || pending) || request.op === 'install' && !packages.some(item => item.name === request.name && available.some(artifact => artifact.name === item.name && artifact.version === item.version)) || request.op === 'remove' && packages.some(item => item.name === request.name)) return bad()
  return { context: { accountId: account.id, username: account.username }, ecosystem: 'pear', scope: 'managed-private-library', library: ACCOUNT_PEAR_LIBRARY, revision: raw.revision, catalogRevision: raw.catalogRevision, inventory: raw.inventory as AccountPackagesView['inventory'], recovery: raw.recovery as AccountPackagesView['recovery'], packages, available, capabilities: { install: raw.capabilities.install as boolean, remove: raw.capabilities.remove as boolean, recover: raw.capabilities.recover as boolean }, application: { op: request.op, state: request.op === 'read' ? 'read' : 'verified', verificationRequired: false } }
}
export async function handleAccountPackagesWorkspaceRoute(req: Request, url: URL, method: string, ports: AccountSshPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_PACKAGES_PATH) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'private packages do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'Private packages')
  let raw: unknown
  if (method === 'POST') { const body = await req.text(); if (body.length > 1024) return fail('VALIDATION', 'package request is too large', { stateChanged: false }); try { raw = JSON.parse(body) } catch { return fail('VALIDATION', 'package request must be JSON', { stateChanged: false }) } }
  const request = parseAccountPackageRequest(method, raw), fresh = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'Private packages')
  if (fresh.account.id !== first.account.id || fresh.account.username !== first.account.username || fresh.caller.principal.id !== first.caller.principal.id) return fail('CONFLICT', 'package account binding changed', { stateChanged: false })
  const mutation = request.op !== 'read', reply = await ports.readAgent(fresh.caller, '/accounts/' + fresh.account.username + '/packages', mutation ? request : undefined, mutation, method)
  try {
    const after = await authorizeAccountOwner(ports, req, [ACCOUNT_PACKAGE_FEATURE], 'Private packages')
    if (after.account.id !== fresh.account.id || after.account.username !== fresh.account.username || after.caller.principal.id !== fresh.caller.principal.id) throw new Error('package_owner_changed')
    return workspaceJson(projectAccountPackagesView(reply, fresh.account, request))
  } catch { return fail('SERVICE_UNAVAILABLE', mutation ? 'package action needs review before retrying' : 'package reply could not be verified', { stateChanged: mutation, unknownOutcome: mutation, verificationRequired: mutation }) }
}
