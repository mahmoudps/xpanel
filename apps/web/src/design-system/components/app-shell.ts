import { createDesignTranslator, escapeAttr, escapeHtml, joinClasses, type TextTranslator } from '../html.ts'

export interface ShellNavItem {
  readonly id: string
  readonly label: string
  readonly href: string
  readonly iconSvg?: string
  readonly current?: boolean
}

export interface ShellNavGroup {
  readonly id: string
  readonly title: string
  readonly items: readonly ShellNavItem[]
}

export interface AppShellProps {
  readonly surface: 'xwhm' | 'xpanel' | 'xmail'
  readonly locale?: string
  readonly brandHtml: string
  readonly navGroups: readonly ShellNavGroup[]
  readonly topbarHtml: string
  readonly contentHtml: string
  readonly collapsed?: boolean
  readonly overlaysHtml?: string
  readonly copy?: TextTranslator
}

export function renderAppShell(props: AppShellProps): string {
  const t = createDesignTranslator(props.copy)
  const collapsedAttr = props.collapsed ? ' data-sidebar-collapsed="true"' : ''
  const collapseLabel = props.collapsed ? t('Expand sidebar') : t('Collapse sidebar')

  const groupsHtml = props.navGroups
    .map(group => {
      const itemsHtml = group.items
        .map(item => {
          const currentAttr = item.current ? ' aria-current="page"' : ''
          const icon = item.iconSvg ? `<span class="ds-nav-link__icon" aria-hidden="true">${item.iconSvg}</span>` : ''
          return `<li><a class="ds-nav-link" href="${escapeAttr(item.href)}" data-nav-route="${escapeAttr(item.href)}"${currentAttr} title="${escapeAttr(item.label)}">${icon}<span class="ds-nav-link__label">${escapeHtml(item.label)}</span></a></li>`
        })
        .join('')
      return `<section class="ds-sidebar__group" aria-labelledby="nav-group-${escapeAttr(group.id)}"><h2 class="ds-sidebar__group-title" id="nav-group-${escapeAttr(group.id)}">${escapeHtml(group.title)}</h2><ul class="ds-sidebar__list">${itemsHtml}</ul></section>`
    })
    .join('')

  return `<div class="${joinClasses('ds-shell')}" data-surface="${escapeAttr(props.surface)}"${collapsedAttr}>` +
    `<aside class="ds-sidebar" data-xp-sidebar aria-label="${escapeAttr(t('Toggle navigation'))}">` +
      `<div class="ds-sidebar__brand">${props.brandHtml}` +
        `<button type="button" class="ds-btn ds-btn--ghost" data-action="toggle-sidebar-collapse" aria-label="${escapeAttr(collapseLabel)}" aria-pressed="${props.collapsed ? 'true' : 'false'}"><span aria-hidden="true">&lsaquo;</span></button>` +
      `</div>` +
      `<nav class="ds-sidebar__nav">${groupsHtml}</nav>` +
    `</aside>` +
    `<div class="ds-workspace">` +
      `<header class="ds-topbar">${props.topbarHtml}</header>` +
      `<main class="ds-main" id="main-content"><div class="ds-container">${props.contentHtml}</div></main>` +
    `</div>` +
    `${props.overlaysHtml ?? ''}` +
  `</div>`
}
