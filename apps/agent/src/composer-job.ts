import { createHash } from 'node:crypto'
import { effectivePlan, fail, isAccountHome, msgid } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import { COMPOSER_JOB_TIMEOUT_MS, composerAccountCommand, composerMirrorCommand, isComposerJobCommand } from '../../../packages/os/src/composer-job-command.ts'
import type { ComposerJobAction } from '../../../packages/os/src/composer-job-command.ts'
import { parseComposerDocuments } from './composer-workspace.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import type { HostJobPlan, HostJobVerification, HostJobView } from './host-job-contract.ts'
import { system } from '@xpanel/render'

/**
 * Composer runs as the site's account, in its slice and sandbox, like the account's own shell would: root never runs it,
 * project scripts and plugins stay off, and the job log is the live output. Everything a job writes is the account's.
 */
const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MIRROR = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/
const unchanged = { stateChanged: false }
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unavailable = (): never => fail('PRECONDITION_FAILED', 'the host job runner is unavailable; no job was submitted', unchanged)
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export interface ComposerJobServices {
  family: 'debian' | 'rhel' | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  /** Installed PHP versions on this host. */
  phpVersions(): Promise<readonly string[]>
  audit(entry: { actor: string; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown> }): Promise<void>
}
type Context = Pick<ComposerWorkspaceContext, 'assertRoot' | 'store' | 'files'>
export interface ComposerJobGraphPackage { name: string; version: string; development: boolean }
export interface ComposerJobReview {
  state: 'ready'; action: ComposerJobAction; domainId: string; domain: string; account: string; phpVersion: string
  expectedRevision: string; reviewFingerprint: string; graphDigest: string; lockDigest: string; packages: ComposerJobGraphPackage[]
}
export interface ComposerTarget { account: Account; domain: Domain; directory: string; phpVersion: string; mirror: string | null }

const targetError = (): never => fail('PRECONDITION_FAILED', 'the saved Composer site is not an active PHP site', unchanged)
function resolveTarget(account: Account, domain: Domain, phpVersion: string | null, mirror: string | null, family: 'debian' | 'rhel', installed: readonly string[]): ComposerTarget {
  if (account.id !== domain.accountId || account.status !== 'active' || domain.suspended || domain.siteType !== 'php' || !isAccountHome(account.home, account.username) || !domain.docRoot.startsWith(account.home + '/')) return targetError()
  const version = phpVersion ?? domain.php.version
  if (!installed.includes(version)) return fail('PRECONDITION_FAILED', 'this PHP version is not installed', { ...unchanged, reason: 'php_not_installed' })
  composerAccountCommand('install', version, family)
  return { account, domain, directory: domain.docRoot.slice(account.home.length + 1), phpVersion: version, mirror }
}
async function readProject(ctx: Context, target: ComposerTarget): Promise<{ manifest: string; lock: string | null }> {
  const plan = await ctx.store.getPlan(target.account.planId), files = plan ? ctx.files(target.account, effectivePlan(plan, target.account)) : null
  if (!files) return fail('PRECONDITION_FAILED', 'the account files cannot be read', unchanged)
  const read = async (name: string): Promise<string | null> => { try { return (await files.readText(target.directory + '/' + name)).content } catch { return null } }
  const manifest = await read('composer.json')
  if (manifest === null) return fail('VALIDATION', 'COMPOSER_JSON_MISSING', { ...unchanged, reason: 'COMPOSER_JSON_MISSING' })
  return { manifest, lock: await read('composer.lock') }
}
function reviewOf(target: ComposerTarget, action: ComposerJobAction, project: { manifest: string; lock: string | null }): ComposerJobReview {
  let rows
  try { rows = parseComposerDocuments(project.manifest, project.lock, null) } catch { return fail('VALIDATION', 'composer.json is not valid', { ...unchanged, reason: 'composer_json_invalid' }) }
  const expectedRevision = sha(JSON.stringify([project.manifest, project.lock])), lockDigest = sha(project.lock ?? ''), graphDigest = sha(project.lock ?? project.manifest)
  const packages = rows.filter(row => row.locked !== null).map(row => ({ name: row.name, version: row.locked!, development: row.development })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return { state: 'ready', action, domainId: target.domain.id, domain: target.domain.name, account: target.account.username, phpVersion: target.phpVersion, expectedRevision, lockDigest, graphDigest, packages,
    reviewFingerprint: sha(JSON.stringify([target.domain.id, target.directory, action, target.phpVersion, target.mirror, expectedRevision])) }
}

/** The run: an optional mirror write as the account, then Composer itself; vendor must exist afterwards. */
export function buildComposerJobPlan(input: { ctx: Context; target: ComposerTarget; review: ComposerJobReview; family: 'debian' | 'rhel'; assertActor(): Promise<void> }): HostJobPlan {
  const { target, review, family } = input
  const account = target.account, run = composerAccountCommand(review.action, target.phpVersion, family)
  const env = { HOME: account.home, COMPOSER_HOME: account.home + '/.composer', COMPOSER_CACHE_DIR: account.home + '/.composer/cache', COMPOSER_ALLOW_SUPERUSER: '0' }
  const jailed = (tail: string[]): string[] => {
    const skeleton = system.buildJailedFileOpArgv(account, ['/usr/bin/id'], { cwdRel: target.directory, env })
    return [...skeleton.slice(0, skeleton.lastIndexOf('--')).map(value => value === 'User=' + account.username ? 'User=' + account.uid : value === 'Group=' + account.username ? 'Group=' + account.gid : value), '--', ...tail]
  }
  const steps = [
    { id: 'composer-mirror', title: msgid('Set the package mirror'), argv: jailed(composerMirrorCommand(target.phpVersion, family, target.mirror)), timeoutMs: 60_000, mutates: true },
    { id: 'composer-run', title: msgid('Run Composer as the account'), argv: jailed(run), timeoutMs: COMPOSER_JOB_TIMEOUT_MS, mutates: true },
  ]
  const known = new Set(steps.map(step => JSON.stringify(step.argv)))
  return {
    kind: 'composer.dependencies.' + review.action, summary: 'Composer ' + review.action + ': ' + review.domain, accountId: account.id,
    fingerprint: { domainId: target.domain.id, action: review.action, expectedRevision: review.expectedRevision, reviewFingerprint: review.reviewFingerprint },
    detail: { domain: review.domain, account: account.username, action: review.action, phpVersion: target.phpVersion, mirror: target.mirror, scripts: false, plugins: false },
    steps, policy: candidate => isComposerJobCommand(candidate) && known.has(JSON.stringify(candidate)),
    beforeStep: async () => { await input.assertActor() },
    verify: async () => {
      await input.assertActor()
      const after = await readProject(input.ctx, target)
      const plan = await input.ctx.store.getPlan(account.planId), files = plan ? input.ctx.files(account, effectivePlan(plan, account)) : null
      const vendor = files ? await files.list(target.directory, { showHidden: true }).then(rows => rows.some(row => row.name === 'vendor' && row.kind === 'directory'), () => false) : false
      const ok = vendor && after.lock !== null
      return { ok, detail: { vendor, lock: after.lock !== null, verificationRequired: !ok } } satisfies HostJobVerification
    },
  }
}

interface JobBody { action: ComposerJobAction; domainId: string; phpVersion: string | null; mirror: string | null; expectedRevision?: string; reviewFingerprint?: string }
async function body(request: Request, apply: boolean): Promise<JobBody> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'Composer jobs require JSON', unchanged)
  const text = await request.text()
  let value: unknown
  try { value = text.length <= 2048 ? JSON.parse(text) : null } catch { value = null }
  const keys = ['action', 'domainId', 'phpVersion', 'mirror', ...(apply ? ['expectedRevision', 'reviewFingerprint'] : [])]
  if (!object(value) || Object.keys(value).sort().join() !== [...keys].sort().join() || !['install', 'update'].includes(String(value.action)) || typeof value.domainId !== 'string' || !UUID.test(value.domainId)
    || !(value.phpVersion === null || typeof value.phpVersion === 'string' && /^[5-9]\.[0-9]{1,2}$/.test(value.phpVersion)) || !(value.mirror === null || typeof value.mirror === 'string' && MIRROR.test(value.mirror))
    || apply && (typeof value.expectedRevision !== 'string' || !HASH.test(value.expectedRevision) || typeof value.reviewFingerprint !== 'string' || !HASH.test(value.reviewFingerprint))) return fail('VALIDATION', 'choose install or update and a saved site', unchanged)
  return value as unknown as JobBody
}

