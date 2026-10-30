import { describe, expect, it } from 'vitest'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import { MAIL_WORKSPACE_ROUTES, projectMailSurfaceView } from '../../../models/mail.ts'
import { parseMarkup } from '../../markup.ts'
import { mailWorkspaceRoutes } from '../pages/xmail/workspaces/index.ts'
import { renderV2AccountSecuritySlot, V2_SECURITY_SLOT } from './slots.ts'
import { createV2MailSurface } from './xmail.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const visibility: VisibilityContext = { principal: { kind: 'user', id: 'mail-owner', username: 'owner', accountId: 'mail-account' }, disabledFeatures: new Set() }
const render = createV2MailSurface(projectMailSurfaceView, () => '<section data-core-unavailable>Unavailable</section>')
const props = { mailbox: 'owner@example.test', visibility, catalog, locale: 'en' as const }

describe('v2 complete mailbox surface integration', () => {
  it.each(MAIL_WORKSPACE_ROUTES)('mounts the actual workspace %s inside one mailbox shell', activeRoute => {
    const html = render({ ...props, activeRoute })
    expect(html).toContain(`data-mail-workspace-route="${activeRoute}"`)
    expect(html).not.toContain('data-core-unavailable')
    expect(html.match(/id="main-content"/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html.match(/class="v2-crumbs"/g)).toHaveLength(1)
    expect(html).not.toContain('xp-board-port')
    expect(html).not.toMatch(/<script\b/)
  })

  it('keeps the projector and renderer exact route sets synchronized', () => {
    expect([...MAIL_WORKSPACE_ROUTES].sort()).toEqual([...mailWorkspaceRoutes].sort())
  })

  it('leaves security replacement to core and emits only one selected-theme host', () => {
    const html = render({ ...props, activeRoute: '/mail/settings/security' })
    expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
    expect(html).not.toContain('data-auth-setup-form')
    const complete = renderV2AccountSecuritySlot({ bodyHtml: html, security: { locale: 'en', principalKind: 'user', surface: 'xmail', mfaMode: 'optional', totpEnabled: false } })
    expect(complete).not.toContain(V2_SECURITY_SLOT)
    expect(complete.match(/data-account-security="two-factor"/g)).toHaveLength(1)
    expect(complete.match(/data-auth-setup-form/g)).toHaveLength(1)
    expect(() => renderV2AccountSecuritySlot({ bodyHtml: complete, security: { locale: 'en', principalKind: 'user', surface: 'xmail', mfaMode: 'optional', totpEnabled: false } })).toThrow('v2_account_security_slot_missing_or_duplicated')
  })

  it('keeps saved factors read-only during handoff and disabled by development policy', () => {
    const bodyHtml = render({ ...props, activeRoute: '/mail/settings/security' })
    const readOnly = renderV2AccountSecuritySlot({ bodyHtml, security: { locale: 'en', principalKind: 'user', surface: 'xmail', mfaMode: 'optional', totpEnabled: true, readOnly: true } })
    expect(readOnly).toContain('data-auth-readonly="true"')
    expect(readOnly).toContain('data-mfa-configured="true"')
    expect(readOnly).not.toContain('data-auth-setup-form')
    const disabled = renderV2AccountSecuritySlot({ bodyHtml, security: { locale: 'en', principalKind: 'user', surface: 'xmail', mfaMode: 'disabled', totpEnabled: true } })
    expect(disabled).toContain('data-mfa-disabled')
    expect(disabled).toContain('data-mfa-configured="true"')
    expect(disabled).not.toContain('data-auth-setup-form')
  })

  it('does not expose mailbox data when route, team or search authority is denied', () => {
    for (const activeRoute of ['/mail/private', '/mail/folders', '/mail/search']) {
      const html = render({ ...props, activeRoute, visibility: { ...visibility, allowedToolIds: new Set() } })
      expect(html).toBe('<section data-core-unavailable>Unavailable</section>')
      expect(html).not.toContain(props.mailbox)
    }
  })

  it('preserves selected search folder in language/scheme links without a query-dropping search form', () => {
    const html = render({ ...props, activeRoute: '/mail/search', activeFolder: 'Saved & Reviewed', theme: 'dark' })
    const anchors = parseMarkup(html).filter(node => node.tag === 'a').map(node => node.attrs.get('href') ?? '')
    const language = anchors.find(href => href.startsWith('/mail/search?') && href.includes('lang=ar'))
    expect(language).toBeDefined()
    const search = new URL(language!, 'https://mail.example.test')
    expect(search.searchParams.get('folder')).toBe('Saved & Reviewed')
    expect(search.searchParams.get('theme')).toBe('dark')
    expect(html).not.toContain('action="/mail/search"')
  })

  it('renders shared feedback once and keeps opaque job identities private on workspace pages', () => {
    const html = render({ ...props, activeRoute: '/mail/settings/preferences', actionState: { state: 'conflict', preserveDraft: true, jobId: 'opaque-private-job' } })
    expect(html.match(/data-action-state="conflict"/g)).toHaveLength(1)
    expect(html).toContain('Unnumbered')
    expect(html).not.toContain('opaque-private-job')
    expect(html).toContain('Saved record not read.')
  })
})
