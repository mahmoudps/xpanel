import { qualifyHostTools, tools, type CatalogTool, type HostQualificationReport } from '@xpanel/catalog'
import type { AgentApp } from '@xpanel/agent'

export interface HostCatalogSource {
  fetch: AgentApp['fetch']
  token: string
}

let cached: { at: number; token: string; catalog: readonly CatalogTool[] } | undefined

/** Drops the short-lived host catalog so tests can observe a new health report. */
export const resetQualifiedCatalogCache = (): void => {
  cached = undefined
}

/** Ask the connected agent which implemented tools this host can run. */
export const loadQualifiedCatalog = async (source: HostCatalogSource | null): Promise<readonly CatalogTool[]> => {
  if (process.env.XPANEL_HOST_QUALIFICATION === 'off' || source === null) return tools
  const now = Date.now()
  if (cached && cached.token === source.token && now - cached.at < 15_000) return cached.catalog
  try {
    const response = await source.fetch(new Request('http://agent.local/health', {
      headers: { 'x-xpanel-agent-token': source.token },
    }))
    if (!response.ok) return tools
    const body = await response.json() as { executor?: unknown; probes?: HostQualificationReport['probes'] }
    const executor = body.executor === 'linux' || body.executor === 'fake' ? body.executor : 'unknown'
    const catalog = qualifyHostTools(tools, {
      executor,
      probes: { 'control-plane': 'passed', ...(body.probes ?? {}) },
    })
    cached = { at: now, token: source.token, catalog }
    return catalog
  } catch {
    return tools
  }
}
