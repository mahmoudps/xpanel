import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'
import { renderStatusBadge, type StatusBadgeProps } from './status-badge.ts'

export interface BreadcrumbItem {
  readonly label: string
  readonly href?: string
}

export interface PageHeaderProps {
  readonly title: string
  readonly description?: string
  readonly locale?: string
  readonly breadcrumbs?: readonly BreadcrumbItem[]
  readonly status?: StatusBadgeProps
  readonly primaryActionHtml?: string
  readonly secondaryMenuHtml?: string
  readonly copy?: TextTranslator
}

export function renderPageHeader(props: PageHeaderProps): string {
  const t = createDesignTranslator(props.copy)
  const crumbs = props.breadcrumbs?.length
    ? props.breadcrumbs
    : [{ label: props.title }]

  const breadcrumbsHtml = `<nav aria-label="${escapeAttr(t('Breadcrumb'))}"><ol class="ds-page-head__breadcrumbs">${crumbs
    .map((crumb, index) => {
      const isLast = index === crumbs.length - 1
      const separator = index > 0 ? '<span class="ds-icon--dir" aria-hidden="true">&rsaquo;</span>' : ''
      if (!isLast && crumb.href) {
        return `<li>${separator}<a href="${escapeAttr(crumb.href)}">${escapeHtml(crumb.label)}</a></li>`
      }
      const label = isLast ? props.title : crumb.label
      return `<li${isLast ? ' aria-current="page"' : ''}>${separator}<span>${escapeHtml(label)}</span></li>`
    })
    .join('')}</ol></nav>`

  const statusHtml = props.status ? renderStatusBadge(props.status) : ''
  const descHtml = props.description ? `<p class="ds-prose">${escapeHtml(props.description)}</p>` : ''
  const actionsHtml = (props.secondaryMenuHtml || props.primaryActionHtml)
    ? `<div class="ds-page-head__actions">${props.secondaryMenuHtml ?? ''}${props.primaryActionHtml ?? ''}</div>`
    : ''

  return `<header class="ds-page-head" data-page-header>` +
    breadcrumbsHtml +
    `<div class="ds-page-head__bar">` +
      `<div class="ds-page-head__title-group">` +
        `<div class="ds-page-head__title-row"><h1 class="ds-page-head__title">${escapeHtml(props.title)}</h1>${statusHtml}</div>` +
        descHtml +
      `</div>` +
      actionsHtml +
    `</div>` +
  `</header>`
}
