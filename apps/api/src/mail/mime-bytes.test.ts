import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MimeCodecAndSanitizer } from './mime.ts'

const codec = new MimeCodecAndSanitizer()
const binary = Buffer.from([0, 255, 254, 128, 65, 13, 10, 32, 9, 13, 10])
const multipart = (payload: Uint8Array, encoding = 'binary', text = 'Message text', extraHeader = '') => Buffer.concat([
  Buffer.from([
    'From: مرسل <owner@example.test>', 'To: receiver@example.test', 'Subject: اختبار المرفقات', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="bytes-boundary"', '', '--bytes-boundary',
    'Content-Type: text/plain; charset=utf-8', '', text, '--bytes-boundary',
    'Content-Type: application/octet-stream', 'Content-Disposition: attachment; filename="raw.bin"',
    'Content-Transfer-Encoding: ' + encoding, ...(extraHeader ? [extraHeader] : []), '', '',
  ].join('\r\n'), 'utf8'),
  Buffer.from(payload), Buffer.from('\r\n--bytes-boundary--\r\n', 'ascii'),
])

describe('lossless authoritative MIME byte parsing', () => {
  it.each(['binary', '8bit', '7bit'])('preserves exact %s attachment bytes, including invalid UTF-8 and trailing whitespace', encoding => {
    const parsed = codec.parseMimeMessage(multipart(binary, encoding))
    expect(parsed.attachments).toHaveLength(1)
    expect(parsed.attachments[0]!.content).toEqual(binary)
    expect(parsed.attachments[0]!.sizeBytes).toBe(binary.length)
    expect(parsed.attachments[0]!.sha256).toBe(createHash('sha256').update(binary).digest('hex'))
    expect(parsed.fromName).toBe('مرسل'); expect(parsed.subject).toBe('اختبار المرفقات')
  })
  it('retains base64 and quoted-printable transfer decoding over wire bytes', () => {
    expect(codec.parseMimeMessage(multipart(Buffer.from(binary.toString('base64'), 'ascii'), 'base64')).attachments[0]!.content).toEqual(binary)
    const quoted = Array.from(binary, byte => '=' + byte.toString(16).toUpperCase().padStart(2, '0')).join('')
    expect(codec.parseMimeMessage(multipart(Buffer.from(quoted, 'ascii'), 'quoted-printable')).attachments[0]!.content).toEqual(binary)
  })
  it('does not confuse a legitimate Unicode replacement character with byte corruption', () => {
    const parsed = codec.parseMimeMessage(multipart(binary, 'binary', 'Legitimate \uFFFD character'))
    expect(parsed.textBody).toBe('Legitimate \uFFFD character')
    expect(parsed.attachments[0]!.content).toEqual(binary)
  })
  it('recognizes only actual multipart delimiter lines, not substrings in binary payloads', () => {
    const payload = Buffer.concat([binary, Buffer.from('left--bytes-boundaryright\r\n--bytes-boundary-not-a-delimiter\r\nend')])
    expect(codec.parseMimeMessage(multipart(payload)).attachments[0]!.content).toEqual(payload)
  })
  it('accepts Uint8Array subviews without including bytes outside the view', () => {
    const raw = multipart(binary), backing = Uint8Array.from([9, 8, ...raw, 7, 6])
    const parsed = codec.parseMimeMessage(backing.subarray(2, backing.length - 2))
    expect(parsed.attachments[0]!.content).toEqual(binary)
  })
  it('preserves current string-caller results for valid UTF-8/base64 messages', () => {
    const raw = multipart(Buffer.from(binary.toString('base64'), 'ascii'), 'base64', 'نص UTF-8')
    const legacy = codec.parseMimeMessage(raw.toString('utf8')), bytes = codec.parseMimeMessage(raw)
    for (const key of ['from', 'fromName', 'to', 'subject', 'textBody', 'rawHtmlBody'] as const) expect(bytes[key]).toEqual(legacy[key])
    expect(bytes.attachments).toEqual(legacy.attachments)
  })
  it('reuses the charset decoder for byte-input text while leaving string callers unchanged', () => {
    const latin = Buffer.concat([Buffer.from('Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n', 'ascii'), Buffer.from([99, 97, 102, 233])])
    expect(codec.parseMimeMessage(latin).textBody).toBe('café')
    expect(codec.parseMimeMessage('Content-Type: text/plain; charset=iso-8859-1\r\n\r\ncafé').textBody).toBe('café')
  })
  it('continues to enforce raw byte/header/part limits', () => {
    const raw = multipart(binary)
    expect(() => codec.parseMimeMessage(raw, { maxTotalBytes: raw.length - 1 })).toThrow(/exceeds limit/)
    expect(() => codec.parseMimeMessage(raw, { maxHeaderBytes: 8 })).toThrow(/header block/)
    expect(() => codec.parseMimeMessage(raw, { maxParts: 1 })).toThrow(/part count/)
  })
})
