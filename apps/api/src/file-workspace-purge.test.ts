import { describe, expect, it } from 'vitest'
import { validateFileWorkspaceReply, validateFileWorkspaceRequest } from './file-workspace-validation.ts'
import { executeFileWorkspaceRequest } from './file-workspace-proxy.ts'

const id = '11111111-1111-4111-8111-111111111111'
const deletedAt = '2026-10-25T00:00:00.000Z'
const item = { id, originalPath: 'docs/a.txt', name: 'a.txt', sizeBytes: 3, deletedAt }
const wire = { op: 'purge-trash', trashId: id, originalPath: item.originalPath, deletedAt }
const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('purge-trash file workspace grammar', () => {
  it('admits exactly one reviewed trash revision', () => {
    expect(validateFileWorkspaceRequest(wire)).toEqual(wire)
  })

  it.each([
    { ...wire, trashId: 'x' }, { ...wire, originalPath: '.trash/a.txt' }, { ...wire, originalPath: '/etc/passwd' }, { ...wire, originalPath: 'a/../b' },
    { ...wire, deletedAt: '2026-02-31T00:00:00Z' }, { ...wire, deletedAt: 1 }, { op: 'purge-trash', trashId: id, originalPath: item.originalPath },
    { op: 'purge-trash', trashId: id, deletedAt }, { ...wire, overwrite: true }, { ...wire, path: 'docs/a.txt' },
  ])('rejects %j before any agent call', value => {
    expect(() => validateFileWorkspaceRequest(value)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
  })

  it('accepts only the acknowledgement of the same item and revision', () => {
    const request = validateFileWorkspaceRequest(wire)
    expect(validateFileWorkspaceReply(request, item)).toEqual(item)
    for (const bad of [{ ...item, id: '22222222-2222-4222-8222-222222222222' }, { ...item, deletedAt: '2026-10-26T00:00:00.000Z' },
      { ...item, originalPath: 'docs/b.txt', name: 'b.txt' }, { ...item, extra: 1 }, { removed: 1 }]) {
      expect(() => validateFileWorkspaceReply(request, bad)).toThrowError(expect.objectContaining({ code: 'CONFIG_TEST_FAILED' }))
    }
  })

  it('reports definite unchanged refusals and keeps other failures verification-required', async () => {
    const request = validateFileWorkspaceRequest(wire)
    for (const status of [404, 409]) {
      const refused = await executeFileWorkspaceRequest(request, reply({ code: 'CONFLICT', details: { stateChanged: false } }, status))
      expect(refused.status).toBe(status)
      expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    }
    await expect(executeFileWorkspaceRequest(request, reply({ code: 'FORBIDDEN' }, 403))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true, unknownOutcome: true } })
    await expect(executeFileWorkspaceRequest(request, reply({ ...item, deletedAt: '2026-10-26T00:00:00.000Z' }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { verificationRequired: true } })
    expect(await (await executeFileWorkspaceRequest(request, reply(item))).json()).toEqual(item)
  })
})
