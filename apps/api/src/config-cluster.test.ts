import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLUSTER_APPLY_PATH, clusterSections, handleClusterRoute, pushSectionsToCluster } from './config-cluster.ts'
import { addFakeServer, createFakeNetwork, linkServers } from './node-peers-test-fixture.ts'
import type { FakeNetwork, FakeServer } from './node-peers-test-fixture.ts'
import { panelConfigRevision } from './panel-config-file.ts'
import { serverOperationFiles } from './server-operations-workspace.ts'
import { tweakSettingsFile } from './tweak-settings-workspace.ts'

// Feature layer: a real master and real members over the modelled pin; the files are written and read back on disk.
const clusterRoute = (server: FakeServer) => [(request: Request, url: URL, method: string) => handleClusterRoute(request, url, method, { ...server.guards, store: server.store, link: server.link })]
let network: FakeNetwork, master: FakeServer, member: FakeServer
beforeEach(async () => {
  network = createFakeNetwork()
  master = await addFakeServer(network, 'master', { routes: clusterRoute })
  member = await addFakeServer(network, 'member', { routes: clusterRoute })
  await linkServers(master, member)
})
afterEach(() => network.close())

type View = { revision: string; members: string[]; sections: string[]; versions: { number: number; digest: string; sections: string[]; pushes: Record<string, { state: string; reason: string | null }> }[] }
const read = async (server: FakeServer = master) => await (await server.root('GET', '/api/server/cluster')).json() as View
const setMembers = async (ids = [member.link.selfId]) => master.root('PUT', '/api/server/cluster/members', { members: ids, expectedRevision: (await read()).revision })
const saveTweak = async (server: FakeServer, key: string, value: unknown) => {
  const file = tweakSettingsFile(server.store), { raw } = await file.read()
  await file.write({ ...raw as object, [key]: value } as never, panelConfigRevision(file.namespace, raw), async () => undefined)
}
const tweak = async (server: FakeServer, key: string) => (await tweakSettingsFile(server.store).current())[key]
/** The audit is the last thing a push does, so the store is idle again once it is written. */
const settled = (number: number) => vi.waitFor(() => { expect(master.audits.some(entry => /^cluster\.push\.(?:applied|failed)$/.test(String(entry.action)) && (entry.detail as { version: number }).version === number)).toBe(true) })
const pushed = async (sections: string[] = ['tweak-settings'], note = 'first') => {
  const created = await master.root('POST', '/api/server/cluster/versions', { sections, note })
  expect(created.status).toBe(201)
  const number = (await created.json() as View).versions[0]!.number
  expect((await master.root('POST', '/api/server/cluster/versions/' + number + '/push', { members: [member.link.selfId] })).status).toBe(202)
  await settled(number)
  return number
}
const pushOf = async (number: number) => (await read()).versions.find(item => item.number === number)!.pushes[member.link.selfId]!
const KEY = 'security.mailboxSendsPerHour'

