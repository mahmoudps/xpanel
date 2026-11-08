import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, open, readFile, readlink, realpath, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { withCoordinatorDatabaseAuthority } from './coordinator-install.mjs'
import { observePreparedAdoptionSource } from './install-bootstrap.mjs'
import { assertPreparedReleaseCurrent, preparedReleaseInfo, withExistingPreparedRelease, parsePreparedReleaseInput } from './prepared-release.mjs'
import { requireLinuxRoot, assertOwnedFile, readInstallationReceipt, readTrustedFile, withTrustedFile } from './lifecycle-ownership.mjs'
import { COORDINATOR_PATHS as P, renderCoordinatorUnit, parseCoordinatorOwnership, coordinatorHelperFromPrepared, withVerifiedCoordinatorOwnership, coordinatorOwnershipInfo } from './coordinator-ownership.mjs'
import { captureManagedFile, managedPathAbsent, replaceManagedFile } from './lifecycle-managed-files.mjs'

const ROOT = '/var/lib/xpanel-lifecycle', REGISTER = ROOT + '/coordinator-install.json', DATABASE = '/var/lib/xpanel/control.db'
const UNIT = 'xpanel-lifecycle.service', CGROUP = '/sys/fs/cgroup/system.slice/' + UNIT
const SHA = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), json = value => Buffer.from(JSON.stringify(value) + '\n')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const remember = file => ({ entry: file.entry, bytes: file.bytes.toString('base64') })
const bytesOf = image => Buffer.from(image.bytes, 'base64')

/** Syntax only; root/helper/DB/host and source proofs are established independently below. */
export function parseCoordinatorRotationRequest(input) {
  check(input && typeof input === 'object' && !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input))
    && Reflect.ownKeys(input).length === 2 && ['operationId', 'mode'].every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value'))
    && typeof input.operationId === 'string' && UUID.test(input.operationId) && ['apply', 'recover', 'rollback'].includes(input.mode), 'COORDINATOR_ROTATION_REQUEST_INVALID')
  return Object.freeze({ operationId: input.operationId, mode: input.mode })
}

export function classifyCoordinatorRotationImage(actual, oldHash, nextHash) {
  if (![actual, oldHash, nextHash].every(value => typeof value === 'string' && SHA.test(value))) return 'foreign'
  return actual === nextHash ? 'next' : actual === oldHash ? 'previous' : 'foreign'
}

/** A journal resumes or rolls back only under the HEAD and installation it was prepared under. Every upgrade
 * rewrites HEAD before it migrates, so a rotation rollback never returns to a helper over a migrated database. */
export function assertCoordinatorRotationContext(intent, current) {
  check(JSON.stringify(intent?.origin) === JSON.stringify(current.origin) && intent.installedReceiptSha256 === current.installedReceiptSha256
    && intent.headSha256 === current.headSha256, 'COORDINATOR_ROTATION_CONTEXT_CHANGED')
}

function parseJournal(value, operationId) {
  check(value && value.schemaVersion === 1 && value.kind === 'xpanel-coordinator-rotation' && value.operationId === operationId
    && ['prepared', 'quiescing', 'quiescent', 'selecting', 'selected', 'starting', 'verified', 'complete', 'rolled_back'].includes(value.phase)
    && ['next', 'previous'].includes(value.selection) && value.origin?.file === DATABASE && UUID.test(value.origin?.issuerId), 'COORDINATOR_ROTATION_JOURNAL_INVALID')
  for (const [name, path] of [['unit', P.unit], ['receipt', P.receipt], ['registration', REGISTER]]) {
    const old = value.previous?.[name]
    check(old?.entry?.path === path && old.entry.kind === 'file' && typeof old.bytes === 'string'
      && old.entry.mode === (name === 'unit' ? 0o644 : 0o600) && hash(bytesOf(old)) === old.entry.sha256, 'COORDINATOR_ROTATION_PREIMAGE_INVALID')
  }
  const oldReceipt = parseCoordinatorOwnership(JSON.parse(bytesOf(value.previous.receipt)))
  check(value.previous.unit.entry.sha256 === hash(renderCoordinatorUnit(oldReceipt.runtime.nodePath, oldReceipt.helper.releaseRoot))
    && value.next.helper.releaseRoot !== oldReceipt.helper.releaseRoot && value.next.runtime.nodePath === oldReceipt.runtime.nodePath
    && value.next.runtime.nodeSha256 === oldReceipt.runtime.nodeSha256 && value.next.unitSha256 === hash(renderCoordinatorUnit(value.next.runtime.nodePath, value.next.helper.releaseRoot)), 'COORDINATOR_ROTATION_SOURCE_INVALID')
  parsePreparedReleaseInput({ artifactPath: value.next.helper.archivePath, expectedArchiveSha256: value.next.helper.archiveSha256 })
  for (const list of [value.publication ?? [], value.previousPublication ?? []]) {
    check(Array.isArray(list) && list.length <= 2 && new Set(list.map(item => item.path)).size === list.length, 'COORDINATOR_ROTATION_PUBLICATION_INVALID')
    for (const image of list) check([P.receipt, REGISTER].includes(image?.path) && typeof image.bytes === 'string'
      && image.bytes.length <= 128 * 1024 && hash(bytesOf(image)) === image.sha256, 'COORDINATOR_ROTATION_PUBLICATION_INVALID')
  }
  if (value.unitCheckpoint) check(value.unitCheckpoint.path === P.unit && value.unitCheckpoint.kind === 'file'
    && value.unitCheckpoint.mode === 0o644 && [value.previous.unit.entry.sha256, value.next.unitSha256].includes(value.unitCheckpoint.sha256), 'COORDINATOR_ROTATION_CHECKPOINT_INVALID')
  return { value, oldReceipt }
}

