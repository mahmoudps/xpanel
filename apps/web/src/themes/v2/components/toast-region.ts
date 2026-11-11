import type { Translate } from '../../../i18n.ts'
import { escapeHtml } from '../html.ts'

/** The live region the realtime runtime appends toasts to (`#xp-toast-region`, `[data-toast-level]` children). */
export const toastRegion = (t: Translate): string =>
  `<div id="xp-toast-region" class="v2-toasts" role="status" aria-live="polite" aria-label="${escapeHtml(t('Notifications'))}"></div>`

// Toast children come from the runtime as semantic elements: [data-toast-level] > body, then a decorative drain bar.
const TOAST = '#xp-toast-region>[data-toast-level]'
export const TOAST_REGION_CSS = `.v2-toasts{position:fixed;inset-block-end:20px;inset-inline-end:20px;z-index:95;display:flex;flex-direction:column;gap:12px;inline-size:min(420px,calc(100vw - 32px));pointer-events:none}
${TOAST}{position:relative;overflow:hidden;min-block-size:54px;padding:12px var(--space-2);padding-inline-start:56px;border-radius:var(--radius-notice);background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--shadow);font-size:14px;pointer-events:auto}
${TOAST}::before{content:"i";position:absolute;inset-block-start:12px;inset-inline-start:var(--space-2);inline-size:28px;block-size:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font:700 14px/28px var(--font-sans);text-align:center}
${TOAST}[data-toast-level=ok]{border-color:var(--ok-line)}
${TOAST}[data-toast-level=ok]::before{content:"\\2713";background:var(--ok-soft);color:var(--ok)}
${TOAST}:is([data-toast-level=critical],[data-toast-level=bad],[data-toast-level=error],[data-toast-level=warn])::before{content:"!";background:var(--bad-soft);color:var(--bad)}
${TOAST}[data-toast-level=warn]::before{background:var(--warn-soft);color:var(--warn)}
${TOAST}:is([data-toast-level=critical],[data-toast-level=bad],[data-toast-level=error]){border-color:var(--bad-line)}
${TOAST}[data-toast-level=warn]{border-color:var(--warn-line)}
${TOAST}>[aria-hidden]{position:absolute;inset-inline-start:0;inset-block-end:0;height:3px;background:var(--focus);animation:v2-drain 4s linear forwards}
`
