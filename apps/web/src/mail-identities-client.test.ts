// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMailIdentitiesWorkspace } from './board-port/xmail-identities.ts'
import {
  MAIL_IDENTITIES_CLIENT_BINDING, identityDraft, identityMatchesDraft, readMailIdentities, readMailIdentity,
} from './mail-identities-client.ts'

const mailbox = 'inbox@example.test'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const stored = () => ([
  { id: '11111111-1111-4111-8111-111111111111', mailbox, displayName: 'Primary', email: mailbox, replyTo: mailbox, textSignature: '— Primary', htmlSignature: '<p>— Primary</p>', isDefault: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', mailbox, displayName: 'Secondary', email: mailbox, replyTo: 'other@example.test', textSignature: '', htmlSignature: '', isDefault: false, createdAt: '2026-01-02T00:00:00.000Z' },
])
const field = (selector: string) => document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click()
const status = () => document.querySelector<HTMLElement>('[data-identities-status]')!

describe('mail identities helpers', () => {
  it('validates identities and enforces a single default', () => {
    expect(readMailIdentities({ identities: stored() }, mailbox)).toHaveLength(2)
    expect(readMailIdentity(stored()[0]!, mailbox).displayName).toBe('Primary')
    for (const bad of [
      { identities: [...stored(), { ...stored()[0], id: '33333333-3333-4333-8333-333333333333' }] },
      { identities: [{ ...stored()[0], mailbox: 'foreign@example.test' }] },
      { identities: [{ ...stored()[0], displayName: 'x'.repeat(201) }] },
      { identities: [{ ...stored()[0], replyTo: 'not-an-email' }] },
      { identities: [{ ...stored()[0], isDefault: 'yes' }] },
      null,
    ]) expect(() => readMailIdentities(bad, mailbox)).toThrow()
  })
  it('builds a bounded draft and compares readback fields', () => {
    const draft = identityDraft({ displayName: '  Named  ', replyTo: 'reply@example.test', textSignature: 'sig', htmlSignature: '<p>sig</p>', isDefault: false })
    expect(draft).toEqual({ displayName: 'Named', replyTo: 'reply@example.test', textSignature: 'sig', htmlSignature: '<p>sig</p>', isDefault: false })
    expect(identityMatchesDraft(stored()[1]!, draft)).toBe(false)
    for (const bad of [
      { displayName: '', replyTo: 'a@b.test', textSignature: '', htmlSignature: '', isDefault: false },
      { displayName: 'x', replyTo: 'bad', textSignature: '', htmlSignature: '', isDefault: false },
      { displayName: 'x', replyTo: 'a@b.test', textSignature: 'x'.repeat(20001), htmlSignature: '', isDefault: false },
      { displayName: 'x', replyTo: 'a@b.test', textSignature: '', htmlSignature: '', isDefault: 'yes' },
    ]) expect(() => identityDraft(bad)).toThrow()
  })
})

describe('mail identities browser binding', () => {
  beforeEach(() => {
    document.body.innerHTML = renderMailIdentitiesWorkspace({ locale: 'en', mailbox, canManage: true })
    document.documentElement.lang = 'en'
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  })
  const boot = (transport: ReturnType<typeof vi.fn>) => {
    (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    new Function(`(${MAIL_IDENTITIES_CLIENT_BINDING})((options) => Promise.resolve(true));`)()
  }
  it('constructs the binding, renders the section and contains no form/fetch', () => {
    expect(() => new Function('return ' + MAIL_IDENTITIES_CLIENT_BINDING)()).not.toThrow()
    expect(MAIL_IDENTITIES_CLIENT_BINDING).not.toContain('fetch(')
    expect(document.querySelector('[data-mail-identities]')).not.toBeNull()
    expect(document.querySelectorAll('form')).toHaveLength(0)
  })
  it('disables everything with an explicit unavailable state without a transport', () => {
    new Function(`(${MAIL_IDENTITIES_CLIENT_BINDING})(undefined);`)()
    expect(status().dataset.state).toBe('unavailable')
    for (const node of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>('[data-mail-identities] button, [data-mail-identities] input, [data-mail-identities] textarea')) expect(node.disabled).toBe(true)
  })
  it('states the ownership review boundary without claiming or exposing withheld records', async () => {
    const hidden = '99999999-9999-4999-8999-999999999999'
    boot(vi.fn(async () => ({ identities: [], metadataReview: { status: 'review_required', reason: 'mailbox_metadata_binding_unverified' }, ownerAuthority: { accountId: hidden, serviceUserId: hidden } }))); await tick()
    const text = document.querySelector('[data-mail-identities]')!.textContent!
    expect(text).toContain('No identity with verified mailbox ownership is available'); expect(text).toContain('Older metadata may need review')
    expect(text).not.toContain(hidden); expect(text).not.toContain('mailbox_metadata_binding_unverified'); expect(text).not.toContain('No identities have been saved')
    expect(document.querySelector('[data-identity-id]')).toBeNull(); expect(document.querySelector<HTMLButtonElement>('[data-identities-save]')!.disabled).toBe(false)
  })
  it('reads identities and creates a new default identity with readback verification', async () => {
    let identities = stored()
    const calls: { method: string; path: string; body?: unknown }[] = []
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) })
      if (method === 'GET') return { identities }
      if (method === 'POST') {
        const created = { id: '44444444-4444-4444-8444-444444444444', mailbox, displayName: 'Third', email: mailbox, replyTo: 'third@example.test', textSignature: 'third', htmlSignature: '', isDefault: true, createdAt: '2026-01-03T00:00:00.000Z' }
        identities = [...identities.map(identity => ({ ...identity, isDefault: false })), created]
        return { identity: created }
      }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    expect(document.querySelectorAll('[data-identity-id]')).toHaveLength(2)
    field('[data-identities-display-name]').value = 'Third'
    field('[data-identities-reply-to]').value = 'third@example.test'
    field('[data-identities-text-signature]').value = 'third'
    ;(field('[data-identities-default]') as HTMLInputElement).checked = true
    click('[data-identities-save]'); await tick(); await tick()
    const post = calls.find(call => call.method === 'POST')
    expect(post?.body).toMatchObject({ email: mailbox, displayName: 'Third', replyTo: 'third@example.test', textSignature: 'third', htmlSignature: '', isDefault: true })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-identity-id]')).toHaveLength(3)
  })
  it('sets the default identity exclusively and reports stale/refused states truthfully', async () => {
    let identities = stored()
    const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return { identities }
      if (method === 'PATCH') {
        const payload = body as { isDefault?: boolean }
        if (payload.isDefault) identities = identities.map(identity => ({ ...identity, isDefault: identity.id === '22222222-2222-4222-8222-222222222222' }))
        return { identity: identities.find(identity => identity.id === '22222222-2222-4222-8222-222222222222') }
      }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    const setDefault = [...document.querySelectorAll<HTMLButtonElement>('[data-identities-action="default"]')][0]!
    setDefault.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector<HTMLElement>('[data-identity-id="22222222-2222-4222-8222-222222222222"]')!.textContent).toContain('Default identity')
  })
  it('deletes an identity only after confirmation and verifies absence', async () => {
    let identities = stored()
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return { identities }
      if (method === 'DELETE') { identities = identities.filter(identity => identity.id !== '22222222-2222-4222-8222-222222222222'); return { ok: true } }
      throw new Error('unexpected_request')
    })
    boot(transport); await tick()
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[data-identities-action="delete"]')][1]!
    remove.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelectorAll('[data-identity-id]')).toHaveLength(1)
  })
  it('locks writes after an uncertain outcome', async () => {
    const transport = vi.fn(async (method: string) => {
      if (method === 'GET') return { identities: stored() }
      throw { status: 503, details: { verificationRequired: true } }
    })
    boot(transport); await tick()
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[data-identities-action="delete"]')][1]!
    remove.click(); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('[data-identities-save]')!.disabled).toBe(true)
  })
})


