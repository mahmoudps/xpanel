import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'

export interface ConfirmDialogProps {
  readonly id: string
  readonly title: string
  readonly message: string
  readonly detailsHtml?: string
  readonly confirmLabel?: string
  readonly cancelLabel?: string
  readonly confirmAction?: string
  readonly destructive?: boolean
  readonly open?: boolean
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderConfirmDialog(props: ConfirmDialogProps): string {
  const t = createDesignTranslator(props.copy)
  const titleId = `${props.id}-title`
  const confirmClass = props.destructive ? 'ds-btn ds-btn--danger' : 'ds-btn ds-btn--primary'
  const openAttr = props.open ? ' open' : ''

  return `<dialog class="ds-dialog" id="${escapeAttr(props.id)}" aria-modal="true" aria-labelledby="${escapeAttr(titleId)}"${openAttr}>` +
    `<header class="ds-dialog__head">` +
      `<h2 class="ds-card__title" id="${escapeAttr(titleId)}">${escapeHtml(props.title)}</h2>` +
      `<button type="button" class="ds-btn ds-btn--ghost" data-ds-dialog-close aria-label="${escapeAttr(t('Close'))}">&times;</button>` +
    `</header>` +
    `<div class="ds-dialog__body">` +
      `<p class="ds-prose">${escapeHtml(props.message)}</p>` +
      (props.detailsHtml ?? '') +
    `</div>` +
    `<footer class="ds-dialog__foot">` +
      `<button type="button" class="ds-btn" data-ds-dialog-cancel>${escapeHtml(props.cancelLabel ?? t('Cancel'))}</button>` +
      `<button type="button" class="${confirmClass}" data-action="${escapeAttr(props.confirmAction ?? 'confirm-dialog')}">${escapeHtml(props.confirmLabel ?? t('Confirm'))}</button>` +
    `</footer>` +
  `</dialog>`
}
