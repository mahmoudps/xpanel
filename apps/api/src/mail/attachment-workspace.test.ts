import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_FILE_BYTES, ATTACHMENT_MESSAGE_BYTES, ATTACHMENT_REFERENCE_TTL_MS, createAttachmentWorkspaceRoutes, createLocalAttachmentSource } from './attachment-workspace.ts'
import type { AttachmentMailboxContext, AttachmentMessage } from './attachment-workspace.ts'
import type { ImapFetchedMessage, ImapSelectedMailboxState } from './imap.ts'

// Request-adapter and declared transport-fake checks. No native service/authentication proof.
const secret = createHash('sha256').update('attachment fixture').digest('hex')
const context = (): AttachmentMailboxContext => ({ record: { sessionId: 'synthetic-session', mailbox: 'owner@example.test', accountId: 'synthetic-account', serviceUserId: 'synthetic-service-user' }, password: ['synthetic', 'runtime', 'only', 'password'].join('-') })
const content = Uint8Array.from([0, 255, 1, 2, 13, 10])
const message = (): AttachmentMessage => ({ mailbox: 'owner@example.test', folder: 'INBOX', uid: 17, uidValidity: 800, parts: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content }] })
const fixture = () => {
  let opened = context(), current = message(), now = Date.parse('2026-10-26T12:00:00Z')
  const open = vi.fn(async () => opened), read = vi.fn(async () => current), audit = vi.fn(async () => {})
  const route = createAttachmentWorkspaceRoutes({ open, secret, source: { read }, now: () => now, audit })
  const request = (path = '/api/webmail/attachment-workspace?uid=17&folder=INBOX', method = 'GET') => route(new Request('http://localhost' + path, { method }))
  const manifest = async () => {
    const response = await request()
    expect(response?.status).toBe(200)
    return await response!.json() as { context: { mailbox: string; folder: string; uid: number; uidValidity: number }; attachments: Array<{ filename: string; contentType: string; sizeBytes: number; sha256: string; downloadPath: string; expiresAt: string }> }
  }
  return { request, manifest, open, read, audit, setContext: (next: AttachmentMailboxContext) => { opened = next }, setMessage: (next: AttachmentMessage) => { current = next }, advance: (ms: number) => { now += ms } }
}

