import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { fail, isXpanelError } from '@xpanel/core'
import { MimeCodecAndSanitizer } from './mime.ts'
import type { MimeParseLimits, ParsedMimeAttachment, ParsedMimeMessage } from './mime.ts'

export interface ImapConnectionConfig {
  host: string
  port: number
  tls?: boolean
  rejectUnauthorized?: boolean
  timeoutMs?: number
  /** Trusted caller bound, checked before an incoming literal is read. */
  maxLiteralBytes?: number
  /** Maximum response line bytes, excluding CRLF; omitted preserves legacy callers. */
  maxResponseLineBytes?: number
  maxSearchResults?: number
}

export interface ImapFolderInfo {
  name: string
  delimiter: string
  attributes: string[]
}

export interface ImapSelectedMailboxState {
  folder: string
  exists: number
  recent: number
  uidValidity: number
  /** False when SELECT did not actually advertise a valid UIDVALIDITY. */
  uidValidityObserved?: boolean
  uidNext: number
  flags: string[]
  resynced: boolean
  previousUidValidity: number | null
}

export interface ImapUidTransferResult {
  sourceUid: number
  sourceUidValidity: number
  sourceUidValidityObserved: true
  destinationUid: number | null
  destinationUidValidity: number | null
  destinationUidValidityObserved: boolean
  unknownOutcome?: true
  verificationRequired?: true
}

export interface ImapFetchedMessage {
  mailbox: string
  folder: string
  uid: number
  uidValidity: number
  flags: string[]
  internalDate: string | null
  sizeBytes: number
  rawMime: string
  /** Original literal bytes for lossless MIME decoding and attachment integrity. */
  rawMimeBytes?: Buffer
  rfc822SizeObserved?: boolean
  /** Full BODY[] literal and an observed RFC822.SIZE agree on the byte count. */
  bodyComplete?: boolean
  /** The BODYSTRUCTURE response text, when the server sent one. */
  bodyStructure?: string
  parsed: ParsedMimeMessage
  attachmentTokens: {
    token: string
    filename: string
    contentType: string
    sizeBytes: number
    dangerousExtension: boolean
  }[]
}

