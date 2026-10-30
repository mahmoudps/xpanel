import { createHash } from 'node:crypto'
import { buildDeliveryCatalog, qualifyHostTools, type CatalogTool, type HostQualificationReport, type VerificationTarget } from '@xpanel/catalog'
import type { AgentApp } from '@xpanel/agent'
import { loadTrustedEvidenceBundle, type CapabilityRequirement } from '../../../scripts/evidence/runtime.mjs'

export interface HostCatalogSource {
  fetch: AgentApp['fetch']
  token: string
  /** Stable connected agent identity, independent of a reused credential. */
  identity?: object
}

/** Startup-only values from protected operator configuration, never a request. */
export interface TrustedAcceptanceOptions {
  path: string
  expectedSha256: string
  expectedTarget: VerificationTarget
  expectedRequirements: readonly CapabilityRequirement[]
}

export interface QualifiedCatalogProvider {
  readonly acceptanceIdentity: string
  load(source: HostCatalogSource | null): Promise<readonly CatalogTool[]>
  reset(): void
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** Acceptance is captured once; host reports can only narrow this immutable snapshot. */
export const createQualifiedCatalogProvider = (acceptance?: TrustedAcceptanceOptions): QualifiedCatalogProvider => {
  // Invalid configured evidence throws before any listener is opened. No accepted fallback exists.
  const verified = acceptance ? loadTrustedEvidenceBundle(acceptance) : undefined
  const base = freeze(structuredClone(buildDeliveryCatalog(verified?.evidence ?? [], verified?.target ?? null)))
  const acceptanceIdentity = createHash('sha256').update(JSON.stringify(acceptance ? {
    digest: acceptance.expectedSha256, target: acceptance.expectedTarget, requirements: acceptance.expectedRequirements,
  } : { accepted: false })).digest('hex')
  type Entry = { at: number; token: string; fetch: HostCatalogSource['fetch']; enabled: boolean; catalog: readonly CatalogTool[] }
  let cache = new WeakMap<object, Entry>()
  let lastEnabled: boolean | undefined
  const close = (report: HostQualificationReport | null, enabled: boolean) => freeze(qualifyHostTools(base, report, enabled))
  return Object.freeze({
    acceptanceIdentity,
    reset: () => { cache = new WeakMap() },
    async load(source: HostCatalogSource | null): Promise<readonly CatalogTool[]> {
      const enabled = process.env.XPANEL_HOST_QUALIFICATION !== 'off'
      if (lastEnabled !== enabled) { cache = new WeakMap(); lastEnabled = enabled }
      if (!source || !enabled) return close(null, enabled)
      const key = source.identity ?? source.fetch
      const now = Date.now(), cached = cache.get(key)
      if (cached && cached.token === source.token && cached.fetch === source.fetch && cached.enabled === enabled && now - cached.at < 15_000) return cached.catalog
      let report: HostQualificationReport | null = null
      try {
        const response = await source.fetch(new Request('http://agent.local/health', { headers: { 'x-xpanel-agent-token': source.token }, signal: AbortSignal.timeout(5000) }))
        if (response.ok) {
          const body: unknown = await response.json()
          if (body && typeof body === 'object' && !Array.isArray(body)) {
            const value = body as Record<string, unknown>
            if (value.probes && typeof value.probes === 'object' && !Array.isArray(value.probes)) report = {
              executor: value.executor === 'linux' || value.executor === 'fake' ? value.executor : 'unknown',
              probes: value.probes as HostQualificationReport['probes'],
            }
          }
        }
      } catch { /* An unread, failed or expired host report never establishes readiness. */ }
      const catalog = close(report, enabled)
      cache.set(key, { at: now, token: source.token, fetch: source.fetch, enabled, catalog })
      return catalog
    },
  })
}

let defaultProvider: QualifiedCatalogProvider | undefined
/** Test isolation only; startup applications retain their own explicitly shared instance. */
export const resetQualifiedCatalogCache = (): void => { defaultProvider?.reset() }
export const loadQualifiedCatalog = (source: HostCatalogSource | null): Promise<readonly CatalogTool[]> =>
  (defaultProvider ??= createQualifiedCatalogProvider()).load(source)