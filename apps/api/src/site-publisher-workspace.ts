import { fail, isUuid } from '@xpanel/core'
import { parseSitePublisherDraft, sitePublisherHash } from '../../agent/src/site-publisher.ts'
import type { SitePublisherView } from '../../agent/src/site-publisher.ts'
import { parseSitePublisherMutation } from '../../agent/src/site-publisher-routes.ts'

export const SITE_PUBLISHER_DOMAIN_ROUTE = /^\/api\/domains\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/site-publisher(?:\/(preview|publish|rollback))?$/
type Operation = 'read' | 'preview' | 'publish' | 'rollback'
export interface SitePublisherHttpRequest { operation: Operation; body?: Record<string, unknown> }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected site publisher reply requires inspection')

export function parseSitePublisherHttpRequest(method: string, suffix: string | undefined, body?: unknown): SitePublisherHttpRequest {
  if (method === 'GET' && suffix === undefined && body === undefined) return { operation: 'read' }
  if (method !== 'POST' || !['preview', 'publish', 'rollback'].includes(suffix ?? '') || !object(body)) return fail('VALIDATION', 'unsupported site publisher request', { stateChanged: false })
  if (Buffer.byteLength(JSON.stringify(body)) > 16_384) return fail('VALIDATION', 'site publisher request is too large', { stateChanged: false })
  return suffix === 'preview' ? { operation: 'preview', body: { ...parseSitePublisherDraft(body) } } : { operation: suffix as 'publish' | 'rollback', body: parseSitePublisherMutation(body, suffix!) }
}

/** Validate the complete projected response independently of the browser's readback. */
export function validateSitePublisherWorkspaceReply(target: { accountId: string; domainId: string }, raw: unknown, operation: Operation = 'read'): SitePublisherView | { html: string; hash: string } {
  if (operation === 'preview') {
    if (!exact(raw, ['html', 'hash']) || typeof raw.html !== 'string' || Buffer.byteLength(raw.html) > 32_768 || !/^<!doctype html>/i.test(raw.html) || !hash(raw.hash) || sitePublisherHash(raw.html) !== raw.hash || /<(?:script|iframe|object|embed|base|link|form)\b|\bon[a-z]+\s*=|\b(?:src|srcset|action)\s*=|javascript\s*:|@import|url\s*\(/i.test(raw.html)) return bad()
    return { html: raw.html, hash: raw.hash }
  }
  if (!isUuid(target.accountId) || !isUuid(target.domainId) || !exact(raw, ['context', 'revision', 'files', 'recovery', 'capabilities', 'application'])) return bad()
  const context = raw.context, recovery = raw.recovery, capabilities = raw.capabilities, application = raw.application
  if (!exact(context, ['accountId', 'domainId', 'domainName', 'path']) || context.accountId !== target.accountId || context.domainId !== target.domainId || typeof context.domainName !== 'string' || !context.domainName || context.domainName.length > 253 || typeof context.path !== 'string' || !context.path || context.path.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(context.domainName + context.path) || context.path.startsWith('/') || context.path.split('/').some(part => !part || ['.', '..', '.xpanel', '.trash'].includes(part)) || !hash(raw.revision)) return bad()
  const names = ['index.html', 'index.htm', 'index.php']
  if (!Array.isArray(raw.files) || raw.files.length !== 3 || raw.files.some((file, i) => !exact(file, ['name', 'exists', 'hash', 'sizeBytes']) || file.name !== names[i] || typeof file.exists !== 'boolean' || typeof file.sizeBytes !== 'number' || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes > 1_048_576 || (file.exists ? !hash(file.hash) : file.hash !== null || file.sizeBytes !== 0))) return bad()
  if (!exact(recovery, ['status', 'createdAt']) || !['none', 'prepared', 'published', 'restored'].includes(String(recovery.status)) || (recovery.status === 'none' ? recovery.createdAt !== null : typeof recovery.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(recovery.createdAt) || !Number.isFinite(Date.parse(recovery.createdAt)) || new Date(recovery.createdAt).toISOString() !== recovery.createdAt)) return bad()
  const status = operation === 'publish' ? 'published' : operation === 'rollback' ? 'rolled_back' : 'read'
  if (!exact(capabilities, ['canPublish', 'canRollback']) || capabilities.canPublish !== false || typeof capabilities.canRollback !== 'boolean' || !exact(application, ['status', 'nativeQualified']) || application.status !== status || application.nativeQualified !== false || ['none', 'restored'].includes(String(recovery.status)) && capabilities.canRollback || operation === 'publish' || operation === 'rollback' && recovery.status !== 'restored') return bad()
  return raw as unknown as SitePublisherView
}

/** Bounded transport: ambiguous mutation replies always require review before retry. */
export async function executeSitePublisherWorkspaceRequest(target: { accountId: string; domainId: string }, request: SitePublisherHttpRequest, invoke: () => Promise<Response>): Promise<Response> {
  const mutation = request.operation === 'publish' || request.operation === 'rollback'
  try {
    const response = await invoke(), declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65_536) || !response.body) throw new Error('invalid_site_publisher_reply')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: unknown
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 65_536) { await reader.cancel(); throw new Error('site_publisher_reply_limit') } chunks.push(chunk.value) } raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } finally { reader.releaseLock() }
    if (response.status !== 200) {
      const problem = object(raw) && object(raw.error) ? raw.error : object(raw) ? raw : {}, details = object(problem.details) ? problem.details : object(problem.detail) ? problem.detail : object(raw) && object(raw.details) ? raw.details : {}
      if (mutation && !(details.stateChanged === false && details.unknownOutcome !== true && details.verificationRequired !== true)) throw new Error('unverified_site_publisher_mutation')
      return Response.json({ error: 'The protected site publisher request was refused.', details: { stateChanged: false } }, { status: [400, 401, 403, 404, 409, 412, 413, 422].includes(response.status) ? response.status : 503 })
    }
    return Response.json(validateSitePublisherWorkspaceReply(target, raw, request.operation), { headers: { 'cache-control': 'no-store' } })
  } catch { return fail('SERVICE_UNAVAILABLE', mutation ? 'site publisher outcome requires inspection' : 'site publisher reply could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) }) }
}
