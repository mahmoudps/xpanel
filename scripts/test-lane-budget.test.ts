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

it('blocks unestablished production budgets without turning a test fixture cap into approval', { tags: ['unit'] }, () => {
  expect(MAX_EXPANDED_PORTABLE_SLOW_CASES).toBeNull()
  expect(MAX_EXPANDED_NATIVE_SLOW_CASES).toBeNull()
  expect(slowBudgetCheck([])).toMatchObject({ status: 'blocked', maximum: null, observed: 0 })
  expect(() => assertSlowBudget([])).toThrow(/not established/)
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

it('counts fast-filtered expanded cases and blocks an unestablished real runtime budget', { tags: ['unit'] }, () => {
  const count = 4
  const result = reportFixture(Array.from({ length: count }, () => 'skipped'), Array.from({ length: count }, () => ['slow']), 'passed')
  expect(result.report.status).toBe('failed')
  expect(result.report.budget).toMatchObject({ status: 'blocked', maximum: null, observed: count })
  expect(result.capturedErrors).toHaveLength(1)
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