async function assertImages(scope) {
  const unit = await captureManagedFile(P.unit)
  check(unit.entry.mode === 0o644 && classifyCoordinatorRotationImage(unit.entry.sha256, scope.intent.previous.unit.entry.sha256, scope.intent.next.unitSha256) !== 'foreign', 'COORDINATOR_ROTATION_FOREIGN_UNIT')
  const checkpoint = scope.intent.unitCheckpoint
  if (checkpoint?.sha256 === unit.entry.sha256) await assertOwnedFile(checkpoint)
  else if (!checkpoint && unit.entry.sha256 === scope.intent.previous.unit.entry.sha256) await assertOwnedFile(scope.intent.previous.unit.entry)
  else check(scope.intent.phase === 'selecting', 'COORDINATOR_ROTATION_UNIT_INODE_UNRECORDED')
  for (const [key, path] of [['receipt', P.receipt], ['registration', REGISTER]]) {
    const actual = await captureManagedFile(path), allowed = new Set([scope.intent.previous[key].entry.sha256,
      ...(scope.intent.publication ?? []).filter(image => image.path === path).map(image => image.sha256),
      ...(scope.intent.previousPublication ?? []).filter(image => image.path === path).map(image => image.sha256)])
    check(actual.entry.mode === 0o600 && allowed.has(actual.entry.sha256), 'COORDINATOR_ROTATION_FOREIGN_METADATA')
  }
  await assertOwnedFile(unit.entry)
  return unit.entry
}

async function command(scope, args) {
  await scope.assertAuthority()
  return withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }, async pin => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/proc/self/fd/3', ['--system', '--no-ask-password', '--no-pager', ...args], { cwd: '/', shell: false,
        stdio: ['ignore', 'pipe', 'pipe', pin.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGERSECURE: '1' } })
      let output = '', bytes = 0, uncertain = false, escalation
      const stop = setTimeout(() => { uncertain = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000) }, 30_000)
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) uncertain = true; else output += chunk })
      child.stderr.on('data', chunk => { if (chunk.length) uncertain = true })
      child.once('error', () => { uncertain = true })
      child.once('close', (code, signal) => { clearTimeout(stop); clearTimeout(escalation); if (uncertain || signal || code !== 0) reject(Object.assign(new Error('COORDINATOR_ROTATION_COMMAND_UNCERTAIN'), { code: 'COORDINATOR_ROTATION_COMMAND_UNCERTAIN' })); else resolve(output) })
    })
    await pin.verify(); await scope.assertAuthority(); return result
  })
}

async function cgroupEmpty() {
  let count = 0
  const inspect = async (path, depth) => {
    check(++count <= 64 && depth <= 8, 'COORDINATOR_ROTATION_CGROUP_BUDGET')
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT' && path === CGROUP) return; throw error }
    check(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0, 'COORDINATOR_ROTATION_CGROUP_CHANGED')
    const members = (await readFile(path + '/cgroup.procs', 'utf8')).trim()
    check(members === '', 'COORDINATOR_ROTATION_CHILDREN_REMAIN')
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await inspect(path + '/' + entry.name, depth + 1)
    check((await readFile(path + '/cgroup.procs', 'utf8')).trim() === '', 'COORDINATOR_ROTATION_CHILDREN_REMAIN')
  }
  await inspect(CGROUP, 0)
}

