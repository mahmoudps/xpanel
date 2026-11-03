import { EventEmitter } from 'node:events'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fixed native ports are replaced only inside this unit module. This proves no Linux hosting or service outcome.
const port = vi.hoisted(() => ({
  files: new Map<string, Buffer>(), dirs: new Map<string, string[]>(), modes: new Map<string, number>(),
  owners: new Map<string, [number, number]>(), fds: new Map<number, string>(), nextFd: 20,
  writes: [] as string[], commands: [] as string[], report: {} as any, loadedUnit: false as boolean | string,
  procStatus: 'Name:\tunit\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n',
  threadStatus: '', extraThread: false, foreignView: false, extraAcl: false,
}))
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const normalized = (path: string) => path.replaceAll('\\', '/')
function resolvedProcPath(path: string): string {
  path = normalized(path)
  const match = /^\/proc\/self\/fd\/([0-9]+)(\/.*)?$/.exec(path)
  return match ? (port.fds.get(Number(match[1])) ?? missing(path)) + (match[2] ?? '') : path
}
function procBytes(path: string) {
  const match = /^\/proc\/99\/task\/(99|100)\/(stat|status)$/.exec(path)
  if (!match) return undefined
  if (match[2] === 'status') return Buffer.from(match[1] === '100' ? port.threadStatus || port.procStatus : port.procStatus)
  const fields = Array<string>(20).fill('0'); fields[0] = 'S'; fields[19] = '1337'
  return Buffer.from(match[1] + ' (unit) ' + fields.join(' '))
}
function missing(path: string): never { throw Object.assign(new Error('missing fixture path'), { code: 'ENOENT', path }) }
function info(path: string) {
  path = normalized(path)
  if (!port.files.has(path) && !port.dirs.has(path)) return missing(path)
  const owners = port.owners.get(path) ?? [0, 0]
  return { uid: BigInt(owners[0]), gid: BigInt(owners[1]), mode: BigInt(port.modes.get(path) ?? (port.dirs.has(path) ? 0o755 : 0o644)),
    dev: 1n, ino: BigInt([...port.dirs.keys(), ...port.files.keys()].indexOf(path) + 1), nlink: 1n,
    size: BigInt(port.files.get(path)?.length ?? 0), mtimeNs: 1n, ctimeNs: 1n,
    isDirectory: () => port.dirs.has(path), isFile: () => port.files.has(path), isSymbolicLink: () => false }
}
vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  lstat: async (path: string) => info(path),
  realpath: async (path: string) => path === process.execPath ? '/opt/node/bin/node'
    : path === '/opt/xpanel/current' ? '/opt/xpanel/releases/0.1.1' : path,
  readlink: async (path: string) => path === '/proc/self' ? String(process.pid)
    : path === `/proc/${process.pid}/exe` ? '/opt/node/bin/node'
      : path === '/opt/xpanel/current' ? '/opt/xpanel/releases/0.1.1'
        : /^\/proc\/(self|1)\/ns\//.test(path) ? port.foreignView && path.startsWith('/proc/self/') ? 'foreign:[2]' : path.split('/').at(-1) + ':[1]' : missing(path),
  readFile: async (path: string, encoding?: string) => {
    path = normalized(path)
    if (path === '/proc/1/comm') return 'systemd\n'
    return path === '/proc/99/status' ? port.procStatus
      : port.files.has(path) ? encoding ? port.files.get(path)!.toString() : port.files.get(path)! : missing(path)
  },
  readdir: async (path: string) => {
    const named = resolvedProcPath(path)
    return named === '/proc' ? ['self', '99'] : named === '/proc/99/task' ? port.extraThread ? ['99', '100'] : ['99'] : port.dirs.get(named) ?? missing(named)
  },
  open: async (path: string) => {
    path = resolvedProcPath(path)
    const content = procBytes(path)
    if (!content) info(path)
    const fd = port.nextFd++; port.fds.set(fd, path); let offset = 0
    return { fd, stat: async () => info(path), close: async () => { port.fds.delete(fd) },
      read: async (buffer: Buffer, start: number, length: number) => {
        if (!content) throw new Error('Unexpected fixture read')
        const bytesRead = Math.min(length, content.length - offset)
        content.copy(buffer, start, offset, offset + bytesRead); offset += bytesRead
        return { bytesRead, buffer }
      } }
  },
  mkdir: async () => { port.writes.push('mkdir'); throw new Error('unexpected write') },
  rename: async () => { port.writes.push('rename'); throw new Error('unexpected write') },
  symlink: async () => { port.writes.push('symlink'); throw new Error('unexpected write') },
  chmod: async () => { port.writes.push('chmod'); throw new Error('unexpected write') },
}))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (_path: string, args: string[], options: { stdio: unknown[] }) => {
    const command = port.fds.get(Number(options.stdio[3]))!
    port.commands.push(command)
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
    const text = command === '/usr/bin/getent' ? 'xpanel:x:123:124::/var/lib/xpanel:/usr/sbin/nologin\n'
      : command === '/usr/bin/getfacl' ? 'user::rwx\n' + ((port.modes.get(port.fds.get(Number(args.at(-1)!.split('/').at(-1)))!)! & 0o070) === 0o070 ? 'group::rwx\n' : 'group::r-x\n')
        + 'other::---\n' + (port.extraAcl ? 'user:500:rwx\nmask::rwx\n' : '')
      : port.loadedUnit === true || port.loadedUnit === args[1] ? 'LoadState=loaded\nActiveState=active\nMainPID=99\nControlPID=0\n'
        : args[1] === 'xpanel-management-tls.timer' ? 'LoadState=not-found\nActiveState=inactive\n'
          : 'LoadState=not-found\nActiveState=inactive\nMainPID=0\nControlPID=0\n'
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(text)); child.emit('close', 0, null) })
    return child
  },
}))
vi.mock('./lifecycle-ownership.mjs', async original => ({
  ...await original<typeof import('./lifecycle-ownership.mjs')>(),
  requireLinuxRoot: () => {},
  assertTrustedDirectory: async (path: string) => { if (!port.dirs.has(path)) missing(path) },
  withTrustedDirectory: async (path: string, callback: (pin: any) => unknown) => {
    const value = info(path)
    if (!value.isDirectory() || value.uid !== 0n || value.gid !== 0n) throw new Error('FIXTURE_DIRECTORY_UNSAFE')
    return callback({ verify: async () => {} })
  },
  readTrustedFile: async (path: string, options: { sha256?: string }) => {
    path = normalized(path)
    const bytes = port.files.get(path) ?? missing(path)
    if (options.sha256 && digest(bytes) !== options.sha256) throw new Error('FIXTURE_HASH_MISMATCH')
    return { bytes, info: info(path), sha256: digest(bytes) }
  },
  withTrustedFile: async (path: string, options: { sha256?: string }, callback: (pin: any) => unknown) => {
    path = normalized(path)
    const bytes = port.files.get(path) ?? missing(path), fd = port.nextFd++
    if (options.sha256 && digest(bytes) !== options.sha256) throw new Error('FIXTURE_HASH_MISMATCH')
    port.fds.set(fd, path)
    try { return await callback({ bytes, fd, info: info(path), sha256: digest(bytes), verify: async () => {} }) }
    finally { port.fds.delete(fd) }
  },
}))
vi.mock('./release-verifier.mjs', async original => ({
  ...await original<typeof import('./release-verifier.mjs')>(),
  withAuthenticatedReleaseArchive: async (_path: string, _trust: unknown, callback: (input: any) => unknown) => ({ report: port.report, value: await callback({ report: port.report }) }),
}))

