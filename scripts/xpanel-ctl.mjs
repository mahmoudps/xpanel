#!/usr/bin/node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_NODE_VERSION = '26.12.1'
export const COMMAND_SCHEMA_VERSION = 1
const COMMANDS = new Set(['version', 'status', 'doctor', 'install', 'adopt', 'update', 'upgrade', 'rollback-release', 'recover', 'uninstall', 'verify-install-source', 'verify-install-ready'])
const CHANGES = new Set(['install', 'adopt', 'update', 'upgrade', 'rollback-release', 'recover', 'uninstall'])
const ARTIFACT_COMMANDS = new Set(['install', 'adopt', 'update', 'upgrade', 'verify-install-source', 'verify-install-ready'])
const PROOF_COMMANDS = new Set(['verify-install-source', 'verify-install-ready'])
const BOOLEANS = new Set(['json', 'yes', 'check', 'plan', 'apply', 'help', 'version'])
const VALUES = new Set(['artifact', 'sha256', 'signing-key', 'key-id', 'artifact-dir', 'dependency-receipt', 'dependency-sha256', 'release'])
const SHA = /^[a-fA-F0-9]{64}$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const safeArgument = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)

export const HELP = `Usage: xpanel-ctl <command> [options]

Commands:
  help, version              Show usage or runtime versions
  status, doctor             Read lifecycle state and prerequisites
  install, adopt             Plan installation/adoption (native apply unavailable)
  update                     Check or update within the current major version
  upgrade                    Plan or apply an explicit major-version upgrade
  rollback-release           Plan release recovery; native apply unavailable
  recover                    Plan or recover an interrupted operation
  uninstall                  Plan removal preserving data (native apply unavailable)
  verify-install-source      Diagnose authenticated source and installed bytes
  verify-install-ready       Diagnose actual runtime readiness

Changes default to --plan. Applying requires --apply --yes and genuine native
prerequisites. Native apply currently supports update, upgrade and recover only;
other change commands refuse before effects. Only update supports --check.
No purge or OS-upgrade command exists.

Authenticated artifact input (all required together):
  --artifact FILE --sha256 HEX --signing-key FILE --key-id ID
Source/readiness diagnostics also require --artifact-dir DIR.
Optional diagnostic input: --dependency-receipt FILE --dependency-sha256 HEX
A dependency receipt is input for inspection, never authority to apply.
Use --json for bounded structured output. Private paths and raw errors are omitted.
`

export class CliUsageError extends Error {
  constructor(code) { super('Invalid lifecycle command arguments.'); this.name = 'CliUsageError'; this.code = code }
}
const usage = code => { throw new CliUsageError(code) }

