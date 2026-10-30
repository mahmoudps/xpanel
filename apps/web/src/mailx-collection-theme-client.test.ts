// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import type { Account } from '@xpanel/core'
import { translator } from './i18n.ts'
import { renderMailxArchiveWorkspace } from './board-port/mailx-archive-workspace.ts'
import { renderMailxCollectionsWorkspace } from './board-port/mailx-collections-workspace.ts'
import { renderV2PanelEmailArchive } from './themes/v2/pages/xpanel/email-tools/archive-deliverability.ts'
import { renderV2PanelCalendarsContacts } from './themes/v2/pages/xpanel/email-tools/collaboration.ts'
import { MAILX_ARCHIVE_CLIENT_BINDING } from './mailx-archive-client.ts'
import { MAILX_COLLECTIONS_CLIENT_BINDING } from './mailx-collections-client.ts'

let dom: EnvironmentReturn | undefined
beforeEach(async () => { dom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test', runScripts: 'outside-only' } }) })
afterEach(async () => { document.body.replaceChildren(); delete (window as Window & { xpT?: unknown }).xpT; delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; await dom?.teardown(globalThis); dom = undefined })
const tick = async () => { for (let n = 0; n < 6; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const account: Account = { id: 'account-a', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'shop.example', planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const revision = 'a'.repeat(64), calendarId = 'b'.repeat(32), bookId = 'c'.repeat(32)
const archive = { saved: true, revision, choices: [{ domain: 'shop.example', mailboxes: ['archive@shop.example'] }], policy: { domains: [{ domain: 'shop.example', mailbox: 'archive@shop.example', incoming: true, outgoing: false, retentionDays: 30 }] }, updatedAt: null, observedAt: null, host: 'connected', state: 'applied', rows: [{ domain: 'shop.example', admission: 'eligible', conflicts: [] }], capabilities: { retentionJobs: true } }
const collections = { context: { account: 'alice' }, dav: { caldav: 'unavailable', carddav: 'unavailable' }, application: { davServed: false }, mailboxes: [{ mailbox: 'archive@shop.example', revision, defaultCalendar: calendarId, calendars: [{ id: calendarId, name: 'Work', description: 'Team description' }], addressBooks: [{ id: bookId, name: 'Clients', description: 'Saved addresses', isDefault: true }], taskLists: [] }] }
const calendars = { context: { account: 'alice' }, mailboxes: [{ mailbox: 'archive@shop.example', revision, calendars: [{ id: calendarId, name: 'Work', color: '#4f6bed', timezone: 'UTC' }] }] }

for (const theme of ['classic', 'v2'] as const) for (const family of ['archive', 'collections'] as const) {
  describe(theme + ' ' + family + ' selected-theme controller', () => {
    function mount(canManage = true) {
      const input = { locale: 'en' as const, canManage }
      document.body.innerHTML = theme === 'classic' ? family === 'archive' ? renderMailxArchiveWorkspace(input) : renderMailxCollectionsWorkspace(input)
        : family === 'archive' ? renderV2PanelEmailArchive({ locale: 'en', account }, { canRead: true, canManage }) : renderV2PanelCalendarsContacts({ locale: 'en', account }, { canRead: true, canManage })
      const send = vi.fn(async (_method: string, path: string) => family === 'archive' ? archive : path === '/api/account/collaboration' ? calendars : collections)
      Object.assign(window, { xpT: translator('en'), xpanelSessionRequest: send })
      return { send, boot: () => window.eval(family === 'archive' ? MAILX_ARCHIVE_CLIENT_BINDING : MAILX_COLLECTIONS_CLIENT_BINDING)(async () => true) }
    }
    it('populates actual owned templates through the serialized binding', async () => {
      const { send, boot } = mount(); boot(); await tick()
      expect(send).toHaveBeenCalledTimes(family === 'archive' ? 1 : 2)
      if (family === 'archive') {
        const row = document.querySelector<HTMLElement>('tr[data-domain="shop.example"]')!
        expect(row.querySelector<HTMLSelectElement>('[data-archive-mailbox]')!.value).toBe('archive@shop.example')
        expect(row.querySelector<HTMLInputElement>('[data-archive-direction="incoming"]')!.checked).toBe(true)
        expect(row.querySelector<HTMLInputElement>('[data-archive-days]')!.value).toBe('30')
        expect(row.querySelector<HTMLButtonElement>('[data-xp-slot="retention"]')!.disabled).toBe(false)
        if (theme === 'v2') expect(row.querySelector('[class^="xp-"]')).toBeNull()
      } else {
        const row = document.querySelector<HTMLElement>('[data-mailx-address-books] tr[data-item-id]')!
        expect(row.querySelector<HTMLInputElement>('[data-item-name]')!.value).toBe('Clients')
        expect(row.textContent).not.toContain(bookId)
        const area = document.querySelector<HTMLTextAreaElement>('[data-mailx-descriptions] textarea')!
        expect(area.value).toBe('Team description')
        expect(document.querySelector<HTMLLabelElement>('label[for="' + area.id + '"]')!.textContent).toContain('Work')
        if (theme === 'v2') expect(row.querySelector('[class^="xp-"]')).toBeNull()
      }
    })
    for (const defect of ['missing', 'duplicate', 'wrong-slot', 'wrong-tag'] as const) it('rejects ' + defect + ' contract before any GET', async () => {
      const { send, boot } = mount(), root = document.querySelector<HTMLElement>('[data-mailx-' + family + ']')!
      const template = root.querySelector<HTMLTemplateElement>('template[data-xp-template="' + (family === 'archive' ? 'mailx-archive-row' : 'mailx-collection-row') + '"]')!
      if (defect === 'missing') template.remove()
      else if (defect === 'duplicate') template.after(template.cloneNode(true))
      else if (defect === 'wrong-slot') template.content.querySelector('[data-xp-slot]')!.remove()
      else { const slot = template.content.querySelector('[data-xp-slot]')!, replacement = document.createElement('span'); replacement.setAttribute('data-xp-slot', slot.getAttribute('data-xp-slot')!); slot.replaceWith(replacement) }
      boot(); await tick()
      expect(send).not.toHaveBeenCalled()
      expect([...root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,button,textarea')].every(control => control.disabled)).toBe(true)
      expect(root.querySelector('[data-mailx-' + family + '-status]')?.textContent).toContain('Nothing was read')
    })
    it('preserves denied admission without reading or exposing selected rows', async () => {
      const { send, boot } = mount(false); boot(); await tick()
      expect(send).not.toHaveBeenCalled()
      expect(document.querySelector('tr[data-domain],tr[data-item-id]')).toBeNull()
    })
  })
}
