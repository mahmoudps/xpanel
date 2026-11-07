import { randomBytes } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const SERVICES = '/api/server/services'
const MANAGER = '/api/server/service-manager'
const NOTIFICATIONS = '/api/server/panel/notifications'
const SETTINGS = '/api/server/settings'
const rowOf = (response, id) => (Array.isArray(response?.data?.services) ? response.data.services.find(item => item.id === id) : undefined)
const canon = value => JSON.stringify(value, (_, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item))
const servicesPage = { route: '/whm/services', read: SERVICES, shows: data => [data?.services?.[0]?.label] }
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

/** A disabled instance exists only on some hosts; a client cannot create one, so the clause is blocked elsewhere. */
async function disabledRefusal(x, id, checkId, row) {
  if (row?.state === 'inactive' && row.unit) {
    const manager = await x.root.get(MANAGER)
    const unit = Array.isArray(manager.data?.units) ? manager.data.units.find(item => item.unit === row.unit) : undefined
    if (unit?.boot === 'disabled') return x.refused(checkId, await x.root.post(`${SERVICES}/${id}/restart`, {}), 'PRECONDITION_FAILED')
  }
  return x.block(checkId, 'No disabled instance of this service exists on the host, and a client cannot disable one without changing its boot configuration.')
}

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

// A product that accepted the extra field would have saved it, so the undo restores the read settings.
async function notificationExtra({ root, undo }, extra) {
  const read = await root.get(NOTIFICATIONS), saved = read.data?.settings ?? null
  if (read.status !== 200 || typeof read.data?.revision !== 'string') return { read, response: null }
  const body = { recipients: saved?.recipients ?? [], events: saved?.events ?? [], webhook: saved?.webhook ?? null }
  undo('notification settings', async () => {
    const now = await root.get(NOTIFICATIONS)
    if (canon(now.data?.settings ?? null) === canon(saved)) return true
    if (saved === null) return false
    const back = await root.put(NOTIFICATIONS, { ...body, expectedRevision: now.data?.revision })
    return back.status === 200 && canon((await root.get(NOTIFICATIONS)).data?.settings) === canon(saved)
  })
  return { read, response: await root.put(NOTIFICATIONS, { ...body, ...extra, expectedRevision: read.data.revision }) }
}

const SECRET = () => `Xq-${randomBytes(18).toString('base64url')}-9a`

