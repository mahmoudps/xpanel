import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipal } from './authorization.ts'

const MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REPLY_BYTES = 8 * 1024 * 1024
export interface AccountBackupContext { account: Account; caller: AuthenticatedCaller }
export type AccountBackupAction = 'backup.read' | 'backup.create' | 'backup.preview' | 'backup.restore' | 'backup.download'
export interface AccountBackupWorkspaceDeps {
  authorize(req: Request, action: AccountBackupAction): Promise<AccountBackupContext>
  /** Forward to /accounts/<server-pinned username>/backup-workspace plus this suffix. */
  requestAgent(context: AccountBackupContext, suffix: string, options: { method: string; body?: unknown }): Promise<Response>
  audit(context: AccountBackupContext, action: string, file: string | null, outcome: 'ok' | 'failed'): Promise<void>
}
interface ArchiveView { file: string; bytes: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const archiveFile = (username: string, value: unknown): string => {
  if (typeof value !== 'string' || !new RegExp('^xpanel-backup-' + username + '-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$').test(value)) return fail('VALIDATION', 'account archive file name is invalid', { stateChanged: false })
  return value
}
const archive = (value: unknown, username: string, listing = false): ArchiveView => {
  if (!object(value) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || !listing && (Number(value.bytes) === 0 || Number(value.bytes) > MAX_BYTES)) return fail('PRECONDITION_FAILED', 'host archive metadata could not be verified', { verificationRequired: true })
  return { file: archiveFile(username, value.file), bytes: Number(value.bytes) }
}
const readJson = async (response: Response): Promise<unknown> => {
  if (!response.body) return fail('PRECONDITION_FAILED', 'host backup response is missing', { verificationRequired: true })
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > MAX_REPLY_BYTES) { await reader.cancel(); return fail('LIMIT_EXCEEDED', 'host backup response is too large', { verificationRequired: true }) }; chunks.push(chunk.value) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { return fail('PRECONDITION_FAILED', 'host backup response could not be read', { verificationRequired: true }) }
  finally { reader.releaseLock() }
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const body = async (req: Request, allowed: readonly string[]): Promise<Record<string, unknown>> => {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) return fail('VALIDATION', 'a JSON backup request is required', { stateChanged: false })
  let value: unknown
  try { const source = await req.text(); if (source.length > 4096) return fail('VALIDATION', 'backup request is too large', { stateChanged: false }); value = JSON.parse(source) }
  catch { return fail('VALIDATION', 'backup request must contain valid JSON', { stateChanged: false }) }
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail('VALIDATION', 'unsupported account backup field', { stateChanged: false })
  return value
}
const contextView = (context: AccountBackupContext) => ({ accountId: context.account.id, username: context.account.username, scope: 'home', maxBytes: MAX_BYTES, mailPreserved: true })

