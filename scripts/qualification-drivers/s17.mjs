import { tool } from './kit.mjs'

const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const ZERO_REV = '0'.repeat(64)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEMP_ID_RE = /^[0-9a-f]{16}$/

const uuidOrZero = value => (typeof value === 'string' && UUID_RE.test(value) ? value : ZERO_UUID)
const revOf = value => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : ZERO_REV)

const ownerSite = async (owner, fixture) => {
  const res = await owner.get('/api/domains')
  const domains = Array.isArray(res.data?.domains) ? res.data.domains : []
  const domain = domains.find(item => item.name === fixture.domain) ?? domains[0] ?? null
  const home = res.data?.context?.home
  const rel = domain && typeof home === 'string' && typeof domain.docRoot === 'string'
    ? (domain.docRoot.startsWith(`${home}/`) ? domain.docRoot.slice(home.length + 1) : domain.docRoot)
    : null
  return {
    res,
    domain,
    hasRealDomain: typeof domain?.id === 'string' && UUID_RE.test(domain.id),
    id: uuidOrZero(domain?.id),
    rev: revOf(res.data?.revision),
    rel,
  }
}

const restoreSiteOptions = (owner, domainId) => async () => {
  const cur = await owner.get('/api/domains')
  if (cur.status !== 200) return false
  const row = cur.data?.domains?.find(item => item.id === domainId)
  if (!row) return true
  if (!row.site || Object.keys(row.site).filter(k => k !== 'category' && k !== 'stoppedByOwner').length === 0) return true
  const back = await owner.put(`/api/domains/${domainId}/site-settings`, { expectedRevision: cur.data.revision, site: {} })
  return back.status === 200
}

const discardFile = (owner, username, filePath) => async () => {
  const parent = filePath.split('/').slice(0, -1).join('/')
  const listed = await owner.post(`/api/accounts/${username}/files`, { op: 'list', path: parent })
  if (listed.status !== 200) return false
  if (!listed.data?.entries?.some(entry => entry.path === filePath)) return true
  const trashed = await owner.post(`/api/accounts/${username}/files`, { op: 'trash', path: filePath })
  if (trashed.status !== 200) return false
  const purged = await owner.post(`/api/accounts/${username}/files`, {
    op: 'purge-trash',
    trashId: trashed.data?.id,
    originalPath: trashed.data?.originalPath,
    deletedAt: trashed.data?.deletedAt,
  })
  return purged.status === 200
}

