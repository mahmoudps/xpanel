import { randomBytes, randomUUID } from 'node:crypto'
import { tool } from './kit.mjs'

const credential = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const b64 = value => Buffer.from(value).toString('base64')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ID = '[0-9a-f-]{36}'
const ZERO_REV = '0'.repeat(64)
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'

async function guardTweak(root, undo) {
  const read = await root.get('/api/server/tweak-settings')
  const original = read.data?.values
  if (read.status !== 200 || typeof read.data?.revision !== 'string' || !original || typeof original !== 'object') {
    return { read, values: null, revision: ZERO_REV }
  }
  undo('tweak settings', async () => {
    const now = await root.get('/api/server/tweak-settings')
    if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
    if (same(now.data?.values, original)) return true
    const back = await root.put('/api/server/tweak-settings', { values: original, expectedRevision: now.data.revision })
    return back.status === 200 && same(back.data?.values, original)
  })
  return { read, values: original, revision: read.data.revision }
}

async function makeReseller(root, tag, suffix, extra, undo) {
  const username = `xr${suffix}${tag}`.slice(0, 16)
  const secret = credential()
  const res = await root.post('/api/resellers', {
    username,
    password: secret,
    acl: ['list-accounts'],
    maxAccounts: 2,
    totalDiskMb: 2048,
    totalBandwidthMb: 4096,
    oversell: { disk: false, bandwidth: false },
    nameservers: [],
    delegatedIps: [],
    ...extra,
  })
  const id = res.data?.reseller?.id
  if (typeof id === 'string') {
    undo(`reseller ${username}`, async () => [200, 404].includes((await root.delete(`/api/resellers/${id}`)).status))
    return { id, username, secret, response: res }
  }
  return { id: null, username, secret, response: res }
}

