const BLOCK = 512
const octal = (block: Buffer, start: number, length: number): number => Number.parseInt(block.subarray(start, start + length).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8)

export interface TarEntry { path: string; type: string; data: Buffer }
/** The entries of an in-memory tar; a truncated entry or a path that leaves the archive stops the walk through refuse. Nothing here touches the disk. */
export function* tarEntries(tar: Buffer, refuse: (reason: 'archive_truncated' | 'archive_path_refused') => never): Generator<TarEntry> {
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) return
    const size = octal(header, 124, 12), type = String.fromCharCode(header[156]!)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, ''), prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const path = prefix ? prefix + '/' + name : name
    if (!Number.isSafeInteger(size) || offset + BLOCK + size > tar.length) return refuse('archive_truncated')
    if (path.split('/').includes('..') || path.startsWith('/')) return refuse('archive_path_refused')
    yield { path, type, data: tar.subarray(offset + BLOCK, offset + BLOCK + size) }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK
  }
}
