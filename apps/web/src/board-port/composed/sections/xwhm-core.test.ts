import { translator } from '../../../i18n.ts'
import { describe, expect, it } from 'vitest'
import { xwhm_accounts } from './xwhm-accounts.ts'
import { xwhm_backups } from './xwhm-backups.ts'
import { xwhm_databases } from './xwhm-databases.ts'
import { xwhm_domains } from './xwhm-domains.ts'
import { xwhm_email } from './xwhm-email.ts'
import { xwhm_home } from './xwhm-home.ts'
import { xwhm_monitoring } from './xwhm-monitoring.ts'

const families = [
  [xwhm_databases, 9], [xwhm_accounts, 4], [xwhm_monitoring, 12],
  [xwhm_domains, 4], [xwhm_backups, 6], [xwhm_email, 12], [xwhm_home, 2],
] as const
const routes = families.flatMap(([items]) => [...items])
const at = (route: string) => {
  const spec = routes.find(item => item.route === route)
  expect(spec, route).toBeDefined()
  return spec!
}

describe('xWHM core route metadata', () => {
  it('retains all unique routes without executable state or display-reference allocation', () => {
    for (const [items, count] of families) expect(items).toHaveLength(count)
    expect(routes).toHaveLength(49)
    expect(new Set(routes.map(item => item.route)).size).toBe(49)
    const keys = ['action', 'bind', 'columns', 'fields', 'group', 'layout', 'lede', 'route', 'section', 'surface', 'title']
    for (const spec of routes) {
      expect(spec.surface).toBe('xwhm')
      expect(spec.route).toMatch(/^\/whm\//)
      expect(Object.keys(spec).sort()).toEqual(keys)
      expect(spec.title.trim().length > 0).toBe(true)
      expect(spec.lede.trim().length > 0).toBe(true)
      expect(spec.fields).toEqual([])
      expect(spec.action).toBeNull()
    }
  })

  it('leaves workflows without a reader unread instead of borrowing an unrelated account list', () => {
    for (const route of ['/whm/accounts/announcements', '/whm/accounts/templates']) {
      expect(at(route).bind).toBe('soon')
      expect(at(route).columns).toEqual([])
      expect(at(route).lede).toMatch(/(?:has|have) not been read/)
    }
    for (const spec of routes.filter(item => item.bind === 'soon')) {
      expect(spec.fields).toEqual([])
      expect(spec.columns).toEqual([])
      expect(spec.action).toBeNull()
    }
    expect(routes.filter(item => item.bind === 'soon')).toHaveLength(42)
  })

  it('distinguishes stored account status and measured web bandwidth from health or usage readings', () => {
    expect(at('/whm/accounts/health').bind).toBe('accounts')
    expect(at('/whm/accounts/health').lede).toContain('assessments and repairs are unavailable')
    expect(at('/whm/accounts/bandwidth').bind).toBe('accounts')
    expect(at('/whm/accounts/bandwidth').lede).toContain('web from the saved site access logs, plus mail and FTP')
    expect(at('/whm/accounts/bandwidth').columns.at(-1)).toBe('Bandwidth')
    expect(translator('ar')(at('/whm/accounts/bandwidth').columns.at(-1)!)).toBe('النطاق الترددي')
    expect(routes.filter(item => item.bind === 'accounts')).toHaveLength(2)
  })

  it('retains native route metadata without inventing replacement actions or API aliases', () => {
    for (const [route, binding] of [
      ['/whm/monitoring/io', 'io'], ['/whm/monitoring/server-info', 'host-info'],
      ['/whm/backups/restore', 'backups'], ['/whm/email/outbound', 'mail-ips'],
    ] as const) {
      expect(at(route).bind).toBe(binding)
      expect(at(route).action).toBeNull()
      expect(at(route).fields).toEqual([])
    }
    expect(at('/whm/backups/files').bind).toBe('backups')
    expect(at('/whm/email/outbound').lede).toContain('cannot be applied')
    expect(JSON.stringify(routes)).not.toContain('/api/')
  })
})
