import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, readlink } from 'node:fs/promises'
import { dirname, posix } from 'node:path'

export const INSTALLATION_RECEIPT = '/var/lib/xpanel-lifecycle/installation.json'
export const OWNED_PANEL_UNITS = Object.freeze(['xpanel-api.service', 'xpanel-agent.service', 'xpanel-management-tls.service', 'xpanel-management-tls.timer'])
const SHA = /^[a-f0-9]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const safe = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }) }
const canonical = path => typeof path === 'string' && path.length <= 4096 && posix.isAbsolute(path) && posix.normalize(path) === path && !/[\0\r\n]/.test(path)
const object = (value, keys, code) => {
  safe(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code)
  safe(Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), code)
}
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const REMOVABLE = new Set([
  '/usr/local/bin/xpanel-ctl', '/opt/xpanel/bin/xpanel-ctl',
  ...OWNED_PANEL_UNITS.map(unit => `/etc/systemd/system/${unit}`),
  '/etc/systemd/system/multi-user.target.wants/xpanel-api.service', '/etc/systemd/system/multi-user.target.wants/xpanel-agent.service',
  '/etc/systemd/system/timers.target.wants/xpanel-management-tls.timer',
  '/etc/nginx/conf.d/xpanel-management.conf', '/etc/nginx/conf.d/xpanel-management-challenge.conf', '/etc/nginx/xpanel-management/ingress-secret.conf',
])
export const isRemovableControlPlanePath = path => typeof path === 'string' && REMOVABLE.has(path)

/** Syntax only. A copied receipt is neither ownership proof nor authority to mutate the host. */
export function parseInstallationReceipt(value) {
  object(value, ['schemaVersion', 'product', 'status', 'officialReference', 'lastLifecycleReference', 'createdAt', 'source', 'runtime', 'writerProtocol', 'units', 'files'], 'INSTALLATION_RECEIPT_INVALID')
  safe(value.schemaVersion === 1 && value.product === 'xpanel' && ['bootstrap_pending', 'active', 'uninstalled'].includes(value.status) && value.officialReference === null, 'INSTALLATION_RECEIPT_INVALID')
  safe(value.lastLifecycleReference === null || typeof value.lastLifecycleReference === 'string' && /^XP-(?:JOB|LC)-[0-9]{4}-[0-9]{6,16}$/.test(value.lastLifecycleReference), 'INSTALLATION_REFERENCE_INVALID')
  safe(typeof value.createdAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)), 'INSTALLATION_RECEIPT_INVALID')
  object(value.source, ['root', 'version', 'archiveSha256', 'manifestSha256', 'dependencyReceiptSha256', 'controlDbSchemaVersion'], 'INSTALLATION_SOURCE_INVALID')
  safe(value.source.root === '/opt/xpanel' && typeof value.source.version === 'string' && VERSION.test(value.source.version) && [value.source.archiveSha256, value.source.manifestSha256, value.source.dependencyReceiptSha256].every(v => typeof v === 'string' && SHA.test(v)) && Number.isSafeInteger(value.source.controlDbSchemaVersion) && value.source.controlDbSchemaVersion >= 1, 'INSTALLATION_SOURCE_INVALID')
  object(value.runtime, ['nodePath', 'nodeVersion', 'nodeSha256', 'systemctlSha256', 'nginxSha256'], 'INSTALLATION_RUNTIME_INVALID')
  safe(canonical(value.runtime.nodePath) && !/^\/(?:home(?:\d+)?|tmp|var\/tmp)(?:\/|$)/.test(value.runtime.nodePath) && value.runtime.nodeVersion === '26.12.1' && [value.runtime.nodeSha256, value.runtime.systemctlSha256, value.runtime.nginxSha256].every(hash => typeof hash === 'string' && SHA.test(hash)), 'INSTALLATION_RUNTIME_INVALID')
  safe(value.writerProtocol === 'lifecycle-admission-v1', 'INSTALLATION_WRITERS_UNQUALIFIED')
  safe(Array.isArray(value.units) && value.units.length === OWNED_PANEL_UNITS.length && new Set(value.units).size === OWNED_PANEL_UNITS.length && value.units.every(unit => OWNED_PANEL_UNITS.includes(unit)), 'INSTALLATION_UNITS_INVALID')
  safe(Array.isArray(value.files) && value.files.length === REMOVABLE.size, 'INSTALLATION_FILES_INVALID')
  const paths = new Set()
  for (const entry of value.files) {
    object(entry, ['path', 'kind', 'device', 'inode', 'size', 'mode', 'sha256', 'target'], 'INSTALLATION_FILE_INVALID')
    safe(isRemovableControlPlanePath(entry.path) && !paths.has(entry.path), 'INSTALLATION_FILE_NOT_REMOVABLE'); paths.add(entry.path)
    safe(['file', 'symlink'].includes(entry.kind) && typeof entry.device === 'string' && DECIMAL.test(entry.device) && typeof entry.inode === 'string' && DECIMAL.test(entry.inode) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 1024 * 1024 && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777, 'INSTALLATION_FILE_INVALID')
    if (entry.kind === 'file') safe(typeof entry.sha256 === 'string' && SHA.test(entry.sha256) && entry.target === null && (entry.mode & 0o6022) === 0, 'INSTALLATION_FILE_INVALID')
    else {
      const expected = entry.path === '/usr/local/bin/xpanel-ctl' ? '/opt/xpanel/bin/xpanel-ctl' : `/etc/systemd/system/${posix.basename(entry.path)}`
      safe(entry.sha256 === null && entry.target === expected && entry.path !== expected, 'INSTALLATION_LINK_INVALID')
    }
  }
  for (const path of REMOVABLE) safe(paths.has(path), 'INSTALLATION_FILES_INCOMPLETE')
  return freeze(structuredClone(value))
}

