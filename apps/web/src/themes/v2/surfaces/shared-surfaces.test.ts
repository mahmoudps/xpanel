import { describe, expect, it, vi } from 'vitest'
import type { ActivityDrawerProps, StatusPageModel, UiTheme, UnavailableProps } from '../../contract.ts'
import { parseMarkup } from '../../markup.ts'
import { renderV2Login } from './login.ts'
import { renderV2Status } from './status.ts'
import { createV2UnavailableRenderer } from './unavailable.ts'
import { V2_SECURITY_SLOT, renderV2AccountSecurityCard, renderV2AccountSecuritySlot, renderV2ActivityDrawer, renderV2CommandPalette, renderV2DocumentBody, renderV2ReconcileBanner } from './slots.ts'

const nodes = (html: string) => parseMarkup(html)
const ids = (html: string) => nodes(html).flatMap(node => node.attrs.has('id') ? [node.attrs.get('id')!] : [])
const statusModel = (status: StatusPageModel['status'], overrides: Partial<StatusPageModel> = {}): StatusPageModel => ({ status, locale: 'en', theme: 'light', density: 'comfortable', surface: 'xpanel', path: '/missing', ...overrides })
const unavailable = (overrides: Partial<UnavailableProps> = {}): UnavailableProps => ({
  surface: 'xpanel', locale: 'en', theme: 'light', density: 'comfortable', route: '/domains/site-settings', heading: 'Site settings',
  admitted: true, securityPage: false, qualifiedRoutes: new Set(), signedIn: true,
  visibility: { principal: { kind: 'user', id: 'principal-internal', username: 'alice', accountId: 'account-internal' }, disabledFeatures: new Set() }, ...overrides,
})
const liveState = (overrides: Partial<ActivityDrawerProps['live']> = {}): ActivityDrawerProps['live'] => ({
  connectionState: 'offline', reconcile: { generationId: 0, status: 'idle', stages: { render: 'pending', test: 'pending', switch: 'pending', reload: 'pending', verify: 'pending' }, stateChecksum: null, filesCount: 0, durationMs: null, failedTest: null, error: null, updatedAt: null },
  ioAnalytics: null, websiteAnalyticsByDomain: {}, recentAuditEntries: [], recentJobs: [], servicesHealth: [], ...overrides,
})

