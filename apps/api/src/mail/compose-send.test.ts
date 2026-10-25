import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createLocalMailboxTransport, parseMailboxSend } from './inbox.ts'
import { ImapProtocolClient } from './imap.ts'
import { MimeCodecAndSanitizer } from './mime.ts'
import { SmtpSubmissionClient } from './smtp.ts'

const draft = { to: 'reader@example.test', subject: 'Review', text: 'Plain text alternative' }
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of closers.splice(0).reverse()) await close()
})

describe('approved compose send contract', () => {
  it('retains the plain-text contract and normalizes real multi-address fields', () => {
    const plain = parseMailboxSend(draft)
    expect(plain).toMatchObject(draft)
    expect(plain).not.toHaveProperty('html')
    expect(plain).not.toHaveProperty('bcc')
    const rich = parseMailboxSend({ ...draft,
      to: ' First@Example.test;second@example.test,first@example.test ',
      cc: ' COPY@example.test ', bcc: 'Hidden@example.test;hidden@example.test',
      html: '<p dir="rtl"><strong>Review</strong> <em>this</em> <u>draft</u></p><ul><li>One</li></ul><blockquote>Quote</blockquote><a href="https://example.test">Link</a>',
    })
    expect(rich.to).toBe('first@example.test, second@example.test')
    expect(rich.cc).toEqual(['copy@example.test'])
    expect(rich.bcc).toEqual(['hidden@example.test'])
    expect(rich.html).toContain('<strong>Review</strong>')
    expect(rich.html).toContain('dir="rtl"')
    expect(rich.html).toContain('<blockquote>Quote</blockquote>')
    expect(rich.idempotencyKey).not.toBe(plain.idempotencyKey)
  })

  it('sanitizes active HTML on the server before a transport can use it', () => {
    const input = parseMailboxSend({ ...draft, html: '<p onclick="alert(1)">Safe <strong>body</strong></p><script>private-script</script><iframe srcdoc="bad">frame</iframe><a href="javascript:alert(1)">bad link</a><img src="https://tracker.example.test/pixel" onerror="alert(1)">' })
    expect(input.html).toContain('<strong>body</strong>')
    expect(input.html).not.toMatch(/onclick|onerror|javascript:|<script|private-script|iframe|srcdoc|https:\/\/tracker/i)
    expect(input.text).toBe(draft.text)
  })

  it.each(['to', 'cc', 'bcc'] as const)('rejects malformed or injected %s rather than silently dropping it', field => {
    for (const value of ['valid@example.test,invalid', 'valid@example.test\r\nBcc: hidden@example.test', 'valid@example.test\u0000', ['valid@example.test'], 7]) {
      expect(() => parseMailboxSend({ ...draft, [field]: value })).toThrow()
    }
  })

  it('keeps To and plain text required even for Bcc or HTML', () => {
    expect(() => parseMailboxSend({ ...draft, to: '', bcc: 'hidden@example.test' })).toThrow(/recipient/)
    expect(() => parseMailboxSend({ ...draft, text: '', html: '<b>HTML alone</b>' })).toThrow(/message text/)
    expect(() => parseMailboxSend({ ...draft, subject: 'Review\r\nBcc: hidden@example.test' })).toThrow(/subject/)
    expect(() => parseMailboxSend({ ...draft, html: 5 })).toThrow(/HTML/)
  })

  it('bounds the combined recipient list, not each field independently', () => {
    const addresses = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => `${prefix}${i}@example.test`).join(',')
    expect(parseMailboxSend({ ...draft, to: addresses(40, 'to'), cc: addresses(30, 'cc'), bcc: addresses(30, 'bcc') }).bcc).toHaveLength(30)
    expect(() => parseMailboxSend({ ...draft, to: addresses(40, 'to'), cc: addresses(30, 'cc'), bcc: addresses(31, 'bcc') })).toThrow(/too many/)
    expect(() => parseMailboxSend({ ...draft, cc: addresses(101, 'cc') })).toThrow(/too many/)
    expect(() => parseMailboxSend({ ...draft, bcc: `${'x'.repeat(243)}@example.test` })).toThrow(/recipient/)
  })

  it('bounds raw UTF-8 text plus HTML before removing unsafe content', () => {
    expect(parseMailboxSend({ ...draft, text: 'a'.repeat(100_000) }).text).toHaveLength(100_000)
    expect(() => parseMailboxSend({ ...draft, text: 'a'.repeat(100_001) })).toThrow()
    expect(() => parseMailboxSend({ ...draft, text: 'a'.repeat(60_000), html: '<script>' + 'b'.repeat(40_000) + '</script>' })).toThrow(/byte limit/)
    expect(() => parseMailboxSend({ ...draft, text: 'م'.repeat(50_001) })).toThrow(/byte limit/)
  })
})

