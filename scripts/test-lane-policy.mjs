import { performance } from 'node:perf_hooks'
import { MAX_EXPANDED_PORTABLE_SLOW_CASES, SLOW_CASE_MS } from './test-slow-budget.mjs'

export function assertSlowBudget(cases, maximum = MAX_EXPANDED_PORTABLE_SLOW_CASES) {
  if (maximum === null) throw new Error('Expanded slow-case budget is not established; measure and review the complete rebuilt inventory before setting it')
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error('Invalid expanded slow-case budget')
  const count = cases.filter(test => test.tags.includes('slow')).length
  if (count > maximum) throw new Error(`Expanded portable slow cases ${count} exceed budget ${maximum}`)
  return count
}

/** This real runtime check counts every collected expanded case, including filtered cases. */
export function slowBudgetCheck(cases, maximum = MAX_EXPANDED_PORTABLE_SLOW_CASES) {
  const started = performance.now()
  const observed = cases.filter(test => test.tags.includes('slow')).length
  let error = null
  try { assertSlowBudget(cases, maximum) }
  catch (failure) { error = failure.message }
  const durationMs = performance.now() - started
  if (durationMs >= 100) error = error ?? 'Expanded slow-case budget check exceeded 100 ms'
  return { name: 'expanded-slow-budget', status: maximum === null ? 'blocked' : error ? 'failed' : 'passed', observed,
    maximum, durationMs, error }
}

export function caseViolations(test) {
  const tags = new Set(test.tags)
  const problems = []
  if (test.duration >= SLOW_CASE_MS && !tags.has('slow')) problems.push('untagged-slow-case')
  if (tags.has('unit') && test.duration >= 100) problems.push('unit-over-100ms')
  if (tags.has('feature') && !tags.has('slow') && test.duration >= 1000) problems.push('feature-over-1000ms')
  if (tags.has('journey') && !tags.has('slow')) problems.push('journey-requires-slow')
  if (tags.has('visual') && !tags.has('slow')) problems.push('visual-requires-slow')
  if (['unit', 'feature', 'journey'].filter(tag => tags.has(tag)).length > 1) problems.push('ambiguous-test-layer')
  return problems
}

export function planLane(lane, args = []) {
  if (!['fast', 'full', 'release', 'census'].includes(lane)) throw new Error('Unknown test lane')
  const affected = [], options = new Set()
  for (const arg of args) {
    if (arg === '--preflight') { options.add(arg); continue }
    if (lane === 'fast' && arg.startsWith('--affected=')) {
      const path = arg.slice('--affected='.length).replaceAll('\\', '/')
      if (!/^(?:apps|packages)\/[^/]+\/src\/.+\.test\.ts$|^scripts\/test-[^/]+\.test\.ts$/.test(path)
          || path.split('/').some(part => part === '..' || part === '.')) throw new Error('Affected test path must be a repository test file')
      affected.push(path)
      continue
    }
    throw new Error('Unsupported lane option')
  }
  if (lane === 'fast' && options.has('--preflight') && affected.length) throw new Error('Preflight does not run affected tests')
  const phases = lane === 'census'
    ? [{ layer: 'portable', args: [], phase: 'census' }]
    : lane === 'fast'
    ? [...(affected.length ? [{ layer: 'portable', args: [...new Set(affected)], phase: 'affected' }] : []),
       { layer: 'portable', args: ['--tags-filter', '!slow'], phase: 'complete' }]
    : lane === 'full'
      ? [{ layer: 'portable', args: ['--tags-filter', '!visual'], phase: 'complete' }, { layer: 'linux', args: ['--tags-filter', '!visual'], phase: 'complete' }]
      : [{ layer: 'portable', args: ['--tags-filter', 'visual'], phase: 'visual' }, { layer: 'browser', args: [], phase: 'browser' }]
  return { lane, phases, preflight: options.has('--preflight'), cleanCommit: lane !== 'fast' && lane !== 'census', measurementOnly: lane === 'census' }
}
