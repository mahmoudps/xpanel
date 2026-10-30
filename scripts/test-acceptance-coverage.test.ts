import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredTestNames, inspectAcceptanceCoverage, safeHarnessPath, validateAcceptanceCoverage } from './acceptance-coverage.mjs'

const root = resolve(import.meta.dirname, '..')
const original = JSON.parse(readFileSync(resolve(root, 'docs/planning/acceptance-scenario-mapping.json'), 'utf8'))
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const check = (edit: (mapping: any) => void, reader = source) => {
  const mapping = structuredClone(original)
  edit(mapping)
  return validateAcceptanceCoverage(mapping, reader)
}

describe('acceptance supporting assertion traceability', () => {
  it('resolves every scenario and fault harness with real declarations without promoting acceptance', () => {
    const result = inspectAcceptanceCoverage(root)
    expect(result.issues).toEqual([])
    expect(result).toMatchObject({ valid: true, scenarios: 60, faults: 6, independentlyAccepted: 0 })
    expect(result.uniqueHarnesses).toBeGreaterThan(20)
  })

  it('rejects missing harnesses beyond the historical two governance paths', () => {
    const missing = original.scenarios[37].harnesses[0]
    const result = check(() => {}, path => { if (path === missing) throw new Error('missing'); return source(path) })
    expect(result.valid).toBe(false)
    expect(result.issues.some((issue: string) => issue.includes(missing))).toBe(true)
  })

  it('rejects lost assertions, incomplete metadata and missing fault coverage', () => {
    expect(check(mapping => { mapping.scenarios[4].harnessCoverage[0].testName = 'unwritten assertion' }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[4].harnessCoverage = [] }).valid).toBe(false)
    expect(check(mapping => { mapping.faultMatrix[0].harnessCoverage = [] }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[4].acceptanceGaps = [] }).valid).toBe(false)
  })

  it('rejects duplicate, omitted and nonreciprocal scenario or fault identities', () => {
    expect(check(mapping => { mapping.scenarios.pop() }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[1].id = 'A01' }).valid).toBe(false)
    expect(check(mapping => { mapping.faultMatrix[0].coveredScenarios.push('A01') }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].faultClassIds.push('F06') }).valid).toBe(false)
  })

  it('does not allow a source declaration to become proof of execution or independent acceptance', () => {
    expect(check(mapping => { mapping.scenarios[0].independentAcceptance = true }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].portablePrimitiveVerified = true }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].harnessCoverage[0].executionStatus = 'passed' }).valid).toBe(false)
    expect(check(mapping => { mapping.independentAcceptance = true }).valid).toBe(false)
  })

  it('requires native and real browser prerequisites on those supporting mappings', () => {
    expect(check(mapping => { mapping.scenarios[0].harnessCoverage[0].environment = 'V' }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].harnessCoverage[0].environment = 'B' }).valid).toBe(false)
    expect(check(mapping => { Object.assign(mapping.scenarios[0].harnessCoverage[0], { environment: 'B', browserRequired: true }) }).valid).toBe(false)
  })

  it('rejects unsafe paths before a source read and ignores skipped declaration substitutes', () => {
    for (const path of ['../test.test.ts', 'apps/api/src/../auth.test.ts', 'C:/private.test.ts', 'apps\\api\\src\\x.test.ts', 'apps/api/src/hidden:stream.test.ts']) expect(safeHarnessPath(path)).toBe(false)
    const result = check(mapping => { mapping.scenarios[0].harnesses[0] = '../outside.test.ts' }, path => {
      expect(path).not.toContain('..')
      return source(path)
    })
    expect(result.valid).toBe(false)
    expect(declaredTestNames("it.skip('not evidence', () => {}); it('declared', () => {}); test(\"other\", () => {})")).toEqual(['declared', 'other'])
  })

  it('ignores comment, string, regex and skipped-suite copies of removed assertions', () => {
    const text = `/* it('commented', () => {}) */
      const example = "it('string copy', () => {})";
      const matcher = /it('regex copy')/;
      if (ready) /it('conditional regex')/.test(value);
      helper.it('member call', () => {});
      describe.skip('disabled', () => { it('skipped child', () => {}) });
      it('live declaration', () => {});`
    expect(declaredTestNames(text)).toEqual(['live declaration'])
  })

  it('reports malformed rows as validation failures instead of throwing or accepting them', () => {
    expect(check(mapping => { mapping.scenarios[0] = null }).valid).toBe(false)
    expect(check(mapping => { mapping.faultMatrix[0] = null }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].harnessCoverage = [null] }).valid).toBe(false)
    expect(check(mapping => { mapping.scenarios[0].faultClassIds = {} }).valid).toBe(false)
    expect(check(mapping => { mapping.faultMatrix[0].coveredScenarios = {} }).valid).toBe(false)
  })
})
