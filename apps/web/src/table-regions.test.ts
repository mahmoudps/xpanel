import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ensureAccessibleSurfaceHtml } from './tokens.ts'

describe('table region class tokens', () => {
  it.each([
    'class="xp-table-wrap"',
    'class="xp-table-wrap xp-accounts__table-wrap"',
    'class="extra xp-table-wrap"',
    'class="before xp-table-wrap after"',
    'data-table="accounts" class="xp-table-wrap extra"',
  ])('keeps a labeled keyboard region for %s', attrs => {
    const html = ensureAccessibleSurfaceHtml(`<div ${attrs}><table><tr><th>Account</th></tr></table></div>`)
    assert.ok(html.includes(attrs), 'Preserve all original attributes and classes')
    assert.match(html, /role="region"/)
    assert.match(html, /tabindex="0"/)
    assert.match(html, /aria-label="Scrollable data table 1"/)
    assert.match(html, /<th scope="col">Account<\/th>/)
  })

  it('does not assign table-region behavior to a substring class', () => {
    const html = ensureAccessibleSurfaceHtml('<div class="xp-table-wrap-preview">Preview</div>')
    assert.equal(html, '<div class="xp-table-wrap-preview">Preview</div>')
  })

  it('preserves an existing accessible name and focus contract', () => {
    const html = ensureAccessibleSurfaceHtml('<div id="accounts" class="xp-table-wrap extra" role="region" tabindex="0" aria-labelledby="accounts-title"><table></table></div>', 'ar')
    assert.match(html, /aria-labelledby="accounts-title"/)
    assert.doesNotMatch(html, /aria-label=/)
    assert.equal((html.match(/role="region"/g) ?? []).length, 1)
    assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1)
  })
})
