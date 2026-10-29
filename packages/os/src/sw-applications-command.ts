/** Public grammar of the account applications view and its job request, shared by API and browser; self-contained for serialization. */
export interface SwApplicationsClientView {
  context: { accountId: string; username: string }
  catalog: { state: 'read' | 'unavailable'; reason: null | 'not-configured' | 'not-verified'; revision: string | null; sequence: number | null; expiresAt: string | null; applications: { id: string; name: string; versions: string[] }[] }
  domains: { id: string; name: string }[]
  selected: null | { domainId: string; state: 'read' | 'unavailable'; reason: null | 'application_provider_unavailable' | 'application_catalog_unavailable'; revision: string | null; installation: null | { appId: string; version: string; previousVersion: string | null }; recoveryRequired: boolean | null; writesAvailable: boolean }
}
export function readSwApplicationsView(value: unknown): SwApplicationsClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const bad = (): never => { throw new Error('invalid_applications_view') }
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const app = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item)
  const version = (item: unknown): item is string => typeof item === 'string' && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(item)
  if (!object(value) || !keys(value, ['context', 'catalog', 'domains', 'selected']) || !object(value.context) || !keys(value.context, ['accountId', 'username']) || !uuid(value.context.accountId) || typeof value.context.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.context.username)) return bad()
  const c = value.catalog
  if (!object(c) || !keys(c, ['state', 'reason', 'revision', 'sequence', 'expiresAt', 'applications']) || !['read', 'unavailable'].includes(c.state) || ![null, 'not-configured', 'not-verified'].includes(c.reason) || (c.state === 'read') !== (c.reason === null)
    || (c.state === 'read') !== hash(c.revision) || !(c.sequence === null || Number.isSafeInteger(c.sequence) && c.sequence >= 1) || !(c.expiresAt === null || typeof c.expiresAt === 'string' && Number.isFinite(Date.parse(c.expiresAt)))
    || !Array.isArray(c.applications) || c.applications.length > 64 || c.state !== 'read' && c.applications.length) return bad()
  const ids = new Set<string>()
  const applications = c.applications.map((item: unknown) => {
    if (!object(item) || !keys(item, ['id', 'name', 'versions']) || !app(item.id) || ids.has(item.id) || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(item.name)
      || !Array.isArray(item.versions) || item.versions.length < 1 || item.versions.length > 8 || !item.versions.every(version)) return bad()
    ids.add(item.id); return { id: item.id, name: item.name, versions: [...item.versions] }
  })
  if (!Array.isArray(value.domains) || value.domains.length > 1000) return bad()
  const domainIds = new Set<string>()
  const domains = value.domains.map((item: unknown) => { if (!object(item) || !keys(item, ['id', 'name']) || !uuid(item.id) || domainIds.has(item.id) || typeof item.name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(item.name)) return bad(); domainIds.add(item.id); return { id: item.id, name: item.name } })
  let selected: SwApplicationsClientView['selected'] = null
  if (value.selected !== null) {
    const s = value.selected
    if (!object(s) || !keys(s, ['domainId', 'state', 'reason', 'revision', 'installation', 'recoveryRequired', 'writesAvailable']) || !domainIds.has(s.domainId) || !['read', 'unavailable'].includes(s.state) || ![null, 'application_provider_unavailable', 'application_catalog_unavailable'].includes(s.reason)
      || (s.state === 'read') !== hash(s.revision) || (s.state === 'read') !== (typeof s.recoveryRequired === 'boolean') || s.state !== 'read' && (s.installation !== null || s.reason === null || s.writesAvailable !== false) || typeof s.writesAvailable !== 'boolean') return bad()
    let installation = null
    if (s.installation !== null) {
      const i = s.installation
      if (!object(i) || !keys(i, ['appId', 'version', 'previousVersion']) || !app(i.appId) || !version(i.version) || !(i.previousVersion === null || version(i.previousVersion))) return bad()
      installation = { appId: i.appId, version: i.version, previousVersion: i.previousVersion }
    }
    selected = { domainId: s.domainId, state: s.state, reason: s.reason, revision: s.revision, installation, recoveryRequired: s.recoveryRequired, writesAvailable: s.writesAvailable }
  }
  return { context: { accountId: value.context.accountId, username: value.context.username }, catalog: { state: c.state, reason: c.reason, revision: c.revision, sequence: c.sequence, expiresAt: c.expiresAt, applications }, domains, selected }
}