async function observe(scope) {
  const shown = await command(scope, ['show', UNIT, '--property=MainPID,ControlPID,ControlGroup,FragmentPath,DropInPaths,User,Group,ActiveState,LoadState'])
  const value = Object.fromEntries(shown.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
  check(value.LoadState === 'loaded' && value.FragmentPath === P.unit && !value.DropInPaths && value.ControlPID === '0'
    && ['', 'root', '0'].includes(value.User) && ['', 'root', '0'].includes(value.Group), 'COORDINATOR_ROTATION_SERVICE_UNOWNED')
  if (value.MainPID === '0') {
    check(value.ActiveState === 'inactive' || value.ActiveState === 'failed', 'COORDINATOR_ROTATION_SERVICE_UNCERTAIN')
    await cgroupEmpty(); return { state: 'quiescent' }
  }
  check(value.ActiveState === 'active' && /^[1-9][0-9]*$/.test(value.MainPID) && value.ControlGroup === '/system.slice/' + UNIT, 'COORDINATOR_ROTATION_SERVICE_UNCERTAIN')
  const pid = Number(value.MainPID)
  check(pid !== process.pid, 'COORDINATOR_ROTATION_EXTERNAL_ROOT_REQUIRED')
  const [status, stat, cgroup, executable, cwd, argv] = await Promise.all([readFile(`/proc/${pid}/status`, 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/cgroup`, 'utf8'), readlink(`/proc/${pid}/exe`), realpath(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/cmdline`, 'utf8')])
  const source = [scope.oldReceipt.helper.releaseRoot, scope.next.releaseRoot].find(root => cwd === root
    && JSON.stringify(argv.split('\0').filter(Boolean)) === JSON.stringify([scope.next.runtime.nodePath, root + '/apps/agent/src/ops-upgrade-native.ts']))
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
  check(source && /^[0-9]+$/.test(start ?? '') && /^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) && /^Gid:\s+0\s+0\s+0\s+0\s*$/m.test(status)
    && executable === await realpath(scope.next.runtime.nodePath) && cgroup.trim() === '0::/system.slice/' + UNIT, 'COORDINATOR_ROTATION_PROCESS_UNOWNED')
  await scope.assertAuthority()
  return { state: 'active', pid, start, source }
}

async function persist(scope, patch) {
  const value = { ...scope.intent, ...patch }
  const written = await replaceManagedFile(scope.path, json(value), 0o600, scope.journal?.entry ?? null, scope.assertAuthority)
  scope.intent = value; scope.journal = written
}

async function quiesce(scope) {
  const unit = await assertImages(scope)
  const before = await observe(scope)
  await assertOwnedFile(unit)
  await persist(scope, { phase: 'quiescing', previousProcess: before, unitCheckpoint: unit })
  if (before.state === 'active') await command(scope, ['stop', UNIT])
  const after = await observe(scope)
  check(after.state === 'quiescent', 'COORDINATOR_ROTATION_NOT_QUIESCENT')
  await cgroupEmpty(); await scope.assertAuthority()
  await persist(scope, { phase: 'quiescent' })
}

