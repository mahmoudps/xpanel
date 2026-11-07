import { describe, expect, it } from 'vitest'
import { readXlsRows } from './xls-reader.ts'

const u16 = (value: number) => [value & 255, value >> 8]
const u32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24]
const rec = (id: number, body: number[]) => [...u16(id), ...u16(body.length), ...body]
const ascii = (text: string) => [...u16(text.length), 0, ...[...text].map(char => char.charCodeAt(0))]
const wide = (text: string) => [...u16(text.length), 1, ...[...text].flatMap(char => u16(char.charCodeAt(0)))]
const double = (value: number) => { const out = new Uint8Array(8); new DataView(out.buffer).setFloat64(0, value, true); return [...out] }

/** A workbook stream: one BOUNDSHEET, a shared string table with a split string, and the cell record kinds a sheet uses. */
function workbook(padding: number): number[] {
  const sst = [...u32(3), ...u32(3), ...ascii('info@example.test'), ...wide('صندوق')]
  const split = [...u16(7), 0, ...[...'abc'].map(char => char.charCodeAt(0))]
  const continued = [0, ...[...'defg'].map(char => char.charCodeAt(0))]
  const sheetRecords = [...rec(0x00FD, [...u16(0), ...u16(0), ...u16(0), ...u32(0)]), ...rec(0x00FD, [...u16(0), ...u16(1), ...u16(0), ...u32(1)]), ...rec(0x00FD, [...u16(2), ...u16(0), ...u16(0), ...u32(2)]),
    ...rec(0x0203, [...u16(0), ...u16(2), ...u16(0), ...double(1024)]), ...rec(0x027E, [...u16(2), ...u16(1), ...u16(0), ...u32((512 << 2) | 2)]), ...rec(0x000A, [])]
  const bof = rec(0x0809, new Array(16).fill(0))
  const head = (offset: number) => [...bof, ...rec(0x0085, [...u32(offset), 0, 0, 1, 0, 0x53]), ...rec(0x00FC, [...sst, ...split]), ...rec(0x003C, continued), ...rec(0x000A, [])]
  const offset = head(0).length + padding
  return [...head(offset), ...new Array(padding).fill(0), ...sheetRecords]
}

/** An OLE2 file with one FAT sector, a directory sector, and the stream in regular sectors. */
function ole(stream: number[]): Uint8Array {
  const sectors = Math.ceil(stream.length / 512), file = new Uint8Array(512 * (3 + sectors)), view = new DataView(file.buffer)
  view.setUint32(0, 0xE011CFD0, true); view.setUint32(4, 0xE11AB1A1, true); view.setUint16(30, 9, true); view.setUint16(32, 6, true)
  view.setUint32(44, 1, true); view.setUint32(48, 1, true); view.setUint32(56, 4096, true); view.setUint32(60, 0xFFFFFFFE, true); view.setUint32(68, 0xFFFFFFFE, true)
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i === 0 ? 0 : 0xFFFFFFFF, true)
  const fat = 512, dir = 1024
  view.setUint32(fat, 0xFFFFFFFD, true); view.setUint32(fat + 4, 0xFFFFFFFE, true)
  for (let i = 0; i < sectors; i++) view.setUint32(fat + (2 + i) * 4, i === sectors - 1 ? 0xFFFFFFFE : 3 + i, true)
  const entry = (at: number, name: string, type: number, start: number, size: number) => {
    [...name].forEach((char, i) => view.setUint16(at + i * 2, char.charCodeAt(0), true))
    view.setUint16(at + 64, (name.length + 1) * 2, true); file[at + 66] = type; view.setUint32(at + 116, start, true); view.setUint32(at + 120, size, true)
  }
  entry(dir, 'Root Entry', 5, 0xFFFFFFFE, 0); entry(dir + 128, 'Workbook', 2, 2, stream.length)
  file.set(stream, 512 * 3)
  return file
}

describe('xls reader', () => {
  it('reads shared strings, numbers and RK values of the first sheet, across a split string', () => {
    expect(readXlsRows(ole(workbook(4096)))).toEqual([['info@example.test', 'صندوق', '1024'], [], ['abcdefg', '512']].filter(row => row.length))
  })
  it('refuses a file that is not an OLE2 workbook', () => {
    expect(() => readXlsRows(new TextEncoder().encode('a,b,c\n'.repeat(400)))).toThrow('invalid_xls')
    const broken = ole(workbook(4096)); new DataView(broken.buffer).setUint32(4, 0, true)
    expect(() => readXlsRows(broken)).toThrow('invalid_xls')
  })
  it('refuses an encrypted workbook', () => {
    expect(() => readXlsRows(ole([...rec(0x002F, [0, 0]), ...new Array(5000).fill(0)]))).toThrow('encrypted_xls')
  })
})
