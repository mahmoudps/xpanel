import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import { hashPasswordArgon2id } from './auth.ts'
import { deliverProcessKillerReports } from './svc-killer-report.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
const run = (over: Record<string, unknown>) => ({ at: '2026-11-07T02:00:00.000Z', trigger: 'nightly', state: 'completed', killed: [{ pid: 5, user: 'alice', comm: 'eggdrop', outcome: 'confirmed' }], trustedSkipped: 0, mailed: false, ...over })

async function fixture(runs: unknown[], recipients: string[]) {
  const database = await createTestDb()
  cleanup.push(() => database.close())
  await createRootPrincipal(database.db, { username: 'root', passwordHash: await hashPasswordArgon2id('fixture-password'), forcePasswordChange: false })
  const paths: string[] = [], email = vi.fn(async () => undefined)
  const agentApp = { fetch: async (request: Request) => { paths.push(new URL(request.url).pathname + ' ' + (request.method === 'POST' ? await request.text() : '')); return Response.json({ runs }) } } as never
  await deliverProcessKillerReports({ db: database.db, agentApp, agentToken: 'a'.repeat(64), readChannels: async () => ({ alerts: true, recipients, webhook: null }), email })
  return { paths, email }
}

describe('process killer report delivery', { tags: ['feature'] }, () => {
  it('mails a nightly run that stopped something, once, and marks it', async () => {
    const { email, paths } = await fixture([run({})], ['root@example.test'])
    expect(email).toHaveBeenCalledOnce()
    expect(paths.at(-1)).toContain('/host/svc/process-killer/reports/mailed {"at":"2026-11-07T02:00:00.000Z"}')
  })
  it('sends nothing for manual, quiet or already mailed runs', async () => {
    const { email } = await fixture([run({ trigger: 'manual' }), run({ killed: [] }), run({ mailed: true })], ['root@example.test'])
    expect(email).not.toHaveBeenCalled()
  })
  it('keeps the report on the page when nobody is listed to receive it', async () => {
    const { email, paths } = await fixture([run({})], [])
    expect(email).not.toHaveBeenCalled()
    expect(paths).toEqual([])
  })
})
