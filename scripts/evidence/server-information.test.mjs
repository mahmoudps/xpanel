import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computeSourceDigest, REQUIRED_PROFILES, sha256, SOURCE_ALGORITHM } from './shared.mjs'
import { isMain } from './cli.mjs'
import { compareServerInformation, pinnedLookup, SERVER_INFORMATION_ACCEPTANCE, SERVER_INFORMATION_HTTP_IDS, SERVER_INFORMATION_REQUIREMENTS, SERVER_INFORMATION_UNIT_IDS, validateServerInformationOrigin, withinOnePercent } from './server-information-contract.mjs'
import { diskFromStatfs, parseMountInventory, parseObservedOsRelease } from './server-information-observer.mjs'
import { authenticatedSession } from './server-information-https.mjs'
import { parseProcStartTicks, validateInstalledBinding } from './server-information-installed.mjs'
import { receiptsForServerInformation } from './server-information-runner.mjs'

function metrics() {
  const mounts = ['/', '/proc', '/run'], hash = sha256('stable mount inventory')
  const disks = mounts.map(mount => ({ mount, totalBytes: mount === '/proc' ? 0 : 10_000, usedBytes: mount === '/proc' ? 0 : 5000, availableBytes: mount === '/proc' ? 0 : 4500 }))
  const observed = { cpu: { model: 'Example CPU', cores: 4 }, memory: { totalBytes: 100_000 }, disks: structuredClone(disks), mountInfoSha256: hash }
  const api = { identity: { model: 'Example CPU', cores: 4 }, memory: { totalBytes: 100_000 }, disks, disk: disks[0], diskCoverage: { status: 'complete', source: 'df', inventorySource: 'proc-self-mountinfo', mounts, unavailableMounts: [], unexpectedMounts: [], mountInfoSha256: hash } }
  return { api, before: structuredClone(observed), after: structuredClone(observed) }
}

function target() {
  const files = [{ path: 'pnpm-lock.yaml', bytes: 4, sha256: sha256('lock') }]
  const source = { algorithm: SOURCE_ALGORITHM, commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, sourceFingerprint: computeSourceDigest(files), files, lockfileSha256: files[0].sha256, node: '26.12.1' }
  const target = { sourceFingerprint: source.sourceFingerprint, artifactSha256: sha256('artifact'), supportedProfiles: [...REQUIRED_PROFILES] }
  const provenance = { schemaVersion: 1, kind: 'xpanel-artifact-provenance', source: { algorithm: source.algorithm, commit: source.commit, sourceFingerprint: source.sourceFingerprint }, artifact: { sha256: target.artifactSha256, bytes: 8 } }
  return { schemaVersion: 1, kind: 'xpanel-verification-target', source, target, provenance: { sha256: sha256(JSON.stringify(provenance)), document: provenance } }
}

const failures = value => compareServerInformation(value.api, value.before, value.after).filter(check => check.status !== 'passed').map(check => check.id)

