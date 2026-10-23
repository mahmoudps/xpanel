import net from 'node:net'
import tls from 'node:tls'
import { fail, type ErrorCode } from '@xpanel/core'
import { MimeCodecAndSanitizer } from './mime.ts'
import type { MimeAttachmentInput } from './mime.ts'

export interface SmtpConnectionConfig {
  host: string
  port: number
  /** Implicit TLS (SMTPS). Mutually exclusive with `starttls`. */
  tls?: boolean
  /** Upgrade with STARTTLS before AUTH. Required when submission sets smtpd_tls_auth_only. */
  starttls?: boolean
  rejectUnauthorized?: boolean
  clientHostname?: string
  timeoutMs?: number
}

export type DraftSubmissionPhase =
  | 'preparing'
  | 'failed_before_data'
  | 'data_transmitted_awaiting_ack'
  | 'accepted_by_mta'

export interface DraftSubmissionStateRecord {
  idempotencyKey: string
  mailbox: string
  messageId: string
  phase: DraftSubmissionPhase
  mtaQueueId: string | null
  smtpCode: number | null
  smtpMessage: string | null
  updatedAt: string
}

export interface SmtpSendInput {
  idempotencyKey: string
  /** Authenticated mailbox principal */
  authenticatedMailbox: string
  /** Optional list of verified alias/identity addresses owned by `authenticatedMailbox` */
  authorizedIdentities?: readonly string[]
  from: string
  fromName?: string
  replyTo?: string
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  textBody?: string
  htmlBody?: string
  attachments?: readonly MimeAttachmentInput[]
  messageId?: string
}

export interface SmtpSubmissionResult {
  idempotencyKey: string
  submissionStatus: 'accepted_by_mta'
  mtaQueueId: string
  messageId: string
  smtpCode: number
  smtpBanner: string
  acceptedRecipients: string[]
  rejectedRecipients: { recipient: string; code: number; message: string }[]
  rawMime: string
}

const DEFAULT_SMTP_TIMEOUT_MS = 15_000

/** SNI is omitted for an IP. Node rejects `servername` when the host is an address. */
export const tlsServerName = (host: string): string | undefined => (net.isIP(host) === 0 ? host : undefined)

export const tlsConnectOptions = (host: string, extra: tls.ConnectionOptions): tls.ConnectionOptions => {
  const servername = tlsServerName(host)
  return servername === undefined ? extra : { ...extra, servername }
}

export interface SmtpHumanCopy {
  en: string
  ar: string
}

/** A stable sentence for the person sending mail. The raw SMTP or TLS text stays off the response. */
export const smtpHumanCopy = (raw: string): SmtpHumanCopy => {
  const text = raw.toLowerCase()
  if (text.includes('servername') && text.includes('ip address')) {
    return {
      en: 'A secure mail connection cannot use an IP address as the server name.',
      ar: 'لا يمكن لاتصال البريد الآمن أن يستخدم عنوان IP كاسم للخادم.',
    }
  }
  if (/timed out|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|socket closed|econn/.test(text)) {
    return { en: 'the mail server could not be reached.', ar: 'تعذر الوصول إلى خادم البريد.' }
  }
  if (/\bauth\b/.test(text)) {
    return { en: 'The mailbox could not sign in to send mail.', ar: 'تعذر تسجيل دخول صندوق البريد لإرسال البريد.' }
  }
  if (/mail from|rcpt|recipient|rejected|starttls|ehlo|greeting|\bdata\b/.test(text)) {
    return { en: 'The mail server refused the message.', ar: 'رفض خادم البريد الرسالة.' }
  }
  return { en: 'The message could not be sent.', ar: 'تعذر إرسال الرسالة.' }
}

const smtpFail = (code: ErrorCode, raw: string, detail?: Record<string, unknown>): never => {
  const copy = smtpHumanCopy(raw)
  return fail(code, copy.en, { ...detail, messageAr: copy.ar })
}

const extractAddress = (raw: string): string => {
  const trimmed = raw.trim()
  const angle = /<([^>]+)>/.exec(trimmed)
  return (angle ? angle[1]! : trimmed).trim().toLowerCase()
}

