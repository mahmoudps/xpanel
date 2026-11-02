import { describe, expect, it } from 'vitest'
import type { ServerSettings } from '@xpanel/core'
import { translator } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmServerPage, V2_WHM_SERVER_ROUTES, type WhmAdminAuthority } from './index.ts'

const principal = { kind: 'root' as const, id: 'root-fixture', username: 'operator' }
const authority: WhmAdminAuthority = { canRead: true, canManage: true, canUseTerminal: true }
const settings: ServerSettings = { hostname: 'stored.private.test', nameservers: ['ns1.private.test', 'ns2.private.test'], adminEmail: 'private@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 2222, backendPort: 8080, backendTlsPort: 8444,
  nginx: { workerProcesses: 'auto', workerConnections: 2048, workerRlimitNofile: 8192, multiAccept: false, keepaliveTimeoutSec: 45 }, apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 8, maxRequestWorkers: 200, maxConnectionsPerChild: 0, serverLimit: 200 } }
const props = (activeRoute: string, extra: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ principal, activeRoute, locale: 'en', ...extra })
const render = (route: string, extra: Partial<WhmSurfaceProps> = {}, admission: WhmAdminAuthority = authority) => renderV2WhmServerPage(translator(extra.locale ?? 'en'), props(route, extra), admission)!
const controls = (html: string) => html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []
const one = (html: string, name: string) => parseMarkup(html).find(node => node.attrs.has(name))

describe('v2 server administration family', () => {
  it.each(V2_WHM_SERVER_ROUTES)('retains the full %s workspace without private values or active operations by default', route => {
    const html = render(route, { serverSettings: settings, hostname: settings.hostname }, { canRead: false, canManage: false })
    expect(html).toContain(`data-v2-server-route="${route}"`)
    expect(html).not.toContain(settings.hostname); expect(html).not.toContain(settings.adminEmail)
    expect(html).not.toContain('<form')
    for (const control of controls(html)) expect(control).toMatch(/\sdisabled(?:\s|>)/)
    expect((html.match(/<h1\b/g) ?? [])).toHaveLength(1)
  })
  it('leaves unknown route dispatch to core without a generic unavailable page', () => {
    expect(renderV2WhmServerPage(translator('en'), props('/whm/panel/settings'), authority)).toBeUndefined()
  })
  it('retains all six setup sections and never seeds worker limits before their saved document is read', () => {
    const unread = render('/whm/server/setup')
    expect(unread).toContain('Network and nameservers'); expect(unread).toContain('Review and apply')
    const workers = parseMarkup(unread).filter(node => node.tag === 'input' && node.attrs.get('name')?.startsWith('nginx.'))
    expect(workers.length).toBeGreaterThan(3)
    for (const worker of workers) { expect(worker.attrs.has('disabled')).toBe(true); expect(worker.attrs.has('value')).toBe(false) }
    expect(unread).toContain('No candidate-generation test result has been returned for this setup request.')
    expect(unread).not.toContain('value="2048"')
    const saved = render('/whm/server/setup', { serverSettings: settings })
    expect(saved).toContain('name="nginx.workerConnections"'); expect(saved).toContain('value="2048"')
    expect(saved).toContain('name="apache.maxConnectionsPerChild"'); expect(saved).toContain('value="0"')
    expect(saved).toContain('data-server-settings-form'); expect(saved).toContain('data-setup-wizard-form')
    for (const name of ['hostname', 'adminEmail', 'primaryIpv4', 'nameservers', 'engine', 'apacheMpm', 'panelPort', 'sshPort', 'quotaFilesystem']) expect(saved).toContain(`name="${name}"`)
  })
  it('requires explicit root-terminal authority, keeps the second-factor control conditional and never renders credentials', () => {
    const denied = render('/whm/server/terminal', {}, { canRead: true, canManage: true })
    expect(denied).toContain('data-terminal-can-use="false"'); expect(denied).not.toContain('<form')
    const html = render('/whm/server/terminal')
    expect(html).toContain('data-terminal-kind="root"'); expect(html).toContain('data-terminal-can-use="true"')
    expect(html).toContain('data-terminal-totp-field hidden')
    expect(one(html, 'data-terminal-password')?.attrs.get('type')).toBe('password')
    expect(one(html, 'data-terminal-password')?.attrs.has('value')).toBe(false)
    expect(one(html, 'data-terminal-command')?.attrs.has('disabled')).toBe(true)
    for (const name of ['second-factor', 'execution', 'idle', 'absolute']) expect(html).toContain(`data-terminal-fact="${name}"`)
  })
  it('keeps saved proxy policy, active trust and explicit activation confirmation separate', () => {
    const html = render('/whm/server/trusted-proxies')
    for (const marker of ['saved', 'updated', 'active', 'activation']) expect(html).toContain(`data-trusted-proxies-field="${marker}"`)
    expect(one(html, 'data-trusted-proxies-cidrs')?.attrs.get('maxlength')).toBe('2100')
    expect(one(html, 'data-trusted-proxies-cidrs')?.attrs.get('dir')).toBe('ltr')
    expect(one(html, 'data-trusted-proxies-apply')?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('Type APPLY TRUSTED PROXIES to confirm')
  })
  it('shows a saved IP owner name without exposing a missing internal owner reference as text', () => {
    const ownerId = '12345678-1234-4123-8123-123456789abc'
    const html = render('/whm/server/ips', { ipPool: [{ id: 'ip-internal', address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'dedicated', ownerKind: 'account', ownerId, ptrHostname: null, isPrimary: false, notes: '' }] })
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).not.toContain(ownerId); expect(text).not.toContain('ip-internal'); expect(text).toContain('Owner unavailable')
    expect(html).toContain('data-ip-remove="ip-internal"')
    expect(html).toContain('name="ownerKind"'); expect(html).toContain('value="reseller" disabled')
  })
  it.each(['/whm/server/networking', '/whm/server/cron', '/whm/server/role'])('keeps %s observational and preserves its specific tables', route => {
    const html = render(route)
    expect(html).not.toContain('<form')
    expect(html).toContain('data-server-observation-can-read="true"')
    expect(html).toContain('data-whm-server-observation-refresh')
    expect(parseMarkup(html).filter(node => node.tag === 'tbody').length).toBeGreaterThanOrEqual(2)
  })
  it('retains NFS saved/apply/foreign sections and node enrollment/channel controls with unread facts', () => {
    const shares = render('/whm/server/file-sharing'), nodes = render('/whm/server/nodes')
    for (const hook of ['data-ops-shares-rows', 'data-ops-shares-editor', 'data-ops-shares-foreign-card', 'data-ops-shares-save']) expect(shares).toContain(hook)
    expect(shares).toContain('data-ops-shares-action="apply" disabled')
    for (const hook of ['data-ops-nodes-rows', 'data-ops-nodes-single', 'data-ops-nodes-fingerprint', 'data-ops-nodes-save']) expect(nodes).toContain(hook)
    expect(nodes).toContain('No node registry has been read.')
  })
  it('keeps Arabic direction and ASCII digits without leaking settings to another principal', () => {
    const html = render('/whm/server/setup', { locale: 'ar', serverSettings: settings, principal: { kind: 'reseller', id: 'r', username: 'provider' } })
    expect(html).toContain('lang="ar" dir="rtl"'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toContain(settings.hostname); expect(html).not.toContain('<form')
  })
})
