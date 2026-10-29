import { ECDH, createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { OsProfile, RenderedFile } from '@xpanel/core'
import { AsyncMutex } from '@xpanel/state'
import { securityObservationCommands } from '@xpanel/os'
import type { SecurityObservationWindow } from '@xpanel/os'
import type { AgentExecutor } from '../executor.ts'
import { LinuxHostExecutor } from '../executor.ts'
import { ALLOWED_SSH_KEY_TYPES, validateSshPublicKey } from './account-process.ts'

const MAX_KEYS_BYTES = 512 * 1024
const MAX_JOURNAL_BYTES = 1024 * 1024
const MAX_KEYS = 500
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const ROOT_KEYS = '/root/.ssh/authorized_keys'
const POLICY_FIELDS = new Set(['port', 'pubkeyauthentication', 'passwordauthentication', 'permitrootlogin', 'kbdinteractiveauthentication', 'authenticationmethods', 'maxauthtries', 'logingracetime', 'allowusers', 'allowgroups'])

export interface SshKeyObservation {
  fingerprint: string
  keyType: string
  comment: string
  managed: boolean
  protected: boolean
  addedAt: string | null
  lastUsedAt: null
}
export interface SshFailedLoginObservation {
  at: string
  address: string
  username: string
  method: string
}
export interface SshObservation {
  observedAt: string
  policy: { state: 'read' | 'unavailable'; values: Record<string, string>; reason?: string }
  service: { state: 'read' | 'unavailable'; unit: string; active: string | null; substate: string | null; enabled: string | null; reason?: string }
  keys: { state: 'read' | 'partial' | 'review-required' | 'unavailable'; revision: string | null; items: SshKeyObservation[]; opaqueEntries: number; reason?: string }
  failedLogins: { state: 'read' | 'unavailable'; items: SshFailedLoginObservation[]; window: SecurityObservationWindow; limit: 500; truncated: boolean; reason?: string }
}
interface ManagedKey { fingerprint: string; publicKey: string; addedAt: string }
export interface RootKeyMutationOptions { authorize?: () => Promise<void> }
interface KeyState { content: string | null; indexContent: string | null; managed: ManagedKey[]; revision: string; journalPresent: boolean }

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const printable = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !UNSAFE.test(value)
const canonicalFingerprint = (blob: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')

/** Validates SSH wire fields; authentication with the key is checked separately. */
export function validateManagedSshPublicKey(value: unknown): ReturnType<typeof validateSshPublicKey> {
  let parsed: ReturnType<typeof validateSshPublicKey>
  try { parsed = validateSshPublicKey(value) }
  catch { return fail('VALIDATION', 'SSH public key format is invalid', { stateChanged: false }) }
  if (!printable(parsed.comment, 256)) return fail('VALIDATION', 'SSH key comment contains unsupported characters', { stateChanged: false })
  const wire = Buffer.from(parsed.base64Blob, 'base64')
  if (wire.toString('base64') !== parsed.base64Blob) return fail('VALIDATION', 'SSH public key encoding must be canonical', { stateChanged: false })
  let offset = 0
  const field = (): Buffer => {
    if (offset + 4 > wire.length) return fail('VALIDATION', 'SSH public key fields are incomplete', { stateChanged: false })
    const size = wire.readUInt32BE(offset); offset += 4
    if (size > wire.length - offset) return fail('VALIDATION', 'SSH public key field is truncated', { stateChanged: false })
    const result = wire.subarray(offset, offset + size); offset += size; return result
  }
  if (field().toString('ascii') !== parsed.keyType) return fail('VALIDATION', 'SSH public key type differs from its wire value', { stateChanged: false })
  const curveKey = (): void => {
    const curve = field().toString('utf8'), point = field()
    const expected = parsed.keyType.includes('nistp384') ? ['nistp384', 'secp384r1', 97] : parsed.keyType.includes('nistp521') ? ['nistp521', 'secp521r1', 133] : ['nistp256', 'prime256v1', 65]
    if (curve !== expected[0] || point.length !== expected[2] || point[0] !== 4) return fail('VALIDATION', 'SSH elliptic-curve key is malformed', { stateChanged: false })
    try { ECDH.convertKey(point, String(expected[1]), undefined, undefined, 'uncompressed') } catch { return fail('VALIDATION', 'SSH elliptic-curve point is invalid', { stateChanged: false }) }
  }
  if (parsed.keyType === 'ssh-ed25519' || parsed.keyType === 'sk-ssh-ed25519@openssh.com') {
    if (field().length !== 32) return fail('VALIDATION', 'SSH ed25519 key must contain 32 public bytes', { stateChanged: false })
  } else if (parsed.keyType === 'ssh-rsa') {
    const exponent = field(), modulus = field()
    if (!exponent.length || exponent.length > 8 || exponent[0]! >= 128 || !modulus.length || modulus[0]! >= 128) return fail('VALIDATION', 'SSH RSA integers are malformed', { stateChanged: false })
    if (exponent.length > 1 && exponent[0] === 0 && exponent[1]! < 128 || modulus.length > 1 && modulus[0] === 0 && modulus[1]! < 128) return fail('VALIDATION', 'SSH RSA integers must use canonical positive encoding', { stateChanged: false })
    const e = BigInt('0x' + exponent.toString('hex')), n = modulus[0] === 0 ? modulus.subarray(1) : modulus
    const bits = n.length ? (n.length - 1) * 8 + 32 - Math.clz32(n[0]!) : 0
    if (e < 3n || e % 2n === 0n || bits < 2048 || bits > 16384 || !n.length || n[n.length - 1]! % 2 !== 1) return fail('VALIDATION', 'SSH RSA key must use a safe exponent and 2048 through 16384 bits', { stateChanged: false })
  } else curveKey()
  if (parsed.keyType.startsWith('sk-')) {
    const application = field()
    if (!application.length || application.length > 1024 || !printable(application.toString('utf8'), 1024)) return fail('VALIDATION', 'SSH security-key application is invalid', { stateChanged: false })
  }
  if (offset !== wire.length) return fail('VALIDATION', 'SSH public key contains unexpected wire data', { stateChanged: false })
  return parsed
}

/** Options-bearing and unrecognized existing lines are preserved and can never become managed. */
function existingKey(line: string): ReturnType<typeof validateManagedSshPublicKey> | null {
  const tokens = line.trim().split(/\s+/)
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (!ALLOWED_SSH_KEY_TYPES.has(tokens[index]!)) continue
    try {
      const blob = Buffer.from(tokens[index + 1]!, 'base64').toString('base64')
      const comment = tokens.slice(index + 2).join(' ')
      return validateManagedSshPublicKey(tokens[index] + ' ' + blob + (printable(comment, 256) && comment ? ' ' + comment : ''))
    } catch { /* opaque entries are retained byte for byte */ }
  }
  return null
}

export { securityObservationCommands } from '@xpanel/os'

export function parseSshEffectivePolicy(stdout: string): Record<string, string> {
  if (Buffer.byteLength(stdout) > 128 * 1024) return fail('PRECONDITION_FAILED', 'SSH effective policy exceeds its bound')
  const values: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const split = line.indexOf(' ')
    if (split < 1) continue
    const name = line.slice(0, split), value = line.slice(split + 1).trim()
    if (!POLICY_FIELDS.has(name)) continue
    if (!printable(value, 1024) || name !== 'port' && Object.hasOwn(values, name)) return fail('PRECONDITION_FAILED', 'SSH effective policy is ambiguous')
    values[name] = name === 'port' && values[name] ? values[name] + ' ' + value : value
  }
  if (!values.port || !values.pubkeyauthentication || !values.passwordauthentication || !values.permitrootlogin) return fail('PRECONDITION_FAILED', 'SSH effective policy did not return required observations')
  return values
}

