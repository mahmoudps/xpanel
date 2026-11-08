// The policy of every panel document. style-src keeps 'unsafe-inline' because the themes and board ports render
// style= attributes and <style> blocks on every page. connect-src 'self' also matches this origin's ws: and wss:
// (CSP Level 3), which the live updates and the terminal open.
export const DOCUMENT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

// The panel handoff and the phpMyAdmin/phpPgAdmin sign-on post a one-time ticket to another HTTPS origin in a new tab.
export const CROSS_ORIGIN_FORM_CSP = DOCUMENT_CSP.replace("form-action 'self'", "form-action 'self' https:")
const HANDOFF = '<script id="xpanel-handoff-client" '
const DB_SIGN_ON = /data-db-engine="(?:account-phpmyadmin|account-phppgadmin|whm-phpmyadmin)"/

/** Headers for one rendered document; its own markup decides the two cross-origin form exceptions. */
export function documentSecurityHeaders(html: string): { 'content-security-policy': string; 'referrer-policy': string } {
  const handoff = html.includes(HANDOFF)
  return {
    'content-security-policy': handoff || DB_SIGN_ON.test(html) ? CROSS_ORIGIN_FORM_CSP : DOCUMENT_CSP,
    // The handoff target checks the exact Origin header, which same-origin would turn into null on this POST.
    'referrer-policy': handoff ? 'strict-origin-when-cross-origin' : 'same-origin',
  }
}
