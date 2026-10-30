import { execFile, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { planLane } from './test-lane-policy.mjs'

const root = resolve(import.meta.dirname, '..')
const vitest = resolve(fileURLToPath(import.meta.resolve('vitest/package.json')), '../vitest.mjs')
const config = resolve(import.meta.dirname, 'testing/lanes/fixtures.config.ts')
const maximumOutputBytes = 2 * 1024 * 1024

interface ChildResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; pid: number | undefined }

/** Real bounded children; a timeout retires the owned process tree, never the parent runner. */
function runChild(args: string[], additions: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env, ...additions, NO_COLOR: '1', FORCE_COLOR: '0' }
    delete environment.XPANEL_TEST_DISPOSABLE_VM
    delete environment.XPANEL_SOURCE_VERIFIED
    const child = spawn(process.execPath, args, {
      cwd: root, env: environment, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    let bytes = 0, failure: Error | undefined, retiring: Promise<void> | undefined
    const retire = (reason: Error) => {
      failure ??= reason
      if (retiring || !child.pid || child.exitCode !== null || child.signalCode !== null) return
      retiring = new Promise<void>((done, failed) => {
        if (process.platform === 'win32') {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, error => {
            if (error && child.exitCode === null && child.signalCode === null) failed(error)
            else done()
          })
        } else {
          try { process.kill(-child.pid!, 'SIGKILL'); done() }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') done(); else failed(error) }
        }
      })
      // Close handling below observes the retirement result; avoid an unhandled rejection.
      void retiring.catch(() => {})
    }
    const timer = setTimeout(() => retire(new Error('Bounded lane fixture exceeded 10000 ms')), 10000)
    for (const channel of ['stdout', 'stderr'] as const) child[channel]!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maximumOutputBytes) { retire(new Error('Bounded lane fixture exceeded its output budget')); return }
      chunks[channel].push(chunk)
    })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', async (exitCode, signal) => {
      clearTimeout(timer)
      try {
        await retiring
        if (failure) throw failure
        resolveResult({ exitCode, signal, pid: child.pid,
          stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8') })
      } catch (error) { reject(error) }
    })
  })
}

function policy(result: ChildResult) {
  const reports = result.stdout.split(/\r?\n/).filter(line => line.startsWith('XPANEL_TEST_POLICY='))
  expect(reports, result.stderr).toHaveLength(1)
  return JSON.parse(reports[0]!.slice('XPANEL_TEST_POLICY='.length))
}

const fixtureArgs = (args: string[] = []) => [vitest, 'run', '--config', config, '--configLoader', 'native', ...args]

