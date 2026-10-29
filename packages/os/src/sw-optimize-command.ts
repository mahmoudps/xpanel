/** Public grammar of the account website-optimization view, shared by API and browser; self-contained for serialization. */
export interface SwOptimizeClientView {
  context: { accountId: string; username: string }; state: 'read' | 'unavailable'; reason: null | 'edge-config-unavailable' | 'unmanaged-edge-config' | 'invalid-edge-config'
  policy: null | { compression: 'on' | 'off'; types: string[]; minLength: number | null; proxied: string[]; cache: { configured: boolean; maxSize: string | null } }
  domains: { name: string; redirect: boolean; suspended: boolean }[]
  actions: { siteCompression: false; siteCache: false; purge: false }
}
export function readSwOptimizeView(value: unknown): SwOptimizeClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const bad = (): never => { throw new Error('invalid_optimize_view') }
  if (!object(value) || !keys(value, ['context', 'state', 'reason', 'policy', 'domains', 'actions']) || !object(value.context) || !keys(value.context, ['accountId', 'username']) || typeof value.context.accountId !== 'string' || value.context.accountId.length > 64
    || typeof value.context.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.context.username) || !['read', 'unavailable'].includes(value.state) || ![null, 'edge-config-unavailable', 'unmanaged-edge-config', 'invalid-edge-config'].includes(value.reason)
    || (value.state === 'read') !== (value.reason === null) || (value.state === 'read') !== (value.policy !== null) || !object(value.actions) || !keys(value.actions, ['siteCompression', 'siteCache', 'purge']) || Object.values(value.actions).some(item => item !== false)
    || !Array.isArray(value.domains) || value.domains.length > 1000) return bad()
  let policy: SwOptimizeClientView['policy'] = null
  if (value.policy !== null) {
    const p = value.policy
    if (!object(p) || !keys(p, ['compression', 'types', 'minLength', 'proxied', 'cache']) || !['on', 'off'].includes(p.compression) || !Array.isArray(p.types) || p.types.length > 64 || p.types.some((type: unknown) => typeof type !== 'string' || !/^(?:[a-z]+\/[a-z0-9.+-]{1,100}|\*)$/.test(type))
      || !(p.minLength === null || Number.isSafeInteger(p.minLength) && p.minLength >= 0) || !Array.isArray(p.proxied) || p.proxied.length > 10 || p.proxied.some((item: unknown) => typeof item !== 'string' || !/^[a-z_-]{2,20}$/.test(item))
      || !object(p.cache) || !keys(p.cache, ['configured', 'maxSize']) || typeof p.cache.configured !== 'boolean' || !(p.cache.maxSize === null || typeof p.cache.maxSize === 'string' && /^[0-9]{1,9}[kmgKMG]?$/.test(p.cache.maxSize))) return bad()
    policy = { compression: p.compression, types: [...p.types], minLength: p.minLength, proxied: [...p.proxied], cache: { configured: p.cache.configured, maxSize: p.cache.maxSize } }
  }
  const domains = value.domains.map((item: unknown) => object(item) && keys(item, ['name', 'redirect', 'suspended']) && typeof item.name === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.name) && typeof item.redirect === 'boolean' && typeof item.suspended === 'boolean' ? { name: item.name, redirect: item.redirect, suspended: item.suspended } : bad())
  return { context: { accountId: value.context.accountId, username: value.context.username }, state: value.state, reason: value.reason, policy, domains, actions: { siteCompression: false, siteCache: false, purge: false } }
}