export default [
  tool('aapanel-region-rules', {
    prefix: 'S17T01', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/prefix-lists\/[A-Za-z0-9_-]{1,32})?$/,
    unit: [{ id: 'S17T01-UNIT-1', file: 'packages/core/src/rules/firewall.test.ts', name: 'address parsing parses CIDRs and refuses host bits' }],
    checks: ['PREFIX-LISTS-OBSERVED', 'INVALID-LIST-NAME-VALIDATION', 'HOST-BITS-CIDR-VALIDATION', 'MISSING-LIST-NOT-FOUND'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const rev = revOf(view.data?.revision)
      check('PREFIX-LISTS-OBSERVED', view.status === 200 && Array.isArray(view.data?.prefixLists) && typeof view.data?.revision === 'string', { status: view.status, lists: Array.isArray(view.data?.prefixLists) ? view.data.prefixLists.length : null })
      refused('INVALID-LIST-NAME-VALIDATION', await root.put('/api/firewall/prefix-lists/INVALID', { entries: ['198.51.100.0/24'], action: 'drop', ports: '22', expectedRevision: rev }), 'VALIDATION')
      refused('HOST-BITS-CIDR-VALIDATION', await root.put('/api/firewall/prefix-lists/xq_bad', { entries: ['198.51.100.7/24'], action: 'drop', ports: '22', expectedRevision: rev }), 'VALIDATION')
      refused('MISSING-LIST-NOT-FOUND', await root.delete('/api/firewall/prefix-lists/xq_missing', { expectedRevision: rev }), 'NOT_FOUND')
    },
  }),

  tool('aapanel-firewall-import-export', {
    prefix: 'S17T02', as: 'root', probe: '/api/firewall',
    paths: /^\/api\/firewall(?:\/(?:export|import))?$/,
    unit: [{ id: 'S17T02-UNIT-1', file: 'apps/web/src/whm-firewall-import-revision.test.ts', name: 'refuses a stale import confirmation and accepts the accurately reviewed fresh import' }],
    checks: ['EXPORT-BUNDLE-READ', 'DRYRUN-IMPORT-VALIDATED', 'CORRUPT-BUNDLE-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/firewall')
      const rev = revOf(view.data?.revision)
      const exported = await root.get('/api/firewall/export')
      check('EXPORT-BUNDLE-READ', exported.status === 200 && Array.isArray(exported.data?.rules), { status: exported.status, rules: Array.isArray(exported.data?.rules) ? exported.data.rules.length : null })
      const dry = await root.post('/api/firewall/import', { document: exported.data ?? {}, expectedRevision: rev, dryRun: true })
      check('DRYRUN-IMPORT-VALIDATED', dry.status === 200 && dry.data?.dryRun === true && dry.data?.valid === true, { status: dry.status, valid: dry.data?.valid ?? null })
      refused('CORRUPT-BUNDLE-VALIDATION', await root.post('/api/firewall/import', { document: '{"version":999,"rules":"bad"}', expectedRevision: rev, dryRun: true }), 'VALIDATION')
    },
  }),

  tool('aapanel-ssh-login-logs', {
    prefix: 'S17T03', as: 'root', probe: '/api/security/ssh',
    paths: /^\/api\/security\/ssh(?:\?window=(?:24h|7d|invalid))?$/,
    unit: [{ id: 'S17T03-UNIT-1', file: 'apps/api/src/ssh-login-alarm.test.ts', name: 'SSH login alarm sends one webhook per login with the address, and moves the cursor past it' }],
    checks: ['WINDOW-24H-OBSERVED', 'WINDOW-7D-OBSERVED', 'UNSUPPORTED-WINDOW-VALIDATION'],
    async run({ root, check, refused }) {
      const day = await root.get('/api/security/ssh?window=24h')
      check('WINDOW-24H-OBSERVED', day.status === 200 && day.data?.ssh?.failedLogins?.window === '24h' && Array.isArray(day.data?.ssh?.failedLogins?.items), { status: day.status, state: day.data?.ssh?.failedLogins?.state ?? null })
      const week = await root.get('/api/security/ssh?window=7d')
      check('WINDOW-7D-OBSERVED', week.status === 200 && week.data?.ssh?.failedLogins?.window === '7d' && Array.isArray(week.data?.ssh?.failedLogins?.items), { status: week.status, state: week.data?.ssh?.failedLogins?.state ?? null })
      refused('UNSUPPORTED-WINDOW-VALIDATION', await root.get('/api/security/ssh?window=invalid'), 'VALIDATION')
    },
  }),

  tool('aapanel-site-list', {
    prefix: 'S17T04', as: 'root', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\?accountId=[0-9a-f-]{36}(?:&workspace=[12])?)?$/,
    unit: [{ id: 'S17T04-UNIT-1', file: 'apps/web/src/themes/v2/pages/xpanel/domains/domains.test.ts', name: 'v2 domain list filter admits server rows and template rows to the shared list filter by kind and keeps it closed without an account' }],
    checks: ['SAVED-SITES-LISTED', 'ACCOUNT-WORKSPACE-FILTERED', 'INVALID-WORKSPACE-QUERY-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const all = await root.get('/api/domains')
      const match = Array.isArray(all.data?.domains) ? all.data.domains.find(d => d.name === fixture.domain) : null
      check('SAVED-SITES-LISTED', all.status === 200 && !!match && match.kind === 'primary' && typeof match.php?.version === 'string', { status: all.status, found: !!match })
      const accId = uuidOrZero(fixture.accountId)
      const scoped = await root.get(`/api/domains?accountId=${accId}&workspace=1`)
      check('ACCOUNT-WORKSPACE-FILTERED', scoped.status === 200 && Array.isArray(scoped.data?.domains) && scoped.data.domains.every(d => d.accountId === fixture.accountId), { status: scoped.status, count: Array.isArray(scoped.data?.domains) ? scoped.data.domains.length : null })
      refused('INVALID-WORKSPACE-QUERY-VALIDATION', await root.get(`/api/domains?accountId=${accId}&workspace=2`), 'VALIDATION')
    },
  }),

  tool('aapanel-site-bulk-actions', {
    prefix: 'S17T05', as: 'root', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/bulk-actions)?$/,
    unit: [{ id: 'S17T05-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'bulk site actions sets a category and starts a backup' }],
    checks: ['BULK-CATEGORY-APPLIED-AND-CLEARED', 'DELETE-MISMATCHED-NAME-REFUSED', 'EMPTY-SELECTION-VALIDATION'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const list = await root.get('/api/domains')
      const row = Array.isArray(list.data?.domains) ? list.data.domains.find(d => d.name === fixture.domain) : null
      const id = uuidOrZero(row?.id)
      if (row?.id && UUID_RE.test(row.id)) {
        undo('clear site category', async () => {
          const reset = await root.post('/api/domains/bulk-actions', { action: 'category', category: null, domains: [{ id: row.id }] })
          return reset.status === 200 && reset.data?.summary?.applied === 1
        })
      }
      const label = `xq-${tag}`
      const setCat = await root.post('/api/domains/bulk-actions', { action: 'category', category: label, domains: [{ id }] })
      const afterSet = await root.get('/api/domains')
      const updated = Array.isArray(afterSet.data?.domains) ? afterSet.data.domains.find(d => d.id === id) : null
      const clearCat = await root.post('/api/domains/bulk-actions', { action: 'category', category: null, domains: [{ id }] })
      check('BULK-CATEGORY-APPLIED-AND-CLEARED', setCat.status === 200 && setCat.data?.summary?.applied === 1 && updated?.site?.category === label && clearCat.status === 200 && clearCat.data?.summary?.applied === 1, { setStatus: setCat.status, clearStatus: clearCat.status })
      const wrongDelete = await root.post('/api/domains/bulk-actions', { action: 'delete', domains: [{ id, confirmName: 'mismatch.invalid' }] })
      check('DELETE-MISMATCHED-NAME-REFUSED', wrongDelete.status === 200 && wrongDelete.data?.summary?.refused === 1 && wrongDelete.data?.results?.[0]?.code === 'VALIDATION', { status: wrongDelete.status, code: wrongDelete.data?.results?.[0]?.code ?? null })
      refused('EMPTY-SELECTION-VALIDATION', await root.post('/api/domains/bulk-actions', { action: 'category', category: 'x', domains: [] }), 'VALIDATION')
    },
  }),

  tool('aapanel-site-start-stop', {
    prefix: 'S17T06', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/site-settings)?$/,
    unit: [{ id: 'S17T06-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'site settings route owner stop and start swap the state, and an administrator stop stays' }],
    checks: ['ALREADY-RUNNING-VALIDATION', 'SITE-STOPPED-BY-OWNER', 'SITE-RESTARTED-BY-OWNER'],
    async run({ owner, fixture, check, refused, undo }) {
      const target = await ownerSite(owner, fixture)
      if (target.hasRealDomain) {
        undo('ensure site started', async () => {
          const cur = await owner.get('/api/domains')
          if (cur.status !== 200) return false
          const d = cur.data?.domains?.find(item => item.id === target.id)
          if (!d || !d.suspended) return true
          return (await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: cur.data.revision, suspended: false })).status === 200
        })
      }
      refused('ALREADY-RUNNING-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, suspended: false }), 'VALIDATION')
      const stopped = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, suspended: true })
      check('SITE-STOPPED-BY-OWNER', stopped.status === 200 && stopped.data?.domain?.suspended === true && stopped.data?.domain?.site?.stoppedByOwner === true, { status: stopped.status, suspended: stopped.data?.domain?.suspended ?? null })
      const nextRev = revOf(stopped.data?.revision)
      const started = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: nextRev, suspended: false })
      check('SITE-RESTARTED-BY-OWNER', started.status === 200 && started.data?.domain?.suspended === false, { status: started.status, suspended: started.data?.domain?.suspended ?? null })
    },
  }),

  tool('aapanel-site-expiry', {
    prefix: 'S17T07', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/site-settings)?$/,
    unit: [{ id: 'S17T07-UNIT-1', file: 'apps/agent/src/site-expiry.test.ts', name: 'site expiry monitor reconciles once when an expiry passes, across a restart, and again for a new date' }],
    checks: ['INVALID-DATE-VALIDATION', 'FUTURE-EXPIRY-SAVED', 'PERMANENT-CLEARS-EXPIRY'],
    async run({ owner, fixture, check, refused, undo }) {
      const target = await ownerSite(owner, fixture)
      if (target.hasRealDomain) {
        undo('clear site expiry', async () => {
          const cur = await owner.get('/api/domains')
          if (cur.status !== 200) return false
          const d = cur.data?.domains?.find(item => item.id === target.id)
          if (!d || d.expiresAt === null) return true
          return (await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: cur.data.revision, expiresAt: null })).status === 200
        })
      }
      refused('INVALID-DATE-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, expiresAt: 'not-a-date' }), 'VALIDATION')
      const saved = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, expiresAt: '2099-12-31T00:00:00.000Z' })
      check('FUTURE-EXPIRY-SAVED', saved.status === 200 && saved.data?.domain?.expiresAt === '2099-12-31T00:00:00.000Z', { status: saved.status, expiresAt: saved.data?.domain?.expiresAt ?? null })
      const cleared = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: revOf(saved.data?.revision), expiresAt: null })
      check('PERMANENT-CLEARS-EXPIRY', cleared.status === 200 && cleared.data?.domain?.expiresAt === null, { status: cleared.status, expiresAt: cleared.data?.domain?.expiresAt ?? null })
    },
  }),

  tool('aapanel-site-quota', {
    prefix: 'S17T08', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/site-settings)?$/,
    unit: [{ id: 'S17T08-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'site settings route refuses a path quota the filesystem cannot enforce, with the stable code' }],
    checks: ['QUOTA-CAPABILITY-OBSERVED', 'ZERO-QUOTA-VALIDATION', 'FILESYSTEM-QUOTA-CONTRACT'],
    async run({ owner, fixture, check, refused, undo }) {
      const target = await ownerSite(owner, fixture)
      const q = await owner.get(`/api/domains/${target.id}/site-settings`)
      const state = q.data?.quota?.state
      check('QUOTA-CAPABILITY-OBSERVED', q.status === 200 && typeof state === 'string', { status: q.status, state: state ?? null })
      refused('ZERO-QUOTA-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, pathQuotaMb: 0 }), 'VALIDATION')
      if (state === 'ready' && target.hasRealDomain) {
        undo('restore unlimited path quota', async () => {
          const cur = await owner.get('/api/domains')
          if (cur.status !== 200) return false
          const d = cur.data?.domains?.find(item => item.id === target.id)
          if (!d || d.pathQuotaMb === 'unlimited') return true
          return (await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: cur.data.revision, pathQuotaMb: 'unlimited' })).status === 200
        })
        const setRes = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, pathQuotaMb: 128 })
        const resetRes = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: revOf(setRes.data?.revision), pathQuotaMb: 'unlimited' })
        check('FILESYSTEM-QUOTA-CONTRACT', setRes.status === 200 && setRes.data?.domain?.pathQuotaMb === 128 && resetRes.status === 200, { status: setRes.status, resetStatus: resetRes.status })
      } else {
        refused('FILESYSTEM-QUOTA-CONTRACT', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, pathQuotaMb: 128 }), 'VALIDATION')
      }
    },
  }),

  tool('aapanel-site-directory', {
    prefix: 'S17T09', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36}\/site-settings)?|accounts\/[a-z][a-z0-9]{0,15}\/files)$/,
    unit: [{ id: 'S17T09-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'site settings route matches each setting to the sites it can work on' }],
    checks: ['TRAVERSAL-RUNDIR-VALIDATION', 'RUNDIR-SAVED-AND-SERVED', 'RUNDIR-RESTORED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const target = await ownerSite(owner, fixture)
      const sub = `xqpub_${tag}`
      if (target.hasRealDomain && target.rel) {
        const folderPath = `${target.rel}/${sub}`
        undo('restore site options', restoreSiteOptions(owner, target.id))
        undo('remove run-dir folder', discardFile(owner, fixture.username, folderPath))
        await owner.post(`/api/accounts/${fixture.username}/files`, { op: 'mkdir', path: folderPath })
        await owner.post(`/api/accounts/${fixture.username}/files`, { op: 'write', path: `${folderPath}/index.php`, content: `<?php echo "rundir-${tag}";` })
      }
      refused('TRAVERSAL-RUNDIR-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { runDirectory: '../escape' } }), 'VALIDATION')
      const saved = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { runDirectory: sub } })
      const served = saved.status === 200 && saved.data?.domain?.site?.runDirectory === sub
        ? await until(() => site.get(fixture.domain, '/'), res => res.status === 200 && res.text.includes(`rundir-${tag}`), { attempts: 8, delayMs: 1000 })
        : { settled: false, last: null }
      check('RUNDIR-SAVED-AND-SERVED', saved.status === 200 && saved.data?.domain?.site?.runDirectory === sub && served.settled, { status: saved.status, servedStatus: served.last?.status ?? null })
      const restored = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: revOf(saved.data?.revision), site: {} })
      check('RUNDIR-RESTORED', restored.status === 200 && !restored.data?.domain?.site?.runDirectory, { status: restored.status })
    },
  }),

  tool('aapanel-deny-access', {
    prefix: 'S17T10', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/(?:domains(?:\/[0-9a-f-]{36}\/site-settings)?|accounts\/[a-z][a-z0-9]{0,15}\/files)$/,
    unit: [{ id: 'S17T10-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'site settings route saves settings through the domain workspace' }],
    checks: ['INVALID-DENY-RULE-VALIDATION', 'DENY-RULE-BLOCKS-EXTENSION', 'DENY-RULE-REMOVED'],
    async run({ owner, fixture, tag, site, check, refused, undo, until }) {
      const target = await ownerSite(owner, fixture)
      const dirName = `xqup_${tag}`
      if (target.hasRealDomain && target.rel) {
        const folderPath = `${target.rel}/${dirName}`
        undo('restore deny rules', restoreSiteOptions(owner, target.id))
        undo('remove uploads folder', discardFile(owner, fixture.username, folderPath))
        await owner.post(`/api/accounts/${fixture.username}/files`, { op: 'mkdir', path: folderPath })
        await owner.post(`/api/accounts/${fixture.username}/files`, { op: 'write', path: `${folderPath}/x.php`, content: '<?php echo "blocked";' })
        await owner.post(`/api/accounts/${fixture.username}/files`, { op: 'write', path: `${folderPath}/x.txt`, content: 'allowed-asset' })
      }
      refused('INVALID-DENY-RULE-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { denyRules: [{ name: '', directory: '../bad', extensions: [] }] } }), 'VALIDATION')
      const saved = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { denyRules: [{ name: `deny-${tag}`, directory: `/${dirName}`, extensions: ['php'] }] } })
      let blocked403 = false, allowed200 = false
      if (saved.status === 200 && Array.isArray(saved.data?.domain?.site?.denyRules)) {
        const denied = await until(() => site.get(fixture.domain, `/${dirName}/x.php`), res => res.status === 403, { attempts: 8, delayMs: 1000 })
        const allowed = await site.get(fixture.domain, `/${dirName}/x.txt`)
        blocked403 = denied.settled
        allowed200 = allowed.status === 200
      }
      check('DENY-RULE-BLOCKS-EXTENSION', saved.status === 200 && blocked403 && allowed200, { status: saved.status, blocked403, allowed200 })
      const cleared = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: revOf(saved.data?.revision), site: {} })
      check('DENY-RULE-REMOVED', cleared.status === 200 && !cleared.data?.domain?.site?.denyRules?.length, { status: cleared.status })
    },
  }),

  tool('aapanel-traffic-control', {
    prefix: 'S17T11', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/site-settings)?$/,
    unit: [{ id: 'S17T11-UNIT-1', file: 'apps/agent/src/traffic-monitor.test.ts', name: 'traffic monitoring maps aliases to one log and ignores foreign account domains' }],
    checks: ['INVALID-TRAFFIC-LIMIT-VALIDATION', 'TRAFFIC-LIMITS-APPLIED', 'TRAFFIC-LIMITS-CLEARED'],
    async run({ owner, fixture, check, refused, undo }) {
      const target = await ownerSite(owner, fixture)
      if (target.hasRealDomain) undo('restore traffic settings', restoreSiteOptions(owner, target.id))
      refused('INVALID-TRAFFIC-LIMIT-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { traffic: { siteConnections: -1, ipConnections: 0, rateKbPerConnection: -1 } } }), 'VALIDATION')
      const saved = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { traffic: { siteConnections: 32, ipConnections: 4, rateKbPerConnection: 256 } } })
      check('TRAFFIC-LIMITS-APPLIED', saved.status === 200 && saved.data?.domain?.site?.traffic?.ipConnections === 4 && saved.data?.domain?.site?.traffic?.rateKbPerConnection === 256, { status: saved.status, ipConnections: saved.data?.domain?.site?.traffic?.ipConnections ?? null })
      const cleared = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: revOf(saved.data?.revision), site: {} })
      check('TRAFFIC-LIMITS-CLEARED', cleared.status === 200 && !cleared.data?.domain?.site?.traffic, { status: cleared.status })
    },
  }),

  tool('aapanel-url-rewrite', {
    prefix: 'S17T12', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/htaccess)?$/,
    unit: [{ id: 'S17T12-UNIT-1', file: 'apps/agent/src/htaccess-workspace.test.ts', name: 'protected .htaccess policy and migration accepts per-directory rewrites and refuses privileged or executable directives' }],
    checks: ['HTACCESS-DOCUMENT-READ', 'PRIVILEGED-DIRECTIVE-FLAGGED', 'MALFORMED-REVISION-VALIDATION'],
    async run({ owner, fixture, check, refused }) {
      const target = await ownerSite(owner, fixture)
      const view = await owner.get(`/api/domains/${target.id}/htaccess`)
      const docRev = revOf(view.data?.document?.revision)
      check('HTACCESS-DOCUMENT-READ', view.status === 200 && typeof view.data?.document?.revision === 'string' && typeof view.data?.capabilities?.canValidate === 'boolean', { status: view.status })
      const validated = await owner.post(`/api/domains/${target.id}/htaccess`, { content: 'Action x-httpd-php /cgi-bin/php\n', expectedRevision: docRev })
      check('PRIVILEGED-DIRECTIVE-FLAGGED', validated.status === 200 && validated.data?.validation?.valid === false && Array.isArray(validated.data?.validation?.issues) && validated.data.validation.issues.length > 0, { status: validated.status, valid: validated.data?.validation?.valid ?? null })
      refused('MALFORMED-REVISION-VALIDATION', await owner.put(`/api/domains/${target.id}/htaccess`, { content: 'RewriteEngine On\n', expectedRevision: 'bad' }), 'VALIDATION')
    },
  }),

  tool('aapanel-site-config-editor', {
    prefix: 'S17T13', as: 'owner', needs: ['account'], probe: '/api/domains',
    paths: /^\/api\/domains(?:\/[0-9a-f-]{36}\/site-settings)?$/,
    unit: [{ id: 'S17T13-UNIT-1', file: 'apps/api/src/site-settings-workspace.test.ts', name: 'site settings route rolls the saved settings back when the configuration test fails' }],
    checks: ['SERVER-HELD-KEY-REFUSED', 'USERDATA-DROPIN-APPLIED-AND-RESTORED', 'NOOP-SAVE-VALIDATION'],
    async run({ owner, fixture, check, refused, undo }) {
      const target = await ownerSite(owner, fixture)
      if (target.hasRealDomain) undo('restore visitorLogOff drop-in', restoreSiteOptions(owner, target.id))
      refused('SERVER-HELD-KEY-REFUSED', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { category: 'unauthorized' } }), 'VALIDATION')
      const saved = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: target.rev, site: { visitorLogOff: true } })
      const nextRev = revOf(saved.data?.revision)
      refused('NOOP-SAVE-VALIDATION', await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: nextRev, site: { visitorLogOff: true } }), 'VALIDATION')
      const restored = await owner.put(`/api/domains/${target.id}/site-settings`, { expectedRevision: nextRev, site: {} })
      check('USERDATA-DROPIN-APPLIED-AND-RESTORED', saved.status === 200 && saved.data?.domain?.site?.visitorLogOff === true && restored.status === 200 && !restored.data?.domain?.site?.visitorLogOff, { saveStatus: saved.status, restoreStatus: restored.status })
    },
  }),

  tool('aapanel-composer', {
    prefix: 'S17T14', as: 'root', needs: ['account'], probe: '/api/server/composer',
    paths: /^\/api\/(?:domains|server\/composer(?:\?domainId=\.\.\/escape|\/jobs\/preview)?)$/,
    unit: [{ id: 'S17T14-UNIT-1', file: 'apps/agent/src/composer-job.test.ts', name: 'Composer job as the account refuses a folder without composer.json with 422 COMPOSER_JSON_MISSING' }],
    checks: ['COMPOSER-SITES-OBSERVED', 'MISSING-MANIFEST-REFUSED', 'ARBITRARY-SELECTOR-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const view = await root.get('/api/server/composer')
      const domains = await root.get('/api/domains')
      const row = Array.isArray(domains.data?.domains) ? domains.data.domains.find(d => d.name === fixture.domain) : null
      const domainId = uuidOrZero(row?.id)
      const phpVersion = typeof row?.php?.version === 'string' ? row.php.version : '8.3'
      check('COMPOSER-SITES-OBSERVED', view.status === 200 && Array.isArray(view.data?.projects), { status: view.status, projects: Array.isArray(view.data?.projects) ? view.data.projects.length : null })
      const preview = await root.post('/api/server/composer/jobs/preview', { action: 'install', domainId, phpVersion, mirror: null })
      check('MISSING-MANIFEST-REFUSED', preview.status >= 400 && preview.status < 500 && typeof preview.data?.code === 'string', { status: preview.status, code: preview.data?.code ?? null })
      refused('ARBITRARY-SELECTOR-VALIDATION', await root.get('/api/server/composer?domainId=../escape'), 'VALIDATION')
    },
  }),

  tool('aapanel-https-protection', {
    prefix: 'S17T15', as: 'root', probe: '/api/server/default-site',
    paths: /^\/api\/server\/default-site(?:\/requests|\?selector=1)?$/,
    unit: [{ id: 'S17T15-UNIT-1', file: 'apps/agent/src/default-site-observation.test.ts', name: 'bounded default-vhost request observations projects only approved table columns and converts actual log time to ASCII UTC' }],
    checks: ['DEFAULT-SITE-POLICY-READ', 'UNMATCHED-REQUESTS-OBSERVED', 'QUERY-SELECTOR-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/default-site')
      const reqs = await root.get('/api/server/default-site/requests')
      check('DEFAULT-SITE-POLICY-READ', view.status === 200 && view.data?.configuration?.state === 'read' && typeof view.data?.configuration?.policy?.refuseHttps === 'boolean', { status: view.status, refuseHttps: view.data?.configuration?.policy?.refuseHttps ?? null })
      check('UNMATCHED-REQUESTS-OBSERVED', reqs.status === 200 && ['read', 'partial', 'unavailable'].includes(reqs.data?.observation?.state), { status: reqs.status, state: reqs.data?.observation?.state ?? null })
      refused('QUERY-SELECTOR-VALIDATION', await root.get('/api/server/default-site?selector=1'), 'VALIDATION')
    },
  }),

  tool('aapanel-panel-port', {
    prefix: 'S17T16', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/binding)?$/,
    unit: [{ id: 'S17T16-UNIT-1', file: 'apps/agent/src/panel-access.test.ts', name: 'panel access host routes reports a port the kernel will not bind' }],
    checks: ['PANEL-BINDING-OBSERVED', 'OUT-OF-RANGE-PORT-VALIDATION', 'DUPLICATE-LISTENER-PORT-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      check('PANEL-BINDING-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string', { status: view.status, state: view.data?.state ?? null })
      refused('OUT-OF-RANGE-PORT-VALIDATION', await root.put('/api/server/panel-access/binding', { ports: { xwhm: 70000, xpanel: 2083, xmail: 2096 }, hosts: { xwhm: null, xpanel: null, xmail: null } }), 'VALIDATION')
      refused('DUPLICATE-LISTENER-PORT-VALIDATION', await root.put('/api/server/panel-access/binding', { ports: { xwhm: 2087, xpanel: 2087, xmail: 2096 }, hosts: { xwhm: null, xpanel: null, xmail: null } }), 'CONFLICT')
    },
  }),

  tool('aapanel-security-entrance', {
    prefix: 'S17T17', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/(?:entrance|gate))?$/,
    unit: [{ id: 'S17T17-UNIT-1', file: 'apps/api/src/panel-access.http.test.ts', name: 'entrance and unauthenticated response hides the panel without the entrance and shows the sign-in after it' }],
    checks: ['CANDIDATE-ENTRANCE-GENERATED', 'SHORT-ENTRANCE-VALIDATION', 'RESERVED-PATH-ENTRANCE-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      const rev = revOf(view.data?.revision)
      const generated = await root.post('/api/server/panel-access/entrance', {})
      check('CANDIDATE-ENTRANCE-GENERATED', view.status === 200 && generated.status === 200 && typeof generated.data?.path === 'string' && generated.data.path.length >= 8, { status: generated.status, length: generated.data?.path?.length ?? null })
      refused('SHORT-ENTRANCE-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: { path: 'short', listeners: ['xwhm'] }, response: { kind: '404' }, basicAuth: null, stopped: [], expectedRevision: rev }), 'VALIDATION')
      refused('RESERVED-PATH-ENTRANCE-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: { path: 'api/login', listeners: ['xwhm'] }, response: { kind: '404' }, basicAuth: null, stopped: [], expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-unauth-response', {
    prefix: 'S17T18', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/gate)?$/,
    unit: [{ id: 'S17T18-UNIT-1', file: 'apps/api/src/panel-access.http.test.ts', name: 'entrance and unauthenticated response answers with the configured response and spares machine routes' }],
    checks: ['GATE-RESPONSE-POLICY-READ', 'UNKNOWN-RESPONSE-KIND-VALIDATION', 'INSECURE-REDIRECT-TARGET-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      const rev = revOf(view.data?.revision)
      check('GATE-RESPONSE-POLICY-READ', view.status === 200 && typeof view.data?.gate?.response?.kind === 'string', { status: view.status, kind: view.data?.gate?.response?.kind ?? null })
      refused('UNKNOWN-RESPONSE-KIND-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: null, response: { kind: '500' }, basicAuth: null, stopped: [], expectedRevision: rev }), 'VALIDATION')
      refused('INSECURE-REDIRECT-TARGET-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: null, response: { kind: 'redirect', target: 'javascript:alert(1)' }, basicAuth: null, stopped: [], expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-panel-domain', {
    prefix: 'S17T19', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/binding)?$/,
    unit: [{ id: 'S17T19-UNIT-1', file: 'apps/agent/src/panel-access.test.ts', name: 'panel access host routes opens the new port first, then hands the switch to the management lifecycle with a deadline' }],
    checks: ['PANEL-HOSTS-OBSERVED', 'BARE-IPV4-HOST-VALIDATION', 'MALFORMED-HOSTNAME-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      check('PANEL-HOSTS-OBSERVED', view.status === 200 && typeof view.data?.revision === 'string', { status: view.status })
      refused('BARE-IPV4-HOST-VALIDATION', await root.put('/api/server/panel-access/binding', { ports: { xwhm: 2087, xpanel: 2083, xmail: 2096 }, hosts: { xwhm: '198.51.100.10', xpanel: null, xmail: null } }), 'VALIDATION')
      refused('MALFORMED-HOSTNAME-VALIDATION', await root.put('/api/server/panel-access/binding', { ports: { xwhm: 2087, xpanel: 2083, xmail: 2096 }, hosts: { xwhm: 'bad..host', xpanel: null, xmail: null } }), 'VALIDATION')
    },
  }),

  tool('aapanel-basic-auth', {
    prefix: 'S17T20', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/gate)?$/,
    unit: [{ id: 'S17T20-UNIT-1', file: 'apps/api/src/panel-access.http.test.ts', name: 'entrance and unauthenticated response admits a valid token through basic authentication, and a cluster peer through both' }],
    checks: ['BASIC-AUTH-STATE-OBSERVED', 'WEAK-CREDENTIAL-VALIDATION', 'COLON-USERNAME-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      const rev = revOf(view.data?.revision)
      check('BASIC-AUTH-STATE-OBSERVED', view.status === 200 && (view.data?.gate?.basicAuth === null || typeof view.data?.gate?.basicAuth?.username === 'string'), { status: view.status, configured: view.data?.gate?.basicAuth !== null })
      refused('WEAK-CREDENTIAL-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: null, response: { kind: '404' }, basicAuth: { username: 'gateadmin', password: '123', listeners: ['xwhm'] }, stopped: [], expectedRevision: rev }), 'VALIDATION')
      refused('COLON-USERNAME-VALIDATION', await root.put('/api/server/panel-access/gate', { entrance: null, response: { kind: '404' }, basicAuth: { username: 'bad:name', password: 'Xq-StrongGateValue99!', listeners: ['xwhm'] }, stopped: [], expectedRevision: rev }), 'VALIDATION')
    },
  }),

  tool('aapanel-temporary-login', {
    prefix: 'S17T21', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\/temporary-logins(?:\/[0-9a-f]{16}(?:\/activity)?)?)?$/,
    unit: [{ id: 'S17T21-UNIT-1', file: 'apps/api/src/panel-access-cli.test.ts', name: 'xpanel panel-access shows the entrance a locked-out owner needs, without the password hash' }],
    checks: ['SHORT-LIFETIME-VALIDATION', 'TEMPORARY-LINK-CREATED-AND-ACTIVITY-READ', 'TEMPORARY-LINK-REVOKED'],
    async run({ root, tag, check, refused, undo }) {
      refused('SHORT-LIFETIME-VALIDATION', await root.post('/api/server/panel-access/temporary-logins', { lifetimeMinutes: 1, note: 'too-short' }), 'VALIDATION')
      const created = await root.post('/api/server/panel-access/temporary-logins', { lifetimeMinutes: 10, note: `xq-${tag}` })
      const rawId = created.data?.id
      const linkId = typeof rawId === 'string' && TEMP_ID_RE.test(rawId) ? rawId : '0'.repeat(16)
      if (typeof rawId === 'string' && TEMP_ID_RE.test(rawId)) {
        undo(`revoke temporary login ${rawId}`, async () => {
          const rev = await root.delete(`/api/server/panel-access/temporary-logins/${rawId}`)
          return rev.status === 200 || rev.status === 404
        })
      }
      const activity = await root.get(`/api/server/panel-access/temporary-logins/${linkId}/activity`)
      check('TEMPORARY-LINK-CREATED-AND-ACTIVITY-READ', created.status === 201 && typeof rawId === 'string' && TEMP_ID_RE.test(rawId) && created.data?.state === 'unused' && activity.status === 200 && Array.isArray(activity.data?.rows), { createStatus: created.status, activityStatus: activity.status })
      const revoked = await root.delete(`/api/server/panel-access/temporary-logins/${linkId}`)
      check('TEMPORARY-LINK-REVOKED', revoked.status === 200 && revoked.data?.state === 'revoked' && typeof revoked.data?.revokedAt === 'string', { status: revoked.status, state: revoked.data?.state ?? null })
    },
  }),

  tool('aapanel-recovery-cli', {
    prefix: 'S17T22', as: 'root', probe: '/api/server/panel-access',
    paths: /^\/api\/server\/panel-access(?:\?selector=1|\/service)?$/,
    unit: [{ id: 'S17T22-UNIT-1', file: 'apps/api/src/cli-security.test.ts', name: 'CLI: explicit one-time root provisioning keeps reset-password as recovery for an existing principal only' }],
    checks: ['PANEL-ACCESS-VIEW-OBSERVED', 'QUERY-SELECTOR-VALIDATION', 'INVALID-SERVICE-ACTION-VALIDATION'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/panel-access')
      check('PANEL-ACCESS-VIEW-OBSERVED', view.status === 200 && Array.isArray(view.data?.temporaryLogins) && typeof view.data?.revision === 'string', { status: view.status })
      refused('QUERY-SELECTOR-VALIDATION', await root.get('/api/server/panel-access?selector=1'), 'VALIDATION')
      refused('INVALID-SERVICE-ACTION-VALIDATION', await root.post('/api/server/panel-access/service', { action: 'stop' }), 'VALIDATION')
    },
  }),

  tool('aapanel-panel-logs', {
    prefix: 'S17T23', as: 'root', probe: '/api/audit',
    paths: /^\/api\/audit(?:\?(?:limit=10|outcome=invalid))?$/,
    unit: [{ id: 'S17T23-UNIT-1', file: 'apps/api/src/audit-api.test.ts', name: 'authenticated audit query HTTP contract filters outcome and inclusive UTC dates before applying a one-row page' }],
    checks: ['AUDIT-ENTRIES-OBSERVED', 'BOUNDED-PAGE-READ', 'INVALID-OUTCOME-FILTER-VALIDATION'],
    async run({ root, check, refused }) {
      const full = await root.get('/api/audit')
      const bounded = await root.get('/api/audit?limit=10')
      check('AUDIT-ENTRIES-OBSERVED', full.status === 200 && Array.isArray(full.data?.entries) && full.data.entries.length >= 1, { status: full.status, entries: Array.isArray(full.data?.entries) ? full.data.entries.length : null })
      check('BOUNDED-PAGE-READ', bounded.status === 200 && Array.isArray(bounded.data?.entries) && bounded.data.entries.length <= 10, { status: bounded.status, count: Array.isArray(bounded.data?.entries) ? bounded.data.entries.length : null })
      refused('INVALID-OUTCOME-FILTER-VALIDATION', await root.get('/api/audit?outcome=invalid'), 'VALIDATION')
    },
  }),

  tool('xpanel-notifications', {
    prefix: 'S17T24', as: 'owner', also: ['root'], needs: ['account'], probe: '/api/account/announcements',
    paths: /^\/api\/(?:server\/announcements(?:\/[0-9a-f-]{36}\/archive)?|account\/announcements(?:\/[0-9a-f-]{36}\/dismiss)?)$/,
    unit: [{ id: 'S17T24-UNIT-1', file: 'apps/api/src/whm-home-workspace.test.ts', name: 'WHM notifications turns a failed backup run into one unread item, read once marked' }],
    checks: ['TARGETED-ANNOUNCEMENT-VISIBLE', 'DISMISS-CLEARS-UNREAD', 'UNKNOWN-AUDIENCE-VALIDATION'],
    async run({ owner, root, fixture, tag, check, refused, undo }) {
      const manage = await root.get('/api/server/announcements')
      const rev = revOf(manage.data?.revision)
      refused('UNKNOWN-AUDIENCE-VALIDATION', await root.post('/api/server/announcements', {
        title: { en: `Notice ${tag}`, ar: `Notice ${tag}` },
        body: { en: 'Body', ar: 'Body' },
        severity: 'info',
        audience: { kind: 'accounts', usernames: ['xqmissing99'] },
        startsAt: null,
        endsAt: null,
        expectedRevision: rev,
      }), 'VALIDATION')
      const created = await root.post('/api/server/announcements', {
        title: { en: `Notice ${tag}`, ar: `Notice ${tag}` },
        body: { en: `Announcement ${tag}`, ar: `Announcement ${tag}` },
        severity: 'info',
        audience: { kind: 'accounts', usernames: [fixture.username] },
        startsAt: null,
        endsAt: null,
        expectedRevision: rev,
      })
      const createdId = created.data?.changed
      const annId = uuidOrZero(createdId)
      if (typeof createdId === 'string' && UUID_RE.test(createdId)) {
        undo(`archive announcement ${createdId}`, async () => {
          const cur = await root.get('/api/server/announcements')
          if (cur.status !== 200) return false
          const item = cur.data?.announcements?.find(a => a.id === createdId)
          if (!item || item.status === 'archived') return true
          return (await root.post(`/api/server/announcements/${createdId}/archive`, { expectedRevision: cur.data.revision })).status === 200
        })
      }
      const before = await owner.get('/api/account/announcements')
      check('TARGETED-ANNOUNCEMENT-VISIBLE', created.status === 200 && before.status === 200 && Array.isArray(before.data?.announcements) && before.data.announcements.some(a => a.id === annId), { createStatus: created.status, listStatus: before.status })
      const dismissed = await owner.post(`/api/account/announcements/${annId}/dismiss`, undefined, { noBody: true })
      const after = await owner.get('/api/account/announcements')
      check('DISMISS-CLEARS-UNREAD', dismissed.status === 200 && after.status === 200 && Array.isArray(after.data?.announcements) && !after.data.announcements.some(a => a.id === annId), { dismissStatus: dismissed.status, afterStatus: after.status })
    },
  }),

  tool('xpanel-general-info', {
    prefix: 'S17T25', as: 'owner', needs: ['account'], probe: '/api/auth/me',
    paths: /^\/api\/(?:auth\/(?:me|sessions)|accounts|domains)$/,
    unit: [{ id: 'S17T25-UNIT-1', file: 'apps/web/src/board-port/xpanel-home.test.ts', name: 'xPanel home board port binds the account and leaves unknown usage empty' }],
    checks: ['IDENTITY-BOUND-TO-ACCOUNT', 'PRIMARY-DOMAIN-AND-IPS-OBSERVED', 'ACTIVE-SESSIONS-OBSERVED'],
    async run({ owner, fixture, check }) {
      const me = await owner.get('/api/auth/me')
      const accounts = await owner.get('/api/accounts')
      const domains = await owner.get('/api/domains')
      const sessions = await owner.get('/api/auth/sessions')
      const acc = Array.isArray(accounts.data?.accounts) ? accounts.data.accounts[0] : null
      const primary = Array.isArray(domains.data?.domains) ? domains.data.domains.find(d => d.kind === 'primary') : null
      check('IDENTITY-BOUND-TO-ACCOUNT', me.status === 200 && me.data?.principal?.username === fixture.username && accounts.status === 200 && acc?.username === fixture.username, { meStatus: me.status, accountStatus: accounts.status })
      check('PRIMARY-DOMAIN-AND-IPS-OBSERVED', domains.status === 200 && primary?.name === fixture.domain && typeof acc?.home === 'string', { domainStatus: domains.status, primary: primary?.name ?? null })
      check('ACTIVE-SESSIONS-OBSERVED', sessions.status === 200 && Array.isArray(sessions.data?.sessions) && sessions.data.sessions.length >= 1, { status: sessions.status, count: Array.isArray(sessions.data?.sessions) ? sessions.data.sessions.length : null })
    },
  }),

  tool('xpanel-usage-stats-panel', {
    prefix: 'S17T26', as: 'owner', needs: ['account'], probe: '/api/accounts',
    paths: /^\/api\/(?:accounts|domains|databases|service-users)$/,
    unit: [{ id: 'S17T26-UNIT-1', file: 'apps/agent/src/account-usage.test.ts', name: 'account usage sample requires the assigned IO quantities and home device instead of any numeric wbps' }],
    checks: ['ACCOUNT-QUOTA-LIMITS-OBSERVED', 'DOMAIN-CAPS-OBSERVED', 'DATABASE-AND-MAILBOX-COUNTS-READ'],
    async run({ owner, fixture, check }) {
      const accounts = await owner.get('/api/accounts')
      const domains = await owner.get('/api/domains')
      const dbs = await owner.get('/api/databases')
      const users = await owner.get('/api/service-users')
      const acc = Array.isArray(accounts.data?.accounts) ? accounts.data.accounts.find(a => a.username === fixture.username) : null
      check('ACCOUNT-QUOTA-LIMITS-OBSERVED', accounts.status === 200 && !!acc && typeof acc.planId === 'string', { status: accounts.status, found: !!acc })
      check('DOMAIN-CAPS-OBSERVED', domains.status === 200 && Array.isArray(domains.data?.domains) && domains.data.domains.length >= 1 && typeof domains.data?.limits === 'object' && domains.data.limits !== null, { status: domains.status })
      check('DATABASE-AND-MAILBOX-COUNTS-READ', dbs.status === 200 && Array.isArray(dbs.data?.databases) && users.status === 200 && Array.isArray(users.data?.serviceUsers), { dbStatus: dbs.status, userStatus: users.status })
    },
  }),

  tool('xpanel-server-information', {
    prefix: 'S17T27', as: 'owner', needs: ['account'], probe: '/api/account/server-information',
    paths: /^\/api\/account\/server-information(?:\?extra=1)?$/,
    unit: [{ id: 'S17T27-UNIT-1', file: 'apps/web/src/whm-server-info-client.test.ts', name: 'server information binding rejects partial or inconsistent host measurements' }],
    checks: ['HOST-FACTS-AND-SERVICES-OBSERVED', 'QUERY-SELECTOR-VALIDATION'],
    async run({ owner, check, refused }) {
      const info = await owner.get('/api/account/server-information')
      check('HOST-FACTS-AND-SERVICES-OBSERVED', info.status === 200 && typeof info.data === 'object' && info.data !== null && (typeof info.data.hostname === 'string' || typeof info.data.host?.hostname === 'string' || Array.isArray(info.data.services)), { status: info.status })
      refused('QUERY-SELECTOR-VALIDATION', await owner.get('/api/account/server-information?extra=1'), 'VALIDATION')
    },
  }),

  tool('xpanel-onboarding-assistant', {
    prefix: 'S17T28', as: 'owner', needs: ['account'], probe: '/api/auth/personal-preferences',
    paths: /^\/api\/auth\/personal-preferences$/,
    unit: [{ id: 'S17T28-UNIT-1', file: 'apps/api/src/admin-preferences.test.ts', name: 'administrator preferences grammar and read projection accepts only the exact bounded three choices and revision' }],
    checks: ['NEW-ACCOUNT-ONBOARDING-VISIBLE', 'UNKNOWN-LOCALE-VALIDATION', 'DISMISSAL-PERSISTS'],
    async run({ owner, check, refused, undo }) {
      const initial = await owner.get('/api/auth/personal-preferences')
      const rev = revOf(initial.data?.revision)
      const origDismissed = Boolean(initial.data?.onboardingDismissed)
      if (initial.status === 200 && typeof initial.data?.revision === 'string') {
        undo('restore onboarding state', async () => {
          const cur = await owner.get('/api/auth/personal-preferences')
          if (cur.status !== 200 || typeof cur.data?.revision !== 'string') return false
          if (cur.data?.onboardingDismissed === origDismissed) return true
          return (await owner.put('/api/auth/personal-preferences', {
            locale: cur.data?.locale ?? null,
            noticePosition: cur.data?.noticePosition ?? 'bottom-right',
            notifications: cur.data?.notifications ?? { disk: true, bandwidth: true, announcements: true },
            onboardingDismissed: origDismissed,
            expectedRevision: cur.data.revision,
          })).status === 200
        })
      }
      check('NEW-ACCOUNT-ONBOARDING-VISIBLE', initial.status === 200 && initial.data?.onboardingDismissed === false && typeof initial.data?.revision === 'string', { status: initial.status, dismissed: initial.data?.onboardingDismissed ?? null })
      refused('UNKNOWN-LOCALE-VALIDATION', await owner.put('/api/auth/personal-preferences', {
        locale: 'zz-INVALID',
        noticePosition: 'bottom-right',
        notifications: { disk: true, bandwidth: true, announcements: true },
        onboardingDismissed: false,
        expectedRevision: rev,
      }), 'VALIDATION')
      const saved = await owner.put('/api/auth/personal-preferences', {
        locale: initial.data?.locale ?? null,
        noticePosition: initial.data?.noticePosition ?? 'bottom-right',
        notifications: initial.data?.notifications ?? { disk: true, bandwidth: true, announcements: true },
        onboardingDismissed: true,
        expectedRevision: rev,
      })
      const reread = await owner.get('/api/auth/personal-preferences')
      check('DISMISSAL-PERSISTS', saved.status === 200 && saved.data?.onboardingDismissed === true && reread.status === 200 && reread.data?.onboardingDismissed === true, { saveStatus: saved.status, rereadDismissed: reread.data?.onboardingDismissed ?? null })
    },
  }),

  tool('nginx-cache-control', {
    prefix: 'S17T29', as: 'owner', needs: ['account'], probe: '/api/account/edge-cache',
    paths: /^\/api\/account\/edge-cache$/,
    unit: [{ id: 'S17T29-UNIT-1', file: 'apps/api/src/nginx-proxy-workspace.test.ts', name: 'NGINX Reverse Proxy Manager switches and purges the cache per account and in bulk, leaving others alone' }],
    checks: ['CACHE-PURGED', 'CACHE-DISABLED-AND-REENABLED', 'UNCHANGED-OP-VALIDATION'],
    async run({ owner, check, refused, undo }) {
      const initial = await owner.get('/api/account/edge-cache')
      if (initial.status === 200 && typeof initial.data?.revision === 'string') {
        undo('restore account edge cache enabled', async () => {
          const cur = await owner.get('/api/account/edge-cache')
          if (cur.status !== 200) return false
          if (cur.data?.enabled === true) return true
          return (await owner.post('/api/account/edge-cache', { expectedRevision: cur.data.revision, op: 'enable' })).status === 200
        })
      }
      const purged = await owner.post('/api/account/edge-cache', { expectedRevision: revOf(initial.data?.revision), op: 'purge' })
      check('CACHE-PURGED', purged.status === 200 && typeof purged.data?.purgedAt === 'string', { status: purged.status })
      const disabled = await owner.post('/api/account/edge-cache', { expectedRevision: revOf(purged.data?.revision), op: 'disable' })
      refused('UNCHANGED-OP-VALIDATION', await owner.post('/api/account/edge-cache', { expectedRevision: revOf(disabled.data?.revision), op: 'disable' }), 'VALIDATION')
      const enabled = await owner.post('/api/account/edge-cache', { expectedRevision: revOf(disabled.data?.revision), op: 'enable' })
      check('CACHE-DISABLED-AND-REENABLED', disabled.status === 200 && disabled.data?.enabled === false && enabled.status === 200 && enabled.data?.enabled === true, { disableStatus: disabled.status, enableStatus: enabled.status })
    },
  }),

  tool('whm-home-favorites', {
    prefix: 'S17T30', as: 'root', probe: '/api/admin/favorites', restores: ['/api/admin/favorites'],
    paths: /^\/api\/admin\/favorites$/,
    unit: [{ id: 'S17T30-UNIT-1', file: 'apps/api/src/whm-home-workspace.test.ts', name: 'WHM favorites holds distinct WHM pages only' }],
    checks: ['FAVORITES-READ', 'NON-WHM-ROUTE-VALIDATION', 'FAVORITE-STARRED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/admin/favorites')
      const origRoutes = Array.isArray(before.data?.routes) ? before.data.routes : []
      const origDesc = typeof before.data?.descriptions === 'boolean' ? before.data.descriptions : true
      check('FAVORITES-READ', before.status === 200 && Array.isArray(before.data?.routes) && typeof before.data?.descriptions === 'boolean', { status: before.status, count: origRoutes.length })
      refused('NON-WHM-ROUTE-VALIDATION', await root.put('/api/admin/favorites', { routes: ['/domains'], descriptions: true }), 'VALIDATION')
      if (before.status === 200 && Array.isArray(before.data?.routes)) {
        undo('restore root favorites', async () => {
          const back = await root.put('/api/admin/favorites', { routes: origRoutes, descriptions: origDesc })
          return back.status === 200
        })
      }
      const nextRoutes = origRoutes.includes('/whm/domains') ? origRoutes.filter(r => r !== '/whm/domains') : [...origRoutes, '/whm/domains'].slice(0, 24)
      const saved = await root.put('/api/admin/favorites', { routes: nextRoutes, descriptions: origDesc })
      const restored = await root.put('/api/admin/favorites', { routes: origRoutes, descriptions: origDesc })
      check('FAVORITE-STARRED-AND-RESTORED', saved.status === 200 && JSON.stringify(saved.data?.routes) === JSON.stringify(nextRoutes) && restored.status === 200, { saveStatus: saved.status, restoreStatus: restored.status })
    },
  }),

  tool('whm-notifications', {
    prefix: 'S17T31', as: 'root', probe: '/api/admin/notifications',
    paths: /^\/api\/admin\/notifications(?:\/read)?$/,
    unit: [{ id: 'S17T31-UNIT-1', file: 'apps/api/src/whm-home-workspace.test.ts', name: 'WHM notifications sorts newest first and keeps the list when the backup read fails' }],
    checks: ['INBOX-OBSERVED', 'MALFORMED-ID-VALIDATION', 'EMPTY-IDS-VALIDATION'],
    async run({ root, check, refused }) {
      const inbox = await root.get('/api/admin/notifications')
      check('INBOX-OBSERVED', inbox.status === 200 && Array.isArray(inbox.data?.items) && typeof inbox.data?.unread === 'number', { status: inbox.status, unread: inbox.data?.unread ?? null })
      refused('MALFORMED-ID-VALIDATION', await root.post('/api/admin/notifications/read', { ids: ['invalid-id'] }), 'VALIDATION')
      refused('EMPTY-IDS-VALIDATION', await root.post('/api/admin/notifications/read', { ids: [] }), 'VALIDATION')
    },
  }),

  tool('incoming-mail-country-filter', {
    prefix: 'S17T32', as: 'root', probe: '/api/server/mailx/country',
    page: { route: '/whm/email/spam', read: '/api/server/mailx/country', shows: () => ['Inbound spam protection'] },
    paths: /^\/api\/server\/mailx\/country$/,
    unit: [{ id: 'S17T32-UNIT-1', file: 'apps/agent/src/mail-country-filter.test.ts', name: 'country networks returns only the networks of the blocked countries' }],
    checks: ['COUNTRY-POLICY-AND-GEOIP-READ', 'INVALID-COUNTRY-CODE-VALIDATION', 'GEOIP-ADMISSION-OR-EMPTY-POLICY'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mailx/country')
      const rev = revOf(view.data?.revision)
      const installed = view.data?.geoip?.installed === true
      check('COUNTRY-POLICY-AND-GEOIP-READ', view.status === 200 && view.data?.section === 'country' && Array.isArray(view.data?.policy?.blocked) && typeof view.data?.geoip?.installed === 'boolean', { status: view.status, geoipInstalled: installed })
      refused('INVALID-COUNTRY-CODE-VALIDATION', await root.put('/api/server/mailx/country', { policy: { blocked: ['ZZZ'] }, expectedRevision: rev }), 'VALIDATION')
      if (!installed) {
        refused('GEOIP-ADMISSION-OR-EMPTY-POLICY', await root.put('/api/server/mailx/country', { policy: { blocked: ['AQ'] }, expectedRevision: rev }), 'PRECONDITION_FAILED')
      } else {
        refused('GEOIP-ADMISSION-OR-EMPTY-POLICY', await root.put('/api/server/mailx/country', { policy: { blocked: ['aq'] }, expectedRevision: rev }), 'VALIDATION')
      }
    },
  }),

  tool('mail-troubleshooter', {
    prefix: 'S17T33', as: 'root', needs: ['account', 'mailbox'], probe: '/api/domains',
    paths: /^\/api\/server\/mail-trace$/,
    unit: [{ id: 'S17T33-UNIT-1', file: 'apps/agent/src/mail-trace.test.ts', name: 'mail route trace fails at the remote domain lookup when a domain has no MX or address' }],
    checks: ['LOCAL-MAILBOX-TRACED', 'NONEXISTENT-DOMAIN-FAILS-LOOKUP', 'OVERSIZED-ADDRESS-VALIDATION'],
    async run({ root, fixture, check, refused }) {
      const local = await root.post('/api/server/mail-trace', { address: fixture.mailbox.address })
      check('LOCAL-MAILBOX-TRACED', local.status === 200 && typeof local.data?.deliverable === 'boolean' && Array.isArray(local.data?.steps) && local.data.steps.length >= 1, { status: local.status, deliverable: local.data?.deliverable ?? null })
      const remote = await root.post('/api/server/mail-trace', { address: 'nobody@xq-nonexistent-domain.invalid' })
      check('NONEXISTENT-DOMAIN-FAILS-LOOKUP', remote.status === 200 && remote.data?.deliverable === false && Array.isArray(remote.data?.steps), { status: remote.status, deliverable: remote.data?.deliverable ?? null })
      refused('OVERSIZED-ADDRESS-VALIDATION', await root.post('/api/server/mail-trace', { address: `${'a'.repeat(250)}@example.test` }), 'VALIDATION')
    },
  }),
]
