import { createServer } from 'node:http'
import { tools } from '../../packages/catalog/src/index.ts'
import { defaultPlan } from '../../packages/core/src/index.ts'
import { resolveWebDocumentRoute, serveWebUi } from '../../apps/web/src/index.ts'

// These observations and the catalog override belong only to this visual fixture.
// They never update the production catalog, authenticate a session or execute host work.
const at = '2026-10-22T12:00:00Z'
const plan = { ...defaultPlan({ id: 'visual-plan', name: 'Synthetic Standard', featureListId: 'visual-features' }), shell: 'jailed' }
const account = {
  id: 'visual-account', username: 'preview', uid: 20042, gid: 20042,
  home: '/home/preview', primaryDomain: 'preview.example.test', planId: plan.id,
  ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@preview.example.test',
  ipv4: '192.0.2.42', ipv6: '2001:db8::42', extraIps: [], shell: 'jailed', createdAt: at,
}
const root = { kind: 'root', id: 'visual-root', username: 'synthetic-root' }
const owner = { kind: 'user', id: 'visual-owner', username: account.username, accountId: account.id }
const domain = {
  id: 'visual-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: '/home/preview/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
  ipv4: account.ipv4, ipv6: account.ipv6,
}
const ioPoint = { at, readBytesPerSec: 18 * 1024 * 1024, writeBytesPerSec: 8 * 1024 * 1024,
  readIops: 240, writeIops: 120, awaitMs: 1.2, psiSomeAvg10: 0.8, psiFullAvg10: 0.1,
  cpuPercent: 24, memoryUsedBytes: 2 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, loadAvg1m: 0.32 }
const trafficPoint = { at, requests: 1200, bytes: 24 * 1024 ** 2, status2xx: 1140, status3xx: 40,
  status4xx: 18, status5xx: 2, cacheHit: 900, cacheMiss: 280, cacheBypass: 20,
  avgRequestTimeMs: 18, p95RequestTimeMs: 42, avgUpstreamTimeMs: 12 }
const websiteAnalytics = {
  domain: domain.name, accountId: account.id, at,
  totals: { requests: 3600, bytes: 72 * 1024 ** 2, uniqueVisitors: 820, cacheHitRatioPercent: 75,
    errorRatePercent: 0.17, avgRequestTimeMs: 18, p95RequestTimeMs: 42, avgUpstreamTimeMs: 12,
    status2xx: 3420, status3xx: 120, status4xx: 54, status5xx: 6 },
  series: [0, 1, 2].map(index => ({ ...trafficPoint, at: `2026-10-22T11:5${index}:00Z`, requests: 1000 + index * 200 })),
  topPaths: [{ key: '/synthetic-catalog', requests: 480, bytes: 4 * 1024 ** 2, errors5xx: 0 }],
  topReferrers: [{ key: 'https://example.test/', requests: 180, bytes: 1024 ** 2, errors5xx: 0 }],
  topClientIps: [{ key: '192.0.2.100', requests: 60, bytes: 512 * 1024, errors5xx: 0 }],
}
const catalog = tools.map(tool => tool.status === 'out-of-scope' ? tool : ({
  ...tool, status: 'verified', delivery: { status: 'verified', reason: 'Synthetic visual fixture only; no production qualification.', evidence: [] },
}))