describe('configuration cluster', () => {
  it('names portable sections only and keeps membership on the master', async () => {
    expect(Object.keys(clusterSections(master.store)).sort()).toEqual(['maintenance-schedule', 'sign-in-policy', 'tweak-settings', 'update-preferences'])
    expect((await setMembers()).status).toBe(200)
    expect((await read()).members).toEqual([member.link.selfId])
    expect((await read(member)).members).toEqual([])
    const stale = await master.root('PUT', '/api/server/cluster/members', { members: [], expectedRevision: 'f'.repeat(64) })
    expect(stale.status).toBe(409)
    const unknown = await master.root('PUT', '/api/server/cluster/members', { members: ['node_' + 'a'.repeat(16)], expectedRevision: (await read()).revision })
    expect(unknown.status).toBe(404)
  })
  it('refuses a member whose credential lacks privilege', async () => {
    await member.link.revoke((await member.link.nodes())[0]!.inboundTokenId)
    const refused = await setMembers()
    expect(refused.status).toBe(403)
    expect((await refused.json() as { details: { reason: string } }).details.reason).toBe('insufficient_privileges')
    expect((await read()).members).toEqual([])
  })
  it('pushes a chosen version, verifies it on the member and rolls it back', async () => {
    await setMembers()
    await saveTweak(master, KEY, 77)
    const before = await tweak(member, KEY)
    const number = await pushed()
    expect(await pushOf(number)).toMatchObject({ state: 'applied', reason: null })
    expect(await tweak(member, KEY)).toBe(77)
    expect(master.audits.map(entry => entry.action)).toEqual(expect.arrayContaining(['cluster.version.created', 'cluster.push.started', 'cluster.push.applied']))
    expect(member.audits.map(entry => entry.action)).toContain('cluster.config.applied')
    const undone = await master.root('POST', '/api/server/cluster/versions/' + number + '/rollback', { member: member.link.selfId, overwrite: false })
    expect(undone.status).toBe(200)
    expect(await tweak(member, KEY)).toBe(before)
    expect(await pushOf(number)).toMatchObject({ state: 'rolled_back' })
    expect((await tweakSettingsFile(member.store).read()).raw).toBeNull()
  })
  it('repeats a push without stacking and rolls back the newest only', async () => {
    await setMembers()
    await saveTweak(master, KEY, 77)
    const first = await pushed()
    expect((await master.root('POST', '/api/server/cluster/versions/' + first + '/push', { members: [member.link.selfId] })).status).toBe(202)
    await vi.waitFor(() => { expect(master.audits.filter(entry => entry.action === 'cluster.push.applied')).toHaveLength(2) })
    await saveTweak(master, KEY, 88)
    const second = await pushed(['tweak-settings'], 'second')
    expect(await tweak(member, KEY)).toBe(88)
    const old = await master.root('POST', '/api/server/cluster/versions/' + first + '/rollback', { member: member.link.selfId, overwrite: false })
    expect((await old.json() as { details: { reason: string } }).details.reason).toBe('not_latest')
    expect((await master.root('POST', '/api/server/cluster/versions/' + second + '/rollback', { member: member.link.selfId, overwrite: false })).status).toBe(200)
    expect(await tweak(member, KEY)).toBe(77)
    expect((await master.root('POST', '/api/server/cluster/versions/' + first + '/rollback', { member: member.link.selfId, overwrite: false })).status).toBe(200)
    expect((await tweakSettingsFile(member.store).read()).raw).toBeNull()
  })
  it('refuses to roll back over local changes unless told to overwrite them', async () => {
    await setMembers()
    await saveTweak(master, KEY, 77)
    const number = await pushed()
    await saveTweak(member, KEY, 55)
    const refused = await master.root('POST', '/api/server/cluster/versions/' + number + '/rollback', { member: member.link.selfId, overwrite: false })
    expect(refused.status).toBe(409)
    expect((await refused.json() as { details: { reason: string } }).details.reason).toBe('local_changes')
    expect(await tweak(member, KEY)).toBe(55)
    expect((await master.root('POST', '/api/server/cluster/versions/' + number + '/rollback', { member: member.link.selfId, overwrite: true })).status).toBe(200)
  })
  it('keeps the update owner of each server', async () => {
    await setMembers()
    const files = serverOperationFiles(master.store).updates, mine = serverOperationFiles(member.store).updates
    await mine.write({ tier: 'release', updates: 'manual', securityPatches: true, majorDelayDays: 0, owner: { principalId: 'member-root', username: 'root' } }, panelConfigRevision(mine.namespace, (await mine.read()).raw), async () => undefined)
    await files.write({ tier: 'stable', updates: 'automatic', securityPatches: false, majorDelayDays: 0, owner: { principalId: 'master-root', username: 'root' } }, panelConfigRevision(files.namespace, (await files.read()).raw), async () => undefined)
    await pushed(['update-preferences'])
    expect((await mine.read()).value).toMatchObject({ tier: 'stable', updates: 'automatic', securityPatches: false, owner: { principalId: 'member-root' } })
  })
  it('changes nothing when one pushed file fails its validator there', async () => {
    await setMembers()
    await saveTweak(member, KEY, 12)
    const token = (await master.link.readSecrets()).tokens[member.link.selfId]!
    const sections = { 'tweak-settings': { [KEY]: 99 }, 'update-preferences': { tier: 'nonsense' } }
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(JSON.stringify(Object.keys(sections).sort().map(id => [id, sections[id as keyof typeof sections]]))).digest('hex')
    const send = (body: unknown) => member.serve(new Request('https://' + member.hostname + CLUSTER_APPLY_PATH, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const refused = await send({ version: 9, digest, sections })
    expect(refused.status).toBe(412)
    expect((await refused.json() as { details: { reason: string; section: string } }).details).toMatchObject({ reason: 'section_invalid', section: 'update-preferences' })
    expect(await tweak(member, KEY)).toBe(12)
    expect(((await send({ version: 9, digest: 'a'.repeat(64), sections })).status)).toBe(412)
    const secret = { 'tweak-settings': { apiToken: 'x', token: 'y' } }
    const secretDigest = createHash('sha256').update(JSON.stringify([['tweak-settings', secret['tweak-settings']]])).digest('hex')
    expect((await send({ version: 10, digest: secretDigest, sections: secret })).status).toBe(400)
  })
  it('reports each member apart and refuses a push to a server that is not a member', async () => {
    await setMembers()
    await saveTweak(master, KEY, 77)
    member.reachable = false
    const number = await pushed()
    expect(await pushOf(number)).toMatchObject({ state: 'failed', reason: 'node_unreachable' })
    expect(master.audits.map(entry => entry.action)).toContain('cluster.push.failed')
    member.reachable = true
    await master.root('PUT', '/api/server/cluster/members', { members: [], expectedRevision: (await read()).revision })
    expect((await master.root('POST', '/api/server/cluster/versions/' + number + '/push', { members: [member.link.selfId] })).status).toBe(400)
  })
  it('accepts a member call from a linked server only, and a file with a bad saved value is not snapshotted', async () => {
    expect((await member.root('POST', CLUSTER_APPLY_PATH, { version: 1, digest: 'a'.repeat(64), sections: {} })).status).toBe(403)
    await writeFile(join(master.store.rootDir, 'extended', 'server', 'tweak-settings.json'), '{"unknown.key":1}')
    const refused = await master.root('POST', '/api/server/cluster/versions', { sections: ['tweak-settings'], note: '' })
    expect((await refused.json() as { details: { reason: string } }).details.reason).toBe('section_invalid')
    expect((await master.root('POST', '/api/server/cluster/versions', { sections: ['nothing'], note: '' })).status).toBe(400)
    expect((await master.root('POST', '/api/server/cluster/versions', { sections: [], note: '' })).status).toBe(400)
  })
  it('keeps a bounded history and sends a named file to every member', { tags: ['slow'] }, async () => {
    await setMembers()
    await saveTweak(master, KEY, 77)
    for (let index = 0; index < 22; index++) await master.root('POST', '/api/server/cluster/versions', { sections: ['tweak-settings'], note: '' })
    expect((await read()).versions).toHaveLength(20)
    expect((await read()).versions[0]!.number).toBe(22)
    const sent = await pushSectionsToCluster({ ...master.guards, store: master.store, link: master.link }, ['tweak-settings'], 'sent', master.caller)
    expect(sent).toEqual({ version: 23, members: 1 })
    await settled(23)
    expect(await tweak(member, KEY)).toBe(77)
    await master.root('PUT', '/api/server/cluster/members', { members: [], expectedRevision: (await read()).revision })
    expect(await pushSectionsToCluster({ ...master.guards, store: master.store, link: master.link }, ['tweak-settings'], 'sent', master.caller)).toBeNull()
  })
})
