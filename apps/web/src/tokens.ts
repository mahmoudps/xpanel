// xPanel Design System tokens, CSS stylesheet, and accessible status/meter primitives.
// Follows docs/STANDARDS.md: OKLCH light & dark themes (no pure #000), logical RTL/LTR properties,
// 1.618:1 main:aside split, compact reference typography, >= 44px ergonomic hit targets,
// tabular numerals on all metrics/IPs/IDs, and icon + text on every status badge and threshold meter.

import { resolveResourceUsage, type ResourceQuantityState } from '@xpanel/core'
import { ARABIC_TYPE_CSS } from './arabic-type.ts'
import { MAIL_LAYOUT_CSS } from './mail-layout.ts'

export type StatusBadgeKind = 'ok' | 'warn' | 'critical' | 'suspended' | 'reconciling'
export type ThresholdLevel = 'ok' | 'warn' | 'critical'
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
  locale?: 'en' | 'ar'
  title?: string
  message?: string
  jobId?: string
  generationId?: number
  retryable?: boolean
  preserveDraft?: boolean
  httpStatus?: number
  errorCode?: string
}

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

const EASTERN_ARABIC_ZERO = 0x0660
const EXTENDED_ARABIC_ZERO = 0x06f0

/**
 * Converts Eastern Arabic (U+0660-U+0669) and Extended Arabic-Indic (U+06F0-U+06F9) numerals to ASCII (0-9).
 */
export function normalizeAsciiDigits(input: string | number): string {
  const raw = typeof input === 'number' ? String(input) : input
  if (raw.length === 0) return ''
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    if (code >= EASTERN_ARABIC_ZERO && code <= EASTERN_ARABIC_ZERO + 9) {
      out += String(code - EASTERN_ARABIC_ZERO)
    } else if (code >= EXTENDED_ARABIC_ZERO && code <= EXTENDED_ARABIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_ZERO)
    } else if (code === 0x066b) {
      out += '.'
    } else if (code === 0x066c) {
      out += ','
    } else {
      out += raw[i]!
    }
  }
  return out
}

/**
 * Formats a number deterministically using Western ASCII digits (`0-9`) regardless of active locale.
 */
export function formatAsciiNumber(
  value: number,
  opts: { decimals?: number; useGrouping?: boolean } = {},
): string {
  if (!Number.isFinite(value)) return '0'
  const decimals = opts.decimals
  const useGrouping = opts.useGrouping ?? true
  const fixed = decimals !== undefined ? value.toFixed(decimals) : String(value)
  const [intPartRaw, fracPart] = fixed.split('.')
  const sign = intPartRaw?.startsWith('-') ? '-' : ''
  const digits = (sign ? intPartRaw!.slice(1) : intPartRaw) ?? '0'
  const grouped = useGrouping ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : digits
  return fracPart !== undefined && fracPart.length > 0 ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`
}

/**
 * Formats a percentage using Western ASCII digits (`0-9`).
 */
export function formatAsciiPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return '0%'
  const rounded = Number(value.toFixed(decimals))
  const text = rounded % 1 === 0 ? String(Math.trunc(rounded)) : rounded.toFixed(decimals)
  return `${text}%`
}

/**
 * Formats an ISO timestamp or Date into `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS UTC` with ASCII digits (`0-9`).
 */
export function formatAsciiDate(
  isoOrDate: string | Date,
  opts: { includeTime?: boolean } = {},
): string {
  const d = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate
  if (Number.isNaN(d.getTime())) {
    return normalizeAsciiDigits(typeof isoOrDate === 'string' ? isoOrDate : '')
  }
  const iso = d.toISOString()
  if (opts.includeTime) {
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
  }
  return iso.slice(0, 10)
}

/**
 * UTC clock `HH:MM UTC`. The panel stores instants in UTC and has no chosen zone,
 * so every server clock uses this label instead of a bare hour.
 */
export function formatUtcClock(isoOrDate: string | Date): string {
  const full = formatAsciiDate(isoOrDate, { includeTime: true })
  const clock = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2} UTC$/.exec(full)
  return clock ? `${clock[1]} UTC` : full
}

/** UTC calendar day `YYYY-MM-DD UTC`, the date form of {@link formatUtcClock}. */
export function formatUtcDay(isoOrDate: string | Date): string {
  const day = formatAsciiDate(isoOrDate)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} UTC` : day
}

/**
 * Escapes arbitrary strings for safe interpolation into HTML text and attributes.
 */
export function escapeHtml(str: string): string {
  if (str.length === 0) return ''
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch)
}

/**
 * Wraps a technical LTR identifier (domain, path, IP, email, port, unit, digest, job ID)
 * in `<bdi dir="ltr">` with normalized ASCII digits so RTL context never scrambles token order.
 */
export function renderLtrValue(value: string | number, className?: string): string {
  const safe = escapeHtml(normalizeAsciiDigits(value))
  const cls = className ? ` class="${escapeHtml(className)}"` : ''
  return `<bdi dir="ltr"${cls}>${safe}</bdi>`
}

/**
 * Determines the unified threshold severity level:
 * - normal (`ok`): < 80%
 * - warning (`warn`): >= 80% and < 95%
 * - critical (`critical`): >= 95%
 */
export function getThresholdLevel(percent: number): ThresholdLevel {
  if (!Number.isFinite(percent) || percent < 80) return 'ok'
  if (percent < 95) return 'warn'
  return 'critical'
}

/**
 * Formats byte counts in decimal units (powers of 1000), labelled B/KB/MB/GB/TB,
 * so a figure matches `df -H` and a hosting provider's GB. Digits stay ASCII.
 */
export function formatAsciiBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let val = bytes
  let unitIdx = 0
  while (val >= 1000 && unitIdx < units.length - 1) {
    val /= 1000
    unitIdx++
  }
  const decimals = unitIdx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2
  return `${ normalizeAsciiDigits(val.toFixed(decimals)) } ${units[unitIdx]}`
}

export function formatBytes(bytes: number): string {
  return formatAsciiBytes(bytes)
}

/**
 * Inline SVG icons for status badges and threshold meters so meaning is never conveyed by color alone.
 */
function renderStatusSvg(status: StatusBadgeKind): string {
  switch (status) {
    case 'ok':
      // Checkmark circle icon
      return `<svg class="xp-status-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.2L7.1 10.1L10.8 6.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    case 'warn':
      // Warning triangle icon
      return `<svg class="xp-status-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2L14.4 13.5H1.6L8 2.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5V9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.85" fill="currentColor"/></svg>`
    case 'critical':
      // Octagon alert icon
      return `<svg class="xp-status-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.3 1.8H10.7L14.2 5.3V10.7L10.7 14.2H5.3L1.8 10.7V5.3L5.3 1.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 5.2V8.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.1" r="0.85" fill="currentColor"/></svg>`
    case 'reconciling':
      // Animated spinner icon
      return `<svg class="xp-status-icon xp-status-icon--spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.6"/><path d="M14.2 8A6.2 6.2 0 0 0 8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`
    case 'suspended':
      // Pause icon
      return `<svg class="xp-status-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 5.6V10.4M9.6 5.6V10.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`
  }
}

const DEFAULT_STATUS_LABELS: Record<StatusBadgeKind, string> = {
  ok: 'Healthy',
  warn: 'Warning',
  critical: 'Critical',
  suspended: 'Suspended',
  reconciling: 'Reconciling',
}

/**
 * Renders an accessible status badge that pairs a semantic SVG icon with an explicit label word.
 * Never relies on colour alone (WCAG 2.2 AA 1.4.1).
 */
export function renderStatusBadge(status: StatusBadgeKind, label: string): string {
  const text = label.trim().length > 0 ? label.trim() : DEFAULT_STATUS_LABELS[status]
  const safeText = escapeHtml(text)
  const svg = renderStatusSvg(status)
  return `<span class="xp-badge xp-badge--${status}" data-status="${status}" role="status">${svg}<span class="xp-badge__label">${safeText}</span></span>`
}

export interface ResourceMeterOptions {
  locale: 'en' | 'ar'
  label: string
  unit?: string
  /** A desired-state cap is not evidence of effective host enforcement. */
  configuredLimit?: boolean
}

const meterPercentText = (percent: number, threshold: ThresholdLevel, positiveUsage: boolean): string => {
  if (positiveUsage && percent < 0.05) return '<0.1%'
  const rounded = percent >= 1e21 ? percent : Math.round(percent * 10) / 10
  if (threshold === 'ok' && rounded >= 80) return '<80%'
  if (threshold === 'warn' && rounded >= 95) return '<95%'
  if (percent > 100 && rounded <= 100) return '>100%'
  return `${formatAsciiNumber(rounded, { useGrouping: false })}%`
}

/** Static utilization of supplied same-unit values; no origin or service-health attestation. */
export function renderThresholdMeter(used: unknown, limit: unknown, options: ResourceMeterOptions): string {
  if (!options.label.trim()) throw new TypeError('A resource meter requires a nonempty accessible label')
  const usage = resolveResourceUsage(used, limit)
  const isAr = options.locale === 'ar'
  const text = (en: string, ar: string): string => isAr ? ar : en
  const unavailable = text('Unavailable', 'غير متاح')
  const unlimited = text('Unlimited', 'غير محدود')
  const value = (part: ResourceQuantityState): string => part.availability !== 'known' ? unavailable
    : part.value === 'unlimited' ? unlimited : formatAsciiNumber(part.value as number)
  const suffix = options.unit?.trim() ? ` ${normalizeAsciiDigits(options.unit.trim())}` : ''
  const valuesText = `${value(usage.used)} / ${value(usage.limit)}${suffix}`
  const configured = options.configuredLimit ? `<span class="xp-meter__basis">${text('Configured limit', 'الحد المعيّن')}</span>` : ''
  let word: string, threshold: ThresholdLevel | undefined
  switch (usage.kind) {
    case 'bounded':
      threshold = usage.threshold
      word = usage.usedValue > usage.limitValue ? text('Limit exceeded', 'تجاوز الحد')
        : threshold === 'critical' ? text('Critical', 'حرج')
          : threshold === 'warn' ? text('Warning', 'تحذير') : text('Within limit', 'ضمن الحد')
      break
    case 'zero-limit':
      threshold = usage.exceeded ? 'critical' : undefined
      word = usage.exceeded ? text('Limit exceeded', 'تجاوز الحد') : text('No allocation', 'لا تخصيص')
      break
    case 'unbounded-allocation': threshold = 'critical'; word = text('Limit exceeded', 'تجاوز الحد'); break
    case 'unlimited': word = unlimited; break
    case 'unavailable': word = unavailable; break
  }
  const percent = usage.kind === 'bounded' && usage.percent !== null ? meterPercentText(usage.percent, usage.threshold, usage.usedValue > 0) : undefined
  const partHtml = (part: ResourceQuantityState, key: 'used' | 'limit') => `<bdi dir="${isAr && (part.value === 'unlimited' || part.availability !== 'known') ? 'rtl' : 'ltr'}" data-resource-part="${key}">${escapeHtml(value(part))}</bdi>`
  const valuesHtml = `<bdi dir="ltr">${partHtml(usage.used, 'used')} / ${partHtml(usage.limit, 'limit')}${suffix ? ` <bdi dir="auto">${escapeHtml(suffix.trim())}</bdi>` : ''}${percent ? ` (${escapeHtml(percent)})` : ''}</bdi>`
  const severity = threshold ? ` xp-meter--${threshold}` : ' xp-meter--neutral'
  const thresholdAttribute = threshold ? ` data-threshold="${threshold}"` : ''
  const icon = threshold && threshold !== 'ok' ? renderStatusSvg(threshold) : ''
  const track = usage.kind === 'bounded'
    ? `<div class="xp-meter__track" role="meter" aria-label="${escapeHtml(normalizeAsciiDigits(options.label))}" aria-valuemin="0" aria-valuemax="${usage.limitValue}" aria-valuenow="${Math.min(usage.usedValue, usage.limitValue)}" aria-valuetext="${escapeHtml(`${valuesText}${percent ? ` (${percent})` : ''}; ${word}${options.configuredLimit ? `; ${text('Configured limit', 'الحد المعيّن')}` : ''}`)}"><div class="xp-meter__fill xp-meter__fill--${usage.threshold}" style="width: ${usage.fillPercent}%"></div></div>`
    : ''
  return `<div class="xp-meter${severity}" data-resource-state="${usage.kind}"${thresholdAttribute} role="group" aria-label="${escapeHtml(normalizeAsciiDigits(options.label))}"><div class="xp-meter__header"><span class="xp-meter__values xp-tabular">${valuesHtml}</span><span class="xp-meter__status">${icon}<span class="xp-meter__word">${escapeHtml(word)}</span></span></div>${track}${configured}</div>`
}

/**
 * Classifies an HTTP / job / reconcile outcome into an explicit non-deceptive UI state.
 * Crucially, HTTP 202 (Accepted) or `status: 'queued' | 'running' | 'pending'` or `observed: false`
 * ALWAYS maps to `'pending'` (never `'succeeded'`), preventing false "Applied" banners before
 * privileged agent reconciliation or background job execution completes.
 */
