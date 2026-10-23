import { escapeHtml } from './tokens.ts'

/** Dates, times, and dash-joined numbers. Neutrals otherwise reverse inside Arabic. */
const LTR_RUN = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?: ?UTC|Z)?|\d{1,2}:\d{2}(?::\d{2})?(?: ?UTC)?|\d+(?:-\d+)+/g

/** Same runs, plus a whole number or size. Used only to keep meta values unclipped. */
const META_VALUE = new RegExp(`${LTR_RUN.source}|\\d+(?:[.,]\\d+)*(?:\\s*\\/\\s*\\d+(?:[.,]\\d+)*)?(?:\\s*[A-Za-z%]+(?:\\/[A-Za-z]+)?)?`, 'g')

export interface MetaPiece { kind: 'label' | 'value'; text: string }

/** Split an Arabic meta line into a shrinkable label and values that must stay whole. */
export const metaPieces = (text: string): MetaPiece[] => {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (!/[\u0600-\u06FF]/.test(trimmed)) return [{ kind: 'value', text: trimmed }]
  const pattern = new RegExp(META_VALUE.source, 'g')
  const pieces: MetaPiece[] = []
  let cursor = 0
  for (const match of trimmed.matchAll(pattern)) {
    const index = match.index ?? 0
    const label = trimmed.slice(cursor, index).trim()
    if (label) pieces.push({ kind: 'label', text: label })
    const value = match[0].trim()
    if (value) pieces.push({ kind: 'value', text: value })
    cursor = index + match[0].length
  }
  const tail = trimmed.slice(cursor).trim()
  if (tail) pieces.push({ kind: 'label', text: tail })
  if (pieces.every(piece => piece.kind === 'label')) return [{ kind: 'value', text: trimmed }]
  return pieces
}

/** Escape text and wrap each date, time, or dash-joined number in `<bdi dir="ltr">`. */
export const isolateLtrRuns = (text: string): string => {
  const pattern = new RegExp(LTR_RUN.source, 'g')
  let html = ''
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index === undefined) continue
    html += escapeHtml(text.slice(cursor, index))
    html += `<bdi dir="ltr">${escapeHtml(match[0])}</bdi>`
    cursor = index + match[0].length
  }
  html += escapeHtml(text.slice(cursor))
  return html
}
