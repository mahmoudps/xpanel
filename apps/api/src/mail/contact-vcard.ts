import { fail } from '@xpanel/core'

type Property = { name: string; header: string; value: string; raw: string }
const MAX_BYTES = 256 * 1024
/** One card already in the store: devices embed photos, so the import bound above would hide it. */
export const MAX_STORED_CARD_BYTES = 1024 * 1024
const refuse = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
export const escapeContactVcardText = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replace(/\r?\n/g, '\\n')
const decode = (value: string): string => value.replace(/\\(.)/g, (_all, escaped: string) => {
  if (escaped === 'n' || escaped === 'N') return '\n'
  if (escaped === '\\' || escaped === ',' || escaped === ';') return escaped
  return refuse('unsupported vCard text escape')
})
const ENCODED = /;(?:ENCODING="?(QUOTED-PRINTABLE|BASE64|B|7BIT|8BIT)"?|(QUOTED-PRINTABLE|BASE64|7BIT|8BIT))(?=;|$)/i
const quotedPrintable = (header: string): boolean => ENCODED.exec(header)?.slice(1).some(kind => kind?.toUpperCase() === 'QUOTED-PRINTABLE') === true
const properties = (source: string): Property[] => {
  if (typeof source !== 'string' || !source.isWellFormed() || Buffer.byteLength(source, 'utf8') > MAX_STORED_CARD_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(source)) return refuse('valid bounded vCard content is required')
  const result: Property[] = []
  for (const raw of source.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? []) {
    if (!raw) continue
    const line = raw.replace(/\r?\n$/, '')
    const previous = result.at(-1)
    // vCard 2.1 soft line break: the value goes on with no leading blank.
    if (previous && previous.value.endsWith('=') && quotedPrintable(previous.header)) {
      previous.raw += raw; previous.value = previous.value.slice(0, -1) + line.trimStart()
      continue
    }
    if (/^[ \t]/.test(line)) {
      if (!previous || previous.name === 'BEGIN' || previous.name === 'END') return refuse('invalid vCard continuation')
      previous.raw += raw; previous.value += line.slice(1)
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 1) return refuse('malformed vCard property')
    const header = line.slice(0, colon), name = header.split(';')[0]!.split('.').at(-1)!.toUpperCase()
    if (!/^(?:[A-Za-z0-9-]+\.)?[A-Za-z0-9-]+(?:;[^\r\n]*)?$/.test(header)) return refuse('invalid vCard property name')
    result.push({ name, header, value: line.slice(colon + 1), raw })
  }
  if (result[0]?.name !== 'BEGIN' || result[0]?.value.toUpperCase() !== 'VCARD' || result.at(-1)?.name !== 'END' || result.at(-1)?.value.toUpperCase() !== 'VCARD' || result.slice(1,-1).some(property => property.name === 'BEGIN' || property.name === 'END')) return refuse('vCard must contain exactly one complete card')
  return result
}

const quotedPrintableBytes = (value: string): Buffer => {
  if (/[^\t\x20-\x7e]/.test(value)) return refuse('invalid quoted-printable vCard field')
  const bytes: number[] = []
  for (let at = 0; at < value.length; at++) {
    if (value[at] !== '=') { bytes.push(value.charCodeAt(at)); continue }
    const pair = value.slice(at + 1, at + 3)
    if (!/^[0-9A-Fa-f]{2}$/.test(pair)) return refuse('invalid quoted-printable vCard field')
    bytes.push(Number.parseInt(pair, 16)); at += 2
  }
  return Buffer.from(bytes)
}
/** The value of a vCard 2.1 ENCODING, decoded in its CHARSET; null for a plain value, which is already Unicode. */
const encodedValue = (property: Property): string | null => {
  const match = ENCODED.exec(property.header), kind = (match?.[1] ?? match?.[2])?.toUpperCase()
  if (!kind && /;ENCODING=/i.test(property.header)) return refuse('this vCard encoding is not supported')
  if (!kind || kind === '7BIT' || kind === '8BIT') return null
  if (kind !== 'QUOTED-PRINTABLE' && !/^[A-Za-z0-9+/]*={0,2}$/.test(property.value.replace(/\s/g, ''))) return refuse('invalid base64 vCard field')
  const bytes = kind === 'QUOTED-PRINTABLE' ? quotedPrintableBytes(property.value) : Buffer.from(property.value, 'base64')
  try { return new TextDecoder(/;CHARSET="?([A-Za-z0-9._:-]{1,40})"?(?=;|$)/i.exec(property.header)?.[1] ?? 'utf-8', { fatal: true }).decode(bytes) }
  catch { return refuse('this vCard character set is not supported') }
}
const ENCODING_PARAMETERS = /;(?:ENCODING="?[^;"]*"?|CHARSET="?[^;"]*"?|QUOTED-PRINTABLE|BASE64|7BIT|8BIT)(?=;|$)/gi

