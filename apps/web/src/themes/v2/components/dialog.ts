import type { Translate } from '../../../i18n.ts'
import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface DialogProps {
  id: string
  title: string
  bodyHtml: string
  footerHtml?: string
  /** role="alertdialog" for confirmations of destructive actions (type to confirm, terminate). */
  alert?: boolean
  /** Id of the body element that describes the dialog (required reading for an alertdialog). */
  describedBy?: string
  close?: HookAttributes
  /** Dialogs render hidden; the overlay controller shows them. */
  open?: boolean
  hooks?: HookAttributes
}

export function dialog(t: Translate, props: DialogProps): string {
  const titleId = `${props.id}-title`
  return `<div class="v2-dialog" id="${escapeHtml(props.id)}" role="${props.alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="${escapeHtml(titleId)}"${attr('aria-describedby', props.describedBy)}${props.open ? '' : ' hidden'}${hookAttrs(props.hooks)}>
<div class="v2-dialog__panel">
<header class="v2-dialog__head"><h2 id="${escapeHtml(titleId)}">${escapeHtml(props.title)}</h2>${props.close ? `<button type="button" class="v2-btn v2-btn--icon v2-btn--bare" aria-label="${escapeHtml(t('Close'))}"${hookAttrs(props.close)}>${icon('x', 16)}</button>` : ''}</header>
<div class="v2-dialog__body">${props.bodyHtml}</div>
${props.footerHtml ? `<footer class="v2-dialog__foot">${props.footerHtml}</footer>` : ''}
</div>
</div>`
}

export const DIALOG_CSS = `.v2-dialog{position:fixed;inset:0;z-index:90;display:flex;align-items:flex-start;justify-content:center;padding:max(48px,10vh) var(--space-2) var(--space-2);background:var(--scrim);overflow-y:auto}
.v2-dialog__panel{inline-size:min(560px,100%);display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line-strong);box-shadow:0 12px 32px rgba(0,0,0,.18)}
.v2-dialog__head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);margin:-10px;margin-inline-start:0}
.v2-dialog__head h2{font-size:18px}
.v2-dialog__body{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-dialog__foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--space-1)}
`
