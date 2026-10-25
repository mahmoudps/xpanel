import { describe, expect, it } from 'vitest'
import { renderComposedRoutes } from './render.ts'
import type { ComposedRoute } from './types.ts'

const spec: ComposedRoute = {
  route: '/configuration-test', surface: 'xwhm', section: 'settings', group: ['Settings', 'الإعدادات'],
  title: ['Configuration', 'الإعداد'], lede: ['Configuration has not been read.', 'لم يُقرأ الإعداد.'],
  layout: 'settings', action: ['Save settings', 'حفظ الإعدادات'], columns: [['Key', 'المفتاح'], ['Value', 'القيمة']],
  fields: [['Host name', 'اسم المضيف'], ['Address', 'العنوان']], bind: 'soon',
}
const context = { locale: 'en' as const, route: spec.route, principal: { kind: 'root' as const, id: 'root-internal', username: 'root' } }

describe('composed layout contract', () => {
  it('uses declared fields, table and action while keeping an unavailable workflow non-operational', () => {
    const html = renderComposedRoutes([spec], context)!
    expect(html).toContain('data-composed-layout="settings"')
    expect(html).toContain('Host name')
    expect(html).toContain('Address')
    expect(html).toContain('Save settings')
    expect(html).toContain('<th scope="col">Key</th>')
    expect(html).toContain('data-read-state="unavailable"')
    for (const tag of html.match(/<(?:button|input|textarea)\b[^>]*>/g) ?? []) expect(tag).toMatch(/\bdisabled\b/)
    expect(html).not.toMatch(/<form\b|\/api\//)
  })

  it('does not expose fields or an action when the trusted context denies the page', () => {
    const html = renderComposedRoutes([spec], { ...context, principal: undefined })!
    expect(html).toContain('data-read-state="denied"')
    expect(html).not.toMatch(/<button|<input|<textarea|<table/)
    expect(html).not.toContain('Host name')
    expect(html).not.toContain('Save settings')
  })

  it('retains wizard and editor structures without claiming a completed step or loaded file', () => {
    const wizard = renderComposedRoutes([{ ...spec, layout: 'wizard' }], context)!
    expect(wizard).toContain('aria-current="step"')
    expect(wizard).toContain('Review changes')
    expect(wizard).not.toContain('Complete')
    const editor = renderComposedRoutes([{ ...spec, layout: 'editor' }], context)!
    expect(editor).toMatch(/<textarea[^>]*readonly[^>]*disabled/)
    expect(editor).toContain('File contents')
    expect(editor).not.toContain('root-internal')
  })
})
