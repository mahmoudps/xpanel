import type { Translate } from '../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface DrawerProps {
  id: string
  title: string
  bodyHtml: string
  /** Cancel and the primary action, built with the kit. */
  footerHtml?: string
  /** Hooks of the controller that closes the drawer; without them no close button is shown. */
  close?: HookAttributes
  hidden?: boolean
  hooks?: HookAttributes
}

/** Side panel for create/edit forms and row details. Place it beside the main content in a `.v2-split` row. */
export function drawer(t: Translate, props: DrawerProps): string {
  const titleId = `${props.id}-title`
  return `<aside class="v2-drawer" id="${escapeHtml(props.id)}" aria-labelledby="${escapeHtml(titleId)}"${props.hidden ? ' hidden' : ''}${hookAttrs(props.hooks)}>
<header class="v2-drawer__head"><h2 id="${escapeHtml(titleId)}">${escapeHtml(props.title)}</h2>${props.close ? `<button type="button" class="v2-btn v2-btn--icon v2-btn--bare" aria-label="${escapeHtml(t('Close'))}"${hookAttrs(props.close)}>${icon('x', 16)}</button>` : ''}</header>
<div class="v2-drawer__body">${props.bodyHtml}</div>
${props.footerHtml ? `<footer class="v2-drawer__foot">${props.footerHtml}</footer>` : ''}
</aside>`
}

export const DRAWER_CSS = `.v2-split{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-3)}
.v2-split>:first-child{flex:999 1 560px;min-width:0}
.v2-drawer{flex:1 1 380px;max-width:440px;min-width:0;display:flex;flex-direction:column;border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--shadow)}
.v2-drawer__head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);padding:12px;padding-inline-start:var(--space-3);border-bottom:1px solid var(--line)}
.v2-drawer__body{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3)}
.v2-drawer__foot{margin-top:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--space-1);padding:var(--space-2) var(--space-3);border-top:1px solid var(--line)}
.v2-btn--bare{border-color:transparent;background:transparent}
`
