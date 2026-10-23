import { randomUUID } from 'node:crypto'
import net from 'node:net'
import tls from 'node:tls'
import { fail } from '@xpanel/core'
import { MimeCodecAndSanitizer } from './mime.ts'
import type { MimeParseLimits, ParsedMimeAttachment, ParsedMimeMessage } from './mime.ts'

export interface ImapConnectionConfig {
  host: string
  port: number
  tls?: boolean
  rejectUnauthorized?: boolean
  timeoutMs?: number
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
  uidNext: number
  flags: string[]
  resynced: boolean
  previousUidValidity: number | null
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
const DEFAULT_ATTACHMENT_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Names and sizes from an IMAP BODYSTRUCTURE. A part counts when it carries a
 * NAME or FILENAME and an octet count. Text parts without a name stay out.
 */
export const attachmentsFromBodyStructure = (source: string): { name: string; sizeBytes: number }[] => {
  const marker = source.toUpperCase().indexOf('BODYSTRUCTURE')
  const body = marker < 0 ? source : source.slice(marker + 'BODYSTRUCTURE'.length)
  const results: { name: string; sizeBytes: number }[] = []
  const partRe = /\("([A-Za-z0-9.+-]+)"\s+"([A-Za-z0-9.+-]+)"\s+(\([^)]*\)|NIL)\s+(?:\([^)]*\)|NIL)\s+(?:\([^)]*\)|NIL)\s+"[^"]*"\s+(\d+)/gi
  let match: RegExpExecArray | null
  while ((match = partRe.exec(body)) !== null) {
    const params = match[3] ?? ''
    const name = /"(?:NAME|FILENAME)"\s+"((?:\\"|[^"])+)"/i.exec(params)?.[1]?.replace(/\\"/g, '"')
    const sizeBytes = Number.parseInt(match[4] ?? '', 10)
    if (!name || !Number.isFinite(sizeBytes) || sizeBytes < 0) continue
    if (match[1]?.toLowerCase() === 'text' && !/name|filename/i.test(params)) continue
    results.push({ name, sizeBytes })
  }
  return results
}

const quoteImapString = (val: string): string => {
  if (/[\r\n\u0000]/.test(val)) {
    fail('VALIDATION', 'IMAP string contains forbidden CR/LF/NUL characters')
  }
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * M02 ImapProtocolClient:
 * Real RFC 3501 IMAP4rev1 wire-protocol client over TCP/TLS sockets with:
 * - Strict authenticated mailbox principal binding (A08)
 * - Per-folder `UIDVALIDITY` tracking and automatic cache invalidation + resync on change
 * - `LOGIN`, `LIST`, `SELECT`, `UID FETCH`, `UID STORE`, `UID COPY`, `UID MOVE`, `UID SEARCH CHARSET UTF-8`, `APPEND`, `LOGOUT`
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
    this.config = config
    this.mime = mime
  }

  get currentMailbox(): string | null {
    return this.authenticatedMailbox
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
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        this.socket?.destroy()
        reject(new Error(`IMAP connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const cleanup = (): void => {
        clearTimeout(timer)
        this.socket?.removeListener('error', onError)
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

      this.socket.on('error', onError)
      this.socket.on('data', (chunk: Buffer) => {
        this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk])
        if (this.pendingWaiter) {
          const w = this.pendingWaiter
          this.pendingWaiter = null
          w.resolve()
        }
      })
      this.socket.on('close', () => {
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
    let uidNext = 1
    let flags: string[] = []

    for (const line of res.untagged) {
      const existsMatch = /^\*\s+(\d+)\s+EXISTS/i.exec(line)
      if (existsMatch) exists = Number.parseInt(existsMatch[1]!, 10)

      const recentMatch = /^\*\s+(\d+)\s+RECENT/i.exec(line)
      if (recentMatch) recent = Number.parseInt(recentMatch[1]!, 10)

      const uvMatch = /\[UIDVALIDITY\s+(\d+)\]/i.exec(line)
      if (uvMatch) uidValidity = Number.parseInt(uvMatch[1]!, 10)

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
      const uidMatch = /\bUID\s+(\d+)/i.exec(firstLine)
      const flagsMatch = /\bFLAGS\s+\(([^)]*)\)/i.exec(firstLine)
      const dateMatch = /\bINTERNALDATE\s+"([^"]*)"/i.exec(firstLine)
      const sizeMatch = /\bRFC822\.SIZE\s+(\d+)/i.exec(firstLine)
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
      const sizeBytes = sizeMatch ? Number.parseInt(sizeMatch[1]!, 10) : Buffer.byteLength(rawMime, 'utf8')

      const parsed = this.mime.parseMimeMessage(rawMime, options.mimeLimits)
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

  /**
   * Updates flags on a message by UID (`UID STORE <uid> +FLAGS.SILENT / -FLAGS.SILENT / FLAGS.SILENT`).
   */
  async searchAllUids(folder: string, requestedMailbox?: string): Promise<number[]> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    if (this.selectedFolder !== folder) await this.selectFolder(folder, mailbox)
    const res = await this.sendCommand('UID SEARCH ALL')
    if (res.status !== 'OK') fail('PRECONDITION_FAILED', `IMAP UID SEARCH failed: ${res.statusText}`)
    const line = res.untagged.find(item => /^\*\s+SEARCH\b/i.test(item)) ?? ''
    return line.replace(/^\*\s+SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean)
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isSafeInteger(value) && value > 0)
  }

  async deleteByUid(folder: string, uid: number, requestedMailbox?: string): Promise<void> {
    if (!Number.isSafeInteger(uid) || uid <= 0) fail('VALIDATION', 'message uid is invalid')
    await this.storeFlagsByUid(folder, uid, 'add', ['\\Deleted'], requestedMailbox)
    const res = await this.sendCommand('EXPUNGE')
    if (res.status !== 'OK') fail('PRECONDITION_FAILED', `IMAP EXPUNGE failed: ${res.statusText}`)
  }

  async storeFlagsByUid(
    folder: string,
    uid: number,
    mode: 'add' | 'remove' | 'set',
    flags: readonly string[],
    requestedMailbox?: string,
  ): Promise<void> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    if (this.selectedFolder !== folder) {
      await this.selectFolder(folder, mailbox)
    }
    const cleanFlags = flags.map((f) => {
      if (!/^\\?[A-Za-z0-9_-]+$/.test(f)) fail('VALIDATION', `invalid IMAP flag "${f}"`)
      return f
    })
    const action =
      mode === 'add' ? '+FLAGS.SILENT' : mode === 'remove' ? '-FLAGS.SILENT' : 'FLAGS.SILENT'
    const res = await this.sendCommand(`UID STORE ${uid} ${action} (${cleanFlags.join(' ')})`)
    if (res.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP UID STORE failed: ${res.statusText}`)
    }
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
  ): Promise<void> {
    const mailbox = this.assertAuthenticatedMailbox(requestedMailbox)
    if (this.selectedFolder !== sourceFolder) {
      await this.selectFolder(sourceFolder, mailbox)
    }
    if (operation === 'copy') {
      const res = await this.sendCommand(`UID COPY ${uid} ${quoteImapString(targetFolder)}`)
      if (res.status !== 'OK') {
        fail('PRECONDITION_FAILED', `IMAP UID COPY failed: ${res.statusText}`)
      }
      return
    }

    const moveRes = await this.sendCommand(`UID MOVE ${uid} ${quoteImapString(targetFolder)}`)
    if (moveRes.status === 'OK') {
      return
    }
    // Fallback to UID COPY + UID STORE \Deleted + EXPUNGE
    const copyRes = await this.sendCommand(`UID COPY ${uid} ${quoteImapString(targetFolder)}`)
    if (copyRes.status !== 'OK') {
      fail('PRECONDITION_FAILED', `IMAP UID MOVE/COPY failed: ${copyRes.statusText}`)
    }
    await this.storeFlagsByUid(sourceFolder, uid, 'add', ['\\Deleted'], mailbox)
    await this.sendCommand('EXPUNGE')
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
      const allRes = await this.sendCommand('UID SEARCH ALL')
      return this.parseSearchUids(allRes.untagged)
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

  private parseSearchUids(untaggedLines: readonly string[]): number[] {
    const uids: number[] = []
    for (const line of untaggedLines) {
      const m = /^\*\s+SEARCH(?:\s+(.*))?$/i.exec(line)
      if (m && m[1]) {
        for (const token of m[1].trim().split(/\s+/)) {
          const n = Number.parseInt(token, 10)
          if (!Number.isNaN(n)) uids.push(n)
        }
      }
    }
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
  ): Promise<{ appendedUid: number | null; statusText: string }> {
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
    const appendUidMatch = /\[APPENDUID\s+\d+\s+(\d+)\]/i.exec(res.statusText)
    const appendedUid = appendUidMatch ? Number.parseInt(appendUidMatch[1]!, 10) : null
    return { appendedUid, statusText: res.statusText }
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
