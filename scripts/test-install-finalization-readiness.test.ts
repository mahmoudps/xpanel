import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Exact internal pure declarations from the candidate. No Linux, CA, service, lock or native authority is emulated.
const source = readFileSync(new URL('./install-finalization-readiness.mjs', import.meta.url), 'utf8')
const declared = (name: string): string => {
  const start = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(source)
  if (!start) throw new Error('missing readiness declaration: ' + name)
  const tail = source.slice(start.index), end = /\n}\n/.exec(tail)
  if (!end) throw new Error('incomplete readiness declaration: ' + name)
  return tail.slice(0, end.index + end[0].length)
}
const check = (value: unknown, code: string) => { if (!value) throw Object.assign(new Error(code), { code }) }
const factory = new Function('check', 'SHA', 'DECIMAL', 'WINDOW_MS', 'hash', 'posix',
  ['canonical', 'checkedContext', 'checkedFacts', 'createReadinessObserver'].map(declared).join('\n') + '\nreturn createReadinessObserver'
)(check, /^[a-f0-9]{64}$/, /^(0|[1-9][0-9]{0,19})$/, 30_000, (value: string) => createHash('sha256').update(value).digest('hex'), posix)

describe('prepared readiness runtime identity', () => {
  const start = source.indexOf('const fileIdentity ='), end = source.indexOf('async function procText(', start)
  if (start < 0 || end <= start) throw new Error('runtime identity source missing')

  function runtimeFixture() {
    const runtime = { nodePath: '/opt/node/bin/node', nodeSha256: 'a'.repeat(64) }
    const baseline = { dev: 1n, ino: 2n, uid: 0n, gid: 0n, mode: 0o755n, size: 500n, nlink: 1n,
      mtimeNs: 4n, ctimeNs: 5n, isFile: () => true, isSymbolicLink: () => false }
    let current = { ...baseline }, closed = 0
    const hashRead = vi.fn(async () => ({ info: { ...baseline }, sha256: runtime.nodeSha256 }))
    const open = vi.fn(async () => ({ stat: async () => ({ ...baseline }), close: async () => { closed++ } }))
    const withTrustedDirectory = async (path: string, run: (pin: { verify(): Promise<void> }) => unknown) => {
      expect(path).toBe('/opt/node/bin')
      return run({ verify: async () => {} })
    }
    const api = new Function('check', 'posix', 'constants', 'readTrustedFile', 'withTrustedDirectory', 'open', 'lstat', 'canonical',
      source.slice(start, end) + '\nreturn { readReadinessRuntime, fileIdentity }')(
      check, posix, { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2 }, hashRead,
      withTrustedDirectory, open, async () => ({ ...current }), JSON.stringify)
    const previous = { pins: { node: { ...api.fileIdentity(baseline), sha256: runtime.nodeSha256 } } }
    return { runtime, previous, hashRead, open, api,
      change: (updates: Partial<typeof baseline>) => { current = { ...baseline, ...updates } }, closed: () => closed }
  }

  it('authenticates runtime bytes at capture and checks the captured inode on later observations', async () => {
    const f = runtimeFixture()
    const first = await f.api.readReadinessRuntime(f.runtime)
    const next = await f.api.readReadinessRuntime(f.runtime, f.previous)
    expect(f.api.fileIdentity(next.info)).toEqual(f.api.fileIdentity(first.info))
    expect(next.sha256).toBe(first.sha256)
    expect(f.hashRead).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledWith(f.runtime.nodePath, 3)
    expect(f.closed()).toBe(1)
  })

  it('refuses same-size rewrites, exchanged inodes, extra links and symlinks', async () => {
    for (const updates of [{ ctimeNs: 6n }, { ino: 3n }, { nlink: 2n }, { isSymbolicLink: () => true }]) {
      const f = runtimeFixture()
      f.change(updates)
      await expect(f.api.readReadinessRuntime(f.runtime, f.previous)).rejects.toThrow('INSTALL_READINESS_RUNTIME_CHANGED')
      expect(f.hashRead).not.toHaveBeenCalled()
      expect(f.closed()).toBe(1)
    }
  })
})

