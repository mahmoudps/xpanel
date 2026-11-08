import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { getPrincipal, getReadonlyOperationDatabaseOrigin, withReobservedReadonlyOperationDatabase, withReopenedReadonlyHostOperationGuard, assertReadonlyOperationDatabaseCurrent, assertHostOperationGuardHeld } from '../packages/db/src/index.ts'
import { withLifecycleWriterAdmission } from './lifecycle-admission.mjs'
import { observePreparedAdoptionSource } from './install-bootstrap.mjs'
import { assertPreparedReleaseCurrent, preparedReleaseInfo } from './prepared-release.mjs'
import { requireLinuxRoot, readInstallationReceipt, assertOwnedFile, readTrustedFile, withTrustedFile, withTrustedDirectory } from './lifecycle-ownership.mjs'
import { COORDINATOR_PATHS as PATHS, coordinatorHelperFromPrepared, parseCoordinatorOwnership, renderCoordinatorUnit, withVerifiedCoordinatorOwnership, assertCoordinatorOwnershipCurrent, coordinatorOwnershipInfo } from './coordinator-ownership.mjs'
import { captureManagedFile, managedPathAbsent, replaceManagedFile, replaceManagedLink } from './lifecycle-managed-files.mjs'

const JOURNAL = '/var/lib/xpanel-lifecycle/coordinator-install.json', DATABASE = '/var/lib/xpanel/control.db'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const json = value => Buffer.from(JSON.stringify(value) + '\n')

/** Keep the physical lock across systemctl and file effects, with a fresh root observation at each boundary. */
export async function withCoordinatorDatabaseAuthority(migrations, callback) {
  return withLifecycleWriterAdmission(() => withReopenedReadonlyHostOperationGuard(DATABASE, { migrations }, async (guard, binding) => {
    const origin = Object.freeze({ file: binding.databaseFile, device: binding.databaseDevice, inode: binding.databaseInode, issuerId: binding.issuerId })
    const anchorPath = '/var/lib/xpanel-agent/operation-audit/operation-audit-authority.json'
    const anchorOptions = { exactMode: 0o600, maxBytes: 16384 }
    const anchor = await readTrustedFile(anchorPath, anchorOptions)
    const sameOrigin = value => ['file', 'device', 'inode', 'issuerId'].every(key => value?.[key] === origin[key])
    if (!sameOrigin(JSON.parse(anchor.bytes).origin)) fail('COORDINATOR_PROTECTED_DATABASE_ORIGIN_CHANGED')
    const readRoot = () => withReobservedReadonlyOperationDatabase(DATABASE, async reader => {
      if (!sameOrigin(getReadonlyOperationDatabaseOrigin(reader))) fail('COORDINATOR_DATABASE_CHANGED')
      const roots = await reader.query("SELECT id FROM principals WHERE kind='root' AND disabled=0 ORDER BY created_at,id LIMIT 2")
      if (roots.length !== 1) fail('COORDINATOR_ROOT_REQUIRED')
      const root = await getPrincipal(reader, roots[0].id)
      if (!root || root.disabled || root.forcePasswordChange || root.kind !== 'root') fail('COORDINATOR_ROOT_REQUIRED')
      await assertReadonlyOperationDatabaseCurrent(reader)
      return root.id
    }, migrations)
    const rootId = await readRoot()
    const assertDatabaseAuthority = async () => {
      await assertHostOperationGuardHeld(guard, binding)
      await readTrustedFile(anchorPath, { ...anchorOptions, sha256: anchor.sha256 })
      if (await readRoot() !== rootId) fail('COORDINATOR_AUTHORITY_CHANGED')
    }
    return callback({ origin, rootId, assertDatabaseAuthority })
  }))
}

async function withExistingRegistrationGuard(prepared, callback) {
  return withCoordinatorDatabaseAuthority('complete', async ({ origin, assertDatabaseAuthority }) => {
    const baseline = await readTrustedFile('/var/lib/xpanel-lifecycle/HEAD', { exactMode: 0o600, maxBytes: 16384 })
    const head = JSON.parse(baseline.bytes), installed = await readInstallationReceipt()
    if (!['idle', 'retired'].includes(head.phase) || head.issuerId !== origin.issuerId || installed.receipt.status !== 'active') fail('COORDINATOR_RETAINED_ATTENTION')
    const assertOrigin = async () => {
      await assertPreparedReleaseCurrent(prepared); await assertDatabaseAuthority()
      if ((await readInstallationReceipt()).sha256 !== installed.sha256) fail('COORDINATOR_AUTHORITY_CHANGED')
      await readTrustedFile('/var/lib/xpanel-lifecycle/HEAD', { exactMode: 0o600, maxBytes: 16384, sha256: baseline.sha256 })
      for (const file of installed.receipt.files) await assertOwnedFile(file)
    }
    await assertOrigin(); const value = await callback(assertOrigin); await assertOrigin(); return value
  })
}

