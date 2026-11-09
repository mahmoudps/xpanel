import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { Db, DurableJobRecord } from '@xpanel/db'

const job = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@xpanel/db', async original => ({ ...await original<typeof import('@xpanel/db')>(), getDurableJob: vi.fn(async () => job.value) }))
const { handleAccountCreateOperationRoute } = await import('./account-create-operations.ts')

const id = '0b6f3f9e-6a0f-4c49-9d4f-2f7a5b8f2c11'
const account = { id: '5f2cbb66-8726-4bba-9f73-46d89ac6ffe5', username: 'newowner7' } as Account
const running = { id, kind: 'account.provision', actor: 'root', status: 'running', needsAttention: false, referenceCode: 'XP-JOB-2026-000001',
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), checkpointData: { accountId: account.id } } as unknown as DurableJobRecord

describe('account creation operation read', () => {
  it('keeps answering the recorded status when a decorating state read fails', async () => {
    job.value = running
    const response = await handleAccountCreateOperationRoute(new Request(`http://panel.test/api/accounts/operations/${id}`),
      new URL(`http://panel.test/api/accounts/operations/${id}`), 'GET', {
        requireCaller: async () => ({ principal: { kind: 'root', username: 'root' } }) as never,
        db: {} as Db,
        getAccount: async () => account,
        primaryDomain: async () => { throw new Error('state read failed') },
        local: () => null,
      })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ operation: { id, status: 'running', needsAttention: false }, account: { id: account.id }, primaryDomain: null })
  })
})
