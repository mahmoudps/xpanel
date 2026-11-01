/// <reference lib="dom" />
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { contextualizeDocumentLinks } from './document-routes.ts'
import { ensureAccessibleSurfaceHtml } from './tokens.ts'
import { renderV2DocumentBody } from './themes/v2/surfaces/slots.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { activityControl, assembleActivityControl } from './themes/v2/shell/activity-control.ts'
import { activityDrawer } from './themes/v2/shell/overlays.ts'
import { renderV2Shell, type V2ShellProps } from './themes/v2/shell/shell.ts'

const t = v2Messages.translator('en')
const props = (surface: V2ShellProps['surface'] = 'xpanel'): V2ShellProps => ({
  surface, activeRoute: surface === 'xpanel' ? '/home' : surface === 'xwhm' ? '/whm' : '/mail/inbox',
  homeHref: '/home', realtimeEnabled: false, languages: [],
  scheme: { current: 'light', toggleHref: '/home?theme=dark' },
  account: { signedIn: true, username: 'alice' }, contentHtml: '<section><h1>Existing workspace</h1></section>',
})
const mountDocument = (surfaceHtml: string, activityHtml: string) => {
  document.body.innerHTML = renderV2DocumentBody({ locale: 'en', surfaceHtml, activityHtml,
    reconcileHtml: '', paletteHtml: '', clientScriptsHtml: '', handoffControls: false })
}
const bell = () => document.querySelector<HTMLButtonElement>('[data-xp-activity-control]')!
const expectClosed = () => {
  expect(bell().disabled).toBe(true)
  expect(bell().dataset.xpActivityControl).toBe('unavailable')
  expect(bell().hasAttribute('data-action')).toBe(false)
}

afterEach(() => { document.body.innerHTML = '' })

