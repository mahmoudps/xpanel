import { link, mkdtemp, mkdir, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinuxHostExecutor } from './executor.ts'
import { removePinnedHostTree, withPinnedHostTargetParent } from './host-target-parent.ts'

const hooks = vi.hoisted(() => ({ afterOpen: undefined as undefined | ((path: string, handle: FileHandle) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    await hooks.afterOpen?.(String(args[0]), handle)
    return handle
  }) }
})

describe.runIf(process.platform === 'linux')('native Linux pinned managed target parents', () => {
  let root: string, parent: string, retired: string, outside: string, target: string, original: string, outsideTarget: string
  let executor: LinuxHostExecutor
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'xpanel-pinned-host-'))
    parent = join(root, 'account', 'public_html'); retired = join(root, 'account', 'retired')
    outside = join(root, 'outside'); target = join(parent, '.user.ini'); original = join(retired, '.user.ini'); outsideTarget = join(outside, '.user.ini')
    await mkdir(parent, { recursive: true }); await mkdir(outside)
    await writeFile(target, 'original-account-content'); await writeFile(outsideTarget, 'protected-outside-content')
    executor = new LinuxHostExecutor({ trustedHostTargets: [{ path: target, operations: ['read', 'write', 'remove'] }] })
    hooks.afterOpen = undefined
    vi.mocked(open).mockClear()
  })
  afterEach(async () => { hooks.afterOpen = undefined; await rm(root, { recursive: true, force: true }) })

  it.each(['read', 'write', 'remove'] as const)('keeps %s on the pinned directory when a tenant swaps the ancestor after open', async operation => {
    let swapped = false
    hooks.afterOpen = async path => {
      if (!swapped && path.endsWith('/public_html')) {
        swapped = true
        await rename(parent, retired)
        await symlink(outside, parent, 'dir')
      }
    }
    if (operation === 'read') expect(await executor.readFile(target)).toBe('original-account-content')
    else if (operation === 'write') await executor.writeFile({ path: target, content: 'updated-account-content', mode: 0o600 })
    else await executor.removePath(target)
    expect(swapped).toBe(true)
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
    if (operation === 'remove') await expect(readFile(original, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(original, 'utf8')).toBe(operation === 'write' ? 'updated-account-content' : 'original-account-content')
  })

  it('refuses a hardlinked managed read from the opened file metadata', async () => {
    await rm(target); await link(outsideTarget, target)
    await expect(executor.readFile(target)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
  })
  it('refuses a symlink managed read', async () => {
    await rm(target); await symlink(outsideTarget, target)
    await expect(executor.readFile(target)).rejects.toThrow()
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
  })
  it('rejects an owned FIFO fixture without waiting for a writer', async () => {
    await rm(target)
    execFileSync('/usr/bin/mkfifo', [target], { timeout: 1000 })
    await expect(executor.readFile(target)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('atomic replacement does not write through an existing hardlinked leaf', async () => {
    await rm(target); await link(outsideTarget, target)
    await executor.writeFile({ path: target, content: 'replacement', mode: 0o600 })
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
    expect(await readFile(target, 'utf8')).toBe('replacement')
  })

  it.each([false, true])('reports close failure while retaining an operation failure: %s', async operationFails => {
    const primary = new Error('fixture operation failed'), closeFailure = new Error('fixture parent close failed')
    hooks.afterOpen = async (path, handle) => {
      if (path !== '/') return
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); throw closeFailure }
    }
    let observed: unknown
    try { await withPinnedHostTargetParent(target, async () => { if (operationFails) throw primary; return true }) }
    catch (error) { observed = error }
    expect(observed).toBeInstanceOf(AggregateError)
    expect((observed as AggregateError).errors).toContain(closeFailure)
    if (operationFails) {
      expect((observed as AggregateError).cause).toBe(primary)
      expect((observed as AggregateError).errors).toContain(primary)
    }
  })

  it('removes an owned nested fixture while retaining its sibling fixture', async () => {
    const mailbox = join(root, 'mailbox')
    await mkdir(join(mailbox, 'cur', 'nested'), { recursive: true })
    await mkdir(join(mailbox, 'new'))
    await writeFile(join(mailbox, 'cur', 'nested', 'message'), 'fixture-message')
    await link(outsideTarget, join(mailbox, 'new', 'linked-message'))
    await withPinnedHostTargetParent(mailbox, removePinnedHostTree)
    await expect(readFile(join(mailbox, 'cur', 'nested', 'message'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
  })
  it('removes a fixture directory link without traversing its target fixture', async () => {
    const mailbox = join(root, 'mailbox')
    await mkdir(mailbox)
    await symlink(outside, join(mailbox, 'cur'), 'dir')
    await withPinnedHostTargetParent(mailbox, removePinnedHostTree)
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
  })
  it('refuses to recurse into a replacement child directory after the original child was pinned', async () => {
    const mailbox = join(root, 'mailbox'), child = join(mailbox, 'cur')
    await mkdir(child, { recursive: true }); await writeFile(join(child, 'message'), 'original-message')
    let replaced = false
    hooks.afterOpen = async path => {
      if (replaced || !path.endsWith('/cur')) return
      replaced = true
      await rename(child, join(mailbox, 'retained-child'))
      await mkdir(child); await writeFile(join(child, 'replacement-guard'), 'retain-this-fixture')
    }
    await expect(withPinnedHostTargetParent(mailbox, removePinnedHostTree)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(replaced).toBe(true)
    expect(await readFile(join(child, 'replacement-guard'), 'utf8')).toBe('retain-this-fixture')
    expect(await readFile(outsideTarget, 'utf8')).toBe('protected-outside-content')
  })
})
