import { describe, expect, it } from 'vitest'
import { attr, escapeHtml, hookAttrs } from './html.ts'

describe('v2 HTML helpers', () => {
  it('escape every character that can break out of text or a quoted attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(escapeHtml(42)).toBe('42')
  })

  it('render data-* hooks with escaped values, bare true and no false or undefined', () => {
    expect(hookAttrs({ 'data-action': 'logout', 'data-ready': true, 'data-off': false, 'data-none': undefined, 'data-count': 3 }))
      .toBe(' data-action="logout" data-ready data-count="3"')
    expect(hookAttrs({ 'data-x': '"><script>' })).toBe(' data-x="&quot;&gt;&lt;script&gt;"')
    expect(hookAttrs(undefined)).toBe('')
  })

  it('refuse hook names that are not plain data-* attributes', () => {
    for (const name of ['data-a b', 'data-a"', 'data-', 'data-A', 'data-x onclick']) {
      expect(() => hookAttrs({ [name]: '1' } as Record<`data-${string}`, string>)).toThrow(/Invalid hook attribute/)
    }
  })

  it('omit empty optional attributes and escape set ones', () => {
    expect(attr('id', undefined)).toBe('')
    expect(attr('id', '')).toBe('')
    expect(attr('title', 'a"b')).toBe(' title="a&quot;b"')
  })
})
