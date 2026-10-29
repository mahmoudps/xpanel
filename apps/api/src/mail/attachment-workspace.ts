import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { MailboxSessionRecord } from '@xpanel/db'
import { ImapProtocolClient } from './imap.ts'
import type { ImapConnectionConfig } from './imap.ts'
import { imapDialPlan } from './idle.ts'
import { mailboxFolderUid, selectedMailboxFolder } from './folder-workspace.ts'
import { sanitizeAttachmentFilename } from './mime.ts'

export const ATTACHMENT_MESSAGE_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024
export const ATTACHMENT_MAX_PARTS = 64
export const ATTACHMENT_REFERENCE_TTL_MS = 5 * 60 * 1000

export interface AttachmentMailboxContext {
  record: Pick<MailboxSessionRecord, 'sessionId' | 'mailbox' | 'accountId' | 'serviceUserId'>
  password: string
}
export interface AttachmentPart {
  filename: string
  contentType: string
  content: Uint8Array
  dangerousExtension?: boolean
}
export interface AttachmentMessage {
  mailbox: string
  folder: string
  uid: number
  uidValidity: number
  parts: AttachmentPart[]
}
export interface AttachmentSource {
  read(opened: AttachmentMailboxContext, folder: string, uid: number): Promise<AttachmentMessage>
}
type AttachmentImapClient = Pick<ImapProtocolClient, 'connect' | 'login' | 'logout' | 'fetchMessagesByUid' | 'authorizeAttachmentDownload'>

/** Credentials and dial configuration come only from the trusted server, never from the request. */
export function createLocalAttachmentSource(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory: (config: ImapConnectionConfig) => AttachmentImapClient = config => new ImapProtocolClient(config),
): AttachmentSource {
  return {
    async read(opened, folder, uid) {
      const host = env.XPANEL_IMAP_HOST || '127.0.0.1', port = Number(env.XPANEL_IMAP_PORT || '143')
      const plan = imapDialPlan(host, port, env.XPANEL_IMAP_TLS)
      if (!plan || !Number.isInteger(port) || port < 1 || port > 65535) return fail('PRECONDITION_FAILED', 'secure mailbox attachment transport is unavailable')
      const configuredTimeout = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000')
      const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? Math.min(configuredTimeout, 60000) : 15000
      const client = clientFactory({ host, port, tls: plan.tls, timeoutMs, maxLiteralBytes: ATTACHMENT_MESSAGE_BYTES, maxResponseLineBytes: 1024 * 1024 })
      try {
        await client.connect()
        await client.login(opened.record.mailbox, opened.password)
        const fetched = await client.fetchMessagesByUid(folder, uid, {
          requestedMailbox: opened.record.mailbox,
          mimeLimits: { maxTotalBytes: ATTACHMENT_MESSAGE_BYTES, maxHeaderBytes: 64 * 1024, maxParts: ATTACHMENT_MAX_PARTS, maxNestingDepth: 6, maxDecompressedBytes: ATTACHMENT_FILE_BYTES },
        })
        if (fetched.state.uidValidityObserved !== true) return fail('PRECONDITION_FAILED', 'mailbox message identity has not been observed')
        const message = fetched.messages.find(value => value.uid === uid)
        if (!message) return fail('NOT_FOUND', 'message not found')
        if (message.rfc822SizeObserved !== true || message.bodyComplete !== true || !(message.rawMimeBytes instanceof Uint8Array)
          || message.rawMimeBytes.byteLength !== message.sizeBytes) return fail('PRECONDITION_FAILED', 'the complete message body has not been observed')
        if (message.uidValidity !== fetched.state.uidValidity) return fail('CONFLICT', 'mailbox identity changed; read the message again')
        const parts = message.attachmentTokens.map(reference => {
          const part = client.authorizeAttachmentDownload(opened.record.mailbox, reference.token)
          return { filename: part.filename, contentType: part.contentType, content: part.content, dangerousExtension: reference.dangerousExtension }
        })
        return { mailbox: message.mailbox, folder: message.folder, uid: message.uid, uidValidity: message.uidValidity, parts }
      } catch (error) {
        return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the selected message attachments could not be read', { stateChanged: false })
      } finally { await client.logout().catch(() => undefined) }
    },
  }
}

