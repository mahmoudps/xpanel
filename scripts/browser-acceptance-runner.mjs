import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { BROWSER_ACCEPTANCE, SHARD_COUNT, validateManifest } from './browser-acceptance-manifest.mjs'

export const ROOT = resolve(import.meta.dirname, '..')
const hash = value => createHash('sha256').update(value).digest('hex')
export const manifestHash = () => hash(JSON.stringify(BROWSER_ACCEPTANCE))
export function parseOptions(args) {
  const options = {}
  for (const argument of args) {
    if (argument === '--list' || argument === '--validate') {
      const key = argument.slice(2)
      if (options[key]) throw new Error('Duplicate argument')
      options[key] = true
    } else {
      const match = /^--(shard|run-id|aggregate)=(.+)$/.exec(argument)
      if (!match || Object.hasOwn(options, match[1])) throw new Error('Unknown or duplicate argument')
      options[match[1]] = match[2]
    }
  }
  if (options['run-id'] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(options['run-id'])) throw new Error('Invalid run ID')
  if (options.shard !== undefined && !new RegExp('^[1-' + SHARD_COUNT + ']/' + SHARD_COUNT + '$').test(options.shard)) throw new Error('Use shard 1/3, 2/3 or 3/3')
  if (options.aggregate && (options.shard || options.list || options.validate)) throw new Error('Aggregate cannot run a shard')
  return options
}
export function readSourceBytes(root, path) {
  const file = resolve(root, path)
  if (isAbsolute(path) || relative(root, file).startsWith('..')) throw new Error('Unsafe source path')
  const info = lstatSync(file)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Source inputs must be regular files without symlinks')
  const inside = relative(realpathSync(root), realpathSync(file))
  if (isAbsolute(inside) || inside.startsWith('..')) throw new Error('Source input escapes checkout')
  return readFileSync(file)
}
export function sourceIdentity(root = ROOT) {
  const git = argv => {
    const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) throw new Error('Cannot identify source checkout')
    return result.stdout.trim()
  }
  const commit = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid source revision')
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort()
  if (!paths.length || new Set(paths).size !== paths.length) throw new Error('Invalid source inventory')
  const digest = createHash('sha256')
  for (const path of paths) {
    if (isAbsolute(path) || relative(root, resolve(root, path)).startsWith('..')) throw new Error('Unsafe source path')
    digest.update(path + '\0').update(readSourceBytes(root, path)).update('\0')
  }
  return { commit, source_sha256: digest.digest('hex'), source_files: paths.length }
}
export function buildPlan(shard, runId, root = ROOT) {
  validateManifest()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(runId ?? '')) throw new Error('An explicit safe run ID is required')
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) throw new Error('Invalid shard')
  const directory = join(root, 'test-results', 'browser-acceptance-' + runId, 'shard-' + shard)
  const steps = BROWSER_ACCEPTANCE.filter(entry => entry.shard === shard).map(entry => {
    const output = join(directory, entry.output.prefix + (['file', 'vitest'].includes(entry.output.kind) ? '.json' : ''))
    const requestedOutput = relative(root, output).split(sep).join('/')
    const args = ['scripts/toolchain.mjs', ...entry.command]
    const env = { ...entry.env }
    if (entry.output.kind === 'directory') args.push('--output=' + requestedOutput)
    else if (entry.output.kind === 'file') args.push('--out', requestedOutput)
    else if (entry.output.kind === 'vitest') args.push('--reporter=json', '--outputFile=' + requestedOutput)
    else env[entry.output.key] = requestedOutput
    return { id: entry.id, command: [process.execPath, ...process.execArgv, ...args], env, output }
  })
  return { shard, run_id: runId, directory, steps }
}
const spawnStep = (step, env, root) => new Promise(resolveChild => {
  const child = spawn(step.command[0], step.command.slice(1), { cwd: root, env, stdio: 'inherit', windowsHide: true })
  let errorKind = null
  child.once('error', error => { errorKind = error.code ?? error.name })
  child.once('close', (code, signal) => resolveChild({ exit_code: code, signal, error_kind: errorKind }))
})
export async function runShard(plan, { execute = spawnStep, root = ROOT, identityReader = sourceIdentity } = {}) {
  const identity = identityReader(root)
  const expectedNode = readFileSync(join(root, '.node-version'), 'utf8').trim()
  if (process.versions.node !== expectedNode) throw new Error('Pinned Node is required')
  await mkdir(dirname(plan.directory), { recursive: true })
  await mkdir(plan.directory) // Never overwrite evidence from a previous attempt.
  const temporary = await mkdtemp(join(tmpdir(), 'xpanel-browser-partition-'))
  const started = performance.now()
  const receipt = { schema_version: 1, scope: 'browser-command-partition', execution_kind: execute === spawnStep && identityReader === sourceIdentity ? 'process' : 'test-double', run_id: plan.run_id, shard: plan.shard, shard_count: SHARD_COUNT, ...identity, manifest_sha256: manifestHash(), node: process.version, platform: process.platform, arch: process.arch, started_at: new Date().toISOString(), status: 'running', steps: plan.steps.map(step => ({ id: step.id, status: 'not_run', duration_ms: 0, exit_code: null })) }
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i], result = receipt.steps[i], begin = performance.now()
      const stepTemporary = join(temporary, step.id)
      await mkdir(stepTemporary)
      result.status = 'running'
      let outcome
      try {
        outcome = await execute(step, { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(root, '.tools', 'playwright-browsers'), ...step.env, TMPDIR: stepTemporary, TMP: stepTemporary, TEMP: stepTemporary }, root)
      } catch (error) { outcome = { exit_code: null, signal: null, error_kind: error.code ?? error.name } }
      Object.assign(result, outcome, { duration_ms: Math.round(performance.now() - begin), status: outcome.exit_code === 0 && !outcome.signal && existsSync(step.output) ? 'passed' : 'failed' })
      process.stdout.write('XPANEL_BROWSER_STEP=' + JSON.stringify({ shard: plan.shard, ...result }) + '\n')
      if (result.status !== 'passed') break
    }
    const after = identityReader(root)
    receipt.source_unchanged = after.commit === identity.commit && after.source_sha256 === identity.source_sha256
    receipt.status = receipt.source_unchanged && receipt.steps.every(step => step.status === 'passed') ? 'passed' : 'failed'
  } finally {
    receipt.finished_at = new Date().toISOString()
    receipt.duration_ms = Math.round(performance.now() - started)
    if (receipt.status === 'running') receipt.status = 'failed'
    const safe = resolve(temporary)
    if (!safe.startsWith(resolve(tmpdir()) + sep) || !safe.split(sep).at(-1).startsWith('xpanel-browser-partition-')) throw new Error('Unsafe fixture cleanup path')
    await rm(safe, { recursive: true, force: false })
    await writeFile(join(plan.directory, 'partition-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  }
  return receipt
}
export function aggregateReceipts(receipts, { runId, identity, expectedNode = 'v' + readFileSync(join(ROOT, '.node-version'), 'utf8').trim() }) {
  validateManifest()
  if (!Array.isArray(receipts) || receipts.length !== SHARD_COUNT) throw new Error('Exactly three partition receipts are required')
  const shards = new Set(), ids = new Set()
  for (const receipt of receipts) {
    if (receipt.schema_version !== 1 || receipt.scope !== 'browser-command-partition' || receipt.execution_kind !== 'process' || receipt.run_id !== runId || receipt.shard_count !== SHARD_COUNT || receipt.status !== 'passed' || receipt.source_unchanged !== true || receipt.node !== expectedNode || receipt.platform !== process.platform || receipt.arch !== process.arch || receipt.manifest_sha256 !== manifestHash() || receipt.commit !== identity.commit || receipt.source_sha256 !== identity.source_sha256 || receipt.source_files !== identity.source_files) throw new Error('Partition identity or success evidence mismatch')
    if (!Number.isInteger(receipt.shard) || receipt.shard < 1 || receipt.shard > SHARD_COUNT || shards.has(receipt.shard)) throw new Error('Unknown or duplicate shard receipt')
    shards.add(receipt.shard)
    const expected = BROWSER_ACCEPTANCE.filter(entry => entry.shard === receipt.shard).map(entry => entry.id)
    if (!Array.isArray(receipt.steps) || receipt.steps.length !== expected.length || !Number.isFinite(receipt.duration_ms) || receipt.duration_ms < 0) throw new Error('Incomplete partition receipt')
    for (let i = 0; i < expected.length; i++) {
      const step = receipt.steps[i]
      if (step.id !== expected[i] || ids.has(step.id) || step.status !== 'passed' || step.exit_code !== 0 || step.signal || step.error_kind || !Number.isFinite(step.duration_ms) || step.duration_ms < 0) throw new Error('Missing, duplicate or unsuccessful acceptance step')
      ids.add(step.id)
    }
  }
  if (ids.size !== BROWSER_ACCEPTANCE.length) throw new Error('Acceptance union is incomplete')
  return { schema_version: 1, scope: 'browser-command-aggregate', status: 'passed', run_id: runId, ...identity, manifest_sha256: manifestHash(), commands: ids.size, shards: SHARD_COUNT, duration_ms_by_shard: receipts.map(receipt => ({ shard: receipt.shard, duration_ms: receipt.duration_ms })), steps: receipts.flatMap(receipt => receipt.steps.map(step => ({ shard: receipt.shard, ...step }))) }
}
async function readReceipts(directory) {
  const matches = []
  async function visit(path, depth) {
    if (depth > 5) throw new Error('Receipt directory nesting exceeds limit')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Receipt symlinks are not accepted')
      const target = join(path, entry.name)
      if (entry.isDirectory()) await visit(target, depth + 1)
      else if (entry.name === 'partition-receipt.json') {
        if (matches.length >= SHARD_COUNT || statSync(target).size > 1024 * 1024) throw new Error('Receipt count or size exceeds limit')
        matches.push(JSON.parse(readFileSync(target, 'utf8')))
      }
    }
  }
  await visit(resolve(directory), 0)
  return matches
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (process.versions.node !== readFileSync(join(ROOT, '.node-version'), 'utf8').trim()) throw new Error('Pinned Node is required')
  const coverage = validateManifest()
  if (options.validate) { process.stdout.write(JSON.stringify({ status: 'coverage_validated', proof_executed: false, ...coverage, manifest_sha256: manifestHash() }) + '\n'); return 0 }
  const runId = options['run-id']
  if (options.list) {
    const plans = (options.shard ? [Number(options.shard[0])] : [1, 2, 3]).map(shard => buildPlan(shard, runId ?? 'dry-run'))
    process.stdout.write(JSON.stringify({ status: 'dry_run', proof_executed: false, plans }, null, 2) + '\n')
    return 0
  }
  if (!runId) throw new Error('An explicit run ID is required')
  if (options.aggregate) {
    const summary = aggregateReceipts(await readReceipts(options.aggregate), { runId, identity: sourceIdentity() })
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    if (process.env.GITHUB_STEP_SUMMARY) {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(process.env.GITHUB_STEP_SUMMARY, 'Browser acceptance: ' + summary.commands + ' commands passed across ' + summary.shards + ' partitions.\n\n| Command | Partition | Actual milliseconds |\n| --- | --- | ---: |\n' + summary.steps.map(step => '| ' + step.id + ' | ' + step.shard + ' | ' + step.duration_ms + ' |').join('\n') + '\n')
    }
    return 0
  }
  if (!options.shard) throw new Error('An explicit shard is required')
  if (realpathSync(process.cwd()) !== realpathSync(ROOT)) throw new Error('Run from the repository root')
  const receipt = await runShard(buildPlan(Number(options.shard[0]), runId))
  return receipt.status === 'passed' ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main() }
  catch { process.stderr.write('Browser acceptance partition validation or execution failed.\n'); process.exitCode = 1 }
}
