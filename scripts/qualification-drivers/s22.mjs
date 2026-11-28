import { tool } from './kit.mjs'

export default [
  tool('disk-quota-setup', {
    prefix: 'S22QTA',
    probe: '/api/setup/wizard',
    page: { route: '/whm/server/setup', read: '/api/setup/wizard' },
    paths: /^\/api\/(?:setup\/wizard|server\/quotas\/init)$/,
    unit: [
      { id: 'S22QTA-UNIT-1', file: 'apps/api/src/quota-status.test.ts', name: 'quota initialization requires a connected host port reports and audits the result of the connected agent' },
    ],
    checks: ['QUOTA-STATUS-READ', 'INVALID-FILESYSTEM-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/setup/wizard')
      check('QUOTA-STATUS-READ', read.status === 200 && typeof read.data?.quotaInitialized === 'boolean' && typeof read.data?.quotaInitialization === 'object', {
        status: read.status,
        quotaInitialized: read.data?.quotaInitialized ?? null,
      })
      refused('INVALID-FILESYSTEM-REFUSED', await root.post('/api/server/quotas/init', { filesystem: 'relative' }), 'VALIDATION')
    },
  }),

  tool('web-stack-builder', {
    prefix: 'S22WSTK',
    probe: '/api/server/web-stack',
    paths: /^\/api\/server\/web-stack(?:\/preview|\/apply)?$/,
    unit: [
      { id: 'S22WSTK-UNIT-1', file: 'apps/agent/src/web-stack-builder.test.ts', name: 'agent web-stack-builder fails closed with 409 CONFLICT when two MPMs are selected simultaneously' },
      { id: 'S22WSTK-UNIT-2', file: 'apps/api/src/whm-web-stack-routes.test.ts', name: 'WHM web-stack and OpenLiteSpeed API routes rejects multiple MPMs with 409 CONFLICT and non-isolated MPMs with 422 VALIDATION, while applying mpm_itk profiles with audit' },
    ],
    checks: ['STACK-PROFILE-READ', 'MULTI-MPM-CONFLICT-REFUSED', 'NON-ITK-MPM-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/web-stack')
      check('STACK-PROFILE-READ', read.status === 200 && typeof read.data?.activeEngine === 'string' && Array.isArray(read.data?.profiles), {
        status: read.status,
        activeEngine: read.data?.activeEngine ?? null,
      })
      refused('MULTI-MPM-CONFLICT-REFUSED', await root.post('/api/server/web-stack/preview', { engine: 'apache', mpms: ['mpm_itk', 'prefork'] }), 'CONFLICT')
      refused('NON-ITK-MPM-REFUSED', await root.post('/api/server/web-stack/preview', { engine: 'apache', mpms: ['prefork'] }), 'VALIDATION')
    },
  }),

  tool('aapanel-openlitespeed-manager', {
    prefix: 'S22OLS',
    probe: '/api/server/services/openlitespeed',
    paths: /^\/api\/server\/services\/openlitespeed(?:\/(?:action|config\/preview|config\/apply|config\/rollback))?$/,
    unit: [
      { id: 'S22OLS-UNIT-1', file: 'apps/agent/src/ols-manager.test.ts', name: 'agent ols-manager controls lshttpd service actions, applies config with backup, rolls back on restart failure, and supports explicit rollback' },
    ],
    checks: ['OLS-STATUS-READ', 'INVALID-ACTION-REFUSED', 'UNSAFE-CONFIG-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/services/openlitespeed')
      check('OLS-STATUS-READ', read.status === 200 && typeof read.data?.state === 'string', { status: read.status, state: read.data?.state ?? null })
      refused('INVALID-ACTION-REFUSED', await root.post('/api/server/services/openlitespeed/action', { action: 'invalid-action' }), ['VALIDATION', 'PRECONDITION_FAILED', 'SERVICE_UNAVAILABLE'])
      refused('UNSAFE-CONFIG-REFUSED', await root.post('/api/server/services/openlitespeed/config/preview', { text: 'include /etc/passwd\n' }), ['VALIDATION', 'PRECONDITION_FAILED', 'SERVICE_UNAVAILABLE'])
    },
  }),

  tool('database-tuning', {
    prefix: 'S22DBTN',
    probe: '/api/server/databases/tuning',
    paths: /^\/api\/server\/databases\/tuning(?:\/(?:preview|apply|rollback))?(?:\?unknown=1)?$/,
    unit: [
      { id: 'S22DBTN-UNIT-1', file: 'apps/api/src/database-tuning-workspace.test.ts', name: 'database tuning API routes root-only tuning preview, apply and rollback with validation, conflict forwarding and audit logs' },
    ],
    checks: ['TUNING-OBSERVATION-READ', 'QUERY-SELECTOR-REFUSED', 'EMPTY-PREVIEW-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/databases/tuning')
      check('TUNING-OBSERVATION-READ', read.status === 200 && ['read', 'partial', 'unavailable'].includes(read.data?.state) && typeof read.data?.dropIn === 'object', {
        status: read.status,
        state: read.data?.state ?? null,
      })
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/databases/tuning?unknown=1'), 'VALIDATION')
      refused('EMPTY-PREVIEW-REFUSED', await root.post('/api/server/databases/tuning/preview', { settings: {} }), 'VALIDATION')
    },
  }),

  tool('aapanel-mysql-service', {
    prefix: 'S22MYS',
    probe: '/api/server/databases/services/mysql',
    paths: /^\/api\/server\/databases\/services\/mysql(?:\/(?:control|settings|preview|config|log))?(?:\?unknown=1)?$/,
    unit: [
      { id: 'S22MYS-UNIT-1', file: 'apps/agent/src/db-mysql-service.test.ts', name: 'MariaDB/MySQL service controller reads live version, listen check, settings and redacted log tail' },
      { id: 'S22MYS-UNIT-2', file: 'apps/api/src/whm-db-services-workspace.test.ts', name: 'database service routes routes mysql reads, control, settings, config and non-audited preview to the agent' },
    ],
    checks: ['MYSQL-SERVICE-READ', 'QUERY-SELECTOR-REFUSED', 'INVALID-CONTROL-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/databases/services/mysql')
      check('MYSQL-SERVICE-READ', read.status === 200 && read.data?.engine === 'mysql' && typeof read.data?.files === 'object', {
        status: read.status,
        installed: read.data?.installed ?? null,
      })
      refused('QUERY-SELECTOR-REFUSED', await root.get('/api/server/databases/services/mysql?unknown=1'), 'VALIDATION')
      refused('INVALID-CONTROL-REFUSED', await root.post('/api/server/databases/services/mysql/control', { action: 'flush-hosts' }), ['VALIDATION', 'PRECONDITION_FAILED', 'SERVICE_UNAVAILABLE'])
    },
  }),

  tool('distro-packages', {
    prefix: 'S22DPKG',
    probe: '/api/server/software/distro-packages',
    paths: /^\/api\/server\/software\/distro-packages(?:\/(?:preview|apply))?$/,
    unit: [
      { id: 'S22DPKG-UNIT-1', file: 'apps/api/src/whm-app-installer-routes.test.ts', name: 'WHM distro packages, one-click deploy, and app installer routes reads, searches, previews and applies reviewed distro packages while rejecting unknown component IDs' },
    ],
    checks: ['DISTRO-CATALOG-READ', 'UNKNOWN-COMPONENT-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/software/distro-packages')
      check('DISTRO-CATALOG-READ', read.status === 200 && Array.isArray(read.data?.items), {
        status: read.status,
        items: read.data?.items?.length ?? null,
      })
      refused('UNKNOWN-COMPONENT-REFUSED', await root.post('/api/server/software/distro-packages/preview', { action: 'install', componentIds: ['unreviewed-arbitrary-pkg'] }), ['VALIDATION', 'PRECONDITION_FAILED'])
    },
  }),

  tool('aapanel-one-click-deploy', {
    prefix: 'S22OCD',
    probe: '/api/server/software/one-click',
    paths: /^\/api\/server\/software\/one-click(?:\/deploy)?$/,
    unit: [
      { id: 'S22OCD-UNIT-1', file: 'apps/api/src/whm-app-installer-routes.test.ts', name: 'WHM distro packages, one-click deploy, and app installer routes reads one-click targets and deploys reviewed apps only onto eligible active domain docRoots' },
    ],
    checks: ['ONE-CLICK-CATALOG-READ', 'INVALID-DEPLOY-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/software/one-click')
      check('ONE-CLICK-CATALOG-READ', read.status === 200 && Array.isArray(read.data?.apps) && Array.isArray(read.data?.targets), {
        status: read.status,
        targets: read.data?.targets?.length ?? null,
      })
      refused('INVALID-DEPLOY-REFUSED', await root.post('/api/server/software/one-click/deploy', { appId: 'invalid!app', domainId: 'not-a-uuid' }), 'VALIDATION')
    },
  }),

  tool('app-installer', {
    prefix: 'S22APP',
    probe: '/api/server/software/app-installer',
    paths: /^\/api\/server\/software\/app-installer(?:\/(?:install|remove))?$/,
    unit: [
      { id: 'S22APP-UNIT-1', file: 'apps/api/src/whm-app-installer-routes.test.ts', name: 'WHM distro packages, one-click deploy, and app installer routes reads app-installer catalog and instances, installs onto owned domain, and removes an instance' },
    ],
    checks: ['APP-INSTALLER-READ', 'INVALID-INSTALL-REFUSED'],
    async run({ root, check, refused }) {
      const read = await root.get('/api/server/software/app-installer')
      check('APP-INSTALLER-READ', read.status === 200 && Array.isArray(read.data?.apps) && Array.isArray(read.data?.instances), {
        status: read.status,
        instances: read.data?.instances?.length ?? null,
      })
      refused('INVALID-INSTALL-REFUSED', await root.post('/api/server/software/app-installer/install', { appId: '../bad', domainId: 'not-a-uuid' }), 'VALIDATION')
    },
  }),

  tool('aapanel-site-reverse-proxy', {
    prefix: 'S22SPR',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/domains/proxy-rules',
    paths: /^\/api\/account\/domains\/proxy-rules(?:\/[a-z0-9.-]+|\?domain=[a-z0-9.-]+)?$/,
    unit: [
      { id: 'S22SPR-UNIT-1', file: 'apps/api/src/account-proxy-projects-routes.test.ts', name: 'account path-scoped site reverse-proxy rules adds, updates and deletes path-scoped rules for owned domains with owned runtime loopback ports and audits each change' },
    ],
    checks: ['SITE-PROXY-RULES-READ', 'UNSAFE-UPSTREAM-REFUSED'],
    async run({ owner, fixture, check, refused }) {
      const read = await owner.get(`/api/account/domains/proxy-rules?domain=${encodeURIComponent(fixture.domain)}`)
      check('SITE-PROXY-RULES-READ', read.status === 200 && Array.isArray(read.data?.rules), {
        status: read.status,
        rules: read.data?.rules?.length ?? null,
      })
      refused('UNSAFE-UPSTREAM-REFUSED', await owner.post(`/api/account/domains/proxy-rules/${fixture.domain}`, {
        path: '/api',
        target: 'http://169.254.169.254/latest/meta-data',
        expectedRevision: read.data?.revision ?? '0'.repeat(64),
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-proxy-project', {
    prefix: 'S22PPROJ',
    as: 'owner',
    needs: ['account'],
    probe: '/api/account/proxy-projects',
    paths: /^\/api\/account\/proxy-projects(?:\/[0-9a-f-]+(?:\/rules)?)?$/,
    unit: [
      { id: 'S22PPROJ-UNIT-1', file: 'apps/api/src/account-proxy-projects-routes.test.ts', name: 'standalone proxy projects creates, updates, adds rules, enforces 409 LAST_PROXY_RULE on last rule delete, and deletes projects' },
    ],
    checks: ['PROXY-PROJECTS-READ', 'INVALID-PROJECT-REFUSED'],
    async run({ owner, check, refused }) {
      const read = await owner.get('/api/account/proxy-projects')
      check('PROXY-PROJECTS-READ', read.status === 200 && Array.isArray(read.data?.projects), {
        status: read.status,
        projects: read.data?.projects?.length ?? null,
      })
      refused('INVALID-PROJECT-REFUSED', await owner.post('/api/account/proxy-projects', { name: '', domains: [] }), 'VALIDATION')
    },
  }),
]
