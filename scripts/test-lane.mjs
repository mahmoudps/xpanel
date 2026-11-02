import { spawnSync } from 'node:child_process'
import { readFileSync, statfsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freemem, loadavg, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { linuxProofPreflight } from './test-linux-preflight.mjs'
import { FAST_LANE_MS, MAX_EXPANDED_NATIVE_SLOW_CASES, MAX_EXPANDED_PORTABLE_SLOW_CASES } from './test-slow-budget.mjs'
import { planLane } from './test-lane-policy.mjs'
import { assertSameSource, identifySource } from './evidence/identity.mjs'

const root = resolve(import.meta.dirname, '..')
const report = value => process.stdout.write(`XPANEL_TEST_LANE=${JSON.stringify(value)}\n`)
const [lane, ...args] = process.argv.slice(2)
const started = performance.now()
try {
  const plan = planLane(lane, args)
  const expectedNode = readFileSync(resolve(root, '.node-version'), 'utf8').trim()
  if (process.versions.node !== expectedNode) throw new Error('Pinned project Node runtime required')
  const sourceBefore = identifySource(root, { requireClean: plan.cleanCommit })
  const { files: inputFiles, ...sourceIdentity } = sourceBefore
  const db = new DatabaseSync(':memory:')
  let sqliteVersion
  try { sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version }
  finally { db.close() }
  const disk = statfsSync(root, { bigint: true })
  const diskTotal = disk.blocks * disk.bsize, diskFree = disk.bavail * disk.bsize
  const diskFreePercent = diskTotal > 0n ? Number(diskFree * 1_000_000n / diskTotal) / 10_000 : 0
  const resources = { diskFreeBytes: String(diskFree), diskTotalBytes: String(diskTotal), diskFreePercent,
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadAverage: loadavg() }
  const environment = { node: process.versions.node, dbEngine: 'node:sqlite', sqliteVersion,
    sourceIdentity: { ...sourceIdentity, inputFileCount: inputFiles.length }, resources }
  const admissionReasons = []
  if (diskFreePercent < 1) admissionReasons.push('Workspace filesystem is below 1% free; heavy lanes are blocked')
  if (!plan.measurementOnly && MAX_EXPANDED_PORTABLE_SLOW_CASES === null) admissionReasons.push('Portable expanded slow-case budget is not established from the complete measured rebuilt inventory')
  if (lane === 'full' && MAX_EXPANDED_NATIVE_SLOW_CASES === null) admissionReasons.push('Native expanded slow-case budget is not established')
  if (admissionReasons.length) {
    report({ lane, status: 'blocked', environment, reasons: admissionReasons, suitesExecuted: false })
    process.exitCode = 2
  }
  if (lane === 'full' && process.exitCode !== 2) {
    const linux = linuxProofPreflight()
    if (linux.status === 'blocked') {
      report({ lane, status: 'blocked', environment, reasons: linux.reasons, suitesExecuted: false })
      process.exitCode = 2
    }
  }
  if (lane === 'release' && plan.preflight && process.exitCode !== 2) {
    const browser = spawnSync(process.execPath, [resolve(import.meta.dirname, 'test-suite.mjs'), 'browser', '--preflight'], { cwd: root, stdio: 'inherit', env: process.env })
    if (browser.status !== 0) {
      report({ lane, status: 'blocked', environment, reasons: ['Existing browser preflight did not report readiness'], suitesExecuted: false })
      process.exitCode = 2
    }
  }
  if (process.exitCode !== 2) {
    const vitest = resolve(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs')
    if (plan.preflight) report({ lane, status: 'available', environment, suitesExecuted: false, phases: plan.phases })
    else {
      report({ lane, status: 'running', environment, phases: plan.phases,
        scope: plan.measurementOnly ? 'measurement only: complete unfiltered portable expanded inventory; no acceptance or budget approval' : lane === 'fast' ? 'complete portable non-slow set after affected tests' : lane === 'full' ? 'all nonvisual portable and explicit native Linux Node tests, including slow cases' : 'existing browser acceptance and tagged computed visual cases' })
      let result = 0
      for (const phase of plan.phases) {
        const command = phase.layer === 'browser' ? [resolve(import.meta.dirname, 'test-suite.mjs'), 'browser'] : [vitest, 'run', ...phase.args]
        const child = spawnSync(process.execPath, command, { cwd: root,
          stdio: plan.measurementOnly ? ['ignore', 'pipe', 'inherit'] : 'inherit',
          encoding: plan.measurementOnly ? 'utf8' : undefined, maxBuffer: 64 * 1024 * 1024, env: {
          ...process.env, XPANEL_TEST_LANE: lane, XPANEL_TEST_PHASE: phase.phase, XPANEL_TEST_LAYER: phase.layer,
        } })
        let exitCode = child.status ?? 1
        if (plan.measurementOnly) {
          process.stdout.write(child.stdout ?? '')
          let measurement
          try {
            const lines = (child.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith('XPANEL_TEST_POLICY='))
            if (lines.length !== 1) throw new Error('Missing or duplicate census report')
            measurement = JSON.parse(lines[0].slice('XPANEL_TEST_POLICY='.length))
          } catch { measurement = null }
          const measured = measurement?.status === 'measurement_only' && measurement.qualificationPassed === false
            && measurement.budgetApproved === false && measurement.census?.frameworkCompleted === true
            && Array.isArray(measurement.census.cases) && measurement.census.cases.length > 0
          exitCode = exitCode === 2 && measured ? 0 : exitCode || 1
        }
        if (exitCode) { result = exitCode; break }
      }
      let sourceUnchanged = false
      try { assertSameSource(sourceBefore, identifySource(root, { requireClean: plan.cleanCommit })); sourceUnchanged = true }
      catch { result = result || 1 }
      const wallMs = performance.now() - started
      if (lane === 'fast' && wallMs >= FAST_LANE_MS) result = result || 1
      const exitCode = result || (plan.measurementOnly ? 2 : 0)
      report({ lane, status: result ? 'failed' : plan.measurementOnly ? 'measurement_only' : 'passed', environment, sourceUnchanged, wallMs, exitCode,
        qualificationPassed: !plan.measurementOnly && result === 0, budgetApproved: false,
        fastBudgetMs: lane === 'fast' ? FAST_LANE_MS : null,
        rebuildRequired: lane === 'fast' && wallMs >= FAST_LANE_MS,
        fullTechnicalAttempted: lane === 'full', technicalScopeCompleted: lane === 'full' && result === 0, productionDeployExecuted: false })
      process.exitCode = exitCode
    }
  }
} catch (error) {
  report({ lane: ['fast', 'full', 'release', 'census'].includes(lane) ? lane : null, status: 'failed', reasons: [error.message] })
  process.exitCode = 1
}
