import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const TERMINAL_PTY_HELPER_SOURCE_PATH = resolve(__dirname, 'xpanel-terminal-pty.c')
export const DEFAULT_TERMINAL_PTY_HELPER_BINARY_PATH = resolve(__dirname, 'bin', 'xpanel-terminal-pty')

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

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Same build contract as the account-file helper: Linux gcc, root-owned 0755 output when run as root. */
export function buildTerminalPtyHelper(options = {}) {
  if (process.platform !== 'linux') throw new Error('xpanel-terminal-pty native helper build requires Linux with gcc')
  const sourcePath = options.sourcePath ?? TERMINAL_PTY_HELPER_SOURCE_PATH
  const binaryPath = options.outputPath ? resolve(options.outputPath) : DEFAULT_TERMINAL_PTY_HELPER_BINARY_PATH
  const compiler = options.compiler ?? '/usr/bin/gcc'
  mkdirSync(dirname(binaryPath), { recursive: true, mode: 0o755 })
  execFileSync(compiler, [...COMPILER_FLAGS, sourcePath, '-o', binaryPath, '-lutil'], { stdio: 'pipe', timeout: 30_000 })
  chmodSync(binaryPath, 0o755)
  if (process.getuid?.() === 0 && options.chownRoot !== false) chownSync(binaryPath, 0, 0)
  return { sourcePath, binaryPath, compiler, flags: COMPILER_FLAGS, sourceSha256: sha256File(sourcePath), binarySha256: sha256File(binaryPath) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIdx = process.argv.indexOf('--output')
  const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined
  process.stdout.write(`${JSON.stringify(buildTerminalPtyHelper(outputPath ? { outputPath } : {}), null, 2)}\n`)
}
