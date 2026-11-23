import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface DrawerProps {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly bodyHtml: string
  readonly footerHtml?: string
  readonly open?: boolean
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderDrawer(props: DrawerProps): string {
  const t = createDesignTranslator(props.copy)
  const titleId = `${props.id}-title`
  const hiddenAttr = props.open ? '' : ' hidden'

  return `<div class="ds-backdrop" id="${escapeAttr(props.id)}-backdrop" data-ds-drawer-backdrop="${escapeAttr(props.id)}"${hiddenAttr}></div>` +
    `<aside class="ds-drawer" id="${escapeAttr(props.id)}" role="dialog" aria-modal="true" aria-labelledby="${escapeAttr(titleId)}"${hiddenAttr}>` +
      `<header class="ds-drawer__head">` +
        `<div>` +
          `<h2 class="ds-card__title" id="${escapeAttr(titleId)}">${escapeHtml(props.title)}</h2>` +
          (props.description ? `<p class="ds-caption">${escapeHtml(props.description)}</p>` : '') +
        `</div>` +
        `<button type="button" class="ds-btn ds-btn--ghost" data-ds-drawer-close="${escapeAttr(props.id)}" aria-label="${escapeAttr(t('Close'))}">&times;</button>` +
      `</header>` +
      `<div class="ds-drawer__body">${props.bodyHtml}</div>` +
      (props.footerHtml ? `<footer class="ds-drawer__foot">${props.footerHtml}</footer>` : '') +
    `</aside>`
}
