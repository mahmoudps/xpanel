export interface ComposerProjectTarget { selector: string; domain: string; account: string; directory: string; phpVersion: string }
export interface ComposerPackageView { name: string; requirement: string | null; locked: string | null; installed: string | null; development: boolean }
export interface ComposerProjectView {
  selector: string; state: 'read' | 'missing' | 'unavailable'; reason: 'composer-json-missing' | 'invalid-project-data' | 'project-read-unavailable' | null
  manifest: 'present' | 'missing' | 'unavailable'; lock: 'present' | 'missing' | 'unavailable'; vendor: 'present' | 'missing' | 'unavailable'
  lockMatch: 'matches' | 'differs' | 'not-verified'; lockFreshness: 'not-verified'; packages: ComposerPackageView[]
}
export interface ComposerWorkspaceView {
  scope: 'saved-site-document-roots'; observedAt: string
  binary: { state: 'read' | 'unavailable'; executable: '/usr/bin/composer'; version: string | null }
  projects: ComposerProjectTarget[]; selected: ComposerProjectView | null
  /** install/update are true only when the agent holds a qualified confined transaction provider and the job runner. */
  actions: { install: boolean; update: boolean; mirror: false; reason: 'isolated-composer-runner-unavailable' | null }
}

/** Whitelisted projection shared by API and browser; raw manifests, URLs, config and logs never cross it. */
export function readComposerWorkspaceView(value: unknown): ComposerWorkspaceView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, limit: number): item is string => typeof item === 'string' && item.length <= limit && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(item)
  const selector = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item)
  const version = (item: unknown): item is string => text(item, 128) && /^[A-Za-z0-9.+_~^*<>=!|, /:-]{1,128}$/.test(item) && !item.includes('://') && !item.includes('@')
  const bad = (): never => { throw new Error('invalid_composer_workspace') }
  if (!object(value) || value.scope !== 'saved-site-document-roots' || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) || !object(value.binary) || !['read', 'unavailable'].includes(String(value.binary.state)) || value.binary.executable !== '/usr/bin/composer' || !object(value.actions) || typeof value.actions.install !== 'boolean' || value.actions.update !== value.actions.install || value.actions.mirror !== false || value.actions.reason !== (value.actions.install ? null : 'isolated-composer-runner-unavailable') || !Array.isArray(value.projects) || value.projects.length > 1000) return bad()
  const binary = value.binary
  if (binary.state === 'read' ? typeof binary.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(binary.version) : binary.version !== null) return bad()
  const seen = new Set<string>()
  const projects: ComposerProjectTarget[] = value.projects.map(raw => {
    if (!object(raw) || !selector(raw.selector) || seen.has(raw.selector) || typeof raw.domain !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(raw.domain) || typeof raw.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.account) || !text(raw.directory, 1024) || !raw.directory.startsWith('/home/' + raw.account + '/') || !/^\/home\/[a-z][a-z0-9]{0,15}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(raw.directory) || raw.directory.split('/').some(part => part === '.' || part === '..') || typeof raw.phpVersion !== 'string' || !/^[5-9]\.[0-9]{1,2}$/.test(raw.phpVersion)) return bad()
    seen.add(raw.selector)
    return { selector: raw.selector, domain: raw.domain, account: raw.account, directory: raw.directory, phpVersion: raw.phpVersion }
  })
  let selected: ComposerProjectView | null = null
  if (value.selected !== null) {
    const raw = value.selected
    if (!object(raw) || !selector(raw.selector) || !seen.has(raw.selector) || !['read', 'missing', 'unavailable'].includes(String(raw.state)) || !['composer-json-missing', 'invalid-project-data', 'project-read-unavailable', null].includes(raw.reason as null) || !['present', 'missing', 'unavailable'].includes(String(raw.manifest)) || !['present', 'missing', 'unavailable'].includes(String(raw.lock)) || !['present', 'missing', 'unavailable'].includes(String(raw.vendor)) || !['matches', 'differs', 'not-verified'].includes(String(raw.lockMatch)) || raw.lockFreshness !== 'not-verified' || !Array.isArray(raw.packages) || raw.packages.length > 1000 || raw.state !== 'read' && raw.packages.length !== 0 || raw.state === 'read' && (raw.reason !== null || raw.manifest !== 'present' || raw.lock === 'unavailable' || raw.vendor === 'unavailable') || raw.state === 'missing' && (raw.reason !== 'composer-json-missing' || raw.manifest !== 'missing') || raw.state === 'unavailable' && !['invalid-project-data', 'project-read-unavailable'].includes(String(raw.reason))) return bad()
    const names = new Set<string>()
    const packages = raw.packages.map(item => {
      if (!object(item) || typeof item.name !== 'string' || !/^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/.test(item.name) || item.name.length > 200 || names.has(item.name) || item.requirement !== null && !version(item.requirement) || item.locked !== null && !version(item.locked) || item.installed !== null && !version(item.installed) || typeof item.development !== 'boolean') return bad()
      names.add(item.name)
      return { name: item.name, requirement: item.requirement as string | null, locked: item.locked as string | null, installed: item.installed as string | null, development: item.development }
    })
    selected = { selector: raw.selector, state: raw.state as ComposerProjectView['state'], reason: raw.reason as ComposerProjectView['reason'], manifest: raw.manifest as ComposerProjectView['manifest'], lock: raw.lock as ComposerProjectView['lock'], vendor: raw.vendor as ComposerProjectView['vendor'], lockMatch: raw.lockMatch as ComposerProjectView['lockMatch'], lockFreshness: 'not-verified', packages }
  }
  return { scope: 'saved-site-document-roots', observedAt: value.observedAt, binary: { state: binary.state as 'read' | 'unavailable', executable: '/usr/bin/composer', version: binary.version as string | null }, projects, selected, actions: value.actions.install ? { install: true, update: true, mirror: false, reason: null } : { install: false, update: false, mirror: false, reason: 'isolated-composer-runner-unavailable' } }
}

