import type { LiveReadStatus } from '../design-system/components/live-read-state.ts'
import type { MetricProps } from '../design-system/components/metric.ts'
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRate,
  isolateTechnical,
} from '../design-system/formatters.ts'
import type { TextTranslator } from '../design-system/html.ts'

export interface TelemetrySample {
  readonly status: LiveReadStatus
  readonly observedAt?: string | null
  readonly hostname?: string | null
  readonly osLabel?: string | null
  readonly kernel?: string | null
  readonly uptimeSeconds?: number | null
  readonly cpuLoad1m?: number | null
  readonly cpuCores?: number | null
  readonly memoryUsedBytes?: number | null
  readonly memoryTotalBytes?: number | null
  readonly diskUsedBytes?: number | null
  readonly diskTotalBytes?: number | null
  readonly inodeUsed?: number | null
  readonly inodeTotal?: number | null
  readonly bandwidthRateBps?: number | null
}

export interface ProjectedTelemetry {
  readonly status: LiveReadStatus
  readonly lastReadAt: string | null
  readonly metrics: readonly MetricProps[]
  readonly summary: {
    readonly loadText: string
    readonly memoryText: string
    readonly diskText: string
    readonly inodeText: string
    readonly uptimeText: string
    readonly bandwidthText: string
    readonly observedText: string
  }
}

function ratioHint(used: number | null | undefined, total: number | null | undefined, locale: string): string | undefined {
  if (typeof used !== 'number' || typeof total !== 'number' || total <= 0 || !Number.isFinite(used)) return undefined
  return formatPercent((used / total) * 100, locale, 1)
}

function pairBytes(used: number | null | undefined, total: number | null | undefined, locale: string, fallback: string): string {
  if (typeof used !== 'number' || !Number.isFinite(used)) return fallback
  const usedText = formatBytes(used, locale)
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return usedText
  return `${usedText} / ${formatBytes(total, locale)}`
}

/** Projects authoritative host or account telemetry using unified design-system formatters. */
export function projectTelemetry(
  sample: TelemetrySample,
  locale: string,
  t: TextTranslator,
  options: { readonly timeZone?: string } = {},
): ProjectedTelemetry {
  const unavailable = sample.status === 'disabled' ? t('Enable service') : t('Loading...')
  const loadText = typeof sample.cpuLoad1m === 'number' && Number.isFinite(sample.cpuLoad1m)
    ? sample.cpuCores
      ? `${formatNumber(sample.cpuLoad1m, locale, 2)} (${formatNumber(sample.cpuCores, locale, 0)})`
      : formatNumber(sample.cpuLoad1m, locale, 2)
    : unavailable
  const memoryText = pairBytes(sample.memoryUsedBytes, sample.memoryTotalBytes, locale, unavailable)
  const diskText = pairBytes(sample.diskUsedBytes, sample.diskTotalBytes, locale, unavailable)
  const inodeText = typeof sample.inodeUsed === 'number' && Number.isFinite(sample.inodeUsed)
    ? typeof sample.inodeTotal === 'number' && Number.isFinite(sample.inodeTotal)
      ? `${formatNumber(sample.inodeUsed, locale, 0)} / ${formatNumber(sample.inodeTotal, locale, 0)}`
      : formatNumber(sample.inodeUsed, locale, 0)
    : unavailable
  const uptimeText = typeof sample.uptimeSeconds === 'number' && Number.isFinite(sample.uptimeSeconds)
    ? formatDuration(sample.uptimeSeconds, t)
    : unavailable
  const bandwidthText = typeof sample.bandwidthRateBps === 'number' && Number.isFinite(sample.bandwidthRateBps)
    ? formatRate(sample.bandwidthRateBps, locale)
    : unavailable
  const observedText = sample.observedAt
    ? formatDateTime(sample.observedAt, { locale, ...(options.timeZone ? { timeZone: options.timeZone } : {}) })
    : unavailable

  const metrics: MetricProps[] = [
    {
      label: t('Load'),
      value: loadText,
      technical: true,
      ...(sample.osLabel ? { hint: sample.osLabel } : {}),
    },
    {
      label: t('Memory'),
      value: memoryText,
      technical: true,
      ...(ratioHint(sample.memoryUsedBytes, sample.memoryTotalBytes, locale) ? { hint: ratioHint(sample.memoryUsedBytes, sample.memoryTotalBytes, locale) } : {}),
    },
    {
      label: t('Disk space'),
      value: diskText,
      technical: true,
      ...(ratioHint(sample.diskUsedBytes, sample.diskTotalBytes, locale) ? { hint: ratioHint(sample.diskUsedBytes, sample.diskTotalBytes, locale) } : {}),
    },
    {
      label: t('Uptime'),
      value: uptimeText,
      technical: false,
      ...(sample.observedAt ? { hint: observedText } : {}),
    },
  ]

  return {
    status: sample.status,
    lastReadAt: sample.observedAt ?? null,
    metrics,
    summary: {
      loadText,
      memoryText,
      diskText,
      inodeText,
      uptimeText,
      bandwidthText,
      observedText,
    },
  }
}

export function formatTechnicalBadge(value: string | null | undefined, fallback: string): string {
  return value ? isolateTechnical(value) : isolateTechnical(fallback)
}
