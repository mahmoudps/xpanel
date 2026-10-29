import { describe, expect, it, vi } from 'vitest'
import { readSwContainersView, readSwContainerEngineView, swContainerReadArgv } from '../../../packages/os/src/sw-container-command.ts'
import { buildSwContainerJobPlan, handleSwContainersRoute, parseEngineContainers, parseEngineImages, parseEngineInfo, parseEngineVersion } from './sw-containers.ts'
import type { SwContainerRouteContext } from './sw-containers.ts'
import type { HostJobPlan } from './host-job-contract.ts'

const id = 'a'.repeat(64), other = 'e'.repeat(64)
const podmanPs = (state = 'running') => JSON.stringify([{ Id: id, Names: ['web'], Image: 'docker.io/library/nginx:latest', State: state, Status: state === 'running' ? 'Up 2 hours' : 'Exited (0) 1 minute ago', Ports: [{ host_ip: '', container_port: 80, host_port: 8080, range: 1, protocol: 'tcp' }] }])
const dockerPs = [JSON.stringify({ ID: other, Names: 'db,alias', Image: 'mariadb:11', State: 'exited', Status: 'Exited (0) 3 minutes ago', Ports: '' }), JSON.stringify({ ID: id, Names: 'web', Image: 'nginx:latest', State: 'running', Status: 'Up 2 hours (healthy)', Ports: '0.0.0.0:8080->80/tcp, :::8080->80/tcp' })].join('\n') + '\n'
const outputs: Record<string, string> = {
  [swContainerReadArgv('podman', 'version').join(' ')]: JSON.stringify({ Client: { Version: '4.9.3', APIVersion: '4.9.3' } }),
  [swContainerReadArgv('podman', 'containers').join(' ')]: podmanPs(),
  [swContainerReadArgv('podman', 'info').join(' ')]: JSON.stringify({ host: { cgroupVersion: 'v2', ociRuntime: { name: 'crun' }, security: { rootless: false } }, store: { graphDriverName: 'overlay' }, registries: { search: ['docker.io'] } }),
  [swContainerReadArgv('podman', 'images').join(' ')]: JSON.stringify([{ Id: 'c'.repeat(64), RepoTags: ['docker.io/library/nginx:latest'], Size: 187000000 }]),
  [swContainerReadArgv('podman', 'networks').join(' ')]: JSON.stringify([{ name: 'podman', id: 'd'.repeat(64), driver: 'bridge' }]),
  [swContainerReadArgv('podman', 'volumes').join(' ')]: '[]',
}
const context = (overrides: Partial<SwContainerRouteContext> = {}) => {
  const submitted: HostJobPlan[] = [], audit = vi.fn(async () => {})
  const run = vi.fn(async (argv: readonly string[]) => { const out = outputs[argv.join(' ')]; return out === undefined ? { ok: false, code: 1, stdout: '', stderr: 'unknown' } : { ok: true, code: 0, stdout: out, stderr: '' } })
  const ctx: SwContainerRouteContext = { assertRoot: async () => ({ actor: 'root' }), run, binaryPresent: async path => path === '/usr/bin/podman', submitJob: async (plan, actor) => { submitted.push(plan); return { id: 'job-1', kind: plan.kind, actor } as never }, audit, now: () => new Date('2026-10-28T00:00:00.000Z'), ...overrides }
  return { ctx, run, submitted, audit }
}
const call = (ctx: SwContainerRouteContext, path: string, body?: unknown) => {
  const url = new URL('http://agent.local' + path)
  return handleSwContainersRoute(new Request(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx)
}

describe('container engine parsers', () => {
  it('normalizes podman arrays and docker JSON lines', () => {
    expect(parseEngineContainers('podman', podmanPs())).toEqual([{ id, name: 'web', image: 'docker.io/library/nginx:latest', state: 'running', status: 'Up 2 hours', ports: ['0.0.0.0:8080->80/tcp'] }])
    expect(parseEngineContainers('docker', dockerPs).map(row => [row.name, row.state, row.ports])).toEqual([['db', 'exited', []], ['web', 'running', ['0.0.0.0:8080->80/tcp', ':::8080->80/tcp']]])
    expect(parseEngineVersion('docker', JSON.stringify({ Client: { Version: '24.0.7' }, Server: { Version: '24.0.7' } }))).toBe('24.0.7')
    expect(() => parseEngineVersion('docker', JSON.stringify({ Client: { Version: '24.0.7' }, Server: null }))).toThrow()
    expect(parseEngineImages('docker', [JSON.stringify({ ID: 'sha256:' + 'c'.repeat(64), Repository: 'nginx', Tag: 'latest', Size: '187MB' }), JSON.stringify({ ID: 'sha256:' + 'c'.repeat(64), Repository: 'nginx', Tag: '1.27', Size: '187MB' }), JSON.stringify({ ID: 'sha256:' + 'f'.repeat(64), Repository: '<none>', Tag: '<none>', Size: '5MB' })].join('\n'))).toEqual([{ id: 'c'.repeat(64), tags: ['nginx:latest', 'nginx:1.27'], size: '187MB' }, { id: 'f'.repeat(64), tags: [], size: '5MB' }])
    expect(parseEngineInfo('docker', JSON.stringify({ DefaultRuntime: 'runc', Driver: 'overlay2', CgroupVersion: '2', SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'], RegistryConfig: { IndexConfigs: { 'docker.io': {} } } }))).toEqual({ runtime: 'runc', storageDriver: 'overlay2', cgroupVersion: '2', rootless: true, registries: ['docker.io'] })
  })
  it('refuses malformed, duplicate, oversized or injected engine output', () => {
    for (const bad of ['not json', JSON.stringify([{ Id: 'short', Names: ['web'], Image: 'x', State: 'running', Status: 'Up' }]), JSON.stringify([{ Id: id, Names: ['web'], Image: 'x', State: 'teleporting', Status: 'Up' }]), JSON.stringify([{ Id: id, Names: ['web'], Image: 'x', State: 'running', Status: 'Up' }, { Id: id, Names: ['web2'], Image: 'x', State: 'running', Status: 'Up' }]), JSON.stringify([{ Id: id, Names: ['a b'], Image: 'x', State: 'running', Status: 'Up' }]), 'x'.repeat(2 * 1024 * 1024 + 1)])
      expect(() => parseEngineContainers('podman', bad)).toThrow()
    expect(() => parseEngineContainers('docker', JSON.stringify({ ID: id, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up', Ports: '0.0.0.0:8080->80/tcp; rm -rf' }))).toThrow()
  })
})

describe('container routes', () => {
  it('reads present engines, marks absent ones and never claims unavailable output as read', async () => {
    const { ctx } = context()
    const view = readSwContainersView(await (await call(ctx, '/host/software/containers'))!.json())
    expect(view.state).toBe('read'); expect(view.actions.lifecycle).toBe(true)
    expect(view.engines.map(engine => [engine.engine, engine.state])).toEqual([['podman', 'read'], ['docker', 'absent']])
    const broken = context({ run: async () => ({ ok: true, code: 0, stdout: '{', stderr: '' }) })
    const failed = readSwContainersView(await (await call(broken.ctx, '/host/software/containers'))!.json())
    expect(failed.state).toBe('unavailable'); expect(failed.engines[0]!.reason).toBe('invalid-engine-output')
    expect(failed.engines[0]!.containers).toEqual([])
    const none = context({ binaryPresent: async () => false })
    expect(((await (await call(none.ctx, '/host/software/containers'))!.json()) as { reason: unknown }).reason).toBe('no-engine')
    const host = context({ run: null, binaryPresent: null })
    expect(((await (await call(host.ctx, '/host/software/containers'))!.json()) as { reason: unknown }).reason).toBe('unsupported-host')
    const engine = readSwContainerEngineView(await (await call(ctx, '/host/software/containers/engine'))!.json())
    expect(engine.engines[0]!.facts).toEqual({ runtime: 'crun', storageDriver: 'overlay', cgroupVersion: '2', rootless: false, registries: ['docker.io'] })
    expect(engine.engines[0]!.images[0]!.size).toBe('187.0 MB')
  })
  it('enforces root, strict bodies, the observed revision and an admitted state transition', async () => {
    const denied = context({ assertRoot: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }) } })
    await expect(call(denied.ctx, '/host/software/containers')).rejects.toThrow('forbidden')
    const { ctx, submitted, audit } = context()
    const revision = readSwContainersView(await (await call(ctx, '/host/software/containers'))!.json()).engines[0]!.revision!
    await expect(call(ctx, '/host/software/containers/action', { engine: 'podman', containerId: id, action: 'stop', expectedRevision: revision, extra: 1 })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/software/containers/action', { engine: 'podman', containerId: id, action: 'stop', expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(call(ctx, '/host/software/containers/action', { engine: 'podman', containerId: id, action: 'start', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(ctx, '/host/software/containers/action', { engine: 'podman', containerId: other, action: 'stop', expectedRevision: revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const response = await call(ctx, '/host/software/containers/action', { engine: 'podman', containerId: id, action: 'stop', expectedRevision: revision })
    expect(response!.status).toBe(202); expect(submitted[0]!.kind).toBe('software.container.stop'); expect(audit).toHaveBeenCalledOnce()
    const unavailable = context({ submitJob: null })
    await expect(call(unavailable.ctx, '/host/software/containers/action', { engine: 'podman', containerId: id, action: 'stop', expectedRevision: revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('builds a plan whose policy, revalidation and verification bind to the observed container', async () => {
    const row = parseEngineContainers('podman', podmanPs())[0]!
    let state = 'running'
    const run = async () => ({ ok: true, code: 0, stdout: podmanPs(state), stderr: '', timedOut: false })
    const assertActor = vi.fn(async () => {})
    const plan = buildSwContainerJobPlan({ engine: 'podman', action: 'stop', container: row, expectedRevision: 'b'.repeat(64), revalidate: { run, assertActor } })
    expect(plan.policy(plan.steps[0]!.argv)).toBe(true); expect(plan.policy(['/usr/bin/podman', 'rm', '--', id])).toBe(false)
    await plan.beforeStep!(plan.steps[0]!); expect(assertActor).toHaveBeenCalledTimes(2)
    expect((await plan.verify!(run)).ok).toBe(false)
    state = 'exited'; expect((await plan.verify!(run)).ok).toBe(true)
    const renamed = async () => ({ ok: true, code: 0, stdout: podmanPs().replace('"web"', '"other"'), stderr: '', timedOut: false })
    const stale = buildSwContainerJobPlan({ engine: 'podman', action: 'stop', container: row, expectedRevision: 'b'.repeat(64), revalidate: { run: renamed, assertActor } })
    await expect(stale.beforeStep!(stale.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
