import type { CanonicalIoAnalyticsUnavailable } from '@xpanel/core'
import type { ComposedContext } from '../composed/context.ts'
import { canReadSelectedAccount } from '../composed/context.ts'
import { escapeHtml, formatAsciiDate, formatAsciiNumber } from '../../tokens.ts'
import { localeDirection, translator } from '../../i18n.ts'
type Copy = string
type Usage = NonNullable<ComposedContext['usage']>

/** Only an authorized per-account projection belongs here, never a whole-server IO DTO. */
export type ResourcesBoardReading = { readonly accountId: string } & (
  | { readonly available: true; readonly snapshot: Usage; readonly observedAt: string | null }
  | CanonicalIoAnalyticsUnavailable
)

export interface ResourcesBoardProps {
  readonly context: ComposedContext
  /** Inject the existing reader result. This view never starts a second fetch. */
  readonly reading?: ResourcesBoardReading
}

interface Value { text: string; technical: boolean }
interface Row { id: string; label: Copy; limit: Value; used: Value; state: 'measured' | 'unavailable' | 'unread' | 'unmeasured' }
const copy = (context: ComposedContext, value: Copy): string => translator(context.locale)(value)
const human = (text: string): Value => ({ text, technical: false })
const numeric = (text: string): Value => ({ text, technical: true })
const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown): value is number => known(value) && Number.isSafeInteger(value)
const number = (value: number): string => formatAsciiNumber(value, { useGrouping: false })
const mib = (bytes: number): string => bytes > 0 && bytes < 1024 * 1024 ? `${number(bytes)} B` : `${number(Number((bytes / (1024 * 1024)).toFixed(2)))} MiB`
const unavailable: Copy = msgid('Unavailable')
const unread: Copy = msgctxt('resources-board', 'Not read')
const unmeasured: Copy = msgid('Not measured')
const notReported: Copy = msgid('Not reported by the agent')

const reasons: Record<CanonicalIoAnalyticsUnavailable['reason'], Copy> = {
  'not-sampled': msgid('No completed sample'),
  paused: msgid('Sampling is paused'),
  stale: msgid('The sample is stale'),
  'configuration-changed': msgid('Configuration changed; a new sample is required'),
  invalid: msgid('The sample is invalid'),
  incomplete: msgid('The sample is incomplete'),
}

const valueHtml = (value: Value): string => value.technical ? `<bdi dir="ltr" class="xp-mono">${escapeHtml(value.text)}</bdi>` : escapeHtml(value.text)
const fact = (context: ComposedContext, label: Copy, value: Value, attribute = ''): string => `<div class="xp-resource-board__field"><dt>${escapeHtml(copy(context, label))}</dt><dd${attribute}>${valueHtml(value)}</dd></div>`
const css = `<style>
.xp-resource-board{display:grid;gap:32px;min-inline-size:0;text-align:start;color:var(--xp-text-primary);font-family:var(--xp-font-sans-ltr);font-size:var(--xp-type-body);line-height:var(--xp-leading-body)}
.xp-resource-board[lang="ar"]{font-family:var(--xp-font-sans-rtl)}
.xp-resource-board :is(h2,p,dl,dd){margin:0;max-inline-size:none}
.xp-resource-board h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}
.xp-resource-board :is(p,dd){font-size:var(--xp-type-body);line-height:var(--xp-leading-body)}
.xp-resource-board__groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px;min-inline-size:0}
.xp-resource-board__card{display:grid;gap:24px;min-inline-size:0;padding:24px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
.xp-resource-board__facts{display:grid;gap:16px;min-inline-size:0}
.xp-resource-board__field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-inline-size:0;text-align:start}
.xp-resource-board__field dt{font-weight:600;font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-resource-board__field dd{min-inline-size:0;text-align:start;overflow-wrap:anywhere}
.xp-resource-board__field bdi{display:inline;unicode-bidi:isolate;white-space:normal;overflow-wrap:anywhere}
@media(max-width:600px){.xp-resource-board__card{padding:16px}}
</style>`

