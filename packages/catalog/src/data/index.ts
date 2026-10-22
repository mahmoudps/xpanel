import type { CatalogTool, ToolSpec } from '../types.ts'
import { groups } from './groups.ts'
import { nativeSpecs, nativeTools } from './native.ts'
import { assessDelivery } from '../delivery.ts'
import { deliveryEvidence, deliveryTarget } from './delivery.ts'
import { specs as researchedSpecs } from './specs.ts'
import { tools as researchedTools } from './tools.ts'

export { groups }
export const specs: readonly ToolSpec[] = [...researchedSpecs, ...nativeSpecs]
const specsById = new Map(specs.map(spec => [spec.id, spec]))
export const tools: readonly CatalogTool[] = [...researchedTools, ...nativeTools].map(tool => {
  const spec = specsById.get(tool.id)
  if (spec === undefined) throw new Error(`Missing specification for catalog tool ${tool.id}`)
  const delivery = assessDelivery(tool, spec, deliveryEvidence, deliveryTarget)
  return { ...tool, status: delivery.status, delivery }
})