export function parseSshFailedLogins(stdout: string, unit: string): SshFailedLoginObservation[] {
  if (Buffer.byteLength(stdout) > MAX_JOURNAL_BYTES) return fail('PRECONDITION_FAILED', 'SSH journal response exceeds its bound')
  const lines = stdout.split('\n').filter(Boolean)
  if (lines.length > 500) return fail('PRECONDITION_FAILED', 'SSH journal returned too many records')
  const items: SshFailedLoginObservation[] = []
  for (const line of lines) {
    let record: unknown
    try { record = JSON.parse(line) } catch { return fail('PRECONDITION_FAILED', 'SSH journal output is not structured JSON') }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const entry = record as Record<string, unknown>
    if (entry._UID !== '0' || entry._SYSTEMD_UNIT !== unit || !['sshd', 'sshd-session'].includes(String(entry._COMM)) || !['/usr/sbin/sshd', '/usr/lib/openssh/sshd-session'].includes(String(entry._EXE))) continue
    if (!printable(entry.MESSAGE, 2048) || typeof entry.__REALTIME_TIMESTAMP !== 'string' || !/^\d{10,20}$/.test(entry.__REALTIME_TIMESTAMP)) continue
    const match = /^Failed ([a-zA-Z0-9@/_-]{1,64}) for (?:invalid user )?(.{1,64}?) from ([0-9a-fA-F:.]+) port \d{1,5}(?: ssh2)?(?: \[preauth\])?$/.exec(entry.MESSAGE)
    if (!match || !isIP(match[3]!) || !printable(match[2], 64)) continue
    const at = new Date(Number(BigInt(entry.__REALTIME_TIMESTAMP) / 1000n))
    if (!Number.isFinite(at.getTime())) continue
    items.push({ at: at.toISOString(), address: match[3]!, username: match[2]!, method: match[1]! })
  }
  return items.sort((left, right) => right.at.localeCompare(left.at))
}

