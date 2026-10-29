// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING } from './mail-compose-identities-client.ts'
import { MAIL_SEND_CLIENT_BINDING, readMailBodyHtml, readMailSendPayload } from './mail-send-client.ts'
import { renderCompose, xmailComposeFromProps, type ComposeModel } from './board-port/xmail-compose.ts'

const mailbox = 'sender@example.test'
const id = (n: number) => 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(n).padStart(12, '0')
const identity = (patch: Record<string, unknown> = {}) => ({ id: id(1), mailbox, email: mailbox, displayName: 'Customer team', replyTo: 'reply@example.test', textSignature: 'Regards,\nCustomer team', htmlSignature: '<img src=x onerror="window.__signatureXss=1">', isDefault: true, createdAt: '2026-10-26T00:00:00Z', revision: '1'.repeat(64), ...patch })
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const root = () => document.querySelector<HTMLElement>('[data-compose-identities]')!
const select = () => document.querySelector<HTMLSelectElement>('#compose-from')!
const editor = () => document.querySelector<HTMLElement>('#compose-body')!
const status = () => document.querySelector<HTMLElement>('[data-compose-identities-status]')!
const send = () => document.querySelector<HTMLButtonElement>('[data-mail-send]')!
const refresh = () => document.querySelector<HTMLButtonElement>('[data-compose-identities-refresh]')!
const insert = () => document.querySelector<HTMLButtonElement>('[data-compose-signature-insert]')!
const boot = (transport?: Transport) => {
  if (transport) (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest = transport
  new Function('return ' + MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING)()(undefined)
}
const change = (value: string) => { select().value = value; select().dispatchEvent(new Event('change')) }

beforeEach(() => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = `<section data-compose-identities data-compose-mailbox="${mailbox}" data-compose-identities-state="unread"><select id="compose-from"><option value="${mailbox}">${mailbox}</option></select><button type="button" data-compose-identities-refresh>Read identities</button><button type="button" data-compose-signature-insert>Insert signature</button><p data-compose-identities-status role="status"></p><input id="compose-to" value="recipient@example.test"><input id="compose-subject" value="Draft subject"><div id="compose-body" contenteditable="true"><p><strong>Original</strong> rich body</p></div><button type="button" data-mail-send="true">Send</button></section><dd data-mail-from-addr><bdi dir="ltr">${mailbox}</bdi></dd><dd data-compose-identity-label>Not read</dd><dd data-compose-reply-to>Not read</dd>`
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  const sendStatus = document.createElement('p'); sendStatus.id = 'mail-send-status'; root().appendChild(sendStatus)
})
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('compose saved sender identities and managed signatures', () => {
  it('serializes a standalone client without HTML insertion or its own fetch transport', () => {
    expect(() => new Function('return ' + MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('preserves rich fragment markup and correctly escapes authored text during collection', () => {
    expect(readMailBodyHtml(editor())).toBe('<p><strong>Original</strong> rich body</p>')
    editor().appendChild(document.createTextNode(' A & B < C > D'))
    expect(readMailBodyHtml(editor())).toBe('<p><strong>Original</strong> rich body</p> A &amp; B &lt; C &gt; D')
  })
  it.each(['en', 'ar'] as const)('exposes real compose sender hooks and keeps all old controls in %s', locale => {
    const model: ComposeModel = {
      locale, product: true, mailbox, quotaText: 'Not read', quotaPct: 0, quotaMeasured: false,
      composeHref: '/mail/compose', inboxHref: '/mail/inbox', folders: [], custom: [],
      vacationHref: '/mail/settings/autoresponder', vacationShort: 'Not read', filtersHref: '/mail/settings/filters', filtersShort: 'Not read',
      savedText: 'Not sent', fromOptions: [{ value: mailbox, label: mailbox }], fromValue: mailbox, fromAddr: mailbox,
      chips: [], subject: '', bodyHtml: '<p>Draft body</p>', numbersOn: false, attachments: [], attachSummary: '0 files', attachHelp: 'No files',
      identityDkim: 'Not read', identitySpf: 'Not read', identitySize: 'Not read', vacationStatus: 'Not read', vacationOn: false,
      vacationOpenLabel: 'Open settings', filterCount: '0', filterRules: '', wsHtml: '', actionHtml: '', logoutAttr: '', routeAttr: '',
    }
    document.body.innerHTML = renderCompose(model)
    expect(root().dataset.composeMailbox).toBe(mailbox)
    expect(select().disabled).toBe(true); expect(send().disabled).toBe(true)
    for (const selector of ['[data-compose-identities-refresh]', '[data-compose-signature-insert]', '[data-mail-action="save-draft"]', '[data-mail-action="discard-ask"]', '[data-mail-format]']) expect(document.querySelector(selector)).not.toBeNull()
    expect(document.querySelector('[data-compose-reply-to]')).not.toBeNull()
    expect(document.querySelector('[data-compose-identity-label]')).not.toBeNull()
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('retains the draft and disables sending without a transport or capability admission', async () => {
    const before = editor().textContent
    boot(); expect(status().dataset.state).toBe('unavailable'); expect(send().disabled).toBe(true); expect(editor().textContent).toBe(before)
    root().removeAttribute('data-compose-identities-bound'); root().dataset.capabilityUnavailable = 'true'
    const transport = vi.fn<Transport>(); boot(transport); await tick(); expect(transport).not.toHaveBeenCalled()
  })
  it('selects the persisted default, reuses rich body nodes and inserts only textSignature', async () => {
    const body = editor().querySelector('strong'), transport = vi.fn<Transport>().mockResolvedValue({ identities: [identity()] })
    boot(transport); await tick()
    expect(transport).toHaveBeenCalledExactlyOnceWith('GET', '/api/webmail/identities')
    expect(select().value).toBe(id(1)); expect(send().disabled).toBe(false); expect(status().dataset.state).toBe('ready')
    expect(editor().querySelector('strong')).toBe(body)
    expect(editor().querySelector('[data-compose-managed-signature]')!.textContent).toBe('\n-- \nRegards,\nCustomer team')
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('[data-compose-identity-label]')!.textContent).toBe('Customer team')
    expect(document.querySelector('[data-compose-reply-to] bdi')!.textContent).toBe('reply@example.test')
    const payload = readMailSendPayload()
    expect(payload).toMatchObject({ identityId: id(1), expectedIdentityRevision: '1'.repeat(64) })
    expect(payload).not.toHaveProperty('fromName'); expect(payload).not.toHaveProperty('replyTo')
    expect(select().textContent).not.toContain(id(1))
  })
  it('replaces only its unchanged signature while preserving arbitrary message formatting', async () => {
    const a = identity(), b = identity({ id: id(2), displayName: 'Support', textSignature: 'Support team', isDefault: false, revision: '2'.repeat(64) })
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [a, b] })); await tick()
    const strong = editor().querySelector('strong'), addition = document.createElement('em'); addition.textContent = 'Additional user text'; editor().prepend(addition)
    change(id(2))
    expect(editor().querySelectorAll('[data-compose-managed-signature]')).toHaveLength(1)
    expect(editor().querySelector('strong')).toBe(strong); expect(editor().querySelector('em')).toBe(addition)
    expect(editor().textContent).not.toContain('Regards,'); expect(editor().textContent).toContain('Support team')
  })
  it('keeps a manually edited signature on identity change and inserts another only on explicit action', async () => {
    const a = identity(), b = identity({ id: id(2), textSignature: 'Other signature', isDefault: false, revision: '2'.repeat(64) })
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [a, b] })); await tick()
    editor().querySelector('[data-compose-managed-signature]')!.textContent = 'My edited signature'
    change(id(2))
    expect(editor().textContent).toContain('My edited signature'); expect(editor().textContent).not.toContain('Other signature')
    expect(status().textContent).toContain('edited signature was kept')
    insert().click()
    expect(editor().textContent).toContain('My edited signature'); expect(editor().textContent).toContain('Other signature')
  })
  it('requires an explicit new sender choice if the selected identity was deleted', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({ identities: [identity()] }); boot(transport); await tick()
    const before = editor().textContent; transport.mockResolvedValue({ identities: [] }); refresh().click(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(send().disabled).toBe(true); expect(editor().textContent).toBe(before)
    change(''); expect(send().disabled).toBe(false); expect(readMailSendPayload()).not.toHaveProperty('identityId')
  })
  it('refreshes a stale revision before sending again without removing user text', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({ identities: [identity()] }); boot(transport); await tick()
    root().dispatchEvent(new CustomEvent('xpanel:compose-identity-stale'))
    expect(send().disabled).toBe(true); expect(status().dataset.state).toBe('stale')
    expect(select().disabled).toBe(true); expect(insert().disabled).toBe(true)
    transport.mockResolvedValue({ identities: [identity({ revision: '2'.repeat(64), textSignature: 'Updated signature' })] }); refresh().click(); await tick()
    expect(send().disabled).toBe(false); expect(readMailSendPayload().expectedIdentityRevision).toBe('2'.repeat(64))
    expect(editor().textContent).toContain('Original rich body'); expect(editor().textContent).toContain('Updated signature')
  })
  it.each([
    { identities: [identity({ revision: undefined })] }, { identities: [identity({ email: 'foreign@example.test' })] },
    { identities: [identity({ mailbox: 'foreign@example.test' })] }, { identities: [identity(), identity()] },
    { identities: [identity({ displayName: 'Header\r\nBcc: victim@example.test' })] },
  ])('keeps sending unavailable after an invalid mailbox/revision collection: %j', async value => {
    const before = editor().textContent; boot(vi.fn<Transport>().mockResolvedValue(value)); await tick()
    expect(status().dataset.state).toBe('failed'); expect(send().disabled).toBe(true); expect(editor().textContent).toBe(before)
  })
  it('supports an actually empty identity collection with the authenticated mailbox sender', async () => {
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [] })); await tick()
    expect(select().value).toBe(''); expect(send().disabled).toBe(false); expect(insert().disabled).toBe(true)
    expect(readMailSendPayload()).not.toHaveProperty('identityId')
    expect(document.querySelector('[data-compose-reply-to] bdi')!.textContent).toBe(mailbox)
  })
  it('states the verified ownership boundary without exposing hidden metadata', async () => {
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [], metadataReview: { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' } })); await tick()
    expect(status().textContent).toContain('verified mailbox ownership'); expect(status().textContent).toContain('Older metadata may need review')
    expect(status().textContent).not.toContain('mailbox_metadata_binding_unverified'); expect(send().disabled).toBe(false)
  })
  it('does not enable Send for a draft-only scoped capability', async () => {
    root().dataset.composeSendEnabled = 'false'; boot(vi.fn<Transport>().mockResolvedValue({ identities: [identity()] })); await tick()
    expect(send().disabled).toBe(true); expect(select().disabled).toBe(false)
  })
  it('waits for actual attachment reads before enabling Send', async () => {
    const section = document.createElement('section'); section.dataset.composeAttachments = ''; root().appendChild(section)
    let ready = false
    Object.defineProperty(root(), 'xpanelReadComposeAttachments', { value: () => { if (!ready) throw new Error('pending'); return [] } })
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [] })); await tick(); expect(send().disabled).toBe(true)
    ready = true; root().dispatchEvent(new CustomEvent('xpanel:compose-attachments-state')); expect(send().disabled).toBe(false)
  })
  it('renders real file controls only under explicit composition capabilities', () => {
    document.body.innerHTML = renderCompose(xmailComposeFromProps({ mailbox, canSend: true, canSaveDraft: true }))
    expect(root().dataset.composeSendEnabled).toBe('true'); expect(root().dataset.composeDraftEnabled).toBe('true')
    expect(root().querySelector<HTMLElement>('[data-compose-attachments]')!.dataset.composeAttachmentEnabled).toBe('true')
    expect(root().querySelector('input[type="file"][multiple][data-compose-attachment-input]')).not.toBeNull(); expect(root().querySelector('[data-compose-attachment-list]')!.children).toHaveLength(0)
    document.body.innerHTML = renderCompose(xmailComposeFromProps({ mailbox }))
    expect(root().dataset.composeSendEnabled).toBe('false'); expect(root().dataset.composeDraftEnabled).toBe('false'); expect(root().querySelector<HTMLElement>('[data-compose-attachments]')!.dataset.composeAttachmentEnabled).toBe('false')
  })
  it('cannot unlock an uncertain SMTP send by refreshing or choosing another identity', async () => {
    const transport = vi.fn<Transport>().mockResolvedValue({ identities: [identity()] }); boot(transport); await tick()
    send().dataset.mailSendReview = 'true'; send().dispatchEvent(new CustomEvent('xpanel:mail-send-state', { bubbles: true }))
    expect(refresh().disabled).toBe(true); expect(select().disabled).toBe(true); expect(send().disabled).toBe(true)
    refresh().click(); await tick(); expect(transport).toHaveBeenCalledTimes(1)
  })
  it('preserves mailbox-only sending as an explicit choice when identity metadata cannot be read', async () => {
    boot(vi.fn<Transport>().mockRejectedValue({ status: 403, details: { stateChanged: false } })); await tick()
    expect(status().dataset.state).toBe('failed'); expect(send().disabled).toBe(true); expect(select().disabled).toBe(false)
    change('')
    expect(status().textContent).toContain('Saved identities were not read')
    expect(send().disabled).toBe(false); expect(readMailSendPayload()).not.toHaveProperty('identityId')
    expect(editor().textContent).toBe('Original rich body')
  })
  it('escapes active-looking plain signature text while retaining it as authored text', async () => {
    const text = '<img src=x onerror="window.__signatureXss=1">'
    boot(vi.fn<Transport>().mockResolvedValue({ identities: [identity({ textSignature: text })] })); await tick()
    expect(editor().querySelector('img')).toBeNull()
    expect(editor().querySelector('[data-compose-managed-signature]')!.textContent).toContain(text)
    expect(readMailSendPayload().html).toContain('&lt;img')
  })
  it('sends the selected saved revision and accepts only a matching mailbox and identity acknowledgement', async () => {
    const calls: { method: string; body?: unknown }[] = []
    const transport = vi.fn<Transport>(async (method, _path, body) => {
      calls.push({ method, body })
      if (method === 'GET') return { identities: [identity()] }
      return { mailbox, messageId: '<accepted@example.test>', savedToSent: true, identityId: id(1), identityRevision: '1'.repeat(64) }
    })
    boot(transport); new Function(MAIL_SEND_CLIENT_BINDING)(); await tick(); send().click(); await tick()
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
    expect(calls.find(call => call.method === 'POST')?.body).toMatchObject({ identityId: id(1), expectedIdentityRevision: '1'.repeat(64), to: 'recipient@example.test' })
    expect(document.getElementById('mail-send-status')!.dataset.state).toBe('accepted')
    expect(editor().querySelector('strong')).toBeNull()
    expect(editor().textContent).toBe('\n-- \nRegards,\nCustomer team')
    expect((document.getElementById('compose-to') as HTMLInputElement).value).toBe('')
  })
  it('preserves newer edits and the existing managed signature after accepted Send', async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => { finish = resolve })
    const transport = vi.fn<Transport>(async method => method === 'GET' ? { identities: [identity()] } : pending)
    boot(transport); new Function(MAIL_SEND_CLIENT_BINDING)(); await tick(); send().click()
    const signature = editor().querySelector('[data-compose-managed-signature]')!, original = editor().querySelector('strong')!
    const newer = document.createElement('em'); newer.textContent = 'Newer text'; editor().appendChild(newer)
    finish({ mailbox, messageId: '<accepted@example.test>', savedToSent: true, identityId: id(1), identityRevision: '1'.repeat(64) }); await tick()
    expect(editor().querySelector('strong')).toBe(original); expect(editor().querySelector('em')).toBe(newer)
    expect(editor().querySelectorAll('[data-compose-managed-signature]')).toHaveLength(1); expect(editor().querySelector('[data-compose-managed-signature]')).toBe(signature)
    expect(document.getElementById('mail-send-status')!.textContent).toContain('newer draft')
  })
  it.each(['cc', 'bcc'])('the actual renderer script sends a valid %s-only envelope without inventing To', async field => {
    document.body.innerHTML = renderCompose(xmailComposeFromProps({ mailbox, canSend: true, draft: { body: 'Private message body' } }))
    const request = vi.fn<Transport>(async () => ({ mailbox, messageId: '<accepted@example.test>', savedToSent: true }))
    ;(window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest = request
    root().dataset.composeIdentitiesState = 'ready'; select().options[0]!.value = ''; select().value = ''
    Object.defineProperty(root(), 'xpanelReadComposeAttachments', { value: () => [] })
    const script = [...document.querySelectorAll('script')].find(node => node.textContent?.includes('data-mail-recip-input'))!
    expect(script).toBeDefined(); new Function(script.textContent!)(); new Function(MAIL_SEND_CLIENT_BINDING)()
    const recipient = document.getElementById('compose-' + field) as HTMLInputElement; recipient.value = 'private-recipient@example.test'
    send().disabled = false; send().click(); await tick()
    expect(request).toHaveBeenCalledTimes(1)
    const payload = request.mock.calls[0]![2] as Record<string, unknown>
    expect(payload.to).toBe(''); expect(payload[field]).toBe('private-recipient@example.test'); expect(payload.html).not.toContain('private-recipient@example.test')
    expect(document.getElementById('mail-send-status')!.dataset.state).toBe('accepted')
  })
  it('keeps a server-refused stale sender draft and requires a fresh identity read before another send', async () => {
    const transport = vi.fn<Transport>(async method => {
      if (method === 'GET') return { identities: [identity()] }
      throw { status: 409, details: { stateChanged: false, identitySelectionRequired: true } }
    })
    boot(transport); new Function(MAIL_SEND_CLIENT_BINDING)(); await tick()
    const before = editor().textContent; send().click(); await tick(); send().click(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(send().disabled).toBe(true)
    expect(editor().textContent).toBe(before)
    expect(transport.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
  it.each([
    { mailbox: 'foreign@example.test', identityId: id(1), identityRevision: '1'.repeat(64) },
    { mailbox, identityId: id(2), identityRevision: '1'.repeat(64) },
    { mailbox, identityId: id(1), identityRevision: '2'.repeat(64) },
    { mailbox },
  ])('locks a mismatched saved-identity acknowledgement without clearing or resending: %j', async ack => {
    const transport = vi.fn<Transport>(async method => method === 'GET' ? { identities: [identity()] }
      : { messageId: '<accepted@example.test>', savedToSent: true, ...ack })
    boot(transport); new Function(MAIL_SEND_CLIENT_BINDING)(); await tick()
    const before = editor().textContent; send().click(); await tick(); send().click(); await tick()
    expect(document.getElementById('mail-send-status')!.dataset.state).toBe('uncertain')
    expect(editor().textContent).toBe(before); expect(send().disabled).toBe(true); expect(refresh().disabled).toBe(true)
    expect(transport.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1)
  })
})
