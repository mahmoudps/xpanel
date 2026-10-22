import { accessSync, constants, readFileSync, realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const canonical = path => process.platform === 'win32' ? realpathSync(path).toLowerCase() : realpathSync(path)
if (canonical(process.cwd()) !== canonical(root)) {
  process.stderr.write('Run this workspace launcher from the repository root. Alternate checkouts and install fixtures must use their own explicit executables.\n')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim()
const manager = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(manifest.packageManager ?? '')

if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(nodeVersion) || !manager) {
  process.stderr.write('Workspace toolchain pins must be exact stable Node and pnpm versions.\n')
  process.exit(1)
}

const windows = process.platform === 'win32'
const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
const nodeCandidates = [
  join(root, '.tools', `node-v${nodeVersion}`, windows ? 'node.exe' : 'bin/node'),
  process.execPath,
  ...pathDirectories.map(directory => join(directory, windows ? 'node.exe' : 'node')),
]

function executableVersion(path, env) {
  try {
    accessSync(path, constants.X_OK)
    const result = spawnSync(path, ['--version'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 65536,
    })
    return result.status === 0 ? result.stdout.trim() : null
  } catch {
    return null
  }
}

const node = [...new Set(nodeCandidates)].find(path => executableVersion(path, process.env) === `v${nodeVersion}`)
if (!node) {
  process.stderr.write(`Verified workspace Node ${nodeVersion} is required. Install the pinned runtime locally or activate it before retrying; no system tools were changed.\n`)
  process.exit(1)
}

const env = { ...process.env, PATH: [dirname(node), ...pathDirectories].join(delimiter) }
const managerCandidates = [
  join(root, '.tools', `pnpm-v${manager[1]}`, 'node_modules', 'pnpm', windows ? 'pnpm.exe' : 'pnpm'),
  join(root, '.tools', 'pnpm-runtime', 'node_modules', 'pnpm', windows ? 'pnpm.exe' : 'pnpm'),
  ...pathDirectories.flatMap(directory => windows
    ? [join(directory, 'pnpm.exe'), join(directory, 'node_modules', 'pnpm', 'pnpm.exe')]
    : [join(directory, 'pnpm')]),
]
const pnpm = [...new Set(managerCandidates)].find(path => executableVersion(path, env) === manager[1])
if (!pnpm) {
  process.stderr.write(`Workspace pnpm ${manager[1]} is required. Install its native executable locally or activate the pinned package manager; no fallback version was selected.\n`)
  process.exit(1)
}
env.PATH = [dirname(node), dirname(pnpm), ...pathDirectories].join(delimiter)

const [command, ...args] = process.argv.slice(2)
if (command === '--check') {
  process.stdout.write(`${JSON.stringify({ node: nodeVersion, pnpm: manager[1], global_environment_modified: false })}\n`)
  process.exit(0)
}
if (command !== 'node' && command !== 'pnpm') {
  process.stderr.write('Usage: node scripts/toolchain.mjs --check | node <arguments...> | pnpm <arguments...>\n')
  process.exit(1)
}

// Use executable paths and argv directly; Windows command shims must not interpret user arguments.
const child = spawn(command === 'node' ? node : pnpm, args, {
  cwd: root,
  env,
  stdio: 'inherit',
  windowsHide: true,
})
child.once('error', () => {
  process.stderr.write(`Cannot execute the pinned workspace ${command}.\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1)
})
