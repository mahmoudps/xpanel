import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readlink, realpath } from 'node:fs/promises'
import { assertOwnedFile, readTrustedFile, requireLinuxRoot, withTrustedFile } from './lifecycle-ownership.mjs'
import { withExistingPreparedRelease, assertPreparedReleaseCurrent, preparedReleaseInfo, withVisiblePreparedRelease } from './prepared-release.mjs'

export const COORDINATOR_PATHS = Object.freeze({
  receipt: '/var/lib/xpanel-lifecycle/coordinator.json', unit: '/etc/systemd/system/xpanel-lifecycle.service',
  enabled: '/etc/systemd/system/multi-user.target.wants/xpanel-lifecycle.service',
  privateKey: '/etc/xpanel/lifecycle-launcher.key', publicKey: '/etc/xpanel/lifecycle-launcher.pub',
  addon: '/opt/xpanel/bin/xpanel-peer-identity.node',
})
const SHA = /^[a-f0-9]{64}$/, DECIMAL = /^(0|[1-9][0-9]{0,19})$/
const UNIT = 'xpanel-lifecycle.service', scopes = new WeakMap(), active = new AsyncLocalStorage()
const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (value, code) => { if (!value) fail(code) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const exact = (value, keys, code) => check(value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), code)
const path = value => typeof value === 'string' && /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..')
const VERSION = '(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})'
const visible = expected => {
  let scope = active.getStore()
  while (scope) { if (!scope.live || scope.pid !== process.pid) return false; if (scope === expected) return true; scope = scope.parent }
  return false
}

/** This unit is separate from OWNED_PANEL_UNITS and survives their stop/drain. */
export function renderCoordinatorUnit(nodePath, releaseRoot) {
  check(path(nodePath), 'COORDINATOR_NODE_PATH_INVALID')
  check(typeof releaseRoot === 'string' && new RegExp('^/opt/xpanel/releases/' + VERSION + '$').test(releaseRoot), 'COORDINATOR_SOURCE_INVALID')
  return `[Unit]\nDescription=xPanel native lifecycle coordinator\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nGroup=root\nWorkingDirectory=${releaseRoot}\nEnvironment=NODE_ENV=production\nExecStart=${nodePath} ${releaseRoot}/apps/agent/src/ops-upgrade-native.ts\nRuntimeDirectory=xpanel-lifecycle\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=no\nUMask=0077\nRestart=no\nKillMode=control-group\nTimeoutStopSec=30\n\n[Install]\nWantedBy=multi-user.target\n`
}

/** Syntax only. A parsed coordinator receipt is never a capability. */
export function parseCoordinatorOwnership(value) {
  exact(value, ['schemaVersion', 'product', 'unit', 'createdAt', 'helper', 'runtime', 'files'], 'COORDINATOR_RECEIPT_INVALID')
  check(value.schemaVersion === 1 && value.product === 'xpanel' && value.unit === UNIT
    && typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)), 'COORDINATOR_RECEIPT_INVALID')
  const helperKeys = ['version', 'releaseRoot', 'archivePath', 'archiveSha256', 'manifestSha256', 'sourceFilesDigest', 'dependencyReceiptPath', 'dependencyReceiptSha256', 'treeSha256']
  exact(value.helper, helperKeys, 'COORDINATOR_SOURCE_INVALID')
  const helper = value.helper
  check(typeof helper.version === 'string' && new RegExp('^' + VERSION + '$').test(helper.version) && helper.releaseRoot === '/opt/xpanel/releases/' + helper.version
    && path(helper.archivePath) && helper.archivePath.endsWith('.tar.gz') && !/^\/(?:home[0-9]*|tmp|var\/tmp)\//.test(helper.archivePath)
    && helper.dependencyReceiptPath === '/var/lib/xpanel-lifecycle/prepared/' + helper.archiveSha256 + '/dependencies.json'
    && ['archiveSha256', 'manifestSha256', 'sourceFilesDigest', 'dependencyReceiptSha256', 'treeSha256'].every(key => typeof helper[key] === 'string' && SHA.test(helper[key])), 'COORDINATOR_SOURCE_INVALID')
  exact(value.runtime, ['nodePath', 'nodeVersion', 'nodeSha256', 'systemctlSha256'], 'COORDINATOR_RUNTIME_INVALID')
  check(path(value.runtime.nodePath) && value.runtime.nodeVersion === '26.12.1'
    && ['nodeSha256', 'systemctlSha256'].every(key => typeof value.runtime[key] === 'string' && SHA.test(value.runtime[key])), 'COORDINATOR_RUNTIME_INVALID')
  const allowed = [COORDINATOR_PATHS.unit, COORDINATOR_PATHS.enabled, COORDINATOR_PATHS.privateKey, COORDINATOR_PATHS.publicKey, COORDINATOR_PATHS.addon]
  check(Array.isArray(value.files) && value.files.length === allowed.length, 'COORDINATOR_FILES_INVALID')
  const seen = new Set()
  for (const entry of value.files) {
    exact(entry, ['path', 'kind', 'device', 'inode', 'size', 'mode', 'sha256', 'target'], 'COORDINATOR_FILE_INVALID')
    check(allowed.includes(entry.path) && !seen.has(entry.path) && typeof entry.device === 'string' && typeof entry.inode === 'string' && DECIMAL.test(entry.device) && DECIMAL.test(entry.inode)
      && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 8 * 1024 * 1024, 'COORDINATOR_FILE_INVALID')
    seen.add(entry.path)
    if (entry.path === COORDINATOR_PATHS.enabled) check(entry.kind === 'symlink' && entry.mode === 0o777 && entry.sha256 === null && entry.target === COORDINATOR_PATHS.unit, 'COORDINATOR_LINK_INVALID')
    else check(entry.kind === 'file' && entry.target === null && typeof entry.sha256 === 'string' && SHA.test(entry.sha256)
      && entry.mode === (entry.path === COORDINATOR_PATHS.privateKey ? 0o600 : entry.path === COORDINATOR_PATHS.addon ? 0o755 : 0o644), 'COORDINATOR_FILE_INVALID')
  }
  return freeze(structuredClone(value))
}

