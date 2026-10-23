import { describe, expect, it } from 'vitest'
import { MimeCodecAndSanitizer } from './mime.ts'
import { attachmentsFromBodyStructure } from './imap.ts'
import { tlsConnectOptions, smtpHumanCopy } from './smtp.ts'
import { composeDraftFromMessage, formatMessageSizeLimit, messageSizeLimitBytes, smtpdMiltersConnected } from './document.ts'

describe('live mail truth', () => {
  it('omits the TLS server name when the SMTP host is an IP', () => {
    const options = tlsConnectOptions('127.0.0.1', { host: '127.0.0.1', port: 587 })
    expect(options.servername).toBeUndefined()
    expect(tlsConnectOptions('mail.example.test', { host: 'mail.example.test' }).servername).toBe('mail.example.test')
  })

  it('maps the Node IP server-name error to a human sentence', () => {
    const copy = smtpHumanCopy('TLS ServerName to an IP address is not permitted')
    expect(copy.en).toBe('A secure mail connection cannot use an IP address as the server name.')
    expect(copy.ar).toContain('IP')
    expect(copy.en).not.toContain('TLS ServerName')
    expect(copy.ar).not.toContain('TLS ServerName')
  })

  it('keeps the display name and the Cc list from the message headers', () => {
    const parsed = new MimeCodecAndSanitizer().parseMimeMessage(
      'From: Lina Saleh <lina@example.test>\r\nTo: info@example.test\r\nCc: sam@example.test\r\nSubject: Hello\r\n\r\nBody\r\n',
    )
    expect(parsed.fromName).toBe('Lina Saleh')
    expect(parsed.from).toBe('lina@example.test')
    expect(parsed.cc).toEqual(['sam@example.test'])
  })

  it('reads an attachment name and size from BODYSTRUCTURE', () => {
    const files = attachmentsFromBodyStructure(
      '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1)("APPLICATION" "PDF" ("NAME" "plan.pdf") NIL NIL "BASE64" 2048 NIL ("ATTACHMENT" ("FILENAME" "plan.pdf")) NIL)',
    )
    expect(files).toEqual([{ name: 'plan.pdf', sizeBytes: 2048 }])
  })

  it('shows 10,240,000 bytes as 10 MB and treats an empty milter as not connected', () => {
    expect(formatMessageSizeLimit(10_240_000)).toBe('10 MB')
    expect(messageSizeLimitBytes('message_size_limit = 10240000\n')).toBe(10_240_000)
    expect(smtpdMiltersConnected('smtpd_milters =\n')).toBe(false)
    expect(smtpdMiltersConnected('smtpd_milters = local:/run/opendkim/opendkim.sock\n')).toBe(true)
  })

  it('quotes the original message for reply, reply-all, and forward', () => {
    const source = {
      mailbox: 'info@example.test',
      from: 'lina@example.test',
      fromName: 'Lina Saleh',
      to: 'info@example.test',
      cc: 'sam@example.test',
      subject: 'Hello',
      body: 'See you',
    }
    const reply = composeDraftFromMessage({ mode: 'reply', ...source })
    expect(reply.to).toBe('lina@example.test')
    expect(reply.cc).toBe('')
    expect(reply.subject).toBe('Re: Hello')
    expect(reply.body).toContain('> See you')
    const all = composeDraftFromMessage({ mode: 'reply-all', ...source })
    expect(all.cc).toBe('sam@example.test')
    expect(all.cc).not.toContain('info@example.test')
    const forward = composeDraftFromMessage({ mode: 'forward', ...source })
    expect(forward.to).toBe('')
    expect(forward.subject).toBe('Fwd: Hello')
    expect(forward.body).toContain('Lina Saleh <lina@example.test>')
  })
})
