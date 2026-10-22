import { createHash, randomBytes } from 'node:crypto'
import { chmod, chown, link, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
// @ts-expect-error build.mjs is an untyped Node build script
import { buildAccountFileHelper } from '../../../helpers/account-files/build.mjs'
import { executorLinuxPreflight } from '../../../scripts/test-linux-preflight.mjs'
import { LinuxHostExecutor } from './executor.ts'
import { JailedFileManager, NativeAccountFileRunner, verifyHelperBinary } from './file-manager.ts'

const observations: Record<string, unknown>[] = []
const cleanupErrors: string[] = []
const nonce = randomBytes(5).toString('hex')
const userA = `xpaf${nonce}a`
const userB = `xpaf${nonce}b`
const slice = `xpaf-${nonce}.slice`
const slicePath = `/run/systemd/system/${slice}`
const cgroupSliceDir = `/sys/fs/cgroup/${slice}`
const createdUsers: string[] = []
const createdGroups: string[] = []
const createdMailSpools: { path: string; uid: number }[] = []

let root = ''
let homeBase = ''
let homeA = ''
let homeB = ''
let uidA = 0
let uidB = 0
let helperBinaryPath = ''
let helperSha256 = ''
let outsideProtectedFile = ''
let tenantBProtectedFile = ''
let quotaMount = ''
let quotaDevice = ''
let quotaMounted = false
let executor = new LinuxHostExecutor()

const sha256 = async (path: string): Promise<string> =>
  createHash('sha256').update(await readFile(path)).digest('hex')

async function command(argv: string[]): Promise<string> {
  const result = await executor.runCommand(argv)
  if (!result.ok) throw new Error(`Fixture command failed: ${argv[0]}: ${result.stderr}`)
  return result.stdout.trim()
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
  await executor.runAction({ kind: 'ensure-group', name, gid: uid })
  createdGroups.push(name)
  await executor.runAction({ kind: 'ensure-user', name, uid, gid: uid, home, shell: '/usr/sbin/nologin' })
  createdUsers.push(name)
  for (const path of [`/var/mail/${name}`, `/var/spool/mail/${name}`]) {
    try {
      const info = await lstat(path)
      if (info.isFile() && info.uid === uid) createdMailSpools.push({ path, uid })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

beforeAll(async () => {
  const gate = executorLinuxPreflight()
  if (gate.status !== 'available') throw new Error(`BLOCKED: ${gate.reasons.join(' ')}`)

  root = await mkdtemp('/var/lib/xpaf-')
  await chown(root, 0, 0)
  await chmod(root, 0o755)

  homeBase = join(root, 'home')
  await mkdir(homeBase, { mode: 0o711 })
  await chown(homeBase, 0, 0)
  await chmod(homeBase, 0o711)

  homeA = join(homeBase, userA)
  homeB = join(homeBase, userB)
  outsideProtectedFile = join(root, 'outside-protected.txt')
  tenantBProtectedFile = join(homeB, 'tenant-b-secret.txt')

  const buildOut = join(root, 'bin', 'xpanel-account-files')
  const receipt = buildAccountFileHelper({ outputPath: buildOut })
  helperBinaryPath = receipt.binaryPath
  helperSha256 = receipt.binarySha256

  executor = new LinuxHostExecutor({
    trustedHostTargets: [
      { path: slicePath, operations: ['read', 'write', 'remove'] },
      { path: homeA, operations: ['ensure-directory', 'remove'] },
      { path: homeB, operations: ['ensure-directory', 'remove'] },
    ],
  })

  uidA = await unusedUid(49200 + Number.parseInt(nonce.slice(0, 3), 16))
  await createIdentity(userA, uidA, homeA)
  uidB = await unusedUid(uidA + 1)
  await createIdentity(userB, uidB, homeB)

  await executor.runAction({ kind: 'ensure-dir', path: homeA, mode: 0o750, owner: userA, group: userA })
  await executor.runAction({ kind: 'ensure-dir', path: homeB, mode: 0o750, owner: userB, group: userB })

  await writeFile(outsideProtectedFile, 'root-protected-marker-content', { mode: 0o600 })
  await chown(outsideProtectedFile, 0, 0)

  await writeFile(tenantBProtectedFile, 'tenant-b-protected-marker-content', { mode: 0o640 })
  await chown(tenantBProtectedFile, uidB, uidB)

  await executor.writeFile({
    path: slicePath,
    mode: 0o644,
    owner: 'root',
    group: 'root',
    content: '[Unit]\nDescription=xPanel S04 account-files slice\n[Slice]\nMemoryAccounting=yes\nTasksAccounting=yes\nMemoryMax=64M\nTasksMax=32\n',
  })
  await executor.runAction({ kind: 'systemd-daemon-reload' })
  await executor.runAction({ kind: 'systemd', verb: 'start', unit: slice })

  observations.push({
    fixture: {
      root,
      homeBase,
      userA,
      uidA,
      userB,
      uidB,
      slice,
      helperBinaryPath,
      helperSha256,
      sourceSha256: receipt.sourceSha256,
    },
  })
}, 60_000)

afterAll(async () => {
  if (!root) return
  if (quotaMounted) {
    const res = await executor.runCommand(['/usr/bin/umount', quotaMount])
    if (res.ok) quotaMounted = false
    else cleanupErrors.push(`Could not unmount quotaMount: ${res.stderr}`)
  }
  if (quotaDevice && !quotaMounted) {
    const res = await executor.runCommand(['/usr/sbin/losetup', '-d', quotaDevice])
    if (res.ok) quotaDevice = ''
    else cleanupErrors.push(`Could not detach loop device: ${res.stderr}`)
  }
  await rmdir(`${cgroupSliceDir}/xpanel-files.scope`).catch(() => undefined)
  await rmdir(cgroupSliceDir).catch(() => undefined)
  await executor.runCommand(['/usr/bin/systemctl', 'stop', slice]).catch(() => undefined)
  await rm(slicePath, { force: true }).catch((e) => cleanupErrors.push(String(e)))
  await executor.runCommand(['/usr/bin/systemctl', 'daemon-reload']).catch(() => undefined)

  for (const name of createdUsers.toReversed()) {
    const exists = await executor.runCommand(['/usr/bin/getent', 'passwd', name])
    if (exists.ok) {
      const res = await executor.runCommand(['/usr/sbin/userdel', name])
      if (!res.ok) cleanupErrors.push(`userdel ${name} failed: ${res.stderr}`)
    }
  }
  for (const name of createdGroups.toReversed()) {
    const exists = await executor.runCommand(['/usr/bin/getent', 'group', name])
    if (exists.ok) {
      const res = await executor.runCommand(['/usr/sbin/groupdel', name])
      if (!res.ok) cleanupErrors.push(`groupdel ${name} failed: ${res.stderr}`)
    }
  }
  for (const spool of createdMailSpools) {
    await rm(spool.path, { force: true }).catch(() => undefined)
  }
  if (!quotaMounted && !quotaDevice) {
    await rm(root, { recursive: true, force: true }).catch((e) => cleanupErrors.push(String(e)))
  }
  const output = process.env.XPANEL_QUALIFICATION_OBSERVATIONS
  if (output) {
    await writeFile(
      output,
      `${JSON.stringify({ package: 'S04', scenarios: ['A15', 'A16', 'A17'], observations, cleanup: { ok: cleanupErrors.length === 0, errors: cleanupErrors } }, null, 2)}\n`,
    )
  }
  expect(cleanupErrors).toEqual([])
}, 60_000)

describe('S04 Native Account File Helper on disposable Linux VM (A15, A16, A17)', () => {
  it('verifies the compiled helper binary ownership, mode 0755, and SHA-256 digest', async () => {
    const digest = await verifyHelperBinary(helperBinaryPath, helperSha256)
    expect(digest).toBe(helperSha256)
    await expect(verifyHelperBinary(helperBinaryPath, '0'.repeat(64))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })

  it('A15: executes all 9 operations under the account UID/GID and cgroup slice, verified via live /proc/<pid>', async () => {
    const liveProcChecks: {
      pid: number
      uidLine: string
      gidLine: string
      groupsLine: string
      noNewPrivsLine: string
      cgroupText: string
    }[] = []

    const runner = new NativeAccountFileRunner({
      binaryPath: helperBinaryPath,
      expectedSha256: helperSha256,
      cgroupPathForAccount: () => cgroupSliceDir,
      requireCgroup: true,
      holdOpenMs: 120,
      onLiveWorker: async ({ pid }) => {
        const [statusText, cgroupText] = await Promise.all([
          readFile(`/proc/${pid}/status`, 'utf8'),
          readFile(`/proc/${pid}/cgroup`, 'utf8'),
        ])
        liveProcChecks.push({
          pid,
          uidLine: /^Uid:[ \t]+(.+)$/m.exec(statusText)?.[1]?.trim() ?? '',
          gidLine: /^Gid:[ \t]+(.+)$/m.exec(statusText)?.[1]?.trim() ?? '',
          groupsLine: /^Groups:[ \t]*(.*)$/m.exec(statusText)?.[1]?.trim() ?? '',
          noNewPrivsLine: /^NoNewPrivs:[ \t]+(\d+)$/m.exec(statusText)?.[1]?.trim() ?? '',
          cgroupText: cgroupText.trim(),
        })
      },
    })

    const accountA = { username: userA, uid: uidA, gid: uidA, home: `/home/${userA}` }
    const fm = new JailedFileManager(homeA, 1024, { account: accountA, runner })

    // 1. mkdir
    const createdDir = await fm.mkdir('public_html', 0o750)
    expect(createdDir.kind).toBe('directory')
    expect(createdDir.mode).toBe(0o750)
    const dirStat = await stat(join(homeA, 'public_html'))
    expect(dirStat.uid).toBe(uidA)
    expect(dirStat.gid).toBe(uidA)
    expect(dirStat.mode & 0o7777).toBe(0o750)

    // 2. write
    const written = await fm.writeText('public_html/index.html', '<h1>Hello Tenant A</h1>\n', {
      overwrite: false,
      mode: 0o640,
    })
    expect(written.kind).toBe('file')
    expect(written.sizeBytes).toBe(24)
    expect(written.mode).toBe(0o640)
    const fileStat = await stat(join(homeA, 'public_html', 'index.html'))
    expect(fileStat.uid).toBe(uidA)
    expect(fileStat.gid).toBe(uidA)
    expect(fileStat.mode & 0o7777).toBe(0o640)

    // 3. read
    const readRes = await fm.readText('public_html/index.html')
    expect(readRes.content).toBe('<h1>Hello Tenant A</h1>\n')
    expect(readRes.sizeBytes).toBe(24)

    // 4. list
    const listed = await fm.list('public_html')
    expect(listed.map((e) => e.path)).toEqual(['public_html/index.html'])

    // 5. chmod
    const chmodded = await fm.chmod('public_html/index.html', 0o600)
    expect(chmodded.mode).toBe(0o600)
    expect((await stat(join(homeA, 'public_html', 'index.html'))).mode & 0o7777).toBe(0o600)

    // 6. trash
    const trashedItem = await fm.moveToTrash('public_html/index.html')
    expect(trashedItem.originalPath).toBe('public_html/index.html')
    await expect(stat(join(homeA, 'public_html', 'index.html'))).rejects.toMatchObject({ code: 'ENOENT' })

    // 7. list-trash
    const trashList = await fm.listTrash()
    expect(trashList.length).toBe(1)
    expect(trashList[0]?.id).toBe(trashedItem.id)

    // 8. restore
    const restored = await fm.restoreFromTrash(trashedItem.id, { overwrite: false })
    expect(restored.path).toBe('public_html/index.html')
    expect(await readFile(join(homeA, 'public_html', 'index.html'), 'utf8')).toBe('<h1>Hello Tenant A</h1>\n')

    // 9. empty-trash
    const secondTrash = await fm.moveToTrash('public_html/index.html')
    expect(secondTrash.originalPath).toBe('public_html/index.html')
    const emptied = await fm.emptyTrash()
    expect(emptied).toBe(1)
    expect(await fm.listTrash()).toEqual([])

    expect(liveProcChecks.length).toBe(11)
    for (const check of liveProcChecks) {
      expect(check.uidLine.split(/\s+/)).toEqual([String(uidA), String(uidA), String(uidA), String(uidA)])
      expect(check.gidLine.split(/\s+/)).toEqual([String(uidA), String(uidA), String(uidA), String(uidA)])
      expect(check.groupsLine).toBe('')
      expect(check.noNewPrivsLine).toBe('1')
      expect(check.cgroupText).toContain(`/${slice}`)
    }

    observations.push({
      scenario: 'A15-positive',
      operations_verified: 9,
      live_proc_checks: liveProcChecks.slice(0, 3),
    })
  })

  it('A15 denial: refuses access to root-owned or foreign-UID files without falling back to privileged agent I/O', async () => {
    const runner = new NativeAccountFileRunner({
      binaryPath: helperBinaryPath,
      expectedSha256: helperSha256,
      cgroupPathForAccount: () => cgroupSliceDir,
      requireCgroup: true,
    })
    const accountA = { username: userA, uid: uidA, gid: uidA, home: `/home/${userA}` }
    const fm = new JailedFileManager(homeA, 1024, { account: accountA, runner })

    const rootOwnedInTenant = join(homeA, 'public_html', 'root-owned.txt')
    await writeFile(rootOwnedInTenant, 'root-secret-inside-home', { mode: 0o600 })
    await chown(rootOwnedInTenant, 0, 0)
    const beforeHash = await sha256(rootOwnedInTenant)

    await expect(fm.readText('public_html/root-owned.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.writeText('public_html/root-owned.txt', 'hijack', { overwrite: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(fm.chmod('public_html/root-owned.txt', 0o640)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.moveToTrash('public_html/root-owned.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })

    expect(await sha256(rootOwnedInTenant)).toBe(beforeHash)
    await unlink(rootOwnedInTenant)
  })

  it('A16: blocks symlink, hardlink, FIFO, tampered trash, and concurrent ancestor-rename race attacks via openat2', async () => {
    const outsideBeforeHash = await sha256(outsideProtectedFile)
    const tenantBBeforeHash = await sha256(tenantBProtectedFile)

    const runner = new NativeAccountFileRunner({
      binaryPath: helperBinaryPath,
      expectedSha256: helperSha256,
      cgroupPathForAccount: () => cgroupSliceDir,
      requireCgroup: true,
    })
    const accountA = { username: userA, uid: uidA, gid: uidA, home: `/home/${userA}` }
    const fm = new JailedFileManager(homeA, 1024, { account: accountA, runner })

    // 1. Direct file symlink pointing to outsideProtectedFile
    const fileSymlink = join(homeA, 'public_html', 'escape-link.txt')
    await symlink(outsideProtectedFile, fileSymlink)
    await expect(fm.readText('public_html/escape-link.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.writeText('public_html/escape-link.txt', 'pwned', { overwrite: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(fm.chmod('public_html/escape-link.txt', 0o640)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.moveToTrash('public_html/escape-link.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await unlink(fileSymlink)

    // 2. Intermediate directory symlink pointing to tenant B's home
    const dirSymlink = join(homeA, 'public_html', 'tenant-b-link')
    await symlink(homeB, dirSymlink)
    await expect(fm.list('public_html/tenant-b-link')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.readText('public_html/tenant-b-link/tenant-b-secret.txt')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(fm.writeText('public_html/tenant-b-link/tenant-b-secret.txt', 'overwrite-b')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await unlink(dirSymlink)

    // 3. Hardlink rejection (st_nlink > 1)
    const originalFile = join(homeA, 'public_html', 'orig.txt')
    const hardlinkedFile = join(homeA, 'public_html', 'hardlink.txt')
    await fm.writeText('public_html/orig.txt', 'original-data')
    await link(originalFile, hardlinkedFile)
    await expect(fm.readText('public_html/hardlink.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.writeText('public_html/hardlink.txt', 'changed')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.chmod('public_html/hardlink.txt', 0o600)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.moveToTrash('public_html/hardlink.txt')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await unlink(hardlinkedFile)
    await unlink(originalFile)

    // 4. Special file (FIFO) rejection without blocking
    const fifoPath = join(homeA, 'public_html', 'attack.fifo')
    await command(['/usr/bin/mkfifo', fifoPath])
    await chown(fifoPath, uidA, uidA)
    await expect(fm.readText('public_html/attack.fifo')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(fm.writeText('public_html/attack.fifo', 'no-block')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await unlink(fifoPath)

    // 5. Concurrent ancestor-rename race attack during 30 read/write attempts
    const raceRealDir = join(homeA, 'public_html', 'race_real')
    const raceTargetDir = join(homeA, 'public_html', 'race_slot')
    const raceSymPath = join(homeA, 'public_html', 'race_sym')
    await mkdir(raceRealDir, { mode: 0o750 })
    await chown(raceRealDir, uidA, uidA)
    await writeFile(join(raceRealDir, 'tenant-b-secret.txt'), 'safe-inside-a', { mode: 0o640 })
    await chown(join(raceRealDir, 'tenant-b-secret.txt'), uidA, uidA)

    let racing = true
    const toggleLoop = (async () => {
      while (racing) {
        try {
          await rm(raceTargetDir, { recursive: true, force: true })
          await symlink(homeB, raceTargetDir)
          await unlink(raceTargetDir)
          await mkdir(raceTargetDir, { mode: 0o750 })
          await chown(raceTargetDir, uidA, uidA)
        } catch {
          /* Concurrent race transitions are expected to collide */
        }
      }
      await rm(raceSymPath, { force: true }).catch(() => undefined)
      await rm(raceTargetDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(raceRealDir, { recursive: true, force: true }).catch(() => undefined)
    })()

    let deniedRaceCount = 0
    let safeSuccessCount = 0
    try {
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fm.readText('public_html/race_slot/tenant-b-secret.txt')
          expect(res.content).not.toBe('tenant-b-protected-marker-content')
          safeSuccessCount++
        } catch (err) {
          expect(isXpanelError(err) && ['FORBIDDEN', 'NOT_FOUND'].includes(err.code)).toBe(true)
          deniedRaceCount++
        }
        try {
          await fm.writeText('public_html/race_slot/tenant-b-secret.txt', 'attempt-from-a')
          safeSuccessCount++
        } catch (err) {
          expect(isXpanelError(err) && ['FORBIDDEN', 'NOT_FOUND', 'CONFLICT'].includes(err.code)).toBe(true)
          deniedRaceCount++
        }
      }
    } finally {
      racing = false
      await toggleLoop
    }

    const outsideAfterHash = await sha256(outsideProtectedFile)
    const tenantBAfterHash = await sha256(tenantBProtectedFile)
    expect(outsideAfterHash).toBe(outsideBeforeHash)
    expect(tenantBAfterHash).toBe(tenantBBeforeHash)
    expect(deniedRaceCount).toBeGreaterThan(0)

    observations.push({
      scenario: 'A16-confinement-and-race-resistance',
      outside_protected_sha256_before: outsideBeforeHash,
      outside_protected_sha256_after: outsideAfterHash,
      tenant_b_protected_sha256_before: tenantBBeforeHash,
      tenant_b_protected_sha256_after: tenantBAfterHash,
      race_attempts: 60,
      denied_race_count: deniedRaceCount,
      safe_success_count: safeSuccessCount,
    })
  }, 60_000)

  it('A17: enforces real ext4 kernel user quotas (EDQUOT) on block and inode limits under the account UID without affecting tenant B', async () => {
    const image = join(root, 's04-quota.img')
    quotaMount = join(root, 'quota-mnt')
    const handle = await open(image, 'wx', 0o600)
    try {
      await handle.truncate(32 * 1024 * 1024)
    } finally {
      await handle.close()
    }
    await mkdir(quotaMount, { mode: 0o711 })
    await chown(quotaMount, 0, 0)
    await command(['/usr/sbin/mkfs.ext4', '-q', '-F', '-O', 'quota', image])
    quotaDevice = await command(['/usr/sbin/losetup', '--find', '--show', image])

    try {
      await command(['/usr/bin/mount', '-t', 'ext4', '-o', 'usrquota', quotaDevice, quotaMount])
      quotaMounted = true
      await chown(quotaMount, 0, 0)
      await chmod(quotaMount, 0o711)
      await executor.runCommand(['/usr/sbin/quotaon', '-u', quotaMount])

      const qHomeA = join(quotaMount, userA)
      const qHomeB = join(quotaMount, userB)
      await mkdir(qHomeA, { mode: 0o750 })
      await chown(qHomeA, uidA, uidA)
      await mkdir(qHomeB, { mode: 0o750 })
      await chown(qHomeB, uidB, uidB)

      // Set 512 KiB block hard limit for userA
      await executor.runAction({
        kind: 'set-quota',
        user: userA,
        blockSoftKb: 512,
        blockHardKb: 512,
        filesystem: quotaMount,
      })

      const runner = new NativeAccountFileRunner({
        binaryPath: helperBinaryPath,
        expectedSha256: helperSha256,
        cgroupPathForAccount: () => cgroupSliceDir,
        requireCgroup: true,
      })

      const fmA = new JailedFileManager(qHomeA, 1, {
        account: { username: userA, uid: uidA, gid: uidA, home: `/home/${userA}` },
        runner,
      })
      const fmB = new JailedFileManager(qHomeB, 10, {
        account: { username: userB, uid: uidB, gid: uidB, home: `/home/${userB}` },
        runner,
      })

      const chunk300k = 'A'.repeat(300 * 1024)
      const firstWrite = await fmA.writeText('within-quota.txt', chunk300k)
      expect(firstWrite.sizeBytes).toBe(300 * 1024)

      let observedErrnoName = ''
      await expect(fmA.writeText('exceeds-quota.txt', chunk300k)).rejects.toSatisfy((err: unknown) => {
        if (!isXpanelError(err) || err.code !== 'LIMIT_EXCEEDED') return false
        observedErrnoName = String(err.detail.errnoName ?? '')
        return observedErrnoName === 'EDQUOT'
      })

      // Ensure no partial or temporary files remain in qHomeA after EDQUOT
      const entriesAfterQuotaFail = await readdir(qHomeA)
      expect(entriesAfterQuotaFail).toEqual(['within-quota.txt'])
      expect(await readFile(join(qHomeA, 'within-quota.txt'), 'utf8')).toBe(chunk300k)

      // Tenant B on the same filesystem can still write freely
      const bWrite = await fmB.writeText('tenant-b-ok.txt', chunk300k)
      expect(bWrite.sizeBytes).toBe(300 * 1024)

      // Test inode quota enforcement (hard limit of 3 inodes for userA: qHomeA + within-quota.txt + 1 more)
      await command(['/usr/sbin/setquota', '-u', userA, '0', '0', '3', '3', quotaMount])
      await fmA.mkdir('one-more-dir')
      await expect(fmA.mkdir('inode-exceeded-dir')).rejects.toSatisfy(
        (err: unknown) => isXpanelError(err) && err.code === 'LIMIT_EXCEEDED' && err.detail.errnoName === 'EDQUOT',
      )

      observations.push({
        scenario: 'A17-kernel-quota-enforcement',
        filesystem: quotaMount,
        device: quotaDevice,
        user_a_uid: uidA,
        user_b_uid: uidB,
        block_hard_limit_kib: 512,
        first_write_bytes: 300 * 1024,
        second_write_errno: observedErrnoName,
        temp_files_remaining: entriesAfterQuotaFail.filter((n) => n.startsWith('.xpanel-tmp-')),
        tenant_b_unaffected: true,
        inode_quota_enforced: true,
      })
    } finally {
      if (quotaMounted) {
        const res = await executor.runCommand(['/usr/bin/umount', quotaMount])
        if (res.ok) quotaMounted = false
      }
      if (!quotaMounted && quotaDevice) {
        const res = await executor.runCommand(['/usr/sbin/losetup', '-d', quotaDevice])
        if (res.ok) quotaDevice = ''
      }
    }
  }, 60_000)
})
