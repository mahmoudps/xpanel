import { SOURCE_LOCALE, translator, type Locale } from '../i18n.ts'
import { formatAsciiNumber, normalizeAsciiDigits } from '../display-format.ts'

export type ActionBadgeKind = 'ok' | 'warn' | 'critical' | 'suspended' | 'reconciling'

export type AsyncActionStateKind =
  | 'idle'
  | 'loading'
  | 'pending'
  | 'succeeded'
  | 'denied'
  | 'failed'
  | 'unavailable'
  | 'conflict'

export interface AsyncActionBannerProps {
  state: AsyncActionStateKind
  locale?: Locale
  title?: string
  message?: string
  /** Internal routing identity; never a display reference. */
  jobId?: string
  /** Persisted official reference supplied by the authoritative server allocator. */
  jobReferenceCode?: string
  generationId?: number
  retryable?: boolean
  preserveDraft?: boolean
  httpStatus?: number
  errorCode?: string
}

// Source messages are translated once for every presentation.
const ACTION_STATE_COPY: Record<AsyncActionStateKind, { badge: ActionBadgeKind; badgeText: string; title: string; message: string }> = {
  idle: {
    badge: 'ok',
    badgeText: msgid('Ready'),
    title: msgid('Workspace ready'),
    message: msgid('All verified controls are synchronized with the current generation.'),
  },
  loading: {
    badge: 'reconciling',
    badgeText: msgid('Loading'),
    title: msgid('Loading live state...'),
    message: msgid('Fetching verified host and account state from the control plane.'),
  },
  pending: {
    badge: 'reconciling',
    badgeText: msgid('Queued / Reconciling'),
    title: msgid('Operation accepted and pending host verification'),
    message: msgid('Desired state has been recorded, or a background job is queued. Host changes are not yet active until reconciliation and health verification complete.'),
  },
  succeeded: {
    badge: 'ok',
    badgeText: msgid('Verified & Applied'),
    title: msgid('Operation verified on host'),
    message: msgid('Configuration passed syntax and health checks and is now active.'),
  },
  denied: {
    badge: 'critical',
    badgeText: msgid('Access Denied'),
    title: msgid('Permission denied for this operation'),
    message: msgid('Your current role or account scope is not authorized to perform this action.'),
  },
  failed: {
    badge: 'critical',
    badgeText: msgctxt('action-state', 'Failed'),
    title: msgid('Operation failed verification'),
    message: msgid('The host verifier rejected the change and automatically preserved the previous active generation. Your form draft has been retained.'),
  },
  unavailable: {
    badge: 'warn',
    badgeText: msgid('Unavailable'),
    title: msgid('Service or runtime dependency unavailable'),
    message: msgid('A required host tool, socket, or backend dependency is currently unverified or unreachable. No changes were applied.'),
  },
  conflict: {
    badge: 'warn',
    badgeText: msgid('Conflict (HTTP 409)'),
    title: msgid('Concurrent state modification or lock conflict'),
    message: msgid('Another reconciliation or resource update is currently in progress. Please review the latest state and retry; your draft input is preserved.'),
  },
}

export interface ActionStateMetadata {
  readonly kind: 'job-reference' | 'generation' | 'http' | 'error'
  readonly label?: string
  readonly value: string
}

/** Plain feedback facts shared by themes; internal routing identity is never part of display metadata. */
export interface ActionStateView {
  readonly state: AsyncActionStateKind
  readonly locale: Locale
  readonly badge: { readonly kind: ActionBadgeKind; readonly text: string }
  readonly title: string
  readonly message: string
  readonly role: 'alert' | 'status'
  readonly live: 'assertive' | 'polite'
  readonly busy: boolean
  readonly preserveDraft: boolean
  readonly retryable: boolean
  readonly metadata: readonly ActionStateMetadata[]
  /** Internal routing identity only. Do not render, copy, print or use as an official reference. */
  readonly internalJobId?: string
}

function actionMetadata(props: AsyncActionBannerProps, locale: Locale): ActionStateMetadata[] {
  const tr = translator(locale)
  const metadata: ActionStateMetadata[] = []
  if (props.jobId || props.jobReferenceCode !== undefined) {
    const official = typeof props.jobReferenceCode === 'string' && props.jobReferenceCode.trim()
      ? props.jobReferenceCode : tr('Unnumbered')
    metadata.push({ kind: 'job-reference', label: tr('Job Ref'), value: normalizeAsciiDigits(official) })
  }
  if (props.generationId !== undefined && props.generationId > 0) {
    metadata.push({ kind: 'generation', label: tr('Generation'), value: `#${formatAsciiNumber(props.generationId, { useGrouping: false })}` })
  }
  if (props.httpStatus !== undefined) {
    metadata.push({ kind: 'http', value: `HTTP ${formatAsciiNumber(props.httpStatus, { useGrouping: false })}` })
  }
  if (props.errorCode) metadata.push({ kind: 'error', value: normalizeAsciiDigits(props.errorCode) })
  return metadata
}

/** Retains the caller's actual action state; presentation never upgrades accepted work to verified success. */
export function projectActionState(props: AsyncActionBannerProps): ActionStateView {
  const locale = props.locale ?? SOURCE_LOCALE
  const tr = translator(locale)
  const source = ACTION_STATE_COPY[props.state] ?? ACTION_STATE_COPY.failed
  const alert = props.state === 'denied' || props.state === 'failed' || props.state === 'unavailable' || props.state === 'conflict'
  return {
    state: props.state, locale,
    badge: { kind: source.badge, text: normalizeAsciiDigits(tr(source.badgeText)) },
    title: normalizeAsciiDigits(props.title ?? tr(source.title)),
    message: normalizeAsciiDigits(props.message ?? tr(source.message)),
    role: alert ? 'alert' : 'status', live: alert ? 'assertive' : 'polite',
    busy: props.state === 'loading' || props.state === 'pending',
    preserveDraft: props.preserveDraft ?? (props.state !== 'succeeded' && props.state !== 'idle'),
    retryable: props.retryable === true, metadata: actionMetadata(props, locale),
    ...(props.jobId ? { internalJobId: props.jobId } : {}),
  }
}