describe('v2 sign-in contracts', () => {
  it('does not turn a presentation target into trusted listener admission', () => {
    const generic = renderV2Login({ targetSurface: 'xwhm' })
    expect(generic).not.toContain('data-login-audience=')
    expect(generic).toContain('data-team-password-form')
    expect(renderV2Login()).not.toContain('data-login-audience=')
    const fixed = renderV2Login({ audience: 'xpanel', targetSurface: 'xwhm' })
    expect(fixed).toContain('data-login-audience="xpanel"')
    expect(fixed).not.toContain('data-login-audience="xwhm"')
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('retains real named fields, listener identity and unique ids for %s', audience => {
    const html = renderV2Login({ audience, targetSurface: audience === 'xmail' ? 'xwhm' : 'xmail', publicOrigin: 'https://panel.example.test:2083', username: 'actual-user', mfaMode: 'optional' })
    const parsed = nodes(html)
    const form = parsed.find(node => node.attrs.has('data-login-form'))!
    expect(Object.fromEntries(form.attrs)).toMatchObject({ method: 'post', action: '/api/auth/login' })
    for (const [name, type] of [['username', 'text'], ['password', 'password'], ['totpCode', 'text'], ['recoveryCode', 'text']]) expect(parsed.some(node => node.tag === 'input' && node.attrs.get('name') === name && node.attrs.get('type') === type)).toBe(true)
    expect(html).toContain(`data-login-audience="${audience}"`)
    expect(html).toContain('value="actual-user"')
    expect(html).toContain('data-auth-submit disabled')
    expect(html).toContain('data-auth-password-form')
    expect(html.includes('data-team-password-form')).toBe(audience === 'xpanel')
    expect(new Set(ids(html)).size).toBe(ids(html).length)
    expect(html).not.toContain('onClick=')
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('omits factor controls in disabled development mode for %s', audience => {
    const html = renderV2Login({ audience, mfaMode: 'disabled' })
    expect(html).toContain('data-mfa-disabled')
    expect(html).not.toContain('data-auth-mfa-fields')
    expect(html).not.toContain('name="totpCode"')
    expect(html).not.toContain('name="recoveryCode"')
    expect(html).toContain('data-auth-password-form')
  })

  it('preserves actual observed lockout time and retry seconds without adding demo observations', () => {
    const html = renderV2Login({ audience: 'xwhm', username: 'real-user', lockout: { locked: true, lockedUntil: '2026-10-29T10:15:00Z', retryAfterSec: 2.3 } })
    expect(html).toContain('data-auth-state="locked"')
    expect(html).toContain('data-retry-after="3"')
    expect(html).toContain('2026-10-29 10:15 UTC')
    expect(html).not.toContain('203.0.113.7')
    expect(html).not.toContain('14 minutes')
    expect(html).not.toContain('value="Orbit-')
  })

  it('escapes untrusted identity/error text, omits invalid contact and does not display another origin', () => {
    const html = renderV2Login({ audience: 'xmail', username: '"><svg onload=bad()>', errorMessage: '<script>bad()</script>', publicOrigin: 'https://example.test/path', supportEmail: 'bad@example.test\nBcc:x' })
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;svg onload=bad()&gt;')
    expect(html).not.toContain('<script>bad()')
    expect(html).not.toContain('https://example.test/path')
    expect(html).not.toContain('mailto:')
  })

  it('keeps handoff failure generic and Arabic labels in ASCII digit presentation', () => {
    const html = renderV2Login({ audience: 'xpanel', locale: 'ar', handoffFailed: true })
    expect(html).toContain('data-handoff-failed')
    expect(html).toMatch(/[\u0600-\u06ff]/)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).not.toContain('data-auth-state="authenticated"')
    expect(html).not.toContain('value="000000"')
  })
})

describe('v2 status and unqualified routes', () => {
  it.each([400, 403, 404, 421, 500, 503] as const)('renders real status %s without cross-panel navigation', status => {
    const html = renderV2Status(statusModel(status, { notice: '<untrusted>', retryHref: '/retry', supportEmail: 'help@example.test' }))
    expect(html).toContain(`data-status-page="${status}"`)
    expect(html).toContain('&lt;untrusted&gt;')
    expect(html.includes('href="/retry?')).toBe(status === 500 || status === 503)
    expect(html.includes('href="/login?')).toBe(status !== 421)
    expect(html.includes('mailto:help@example.test')).toBe(status === 403 || status === 404)
    expect(nodes(html).filter(node => node.tag === 'main')).toHaveLength(1)
  })

  it('preserves same-listener account/appearance context and refuses external workspace links', () => {
    const html = renderV2Status(statusModel(404, { workspaceHref: '/home', accountId: 'route-only-id', locale: 'ar', theme: 'dark', density: 'compact' }))
    expect(html).toContain('/home?lang=ar&amp;theme=dark&amp;density=compact&amp;accountId=route-only-id')
    const denied = renderV2Status(statusModel(404, { workspaceHref: '//elsewhere.test/account' }))
    expect(denied).not.toContain('elsewhere.test')
    expect(denied).not.toContain('Back to workspace')
  })

  it.each(['xpanel', 'xwhm', 'xmail'] as const)('preserves security navigation and does not expose an inert search on %s', surface => {
    const securityHref = surface === 'xwhm' ? '/whm/security/sign-in' : surface === 'xmail' ? '/mail/settings/security' : '/security/account'
    const visibility = { principal: surface === 'xwhm' ? { kind: 'root' as const, id: 'root-id', username: 'root' } : { kind: 'user' as const, id: 'user-id', username: 'alice', accountId: 'account-id' } }
    for (const html of [renderV2Status(statusModel(503, { surface, signedIn: true, visibility })), createV2UnavailableRenderer(() => undefined)(unavailable({ surface, admitted: false, visibility }))]) {
      expect(html).toContain(`href="${securityHref}" data-security-link="true"`)
      expect(html).not.toContain('data-action="open-cmdk"')
      expect(nodes(html).find(node => node.attrs.get('class') === 'v2-search')?.attrs.has('disabled')).toBe(true)
    }
  })

  it('never substitutes a generic unavailable card for a missing admitted layout', () => {
    expect(() => createV2UnavailableRenderer(() => undefined)(unavailable())).toThrow('v2_unqualified_layout_missing')
    const renderPage = vi.fn(() => '<article data-readonly-page><h1>Full read-only layout</h1><button disabled>Apply</button></article>')
    const html = createV2UnavailableRenderer(renderPage)(unavailable())
    expect(renderPage).toHaveBeenCalledOnce()
    expect(html).toContain('data-readonly-page')
    expect(html).toContain('data-tool-availability="unverified"')
  })

  it('does not call a sensitive layout for a denied route and leaves one security insertion host', () => {
    const page = vi.fn(() => '<p>private data</p>')
    const renderer = createV2UnavailableRenderer(page)
    expect(renderer(unavailable({ admitted: false }))).not.toContain('private data')
    expect(page).not.toHaveBeenCalled()
    const securityPage = vi.fn(() => `<article><h1>Security</h1>${V2_SECURITY_SLOT}</article>`)
    const html = createV2UnavailableRenderer(securityPage)(unavailable({ securityPage: true, route: '/security/account' }))
    expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
    expect(securityPage).toHaveBeenCalledOnce()
    expect(page).not.toHaveBeenCalled()
    for (const slots of ['', V2_SECURITY_SLOT + V2_SECURITY_SLOT]) expect(() => createV2UnavailableRenderer(() => `<h1>Security</h1>${slots}`)(unavailable({ securityPage: true, route: '/security/account' }))).toThrow('v2_unqualified_security_slot_missing_or_duplicated')
  })

  it('escapes neutral summary values and only links admitted registered navigation', () => {
    const html = createV2UnavailableRenderer(() => '<h1>Site</h1>')(unavailable({ summary: { title: '<summary>', accountEmpty: false, fields: [{ key: 'account', label: 'Account', value: '<unsafe>', ltr: true }] } }))
    expect(html).toContain('&lt;summary&gt;')
    expect(html).toContain('<bdi dir="ltr">&lt;unsafe&gt;</bdi>')
    expect(html).not.toContain('data-nav-route="/whm')
  })
})

describe('v2 shared security and document slots', () => {
  const security = { locale: 'en', totpEnabled: false, principalKind: 'user', surface: 'xpanel' } as const
  it('retains optional enrollment, QR/code/recovery and exact native field shapes', () => {
    const html = renderV2AccountSecurityCard(security), parsed = nodes(html)
    expect(html).toContain('data-auth-state="optional"')
    for (const hook of ['data-auth-setup-form', 'data-auth-enrollment-details', 'data-auth-totp-qr', 'data-auth-totp-secret', 'data-auth-enroll-form', 'data-auth-recovery-codes']) expect(html).toContain(hook)
    expect(parsed.find(node => node.attrs.get('id') === 'enrollment-code')?.attrs.get('pattern')).toBe('[0-9]{6}')
    expect(html).toContain('data-action="acknowledge-recovery"')
    expect(new Set(ids(html)).size).toBe(ids(html).length)
  })

  it('shows enabled or development-disabled facts without enrollment controls', () => {
    const enabled = renderV2AccountSecurityCard({ ...security, principalKind: 'root', surface: 'xwhm', totpEnabled: true })
    expect(enabled).toContain('data-mfa-enabled="true"')
    expect(enabled).toContain('xpanel disable-2fa root --confirm')
    expect(enabled).not.toContain('data-auth-setup-form')
    const disabled = renderV2AccountSecurityCard({ ...security, mfaMode: 'disabled', totpEnabled: true })
    expect(disabled).toContain('data-mfa-configured="true"')
    expect(disabled).toContain('data-mfa-disabled')
    expect(disabled).not.toContain('data-auth-enroll-form')
  })

  it('requires exactly one theme-owned security host and inserts the real card once', () => {
    expect(() => renderV2AccountSecuritySlot({ bodyHtml: '<main></main>', security })).toThrow('v2_account_security_slot_missing_or_duplicated')
    expect(() => renderV2AccountSecuritySlot({ bodyHtml: V2_SECURITY_SLOT + V2_SECURITY_SLOT, security })).toThrow('v2_account_security_slot_missing_or_duplicated')
    const html = renderV2AccountSecuritySlot({ bodyHtml: `<main>${V2_SECURITY_SLOT}</main>`, security })
    expect(html.match(/data-account-security="two-factor"/g)).toHaveLength(1)
    expect(html).not.toContain('data-v2-account-security-slot')
  })

  it('retains actual jobs/audit observations without exposing internal references or assuming live updates', () => {
    const hiddenId = '12345678-1234-4234-8234-123456789abc'
    const html = renderV2ActivityDrawer({ locale: 'en', live: liveState({
      recentJobs: [{ jobId: hiddenId, kind: 'package.install', status: 'running', progress: 15, updatedAt: '2026-10-29T11:00:00Z' }],
      recentAuditEntries: [{ id: hiddenId, at: '2026-10-29T11:00:00Z', actor: hiddenId, action: 'auth.login', target: hiddenId, outcome: 'ok', detail: {} }],
    }) })
    expect(html).toContain('package.install')
    expect(html).toContain('15%')
    expect(html).toContain('Unnumbered')
    expect(html).not.toContain(hiddenId)
    expect(html).toContain('Signed in')
    expect(html).not.toContain('as they happen')
  })

  it('preserves reconcile stages, observed identity, errors and measured metadata', () => {
    const live = liveState()
    live.connectionState = 'connected'
    live.reconcile = { ...live.reconcile, generationId: 8, status: 'failed', updatedAt: '2026-10-29T11:00:00Z', filesCount: 3, durationMs: 15, stateChecksum: 'actual-checksum', failedTest: 'configtest', error: '<bad configuration>', stages: { ...live.reconcile.stages, render: 'passed', test: 'failed' } }
    const html = renderV2ReconcileBanner({ locale: 'en', live })
    expect(html).toContain('data-generation-id="8"')
    expect(html).toContain('data-stage="test"')
    expect(html).toContain('&lt;bad configuration&gt;')
    expect(html).toContain('actual-checksum')
    expect(html).toContain('Live stream connected')
    expect(html.match(/id="xp-reconcile-banner"/g)).toHaveLength(1)
  })

  it('emits supplied fragments and branded footer once, preserving the handoff sign-out control', () => {
    const html = renderV2DocumentBody({ locale: 'en', handoffControls: true, impersonation: { target: '<account>', issuer: 'operator' }, surfaceHtml: '<main>surface</main>', reconcileHtml: '<div id="reconcile-sentinel"></div>', paletteHtml: '<div id="palette-sentinel"></div>', activityHtml: '<div id="activity-sentinel"></div>', clientScriptsHtml: '<script id="client-sentinel"></script>', branding: { companyName: '<company>', productName: 'Host', footerText: '<footer text>', hidePoweredBy: false, primaryColor: '', accentColor: '', supportUrl: 'https://support.example.test', supportEmail: 'help@example.test', logoUrl: null, faviconUrl: null } })
    for (const sentinel of ['reconcile-sentinel', 'palette-sentinel', 'activity-sentinel', 'client-sentinel']) expect(html.match(new RegExp(sentinel, 'g'))).toHaveLength(1)
    expect(html).toContain('data-impersonation-end')
    expect(html).toContain('&lt;account&gt;')
    expect(html).not.toContain('xp-impersonation')
    expect(html.match(/data-brand-footer role="contentinfo"/g)).toHaveLength(1)
    expect(html).toContain('&lt;footer text&gt;')
  })

  it('does not emit a command palette for login', () => {
    expect(renderV2CommandPalette({ surface: 'login', locale: 'en', entries: [] })).toBe('')
    expect(renderV2CommandPalette({ surface: 'xpanel', locale: 'en', entries: [] })).toContain('id="xp-cmdk-modal"')
  })
})