export class SecurityObservationService {
  private readonly executor: AgentExecutor
  private readonly os: OsProfile
  private readonly indexPath: string
  private readonly journalPath: string
  private readonly protectedFingerprints: ReadonlySet<string>
  private readonly mutex = new AsyncMutex()
  private readonly now: () => Date

  constructor(input: { executor: AgentExecutor; os: OsProfile; stateDir: string; protectedFingerprints?: readonly string[]; now?: () => Date }) {
    if (typeof input.stateDir !== 'string' || !posix.isAbsolute(input.stateDir) || input.stateDir.includes('..') || input.stateDir === '/') fail('VALIDATION', 'security state directory must be trusted and absolute')
    this.executor = input.executor; this.os = input.os; this.now = input.now ?? (() => new Date())
    this.indexPath = posix.join(input.stateDir, 'security', 'root-managed-keys.json')
    this.journalPath = posix.join(input.stateDir, 'security', 'root-key-write.json')
    this.protectedFingerprints = new Set(input.protectedFingerprints ?? [])
    securityObservationCommands(this.os)
  }

  private async keyState(): Promise<KeyState> {
    const content = await this.executor.readFile(ROOT_KEYS), indexContent = await this.executor.readFile(this.indexPath)
    if (Buffer.byteLength(content ?? '') > MAX_KEYS_BYTES || Buffer.byteLength(indexContent ?? '') > MAX_KEYS_BYTES) return fail('PRECONDITION_FAILED', 'SSH key files exceed their bounds', { stateChanged: false })
    let managed: ManagedKey[] = []
    if (indexContent !== null) {
      let value: unknown
      try { value = JSON.parse(indexContent) } catch { return fail('PRECONDITION_FAILED', 'managed SSH key index needs review', { stateChanged: false }) }
      if (!Array.isArray(value) || value.length > MAX_KEYS) return fail('PRECONDITION_FAILED', 'managed SSH key index needs review', { stateChanged: false })
      const seen = new Set<string>()
      managed = value.map(record => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('PRECONDITION_FAILED', 'managed SSH key index needs review', { stateChanged: false })
        const entry = record as Record<string, unknown>, key = validateManagedSshPublicKey(entry.publicKey)
        const fingerprint = canonicalFingerprint(key.base64Blob)
        if (entry.fingerprint !== fingerprint || typeof entry.addedAt !== 'string' || !Number.isFinite(Date.parse(entry.addedAt)) || seen.has(fingerprint)) return fail('PRECONDITION_FAILED', 'managed SSH key index needs review', { stateChanged: false })
        seen.add(fingerprint); return { fingerprint, publicKey: key.canonicalLine, addedAt: entry.addedAt }
      })
    }
    return { content, indexContent, managed, revision: sha(JSON.stringify([content, indexContent])), journalPresent: await this.executor.readFile(this.journalPath) !== null }
  }

  private projectKeys(state: KeyState): SshObservation['keys'] {
    const items: SshKeyObservation[] = []; let opaqueEntries = 0
    for (const line of (state.content ?? '').split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const key = existingKey(line)
      if (!key) { opaqueEntries++; continue }
      const fingerprint = canonicalFingerprint(key.base64Blob), managed = state.managed.find(record => record.fingerprint === fingerprint && record.publicKey === line)
      items.push({ fingerprint, keyType: key.keyType, comment: key.comment, managed: !!managed, protected: !managed || this.protectedFingerprints.has(fingerprint), addedAt: managed?.addedAt ?? null, lastUsedAt: null })
    }
    const counts = new Map<string, number>()
    for (const item of items) counts.set(item.fingerprint, (counts.get(item.fingerprint) ?? 0) + 1)
    for (const item of items) if ((counts.get(item.fingerprint) ?? 0) > 1) item.protected = true
    if (items.length + opaqueEntries > MAX_KEYS) return fail('PRECONDITION_FAILED', 'SSH authorized keys exceed their entry bound')
    return { state: state.journalPresent ? 'review-required' : opaqueEntries ? 'partial' : 'read', revision: state.revision, items, opaqueEntries,
      ...(state.journalPresent ? { reason: 'root_key_write_requires_review' } : {}) }
  }

  async observeSsh(input: { window?: SecurityObservationWindow } = {}): Promise<SshObservation> {
    const commands = securityObservationCommands(this.os, input.window ?? '24h')
    const result: SshObservation = {
      observedAt: this.now().toISOString(), policy: { state: 'unavailable', values: {}, reason: 'ssh_policy_unavailable' },
      service: { state: 'unavailable', unit: commands.unit, active: null, substate: null, enabled: null, reason: 'ssh_service_unavailable' },
      keys: { state: 'unavailable', revision: null, items: [], opaqueEntries: 0, reason: 'ssh_keys_unavailable' },
      failedLogins: { state: 'unavailable', items: [], window: commands.window, limit: 500, truncated: false, reason: 'ssh_journal_unavailable' },
    }
    const reads = await Promise.allSettled([
      this.executor.runCommand(commands.effective), this.executor.runCommand(commands.service), this.executor.runCommand(commands.failures),
      this.mutex.run(() => this.keyState().then(state => this.projectKeys(state))),
    ])
    const effective = reads[0], service = reads[1], failures = reads[2], keys = reads[3]
    if (effective?.status === 'fulfilled' && 'ok' in effective.value && effective.value.ok) {
      try { result.policy = { state: 'read', values: parseSshEffectivePolicy(effective.value.stdout) } } catch { /* retain explicit unavailable state */ }
    }
    if (service?.status === 'fulfilled' && 'ok' in service.value && service.value.ok && Buffer.byteLength(service.value.stdout) <= 16 * 1024) {
      const values = Object.fromEntries(service.value.stdout.split('\n').map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)] }))
      if (printable(values.ActiveState, 128) && printable(values.SubState, 128) && printable(values.UnitFileState, 128) && values.LoadState === 'loaded') result.service = { state: 'read', unit: commands.unit, active: values.ActiveState, substate: values.SubState, enabled: values.UnitFileState }
    }
    if (failures?.status === 'fulfilled' && 'ok' in failures.value && failures.value.ok) {
      try { const items = parseSshFailedLogins(failures.value.stdout, commands.unit); result.failedLogins = { state: 'read', items, window: commands.window, limit: 500, truncated: failures.value.stdout.split('\n').filter(Boolean).length === 500 } } catch { /* retain explicit unavailable state */ }
    }
    if (keys?.status === 'fulfilled' && 'items' in keys.value) result.keys = keys.value
    return result
  }

  private rendered(path: string, content: string): RenderedFile { return { path, content, mode: 0o600, owner: 'root', group: 'root' } }

  private async authorizeKeyChange(authorize?: () => Promise<void>): Promise<void> {
    if (!authorize && this.executor instanceof LinuxHostExecutor) return fail('PRECONDITION_FAILED', 'native SSH key mutations require a trusted authorization callback', { stateChanged: false })
    await authorize?.()
  }

  private async publishKeys(before: KeyState, content: string, managed: ManagedKey[], options: RootKeyMutationOptions): Promise<SshObservation['keys']> {
    const indexContent = JSON.stringify(managed, null, 2) + '\n'
    if (managed.length > MAX_KEYS || Buffer.byteLength(content) > MAX_KEYS_BYTES || Buffer.byteLength(indexContent) > MAX_KEYS_BYTES) return fail('LIMIT_EXCEEDED', 'SSH key state reached its capacity', { stateChanged: false })
    const suffix = this.now().toISOString().replace(/[-:.TZ]/g, '') + '-' + randomUUID()
    const backups = [
      ...(before.content === null ? [] : [this.rendered(ROOT_KEYS + '.bak.' + suffix, before.content)]),
      ...(before.indexContent === null ? [] : [this.rendered(this.indexPath + '.bak.' + suffix, before.indexContent)]),
    ]
    const intent = this.rendered(this.journalPath, JSON.stringify({ version: 1, before: { revision: before.revision }, after: { keysSha256: sha(content), indexSha256: sha(indexContent) }, backups: backups.map(file => file.path), at: this.now().toISOString() }) + '\n')
    const files = [this.rendered(ROOT_KEYS, content), this.rendered(this.indexPath, indexContent)]
    const dirs = [{ kind: 'ensure-dir' as const, path: '/root/.ssh', mode: 0o700, owner: 'root', group: 'root' }, { kind: 'ensure-dir' as const, path: posix.dirname(this.indexPath), mode: 0o700, owner: 'root', group: 'root' }]
    // Retained backups are never compensating removals; their atomic writes enforce write admission separately.
    await this.authorizeKeyChange(options.authorize)
    await this.executor.preflight({ files: [intent, ...files], preActions: dirs, postActions: [] })
    for (const action of dirs) { await this.authorizeKeyChange(options.authorize); await this.executor.runAction(action) }
    for (const backup of backups) { await this.authorizeKeyChange(options.authorize); await this.executor.writeFile(backup) }
    const current = await this.keyState()
    if (current.revision !== before.revision || current.journalPresent) return fail('CONFLICT', 'SSH keys changed while preparing their backup', { stateChanged: false })
    await this.authorizeKeyChange(options.authorize)
    await this.executor.writeFile(intent)
    try {
      for (const file of files) { await this.authorizeKeyChange(options.authorize); await this.executor.writeFile(file) }
      const observed = await this.keyState()
      if (observed.content !== content || observed.indexContent !== indexContent) return fail('PRECONDITION_FAILED', 'SSH key readback differs from the requested state')
      await this.authorizeKeyChange(options.authorize)
      await this.executor.removePath(this.journalPath)
      const committed = await this.keyState()
      if (committed.journalPresent || committed.content !== content || committed.indexContent !== indexContent) return fail('PRECONDITION_FAILED', 'SSH key commit requires inspection')
      return this.projectKeys(committed)
    } catch (error) {
      let restored = false
      try {
        const actualKeys = await this.executor.readFile(ROOT_KEYS), actualIndex = await this.executor.readFile(this.indexPath)
        if (![before.content, content].includes(actualKeys) || ![before.indexContent, indexContent].includes(actualIndex)) throw new Error('external_key_change')
        if (before.content === null) await this.executor.removePath(ROOT_KEYS); else await this.executor.writeFile(this.rendered(ROOT_KEYS, before.content))
        if (before.indexContent === null) await this.executor.removePath(this.indexPath); else await this.executor.writeFile(this.rendered(this.indexPath, before.indexContent))
        const rollback = await this.keyState()
        if (rollback.revision !== before.revision) throw new Error('rollback_readback_mismatch')
        await this.executor.removePath(this.journalPath); restored = true
      } catch { /* retain intent and backups; do not overwrite unrecognized external changes */ }
      if (!restored) return fail('PRECONDITION_FAILED', 'SSH key outcome requires operator review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      return fail('PRECONDITION_FAILED', 'SSH key write failed and the previous state was restored', { stateChanged: false, restored: true })
    }
  }

  async addRootKey(input: { publicKey: unknown; expectedRevision: unknown }, options: RootKeyMutationOptions = {}): Promise<{ applied: true; keys: SshObservation['keys'] }> {
    const key = validateManagedSshPublicKey(input.publicKey)
    return this.mutex.run(async () => {
      await this.authorizeKeyChange(options.authorize)
      const before = await this.keyState()
      if (before.journalPresent) return fail('PRECONDITION_FAILED', 'SSH key write requires operator review', { stateChanged: false, verificationRequired: true })
      if (typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision)) return fail('VALIDATION', 'saved SSH key revision is required', { stateChanged: false })
      if (before.revision !== input.expectedRevision) return fail('CONFLICT', 'SSH keys changed; read them before retrying', { stateChanged: false })
      const current = this.projectKeys(before), fingerprint = canonicalFingerprint(key.base64Blob)
      if (current.opaqueEntries > 0) return fail('PRECONDITION_FAILED', 'unrecognized existing SSH entries require operator review before a key is added', { stateChanged: false })
      if (current.items.some(item => item.fingerprint === fingerprint)) return fail('CONFLICT', 'this SSH key already exists; no access restrictions were changed', { stateChanged: false })
      if (current.items.length + current.opaqueEntries >= MAX_KEYS) return fail('LIMIT_EXCEEDED', 'SSH authorized keys reached their capacity', { stateChanged: false })
      const content = (before.content ?? '') + (before.content && !before.content.endsWith('\n') ? '\n' : '') + key.canonicalLine + '\n'
      const keys = await this.publishKeys(before, content, [...before.managed, { fingerprint, publicKey: key.canonicalLine, addedAt: this.now().toISOString() }], options)
      return { applied: true, keys }
    })
  }

  async removeManagedRootKey(input: { fingerprint: unknown; expectedRevision: unknown }, options: RootKeyMutationOptions = {}): Promise<{ applied: true; keys: SshObservation['keys'] }> {
    return this.mutex.run(async () => {
      await this.authorizeKeyChange(options.authorize)
      const before = await this.keyState()
      if (before.journalPresent) return fail('PRECONDITION_FAILED', 'SSH key write requires operator review', { stateChanged: false, verificationRequired: true })
      if (typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision) || typeof input.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(input.fingerprint)) return fail('VALIDATION', 'saved SSH key fingerprint and revision are required', { stateChanged: false })
      if (before.revision !== input.expectedRevision) return fail('CONFLICT', 'SSH keys changed; read them before retrying', { stateChanged: false })
      const observation = this.projectKeys(before), target = observation.items.find(item => item.fingerprint === input.fingerprint)
      if (!target?.managed || target.protected) return fail('FORBIDDEN', 'existing, fleet and protected SSH keys cannot be removed', { stateChanged: false })
      if (observation.items.length <= 1) return fail('SELF_LOCKOUT', 'the last known SSH key cannot be removed', { stateChanged: false })
      const managed = before.managed.find(item => item.fingerprint === input.fingerprint)!
      const lines = (before.content ?? '').split('\n'), exact = lines.filter(line => line === managed.publicKey)
      if (exact.length !== 1) return fail('CONFLICT', 'the managed SSH key line changed; review it before removal', { stateChanged: false })
      const content = lines.filter(line => line !== managed.publicKey).join('\n')
      const keys = await this.publishKeys(before, content, before.managed.filter(item => item.fingerprint !== input.fingerprint), options)
      return { applied: true, keys }
    })
  }
}