/** Pure request parsing; this function neither reads host state nor authorizes effects. */
export function parseLifecycleArgs(argv) {
  if (!Array.isArray(argv) || argv.length > 40 || argv.some(arg => !safeArgument(arg))) usage('INVALID_ARGUMENT')
  let command
  const options = new Map()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('-')) {
      if (command !== undefined) usage('EXTRA_POSITIONAL_ARGUMENT')
      command = arg
      continue
    }
    const token = arg === '-h' ? '--help' : arg === '-v' ? '--version' : arg
    if (!token.startsWith('--') || token === '--') usage('UNKNOWN_OPTION')
    const equal = token.indexOf('='), name = token.slice(2, equal === -1 ? undefined : equal)
    if (options.has(name)) usage('DUPLICATE_OPTION')
    if (BOOLEANS.has(name)) {
      if (equal !== -1) usage('BOOLEAN_OPTION_VALUE')
      options.set(name, true)
    } else if (VALUES.has(name)) {
      const value = equal === -1 ? argv[++index] : token.slice(equal + 1)
      if (!safeArgument(value) || value.startsWith('-')) usage('MISSING_OPTION_VALUE')
      options.set(name, value)
    } else usage('UNKNOWN_OPTION')
  }
  const json = options.has('json')
  if (command === 'help' || options.has('help') || (command === undefined && options.size === (json ? 1 : 0))) {
    if (command !== undefined && command !== 'help' && !COMMANDS.has(command) || [...options.keys()].some(key => key !== 'help' && key !== 'json')) usage('HELP_OPTION_CONFLICT')
    return Object.freeze({ schemaVersion: COMMAND_SCHEMA_VERSION, command: 'help', mode: 'read', json, assumeYes: false })
  }
  if (options.has('version')) {
    if (command !== undefined || [...options.keys()].some(key => key !== 'version' && key !== 'json')) usage('VERSION_OPTION_CONFLICT')
    command = 'version'
  }
  if (!COMMANDS.has(command)) usage('UNKNOWN_COMMAND')
  const modes = ['check', 'plan', 'apply'].filter(mode => options.has(mode))
  if (modes.length > 1) usage('CONFLICTING_MODES')
  if (modes.length && !CHANGES.has(command)) usage('MODE_NOT_SUPPORTED')
  const mode = modes[0] ?? (CHANGES.has(command) ? 'plan' : 'read')
  if (mode === 'check' && command !== 'update') usage('CHECK_NOT_SUPPORTED')
  if (mode === 'apply' && !options.has('yes')) usage('APPLY_REQUIRES_YES')
  if (options.has('yes') && mode !== 'apply') usage('YES_REQUIRES_APPLY')
  const names = ['artifact', 'sha256', 'signing-key', 'key-id'], artifactCount = names.filter(name => options.has(name)).length
  if (artifactCount && !ARTIFACT_COMMANDS.has(command)) usage('ARTIFACT_NOT_SUPPORTED')
  if (artifactCount && artifactCount !== names.length) usage('INCOMPLETE_ARTIFACT_PROOF')
  if ((PROOF_COMMANDS.has(command) || mode === 'apply' && ['install', 'adopt', 'update', 'upgrade'].includes(command)) && artifactCount !== names.length) usage('ARTIFACT_PROOF_REQUIRED')
  if (artifactCount && !SHA.test(options.get('sha256'))) usage('INVALID_ARCHIVE_SHA256')
  if (artifactCount && !KEY_ID.test(options.get('key-id'))) usage('INVALID_KEY_ID')
  if (options.has('artifact-dir') && !PROOF_COMMANDS.has(command)) usage('ARTIFACT_DIRECTORY_NOT_SUPPORTED')
  if (PROOF_COMMANDS.has(command) && !options.has('artifact-dir')) usage('ARTIFACT_DIRECTORY_REQUIRED')
  const dependencyPath = options.has('dependency-receipt'), dependencyHash = options.has('dependency-sha256')
  if ((dependencyPath || dependencyHash) && !ARTIFACT_COMMANDS.has(command)) usage('DEPENDENCY_RECEIPT_NOT_SUPPORTED')
  if (dependencyPath !== dependencyHash) usage('INCOMPLETE_DEPENDENCY_RECEIPT')
  if (dependencyHash && !SHA.test(options.get('dependency-sha256'))) usage('INVALID_DEPENDENCY_SHA256')
  if (options.has('release') && command !== 'rollback-release') usage('RELEASE_NOT_SUPPORTED')
  if (command === 'rollback-release' && !options.has('release')) usage('RELEASE_REQUIRED')
  if (options.has('release') && (!VERSION.test(options.get('release')) || options.get('release').length > 64 || options.get('release').split('.').some(part => !Number.isSafeInteger(Number(part))))) usage('INVALID_RELEASE')
  const request = { schemaVersion: COMMAND_SCHEMA_VERSION, command, mode, json, assumeYes: options.has('yes') }
  if (artifactCount) request.artifact = Object.freeze({ path: options.get('artifact'), expectedArchiveSha256: options.get('sha256').toLowerCase(), signingKeyPath: options.get('signing-key'), keyId: options.get('key-id') })
  if (options.has('artifact-dir')) request.artifactDir = options.get('artifact-dir')
  if (dependencyPath) request.dependencyReceipt = Object.freeze({ path: options.get('dependency-receipt'), expectedSha256: options.get('dependency-sha256').toLowerCase() })
  if (options.has('release')) request.targetRelease = options.get('release')
  return Object.freeze(request)
}

const OUTCOMES = new Map([[0, new Set(['read', 'planned', 'committed'])], [2, new Set(['blocked'])], [3, new Set(['blocked'])], [4, new Set(['blocked'])], [5, new Set(['blocked'])], [6, new Set(['attention'])], [7, new Set(['bootstrap-pending'])]])
const MESSAGES = new Map([[0, 'Lifecycle command completed.'], [2, 'Invalid lifecycle command arguments.'], [3, 'Lifecycle prerequisites are not satisfied.'], [4, 'Another lifecycle operation holds the lock.'], [5, 'The previous operation has a verified failure.'], [6, 'Lifecycle state requires attention before another operation.'], [7, 'Source preparation completed; application bootstrap remains pending.']])
const STATES = new Set(['idle', 'ready', 'planned', 'committed', 'blocked', 'attention', 'retirement_pending', 'bootstrap-pending', 'not-installed', 'installed', 'in-progress', 'failed', 'rolled-back', 'rollback-pending', 'prepared', 'preflight', 'verify', 'stage', 'backup', 'activate', 'commit', 'rollback', 'recover', 'uninstall', 'adopt', 'dependency-verification', 'source-verification', 'unavailable'])
const VERSION_KEYS = new Set(['currentVersion', 'targetVersion', 'version', 'nodeVersion', 'requiredNodeVersion'])
const BOOLEAN_KEYS = new Set(['sourceVerified', 'dependenciesVerified', 'installReady', 'compatible', 'qualified', 'bootstrapPending', 'changed', 'preservedData'])
const HASH_KEYS = new Set(['archiveSha256', 'artifactSha256'])
const invalidResult = code => ({ exitCode: 6, code, outcome: 'attention', message: MESSAGES.get(6) })

