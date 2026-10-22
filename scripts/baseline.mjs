import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const excludedDirectories = new Set([
  '.git', 'node_modules', '.pnpm-store', '.tools', '.secrets',
  'dist', 'coverage', '.vite', 'test-results', 'playwright-report',
])
const excludedPaths = ['deploy/.data', 'docs/execution']

function isExcluded(path, name, isDirectory) {
  return isDirectory && name.startsWith('.') && name !== '.github'
    || excludedDirectories.has(name)
    || excludedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))
    || (name === '.env' || name.startsWith('.env.')) && name !== '.env.example'
    || /\.(?:log|pem|key)$/i.test(name)
}

const sha256 = value => createHash('sha256').update(value).digest('hex')

async function inventory(directory = '') {
  const files = []
  const location = new URL(directory ? `../${directory}/` : '../', import.meta.url)
  for (const item of await readdir(location, { withFileTypes: true })) {
    const path = directory ? `${directory}/${item.name}` : item.name
    if (isExcluded(path, item.name, item.isDirectory())) continue
    if (item.isDirectory()) files.push(...await inventory(path))
    else if (item.isFile()) {
      const content = await readFile(new URL(`../${path}`, import.meta.url))
      files.push({ path, bytes: content.length, sha256: sha256(content) })
    }
    // Do not follow symlinks into caches, secrets, or directories outside the checkout.
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function command(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
  return {
    exit_code: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
    ...(result.error ? { error: result.error.message } : {}),
  }
}

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const files = await inventory()
const pnpm = process.platform === 'win32'
  ? command('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'])
  : command('pnpm', ['--version'])
const report = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  purpose: 'Source fingerprint only; this does not certify installation, tests, or production readiness.',
  runtime: { node: process.version, platform: process.platform, arch: process.arch, pnpm },
  expected_package_manager: manifest.packageManager,
  expected_node: manifest.engines?.node,
  head: command('git', ['rev-parse', 'HEAD']),
  git_status: command('git', ['status', '--short', '--untracked-files=normal']),
  exclusions: {
    directory_names: [...excludedDirectories],
    paths: excludedPaths,
    filenames: ['.env', '.env.* except .env.example', '*.log', '*.pem', '*.key'],
    symlinks: 'not followed',
  },
  tree_sha256: sha256(files.map(file => `${file.path}\0${file.sha256}\n`).join('')),
  files,
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.head.exit_code !== 0 || pnpm.exit_code !== 0) process.exitCode = 1