const fixture = () => {
  let time = Date.parse('2026-10-30T10:00:00.000Z')
  const hash = (letter: string) => letter.repeat(64)
  const context = {
    source: { root: '/opt/xpanel', version: '1.2.3', archiveSha256: hash('a'), manifestSha256: hash('b'), dependencyReceiptSha256: hash('c'), controlDbSchemaVersion: 6 },
    runtime: { nodePath: '/usr/bin/node', nodeVersion: '26.12.1', nodeSha256: hash('d'), systemctlSha256: hash('e'), nginxSha256: hash('f') },
    database: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: '11111111-1111-4111-8111-111111111111' },
    rootPrincipalId: '22222222-2222-4222-8222-222222222222',
    state: { revision: 1, checksum: hash('1'), accountCount: 0 }, admissionFingerprint: hash('2'),
  }
  const management = { configSha256: hash('3'), certificateSha256: hash('4'), audiences: ['xwhm', 'xpanel', 'xmail'], references: [{ path: '/etc/xpanel/management-tls.json', inode: '11', sha256: hash('5') }] }
  const facts = {
    processes: ['api', 'agent'].map((role, index) => ({ role, pid: 42 + index, start: '1000', uid: role === 'api' ? 991 : 0,
      executable: '/usr/bin/node', cwd: '/opt/xpanel/releases/1.2.3', cgroup: '/system.slice/xpanel-' + role + '.service',
      invocationId: String(index + 1).repeat(32), socketDevice: '1', socketInode: String(40 + index) })),
    ingress: { configSha256: management.configSha256, certificateSha256: management.certificateSha256, audiences: [...management.audiences] },
    pins: { management, sockets: [{ port: 12083, inode: '40' }, { port: 12087, inode: '41' }, { port: 12096, inode: '42' }, { path: '/run/xpanel/agent.sock', inode: '43' }] },
  }
  let onRead: (() => void) | undefined, onHttps: (() => void) | undefined
  const readFacts = vi.fn(async (_context: unknown, _previous?: unknown) => { onRead?.(); return structuredClone(facts) })
  const observeHttps = vi.fn(async () => { onHttps?.(); return structuredClone(facts.pins.management) })
  const assertRoot = vi.fn()
  const observer = factory({ assertRoot, now: () => time, readFacts, observeHttps })
  return { context, facts, subject: hash('6'), observer, readFacts, observeHttps, assertRoot,
    time: (value: number) => { time += value }, onRead: (fn: (() => void) | undefined) => { onRead = fn }, onHttps: (fn: (() => void) | undefined) => { onHttps = fn } }
}

