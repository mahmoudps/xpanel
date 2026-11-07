import { randomBytes } from 'node:crypto'
import { safeResponse, tool } from './kit.mjs'

const secret = () => `Xq-${randomBytes(18).toString('base64url')}-9a`
const ZERO = '0'.repeat(64)
const missing = (check, ids, why) => { for (const id of ids) check(id, false, { reason: why }) }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// --- databases -------------------------------------------------------------------------------------------------------

async function databaseGone(root, fixture, id) {
  const listed = await root.get(`/api/databases?accountId=${fixture.accountId}&includeTrashed=true`)
  return listed.status === 200 && !(listed.data?.databases ?? []).some(row => row.id === id)
}
async function userGone(root, fixture, id) {
  const listed = await root.get(`/api/databases/users?accountId=${fixture.accountId}`)
  return listed.status === 200 && !(listed.data?.users ?? []).some(row => row.id === id)
}
/** One database and one granted user on the run fixture account; each is undone as soon as it exists. */
async function provision({ root, fixture, tag, undo }) {
  const created = await root.post('/api/databases', { accountId: fixture.accountId, name: `r${tag}` })
  const database = created.data?.database
  if (created.status !== 201 || typeof database?.id !== 'string') return { created }
  undo('database', async () => { const gone = await root.delete(`/api/databases/${database.id}`); return [200, 404].includes(gone.status) && await databaseGone(root, fixture, database.id) })
  const made = await root.post('/api/databases/users', { accountId: fixture.accountId, name: `u${tag}`, password: secret(), databaseId: database.id, privileges: ['SELECT', 'INSERT'] })
  const user = made.data?.user
  if (made.status !== 201 || typeof user?.id !== 'string') return { created, database, made }
  undo('database user', async () => { const gone = await root.delete(`/api/databases/users/${user.id}`); return [200, 404].includes(gone.status) && await userGone(root, fixture, user.id) })
  return { created, database, user, made }
}
const userRow = async (root, fixture, id) => (await root.get(`/api/databases/users?accountId=${fixture.accountId}`)).data?.users?.find(row => row.id === id)
const schemaTables = async (root, name) => (await root.get('/api/server/databases/overview')).data?.databases?.find(row => row.name === name)?.tables

const DB_PATHS = /^\/api\/(?:databases(?:\/users)?(?:\/[0-9a-f-]{36})?(?:\?[A-Za-z0-9=&_.-]{1,128})?|server\/databases\/overview)$/

// --- backups ---------------------------------------------------------------------------------------------------------

const SCHEDULE = ['enabled', 'frequency', 'cron', 'retentionCount', 'retentionWeekly', 'retentionMonthly', 'compress', 'includeDatabases', 'includeMail', 'includeDns', 'includeControl', 'selectedAccounts', 'destinationIds']
const pick = schedule => Object.fromEntries(SCHEDULE.map(key => [key, schedule?.[key]]))
/** Reads the saved schedule first; the undo puts it back and re-reads it. Null when it cannot be read. */
async function guardSchedule(root, undo) {
  const before = await root.get('/api/backups/schedule')
  if (before.status !== 200 || !before.data?.schedule) return null
  const saved = pick(before.data.schedule)
  undo('backup schedule', async () => {
    const now = await root.get('/api/backups/schedule')
    if (now.status !== 200) return false
    if (same(pick(now.data?.schedule), saved)) return true
    if ((await root.put('/api/backups/schedule', saved)).status !== 200) return false
    const again = await root.get('/api/backups/schedule')
    return again.status === 200 && same(pick(again.data?.schedule), saved)
  })
  return saved
}
async function destinationGone(root, id) {
  const listed = await root.get('/api/backups/destinations')
  return listed.status === 200 && !(listed.data?.destinations ?? []).some(row => row.id === id)
}
const dropDestination = async (root, id) => [200, 404].includes((await root.delete(`/api/backups/destinations/${id}`)).status) && await destinationGone(root, id)
const destinationBody = (tag, name, extra = {}) => ({ name: `xq-${tag}-${name}`, kind: 'sftp', endpoint: `sftp://xq-${tag}.invalid`, pathPrefix: '/backups/xq', username: 'xq', retentionDays: 30, enabled: false, ...extra })

// --- transfers -------------------------------------------------------------------------------------------------------