export function classifyHttpActionState(input: {
  httpStatus: number
  status?: string
  observed?: boolean
  errorCode?: string
}): AsyncActionStateKind {
  const code = (input.errorCode ?? '').toUpperCase()
  const st = (input.status ?? '').toLowerCase()
  if (
    input.httpStatus === 202 ||
    st === 'queued' ||
    st === 'running' ||
    st === 'pending' ||
    input.observed === false
  ) {
    return 'pending'
  }
  if (
    input.httpStatus === 401 ||
    input.httpStatus === 403 ||
    code === 'FORBIDDEN' ||
    code === 'UNAUTHENTICATED'
  ) {
    return 'denied'
  }
  if (input.httpStatus === 409 || code === 'CONFLICT') {
    return 'conflict'
  }
  if (
    input.httpStatus === 412 ||
    input.httpStatus === 503 ||
    code === 'PRECONDITION_FAILED' ||
    code === 'UNAVAILABLE' ||
    st === 'unavailable'
  ) {
    return 'unavailable'
  }
  if (input.httpStatus >= 400 || st === 'failed' || st === 'rolled_back') {
    return 'failed'
  }
  if (input.httpStatus >= 200 && input.httpStatus < 300) {
    return 'succeeded'
  }
  return 'failed'
}

const ACTION_STATE_COPY: Record<
  'en' | 'ar',
  Record<AsyncActionStateKind, { badge: StatusBadgeKind; badgeText: string; title: string; message: string }>
> = {
  en: {
    idle: {
      badge: 'ok',
      badgeText: 'Ready',
      title: 'Workspace ready',
      message: 'All verified controls are synchronized with the current generation.',
    },
    loading: {
      badge: 'reconciling',
      badgeText: 'Loading',
      title: 'Loading live state...',
      message: 'Fetching verified host and account state from the control plane.',
    },
    pending: {
      badge: 'reconciling',
      badgeText: 'Queued / Reconciling',
      title: 'Operation accepted and pending host verification',
      message:
        'Desired state has been recorded, or a background job is queued. Host changes are not yet active until reconciliation and health verification complete.',
    },
    succeeded: {
      badge: 'ok',
      badgeText: 'Verified & Applied',
      title: 'Operation verified on host',
      message: 'Configuration passed syntax and health checks and is now active.',
    },
    denied: {
      badge: 'critical',
      badgeText: 'Access Denied',
      title: 'Permission denied for this operation',
      message: 'Your current role or account scope is not authorized to perform this action.',
    },
    failed: {
      badge: 'critical',
      badgeText: 'Failed',
      title: 'Operation failed verification',
      message:
        'The host verifier rejected the change and automatically preserved the previous active generation. Your form draft has been retained.',
    },
    unavailable: {
      badge: 'warn',
      badgeText: 'Unavailable',
      title: 'Service or runtime dependency unavailable',
      message:
        'A required host tool, socket, or backend dependency is currently unverified or unreachable. No changes were applied.',
    },
    conflict: {
      badge: 'warn',
      badgeText: 'Conflict (HTTP 409)',
      title: 'Concurrent state modification or lock conflict',
      message:
        'Another reconciliation or resource update is currently in progress. Please review the latest state and retry; your draft input is preserved.',
    },
  },
  ar: {
    idle: {
      badge: 'ok',
      badgeText: 'جاهز',
      title: 'مساحة العمل جاهزة',
      message: 'جميع الأدوات الموثقة متزامنة مع الجيل النشط حالياً.',
    },
    loading: {
      badge: 'reconciling',
      badgeText: 'جارٍ التحميل',
      title: 'جارٍ تحميل الحالة المباشرة...',
      message: 'يتم جلب الحالة الموثقة للخادم والحساب من منصة التحكم.',
    },
    pending: {
      badge: 'reconciling',
      badgeText: 'قيد الانتظار والمطابقة',
      title: 'تم استلام العملية وهي بانتظار التحقق على الخادم',
      message:
        'تم تسجيل الحالة المطلوبة أو جدولة المهمة في الخلفية. لن تصبح التغييرات فعالة على الخادم حتى تكتمل المطابقة وفحوصات الصحة.',
    },
    succeeded: {
      badge: 'ok',
      badgeText: 'مطبّق ومؤكد',
      title: 'تم التحقق من العملية وتطبيقها على الخادم',
      message: 'اجتازت الإعدادات فحوصات الصلاحية والصحة وأصبحت نشطة الآن.',
    },
    denied: {
      badge: 'critical',
      badgeText: 'مرفوض الصلاحية',
      title: 'ليست لديك صلاحية لتنفيذ هذه العملية',
      message: 'الدور الحالي أو نطاق الحساب غير مخوّل لتنفيذ هذا الإجراء.',
    },
    failed: {
      badge: 'critical',
      badgeText: 'فشل التنفيذ',
      title: 'فشل التحقق من العملية',
      message:
        'رفض مدقق الخادم التغيير وحافظ تلقائياً على الجيل النشط السابق. تم الاحتفاظ بمسودة النموذج الخاصة بك.',
    },
    unavailable: {
      badge: 'warn',
      badgeText: 'غير متاح',
      title: 'الخدمة أو الأداة المطلوبة غير متاحة حالياً',
      message:
        'إحدى أدوات النظام أو قنوات الاتصال المطلوبة غير موثقة أو غير متاحة حالياً. لم يتم تطبيق أي تغيير.',
    },
    conflict: {
      badge: 'warn',
      badgeText: 'تعارض (HTTP 409)',
      title: 'تعارض في تعديل الحالة أو قفل المطابقة',
      message:
        'توجد عملية مطابقة أو تحديث آخر قيد التنفيذ حالياً. يرجى مراجعة أحدث حالة وإعادة المحاولة؛ تم الاحتفاظ بمدخلاتك.',
    },
  },
}

/**
 * Renders an explicit, accessible async action / availability status banner (`loading`, `pending`,
 * `succeeded`, `denied`, `failed`, `unavailable`, `conflict`) with `<bdi dir="ltr">` isolation on
 * technical job/generation references and draft-preservation metadata.
 */
export function renderAsyncActionState(props: AsyncActionBannerProps): string {
  const locale = props.locale === 'ar' ? 'ar' : 'en'
  const copy = ACTION_STATE_COPY[locale][props.state] ?? ACTION_STATE_COPY[locale].failed
  const isAlert =
    props.state === 'denied' ||
    props.state === 'failed' ||
    props.state === 'unavailable' ||
    props.state === 'conflict'
  const isBusy = props.state === 'loading' || props.state === 'pending'
  const role = isAlert ? 'alert' : 'status'
  const preserveDraft =
    props.preserveDraft ??
    (props.state !== 'succeeded' && props.state !== 'idle')
  const title = normalizeAsciiDigits(props.title ?? copy.title)
  const message = normalizeAsciiDigits(props.message ?? copy.message)

  const metaParts: string[] = []
  if (props.jobId) {
    const label = locale === 'ar' ? 'معرّف المهمة' : 'Job Ref'
    metaParts.push(
      `<span>${escapeHtml(label)}: <code class="xp-mono">${renderLtrValue(props.jobId)}</code></span>`,
    )
  }
  if (props.generationId !== undefined && props.generationId > 0) {
    const label = locale === 'ar' ? 'الجيل' : 'Generation'
    metaParts.push(
      `<span>${escapeHtml(label)}: <code class="xp-mono">${renderLtrValue(`#${formatAsciiNumber(props.generationId, { useGrouping: false })}`)}</code></span>`,
    )
  }
  if (props.httpStatus !== undefined) {
    metaParts.push(
      `<span class="xp-tabular"><code class="xp-mono">${renderLtrValue(`HTTP ${formatAsciiNumber(props.httpStatus, { useGrouping: false })}`)}</code></span>`,
    )
  }
  if (props.errorCode) {
    metaParts.push(`<code class="xp-mono">${renderLtrValue(props.errorCode)}</code>`)
  }

  return (
    `<section class="xp-action-state xp-action-state--${props.state}" role="${role}" aria-live="${isAlert ? 'assertive' : 'polite'}" aria-busy="${isBusy ? 'true' : 'false'}" data-action-state="${props.state}" data-preserve-draft="${preserveDraft ? 'true' : 'false'}" data-deceptive-success="false">` +
    `<div class="xp-action-state__header">` +
    renderStatusBadge(copy.badge, normalizeAsciiDigits(copy.badgeText)) +
    `<strong class="xp-action-state__title">${escapeHtml(title)}</strong>` +
    (metaParts.length > 0 ? `<div class="xp-action-state__meta">${metaParts.join(' · ')}</div>` : '') +
    `</div>` +
    `<p class="xp-prose xp-action-state__message" style="margin: 6px 0 0;">${escapeHtml(message)}</p>` +
    `</section>`
  )
}

/**
 * Post-processes rendered surface HTML to guarantee:
 * 1. Every `.xp-table-wrap` scrollable table container is keyboard-focusable (`role="region" tabindex="0" aria-label="..."`).
 * 2. Every `<th>` inside data tables has `scope="col"` for screen readers.
 * 3. Every numeral across text and attributes uses Western ASCII digits (`0-9`).
 */
export function ensureAccessibleSurfaceHtml(html: string, locale: 'en' | 'ar' = 'en'): string {
  const defaultRegionLabel =
    locale === 'ar' ? 'جدول بيانات قابل للتمرير الأفقي' : 'Scrollable data table'
  let regionIndex = 0

  const withRegions = html.replace(/<div\b([^>]*)>/g, (full, attrs: string) => {
    const classes = /(?:^|\s)class="([^"]*)"/.exec(attrs)?.[1]?.split(/\s+/)
    if (!classes?.includes('xp-table-wrap')) return full
    regionIndex++
    let nextAttrs = attrs
    if (!/(?:^|\s)role=/.test(nextAttrs)) {
      nextAttrs += ` role="region"`
    }
    if (!/(?:^|\s)tabindex=/.test(nextAttrs)) {
      nextAttrs += ` tabindex="0"`
    }
    if (!/(?:^|\s)aria-label=/.test(nextAttrs) && !/(?:^|\s)aria-labelledby=/.test(nextAttrs)) {
      nextAttrs += ` aria-label="${escapeHtml(`${defaultRegionLabel} ${regionIndex}`)}"`
    }
    return `<div${nextAttrs}>`
  })

  const withScopedHeaders = withRegions.replace(/<th(\s+[^>]*|\s*)>/g, (full, attrs: string) => {
    if (/\bscope=/.test(attrs)) return full
    return `<th scope="col"${attrs}>`
  })

  return normalizeAsciiDigits(withScopedHeaders)
}

/**
 * Shared stylesheet for xPanel, xWHM, and xMail.
 * Colour roles follow the dedicated design: a light canvas with the navy rail ink,
 * and a dark theme built from that same ink. Logical properties mirror LTR and RTL.
 * Numerals stay tabular ASCII.
 */
