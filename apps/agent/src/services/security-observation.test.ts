import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { OsProfile, RenderedFile } from '@xpanel/core'
import { FakeHostExecutor, LinuxHostExecutor, createProductionHostTargetMatcher } from '../executor.ts'
import type { HostExecutionPlan } from '../executor.ts'
import { parseSshEffectivePolicy, parseSshFailedLogins, SecurityObservationService, validateManagedSshPublicKey } from './security-observation.ts'

// Memory-only host executor and generated public test keys; no native SSH access is exercised.
const rootPath = '/root/.ssh/authorized_keys', indexPath = '/var/lib/xpanel/security/root-managed-keys.json', journalPath = '/var/lib/xpanel/security/root-key-write.json'
const os = { family: 'debian', services: { sshd: 'ssh' }, paths: { sshdConfig: '/etc/ssh/sshd_config' } } as OsProfile
const key = (comment: string): string => {
  const { publicKey } = generateKeyPairSync('ed25519'), jwk = publicKey.export({ format: 'jwk' })
  const string = (value: Buffer): Buffer => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]) }
  const blob = Buffer.concat([string(Buffer.from('ssh-ed25519')), string(Buffer.from(jwk.x!, 'base64url'))])
  return 'ssh-ed25519 ' + blob.toString('base64') + ' ' + comment
}
const fingerprint = (value: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(value.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')
const failure = (patch: Record<string, unknown> = {}): string => JSON.stringify({ _UID: '0', _SYSTEMD_UNIT: 'ssh.service', _COMM: 'sshd', _EXE: '/usr/sbin/sshd', __REALTIME_TIMESTAMP: '1793026800000000', MESSAGE: 'Failed password for invalid user nobody from 192.0.2.4 port 45000 ssh2', ...patch })

class ObservedExecutor extends FakeHostExecutor {
  failIndex = false
  externalDuringFailure: string | null = null
  override async runCommand(argv: string[]) {
    this.executedCommands.push([...argv])
    return { ok: true, code: 0, stderr: '', stdout: argv[0] === '/usr/sbin/sshd' ? 'port 22\npubkeyauthentication yes\npasswordauthentication yes\npermitrootlogin prohibit-password\nmaxauthtries 3\nlogingracetime 30\n' : argv[0] === '/usr/bin/systemctl' ? 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n' : failure() + '\n' + failure({ _UID: '20000', MESSAGE: 'Failed password for root from 192.0.2.99 port 45000 ssh2' }) + '\n' }
  }
  override async writeFile(file: RenderedFile): Promise<void> {
    if (this.failIndex && file.path === indexPath) {
      this.failIndex = false
      if (this.externalDuringFailure !== null) this.files.set(rootPath, { path: rootPath, content: this.externalDuringFailure, mode: 0o600, owner: 'root', group: 'root' })
      throw new Error('synthetic_index_failure')
    }
    return super.writeFile(file)
  }
}
const fixture = async (content?: string) => {
  const executor = new ObservedExecutor(), original = content ?? '# existing root keys\n' + key('fleet-existing') + '\n'
  executor.files.set(rootPath, { path: rootPath, content: original, mode: 0o600, owner: 'root', group: 'root' })
  const service = new SecurityObservationService({ executor, os, stateDir: '/var/lib/xpanel', now: () => new Date('2026-10-26T15:00:00Z') })
  const initial = await service.observeSsh()
  return { executor, original, service, initial }
}

describe('SSH native observation and key boundary', () => {
  it('refuses a native key mutation without trusted authorization before probing any host files', async () => {
    const executor = new LinuxHostExecutor(), read = vi.spyOn(executor, 'readFile').mockRejectedValue(new Error('host read must not be reached'))
    const service = new SecurityObservationService({ executor, os, stateDir: '/var/lib/xpanel-agent' })
    await expect(service.addRootKey({ publicKey: key('unqualified-native'), expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(read).not.toHaveBeenCalled(); read.mockRestore()
  })
  it('rechecks a queued writer authorization after the preceding key transaction completes', async () => {
    const f = await fixture(), firstKey = key('allowed-first'), refusedKey = key('revoked-second')
    let enter!: () => void, resume!: () => void, first = true, revoked = false
    const entered = new Promise<void>(resolve => { enter = resolve }), waiting = new Promise<void>(resolve => { resume = resolve })
    const allowed = f.service.addRootKey({ publicKey: firstKey, expectedRevision: f.initial.keys.revision }, { authorize: async () => { if (first) { first = false; enter(); await waiting } } })
    await entered
    const denied = f.service.addRootKey({ publicKey: refusedKey, expectedRevision: f.initial.keys.revision }, { authorize: async () => { if (revoked) fail('FORBIDDEN', 'synthetic authorization revoked', { stateChanged: false }) } })
    const deniedAssertion = expect(denied).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    revoked = true; resume(); await allowed; await deniedAssertion
    const observed = await f.service.observeSsh()
    expect(observed.keys.items.filter(item => item.managed).map(item => item.fingerprint)).toEqual([fingerprint(firstKey)])
    expect(await f.executor.readFile(rootPath)).toContain(f.original)
  })
  it('restores exact original key bytes if authorization is revoked between key and index publication', async () => {
    const f = await fixture(), added = key('revoked-after-key-write'), write = f.executor.writeFile.bind(f.executor); let revoked = false
    const spy = vi.spyOn(f.executor, 'writeFile').mockImplementation(async file => { await write(file); if (file.path === rootPath && file.content.includes('revoked-after-key-write')) revoked = true })
    await expect(f.service.addRootKey({ publicKey: added, expectedRevision: f.initial.keys.revision }, { authorize: async () => { if (revoked) fail('FORBIDDEN', 'synthetic authorization revoked', { stateChanged: false }) } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, restored: true } })
    expect(await f.executor.readFile(rootPath)).toBe(f.original); expect(await f.executor.readFile(indexPath)).toBeNull(); expect(await f.executor.readFile(journalPath)).toBeNull(); spy.mockRestore()
  })
  it('can add and remove a managed key without permission to delete its retained recovery backups', async () => {
    const policy = createProductionHostTargetMatcher()
    // This declared port models compensatable preflight permissions; it is not
    // Linux metadata, process or filesystem qualification.
    class ScopedExecutor extends ObservedExecutor {
      override async preflight(plan: HostExecutionPlan) { for (const file of plan.files) for (const operation of ['read', 'write', 'remove'] as const) if (!policy(file.path, operation)) fail('PRECONDITION_FAILED', 'declared compensatable target is not admitted'); for (const action of plan.preActions) if (action.kind === 'ensure-dir' && !policy(action.path, 'ensure-directory')) fail('PRECONDITION_FAILED', 'declared directory is not admitted') }
      override async writeFile(file: RenderedFile) { if (!policy(file.path, 'write')) fail('PRECONDITION_FAILED', 'declared write is not admitted'); return super.writeFile(file) }
      override async readFile(path: string) { if (!policy(path, 'read')) fail('PRECONDITION_FAILED', 'declared read is not admitted'); return super.readFile(path) }
      override async removePath(path: string) { if (!policy(path, 'remove')) fail('PRECONDITION_FAILED', 'declared removal is not admitted'); return super.removePath(path) }
    }
    const executor = new ScopedExecutor(), original = key('fleet-original') + '\n'
    executor.files.set(rootPath, { path: rootPath, content: original, mode: 0o600, owner: 'root', group: 'root' })
    const service = new SecurityObservationService({ executor, os, stateDir: '/var/lib/xpanel-agent' }), before = await service.observeSsh(), added = key('managed-scoped')
    const applied = await service.addRootKey({ publicKey: added, expectedRevision: before.keys.revision })
    await service.removeManagedRootKey({ fingerprint: fingerprint(added), expectedRevision: applied.keys.revision })
    expect(await executor.readFile(rootPath)).toBe(original)
    const backups = [...executor.files.keys()].filter(path => path.includes('.bak.'))
    expect(backups.length).toBeGreaterThan(0); for (const path of backups) expect(policy(path, 'remove')).toBe(false)
  })
  it('returns actual parsed observations with fingerprint-only protected keys and trusted journal provenance', async () => {
    const f = await fixture(), value = f.initial
    expect(value.policy).toMatchObject({ state: 'read', values: { port: '22', passwordauthentication: 'yes' } })
    expect(value.service).toMatchObject({ state: 'read', active: 'active', unit: 'ssh.service' })
    expect(value.keys.items).toHaveLength(1); expect(value.keys.items[0]).toMatchObject({ managed: false, protected: true, lastUsedAt: null })
    expect(value.failedLogins.items.map(item => item.address)).toEqual(['192.0.2.4'])
    expect(JSON.stringify(value)).not.toContain(f.original.split('\n').find(line => line.startsWith('ssh-'))!.split(' ')[1]!)
    expect(f.executor.executedActions).toHaveLength(0)
  })
  it('uses the exact 7-day bounded journal command when requested', async () => {
    const f = await fixture(), value = await f.service.observeSsh({ window: '7d' })
    expect(value.failedLogins.window).toBe('7d')
    expect(f.executor.executedCommands.at(-1)).toEqual(['/usr/bin/journalctl', '--unit', 'ssh.service', '--since', '-7d', '--no-pager', '--output=json', '--lines=500'])
  })
  it('adds a new managed public key with backups and a verified readback while preserving every original byte', async () => {
    const f = await fixture(), added = key('managed-new')
    const result = await f.service.addRootKey({ publicKey: added, expectedRevision: f.initial.keys.revision })
    expect(result.applied).toBe(true); expect(result.keys.items.find(item => item.fingerprint === fingerprint(added))).toMatchObject({ managed: true, protected: false })
    expect((await f.executor.readFile(rootPath))?.startsWith(f.original)).toBe(true)
    const backups = [...f.executor.files.values()].filter(file => file.path.startsWith(rootPath + '.bak.'))
    expect(backups).toHaveLength(1); expect(backups[0]?.content).toBe(f.original)
    expect(await f.executor.readFile(journalPath)).toBeNull()
  })
  it('refuses duplicate options-bearing existing keys without widening their access restrictions', async () => {
    const existing = key('restricted-original'), original = 'restrict,command="/usr/bin/true" ' + existing + '\n', f = await fixture(original)
    await expect(f.service.addRootKey({ publicKey: existing, expectedRevision: f.initial.keys.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await f.executor.readFile(rootPath)).toBe(original)
    expect(await f.executor.readFile(indexPath)).toBeNull()
  })
  it('refuses removal of existing/fleet keys and permits only an exact managed-key removal', async () => {
    const f = await fixture(), added = key('managed-remove')
    await expect(f.service.removeManagedRootKey({ fingerprint: f.initial.keys.items[0]!.fingerprint, expectedRevision: f.initial.keys.revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const created = await f.service.addRootKey({ publicKey: added, expectedRevision: f.initial.keys.revision })
    await f.service.removeManagedRootKey({ fingerprint: fingerprint(added), expectedRevision: created.keys.revision })
    expect(await f.executor.readFile(rootPath)).toBe(f.original)
  })
  it('refuses removal of the last known key even when it is panel-managed', async () => {
    const f = await fixture(''), added = key('only-key')
    const created = await f.service.addRootKey({ publicKey: added, expectedRevision: f.initial.keys.revision })
    await expect(f.service.removeManagedRootKey({ fingerprint: fingerprint(added), expectedRevision: created.keys.revision })).rejects.toMatchObject({ code: 'SELF_LOCKOUT' })
    expect((await f.service.observeSsh()).keys.items).toHaveLength(1)
  })
  it('keeps opaque existing entries visible and blocks additions without changing their bytes', async () => {
    const f = await fixture('unrecognized-existing-entry\n')
    expect(f.initial.keys).toMatchObject({ state: 'partial', opaqueEntries: 1 })
    await expect(f.service.addRootKey({ publicKey: key('not-added'), expectedRevision: f.initial.keys.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.executor.readFile(rootPath)).toBe(f.original)
  })
  it('allows only one concurrent request to consume the same captured revision', async () => {
    const f = await fixture()
    const results = await Promise.allSettled([f.service.addRootKey({ publicKey: key('first'), expectedRevision: f.initial.keys.revision }), f.service.addRootKey({ publicKey: key('second'), expectedRevision: f.initial.keys.revision })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason.code)).toEqual(['CONFLICT'])
    expect((await f.service.observeSsh()).keys.items).toHaveLength(2)
  })
  it('restores exact ordinary-failure preimages and does not claim an applied key', async () => {
    const f = await fixture(); f.executor.failIndex = true
    await expect(f.service.addRootKey({ publicKey: key('rollback'), expectedRevision: f.initial.keys.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: expect.anything() })
    expect(await f.executor.readFile(rootPath)).toBe(f.original); expect(await f.executor.readFile(indexPath)).toBeNull(); expect(await f.executor.readFile(journalPath)).toBeNull()
  })
  it('preserves external changes on uncertain failure and locks further writes behind the retained intent', async () => {
    const f = await fixture(), external = f.original + key('external-after-write') + '\n'
    f.executor.failIndex = true; f.executor.externalDuringFailure = external
    await expect(f.service.addRootKey({ publicKey: key('unknown'), expectedRevision: f.initial.keys.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.executor.readFile(rootPath)).toBe(external); expect(await f.executor.readFile(journalPath)).not.toBeNull()
    expect((await f.service.observeSsh()).keys.state).toBe('review-required')
    await expect(f.service.addRootKey({ publicKey: key('not-retried'), expectedRevision: (await f.service.observeSsh()).keys.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.executor.readFile(rootPath)).toBe(external)
  })
  it('does not turn absent or malformed host outputs into successful empty observations', async () => {
    const executor = new FakeHostExecutor()
    executor.failCommand('/usr/sbin/sshd', 127); executor.failCommand('/usr/bin/journalctl', 127)
    const service = new SecurityObservationService({ executor, os, stateDir: '/var/lib/xpanel' })
    const value = await service.observeSsh()
    expect(value.policy.state).toBe('unavailable'); expect(value.failedLogins.state).toBe('unavailable')
  })
  it('validates full key wire fields and rejects authorized_keys options and extra data', () => {
    const valid = key('valid')
    expect(validateManagedSshPublicKey(valid).keyType).toBe('ssh-ed25519')
    for (const malformed of ['command="id" ' + valid, valid + '\n' + valid, valid.replace('ssh-ed25519 ', 'ssh-rsa '), valid.replace(valid.split(' ')[1]!, Buffer.from('incomplete').toString('base64')), valid + '\u202e']) expect(() => validateManagedSshPublicKey(malformed)).toThrow()
    expect(() => validateManagedSshPublicKey('REJECTED_TYPE_MARKER ' + valid.split(' ')[1])).toThrow(/^SSH public key format is invalid$/)
  })
  it('validates real generated EC points and refuses an off-curve point', () => {
    const fields = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]) }
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' })
    const validPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
    const ecKey = (point: Buffer) => 'ecdsa-sha2-nistp256 ' + Buffer.concat([fields(Buffer.from('ecdsa-sha2-nistp256')), fields(Buffer.from('nistp256')), fields(point)]).toString('base64')
    expect(validateManagedSshPublicKey(ecKey(validPoint)).keyType).toBe('ecdsa-sha2-nistp256')
    const invalidPoint = Buffer.alloc(65); invalidPoint[0] = 4
    expect(() => validateManagedSshPublicKey(ecKey(invalidPoint))).toThrow('SSH elliptic-curve point is invalid')
  })
  it('parses multiple configured ports and refuses ambiguous or incomplete effective policy', () => {
    const output = 'port 22\nport 2222\npubkeyauthentication yes\npasswordauthentication no\npermitrootlogin prohibit-password\n'
    expect(parseSshEffectivePolicy(output).port).toBe('22 2222')
    expect(() => parseSshEffectivePolicy(output + 'passwordauthentication yes\n')).toThrow()
    expect(() => parseSshEffectivePolicy('port 22\n')).toThrow()
  })
  it('never trusts forged tenant/syslog metadata and supports actual none/preauth failure events', () => {
    const data = [failure(), failure({ _SYSTEMD_UNIT: 'user@20000.service' }), failure({ _EXE: '/usr/bin/logger' }), failure({ _UID: '20000' }), failure({ MESSAGE: 'Failed none for admin from 2001:db8::1 port 50 ssh2 [preauth]' })].join('\n')
    expect(parseSshFailedLogins(data, 'ssh.service').map(item => item.method)).toEqual(['password', 'none'])
    expect(() => parseSshFailedLogins('not-json', 'ssh.service')).toThrow()
  })
})
