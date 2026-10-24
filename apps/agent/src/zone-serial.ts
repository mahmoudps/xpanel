/** BIND serial token written by `renderBindZone` (`N ; serial`). */
export const SERIAL_RE = /^(\s*)(\d+)(\s*;\s*serial\b)/m

const SERIAL_CAP = 4_294_967_295

const serialToken = (text: string): string => text.replace(SERIAL_RE, '$1SERIAL$3')

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
 * Serial to write. No previous file keeps the state serial. An unchanged body
 * keeps the higher of the state and file serials. A changed body bumps that floor.
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
  if (serialToken(previousText) === serialToken(rendered)) return floor
  return bumpSoaSerial(floor, now)
}
