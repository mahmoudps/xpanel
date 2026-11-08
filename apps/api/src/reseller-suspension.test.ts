import { describe, expect, it, vi } from 'vitest'
import { handleResellerSuspensionRoute } from './reseller-suspension.ts'

const ID = '11111111-1111-4111-8111-111111111111'
const account = (username: string, status: string, ownerId: string | null = ID, suspendReason: string | null = null) => ({ id: username, username, status, ownerId, suspendReason })
const setup = (suspended: boolean, accounts: unknown[], setSuspension = vi.fn(async () => undefined)) => {
  const reseller = { id: ID, username: 'res1', ...(suspended ? { suspended: true } : {}) }
  const ports = {
    requireCaller: vi.fn(async () => ({ principal: { kind: 'root', id: 'root', username: 'root' } })), assertRoot: vi.fn(async () => undefined), emitAudit: vi.fn(async () => undefined),
    store: { listResellers: vi.fn(async () => [reseller]), updateReseller: vi.fn(async (_id: string, patch: object) => ({ ...reseller, ...patch })), listAccounts: vi.fn(async () => accounts) },
    setSuspension, setLoginDisabled: vi.fn(async () => undefined),
  }
  return ports as typeof ports & Record<string, never>
}
const call = (verb: string, ports: object, body?: unknown) => {
  const url = `http://x/api/resellers/${ID}/${verb}`
  return handleResellerSuspensionRoute(new Request(url, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(url), 'POST', ports as never)
}

describe('reseller suspension', () => {
  it('blocks the sign-in and suspends only the active accounts the reseller owns', async () => {
    const ports = setup(false, [account('a', 'active'), account('b', 'suspended'), account('c', 'active', null)])
    const body = await (await call('suspend', ports, { reason: 'unpaid' }))!.json() as { changed: string[] }
    expect(body.changed).toEqual(['a'])
    expect(ports.setLoginDisabled).toHaveBeenCalledWith(ID, true)
    expect(ports.store.updateReseller).toHaveBeenCalledWith(ID, { suspended: true })
    expect(ports.setSuspension).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ username: 'a' }), 'suspend', 'Reseller res1 is suspended: unpaid')
  })
  it('lifts only the suspensions this action made', async () => {
    const ports = setup(true, [account('a', 'suspended', ID, 'Reseller res1 is suspended: unpaid'), account('b', 'suspended', ID, 'abuse')])
    const body = await (await call('unsuspend', ports))!.json() as { changed: string[] }
    expect(body.changed).toEqual(['a'])
    expect(ports.setLoginDisabled).toHaveBeenCalledWith(ID, false)
  })
  it('reports an account that failed and keeps going', async () => {
    const setSuspension = vi.fn(async (_caller: unknown, target: { username: string }) => { if (target.username === 'a') throw new Error('host') })
    const ports = setup(false, [account('a', 'active'), account('b', 'active')], setSuspension as never)
    const body = await (await call('suspend', ports))!.json() as { changed: string[]; failed: string[] }
    expect(body).toMatchObject({ changed: ['b'], failed: ['a'] })
    expect(ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
  })
  it('refuses a repeat, an unknown reseller, a body on unsuspend and other methods', async () => {
    await expect(call('suspend', setup(true, []))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('unsuspend', setup(false, []))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call('unsuspend', setup(true, []), { reason: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const missing = setup(false, []); missing.store.listResellers = vi.fn(async () => [])
    await expect(call('suspend', missing)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const url = `http://x/api/resellers/${ID}/suspend`
    expect((await handleResellerSuspensionRoute(new Request(url), new URL(url), 'GET', setup(false, []) as never))!.status).toBe(405)
    expect(await handleResellerSuspensionRoute(new Request('http://x/api/resellers'), new URL('http://x/api/resellers'), 'POST', setup(false, []) as never)).toBeNull()
  })
})
