import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { handleComposerJobRoute } from './composer-job.ts'
import type { ComposerJobServices } from './composer-job.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import type { HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'
import { validateHostJobPlan } from './host-jobs.ts'

const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', domainId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const account = { id: accountId, username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', status: 'active', planId: 'plan' } as Account
const domain = { id: domainId, accountId, name: 'example.test', siteType: 'php', docRoot: '/home/alpha/public_html', suspended: false, php: { version: '8.3' } } as Domain
const plan = { id: 'plan', resources: { memoryMb: 128, cpuPercent: 25, maxProcesses: 12, diskMb: 100 } } as Plan
const manifest = JSON.stringify({ require: { 'acme/lib': '^1.0' } })

const fixture = (documents: Record<string, string> = { 'composer.json': manifest }) => {
  let submitted: HostJobPlan | null = null
  const entries = [{ name: 'vendor', kind: 'directory' }]
  const files = { list: vi.fn(async () => entries), readText: vi.fn(async (path: string) => { const text = documents[path.split('/').at(-1)!]; if (text === undefined) throw new Error('missing'); return { content: text } }) }
  const ctx = { assertRoot: vi.fn(async () => ({ actor: 'root' })), files: () => files, run: null,
    store: { listAccounts: async () => [account], listDomains: async () => [domain], getPlan: async () => plan, withAccountLifecycleLease: async <T>(_id: string, operation: (value: Account) => Promise<T>) => operation(account) } } as unknown as ComposerWorkspaceContext
  const services: ComposerJobServices = { family: 'debian', phpVersions: async () => ['8.2', '8.3'], audit: vi.fn(async () => {}),
    submitJob: vi.fn(async value => { validateHostJobPlan(value); submitted = value; return { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind: value.kind, accountId } as HostJobView }) }
  return { ctx, services, files, documents, submitted: () => submitted }
}
const request = (f: ReturnType<typeof fixture>, name: string, body: unknown, method = 'POST') => {
  const url = new URL('http://agent/host/composer/jobs/' + name)
  return handleComposerJobRoute(new Request(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, method, f.ctx, f.services)
}
const base = { action: 'install', domainId, phpVersion: null, mirror: null }
const preview = async (f: ReturnType<typeof fixture>, input: Record<string, unknown> = base) => {
  const response = await request(f, 'preview', input); assert.ok(response)
  return ((await response.json()) as { review: Record<string, string> }).review
}
const queued = async (f: ReturnType<typeof fixture>, input: Record<string, unknown> = base): Promise<HostJobPlan> => {
  const review = await preview(f, input), response = await request(f, 'apply', { ...input, expectedRevision: review.expectedRevision, reviewFingerprint: review.reviewFingerprint })
  expect(response!.status).toBe(202); const job = f.submitted(); assert.ok(job); return job
}

describe('Composer job as the account', () => {
  it('refuses a folder without composer.json with 422 COMPOSER_JSON_MISSING', async () => {
    await expect(request(fixture({}), 'preview', base)).rejects.toMatchObject({ code: 'VALIDATION', message: 'COMPOSER_JSON_MISSING', detail: { reason: 'COMPOSER_JSON_MISSING', stateChanged: false } })
  })
  it('keeps a host without a job runner truthful', async () => {
    const f = fixture(); f.services.submitJob = null
    await expect(request(f, 'preview', base)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it.each(['path', 'url', 'env', 'scripts'])('refuses a caller-selected %s', async key => {
    await expect(request(fixture(), 'preview', { ...base, [key]: '/root/private' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('only serves POST', async () => { expect((await request(fixture(), 'preview', {}, 'GET'))!.status).toBe(405) })
  it('reviews the locked graph and binds the choice into the fingerprint', async () => {
    const lock = JSON.stringify({ packages: [{ name: 'acme/lib', version: '1.2.0' }], 'packages-dev': [] })
    const f = fixture({ 'composer.json': manifest, 'composer.lock': lock }), review = await preview(f)
    expect(review).toMatchObject({ account: 'alpha', domain: 'example.test', phpVersion: '8.3' })
    expect(review.packages).toEqual([{ name: 'acme/lib', version: '1.2.0', development: false }])
    expect((await preview(f, { ...base, phpVersion: '8.2' })).reviewFingerprint).not.toBe(review.reviewFingerprint)
    await expect(preview(f, { ...base, phpVersion: '8.4' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'php_not_installed' } })
    await expect(preview(f, { ...base, mirror: 'http://not-https.test' })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('runs Composer as the numeric account in its document root, never as root', async () => {
    const job = await queued(fixture(), { ...base, mirror: 'https://mirror.example.test/repo' })
    expect(job.steps.map(step => step.id)).toEqual(['composer-mirror', 'composer-run'])
    for (const step of job.steps) {
      expect(job.policy(step.argv)).toBe(true); expect(job.policy([...step.argv, '--root'])).toBe(false)
      expect(step.argv).toContain('User=20001'); expect(step.argv).toContain('Group=20001')
      expect(step.argv.some(value => value.includes('/home/alpha/public_html'))).toBe(true)
    }
    expect(job.steps[0]!.argv.slice(-3)).toEqual(['repos.packagist', 'composer', 'https://mirror.example.test/repo'])
    expect(job.steps[1]!.argv).toContain('--no-scripts')
  })
  it('counts a run only when vendor and the lock file exist afterwards', async () => {
    const f = fixture(), job = await queued(f), run = {} as HostJobRun
    expect(await job.verify!(run)).toMatchObject({ ok: false, detail: { lock: false, verificationRequired: true } })
    f.documents['composer.lock'] = JSON.stringify({ packages: [] })
    expect(await job.verify!(run)).toMatchObject({ ok: true, detail: { vendor: true, lock: true } })
    f.files.list.mockResolvedValueOnce([])
    expect((await job.verify!(run)).ok).toBe(false)
  })
  it('refuses an apply against a project that changed after review', async () => {
    const f = fixture(), review = await preview(f)
    f.documents['composer.json'] = JSON.stringify({ require: {} })
    await expect(request(f, 'apply', { ...base, expectedRevision: review.expectedRevision, reviewFingerprint: review.reviewFingerprint })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.services.submitJob).not.toHaveBeenCalled()
  })
})
