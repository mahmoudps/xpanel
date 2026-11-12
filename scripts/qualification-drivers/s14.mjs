import { tool } from './kit.mjs'

/**
 * Slice s14 - reviewed WHM tweak settings, server observation, host access, DNS/domain ops, and database tools.
 * Every check acts strictly through the HTTPS panel API with bounded run-scoped objects and full undo cleanup.
 */

const ID = '[0-9a-f-]{36}'
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ZERO_REV = '0'.repeat(64)
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

async function guardTweak(root, undo) {
  const before = await root.get('/api/server/tweak-settings')
  if (before.status !== 200 || !before.data?.values || typeof before.data?.revision !== 'string') {
    return { before, values: null, revision: ZERO_REV }
  }
  const origValues = structuredClone(before.data.values)
  undo('tweak settings', async () => {
    const now = await root.get('/api/server/tweak-settings')
    if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
    if (same(now.data?.values, origValues)) return true
    const res = await root.put('/api/server/tweak-settings', { values: origValues, expectedRevision: now.data.revision })
    return res.status === 200
  })
  return { before, values: origValues, revision: before.data.revision }
}

export default [
  tool('tweak-logging', {
    prefix: 'S14T01', as: 'root', probe: '/api/server/tweak-settings',
    page: { route: '/whm/audit', read: '/api/server/tweak-settings', shows: () => ['Audit log'] },
    paths: /^\/api\/(?:server\/tweak-settings(?:\?x=1)?|audit(?:\?limit=5)?)$/, requests: 25,
    unit: [{ id: 'S14T01-UNIT-1', file: 'apps/api/src/tweak-settings-workspace.test.ts', name: 'settings index lists every tweak and each other setting once, each with its source page' }],
    checks: ['SELECTOR-QUERY-REFUSED', 'NON-BOOLEAN-LOGGING-REFUSED', 'LOGGING-TWEAK-SAVED-AND-AUDIT-READ'],
    async run({ root, check, refused, undo }) {
      refused('SELECTOR-QUERY-REFUSED', await root.get('/api/server/tweak-settings?x=1'), 'VALIDATION')
      const { values, revision } = await guardTweak(root, undo)
      refused('NON-BOOLEAN-LOGGING-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'logging.apiCalls': 'yes' }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('LOGGING-TWEAK-SAVED-AND-AUDIT-READ', false, { hasValues: false })
        return
      }
      const nextVal = !values['logging.apiCalls']
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'logging.apiCalls': nextVal }, expectedRevision: revision,
      })
      const audit = await root.get('/api/audit?limit=5')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('LOGGING-TWEAK-SAVED-AND-AUDIT-READ', saved.status === 200 && saved.data?.values?.['logging.apiCalls'] === nextVal && audit.status === 200 && Array.isArray(audit.data?.entries) && restored.status === 200, {
        savedStatus: saved.status, auditStatus: audit.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-display', {
    prefix: 'S14T02', as: 'root', probe: '/api/server/panel/branding',
    paths: /^\/api\/server\/panel\/branding(?:\?expectedRevision=[0-9a-f]{64})?$/, requests: 25,
    unit: [{ id: 'S14T02-UNIT-1', file: 'apps/api/src/panel-branding.test.ts', name: 'branding grammar and image inspection normalizes colours and refuses markup, insecure links and malformed contacts' }],
    checks: ['INVALID-THEME-REFUSED', 'STALE-BRANDING-CONFLICT', 'DISPLAY-DENSITY-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/panel/branding')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origState = before.data?.state ?? 'default'
      const src = before.data?.branding ?? {}
      const editable = {
        companyName: typeof src.companyName === 'string' ? src.companyName : 'xPanel Hosting',
        productName: typeof src.productName === 'string' ? src.productName : 'xPanel',
        footerText: typeof src.footerText === 'string' ? src.footerText : '',
        hidePoweredBy: typeof src.hidePoweredBy === 'boolean' ? src.hidePoweredBy : false,
        primaryColor: typeof src.primaryColor === 'string' ? src.primaryColor : '#2563eb',
        accentColor: typeof src.accentColor === 'string' ? src.accentColor : '#0ea5e9',
        supportUrl: typeof src.supportUrl === 'string' ? src.supportUrl : '',
        supportEmail: typeof src.supportEmail === 'string' ? src.supportEmail : '',
        defaultTheme: src.defaultTheme === 'dark' ? 'dark' : 'light',
        defaultDensity: src.defaultDensity === 'compact' ? 'compact' : 'comfortable',
      }
      refused('INVALID-THEME-REFUSED', await root.put('/api/server/panel/branding', {
        ...editable, defaultTheme: 'solarized', expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-BRANDING-CONFLICT', await root.put('/api/server/panel/branding', {
        ...editable, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('DISPLAY-DENSITY-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      const restoreBranding = async () => {
        const now = await root.get('/api/server/panel/branding')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (origState === 'default') {
          if (now.data?.state === 'default') return true
          return (await root.delete(`/api/server/panel/branding?expectedRevision=${now.data.revision}`)).status === 200
        }
        return (await root.put('/api/server/panel/branding', { ...editable, expectedRevision: now.data.revision })).status === 200
      }
      undo('panel branding', restoreBranding)
      const nextDensity = editable.defaultDensity === 'compact' ? 'comfortable' : 'compact'
      const saved = await root.put('/api/server/panel/branding', {
        ...editable, defaultDensity: nextDensity, expectedRevision: rev,
      })
      const restoredOk = await restoreBranding()
      check('DISPLAY-DENSITY-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.branding?.defaultDensity === nextDensity && restoredOk, {
        savedStatus: saved.status, density: saved.data?.branding?.defaultDensity ?? null, restoredOk,
      })
    },
  }),

  tool('tweak-status', {
    prefix: 'S14T03', as: 'root', probe: '/api/server/server-health',
    page: { route: '/whm/panel/notifications', read: '/api/server/server-health', shows: () => ['Notifications'] },
    paths: /^\/api\/server\/(?:server-health(?:\?refresh=1)?|tweak-settings)$/, requests: 25,
    unit: [{ id: 'S14T03-UNIT-1', file: 'apps/api/src/server-health-workspace.test.ts', name: 'API server health workspace authorizes root before and after the agent read and returns the projected report' }],
    checks: ['HEALTH-SELECTOR-REFUSED', 'OUT-OF-RANGE-THRESHOLD-REFUSED', 'FIXED-LOAD-THRESHOLD-PROJECTED'],
    async run({ root, check, refused, undo }) {
      refused('HEALTH-SELECTOR-REFUSED', await root.get('/api/server/server-health?refresh=1'), 'VALIDATION')
      const { values, revision } = await guardTweak(root, undo)
      refused('OUT-OF-RANGE-THRESHOLD-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'status.loadThreshold': 0 }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('FIXED-LOAD-THRESHOLD-PROJECTED', false, { hasValues: false })
        return
      }
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'status.loadThreshold': 8 }, expectedRevision: revision,
      })
      const health = await root.get('/api/server/server-health')
      const loadCheck = (health.data?.checks ?? []).find(item => item?.id === 'load')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('FIXED-LOAD-THRESHOLD-PROJECTED', saved.status === 200 && health.status === 200 && Array.isArray(health.data?.checks) && (loadCheck === undefined || String(loadCheck.evidence ?? '').includes('8')) && restored.status === 200, {
        savedStatus: saved.status, healthStatus: health.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-packages', {
    prefix: 'S14T04', as: 'root', probe: '/api/server/tweak-settings',
    page: { route: '/whm/plans/features', read: '/api/server/tweak-settings', shows: () => ['Feature lists'] },
    paths: new RegExp(String.raw`^\/api\/(?:server\/tweak-settings|plans(?:\/${ID})?)$`), requests: 25,
    unit: [{ id: 'S14T04-UNIT-1', file: 'packages/core/src/tweaks/tweaks.test.ts', name: 'tweak settings registry caps package values at the cPanel ceiling and leaves unlimited alone' }],
    checks: ['PLAN-DISK-CEILING-REFUSED', 'TWEAK-CEILING-REFUSED', 'DEFAULT-PACKAGE-LIMITS-INHERITED'],
    async run({ root, tag, check, refused, undo }) {
      const tweaks = await root.get('/api/server/tweak-settings')
      const rev = typeof tweaks.data?.revision === 'string' ? tweaks.data.revision : ZERO_REV
      const vals = tweaks.data?.values ?? {}
      refused('PLAN-DISK-CEILING-REFUSED', await root.post('/api/plans', {
        name: `xq-ceil-${tag}`, resources: { diskMb: 4294967297 },
      }), 'VALIDATION')
      refused('TWEAK-CEILING-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...vals, 'packages.defaultDiskMb': 4294967297 }, expectedRevision: rev,
      }), 'VALIDATION')
      const created = await root.post('/api/plans', { name: `xq-pkg-${tag}` })
      const planId = created.data?.plan?.id
      if (typeof planId === 'string') {
        undo('default package plan', async () => [200, 404].includes((await root.delete(`/api/plans/${planId}`)).status))
      }
      const expectedDisk = vals['packages.defaultDiskMb']
      const inherited = created.status === 201 && typeof planId === 'string' && typeof expectedDisk === 'number' && created.data?.plan?.resources?.diskMb === expectedDisk
      if (typeof planId === 'string') await root.delete(`/api/plans/${planId}`)
      check('DEFAULT-PACKAGE-LIMITS-INHERITED', inherited, {
        status: created.status, diskMb: created.data?.plan?.resources?.diskMb ?? null, expectedDisk: expectedDisk ?? null,
      })
    },
  }),

  tool('tweak-development', {
    prefix: 'S14T05', as: 'root', probe: '/api/server/panel/settings',
    paths: /^\/api\/server\/panel\/(?:settings|developer)$/, requests: 25,
    unit: [{ id: 'S14T05-UNIT-1', file: 'apps/api/src/developer-workspace.test.ts', name: 'finite interactive API explorer refuses both explorer surfaces while root keeps the switch off' }],
    checks: ['INVALID-DEV-MODE-REFUSED', 'EXPLORER-WRITE-REFUSED', 'DEVELOPER-MODE-TOGGLED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/panel/settings')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const src = before.data?.settings ?? {}
      const origSettings = {
        offlineMode: typeof src.offlineMode === 'boolean' ? src.offlineMode : false,
        offlineMessage: typeof src.offlineMessage === 'string' ? src.offlineMessage : '',
        developerMode: typeof src.developerMode === 'boolean' ? src.developerMode : false,
        liveUpdates: typeof src.liveUpdates === 'boolean' ? src.liveUpdates : true,
        reverseProxyAllowedHosts: Array.isArray(src.reverseProxyAllowedHosts) ? src.reverseProxyAllowedHosts : [],
      }
      refused('INVALID-DEV-MODE-REFUSED', await root.put('/api/server/panel/settings', {
        ...origSettings, developerMode: 'yes', expectedRevision: rev,
      }), 'VALIDATION')
      refused('EXPLORER-WRITE-REFUSED', await root.post('/api/server/panel/developer', {
        operation: 'DELETE',
      }), 'VALIDATION')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('DEVELOPER-MODE-TOGGLED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('panel developer settings', async () => {
        const now = await root.get('/api/server/panel/settings')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.settings, origSettings)) return true
        return (await root.put('/api/server/panel/settings', { ...origSettings, expectedRevision: now.data.revision })).status === 200
      })
      const nextDev = !origSettings.developerMode
      const saved = await root.put('/api/server/panel/settings', {
        ...origSettings, developerMode: nextDev, expectedRevision: rev,
      })
      const explorer = await root.get('/api/server/panel/developer')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/panel/settings', { ...origSettings, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('DEVELOPER-MODE-TOGGLED-AND-RESTORED', saved.status === 200 && saved.data?.settings?.developerMode === nextDev && explorer.status === 200 && restored.status === 200, {
        savedStatus: saved.status, explorerStatus: explorer.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-support', {
    prefix: 'S14T06', as: 'root', probe: '/api/server/support',
    paths: /^\/api\/server\/(?:support(?:\?x=1|\/bundle\?manifest=[0-9a-f]{16})?|tweak-settings)$/, requests: 25,
    unit: [{ id: 'S14T06-UNIT-1', file: 'apps/api/src/support-workspace.test.ts', name: 'API support workspace returns the projected summary, the manifest and an unconfigured contact, authorizing root before and after the host read' }],
    checks: ['SUPPORT-SELECTOR-REFUSED', 'RETENTION-BOUNDS-REFUSED', 'MISMATCHED-MANIFEST-CONFLICT', 'RETENTION-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      refused('SUPPORT-SELECTOR-REFUSED', await root.get('/api/server/support?x=1'), 'VALIDATION')
      const { values, revision } = await guardTweak(root, undo)
      refused('RETENTION-BOUNDS-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'support.updateLogRetentionDays': 0 }, expectedRevision: revision,
      }), 'VALIDATION')
      refused('MISMATCHED-MANIFEST-CONFLICT', await root.get('/api/server/support/bundle?manifest=0000000000000000'), 'CONFLICT')
      if (!values) {
        check('RETENTION-SAVED-AND-RESTORED', false, { hasValues: false })
        return
      }
      const nextDays = values['support.updateLogRetentionDays'] === 60 ? 75 : 60
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'support.updateLogRetentionDays': nextDays }, expectedRevision: revision,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('RETENTION-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.values?.['support.updateLogRetentionDays'] === nextDays && restored.status === 200, {
        savedStatus: saved.status, days: saved.data?.values?.['support.updateLogRetentionDays'] ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('web-server-status', {
    prefix: 'S14T07', as: 'root', probe: '/api/server/services/web-status',
    paths: /^\/api\/server\/services\/web-status(?:\?host=127\.0\.0\.1)?$/, requests: 15,
    unit: [{ id: 'S14T07-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'web server status reads the summary and lists each busy worker with client, vhost and request' }],
    checks: ['WEB-STATUS-READ', 'WEB-STATUS-SELECTOR-REFUSED', 'WEB-STATUS-POST-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/services/web-status')
      check('WEB-STATUS-READ', view.status === 200 && typeof view.data?.engine === 'string' && Boolean(view.data?.apache) && Boolean(view.data?.nginx), {
        status: view.status, engine: view.data?.engine ?? null,
      })
      refused('WEB-STATUS-SELECTOR-REFUSED', await root.get('/api/server/services/web-status?host=127.0.0.1'), 'VALIDATION')
      refused('WEB-STATUS-POST-REFUSED', await root.post('/api/server/services/web-status', {}), 405)
    },
  }),

  tool('daily-process-log', {
    prefix: 'S14T08', as: 'root', probe: '/api/server/services/process-log',
    paths: /^\/api\/server\/services\/process-log(?:\?(?:day=(?:today|yesterday|2020-01-01)|user=root))?$/, requests: 15,
    unit: [{ id: 'S14T08-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'daily process log averages over the day and lists the top process, as the acceptance reads' }],
    checks: ['PROCESS-LOG-DAYS-READ', 'ARBITRARY-DATE-REFUSED', 'UNKNOWN-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const [today, yesterday] = await Promise.all([
        root.get('/api/server/services/process-log?day=today'),
        root.get('/api/server/services/process-log?day=yesterday'),
      ])
      check('PROCESS-LOG-DAYS-READ', today.status === 200 && yesterday.status === 200 && /^\d{4}-\d{2}-\d{2}$/.test(today.data?.day ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(yesterday.data?.day ?? ''), {
        todayStatus: today.status, yesterdayStatus: yesterday.status,
      })
      refused('ARBITRARY-DATE-REFUSED', await root.get('/api/server/services/process-log?day=2020-01-01'), 'VALIDATION')
      refused('UNKNOWN-SELECTOR-REFUSED', await root.get('/api/server/services/process-log?user=root'), 'VALIDATION')
    },
  }),

  tool('server-information', {
    prefix: 'S14T09', as: 'root', probe: '/api/server/info',
    paths: /^\/api\/server\/(?:info|server-observation\/network(?:\?x=1)?)$/, requests: 15,
    unit: [{ id: 'S14T09-UNIT-1', file: 'apps/agent/src/host-info-disks.test.ts', name: 'complete per-mount host disk observations uses one literal command and covers root, home, pseudo and file-bind mounts without exclusions' }],
    checks: ['HOST-METRICS-AND-DISKS-READ', 'HARDWARE-OBSERVATION-READ', 'HARDWARE-SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const [info, net] = await Promise.all([
        root.get('/api/server/info'),
        root.get('/api/server/server-observation/network'),
      ])
      check('HOST-METRICS-AND-DISKS-READ', info.status === 200 && Number.isFinite(info.data?.load?.load1) && Number(info.data?.memory?.totalBytes) > 0 && Number(info.data?.disk?.totalBytes) > 0, {
        status: info.status, load1: info.data?.load?.load1 ?? null, diskBytes: info.data?.disk?.totalBytes ?? null,
      })
      check('HARDWARE-OBSERVATION-READ', net.status === 200 && typeof net.data?.observedAt === 'string', {
        status: net.status,
      })
      refused('HARDWARE-SELECTOR-REFUSED', await root.get('/api/server/server-observation/network?x=1'), 'VALIDATION')
    },
  }),

  tool('task-queue-monitor', {
    prefix: 'S14T10', as: 'root', probe: '/api/jobs',
    paths: new RegExp(String.raw`^\/api\/jobs(?:\?status=pending|\/not-a-uuid|\/${ID}(?:\/cancel)?)?$`), requests: 15,
    unit: [{ id: 'S14T10-UNIT-1', file: 'apps/api/src/jobs-workspace.test.ts', name: 'API host jobs workspace forwards validated reads to the agent after root authorization' }],
    checks: ['JOB-QUEUE-READ', 'INVALID-STATUS-FILTER-REFUSED', 'MALFORMED-JOB-ID-REFUSED', 'ABSENT-JOB-NOT-FOUND'],
    async run({ root, check, refused }) {
      const list = await root.get('/api/jobs')
      check('JOB-QUEUE-READ', list.status === 200 && Array.isArray(list.data?.jobs), {
        status: list.status, count: Array.isArray(list.data?.jobs) ? list.data.jobs.length : null,
      })
      refused('INVALID-STATUS-FILTER-REFUSED', await root.get('/api/jobs?status=pending'), 'VALIDATION')
      refused('MALFORMED-JOB-ID-REFUSED', await root.get('/api/jobs/not-a-uuid'), 'VALIDATION')
      refused('ABSENT-JOB-NOT-FOUND', await root.get(`/api/jobs/${ZERO_UUID}`), 'NOT_FOUND')
    },
  }),

  tool('resolver-configuration', {
    prefix: 'S14T11', as: 'root', probe: '/api/server/resolvers',
    paths: /^\/api\/server\/(?:resolvers|server-observation\/network)$/, requests: 15,
    unit: [{ id: 'S14T11-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations saves resolvers bound to their revision and reports them as not applied without an agent' }],
    checks: ['RESOLVERS-AND-NETWORK-READ', 'SINGLE-RESOLVER-REFUSED', 'DUPLICATE-RESOLVER-REFUSED', 'STALE-RESOLVERS-CONFLICT'],
    async run({ root, check, refused }) {
      const [resCfg, net] = await Promise.all([
        root.get('/api/server/resolvers'),
        root.get('/api/server/server-observation/network'),
      ])
      const rev = typeof resCfg.data?.revision === 'string' ? resCfg.data.revision : ZERO_REV
      check('RESOLVERS-AND-NETWORK-READ', resCfg.status === 200 && typeof resCfg.data?.revision === 'string' && net.status === 200, {
        status: resCfg.status, netStatus: net.status,
      })
      refused('SINGLE-RESOLVER-REFUSED', await root.put('/api/server/resolvers', {
        resolvers: ['192.0.2.1'], expectedRevision: rev,
      }), 'VALIDATION')
      refused('DUPLICATE-RESOLVER-REFUSED', await root.put('/api/server/resolvers', {
        resolvers: ['192.0.2.1', '192.0.2.1'], expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-RESOLVERS-CONFLICT', await root.put('/api/server/resolvers', {
        resolvers: ['1.1.1.1', '8.8.8.8'], expectedRevision: ZERO_REV,
      }), 'CONFLICT')
    },
  }),

  tool('security-policies', {
    prefix: 'S14T12', as: 'root', probe: '/api/server/sec/sign-in',
    paths: /^\/api\/server\/sec\/sign-in(?:\/lockouts)?$/, requests: 25,
    unit: [{ id: 'S14T12-UNIT-1', file: 'apps/api/src/sign-in-policy.test.ts', name: 'sign-in policy rules canonicalizes ranges, rounds strength up to a multiple of 5 and refuses out-of-range values' }],
    checks: ['IDLE-SESSION-BOUNDS-REFUSED', 'STALE-POLICY-CONFLICT', 'SESSION-POLICY-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const [before, lockouts] = await Promise.all([
        root.get('/api/server/sec/sign-in'),
        root.get('/api/server/sec/sign-in/lockouts'),
      ])
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy
      const fallbackPolicy = origPolicy ?? {
        lockout: {
          username: { attempts: 5, windowMin: 15, durationMin: 15 },
          ip: { attempts: 10, windowMin: 15, durationMin: 15 },
          ipAllow: [],
          ipDeny: [],
        },
        passwordStrength: { default: 50, perService: { panel: null, mail: null, ftp: null, database: null, webdisk: null, directory: null } },
        session: { idleMin: 15, absoluteHours: 12 },
      }
      refused('IDLE-SESSION-BOUNDS-REFUSED', await root.put('/api/server/sec/sign-in', {
        policy: { ...fallbackPolicy, session: { idleMin: 31, absoluteHours: 12 } }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-POLICY-CONFLICT', await root.put('/api/server/sec/sign-in', {
        policy: fallbackPolicy, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || !origPolicy || typeof before.data?.revision !== 'string') {
        check('SESSION-POLICY-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('sign-in session policy', async () => {
        const now = await root.get('/api/server/sec/sign-in')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/sec/sign-in', { policy: origPolicy, expectedRevision: now.data.revision })).status === 200
      })
      const nextIdle = origPolicy.session?.idleMin === 20 ? 25 : 20
      const saved = await root.put('/api/server/sec/sign-in', {
        policy: { ...origPolicy, session: { ...origPolicy.session, idleMin: nextIdle } }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/sign-in', { policy: origPolicy, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('SESSION-POLICY-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.policy?.session?.idleMin === nextIdle && lockouts.status === 200 && restored.status === 200, {
        savedStatus: saved.status, idleMin: saved.data?.policy?.session?.idleMin ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('host-access-control', {
    prefix: 'S14T13', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/(?:rules(?:\/default-ssh)?|confirm))?$/, requests: 20,
    unit: [{ id: 'S14T13-UNIT-1', file: 'apps/api/src/firewall-workspace.test.ts', name: 'firewall rule-set rules lets system rules move and narrow but never be deleted, widened or unlocked' }],
    checks: ['FIREWALL-RULESET-READ', 'SYSTEM-SSH-DELETE-REFUSED', 'INVALID-CIDR-RULE-REFUSED', 'UNKNOWN-CONFIRMATION-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      check('FIREWALL-RULESET-READ', view.status === 200 && Array.isArray(view.data?.rules) && view.data?.confirmWindowSeconds === 120, {
        status: view.status, ruleCount: Array.isArray(view.data?.rules) ? view.data.rules.length : null,
      })
      refused('SYSTEM-SSH-DELETE-REFUSED', await root.delete('/api/firewall/rules/default-ssh', { expectedRevision: rev }), ['VALIDATION', 'NOT_FOUND'])
      refused('INVALID-CIDR-RULE-REFUSED', await root.post('/api/firewall/rules', {
        kind: 'port', action: 'accept', protocol: 'tcp', port: '70000', source: '999.999.999.999',
        forwardTo: null, list: null, comment: 'invalid', enabled: true, expectedRevision: rev,
      }), 'VALIDATION')
      refused('UNKNOWN-CONFIRMATION-NOT-FOUND', await root.post('/api/firewall/confirm', { id: ZERO_UUID }), 'NOT_FOUND')
    },
  }),

  tool('wheel-group-users', {
    prefix: 'S14T14', as: 'root', needs: ['account'], probe: '/api/server/sec/admin-group',
    paths: /^\/api\/server\/sec\/admin-group$/, requests: 20,
    unit: [{ id: 'S14T14-UNIT-1', file: 'apps/api/src/root-identity-workspace.test.ts', name: 'Manage Wheel Group Users reads the host group strictly and changes one hosting account with audit' }],
    checks: ['INVALID-GROUP-ACTION-REFUSED', 'SYSTEM-ROOT-ADD-FORBIDDEN', 'WHEEL-MEMBERSHIP-ROUNDTRIP'],
    async run({ root, fixture, check, refused, undo }) {
      refused('INVALID-GROUP-ACTION-REFUSED', await root.post('/api/server/sec/admin-group', {
        action: 'grant', username: fixture.username,
      }), 'VALIDATION')
      refused('SYSTEM-ROOT-ADD-FORBIDDEN', await root.post('/api/server/sec/admin-group', {
        action: 'add', username: 'root',
      }), 'FORBIDDEN')
      undo('wheel group member', async () => (await root.post('/api/server/sec/admin-group', {
        action: 'remove', username: fixture.username,
      })).status === 200)
      const added = await root.post('/api/server/sec/admin-group', { action: 'add', username: fixture.username })
      const inWheel = (added.data?.observation?.members ?? []).some(item => item?.username === fixture.username && item?.account === true)
      const removed = await root.post('/api/server/sec/admin-group', { action: 'remove', username: fixture.username })
      const outWheel = !(removed.data?.observation?.members ?? []).some(item => item?.username === fixture.username)
      check('WHEEL-MEMBERSHIP-ROUNDTRIP', added.status === 200 && inWheel && removed.status === 200 && outWheel, {
        addedStatus: added.status, group: added.data?.observation?.group ?? null, removedStatus: removed.status,
      })
    },
  }),

  tool('sudo-group-users', {
    prefix: 'S14T15', as: 'root', needs: ['account'], probe: '/api/server/sec/admin-group',
    paths: /^\/api\/server\/sec\/admin-group$/, requests: 20,
    unit: [{ id: 'S14T15-UNIT-1', file: 'apps/agent/src/root-identity.test.ts', name: 'administrator group membership adds and removes a hosting account with gpasswd and reports only an observed change' }],
    checks: ['MALFORMED-USERNAME-REFUSED', 'SYSTEM-USER-FORBIDDEN', 'SUDO-MEMBERSHIP-ROUNDTRIP'],
    async run({ root, fixture, check, refused, undo }) {
      refused('MALFORMED-USERNAME-REFUSED', await root.post('/api/server/sec/admin-group', {
        action: 'add', username: 'Upper_Case',
      }), 'VALIDATION')
      refused('SYSTEM-USER-FORBIDDEN', await root.post('/api/server/sec/admin-group', {
        action: 'add', username: 'root',
      }), 'FORBIDDEN')
      undo('sudo group member', async () => (await root.post('/api/server/sec/admin-group', {
        action: 'remove', username: fixture.username,
      })).status === 200)
      const added = await root.post('/api/server/sec/admin-group', { action: 'add', username: fixture.username })
      const inSudo = (added.data?.observation?.members ?? []).some(item => item?.username === fixture.username && item?.account === true)
      const removed = await root.post('/api/server/sec/admin-group', { action: 'remove', username: fixture.username })
      const outSudo = !(removed.data?.observation?.members ?? []).some(item => item?.username === fixture.username)
      check('SUDO-MEMBERSHIP-ROUNDTRIP', added.status === 200 && inSudo && removed.status === 200 && outSudo, {
        addedStatus: added.status, group: added.data?.observation?.group ?? null, removedStatus: removed.status,
      })
    },
  }),

  tool('waf-rules', {
    prefix: 'S14T16', as: 'root', probe: '/api/server/sec/waf-rules',
    page: { route: '/whm/security/waf', read: '/api/server/sec/waf-rules', shows: () => ['Web application firewall'] },
    paths: /^\/api\/server\/sec\/waf-rules(?:\/discard)?$/, requests: 25,
    unit: [{ id: 'S14T16-UNIT-1', file: 'apps/api/src/svc-waf-workspace.test.ts', name: 'custom WAF rules keeps a saved rule staged, whatever the request says about deployed rules' }],
    checks: ['INCLUDE-DIRECTIVE-REFUSED', 'MISMATCHED-RULE-ID-REFUSED', 'STAGED-RULE-KEPT-OUT-OF-DEPLOYED'],
    async run({ root, tag, check, refused, undo }) {
      const before = await root.get('/api/server/sec/waf-rules')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy ?? { engine: 'inherit', deployedEngine: 'inherit', staged: [], deployed: [] }
      refused('INCLUDE-DIRECTIVE-REFUSED', await root.put('/api/server/sec/waf-rules', {
        policy: { ...origPolicy, staged: [{ id: 49001, text: 'Include /etc/hosts', note: 'bad', enabled: true }] },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('MISMATCHED-RULE-ID-REFUSED', await root.put('/api/server/sec/waf-rules', {
        policy: { ...origPolicy, staged: [{ id: 49001, text: 'SecRule REQUEST_URI "@contains /x" "id:49999,phase:1,deny,status:403"', note: 'mismatch', enabled: true }] },
        expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('STAGED-RULE-KEPT-OUT-OF-DEPLOYED', false, { status: before.status })
        return
      }
      undo('staged waf rules', async () => {
        const now = await root.get('/api/server/sec/waf-rules')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/sec/waf-rules', { policy: origPolicy, expectedRevision: now.data.revision })).status === 200
      })
      const ruleText = `SecRule REQUEST_URI "@contains /.xq-${tag}" "id:49016,phase:1,deny,status:403,msg:'s14t16'"`
      const staged = await root.put('/api/server/sec/waf-rules', {
        policy: { ...origPolicy, staged: [...(origPolicy.staged ?? []), { id: 49016, text: ruleText, note: `xq-${tag}`, enabled: true }] },
        expectedRevision: rev,
      })
      const hasStaged = (staged.data?.policy?.staged ?? []).some(item => item?.id === 49016)
      const notDeployed = !(staged.data?.policy?.deployed ?? []).some(item => item?.id === 49016)
      const discarded = typeof staged.data?.revision === 'string'
        ? await root.post('/api/server/sec/waf-rules/discard', { expectedRevision: staged.data.revision })
        : { status: 0 }
      if (typeof discarded.data?.revision === 'string' && !same(discarded.data?.policy, origPolicy)) {
        await root.put('/api/server/sec/waf-rules', { policy: origPolicy, expectedRevision: discarded.data.revision })
      }
      check('STAGED-RULE-KEPT-OUT-OF-DEPLOYED', staged.status === 200 && hasStaged && notDeployed && discarded.status === 200, {
        stagedStatus: staged.status, hasStaged, notDeployed, discardStatus: discarded.status,
      })
    },
  }),

  tool('waf-vendors', {
    prefix: 'S14T17', as: 'root', probe: '/api/server/sec/waf-vendors',
    page: { route: '/whm/security/waf', read: '/api/server/sec/waf-vendors', shows: () => ['Web application firewall'] },
    paths: /^\/api\/server\/sec\/waf-vendors(?:\/(?:preview|remove))?$/, requests: 20,
    unit: [{ id: 'S14T17-UNIT-1', file: 'apps/api/src/svc-waf-workspace.test.ts', name: 'WAF vendors admits a vendor only through install, which the host verifies, and switches stay editable' }],
    checks: ['WAF-VENDORS-READ', 'UNINSTALLED-VENDOR-PUT-REFUSED', 'HTTP-VENDOR-PREVIEW-REFUSED', 'ABSENT-VENDOR-REMOVE-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/sec/waf-vendors')
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      check('WAF-VENDORS-READ', view.status === 200 && Array.isArray(view.data?.policy?.crsDisabledFiles) && Array.isArray(view.data?.policy?.vendors), {
        status: view.status,
      })
      refused('UNINSTALLED-VENDOR-PUT-REFUSED', await root.put('/api/server/sec/waf-vendors', {
        policy: {
          crsDisabledFiles: [],
          vendors: [{ id: 'fakevendor', name: 'Fake', description: '', docsUrl: null, metadataUrl: 'https://example.test/meta.json', archiveSha256: 'a'.repeat(64), version: '1.0', enabled: true, autoUpdate: false, disabledFiles: [] }],
        },
        expectedRevision: rev,
      }), 'VALIDATION')
      refused('HTTP-VENDOR-PREVIEW-REFUSED', await root.post('/api/server/sec/waf-vendors/preview', {
        url: 'http://example.test/meta.json',
      }), 'VALIDATION')
      refused('ABSENT-VENDOR-REMOVE-NOT-FOUND', await root.post('/api/server/sec/waf-vendors/remove', {
        id: 'absentvendor', expectedRevision: rev,
      }), 'NOT_FOUND')
    },
  }),

  tool('password-strength', {
    prefix: 'S14T18', as: 'root', needs: ['account'], probe: '/api/server/sec/sign-in',
    paths: /^\/api\/(?:server\/sec\/sign-in|service-users)$/, requests: 25,
    unit: [{ id: 'S14T18-UNIT-1', file: 'apps/api/src/password-policy.test.ts', name: 'password policy requires the saved strength of each service, falling back to the default' }],
    checks: ['OUT-OF-RANGE-STRENGTH-REFUSED', 'ROUNDED-STRENGTH-ENFORCES-MAILBOX'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const before = await root.get('/api/server/sec/sign-in')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy
      const fallbackPolicy = origPolicy ?? {
        lockout: {
          username: { attempts: 5, windowMin: 15, durationMin: 15 },
          ip: { attempts: 10, windowMin: 15, durationMin: 15 },
          ipAllow: [],
          ipDeny: [],
        },
        passwordStrength: { default: 50, perService: { panel: null, mail: null, ftp: null, database: null, webdisk: null, directory: null } },
        session: { idleMin: 15, absoluteHours: 12 },
      }
      refused('OUT-OF-RANGE-STRENGTH-REFUSED', await root.put('/api/server/sec/sign-in', {
        policy: { ...fallbackPolicy, passwordStrength: { ...fallbackPolicy.passwordStrength, default: 105 } },
        expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status !== 200 || !origPolicy || typeof before.data?.revision !== 'string') {
        check('ROUNDED-STRENGTH-ENFORCES-MAILBOX', false, { status: before.status })
        return
      }
      undo('strength policy', async () => {
        const now = await root.get('/api/server/sec/sign-in')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/sec/sign-in', { policy: origPolicy, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/sec/sign-in', {
        policy: {
          ...origPolicy,
          passwordStrength: {
            ...origPolicy.passwordStrength,
            perService: { ...origPolicy.passwordStrength?.perService, mail: 42 },
          },
        },
        expectedRevision: rev,
      })
      const weakMbx = await root.post('/api/service-users', {
        accountId: fixture.accountId,
        login: `weak-${tag}@${fixture.domain}`,
        password: 'aaaaaaaa',
        services: { email: true, ftp: false, webdisk: false },
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/sign-in', { policy: origPolicy, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('ROUNDED-STRENGTH-ENFORCES-MAILBOX', saved.status === 200 && saved.data?.policy?.passwordStrength?.perService?.mail === 45 && weakMbx.status === 422 && weakMbx.data?.code === 'VALIDATION' && restored.status === 200, {
        savedStatus: saved.status, roundedMail: saved.data?.policy?.passwordStrength?.perService?.mail ?? null, weakStatus: weakMbx.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('security-questions', {
    prefix: 'S14T19', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/server/sec/security-questions',
    paths: /^\/api\/(?:server\/sec\/security-questions(?:\/reset)?|auth\/security-questions(?:\/addresses)?)$/, requests: 25,
    unit: [{ id: 'S14T19-UNIT-1', file: 'apps/api/src/security-questions.test.ts', name: 'security question rules normalises answers and accepts only bounded, distinct sets' }],
    checks: ['SINGLE-QUESTION-REFUSED', 'INVALID-TRUSTED-IP-REFUSED', 'UNKNOWN-RESET-USER-NOT-FOUND', 'OWNER-QUESTIONS-ENROLLED-AND-RESET'],
    async run({ root, owner, fixture, check, refused, undo }) {
      refused('SINGLE-QUESTION-REFUSED', await owner.put('/api/auth/security-questions', {
        currentPassword: 'ignored',
        questions: [{ question: 'What was your very first pet?', answer: 'Rex' }],
      }), 'VALIDATION')
      refused('INVALID-TRUSTED-IP-REFUSED', await owner.post('/api/auth/security-questions/addresses', {
        action: 'add', address: 'not-an-ip',
      }), 'VALIDATION')
      refused('UNKNOWN-RESET-USER-NOT-FOUND', await root.post('/api/server/sec/security-questions/reset', {
        username: 'nosuchuser99',
      }), 'NOT_FOUND')
      undo('owner security questions', async () => [200, 404].includes((await root.post('/api/server/sec/security-questions/reset', {
        username: fixture.username,
      })).status))
      const enrolled = await owner.put('/api/auth/security-questions', {
        currentPassword: fixture.password,
        questions: [
          { question: 'What street did you grow up on?', answer: 'Cedar Lane' },
          { question: 'What was your childhood nickname?', answer: 'Sparrow' },
        ],
      })
      const reset = await root.post('/api/server/sec/security-questions/reset', { username: fixture.username })
      check('OWNER-QUESTIONS-ENROLLED-AND-RESET', enrolled.status === 200 && Array.isArray(enrolled.data?.questions) && enrolled.data.questions.length === 2 && reset.status === 200 && reset.data?.removed === 2, {
        enrolledStatus: enrolled.status, resetStatus: reset.status, removed: reset.data?.removed ?? null,
      })
    },
  }),

  tool('fork-bomb-protection', {
    prefix: 'S14T20', as: 'root', probe: '/api/server/sec/fork-bomb',
    paths: /^\/api\/server\/sec\/fork-bomb$/, requests: 20,
    unit: [{ id: 'S14T20-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'host access tools renders fork bomb limits per shell user and refuses to claim them without pam_limits' }],
    checks: ['NON-BOOLEAN-FORK-BOMB-REFUSED', 'STALE-FORK-BOMB-CONFLICT', 'FORK-BOMB-TOGGLED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/sec/fork-bomb')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origEnabled = Boolean(before.data?.policy?.enabled)
      refused('NON-BOOLEAN-FORK-BOMB-REFUSED', await root.put('/api/server/sec/fork-bomb', {
        policy: { enabled: 'yes' }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-FORK-BOMB-CONFLICT', await root.put('/api/server/sec/fork-bomb', {
        policy: { enabled: origEnabled }, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('FORK-BOMB-TOGGLED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('fork bomb policy', async () => {
        const now = await root.get('/api/server/sec/fork-bomb')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.policy?.enabled === origEnabled) return true
        return (await root.put('/api/server/sec/fork-bomb', { policy: { enabled: origEnabled }, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/sec/fork-bomb', {
        policy: { enabled: !origEnabled }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/fork-bomb', { policy: { enabled: origEnabled }, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('FORK-BOMB-TOGGLED-AND-RESTORED', saved.status === 200 && saved.data?.policy?.enabled === !origEnabled && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('smtp-restrictions', {
    prefix: 'S14T21', as: 'root', probe: '/api/server/sec/smtp-restrictions',
    paths: /^\/api\/server\/sec\/smtp-restrictions$/, requests: 20,
    unit: [{ id: 'S14T21-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'host access tools reports the SMTP rule from the kernel, not from the saved switch' }],
    checks: ['WRONG-SMTP-POLICY-KEY-REFUSED', 'STALE-SMTP-POLICY-CONFLICT', 'SMTP-RESTRICTIONS-TOGGLED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/sec/smtp-restrictions')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origEnabled = Boolean(before.data?.policy?.enabled)
      refused('WRONG-SMTP-POLICY-KEY-REFUSED', await root.put('/api/server/sec/smtp-restrictions', {
        policy: { allowed: true }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-SMTP-POLICY-CONFLICT', await root.put('/api/server/sec/smtp-restrictions', {
        policy: { enabled: origEnabled }, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('SMTP-RESTRICTIONS-TOGGLED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('smtp restrictions policy', async () => {
        const now = await root.get('/api/server/sec/smtp-restrictions')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.policy?.enabled === origEnabled) return true
        return (await root.put('/api/server/sec/smtp-restrictions', { policy: { enabled: origEnabled }, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/sec/smtp-restrictions', {
        policy: { enabled: !origEnabled }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/smtp-restrictions', { policy: { enabled: origEnabled }, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('SMTP-RESTRICTIONS-TOGGLED-AND-RESTORED', saved.status === 200 && saved.data?.policy?.enabled === !origEnabled && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('traceroute-toggle', {
    prefix: 'S14T22', as: 'root', probe: '/api/server/sec/traceroute',
    paths: /^\/api\/server\/sec\/traceroute$/, requests: 20,
    unit: [{ id: 'S14T22-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'host access tools shows a mode changed behind the panel as drift' }],
    checks: ['WRONG-TRACEROUTE-KEY-REFUSED', 'STALE-TRACEROUTE-CONFLICT', 'TRACEROUTE-POLICY-TOGGLED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/sec/traceroute')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origAllowed = Boolean(before.data?.policy?.allowed)
      refused('WRONG-TRACEROUTE-KEY-REFUSED', await root.put('/api/server/sec/traceroute', {
        policy: { enabled: true }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-TRACEROUTE-CONFLICT', await root.put('/api/server/sec/traceroute', {
        policy: { allowed: origAllowed }, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('TRACEROUTE-POLICY-TOGGLED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('traceroute policy', async () => {
        const now = await root.get('/api/server/sec/traceroute')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.policy?.allowed === origAllowed) return true
        return (await root.put('/api/server/sec/traceroute', { policy: { allowed: origAllowed }, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/sec/traceroute', {
        policy: { allowed: !origAllowed }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/sec/traceroute', { policy: { allowed: origAllowed }, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('TRACEROUTE-POLICY-TOGGLED-AND-RESTORED', saved.status === 200 && saved.data?.policy?.allowed === !origAllowed && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('system-mail-forwarding', {
    prefix: 'S14T23', as: 'root', probe: '/api/server/system-mail',
    page: { route: '/whm/panel/notifications', read: '/api/server/system-mail', shows: () => ['Notifications'] },
    paths: /^\/api\/server\/system-mail$/, requests: 25,
    unit: [{ id: 'S14T23-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations validates and saves system mail, panel TLS, the schedule and update preferences' }],
    checks: ['UNKNOWN-LOCAL-FORWARD-REFUSED', 'MALFORMED-FORWARD-REFUSED', 'STALE-SYSTEM-MAIL-CONFLICT', 'SYSTEM-MAIL-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/system-mail')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origForwards = before.data?.forwards ?? { root: null, nobody: null, xpanel: null }
      refused('UNKNOWN-LOCAL-FORWARD-REFUSED', await root.put('/api/server/system-mail', {
        forwards: { root: 'nosuchaccount99', nobody: null, xpanel: null }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('MALFORMED-FORWARD-REFUSED', await root.put('/api/server/system-mail', {
        forwards: { root: 'bad@@example.net', nobody: null, xpanel: null }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-SYSTEM-MAIL-CONFLICT', await root.put('/api/server/system-mail', {
        forwards: origForwards, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('SYSTEM-MAIL-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('system mail forwards', async () => {
        const now = await root.get('/api/server/system-mail')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.forwards, origForwards)) return true
        return (await root.put('/api/server/system-mail', { forwards: origForwards, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/server/system-mail', {
        forwards: { ...origForwards, root: 'ops@example.net' }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/system-mail', { forwards: origForwards, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('SYSTEM-MAIL-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.forwards?.root === 'ops@example.net' && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('restart-mailing-lists', {
    prefix: 'S14T24', as: 'root', needs: ['account'], probe: '/api/server/mailing-lists',
    paths: new RegExp(String.raw`^\/api\/(?:server\/mailing-lists(?:\?x=1|\/restart)?|mail\/mailing-lists(?:\/${ID})?)$`), requests: 25,
    unit: [{ id: 'S14T24-UNIT-1', file: 'apps/api/src/mail/mailing-list-admin.test.ts', name: 'mailing list administrator password refuses a restart with no saved list and without the host agent' }],
    checks: ['MAILING-LISTS-SELECTOR-REFUSED', 'EMPTY-LISTS-PRECONDITION', 'MAILING-LIST-CREATED-AND-RESTARTED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      refused('MAILING-LISTS-SELECTOR-REFUSED', await root.get('/api/server/mailing-lists?x=1'), 'VALIDATION')
      const initial = await root.get('/api/server/mailing-lists')
      const initialLists = Array.isArray(initial.data?.lists) ? initial.data.lists : null
      if (initial.status === 200 && initialLists && initialLists.length === 0) {
        refused('EMPTY-LISTS-PRECONDITION', await root.post('/api/server/mailing-lists/restart', {}), 'PRECONDITION_FAILED')
      } else {
        const r = await root.post('/api/server/mailing-lists/restart', {})
        check('EMPTY-LISTS-PRECONDITION', initial.status === 200 && Array.isArray(initialLists) && initialLists.length > 0 && r.status === 200, {
          initialCount: initialLists?.length ?? null, status: r.status,
        })
      }
      const created = await root.post('/api/mail/mailing-lists', {
        accountId: fixture.accountId, name: `xq-${tag}`, domain: fixture.domain, members: [],
      })
      const listId = created.data?.mailingList?.id
      if (typeof listId === 'string') {
        undo('mailing list', async () => [200, 404].includes((await root.delete(`/api/mail/mailing-lists/${listId}`)).status))
      }
      const restarted = typeof listId === 'string'
        ? await root.post('/api/server/mailing-lists/restart', {})
        : { status: 0, data: null }
      if (typeof listId === 'string') await root.delete(`/api/mail/mailing-lists/${listId}`)
      check('MAILING-LIST-CREATED-AND-RESTARTED', created.status === 201 && restarted.status === 200 && restarted.data?.service?.id === 'postfix', {
        createdStatus: created.status, restartStatus: restarted.status, serviceState: restarted.data?.service?.state ?? null,
      })
    },
  }),

  tool('restart-ssh', {
    prefix: 'S14T25', as: 'root', probe: '/api/server/services',
    paths: /^\/api\/server\/(?:services(?:\/unknown-daemon\/restart)?|service-manager(?:\/action)?)$/, requests: 20,
    unit: [{ id: 'S14T25-UNIT-1', file: 'apps/agent/src/service-manager.test.ts', name: 'isolated boot changes and jobs requires config test first, then fresh authorization before restart, and verifies active readback' }],
    checks: ['SSH-SERVICE-OBSERVED', 'UNKNOWN-DAEMON-NOT-FOUND', 'DISABLE-SSH-FORBIDDEN', 'STALE-SERVICE-MANAGER-CONFLICT'],
    async run({ root, check, refused }) {
      const [services, sm] = await Promise.all([
        root.get('/api/server/services'),
        root.get('/api/server/service-manager'),
      ])
      const sshRow = (services.data?.services ?? []).find(item => item?.id === 'ssh')
      const sshUnit = typeof sshRow?.unit === 'string' ? sshRow.unit : 'ssh.service'
      const smRev = typeof sm.data?.revision === 'string' ? sm.data.revision : ZERO_REV
      check('SSH-SERVICE-OBSERVED', services.status === 200 && Boolean(sshRow) && sm.status === 200, {
        servicesStatus: services.status, smStatus: sm.status, sshState: sshRow?.state ?? null,
      })
      refused('UNKNOWN-DAEMON-NOT-FOUND', await root.post('/api/server/services/unknown-daemon/restart', {}), 'NOT_FOUND')
      refused('DISABLE-SSH-FORBIDDEN', await root.post('/api/server/service-manager/action', {
        action: 'disable', unit: sshUnit, expectedRevision: smRev,
      }), 'FORBIDDEN')
      refused('STALE-SERVICE-MANAGER-CONFLICT', await root.post('/api/server/service-manager/action', {
        action: 'restart', unit: sshUnit, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
    },
  }),

  tool('hostname-a-record', {
    prefix: 'S14T26', as: 'root', probe: '/api/dns/zones',
    paths: new RegExp(String.raw`^\/api\/(?:dns\/zones(?:\/${ID})?|server\/dns-ops\/hostname-a-record(?:\?ip=192\.0\.2\.10)?)$`), requests: 25,
    unit: [{ id: 'S14T26-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations creates a hostname zone with its A record when no parent zone exists, and uses the parent otherwise' }],
    checks: ['IPV6-HOSTNAME-RECORD-REFUSED', 'EXTRA-FIELD-REFUSED', 'SELECTOR-QUERY-REFUSED', 'HOSTNAME-A-RECORD-ENSURED'],
    async run({ root, check, refused, undo }) {
      refused('IPV6-HOSTNAME-RECORD-REFUSED', await root.post('/api/server/dns-ops/hostname-a-record', { ip: '2001:db8::1' }), 'VALIDATION')
      refused('EXTRA-FIELD-REFUSED', await root.post('/api/server/dns-ops/hostname-a-record', { ip: '192.0.2.10', ttl: 300 }), 'VALIDATION')
      refused('SELECTOR-QUERY-REFUSED', await root.post('/api/server/dns-ops/hostname-a-record?ip=192.0.2.10', {}), 'VALIDATION')
      const beforeZones = await root.get('/api/dns/zones')
      const beforeIds = new Set((beforeZones.data?.zones ?? []).map(z => z?.id).filter(Boolean))
      const ensured = await root.post('/api/server/dns-ops/hostname-a-record', {})
      if (ensured.status === 200 && ensured.data?.created === true) {
        const afterZones = await root.get('/api/dns/zones')
        const createdZone = (afterZones.data?.zones ?? []).find(z => z?.id && !beforeIds.has(z.id))
        if (createdZone?.id) {
          undo('created hostname zone', async () => [200, 404].includes((await root.delete(`/api/dns/zones/${createdZone.id}`)).status))
          await root.delete(`/api/dns/zones/${createdZone.id}`)
        }
      }
      check('HOSTNAME-A-RECORD-ENSURED', ensured.status === 200 && typeof ensured.data?.hostname === 'string' && typeof ensured.data?.ip === 'string' && typeof ensured.data?.zone === 'string', {
        status: ensured.status, zone: ensured.data?.zone ?? null, created: ensured.data?.created ?? null,
      })
    },
  }),

  tool('xwhm-email-routing', {
    prefix: 'S14T27', as: 'root', needs: ['account'], probe: '/api/server/mailx/routing',
    paths: /^\/api\/server\/mailx\/routing(?:\/preview)?$/, requests: 25,
    unit: [{ id: 'S14T27-UNIT-1', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server settings and routing policy refuses invalid values by field, unusable certificates and domains not hosted here, before any write' }],
    checks: ['UNHOSTED-ROUTING-DOMAIN-REFUSED', 'INVALID-ROUTING-MODE-REFUSED', 'ROUTING-PREVIEW-AND-ROUNDTRIP'],
    async run({ root, fixture, check, refused, undo }) {
      const before = await root.get('/api/server/mailx/routing')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy ?? { domains: [] }
      refused('UNHOSTED-ROUTING-DOMAIN-REFUSED', await root.put('/api/server/mailx/routing', {
        policy: { domains: [{ domain: 'unhosted-nowhere.example', mode: 'remote' }] }, expectedRevision: rev,
      }), 'VALIDATION')
      refused('INVALID-ROUTING-MODE-REFUSED', await root.put('/api/server/mailx/routing', {
        policy: { domains: [{ domain: fixture.domain, mode: 'local' }] }, expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('ROUTING-PREVIEW-AND-ROUNDTRIP', false, { status: before.status })
        return
      }
      undo('mailx routing policy', async () => {
        const now = await root.get('/api/server/mailx/routing')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/mailx/routing', { policy: origPolicy, expectedRevision: now.data.revision })).status === 200
      })
      const nextDomains = [...(origPolicy.domains ?? []).filter(d => d?.domain !== fixture.domain), { domain: fixture.domain, mode: 'remote' }]
      const preview = await root.post('/api/server/mailx/routing/preview', {
        policy: { domains: nextDomains }, expectedRevision: rev,
      })
      const saved = await root.put('/api/server/mailx/routing', {
        policy: { domains: nextDomains }, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/mailx/routing', { policy: origPolicy, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('ROUTING-PREVIEW-AND-ROUNDTRIP', preview.status === 200 && Array.isArray(preview.data?.changes) && saved.status === 200 && restored.status === 200, {
        previewStatus: preview.status, savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('park-domain', {
    prefix: 'S14T28', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/domains',
    paths: new RegExp(String.raw`^\/api\/domains(?:\?accountId=${ID}&workspace=1|\/${ID})?$`), requests: 25,
    unit: [{ id: 'S14T28-UNIT-1', file: 'packages/core/src/tweaks/domains.test.ts', name: 'Tweak Settings: Domains refuses hostname subdomains, cross-account subdomains and common domains for users only' }],
    checks: ['COMMON-DOMAIN-PARK-FORBIDDEN', 'ALIAS-CUSTOM-DOCROOT-REFUSED', 'PARKED-ALIAS-CREATED-AND-REMOVED'],
    async run({ root, owner, fixture, tag, check, refused, undo }) {
      const ws = await root.get(`/api/domains?accountId=${fixture.accountId}&workspace=1`)
      const rev = typeof ws.data?.revision === 'string' ? ws.data.revision : ZERO_REV
      const primary = (ws.data?.domains ?? []).find(item => item?.name === fixture.domain)
      const parentId = primary?.id ?? ZERO_UUID
      refused('COMMON-DOMAIN-PARK-FORBIDDEN', await owner.post('/api/domains', {
        name: 'google.com', kind: 'alias', parentId, expectedRevision: rev,
      }), 'FORBIDDEN')
      refused('ALIAS-CUSTOM-DOCROOT-REFUSED', await root.post('/api/domains', {
        accountId: fixture.accountId, name: `bad-${tag}.example.test`, kind: 'alias', parentId, docRoot: 'custom', expectedRevision: rev,
      }), 'VALIDATION')
      if (ws.status !== 200 || !primary?.id || typeof ws.data?.revision !== 'string') {
        check('PARKED-ALIAS-CREATED-AND-REMOVED', false, { status: ws.status })
        return
      }
      const aliasName = `park-${tag}.example.test`
      const parked = await root.post('/api/domains', {
        accountId: fixture.accountId, name: aliasName, kind: 'alias', parentId: primary.id, expectedRevision: rev,
      })
      const aliasId = parked.data?.domain?.id
      if (typeof aliasId === 'string') {
        undo('parked alias domain', async () => {
          const cur = await root.get(`/api/domains?accountId=${fixture.accountId}&workspace=1`)
          if (!(cur.data?.domains ?? []).some(d => d?.id === aliasId)) return true
          return [200, 404].includes((await root.delete(`/api/domains/${aliasId}`, {
            confirmName: aliasName, expectedRevision: cur.data?.revision,
          })).status)
        })
      }
      const removed = typeof aliasId === 'string' && typeof parked.data?.revision === 'string'
        ? await root.delete(`/api/domains/${aliasId}`, { confirmName: aliasName, expectedRevision: parked.data.revision })
        : { status: 0 }
      check('PARKED-ALIAS-CREATED-AND-REMOVED', parked.status === 201 && parked.data?.domain?.kind === 'alias' && parked.data?.domain?.docRoot === primary.docRoot && removed.status === 200, {
        parkedStatus: parked.status, removedStatus: removed.status,
      })
    },
  }),

  tool('dns-config-cleanup', {
    prefix: 'S14T29', as: 'root', probe: '/api/server/dns-ops/cleanup',
    paths: /^\/api\/server\/dns-ops\/cleanup(?:\?(?:zone=example\.com|force=1))?$/, requests: 15,
    unit: [{ id: 'S14T29-UNIT-1', file: 'apps/agent/src/server-operations.test.ts', name: 'server operations on the host cleans the catalog back to the reconciler rendering and reloads PowerDNS' }],
    checks: ['CLEANUP-SELECTOR-REFUSED', 'CLEANUP-PUT-METHOD-REFUSED', 'DNS-CATALOG-INSPECTED-AND-CLEANED'],
    async run({ root, check, refused }) {
      refused('CLEANUP-SELECTOR-REFUSED', await root.get('/api/server/dns-ops/cleanup?zone=example.com'), 'VALIDATION')
      refused('CLEANUP-PUT-METHOD-REFUSED', await root.put('/api/server/dns-ops/cleanup', {}), 405)
      const inspect = await root.get('/api/server/dns-ops/cleanup')
      const cleaned = await root.post('/api/server/dns-ops/cleanup', {})
      check('DNS-CATALOG-INSPECTED-AND-CLEANED', inspect.status === 200 && Array.isArray(inspect.data?.duplicates) && cleaned.status === 200 && Array.isArray(cleaned.data?.after?.duplicates) && cleaned.data.after.duplicates.length === 0, {
        inspectStatus: inspect.status, cleanStatus: cleaned.status, cleanedCount: cleaned.data?.cleaned ?? null,
      })
    },
  }),

  tool('domain-forwarding', {
    prefix: 'S14T30', as: 'root', needs: ['account'], probe: '/api/server/domain-forwards',
    paths: /^\/api\/server\/domain-forwards(?:\/[a-z0-9.-]+)?$/, requests: 25,
    unit: [{ id: 'S14T30-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations refuses a forward without a free pool address' }],
    checks: ['NON-HTTP-FORWARD-REFUSED', 'HOSTED-DOMAIN-FORWARD-CONFLICT', 'ABSENT-FORWARD-DELETE-NOT-FOUND', 'FORWARD-POOL-IP-CONTRACT'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const before = await root.get('/api/server/domain-forwards')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const fwdDomain = `fwd-${tag}.example.test`
      refused('NON-HTTP-FORWARD-REFUSED', await root.post('/api/server/domain-forwards', {
        domain: fwdDomain, url: 'ftp://example.net/', expectedRevision: rev,
      }), 'VALIDATION')
      refused('HOSTED-DOMAIN-FORWARD-CONFLICT', await root.post('/api/server/domain-forwards', {
        domain: fixture.domain, url: 'https://example.net/', expectedRevision: rev,
      }), 'CONFLICT')
      refused('ABSENT-FORWARD-DELETE-NOT-FOUND', await root.delete(`/api/server/domain-forwards/missing-${tag}.example.test`, {
        expectedRevision: rev,
      }), 'NOT_FOUND')
      const attempt = await root.post('/api/server/domain-forwards', {
        domain: fwdDomain, url: 'https://example.net/', expectedRevision: rev,
      })
      if (attempt.status === 201) {
        undo('domain forward', async () => {
          const cur = await root.get('/api/server/domain-forwards')
          if (!(cur.data?.forwards ?? []).some(f => f?.domain === fwdDomain)) return true
          return [200, 404].includes((await root.delete(`/api/server/domain-forwards/${fwdDomain}`, {
            expectedRevision: cur.data?.revision,
          })).status)
        })
        const del = await root.delete(`/api/server/domain-forwards/${fwdDomain}`, {
          expectedRevision: attempt.data?.revision ?? rev,
        })
        check('FORWARD-POOL-IP-CONTRACT', Boolean(attempt.data?.forward?.ip) && del.status === 200, {
          status: attempt.status, deletedStatus: del.status,
        })
      } else {
        check('FORWARD-POOL-IP-CONTRACT', attempt.status === 412 && attempt.data?.code === 'PRECONDITION_FAILED', {
          status: attempt.status, code: attempt.data?.code ?? null,
        })
      }
    },
  }),

  tool('db-access-hosts', {
    prefix: 'S14T31', as: 'root', restores: ['/api/server/databases/access-hosts'], probe: '/api/server/databases/access-hosts',
    paths: /^\/api\/server\/databases\/access-hosts(?:\/push)?$/, requests: 25,
    unit: [{ id: 'S14T31-UNIT-1', file: 'apps/api/src/whm-db-tools-workspace.test.ts', name: 'Additional access hosts refuses a name, saves addresses and pushes only the saved list' }],
    checks: ['DNS-HOSTNAME-REFUSED', 'WILDCARD-CIDR-REFUSED', 'STALE-ACCESS-HOSTS-CONFLICT', 'ACCESS-HOST-SAVED-AND-RESTORED'],
    async run({ root, tag, check, refused, undo }) {
      const before = await root.get('/api/server/databases/access-hosts')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origHosts = Array.isArray(before.data?.hosts)
        ? before.data.hosts.map(({ host, comment }) => ({ host, comment }))
        : null
      refused('DNS-HOSTNAME-REFUSED', await root.put('/api/server/databases/access-hosts', {
        hosts: [{ host: 'DB.Example.com', comment: 'bad' }], expectedRevision: rev,
      }), 'VALIDATION')
      refused('WILDCARD-CIDR-REFUSED', await root.put('/api/server/databases/access-hosts', {
        hosts: [{ host: '0.0.0.0/0', comment: '' }], expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-ACCESS-HOSTS-CONFLICT', await root.put('/api/server/databases/access-hosts', {
        hosts: origHosts ?? [], expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      if (before.status !== 200 || !origHosts || typeof before.data?.revision !== 'string') {
        check('ACCESS-HOST-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('database access hosts', async () => {
        const now = await root.get('/api/server/databases/access-hosts')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        const cur = (now.data?.hosts ?? []).map(({ host, comment }) => ({ host, comment }))
        if (same(cur, origHosts)) return true
        return (await root.put('/api/server/databases/access-hosts', { hosts: origHosts, expectedRevision: now.data.revision })).status === 200
      })
      const nextHosts = [...origHosts.filter(h => h.host !== '203.0.113.231'), { host: '203.0.113.231', comment: `xq-${tag}` }]
      const saved = await root.put('/api/server/databases/access-hosts', {
        hosts: nextHosts, expectedRevision: rev,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/databases/access-hosts', { hosts: origHosts, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('ACCESS-HOST-SAVED-AND-RESTORED', saved.status === 200 && (saved.data?.hosts ?? []).some(h => h?.host === '203.0.113.231') && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('postgresql-setup', {
    prefix: 'S14T32', as: 'root', probe: '/api/server/databases/postgresql',
    paths: /^\/api\/server\/databases\/postgresql(?:\?x=1|\/(?:roles|superuser-password))?$/, requests: 20,
    unit: [{ id: 'S14T32-UNIT-1', file: 'apps/api/src/whm-db-tools-workspace.test.ts', name: 'Configure PostgreSQL creates the missing role once, without a known password, and reconciles once' }],
    checks: ['POSTGRESQL-STATUS-READ', 'POSTGRESQL-SELECTOR-REFUSED', 'SHORT-SUPERUSER-CREDENTIAL-REFUSED', 'EXTRA-SUPERUSER-FIELD-REFUSED'],
    async run({ root, check, refused }) {
      const status = await root.get('/api/server/databases/postgresql')
      check('POSTGRESQL-STATUS-READ', status.status === 200 && typeof status.data?.installed === 'boolean' && status.data?.clientFile === '/root/.pgpass', {
        status: status.status, installed: status.data?.installed ?? null, running: status.data?.running ?? null,
      })
      refused('POSTGRESQL-SELECTOR-REFUSED', await root.get('/api/server/databases/postgresql?x=1'), 'VALIDATION')
      refused('SHORT-SUPERUSER-CREDENTIAL-REFUSED', await root.post('/api/server/databases/postgresql/superuser-password', {
        password: 'short',
      }), 'VALIDATION')
      refused('EXTRA-SUPERUSER-FIELD-REFUSED', await root.post('/api/server/databases/postgresql/superuser-password', {
        password: 'Xq9!ValidSuperuserPhrase#2026', confirm: 'extra',
      }), 'VALIDATION')
    },
  }),

  tool('db-ownership-map', {
    prefix: 'S14T33', as: 'root', needs: ['account'], probe: '/api/server/databases/overview',
    paths: new RegExp(String.raw`^\/api\/(?:server\/databases\/(?:overview|ownership)|databases(?:\/${ID}(?:\/trash)?)?)$`), requests: 25,
    unit: [{ id: 'S14T33-UNIT-1', file: 'apps/api/src/whm-db-tools-workspace.test.ts', name: 'Database Map Tool assigns a server-only database and reconciles once' }],
    checks: ['EMPTY-OWNERSHIP-MAP-REFUSED', 'UNPREFIXED-OWNERSHIP-REFUSED', 'UNOBSERVED-DATABASE-NOT-FOUND', 'ALREADY-OWNED-DATABASE-CONFLICT'],
    async run({ root, fixture, tag, check, refused, undo }) {
      refused('EMPTY-OWNERSHIP-MAP-REFUSED', await root.post('/api/server/databases/ownership', {
        account: fixture.username, databases: [], users: [],
      }), 'VALIDATION')
      refused('UNPREFIXED-OWNERSHIP-REFUSED', await root.post('/api/server/databases/ownership', {
        account: fixture.username, databases: ['foreign_db'], users: [],
      }), 'VALIDATION')
      refused('UNOBSERVED-DATABASE-NOT-FOUND', await root.post('/api/server/databases/ownership', {
        account: fixture.username, databases: [`${fixture.username}_ghost_${tag.slice(0, 4)}`], users: [],
      }), 'NOT_FOUND')
      const dbName = `${fixture.username}_own_${tag.slice(0, 4)}`
      const created = await root.post('/api/databases', { accountId: fixture.accountId, name: dbName, engine: 'mariadb' })
      const dbId = created.data?.database?.id
      if (typeof dbId === 'string') {
        undo('ownership test database', async () => {
          await root.post(`/api/databases/${dbId}/trash`, {})
          return [200, 404].includes((await root.delete(`/api/databases/${dbId}`)).status)
        })
      }
      const remap = typeof dbId === 'string'
        ? await root.post('/api/server/databases/ownership', { account: fixture.username, databases: [dbName], users: [] })
        : { status: 0, data: null }
      if (typeof dbId === 'string') {
        await root.post(`/api/databases/${dbId}/trash`, {})
        await root.delete(`/api/databases/${dbId}`)
      }
      check('ALREADY-OWNED-DATABASE-CONFLICT', created.status === 201 && remap.status === 409 && remap.data?.code === 'CONFLICT', {
        createdStatus: created.status, remapStatus: remap.status, code: remap.data?.code ?? null,
      })
    },
  }),
]
