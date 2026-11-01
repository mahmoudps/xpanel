import { afterEach, describe, expect, it, vi } from 'vitest'
import { protectInstalledStateParent, setStateOwnershipDepsForTests } from './ownership.ts'

const ROOT = '/var/lib/xpanel'
const installed = { dbPath: '/var/lib/xpanel/control.db', stateDir: '/var/lib/xpanel/state' }
const owner = { uid: 22001, gid: 22002 }
const metadata = (uid: number, gid: number, mode: number, ino: number, symbolic = false) => ({
  uid, gid, mode: 0o040000 | mode, dev: 7, ino,
  isDirectory: () => !symbolic,
  isSymbolicLink: () => symbolic,
})

const fixture = (mode = 0o2770) => {
  let held = metadata(owner.uid, owner.gid, mode, 41)
  let named = { ...held }
  let phase = 0
  const parents = new Map([
    ['/', metadata(0, 0, 0o755, 1)],
    ['/var', metadata(0, 0, 0o755, 2)],
    ['/var/lib', metadata(0, 0, 0o755, 3)],
  ])
  const close = vi.fn(async () => {})
  const chown = vi.fn(async () => {})
  const chmod = vi.fn(async (next: number) => {
    held = { ...held, mode: 0o040000 | next }
    named = { ...named, mode: 0o040000 | next }
    phase = 1
  })
  const inspectPath = vi.fn(async (path: string) => {
    if (path === ROOT) return { ...named }
    const node = parents.get(path)
    if (!node) throw new Error('unexpected inspected path')
    return { ...node }
  })
  const openInstalledParent = vi.fn(async () => ({
    stat: async () => ({ ...held }),
    chmod,
    close,
  }))
  setStateOwnershipDepsForTests({
    platform: () => 'linux',
    euid: () => owner.uid,
    lookup: name => name === 'xpanel' ? { ...owner } : null,
    chown, inspectPath, openInstalledParent,
  })
  return {
    parents, close, chown, chmod, inspectPath, openInstalledParent,
    get held() { return held }, get named() { return named }, get phase() { return phase },
    replaceHeld: (node: ReturnType<typeof metadata>) => { held = node },
    replaceNamed: (node: ReturnType<typeof metadata>) => { named = node },
  }
}

afterEach(() => { setStateOwnershipDepsForTests(null) })