/** Retain the executable inode until actual child close; timeout never means retirement. */
async function systemctl(args, assertAuthority) {
  await assertAuthority()
  return withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024 }, async pin => {
    let uncertain = false
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/proc/self/fd/3', ['--system', '--no-ask-password', '--no-pager', ...args], { cwd: '/', shell: false, stdio: ['ignore', 'pipe', 'pipe', pin.fd], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGERSECURE: '1' } })
      let bytes = 0, stdout = '', error = false
      let escalation
      const deadline = setTimeout(() => { uncertain = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000) }, 30_000)
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) uncertain = true; else stdout += chunk })
      child.stderr.on('data', chunk => { bytes += chunk.length; if (chunk.length) error = true; if (bytes > 16384) uncertain = true })
      child.once('error', () => { uncertain = true })
      child.once('close', (code, signal) => { clearTimeout(deadline); clearTimeout(escalation); if (uncertain || signal || code !== 0 || error) reject(Object.assign(new Error('COORDINATOR_COMMAND_UNVERIFIED'), { code: 'COORDINATOR_COMMAND_UNVERIFIED' })); else resolve(stdout) })
    })
    await pin.verify(); await assertAuthority(); return result
  })
}

/** Fixed product registration, after root provisioning; no caller-selected paths, trust or unit. */
export async function installPreparedCoordinator(prepared) {
  requireLinuxRoot(); await assertPreparedReleaseCurrent(prepared)
  const helper = preparedReleaseInfo(prepared)
  if (await realpath(fileURLToPath(import.meta.url)) !== helper.releaseRoot + '/scripts/coordinator-install.mjs'
    || process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH
    || await readlink('/proc/self/exe') !== await realpath(helper.runtime.nodePath)
    || JSON.stringify(process.argv) !== JSON.stringify([helper.runtime.nodePath, helper.releaseRoot + '/scripts/coordinator-install-entry.mjs', '--artifact=' + helper.artifactPath, '--archive-sha256=' + helper.archiveSha256])) fail('COORDINATOR_INSTALL_HELPER_REQUIRED')
  // Verify both the signed helper and the separately installed active source before any host-lock effects.
  await observePreparedAdoptionSource(prepared)
  // Resume only the fixed verified registration under SH admission and physical host exclusion.
  if (!await managedPathAbsent(PATHS.receipt)) return withExistingRegistrationGuard(prepared, assertOrigin => withVerifiedCoordinatorOwnership(async capability => {
    const current = coordinatorOwnershipInfo(capability)
    if (current.helper.archiveSha256 !== helper.archiveSha256) fail('COORDINATOR_EXPLICIT_RETIREMENT_REQUIRED')
    let registration = await readTrustedFile(JOURNAL, { exactMode: 0o600, maxBytes: 65536 })
    const journal = JSON.parse(registration.bytes)
    if (!['prepared', 'registered', 'start_requested'].includes(journal.phase) || journal.phase !== 'prepared' && journal.receiptSha256 !== current.receiptSha256
      || journal.helper?.archiveSha256 !== helper.archiveSha256) fail('COORDINATOR_REGISTRATION_RECOVERY_REQUIRED')
    const assertAuthority = async () => { await assertOrigin(); await assertCoordinatorOwnershipCurrent(capability); await readTrustedFile(JOURNAL, { exactMode: 0o600, maxBytes: 65536, sha256: registration.sha256 }) }
    if (journal.phase === 'prepared') {
      if (!Array.isArray(journal.newFiles) || journal.newFiles.length !== 3 || journal.enabledTarget !== PATHS.unit) fail('COORDINATOR_REGISTRATION_RECOVERY_REQUIRED')
      for (const path of [PATHS.privateKey, PATHS.publicKey, PATHS.unit]) {
        const planned = journal.newFiles.find(file => file.path === path), actual = await captureManagedFile(path)
        if (!planned || actual.entry.sha256 !== planned.sha256 || actual.entry.mode !== planned.mode) fail('COORDINATOR_REGISTRATION_IMAGE_CHANGED')
      }
      const old = await captureManagedFile(JOURNAL)
      if (old.entry.sha256 !== registration.sha256) fail('COORDINATOR_REGISTRATION_IMAGE_CHANGED')
      const updated = await replaceManagedFile(JOURNAL, json({ ...journal, phase: 'registered', receiptSha256: current.receiptSha256 }), 0o600, old.entry,
        async () => { await assertOrigin(); await assertCoordinatorOwnershipCurrent(capability) })
      registration = { bytes: updated.bytes, sha256: updated.entry.sha256 }
    }
    await systemctl(['daemon-reload'], assertAuthority)
    const state = await systemctl(['show', current.unit, '--property=MainPID,ControlPID,ActiveState,FragmentPath,DropInPaths'], assertAuthority)
    const fields = Object.fromEntries(state.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
    if (fields.FragmentPath !== PATHS.unit || fields.DropInPaths || fields.ControlPID !== '0') fail('COORDINATOR_REGISTRATION_STATE_UNKNOWN')
    let started = false
    if (fields.ActiveState === 'inactive' && fields.MainPID === '0') {
      await systemctl(['daemon-reload'], assertAuthority)
      await systemctl(['start', current.unit], assertAuthority)
      started = true
    } else if (fields.ActiveState !== 'active' || !/^[1-9][0-9]*$/.test(fields.MainPID)) fail('COORDINATOR_REGISTRATION_STATE_UNKNOWN')
    return Object.freeze({ status: 'registered', unit: current.unit, sourceVersion: current.helper.version, started, ready: false, ipcQualificationRequired: true })
  }))
  const interrupted = await managedPathAbsent(JOURNAL) ? null : await captureManagedFile(JOURNAL)
  const databasePin = await open(DATABASE, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const database = await databasePin.stat({ bigint: true })
    if (!database.isFile() || database.nlink !== 1n) fail('COORDINATOR_DATABASE_UNSAFE')
    return await withCoordinatorDatabaseAuthority('complete', async ({ origin, assertDatabaseAuthority }) => {
      if (origin.file !== DATABASE || origin.device !== String(database.dev) || origin.inode !== String(database.ino)) fail('COORDINATOR_DATABASE_CHANGED')
      const installed = await readInstallationReceipt()
      if (installed.receipt.status !== 'active') fail('COORDINATOR_INSTALLATION_REQUIRED')
      if (installed.receipt.runtime.nodePath !== helper.runtime.nodePath || installed.receipt.runtime.nodeSha256 !== helper.runtime.nodeSha256) fail('COORDINATOR_RUNTIME_CHANGED')
      const baseline = await readTrustedFile('/var/lib/xpanel-lifecycle/HEAD', { exactMode: 0o600, maxBytes: 16384 })
      const head = JSON.parse(baseline.bytes.toString('utf8'))
      if (!['idle', 'retired'].includes(head.phase) || head.issuerId !== origin.issuerId) fail('COORDINATOR_RETAINED_ATTENTION')
      const assertAuthority = async () => {
        requireLinuxRoot(); await assertPreparedReleaseCurrent(prepared); await assertDatabaseAuthority()
        const current = await readInstallationReceipt()
        if (current.sha256 !== installed.sha256) fail('COORDINATOR_INSTALLATION_CHANGED')
        await readTrustedFile('/var/lib/xpanel-lifecycle/HEAD', { exactMode: 0o600, maxBytes: 16384, sha256: baseline.sha256 })
        for (const file of installed.receipt.files) await assertOwnedFile(file)
      }
      await assertAuthority()
      let priorIntent = null
      if (interrupted) {
        priorIntent = JSON.parse(interrupted.bytes)
        if (interrupted.entry.mode !== 0o600 || priorIntent.schemaVersion !== 1 || priorIntent.phase !== 'prepared'
          || priorIntent.installedReceiptSha256 !== installed.sha256 || priorIntent.headSha256 !== baseline.sha256
          || JSON.stringify(priorIntent.helper) !== JSON.stringify(coordinatorHelperFromPrepared(helper, helper.artifactPath))) fail('COORDINATOR_REGISTRATION_RECOVERY_REQUIRED')
        await assertOwnedFile(interrupted.entry)
      } else for (const path of [PATHS.unit, PATHS.enabled, PATHS.privateKey, PATHS.publicKey, PATHS.receipt]) if (!await managedPathAbsent(path)) fail('COORDINATOR_FOREIGN_PATH_PRESERVED')
      const priorState = await systemctl(['show', 'xpanel-lifecycle.service', '--property=LoadState,ActiveState,MainPID,ControlPID'], assertAuthority)
      const fields = Object.fromEntries(priorState.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
      if ((!priorIntent && fields.LoadState !== 'not-found') || !['not-found', 'loaded'].includes(fields.LoadState)
        || fields.ActiveState !== 'inactive' || fields.MainPID !== '0' || fields.ControlPID !== '0') fail('COORDINATOR_EXISTING_UNIT_PRESERVED')
      const addon = await captureManagedFile(PATHS.addon)
      let privateKey, publicKey
      if (priorIntent && !await managedPathAbsent(PATHS.privateKey)) {
        const key = await readTrustedFile(PATHS.privateKey, { exactMode: 0o600, maxBytes: 4096 })
        privateKey = Buffer.from(key.bytes)
        const parsedKey = createPrivateKey(privateKey)
        if (parsedKey.asymmetricKeyType !== 'ed25519') fail('COORDINATOR_REGISTRATION_KEY_CHANGED')
        publicKey = Buffer.from(createPublicKey(parsedKey).export({ type: 'spki', format: 'pem' }))
      } else {
        // A journal with no key is restartable only if no registration file was ever published.
        for (const path of [PATHS.unit, PATHS.enabled, PATHS.privateKey, PATHS.publicKey, PATHS.receipt]) if (!await managedPathAbsent(path)) fail('COORDINATOR_REGISTRATION_IMAGE_UNKNOWN')
        const pair = generateKeyPairSync('ed25519')
        privateKey = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
        publicKey = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' }))
      }
      const unit = Buffer.from(renderCoordinatorUnit(helper.runtime.nodePath, helper.releaseRoot))
      let intent = { schemaVersion: 1, operationId: randomUUID(), phase: 'prepared', createdAt: new Date().toISOString(),
        installedReceiptSha256: installed.sha256, headSha256: baseline.sha256, helper: coordinatorHelperFromPrepared(helper, helper.artifactPath),
        newFiles: [{ path: PATHS.privateKey, sha256: sha(privateKey), mode: 0o600 }, { path: PATHS.publicKey, sha256: sha(publicKey), mode: 0o644 }, { path: PATHS.unit, sha256: sha(unit), mode: 0o644 }], enabledTarget: PATHS.unit }
      if (priorIntent && !await managedPathAbsent(PATHS.privateKey)) {
        if (JSON.stringify(intent.newFiles) !== JSON.stringify(priorIntent.newFiles) || priorIntent.enabledTarget !== PATHS.unit) fail('COORDINATOR_REGISTRATION_IMAGE_CHANGED')
        intent = priorIntent
      } else if (priorIntent) intent = { ...intent, supersededUnpublishedIntentSha256: interrupted.entry.sha256 }
      let journal = interrupted && intent === priorIntent ? interrupted : await replaceManagedFile(JOURNAL, json(intent), 0o600, interrupted?.entry ?? null, assertAuthority)
      const files = []
      try {
        // Intent contains hashes only, never private key bytes. Unknown outcomes retain this journal.
        for (const [path, bytes, mode] of [[PATHS.privateKey, privateKey, 0o600], [PATHS.publicKey, publicKey, 0o644], [PATHS.unit, unit, 0o644]]) {
          if (await managedPathAbsent(path)) files.push((await replaceManagedFile(path, bytes, mode, null, assertAuthority)).entry)
          else {
            const actual = await captureManagedFile(path)
            if (!priorIntent || actual.entry.kind !== 'file' || actual.entry.mode !== mode || actual.entry.sha256 !== sha(bytes)) fail('COORDINATOR_REGISTRATION_IMAGE_CHANGED')
            files.push(actual.entry)
          }
        }
        if (await managedPathAbsent(PATHS.enabled)) files.push((await replaceManagedLink(PATHS.enabled, PATHS.unit, null, assertAuthority)).entry)
        else { const enabled = await captureManagedFile(PATHS.enabled); if (!priorIntent || enabled.entry.kind !== 'symlink' || enabled.entry.target !== PATHS.unit) fail('COORDINATOR_REGISTRATION_IMAGE_CHANGED'); files.push(enabled.entry) }
        files.push(addon.entry)
        const receipt = parseCoordinatorOwnership({ schemaVersion: 1, product: 'xpanel', unit: 'xpanel-lifecycle.service', createdAt: intent.createdAt,
          helper: intent.helper, runtime: { nodePath: helper.runtime.nodePath, nodeVersion: helper.runtime.nodeVersion, nodeSha256: helper.runtime.nodeSha256, systemctlSha256: installed.receipt.runtime.systemctlSha256 }, files })
        await replaceManagedFile(PATHS.receipt, json(receipt), 0o600, null, assertAuthority)
        journal = await replaceManagedFile(JOURNAL, json({ ...intent, phase: 'registered', receiptSha256: sha(json(receipt)) }), 0o600, journal.entry, assertAuthority)
        await withVerifiedCoordinatorOwnership(async () => { await assertAuthority() })
        await systemctl(['daemon-reload'], assertAuthority)
        await systemctl(['start', receipt.unit], assertAuthority)
        await replaceManagedFile(JOURNAL, json({ ...intent, phase: 'start_requested', receiptSha256: sha(json(receipt)) }), 0o600, journal.entry, assertAuthority)
        // IPC/process/source qualification remains independently required; systemctl exit is not readiness.
        return Object.freeze({ status: 'registered', unit: receipt.unit, sourceVersion: helper.version, started: true, ready: false })
      } finally { privateKey.fill(0) }
    })
  } finally { await databasePin.close() }
}
