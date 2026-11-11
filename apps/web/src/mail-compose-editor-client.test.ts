/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIL_DRAFT_CLIENT_BINDING } from './mail-draft-client.ts'
import { pageScriptBodies } from './page-scripts.ts'
import { renderXmailCompose, xmailComposeFromProps } from './board-port/xmail-compose.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { renderV2MailCompose } from './themes/v2/pages/xmail/compose.ts'

const mailbox = 'owner@example.test'
const THEMES: Readonly<Record<string, () => string>> = {
  classic: () => renderXmailCompose(xmailComposeFromProps({ mailbox })),
  v2: () => renderV2MailCompose(v2Messages.translator('en'), {
    mailbox, route: '/mail/compose', title: 'New message', kind: 'compose', quota: { text: '—', percent: null }, folders: [], customFolders: [], canCompose: true,
    draft: { to: '', cc: '', bcc: '', subject: '', body: '' },
    canSend: false, canSaveDraft: false, canUseAttachments: false, canManageVacation: false, canManageFilters: false, identity: {}, vacation: null, rules: null,
  }),
}
const get = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const boot = (theme: string) => {
  const html = THEMES[theme]!()
  const bodies = pageScriptBodies(html)
  expect(bodies).toHaveLength(1)
  document.body.innerHTML = html
  new Function(bodies[0]!)()
}
const browser = document as { execCommand?: unknown; queryCommandState?: unknown }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); delete browser.execCommand; delete browser.queryCommandState })

