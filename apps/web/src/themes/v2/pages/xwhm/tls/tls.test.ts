import { describe, expect, it } from 'vitest'
import type { WhmNetworkAuthority } from '../domains/common.ts'
import { renderV2WhmTlsPage } from './index.ts'

const authority: WhmNetworkAuthority = { canRead: true, canManage: true }
const tile = (html: string, label: string): string => html.match(new RegExp(`<h2>${label}</h2></div>\\s*<p class="v2-kpi__value(?: v2-kpi__value--text)? v2-num"><span>([^<]*)</span>`))![1]!

describe('v2 WHM SSL/TLS summary', () => {
  it('counts the supplied stored expiry dates in the same groups as the stored-expiry filter', () => {
    const day = 86_400_000, at = (offset: number): string => new Date(Date.now() + offset * day).toISOString()
    const html = renderV2WhmTlsPage({ principal: { kind: 'root', id: 'r', username: 'root' }, certificates: [{ names: ['a.example.test'], notAfter: at(-2) }, { names: ['b.example.test'], notAfter: at(10) }, { names: ['c.example.test'], notAfter: at(90) }, { names: ['d.example.test'], notAfter: at(200) }] }, authority)
    expect(tile(html, 'All stored certificates')).toBe('4')
    expect(tile(html, 'Expired')).toBe('1')
    expect(tile(html, 'Expires within 30 days')).toBe('1')
    expect(tile(html, 'Expires later')).toBe('2')
  })

  it('shows no count when no certificate list was supplied', () => {
    const html = renderV2WhmTlsPage({ principal: { kind: 'root', id: 'r', username: 'root' } }, authority)
    for (const label of ['All stored certificates', 'Expired', 'Expires within 30 days', 'Expires later']) expect(tile(html, label)).toBe('—')
    expect(html.match(/class="v2-kpi__note v2-num">Not read</g)).toHaveLength(4)
  })
})