const SESSIONS = '/api/transfers/sessions'
const sourceAuth = tag => ({ kind: 'ssh-key', host: `xq-${tag}.example.net`, port: 22, user: 'root', keyId: `xq${tag}`, hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` })
async function cancelSession(root, id) {
  const read = await root.get(`${SESSIONS}/${id}`)
  if (read.status === 404) return true
  if (!['cancelled', 'failed', 'completed'].includes(read.data?.session?.state)) await root.patch(`${SESSIONS}/${id}`, { expectedRevision: read.data?.revision, action: 'cancel' })
  const removed = await root.delete(`${SESSIONS}/${id}`)
  return removed.status === 200
}
/** A session pointing at a name that is never contacted, since no discovery is started. */
async function openSession(root, tag, undo, extra = {}) {
  const response = await root.post(SESSIONS, { auth: sourceAuth(tag), ...extra })
  const id = response.data?.session?.id
  if (response.status === 201 && typeof id === 'string') undo('transfer session', () => cancelSession(root, id))
  return { response, id: typeof id === 'string' ? id : null, revision: response.data?.revision }
}
const SESSION_PATHS = /^\/api\/transfers\/sessions(?:\/[0-9a-f-]{36})?$/
const NEEDS_REMOTE = 'This clause needs a second lab host as the source server, which does not exist yet.'
const NEEDS_SMTP = 'This clause needs an SMTP exchange with the mail server, which the panel API and the served site cannot drive.'

export default [
  tool('db-users-admin', {
    prefix: 'DBU', as: 'root', needs: ['account'], probe: '/api/server/databases/users', paths: DB_PATHS, requests: 12,
    unit: [{ id: 'DBU-UNIT-USERS', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database drift projections joins saved name@localhost users with observed accounts and never projects authentication strings' }],
    checks: ['RENAME-LONG-VALIDATION', 'RENAME-KEEPS-GRANTS'],
    async run(context) {
      const { root, fixture, tag, check, refused } = context
      const made = await provision(context)
      if (!made.user) return missing(check, ['RENAME-LONG-VALIDATION', 'RENAME-KEEPS-GRANTS'], 'The run could not create its database user.')
      const url = `/api/databases/users/${made.user.id}`, before = await userRow(root, fixture, made.user.id)
      refused('RENAME-LONG-VALIDATION', await root.patch(url, { name: 'x'.repeat(33) }), 'VALIDATION')
      const name = `${fixture.username}_v${tag}`, renamed = await root.patch(url, { name })
      const after = await userRow(root, fixture, made.user.id)
      check('RENAME-KEEPS-GRANTS', renamed.status === 200 && before?.grants?.length > 0 && after?.name === name && same(before.grants, after.grants), { ...safeResponse(renamed), grantsBefore: before?.grants?.length ?? null, grantsAfter: after?.grants?.length ?? null, renamed: after?.name === name })
    },
  }),

  tool('databases-admin', {
    prefix: 'DBA', as: 'root', needs: ['account'], probe: '/api/server/databases/overview', paths: DB_PATHS, requests: 14,
    unit: [{ id: 'DBA-UNIT-DRIFT', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database drift projections labels saved counts separately and computes schema drift only from an actual read' }],
    checks: ['RENAME-PREFIXED-VALIDATION', 'RENAME-KEEPS-TABLES', 'RENAME-KEEPS-ROWS', 'RENAME-KEEPS-GRANTS'],
    async run(context) {
      const { root, fixture, tag, check, block, refused } = context
      block('RENAME-KEEPS-ROWS', 'No SQL client is available to an API client, so no row count can be read.')
      const made = await provision(context)
      if (!made.user) return missing(check, ['RENAME-PREFIXED-VALIDATION', 'RENAME-KEEPS-TABLES', 'RENAME-KEEPS-GRANTS'], 'The run could not create its database and user.')
      const url = `/api/databases/${made.database.id}`
      refused('RENAME-PREFIXED-VALIDATION', await root.patch(url, { name: 'shop2', prefix: true }), 'VALIDATION')
      const name = `${fixture.username}_r${tag}2`, tablesBefore = await schemaTables(root, made.database.name), grantsBefore = (await userRow(root, fixture, made.user.id))?.grants
      const renamed = await root.patch(url, { name })
      const listed = await root.get(`/api/databases?accountId=${fixture.accountId}`), tablesAfter = await schemaTables(root, name), grantsAfter = (await userRow(root, fixture, made.user.id))?.grants
      const present = (listed.data?.databases ?? []).some(row => row.id === made.database.id && row.name === name)
      check('RENAME-KEEPS-TABLES', renamed.status === 200 && present && typeof tablesBefore === 'number' && tablesBefore === tablesAfter, { ...safeResponse(renamed), tablesBefore: tablesBefore ?? null, tablesAfter: tablesAfter ?? null })
      check('RENAME-KEEPS-GRANTS', renamed.status === 200 && grantsBefore?.length > 0 && same(grantsBefore, grantsAfter), { ...safeResponse(renamed), grantsBefore: grantsBefore?.length ?? null, grantsAfter: grantsAfter?.length ?? null })
    },
  }),

  tool('db-engine-upgrade', {
    prefix: 'DBUP', as: 'root', probe: '/api/server/databases/upgrade', paths: /^\/api\/server\/databases\/upgrade\/apply$/, requests: 4,
    unit: [{ id: 'DBUP-UNIT-REVISION', file: 'apps/api/src/db-workspace.test.ts', name: 'database workspace routes submits the reviewed upgrade revision only and maps an unverifiable job reply to review' }],
    checks: ['DOWNGRADE-REFUSED', 'WARNINGS-NOT-ACKNOWLEDGED'],
    async run({ root, refused }) {
      // A revision of zeros never matches a saved one, so no upgrade can start whatever the body is.
      refused('DOWNGRADE-REFUSED', await root.post('/api/server/databases/upgrade/apply', { expectedRevision: ZERO, acknowledgedWarnings: [], targetVersion: '0.0.1' }), 'VALIDATION')
      refused('WARNINGS-NOT-ACKNOWLEDGED', await root.post('/api/server/databases/upgrade/apply', { expectedRevision: ZERO, acknowledgedWarnings: [] }), 'PRECONDITION_FAILED')
    },
  }),

  tool('db-process-list', {
    prefix: 'DBPL', as: 'root', probe: '/api/server/databases/processes', paths: /^\/api\/server\/databases\/processes$/, requests: 4,
    unit: [{ id: 'DBPL-UNIT-PROCESSES', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database workspace routes projects processes with account owners and the configured engine with service state' }],
    checks: ['IDLE-CONNECTION-LISTED', 'SLEEP-TIME-INCREASES'],
    async run({ root, check, block, sleep }) {
      block('IDLE-CONNECTION-LISTED', 'Opening an idle database connection as a database user needs a MariaDB protocol client, which an API client does not have.')
      const first = await root.get('/api/server/databases/processes'), row = first.data?.processes?.find(item => item.command === 'Sleep')
      await sleep(2000)
      const second = await root.get('/api/server/databases/processes'), later = second.data?.processes?.find(item => item.id === row?.id)
      const increased = later !== undefined && row !== undefined && later.command === 'Sleep' && later.timeSeconds > row.timeSeconds
      check('SLEEP-TIME-INCREASES', first.status === 200 && second.status === 200 && increased, { first: first.status, second: second.status, sleepRows: first.data?.processes?.filter(item => item.command === 'Sleep').length ?? null, increased })
    },
  }),

  tool('backup-config', {
    prefix: 'BKC', restores: ['/api/backups/schedule'], as: 'root', probe: '/api/backups/schedule', paths: /^\/api\/backups\/schedule$/, requests: 10,
    unit: [
      { id: 'BKC-UNIT-CRON', file: 'apps/api/src/completion-whm-backups-security.test.ts', name: 'backup policy validation validates bounded cron fields and refuses command/environment forms' },
      { id: 'BKC-UNIT-SCHEDULE', file: 'apps/api/src/completion-whm-backups-security.test.ts', name: 'WHM backup configuration loopback HTTP security stores a validated requested schedule and refuses deletion of a selected destination' },
    ],
    checks: ['NO-SCHEDULE-VALIDATION', 'NO-CONTENTS-VALIDATION', 'STAGING-HOME-INVALID-PATH', 'STAGING-ETC-INVALID-PATH', 'RETENTION-10000-VALIDATION'],
    async run({ root, undo, check, refused }) {
      const saved = await guardSchedule(root, undo)
      if (!saved) return missing(check, ['NO-SCHEDULE-VALIDATION', 'NO-CONTENTS-VALIDATION', 'STAGING-HOME-INVALID-PATH', 'STAGING-ETC-INVALID-PATH', 'RETENTION-10000-VALIDATION'], 'The saved schedule could not be read.')
      // Each request changes one field of the saved schedule, so an unexpected acceptance alters only that field and the undo restores it.
      const put = body => root.put('/api/backups/schedule', { ...saved, ...body })
      refused('NO-SCHEDULE-VALIDATION', await put({ cron: '' }), 'VALIDATION')
      refused('NO-CONTENTS-VALIDATION', await put({ includeDatabases: false, includeMail: false, includeDns: false, includeControl: false, selectedAccounts: [] }), 'VALIDATION')
      refused('STAGING-HOME-INVALID-PATH', await put({ stagingDir: '/home' }), 'VALIDATION')
      refused('STAGING-ETC-INVALID-PATH', await put({ stagingDir: '/etc/x' }), 'VALIDATION')
      refused('RETENTION-10000-VALIDATION', await put({ retentionCount: 10000 }), 'VALIDATION')
    },
  }),

  tool('backup-destinations', {
    prefix: 'BKD', restores: ['/api/backups/destinations'], as: 'root', probe: '/api/backups/destinations', requests: 16,
    paths: /^\/api\/backups\/(?:destinations(?:\/[0-9a-f-]{36})?|workspace\/destinations\/[0-9a-f-]{36}\/test)$/,
    unit: [{ id: 'BKD-UNIT-LIFECYCLE', file: 'apps/api/src/backup-destinations-workspace.test.ts', name: 'canonical backup destination lifecycle forces new destinations inactive and refuses credentials or proof supplied as fields' }],
    checks: ['WRONG-CREDENTIALS-FAILED', 'OTHER-TARGETS-UNAFFECTED', 'TIMEOUT-20-VALIDATION'],
    async run({ root, tag, undo, check }) {
      const created = await root.post('/api/backups/destinations', destinationBody(tag, 'a'))
      const id = created.data?.destination?.id
      if (created.status !== 201 || typeof id !== 'string') return missing(check, ['WRONG-CREDENTIALS-FAILED', 'OTHER-TARGETS-UNAFFECTED', 'TIMEOUT-20-VALIDATION'], 'The run could not create its destination.')
      undo('backup destination', () => dropDestination(root, id))
      const others = async () => JSON.stringify(((await root.get('/api/backups/destinations')).data?.destinations ?? []).filter(row => row.id !== id))
      const listed = await root.get('/api/backups/destinations'), beforeOthers = await others()
      const tested = await root.post(`/api/backups/workspace/destinations/${id}/test`, { expectedRevision: listed.data?.revision })
      check('WRONG-CREDENTIALS-FAILED', tested.status === 200 && (tested.data?.status === 'failed' || tested.data?.outcome === 'failed') && /auth/i.test(JSON.stringify(tested.data ?? {})), { ...safeResponse(tested), outcome: typeof tested.data?.outcome === 'string' ? tested.data.outcome.slice(0, 32) : null })
      const afterOthers = await others()
      check('OTHER-TARGETS-UNAFFECTED', listed.status === 200 && beforeOthers === afterOthers, { listed: listed.status, unchanged: beforeOthers === afterOthers })
      // Without a valid control, a refusal could come from the unknown field alone and say nothing about the value 20.
      const control = await root.post('/api/backups/destinations', destinationBody(tag, 'b', { timeout: 30 })), controlId = control.data?.destination?.id
      if (typeof controlId === 'string') undo('control destination', () => dropDestination(root, controlId))
      const low = await root.post('/api/backups/destinations', destinationBody(tag, 'c', { timeout: 20 })), lowId = low.data?.destination?.id
      if (typeof lowId === 'string') undo('timeout destination', () => dropDestination(root, lowId))
      check('TIMEOUT-20-VALIDATION', control.status === 201 && low.status >= 400 && low.data?.code === 'VALIDATION', { control: safeResponse(control), value20: safeResponse(low) })
    },
  }),

  tool('backup-user-selection', {
    prefix: 'BKU', restores: ['/api/backups/schedule'], as: 'root', needs: ['account'], probe: '/api/backups/schedule', paths: /^\/api\/backups\/schedule$/, requests: 8,
    unit: [{ id: 'BKU-UNIT-SCHEDULE', file: 'apps/api/src/completion-whm-backups-security.test.ts', name: 'WHM backup configuration loopback HTTP security stores a validated requested schedule and refuses deletion of a selected destination' }],
    checks: ['SELECTION-SAVED', 'NEXT-RUN-EXCLUDES-OFF-ACCOUNT'],
    async run({ root, fixture, undo, check, block }) {
      block('NEXT-RUN-EXCLUDES-OFF-ACCOUNT', 'The archives of a scheduled run exist only after the schedule fires at its configured time, which a run cannot wait for.')
      const saved = await guardSchedule(root, undo)
      if (!saved) return missing(check, ['SELECTION-SAVED'], 'The saved schedule could not be read.')
      const put = await root.put('/api/backups/schedule', { ...saved, selectedAccounts: [fixture.username] })
      const read = await root.get('/api/backups/schedule'), kept = same(read.data?.schedule?.selectedAccounts, [fixture.username])
      check('SELECTION-SAVED', put.status === 200 && read.status === 200 && kept, { ...safeResponse(put), read: read.status, saved: kept })
    },
  }),

  tool('transfer-tool', {
    prefix: 'TRT', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 8,
    unit: [{ id: 'TRT-UNIT-AUTH', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary keeps authentication and root authorization mandatory without exposing stored source details' }],
    checks: ['WRONG-PASSWORD-AUTH-FAILED', 'CORRECT-CREDENTIALS-INVENTORY', 'THREADS-101-VALIDATION'],
    async run({ root, tag, undo, check, block }) {
      block('WRONG-PASSWORD-AUTH-FAILED', NEEDS_REMOTE)
      block('CORRECT-CREDENTIALS-INVENTORY', NEEDS_REMOTE)
      // The control shows 100 is accepted, so the refusal of 101 is about the value and not the field name.
      const control = await openSession(root, tag, undo, { transfer_threads: 100 })
      const high = await openSession(root, tag, undo, { transfer_threads: 101 })
      check('THREADS-101-VALIDATION', control.response.status === 201 && high.response.status >= 400 && high.response.data?.code === 'VALIDATION', { control: safeResponse(control.response), value101: safeResponse(high.response) })
    },
  }),

  tool('linked-server-nodes', {
    prefix: 'LSN', as: 'root', probe: '/api/server/nodes', paths: /^\/api\/server\/nodes$/, requests: 2,
    unit: [{ id: 'LSN-UNIT-LINK', file: 'apps/api/src/ops-nodes-workspace.test.ts', name: 'linked server nodes links two servers with mutual proof and shows no credential' }],
    checks: ['DUPLICATE-HOSTNAME-CONFLICT', 'OTHER-MAJOR-VERSION-REFUSED'],
    async run({ block }) {
      block('DUPLICATE-HOSTNAME-CONFLICT', NEEDS_REMOTE)
      block('OTHER-MAJOR-VERSION-REFUSED', NEEDS_REMOTE)
    },
  }),

  tool('configuration-cluster', {
    prefix: 'CCL', as: 'root', probe: '/api/server/cluster', paths: /^\/api\/server\/cluster$/, requests: 2,
    unit: [{ id: 'CCL-UNIT-PUSH', file: 'apps/api/src/config-cluster.test.ts', name: 'configuration cluster pushes a chosen version, verifies it on the member and rolls it back' }],
    checks: ['UNPRIVILEGED-MEMBER-REFUSED', 'SEND-TO-CLUSTER-PUSHES-EACH-MEMBER'],
    async run({ block }) {
      block('UNPRIVILEGED-MEMBER-REFUSED', NEEDS_REMOTE)
      block('SEND-TO-CLUSTER-PUSHES-EACH-MEMBER', NEEDS_REMOTE)
    },
  }),

  tool('live-transfer', {
    prefix: 'LVT', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 2,
    unit: [{ id: 'LVT-UNIT-CUTOVER', file: 'apps/api/src/live-transfer.test.ts', name: 'live transfer copies, freezes, syncs the rest and cuts the account over' }],
    checks: ['SOURCE-SUSPENDED-AND-PROXYING', 'SITE-SERVED-BY-DESTINATION', 'SOURCE-ZONE-AT-DESTINATION'],
    async run({ block }) {
      block('SOURCE-SUSPENDED-AND-PROXYING', NEEDS_REMOTE)
      block('SITE-SERVED-BY-DESTINATION', NEEDS_REMOTE)
      block('SOURCE-ZONE-AT-DESTINATION', NEEDS_REMOTE)
    },
  }),

  tool('transfer-tool-selection', {
    prefix: 'TRS', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 4,
    unit: [{ id: 'TRS-UNIT-REVISION', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary persists real draft metadata across route-factory restart and keeps the exact revision' }],
    checks: ['CONFLICT-MARKED-NOT-ENQUEUED', 'RENAMED-ENQUEUES'],
    async run({ block }) {
      block('CONFLICT-MARKED-NOT-ENQUEUED', 'A selection needs the remote account inventory of a discovered source, and no second lab host exists to discover.')
      block('RENAMED-ENQUEUES', 'A selection needs the remote account inventory of a discovered source, and no second lab host exists to discover.')
    },
  }),

  tool('account-transfer-progress', {
    prefix: 'TRP', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 8,
    unit: [{ id: 'TRP-UNIT-EMPTY', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary reads empty state without inventing a source or allocating metadata' }],
    checks: ['STATE-IN-ALLOWED-SET', 'PAUSE-STOPS-NEW-ITEMS', 'START-RESUMES', 'CLASH-RENAME-IN-SUMMARY'],
    async run({ root, tag, undo, check, ok, block }) {
      block('CLASH-RENAME-IN-SUMMARY', 'A renamed database appears only after a real transfer between two servers, and no second lab host exists.')
      const session = await openSession(root, tag, undo)
      if (!session.id) return missing(check, ['STATE-IN-ALLOWED-SET', 'PAUSE-STOPS-NEW-ITEMS', 'START-RESUMES'], 'The run could not open its session.')
      const read = await root.get(`${SESSIONS}/${session.id}`), state = read.data?.session?.status ?? read.data?.session?.state
      check('STATE-IN-ALLOWED-SET', read.status === 200 && ['created', 'connected', 'inventoried', 'selected', 'reviewed', 'applying', 'completed', 'failed', 'cancelled'].includes(state), { status: read.status, state: typeof state === 'string' ? state.slice(0, 32) : null })
      ok('PAUSE-STOPS-NEW-ITEMS', await root.patch(`${SESSIONS}/${session.id}`, { expectedRevision: read.data?.revision, action: 'stop' }))
      ok('START-RESUMES', await root.patch(`${SESSIONS}/${session.id}`, { expectedRevision: read.data?.revision, action: 'run', digest: ZERO }))
    },
  }),

  tool('review-transfers-and-restores', {
    prefix: 'TRR', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 8,
    unit: [{ id: 'TRR-UNIT-STOP', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary stops after the current account and skips the rest' }],
    checks: ['IDLE-SESSION-LISTED-FAILED', 'CANCEL-PENDING-FAILED-ABORTED', 'OLD-SESSIONS-PURGED'],
    async run({ root, tag, undo, check, block }) {
      block('IDLE-SESSION-LISTED-FAILED', 'A session becomes two hours idle only by waiting two hours, and an API client cannot change a session time.')
      block('OLD-SESSIONS-PURGED', 'The nightly purge acts on sessions older than 30 days, and an API client cannot age a session or run the purge.')
      const session = await openSession(root, tag, undo)
      if (!session.id) return missing(check, ['CANCEL-PENDING-FAILED-ABORTED'], 'The run could not open its session.')
      const cancelled = await root.patch(`${SESSIONS}/${session.id}`, { expectedRevision: session.revision, action: 'cancel' })
      const state = String(cancelled.data?.session?.state ?? ''), error = String(cancelled.data?.session?.error ?? '')
      check('CANCEL-PENDING-FAILED-ABORTED', cancelled.status === 200 && state.toLowerCase() === 'failed' && /aborted/i.test(error), { ...safeResponse(cancelled), state: state.slice(0, 32) })
    },
  }),

  tool('transfer-or-restore-account', {
    prefix: 'TRA', as: 'root', needs: ['account'], probe: SESSIONS, requests: 8,
    paths: /^\/api\/transfers\/(?:sessions|cpanel-imports(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'TRA-UNIT-BOUNDARY', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary rejects browser-authored connection/completion and caller-authored local inventory' }],
    checks: ['EXISTING-ACCOUNT-REFUSED', 'TMP-ARCHIVE-REFUSED', 'REMOTE-WRONG-PASSWORD-AUTH-FAILED'],
    async run({ root, fixture, undo, refused, block }) {
      block('REMOTE-WRONG-PASSWORD-AUTH-FAILED', NEEDS_REMOTE)
      const discard = async id => {
        const read = await root.get(SESSIONS), row = read.data?.cpanelImports?.find(item => item.id === id)
        if (!row) return read.status === 200
        return (await root.patch(`/api/transfers/cpanel-imports/${id}`, { expectedRevision: row.revision, action: 'discard' })).status === 200
      }
      // An unexpected acceptance would leave an import record behind, so it is discarded as soon as it exists.
      const attempt = async body => {
        const response = await root.post('/api/transfers/cpanel-imports', body), id = response.data?.cpanelImport?.id
        if (typeof id === 'string') undo('cpanel import', () => discard(id))
        return response
      }
      refused('EXISTING-ACCOUNT-REFUSED', await attempt({ filename: `cpmove-${fixture.username}.tar.gz`, bytes: 1, targetUsername: fixture.username, overwrite: 0 }), 'CONFLICT')
      refused('TMP-ARCHIVE-REFUSED', await attempt({ filename: '/tmp/cpmove-u1.tar.gz', bytes: 1 }), 'VALIDATION')
    },
  }),

  tool('mail-delivery-reports', {
    prefix: 'MDR', as: 'root', probe: '/api/server/mail-log/delivery', requests: 14,
    paths: /^\/api\/(?:server\/mail-log\/delivery(?:\?[A-Za-z0-9=&_.:-]{1,128})?|resellers(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'MDR-UNIT-NON-ROOT', file: 'apps/api/src/mail-log-workspace.test.ts', name: 'root mail log workspace refuses a non-root caller with 403 before any host read' }],
    checks: ['RESELLER-SEES-OWN-ONLY', 'SHOW-DELIVERIES-OFF-HIDES-SENT'],
    async run({ root, tag, undo, check, signIn }) {
      const username = `xqr${tag}`, password = secret()
      const made = await root.post('/api/resellers', { username, password, acl: ['list-accounts'], maxAccounts: 1, totalDiskMb: 1024, totalBandwidthMb: 'unlimited', oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] })
      const id = made.data?.reseller?.id
      if (typeof id === 'string') undo('reseller', async () => [200, 404].includes((await root.delete(`/api/resellers/${id}`)).status))
      const { client } = typeof id === 'string' ? await signIn('reseller', { username, password }) : { client: null }
      if (!client) missing(check, ['RESELLER-SEES-OWN-ONLY'], 'The run could not sign in its reseller.')
      else {
        // The reseller owns no account, so a scoped search must return no event at all.
        const own = await client.get('/api/server/mail-log/delivery')
        check('RESELLER-SEES-OWN-ONLY', own.status === 200 && Array.isArray(own.data?.messages) && own.data.messages.length === 0, { ...safeResponse(own), events: own.data?.messages?.length ?? null })
      }
      const hidden = await root.get('/api/server/mail-log/delivery?show_deliveries=0')
      check('SHOW-DELIVERIES-OFF-HIDES-SENT', hidden.status === 200 && Array.isArray(hidden.data?.messages) && !/"status":"sent"/.test(JSON.stringify(hidden.data.messages)), safeResponse(hidden))
    },
  }),

  tool('mail-queue-manager', {
    prefix: 'MQM', as: 'root', probe: '/api/server/mail-queue', paths: /^\/api\/server\/mail-queue(?:\/action)?$/, requests: 6,
    unit: [{ id: 'MQM-UNIT-GRAMMAR', file: 'apps/api/src/mail-queue-workspace.test.ts', name: 'API mail queue workspace validates grammar before dispatch' }],
    checks: ['DELETE-REMOVES-MESSAGE', 'SECOND-DELETE-NOT-FOUND', 'UNFREEZE-NOT-FROZEN'],
    async run({ root, tag, check, block, refused }) {
      block('DELETE-REMOVES-MESSAGE', 'The driver cannot submit a message of its own, and it must not delete a message another sender queued.')
      const listed = await root.get('/api/server/mail-queue'), ghost = `${tag.toUpperCase()}F0F0F0F0`
      if (listed.status !== 200 || (listed.data?.messages ?? []).some(item => item.queueId === ghost)) return missing(check, ['SECOND-DELETE-NOT-FOUND', 'UNFREEZE-NOT-FROZEN'], 'The queue could not be read or already holds the probe identifier.')
      const expectedRevision = listed.data?.revision ?? ZERO
      refused('SECOND-DELETE-NOT-FOUND', await root.post('/api/server/mail-queue/action', { action: 'delete', queueId: ghost, queue: 'deferred', expectedRevision }), 'NOT_FOUND')
      refused('UNFREEZE-NOT-FROZEN', await root.post('/api/server/mail-queue/action', { action: 'release', queueId: ghost, queue: 'hold', expectedRevision }), 'CONFLICT')
    },
  }),

  tool('mail-monitor', {
    prefix: 'MMON', as: 'root', probe: '/api/server/mail-log/monitor', paths: /^\/api\/server\/mail-log\/monitor$/, requests: 2,
    unit: [{ id: 'MMON-UNIT-AGGREGATES', file: 'apps/api/src/mail-log-workspace.test.ts', name: 'root mail log workspace returns monitor aggregates without message rows' }],
    checks: ['BURST-SPIKE-LISTED', 'SPIKE-LINKS-TO-QUEUE'],
    async run({ block }) {
      block('BURST-SPIKE-LISTED', 'A burst of 500 outbound messages needs authenticated SMTP submission from a mailbox, which the panel API and the served site cannot drive.')
      block('SPIKE-LINKS-TO-QUEUE', 'A spike exists only after that burst of outbound messages.')
    },
  }),

  tool('mail-quality', {
    prefix: 'MQL', as: 'root', needs: ['account', 'mailbox'], probe: '/api/server/mail-quality', paths: /^\/api\/server\/mail-quality(?:\/check|\/fix)?$/, requests: 8, deadlineMs: 180_000,
    unit: [{ id: 'MQL-UNIT-DKIM', file: 'apps/api/src/mail-quality-workspace.test.ts', name: 'mail quality checks compares the published DKIM key exactly with the signing key' }],
    checks: ['DKIM-MISSING-SCORED', 'FIX-RAISES-SCORE'],
    async run({ root, fixture, check }) {
      const body = { domains: [fixture.domain] }
      const first = await root.post('/api/server/mail-quality/check', body), dkim = first.data?.results?.[0]?.dkim
      const named = /DKIM missing/i.test(String(dkim?.cause ?? ''))
      check('DKIM-MISSING-SCORED', first.status === 200 && dkim?.state === 'problem' && named, { ...safeResponse(first), state: dkim?.state ?? null, reasonNamesDkim: named })
      const fix = await root.post('/api/server/mail-quality/fix', { domain: fixture.domain, check: 'dkim' })
      const again = await root.post('/api/server/mail-quality/check', body), after = again.data?.results?.[0]?.dkim
      check('FIX-RAISES-SCORE', fix.status === 200 && again.status === 200 && after?.state === 'ok', { fix: safeResponse(fix), recheck: safeResponse(again), state: after?.state ?? null })
    },
  }),

  tool('smtp-relay', {
    prefix: 'SMR', restores: ['/api/server/mailx/relay'], as: 'root', needs: ['account'], probe: '/api/server/mailx/relay', paths: /^\/api\/server\/mailx\/relay$/, requests: 8,
    unit: [{ id: 'SMR-UNIT-RELAY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace saves the relay with CAS, keeps the password out of every view and applies through the agent' }],
    checks: ['SCOPED-RELAY-ACCEPTED', 'SCOPED-DOMAIN-USES-RELAY', 'OTHER-DOMAINS-DELIVER-DIRECT'],
    async run({ root, fixture, undo, check, block }) {
      block('SCOPED-DOMAIN-USES-RELAY', NEEDS_SMTP)
      block('OTHER-DOMAINS-DELIVER-DIRECT', NEEDS_SMTP)
      const before = await root.get('/api/server/mailx/relay')
      if (before.status !== 200 || !before.data?.policy) return missing(check, ['SCOPED-RELAY-ACCEPTED'], 'The saved relay policy could not be read.')
      const { passwordSet: _set, ...policy } = before.data.policy
      const restore = async () => {
        const now = await root.get('/api/server/mailx/relay')
        if (now.status !== 200) return false
        const { passwordSet: _now, ...current } = now.data.policy
        if (same(current, policy)) return true
        if ((await root.put('/api/server/mailx/relay', { policy, expectedRevision: now.data.revision, password: null })).status !== 200) return false
        const again = await root.get('/api/server/mailx/relay')
        if (again.status !== 200) return false
        const { passwordSet: _again, ...restored } = again.data.policy
        return same(restored, policy)
      }
      const scoped = await root.put('/api/server/mailx/relay', { policy: { ...policy, domains: [fixture.domain] }, expectedRevision: before.data.revision, password: null })
      if (scoped.status === 200) undo('relay policy', restore)
      check('SCOPED-RELAY-ACCEPTED', scoped.status === 200, safeResponse(scoped))
    },
  }),

  tool('incoming-mail-domain-filter', {
    prefix: 'IMF', as: 'root', probe: '/api/server/mailx/spam', paths: /^\/api\/server\/mailx\/spam$/, requests: 2,
    unit: [{ id: 'IMF-UNIT-POLICY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace rejects non-root callers, selectors, unknown fields and invalid policies before any write' }],
    checks: ['BLOCKED-DOMAIN-REJECTED-5XX', 'REMOVED-DOMAIN-ACCEPTED'],
    async run({ block }) {
      block('BLOCKED-DOMAIN-REJECTED-5XX', NEEDS_SMTP)
      block('REMOVED-DOMAIN-ACCEPTED', NEEDS_SMTP)
    },
  }),

  tool('whm-greylisting', {
    prefix: 'GRL', as: 'root', probe: '/api/server/mailx/spam', paths: /^\/api\/server\/mailx\/spam$/, requests: 2,
    unit: [{ id: 'GRL-UNIT-POLICY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace rejects non-root callers, selectors, unknown fields and invalid policies before any write' }],
    checks: ['FIRST-ATTEMPT-451', 'RETRY-AFTER-DEFERRAL-ACCEPTED', 'TRUSTED-IP-FIRST-TRY'],
    async run({ block }) {
      block('FIRST-ATTEMPT-451', NEEDS_SMTP)
      block('RETRY-AFTER-DEFERRAL-ACCEPTED', NEEDS_SMTP)
      block('TRUSTED-IP-FIRST-TRY', NEEDS_SMTP)
    },
  }),
]