/** Account selectors never cross this boundary; the authenticated current account is authoritative. */
export function createAccountBackupWorkspace(deps: AccountBackupWorkspaceDeps) {
  const authorize = async (req: Request, action: AccountBackupAction, previous?: AccountBackupContext): Promise<AccountBackupContext> => {
    const current = await deps.authorize(req, action)
    if (isMailboxPrincipal(current.caller) || current.caller.principal.kind !== 'user' || current.caller.principal.accountId !== current.account.id || current.account.status !== 'active') return fail('FORBIDDEN', 'account backups require the active signed-in owner', { stateChanged: false })
    if (previous && (current.account.id !== previous.account.id || current.account.username !== previous.account.username || current.account.uid !== previous.account.uid || current.account.home !== previous.account.home)) return fail('CONFLICT', 'the backup account changed; reload before continuing', { stateChanged: false })
    return current
  }
  const readList = async (context: AccountBackupContext): Promise<{ response: Response; backups?: ArchiveView[] }> => {
    const response = await deps.requestAgent(context, '', { method: 'GET' })
    if (!response.ok) return { response }
    const value = await readJson(response)
    if (!object(value) || !Array.isArray(value.backups) || value.backups.length > 10000) return fail('PRECONDITION_FAILED', 'host backup listing could not be verified', { verificationRequired: true })
    const backups = value.backups.map(item => archive(item, context.account.username, true))
    if (new Set(backups.map(item => item.file)).size !== backups.length) return fail('PRECONDITION_FAILED', 'host backup listing contains duplicate files', { verificationRequired: true })
    return { response, backups }
  }
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== '/api/account/backups' && !url.pathname.startsWith('/api/account/backups/')) return null
    const base = '/api/account/backups', suffix = url.pathname.slice(base.length)
    const match = /^\/([^/]+)\/(preview|restore|download|preview\.csv)$/.exec(suffix)
    const action: AccountBackupAction = !suffix ? method === 'GET' ? 'backup.read' : 'backup.create' : match?.[2] === 'restore' ? 'backup.restore' : match?.[2] === 'download' ? 'backup.download' : 'backup.preview'
    let context = await authorize(req, action)
    if (url.search && match?.[2] !== 'preview.csv') return fail('VALIDATION', 'account backup selectors are not accepted', { stateChanged: false })
    if (!suffix && method === 'GET') {
      const listing = await readList(context)
      return listing.backups ? json({ context: contextView(context), backups: listing.backups }) : listing.response
    }
    let file: string | undefined
    if (match) {
      let decoded: string
      try { decoded = decodeURIComponent(match[1]!) } catch { return fail('VALIDATION', 'account archive file name is invalid', { stateChanged: false }) }
      file = archiveFile(context.account.username, decoded)
    }
    if (!suffix && method === 'POST') {
      await body(req, [])
      context = await authorize(req, action, context)
      const response = await deps.requestAgent(context, '', { method: 'POST', body: {} })
      if (!response.ok) { await deps.audit(context, 'backup.create', null, 'failed'); return response }
      try {
        const value = await readJson(response)
        if (!object(value)) throw new Error('invalid_backup_ack')
        const created = archive(value.backup, context.account.username), listing = await readList(context)
        if (!listing.backups?.some(item => item.file === created.file && item.bytes === created.bytes)) throw new Error('backup_readback_mismatch')
        await deps.audit(context, 'backup.created', created.file, 'ok')
        return json({ context: contextView(context), backup: created }, 201)
      } catch { await deps.audit(context, 'backup.create', null, 'failed'); return fail('PRECONDITION_FAILED', 'archive creation outcome requires review; do not retry automatically', { stateChanged: true, verificationRequired: true }) }
    }
    if (match && method === 'GET' && match[2] === 'download') {
      const listing = await readList(context)
      if (!listing.backups) return listing.response
      const selected = listing.backups.find(item => item.file === file)
      if (!selected) return fail('NOT_FOUND', 'account archive not found')
      if (selected.bytes === 0 || selected.bytes > MAX_BYTES) return fail('LIMIT_EXCEEDED', 'the archive is empty or exceeds the 2 GiB account limit')
      context = await authorize(req, action, context)
      const response = await deps.requestAgent(context, '/' + encodeURIComponent(file!) + '/download', { method: 'GET' })
      if (!response.ok) return response
      if (!response.body || response.headers.get('content-type') !== 'application/gzip' || response.headers.get('content-length') !== String(selected.bytes) || response.headers.get('content-disposition') !== `attachment; filename="${file}"`) { await response.body?.cancel(); return fail('PRECONDITION_FAILED', 'archive download headers could not be verified') }
      try { await deps.audit(context, 'backup.download.started', file!, 'ok') }
      catch (error) { await response.body.cancel().catch(() => undefined); throw error }
      return new Response(response.body, { headers: { 'content-type': 'application/gzip', 'content-length': String(selected.bytes), 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } })
    }
    if (match && method === 'GET' && match[2] === 'preview.csv') {
      if ([...url.searchParams.keys()].some(key => key !== 'revision') || !/^[a-f0-9]{64}$/.test(url.searchParams.get('revision') ?? '')) return fail('VALIDATION', 'the reviewed backup revision is required')
      return deps.requestAgent(context, '/' + encodeURIComponent(file!) + '/preview.csv?revision=' + url.searchParams.get('revision'), { method: 'GET' })
    }
    if (match && method === 'POST' && (match[2] === 'preview' || match[2] === 'restore')) {
      const request = await body(req, match[2] === 'restore' ? ['expectedRevision', 'confirmation'] : [])
      if (match[2] === 'restore' && (request.confirmation !== context.account.username || typeof request.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expectedRevision))) return fail('VALIDATION', 'the exact account confirmation and reviewed revision are required', { stateChanged: false })
      context = await authorize(req, action, context)
      const response = await deps.requestAgent(context, '/' + encodeURIComponent(file!) + '/' + match[2], { method: 'POST', body: request })
      if (!response.ok) { if (match[2] === 'restore') await deps.audit(context, 'backup.restore', file!, 'failed'); return response }
      const value = await readJson(response)
      if (match[2] === 'preview') {
        if (!object(value) || !object(value.preview) || value.preview.file !== file || typeof value.preview.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.preview.revision) || value.preview.scope !== 'home' || value.preview.mailPreserved !== true) return fail('PRECONDITION_FAILED', 'restore comparison could not be verified', { stateChanged: false })
        return json({ context: contextView(context), preview: value.preview })
      }
      if (!object(value) || !object(value.backup) || value.backup.file !== file || value.backup.scope !== 'home' || value.backup.mailPreserved !== true || value.backup.contentReadback !== 'matched') return fail('PRECONDITION_FAILED', 'restore outcome requires review; the home must be inspected', { stateChanged: true, verificationRequired: true })
      if (archive(value.backup.recovery, context.account.username).file === file) return fail('PRECONDITION_FAILED', 'restore did not verify a separate recovery archive', { stateChanged: true, verificationRequired: true })
      await deps.audit(context, 'backup.restored', file!, 'ok')
      return json({ context: contextView(context), backup: value.backup })
    }
    return fail('NOT_FOUND', 'account backup route not found')
  }
}