const stateFor = (route, qualifiedCatalog) => ({
  surface: route.surface, activeRoute: route.activeRoute, realtimeEnabled: false,
  title: 'Synthetic visual fixture — xPanel', accountId: account.id, catalog: qualifiedCatalog ? catalog : tools,
  visibility: { principal: route.surface === 'xwhm' ? root : owner, disabledFeatures: new Set() },
  whm: {
    principal: root, hostname: 'synthetic-host.example.test', version: '0.1.0-fixture', availableVersion: '0.1.0-fixture',
    adminSessionIp: '192.0.2.100', plans: [plan], accounts: [account],
    ioSnapshot: { at, current: ioPoint, history: [0, 1, 2].map(index => ({ ...ioPoint, at: `2026-10-22T11:5${index}:00Z`, readBytesPerSec: (12 + index * 3) * 1024 ** 2 })),
      accounts: [{ accountId: account.id, username: account.username, uid: account.uid, readBytesPerSec: 3 * 1024 ** 2, writeBytesPerSec: 1024 ** 2, readIops: 48, writeIops: 20, memoryCurrentBytes: 256 * 1024 ** 2, memoryLimitMb: 1024, pidsCurrent: 24, pidsLimit: 100, cpuPercent: 18, statusLevel: 'ok' }] },
    services: ['nginx', 'apache', 'php-fpm', 'mariadb', 'dovecot', 'postfix', 'pdns', 'nftables'].map(name => ({ name, unit: `${name}.service`, version: 'synthetic', active: true, enabled: true, rssMb: 24, role: 'Synthetic visual sample' })),
    resellers: [{ id: 'visual-reseller', username: 'previewreseller', acl: ['list-accounts', 'create-account'], maxAccounts: 10, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: false, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [] }],
    ipPool: [{ id: 'visual-ip', address: account.ipv4, version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: 'mail.preview.example.test', isPrimary: true, notes: 'Synthetic RFC 5737 address' }],
    mailIpConfig: { mode: 'custom-map', defaultIpv4: account.ipv4, defaultIpv6: account.ipv6, defaultHelo: 'mail.preview.example.test', domainOverrides: [{ domainName: domain.name, ipv4: account.ipv4, ipv6: account.ipv6, heloHostname: 'mail.preview.example.test' }] },
    firewallRules: [{ id: 'visual-firewall', kind: 'port', action: 'accept', protocol: 'tcp', port: '443', source: null, forwardTo: null, list: null, comment: 'Synthetic HTTPS sample', enabled: true }],
    generations: [{ generationId: 42, at, actor: 'synthetic-root', summary: 'Synthetic configuration sample', stateChecksum: 'synthetic-checksum', filesCount: 12, durationMs: 80, status: 'superseded' }],
    auditEntries: [{ id: 'visual-audit', at, actor: 'synthetic-root', action: 'visual.preview', target: 'Synthetic sample', detail: {}, outcome: 'ok' }],
  },
  panel: {
    account, plan, domains: [domain], activeDomain: domain.name, websiteAnalytics,
    customConfig: { domainId: domain.id, accountId: account.id, domainName: domain.name, nginxInclude: '# Synthetic visual sample', apacheInclude: '# Synthetic visual sample', userIni: { memory_limit: '256M' }, customHeaders: {}, cacheBypassPaths: [], updatedAt: at, updatedBy: 'user' },
    files: [{ name: 'synthetic-index.html', path: '/home/preview/public_html/synthetic-index.html', kind: 'file', sizeBytes: 2048, modeOctal: '0640', modifiedAt: at }, { name: 'archive', path: '/home/preview/.trash/archive', kind: 'folder', sizeBytes: 0, modeOctal: '0750', modifiedAt: at, trashed: true }],
    databases: [{ id: 'visual-database', accountId: account.id, engine: 'mariadb', name: 'preview_synthetic', trashedAt: null }],
    serviceUsers: [{ id: 'visual-service-user', accountId: account.id, login: 'info@preview.example.test', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
    dnsRecords: [{ id: 'visual-dns', zone: domain.name, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }],
  },
  mail: {
    mailbox: 'info@preview.example.test', domain: domain.name, quotaUsedMb: 160, quotaLimitMb: 1024,
    messages: [{ uid: 1, folder: 'INBOX', from: 'preview-sender@example.test', to: 'info@preview.example.test', subject: 'Synthetic welcome message', preview: 'This message is visual test data.', body: 'This is synthetic visual test data. No mail server was contacted.', receivedAt: at, sizeKb: 2, unread: true, dkimPass: true, spfPass: true, dmarcPass: true }],
    sieveRules: [{ id: 'visual-sieve', name: 'Synthetic archive rule', condition: 'subject contains preview', action: 'fileinto Archive', enabled: true }], vacationEnabled: false,
  },
})

const markVisualDocument = html => html
  .replace('<html ', '<html data-visual-fixture="synthetic" ')
  .replace('<body>', '<body data-visual-fixture="synthetic"><div role="note" data-visual-fixture-watermark style="position:sticky;inset-block-start:0;z-index:2000;padding:5px 12px;text-align:center;background:#f4f6f8;color:#384354;border-block-end:1px solid #d5dce4;font:12px/1.4 sans-serif" dir="ltr">Synthetic visual fixture</div>')

/**
 * Loopback-only, read-only visual server. No API authentication, cookies, secrets or host commands.
 * qualifiedCatalog=false retains the original catalog states for unavailable-workspace rendering.
 * Principals and account data remain synthetic in either case.
 */
export async function createVisualFixture({ port = 0, host = '127.0.0.1', qualifiedCatalog = true } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The visual fixture must bind to loopback.')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid visual fixture port.')
  if (typeof qualifiedCatalog !== 'boolean') throw new Error('The synthetic catalog selection must be explicit.')
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
        outgoing.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        incoming.resume()
        outgoing.end('This synthetic visual fixture is read-only.')
        return
      }
      const address = server.address()
      const origin = `http://${host === '::1' ? '[::1]' : host}:${address.port}`
      const url = new URL(incoming.url ?? '/', origin)
      const route = resolveWebDocumentRoute(url.pathname)
      const asset = url.pathname === '/favicon.ico' || url.pathname === '/assets' || url.pathname.startsWith('/assets/')
      if (!asset && !route) {
        outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        outgoing.end(incoming.method === 'HEAD' ? undefined : 'No synthetic visual document exists here.')
        return
      }
      const response = await serveWebUi(new Request(url, { method: incoming.method }), route ? () => stateFor(route, qualifiedCatalog) : undefined)
      const html = response.headers.get('content-type')?.startsWith('text/html')
      const body = html ? markVisualDocument(await response.text()) : await response.text()
      outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), 'cache-control': 'no-store', 'x-visual-fixture': 'synthetic' })
      outgoing.end(incoming.method === 'HEAD' ? undefined : body)
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      outgoing.end('Synthetic visual fixture could not render this document.')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  return {
    baseUrl: `http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.closeIdleConnections()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}
