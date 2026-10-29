import { COMPOSE_ATTACHMENT_LIMITS, type ComposeAttachmentPayload } from '@xpanel/core'
import type { MimeAttachmentInput } from './mime.ts'

export class ComposeAttachmentValidationError extends Error {
  readonly status: 400 | 413
  constructor(message: string, status: 400 | 413 = 400) {
    super(message)
    this.name = 'ComposeAttachmentValidationError'
    this.status = status
  }
}

export interface PreparedComposeAttachments {
  readonly payload: readonly ComposeAttachmentPayload[]
  readonly attachments: readonly MimeAttachmentInput[]
  readonly decodedBytes: number
}

/** The single trusted byte validator used by both SMTP Send and IMAP Save draft. */
export function prepareComposeAttachments(input: unknown, requestPayload?: Readonly<Record<string, unknown>>): PreparedComposeAttachments {
  const limits = COMPOSE_ATTACHMENT_LIMITS
  const invalid = (message = 'Attachments must contain valid file bytes.'): never => { throw new ComposeAttachmentValidationError(message) }
  const tooLarge = (message: string): never => { throw new ComposeAttachmentValidationError(message, 413) }
  const values = input === undefined ? [] : input
  if (!Array.isArray(values)) return invalid()
  if (values.length > limits.maxFiles) return tooLarge('A message supports at most 10 attachments.')
  const payload: ComposeAttachmentPayload[] = [], attachments: MimeAttachmentInput[] = []
  let decodedBytes = 0
  const maximumEncodedLength = 4 * Math.ceil(limits.maxDecodedBytes / 3)
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
    const item = value as Record<string, unknown>
    if (Object.keys(item).length !== 3 || !['filename', 'contentType', 'contentBase64'].every(key => Object.prototype.hasOwnProperty.call(item, key))) return invalid()
    const { filename, contentType, contentBase64 } = item
    if (typeof filename !== 'string' || !filename || filename !== filename.trim() || filename === '.' || filename === '..' ||
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\\/:*?"<>|]/u.test(filename) ||
      Buffer.byteLength(filename, 'utf8') > limits.maxFilenameBytes || Buffer.from(filename, 'utf8').toString('utf8') !== filename) return invalid('An attachment filename is invalid.')
    if (typeof contentType !== 'string' || contentType.length > limits.maxContentTypeLength ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) return invalid('An attachment content type is invalid.')
    if (typeof contentBase64 !== 'string') return invalid()
    if (contentBase64.length > maximumEncodedLength) return tooLarge('Attachments exceed the 512 KiB total file limit.')
    if (contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) return invalid('An attachment encoding is invalid.')
    const bytes = Buffer.from(contentBase64, 'base64')
    if (bytes.toString('base64') !== contentBase64) return invalid('An attachment encoding is not canonical.')
    decodedBytes += bytes.byteLength
    if (decodedBytes > limits.maxDecodedBytes) return tooLarge('Attachments exceed the 512 KiB total file limit.')
    const canonical: ComposeAttachmentPayload = Object.freeze({ filename, contentType, contentBase64 })
    payload.push(canonical)
    attachments.push(Object.freeze({ filename, contentType, content: bytes }))
  }
  let serialized: string
  try { serialized = JSON.stringify({ ...requestPayload, attachments: payload }) }
  catch { return invalid('The message request cannot be encoded.') }
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxRequestBytes) return tooLarge('The complete message request exceeds 1 MiB.')
  return Object.freeze({ payload: Object.freeze(payload), attachments: Object.freeze(attachments), decodedBytes })
}
