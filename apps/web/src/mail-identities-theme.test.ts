/// <reference lib="dom" />
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { msgctxt, msgid } from '@xpanel/core'
import { translator } from './i18n.ts'
import { MAIL_IDENTITIES_CLIENT_BINDING } from './mail-identities-client.ts'
import { renderMailIdentitiesWorkspace } from './board-port/xmail-identities.ts'
import { renderMailIdentitiesPage } from './themes/v2/pages/xmail/workspaces/settings.ts'
import { V2_MAIL_DYNAMIC_CSS } from './themes/v2/pages/xmail/client-templates.ts'
import { MAIL_WORKSPACES_CSS } from './themes/v2/pages/xmail/workspaces/common.ts'

type TestDom = { window: Window & typeof globalThis }
const peerRequire = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = peerRequire('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const doms: TestDom[] = []
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close() })
const mailbox = 'owner@example.test'
const identity = { id: '11111111-1111-4111-8111-111111111111', mailbox, email: mailbox, displayName: 'Actual saved identity', replyTo: 'long.' + 'part.'.repeat(20) + 'reply@example.test', textSignature: 'التوقيع 123 ' + 'word-'.repeat(40), htmlSignature: '<b>source</b>', isDefault: true, createdAt: '2026-10-27T12:34:56.123Z' }
const tick = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

describe.each(['classic', 'v2'] as const)('%s identity metadata actual theme contract', theme => {
  it.each(['en', 'ar'] as const)('keeps wrapping, label/value direction and exact transport in %s', async locale => {
    const body = theme === 'classic' ? renderMailIdentitiesWorkspace({ locale, mailbox, canManage: true })
      : `<style>${MAIL_WORKSPACES_CSS}${V2_MAIL_DYNAMIC_CSS}</style>` + renderMailIdentitiesPage({ locale, mailbox, route: '/mail/settings/identities', canRead: true, canManage: true })
    const dom = new JSDOM(`<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><body>${body}</body></html>`, { url: 'https://mail.example.test/mail/settings/identities', runScripts: 'outside-only' }); doms.push(dom)
    const send = vi.fn(async () => ({ identities: [identity] }))
    Object.assign(dom.window, { xpT: translator(locale), msgid, msgctxt, xpanelSessionRequest: send })
    const boot = dom.window.Function('return ' + MAIL_IDENTITIES_CLIENT_BINDING)() as (ask: unknown) => void
    boot(async () => false); await tick()
    const { document } = dom.window
    const card = document.querySelector('[data-identity-id]')!
    const fields = [...card.querySelectorAll<HTMLElement>('[data-identity-field]')]
    expect(fields.map(field => field.dataset.identityField)).toEqual(['email', 'reply-to', 'signature', 'created'])
    for (const field of fields) {
      expect([...field.children].map(node => node.tagName)).toEqual(['DT', 'DD'])
      const value = field.querySelector<HTMLElement>('dd>bdi')!
      expect(value.dir).toBe(field.dataset.identityField === 'signature' ? 'auto' : 'ltr')
      expect(dom.window.getComputedStyle(value).overflowWrap).toBe('anywhere')
      expect(dom.window.getComputedStyle(value).whiteSpace).toBe('normal')
      expect(dom.window.getComputedStyle(field).gap).toBe(theme === 'classic' ? 'var(--xp-space-label,8px)' : 'var(--space-1)')
    }
    expect(card.querySelector('[data-identity-field="reply-to"] bdi')!.textContent).toBe(identity.replyTo)
    expect(card.querySelector('[data-identity-field="signature"] bdi')!.textContent).toBe(identity.textSignature)
    card.querySelector<HTMLButtonElement>('[data-identities-action="edit"]')!.click()
    expect(document.querySelector<HTMLInputElement>('[data-identities-reply-to]')!.value).toBe(identity.replyTo)
    expect(document.querySelector<HTMLTextAreaElement>('[data-identities-text-signature]')!.value).toBe(identity.textSignature)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('GET', '/api/webmail/identities', undefined)
  })
})