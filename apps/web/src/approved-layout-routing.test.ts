import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWebApp } from './app.ts'

const renderers = vi.hoisted(() => ({
  panel: vi.fn(() => '<section data-approved-test="panel"></section>'),
  whm: vi.fn(() => '<section data-approved-test="whm"></section>'),
}))
vi.mock('./board-port/approved-xpanel-workspaces.ts', () => ({ renderApprovedXpanelWorkspace: renderers.panel }))
vi.mock('./board-port/approved-xwhm.ts', () => ({ renderWhmDetailPage: renderers.whm }))

beforeEach(() => { renderers.panel.mockClear(); renderers.whm.mockClear() })

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
    // CSS selectors and the shared client script mention action attributes; only actual elements are actionable.
    expect(html).not.toMatch(/<form\b|<[a-z][^>]*\b(?:contenteditable="true"|data-mail-send=|data-mail-action=|data-mail-uid=)/i)
    for (const value of ['private-mailbox-marker', 'private-recipient-marker', 'private-subject-marker', 'private-body-marker']) expect(html).not.toContain(value)
  })

  it('does not expose a mail workspace without an admitted identity', () => {
    const html = renderWebApp({ surface: 'xmail', activeRoute: '/mail/compose', locale: 'en', catalog: [] })
    expect(html).not.toContain('data-mail-read-only="true"')
  })
})
