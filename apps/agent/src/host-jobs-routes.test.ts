import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { HostJobCommandResult, HostJobPlan } from './host-job-contract.ts'
import { HostJobRunner } from './host-jobs.ts'
import { handleHostJobsRoute } from './host-jobs-routes.ts'

let handle: TestDbHandle | undefined, dir: string | undefined, runner: HostJobRunner | undefined
afterEach(async () => {
  runner?.close(); await handle?.close()
  if (dir) await rm(dir, { recursive: true, force: true })
  handle = undefined; dir = undefined; runner = undefined
})

const plan = (revision = 'r1'): HostJobPlan => ({
  kind: 'system.packages.upgrade', summary: 'Upgrade packages', accountId: null, fingerprint: { revision }, detail: {},
  steps: [
    { id: 'first', title: 'First', argv: ['/usr/bin/true'], timeoutMs: 1000, mutates: false },
    { id: 'second', title: 'Second', argv: ['/usr/bin/true'], timeoutMs: 1000, mutates: true },
  ],
  policy: argv => argv[0] === '/usr/bin/true',
})

const fresh = async (run: () => Promise<HostJobCommandResult> = async () => ({ ok: true, code: 0, stdout: 'done\n', stderr: '', timedOut: false })) => {
  handle = await createTestDb()
  dir = await mkdtemp(join(tmpdir(), 'xpanel-host-jobs-routes-'))
  runner = new HostJobRunner({ db: handle.db, run, logDir: dir })
  return runner
}

const call = (path: string, method = 'GET', ctx: Parameters<typeof handleHostJobsRoute>[3], body?: string) => {
  const url = new URL('http://agent.local' + path)
  return handleHostJobsRoute(new Request(url, { method, ...(body === undefined ? {} : { body }) }), url, method, ctx)
}

describe('agent host job routes', () => {
  it('ignores unrelated paths and refuses wrong methods without authorization work', async () => {
    const assertRoot = vi.fn(async () => ({ actor: 'root' }))
    expect(await call('/host/jobsx', 'GET', { assertRoot, runner: null })).toBeNull()
    expect(await call('/host/php/inventory', 'GET', { assertRoot, runner: null })).toBeNull()
    const post = await call('/host/jobs', 'POST', { assertRoot, runner: null })
    expect(post!.status).toBe(405); expect(post!.headers.get('allow')).toBe('GET')
    const get = await call('/host/jobs/00000000-0000-4000-8000-000000000000/cancel', 'GET', { assertRoot, runner: null })
    expect(get!.status).toBe(405); expect(get!.headers.get('allow')).toBe('POST')
    expect(assertRoot).not.toHaveBeenCalled()
  })

  it('requires root before reading anything', async () => {
    const jobs = await fresh()
    const list = vi.spyOn(jobs, 'list')
    await expect(call('/host/jobs', 'GET', { assertRoot: async () => { throw new Error('root required') }, runner: jobs })).rejects.toThrow('root required')
    expect(list).not.toHaveBeenCalled()
  })

  it.each([
    '/host/jobs?unknown=1', '/host/jobs?status=queued&status=running', '/host/jobs?status=done', '/host/jobs?kindPrefix=Bad',
    '/host/jobs?limit=101', '/host/jobs?limit=0', '/host/jobs?limit=01', '/host/jobs/NOT-A-UUID',
    '/host/jobs/00000000-0000-4000-8000-00000000000A', '/host/jobs/00000000-0000-4000-8000-000000000000?x=1',
    '/host/jobs/00000000-0000-4000-8000-000000000000/log?offset=-1', '/host/jobs/00000000-0000-4000-8000-000000000000/log?limit=262145',
    '/host/jobs/00000000-0000-4000-8000-000000000000/log?path=/etc/shadow',
  ])('refuses selector grammar %s', async path => {
    await expect(call(path, 'GET', { assertRoot: async () => ({ actor: 'root' }), runner: await fresh() })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('reports an unavailable runner truthfully', async () => {
    await expect(call('/host/jobs', 'GET', { assertRoot: async () => ({ actor: 'root' }), runner: null })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })

  it('lists, reads, pages the log and cancels with no-store responses', async () => {
    let release!: (value: HostJobCommandResult) => void
    const gate = new Promise<HostJobCommandResult>(resolve => { release = resolve })
    const jobs = await fresh(() => gate)
    const { job } = await jobs.submit(plan(), 'root')
    const { job: queued } = await jobs.submit(plan('r2'), 'root')
    const ctx = { assertRoot: async () => ({ actor: 'root' }), runner: jobs }
    const listed = (await call('/host/jobs?status=queued&kindPrefix=system.packages&limit=10', 'GET', ctx))!
    expect(listed.headers.get('cache-control')).toBe('no-store')
    expect(((await listed.json()) as { jobs: { id: string }[] }).jobs.map(item => item.id)).toContain(queued.id)
    const read = (await call(`/host/jobs/${job.id}`, 'GET', ctx))!
    expect(((await read.json()) as { job: { id: string } }).job.id).toBe(job.id)
    const log = (await call(`/host/jobs/${job.id}/log?offset=0&limit=10`, 'GET', ctx))!
    expect(await log.json()).toMatchObject({ id: job.id, available: true, offset: 0, nextOffset: 10 })
    await expect(call(`/host/jobs/${job.id}/cancel`, 'POST', ctx, '{"force":true}')).rejects.toMatchObject({ code: 'VALIDATION' })
    const cancelled = (await call(`/host/jobs/${queued.id}/cancel`, 'POST', ctx))!
    expect(await cancelled.json()).toMatchObject({ job: { id: queued.id, status: 'cancelled' } })
    await expect(call('/host/jobs/00000000-0000-4000-8000-000000000000', 'GET', ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    release({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false })
    await jobs.idle()
  })

  it('re-checks root immediately before recording a cancellation', async () => {
    let release!: (value: HostJobCommandResult) => void
    const gate = new Promise<HostJobCommandResult>(resolve => { release = resolve })
    const jobs = await fresh(() => gate)
    await jobs.submit(plan(), 'root')
    const { job: queued } = await jobs.submit(plan('r2'), 'root')
    const actors = ['root', 'someone-else']
    const assertRoot = vi.fn(async (action: string) => { expect(action).toBe('host.jobs.cancel'); return { actor: actors.shift()! } })
    await expect(call(`/host/jobs/${queued.id}/cancel`, 'POST', { assertRoot, runner: jobs })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(assertRoot).toHaveBeenCalledTimes(2)
    expect((await jobs.get(queued.id))!.status).toBe('queued')
    await expect(call(`/host/jobs/${queued.id}/cancel`, 'POST', { assertRoot: async () => { throw new Error('denied') }, runner: jobs })).rejects.toThrow('denied')
    release({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false })
    await jobs.idle()
  })
})