describe('authenticated MIME attachment workspace', () => {
  it('issues bounded references from actual bytes without returning content or credentials', async () => {
    const f = fixture(), value = await f.manifest()
    expect(value.context).toEqual({ mailbox: 'owner@example.test', folder: 'INBOX', uid: 17, uidValidity: 800 })
    expect(value.attachments[0]).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    expect(value.attachments[0]!.downloadPath).toMatch(/^\/api\/webmail\/attachment-download\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(value)).not.toContain(context().password)
    expect(value.attachments[0]).not.toHaveProperty('content')
    expect(f.open).toHaveBeenCalledTimes(2)
  })
  it('downloads exact binary content with safe headers and a scoped audit', async () => {
    const f = fixture(), value = await f.manifest(), response = await f.request(value.attachments[0]!.downloadPath)
    expect(response?.status).toBe(200)
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(content)
    expect(response!.headers.get('content-type')).toBe('application/pdf')
    expect(response!.headers.get('content-disposition')).toContain('attachment; filename="invoice.pdf"')
    expect(response!.headers.get('cache-control')).toContain('no-store')
    expect(response!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response!.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(f.audit).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ mailbox: 'owner@example.test', folder: 'INBOX', uid: 17, sizeBytes: content.length }))
  })
  it.each(['sessionId', 'accountId', 'serviceUserId', 'mailbox'] as const)('binds downloads to %s', async key => {
    const f = fixture(), value = await f.manifest(), other = context()
    other.record[key] = 'other-' + key; f.setContext(other)
    await expect(f.request(value.attachments[0]!.downloadPath)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('refuses tampered and expired references without reading message bytes', async () => {
    const f = fixture(), value = await f.manifest(), path = value.attachments[0]!.downloadPath
    await expect(f.request(path.slice(0, -1) + (path.endsWith('A') ? 'B' : 'A'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    f.advance(ATTACHMENT_REFERENCE_TTL_MS)
    await expect(f.request(path)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it.each(['uidValidity', 'content', 'filename', 'contentType'] as const)('refuses changed %s after refetch', async key => {
    const f = fixture(), value = await f.manifest(), current = message()
    if (key === 'uidValidity') current.uidValidity++
    else if (key === 'content') current.parts[0]!.content = Uint8Array.from([4, 5, 6])
    else current.parts[0]![key] = key === 'filename' ? 'other.pdf' : 'text/plain'
    f.setMessage(current)
    await expect(f.request(value.attachments[0]!.downloadPath)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.audit).not.toHaveBeenCalled()
  })
  it('fails closed when authorization changes during an attachment read', async () => {
    const f = fixture()
    f.open.mockResolvedValueOnce(context()).mockResolvedValueOnce({ ...context(), record: { ...context().record, serviceUserId: 'revoked' } })
    await expect(f.manifest()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('pins a supplied observed message identity before issuing attachment references', async () => {
    const f = fixture()
    await expect(f.request('/api/webmail/attachment-workspace?uid=17&folder=INBOX&uidValidity=801')).rejects.toMatchObject({ code: 'CONFLICT' })
    const response = await f.request('/api/webmail/attachment-workspace?uid=17&folder=INBOX&uidValidity=800')
    expect(response?.status).toBe(200)
  })
  it.each(['uid=0', 'uid=01', 'uid=4294967296', 'uid=17&uid=18', 'uid=17&mailbox=foreign@example.test', 'uid=17&folder=../other', 'uid=17&uidValidity=invalid'])('rejects unsupported selectors %s before transport', async query => {
    const f = fixture()
    await expect(f.request('/api/webmail/attachment-workspace?' + query)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(f.read).not.toHaveBeenCalled()
  })
  it('does not substitute metadata for missing, foreign or oversized MIME bytes', async () => {
    const f = fixture(), current = message()
    f.setMessage({ ...current, uid: 18 })
    await expect(f.manifest()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    f.setMessage({ ...current, parts: [{ ...current.parts[0]!, content: new Uint8Array(ATTACHMENT_FILE_BYTES + 1) }] })
    await expect(f.manifest()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    f.setMessage({ ...current, parts: [{ ...current.parts[0]!, content: undefined as never }] })
    await expect(f.manifest()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('preserves Unicode names safely and forces active/dangerous content to download as octets', async () => {
    const f = fixture(), current = message()
    current.parts[0] = { filename: '../فاتورة\r\n.png', contentType: 'image/svg+xml', content, dangerousExtension: true }
    f.setMessage(current)
    const value = await f.manifest(), response = await f.request(value.attachments[0]!.downloadPath)
    expect(value.attachments[0]!.filename).not.toMatch(/[\r\n/\\]/)
    expect(response!.headers.get('content-type')).toBe('application/octet-stream')
    expect(response!.headers.get('content-disposition')).toContain("filename*=UTF-8''")
    expect(response!.headers.get('content-disposition')).not.toMatch(/[\r\n]/)
  })
  it('does not claim an unrelated route and rejects writes to the read-only attachment endpoints', async () => {
    const f = fixture()
    expect(await f.request('/api/other')).toBeNull()
    expect((await f.request('/api/webmail/attachment-workspace?uid=17', 'POST'))?.status).toBe(405)
    expect(f.read).not.toHaveBeenCalled()
  })
})

describe('real IMAP attachment adapter boundary', () => {
  const wireFixture = (uidValidityObserved = true) => {
    const download = { filename: 'real.bin', contentType: 'application/octet-stream', sizeBytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), content: Buffer.from(content), contentDisposition: 'attachment' }
    const rawMimeBytes = Buffer.from('Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="real.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(content).toString('base64'))
    const fetched = { state: { uidValidity: 800, uidValidityObserved } as ImapSelectedMailboxState,
      messages: [{ mailbox: 'owner@example.test', folder: 'INBOX', uid: 17, uidValidity: 800, rawMimeBytes, sizeBytes: rawMimeBytes.length, rfc822SizeObserved: true, bodyComplete: true, attachmentTokens: [{ token: 'runtime-only-reference', dangerousExtension: false }] } as ImapFetchedMessage] }
    return { connect: vi.fn(async () => 'OK'), login: vi.fn(async () => undefined), logout: vi.fn(async () => undefined), fetchMessagesByUid: vi.fn(async () => fetched), authorizeAttachmentDownload: vi.fn(() => download) }
  }
  it('uses authenticated real-client operations and MIME/literal bounds', async () => {
    const client = wireFixture(), factory = vi.fn(() => client)
    const result = await createLocalAttachmentSource({ XPANEL_IMAP_HOST: '127.0.0.1' }, factory).read(context(), 'INBOX', 17)
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 143, tls: false, maxLiteralBytes: ATTACHMENT_MESSAGE_BYTES, maxResponseLineBytes: 1024 * 1024 }))
    expect(client.login).toHaveBeenCalledWith(context().record.mailbox, context().password)
    expect(client.fetchMessagesByUid).toHaveBeenCalledWith('INBOX', 17, expect.objectContaining({ requestedMailbox: context().record.mailbox, mimeLimits: expect.objectContaining({ maxTotalBytes: ATTACHMENT_MESSAGE_BYTES }) }))
    expect(client.authorizeAttachmentDownload).toHaveBeenCalledWith(context().record.mailbox, 'runtime-only-reference')
    expect(result.parts[0]!.content).toEqual(Buffer.from(content)); expect(client.logout).toHaveBeenCalledOnce()
  })
  it('requires genuinely observed UIDVALIDITY before exposing attachments', async () => {
    const client = wireFixture(false)
    await expect(createLocalAttachmentSource({}, () => client).read(context(), 'INBOX', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(client.authorizeAttachmentDownload).not.toHaveBeenCalled(); expect(client.logout).toHaveBeenCalledOnce()
  })
  it.each(['rfc822SizeObserved', 'bodyComplete'] as const)('requires observed %s instead of metadata fallbacks', async field => {
    const client = wireFixture()
    const original = await client.fetchMessagesByUid()
    original.messages[0]![field] = false
    client.fetchMessagesByUid.mockResolvedValue(original)
    await expect(createLocalAttachmentSource({}, () => client).read(context(), 'INBOX', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(client.authorizeAttachmentDownload).not.toHaveBeenCalled()
  })
  it('refuses missing/truncated raw BODY bytes before using attachment tokens', async () => {
    const client = wireFixture(), original = await client.fetchMessagesByUid()
    original.messages[0]!.rawMimeBytes = Buffer.from('truncated')
    client.fetchMessagesByUid.mockResolvedValue(original)
    await expect(createLocalAttachmentSource({}, () => client).read(context(), 'INBOX', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(client.authorizeAttachmentDownload).not.toHaveBeenCalled()
  })
  it('refuses cleartext remote mail before constructing a client', async () => {
    const factory = vi.fn(() => wireFixture())
    await expect(createLocalAttachmentSource({ XPANEL_IMAP_HOST: 'mail.example.test', XPANEL_IMAP_PORT: '143' }, factory).read(context(), 'INBOX', 17)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(factory).not.toHaveBeenCalled()
  })
})
