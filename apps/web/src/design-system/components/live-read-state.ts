import { formatDateTimeHtml } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, type TextTranslator } from '../html.ts'
import { renderErrorState } from './error-state.ts'
import { renderSkeleton } from './skeleton.ts'

export type LiveReadStatus = 'loading' | 'ready' | 'error' | 'disabled'

export interface LiveReadStateProps {
  readonly status: LiveReadStatus
  readonly contentHtml?: string
  readonly lastReadAt?: string | Date | number | null
  readonly timeZone?: string
  readonly locale?: string
  readonly refreshAction?: string
  readonly errorTitle?: string
  readonly errorMessage?: string
  readonly enableHref?: string
  readonly enableLabel?: string
  readonly copy?: TextTranslator
}

export function renderLiveReadState(props: LiveReadStateProps): string {
  const t = createDesignTranslator(props.copy)

  if (props.status === 'loading') {
    return renderSkeleton({ variant: 'card', count: 1, locale: props.locale, copy: props.copy })
  }

  if (props.status === 'error') {
    return renderErrorState({
      title: props.errorTitle ?? t('Validation failed'),
      message: props.errorMessage ?? t('Retry'),
      variant: 'error',
      retryAction: props.refreshAction ?? 'refresh-read',
      locale: props.locale,
      copy: props.copy,
    })
  }

  if (props.status === 'disabled') {
    return renderErrorState({
      title: props.errorTitle ?? t('Unavailable'),
      message: props.errorMessage ?? t('Enable service'),
      variant: 'forbidden',
      enableHref: props.enableHref,
      enableLabel: props.enableLabel,
      locale: props.locale,
      copy: props.copy,
    })
  }

  const tsHtml = props.lastReadAt
    ? `<span>${escapeHtml(t('Last updated'))}: ${formatDateTimeHtml(props.lastReadAt, { locale: props.locale, timeZone: props.timeZone })}</span>`
    : '<span></span>'
  const refreshBtn = props.refreshAction
    ? `<button type="button" class="ds-btn ds-btn--ghost" data-action="${escapeAttr(props.refreshAction)}">${escapeHtml(t('Refresh'))}</button>`
    : ''

  return `<div class="ds-live-read">` +
    `<div class="ds-live-read__meta">${tsHtml}${refreshBtn}</div>` +
    (props.contentHtml ?? '') +
  `</div>`
}