async function select(scope, selection) {
  await quiesce(scope)
  await persist(scope, { phase: 'selecting', selection })
  const assertQuiescent = async () => { await scope.assertAuthority(); check((await observe(scope)).state === 'quiescent', 'COORDINATOR_ROTATION_NOT_QUIESCENT') }
  const root = selection === 'next' ? scope.next.releaseRoot : scope.oldReceipt.helper.releaseRoot
  const unitBytes = Buffer.from(renderCoordinatorUnit(scope.next.runtime.nodePath, root))
  let unit = await captureManagedFile(P.unit)
  check(classifyCoordinatorRotationImage(unit.entry.sha256, scope.intent.previous.unit.entry.sha256, scope.intent.next.unitSha256) !== 'foreign', 'COORDINATOR_ROTATION_FOREIGN_UNIT')
  if (unit.entry.sha256 !== hash(unitBytes)) unit = await replaceManagedFile(P.unit, unitBytes, 0o644, unit.entry, assertQuiescent)
  await persist(scope, { unitCheckpoint: unit.entry })
  const helper = selection === 'next' ? scope.intent.next.helper : scope.oldReceipt.helper
  const receipt = parseCoordinatorOwnership({ ...scope.oldReceipt, helper,
    files: scope.oldReceipt.files.map(file => file.path === P.unit ? unit.entry : file) })
  const registration = { ...JSON.parse(bytesOf(scope.intent.previous.registration)), phase: 'registered', helper,
    receiptSha256: hash(json(receipt)), rotationOperationId: scope.intent.operationId,
    newFiles: [P.privateKey, P.publicKey, P.unit].map(path => { const file = receipt.files.find(item => item.path === path); return { path, sha256: file.sha256, mode: file.mode } }) }
  const images = [{ path: P.receipt, bytes: json(receipt), key: 'receipt' }, { path: REGISTER, bytes: json(registration), key: 'registration' }]
  // Both metadata postimages are durable before either rename. A retry admits only these finite images.
  const previousPublication = scope.intent.publication ?? []
  await persist(scope, { publication: images.map(image => ({ path: image.path, sha256: hash(image.bytes), bytes: image.bytes.toString('base64') })), previousPublication })
  for (const image of images) {
    const actual = await captureManagedFile(image.path), admitted = new Set([scope.intent.previous[image.key].entry.sha256,
      ...scope.intent.publication.filter(item => item.path === image.path).map(item => item.sha256),
      ...scope.intent.previousPublication.filter(item => item.path === image.path).map(item => item.sha256)])
    check(admitted.has(actual.entry.sha256), 'COORDINATOR_ROTATION_FOREIGN_METADATA')
    if (actual.entry.sha256 !== hash(image.bytes)) await replaceManagedFile(image.path, image.bytes, 0o600, actual.entry, assertQuiescent)
    await readTrustedFile(image.path, { exactMode: 0o600, maxBytes: 65536, sha256: hash(image.bytes) })
  }
  await persist(scope, { phase: 'selected', selectedReceiptSha256: hash(json(receipt)) })
  await assertQuiescent()
  await command(scope, ['daemon-reload'])
  await persist(scope, { phase: 'starting' })
  await command(scope, ['start', UNIT])
  const active = await observe(scope)
  check(active.state === 'active' && active.source === root, 'COORDINATOR_ROTATION_START_UNVERIFIED')
  await withVerifiedCoordinatorOwnership(async ownership => {
    const actual = coordinatorOwnershipInfo(ownership)
    check(actual.receiptSha256 === scope.intent.selectedReceiptSha256 && actual.helper.releaseRoot === root, 'COORDINATOR_ROTATION_RECEIPT_UNVERIFIED')
    await scope.assertAuthority()
  })
  await persist(scope, { phase: 'verified', activeProcess: active })
  const after = await observe(scope)
  check(JSON.stringify(after) === JSON.stringify(active), 'COORDINATOR_ROTATION_PROCESS_CHANGED')
  await persist(scope, { phase: selection === 'next' ? 'complete' : 'rolled_back', completedAt: new Date().toISOString() })
  return Object.freeze({ operationId: scope.intent.operationId, status: scope.intent.phase, helperVersion: helper.version, ready: false, ipcQualificationRequired: true })
}