/** Replace only reviewed properties. Every unrelated property retains its exact bytes and folding. */
export const rewriteContactVcard = (source: string, replacements: Readonly<Record<string, string | null>>): string => {
  const blocks = properties(source), newline = source.includes('\r\n') ? '\r\n' : '\n'
  const pending = new Set(Object.keys(replacements)), output: string[] = []
  for (const name of pending) if (name !== 'CATEGORIES' && blocks.filter(block => block.name === name).length > 1) return fail('PRECONDITION_FAILED', 'multiple vCard values require explicit review before this field can change', { stateChanged: false })
  for (const block of blocks) {
    if (pending.has(block.name)) {
      const value = replacements[block.name]
      // The new value is plain UTF-8, so the parameters that described the old bytes go with them.
      if (value !== null) output.push(block.header.replace(ENCODING_PARAMETERS, '') + ':' + value + (/\r?\n$/.test(block.raw) ? block.raw.endsWith('\r\n') ? '\r\n' : '\n' : ''))
      pending.delete(block.name)
    } else if (Object.hasOwn(replacements, block.name)) continue
    else {
      if (block.name === 'END') for (const name of pending) {
        const value = replacements[name]
        if (value !== null) output.push(name + ':' + value + newline)
      }
      output.push(block.raw)
    }
  }
  return output.join('')
}

const categories = (value: string): string[] => {
  if (!value) return []
  const result: string[] = []; let part = '', escaped = false
  for (const character of value) {
    if (escaped) { part += '\\' + character; escaped = false }
    else if (character === '\\') escaped = true
    else if (character === ',') { result.push(decode(part)); part = '' }
    else part += character
  }
  if (escaped) return refuse('incomplete vCard category escape')
  result.push(decode(part)); return result
}

/** Bounded import index; the original card remains authoritative for UID and opaque properties. */
export const readContactVcards = (source: string, maxBytes = MAX_BYTES) => {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > maxBytes) return refuse('valid bounded vCard content is required')
  const cards: string[] = []; let current: string[] | null = null
  for (const raw of source.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? []) {
    if (!raw) continue
    const line = raw.replace(/\r?\n$/, '')
    if (/^BEGIN:VCARD$/i.test(line)) { if (current) return refuse('nested vCard'); current = [raw] }
    else if (/^END:VCARD$/i.test(line)) { if (!current) return refuse('unmatched vCard end'); current.push(raw); cards.push(current.join('')); current = null }
    else if (current) current.push(raw)
    else if (line.trim()) return refuse('text outside vCard')
  }
  if (current || !cards.length) return refuse('complete vCard content is required')
  return cards.map(vcard => {
    const blocks = properties(vcard)
    const text = (name: string): string => {
      const property = blocks.find(block => block.name === name)
      if (!property) return ''
      const decoded = encodedValue(property)
      if (decoded !== null) return decoded.replace(/\\([\\,;nN])/g, (_all, escaped: string) => escaped === 'n' || escaped === 'N' ? '\n' : escaped)
      if (/\\$/.test(property.value) && !/\\\\$/.test(property.value)) return refuse('incomplete vCard escape')
      return decode(property.value)
    }
    return { fullName: text('FN'), email: text('EMAIL').toLowerCase(), phone: text('TEL'), organization: text('ORG'), title: text('TITLE'),
      groups: blocks.filter(block => block.name === 'CATEGORIES').flatMap(block => categories(encodedValue(block) ?? block.value)), vcard }
  })
}
