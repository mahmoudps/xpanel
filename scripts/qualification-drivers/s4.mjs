import { randomBytes } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const SERVICES = '/api/server/services'
const MANAGER = '/api/server/service-manager'
const NOTIFICATIONS = '/api/server/panel/notifications'
const SETTINGS = '/api/server/settings'
const rowOf = (response, id) => (Array.isArray(response?.data?.services) ? response.data.services.find(item => item.id === id) : undefined)
const canon = value => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item))
const servicesPage = { route: '/whm/services', read: SERVICES, shows: data => [data?.services?.[0]?.label] }
const notificationsPage = { route: '/whm/panel/notifications', read: NOTIFICATIONS, shows: data => Array.isArray(data?.settings?.recipients) ? data.settings.recipients : [] }
const restartPaths = (...extra) => new RegExp(`^/api/server/(?:services(?:/[a-z0-9-]+/restart)?|service-manager${extra.map(item => `|${item}`).join('')})$`)
const restartUnit = [
  { suffix: 'UNIT-RESTART', name: 'host services restarts a daemon without an offline checker directly' },
  { suffix: 'UNIT-CONFIG-TEST', name: 'host services refuses the restart when the configuration test fails and keeps only its bounded stderr' },
]
const unitsOf = (prefix, ...names) => (names.length ? names : restartUnit).map(item => ({ id: `${prefix}-${item.suffix}`, file: 'apps/agent/src/phase2-host.test.ts', name: item.name }))

/** Restarts a service that is active now, never a stopped one, and keeps polling until it reads active again. */
async function restartActive({ root, undo, until }, id) {
  const before = await root.get(SERVICES), row = rowOf(before, id)
  if (before.status !== 200 || row?.state !== 'active') return { before, row, restarted: false }
  undo(`${id} active`, async () => rowOf(await root.get(SERVICES), id)?.state === 'active')
  const response = await root.post(`${SERVICES}/${id}/restart`, {})
  const settled = await until(() => root.get(SERVICES), read => rowOf(read, id)?.state === 'active', { attempts: 10, delayMs: 1500 })
  return { before, row, response, settled, restarted: true }
}
const cameBack = cycle => cycle.restarted && cycle.response.status === 200 && cycle.response.data?.service?.state === 'active' && cycle.settled.settled
const seen = cycle => ({ before: cycle.row?.state ?? null, status: cycle.response?.status ?? null, active: cycle.settled?.settled ?? false })

async function guardSettings({ root, undo }) {
  const read = await root.get(SETTINGS), original = read.data?.settings
  if (read.status !== 200 || !original) return null
  const write = body => root.put(SETTINGS, { ...body, markSetupComplete: false })
  undo('server settings', async () => {
    if (canon((await root.get(SETTINGS)).data?.settings) === canon(original)) return true
    if ((await write(original)).status !== 200) return false
    return canon((await root.get(SETTINGS)).data?.settings) === canon(original)
  })
  return { original, write, read }
}

const DEFAULT_WEB = { timeoutSec: 60, clientMaxBodyMb: 128, tlsProtocols: ['TLSv1.2', 'TLSv1.3'], tlsCiphers: 'HIGH:!aNULL:!MD5', gzip: { enabled: true, level: 5 }, directoryIndex: ['index.php', 'index.html'], rlimitMemMb: null, rlimitCpuSec: null, includes: { apachePreMain: '', apachePreVhost: '', apachePostVhost: '', nginxHttp: '' } }