describe('compose behaviour shared by the themes', () => {
  it('serves both themes the same script', () => {
    expect(pageScriptBodies(THEMES.v2!())).toEqual(pageScriptBodies(THEMES.classic!()))
  })

  describe.each(Object.keys(THEMES))('%s', theme => {
    it('applies a formatting button to the selection in the body and marks it pressed', () => {
      boot(theme)
      const editor = get('#compose-body')
      editor.textContent = 'hello'
      const range = document.createRange(); range.selectNodeContents(editor)
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      // jsdom has no editing commands: this stands in for the browser's bold on the restored selection.
      const exec = vi.fn((command: string) => {
        if (command === 'bold') window.getSelection()!.getRangeAt(0).surroundContents(document.createElement('b'))
        return true
      })
      Object.assign(document, { execCommand: exec, queryCommandState: (command: string) => command === 'bold' })
      get('[data-mail-format="bold"]').click()
      expect(exec).toHaveBeenCalledWith('bold', false, null)
      expect(editor.innerHTML).toBe('<b>hello</b>')
      expect(get('[data-mail-format="bold"]').getAttribute('aria-pressed')).toBe('true')
      expect(get('[data-mail-format="italic"]').getAttribute('aria-pressed')).toBe('false')
      expect(get('[data-mail-feedback]').hidden).toBe(true)
    })

    it('says so and leaves the body alone when the browser cannot format', () => {
      boot(theme)
      get('#compose-body').textContent = 'hello'
      get('[data-mail-format="italic"]').click()
      expect(get('#compose-body').innerHTML).toBe('hello')
      expect(get('[data-mail-feedback]').hidden).toBe(false)
      expect(get('[data-mail-feedback]').getAttribute('role')).toBe('alert')
      expect(get('[data-mail-feedback]').textContent).toBe('Formatting could not be applied. Your message is unchanged.')
    })

    it('turns a typed recipient into a chip on Enter or a comma, flags a bad address and removes a chip', () => {
      boot(theme)
      const to = get<HTMLInputElement>('#compose-to')
      to.value = 'Ann <ann@example.test>'
      to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      const chip = get('[data-mail-recip="to"] ul > [data-mail-chip="to"]')
      expect(chip.dataset.addr).toBe('ann@example.test')
      expect(chip.dataset.invalid).toBe('false')
      expect(to.value).toBe('')
      expect(to.placeholder).toBe('Add another')
      const cc = get<HTMLInputElement>('#compose-cc')
      cc.value = 'not-an-address,'
      cc.dispatchEvent(new Event('input'))
      expect(get('[data-mail-chip="cc"]').dataset.invalid).toBe('true')
      expect(get('[data-mail-chip="cc"]').textContent).toContain('· check address')
      get('[data-mail-chip="to"] [data-mail-action="remove-chip"]').click()
      expect(document.querySelector('[data-mail-chip="to"]')).toBeNull()
      expect(to.placeholder).toBe('Add a recipient')
    })

    it('asks before discarding and goes back to the idle button on Keep editing', () => {
      boot(theme)
      const group = get('[data-mail-discard]')
      const idle = group.innerHTML
      get('[data-mail-action="discard-ask"]').click()
      expect(group.querySelector('span')!.textContent).toBe('Discard this draft?')
      expect(group.querySelector('a')!.getAttribute('href')).toBe('/mail/inbox')
      expect(group.querySelector('a')!.textContent).toBe('Discard draft')
      expect(group.querySelector('[data-mail-action="discard-ask"]')).toBeNull()
      get('[data-mail-action="discard-cancel"]').click()
      expect(group.children).toHaveLength(1)
      expect(group.querySelector('[data-mail-action="discard-ask"]')!.textContent).toBe('Discard')
      expect(group.innerHTML).toBe(idle)
      get('[data-mail-action="discard-ask"]').click(); get('[data-mail-action="discard-cancel"]').click()
      expect(group.innerHTML).toBe(idle)
    })

    it('emits input on plain-text paste and chip edits so Save draft tracks every compose change', async () => {
      const html = theme === 'classic'
        ? renderXmailCompose({ ...xmailComposeFromProps({ mailbox }), canSaveDraft: true, canSend: true, fromOptions: [{ value: '', label: mailbox }], fromValue: '' })
        : renderV2MailCompose(v2Messages.translator('en'), {
          mailbox, route: '/mail/compose', title: 'New message', kind: 'compose', quota: { text: '—', percent: null }, folders: [], customFolders: [], canCompose: true,
          draft: { to: '', cc: '', bcc: '', subject: '', body: '' },
          canSend: true, canSaveDraft: true, canUseAttachments: false, canManageVacation: false, canManageFilters: false, identity: {}, vacation: null, rules: null,
        })
      const bodies = pageScriptBodies(html)
      document.body.innerHTML = html
      const identities = get('[data-compose-identities]') as HTMLElement & { xpanelReadComposeAttachments?: () => readonly unknown[] }
      identities.dataset.composeIdentitiesState = 'ready'
      identities.xpanelReadComposeAttachments = () => []
      const request = vi.fn(async (_method: string, _path: string, body?: unknown) => ({
        mailbox, folder: 'Drafts', status: 'saved',
        draft: { uid: request.mock.calls.length + 10, uidValidity: 7, revision: 'a'.repeat(64), messageId: '<draft@example.test>' },
        previousDraft: (body as { expectedDraft?: unknown } | undefined)?.expectedDraft ? 'retired' : 'none',
        reviewRequired: false,
      }))
      ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
      try {
        new Function(bodies[0]!)()
        new Function('return ' + MAIL_DRAFT_CLIENT_BINDING)()()
        const save = get<HTMLButtonElement>('[data-mail-action="save-draft"]')
        const editor = get('#compose-body')
        expect(save.disabled).toBe(true)

        const paste = (plain: string) => {
          const range = document.createRange()
          range.selectNodeContents(editor)
          range.collapse(false)
          window.getSelection()!.removeAllRanges()
          window.getSelection()!.addRange(range)
          const event = new Event('paste', { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? plain : '' } })
          editor.dispatchEvent(event)
          return event
        }

        const firstPaste = paste('First line\nSecond line')
        expect(firstPaste.defaultPrevented).toBe(true)
        expect(editor.innerHTML).toContain('First line<br>Second line')
        expect(save.disabled).toBe(false)

        save.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(save.disabled).toBe(true)

        paste('\nAppended line')
        expect(save.disabled).toBe(false)

        save.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(save.disabled).toBe(true)

        const to = get<HTMLInputElement>('#compose-to')
        to.value = 'ann@example.test'
        to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
        expect(save.disabled).toBe(false)

        save.click()
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(save.disabled).toBe(true)

        get('[data-mail-chip="to"] [data-mail-action="remove-chip"]').click()
        expect(save.disabled).toBe(false)
      } finally {
        delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
      }
    })
  })
})
