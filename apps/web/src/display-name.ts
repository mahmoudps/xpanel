/** Inserts spaces into an unspaced camel-case label. Names that already contain spaces or hyphens stay as stored. */
export function formatDisplayName(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || /[\s-]/.test(trimmed)) return trimmed
  return trimmed.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
}

const CONTACT_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

/** Accepts a configured contact address. Anything else is omitted rather than shown. */
export function publicContactEmail(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 254 || !CONTACT_EMAIL.test(trimmed)) return undefined
  return trimmed
}
