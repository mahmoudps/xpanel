import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { renderPanelSurface, type PanelSurfaceProps } from './surfaces/xpanel.ts'
import { renderWhmSurface, type WhmSurfaceProps } from './surfaces/xwhm.ts'
import { renderLoginSurface } from './surfaces/login.ts'
import { renderStatusBody } from './status-page.ts'

const at = '2026-10-22T14:05:00Z'
const plan = { ...defaultPlan({ id: 'copy-plan', name: 'Synthetic plan', featureListId: 'copy-features' }), shell: 'jailed' as const }
const account: Account = {
  id: 'copy-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '192.0.2.21', ipv6: '2001:db8::12', shell: 'jailed', createdAt: at,
}
const panel: PanelSurfaceProps = {
  locale: 'ar',
  account, plan,
  domains: [{ id: 'copy-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: account.ipv6 }],
  files: [{ name: 'note.txt', path: '/home/alice/public_html/note.txt', kind: 'file', sizeBytes: 128, modeOctal: '0640', modifiedAt: at }],
  databases: [{ id: 'copy-db', accountId: account.id, engine: 'mariadb', name: 'alice_shop', trashedAt: null }],
  serviceUsers: [{ id: 'copy-user', accountId: account.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
  dnsRecords: [{ id: 'copy-dns', zone: account.primaryDomain, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }],
}
const whm: WhmSurfaceProps = {
  locale: 'ar',
  principal: { kind: 'root', id: 'copy-root', username: 'root' },
  accounts: [account],
  plans: [plan],
}

const ALLOWED = new Set([
  'xpanel', 'xwhm', 'xmail', 'ssl', 'tls', 'dns', 'ftp', 'ttl', 'php', 'html', 'http', 'https',
  'mariadb', 'powerdns', 'bind', 'nginx', 'apache', 'acme', 'ctrl', 'utc', 'ibm', 'rfc', 'totp',
  'spf', 'dkim', 'dmarc', 'inbox', 'sieve', 'nftables', 'postfix', 'dovecot', 'chroot', 'chmod',
  'systemd', 'cgroup', 'slice', 'uid', 'ssh', 'ipv4', 'ipv6', 'argon2id', 'sqlite', 'csv', 'json',
  'utf', 'ascii', 'ok', 'mb', 'gb', 'kb', 'tb', 'cpu', 'rss', 'ptr', 'helo', 'ehlo', 'spf',
  'public_html', 'trash', 'user', 'ini', 'conf', 'fpm', 'ondemand', 'english',
])

const mainHtml = (html: string): string => {
  const marker = html.indexOf('id="main-content"')
  if (marker < 0) return html
  const openEnd = html.indexOf('>', marker)
  const end = html.lastIndexOf('</main>')
  return openEnd >= 0 && end > openEnd ? html.slice(openEnd + 1, end) : html
}

const visibleCopy = (html: string): string => {
  const source = mainHtml(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:bdi|code|kbd|time)\b[^>]*>[\s\S]*?<\/(?:bdi|code|kbd|time)>/gi, ' ')
  const parts: string[] = []
  for (const match of source.matchAll(/<(th|label|button|h1|h2|p|summary)\b[^>]*>([\s\S]*?)<\/\1>/gi)) parts.push(match[2] ?? '')
  for (const match of source.matchAll(/<span class="xp-badge__label">([^<]*)<\/span>/g)) parts.push(match[1] ?? '')
  return parts.join('\n').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ')
}

const latinWords = (text: string): string[] => {
  const found = text.match(/[A-Za-z][A-Za-z0-9_-]{3,}/g) ?? []
  return [...new Set(found.filter(word => !ALLOWED.has(word.toLowerCase()) && !/^\d+$/.test(word)))]
}

describe('Arabic render keeps interface copy in Arabic', () => {
  const pages: Array<[string, string]> = [
    ['email accounts', renderPanelSurface({ ...panel, activeRoute: '/email/accounts' })],
    ['files', renderPanelSurface({ ...panel, activeRoute: '/files/manager' })],
    ['domains', renderPanelSurface({ ...panel, activeRoute: '/domains' })],
    ['databases', renderPanelSurface({ ...panel, activeRoute: '/databases/mariadb' })],
    ['ssl', renderPanelSurface({ ...panel, activeRoute: '/security/ssl' })],
    ['dns', renderPanelSurface({ ...panel, activeRoute: '/domains/zone-editor' })],
    ['accounts', renderWhmSurface({ ...whm, activeRoute: '/whm/accounts' })],
    ['create account', renderWhmSurface({ ...whm, activeRoute: '/whm/accounts/new' })],
    ['plans', renderWhmSurface({ ...whm, activeRoute: '/whm/plans' })],
    ['xpanel login', renderLoginSurface({ locale: 'ar', audience: 'xpanel' })],
    ['xwhm login', renderLoginSurface({ locale: 'ar', audience: 'xwhm' })],
    ['xmail login', renderLoginSurface({ locale: 'ar', audience: 'xmail' })],
    ['status 404', renderStatusBody({ status: 404, locale: 'ar', theme: 'light', density: 'comfortable', surface: 'xpanel', path: '/missing' })],
  ]

  it('does not leave the known English labels in Arabic email, file, and account screens', () => {
    const email = pages.find(([name]) => name === 'email accounts')?.[1] ?? ''
    const joined = pages.map(([, html]) => visibleCopy(html)).join('\n')
    for (const phrase of ['Service Logins', 'Mailbox Quota', 'Host binding unverified']) {
      assert.equal(joined.includes(phrase), false, phrase)
    }
    assert.doesNotMatch(email, />Login</)
    assert.doesNotMatch(email, />Services</)
    assert.match(email, /تسجيل الدخول/)
    assert.match(email, /الخدمات/)
    assert.match(email, /حصة صندوق البريد/)
    assert.match(email, /تسجيلات دخول للخدمات/)
    assert.match(pages.find(([name]) => name === 'create account')?.[1] ?? '', /بريد التواصل/)
    assert.doesNotMatch(BROWSER_REALTIME_SCRIPT, /window\.prompt|Host binding unverified/)
  })

  it('fails when Arabic main copy still contains an unlisted English word', () => {
    const leftovers = pages.flatMap(([name, html]) => latinWords(visibleCopy(html)).map(word => `${name}: ${word}`))
    assert.deepEqual(leftovers, [])
  })
})
