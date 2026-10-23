/**
 * Minimal ISO/IEC 18004 QR encoder (byte mode, error correction level L, versions 1-8)
 * used to render `otpauth://totp/...` enrollment URIs as an inline SVG without dependencies.
 */

interface QrVersionSpec {
  version: number
  dataCodewords: number
  ecCodewordsPerBlock: number
  blocks: number
  alignment: readonly number[]
}

const QR_VERSIONS_L: readonly QrVersionSpec[] = [
  { version: 1, dataCodewords: 19, ecCodewordsPerBlock: 7, blocks: 1, alignment: [] },
  { version: 2, dataCodewords: 34, ecCodewordsPerBlock: 10, blocks: 1, alignment: [6, 18] },
  { version: 3, dataCodewords: 55, ecCodewordsPerBlock: 15, blocks: 1, alignment: [6, 22] },
  { version: 4, dataCodewords: 80, ecCodewordsPerBlock: 20, blocks: 1, alignment: [6, 26] },
  { version: 5, dataCodewords: 108, ecCodewordsPerBlock: 26, blocks: 1, alignment: [6, 30] },
  { version: 6, dataCodewords: 136, ecCodewordsPerBlock: 18, blocks: 2, alignment: [6, 34] },
  { version: 7, dataCodewords: 156, ecCodewordsPerBlock: 20, blocks: 2, alignment: [6, 22, 38] },
  { version: 8, dataCodewords: 194, ecCodewordsPerBlock: 24, blocks: 2, alignment: [6, 24, 42] },
]

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255]!
  }
})()

const gfMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!)

const rsGeneratorPoly = (degree: number): Uint8Array => {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]!
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, root)
    }
    poly = next
  }
  return poly
}

const rsEncode = (data: Uint8Array, ecLength: number): Uint8Array => {
  const gen = rsGeneratorPoly(ecLength)
  const rem = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ rem[0]!
    rem.copyWithin(0, 1)
    rem[ecLength - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecLength; j++) {
        rem[j] = rem[j]! ^ gfMul(gen[j + 1]!, factor)
      }
    }
  }
  return rem
}

const formatBitsL = (mask: number): number => {
  const data = (0b01 << 3) | (mask & 0b111)
  let rem = data << 10
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10)
  }
  return ((data << 10) | rem) ^ 0x5412
}

const versionBits = (version: number): number => {
  let rem = version << 12
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12)
  }
  return (version << 12) | rem
}

const maskBit = (mask: number, r: number, c: number): boolean => {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
}

const penaltyScore = (modules: Uint8Array, size: number): number => {
  let score = 0
  const get = (r: number, c: number): number => modules[r * size + c]!
  for (let r = 0; r < size; r++) {
    let runColor = get(r, 0)
    let runLen = 1
    for (let c = 1; c < size; c++) {
      const v = get(r, c)
      if (v === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = v
        runLen = 1
      }
    }
  }
  for (let c = 0; c < size; c++) {
    let runColor = get(0, c)
    let runLen = 1
    for (let r = 1; r < size; r++) {
      const v = get(r, c)
      if (v === runColor) {
        runLen++
        if (runLen === 5) score += 3
        else if (runLen > 5) score += 1
      } else {
        runColor = v
        runLen = 1
      }
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = get(r, c)
      if (v === get(r, c + 1) && v === get(r + 1, c) && v === get(r + 1, c + 1)) score += 3
    }
  }
  let dark = 0
  for (let i = 0; i < modules.length; i++) if (modules[i]) dark++
  const k = Math.abs(dark * 20 - size * size * 10) / (size * size)
  score += Math.floor(k) * 10
  return score
}

