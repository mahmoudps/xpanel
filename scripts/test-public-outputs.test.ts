import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-public-outputs.mjs', import.meta.url))
const fixturePath = 'packages/lifecycle/src/testing/cpanel-fixture.ts'
const directories: string[] = []
const env = { ...process.env }
for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
env.GIT_CONFIG_NOSYSTEM = '1'
env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
env.GIT_TERMINAL_PROMPT = '0'

function git(cwd: string, args: string[], input?: string) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, input, env, windowsHide: true, encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('Git fixture setup failed')
  return result.stdout
}

const fixture = Buffer.from(git(process.cwd(), ['show', ':' + fixturePath]))
if (createHash('sha256').update(fixture).digest('hex') !== 'd5f784567ef4e1925746dc2ae252a88f4b719599a628d1379b50f7ddd9835897') throw new Error('Synthetic public test fixture changed')
const match = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(fixture.toString())
if (!match) throw new Error('Synthetic test key missing')
const key = match[0]
const der = createPrivateKey(key).export({ type: 'pkcs8', format: 'der' })

function directory(initialize = true) {
  const path = mkdtempSync(join(tmpdir(), 'public-output-index-'))
  directories.push(path)
  if (initialize) git(path, ['-c', 'init.templateDir=', 'init', '--quiet'])
  return path
}
function put(root: string, path: string, bytes: string | Buffer) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}
function add(root: string, paths: string[]) { git(root, ['add', '-f', '--', ...paths]) }
function run(root: string) {
  const result = spawnSync(process.execPath, [script], { cwd: root, env, windowsHide: true, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function counts(result: ReturnType<typeof run>) {
  const start = result.stdout.indexOf('{')
  if (start < 0) throw new Error('Expected count-only guard output')
  return JSON.parse(result.stdout.slice(start))
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    const expected = resolve(path), actual = realpathSync(path)
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
    if (!same(dirname(expected), resolve(tmpdir())) || !same(actual, expected) || !basename(expected).startsWith('public-output-index-')) throw new Error('Unsafe test cleanup path')
    rmSync(expected, { recursive: true, force: true })
  }
})

describe('indexed public output guard', { tags: ['feature'] }, () => {
  it('accepts an empty index', () => {
    const result = run(directory())
    expect(result.status).toBe(0)
    expect(counts(result).trackedPaths).toBe(0)
  })
  it('accepts ordinary public source and environment examples', () => {
    const root = directory()
    put(root, 'src/public.ts', 'export const value = 1\n')
    put(root, '.env.example', 'APP_URL=https://example.test\n')
    put(root, 'config/.env.example', 'APP_URL=https://example.test\n')
    add(root, ['src/public.ts', '.env.example', 'config/.env.example'])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result)).toMatchObject({ trackedPaths: 3, prohibitedPaths: 0, privateKeyFiles: 0 })
  })
  it('rejects the generic ignored dependency, environment, build, cache and test outputs', () => {
    const root = directory(), paths = ['node_modules/pkg/index.js', '.pnpm-store/cache', '.tools/bin/tool', 'dist/app.js', 'coverage/result.json', '.secrets/data', '.vite/cache', 'playwright-report/index.html', 'test-results/result.json', '.artifacts/result.html', '.env', 'config/.env.local', 'logs/build.log', 'cache/build.tsbuildinfo', 'deploy/.data/state.json', 'apps/web/dist/app.js']
    for (const path of paths) put(root, path, 'synthetic output\n')
    add(root, paths)
    const result = run(root)
    expect(result.status).toBe(1)
    expect(counts(result).prohibitedPaths).toBe(paths.length)
  })
  it('ignores untracked ignored files including a reused public test key', () => {
    const root = directory()
    put(root, '.gitignore', '.secrets/\n.env\n')
    add(root, ['.gitignore'])
    put(root, '.secrets/reused.key', key)
    put(root, '.env', 'SYNTHETIC=example\n')
    git(root, ['check-ignore', '-q', '.secrets/reused.key'])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result)).toMatchObject({ trackedPaths: 1, prohibitedPaths: 0, privateKeyFiles: 0 })
  })
  it('rejects an ignored environment output when it is force-added to the index', () => {
    const root = directory()
    put(root, '.gitignore', '.env\n')
    put(root, '.env', 'SYNTHETIC=example\n')
    add(root, ['.gitignore', '.env'])
    expect(counts(run(root)).prohibitedPaths).toBe(1)
  })
  it('rejects valid existing PEM key material without printing key bytes or file names', () => {
    const root = directory(), path = 'unusual dir/reused fixture.pem'
    put(root, path, key)
    add(root, [path])
    const result = run(root), output = result.stdout + result.stderr
    expect(result.status).toBe(1)
    expect(counts(result)).toMatchObject({ privateKeyFiles: 1, adjudicatedKeyFiles: 0, rejectedKeyFiles: 1 })
    expect(output.includes(path)).toBe(false)
    expect(output.includes(key)).toBe(false)
    expect(key.split('\n').slice(1, -1).some(line => line.length > 20 && output.includes(line))).toBe(false)
  })
  it('rejects DER encoding of the same existing test key without a filename heuristic', () => {
    const root = directory()
    put(root, 'ordinary-data.bin', der)
    add(root, ['ordinary-data.bin'])
    const result = run(root)
    expect(result.status).toBe(1)
    expect(counts(result).rejectedKeyFiles).toBe(1)
  })
  it('rejects a literal escaped-linebreak encoding of the existing test key', () => {
    const root = directory()
    put(root, 'source.txt', key.replaceAll('\n', '\\n'))
    add(root, ['source.txt'])
    const result = run(root)
    expect(result.status).toBe(1)
    expect(counts(result).rejectedKeyFiles).toBe(1)
  })
  it('reads a staged key even when the unstaged file has harmless contents', () => {
    const root = directory()
    put(root, 'sample.pem', key)
    add(root, ['sample.pem'])
    put(root, 'sample.pem', 'ordinary public text\n')
    expect(counts(run(root)).rejectedKeyFiles).toBe(1)
  })
  it('does not scan unstaged key contents over a harmless indexed version', () => {
    const root = directory()
    put(root, 'sample.txt', 'ordinary public text\n')
    add(root, ['sample.txt'])
    put(root, 'sample.txt', key)
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result).privateKeyFiles).toBe(0)
  })
  it('still checks an indexed key after its working-tree file is deleted', () => {
    const root = directory()
    put(root, 'sample.pem', key)
    add(root, ['sample.pem'])
    unlinkSync(join(root, 'sample.pem'))
    expect(counts(run(root)).rejectedKeyFiles).toBe(1)
  })
  it('ignores a key removed from the index while preserving its untracked file', () => {
    const root = directory()
    put(root, 'sample.pem', key)
    add(root, ['sample.pem'])
    git(root, ['rm', '--cached', '--quiet', '--', 'sample.pem'])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result).trackedPaths).toBe(0)
  })
  it('reports the exact adjudicated public fixture as a nonzero raw finding', () => {
    const root = directory()
    put(root, fixturePath, fixture)
    add(root, [fixturePath])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result)).toMatchObject({ privateKeyFiles: 1, adjudicatedKeyFiles: 1, rejectedKeyFiles: 0 })
  })
  it('does not extend the fixture exception to an identical blob at another path', () => {
    const root = directory()
    put(root, 'fixtures/renamed.ts', fixture)
    add(root, ['fixtures/renamed.ts'])
    expect(counts(run(root)).rejectedKeyFiles).toBe(1)
  })
  it('rejects any whole-blob mutation at the exact fixture path', () => {
    const root = directory()
    put(root, fixturePath, Buffer.concat([fixture, Buffer.from('\n// changed\n')]))
    add(root, [fixturePath])
    const result = run(root)
    expect(result.status).toBe(1)
    expect(counts(result)).toMatchObject({ privateKeyFiles: 1, adjudicatedKeyFiles: 0, rejectedKeyFiles: 1 })
  })
  it('rejects an additional key appended to the exact fixture path', () => {
    const root = directory()
    put(root, fixturePath, Buffer.concat([fixture, Buffer.from('\n' + key + '\n')]))
    add(root, [fixturePath])
    expect(counts(run(root)).rejectedKeyFiles).toBe(1)
  })
  it('does not mistake source examples containing only a key label for key material', () => {
    const root = directory()
    put(root, 'examples.txt', '-----BEGIN PRIVATE KEY-----\nnot base64 key material\n-----END PRIVATE KEY-----\n')
    add(root, ['examples.txt'])
    const result = run(root)
    expect(result.status).toBe(0)
    expect(counts(result).privateKeyFiles).toBe(0)
  })
  it('fails closed outside a Git repository without echoing the filesystem path', () => {
    const root = directory(false), result = run(root)
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim()).toBe('Public output check failed: unable to inspect indexed data.')
    expect(result.stderr.includes(root)).toBe(false)
  })
})
