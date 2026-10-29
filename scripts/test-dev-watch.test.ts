import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { developmentSpawnSpec, parseDevArguments } from './dev.mjs'

describe('development launcher arguments', () => {
  it('keeps ordinary development startup and application arguments unchanged', () => {
    const spec = developmentSpawnSpec(['--port', '0'], { execPath: 'node-fixture', entry: 'entry with spaces.ts', env: { NODE_ENV: 'production', FIXTURE: 'retained' } })
    expect(spec.command).toBe('node-fixture')
    expect(spec.args).toEqual(['entry with spaces.ts', '--port', '0'])
    expect(spec.options).toMatchObject({ stdio: 'inherit', windowsHide: true, shell: false, env: { NODE_ENV: 'development', FIXTURE: 'retained' } })
  })

  it('puts the native watch flag before the application entry exactly once', () => {
    const spec = developmentSpawnSpec(['--watch', '--port', '0', '--watch'], { entry: 'fixture.ts', env: {} })
    expect(spec.args).toEqual(['--watch', 'fixture.ts', '--port', '0'])
    expect(parseDevArguments(['--watch'])).toEqual({ watch: true, appArgs: [] })
  })

  it('preserves application-only arguments after the separator', () => {
    expect(parseDevArguments(['--', '--watch'])).toEqual({ watch: false, appArgs: ['--', '--watch'] })
    expect(parseDevArguments(['--watch', '--', '--watch'])).toEqual({ watch: true, appArgs: ['--', '--watch'] })
  })

  it('passes shell metacharacters as literal application arguments without mutating the supplied environment', () => {
    const env = { NODE_ENV: 'production' }
    const args = ['--port', '0; ignored-command', '$(ignored-command)', 'value with spaces']
    const spec = developmentSpawnSpec(args, { entry: 'fixture.ts', env })
    expect(spec.args).toEqual(['fixture.ts', ...args])
    expect(spec.options.shell).toBe(false)
    expect(env).toEqual({ NODE_ENV: 'production' })
  })
})

interface FixtureRecord { value: number; pid: number; startedAt: string; observedAt: number }
interface FixtureProcess { child: ChildProcessWithoutNullStreams; records: FixtureRecord[]; waitFor: (value: number) => Promise<FixtureRecord> }

const launchFixture = (entry: string, watch: boolean): FixtureProcess => {
  const spec = developmentSpawnSpec(watch ? ['--watch'] : [], { entry })
  const child = spawn(spec.command, spec.args, { ...spec.options, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  const records: FixtureRecord[] = []
  const listeners = new Set<() => void>()
  let buffer = ''
  let spawnError: Error | undefined
  child.on('error', error => { spawnError = error; for (const listener of listeners) listener() })
  child.stderr.resume()
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('DEV_FIXTURE ')) continue
      records.push({ ...JSON.parse(line.slice('DEV_FIXTURE '.length)), observedAt: performance.now() })
    }
    for (const listener of listeners) listener()
  })
  return { child, records, waitFor: value => new Promise((resolveRecord, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Synthetic development fixture did not report the expected value')) }, 5000)
    const check = () => {
      const record = records.find(item => item.value === value)
      if (!record && !spawnError) return
      clearTimeout(timer)
      listeners.delete(check)
      if (spawnError) reject(spawnError)
      else resolveRecord(record!)
    }
    listeners.add(check)
    check()
  }) }
}

const stopFixture = async (fixture: FixtureProcess | undefined) => {
  if (!fixture) return
  // The watch supervisor owns a second, synthetic application process.
  for (const pid of new Set(fixture.records.map(record => record.pid))) {
    if (pid === fixture.child.pid) continue
    try { process.kill(pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) return
  const closed = new Promise<void>((resolveClosed, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic development fixture did not close')), 3000)
    fixture.child.once('close', () => { clearTimeout(timer); resolveClosed() })
  })
  fixture.child.kill('SIGTERM')
  await closed
}

it('restarts after an imported synthetic file changes and records a scripted manual-restart baseline', async () => {
  const beganAt = new Date().toISOString()
  const root = await mkdtemp(join(tmpdir(), 'xpanel-dev-watch-'))
  const entry = join(root, 'entry.mjs')
  const dependency = join(root, 'value.mjs')
  let manual: FixtureProcess | undefined
  let restarted: FixtureProcess | undefined
  let watched: FixtureProcess | undefined
  try {
    await writeFile(entry, "import { value } from './value.mjs'; console.log('DEV_FIXTURE ' + JSON.stringify({ value, pid: process.pid, startedAt: new Date().toISOString() })); setInterval(() => {}, 1000);\n")
    await writeFile(dependency, 'export const value = 1;\n')
    manual = launchFixture(entry, false)
    await manual.waitFor(1)
    const manualEditAt = new Date().toISOString()
    const manualStart = performance.now()
    await writeFile(dependency, 'export const value = 2;\n')
    await stopFixture(manual)
    restarted = launchFixture(entry, false)
    const manualResult = await restarted.waitFor(2)
    const manualRestartMs = manualResult.observedAt - manualStart
    await stopFixture(restarted)

    await writeFile(dependency, 'export const value = 1;\n')
    watched = launchFixture(entry, true)
    const initial = await watched.waitFor(1)
    const watchEditAt = new Date().toISOString()
    const watchStart = performance.now()
    await writeFile(dependency, 'export const value = 2;\n')
    const watchResult = await watched.waitFor(2)
    const watchRestartMs = watchResult.observedAt - watchStart
    expect(watchResult.pid).not.toBe(initial.pid)
    expect(watchResult.value).toBe(2)
    process.stdout.write('DEV_WATCH_TIMING=' + JSON.stringify({ runtime: process.version, beganAt, manualEditAt, manualStartedAt: manualResult.startedAt, manualRestartMs, watchEditAt, watchStartedAt: watchResult.startedAt, watchRestartMs, completedAt: new Date().toISOString(), scope: 'Synthetic imported-module restart only; scripted manual baseline excludes human delay.' }) + '\n')
  } finally {
    await stopFixture(watched)
    await stopFixture(restarted)
    await stopFixture(manual)
    const tempRoot = resolve(tmpdir())
    const target = resolve(root)
    const within = relative(tempRoot, target)
    if (!isAbsolute(target) || !within || within === '..' || within.startsWith('..\\') || within.startsWith('../') || isAbsolute(within)) throw new Error('Synthetic cleanup target is outside the temporary directory')
    await rm(target, { recursive: true, force: true })
  }
}, 20_000)