export const encodeQrMatrix = (payload: string): { size: number; modules: Uint8Array } => {
  const bytes = Buffer.from(payload, 'utf8')
  const spec = QR_VERSIONS_L.find((s) => bytes.byteLength + 2 <= s.dataCodewords)
  if (!spec) throw new Error('QR payload exceeds supported capacity')

  const bits: number[] = []
  const pushBits = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1)
  }
  pushBits(0b0100, 4)
  pushBits(bytes.byteLength, 8)
  for (const b of bytes) pushBits(b, 8)
  const capacityBits = spec.dataCodewords * 8
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataWords = new Uint8Array(spec.dataCodewords)
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!
    dataWords[i] = byte
  }
  for (let i = bits.length / 8, pad = 0; i < spec.dataCodewords; i++, pad ^= 1) {
    dataWords[i] = pad === 0 ? 0xec : 0x11
  }

  const blockSize = spec.dataCodewords / spec.blocks
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  for (let b = 0; b < spec.blocks; b++) {
    const slice = dataWords.subarray(b * blockSize, (b + 1) * blockSize)
    dataBlocks.push(slice)
    ecBlocks.push(rsEncode(slice, spec.ecCodewordsPerBlock))
  }

  const codewords: number[] = []
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < spec.blocks; b++) codewords.push(dataBlocks[b]![i]!)
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) codewords.push(ecBlocks[b]![i]!)
  }

  const streamBits: number[] = []
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) streamBits.push((cw >>> b) & 1)
  }
  const remainderBits = spec.version >= 2 && spec.version <= 6 ? 7 : 0
  for (let i = 0; i < remainderBits; i++) streamBits.push(0)

  const size = 17 + spec.version * 4
  const base = new Uint8Array(size * size)
  const reserved = new Uint8Array(size * size)
  const setFunction = (r: number, c: number, dark: boolean): void => {
    if (r < 0 || r >= size || c < 0 || c >= size) return
    base[r * size + c] = dark ? 1 : 0
    reserved[r * size + c] = 1
  }

  const placeFinder = (top: number, left: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        setFunction(top + dr, left + dc, inside && (ring || core))
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(0, size - 7)
  placeFinder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    setFunction(6, i, i % 2 === 0)
    setFunction(i, 6, i % 2 === 0)
  }

  for (const r of spec.alignment) {
    for (const c of spec.alignment) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 8) || (r >= size - 8 && c <= 8)) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          setFunction(r + dr, c + dc, dark)
        }
      }
    }
  }

  setFunction(size - 8, 8, true)
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8 * size + i] = 1
      reserved[i * size + 8] = 1
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8 * size + (size - 1 - i)] = 1
    reserved[(size - 1 - i) * size + 8] = 1
  }

  if (spec.version >= 7) {
    const vBits = versionBits(spec.version)
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1
      const a = Math.floor(i / 3)
      const b = (i % 3) + size - 11
      setFunction(a, b, bit)
      setFunction(b, a, bit)
    }
  }

  const raw = new Uint8Array(base)
  let bitIdx = 0
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const c = right - j
        if (!reserved[r * size + c]) {
          raw[r * size + c] = bitIdx < streamBits.length ? streamBits[bitIdx++]! : 0
        }
      }
    }
    upward = !upward
  }

  const writeFormat = (target: Uint8Array, mask: number): void => {
    const f = formatBitsL(mask)
    // First copy: bits 0-5 down column 8, then around the top-left finder, bits 9-14 along row 8.
    for (let i = 0; i <= 5; i++) target[i * size + 8] = (f >>> i) & 1
    target[7 * size + 8] = (f >>> 6) & 1
    target[8 * size + 8] = (f >>> 7) & 1
    target[8 * size + 7] = (f >>> 8) & 1
    for (let i = 9; i < 15; i++) target[8 * size + (14 - i)] = (f >>> i) & 1
    for (let i = 0; i < 8; i++) target[8 * size + (size - 1 - i)] = (f >>> i) & 1
    for (let i = 8; i < 15; i++) target[(size - 15 + i) * size + 8] = (f >>> i) & 1
    target[(size - 8) * size + 8] = 1
  }

  let bestMask = 0
  let bestScore = Infinity
  let bestModules = new Uint8Array(raw)
  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(raw)
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r * size + c] && maskBit(mask, r, c)) {
          candidate[r * size + c] = candidate[r * size + c]! ^ 1
        }
      }
    }
    writeFormat(candidate, mask)
    const score = penaltyScore(candidate, size)
    if (score < bestScore) {
      bestScore = score
      bestMask = mask
      bestModules = candidate
    }
  }
  writeFormat(bestModules, bestMask)
  return { size, modules: bestModules }
}

export const renderTotpQrSvg = (otpauthUrl: string): string => {
  const { size, modules } = encodeQrMatrix(otpauthUrl)
  const quiet = 4
  const total = size + quiet * 2
  let d = ''
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) {
        d += `M${c + quiet} ${r + quiet}h1v1h-1z`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Authenticator QR code" width="168" height="168" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path fill="#101828" d="${d}"/></svg>`
}
