import { describe, expect, it, vi } from 'vitest'
import {
  applyFileSharingConfig, isShareHost, isSharePath, observeFileSharing, parseEtabPaths, parseManagedExports, parseShareConfig, renderManagedExports, shareConfigRevision,
} from './ops-file-sharing.ts'
import type { FileSharingNativeProvider, ShareConfig } from './ops-file-sharing.ts'

const client = (host: string, extra: Partial<{ permission: 'ro' | 'rw'; squashRoot: boolean; subtreeCheck: boolean }> = {}) => ({ host, permission: extra.permission ?? 'rw', squashRoot: extra.squashRoot ?? true, subtreeCheck: extra.subtreeCheck ?? true })
const config = (): ShareConfig => ({ shares: [
  { id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [client('10.0.0.0/24', { permission: 'rw' }), client('192.168.1.5', { permission: 'ro', squashRoot: false })] },
  { id: 'shr_' + 'b'.repeat(16), path: '/home/alice/public', clients: [client('backup.local.test', { subtreeCheck: false })] },
] })

describe('share grammar', () => {
  it('accepts managed paths and documented host specs and rejects everything else', () => {
    expect(isSharePath('/srv/shares/x')).toBe(true); expect(isSharePath('/home/a/b')).toBe(true)
    for (const bad of ['/etc/passwd', '/srv/shares/', '/home/', '/srv/shares/a/../b', '/srv/shares//x', '/srv/shares/x/', '/srv/shares/x y', '/srv/shares/x\u0000']) expect(isSharePath(bad)).toBe(false)
    for (const good of ['*', '10.0.0.0/24', '192.168.1.5', 'host.local.test', '*.local.test']) expect(isShareHost(good)).toBe(true)
    for (const bad of ['', '10.0.0.0/33', '999.1.1.1', 'a b', '*.', 'under_score.test', 'x'.repeat(256)]) expect(isShareHost(bad)).toBe(false)
  })
  it('parses a bounded config and rejects duplicates, unknown keys and over-limit lists', () => {
    expect(parseShareConfig(config()).shares).toHaveLength(2)
    const mutate = (change: (value: { shares: unknown[] }) => void) => { const value = JSON.parse(JSON.stringify(config())); change(value); return () => parseShareConfig(value) }
    expect(mutate(value => { (value.shares[0] as { path: string }).path = '/etc/x' })).toThrow()
    expect(mutate(value => { value.shares[1] = value.shares[0] })).toThrow()
    expect(mutate(value => { (value.shares[0] as Record<string, unknown>).extra = 1 })).toThrow()
    expect(mutate(value => { (value.shares[0] as { clients: unknown[] }).clients = [] })).toThrow()
    expect(() => parseShareConfig({ shares: Array.from({ length: 201 }, (_, index) => ({ id: 'shr_' + String(index).padStart(16, '0'), path: '/srv/shares/s' + index, clients: [client('*')] })) })).toThrow()
    expect(() => parseShareConfig({ shares: [], extra: true })).toThrow()
  })
  it('renders canonical exports and round-trips to the same revision', () => {
    const text = renderManagedExports(config())
    expect(text).toContain('"/home/alice/public" backup.local.test(rw,no_subtree_check,root_squash,sync)')
    expect(text).toContain('"/srv/shares/team" 10.0.0.0/24(rw,subtree_check,root_squash,sync) 192.168.1.5(ro,subtree_check,no_root_squash,sync)')
    expect(shareConfigRevision(parseManagedExports(text))).toBe(shareConfigRevision(config()))
    expect(shareConfigRevision(parseManagedExports(null)).length).toBe(64)
    expect(parseManagedExports('garbage line').shares).toHaveLength(0)
    expect(parseManagedExports('"/etc/x" *(rw,sync)').shares).toHaveLength(0)
  })
  it('reads exported directories from etab', () => {
    expect([...parseEtabPaths('"/srv/shares/team"\t10.0.0.0/24(...)\n/home/alice/public\tbackup(...)\n# comment\n')]).toEqual(['/srv/shares/team', '/home/alice/public'])
  })
})

