import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleFileSharingRoute } from './ops-file-sharing-routes.ts'
import type { FileSharingRouteContext } from './ops-file-sharing-routes.ts'
import { parseExpectedEtab } from './ops-file-sharing-test-helpers.ts'
import { renderManagedExports, savedShareConfigRevision, shareConfigRevision } from './ops-file-sharing.ts'
import type { FileSharingNativeProvider, ShareConfig } from './ops-file-sharing.ts'

let base = ''
const config: ShareConfig = { shares: [{ id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [{ host: '10.0.0.0/24', permission: 'rw', squashRoot: true, subtreeCheck: true }] }] }
const provider = (): FileSharingNativeProvider & { managed: string | null; etab: string } => {
  const state = { managed: null as string | null, etab: '\n' }
  return Object.assign(state, {
    readManaged: async () => state.managed, readEtab: async () => state.etab,
    writeManaged: async (content: string, beforeCommit: () => Promise<void>) => { await beforeCommit(); state.managed = content },
    removeManaged: async () => { state.managed = null },
    reexport: async () => { state.etab = state.managed ? parseExpectedEtab(state.managed) : '\n'; return true },
  })
}
const context = (overrides: Partial<FileSharingRouteContext> = {}): FileSharingRouteContext => ({
  assertRoot: vi.fn(async () => ({ actor: 'root' })),
  store: { rootDir: base, getWriterLock: () => ({ acquire: async () => ({ assertFencingToken: async () => {}, release: async () => {} }) }) as never },
  provider: provider(),
  ...overrides,
})
const call = (ctx: FileSharingRouteContext, path: string, method = 'GET', body?: unknown) => {
  const url = new URL('http://agent.local' + path)
  return handleFileSharingRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, ctx)
}
const writeSaved = (value: unknown) => writeFile(join(base, 'extended', 'file-sharing', 'shares.json'), JSON.stringify(value))

beforeEach(async () => { base = await mkdtemp(join(tmpdir(), 'xpanel-ops-shares-')); await mkdir(join(base, 'extended', 'file-sharing'), { recursive: true }) })
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

describe('file sharing agent routes', () => {
  it('ignores unrelated paths and re-asserts root around the read', async () => {
    expect(await call(context(), '/host/system-updates/plan')).toBeNull()
    const ctx = context()
    const body = await (await call(ctx, '/host/file-sharing'))!.json() as Record<string, any>
    expect(body.saved).toMatchObject({ revision: shareConfigRevision({ shares: [] }), invalid: false })
    expect(body.observed).toMatchObject({ state: 'read', shares: [] })
    expect((await (await call(context({ provider: null }), '/host/file-sharing'))!.json() as Record<string, any>).observed.reason).toBe('nfs_server_unavailable')
    expect(ctx.assertRoot).toHaveBeenCalledTimes(2)
  })
  it('reads a saved configuration and reports it as invalid without exporting it', async () => {
    await writeSaved(config)
    const ok = await (await call(context(), '/host/file-sharing'))!.json() as Record<string, any>
    expect(ok.saved.config.shares).toHaveLength(1); expect(ok.saved.invalid).toBe(false)
    await writeSaved({ shares: [{ id: 'bad', path: '/etc/passwd', clients: [] }] })
    const invalid = await (await call(context(), '/host/file-sharing'))!.json() as Record<string, any>
    expect(invalid.saved.invalid).toBe(true); expect(invalid.saved.config.shares).toEqual([])
  })
  it('applies the saved configuration with revision and active-revision concurrency', async () => {
    await writeSaved(config)
    const raw = JSON.parse(JSON.stringify(config))
    const ctx = context()
    const response = await call(ctx, '/host/file-sharing/apply', 'POST', { expectedRevision: savedShareConfigRevision(raw), expectedActiveRevision: shareConfigRevision({ shares: [] }) })
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ appliedRevision: shareConfigRevision(config), stateChanged: true })
    expect((ctx.provider as unknown as { managed: string | null }).managed).toBe(renderManagedExports(config))
  })
  it('refuses a stale saved revision, bad bodies and the missing provider', async () => {
    await writeSaved(config)
    await expect(call(context(), '/host/file-sharing/apply', 'POST', { expectedRevision: 'f'.repeat(64), expectedActiveRevision: shareConfigRevision({ shares: [] }) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(context(), '/host/file-sharing/apply', 'POST', { expectedRevision: 'x', expectedActiveRevision: 'y' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(context({ provider: null }), '/host/file-sharing/apply', 'POST', { expectedRevision: savedShareConfigRevision(JSON.parse(JSON.stringify(config))), expectedActiveRevision: shareConfigRevision({ shares: [] }) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(context(), '/host/file-sharing?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
