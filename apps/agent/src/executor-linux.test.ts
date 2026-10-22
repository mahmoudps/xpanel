import { randomBytes } from 'node:crypto'
import { chmod, chown, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executorLinuxPreflight } from '../../../scripts/test-linux-preflight.mjs'
import { LinuxHostExecutor } from './executor.ts'

const observations: Record<string, unknown>[] = []
const cleanupErrors: string[] = []
const nonce = randomBytes(5).toString('hex')
const userA = `xpq${nonce}a`
const userB = `xpq${nonce}b`
const userC = `xpq${nonce}c`
const service = `xpq${nonce}.service`
const slice = `xpq${nonce}.slice`
const servicePath = `/run/systemd/system/${service}`
const slicePath = `/run/systemd/system/${slice}`
const createdUsers: string[] = []
const createdGroups: string[] = []
const createdUnitFiles: string[] = []
const createdMailSpools: { path: string; uid: number }[] = []
let root = ''
let uidA = 0
let uidB = 0
let uidC = 0
let homeA = ''
let homeB = ''
let ownedFile = ''
let replacementFile = ''
let ownerErrorFile = ''
let missingFile = ''
let invalidUnitFile = ''
let deniedFile = ''
let removalDirectory = ''
let badOwnerDirectory = ''
let quotaMount = ''
let quotaDevice = ''
let quotaMounted = false
let quotaEnforcement = 'not_run'
let executor = new LinuxHostExecutor()

async function command(argv: string[]): Promise<string> {
  const result = await executor.runCommand(argv)
  if (!result.ok) throw new Error(`Fixture command failed: ${argv[0]}: ${result.stderr}`)
  return result.stdout.trim()
}

async function unitProperty(name: string): Promise<string> {
  return command(['/usr/bin/systemctl', 'show', service, `--property=${name}`, '--value'])
}

async function unusedUid(base: number): Promise<number> {
  for (let candidate = base; candidate < base + 1000; candidate++) {
    const user = await executor.runCommand(['/usr/bin/getent', 'passwd', String(candidate)])
    const group = await executor.runCommand(['/usr/bin/getent', 'group', String(candidate)])
    if (user.code === 2 && group.code === 2) return candidate
  }
  throw new Error('No unused fixture UID/GID was available')
}