/** A read-only inner surface; the existing adapter owns navigation and capability admission. */
export function renderResourcesBoard({ context, reading }: ResourcesBoardProps): string {
  if (!canReadSelectedAccount(context)) return `<section class="xp-resource-board" data-resource-reading="denied"><p>${escapeHtml(copy(context, msgid('An authorized account context is required.')))}</p></section>`
  const bound = reading?.accountId === context.account?.id
  const available = bound && reading?.available === true && reading.snapshot !== null && typeof reading.snapshot === 'object'
  const sample = available && reading?.available === true ? reading.snapshot : undefined
  const state = reading === undefined ? 'unread' : available ? 'read' : 'unavailable'
  const unknown = human(copy(context, state === 'unread' ? unread : unavailable))
  const plan = context.plan?.id === context.account?.planId ? context.plan?.resources : undefined
  const limit = (value: unknown, unit: string): Value => value === 'unlimited'
    ? human(copy(context, msgid('Unlimited')))
    : known(value) ? numeric(`${number(value)}${unit ? ` ${unit}` : ''}`) : human(copy(context, unread))
  const row = (id: string, label: Copy, stored: Value, observed: unknown, format: (value: number) => string): Row => ({
    id, label, limit: stored, used: count(observed) ? numeric(format(observed)) : unknown,
    state: count(observed) ? 'measured' : state === 'unread' ? 'unread' : 'unavailable',
  })
  const rows: Row[] = [
    row('disk', msgid('Disk'), limit(plan?.diskMb, 'MiB'), sample?.diskBytes, mib),
    row('memory', msgid('Memory'), limit(plan?.memoryMb, 'MiB'), sample?.memoryBytes, mib),
    row('processes', msgid('Processes'), limit(plan?.maxProcesses, ''), sample?.processCount, number),
    { id: 'cpu', label: msgid('CPU'), limit: limit(plan?.cpuPercent, '%'), used: unknown, state: state === 'unread' ? 'unread' : 'unavailable' },
    { id: 'bandwidth', label: msgid('Bandwidth / month'), limit: limit(plan?.bandwidthMbMonth, 'MiB'), used: human(copy(context, unmeasured)), state: 'unmeasured' },
    { id: 'io-read', label: msgid('Disk read rate'), limit: limit(plan?.ioReadBps, 'B/s'), used: unknown, state: state === 'unread' ? 'unread' : 'unavailable' },
    { id: 'io-write', label: msgid('Disk write rate'), limit: limit(plan?.ioWriteBps, 'B/s'), used: unknown, state: state === 'unread' ? 'unread' : 'unavailable' },
    { id: 'io-await', label: msgid('IO latency'), limit: human(copy(context, msgid('No stored limit'))), used: human(copy(context, unmeasured)), state: 'unmeasured' },
  ]
  const observedAt = bound && reading?.observedAt && Number.isFinite(Date.parse(reading.observedAt)) ? numeric(formatAsciiDate(reading.observedAt, { includeTime: true })) : human(copy(context, notReported))
  const status = bound && reading?.available === false ? human(copy(context, reasons[reading.reason] ?? unavailable))
    : human(copy(context, available ? msgid('Account usage sample') : state === 'unread' ? unread : unavailable))
  const verification = sample?.ioEnforced === true ? msgid('Verified for this sample')
    : sample?.ioEnforced === false ? msgid('Observed mismatch') : unread
  return `<section class="xp-resource-board" lang="${context.locale}" dir="${localeDirection(context.locale)}" data-resource-reading="${state}">${css}
<section class="xp-resource-board__card" aria-labelledby="resource-reading-title"><h2 id="resource-reading-title">${escapeHtml(copy(context, msgid('Resource readings')))}</h2><p>${escapeHtml(copy(context, msgid('Stored plan limits are desired configuration. Readings and IO verification are separate observations; no process or service readings are invented.')))}</p><dl class="xp-resource-board__facts">${fact(context, msgid('Reading state'), status)}${fact(context, msgid('Observed at'), observedAt)}${fact(context, msgid('IO cap verification'), human(copy(context, verification)))}</dl></section>
<div class="xp-resource-board__groups">${rows.map(item => `<section class="xp-resource-board__card" data-resource-metric="${item.id}" data-resource-state="${item.state}" aria-labelledby="resource-${item.id}-title"><h2 id="resource-${item.id}-title">${escapeHtml(copy(context, item.label))}</h2><dl class="xp-resource-board__facts">${fact(context, msgid('Stored plan limit'), item.limit)}${fact(context, msgid('Current reading'), item.used, ' data-resource-value')}</dl></section>`).join('')}</div></section>`
}