export function registerServerInformationTests(test) {
  test('SI-UNIT-CRITERION-CONTRACT', () => {
    const specs = readFileSync(fileURLToPath(new URL('../../packages/catalog/src/data/specs.ts', import.meta.url)), 'utf8')
    const item = specs.slice(specs.indexOf('"id": "server-information"')).split('"absorbed"')[0]
    assert.ok(item.includes(JSON.stringify(SERVER_INFORMATION_ACCEPTANCE)))
    assert.equal(SERVER_INFORMATION_UNIT_IDS.length, 15)
    assert.equal(SERVER_INFORMATION_REQUIREMENTS[0].checks.http.length, 12)
  })

  test('SI-UNIT-TOLERANCE-BOUNDARY', () => {
    assert.equal(withinOnePercent(10100, 10000), true)
    assert.equal(withinOnePercent(10101, 10000), false)
    assert.equal(withinOnePercent(0, 0), true)
    assert.equal(withinOnePercent(1, 0), false)
    assert.equal(withinOnePercent(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), true)
    assert.equal(withinOnePercent(Number.POSITIVE_INFINITY, 1), false)
    assert.equal(withinOnePercent(-1, 1), false)
  })

  test('SI-UNIT-CPU-IDENTITY', () => {
    const value = metrics(); value.api.identity.model = ' Example   CPU '
    assert.deepEqual(failures(value), [])
    value.api.identity.cores = 3
    assert.deepEqual(failures(value), ['SI-CPU-CORES'])
    value.api.identity.model = 'Different CPU'
    assert.ok(failures(value).includes('SI-CPU-MODEL'))
  })

  test('SI-UNIT-ALL-MOUNTS', () => {
    const value = metrics()
    assert.deepEqual(failures(value), [])
    value.api.disks.pop()
    assert.ok(failures(value).includes('SI-MOUNT-INVENTORY'))
    const extra = metrics(); extra.api.disks.push({ mount: '/unobserved', totalBytes: 0, usedBytes: 0, availableBytes: 0 })
    assert.ok(failures(extra).includes('SI-MOUNT-INVENTORY'))
  })

  test('SI-UNIT-ROOT-ONLY-REFUSAL', () => {
    const value = metrics(); delete value.api.disks
    assert.deepEqual(failures(value), ['SI-MOUNT-INVENTORY', 'SI-MOUNT-USAGE'])
    const missingCoverage = metrics(); delete missingCoverage.api.diskCoverage
    assert.ok(failures(missingCoverage).includes('SI-MOUNT-INVENTORY'))
  })

  test('SI-UNIT-TOPOLOGY-STABILITY', () => {
    const value = metrics(); value.after.mountInfoSha256 = sha256('changed namespace')
    assert.ok(failures(value).includes('SI-MOUNT-INVENTORY'))
    const incomplete = metrics(); incomplete.api.diskCoverage.unavailableMounts.push('/proc')
    assert.ok(failures(incomplete).includes('SI-MOUNT-INVENTORY'))
  })

  test('SI-UNIT-BRACKET-METRICS', () => {
    const value = metrics(); value.after.disks[0].usedBytes = 6000
    assert.ok(failures(value).includes('SI-MOUNT-USAGE'), 'large volatility cannot hide an inaccurate intermediate API value')
    const invalid = metrics(); invalid.api.disks[0].totalBytes = 0
    assert.ok(failures(invalid).includes('SI-MOUNT-INVENTORY'))
  })

  test('SI-UNIT-MOUNT-PARSER', () => {
    const raw = '20 1 8:1 / / rw - ext4 /dev/example rw\n21 20 0:3 / /proc rw - proc proc rw\n22 20 8:1 /a /a\\040b rw - ext4 /dev/example rw\n23 20 8:1 /b /a\\040b rw - ext4 /dev/example rw\n'
    assert.deepEqual(parseMountInventory(raw), ['/', '/a b', '/proc'])
    assert.throws(() => parseMountInventory('malformed'))
  })

  test('SI-UNIT-STATFS-ACCOUNTING', () => {
    assert.deepEqual(diskFromStatfs('/data', { bsize: 4096n, blocks: 100n, bfree: 40n, bavail: 35n }), { mount: '/data', totalBytes: 409600, usedBytes: 245760, availableBytes: 143360 })
    assert.throws(() => diskFromStatfs('/', { bsize: 4096n, blocks: 10n, bfree: 11n, bavail: 5n }))
    assert.throws(() => diskFromStatfs('/', { bsize: 4096n, blocks: 2n ** 63n, bfree: 0n, bavail: 0n }))
  })

  test('SI-UNIT-OS-PROFILES', () => {
    assert.deepEqual(parseObservedOsRelease('NAME="CentOS Stream"\nID="centos"\nVERSION_ID="9"\n'), { id: 'centos', versionId: '9', name: 'CentOS Stream' })
    assert.throws(() => parseObservedOsRelease('NAME="CentOS Linux"\nID="centos"\nVERSION_ID="9"\n'))
  })

  test('SI-UNIT-TLS-ORIGIN', () => {
    assert.equal(validateServerInformationOrigin('https://panel.example:2087'), 'https://panel.example:2087')
    for (const origin of ['http://panel.example', 'https://user:secret@panel.example', 'https://panel.example/api/server/info', 'https://panel.example/?query=1']) assert.throws(() => validateServerInformationOrigin(origin))
  })

  test('SI-UNIT-DNS-LOOKUP', () => {
    const lookup = pinnedLookup('127.0.0.1', 4)
    lookup('panel.example', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '127.0.0.1', family: 4 }]) })
    lookup('panel.example', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '127.0.0.1'); assert.equal(family, 4) })
  })

  test('SI-UNIT-SESSION-AUDIENCE', () => {
    const value = { status: 200, data: { principal: { kind: 'root' }, entryPoint: 'xwhm', csrfToken: 'synthetic-csrf', passwordChangeRequired: false }, setCookie: ['__Host-xwhm_session=synthetic-session; Path=/; HttpOnly; Secure; SameSite=Strict'] }
    assert.equal(authenticatedSession(value).cookie, '__Host-xwhm_session=synthetic-session')
    assert.throws(() => authenticatedSession({ ...value, data: { ...value.data, entryPoint: 'xpanel' } }))
    assert.throws(() => authenticatedSession({ ...value, setCookie: ['__Host-xwhm_session=synthetic-session; Path=/; HttpOnly; SameSite=Strict'] }))
    assert.throws(() => authenticatedSession({ ...value, data: { ...value.data, principal: { kind: 'reseller' } } }))
  })

  test('SI-UNIT-INSTALLED-BINDING', () => {
    const document = target(), item = { pid: 101, uid: 999, startTicks: '100', commandSha256: sha256('command'), executableSha256: sha256('node') }
    const binding = { schemaVersion: 1, kind: 'xpanel-server-information-installed-binding', target: document.target, sourceAlgorithm: document.source.algorithm, commit: document.source.commit, profile: 'ubuntu-24.04', releaseRoot: '/opt/xpanel/releases/example', manifestSha256: sha256('manifest'), bootId: 'a'.repeat(36), qualificationAdmission: 'existing-host-probes', roles: { api: item, agent: { ...item, pid: 102, uid: 0 } } }
    validateInstalledBinding(binding, document)
    assert.throws(() => validateInstalledBinding({ ...binding, target: { ...binding.target, artifactSha256: sha256('different') } }, document))
    assert.throws(() => validateInstalledBinding({ ...binding, profile: 'unmeasured' }, document))
    const stat = `101 (a process (name)) S ${Array.from({ length: 18 }, () => '0').join(' ')} 12345 0 0`
    assert.equal(parseProcStartTicks(stat), '12345')
  })

  test('SI-UNIT-TWO-SLOT-RECEIPTS', () => {
    const document = target()
    const report = { schemaVersion: 1, status: 'passed', proofExecuted: true, runId: 'synthetic-unit-contract', profile: 'ubuntu-24.04', target: document.target, sourceAlgorithm: document.source.algorithm, commit: document.source.commit, startedAt: '2026-10-29T00:00:00Z', finishedAt: '2026-10-29T00:00:01Z', runtime: { node: 'v26.12.1', platform: 'linux', profile: 'ubuntu-24.04' }, host: { osRelease: { id: 'ubuntu', versionId: '24.04', name: 'Ubuntu' } }, checks: SERVER_INFORMATION_HTTP_IDS.map(id => ({ id, status: 'passed', observed: true })), cleanup: { ok: true, errors: [], leftovers: { sessions: [] } }, coveredSlots: [{ stage: 'integrated', environment: 'http' }, { stage: 'verified', environment: 'linux' }] }
    const bytes = Buffer.from(JSON.stringify(report))
    assert.deepEqual(receiptsForServerInformation(report, document, slot => `${slot.environment}.report.json`, bytes).map(item => item.environment), ['http', 'linux'])
    assert.throws(() => receiptsForServerInformation({ ...report, status: 'blocked' }, document, () => 'report.json', bytes))
    const forged = { ...report, coveredSlots: [{ stage: 'verified', environment: 'browser' }, { stage: 'verified', environment: 'linux' }] }
    assert.throws(() => receiptsForServerInformation(forged, document, () => 'report.json', Buffer.from(JSON.stringify(forged))))
  })
}

if (isMain(import.meta.url)) registerServerInformationTests(nodeTest)