export function requireLinuxRoot() {
  safe(process.platform === 'linux' && process.getuid?.() === 0 && process.geteuid?.() === 0, 'LINUX_ROOT_REQUIRED')
}

/** Retain and revalidate every actual root-owned ancestor FD across the callback. */
export async function withTrustedDirectory(path, callback) {
  safe(canonical(path) && typeof callback === 'function', 'TRUSTED_PATH_REQUIRED')
  const pins = []
  const verify = async () => {
    for (const pin of pins) {
      const [named, opened] = await Promise.all([lstat(pin.path, { bigint: true }), pin.handle.stat({ bigint: true })])
      safe(opened.isDirectory() && named.isDirectory() && !named.isSymbolicLink() && opened.uid === 0n && (opened.mode & 0o022n) === 0n && opened.dev === pin.device && opened.ino === pin.inode && named.dev === pin.device && named.ino === pin.inode, 'TRUSTED_PARENT_DRIFT')
    }
  }
  try {
    const paths = []; for (let current = path; ; current = dirname(current)) { paths.unshift(current); if (current === '/') break }
    for (const current of paths) {
      const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      const initial = await handle.stat({ bigint: true }); pins.push({ path: current, handle, device: initial.dev, inode: initial.ino })
      await verify()
    }
    const value = await callback(Object.freeze({ verify }))
    await verify()
    return value
  } finally {
    const errors = []
    for (const pin of pins.reverse()) try { await pin.handle.close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'trusted directory descriptor retirement requires inspection')
  }
}

export async function assertTrustedDirectory(path) { return withTrustedDirectory(path, async () => {}) }