export interface AttachmentAuditEvent {
  mailbox: string
  folder: string
  uid: number
  filename: string
  sizeBytes: number
  sha256: string
}
export interface AttachmentWorkspaceDependencies {
  /** Opens and freshly authorizes the signed-in sealed mailbox. */
  open: (request: Request) => Promise<AttachmentMailboxContext>
  secret: string
  source?: AttachmentSource
  env?: NodeJS.ProcessEnv
  now?: () => number
  audit: (request: Request, event: AttachmentAuditEvent) => Promise<void>
}
interface AttachmentReference {
  version: 1
  sessionId: string
  accountId: string
  serviceUserId: string
  mailbox: string
  folder: string
  uid: number
  uidValidity: number
  part: number
  sha256: string
  metadataSha256: string
  sizeBytes: number
  expiresAt: number
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const boundedUid = (value: unknown): number => {
  const uid = mailboxFolderUid(value)
  return uid <= 0xffffffff ? uid : fail('VALIDATION', 'message uid is invalid', { stateChanged: false })
}
const safeContentType = (value: string, dangerous: boolean): string => {
  const type = value.split(';')[0]!.trim().toLowerCase()
  if (dangerous || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) || /^(?:text\/(?:html|javascript)|application\/(?:javascript|xhtml\+xml)|image\/svg\+xml)$/.test(type)) return 'application/octet-stream'
  return type
}
const disposition = (filename: string): string => {
  const ascii = filename.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/["\\]/g, '_') || 'attachment.bin'
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const partMetadata = (part: AttachmentPart): string => sha256(Buffer.from(JSON.stringify([sanitizeAttachmentFilename(part.filename), safeContentType(part.contentType, part.dangerousExtension === true)])))
const binding = (opened: AttachmentMailboxContext) => ({ sessionId: opened.record.sessionId, accountId: opened.record.accountId, serviceUserId: opened.record.serviceUserId, mailbox: opened.record.mailbox })
const sameBinding = (left: AttachmentMailboxContext, right: AttachmentMailboxContext): boolean => JSON.stringify(binding(left)) === JSON.stringify(binding(right))

function validatedMessage(message: AttachmentMessage, opened: AttachmentMailboxContext, folder: string, uid: number): AttachmentMessage {
  if (!object(message) || message.mailbox !== opened.record.mailbox || message.folder !== folder || message.uid !== uid
    || !Number.isSafeInteger(message.uidValidity) || message.uidValidity < 1 || message.uidValidity > 0xffffffff
    || !Array.isArray(message.parts) || message.parts.length > ATTACHMENT_MAX_PARTS) return fail('PRECONDITION_FAILED', 'mailbox attachment identity could not be verified')
  let bytes = 0
  for (const part of message.parts) {
    if (!object(part) || typeof part.filename !== 'string' || typeof part.contentType !== 'string' || !(part.content instanceof Uint8Array)
      || part.content.byteLength > ATTACHMENT_FILE_BYTES || part.filename.length > 2048 || !part.filename.isWellFormed() || part.contentType.length > 256) return fail('PRECONDITION_FAILED', 'mailbox attachment exceeds the supported bounds')
    bytes += part.content.byteLength
    if (bytes > ATTACHMENT_MESSAGE_BYTES) return fail('PRECONDITION_FAILED', 'message attachments exceed the supported bounds')
  }
  return message
}

function referenceCodec(secret: string) {
  if (typeof secret !== 'string' || secret.length < 32) return fail('PRECONDITION_FAILED', 'mailbox attachment signing is unavailable')
  const signature = (value: string) => createHmac('sha256', secret).update('xpanel-mail-attachment:v1:' + value).digest()
  return {
    encode(value: AttachmentReference): string {
      const body = Buffer.from(JSON.stringify(value)).toString('base64url')
      return body + '.' + signature(body).toString('base64url')
    },
    decode(token: string): AttachmentReference {
      if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return fail('NOT_FOUND', 'attachment download reference not found')
      const [body, mac] = token.split('.') as [string, string]
      const received = Buffer.from(mac, 'base64url')
      if (received.toString('base64url') !== mac || !timingSafeEqual(received, signature(body))) return fail('NOT_FOUND', 'attachment download reference not found')
      let value: unknown
      try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return fail('NOT_FOUND', 'attachment download reference not found') }
      if (!object(value) || value.version !== 1 || ['sessionId', 'accountId', 'serviceUserId', 'mailbox', 'folder'].some(key => typeof value[key] !== 'string')
        || !Number.isSafeInteger(value.uid) || !Number.isSafeInteger(value.uidValidity) || !Number.isSafeInteger(value.part) || (value.part as number) < 0 || (value.part as number) >= ATTACHMENT_MAX_PARTS
        || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0 || (value.sizeBytes as number) > ATTACHMENT_FILE_BYTES
        || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.metadataSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.metadataSha256) || !Number.isSafeInteger(value.expiresAt)) return fail('NOT_FOUND', 'attachment download reference not found')
      return value as unknown as AttachmentReference
    },
  }
}

