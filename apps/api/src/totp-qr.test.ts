import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encodeQrMatrix, renderTotpQrSvg } from './totp-qr.ts'

const FORMAT_MASK = 0x5412
const bchFormat = (data: number): number => {
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ FORMAT_MASK
}
const VALID_FORMATS = new Set(Array.from({ length: 32 }, (_, data) => bchFormat(data)))

const readFormatCopies = (size: number, m: Uint8Array): [number, number] => {
  const at = (r: number, c: number): number => m[r * size + c] ?? 0
  const first = [0, 1, 2, 3, 4, 5].map(i => at(i, 8)).concat([at(7, 8), at(8, 8), at(8, 7)], [9, 10, 11, 12, 13, 14].map(i => at(8, 14 - i)))
  const second = Array.from({ length: 8 }, (_, i) => at(8, size - 1 - i)).concat(Array.from({ length: 7 }, (_, k) => at(size - 7 + k, 8)))
  const value = (bits: number[]) => bits.reduce((acc, bit, i) => acc | (bit << i), 0)
  return [value(first), value(second)]
}

const urlFor = (name: string) => `otpauth://totp/xPanel:${encodeURIComponent(name)}?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=xPanel`

describe('TOTP enrollment QR encoder', () => {
  it('writes identical, valid level-L format information in both copies for every version', () => {
    for (const length of [1, 10, 25, 45, 70, 90, 110]) {
      const { size, modules } = encodeQrMatrix(urlFor('u'.repeat(length)))
      const [first, second] = readFormatCopies(size, modules)
      expect(first).toBe(second)
      expect(VALID_FORMATS.has(first)).toBe(true)
      expect(((first ^ FORMAT_MASK) >>> 13) & 0b11).toBe(0b01)
      expect(modules[(size - 8) * size + 8]).toBe(1)
    }
  })

  it('places finder patterns and timing patterns', () => {
    const { size, modules } = encodeQrMatrix(urlFor('root'))
    const at = (r: number, c: number): number => modules[r * size + c] ?? 0
    for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(at(r0, c0 + i)).toBe(1)
        expect(at(r0 + 6, c0 + i)).toBe(1)
        expect(at(r0 + i, c0)).toBe(1)
        expect(at(r0 + 3, c0 + 3)).toBe(1)
      }
    }
    for (let i = 8; i < size - 8; i++) {
      expect(at(6, i)).toBe(i % 2 === 0 ? 1 : 0)
      expect(at(i, 6)).toBe(i % 2 === 0 ? 1 : 0)
    }
  })

  it('is deterministic for a known enrollment URI (verified with an independent decoder)', () => {
    const { size, modules } = encodeQrMatrix(urlFor('root'))
    expect(size).toBe(37)
    expect(createHash('sha256').update(modules).digest('hex')).toBe('eeac93ad635a1414ceac1fa8c1d37db4a32f1d31b2046d2498122c791cbb0511')
  })

  it('renders a self-contained SVG and rejects payloads beyond version 8', () => {
    const svg = renderTotpQrSvg(urlFor('root'))
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).not.toMatch(/<script|href=|on[a-z]+=/i)
    expect(() => encodeQrMatrix('x'.repeat(400))).toThrow(/capacity/)
  })
})
