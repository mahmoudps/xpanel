import { tool } from './kit.mjs'

const STALE_REV = 'f'.repeat(64)
const ZERO_UUID = '00000000-0000-4000-8000-000000000009'
const ZERO_HOST_ID = '000000000000'
const isHex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const safeUser = value => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(value) ? value : 'xqacct'
const nextStale = rev => rev === STALE_REV ? 'e'.repeat(64) : STALE_REV

export default [
  tool('aapanel-performance-test', {
    prefix: 'S20T01',
    probe: '/api/server/monitoring/benchmark',
    paths: /^\/api\/server\/monitoring\/benchmark(?:\/jobs|\?unknown=1)?$/,
    unit: [{ id: 'S20T01-UNIT-1', file: 'apps/agent/src/benchmark.test.ts', name: 'benchmark host plan and route has bounded steps and fresh authority' }],
    checks: ['BENCHMARK-HISTORY-READ', 'QUERY-SELECTOR-REFUSED', 'UNCONFIRMED-RUN-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/monitoring/benchmark')
      check(
        'BENCHMARK-HISTORY-READ',
        read.status === 200
          && ['read', 'unavailable'].includes(read.data?.history?.state)
          && Array.isArray(read.data?.history?.results)
          && read.data?.limits?.cpuSeconds === 5
          && read.data?.limits?.diskBytes === 67108864
          && read.data?.network === 'not_measured',
        { status: read.status, historyState: read.data?.history?.state ?? null, results: read.data?.history?.results?.length ?? null },
      )
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/monitoring/benchmark?unknown=1'), 'VALIDATION')
      refused('UNCONFIRMED-RUN-REFUSED', await root.post('/api/server/monitoring/benchmark/jobs', { confirm: 'NO' }), 'VALIDATION')
    },
  }),

  tool('aapanel-linux-tools', {
    prefix: 'S20T02',
    probe: '/api/server/host-tools/timezone',
    paths: /^\/api\/server\/host-tools\/(?:timezone|swap|ram-disks|hosts-file)(?:\?unknown=1)?$/,
    unit: [
      { id: 'S20T02-UNIT-1', file: 'packages/core/src/host-tools.test.ts', name: 'other host tool rows validates hosts entries and RAM disks' },
      { id: 'S20T02-UNIT-2', file: 'apps/agent/src/host-tools-routes.test.ts', name: 'swap plan sizes the file, keeps it across reboots and proves the size' },
    ],
    checks: ['LINUX-TOOLS-READ', 'HOSTS-FILE-READ', 'INVALID-TIMEZONE-REFUSED', 'INVALID-HOSTS-ENTRY-REFUSED'],
    async run({ root, check, refused }) {
      const tz = await root.get('/api/server/host-tools/timezone')
      check(
        'LINUX-TOOLS-READ',
        tz.status === 200 && isHex64(tz.data?.revision) && typeof tz.data?.swapMb === 'number' && Array.isArray(tz.data?.rows),
        { status: tz.status, swapMb: tz.data?.swapMb ?? null, ramDisks: tz.data?.rows?.length ?? null },
      )
      const hosts = await root.get('/api/server/host-tools/hosts-file')
      check(
        'HOSTS-FILE-READ',
        hosts.status === 200 && isHex64(hosts.data?.revision) && Array.isArray(hosts.data?.rows),
        { status: hosts.status, rows: hosts.data?.rows?.length ?? null },
      )
      const rev = isHex64(tz.data?.revision) ? tz.data.revision : '0'.repeat(64)
      refused('INVALID-TIMEZONE-REFUSED', await root.put('/api/server/host-tools/timezone', { timezone: 'Invalid/Zone/Extra/Part', expectedRevision: rev }), 'VALIDATION')
      refused('INVALID-HOSTS-ENTRY-REFUSED', await root.post('/api/server/host-tools/hosts-file', { ip: 'not-an-ip', names: 'bad_host', expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-supervisor', {
    prefix: 'S20T03',
    probe: '/api/server/host-tools/daemons',
    paths: /^\/api\/server\/host-tools\/(?:daemons(?:\/000000000000)?|daemon-profile)$/,
    unit: [{ id: 'S20T03-UNIT-1', file: 'packages/core/src/host-tools.test.ts', name: 'other host tool rows admits daemons as root or an account with a shell-free command' }],
    checks: ['SUPERVISED-DAEMONS-READ', 'DAEMON-PROFILE-READ', 'INVALID-DAEMON-PROFILE-REFUSED', 'UNKNOWN-DAEMON-DELETE-NOT-FOUND'],
    async run({ root, check, refused }) {
      const daemons = await root.get('/api/server/host-tools/daemons')
      check(
        'SUPERVISED-DAEMONS-READ',
        daemons.status === 200 && isHex64(daemons.data?.revision) && Array.isArray(daemons.data?.rows) && typeof daemons.data?.profile === 'object' && daemons.data.profile !== null,
        { status: daemons.status, rows: daemons.data?.rows?.length ?? null },
      )
      const profile = await root.get('/api/server/host-tools/daemon-profile')
      check(
        'DAEMON-PROFILE-READ',
        profile.status === 200 && isHex64(profile.data?.revision) && typeof profile.data?.restartSec === 'number' && typeof profile.data?.burst === 'number',
        { status: profile.status, restartSec: profile.data?.restartSec ?? null, burst: profile.data?.burst ?? null },
      )
      const rev = isHex64(profile.data?.revision) ? profile.data.revision : '0'.repeat(64)
      refused('INVALID-DAEMON-PROFILE-REFUSED', await root.put('/api/server/host-tools/daemon-profile', { restartSec: 0, burst: 5, windowSec: 60, expectedRevision: rev }), 'VALIDATION')
      refused('UNKNOWN-DAEMON-DELETE-NOT-FOUND', await root.delete(`/api/server/host-tools/daemons/${ZERO_HOST_ID}`, { expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('aapanel-log-cleanup', {
    prefix: 'S20T04',
    probe: '/api/server/host-tools/log-cleanup',
    paths: /^\/api\/server\/host-tools\/log-cleanup(?:\?unknown=1)?$/,
    unit: [{ id: 'S20T04-UNIT-1', file: 'apps/agent/src/host-tools-routes.test.ts', name: 'log cleanup truncates site logs in place and lists their size' }],
    checks: ['LOG-CLEANUP-CATEGORIES-READ', 'EMPTY-CATEGORY-SELECTION-REFUSED', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/host-tools/log-cleanup')
      check(
        'LOG-CLEANUP-CATEGORIES-READ',
        read.status === 200 && Array.isArray(read.data?.rows) && read.data.rows.every(row => typeof row?.id === 'string' && typeof row?.bytes === 'number'),
        { status: read.status, categories: read.data?.rows?.length ?? null },
      )
      refused('EMPTY-CATEGORY-SELECTION-REFUSED', await root.post('/api/server/host-tools/log-cleanup', {}), 'VALIDATION')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/host-tools/log-cleanup?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-webhook', {
    prefix: 'S20T05',
    probe: '/api/server/host-tools/hooks',
    paths: /^\/api\/server\/host-tools\/hooks(?:\/000000000000|\?unknown=1)?$/,
    unit: [{ id: 'S20T05-UNIT-1', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API inbound hook answers 403 and runs nothing for a wrong key, and runs once for the right one' }],
    checks: ['INBOUND-HOOKS-READ', 'UNKNOWN-SCRIPT-HOOK-REFUSED', 'UNKNOWN-HOOK-DELETE-NOT-FOUND', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/host-tools/hooks')
      check(
        'INBOUND-HOOKS-READ',
        read.status === 200 && isHex64(read.data?.revision) && Array.isArray(read.data?.rows) && Array.isArray(read.data?.scripts),
        { status: read.status, hooks: read.data?.rows?.length ?? null, scripts: read.data?.scripts?.length ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused('UNKNOWN-SCRIPT-HOOK-REFUSED', await root.post('/api/server/host-tools/hooks', { name: 'BadHook', scriptId: ZERO_HOST_ID, expectedRevision: rev }), 'VALIDATION')
      refused('UNKNOWN-HOOK-DELETE-NOT-FOUND', await root.delete(`/api/server/host-tools/hooks/${ZERO_HOST_ID}`, { expectedRevision: rev }), 'NOT_FOUND')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/host-tools/hooks?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-php-guardian', {
    prefix: 'S20T06',
    probe: '/api/server/host-tools/php-guardian',
    paths: /^\/api\/server\/host-tools\/php-guardian(?:\?unknown=1)?$/,
    unit: [{ id: 'S20T06-UNIT-1', file: 'apps/agent/src/php-inventory.test.ts', name: 'PHP inventory read adapter admits only the exact fixed read commands, with no general PHP or package mutation allowance' }],
    checks: ['PHP-GUARDIAN-READ', 'OUT-OF-RANGE-INTERVAL-REFUSED', 'STALE-REVISION-CONFLICT', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/host-tools/php-guardian')
      check(
        'PHP-GUARDIAN-READ',
        read.status === 200 && isHex64(read.data?.revision) && typeof read.data?.enabled === 'boolean' && typeof read.data?.intervalSec === 'number' && typeof read.data?.timeoutSec === 'number',
        { status: read.status, enabled: read.data?.enabled ?? null, intervalSec: read.data?.intervalSec ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused('OUT-OF-RANGE-INTERVAL-REFUSED', await root.put('/api/server/host-tools/php-guardian', { enabled: false, intervalSec: 10, timeoutSec: 5, expectedRevision: rev }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/host-tools/php-guardian', { enabled: false, intervalSec: 300, timeoutSec: 5, expectedRevision: nextStale(rev) }), 'CONFLICT')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/host-tools/php-guardian?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-panel-general', {
    prefix: 'S20T07',
    probe: '/api/server/panel/settings',
    paths: /^\/api\/server\/panel\/settings(?:\?unknown=1)?$/,
    unit: [{ id: 'S20T07-UNIT-1', file: 'apps/api/src/panel-settings.test.ts', name: 'panel settings API reads defaults, saves revision-bound, reads back and audits without the message text' }],
    checks: ['PANEL-SETTINGS-READ', 'INVALID-ALLOWED-HOST-REFUSED', 'STALE-REVISION-CONFLICT', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/panel/settings')
      check(
        'PANEL-SETTINGS-READ',
        read.status === 200 && ['default', 'saved', 'invalid'].includes(read.data?.state) && isHex64(read.data?.revision)
          && (read.data?.state === 'invalid' || typeof read.data?.settings?.liveUpdates === 'boolean'),
        { status: read.status, state: read.data?.state ?? null, liveUpdates: read.data?.settings?.liveUpdates ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused(
        'INVALID-ALLOWED-HOST-REFUSED',
        await root.put('/api/server/panel/settings', { offlineMode: false, offlineMessage: '', developerMode: false, liveUpdates: true, reverseProxyAllowedHosts: ['bad host!'], expectedRevision: rev }),
        'VALIDATION',
      )
      refused(
        'STALE-REVISION-CONFLICT',
        await root.put('/api/server/panel/settings', { offlineMode: false, offlineMessage: '', developerMode: false, liveUpdates: true, reverseProxyAllowedHosts: [], expectedRevision: nextStale(rev) }),
        'CONFLICT',
      )
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/panel/settings?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-panel-backup-restore', {
    prefix: 'S20T08',
    probe: '/api/server/panel-backups',
    paths: /^\/api\/server\/panel-backups(?:\/xpanel-control-20990101T000000Z\.tar\.gz|\?unknown=1)?$/,
    unit: [{ id: 'S20T08-UNIT-1', file: 'packages/lifecycle/src/backup/restore.test.ts', name: 'restorePlan restoring databases does not touch the home' }],
    checks: ['PANEL-BACKUPS-LIST-READ', 'MISSING-SNAPSHOT-DOWNLOAD-NOT-FOUND', 'INVALID-OPERATION-REFUSED', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/panel-backups')
      check(
        'PANEL-BACKUPS-LIST-READ',
        read.status === 200 && typeof read.data?.folder === 'string' && typeof read.data?.canBuild === 'boolean' && Array.isArray(read.data?.backups),
        { status: read.status, canBuild: read.data?.canBuild ?? null, count: read.data?.backups?.length ?? null },
      )
      refused('MISSING-SNAPSHOT-DOWNLOAD-NOT-FOUND', await root.get('/api/server/panel-backups/xpanel-control-20990101T000000Z.tar.gz'), 'NOT_FOUND')
      refused('INVALID-OPERATION-REFUSED', await root.post('/api/server/panel-backups', { op: 'unknown' }), 'VALIDATION')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/panel-backups?unknown=1'), 'VALIDATION')
    },
  }),

  tool('resource-limits-manager', {
    prefix: 'S20T09',
    needs: ['account'],
    probe: '/api/server/server-limits',
    paths: /^\/api\/server\/server-limits(?:\?(?:username=[a-z0-9]{1,16}|unknown=1))?$/,
    unit: [{ id: 'S20T09-UNIT-1', file: 'apps/agent/src/server-health-limits.test.ts', name: 'server resource limits compares plan limits with kernel caps and flags usage at or above 90 percent' }],
    checks: ['RESOURCE-LIMITS-BATCH-READ', 'SCOPED-ACCOUNT-LIMITS-READ', 'UNKNOWN-ACCOUNT-NOT-FOUND', 'UNKNOWN-SELECTOR-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const read = await root.get('/api/server/server-limits')
      check(
        'RESOURCE-LIMITS-BATCH-READ',
        read.status === 200 && ['read', 'unavailable'].includes(read.data?.host) && Array.isArray(read.data?.accounts),
        { status: read.status, host: read.data?.host ?? null, accounts: read.data?.accounts?.length ?? null },
      )
      const username = safeUser(fixture?.username)
      const scoped = await root.get(`/api/server/server-limits?username=${username}`)
      check(
        'SCOPED-ACCOUNT-LIMITS-READ',
        scoped.status === 200 && Array.isArray(scoped.data?.accounts) && scoped.data.accounts.length === 1
          && scoped.data.accounts[0]?.username === username && Array.isArray(scoped.data.accounts[0]?.rows) && scoped.data.accounts[0].rows.length === 8,
        { status: scoped.status, username, rows: scoped.data?.accounts?.[0]?.rows?.length ?? null },
      )
      refused('UNKNOWN-ACCOUNT-NOT-FOUND', await root.get('/api/server/server-limits?username=missingacct999'), 'NOT_FOUND')
      refused('UNKNOWN-SELECTOR-REFUSED', await root.get('/api/server/server-limits?unknown=1'), 'VALIDATION')
    },
  }),

  tool('service-config-health', {
    prefix: 'S20T10',
    probe: '/api/server/configuration-health',
    paths: /^\/api\/server\/configuration-health(?:\/repair|\?unknown=1)?$/,
    unit: [{ id: 'S20T10-UNIT-1', file: 'apps/agent/src/configuration-health.test.ts', name: 'configuration health canonical observations binds metadata drift observations into exact target revisions' }],
    checks: ['CONFIG-HEALTH-MANIFEST-READ', 'INVALID-REPAIR-INTENT-REFUSED', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/configuration-health')
      check(
        'CONFIG-HEALTH-MANIFEST-READ',
        read.status === 200
          && ['read', 'unavailable'].includes(read.data?.state)
          && ['clean', 'drift', 'unavailable'].includes(read.data?.drift)
          && Array.isArray(read.data?.targets)
          && Array.isArray(read.data?.tests)
          && typeof read.data?.canRepair === 'boolean',
        { status: read.status, state: read.data?.state ?? null, drift: read.data?.drift ?? null, tests: read.data?.tests?.length ?? null },
      )
      refused('INVALID-REPAIR-INTENT-REFUSED', await root.post('/api/server/configuration-health/repair', {}), 'VALIDATION')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/configuration-health?unknown=1'), 'VALIDATION')
    },
  }),

  tool('outbound-spam-protection', {
    prefix: 'S20T11',
    probe: '/api/server/sec/outbound-spam',
    paths: /^\/api\/server\/(?:sec\/outbound-spam|mail\/outbound\/holds\/(?:release|delete))$/,
    unit: [{ id: 'S20T11-UNIT-1', file: 'apps/api/src/outbound-spam.test.ts', name: 'outbound limits holds a mailbox over its hourly limit once' }],
    checks: ['OUTBOUND-SPAM-POLICY-READ', 'INVALID-LIMIT-POLICY-REFUSED', 'UNHELD-SENDER-RELEASE-NOT-FOUND', 'MISSING-SENDER-KEY-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/sec/outbound-spam')
      check(
        'OUTBOUND-SPAM-POLICY-READ',
        read.status === 200 && ['default', 'saved', 'invalid'].includes(read.data?.state) && isHex64(read.data?.revision)
          && typeof read.data?.policy?.mailboxHourly === 'number' && Array.isArray(read.data?.policy?.rules),
        { status: read.status, state: read.data?.state ?? null, mailboxHourly: read.data?.policy?.mailboxHourly ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused(
        'INVALID-LIMIT-POLICY-REFUSED',
        await root.put('/api/server/sec/outbound-spam', {
          policy: { enabled: false, mailboxHourly: -1, mailboxDaily: 1000, accountHourly: 500, accountDaily: 5000, domainHourly: 0, domainDaily: 0, rules: [] },
          expectedRevision: rev,
        }),
        'VALIDATION',
      )
      refused('UNHELD-SENDER-RELEASE-NOT-FOUND', await root.post('/api/server/mail/outbound/holds/release', { key: 'unheld@invalid.example' }), 'NOT_FOUND')
      refused('MISSING-SENDER-KEY-REFUSED', await root.post('/api/server/mail/outbound/holds/delete', {}), 'VALIDATION')
    },
  }),

  tool('integrations-hub', {
    prefix: 'S20T12',
    probe: '/api/server/integrations',
    paths: /^\/api\/server\/integrations(?:\/test|\?unknown=1)?$/,
    unit: [{ id: 'S20T12-UNIT-1', file: 'apps/api/src/ops-integrations-workspace.test.ts', name: 'integrations API workspace saves endpoints, generates a per-endpoint secret and never returns it' }],
    checks: ['INTEGRATIONS-HUB-READ', 'UNKNOWN-WEBHOOK-TEST-NOT-FOUND', 'STALE-REVISION-CONFLICT', 'QUERY-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/integrations')
      check(
        'INTEGRATIONS-HUB-READ',
        read.status === 200 && isHex64(read.data?.savedRevision) && Array.isArray(read.data?.endpoints)
          && Array.isArray(read.data?.events) && Array.isArray(read.data?.deliveries) && read.data?.signatureScheme === 'hmac-sha256-t-v1',
        { status: read.status, endpoints: read.data?.endpoints?.length ?? null, events: read.data?.events?.length ?? null },
      )
      const rev = isHex64(read.data?.savedRevision) ? read.data.savedRevision : '0'.repeat(64)
      refused('UNKNOWN-WEBHOOK-TEST-NOT-FOUND', await root.post('/api/server/integrations/test', { id: 'whk_0000000000000000' }), 'NOT_FOUND')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/integrations', { config: { endpoints: [] }, expectedSavedRevision: nextStale(rev) }), 'CONFLICT')
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/integrations?unknown=1'), 'VALIDATION')
    },
  }),

  tool('whmcs-integration', {
    prefix: 'S20T13',
    probe: '/api/server/panel/whmcs',
    page: { route: '/whm/panel/whmcs', read: '/api/server/panel/whmcs', shows: () => ['WHMCS'] },
    paths: /^\/api\/server\/panel\/whmcs(?:\/(?:module|activity))?$/,
    unit: [{ id: 'S20T13-UNIT-1', file: 'apps/api/src/whmcs-integration.test.ts', name: 'WHMCS settings grammar refuses unsafe URLs, addresses, mappings and extra keys' }],
    checks: ['WHMCS-SETTINGS-READ', 'WHMCS-ACTIVITY-LOG-READ', 'WHMCS-MODULE-DOWNLOAD', 'UNSAFE-WHMCS-URL-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/panel/whmcs')
      check(
        'WHMCS-SETTINGS-READ',
        read.status === 200 && ['default', 'saved', 'invalid'].includes(read.data?.state) && isHex64(read.data?.revision) && Array.isArray(read.data?.plans),
        { status: read.status, state: read.data?.state ?? null, plans: read.data?.plans?.length ?? null },
      )
      const activity = await root.get('/api/server/panel/whmcs/activity')
      check('WHMCS-ACTIVITY-LOG-READ', activity.status === 200 && Array.isArray(activity.data?.entries), { status: activity.status, entries: activity.data?.entries?.length ?? null })
      const mod = await root.get('/api/server/panel/whmcs/module')
      check(
        'WHMCS-MODULE-DOWNLOAD',
        mod.status === 200 && typeof mod.text === 'string' && mod.text.includes('<?php'),
        { status: mod.status, hasPhpSource: typeof mod.text === 'string' && mod.text.includes('<?php') },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused(
        'UNSAFE-WHMCS-URL-REFUSED',
        await root.put('/api/server/panel/whmcs', {
          enabled: false, whmcsUrl: 'http://insecure.example.com', allowedAddresses: [], ssoTarget: 'xpanel', autoCreate: false, planMap: [], expectedRevision: rev,
        }),
        'VALIDATION',
      )
    },
  }),

  tool('alert-rules', {
    prefix: 'S20T14',
    probe: '/api/server/monitoring-alerts',
    paths: /^\/api\/server\/monitoring-alerts(?:\/evaluate|\?unknown=1)?$/,
    unit: [{ id: 'S20T14-UNIT-1', file: 'apps/api/src/monitoring-alerts.test.ts', name: 'monitoring alerts route saves rules under the observed revision, re-reads and audits; a stale revision is a 409 conflict' }],
    checks: ['ALERT-RULES-READ', 'EVALUATE-BODY-REFUSED', 'INVALID-QUIET-WINDOW-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/monitoring-alerts')
      const rules = Array.isArray(read.data?.rules) ? read.data.rules : []
      check(
        'ALERT-RULES-READ',
        read.status === 200 && isHex64(read.data?.revision) && rules.length === 10 && typeof read.data?.bounds === 'object' && read.data.bounds !== null,
        { status: read.status, rules: rules.length, evaluationState: read.data?.evaluationState ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused('EVALUATE-BODY-REFUSED', await root.post('/api/server/monitoring-alerts/evaluate', { unexpected: true }), 'VALIDATION')
      refused('INVALID-QUIET-WINDOW-REFUSED', await root.put('/api/server/monitoring-alerts', { rules, quiet: { start: '10:00', end: '10:00' }, expectedRevision: rev }), 'VALIDATION')
      const fallbackRules = rules.length === 10 ? rules : [
        { id: 'load', enabled: true, threshold: 1 },
        { id: 'memory', enabled: true, threshold: 15 },
        { id: 'swap', enabled: true, threshold: 50 },
        { id: 'disk-space', enabled: true, threshold: 85 },
        { id: 'disk-inodes', enabled: true, threshold: 85 },
        { id: 'services', enabled: true, threshold: null },
        { id: 'drift', enabled: true, threshold: null },
        { id: 'certificates', enabled: true, threshold: 14 },
        { id: 'reboot', enabled: true, threshold: null },
        { id: 'bandwidth', enabled: true, threshold: 80 },
      ]
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/monitoring-alerts', { rules: fallbackRules, quiet: null, expectedRevision: nextStale(rev) }), 'CONFLICT')
    },
  }),

  tool('service-watchdog', {
    prefix: 'S20T15',
    probe: '/api/server/host-tools/watchdog',
    paths: /^\/api\/server\/host-tools\/watchdog(?:\/(?:dovecot|unknown))?$/,
    unit: [
      { id: 'S20T15-UNIT-1', file: 'packages/core/src/host-tools.test.ts', name: 'other host tool rows names only known services in the watchdog' },
      { id: 'S20T15-UNIT-2', file: 'apps/api/src/host-tools-workspace.test.ts', name: 'scheduler and host tools API lists watched services and saves one' },
    ],
    checks: ['WATCHDOG-SERVICES-READ', 'UNKNOWN-WATCHED-SERVICE-NOT-FOUND', 'INVALID-PROBE-INTERVAL-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/host-tools/watchdog')
      check(
        'WATCHDOG-SERVICES-READ',
        read.status === 200 && isHex64(read.data?.revision) && Array.isArray(read.data?.rows) && read.data.rows.length === 6,
        { status: read.status, rows: read.data?.rows?.length ?? null, budgetPerHour: read.data?.budgetPerHour ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused('UNKNOWN-WATCHED-SERVICE-NOT-FOUND', await root.put('/api/server/host-tools/watchdog/unknown', { enabled: false, autoRestart: false, intervalSec: 60, budgetPerHour: 2, expectedRevision: rev }), 'NOT_FOUND')
      refused('INVALID-PROBE-INTERVAL-REFUSED', await root.put('/api/server/host-tools/watchdog/dovecot', { enabled: false, autoRestart: false, intervalSec: 10, budgetPerHour: 2, expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('error-reporting', {
    prefix: 'S20T16',
    probe: '/api/server/error-reporting',
    paths: /^\/api\/server\/error-reporting(?:\/test|\?unknown=1)?$/,
    unit: [{ id: 'S20T16-UNIT-1', file: 'apps/api/src/panel-tools.test.ts', name: 'error reporting sends the stack, release, generation and component with the password replaced' }],
    checks: ['ERROR-REPORTING-CONFIG-READ', 'UNCONFIGURED-DSN-TEST-REFUSED', 'INSECURE-DSN-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/error-reporting')
      check(
        'ERROR-REPORTING-CONFIG-READ',
        read.status === 200 && isHex64(read.data?.revision) && typeof read.data?.invalid === 'boolean'
          && (read.data?.invalid === true || typeof read.data?.config?.environment === 'string'),
        { status: read.status, invalid: read.data?.invalid ?? null, dsnSet: Boolean(read.data?.config?.dsn) },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      if (!read.data?.config?.dsn) {
        refused('UNCONFIGURED-DSN-TEST-REFUSED', await root.post('/api/server/error-reporting/test', {}), 'PRECONDITION_FAILED')
      } else {
        refused('UNCONFIGURED-DSN-TEST-REFUSED', await root.get('/api/server/error-reporting?unknown=1'), 'VALIDATION')
      }
      refused(
        'INSECURE-DSN-REFUSED',
        await root.put('/api/server/error-reporting', { config: { dsn: 'http://0123456789abcdef0123456789abcdef@127.0.0.1/1', environment: 'production', sampleRate: 1 }, expectedRevision: rev }),
        'VALIDATION',
      )
      refused(
        'STALE-REVISION-CONFLICT',
        await root.put('/api/server/error-reporting', { config: { dsn: null, environment: 'production', sampleRate: 1 }, expectedRevision: nextStale(rev) }),
        'CONFLICT',
      )
    },
  }),

  tool('metrics-export', {
    prefix: 'S20T17',
    probe: '/api/server/metrics-export',
    paths: /^\/api\/(?:server\/metrics-export|metrics)$/,
    unit: [{ id: 'S20T17-UNIT-1', file: 'apps/api/src/panel-tools.test.ts', name: 'OpenMetrics export renders each account and leaves out what no sample holds' }],
    checks: ['METRICS-EXPORT-SETTINGS-READ', 'METRICS-SCRAPE-GATE-ENFORCED', 'INVALID-SOURCE-IP-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/metrics-export')
      check(
        'METRICS-EXPORT-SETTINGS-READ',
        read.status === 200 && isHex64(read.data?.revision) && read.data?.path === '/api/metrics' && read.data?.scope === 'metrics:read',
        { status: read.status, enabled: read.data?.config?.enabled ?? null, scope: read.data?.scope ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      const scrape = await root.get('/api/metrics')
      if (read.data?.config?.enabled === true) {
        check('METRICS-SCRAPE-GATE-ENFORCED', scrape.status === 200 && typeof scrape.text === 'string' && scrape.text.includes('# EOF'), { status: scrape.status })
      } else {
        refused('METRICS-SCRAPE-GATE-ENFORCED', scrape, 'PRECONDITION_FAILED')
      }
      refused('INVALID-SOURCE-IP-REFUSED', await root.put('/api/server/metrics-export', { config: { enabled: false, allow: ['not-an-ip'] }, expectedRevision: rev }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/metrics-export', { config: { enabled: false, allow: [] }, expectedRevision: nextStale(rev) }), 'CONFLICT')
    },
  }),

  tool('config-as-code', {
    prefix: 'S20T18',
    probe: '/api/server/config-as-code/export',
    paths: /^\/api\/server\/config-as-code\/(?:export|preview|apply)$/,
    unit: [{ id: 'S20T18-UNIT-1', file: 'apps/api/src/panel-tools.test.ts', name: 'configuration as code importing the export changes nothing and a changed disk limit shows exactly that change' }],
    checks: ['CONFIG-TREE-EXPORT-READ', 'IDENTICAL-EXPORT-PREVIEW-EMPTY-DIFF', 'NEW-ACCOUNT-IMPORT-NOT-IMPORTABLE', 'STALE-REVISION-APPLY-CONFLICT'],
    async run({ root, check, refused }) {
      const exported = await root.get('/api/server/config-as-code/export')
      const files = exported.data?.files && typeof exported.data.files === 'object' && !Array.isArray(exported.data.files) ? exported.data.files : {}
      check(
        'CONFIG-TREE-EXPORT-READ',
        exported.status === 200 && isHex64(exported.data?.revision) && Object.keys(files).length >= 1,
        { status: exported.status, fileCount: Object.keys(files).length },
      )
      const samePreview = await root.post('/api/server/config-as-code/preview', { files })
      check(
        'IDENTICAL-EXPORT-PREVIEW-EMPTY-DIFF',
        samePreview.status === 200 && Array.isArray(samePreview.data?.changes) && samePreview.data.changes.length === 0 && samePreview.data?.applicable === true,
        { status: samePreview.status, changes: samePreview.data?.changes?.length ?? null, applicable: samePreview.data?.applicable ?? null },
      )
      const badAccount = await root.post('/api/server/config-as-code/preview', {
        files: { 'accounts/xqnotimportable.yaml': 'id: xqnotimportable\nusername: xqnotimportable\nplanId: p1\n' },
      })
      check(
        'NEW-ACCOUNT-IMPORT-NOT-IMPORTABLE',
        badAccount.status === 200 && Array.isArray(badAccount.data?.changes) && badAccount.data.changes[0]?.apply === 'not-importable' && badAccount.data?.applicable === false,
        { status: badAccount.status, apply: badAccount.data?.changes?.[0]?.apply ?? null, applicable: badAccount.data?.applicable ?? null },
      )
      const rev = isHex64(exported.data?.revision) ? exported.data.revision : '0'.repeat(64)
      refused('STALE-REVISION-APPLY-CONFLICT', await root.post('/api/server/config-as-code/apply', { files: {}, expectedRevision: nextStale(rev) }), 'CONFLICT')
    },
  }),

  tool('site-staging', {
    prefix: 'S20T19',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/staging',
    paths: /^\/api\/account\/staging(?:\/[0-9a-f-]{36}(?:\/copy)?)?$/,
    unit: [{ id: 'S20T19-UNIT-1', file: 'apps/api/src/acct-staging-workspace.test.ts', name: 'staging API lists stageable owned domains and runs copy, review, promote and discard with record CAS' }],
    checks: ['STAGING-WORKSPACE-READ', 'OWNED-DOMAIN-INSPECT-READ', 'UNKNOWN-DOMAIN-NOT-FOUND', 'STALE-RECORDS-REVISION-CONFLICT'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/staging')
      const domains = Array.isArray(read.data?.domains) ? read.data.domains : []
      check(
        'STAGING-WORKSPACE-READ',
        read.status === 200 && isHex64(read.data?.revision) && Array.isArray(read.data?.domains) && Array.isArray(read.data?.records) && domains.length >= 1,
        { status: read.status, domains: domains.length, records: read.data?.records?.length ?? null },
      )
      const domainId = isUuid(domains[0]?.id) ? domains[0].id : ZERO_UUID
      const inspect = await owner.get(`/api/account/staging/${domainId}`)
      check(
        'OWNED-DOMAIN-INSPECT-READ',
        inspect.status === 200 && typeof inspect.data?.live?.files === 'number' && typeof inspect.data?.staging?.exists === 'boolean',
        { status: inspect.status, liveFiles: inspect.data?.live?.files ?? null, stagingExists: inspect.data?.staging?.exists ?? null },
      )
      refused('UNKNOWN-DOMAIN-NOT-FOUND', await owner.get(`/api/account/staging/${ZERO_UUID}`), 'NOT_FOUND')
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused('STALE-RECORDS-REVISION-CONFLICT', await owner.post(`/api/account/staging/${domainId}/copy`, { expectedRecordsRevision: nextStale(rev) }), 'CONFLICT')
    },
  }),

  tool('account-containers', {
    prefix: 'S20T20',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/runtime',
    page: { route: '/software/containers', read: '/api/account/runtime', shows: () => ['Containers'] },
    paths: /^\/api\/account\/runtime(?:\/log\?target=invalid|\?unknown=1)?$/,
    unit: [{ id: 'S20T20-UNIT-1', file: 'apps/agent/src/account-runtime.test.ts', name: 'applyRuntimeOp refuses a runtime the host lacks, a foreign domain, cache above the plan and containers without the engine' }],
    checks: ['ACCOUNT-CONTAINERS-VIEW-READ', 'UNAPPROVED-REGISTRY-IMAGE-REFUSED', 'INVALID-LOG-TARGET-REFUSED', 'QUERY-SELECTOR-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/runtime')
      check(
        'ACCOUNT-CONTAINERS-VIEW-READ',
        read.status === 200 && isHex64(read.data?.revision) && typeof read.data?.host?.containers?.available === 'boolean' && Array.isArray(read.data?.containers),
        { status: read.status, engineAvailable: read.data?.host?.containers?.available ?? null, containers: read.data?.containers?.length ?? null },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      refused(
        'UNAPPROVED-REGISTRY-IMAGE-REFUSED',
        await owner.post('/api/account/runtime', { op: 'container.run', expectedRevision: rev, container: { name: 'xqbad', image: 'untrusted.example.com/app:latest', env: {} } }),
        'VALIDATION',
      )
      refused('INVALID-LOG-TARGET-REFUSED', await owner.get('/api/account/runtime/log?target=invalid'), 'VALIDATION')
      refused('QUERY-SELECTOR-REFUSED', await owner.get('/api/account/runtime?unknown=1'), 'VALIDATION')
    },
  }),

  tool('software-center', {
    prefix: 'S20T21',
    probe: '/api/server/software-center?page=catalog',
    paths: /^\/api\/server\/software-center(?:\/preview|\?page=(?:catalog|module|runtime|invalid))?$/,
    unit: [{ id: 'S20T21-UNIT-1', file: 'apps/agent/src/software-center-catalog.test.ts', name: 'shipped software center catalog protects every package the installer profiles name, including PHP-FPM for each supported version' }],
    checks: ['SOFTWARE-CATALOG-PAGES-READ', 'COMPONENT-PREVIEW-CONTRACT', 'INVALID-PAGE-SELECTOR-REFUSED', 'INVALID-PREVIEW-BODY-REFUSED'],
    async run({ root, check, refused }) {
      const catalog = await root.get('/api/server/software-center?page=catalog')
      const modules = await root.get('/api/server/software-center?page=module')
      const runtimes = await root.get('/api/server/software-center?page=runtime')
      check(
        'SOFTWARE-CATALOG-PAGES-READ',
        catalog.status === 200 && modules.status === 200 && runtimes.status === 200
          && Array.isArray(catalog.data?.components) && Array.isArray(modules.data?.components) && Array.isArray(runtimes.data?.components),
        { catalog: catalog.data?.components?.length ?? null, modules: modules.data?.components?.length ?? null, runtimes: runtimes.data?.components?.length ?? null },
      )
      const rev = isHex64(catalog.data?.revision) ? catalog.data.revision : '0'.repeat(64)
      const targetId = typeof catalog.data?.components?.[0]?.id === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(catalog.data.components[0].id) ? catalog.data.components[0].id : 'redis'
      const preview = await root.post('/api/server/software-center/preview', { action: 'install', componentIds: [targetId], expectedRevision: rev })
      check(
        'COMPONENT-PREVIEW-CONTRACT',
        preview.status === 200 && ['ready', 'refused', 'unavailable'].includes(preview.data?.preview?.state)
          && typeof preview.data?.preview?.estimate?.memoryMb === 'number',
        { status: preview.status, previewState: preview.data?.preview?.state ?? null, memoryMb: preview.data?.preview?.estimate?.memoryMb ?? null },
      )
      refused('INVALID-PAGE-SELECTOR-REFUSED', await root.get('/api/server/software-center?page=invalid'), 'VALIDATION')
      refused('INVALID-PREVIEW-BODY-REFUSED', await root.post('/api/server/software-center/preview', { action: 'invalid', componentIds: [], expectedRevision: 'bad' }), 'VALIDATION')
    },
  }),

  tool('account-repair', {
    prefix: 'S20T22',
    needs: ['account'],
    probe: '/api/accounts/health',
    paths: /^\/api\/accounts\/(?:health(?:\?username=[a-z0-9]{1,16})?|repair\/(?:preview|run))$/,
    unit: [{ id: 'S20T22-UNIT-1', file: 'apps/agent/src/account-repair.test.ts', name: 'account repair route starts one job for saved accounts only' }],
    checks: ['ACCOUNT-HEALTH-READ', 'OWNERSHIP-REPAIR-PREVIEW-READ', 'UNKNOWN-ACCOUNT-PREVIEW-NOT-FOUND', 'INVALID-REPAIR-FIX-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const username = safeUser(fixture?.username)
      const health = await root.get(`/api/accounts/health?username=${username}`)
      check(
        'ACCOUNT-HEALTH-READ',
        health.status === 200 && ['read', 'unavailable'].includes(health.data?.host) && Array.isArray(health.data?.accounts) && health.data.accounts[0]?.username === username,
        { status: health.status, host: health.data?.host ?? null, username },
      )
      const preview = await root.post('/api/accounts/repair/preview', { accounts: [username] })
      check(
        'OWNERSHIP-REPAIR-PREVIEW-READ',
        preview.status === 200 && Array.isArray(preview.data?.accounts) && preview.data.accounts[0]?.username === username
          && ['ok', 'problem', 'unavailable'].includes(preview.data.accounts[0]?.ownership),
        { status: preview.status, ownership: preview.data?.accounts?.[0]?.ownership ?? null },
      )
      refused('UNKNOWN-ACCOUNT-PREVIEW-NOT-FOUND', await root.post('/api/accounts/repair/preview', { accounts: ['missingacct999'] }), 'NOT_FOUND')
      refused('INVALID-REPAIR-FIX-REFUSED', await root.post('/api/accounts/repair/run', { accounts: [username], fixes: ['unknown'] }), 'VALIDATION')
    },
  }),

  tool('notification-templates', {
    prefix: 'S20T23',
    probe: '/api/server/notification-templates',
    paths: /^\/api\/server\/notification-templates(?:\/(?:save|preview))?$/,
    unit: [{ id: 'S20T23-UNIT-1', file: 'apps/api/src/notification-templates.test.ts', name: 'notification templates refuses an unknown variable with its name and keeps the saved text' }],
    checks: ['NOTIFICATION-TEMPLATES-LIST-READ', 'SAMPLE-PREVIEW-RENDERS-VARIABLES', 'UNKNOWN-VARIABLE-SAVE-REFUSED', 'MISSING-LANGUAGE-SAVE-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/notification-templates')
      check(
        'NOTIFICATION-TEMPLATES-LIST-READ',
        read.status === 200 && isHex64(read.data?.revision) && Array.isArray(read.data?.events) && read.data.events.length === 6,
        { status: read.status, events: read.data?.events?.length ?? null },
      )
      const preview = await root.post('/api/server/notification-templates/preview', { event: 'account.provisioned', locale: 'en' })
      check(
        'SAMPLE-PREVIEW-RENDERS-VARIABLES',
        preview.status === 200 && typeof preview.data?.subject === 'string' && preview.data.subject.includes('alice')
          && typeof preview.data?.body === 'string' && preview.data.body.includes('example.com'),
        { status: preview.status, hasSampleAccount: Boolean(preview.data?.subject?.includes('alice')) },
      )
      const rev = isHex64(read.data?.revision) ? read.data.revision : '0'.repeat(64)
      const badVar = await root.post('/api/server/notification-templates/save', {
        event: 'account.provisioned',
        expectedRevision: rev,
        en: { subject: 'Ready {unknownVar}', body: 'Body {account}' },
        ar: { subject: 'جاهز {account}', body: 'النص {domain}' },
      })
      check(
        'UNKNOWN-VARIABLE-SAVE-REFUSED',
        badVar.status >= 400 && badVar.status < 500 && badVar.data?.code === 'VALIDATION' && JSON.stringify(badVar.data).includes('unknownVar'),
        { status: badVar.status, code: badVar.data?.code ?? null, namedVariable: JSON.stringify(badVar.data ?? {}).includes('unknownVar') },
      )
      refused(
        'MISSING-LANGUAGE-SAVE-REFUSED',
        await root.post('/api/server/notification-templates/save', {
          event: 'account.provisioned',
          expectedRevision: rev,
          en: { subject: 'Ready {account}', body: 'Body {domain}' },
          ar: { subject: '', body: '' },
        }),
        'VALIDATION',
      )
    },
  }),

  tool('command-line-api', {
    prefix: 'S20T24',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/developer/functions',
    paths: /^\/api\/account\/developer\/(?:functions|openapi|call)$/,
    unit: [
      { id: 'S20T24-UNIT-1', file: 'apps/api/src/cli-api/client.test.ts', name: 'xuapi / xwhmapi argument parsing refuses secrets on the command line' },
      { id: 'S20T24-UNIT-2', file: 'apps/api/src/cli-api/functions.test.ts', name: 'xuapi / xwhmapi function catalog lists only routes admitted on the listener of each command and reachable from the command line' },
    ],
    checks: ['XUAPI-CATALOG-FUNCTIONS-READ', 'XUAPI-OPENAPI-DOCUMENT-READ', 'SHELL-CRON-LIST-CALL-SUCCEEDS', 'UNLISTED-FUNCTION-CALL-NOT-FOUND'],
    async run({ owner, check, refused }) {
      const fns = await owner.get('/api/account/developer/functions')
      check(
        'XUAPI-CATALOG-FUNCTIONS-READ',
        fns.status === 200 && fns.data?.surface === 'account' && fns.data?.command === 'xuapi'
          && Array.isArray(fns.data?.functions) && fns.data.functions.some(fn => fn?.module === 'cron' && fn?.fn === 'list' && fn?.path === '/api/account/cron'),
        { status: fns.status, command: fns.data?.command ?? null, count: fns.data?.functions?.length ?? null },
      )
      const openapi = await owner.get('/api/account/developer/openapi')
      check(
        'XUAPI-OPENAPI-DOCUMENT-READ',
        openapi.status === 200 && openapi.data?.openapi === '3.1.0' && typeof openapi.data?.paths === 'object' && openapi.data.paths !== null,
        { status: openapi.status, openapi: openapi.data?.openapi ?? null },
      )
      const cronList = await owner.post('/api/account/developer/call', { module: 'cron', fn: 'list', params: {} })
      check(
        'SHELL-CRON-LIST-CALL-SUCCEEDS',
        cronList.status === 200 && cronList.data?.status === 200 && cronList.data?.request?.path === '/api/account/cron',
        { status: cronList.status, innerStatus: cronList.data?.status ?? null, targetPath: cronList.data?.request?.path ?? null },
      )
      refused('UNLISTED-FUNCTION-CALL-NOT-FOUND', await owner.post('/api/account/developer/call', { module: 'cron', fn: 'nosuch', params: {} }), 'NOT_FOUND')
    },
  }),
]
