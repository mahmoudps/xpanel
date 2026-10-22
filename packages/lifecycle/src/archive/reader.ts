import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { extract as tarExtract } from 'tar-stream'
import { XpanelError, fail, isXpanelError } from '@xpanel/core'
import { ArchiveGuard } from './guard.ts'
import type { GuardOptions, SafeEntry, SkippedEntry } from './guard.ts'

export type ByteSource = AsyncIterable<Uint8Array>
export type Body = AsyncIterable<Buffer>
type Visitor = (entry: SafeEntry, body: Body) => Promise<void>

interface WalkOptions extends Partial<GuardOptions> {
  /** sees every skipped entry (the summary keeps only the first ones) */
  onSkip?: (skipped: SkippedEntry) => void
}

interface WalkSummary {
  entries: number
  bytes: number
  /** first skipped entries, capped */
  skipped: SkippedEntry[]
  skippedTotal: number
}

const MAX_SKIPPED_REPORTED = 1000

const concatHead = async (it: AsyncIterator<Uint8Array>): Promise<{ head: Buffer; done: boolean }> => {
  const parts: Buffer[] = []
  let len = 0
  for (;;) {
    const n = await it.next()
    if (n.done) return { head: Buffer.concat(parts), done: true }
    parts.push(Buffer.from(n.value))
    len += n.value.length
    if (len >= 2) return { head: Buffer.concat(parts), done: false }
  }
}

async function* replay(head: Buffer, it: AsyncIterator<Uint8Array>, done: boolean): AsyncGenerator<Buffer> {
  if (head.length) yield head
  if (done) return
  for (;;) {
    const n = await it.next()
    if (n.done) return
    yield Buffer.from(n.value)
  }
}

export const drain = async (body: Body): Promise<void> => {
  for await (const chunk of body) void chunk
}

/** Reads a whole entry into memory, or returns null (after draining) when it exceeds `cap`. */
export const readBody = async (body: Body, cap: number): Promise<Buffer | null> => {
  const parts: Buffer[] = []
  let len = 0
  let over = false
  for await (const chunk of body) {
    if (over) continue
    len += chunk.length
    if (len > cap) { over = true; parts.length = 0; continue }
    parts.push(chunk)
  }
  return over ? null : Buffer.concat(parts)
}

interface Digest {
  sha256: string
  size: number
}

/** Wraps a body so consuming it also computes sha256 and size; `finish()` drains the rest. */
export const hashing = (body: Body): { body: Body; finish: () => Promise<Digest> } => {
  const h = createHash('sha256')
  let size = 0
  const it = body[Symbol.asyncIterator]()
  let ended = false
  const pull = async (): Promise<IteratorResult<Buffer>> => {
    const n = await it.next()
    if (n.done) { ended = true; return n }
    h.update(n.value)
    size += n.value.length
    return n
  }
  const wrapped: Body = { [Symbol.asyncIterator]: () => ({ next: pull }) }
  return {
    body: wrapped,
    finish: async () => {
      while (!ended) await pull()
      return { sha256: h.digest('hex'), size }
    },
  }
}

const corrupt = (e: unknown): XpanelError =>
  isXpanelError(e) ? e : new XpanelError('VALIDATION', `archive is corrupt or not a tar archive: ${e instanceof Error ? e.message : String(e)}`)

/** Entry body whose read errors (truncation, bad gzip) surface as validation errors. */
const entryBody = (stream: AsyncIterable<Buffer>): Body => ({
  [Symbol.asyncIterator]: () => {
    const it = stream[Symbol.asyncIterator]()
    return {
      next: async () => {
        try {
          return await it.next()
        } catch (e) {
          throw corrupt(e)
        }
      },
    }
  },
})

/**
 * Streams a tar or tar.gz (auto-detected) through an ArchiveGuard. The visitor sees only
 * accepted entries; anything it leaves unread is drained. Nothing is written anywhere.
 */
export const walkTar = async (source: ByteSource, visit: Visitor, opts: WalkOptions = {}): Promise<WalkSummary> => {
  const { onSkip, ...guardOpts } = opts
  const guard = new ArchiveGuard(guardOpts)
  const it = source[Symbol.asyncIterator]()
  const { head, done } = await concatHead(it)
  if (head.length === 0) fail('VALIDATION', 'archive is empty')
  const raw = Readable.from(replay(head, it, done), { objectMode: false })
  const gunzip = head[0] === 0x1f && head[1] === 0x8b ? createGunzip() : null
  const ex = tarExtract()
  const onError = (e: Error): void => { ex.destroy(e) }
  raw.on('error', onError)
  gunzip?.on('error', onError)
  ;(gunzip ? raw.pipe(gunzip) : raw).pipe(ex)
  const entries = ex[Symbol.asyncIterator]()
  const skipped: SkippedEntry[] = []
  let skippedCount = 0
  try {
    for (;;) {
      let n: Awaited<ReturnType<typeof entries.next>>
      try {
        n = await entries.next()
      } catch (e) {
        throw corrupt(e)
      }
      if (n.done) break
      const stream = entryBody(n.value as unknown as AsyncIterable<Buffer>)
      const decision = guard.check(n.value.header)
      if (decision.action === 'skip') {
        skippedCount++
        if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push(decision.skipped)
        onSkip?.(decision.skipped)
      } else {
        await visit(decision.entry, stream)
      }
      await drain(stream)
    }
  } finally {
    await entries.return?.()
    raw.destroy()
    gunzip?.destroy()
  }
  return { entries: guard.entries, bytes: guard.bytes, skipped, skippedTotal: skippedCount }
}
