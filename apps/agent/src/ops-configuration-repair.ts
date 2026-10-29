import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { RenderedFile } from '@xpanel/core'
import type { ConfigurationHealthRepairProvider } from './configuration-health.ts'
import type { OwnedFileEntry } from './reconciler-journal.ts'
import { sha256Text } from './reconciler-journal.ts'

export interface ConfigurationFileMeta { mode: number; owner: string; group: string }
export interface ConfigurationRepairPorts {
  /** The reconciler's own exclusion: withLifecycleWriterAdmission(() => withGenerationReconciliationLease(stateRoot, work)). */
  lease: <T>(work: () => Promise<T>) => Promise<T>
  /** Owned manifest entry of the active generation; null when the path is not owned by it. */
  manifestEntry: (generationId: number, path: string) => Promise<OwnedFileEntry | null>
  /** Files compiled from the saved desired state; equal to the generation only while nothing is pending. */
  renderFiles: () => Promise<readonly RenderedFile[]>
  readFile: (path: string) => Promise<string | null>
  readMeta: (path: string) => Promise<ConfigurationFileMeta | null>
  /** Atomic write with the rendered mode and ownership (executor.writeFile). */
  writeFile: (file: RenderedFile) => Promise<void>
  removeFile: (path: string) => Promise<void>
  /** Every reviewed server configuration test; true only when all pass. */
  runTests: () => Promise<boolean>
  /** executor.runAction(rollbackReloadAction(unit)) followed by the reconciler unit health check. */
  reloadUnit: (unit: string) => Promise<boolean>
  /** Root-only directory for durable preimage records (0700). */
  recoveryDir: string
  now?: () => Date
}
export interface ConfigurationRepairRecord {
  schemaVersion: 1; id: string; createdAt: string; generationId: number; path: string; expectedChecksum: string
  existed: boolean; preimage: string | null; preimageChecksum: string | null; preimageMeta: ConfigurationFileMeta | null
  state: 'prepared' | 'rolled_back' | 'rollback_failed'
}

const unchanged = { stateChanged: false }
const unknown = { stateChanged: true, unknownOutcome: true, verificationRequired: true }
const recordsDir = (ports: ConfigurationRepairPorts): string => join(ports.recoveryDir, 'configuration')
const sameMeta = (left: ConfigurationFileMeta | null, right: ConfigurationFileMeta | null): boolean => !!left && !!right && left.mode === right.mode && left.owner === right.owner && left.group === right.group

async function writeRecord(ports: ConfigurationRepairPorts, record: ConfigurationRepairRecord): Promise<void> {
  await mkdir(recordsDir(ports), { recursive: true, mode: 0o700 })
  const path = join(recordsDir(ports), record.id + '.json'), temporary = path + '.' + randomUUID() + '.tmp'
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(record), 'utf8'); await handle.sync() } finally { await handle.close() }
  await rename(temporary, path)
}

/** passwd(5)/group(5): name:x:id:...; the first entry for an id wins, as getpwuid(3) does. */
export const idNames = (text: string): Map<number, string> => {
  const names = new Map<number, string>()
  for (const line of text.split('\n')) {
    const [name, , id] = line.split(':')
    if (name && /^[a-z_][a-z0-9_.-]{0,31}\$?$/i.test(name) && id !== undefined && /^[0-9]{1,10}$/.test(id) && !names.has(Number(id))) names.set(Number(id), name)
  }
  return names
}
/** Native metadata reader for the provider: mode bits and owner/group names of a regular file, never a symlink. */
export async function nativeConfigurationFileMeta(path: string): Promise<ConfigurationFileMeta | null> {
  let info
  try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!info.isFile()) return fail('PRECONDITION_FAILED', 'a managed configuration path is not a regular file', unchanged)
  const owner = idNames(await readFile('/etc/passwd', 'utf8')).get(info.uid), group = idNames(await readFile('/etc/group', 'utf8')).get(info.gid)
  if (!owner || !group) return fail('PRECONDITION_FAILED', 'managed configuration ownership could not be resolved', unchanged)
  return { mode: info.mode & 0o7777, owner, group }
}

