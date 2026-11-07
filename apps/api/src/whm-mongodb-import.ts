import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { MONGO_UPLOAD_DIR } from '../../agent/src/db-mongodb-service.ts'
import { readPanelConfigBody } from './panel-config-file.ts'
import { CPANEL_UPLOAD_CHUNK_BYTES } from './transfer-workspace.ts'

/**
 * MongoDB import upload: the panel's chunked path, as for a cPanel archive. Chunks land in the API's state folder,
 * and the agent proves the finished file and takes it into the root-only backup directory.
 * shortcut: one upload at a time, held in memory; an API restart asks the browser to send the file again.
 */
const MAX_BYTES = 20 * 1024 ** 3
const unchanged = { stateChanged: false }
interface Upload { id: string; filename: string; bytes: number }
let active: Upload | null = null
const directory = (store: Pick<StateStore, 'rootDir'>): string => join(store.rootDir, MONGO_UPLOAD_DIR)

export async function startMongodbUpload(request: Request, store: Pick<StateStore, 'rootDir'>): Promise<{ id: string; chunkBytes: number }> {
  const body = await readPanelConfigBody(request), { filename, bytes } = body
  if (typeof filename !== 'string' || filename.length < 1 || filename.length > 255 || !/\.gz$/i.test(filename)) return fail('VALIDATION', 'choose a .archive.gz file', { ...unchanged, reason: 'mongodb_archive_rejected' })
  if (!Number.isSafeInteger(bytes) || (bytes as number) < 1 || (bytes as number) > MAX_BYTES) return fail('VALIDATION', 'the file size is not accepted', { ...unchanged, reason: 'mongodb_import_too_large' })
  const dir = directory(store)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  const free = await statfs(dir)
  if (free.bavail * free.bsize < (bytes as number) * 2) return fail('PRECONDITION_FAILED', 'there is not enough free disk space for this file', { ...unchanged, reason: 'mongodb_import_no_space' })
  // A new upload replaces one that stopped halfway, so nothing piles up in the state folder.
  for (const name of await readdir(dir)) await unlink(join(dir, name)).catch(() => undefined)
  active = { id: randomUUID(), filename, bytes: bytes as number }
  return { id: active.id, chunkBytes: CPANEL_UPLOAD_CHUNK_BYTES }
}

export async function storeMongodbChunk(request: Request, id: string, store: Pick<StateStore, 'rootDir'>, adopt: (upload: Upload) => Promise<unknown>): Promise<Record<string, unknown>> {
  const upload = active
  if (!upload || upload.id !== id) return fail('NOT_FOUND', 'this upload is no longer open; send the file again', { ...unchanged, reason: 'mongodb_import_expired' })
  const body = await readPanelConfigBody(request, 2 * CPANEL_UPLOAD_CHUNK_BYTES), { offset, data } = body
  if (typeof data !== 'string' || data.length > Math.ceil(CPANEL_UPLOAD_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return fail('VALIDATION', 'the chunk must be base64', unchanged)
  const chunk = Buffer.from(data, 'base64')
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !chunk.length || (offset as number) + chunk.length > upload.bytes) return fail('VALIDATION', 'the chunk does not fit the file', unchanged)
  const partial = join(directory(store), `${id}.part`), output = await open(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o640)
  try {
    const size = (await output.stat()).size
    if (size !== offset) return fail('CONFLICT', `the upload continues at ${size} bytes`, { ...unchanged, received: size })
    let written = 0
    while (written < chunk.length) written += (await output.write(chunk.subarray(written))).bytesWritten
    await output.sync()
  } finally { await output.close() }
  const received = (offset as number) + chunk.length
  if (received < upload.bytes) return { received, complete: false }
  active = null
  await rename(partial, join(directory(store), `${id}.archive.gz`))
  return { received, complete: true, backup: await adopt(upload) }
}
