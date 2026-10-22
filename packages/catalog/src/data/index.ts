import type { CatalogTool, ToolSpec } from '../types.ts'
import { groups } from './groups.ts'
import { nativeSpecs, nativeTools } from './native.ts'
import { readyTools } from './ready.ts'
import { specs as researchedSpecs } from './specs.ts'
import { tools as researchedTools } from './tools.ts'

const withReadiness = (tool: CatalogTool): CatalogTool => {
  const test = readyTools[tool.id]
  if (tool.status === 'out-of-scope' || test === undefined) return tool
  return { ...tool, status: 'ready', acceptanceTest: test }
}

export { groups }
export const tools: readonly CatalogTool[] = [...researchedTools, ...nativeTools].map(withReadiness)
export const specs: readonly ToolSpec[] = [...researchedSpecs, ...nativeSpecs]