export const DESIGN_TOKENS_CSS = /* css */ `
:root,
[data-theme="dark"] {
  color-scheme: dark;

  /* Dark theme uses the design's navy ink, lifted so text stays readable. Never pure black. */
  --xp-bg-canvas: #0e1726;
  --xp-bg-surface: #152033;
  --xp-bg-elevated: #1d2b40;
  --xp-bg-overlay: rgba(14, 23, 38, 0.94);
  --xp-bg-subtle: #121c2e;
  --xp-bg-code: #0e1726;

  --xp-text-primary: #e6edf7;
  --xp-text-secondary: #c9d3e1;
  --xp-text-muted: #8a99af;
  --xp-text-on-accent: #0e1726;
  --xp-text-code: #e6edf7;

  --xp-border: #2a3a52;
  --xp-border-strong: #3a4d6b;
  --xp-border-focus: #6ea0ff;

  --xp-accent: #6ea0ff;
  --xp-accent-hover: #8db0f2;
  --xp-accent-soft: #1d2b40;
  --xp-accent-border: #3d5680;

  --xp-status-ok-fg: #75e0a7;
  --xp-status-ok-bg: #0f3324;
  --xp-status-ok-border: #1f6b45;
  --xp-status-ok-bar: #0e7a4e;

  --xp-status-warn-fg: #f9c9a0;
  --xp-status-warn-bg: #3a2414;
  --xp-status-warn-border: #8a4b12;
  --xp-status-warn-bar: #b54708;

  --xp-status-critical-fg: #f4b8b2;
  --xp-status-critical-bg: #3a1a1e;
  --xp-status-critical-border: #8a3028;
  --xp-status-critical-bar: #b42318;

  --xp-status-reconciling-fg: #c7d7f8;
  --xp-status-reconciling-bg: #1d2b40;
  --xp-status-reconciling-border: #3d5680;

  --xp-status-suspended-fg: #c9d3e1;
  --xp-status-suspended-bg: #1d2b40;
  --xp-status-suspended-border: #3a4d6b;

  --xp-chart-read: #6ea0ff;
  --xp-chart-write: #75e0a7;
  --xp-chart-psi: #f9c9a0;
  --xp-chart-latency: #c7d7f8;
  --xp-chart-2xx: #75e0a7;
  --xp-chart-3xx: #6ea0ff;
  --xp-chart-4xx: #f9c9a0;
  --xp-chart-5xx: #f4b8b2;
  --xp-chart-grid: #2a3a52;

  --xp-shadow-sm: 0 1px 2px rgba(8, 12, 20, 0.45);
  --xp-shadow-md: 0 8px 24px rgba(8, 12, 20, 0.48);
  --xp-shadow-lg: 0 20px 48px rgba(8, 12, 20, 0.56);
}

[data-theme="light"] {
  color-scheme: light;

  /* Light mode surface hierarchy. */
  --xp-bg-canvas: #f5f6f8;
  --xp-bg-surface: #ffffff;
  --xp-bg-elevated: #f8f9fb;
  --xp-bg-overlay: rgba(255, 255, 255, 0.96);
  --xp-bg-subtle: #f1f3f7;
  --xp-bg-code: #0e1726;

  /* Light mode text hierarchy; contrast acceptance is measured per rendered state. */
  --xp-text-primary: #101828;
  --xp-text-secondary: #344054;
  --xp-text-muted: #5d6b7e;
  --xp-text-on-accent: #ffffff;
  --xp-text-code: #e6edf7;

  /* Borders & dividers */
  --xp-border: #e2e6ec;
  --xp-border-strong: #d0d5dd;
  --xp-border-focus: #1d5bd6;

  /* Brand and interactive accents. */
  --xp-accent: #1d5bd6;
  --xp-accent-hover: #1546a8;
  --xp-accent-soft: #e8effd;
  --xp-accent-border: #c7d7f8;

  /* Semantic status & threshold tokens */
  --xp-status-ok-fg: #0e7a4e;
  --xp-status-ok-bg: #e7f5ee;
  --xp-status-ok-border: #a9dfc8;
  --xp-status-ok-bar: #0e7a4e;

  --xp-status-warn-fg: #9a3b06;
  --xp-status-warn-bg: #fef0e6;
  --xp-status-warn-border: #f7c697;
  --xp-status-warn-bar: #b54708;

  --xp-status-critical-fg: #b42318;
  --xp-status-critical-bg: #fdecea;
  --xp-status-critical-border: #f5b7b1;
  --xp-status-critical-bar: #b42318;

  --xp-status-reconciling-fg: #1546a8;
  --xp-status-reconciling-bg: #e8effd;
  --xp-status-reconciling-border: #c7d7f8;

  --xp-status-suspended-fg: #344054;
  --xp-status-suspended-bg: #eef1f6;
  --xp-status-suspended-border: #d0d5dd;

  /* Chart series palette */
  --xp-chart-read: #1d5bd6;
  --xp-chart-write: #0e7a4e;
  --xp-chart-psi: #b54708;
  --xp-chart-latency: #6938ef;
  --xp-chart-2xx: #0e7a4e;
  --xp-chart-3xx: #1d5bd6;
  --xp-chart-4xx: #b54708;
  --xp-chart-5xx: #b42318;
  --xp-chart-grid: #e2e6ec;

  /* Shadows */
  --xp-shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.05);
  --xp-shadow-md: 0 6px 18px rgba(16, 24, 40, 0.08);
  --xp-shadow-lg: 0 20px 44px rgba(16, 24, 40, 0.14);
}

/* Structural layout and spacing tokens; see docs/STANDARDS.md. */
:root {
  --xp-font-sans-ltr: 'IBM Plex Sans', 'IBM Plex Sans Arabic', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --xp-font-sans-rtl: 'IBM Plex Sans Arabic', 'IBM Plex Sans', 'Noto Sans Arabic', Tahoma, sans-serif;
  --xp-font-mono: 'IBM Plex Mono', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

  /* Typography roles shared by account, administration, mail and sign-in screens. */
  --xp-type-caption: 13px;
  --xp-type-label: 14px;
  --xp-type-body: 16px;
  --xp-type-card: 18px;
  --xp-type-page: 26px;
  --xp-type-input-mobile: 16px;
  --xp-leading-caption: 20px;
  --xp-leading-label: 22px;
  --xp-leading-body: 24px;
  --xp-leading-card: 28px;
  --xp-leading-page: 34px;
  --xp-leading-input-mobile: 24px;
  --xp-weight-regular: 400;
  --xp-weight-medium: 500;
  --xp-weight-semibold: 600;

  /* Relationships:8px label/value,16px fields,24px groups,32px screen sections. */
  --xp-space-xs: 4px;
  --xp-space-sm: 8px;
  --xp-space-md: 12px;
  --xp-space-field: 16px;
  --xp-space-card: 24px;
  --xp-space-section: 32px;

  /* Layout dimensions */
  --xp-sidebar-width: 248px;
  --xp-sidebar-collapsed-width: 64px;
  --xp-topbar-height: 56px;
  --xp-mobile-topbar-height: 64px;
  --xp-hit-target: 44px;
  --xp-mobile-sheet-max: 320px;
  --xp-mobile-sheet-gutter: 16px;
  --xp-toolbar-panel-max: 560px;
  --xp-nav-backdrop: rgba(14, 23, 38, 0.68);
  --xp-focus-width: 2px;
  --xp-focus-offset: 2px;
  --xp-radius-sm: 8px;
  --xp-radius-md: 12px;
  --xp-radius-lg: 14px;
  --xp-golden-main: 1.618fr;
  --xp-golden-aside: 1fr;
}

*, *::before, *::after {
  box-sizing: border-box;
}

a:where(:not([class])) {
  color: var(--xp-accent);
}

a:where(:not([class])):hover {
  color: var(--xp-accent-hover);
}

[hidden] {
  display: none !important;
}

html {
  font-size: 16px;
}

body {
  font-size: var(--xp-type-body);
}

html, body {
  margin: 0;
  padding: 0;
  background-color: var(--xp-bg-canvas);
  color: var(--xp-text-primary);
  line-height: var(--xp-leading-body);
  font-kerning: normal;
  font-feature-settings: "kern" 1;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
}

html[dir="ltr"] { font-family: var(--xp-font-sans-ltr); }
html[dir="rtl"] { font-family: var(--xp-font-sans-rtl); }
[dir="ltr"], [dir="rtl"] { text-align: start; }

/* Arabic glyphs need additional vertical room; direction alone never selects a font. */
html[lang="ar"] {
  font-family: var(--xp-font-sans-rtl);
  --xp-leading-caption: 22px;
  --xp-leading-label: 24px;
  --xp-leading-body: 26px;
  --xp-leading-card: 30px;
  --xp-leading-page: 36px;
}

/* Enforce tabular numerals on every counter, rate, quota, IP, port, UID, PID, and timestamp */
.xp-tabular,
.xp-kpi__value,
.xp-meter__values,
.xp-table td[data-numeric="true"],
.xp-mono,
code,
pre,
kbd,
time {
  font-variant-numeric: tabular-nums;
}

.xp-mono,
code,
pre,
kbd {
  font-family: var(--xp-font-mono);
  font-weight: var(--xp-weight-regular);
}

/* The bundled technical face has genuine400/500 weights; keep emphasis within those faces. */
:is(strong, b).xp-mono,
:is(strong, b) .xp-mono { font-weight: var(--xp-weight-medium); }

p, .xp-prose {
  margin: 0;
  max-inline-size: 68ch;
  line-height: var(--xp-leading-body);
}
p + p { margin-block-start: var(--xp-space-field); }

/* Visible keyboard focus (WCAG 2.2 AA 2.4.7 / 2.4.11) */
:focus-visible {
  outline: var(--xp-focus-width) solid var(--xp-border-focus);
  outline-offset: var(--xp-focus-offset);
}

.xp-sr-only {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

.xp-skip-link {
  position: fixed;
  inset-block-start: var(--xp-space-field);
  inset-inline-start: var(--xp-space-field);
  z-index: 100;
  inline-size: 1px;
  block-size: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  background-color: var(--xp-bg-surface);
  color: var(--xp-text-primary);
  border-radius: var(--xp-radius-sm);
  font: inherit;
}

.xp-skip-link:focus {
  display: inline-flex;
  align-items: center;
  inline-size: fit-content;
  max-inline-size: calc(100% - var(--xp-space-field) - var(--xp-space-field));
  block-size: auto;
  min-block-size: var(--xp-hit-target);
  padding-block: var(--xp-space-xs);
  padding-inline: 14px;
  overflow: visible;
  clip-path: none;
  white-space: normal;
  outline: var(--xp-focus-width) solid var(--xp-border-focus);
  outline-offset: var(--xp-focus-offset);
}

/* App shell: 248px desktop rail, compact header and a mobile navigation sheet. */
.xp-shell {
  display: grid;
  grid-template-columns: var(--xp-sidebar-width) minmax(0, 1fr);
  min-block-size: 100dvh;
}

[data-xp-shell-content] {
  min-inline-size: 0;
}

.xp-shell [data-action="toggle-mobile-nav"],
.xp-shell .xp-mobile-nav-close,
.xp-nav-backdrop,
[data-xp-nav-backdrop] {
  display: none;
}

.xp-shell[data-sidebar="collapsed"] {
  grid-template-columns: var(--xp-sidebar-collapsed-width) minmax(0, 1fr);
}

.xp-sidebar {
  background-color: var(--xp-bg-surface);
  border-inline-end: 1px solid var(--xp-border);
  display: flex;
  flex-direction: column;
  gap: 16px;
  inline-size: var(--xp-sidebar-width);
  position: sticky;
  inset-block-start: 0;
  block-size: 100dvh;
  overflow-y: auto;
  padding-block: 20px;
  padding-inline: 14px;
}

/* Dark xWHM navigation rail. */
html[data-surface="xwhm"] .xp-sidebar {
  background-color: #0e1726;
  border-inline-end-color: #1f2c40;
  color: #c9d3e1;
  --xp-bg-surface: #0e1726;
  --xp-bg-elevated: #162235;
  --xp-bg-subtle: #131e30;
  --xp-text-primary: #f8fafc;
  --xp-text-secondary: #c9d3e1;
  --xp-text-muted: #94a3b8;
  --xp-border: #1f2c40;
  --xp-border-strong: #2d3f59;
  --xp-accent-soft: #1d2b40;
  --xp-accent: #6ea0ff;
  --xp-border-focus: var(--xp-accent);
}

.xp-sidebar__brand {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  gap: 12px;
  padding-block-end: 16px;
  border-block-end: 1px solid var(--xp-border);
}

.xp-sidebar__brand > div {
  min-inline-size: 0;
}

.xp-sidebar__brand .xp-mono {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--xp-text-muted);
}

.xp-sidebar__brand > strong,
.xp-sidebar__brand > div > strong {
  font-family: var(--xp-font-mono);
  font-size: 17px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--xp-accent);
}
html[data-surface="xwhm"] .xp-sidebar .xp-brand__mark { background: #1d5bd6; }
html[data-surface="xwhm"] .xp-sidebar__brand > strong,
html[data-surface="xwhm"] .xp-sidebar__brand > div > strong { color: #ffffff; }
html[data-surface="xwhm"] .xp-sidebar { gap: 18px; }

.xp-sidebar [data-account-summary-card] > div {
  flex-wrap: wrap;
  gap: 8px;
}

.xp-sidebar__favorites,
.xp-sidebar__quota {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-block-end: 12px;
  border-block-end: 1px solid var(--xp-border);
}

.xp-nav-section {
  margin-block-end: var(--xp-space-xs);
}

.xp-nav-section__title {
  display: flex;
  min-block-size: var(--xp-hit-target);
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  gap: var(--xp-space-sm);
  list-style: none;
  font-size: var(--xp-type-caption);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  line-height: var(--xp-leading-caption);
  color: var(--xp-text-muted);
  cursor: pointer;
  border-radius: 6px;
  user-select: none;
}

.xp-nav-section__title::-webkit-details-marker { display: none; }
.xp-nav-section__title::after {
  content: '';
  flex: none;
  inline-size: 16px;
  block-size: 16px;
  margin-inline-start: auto;
  background-color: currentColor;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m5 6 3 3 3-3' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 16px no-repeat;
  transform: rotate(-90deg);
}
html[dir="rtl"] .xp-nav-section:not([open]) > .xp-nav-section__title::after { transform: rotate(90deg); }
.xp-nav-section[open] > .xp-nav-section__title::after { transform: none; }

.xp-nav-section__title:hover {
  color: var(--xp-text-primary);
  background-color: var(--xp-bg-elevated);
}

.xp-nav-section__items {
  display: flex;
  flex-direction: column;
  gap: var(--xp-space-xs);
  margin-block-start: 4px;
}

.xp-shell[data-sidebar="collapsed"] .xp-sidebar {
  inline-size: var(--xp-sidebar-collapsed-width);
}

.xp-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-block-size: var(--xp-hit-target);
  padding-inline: 12px;
  border-radius: 8px;
  color: var(--xp-text-secondary);
  text-decoration: none;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
}

.xp-nav-item:hover {
  background-color: var(--xp-bg-elevated);
  color: var(--xp-text-primary);
}

.xp-nav-item[aria-current="page"],
.xp-nav-item--active {
  background-color: var(--xp-accent-soft);
  color: var(--xp-text-primary);
  font-weight: 600;
  box-shadow: inset 3px 0 0 var(--xp-accent);
}
html[dir="rtl"] .xp-nav-item[aria-current="page"],
html[dir="rtl"] .xp-nav-item--active {
  box-shadow: inset -3px 0 0 var(--xp-accent);
}

.xp-nav-groups { display: flex; flex-direction: column; gap: 18px; }
.xp-nav-group { display: flex; flex-direction: column; gap: 4px; }
.xp-nav-group__label {
  padding-inline: 12px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.6;
  color: var(--xp-text-muted);
}
.xp-nav-group__items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.xp-nav-item .xp-nav-soon {
  margin-inline-start: auto;
  padding: 2px 8px;
  border: 1px dashed var(--xp-border-strong);
  border-radius: 999px;
  color: var(--xp-text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
}
.xp-design-page { display: flex; flex-direction: column; gap: 26px; min-inline-size: 0; }
.xp-design-page__lede { margin: 0; max-inline-size: 68ch; color: var(--xp-text-secondary); }
.xp-design-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 24px;
  border: 1px dashed #c9cfd8;
  border-radius: 12px;
  background: var(--xp-bg-surface);
}
.xp-design-empty h2, .xp-design-empty h3 { margin: 0; font-size: 16px; font-weight: 600; }
.xp-design-empty p { margin: 0; }
.xp-board-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px; }
.xp-board-crumb ol { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--xp-text-muted); }
.xp-board-crumb li[aria-current="page"] { color: var(--xp-text-secondary); }
.xp-board-crumb li + li::before { content: "/"; margin-inline-end: 6px; }
.xp-board-section { border: 1px solid var(--xp-border); border-radius: 12px; background: var(--xp-bg-surface); overflow: hidden; }
.xp-board-section__head { padding: 16px 20px; border-block-end: 1px solid var(--xp-border); }
.xp-board-section__head h2, .xp-board-section__head h3, .xp-board-note h2 { margin: 0; font-size: 16px; font-weight: 600; }
.xp-board-section__body { padding: 20px 24px; display: flex; flex-direction: column; gap: 16px; }
.xp-board-note { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 10px; border: 1px solid #c7d7f8; background: #f3f7fe; }
html[data-theme="dark"] .xp-board-note { border-color: #3a4d6b; background: #1d2b40; }
.xp-board-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; }
.xp-board-fields input, .xp-board-section__body input[type="search"], .xp-board-section__body input.xp-specimen {
  min-block-size: 44px;
  inline-size: 100%;
  padding-inline: 12px;
  border-radius: 8px;
  border: 1px solid #d0d5dd;
  background: #ffffff;
  color: #101828;
}
.xp-board-section__body input.xp-specimen:disabled {
  border-color: #e2e6ec;
  background: #f0f2f5;
  color: #5d6b7e;
  cursor: not-allowed;
}
.xp-board-section__body input.xp-specimen[aria-invalid="true"] {
  border: 1.5px solid #b42318;
}
.xp-focus-sample {
  display: flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 12px;
  border-radius: 8px;
  border: 1.5px solid #1d5bd6;
  background: #ffffff;
  box-shadow: 0 0 0 3px #e8effd;
  color: #101828;
}
.xp-chip {
  min-block-size: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid #d0d5dd;
  background: #ffffff;
  color: #344054;
  font-size: 13px;
  font-weight: 600;
}
.xp-chip[aria-pressed="true"] {
  background: #e8effd;
  color: #1d5bd6;
  border-color: #c7d7f8;
}
.xp-segment {
  display: inline-flex;
  align-self: flex-start;
  padding: 3px;
  border-radius: 10px;
  background: #eef0f3;
  gap: 2px;
}
.xp-segment [role="radio"] {
  min-block-size: 38px;
  padding: 0 14px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #475467;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  box-shadow: none;
  cursor: pointer;
}
.xp-segment [role="radio"][aria-checked="true"] {
  background: #ffffff;
  color: #101828;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.12);
}
.xp-switch {
  inline-size: 48px;
  block-size: 28px;
  padding: 3px;
  border-radius: 999px;
  border: none;
  background: #98a2b3;
  display: inline-flex;
  justify-content: flex-start;
  cursor: pointer;
}
.xp-switch[aria-checked="true"] { background: #1d5bd6; justify-content: flex-end; }
.xp-switch::after {
  content: "";
  inline-size: 22px;
  block-size: 22px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(16, 24, 40, 0.3);
}
.xp-radio-card {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid #e2e6ec;
  background: #ffffff;
  cursor: pointer;
}
.xp-radio-card:has(:checked) {
  border: 1.5px solid #1d5bd6;
  background: #f3f7fe;
}
.xp-radio-card:has(:disabled) {
  border: 1px solid #e2e6ec;
  background: #f8f9fb;
  color: #475467;
  cursor: not-allowed;
}
.xp-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid #e2e6ec;
}
.xp-tabs [role="tab"] {
  min-block-size: 44px;
  padding: 0 14px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #475467;
  font: inherit;
  font-size: 14px;
  font-weight: 500;
}
.xp-tabs [role="tab"][aria-selected="true"] {
  border-bottom-color: #1d5bd6;
  color: #1d5bd6;
  font-weight: 600;
}
.xp-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px;
  border-radius: 10px;
  border: 1.5px dashed #9aa4b2;
  background: #f8f9fb;
  text-align: center;
}
.xp-skeleton-stack { display: flex; flex-direction: column; gap: 14px; }
.xp-skeleton-row { display: flex; align-items: center; gap: 12px; }
.xp-board-section .xp-skeleton-stack .xp-skeleton-avatar { inline-size: 32px; block-size: 32px; border-radius: 8px; flex: none; }
.xp-board-section .xp-skeleton-stack .xp-skeleton-copy { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.xp-board-section .xp-skeleton-stack .xp-skeleton-line { inline-size: 42%; block-size: 10px; border-radius: 5px; }
.xp-board-section .xp-skeleton-stack .xp-skeleton-line--short { inline-size: 28%; block-size: 8px; border-radius: 4px; }
.xp-board-section .xp-skeleton-stack .xp-skeleton-pill { inline-size: 72px; block-size: 22px; border-radius: 999px; flex: none; }
.xp-card.xp-toast.xp-toast--undo {
  background: #101828;
  color: #ffffff;
  border-color: #101828;
  box-shadow: 0 12px 24px -10px rgba(16, 24, 40, 0.3);
}
.xp-toast__mark {
  inline-size: 28px;
  block-size: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.xp-toast__mark--ok { background: #e7f5ee; color: #0e7a4e; }
.xp-toast__mark--critical { background: #fdecea; color: #b42318; }
.xp-toast__row { display: flex; gap: 12px; align-items: flex-start; }
.xp-board-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.xp-swatches { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 16px; }
.xp-swatches li { display: flex; flex-direction: column; gap: 6px; min-inline-size: 96px; font-size: 13px; }
.xp-swatch { inline-size: 48px; block-size: 48px; border-radius: 8px; border: 1px solid var(--xp-border); }
.xp-type-sample { margin: 0; }
.xp-type-sample--page { font-size: 26px; line-height: 34px; font-weight: 600; }
.xp-board-section .xp-skeleton { block-size: 14px; border-radius: 4px; }
.xp-home-layout { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 26px; }
.xp-home-primary { flex: 1.618 1 420px; min-inline-size: 0; display: flex; flex-direction: column; gap: 16px; }
.xp-home-aside { flex: 1 1 260px; min-inline-size: 0; display: flex; flex-direction: column; gap: 26px; }
.xp-home-tools-head { display: flex; flex-direction: column; gap: 8px; }
.xp-home-tools-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
.xp-home-tools-head label { font-size: 13px; font-weight: 600; }
.xp-home-tools-head input { min-block-size: 44px; inline-size: 100%; padding-inline: 12px; border-radius: 8px; border: 1px solid #d0d5dd; background: #fff; color: #101828; font: inherit; }
.xp-home-tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.xp-tool-card .xp-home-tool-list { list-style: none; margin: 0; padding: 8px; display: flex; flex-direction: column; }
.xp-home-tool { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-block-size: 44px; padding: 0 8px; border-radius: 8px; color: var(--xp-text-primary); text-decoration: none; }
.xp-home-tool:hover { background: #f3f7fe; color: #1d5bd6; }
.xp-board-canvas { display: flex; flex-direction: column; gap: 26px; min-inline-size: 0; }
.xp-board-fields { display: flex; flex-wrap: wrap; gap: 16px; }
.xp-board-fields .xp-field { flex: 1 1 180px; min-inline-size: 0; }
.xp-board-legend { margin: 0; padding: 16px; border: 1px solid var(--xp-border); border-radius: 12px; }
.xp-board-legend legend { padding: 0; font-size: 13px; font-weight: 600; }
.xp-board-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.xp-board-checks label { display: flex; align-items: center; gap: 8px; min-block-size: 44px; }
.xp-board-radios { display: flex; flex-wrap: wrap; gap: 12px; }
.xp-board-stats { display: flex; flex-wrap: wrap; gap: 12px; margin: 0; }
.xp-board-stats > div { flex: 1 1 140px; padding: 16px; border: 1px solid var(--xp-border); border-radius: 12px; background: var(--xp-bg-surface); }
.xp-board-stats dt { font-size: 12px; color: var(--xp-text-muted); }
.xp-board-stats dd { margin: 4px 0 0; font-size: 16px; font-weight: 600; }
.xp-board-dl { margin: 0; }
.xp-fact { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 20px; }
.xp-fact + .xp-fact { border-block-start: 1px solid #eef0f3; }
.xp-fact dt { font-size: 13px; color: #475467; }
.xp-fact dd { margin: 0; font-size: 13px; text-align: end; overflow-wrap: anywhere; }
.xp-board-code { margin: 0; padding: 16px; border-radius: 8px; background: #0e1726; color: #e6edf7; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13px; line-height: 1.6; overflow: auto; min-block-size: 44px; }
.xp-board-anchors { display: flex; flex-wrap: wrap; gap: 8px; }
.xp-board-anchors a { min-block-size: 44px; display: inline-flex; align-items: center; padding: 0 14px; border-radius: 999px; border: 1px solid #d0d5dd; background: #fff; color: #344054; font-size: 13px; font-weight: 500; text-decoration: none; }
.xp-board-section__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; }
@media (max-width: 719px) {
  .xp-home-aside { order: -1; flex-basis: 100%; }
  .xp-home-primary { flex-basis: 100%; }
}

.xp-workspace {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
  min-block-size: 100dvh;
}

.xp-topbar {
  min-block-size: var(--xp-topbar-height);
  background-color: var(--xp-bg-surface);
  border-block-end: 1px solid var(--xp-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--xp-space-field);
  padding-block: 8px;
  padding-inline: var(--xp-space-card);
  position: sticky;
  inset-block-start: 0;
  z-index: 30;
}

.xp-topbar__start,
.xp-topbar__end,
.xp-topbar-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-inline-size: 0;
  gap: 8px;
}

.xp-account-actions {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: var(--xp-space-sm);
  min-inline-size: 0;
  max-inline-size: 100%;
}
.xp-account-actions__name {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.xp-account-actions > .xp-btn { flex-shrink: 0; }

/* Keep page search reachable without competing with account tools at desktop widths. */
.xp-page-search__icon { display: none; flex: none; }
@media (960px <= width < 1600px) {
  .xp-page-search { position: relative; inline-size: var(--xp-hit-target); block-size: var(--xp-hit-target); padding: 0; flex: none; }
  .xp-page-search__icon { display: block; }
  .xp-page-search > :is(.xp-page-search__label, kbd) {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

.xp-toolbar-options {
  display: block;
  flex: 1 1 auto;
  min-inline-size: 0;
}

/* Keep an explicit row inside native details content; its UA wrapper need not flatten. */
.xp-toolbar-options__content {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-between;
  min-inline-size: 0;
  gap: var(--xp-space-field);
}

@media (width >= 960px) {
  .xp-toolbar-options__content > .xp-topbar__start {
    align-self: flex-start;
    flex: 0 0 auto;
  }

  .xp-toolbar-options__content > .xp-topbar__end {
    flex: 1 1 0;
    min-inline-size: 0;
    justify-content: flex-end;
  }
}

.xp-toolbar-options > summary,
.xp-mobile-brand {
  display: none;
}

.xp-main {
  min-inline-size: 0;
  padding-block: var(--xp-space-card);
  padding-inline: var(--xp-space-card);
  display: flex;
  flex-direction: column;
  gap: var(--xp-space-card);
}

/* Login shell and two-column layout. */
.xp-login-shell {
  min-block-size: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background-color: var(--xp-bg-canvas);
  color: var(--xp-text-primary);
}

.xp-login-topbar {
  inline-size: 100%;
  max-inline-size: 1000px;
  margin-inline: auto;
  padding-block: 20px 0;
  padding-inline: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.xp-brand {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}

.xp-brand__mark {
  inline-size: 36px;
  block-size: 36px;
  border-radius: 8px;
  background-color: #101828;
  color: #ffffff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--xp-font-mono);
  font-weight: 500;
  font-size: 18px;
  line-height: 1;
  flex-shrink: 0;
}

.xp-brand__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.xp-brand__name {
  font-family: var(--xp-font-mono);
  font-size: 17px;
  font-weight: 500;
  color: var(--xp-accent);
  letter-spacing: normal;
  line-height: 1.3;
}

.xp-brand__sub {
  font-size: var(--xp-type-caption);
  color: var(--xp-text-muted);
  line-height: var(--xp-leading-caption);
}

.xp-login-main {
  inline-size: 100%;
  max-inline-size: 1000px;
  margin-inline: auto;
  padding-block: 32px;
  padding-inline: 32px;
  display: flex;
  gap: var(--xp-space-card);
  align-items: flex-start;
  flex-wrap: wrap;
  flex: 1;
}

.xp-login-card {
  flex: 1 1 400px;
  min-inline-size: min(100%, 320px);
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border);
  border-radius: 12px;
  padding: var(--xp-space-card);
  box-shadow: var(--xp-shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--xp-space-card);
}

.xp-login-step {
  font-size: 12px;
  font-weight: 600;
  color: var(--xp-accent);
  letter-spacing: 0.01em;
}

.xp-page-title {
  margin: 0;
  font-size: var(--xp-type-page);
  font-weight: var(--xp-weight-semibold);
  color: var(--xp-text-primary);
  letter-spacing: normal;
  line-height: var(--xp-leading-page);
}

.xp-subtitle {
  margin: 0;
  font-size: var(--xp-type-body);
  color: var(--xp-text-secondary);
  line-height: var(--xp-leading-body);
}

.xp-help {
  margin: 0;
  font-size: var(--xp-type-caption);
  color: var(--xp-text-muted);
  line-height: var(--xp-leading-caption);
}

.xp-help:empty {
  display: none;
}

.xp-alert {
  padding: var(--xp-space-md) var(--xp-space-field);
  border-radius: 8px;
  border: 1px solid var(--xp-border-strong);
  font-size: var(--xp-type-label);
  font-weight: 500;
  line-height: var(--xp-leading-label);
}

.xp-alert[hidden] {
  display: none !important;
}

.xp-alert--critical {
  background-color: var(--xp-status-critical-bg);
  border-color: var(--xp-status-critical-border);
  color: var(--xp-status-critical-fg);
}

.xp-alert--warn {
  background-color: var(--xp-status-warn-bg);
  border-color: var(--xp-status-warn-border);
  color: var(--xp-status-warn-fg);
}

.xp-alert--ok {
  background-color: var(--xp-status-ok-bg);
  border-color: var(--xp-status-ok-border);
  color: var(--xp-status-ok-fg);
}

.xp-form,
.xp-form-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
  inline-size: 100%;
}

.xp-field {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  align-content: start;
  gap: var(--xp-space-sm);
  inline-size: 100%;
  min-inline-size: 0;
  text-align: start;
}

.xp-field > * {
  min-inline-size: 0;
}

.xp-field-value {
  display: block;
  min-inline-size: 0;
  overflow-wrap: anywhere;
  text-align: start;
}

.xp-field-value > bdi[dir="ltr"] {
  display: block;
  min-inline-size: 0;
  overflow-wrap: anywhere;
  text-align: match-parent;
}

.xp-label {
  display: block;
  inline-size: 100%;
  font-size: var(--xp-type-label);
  font-weight: var(--xp-weight-semibold);
  color: var(--xp-text-secondary);
  line-height: var(--xp-leading-label);
}

.xp-fieldset {
  margin: 0;
  padding: 16px;
  border: 1px solid var(--xp-border);
  border-radius: 10px;
  background-color: var(--xp-bg-elevated);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.xp-fieldset[hidden] {
  display: none !important;
}

.xp-login-aside {
  flex: 1 1 260px;
  min-inline-size: min(100%, 260px);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.xp-login-aside-card {
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--xp-shadow-sm);
}

.xp-login-aside-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--xp-text-primary);
}

.xp-login-dl {
  margin: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  font-size: 12.5px;
  text-align: start;
}

.xp-login-dl dt {
  min-inline-size: 0;
  color: var(--xp-text-muted);
  font-weight: 500;
}

.xp-login-dl dd + dt {
  margin-block-start: 8px;
}

.xp-login-dl dd {
  margin: 0;
  min-inline-size: 0;
  color: var(--xp-text-primary);
  font-weight: 500;
  text-align: start;
  overflow-wrap: anywhere;
}

.xp-login-surface-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.xp-login-surface-link {
  display: flex;
  min-block-size: var(--xp-hit-target);
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--xp-border);
  background-color: var(--xp-bg-elevated);
  color: var(--xp-text-primary);
  text-decoration: none;
  font-size: 13px;
}

.xp-login-surface-link:hover {
  border-color: var(--xp-border-strong);
  background-color: var(--xp-bg-subtle);
}

.xp-login-surface-link[aria-current="page"] {
  background-color: var(--xp-accent-soft);
  border-color: var(--xp-accent);
  font-weight: 600;
}

.xp-cli-recovery {
  margin-block-start: 4px;
  padding-block-start: 14px;
  border-block-start: 1px solid var(--xp-border);
  font-size: 12.5px;
  color: var(--xp-text-secondary);
}

.xp-cli-recovery summary {
  min-block-size: var(--xp-hit-target);
  cursor: pointer;
  font-weight: 500;
  color: var(--xp-text-secondary);
}

.xp-code-block {
  margin: 8px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background-color: var(--xp-bg-code);
  border: 1px solid var(--xp-border);
  color: var(--xp-text-code);
  font-family: var(--xp-font-mono);
  font-size: 12px;
  overflow-x: auto;
  line-height: 1.5;
}

.xp-login-footer {
  inline-size: 100%;
  max-inline-size: 1000px;
  margin-inline: auto;
  padding-block: 16px 24px;
  padding-inline: 32px;
  border-block-start: 1px solid var(--xp-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--xp-text-muted);
}

/* Dedicated listener identities share one compact sign-in form contract. */
.xp-login-shell[data-login-audience] {
  --xp-login-width: 560px;
  --xp-login-control-size: 48px;
  --xp-login-eye-target: 44px;
  --xp-login-icon-size: 20px;
  --xp-login-radius: 12px;
  --xp-login-profile: var(--xp-accent);
  --xp-login-profile-soft: var(--xp-accent-soft);
  display: grid;
  grid-template-columns: minmax(0, var(--xp-login-width));
  align-content: center;
  justify-content: center;
  gap: var(--xp-space-card);
  padding: var(--xp-space-section) var(--xp-space-field);
}
.xp-login-shell[data-login-audience="xwhm"] {
  --xp-login-profile: var(--xp-text-primary);
  --xp-login-profile-soft: var(--xp-bg-subtle);
}
.xp-login-shell[data-login-audience="xmail"] {
  --xp-login-profile: var(--xp-status-ok-fg);
  --xp-login-profile-soft: var(--xp-status-ok-bg);
}
.xp-login-shell[data-login-audience] .xp-login-topbar {
  max-inline-size: none;
  padding: 0;
  flex-wrap: nowrap;
  gap: var(--xp-space-md);
}
.xp-login-shell[data-login-audience] .xp-brand { gap: var(--xp-space-md); }
.xp-login-shell[data-login-audience] .xp-brand__mark {
  color: var(--xp-login-profile);
  background: var(--xp-login-profile-soft);
  box-shadow: none;
}
.xp-login-shell[data-login-audience] .xp-brand__mark svg {
  inline-size: 24px;
  block-size: 24px;
}
.xp-login-shell[data-login-audience] .xp-topbar-actions { gap: 4px; flex-shrink: 0; }
.xp-login-shell[data-login-audience] .xp-topbar-actions .xp-btn {
  min-inline-size: var(--xp-login-eye-target);
  min-block-size: var(--xp-login-eye-target);
  padding-inline: var(--xp-space-sm);
  background: transparent;
  border-color: transparent;
}
.xp-login-shell[data-login-audience] .xp-topbar-actions .xp-btn:hover {
  background: var(--xp-bg-subtle);
  border-color: var(--xp-border);
}
.xp-login-theme { position: relative; }
.xp-login-theme svg { inline-size: 20px; block-size: 20px; flex: none; }
.xp-login-theme__label { font-size: var(--xp-type-label); line-height: var(--xp-leading-label); }
.xp-login-identity__product {
  margin: 0;
  font-family: var(--xp-font-sans-ltr);
  font-size: var(--xp-type-page);
  font-weight: var(--xp-weight-semibold);
  letter-spacing: -0.02em;
  line-height: var(--xp-leading-page);
  color: var(--xp-text-primary);
}
.xp-login-siblings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--xp-space-sm) var(--xp-space-field);
}
.xp-login-sibling {
  color: var(--xp-text-secondary);
  font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.xp-login-sibling:hover { color: var(--xp-text-primary); }
.xp-login-shell[data-login-audience] .xp-login-main {
  display: block;
  max-inline-size: none;
  padding: 0;
}
.xp-login-shell[data-login-audience] .xp-login-card {
  min-inline-size: 0;
  padding: var(--xp-space-card);
  gap: var(--xp-space-card);
  border-block-start: 3px solid var(--xp-login-profile);
  border-radius: var(--xp-login-radius);
  box-shadow: var(--xp-shadow-sm);
}
.xp-login-shell[data-login-audience] .xp-page-title {
  font-size: var(--xp-type-page);
  line-height: var(--xp-leading-page);
  overflow-wrap: anywhere;
}
.xp-login-shell[data-login-audience] .xp-form { gap: var(--xp-space-field); }
.xp-login-shell .xp-field > label.xp-label { padding-inline-start: calc(var(--xp-space-md) + 1px); }
.xp-login-shell[data-login-audience] .xp-input,
.xp-login-shell[data-login-audience] button[type="submit"] {
  min-block-size: var(--xp-login-control-size);
}
.xp-login-shell[data-login-audience] .xp-input { font-size: 16px; }
.xp-login-shell[data-login-audience] .xp-btn--primary {
  color: var(--xp-bg-surface);
  background: var(--xp-text-primary);
  border-color: var(--xp-text-primary);
}
.xp-login-shell[data-login-audience] .xp-btn--primary:hover {
  background: var(--xp-text-secondary);
  border-color: var(--xp-text-secondary);
}
.xp-login-shell[data-login-audience] .xp-cli-recovery {
  margin-block-start: 0;
  padding-block-start: var(--xp-space-md);
}
.xp-login-password { position: relative; display: grid; min-inline-size: 0; }
.xp-login-password > .xp-input { padding-inline-end: 7.75rem; }
.xp-password-toggle {
  position: absolute;
  inset-block-start: 2px;
  inset-inline-end: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-inline-size: 44px;
  max-inline-size: calc(100% - 8px);
  block-size: 44px;
  padding-inline: 10px;
  border: 1px solid var(--xp-border);
  border-radius: 8px;
  background: var(--xp-bg-elevated);
  color: var(--xp-text-primary);
  font: inherit;
  font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label);
  cursor: pointer;
}
.xp-password-toggle svg { inline-size: 20px; block-size: 20px; }
.xp-password-toggle svg[hidden] { display: none; }
.xp-password-toggle:hover { background: var(--xp-bg-subtle); color: var(--xp-text-primary); }
.xp-password-toggle:focus-visible {
  outline: 2px solid var(--xp-border-focus);
  outline-offset: 2px;
  background: var(--xp-bg-subtle);
}
html[dir="rtl"] .xp-login-password > .xp-input { padding-inline: 7.75rem 12px; }
@media (max-width: 479px) {
  .xp-login-theme__label {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
}
html[dir="rtl"] .xp-login-shell[data-login-audience] .xp-label { font-size: 14px; line-height: 24px; }
html[dir="rtl"] .xp-login-shell[data-login-audience] .xp-page-title { line-height: 36px; }
html[dir="rtl"] .xp-login-shell[data-login-audience] .xp-help,
html[dir="rtl"] .xp-login-shell[data-login-audience] .xp-cli-recovery { line-height: 24px; }
@media (max-width: 479px) {
  .xp-login-shell[data-login-audience] { padding-block: var(--xp-space-card); }
  .xp-login-shell[data-login-audience] .xp-login-card { padding: var(--xp-space-field); }
  .xp-login-shell[data-login-audience] .xp-brand { gap: var(--xp-space-sm); }
  .xp-login-shell[data-login-audience] .xp-topbar-actions .xp-btn { font-size: var(--xp-type-label); }
}

/* Scoped read-only workspace summary. */
.xp-workspace-summary {
  display: grid;
  gap: 24px;
  min-inline-size: 0;
}
.xp-workspace-summary > .xp-page-title { margin: 0; }
.xp-workspace-summary > .xp-card {
  display: grid;
  gap: 16px;
  min-inline-size: 0;
  padding: 24px;
  box-shadow: none;
}
.xp-workspace-summary h2 {
  margin: 0;
  font-size: var(--xp-type-card);
  font-weight: var(--xp-weight-semibold);
  line-height: var(--xp-leading-card);
}
.xp-workspace-summary .xp-kpi-grid {
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 24px;
}
.xp-workspace-summary .xp-label {
  color: var(--xp-text-muted);
  font-size: var(--xp-type-label);
  font-weight: var(--xp-weight-medium);
}
.xp-workspace-summary .xp-field-value {
  font-size: var(--xp-type-body);
  font-weight: var(--xp-weight-medium);
  line-height: var(--xp-leading-body);
}
.xp-workspace-summary .xp-field-value > bdi[dir="ltr"] { text-align: left; }
html[dir="rtl"] .xp-workspace-summary .xp-field-value > bdi[dir="ltr"] { text-align: right; }
.xp-workspace-summary .xp-prose { margin: 0; }
.xp-workspace-summary [data-auth-status]:empty { display: none; }
.xp-workspace-availability > .xp-btn { justify-self: start; }
.xp-nav-note {
  margin: 0 0 var(--xp-space-sm);
  color: var(--xp-text-secondary);
  font-size: var(--xp-type-body);
  line-height: var(--xp-leading-body);
}
.xp-nav-planned {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.xp-nav-planned__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  min-block-size: 44px;
  padding-inline: 12px;
  border-radius: 8px;
  border: 1px dashed #d0d5dd;
  color: #5d6b7e;
  background: #f8f9fb;
  cursor: not-allowed;
}
html[data-surface="xwhm"] .xp-sidebar .xp-nav-planned__item,
[data-theme="dark"] .xp-nav-planned__item {
  border-color: #3a4d6b;
  background: transparent;
  color: #8a99af;
}
.xp-nav-planned__name,
.xp-nav-planned__state {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.xp-nav-planned__name {
  min-inline-size: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: var(--xp-weight-medium);
  color: inherit;
}
.xp-nav-planned__state {
  color: inherit;
  font-size: 12px;
  line-height: 20px;
  font-weight: var(--xp-weight-semibold);
}
.xp-nav-ready { display: flex; flex-direction: column; gap: 2px; margin-block: 8px 2px; }
.xp-nav-ready__name {
  padding-inline: 12px;
  color: var(--xp-text-secondary);
  font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label);
  font-weight: var(--xp-weight-medium);
}
.xp-nav-ready__pages { display: flex; flex-direction: column; gap: 2px; }
.xp-nav-ready__pages .xp-nav-item { min-block-size: 44px; }
.xp-user-menu { position: relative; margin-inline-start: auto; }
.xp-user-menu__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-block-size: 44px;
  padding-block: 0;
  padding-inline: 6px 12px;
  border: 1px solid var(--xp-border);
  border-radius: 999px;
  background: var(--xp-bg-surface);
  cursor: pointer;
  list-style: none;
}
.xp-user-menu__avatar,
.xp-account-pill__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 32px;
  block-size: 32px;
  border-radius: 50%;
  background: #0e1726;
  color: #ffffff;
  font-family: var(--xp-font-mono);
  font-size: 13px;
  font-weight: 500;
  flex: none;
}
html[data-surface="xpanel"] .xp-account-pill__avatar,
html[data-surface="xmail"] .xp-account-pill__avatar {
  background: #e8effd;
  color: #1d5bd6;
  border: 1px solid #c7d7f8;
}
.xp-account-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-block-size: 44px;
  padding-inline: 6px 12px;
  border: 1px solid var(--xp-border);
  border-radius: 999px;
  background: var(--xp-bg-surface);
}
.xp-user-menu__summary::-webkit-details-marker { display: none; }
.xp-user-menu__summary:focus-visible,
.xp-menu-choice:focus-visible,
.xp-login-sibling:focus-visible,
.xp-back-link:focus-visible {
  outline: 2px solid var(--xp-border-focus);
  outline-offset: 2px;
}
.xp-user-menu__identity { display: flex; flex-direction: column; align-items: flex-start; min-inline-size: 0; }
.xp-user-menu__name { font-size: var(--xp-type-body); font-weight: var(--xp-weight-semibold); line-height: var(--xp-leading-body); }
.xp-user-menu__role { color: var(--xp-text-muted); font-size: var(--xp-type-caption); line-height: var(--xp-leading-caption); }
.xp-user-menu__panel {
  position: absolute;
  inset-inline-end: 0;
  inset-block-start: calc(100% + 8px);
  z-index: 40;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-inline-size: min(280px, 80vw);
  padding: 8px;
  border: 1px solid var(--xp-border);
  border-radius: var(--xp-radius-md);
  background: var(--xp-bg-surface);
  box-shadow: var(--xp-shadow-md);
}
.xp-menu-choice {
  display: flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 12px;
  border-radius: var(--xp-radius-sm);
  color: var(--xp-text-primary);
  text-decoration: none;
  font-size: var(--xp-type-body);
}
.xp-menu-choice:hover,
.xp-menu-choice[aria-current="true"] { background: var(--xp-bg-elevated); }
.xp-menu-density { display: grid; gap: 4px; }
.xp-menu-signout { justify-content: flex-start; }
.xp-icon-back { display: inline-flex; flex: none; align-items: center; }
.xp-icon-back svg { display: block; }
html[dir="rtl"] .xp-icon-back { transform: scaleX(-1); }
.xp-status-standalone {
  min-block-size: 100dvh;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: var(--xp-space-card);
  padding: var(--xp-space-section) var(--xp-space-field);
}
.xp-status-main, .xp-status-card { inline-size: min(100%, 640px); }
.xp-status-card { display: grid; gap: var(--xp-space-field); }
.xp-status-code {
  margin: 0;
  color: var(--xp-text-muted);
  font-size: var(--xp-type-label);
  letter-spacing: 0.04em;
}
.xp-status-actions { display: flex; flex-wrap: wrap; gap: var(--xp-space-sm); }
.xp-breadcrumb { font-size: var(--xp-type-body); line-height: var(--xp-leading-body); }
@media (max-width: 640px) {
  .xp-workspace-summary { gap: 16px; }
  .xp-workspace-summary > .xp-card { padding: 16px; }
  .xp-workspace-summary .xp-kpi-grid { gap: 16px; }
}

/* Golden ratio 1.618 : 1 split layout for primary workspace + live inspector aside */
.xp-golden-grid {
  display: grid;
  grid-template-columns: var(--xp-golden-main) var(--xp-golden-aside);
  gap: var(--xp-space-card);
  align-items: start;
}

.xp-golden-grid > * {
  min-inline-size: 0;
}

.xp-kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
  gap: var(--xp-space-field);
}

.xp-kpi-grid > * {
  min-inline-size: 0;
}

/* Technical KPI text must survive the live client's textContent replacement. */
:is(.xp-io-monitor, .xp-website-analytics) .xp-kpi__value {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: left;
}

html[dir="rtl"] :is(.xp-io-monitor, .xp-website-analytics) .xp-kpi__value {
  text-align: right;
}

.xp-plan-resource-value,
.xp-chart-technical-value {
  white-space: nowrap;
}

.xp-plan-editor-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--xp-space-field);
}

.xp-plan-cap-option {
  display: inline-flex;
  align-items: center;
  gap: var(--xp-space-sm);
  min-block-size: 44px;
  cursor: pointer;
}

.xp-card {
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border);
  border-radius: var(--xp-radius-md);
  padding: var(--xp-space-card);
  box-shadow: none;
}

.xp-card :where(h2, h3) {
  margin-block: 0;
  font-size: var(--xp-type-card);
  font-weight: var(--xp-weight-semibold);
  line-height: var(--xp-leading-card);
}

.xp-card > :first-child { margin-block-start: 0; }
.xp-card > :last-child { margin-block-end: 0; }

.xp-shell :where(.xp-label) {
  font-size: var(--xp-type-label);
  font-weight: var(--xp-weight-medium);
  color: var(--xp-text-secondary);
}

.xp-shell .xp-mono:not(:where(.xp-input, .xp-select, .xp-textarea)),
.xp-shell code,
.xp-shell pre,
.xp-shell kbd { font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label); }

.xp-card__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-block-end: var(--xp-space-field);
}

.xp-card__header > :where(h2, h3) {
  flex: 1 1 12rem;
  min-inline-size: 0;
}

.xp-card__header > .xp-badge {
  max-inline-size: 100%;
  white-space: normal;
}

.xp-card__header > .xp-badge .xp-status-icon { flex-shrink: 0; }
.xp-card__header .xp-prose { margin-block-start: var(--xp-space-sm); }
.xp-form-group > .xp-card__header { margin-block-end: 0; }
#whm-accounts [data-account-row] td:nth-child(5) > span.xp-mono {
  font-family: inherit;
  font-size: var(--xp-type-body);
}

/* Ergonomic buttons & inputs */
.xp-btn,
.xp-input,
.xp-select,
.xp-textarea {
  min-block-size: var(--xp-hit-target);
  padding-block: var(--xp-space-sm);
  padding-inline: var(--xp-space-md);
  border-radius: var(--xp-radius-sm);
  font: inherit;
  font-size: var(--xp-type-body);
  line-height: var(--xp-leading-body);
}

.xp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-inline-size: var(--xp-hit-target);
  gap: 8px;
  cursor: pointer;
  border: 1px solid var(--xp-border-strong);
  background-color: var(--xp-bg-surface);
  color: var(--xp-text-primary);
  font-weight: 600;
  text-decoration: none;
}

.xp-btn--ghost {
  background-color: var(--xp-bg-surface);
  border-color: var(--xp-border-strong);
  color: var(--xp-text-secondary);
  min-block-size: var(--xp-hit-target);
  padding-inline: 12px;
  font-size: var(--xp-type-body);
}

.xp-btn--inline {
  align-self: start;
  justify-self: start;
  min-block-size: var(--xp-hit-target);
  padding-inline: var(--xp-space-sm);
  font-size: var(--xp-type-body);
  background-color: var(--xp-bg-elevated);
}

.xp-btn--primary {
  background-color: var(--xp-accent);
  border-color: var(--xp-accent);
  color: var(--xp-text-on-accent);
  font-weight: 600;
}

.xp-btn--danger {
  background-color: #b42318;
  border-color: #b42318;
  color: #ffffff;
  font-weight: 600;
}

.xp-btn--quiet {
  background: transparent;
  border-color: transparent;
  color: #1d5bd6;
  font-weight: 600;
}

.xp-btn:disabled,
.xp-btn:disabled:hover,
.xp-btn:disabled:active,
.xp-btn--primary:disabled,
.xp-btn--primary:disabled:hover,
.xp-btn--primary:disabled:active {
  background-color: #f0f2f5;
  border-color: #e2e6ec;
  color: #5d6b7e;
  font-weight: 600;
  opacity: 1;
  cursor: not-allowed;
}

.xp-input,
.xp-select,
.xp-textarea {
  inline-size: 100%;
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border-strong);
  color: var(--xp-text-primary);
}

.xp-input:focus,
.xp-select:focus,
.xp-textarea:focus {
  border-color: var(--xp-border-focus);
  outline: var(--xp-focus-width) solid var(--xp-border-focus);
  outline-offset: var(--xp-focus-offset);
}

/* Native control states are scoped to authenticated workspaces. */
.xp-workspace { --xp-control-edge: #8a99af; }
[data-theme="light"] .xp-workspace { --xp-control-edge: #808b9c; }

.xp-workspace :is(.xp-input, .xp-select, .xp-textarea),
.xp-workspace :is(.xp-input, .xp-select, .xp-textarea):focus {
  border-color: var(--xp-control-edge);
}

.xp-workspace :is(.xp-input, .xp-textarea)[readonly] {
  background-color: var(--xp-bg-subtle);
}

/* Keep the native picker and options; only the closed control chrome is authored. */
.xp-workspace select.xp-select:not([multiple]):not([size]) {
  appearance: none;
  min-block-size: var(--xp-hit-target);
  line-height: 24px;
  padding-inline-end: calc(var(--xp-space-md) + var(--xp-space-field));
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: right calc(var(--xp-space-md) + 4px) center, right var(--xp-space-md) center;
  background-size: 4px 4px;
  background-repeat: no-repeat;
}

html[dir="rtl"] .xp-workspace select.xp-select:not([multiple]):not([size]) {
  background-position: left var(--xp-space-md) center, left calc(var(--xp-space-md) + 4px) center;
}

html[dir="rtl"] .xp-workspace select.xp-select[dir="ltr"]:not([multiple]):not([size]) {
  padding-inline-start: calc(var(--xp-space-md) + var(--xp-space-field));
  padding-inline-end: var(--xp-space-md);
}

.xp-workspace label[for]:has(+ :is(input.xp-input:not([type="checkbox"], [type="radio"]), select.xp-select, textarea.xp-textarea)),
.xp-workspace label[for] + :is(input.xp-input:not([type="checkbox"], [type="radio"]), select.xp-select, textarea.xp-textarea) + .xp-help {
  padding-inline: calc(var(--xp-space-md) + 1px);
}

@media (forced-colors: active) {
  .xp-workspace select.xp-select:not([multiple]):not([size]),
  html[dir="rtl"] .xp-workspace select.xp-select[dir="ltr"]:not([multiple]):not([size]) {
    /* Native OS chrome preserves the user's high-contrast picker affordance. */
    appearance: auto;
    background-image: none;
    padding-inline: var(--xp-space-md);
  }
}

.xp-workspace .xp-btn:disabled,
.xp-workspace .xp-btn:disabled:hover,
.xp-workspace .xp-btn:disabled:active {
  background-color: #f0f2f5;
  border-color: #e2e6ec;
  color: #5d6b7e;
  font-weight: 600;
  opacity: 1;
  cursor: not-allowed;
}

.xp-workspace :is(.xp-input, .xp-select, .xp-textarea):disabled {
  background-color: #f0f2f5;
  border-color: #e2e6ec;
  color: #5d6b7e;
  cursor: not-allowed;
  opacity: 1;
}

.xp-workspace :is(.xp-input, .xp-select, .xp-textarea)[aria-invalid="true"] {
  border: 1.5px solid #b42318;
}

.xp-field-error {
  color: #b42318;
  font-weight: 500;
}

.xp-input.xp-mono,
.xp-select.xp-mono,
.xp-textarea.xp-mono {
  font-family: var(--xp-font-mono);
  font-weight: var(--xp-weight-regular);
}

/* Match the field's label edge while preserving each value's text direction. */
bdi[dir="ltr"],
.xp-ltr-value {
  direction: ltr;
  unicode-bidi: isolate;
}

html[dir="rtl"] .xp-login-shell .xp-input,
html[dir="rtl"] .xp-input[dir="ltr"],
html[dir="rtl"] .xp-select[dir="ltr"],
html[dir="rtl"] .xp-textarea[dir="ltr"],
html[dir="rtl"] .xp-field-value[dir="ltr"] {
  direction: ltr;
  unicode-bidi: isolate;
  text-align: right;
}

/* Form chunking (Miller: <= 7 fields per group, 16px field gap) */
.xp-form-group {
  display: flex;
  flex-direction: column;
  gap: var(--xp-space-field);
}

/* Dense admin data tables with compact / comfortable density switcher */
.xp-table-wrap {
  overflow-x: auto;
  max-inline-size: 100%;
  border: 1px solid var(--xp-border);
  border-radius: var(--xp-radius-md);
  background-color: var(--xp-bg-surface);
}

.xp-table-wrap[role="region"][tabindex="0"]:focus-visible {
  outline: var(--xp-focus-width) solid var(--xp-border-focus);
  outline-offset: var(--xp-focus-offset);
}

.xp-table {
  inline-size: 100%;
  border-collapse: collapse;
  text-align: start;
  font-size: var(--xp-type-body);
  line-height: var(--xp-leading-body);
}

.xp-table th,
.xp-table td {
  height: 44px;
  padding-block: var(--xp-space-sm);
  padding-inline: var(--xp-space-field);
  border-block-end: 1px solid var(--xp-border);
  vertical-align: middle;
}

[data-density="compact"] .xp-table th,
[data-density="compact"] .xp-table td,
.xp-table--compact th,
.xp-table--compact td {
  padding-block: var(--xp-space-xs);
  padding-inline: 12px;
  font-size: var(--xp-type-body);
}

.xp-table th {
  background-color: var(--xp-bg-elevated);
  color: var(--xp-text-muted);
  font-size: var(--xp-type-label);
  font-weight: var(--xp-weight-medium);
  white-space: nowrap;
}

.xp-table tbody tr:last-child > td { border-block-end: 0; }
.xp-table tbody tr:hover { background-color: var(--xp-bg-elevated); }

/* Status pills with mandatory SVG icon + text label */
.xp-badge {
  display: inline-flex;
  align-items: center;
  inline-size: fit-content;
  max-inline-size: 100%;
  align-self: start;
  justify-self: start;
  gap: var(--xp-space-xs);
  padding-block: 2px;
  padding-inline: 10px;
  border-radius: 999px;
  font-size: var(--xp-type-caption);
  font-weight: 600;
  line-height: var(--xp-leading-caption);
  border: 1px solid transparent;
  white-space: nowrap;
}

.xp-badge--ok {
  color: var(--xp-status-ok-fg);
  background-color: var(--xp-status-ok-bg);
  border-color: var(--xp-status-ok-border);
}

.xp-badge--warn {
  color: var(--xp-status-warn-fg);
  background-color: var(--xp-status-warn-bg);
  border-color: var(--xp-status-warn-border);
}

.xp-badge--critical {
  color: var(--xp-status-critical-fg);
  background-color: var(--xp-status-critical-bg);
  border-color: var(--xp-status-critical-border);
}

.xp-badge--reconciling {
  color: var(--xp-status-reconciling-fg);
  background-color: var(--xp-status-reconciling-bg);
  border-color: var(--xp-status-reconciling-border);
}

.xp-badge--suspended {
  color: var(--xp-status-suspended-fg);
  background-color: var(--xp-status-suspended-bg);
  border-color: var(--xp-status-suspended-border);
}

@keyframes xp-indet {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(260%); }
}

@keyframes xp-shimmer {
  0% { background-position: -480px 0; }
  100% { background-position: 480px 0; }
}

@keyframes xp-spin {
  to { transform: rotate(360deg); }
}

@keyframes xp-drain {
  from { width: 100%; }
  to { width: 0%; }
}

.xp-status-icon--spin {
  animation: xp-spin 0.9s linear infinite;
}

.xp-meter__indet {
  position: absolute;
  inset-block: 0;
  width: 40%;
  border-radius: 4px;
  background: #1d5bd6;
  animation: xp-indet 1.4s ease-in-out infinite;
}

.xp-skeleton {
  background: linear-gradient(90deg, #eef0f3 0%, #f8f9fb 50%, #eef0f3 100%);
  background-size: 960px 100%;
  animation: xp-shimmer 1.4s linear infinite;
}

[data-theme="dark"] .xp-skeleton {
  background: linear-gradient(90deg, #1d2b40 0%, #2a3a52 50%, #1d2b40 100%);
  background-size: 960px 100%;
}

.xp-card.xp-toast {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
  overflow: hidden;
  box-shadow: 0 12px 24px -10px rgba(16, 24, 40, 0.18);
}

.xp-toast__body {
  padding: 14px;
}

.xp-toast__body p {
  margin: 0;
}

.xp-toast[data-toast-level="critical"] {
  border-color: #f4b8b2;
}

.xp-toast__drain {
  block-size: 3px;
  background: #6ea0ff;
  animation: xp-drain 8s linear infinite;
}

/* 80% / 95% Threshold meters */
.xp-meter {
  display: flex;
  flex-direction: column;
  gap: var(--xp-space-sm);
  min-inline-size: 160px;
}

.xp-meter__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.8125rem;
}

.xp-meter__values {
  order: -1;
  min-inline-size: 0;
  text-align: start;
}

.xp-meter__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: var(--xp-weight-medium);
}

.xp-meter--neutral .xp-meter__status,
.xp-meter__basis { color: var(--xp-text-muted); }
.xp-meter__basis { font-size: var(--xp-type-caption); line-height: var(--xp-leading-caption); }

.xp-meter--ok .xp-meter__status { color: var(--xp-status-ok-fg); }
.xp-meter--warn .xp-meter__status { color: var(--xp-status-warn-fg); }
.xp-meter--critical .xp-meter__status { color: var(--xp-status-critical-fg); }

.xp-meter__track {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #e9ecf1;
  overflow: hidden;
}

.xp-meter__track--compact {
  height: 4px;
  border-radius: 2px;
}

.xp-meter__fill {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: #1d5bd6;
  transition: width 0.6s ease;
}

.xp-meter__track--compact .xp-meter__fill {
  border-radius: 2px;
}

html[dir="rtl"] .xp-meter__fill {
  margin-left: auto;
}

.xp-meter__fill--ok { background-color: #1d5bd6; }
.xp-meter__fill--warn { background-color: #b54708; }
.xp-meter__fill--critical { background-color: #b42318; }

.xp-io-monitor { display: flex; flex-direction: column; gap: var(--xp-space-card); min-inline-size: 0; }
.xp-io-monitor > .xp-card__header { margin-block-end: 0; }
.xp-io-monitor .xp-kpi__value { font-size: var(--xp-type-page); line-height: var(--xp-leading-page); font-weight: var(--xp-weight-semibold); }
.xp-resource-history-unavailable { color: var(--xp-text-muted); }

/* Reconcile Pipeline Stepper Banner (render -> test -> switch -> reload -> verify) */
.xp-reconcile-banner {
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border-strong);
  border-radius: var(--xp-radius-md);
  padding: var(--xp-space-field) var(--xp-space-card);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.xp-reconcile-stepper {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.xp-reconcile-step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding-block: 6px;
  padding-inline: 12px;
  border-radius: var(--xp-radius-sm);
  border: 1px solid var(--xp-border);
  background-color: var(--xp-bg-subtle);
  font-size: 0.85rem;
  font-weight: 500;
}

.xp-reconcile-step[data-step-status="passed"] {
  border-color: var(--xp-status-ok-border);
  color: var(--xp-status-ok-fg);
  background-color: var(--xp-status-ok-bg);
}

.xp-reconcile-step[data-step-status="running"] {
  border-color: var(--xp-status-reconciling-border);
  color: var(--xp-status-reconciling-fg);
  background-color: var(--xp-status-reconciling-bg);
}

.xp-reconcile-step[data-step-status="failed"] {
  border-color: var(--xp-status-critical-border);
  color: var(--xp-status-critical-fg);
  background-color: var(--xp-status-critical-bg);
}

/* Command Palette Modal (Cmd/Ctrl+K) & Slide-Over Drawers */
.xp-modal-backdrop,
.xp-drawer-backdrop {
  position: fixed;
  inset: 0;
  background-color: var(--xp-nav-backdrop);
  backdrop-filter: blur(4px);
  z-index: 80;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-block-start: 10vh;
}

.xp-modal-backdrop[hidden],
.xp-drawer-backdrop[hidden] {
  display: none !important;
}

.xp-cmdk-result[aria-selected="true"] {
  background-color: var(--xp-accent-soft);
  color: var(--xp-text-primary);
  border-inline-start-color: var(--xp-accent);
}

.xp-cmdk-result {
  flex-wrap: wrap;
  gap: 4px 8px;
  padding-block: 8px;
}

.xp-cmdk-result__section {
  color: var(--xp-text-muted);
  font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label);
}
.xp-cmdk-result__route {
  margin-inline-start: auto;
  font-size: var(--xp-type-caption);
  line-height: var(--xp-leading-caption);
}
.xp-cmdk-result > code {
  max-inline-size: 100%;
  overflow-wrap: anywhere;
}

.xp-cmdk-results {
  position: relative;
  overflow-anchor: none;
  scroll-behavior: auto;
}
.xp-cmdk-dialog {
  inline-size: min(640px, 92vw);
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border-strong);
  border-radius: var(--xp-radius-lg);
  box-shadow: var(--xp-shadow-lg);
  overflow: hidden;
}

.xp-drawer {
  position: fixed;
  inset-block: 0;
  inset-inline-end: 0;
  inline-size: min(540px, 94vw);
  background-color: var(--xp-bg-surface);
  border-inline-start: 1px solid var(--xp-border-strong);
  box-shadow: var(--xp-shadow-lg);
  padding: var(--xp-space-card);
  overflow-y: auto;
  z-index: 85;
}

/* Interactive SVG Charts & Tooltips */
.xp-chart-container {
  position: relative;
  inline-size: 100%;
}

.xp-chart-svg {
  inline-size: 100%;
  block-size: auto;
  display: block;
  overflow: visible;
}

.xp-chart-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--xp-space-field);
  font-size: 0.85rem;
  color: var(--xp-text-secondary);
}

.xp-chart-swatch {
  display: inline-block;
  inline-size: 10px;
  block-size: 10px;
  border-radius: 2px;
  margin-inline-end: 6px;
}

/* Explicit Async Action & Availability State Banners */
.xp-action-state {
  background-color: var(--xp-bg-surface);
  border: 1px solid var(--xp-border-strong);
  border-inline-start-width: 4px;
  border-radius: var(--xp-radius-md);
  padding: var(--xp-space-field) var(--xp-space-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.xp-action-state__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.xp-action-state__meta {
  margin-inline-start: auto;
  font-size: 0.82rem;
  color: var(--xp-text-secondary);
}

.xp-action-state--loading,
.xp-action-state--pending {
  border-inline-start-color: var(--xp-border-focus);
  background-color: var(--xp-status-reconciling-bg);
}

.xp-action-state--succeeded {
  border-inline-start-color: var(--xp-status-ok-bar);
  background-color: var(--xp-status-ok-bg);
}

.xp-action-state--denied,
.xp-action-state--failed {
  border-inline-start-color: var(--xp-status-critical-bar);
  background-color: var(--xp-status-critical-bg);
}

.xp-action-state--unavailable,
.xp-action-state--conflict {
  border-inline-start-color: var(--xp-status-warn-bar);
  background-color: var(--xp-status-warn-bg);
}

/* Jailed Terminal & Code Editor */
.xp-terminal {
  background-color: var(--xp-bg-code);
  border: 1px solid var(--xp-border-strong);
  border-radius: var(--xp-radius-md);
  font-family: var(--xp-font-mono);
  font-size: 0.85rem;
  padding: var(--xp-space-field);
  color: var(--xp-text-code);
  overflow-x: auto;
}

@media (max-width: 960px) {
  .xp-golden-grid,
  .xp-mail-tri-pane {
    grid-template-columns: 1fr !important;
  }
  .xp-topbar {
    block-size: auto;
    min-block-size: var(--xp-topbar-height);
    flex-wrap: wrap;
    padding-block: 8px;
    padding-inline: var(--xp-space-field);
  }
  .xp-main {
    padding-inline: var(--xp-space-field);
  }
}

@media (width < 960px) {
  .xp-shell,
  .xp-shell[data-sidebar="collapsed"] {
    grid-template-columns: minmax(0, 1fr);
  }

  .xp-topbar {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    block-size: var(--xp-mobile-topbar-height);
    min-block-size: var(--xp-mobile-topbar-height);
    gap: var(--xp-space-xs);
    padding-block: 8px;
    padding-inline: var(--xp-space-field);
  }

  .xp-shell .xp-input,
  .xp-shell .xp-select,
  .xp-shell .xp-textarea {
    font-size: var(--xp-type-input-mobile);
    line-height: var(--xp-leading-input-mobile);
  }

  .xp-mobile-brand {
    display: block;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--xp-text-primary);
    font-family: var(--xp-font-sans-ltr);
    font-size: var(--xp-type-card);
    line-height: var(--xp-leading-card);
    font-weight: 600;
    text-decoration: none;
  }

  .xp-toolbar-options {
    display: block;
    position: static;
    min-inline-size: 0;
  }

  .xp-toolbar-options > summary {
    display: inline-flex;
    list-style: none;
    white-space: nowrap;
  }

  .xp-toolbar-options > summary::-webkit-details-marker {
    display: none;
  }

  .xp-toolbar-options > .xp-toolbar-options__content {
    display: none;
  }

  .xp-toolbar-options[data-mobile-ready][open] > .xp-toolbar-options__content {
    display: flex;
    flex-direction: column;
    gap: var(--xp-space-field);
    position: absolute;
    inset-block-start: 100%;
    inset-inline: var(--xp-space-field);
    max-block-size: min(70dvh, var(--xp-toolbar-panel-max));
    padding: var(--xp-space-field);
    overflow-y: auto;
    overscroll-behavior: contain;
    background-color: var(--xp-bg-surface);
    color: var(--xp-text-primary);
    border: 1px solid var(--xp-border-strong);
    border-radius: var(--xp-radius-sm);
    box-shadow: var(--xp-shadow-md);
    z-index: 1;
  }

  .xp-toolbar-options__content .xp-topbar__start,
  .xp-toolbar-options__content .xp-topbar__end {
    flex-direction: column;
    align-items: stretch;
    inline-size: 100%;
    gap: var(--xp-space-sm);
  }

  .xp-toolbar-options__content .xp-topbar__start > *,
  .xp-toolbar-options__content .xp-topbar__end > * {
    max-inline-size: 100%;
  }

  .xp-shell [data-action="toggle-mobile-nav"],
  .xp-shell .xp-mobile-nav-close {
    display: inline-flex;
  }

  .xp-mobile-nav-close {
    align-self: flex-end;
  }

  .xp-shell .xp-sidebar,
  .xp-shell[data-sidebar="collapsed"] .xp-sidebar {
    position: fixed;
    inset-block: 0;
    inset-inline-start: 0;
    inline-size: min(var(--xp-mobile-sheet-max), calc(100vw - var(--xp-mobile-sheet-gutter) - var(--xp-mobile-sheet-gutter)));
    block-size: 100dvh;
    max-block-size: 100dvh;
    z-index: 70;
    visibility: hidden;
    pointer-events: none;
    overscroll-behavior: contain;
    box-shadow: var(--xp-shadow-lg);
  }

  .xp-shell[data-mobile-nav="open"] .xp-sidebar {
    visibility: visible;
    pointer-events: auto;
  }

  .xp-nav-backdrop,
  [data-xp-nav-backdrop] {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 60;
    background-color: var(--xp-nav-backdrop);
    border: 0;
    padding: 0;
  }

  .xp-topbar__start {
    flex: 1 1 auto;
  }

  .xp-topbar .xp-page-title {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 640px) {
  .xp-login-topbar,
  .xp-login-main,
  .xp-login-footer {
    padding-inline: 16px;
  }
  .xp-login-card,
  .xp-login-aside-card {
    padding: var(--xp-space-field);
  }

  /* File metadata and policy badges follow readable headings on narrow screens. */
  #xpanel-file-manager .xp-card__header {
    flex-direction: column;
    align-items: stretch;
  }

  #xpanel-file-manager .xp-card__header > :where(h2, h3) {
    flex: 0 1 auto;
  }

  #xpanel-file-manager .xp-card__header > * {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow-wrap: anywhere;
  }

  #xpanel-file-manager .xp-card__header .xp-badge {
    align-self: flex-start;
    max-inline-size: 100%;
    white-space: normal;
  }

  #xpanel-file-manager .xp-card__header .xp-badge__label {
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  #xpanel-file-manager .xp-card__header .xp-status-icon {
    flex-shrink: 0;
  }
}

@media (max-width: 640px) {
  .xp-card { padding: var(--xp-space-field); }
}

@media (max-width: 480px) {
  .xp-kpi-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .xp-card {
    padding: var(--xp-space-field);
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
/* Accounts workspace and row-bound confirmation. */
.xp-accounts { min-inline-size: 0; }
.xp-accounts--create { inline-size: 100%; max-inline-size: 690px; justify-self: start; }
.xp-accounts #whm-create-account-drawer { max-inline-size: 640px; }
.xp-accounts #whm-create-account-drawer > button[type="submit"] { inline-size: max-content; min-inline-size: 44px; max-inline-size: 100%; }
.xp-accounts__header { margin-block-end: 24px; }
.xp-accounts__table { table-layout: auto; }
.xp-accounts__table :where(th, td) { padding: 16px; text-align: start; }
.xp-accounts__table th { white-space: nowrap; }
.xp-accounts__table td { vertical-align: top; }
.xp-accounts__table td:first-child { min-inline-size: 130px; }
.xp-accounts__identity { display: grid; gap: 8px; }
.xp-accounts__identity > strong { font-size: var(--xp-type-body); font-weight: var(--xp-weight-semibold); }
.xp-accounts__details { min-inline-size: 0; }
.xp-accounts__details > summary { display: flex; align-items: center; gap: 8px; min-block-size: 44px; inline-size: max-content; max-inline-size: 100%; padding: 0 8px; margin-inline-start: -8px; color: var(--xp-text-secondary); font-size: var(--xp-type-label); cursor: pointer; list-style: none; }
.xp-accounts__details > summary::-webkit-details-marker { display: none; }
.xp-accounts__details > summary::after { content: ''; inline-size: 6px; block-size: 6px; border-inline-end: 1.5px solid currentColor; border-block-end: 1.5px solid currentColor; transform: rotate(45deg); margin-block-start: -3px; }
.xp-accounts__details[open] > summary::after { transform: rotate(225deg); margin-block-start: 3px; }
.xp-accounts__technical { display: grid; gap: 16px; margin: 8px 0 0; min-inline-size: 0; }
.xp-accounts__technical > div, .xp-accounts__field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-inline-size: 0; text-align: start; }
.xp-accounts__technical dt, .xp-accounts__field > dt { color: var(--xp-text-secondary); font-size: var(--xp-type-label); line-height: var(--xp-leading-label); }
.xp-accounts__technical dd, .xp-accounts__field > dd { margin: 0; min-inline-size: 0; }
.xp-accounts__technical dd { font-family: var(--xp-font-mono); font-size: var(--xp-type-label); overflow-wrap: anywhere; }
.xp-accounts__technical bdi, .xp-account-dialog__identity bdi { display: block; overflow-wrap: anywhere; text-align: left; }
html[dir="rtl"] .xp-accounts__technical bdi, html[dir="rtl"] .xp-account-dialog__identity bdi { text-align: right; }
.xp-accounts__domain { overflow-wrap: anywhere; }
.xp-accounts__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.xp-accounts__actions > button { white-space: nowrap; }
.xp-accounts__delete { color: var(--xp-status-critical-fg); }
.xp-accounts__mobile-label { display: none; }
.xp-accounts__empty { margin: 0; padding: 16px 0; color: var(--xp-text-secondary); }
.xp-accounts__field[hidden] { display: none; }
.xp-dialog,
.xp-account-dialog { inline-size: min(500px, calc(100% - 32px)); max-inline-size: 500px; max-block-size: calc(100dvh - 32px); box-sizing: border-box; padding: 24px; border: 1px solid var(--xp-border); border-radius: 12px; background: var(--xp-bg-surface); color: var(--xp-text-primary); box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12); overflow: auto; }
.xp-dialog { position: fixed; inset: 0; margin: auto; }
.xp-dialog::backdrop,
.xp-account-dialog::backdrop { background: rgba(16, 24, 40, 0.4); }
.xp-dialog > form,
.xp-account-dialog > form { display: grid; gap: 16px; min-inline-size: 0; }
.xp-dialog__header { display: grid; gap: 8px; }
.xp-dialog__header > h2 { margin: 0; font-size: var(--xp-type-card); line-height: var(--xp-leading-card); font-weight: var(--xp-weight-semibold); }
.xp-dialog__header > p { margin: 0; color: var(--xp-text-secondary); font-size: var(--xp-type-body); line-height: var(--xp-leading-body); }
.xp-dialog__footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.xp-dialog__footer > button { min-block-size: 44px; }
.xp-accounts > .xp-account-dialog { position: fixed; inset: 0; margin: auto; }
.xp-account-dialog .xp-accounts__delete { color: var(--xp-status-critical-fg); background-color: var(--xp-status-critical-bg); border-color: var(--xp-status-critical-border); }
.xp-account-dialog::backdrop { background: rgba(16, 24, 40, .4); }
.xp-account-dialog > form { display: grid; gap: 24px; min-inline-size: 0; }
.xp-account-dialog__header { display: grid; gap: 8px; }
.xp-account-dialog__header > h2 { margin: 0; font-size: var(--xp-type-card); line-height: var(--xp-leading-card); font-weight: var(--xp-weight-semibold); }
.xp-account-dialog__header > p { margin: 0; font-size: var(--xp-type-body); line-height: var(--xp-leading-body); color: var(--xp-text-secondary); }
.xp-account-dialog__identity { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0; }
.xp-account-dialog__identity dd { font-size: var(--xp-type-body); }
.xp-account-dialog__footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.xp-account-dialog__footer > button { min-block-size: 44px; }
.xp-account-dialog__status { margin: 0; padding: 16px; border: 1px solid var(--xp-border); border-radius: var(--xp-radius-sm); font-size: var(--xp-type-body); line-height: var(--xp-leading-body); overflow-wrap: anywhere; }
.xp-account-dialog__status[data-state="failed"] { color: var(--xp-status-critical-fg); border-color: var(--xp-status-critical-border); }
.xp-account-dialog__status[hidden] { display: none; }
@media (max-width: 719px) {
  .xp-accounts__table-wrap { border: 0; overflow: visible; background: transparent; }
  .xp-accounts__table, .xp-accounts__table tbody { display: block; inline-size: 100%; }
  .xp-accounts__table thead { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .xp-accounts__table tr { display: grid; gap: 16px; padding: 16px; border: 1px solid var(--xp-border); border-radius: var(--xp-radius-md); background: var(--xp-bg-surface); }
  .xp-accounts__table tr + tr { margin-block-start: 16px; }
  .xp-accounts__table td { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-inline-size: 0; padding: 0; border: 0; }
  .xp-accounts__table td:first-child { min-inline-size: 0; }
  .xp-accounts__identity { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
  .xp-accounts__details > summary { margin-block-start: -12px; }
  .xp-accounts__details[open] { grid-column: 1 / -1; }
  .xp-accounts__technical { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .xp-accounts__mobile-label { display: block; font-size: var(--xp-type-label); line-height: var(--xp-leading-label); color: var(--xp-text-secondary); }
  .xp-accounts__domain { display: block; text-align: left; }
  html[dir="rtl"] .xp-accounts__domain { text-align: right; }
}
@media (max-width: 479px) {
  .xp-account-dialog { padding: 24px; }
  .xp-account-dialog__identity { grid-template-columns: minmax(0, 1fr); }
  .xp-account-dialog__footer > button { flex: 1 1 auto; }
}

.xp-account-security { min-inline-size: 0; }
.xp-main > .xp-account-security { margin-block-end: var(--xp-space-card); }
.xp-account-security .xp-help { margin: 0; }
.xp-totp-qr { display: inline-block; inline-size: max-content; max-inline-size: 100%; padding: 8px; background: #ffffff; border: 1px solid var(--xp-border); border-radius: var(--xp-radius-sm, 6px); line-height: 0; }
.xp-totp-qr > svg { display: block; inline-size: 168px; block-size: 168px; max-inline-size: 100%; }

${MAIL_LAYOUT_CSS}
${ARABIC_TYPE_CSS}
`
