/** Reads the first worksheet of a legacy .xls (BIFF8 in an OLE2 container) as text rows. No formulas run; a formula cell reads as empty. */
export function readXlsRows(bytes: Uint8Array): string[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bad = (): never => { throw new Error('invalid_xls') }
  if (bytes.length < 1024 || view.getUint32(0, true) !== 0xE011CFD0 || view.getUint32(4, true) !== 0xE11AB1A1) bad()
  const sectorSize = 1 << view.getUint16(30, true), miniSize = 1 << view.getUint16(32, true), cutoff = view.getUint32(56, true)
  if (sectorSize !== 512 && sectorSize !== 4096) bad()
  const END = 0xFFFFFFFE, sectorAt = (index: number): number => { const at = (index + 1) * sectorSize; return at + sectorSize > bytes.length ? bad() : at }
  const fatSectors: number[] = []
  for (let i = 0; i < 109; i++) { const value = view.getUint32(76 + i * 4, true); if (value < END) fatSectors.push(value) }
  for (let next = view.getUint32(68, true), guard = 0; next < END && guard < 4096; guard++) {
    const at = sectorAt(next), slots = sectorSize / 4 - 1
    for (let i = 0; i < slots; i++) { const value = view.getUint32(at + i * 4, true); if (value < END) fatSectors.push(value) }
    next = view.getUint32(at + slots * 4, true)
  }
  const entryOf = (table: readonly number[], index: number): number => {
    const sector = table[Math.floor(index / (sectorSize / 4))]
    return sector === undefined ? bad() : view.getUint32(sectorAt(sector) + (index % (sectorSize / 4)) * 4, true)
  }
  const chain = (start: number, table: readonly number[]): number[] => { const out: number[] = []; for (let at = start; at < END; at = entryOf(table, at)) { out.push(at); if (out.length > 1 << 20) bad() } return out }
  const read = (start: number): Uint8Array => { const list = chain(start, fatSectors), out = new Uint8Array(list.length * sectorSize); list.forEach((sector, i) => out.set(bytes.subarray(sectorAt(sector), sectorAt(sector) + sectorSize), i * sectorSize)); return out }
  const directory = read(view.getUint32(48, true)), dirView = new DataView(directory.buffer)
  let root = -1, book = -1
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const length = dirView.getUint16(at + 64, true)
    if (length < 2 || length > 64) continue
    let name = ''; for (let i = 0; i < length / 2 - 1; i++) name += String.fromCharCode(dirView.getUint16(at + i * 2, true))
    if (directory[at + 66] === 5) root = at
    if (directory[at + 66] === 2 && (name === 'Workbook' || name === 'Book')) book = at
  }
  if (root < 0 || book < 0) bad()
  const start = dirView.getUint32(book + 116, true), size = dirView.getUint32(book + 120, true)
  let stream: Uint8Array
  if (size >= cutoff) stream = read(start).subarray(0, size)
  else {
    const miniStream = read(dirView.getUint32(root + 116, true)), miniFat = chain(view.getUint32(60, true), fatSectors), out = new Uint8Array(size)
    let written = 0
    for (let at = start; at < END && written < size; at = entryOf(miniFat, at)) { const part = miniStream.subarray(at * miniSize, (at + 1) * miniSize); out.set(part.subarray(0, Math.min(part.length, size - written)), written); written += part.length }
    stream = out
  }
  const data = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const record = (at: number): { id: number; length: number; body: number } | null => at + 4 > stream.length ? null : { id: data.getUint16(at, true), length: data.getUint16(at + 2, true), body: at + 4 }
  const strings: string[] = []
  let sheet = -1
  for (let at = 0, next = record(at); next && next.id !== 0x000A; at = next.body + next.length, next = record(at)) {
    if (next.id === 0x002F) throw new Error('encrypted_xls')
    if (next.id === 0x0085 && sheet < 0 && stream[next.body + 5] === 0) sheet = data.getUint32(next.body, true)
    if (next.id !== 0x00FC) continue
    // CONTINUE records split the table: each piece holds whole characters and a split string restarts with a fresh flag byte.
    const parts: [number, number][] = [[next.body + 8, next.body + next.length]]
    for (let follow = record(next.body + next.length); follow?.id === 0x003C; follow = record(follow.body + follow.length)) parts.push([follow.body, follow.body + follow.length])
    let part = 0, pos = parts[0]![0]
    const take = (count: number): number => { while (pos + count > parts[part]![1]) { part++; if (!parts[part]) bad(); pos = parts[part]![0] } const here = pos; pos += count; return here }
    for (let left = data.getUint32(next.body + 4, true); left > 0; left--) {
      const length = data.getUint16(take(2), true), flags = stream[take(1)]!
      const rich = flags & 8 ? data.getUint16(take(2), true) : 0, phonetic = flags & 4 ? data.getUint32(take(4), true) : 0
      let wide = (flags & 1) === 1, text = ''
      for (let i = 0; i < length; i++) {
        if (pos + (wide ? 2 : 1) > parts[part]![1]) { part++; if (!parts[part]) bad(); pos = parts[part]![0]; wide = (stream[pos++]! & 1) === 1 }
        text += String.fromCharCode(wide ? data.getUint16(take(2), true) : stream[take(1)]!)
      }
      for (let skip = rich * 4 + phonetic; skip > 0;) { const room = Math.min(skip, parts[part]![1] - pos); pos += room; skip -= room; if (skip) { part++; if (!parts[part]) break; pos = parts[part]![0] } }
      strings.push(text)
    }
  }
  if (sheet < 0) bad()
  const cells = new Map<number, Map<number, string>>()
  const put = (row: number, column: number, value: string): void => { let cols = cells.get(row); if (!cols) cells.set(row, cols = new Map()); cols.set(column, value) }
  const rk = (raw: number): number => { const scaled = raw & 1, integer = raw & 2; let value: number; if (integer) value = raw >> 2; else { const parts = new DataView(new ArrayBuffer(8)); parts.setUint32(4, raw & 0xFFFFFFFC, true); value = parts.getFloat64(0, true) } return scaled ? value / 100 : value }
  for (let at = sheet, next = record(at); next && next.id !== 0x000A; at = next.body + next.length, next = record(at)) {
    const row = data.getUint16(next.body, true), column = data.getUint16(next.body + 2, true)
    if (next.id === 0x00FD) put(row, column, strings[data.getUint32(next.body + 6, true)] ?? '')
    else if (next.id === 0x0203) put(row, column, String(data.getFloat64(next.body + 6, true)))
    else if (next.id === 0x027E) put(row, column, String(rk(data.getInt32(next.body + 6, true))))
    else if (next.id === 0x00BD) for (let i = 0, last = data.getUint16(next.body + next.length - 2, true); column + i <= last; i++) put(row, column + i, String(rk(data.getInt32(next.body + 4 + i * 6 + 2, true))))
  }
  return [...cells.keys()].sort((a, b) => a - b).map(row => { const cols = cells.get(row)!, width = Math.max(...cols.keys()) + 1; return Array.from({ length: width }, (_, column) => cols.get(column) ?? '') })
}
