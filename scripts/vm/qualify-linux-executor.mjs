import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executorLinuxPreflight } from '../test-linux-preflight.mjs'
import { verifySnapshotReceipt } from './verify-source-snapshot.mjs'

const root = resolve(import.meta.dirname, '../..')
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const separator = arg.indexOf('=')
  return [arg.slice(0, separator), arg.slice(separator + 1)]
}))
const gate = executorLinuxPreflight()
const snapshot = args['--snapshot-sha256']
let verifiedReceipt = null
if (!snapshot || !/^[a-f0-9]{64}$/.test(snapshot)) {
  gate.status = 'blocked'
  gate.reasons.push('A coordinator supplied --snapshot-sha256=<64 lowercase hex> is required.')
} else {
  const receiptCheck = verifySnapshotReceipt({
    rootDir: root,
    expectedArchiveSha256: snapshot,
    expectedSourceSha256: args['--source-sha256'],
    receiptPath: args['--receipt'] ?? null,
    requirePinnedPnpm: true,
  })
  if (!receiptCheck.ok) {
    gate.status = 'blocked'
    gate.reasons.push(...receiptCheck.reasons)
  } else {
    verifiedReceipt = receiptCheck.receipt
  }
}
const expectedNode = (await readFile(resolve(root, '.node-version'), 'utf8')).trim()
if (process.version !== `v${expectedNode}`) {
  gate.status = 'blocked'
  gate.reasons.push(`The source snapshot requires exact Node ${expectedNode}; this process is ${process.version}.`)
}
let vitest
try { vitest = resolve(dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))), 'vitest.mjs') }
catch {
  gate.status = 'blocked'
  gate.reasons.push('The snapshot development dependencies are unavailable; a pinned frozen-lockfile install is required before testing.')
}
const output = resolve(root, args['--output'] ?? 'test-results/linux-executor.json')
if (gate.status === 'blocked') {
  process.stdout.write(`${JSON.stringify(gate)}\n`)
  process.exitCode = 2
} else {
  await mkdir(dirname(output), { recursive: true })
  const sourcePaths = ['apps/agent/src/executor.ts', 'apps/agent/src/executor-linux.test.ts', 'packages/core/src/system.ts', 'packages/os/src/validate.ts', 'scripts/test-linux-preflight.mjs', 'scripts/vm/qualify-linux-executor.mjs', 'vitest.config.ts', 'pnpm-lock.yaml', 'package.json']
  const fingerprint = async () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })))
  const before = await fingerprint()
  const command = (file, commandArgs) => {
    const result = spawnSync(file, commandArgs, { encoding: 'utf8', timeout: 5000 })
    return { exit_code: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' }
  }
  const environment = { node: process.version, platform: process.platform, uid: process.getuid(), kernel: command('/usr/bin/uname', ['-srvmo']), systemd: command('/usr/bin/systemctl', ['--version']), virtualization: command('/usr/bin/systemd-detect-virt', []), os_release: await readFile('/etc/os-release', 'utf8') }
  const vitestOutput = `${output}.vitest.json`
  const observationsOutput = `${output}.observations.json`
  const startedAt = new Date().toISOString()
  const result = spawnSync(process.execPath, [vitest, 'run', 'apps/agent/src/executor-linux.test.ts', '--reporter=json', `--outputFile=${vitestOutput}`], {
    cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', XPANEL_TEST_LAYER: 'linux', XPANEL_QUALIFICATION_OBSERVATIONS: observationsOutput },
  })
  await writeFile(`${output}.stdout.txt`, result.stdout ?? '')
  await writeFile(`${output}.stderr.txt`, result.stderr ?? '')
  const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return null } }
  const tests = await readJson(vitestOutput)
  const observations = await readJson(observationsOutput)
  const after = await fingerprint()
  const sourceUnchanged = JSON.stringify(before) === JSON.stringify(after)
  const allTestsExecuted = tests?.numTotalTests >= 10 && tests.numPassedTests === tests.numTotalTests && tests.numPendingTests === 0
  const passed = result.status === 0 && tests?.success === true && allTestsExecuted && sourceUnchanged && observations?.cleanup?.ok === true
  const evidence = {
    schema_version: 1, scope: 'Real LinuxHostExecutor primitives on the authorized disposable VM; no fake executor, browser, Apache/PHP workload or live firewall traffic claim.',
    started_at: startedAt, finished_at: new Date().toISOString(), snapshot_archive_sha256: snapshot,
    coordinator_source_sha256: args['--source-sha256'] ?? null,
    snapshot_source_sha256: verifiedReceipt?.source_sha256 ?? null,
    snapshot_receipt_sha256: verifiedReceipt?.receipt_sha256 ?? null,
    archive_hash_verified_by_receipt: Boolean(verifiedReceipt),
    environment, preflight: gate, source_before: before, source_after: after, source_unchanged: sourceUnchanged,
    execution: { command: [process.execPath, vitest, 'run', 'apps/agent/src/executor-linux.test.ts', '--reporter=json', `--outputFile=${vitestOutput}`], exit_code: result.status, signal: result.signal, error: result.error?.message ?? null },
    status: passed ? 'passed' : 'failed', counts: tests ? { total: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests, pending: tests.numPendingTests } : null,
    observations, limits: ['Apache/PHP workload isolation is not exercised.', 'No firewall rule or SSH configuration is changed.', 'Positive quota enforcement is separately reported, never inferred from an executor success.'],
  }
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ status: evidence.status, counts: evidence.counts, source_unchanged: sourceUnchanged, cleanup: observations?.cleanup ?? null, evidence: output })}\n`)
  process.exitCode = passed ? 0 : 1
}
