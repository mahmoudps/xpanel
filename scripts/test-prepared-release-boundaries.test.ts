import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { assertPreparedReleaseCurrent, parsePreparedReleaseInput, preparedReleaseInfo } from './prepared-release.mjs'
import { observePreparedAdoptionSource } from './install-bootstrap.mjs'
import { parseNativeInstallFinalizationRequest, parseNativePreparedAdoptionRequest, assertInstallAdoptionReadinessScope, installOwnershipCompletionSummary } from './install-finalization-native.mjs'
import { captureInstallAdoptionReadiness } from './install-finalization-readiness.mjs'
import { runAcquireLifecycleRelease } from './acquire-lifecycle-release.mjs'

const artifact = { path: '/root/releases/xpanel-0.1.1.tar.gz', expectedArchiveSha256: 'a'.repeat(64), keyId: 'archive-key', signingKeyPath: '/etc/xpanel/release-hmac.key' }
const request = { schemaVersion: 1, command: 'adopt', mode: 'apply', json: true, assumeYes: true, artifact }

describe('prepared helper boundaries; portable checks are not native qualification', () => {
  it('accepts only the bounded artifact selector and no caller-provided trust, runtime, receipt or authority', () => {
    const input = { artifactPath: artifact.path, expectedArchiveSha256: artifact.expectedArchiveSha256 }
    assert.deepEqual(parsePreparedReleaseInput(input), input)
    for (const extra of ['trustPath', 'runtime', 'receipt', 'capability', 'provider', 'allowPopulated']) {
      assert.throws(() => parsePreparedReleaseInput({ ...input, [extra]: {} }), /PREPARED_RELEASE_INPUT_INVALID/)
    }
    for (const path of ['/tmp/source.tar.gz', '/home/owner/source.tar.gz', '/root/../root/source.tar.gz', '/root/source.tar.gz\n', 'source.tar.gz']) {
      assert.throws(() => parsePreparedReleaseInput({ ...input, artifactPath: path }), /PREPARED_RELEASE_INPUT_INVALID/)
    }
  })

  it('records populated adoption without describing it as a fresh installation', () => {
    assert.equal(installOwnershipCompletionSummary('adopt'), 'Observed populated-installation adoption finalized')
    assert.equal(installOwnershipCompletionSummary('install'), 'Observed fresh-install ownership finalized')
    assert.throws(() => installOwnershipCompletionSummary('upgrade' as never), /INSTALL_FINALIZATION_KIND_INVALID/)
  })

  it('keeps fresh install grammar separate from the explicit adoption command', () => {
    assert.deepEqual(parseNativePreparedAdoptionRequest(request), request)
    assert.throws(() => parseNativeInstallFinalizationRequest(request), /INSTALL_FINALIZATION_REQUEST_INVALID/)
    const fresh = { ...request, command: 'install' }
    assert.deepEqual(parseNativeInstallFinalizationRequest(fresh), fresh)
    assert.throws(() => parseNativePreparedAdoptionRequest(fresh), /INSTALL_FINALIZATION_REQUEST_INVALID/)
    for (const value of [{ ...request, assumeYes: false }, { ...request, mode: 'plan' }, { ...request, helperIdentity: {} }, { ...request, allowPopulated: true }]) {
      assert.throws(() => parseNativePreparedAdoptionRequest(value), /INSTALL_FINALIZATION_REQUEST_INVALID/)
    }
  })

  it('rejects copied receipts and ready-shaped data before any native prepared or adoption access', async () => {
    for (const capability of [null, {}, Object.freeze({}), { schemaVersion: 1, kind: 'xpanel-prepared-release', live: true, root: true }]) {
      assert.throws(() => preparedReleaseInfo(capability), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      await assert.rejects(assertPreparedReleaseCurrent(capability), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      await assert.rejects(observePreparedAdoptionSource(capability), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      await assert.rejects(assertInstallAdoptionReadinessScope(capability, {}, 'capturing'), /INSTALL_ADOPTION_NATIVE_SCOPE_REQUIRED/)
      await assert.rejects(captureInstallAdoptionReadiness(capability, {} as never, 'a'.repeat(64)), /INSTALL_ADOPTION_NATIVE_SCOPE_REQUIRED/)
    }
  })

  it('bounds invalid acquisition CLI output and does not report preparation on refusal', async () => {
    const stdout: string[] = [], stderr: string[] = []
    const result = await runAcquireLifecycleRelease(['--artifact=unexpected'], { stdout: { write: (s: string) => { stdout.push(s) } }, stderr: { write: (s: string) => { stderr.push(s) } } })
    assert.equal(result, 3); assert.deepEqual(stdout, [])
    assert.deepEqual(JSON.parse(stderr.join('')), { status: 'blocked', code: 'PREPARED_ACQUISITION_ARGUMENTS_INVALID', preservePreparedState: true, installReady: false })
  })
})

// Execute the actual directory-pin function with isolated filesystem observations, never native authority.
describe('installed state-directory images and retained mode pins', () => {
  const source = readFileSync(new URL('./install-finalization-native.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export async function withInstallFinalizationStateDirectories(')
  const end = source.indexOf('\nasync function processIdentity()', start)
  assert(start >= 0 && end > start)
  function fixture(parentMode: number) {
    let mode = parentMode, uid = 111n, symlink = false, closed = 0
    const stat = (path: string) => ({ uid, gid: 222n, dev: 1n, ino: path.endsWith('/state') ? 3n : 2n,
      mode: BigInt(path.endsWith('/state') ? 0o2750 : mode), isDirectory: () => true, isSymbolicLink: () => symlink })
    const check = (value: unknown, code: string) => { if (!value) throw new Error(code) }
    const run = new Function('check', 'withTrustedDirectory', 'STATE', 'lstat', 'realpath', 'open', 'constants',
      source.slice(start, end).replace('export async function', 'async function') + '\nreturn withInstallFinalizationStateDirectories')(
      check, async (_: string, callback: (value: unknown) => Promise<unknown>) => callback({ verify: async () => {} }),
      '/var/lib/xpanel/state', async (path: string) => stat(path), async (path: string) => path,
      async (path: string) => ({ stat: async () => stat(path), close: async () => { closed++ } }),
      { O_RDONLY: 0, O_DIRECTORY: 1, O_NOFOLLOW: 2 },
    ) as (uid: number, gid: number, callback: (pins: { verify(): Promise<void> }) => Promise<void>) => Promise<void>
    return { run, narrow: () => { mode = 0o2750 }, widen: () => { mode = 0o2770 }, wrongOwner: () => { uid = 0n },
      symlink: () => { symlink = true }, closed: () => closed }
  }
  it('accepts exactly the legacy and protected installed parent images without changing either', async () => {
    for (const mode of [0o2770, 0o2750]) {
      const f = fixture(mode)
      await f.run(111, 222, async pins => { await pins.verify() })
      assert.equal(f.closed(), 2)
    }
    for (const mode of [0o2777, 0o0770, 0o0750, 0o2700, 0o2775]) {
      const f = fixture(mode)
      await assert.rejects(f.run(111, 222, async () => {}), /INSTALL_STATE_DIRECTORY_UNSAFE/)
    }
  })
  it('rejects mode changes even between approved images, ownership drift and symlink replacement', async () => {
    for (const change of ['narrow', 'widen', 'wrongOwner', 'symlink'] as const) {
      const f = fixture(change === 'widen' ? 0o2750 : 0o2770)
      await assert.rejects(f.run(111, 222, async pins => { f[change](); await pins.verify() }), /INSTALL_STATE_DIRECTORY_CHANGED/)
      assert.equal(f.closed(), 2)
    }
  })
})

// Test the exact private visibility predicate in an isolated namespace. Its objects are never registered
// in the native module's WeakMap and cannot mint an actual prepared capability.
describe('isolated prepared-scope ancestor visibility', () => {
  const source = readFileSync(new URL('./install-bootstrap.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('function preparedScope(capability) {'), end = source.indexOf('\n}\n', start)
  assert(start >= 0 && end > start)
  type Scope = { live: boolean; pid: number; parent: Scope | null }
  function fixture() {
    const scopes = new WeakMap<object, Scope>(), active = new AsyncLocalStorage<Scope>()
    const check = (value: unknown, code: string) => { if (!value) throw new Error(code) }
    const select = new Function('preparedScopes', 'preparedActive', 'check', 'process', source.slice(start, end + 3) + '\nreturn preparedScope')(scopes, active, check, { pid: 42 }) as (capability: unknown) => Scope
    const parent: Scope = { live: true, pid: 42, parent: null }, child: Scope = { live: true, pid: 42, parent }, sibling: Scope = { live: true, pid: 42, parent: null }
    const parentKey = {}, childKey = {}, siblingKey = {}
    scopes.set(parentKey, parent); scopes.set(childKey, child); scopes.set(siblingKey, sibling)
    return { active, select, parent, child, sibling, parentKey, childKey, siblingKey }
  }

  it('allows a held helper ancestor under a nested target while rejecting unrelated live capabilities', async () => {
    const f = fixture()
    await f.active.run(f.child, async () => {
      assert.equal(f.select(f.parentKey), f.parent); assert.equal(f.select(f.childKey), f.child)
      assert.throws(() => f.select(f.siblingKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      await Promise.all([
        f.active.run(f.sibling, async () => { await Promise.resolve(); assert.throws(() => f.select(f.parentKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/) }),
        Promise.resolve().then(() => assert.equal(f.select(f.parentKey), f.parent)),
      ])
    })
    assert.throws(() => f.select(f.parentKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
  })

  it('refuses retired links, detached scope chains and a different process lifetime', async () => {
    const f = fixture()
    await f.active.run(f.child, async () => {
      f.parent.live = false; assert.throws(() => f.select(f.parentKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      f.parent.live = true; f.child.pid = 43; assert.throws(() => f.select(f.parentKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
      f.child.pid = 42; f.child.parent = null; assert.throws(() => f.select(f.parentKey), /PREPARED_RELEASE_CAPABILITY_REQUIRED/)
    })
  })
})
