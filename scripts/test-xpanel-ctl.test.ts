import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliUsageError, HELP, parseLifecycleArgs, publicLifecycleResult, runLifecycleCli } from './xpanel-ctl.mjs'

const root = resolve(import.meta.dirname, '..')
const hash = 'a'.repeat(64)
const artifact = ['--artifact', '/fixture/release.tar.gz', '--sha256', hash, '--signing-key', '/fixture/release.key', '--key-id', 'release-2026']
const dependency = ['--dependency-receipt', '/fixture/runtime.json', '--dependency-sha256', 'b'.repeat(64)]
const reject = (args: string[], code: string) => {
  try { parseLifecycleArgs(args) } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError)
    expect((error as InstanceType<typeof CliUsageError>).code).toBe(code)
    return
  }
  throw new Error('Expected the parser to reject the request')
}

describe('lifecycle command boundary: source contracts, not native qualification', () => {
  it.each(['version', 'status', 'doctor'])('keeps %s read-only', command => {
    expect(parseLifecycleArgs([command])).toEqual({ schemaVersion: 1, command, mode: 'read', json: false, assumeYes: false })
  })

  it.each(['install', 'adopt', 'update', 'upgrade', 'recover', 'uninstall'])('defaults %s to a plan', command => {
    const request = parseLifecycleArgs([command])
    expect(request).toMatchObject({ command, mode: 'plan', assumeYes: false })
    expect(Object.isFrozen(request)).toBe(true)
  })

  it('keeps check, compatible update, major upgrade and recovery requests distinct', () => {
    expect(parseLifecycleArgs(['update', '--check', '--json'])).toMatchObject({ command: 'update', mode: 'check', json: true })
    expect(parseLifecycleArgs(['update', '--apply', '--yes', ...artifact])).toMatchObject({ command: 'update', mode: 'apply' })
    expect(parseLifecycleArgs(['upgrade', '--apply', '--yes', ...artifact])).toMatchObject({ command: 'upgrade', mode: 'apply' })
    expect(parseLifecycleArgs(['recover', '--apply', '--yes'])).toMatchObject({ command: 'recover', mode: 'apply' })
    expect(parseLifecycleArgs(['rollback-release', '--release=1.2.3'])).toMatchObject({ command: 'rollback-release', targetRelease: '1.2.3', mode: 'plan' })
  })

  it('parses authenticated archive input without upgrading diagnostic receipts into authority', () => {
    const request = parseLifecycleArgs(['verify-install-ready', ...artifact, '--artifact-dir=/fixture/tree', ...dependency])
    expect(request).toEqual({ schemaVersion: 1, command: 'verify-install-ready', mode: 'read', json: false, assumeYes: false,
      artifact: { path: '/fixture/release.tar.gz', expectedArchiveSha256: hash, signingKeyPath: '/fixture/release.key', keyId: 'release-2026' },
      artifactDir: '/fixture/tree', dependencyReceipt: { path: '/fixture/runtime.json', expectedSha256: 'b'.repeat(64) } })
    expect(Object.isFrozen(request.artifact)).toBe(true)
    expect(Object.isFrozen(request.dependencyReceipt)).toBe(true)
    expect(request).not.toHaveProperty('installReady')
    expect(HELP).toContain('never authority to apply')
    expect(parseLifecycleArgs(['verify-install-ready', ...artifact, '--artifact-dir=/fixture/tree'])).not.toHaveProperty('dependencyReceipt')
  })

  it.each([
    [['upgrade', '--apply'], 'APPLY_REQUIRES_YES'],
    [['upgrade', '--apply', '--yes'], 'ARTIFACT_PROOF_REQUIRED'],
    [['adopt', '--apply', '--yes'], 'ARTIFACT_PROOF_REQUIRED'],
    [['uninstall', '--yes'], 'YES_REQUIRES_APPLY'],
    [['upgrade', '--check'], 'CHECK_NOT_SUPPORTED'],
    [['status', '--plan'], 'MODE_NOT_SUPPORTED'],
    [['update', '--plan', '--apply', '--yes'], 'CONFLICTING_MODES'],
    [['status', '--json', '--json'], 'DUPLICATE_OPTION'],
    [['status', '--json=true'], 'BOOLEAN_OPTION_VALUE'],
    [['uninstall', '--purge'], 'UNKNOWN_OPTION'],
    [['install', '--runtime=/fixture/backend.mjs'], 'UNKNOWN_OPTION'],
    [['install', '--producer=fixture'], 'UNKNOWN_OPTION'],
    [['status', ...artifact], 'ARTIFACT_NOT_SUPPORTED'],
    [['update', '--artifact=x'], 'INCOMPLETE_ARTIFACT_PROOF'],
    [['verify-install-source', ...artifact], 'ARTIFACT_DIRECTORY_REQUIRED'],
    [['verify-install-source', '--artifact-dir=/fixture/tree'], 'ARTIFACT_PROOF_REQUIRED'],
    [['install', ...artifact, '--artifact-dir=/fixture/tree'], 'ARTIFACT_DIRECTORY_NOT_SUPPORTED'],
    [['status', ...dependency], 'DEPENDENCY_RECEIPT_NOT_SUPPORTED'],
    [['update', '--dependency-receipt=x'], 'INCOMPLETE_DEPENDENCY_RECEIPT'],
    [['update', '--dependency-receipt=x', '--dependency-sha256=no'], 'INVALID_DEPENDENCY_SHA256'],
    [['install', '--artifact=x', '--sha256=no', '--signing-key=y', '--key-id=z'], 'INVALID_ARCHIVE_SHA256'],
    [['install', '--artifact=x', `--sha256=${hash}`, '--signing-key=y', '--key-id=../key'], 'INVALID_KEY_ID'],
    [['rollback-release'], 'RELEASE_REQUIRED'],
    [['rollback-release', '--release=01.2.3'], 'INVALID_RELEASE'],
    [['rollback-release', '--release=9007199254740992.0.0'], 'INVALID_RELEASE'],
    [['rollback-release', '--release=1.2.3-beta'], 'INVALID_RELEASE'],
    [['status', '--release=1.2.3'], 'RELEASE_NOT_SUPPORTED'],
    [['status', 'extra'], 'EXTRA_POSITIONAL_ARGUMENT'],
    [['status\nprivate'], 'INVALID_ARGUMENT'],
    [['--'], 'UNKNOWN_OPTION'],
    [['status', '--help', '--apply'], 'HELP_OPTION_CONFLICT'],
    [['status', '--version'], 'VERSION_OPTION_CONFLICT'],
    [['unrecognized'], 'UNKNOWN_COMMAND'],
  ] as Array<[string[], string]>)('rejects unsafe or ambiguous arguments %#', (args, code) => reject(args, code))

  it('normalizes hashes while preserving input paths for the native validator', () => {
    expect(parseLifecycleArgs(['install', '--artifact=relative path/archive', `--sha256=${hash.toUpperCase()}`, '--signing-key=relative key', '--key-id=release']).artifact).toEqual({ path: 'relative path/archive', expectedArchiveSha256: hash, signingKeyPath: 'relative key', keyId: 'release' })
    reject(Array.from({ length: 41 }, () => '--json'), 'INVALID_ARGUMENT')
  })

  it('retains official persisted job references and drops internal IDs, private paths and raw errors', () => {
    const clean = publicLifecycleResult({ exitCode: 0, code: 'LIFECYCLE_STATUS', outcome: 'read', message: '/private/error',
      details: { officialReference: 'XP-JOB-2026-000001', operationId: '123e4567-e89b-42d3-a456-426614174000', path: '/private/state', stderr: 'secret', status: 'retirement_pending', installReady: false } }, 'read')
    expect(clean).toEqual({ exitCode: 0, code: 'LIFECYCLE_STATUS', outcome: 'read', message: 'Lifecycle command completed.', details: { officialReference: 'XP-JOB-2026-000001', status: 'retirement_pending', installReady: false } })
    expect(JSON.stringify(clean)).not.toMatch(/private|secret|123e4567/)
    expect(publicLifecycleResult({ exitCode: 0, code: 'LIFECYCLE_STATUS', outcome: 'read', details: { officialReference: null } }).details).toEqual({ officialReference: null })
    expect(publicLifecycleResult({ exitCode: 0, code: 'LIFECYCLE_STATUS', outcome: 'read', details: { officialReference: 'XP-LC-2026-000001' } })).not.toHaveProperty('details')
  })

  it('rejects impossible success envelopes instead of relabeling them as committed', () => {
    expect(publicLifecycleResult({ exitCode: 0, code: 'SUCCESS', outcome: 'planned' }, 'apply')).toMatchObject({ exitCode: 6, code: 'INVALID_RUNTIME_OUTCOME', outcome: 'attention' })
    for (const result of [null, { exitCode: 0, code: 'x/private', outcome: 'committed' }, { exitCode: 6, code: 'ATTENTION', outcome: 'committed' }]) expect(publicLifecycleResult(result)).toMatchObject({ exitCode: 6, outcome: 'attention' })
  })

  it('provides help and version without importing the native runtime or requiring root', async () => {
    const text: string[] = [], streams = { stdout: { write: (value: string) => text.push(value) }, stderr: { write: (value: string) => text.push(value) } }
    expect(await runLifecycleCli(['help'], streams)).toBe(0)
    expect(text.join('')).toContain('Usage: xpanel-ctl')
    text.length = 0
    expect(await runLifecycleCli(['version', '--json'], streams)).toBe(0)
    expect(JSON.parse(text.join(''))).toMatchObject({ exitCode: 0, code: 'CLI_VERSION', details: { commandSchema: 1, requiredNodeVersion: '26.12.1' } })
  })

  it('refuses apply on a non-Linux machine without loading host modules', () => {
    if (process.platform === 'linux') return
    const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/xpanel-ctl.mjs'), 'recover', '--apply', '--yes', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 10_000, windowsHide: true })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ code: 'ROOT_LINUX_REQUIRED', outcome: 'blocked' })
    expect(result.stderr).toBe('')
  })

  it('keeps shell wrappers small and data-preserving with one canonical dispatcher', () => {
    const wrapper = readFileSync(resolve(root, 'bin/xpanel-ctl'), 'utf8')
    expect(wrapper).toContain('unset NODE_OPTIONS NODE_PATH')
    expect(wrapper).toContain('NODE=/usr/bin/node')
    expect(wrapper).toContain('trusted "$CLI"')
    expect(wrapper).not.toMatch(/source |\beval\b|rm -|curl |wget |XPANEL_NODE_BIN/)
    for (const command of ['update', 'upgrade', 'uninstall']) {
      const text = readFileSync(resolve(root, `scripts/${command}.sh`), 'utf8')
      expect(text).toContain(`exec /bin/bash "$ROOT/bin/xpanel-ctl" ${command} "$@"`)
      expect(text).not.toMatch(/rm -|source |\beval\b|systemctl|curl |wget /)
    }
  })
})
