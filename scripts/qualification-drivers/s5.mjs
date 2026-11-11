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
    prefix: 'DBA', as: 'root', needs: ['account'], probe: '/api/server/databases/overview', paths: DB_PATHS, requests: 16,
    unit: [{ id: 'DBA-UNIT-DRIFT', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database drift projections labels saved counts separately and computes schema drift only from an actual read' }],
    checks: ['RENAME-PREFIXED-VALIDATION', 'RENAME-KEEPS-TABLES', 'RENAME-IN-SYNC-OVERVIEW', 'RENAME-KEEPS-GRANTS'],
    async run(context) {
      const { root, fixture, tag, check, refused } = context
      const made = await provision(context)
      if (!made.user) return missing(check, ['RENAME-PREFIXED-VALIDATION', 'RENAME-KEEPS-TABLES', 'RENAME-IN-SYNC-OVERVIEW', 'RENAME-KEEPS-GRANTS'], 'The run could not create its database and user.')
      const url = `/api/databases/${made.database.id}`
      refused('RENAME-PREFIXED-VALIDATION', await root.patch(url, { name: 'shop2', prefix: true }), 'VALIDATION')
      const name = `${fixture.username}_r${tag}2`, tablesBefore = await schemaTables(root, made.database.name), grantsBefore = (await userRow(root, fixture, made.user.id))?.grants
      const renamed = await root.patch(url, { name })
      const listed = await root.get(`/api/databases?accountId=${fixture.accountId}`), overview = await root.get('/api/server/databases/overview'), grantsAfter = (await userRow(root, fixture, made.user.id))?.grants
      const overviewRow = (overview.data?.databases ?? []).find(row => row.name === name), tablesAfter = overviewRow?.tables
      const present = (listed.data?.databases ?? []).some(row => row.id === made.database.id && row.name === name)
      check('RENAME-KEEPS-TABLES', renamed.status === 200 && present && typeof tablesBefore === 'number' && tablesBefore === tablesAfter, { ...safeResponse(renamed), tablesBefore: tablesBefore ?? null, tablesAfter: tablesAfter ?? null })
      check('RENAME-IN-SYNC-OVERVIEW', renamed.status === 200 && overview.status === 200 && overviewRow?.account === fixture.username && overviewRow?.drift === 'in-sync' && typeof overviewRow?.sizeBytes === 'number' && overviewRow.sizeBytes >= 0, { status: overview.status, drift: overviewRow?.drift ?? null, sizeBytes: overviewRow?.sizeBytes ?? null })
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
    prefix: 'DBPL', as: 'root', probe: '/api/server/databases/processes', paths: /^\/api\/server\/databases\/processes(?:\/kill)?$/, requests: 8,
    page: {
      route: '/whm/databases/processes', read: '/api/server/databases/processes',
      shows: data => Array.isArray(data?.processes) ? data.processes.filter(item => typeof item?.user === 'string' && item.user.length > 0).slice(0, 1).map(item => item.user) : [],
    },
    unit: [{ id: 'DBPL-UNIT-PROCESSES', file: 'apps/api/src/whm-databases-workspace.test.ts', name: 'WHM database workspace routes projects processes with account owners and the configured engine with service state' }],
    checks: ['PROCESSES-OBSERVED', 'PROTECTED-KILL-REFUSED', 'INVALID-KILL-MODE-REFUSED'],
    async run({ root, check, refused }) {
      const observed = await root.get('/api/server/databases/processes')
      const rows = Array.isArray(observed.data?.processes) ? observed.data.processes : null
      check('PROCESSES-OBSERVED', observed.status === 200 && observed.data?.observed?.state === 'read' && observed.data?.queryText === 'not-read' && rows !== null && rows.length >= 1, { ...safeResponse(observed), state: observed.data?.observed?.state ?? null, count: rows?.length ?? null })
      const guarded = rows?.find(item => item?.protected === true && typeof item.id === 'number')
      if (!guarded) check('PROTECTED-KILL-REFUSED', false, { status: observed.status, protectedFound: false })
      else refused('PROTECTED-KILL-REFUSED', await root.post('/api/server/databases/processes/kill', { id: guarded.id, mode: 'connection', user: guarded.user, db: guarded.db }), 'FORBIDDEN')
      refused('INVALID-KILL-MODE-REFUSED', await root.post('/api/server/databases/processes/kill', { id: 1, mode: 'terminate', user: 'root', db: null }), 'VALIDATION')
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
    prefix: 'BKU', restores: ['/api/backups/schedule'], as: 'root', needs: ['account'], probe: '/api/backups/schedule', paths: /^\/api\/backups\/schedule$/, requests: 10,
    unit: [{ id: 'BKU-UNIT-SCHEDULE', file: 'apps/api/src/completion-whm-backups-security.test.ts', name: 'WHM backup configuration loopback HTTP security stores a validated requested schedule and refuses deletion of a selected destination' }],
    checks: ['SELECTION-SAVED', 'DUPLICATE-ACCOUNT-REFUSED'],
    async run({ root, fixture, undo, check, refused }) {
      const saved = await guardSchedule(root, undo)
      if (!saved) return missing(check, ['SELECTION-SAVED', 'DUPLICATE-ACCOUNT-REFUSED'], 'The saved schedule could not be read.')
      refused('DUPLICATE-ACCOUNT-REFUSED', await root.put('/api/backups/schedule', { ...saved, selectedAccounts: [fixture.username, fixture.username] }), 'VALIDATION')
      const put = await root.put('/api/backups/schedule', { ...saved, selectedAccounts: [fixture.username] })
      const read = await root.get('/api/backups/schedule'), kept = same(read.data?.schedule?.selectedAccounts, [fixture.username])
      check('SELECTION-SAVED', put.status === 200 && read.status === 200 && kept, { ...safeResponse(put), read: read.status, saved: kept })
    },
  }),

  tool('review-transfers-and-restores', {
    prefix: 'TRR', as: 'root', probe: SESSIONS, paths: SESSION_PATHS, requests: 10,
    unit: [{ id: 'TRR-UNIT-STOP', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary stops after the current account and skips the rest' }],
    checks: ['SESSION-LISTED-IN-HISTORY', 'STALE-REVISION-CONFLICT', 'CANCEL-PENDING-FAILED-ABORTED'],
    async run({ root, tag, undo, check, refused }) {
      const session = await openSession(root, tag, undo)
      if (!session.id) return missing(check, ['SESSION-LISTED-IN-HISTORY', 'STALE-REVISION-CONFLICT', 'CANCEL-PENDING-FAILED-ABORTED'], 'The run could not open its session.')
      const listed = await root.get(SESSIONS)
      const inHistory = Array.isArray(listed.data?.sessions) && listed.data.sessions.some(row => row.id === session.id)
      check('SESSION-LISTED-IN-HISTORY', listed.status === 200 && inHistory, { ...safeResponse(listed), listed: inHistory })
      refused('STALE-REVISION-CONFLICT', await root.patch(`${SESSIONS}/${session.id}`, { expectedRevision: ZERO, action: 'cancel' }), 'CONFLICT')
      const cancelled = await root.patch(`${SESSIONS}/${session.id}`, { expectedRevision: session.revision, action: 'cancel' })
      const state = String(cancelled.data?.session?.state ?? '').toLowerCase()
      check('CANCEL-PENDING-FAILED-ABORTED', cancelled.status === 200 && ['cancelled', 'failed', 'aborted'].includes(state), { ...safeResponse(cancelled), state: state.slice(0, 32) })
    },
  }),

  tool('transfer-or-restore-account', {
    prefix: 'TRA', as: 'root', needs: ['account'], probe: SESSIONS, requests: 10,
    paths: /^\/api\/transfers\/(?:sessions(?:\/[0-9a-f-]{36})?|cpanel-imports(?:\/[0-9a-f-]{36})?)$/,
    unit: [{ id: 'TRA-UNIT-BOUNDARY', file: 'apps/api/src/transfer-workspace.test.ts', name: 'strict persisted transfer workspace loopback boundary rejects browser-authored connection/completion and caller-authored local inventory' }],
    checks: ['EXISTING-ACCOUNT-REFUSED', 'TMP-ARCHIVE-REFUSED', 'PASSWORD-AUTH-REFUSED'],
    async run({ root, fixture, tag, undo, refused }) {
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
      const passwordSession = await root.post(SESSIONS, { auth: { kind: 'password', host: `xq-${tag}.example.net`, port: 22, user: 'root', password: secret() } })
      if (typeof passwordSession.data?.session?.id === 'string') undo('password session', () => cancelSession(root, passwordSession.data.session.id))
      refused('PASSWORD-AUTH-REFUSED', passwordSession, 'VALIDATION')
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
    checks: ['QUEUE-OBSERVED', 'SECOND-DELETE-NOT-FOUND', 'UNFREEZE-NOT-FROZEN'],
    async run({ root, tag, check, refused }) {
      const listed = await root.get('/api/server/mail-queue'), ghost = `${tag.toUpperCase()}F0F0F0F0`
      const observed = listed.status === 200 && Array.isArray(listed.data?.messages) && /^[0-9a-f]{64}$/.test(listed.data?.revision ?? '')
      check('QUEUE-OBSERVED', observed, { ...safeResponse(listed), count: Array.isArray(listed.data?.messages) ? listed.data.messages.length : null })
      if (!observed || (listed.data?.messages ?? []).some(item => item.queueId === ghost)) return missing(check, ['SECOND-DELETE-NOT-FOUND', 'UNFREEZE-NOT-FROZEN'], 'The queue could not be read or already holds the probe identifier.')
      const expectedRevision = listed.data.revision
      refused('SECOND-DELETE-NOT-FOUND', await root.post('/api/server/mail-queue/action', { action: 'delete', queueId: ghost, queue: 'deferred', expectedRevision }), 'NOT_FOUND')
      refused('UNFREEZE-NOT-FROZEN', await root.post('/api/server/mail-queue/action', { action: 'release', queueId: ghost, queue: 'hold', expectedRevision }), 'CONFLICT')
    },
  }),

  tool('mail-monitor', {
    prefix: 'MMON', as: 'root', probe: '/api/server/mail-log/monitor', paths: /^\/api\/server\/mail-log\/monitor(?:\?[A-Za-z0-9=&_.:%-]{1,128})?$/, requests: 6,
    unit: [{ id: 'MMON-UNIT-AGGREGATES', file: 'apps/api/src/mail-log-workspace.test.ts', name: 'root mail log workspace returns monitor aggregates without message rows' }],
    checks: ['AGGREGATES-WITHOUT-MESSAGES', 'SELECTOR-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mail-log/monitor')
      check('AGGREGATES-WITHOUT-MESSAGES', view.status === 200 && view.data?.scope === 'server' && view.data?.state === 'read' && typeof view.data?.summary === 'object' && view.data?.summary !== null && !Object.hasOwn(view.data ?? {}, 'messages'), { ...safeResponse(view), state: view.data?.state ?? null, hasSummary: view.data?.summary != null })
      refused('SELECTOR-REFUSED', await root.get('/api/server/mail-log/monitor?sender=xq%40example.net'), 'VALIDATION')
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
    prefix: 'SMR', as: 'root', needs: ['account'], probe: '/api/server/mailx/relay', paths: /^\/api\/server\/mailx\/relay$/, requests: 6,
    page: { route: '/whm/email/relay', read: '/api/server/mailx/relay', shows: () => [] },
    unit: [{ id: 'SMR-UNIT-RELAY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace saves the relay with CAS, keeps the password out of every view and applies through the agent' }],
    checks: ['POLICY-READ-REDACTED', 'PER-DOMAIN-RELAY-REFUSED', 'PORT-465-REFUSED'],
    async run({ root, fixture, check, refused }) {
      const before = await root.get('/api/server/mailx/relay')
      const policy = before.data?.policy
      const validRead = before.status === 200 && policy && typeof policy === 'object' && typeof policy.passwordSet === 'boolean' && !Object.hasOwn(policy, 'password') && !Object.hasOwn(before.data ?? {}, 'secret') && /^[0-9a-f]{64}$/.test(before.data?.revision ?? '')
      check('POLICY-READ-REDACTED', Boolean(validRead), { ...safeResponse(before), host: before.data?.host ?? null, redacted: Boolean(validRead) })
      if (!validRead) return missing(check, ['PER-DOMAIN-RELAY-REFUSED', 'PORT-465-REFUSED'], 'The saved relay policy could not be read.')
      const { passwordSet: _set, ...base } = policy
      refused('PER-DOMAIN-RELAY-REFUSED', await root.put('/api/server/mailx/relay', { policy: { ...base, domains: [fixture.domain] }, expectedRevision: before.data.revision, password: null }), 'VALIDATION')
      refused('PORT-465-REFUSED', await root.put('/api/server/mailx/relay', { policy: { ...base, port: 465 }, expectedRevision: before.data.revision, password: null }), 'VALIDATION')
    },
  }),

  tool('incoming-mail-domain-filter', {
    prefix: 'IMF', as: 'root', probe: '/api/server/mailx/spam', paths: /^\/api\/server\/mailx\/spam$/, requests: 6,
    page: { route: '/whm/email/spam', read: '/api/server/mailx/spam', shows: data => typeof data?.engine?.engine === 'string' ? [data.engine.engine] : [] },
    unit: [{ id: 'IMF-UNIT-POLICY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace rejects non-root callers, selectors, unknown fields and invalid policies before any write' }],
    checks: ['SPAM-POLICY-READ', 'INVALID-DOMAIN-REFUSED', 'INVERTED-SCORES-REFUSED'],
    async run({ root, check, refused }) {
      const view = await root.get('/api/server/mailx/spam')
      const policy = view.data?.policy
      const ok = view.status === 200 && policy && Array.isArray(policy.blockedDomains) && /^[0-9a-f]{64}$/.test(view.data?.revision ?? '')
      check('SPAM-POLICY-READ', Boolean(ok), { ...safeResponse(view), blockedCount: Array.isArray(policy?.blockedDomains) ? policy.blockedDomains.length : null })
      if (!ok) return missing(check, ['INVALID-DOMAIN-REFUSED', 'INVERTED-SCORES-REFUSED'], 'The spam policy could not be read.')
      refused('INVALID-DOMAIN-REFUSED', await root.put('/api/server/mailx/spam', { policy: { ...policy, blockedDomains: ['not a domain!'] }, expectedRevision: view.data.revision }), 'VALIDATION')
      refused('INVERTED-SCORES-REFUSED', await root.put('/api/server/mailx/spam', { policy: { ...policy, headerScore: 20, rejectScore: 10 }, expectedRevision: view.data.revision }), 'VALIDATION')
    },
  }),

  tool('whm-greylisting', {
    prefix: 'GRL', as: 'root', probe: '/api/server/mailx/spam', paths: /^\/api\/server\/mailx\/(?:spam|greylist)$/, requests: 8,
    page: { route: '/whm/email/spam', read: '/api/server/mailx/spam', shows: data => typeof data?.engine?.engine === 'string' ? [data.engine.engine] : [] },
    unit: [{ id: 'GRL-UNIT-POLICY', file: 'apps/api/src/mailx-workspace.test.ts', name: 'server mail policy workspace rejects non-root callers, selectors, unknown fields and invalid policies before any write' }],
    checks: ['GREYLIST-POLICY-READ', 'UNHOSTED-DOMAIN-REFUSED', 'GREYLIST-SCORE-ORDER-REFUSED'],
    async run({ root, check, refused }) {
      const greylist = await root.get('/api/server/mailx/greylist'), spam = await root.get('/api/server/mailx/spam')
      const ok = greylist.status === 200 && Array.isArray(greylist.data?.policy?.domains) && /^[0-9a-f]{64}$/.test(greylist.data?.revision ?? '')
      check('GREYLIST-POLICY-READ', Boolean(ok), { ...safeResponse(greylist), domains: Array.isArray(greylist.data?.policy?.domains) ? greylist.data.policy.domains.length : null })
      if (!ok) missing(check, ['UNHOSTED-DOMAIN-REFUSED'], 'The greylist policy could not be read.')
      else refused('UNHOSTED-DOMAIN-REFUSED', await root.put('/api/server/mailx/greylist', { policy: { domains: ['unhosted-xq.example.invalid'] }, expectedRevision: greylist.data.revision }), 'VALIDATION')
      const spamOk = spam.status === 200 && spam.data?.policy && /^[0-9a-f]{64}$/.test(spam.data?.revision ?? '')
      if (!spamOk) check('GREYLIST-SCORE-ORDER-REFUSED', false, safeResponse(spam))
      else refused('GREYLIST-SCORE-ORDER-REFUSED', await root.put('/api/server/mailx/spam', { policy: { ...spam.data.policy, headerScore: 6, greylistScore: 6 }, expectedRevision: spam.data.revision }), 'VALIDATION')
    },
  }),
]