/** Saves notification settings and registers verified restore (using /reset when initial state was default). */
async function guardNotifications({ root, undo }) {
  const read = await root.get(NOTIFICATIONS), initialState = read.data?.state, saved = read.data?.settings ?? null
  if (read.status !== 200 || typeof read.data?.revision !== 'string') return null
  undo('notification settings', async () => {
    const now = await root.get(NOTIFICATIONS)
    if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
    if (initialState === 'default') {
      if (now.data?.state === 'default') return true
      const reset = await root.post(`${NOTIFICATIONS}/reset`, { expectedRevision: now.data.revision })
      return reset.status === 200 && (await root.get(NOTIFICATIONS)).data?.state === 'default'
    }
    if (saved === null) return false
    if (canon(now.data?.settings ?? null) === canon(saved)) return true
    const back = await root.put(NOTIFICATIONS, {
      recipients: saved.recipients ?? [],
      events: saved.events ?? [],
      webhook: saved.webhook ?? null,
      ...(saved.emailMinimumSeverity !== undefined ? { emailMinimumSeverity: saved.emailMinimumSeverity } : {}),
      ...(saved.telegram !== undefined ? { telegram: saved.telegram ? { chatId: saved.telegram.chatId, enabled: saved.telegram.enabled } : null } : {}),
      expectedRevision: now.data.revision,
    })
    return back.status === 200 && canon((await root.get(NOTIFICATIONS)).data?.settings) === canon(saved)
  })
  return { read, saved }
}

const SECRET = () => `Xq-${randomBytes(18).toString('base64url')}-9a`