/** Real loopback SMTP dialogue; no service credentials or external delivery. */
const smtpCapture = async () => {
  const recipients: string[] = []
  const submitted: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    let inData = false
    const reply = (line: string) => socket.write(line + '\r\n')
    reply('220 loopback.example.test ESMTP')
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (inData) {
          const stop = buffer.indexOf('\r\n.\r\n')
          if (stop < 0) break
          submitted.push(buffer.slice(0, stop).replace(/(^|\r\n)\.\./g, '$1.'))
          buffer = buffer.slice(stop + 5)
          inData = false
          reply('250 2.0.0 Ok: queued as FIDELITY100')
          continue
        }
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const command = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (command.startsWith('EHLO ')) reply('250-loopback.example.test\r\n250 AUTH PLAIN')
        else if (command.startsWith('AUTH PLAIN ')) reply('235 2.7.0 Authenticated')
        else if (command.startsWith('MAIL FROM:')) reply('250 2.1.0 Ok')
        else if (command.startsWith('RCPT TO:')) { recipients.push(command.slice('RCPT TO:<'.length, -1)); reply('250 2.1.5 Ok') }
        else if (command === 'DATA') { inData = true; reply('354 Send message') }
        else if (command === 'QUIT') { reply('221 Bye'); socket.end() }
        else reply('500 Unexpected command')
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { port: (server.address() as net.AddressInfo).port, recipients, submitted }
}

describe('compose transport MIME and blind recipient boundary', () => {
  it('passes Bcc only through the SMTP envelope and stores the same sanitized MIME in Sent', async () => {
    const wire = await smtpCapture()
    const submit = SmtpSubmissionClient.prototype.submitMessage
    // The test loopback server has no TLS. Production transport's STARTTLS configuration stays intact.
    vi.spyOn(SmtpSubmissionClient.prototype, 'submitMessage').mockImplementation(function (credentials, input) {
      return submit.call(new SmtpSubmissionClient({ host: '127.0.0.1', port: wire.port, tls: false, timeoutMs: 2000 }), credentials, input)
    })
    vi.spyOn(ImapProtocolClient.prototype, 'connect').mockResolvedValue('OK')
    vi.spyOn(ImapProtocolClient.prototype, 'login').mockResolvedValue()
    vi.spyOn(ImapProtocolClient.prototype, 'logout').mockResolvedValue()
    const append = vi.spyOn(ImapProtocolClient.prototype, 'appendMessage').mockResolvedValue({ appendedUid: 1, statusText: 'OK' })
    const signed: string[] = []
    const transport = createLocalMailboxTransport({}, { signSent: async (_mailbox, rawMime) => {
      signed.push(rawMime)
      return 'DKIM-Signature: v=1; a=rsa-sha256; b=fixture\r\n' + rawMime
    } })
    const input = parseMailboxSend({ ...draft, to: 'reader@example.test,second@example.test', cc: 'copy@example.test', bcc: 'blind-only@example.test', html: '<p onclick="bad()">Safe <strong>body</strong></p><script>blocked</script>' })
    const result = await transport.send('sender@example.test', 'synthetic-test-password', input)
    expect(result.savedToSent).toBe(true)
    expect(result.messageId).toMatch(/^<[^<>]+>$/)
    expect(wire.recipients).toEqual(['reader@example.test', 'second@example.test', 'copy@example.test', 'blind-only@example.test'])
    expect(wire.submitted).toHaveLength(1)
    const raw = wire.submitted[0]!
    expect(raw).not.toMatch(/^Bcc:/im)
    expect(raw).not.toContain('blind-only@example.test')
    const parsed = new MimeCodecAndSanitizer().parseMimeMessage(raw)
    expect(parsed.to).toEqual(['reader@example.test', 'second@example.test'])
    expect(parsed.cc).toEqual(['copy@example.test'])
    expect(parsed.textBody.trim()).toBe(draft.text)
    expect(parsed.rawHtmlBody).toContain('<strong>body</strong>')
    expect(parsed.rawHtmlBody).not.toMatch(/onclick|<script|blocked/)
    expect(signed[0]).not.toContain('blind-only@example.test')
    expect(append).toHaveBeenCalledExactlyOnceWith('Sent', 'DKIM-Signature: v=1; a=rsa-sha256; b=fixture\r\n' + signed[0], ['\\Seen'])
    expect(String(append.mock.calls[0]![1])).not.toMatch(/^Bcc:/im)
  })

  it('preserves uncertain submission details and does not write Sent on refusal', async () => {
    vi.spyOn(SmtpSubmissionClient.prototype, 'submitMessage').mockImplementation(async () => fail('CONFLICT', 'Delivery needs verification', { phase: 'data_transmitted_awaiting_ack', verificationRequired: true }))
    const append = vi.spyOn(ImapProtocolClient.prototype, 'appendMessage')
    const transport = createLocalMailboxTransport()
    await expect(transport.send('sender@example.test', 'synthetic-test-password', parseMailboxSend({ ...draft, bcc: 'hidden@example.test', html: '<b>Review</b>' }))).rejects.toMatchObject({ code: 'CONFLICT', detail: { phase: 'data_transmitted_awaiting_ack', verificationRequired: true } })
    expect(append).not.toHaveBeenCalled()
  })
})