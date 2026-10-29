import { fail, isXpanelError } from '@xpanel/core'
import { BACKUP_RUN_LIMITS, parseBackupArchiveName, readBackupRunsView } from '../../agent/src/acct-backup-plan.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { BackupDestinationsWorkspacePorts } from './backup-destinations-workspace.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const ROUTE = /^\/api\/backups\/workspace\/(?:runs|destinations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(retention|recover))$/
const REFUSALS = new Set(['VALIDATION', 'CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED', 'FORBIDDEN', 'LIMIT_EXCEEDED'])
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: unknown, keys: readonly string[]): raw is Record<string, unknown> => object(raw) && Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const unreadable = (): never => fail('SERVICE_UNAVAILABLE', 'the host backup reply could not be verified', { stateChanged: false })
const readBody = async (req: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text) > 1024) return invalid('the backup request is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('invalid backup request JSON') }
  return exact(body, keys) ? body : invalid('the backup request takes only ' + keys.join(', '))
}
const hex = (raw: unknown, name: string): string => typeof raw === 'string' && HEX.test(raw) ? raw : invalid(name + ' must be a saved revision')

/** Agent reply for GET /host/backups/destinations/<id>/retention. */
export function readBackupRetentionPreview(raw: unknown, destinationId: string) {
  if (!exact(raw, ['destinationId', 'retentionDays', 'retentionCount', 'planDigest', 'rows']) || raw.destinationId !== destinationId || typeof raw.planDigest !== 'string' || !HEX.test(raw.planDigest)
    || ![raw.retentionDays, raw.retentionCount].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 3650) || !Array.isArray(raw.rows) || raw.rows.length > BACKUP_RUN_LIMITS.listed) return unreadable()
  const rows = raw.rows.map(row => {
    const parsed = exact(row, ['name', 'username', 'createdAt', 'bytes', 'action', 'reason']) ? parseBackupArchiveName(row.name) : null
    if (!parsed || parsed.username !== row.username || parsed.createdAt !== row.createdAt || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || !['newest', 'protected', 'within_count', 'within_days', 'expired'].includes(row.reason as string) || row.action !== (row.reason === 'expired' ? 'delete' : 'keep')) return unreadable()
    return { name: row.name as string, username: parsed.username, createdAt: parsed.createdAt, bytes: row.bytes as number, action: row.action as 'keep' | 'delete', reason: row.reason as string }
  })
  return { destinationId, retentionDays: raw.retentionDays as number, retentionCount: raw.retentionCount as number, planDigest: raw.planDigest, rows }
}

/**
 * Root-only run history, run now, retention preview/apply and remote archive recovery. The agent re-checks root authority,
 * destination verification and its own run-history revision; this layer adds the saved configuration revision and audit.
 */
export function createBackupRunsWorkspaceRoutes(ports: BackupDestinationsWorkspacePorts) {
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    const match = ROUTE.exec(url.pathname)
    if (!match) return null
    const [, destinationId, kind = 'runs'] = match
    const initial = await ports.requireCaller(req)
    await ports.assertRoot(initial, 'backups.runs')
    if (url.search) return invalid('backup runs accept no selectors')
    const allow = kind === 'recover' ? 'POST' : 'GET, POST'
    if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
    const host = ports.destinationHost
    if (!host) return fail('PRECONDITION_FAILED', 'scheduled backup execution is unavailable on this host', { stateChanged: false, nativeApplied: false })
    const read = async (path: string): Promise<unknown> => { try { return await host(initial, path) } catch (error) { if (isXpanelError(error) && REFUSALS.has(error.code)) throw error; return unreadable() } }
    if (method === 'GET') {
      if (kind === 'runs') { try { return json(readBackupRunsView(await read('/host/backups/runs'))) } catch (error) { if (isXpanelError(error)) throw error; return unreadable() } }
      return json(readBackupRetentionPreview(await read('/host/backups/destinations/' + destinationId + '/retention'), destinationId!))
    }
    const keys = kind === 'runs' ? ['expectedRevision', 'expectedRunsRevision'] : kind === 'retention' ? ['expectedRevision', 'expectedPlanDigest'] : ['expectedRevision', 'expectedRunsRevision', 'runId', 'username', 'file']
    const body = await readBody(req, keys), expectedRevision = hex(body.expectedRevision, 'expectedRevision')
    let agentBody: Record<string, unknown>
    if (kind === 'retention') agentBody = { expectedPlanDigest: hex(body.expectedPlanDigest, 'expectedPlanDigest') }
    else {
      agentBody = { expectedRevision: hex(body.expectedRunsRevision, 'expectedRunsRevision') }
      if (kind === 'recover') {
        if (typeof body.runId !== 'string' || !UUID.test(body.runId) || typeof body.username !== 'string' || typeof body.file !== 'string' || parseBackupArchiveName(body.username + '/' + body.file)?.file !== body.file) return invalid('a recorded run, account and archive are required')
        agentBody = { ...agentBody, runId: body.runId, username: body.username, file: body.file }
      }
    }
    if ((await ports.load()).revision !== expectedRevision) return fail('CONFLICT', 'backup configuration changed; reload and review', { stateChanged: false })
    const fresh: AuthenticatedCaller = await ports.requireCaller(req)
    await ports.assertRoot(fresh, 'backups.runs')
    if (fresh.principal.id !== initial.principal.id || fresh.sessionId !== initial.sessionId || fresh.apiTokenId !== initial.apiTokenId) return fail('FORBIDDEN', 'backup authority changed', { stateChanged: false })
    const path = kind === 'runs' ? '/host/backups/runs' : '/host/backups/destinations/' + destinationId + '/' + kind
    let raw: unknown
    try { raw = await host(fresh, path, agentBody) } catch (error) {
      if (isXpanelError(error) && REFUSALS.has(error.code)) throw error
      return fail('SERVICE_UNAVAILABLE', 'the backup request outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
    let result: Record<string, unknown>, outcome: 'ok' | 'failed' = 'ok'
    if (kind === 'retention') {
      if (!exact(raw, ['destinationId', 'deleted', 'outcome']) || raw.destinationId !== destinationId || !Array.isArray(raw.deleted) || raw.deleted.length > BACKUP_RUN_LIMITS.listed || raw.deleted.some(name => !parseBackupArchiveName(name)) || !['verified', 'failed', 'unknown'].includes(raw.outcome as string))
        return fail('SERVICE_UNAVAILABLE', 'the retention outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      result = { destinationId, deleted: raw.deleted, outcome: raw.outcome, verificationRequired: raw.outcome !== 'verified' }
      if (raw.outcome !== 'verified') outcome = 'failed'
    } else {
      const id = kind === 'runs' ? 'runId' : 'recoveryId'
      if (!exact(raw, [id, 'state']) || typeof raw[id] !== 'string' || !UUID.test(raw[id] as string) || raw.state !== 'running') return fail('SERVICE_UNAVAILABLE', 'the backup request outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      result = { [id]: raw[id], state: 'running' }
    }
    const action = kind === 'runs' ? 'backup.run.requested' : kind === 'retention' ? 'backup.retention.applied' : 'backup.archive.recovery.requested'
    const target = kind === 'runs' ? 'backup:schedule' : 'backup-destination:' + destinationId
    try { await ports.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action, target, outcome, ...(kind === 'recover' ? { detail: { username: agentBody.username, file: agentBody.file } } : {}) }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the backup request was sent but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(result, kind === 'retention' ? 200 : 202)
  }
}
