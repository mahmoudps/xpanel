import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyVerifiedKernelPackage } from './install-kernel-package.mjs'

const parent = resolve(tmpdir()), roots: string[] = []
const bytes = Buffer.from('small authenticated package object')
const sha256 = createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(join(parent, 'xpanel-kernel-copy-')); roots.push(root)
  const source = join(root, 'input.deb'), destination = join(root, 'sealed.deb')
  writeFileSync(source, bytes)
  return { root, source, destination }
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== parent || !basename(root).startsWith('xpanel-kernel-copy-')) throw new Error('Unowned package fixture')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('bounded kernel object sealing; ordinary file permissions only, no package execution', () => {
  it('copies exactly the signed bytes into a new object and preserves the original', () => {
    const { source, destination } = fixture()
    const result = copyVerifiedKernelPackage(source, destination, sha256, bytes.length)
    expect(result).toEqual({ sha256, bytes: bytes.length })
    expect(Object.isFrozen(result)).toBe(true)
    expect(readFileSync(source)).toEqual(bytes)
    expect(readFileSync(destination)).toEqual(bytes)
    if (process.platform !== 'win32') expect(lstatSync(destination).mode & 0o777).toBe(0o600)
  })
  it('refuses an existing output without overwriting it', () => {
    const { source, destination } = fixture()
    writeFileSync(destination, 'preserve unknown output')
    expect(() => copyVerifiedKernelPackage(source, destination, sha256, bytes.length)).toThrow()
    expect(readFileSync(destination, 'utf8')).toBe('preserve unknown output')
  })
  it('checks signed size before creating a destination', () => {
    const { source, destination } = fixture()
    writeFileSync(source, Buffer.alloc(64 * 1024))
    expect(() => copyVerifiedKernelPackage(source, destination, sha256, bytes.length)).toThrow('KERNEL_PACKAGE_DOWNLOAD_SHAPE_INVALID')
    expect(existsSync(destination)).toBe(false)
  })
  it('retains a rejected output for diagnosis, without publishing a success record or erasing input', () => {
    const { source, destination } = fixture()
    expect(() => copyVerifiedKernelPackage(source, destination, '0'.repeat(64), bytes.length)).toThrow('KERNEL_PACKAGE_DOWNLOAD_DIGEST_MISMATCH')
    expect(readFileSync(source)).toEqual(bytes)
    expect(readFileSync(destination)).toEqual(bytes)
  })
  it('refuses multiply linked downloads before creating output', () => {
    const { root, source, destination } = fixture()
    linkSync(source, join(root, 'other-link'))
    expect(() => copyVerifiedKernelPackage(source, destination, sha256, bytes.length)).toThrow('KERNEL_PACKAGE_DOWNLOAD_SHAPE_INVALID')
    expect(existsSync(destination)).toBe(false)
  })
  it.each([0, -1, NaN, 512 * 1024 ** 2 + 1])('refuses invalid byte budget %s before I/O', budget => {
    const { source, destination } = fixture()
    expect(() => copyVerifiedKernelPackage(source, destination, sha256, budget)).toThrow('KERNEL_PACKAGE_COPY_INPUT_INVALID')
    expect(existsSync(destination)).toBe(false)
  })
  it.skipIf(process.platform === 'win32')('refuses a FIFO immediately without waiting for a writer', () => {
    const { root, destination } = fixture(), pipe = join(root, 'untrusted-pipe.deb')
    expect(spawnSync('/usr/bin/mkfifo', [pipe]).status).toBe(0)
    expect(() => copyVerifiedKernelPackage(pipe, destination, sha256, bytes.length)).toThrow('KERNEL_PACKAGE_DOWNLOAD_SHAPE_INVALID')
    expect(existsSync(destination)).toBe(false)
  })
})
