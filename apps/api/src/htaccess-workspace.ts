import { fail, isUuid } from '@xpanel/core'
import { parseHtaccessRequest } from '../../agent/src/htaccess-contract.ts'
import type { HtaccessRequest, HtaccessView } from '../../agent/src/htaccess-workspace.ts'

export const HTACCESS_DOMAIN_ROUTE = /^\/api\/domains\/([0-9a-f-]{36})\/htaccess(?:\/(restore|migrate-php))?$/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Public verbs select the operation; body path/account/Host/probe hints are rejected. */
export function parseHtaccessHttpRequest(method: string, suffix: string | undefined, body?: unknown): HtaccessRequest {
  if (method === 'GET' && suffix === undefined) return parseHtaccessRequest({ op: 'read' })
  if (!object(body)) return fail('VALIDATION', '.htaccess body must be an object', { stateChanged: false })
  if (Object.hasOwn(body, 'op')) return fail('VALIDATION', '.htaccess operation comes from the route', { stateChanged: false })
  const op = method === 'PUT' && suffix === undefined ? 'save' : method === 'POST' && suffix === undefined ? 'validate' : method === 'POST' && ['restore', 'migrate-php'].includes(suffix ?? '') ? suffix : null
  if (!op) return fail('VALIDATION', 'unsupported .htaccess method', { stateChanged: false })
  return parseHtaccessRequest({ ...body, op })
}

/** Agent response pinning is independent from the browser's readback checks. */
export function validateHtaccessWorkspaceReply(target: { domainId: string; accountId: string }, raw: unknown): HtaccessView {
  if (!isUuid(target.domainId) || !isUuid(target.accountId) || !object(raw) || !object(raw.context) || raw.context.domainId !== target.domainId || raw.context.accountId !== target.accountId || typeof raw.context.domainName !== 'string' || typeof raw.context.path !== 'string' || raw.context.path.startsWith('/') || /[\\\u0000-\u001f]/.test(raw.context.path) || raw.context.path.split('/').some(part => !part || part === '.' || part === '..') || raw.context.path.split('/').at(-1) !== '.htaccess') return fail('CONFIG_TEST_FAILED', 'protected .htaccess reply target is invalid')
  if (!object(raw.document) || typeof raw.document.exists !== 'boolean' || typeof raw.document.content !== 'string' || !raw.document.content.isWellFormed() || !Number.isSafeInteger(raw.document.sizeBytes) || raw.document.sizeBytes !== Buffer.byteLength(raw.document.content, 'utf8') || (raw.document.sizeBytes as number) > 64 * 1024 || !revision(raw.document.revision) || raw.document.exists === false && (raw.document.content !== '' || raw.document.sizeBytes !== 0 || raw.document.mtime !== null)) return fail('CONFIG_TEST_FAILED', 'protected .htaccess document is invalid')
  if (!Array.isArray(raw.versions) || raw.versions.length > 30 || raw.versions.some(version => !object(version) || !isUuid(version.id) || !revision(version.revision) || typeof version.at !== 'string' || !Number.isFinite(Date.parse(version.at)) || typeof version.actor !== 'string' || typeof version.current !== 'boolean' || typeof version.canRestore !== 'boolean' || !Number.isSafeInteger(version.sizeBytes))) return fail('CONFIG_TEST_FAILED', 'protected .htaccess history is invalid')
  const capabilities = raw.capabilities
  if (!object(capabilities) || ['canSave', 'canValidate', 'canRestore', 'canMigrate'].some(key => typeof capabilities[key] !== 'boolean') || !object(raw.application) || !['read', 'validated', 'saved', 'restored', 'rolled_back'].includes(String(raw.application.status)) || raw.application.nativeQualified !== false || typeof raw.application.syntaxChecked !== 'boolean' || typeof raw.reviewRequired !== 'boolean' || !object(raw.policy) || typeof raw.policy.valid !== 'boolean' || !Array.isArray(raw.policy.issues) || !Array.isArray(raw.policy.phpLines)) return fail('CONFIG_TEST_FAILED', 'protected .htaccess status is invalid')
  return raw as unknown as HtaccessView
}

export async function executeHtaccessWorkspaceRequest(target: { domainId: string; accountId: string }, request: HtaccessRequest, invoke: () => Promise<Response>): Promise<Response> {
  const mutation = ['save', 'restore', 'migrate-php'].includes(request.op)
  try {
    const response = await invoke()
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 2 * 1024 * 1024)) throw new Error('htaccess_reply_limit')
    if (!response.body) throw new Error('missing_htaccess_reply')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    let raw: unknown
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('htaccess_reply_limit') } chunks.push(chunk.value) }
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally { reader.releaseLock() }
    if (response.status !== 200) {
      const problem = object(raw) && object(raw.error) ? raw.error : object(raw) ? raw : {}
      const details = object(problem.details) ? problem.details : {}
      const unchanged = details.stateChanged === false && !['stateChanged', 'unknownOutcome', 'verificationRequired'].some(key => details[key] === true)
      if (mutation && !unchanged) return fail('SERVICE_UNAVAILABLE', '.htaccess outcome requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      const status = [400, 401, 403, 404, 409, 412, 413, 422].includes(response.status) ? response.status : 503
      return Response.json({ error: 'The protected .htaccess request was refused.', details: { stateChanged: false } }, { status })
    }
    return Response.json(validateHtaccessWorkspaceReply(target, raw))
  } catch {
    return fail('SERVICE_UNAVAILABLE', mutation ? '.htaccess outcome requires inspection' : 'the protected .htaccess read could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) })
  }
}