/** Mounted before legacy JSON attachment metadata routes; only this handler returns real bytes. */
export function createAttachmentWorkspaceRoutes(deps: AttachmentWorkspaceDependencies): (request: Request) => Promise<Response | null> {
  const source = deps.source ?? createLocalAttachmentSource(deps.env), now = deps.now ?? Date.now
  return async request => {
    const url = new URL(request.url), manifest = url.pathname === '/api/webmail/attachment-workspace'
    const download = /^\/api\/webmail\/attachment-download\/([^/]+)$/.exec(url.pathname)
    if (!manifest && !download) return null
    if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } })
    const opened = await deps.open(request), codec = referenceCodec(deps.secret)
    if (manifest) {
      if ([...url.searchParams.keys()].some(key => key !== 'uid' && key !== 'folder' && key !== 'uidValidity') || url.searchParams.getAll('uid').length !== 1 || url.searchParams.getAll('folder').length > 1 || url.searchParams.getAll('uidValidity').length > 1) return fail('VALIDATION', 'unsupported attachment selector', { stateChanged: false })
      const uid = boundedUid(url.searchParams.get('uid')), folder = selectedMailboxFolder(url.searchParams.get('folder'))
      const expectedValidity = url.searchParams.has('uidValidity') ? boundedUid(url.searchParams.get('uidValidity')) : undefined
      const message = validatedMessage(await source.read(opened, folder, uid), opened, folder, uid)
      if (expectedValidity !== undefined && expectedValidity !== message.uidValidity) return fail('CONFLICT', 'message identity changed; read the message again')
      const fresh = await deps.open(request)
      if (!sameBinding(opened, fresh)) return fail('FORBIDDEN', 'mailbox session changed; sign in again')
      const expiresAt = now() + ATTACHMENT_REFERENCE_TTL_MS
      const attachments = message.parts.map((part, index) => {
        const filename = sanitizeAttachmentFilename(part.filename), hash = sha256(part.content)
        const ref: AttachmentReference = { version: 1, ...binding(opened), folder, uid, uidValidity: message.uidValidity, part: index, sha256: hash, metadataSha256: partMetadata(part), sizeBytes: part.content.byteLength, expiresAt }
        return { filename, contentType: safeContentType(part.contentType, part.dangerousExtension === true), sizeBytes: part.content.byteLength, sha256: hash,
          downloadPath: '/api/webmail/attachment-download/' + codec.encode(ref), expiresAt: new Date(expiresAt).toISOString() }
      })
      return Response.json({ context: { mailbox: opened.record.mailbox, folder, uid, uidValidity: message.uidValidity }, attachments }, { headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
    }
    if (url.search) return fail('VALIDATION', 'unsupported attachment selector', { stateChanged: false })
    const reference = codec.decode(download![1]!)
    if (Object.entries(binding(opened)).some(([key, value]) => reference[key as keyof AttachmentReference] !== value)) return fail('NOT_FOUND', 'attachment download reference not found')
    if (reference.expiresAt <= now()) return fail('PRECONDITION_FAILED', 'attachment download reference expired; read attachments again')
    const uid = boundedUid(reference.uid), folder = selectedMailboxFolder(reference.folder)
    const message = validatedMessage(await source.read(opened, folder, uid), opened, folder, uid)
    const part = message.parts[reference.part]
    if (message.uidValidity !== reference.uidValidity || !part || part.content.byteLength !== reference.sizeBytes || sha256(part.content) !== reference.sha256 || partMetadata(part) !== reference.metadataSha256) return fail('CONFLICT', 'message or attachment identity changed; read attachments again')
    const fresh = await deps.open(request)
    if (!sameBinding(opened, fresh)) return fail('FORBIDDEN', 'mailbox session changed; sign in again')
    if (reference.expiresAt <= now()) return fail('PRECONDITION_FAILED', 'attachment download reference expired; read attachments again')
    const filename = sanitizeAttachmentFilename(part.filename), contentType = safeContentType(part.contentType, part.dangerousExtension === true)
    await deps.audit(request, { mailbox: opened.record.mailbox, folder, uid, filename, sizeBytes: part.content.byteLength, sha256: reference.sha256 })
    return new Response(Uint8Array.from(part.content), { headers: { 'content-type': contentType, 'content-length': String(part.content.byteLength), 'content-disposition': disposition(filename),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer' } })
  }
}
