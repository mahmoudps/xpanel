import type { ServerSettings } from '@xpanel/core'
import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmServiceToolPage, V2_WHM_SERVICE_TOOL_ROUTES, WHM_SERVICE_TOOLS_CSS } from './index.ts'
import type { WhmDataPageInput } from '../software/common.ts'
import { WHM_WEB_SERVER_CSS } from './web.ts'
import { v2StylesheetsForDocument } from '../../../route-assets.ts'

const saved: ServerSettings = { hostname: 'host.example.test', nameservers: ['ns1.example.test'], adminEmail: 'admin@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443,
  nginx: { workerProcesses: 'auto', workerConnections: 4096, workerRlimitNofile: 16384, multiAccept: true, keepaliveTimeoutSec: 65 },
  apache: { startServers: 8, minSpareServers: 5, maxSpareServers: 20, maxRequestWorkers: 300, serverLimit: 256, maxConnectionsPerChild: 0 } }
const render = (route: string, input: WhmDataPageInput = {}) => renderV2WhmServiceToolPage({ dataAuthority: { canRead: true, canManage: true }, ...input, activeRoute: route })!
const node = (html: string, name: string, value?: string) => {
  const found = parseMarkup(html).find(item => item.attrs.has(name) && (value === undefined || item.attrs.get(name) === value))
  if (!found) throw new Error(`Missing ${name}`)
  return found
}

