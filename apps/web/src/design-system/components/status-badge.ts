import { escapeHtml, joinClasses } from '../html.ts'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info'

export interface StatusBadgeProps {
  readonly label: string
  readonly tone?: BadgeTone
  readonly iconHtml?: string
}

export function renderStatusBadge(props: StatusBadgeProps): string {
  const toneClass = props.tone && props.tone !== 'neutral' ? `ds-badge--${props.tone}` : undefined
  return `<span class="${joinClasses('ds-badge', toneClass)}">${props.iconHtml ?? ''}${escapeHtml(props.label)}</span>`
}
