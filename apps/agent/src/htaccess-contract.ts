import { fail, isUuid } from '@xpanel/core'
import { HTACCESS_MAX_BYTES } from './htaccess-policy.ts'
import type { HtaccessRequest } from './htaccess-workspace.ts'

const revision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function parseHtaccessRequest(value: unknown): HtaccessRequest {
  if (!object(value) || !['read', 'validate', 'save', 'restore', 'migrate-php'].includes(String(value.op))) return fail('VALIDATION', 'invalid .htaccess operation', { stateChanged: false })
  const allowed = value.op === 'read' ? ['op'] : value.op === 'restore' ? ['op', 'versionId', 'expectedRevision'] : value.op === 'migrate-php' ? ['op', 'content', 'expectedRevision', 'expectedPhpRevision'] : ['op', 'content', 'expectedRevision']
  if (Object.keys(value).length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported .htaccess request field', { stateChanged: false })
  if (value.op === 'read') return { op: 'read' }
  if (!revision(value.expectedRevision)) return fail('VALIDATION', 'a saved .htaccess revision is required', { stateChanged: false })
  if (value.op === 'restore') {
    if (!isUuid(value.versionId)) return fail('VALIDATION', 'a kept version selector is required', { stateChanged: false })
    return { op: 'restore', versionId: value.versionId, expectedRevision: value.expectedRevision }
  }
  if (value.op === 'migrate-php') {
    if (!revision(value.expectedPhpRevision)) return fail('VALIDATION', 'a saved domain PHP revision is required', { stateChanged: false })
    if (typeof value.content !== 'string' || !value.content.isWellFormed() || Buffer.byteLength(value.content, 'utf8') > HTACCESS_MAX_BYTES) return fail('VALIDATION', '.htaccess draft must be bounded Unicode text', { stateChanged: false })
    return { op: 'migrate-php', content: value.content, expectedRevision: value.expectedRevision, expectedPhpRevision: value.expectedPhpRevision }
  }
  if (typeof value.content !== 'string' || !value.content.isWellFormed() || Buffer.byteLength(value.content, 'utf8') > HTACCESS_MAX_BYTES) return fail('VALIDATION', '.htaccess content must be bounded Unicode text', { stateChanged: false })
  return { op: value.op as 'save' | 'validate', content: value.content, expectedRevision: value.expectedRevision }
}
