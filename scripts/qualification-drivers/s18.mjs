import { tool } from './kit.mjs'

const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ZERO_REV = '0'.repeat(64)
const ZERO_HASH = '0'.repeat(64)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const uuidOrZero = value => (typeof value === 'string' && UUID_RE.test(value) ? value : ZERO_UUID)
const revOf = value => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : ZERO_REV)

export default [
  tool('mailbox-format-conversion', {
    prefix: 'S18T01', as: 'root', needs: ['account', 'mailbox'], probe: '/api/server/mail-maintenance',
    paths: /^\/api\/server\/mail-maintenance(?:\/jobs|\?mailbox=[A-Za-z0-9._%+-]+)?$/,
    unit: [{ id: 'S18T01-UNIT-1', file: 'apps/agent/src/mailbox-maintenance.test.ts', name: 'mailbox maintenance reads and plans lists only saved email-enabled mailboxes of live accounts' }],
    checks: ['MAILDIR-MAINTENANCE-LISTED', 'MAILBOX-SELECTOR-VALIDATION', 'MDBOX-OPERATION-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/mail-maintenance')
      const mailboxes = Array.isArray(view.data?.mailboxes) ? view.data.mailboxes : []
      check('MAILDIR-MAINTENANCE-LISTED', view.status === 200 && ['configured', 'not_configured', 'unavailable'].includes(view.data?.fts) && Array.isArray(view.data?.mailboxes), { status: view.status, fts: view.data?.fts ?? null, count: mailboxes.length })
      refused('MAILBOX-SELECTOR-VALIDATION', await root.get('/api/server/mail-maintenance?mailbox=not-an-address'), 'VALIDATION')
      const mbox = typeof fixture.mailbox === 'string' && fixture.mailbox.includes('@') ? fixture.mailbox : 'alice@example.test'
      refused('MDBOX-OPERATION-VALIDATION', await root.post('/api/server/mail-maintenance/jobs', { operation: 'convert-mdbox', mailboxes: [mbox] }), 'VALIDATION')
    },
  }),

  tool('repair-mailbox-permissions', {
    prefix: 'S18T02', as: 'root', needs: ['account', 'mailbox'], probe: '/api/server/mail-maintenance',
    paths: /^\/api\/server\/mail-maintenance(?:\/repair)?$/,
    unit: [{ id: 'S18T02-UNIT-1', file: 'apps/agent/src/mailbox-maintenance-routes.test.ts', name: 'agent mailbox maintenance routes validates methods, selectors and strict bodies before any host read' }],
    checks: ['MAINTENANCE-VIEW-OBSERVED', 'REPAIR-JOB-SUBMITTED', 'INVALID-ACCOUNTS-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/mail-maintenance')
      check('MAINTENANCE-VIEW-OBSERVED', view.status === 200 && Array.isArray(view.data?.mailboxes), { status: view.status, jobsAvailable: view.data?.jobsAvailable ?? null })
      const username = typeof fixture.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(fixture.username) ? fixture.username : 'xqacct'
      const repair = await root.post('/api/server/mail-maintenance/repair', { accounts: [username] })
      check('REPAIR-JOB-SUBMITTED', repair.status === 202 && Array.isArray(repair.data?.jobs) && typeof repair.data?.accounts === 'number', { status: repair.status, jobs: Array.isArray(repair.data?.jobs) ? repair.data.jobs.length : null })
      refused('INVALID-ACCOUNTS-VALIDATION', await root.post('/api/server/mail-maintenance/repair', { accounts: 'invalid' }), 'VALIDATION')
    },
  }),

  tool('spam-daemon-startup', {
    prefix: 'S18T03', as: 'root', probe: '/api/server/mailx/spamd',
    page: { route: '/whm/email/spam', read: '/api/server/mailx/spamd', shows: () => ['Inbound spam protection'] },
    paths: /^\/api\/server\/mailx\/spamd$/,
    unit: [{ id: 'S18T03-UNIT-1', file: 'apps/web/src/themes/v2/pages/xpanel/email-tools/email-tools.test.ts', name: 'v2 account email tool family keeps spam thresholds bounded and separates saved policy from observed native mailbox effects' }],
    checks: ['SPAMD-POLICY-OBSERVED', 'ZERO-CHILDREN-VALIDATION', 'INVALID-ALLOWED-IP-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mailx/spamd')
      const rev = revOf(view.data?.revision)
      const pol = view.data?.policy ?? {}
      check('SPAMD-POLICY-OBSERVED', view.status === 200 && view.data?.section === 'spamd' && typeof view.data?.revision === 'string' && Array.isArray(pol.allowedIps), { status: view.status, children: pol.children ?? null })
      refused('ZERO-CHILDREN-VALIDATION', await root.put('/api/server/mailx/spamd', {
        expectedRevision: rev,
        policy: { allowedIps: ['127.0.0.1'], maxConnPerChild: 200, children: 0, timeoutTcp: 30, timeoutChild: 300 },
      }), 'VALIDATION')
      refused('INVALID-ALLOWED-IP-VALIDATION', await root.put('/api/server/mailx/spamd', {
        expectedRevision: rev,
        policy: { allowedIps: ['not-an-ip'], maxConnPerChild: 200, children: 1, timeoutTcp: 30, timeoutChild: 300 },
      }), 'VALIDATION')
    },
  }),

  tool('view-relayers', {
    prefix: 'S18T04', as: 'root', probe: '/api/server/mail-reports/relayers',
    paths: /^\/api\/server\/mail-reports\/relayers(?:\?(?:unknown=1|since=bad))?$/,
    unit: [{ id: 'S18T04-UNIT-1', file: 'apps/api/src/email-all-users.test.ts', name: 'Email All Users keeps headers to one line and addresses to the reviewed shape' }],
    checks: ['RELAYERS-REPORT-OBSERVED', 'UNKNOWN-SELECTOR-VALIDATION', 'MALFORMED-WINDOW-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mail-reports/relayers')
      check('RELAYERS-REPORT-OBSERVED', view.status === 200 && ['read', 'unavailable'].includes(view.data?.state) && Array.isArray(view.data?.rows), { status: view.status, state: view.data?.state ?? null, rows: Array.isArray(view.data?.rows) ? view.data.rows.length : null })
      refused('UNKNOWN-SELECTOR-VALIDATION', await root.get('/api/server/mail-reports/relayers?unknown=1'), 'VALIDATION')
      refused('MALFORMED-WINDOW-VALIDATION', await root.get('/api/server/mail-reports/relayers?since=bad'), 'VALIDATION')
    },
  }),

  tool('view-sent-summary', {
    prefix: 'S18T05', as: 'root', probe: '/api/server/mail-reports/sent-summary',
    paths: /^\/api\/server\/mail-reports\/(?:sent-summary(?:\?view=(?:current|history|invalid))?|send-limits)$/,
    unit: [{ id: 'S18T05-UNIT-1', file: 'apps/api/src/email-disk-usage-workspace.test.ts', name: 'Git viewer workspace forwards validated views only and accepts no mutating method' }],
    checks: ['CURRENT-SENT-SUMMARY-OBSERVED', 'SEND-LIMITS-OBSERVED', 'INVALID-VIEW-VALIDATION', 'INVALID-SEND-LIMITS-VALIDATION'],
    async run({ root, check, refused }) {
      const current = await root.get('/api/server/mail-reports/sent-summary?view=current')
      check('CURRENT-SENT-SUMMARY-OBSERVED', current.status === 200 && current.data?.view === 'current' && ['read', 'unavailable'].includes(current.data?.state) && Array.isArray(current.data?.rows), { status: current.status, state: current.data?.state ?? null })
      const limits = await root.get('/api/server/mail-reports/send-limits')
      check('SEND-LIMITS-OBSERVED', limits.status === 200 && typeof limits.data?.limits?.domainHourlyLimit === 'number' && typeof limits.data?.limits?.deferFailPercent === 'number', { status: limits.status, hourly: limits.data?.limits?.domainHourlyLimit ?? null })
      refused('INVALID-VIEW-VALIDATION', await root.get('/api/server/mail-reports/sent-summary?view=invalid'), 'VALIDATION')
      refused('INVALID-SEND-LIMITS-VALIDATION', await root.put('/api/server/mail-reports/send-limits', { domainHourlyLimit: -1, deferFailPercent: 101, deferFailMinimum: 5 }), 'VALIDATION')
    },
  }),

  tool('panel-branding', {
    prefix: 'S18T06', as: 'root', probe: '/api/server/panel/branding',
    paths: /^\/api\/server\/panel\/branding(?:\?unknown=1)?$/,
    unit: [{ id: 'S18T06-UNIT-1', file: 'apps/api/src/panel-branding.test.ts', name: 'branding grammar and image inspection normalizes colours and refuses markup, insecure links and malformed contacts' }],
    checks: ['BRANDING-STATE-OBSERVED', 'MARKUP-COMPANY-VALIDATION', 'INSECURE-SUPPORT-URL-VALIDATION', 'UNKNOWN-QUERY-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel/branding')
      const rev = revOf(view.data?.revision)
      check('BRANDING-STATE-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && ['default', 'saved', 'invalid'].includes(view.data?.state), { status: view.status, state: view.data?.state ?? null })
      const base = {
        companyName: 'Acme', productName: 'Host', footerText: '', hidePoweredBy: false,
        primaryColor: '', accentColor: '', supportUrl: '', supportEmail: '',
        defaultTheme: 'light', defaultDensity: 'comfortable', expectedRevision: rev,
      }
      refused('MARKUP-COMPANY-VALIDATION', await root.put('/api/server/panel/branding', { ...base, companyName: '<b>Acme</b>' }), 'VALIDATION')
      refused('INSECURE-SUPPORT-URL-VALIDATION', await root.put('/api/server/panel/branding', { ...base, supportUrl: 'http://insecure.example.test' }), 'VALIDATION')
      refused('UNKNOWN-QUERY-VALIDATION', await root.get('/api/server/panel/branding?unknown=1'), 'VALIDATION')
    },
  }),

  tool('panel-change-log', {
    prefix: 'S18T07', as: 'root', probe: '/api/server/services/change-log',
    paths: /^\/api\/server\/(?:services\/change-log(?:\?unknown=1)?|upgrade)$/,
    unit: [{ id: 'S18T07-UNIT-1', file: 'apps/agent/src/db-upgrade.test.ts', name: 'MariaDB upgrade route refuses stale revisions, extra fields, missing runner and changed authority' }],
    checks: ['RELEASE-NOTES-LISTED', 'RUNNING-VERSION-CONSISTENT', 'SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const log = await root.get('/api/server/services/change-log')
      const entries = Array.isArray(log.data?.entries) ? log.data.entries : []
      check('RELEASE-NOTES-LISTED', log.status === 200 && entries.length >= 1 && entries.every(e => typeof e.version === 'string'), { status: log.status, entries: entries.length, installed: log.data?.installed ?? null })
      const upg = await root.get('/api/server/upgrade')
      const running = upg.data?.current?.version ?? null
      const marked = entries.filter(e => e.installed === true).map(e => e.version)
      check('RUNNING-VERSION-CONSISTENT', log.status === 200 && upg.status === 200 && (log.data?.installed === null || log.data?.installed === running) && (marked.length === 0 || marked[0] === log.data?.installed), { status: upg.status, running, markedCount: marked.length })
      refused('SELECTOR-VALIDATION', await root.get('/api/server/services/change-log?unknown=1'), 'VALIDATION')
    },
  }),

  tool('site-software-catalog', {
    prefix: 'S18T08', as: 'root', probe: '/api/server/site-software',
    paths: /^\/api\/server\/site-software(?:\/catalog)?$/,
    unit: [{ id: 'S18T08-UNIT-1', file: 'apps/api/src/site-software-catalog.test.ts', name: 'site software catalog workspace offers only applications of the verified signed catalog and withdraws them without it' }],
    checks: ['CATALOG-OFFER-OBSERVED', 'UNCATALOGED-OFFER-REFUSED', 'MALFORMED-CATALOG-IMPORT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/site-software')
      const rev = revOf(view.data?.offer?.revision)
      check('CATALOG-OFFER-OBSERVED', view.status === 200 && typeof view.data?.offer?.revision === 'string' && Array.isArray(view.data?.offer?.offered), { status: view.status, offered: Array.isArray(view.data?.offer?.offered) ? view.data.offer.offered.length : null })
      refused('UNCATALOGED-OFFER-REFUSED', await root.put('/api/server/site-software', { offered: ['xq-unknown-app'], expectedRevision: rev }), 'PRECONDITION_FAILED')
      refused('MALFORMED-CATALOG-IMPORT-VALIDATION', await root.post('/api/server/site-software/catalog', { extra: 1 }), 'VALIDATION')
    },
  }),

  tool('site-software-instances', {
    prefix: 'S18T09', as: 'root', probe: '/api/server/site-software/instances',
    paths: /^\/api\/server\/site-software\/instances(?:\/jobs|\?unknown=1)?$/,
    unit: [{ id: 'S18T09-UNIT-1', file: 'apps/api/src/site-software-instances.test.ts', name: 'site software instances workspace passes through only rows that match their grammar' }],
    checks: ['INSTANCES-LIST-OBSERVED', 'SELECTOR-VALIDATION', 'INVALID-INSTANCE-JOB-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/site-software/instances')
      check('INSTANCES-LIST-OBSERVED', view.status === 200 && Array.isArray(view.data?.instances), { status: view.status, count: Array.isArray(view.data?.instances) ? view.data.instances.length : null })
      refused('SELECTOR-VALIDATION', await root.get('/api/server/site-software/instances?unknown=1'), 'VALIDATION')
      refused('INVALID-INSTANCE-JOB-VALIDATION', await root.post('/api/server/site-software/instances/jobs', { operation: 'upgrade-all' }), 'VALIDATION')
    },
  }),

  tool('mailing-list-password-reset', {
    prefix: 'S18T10', as: 'root', probe: '/api/server/mailing-lists',
    paths: /^\/api\/server\/mailing-lists(?:\/[0-9a-f-]{36}\/password|\?unknown=1)?$/,
    unit: [{ id: 'S18T10-UNIT-1', file: 'apps/api/src/mail/mailing-list-admin.test.ts', name: 'mailing list administrator password lets the owner set a password that then unlocks member administration from webmail, and a root reset replaces it' }],
    checks: ['MAILING-LISTS-OBSERVED', 'SHORT-CREDENTIAL-VALIDATION', 'MISSING-LIST-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mailing-lists')
      const lists = Array.isArray(view.data?.lists) ? view.data.lists : []
      check('MAILING-LISTS-OBSERVED', view.status === 200 && Array.isArray(view.data?.lists), { status: view.status, count: lists.length })
      refused('SHORT-CREDENTIAL-VALIDATION', await root.put(`/api/server/mailing-lists/${ZERO_UUID}/password`, { password: 'short' }), 'VALIDATION')
      refused('MISSING-LIST-NOT-FOUND', await root.put(`/api/server/mailing-lists/${ZERO_UUID}/password`, { password: 'ValidResetPhrase#2026' }), 'NOT_FOUND')
    },
  }),

  tool('theme-manager', {
    prefix: 'S18T11', as: 'root', probe: '/api/server/themes',
    paths: /^\/api\/server\/themes(?:\/[a-z][a-z0-9-]{1,31}(?:\/(?:clone|package))?)?$/,
    unit: [{ id: 'S18T11-UNIT-1', file: 'apps/web/src/themes/v2/document.test.ts', name: 'v2 document contract preserves validated branding attributes and styles without inventing a new title or favicon' }],
    checks: ['THEMES-INVENTORY-OBSERVED', 'MISSING-TOKEN-PACKAGE-VALIDATION', 'CLONE-ROUNDTRIP-VERIFIED', 'BUILTIN-DELETE-FORBIDDEN'],
    async run({ root, tag, undo, check, refused }) {
      const view = await root.get('/api/server/themes')
      const themes = Array.isArray(view.data?.themes) ? view.data.themes : []
      const builtIn = themes.find(t => t.builtIn === true)?.id ?? 'v2'
      check('THEMES-INVENTORY-OBSERVED', view.status === 200 && themes.some(t => t.builtIn === true) && typeof view.data?.limits?.packages === 'number', { status: view.status, count: themes.length })
      refused('MISSING-TOKEN-PACKAGE-VALIDATION', await root.post('/api/server/themes', { id: 'xq-bad', name: 'Bad', version: '1.0.0', base: builtIn, light: {}, dark: {} }), 'VALIDATION')
      const cloneId = `xq-${String(tag).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'clone1'}`
      undo('theme clone', async () => {
        const cur = await root.get('/api/server/themes')
        if (cur.status === 200 && Array.isArray(cur.data?.themes) && cur.data.themes.some(t => t.id === cloneId)) {
          const del = await root.delete(`/api/server/themes/${cloneId}`)
          return del.status === 200
        }
        return true
      })
      const cloned = await root.post(`/api/server/themes/${builtIn}/clone`, { id: cloneId, name: 'Qualification Clone' })
      const delClone = cloned.status === 200 ? await root.delete(`/api/server/themes/${cloneId}`) : { status: 0, data: null }
      check('CLONE-ROUNDTRIP-VERIFIED', cloned.status === 200 && Array.isArray(cloned.data?.themes) && cloned.data.themes.some(t => t.id === cloneId && t.state === 'installed') && delClone.status === 200 && !delClone.data?.themes?.some(t => t.id === cloneId), { cloneStatus: cloned.status, deleteStatus: delClone.status })
      refused('BUILTIN-DELETE-FORBIDDEN', await root.delete(`/api/server/themes/${builtIn}`), 'FORBIDDEN')
    },
  }),

  tool('application-locales', {
    prefix: 'S18T12', as: 'root', probe: '/api/server/panel/languages',
    paths: /^\/api\/server\/panel\/languages(?:\/zz\/catalog)?$/,
    unit: [{ id: 'S18T12-UNIT-1', file: 'apps/api/src/panel-languages.test.ts', name: 'panel languages policy saves offered locales and the default under the lease, applies and audits them' }],
    checks: ['LOCALES-REGISTRY-OBSERVED', 'DEFAULT-NOT-OFFERED-VALIDATION', 'UNKNOWN-LOCALE-VALIDATION', 'UNREGISTERED-CATALOG-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel/languages')
      const rev = revOf(view.data?.revision)
      const locales = Array.isArray(view.data?.locales) ? view.data.locales : []
      check('LOCALES-REGISTRY-OBSERVED', view.status === 200 && locales.length >= 2 && typeof view.data?.defaultLocale === 'string' && typeof view.data?.revision === 'string', { status: view.status, locales: locales.length, defaultLocale: view.data?.defaultLocale ?? null })
      refused('DEFAULT-NOT-OFFERED-VALIDATION', await root.put('/api/server/panel/languages', { offered: ['en'], defaultLocale: 'ar', expectedRevision: rev }), 'VALIDATION')
      refused('UNKNOWN-LOCALE-VALIDATION', await root.put('/api/server/panel/languages', { offered: ['en', 'zz'], defaultLocale: 'en', expectedRevision: rev }), 'VALIDATION')
      refused('UNREGISTERED-CATALOG-NOT-FOUND', await root.get('/api/server/panel/languages/zz/catalog'), 'NOT_FOUND')
    },
  }),

  tool('locale-copy', {
    prefix: 'S18T13', as: 'root', probe: '/api/server/panel/languages',
    paths: /^\/api\/server\/panel\/languages(?:\/copies(?:\/[A-Za-z-]+)?)?$/,
    unit: [{ id: 'S18T13-UNIT-1', file: 'apps/api/src/panel-languages.test.ts', name: 'Copy a Locale refuses an existing code, a bad code and an unknown source' }],
    checks: ['LANGUAGES-STATE-OBSERVED', 'EXISTING-LOCALE-CONFLICT', 'LOCALE-COPY-ROUNDTRIP', 'BAD-LOCALE-TAG-VALIDATION'],
    async run({ root, undo, check, refused }) {
      const view = await root.get('/api/server/panel/languages')
      const rev = revOf(view.data?.revision)
      check('LANGUAGES-STATE-OBSERVED', view.status === 200 && Array.isArray(view.data?.copies) && typeof view.data?.revision === 'string', { status: view.status, copies: Array.isArray(view.data?.copies) ? view.data.copies.length : null })
      refused('EXISTING-LOCALE-CONFLICT', await root.post('/api/server/panel/languages/copies', { source: 'en', tag: 'en', expectedRevision: rev }), 'CONFLICT')
      refused('BAD-LOCALE-TAG-VALIDATION', await root.post('/api/server/panel/languages/copies', { source: 'en', tag: 'bad_tag_999', expectedRevision: rev }), 'VALIDATION')
      const copyTag = 'fr-CA'
      undo('locale copy', async () => {
        const cur = await root.get('/api/server/panel/languages')
        if (cur.status === 200 && Array.isArray(cur.data?.copies) && cur.data.copies.some(c => c.tag === copyTag)) {
          const del = await root.delete(`/api/server/panel/languages/copies/${copyTag}`, { expectedRevision: cur.data.revision })
          return del.status === 200
        }
        return true
      })
      const created = await root.post('/api/server/panel/languages/copies', { source: 'en', tag: copyTag, expectedRevision: rev })
      const copyRow = Array.isArray(created.data?.copies) ? created.data.copies.find(c => c.tag === copyTag) : null
      const removed = created.status === 200 && typeof created.data?.revision === 'string'
        ? await root.delete(`/api/server/panel/languages/copies/${copyTag}`, { expectedRevision: created.data.revision })
        : { status: 0, data: null }
      check('LOCALE-COPY-ROUNDTRIP', created.status === 200 && !!copyRow && copyRow.messages > 0 && removed.status === 200 && !removed.data?.copies?.some(c => c.tag === copyTag), { createStatus: created.status, messages: copyRow?.messages ?? null, deleteStatus: removed.status })
    },
  }),

  tool('background-process-killer', {
    prefix: 'S18T14', as: 'root', probe: '/api/server/sec/process-killer',
    paths: /^\/api\/server\/sec\/process-killer(?:\/run)?$/,
    unit: [{ id: 'S18T14-UNIT-1', file: 'apps/agent/src/host-monitoring.test.ts', name: 'identity-bound process signal refuses a changed identity with 409 and protected processes before dispatch' }],
    checks: ['PROCESS-KILLER-POLICY-OBSERVED', 'UNLISTED-PROCESS-NAME-VALIDATION', 'INVALID-TRUSTED-USER-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/sec/process-killer')
      const rev = revOf(view.data?.revision)
      check('PROCESS-KILLER-POLICY-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && Array.isArray(view.data?.policy?.names) && Array.isArray(view.data?.accounts), { status: view.status, names: Array.isArray(view.data?.policy?.names) ? view.data.policy.names.length : null })
      refused('UNLISTED-PROCESS-NAME-VALIDATION', await root.put('/api/server/sec/process-killer', {
        expectedRevision: rev,
        policy: { enabled: false, names: ['sshd'], trustedUsers: [] },
      }), 'VALIDATION')
      refused('INVALID-TRUSTED-USER-VALIDATION', await root.put('/api/server/sec/process-killer', {
        expectedRevision: rev,
        policy: { enabled: false, names: ['ircd'], trustedUsers: ['BAD USER'] },
      }), 'VALIDATION')
    },
  }),

  tool('antivirus-scanner-config', {
    prefix: 'S18T15', as: 'root', probe: '/api/server/sec/antivirus-scope',
    paths: /^\/api\/server\/(?:sec\/antivirus-scope|security-tools\/antivirus)$/,
    unit: [{ id: 'S18T15-UNIT-1', file: 'apps/agent/src/security-tools-antivirus.test.ts', name: 'antivirus job plans scans exactly one account home as a reviewed non-mutating job' }],
    checks: ['SCAN-SCOPE-POLICY-OBSERVED', 'ANTIVIRUS-ENGINE-OBSERVED', 'INVALID-SCOPE-SHAPE-VALIDATION', 'INVALID-USER-OVERRIDE-VALIDATION'],
    async run({ root, check, refused }) {
      const scope = await root.get('/api/server/sec/antivirus-scope')
      const rev = revOf(scope.data?.revision)
      check('SCAN-SCOPE-POLICY-OBSERVED', scope.status === 200 && typeof scope.data?.revision === 'string' && typeof scope.data?.policy?.global?.mail === 'boolean', { status: scope.status, globalMail: scope.data?.policy?.global?.mail ?? null })
      const engine = await root.get('/api/server/security-tools/antivirus')
      check('ANTIVIRUS-ENGINE-OBSERVED', engine.status === 200 && ['read', 'not_installed', 'unavailable'].includes(engine.data?.engine?.state) && Array.isArray(engine.data?.scans), { status: engine.status, engineState: engine.data?.engine?.state ?? null })
      refused('INVALID-SCOPE-SHAPE-VALIDATION', await root.put('/api/server/sec/antivirus-scope', {
        expectedRevision: rev,
        policy: { global: { home: true, mail: true }, users: {} },
      }), 'VALIDATION')
      refused('INVALID-USER-OVERRIDE-VALIDATION', await root.put('/api/server/sec/antivirus-scope', {
        expectedRevision: rev,
        policy: { global: { home: true, mail: true, publicFtp: true, publicWeb: true }, users: { 'BAD-NAME': { home: true, mail: false, publicFtp: true, publicWeb: true } } },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-nodejs-versions', {
    prefix: 'S18T16', as: 'root', probe: '/api/server/software-center?page=runtime',
    paths: /^\/api\/server\/software-center(?:\/preview|\?page=(?:runtime|invalid))?$/,
    unit: [{ id: 'S18T16-UNIT-1', file: 'apps/agent/src/software-center-catalog.test.ts', name: 'shipped software center catalog generates PHP module rows only for supported observed versions with per-family naming' }],
    checks: ['NODEJS-RUNTIME-CATALOG-OBSERVED', 'INVALID-PAGE-VALIDATION', 'UNKNOWN-COMPONENT-PREVIEW-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software-center?page=runtime')
      const rev = revOf(view.data?.revision)
      const comps = Array.isArray(view.data?.components) ? view.data.components : []
      check('NODEJS-RUNTIME-CATALOG-OBSERVED', view.status === 200 && view.data?.page === 'runtime' && ['read', 'unavailable'].includes(view.data?.state) && Array.isArray(view.data?.components), { status: view.status, state: view.data?.state ?? null, components: comps.length })
      refused('INVALID-PAGE-VALIDATION', await root.get('/api/server/software-center?page=invalid'), 'VALIDATION')
      refused('UNKNOWN-COMPONENT-PREVIEW-VALIDATION', await root.post('/api/server/software-center/preview', { action: 'remove', componentIds: [], expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-go-project', {
    prefix: 'S18T17', as: 'root', needs: ['account'], probe: '/api/server/application-projects',
    page: { route: '/whm/software/application-projects', read: '/api/server/application-projects', shows: () => ['Go & Java projects'] },
    paths: /^\/api\/server\/application-projects(?:\/log\?account=[a-z0-9]+&target=bad|\?unknown=1)?$/,
    unit: [{ id: 'S18T17-UNIT-1', file: 'apps/agent/src/application-projects.test.ts', name: 'Go and Java projects finds a file without execute permission, and a missing one' }],
    checks: ['GO-PROJECTS-VIEW-OBSERVED', 'MISSING-ACCOUNT-OP-VALIDATION', 'LOG-TARGET-GRAMMAR-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/application-projects')
      const runtimes = Array.isArray(view.data?.runtimes) ? view.data.runtimes : []
      check('GO-PROJECTS-VIEW-OBSERVED', view.status === 200 && runtimes.some(r => r.kind === 'go') && Array.isArray(view.data?.accounts), { status: view.status, accounts: Array.isArray(view.data?.accounts) ? view.data.accounts.length : null })
      const username = typeof fixture.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(fixture.username) ? fixture.username : 'xqacct'
      refused('MISSING-ACCOUNT-OP-VALIDATION', await root.post('/api/server/application-projects', { account: username, op: { op: 'project.save', expectedRevision: ZERO_REV, app: { name: 'BAD NAME' } } }), 'VALIDATION')
      refused('LOG-TARGET-GRAMMAR-VALIDATION', await root.get(`/api/server/application-projects/log?account=${username}&target=bad`), 'VALIDATION')
    },
  }),

  tool('aapanel-go-sdk', {
    prefix: 'S18T18', as: 'root', probe: '/api/server/software-center?page=runtime',
    paths: /^\/api\/server\/(?:software-center(?:\?page=runtime|\/preview\?x=1)?|application-projects)$/,
    unit: [{ id: 'S18T18-UNIT-1', file: 'apps/agent/src/site-software.test.ts', name: 'site software catalog imports only a catalog the release key signed and reports the refusal reason otherwise' }],
    checks: ['GO-RUNTIME-FACTS-OBSERVED', 'SOFTWARE-RUNTIME-PAGE-OBSERVED', 'PREVIEW-QUERY-SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const projects = await root.get('/api/server/application-projects')
      const goRuntime = Array.isArray(projects.data?.runtimes) ? projects.data.runtimes.find(r => r.kind === 'go') : null
      check('GO-RUNTIME-FACTS-OBSERVED', projects.status === 200 && !!goRuntime && typeof goRuntime.available === 'boolean', { status: projects.status, available: goRuntime?.available ?? null, version: goRuntime?.version ?? null })
      const sw = await root.get('/api/server/software-center?page=runtime')
      check('SOFTWARE-RUNTIME-PAGE-OBSERVED', sw.status === 200 && sw.data?.page === 'runtime' && Array.isArray(sw.data?.components), { status: sw.status, count: Array.isArray(sw.data?.components) ? sw.data.components.length : null })
      refused('PREVIEW-QUERY-SELECTOR-VALIDATION', await root.post('/api/server/software-center/preview?x=1', {}), 'VALIDATION')
    },
  }),

  tool('aapanel-python-versions', {
    prefix: 'S18T19', as: 'root', needs: ['account'], probe: '/api/server/application-projects',
    paths: /^\/api\/server\/(?:application-projects|software-center\?page=runtime)$/,
    unit: [{ id: 'S18T19-UNIT-1', file: 'apps/agent/src/application-projects.test.ts', name: 'named Python environments refuses a name that exists with CONFLICT and a version not installed' }],
    checks: ['PYTHON-INTERPRETERS-OBSERVED', 'UNINSTALLED-PYTHON-REFUSED', 'INVALID-ENV-NAME-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/application-projects')
      const pyList = Array.isArray(view.data?.python) ? view.data.python : []
      const acctRow = Array.isArray(view.data?.accounts) ? view.data.accounts.find(a => a.account === fixture.username) ?? view.data.accounts[0] : null
      const rev = revOf(acctRow?.revision)
      const username = typeof acctRow?.account === 'string' ? acctRow.account : (typeof fixture.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(fixture.username) ? fixture.username : 'xqacct')
      check('PYTHON-INTERPRETERS-OBSERVED', view.status === 200 && Array.isArray(view.data?.python) && Array.isArray(view.data?.accounts), { status: view.status, interpreters: pyList.length })
      const missingRes = await root.post('/api/server/application-projects', {
        account: username,
        op: { op: 'pyenv.create', expectedRevision: rev, name: 'xqenv', version: '3.99' },
      })
      check('UNINSTALLED-PYTHON-REFUSED', missingRes.status >= 400 && missingRes.status < 500 && ['VALIDATION', 'PRECONDITION_FAILED'].includes(missingRes.data?.code), { status: missingRes.status, code: missingRes.data?.code ?? null })
      refused('INVALID-ENV-NAME-VALIDATION', await root.post('/api/server/application-projects', {
        account: username,
        op: { op: 'pyenv.create', expectedRevision: rev, name: '../bad', version: '3.12' },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-java-project', {
    prefix: 'S18T20', as: 'root', needs: ['account'], probe: '/api/server/application-projects',
    page: { route: '/whm/software/application-projects', read: '/api/server/application-projects', shows: () => ['Go & Java projects'] },
    paths: /^\/api\/server\/application-projects$/,
    unit: [{ id: 'S18T20-UNIT-1', file: 'apps/agent/src/application-projects.test.ts', name: 'Go and Java projects refuses a JDK that is not installed with RUNTIME_MISSING' }],
    checks: ['JAVA-JDKS-OBSERVED', 'MISSING-JDK-RUNTIME-REFUSED', 'INVALID-JAR-PROJECT-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/application-projects')
      const acctRow = Array.isArray(view.data?.accounts) ? view.data.accounts.find(a => a.account === fixture.username) ?? view.data.accounts[0] : null
      const rev = revOf(acctRow?.revision)
      const username = typeof acctRow?.account === 'string' ? acctRow.account : (typeof fixture.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(fixture.username) ? fixture.username : 'xqacct')
      const domId = uuidOrZero(acctRow?.domains?.[0]?.id)
      check('JAVA-JDKS-OBSERVED', view.status === 200 && Array.isArray(view.data?.jdks) && Array.isArray(view.data?.runtimes) && view.data.runtimes.some(r => r.kind === 'java'), { status: view.status, jdks: Array.isArray(view.data?.jdks) ? view.data.jdks.length : null })
      const missingJdk = await root.post('/api/server/application-projects', {
        account: username,
        op: { op: 'project.save', expectedRevision: rev, app: { name: 'xqjava', runtime: 'java', root: 'apps/xqjava', startup: 'app.jar', domainId: domId, path: '/xqjava', env: {}, port: null, openPort: false, jdk: '99', command: null } },
      })
      check('MISSING-JDK-RUNTIME-REFUSED', missingJdk.status >= 400 && missingJdk.status < 500 && ['VALIDATION', 'PRECONDITION_FAILED'].includes(missingJdk.data?.code), { status: missingJdk.status, code: missingJdk.data?.code ?? null })
      refused('INVALID-JAR-PROJECT-VALIDATION', await root.post('/api/server/application-projects', {
        account: username,
        op: { op: 'project.save', expectedRevision: rev, app: { name: 'BAD_JAVA', runtime: 'java' } },
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-dashboard', {
    prefix: 'S18T21', as: 'root', probe: '/api/server/monitoring/processes',
    paths: /^\/api\/(?:server\/monitoring\/(?:processes|disk|performance\?window=invalid)|domains)$/,
    unit: [{ id: 'S18T21-UNIT-1', file: 'apps/web/src/board-port/xwhm-dashboard.test.ts', name: 'xWHM dashboard board port uses observed assigned-cap evidence and never treats delegated controllers as enforcement proof' }],
    checks: ['LIVE-PROCESSES-OBSERVED', 'FILESYSTEM-DISK-OBSERVED', 'HOSTED-SITES-COUNTER-READ', 'INVALID-PERFORMANCE-WINDOW-VALIDATION'],
    async run({ root, check, refused }) {
      const procs = await root.get('/api/server/monitoring/processes')
      check('LIVE-PROCESSES-OBSERVED', procs.status === 200 && ['read', 'unavailable'].includes(procs.data?.state) && Array.isArray(procs.data?.items), { status: procs.status, state: procs.data?.state ?? null, total: procs.data?.total ?? null })
      const disk = await root.get('/api/server/monitoring/disk')
      check('FILESYSTEM-DISK-OBSERVED', disk.status === 200 && ['read', 'unavailable'].includes(disk.data?.filesystems?.state) && Array.isArray(disk.data?.filesystems?.items), { status: disk.status, fsState: disk.data?.filesystems?.state ?? null })
      const sites = await root.get('/api/domains')
      check('HOSTED-SITES-COUNTER-READ', sites.status === 200 && Array.isArray(sites.data?.domains), { status: sites.status, sites: Array.isArray(sites.data?.domains) ? sites.data.domains.length : null })
      refused('INVALID-PERFORMANCE-WINDOW-VALIDATION', await root.get('/api/server/monitoring/performance?window=invalid'), 'VALIDATION')
    },
  }),

  tool('aapanel-task-messages', {
    prefix: 'S18T22', as: 'root', probe: '/api/jobs',
    paths: /^\/api\/jobs(?:\/[0-9a-f-]{36}(?:\/log)?|\?status=(?:failed|invalid))?$/,
    unit: [{ id: 'S18T22-UNIT-1', file: 'apps/agent/src/db-service-jobs.test.ts', name: 'Redis version switch rolls back a failed install and leaves an early failure alone' }],
    checks: ['JOB-HISTORY-LISTED', 'FAILED-JOBS-FILTERED', 'INVALID-STATUS-FILTER-VALIDATION', 'MISSING-JOB-NOT-FOUND'],
    async run({ root, check, refused }) {
      const all = await root.get('/api/jobs')
      check('JOB-HISTORY-LISTED', all.status === 200 && Array.isArray(all.data?.jobs), { status: all.status, count: Array.isArray(all.data?.jobs) ? all.data.jobs.length : null })
      const failed = await root.get('/api/jobs?status=failed')
      check('FAILED-JOBS-FILTERED', failed.status === 200 && Array.isArray(failed.data?.jobs) && failed.data.jobs.every(j => j.status === 'failed'), { status: failed.status, count: Array.isArray(failed.data?.jobs) ? failed.data.jobs.length : null })
      refused('INVALID-STATUS-FILTER-VALIDATION', await root.get('/api/jobs?status=invalid'), 'VALIDATION')
      refused('MISSING-JOB-NOT-FOUND', await root.get(`/api/jobs/${ZERO_UUID}/log`), 'NOT_FOUND')
    },
  }),

  tool('aapanel-language-theme', {
    prefix: 'S18T23', as: 'root', probe: '/api/auth/ui-preferences',
    restores: ['/api/auth/ui-preferences'],
    paths: /^\/api\/(?:auth\/ui-preferences|admin\/preferences)$/,
    unit: [{ id: 'S18T23-UNIT-1', file: 'apps/api/src/personal-preferences.test.ts', name: 'personal preferences saves language, position and switches, and reads them for rendering' }],
    checks: ['UI-PREFERENCES-OBSERVED', 'ADMIN-PREFERENCES-OBSERVED', 'UNREGISTERED-THEME-VALIDATION'],
    async run({ root, check, refused }) {
      const ui = await root.get('/api/auth/ui-preferences')
      const rev = revOf(ui.data?.revision)
      check('UI-PREFERENCES-OBSERVED', ui.status === 200 && Array.isArray(ui.data?.choices) && ui.data.choices.length >= 1 && typeof ui.data?.revision === 'string', { status: ui.status, uiTheme: ui.data?.uiTheme ?? null, choices: Array.isArray(ui.data?.choices) ? ui.data.choices.length : null })
      const admin = await root.get('/api/admin/preferences')
      check('ADMIN-PREFERENCES-OBSERVED', admin.status === 200 && typeof admin.data?.revision === 'string', { status: admin.status, state: admin.data?.state ?? null })
      refused('UNREGISTERED-THEME-VALIDATION', await root.put('/api/auth/ui-preferences', { uiTheme: 'xq-nonexistent-theme', expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-ftp-logs', {
    prefix: 'S18T24', as: 'root', probe: '/api/server/ftp-log/activity',
    paths: /^\/api\/server\/ftp-log\/(?:activity(?:\?(?:kind=login-failed|unknown=1))?|raw\?domain=example\.test&hours=999)$/,
    unit: [{ id: 'S18T24-UNIT-1', file: 'packages/render/src/services/ftp.test.ts', name: 'ftpPasswdLine renders the pure-pw line with the account ids and /./ chroot at the home' }],
    checks: ['FTP-ACTIVITY-OBSERVED', 'UNKNOWN-SELECTOR-VALIDATION', 'RAW-HOURS-BOUND-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/ftp-log/activity')
      check('FTP-ACTIVITY-OBSERVED', view.status === 200 && view.data?.scope === 'server' && ['read', 'unavailable'].includes(view.data?.state) && Array.isArray(view.data?.events), { status: view.status, state: view.data?.state ?? null, events: Array.isArray(view.data?.events) ? view.data.events.length : null })
      refused('UNKNOWN-SELECTOR-VALIDATION', await root.get('/api/server/ftp-log/activity?unknown=1'), 'VALIDATION')
      refused('RAW-HOURS-BOUND-VALIDATION', await root.get('/api/server/ftp-log/raw?domain=example.test&hours=999'), 'VALIDATION')
    },
  }),

  tool('aapanel-db-quota', {
    prefix: 'S18T25', as: 'root', probe: '/api/server/databases/quota',
    paths: /^\/api\/server\/databases\/quota(?:\?unknown=1)?$/,
    unit: [{ id: 'S18T25-UNIT-1', file: 'apps/agent/src/db-quota.test.ts', name: 'database size limits takes write privileges over the limit and gives them back under it' }],
    checks: ['DB-QUOTA-VIEW-OBSERVED', 'ZERO-LIMIT-VALIDATION', 'UNSAVED-DATABASE-NOT-FOUND', 'SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/quota')
      const rev = revOf(view.data?.revision)
      check('DB-QUOTA-VIEW-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string', { status: view.status })
      refused('ZERO-LIMIT-VALIDATION', await root.put('/api/server/databases/quota', { database: 'xq_db', limitMb: 0, expectedRevision: rev }), 'VALIDATION')
      refused('UNSAVED-DATABASE-NOT-FOUND', await root.put('/api/server/databases/quota', { database: 'xq_missing_db_999', limitMb: 64, expectedRevision: rev }), 'NOT_FOUND')
      refused('SELECTOR-VALIDATION', await root.get('/api/server/databases/quota?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-phpmyadmin-access', {
    prefix: 'S18T26', as: 'root', probe: '/api/server/databases/phpmyadmin-access',
    paths: /^\/api\/server\/databases\/phpmyadmin-access(?:\?unknown=1)?$/,
    unit: [{ id: 'S18T26-UNIT-1', file: 'apps/agent/src/phpmyadmin-access.test.ts', name: 'phpMyAdmin access limits the server to this host while public access is off' }],
    checks: ['PHPMYADMIN-ACCESS-OBSERVED', 'INCOMPLETE-FIELDS-VALIDATION', 'RESERVED-PORT-OR-ABSENT-REFUSED', 'SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/phpmyadmin-access')
      const rev = revOf(view.data?.revision)
      check('PHPMYADMIN-ACCESS-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string' && typeof view.data?.publicAccess === 'boolean' && typeof view.data?.host === 'object', { status: view.status, installed: view.data?.host?.installed ?? null, publicAccess: view.data?.publicAccess ?? null })
      refused('INCOMPLETE-FIELDS-VALIDATION', await root.put('/api/server/databases/phpmyadmin-access', { publicAccess: false }), 'VALIDATION')
      const portTry = await root.put('/api/server/databases/phpmyadmin-access', {
        publicAccess: false, httpPort: null, httpsPort: 22, phpVersion: null,
        basicAuthUser: null, basicAuthPassword: null, expectedRevision: rev,
      })
      const expectedCode = view.status === 200 && view.data?.host?.installed === true ? 'VALIDATION' : 'PRECONDITION_FAILED'
      refused('RESERVED-PORT-OR-ABSENT-REFUSED', portTry, expectedCode)
      refused('SELECTOR-VALIDATION', await root.get('/api/server/databases/phpmyadmin-access?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-mongodb', {
    prefix: 'S18T27', as: 'root', probe: '/api/server/databases/services/mongodb',
    page: { route: '/whm/databases/mongodb', read: '/api/server/databases/services/mongodb', shows: () => ['MongoDB'] },
    paths: /^\/api\/server\/databases\/services\/mongodb(?:\/(?:import|settings)|\?unknown=1)?$/,
    unit: [{ id: 'S18T27-UNIT-1', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database workspace routes returns 403 before saved or host reads and 422 for selectors' }],
    checks: ['MONGODB-SERVICE-OBSERVED', 'NON-LOOPBACK-BIND-VALIDATION', 'NON-GZIP-IMPORT-VALIDATION', 'SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/services/mongodb')
      check('MONGODB-SERVICE-OBSERVED', view.status === 200 && view.data?.engine === 'mongodb' && typeof view.data?.installed === 'boolean' && Array.isArray(view.data?.backups), { status: view.status, installed: view.data?.installed ?? null, runtimeState: view.data?.runtime?.state ?? null })
      refused('NON-LOOPBACK-BIND-VALIDATION', await root.post('/api/server/databases/services/mongodb/settings', { port: 27017, bindIp: '0.0.0.0' }), 'VALIDATION')
      refused('NON-GZIP-IMPORT-VALIDATION', await root.post('/api/server/databases/services/mongodb/import', { filename: 'dump.tar', bytes: 128 }), 'VALIDATION')
      refused('SELECTOR-VALIDATION', await root.get('/api/server/databases/services/mongodb?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-redis-keys', {
    prefix: 'S18T28', as: 'root', probe: '/api/server/databases/services/redis',
    paths: /^\/api\/server\/databases\/services\/redis(?:\/(?:keys|key|key-delete|flush))?$/,
    unit: [{ id: 'S18T28-UNIT-1', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database workspace routes serves saved state with an unavailable observation when the host read fails or is malformed' }],
    checks: ['REDIS-KEYSPACE-OBSERVED', 'DB-INDEX-BOUND-VALIDATION', 'ZERO-TTL-VALIDATION', 'FLUSH-CONFIRMATION-VALIDATION'],
    async run({ root, tag, undo, check, refused }) {
      const view = await root.get('/api/server/databases/services/redis')
      let keyspaceOk = view.status === 200 && view.data?.engine === 'redis' && typeof view.data?.installed === 'boolean'
      if (keyspaceOk && view.data?.installed === true && view.data?.runtime?.state === 'read') {
        const key = `xq:${tag}`
        undo('redis key', async () => {
          const del = await root.post('/api/server/databases/services/redis/key-delete', { db: 0, key })
          return del.status === 200
        })
        const saved = await root.post('/api/server/databases/services/redis/key', { db: 0, key, value: 'probe', ttlSeconds: 60 })
        const scanned = await root.post('/api/server/databases/services/redis/keys', { db: 0, cursor: '0', match: key })
        const removed = await root.post('/api/server/databases/services/redis/key-delete', { db: 0, key })
        keyspaceOk = saved.status === 200 && scanned.status === 200 && Array.isArray(scanned.data?.keys) && scanned.data.keys.some(r => r.key === key && r.ttlSeconds > 0 && r.ttlSeconds <= 60) && removed.status === 200
      }
      check('REDIS-KEYSPACE-OBSERVED', keyspaceOk, { status: view.status, installed: view.data?.installed ?? null, runtimeState: view.data?.runtime?.state ?? null })
      refused('DB-INDEX-BOUND-VALIDATION', await root.post('/api/server/databases/services/redis/keys', { db: 256, cursor: '0', match: '' }), 'VALIDATION')
      refused('ZERO-TTL-VALIDATION', await root.post('/api/server/databases/services/redis/key', { db: 0, key: 'xq:bad', value: 'v', ttlSeconds: 0 }), 'VALIDATION')
      refused('FLUSH-CONFIRMATION-VALIDATION', await root.post('/api/server/databases/services/redis/flush', { db: 0, confirmation: 'wrong' }), 'VALIDATION')
    },
  }),

  tool('aapanel-redis-service', {
    prefix: 'S18T29', as: 'root', probe: '/api/server/databases/services/redis',
    paths: /^\/api\/server\/databases\/services\/redis(?:\/(?:settings|config|versions))?$/,
    unit: [{ id: 'S18T29-UNIT-1', file: 'apps/agent/src/db-service-files.test.ts', name: 'redis.conf editing replaces every active line of a keyword and keeps comments and other lines' }],
    checks: ['REDIS-DAEMON-OBSERVED', 'INVALID-EVICTION-POLICY-VALIDATION', 'EMPTY-CONFIG-TEXT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/services/redis')
      check('REDIS-DAEMON-OBSERVED', view.status === 200 && view.data?.engine === 'redis' && typeof view.data?.installed === 'boolean' && typeof view.data?.passwordConfigured === 'boolean', { status: view.status, installed: view.data?.installed ?? null })
      refused('INVALID-EVICTION-POLICY-VALIDATION', await root.post('/api/server/databases/services/redis/settings', {
        port: 6379, maxmemoryMb: 128, maxclients: 1000, maxmemoryPolicy: 'invalid-policy', persistence: 'rdb', remoteAccess: false,
      }), 'VALIDATION')
      refused('EMPTY-CONFIG-TEXT-VALIDATION', await root.post('/api/server/databases/services/redis/config', { text: '', expectedRevision: ZERO_REV }), 'VALIDATION')
    },
  }),

  tool('aapanel-postgresql-service', {
    prefix: 'S18T30', as: 'root', probe: '/api/server/databases/services/postgresql',
    paths: /^\/api\/server\/databases\/services\/postgresql(?:\/(?:settings|hba|config))?$/,
    unit: [{ id: 'S18T30-UNIT-1', file: 'apps/agent/src/db-service-jobs.test.ts', name: 'PostgreSQL major upgrade refuses a version no repository offers, a downgrade and a full disk' }],
    checks: ['POSTGRESQL-CLUSTER-OBSERVED', 'MISSING-PEER-ADMIN-HBA-VALIDATION', 'INVALID-MEMORY-UNIT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/databases/services/postgresql')
      check('POSTGRESQL-CLUSTER-OBSERVED', view.status === 200 && view.data?.engine === 'postgresql' && typeof view.data?.installed === 'boolean' && Array.isArray(view.data?.pendingRestart), { status: view.status, installed: view.data?.installed ?? null, version: view.data?.version ?? null })
      refused('MISSING-PEER-ADMIN-HBA-VALIDATION', await root.post('/api/server/databases/services/postgresql/hba', {
        text: 'host all all 127.0.0.1/32 scram-sha-256\n',
        expectedRevision: ZERO_REV,
      }), 'VALIDATION')
      refused('INVALID-MEMORY-UNIT-VALIDATION', await root.post('/api/server/databases/services/postgresql/settings', {
        port: 5432, maxConnections: 100, sharedBuffers: '128BYTES', workMem: '4MB',
        maintenanceWorkMem: '64MB', effectiveCacheSize: '512MB', logMinDurationMs: -1,
      }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-apps', {
    prefix: 'S18T31', as: 'root', needs: ['account'], probe: '/api/server/software/containers/policy',
    paths: /^\/api\/server\/software\/containers\/(?:policy|catalog|op)$/,
    unit: [{ id: 'S18T31-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container engine parsers normalizes podman arrays and docker JSON lines' }],
    checks: ['CONTAINER-APP-TEMPLATES-OBSERVED', 'PRIVILEGED-PORT-INSTALL-VALIDATION', 'CATALOG-FEED-SHAPE-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const policy = await root.get('/api/server/software/containers/policy')
      const rev = revOf(policy.data?.revision)
      check('CONTAINER-APP-TEMPLATES-OBSERVED', policy.status === 200 && Array.isArray(policy.data?.apps) && Array.isArray(policy.data?.templates) && ['bundled', 'signed'].includes(policy.data?.catalog?.source), { status: policy.status, apps: Array.isArray(policy.data?.apps) ? policy.data.apps.length : null, source: policy.data?.catalog?.source ?? null })
      const username = typeof fixture.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(fixture.username) ? fixture.username : 'xqacct'
      refused('PRIVILEGED-PORT-INSTALL-VALIDATION', await root.post('/api/server/software/containers/op', {
        account: username,
        expectedRevision: rev,
        action: { op: 'app.install', app: 'redis', name: 'xqredis', version: '7.2', bind: '127.0.0.1', port: 80, memoryMb: 256, cpuPercent: 100 },
      }), 'VALIDATION')
      refused('CATALOG-FEED-SHAPE-VALIDATION', await root.post('/api/server/software/containers/catalog', { url: 'https://example.test/feed.json' }), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-overview', {
    prefix: 'S18T32', as: 'root', probe: '/api/server/software/containers/accounts',
    paths: /^\/api\/server\/software\/containers\/(?:accounts(?:\?unknown=1)?|scope(?:\?unknown=1)?)$/,
    unit: [{ id: 'S18T32-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container engine parsers normalizes podman arrays and docker JSON lines' }],
    checks: ['ACCOUNTS-OVERVIEW-OBSERVED', 'HOST-SCOPE-STATS-OBSERVED', 'UNSUPPORTED-SCOPE-SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const accs = await root.get('/api/server/software/containers/accounts')
      check('ACCOUNTS-OVERVIEW-OBSERVED', accs.status === 200 && ['read', 'unavailable'].includes(accs.data?.state) && Array.isArray(accs.data?.accounts), { status: accs.status, state: accs.data?.state ?? null, accounts: Array.isArray(accs.data?.accounts) ? accs.data.accounts.length : null })
      const scope = await root.get('/api/server/software/containers/scope')
      check('HOST-SCOPE-STATS-OBSERVED', scope.status === 200 && ['read', 'unavailable'].includes(scope.data?.state) && Array.isArray(scope.data?.stats) && Array.isArray(scope.data?.stacks), { status: scope.status, state: scope.data?.state ?? null, stats: Array.isArray(scope.data?.stats) ? scope.data.stats.length : null })
      refused('UNSUPPORTED-SCOPE-SELECTOR-VALIDATION', await root.get('/api/server/software/containers/scope?unknown=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-docker-containers', {
    prefix: 'S18T33', as: 'root', probe: '/api/server/software/containers',
    paths: /^\/api\/server\/software\/containers(?:\/(?:engine|action)|\?unknown=1)?$/,
    unit: [{ id: 'S18T33-UNIT-1', file: 'apps/agent/src/sw-containers.test.ts', name: 'container engine parsers normalizes podman arrays and docker JSON lines' }],
    checks: ['CONTAINER-ENGINES-LISTED', 'ENGINE-DETAIL-OBSERVED', 'INVALID-CONTAINER-ID-ACTION-VALIDATION', 'SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/software/containers')
      check('CONTAINER-ENGINES-LISTED', view.status === 200 && view.data?.scope === 'host-engines' && ['read', 'unavailable'].includes(view.data?.state) && Array.isArray(view.data?.engines), { status: view.status, state: view.data?.state ?? null, engines: Array.isArray(view.data?.engines) ? view.data.engines.length : null })
      const detail = await root.get('/api/server/software/containers/engine')
      check('ENGINE-DETAIL-OBSERVED', detail.status === 200 && detail.data?.scope === 'host-engines' && Array.isArray(detail.data?.engines), { status: detail.status, state: detail.data?.state ?? null })
      refused('INVALID-CONTAINER-ID-ACTION-VALIDATION', await root.post('/api/server/software/containers/action', {
        engine: 'podman', containerId: 'short-id', action: 'restart', expectedRevision: ZERO_HASH,
      }), 'VALIDATION')
      refused('SELECTOR-VALIDATION', await root.get('/api/server/software/containers?unknown=1'), 'VALIDATION')
    },
  }),
]
