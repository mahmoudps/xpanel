import { describe, expect, it } from 'vitest'
import { readCtrOpRequest, readCtrView } from './ctr-view.ts'
import { isSwContainerCommand, swContainerInspectArgv, swContainerLogsArgv, swContainerReadArgv } from './sw-container-command.ts'

const id = 'a'.repeat(64), revision = 'b'.repeat(64)
const request = (action: unknown, over: Record<string, unknown> = {}) => ({ account: 'alice', expectedRevision: revision, action, ...over })

describe('container operation grammar', { tags: ['unit'] }, () => {
  it('admits each reviewed shape', () => {
    for (const action of [{ op: 'image.pull', image: 'docker.io/library/nginx:1.27' }, { op: 'image.remove', id }, { op: 'image.prune' }, { op: 'image.push', id, destination: 'ghcr.io/acme/app:1' }, { op: 'image.export', id, path: 'a/b.tar' }, { op: 'image.import', path: 'a/b.tar' }, { op: 'image.build', tag: 'localhost/app:1', context: 'app', containerfile: null }, { op: 'network.create', name: 'net', subnet: '10.0.0.0/24', gateway: null, range: null, ipv6Subnet: null, labels: [] }, { op: 'volume.create', name: 'data', options: [], labels: [] }, { op: 'engine.repair' },
      { op: 'registry.login', host: 'ghcr.io', username: 'bob', password: 'x' }, { op: 'stack.save', name: 'shop', yaml: 'services: {}\n', env: null, notes: '', template: null }, { op: 'stack.update', name: 'shop' }, { op: 'stack.restart-policy', name: 'shop', service: 'web', restart: 'always' }, { op: 'stack.network', name: 'shop', network: 'net', connected: true },
      { op: 'app.install', app: 'adminer', name: 'db', version: '4', bind: '127.0.0.1', port: 8080, memoryMb: null, cpuPercent: 50 }, { op: 'container.commit', id, tag: 'localhost/app:1' }])
      expect(readCtrOpRequest(request(action)).action).toEqual(action)
  })
  it.each([
    [request({ op: 'image.pull', image: 'x', extra: 1 })], [request({ op: 'shell', command: 'id' })], [request({ op: 'image.prune' }, { account: 'Root' })], [request({ op: 'image.prune' }, { expectedRevision: 'x' })],
    [request({ op: 'app.install', app: 'adminer', name: 'db', version: '4;rm', bind: '127.0.0.1', port: 8080, memoryMb: null, cpuPercent: null })], [request({ op: 'app.install', app: 'adminer', name: 'db', version: '4', bind: '1.2.3.4', port: 8080, memoryMb: null, cpuPercent: null })],
    [request({ op: 'app.install', app: 'adminer', name: 'db', version: '4', bind: '127.0.0.1', port: 80, memoryMb: null, cpuPercent: null })], [request({ op: 'stack.save', name: 'shop', yaml: '', env: null, notes: 'a\u0007b', template: null })], [request({ op: 'stack.restart-policy', name: 'shop', service: 'web', restart: 'sometimes' })],
    [{ account: 'alice', expectedRevision: revision }], [null],
  ])('refuses %j', value => { expect(() => readCtrOpRequest(value)).toThrow('invalid_container_operation') })
})

describe('container views', { tags: ['unit'] }, () => {
  const scope = { scope: 'account', account: 'alice', state: 'read', reason: null, observedAt: '2026-11-07T00:00:00.000Z', revision, version: '4.9.3', stats: [], images: [], networks: [], volumes: [], stacks: [], logins: [], actions: { write: true, jobs: true } }
  it('admits a read view and refuses an extra key or a forged row', () => {
    expect(readCtrView('scope', scope)).toEqual(scope)
    expect(() => readCtrView('scope', { ...scope, secret: 1 })).toThrow('invalid_container_view')
    expect(() => readCtrView('scope', { ...scope, images: [{ id: 'x', tags: [], size: null }] })).toThrow('invalid_container_view')
    expect(() => readCtrView('policy', { revision })).toThrow('invalid_container_view')
    expect(() => readCtrView('nope' as never, scope)).toThrow('invalid_container_view')
  })
  it('gives no stack env value a place in the view', () => {
    const stack = { name: 'shop', app: null, enabled: true, yaml: 'services: {}', envKeys: ['DB'], notes: '', folder: '/home/alice/containers/shop', networks: [], updatedAt: '2026-11-07T00:00:00.000Z', services: [] }
    expect(readCtrView('scope', { ...scope, stacks: [stack] }).stacks).toHaveLength(1)
    expect(() => readCtrView('scope', { ...scope, stacks: [{ ...stack, env: 'DB=x' }] })).toThrow('invalid_container_view')
  })
})

describe('host engine reads', { tags: ['unit'] }, () => {
  it('admits stats, inspect and logs of one observed id in both engines', () => {
    for (const engine of ['podman', 'docker'] as const) for (const argv of [swContainerReadArgv(engine, 'stats'), swContainerInspectArgv(engine, id), swContainerLogsArgv(engine, id)]) expect(isSwContainerCommand(argv)).toBe(true)
    expect(isSwContainerCommand(['/usr/bin/docker', 'logs', '--tail', '200', '--timestamps', 'web'])).toBe(false)
    expect(isSwContainerCommand(['/usr/bin/docker', 'inspect', id])).toBe(false)
    expect(() => swContainerInspectArgv('podman', '../x')).toThrow()
  })
})
