import { escapeHtml, hookAttrs, type HookAttributes } from '../html.ts'

export interface TabItem {
  id: string
  label: string
  /** The tab panel this tab controls. */
  panelId: string
  selected: boolean
  count?: number
  /** An empty count slot a controller fills later; it shows once it has text. Ignored when `count` is given. */
  countHooks?: HookAttributes
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
  `<div class="v2-tabs" role="tablist" aria-label="${escapeHtml(props.label)}"${hookAttrs(props.hooks)}>${props.tabs.map(tab => `<button type="button" role="tab" id="${escapeHtml(tab.id)}" aria-selected="${tab.selected}" aria-controls="${escapeHtml(tab.panelId)}" tabindex="${tab.selected ? '0' : '-1'}"${hookAttrs(tab.hooks)}>${escapeHtml(tab.label)}${tab.count !== undefined ? `<span class="v2-count v2-num">${tab.count}</span>` : tab.countHooks ? `<span class="v2-count v2-num"${hookAttrs(tab.countHooks)}></span>` : ''}</button>`).join('')}</div>`

export interface TabPanelProps {
  id: string
  /** Id of the tab that labels this panel. */
  tabId: string
  bodyHtml: string
  hidden?: boolean
  /** Page sections keep the approved 32px hierarchy instead of compact component spacing. */
  sectionSpacing?: boolean
  hooks?: HookAttributes
}

export const tabPanel = (props: TabPanelProps): string =>
  `<div class="v2-tabpanel${props.sectionSpacing ? ' v2-tabpanel--sections' : ''}" role="tabpanel" id="${escapeHtml(props.id)}" aria-labelledby="${escapeHtml(props.tabId)}" tabindex="0"${props.hidden ? ' hidden' : ''}${hookAttrs(props.hooks)}>${props.bodyHtml}</div>`

export const TABS_CSS = `.v2-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line)}
.v2-tabs>[role=tab]{display:inline-flex;align-items:center;gap:var(--space-1);min-height:var(--target);padding:0 12px;margin-bottom:-1px;scroll-margin-block-start:104px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font-size:14px;font-weight:500;cursor:pointer}
.v2-tabs>[role=tab]:hover{color:var(--text)}
.v2-tabs>[role=tab][aria-selected="true"]{border-bottom-color:var(--accent-fill);color:var(--text);font-weight:600}
.v2-tabs .v2-count{background:var(--sunken)}
.v2-tabs .v2-count:empty{display:none}
@media(max-width:600px){.v2-tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;scroll-snap-type:x proximity;scroll-padding-inline:var(--space-2);padding-inline-end:32px;mask-image:linear-gradient(to right,#000 calc(100% - 32px),transparent)}.v2-tabs:dir(rtl){mask-image:linear-gradient(to left,#000 calc(100% - 32px),transparent)}.v2-tabs>[role=tab]{flex:none;white-space:nowrap;scroll-snap-align:start}.v2-tabs>[aria-selected="true"]{scroll-initial-target:nearest}}
.v2-tabpanel{display:flex;flex-direction:column;gap:var(--space-2);padding-top:var(--space-2)}
.v2-tabpanel--sections{gap:var(--space-4);padding-top:0}
.v2-tabpanel--sections[hidden]{display:none}
`
