import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'
import { icon } from '../icons.ts'

export interface RowMenuItem {
  label: string
  /** Keyboard hint shown beside the item, such as "E". */
  shortcut?: string
  danger?: boolean
  separatorBefore?: boolean
  /** A link item navigates; otherwise the item is a button bound through its hooks. */
  href?: string
  hooks?: HookAttributes
}

export interface RowMenuProps {
  id: string
  /** Names the trigger and the menu, such as "Actions for alice". */
  label: string
  items: readonly RowMenuItem[]
  /** Hooks on the trigger, such as the `menu` verb of the `row-menu` template. */
  triggerHooks?: HookAttributes
  hooks?: HookAttributes
}

/** Row action menu: a 44px kebab trigger and a role="menu" list in a native popover, so it opens without
 *  script, escapes the table's scroll clipping (top layer) and closes on Escape or an outside click.
 *  Arrow-key roving focus between items belongs to a core menu controller. */
export function rowMenu(props: RowMenuProps): string {
  const label = escapeHtml(props.label)
  const items = props.items.map(item => {
    const content = `${escapeHtml(item.label)}${item.shortcut ? `<kbd aria-hidden="true">${escapeHtml(item.shortcut)}</kbd>` : ''}`
    const cls = `v2-menu__item${item.danger ? ' v2-menu__item--danger' : ''}`
    const control = item.href
      ? `<a role="menuitem" class="${cls}" href="${escapeHtml(item.href)}"${hookAttrs(item.hooks)}>${content}</a>`
      : `<button type="button" role="menuitem" class="${cls}"${hookAttrs(item.hooks)}>${content}</button>`
    return `${item.separatorBefore ? '<li role="separator"></li>' : ''}<li role="none">${control}</li>`
  }).join('')
  const id = escapeHtml(props.id)
  return `<span class="v2-menu"${hookAttrs(props.hooks)}><button type="button" class="v2-btn v2-btn--icon" popovertarget="${id}" aria-haspopup="menu" aria-controls="${id}" aria-label="${label}"${hookAttrs(props.triggerHooks)}>${icon('more')}</button><ul class="v2-menu__list" id="${id}" role="menu" aria-label="${label}" popover>${items}</ul></span>`
}

// Without CSS anchor positioning the popover keeps the browser's centered placement.
export const ROW_MENU_CSS = `.v2-menu{display:inline-flex}
.v2-menu>.v2-btn:has(+:popover-open){border-color:var(--accent);border-width:1.5px}
.v2-menu__list{min-inline-size:220px;list-style:none;padding:4px;border-radius:var(--radius-notice);background:var(--surface);color:var(--text);border:1px solid var(--line-strong);box-shadow:0 8px 24px rgba(0,0,0,.16);text-align:start}
.v2-menu__list:popover-open{display:flex;flex-direction:column}
@supports (position-area:block-end){.v2-menu__list{inset:auto;margin:4px 0 0;position-area:block-end span-inline-start;position-try-fallbacks:flip-block}}
.v2-menu__list [role=separator]{height:1px;margin:4px;background:var(--line)}
.v2-menu__item{display:flex;align-items:center;justify-content:space-between;gap:12px;inline-size:100%;min-height:var(--target);padding:0 12px;border:0;border-radius:var(--radius-chip);background:transparent;color:var(--text);font-size:14px;text-align:start;text-decoration:none;cursor:pointer}
.v2-menu__item:hover,.v2-menu__item:focus-visible{background:var(--subtle);color:var(--text)}
.v2-menu__item--danger,.v2-menu__item--danger:hover{color:var(--bad);font-weight:600}
.v2-menu__item kbd{font-size:11px;color:var(--muted)}
`
