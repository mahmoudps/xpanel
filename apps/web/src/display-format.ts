// Pure display formatting shared by server views and browser bindings.

const EASTERN_ARABIC_ZERO = 0x0660
const EXTENDED_ARABIC_ZERO = 0x06f0

/**
 * Converts Eastern Arabic (U+0660-U+0669) and Extended Arabic-Indic (U+06F0-U+06F9) numerals to ASCII (0-9).
 */
export function normalizeAsciiDigits(input: string | number): string {
  const raw = typeof input === 'number' ? String(input) : input
  if (raw.length === 0) return ''
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code >= EASTERN_ARABIC_ZERO && code <= EASTERN_ARABIC_ZERO + 9) {
      out += String(code - EASTERN_ARABIC_ZERO)
    } else if (code >= EXTENDED_ARABIC_ZERO && code <= EXTENDED_ARABIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_ZERO)
    } else if (code === 0x066b) {
      out += '.'
    } else if (code === 0x066c) {
      out += ','
    } else {
      out += raw[i]!
    }
  }
  return out
}

/**
 * Formats a number deterministically using Western ASCII digits (`0-9`) regardless of active locale.
 */
export function formatAsciiNumber(
  value: number,
  opts: { decimals?: number; useGrouping?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return '0'
  const decimals = opts.decimals
  const useGrouping = opts.useGrouping ?? true
  const fixed = decimals !== undefined ? value.toFixed(decimals) : String(value)
  const [intPartRaw, fracPart] = fixed.split('.')
  const sign = intPartRaw?.startsWith('-') ? '-' : ''
  const digits = (sign ? intPartRaw!.slice(1) : intPartRaw) ?? '0'
  const grouped = useGrouping ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits
  return fracPart !== undefined && fracPart.length > 0 ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`
}

/**
 * Formats a percentage using Western ASCII digits (`0-9`).
 */
export function formatAsciiPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '0%'
  const rounded = Number(value.toFixed(decimals))
  const text = rounded % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(decimals)
  return `${text}%`
}

/**
 * The product's one display form for instants: `YYYY-MM-DD`, or `YYYY-MM-DD HH:mm UTC` with `includeTime`,
 * ASCII digits in every locale. Readable presentation also rejects anything but an explicit ISO 8601 instant.
 * Machine formats (APIs, logs, `datetime` attributes) stay ISO 8601.
 */
export function formatAsciiDate(
  isoOrDate: string | Date,
  opts: { includeTime?: boolean; presentation?: 'readable' } = {},
): string {
  const readable = opts.presentation === 'readable'
  const input = readable && typeof isoOrDate === 'string' ? normalizeAsciiDigits(isoOrDate) : isoOrDate
  const supplied = readable && typeof input === 'string'
    ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(input) : null
  if (readable && typeof input === 'string' && !supplied) return '—'
  const d = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(d.getTime())) {
    return readable ? '—' : normalizeAsciiDigits(typeof isoOrDate === 'string' ? isoOrDate : '')
  }
  if (supplied) {
    const calendar = new Date(supplied[1] + 'Z')
    if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== supplied[1]) return '—'
  }
  const iso = d.toISOString()
  if (readable && !/^\d{4}-\d{2}-\d{2}T/.test(iso)) return '—'
  return opts.includeTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10)
}

/** Readable presentation only; retain original instants for storage, APIs and arithmetic. */
export function formatDisplayDateTime(value: string | Date | null | undefined): string {
  return value === null || value === undefined ? '—' : formatAsciiDate(value, { includeTime: true, presentation: 'readable' })
}

/** One self-contained browser expression generated from the same server implementation. */
export const DISPLAY_DATETIME_BINDING = `(()=>{
const EASTERN_ARABIC_ZERO=${EASTERN_ARABIC_ZERO};
const EXTENDED_ARABIC_ZERO=${EXTENDED_ARABIC_ZERO};
const normalizeAsciiDigits=${normalizeAsciiDigits.toString()};
const formatAsciiDate=${formatAsciiDate.toString()};
return ${formatDisplayDateTime.toString()};
})()`

/**
 * UTC clock `HH:mm UTC`. The panel stores instants in UTC and has no chosen zone,
 * so every server clock uses this label instead of a bare hour.
 */
export function formatUtcClock(isoOrDate: string | Date): string {
  const full = formatAsciiDate(isoOrDate, { includeTime: true })
  const clock = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2} UTC)$/.exec(full)
  return clock ? clock[1]! : full
}

/** UTC calendar day `YYYY-MM-DD UTC`, the date form of {@link formatUtcClock}. */
export function formatUtcDay(isoOrDate: string | Date): string {
  const day = formatAsciiDate(isoOrDate)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} UTC` : day
}


/**
 * The product's one byte format: binary IEC units (powers of 1024) labelled B/KiB/MiB/GiB/TiB,
 * ASCII digits and a non-breaking space before the unit. Plans, quotas and props store MiB.
 */
export function formatAsciiBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  // A measured positive amount under one byte is not shown as zero.
  if (Number.isFinite(bytes) && bytes > 0 && bytes < 1) return '<1\u00a0B'
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  let decimals = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2
  // 1023.7 KiB rounds to 1024: show the next unit instead.
  if (Number(value.toFixed(decimals)) >= 1024 && unit < units.length - 1) { value /= 1024; unit++; decimals = 2 }
  return value.toFixed(decimals) + '\u00a0' + units[unit]
}

/** A transfer rate in the same units: B/s, KiB/s, MiB/s. */
export function formatAsciiRate(bytesPerSecond: number): string {
  return formatAsciiBytes(bytesPerSecond) + '/s'
}

/**
 * Wraps a technical run (date-time, path, file name, command, address, "number unit") in
 * LEFT-TO-RIGHT ISOLATE ... POP DIRECTIONAL ISOLATE, so it keeps its order inside Arabic text.
 * Clients use it when writing textContent; markup uses `<bdi dir="ltr">`.
 */
export function isolateLtr(text: string): string {
  return '\u2066' + text + '\u2069'
}

/** The byte format as clients write it into text: isolated, optionally as a rate. */
export function formatIsolatedBytes(bytes: number, perSecond?: boolean): string {
  return '\u2066' + formatAsciiBytes(bytes) + (perSecond ? '/s' : '') + '\u2069'
}

/** Browser clients get the isolated byte formatter from this one implementation. */
export const ASCII_BYTES_BINDING = `(()=>{const formatAsciiBytes=${formatAsciiBytes.toString()};return ${formatIsolatedBytes.toString()};})()`

/** Browser clients get {@link isolateLtr} from this one implementation. */
export const ISOLATE_LTR_BINDING = isolateLtr.toString()

export function formatBytes(bytes: number): string {
  return formatAsciiBytes(bytes)
}

