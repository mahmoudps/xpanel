# Every panel document carries a Content-Security-Policy

Date: 2026-11-08.

## Problem

The xPanel, xWHM and xMail documents, in the classic and v2 themes, sent no `Content-Security-Policy`. A control panel needs one as defense in depth against XSS and clickjacking. Every page also ran inline scripts: the translator with its message subset, the sign-in client, and on some pages the team password, handoff, Home, Inbox and Compose clients.

## Decision

- `apps/web/src/content-security-policy.ts` holds the policy. `serveWebUi` sends it on every document, the transport status pages (403, 421, 500, 503) send it too, and so does the temporary sign-in page:

  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`

- No inline script remains, so no nonce is needed. Each former inline script is a same-origin asset with a content-hash version (`apps/web/src/page-scripts.ts`): `/assets/i18n-runtime.js`, `login-client.js`, `team-password.js`, `handoff.js`, `xpanel-home.js`, `xmail-inbox.js` and `xmail-compose.js`. A synchronous external script keeps the execution order of the inline one, and each tag keeps its element id. The page's message subset moves into a `<script type="application/json" id="xpanel-i18n-messages">` block, which the runtime reads. The per-page message keys still come from the scripts the page loads.
- The rendered pages had no inline event handlers and no `javascript:` URLs, so none had to move. The route matrix test now asserts that no document has them.
- `style-src` keeps `'unsafe-inline'`: the themes and board ports render about 3,300 `style=` attributes and inline `<style>` blocks across the 438 documents. They stay as they are.
- `connect-src 'self'` covers the same-origin `wss:` and `ws:` URLs of the live updates and the terminal, because CSP Level 3 matches `'self'` to them. No host source is added.
- Documents also send `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. HSTS and cookies are unchanged.

## Exceptions

- **Handoff controls** (xWHM accounts to xPanel, xPanel email accounts and calendars to xMail): the client posts a one-time token to the other listener's HTTPS origin in a new tab. These documents get `form-action 'self' https:` and `Referrer-Policy: strict-origin-when-cross-origin`, because the target checks the exact `Origin` header and `same-origin` would turn it into `null`.
- **phpMyAdmin and phpPgAdmin sign-on** (`/databases/phpmyadmin`, `/databases/phppgadmin`, `/whm/databases/phpmyadmin`): the ticket goes to the client's own HTTPS port, which the host configures. These documents get `form-action 'self' https:` and keep `same-origin`. The document's own markup decides both exceptions.
- **Pages with their own narrower policy**, unchanged: Webalizer statistics pages (`WEBALIZER_PAGE_CSP`), webmail attachments, file share downloads, plugin icons and branding assets (`default-src 'none'`, sandboxed where they hold content), and the mailing list unsubscribe page.
- **Sandboxed previews** (the file manager HTML editor, the site publisher preview, the web template preview) are `srcdoc` frames. They inherit the document policy, so remote images, stylesheets and video embeds in the previewed page do not load there. The saved file is not changed.

## Tests

- `apps/web/src/content-security-policy.test.ts`: the policy, the sign-in page in both themes, the 404 document, and the handoff and sign-on exceptions.
- `apps/api/src/ui-preferences-integration.test.ts`: every registered xPanel, xWHM and xMail document, in both themes and both languages, rendered by the API, has the policy and no inline script, inline handler, `javascript:` URL or foreign subresource.
- The browser lanes record `securitypolicyviolation` events and HTML documents without a policy (`tests/browser/csp-violations.mjs`), and fail on any.
