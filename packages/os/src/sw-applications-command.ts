/** Public grammar of the account applications view and its job request, shared by API and browser; self-contained for serialization. */
export interface SwApplicationsClientView {
  context: { accountId: string; username: string }
  catalog: { state: 'read' | 'unavailable'; reason: null | 'not-configured' | 'not-verified' | 'expired'; revision: string | null; sequence: number | null; expiresAt: string | null; applications: { id: string; name: string; versions: string[] }[] }
  domains: { id: string; name: string }[]
  instances: { domainId: string; domain: string; path: string; appId: string; version: string; previousVersion: string | null; database: string | null; updatedAt: string }[]
  selected: null | { domainId: string; path: string; state: 'read' | 'unavailable'; reason: string | null; revision: string | null; installation: null | { appId: string; version: string; previousVersion: string | null }; recoveryRequired: boolean | null; modified: boolean | null; writesAvailable: boolean }
}
export function readSwApplicationsView(value: unknown): SwApplicationsClientView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, list: string[]): boolean => Object.keys(item).sort().join() === [...list].sort().join()
  const bad = (): never => { throw new Error('invalid_applications_view') }
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const app = (item: unknown): item is string => typeof item === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(item)
  const version = (item: unknown): item is string => typeof item === 'string' && /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(item)
  const place = (item: unknown): item is string => item === '' || typeof item === 'string' && item.length <= 240 && item.split('/').every(part => /^[A-Za-z0-9._-]{1,64}$/.test(part) && part !== '.' && part !== '..')
  if (!object(value) || !keys(value, ['context', 'catalog', 'domains', 'instances', 'selected']) || !object(value.context) || !keys(value.context, ['accountId', 'username']) || !uuid(value.context.accountId) || typeof value.context.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.context.username)) return bad()
  const c = value.catalog
  if (!object(c) || !keys(c, ['state', 'reason', 'revision', 'sequence', 'expiresAt', 'applications']) || !['read', 'unavailable'].includes(c.state) || ![null, 'not-configured', 'not-verified', 'expired'].includes(c.reason) || (c.state === 'read') !== (c.reason === null)
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
  if (!Array.isArray(value.instances) || value.instances.length > 64) return bad()
  const instances = value.instances.map((item: unknown) => {
    if (!object(item) || !keys(item, ['domainId', 'domain', 'path', 'appId', 'version', 'previousVersion', 'database', 'updatedAt']) || !domainIds.has(item.domainId) || typeof item.domain !== 'string' || !place(item.path) || !app(item.appId) || !version(item.version)
      || !(item.previousVersion === null || version(item.previousVersion)) || !(item.database === null || typeof item.database === 'string' && /^[a-z0-9_]{1,64}$/.test(item.database)) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) return bad()
    return { domainId: item.domainId, domain: item.domain, path: item.path, appId: item.appId, version: item.version, previousVersion: item.previousVersion, database: item.database, updatedAt: item.updatedAt }
  })
  let selected: SwApplicationsClientView['selected'] = null
  if (value.selected !== null) {
    const s = value.selected
    if (!object(s) || !keys(s, ['domainId', 'path', 'state', 'reason', 'revision', 'installation', 'recoveryRequired', 'modified', 'writesAvailable']) || !domainIds.has(s.domainId) || !place(s.path) || !['read', 'unavailable'].includes(s.state) || !(s.reason === null || typeof s.reason === 'string' && /^application_[a-z_]{1,64}$/.test(s.reason))
      || (s.state === 'read') !== hash(s.revision) || (s.state === 'read') !== (typeof s.recoveryRequired === 'boolean') || (s.state === 'read') !== (typeof s.modified === 'boolean') || s.state !== 'read' && (s.installation !== null || s.reason === null || s.writesAvailable !== false) || typeof s.writesAvailable !== 'boolean') return bad()
    let installation = null
    if (s.installation !== null) {
      const i = s.installation
      if (!object(i) || !keys(i, ['appId', 'version', 'previousVersion']) || !app(i.appId) || !version(i.version) || !(i.previousVersion === null || version(i.previousVersion))) return bad()
      installation = { appId: i.appId, version: i.version, previousVersion: i.previousVersion }
    }
    selected = { domainId: s.domainId, path: s.path, state: s.state, reason: s.reason, revision: s.revision, installation, recoveryRequired: s.recoveryRequired, modified: s.modified, writesAvailable: s.writesAvailable }
  }
  return { context: { accountId: value.context.accountId, username: value.context.username }, catalog: { state: c.state, reason: c.reason, revision: c.revision, sequence: c.sequence, expiresAt: c.expiresAt, applications }, domains, instances, selected }
}