/** Output filtering only; a result shape does not grant lifecycle authority. */
export function publicLifecycleResult(result, expectedMode) {
  if (!result || typeof result !== 'object' || !OUTCOMES.get(result.exitCode)?.has(result.outcome) || typeof result.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code)) return invalidResult('INVALID_RUNTIME_RESULT')
  if (result.exitCode === 0 && expectedMode && result.outcome !== ({ read: 'read', check: 'read', plan: 'planned', apply: 'committed' })[expectedMode]) return invalidResult('INVALID_RUNTIME_OUTCOME')
  const clean = { exitCode: result.exitCode, code: result.code, outcome: result.outcome, message: MESSAGES.get(result.exitCode) }
  if (result.details && typeof result.details === 'object' && !Array.isArray(result.details)) {
    const details = {}
    for (const [key, value] of Object.entries(result.details)) {
      if (VERSION_KEYS.has(key) && typeof value === 'string' && value.length <= 64 && VERSION.test(value)) details[key] = value
      if ((key === 'status' || key === 'phase') && STATES.has(value)) details[key] = value
      if (key === 'reason' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) details[key] = value
      if (key === 'officialReference' && (value === null || typeof value === 'string' && /^XP-JOB-[0-9]{4}-[0-9]{6,16}$/.test(value))) details[key] = value
      if (BOOLEAN_KEYS.has(key) && typeof value === 'boolean') details[key] = value
      if (HASH_KEYS.has(key) && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) details[key] = value
      if (key === 'commandSchema' && value === COMMAND_SCHEMA_VERSION) details[key] = value
    }
    if (Object.keys(details).length) clean.details = details
  }
  return clean
}

const blocked = (exitCode, code) => publicLifecycleResult({ exitCode, code, outcome: exitCode === 6 ? 'attention' : 'blocked' })

/** Always dispatches to the single fixed runtime; no caller-selected backend is supported. */
export async function runLifecycleCli(argv, streams = { stdout: process.stdout, stderr: process.stderr }) {
  let request, result
  try { request = parseLifecycleArgs(argv) }
  catch (error) { result = blocked(2, error instanceof CliUsageError ? error.code : 'INVALID_ARGUMENT') }
  if (request?.command === 'help') {
    streams.stdout.write(request.json ? `${JSON.stringify({ exitCode: 0, code: 'HELP', outcome: 'read', usage: HELP })}\n` : HELP)
    return 0
  }
  if (request?.command === 'version') result = publicLifecycleResult({ exitCode: 0, code: 'CLI_VERSION', outcome: 'read', details: { commandSchema: COMMAND_SCHEMA_VERSION, nodeVersion: process.versions.node, requiredNodeVersion: REQUIRED_NODE_VERSION } })
  if (request && !result) {
    if (process.versions.node !== REQUIRED_NODE_VERSION) result = blocked(3, 'PINNED_NODE_REQUIRED')
    else if (process.env.NODE_OPTIONS || process.env.NODE_PATH) result = blocked(3, 'UNTRUSTED_NODE_ENVIRONMENT')
    else if (request.mode === 'apply' && (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0)) result = blocked(3, 'ROOT_LINUX_REQUIRED')
    else {
      try {
        const runtime = await import('./lifecycle-runtime.mjs')
        result = typeof runtime.runLifecycleRuntime === 'function' ? publicLifecycleResult(await runtime.runLifecycleRuntime(request), request.mode) : blocked(3, 'RUNTIME_UNAVAILABLE')
      } catch (error) {
        result = blocked(error?.code === 'ERR_MODULE_NOT_FOUND' ? 3 : 6, error?.code === 'ERR_MODULE_NOT_FOUND' ? 'RUNTIME_UNAVAILABLE' : 'RUNTIME_ATTENTION_REQUIRED')
      }
    }
  }
  const json = request?.json ?? (Array.isArray(argv) && argv.includes('--json'))
  const stream = result.exitCode === 0 || json ? streams.stdout : streams.stderr
  stream.write(json ? `${JSON.stringify(result)}\n` : `${result.code}: ${result.message}\n${result.details ? `${JSON.stringify(result.details)}\n` : ''}`)
  return result.exitCode
}

if (import.meta.main || process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runLifecycleCli(process.argv.slice(2)) }
  catch { process.stderr.write('RUNTIME_ATTENTION_REQUIRED: Lifecycle state requires attention before another operation.\n'); process.exitCode = 6 }
}