describe('V2 WHM service-tool documents', () => {


  it.each(['en', 'ar'] as const)('restores the Web Server flow, proxy and saved comparison in %s without inventing runtime evidence', locale => {
    const current = { ...saved, backendPort: 18181, backendTlsPort: 19443 }
    const html = render('/whm/services/web', { locale, serverSettings: current })
    const nodes = parseMarkup(html)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-hop'))).toHaveLength(3)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-snapshot-setting'))).toHaveLength(15)
    for (const key of ['web-flow', 'web-proxy', 'web-comparison', 'web-test-gate']) expect(node(html, 'data-whm-detail-section', key).tag).toBe('section')
    expect(nodes.filter(item => item.attrs.get('data-whm-web-snapshot') === 'page-load')).toHaveLength(3)
    expect(html).toContain('proxy_pass http://127.0.0.1:18181;')
    expect(html).toContain('proxy_set_header X-Forwarded-For $remote_addr;')
    expect(html).not.toContain('$proxy_add_x_forwarded_for')
    expect(html).not.toMatch(/alice-shop|20014|1\.24\.0|2\.4\.58|xpanel-&lt;uid&gt;/)
    expect(nodes.filter(item => item.attrs.has('data-server-settings-form'))).toHaveLength(1)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-readback'))).toHaveLength(1)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-generation'))).toHaveLength(1)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-rollback'))).toHaveLength(1)
    const ids = nodes.flatMap(item => item.attrs.has('id') ? [item.attrs.get('id')!] : [])
    expect(new Set(ids).size).toBe(ids.length)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('binds the explanatory backend to the saved engine and MPM rather than the Apache demo', () => {
    for (const [engine, apacheMpm, expected] of [
      ['apache', 'itk', 'Saved Apache MPM: itk.'],
      ['apache', 'prefork', 'Saved Apache MPM: prefork.'],
      ['openlitespeed', 'itk', 'OpenLiteSpeed is the saved engine.'],
    ] as const) {
      const html = render('/whm/services/web', { serverSettings: { ...saved, engine, apacheMpm } })
      expect(html).toContain(expected)
      expect(html).toContain('Runtime not observed')
      expect(html).not.toContain('Running</span>')
    }
  })

  it('keeps comparison defaults and proposed changes unreviewed until authoritative data is available', () => {
    const html = render('/whm/services/web', { serverSettings: saved })
    const nodes = parseMarkup(html)
    const sectionIndex = nodes.findIndex(item => item.attrs.get('data-whm-detail-section') === 'web-comparison')
    const belongs = (index: number): boolean => {
      for (let parent = nodes[index]!.parent; parent >= 0; parent = nodes[parent]!.parent) if (parent === sectionIndex) return true
      return false
    }
    const headers = nodes.filter((item, index) => belongs(index) && item.tag === 'th' && item.attrs.get('scope') === 'col')
    expect(headers).toHaveLength(5)
    expect(html).toContain('A host-specific default baseline has not been supplied.')
    expect(html).toContain('Not reviewed')
    expect(html).not.toContain('Default for 4 cores / 8 GB')
    expect(nodes.filter(item => item.attrs.get('href') === '#v2-whm-data-web-pending')).toHaveLength(1)
    expect(nodes.filter(item => item.attrs.has('data-whm-web-test-gate'))).toHaveLength(1)
  })

  it('retains unknown architecture when settings are unread and never exposes denied saved ports', () => {
    const unread = render('/whm/services/web')
    expect(node(unread, 'data-whm-web-proxy-reference').attrs.get('data-state')).toBe('unread')
    expect(unread).not.toContain('proxy_pass http://127.0.0.1:')
    for (const extra of [{ dataAuthority: undefined }, { capabilityUnavailable: true }]) {
      const html = render('/whm/services/web', { serverSettings: { ...saved, backendPort: 18181, backendTlsPort: 19443 }, ...extra })
      expect(node(html, 'data-whm-web-proxy-reference').attrs.get('data-state')).toBe('unread')
      expect(html).not.toMatch(/18181|19443|proxy_pass http:\/\/127\.0\.0\.1:/)
      expect(parseMarkup(html).filter(item => ['input', 'select', 'textarea', 'button'].includes(item.tag)).every(item => item.attrs.has('disabled'))).toBe(true)
    }
  })

  it('loads the Web Server supplement only for that authorized document selection', () => {
    const selected = v2StylesheetsForDocument({ surface: 'xwhm', route: '/whm/services/web', viewKind: 'workspace' })
    const supplement = selected.find(item => item.path === '/assets/themes/v2/whm-web-server.css')
    expect(supplement?.body).toBe(WHM_WEB_SERVER_CSS.trim() + '\n')
    for (const route of ['/whm/services/dns', '/whm/services', '/whm/software/php', '/whm/plans']) {
      expect(v2StylesheetsForDocument({ surface: 'xwhm', route, viewKind: 'workspace' }).some(item => item.path === supplement!.path)).toBe(false)
    }
    for (const viewKind of ['status', 'login'] as const) expect(v2StylesheetsForDocument({ surface: 'xwhm', route: '/whm/services/web', viewKind }).some(item => item.path === supplement!.path)).toBe(false)
    expect(v2StylesheetsForDocument({ surface: 'xpanel', route: '/whm/services/web', viewKind: 'workspace' }).some(item => item.path === supplement!.path)).toBe(false)
    expect(WHM_WEB_SERVER_CSS).toContain('[data-whm-detail-route="/whm/services/web"]')
    expect(WHM_WEB_SERVER_CSS).not.toMatch(/text-align:(?:left|right)|margin-(?:left|right)/)
  })

  it('maps exactly seven service-tool documents without claiming the existing service manager', () => {
    expect(new Set(V2_WHM_SERVICE_TOOL_ROUTES).size).toBe(7)
    for (const route of V2_WHM_SERVICE_TOOL_ROUTES) {
      const html = render(route)
      expect(html).toContain(`data-whm-detail-route="${route}"`)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toMatch(/class="[^"\n]*\bxp-|<style\b|<script\b/)
    }
    expect(renderV2WhmServiceToolPage({ activeRoute: '/whm/services/more' })).toBeUndefined()
  })

  it('keeps all service controls disabled when no core authority is supplied', () => {
    for (const route of V2_WHM_SERVICE_TOOL_ROUTES) {
      const html = render(route, { dataAuthority: undefined })
      expect(html).toContain('data-capability-state="unavailable"')
      expect(parseMarkup(html).filter(item => ['input', 'select', 'textarea', 'button'].includes(item.tag)).every(item => item.attrs.has('disabled'))).toBe(true)
    }
  })

  it('does not expose saved settings through a denied or unqualified presentation', () => {
    const secrets = { ...saved, backendPort: 18181, backendTlsPort: 19443 }
    for (const extra of [{ dataAuthority: undefined }, { capabilityUnavailable: true }]) {
      const html = render('/whm/services/web', { serverSettings: secrets, ...extra })
      expect(html).not.toContain('18181')
      expect(html).not.toContain('19443')
      expect(html).not.toContain('data-server-settings-form')
    }
  })

  it('renders the full web setting contract while keeping drafts distinct from observations', () => {
    const html = render('/whm/services/web', { serverSettings: saved })
    expect(node(html, 'data-server-settings-form').tag).toBe('form')
    const fields = parseMarkup(html).filter(item => item.attrs.has('name'))
    for (const name of ['engine', 'apacheMpm', 'backendPort', 'backendTlsPort', 'nginx.workerProcesses', 'nginx.workerConnections', 'nginx.workerRlimitNofile', 'nginx.keepaliveTimeoutSec', 'nginx.multiAccept', 'apache.startServers', 'apache.minSpareServers', 'apache.maxSpareServers', 'apache.maxRequestWorkers', 'apache.serverLimit', 'apache.maxConnectionsPerChild']) expect(fields.some(item => item.attrs.get('name') === name), name).toBe(true)
    expect(html).toContain('value="8080"')
    expect(node(html, 'data-whm-web-status').attrs.get('data-state')).toBe('unread')
    expect(node(html, 'data-whm-web-services').attrs.get('data-columns')).toBe('3')
    expect(node(html, 'data-whm-web-readback').attrs.get('data-web-can-rollback')).toBe('false')
  })

  it('uses only supported engine and Apache MPM values', () => {
    const html = render('/whm/services/web', { serverSettings: saved })
    expect(html).toContain('value="apache" selected')
    expect(html).toContain('value="openlitespeed"')
    expect(html).toContain('value="itk" selected')
    expect(html).toContain('value="prefork"')
    expect(html).not.toMatch(/value="(?:nginx|event)"/)
  })

  it('keeps read-only web settings outside a submit form and generation restore disabled', () => {
    const html = render('/whm/services/web', { serverSettings: saved, dataAuthority: { canRead: true, canManage: false } })
    expect(html).not.toContain('data-server-settings-form')
    expect(node(html, 'data-whm-readonly-fields').tag).toBe('div')
    expect(node(html, 'data-whm-web-rollback').attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-whm-web-generation').attrs.has('disabled')).toBe(true)
    for (const section of ['web-stack', 'web-pending', 'web-generations']) expect(node(html, 'data-whm-detail-section', section).tag).toBe('section')
  })

  it('retains DNS, FTP and service certificate readback with correct column counts', () => {
    for (const [kind, columns] of [['dns', '7'], ['ftp', '4'], ['certificates', '10']]) {
      const html = render(`/whm/services/${kind}`)
      expect(node(html, 'data-whm-service-detail-rows').attrs.get('data-columns')).toBe(columns)
      expect(node(html, 'data-whm-service-detail-status').attrs.get('data-state')).toBe('unread')
      if (kind === 'certificates') {
        expect(html).not.toContain('data-whm-service-detail-restart')
        expect(html).toContain('Private keys are checked for presence and never opened.')
      } else expect(node(html, 'data-whm-service-detail-restart').attrs.has('disabled')).toBe(true)
    }
  })

  it('preserves exact repair confirmation and fresh-generation requirements', () => {
    const html = render('/whm/services/health')
    expect(node(html, 'data-ch-targets').attrs.get('data-columns')).toBe('4')
    expect(node(html, 'data-ch-tests').attrs.get('data-columns')).toBe('3')
    expect(node(html, 'data-ch-confirm').attrs.get('maxlength')).toBe('20')
    expect(node(html, 'data-ch-confirm').attrs.has('disabled')).toBe(true)
    expect(html).toContain('REPAIR CONFIGURATION')
    expect(node(html, 'data-ch-repair').attrs.has('disabled')).toBe(true)
    expect(html).toContain('other drift must stay unchanged')
  })

  it('does not invent an index order before reading saved domain configuration', () => {
    const html = render('/whm/services/default-index')
    const files = node(html, 'data-default-index-files')
    expect(files.attrs.get('value') ?? '').toBe('')
    expect(files.attrs.get('maxlength')).toBe('1055')
    expect(files.attrs.has('disabled')).toBe(true)
    expect(node(html, 'data-default-index-status').attrs.get('data-state')).toBe('unread')
    for (const hook of ['preview', 'save', 'reset']) expect(node(html, `data-default-index-${hook}`).attrs.has('disabled')).toBe(true)
    expect(html).toContain('Preview is not a native syntax check.')
  })

  it('retains FTP window, filters, eight counters and the per-user detail panel', () => {
    const html = render('/whm/services/ftp-log-analysis')
    expect(node(html, 'data-ftp-log-form').tag).toBe('form')
    expect(node(html, 'data-ftp-log-range').attrs.has('disabled')).toBe(true)
    expect(parseMarkup(html).filter(item => item.attrs.has('data-ftp-log-count'))).toHaveLength(8)
    for (const key of ['users', 'clients', 'bursts']) expect(node(html, 'data-ftp-log-table', key).tag).toBe('tbody')
    expect(node(html, 'data-ftp-log-rows').attrs.get('data-columns')).toBe('7')
    expect(node(html, 'data-ftp-log-detail').attrs.get('tabindex')).toBe('-1')
    expect(node(html, 'data-ftp-log-detail-body').attrs.has('hidden')).toBe(true)
  })

  it('preserves Arabic field alignment and the semantic spacing hierarchy', () => {
    const html = render('/whm/services/web', { locale: 'ar', serverSettings: saved })
    expect(html).toContain('dir="rtl"')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    for (const token of ['gap:var(--space-1)', 'gap:var(--space-2)', 'gap:var(--space-3)', 'gap:var(--space-4)']) expect(WHM_SERVICE_TOOLS_CSS).toContain(token)
    expect(WHM_SERVICE_TOOLS_CSS).not.toMatch(/text-align:(?:left|right)|margin-(?:left|right)/)
  })
})