it('qualifies actual Vitest collection, forbidden focus and nonpassing census without running the project suite', { tags: ['slow', 'journey'], timeout: 60000 }, async () => {
  // This entire test is one orchestration journey. The nested config discovers only .case.ts fixtures.
  const filtered = await runChild(fixtureArgs(['--tags-filter', '!slow']), {
    XPANEL_LANE_INTEGRATION_FIXTURE: 'selection', XPANEL_TEST_LANE: 'fast', XPANEL_TEST_LAYER: 'portable', XPANEL_TEST_PHASE: 'complete',
  })
  expect(filtered.signal).toBeNull()
  expect(filtered.exitCode).toBe(1) // The real null budget must fail closed, even in this tiny fixture.
  const filteredPolicy = policy(filtered)
  expect(filteredPolicy).toMatchObject({ status: 'failed', expandedCases: 4,
    results: { passed: 1, failed: 0, skipped: 3 }, budget: { status: 'blocked', maximum: null, observed: 3 } })
  expect(filteredPolicy.violations).toContainEqual(expect.objectContaining({ kind: 'slow-budget-unestablished' }))

  const focused = await runChild(fixtureArgs(), {
    XPANEL_LANE_INTEGRATION_FIXTURE: 'focused', XPANEL_TEST_LANE: 'fast', XPANEL_TEST_LAYER: 'portable', XPANEL_TEST_PHASE: 'complete',
  })
  expect(focused.signal).toBeNull()
  expect(focused.exitCode).toBe(1)
  expect(`${focused.stdout}\n${focused.stderr}`).toMatch(/Unexpected \.only modifier|\.only[^\r\n]*allowOnly/i)

  const census = await runChild(fixtureArgs(), {
    XPANEL_LANE_INTEGRATION_FIXTURE: 'selection', XPANEL_TEST_LANE: 'census', XPANEL_TEST_LAYER: 'portable', XPANEL_TEST_PHASE: 'census',
  })
  expect(census.signal).toBeNull()
  expect(census.exitCode).toBe(2)
  const measured = policy(census)
  expect(measured).toMatchObject({ status: 'measurement_only', expandedCases: 4, qualificationPassed: false, budgetApproved: false,
    results: { passed: 4, failed: 0, skipped: 0 }, census: { frameworkCompleted: true, taggedSlowCount: 3 } })
  expect(measured.census.cases.filter((test: any) => test.tags.includes('slow'))).toHaveLength(3)
  expect(measured.census.modules).toHaveLength(1)
  expect(measured.census.modules[0].durationMs).toBeGreaterThanOrEqual(0)

  const fullPlan = planLane('full')
  expect(fullPlan.phases).toHaveLength(2)
  expect(fullPlan.phases.every((phase: any) => phase.args.join(' ') === '--tags-filter !visual')).toBe(true)
  const fullSelection = await runChild(fixtureArgs(fullPlan.phases[0]!.args), {
    XPANEL_LANE_INTEGRATION_FIXTURE: 'selection', XPANEL_TEST_LANE: 'census', XPANEL_TEST_LAYER: 'portable', XPANEL_TEST_PHASE: 'census',
  })
  expect(fullSelection.signal).toBeNull()
  expect(fullSelection.exitCode).toBe(2)
  const selected = policy(fullSelection)
  expect(selected).toMatchObject({ status: 'measurement_only', results: { passed: 3, failed: 0, skipped: 1 } })
  expect(selected.census.cases.filter((test: any) => test.tags.includes('slow') && !test.tags.includes('visual')))
    .toHaveLength(2)
  expect(selected.census.cases.filter((test: any) => test.tags.includes('slow') && !test.tags.includes('visual'))
    .every((test: any) => test.state === 'passed')).toBe(true)

  const missingNative = await runChild([resolve(import.meta.dirname, 'test-suite.mjs'), 'linux', '--preflight'])
  expect(missingNative.signal).toBeNull()
  expect(missingNative.exitCode).toBe(2)
  const nativeReport = JSON.parse(missingNative.stdout.trim().replace(/^XPANEL_TEST_LAYER=/, ''))
  expect(nativeReport).toMatchObject({ layer: 'linux', status: 'blocked' })
  expect(nativeReport.reasons.join(' ')).toMatch(/disposable/i)
  expect(missingNative.stdout).not.toContain('"status":"running"')
  expect(missingNative.stdout).not.toContain('"status":"passed"')
  process.stdout.write(`XPANEL_TEST_LANE_INTEGRATION=${JSON.stringify({
    scope: 'tiny real Vitest fixtures only', completeProjectSuiteExecuted: false, qualificationPassed: false, budgetApproved: false,
    filtered: { exitCode: filtered.exitCode, expandedCases: filteredPolicy.expandedCases,
      results: filteredPolicy.results, slowObserved: filteredPolicy.budget.observed },
    focused: { exitCode: focused.exitCode, modifierRejected: true },
    census: { exitCode: census.exitCode, status: measured.status, expandedCases: measured.expandedCases },
    fullSelection: { exitCode: fullSelection.exitCode, results: selected.results,
      nonvisualSlowPassed: selected.census.cases.filter((test: any) => test.tags.includes('slow') && !test.tags.includes('visual') && test.state === 'passed').length },
    missingNative: { exitCode: missingNative.exitCode, status: nativeReport.status },
  })}\n`)
})