describe('V2 authorized activity control assembly', () => {
  it.each(['xpanel', 'xwhm', 'xmail'] as const)('retains an unknown disabled %s bell without inventing zero unread or erasing existing controls', surface => {
    mountDocument(renderV2Shell(t, { ...props(surface), unread: 99 }), '')
    expectClosed()
    expect(bell().getAttribute('aria-label')).toBe('Activity & Jobs')
    expect(document.querySelector('[data-action="open-activity-drawer"]')).toBeNull()
    expect(document.querySelector('.v2-top__badge')).toBeNull()
    expect(document.querySelector('[data-action="open-cmdk"]')).not.toBeNull()
    expect(document.querySelector('[data-user-menu]')).not.toBeNull()
    expect(document.querySelector('[data-action="logout"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-xp-toolbar-options]')).toHaveLength(1)
  })

  it('connects the one core-supplied hidden drawer without inferring an unread total or enabling native controls', () => {
    const rawSurface = renderV2Shell(t, { ...props(), contentHtml: '<section><h1>Existing workspace</h1><form><label>Existing native field<input name="existing" disabled></label><button type="submit" disabled>Existing native action</button></form></section>' })
    const surface = contextualizeDocumentLinks(ensureAccessibleSurfaceHtml(rawSurface), { locale: 'en', theme: 'light', density: 'comfortable', activeRoute: '/home' })
    const drawer = activityDrawer(t, { bodyHtml: '<p>Authorized account activity</p>' })
    mountDocument(surface, drawer)
    expect(bell().disabled).toBe(false)
    expect(bell().dataset.action).toBe('open-activity-drawer')
    expect(bell().getAttribute('aria-controls')).toBe('xp-activity-drawer')
    expect(bell().getAttribute('aria-label')).toBe('Activity & Jobs')
    expect(document.querySelectorAll('[data-action="open-activity-drawer"]')).toHaveLength(1)
    expect(document.querySelectorAll('#xp-activity-drawer')).toHaveLength(1)
    expect(document.querySelector<HTMLElement>('#xp-activity-drawer')?.hidden).toBe(true)
    expect(document.querySelector('.v2-top__badge')).toBeNull()
    expect(document.querySelector('#xp-activity-drawer')?.textContent).toContain('Authorized account activity')
    expect(document.querySelector<HTMLInputElement>('input[name="existing"]')?.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('form button')?.disabled).toBe(true)
    const assembled = surface + drawer
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled.replace(activityControl(t, { available: false }), activityControl(t, { available: true })))
  })

  it('keeps malformed or ambiguous drawers closed', () => {
    const surface = renderV2Shell(t, props()), drawer = activityDrawer(t, {})
    for (const invalid of ['', '<div>Unavailable</div>', drawer.replace('id="xp-activity-drawer"', 'id="other"'), drawer + drawer,
      drawer.replace('data-xp-drawer="activity"', 'data-xp-drawer="other"')]) {
      mountDocument(surface, invalid)
      expectClosed()
    }
  })

  it('does not activate either duplicated shell placeholder', () => {
    const surface = renderV2Shell(t, props()), drawer = activityDrawer(t, {})
    const assembled = surface + surface + drawer
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled)
  })

  it('leaves documents without a shell placeholder byte-for-byte unchanged', () => {
    const login = '<main id="main-content"><h1>Sign in</h1></main>'
    expect(assembleActivityControl(t, login, activityDrawer(t, {}))).toBe(login)
  })

  it('does not treat isolated shell preview props as assembled drawer authority', () => {
    mountDocument(renderV2Shell(t, { ...props(), activity: {}, unread: 3 }), '')
    expectClosed()
    expect(document.querySelector('.v2-top__badge')).toBeNull()
  })
  it('keeps a genuinely supplied unread count and rejects invalid count facts', () => {
    for (const unread of [undefined, -1, Number.NaN, 1.5]) {
      document.body.innerHTML = activityControl(t, { available: true, ...(unread === undefined ? {} : { unread }) })
      expect(bell().getAttribute('aria-label')).toBe('Activity & Jobs')
      expect(document.querySelector('.v2-top__badge')).toBeNull()
    }
    document.body.innerHTML = activityControl(t, { available: true, unread: 3 })
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 3 unread')
    expect(document.querySelector('.v2-top__badge')?.textContent).toBe('3')
  })

  it('retains an Arabic accessible name without inventing a numeric badge', () => {
    document.body.innerHTML = activityControl(v2Messages.translator('ar'), { available: false })
    expect(bell().getAttribute('aria-label')).toMatch(/[\u0600-\u06ff]/)
    expect(bell().getAttribute('aria-label')).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(document.querySelector('.v2-top__badge')).toBeNull()
  })

  it('rejects a duplicate live target in ordinary shell content as well as the canonical drawer', () => {
    const surface = renderV2Shell(t, { ...props(), contentHtml: '<div id="xp-activity-drawer">Other</div>' })
    mountDocument(surface, activityDrawer(t, {}))
    expect(document.querySelectorAll('#xp-activity-drawer')).toHaveLength(2)
    expectClosed()
    expect(document.querySelector('[data-action="open-activity-drawer"]')).toBeNull()
  })

  it('does not turn a sole exact fallback inside a template into an available live control', () => {
    const fallback = activityControl(t, { available: false }), drawer = activityDrawer(t, {})
    const surface = `<template>${fallback}</template>`, assembled = surface + drawer
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled)
    mountDocument(surface, drawer)
    expect(document.querySelector('[data-xp-activity-control]')).toBeNull()
    expect(document.querySelector('template')?.content.querySelector<HTMLButtonElement>('[data-xp-activity-control]')?.disabled).toBe(true)
    expect(document.querySelector('[data-action="open-activity-drawer"]')).toBeNull()
  })

  it.each(['reconcileHtml', 'paletteHtml', 'clientScriptsHtml'] as const)('checks duplicate targets in the complete %s slot', key => {
    document.body.innerHTML = renderV2DocumentBody({ locale: 'en', surfaceHtml: renderV2Shell(t, props()),
      activityHtml: activityDrawer(t, {}), reconcileHtml: '', paletteHtml: '', clientScriptsHtml: '',
      handoffControls: false, [key]: '<div id="xp-activity-drawer">Other slot</div>' })
    expectClosed()
  })

  it.each(['inert', 'hidden', 'aria-hidden="true"', 'foreign'] as const)('does not activate a %s placeholder', wrapper => {
    const shell = renderV2Shell(t, props()), drawer = activityDrawer(t, {})
    const surface = wrapper === 'foreign' ? `<svg>${shell}</svg>` : `<div ${wrapper}>${shell}</div>`
    const assembled = surface + drawer
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled)
  })

  it('rejects a foreign duplicate ID because the runtime uses document.getElementById', () => {
    const surface = renderV2Shell(t, { ...props(), contentHtml: '<svg id="xp-activity-drawer"></svg>' })
    mountDocument(surface, activityDrawer(t, {}))
    expectClosed()
  })

  it('keeps ordinary disclosure behavior independent from activity admission', () => {
    const surface = renderV2Shell(t, props()).replace('class="v2-tools" open', 'class="v2-tools"')
    mountDocument(surface, activityDrawer(t, {}))
    expect(document.querySelector<HTMLDetailsElement>('[data-xp-toolbar-options]')?.open).toBe(false)
    expect(bell().disabled).toBe(false)
  })

  it.each(['comment', 'attribute', 'raw-text'] as const)('does not substitute an exact literal in a %s for the differently serialized live control', kind => {
    const fallback = activityControl(t, { available: false })
    const differentSerialization = fallback.replace('data-xp-activity-control="unavailable"', "data-xp-activity-control='unavailable'")
    const shell = renderV2Shell(t, props()).replace(fallback, differentSerialization)
    const literal = kind === 'comment' ? `<!-- ${fallback} -->` : kind === 'attribute' ? `<div data-note='${fallback}'></div>` : `<textarea>${fallback}</textarea>`
    const drawer = activityDrawer(t, {}), assembled = literal + shell + drawer
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled)
  })

  it('requires the supplied activity fragment itself to be live rather than a canonical lookalike elsewhere', () => {
    const drawer = activityDrawer(t, { bodyHtml: '<p>Authorized</p>' })
    const lookalike = activityDrawer(t, { bodyHtml: '<p>Other</p>' })
    const assembled = renderV2Shell(t, props()) + lookalike + `<script type="text/plain">${drawer}</script>`
    expect(assembleActivityControl(t, assembled, drawer)).toBe(assembled)
  })
})