describe('install readiness isolated observation binding (not native qualification)', () => {
  it('captures current facts and accepts a structured-cloned observation without any EX network call', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    expect(value.mode).toBe('normal')
    expect(value.processes).toHaveLength(2)
    expect(Date.parse(value.expiresAt) - Date.parse(value.observedAt)).toBe(30_000)
    expect(f.observeHttps).toHaveBeenCalledTimes(1)
    await f.observer.assertCurrent(structuredClone(f.context), structuredClone(value))
    expect(f.observeHttps).toHaveBeenCalledTimes(1)
    expect(f.readFacts).toHaveBeenCalledTimes(3)
    expect(f.readFacts.mock.calls[2]?.[1]).toEqual(f.facts)
  })

  it.each(['pid', 'start', 'uid', 'cwd', 'invocationId', 'socketInode'] as const)('refuses changed process %s after SH observation', async field => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject), process = f.facts.processes[0]!
    if (field === 'pid' || field === 'uid') process[field] += 1
    else process[field] += '-changed'
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toBeDefined()
    expect(f.observeHttps).toHaveBeenCalledTimes(1)
  })

  it('binds all private listener pins, not only the representative public API socket', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    f.facts.pins.sockets[2]!.inode = '999'
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toMatchObject({ code: 'INSTALL_READINESS_CHANGED' })
  })

  it.each(['subject', 'context', 'foreign-capture'] as const)('refuses %s without granting a data object authority', async kind => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    const context = structuredClone(f.context), observation = structuredClone(value)
    if (kind === 'subject') observation.subjectDigest = '7'.repeat(64)
    if (kind === 'context') context.admissionFingerprint = '8'.repeat(64)
    const observer = kind === 'foreign-capture' ? fixture().observer : f.observer
    await expect(observer.assertCurrent(context, observation)).rejects.toMatchObject({ code: 'INSTALL_READINESS_CAPTURE_REQUIRED' })
  })

  it('refuses expiry before any EX filesystem/provenance work', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject), before = f.readFacts.mock.calls.length
    f.time(30_000)
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toMatchObject({ code: 'INSTALL_READINESS_EXPIRED' })
    expect(f.readFacts).toHaveBeenCalledTimes(before)
    expect(f.observeHttps).toHaveBeenCalledTimes(1)
  })

  it('checks the deadline again after the last awaited EX read', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    f.onRead(() => f.time(30_000))
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toMatchObject({ code: 'INSTALL_READINESS_EXPIRED' })
    expect(f.observeHttps).toHaveBeenCalledTimes(1)
  })

  it('refuses a source/process change while HTTPS is in flight', async () => {
    const f = fixture()
    f.onHttps(() => { f.facts.pins.sockets[0]!.inode = '900' })
    await expect(f.observer.capture(f.context, f.subject)).rejects.toMatchObject({ code: 'INSTALL_READINESS_CHANGED' })
  })

  it('does not issue an overlong capture after slow observations', async () => {
    const f = fixture()
    f.onHttps(() => f.time(30_000))
    await expect(f.observer.capture(f.context, f.subject)).rejects.toMatchObject({ code: 'INSTALL_READINESS_EXPIRED' })
  })

  it('refuses changed TLS or a missing audience', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    f.facts.ingress.certificateSha256 = '9'.repeat(64)
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toMatchObject({ code: 'INSTALL_READINESS_CHANGED' })
    const missing = fixture()
    missing.facts.ingress.audiences.pop()
    await expect(missing.observer.capture(missing.context, missing.subject)).rejects.toMatchObject({ code: 'INSTALL_READINESS_INGRESS_INVALID' })
  })

  it('retires its cache and denies replay after release', async () => {
    const f = fixture(), value = await f.observer.capture(f.context, f.subject)
    f.observer.release(structuredClone(value))
    await expect(f.observer.assertCurrent(f.context, value)).rejects.toMatchObject({ code: 'INSTALL_READINESS_CAPTURE_REQUIRED' })
  })

  it('honors the native root gate before I/O in either phase', async () => {
    const f = fixture()
    f.assertRoot.mockImplementation(() => { throw Object.assign(new Error('root'), { code: 'LINUX_ROOT_REQUIRED' }) })
    await expect(f.observer.capture(f.context, f.subject)).rejects.toMatchObject({ code: 'LINUX_ROOT_REQUIRED' })
    expect(f.readFacts).not.toHaveBeenCalled()
    expect(f.observeHttps).not.toHaveBeenCalled()
  })
})


const tlsSource = readFileSync(new URL('./management-tls.mjs', import.meta.url), 'utf8')
const tlsCaptureDeclaration = (() => {
  const start = /^export async function captureManagementTlsReadiness\(/m.exec(tlsSource)
  if (!start) throw new Error('missing readonly management capture')
  const tail = tlsSource.slice(start.index), end = /\n}\n/.exec(tail)
  if (!end) throw new Error('incomplete readonly management capture')
  return tail.slice(0, end.index + end[0].length).replace(/^export /, '')
})()
const tlsCapture = (state: () => unknown, servedReady: (...args: unknown[]) => Promise<unknown>) => new Function(
  'readManagementTlsReadiness', 'validateConfig', 'readRootFile', 'PATHS', 'servedReady', 'fail',
  tlsCaptureDeclaration + '\nreturn captureManagementTlsReadiness'
)(state, (value: unknown) => value, () => ({ bytes: Buffer.from('{}') }), { config: '/fixed/config' }, servedReady,
  (code: string) => { throw Object.assign(new Error(code), { code }) })

