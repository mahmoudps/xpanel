import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { profileFor } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { PREVIOUS_RELEASE_TREES, writePreviousReleaseTree, type PreviousReleaseTree } from '../../../packages/state/src/previous-release-fixture.ts'
import { compileDesiredGeneration } from './reconciler.ts'

const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
const snapshotOf = async (tree: PreviousReleaseTree) => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-previous-generation-')); roots.push(root)
  await writePreviousReleaseTree(tree, root)
  return new StateStore(root).readSnapshot()
}
const [host, legacy] = PREVIOUS_RELEASE_TREES as [PreviousReleaseTree, PreviousReleaseTree]
const server = legacy.files['server.json'] as { settings: Record<string, unknown> }

// The reconciler serves a previous release's saved state through the policy layer, and never serves prefork.
describe('a generation compiled from a 0.1.24 state tree', () => {
  it('renders the qualification host, which never saved a firewall, without a firewall table', async () => {
    const generation = compileDesiredGeneration(await snapshotOf(host), { os })
    expect(generation.files.some(file => file.path === os.paths.nftablesConf)).toBe(false)
  })

  it('serves rules saved without the switch as on', async () => {
    const itk = { ...legacy, files: { ...legacy.files, 'server.json': { ...server, settings: { ...server.settings, apacheMpm: 'itk' } } } }
    const nft = compileDesiredGeneration(await snapshotOf(itk), { os }).files.find(file => file.path === os.paths.nftablesConf)
    expect(nft?.content).toContain('policy drop;')
    expect(nft?.content).toContain('203.0.113.0/28')
  })

  it('refuses to serve a saved prefork setting', async () => {
    const snapshot = await snapshotOf(legacy)
    expect(() => compileDesiredGeneration(snapshot, { os })).toThrow(expect.objectContaining({ code: 'ENGINE_UNAVAILABLE', detail: expect.objectContaining({ reason: 'prefork_refused' }) }))
  })
})
