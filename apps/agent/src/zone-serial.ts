import { createHash } from 'node:crypto'

/** BIND serial token written by `renderBindZone` (`N ; serial`). */
export const SERIAL_RE = /^(\s*)(\d+)(\s*;\s*serial\b)/m
const CONTENT_HASH_RE = /(?:^|\n); xpanel-content ([0-9a-f]{64})\n?$/

const SERIAL_CAP = 4_294_967_295

const serialToken = (text: string): string => text.replace(SERIAL_RE, '$1SERIAL$3')
const zoneBody = (text: string): string => text.replace(CONTENT_HASH_RE, '\n').replace(/\s*$/, '\n')

/** Hash the actual body, excluding its serial and final content marker. */
export const zoneContentHash = (text: string): string =>
  createHash('sha256').update(serialToken(zoneBody(text)), 'utf8').digest('hex')

export const stampZoneContent = (text: string): string => {
  const body = zoneBody(text)
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
 * Only a valid stamp of the actual previous body AND matching desired content
 * can keep the serial. Unstamped files migrate once; altered files bump once.
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
  const stored = CONTENT_HASH_RE.exec(previousText)?.[1]
  if (stored && stored === zoneContentHash(previousText) && stored === zoneContentHash(rendered)) return floor
  return bumpSoaSerial(floor, now)
}