const dotStuffMime = (rawMime: string): string => {
  const normalized = rawMime.replace(/\r?\n/g, '\r\n')
  const stuffed = normalized.replace(/(^|\r\n)\./g, '$1..')
  return stuffed.endsWith('\r\n') ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`
}

/**
 * M02 SmtpSubmissionClient:
 * Real RFC 5321 / RFC 4954 SMTP submission client over TCP/TLS sockets with:
 * - `EHLO`, `AUTH PLAIN`, `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT`
 * - Strict sender identity & alias ownership enforcement (A08, A42)
 * - Idempotent draft submission state machine that prevents blind resends on post-DATA timeout
 * - Real MTA queue ID extraction from `250 2.0.0 Ok: queued as <QUEUE_ID>`
 */
export class SmtpSubmissionClient {
  private readonly config: SmtpConnectionConfig
  private readonly mime: MimeCodecAndSanitizer
  private readonly submissionLedger = new Map<string, DraftSubmissionStateRecord>()

  constructor(config: SmtpConnectionConfig, mime = new MimeCodecAndSanitizer()) {
    this.config = config
    this.mime = mime
  }

  getSubmissionState(idempotencyKey: string): DraftSubmissionStateRecord | null {
    return this.submissionLedger.get(idempotencyKey) ?? null
  }

  /**
   * Verifies that `from` is either the authenticated mailbox itself or an explicitly
   * authorized alias/identity belonging to that mailbox.
   */
  assertSenderAuthorized(
    authenticatedMailbox: string,
    requestedFrom: string,
    authorizedIdentities: readonly string[] = [],
  ): { mailbox: string; senderAddress: string } {
    const mailbox = authenticatedMailbox.trim().toLowerCase()
    const senderAddress = extractAddress(requestedFrom)
    if (!mailbox.includes('@') || !senderAddress.includes('@')) {
      fail('VALIDATION', 'authenticatedMailbox and from must be valid email addresses')
    }
    if (/[\r\n\u0000]/.test(senderAddress)) {
      fail('VALIDATION', 'sender address contains forbidden control characters')
    }

    const allowedSet = new Set<string>([
      mailbox,
      ...authorizedIdentities.map((id) => extractAddress(id)),
    ])

    if (!allowedSet.has(senderAddress)) {
      fail(
        'FORBIDDEN',
        `sender identity "${senderAddress}" is not authorized for mailbox "${mailbox}"`,
        {
          authenticatedMailbox: mailbox,
          attemptedSender: senderAddress,
        },
      )
    }
    return { mailbox, senderAddress }
  }

  /**
   * Connects to the SMTP submission server, authenticates via `AUTH PLAIN`,
   * enforces sender ownership and idempotency state, and submits the message via `DATA`.
   */
  async submitMessage(
    credentials: { username: string; password: string },
    input: SmtpSendInput,
  ): Promise<SmtpSubmissionResult> {
    if (!input.idempotencyKey || input.idempotencyKey.trim().length === 0) {
      fail('VALIDATION', 'idempotencyKey is required for SMTP draft submission')
    }
    const idempotencyKey = input.idempotencyKey.trim()

    const { mailbox, senderAddress } = this.assertSenderAuthorized(
      input.authenticatedMailbox,
      input.from,
      input.authorizedIdentities,
    )

    if (credentials.username.trim().toLowerCase() !== mailbox) {
      fail('FORBIDDEN', 'SMTP credentials username must match the authenticated mailbox principal')
    }

    // Check existing submission state for idempotency / post-DATA timeout safety
    const existing = this.submissionLedger.get(idempotencyKey)
    if (existing) {
      if (existing.mailbox !== mailbox) {
        fail('FORBIDDEN', 'idempotencyKey belongs to a different mailbox principal')
      }
      if (existing.phase === 'data_transmitted_awaiting_ack') {
        fail(
          'CONFLICT',
          'SMTP DATA was already transmitted before timeout; refusing blind resend to prevent duplicate delivery',
          {
            idempotencyKey,
            phase: existing.phase,
            messageId: existing.messageId,
          },
        )
      }
      if (existing.phase === 'accepted_by_mta' && existing.mtaQueueId) {
        fail('CONFLICT', 'draft was already accepted by the MTA', {
          idempotencyKey,
          phase: existing.phase,
          mtaQueueId: existing.mtaQueueId,
          messageId: existing.messageId,
        })
      }
    }

    const allRecipients = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ]
      .map((r) => extractAddress(r))
      .filter(Boolean)

    if (allRecipients.length === 0) {
      fail('VALIDATION', 'at least one recipient is required')
    }
    for (const rcpt of allRecipients) {
      if (!rcpt.includes('@') || /[\r\n\u0000]/.test(rcpt)) {
        fail('VALIDATION', `invalid recipient address "${rcpt}"`)
      }
    }

    const built = this.mime.buildMimeMessage({
      from: senderAddress,
      fromName: input.fromName,
      replyTo: input.replyTo,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      attachments: input.attachments,
      messageId: input.messageId,
    })

    // Double-check the built MIME From header matches senderAddress
    const parsedCheck = this.mime.parseMimeMessage(built.rawMime)
    if (parsedCheck.from !== senderAddress) {
      fail('FORBIDDEN', 'MIME From header mismatch with authorized sender address')
    }

    this.submissionLedger.set(idempotencyKey, {
      idempotencyKey,
      mailbox,
      messageId: built.messageId,
      phase: 'preparing',
      mtaQueueId: null,
      smtpCode: null,
      smtpMessage: null,
      updatedAt: new Date().toISOString(),
    })

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS
    let socket: net.Socket | tls.TLSSocket | null = null
    let receiveBuffer = Buffer.alloc(0)
    let pendingWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null

    const waitForData = (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWaiter = null
          reject(new Error(`SMTP read timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pendingWaiter = {
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

    const readLine = async (): Promise<string> => {
      while (true) {
        const nlIdx = receiveBuffer.indexOf(0x0a)
        if (nlIdx >= 0) {
          const lineBuf = receiveBuffer.subarray(0, nlIdx + 1)
          receiveBuffer = receiveBuffer.subarray(nlIdx + 1)
          return lineBuf.toString('utf8').replace(/\r?\n$/, '')
        }
        await waitForData()
      }
    }

    const readSmtpResponse = async (): Promise<{ code: number; lines: string[]; message: string }> => {
      const lines: string[] = []
      while (true) {
        const line = await readLine()
        lines.push(line)
        const m = /^(\d{3})([ -])(.*)$/.exec(line)
        if (!m) {
          throw new Error(`Malformed SMTP response line: ${line}`)
        }
        if (m[2] === ' ') {
          return {
            code: Number.parseInt(m[1]!, 10),
            lines,
            message: lines.map((l) => l.slice(4)).join('\n'),
          }
        }
      }
    }

    const sendLine = (line: string): void => {
      if (!socket || socket.destroyed) {
        throw new Error('SMTP socket is closed')
      }
      socket.write(`${line}\r\n`)
    }

    const attachIo = (target: net.Socket | tls.TLSSocket): void => {
      target.on('error', (err) => {
        if (pendingWaiter) {
          const w = pendingWaiter
          pendingWaiter = null
          w.reject(err)
        }
      })
      target.on('data', (chunk: Buffer) => {
        receiveBuffer = Buffer.concat([receiveBuffer, chunk])
        if (pendingWaiter) {
          const w = pendingWaiter
          pendingWaiter = null
          w.resolve()
        }
      })
      target.on('close', () => {
        if (pendingWaiter) {
          const w = pendingWaiter
          pendingWaiter = null
          w.reject(new Error('SMTP socket closed unexpectedly'))
        }
      })
    }

    try {
      socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`SMTP connect timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        const onConnect = (s: net.Socket | tls.TLSSocket): void => {
          clearTimeout(timer)
          resolve(s)
        }
        const s = this.config.tls
          ? tls.connect(
              tlsConnectOptions(this.config.host, {
                host: this.config.host,
                port: this.config.port,
                rejectUnauthorized: this.config.rejectUnauthorized ?? true,
              }),
              () => onConnect(s),
            )
          : net.connect({ host: this.config.host, port: this.config.port }, () => onConnect(s))

        s.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        attachIo(s)
      })

      const greeting = await readSmtpResponse()
      if (greeting.code !== 220) {
        throw new Error(`Unexpected SMTP greeting (${greeting.code}): ${greeting.message}`)
      }

      const ehloHost = this.config.clientHostname ?? 'webmail.xpanel.internal'
      sendLine(`EHLO ${ehloHost}`)
      const ehloRes = await readSmtpResponse()
      if (ehloRes.code !== 250) {
        throw new Error(`SMTP EHLO failed (${ehloRes.code}): ${ehloRes.message}`)
      }

      if (this.config.starttls) {
        if (this.config.tls) throw new Error('SMTP STARTTLS is not used on an implicit TLS connection')
        if (!ehloRes.lines.some((line) => /^250[- ]STARTTLS$/i.test(line))) {
          throw new Error('SMTP server does not advertise STARTTLS')
        }
        sendLine('STARTTLS')
        const ready = await readSmtpResponse()
        if (ready.code !== 220) throw new Error(`SMTP STARTTLS refused (${ready.code}): ${ready.message}`)
        const plain = socket
        if (!plain) throw new Error('SMTP socket is closed')
        plain.removeAllListeners('data')
        plain.removeAllListeners('error')
        plain.removeAllListeners('close')
        const loopback = this.config.host === '127.0.0.1' || this.config.host === '::1' || this.config.host === 'localhost'
        const secure = tls.connect(tlsConnectOptions(this.config.host, {
          socket: plain,
          rejectUnauthorized: this.config.rejectUnauthorized ?? !loopback,
        }))
        socket = secure
        attachIo(secure)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`SMTP STARTTLS timed out after ${timeoutMs}ms`)), timeoutMs)
          secure.once('secureConnect', () => {
            clearTimeout(timer)
            resolve()
          })
          secure.once('error', (err) => {
            clearTimeout(timer)
            reject(err)
          })
        })
        sendLine(`EHLO ${ehloHost}`)
        const secured = await readSmtpResponse()
        if (secured.code !== 250) {
          throw new Error(`SMTP EHLO after STARTTLS failed (${secured.code}): ${secured.message}`)
        }
      }

      // Authenticate using SASL PLAIN (\0username\0password)
      const authPlainToken = Buffer.from(
        `\u0000${mailbox}\u0000${credentials.password}`,
        'utf8',
      ).toString('base64')
      sendLine(`AUTH PLAIN ${authPlainToken}`)
      const authRes = await readSmtpResponse()
      if (authRes.code !== 235) {
        this.submissionLedger.set(idempotencyKey, {
          idempotencyKey,
          mailbox,
          messageId: built.messageId,
          phase: 'failed_before_data',
          mtaQueueId: null,
          smtpCode: authRes.code,
          smtpMessage: authRes.message,
          updatedAt: new Date().toISOString(),
        })
        smtpFail('UNAUTHENTICATED', `SMTP AUTH PLAIN failed (${authRes.code})`)
      }

      sendLine(`MAIL FROM:<${senderAddress}>`)
      const mailFromRes = await readSmtpResponse()
      if (mailFromRes.code !== 250) {
        this.submissionLedger.set(idempotencyKey, {
          idempotencyKey,
          mailbox,
          messageId: built.messageId,
          phase: 'failed_before_data',
          mtaQueueId: null,
          smtpCode: mailFromRes.code,
          smtpMessage: mailFromRes.message,
          updatedAt: new Date().toISOString(),
        })
        smtpFail('FORBIDDEN', `SMTP MAIL FROM rejected (${mailFromRes.code})`)
      }

      const acceptedRecipients: string[] = []
      const rejectedRecipients: { recipient: string; code: number; message: string }[] = []

      for (const rcpt of allRecipients) {
        sendLine(`RCPT TO:<${rcpt}>`)
        const rcptRes = await readSmtpResponse()
        if (rcptRes.code >= 200 && rcptRes.code < 300) {
          acceptedRecipients.push(rcpt)
        } else {
          rejectedRecipients.push({
            recipient: rcpt,
            code: rcptRes.code,
            message: rcptRes.message,
          })
        }
      }

      if (acceptedRecipients.length === 0) {
        const firstRej = rejectedRecipients[0]
        this.submissionLedger.set(idempotencyKey, {
          idempotencyKey,
          mailbox,
          messageId: built.messageId,
          phase: 'failed_before_data',
          mtaQueueId: null,
          smtpCode: firstRej?.code ?? 550,
          smtpMessage: firstRej?.message ?? 'All recipients rejected',
          updatedAt: new Date().toISOString(),
        })
        smtpFail('VALIDATION', `SMTP recipients rejected (${firstRej?.code ?? 550})`, {
          rejectedCount: rejectedRecipients.length,
        })
      }

      sendLine('DATA')
      const dataPrompt = await readSmtpResponse()
      if (dataPrompt.code !== 354) {
        this.submissionLedger.set(idempotencyKey, {
          idempotencyKey,
          mailbox,
          messageId: built.messageId,
          phase: 'failed_before_data',
          mtaQueueId: null,
          smtpCode: dataPrompt.code,
          smtpMessage: dataPrompt.message,
          updatedAt: new Date().toISOString(),
        })
        smtpFail('PRECONDITION_FAILED', `SMTP DATA rejected (${dataPrompt.code})`)
      }

      // Mark phase BEFORE writing final dot-terminated DATA so a post-DATA timeout is never blindly resent
      this.submissionLedger.set(idempotencyKey, {
        idempotencyKey,
        mailbox,
        messageId: built.messageId,
        phase: 'data_transmitted_awaiting_ack',
        mtaQueueId: null,
        smtpCode: null,
        smtpMessage: null,
        updatedAt: new Date().toISOString(),
      })

      socket.write(dotStuffMime(built.rawMime))
      const dataAck = await readSmtpResponse()

      if (dataAck.code !== 250) {
        this.submissionLedger.set(idempotencyKey, {
          idempotencyKey,
          mailbox,
          messageId: built.messageId,
          phase: 'failed_before_data',
          mtaQueueId: null,
          smtpCode: dataAck.code,
          smtpMessage: dataAck.message,
          updatedAt: new Date().toISOString(),
        })
        smtpFail('PRECONDITION_FAILED', `SMTP DATA payload rejected (${dataAck.code})`)
      }

      const queueMatch = /\bqueued as ([A-Za-z0-9_-]{6,32})/i.exec(dataAck.message)
      const mtaQueueId = queueMatch ? queueMatch[1]! : `MTAQ_${Date.now().toString(36).toUpperCase()}`

      this.submissionLedger.set(idempotencyKey, {
        idempotencyKey,
        mailbox,
        messageId: built.messageId,
        phase: 'accepted_by_mta',
        mtaQueueId,
        smtpCode: dataAck.code,
        smtpMessage: dataAck.message,
        updatedAt: new Date().toISOString(),
      })

      try {
        sendLine('QUIT')
        await readSmtpResponse()
      } catch {
        // Ignore QUIT close errors
      }
      socket.destroy()

      return {
        idempotencyKey,
        submissionStatus: 'accepted_by_mta',
        mtaQueueId,
        messageId: built.messageId,
        smtpCode: dataAck.code,
        smtpBanner: dataAck.message,
        acceptedRecipients,
        rejectedRecipients,
        rawMime: built.rawMime,
      }
    } catch (err) {
      socket?.destroy()
      const current = this.submissionLedger.get(idempotencyKey)
      if (current && current.phase === 'preparing') {
        this.submissionLedger.set(idempotencyKey, {
          ...current,
          phase: 'failed_before_data',
          updatedAt: new Date().toISOString(),
        })
      }
      throw err
    }
  }
}
