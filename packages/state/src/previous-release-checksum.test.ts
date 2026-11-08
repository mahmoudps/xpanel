import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PREVIOUS_RELEASE_TREES, writePreviousReleaseTree, type PreviousReleaseTree } from './previous-release-fixture.ts'
import { StateStore } from './store.ts'

const roots: string[] = []
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })
const open = async (tree: PreviousReleaseTree): Promise<StateStore> => {
  const root = await mkdtemp(join(tmpdir(), 'xpanel-previous-state-')); roots.push(root)
  await writePreviousReleaseTree(tree, root)
  return new StateStore(root)
}
const [host, legacy] = PREVIOUS_RELEASE_TREES as [PreviousReleaseTree, PreviousReleaseTree]

// An upgrade observes the host through the target release before it reconciles, and refuses unless the active
// generation's manifest still names the checksum the previous release recorded. A rollback restores its snapshots.
describe.each(PREVIOUS_RELEASE_TREES.map(tree => [tree.name, tree] as const))('a 0.1.24 state tree: %s', (_name, tree) => {
  it('reads without refusal and keeps the checksum that release computed', async () => {
    const store = await open(tree)
    expect(await store.withReadonlyObservation(async observation => observation.snapshot.checksum)).toBe(tree.checksum)
    expect((await store.readSnapshot()).checksum).toBe(tree.checksum)
  })

  it('validates each generation snapshot that release saved to the checksum it recorded', async () => {
    const store = await open(tree), generations = Object.keys(tree.files).filter(path => /^generations\/\d+\.json$/.test(path))
    expect(generations.length).toBeGreaterThan(0)
    for (const path of generations) {
      const saved = tree.files[path] as { checksum: string }
      expect((await store.readValidatedGenerationSnapshot(Number(path.slice(12, -5))))?.checksum).toBe(saved.checksum)
    }
  })
})

describe('older shapes reach the store API through the policy layer, and the files stay as saved', () => {
  it('keeps the effective defaults of a firewall the host never saved', async () => {
    const store = await open(host)
    expect((await store.readSnapshot()).firewall).toEqual({ rules: [], prefixLists: [] })
    expect(await store.getFirewallState()).toMatchObject({ enabled: false, blockPing: false })
  })

  it('maps one oversell switch to disk and bandwidth, and serves saved rules as on', async () => {
    const store = await open(legacy), snapshot = await store.readSnapshot()
    expect(snapshot.resellers.map(reseller => reseller.oversell).sort()).toEqual([false, true])
    expect(Object.fromEntries((await store.listResellers()).map(reseller => [reseller.username, reseller.oversell])))
      .toEqual({ resell: { disk: true, bandwidth: true }, strict: { disk: false, bandwidth: false } })
    expect(snapshot.firewall).not.toHaveProperty('enabled')
    expect(await store.getFirewallState()).toMatchObject({ enabled: true, blockPing: false })
  })

  it('reads a saved reserved plan name and prefork, and refuses them only for a new save', async () => {
    const store = await open(legacy), before = await readdir(join(roots.at(-1)!, 'plans'))
    expect((await store.listPlans()).map(plan => plan.name)).toContain('Extensions')
    expect((await store.getServerSettings())?.apacheMpm).toBe('prefork')
    const standard = (await store.listPlans()).find(plan => plan.name === 'Standard')!
    await expect(store.createPlan({ ...standard, name: 'extensions' })).rejects.toThrow(/reserved plan name/)
    await expect(store.updatePlan(standard.id, { name: 'EXTENSIONS' })).rejects.toThrow(/reserved plan name/)
    const extensions = (await store.listPlans()).find(plan => plan.name === 'Extensions')!
    await expect(store.updatePlan(extensions.id, { shell: 'jailed' })).resolves.toMatchObject({ name: 'Extensions', shell: 'jailed' })
    expect(await readdir(join(roots.at(-1)!, 'plans'))).toEqual(before)
    const settings = (await store.getServerSettings())!
    await expect(store.saveServerSettings(settings)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })
})
