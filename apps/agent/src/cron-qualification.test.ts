import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { createNativeCronQualification } from './cron-qualification.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20010, gid: 20010,
  home: '/home/alice', primaryDomain: 'alice.example.test', planId: '22222222-2222-4222-8222-222222222222',
  ownerId: null, status: 'active', ipv4: '192.0.2.10', shell: 'jailed', php: {},
  contactEmail: 'alice@example.test', createdAt: '2026-01-01T00:00:00.000Z' } as unknown as Account
const job = { id: '33333333-3333-4333-8333-333333333333', schedule: '*/5 * * * *', command: '/usr/bin/id -un', enabled: true }

describe('trusted cron host qualification', { tags: ['unit'] }, () => {
  it('admits an enabled job when systemd timers are active and the schedule translates', async () => {
    const isActive = vi.fn(async () => true)
    await expect(createNativeCronQualification({ isActive })({ account, job, action: 'run' })).resolves.toBeUndefined()
    expect(isActive).toHaveBeenCalledWith('timers.target')
  })

  it('refuses when the host timer target is inactive', async () => {
    const qualify = createNativeCronQualification({ isActive: async () => false })
    await expect(qualify({ account, job, action: 'observe' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'systemd_timers_inactive' } })
  })

  it('refuses an unsupported schedule before any host observation', async () => {
    const isActive = vi.fn(async () => true)
    const qualify = createNativeCronQualification({ isActive })
    await expect(qualify({ account, job: { ...job, schedule: 'every so often' }, action: 'observe' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'schedule_not_supported' } })
    expect(isActive).not.toHaveBeenCalled()
  })

  it('refuses a disabled manual run and an invalid account identity', async () => {
    const qualify = createNativeCronQualification({ isActive: async () => true })
    await expect(qualify({ account, job: { ...job, enabled: false }, action: 'run' }))
      .rejects.toMatchObject({ detail: { reason: 'job_disabled' } })
    await expect(qualify({ account: { ...account, uid: 0 }, job, action: 'observe' }))
      .rejects.toMatchObject({ detail: { reason: 'account_identity_invalid' } })
  })
})