import { resumePreparedInstallation } from './install-bootstrap.mjs'
const releaseRoot = '/opt/xpanel/releases/0.1.1'
const input = { artifactPath: '/root/releases/old.tar.gz', artifactSha256: 'a'.repeat(64), trustPath: '/root/input-trust.json', keysPath: '/root/input-keys.json' }
const blob = (value: unknown) => Buffer.from(JSON.stringify(value))
const put = (path: string, value: Buffer | string, mode = 0o644) => { port.files.set(normalized(path), Buffer.from(value)); port.modes.set(normalized(path), mode) }

beforeEach(() => {
  port.files.clear(); port.dirs.clear(); port.modes.clear(); port.owners.clear(); port.fds.clear()
  port.writes.length = port.commands.length = 0; port.loadedUnit = false
  port.procStatus = 'Name:\tunit\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n'
  port.threadStatus = ''; port.extraThread = port.foreignView = port.extraAcl = false
  vi.stubEnv('NODE_OPTIONS', ''); vi.stubEnv('NODE_PATH', '')
  for (const path of ['/opt', '/var/lib', '/var/lib/xpanel-lifecycle', releaseRoot, releaseRoot + '/scripts', '/var/lib/xpanel', '/var/lib/xpanel/state', '/var/lib/xpanel/generations', '/proc/99', '/proc/99/task', '/proc/99/task/99', '/proc/99/task/100']) port.dirs.set(path, [])
  port.dirs.set('/var/lib/xpanel', ['state', 'generations'])
  for (const path of ['/var/lib/xpanel', '/var/lib/xpanel/state', '/var/lib/xpanel/generations']) {
    port.owners.set(path, [123, 124]); port.modes.set(path, path === '/var/lib/xpanel' ? 0o2770 : 0o2750)
  }
  const lock = Buffer.from('unit-lock'), manager = Buffer.from('unit-manager'), node = Buffer.from('unit-node')
  put('/opt/node/bin/node', node, 0o755); put('/opt/tools/pnpm', manager, 0o755)
  for (const path of ['/usr/bin/getent', '/usr/bin/systemctl', '/usr/bin/getfacl', fileURLToPath(new URL('./install-bootstrap.mjs', import.meta.url))]) put(path, 'unit-control', 0o755)
  const runtime = { nodePath: '/opt/node/bin/node', nodeSha256: digest(node) }
  const key = Buffer.alloc(48, 17), pair = generateKeyPairSync('ed25519')
  const keys = { schemaVersion: 1, keys: [{ keyId: 'unit-publisher', algorithm: 'ed25519', publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() }] }
  const trust = { keyId: 'unit-archive', signingKeyPath: '/root/input-hmac', packageManagerPath: '/opt/tools/pnpm', packageManagerSha256: digest(manager) }
  put(input.trustPath, blob(trust), 0o600); put(input.keysPath, blob(keys), 0o600); put(trust.signingKeyPath, key, 0o600)
  put('/etc/xpanel/release-trust.json', blob({ ...trust, signingKeyPath: '/etc/xpanel/release-hmac.key' }), 0o600)
  put('/etc/xpanel/release-hmac.key', key, 0o600); put('/etc/xpanel/release-keys.json', blob(keys))
  const controls = ['prepared-release.mjs', 'prepare-lifecycle-release.mjs', 'install-bootstrap.mjs', 'install-finalization.mjs',
    'install-finalization-native.mjs', 'install-finalization-readiness.mjs', 'acquire-lifecycle-release.mjs', 'install-transition-observation.mjs', 'install-bootstrap.d.mts']
  const files = [{ path: 'pnpm-lock.yaml', bytes: lock, mode: 0o644 }, ...controls.map(name => ({ path: 'scripts/' + name, bytes: Buffer.from('unit-control-' + name), mode: 0o644 }))]
  const manifest = { version: '0.1.1', controlDbSchemaVersion: 6, runtime: { nodeVersion: '26.12.1', packageManager: 'pnpm@12.15.0' },
    lockfileSha256: digest(lock), files: files.map(file => ({ path: file.path })) }
  files.push({ path: 'release-manifest.json', bytes: blob(manifest), mode: 0o644 })
  for (const file of files) put(releaseRoot + '/' + file.path, file.bytes, file.mode)
  port.dirs.set(releaseRoot, ['pnpm-lock.yaml', 'scripts', 'release-manifest.json'])
  port.dirs.set(releaseRoot + '/scripts', [...controls].sort())
  const treeEntries = files.filter(file => !file.path.startsWith('scripts/')).sort((a, b) => a.path < b.path ? -1 : 1)
    .map(file => ({ path: file.path, kind: 'file', sha256: digest(file.bytes), bytes: file.bytes.length, mode: file.mode })) as object[]
  treeEntries.push({ path: 'scripts', kind: 'directory', mode: 0o755 })
  for (const file of files.filter(file => file.path.startsWith('scripts/')).sort((a, b) => a.path < b.path ? -1 : 1)) treeEntries.push({ path: file.path, kind: 'file', sha256: digest(file.bytes), bytes: file.bytes.length, mode: file.mode })
  const manifestSha256 = digest(blob(manifest))
  const dependency = { schemaVersion: 1, kind: 'xpanel-installed-dependencies', root: releaseRoot, archiveSha256: input.artifactSha256, manifestSha256,
    controlDbSchemaVersion: 6, nodeVersion: '26.12.1', nodePath: runtime.nodePath, nodeSha256: runtime.nodeSha256,
    packageManager: manifest.runtime.packageManager, lockfileSha256: manifest.lockfileSha256,
    packageManagerPath: trust.packageManagerPath, packageManagerSha256: trust.packageManagerSha256, tree: { treeSha256: digest(blob(treeEntries)) } }
  put('/var/lib/xpanel-lifecycle/install-dependencies.json', blob(dependency), 0o600)
  put('/var/lib/xpanel-lifecycle/bootstrap.json', blob({ schemaVersion: 1, status: 'prepared', createdAt: '2026-01-01T00:00:00Z', version: '0.1.1', releaseRoot,
    archiveSha256: input.artifactSha256, manifestSha256, controlDbSchemaVersion: 6, dependencyReceiptSha256: digest(blob(dependency)), runtime }), 0o600)
  port.dirs.set('/var/lib/xpanel-lifecycle', ['bootstrap.json', 'install-dependencies.json', 'prepared'])
  const prepared = '/var/lib/xpanel-lifecycle/prepared', archiveDirectory = prepared + '/' + input.artifactSha256
  for (const [path, names] of [[prepared, [input.artifactSha256, 'version-0.1.1']], [prepared + '/version-0.1.1', []], [archiveDirectory, ['dependencies.json', 'prepared.json']]] as [string, string[]][]) {
    port.dirs.set(path, names); port.modes.set(path, 0o700)
  }
  put(archiveDirectory + '/dependencies.json', blob(dependency), 0o600)
  put(archiveDirectory + '/prepared.json', blob({ schemaVersion: 1, kind: 'xpanel-prepared-release', releaseRoot, version: '0.1.1',
    archiveSha256: input.artifactSha256, manifestSha256, sourceFilesDigest: digest(blob(manifest.files)), treeSha256: dependency.tree.treeSha256,
    controlDbSchemaVersion: 6, dependencyReceiptPath: archiveDirectory + '/dependencies.json', dependencyReceiptSha256: digest(blob(dependency)),
    runtime: { ...runtime, nodeVersion: '26.12.1', packageManagerPath: trust.packageManagerPath, packageManagerSha256: trust.packageManagerSha256 } }), 0o600)
  port.report = { lifecycleControlsPresent: true, archiveSha256: input.artifactSha256, manifestSha256, manifest, totalUnpackedBytes: 1234,
    entries: files.map(file => ({ path: file.path, type: 'file', bytes: file.bytes.length, mode: file.mode, sha256: digest(file.bytes) })) }
  const payload = `xpanel-release-v1:0.1.1:6:${input.artifactSha256}:1234`
  put('/root/releases/old.manifest.json', blob({ version: '0.1.1', schemaVersion: 6, sha256: input.artifactSha256, bytes: 1234,
    keyId: 'unit-publisher', signature: sign(null, Buffer.from(payload), pair.privateKey).toString('hex') }))
})

