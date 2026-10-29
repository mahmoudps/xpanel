import { describe, expect, it } from 'vitest'
import { MimeCodecAndSanitizer, type MimeBuildInput } from './mime.ts'

const codec = new MimeCodecAndSanitizer()
const draft = (): MimeBuildInput => ({ from: 'owner@example.test', to: [], subject: '', textBody: 'Unfinished body' })
const headers = (raw: string) => raw.split('\r\n\r\n')[0]!

describe('trusted empty-To MIME building', () => {
  it('keeps the default and explicit false strict even when Cc is present', () => {
    expect(() => codec.buildMimeMessage(draft())).toThrow('at least one To recipient')
    expect(() => codec.buildMimeMessage(draft(), { allowEmptyTo: false })).toThrow('at least one To recipient')
    expect(() => codec.buildMimeMessage({ ...draft(), cc: ['copy@example.test'] })).toThrow('at least one To recipient')
    expect(() => codec.buildMimeMessage({ ...draft(), allowEmptyTo: true } as MimeBuildInput)).toThrow('at least one To recipient')
  })
  it('builds a real body-only draft without an invented To header and returns its actual identity', () => {
    const result = codec.buildMimeMessage(draft(), { allowEmptyTo: true })
    expect(headers(result.rawMime)).not.toMatch(/^To:/mi)
    expect(result.rawMime).not.toContain('undisclosed-recipients')
    expect(result.rawMime).toContain('Message-ID: ' + result.messageId)
    expect(codec.parseMimeMessage(Buffer.from(result.rawMime)).textBody).toBe('Unfinished body')
  })
  it('keeps Cc-only content and omits Bcc from a MIME message built for a separately validated private envelope', () => {
    const { rawMime } = codec.buildMimeMessage({ ...draft(), cc: ['copy@example.test'] }, { allowEmptyTo: true })
    expect(headers(rawMime)).toContain('Cc: copy@example.test')
    expect(headers(rawMime)).not.toMatch(/^(?:To|Bcc):/mi)
  })
  it('permits a private draft Bcc header only when the trusted draft caller explicitly supplies it', () => {
    const { rawMime } = codec.buildMimeMessage({ ...draft(), extraHeaders: { Bcc: 'private@example.test' } }, { allowEmptyTo: true })
    expect(headers(rawMime)).not.toMatch(/^To:/mi)
    expect(codec.parseMimeMessage(Buffer.from(rawMime)).headers.bcc).toBe('private@example.test')
    const sent = codec.buildMimeMessage(draft(), { allowEmptyTo: true })
    expect(headers(sent.rawMime)).not.toMatch(/^Bcc:/mi)
    expect(sent.rawMime).not.toContain('private@example.test')
  })
  it('preserves real To values and actual file bytes when the trusted option is enabled', () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10])
    const { rawMime } = codec.buildMimeMessage({ ...draft(), to: ['recipient@example.test'], attachments: [{ filename: 'bytes.bin', contentType: 'application/octet-stream', content: bytes }] }, { allowEmptyTo: true })
    expect(headers(rawMime)).toContain('To: recipient@example.test')
    expect(codec.parseMimeMessage(Buffer.from(rawMime)).attachments[0]!.content).toEqual(bytes)
  })
  it('does not let the trusted option substitute a missing or malformed To array', () => {
    for (const to of [undefined, null, 'recipient@example.test']) expect(() => codec.buildMimeMessage({ ...draft(), to } as unknown as MimeBuildInput, { allowEmptyTo: true })).toThrow('at least one To recipient')
    expect(() => codec.buildMimeMessage({ ...draft(), from: '' }, { allowEmptyTo: true })).toThrow('valid From address')
  })
})
