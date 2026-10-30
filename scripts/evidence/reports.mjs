import { isRecord, requireValue, stringList } from './contracts.mjs'

function assertInventory(actual, expected) {
  stringList(actual, 'Report has duplicate, missing or unnamed checks')
  requireValue(actual.length === expected.length && expected.every(id => actual.includes(id)), 'Report check inventory does not match the reviewed requirement')
}

/** Exit code and output existence are deliberately insufficient acceptance. */
export function validateSemanticReport(report, kind, expectedCases) {
  stringList(expectedCases, 'A reviewed expected check inventory is required')
  requireValue(isRecord(report), 'A semantic report must be an object')
  if (kind === 'checks-v1') {
    requireValue(report.schemaVersion === 1 && report.status === 'passed' && report.proofExecuted === true && Array.isArray(report.checks), 'Incomplete acceptance check report')
    assertInventory(report.checks.map(check => check.id), expectedCases)
    requireValue(report.checks.every(check => check.status === 'passed' && check.error === undefined && Object.hasOwn(check, 'observed') && check.observed !== undefined && check.observed !== null), 'An acceptance check failed, skipped, lacked observation or remained blocked')
    return { total: report.checks.length, passed: report.checks.length, failed: 0, skipped: 0 }
  }
  if (kind === 'vitest-v1') {
    requireValue(report.success === true && Array.isArray(report.testResults) && report.numTotalTests === expectedCases.length && report.numPassedTests === expectedCases.length && report.numFailedTests === 0 && report.numPendingTests === 0 && (report.numTodoTests ?? 0) === 0 && (report.numFailedTestSuites ?? 0) === 0, 'Vitest report is incomplete or unsuccessful')
    const cases = report.testResults.flatMap(suite => {
      requireValue(suite.status === 'passed' && Array.isArray(suite.assertionResults) && (suite.message ?? '') === '', 'Vitest suite failed collection or did not finish')
      return suite.assertionResults
    })
    assertInventory(cases.map(test => test.fullName), expectedCases)
    requireValue(cases.every(test => test.status === 'passed' && Array.isArray(test.failureMessages) && test.failureMessages.length === 0), 'Vitest assertion failed or was skipped')
    return { total: cases.length, passed: cases.length, failed: 0, skipped: 0 }
  }
  throw new Error('Unknown semantic report format; a producer adapter is required')
}
