import { createHash } from 'node:crypto'

/** BIND serial token written by `renderBindZone` (`N ; serial`). */
export const SERIAL_RE = /^(\s*)(\d+)(\s*;\s*serial\b)/m

/**
 * Content hash stored as the last line of the zone. A marker earlier in the
 * file is body text and must not suppress a serial bump.
 */
export const CONTENT_HASH_RE = /(?:^|\n); xpanel-content ([0-9a-f]{64})\n?$/

const SERIAL_CAP = 4_294_967_295

const serialToken = (text: string): string => text.replace(SERIAL_RE, '$1SERIAL$3')

const withoutHash = (text: string): string => text.replace(/\n?; xpanel-content [0-9a-f]{64}\s*$/m, '\n')

/** SHA-256 of the zone with the serial token and the hash line removed. */
export const zoneContentHash = (text: string): string =>
  createHash('sha256').update(serialToken(withoutHash(text)), 'utf8').digest('hex')

export const storedZoneContentHash = (text: string): string | null => CONTENT_HASH_RE.exec(text)?.[1] ?? null

/** Appends the content hash. The serial number is not part of the hash. */
export const stampZoneContent = (rendered: string): string => {
  const body = withoutHash(rendered).replace(/\s*$/, '\n')
  return `${body}; xpanel-content ${zoneContentHash(body)}\n`
}

const utcStamp = (now: Date): number => {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  return Number(`${now.getUTCFullYear()}${month}${day}00`)
}

/**
 * Next SOA serial. A calendar day newer than the current value uses YYYYMMDD00.
 * The same day increments. The value never decreases and never passes 2^32-1.
 */
export const bumpSoaSerial = (current: number, now = new Date()): number => {
  const stamp = utcStamp(now)
  const base = Number.isSafeInteger(current) && current > 0 ? current : 0
  const next = base < stamp ? stamp : base + 1
  return Math.min(next, SERIAL_CAP)
}

const fileSerial = (text: string): number => {
  const match = SERIAL_RE.exec(text)
  const value = Number(match?.[2] ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Serial to write. No previous file keeps the state serial. A previous file
 * whose stored content hash matches the rendered zone keeps the higher of the
 * state and file serials. A missing hash, or a different hash, bumps that floor
 * so records added under the old serial are published.
 */
export const chooseZoneSerial = (
  stateSerial: number,
  previousText: string | null,
  rendered: string,
  now = new Date(),
): number => {
  const state = Number.isSafeInteger(stateSerial) && stateSerial > 0 ? stateSerial : 0
  if (previousText === null) return state
  const floor = Math.max(state, fileSerial(previousText))
  const stored = storedZoneContentHash(previousText)
  if (stored !== null && stored === zoneContentHash(rendered)) return floor
  return bumpSoaSerial(floor, now)
}
