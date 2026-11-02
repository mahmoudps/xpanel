import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmDatabasePage, V2_WHM_DATABASE_ROUTES, WHM_DATABASE_PAGES_CSS, type WhmDatabaseInput } from './index.ts'

const readable = { dataAuthority: { canRead: true, canManage: true, canKill: true } }
const render = (route: string, input: WhmDatabaseInput = {}) => renderV2WhmDatabasePage({ ...readable, ...input, activeRoute: route })!
const node = (html: string, name: string, value?: string) => {
  const found = parseMarkup(html).find(item => item.attrs.has(name) && (value === undefined || item.attrs.get(name) === value))
  if (!found) throw new Error(`Missing ${name}`)
  return found
}

describe('V2 WHM database documents', () => {
  it('maps exactly nine database documents without swallowing unrelated routes', () => {
    expect(new Set(V2_WHM_DATABASE_ROUTES).size).toBe(9)
    for (const route of V2_WHM_DATABASE_ROUTES) {
      const html = render(route)
      expect(html).toContain(`data-whm-detail-route="${route}"`)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toMatch(/class="[^"\n]*\bxp-|<style\b|<script\b/)
    }
    expect(renderV2WhmDatabasePage({ activeRoute: '/whm/accounts' })).toBeUndefined()
  })

  it('defaults every native control to disabled without core authority', () => {
    for (const route of V2_WHM_DATABASE_ROUTES) {
      const html = render(route, { dataAuthority: undefined })
      expect(html).toContain('data-capability-state="unavailable"')
      expect(parseMarkup(html).filter(item => ['input', 'select', 'textarea', 'button'].includes(item.tag)).every(item => item.attrs.has('disabled'))).toBe(true)
    }
  })

  it('requires explicit write and kill authority independently of read admission', () => {
    const html = render('/whm/databases/processes', { dataAuthority: { canRead: true, canManage: false, canKill: true } })
    expect(html).toContain('data-db-can-read="true"')
    expect(html).toContain('data-db-can-kill="false"')
    expect(render('/whm/databases/processes')).toContain('data-db-can-kill="true"')
    expect(render('/whm/databases/users')).toContain('data-db-can-kill="false"')
  })

  it('keeps capability unavailability stronger than all requested authority flags', () => {
    const html = render('/whm/databases/processes', { capabilityUnavailable: true })
    expect(html).toContain('data-db-can-read="false"')
    expect(html).toContain('data-db-can-kill="false"')
    expect(node(html, 'data-whm-db-refresh').attrs.has('disabled')).toBe(true)
  })

  it('separates saved configuration, observed counters and unattributed server schemas', () => {
    const html = render('/whm/databases')
    for (const key of ['version', 'Uptime', 'Threads_connected', 'Threads_running', 'Questions', 'Slow_queries', 'schemaCount', 'totalSizeBytes', 'accounts', 'databases', 'users', 'grants', 'savedOnly', 'serverOnly']) {
      expect(node(html, 'data-whm-db-fact', key).tag).toBe('dd')
    }
    expect(node(html, 'data-whm-db-rows', 'accounts').attrs.get('data-columns')).toBe('8')
    expect(node(html, 'data-whm-db-rows', 'databases').attrs.get('data-columns')).toBe('6')
    expect(html).toContain('Server-only schemas are not attributed to an account.')
    expect(html).not.toMatch(/data-whm-db-fact="[^"]+">0</)
  })

  it('preserves all drift filters and excludes query contents from the process view', () => {
    const users = render('/whm/databases/users')
    for (const value of ['in-sync', 'saved-only', 'server-only', 'system', 'unverified']) expect(users).toContain(`value="${value}"`)
    const processes = render('/whm/databases/processes')
    expect(node(processes, 'data-whm-db-rows', 'processes').attrs.get('data-columns')).toBe('9')
    expect(processes).toContain('Query text is not read.')
    expect(processes).not.toContain('data-whm-db-drift-filter')
  })

  it('retains single sign-on setup without issuing a browser credential or premature launch', () => {
    const html = render('/whm/databases/phpmyadmin')
    expect(node(html, 'data-db-action', 'open').attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-db-checks').tag).toBe('ol')
    expect(html).not.toMatch(/type="password"|sealedPassword|temporary-password/)
    expect(html).toContain('phpPgAdmin has no supported single sign-on.')
  })

  it('retains reviewed package and backup stages before the upgrade control', () => {
    const html = render('/whm/databases/upgrade')
    expect(node(html, 'data-db-rows', 'packages').attrs.get('data-columns')).toBe('5')
    expect(html).toContain('/var/backups/xpanel/mariadb-upgrade')
    expect(node(html, 'data-db-action', 'upgrade').attrs.has('disabled')).toBe(true)
    expect(html.indexOf('database-upgrade-backup')).toBeLessThan(html.indexOf('data-db-action="upgrade"'))
    expect(node(html, 'data-db-job').attrs.has('hidden')).toBe(true)
  })

  it('keeps Redis and MongoDB data browsing unavailable without credentials', () => {
    const redis = render('/whm/databases/redis'), mongo = render('/whm/databases/mongodb')
    expect(node(redis, 'data-db-fact', 'requirePass').tag).toBe('dd')
    expect(node(mongo, 'data-db-fact', 'authorization').tag).toBe('dd')
    for (const html of [redis, mongo]) {
      expect(html).toContain('does not browse its data.')
      expect(html).not.toMatch(/type="password"|data-db-action="(?:save|connect|delete)"/)
    }
  })

  it('presents tuning as observations and an advisory plan without settings mutations', () => {
    const html = render('/whm/databases/tuning')
    expect(node(html, 'data-db-tuning-rows', 'variables').attrs.get('data-columns')).toBe('2')
    expect(node(html, 'data-db-tuning-rows', 'status').attrs.get('data-columns')).toBe('2')
    expect(node(html, 'data-db-tuning-plan').tag).toBe('div')
    expect(html).not.toMatch(/<form\b|type="submit"|data-db-tuning-save/)
  })

  it('keeps Arabic direction and ASCII digit glyphs without physical alignment CSS', () => {
    const html = render('/whm/databases/upgrade', { locale: 'ar' })
    expect(html).toContain('dir="rtl"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(WHM_DATABASE_PAGES_CSS).toContain('gap:var(--space-1)')
    expect(WHM_DATABASE_PAGES_CSS).not.toMatch(/text-align:(?:left|right)|margin-(?:left|right)|padding-(?:left|right)/)
  })
})
