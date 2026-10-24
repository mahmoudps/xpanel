/** Absolute xMail inbox on the public mail origin. A relative `/mail/inbox` 404s on the account port. */
export const mailInboxHref = (mailOrigin?: string): string => {
  if (!mailOrigin) return '/mail/inbox'
  try {
    const url = new URL(mailOrigin)
    if (url.protocol === 'https:' && url.origin === mailOrigin && url.username === '' && url.password === '') {
      return `${url.origin}/mail/inbox`
    }
  } catch { /* Keep the panel path when the origin is not an exact HTTPS origin. */ }
  return '/mail/inbox'
}