describe('readonly TLS capture sequencing (isolated, no HTTP or CA)', () => {
  it('waits for the entire configured HTTPS check before returning a capture', async () => {
    const state = { certificateSha256: 'a'.repeat(64), configSha256: 'b'.repeat(64) }
    let release!: () => void, complete = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const probe = vi.fn(async () => { await gate; complete = true })
    const capture = tlsCapture(() => structuredClone(state), probe)
    let returned = false
    const pending = capture().then((result: unknown) => { returned = true; return result })
    await Promise.resolve()
    expect(returned).toBe(false)
    release()
    expect(await pending).toEqual(state)
    expect(complete).toBe(true)
    expect(probe).toHaveBeenCalledWith({}, { generation: state.certificateSha256 }, true)
  })
  it('rejects a changed protected TLS snapshot after HTTP completes', async () => {
    let counter = 0
    const capture = tlsCapture(() => ({ certificateSha256: String(counter++).repeat(64) }), async () => {})
    await expect(capture()).rejects.toMatchObject({ code: 'INSTALL_READINESS_TLS_CHANGED' })
  })
  it('does not issue a capture on failed HTTPS/login readiness', async () => {
    const capture = tlsCapture(() => ({ certificateSha256: 'a'.repeat(64) }), async () => { throw Object.assign(new Error('login'), { code: 'APPLICATION_LOGIN_NOT_READY' }) })
    await expect(capture()).rejects.toMatchObject({ code: 'APPLICATION_LOGIN_NOT_READY' })
  })
})


describe('EX unit snapshot uses protected file/cgroup reads only (isolated)', () => {
  const setup = () => {
    const names = ['xpanel-api.service', 'xpanel-agent.service']
    const units = names.map((Id, index) => ({ Id, MainPID: String(42 + index), ControlGroup: '/system.slice/' + Id }))
    const files = names.map(name => ({ path: '/etc/systemd/system/' + name, kind: 'file' }))
    const cgroups = units.map(unit => ({ path: unit.ControlGroup, exists: true, nodes: [], processes: [Number(unit.MainPID)], populated: true }))
    const observe = vi.fn(async () => ({ observations: [{ units, cgroups }] }))
    const owned = vi.fn(async (_file: unknown) => {}), trusted = vi.fn(async (_path: string) => {})
    const tree = vi.fn(async (path: string) => {
      const group = cgroups.find(item => '/sys/fs/cgroup' + item.path === path)
      if (!group) throw new Error('unexpected cgroup read')
      return { nodes: group.nodes, processes: group.processes, populated: group.populated }
    })
    const read = new Function('check', 'assertOwnedFile', 'observeOwnedControlPlaneUnits', 'projectOwnedControlPlaneObservation',
      'assertTrustedDirectory', 'readBoundedCgroupTree', declared('readUnitSnapshot') + '\nreturn readUnitSnapshot'
    )(check, owned, observe, (value: unknown) => value, trusted, tree)
    return { units, files, cgroups, observe, owned, trusted, tree, read }
  }
  it('uses the actual observation port during SH capture', async () => {
    const f = setup()
    const result = await f.read({ files: f.files }, null)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.tree).not.toHaveBeenCalled()
    expect(result.units).toEqual(f.units)
    expect(f.owned).toHaveBeenCalledTimes(2)
  })
  it('never invokes the systemctl observer during EX revalidation', async () => {
    const f = setup()
    f.observe.mockImplementation(async () => { throw new Error('EX may not execute systemctl or D-Bus') })
    const result = await f.read({ files: f.files }, { pins: { units: f.units } })
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.tree).toHaveBeenCalledTimes(2)
    expect(f.tree.mock.calls.map(call => call[0])).toEqual(['/sys/fs/cgroup/system.slice/xpanel-api.service', '/sys/fs/cgroup/system.slice/xpanel-agent.service'])
    expect(result.cgroups).toEqual([...f.cgroups].sort((a, b) => a.path.localeCompare(b.path)))
  })
  it('rejects a foreign captured cgroup before reading it', async () => {
    const f = setup(), units = structuredClone(f.units)
    units[0]!.ControlGroup = '/tmp/foreign'
    await expect(f.read({ files: f.files }, { pins: { units } })).rejects.toMatchObject({ code: 'INSTALL_READINESS_UNIT_CAPTURE_INVALID' })
    expect(f.tree).not.toHaveBeenCalled()
    expect(f.observe).not.toHaveBeenCalled()
  })
  it('rejects a changed owned unit file without invoking the system observer', async () => {
    const f = setup()
    f.owned.mockImplementation(async () => { throw Object.assign(new Error('unit drift'), { code: 'OWNED_FILE_DRIFT' }) })
    await expect(f.read({ files: f.files }, { pins: { units: f.units } })).rejects.toMatchObject({ code: 'OWNED_FILE_DRIFT' })
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.tree).not.toHaveBeenCalled()
  })
})

