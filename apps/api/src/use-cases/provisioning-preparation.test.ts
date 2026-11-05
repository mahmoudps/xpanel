import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod, symlink, unlink, rename, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileProvisioningPreparationStore } from './provisioning-preparation.ts'

const PHC = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const roots: string[] = []
const posix = process.platform === 'linux'
const locked = <T>(work: () => Promise<T>): Promise<T> => work()
const request = () => ({ actorKey: 'root:operator', idempotencyKey: 'account-request-1', requestIdentity: 'a'.repeat(64),
  credentialIntent: 'plaintext-never-persisted', preparePasswordHash: vi.fn(async () => PHC),
  // The port wiring is tested without expensive hashing. Runtime must supply its Argon2 verifier.
  verifyCredentialIntent: vi.fn(async (intent: string, hash: string) => intent === 'plaintext-never-persisted' && hash === PHC),
  prepareDesiredState: vi.fn(async () => ({ planId: 'plan', templateId: 'template', revision: 7, records: [{ name: 'www', content: '192.0.2.4' }] })) })
const harness = async () => {
  // The production authority deliberately rejects world-writable /tmp ancestry.
  const root = await mkdtemp(join(homedir(), '.xpanel-preparation-test-'))
  roots.push(root)
  await chmod(root, 0o700)
  const directory = join(root, 'private', 'provisioning')
  const store = new FileProvisioningPreparationStore({ directory, withLock: locked })
  return { root, directory, store }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(homedir(), '.xpanel-preparation-test-'))) throw new Error('unexpected test cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})

describe('private provisioning authority portability and input admission', { tags: ['unit'] }, () => {
  it('rejects a noncanonical operator directory before any callback', () => {
    expect(() => new FileProvisioningPreparationStore({ directory: 'relative/credentials', withLock: locked })).toThrow('absolute canonical')
  })

  it('rejects malformed public request keys without preparing a credential', async () => {
    const input = request(), store = new FileProvisioningPreparationStore({ directory: join(homedir(), '.unused-preparation-authority'), withLock: locked })
    await expect(store.prepare({ ...input, idempotencyKey: '../escape' })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(input.preparePasswordHash).not.toHaveBeenCalled()
    expect(input.prepareDesiredState).not.toHaveBeenCalled()
  })

  it.skipIf(posix)('fails closed where POSIX ownership and modes cannot be verified', async () => {
    const input = request(), store = new FileProvisioningPreparationStore({ directory: join(homedir(), '.unused-preparation-authority'), withLock: locked })
    await expect(store.prepare(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'private_filesystem_not_supported' } })
    expect(input.preparePasswordHash).not.toHaveBeenCalled()
    expect(input.prepareDesiredState).not.toHaveBeenCalled()
  })
})

describe('trusted state ancestor configuration', { tags: ['unit'] }, () => {
  it.each(['relative', 'outside', 'same-directory', 'uid', 'gid'])('rejects malformed %s startup trust without filesystem access', kind => {
    const root = join(homedir(), '.unused-preparation-root'), directory = join(root, 'private', 'provisioning')
    const trusted = { directory: root, uid: 0, gid: 0 }
    if (kind === 'relative') trusted.directory = 'relative/root'
    if (kind === 'outside') trusted.directory = join(homedir(), '.other-preparation-root')
    if (kind === 'same-directory') trusted.directory = directory
    if (kind === 'uid') trusted.uid = -1
    if (kind === 'gid') trusted.gid = 0.5
    expect(() => new FileProvisioningPreparationStore({ directory, trustedStateRoot: trusted, withLock: locked })).toThrow('canonical trusted state ancestor')
  })
})

describe.skipIf(!posix)('exact API service state ancestor trust', { tags: ['feature'] }, () => {
  const shared = async () => {
    const h = await harness(), stateRoot = join(h.root, 'state'), directory = join(stateRoot, 'private', 'account-provisioning')
    await mkdir(stateRoot, { mode: 0o700 })
    await chmod(stateRoot, 0o2770)
    const trustedStateRoot = { directory: stateRoot, uid: process.getuid!(), gid: process.getgid!() }
    const store = new FileProvisioningPreparationStore({ directory, trustedStateRoot, withLock: locked })
    return { ...h, stateRoot, directory, trustedStateRoot, store }
  }

  it('admits only the exact configured service root and creates private children without inherited SGID', async () => {
    const h = await shared(), input = request(), saved = await h.store.prepare(input)
    expect((await lstat(h.stateRoot)).mode & 0o7777).toBe(0o2770)
    expect((await lstat(join(h.stateRoot, 'private'))).mode & 0o7777).toBe(0o700)
    expect((await lstat(h.directory)).mode & 0o7777).toBe(0o700)
    expect(await h.store.load(saved.reference, input.actorKey)).toEqual(saved)
  })

  it('keeps the default constructor closed to that group-writable root', async () => {
    const h = await shared(), input = request()
    const strict = new FileProvisioningPreparationStore({ directory: h.directory, withLock: locked })
    await expect(strict.prepare(input)).rejects.toMatchObject({ detail: { reason: 'private_directory_untrusted' } })
    expect(input.preparePasswordHash).not.toHaveBeenCalled()
  })

  it('admits a carried-over SGID-inherited private leaf with empty group bits', async () => {
    const h = await shared(), input = request()
    await mkdir(join(h.stateRoot, 'private'), { mode: 0o700 })
    await chmod(join(h.stateRoot, 'private'), 0o700)
    await mkdir(h.directory, { mode: 0o700 })
    await chmod(h.directory, 0o2700)
    const saved = await h.store.prepare(input)
    expect((await lstat(h.directory)).mode & 0o7777).toBe(0o2700)
    expect(await h.store.load(saved.reference, input.actorKey)).toEqual(saved)
  })

  it('admits the narrowed 02750 installed data root produced by protected startup', async () => {
    const h = await shared(), input = request()
    await chmod(h.stateRoot, 0o2750)
    const saved = await h.store.prepare(input)
    expect(await h.store.load(saved.reference, input.actorKey)).toEqual(saved)
  })

  it.each(['path', 'uid', 'gid', 'mode', 'symlink'])('rejects a %s mismatch instead of broadening ancestor trust', async kind => {
    const h = await shared(), input = request(), trusted = { ...h.trustedStateRoot }
    if (kind === 'path') trusted.directory = h.root
    if (kind === 'uid') trusted.uid++
    if (kind === 'gid') trusted.gid++
    if (kind === 'mode') await chmod(h.stateRoot, 0o0770)
    if (kind === 'symlink') {
      const original = `${h.stateRoot}-original`
      await rename(h.stateRoot, original)
      await symlink(original, h.stateRoot, 'dir')
    }
    const store = new FileProvisioningPreparationStore({ directory: h.directory, trustedStateRoot: trusted, withLock: locked })
    await expect(store.prepare(input)).rejects.toMatchObject({ detail: { reason: 'private_directory_untrusted' } })
    expect(input.preparePasswordHash).not.toHaveBeenCalled()
  })

  it.each(['private-leaf', 'state-parent'])('detects replacement of the %s before issuing any credential', async kind => {
    const h = await shared(), input = request()
    input.prepareDesiredState.mockImplementationOnce(async () => {
      if (kind === 'private-leaf') {
        await rename(h.directory, `${h.directory}-preserved`)
        await mkdir(h.directory, { mode: 0o700 })
      } else {
        const old = `${h.stateRoot}-preserved`
        await rename(h.stateRoot, old)
        await mkdir(h.stateRoot, { mode: 0o700 })
        await chmod(h.stateRoot, 0o2770)
        await rename(join(old, 'private'), join(h.stateRoot, 'private'))
      }
      return { planId: 'plan', templateId: 'template', revision: 7, records: [{ name: 'www', content: '192.0.2.4' }] }
    })
    await expect(h.store.prepare(input)).rejects.toMatchObject({ detail: { reason: 'private_directory_changed' } })
    expect(input.preparePasswordHash).not.toHaveBeenCalled()
  })
})

describe.skipIf(!posix)('POSIX private provisioning authority persistence', { tags: ['feature'] }, () => {
  it('reuses exact prepared credentials and desired state after reopening without hashing or resolving again', async () => {
    const h = await harness(), first = request()
    const saved = await h.store.prepare(first)
    const reopened = new FileProvisioningPreparationStore({ directory: h.directory, withLock: locked }), replay = request()
    replay.preparePasswordHash.mockRejectedValue(new Error('must not rehash'))
    replay.prepareDesiredState.mockResolvedValue({ planId: 'changed', templateId: 'changed', revision: 99, records: [] })
    expect(await reopened.prepare(replay)).toEqual(saved)
    expect(replay.preparePasswordHash).not.toHaveBeenCalled()
    expect(replay.prepareDesiredState).not.toHaveBeenCalled()
    expect(await reopened.load(saved.reference, first.actorKey)).toEqual(saved)
    const persisted = (await Promise.all((await readdir(h.directory)).map(file => readFile(join(h.directory, file), 'utf8')))).join('\n')
    expect(persisted).not.toContain(first.credentialIntent)
    expect(persisted).not.toContain(first.idempotencyKey)
    expect(persisted).not.toContain('intentMac')
  })

  it('rejects changed credentials or public input without replacing the first preparation', async () => {
    const h = await harness(), first = request(), saved = await h.store.prepare(first)
    const changed = request()
    await expect(h.store.prepare({ ...changed, credentialIntent: 'a different password' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(h.store.prepare({ ...changed, requestIdentity: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(changed.preparePasswordHash).not.toHaveBeenCalled()
    expect(await h.store.load(saved.reference, first.actorKey)).toEqual(saved)
  })

  it('records the credential of each verified request beside the unchanged preparation', async () => {
    const h = await harness(), first = request()
    const saved = await h.store.prepare({ ...first, currentAuthorization: { session: 'first' } })
    expect(saved.currentAuthorization).toEqual({ session: 'first' })
    await expect(h.store.prepare({ ...request(), credentialIntent: 'a different password', currentAuthorization: { session: 'forged' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await h.store.load(saved.reference, first.actorKey)).currentAuthorization).toEqual({ session: 'first' })
    const retried = await h.store.prepare({ ...request(), currentAuthorization: { session: 'retry' } })
    expect(retried).toEqual({ ...saved, currentAuthorization: { session: 'retry' } })
    expect((await h.store.load(saved.reference, first.actorKey)).currentAuthorization).toEqual({ session: 'retry' })
    expect((await lstat(join(h.directory, saved.reference + '.authorization.json'))).mode & 0o777).toBe(0o600)
  })

  it('refuses an unacknowledged credential hashing outcome rather than silently rehashing it', async () => {
    const h = await harness(), first = request()
    first.preparePasswordHash.mockRejectedValue(new Error('sensitive-credential-must-not-appear'))
    await expect(h.store.prepare(first)).rejects.toMatchObject({ detail: { reason: 'reserved_credential_outcome_unknown' } })
    const next = request()
    await expect(h.store.prepare(next)).rejects.toMatchObject({ detail: { reason: 'reserved_credential_outcome_unknown' } })
    expect(next.preparePasswordHash).not.toHaveBeenCalled()
    expect(next.prepareDesiredState).not.toHaveBeenCalled()
  })

  it('does not issue a preparation on invalid PHC output and never includes it in an error', async () => {
    const h = await harness(), input = request()
    input.preparePasswordHash.mockResolvedValue('invalid-secret-value')
    let thrown: unknown
    try { await h.store.prepare(input) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(JSON.stringify(thrown)).not.toContain('invalid-secret-value')
  })

  it('requires the first prepared credential to match its intent through the trusted verifier', async () => {
    const h = await harness(), input = request()
    input.verifyCredentialIntent.mockResolvedValue(false)
    await expect(h.store.prepare(input)).rejects.toMatchObject({ detail: { reason: 'prepared_credential_intent_mismatch' } })
    const files = await readdir(h.directory)
    expect(files.some(file => /^[0-9a-f-]{36}\.json$/.test(file))).toBe(false)
    expect(input.verifyCredentialIntent).toHaveBeenCalledWith(input.credentialIntent, PHC)
  })

  it('does not expose a saved credential when the replay verifier is unavailable', async () => {
    const h = await harness(), first = request()
    await h.store.prepare(first)
    const replay = request()
    replay.verifyCredentialIntent.mockRejectedValue(new Error('sensitive input must not escape'))
    await expect(h.store.prepare(replay)).rejects.toMatchObject({ detail: { reason: 'credential_verification_unavailable' } })
    expect(replay.preparePasswordHash).not.toHaveBeenCalled()
  })

  it('refuses missing namespace keys instead of rotating operation identity and hashing again', async () => {
    const h = await harness(), first = request()
    await h.store.prepare(first)
    await unlink(join(h.directory, 'namespace-hmac.key'))
    const replay = request()
    await expect(h.store.prepare(replay)).rejects.toMatchObject({ detail: { reason: 'private_namespace_key_missing' } })
    expect(replay.preparePasswordHash).not.toHaveBeenCalled()
    expect(replay.prepareDesiredState).not.toHaveBeenCalled()
  })

  it('rejects cross-actor loading and distinct actors receive distinct operation identities', async () => {
    const h = await harness(), first = request(), saved = await h.store.prepare(first)
    await expect(h.store.load(saved.reference, 'reseller:other')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const other = await h.store.prepare({ ...request(), actorKey: 'reseller:other' })
    expect(other.reference).not.toBe(saved.reference)
  })

  it('detects modified desired-state bytes before returning a credential', async () => {
    const h = await harness(), first = request(), saved = await h.store.prepare(first)
    const file = join(h.directory, saved.reference + '.json'), value = JSON.parse(await readFile(file, 'utf8'))
    value.desiredState.revision++
    await writeFile(file, JSON.stringify(value), { mode: 0o600 })
    await expect(h.store.load(saved.reference, first.actorKey)).rejects.toMatchObject({ detail: { reason: 'private_preparation_binding_invalid' } })
  })

  it('refuses writable or symlinked authority roots and leaves the target untouched', async () => {
    const h = await harness(), first = request()
    await mkdir(h.directory, { recursive: true, mode: 0o700 })
    await chmod(h.directory, 0o770)
    await expect(h.store.prepare(first)).rejects.toMatchObject({ detail: { reason: 'private_directory_untrusted' } })
    expect(await readdir(h.directory)).toEqual([])
    const link = join(h.root, 'linked-' + randomUUID())
    await symlink(h.directory, link)
    const linked = new FileProvisioningPreparationStore({ directory: link, withLock: locked })
    await expect(linked.prepare(first)).rejects.toMatchObject({ detail: { reason: 'private_directory_untrusted' } })
    expect(first.preparePasswordHash).not.toHaveBeenCalled()
  })
})