/** Product root-operator path. Only the fixed coordinator unit/receipt/journal can change. */
export async function rotatePreparedCoordinator(input, prepared) {
  requireLinuxRoot(); const request = parseCoordinatorRotationRequest(input)
  await assertPreparedReleaseCurrent(prepared)
  const next = preparedReleaseInfo(prepared)
  check(await realpath(fileURLToPath(import.meta.url)) === next.releaseRoot + '/scripts/coordinator-rotation.mjs'
    && process.version === 'v26.12.1' && !process.env.NODE_OPTIONS && !process.env.NODE_PATH
    && await readlink('/proc/self/exe') === await realpath(next.runtime.nodePath)
    && JSON.stringify(process.argv) === JSON.stringify([next.runtime.nodePath, next.releaseRoot + '/scripts/coordinator-rotate-entry.mjs', '--artifact=' + next.artifactPath, '--archive-sha256=' + next.archiveSha256, '--operation-id=' + request.operationId, '--mode=' + request.mode]), 'COORDINATOR_ROTATION_SIGNED_HELPER_REQUIRED')
  // Rotation runs this release against the installed database before its upgrade migrates it.
  await observePreparedAdoptionSource(prepared, 'pre-migration')
  const path = `${ROOT}/coordinator-rotation-${request.operationId}.json`
  let journal = await managedPathAbsent(path) ? null : await captureManagedFile(path), oldReceipt, intent
  if (journal) ({ oldReceipt, value: intent } = parseJournal(JSON.parse(journal.bytes), request.operationId))
  else {
    check(request.mode === 'apply', 'COORDINATOR_ROTATION_JOURNAL_REQUIRED')
    await withVerifiedCoordinatorOwnership(async ownership => {
      const current = coordinatorOwnershipInfo(ownership)
      check(current.helper.releaseRoot !== next.releaseRoot, 'COORDINATOR_ROTATION_SAME_HELPER')
      oldReceipt = parseCoordinatorOwnership(JSON.parse((await captureManagedFile(P.receipt)).bytes))
      check(oldReceipt.helper.archiveSha256 === current.helper.archiveSha256, 'COORDINATOR_ROTATION_OWNERSHIP_CHANGED')
    })
  }
  check(oldReceipt.runtime.nodePath === next.runtime.nodePath && oldReceipt.runtime.nodeSha256 === next.runtime.nodeSha256, 'COORDINATOR_ROTATION_RUNTIME_CHANGE_UNSUPPORTED')
  if (intent) check(JSON.stringify(intent.next.helper) === JSON.stringify(coordinatorHelperFromPrepared(next, next.artifactPath)), 'COORDINATOR_ROTATION_TARGET_CHANGED')
  return withExistingPreparedRelease({ artifactPath: oldReceipt.helper.archivePath, expectedArchiveSha256: oldReceipt.helper.archiveSha256 }, async oldPrepared => {
    return withCoordinatorDatabaseAuthority('pre-migration', async ({ origin, rootId, assertDatabaseAuthority }) => {
      const installed = await readInstallationReceipt(), head = await readTrustedFile(ROOT + '/HEAD', { exactMode: 0o600, maxBytes: 16384 }), parsedHead = JSON.parse(head.bytes)
      check(installed.receipt.status === 'active' && parsedHead.issuerId === origin.issuerId && ['idle', 'retired'].includes(parsedHead.phase)
        && await managedPathAbsent(ROOT + '/writer-barrier.json'), 'COORDINATOR_ROTATION_LIFECYCLE_PENDING')
      const scope = { path, intent, journal, oldReceipt, next, assertAuthority: null }
      scope.assertAuthority = async () => {
        requireLinuxRoot(); await assertPreparedReleaseCurrent(prepared); await assertPreparedReleaseCurrent(oldPrepared)
        await assertDatabaseAuthority()
        check((await readInstallationReceipt()).sha256 === installed.sha256 && await managedPathAbsent(ROOT + '/writer-barrier.json'), 'COORDINATOR_ROTATION_INSTALLATION_CHANGED')
        await readTrustedFile(ROOT + '/HEAD', { exactMode: 0o600, maxBytes: 16384, sha256: head.sha256 })
        for (const file of oldReceipt.files) if (file.path !== P.unit) await assertOwnedFile(file)
        for (const file of installed.receipt.files) await assertOwnedFile(file)
      }
      await scope.assertAuthority()
      if (intent) {
        await assertOwnedFile(journal.entry)
        assertCoordinatorRotationContext(intent, { origin, installedReceiptSha256: installed.sha256, headSha256: head.sha256 })
        if (request.mode === 'apply') fail('COORDINATOR_ROTATION_EXPLICIT_RECOVERY_REQUIRED')
      } else {
        await withVerifiedCoordinatorOwnership(async ownership => {
          const current = coordinatorOwnershipInfo(ownership)
          check(current.helper.archiveSha256 === oldReceipt.helper.archiveSha256
            && (await captureManagedFile(P.receipt)).entry.sha256 === current.receiptSha256, 'COORDINATOR_ROTATION_OWNERSHIP_CHANGED')
        })
        const previous = { unit: remember(await captureManagedFile(P.unit)), receipt: remember(await captureManagedFile(P.receipt)), registration: remember(await captureManagedFile(REGISTER)) }
        scope.intent = { schemaVersion: 1, kind: 'xpanel-coordinator-rotation', operationId: request.operationId, phase: 'prepared', selection: 'next',
          origin, rootPrincipalId: rootId, installedReceiptSha256: installed.sha256, headSha256: head.sha256, previous,
          next: { helper: coordinatorHelperFromPrepared(next, next.artifactPath), runtime: next.runtime, unitSha256: hash(renderCoordinatorUnit(next.runtime.nodePath, next.releaseRoot)) },
          createdAt: new Date().toISOString() }
        parseJournal(scope.intent, request.operationId)
        await persist(scope, {})
      }
      // Explicit recovery resumes the journal's selected direction; rollback is a separate root choice.
      return select(scope, request.mode === 'rollback' ? 'previous' : scope.intent.selection)
    })
  })
}
