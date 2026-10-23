import { escapeHtml } from './tokens.ts'

/** Dates, times, and dash-joined numbers. Neutrals otherwise reverse inside Arabic. */
const LTR_RUN = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?: ?UTC|Z)?|\d{1,2}:\d{2}(?::\d{2})?(?: ?UTC)?|\d+(?:-\d+)+/g

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
