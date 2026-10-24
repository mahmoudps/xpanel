import { describe, expect, it } from 'vitest'
import { MimeCodecAndSanitizer } from './mime.ts'
import { attachmentsFromBodyStructure } from './imap.ts'
import { tlsConnectOptions, smtpHumanCopy } from './smtp.ts'
import { composeDraftFromMessage, dkimIdentityLine, formatMessageSizeLimit, messageSizeLimitBytes, messageSizeLimitFromPostconf, smtpdMiltersConfigured } from './document.ts'
import { imapHumanCopy } from './inbox.ts'

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
    const named = new MimeCodecAndSanitizer().parseMimeMessage(
      'From: Lina Saleh <lina@example.test>\r\nCc: "Saleh, Sam" <sam@example.test>, info@example.test\r\nSubject: Hello\r\n\r\nBody\r\n',
    )
    expect(named.cc).toEqual(['Saleh, Sam <sam@example.test>', 'info@example.test'])
  })

  it('reads an attachment name and size from BODYSTRUCTURE', () => {
    const files = attachmentsFromBodyStructure(
      '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 12 1)("APPLICATION" "PDF" ("NAME" "plan.pdf") NIL NIL "BASE64" 2048 NIL ("ATTACHMENT" ("FILENAME" "plan.pdf")) NIL)',
    )
    expect(files).toEqual([{ name: 'plan.pdf', sizeBytes: Math.floor(2048 / 4) * 3 }])
  })

  it('shows 10,240,000 bytes as 10 MB and treats an empty milter as not connected', () => {
    expect(formatMessageSizeLimit(10_240_000)).toBe('10 MB')
    expect(messageSizeLimitBytes('message_size_limit = 10240000\n')).toBe(10_240_000)
    expect(messageSizeLimitFromPostconf('10240000\n')).toBe(10_240_000)
    expect(messageSizeLimitFromPostconf('')).toBeNull()
    expect(smtpdMiltersConfigured('smtpd_milters =\n')).toBe(false)
    expect(smtpdMiltersConfigured('smtpd_milters = local:opendkim/opendkim.sock\n')).toBe(true)
    expect(dkimIdentityLine('refused', 'xp202610', 'en')).toBe('OpenDKIM refused the connection')
    expect(dkimIdentityLine('signing', 'xp202610', 'en')).toBe('OpenDKIM is signing with xp202610')
    expect(dkimIdentityLine('unknown', undefined, 'ar')).toBe('حالة OpenDKIM غير معروفة')
    expect(dkimIdentityLine('refused', 'xp202610', 'en').includes('connected')).toBe(false)
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
    expect(reply.to).toBe('Lina Saleh <lina@example.test>')
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

  it('explains an IMAP move with folder copy instead of a send failure', () => {
    const missing = imapHumanCopy('IMAP UID MOVE/COPY failed: NO [TRYCREATE] Mailbox does not exist')
    expect(missing.en).toBe('That folder is not on this mailbox yet.')
    expect(missing.en).not.toContain('could not be sent')
    const failed = imapHumanCopy('IMAP UID MOVE/COPY failed: NO')
    expect(failed.en).toBe('The message could not be moved.')
    expect(failed.ar).toBe('تعذر نقل الرسالة.')
  })
})
