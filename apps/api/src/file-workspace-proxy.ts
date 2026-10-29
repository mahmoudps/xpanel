import { fail } from '@xpanel/core'
import { validateFileWorkspaceReply } from './file-workspace-validation.ts'
import type { FileWorkspaceRequest } from './file-workspace-validation.ts'

const READ_OPERATIONS = new Set(['list', 'read', 'list-trash', 'get-bytes'])
const MAX_REPLY_BYTES = 8 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

async function readReply(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_REPLY_BYTES)) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('file_reply_limit')
  }
  if (!response.body) throw new Error('missing_file_reply')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_REPLY_BYTES) { await reader.cancel(); throw new Error('file_reply_limit') }
      chunks.push(chunk.value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown
  } finally { reader.releaseLock() }
}

function unchangedFailure(value: unknown): boolean {
  if (!record(value)) return false
  const problem = record(value.error) ? value.error : value
  const details = record(problem.details) ? problem.details : {}
  const candidates = [value, record(value.details) ? value.details : {}, problem, details]
  if (candidates.some(candidate => ['verificationRequired', 'unknownOutcome', 'needsAttention'].some(key => candidate[key] === true) || candidate.stateChanged === true)) return false
  return details.stateChanged === false || value.stateChanged === false || record(value.details) && value.details.stateChanged === false
}

function refusedReply(upstreamStatus: number): Response {
  const codes: Record<number, string> = {
    400: 'VALIDATION', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
    409: 'CONFLICT', 412: 'PRECONDITION_FAILED', 413: 'LIMIT_EXCEEDED', 422: 'VALIDATION',
  }
  const status = Object.hasOwn(codes, upstreamStatus) ? upstreamStatus : 503
  return json({ code: codes[status] ?? 'SERVICE_UNAVAILABLE', error: 'The file operation could not be completed.',
    details: { stateChanged: false, upstreamStatus } }, status)
}
/** Validate the trusted agent's reply before an account file result reaches the browser. */
export async function executeFileWorkspaceRequest(request: FileWorkspaceRequest, invoke: () => Promise<Response>): Promise<Response> {
  const mutation = !READ_OPERATIONS.has(request.op)
  try {
    const response = await invoke()
    const body = await readReply(response)
    if (response.status !== 200) {
      if (response.ok) throw new Error('unexpected_file_reply_status')
      if (mutation && !unchangedFailure(body)) return fail('SERVICE_UNAVAILABLE', 'file operation outcome requires verification', {
        stateChanged: true, verificationRequired: true, unknownOutcome: true, upstreamStatus: response.status,
      })
      return refusedReply(response.status)
    }
    return json(validateFileWorkspaceReply(request, body))
  } catch {
    if (mutation) return fail('SERVICE_UNAVAILABLE', 'file operation outcome requires verification', {
      stateChanged: true, verificationRequired: true, unknownOutcome: true,
    })
    return fail('SERVICE_UNAVAILABLE', 'file operation reply could not be verified', { stateChanged: false })
  }
}