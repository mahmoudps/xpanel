import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ACCOUNT_FILE_HELPER_SOURCE_PATH = resolve(__dirname, 'xpanel-account-files.c')
export const DEFAULT_ACCOUNT_FILE_HELPER_BINARY_PATH = resolve(__dirname, 'bin', 'xpanel-account-files')

export const COMPILER_FLAGS = Object.freeze([
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-std=gnu11',
  '-fstack-protector-strong',
  '-Wl,-z,relro,-z,now',
  '-Wl,--build-id=none',
])

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function buildAccountFileHelper(options = {}) {
  if (process.platform !== 'linux') {
    throw new Error('xpanel-account-files native helper build requires Linux with gcc and kernel headers')
  }
  const sourcePath = options.sourcePath ?? ACCOUNT_FILE_HELPER_SOURCE_PATH
  const binaryPath = options.outputPath ? resolve(options.outputPath) : DEFAULT_ACCOUNT_FILE_HELPER_BINARY_PATH
  const compiler = options.compiler ?? '/usr/bin/gcc'
  const outDir = dirname(binaryPath)

  mkdirSync(outDir, { recursive: true, mode: 0o755 })
  if (process.getuid?.() === 0 && options.chownRoot !== false) {
    chownSync(outDir, 0, 0)
    chmodSync(outDir, 0o755)
  }

  const args = [...COMPILER_FLAGS, sourcePath, '-o', binaryPath]
  execFileSync(compiler, args, { stdio: 'pipe', timeout: 30_000 })

  chmodSync(binaryPath, 0o755)
  if (process.getuid?.() === 0 && options.chownRoot !== false) {
    chownSync(binaryPath, 0, 0)
  }

  return {
    sourcePath,
    binaryPath,
    compiler,
    flags: COMPILER_FLAGS,
    sourceSha256: sha256File(sourcePath),
    binarySha256: sha256File(binaryPath),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIdx = process.argv.indexOf('--output')
  const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined
  const receipt = buildAccountFileHelper(outputPath ? { outputPath } : {})
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}
