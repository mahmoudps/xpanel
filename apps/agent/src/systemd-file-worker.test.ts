import assert from 'node:assert/strict'
import { beforeEach, describe, it, vi } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import type { HelperProcessSpawnInput } from './account-file-runner.ts'

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
  calls: [] as { executable: string; args: string[]; options: Record<string, unknown> }[],
  verified: [] as string[],
  modes: new Map<string, number>(),
  symlinks: new Set<string>(),
  ownership: new Map<string, number>(),
  groups: new Map<string, number>(),
  missingDirectories: new Set<string>(),
  inheritedGid: 0,
  chowns: [] as { path: string; uid: number; gid: number }[],
  chmods: [] as { path: string; mode: number }[],
  filesystemEvents: [] as string[],
  failReads: new Map<string, string>(),
  failSync: false,
  syncs: 0,
  state: 'inactive',
  pending: '',
  populated: '0',
  observed: false,
  sliceFields: '',
  behavior: 'normal',
  stdout: '{"ok":true}\n',
  stderr: '',
  launchInput: '',
  launchPid: 811,
  workerFields: undefined as string | undefined,
  eventsOverride: undefined as string | undefined,
  serviceAbsent: false,
  cgroupType: 0x63677270,
  exitCode: 0,
  collect: false,
  launcher: undefined as undefined | { finish: () => void; kill: () => void },
  wrappersReaped: 0,
  incidentWrites: [] as string[],
}))

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const { constants } = await import('node:fs')
  const missing = (path: string) => Object.assign(new Error('missing'), { code: 'ENOENT', path })
  const stat = (path: string, directory = false) => ({
    uid: fixture.ownership.get(path) ?? 0, gid: fixture.groups.get(path) ?? 0,
    mode: fixture.modes.get(path) ?? (directory ? (path.endsWith('file-worker-incidents') ? 0o700 : 0o755) : 0o644),
    size: Buffer.byteLength(fixture.files.get(path) ?? ''),
    isDirectory: () => directory, isFile: () => !directory,
    isSymbolicLink: () => fixture.symlinks.has(path),
  })
  const isDir = (path: string) => !path.includes('.') || (path.startsWith('/sys/fs/cgroup/') && (path.endsWith('.slice') || path.endsWith('.service')))
  return {
    ...actual,
    lstat: async (path: string) => {
      if (fixture.missingDirectories.has(path)) throw missing(path)
      if (fixture.serviceAbsent && path.startsWith('/sys/fs/cgroup/') && path.endsWith('.service')) throw missing(path)
      if (!fixture.files.has(path) && !isDir(path)) throw missing(path)
      return stat(path, isDir(path))
    },
    statfs: async () => ({ type: fixture.cgroupType }),
    mkdir: async (path: string, options: { mode?: number }) => {
      if (!fixture.missingDirectories.delete(path)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      fixture.groups.set(path, fixture.inheritedGid)
      fixture.modes.set(path, options.mode ?? 0o755)
      fixture.filesystemEvents.push('mkdir:' + path)
    },
    readdir: async (path: string) => [...fixture.files.keys()].filter((entry) => entry.startsWith(path + '/') && !entry.slice(path.length + 1).includes('/')).map((entry) => entry.slice(path.length + 1)),
    open: async (path: string, flags: number, mode?: number) => {
      if (fixture.failReads.has(path)) throw Object.assign(new Error('read refused'), { code: fixture.failReads.get(path) })
      const write = Boolean(flags & constants.O_CREAT)
      if (!write && !fixture.files.has(path) && !isDir(path)) throw missing(path)
      if (write && (flags & constants.O_EXCL) && fixture.files.has(path)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
      if (write) { fixture.files.set(path, ''); fixture.modes.set(path, mode ?? 0o644); fixture.groups.set(path, fixture.inheritedGid) }
      return {
        stat: async () => stat(path, isDir(path)),
        chown: async (uid: number, gid: number) => {
          fixture.chowns.push({ path, uid, gid }); fixture.ownership.set(path, uid); fixture.groups.set(path, gid)
          fixture.filesystemEvents.push('chown:' + path)
        },
        chmod: async (mode: number) => {
          fixture.chmods.push({ path, mode }); fixture.modes.set(path, mode)
          fixture.filesystemEvents.push('chmod:' + path)
        },
        readFile: async () => Buffer.from(path.endsWith('/cgroup.events') ? fixture.eventsOverride ?? 'populated ' + fixture.populated + '\nfrozen 0\n' : fixture.files.get(path) ?? ''),
        writeFile: async (value: string) => { fixture.files.set(path, value); fixture.incidentWrites.push(value); fixture.filesystemEvents.push('write:' + path) },
        sync: async () => { if (fixture.failSync) throw new Error('sync failed'); fixture.syncs++; fixture.filesystemEvents.push('sync:' + path) },
        close: async () => undefined,
      }
    },
    rename: async (from: string, to: string) => {
      fixture.files.set(to, fixture.files.get(from) ?? ''); fixture.files.delete(from)
      fixture.groups.set(to, fixture.groups.get(from) ?? 0); fixture.groups.delete(from)
      fixture.modes.set(to, fixture.modes.get(from) ?? 0o644); fixture.modes.delete(from)
    },
    unlink: async (path: string) => { if (!fixture.files.delete(path)) throw missing(path) },
  }
})

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  class Child extends EventEmitter {
    pid = fixture.launchPid
    stdin = new PassThrough()
    stdout = new PassThrough()
    stderr = new PassThrough()
    killed = false
    done = false
    constructor() { super(); this.stdin.on('error', () => undefined) }
    finish(code: number | null = 0, signal: NodeJS.Signals | null = null) {
      if (this.done) return
      this.done = true
      fixture.wrappersReaped++
      this.stdout.end(); this.stderr.end(); this.emit('close', code, signal)
    }
    kill() { this.killed = true; queueMicrotask(() => this.finish(null, 'SIGKILL')); return true }
  }
  return {
    spawn: (executable: string, args: string[], options: Record<string, unknown>) => {
      fixture.calls.push({ executable, args, options })
      const child = new Child()
      if (executable === '/usr/bin/systemctl') {
        queueMicrotask(() => {
          const isSlice = args.at(-1)?.endsWith('.slice')
          if (args.includes('stop')) {
            if (fixture.behavior === 'queued-start') { fixture.observed = true; fixture.state = 'active'; fixture.pending = '32'; fixture.behavior = 'stop-next' }
            else if (!['sticky', 'permission'].includes(fixture.behavior)) { fixture.state = 'inactive'; fixture.pending = ''; fixture.populated = '0' }
            child.finish(fixture.behavior === 'permission' ? 1 : 0)
          } else {
            if (fixture.behavior === 'permission' && !isSlice) { child.stderr.write('Access denied'); child.finish(1); return }
            child.stdout.write(isSlice ? fixture.sliceFields : fixture.workerFields ?? [
              'LoadState=' + (fixture.observed ? 'loaded' : 'not-found'),
              'ActiveState=' + fixture.state,
              'ControlGroup=' + (fixture.observed ? '/xpanel.slice/xpanel-29101.slice/' + unit : ''),
              'Job=' + fixture.pending,
            ].join('\n') + '\n')
            child.finish()
          }
        })
        return child
      }
      child.stdin.on('data', (chunk) => { fixture.launchInput += chunk.toString() })
      fixture.launcher = { finish: () => { fixture.state = 'inactive'; fixture.populated = '0'; if (fixture.collect) fixture.observed = false; child.stdout.write(fixture.stdout); child.finish(fixture.exitCode) }, kill: () => child.kill() }
      queueMicrotask(() => {
        if (fixture.behavior === 'spawn-error') { child.pid = 0; child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' })); child.finish(null); return }
        if (fixture.behavior === 'early-death') { child.finish(1); return }
        fixture.observed = true; fixture.state = 'active'; fixture.populated = '1'
        if (fixture.behavior === 'normal') fixture.launcher?.finish()
        else if (fixture.behavior === 'stdout-overflow') child.stdout.write('x'.repeat(4097))
        else if (fixture.behavior === 'stderr-overflow') child.stderr.write('x'.repeat(1025))
        else if (fixture.behavior === 'callback') { child.stdout.write(fixture.stdout); child.finish() }
      })
      return child
    },
  }
})

