import { describe, expect, it, vi } from 'vitest'
import { HOST_PROBES } from '../../../packages/catalog/src/host-qualification.ts'
import { createQualifiedCatalogProvider, loadQualifiedCatalog, qualificationModeOn } from './host-catalog.ts'

// The lab switch as a qualification guest reads it: on, while the unit slot runs there.
vi.mock('./qualification-mode.ts', () => ({ readQualificationMode: () => true }))
const report = { executor: 'linux', probes: Object.fromEntries(HOST_PROBES.map(id => [id, 'passed'])) }

describe('catalog of an application built without a provider', { tags: ['unit'] }, () => {
  it('never reads the host lab switch, so a unit run on a qualification host sees the ordinary catalog', async () => {
    expect(createQualifiedCatalogProvider().qualificationMode()).toBe(true)
    expect(qualificationModeOn()).toBe(false)
    const tools = await loadQualifiedCatalog({ token: 'test-agent', identity: {}, fetch: async () => Response.json(report) })
    expect(tools.some(tool => tool.delivery.admission)).toBe(false)
  })
})
