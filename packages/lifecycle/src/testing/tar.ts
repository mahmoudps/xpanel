import { gzipSync } from 'node:zlib'
import { pack as tarPack } from 'tar-stream'
import type { Header } from 'tar-stream'

// Builds synthetic archives in memory for tests; no binary fixtures in the repo.

export interface TestEntry {
  name: string
  type?: Header['type']
  content?: string | Buffer
  linkname?: string
  mode?: number
}

export const buildTar = async (entries: TestEntry[], opts: { gzip?: boolean } = {}): Promise<Buffer> => {
  const p = tarPack()
  const chunks: Buffer[] = []
  const collected = (async () => { for await (const c of p) chunks.push(Buffer.from(c as Uint8Array)) })()
  for (const e of entries) {
    const type = e.type ?? 'file'
    const header: Partial<Header> & { name: string } = { name: e.name, type, mode: e.mode ?? (type === 'directory' ? 0o755 : 0o644), mtime: new Date('2026-10-01T00:00:00Z') }
    if (e.linkname !== undefined) header.linkname = e.linkname
    await new Promise<void>((resolve, reject) => {
      const cb = (err?: Error | null): void => (err ? reject(err) : resolve())
      if (type === 'file') p.entry(header, e.content ?? '', cb)
      else p.entry(header, cb)
    })
  }
  p.finalize()
  await collected
  const tar = Buffer.concat(chunks)
  return opts.gzip ? gzipSync(tar) : tar
}

/** Feeds a buffer in small chunks to exercise streaming boundaries. */
export async function* chunked(buf: Buffer, size = 97): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size)
}

export const dirs = (...names: string[]): TestEntry[] => names.map((name) => ({ name, type: 'directory' }))