/** Metadata mapping is not a grant; callers cannot supply it to the native factory. */
export function coordinatorHelperFromPrepared(info, archivePath) {
  return Object.freeze(Object.fromEntries(['version', 'releaseRoot', 'archiveSha256', 'manifestSha256', 'sourceFilesDigest', 'dependencyReceiptPath', 'dependencyReceiptSha256', 'treeSha256'].map(key => [key, info[key]]).concat([['archivePath', archivePath]])))
}

export async function assertCoordinatorOwnershipCurrent(capability) {
  const scope = capability && scopes.get(capability)
  check(scope && visible(scope), 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  requireLinuxRoot()
  await withVisiblePreparedRelease(scope.prepared, () => assertPreparedReleaseCurrent(scope.prepared))
  for (const verify of scope.pins) await verify()
  for (const entry of scope.receipt.files) await assertOwnedFile(entry)
}

/** Native listener callbacks can lose the async store. Re-enter the same live scope; do not mint another one. */
export async function withVisibleCoordinatorOwnership(capability, callback) {
  const scope = capability && scopes.get(capability)
  check(typeof callback === 'function' && scope && scope.live && scope.pid === process.pid, 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  if (visible(scope)) return callback()
  return active.run(scope, () => callback())
}

export function coordinatorOwnershipInfo(capability) {
  const scope = capability && scopes.get(capability)
  check(scope && visible(scope), 'COORDINATOR_OWNERSHIP_SCOPE_REQUIRED')
  const entry = name => scope.receipt.files.find(file => file.path === COORDINATOR_PATHS[name])
  return freeze({ unit: UNIT, nodePath: scope.receipt.runtime.nodePath, nodeSha256: scope.receipt.runtime.nodeSha256,
    systemctlSha256: scope.receipt.runtime.systemctlSha256, sourcePath: scope.receipt.helper.releaseRoot + '/apps/agent/src/ops-upgrade-native.ts',
    unitSha256: entry('unit').sha256, addonSha256: entry('addon').sha256, publicKeySha256: entry('publicKey').sha256,
    receiptSha256: scope.receiptSha256, helper: scope.receipt.helper })
}

/** Live trusted file/ancestry and authenticated helper pins survive the whole callback. */
export async function withVerifiedCoordinatorOwnership(callback) {
  requireLinuxRoot()
  check(typeof callback === 'function', 'COORDINATOR_CALLBACK_REQUIRED')
  return withTrustedFile(COORDINATOR_PATHS.receipt, { maxBytes: 32 * 1024, exactMode: 0o600 }, async held => {
    const receipt = parseCoordinatorOwnership(JSON.parse(held.bytes.toString('utf8')))
    return withExistingPreparedRelease({ artifactPath: receipt.helper.archivePath, expectedArchiveSha256: receipt.helper.archiveSha256 }, async prepared => {
      const info = preparedReleaseInfo(prepared)
      check(JSON.stringify(coordinatorHelperFromPrepared(info, receipt.helper.archivePath)) === JSON.stringify(coordinatorHelperFromPrepared(receipt.helper, receipt.helper.archivePath)), 'COORDINATOR_HELPER_CHANGED')
      check(info.runtime.nodePath === receipt.runtime.nodePath && info.runtime.nodeSha256 === receipt.runtime.nodeSha256 && info.runtime.nodeVersion === receipt.runtime.nodeVersion, 'COORDINATOR_RUNTIME_CHANGED')
      const scope = { receipt, receiptSha256: held.sha256, prepared, pins: [held.verify], live: true, parent: active.getStore() ?? null, pid: process.pid }, capability = Object.freeze({})
      scopes.set(capability, scope)
      const regular = receipt.files.filter(entry => entry.kind === 'file')
      const pin = async index => {
        if (index === regular.length) return withTrustedFile(receipt.runtime.nodePath, { maxBytes: 256 * 1024 * 1024, sha256: receipt.runtime.nodeSha256 }, async node =>
          withTrustedFile('/usr/bin/systemctl', { maxBytes: 16 * 1024 * 1024, sha256: receipt.runtime.systemctlSha256 }, async systemctl => {
            scope.pins.push(node.verify, systemctl.verify)
            const unit = await readTrustedFile(COORDINATOR_PATHS.unit, { maxBytes: 65536 })
            check(unit.sha256 === digest(renderCoordinatorUnit(receipt.runtime.nodePath, receipt.helper.releaseRoot)), 'COORDINATOR_UNIT_CONTRACT_CHANGED')
            check(await readlink(COORDINATOR_PATHS.enabled) === COORDINATOR_PATHS.unit && await realpath(COORDINATOR_PATHS.enabled) === COORDINATOR_PATHS.unit, 'COORDINATOR_LINK_CHANGED')
            return active.run(scope, async () => { await assertCoordinatorOwnershipCurrent(capability); const result = await callback(capability); await assertCoordinatorOwnershipCurrent(capability); return result })
          }))
        const entry = regular[index]
        return withTrustedFile(entry.path, { maxBytes: 8 * 1024 * 1024, exactMode: entry.mode, sha256: entry.sha256 }, async file => {
          scope.pins.push(file.verify); await assertOwnedFile(entry); return pin(index + 1)
        })
      }
      try { return await pin(0) } finally { scope.live = false }
    })
  })
}
