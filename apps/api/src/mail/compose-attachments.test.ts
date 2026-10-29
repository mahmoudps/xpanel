import { describe, expect, it } from 'vitest'
import { COMPOSE_ATTACHMENT_LIMITS } from '@xpanel/core'
import { MimeCodecAndSanitizer } from './mime.ts'
import { ComposeAttachmentValidationError, prepareComposeAttachments } from './compose-attachments.ts'

const file = (bytes = Buffer.from([0, 255, 128, 13, 10]), filename = 'report.bin', contentType = 'application/octet-stream') => ({ filename, contentType, contentBase64: bytes.toString('base64') })

describe('shared Send and Save draft attachment byte validation', () => {
  it('preserves actual binary bytes through the authoritative MIME builder and parser', () => {
    const input = file(), prepared = prepareComposeAttachments([input], { to: ['recipient@example.test'], subject: 'Files', text: 'Attached' })
    expect(prepared.decodedBytes).toBe(5)
    expect(prepared.payload).toEqual([input])
    expect(prepared.attachments[0]!.content).toEqual(Buffer.from([0, 255, 128, 13, 10]))
    const codec = new MimeCodecAndSanitizer()
    const { rawMime: raw } = codec.buildMimeMessage({ from: 'sender@example.test', to: ['recipient@example.test'], subject: 'Files', textBody: 'Attached', attachments: prepared.attachments })
    const parsed = codec.parseMimeMessage(Buffer.from(raw, 'utf8'))
    expect(parsed.attachments[0]!.content).toEqual(prepared.attachments[0]!.content)
    expect(Object.isFrozen(prepared.payload[0])).toBe(true)
  })
  it('supports missing attachments and a real zero-byte file', () => {
    expect(prepareComposeAttachments(undefined).attachments).toEqual([])
    expect(prepareComposeAttachments([file(Buffer.alloc(0))]).decodedBytes).toBe(0)
  })
  it.each([null, {}, 'metadata', [{ filename: 'x.bin', contentType: 'application/octet-stream' }], [{ ...file(), sizeBytes: 5 }]])('rejects metadata-only or alternate DTO shapes', input => {
    expect(() => prepareComposeAttachments(input)).toThrow(ComposeAttachmentValidationError)
  })
  it.each(['AA', 'AA=', 'AA===', 'AA==\n', 'AA-_', 'AB==', 'AAB=', 'data:;base64,AA==', '===='])('rejects noncanonical base64 %s', encoded => {
    expect(() => prepareComposeAttachments([{ ...file(), contentBase64: encoded }])).toThrow(ComposeAttachmentValidationError)
  })
  it.each(['../x', 'a\\b', 'a\r\nb', 'a"b', 'a:b', '\u202efile.pdf', ' x.txt', '..', '\ud800', 'ع'.repeat(128)])('rejects unsafe or oversized filenames', name => {
    expect(() => prepareComposeAttachments([file(undefined, name)])).toThrow(ComposeAttachmentValidationError)
  })
  it.each(['text/html; charset=utf-8', 'text/plain\r\nx:y', 'TEXT/PLAIN', 'text', 'a/'.padEnd(128, 'b')])('rejects unsafe MIME header values', type => {
    expect(() => prepareComposeAttachments([file(undefined, undefined, type)])).toThrow(ComposeAttachmentValidationError)
  })
  it('enforces file count and the decoded aggregate boundary exactly', () => {
    expect(prepareComposeAttachments(Array.from({ length: 10 }, () => file(Buffer.alloc(0)))).attachments).toHaveLength(10)
    expect(() => prepareComposeAttachments(Array.from({ length: 11 }, () => file(Buffer.alloc(0))))).toThrow(ComposeAttachmentValidationError)
    expect(prepareComposeAttachments([file(Buffer.alloc(COMPOSE_ATTACHMENT_LIMITS.maxDecodedBytes))]).decodedBytes).toBe(524288)
    expect(() => prepareComposeAttachments([file(Buffer.alloc(524288)), file(Buffer.from([1]))])).toThrow(ComposeAttachmentValidationError)
    expect(() => prepareComposeAttachments([file(Buffer.alloc(524289))])).toThrow(ComposeAttachmentValidationError)
  })
  it('measures the exact UTF-8 aggregate JSON including Draft metadata and escaped text', () => {
    const attachments = [file()], body = { text: '\\'.repeat(200000), expectedDraft: { folder: 'Drafts', uid: 7, uidValidity: 12 } }
    expect(prepareComposeAttachments(attachments, body).decodedBytes).toBe(5)
    expect(() => prepareComposeAttachments(attachments, { text: 'ع'.repeat(600000) })).toThrow(ComposeAttachmentValidationError)
    expect(() => prepareComposeAttachments(attachments, { text: '\\'.repeat(600000) })).toThrow(ComposeAttachmentValidationError)
    const overhead = Buffer.byteLength(JSON.stringify({ text: '', attachments }))
    expect(() => prepareComposeAttachments(attachments, { text: 'x'.repeat(1048576 - overhead) })).not.toThrow()
    expect(() => prepareComposeAttachments(attachments, { text: 'x'.repeat(1048577 - overhead) })).toThrow(ComposeAttachmentValidationError)
  })
})
