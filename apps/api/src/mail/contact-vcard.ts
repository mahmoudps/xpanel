import { fail } from '@xpanel/core'

type Property = { name: string; header: string; value: string; raw: string }
const MAX_BYTES = 256 * 1024
const refuse = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
export const escapeContactVcardText = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replace(/\r?\n/g, '\\n')
const decode = (value: string): string => value.replace(/\\(.)/g, (_all, escaped: string) => {
  if (escaped === 'n' || escaped === 'N') return '\n'
  if (escaped === '\\' || escaped === ',' || escaped === ';') return escaped
  return refuse('unsupported vCard text escape')
})
const properties = (source: string): Property[] => {
  if (typeof source !== 'string' || !source.isWellFormed() || Buffer.byteLength(source, 'utf8') > MAX_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(source)) return refuse('valid bounded vCard content is required')
  const result: Property[] = []
  for (const raw of source.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? []) {
    if (!raw) continue
    const line = raw.replace(/\r?\n$/, '')
    if (/^[ \t]/.test(line)) {
      const previous = result.at(-1)
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

/** Replace only reviewed properties. Every unrelated property retains its exact bytes and folding. */
export const rewriteContactVcard = (source: string, replacements: Readonly<Record<string, string | null>>): string => {
  const blocks = properties(source), newline = source.includes('\r\n') ? '\r\n' : '\n'
  const pending = new Set(Object.keys(replacements)), output: string[] = []
  for (const name of pending) if (name !== 'CATEGORIES' && blocks.filter(block => block.name === name).length > 1) return fail('PRECONDITION_FAILED', 'multiple vCard values require explicit review before this field can change', { stateChanged: false })
  for (const block of blocks) {
    if (pending.has(block.name)) {
      const value = replacements[block.name]
      if (value !== null) output.push(block.header + ':' + value + (/\r?\n$/.test(block.raw) ? block.raw.endsWith('\r\n') ? '\r\n' : '\n' : ''))
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
export const readContactVcards = (source: string) => {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source, 'utf8') > MAX_BYTES) return refuse('valid bounded vCard content is required')
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
      if (/;(?:ENCODING|CHARSET)=/i.test(property.header)) return refuse('encoded contact fields require explicit review')
      if (/\\$/.test(property.value) && !/\\\\$/.test(property.value)) return refuse('incomplete vCard escape')
      return decode(property.value)
    }
    return { fullName: text('FN'), email: text('EMAIL').toLowerCase(), phone: text('TEL'), organization: text('ORG'), title: text('TITLE'),
      groups: blocks.filter(block => block.name === 'CATEGORIES').flatMap(block => categories(block.value)), vcard }
  })
}
