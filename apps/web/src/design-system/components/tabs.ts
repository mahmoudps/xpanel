import { escapeAttr, escapeHtml } from '../html.ts'

export interface TabItem {
  readonly id: string
  readonly label: string
  readonly badgeHtml?: string
  readonly panelHtml: string
  readonly active?: boolean
}

export interface TabsProps {
  readonly id: string
  readonly ariaLabel: string
  readonly items: readonly TabItem[]
}

export function renderTabs(props: TabsProps): string {
  const activeIndex = Math.max(0, props.items.findIndex(item => item.active))
  const tabsHtml = props.items
    .map((item, index) => {
      const selected = index === activeIndex
      const tabId = `${props.id}-tab-${item.id}`
      const panelId = `${props.id}-panel-${item.id}`
      return `<button type="button" class="ds-tab" role="tab" id="${escapeAttr(tabId)}" aria-selected="${selected ? 'true' : 'false'}" aria-controls="${escapeAttr(panelId)}" tabindex="${selected ? '0' : '-1'}" data-ds-tab="${escapeAttr(item.id)}">${escapeHtml(item.label)}${item.badgeHtml ?? ''}</button>`
    })
    .join('')

  const panelsHtml = props.items
    .map((item, index) => {
      const selected = index === activeIndex
      const tabId = `${props.id}-tab-${item.id}`
      const panelId = `${props.id}-panel-${item.id}`
      return `<div class="ds-tab-panel" role="tabpanel" id="${escapeAttr(panelId)}" aria-labelledby="${escapeAttr(tabId)}"${selected ? '' : ' hidden'} data-ds-tabpanel="${escapeAttr(item.id)}">${item.panelHtml}</div>`
    })
    .join('')

  return `<div class="ds-tabs" id="${escapeAttr(props.id)}" data-ds-tabs>` +
    `<div class="ds-tab-list" role="tablist" aria-label="${escapeAttr(props.ariaLabel)}">${tabsHtml}</div>` +
    panelsHtml +
  `</div>`
}
