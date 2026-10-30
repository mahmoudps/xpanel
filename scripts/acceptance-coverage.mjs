import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const environments = new Set(['U', 'H', 'B', 'V', 'E'])
const scenarioIds = Array.from({ length: 60 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
const faultIds = Array.from({ length: 6 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`)
const harnessPath = /^(?:apps|packages)\/[^/]+\/src\/(?:[^/]+\/)*[^/]+\.test\.ts$|^scripts\/test-[^/]+\.test\.ts$/

export function safeHarnessPath(path) {
  return typeof path === 'string' && harnessPath.test(path)
    && !path.split('/').some(part => part === '.' || part === '..')
    && !/[:\\\x00-\x1f\x7f]/.test(path)
}

/** Static declaration anchors establish traceability only, never a passing test. */
export function declaredTestNames(source) {
  // Ignore literal/comment text without evaluating test modules or their fixtures.
  const code = new Uint8Array(source.length).fill(1)
  const parentheses = []
  let previous = '', closedControlCondition = false
  for (let index = 0; index < source.length;) {
    const start = index, char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
      code.fill(0, start, index); continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      code.fill(0, start, index); continue
    }
    if (char === "'" || char === '"' || char === '`') {
      index++
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index++] === char) break
      }
      code.fill(0, start, index); previous = 'literal'; closedControlCondition = false; continue
    }
    if (char === '/' && (!previous || /[=(,:!&|?{};>\[]/.test(previous)
      || ['return', 'throw', 'case', 'yield', 'await'].includes(previous) || closedControlCondition)) {
      index++
      let characterClass = false
      while (index < source.length && source[index] !== '\n') {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index] === '[') characterClass = true
        if (source[index] === ']') characterClass = false
        if (source[index++] === '/' && !characterClass) break
      }
      while (/[a-z]/i.test(source[index] ?? '') && index < source.length) index++
      code.fill(0, start, index); previous = 'literal'; closedControlCondition = false; continue
    }
    if (/[a-z_$]/i.test(char)) {
      index++
      while (index < source.length && /[a-z0-9_$]/i.test(source[index])) index++
      previous = source.slice(start, index); closedControlCondition = false; continue
    }
    if (char === '(') parentheses.push(['if', 'while', 'for', 'switch', 'catch', 'with'].includes(previous))
    if (char === ')') closedControlCondition = parentheses.pop() === true
    else if (!/\s/.test(char)) closedControlCondition = false
    if (!/\s/.test(char)) previous = char
    index++
  }
  const disabled = []
  const suites = /\bdescribe\s*\.\s*(?:skip|todo)\s*\(/g
  for (const match of source.matchAll(suites)) {
    if (!code[match.index]) continue
    let depth = 1, index = match.index + match[0].length
    for (; index < source.length && depth; index++) {
      if (!code[index]) continue
      if (source[index] === '(') depth++
      if (source[index] === ')') depth--
    }
    disabled.push([match.index, index])
  }
  const names = []
  const calls = /\b(?:it|test)\s*(?:\.\s*(?:concurrent|sequential))?\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g
  for (const match of source.matchAll(calls)) {
    if (!code[match.index] || disabled.some(([start, end]) => match.index >= start && match.index < end)) continue
    let before = match.index - 1
    while (before >= 0 && (!code[before] || /\s/.test(source[before]))) before--
    if (source[before] === '.') continue
    names.push((match[1] ?? match[2]).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t'))
  }
  return names
}

/** The injected reader keeps structural policy independently testable without a DB or fixture history. */
export function validateAcceptanceCoverage(mapping, readSource) {
  const issues = [], sources = new Map(), harnesses = new Set()
  const problem = (id, detail) => issues.push(`${id}: ${detail}`)
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { valid: false, issues: ['mapping: expected object'], scenarios: 0, faults: 0, uniqueHarnesses: 0, independentlyAccepted: 0 }
  }
  const scenarios = Array.isArray(mapping.scenarios) ? mapping.scenarios : []
  const faults = Array.isArray(mapping.faultMatrix) ? mapping.faultMatrix : []
  if (JSON.stringify(scenarios.map(item => item?.id)) !== JSON.stringify(scenarioIds)) problem('mapping', 'requires exactly A01-A60 in order')
  if (JSON.stringify(faults.map(item => item?.id)) !== JSON.stringify(faultIds)) problem('mapping', 'requires exactly F01-F06 in order')
  if (mapping.evidenceAssessment !== 'declarative_unaccepted' || mapping.independentAcceptance !== false) {
    problem('mapping', 'traceability inventory cannot claim independent acceptance')
  }

  function inspectCoverage(item, paths) {
    const id = item?.id ?? 'unknown'
    if (!Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length) {
      problem(id, 'requires unique supporting harness paths')
      return
    }
    const coverage = Array.isArray(item.harnessCoverage) ? item.harnessCoverage.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : []
    if (coverage.length !== item.harnessCoverage?.length) problem(id, 'invalid harness coverage row')
    if (coverage.length !== paths.length || new Set(coverage.map(row => row.path)).size !== coverage.length
      || coverage.some(row => !paths.includes(row.path))) problem(id, 'coverage must describe each mapped harness exactly once')
    if (item.mappingStatus !== 'partial' || !Array.isArray(item.acceptanceGaps) || !item.acceptanceGaps.length
      || item.acceptanceGaps.some(gap => typeof gap !== 'string' || gap.trim().length < 20)) {
      problem(id, 'requires explicit partial coverage and remaining independent acceptance gaps')
    }
    for (const path of paths) {
      if (!safeHarnessPath(path)) { problem(id, `unsafe harness path ${String(path)}`); continue }
      harnesses.add(path)
      if (!sources.has(path)) {
        try {
          const source = readSource(path)
          if (typeof source !== 'string') throw new Error('not source text')
          sources.set(path, new Set(declaredTestNames(source)))
        } catch { sources.set(path, null) }
      }
      const declared = sources.get(path)
      if (declared === null) { problem(id, `missing or unreadable harness ${path}`); continue }
      const row = coverage.find(value => value.path === path)
      if (!row) continue
      const model = { U: 'pure_primitive', H: 'loopback_transport', B: 'release_browser', V: 'disposable_native', E: 'external_observer' }
      const expectedModel = row.environment === null ? 'in_process_feature' : model[row.environment]
      if ((!environments.has(row.environment) && row.environment !== null) || row.executionModel !== expectedModel || row.role !== 'supporting_assertions'
        || row.executionStatus !== 'not_run') problem(id, `invalid declaration metadata for ${path}`)
      if (typeof row.testName !== 'string' || !declared.has(row.testName)) problem(id, `test declaration anchor not found in ${path}`)
      for (const field of ['assertions', 'oracle', 'limitations']) {
        if (typeof row[field] !== 'string' || row[field].trim().length < 20) problem(id, `missing ${field} description for ${path}`)
      }
      if (row.environment === 'B' && row.browserRequired !== true) problem(id, `browser mapping must require actual Chromium for ${path}`)
      if (row.environment === 'V' && row.nativePrerequisitesRequired !== true) problem(id, `native mapping must retain disposable-host prerequisites for ${path}`)
      if (row.environment === 'E' && row.externalObserverRequired !== true) problem(id, `external mapping must require an independent observer for ${path}`)
    }
  }

  const scenarioById = new Map(scenarios.map(item => [item?.id, item]))
  const faultById = new Map(faults.map(item => [item?.id, item]))
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) { problem('mapping', 'invalid scenario row'); continue }
    if (scenario.evidenceAssessment !== 'declarative_unaccepted' || scenario.independentAcceptance !== false) problem(scenario.id, 'a source mapping is not independent execution evidence')
    if (scenario.portablePrimitiveVerified !== false) problem(scenario.id, 'legacy primitive verification must remain false without an execution receipt')
    inspectCoverage(scenario, scenario.harnesses)
    if (!Array.isArray(scenario.faultClassIds)) problem(scenario.id, 'faultClassIds must be an array')
    for (const faultId of Array.isArray(scenario.faultClassIds) ? scenario.faultClassIds : []) {
      const reciprocal = faultById.get(faultId)?.coveredScenarios
      if (!Array.isArray(reciprocal) || !reciprocal.includes(scenario.id)) problem(scenario.id, `fault ${faultId} is not reciprocal`)
    }
  }
  for (const fault of faults) {
    if (!fault || typeof fault !== 'object' || Array.isArray(fault)) { problem('mapping', 'invalid fault row'); continue }
    inspectCoverage(fault, [fault.portableHarness])
    if (!Array.isArray(fault.coveredScenarios) || !fault.coveredScenarios.length) problem(fault.id, 'coveredScenarios must be a nonempty array')
    for (const scenarioId of Array.isArray(fault.coveredScenarios) ? fault.coveredScenarios : []) {
      const reciprocal = scenarioById.get(scenarioId)?.faultClassIds
      if (!Array.isArray(reciprocal) || !reciprocal.includes(fault.id)) problem(fault.id, `scenario ${scenarioId} is not reciprocal`)
    }
  }
  return {
    valid: issues.length === 0, issues, scenarios: scenarios.length, faults: faults.length,
    uniqueHarnesses: harnesses.size,
    independentlyAccepted: scenarios.filter(item => item?.independentAcceptance === true).length,
  }
}

export function inspectAcceptanceCoverage(root = resolve(import.meta.dirname, '..')) {
  const rootPath = realpathSync(root)
  const mapping = JSON.parse(readFileSync(resolve(rootPath, 'docs/planning/acceptance-scenario-mapping.json'), 'utf8'))
  return validateAcceptanceCoverage(mapping, path => {
    const full = resolve(rootPath, path)
    const actual = realpathSync(full), rel = relative(rootPath, actual)
    if (!safeHarnessPath(path) || actual !== full || isAbsolute(rel) || rel.startsWith('..') || !lstatSync(full).isFile()) throw new Error('Unsafe harness')
    return readFileSync(full, 'utf8')
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('acceptance-coverage accepts no arguments')
    const result = inspectAcceptanceCoverage()
    process.stdout.write(`${JSON.stringify({ ...result, kind: 'declarative_traceability', executionEvidence: false }, null, 2)}\n`)
    process.exitCode = result.valid ? 0 : 1
  } catch (error) {
    process.stderr.write(`Acceptance coverage inspection failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