/** Read and retain a root-owned regular inode; no stat providers or caller receipts can replace native checks. */
export async function withTrustedFile(path, { maxBytes = 1024 * 1024, exactMode, sha256 } = {}, callback) {
  safe(canonical(path) && Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= 256 * 1024 * 1024 && typeof callback === 'function', 'TRUSTED_FILE_OPTIONS_INVALID')
  return withTrustedDirectory(dirname(path), async ancestry => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat({ bigint: true })
      safe(before.isFile() && before.uid === 0n && before.gid === 0n && before.nlink === 1n && (before.mode & 0o6022n) === 0n && before.size >= 0n && before.size <= BigInt(maxBytes), 'TRUSTED_FILE_REQUIRED')
      if (exactMode !== undefined) safe(Number(before.mode & 0o7777n) === exactMode, 'TRUSTED_FILE_MODE')
      const bytes = Buffer.alloc(Number(before.size)); let offset = 0
      while (offset < bytes.length) { const actual = await handle.read(bytes, offset, bytes.length - offset, offset); safe(actual.bytesRead > 0, 'TRUSTED_FILE_CHANGED'); offset += actual.bytesRead }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (sha256 !== undefined) safe(digest === sha256, 'TRUSTED_FILE_HASH_DRIFT')
      const verify = async () => {
        await ancestry.verify()
        const [after, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
        safe(after.isFile() && after.uid === before.uid && after.gid === before.gid && after.mode === before.mode && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && named.dev === before.dev && named.ino === before.ino && !named.isSymbolicLink(), 'TRUSTED_FILE_CHANGED')
      }
      await verify()
      const value = await callback(Object.freeze({ bytes, fd: handle.fd, sha256: digest, info: before, verify }))
      await verify()
      return value
    } finally { await handle.close() }
  })
}

export async function readTrustedFile(path, options) { return withTrustedFile(path, options, async ({ bytes, sha256, info }) => Object.freeze({ bytes, sha256, info })) }

export async function readInstallationReceipt() {
  requireLinuxRoot()
  return withTrustedFile(INSTALLATION_RECEIPT, { maxBytes: 64 * 1024, exactMode: 0o600 }, async actual => Object.freeze({ receipt: parseInstallationReceipt(JSON.parse(actual.bytes.toString('utf8'))), sha256: actual.sha256 }))
}

export async function assertOwnedFile(entry) {
  await assertTrustedDirectory(dirname(entry.path))
  const named = await lstat(entry.path, { bigint: true })
  safe(String(named.dev) === entry.device && String(named.ino) === entry.inode && Number(named.size) === entry.size && Number(named.mode & 0o7777n) === entry.mode && named.uid === 0n && named.gid === 0n, 'OWNED_FILE_DRIFT')
  if (entry.kind === 'symlink') safe(named.isSymbolicLink() && await readlink(entry.path) === entry.target && await realpath(entry.path) === await realpath(entry.target), 'OWNED_LINK_DRIFT')
  else {
    safe(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n, 'OWNED_FILE_DRIFT')
    const opened = await readTrustedFile(entry.path, { maxBytes: 1024 * 1024, sha256: entry.sha256 })
    safe(String(opened.info.dev) === entry.device && String(opened.info.ino) === entry.inode, 'OWNED_FILE_DRIFT')
  }
}

/** A finite preservation plan, not uninstall authorization or TLS handoff proof. */
export function preservingUninstallPlan(receipt) {
  const parsed = parseInstallationReceipt(receipt); safe(parsed.status !== 'uninstalled', 'ALREADY_UNINSTALLED')
  return freeze({ kind: 'uninstall', removal: parsed.files.map(entry => entry.path), stopUnits: [...OWNED_PANEL_UNITS], retain: ['/opt/xpanel', '/etc/xpanel', '/var/lib/xpanel', '/var/lib/xpanel-agent', '/var/lib/xpanel-lifecycle', '/var/lib/xpanel-management-tls', '/var/log/xpanel', '/var/log/xpanel-management-tls', '/etc/letsencrypt', '/home', '/var/mail', '/var/vmail', '/var/lib/mysql', '/var/lib/mariadb'], purge: false, restoreHistoricalAuthority: false })
}
