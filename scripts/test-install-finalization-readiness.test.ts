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
