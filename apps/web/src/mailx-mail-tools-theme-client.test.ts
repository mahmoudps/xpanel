// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { defaultPlan, type Account } from '@xpanel/core'
import { translator } from './i18n.ts'
import { renderMailxMailToolsWorkspace } from './board-port/mailx-mail-tools-workspace.ts'
import { renderV2PanelSpamFilters } from './themes/v2/pages/xpanel/email-tools/spam.ts'
import { renderV2PanelMailingLists } from './themes/v2/pages/xpanel/email-tools/mailing-lists.ts'
import { MAILX_MAIL_TOOLS_CLIENT_BINDING } from './mailx-mail-tools-client.ts'

let environment: EnvironmentReturn | undefined
beforeEach(async () => { environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test', runScripts: 'outside-only' } }) })
afterEach(async () => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; await environment?.teardown(globalThis); environment = undefined })
const tick = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const account: Account = { id: 'account-owner', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan-owner', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const props = { account, plan: defaultPlan({ id: account.planId, name: 'Plan' }), domains: [] }
const revision = 'a'.repeat(64)
const response = (section: 'spam' | 'lists') => section === 'lists'
  ? { host: 'connected', observedAt: '2026-10-29T12:00:00.000Z', aliases: 'read', compositeRevision: revision, capabilities: { moderation: false, archive: false }, lists: [{ address: '<literal>@example.test', members: 2, state: 'delivering' }] }
  : { host: 'connected', observedAt: '2026-10-29T12:00:00.000Z', engine: { engine: 'rspamd', wiring: 'wired' }, compositeRevision: revision, capabilities: { learning: true, boxTrapper: false }, mailboxes: [{ mailbox: '<literal>@example.test', preference: 'saved', native: 'applied', effects: { allowlist: true, filtering: false, score: false, blocklist: false, spamBox: false } }] }
function mount(theme: 'classic' | 'v2', section: 'spam' | 'lists', canManage = true) {
  document.body.innerHTML = theme === 'classic' ? renderMailxMailToolsWorkspace({ locale: 'en', section, canManage })
    : section === 'spam' ? renderV2PanelSpamFilters(props, { canRead: true, canManage }) : renderV2PanelMailingLists(props, { canRead: true, canManage })
  const root = document.querySelector<HTMLElement>('[data-mailx-tools]')!
  const send = vi.fn(async (method: string) => method === 'GET' ? response(section) : { job: { id: 'internal-job', status: 'queued' } })
  Object.assign(window, { xpT: translator('en'), xpanelSessionRequest: send })
  const boot = () => { (window as unknown as { eval(code: string): void }).eval('(' + MAILX_MAIL_TOOLS_CLIENT_BINDING + ')(async()=>true)') }
  return { root, send, boot }
}
describe.each(['classic', 'v2'] as const)('%s observed mail tool templates', theme => {
  for (const section of ['spam', 'lists'] as const) {
    it('renders ' + section + ' observations through the real selected-theme binding', async () => {
      const { root, send, boot } = mount(theme, section); boot(); await tick()
      expect(send).toHaveBeenCalledWith('GET', section === 'spam' ? '/api/account/mailx/mail-tools' : '/api/account/mailx/mail-tools/lists')
      const rows = root.querySelector('[data-mailx-' + (section === 'spam' ? 'tools' : 'lists') + '-rows]')!
      expect(rows.textContent).toContain('<literal>@example.test'); expect(rows.querySelector('literal')).toBeNull()
      expect(rows.querySelector('th bdi')?.getAttribute('dir')).toBe('ltr')
      if (section === 'spam') {
        const button = rows.querySelector<HTMLButtonElement>('[data-direction="spam"]')!
        expect(button.disabled).toBe(false); button.click(); await tick()
        expect(send).toHaveBeenCalledWith('POST', '/api/account/mailx/mail-tools/learn', { mailbox: '<literal>@example.test', direction: 'spam', expectedRevision: revision })
        expect(button.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
      }
    })
    for (const defect of ['missing', 'duplicate', 'slot', 'wrong-tag'] as const) it(section + ' refuses ' + defect + ' markup before GET', async () => {
      const { root, send, boot } = mount(theme, section)
      const template = root.querySelector<HTMLTemplateElement>('template[data-xp-template="mail-tools-' + (section === 'spam' ? 'spam' : 'list') + '-row"]')!
      if (defect === 'missing') template.remove()
      else if (defect === 'duplicate') template.after(template.cloneNode(true))
      else if (defect === 'slot') template.content.querySelector('[data-xp-slot]')!.removeAttribute('data-xp-slot')
      else { const old = template.content.querySelector('[data-xp-slot]')!; const wrong = document.createElement('span'); wrong.setAttribute('data-xp-slot', old.getAttribute('data-xp-slot')!); old.replaceWith(wrong) }
      boot(); await tick(); expect(send).not.toHaveBeenCalled()
      expect(root.querySelector('[data-mailx-' + (section === 'spam' ? 'tools' : 'lists') + '-status]')?.getAttribute('data-state')).toBe('unavailable')
      expect([...root.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    })
    it(section + ' keeps denied admission unread', async () => { const { send, boot } = mount(theme, section, false); boot(); await tick(); expect(send).not.toHaveBeenCalled() })
  }
})
