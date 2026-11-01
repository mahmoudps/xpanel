// Pure page-consumer tests. Core/API suites separately prove trusted source identity and transport.
import { describe, expect, it } from 'vitest'
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH, type Account } from '@xpanel/core'
import type { AuthPersonalView, PanelSurfaceProps, ThemeViewProps } from './themes/contract.ts'
import { matchesHook, parseMarkup, type HookSelector } from './themes/markup.ts'
import { renderV2AccountSecurityPage } from './themes/v2/pages/xpanel/security/account.ts'
import { NO_SETTINGS_AUTHORITY, page, type PanelSettingsAuthority } from './themes/v2/pages/xpanel/settings/common.ts'
import { V2_PANEL_SETTINGS_ROUTES } from './themes/v2/pages/xpanel/settings/remaining.ts'
import { V2_SECURITY_SLOT } from './themes/v2/surfaces/slots.ts'

const locales = ['en', 'ar'] satisfies readonly ('en' | 'ar')[]
const account: Account = { id: 'personal-account', username: 'personalowner', uid: 20045, gid: 20045, home: '/home/personalowner', primaryDomain: 'personal.example.test', planId: 'personal-plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.45', shell: 'none', createdAt: '2026-10-31T00:00:00Z' }
const ready: AuthPersonalView = { state: 'ready', canChangePassword: true, canReadSessions: true, canRevokeSessions: true, canReadApiTokens: true, canManageApiTokens: true }
const readOnlyNative: PanelSettingsAuthority = { presentation: 'read-only', canRead: false, canManage: false }
const liveNative: PanelSettingsAuthority = { canRead: true, canManage: true }
const props = (locale: 'en' | 'ar', authPersonal?: AuthPersonalView): PanelSurfaceProps & ThemeViewProps => ({ locale, activeRoute: '/security/account', account, visibility: { principal: { kind: 'user', id: 'personal-principal', username: account.username, accountId: account.id } }, ...(authPersonal ? { authPersonal } : {}) })
const liveNodes = (html: string) => parseMarkup(html).filter(node => node.template < 0)
const matched = (html: string, selector: HookSelector) => liveNodes(html).filter(node => matchesHook(node, selector))
function one(html: string, selector: HookSelector) {
  const found = matched(html, selector)
  expect(found, selector).toHaveLength(1)
  const node = found[0]
  if (!node) throw new Error('Missing personal-security node: ' + selector)
  return node
}
function denied(html: string, selector: HookSelector): boolean {
  const nodes = parseMarkup(html)
  const index = nodes.findIndex(node => node.template < 0 && matchesHook(node, selector))
  if (index < 0) throw new Error('Missing personal-security scope: ' + selector)
  for (let current = index; current >= 0; current = nodes[current]?.parent ?? -1) {
    const node = nodes[current]
    if (!node) throw new Error('Invalid markup parent')
    if (node.attrs.get('data-readonly') === 'true' || node.attrs.get('data-read-only') === 'true' || node.attrs.get('data-qualified') === 'false' || node.tag === 'fieldset' && node.attrs.has('disabled')) return true
  }
  return false
}
function closed(html: string): void {
  expect(one(html, '[data-account-password]').attrs.get('data-account-password-can-change')).toBe('false')
  expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-read')).toBe('false')
  expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-revoke')).toBe('false')
  expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-read')).toBe('false')
  expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-manage')).toBe('false')
  for (const selector of ['[data-account-password]', '[data-account-sessions]', '[data-account-api-tokens]'] satisfies readonly HookSelector[]) expect(denied(html, selector), selector).toBe(true)
  for (const node of liveNodes(html).filter(node => ['input', 'textarea', 'select'].includes(node.tag) || node.tag === 'button' && node.attrs.get('role') !== 'tab')) expect(node.attrs.has('disabled'), node.tag).toBe(true)
}

