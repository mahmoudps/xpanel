import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'

const native = vi.hoisted(() => ({ calls: [] as string[][], onSpawn: undefined as ((argv: string[]) => void) | undefined }))
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'),
  execFile(binary: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) {
    const argv = [binary, ...args]
    native.calls.push(argv)
    native.onSpawn?.(argv)
    callback(null, 'ActiveState=active\n', '')
    return { pid: 1 }
  },
}))

import { LinuxHostExecutor } from './executor.ts'
import { withHostEffectAuthority } from './host-effect-authority.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native executor operation boundary (mocked subprocesses, not native qualification)', () => {
  beforeEach(() => { native.calls.length = 0; native.onSpawn = undefined })

  it('checks revocation after a read probe and before the next actual native effect', async () => {
    const executor = new LinuxHostExecutor()
    let allowed = true
    native.onSpawn = argv => { if (argv[0] === '/usr/bin/id') allowed = false }
    await expect(withHostEffectAuthority(executor, { signal: new AbortController().signal,
      async assertAuthority() { if (!allowed) fail('FORBIDDEN', 'revoked') },
    }, () => executor.runAction({ kind: 'ensure-user', name: 'alice', uid: 2001, gid: 2001, home: '/home/alice', shell: '/bin/false' })))
      .rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(native.calls).toEqual([['/usr/bin/id', '-u', 'alice']])
  })

  it('denies service mutations during read-only reobservation but preserves normal calls', async () => {
    const executor = new LinuxHostExecutor()
    await expect(withHostEffectAuthority(executor, { signal: new AbortController().signal, readOnly: true, async assertAuthority() {} },
      () => executor.runAction({ kind: 'systemd', verb: 'restart', unit: 'nginx.service' })))
      .rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(native.calls).toHaveLength(0)
    await executor.runAction({ kind: 'systemd', verb: 'restart', unit: 'nginx.service' })
    expect(native.calls).toEqual([['/usr/bin/systemctl', 'restart', 'nginx.service']])
  })

  it('captures argv before an awaited authorization read so observation cannot become restart', async () => {
    const executor = new LinuxHostExecutor(), entered = deferred(), release = deferred()
    const argv = ['/usr/bin/systemctl', 'show', '--no-pager', '--property=Id,Names,LoadState,ActiveState,SubState,UnitFileState', '--', 'nginx.service']
    let blockNext = false
    await withHostEffectAuthority(executor, { signal: new AbortController().signal, readOnly: true,
      async assertAuthority() { if (blockNext) { blockNext = false; entered.resolve(); await release.promise } },
    }, async () => {
      blockNext = true
      const observation = executor.runCommand(argv)
      await entered.promise
      argv.splice(1, argv.length - 1, 'restart', 'nginx.service')
      release.resolve()
      await observation
    })
    expect(native.calls).toHaveLength(1)
    expect(native.calls[0]?.[1]).toBe('show')
  })

  it('reports an in-flight native mutation as requiring verification when cancellation arrives', async () => {
    const executor = new LinuxHostExecutor(), abort = new AbortController()
    native.onSpawn = () => { abort.abort() }
    await expect(withHostEffectAuthority(executor, { signal: abort.signal, async assertAuthority() {} },
      () => executor.runAction({ kind: 'systemd', verb: 'restart', unit: 'nginx.service' })))
      .rejects.toMatchObject({ detail: { stateChanged: true, verificationRequired: true } })
    expect(native.calls).toEqual([['/usr/bin/systemctl', 'restart', 'nginx.service']])
  })

  it('does not spawn a delayed command after the admitted async scope has retired', async () => {
    const executor = new LinuxHostExecutor(), later = deferred()
    let child!: Promise<unknown>
    await withHostEffectAuthority(executor, { signal: new AbortController().signal, async assertAuthority() {} }, async () => {
      child = later.promise.then(() => executor.runCommand(['/usr/bin/id', '-u', 'alice']))
    })
    const rejected = expect(child).rejects.toMatchObject({ detail: { stateChanged: false } })
    later.resolve()
    await rejected
    expect(native.calls).toHaveLength(0)
  })
})

describe('exact readonly quota observations (mocked subprocesses)', () => {
  beforeEach(() => { native.calls.length = 0; native.onSpawn = undefined })
  const readonly = (executor: LinuxHostExecutor, argv: string[]) =>
    withHostEffectAuthority(executor, { signal: new AbortController().signal, readOnly: true, async assertAuthority() {} },
      () => executor.runCommand(argv))
  it.each([
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', '/home/alice'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'SOURCE', '--target', '/home'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'FSTYPE', '--target', '/'],
    ['/usr/sbin/quotaon', '--print-state', '--verbose', '--user', '/home'],
  ])('admits only the exact measurement argv %#', async (...argv) => {
    await readonly(new LinuxHostExecutor(), argv)
    expect(native.calls).toEqual([argv])
  })
  it.each([
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET,SOURCE', '--target', '/home'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', '/home', '--poll'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', '/home/../tmp'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', '/home/'],
    ['/usr/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', 'home'],
    ['/bin/findmnt', '--noheadings', '--raw', '--output', 'TARGET', '--target', '/home'],
    ['/usr/sbin/quotaon', '--user', '/home'],
    ['/usr/sbin/quotaon', '-pvu', '/home'],
    ['/usr/sbin/quotaon', '--print-state', '--verbose', '--user', '/home', '/tmp'],
    ['/usr/sbin/quotaon', '--print-state', '--verbose', '--off', '/home'],
    ['/usr/sbin/quotaoff', '--print-state', '--verbose', '--user', '/home'],
    ['/bin/sh', '-c', 'quotaon --print-state --verbose --user /home'],
  ])('refuses broadened or mutating argv %# before spawning', async (...argv) => {
    await expect(readonly(new LinuxHostExecutor(), argv)).rejects.toThrow()
    expect(native.calls).toHaveLength(0)
  })
  it('rechecks revocation after an exact readonly quota command without claiming an effect', async () => {
    const executor = new LinuxHostExecutor(), abort = new AbortController()
    native.onSpawn = () => abort.abort()
    await expect(withHostEffectAuthority(executor, { signal: abort.signal, readOnly: true, async assertAuthority() {} },
      () => executor.runCommand(['/usr/sbin/quotaon', '--print-state', '--verbose', '--user', '/home'])))
      .rejects.toMatchObject({ detail: { stateChanged: false } })
    expect(native.calls).toHaveLength(1)
  })
})