export async function handleComposerJobRoute(request: Request, url: URL, method: string, ctx: Context, services?: ComposerJobServices | null): Promise<Response | null> {
  const apply = url.pathname === '/host/composer/jobs/apply'
  if (!apply && url.pathname !== '/host/composer/jobs/preview') return null
  const label = 'software.composer.' + (apply ? 'apply' : 'preview'), first = await ctx.assertRoot(label)
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'Composer jobs do not accept query selectors', unchanged)
  const input = await body(request, apply)
  if (!services?.family || !services.submitJob) return unavailable()
  const assertActor = async (): Promise<void> => { if ((await ctx.assertRoot(label)).actor !== first.actor) return fail('FORBIDDEN', 'Composer authority changed', unchanged) }
  const domain = (await ctx.store.listDomains()).find(item => item.id === input.domainId), account = domain ? (await ctx.store.listAccounts()).find(item => item.id === domain.accountId) : null
  if (!domain || !account) return fail('NOT_FOUND', 'the selected Composer site is unavailable', unchanged)
  const installed = await services.phpVersions()
  const reviewed = await ctx.store.withAccountLifecycleLease(account.id, async fresh => {
    await assertActor()
    const target = resolveTarget(fresh, domain, input.phpVersion, input.mirror, services.family!, installed)
    return { target, review: reviewOf(target, input.action, await readProject(ctx, target)) }
  })
  await assertActor()
  if (!apply) return json(200, { review: reviewed.review })
  if (input.expectedRevision !== reviewed.review.expectedRevision || input.reviewFingerprint !== reviewed.review.reviewFingerprint) return fail('CONFLICT', 'the Composer project changed; preview again', unchanged)
  const plan = buildComposerJobPlan({ ctx, target: reviewed.target, review: reviewed.review, family: services.family, assertActor })
  await services.audit({ actor: first.actor, action: 'composer.dependencies.requested', target: domain.name, outcome: 'ok', detail: { action: input.action, phpVersion: reviewed.target.phpVersion, reviewFingerprint: reviewed.review.reviewFingerprint } })
  await assertActor()
  let job: HostJobView
  try { job = await services.submitJob(plan, first.actor) }
  catch { return fail('SERVICE_UNAVAILABLE', 'Composer job submission requires review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  if (!UUID.test(job.id) || job.kind !== plan.kind || job.accountId !== account.id) return fail('SERVICE_UNAVAILABLE', 'the submitted Composer job acknowledgement could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(202, { job })
}
