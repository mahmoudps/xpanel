import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderWhmSurface } from './index.ts'
import type { WhmSurfaceProps } from './index.ts'

const props: WhmSurfaceProps = {
  principal: { kind: 'root', id: 'fixture-root', username: 'root' },
  accounts: [{ id: 'fixture-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.10', ipv6: null, shell: 'none', createdAt: '2026-10-23T00:00:00Z' }],
  resellers: [],
  services: [],
}

describe('phase 2 xWHM screens', () => {
  it('renders the wired administrator screens in English and Arabic', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = ['/whm/resellers', '/whm/dns', '/whm/backups/restore', '/whm/services', '/whm/monitoring/server-info']
        .map(activeRoute => renderWhmSurface({ ...props, locale, activeRoute }))
        .join('\n')
      assert.match(html, /data-reseller-create-form="true"/)
      assert.match(html, /data-dns-editor="true"/)
      assert.match(html, /data-account-backups="true"/)
      assert.match(html, /data-host-services="true"/)
      assert.match(html, /data-host-info="true"/)
      assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
      if (locale === 'ar') assert.match(html, /إنشاء الموزع/)
    }
  })
})