export default [
  tool('skeleton-directory', {
    prefix: 'S13T01', as: 'root', restores: ['/api/accounts/skeleton'], probe: '/api/accounts/skeleton',
    paths: /^\/api\/accounts\/skeleton(?:\/file)?$/, requests: 25,
    unit: [{ id: 'S13T01-UNIT-1', file: 'apps/api/src/skeleton-workspace.test.ts', name: 'Skeleton Directory holds files by owner, and a reseller never sees root files' }],
    checks: ['DOTFILE-PATH-REFUSED', 'OUTSIDE-ROOT-REFUSED', 'SKEL-FILE-SAVED-AND-REMOVED'],
    async run({ root, tag, check, refused, undo }) {
      const before = await root.get('/api/accounts/skeleton')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      refused('DOTFILE-PATH-REFUSED', await root.put('/api/accounts/skeleton/file', {
        path: 'public_html/.htaccess', contentBase64: b64('Deny from all\n'), expectedRevision: rev,
      }), 'VALIDATION')
      refused('OUTSIDE-ROOT-REFUSED', await root.put('/api/accounts/skeleton/file', {
        path: 'etc/hosts', contentBase64: b64('test\n'), expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('SKEL-FILE-SAVED-AND-REMOVED', false, { status: before.status })
        return
      }
      const relPath = `public_html/xq-${tag}.html`
      undo('skeleton file', async () => {
        const now = await root.get('/api/accounts/skeleton')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (!(now.data?.files ?? []).some(item => item?.path === relPath)) return true
        return (await root.delete('/api/accounts/skeleton/file', { path: relPath, expectedRevision: now.data.revision })).status === 200
      })
      const saved = await root.put('/api/accounts/skeleton/file', {
        path: relPath, contentBase64: b64(`<!doctype html><title>xq-${tag}</title>\n`), expectedRevision: rev,
      })
      const present = (saved.data?.files ?? []).some(item => item?.path === relPath)
      const removed = typeof saved.data?.revision === 'string'
        ? await root.delete('/api/accounts/skeleton/file', { path: relPath, expectedRevision: saved.data.revision })
        : { status: 0, data: null }
      const gone = !(removed.data?.files ?? []).some(item => item?.path === relPath)
      check('SKEL-FILE-SAVED-AND-REMOVED', saved.status === 200 && present && removed.status === 200 && gone, {
        savedStatus: saved.status, present, removedStatus: removed.status, gone,
      })
    },
  }),

  tool('email-all-users', {
    prefix: 'S13T02', as: 'root', needs: ['account'], probe: '/api/server/announcements',
    page: { route: '/whm/accounts/announcements', read: '/api/server/announcements', shows: () => ['Announcements'] },
    paths: /^\/api\/server\/announcements(?:\/email)?$/, requests: 20,
    unit: [{ id: 'S13T02-UNIT-1', file: 'apps/api/src/email-all-users.test.ts', name: 'Email All Users sends nothing on the first post and one message per account on the confirmation' }],
    checks: ['INVALID-SENDER-REFUSED', 'STALE-CONFIRM-CONFLICT', 'PREVIEW-RECIPIENTS-WITHOUT-SEND'],
    async run({ root, tag, check, refused }) {
      refused('INVALID-SENDER-REFUSED', await root.post('/api/server/announcements/email', {
        fromName: 'System Notice', fromAddress: 'not-an-email', subject: `xq-${tag}`, body: 'Maintenance notice.',
      }), 'VALIDATION')
      refused('STALE-CONFIRM-CONFLICT', await root.post('/api/server/announcements/email', {
        fromName: 'System Notice', fromAddress: 'admin@example.net', subject: `xq-${tag}`, body: 'Maintenance notice.', confirm: ZERO_REV,
      }), 'CONFLICT')
      const preview = await root.post('/api/server/announcements/email', {
        fromName: 'System Notice', fromAddress: 'admin@example.net', subject: `xq-${tag}`, body: 'Maintenance notice.',
      })
      check('PREVIEW-RECIPIENTS-WITHOUT-SEND', preview.status === 200 && typeof preview.data?.review === 'string' && Number.isInteger(preview.data?.recipients) && Array.isArray(preview.data?.sample), {
        status: preview.status, recipients: preview.data?.recipients ?? null,
      })
    },
  }),

  tool('manage-demo-mode', {
    prefix: 'S13T03', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/server/demo-mode',
    paths: /^\/api\/(?:server\/demo-mode|account\/preferences)$/, requests: 25,
    unit: [{ id: 'S13T03-UNIT-1', file: 'apps/api/src/demo-mode.test.ts', name: 'demo mode workspace lists current accounts, saves a revision-bound list, reads it back and audits the change by username' }],
    checks: ['UNKNOWN-ACCOUNT-REFUSED', 'STALE-REVISION-CONFLICT', 'DEMO-BLOCKS-WRITES-ALLOWS-READS'],
    async run({ root, owner, fixture, check, refused, undo }) {
      const before = await root.get('/api/server/demo-mode')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origIds = Array.isArray(before.data?.accountIds) ? before.data.accountIds : []
      refused('UNKNOWN-ACCOUNT-REFUSED', await root.put('/api/server/demo-mode', { accountIds: [ZERO_UUID], expectedRevision: rev }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/demo-mode', { accountIds: origIds, expectedRevision: ZERO_REV }), 'CONFLICT')
      if (before.status !== 200 || typeof fixture.accountId !== 'string') {
        check('DEMO-BLOCKS-WRITES-ALLOWS-READS', false, { status: before.status })
        return
      }
      undo('demo mode accounts', async () => {
        const now = await root.get('/api/server/demo-mode')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        const cur = Array.isArray(now.data?.accountIds) ? now.data.accountIds : []
        if (same(cur, origIds)) return true
        return (await root.put('/api/server/demo-mode', { accountIds: origIds, expectedRevision: now.data.revision })).status === 200
      })
      const nextIds = [...new Set([...origIds, fixture.accountId])]
      const enabled = await root.put('/api/server/demo-mode', { accountIds: nextIds, expectedRevision: rev })
      const ownerRead = await owner.get('/api/account/preferences')
      const prefRev = typeof ownerRead.data?.revision === 'string' ? ownerRead.data.revision : ZERO_REV
      const ownerWrite = await owner.patch('/api/account/preferences', { notificationPosition: 'top-right', expectedRevision: prefRev })
      const restored = typeof enabled.data?.revision === 'string'
        ? await root.put('/api/server/demo-mode', { accountIds: origIds, expectedRevision: enabled.data.revision })
        : { status: 0 }
      check('DEMO-BLOCKS-WRITES-ALLOWS-READS', enabled.status === 200 && ownerRead.status === 200 && ownerWrite.status === 403 && ownerWrite.data?.code === 'FORBIDDEN' && restored.status === 200, {
        enabledStatus: enabled.status, readStatus: ownerRead.status, writeDenied: ownerWrite.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('manage-shell-access', {
    prefix: 'S13T04', as: 'root', needs: ['account'], probe: '/api/accounts/admin',
    paths: new RegExp(String.raw`^\/api\/accounts\/(?:admin|${ID}|bulk-actions\/shell)$`), requests: 25,
    unit: [{ id: 'S13T04-UNIT-1', file: 'apps/api/src/account-admin-workspace.test.ts', name: 'account administration reports a shell that differs from the package as an override' }],
    checks: ['UNSUPPORTED-SHELL-REFUSED', 'UNCHANGED-SHELL-CONFLICT', 'JAILED-OVERRIDE-AND-RESTORE'],
    async run({ root, fixture, check, refused, undo }) {
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('UNSUPPORTED-SHELL-REFUSED', await root.post('/api/accounts/bulk-actions/shell', {
        operationId: randomUUID(), accounts: [{ id: acctId }], shell: 'bash',
      }), 'VALIDATION')
      const before = await root.get('/api/accounts/admin')
      const row = (before.data?.accounts ?? []).find(item => item?.username === fixture.username)
      const origShell = row?.shell ?? 'none'
      const planShell = row?.planShell ?? 'jailed'
      const overrideShell = planShell === 'none' ? 'jailed' : 'none'
      const restoreTarget = row?.planShell ?? origShell
      refused('UNCHANGED-SHELL-CONFLICT', await root.patch(`/api/accounts/${acctId}`, { shell: origShell }), 'CONFLICT')
      if (typeof fixture.accountId !== 'string') {
        check('JAILED-OVERRIDE-AND-RESTORE', false, { status: before.status })
        return
      }
      undo('account shell mode', async () => {
        const now = await root.get('/api/accounts/admin')
        const cur = (now.data?.accounts ?? []).find(item => item?.username === fixture.username)?.shell
        if (now.status === 200 && cur === restoreTarget) return true
        return (await root.patch(`/api/accounts/${fixture.accountId}`, { shell: restoreTarget })).status === 200
      })
      if (origShell === overrideShell) await root.patch(`/api/accounts/${fixture.accountId}`, { shell: planShell })
      const changed = await root.patch(`/api/accounts/${fixture.accountId}`, { shell: overrideShell })
      const mid = await root.get('/api/accounts/admin')
      const midRow = (mid.data?.accounts ?? []).find(item => item?.username === fixture.username)
      const restored = await root.patch(`/api/accounts/${fixture.accountId}`, { shell: restoreTarget })
      check('JAILED-OVERRIDE-AND-RESTORE', changed.status === 200 && midRow?.shell === overrideShell && midRow?.shellSource === 'override' && restored.status === 200, {
        changedStatus: changed.status, shellSource: midRow?.shellSource ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('web-log-retention', {
    prefix: 'S13T05', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/server/logs/retention',
    paths: /^\/api\/(?:server\/logs\/retention(?:\?x=1)?|account\/logs\/settings)$/, requests: 25,
    unit: [{ id: 'S13T05-UNIT-1', file: 'apps/api/src/account-logs-workspace.test.ts', name: 'account site logs workspace saves raw access archive settings for the owner, or returns the account to the server defaults' }],
    checks: ['SELECTOR-QUERY-REFUSED', 'ZERO-RETENTION-REFUSED', 'ACCOUNT-RETENTION-PROJECTED-AND-RESET'],
    async run({ root, owner, fixture, check, refused, undo }) {
      refused('SELECTOR-QUERY-REFUSED', await root.get('/api/server/logs/retention?x=1'), 'VALIDATION')
      refused('ZERO-RETENTION-REFUSED', await owner.put('/api/account/logs/settings', {
        settings: { archive: true, removePreviousMonthArchive: false, retentionDays: 0 },
      }), 'VALIDATION')
      undo('account log retention', async () => (await owner.put('/api/account/logs/settings', { settings: null })).status === 200)
      const saved = await owner.put('/api/account/logs/settings', {
        settings: { archive: true, removePreviousMonthArchive: false, retentionDays: 7 },
      })
      const view = await root.get('/api/server/logs/retention')
      const acct = (view.data?.accounts ?? []).find(item => item?.accountId === fixture.accountId)
      const reset = await owner.put('/api/account/logs/settings', { settings: null })
      check('ACCOUNT-RETENTION-PROJECTED-AND-RESET', saved.status === 200 && view.status === 200 && acct?.source === 'account' && acct?.settings?.retentionDays === 7 && reset.status === 200, {
        savedStatus: saved.status, source: acct?.source ?? null, retentionDays: acct?.settings?.retentionDays ?? null, resetStatus: reset.status,
      })
    },
  }),

  tool('web-template-editor', {
    prefix: 'S13T06', as: 'root', needs: ['account'], probe: '/api/accounts/web-templates',
    page: { route: '/whm/accounts/templates', read: '/api/domains' },
    paths: new RegExp(String.raw`^\/api\/(?:accounts\/web-templates(?:\/default)?|resellers(?:\/${ID})?|auth\/(?:login|logout)|domains)$`), requests: 30,
    unit: [{ id: 'S13T06-UNIT-1', file: 'apps/api/src/web-templates-workspace.test.ts', name: 'Web Template Editor saves into the caller scope and publishes through the host' }],
    checks: ['BLANK-TEMPLATE-REFUSED', 'STALE-TEMPLATE-CONFLICT', 'RESELLER-TEMPLATE-SAVED-AND-RESET'],
    async run({ root, tag, check, refused, undo, signIn }) {
      const rootView = await root.get('/api/accounts/web-templates')
      const rev = typeof rootView.data?.revision === 'string' ? rootView.data.revision : ZERO_REV
      refused('BLANK-TEMPLATE-REFUSED', await root.put('/api/accounts/web-templates/default', { html: '   ', expectedRevision: rev }), 'VALIDATION')
      refused('STALE-TEMPLATE-CONFLICT', await root.put('/api/accounts/web-templates/default', { html: '<!doctype html><p>xq</p>', expectedRevision: ZERO_REV }), 'CONFLICT')
      const reseller = await makeReseller(root, tag, 'w', { acl: ['list-accounts', 'edit-account'] }, undo)
      const { client } = reseller.id ? await signIn('reseller', { username: reseller.username, password: reseller.secret }) : { client: null }
      if (!client) {
        check('RESELLER-TEMPLATE-SAVED-AND-RESET', false, { resellerCreated: Boolean(reseller.id) })
        return
      }
      const rView = await client.get('/api/accounts/web-templates')
      const rRev = rView.data?.revision
      const saved = typeof rRev === 'string'
        ? await client.put('/api/accounts/web-templates/default', { html: `<!doctype html><title>xq-${tag}</title><p>%contact%</p>`, expectedRevision: rRev })
        : { status: 0, data: null }
      const reset = typeof saved.data?.revision === 'string'
        ? await client.delete('/api/accounts/web-templates/default', { expectedRevision: saved.data.revision })
        : { status: 0, data: null }
      check('RESELLER-TEMPLATE-SAVED-AND-RESET', saved.status === 200 && saved.data?.pages?.default?.state === 'custom' && reset.status === 200 && reset.data?.pages?.default?.state === 'shipped', {
        savedStatus: saved.status, customState: saved.data?.pages?.default?.state ?? null, resetStatus: reset.status,
      })
    },
  }),

  tool('account-enhancements', {
    prefix: 'S13T07', as: 'root', needs: ['account'], probe: '/api/server/account-enhancements',
    paths: /^\/api\/(?:server\/account-enhancements|accounts\/enhancements)$/, requests: 20,
    unit: [{ id: 'S13T07-UNIT-1', file: 'apps/api/src/acct-enhancements-workspace.test.ts', name: 'reseller assignment stops the assignment past the limit and refuses all at 0' }],
    checks: ['ENHANCEMENTS-DIRECTORY-READ', 'INVALID-ENHANCEMENT-ID-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, fixture, check, refused }) {
      const [serverView, acctView] = await Promise.all([
        root.get('/api/server/account-enhancements'),
        root.get('/api/accounts/enhancements'),
      ])
      const rev = typeof serverView.data?.revision === 'string' ? serverView.data.revision : ZERO_REV
      const doc = serverView.data?.document ?? { definitions: [], planAssignments: {}, accountAssignments: {}, resellerLimits: {} }
      const hasAcct = (acctView.data?.accounts ?? []).some(item => item?.username === fixture.username)
      check('ENHANCEMENTS-DIRECTORY-READ', serverView.status === 200 && acctView.status === 200 && hasAcct, {
        serverStatus: serverView.status, acctStatus: acctView.status, hasAcct,
      })
      refused('INVALID-ENHANCEMENT-ID-REFUSED', await root.put('/api/server/account-enhancements', {
        expectedRevision: rev,
        definitions: [{ id: 'Bad!', name: 'Bad', kind: 'boolean', description: '', min: null, max: null, unit: null }],
        planAssignments: doc.planAssignments ?? {},
        accountAssignments: doc.accountAssignments ?? {},
        resellerLimits: doc.resellerLimits ?? {},
      }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/account-enhancements', {
        expectedRevision: ZERO_REV,
        definitions: doc.definitions ?? [],
        planAssignments: doc.planAssignments ?? {},
        accountAssignments: doc.accountAssignments ?? {},
        resellerLimits: doc.resellerLimits ?? {},
      }), 'CONFLICT')
    },
  }),

  tool('change-multiple-sites-ip', {
    prefix: 'S13T08', as: 'root', needs: ['account'], probe: '/api/ips/usage',
    paths: /^\/api\/ips\/(?:usage|change-many)$/, requests: 20,
    unit: [{ id: 'S13T08-UNIT-1', file: 'apps/api/src/ip-network-workspace.test.ts', name: 'root IP tools moves several sites in one request and names the account a refusal stopped at' }],
    checks: ['USAGE-READ', 'EMPTY-BATCH-REFUSED', 'UNPOOLED-ADDRESS-FORBIDDEN', 'UNKNOWN-ACCOUNT-NOT-FOUND'],
    async run({ root, fixture, check, refused }) {
      const usage = await root.get('/api/ips/usage')
      check('USAGE-READ', usage.status === 200 && Array.isArray(usage.data?.ips), {
        status: usage.status, count: Array.isArray(usage.data?.ips) ? usage.data.ips.length : null,
      })
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('EMPTY-BATCH-REFUSED', await root.post('/api/ips/change-many', { changes: [] }), 'VALIDATION')
      refused('UNPOOLED-ADDRESS-FORBIDDEN', await root.post('/api/ips/change-many', {
        changes: [{ accountId: acctId, ipv4: '203.0.113.254' }],
      }), 'FORBIDDEN')
      refused('UNKNOWN-ACCOUNT-NOT-FOUND', await root.post('/api/ips/change-many', {
        changes: [{ accountId: ZERO_UUID, ipv4: '203.0.113.254' }],
      }), 'NOT_FOUND')
    },
  }),

  tool('modify-upgrade-multiple-accounts', {
    prefix: 'S13T09', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/accounts',
    paths: new RegExp(String.raw`^\/api\/(?:accounts(?:\/${ID}|\/bulk-actions\/plan)?|plans(?:\/${ID})?|account\/preferences)$`), requests: 30,
    unit: [{ id: 'S13T09-UNIT-1', file: 'apps/api/src/account-bulk-actions.test.ts', name: 'WHM bulk account actions refuses an oversized or repeated selection before any change' }],
    checks: ['EMPTY-SELECTION-REFUSED', 'DUPLICATE-ACCOUNT-REFUSED', 'BULK-PLAN-UPGRADE-PRESERVES-PREFS'],
    async run({ root, owner, fixture, tag, check, refused, undo }) {
      const acctId = fixture.accountId ?? ZERO_UUID
      refused('EMPTY-SELECTION-REFUSED', await root.post('/api/accounts/bulk-actions/plan', {
        operationId: randomUUID(), accounts: [], planId: ZERO_UUID,
      }), 'VALIDATION')
      refused('DUPLICATE-ACCOUNT-REFUSED', await root.post('/api/accounts/bulk-actions/plan', {
        operationId: randomUUID(), accounts: [{ id: acctId }, { id: acctId }], planId: ZERO_UUID,
      }), 'VALIDATION')
      if (typeof fixture.accountId !== 'string') {
        check('BULK-PLAN-UPGRADE-PRESERVES-PREFS', false, { accountId: null })
        return
      }
      const acctBefore = await root.get(`/api/accounts/${fixture.accountId}`)
      const origPlanId = acctBefore.data?.account?.planId
      const planRes = await root.post('/api/plans', {
        name: `xq-bulk-${tag}`,
        resources: { diskMb: 3072, bandwidthMbMonth: 10240, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      })
      const newPlanId = planRes.data?.plan?.id
      if (typeof newPlanId !== 'string' || typeof origPlanId !== 'string') {
        check('BULK-PLAN-UPGRADE-PRESERVES-PREFS', false, { planStatus: planRes.status })
        return
      }
      undo('bulk plan restore', async () => {
        await root.post('/api/accounts/bulk-actions/plan', { operationId: randomUUID(), accounts: [{ id: fixture.accountId }], planId: origPlanId })
        return [200, 404].includes((await root.delete(`/api/plans/${newPlanId}`)).status)
      })
      const prefsBefore = await owner.get('/api/account/preferences')
      const bulk = await root.post('/api/accounts/bulk-actions/plan', {
        operationId: randomUUID(), accounts: [{ id: fixture.accountId }], planId: newPlanId,
      })
      const prefsAfter = await owner.get('/api/account/preferences')
      await root.post('/api/accounts/bulk-actions/plan', { operationId: randomUUID(), accounts: [{ id: fixture.accountId }], planId: origPlanId })
      await root.delete(`/api/plans/${newPlanId}`)
      check('BULK-PLAN-UPGRADE-PRESERVES-PREFS', bulk.status === 200 && bulk.data?.results?.[0]?.outcome === 'applied' && prefsBefore.status === 200 && prefsAfter.status === 200 && same(prefsAfter.data?.preferences, prefsBefore.data?.preferences), {
        bulkStatus: bulk.status, outcome: bulk.data?.results?.[0]?.outcome ?? null,
      })
    },
  }),

  tool('reseller-nameservers', {
    prefix: 'S13T10', as: 'root', needs: ['account'], probe: '/api/resellers',
    page: { route: '/whm/resellers/ips-nameservers', read: '/api/domains', shows: () => ['IPs & nameservers'] },
    paths: new RegExp(String.raw`^\/api\/(?:resellers(?:\/${ID})?|domains)$`), requests: 25,
    unit: [{ id: 'S13T10-UNIT-1', file: 'packages/state/src/ip-allocation.test.ts', name: 'account-as-IP-reservation state contract; diagnostic desired state, not host binding keeps a reseller delegation needed by an existing dedicated account' }],
    checks: ['MALFORMED-NS-REFUSED', 'DUPLICATE-NS-REFUSED', 'NAMESERVERS-SAVED-ON-RESELLER'],
    async run({ root, tag, check, refused, undo }) {
      const reseller = await makeReseller(root, tag, 'n', {}, undo)
      const targetId = reseller.id ?? ZERO_UUID
      refused('MALFORMED-NS-REFUSED', await root.patch(`/api/resellers/${targetId}`, { nameservers: ['bad..host'] }), reseller.id ? 'VALIDATION' : 'NOT_FOUND')
      refused('DUPLICATE-NS-REFUSED', await root.patch(`/api/resellers/${targetId}`, { nameservers: ['ns1.example.net', 'ns1.example.net'] }), reseller.id ? 'VALIDATION' : 'NOT_FOUND')
      if (!reseller.id) {
        check('NAMESERVERS-SAVED-ON-RESELLER', false, { created: reseller.response.status })
        return
      }
      const ns = [`ns1.xq-${tag}.example.net`, `ns2.xq-${tag}.example.net`]
      const saved = await root.patch(`/api/resellers/${reseller.id}`, { nameservers: ns })
      check('NAMESERVERS-SAVED-ON-RESELLER', saved.status === 200 && same(saved.data?.reseller?.nameservers, ns), {
        status: saved.status, count: (saved.data?.reseller?.nameservers ?? []).length,
      })
    },
  }),

  tool('email-all-resellers', {
    prefix: 'S13T11', as: 'root', needs: ['account', 'mailbox'], probe: '/api/resellers',
    page: { route: '/whm/resellers/more', read: '/api/domains', shows: () => ['More reseller tools'] },
    paths: new RegExp(String.raw`^\/api\/(?:resellers(?:\/email|\/${ID})?|domains)$`), requests: 25,
    unit: [{ id: 'S13T11-UNIT-1', file: 'apps/api/src/reseller-workspace.test.ts', name: 'reseller privilege lists and Email All Resellers sends one message per reseller contact and reports who has none or failed' }],
    checks: ['EMPTY-SUBJECT-REFUSED', 'MULTILINE-SUBJECT-REFUSED', 'RESELLER-CONTACT-DELIVERED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      refused('EMPTY-SUBJECT-REFUSED', await root.post('/api/resellers/email', { subject: '', body: 'Notice' }), 'VALIDATION')
      refused('MULTILINE-SUBJECT-REFUSED', await root.post('/api/resellers/email', { subject: 'Line1\nLine2', body: 'Notice' }), 'VALIDATION')
      const addr = fixture.mailbox?.address ?? `xq@${fixture.domain}`
      const reseller = await makeReseller(root, tag, 'e', { contactEmail: addr }, undo)
      if (!reseller.id) {
        check('RESELLER-CONTACT-DELIVERED', false, { created: reseller.response.status })
        return
      }
      const sent = await root.post('/api/resellers/email', { subject: `Reseller notice ${tag}`, body: 'Scheduled window.' })
      const hit = (sent.data?.sent ?? []).includes(reseller.username)
      check('RESELLER-CONTACT-DELIVERED', sent.status === 200 && hit && !(sent.data?.sent ?? []).includes(fixture.username), {
        status: sent.status, hit, sentCount: Array.isArray(sent.data?.sent) ? sent.data.sent.length : null,
      })
    },
  }),

  tool('manage-reseller-ip-delegation', {
    prefix: 'S13T12', as: 'root', needs: ['account'], probe: '/api/resellers',
    page: { route: '/whm/resellers/ips-nameservers', read: '/api/domains', shows: () => ['IPs & nameservers'] },
    paths: new RegExp(String.raw`^\/api\/(?:resellers(?:\/${ID})?|ips(?:\?view=allocation&planId=${ID}&ownerId=${ID})?|plans|domains)$`), requests: 25,
    unit: [{ id: 'S13T12-UNIT-1', file: 'packages/state/src/ip-allocation.test.ts', name: 'account-as-IP-reservation state contract; diagnostic desired state, not host binding keeps a reseller delegation needed by an existing dedicated account' }],
    checks: ['MALFORMED-DELEGATION-REFUSED', 'DELEGATION-SAVED-AND-ALLOCATION-SCOPED'],
    async run({ root, tag, check, refused, undo }) {
      const [ips, plans] = await Promise.all([root.get('/api/ips'), root.get('/api/plans')])
      const primaryIp = (ips.data?.ips ?? []).find(item => item?.version === 4)?.address
      const planId = (plans.data?.plans ?? [])[0]?.id
      const reseller = await makeReseller(root, tag, 'd', {}, undo)
      const targetId = reseller.id ?? ZERO_UUID
      refused('MALFORMED-DELEGATION-REFUSED', await root.patch(`/api/resellers/${targetId}`, { delegatedIps: ['not-an-ip'] }), reseller.id ? 'VALIDATION' : 'NOT_FOUND')
      if (!reseller.id || typeof primaryIp !== 'string' || typeof planId !== 'string') {
        check('DELEGATION-SAVED-AND-ALLOCATION-SCOPED', false, { resellerId: Boolean(reseller.id), hasIp: typeof primaryIp === 'string' })
        return
      }
      const patched = await root.patch(`/api/resellers/${reseller.id}`, { delegatedIps: [primaryIp] })
      const alloc = await root.get(`/api/ips?view=allocation&planId=${planId}&ownerId=${reseller.id}`)
      check('DELEGATION-SAVED-AND-ALLOCATION-SCOPED', patched.status === 200 && same(patched.data?.reseller?.delegatedIps, [primaryIp]) && alloc.status === 200 && alloc.data?.scope === 'desired-state', {
        patchStatus: patched.status, allocStatus: alloc.status,
      })
    },
  }),

  tool('manage-reseller-shared-ip', {
    prefix: 'S13T13', as: 'root', needs: ['account'], probe: '/api/resellers',
    page: { route: '/whm/resellers/ips-nameservers', read: '/api/domains', shows: () => ['IPs & nameservers'] },
    paths: new RegExp(String.raw`^\/api\/(?:resellers(?:\/${ID})?|ips|domains)$`), requests: 25,
    unit: [{ id: 'S13T13-UNIT-1', file: 'packages/state/src/ip-allocation.test.ts', name: 'account-as-IP-reservation state contract; diagnostic desired state, not host binding reseller package limits, shared IP, saved privilege lists and suspension lock gives new reseller accounts its main shared IP and refuses an address it may not use' }],
    checks: ['MALFORMED-SHARED-IP-REFUSED', 'UNPOOLED-SHARED-IP-FORBIDDEN', 'DELEGATED-SHARED-IP-ASSIGNED'],
    async run({ root, tag, check, refused, undo }) {
      const ips = await root.get('/api/ips')
      const sharedIpv4 = (ips.data?.ips ?? []).find(item => item?.version === 4 && item?.role === 'shared')?.address
      const reseller = await makeReseller(root, tag, 's', {}, undo)
      const targetId = reseller.id ?? ZERO_UUID
      refused('MALFORMED-SHARED-IP-REFUSED', await root.patch(`/api/resellers/${targetId}`, { sharedIp: 'not-an-ip' }), reseller.id ? 'VALIDATION' : 'NOT_FOUND')
      refused('UNPOOLED-SHARED-IP-FORBIDDEN', await root.patch(`/api/resellers/${targetId}`, { sharedIp: '203.0.113.250' }), reseller.id ? 'FORBIDDEN' : 'NOT_FOUND')
      if (!reseller.id || typeof sharedIpv4 !== 'string') {
        check('DELEGATED-SHARED-IP-ASSIGNED', false, { resellerId: Boolean(reseller.id), hasSharedIp: typeof sharedIpv4 === 'string' })
        return
      }
      const assigned = await root.patch(`/api/resellers/${reseller.id}`, { delegatedIps: [sharedIpv4], sharedIp: sharedIpv4 })
      check('DELEGATED-SHARED-IP-ASSIGNED', assigned.status === 200 && assigned.data?.reseller?.sharedIp === sharedIpv4, {
        status: assigned.status, matched: assigned.data?.reseller?.sharedIp === sharedIpv4,
      })
    },
  }),

  tool('reset-resellers', {
    prefix: 'S13T14', as: 'root', needs: ['account'], probe: '/api/resellers/acl-lists',
    page: { route: '/whm/resellers/privileges', read: '/api/domains', shows: () => ['Reseller privileges'] },
    paths: new RegExp(String.raw`^\/api\/(?:resellers(?:\/acl-lists(?:\/[a-z0-9_-]+(?:\/apply)?)?|\/${ID})?|domains)$`), requests: 30,
    unit: [{ id: 'S13T14-UNIT-1', file: 'apps/api/src/reseller-workspace.test.ts', name: 'reseller privilege lists and Email All Resellers saves a privilege list and resets many resellers to it' }],
    checks: ['UNKNOWN-ACL-REFUSED', 'MISSING-LIST-NOT-FOUND', 'ACL-LIST-APPLIED-TO-MULTIPLE-RESELLERS'],
    async run({ root, tag, check, refused, undo }) {
      const listName = `xq-${tag}`
      refused('UNKNOWN-ACL-REFUSED', await root.put(`/api/resellers/acl-lists/${listName}`, { acl: ['not-an-acl'] }), 'VALIDATION')
      refused('MISSING-LIST-NOT-FOUND', await root.post(`/api/resellers/acl-lists/missing-${tag}/apply`, { resellerIds: [ZERO_UUID] }), 'NOT_FOUND')
      const r1 = await makeReseller(root, tag, 'a', { acl: ['list-accounts', 'create-account'] }, undo)
      const r2 = await makeReseller(root, tag, 'b', { acl: ['list-accounts', 'suspend-account'] }, undo)
      if (!r1.id || !r2.id) {
        check('ACL-LIST-APPLIED-TO-MULTIPLE-RESELLERS', false, { r1: Boolean(r1.id), r2: Boolean(r2.id) })
        return
      }
      undo('acl list', async () => [200, 404].includes((await root.delete(`/api/resellers/acl-lists/${listName}`)).status))
      const savedList = await root.put(`/api/resellers/acl-lists/${listName}`, { acl: ['list-accounts'] })
      const applied = await root.post(`/api/resellers/acl-lists/${listName}/apply`, { resellerIds: [r1.id, r2.id] })
      await root.delete(`/api/resellers/acl-lists/${listName}`)
      const updated = applied.data?.resellers ?? []
      const bothReset = updated.length === 2 && updated.every(item => same(item?.acl, ['list-accounts']))
      check('ACL-LIST-APPLIED-TO-MULTIPLE-RESELLERS', savedList.status === 200 && applied.status === 200 && bothReset, {
        savedStatus: savedList.status, appliedStatus: applied.status, bothReset,
      })
    },
  }),

  tool('account-restore-progress', {
    prefix: 'S13T15', as: 'root', needs: ['account'], probe: '/api/backups/files',
    paths: /^\/api\/backups\/(?:files(?:\/[a-z][a-z0-9]{0,15}(?:\/browse)?)?|components\/[a-z][a-z0-9]{0,15}\/parts)$/, requests: 20,
    unit: [{ id: 'S13T15-UNIT-1', file: 'apps/api/src/acct-restore-workspace.test.ts', name: 'WHM component restore API forwards a part restore with fresh authority and accepts only a reply bound to the reviewed archive, databases and zones' }],
    checks: ['RESTORE-ARCHIVES-LISTED', 'FOREIGN-ARCHIVE-REFUSED', 'MISSING-ARCHIVE-NOT-FOUND', 'FOREIGN-DB-PART-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const [accounts, archives] = await Promise.all([
        root.get('/api/backups/files'),
        root.get(`/api/backups/files/${fixture.username}`),
      ])
      const hasAcct = (accounts.data?.accounts ?? []).some(item => item?.username === fixture.username)
      check('RESTORE-ARCHIVES-LISTED', accounts.status === 200 && hasAcct && archives.status === 200 && archives.data?.context?.accountId === fixture.accountId && Array.isArray(archives.data?.archives), {
        accountsStatus: accounts.status, archivesStatus: archives.status,
      })
      refused('FOREIGN-ARCHIVE-REFUSED', await root.post(`/api/backups/files/${fixture.username}/browse`, {
        file: 'xpanel-backup-otheracct-20261026T100000Z.tar.gz',
      }), 'VALIDATION')
      const validArchive = `xpanel-backup-${fixture.username}-20261026T100000Z.tar.gz`
      refused('MISSING-ARCHIVE-NOT-FOUND', await root.post(`/api/backups/files/${fixture.username}/browse`, { file: validArchive }), 'NOT_FOUND')
      refused('FOREIGN-DB-PART-REFUSED', await root.post(`/api/backups/components/${fixture.username}/parts`, {
        file: validArchive, databases: ['otheracct_db'], zones: [], expectedArchiveSha256: 'a'.repeat(64),
      }), 'VALIDATION')
    },
  }),

  tool('convert-addon-to-account', {
    prefix: 'S13T16', as: 'root', needs: ['account'], probe: '/api/transfers/convert-addon',
    page: { route: '/whm/transfers/convert-addon', read: '/api/domains' },
    paths: new RegExp(String.raw`^\/api\/(?:transfers\/convert-addon(?:\/(?:preview|apply))?|domains(?:\/${ID})?)$`), requests: 25,
    unit: [{ id: 'S13T16-UNIT-1', file: 'apps/api/src/acct-convert-addon.test.ts', name: 'addon domain conversion route previews, then hands apply to the journaled executor only after confirmation and CAS checks' }],
    checks: ['CONVERSION-WORKSPACE-READ', 'ABSENT-DOMAIN-PREVIEW-NOT-FOUND', 'MISMATCHED-CONFIRM-REFUSED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const added = typeof fixture.accountId === 'string'
        ? await root.post('/api/domains', { accountId: fixture.accountId, name: `xq${tag}cv.example.net`, kind: 'addon' })
        : { status: 0, data: null }
      const addedId = added.data?.domain?.id
      if (typeof addedId === 'string') {
        undo('addon domain', async () => [200, 204, 404].includes((await root.delete(`/api/domains/${addedId}`)).status))
      }
      const view = await root.get('/api/transfers/convert-addon')
      const planId = (view.data?.plans ?? [])[0]?.id ?? ZERO_UUID
      check('CONVERSION-WORKSPACE-READ', view.status === 200 && Array.isArray(view.data?.candidates) && Array.isArray(view.data?.plans) && Array.isArray(view.data?.journal), {
        status: view.status, plans: Array.isArray(view.data?.plans) ? view.data.plans.length : null,
      })
      refused('ABSENT-DOMAIN-PREVIEW-NOT-FOUND', await root.post('/api/transfers/convert-addon/preview', {
        domainId: ZERO_UUID, username: 'xqconvuser', planId,
      }), 'NOT_FOUND')
      if (typeof addedId === 'string') {
        const targetUser = `xqcv${tag}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
        const preview = await root.post('/api/transfers/convert-addon/preview', { domainId: addedId, username: targetUser, planId })
        const rev = typeof preview.data?.revision === 'string' ? preview.data.revision : ZERO_REV
        refused('MISMATCHED-CONFIRM-REFUSED', await root.post('/api/transfers/convert-addon/apply', {
          domainId: addedId, username: targetUser, planId, expectedRevision: rev, confirm: 'wrong',
        }), 'VALIDATION')
        await root.delete(`/api/domains/${addedId}`)
      } else {
        refused('MISMATCHED-CONFIRM-REFUSED', added, 'VALIDATION')
      }
    },
  }),

  tool('change-root-password', {
    prefix: 'S13T17', as: 'root', probe: '/api/server/root-password',
    page: { route: '/whm/security/ssh', read: '/api/security/ssh', shows: data => (data?.ssh?.keys?.items ?? []).slice(0, 1).map(item => item.fingerprint) },
    paths: /^\/api\/server\/root-password$/, requests: 15,
    unit: [{ id: 'S13T17-UNIT-1', file: 'apps/api/src/root-identity-workspace.test.ts', name: 'Change Root Password re-authenticates, applies the strength rule and audits before and after the host change' }],
    checks: ['CAPABILITY-READ', 'CONFIRMATION-MISMATCH-REFUSED', 'WEAK-CREDENTIAL-REFUSED'],
    async run({ root, check, refused }) {
      const cap = await root.get('/api/server/root-password')
      check('CAPABILITY-READ', cap.status === 200 && cap.data?.capability?.reauthentication === 'required' && cap.data?.capability?.audit === 'enabled', {
        status: cap.status, hostState: cap.data?.host ?? null,
      })
      refused('CONFIRMATION-MISMATCH-REFUSED', await root.post('/api/server/root-password', {
        currentPassword: 'unused', password: credential(), confirmation: credential(),
      }), 'VALIDATION')
      refused('WEAK-CREDENTIAL-REFUSED', await root.post('/api/server/root-password', {
        currentPassword: 'unused', password: 'weak', confirmation: 'weak',
      }), 'VALIDATION')
    },
  }),

  tool('system-maintenance-schedule', {
    prefix: 'S13T18', as: 'root', restores: ['/api/server/maintenance-schedule'], probe: '/api/server/maintenance-schedule',
    page: { route: '/whm/server/cron', read: '/api/server/settings' },
    paths: /^\/api\/server\/(?:maintenance-schedule|settings)$/, requests: 20,
    unit: [{ id: 'S13T18-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations validates and saves system mail, panel TLS, the schedule and update preferences' }],
    checks: ['INVALID-MINUTE-REFUSED', 'INVALID-WEEKDAY-REFUSED', 'SCHEDULE-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/maintenance-schedule')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origUpdater = before.data?.updater ?? '0 3 * * *'
      const origBackup = before.data?.backup ?? null
      refused('INVALID-MINUTE-REFUSED', await root.put('/api/server/maintenance-schedule', {
        updater: '60 2 * * *', backup: origBackup, expectedRevision: rev,
      }), 'VALIDATION')
      refused('INVALID-WEEKDAY-REFUSED', await root.put('/api/server/maintenance-schedule', {
        updater: '0 2 * * 7', backup: origBackup, expectedRevision: rev,
      }), 'VALIDATION')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('SCHEDULE-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('maintenance schedule', async () => {
        const now = await root.get('/api/server/maintenance-schedule')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.updater === origUpdater && now.data?.backup === origBackup) return true
        return (await root.put('/api/server/maintenance-schedule', { updater: origUpdater, backup: origBackup, expectedRevision: now.data.revision })).status === 200
      })
      const nextUpdater = origUpdater === '15 4 * * *' ? '20 4 * * *' : '15 4 * * *'
      const saved = await root.put('/api/server/maintenance-schedule', { updater: nextUpdater, backup: origBackup, expectedRevision: rev })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/maintenance-schedule', { updater: origUpdater, backup: origBackup, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('SCHEDULE-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.updater === nextUpdater && restored.status === 200, {
        savedStatus: saved.status, updater: saved.data?.updater ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('server-role-profile', {
    prefix: 'S13T19', as: 'root', needs: ['account'], probe: '/api/server/role-profile',
    page: { route: '/whm/server/role', read: '/api/server/settings' },
    paths: /^\/api\/server\/(?:role-profile(?:\/review)?|settings)$/, requests: 20,
    unit: [{ id: 'S13T19-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations refuses the current profile and a change that stops what accounts use' }],
    checks: ['PROFILE-AND-PREVIEW-READ', 'UNCHANGED-PROFILE-REFUSED', 'ACTIVE-ROLE-STOP-PRECONDITION'],
    async run({ root, check, refused }) {
      const current = await root.get('/api/server/role-profile')
      const rev = typeof current.data?.revision === 'string' ? current.data.revision : ZERO_REV
      const curProfile = current.data?.state?.profile ?? 'full'
      const curOptional = Array.isArray(current.data?.state?.optional) ? current.data.state.optional : []
      const nextOptional = curOptional.includes('postgresql') ? curOptional.filter(item => item !== 'postgresql') : [...curOptional, 'postgresql']
      const previewBody = curProfile === 'full' ? { profile: 'full', optional: nextOptional } : { profile: 'full', optional: [] }
      const preview = await root.post('/api/server/role-profile/review', previewBody)
      check('PROFILE-AND-PREVIEW-READ', current.status === 200 && Array.isArray(current.data?.effective) && preview.status === 200 && Array.isArray(preview.data?.changes), {
        status: current.status, previewStatus: preview.status,
      })
      refused('UNCHANGED-PROFILE-REFUSED', await root.put('/api/server/role-profile', {
        profile: curProfile, optional: curOptional, expectedRevision: rev,
      }), 'VALIDATION')
      refused('ACTIVE-ROLE-STOP-PRECONDITION', await root.put('/api/server/role-profile', {
        profile: 'dns-only', optional: [], expectedRevision: rev,
      }), 'PRECONDITION_FAILED')
    },
  }),

  tool('web-stats-engines', {
    prefix: 'S13T20', as: 'root', restores: ['/api/server/web-stats'], probe: '/api/server/web-stats', requires_qualification_admission: true,
    page: { route: '/whm/monitoring/logs', read: '/api/server/settings' },
    paths: /^\/api\/server\/(?:web-stats|settings)$/, requests: 20,
    unit: [{ id: 'S13T20-UNIT-1', file: 'apps/api/src/web-stats-workspace.test.ts', name: 'saved statistics configuration reads and saves the root policy, keeping owner choices and refusing an interval off the 0.25 step' }],
    checks: ['OFF-QUARTER-INTERVAL-REFUSED', 'STALE-REVISION-CONFLICT', 'BLACKOUT-HOURS-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/web-stats')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const origPolicy = before.data?.policy
      const fallbackPolicy = origPolicy ?? {
        engines: { analog: { available: false, defaultOn: false }, awstats: { available: true, defaultOn: true }, webalizer: { available: true, defaultOn: false } },
        intervalHours: 24, bandwidthHours: 2, blackoutHours: [], users: 'all', allowed: {},
      }
      refused('OFF-QUARTER-INTERVAL-REFUSED', await root.put('/api/server/web-stats', {
        revision: rev, policy: { ...fallbackPolicy, intervalHours: 0.3 },
      }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/web-stats', {
        revision: ZERO_REV, policy: fallbackPolicy,
      }), 'CONFLICT')
      if (before.status !== 200 || !origPolicy || typeof before.data?.revision !== 'string') {
        check('BLACKOUT-HOURS-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('web stats policy', async () => {
        const now = await root.get('/api/server/web-stats')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (same(now.data?.policy, origPolicy)) return true
        return (await root.put('/api/server/web-stats', { revision: now.data.revision, policy: origPolicy })).status === 200
      })
      const nextHours = same(origPolicy.blackoutHours, [2]) ? [3] : [2]
      const saved = await root.put('/api/server/web-stats', { revision: rev, policy: { ...origPolicy, blackoutHours: nextHours } })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/web-stats', { revision: saved.data.revision, policy: origPolicy })
        : { status: 0 }
      check('BLACKOUT-HOURS-SAVED-AND-RESTORED', saved.status === 200 && same(saved.data?.policy?.blackoutHours, nextHours) && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('update-preferences', {
    prefix: 'S13T21', as: 'root', probe: '/api/server/update-preferences',
    page: { route: '/whm/server/upgrade', read: '/api/server/upgrade', shows: data => [data?.current?.version] },
    paths: /^\/api\/server\/(?:update-preferences|upgrade)$/, requests: 20,
    unit: [{ id: 'S13T21-UNIT-1', file: 'apps/api/src/server-operations-workspace.test.ts', name: 'WHM server operations reports the cluster on saved update preferences only when asked, and no push without members' }],
    checks: ['UNKNOWN-TIER-REFUSED', 'STALE-REVISION-CONFLICT', 'PREFERENCES-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const before = await root.get('/api/server/update-preferences')
      const rev = typeof before.data?.revision === 'string' ? before.data.revision : ZERO_REV
      const orig = {
        tier: before.data?.tier ?? 'stable',
        updates: before.data?.updates ?? 'manual',
        securityPatches: before.data?.securityPatches ?? true,
        majorDelayDays: before.data?.majorDelayDays ?? 0,
      }
      refused('UNKNOWN-TIER-REFUSED', await root.put('/api/server/update-preferences', { ...orig, tier: 'nightly', expectedRevision: rev }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.put('/api/server/update-preferences', { ...orig, expectedRevision: ZERO_REV }), 'CONFLICT')
      if (before.status !== 200 || typeof before.data?.revision !== 'string') {
        check('PREFERENCES-SAVED-AND-RESTORED', false, { status: before.status })
        return
      }
      undo('update preferences', async () => {
        const now = await root.get('/api/server/update-preferences')
        if (now.status !== 200 || typeof now.data?.revision !== 'string') return false
        if (now.data?.tier === orig.tier && now.data?.updates === orig.updates && now.data?.securityPatches === orig.securityPatches && now.data?.majorDelayDays === orig.majorDelayDays) return true
        return (await root.put('/api/server/update-preferences', { ...orig, expectedRevision: now.data.revision })).status === 200
      })
      const nextDelay = orig.majorDelayDays === 7 ? 14 : 7
      const saved = await root.put('/api/server/update-preferences', { ...orig, majorDelayDays: nextDelay, expectedRevision: rev })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/update-preferences', { ...orig, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('PREFERENCES-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.majorDelayDays === nextDelay && restored.status === 200, {
        savedStatus: saved.status, majorDelayDays: saved.data?.majorDelayDays ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('panel-upgrade', {
    prefix: 'S13T22', as: 'root', probe: '/api/server/upgrade',
    page: { route: '/whm/server/upgrade', read: '/api/server/upgrade', shows: data => [data?.current?.version] },
    paths: /^\/api\/server\/upgrade(?:\/(?:status|preflight|start))?$/, requests: 20,
    unit: [{ id: 'S13T22-UNIT-1', file: 'apps/api/src/upgrade-workspace.test.ts', name: 'API upgrade workspace rejects request-controlled preflight evidence with 422 semantics' }],
    checks: ['UPGRADE-WORKSPACE-READ', 'FORCE-BYPASS-REFUSED', 'CONFIRMATION-MISMATCH-REFUSED', 'STALE-REVISION-CONFLICT'],
    async run({ root, check, refused }) {
      const [view, status] = await Promise.all([root.get('/api/server/upgrade'), root.get('/api/server/upgrade/status')])
      const rev = typeof view.data?.revision === 'string' ? view.data.revision : ZERO_REV
      check('UPGRADE-WORKSPACE-READ', view.status === 200 && typeof view.data?.current?.version === 'string' && status.status === 200, {
        status: view.status, statusRead: status.status, version: view.data?.current?.version ?? null,
      })
      refused('FORCE-BYPASS-REFUSED', await root.post('/api/server/upgrade/preflight', {
        targetVersion: '99.99.99', expectedRevision: rev, force: true,
      }), 'VALIDATION')
      refused('CONFIRMATION-MISMATCH-REFUSED', await root.post('/api/server/upgrade/start', {
        targetVersion: '99.99.99', expectedRevision: rev, confirm: 'wrong',
      }), 'VALIDATION')
      refused('STALE-REVISION-CONFLICT', await root.post('/api/server/upgrade/preflight', {
        targetVersion: '99.99.99', expectedRevision: 'f'.repeat(64),
      }), 'CONFLICT')
    },
  }),

  tool('advanced-settings-browser', {
    prefix: 'S13T23', as: 'root', probe: '/api/server/settings-index',
    page: { route: '/whm/server/setup', read: '/api/server/settings' },
    paths: /^\/api\/server\/(?:settings-index(?:\?key=x)?|tweak-settings|settings)$/, requests: 25,
    unit: [{ id: 'S13T23-UNIT-1', file: 'apps/api/src/tweak-settings-workspace.test.ts', name: 'Tweak Settings and the Advanced Settings Browser reads every indexed setting from its own store' }],
    checks: ['SELECTOR-QUERY-REFUSED', 'UNKNOWN-KEY-REFUSED', 'INDEX-REFLECTS-SAVED-TWEAK'],
    async run({ root, check, refused, undo }) {
      refused('SELECTOR-QUERY-REFUSED', await root.get('/api/server/settings-index?key=x'), 'VALIDATION')
      const { values, revision } = await guardTweak(root, undo)
      refused('UNKNOWN-KEY-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'unknown.key': true }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('INDEX-REFLECTS-SAVED-TWEAK', false, { hasValues: false })
        return
      }
      const nextVal = values['server.healthCheckMinutes'] === 15 ? 20 : 15
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'server.healthCheckMinutes': nextVal }, expectedRevision: revision,
      })
      const idx = await root.get('/api/server/settings-index')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('INDEX-REFLECTS-SAVED-TWEAK', saved.status === 200 && idx.status === 200 && idx.data?.values?.['server.healthCheckMinutes'] === nextVal && restored.status === 200, {
        savedStatus: saved.status, indexedValue: idx.data?.values?.['server.healthCheckMinutes'] ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-system', {
    prefix: 'S13T24', as: 'root', probe: '/api/server/tweak-settings',
    page: { route: '/whm/server/setup', read: '/api/server/settings' },
    paths: /^\/api\/server\/(?:tweak-settings|monitoring-alerts|settings)$/, requests: 25,
    unit: [{ id: 'S13T24-UNIT-1', file: 'apps/api/src/tweak-settings-workspace.test.ts', name: 'Tweak Settings and the Advanced Settings Browser saves a value inside its definition, refuses others and feeds the alert schedule' }],
    checks: ['BELOW-MIN-MINUTES-REFUSED', 'ABOVE-MAX-MINUTES-REFUSED', 'HEALTH-INTERVAL-FEEDS-ALERTS'],
    async run({ root, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('BELOW-MIN-MINUTES-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'server.healthCheckMinutes': 0 }, expectedRevision: revision,
      }), 'VALIDATION')
      refused('ABOVE-MAX-MINUTES-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'server.healthCheckMinutes': 121 }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('HEALTH-INTERVAL-FEEDS-ALERTS', false, { hasValues: false })
        return
      }
      const nextVal = values['server.healthCheckMinutes'] === 10 ? 12 : 10
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'server.healthCheckMinutes': nextVal }, expectedRevision: revision,
      })
      const alerts = await root.get('/api/server/monitoring-alerts')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('HEALTH-INTERVAL-FEEDS-ALERTS', saved.status === 200 && alerts.status === 200 && alerts.data?.delivery?.scheduler?.everyMinutes === nextVal && restored.status === 200, {
        savedStatus: saved.status, everyMinutes: alerts.data?.delivery?.scheduler?.everyMinutes ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-security', {
    prefix: 'S13T25', as: 'root', probe: '/api/server/tweak-settings',
    paths: /^\/api\/server\/tweak-settings$/, requests: 25,
    unit: [{ id: 'S13T25-UNIT-1', file: 'apps/api/src/session-address.test.ts', name: 'session address validation refuses a valid cookie replayed from another address and says why' }],
    checks: ['INVALID-VALIDATION-MODE-REFUSED', 'ZERO-HOURLY-LIMIT-REFUSED', 'SECURITY-TWEAK-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('INVALID-VALIDATION-MODE-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'security.cookieIpValidation': 'paranoid' }, expectedRevision: revision,
      }), 'VALIDATION')
      refused('ZERO-HOURLY-LIMIT-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'security.mailboxSendsPerHour': 0 }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('SECURITY-TWEAK-SAVED-AND-RESTORED', false, { hasValues: false })
        return
      }
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'security.mailboxSendsPerHour': 250 }, expectedRevision: revision,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('SECURITY-TWEAK-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.values?.['security.mailboxSendsPerHour'] === 250 && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-domains', {
    prefix: 'S13T26', as: 'root', needs: ['account'], probe: '/api/server/tweak-settings',
    page: { route: '/whm/domains', read: '/api/domains' },
    paths: /^\/api\/(?:server\/tweak-settings|domains)$/, requests: 25,
    unit: [{ id: 'S13T26-UNIT-1', file: 'packages/core/src/tweaks/domains.test.ts', name: 'Tweak Settings: Domains keeps a chosen document root inside public_html' }],
    checks: ['NON-BOOLEAN-TWEAK-REFUSED', 'OUTSIDE-PUBLIC-HTML-ENFORCED'],
    async run({ root, fixture, tag, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('NON-BOOLEAN-TWEAK-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'domains.docrootPublicHtml': 'yes' }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values || typeof fixture.accountId !== 'string') {
        check('OUTSIDE-PUBLIC-HTML-ENFORCED', false, { hasValues: Boolean(values) })
        return
      }
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'domains.docrootPublicHtml': true }, expectedRevision: revision,
      })
      const outside = await root.post('/api/domains', {
        accountId: fixture.accountId,
        name: `sub-${tag}.${fixture.domain}`,
        kind: 'subdomain',
        docRoot: `/home/${fixture.username}/outside-${tag}`,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('OUTSIDE-PUBLIC-HTML-ENFORCED', saved.status === 200 && outside.status === 422 && outside.data?.code === 'VALIDATION' && restored.status === 200, {
        savedStatus: saved.status, outsideStatus: outside.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-mail', {
    prefix: 'S13T27', as: 'root', probe: '/api/server/mailx/server',
    page: { route: '/whm/email/server', read: '/api/server/mail-server/server' },
    paths: /^\/api\/server\/(?:mailx\/(?:server(?:\/preview)?|marketing)|mail-server\/server)$/, requests: 20,
    unit: [{ id: 'S13T27-UNIT-1', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server settings and routing policy previews the exact rendered change, then saves and applies it with the changed keys in the audit' }],
    checks: ['MAILX-SERVER-AND-MARKETING-READ', 'OPEN-RELAY-MYNETWORKS-REFUSED', 'RBL-PREVIEW-DIFF-RENDERED'],
    async run({ root, check, refused }) {
      const [srv, mkt] = await Promise.all([root.get('/api/server/mailx/server'), root.get('/api/server/mailx/marketing')])
      const rev = typeof srv.data?.revision === 'string' ? srv.data.revision : ZERO_REV
      const basePolicy = srv.data?.policy ?? { postfix: {}, dovecot: {}, rbl: null, certificates: { smtp: null, submission: null, imap: null } }
      check('MAILX-SERVER-AND-MARKETING-READ', srv.status === 200 && srv.data?.section === 'server' && mkt.status === 200, {
        srvStatus: srv.status, mktStatus: mkt.status,
      })
      refused('OPEN-RELAY-MYNETWORKS-REFUSED', await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, postfix: { ...(basePolicy.postfix ?? {}), mynetworks: '0.0.0.0/0;evil' } },
        expectedRevision: rev,
      }), 'VALIDATION')
      const preview = await root.post('/api/server/mailx/server/preview', {
        policy: { ...basePolicy, rbl: ['zen.spamhaus.org'] },
        expectedRevision: rev,
      })
      check('RBL-PREVIEW-DIFF-RENDERED', preview.status === 200 && Array.isArray(preview.data?.changes), {
        status: preview.status, changes: Array.isArray(preview.data?.changes) ? preview.data.changes.length : null,
      })
    },
  }),

  tool('tweak-redirection', {
    prefix: 'S13T28', as: 'root', probe: '/api/server/tweak-settings',
    paths: /^\/api\/server\/tweak-settings$/, requests: 25,
    unit: [{ id: 'S13T28-UNIT-1', file: 'packages/core/src/tweaks/tweaks.test.ts', name: 'tweak settings registry takes only an https address or nothing for the sign-out address' }],
    checks: ['HTTP-LOGOUT-URL-REFUSED', 'HTTPS-LOGOUT-URL-SAVED-AND-RESTORED'],
    async run({ root, tag, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('HTTP-LOGOUT-URL-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'redirection.logoutUrl': 'http://insecure.example.net/out' }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('HTTPS-LOGOUT-URL-SAVED-AND-RESTORED', false, { hasValues: false })
        return
      }
      const targetUrl = `https://xq-${tag}.example.net/bye`
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'redirection.logoutUrl': targetUrl }, expectedRevision: revision,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('HTTPS-LOGOUT-URL-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.values?.['redirection.logoutUrl'] === targetUrl && restored.status === 200, {
        savedStatus: saved.status, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-stats-logs', {
    prefix: 'S13T29', as: 'root', needs: ['account'], probe: '/api/server/logs/retention',
    paths: /^\/api\/server\/(?:logs\/retention|tweak-settings)$/, requests: 25,
    unit: [{ id: 'S13T29-UNIT-1', file: 'apps/agent/src/log-rotation.test.ts', name: 'raw access log rotation after metering rotates once per UTC day, only while the meter follows the file, and verifies that nginx reopened it' }],
    checks: ['BELOW-MIN-HOLD-MB-REFUSED', 'ROTATE-DAYS-SAVED-AND-SURFACED'],
    async run({ root, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('BELOW-MIN-HOLD-MB-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'logs.holdMaxMb': 5 }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('ROTATE-DAYS-SAVED-AND-SURFACED', false, { hasValues: false })
        return
      }
      const nextDays = values['logs.panelRotateDays'] === 21 ? 28 : 21
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'logs.panelRotateDays': nextDays }, expectedRevision: revision,
      })
      const retention = await root.get('/api/server/logs/retention')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('ROTATE-DAYS-SAVED-AND-SURFACED', saved.status === 200 && retention.status === 200 && retention.data?.panelRotateDays === nextDays && restored.status === 200, {
        savedStatus: saved.status, panelRotateDays: retention.data?.panelRotateDays ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-sql', {
    prefix: 'S13T30', as: 'root', also: ['owner'], needs: ['account'], probe: '/api/server/databases/settings',
    page: { route: '/whm/databases/servers', read: '/api/server/databases/overview' },
    paths: /^\/api\/(?:server\/databases\/(?:settings|overview)|databases)$/, requests: 20,
    unit: [{ id: 'S13T30-UNIT-1', file: 'apps/api/src/whm-db-tools-workspace.test.ts', name: 'Tweak Settings: SQL route saves its keys, keeps other saved tweaks out of its way and refuses a stale revision' }],
    checks: ['SQL-SETTINGS-READ', 'NON-BOOLEAN-SQL-SETTING-REFUSED', 'STALE-SQL-REVISION-CONFLICT', 'UNPREFIXED-DB-NAME-REFUSED'],
    async run({ root, owner, check, refused }) {
      const sql = await root.get('/api/server/databases/settings')
      const rev = typeof sql.data?.revision === 'string' ? sql.data.revision : ZERO_REV
      check('SQL-SETTINGS-READ', sql.status === 200 && sql.data?.state === 'read' && typeof rev === 'string', {
        status: sql.status, state: sql.data?.state ?? null,
      })
      refused('NON-BOOLEAN-SQL-SETTING-REFUSED', await root.put('/api/server/databases/settings', {
        autotuneLimits: 'yes', innodbBufferPoolByRam: false, expectedRevision: rev,
      }), 'VALIDATION')
      refused('STALE-SQL-REVISION-CONFLICT', await root.put('/api/server/databases/settings', {
        autotuneLimits: false, innodbBufferPoolByRam: false, expectedRevision: ZERO_REV,
      }), 'CONFLICT')
      refused('UNPREFIXED-DB-NAME-REFUSED', await owner.post('/api/databases', { name: 'shop' }), 'VALIDATION')
    },
  }),

  tool('tweak-compression', {
    prefix: 'S13T31', as: 'root', probe: '/api/backups/workspace',
    page: { route: '/whm/backups', read: '/api/backups/schedule', shows: data => [data?.schedule?.stagingDir] },
    paths: /^\/api\/(?:backups\/(?:workspace|schedule)|server\/tweak-settings)$/, requests: 25,
    unit: [{ id: 'S13T31-UNIT-1', file: 'apps/agent/src/lifecycle-transfer-tasks.test.ts', name: 'transfer host tasks compresses the home package at the saved Tweak Settings gzip level' }],
    checks: ['GZIP-ABOVE-MAX-REFUSED', 'ZSTD-ABOVE-MAX-REFUSED', 'COMPRESSION-LEVELS-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      const { values, revision } = await guardTweak(root, undo)
      refused('GZIP-ABOVE-MAX-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'compression.gzipLevel': 10 }, expectedRevision: revision,
      }), 'VALIDATION')
      refused('ZSTD-ABOVE-MAX-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'compression.zstdLevel': 20 }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('COMPRESSION-LEVELS-SAVED-AND-RESTORED', false, { hasValues: false })
        return
      }
      const nextGzip = values['compression.gzipLevel'] === 9 ? 8 : 9
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'compression.gzipLevel': nextGzip, 'compression.zstdLevel': 5 }, expectedRevision: revision,
      })
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('COMPRESSION-LEVELS-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.values?.['compression.gzipLevel'] === nextGzip && saved.data?.values?.['compression.zstdLevel'] === 5 && restored.status === 200, {
        savedStatus: saved.status, gzipLevel: saved.data?.values?.['compression.gzipLevel'] ?? null, restoredStatus: restored.status,
      })
    },
  }),

  tool('tweak-notifications', {
    prefix: 'S13T32', as: 'root', probe: '/api/server/panel/notifications',
    page: { route: '/whm/panel/notifications', read: '/api/server/panel/notifications', shows: () => ['Notifications'] },
    paths: /^\/api\/server\/(?:panel\/notifications|monitoring-alerts|tweak-settings)$/, requests: 20,
    unit: [{ id: 'S13T32-UNIT-1', file: 'apps/api/src/monitoring-alerts.test.ts', name: 'monitoring alerts route delivers each firing episode once by email and webhook, then its resolution, and shows it in the log' }],
    checks: ['NOTIFICATIONS-AND-ALERTS-READ', 'ZERO-LOAD-THRESHOLD-REFUSED', 'STALE-ALERTS-CONFLICT'],
    async run({ root, check, refused }) {
      const [notifs, alerts, tweaks] = await Promise.all([
        root.get('/api/server/panel/notifications'),
        root.get('/api/server/monitoring-alerts'),
        root.get('/api/server/tweak-settings'),
      ])
      check('NOTIFICATIONS-AND-ALERTS-READ', notifs.status === 200 && alerts.status === 200 && tweaks.status === 200, {
        notifsStatus: notifs.status, alertsStatus: alerts.status,
      })
      refused('ZERO-LOAD-THRESHOLD-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(tweaks.data?.values ?? {}), 'status.loadThreshold': 0 },
        expectedRevision: typeof tweaks.data?.revision === 'string' ? tweaks.data.revision : ZERO_REV,
      }), 'VALIDATION')
      refused('STALE-ALERTS-CONFLICT', await root.put('/api/server/monitoring-alerts', {
        rules: Array.isArray(alerts.data?.rules) ? alerts.data.rules : [],
        quiet: alerts.data?.quiet ?? null,
        expectedRevision: ZERO_REV,
      }), 'CONFLICT')
    },
  }),

  tool('tweak-software', {
    prefix: 'S13T33', as: 'root', probe: '/api/server/panel/settings',
    page: { route: '/whm/panel/settings', read: '/api/server/settings', shows: () => ['Panel settings'] },
    paths: /^\/api\/server\/(?:panel\/settings|services\/package-check(?:\?x=1)?|tweak-settings|settings)$/, requests: 25,
    unit: [{ id: 'S13T33-UNIT-1', file: 'apps/agent/src/svc-tools.test.ts', name: 'nightly maintenance honours switched off retention and file checks' }],
    checks: ['PACKAGE-CHECK-SELECTOR-REFUSED', 'NON-BOOLEAN-SOFTWARE-TWEAK-REFUSED', 'NIGHTLY-PACKAGE-CHECK-SAVED-AND-RESTORED'],
    async run({ root, check, refused, undo }) {
      refused('PACKAGE-CHECK-SELECTOR-REFUSED', await root.get('/api/server/services/package-check?x=1'), 'VALIDATION')
      const { values, revision } = await guardTweak(root, undo)
      refused('NON-BOOLEAN-SOFTWARE-TWEAK-REFUSED', await root.put('/api/server/tweak-settings', {
        values: { ...(values ?? {}), 'software.nightlyPackageCheck': 'yes' }, expectedRevision: revision,
      }), 'VALIDATION')
      if (!values) {
        check('NIGHTLY-PACKAGE-CHECK-SAVED-AND-RESTORED', false, { hasValues: false })
        return
      }
      const nextVal = !values['software.nightlyPackageCheck']
      const saved = await root.put('/api/server/tweak-settings', {
        values: { ...values, 'software.nightlyPackageCheck': nextVal }, expectedRevision: revision,
      })
      const pkgCheck = await root.get('/api/server/services/package-check')
      const restored = typeof saved.data?.revision === 'string'
        ? await root.put('/api/server/tweak-settings', { values, expectedRevision: saved.data.revision })
        : { status: 0 }
      check('NIGHTLY-PACKAGE-CHECK-SAVED-AND-RESTORED', saved.status === 200 && saved.data?.values?.['software.nightlyPackageCheck'] === nextVal && pkgCheck.status === 200 && restored.status === 200, {
        savedStatus: saved.status, pkgCheckStatus: pkgCheck.status, restoredStatus: restored.status,
      })
    },
  }),
]
