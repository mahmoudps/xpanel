import { createDesignTranslator, escapeAttr, escapeHtml, joinClasses, type TextTranslator } from '../html.ts'

export type ToastTone = 'info' | 'ok' | 'warn' | 'bad'

export interface ToastProps {
  readonly id: string
  readonly title: string
  readonly message?: string
  readonly tone?: ToastTone
  readonly undoAction?: string
  readonly undoLabel?: string
  readonly locale?: string
  readonly copy?: TextTranslator
}

export function renderToast(props: ToastProps): string {
  const t = createDesignTranslator(props.copy)
  const toneClass = props.tone && props.tone !== 'info' ? `ds-toast--${props.tone}` : undefined
  const undoBtn = props.undoAction
    ? `<button type="button" class="ds-btn ds-btn--ghost" data-action="${escapeAttr(props.undoAction)}">${escapeHtml(props.undoLabel ?? t('Undo'))}</button>`
    : ''

  return `<div class="${joinClasses('ds-toast', toneClass)}" role="status" data-ds-toast="${escapeAttr(props.id)}">` +
    `<div>` +
      `<strong>${escapeHtml(props.title)}</strong>` +
      (props.message ? `<p class="ds-caption">${escapeHtml(props.message)}</p>` : '') +
    `</div>` +
    `<div class="ds-page-head__actions">${undoBtn}<button type="button" class="ds-btn ds-btn--ghost" data-ds-toast-dismiss="${escapeAttr(props.id)}" aria-label="${escapeAttr(t('Close'))}">&times;</button></div>` +
  `</div>`
}

export function renderToastRegion(toasts: readonly ToastProps[] = []): string {
  return `<div class="ds-toast-region" id="xp-toast-region" aria-live="polite" aria-atomic="true">${toasts.map(renderToast).join('')}</div>`
}