async function createIdentity(name: string, uid: number, home: string): Promise<void> {
  expect((await executor.runCommand(['/usr/bin/getent', 'passwd', name])).code).toBe(2)
  expect((await executor.runCommand(['/usr/bin/getent', 'group', name])).code).toBe(2)
  const mailPaths = [`/var/mail/${name}`, `/var/spool/mail/${name}`]
  for (const path of mailPaths) {
    try { await lstat(path); throw new Error(`Fixture mail spool already exists: ${path}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  await executor.runAction({ kind: 'ensure-group', name, gid: uid })
  createdGroups.push(name)
  await executor.runAction({ kind: 'ensure-user', name, uid, gid: uid, home, shell: '/usr/sbin/nologin' })
  createdUsers.push(name)
  for (const path of mailPaths) {
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.uid !== uid) throw new Error(`Unexpected fixture mail spool ownership: ${path}`)
      createdMailSpools.push({ path, uid })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

beforeAll(async () => {
  const gate = executorLinuxPreflight()
  if (gate.status !== 'available') throw new Error(`BLOCKED: ${gate.reasons.join(' ')}`)
  root = await mkdtemp('/var/tmp/xpq-')
  await chmod(root, 0o711)
  homeA = join(root, 'home-a')
  homeB = join(root, 'home-b')
  ownedFile = join(root, 'owned.conf')
  replacementFile = join(root, 'replacement.conf')
  ownerErrorFile = join(root, 'owner-error.conf')
  missingFile = join(root, 'missing.conf')
  invalidUnitFile = join(root, 'invalid.service')
  deniedFile = join(root, 'denied.conf')
  removalDirectory = join(root, 'removal')
  badOwnerDirectory = join(root, 'bad-owner')
  for (const path of [servicePath, slicePath, `/etc/systemd/system.control/${service}.d`, `/run/systemd/system.control/${service}.d`]) {
    try { await lstat(path); throw new Error(`Fixture target already exists: ${path}`) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const fileOperations = ['read', 'write', 'remove'] as const
  const directoryOperations = ['ensure-directory', 'remove'] as const
  executor = new LinuxHostExecutor({
    trustedHostTargets: [
      ...[ownedFile, replacementFile, ownerErrorFile, missingFile, invalidUnitFile, servicePath, slicePath, join(removalDirectory, 'child')].map(path => ({ path, operations: fileOperations })),
      ...[homeA, homeB, removalDirectory, badOwnerDirectory].map(path => ({ path, operations: directoryOperations })),
    ],
  })
  uidA = await unusedUid(48000 + Number.parseInt(nonce.slice(0, 3), 16))
  await createIdentity(userA, uidA, homeA)
  uidB = await unusedUid(uidA + 1)
  await createIdentity(userB, uidB, homeB)
  uidC = await unusedUid(uidB + 1)
  await createIdentity(userC, uidC, join(root, 'home-c'))
  await executor.runAction({ kind: 'ensure-dir', path: homeA, mode: 0o750, owner: userA, group: userA })
  await executor.runAction({ kind: 'ensure-dir', path: homeB, mode: 0o750, owner: userB, group: userB })
  await executor.writeFile({ path: ownerErrorFile, content: 'previous-valid-generation', mode: 0o640, owner: 'root', group: 'root' })
  await executor.writeFile({ path: slicePath, mode: 0o644, owner: 'root', group: 'root', content: '[Unit]\nDescription=xPanel qualification fixture slice\n[Slice]\nMemoryAccounting=yes\nTasksAccounting=yes\n' })
  createdUnitFiles.push(slicePath)
  await executor.writeFile({ path: servicePath, mode: 0o644, owner: 'root', group: 'root', content: `[Unit]\nDescription=xPanel qualification fixture process\n[Service]\nType=simple\nUser=${userA}\nGroup=${userA}\nSlice=${slice}\nExecStart=/usr/bin/sleep 300\nExecReload=/usr/bin/false\nMemoryMax=64M\nTasksMax=32\n` })
  createdUnitFiles.push(servicePath)
  await executor.runAction({ kind: 'systemd-daemon-reload' })
  await executor.runAction({ kind: 'systemd', verb: 'start', unit: service })
  observations.push({ fixture: { root, usernames: [userA, userB, userC], uids: [uidA, uidB, uidC], service, slice }, executor: 'LinuxHostExecutor', fake_executor: false })
}, 60_000)

afterAll(async () => {
  if (!root) return
  if (quotaMounted) {
    const result = await executor.runCommand(['/usr/bin/umount', quotaMount])
    if (result.ok) quotaMounted = false
    else cleanupErrors.push(`Could not unmount quota fixture: ${result.stderr}`)
  }
  if (quotaDevice && !quotaMounted) {
    const result = await executor.runCommand(['/usr/sbin/losetup', '-d', quotaDevice])
    if (!result.ok) cleanupErrors.push(`Could not detach quota fixture device: ${result.stderr}`)
    else quotaDevice = ''
  }
  const createdUnits = [service, slice].filter(unit => createdUnitFiles.includes(`/run/systemd/system/${unit}`))
  for (const unit of createdUnits) {
    const result = await executor.runCommand(['/usr/bin/systemctl', 'stop', unit])
    if (!result.ok) cleanupErrors.push(`Could not stop ${unit}: ${result.stderr}`)
  }
  const propertyPaths = createdUnitFiles.includes(servicePath) ? [`/etc/systemd/system.control/${service}.d`, `/run/systemd/system.control/${service}.d`] : []
  for (const path of [...createdUnitFiles, ...propertyPaths]) {
    try { await rm(path, { recursive: true, force: true }) }
    catch (error) { cleanupErrors.push(`Could not remove fixture target ${path}: ${String(error)}`) }
  }
  const reload = await executor.runCommand(['/usr/bin/systemctl', 'daemon-reload'])
  if (!reload.ok) cleanupErrors.push(`Could not reload systemd after cleanup: ${reload.stderr}`)
  if (createdUnits.includes(service)) await executor.runCommand(['/usr/bin/systemctl', 'reset-failed', service])
  for (const name of createdUsers.toReversed()) {
    const exists = await executor.runCommand(['/usr/bin/getent', 'passwd', name])
    if (exists.ok) {
      const result = await executor.runCommand(['/usr/sbin/userdel', name])
      if (!result.ok) cleanupErrors.push(`Could not remove fixture user ${name}: ${result.stderr}`)
    }
  }
  for (const name of createdGroups.toReversed()) {
    const exists = await executor.runCommand(['/usr/bin/getent', 'group', name])
    if (exists.ok) {
      const result = await executor.runCommand(['/usr/sbin/groupdel', name])
      if (!result.ok) cleanupErrors.push(`Could not remove fixture group ${name}: ${result.stderr}`)
    } else if (exists.code !== 2) cleanupErrors.push(`Could not establish fixture group absence: ${name}`)
  }
  for (const spool of createdMailSpools) {
    try {
      const info = await lstat(spool.path)
      if (!info.isFile() || info.uid !== spool.uid) throw new Error('Fixture mail spool ownership changed; removal refused')
      await rm(spool.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(`Could not remove fixture mail spool: ${String(error)}`)
    }
  }
  try { if (!quotaMounted && !quotaDevice) await rm(root, { recursive: true, force: true }) }
  catch (error) { cleanupErrors.push(`Could not remove fixture directory: ${String(error)}`) }
  for (const name of createdUsers) if ((await executor.runCommand(['/usr/bin/getent', 'passwd', name])).ok) cleanupErrors.push(`Fixture user remains: ${name}`)
  for (const name of createdGroups) if ((await executor.runCommand(['/usr/bin/getent', 'group', name])).ok) cleanupErrors.push(`Fixture group remains: ${name}`)
  const cleanup = { ok: cleanupErrors.length === 0, errors: cleanupErrors }
  const output = process.env.XPANEL_QUALIFICATION_OBSERVATIONS
  if (output) await writeFile(output, `${JSON.stringify({ observations, cleanup, positive_quota_enforcement: quotaEnforcement, apache_php_workload_isolation: 'not_run', firewall_traffic_isolation: 'not_run' }, null, 2)}\n`)
  expect(cleanupErrors).toEqual([])
}, 60_000)

describe('Real LinuxHostExecutor on an explicitly acknowledged disposable VM', () => {
  it('executes a real command and observes root UID', async () => {
    expect(await command(['/usr/bin/id', '-u'])).toBe('0')
  })

  it('creates the requested GID in the real account database', async () => {
    expect((await command(['/usr/bin/getent', 'group', userA])).split(':')[2]).toBe(String(uidA))
  })

  it('creates the requested UID/GID/home/shell in the real account database', async () => {
    const record = (await command(['/usr/bin/getent', 'passwd', userA])).split(':')
    expect(record[2]).toBe(String(uidA))
    expect(record[3]).toBe(String(uidA))
    expect(record[5]).toBe(homeA)
    expect(record[6]).toBe('/usr/sbin/nologin')
  })

  it('repeating the same ensure-user preserves the expected identity', async () => {
    await executor.runAction({ kind: 'ensure-user', name: userA, uid: uidA, gid: uidA, home: homeA, shell: '/usr/sbin/nologin' })
    expect(await command(['/usr/bin/id', '-u', userA])).toBe(String(uidA))
    expect(await command(['/usr/bin/id', '-g', userA])).toBe(String(uidA))
  })

  it('ensures the reviewed directory mode and ownership', async () => {
    const info = await stat(homeA)
    expect(info.mode & 0o777).toBe(0o750)
    expect(info.uid).toBe(uidA)
    expect(info.gid).toBe(uidA)
  })

  it('publishes a real atomic file with requested bytes, mode and ownership', async () => {
    await executor.writeFile({ path: ownedFile, content: 'xpq-owned-content', mode: 0o640, owner: userA, group: userA })
    const info = await stat(ownedFile)
    expect(await readFile(ownedFile, 'utf8')).toBe('xpq-owned-content')
    expect(info.mode & 0o777).toBe(0o640)
    expect(info.uid).toBe(uidA)
    expect(info.gid).toBe(uidA)
  })

  it('replaces a reviewed file through a new inode without a temporary-file leak', async () => {
    await executor.writeFile({ path: replacementFile, content: 'old', mode: 0o640, owner: 'root', group: 'root' })
    const old = await stat(replacementFile)
    await executor.writeFile({ path: replacementFile, content: 'new', mode: 0o600, owner: 'root', group: 'root' })
    const current = await stat(replacementFile)
    expect(current.ino).not.toBe(old.ino)
    expect(current.mode & 0o777).toBe(0o600)
    expect(await executor.readFile(replacementFile)).toBe('new')
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('returns null for an absent reviewed file', async () => {
    expect(await executor.readFile(missingFile)).toBeNull()
  })

  it('reports the actual nonzero command exit code', async () => {
    const result = await executor.runCommand(['/usr/bin/false'])
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
  })

  it('fails closed when the requested binary does not exist', async () => {
    const result = await executor.runCommand([join(root, 'missing-binary')])
    expect(result.ok).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toBe('')
  })

  it('runs an exec action as the requested account rather than root', async () => {
    const path = join(homeA, 'runuser-marker')
    await executor.runAction({ kind: 'exec', argv: ['/usr/bin/touch', path], runAsUser: userA })
    const info = await stat(path)
    expect(info.uid).toBe(uidA)
    expect(info.gid).toBe(uidA)
    observations.push({ run_as_user: userA, actual_file_uid: info.uid, actual_file_gid: info.gid })
  })

  it('denies a different UID access to a private fixture file', async () => {
    const path = join(homeB, 'private-marker')
    await executor.runAction({ kind: 'exec', argv: ['/usr/bin/touch', path], runAsUser: userB })
    const result = await executor.runCommand(['/usr/sbin/runuser', '-u', userA, '--', '/usr/bin/cat', path])
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('Permission denied')
    observations.push({ uid_access_probe: { actor_uid: uidA, target_uid: uidB, exit_code: result.code, denied: true }, scope: 'UID filesystem primitive, not tenant helper or Apache workload proof' })
  })

  it('propagates a failed exec action instead of acknowledging success', async () => {
    await expect(executor.runAction({ kind: 'exec', argv: ['/usr/bin/false'] })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
  })

  it('runs a real systemd service configuration verifier successfully', async () => {
    const result = await executor.runTest({ name: 'systemd-valid-fixture', argv: ['/usr/bin/systemd-analyze', 'verify', servicePath] })
    expect(result.ok, result.stderr).toBe(true)
    expect(result.code).toBe(0)
  })

  it('reports a real service configuration syntax failure', async () => {
    await executor.writeFile({ path: invalidUnitFile, mode: 0o644, owner: 'root', group: 'root', content: '[Service]\nType=oneshot\nExecStart=\n' })
    const result = await executor.runTest({ name: 'systemd-invalid-fixture', argv: ['/usr/bin/systemd-analyze', 'verify', invalidUnitFile] })
    expect(result.ok).toBe(false)
    expect(result.code).not.toBe(0)
    expect(result.stderr).not.toBe('')
  })

  it('observes the real service PID under its account UID and actual cgroup', async () => {
    const pid = Number(await unitProperty('MainPID'))
    expect(pid).toBeGreaterThan(1)
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    expect(/^Uid:\s+(\d+)/m.exec(status)?.[1]).toBe(String(uidA))
    const cgroup = await unitProperty('ControlGroup')
    expect(cgroup).toContain(slice)
    expect(await readFile(`/proc/${pid}/cgroup`, 'utf8')).toContain(cgroup)
    observations.push({ systemd_probe: { main_pid: pid, actual_uid: uidA, actual_cgroup: cgroup, unit: service }, scope: 'sleep process identity and cgroup membership; not Apache/PHP workload' })
  })

  it('applies real systemd resource properties visible in cgroup v2', async () => {
    await executor.runAction({ kind: 'systemd-set-property', unit: service, properties: { MemoryMax: '33554432', TasksMax: '16' } })
    const cgroup = await unitProperty('ControlGroup')
    const memory = (await readFile(`/sys/fs/cgroup${cgroup}/memory.max`, 'utf8')).trim()
    const pids = (await readFile(`/sys/fs/cgroup${cgroup}/pids.max`, 'utf8')).trim()
    expect(memory).toBe('33554432')
    expect(pids).toBe('16')
    observations.push({ cgroup_limits: { path: cgroup, memory_max: memory, pids_max: pids }, load_enforcement_stress_test: 'not_run' })
  })

  it('propagates real systemd reload failure and leaves the existing process observable', async () => {
    await expect(executor.runAction({ kind: 'systemd', verb: 'reload', unit: service })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(await unitProperty('ActiveState')).toBe('active')
    expect(Number(await unitProperty('MainPID'))).toBeGreaterThan(1)
  })

  it('refuses an unreviewed path before reading or modifying the marker', async () => {
    await writeFile(deniedFile, 'unreviewed-marker')
    await expect(executor.readFile(deniedFile)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(executor.writeFile({ path: deniedFile, content: 'must-not-publish', mode: 0o600 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await readFile(deniedFile, 'utf8')).toBe('unreviewed-marker')
  })

  it('fails ownership changes before publishing new bytes', async () => {
    await expect(executor.writeFile({ path: ownerErrorFile, content: 'must-not-publish', mode: 0o640, owner: `xpq${nonce}missing`, group: 'root' })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    expect(await readFile(ownerErrorFile, 'utf8')).toBe('previous-valid-generation')
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('fails closed for SQL when no real SQL runner is configured', async () => {
    await expect(executor.runAction({ kind: 'sql', engine: 'mariadb', statements: ['SELECT 1'] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('bounds a real sleeping child with the configured command timeout', async () => {
    const bounded = new LinuxHostExecutor({ timeoutMs: 100 })
    const result = await bounded.runCommand(['/usr/bin/sleep', '30'])
    expect(result.ok).toBe(false)
    expect(result.code).not.toBe(0)
  })

  it('rejects shell metacharacters without invoking a shell or creating a marker', async () => {
    const path = join(root, 'must-not-exist')
    const attempt = async () => executor.runCommand(['/usr/bin/touch', `${path};id`])
    await expect(attempt()).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a reviewed child and then its empty reviewed parent', async () => {
    await executor.runAction({ kind: 'ensure-dir', path: removalDirectory, mode: 0o700, owner: 'root', group: 'root' })
    await writeFile(join(removalDirectory, 'child'), 'fixture')
    await executor.runAction({ kind: 'remove-path', path: join(removalDirectory, 'child') })
    await executor.runAction({ kind: 'remove-path', path: removalDirectory })
    await expect(stat(removalDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await stat(root)).toBeDefined()
  })

  it('propagates directory ownership errors', async () => {
    await expect(executor.runAction({ kind: 'ensure-dir', path: badOwnerDirectory, mode: 0o700, owner: `xpq${nonce}missing`, group: 'root' })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    await expect(stat(badOwnerDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces the actual executor quota on a private loop image and removes the limit', async () => {
    const image = join(root, 'quota.img')
    quotaMount = join(root, 'quota-mount')
    const handle = await open(image, 'wx', 0o600)
    try { await handle.truncate(32 * 1024 * 1024) }
    finally { await handle.close() }
    await mkdir(quotaMount, { mode: 0o755 })
    await command(['/usr/sbin/mkfs.ext4', '-q', '-F', '-O', 'quota', image])
    quotaDevice = await command(['/usr/sbin/losetup', '--find', '--show', image])
    expect(quotaDevice).toMatch(/^\/dev\/loop\d+$/)
    try {
      await command(['/usr/bin/mount', '-t', 'ext4', '-o', 'usrquota', quotaDevice, quotaMount])
      quotaMounted = true
      const quotaOn = await executor.runCommand(['/usr/sbin/quotaon', '-u', quotaMount])
      observations.push({ quota_enable: { exit_code: quotaOn.code, stdout: quotaOn.stdout, stderr: quotaOn.stderr }, scope: 'Private ext4 image; quota may already be enabled by its on-disk quota feature' })
      const directory = join(quotaMount, 'account')
      await mkdir(directory, { mode: 0o750 })
      await chown(directory, uidA, uidA)
      await executor.runAction({ kind: 'set-quota', user: userA, blockSoftKb: 512, blockHardKb: 512, filesystem: quotaMount })
      const limitedPath = join(directory, 'limited.bin')
      const limited = await executor.runCommand(['/usr/sbin/runuser', '-u', userA, '--', '/usr/bin/dd', 'if=/dev/zero', `of=${limitedPath}`, 'bs=4096', 'count=512', 'status=none'])
      expect(limited.ok).toBe(false)
      expect(limited.stderr).toContain('Disk quota exceeded')
      const limitedSize = (await stat(limitedPath)).size
      expect(limitedSize).toBeLessThanOrEqual(512 * 1024)
      await executor.runAction({ kind: 'set-quota', user: userA, blockSoftKb: 0, blockHardKb: 0, filesystem: quotaMount })
      const unlimitedPath = join(directory, 'unlimited.bin')
      const unlimited = await executor.runCommand(['/usr/sbin/runuser', '-u', userA, '--', '/usr/bin/dd', 'if=/dev/zero', `of=${unlimitedPath}`, 'bs=4096', 'count=512', 'status=none'])
      expect(unlimited.ok, unlimited.stderr).toBe(true)
      expect((await stat(unlimitedPath)).size).toBe(2 * 1024 * 1024)
      quotaEnforcement = 'passed'
      observations.push({ quota_enforcement: { filesystem: quotaMount, device: quotaDevice, user_uid: uidA, hard_limit_kib: 512, denied_exit_code: limited.code, denied_error: limited.stderr.trim(), partial_bytes: limitedSize, removed_limit_write_bytes: 2 * 1024 * 1024 }, rootfs_mount_options_changed: false })
    } finally {
      if (quotaMounted) {
        const result = await executor.runCommand(['/usr/bin/umount', quotaMount])
        if (result.ok) quotaMounted = false
        else cleanupErrors.push(`Could not unmount private quota filesystem: ${result.stderr}`)
      }
      if (!quotaMounted && quotaDevice) {
        const result = await executor.runCommand(['/usr/sbin/losetup', '-d', quotaDevice])
        if (result.ok) quotaDevice = ''
        else cleanupErrors.push(`Could not detach private quota loop device: ${result.stderr}`)
      }
    }
  }, 60_000)

  it('deletes a fixture account in the actual account database', async () => {
    await executor.runAction({ kind: 'delete-user', name: userC })
    expect((await executor.runCommand(['/usr/bin/getent', 'passwd', userC])).code).toBe(2)
  })
})
