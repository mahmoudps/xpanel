import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, posix } from 'node:path'
import { fail, isUuid, isXpanelError, validateDomainName, validateUsername } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { AsyncMutex, atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { FileText, JailedFileManager } from './file-manager.ts'
import { HTACCESS_MAX_BYTES, inspectHtaccess, planHtaccessPhpMigration } from './htaccess-policy.ts'
import type { HtaccessIssue, HtaccessPhpPlan } from './htaccess-policy.ts'
import { parseHtaccessRequest } from './htaccess-contract.ts'

export interface HtaccessTarget {
  accountId: string; username: string; home: string; domainId: string; domainName: string
  docRoot: string; path: string; engine: string; backendPort: number; phpHandler: string; active: boolean
}
export interface HtaccessValidation { valid: boolean; nativeChecked: boolean; issues: HtaccessIssue[]; checkedAt: string }
export interface HtaccessValidator { available(): Promise<boolean>; check(target: HtaccessTarget, content: string): Promise<HtaccessValidation> }
export type HtaccessOperation = 'read' | 'validate' | 'save' | 'restore' | 'migrate-php'
export type HtaccessRequest = { op: 'read' } | { op: 'validate' | 'save'; content: string; expectedRevision: string }
  | { op: 'restore'; versionId: string; expectedRevision: string }
  | { op: 'migrate-php'; content: string; expectedRevision: string; expectedPhpRevision: string }
interface Version { id: string; at: string; actor: string; file: FileText | null; revision: string; state: 'kept' | 'saved' | 'restored' | 'rolled_back' | 'failed' }
interface Pending { id: string; at: string; actor: string; before: FileText | null; content: string | null; state: 'pending' | 'unknown' }
interface History { versions: Version[]; pending: Pending | null }
export interface HtaccessDocument { exists: boolean; content: string; sizeBytes: number; mtime: string | null; revision: string }
export interface HtaccessView {
  context: Pick<HtaccessTarget, 'accountId' | 'domainId' | 'domainName' | 'path' | 'engine' | 'phpHandler'>
  document: HtaccessDocument
  versions: { id: string; at: string; actor: string; sizeBytes: number; revision: string; state: Version['state']; current: boolean; canRestore: boolean }[]
  policy: ReturnType<typeof inspectHtaccess>
  capabilities: { canValidate: boolean; canSave: boolean; canRestore: boolean; canMigrate: boolean; reason: string | null }
  application: { status: 'read' | 'validated' | 'saved' | 'restored' | 'rolled_back'; nativeQualified: false; syntaxChecked: boolean; httpStatus: number | null }
  reviewRequired: boolean
  validation?: HtaccessValidation
  phpRevision?: string
  migration?: { phpRevision: string; keys: string[]; status: 'applied' | 'restored' }
}
export interface HtaccessPhpUpdatePort {
  revision(target: HtaccessTarget): Promise<string>
  /** Existing domain PHP writer owns validation, its revision and guarded compensation. */
  migrate(target: HtaccessTarget, plan: HtaccessPhpPlan, expectedPhpRevision: string,
    saveFile: () => Promise<HtaccessView>): Promise<HtaccessView>
}
export interface HtaccessWorkspaceOptions {
  historyDir: string
  resolve(username: string, domainId: string, operation: HtaccessOperation): Promise<HtaccessTarget>
  files(target: HtaccessTarget): Pick<JailedFileManager, 'readText' | 'writeTextChecked'>
  validator?: HtaccessValidator
  probe(target: HtaccessTarget): Promise<number>
  actor: string
  php?: HtaccessPhpUpdatePort
}
const locks = new Map<string, AsyncMutex>()
const sameContent = (file: FileText | null, content: string | null): boolean => content === null ? file === null : file !== null && file.content === content
const revisionPattern = /^[0-9a-f]{64}$/
export const htaccessRevision = (target: HtaccessTarget, file: FileText | null): string => createHash('sha256').update(JSON.stringify({ accountId: target.accountId, domainId: target.domainId, path: target.path, file })).digest('hex')

/** Derives the only permitted target from current trusted state, never request paths. */
export function deriveHtaccessTarget(account: Account, domain: Domain, settings: ServerSettings | null, servingDomain?: Domain | null): HtaccessTarget {
  if (!isUuid(account.id) || !isUuid(domain.id) || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const serving = domain.kind === 'alias' ? servingDomain : domain
  if (!serving || !isUuid(serving.id) || serving.accountId !== account.id || serving.kind === 'alias' || domain.kind === 'alias' && serving.id !== domain.parentId) return fail('PRECONDITION_FAILED', 'the current serving domain could not be resolved', { stateChanged: false })
  const username = validateUsername(account.username), domainName = validateDomainName(domain.name)
  if (typeof account.home !== 'string' || !posix.isAbsolute(account.home) || posix.normalize(account.home) !== account.home || /[\\\u0000-\u001f\u007f"']/.test(account.home) || !posix.isAbsolute(serving.docRoot) || posix.normalize(serving.docRoot) !== serving.docRoot || /[\\\u0000-\u001f\u007f"']/.test(serving.docRoot) || serving.docRoot.includes('${')) return fail('PRECONDITION_FAILED', 'domain file target is not canonical', { stateChanged: false })
  const relative = posix.relative(account.home, serving.docRoot)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative) || relative === '.trash' || relative.startsWith('.trash/')) return fail('FORBIDDEN', 'domain document root is outside the account file workspace', { stateChanged: false })
  const path = relative ? relative + '/.htaccess' : '.htaccess'
  const backendPort = settings?.backendPort ?? 0
  return { accountId: account.id, username, home: account.home, domainId: domain.id, domainName, docRoot: serving.docRoot, path,
    engine: settings?.engine ?? 'unavailable', backendPort, phpHandler: serving.php?.handler ?? 'unavailable',
    active: account.status === 'active' && !domain.suspended && !serving.suspended && ['php', 'static'].includes(serving.siteType) }
}

/** Content and recovery truth live in the confined filesystem; JSON retains private preimages only. */
export class HtaccessWorkspace {
  private readonly options: HtaccessWorkspaceOptions
  constructor(options: HtaccessWorkspaceOptions) {
    if (!isAbsolute(options.historyDir) || /[\u0000-\u001f]/.test(options.historyDir)) fail('VALIDATION', 'trusted absolute .htaccess history directory is required')
    this.options = options
  }
  private historyPath(target: HtaccessTarget): string { return join(this.options.historyDir, target.accountId, target.domainId + '.json') }
  private async history(target: HtaccessTarget): Promise<History> {
    const value = await readJsonIfExists<History>(this.historyPath(target))
    if (value === null) return { versions: [], pending: null }
    if (!Object.hasOwn(value, 'pending') || !Array.isArray(value.versions) || value.versions.length > 30 || value.versions.some(version => !isUuid(version.id) || !revisionPattern.test(version.revision) || !Number.isFinite(Date.parse(version.at)) || typeof version.actor !== 'string' || !['kept', 'saved', 'restored', 'rolled_back', 'failed'].includes(version.state) || version.file !== null && (version.file.path !== target.path || typeof version.file.content !== 'string' || Buffer.byteLength(version.file.content) > HTACCESS_MAX_BYTES) || htaccessRevision(target, version.file) !== version.revision) || value.pending && (!isUuid(value.pending.id) || !['pending', 'unknown'].includes(value.pending.state))) return fail('PRECONDITION_FAILED', '.htaccess history requires inspection', { stateChanged: false })
    return value
  }
  private async persist(target: HtaccessTarget, history: History): Promise<void> {
    await atomicWriteJson(this.historyPath(target), { ...history, versions: history.versions.slice(-30) }, 0o640)
  }
  private async file(target: HtaccessTarget): Promise<FileText | null> {
    try {
      const file = await this.options.files(target).readText(target.path)
      if (file.path !== target.path || Buffer.byteLength(file.content, 'utf8') !== file.sizeBytes || file.sizeBytes > HTACCESS_MAX_BYTES) return fail('LIMIT_EXCEEDED', '.htaccess file cannot be edited within the 64 KiB limit', { stateChanged: false })
      return file
    } catch (error) { if (isXpanelError(error) && error.code === 'NOT_FOUND') return null; throw error }
  }
  private assertExpected(target: HtaccessTarget, file: FileText | null, expected: string): void {
    if (!revisionPattern.test(expected)) fail('VALIDATION', 'a current .htaccess revision is required', { stateChanged: false })
    if (htaccessRevision(target, file) !== expected) fail('CONFLICT', '.htaccess changed; read and review it before retrying', { stateChanged: false })
  }
  private async view(target: HtaccessTarget, file: FileText | null, history: History, status: HtaccessView['application']['status'] = 'read', validation?: HtaccessValidation, httpStatus: number | null = null): Promise<HtaccessView> {
    const revision = htaccessRevision(target, file), available = !!this.options.validator && await this.options.validator.available()
    const allowed = target.active && target.engine === 'apache' && available && history.pending === null
    let phpRevision: string | undefined
    if (this.options.php && allowed) { try { const value = await this.options.php.revision(target); if (revisionPattern.test(value)) phpRevision = value } catch { /* PHP availability does not invent a migration capability. */ } }
    return { context: { accountId: target.accountId, domainId: target.domainId, domainName: target.domainName, path: target.path, engine: target.engine, phpHandler: target.phpHandler },
      document: { exists: file !== null, content: file?.content ?? '', sizeBytes: file?.sizeBytes ?? 0, mtime: file?.mtime ?? null, revision },
      versions: history.versions.map(version => ({ id: version.id, at: version.at, actor: version.actor, sizeBytes: version.file?.sizeBytes ?? 0, revision: version.revision, state: version.state, current: version.revision === revision, canRestore: allowed && version.state !== 'failed' && inspectHtaccess(version.file?.content ?? '').valid && !sameContent(file, version.file?.content ?? null) })),
      policy: inspectHtaccess(file?.content ?? ''), capabilities: { canValidate: allowed, canSave: allowed, canRestore: allowed, canMigrate: allowed && !!phpRevision,
        reason: history.pending ? 'A previous file operation requires inspection.' : !target.active ? 'The domain is not an active file-backed site.' : target.engine !== 'apache' ? '.htaccess requires the Apache engine.' : !available ? 'The protected Apache validation service is unavailable.' : null },
      application: { status, nativeQualified: false, syntaxChecked: validation?.nativeChecked === true, httpStatus }, reviewRequired: history.pending !== null, ...(validation ? { validation } : {}), ...(phpRevision ? { phpRevision } : {}) }
  }
  async read(username: string, domainId: string): Promise<HtaccessView> {
    const target = await this.options.resolve(username, domainId, 'read')
    return this.view(target, await this.file(target), await this.history(target))
  }
  private async validateCandidate(target: HtaccessTarget, content: string): Promise<HtaccessValidation> {
    const policy = inspectHtaccess(content)
    if (!policy.valid) return { valid: false, nativeChecked: false, issues: policy.issues, checkedAt: new Date().toISOString() }
    if (!this.options.validator || !await this.options.validator.available()) return fail('PRECONDITION_FAILED', 'protected Apache candidate validation is unavailable', { stateChanged: false })
    let result: HtaccessValidation
    try { result = await this.options.validator.check(target, content) }
    catch { return fail('CONFIG_TEST_FAILED', 'protected Apache candidate validation could not complete', { stateChanged: false }) }
    if (typeof result.valid !== 'boolean' || result.nativeChecked !== true || !Array.isArray(result.issues)) return fail('CONFIG_TEST_FAILED', 'Apache candidate validation result could not be verified', { stateChanged: false })
    return result
  }
  async validate(username: string, domainId: string, content: string, expectedRevision: string): Promise<HtaccessView> {
    const target = await this.options.resolve(username, domainId, 'validate'), file = await this.file(target), history = await this.history(target)
    this.assertExpected(target, file, expectedRevision)
    if (!target.active || target.engine !== 'apache' || history.pending) return fail('PRECONDITION_FAILED', '.htaccess validation is unavailable for this target', { stateChanged: false })
    return this.view(target, file, history, 'validated', await this.validateCandidate(target, content))
  }
  private async apply(username: string, domainId: string, expectedRevision: string, replacement: string | null,
    operation: 'save' | 'restore'): Promise<HtaccessView> {
    const initial = await this.options.resolve(username, domainId, operation)
    const key = initial.accountId + ':' + initial.path
    let mutex = locks.get(key); if (!mutex) { mutex = new AsyncMutex(); locks.set(key, mutex) }
    return mutex.run(async () => {
      const target = await this.options.resolve(username, domainId, operation)
      if (target.accountId !== initial.accountId || target.path !== initial.path || !target.active || target.engine !== 'apache') return fail('PRECONDITION_FAILED', '.htaccess target changed or is unavailable', { stateChanged: false })
      const current = await this.file(target), history = await this.history(target)
      this.assertExpected(target, current, expectedRevision)
      if (history.pending) return fail('PRECONDITION_FAILED', 'a previous .htaccess operation requires inspection', { stateChanged: false })
      const validation = await this.validateCandidate(target, replacement ?? '')
      if (!validation.valid) return this.view(target, current, history, 'validated', validation)
      if (sameContent(current, replacement)) return this.view(target, current, history, operation === 'save' ? 'saved' : 'restored', validation)
      let baselineStatus: number
      try { baselineStatus = await this.options.probe(target) }
      catch { return fail('PRECONDITION_FAILED', 'the existing site check is unavailable', { stateChanged: false }) }
      if (!Number.isInteger(baselineStatus) || baselineStatus < 100 || baselineStatus > 599) return fail('PRECONDITION_FAILED', 'the existing site check is unavailable', { stateChanged: false })
      const at = new Date().toISOString(), pending: Pending = { id: randomUUID(), at, actor: this.options.actor, before: current, content: replacement, state: 'pending' }
      if (!history.versions.some(version => version.revision === expectedRevision)) history.versions.push({ id: randomUUID(), at, actor: this.options.actor, file: current, revision: expectedRevision, state: 'kept' })
      history.pending = pending
      await this.persist(target, history)
      let wrote = false
      try {
        const latest = await this.options.resolve(username, domainId, operation)
        if (latest.accountId !== target.accountId || latest.path !== target.path || latest.docRoot !== target.docRoot || !latest.active || latest.engine !== 'apache') return fail('CONFLICT', '.htaccess target changed before publication', { stateChanged: false })
        const acknowledgement = await this.options.files(target).writeTextChecked(target.path, replacement, current); wrote = true
        const saved = await this.file(target)
        if (!sameContent(saved, replacement) || saved !== null && (acknowledgement === null || acknowledgement.mtime !== saved.mtime || acknowledgement.sizeBytes !== saved.sizeBytes)) return fail('SERVICE_UNAVAILABLE', 'the file write requires inspection', { stateChanged: true, unknownOutcome: true })
        let status: number | null = null
        try { status = await this.options.probe(target) } catch { status = null }
        if (status === null || status >= 500 || status < 100 || status > 599) {
          // Compensation consumes only the exact just-observed candidate. It never
          // overwrites a different current file in an attempt to manufacture success.
          const binding = await this.options.resolve(username, domainId, 'read')
          if (binding.accountId !== target.accountId || binding.path !== target.path || binding.docRoot !== target.docRoot) return fail('SERVICE_UNAVAILABLE', 'the target moved before compensation', { stateChanged: true, unknownOutcome: true })
          await this.options.files(target).writeTextChecked(target.path, current?.content ?? null, saved)
          const restored = await this.file(target)
          if (!sameContent(restored, current?.content ?? null)) return fail('SERVICE_UNAVAILABLE', 'file compensation requires inspection', { stateChanged: true, unknownOutcome: true })
          history.pending = null
          history.versions.push({ id: randomUUID(), at: new Date().toISOString(), actor: this.options.actor, file: saved, revision: htaccessRevision(target, saved), state: 'failed' })
          history.versions.push({ id: randomUUID(), at: new Date().toISOString(), actor: this.options.actor, file: restored, revision: htaccessRevision(target, restored), state: 'rolled_back' })
          await this.persist(target, history)
          return this.view(target, restored, history, 'rolled_back', validation, status)
        }
        history.pending = null
        history.versions.push({ id: randomUUID(), at: new Date().toISOString(), actor: this.options.actor, file: saved, revision: htaccessRevision(target, saved), state: operation === 'save' ? 'saved' : 'restored' })
        await this.persist(target, history)
        return this.view(target, saved, history, operation === 'save' ? 'saved' : 'restored', validation, status)
      } catch (error) {
        const uncertain = isXpanelError(error) && ['stateChanged', 'verificationRequired', 'unknownOutcome'].some(key => error.detail?.[key] === true)
        const unchanged = !wrote && !uncertain && isXpanelError(error) && ['CONFLICT', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION', 'PRECONDITION_FAILED', 'LIMIT_EXCEEDED'].includes(error.code)
        history.pending = unchanged ? null : { ...pending, state: 'unknown' }
        try { await this.persist(target, history) } catch { return fail('SERVICE_UNAVAILABLE', 'file outcome and recovery metadata require inspection', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
        if (unchanged && isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
        return fail('SERVICE_UNAVAILABLE', '.htaccess outcome requires inspection; no retry was sent', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      }
    })
  }
  save(username: string, domainId: string, content: string, expectedRevision: string): Promise<HtaccessView> { inspectHtaccess(content); return this.apply(username, domainId, expectedRevision, content, 'save') }
  async restore(username: string, domainId: string, versionId: string, expectedRevision: string): Promise<HtaccessView> {
    if (!isUuid(versionId)) return fail('VALIDATION', 'a valid kept version selector is required', { stateChanged: false })
    const target = await this.options.resolve(username, domainId, 'restore'), history = await this.history(target)
    const version = history.versions.find(item => item.id === versionId)
    if (!version || version.state === 'failed') return fail('NOT_FOUND', 'restorable kept version not found', { stateChanged: false })
    return this.apply(username, domainId, expectedRevision, version.file?.content ?? null, 'restore')
  }
  async migratePhp(username: string, domainId: string, content: string, expectedRevision: string, expectedPhpRevision: string): Promise<HtaccessView> {
    if (!this.options.php || !revisionPattern.test(expectedPhpRevision)) return fail('PRECONDITION_FAILED', 'the guarded domain PHP migration service is unavailable', { stateChanged: false })
    const target = await this.options.resolve(username, domainId, 'migrate-php'), file = await this.file(target)
    this.assertExpected(target, file, expectedRevision)
    if (await this.options.php.revision(target) !== expectedPhpRevision) return fail('CONFLICT', 'domain PHP configuration changed; read it before migration', { stateChanged: false })
    const plan = planHtaccessPhpMigration(content)
    const result = await this.options.php.migrate(target, plan, expectedPhpRevision, () => this.save(username, domainId, plan.content, expectedRevision))
    const receipt = result.migration
    if (!receipt || !revisionPattern.test(receipt.phpRevision) || !Array.isArray(receipt.keys) || JSON.stringify([...receipt.keys].sort()) !== JSON.stringify(Object.keys(plan.settings).sort()) ||
        !['saved', 'rolled_back', 'validated'].includes(result.application.status) ||
        result.application.status === 'saved' && (receipt.status !== 'applied' || result.document.content !== plan.content) ||
        result.application.status !== 'saved' && receipt.status !== 'restored') return fail('SERVICE_UNAVAILABLE', 'PHP and file migration outcomes require inspection', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    return result
  }
  async handle(username: string, domainId: string, input: unknown): Promise<HtaccessView> {
    validateUsername(username)
    if (!isUuid(domainId)) return fail('VALIDATION', 'a domain selector is required', { stateChanged: false })
    const request = parseHtaccessRequest(input)
    if (request.op === 'read') return this.read(username, domainId)
    if (request.op === 'validate') return this.validate(username, domainId, request.content, request.expectedRevision)
    if (request.op === 'save') return this.save(username, domainId, request.content, request.expectedRevision)
    if (request.op === 'restore') return this.restore(username, domainId, request.versionId, request.expectedRevision)
    if (request.op === 'migrate-php') {
      const { content, expectedRevision, expectedPhpRevision } = request
      return this.migratePhp(username, domainId, content, expectedRevision, expectedPhpRevision)
    }
    return fail('VALIDATION', 'unsupported .htaccess operation', { stateChanged: false })
  }
}