describe('reachable metadata datetime', () => {
  it.each(['en', 'ar'] as const)('renders readable creation time in %s without formatting signature or stored identity data', async locale => {
    const createdAt = '2026-10-27T12:34:56.123456Z', signature = 'Original signature 2026-10-27T12:34:56.123456Z'
    const identities = stored().map((identity, index) => ({ ...identity, createdAt: index ? '2026-10-27T12:34:56.000Z' : createdAt, textSignature: signature }))
    const transport = vi.fn(async (_method: string, _path: string) => ({ identities }))
    document.body.innerHTML = renderMailIdentitiesWorkspace({ locale, mailbox, canManage: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    try {
      new Function('return ' + MAIL_IDENTITIES_CLIENT_BINDING)()(async () => false)
      await tick()
      const cards = [...document.querySelectorAll('[data-identity-id]')]
      expect(cards[0]!.querySelector('[data-identity-created-at]')!.textContent).toBe('2026-10-27 12:34 UTC')
      expect(cards[1]!.querySelector('[data-identity-created-at]')!.textContent).toBe('2026-10-27 12:34 UTC')
      expect(cards[0]!.querySelector('[data-identity-field="signature"] dd bdi')!.textContent).toBe(signature)
      expect(readMailIdentities({ identities }, mailbox)[0]!.createdAt).toBe(createdAt)
      expect(identities[0]!.createdAt).toBe(createdAt)
      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport).toHaveBeenCalledWith('GET', '/api/webmail/identities', undefined)
    } finally { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})


describe('identity metadata field grouping', () => {
  it.each(['en', 'ar'] as const)('keeps complete label/value pairs and isolated wrapping values in %s without changing identity actions or transport', async locale => {
    const createdAt = '2026-10-27T12:34:56.123456Z', signature = 'Original signature\n' + 'long-value-'.repeat(24) + ' العربية 123'
    const replyTo = 'long.' + 'value.'.repeat(12) + 'reply@example.test'
    const identities = stored().map(identity => ({ ...identity, createdAt, replyTo, textSignature: signature }))
    const transport = vi.fn(async (_method: string, _path: string, _body?: unknown) => ({ identities }))
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = renderMailIdentitiesWorkspace({ locale, mailbox, canManage: true })
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
    try {
      new Function('return ' + MAIL_IDENTITIES_CLIENT_BINDING)()(async () => false)
      await tick()
      const cards = [...document.querySelectorAll('[data-identity-id]')]
      expect(cards).toHaveLength(2)
      const labels = locale === 'ar' ? ['البريد', 'الرد إلى', 'التوقيع النصي', 'أُنشئت'] : ['Email', 'Reply-to', 'Plain signature', 'Created']
      const values = [mailbox, replyTo, signature, '2026-10-27 12:34 UTC']
      for (const [index, card] of cards.entries()) {
        const list = card.querySelector('dl')!, pairs = [...list.children]
        expect(pairs).toHaveLength(4)
        expect(list.querySelector(':scope > dt, :scope > dd')).toBeNull()
        expect(pairs.map(pair => pair.getAttribute('data-identity-field'))).toEqual(['email', 'reply-to', 'signature', 'created'])
        pairs.forEach((pair, fieldIndex) => {
          expect(pair.tagName).toBe('DIV')
          expect([...pair.children].map(child => child.tagName)).toEqual(['DT', 'DD'])
          expect(pair.querySelector('dt')!.textContent).toBe(labels[fieldIndex])
          const value = pair.querySelector<HTMLElement>('dd > bdi')!
          expect(value.dir).toBe('ltr')
          expect(value.textContent).toBe(values[fieldIndex])
          expect(value.style.overflowWrap).toBe('anywhere')
          expect(value.style.whiteSpace).toBe('normal')
        })
        expect(card.querySelector('[data-identity-field="created"] > dd > [data-identity-created-at]')!.textContent).toBe('2026-10-27 12:34 UTC')
        expect([...card.querySelectorAll('[data-identities-action]')].map(button => button.getAttribute('data-identities-action'))).toEqual(index ? ['edit', 'default', 'delete'] : ['edit', 'delete'])
      }
      expect(document.querySelector('[data-mail-identities]')!.getAttribute('dir')).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      cards[0]!.querySelector<HTMLButtonElement>('[data-identities-action="edit"]')!.click()
      expect(document.querySelector('[data-identities-form-title]')!.textContent).toBe(locale === 'ar' ? 'تحرير الهوية: Primary' : 'Edit identity: Primary')
      expect(field('[data-identities-reply-to]').value).toBe(replyTo)
      expect(field('[data-identities-text-signature]').value).toBe(signature)
      expect(field('[data-identities-html-signature]').value).toBe(identities[0]!.htmlSignature)
      expect(identities[0]!.createdAt).toBe(createdAt)
      expect(transport).toHaveBeenCalledTimes(1)
      expect(transport).toHaveBeenCalledWith('GET', '/api/webmail/identities', undefined)
    } finally { document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest }
  })
})
