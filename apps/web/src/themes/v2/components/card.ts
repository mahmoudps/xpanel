import { attr, escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'

export interface CardProps {
  /** With a title the card is a labelled section; without one it is a plain surface. */
  title?: string
  /** Required with a title: the heading id the section is labelled by. */
  titleId?: string
  headingLevel?: 2 | 3
  description?: string
  /** Announces later changes of the description, such as a list's read summary (role="status"). */
  descriptionLive?: boolean
  descriptionHooks?: HookAttributes
  /** Header actions built with the kit, such as a count pill or a secondary button. */
  actionsHtml?: string
  bodyHtml: string
  footerHtml?: string
  /** Flush: the body runs edge to edge (tables, logs); header and footer keep their padding. */
  flush?: boolean
  id?: string
  hooks?: HookAttributes
}

export function card(props: CardProps): string {
  const cls = `v2-card${props.flush ? ' v2-card--flush' : ''}`
  const footer = props.footerHtml ? `<div class="v2-card__foot">${props.footerHtml}</div>` : ''
  if (props.title === undefined) {
    return `<div class="${cls}"${attr('id', props.id)}${hookAttrs(props.hooks)}><div class="v2-card__body">${props.bodyHtml}</div>${footer}</div>`
  }
  if (!props.titleId) throw new Error('A titled card needs titleId for aria-labelledby')
  const h = `h${props.headingLevel ?? 2}`
  const head = `<div class="v2-card__head"><div class="v2-card__title"><${h} id="${escapeHtml(props.titleId)}">${escapeHtml(props.title)}</${h}>${props.description ? `<p${props.descriptionLive ? ' role="status"' : ''}${hookAttrs(props.descriptionHooks)}>${escapeHtml(props.description)}</p>` : ''}</div>${props.actionsHtml ? `<div class="v2-card__actions">${props.actionsHtml}</div>` : ''}</div>`
  return `<section class="${cls}"${attr('id', props.id)} aria-labelledby="${escapeHtml(props.titleId)}"${hookAttrs(props.hooks)}>${head}<div class="v2-card__body">${props.bodyHtml}</div>${footer}</section>`
}

export const CARD_CSS = `.v2-card{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--v2-panel-padding);border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);min-width:0}
.v2-card__head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--space-1) var(--space-2)}
.v2-card__title{display:flex;flex-direction:column;gap:4px;min-width:0}
.v2-card__title p{font-size:13px;color:var(--muted)}
.v2-card__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-card__body{display:flex;flex-direction:column;gap:var(--space-2);min-width:0}
.v2-card__foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:var(--space-1)}
.v2-card--flush{padding:0;gap:0;overflow:hidden}
.v2-card--flush>.v2-card__body{gap:0}
.v2-card--flush>:is(.v2-card__head,.v2-card__foot){padding:var(--v2-panel-padding)}
.v2-card--flush>.v2-card__foot{padding-block:var(--space-1);border-top:1px solid var(--line)}
`
