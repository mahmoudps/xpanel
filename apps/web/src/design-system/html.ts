export type TextTranslator = (message: string, values?: Readonly<Record<string, string | number>>) => string

export function normalizeAsciiDigits(value: string): string {
  return value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String(digit.charCodeAt(0) & 0xf))
}

export function createDesignTranslator(copy?: TextTranslator): TextTranslator {
  return (message, values) => {
    const raw = copy ? copy(message, values) : message
    if (!values) return normalizeAsciiDigits(raw)
    let interpolated = raw
    for (const [key, val] of Object.entries(values)) {
      interpolated = interpolated.replaceAll(`{${key}}`, String(val))
    }
    return normalizeAsciiDigits(interpolated)
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function escapeAttr(value: string): string {
  return escapeHtml(value)
}

export function joinClasses(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function renderAttributes(map: Readonly<Record<string, string | number | boolean | undefined | null>>): string {
  const out: string[] = []
  for (const [name, value] of Object.entries(map)) {
    if (name.toLowerCase() === 'style') {
      throw new Error(`Inline style attribute is forbidden in design-system components (${name})`)
    }
    if (value === undefined || value === null || value === false) continue
    if (value === true) out.push(name)
    else out.push(`${name}="${escapeAttr(String(value))}"`)
  }
  return out.length ? ' ' + out.join(' ') : ''
}
