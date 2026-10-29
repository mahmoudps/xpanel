import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'

export interface TabItem {
  id: string
  label: string
  /** The tab panel this tab controls. */
  panelId: string
  selected: boolean
  count?: number
  hooks?: HookAttributes
}

export interface TabsProps {
  /** Names the tab list, such as "Site settings". */
  label: string
  tabs: readonly TabItem[]
  hooks?: HookAttributes
}

/** Tab list; only the selected tab is in the Tab sequence (arrow keys move between tabs in the core controller). */
export const tabs = (props: TabsProps): string =>
  `<div class="v2-tabs" role="tablist" aria-label="${escapeHtml(props.label)}"${hookAttrs(props.hooks)}>${props.tabs.map(tab => `<button type="button" role="tab" id="${escapeHtml(tab.id)}" aria-selected="${tab.selected}" aria-controls="${escapeHtml(tab.panelId)}" tabindex="${tab.selected ? '0' : '-1'}"${hookAttrs(tab.hooks)}>${escapeHtml(tab.label)}${tab.count === undefined ? '' : `<span class="v2-count v2-num">${tab.count}</span>`}</button>`).join('')}</div>`

export interface TabPanelProps {
  id: string
  /** Id of the tab that labels this panel. */
  tabId: string
  bodyHtml: string
  hidden?: boolean
  hooks?: HookAttributes
}

export const tabPanel = (props: TabPanelProps): string =>
  `<div class="v2-tabpanel" role="tabpanel" id="${escapeHtml(props.id)}" aria-labelledby="${escapeHtml(props.tabId)}" tabindex="0"${props.hidden ? ' hidden' : ''}${hookAttrs(props.hooks)}>${props.bodyHtml}</div>`

export const TABS_CSS = `.v2-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line)}
.v2-tabs>[role=tab]{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--target);padding:0 14px;margin-bottom:-1px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font-size:14px;font-weight:500;cursor:pointer}
.v2-tabs>[role=tab]:hover{color:var(--text)}
.v2-tabs>[role=tab][aria-selected="true"]{border-bottom-color:var(--accent-fill);color:var(--text);font-weight:600}
.v2-tabs .v2-count{background:var(--sunken)}
.v2-tabpanel{display:flex;flex-direction:column;gap:var(--space-2);padding-top:var(--space-2)}
`
