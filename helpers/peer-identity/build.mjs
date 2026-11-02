import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PEER_IDENTITY_C_SOURCE } from '../../apps/agent/src/peer-identity-source.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const DEFAULT_PEER_IDENTITY_ADDON_PATH = resolve(__dirname, 'bin', 'xpanel-peer-identity.node')

// The same flags the agent uses when it compiles this source itself.
export const COMPILER_FLAGS = Object.freeze(['-shared', '-fPIC', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror'])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Same build contract as the other native helpers: Linux gcc, root-owned 0755 output when run as root. */
export function buildPeerIdentityAddon(options = {}) {
  if (process.platform !== 'linux') throw new Error('xpanel-peer-identity native addon build requires Linux with gcc')
  const binaryPath = options.outputPath ? resolve(options.outputPath) : DEFAULT_PEER_IDENTITY_ADDON_PATH
  const compiler = options.compiler ?? '/usr/bin/gcc'
  const work = mkdtempSync(join(tmpdir(), 'xpanel-peer-identity-'))
  try {
    const sourcePath = join(work, 'xpanel-peer-identity.c')
    writeFileSync(sourcePath, PEER_IDENTITY_C_SOURCE, { mode: 0o600 })
    mkdirSync(dirname(binaryPath), { recursive: true, mode: 0o755 })
    execFileSync(compiler, [...COMPILER_FLAGS, '-o', binaryPath, sourcePath], { stdio: 'pipe', timeout: 30_000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  chmodSync(binaryPath, 0o755)
  if (process.getuid?.() === 0 && options.chownRoot !== false) chownSync(binaryPath, 0, 0)
  return { binaryPath, compiler, flags: COMPILER_FLAGS, sourceSha256: sha256(PEER_IDENTITY_C_SOURCE), binarySha256: sha256(readFileSync(binaryPath)) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIdx = process.argv.indexOf('--output')
  const outputPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined
  process.stdout.write(`${JSON.stringify(buildPeerIdentityAddon(outputPath ? { outputPath } : {}), null, 2)}\n`)
}