interface ScopedAttachmentRecord {
  token: string
  ownerMailbox: string
  folder: string
  uid: number
  uidValidity: number
  attachment: ParsedMimeAttachment
  expiresAtMs: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const positiveMessageUid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff

/** Preserve positions while hiding strings/nested values from FETCH attribute matching. */
const fetchAttributeView = (line: string): string => {
  const result: string[] = []
  let depth = 0, quoted = false, escaped = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (quoted) {
      result.push(' ')
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') { quoted = true; result.push(' ') }
    else if (char === '(') { depth++; result.push(depth > 1 ? ' ' : char) }
    else if (char === ')') { result.push(depth > 1 ? ' ' : char); depth-- }
    else result.push(depth > 1 ? ' ' : char)
  }
  return result.join('')
}
const DEFAULT_ATTACHMENT_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Names and sizes from an IMAP BODYSTRUCTURE. A part counts when it carries a
 * NAME or FILENAME and an octet count. Text parts without a name stay out.
 */
const decodedBodyOctets = (octets: number, encoding: string): number =>
  /base64/i.test(encoding) ? Math.floor(octets / 4) * 3 : octets

export const attachmentsFromBodyStructure = (source: string): { name: string; sizeBytes: number }[] => {
  const marker = source.toUpperCase().indexOf('BODYSTRUCTURE')
  const body = marker < 0 ? source : source.slice(marker + 'BODYSTRUCTURE'.length)
  const results: { name: string; sizeBytes: number }[] = []
  const partRe = /\("([A-Za-z0-9.+-]+)"\s+"([A-Za-z0-9.+-]+)"\s+(\([^)]*\)|NIL)\s+(?:\([^)]*\)|NIL)\s+(?:\([^)]*\)|NIL)\s+"([^"]*)"\s+(\d+)/gi
  let match: RegExpExecArray | null
  while ((match = partRe.exec(body)) !== null) {
    const params = match[3] ?? ''
    const name = /"(?:NAME|FILENAME)"\s+"((?:\\"|[^"])+)"/i.exec(params)?.[1]?.replace(/\\"/g, '"')
    const encoded = Number.parseInt(match[5] ?? '', 10)
    if (!name || !Number.isFinite(encoded) || encoded < 0) continue
    if (match[1]?.toLowerCase() === 'text' && !/name|filename/i.test(params)) continue
    results.push({ name, sizeBytes: decodedBodyOctets(encoded, match[4] ?? '') })
  }
  return results
}

const quoteImapString = (val: string): string => {
  if (/[\r\n\u0000]/.test(val)) {
    fail('VALIDATION', 'IMAP string contains forbidden CR/LF/NUL characters')
  }
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface ImapMailboxEntry {
  /** Wire (modified UTF-7) name; the only identity used in commands. */
  name: string
  /** Decoded name; null when the server name is not canonical modified UTF-7. */
  displayName: string | null
  delimiter: string | null
  attributes: string[]
  /** Null when LSUB was not answered. */
  subscribed: boolean | null
}
export type ImapStatusItem = 'MESSAGES' | 'UNSEEN' | 'SIZE' | 'UIDVALIDITY'
export interface ImapMailboxStatus { messages?: number; unseen?: number; size?: number; uidValidity?: number }
export interface ImapQuotaResource { root: string; resource: string; usage: number; limit: number }
export interface ImapCommandOutcome { ok: boolean; code: string | null }
export interface ImapSearchCriteria { before?: string; largerThan?: number; seen?: true }

const STATUS_FIELDS: Record<ImapStatusItem, keyof ImapMailboxStatus> = { MESSAGES: 'messages', UNSEEN: 'unseen', SIZE: 'size', UIDVALIDITY: 'uidValidity' }
const sameMailboxName = (left: string, right: string): boolean => left === right || (left.toUpperCase() === 'INBOX' && right.toUpperCase() === 'INBOX')
const mailboxWireName = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value) && !/[%*]/.test(value)
  ? value : fail('VALIDATION', 'the mail folder name is invalid', { stateChanged: false })
const unreadableFolders = (): never => fail('PRECONDITION_FAILED', 'the mail server returned an unreadable folder response', { stateChanged: false, reason: 'imap_folder_response_invalid' })

/** RFC 3501 5.1.3 modified UTF-7: printable US-ASCII stays except "&" ("&-"); other runs are "&" + modified BASE64 of UTF-16BE + "-". */
export const encodeImapMailboxName = (name: string): string => {
  if (!name.isWellFormed()) return fail('VALIDATION', 'the mail folder name is not well-formed Unicode', { stateChanged: false })
  let out = '', pending: number[] = []
  const flush = (): void => {
    if (!pending.length) return
    const bytes = Buffer.alloc(pending.length * 2)
    pending.forEach((unit, index) => bytes.writeUInt16BE(unit, index * 2))
    out += '&' + bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-'
    pending = []
  }
  for (let index = 0; index < name.length; index++) {
    const unit = name.charCodeAt(index)
    if (unit >= 0x20 && unit <= 0x7e) { flush(); out += unit === 0x26 ? '&-' : name[index] } else pending.push(unit)
  }
  flush()
  return out
}

/** Canonical modified UTF-7 only (it must re-encode to the same wire bytes); otherwise null. */
export const decodeImapMailboxName = (wire: string): string | null => {
  if (!/^[\x20-\x7e]*$/.test(wire)) return null
  let out = ''
  for (let index = 0; index < wire.length;) {
    const amp = wire.indexOf('&', index)
    if (amp < 0) { out += wire.slice(index); break }
    out += wire.slice(index, amp)
    const end = wire.indexOf('-', amp + 1)
    if (end < 0) return null
    const chunk = wire.slice(amp + 1, end)
    if (!chunk) out += '&'
    else {
      if (!/^[A-Za-z0-9+,]+$/.test(chunk)) return null
      const bytes = Buffer.from(chunk.replace(/,/g, '/'), 'base64')
      if (!bytes.length || bytes.length % 2) return null
      for (let offset = 0; offset < bytes.length; offset += 2) out += String.fromCharCode(bytes.readUInt16BE(offset))
    }
    index = end + 1
  }
  return out.isWellFormed() && encodeImapMailboxName(out) === wire ? out : null
}

/** RFC 3501 mailbox/astring: quoted string, literal (sendCommand inlines it after CRLF) or atom. */
const readMailboxToken = (input: string): { value: string; rest: string } | null => {
  if (input.startsWith('"')) {
    let value = ''
    for (let index = 1; index < input.length; index++) {
      const char = input[index]!
      if (char === '"') return { value, rest: input.slice(index + 1) }
      if (char === '\\') {
        const next = input[++index]
        if (next !== '\\' && next !== '"') return null
        value += next
      } else if (char === '\r' || char === '\n') return null
      else value += char
    }
    return null
  }
  const literal = /^\{(\d{1,5})\}\r\n/.exec(input)
  if (literal) {
    const bytes = Buffer.from(input.slice(literal[0].length), 'utf8'), size = Number(literal[1])
    return bytes.length < size ? null : { value: bytes.subarray(0, size).toString('utf8'), rest: bytes.subarray(size).toString('utf8') }
  }
  const atom = /^[^\s()"{%*\\\x00-\x1f\x7f]+/.exec(input)
  return atom ? { value: atom[0], rest: input.slice(atom[0].length) } : null
}

/** Sorted unique UIDs as an RFC 3501 sequence-set, e.g. "1:3,7". */
const uidSequenceSet = (uids: readonly number[], max: number): string => {
  if (!Array.isArray(uids) || !uids.length || uids.length > max || uids.some(uid => !positiveMessageUid(uid)) || new Set(uids).size !== uids.length) {
    return fail('VALIDATION', 'the mail message set is invalid', { stateChanged: false })
  }
  const sorted = [...uids].sort((left, right) => left - right), parts: string[] = []
  for (let index = 0; index < sorted.length;) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++
    parts.push(end === index ? String(sorted[index]) : sorted[index] + ':' + sorted[end])
    index = end + 1
  }
  return parts.join(',')
}

/**
 * M02 ImapProtocolClient:
 * Real RFC 3501 IMAP4rev1 wire-protocol client over TCP/TLS sockets with:
 * - Strict authenticated mailbox principal binding (A08)
 * - Per-folder `UIDVALIDITY` tracking and automatic cache invalidation + resync on change
 * - `LOGIN`, `LIST`, `SELECT`, `UID FETCH`, `UID STORE`, `UID COPY`, `UID MOVE`, `UID SEARCH CHARSET UTF-8`, `APPEND`, `LOGOUT`
 * - Folder administration (`LSUB`, `CREATE`, `RENAME`, `DELETE`, `SUBSCRIBE`), `STATUS` and `GETQUOTAROOT`
 * - Owner-scoped, time-limited attachment download authorization tokens (A08, A44)
 */
export class ImapProtocolClient {
  private readonly config: ImapConnectionConfig
  private readonly mime: MimeCodecAndSanitizer
  private socket: net.Socket | tls.TLSSocket | null = null
  private authenticatedMailbox: string | null = null
  private selectedFolder: string | null = null
  private selectedUidValidity: number | null = null
  private tagCounter = 0
  private receiveBuffer = Buffer.alloc(0)
  private pendingWaiter: {
    resolve: () => void
    reject: (err: Error) => void
  } | null = null

  private readonly uidValidityCache = new Map<string, number>()
  private readonly cachedMessagesByFolder = new Map<string, Map<number, ImapFetchedMessage>>()
  private readonly attachmentRegistry = new Map<string, ScopedAttachmentRecord>()

  constructor(config: ImapConnectionConfig, mime = new MimeCodecAndSanitizer()) {
    if (config.maxLiteralBytes !== undefined && (!Number.isSafeInteger(config.maxLiteralBytes) || config.maxLiteralBytes <= 0)) {
      fail('VALIDATION', 'IMAP literal limit must be a positive safe integer')
    }
    for (const field of ['maxResponseLineBytes', 'maxSearchResults'] as const) {
      const value = config[field]
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) fail('VALIDATION', 'IMAP response limits must be positive safe integers')
    }
    if (config.maxLiteralBytes !== undefined && config.maxResponseLineBytes !== undefined
      && !Number.isSafeInteger(config.maxLiteralBytes + config.maxResponseLineBytes + 2)) fail('VALIDATION', 'IMAP response limits are too large')
    this.config = config
    this.mime = mime
  }

  get currentMailbox(): string | null {
    return this.authenticatedMailbox
  }

  private refuseBoundedResponse(message: string, reason: string): never {
    this.socket?.destroy()
    this.socket = null
    this.receiveBuffer = Buffer.alloc(0)
    return fail('PRECONDITION_FAILED', message, { reason })
  }

  private assertAuthenticatedMailbox(requestedMailbox?: string): string {
    if (!this.authenticatedMailbox) {
      return fail('UNAUTHENTICATED', 'IMAP client is not authenticated')
    }
    if (requestedMailbox && requestedMailbox.trim().toLowerCase() !== this.authenticatedMailbox) {
      return fail('FORBIDDEN', 'cross-mailbox IMAP operation is forbidden', {
        authenticatedMailbox: this.authenticatedMailbox,
        requestedMailbox: requestedMailbox.trim().toLowerCase(),
      })
    }
    return this.authenticatedMailbox ?? ''
  }

  async connect(): Promise<string> {
    if (this.socket && !this.socket.destroyed) {
      return 'OK already connected'
    }
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.receiveBuffer = Buffer.alloc(0)

    return new Promise<string>((resolve, reject) => {
      let socket: net.Socket | tls.TLSSocket
      const onError = (err: Error): void => {
        cleanup()
        const rawCode = (err as NodeJS.ErrnoException).code
        const code = typeof rawCode === 'string' && /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : null
        const failure = new Error('IMAP socket error' + (code ? ': ' + code : ''))
        if (this.socket === socket) {
          if (this.pendingWaiter) {
            const waiter = this.pendingWaiter
            this.pendingWaiter = null
            waiter.reject(failure)
          }
          socket.destroy()
        }
        reject(failure)
      }
      const timer = setTimeout(() => {
        cleanup()
        this.socket?.destroy()
        reject(new Error(`IMAP connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
      }

      const onConnect = async (): Promise<void> => {
        try {
          const greeting = await this.readLine()
          cleanup()
          if (!greeting.startsWith('* OK')) {
            throw new Error(`Unexpected IMAP greeting: ${greeting}`)
          }
          resolve(greeting)
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }

      if (this.config.tls) {
        this.socket = tls.connect(
          {
            host: this.config.host,
            port: this.config.port,
            rejectUnauthorized: this.config.rejectUnauthorized ?? true,
          },
          () => {
            void onConnect()
          },
        )
      } else {
        this.socket = net.connect(
          {
            host: this.config.host,
            port: this.config.port,
          },
          () => {
            void onConnect()
          },
        )
      }

      socket = this.socket
      socket.on('error', onError)
      socket.on('data', (chunk: Buffer) => {
        if (this.socket !== socket) return
        const literalLimit = this.config.maxLiteralBytes, lineLimit = this.config.maxResponseLineBytes
        if (literalLimit !== undefined && lineLimit !== undefined
          && chunk.byteLength > literalLimit + lineLimit + 2 - this.receiveBuffer.byteLength) {
          this.receiveBuffer = Buffer.alloc(0)
          onError(Object.assign(new Error('IMAP pending response exceeded its byte bound'), { code: 'IMAP_RESPONSE_LIMIT' }))
          return
        }
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
        if (this.pendingWaiter) {
          const w = this.pendingWaiter
          this.pendingWaiter = null
          w.resolve()
        }
      })
      socket.on('close', () => {
        socket.removeListener('error', onError)
        cleanup()
        if (this.socket !== socket) return
        this.socket = null
        this.receiveBuffer = Buffer.alloc(0)
        if (this.pendingWaiter) {
          const w = this.pendingWaiter
          this.pendingWaiter = null
          w.reject(new Error('IMAP socket closed unexpectedly'))
        }
      })
    })
  }

  private async waitForData(): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('IMAP socket is not connected')
    }
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWaiter = null
        reject(new Error(`IMAP read timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pendingWaiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (err: Error) => {
          clearTimeout(timer)
          reject(err)
        },
      }
    })
  }

  private async readLine(): Promise<string> {
    while (true) {
      const nlIdx = this.receiveBuffer.indexOf(0x0a) // '\n'
      const maximum = this.config.maxResponseLineBytes
      if (maximum !== undefined) {
        const contentBytes = nlIdx >= 0 ? nlIdx - (nlIdx > 0 && this.receiveBuffer[nlIdx - 1] === 0x0d ? 1 : 0) : this.receiveBuffer.byteLength
        const pendingCr = nlIdx < 0 && contentBytes === maximum + 1 && this.receiveBuffer.at(-1) === 0x0d
        if (contentBytes > maximum && !pendingCr) return this.refuseBoundedResponse('the mail server response line exceeds its bounded read limit', 'imap_response_line_limit')
      }
      if (nlIdx >= 0) {
        const lineBuf = this.receiveBuffer.subarray(0, nlIdx + 1)
        this.receiveBuffer = this.receiveBuffer.subarray(nlIdx + 1)
        return lineBuf.toString('utf8').replace(/\r?\n$/, '')
      }
      await this.waitForData()
    }
  }

  private async readExactBytes(count: number): Promise<Buffer> {
    while (this.receiveBuffer.length < count) {
      await this.waitForData()
    }
    const out = this.receiveBuffer.subarray(0, count)
    this.receiveBuffer = this.receiveBuffer.subarray(count)
    return out
  }

  private writeRaw(data: string | Buffer): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('IMAP socket is not open')
    }
    this.socket.write(data)
  }

  /**
   * Executes a tagged IMAP command, collecting untagged responses (including literal `{N}\r\n` payloads)
   * until the matching tagged completion line (`A0001 OK/NO/BAD`) arrives.
   */
  private async sendCommand(
    command: string,
    literalPayload?: Buffer,
  ): Promise<{ tag: string; status: 'OK' | 'NO' | 'BAD'; statusText: string; untagged: string[]; literals: Buffer[] }> {
    this.tagCounter++
    const tag = `A${String(this.tagCounter).padStart(4, '0')}`
    const untagged: string[] = []
    const literals: Buffer[] = []

    this.writeRaw(`${tag} ${command}\r\n`)

    while (true) {
      const line = await this.readLine()

      if (line.startsWith('+')) {
        if (!literalPayload) {
          throw new Error(`Unexpected IMAP continuation request: ${line}`)
        }
        this.writeRaw(literalPayload)
        this.writeRaw('\r\n')
        literalPayload = undefined
        continue
      }

      if (line.startsWith('* ')) {
        // Check if the untagged response ends with a literal specifier `{N}`
        const litMatch = /\{(\d+)\}$/.exec(line)
        if (litMatch) {
          const litBytesCount = Number.parseInt(litMatch[1]!, 10)
          if (this.config.maxLiteralBytes !== undefined && (!Number.isSafeInteger(litBytesCount) || litBytesCount > this.config.maxLiteralBytes)) {
            return this.refuseBoundedResponse('the mail message exceeds the bounded read limit', 'imap_literal_limit')
          }
          const litBuf = await this.readExactBytes(litBytesCount)
          literals.push(litBuf)
          const trailingLine = await this.readLine()
          untagged.push(`${line}\r\n${litBuf.toString('utf8')}${trailingLine}`)
        } else {
          untagged.push(line)
        }
        continue
      }

      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1)
        const m = /^(OK|NO|BAD)\b\s*(.*)$/i.exec(rest)
        const status = ((m?.[1] ?? 'BAD').toUpperCase()) as 'OK' | 'NO' | 'BAD'
        const statusText = m?.[2] ?? rest
        return { tag, status, statusText, untagged, literals }
      }
    }
  }

  /**
   * Authenticates the IMAP session for `mailbox` and binds this client instance exclusively to that mailbox.
   */
  async login(mailbox: string, password: string): Promise<void> {
    const normMailbox = mailbox.trim().toLowerCase()
    if (!normMailbox.includes('@')) {
      fail('VALIDATION', 'IMAP login must be a full mailbox email address')
    }
    if (!this.socket || this.socket.destroyed) {
      await this.connect()
    }
    const res = await this.sendCommand(`LOGIN ${quoteImapString(normMailbox)} ${quoteImapString(password)}`)
    if (res.status !== 'OK') {
      fail('UNAUTHENTICATED', `IMAP LOGIN failed for ${normMailbox}: ${res.statusText}`)
    }
    this.authenticatedMailbox = normMailbox
  }

  /**
   * Lists folders in the authenticated mailbox (`LIST "" "*"`).
   */
  async listFolders(requestedMailbox?: string): Promise<ImapFolderInfo[]> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const res = await this.sendCommand('LIST "" "*"')
    if (res.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP LIST failed: ${res.statusText}`)
    }

    const folders: ImapFolderInfo[] = []
    for (const line of res.untagged) {
      const m = /^\*\s+LIST\s+\(([^)]*)\)\s+"([^"]*)"\s+(?:"([^"]+)"|([^\s]+))/i.exec(line)
      if (m) {
        const attrs = (m[1] ?? '')
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
        const delimiter = m[2] ?? '/'
        const name = m[3] ?? m[4] ?? ''
        folders.push({ name, delimiter, attributes: attrs })
      }
    }
    return folders
  }

  /**
   * Selects a folder (`SELECT <folder>`), parses `EXISTS`, `RECENT`, `UIDVALIDITY`, `UIDNEXT`, `FLAGS`,
   * and automatically invalidates cached UIDs/tokens if `UIDVALIDITY` has changed since last sync.
   */
  async selectFolder(folder: string, requestedMailbox?: string): Promise<ImapSelectedMailboxState> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    const res = await this.sendCommand(`SELECT ${quoteImapString(folder)}`)
    if (res.status !== 'OK') {
      fail('NOT_FOUND', `IMAP SELECT failed for folder "${folder}": ${res.statusText}`)
    }

    let exists = 0
    let recent = 0
    let uidValidity = 1
    let uidValidityObserved = false
    let uidNext = 1
    let flags: string[] = []

    for (const line of res.untagged) {
      const existsMatch = /^\*\s+(\d+)\s+EXISTS/i.exec(line)
      if (existsMatch) exists = Number.parseInt(existsMatch[1]!, 10)

      const recentMatch = /^\*\s+(\d+)\s+RECENT/i.exec(line)
      if (recentMatch) recent = Number.parseInt(recentMatch[1]!, 10)

      const uvMatch = /\[UIDVALIDITY\s+(\d+)\]/i.exec(line)
      if (uvMatch) uidValidity = Number.parseInt(uvMatch[1]!, 10)
      if (uvMatch) uidValidityObserved = /^\*\s+OK\s+\[UIDVALIDITY\s+\d+\]/i.test(line)
        && Number.isSafeInteger(uidValidity) && uidValidity > 0 && uidValidity <= 4294967295

      const unMatch = /\[UIDNEXT\s+(\d+)\]/i.exec(line)
      if (unMatch) uidNext = Number.parseInt(unMatch[1]!, 10)

      const flagsMatch = /^\*\s+FLAGS\s+\(([^)]*)\)/i.exec(line)
      if (flagsMatch) {
        flags = (flagsMatch[1] ?? '').split(/\s+/).filter(Boolean)
      }
    }

    const cacheKey = `${mailbox}::${folder}`
    const previousUidValidity = this.uidValidityCache.get(cacheKey) ?? null
    let resynced = false

    if (previousUidValidity !== null && previousUidValidity !== uidValidity) {
      // UIDVALIDITY changed: purge stale UID message cache; attachment tokens issued under
      // the old UIDVALIDITY will fail authorization with CONFLICT until resynced.
      resynced = true
      this.cachedMessagesByFolder.delete(cacheKey)
    }

    this.uidValidityCache.set(cacheKey, uidValidity)
    this.selectedFolder = folder
    this.selectedUidValidity = uidValidity

    return {
      folder,
      exists,
      recent,
      uidValidity,
      uidValidityObserved,
      uidNext,
      flags,
      resynced,
      previousUidValidity,
    }
  }

  /**
   * Fetches a message or range by UID (`UID FETCH <uidRange> (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`),
   * parses and sanitizes its MIME content, and issues owner-scoped attachment tokens.
   */
  async fetchMessagesByUid(
    folder: string,
    uidSequence: string | number,
    options: {
      requestedMailbox?: string
      mimeLimits?: MimeParseLimits
      attachmentTtlMs?: number
    } = {},
  ): Promise<{ state: ImapSelectedMailboxState; messages: ImapFetchedMessage[] }> {
    const mailbox = this.assertAuthenticatedMailbox(options.requestedMailbox)
    const state = await this.selectFolder(folder, mailbox)
    const seqStr = String(uidSequence).trim()
    if (!/^[0-9:*]+(?:,[0-9:*]+)*$/.test(seqStr)) {
      fail('VALIDATION', `invalid IMAP UID sequence "${seqStr}"`)
    }

    const res = await this.sendCommand(
      `UID FETCH ${seqStr} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE BODY.PEEK[])`,
    )
    if (res.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP UID FETCH failed: ${res.statusText}`)
    }

    const cacheKey = `${mailbox}::${folder}`
    let folderCache = this.cachedMessagesByFolder.get(cacheKey)
    if (!folderCache) {
      folderCache = new Map<number, ImapFetchedMessage>()
      this.cachedMessagesByFolder.set(cacheKey, folderCache)
    }

    const messages: ImapFetchedMessage[] = []
    let literalIdx = 0

    for (const rawLine of res.untagged) {
      if (!/^\*\s+\d+\s+FETCH\b/i.test(rawLine)) continue
      const firstLine = rawLine.split(/\r?\n/)[0] ?? rawLine
      const attributes = fetchAttributeView(firstLine)
      const uidMatch = /\bUID\s+([1-9]\d*)(?=\s|\))/i.exec(attributes)
      const flagsOffset = attributes.search(/\bFLAGS\s/i), dateOffset = attributes.search(/\bINTERNALDATE\s/i)
      const flagsMatch = flagsOffset < 0 ? null : /^FLAGS\s+\(([^)]*)\)/i.exec(firstLine.slice(flagsOffset))
      const dateMatch = dateOffset < 0 ? null : /^INTERNALDATE\s+"([^"]*)"/i.exec(firstLine.slice(dateOffset))
      const sizeMatch = /\bRFC822\.SIZE\s+(\d+)(?=\s|\))/i.exec(attributes)
      const bodyMatch = /\bBODY\[\](?:<([0-9]+)>)?\s+\{([0-9]+)\}$/i.exec(attributes)
      const structureStart = firstLine.toUpperCase().indexOf('BODYSTRUCTURE')
      const structureEnd = structureStart < 0 ? -1 : firstLine.toUpperCase().indexOf('BODY.PEEK', structureStart)
      const bodyStructure = structureStart < 0
        ? ''
        : firstLine.slice(structureStart, structureEnd < 0 ? undefined : structureEnd).trim()

      const uid = uidMatch ? Number.parseInt(uidMatch[1]!, 10) : 0
      const flags = flagsMatch ? (flagsMatch[1] ?? '').split(/\s+/).filter(Boolean) : []
      const internalDate = dateMatch ? dateMatch[1]! : null
      const literalBuf = res.literals[literalIdx++]
      const rawMime = literalBuf ? literalBuf.toString('utf8') : ''
      const rawMimeBytes = literalBuf ? Buffer.from(literalBuf) : Buffer.alloc(0)
      const sizeBytes = sizeMatch ? Number.parseInt(sizeMatch[1]!, 10) : rawMimeBytes.byteLength
      const rfc822SizeObserved = sizeMatch !== null && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
      const bodyComplete = literalBuf !== undefined && bodyMatch !== null && bodyMatch[1] === undefined
        && Number(bodyMatch[2]) === rawMimeBytes.byteLength && rfc822SizeObserved && sizeBytes === rawMimeBytes.byteLength

      const parsed = this.mime.parseMimeMessage(rawMimeBytes, options.mimeLimits)
      const ttlMs = options.attachmentTtlMs ?? DEFAULT_ATTACHMENT_TTL_MS
      const expiresAtMs = Date.now() + ttlMs

      const attachmentTokens = parsed.attachments.map((att) => {
        const token = `att_tok_${randomUUID()}`
        this.attachmentRegistry.set(token, {
          token,
          ownerMailbox: mailbox,
          folder,
          uid,
          uidValidity: state.uidValidity,
          attachment: att,
          expiresAtMs,
        })
        return {
          token,
          filename: att.filename,
          contentType: att.contentType,
          sizeBytes: att.sizeBytes,
          dangerousExtension: att.dangerousExtension,
        }
      })

      const fetched: ImapFetchedMessage = {
        mailbox,
        folder,
        uid,
        uidValidity: state.uidValidity,
        flags,
        internalDate,
        sizeBytes,
        rawMime,
        rawMimeBytes,
        rfc822SizeObserved,
        bodyComplete,
        ...(bodyStructure ? { bodyStructure } : {}),
        parsed,
        attachmentTokens,
      }
      folderCache.set(uid, fetched)
      messages.push(fetched)
    }

    return { state, messages }
  }

  /**
   * Authorizes and streams/returns a downloaded attachment only if:
   * 1. `callerMailbox` matches the authenticated mailbox and the attachment's `ownerMailbox`
   * 2. The token has not expired
   * 3. The folder's `UIDVALIDITY` has not been invalidated since the token was issued
   */
  authorizeAttachmentDownload(
    callerMailbox: string,
    token: string,
    nowMs = Date.now(),
  ): {
    filename: string
    contentType: string
    contentDisposition: string
    sizeBytes: number
    sha256: string
    content: Buffer
  } {
    const normCaller = callerMailbox.trim().toLowerCase()
    const record = this.attachmentRegistry.get(token)
    if (!record) {
      return fail('NOT_FOUND', 'attachment reference not found')
    }
    if (record.ownerMailbox !== normCaller) {
      return fail('FORBIDDEN', 'cross-mailbox attachment download is forbidden', {
        callerMailbox: normCaller,
      })
    }
    if (nowMs > record.expiresAtMs) {
      this.attachmentRegistry.delete(token)
      return fail('PRECONDITION_FAILED', 'attachment download reference has expired')
    }
    const currentUv = this.uidValidityCache.get(`${record.ownerMailbox}::${record.folder}`)
    if (currentUv !== undefined && currentUv !== record.uidValidity) {
      this.attachmentRegistry.delete(token)
      return fail('CONFLICT', 'mailbox UIDVALIDITY changed; resync required before downloading attachment')
    }

    return {
      filename: record.attachment.filename,
      contentType: record.attachment.dangerousExtension
        ? 'application/octet-stream'
        : record.attachment.contentType,
      contentDisposition: `attachment; filename="${record.attachment.filename.replace(/["\\]/g, '_')}"`,
      sizeBytes: record.attachment.sizeBytes,
      sha256: record.attachment.sha256,
      content: record.attachment.content,
    }
  }

  private expectedMessageIdentity(uid: unknown, validity: unknown): number {
    if (!positiveMessageUid(uid) || !positiveMessageUid(validity)) return fail('VALIDATION', 'the expected mail message identity is required', { stateChanged: false })
    return validity
  }

  private async observedSelection(folder: string, mailbox: string, expected?: number): Promise<ImapSelectedMailboxState> {
    const state = await this.selectFolder(folder, mailbox)
    if (state.folder !== folder || state.uidValidityObserved !== true || !positiveMessageUid(state.uidValidity)) return fail('PRECONDITION_FAILED', 'the mailbox identity was not observed', { stateChanged: false })
    if (expected !== undefined && state.uidValidity !== expected) return fail('CONFLICT', 'the mailbox identity changed before the operation', { stateChanged: false })
    return state
  }

  private async uidIsPresent(uid: number): Promise<boolean> {
    const result = await this.sendCommand('UID SEARCH UID ' + uid)
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail message presence could not be observed')
    const uids = this.parseSearchUids(result.untagged, 1)
    if (uids.some(value => value !== uid)) return fail('PRECONDITION_FAILED', 'the mail server returned an unexpected message identity')
    return uids.length === 1
  }

  private async requireMessage(folder: string, uid: number, validity: number, mailbox: string): Promise<void> {
    await this.observedSelection(folder, mailbox, validity)
    if (!await this.uidIsPresent(uid)) return fail('NOT_FOUND', 'the mail message is no longer present', { stateChanged: false })
    await this.observedSelection(folder, mailbox, validity)
  }

  private async requireAbsence(folder: string, uid: number, validity: number, mailbox: string): Promise<void> {
    await this.observedSelection(folder, mailbox, validity)
    if (await this.uidIsPresent(uid)) return fail('PRECONDITION_FAILED', 'the removed mail message is still present')
    await this.observedSelection(folder, mailbox, validity)
  }

  private async observedCapabilities(): Promise<Set<string>> {
    const result = await this.sendCommand('CAPABILITY')
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'mail server capabilities could not be observed', { stateChanged: false })
    const lines = result.untagged.filter(line => /^\*\s+CAPABILITY(?:\s|$)/i.test(line))
    if (lines.length !== 1) return fail('PRECONDITION_FAILED', 'mail server capabilities were not observed', { stateChanged: false })
    const capabilities = new Set<string>()
    let count = 0
    for (const match of lines[0]!.replace(/^\*\s+CAPABILITY\s*/i, '').matchAll(/\S+/g)) {
      const token = match[0]
      if (++count > 256 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) return fail('PRECONDITION_FAILED', 'mail server capabilities exceed their supported bounds', { stateChanged: false })
      capabilities.add(token.toUpperCase())
    }
    if (!count) return fail('PRECONDITION_FAILED', 'mail server capabilities were not observed', { stateChanged: false })
    return capabilities
  }

  private requireUidPlus(capabilities: ReadonlySet<string>): void {
    if (!capabilities.has('UIDPLUS')) return fail('PRECONDITION_FAILED', 'the server cannot safely remove one message by UID', { stateChanged: false, unsupported: true, reason: 'imap_uid_expunge_unsupported' })
  }

  private parseCopyUid(result: { statusText: string; untagged: readonly string[] }, uid: number): { sourceUid: number; destinationUid: number; destinationUidValidity: number } | undefined {
    const texts = [result.statusText, ...result.untagged.flatMap(line => {
      const match = /^\*\s+OK\s+(\[COPYUID\b.*)$/i.exec(line)
      return match ? [match[1]!] : []
    })].filter(text => /^\[COPYUID\b/i.test(text))
    const unverified = (): never => fail('PRECONDITION_FAILED', 'the copied mail message identity could not be verified', { unknownOutcome: true, verificationRequired: true, reason: 'imap_copy_uid_unverified' })
    const singleUid = (token: string, allowSingletonRange: boolean): number | undefined => {
      const match = token.length <= 21 ? /^([1-9]\d{0,9})(?::([1-9]\d{0,9}))?$/.exec(token) : null
      if (!match || (!allowSingletonRange && match[2] !== undefined)) return undefined
      const first = Number(match[1]), last = match[2] === undefined ? first : Number(match[2])
      return positiveMessageUid(first) && positiveMessageUid(last) && first === last ? first : undefined
    }
    let identity: { sourceUid: number; destinationUid: number; destinationUidValidity: number } | undefined
    for (const text of texts) {
      const match = /^\[COPYUID\s+(\S+)\s+(\S+)\s+([^\]\s]+)\](?:\s|$)/i.exec(text)
      if (!match) return unverified()
      const sourceUid = singleUid(match[2]!, true), destinationUid = singleUid(match[3]!, true), destinationUidValidity = singleUid(match[1]!, false)
      if (sourceUid === undefined || sourceUid !== uid || destinationUid === undefined || destinationUidValidity === undefined) return unverified()
      const candidate = { sourceUid, destinationUid, destinationUidValidity }
      if (identity && (identity.destinationUid !== destinationUid || identity.destinationUidValidity !== destinationUidValidity)) return unverified()
      identity = candidate
    }
    return identity
  }

  private async requireDestination(folder: string, uid: number, validity: number, mailbox: string): Promise<void> {
    await this.requireMessage(folder, uid, validity, mailbox)
  }

  private async writeSelectedFlags(uid: number, mode: 'add' | 'remove' | 'set', flags: readonly string[]): Promise<void> {
    const action = mode === 'add' ? '+FLAGS.SILENT' : mode === 'remove' ? '-FLAGS.SILENT' : 'FLAGS.SILENT'
    const result = await this.sendCommand('UID STORE ' + uid + ' ' + action + ' (' + flags.join(' ') + ')')
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail message flag update was not verified')
  }

  private messageOperationFailure(error: unknown, attempted: boolean): never {
    return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the mail message operation could not be verified', {
      ...(attempted ? { unknownOutcome: true, verificationRequired: true } : { stateChanged: false }), reason: 'imap_message_unverified',
    })
  }

  /** Searches a genuinely observed mailbox; empty means an actual empty SEARCH response. */
  async searchAllUids(folder: string, requestedMailbox?: string, expectedUidValidity?: number): Promise<number[]> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    if (expectedUidValidity !== undefined && !positiveMessageUid(expectedUidValidity)) return fail('VALIDATION', 'the expected mailbox identity is invalid', { stateChanged: false })
    const state = await this.observedSelection(folder, mailbox, expectedUidValidity)
    const res = await this.sendCommand('UID SEARCH ALL')
    if (res.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail search did not complete')
    const uids = this.parseSearchUids(res.untagged)
    await this.observedSelection(folder, mailbox, state.uidValidity)
    return uids
  }

  async deleteByUid(folder: string, uid: number, requestedMailbox?: string, expectedUidValidity?: number): Promise<void> {
    let attempted = false
    try {
      const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), validity = this.expectedMessageIdentity(uid, expectedUidValidity)
      this.requireUidPlus(await this.observedCapabilities())
      await this.requireMessage(folder, uid, validity, mailbox)
      attempted = true
      await this.writeSelectedFlags(uid, 'add', ['\\Deleted'])
      await this.observedSelection(folder, mailbox, validity)
      const result = await this.sendCommand('UID EXPUNGE ' + uid)
      if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the UID expunge did not complete')
      await this.requireAbsence(folder, uid, validity, mailbox)
    } catch (error) { return this.messageOperationFailure(error, attempted) }
  }

  async storeFlagsByUid(
    folder: string,
    uid: number,
    mode: 'add' | 'remove' | 'set',
    flags: readonly string[],
    requestedMailbox?: string,
    expectedUidValidity?: number,
  ): Promise<void> {
    let attempted = false
    try {
      const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), validity = this.expectedMessageIdentity(uid, expectedUidValidity)
      if (!['add', 'remove', 'set'].includes(mode) || !Array.isArray(flags) || flags.some(flag => typeof flag !== 'string' || !/^\\?[A-Za-z0-9_-]+$/.test(flag))) return fail('VALIDATION', 'the IMAP flags are invalid', { stateChanged: false })
      if (mode !== 'remove' && flags.some(flag => flag.toLowerCase() === '\\deleted')) this.requireUidPlus(await this.observedCapabilities())
      await this.requireMessage(folder, uid, validity, mailbox)
      attempted = true
      await this.writeSelectedFlags(uid, mode, flags)
      await this.requireMessage(folder, uid, validity, mailbox)
    } catch (error) { return this.messageOperationFailure(error, attempted) }
  }

  /** Exact native MOVE for identity-sensitive retirement; never falls back to EXPUNGE. */
  async moveByUidWithIdentity(
    sourceFolder: string,
    uid: number,
    targetFolder: string,
    expectedSourceUidValidity: number,
    requestedMailbox?: string,
  ): Promise<{ sourceUid: number; destinationUid: number; destinationUidValidity: number }> {
    if (sourceFolder === targetFolder) return fail('VALIDATION', 'the mail retirement folders must differ', { stateChanged: false })
    const result = await this.transferByUid(sourceFolder, uid, targetFolder, 'move', expectedSourceUidValidity, requestedMailbox, true)
    if (result.destinationUid === null || result.destinationUidValidity === null || result.destinationUidValidityObserved !== true) return fail('PRECONDITION_FAILED', 'the native mail move identity was not verified', { unknownOutcome: true, verificationRequired: true })
    return { sourceUid: result.sourceUid, destinationUid: result.destinationUid, destinationUidValidity: result.destinationUidValidity }
  }

  /**
   * Moves or copies a message by UID to `targetFolder`.
   */
  async moveOrCopyByUid(
    sourceFolder: string,
    uid: number,
    targetFolder: string,
    operation: 'copy' | 'move',
    requestedMailbox?: string,
    expectedUidValidity?: number,
  ): Promise<number | undefined> {
    const validity = this.expectedMessageIdentity(uid, expectedUidValidity)
    const result = await this.moveOrCopyByUidWithIdentity(sourceFolder, uid, targetFolder, operation, validity, requestedMailbox)
    return result.destinationUid ?? undefined
  }

  async moveOrCopyByUidWithIdentity(
    sourceFolder: string, uid: number, targetFolder: string, operation: 'copy' | 'move', expectedSourceUidValidity: number, requestedMailbox?: string,
  ): Promise<ImapUidTransferResult> {
    return this.transferByUid(sourceFolder, uid, targetFolder, operation, expectedSourceUidValidity, requestedMailbox, false)
  }

  private async transferByUid(
    sourceFolder: string, uid: number, targetFolder: string, operation: 'copy' | 'move', expectedSourceUidValidity: number, requestedMailbox: string | undefined, nativeOnly: boolean,
  ): Promise<ImapUidTransferResult> {
    let attempted = false
    try {
      const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), validity = this.expectedMessageIdentity(uid, expectedSourceUidValidity)
      if (operation !== 'move' && operation !== 'copy') return fail('VALIDATION', 'the mail transfer operation is invalid', { stateChanged: false })
      quoteImapString(sourceFolder)
      const quotedTarget = quoteImapString(targetFolder), capabilities = await this.observedCapabilities()
      const nativeMove = operation === 'move' && capabilities.has('MOVE')
      if (nativeOnly && !nativeMove) return fail('PRECONDITION_FAILED', 'native message MOVE is unavailable', { stateChanged: false, unsupported: true })
      if (operation === 'move' && !nativeMove) this.requireUidPlus(capabilities)
      await this.requireMessage(sourceFolder, uid, validity, mailbox)
      attempted = true
      const result = await this.sendCommand('UID ' + (nativeMove ? 'MOVE ' : 'COPY ') + uid + ' ' + quotedTarget)
      if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail transfer did not complete')
      const identity = this.parseCopyUid(result, uid)
      if (!identity) {
        if (nativeOnly || (operation === 'move' && !nativeMove)) return fail('PRECONDITION_FAILED', 'the transferred message identity was not observed')
        if (nativeMove) await this.requireAbsence(sourceFolder, uid, validity, mailbox)
        else await this.observedSelection(sourceFolder, mailbox, validity)
        return { sourceUid: uid, sourceUidValidity: validity, sourceUidValidityObserved: true, destinationUid: null, destinationUidValidity: null,
          destinationUidValidityObserved: false, unknownOutcome: true, verificationRequired: true }
      }
      if (operation === 'move' && !nativeMove) {
        await this.requireDestination(targetFolder, identity.destinationUid, identity.destinationUidValidity, mailbox)
        await this.requireMessage(sourceFolder, uid, validity, mailbox)
        await this.writeSelectedFlags(uid, 'add', ['\\Deleted'])
        await this.observedSelection(sourceFolder, mailbox, validity)
        const expunge = await this.sendCommand('UID EXPUNGE ' + uid)
        if (expunge.status !== 'OK') return fail('PRECONDITION_FAILED', 'the UID expunge did not complete')
      }
      if (operation === 'move') await this.requireAbsence(sourceFolder, uid, validity, mailbox)
      await this.requireDestination(targetFolder, identity.destinationUid, identity.destinationUidValidity, mailbox)
      if (operation === 'copy') await this.observedSelection(sourceFolder, mailbox, validity)
      return { sourceUid: identity.sourceUid, sourceUidValidity: validity, sourceUidValidityObserved: true,
        destinationUid: identity.destinationUid, destinationUidValidity: identity.destinationUidValidity, destinationUidValidityObserved: true }
    } catch (error) { return this.messageOperationFailure(error, attempted) }
  }

  /**
   * Searches a folder using `UID SEARCH CHARSET UTF-8` so Arabic and UTF-8 queries match accurately.
   */
  async searchByUtf8Query(
    folder: string,
    query: string,
    requestedMailbox?: string,
  ): Promise<number[]> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    if (this.selectedFolder !== folder) {
      await this.selectFolder(folder, mailbox)
    }
    const cleanQuery = query.trim()
    if (!cleanQuery) {
      return this.searchAllUids(folder, mailbox)
    }

    const queryBytes = Buffer.from(cleanQuery, 'utf8')
    const res = await this.sendCommand(
      `UID SEARCH CHARSET UTF-8 TEXT {${queryBytes.length}}`,
      queryBytes,
    )
    if (res.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP UID SEARCH failed: ${res.statusText}`)
    }
    return this.parseSearchUids(res.untagged)
  }

  private parseSearchUids(untaggedLines: readonly string[], operationLimit?: number): number[] {
    const uids: number[] = []
    let observed = false
    for (const line of untaggedLines) {
      const m = /^\*\s+SEARCH(?:\s+(.*))?$/i.exec(line)
      if (m) observed = true
      if (m && m[1]) {
        for (const match of m[1].matchAll(/\S+/g)) {
          const limit = Math.min(this.config.maxSearchResults ?? Number.POSITIVE_INFINITY, operationLimit ?? Number.POSITIVE_INFINITY)
          if (uids.length >= limit) return this.refuseBoundedResponse('the mail search result exceeds its bounded result count', 'imap_search_result_limit')
          const token = match[0]
          const n = token.length <= 10 && /^[1-9]\d*$/.test(token) ? Number(token) : Number.NaN
          if (!Number.isSafeInteger(n) || n > 4294967295) return fail('PRECONDITION_FAILED', 'IMAP SEARCH returned an invalid message identity')
          uids.push(n)
        }
      }
    }
    if (!observed) return fail('PRECONDITION_FAILED', 'IMAP SEARCH result was not observed')
    return uids
  }

  /**
   * Appends a raw MIME message to `folder` (`APPEND <folder> (<flags>) {<bytes>}`),
   * used for saving Drafts and storing a copy in Sent.
   */
  async appendMessage(
    folder: string,
    rawMime: string | Buffer,
    flags: readonly string[] = ['\\Seen'],
    requestedMailbox?: string,
  ): Promise<{ appendedUid: number | null; appendedUidValidity: number | null; statusText: string }> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const payload = typeof rawMime === 'string' ? Buffer.from(rawMime, 'utf8') : rawMime
    const flagList = flags.join(' ')
    const res = await this.sendCommand(
      `APPEND ${quoteImapString(folder)} (${flagList}) {${payload.length}}`,
      payload,
    )
    if (res.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP APPEND failed: ${res.statusText}`)
    }
    const appendUidMatch = /^\[APPENDUID\s+([1-9]\d*)\s+([1-9]\d*)\](?:\s|$)/i.exec(res.statusText)
    const validity = appendUidMatch ? Number(appendUidMatch[1]) : null
    const uid = appendUidMatch ? Number(appendUidMatch[2]) : null
    const known = validity !== null && uid !== null && Number.isSafeInteger(validity) && validity <= 4294967295
      && Number.isSafeInteger(uid) && uid <= 4294967295
    return { appendedUid: known ? uid : null, appendedUidValidity: known ? validity : null, statusText: res.statusText }
  }

  /** `STATUS` counts. A missing folder returns null instead of failing the mailbox. */
  async folderStatus(folder: string, requestedMailbox?: string): Promise<{ messages: number; unseen: number } | null> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const res = await this.sendCommand(`STATUS ${quoteImapString(folder)} (MESSAGES UNSEEN)`)
    if (res.status !== 'OK') return null
    const line = res.untagged.find(item => /\bSTATUS\b/i.test(item)) ?? ''
    const messages = Number.parseInt(/\bMESSAGES\s+(\d+)/i.exec(line)?.[1] ?? '', 10)
    const unseen = Number.parseInt(/\bUNSEEN\s+(\d+)/i.exec(line)?.[1] ?? '', 10)
    if (!Number.isFinite(messages)) return null
    return { messages, unseen: Number.isFinite(unseen) ? unseen : 0 }
  }

  /** Dovecot STORAGE is kibibytes. Null when the quota plugin did not answer. */
  async quotaRoot(requestedMailbox?: string): Promise<{ usedKb: number; limitKb: number } | null> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const res = await this.sendCommand('GETQUOTAROOT INBOX')
    if (res.status !== 'OK') return null
    for (const line of res.untagged) {
      const match = /\bSTORAGE\s+(\d+)\s+(\d+)/i.exec(line)
      if (!match) continue
      const usedKb = Number.parseInt(match[1]!, 10)
      const limitKb = Number.parseInt(match[2]!, 10)
      if (Number.isFinite(usedKb) && Number.isFinite(limitKb)) return { usedKb, limitKb }
    }
    return null
  }

  /** Observed post-login CAPABILITY tokens, upper-cased (e.g. MOVE, UIDPLUS, STATUS=SIZE, QUOTA). */
  async capabilities(requestedMailbox?: string): Promise<ReadonlySet<string>> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    return this.observedCapabilities()
  }

  private parseMailboxLines(lines: readonly string[], kind: 'LIST' | 'LSUB', maxEntries: number): ImapMailboxEntry[] {
    const entries: ImapMailboxEntry[] = []
    const marker = new RegExp('^\\*\\s+' + kind + '\\s', 'i'), head = new RegExp('^\\*\\s+' + kind + '\\s+\\(([^()]*)\\)\\s+(NIL|"(?:\\\\[\\\\"]|[^"\\\\])")\\s+', 'i')
    for (const line of lines) {
      if (!marker.test(line)) continue
      const match = head.exec(line), token = match ? readMailboxToken(line.slice(match[0].length)) : null
      const attributes = match ? match[1]!.split(/\s+/).filter(Boolean) : []
      if (!match || !token || token.rest !== '' || !/^[\x20-\x7e]{1,1024}$/.test(token.value) || attributes.length > 32
        || attributes.some(flag => !/^\\[A-Za-z][A-Za-z0-9-]{0,63}$/.test(flag))) return unreadableFolders()
      if (entries.length >= maxEntries) return this.refuseBoundedResponse('the mail folder list exceeds its bounded entry count', 'imap_folder_list_limit')
      const delimiter = match[2]!.toUpperCase() === 'NIL' ? null : match[2]!.slice(1, -1).replace(/^\\/, '')
      entries.push({ name: token.value, displayName: decodeImapMailboxName(token.value), delimiter, attributes, subscribed: null })
    }
    return entries
  }

  /** RFC 3501 LIST "" "*" with RFC 6154 special-use attributes; subscriptions from LSUB when answered. */
  async listMailboxes(requestedMailbox?: string, maxEntries = 2000): Promise<{ entries: ImapMailboxEntry[]; subscriptionsObserved: boolean }> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const list = await this.sendCommand('LIST "" "*"')
    if (list.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail folder list was not observed', { stateChanged: false, reason: 'imap_list_unavailable' })
    const entries = this.parseMailboxLines(list.untagged, 'LIST', maxEntries)
    const key = (name: string): string => name.toUpperCase() === 'INBOX' ? 'INBOX' : name
    if (new Set(entries.map(entry => key(entry.name))).size !== entries.length) return unreadableFolders()
    const lsub = await this.sendCommand('LSUB "" "*"')
    const subscribed = lsub.status === 'OK' ? new Set(this.parseMailboxLines(lsub.untagged, 'LSUB', maxEntries).map(entry => key(entry.name))) : null
    for (const entry of entries) entry.subscribed = subscribed === null ? null : subscribed.has(key(entry.name))
    return { entries, subscriptionsObserved: subscribed !== null }
  }

  private async mailboxCommand(command: string, invalidates: readonly string[] = []): Promise<ImapCommandOutcome> {
    const mailbox = this.authenticatedMailbox ?? ''
    for (const name of invalidates) {
      this.uidValidityCache.delete(mailbox + '::' + name); this.cachedMessagesByFolder.delete(mailbox + '::' + name)
      if (this.selectedFolder === name) { this.selectedFolder = null; this.selectedUidValidity = null }
    }
    const result = await this.sendCommand(command)
    // RFC 5530 response codes such as [ALREADYEXISTS], [NONEXISTENT], [INUSE]; never the server's free text.
    return { ok: result.status === 'OK', code: /^\[([A-Za-z][A-Za-z0-9-]{0,31})[\] ]/.exec(result.statusText)?.[1]?.toUpperCase() ?? null }
  }

  /** RFC 3501 CREATE with an already encoded wire name. */
  async createMailbox(name: string, requestedMailbox?: string): Promise<ImapCommandOutcome> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    return this.mailboxCommand('CREATE ' + quoteImapString(mailboxWireName(name)))
  }

  /** RFC 3501 RENAME; the server moves inferior folders with it. */
  async renameMailbox(from: string, to: string, requestedMailbox?: string): Promise<ImapCommandOutcome> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const source = mailboxWireName(from), target = mailboxWireName(to)
    return this.mailboxCommand('RENAME ' + quoteImapString(source) + ' ' + quoteImapString(target), [source, target])
  }

  async deleteMailbox(name: string, requestedMailbox?: string): Promise<ImapCommandOutcome> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const wire = mailboxWireName(name)
    return this.mailboxCommand('DELETE ' + quoteImapString(wire), [wire])
  }

  async setMailboxSubscription(name: string, subscribed: boolean, requestedMailbox?: string): Promise<ImapCommandOutcome> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    if (typeof subscribed !== 'boolean') return fail('VALIDATION', 'the subscription state is invalid', { stateChanged: false })
    return this.mailboxCommand((subscribed ? 'SUBSCRIBE ' : 'UNSUBSCRIBE ') + quoteImapString(mailboxWireName(name)))
  }

  /** RFC 3501 STATUS; SIZE is RFC 8438 and is requested only when STATUS=SIZE was advertised. */
  async mailboxStatus(name: string, items: readonly ImapStatusItem[], requestedMailbox?: string): Promise<ImapMailboxStatus> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const wire = mailboxWireName(name)
    if (!Array.isArray(items) || !items.length || new Set(items).size !== items.length || items.some(item => !Object.hasOwn(STATUS_FIELDS, item))) return fail('VALIDATION', 'the folder status items are invalid', { stateChanged: false })
    const result = await this.sendCommand('STATUS ' + quoteImapString(wire) + ' (' + items.join(' ') + ')')
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail folder status was not observed', { stateChanged: false, reason: 'imap_status_unavailable' })
    const lines = result.untagged.filter(line => /^\*\s+STATUS\s/i.test(line))
    const token = lines.length === 1 ? readMailboxToken(lines[0]!.replace(/^\*\s+STATUS\s+/i, '')) : null
    const values = token && sameMailboxName(token.value, wire) ? /^\s*\(([^()]*)\)$/.exec(token.rest) : null
    const words = values ? values[1]!.trim().split(/\s+/).filter(Boolean) : []
    if (!values || words.length !== items.length * 2) return unreadableFolders()
    const observed: ImapMailboxStatus = {}
    for (let index = 0; index < words.length; index += 2) {
      const item = words[index]!.toUpperCase() as ImapStatusItem, raw = words[index + 1]!
      const value = /^(?:0|[1-9]\d{0,18})$/.test(raw) ? Number(raw) : Number.NaN
      if (!items.includes(item) || observed[STATUS_FIELDS[item]] !== undefined || !Number.isSafeInteger(value)) return unreadableFolders()
      observed[STATUS_FIELDS[item]] = value
    }
    if (observed.uidValidity !== undefined && !positiveMessageUid(observed.uidValidity)) return unreadableFolders()
    return observed
  }

  /** UID to RFC822.SIZE for every message of one observed generation; sizes is null above maxMessages. */
  async mailboxMessageSizes(name: string, maxMessages: number, requestedMailbox?: string, expectedUidValidity?: number): Promise<{ uidValidity: number; exists: number; sizes: Map<number, number> | null }> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), wire = mailboxWireName(name)
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) return fail('VALIDATION', 'the message measurement bound is invalid', { stateChanged: false })
    if (expectedUidValidity !== undefined && !positiveMessageUid(expectedUidValidity)) return fail('VALIDATION', 'the expected mailbox identity is invalid', { stateChanged: false })
    const state = await this.observedSelection(wire, mailbox, expectedUidValidity)
    if (state.exists > maxMessages) return { uidValidity: state.uidValidity, exists: state.exists, sizes: null }
    const sizes = new Map<number, number>()
    if (state.exists > 0) {
      const result = await this.sendCommand('UID FETCH 1:* (RFC822.SIZE)')
      if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the message sizes were not observed', { stateChanged: false, reason: 'imap_size_unavailable' })
      for (const line of result.untagged) {
        if (!/^\*\s+\d+\s+FETCH\b/i.test(line)) continue
        const view = fetchAttributeView(line), size = /\bRFC822\.SIZE\s+(0|[1-9]\d{0,15})(?=\s|\))/i.exec(view)
        // Unsolicited flag updates carry no RFC822.SIZE; the count check below still requires every message.
        if (!size) continue
        const uid = Number(/\bUID\s+([1-9]\d{0,9})(?=\s|\))/i.exec(view)?.[1] ?? Number.NaN), bytes = Number(size[1])
        if (!positiveMessageUid(uid) || sizes.has(uid) || !Number.isSafeInteger(bytes) || sizes.size >= maxMessages) return unreadableFolders()
        sizes.set(uid, bytes)
      }
    }
    const after = await this.observedSelection(wire, mailbox, state.uidValidity)
    if (sizes.size !== state.exists || after.exists !== state.exists) return fail('CONFLICT', 'the mail folder changed while it was measured', { stateChanged: false, reason: 'imap_folder_changed' })
    return { uidValidity: state.uidValidity, exists: state.exists, sizes }
  }

  /** RFC 3501 UID SEARCH with BEFORE (internal date), LARGER (octets) and SEEN, all ANDed, in one observed generation. */
  async searchMailboxUids(name: string, criteria: ImapSearchCriteria, expectedUidValidity: number | undefined, maxResults: number, requestedMailbox?: string): Promise<{ uidValidity: number; uids: number[] }> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), wire = mailboxWireName(name), keys: string[] = []
    if (!criteria || typeof criteria !== 'object' || Object.keys(criteria).some(key => !['before', 'largerThan', 'seen'].includes(key))) return fail('VALIDATION', 'the search criteria are invalid', { stateChanged: false })
    if (criteria.before !== undefined) {
      if (typeof criteria.before !== 'string' || !/^(?:[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{4}$/.test(criteria.before)) return fail('VALIDATION', 'the search date is invalid', { stateChanged: false })
      keys.push('BEFORE ' + criteria.before)
    }
    if (criteria.largerThan !== undefined) {
      if (!Number.isSafeInteger(criteria.largerThan) || criteria.largerThan < 0) return fail('VALIDATION', 'the search size is invalid', { stateChanged: false })
      keys.push('LARGER ' + criteria.largerThan)
    }
    if (criteria.seen !== undefined) {
      if (criteria.seen !== true) return fail('VALIDATION', 'the search read state is invalid', { stateChanged: false })
      keys.push('SEEN')
    }
    if (!keys.length) return fail('VALIDATION', 'at least one search criterion is required', { stateChanged: false })
    const state = await this.observedSelection(wire, mailbox, expectedUidValidity)
    const result = await this.sendCommand('UID SEARCH ' + keys.join(' '))
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail search did not complete', { stateChanged: false })
    const uids = this.parseSearchUids(result.untagged, maxResults)
    await this.observedSelection(wire, mailbox, state.uidValidity)
    return { uidValidity: state.uidValidity, uids }
  }

  private async presentUids(set: string, wanted: ReadonlySet<number>): Promise<number[]> {
    const result = await this.sendCommand('UID SEARCH UID ' + set)
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mail message presence could not be observed')
    const uids = this.parseSearchUids(result.untagged, wanted.size)
    if (uids.some(uid => !wanted.has(uid))) return fail('PRECONDITION_FAILED', 'the mail server returned an unexpected message identity')
    return uids.sort((left, right) => left - right)
  }

  private async requireExactSet(folder: string, set: string, wanted: ReadonlySet<number>, validity: number, mailbox: string): Promise<void> {
    await this.observedSelection(folder, mailbox, validity)
    if ((await this.presentUids(set, wanted)).length !== wanted.size) return fail('CONFLICT', 'the selected messages changed', { stateChanged: false, reason: 'imap_message_set_changed' })
    await this.observedSelection(folder, mailbox, validity)
  }

  private setOperationFailure(error: unknown, attempted: boolean): never {
    if (!attempted && isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
    return this.messageOperationFailure(error, attempted)
  }

  /** RFC 6851 UID MOVE of an exact observed UID set; no COPY/EXPUNGE fallback. Moved means absent from the source on re-read. */
  async moveUidSet(source: string, uids: readonly number[], target: string, expectedSourceUidValidity: number, requestedMailbox?: string, maxMessages = 5000): Promise<{ moved: number[]; remaining: number[]; accepted: boolean }> {
    let attempted = false
    try {
      const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), from = mailboxWireName(source), to = mailboxWireName(target)
      if (sameMailboxName(from, to)) return fail('VALIDATION', 'the source and destination folders must differ', { stateChanged: false })
      if (!positiveMessageUid(expectedSourceUidValidity)) return fail('VALIDATION', 'the expected mailbox identity is required', { stateChanged: false })
      const set = uidSequenceSet(uids, maxMessages), wanted = new Set(uids)
      if (!(await this.observedCapabilities()).has('MOVE')) return fail('PRECONDITION_FAILED', 'native message MOVE is unavailable', { stateChanged: false, unsupported: true, reason: 'imap_move_unsupported' })
      await this.requireExactSet(from, set, wanted, expectedSourceUidValidity, mailbox)
      attempted = true
      const result = await this.sendCommand('UID MOVE ' + set + ' ' + quoteImapString(to))
      await this.observedSelection(from, mailbox, expectedSourceUidValidity)
      const remaining = await this.presentUids(set, wanted), left = new Set(remaining)
      return { moved: [...wanted].filter(uid => !left.has(uid)).sort((a, b) => a - b), remaining, accepted: result.status === 'OK' }
    } catch (error) { return this.setOperationFailure(error, attempted) }
  }

  /** UIDPLUS (RFC 4315) permanent removal of an exact observed UID set: UID STORE \Deleted then UID EXPUNGE of that set only. */
  async expungeUidSet(folder: string, uids: readonly number[], expectedUidValidity: number, requestedMailbox?: string, maxMessages = 5000): Promise<{ removed: number[]; remaining: number[]; accepted: boolean }> {
    let attempted = false
    try {
      const mailbox = this.assertAuthenticatedMailbox(requestedMailbox), wire = mailboxWireName(folder)
      if (!positiveMessageUid(expectedUidValidity)) return fail('VALIDATION', 'the expected mailbox identity is required', { stateChanged: false })
      const set = uidSequenceSet(uids, maxMessages), wanted = new Set(uids)
      this.requireUidPlus(await this.observedCapabilities())
      await this.requireExactSet(wire, set, wanted, expectedUidValidity, mailbox)
      attempted = true
      const store = await this.sendCommand('UID STORE ' + set + ' +FLAGS.SILENT (\\Deleted)')
      if (store.status !== 'OK') return fail('PRECONDITION_FAILED', 'the deletion flags were not verified')
      await this.observedSelection(wire, mailbox, expectedUidValidity)
      const expunge = await this.sendCommand('UID EXPUNGE ' + set)
      await this.observedSelection(wire, mailbox, expectedUidValidity)
      const remaining = await this.presentUids(set, wanted), left = new Set(remaining)
      return { removed: [...wanted].filter(uid => !left.has(uid)).sort((a, b) => a - b), remaining, accepted: expunge.status === 'OK' }
    } catch (error) { return this.setOperationFailure(error, attempted) }
  }

  /** RFC 9208 (RFC 2087) GETQUOTAROOT INBOX; STORAGE usage and limit are in units of 1024 octets. */
  async quotaRootResources(requestedMailbox?: string): Promise<{ roots: string[]; resources: ImapQuotaResource[] }> {
    this.assertAuthenticatedMailbox(requestedMailbox)
    const result = await this.sendCommand('GETQUOTAROOT INBOX')
    if (result.status !== 'OK') return fail('PRECONDITION_FAILED', 'the mailbox quota was not observed', { stateChanged: false, reason: 'imap_quota_unavailable' })
    const roots: string[] = [], resources: ImapQuotaResource[] = []
    for (const line of result.untagged) {
      if (/^\*\s+QUOTAROOT\s/i.test(line)) {
        const mailbox = readMailboxToken(line.replace(/^\*\s+QUOTAROOT\s+/i, ''))
        if (!mailbox || !sameMailboxName(mailbox.value, 'INBOX')) return unreadableFolders()
        let rest = mailbox.rest
        while (rest.length) {
          const root = /^ /.test(rest) ? readMailboxToken(rest.slice(1)) : null
          if (!root || roots.length >= 16) return unreadableFolders()
          roots.push(root.value); rest = root.rest
        }
      } else if (/^\*\s+QUOTA\s/i.test(line)) {
        const root = readMailboxToken(line.replace(/^\*\s+QUOTA\s+/i, ''))
        const list = root ? /^ \(([^()]*)\)$/.exec(root.rest) : null
        const words = list ? list[1]!.trim().split(/\s+/).filter(Boolean) : []
        if (!root || !list || words.length % 3 || resources.length + words.length / 3 > 64) return unreadableFolders()
        for (let index = 0; index < words.length; index += 3) {
          const usage = /^(?:0|[1-9]\d{0,18})$/.test(words[index + 1]!) ? Number(words[index + 1]) : Number.NaN
          const limit = /^(?:0|[1-9]\d{0,18})$/.test(words[index + 2]!) ? Number(words[index + 2]) : Number.NaN
          if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(words[index]!) || !Number.isSafeInteger(usage) || !Number.isSafeInteger(limit)) return unreadableFolders()
          resources.push({ root: root.value, resource: words[index]!.toUpperCase(), usage, limit })
        }
      }
    }
    return { roots, resources }
  }

  async logout(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      try {
        await this.sendCommand('LOGOUT')
      } catch {
        // Ignore errors on close
      }
      this.socket.destroy()
    }
    this.socket = null
    this.authenticatedMailbox = null
    this.selectedFolder = null
    this.selectedUidValidity = null
  }
}
