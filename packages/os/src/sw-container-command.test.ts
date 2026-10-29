import { describe, expect, it } from 'vitest'
import { isSwContainerCommand, readSwContainerEngineView, readSwContainersView, swContainerActionArgv, swContainerReadArgv } from './sw-container-command.ts'

const id = 'a'.repeat(64)
describe('container engine grammar', () => {
  it('admits only the fixed read formats and one-id lifecycle commands', () => {
    expect(swContainerReadArgv('podman', 'containers')).toEqual(['/usr/bin/podman', 'ps', '--all', '--format', 'json'])
    expect(swContainerReadArgv('docker', 'containers')).toEqual(['/usr/bin/docker', 'ps', '--all', '--no-trunc', '--format', '{{json .}}'])
    expect(swContainerActionArgv('docker', 'stop', id)).toEqual(['/usr/bin/docker', 'stop', '--time', '30', '--', id])
    for (const engine of ['podman', 'docker'] as const) {
      for (const read of ['version', 'containers', 'images', 'networks', 'volumes', 'info'] as const) expect(isSwContainerCommand(swContainerReadArgv(engine, read))).toBe(true)
      for (const action of ['start', 'stop', 'restart'] as const) expect(isSwContainerCommand(swContainerActionArgv(engine, action, id))).toBe(true)
    }
    for (const argv of [['/usr/bin/podman', 'run', 'alpine'], ['/usr/bin/docker', 'rm', '--', id], ['/usr/bin/podman', 'stop', '--', id], ['/usr/bin/docker', 'start', '--', 'web'], ['/usr/bin/docker', 'start', '--', id.slice(1)], ['/usr/local/bin/docker', 'start', '--', id], ['/usr/bin/docker', 'exec', id, 'sh']])
      expect(isSwContainerCommand(argv)).toBe(false)
    expect(() => swContainerActionArgv('podman', 'start', 'web')).toThrow()
    expect(() => swContainerActionArgv('podman', 'kill' as never, id)).toThrow()
  })
  const list = () => ({ scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T00:00:00.000Z', rootlessAccounts: 'not-read', actions: { lifecycle: true },
    engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', revision: 'b'.repeat(64), containers: [{ id, name: 'web', image: 'docker.io/library/nginx:latest', state: 'running', status: 'Up 2 hours', ports: ['0.0.0.0:8080->80/tcp'] }] }, { engine: 'docker', state: 'absent', reason: 'engine-absent', version: null, revision: null, containers: [] }] })
  it('reads the public list view strictly', () => {
    expect(readSwContainersView(list()).engines[0]!.containers[0]!.name).toBe('web')
    const extra = list() as Record<string, unknown>; extra.command = 'x'; expect(() => readSwContainersView(extra)).toThrow()
    const dup = list(); (dup.engines[0]!.containers as unknown[]).push({ ...dup.engines[0]!.containers[0]! }); expect(() => readSwContainersView(dup)).toThrow()
    const fake = list(); fake.engines[0]!.state = 'unavailable'; expect(() => readSwContainersView(fake)).toThrow()
    const injected = list(); injected.engines[0]!.containers[0]!.name = '<img src=x>'; expect(() => readSwContainersView(injected)).toThrow()
    const lifecycle = list(); lifecycle.state = 'unavailable'; (lifecycle as Record<string, unknown>).reason = 'no-engine'; expect(() => readSwContainersView(lifecycle)).toThrow()
  })
  it('keeps engine writes false and rejects partial engine views', () => {
    const view = { scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T00:00:00.000Z', actions: { pull: false, registryWrite: false, daemonWrite: false, networkWrite: false, volumeWrite: false },
      engines: [{ engine: 'docker', state: 'read', reason: null, version: '24.0.7', facts: { runtime: 'runc', storageDriver: 'overlay2', cgroupVersion: '2', rootless: false, registries: ['index.docker.io'] }, images: [{ id: 'c'.repeat(64), tags: ['nginx:latest'], size: '187MB' }], networks: [{ id: 'd'.repeat(64), name: 'bridge', driver: 'bridge' }], volumes: [{ name: 'data', driver: 'local' }] }] }
    expect(readSwContainerEngineView(view).engines[0]!.images[0]!.tags).toEqual(['nginx:latest'])
    const write = structuredClone(view); (write.actions as Record<string, boolean>).pull = true; expect(() => readSwContainerEngineView(write)).toThrow()
    const nofacts = structuredClone(view); (nofacts.engines[0] as Record<string, unknown>).facts = null; expect(() => readSwContainerEngineView(nofacts)).toThrow()
  })
})
