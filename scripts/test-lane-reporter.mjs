import { slowBudgetCheck, caseViolations } from './test-lane-policy.mjs'
import { MAX_EXPANDED_NATIVE_SLOW_CASES, MAX_EXPANDED_PORTABLE_SLOW_CASES } from './test-slow-budget.mjs'

/** Policy checks use collected expanded cases, including cases excluded by the fast filter. */
export default class TestLaneReporter {
  #ctx
  onInit(ctx) { this.#ctx = ctx }
  onTestRunEnd(modules, unhandledErrors, reason) {
    const census = process.env.XPANEL_TEST_LANE === 'census'
    const cases = modules.flatMap(module => [...module.children.allTests()].map(test => ({
      path: module.relativeModuleId, name: test.fullName, tags: [...test.tags],
      state: test.result().state, duration: test.diagnostic()?.duration ?? 0,
    })))
    const violations = cases.flatMap(test => caseViolations(test).map(kind => ({ kind, ...test })))
    const maximum = process.env.XPANEL_TEST_LAYER === 'linux' ? MAX_EXPANDED_NATIVE_SLOW_CASES : MAX_EXPANDED_PORTABLE_SLOW_CASES
    const budget = slowBudgetCheck(cases, maximum)
    if (!census && budget.status !== 'passed') violations.push({ kind: budget.status === 'blocked' ? 'slow-budget-unestablished' : 'slow-budget', message: budget.error })
    if (process.env.XPANEL_TEST_PHASE === 'visual') {
      const visual = cases.filter(test => test.tags.includes('visual'))
      if (!visual.length || visual.some(test => test.state !== 'passed')) violations.push({ kind: 'visual-cases-not-complete' })
    }
    const slowest = [...cases].sort((a, b) => b.duration - a.duration).slice(0, 10)
    const frameworkCompleted = reason === 'passed' && unhandledErrors.length === 0 && modules.length > 0 && cases.length > 0 && modules.every(module => module.ok())
    const result = { lane: process.env.XPANEL_TEST_LANE, phase: process.env.XPANEL_TEST_PHASE,
      status: reason === 'interrupted' ? 'interrupted' : !frameworkCompleted ? 'failed' : census ? 'measurement_only' : violations.length ? 'failed' : 'passed',
      policyStatus: violations.length ? 'failed' : 'passed', unhandledErrorCount: unhandledErrors.length,
      results: { passed: cases.filter(test => test.state === 'passed').length, failed: cases.filter(test => test.state === 'failed').length, skipped: cases.filter(test => test.state === 'skipped').length }, expandedCases: cases.length,
      budget, violations, slowest,
      ...(census ? { qualificationPassed: false, budgetApproved: false,
        census: { frameworkCompleted, cases,
          modules: modules.map(module => ({ path: module.relativeModuleId, durationMs: module.diagnostic?.()?.duration ?? null, ok: module.ok() })),
          taggedSlowCount: cases.filter(test => test.tags.includes('slow')).length,
          observedSlowCount: cases.filter(test => test.duration >= 2000).length,
          untaggedSlowCount: cases.filter(test => test.duration >= 2000 && !test.tags.includes('slow')).length,
          limits: 'Complete portable measurement only. Rebuild observed slow fixtures before proposing an initial cap; no test-layer or qualification pass is granted.' } } : {}) }
    process.stdout.write(`XPANEL_TEST_POLICY=${JSON.stringify(result)}\n`)
    if (census) {
      // Measurement must not become a green build or an automatic budget increase.
      process.exitCode = frameworkCompleted ? 2 : 1
    } else if (violations.length) {
      this.#ctx.state.catchError(new Error('Test lane policy failed; see XPANEL_TEST_POLICY'), 'Test Lane Policy')
      process.exitCode = 1
    }
  }
}