/** Records left by an interrupted repair. A restart never claims their rollback ran; an operator reviews each one. */
export async function readRetainedConfigurationRepairs(ports: Pick<ConfigurationRepairPorts, 'recoveryDir'>): Promise<ConfigurationRepairRecord[]> {
  let names: string[]
  try { names = await readdir(recordsDir(ports as ConfigurationRepairPorts)) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  const records: ConfigurationRepairRecord[] = []
  for (const name of names.filter(item => /^[0-9a-f-]{36}\.json$/.test(item)).sort().slice(0, 100)) records.push(JSON.parse(await readFile(join(recordsDir(ports as ConfigurationRepairPorts), name), 'utf8')) as ConfigurationRepairRecord)
  return records
}

/**
 * Physical targeted repair: one owned file is rewritten to its generation bytes and metadata, its dependent units
 * reload, and every reviewed test passes, or the durable preimage is restored and the outcome reported unknown.
 */
export function createConfigurationRepairProvider(ports: ConfigurationRepairPorts): ConfigurationHealthRepairProvider {
  const leased = async <T>(work: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> => ports.lease(async () => {
    let open = true
    try { return await work(async () => { if (!open) return fail('CONFLICT', 'the configuration lease was released', unchanged) }) } finally { open = false }
  })
  return {
    withLease: leased,
    repairTarget: async ({ generation, target, authorize, assertHeld }) => {
      // A record whose file now holds exactly its preimage or its generation bytes describes a settled outcome.
      for (const retained of await readRetainedConfigurationRepairs(ports)) {
        const current = await ports.readFile(retained.path), checksum = current === null ? null : sha256Text(current)
        if (checksum !== retained.expectedChecksum && checksum !== retained.preimageChecksum) return fail('PRECONDITION_FAILED', 'an earlier configuration repair record requires review', unchanged)
        await unlink(join(recordsDir(ports), retained.id + '.json'))
      }
      await authorize(); await assertHeld()
      const entry = await ports.manifestEntry(generation.id, target.path)
      if (!entry || entry.sha256 !== target.expectedChecksum) return fail('CONFLICT', 'the repair target is not owned by the active generation', unchanged)
      const rendered = (await ports.renderFiles()).find(file => file.path === target.path)
      if (!rendered || sha256Text(rendered.content) !== entry.sha256 || rendered.mode !== entry.mode || (rendered.owner ?? 'root') !== entry.owner || (rendered.group ?? 'root') !== entry.group) return fail('CONFLICT', 'saved settings no longer render the generation file; reconcile instead', unchanged)
      const expectedMeta: ConfigurationFileMeta = { mode: entry.mode, owner: entry.owner, group: entry.group }
      const preimage = await ports.readFile(target.path), preimageMeta = preimage === null ? null : await ports.readMeta(target.path)
      const observed = preimage === null ? null : sha256Text(preimage)
      if (observed !== target.observedChecksum || preimage !== null && !preimageMeta) return fail('CONFLICT', 'the drifted file changed before its preimage was captured', unchanged)
      const record: ConfigurationRepairRecord = { schemaVersion: 1, id: randomUUID(), createdAt: (ports.now?.() ?? new Date()).toISOString(), generationId: generation.id, path: target.path, expectedChecksum: entry.sha256, existed: preimage !== null, preimage, preimageChecksum: observed, preimageMeta, state: 'prepared' }
      await writeRecord(ports, record)
      const recordPath = join(recordsDir(ports), record.id + '.json')
      const saved = JSON.parse(await readFile(recordPath, 'utf8')) as ConfigurationRepairRecord
      if (saved.preimage !== preimage || (saved.preimage === null ? null : sha256Text(saved.preimage)) !== observed) return fail('PRECONDITION_FAILED', 'the configuration preimage could not be verified', unchanged)

      const rollback = async (): Promise<never> => {
        let restored = false
        try {
          if (record.existed) await ports.writeFile({ path: target.path, content: record.preimage!, mode: record.preimageMeta!.mode, owner: record.preimageMeta!.owner, group: record.preimageMeta!.group })
          else await ports.removeFile(target.path)
          const back = await ports.readFile(target.path)
          restored = record.existed ? back !== null && sha256Text(back) === record.preimageChecksum && sameMeta(await ports.readMeta(target.path), record.preimageMeta) : back === null
          for (const unit of entry.dependentUnits) restored = await ports.reloadUnit(unit) && restored
        } catch { restored = false }
        await writeRecord(ports, { ...record, state: restored ? 'rolled_back' : 'rollback_failed' })
        if (restored) await unlink(recordPath)
        return fail('SERVICE_UNAVAILABLE', restored ? 'the configuration repair was rolled back after a failed check' : 'the configuration repair and its rollback require review', { ...unknown, rolledBack: restored })
      }
      try {
        await authorize(); await assertHeld()
        await ports.writeFile(rendered)
      } catch { return rollback() }
      let verified = false
      try {
        const after = await ports.readFile(target.path)
        verified = after !== null && sha256Text(after) === entry.sha256 && sameMeta(await ports.readMeta(target.path), expectedMeta) && await ports.runTests()
        for (const unit of entry.dependentUnits) if (verified) verified = await ports.reloadUnit(unit)
        if (verified) { await assertHeld(); await authorize() }
      } catch { verified = false }
      if (!verified) return rollback()
      await unlink(recordPath)
      return { recoveryVerified: true }
    },
  }
}
