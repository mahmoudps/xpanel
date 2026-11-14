import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { verifyHelperBinary } from './account-file-runner.ts'
import { readInstalledHelperDigest, type HelperDigestFiles } from './installed-helper-digest.ts'

export const ACCOUNT_FILE_HELPER_COMPILER_FLAGS = Object.freeze([
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-std=gnu11',
  '-fstack-protector-strong',
  '-Wl,-z,relro,-z,now',
  '-Wl,--build-id=none',
])

const DEFAULT_SOURCE_PATH = fileURLToPath(new URL('../../../helpers/account-files/xpanel-account-files.c', import.meta.url))

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export interface RefreshAccountFileHelperOptions {
  readonly sourcePath?: string
  readonly compilerPath?: string
  readonly digestFiles?: HelperDigestFiles
  readonly chownRoot?: boolean
  readonly verifyBinary?: (binaryPath: string, expectedSha256?: string) => Promise<string>
  readonly compile?: (compiler: string, args: readonly string[]) => void
}

/**
 * Rebuilds the root-owned `xpanel-account-files` binary across release upgrades when the existing installed
 * binary still matches its `.sha256` receipt and the release's `xpanel-account-files.c` source has advanced.
 * Any tampered binary fails `verifyHelperBinary` before compilation can run.
 */
export async function refreshAccountFileHelperIfStale(
  binaryPath: string,
  options: RefreshAccountFileHelperOptions = {},
): Promise<'unchanged' | 'refreshed' | 'skipped'> {
  if (!existsSync(binaryPath)) return 'skipped'
  const digest = await readInstalledHelperDigest(binaryPath, options.digestFiles)
  if (!digest) return 'skipped'
  const verify = options.verifyBinary ?? verifyHelperBinary
  await verify(binaryPath, digest)

  const sourcePath = options.sourcePath ?? DEFAULT_SOURCE_PATH
  const compilerPath = options.compilerPath ?? '/usr/bin/gcc'
  if (!existsSync(sourcePath) || (!options.compile && !existsSync(compilerPath))) return 'skipped'

  const sourceSha256 = sha256Hex(readFileSync(sourcePath))
  const recordedSource = await readInstalledHelperDigest(binaryPath + '.source', options.digestFiles)
  if (recordedSource === sourceSha256) return 'unchanged'

  const suffix = `.${process.pid}.new`
  const nextBinary = binaryPath + suffix
  const nextDigest = binaryPath + '.sha256' + suffix
  const nextSource = binaryPath + '.source.sha256' + suffix
  const chownRoot = options.chownRoot ?? (process.getuid?.() === 0)
  try {
    const args = [...ACCOUNT_FILE_HELPER_COMPILER_FLAGS, sourcePath, '-o', nextBinary]
    if (options.compile) options.compile(compilerPath, args)
    else execFileSync(compilerPath, args, { stdio: 'pipe', timeout: 30_000 })
    chmodSync(nextBinary, 0o755)
    if (chownRoot) chownSync(nextBinary, 0, 0)
    const binarySha256 = sha256Hex(readFileSync(nextBinary))
    writeFileSync(nextDigest, `${binarySha256}\n`, { mode: 0o644 })
    writeFileSync(nextSource, `${sourceSha256}\n`, { mode: 0o644 })
    chmodSync(nextDigest, 0o644)
    chmodSync(nextSource, 0o644)
    if (chownRoot) {
      chownSync(nextDigest, 0, 0)
      chownSync(nextSource, 0, 0)
    }
    renameSync(nextBinary, binaryPath)
    renameSync(nextDigest, binaryPath + '.sha256')
    renameSync(nextSource, binaryPath + '.source.sha256')
    return 'refreshed'
  } catch (error) {
    rmSync(nextBinary, { force: true })
    rmSync(nextDigest, { force: true })
    rmSync(nextSource, { force: true })
    process.stderr.write(`xpanel-agent file helper refresh skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    return 'skipped'
  }
}
