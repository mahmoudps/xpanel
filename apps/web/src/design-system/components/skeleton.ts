import { createDesignTranslator, escapeHtml, type TextTranslator } from '../html.ts'

export type SkeletonVariant = 'title' | 'line' | 'metric' | 'row' | 'card'

export interface SkeletonProps {
  readonly variant?: SkeletonVariant
  readonly count?: number
  readonly locale?: string
  readonly loadingLabel?: string
  readonly copy?: TextTranslator
}

export function renderSkeleton(props: SkeletonProps): string {
  const t = createDesignTranslator(props.copy)
  const count = Math.max(1, Math.min(10, props.count ?? 1))
  const variant = props.variant ?? 'line'
  const items = Array.from({ length: count }, () => `<div class="ds-skeleton ds-skeleton--${variant}" aria-hidden="true"></div>`).join('')
  return `<div class="ds-live-read" role="status" aria-busy="true">` +
    `<span class="ds-sr-only">${escapeHtml(props.loadingLabel ?? t('Loading...'))}</span>` +
    items +
  `</div>`
}
