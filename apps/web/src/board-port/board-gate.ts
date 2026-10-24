import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

/** Whole page. A 1px shift of a full screen is about 1.2%, so 3% could not see it. */
export const PAGE_LIMIT = 0.005
/** Every 200×200 tile, including the short tiles on the right and bottom edges. */
export const TILE_LIMIT = 0.01
export const TILE = 200

export interface TileScore {
  x: number
  y: number
  mismatched: number
  total: number
  ratio: number
}

export interface GateScore {
  mismatched: number
  total: number
  ratio: number
  worstTile: TileScore
  pass: boolean
  diff: Buffer
}

const crop = (image: PNG, x: number, y: number, width: number, height: number): Buffer => {
  const out = Buffer.alloc(width * height * 4)
  for (let row = 0; row < height; row++) {
    const src = ((y + row) * image.width + x) * 4
    image.data.copy(out, row * width * 4, src, src + width * 4)
  }
  return out
}

export const scoreGate = (left: Buffer, right: Buffer): GateScore => {
  const a = PNG.sync.read(left)
  const b = PNG.sync.read(right)
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const diff = new PNG({ width, height })
  const mismatched = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false })
  let worstTile: TileScore = { x: 0, y: 0, mismatched: 0, total: 1, ratio: 0 }
  for (let y = 0; y < height; y += TILE) {
    for (let x = 0; x < width; x += TILE) {
      const tw = Math.min(TILE, width - x)
      const th = Math.min(TILE, height - y)
      const tileDiff = new PNG({ width: tw, height: th })
      const tileMiss = pixelmatch(crop(a, x, y, tw, th), crop(b, x, y, tw, th), tileDiff.data, tw, th, { threshold: 0.1, includeAA: false })
      const ratio = tileMiss / (tw * th)
      if (ratio > worstTile.ratio) worstTile = { x, y, mismatched: tileMiss, total: tw * th, ratio }
    }
  }
  const ratio = mismatched / (width * height)
  return {
    mismatched,
    total: width * height,
    ratio,
    worstTile,
    pass: ratio <= PAGE_LIMIT && worstTile.ratio <= TILE_LIMIT,
    diff: PNG.sync.write(diff),
  }
}

/** True when the two captures are the same file bytes. A perfect pixel match can be this, and so can a board screenshot saved twice. Either way it is not a pass. */
export const sameCapture = (left: Buffer, right: Buffer): boolean => left.equals(right)

/** A pass needs the pixel limits, two different capture files, and a 1px control that itself fails. */
export const gateAccepts = (input: { score: GateScore; board: Buffer; app: Buffer; negativePass: boolean }): boolean =>
  input.score.pass && !sameCapture(input.board, input.app) && input.negativePass === false

/** Insert a 1px top pad on the product board-port root. The published capture does not use this. */
export const padPort = (html: string, port: string): string => {
  const pattern = new RegExp(`(<div\\b[^>]*\\bdata-board-port="${port}"[^>]*)>`)
  if (!pattern.test(html)) throw new Error(`pad target data-board-port="${port}" is missing`)
  return html.replace(pattern, (_full, open: string) => (
    open.includes('style="') ? `${open.replace('style="', 'style="padding-top:1px;')}>` : `${open} style="padding-top:1px">`
  ))
}
