import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDbProfilesWorkspaceRoute, projectDbProfiles } from './db-profiles-workspace.ts'
import type { DbProfilesWorkspaceHelpers } from './db-profiles-workspace.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const OWNER = { ...ROOT, principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice' } } as unknown as AuthenticatedCaller
const PROFILE = { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', description: '', validation: null, createdAt: '2026-11-07T12:00:00.000Z', updatedAt: '2026-11-07T12:00:00.000Z' }
const LISTING = { active: 'localhost', profiles: [PROFILE] }
const CA = '-----BEGIN CERTIFICATE-----\nMIIBGDCBy6ADAgECAhRKTjFyFLt4k8g89TSRiT/y/YsPxTAFBgMrZXAwGjEYMBYG\nA1UEAwwPZGIuZXhhbXBsZS50ZXN0MCAXDTI2MTEwNzE0MjU1MVoYDzIxMjYxMDE0\nMTQyNTUxWjAaMRgwFgYDVQQDDA9kYi5leGFtcGxlLnRlc3QwKjAFBgMrZXADIQB4\nt9Bi9F5HFj/RsSTVA2fDi0xBMxxQ7YUnoKFMCjm696MhMB8wHQYDVR0OBBYEFEmM\nR8R4+nFkgnjksG+98ZpcFgTDMAUGAytlcANBAIx8e+jttMtfmWL05gPWfNRwRg4s\nAYD7xEXQYM/xyQIAjaEAKIkXlFH3vpRoYDj2itit0HwwbtTs47QyZ/JeyQk=\n-----END CERTIFICATE-----\n'
const BODY = { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', password: 'Secret1!', description: '', ca: CA }
function harness(callHost: DbProfilesWorkspaceHelpers['callHost'] = vi.fn(async () => LISTING), caller = ROOT) {
  const helpers = { requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }), callHost } as unknown as DbProfilesWorkspaceHelpers
  const send = (path: string, method = 'GET', body?: unknown) => handleDbProfilesWorkspaceRoute(new Request('http://api.test/api/server/db-profiles' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test/api/server/db-profiles' + path), method, helpers)
  return { send, helpers }
}

describe('database profiles workspace', () => {
  it('is root only and ignores other paths', async () => {
    await expect(harness(undefined, OWNER).send('')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await handleDbProfilesWorkspaceRoute(new Request('http://api.test/api/server/other'), new URL('http://api.test/api/server/other'), 'GET', harness().helpers)).toBeNull()
  })
  it('projects a listing field by field, so a stray credential never reaches a browser', async () => {
    const text = await (await harness(vi.fn(async () => ({ active: 'localhost', extra: 'x', profiles: [{ ...PROFILE, password: 'leak' }] }))).send(''))!.text()
    expect(text).not.toContain('leak'); expect(text).not.toContain('extra')
    expect(JSON.parse(text)).toMatchObject({ active: 'localhost', localProfile: 'localhost', profiles: [{ name: 'remote1' }] })
    expect(() => projectDbProfiles({ active: 'x', profiles: [{ name: 'BAD' }] })).toThrow()
  })
  it('sends a save to the agent once and refuses a rename', async () => {
    const callHost = vi.fn(async () => LISTING), h = harness(callHost)
    await h.send('', 'POST', BODY)
    expect(callHost).toHaveBeenCalledWith(ROOT, '/host/db-profiles/save', BODY)
    await expect(h.send('/other', 'PUT', BODY)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('', 'POST', { ...BODY, host: 'a\nb' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(callHost).toHaveBeenCalledTimes(1)
  })
  it('passes the verbs through and keeps the stable refusal reasons', async () => {
    const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string): Promise<unknown> => path.endsWith('/activate') ? fail('PRECONDITION_FAILED', 'no', { stateChanged: false, reason: 'PROFILE_INVALID', failure: 'access_denied' }) : path.endsWith('/delete') ? fail('CONFLICT', 'no', { stateChanged: false, reason: 'IN_USE' }) : LISTING)
    const h = harness(callHost)
    await expect(h.send('/remote1/activate', 'POST', {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'PROFILE_INVALID', failure: 'access_denied' } })
    await expect(h.send('/remote1', 'DELETE')).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'IN_USE' } })
    await h.send('/remote1/validate', 'POST', {})
    expect(callHost).toHaveBeenCalledWith(ROOT, '/host/db-profiles/validate', { name: 'remote1' })
    expect((await h.send('/remote1/validate'))!.status).toBe(405)
    await expect(h.send('/Bad%20Name', 'DELETE')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses truthfully without a host agent', async () => {
    const helpers = { requireCaller: async () => ROOT, assertRoot: async () => undefined } as unknown as DbProfilesWorkspaceHelpers
    await expect(handleDbProfilesWorkspaceRoute(new Request('http://api.test/api/server/db-profiles'), new URL('http://api.test/api/server/db-profiles'), 'GET', helpers)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'host_agent_unavailable' } })
  })
})
