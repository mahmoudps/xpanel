/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWebApp } from './app.ts'
import { parseMarkup } from './html.ts'

const renderers = vi.hoisted(() => ({
  panel: vi.fn(() => '<section data-approved-test="panel"></section>'),
  whm: vi.fn(() => '<section data-approved-test="whm"></section>'),
}))
vi.mock('./board-port/approved-xpanel-workspaces.ts', () => ({ renderApprovedXpanelWorkspace: renderers.panel }))
vi.mock('./board-port/approved-xwhm.ts', () => ({ renderWhmDetailPage: renderers.whm }))

beforeEach(() => { renderers.panel.mockClear(); renderers.whm.mockClear() })

// Only the admitted session menu may display this supplied mailbox identity.
// Keep the original whole-document payload exclusion after removing that one menu.
const expectMailboxOnlyInChrome = (html: string, mailbox: string, marker: string): void => {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const menus = document.querySelectorAll('details[data-user-menu]')
  expect(menus).toHaveLength(1)
  const menu = menus.item(0)
  expect(menu?.closest('header')).not.toBeNull()
  expect(menu?.closest('[data-tool-availability="unverified"]')).toBeNull()
  expect(menu?.textContent).toContain(mailbox)
  menu?.remove()
  expect(document.documentElement.outerHTML).not.toContain(marker)
}
const expectReadOnlyMailWorkspace = (html: string): void => {
  const nodes = parseMarkup(html)
  const roots = nodes.flatMap((node, index) => node.attrs.get('data-tool-availability') === 'unverified' ? [index] : [])
  expect(roots).toHaveLength(1)
  const root = roots[0]!
  const workspace = nodes.filter((_node, index) => {
    for (let current = index; current >= 0; current = nodes[current]!.parent) if (current === root) return true
    return false
  })
  expect(workspace.some(node => node.attrs.get('data-mail-read-only') === 'true')).toBe(true)
  for (const node of workspace) {
    expect(node.tag).not.toBe('form')
    expect(node.attrs.get('contenteditable')?.toLowerCase()).not.toBe('true')
    for (const attribute of ['data-mail-send', 'data-mail-action', 'data-mail-uid']) expect(node.attrs.has(attribute)).toBe(false)
  }
}

describe('approved layout admission boundary', () => {
  it('retains a known owner layout without forwarding unqualified provider data', () => {
    const html = renderWebApp({
      surface: 'xpanel', activeRoute: '/resources', locale: 'en', catalog: [],
      visibility: { principal: { kind: 'user', id: 'u1', username: 'owner7', accountId: 'a1' } },
      panel: { recentAudit: [{ action: 'private-audit-marker', target: 'private-target-marker' }] },
    })
    expect(html).toContain('data-approved-test="panel"')
    expect(html).toContain('data-tool-availability="unverified"')
    expect(renderers.panel).toHaveBeenCalledExactlyOnceWith({ route: '/resources', locale: 'en', readOnly: true })
    expect(html).not.toContain('private-audit-marker')
    expect(html).not.toContain('private-target-marker')
    expect(html).not.toContain('data-realtime-enabled="true"')
  })

  it('retains a known root layout as unavailable rather than admitting its operations', () => {
    const html = renderWebApp({
      surface: 'xwhm', activeRoute: '/whm/plans/features', locale: 'ar', catalog: [],
      visibility: { principal: { kind: 'root', id: 'root1', username: 'administrator7' } },
      whm: { featureLists: [{ id: 'private-feature-id', name: 'private-feature-name' }] },
    })
    expect(html).toContain('data-approved-test="whm"')
    expect(renderers.whm).toHaveBeenCalledExactlyOnceWith({ activeRoute: '/whm/plans/features', locale: 'ar', capabilityUnavailable: true })
    expect(html).not.toContain('private-feature-name')
    expect(html).not.toContain('private-feature-id')
  })

  it.each([undefined, { principal: { kind: 'user' as const, id: 'u1', username: 'owner7', accountId: 'a1' } }])('does not call a root layout renderer for absent or wrong-role identity', visibility => {
    renderWebApp({ surface: 'xwhm', activeRoute: '/whm/plans/features', locale: 'en', catalog: [], visibility })
    expect(renderers.whm).not.toHaveBeenCalled()
  })

  it('does not admit unknown routes merely to show an approved layout', () => {
    renderWebApp({ surface: 'xpanel', activeRoute: '/not-a-registered-document', locale: 'en', catalog: [],
      visibility: { principal: { kind: 'user', id: 'u1', username: 'owner7', accountId: 'a1' } } })
    expect(renderers.panel).not.toHaveBeenCalled()
    expect(renderers.whm).not.toHaveBeenCalled()
  })
})


describe('unqualified approved mail layout', () => {
  it.each(['/mail/inbox', '/mail/compose'])('retains %s without exposing mailbox data or live actions', route => {
    const html = renderWebApp({
      surface: 'xmail', activeRoute: route, locale: 'ar', theme: 'dark', catalog: [],
      visibility: { principal: { kind: 'user', id: 'u1', username: 'owner7', accountId: 'a1' } },
      mail: { mailbox: 'private-mailbox-marker@example.test', messages: [],
        composeDraft: { to: 'private-recipient-marker@example.test', cc: '', subject: 'private-subject-marker', body: 'private-body-marker' } },
    })
    expect(html).toContain('data-mail-read-only="true"')
    expect(html).toContain('data-mail-layout="reference"')
    expect(html).toContain('data-quota-ratio="unknown"')
    // Personal preferences remain outside this unqualified native workspace.
    expectReadOnlyMailWorkspace(html)
    expectMailboxOnlyInChrome(html, 'private-mailbox-marker@example.test', 'private-mailbox-marker')
    for (const value of ['private-recipient-marker', 'private-subject-marker', 'private-body-marker']) expect(html).not.toContain(value)
  })

  it.each([
    ['form', '<form><input type="password" disabled></form>'],
    ['editable', '<div contenteditable="true"></div>'],
    ['send', '<button data-mail-send disabled></button>'],
    ['action', '<template><button data-mail-action="archive" disabled></button></template>'],
    ['uid', '<div data-mail-uid="1"></div>'],
  ])('rejects actual %s controls inside the unqualified workspace', (_kind, controls) => {
    const html = '<section data-tool-availability="unverified"><section data-mail-read-only="true">' + controls + '</section></section>'
    expect(() => expectReadOnlyMailWorkspace(html)).toThrow()
  })

  it('keeps the independent chooser outside the workspace and rejects native sibling forms within it', () => {
    const mail = '<section data-mail-read-only="true"><p>Not read</p></section>'
    const chooser = '<form data-ui-theme-form><select data-ui-theme-choice disabled></select></form>'
    expectReadOnlyMailWorkspace(chooser + '<section data-tool-availability="unverified">' + mail + '</section>')
    expect(() => expectReadOnlyMailWorkspace('<section data-tool-availability="unverified">' + mail + '<form><button disabled>Send</button></form></section>')).toThrow()
  })

  it('does not expose a mail workspace without an admitted identity', () => {
    const html = renderWebApp({ surface: 'xmail', activeRoute: '/mail/compose', locale: 'en', catalog: [] })
    expect(html).not.toContain('data-mail-read-only="true"')
  })
})