export default [
  tool('restart-dns', {
    prefix: 'RDNS', probe: SERVICES, paths: restartPaths(), page: servicesPage, unit: unitsOf('RDNS'),
    checks: ['RESTART-SUCCESS', 'PORT-53-ANSWERS', 'UNKNOWN-SERVICE-REFUSED'],
    async run(x) {
      const cycle = await restartActive(x, 'pdns')
      x.check('RESTART-SUCCESS', cameBack(cycle), seen(cycle))
      const dns = cycle.restarted ? await x.net.dnsQuery('localhost', 1) : null
      x.check('PORT-53-ANSWERS', cameBack(cycle) && dns?.ok === true, { ...seen(cycle), dnsOk: dns?.ok ?? false, rcode: dns?.rcode ?? null })
      x.refused('UNKNOWN-SERVICE-REFUSED', await x.root.post(`${SERVICES}/unknown-dns/restart`, {}), 'NOT_FOUND')
    },
  }),

  tool('restart-ftp', {
    prefix: 'RFTP', probe: SERVICES, paths: restartPaths(), page: servicesPage, unit: unitsOf('RFTP'),
    checks: ['UNKNOWN-SERVICE-REFUSED', 'PORT-21-ACCEPTS', 'SERVICE-ACTIVE-AFTER-RESTART'],
    async run(x) {
      const cycle = await restartActive(x, 'pure-ftpd')
      x.refused('UNKNOWN-SERVICE-REFUSED', await x.root.post(`${SERVICES}/unknown-ftp/restart`, {}), 'NOT_FOUND')
      const ftp = cycle.restarted ? await x.net.tcpBanner(21) : null
      x.check('PORT-21-ACCEPTS', cameBack(cycle) && ftp?.ok === true && /^220\b/.test(ftp.banner), { ...seen(cycle), bannerOk: ftp?.ok ?? false })
      x.check('SERVICE-ACTIVE-AFTER-RESTART', cameBack(cycle), seen(cycle))
    },
  }),

  tool('restart-web', {
    prefix: 'RWEB', needs: ['account'], probe: SERVICES, paths: restartPaths('settings'), page: servicesPage, requests: 40, unit: unitsOf('RWEB'),
    checks: ['BROKEN-INCLUDE-REFUSED', 'SITES-KEEP-RESPONDING'],
    async run(x) {
      const guard = await guardSettings(x)
      if (!guard) return
      const web = guard.original.web ?? DEFAULT_WEB
      const broken = await guard.write({ ...guard.original, web: { ...web, includes: { ...web.includes, nginxHttp: `xq_${x.tag}_invalid_directive on;` } } })
      x.undo('nginx active', async () => rowOf(await x.root.get(SERVICES), 'nginx')?.state === 'active')
      const restart = await x.root.post(`${SERVICES}/nginx/restart`, {})
      x.refused('BROKEN-INCLUDE-REFUSED', restart, 'CONFIG_TEST_FAILED')
      const served = await x.site.get(x.fixture.domain, '/').catch(() => ({ status: 0 }))
      x.check('SITES-KEEP-RESPONDING', broken.status === 200 && served.status > 0 && served.status < 500, { saveStatus: broken.status, restartStatus: restart.status, siteStatus: served.status })
    },
  }),

  tool('restart-imap', {
    prefix: 'RIMAP', also: ['mailbox'], needs: ['account', 'mailbox'], probe: SERVICES, paths: restartPaths(), page: servicesPage, requests: 40, unit: unitsOf('RIMAP'),
    checks: ['IMAP-LOGIN-WITHIN-10S'],
    async run(x) {
      const cycle = await restartActive(x, 'dovecot')
      const started = Date.now()
      const login = cycle.restarted ? await x.until(() => x.signIn('mailbox', { username: x.fixture.mailbox.address, password: x.fixture.mailbox.password }), read => read.client !== null, { attempts: 10, delayMs: 1000 }) : null
      const seconds = Math.round((Date.now() - started) / 100) / 10
      x.check('IMAP-LOGIN-WITHIN-10S', cameBack(cycle) && login?.settled === true && seconds <= 10, { ...seen(cycle), seconds, attempts: login?.attempts ?? 0 })
    },
  }),

  tool('restart-mta', {
    prefix: 'RMTA', probe: SERVICES, paths: restartPaths('mail-queue'), page: servicesPage, unit: unitsOf('RMTA'),
    checks: ['QUEUE-PRESERVED', 'PORT-25-220-BANNER'],
    async run(x) {
      const kept = read => (Array.isArray(read.data?.messages) ? read.data.messages.filter(item => ['deferred', 'hold'].includes(item.queue)).map(item => item.queueId) : [])
      const queued = await x.root.get('/api/server/mail-queue')
      const cycle = await restartActive(x, 'postfix')
      const after = await x.root.get('/api/server/mail-queue')
      const beforeIds = kept(queued), afterIds = kept(after)
      x.check('QUEUE-PRESERVED', cameBack(cycle) && queued.status === 200 && after.status === 200 && Array.isArray(queued.data?.messages) && Array.isArray(after.data?.messages) && afterIds.length <= beforeIds.length,
        { ...seen(cycle), queued: beforeIds.length, remaining: afterIds.length })
      const smtp = cycle.restarted ? await x.net.tcpBanner(25) : null
      x.check('PORT-25-220-BANNER', cameBack(cycle) && smtp?.ok === true && /^220\b/.test(smtp.banner), { ...seen(cycle), bannerOk: smtp?.ok ?? false })
    },
  }),

  tool('restart-mysql', {
    prefix: 'RSQL', probe: SERVICES, paths: restartPaths('databases/tuning'), page: servicesPage, requests: 45, unit: unitsOf('RSQL'),
    checks: ['ROOT-CLIENT-CONNECTS', 'UPTIME-BELOW-60'],
    async run(x) {
      const cycle = await restartActive(x, 'mariadb')
      const tuned = cycle.restarted ? await x.until(() => x.root.get('/api/server/databases/tuning'), read => read.status === 200 && read.data?.state === 'read', { attempts: 15, delayMs: 2000 }) : null
      const uptime = tuned?.last?.data?.status?.Uptime
      x.check('ROOT-CLIENT-CONNECTS', cameBack(cycle) && tuned?.settled === true, { ...seen(cycle), attempts: tuned?.attempts ?? 0 })
      x.check('UPTIME-BELOW-60', tuned?.settled === true && Number.isFinite(uptime) && uptime < 60, { uptimeSeconds: Number.isFinite(uptime) ? uptime : null })
    },
  }),

  tool('restart-postgresql', {
    prefix: 'RPG', probe: SERVICES, paths: restartPaths(), unit: unitsOf('RPG'),
    checks: ['SERVICE-STATE-OBSERVED', 'RESTART-OR-REFUSAL-VERIFIED'],
    async run(x) {
      const rows = await x.root.get(SERVICES), row = rowOf(rows, 'postgresql')
      x.check('SERVICE-STATE-OBSERVED', rows.status === 200 && ['active', 'inactive', 'not-installed'].includes(row?.state), { status: rows.status, state: row?.state ?? null })
      if (rows.status !== 200) return x.check('RESTART-OR-REFUSAL-VERIFIED', false, { status: rows.status })
      if (row?.state === 'active') {
        const cycle = await restartActive(x, 'postgresql')
        x.check('RESTART-OR-REFUSAL-VERIFIED', cameBack(cycle), seen(cycle))
      } else if (row?.state === 'not-installed') {
        x.refused('RESTART-OR-REFUSAL-VERIFIED', await x.root.post(`${SERVICES}/postgresql/restart`, {}), 'PRECONDITION_FAILED')
      } else {
        x.refused('RESTART-OR-REFUSAL-VERIFIED', await x.root.post(`${SERVICES}/postgresql-99/restart`, {}), 'NOT_FOUND')
      }
    },
  }),

  tool('restart-php-fpm', {
    prefix: 'RFPM', probe: SERVICES, paths: restartPaths(), requests: 45,
    unit: [...unitsOf('RFPM'), { id: 'RFPM-UNIT-PHP-VERSION', file: 'apps/agent/src/phase2-host.test.ts', name: 'host services restarts exactly one version of account masters after each passes its own test, and never the distro master' }],
    checks: ['EVERY-VERSION-RESTARTED', 'RESULT-LISTS-EVERY-VERSION-OK', 'UNKNOWN-VERSION-REFUSED'],
    async run(x) {
      const rows = await x.root.get(SERVICES)
      const versions = (Array.isArray(rows.data?.services) ? rows.data.services : []).filter(item => item.fpm && item.fpm.masters > 0 && item.state === 'active')
      if (rows.status !== 200 || versions.length === 0) {
        x.check('EVERY-VERSION-RESTARTED', false, { status: rows.status, versions: 0 })
        x.check('RESULT-LISTS-EVERY-VERSION-OK', false, { status: rows.status, versions: 0 })
      } else {
        x.undo('php-fpm active', async () => { const now = await x.root.get(SERVICES); return versions.every(item => rowOf(now, item.id)?.state === 'active') })
        const results = []
        for (const item of versions) results.push({ id: item.id, response: await x.root.post(`${SERVICES}/${item.id}/restart`, {}) })
        const settled = await x.until(() => x.root.get(SERVICES), read => versions.every(item => rowOf(read, item.id)?.state === 'active'), { attempts: 10, delayMs: 1500 })
        x.check('EVERY-VERSION-RESTARTED', results.every(item => item.response.status === 200 && item.response.data?.service?.state === 'active') && settled.settled, { versions: versions.length, restarted: results.filter(item => item.response.status === 200).length })
        // Like cPanel the product keeps one row per PHP version and restarts them one at a time; no aggregate restart
        // exists, so the result is the service list read after the restarts.
        x.check('RESULT-LISTS-EVERY-VERSION-OK', settled.last?.status === 200 && versions.every(item => rowOf(settled.last, item.id)?.state === 'active'), { status: settled.last?.status ?? null, versions: versions.length })
      }
      x.refused('UNKNOWN-VERSION-REFUSED', await x.root.post(`${SERVICES}/php-fpm-59/restart`, {}), 'NOT_FOUND')
    },
  }),

  tool('apache-global-config', {
    prefix: 'APCFG', restores: ['/api/server/settings'], probe: SETTINGS, paths: /^\/api\/(?:server\/(?:settings|services)|generations)$/, requests: 25,
    unit: [{ id: 'APCFG-UNIT-LIMITS', file: 'packages/core/src/rules/workers.test.ts', name: 'validateApacheWorkers rejects unknown keys, missing keys and non-objects' }],
    checks: ['WORKERS-OVER-LIMIT-REFUSED', 'WEB-TIMEOUT-SAVED-REGENERATES', 'SERVICES-ACTIVE-AFTER-RELOAD'],
    async run(x) {
      const guard = await guardSettings(x)
      if (!guard) return
      const { original } = guard
      x.refused('WORKERS-OVER-LIMIT-REFUSED', await guard.write({ ...original, apache: { ...original.apache, maxRequestWorkers: 300, serverLimit: 256 } }), 'VALIDATION')
      const generation = async () => { const read = await x.root.get('/api/generations'); return { read, id: read.data?.currentGeneration?.id ?? null } }
      const before = await generation()
      const web = original.web ?? DEFAULT_WEB
      const nextTimeout = web.timeoutSec === 65 ? 70 : 65
      const saved = await guard.write({ ...original, web: { ...web, timeoutSec: nextTimeout } })
      const after = await generation()
      x.check('WEB-TIMEOUT-SAVED-REGENERATES', saved.status === 200 && saved.data?.reconcile?.status === 'applied' && before.id !== null && after.id !== null && after.id !== before.id,
        { status: saved.status, reconcile: saved.data?.reconcile?.status ?? null, generationChanged: before.id !== after.id })
      const services = await x.root.get(SERVICES)
      x.check('SERVICES-ACTIVE-AFTER-RELOAD', saved.status === 200 && services.status === 200 && rowOf(services, 'apache')?.state === 'active' && rowOf(services, 'nginx')?.state === 'active',
        { saveStatus: saved.status, status: services.status, apache: rowOf(services, 'apache')?.state ?? null, nginx: rowOf(services, 'nginx')?.state ?? null })
    },
  }),

  tool('system-reboot', {
    prefix: 'REBOOT', probe: MANAGER, paths: /^\/api\/(?:server\/service-manager(?:\/action)?|resellers(?:\/[0-9a-f-]{36})?)$/, requests: 15,
    unit: [{ id: 'REBOOT-UNIT-GRAMMAR', file: 'apps/api/src/service-manager-workspace.test.ts', name: 'service manager API routes refuses unknown fields and selectors without forwarding' }],
    checks: ['RESELLER-FORBIDDEN', 'FORCEFUL-REBOOT-NEEDS-CONFIRMATION'],
    async run(x) {
      const view = await x.root.get(MANAGER)
      const expectedRevision = typeof view.data?.revision === 'string' ? view.data.revision : '0'.repeat(64)
      // The body never carries the confirmation phrase, so no request here can start a reboot.
      const body = { action: 'reboot', expectedRevision }
      const username = `xq${x.tag}z`, password = SECRET()
      const made = await x.root.post('/api/resellers', { username, password, acl: ['list-accounts'], maxAccounts: 'unlimited', totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited', oversell: { disk: true, bandwidth: true }, nameservers: ['ns1.example.net', 'ns2.example.net'], delegatedIps: [] })
      const id = made.data?.reseller?.id
      if (made.status === 201 && typeof id === 'string') x.undo('reseller', async () => [200, 404].includes((await x.root.delete(`/api/resellers/${id}`)).status))
      const session = typeof id === 'string' ? await x.signIn('reseller', { username, password }) : { client: null, response: made }
      if (session.client) x.refused('RESELLER-FORBIDDEN', await session.client.post(`${MANAGER}/action`, body), 'FORBIDDEN')
      else x.check('RESELLER-FORBIDDEN', false, safeResponse(session.response))
      x.refused('FORCEFUL-REBOOT-NEEDS-CONFIRMATION', await x.root.post(`${MANAGER}/action`, body), 'VALIDATION')
    },
  }),

  tool('server-repair', {
    prefix: 'SRPR', probe: '/api/server/repair/diagnostics', paths: /^\/api\/server\/repair\/(?:diagnostics|preview|run)$/, requests: 8,
    unit: [{ id: 'SRPR-UNIT-DIAGNOSTICS', file: 'apps/agent/src/repair-center.test.ts', name: 'repair diagnostics report reports Debian package, service configuration and drift diagnostics truthfully' }],
    checks: ['HEALTHY-SCAN-NO-PACKAGE-PROBLEMS', 'SERVICES-AND-DRIFT-OBSERVED', 'HEALTHY-REPAIR-REFUSED', 'INVALID-REPAIR-REFUSED'],
    async run(x) {
      const scan = await x.root.get('/api/server/repair/diagnostics')
      const diagnostics = Array.isArray(scan.data?.diagnostics) ? scan.data.diagnostics : []
      const packages = diagnostics.filter(item => item.area === 'packages')
      x.check('HEALTHY-SCAN-NO-PACKAGE-PROBLEMS', scan.status === 200 && packages.length > 0 && packages.every(item => item.state === 'ok'), { status: scan.status, packageChecks: packages.length, notOk: packages.filter(item => item.state !== 'ok').map(item => item.id) })
      const otherAreas = diagnostics.filter(item => item.area !== 'packages')
      x.check('SERVICES-AND-DRIFT-OBSERVED', scan.status === 200 && typeof scan.data?.revision === 'string' && otherAreas.length > 0 && otherAreas.every(item => ['ok', 'problem', 'unavailable'].includes(item.state)),
        { status: scan.status, otherChecks: otherAreas.length })
      const repairId = scan.data?.family === 'rhel' ? 'dnf-cache-refresh' : 'dpkg-configure'
      const expectedRevision = typeof scan.data?.revision === 'string' ? scan.data.revision : '0'.repeat(64)
      x.refused('HEALTHY-REPAIR-REFUSED', await x.root.post('/api/server/repair/preview', { repairId, expectedRevision }), 'PRECONDITION_FAILED')
      x.refused('INVALID-REPAIR-REFUSED', await x.root.post('/api/server/repair/run', { repairId: 'invalid-repair', expectedRevision: 'bad' }), 'VALIDATION')
    },
  }),

  tool('account-health', {
    prefix: 'ACCH', needs: ['account'], probe: '/api/accounts/health', paths: /^\/api\/accounts\/health\?username=xq(?:[0-9a-f]{8}|nobody99)$/, requests: 6,
    page: { route: '/whm/accounts/health', read: '/api/accounts/health', shows: data => [data?.accounts?.[0]?.username] },
    unit: [{ id: 'ACCH-UNIT-CERTIFICATES', file: 'apps/agent/src/account-health.test.ts', name: 'account health checks reports per-domain certificate, zone and PHP problems with the worst first' }],
    checks: ['SSL-CHECK-NAMES-DOMAIN', 'ALL-CHECKS-GRADED', 'UNKNOWN-ACCOUNT-NOT-FOUND'],
    async run(x) {
      const health = await x.root.get(`/api/accounts/health?username=${x.fixture.username}`)
      const checks = Array.isArray(health.data?.accounts?.[0]?.checks) ? health.data.accounts[0].checks : []
      const certificates = checks.find(item => item.id === 'certificates')
      const item = Array.isArray(certificates?.items) ? certificates.items.find(entry => entry.name === x.fixture.domain) : undefined
      x.check('SSL-CHECK-NAMES-DOMAIN', health.status === 200 && typeof item?.evidence === 'string' && item.evidence.length > 0, { status: health.status, domainListed: item !== undefined, state: item?.state ?? null })
      x.check('ALL-CHECKS-GRADED', health.status === 200 && health.data?.host === 'read' && checks.length >= 2 && checks.every(entry => ['ok', 'warning', 'critical', 'unavailable'].includes(entry.state)),
        { status: health.status, host: health.data?.host ?? null, checks: checks.length })
      x.refused('UNKNOWN-ACCOUNT-NOT-FOUND', await x.root.get('/api/accounts/health?username=xqnobody99'), 'NOT_FOUND')
    },
  }),

  tool('process-manager', {
    prefix: 'PROC', needs: ['account'], probe: '/api/server/monitoring/processes', paths: /^\/api\/server\/monitoring\/processes(?:\/signal|\/kill-user)?$/,
    unit: [
      { id: 'PROC-UNIT-SIGNAL', file: 'apps/api/src/monitoring-workspace.test.ts', name: 'monitoring workspace API signals with a fresh root re-check, canonical body and audited outcome' },
      { id: 'PROC-UNIT-SWEEP', file: 'apps/agent/src/host-monitoring.test.ts', name: 'kill all for one user sends KILL to everything of the account and again to what stays, confirming only when nothing remains' },
    ],
    checks: ['KILL-ALL-FOR-USER', 'PROTECTED-USER-REFUSED', 'SYSTEM-USER-REFUSED'],
    async run(x) {
      const user = x.fixture.username
      const sweep = await x.root.post('/api/server/monitoring/processes/kill-user', { username: user, killConfirmed: true })
      const owned = await x.root.get('/api/server/monitoring/processes')
      x.check('KILL-ALL-FOR-USER', sweep.status === 200 && sweep.data?.state === 'confirmed' && owned.status === 200 && Array.isArray(owned.data?.items) && !owned.data.items.some(item => item.user === user), { ...safeResponse(sweep), signalled: sweep.data?.signalled ?? null, exempt: sweep.data?.exempt ?? null })
      x.refused('SYSTEM-USER-REFUSED', await x.root.post('/api/server/monitoring/processes/kill-user', { username: 'root', killConfirmed: true }), 'FORBIDDEN')
      // A kernel thread ignores signals, so a product that fails to protect it still changes nothing on the host.
      const target = (Array.isArray(owned.data?.items) ? owned.data.items : []).find(item => item.protection === 'kernel' && item.uid === 0 && item.pid >= 2)
      if (target) x.refused('PROTECTED-USER-REFUSED', await x.root.post('/api/server/monitoring/processes/signal', { pid: target.pid, uid: target.uid, comm: target.comm, startedAt: target.startedAt, signal: 'TERM' }), 'FORBIDDEN')
      else x.check('PROTECTED-USER-REFUSED', false, { status: owned.status, protectedRows: 0 })
    },
  }),

  tool('notification-center', {
    prefix: 'NCTR', restores: ['/api/server/panel/notifications'], probe: NOTIFICATIONS, page: notificationsPage, paths: /^\/api\/server\/panel\/notifications(?:\/(?:reset|test))?$/, requests: 16,
    unit: [{ id: 'NCTR-UNIT-STRICT', file: 'apps/api/src/panel-notifications.test.ts', name: 'notification settings grammar validates recipients, events, the webhook and the revision strictly' }],
    checks: ['HIGH-ONLY-EMAIL-FILTER', 'TEST-DISPATCH-RECORDED'],
    async run(x) {
      const guard = await guardNotifications(x)
      if (!guard) return x.check('HIGH-ONLY-EMAIL-FILTER', false, { status: 0 })
      const saved = await x.root.put(NOTIFICATIONS, {
        recipients: ['ops@example.net'],
        events: ['monitoring.alert'],
        webhook: null,
        emailMinimumSeverity: 'high',
        expectedRevision: guard.read.data.revision,
      })
      x.check('HIGH-ONLY-EMAIL-FILTER', saved.status === 200 && saved.data?.settings?.emailMinimumSeverity === 'high', { readStatus: guard.read.status, ...safeResponse(saved) })
      const tested = saved.status === 200 ? await x.root.post(`${NOTIFICATIONS}/test`, '') : null
      const emailResult = Array.isArray(tested?.data?.test?.results) ? tested.data.test.results.find(item => item.channel === 'email') : null
      x.check('TEST-DISPATCH-RECORDED', tested?.status === 200 && emailResult !== null && emailResult !== undefined, { status: tested?.status ?? null, results: tested?.data?.test?.results?.length ?? 0 })
    },
  }),

  tool('notification-channels', {
    prefix: 'NCHN', restores: ['/api/server/panel/notifications'], probe: NOTIFICATIONS, page: notificationsPage, paths: /^\/api\/server\/panel\/notifications(?:\/(?:reset|test))?$/, requests: 18,
    unit: [{ id: 'NCHN-UNIT-SAVE', file: 'apps/api/src/panel-notifications.test.ts', name: 'notification settings workspace saves under the observed revision, re-reads and audits without the webhook path' }],
    checks: ['TELEGRAM-TEST-PROVIDER-ERROR', 'TOKEN-NEVER-RETURNED'],
    async run(x) {
      const guard = await guardNotifications(x)
      if (!guard) return x.check('TELEGRAM-TEST-PROVIDER-ERROR', false, { status: 0 })
      const probeToken = 'xq-invalid-bot-token'
      const saved = await x.root.put(NOTIFICATIONS, {
        recipients: [],
        events: ['monitoring.alert'],
        webhook: null,
        telegram: { botToken: probeToken, chatId: '10001', enabled: true },
        expectedRevision: guard.read.data.revision,
      })
      const tested = saved.status === 200 ? await x.root.post(`${NOTIFICATIONS}/test`, '') : null
      const tgResult = Array.isArray(tested?.data?.test?.results) ? tested.data.test.results.find(item => item.channel === 'telegram') : null
      x.check('TELEGRAM-TEST-PROVIDER-ERROR', saved.status === 200 && tested?.status === 200 && typeof tgResult?.error === 'string',
        { saveStatus: saved.status, testStatus: tested?.status ?? null, providerError: tgResult?.error ?? null })
      const reread = saved.status === 200 ? await x.root.get(NOTIFICATIONS) : null
      const tg = reread?.data?.settings?.telegram
      x.check('TOKEN-NEVER-RETURNED', reread?.status === 200 && tg?.tokenSet === true && tg?.botToken === undefined && !JSON.stringify(reread.data).includes(probeToken),
        { status: reread?.status ?? null, tokenSet: tg?.tokenSet ?? null, hasBotTokenField: tg !== undefined && tg !== null && Object.hasOwn(tg, 'botToken') })
    },
  }),

  tool('server-health', {
    prefix: 'SHLT', probe: '/api/server/server-health', paths: /^\/api\/server\/server-health(?:\?area=disk)?$/, requests: 6,
    unit: [{ id: 'SHLT-UNIT-REPORT', file: 'apps/api/src/server-health-workspace.test.ts', name: 'API server health workspace authorizes root before and after the agent read and returns the projected report' }],
    checks: ['DISK-CHECK-READ', 'SELECTOR-REFUSED', 'DISK-OK-BELOW-80'], hostOnly: ['DISK-OK-BELOW-80'],
    async run(x) {
      const report = await x.root.get('/api/server/server-health'), disk = report.data?.checks?.find(item => item.id === 'disk-space')
      x.check('DISK-CHECK-READ', report.status === 200 && typeof disk?.state === 'string', { status: report.status, state: disk?.state ?? null })
      x.refused('SELECTOR-REFUSED', await x.root.get('/api/server/server-health?area=disk'), 'VALIDATION')
      if (!x.host) return
      const home = x.host.disk('/home'), percent = home.usedBytes / (home.usedBytes + home.availableBytes) * 100, band = { percent: Math.round(percent) }
      x.check('DISK-OK-BELOW-80', report.status === 200 && percent < 80 && disk?.state === 'ok', { ...band, state: disk?.state ?? null })
    },
  }),

  tool('current-disk-usage', {
    prefix: 'CDU', probe: '/api/server/monitoring/disk', paths: /^\/api\/server\/monitoring\/disk$/,
    unit: [{ id: 'CDU-UNIT-DISK', file: 'apps/api/src/monitoring-workspace.test.ts', name: 'monitoring workspace API forwards canonical reads and projects only reviewed fields' }],
    checks: ['MOUNTS-READ', 'MATCHES-STATVFS-WITHIN-1PCT'], hostOnly: ['MATCHES-STATVFS-WITHIN-1PCT'],
    async run(x) {
      const read = await x.root.get('/api/server/monitoring/disk'), items = read.data?.filesystems?.items ?? []
      x.check('MOUNTS-READ', read.status === 200 && items.length > 0, { status: read.status, mounts: items.length })
      if (!x.host) return
      const worst = items.reduce((highest, item) => {
        const kernel = x.host.disk(item.mount), span = Math.max(1, kernel.totalBytes)
        return Math.max(highest, Math.abs(item.usedBytes - kernel.usedBytes) / span, Math.abs(item.availableBytes - kernel.availableBytes) / span)
      }, 0)
      x.check('MATCHES-STATVFS-WITHIN-1PCT', read.status === 200 && items.length > 0 && worst <= 0.01, { mounts: items.length, worstPercent: Math.round(worst * 10000) / 100 })
    },
  }),
]