describe('V2 independent account personal security', () => {
  for (const locale of locales) {
    for (const [name, nativeAuthority] of [['qualified native', liveNative], ['unqualified native', readOnlyNative]] satisfies readonly (readonly [string, PanelSettingsAuthority])[]) {
      it('keeps missing personal facts closed with ' + name + ' in ' + locale, () => {
        const html = renderV2AccountSecurityPage(props(locale), nativeAuthority)
        closed(html)
        expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
        expect(html).not.toContain('data-auth-setup-form')
      })
    }
    it('opens trusted self operations while retaining native denial in ' + locale, () => {
      const html = renderV2AccountSecurityPage(props(locale, ready), readOnlyNative)
      expect(one(html, '[data-account-password]').attrs.get('data-account-password-can-change')).toBe('true')
      expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-read')).toBe('true')
      expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-revoke')).toBe('true')
      expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-read')).toBe('true')
      expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-manage')).toBe('true')
      for (const selector of ['[data-account-password]', '[data-account-sessions]', '[data-account-api-tokens]'] satisfies readonly HookSelector[]) expect(denied(html, selector), selector).toBe(false)
      for (const id of ['v2-account-ssh', 'v2-account-ip', 'v2-account-hotlink', 'v2-account-privacy']) expect(denied(html, `#${id}`), id).toBe(true)
      expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
      expect(matched(html, '[data-presentation-tab]')).toHaveLength(7)
      expect(matched(html, '[data-v2-security-check]')).toHaveLength(6)
    })
    for (const state of ['denied', 'unavailable'] satisfies readonly AuthPersonalView['state'][]) {
      it('refuses true flags in nonready ' + state + ' view in ' + locale, () => closed(renderV2AccountSecurityPage(props(locale, { ...ready, state }), readOnlyNative)))
    }
    it('separates reads from session revocation and token issuance in ' + locale, () => {
      const html = renderV2AccountSecurityPage(props(locale, { ...ready, canChangePassword: false, canRevokeSessions: false, canManageApiTokens: false }), readOnlyNative)
      expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-read')).toBe('true')
      expect(one(html, '[data-account-sessions]').attrs.get('data-sessions-can-revoke')).toBe('false')
      expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-read')).toBe('true')
      expect(one(html, '[data-account-api-tokens]').attrs.get('data-tokens-can-manage')).toBe('false')
      expect(denied(html, '[data-account-password]')).toBe(true)
      expect(one(html, '[data-sessions-revoke-others]').attrs.has('disabled')).toBe(true)
      expect(one(html, '[data-account-tokens-submit]').attrs.has('disabled')).toBe(true)
    })
    it('does not grant session or token mutations without their own read flag in ' + locale, () => {
      closed(renderV2AccountSecurityPage(props(locale, { ...ready, canChangePassword: false, canReadSessions: false, canReadApiTokens: false }), readOnlyNative))
    })
    it('opens only the personal host with no native authority in ' + locale, () => {
      const html = renderV2AccountSecurityPage(props(locale, ready), NO_SETTINGS_AUTHORITY)
      expect(one(html, '[data-v2-settings-route="/security/account"]').attrs.has('data-readonly')).toBe(false)
      for (const selector of ['[data-account-password]', '[data-account-sessions]', '[data-account-api-tokens]'] satisfies readonly HookSelector[]) expect(denied(html, selector), selector).toBe(false)
      for (const id of ['v2-account-ssh', 'v2-account-ip', 'v2-account-hotlink', 'v2-account-privacy']) expect(denied(html, `#${id}`), id).toBe(true)
      const untrusted = renderV2AccountSecurityPage(props(locale), NO_SETTINGS_AUTHORITY)
      expect(one(untrusted, '[data-v2-settings-route="/security/account"]').attrs.get('data-readonly')).toBe('true')
      for (const route of V2_PANEL_SETTINGS_ROUTES.filter(route => route !== '/security/account')) {
        const plain = page({ ...props(locale), activeRoute: route }, NO_SETTINGS_AUTHORITY, route, 'Title', 'Description', '<input disabled>')
        const personal = page({ ...props(locale, ready), activeRoute: route }, NO_SETTINGS_AUTHORITY, route, 'Title', 'Description', '<input disabled>')
        expect(personal, route).toBe(plain)
      }
    })
    it('rejects nonboolean operation flags without native unlock in ' + locale, () => {
      const malformed: AuthPersonalView = { ...ready }
      for (const key of ['canChangePassword', 'canReadSessions', 'canReadApiTokens']) Reflect.set(malformed, key, 'true')
      closed(renderV2AccountSecurityPage(props(locale, malformed), readOnlyNative))
    })
    it('preserves complete finite tables and safe initially disabled forms in ' + locale, () => {
      const html = renderV2AccountSecurityPage(props(locale, ready), readOnlyNative)
      const form = one(html, '[data-account-password-form]')
      expect(form.tag).toBe('form')
      expect(form.attrs.get('method')).toBe('post')
      expect(form.attrs.get('action')).toBe('/api/auth/change-password')
      expect(ACCOUNT_SELF_PASSWORD_MIN_LENGTH).toBe(8)
      expect(one(html, '[name="currentPassword"]').attrs.has('minlength')).toBe(false)
      for (const name of ['newPassword', 'confirmPassword']) expect(one(html, `[name="${name}"]`).attrs.get('minlength')).toBe(String(ACCOUNT_SELF_PASSWORD_MIN_LENGTH))
      for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) {
        const field = one(html, `[name="${name}"]`)
        expect(field.tag).toBe('input')
        expect(field.attrs.get('type')).toBe('password')
        expect(field.attrs.has('disabled')).toBe(true)
        expect(field.attrs.has('value')).toBe(false)
      }
      expect(one(html, '[data-sessions-rows]').tag).toBe('tbody')
      expect(one(html, '[data-account-tokens-rows]').tag).toBe('tbody')
      expect(one(html, '[data-account-tokens-create]').attrs.get('method')).toBe('post')
      expect(one(html, '[data-account-tokens-create]').attrs.get('action')).toBe('/api/auth/api-tokens')
      expect(matched(html, '[data-account-tokens-scope]')).toHaveLength(12)
      expect(matched(html, '[data-account-tokens-scope]').every(node => node.attrs.has('disabled'))).toBe(true)
      expect(html).toContain('<code data-account-tokens-secret dir="ltr" class="v2-mono"></code>')
      expect(one(html, '[data-account-tokens-reveal]').attrs.has('hidden')).toBe(true)
      const outline = parseMarkup(html)
      for (const [name, cells] of [['account-session-row', 6], ['account-token-row', 7]] satisfies readonly (readonly [string, number])[]) {
        const template = outline.findIndex(node => node.tag === 'template' && node.attrs.get('data-xp-template') === name)
        expect(template).toBeGreaterThanOrEqual(0)
        const row = outline.findIndex(node => node.parent === template && node.tag === 'tr')
        expect(row).toBeGreaterThanOrEqual(0)
        expect(outline.filter(node => node.parent === row && node.tag === 'td')).toHaveLength(cells)
      }
    })
  }
})
