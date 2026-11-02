import type { Translate } from '../../../i18n.ts'
import { escapeHtml } from '../html.ts'

/** The live region the realtime runtime appends toasts to (`#xp-toast-region`, `[data-toast-level]` children). */
export const toastRegion = (t: Translate): string =>
  `<div id="xp-toast-region" class="v2-toasts" role="status" aria-live="polite" aria-label="${escapeHtml(t('Notifications'))}"></div>`

// Toast children come from the runtime as semantic elements: [data-toast-level] > body, then a decorative drain bar.
const TOAST = '#xp-toast-region>[data-toast-level]'
export const TOAST_REGION_CSS = `.v2-toasts{position:fixed;inset-block-end:20px;inset-inline-end:20px;z-index:95;display:flex;flex-direction:column;gap:12px;inline-size:min(420px,calc(100vw - 32px));pointer-events:none}
${TOAST}{position:relative;overflow:hidden;padding:12px var(--space-2);border-radius:var(--radius-notice);background:var(--surface);border:1px solid var(--line-strong);box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:14px;pointer-events:auto}
${TOAST}[data-toast-level=ok]{border-color:var(--ok-line)}
${TOAST}:is([data-toast-level=critical],[data-toast-level=bad],[data-toast-level=error]){border-color:var(--bad-line)}
${TOAST}[data-toast-level=warn]{border-color:var(--warn-line)}
${TOAST}>[aria-hidden]{position:absolute;inset-inline-start:0;inset-block-end:0;height:3px;background:var(--focus);animation:v2-drain 4s linear forwards}
`
