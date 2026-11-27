import { describe, expect, it } from 'vitest'
import { type VisibilityContext } from '@xpanel/catalog'
import { CORE_OPERATIONAL_ACTIONS, visibleCoreActions } from './catalog.ts'

const routes = new Set([
  '/whm/services', '/whm/accounts', '/whm/dns', '/whm/ssl', '/whm/email/queue',
  '/whm/software/php', '/whm/security/firewall', '/whm/monitoring/health',
  '/databases/mariadb', '/email/accounts', '/domains/site-settings', '/files/backup',
])

describe('core operational action catalog', () => {
  it('defines all 12 core actions with valid endpoint routes', () => {
    expect(CORE_OPERATIONAL_ACTIONS).toHaveLength(12)
    expect(new Set(CORE_OPERATIONAL_ACTIONS.map(a => a.id)).size).toBe(12)
  })

  it('gates root, reseller, and owner actions strictly according to visibility', () => {
    const root: VisibilityContext = { principal: { kind: 'root', id: 'root', username: 'root' } }
    const whmRoot = visibleCoreActions('xwhm', root, undefined, routes)
    expect(whmRoot.map(a => a.id)).toContain('restart-service')
    expect(whmRoot.map(a => a.id)).toContain('check-config-health')
    expect(whmRoot.some(a => a.id === 'purge-edge-cache')).toBe(false)

    const restrictedReseller: VisibilityContext = {
      principal: { kind: 'reseller', id: 'r1', username: 'res1' },
      reseller: { acl: ['list-accounts'] },
    }
    expect(visibleCoreActions('xwhm', restrictedReseller, undefined, routes)).toEqual([])

    const suspendReseller: VisibilityContext = {
      principal: { kind: 'reseller', id: 'r1', username: 'res1' },
      reseller: { acl: ['list-accounts', 'suspend-account'] },
    }
    expect(visibleCoreActions('xwhm', suspendReseller, undefined, routes).map(a => a.id)).toEqual(['suspend-account'])

    const owner: VisibilityContext = {
      principal: { kind: 'user', id: 'u1', accountId: 'a1', username: 'alice' },
      disabledFeatures: new Set(['manage-domain']),
    }
    const panelOwner = visibleCoreActions('xpanel', owner, undefined, routes).map(a => a.id)
    expect(panelOwner).toContain('create-database')
    expect(panelOwner).toContain('run-backup')
    expect(panelOwner).not.toContain('purge-edge-cache')
    expect(visibleCoreActions('xmail', owner, undefined, routes)).toEqual([])
  })
})
