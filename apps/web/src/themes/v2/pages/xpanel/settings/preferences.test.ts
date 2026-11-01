import { describe, expect, it } from 'vitest'
import type { Account } from '@xpanel/core'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { parseMarkup } from '../../../../markup.ts'
import { alternateLocales } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2AccountLanguagePage, renderV2AccountPreferencesPage } from './preferences.ts'
import type { PanelSettingsAuthority } from './common.ts'

const account: Account = { id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-30T00:00:00Z' }
const authority: PanelSettingsAuthority = { canRead: true, canManage: true, relatedRoutes: new Set(['/preferences', '/preferences/language']) }
const render = (route: '/preferences' | '/preferences/language', locale: 'en' | 'ar', permission = authority) => {
  const props: PanelSurfaceProps = { account, activeRoute: route, locale, theme: 'dark' }
  return route === '/preferences' ? renderV2AccountPreferencesPage(props, permission) : renderV2AccountLanguagePage(props, permission)
}

describe('V2 local account/language preferences navigation', () => {
  it.each([
    ['/preferences', 'en'], ['/preferences', 'ar'],
    ['/preferences/language', 'en'], ['/preferences/language', 'ar'],
  ] as const)('matches the finite two-pane contract on %s in %s', (route, locale) => {
    const html = render(route, locale)
    const nodes = parseMarkup(html)
    const lists = nodes.filter(node => node.attrs.get('role') === 'tablist')
    const tabs = nodes.filter(node => node.attrs.get('role') === 'tab')
    const panels = nodes.filter(node => node.attrs.get('role') === 'tabpanel')
    expect(nodes.filter(node => node.attrs.get('data-presentation-tabs') === 'panels')).toHaveLength(1)
    expect(lists).toHaveLength(1)
    expect(lists[0]!.attrs.get('aria-label')).toBe(v2Messages.translator(locale)('Preferences'))
    expect(tabs).toHaveLength(2)
    expect(panels).toHaveLength(2)
    const selected = route === '/preferences' ? 'account' : 'language'
    for (const tab of tabs) {
      const key = tab.attrs.get('data-presentation-tab')
      const panel = panels.find(node => node.attrs.get('id') === tab.attrs.get('aria-controls'))!
      expect(['account', 'language']).toContain(key)
      expect(tab.tag).toBe('button')
      expect(tab.attrs.get('type')).toBe('button')
      expect(tab.attrs.has('data-action')).toBe(false)
      expect(tab.attrs.has('data-api-url')).toBe(false)
      expect(tab.attrs.get('aria-selected')).toBe(String(key === selected))
      expect(tab.attrs.get('tabindex')).toBe(key === selected ? '0' : '-1')
      expect(panel.attrs.get('aria-labelledby')).toBe(tab.attrs.get('id'))
      expect(panel.attrs.has('hidden')).toBe(key !== selected)
      for (let parent = tab.parent; parent >= 0; parent = nodes[parent]!.parent) expect(nodes[parent]!.tag).not.toBe('form')
    }
    const ids = nodes.map(node => node.attrs.get('id')).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    expect(nodes.find(node => node.attrs.has('data-v2-settings-route'))!.attrs.get('data-v2-settings-route')).toBe(route)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('keeps the original contact mount, account identity and initial disabled controls only on Account', () => {
    const nodes = parseMarkup(render('/preferences', 'en'))
    const mounts = nodes.filter(node => node.attrs.has('data-account-contact'))
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.attrs.get('data-contact-account')).toBe(account.id)
    expect(mounts[0]!.attrs.get('data-contact-manage')).toBe('true')
    expect(nodes.filter(node => node.tag === 'form' && node.attrs.has('data-contact-form'))).toHaveLength(1)
    expect(nodes.find(node => node.attrs.get('name') === 'contactEmail')!.attrs.has('disabled')).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-contact-save'))!.attrs.has('disabled')).toBe(true)
  })

  it('does not add a hidden contact controller or native form to the Language route', () => {
    const nodes = parseMarkup(render('/preferences/language', 'en'))
    for (const attribute of ['data-account-contact', 'data-contact-form', 'data-contact-save', 'data-contact-refresh', 'data-contact-reload', 'data-contact-status', 'data-contact-saved', 'data-contact-account']) expect(nodes.some(node => node.attrs.has(attribute))).toBe(false)
    expect(nodes.some(node => node.attrs.has('data-v2-contact-preview') && node.attrs.get('data-readonly') === 'true')).toBe(true)
    expect(nodes.find(node => node.attrs.get('name') === 'contactEmail')!.attrs.has('disabled')).toBe(true)
    expect(nodes.some(node => node.tag === 'a' && node.attrs.get('href') === '/preferences?lang=en&theme=dark')).toBe(true)
  })

  it.each(['en', 'ar'] as const)('preserves the existing %s language-choice URLs and permission-scoped route links', locale => {
    const nodes = parseMarkup(render('/preferences/language', locale))
    const actual = nodes.filter(node => node.tag === 'a' && node.attrs.get('href')?.startsWith('/preferences/language?')).map(node => node.attrs.get('href'))
    const expected = alternateLocales(locale).map(option => '/preferences/language?' + new URLSearchParams({ lang: option.tag, theme: 'dark' }))
    expect(actual).toEqual(expected)
    const scoped = parseMarkup(render('/preferences', locale, { ...authority, relatedRoutes: new Set(['/preferences']) }))
    expect(scoped.some(node => node.tag === 'a' && node.attrs.get('href')?.startsWith('/preferences/language?'))).toBe(false)
    const noContactRoute = parseMarkup(render('/preferences/language', locale, { ...authority, relatedRoutes: new Set(['/preferences/language']) }))
    expect(noContactRoute.some(node => node.tag === 'a' && node.attrs.get('href')?.startsWith('/preferences?'))).toBe(false)
  })

  it('preserves read-only/absent-authority contact gates while leaving local tabs as presentation controls', () => {
    for (const permission of [{ canRead: true, canManage: false }, { canRead: false, canManage: true }, { presentation: 'read-only' as const, canRead: true, canManage: true, canReadFacts: false }]) {
      const nodes = parseMarkup(render('/preferences', 'en', permission))
      expect(nodes.find(node => node.attrs.has('data-contact-manage'))!.attrs.get('data-contact-manage')).toBe('false')
      for (const node of nodes.filter(node => node.tag === 'input' || node.tag === 'button' && node.attrs.get('type') === 'submit')) expect(node.attrs.has('disabled')).toBe(true)
      expect(nodes.filter(node => node.attrs.get('role') === 'tab').every(node => !node.attrs.has('disabled'))).toBe(true)
    }
  })
})
