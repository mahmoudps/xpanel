import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import { credentialFingerprint, handleTransferCredentialsRoute, parseCredentialLabel, parseSourceApiToken, readTransferCredentialToken } from './acct-transfer-credentials.ts'
import type { AuthenticatedCaller } from './auth.ts'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const task of cleanup.splice(0)) await task() })
const TOKEN = 'xp_' + 'A'.repeat(43)
const fixture = async () => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const audits: Record<string, unknown>[] = []
  let kind = 'root', principalId = 'p1', switchTo: string | null = null
  const helpers = {
    store: state.store,
    requireCaller: async () => {
      const caller = { principal: { kind, id: principalId, username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
      if (switchTo) { principalId = switchTo; switchTo = null }
      return caller
    },
    assertRoot: async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async (input: Record<string, unknown>) => { audits.push(input) },
  }
  const call = (method: string, path = '/api/transfers/credentials', body?: unknown) => {
    const url = new URL('http://x' + path)
    return handleTransferCredentialsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers as never)
  }
  const read = async () => (await (await call('GET'))!.json()) as { revision: string; credentials: { id: string; label: string; fingerprint: string }[] }
  return { state, audits, call, read, setKind: (value: string) => { kind = value }, switchAfterNext: (value: string) => { switchTo = value } }
}

describe('transfer source credentials', () => {
  it('validates labels and xPanel API token grammar', () => {
    expect(parseCredentialLabel('  Old server  ')).toBe('Old server')
    for (const label of ['', 'a'.repeat(81), 'x<b>', 'line\nbreak']) expect(() => parseCredentialLabel(label)).toThrow()
    expect(parseSourceApiToken(TOKEN)).toBe(TOKEN)
    for (const token of ['xp_short', 'yp_' + 'A'.repeat(43), TOKEN + 'A', 42]) expect(() => parseSourceApiToken(token)).toThrow()
    expect(credentialFingerprint(TOKEN)).toMatch(/^[0-9a-f]{16}$/)
  })
  it('stores a token write-once at mode 0600 and never returns it', async () => {
    const f = await fixture()
    const first = await f.read()
    expect(first.credentials).toEqual([])
    const response = (await f.call('POST', undefined, { label: 'Old server', token: TOKEN, expectedRevision: first.revision }))!
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(TOKEN)
    const listed = await f.read()
    expect(JSON.stringify(listed)).not.toContain(TOKEN)
    expect(listed.credentials[0]).toMatchObject({ label: 'Old server', kind: 'api-token', fingerprint: credentialFingerprint(TOKEN) })
    expect(await readTransferCredentialToken(f.state.store, listed.credentials[0]!.id)).toBe(TOKEN)
    const file = join(f.state.rootDir, 'extended', 'transfers', 'credentials.json')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).toContain(TOKEN)
    expect(f.audits.map(item => item.action)).toEqual(['transfer.credential.created'])
    expect(JSON.stringify(f.audits)).not.toContain(TOKEN)
  })
  it('rejects stale revisions, duplicates, unknown keys and non-root callers', async () => {
    const f = await fixture()
    const first = await f.read()
    await f.call('POST', undefined, { label: 'A', token: TOKEN, expectedRevision: first.revision })
    await expect(f.call('POST', undefined, { label: 'B', token: 'xp_' + 'B'.repeat(43), expectedRevision: first.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const second = await f.read()
    await expect(f.call('POST', undefined, { label: 'a', token: 'xp_' + 'B'.repeat(43), expectedRevision: second.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.call('POST', undefined, { label: 'C', token: TOKEN, expectedRevision: second.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.call('POST', undefined, { label: 'C', token: TOKEN, expectedRevision: second.revision, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.call('GET', '/api/transfers/credentials?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await f.call('PUT'))!.status).toBe(405)
    f.setKind('user')
    await expect(f.call('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('deletes by id with the captured revision and refuses a changed authority', async () => {
    const f = await fixture()
    await f.call('POST', undefined, { label: 'A', token: TOKEN, expectedRevision: (await f.read()).revision })
    const listed = await f.read(), id = listed.credentials[0]!.id
    await expect(f.call('DELETE', '/api/transfers/credentials/' + '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), { expectedRevision: listed.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    f.switchAfterNext('p2')
    await expect(f.call('DELETE', '/api/transfers/credentials/' + id, { expectedRevision: listed.revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await readTransferCredentialToken(f.state.store, id)).toBe(TOKEN)
    f.switchAfterNext('p1')
    await f.read()
    const response = (await f.call('DELETE', '/api/transfers/credentials/' + id, { expectedRevision: listed.revision }))!
    expect(response.status).toBe(200)
    expect((await f.read()).credentials).toEqual([])
    expect(await readTransferCredentialToken(f.state.store, id)).toBeNull()
    expect(f.audits.at(-1)).toMatchObject({ action: 'transfer.credential.deleted', target: 'transfer-credential:' + id })
  })
  it('refuses a corrupt credential file instead of treating it as empty', async () => {
    const f = await fixture()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(f.state.rootDir, 'extended', 'transfers'), { recursive: true })
    await writeFile(join(f.state.rootDir, 'extended', 'transfers', 'credentials.json'), JSON.stringify({ version: 1, credentials: [{ id: 'x' }] }))
    await expect(f.read()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(readTransferCredentialToken(f.state.store, 'x')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