describe('readiness cgroup writer-lock waiters', () => {
  const cgroup = '/system.slice/xpanel-agent.service'
  const service = { pid: 42, uid: 0, cgroup }
  const root = { path: '/sys/fs/cgroup' + cgroup, processes: [42, 43] }
  const group = { path: cgroup, exists: true, populated: true, nodes: [root], processes: [42, 43] }

  function fixture() {
    const identity = (parent: number, start: number) => `43 (flock) S ${parent} ${'0 '.repeat(17)}${start}`
    const tool = { dev: 1n, ino: 2n }, lock = { dev: 1n, ino: 3n }
    const proc = { stat: identity(42, 100), status: 'Uid:\t0\t0\t0\t0\n', cgroup: '0::' + cgroup + '\n',
      cmdline: ['/proc/self/fd/4', '--shared', '--timeout', '15', '3', ''].join('\0') }
    const files = { exe: tool, 'fd/4': tool, 'fd/3': lock }
    const close = vi.fn(async () => {}), readlink = vi.fn(async () => '/usr/bin/flock')
    const procText = vi.fn(async (_root: string, name: keyof typeof proc) => proc[name])
    const project = new Function('LIFECYCLE_LOCK', 'constants', 'open', 'procText', 'readlink', 'stat', 'withTrustedFile', 'check',
      ['processStart', 'isWriterLockChild', 'projectReadinessCgroups'].map(declared).join('\n') + '\nreturn projectReadinessCgroups'
    )('/var/lib/xpanel-lifecycle/writer.lock', {}, async () => ({ fd: 50, close }), procText, readlink,
      async (path: string) => files[path.replace('/proc/self/fd/50/', '') as keyof typeof files],
      async (path: string, _options: unknown, run: (value: unknown) => Promise<unknown>) => run({ info: path.endsWith('/flock') ? tool : lock }), check)
    return { identity, proc, files, close, readlink, procText, project }
  }

  it('projects away an authenticated waiter while keeping the main process and cgroup identity', async () => {
    const f = fixture()
    const expected = { ...group, nodes: [{ ...root, processes: [42] }], processes: [42] }
    expect(await f.project([group], [service])).toEqual([expected])
    expect(await f.project([expected], [service])).toEqual([expected])
    expect(f.close).toHaveBeenCalledOnce()
    expect(group.processes).toEqual([42, 43])
  })

  it.each(['parent', 'uid', 'arguments', 'cgroup', 'lock-fd', 'tool-fd', 'executable', 'retired', 'changed-start'])(
    'keeps an unauthenticated member when %s fails', async mismatch => {
      const f = fixture()
      if (mismatch === 'parent') f.proc.stat = f.identity(41, 100)
      if (mismatch === 'uid') f.proc.status = 'Uid:\t0\t1\t0\t0\n'
      if (mismatch === 'arguments') f.proc.cmdline = f.proc.cmdline.replace('--shared', '--exclusive')
      if (mismatch === 'cgroup') f.proc.cgroup = '0::/elsewhere\n'
      if (mismatch === 'lock-fd') f.files['fd/3'] = f.files.exe
      if (mismatch === 'tool-fd') f.files['fd/4'] = f.files['fd/3']
      if (mismatch === 'executable') f.readlink.mockResolvedValue('/tmp/flock')
      if (mismatch === 'retired') f.procText.mockRejectedValueOnce(Object.assign(new Error(), { code: 'ENOENT' }))
      if (mismatch === 'changed-start') f.procText.mockResolvedValueOnce(f.proc.stat).mockImplementation(async (_root, name) =>
        name === 'stat' ? f.identity(42, 101) : f.proc[name])
      expect(await f.project([group], [service])).toEqual([group])
      expect(f.close).toHaveBeenCalledOnce()
    })

  it('keeps moved members and descendant cgroup topology', async () => {
    const f = fixture()
    const moved = { ...group, nodes: [{ ...root, processes: [42] }, { path: root.path + '/unexpected', processes: [43] }] }
    expect(await f.project([moved], [service])).toEqual([moved])
    expect(f.procText).not.toHaveBeenCalled()
  })
})