describe('installed state parent permission repair', () => {

  for (const configuration of [
    { name: 'temporary state', dbPath: installed.dbPath, stateDir: '/var/tmp/qa/state' },
    { name: 'temporary database', dbPath: '/var/tmp/qa/control.db', stateDir: installed.stateDir },
    { name: 'entire private store', dbPath: '/var/tmp/qa/control.db', stateDir: '/var/tmp/qa/state' },
    { name: 'noncanonical path spelling', dbPath: installed.dbPath, stateDir: '/var/lib/xpanel/state/../state' },
  ]) {
    it('does not inspect an unrelated installed tree for ' + configuration.name, async () => {
      const fs = fixture()
      await protectInstalledStateParent(configuration)
      expect(fs.inspectPath).not.toHaveBeenCalled()
      expect(fs.openInstalledParent).not.toHaveBeenCalled()
      expect(fs.chmod).not.toHaveBeenCalled()
      expect(fs.chown).not.toHaveBeenCalled()
    })
  }

  it('does not inspect a Linux installation from non-Linux startup', async () => {
    const fs = fixture()
    setStateOwnershipDepsForTests({ platform: () => 'win32', euid: () => owner.uid,
      lookup: () => ({ ...owner }), chown: fs.chown, inspectPath: fs.inspectPath, openInstalledParent: fs.openInstalledParent })
    await protectInstalledStateParent(installed)
    expect(fs.inspectPath).not.toHaveBeenCalled()
    expect(fs.openInstalledParent).not.toHaveBeenCalled()
    expect(fs.chmod).not.toHaveBeenCalled()
  })
  it('removes only legacy group write while retaining the API owner and held directory', async () => {
    const fs = fixture()
    await protectInstalledStateParent(installed)
    expect(fs.chmod.mock.calls).toEqual([[0o2750]])
    expect(fs.held).toMatchObject({ uid: owner.uid, gid: owner.gid, dev: 7, ino: 41, mode: 0o042750 })
    expect(fs.named).toMatchObject({ uid: owner.uid, gid: owner.gid, dev: 7, ino: 41, mode: 0o042750 })
    expect(fs.chown).not.toHaveBeenCalled()
    expect(fs.close).toHaveBeenCalledTimes(1)
    expect(new Set(fs.inspectPath.mock.calls.map(call => call[0]))).toEqual(new Set(['/', '/var', '/var/lib', ROOT]))
  })

  it('accepts another startup narrowing the same inode before the held stat without writing again', async () => {
    const fs = fixture()
    fs.openInstalledParent.mockImplementationOnce(async () => {
      expect(fs.inspectPath.mock.calls[0]).toEqual([ROOT])
      expect(fs.named.mode & 0o7777).toBe(0o2770)
      const narrowed = metadata(owner.uid, owner.gid, 0o2750, 41)
      fs.replaceHeld(narrowed)
      fs.replaceNamed({ ...narrowed })
      return { stat: async () => ({ ...fs.held }), chmod: fs.chmod, close: fs.close }
    })
    await protectInstalledStateParent(installed)
    expect(fs.held).toMatchObject({ uid: owner.uid, gid: owner.gid, dev: 7, ino: 41, mode: 0o042750 })
    expect(fs.named).toMatchObject({ uid: owner.uid, gid: owner.gid, dev: 7, ino: 41, mode: 0o042750 })
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.chown).not.toHaveBeenCalled()
    expect(fs.close).toHaveBeenCalledTimes(1)
  })

  it('leaves the new normal installer mode unchanged', async () => {
    const fs = fixture(0o2750)
    await protectInstalledStateParent(installed)
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.chown).not.toHaveBeenCalled()
    expect(fs.close).toHaveBeenCalledTimes(1)
  })

  const invalidNodes: [string, ReturnType<typeof metadata>][] = [
    ['foreign UID', metadata(22003, owner.gid, 0o2770, 41)],
    ['socket group instead of the API primary group', metadata(owner.uid, 22004, 0o2770, 41)],
    ['world writable mode', metadata(owner.uid, owner.gid, 0o2777, 41)],
    ['unexpected mode', metadata(owner.uid, owner.gid, 0o2775, 41)],
    ['symbolic directory name', metadata(owner.uid, owner.gid, 0o2770, 41, true)],
  ]
  it.each(invalidNodes)('refuses %s without changing ownership or permissions', async (_name, node) => {
    const fs = fixture()
    fs.replaceNamed(node)
    fs.replaceHeld(node)
    await expect(protectInstalledStateParent(installed)).rejects.toThrow('inspected ownership or permission repair')
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.chown).not.toHaveBeenCalled()
  })

  it('refuses a writable ancestor above the installed parent', async () => {
    const fs = fixture()
    fs.parents.set('/var/lib', metadata(0, 0, 0o775, 3))
    await expect(protectInstalledStateParent(installed)).rejects.toThrow('inspected ownership or permission repair')
    expect(fs.openInstalledParent).not.toHaveBeenCalled()
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.chown).not.toHaveBeenCalled()
  })

  it('refuses a different held inode before any chmod', async () => {
    const fs = fixture()
    fs.replaceHeld(metadata(owner.uid, owner.gid, 0o2770, 99))
    await expect(protectInstalledStateParent(installed)).rejects.toThrow('inspected ownership or permission repair')
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.close).toHaveBeenCalledTimes(1)
  })

  it('detects a swapped name after restricting the original held directory', async () => {
    const fs = fixture()
    fs.chmod.mockImplementation(async next => {
      fs.replaceHeld(metadata(owner.uid, owner.gid, next, 41))
      fs.replaceNamed(metadata(owner.uid, owner.gid, next, 99))
    })
    await expect(protectInstalledStateParent(installed)).rejects.toThrow('inspected ownership or permission repair')
    expect(fs.chmod.mock.calls).toEqual([[0o2750]])
    expect(fs.chown).not.toHaveBeenCalled()
    expect(fs.close).toHaveBeenCalledTimes(1)
  })

  it('refuses a caller that is neither root nor the canonical API owner', async () => {
    const fs = fixture()
    setStateOwnershipDepsForTests({ platform: () => 'linux', euid: () => 22003,
      lookup: () => ({ ...owner }), chown: fs.chown, inspectPath: fs.inspectPath, openInstalledParent: fs.openInstalledParent })
    await expect(protectInstalledStateParent(installed)).rejects.toThrow('inspected ownership or permission repair')
    expect(fs.openInstalledParent).not.toHaveBeenCalled()
    expect(fs.chmod).not.toHaveBeenCalled()
  })

  it('does not create a missing canonical installation parent', async () => {
    const fs = fixture()
    fs.inspectPath.mockRejectedValueOnce(Object.assign(new Error('absent'), { code: 'ENOENT' }))
    await protectInstalledStateParent(installed)
    expect(fs.openInstalledParent).not.toHaveBeenCalled()
    expect(fs.chmod).not.toHaveBeenCalled()
    expect(fs.chown).not.toHaveBeenCalled()
  })
})

