import { describe, expect, it, vi } from 'vitest'
import { NativeAccountFileRunner } from './account-file-runner.ts'
import type { AccountFileContext, AccountFileRequest } from './file-manager.ts'
const context: AccountFileContext = { account: { username: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }, homeRoot: '/home/alice', diskQuotaMb: 512, maxEditBytes: 1024 * 1024, maxFileMode: 0o640, maxDirMode: 0o750, maxListEntries: 10000 }
const request = { op: 'write-checked' as const, path: 'public_html/.htaccess', content: '', remove: true, expectedExists: false, expectedContent: '', expectedMtime: '', mode: 0o640 }
// Only the process boundary is substituted; production request/envelope checks run.
const runner = (result: unknown, error?: Record<string, unknown>, extra?: Record<string, unknown>) => {
  const spawner = vi.fn(async () => ({ pid: 3210, exitCode: error ? 1 : 0, signal: null, stderr: '', stdout: JSON.stringify({ protocolVersion: 2, ok: !error, op: 'write-checked', worker: { pid: 3210, uid: 1001, gid: 1001, cgroup: '/' }, ...(error ? { error } : { result }), ...extra }) }))
  return { value: new NativeAccountFileRunner({ binaryPath: '/opt/xpanel/bin/xpanel-account-files', spawner }), spawner }
}
describe('internal checked helper protocol', () => {
  it('accepts only exact removal acknowledgement and bounded preimages', async () => {
    const f = runner(null); expect(await f.value.run(context, request)).toBeNull()
    await expect(f.value.run(context, { ...request, expectedContent: 'unbound' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(f.value.run(context, { ...request, path: '../outside' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.value.run(context, { ...request, host: 'other' } as AccountFileRequest)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.spawner).toHaveBeenCalledTimes(1)
  })
  it('marks malformed or extra-field acknowledgements uncertain', async () => {
    await expect(runner({ removed: true }).value.run(context, request)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    await expect(runner(null, undefined, { extra: true }).value.run(context, request)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
  })
  it('distinguishes preimage refusal from a post-publication sync failure', async () => {
    await expect(runner(null, { code: 'CONFLICT', errno: 11, errnoName: 'EAGAIN', message: 'preimage changed' }).value.run(context, request)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(runner(null, { code: 'SERVICE_UNAVAILABLE', errno: 5, errnoName: 'EIO', message: 'sync failed' }).value.run(context, request)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})