export default [
  tool('restart-dns', {
    prefix: 'RDNS', probe: SERVICES, paths: restartPaths(), page: servicesPage, unit: unitsOf('RDNS'),
    checks: ['RESTART-SUCCESS', 'NEW-PID', 'DISABLED-SERVICE-REFUSED'],
    async run(x) {
      const cycle = await restartActive(x, 'pdns')
      x.check('RESTART-SUCCESS', cameBack(cycle), seen(cycle))
      x.block('NEW-PID', 'Neither the restart reply nor the service read carries a process ID, so a client cannot compare daemon PIDs.')
      await disabledRefusal(x, 'pdns', 'DISABLED-SERVICE-REFUSED', cycle.row)
    },
  }),

  tool('restart-ftp', {
    prefix: 'RFTP', probe: SERVICES, paths: restartPaths(), page: servicesPage, unit: unitsOf('RFTP'),
    checks: ['DISABLED-SERVICE-REFUSED', 'PORT-21-ACCEPTS', 'SERVICE-ACTIVE-AFTER-RESTART'],
    async run(x) {
      const cycle = await restartActive(x, 'pure-ftpd')
      await disabledRefusal(x, 'pure-ftpd', 'DISABLED-SERVICE-REFUSED', cycle.row)
      x.block('PORT-21-ACCEPTS', 'The API client has no route to the FTP control port; a connection to port 21 is only visible to a TCP client.')
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
      if (!cycle.restarted || queued.status !== 200 || kept(queued).length > 0) {
        x.check('QUEUE-PRESERVED', cameBack(cycle) && queued.status === 200 && after.status === 200 && kept(queued).every(id => kept(after).includes(id)), { ...seen(cycle), queued: kept(queued).length, remaining: kept(after).length })
      } else x.block('QUEUE-PRESERVED', 'The mail queue holds no deferred or held message to follow across a restart, and a client cannot queue one without sending real mail.')
      x.block('PORT-25-220-BANNER', 'The API client has no route to the SMTP port; the 220 banner is only visible to a TCP client.')
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
    checks: ['NOT-INSTALLED-REFUSED'],
    async run(x) {
      const rows = await x.root.get(SERVICES), row = rowOf(rows, 'postgresql')
      if (rows.status === 200 && row?.state === 'not-installed') x.refused('NOT-INSTALLED-REFUSED', await x.root.post(`${SERVICES}/postgresql/restart`, {}), 'PRECONDITION_FAILED')
      else x.block('NOT-INSTALLED-REFUSED', 'PostgreSQL is installed on this host, and a client cannot remove it to reach the refusal.')
    },
  }),

  tool('restart-php-fpm', {
    prefix: 'RFPM', probe: SERVICES, paths: restartPaths(), requests: 45,
    unit: [...unitsOf('RFPM'), { id: 'RFPM-UNIT-PHP-VERSION', file: 'apps/agent/src/phase2-host.test.ts', name: 'host services restarts exactly one version of account masters after each passes its own test, and never the distro master' }],
    checks: ['EVERY-VERSION-RESTARTED', 'RESULT-LISTS-EVERY-VERSION-OK', 'FASTCGI-SOCKETS-ACCEPT'],
    async run(x) {
      const rows = await x.root.get(SERVICES)
      const versions = (Array.isArray(rows.data?.services) ? rows.data.services : []).filter(item => item.fpm && item.fpm.masters > 0 && item.state === 'active')
      if (versions.length === 0) {
        x.check('EVERY-VERSION-RESTARTED', false, { status: rows.status, versions: 0 })
      } else {
        x.undo('php-fpm active', async () => { const now = await x.root.get(SERVICES); return versions.every(item => rowOf(now, item.id)?.state === 'active') })
        const results = []
        for (const item of versions) results.push({ id: item.id, response: await x.root.post(`${SERVICES}/${item.id}/restart`, {}) })
        const settled = await x.until(() => x.root.get(SERVICES), read => versions.every(item => rowOf(read, item.id)?.state === 'active'), { attempts: 10, delayMs: 1500 })
        x.check('EVERY-VERSION-RESTARTED', results.every(item => item.response.status === 200 && item.response.data?.service?.state === 'active') && settled.settled, { versions: versions.length, restarted: results.filter(item => item.response.status === 200).length })
      }
      const all = await x.root.post(`${SERVICES}/php-fpm/restart`, {})
      const listed = all.data?.versions ?? all.data?.services
      x.check('RESULT-LISTS-EVERY-VERSION-OK', all.status === 200 && versions.length > 0 && Array.isArray(listed) && versions.every(item => listed.some(entry => entry.id === item.id && ['ok', 'active'].includes(entry.status ?? entry.state))), safeResponse(all))
      x.block('FASTCGI-SOCKETS-ACCEPT', 'The API client cannot open a FastCGI connection to a pool socket; the sockets are local to the host.')
    },
  }),

  tool('apache-global-config', {
    prefix: 'APCFG', restores: ['/api/server/settings'], probe: SETTINGS, paths: /^\/api\/(?:server\/settings|generations)$/, requests: 20,
    unit: [{ id: 'APCFG-UNIT-LIMITS', file: 'packages/core/src/rules/workers.test.ts', name: 'validateApacheWorkers rejects unknown keys, missing keys and non-objects' }],
    checks: ['WORKERS-OVER-LIMIT-REFUSED', 'KEEPALIVE-SAVED-REGENERATES', 'GRACEFUL-RESTART'],
    async run(x) {
      const guard = await guardSettings(x)
      if (!guard) return
      const { original } = guard
      x.refused('WORKERS-OVER-LIMIT-REFUSED', await guard.write({ ...original, apache: { ...original.apache, maxRequestWorkers: 300, serverLimit: 256 } }), 'VALIDATION')
      const generation = async () => { const read = await x.root.get('/api/generations'); return { read, id: read.data?.currentGeneration?.id ?? null } }
      const before = await generation()
      const saved = await guard.write({ ...original, apache: { ...original.apache, keepAlive: 'On' } })
      const after = await generation()
      x.check('KEEPALIVE-SAVED-REGENERATES', saved.status === 200 && saved.data?.reconcile?.status === 'applied' && before.id !== null && after.id !== null && after.id !== before.id, { status: saved.status, reconcile: saved.data?.reconcile?.status ?? null, generationChanged: before.id !== after.id })
      x.block('GRACEFUL-RESTART', 'A graceful restart is indistinguishable from a hard one through the API; only the applied generation is visible.')
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
    prefix: 'SRPR', probe: '/api/server/repair/diagnostics', paths: /^\/api\/server\/repair\/diagnostics$/,
    unit: [{ id: 'SRPR-UNIT-DIAGNOSTICS', file: 'apps/agent/src/repair-center.test.ts', name: 'repair diagnostics report reports Debian package, service configuration and drift diagnostics truthfully' }],
    checks: ['HEALTHY-SCAN-NO-PACKAGE-PROBLEMS', 'INTERRUPTED-SCAN-REPORTED', 'FIX-RUNS-DPKG-CONFIGURE-JOB', 'FOLLOW-UP-CHECK-PASSES'],
    async run(x) {
      const scan = await x.root.get('/api/server/repair/diagnostics')
      const packages = (Array.isArray(scan.data?.diagnostics) ? scan.data.diagnostics : []).filter(item => item.area === 'packages')
      x.check('HEALTHY-SCAN-NO-PACKAGE-PROBLEMS', scan.status === 200 && packages.length > 0 && packages.every(item => item.state === 'ok'), { status: scan.status, packageChecks: packages.length, notOk: packages.filter(item => item.state !== 'ok').map(item => item.id) })
      const why = 'A client cannot interrupt the package manager on a qualification host, and the fix is only offered for an interrupted run.'
      x.block('INTERRUPTED-SCAN-REPORTED', why)
      x.block('FIX-RUNS-DPKG-CONFIGURE-JOB', why)
      x.block('FOLLOW-UP-CHECK-PASSES', why)
    },
  }),

  tool('account-health', {
    prefix: 'ACCH', needs: ['account'], probe: '/api/accounts/health', paths: /^\/api\/accounts\/health\?username=xq[0-9a-f]{8}$/,
    page: { route: '/whm/accounts/health', read: '/api/accounts/health', shows: data => [data?.accounts?.[0]?.username] },
    unit: [{ id: 'ACCH-UNIT-CERTIFICATES', file: 'apps/agent/src/account-health.test.ts', name: 'account health checks reports per-domain certificate, zone and PHP problems with the worst first' }],
    checks: ['SSL-CHECK-NAMES-DOMAIN', 'EXPIRED-CERT-CRITICAL', 'VALID-CERT-CLEARS'],
    async run(x) {
      const health = await x.root.get(`/api/accounts/health?username=${x.fixture.username}`)
      const certificates = Array.isArray(health.data?.accounts?.[0]?.checks) ? health.data.accounts[0].checks.find(item => item.id === 'certificates') : undefined
      const item = Array.isArray(certificates?.items) ? certificates.items.find(entry => entry.name === x.fixture.domain) : undefined
      x.check('SSL-CHECK-NAMES-DOMAIN', health.status === 200 && typeof item?.evidence === 'string' && item.evidence.length > 0, { status: health.status, domainListed: item !== undefined, state: item?.state ?? null })
      const why = 'An expired certificate cannot be produced through the API, and the run fixture has no certificate whose expiry a client controls.'
      x.block('EXPIRED-CERT-CRITICAL', why)
      x.block('VALID-CERT-CLEARS', why)
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
    prefix: 'NCTR', probe: NOTIFICATIONS, paths: /^\/api\/server\/panel\/notifications$/,
    unit: [{ id: 'NCTR-UNIT-STRICT', file: 'apps/api/src/panel-notifications.test.ts', name: 'notification settings grammar validates recipients, events, the webhook and the revision strictly' }],
    checks: ['HIGH-ONLY-EMAIL-FILTER', 'TEST-SENDS-TO-EVERY-URL'],
    async run(x) {
      const { read, response } = await notificationExtra(x, { emailMinimumSeverity: 'high' })
      x.check('HIGH-ONLY-EMAIL-FILTER', response !== null && response.status === 200, { readStatus: read.status, ...safeResponse(response) })
      x.block('TEST-SENDS-TO-EVERY-URL', 'The receiving side of a webhook is not reachable from an API client, so the hostname, subject and body it gets cannot be observed.')
    },
  }),

  tool('notification-channels', {
    prefix: 'NCHN', probe: NOTIFICATIONS, paths: /^\/api\/server\/panel\/notifications$/,
    unit: [{ id: 'NCHN-UNIT-SAVE', file: 'apps/api/src/panel-notifications.test.ts', name: 'notification settings workspace saves under the observed revision, re-reads and audits without the webhook path' }],
    checks: ['TELEGRAM-TEST-PROVIDER-ERROR', 'TOKEN-NEVER-RETURNED'],
    async run(x) {
      const { read, response } = await notificationExtra(x, { telegram: { botToken: 'xq-wrong-token', chatId: '0' } })
      x.check('TELEGRAM-TEST-PROVIDER-ERROR', response !== null && response.status === 200, { readStatus: read.status, ...safeResponse(response) })
      x.block('TOKEN-NEVER-RETURNED', 'No chat channel with a bot token can be saved, so there is no saved token whose absence from a later read could be observed.')
    },
  }),

  tool('server-health', {
    prefix: 'SHLT', probe: '/api/server/server-health', paths: /^\/api\/server\/server-health$/,
    unit: [{ id: 'SHLT-UNIT-REPORT', file: 'apps/api/src/server-health-workspace.test.ts', name: 'API server health workspace authorizes root before and after the agent read and returns the projected report' }],
    checks: ['DISK-CHECK-READ', 'DISK-CRITICAL-OVER-95', 'DISK-OK-BELOW-80'], hostOnly: ['DISK-CRITICAL-OVER-95', 'DISK-OK-BELOW-80'],
    async run(x) {
      const report = await x.root.get('/api/server/server-health'), disk = report.data?.checks?.find(item => item.id === 'disk-space')
      x.check('DISK-CHECK-READ', report.status === 200 && typeof disk?.state === 'string', { status: report.status, state: disk?.state ?? null })
      if (!x.host) return
      const home = x.host.disk('/home'), percent = home.usedBytes / (home.usedBytes + home.availableBytes) * 100, band = { percent: Math.round(percent) }
      if (percent > 95) x.check('DISK-CRITICAL-OVER-95', disk?.state === 'critical' && disk.items?.some(item => /used=.*free|used=.*avail/i.test(item.evidence)) === true, { ...band, state: disk?.state ?? null })
      else x.block('DISK-CRITICAL-OVER-95', 'Needs a lab guest whose /home is its own volume above 95% used. No such guest exists yet.')
      if (percent < 80) x.check('DISK-OK-BELOW-80', disk?.state === 'ok', { ...band, state: disk?.state ?? null })
      else x.block('DISK-OK-BELOW-80', 'This host has /home at or above 80% used, so the passing band cannot be observed here.')
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
      x.check('MATCHES-STATVFS-WITHIN-1PCT', items.length > 0 && worst <= 0.01, { mounts: items.length, worstPercent: Math.round(worst * 10000) / 100 })
    },
  }),
]
