import type { CapabilityEvidence, CatalogTool, ToolSpec, VerificationTarget } from '../types.ts'
import { groups } from './groups.ts'
import { nativeSpecs, nativeTools } from './native.ts'
import { assessDelivery } from '../delivery.ts'
import { deliveryEvidence, deliveryTarget } from './delivery.ts'
import { specs as researchedSpecs } from './specs.ts'
import { tools as researchedTools } from './tools.ts'

export { groups }
export const specs: readonly ToolSpec[] = [...researchedSpecs, ...nativeSpecs]
const specsById = new Map(specs.map(spec => [spec.id, spec]))
/** Build a fresh catalog from detached acceptance; never mutate declarations. */
export const buildDeliveryCatalog = (
  evidence: readonly CapabilityEvidence[], target: VerificationTarget | null,
): readonly CatalogTool[] => {
  const byTool = new Map<string, CapabilityEvidence[]>()
  for (const row of evidence) {
    if (row && typeof row === 'object' && typeof row.toolId === 'string') {
      const bucket = byTool.get(row.toolId)
      if (bucket !== undefined) bucket.push(row)
      else byTool.set(row.toolId, [row])
    }
  }
  return [...researchedTools, ...nativeTools].map(tool => {
    const spec = specsById.get(tool.id)
    if (spec === undefined) throw new Error(`Missing specification for catalog tool ${tool.id}`)
    const delivery = assessDelivery(tool, spec, byTool.get(tool.id) ?? [], target)
    return { ...tool, status: delivery.status, delivery }
  })
}

export const unqualifiedTools: readonly CatalogTool[] = Object.freeze(buildDeliveryCatalog([], null))
export const tools: readonly CatalogTool[] = buildDeliveryCatalog(deliveryEvidence, deliveryTarget)
