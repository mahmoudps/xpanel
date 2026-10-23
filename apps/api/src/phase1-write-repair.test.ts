import { chmod, mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { classifyCliInvocation } from './cli-privilege.ts'
import { createApiApp } from './server.ts'
import { assertStateWritable } from './state-access.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

describe('phase-1 write repair', () => {
  it('re-executes root state commands as the xpanel user and keeps ownership repair on root', () => {
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'reindex', serviceUid: 50 })).toBe('drop-to-xpanel')
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'init-root', serviceUid: 50 })).toBe('drop-to-xpanel')
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'status', serviceUid: 50 })).toBe('drop-to-xpanel')
    expect(classifyCliInvocation({ platform: 'linux', uid: 50, command: 'reset-password', serviceUid: 50 })).toBe('run')
    expect(classifyCliInvocation({ platform: 'linux', uid: 1000, command: 'reindex', serviceUid: 50 })).toBe('refuse')
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'repair-state-ownership', serviceUid: 50 })).toBe('repair-as-root')
    expect(classifyCliInvocation({ platform: 'linux', uid: 50, command: 'repair-state-ownership', serviceUid: 50 })).toBe('refuse')
    expect(classifyCliInvocation({ platform: 'linux', uid: 0, command: 'help', serviceUid: 50 })).toBe('help')
    expect(classifyCliInvocation({ platform: 'darwin', uid: 0, command: 'status', serviceUid: null })).toBe('run')
  })

  it.skipIf(process.platform === 'win32')('fails startup with a clear error when an existing state directory is not writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xpanel-state-access-'))
    const plans = join(root, 'plans')
    await mkdir(plans, { recursive: true })
    await chmod(plans, 0o550)
    await expect(assertStateWritable(root)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      detail: { reason: 'state_not_writable', path: plans },
    })
    await chmod(plans, 0o750)
  })

  it('logs unexpected 500s with method and path and tells the client nothing was saved', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    const secret = 'SENSITIVE_SQL_CONNECTION_STRING_SECRET_12345'
    const errors: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args) })
    try {
      const app = createApiApp({
        serverSecret: TEST_SERVER_SECRET,
        db: database.db,
        store: state.store,
        webRenderer: () => { throw new Error(secret) },
      })
      const response = await app.fetch(new Request('http://panel.local/whm/accounts', { method: 'GET' }))
      expect(response.status).toBe(500)
      const body = await response.json() as { code: string; detail: string; details: { stateChanged: boolean } }
      expect(body).toMatchObject({ code: 'INTERNAL_ERROR', detail: 'Internal server error', details: { stateChanged: false } })
      expect(JSON.stringify(body)).not.toContain(secret)
      expect(errors.some(line => String(line[0]).includes('GET /whm/accounts') && String(line[0]).includes(secret))).toBe(true)
    } finally {
      spy.mockRestore()
      await state.close()
      await database.close()
    }
  })
})
