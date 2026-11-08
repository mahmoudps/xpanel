import { expect, it, vi } from 'vitest'
import TestLaneReporter from './test-lane-reporter.mjs'
import { assertSlowBudget, caseViolations, planLane, slowBudgetCheck } from './test-lane-policy.mjs'
import { MAX_EXPANDED_NATIVE_SLOW_CASES, MAX_EXPANDED_PORTABLE_SLOW_CASES } from './test-slow-budget.mjs'

it('counts expanded records including skipped cases and duplicate labels', { tags: ['unit'] }, () => {
  const fixtureMaximum = 3
  const cases = Array.from({ length: fixtureMaximum }, () => ({ name: 'same label', state: 'skipped', tags: ['slow'] }))
  expect(assertSlowBudget(cases, fixtureMaximum)).toBe(fixtureMaximum)
  expect(slowBudgetCheck([...cases, { tags: ['slow'] }], fixtureMaximum)).toMatchObject({ status: 'failed', observed: fixtureMaximum + 1 })
  expect(() => assertSlowBudget(cases, -1)).toThrow(/Invalid/)
})

it('pins the approved portable ceiling and blocks the unestablished native budget', { tags: ['unit'] }, () => {
  expect(MAX_EXPANDED_PORTABLE_SLOW_CASES).toBe(192)
  expect(slowBudgetCheck([])).toMatchObject({ status: 'passed', maximum: 192, observed: 0 })
  expect(MAX_EXPANDED_NATIVE_SLOW_CASES).toBeNull()
  expect(slowBudgetCheck([], MAX_EXPANDED_NATIVE_SLOW_CASES)).toMatchObject({ status: 'blocked', maximum: null, observed: 0 })
  expect(() => assertSlowBudget([], MAX_EXPANDED_NATIVE_SLOW_CASES)).toThrow(/not established/)
})

it('fails at the slow threshold and keeps layer meanings distinct', { tags: ['unit'] }, () => {
  expect(caseViolations({ tags: [], duration: 1999 })).toEqual([])
  expect(caseViolations({ tags: [], duration: 2000 })).toContain('untagged-slow-case')
  expect(caseViolations({ tags: ['unit'], duration: 100 })).toContain('unit-over-100ms')
  expect(caseViolations({ tags: ['feature'], duration: 1000 })).toContain('feature-over-1000ms')
  expect(caseViolations({ tags: ['journey'], duration: 1 })).toContain('journey-requires-slow')
})

it('runs affected tests before the complete non-slow portable selection', { tags: ['unit'] }, () => {
  const plan = planLane('fast', ['--affected=scripts/test-lane-budget.test.ts'])
  expect(plan.phases[0]).toMatchObject({ phase: 'affected', args: ['scripts/test-lane-budget.test.ts'] })
  expect(plan.phases[1]).toMatchObject({ phase: 'complete', args: ['--tags-filter', '!slow'] })
  expect(planLane('full').phases.every(phase => !phase.args.includes('!slow'))).toBe(true)
})

it('rejects partial-suite flags and escaping affected paths', { tags: ['unit'] }, () => {
  expect(() => planLane('fast', ['--tags-filter=unit'])).toThrow(/Unsupported/)
  expect(() => planLane('fast', ['scripts/test-lane-budget.test.ts'])).toThrow(/Unsupported/)
  expect(() => planLane('fast', ['--affected=apps/x/src/../../../outside.test.ts'])).toThrow(/repository test/)
  expect(planLane('release').cleanCommit).toBe(true)
})

function reportFixture(states: string[], tags: string[][], reason: 'passed' | 'failed' | 'interrupted', lane = 'fast') {
  const previousCode = process.exitCode
  const previousLane = process.env.XPANEL_TEST_LANE
  let output = ''
  const capturedErrors: unknown[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { output += String(chunk); return true })
  try {
    process.env.XPANEL_TEST_LANE = lane
    const reporter = new TestLaneReporter()
    reporter.onInit({ state: { catchError: (error: unknown) => capturedErrors.push(error) } })
    const tests = states.map((state, index) => ({ fullName: 'same label', tags: tags[index] ?? [], result: () => ({ state }), diagnostic: () => ({ duration: 0 }) }))
    reporter.onTestRunEnd([{ relativeModuleId: 'fixture.test.ts', ok: () => reason === 'passed', children: { allTests: () => tests.values() } }], [], reason)
    return { report: JSON.parse(output.trim().replace(/^XPANEL_TEST_POLICY=/, '')), capturedErrors }
  } finally {
    write.mockRestore(); process.exitCode = previousCode
    if (previousLane === undefined) delete process.env.XPANEL_TEST_LANE
    else process.env.XPANEL_TEST_LANE = previousLane
  }
}

it('counts fast-filtered expanded cases against the real runtime budget', { tags: ['unit'] }, () => {
  const slow = (count: number) => reportFixture(Array.from({ length: count }, () => 'skipped'), Array.from({ length: count }, () => ['slow']), 'passed')
  const within = slow(192)
  expect(within.report.status).toBe('passed')
  expect(within.report.budget).toMatchObject({ status: 'passed', maximum: 192, observed: 192 })
  expect(within.capturedErrors).toEqual([])
  const over = slow(193)
  expect(over.report.status).toBe('failed')
  expect(over.report.budget).toMatchObject({ status: 'failed', maximum: 192, observed: 193 })
  expect(over.capturedErrors).toHaveLength(1)
  vi.stubEnv('XPANEL_TEST_LAYER', 'linux')
  try {
    const native = slow(4)
    expect(native.report.status).toBe('failed')
    expect(native.report.budget).toMatchObject({ status: 'blocked', maximum: null, observed: 4 })
    expect(native.capturedErrors).toHaveLength(1)
  } finally { vi.unstubAllEnvs() }
})

it('never labels failed or interrupted framework runs as passed', { tags: ['unit'] }, () => {
  expect(reportFixture(['failed'], [[]], 'failed').report.status).toBe('failed')
  expect(reportFixture([], [], 'interrupted').report.status).toBe('interrupted')
})

it('census measures the complete portable set and never approves a budget or qualification', { tags: ['unit'] }, () => {
  expect(planLane('census')).toMatchObject({ measurementOnly: true, cleanCommit: false,
    phases: [{ layer: 'portable', args: [], phase: 'census' }] })
  expect(() => planLane('census', ['--affected=scripts/test-lane-budget.test.ts'])).toThrow(/Unsupported/)
  expect(() => planLane('census', ['--tags-filter=slow'])).toThrow(/Unsupported/)
  const result = reportFixture(['passed', 'skipped'], [[], ['slow']], 'passed', 'census')
  expect(result.report).toMatchObject({ status: 'measurement_only', qualificationPassed: false, budgetApproved: false,
    census: { frameworkCompleted: true, taggedSlowCount: 1 } })
  expect(result.report.census.cases).toHaveLength(2)
  expect(result.capturedErrors).toEqual([])
  expect(reportFixture(['failed'], [[]], 'failed', 'census').report.status).toBe('failed')
})
