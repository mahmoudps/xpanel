import { system as systemRender } from '@xpanel/render'
import type { CanonicalIoAnalyticsUnavailable } from '@xpanel/core'
import type { ComposedContext } from '../composed/context.ts'
import { canReadSelectedAccount } from '../composed/context.ts'
import { escapeHtml, formatAsciiBytes, formatAsciiDate, formatAsciiNumber } from '../../tokens.ts'
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
const mib = (bytes: number): string => formatAsciiBytes(bytes)
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
.xp-resource-board :is(h2,h3,p,dl,dd){margin:0;max-inline-size:none}
.xp-resource-board :is(h2,h3){font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}
.xp-resource-board :is(p,dd){font-size:var(--xp-type-body);line-height:var(--xp-leading-body)}
.xp-resource-board__groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:24px;min-inline-size:0}
.xp-resource-board__card{display:grid;gap:24px;min-inline-size:0;padding:24px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
.xp-resource-board__facts{display:grid;gap:16px;min-inline-size:0}
.xp-resource-board__field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-inline-size:0;text-align:start}
.xp-resource-board__field dt{font-weight:600;font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-resource-board__field dd{min-inline-size:0;text-align:start;overflow-wrap:anywhere}
.xp-resource-board__field bdi{display:inline;unicode-bidi:isolate;white-space:normal;overflow-wrap:anywhere}
.xp-resource-board__workspace{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:24px;align-items:start;min-inline-size:0}
.xp-resource-board__main{display:grid;gap:32px;min-inline-size:0}
.xp-resource-board__charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;min-inline-size:0}
.xp-resource-board__toolbar,.xp-resource-board__ranges{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.xp-resource-board__toolbar{justify-content:space-between;gap:16px}
.xp-resource-board button{min-block-size:44px;padding:8px 16px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface);color:var(--xp-text-primary);font:inherit}
.xp-resource-board button:disabled{cursor:not-allowed;opacity:.65}
.xp-resource-board__plot{display:grid;align-content:center;gap:16px;min-block-size:180px;padding:24px;border:1px dashed var(--xp-border);border-radius:8px;text-align:center}
.xp-resource-board__stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.xp-resource-board__scroll{min-inline-size:0;max-inline-size:100%;overflow:auto}
.xp-resource-board table{inline-size:100%;min-inline-size:640px;border-collapse:collapse;text-align:start}
.xp-resource-board :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;border-block-end:1px solid var(--xp-border);overflow-wrap:anywhere}
.xp-resource-board th{font-size:var(--xp-type-label);line-height:var(--xp-leading-label);font-weight:600}.xp-resource-board th[scope=row]{min-inline-size:140px}
.xp-resource-board__list{display:grid;gap:16px;list-style:none;margin:0;padding:0}.xp-resource-board__list>li{display:grid;gap:8px;padding-block:16px;border-block-start:1px solid var(--xp-border)}
.xp-resource-board details{display:grid;gap:16px;min-inline-size:0}.xp-resource-board summary{min-block-size:44px;align-content:center;cursor:pointer;font-weight:600}
.xp-resource-board__code{margin:0;padding:16px;border:1px solid var(--xp-border);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
details>.xp-resource-board__code{margin-block-start:16px}
.xp-resource-board__caption{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(max-width:1100px){.xp-resource-board__workspace{grid-template-columns:minmax(0,1fr)}}
@media(max-width:800px){.xp-resource-board__charts{grid-template-columns:minmax(0,1fr)}}
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
    sample?.bandwidthMonth && sample.bandwidthMonth.totalBytes !== null
      ? { id: 'bandwidth', label: msgid('Bandwidth / month'), limit: limit(plan?.bandwidthMbMonth, 'MiB'), used: numeric(mib(sample.bandwidthMonth.totalBytes) + (sample.bandwidthMonth.limited ? ' · ' + copy(context, msgid('Limit page served')) : '')), state: 'measured' }
      : { id: 'bandwidth', label: msgid('Bandwidth / month'), limit: limit(plan?.bandwidthMbMonth, 'MiB'), used: human(copy(context, unmeasured)), state: 'unmeasured' },
    { id: 'io-read', label: msgid('Disk read rate'), limit: limit(plan?.ioReadBps, 'B/s'), used: unknown, state: state === 'unread' ? 'unread' : 'unavailable' },
    { id: 'io-write', label: msgid('Disk write rate'), limit: limit(plan?.ioWriteBps, 'B/s'), used: unknown, state: state === 'unread' ? 'unread' : 'unavailable' },
    { id: 'io-await', label: msgid('IO latency'), limit: human(copy(context, msgid('No stored limit'))), used: human(copy(context, unmeasured)), state: 'unmeasured' },
  ]
  const observedAt = bound && reading?.observedAt && Number.isFinite(Date.parse(reading.observedAt)) ? numeric(formatAsciiDate(reading.observedAt, { includeTime: true })) : human(copy(context, notReported))
  const status = bound && reading?.available === false ? human(copy(context, reasons[reading.reason] ?? unavailable))
    : human(copy(context, available ? msgid('Account usage sample') : state === 'unread' ? unread : unavailable))
  const verification = sample?.ioEnforced === true ? msgid('Verified for this sample')
    : sample?.ioEnforced === false ? msgid('Observed mismatch') : unread
  const text = (value: Copy): string => escapeHtml(copy(context, value))
  const notRead = human(copy(context, unread))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-resource-board__card" aria-labelledby="resource-${key}-heading"><h2 id="resource-${key}-heading">${text(title)}</h2>${body}</section>`
  const facts = (items: readonly (readonly [Copy, Value])[]): string => `<dl class="xp-resource-board__stats">${items.map(([label, value]) => fact(context, label, value)).join('')}</dl>`
  const table = (key: string, title: Copy, headings: readonly Copy[], body: string): string => `<div class="xp-resource-board__scroll" role="region" tabindex="0" aria-labelledby="resource-${key}-caption"><table><caption class="xp-resource-board__caption" id="resource-${key}-caption">${text(title)}</caption><thead><tr>${headings.map(label => `<th scope="col">${text(label)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`
  const emptyTable = (key: string, title: Copy, headings: readonly Copy[], message: Copy): string => table(key, title, headings, `<tr data-resource-observation="unread"><td colspan="${headings.length}"><p role="status">${text(message)}</p></td></tr>`)
  const chart = (key: string, title: Copy, current: Value, configured: Value): string => card(key, title,
    `<div class="xp-resource-board__plot" data-resource-observation="unread"><p role="status">${text(msgctxt('resources-board', 'History has not been read.'))}</p></div>`
    + facts([[msgctxt('resources-board', 'Average'), notRead], [msgctxt('resources-board', 'Peak'), notRead], [msgid('Current reading'), current], [msgid('Stored plan limit'), configured]]))
  const unit = card('slice', msgctxt('resources-board', 'Account isolation slice'), `<p>${text(msgctxt('resources-board', 'Stored configuration is not a running-unit or applied-limit observation.'))}</p>`
    + facts([[msgctxt('resources-board', 'Configured isolation slice'), numeric(systemRender.accountSliceName(context.account!.uid))], [msgctxt('resources-board', 'Observed unit state'), notRead]])
    + `<details><summary>${text(msgctxt('resources-board', 'Service unit details'))}</summary><pre class="xp-resource-board__code">${text(msgctxt('resources-board', 'Unit file has not been read.'))}</pre></details>`)
  const comparedRows: readonly Row[] = [...rows,
    { id: 'io-read-iops', label: msgctxt('resources-board', 'Read IOPS'), limit: limit(plan?.ioReadIops, 'IOPS'), used: notRead, state: 'unread' },
    { id: 'io-write-iops', label: msgctxt('resources-board', 'Write IOPS'), limit: limit(plan?.ioWriteIops, 'IOPS'), used: notRead, state: 'unread' },
  ]
  const comparison = card('limits', msgctxt('resources-board', 'Plan, applied limit and usage'), `<p>${text(msgctxt('resources-board', 'Applied values need host readback. A saved plan does not establish active host limits.'))}</p>`
    + table('limits', msgctxt('resources-board', 'Plan, applied limit and usage'), [msgid('Resource'), msgid('Stored plan limit'), msgctxt('resources-board', 'Applied limit'), msgid('State'), msgid('Current reading')], comparedRows.map(item => `<tr><th scope="row">${text(item.label)}</th><td>${valueHtml(item.limit)}</td><td>${valueHtml(notRead)}</td><td>${text(item.state === 'measured' ? msgid('Measured') : item.state === 'unread' ? unread : item.state === 'unmeasured' ? unmeasured : unavailable)}</td><td>${valueHtml(item.used)}</td></tr>`).join('')))
  const io = card('io-history', msgctxt('resources-board', 'Disk IO history'), `<div class="xp-resource-board__ranges" role="group" aria-label="${text(msgctxt('resources-board', 'IO direction'))}"><button type="button" aria-pressed="false" disabled>${text(msgid('Read'))}</button><button type="button" aria-pressed="true" disabled>${text(msgid('Write'))}</button></div><div class="xp-resource-board__plot" data-resource-observation="unread"><p role="status">${text(msgctxt('resources-board', 'History has not been read.'))}</p></div>`
    + facts([[msgctxt('resources-board', 'Average'), notRead], [msgctxt('resources-board', 'Peak'), notRead], [msgctxt('resources-board', 'Configured read cap'), rows[5]!.limit], [msgctxt('resources-board', 'Configured write cap'), rows[6]!.limit]]))
  const events = card('events', msgctxt('resources-board', 'Limit events'), `<p>${text(msgctxt('resources-board', 'Event counters and their observation times have not been read.'))}</p><ol class="xp-resource-board__list" data-resource-observation="unread">${[msgctxt('resources-board', 'Memory events'), msgctxt('resources-board', 'Process limit events'), msgctxt('resources-board', 'IO throttling'), msgctxt('resources-board', 'Bandwidth limit events')].map(label => `<li><strong>${text(label)}</strong>${facts([[msgid('State'), notRead], [msgctxt('resources-board', 'Last observed'), notRead]])}</li>`).join('')}</ol>`)
  const services = card('services', msgctxt('resources-board', 'Site service configuration'), `<p>${text(msgctxt('resources-board', 'Live service units and the request path have not been read.'))}</p>`
    + facts([[msgid('Primary domain'), numeric(context.account!.primaryDomain)], [msgid('Default PHP'), sample?.phpVersion ? numeric(sample.phpVersion) : notRead]])
    + `<ol class="xp-resource-board__list" aria-label="${text(msgctxt('resources-board', 'Request path'))}" data-resource-observation="unread">${[msgctxt('resources-board', 'Web proxy'), msgctxt('resources-board', 'Account web worker'), msgctxt('resources-board', 'PHP worker')].map(label => `<li><strong>${text(label)}</strong><span>${valueHtml(notRead)}</span></li>`).join('')}</ol><h3>${text(msgctxt('resources-board', 'Virtual host'))}</h3><pre class="xp-resource-board__code">${text(msgctxt('resources-board', 'Virtual-host configuration has not been read.'))}</pre>`
    + facts([[msgctxt('resources-board', 'Runtime identity'), notRead], [msgctxt('resources-board', 'Home permissions'), notRead], [msgctxt('resources-board', 'Private temporary directory'), notRead], [msgctxt('resources-board', 'Database access'), notRead]]))
  const processes = card('process-list', msgctxt('resources-board', 'Processes in your slice'), emptyTable('process-list', msgctxt('resources-board', 'Processes in your slice'), [msgctxt('resources-board', 'Command and unit'), 'PID', msgid('User'), msgid('CPU'), msgid('Memory'), msgid('Started (UTC)')], msgctxt('resources-board', 'A process count is not a process list. No process rows have been read.')))
  const folders = card('folders', msgctxt('resources-board', 'Disk usage by folder'), `<a class="xp-btn" href="/files/manager">${text(msgid('File manager'))}</a><p id="resource-folder-navigation-note">${text(msgctxt('resources-board', 'Use the authorized workspace navigation to open the file manager.'))}</p>` + emptyTable('folders', msgctxt('resources-board', 'Disk usage by folder'), [msgid('Path'), msgid('Size'), msgid('Share')], msgctxt('resources-board', 'Folder sizes have not been read. A file listing is not a recursive quota measurement.')))
  return `<section class="xp-resource-board" lang="${context.locale}" dir="${localeDirection(context.locale)}" data-resource-reading="${state}">${css}
<section class="xp-resource-board__card" aria-labelledby="resource-reading-title"><h2 id="resource-reading-title">${escapeHtml(copy(context, msgid('Resource readings')))}</h2><p>${escapeHtml(copy(context, msgid('Stored plan limits are desired configuration. Readings and IO verification are separate observations; no process or service readings are invented.')))}</p><dl class="xp-resource-board__facts">${fact(context, msgid('Reading state'), status)}${fact(context, msgid('Observed at'), observedAt)}${fact(context, msgid('IO cap verification'), human(copy(context, verification)))}</dl></section>
<div class="xp-resource-board__groups">${rows.map(item => `<section class="xp-resource-board__card" data-resource-metric="${item.id}" data-resource-state="${item.state}" aria-labelledby="resource-${item.id}-title"><h2 id="resource-${item.id}-title">${escapeHtml(copy(context, item.label))}</h2><dl class="xp-resource-board__facts">${fact(context, msgid('Stored plan limit'), item.limit)}${fact(context, msgid('Current reading'), item.used, ' data-resource-value')}</dl></section>`).join('')}</div>
${unit}<div class="xp-resource-board__workspace"><div class="xp-resource-board__main"><div class="xp-resource-board__charts">${chart('cpu-history', msgctxt('resources-board', 'CPU usage'), rows[3]!.used, rows[3]!.limit)}${chart('memory-history', msgctxt('resources-board', 'Memory usage'), rows[1]!.used, rows[1]!.limit)}</div>${comparison}<div class="xp-resource-board__charts">${io}${events}</div></div>${services}</div>${processes}${folders}</section>`
}
