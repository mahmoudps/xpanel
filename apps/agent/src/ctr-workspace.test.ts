import { generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { compileAccountRuntime, readRuntimeRegistry, runtimeRegistryPath } from './account-runtime.ts'
import type { RuntimeHost } from './account-runtime.ts'
import { CTR_APPS } from './ctr-apps.ts'
import { createCtrCatalog, ctrCatalogSigningBytes, fetchCtrCatalog, verifyCtrCatalog } from './ctr-catalog.ts'
import { createLogFollower } from './ctr-logs.ts'
import { containerLoopbackPorts, parseComposeServices, stackUnitSpecs } from './ctr-compose.ts'
import { CTR_READS, ctrJournalArgv, ctrPodmanArgv, ctrTail, isCtrCommand } from './ctr-command.ts'
import { buildTerminalSystemdArgv, handleTerminalRoute } from './terminal-sessions.ts'
import { CTR_DEFAULT_POLICY, isTrustedImage, renderRegistriesConf } from './ctr-policy.ts'
import { handleCtrRoute, listeningPorts, parseEngineInspect, parseEngineSearch, parseEngineStats, resolveContainerTerminal, subnetsOverlap } from './ctr-workspace.ts'
import type { CtrRouteContext } from './ctr-workspace.ts'
import type { HostJobPlan } from './host-job-contract.ts'
import { profileFor } from '@xpanel/os'
import { system } from '@xpanel/render'
import { createProductionHostTargetMatcher } from './executor.ts'
import { atomicWriteJson } from '@xpanel/state'

const debianOs = profileFor(['ID=ubuntu', 'VERSION_ID="24.04"', ''].join(String.fromCharCode(10)))
const id = 'a'.repeat(64), imageId = 'c'.repeat(64), revisionOf = async (ctx: CtrRouteContext): Promise<string> => (await (await call(ctx, 'scope?account=alice')).json() as { revision: string }).revision
const accountId = '11111111-1111-4111-8111-111111111111'
const account = { id: accountId, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', status: 'active', planId: 'p', resellerId: null } as unknown as Account
const plan = { id: 'p', featureListId: 'f', resources: { memoryMb: 2048, cpuPercent: 200, maxProcesses: 256, diskMb: 'unlimited' } } as unknown as Plan
const yaml = `services:
  db:
    image: mariadb:11
    environment:
      MARIADB_PASSWORD: \${DB}
    volumes:
      - data:/var/lib/mysql
  web:
    image: docker.io/library/nginx:1.27
    depends_on: [db]
    restart: always
    ports:
      - "8080:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
volumes:
  data:
`
const psJson = (state = 'running') => JSON.stringify([{ Id: id, Names: ['shop-web'], Image: 'docker.io/library/nginx:1.27', ImageID: imageId, State: state, Status: 'Up', Ports: [] }])
function harness(over: Partial<CtrRouteContext> = {}, outputs: Record<string, string> = {}, root = '/nonexistent') {
  const jobs: HostJobPlan[] = [], audits: unknown[] = [], restarts: string[] = []
  const stdout = (argv: readonly string[]): string => {
    const tail = argv.join(' ')
    for (const [key, value] of Object.entries(outputs)) if (tail.endsWith(key)) return value
    for (const [name, list] of Object.entries(CTR_READS)) if (tail.endsWith(list.join(' '))) return name === 'info' ? '{}' : name === 'containers' ? psJson() : name === 'images' ? JSON.stringify([{ Id: imageId, RepoTags: ['docker.io/library/nginx:1.27'], Size: 1000 }]) : name === 'networks' ? JSON.stringify([{ name: 'podman', driver: 'bridge', subnets: [{ subnet: '10.88.0.0/16' }] }]) : name === 'volumes' ? JSON.stringify([{ Name: 'shop_data', Driver: 'local' }, { Name: 'junk', Driver: 'local' }]) : name === 'dangling' ? JSON.stringify([{ Name: 'shop_data', Driver: 'local' }, { Name: 'junk', Driver: 'local' }]) : '[]'
    return ''
  }
  const host: RuntimeHost = { exists: async path => ['/usr/bin/podman', '/usr/bin/newuidmap'].includes(path), run: async argv => ({ ok: true, code: 0, stdout: argv[1] === '--version' ? 'podman version 4.9.3' : stdout(argv), stderr: '', timedOut: false }) as never, systemd: async (_verb, unit) => { restarts.push(unit) }, probe: async () => null,
    readText: async path => path.endsWith('subuid') || path.endsWith('subgid') ? 'alice:100000:65536\n' : path === '/proc/net/tcp' ? '  sl  local_address rem_address   st\n   0: 0100007F:2382 00000000:0000 0A\n' : '' }
  const ctx: CtrRouteContext = { assertRoot: async () => ({ actor: 'root' }), run: null, binaryPresent: null, submitJob: async (job, actor) => { jobs.push(job); return { id: 'job-1', kind: job.kind, actor } as never }, audit: async entry => { audits.push(entry) }, now: () => new Date('2026-11-07T00:00:00.000Z'), host, reconcile: async () => ({ status: 'applied' }), catalog: createCtrCatalog(memoryCatalogFiles()), follow: null,
    store: { rootDir: root, listAccounts: async () => [account], getAccountByUsername: async name => name === 'alice' ? account : null, getPlan: async () => plan, getFeatureList: async () => ({ id: 'f', disabled: [] }) as unknown as FeatureList, withAccountLifecycleLease: async (_id, operation) => operation(account) }, ...over }
  return { ctx, jobs, audits, restarts }
}
function call(ctx: CtrRouteContext, path: string, body?: unknown): Promise<Response> {
  const url = new URL('http://agent/host/software/containers/' + path), init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  return handleCtrRoute(new Request(url, init), url, body === undefined ? 'GET' : 'POST', ctx) as Promise<Response>
}
const op = async (ctx: CtrRouteContext, action: unknown): Promise<Response> => call(ctx, 'op', { account: 'alice', expectedRevision: await revisionOf(ctx), action })
function memoryCatalogFiles(keys: { keyId: string; publicKeyPem: string }[] = []) {
  let envelope: string | null = null, floor: string | null = null
  return { readTrust: async () => ({ state: keys.length ? 'configured' as const : 'missing' as const, keys, reason: null }), readEnvelope: async () => envelope, writeEnvelope: async (text: string) => { envelope = text }, readFloor: async () => floor, writeFloor: async (text: string) => { floor = text } }
}
const roots: string[] = []
const tempRoot = async (): Promise<string> => { const root = await mkdtemp(join(tmpdir(), 'ctr-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('rootless container grammar', { tags: ['unit'] }, () => {
  it('runs as the account in its slice and admits only reviewed commands', () => {
    const pull = ctrPodmanArgv(account, ctrTail.pull('docker.io/library/nginx:1.27'))
    expect(pull).toEqual(expect.arrayContaining(['User=20014', 'Slice=xpanel-20014.slice', 'BindPaths=/home/alice', '--setenv=XDG_RUNTIME_DIR=/run/xpanel-ctr/alice']))
    expect(isCtrCommand(pull)).toBe(true)
    expect(isCtrCommand(pull.map(value => value === 'BindPaths=/home/alice' ? 'BindPaths=/home' : value))).toBe(false)
    expect(isCtrCommand(pull.map(value => value === 'pull' ? 'push' : value))).toBe(false)
    expect(isCtrCommand([...pull.slice(0, -1), 'docker.io/library/nginx:1.27', '--privileged'])).toBe(false)
    expect(isCtrCommand(ctrPodmanArgv(account, ctrTail.networkCreate({ name: 'net', subnet: '10.9.0.0/24', gateway: '10.9.0.1', range: null, ipv6Subnet: 'fd00::/64', labels: ['a=b'] })))).toBe(true)
    expect(() => ctrPodmanArgv(account, ['run', 'docker.io/library/nginx:1.27'])).toThrow()
    expect(() => ctrPodmanArgv({ ...account, home: '/home/bob' }, ctrTail.migrate())).toThrow()
    expect(isCtrCommand(['/usr/bin/systemctl', 'restart', '--', 'xpanel-ctr-alice-shop-web.service'])).toBe(true)
    expect(isCtrCommand(['/usr/bin/systemctl', 'restart', '--', 'sshd.service'])).toBe(false)
  })
  it('passes a login password through a root-only file, never argv', () => {
    const argv = ctrPodmanArgv(account, ctrTail.login('ghcr.io', 'bob', '/home/alice'), '/var/lib/xpanel/extended/containers/login-alice')
    expect(argv).toContain('StandardInput=file:/var/lib/xpanel/extended/containers/login-alice')
    expect(argv).not.toContain('--pipe')
    expect(isCtrCommand(argv)).toBe(true)
    expect(isCtrCommand(argv.map(value => value.startsWith('StandardInput=') ? 'StandardInput=file:/etc/shadow' : value))).toBe(false)
  })
})

describe('compose subset', { tags: ['unit'] }, () => {
  it('orders dependencies first and shares one network namespace', () => {
    const services = parseComposeServices('shop', yaml, 'DB=secret\n')
    expect(services.map(service => service.name)).toEqual(['db', 'web'])
    expect(services[0]!.env).toEqual({ MARIADB_PASSWORD: 'secret' })
    expect(services[1]!.ports).toEqual([{ bind: '127.0.0.1', host: 8080, container: 80, protocol: 'tcp' }])
    const [db, web] = stackUnitSpecs({ name: 'shop', yaml, env: 'DB=secret\n', notes: '', app: null, enabled: true, updatedAt: '2026-11-07T00:00:00.000Z', restart: {}, networks: [], limits: { memoryMb: null, cpuPercent: null } }, '/home/alice')
    expect(db).toMatchObject({ name: 'shop-db', hosts: ['db', 'web'], publish: [{ host: 8080 }] })
    expect(web).toMatchObject({ name: 'shop-web', shareNetworkOf: 'shop-db', restart: 'always', dataDirs: ['/home/alice/containers/shop/html'] })
  })
  it.each([
    ['not: [valid', 'yaml'], ['services: {}', 'services'], ['services:\n  a:\n    image: nginx:1\n    privileged: true', 'privileged'], ['services:\n  a:\n    image: nginx', 'image'],
    ['services:\n  a:\n    image: nginx:1\n    volumes: ["/etc:/x"]', 'volumes'], ['services:\n  a:\n    image: nginx:1\n    volumes: ["./../x:/x"]', 'volumes'], ['services:\n  a:\n    image: nginx:1\n    ports: ["80:80"]', 'ports'],
    ['services:\n  a:\n    image: nginx:1\n    ports: ["1.2.3.4:8080:80"]', 'ports'], ['services:\n  a:\n    image: nginx:1\n    depends_on: [a]', 'depends_on'], ['networks: {}\nservices:\n  a:\n    image: nginx:1', 'networks'], ['services:\n  a:\n    image: ${MISSING}:1', 'env'],
  ])('refuses %s before anything is created', (text, field) => {
    expect(() => parseComposeServices('shop', text, '')).toThrowError(expect.objectContaining({ code: 'VALIDATION', detail: expect.objectContaining({ field }) }))
  })
  it('keeps the app catalog valid and on trusted registries', () => {
    for (const app of CTR_APPS) for (const service of parseComposeServices(app.id, app.yaml, ['VERSION=1', 'BIND=127.0.0.1', 'HOST_PORT=8081', ...app.secrets.map(key => key + '=x')].join('\n'))) expect(isTrustedImage(CTR_DEFAULT_POLICY, service.image)).toBe(true)
  })
  it('compiles a stack into rootless units with limits and a firewall loopback guard', () => {
    const stack = { name: 'shop', yaml, env: 'DB=secret\n', notes: '', app: null, enabled: true, updatedAt: '2026-11-07T00:00:00.000Z', restart: {}, networks: [], limits: { memoryMb: 512, cpuPercent: null } }
    const out = compileAccountRuntime({ ...account, ipv4: '192.0.2.1' } as unknown as Account, plan, [], { apps: [], cache: { redis: null, memcached: null }, containers: [], stacks: [stack] }, debianOs)
    expect(out.units).toEqual(['xpanel-ctr-alice-shop-db.service', 'xpanel-ctr-alice-shop-web.service'])
    const db = out.files.find(file => file.path.endsWith('shop-db.service'))!.content, web = out.files.find(file => file.path.endsWith('shop-web.service'))!.content
    expect(db).toContain('--memory=512m'); expect(db).toContain('--publish=127.0.0.1:8080:80/tcp'); expect(db).toContain('--add-host=web:127.0.0.1')
    expect(web).toContain('--network=container:shop-db'); expect(web).toContain('BindsTo=xpanel-ctr-alice-shop-db.service'); expect(web).toContain('Restart=always')
    expect(web).not.toContain('--publish'); expect(web).not.toContain('--privileged')
    expect(containerLoopbackPorts([account], new Map([[accountId, { stacks: [stack] }]]))).toEqual([{ port: 8080, protocol: 'tcp', uid: 20014 }])
    expect(containerLoopbackPorts([{ ...account, status: 'suspended' } as Account], new Map([[accountId, { stacks: [stack] }]]))).toEqual([])
  })
})

describe('host files', { tags: ['unit'] }, () => {
  it('lets the agent manage only its registries drop-in under /etc/containers', () => {
    const allowed = createProductionHostTargetMatcher()
    expect(allowed('/etc/containers/registries.conf.d/90-xpanel.conf', 'write')).toBe(true)
    expect(allowed('/etc/containers/registries.conf.d', 'ensure-directory')).toBe(true)
    expect(allowed('/etc/containers/registries.conf', 'write')).toBe(false)
  })
  it('guards a published loopback port from its own table, with no firewall rule at all', () => {
    expect(system.renderContainerGuard([], debianOs)).toBeNull()
    const guard = system.renderContainerGuard([{ port: 8080, protocol: 'tcp', uid: 20014 }, { port: 5353, protocol: 'udp', uid: 20015 }], debianOs)!
    expect(guard.rules.content).toContain('table inet xpanel_ctr_guard {')
    expect(guard.rules.content).toContain('ip daddr 127.0.0.1 tcp dport 8080 meta skuid 1000-60000 meta skuid != 20014 reject with tcp reset comment "xpanel-container-loopback"')
    expect(guard.rules.content).toContain('udp dport 5353 meta skuid 1000-60000 meta skuid != 20015 reject comment')
    expect(guard.rules.content.indexOf('delete table')).toBeLessThan(guard.rules.content.indexOf('hook output'))
    expect(guard.unit.path).toBe('/etc/systemd/system/xpanel-container-guard.service')
    expect(guard.unit.content).toContain('ExecStop=/usr/sbin/nft delete table inet xpanel_ctr_guard')
    expect(guard.actions[0]).toEqual({ kind: 'exec', argv: ['/usr/sbin/nft', '-f', '/etc/xpanel/container-guard.nft'] })
    expect(createProductionHostTargetMatcher()('/etc/xpanel/container-guard.nft', 'write')).toBe(true)
    const ports = { panelPort: 2087, sshPort: 22, backendPort: 8081, backendTlsPort: 8444 }
    expect(system.renderNftables(defaultFirewallRules(ports), system.nftSettingsFromServer(ports, { banTimeoutSec: 600 }), debianOs).content).not.toContain('xpanel-container-loopback')
  })
})

describe('engine output', { tags: ['unit'] }, () => {
  const rows = [{ id, name: 'web', image: 'nginx:1', state: 'exited', status: 'Exited', ports: [] }, { id: 'b'.repeat(64), name: 'db', image: 'x:1', state: 'running', status: 'Up', ports: [] }]
  it('reports zero use for a stopped container', () => {
    const stats = parseEngineStats('podman', JSON.stringify([{ name: 'web', cpu_percent: '9.00%', mem_usage: '5MB / 1GB', net_io: '1kB / 2kB' }, { name: 'db', cpu_percent: '1.50%', mem_usage: '50MB / 1GB', net_io: '3kB / 4kB' }]), rows)
    expect(stats.map(row => [row.name, row.cpu, row.memory])).toEqual([['web', '0.00%', '0B'], ['db', '1.50%', '50MB / 1GB']])
  })
  it('never reads the environment of an inspected container', () => {
    const view = parseEngineInspect(JSON.stringify([{ Id: id, Name: '/web', Config: { Image: 'nginx:1', Env: ['SECRET=x'] }, State: { Status: 'running', ExitCode: 0 }, NetworkSettings: { IPAddress: '10.0.0.2', Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } }, Mounts: [{ Type: 'volume', Name: 'data', Destination: '/data', RW: false }], HostConfig: { RestartPolicy: { Name: 'always' } } }]))
    expect(view).toMatchObject({ name: 'web', image: 'nginx:1', ips: ['10.0.0.2'], ports: ['127.0.0.1:8080->80/tcp'], restart: 'always', mounts: [{ type: 'volume', source: 'data', target: '/data', readOnly: true }] })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })
  it('detects overlapping subnets in both families and listening ports', () => {
    expect(subnetsOverlap('10.0.0.0/16', '10.0.5.0/24')).toBe(true); expect(subnetsOverlap('10.1.0.0/16', '10.2.0.0/16')).toBe(false)
    expect(subnetsOverlap('fd00::/64', 'fd00::/48')).toBe(true); expect(subnetsOverlap('fd00:1::/64', 'fd00:2::/64')).toBe(false); expect(subnetsOverlap('10.0.0.0/8', 'fd00::/8')).toBe(false)
    expect([...listeningPorts('h\n 0: 00000000:1F90 00000000:0000 0A\n 1: 00000000:0050 01020304:0050 01\n', '0A')]).toEqual([8080])
  })
  it('renders mirrors only when one is set', () => {
    expect(renderRegistriesConf(CTR_DEFAULT_POLICY)).toBeNull()
    const file = renderRegistriesConf({ templates: [], feedUrl: null, registries: [{ host: 'docker.io', namespace: null, mirror: 'mirror.example.com' }] })!
    expect(file.content).toContain('prefix = "docker.io"'); expect(file.content).toContain('location = "mirror.example.com"')
  })
  it('honours a namespace in the trust policy', () => {
    const policy = { templates: [], feedUrl: null, registries: [{ host: 'ghcr.io', namespace: 'acme', mirror: null }] }
    expect(isTrustedImage(policy, 'ghcr.io/acme/app:1')).toBe(true); expect(isTrustedImage(policy, 'ghcr.io/other/app:1')).toBe(false); expect(isTrustedImage(policy, 'docker.io/library/nginx:1')).toBe(false)
  })
})

describe('signed app catalog', { tags: ['unit'] }, () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), keys = [{ keyId: 'release', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
  const app = { id: 'kuma', name: 'Kuma', description: 'Monitor', version: '2', port: 3001, secrets: [], yaml: 'services:\n  app:\n    image: docker.io/louislam/uptime-kuma:${VERSION}\n' }
  const envelope = (sequence: number, days = 30, signer = privateKey) => {
    const payload = JSON.stringify({ schemaVersion: 1, sequence, issuedAt: '2026-11-07T00:00:00.000Z', expiresAt: new Date(Date.parse('2026-11-07T00:00:00.000Z') + days * 86400_000).toISOString(), apps: [app] })
    return JSON.stringify({ keyId: 'release', payload, signature: sign(null, ctrCatalogSigningBytes(payload), signer).toString('hex') })
  }
  const now = () => new Date('2026-11-08T00:00:00.000Z')
  it('overlays the shipped apps only with a signed, current feed and refuses a rollback', async () => {
    const catalog = createCtrCatalog(memoryCatalogFiles(keys), now)
    expect((await catalog.read()).source).toBe('bundled')
    const read = await catalog.import(envelope(5))
    expect(read).toMatchObject({ source: 'signed', sequence: 5 }); expect(read.apps.map(item => item.id)).toEqual(['kuma', ...CTR_APPS.map(item => item.id)])
    await expect(catalog.import(envelope(4))).rejects.toMatchObject({ detail: { reason: 'catalog_stale' } })
    await expect(catalog.import(envelope(6, 0))).rejects.toMatchObject({ detail: { reason: 'catalog_stale' } })
    await expect(catalog.import(envelope(6, 30, generateKeyPairSync('ed25519').privateKey))).rejects.toMatchObject({ detail: { reason: 'catalog_invalid' } })
    await expect(catalog.import('not json')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await catalog.read()).sequence).toBe(5)
  })
  it('falls back to the shipped apps when the stored feed lapses, and needs a release key', async () => {
    const files = memoryCatalogFiles(keys)
    await createCtrCatalog(files, now).import(envelope(5, 2))
    expect(await createCtrCatalog(files, () => new Date('2026-12-01T00:00:00.000Z')).read()).toMatchObject({ source: 'bundled', reason: 'catalog_stale' })
    await expect(createCtrCatalog(memoryCatalogFiles(), now).import(envelope(5))).rejects.toMatchObject({ detail: { reason: 'release_keys_unavailable' } })
    expect(() => verifyCtrCatalog(envelope(5).replace('release', 'other'), keys, now(), 0)).toThrow()
  })
  it('fetches only https on a public name and refuses redirects', async () => {
    const get = vi.fn(async () => new Response('body')) as unknown as typeof fetch
    await expect(fetchCtrCatalog('https://updates.example.com/apps.json', get)).resolves.toBe('body')
    expect((get as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ redirect: 'error' })
    for (const url of ['http://updates.example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://user:pw@updates.example.com/a', 'nope']) await expect(fetchCtrCatalog(url, get)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('live logs', { tags: ['unit'] }, () => {
  const child = () => { const stdout = new EventEmitter() as EventEmitter & { pause(): void; resume(): void }; stdout.pause = vi.fn(); stdout.resume = vi.fn(); const process = new EventEmitter() as EventEmitter & { stdout: typeof stdout; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }; process.stdout = stdout; process.stderr = new EventEmitter(); process.kill = vi.fn(); return process }
  const argv = ctrJournalArgv(['xpanel-ctr-alice-shop-web.service'], true)
  it('streams complete lines, ends with the process and frees its slot', async () => {
    const process = child(), follow = createLogFollower(() => process as never), reader = follow(argv).getReader()
    process.stdout.emit('data', Buffer.from('one\ntw')); process.stdout.emit('data', Buffer.from('o\u0007\n')); process.emit('close')
    const text: string[] = []
    for (;;) { const next = await reader.read(); if (next.done) break; text.push(new TextDecoder().decode(next.value)) }
    expect(text.join('').trim().split('\n').map(line => JSON.parse(line))).toEqual([{ line: 'one' }, { line: 'two ' }, { end: 'exit' }])
    expect(process.kill).toHaveBeenCalled()
  })
  it('kills the process when the viewer leaves and caps viewers', async () => {
    const started: ReturnType<typeof child>[] = [], follow = createLogFollower(() => { const process = child(); started.push(process); return process as never })
    const streams = [1, 2, 3, 4].map(() => follow(argv))
    expect(() => follow(argv)).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }))
    await streams[0]!.cancel()
    expect(started[0]!.kill).toHaveBeenCalled()
    expect(() => follow(argv)).not.toThrow()
  })
  it('admits only reviewed follow commands', () => {
    const follow = createLogFollower(() => child() as never)
    expect(isCtrCommand(argv)).toBe(true)
    expect(isCtrCommand(['/usr/bin/journalctl', '--unit=sshd.service', '--follow', '--lines=400', '--no-pager', '--output=short-iso', '--utc', '--quiet'])).toBe(false)
    expect(() => follow(['/usr/bin/journalctl', '--follow'])).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
    expect(ctrPodmanArgv(account, ctrTail.follow(id))).toContain('RuntimeMaxSec=630s')
  })
})

describe('container terminal', { tags: ['unit'] }, () => {
  it('execs in the container as the account, under the PTY helper, with session limits', () => {
    const launch = { id: '22222222-2222-4222-8222-222222222222', cols: 80, rows: 24, absoluteTimeoutMs: 3600_000, target: { kind: 'container' as const, account, containerId: id, shell: 'bash' as const, asRoot: true } }
    const argv = buildTerminalSystemdArgv(launch, '/opt/xpanel/bin/xpanel-terminal-pty')
    expect(argv).toEqual(expect.arrayContaining(['User=20014', 'Slice=xpanel-20014.slice', 'BindPaths=/home/alice', '--unit=xpanel-terminal-22222222-2222-4222-8222-222222222222', 'TasksMax=64', '--setenv=TERM=xterm-256color']))
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['/opt/xpanel/bin/xpanel-terminal-pty', '80', '24', '/usr/bin/podman', '--cgroup-manager=cgroupfs', 'exec', '--interactive', '--tty', '--user', '0', id, '/bin/bash'])
    expect(() => buildTerminalSystemdArgv({ ...launch, target: { ...launch.target, containerId: 'x' } })).toThrow()
  })
  it('opens only as root, for a container in that account store, and ties the session to the account', async () => {
    const open = vi.fn(() => ({ id: 's' })), terminals = { open, limits: {} } as never, assertRootCaller = vi.fn(async () => {}), resolved = { id: accountId, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice' }
    const body = { kind: 'container', account: 'alice', containerId: id, shell: 'sh', asRoot: false, cols: 80, rows: 24 }, call = (value: unknown, containerTerminal?: () => Promise<typeof resolved>) => { const url = new URL('http://agent/terminal/sessions'); return handleTerminalRoute(new Request(url, { method: 'POST', body: JSON.stringify(value) }), url, 'POST', { caller: { principalId: 'p', role: 'root' } as never, terminals, store: {} as never, assertRootCaller, ...(containerTerminal ? { containerTerminal } : {}) }) }
    await expect(call(body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call({ ...body, shell: 'zsh' }, async () => resolved)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(body, async () => resolved))!.status).toBe(201)
    expect(open).toHaveBeenCalledWith('p', expect.objectContaining({ kind: 'container', containerId: id, account: resolved }), 80, 24)
    expect(assertRootCaller).toHaveBeenCalled()
    const h = harness(), host = h.ctx.host!
    host.run = async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false }) as never
    await expect(resolveContainerTerminal(h.ctx, 'alice', id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('container routes', { tags: ['unit'] }, () => {
  it('searches only trusted registries and lists only trusted names', async () => {
    const h = harness({}, { 'search --limit 25 --format json docker.io/nginx': JSON.stringify([{ Name: 'docker.io/library/nginx', Description: 'Official  build', Stars: 20000, Official: '[OK]' }]) })
    const view = await (await call(h.ctx, 'search?account=alice&registry=docker.io&term=nginx')).json() as { results: unknown[] }
    expect(view.results).toEqual([{ name: 'docker.io/library/nginx', description: 'Official build', stars: 20000, official: true }])
    await expect(call(h.ctx, 'search?account=alice&registry=evil.example&term=nginx')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(h.ctx, 'search?account=alice&registry=docker.io&term=../x')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(parseEngineSearch(JSON.stringify([{ Name: 'quay.io/x/y' }]), () => false)).toEqual([])
  })
  it('pushes to a trusted destination, exports and imports inside the home, and builds without pulling', async () => {
    const root = await tempRoot(), h = harness({}, {}, root)
    await expect(op(h.ctx, { op: 'image.push', id: imageId, destination: 'evil.example/x/y:1' })).rejects.toMatchObject({ detail: { reason: 'untrusted_registry' } })
    expect((await op(h.ctx, { op: 'image.push', id: imageId, destination: 'ghcr.io/acme/app:1' })).status).toBe(202)
    await expect(op(h.ctx, { op: 'image.export', id: imageId, path: '../bob/x.tar' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.jobs.at(-1)!.steps[0]!.argv.at(-1)).toBe('ghcr.io/acme/app:1')
    await op(h.ctx, { op: 'image.export', id: imageId, path: 'containers/images/nginx.tar' })
    expect(h.jobs.at(-1)!.steps[0]!.argv.slice(-5)).toEqual(['image', 'save', '--output', '/home/alice/containers/images/nginx.tar', imageId])
    await op(h.ctx, { op: 'image.import', path: 'containers/images/nginx.tar' })
    expect(isCtrCommand(h.jobs.at(-1)!.steps[0]!.argv)).toBe(true)
    await expect(op(h.ctx, { op: 'image.build', tag: 'docker.io/x:1', context: 'app', containerfile: null })).rejects.toMatchObject({ code: 'VALIDATION' })
    await op(h.ctx, { op: 'image.build', tag: 'localhost/app:1', context: 'containers/app', containerfile: 'FROM docker.io/library/nginx:1.27\n' })
    const build = h.jobs.at(-1)!, argv = build.steps[0]!.argv, file = join(root, 'extended/containers/build-alice')
    expect(argv.slice(-7)).toEqual(['build', '--pull=never', '--tag', 'localhost/app:1', '--file', '-', '/home/alice/containers/app'])
    expect(argv).toContain('StandardInput=file:' + file); expect(isCtrCommand(argv)).toBe(true)
    await expect(readFile(file, 'utf8')).resolves.toContain('FROM')
    await build.finalize!(async () => ({ ok: true, code: 0, stdout: '', stderr: '', timedOut: false }), [])
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    await op(h.ctx, { op: 'image.build', tag: 'localhost/app:2', context: 'containers/app', containerfile: null })
    expect(h.jobs.at(-1)!.steps[0]!.argv.slice(-5)).toEqual(['build', '--pull=never', '--tag', 'localhost/app:2', '/home/alice/containers/app'])
    expect(() => ctrPodmanArgv(account, ['build', '--tag', 'localhost/app:1', '/home/alice/app'])).toThrow()
    expect(() => ctrPodmanArgv(account, ['image', 'load', '--input', '/home/bob/x.tar'])).toThrow()
  })
  it('streams a live log through the reviewed argv and keeps stack services on their journal', async () => {
    const root = await tempRoot(), seen: (readonly string[])[] = [], follow = (argv: readonly string[]) => { seen.push(argv); return new ReadableStream<Uint8Array>({ start: c => c.close() }) }
    const h = harness({ follow, run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }) }, {}, root)
    await op(h.ctx, { op: 'stack.save', name: 'shop', yaml, env: 'DB=secret\n', notes: '', template: null })
    const response = await call(h.ctx, 'log-stream?account=alice&stack=shop')
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')
    expect(seen[0]).toEqual(ctrJournalArgv(['xpanel-ctr-alice-shop-db.service', 'xpanel-ctr-alice-shop-web.service'], true))
    await call(h.ctx, 'log-stream?engine=podman&id=' + id)
    expect(seen[1]).toEqual(['/usr/bin/podman', 'logs', '--follow', '--tail', '200', '--timestamps', id])
    await expect(call(h.ctx, 'log-stream?engine=podman&id=x')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call({ ...h.ctx, follow: null }, 'log-stream?account=alice&stack=shop')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('keeps the engine off until it is installed', async () => {
    const off = harness()
    off.ctx.host!.exists = async () => false
    const view = await (await call(off.ctx, 'scope?account=alice')).json() as { state: string; reason: string; actions: { write: boolean } }
    expect(view).toMatchObject({ state: 'unavailable', reason: 'not-installed', actions: { write: false } })
    await expect(op(off.ctx, { op: 'image.pull', image: 'docker.io/library/nginx:1.27' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(off.jobs).toEqual([])
  })
  it('pulls only from trusted registries and verifies the image', async () => {
    const h = harness()
    await expect(op(h.ctx, { op: 'image.pull', image: 'evil.example/x/y:1' })).rejects.toMatchObject({ detail: { reason: 'untrusted_registry' } })
    expect((await op(h.ctx, { op: 'image.pull', image: 'docker.io/library/nginx:1.27' })).status).toBe(202)
    const job = h.jobs[0]!
    expect(job.kind).toBe('software.container.image.pull')
    expect(job.policy(job.steps[0]!.argv)).toBe(true); expect(job.policy(['/usr/bin/podman', 'rm', 'x'])).toBe(false)
  })
  it('refuses to remove an image in use with IN_USE', async () => {
    const h = harness()
    await expect(op(h.ctx, { op: 'image.remove', id: imageId })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'IN_USE' } })
  })
  it('refuses an overlapping subnet and a stale revision with CONFLICT', async () => {
    const h = harness()
    await expect(op(h.ctx, { op: 'network.create', name: 'net', subnet: '10.88.1.0/24', gateway: null, range: null, ipv6Subnet: null, labels: [] })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'subnet_overlap' } })
    await expect(call(h.ctx, 'op', { account: 'alice', expectedRevision: 'f'.repeat(64), action: { op: 'image.prune' } })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('deploys a stack, refuses a taken port and leaves saved volumes out of a prune', async () => {
    const root = await tempRoot(), h = harness({}, {}, root)
    expect((await op(h.ctx, { op: 'stack.save', name: 'shop', yaml, env: 'DB=secret\n', notes: '', template: null })).status).toBe(200)
    expect((await readRuntimeRegistry(root, accountId)).stacks?.[0]).toMatchObject({ name: 'shop', enabled: true })
    await expect(op(h.ctx, { op: 'stack.save', name: 'two', yaml: 'services:\n  a:\n    image: nginx:1\n    ports: ["8080:80"]', env: '', notes: '', template: null })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'PORT_IN_USE' } })
    await expect(op(h.ctx, { op: 'stack.save', name: 'two', yaml: 'services:\n  a:\n    image: nginx:1\n    ports: ["9090:80"]', env: '', notes: '', template: null })).rejects.toMatchObject({ detail: { reason: 'PORT_IN_USE' } })
    expect((await op(h.ctx, { op: 'volume.prune' })).status).toBe(202)
    expect(h.jobs.at(-1)!.steps.map(step => step.argv.at(-1))).toEqual(['junk'])
    await expect(op(h.ctx, { op: 'volume.remove', name: 'shop_data' })).rejects.toMatchObject({ detail: { reason: 'IN_USE' } })
    await op(h.ctx, { op: 'stack.restart-policy', name: 'shop', service: 'db', restart: 'always' })
    expect((await readRuntimeRegistry(root, accountId)).stacks?.[0]?.restart).toEqual({ db: 'always' })
    await op(h.ctx, { op: 'stack.stop', name: 'shop' })
    await op(h.ctx, { op: 'stack.remove', name: 'shop' })
    expect((await readRuntimeRegistry(root, accountId)).stacks).toEqual([])
  })
  it('saves a template without the values of its env', async () => {
    const root = await tempRoot(), h = harness({}, {}, root)
    await op(h.ctx, { op: 'stack.save', name: 'shop', yaml, env: 'DB=secret\n', notes: '', template: 'Shop' })
    const policy = await (await call(h.ctx, 'policy')).json() as { templates: { name: string; description: string; env: string }[] }
    expect(policy.templates).toEqual([expect.objectContaining({ name: 'shop', description: 'Shop', env: 'DB=\n' })])
  })
  it('restores the saved stack when the reconcile fails', async () => {
    const root = await tempRoot(), h = harness({ reconcile: async () => ({ status: 'failed' }) }, {}, root)
    await expect(op(h.ctx, { op: 'stack.save', name: 'shop', yaml, env: 'DB=secret\n', notes: '', template: null })).rejects.toMatchObject({ code: 'CONFIG_TEST_FAILED' })
    await expect(readFile(runtimeRegistryPath(root, accountId), 'utf8')).resolves.not.toContain('shop')
  })
  it('installs an app as a stack with generated secrets', async () => {
    const root = await tempRoot(), h = harness({}, {}, root)
    await op(h.ctx, { op: 'app.install', app: 'wordpress', name: 'blog', version: '6', bind: '127.0.0.1', port: 8081, memoryMb: 512, cpuPercent: 100 })
    const stack = (await readRuntimeRegistry(root, accountId)).stacks![0]!
    expect(stack).toMatchObject({ app: 'wordpress', limits: { memoryMb: 512, cpuPercent: 100 } })
    expect(stack.env).toMatch(/DB_PASSWORD=[0-9a-f]{36}/)
    const view = await (await call(h.ctx, 'scope?account=alice')).json() as { stacks: { envKeys: string[]; yaml: string }[] }
    expect(view.stacks[0]!.envKeys).toContain('DB_PASSWORD')
    expect(JSON.stringify(view)).not.toMatch(/DB_PASSWORD=/)
  })
  it('saves the trust policy and refuses a registry login that fails with AUTH_FAILED', async () => {
    const root = await tempRoot(), h = harness({}, {}, root)
    const policy = await (await call(h.ctx, 'policy')).json() as { revision: string; registries: unknown[] }
    expect(policy.registries).toHaveLength(3)
    const saved = await (await call(h.ctx, 'policy', { expectedRevision: policy.revision, policy: { registries: [{ host: 'ghcr.io', namespace: null, mirror: 'mirror.example.com' }], templates: [], feedUrl: null } })).json() as { registries: unknown[] }
    expect(saved.registries).toHaveLength(1)
    await expect(call(h.ctx, 'policy', { expectedRevision: policy.revision, policy: { registries: [], templates: [], feedUrl: null } })).rejects.toMatchObject({ code: 'CONFLICT' })
    const base = h.ctx.host!.run
    h.ctx.host!.run = async argv => argv.includes('--password-stdin') ? { ok: false, code: 1, stdout: '', stderr: '', timedOut: false } as never : argv[0] === '/usr/bin/journalctl' ? { ok: true, code: 0, stdout: 'Error: logging into "ghcr.io": invalid username/password', stderr: '', timedOut: false } as never : base(argv)
    await expect(op(h.ctx, { op: 'registry.login', host: 'ghcr.io', username: 'bob', password: 'wrong' })).rejects.toMatchObject({ detail: { reason: 'AUTH_FAILED' } })
    await expect(op(h.ctx, { op: 'registry.login', host: 'quay.io', username: 'bob', password: 'x' })).rejects.toMatchObject({ detail: { reason: 'untrusted_registry' } })
    expect((await readRuntimeRegistry(root, accountId)).logins).toBeUndefined()
    await expect(readFile(join(root, 'extended/containers/login-alice'), 'utf8')).rejects.toThrow()
  })
  it('rejects an invalid saved stack instead of half applying it', async () => {
    const root = await tempRoot()
    await atomicWriteJson(runtimeRegistryPath(root, accountId), { apps: [], cache: { redis: null, memcached: null }, containers: [], stacks: [{ name: 'x' }] }, 0o600)
    await expect(readRuntimeRegistry(root, accountId)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('re-checks root on each route and refuses selectors', async () => {
    const h = harness()
    await expect(call(h.ctx, 'accounts?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call({ ...h.ctx, assertRoot: async () => { throw new Error('denied') } }, 'accounts')).rejects.toThrow('denied')
    const view = await (await call(h.ctx, 'accounts')).json() as { accounts: { username: string; available: boolean }[] }
    expect(view.accounts).toEqual([expect.objectContaining({ username: 'alice', available: true })])
    await expect(call(h.ctx, 'scope?account=nobody')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
