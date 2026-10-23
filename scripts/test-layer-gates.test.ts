import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testLayerConfig } from './test-layers.mjs'

const runner = resolve(import.meta.dirname, 'test-suite.mjs')

describe('Test environment gates', () => {
  it('reports missing disposable VM acknowledgement as blocked without starting a test runner', () => {
    const env = { ...process.env }
    delete env.XPANEL_TEST_DISPOSABLE_VM
    const child = spawnSync(process.execPath, [runner, 'linux', '--preflight'], { env, encoding: 'utf8' })
    expect(child.status).toBe(2)
    const result = JSON.parse(child.stdout.trim().replace(/^XPANEL_TEST_LAYER=/, ''))
    expect(result.layer).toBe('linux')
    expect(result.status).toBe('blocked')
    expect(result.reasons.join(' ')).toContain('disposable VM')
    expect(child.stdout).not.toContain('"status":"passed"')
  })

  it('blocks browser qualification when the matching Chromium is absent', () => {
    const child = spawnSync(process.execPath, [runner, 'browser', '--preflight'], {
      encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve(import.meta.dirname, '../test-results/missing-browser-cache') },
    })
    expect(child.status).toBe(2)
    const result = JSON.parse(child.stdout.trim().replace(/^XPANEL_TEST_LAYER=/, ''))
    expect(result.status).toBe('blocked')
    expect(result.layer).toBe('browser')
    expect(child.stdout).not.toContain('"status":"passed"')
  })

  it('blocks executor qualification before Linux cases when disposable acknowledgement is absent', () => {
    const env = { ...process.env }
    delete env.XPANEL_TEST_DISPOSABLE_VM
    const qualifier = resolve(import.meta.dirname, 'vm/qualify-linux-executor.mjs')
    const child = spawnSync(process.execPath, [qualifier, `--snapshot-sha256=${'a'.repeat(64)}`], { env, encoding: 'utf8' })
    expect(child.status).toBe(2)
    const result = JSON.parse(child.stdout.trim())
    expect(result.layer).toBe('linux-executor')
    expect(result.status).toBe('blocked')
    expect(result.reasons.join(' ')).toContain('acknowledgement')
  })

  it('blocks executor and boundary qualification when a verified snapshot receipt is absent even if XPANEL_SOURCE_VERIFIED=true is set', () => {
    const env = { ...process.env, XPANEL_SOURCE_VERIFIED: 'true' }
    delete env.XPANEL_TEST_DISPOSABLE_VM
    const execQualifier = resolve(import.meta.dirname, 'vm/qualify-linux-executor.mjs')
    const execChild = spawnSync(process.execPath, [execQualifier, `--snapshot-sha256=${'a'.repeat(64)}`], { env, encoding: 'utf8' })
    expect(execChild.status).toBe(2)
    const execResult = JSON.parse(execChild.stdout.trim())
    expect(execResult.status).toBe('blocked')
    expect(execResult.reasons.join(' ')).toMatch(/receipt/i)
    expect(execResult.reasons.join(' ')).toMatch(/source-sha256/i)

    const boundaryQualifier = resolve(import.meta.dirname, 'vm/qualify-agent-boundary.mjs')
    const boundaryChild = spawnSync(process.execPath, [boundaryQualifier, `--snapshot-sha256=${'a'.repeat(64)}`], { env, encoding: 'utf8' })
    expect(boundaryChild.status).toBe(2)
    const boundaryResult = JSON.parse(boundaryChild.stdout.trim())
    expect(boundaryResult.status).toBe('blocked')
    expect(boundaryResult.preflight.reasons.join(' ')).toMatch(/receipt/i)
    expect(boundaryResult.preflight.reasons.join(' ')).toMatch(/source-sha256/i)
  })

  it('keeps the privileged fixture and *.linux.test.ts explicitly separate from portable tests', () => {
    expect(testLayerConfig('portable').exclude).toContain('apps/agent/src/linux-isolation.test.ts')
    expect(testLayerConfig('portable').exclude).toContain('**/*.linux.test.ts')
    expect(testLayerConfig('linux').include).toContain('apps/agent/src/linux-isolation.test.ts')
    expect(testLayerConfig('linux').include).toContain('**/*.linux.test.ts')
    expect(() => testLayerConfig('unknown')).toThrow('Unknown test layer')
  })
})