export interface ComposerJobReviewView {
  state: 'ready'; action: 'install' | 'update'; domainId: string; domain: string; account: string; phpVersion: string
  expectedRevision: string; reviewFingerprint: string; graphDigest: string; lockDigest: string; packages: { name: string; version: string; development: boolean }[]
}
/** Preview reply grammar shared by API and browser; self-contained for serialization. */
export function readComposerJobReview(value: unknown): ComposerJobReviewView {
  const object = (item: unknown): item is Record<string, any> => !!item && typeof item === 'object' && !Array.isArray(item)
  const hash = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const bad = (): never => { throw new Error('invalid_composer_review') }
  const raw = object(value) && Object.keys(value).join() === 'review' ? value.review : null
  if (!object(raw) || Object.keys(raw).sort().join() !== 'account,action,domain,domainId,expectedRevision,graphDigest,lockDigest,packages,phpVersion,reviewFingerprint,state' || raw.state !== 'ready' || !['install', 'update'].includes(raw.action)
    || typeof raw.domainId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw.domainId) || typeof raw.domain !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(raw.domain) || typeof raw.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.account)
    || typeof raw.phpVersion !== 'string' || !/^[5-9]\.[0-9]{1,2}$/.test(raw.phpVersion) || ![raw.expectedRevision, raw.reviewFingerprint, raw.graphDigest, raw.lockDigest].every(hash) || !Array.isArray(raw.packages) || raw.packages.length > 1000) return bad()
  const names = new Set<string>()
  const packages = raw.packages.map((item: unknown) => {
    if (!object(item) || Object.keys(item).sort().join() !== 'development,name,version' || typeof item.name !== 'string' || item.name.length > 200 || !/^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?\/[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/.test(item.name) || names.has(item.name)
      || typeof item.version !== 'string' || !/^(?:v?[0-9][A-Za-z0-9.+_-]{0,127}|dev-[A-Za-z0-9._-]{1,120})$/.test(item.version) || typeof item.development !== 'boolean') return bad()
    names.add(item.name); return { name: item.name, version: item.version, development: item.development }
  })
  return { state: 'ready', action: raw.action, domainId: raw.domainId, domain: raw.domain, account: raw.account, phpVersion: raw.phpVersion, expectedRevision: raw.expectedRevision, reviewFingerprint: raw.reviewFingerprint, graphDigest: raw.graphDigest, lockDigest: raw.lockDigest, packages }
}
