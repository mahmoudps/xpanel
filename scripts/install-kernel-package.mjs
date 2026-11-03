import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, fsyncSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])

/** Copy one bounded signed object from an untrusted download. No authority, package execution or cleanup is conferred. */
export function copyVerifiedKernelPackage(source, destination, expectedSha256, expectedBytes) {
  check(typeof source === 'string' && typeof destination === 'string' && source !== destination
    && typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256)
    && Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= 512 * 1024 ** 2, 'KERNEL_PACKAGE_COPY_INPUT_INVALID')
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let output
  try {
    const before = fstatSync(input, { bigint: true })
    check(before.isFile() && before.nlink === 1n && before.size === BigInt(expectedBytes), 'KERNEL_PACKAGE_DOWNLOAD_SHAPE_INVALID')
    check(same(before, lstatSync(source, { bigint: true })), 'KERNEL_PACKAGE_DOWNLOAD_CHANGED')
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const named = fstatSync(output, { bigint: true }), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    while (true) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, expectedBytes - total + 1), null)
      if (count === 0) break
      check(total + count <= expectedBytes, 'KERNEL_PACKAGE_DOWNLOAD_GREW')
      hash.update(buffer.subarray(0, count))
      let offset = 0
      while (offset < count) {
        const wrote = writeSync(output, buffer, offset, count - offset)
        check(wrote > 0, 'KERNEL_PACKAGE_COPY_SHORT_WRITE')
        offset += wrote
      }
      total += count
    }
    check(total === expectedBytes && hash.digest('hex') === expectedSha256, 'KERNEL_PACKAGE_DOWNLOAD_DIGEST_MISMATCH')
    check(same(before, fstatSync(input, { bigint: true })) && same(before, lstatSync(source, { bigint: true })), 'KERNEL_PACKAGE_DOWNLOAD_CHANGED')
    fsyncSync(output)
    const after = fstatSync(output, { bigint: true }), target = lstatSync(destination, { bigint: true })
    check(after.isFile() && after.dev === named.dev && after.ino === named.ino && after.size === BigInt(expectedBytes)
      && after.nlink === 1n && (process.platform === 'win32' || (after.mode & 0o777n) === 0o600n)
      && same(after, target), 'KERNEL_PACKAGE_COPY_TARGET_CHANGED')
    return Object.freeze({ sha256: expectedSha256, bytes: total })
  } finally {
    if (output !== undefined) closeSync(output)
    closeSync(input)
  }
}

if (import.meta.main) {
  try {
    const [source, destination, sha256, bytes, ...extra] = process.argv.slice(2)
    check(process.platform === 'linux' && process.getuid() === 0 && process.geteuid() === 0
      && process.getgid() === 0 && process.getegid() === 0, 'KERNEL_PACKAGE_COPY_ROOT_REQUIRED')
    check(extra.length === 0 && /^(?:[1-9][0-9]{0,9})$/.test(bytes ?? ''), 'KERNEL_PACKAGE_COPY_INPUT_INVALID')
    const match = /^\/var\/lib\/xpanel-kernel-inputs\/snapshot\.[A-Za-z0-9]{8}\/download\/([A-Za-z0-9._+%~:-]+\.deb)$/.exec(source ?? '')
    check(match && destination === dirname(dirname(source)) + '/authenticated.deb', 'KERNEL_PACKAGE_COPY_LOCATION_INVALID')
    let parent = dirname(destination)
    check(realpathSync(parent) === parent && realpathSync(dirname(source)) === dirname(source), 'KERNEL_PACKAGE_COPY_LOCATION_INVALID')
    while (true) {
      const info = lstatSync(parent)
      check(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && info.gid === 0 && (info.mode & 0o022) === 0, 'KERNEL_PACKAGE_COPY_PARENT_UNSAFE')
      if (parent === '/') break
      parent = dirname(parent)
    }
    copyVerifiedKernelPackage(source, destination, sha256, Number(bytes))
    process.stdout.write('{"status":"kernel-package-sealed"}\n')
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'KERNEL_PACKAGE_COPY_UNCONFIRMED'
    process.stderr.write(JSON.stringify({ status: 'blocked', code, partialOutputRetained: true }) + '\n')
    process.exitCode = 3
  }
}