const provider = (overrides: Partial<FileSharingNativeProvider> & { managed?: string | null; etab?: string } = {}): FileSharingNativeProvider & { managed: string | null; etab: string } => {
  const state = { managed: overrides.managed ?? null, etab: overrides.etab ?? '' }
  return Object.assign(state, {
    readManaged: async () => state.managed,
    readEtab: async () => overrides.readEtab ? overrides.readEtab() : state.etab,
    writeManaged: overrides.writeManaged ?? (async (content: string, beforeCommit: () => Promise<void>) => { await beforeCommit(); state.managed = content }),
    removeManaged: overrides.removeManaged ?? (async () => { state.managed = null }),
    reexport: overrides.reexport ?? (async () => { state.etab = state.managed ? parseExpectedEtab(state.managed) : ''; return true }),
  })
}
const parseExpectedEtab = (managed: string): string => parseManagedExports(managed).shares.map(share => '"' + share.path + '"\t*(rw)').join('\n') + '\n'

describe('file sharing observation and apply', () => {
  it('reports export state per configured share and lists foreign exports truthfully', async () => {
    const io = provider({ managed: renderManagedExports(config()), etab: '"/srv/shares/team"\t*(rw)\n/data\tadmin(rw)\n' })
    const observed = await observeFileSharing(config(), io)
    expect(observed.state).toBe('read')
    expect(observed.shares.map(share => share.exportState)).toEqual(['exported', 'not-exported'])
    expect(observed.foreignExports).toEqual(['/data'])
    expect((await observeFileSharing(config(), null)).reason).toBe('nfs_server_unavailable')
    expect((await observeFileSharing(config(), provider({ readEtab: async () => null }))).reason).toBe('nfs_server_unavailable')
  })
  it('writes the managed file, re-exports and verifies against the kernel table', async () => {
    const io = provider({ etab: '\n' })
    const active = shareConfigRevision(parseManagedExports(null))
    const result = await applyFileSharingConfig(config(), active, io, async () => {})
    expect(result.appliedRevision).toBe(shareConfigRevision(config()))
    expect(io.managed).toBe(renderManagedExports(config()))
    expect(result.active.shares.every(share => share.exportState === 'exported')).toBe(true)
  })
  it('refuses a stale active revision and the absent NFS server without writing', async () => {
    const io = provider({ etab: '\n' })
    io.writeManaged = vi.fn(io.writeManaged)
    await expect(applyFileSharingConfig(config(), 'f'.repeat(64), io, async () => {})).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(io.writeManaged).not.toHaveBeenCalled()
    await expect(applyFileSharingConfig(config(), 'a'.repeat(64), null, async () => {})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('removes the managed file for an empty configuration', async () => {
    const io = provider({ managed: renderManagedExports(config()), etab: parseExpectedEtab(renderManagedExports(config())) })
    const active = shareConfigRevision(config())
    await applyFileSharingConfig({ shares: [] }, active, io, async () => {})
    expect(io.managed).toBeNull()
  })
  it('restores the exact preimage when re-export or verification fails', async () => {
    const before = renderManagedExports(config())
    const io = provider({ managed: before, etab: parseExpectedEtab(before) })
    // The new content fails to re-export; restoring the preimage re-exports cleanly.
    io.reexport = async () => { if (io.managed === before) { io.etab = parseExpectedEtab(before); return true } return false }
    const active = shareConfigRevision(config())
    const next: ShareConfig = { shares: [{ id: 'shr_' + 'c'.repeat(16), path: '/srv/shares/new', clients: [client('*')] }] }
    await expect(applyFileSharingConfig(next, active, io, async () => {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { rolledBack: true, stateChanged: false } })
    expect(io.managed).toBe(before)
  })
  it('reports an unknown outcome when the rollback itself cannot be verified', async () => {
    const before = renderManagedExports(config())
    let writes = 0
    const io = provider({ managed: before, etab: parseExpectedEtab(before), writeManaged: async (content: string, beforeCommit: () => Promise<void>) => { await beforeCommit(); io.managed = content }, reexport: async () => { if (++writes >= 1) return false; return true } })
    const active = shareConfigRevision(config())
    const next: ShareConfig = { shares: [{ id: 'shr_' + 'd'.repeat(16), path: '/srv/shares/new', clients: [client('*')] }] }
    await expect(applyFileSharingConfig(next, active, io, async () => {})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
  })
})
