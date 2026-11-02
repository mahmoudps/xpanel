import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon, type IconName } from '../icons.ts'

export interface EmptyStateProps {
  icon: IconName
  title: string
  text?: string
  /** The next step, built with the kit (usually the primary action). */
  actionHtml?: string
  headingLevel?: 2 | 3
  hooks?: HookAttributes
}

export const emptyState = (props: EmptyStateProps): string => {
  const h = `h${props.headingLevel ?? 3}`
  return `<div class="v2-state v2-state--empty"${hookAttrs(props.hooks)}><span class="v2-state__icon" aria-hidden="true">${icon(props.icon, 22)}</span><${h}>${escapeHtml(props.title)}</${h}>${props.text ? `<p>${escapeHtml(props.text)}</p>` : ''}${props.actionHtml ?? ''}</div>`
}

export interface LoadingStateProps {
  /** What is loading, read by assistive technology, such as "Loading databases". */
  label?: string
  rows?: number
  hooks?: HookAttributes
}

/** Skeleton rows in the final layout so nothing jumps; one visually hidden label announces the wait. */
export const loadingState = (t: Translate, props: LoadingStateProps): string =>
  `<div class="v2-state v2-state--loading" aria-busy="true"${hookAttrs(props.hooks)}><span class="v2-sr" role="status">${escapeHtml(props.label ?? t('Loading'))}</span>${Array.from({ length: props.rows ?? 3 }, (_, i) => `<div class="v2-skeleton-row" aria-hidden="true"><span class="v2-skeleton v2-skeleton--tile"></span><span class="v2-skeleton-lines"><span class="v2-skeleton" style="inline-size:${[56, 44, 64][i % 3]}%"></span><span class="v2-skeleton v2-skeleton--thin" style="inline-size:${[32, 24, 40][i % 3]}%"></span></span></div>`).join('')}</div>`

export interface ErrorStateProps {
  /** Cause and consequence, such as "Databases could not be read." */
  lead: string
  text?: string
  /** Technical detail, such as the agent error line. */
  detail?: string
  /** Hooks of the controller that retries; without them no Retry button is shown. */
  retry?: HookAttributes
  hooks?: HookAttributes
}

export const errorState = (t: Translate, props: ErrorStateProps): string =>
  `<div class="v2-state v2-state--error" role="alert"${hookAttrs(props.hooks)}><p><strong>${escapeHtml(props.lead)}</strong>${props.text ? ` ${escapeHtml(props.text)}` : ''}</p>${props.detail ? `<code>${escapeHtml(props.detail)}</code>` : ''}${props.retry ? `<button type="button" class="v2-btn"${hookAttrs(props.retry)}>${icon('refresh', 16)}${escapeHtml(t('Retry'))}</button>` : ''}</div>`

export const STATE_BLOCK_CSS = `.v2-state--empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:var(--space-3) var(--space-2);border-radius:var(--radius-notice);border:1px dashed var(--line-strong);text-align:center}
.v2-state--empty>:is(h2,h3){font-size:16px}
.v2-state--empty>p{max-width:40ch;font-size:13px;color:var(--muted);line-height:1.6}
.v2-state__icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:var(--sunken);color:var(--muted)}
.v2-state--loading{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-state--error{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:var(--space-2);border-radius:var(--radius-notice);border:1px solid var(--bad-line);background:var(--bad-soft);font-size:13px;line-height:1.6}
.v2-state--error strong{color:var(--bad);font-weight:600}
.v2-state--error>code{display:block;align-self:stretch;padding:var(--space-1) 12px;border-radius:var(--radius-chip);background:var(--surface);border:1px solid var(--bad-line);font-size:12px;color:var(--text-2);overflow-wrap:anywhere}
.v2-skeleton-row{display:flex;align-items:center;gap:12px;animation:v2-pulse 1.6s ease-in-out infinite}
.v2-skeleton-lines{flex:1 1 auto;display:flex;flex-direction:column;gap:6px}
.v2-skeleton{display:block;height:10px;border-radius:5px;background:var(--sunken)}
.v2-skeleton--thin{height:8px}
.v2-skeleton--tile{flex:none;width:34px;height:34px;border-radius:9px}
.v2-skeleton--pill{flex:none;width:72px;height:22px;border-radius:var(--radius-pill)}
`