describe('read-only admission for the identical early prepared source, with fake native ports', () => {
  it('keeps the old release and returns no activation, extraction, receipt rewrite or native mutation capability', async () => {
    const before = [...port.files].map(([path, bytes]) => [path, digest(bytes)])
    const result = await resumePreparedInstallation(input)
    expect(result).toMatchObject({ status: 'prepared', version: '0.1.1', releaseRoot, installationReceipt: 'pending', resumed: true })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.keys(result)).not.toContain('capability')
    expect([...port.files].map(([path, bytes]) => [path, digest(bytes)])).toEqual(before)
    expect(port.writes).toEqual([])
    expect(port.fds.size).toBe(0)
    expect(port.commands.every(path => ['/usr/bin/getent', '/usr/bin/systemctl', '/usr/bin/getfacl'].includes(path))).toBe(true)
  })
  it.each(['/var/lib/xpanel/control.db', '/var/lib/xpanel/control.db-wal', '/var/lib/xpanel/control.db-shm', '/var/lib/xpanel/install-journal.json', '/etc/xpanel/mariadb-admin.cnf', '/etc/systemd/system/xpanel-api.service'])('refuses persisted effects at %s', async path => {
    put(path, 'existing-effects')
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_EFFECTS_PRESENT')
    expect(port.writes).toEqual([])
  })
  it.each(['HEAD', 'installation.json', 'writer-barrier.json', 'coordinator.json', 'unknown'])('refuses lifecycle state %s', async name => {
    port.dirs.get('/var/lib/xpanel-lifecycle')!.push(name)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_LIFECYCLE_EFFECTS_PRESENT')
  })
  it.each(['bootstrap_pending', 'active', 'preparing'])('does not reinterpret %s as early preparation', async status => {
    const path = '/var/lib/xpanel-lifecycle/bootstrap.json'
    put(path, blob({ ...JSON.parse(port.files.get(path)!.toString()), status }), 0o600)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_PREPARED_REQUIRED')
  })
  it('refuses a loaded unit or any service UID process, including saved credentials', async () => {
    port.loadedUnit = true
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_UNIT_PRESENT')
    port.loadedUnit = false; port.procStatus = 'Uid:\t0\t0\t123\t0\nGid:\t0\t0\t0\t0\nGroups:\t0\n'
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_SERVICE_PROCESS_PRESENT')
  })
  it.each(['Gid:\t0\t124\t0\t0\nGroups:\t0\n', 'Gid:\t0\t0\t0\t0\nGroups:\t0 124\n'])('rejects a live writer through group credentials: %s', async groups => {
    port.procStatus = 'Uid:\t500\t500\t500\t500\n' + groups
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_SERVICE_PROCESS_PRESENT')
    expect(port.fds.size).toBe(0)
  })
  it('checks secondary thread credentials and rejects another PID/service namespace', async () => {
    port.extraThread = true; port.threadStatus = 'Uid:\t500\t500\t500\t500\nGid:\t500\t500\t500\t500\nGroups:\t124\n'
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_SERVICE_PROCESS_PRESENT')
    port.extraThread = false; port.foreignView = true
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_HOST_VIEW_REQUIRED')
  })
  it('accepts the real absent timer shape without process properties and still refuses a loaded timer', async () => {
    await expect(resumePreparedInstallation(input)).resolves.toMatchObject({ resumed: true })
    port.loadedUnit = 'xpanel-management-tls.timer'
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_UNIT_PRESENT')
  })
  it('refuses nonempty service data and ownership or mode drift', async () => {
    port.dirs.get('/var/lib/xpanel/state')!.push('authority.json')
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_STATE_PRESENT')
    port.dirs.set('/var/lib/xpanel/state', []); port.owners.set('/var/lib/xpanel/state', [0, 0])
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_DIRECTORY_UNSAFE')
    port.owners.set('/var/lib/xpanel/state', [123, 124]); port.modes.set('/var/lib/xpanel/state', 0o777)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_DIRECTORY_UNSAFE')
  })
  it('refuses named or default ACLs that give another principal private data access', async () => {
    port.extraAcl = true
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_DIRECTORY_ACL_UNSAFE')
    expect(port.fds.size).toBe(0)
  })
  it.each(['', '/version-0.1.1', '/' + input.artifactSha256])('rejects additional preparation data under %s', async suffix => {
    port.dirs.get('/var/lib/xpanel-lifecycle/prepared' + suffix)!.push('partial-or-other-release')
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_PREPARED_CONTENTS_CHANGED')
    expect(port.writes).toEqual([])
  })
  it('rejects changed prepared proof and duplicate dependency receipt', async () => {
    const directory = '/var/lib/xpanel-lifecycle/prepared/' + input.artifactSha256
    const proof = directory + '/prepared.json', saved = port.files.get(proof)!
    put(proof, blob({ ...JSON.parse(saved.toString()), version: '0.1.2' }), 0o600)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RESUME_PREPARED_PROOF_MISMATCH')
    port.files.set(proof, saved); put(directory + '/dependencies.json', '{}', 0o600)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('FIXTURE_HASH_MISMATCH')
    expect(port.writes).toEqual([])
  })
  it('refuses wrong archive and changed installed source rather than replacing either', async () => {
    await expect(resumePreparedInstallation({ ...input, artifactSha256: 'b'.repeat(64) })).rejects.toThrow('INSTALL_RESUME_PREPARED_REQUIRED')
    put(releaseRoot + '/scripts/install-bootstrap.mjs', 'altered-installed-control')
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_RELEASE_TREE_CHANGED')
  })
  it('does not trust a correct version paired with a changed publisher signature or installed secret', async () => {
    const path = '/root/releases/old.manifest.json', saved = port.files.get(path)!
    put(path, blob({ ...JSON.parse(saved.toString()), signature: '0'.repeat(128) }))
    await expect(resumePreparedInstallation(input)).rejects.toThrow('INSTALL_PUBLISHER_SIGNATURE_INVALID')
    port.files.set(path, saved); put('/etc/xpanel/release-hmac.key', Buffer.alloc(48, 18), 0o600)
    await expect(resumePreparedInstallation(input)).rejects.toThrow('FIXTURE_HASH_MISMATCH')
  })
})