import { SystemdAccountFileWorkerPool } from './systemd-file-worker.ts'

const unit = 'xpanel-files-29101-' + 'a'.repeat(32) + '.service'
const parent = '/sys/fs/cgroup/xpanel.slice/xpanel-29101.slice'
const incidentDir = '/var/lib/xpanel-agent/file-worker-incidents'
const input: HelperProcessSpawnInput & { uid: number; workerUnit: string; cgroupPath: string } = {
  binaryPath: '/opt/xpanel/bin/xpanel-account-files', stdinPayload: '{"secret":"tenant-payload"}',
  timeoutMs: 50, maxStdoutBytes: 4096, maxStderrBytes: 1024, uid: 29101, workerUnit: unit, cgroupPath: parent,
}
const pool = () => new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async (path) => { fixture.verified.push(path); return 'a'.repeat(64) } })
const code = (expected: string) => (error: unknown) => isXpanelError(error) && error.code === expected
const receipts = () => [...fixture.files.entries()].filter(([path]) => path.startsWith(incidentDir + '/'))
const waitForLaunch = async () => {
  for (let attempt = 0; attempt < 100 && !fixture.launcher; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(fixture.launcher, 'expected the supervised launcher to start')
  return fixture.launcher
}

beforeEach(() => {
  fixture.files.clear(); fixture.calls.length = 0; fixture.verified.length = 0
  fixture.modes.clear(); fixture.symlinks.clear(); fixture.ownership.clear(); fixture.failReads.clear()
  fixture.groups.clear(); fixture.missingDirectories.clear(); fixture.inheritedGid = 0; fixture.chowns.length = 0; fixture.chmods.length = 0; fixture.filesystemEvents.length = 0
  fixture.failSync = false; fixture.syncs = 0; fixture.state = 'inactive'; fixture.pending = ''; fixture.populated = '0'; fixture.observed = false
  fixture.behavior = 'normal'; fixture.stdout = '{"ok":true}\n'; fixture.stderr = ''; fixture.launchInput = ''; fixture.launcher = undefined; fixture.wrappersReaped = 0; fixture.incidentWrites.length = 0
  fixture.workerFields = undefined; fixture.eventsOverride = undefined; fixture.serviceAbsent = false; fixture.cgroupType = 0x63677270
  fixture.exitCode = 0; fixture.collect = false
  fixture.sliceFields = 'LoadState=loaded\nActiveState=active\nFragmentPath=/etc/systemd/system/xpanel-29101.slice\nControlGroup=/xpanel.slice/xpanel-29101.slice\n'
  fixture.files.set('/etc/systemd/system/xpanel-29101.slice', '[Slice]\nMemoryMax=infinity\nTasksMax=infinity\n')
  for (const directory of ['/sys/fs/cgroup', '/sys/fs/cgroup/xpanel.slice', parent]) {
    fixture.files.set(directory + '/cgroup.controllers', 'cpu memory pids io\n')
    fixture.files.set(directory + '/cgroup.subtree_control', 'cpu memory pids io\n')
  }
  fixture.files.set(parent + '/cgroup.type', 'domain\n')
  fixture.files.set(parent + '/cpu.max', 'max 100000\n')
  fixture.files.set(parent + '/memory.max', 'max\n')
  fixture.files.set(parent + '/pids.max', 'max\n')
  fixture.files.set(parent + '/io.max', '')
  fixture.files.set(parent + '/' + unit + '/cgroup.events', 'populated 0\nfrozen 0\n')
})

describe('transient account file service supervisor', () => {
  it('uses verified fixed executables, a named bounded service, exact stdin and proof before returning', async () => {
    const worker = pool()
    const result = await worker.run(input)
    assert.equal(result.stdout, fixture.stdout)
    assert.equal(result.pid, fixture.launchPid)
    assert.deepEqual(fixture.verified, ['/usr/bin/systemd-run', '/usr/bin/systemctl', '/usr/bin/systemd-run', '/usr/bin/systemctl'])
    const launch = fixture.calls.find((call) => call.executable === '/usr/bin/systemd-run')
    assert.ok(launch)
    for (const expected of ['--system', '--pipe', '--wait', '--collect', '--service-type=exec', '--expand-environment=no', '--unit=' + unit, '--slice=xpanel-29101.slice', '--property=MemoryMax=64M', '--property=MemorySwapMax=0', '--property=TasksMax=1', '--property=CPUQuota=100%', '--property=RuntimeMaxSec=50ms', '--property=TimeoutStartSec=50ms', '--property=KillMode=control-group']) assert.ok(launch.args.includes(expected), expected)
    assert.deepEqual(launch.args.slice(-2), ['--', input.binaryPath])
    assert.equal(launch.options.shell, false)
    assert.equal(fixture.launchInput, input.stdinPayload)
    assert.ok(fixture.syncs >= 3)
    assert.equal(receipts().length, 0)
    assert.ok(fixture.calls.some((call) => call.args.includes('stop') && call.args.at(-1) === unit))
    assert.ok(!fixture.calls.some((call) => call.args.some((arg) => ['start', 'set-property', 'enable', 'reset-failed'].includes(arg))))
    await worker.close()
  })

  it.each([
    ['LoadState=loaded', 'LoadState=not-found'],
    ['ActiveState=active', 'ActiveState=inactive'],
    ['ControlGroup=/xpanel.slice/xpanel-29101.slice', 'ControlGroup=/xpanel.slice/xpanel-291010.slice'],
    ['FragmentPath=/etc/systemd/system/xpanel-29101.slice', 'FragmentPath=/run/systemd/transient/xpanel-29101.slice'],
  ])('refuses missing or mismatched loaded account policy (%s)', async (from, to) => {
    fixture.sliceFields = fixture.sliceFields.replace(from, to)
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('rejects ambiguous duplicate systemctl fields rather than treating them as absence', async () => {
    fixture.sliceFields += 'LoadState=loaded\n'
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
  })

  it.each(['symlink', 'writable', 'owner'])('rejects a %s canonical policy fragment before launch', async (kind) => {
    const fragment = '/etc/systemd/system/xpanel-29101.slice'
    if (kind === 'symlink') fixture.symlinks.add(fragment)
    if (kind === 'writable') fixture.modes.set(fragment, 0o666)
    if (kind === 'owner') fixture.ownership.set(fragment, 29101)
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
  })

  it('refuses missing controller enforcement, while explicit unlimited values remain valid', async () => {
    fixture.files.set('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control', 'cpu pids io\n')
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it.each(['stdout-overflow', 'stderr-overflow', 'hold'])('cleans up the named service and reaps on %s', async (behavior) => {
    fixture.behavior = behavior
    await assert.rejects(() => pool().run(input))
    assert.ok(fixture.calls.some((call) => call.args.includes('stop') && call.args.at(-1) === unit))
    assert.equal(fixture.state, 'inactive')
    assert.equal(receipts().length, 0)
    assert.ok(fixture.launcher)
  })

  it('stops a queued start instead of accepting the first inactive observation', async () => {
    fixture.behavior = 'queued-start'
    await assert.rejects(() => pool().run(input))
    assert.equal(fixture.state, 'inactive')
    assert.equal(fixture.pending, '')
    assert.ok(fixture.calls.filter((call) => call.args.includes('stop')).length >= 2)
    assert.equal(receipts().length, 0)
  })

  it('keeps an unresolved durable receipt and gates admission when wrapper death cannot exclude queued creation', async () => {
    fixture.behavior = 'early-death'
    const worker = pool()
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
    assert.equal(receipts().length, 1)
    const saved = receipts()[0]?.[1] ?? ''
    assert.ok(saved.includes(unit)); assert.ok(!saved.includes('tenant-payload')); assert.ok(!saved.includes(input.binaryPath))
    await assert.rejects(() => worker.run({ ...input, workerUnit: unit.replace(/a/g, 'b') }), code('SERVICE_UNAVAILABLE'))
  })

  it('does not hide a permission error as an empty or absent service', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    await waitForLaunch()
    fixture.behavior = 'permission'
    await rejected
    assert.equal(receipts().length, 1)
  })

  it('refuses startup when an earlier unresolved unit receipt exists', async () => {
    fixture.files.set(incidentDir + '/' + unit + '.json', JSON.stringify({ unit, uid: 29101, status: 'unresolved', reason: 'timeout' }))
    await assert.rejects(() => pool().initialize(), code('SERVICE_UNAVAILABLE'))
    assert.equal(fixture.calls.length, 0)
  })

  it('denies execution if its durable in-flight journal cannot be fsynced', async () => {
    fixture.failSync = true
    await assert.rejects(() => pool().run(input), code('SERVICE_UNAVAILABLE'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('close cancels and awaits all active services, then refuses new operations', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    await waitForLaunch()
    await worker.close()
    await rejected
    assert.equal(fixture.state, 'inactive')
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
  })

  it.each(['cpu', 'memory', 'pids'])('requires available and enabled %s controllers at every ancestor', async (controller) => {
    fixture.files.set('/sys/fs/cgroup/xpanel.slice/cgroup.controllers', ['cpu', 'memory', 'pids'].filter((name) => name !== controller).join(' '))
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it.each(['memory.max', 'cpu.max', 'pids.max'])('refuses a missing %s enforcement interface before launch', async (name) => {
    fixture.files.delete(parent + '/' + name)
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('refuses a non-cgroup2 filesystem and an insecure incident ancestor', async () => {
    fixture.cgroupType = 0xef53
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    fixture.cgroupType = 0x63677270
    fixture.modes.set('/var/lib/xpanel-agent', 0o777)
    await assert.rejects(() => pool().initialize(), code('PRECONDITION_FAILED'))
  })

  it.each(['missing', 'malformed', 'duplicate', 'permission'])('never interprets %s cgroup events as empty', async (kind) => {
    if (kind === 'missing') fixture.files.delete(parent + '/' + unit + '/cgroup.events')
    if (kind === 'malformed') fixture.eventsOverride = 'populated unknown\n'
    if (kind === 'duplicate') fixture.eventsOverride = 'populated 0\npopulated 0\n'
    if (kind === 'permission') fixture.failReads.set(parent + '/' + unit + '/cgroup.events', 'EACCES')
    await assert.rejects(() => pool().run(input), code('SERVICE_UNAVAILABLE'))
    assert.equal(receipts().length, 1)
  })

  it('accepts actual service cgroup absence after a completed wrapper and terminal unit proof', async () => {
    fixture.serviceAbsent = true
    assert.equal((await pool().run(input)).exitCode, 0)
    assert.equal(receipts().length, 0)
  })

  it('does not return success when the stopped unit still has a pending job', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    const launcher = await waitForLaunch()
    fixture.workerFields = 'LoadState=loaded\nActiveState=inactive\nControlGroup=' + parent.slice('/sys/fs/cgroup'.length) + '/' + unit + '\nJob=123\n'
    launcher.finish()
    await rejected
    assert.equal(receipts().length, 1)
  })

  it('keeps the incident if the unit is terminal but its cgroup remains populated', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    const launcher = await waitForLaunch()
    fixture.eventsOverride = 'populated 1\nfrozen 0\n'
    launcher.finish()
    await rejected
    assert.equal(receipts().length, 1)
  })

  it('cleans up spawn failure without invoking a direct helper fallback', async () => {
    fixture.behavior = 'spawn-error'
    await assert.rejects(() => pool().run(input), code('SERVICE_UNAVAILABLE'))
    assert.ok(fixture.calls.some((call) => call.args.includes('stop')))
    assert.ok(fixture.calls.every((call) => ['/usr/bin/systemd-run', '/usr/bin/systemctl'].includes(call.executable)))
    assert.equal(receipts().length, 0)
  })

  it('bounds an observer that never settles, then proves cleanup before rejecting', async () => {
    await assert.rejects(() => pool().run({ ...input, onStdoutLine: () => new Promise(() => undefined) }), code('SERVICE_UNAVAILABLE'))
    assert.equal(receipts().length, 0)
  })

  it('preserves immutable generated unit identity if its caller mutates the input during preflight', async () => {
    const changed = { ...input }
    const running = pool().run(changed)
    changed.workerUnit = 'ssh.service'
    changed.cgroupPath = '/sys/fs/cgroup/system.slice'
    assert.equal((await running).exitCode, 0)
    assert.ok(!fixture.calls.some((call) => call.args.includes('ssh.service')))
  })

  it('rejects changed executable bytes after initialization', async () => {
    let changed = false
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => (changed ? 'b' : 'a').repeat(64) })
    await worker.initialize()
    changed = true
    await assert.rejects(() => worker.run(input), code('PRECONDITION_FAILED'))
    assert.equal(fixture.calls.length, 0)
  })

  it('allows the first bounded service in an empty active account slice', async () => {
    fixture.files.set(parent + '/cgroup.subtree_control', '')
    assert.equal((await pool().run(input)).exitCode, 0)
  })

  it('requires I/O enforcement even for unlimited plan policy', async () => {
    fixture.files.delete(parent + '/io.max')
    await assert.rejects(() => pool().run(input), code('PRECONDITION_FAILED'))
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('returns a structured native rejection after verified cleanup of an already-collected service', async () => {
    fixture.exitCode = 1
    fixture.collect = true
    fixture.serviceAbsent = true
    fixture.stdout = JSON.stringify({ protocolVersion: 2, ok: false, worker: { pid: 912, cgroup: parent.slice('/sys/fs/cgroup'.length) + '/' + unit }, error: { code: 'FORBIDDEN' } }) + '\n'
    const result = await pool().run(input)
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, fixture.stdout)
    assert.equal(receipts().length, 0)
  })

  it('does not treat a failed loaded unit as inactive completion', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    const launcher = await waitForLaunch()
    fixture.workerFields = 'LoadState=loaded\nActiveState=failed\nControlGroup=\nJob=\n'
    launcher.finish()
    await rejected
    assert.equal(receipts().length, 1)
  })

  it('surfaces combined cleanup and journal failure while retaining the prelaunch marker', async () => {
    const worker = pool()
    fixture.behavior = 'hold'
    const running = worker.run(input)
    const rejected = assert.rejects(() => running, (error: unknown) => isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE' && error.message.includes('incident journal could not be persisted'))
    const launcher = await waitForLaunch()
    fixture.failSync = true
    fixture.eventsOverride = 'populated 1\n'
    launcher.finish()
    await rejected
    assert.ok(receipts().some(([path, value]) => path.endsWith(unit + '.json') && value.includes('in-flight')))
  })

  it('close interrupts an unresponsive live observer without waiting its full invocation timeout', async () => {
    const worker = pool()
    let observed!: () => void
    const callbackEntered = new Promise<void>((resolve) => { observed = resolve })
    const running = worker.run({ ...input, timeoutMs: 120_000, onStdoutLine: () => { observed(); return new Promise(() => undefined) } })
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    await callbackEntered
    await worker.close()
    await rejected
    assert.equal(receipts().length, 0)
  })

  it.each(['xpanel-files-29102-' + 'a'.repeat(32) + '.service', 'xpanel-files-29101-' + 'A'.repeat(32) + '.service', 'ssh.service', '../xpanel-files-29101.service'])('rejects non-generated worker unit %s before systemd commands', async (workerUnit) => {
    await assert.rejects(() => pool().run({ ...input, workerUnit }), code('PRECONDITION_FAILED'))
    assert.equal(fixture.calls.length, 0)
  })

  it('secures newly created runtime directories despite a nonzero daemon primary GID', async () => {
    fixture.inheritedGid = 986
    fixture.missingDirectories.add('/var/lib/xpanel-agent')
    fixture.missingDirectories.add(incidentDir)
    await pool().initialize()
    assert.deepEqual(fixture.chowns, [
      { path: '/var/lib/xpanel-agent', uid: 0, gid: 0 },
      { path: incidentDir, uid: 0, gid: 0 },
    ])
    for (const path of ['/var/lib/xpanel-agent', incidentDir]) {
      assert.equal(fixture.groups.get(path), 0)
      assert.equal(fixture.modes.get(path), 0o700)
      assert.ok(fixture.filesystemEvents.indexOf('chown:' + path) < fixture.filesystemEvents.indexOf('sync:' + path))
    }
  })

  it('secures only a newly O_EXCL-created receipt before validation, write and fsync', async () => {
    fixture.inheritedGid = 986
    assert.equal((await pool().run(input)).exitCode, 0)
    const path = incidentDir + '/' + unit + '.json'
    assert.deepEqual(fixture.chowns, [{ path, uid: 0, gid: 0 }])
    assert.deepEqual(fixture.chmods, [{ path, mode: 0o600 }])
    assert.ok(fixture.filesystemEvents.indexOf('chown:' + path) < fixture.filesystemEvents.indexOf('write:' + path))
    assert.ok(fixture.filesystemEvents.indexOf('write:' + path) < fixture.filesystemEvents.indexOf('sync:' + path))
    assert.equal(receipts().length, 0)
  })

  it('secures newly created unresolved replacement files as root:root with a nonzero daemon group', async () => {
    fixture.inheritedGid = 986
    fixture.behavior = 'early-death'
    await assert.rejects(() => pool().run(input), code('SERVICE_UNAVAILABLE'))
    assert.equal(fixture.chowns.length, 2)
    assert.ok(fixture.chowns.every((entry) => entry.uid === 0 && entry.gid === 0 && entry.path.startsWith(incidentDir + '/')))
    const [path, contents] = receipts()[0]!
    assert.equal(fixture.groups.get(path), 0)
    assert.equal(fixture.modes.get(path), 0o600)
    assert.equal(JSON.parse(contents).status, 'unresolved')
  })

  it.each(['/var/lib/xpanel-agent', incidentDir])('does not repair an existing non-root group directory: %s', async (path) => {
    fixture.groups.set(path, 986)
    await assert.rejects(() => pool().initialize(), code('PRECONDITION_FAILED'))
    assert.equal(fixture.groups.get(path), 986)
    assert.equal(fixture.chowns.length, 0)
    assert.equal(fixture.chmods.length, 0)
  })

  it('preserves an existing non-root-group receipt without attempting ownership repair', async () => {
    const path = incidentDir + '/' + unit + '.json'
    fixture.files.set(path, 'preserved-unresolved-receipt')
    fixture.groups.set(path, 986)
    fixture.modes.set(path, 0o600)
    await assert.rejects(() => pool().initialize(), code('SERVICE_UNAVAILABLE'))
    assert.equal(fixture.files.get(path), 'preserved-unresolved-receipt')
    assert.equal(fixture.groups.get(path), 986)
    assert.equal(fixture.chowns.length, 0)
    assert.equal(fixture.chmods.length, 0)
  })

  it('refuses an existing receipt encountered after initialization without chowning or overwriting it', async () => {
    const worker = pool()
    await worker.initialize()
    const path = incidentDir + '/' + unit + '.json'
    fixture.files.set(path, 'existing-receipt-after-initialize')
    fixture.groups.set(path, 986)
    fixture.modes.set(path, 0o600)
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
    assert.equal(fixture.files.get(path), 'existing-receipt-after-initialize')
    assert.equal(fixture.groups.get(path), 986)
    assert.equal(fixture.chowns.length, 0)
    assert.equal(fixture.chmods.length, 0)
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('reserves four slots before payload preparation and immediately refuses a fifth without queueing', async () => {
    const worker = pool()
    let prepared = 0
    const pending = Array.from({ length: 4 }, () => worker.run(async () => { prepared++; return new Promise<typeof input>(() => undefined) }))
    const settled = pending.map((operation) => assert.rejects(() => operation, code('SERVICE_UNAVAILABLE')))
    let fifthPrepared = false
    await assert.rejects(() => worker.run(async () => { fifthPrepared = true; return input }), code('SERVICE_UNAVAILABLE'))
    assert.equal(fifthPrepared, false)
    for (let attempt = 0; attempt < 100 && prepared !== 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(prepared, 4)
    assert.equal(fixture.calls.length, 0)
    assert.equal(receipts().length, 0)
    await worker.close()
    await Promise.all(settled)
  })

  it('cancels pending preparation on close without launching or waiting for its unresolved payload', async () => {
    const worker = pool()
    let entered!: () => void
    const preparing = new Promise<void>((resolve) => { entered = resolve })
    let preparationSignal: AbortSignal | undefined
    const running = worker.run(async (signal) => { preparationSignal = signal; entered(); return new Promise<typeof input>(() => undefined) })
    const rejected = assert.rejects(() => running, code('SERVICE_UNAVAILABLE'))
    await Promise.race([preparing, new Promise((_, reject) => setTimeout(() => reject(new Error('preparation never started')), 500))])
    await worker.close()
    await rejected
    assert.equal(preparationSignal?.aborted, true)
    assert.equal(fixture.calls.length, 0)
    assert.equal(receipts().length, 0)
    let preparedAfterClose = false
    await assert.rejects(() => worker.run(async () => { preparedAfterClose = true; return input }), code('SERVICE_UNAVAILABLE'))
    assert.equal(preparedAfterClose, false)
  })

  it('releases a reserved slot after preparation failure and admits a later real operation', async () => {
    const worker = pool()
    const cause = new Error('preparation-failed')
    await assert.rejects(() => worker.run(async () => { throw cause }), (error) => error === cause)
    assert.equal((await worker.run(async () => input)).exitCode, 0)
    assert.equal(receipts().length, 0)
  })

  it('notifies recovery once and allows its callback to await pool.close without self-deadlock', async () => {
    let calls = 0
    let notificationFinished!: () => void
    const notification = new Promise<void>((resolve) => { notificationFinished = resolve })
    const worker = new SystemdAccountFileWorkerPool({
      incidentDir, verifyExecutable: async () => 'a'.repeat(64),
      onRecoveryRequired: async () => { calls++; try { await worker.close() } catch { /* Admission is intentionally blocked. */ } notificationFinished() },
    })
    fixture.behavior = 'early-death'
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
    await Promise.race([notification, new Promise((_, reject) => setTimeout(() => reject(new Error('notification self-deadlocked')), 1000))])
    assert.equal(calls, 1)
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
    assert.equal(calls, 1)
  })

  it('absorbs a rejected recovery callback and still preserves the unresolved incident', async () => {
    let calls = 0
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => 'a'.repeat(64), onRecoveryRequired: async () => { calls++; throw new Error('callback rejected') } })
    fixture.behavior = 'early-death'
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(receipts().length, 1)
  })

  it('notifies recovery once on unresolved startup receipts and never prepares work', async () => {
    let calls = 0
    let prepared = false
    fixture.files.set(incidentDir + '/unresolved.json', 'unresolved')
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => 'a'.repeat(64), onRecoveryRequired: () => { calls++ } })
    await assert.rejects(() => worker.initialize(), code('SERVICE_UNAVAILABLE'))
    await assert.rejects(() => worker.run(async () => { prepared = true; return input }), code('SERVICE_UNAVAILABLE'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(prepared, false)
    assert.equal(fixture.calls.length, 0)
  })

  it('notifies recovery on unsafe journal readiness without repairing its existing directory', async () => {
    let calls = 0
    fixture.groups.set(incidentDir, 986)
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => 'a'.repeat(64), onRecoveryRequired: () => { calls++ } })
    await assert.rejects(() => worker.initialize(), code('PRECONDITION_FAILED'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(fixture.chowns.length, 0)
    await assert.rejects(() => worker.run(async () => input), code('SERVICE_UNAVAILABLE'))
  })

  it('notifies recovery after launch-journal fsync failure without preparing a later request', async () => {
    let calls = 0
    fixture.failSync = true
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => 'a'.repeat(64), onRecoveryRequired: () => { calls++ } })
    await assert.rejects(() => worker.run(async () => input), code('SERVICE_UNAVAILABLE'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    let prepared = false
    await assert.rejects(() => worker.run(async () => { prepared = true; return input }), code('SERVICE_UNAVAILABLE'))
    assert.equal(prepared, false)
    assert.ok(!fixture.calls.some((call) => call.executable === '/usr/bin/systemd-run'))
  })

  it('notifies recovery when proved termination cannot clear its journal durably', async () => {
    let calls = 0
    const worker = new SystemdAccountFileWorkerPool({ incidentDir, verifyExecutable: async () => 'a'.repeat(64), onRecoveryRequired: () => { calls++ } })
    await assert.rejects(() => worker.run({ ...input, onStdoutLine: () => { fixture.failSync = true } }), (error) => isXpanelError(error) && error.message.includes('could not be cleared durably'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    await assert.rejects(() => worker.run(input), code('SERVICE_UNAVAILABLE'))
  })

  it('releases slots after policy refusal and after an ordinary completed helper operation', async () => {
    const worker = pool()
    const canonical = fixture.sliceFields
    fixture.sliceFields = canonical.replace('LoadState=loaded', 'LoadState=not-found')
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(() => worker.run(async () => input), code('PRECONDITION_FAILED'))
    fixture.sliceFields = canonical
    for (let attempt = 0; attempt < 5; attempt++) {
      // Each invocation uses a fresh generated service identity in production;
      // clear this boundary's already-collected simulated status between calls.
      fixture.observed = false
      assert.equal((await worker.run(async () => input)).exitCode, 0)
    }
  })
})
