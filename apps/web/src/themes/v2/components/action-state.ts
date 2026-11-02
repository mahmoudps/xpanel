import type { ActionStateView } from '../../../models/action-state.ts'
import { escapeHtml, type Tone } from '../html.ts'
import { statusPill } from './status-pill.ts'

const TONES: Readonly<Record<ActionStateView['badge']['kind'], Tone>> = {
  ok: 'ok', warn: 'warn', critical: 'bad', suspended: 'neutral', reconciling: 'info',
}

/** Displays core's actual outcome. Retry eligibility is metadata, never an operation or a success acknowledgement. */
export function actionState(view: ActionStateView): string {
  const metadata = view.metadata.length ? `<ul class="v2-action-state__metadata">${view.metadata.map(item => `<li data-action-meta="${item.kind}">${item.label ? `<span class="v2-action-state__label">${escapeHtml(item.label)}</span>` : ''}<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(item.value)}</bdi></li>`).join('')}</ul>` : ''
  return `<section class="v2-action-state" role="${view.role}" aria-live="${view.live}" aria-busy="${view.busy}" data-action-state="${view.state}" data-preserve-draft="${view.preserveDraft}" data-retryable="${view.retryable}" data-deceptive-success="false"><div class="v2-action-state__head">${statusPill({ tone: TONES[view.badge.kind], label: view.badge.text })}<strong>${escapeHtml(view.title)}</strong></div><p>${escapeHtml(view.message)}</p>${metadata}</section>`
}

export const ACTION_STATE_CSS = `.v2-action-state{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);min-inline-size:0}
.v2-action-state__head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2)}
.v2-action-state__head>strong{font-size:14px;font-weight:600;min-inline-size:0;overflow-wrap:anywhere}
.v2-action-state>p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.v2-action-state__metadata{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-2);list-style:none;padding:0;margin:0}
.v2-action-state__metadata>li{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);max-inline-size:100%;min-inline-size:0;font-size:12px;overflow-wrap:anywhere}
.v2-action-state__label{color:var(--muted)}
.v2-action-state__metadata bdi{unicode-bidi:isolate;text-align:start;max-inline-size:100%;overflow-wrap:anywhere}
.v2-action-state[data-action-state=denied],.v2-action-state[data-action-state=failed]{border-color:var(--bad-line);background:var(--bad-soft)}
.v2-action-state[data-action-state=unavailable],.v2-action-state[data-action-state=conflict]{border-color:var(--warn-line);background:var(--warn-soft)}
.v2-action-state[data-action-state=loading],.v2-action-state[data-action-state=pending]{border-color:var(--accent-line);background:var(--accent-soft)}
.v2-action-state[data-action-state=succeeded]{border-color:var(--ok-line);background:var(--ok-soft)}
@media(max-width:767px){.v2-action-state{padding:var(--space-2)}}
`
