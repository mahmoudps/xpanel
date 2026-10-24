import { describe, expect, it } from 'vitest'
import { validateLifecycleRuntimeRequest, lifecycleCompatibilitySummary, runLifecycleRuntime } from './lifecycle-runtime.mjs'
const request = { schemaVersion: 1, command: 'upgrade', mode: 'apply', json: true, assumeYes: true }
describe('canonical lifecycle runtime dispatch', () => {
  it('requires exact command modes and explicit apply confirmation', () => {
    for (const wrong of [{ ...request, assumeYes: false }, { ...request, command: 'shell' }, { ...request, command: 'status' }, { ...request, durable: true }, { ...request, artifact: { path: '/tmp/archive', expectedArchiveSha256: 'a'.repeat(64) } }]) expect(() => validateLifecycleRuntimeRequest(wrong)).toThrow()
    expect(validateLifecycleRuntimeRequest({ ...request, mode: 'plan', assumeYes: false }).mode).toBe('plan')
  })
  it('does not promote a plan or schema comparison into an apply capability', async () => {
    expect(lifecycleCompatibilitySummary({ source: { version: '1.2.3', controlDbSchemaVersion: 3 } }, { version: '1.2.4', controlDbSchemaVersion: 3 })).toEqual({ sameMajor: true, newer: true, sameSchema: true })
    const planned = await runLifecycleRuntime({ ...request, mode: 'plan', assumeYes: false })
    expect(planned.outcome).toBe('planned'); expect(planned.details.ready).toBe(false)
  })
  it.runIf(process.platform !== 'linux')('refuses actual unsupported privileged execution with no artifact or namespace effects', async () => {
    const result = await runLifecycleRuntime(request)
    expect(result.exitCode).toBe(3); expect(result.outcome).toBe('blocked')
  })
})
