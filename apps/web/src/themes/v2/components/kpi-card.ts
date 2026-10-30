import { escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'
import { icon, type IconName } from '../icons.ts'
import { sparklinePaths } from './chart.ts'

export interface KpiCardProps {
  label: string
  headingLevel?: 2 | 3
  value: string
  /** Unit or capacity after the value, such as "%" or "/ 10 GB". */
  unit?: string
  icon?: IconName
  /** Icon tile tone; status tones also color the meter bar. */
  tone?: Tone
  /** Quota bar, 0-100. The caller picks the tone from the product thresholds; the note says the state in words. */
  meter?: { percent: number; tone?: Tone }
  /** Trend sparkline; `label` is its text summary for assistive technology. */
  spark?: { values: readonly number[]; label: string }
  note?: string
  noteTone?: Tone
  /** Hooks on the value, such as `data-live-kpi` for live updates. */
  valueHooks?: HookAttributes
  hooks?: HookAttributes
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0))

export function kpiCard(props: KpiCardProps): string {
  const h = `h${props.headingLevel ?? 3}`
  const tone = props.tone ?? 'info'
  const meter = props.meter
    ? `<div class="v2-bar" aria-hidden="true"><span class="v2-bar__fill v2-bar--${props.meter.tone ?? 'info'}" style="inline-size:${clampPercent(props.meter.percent)}%"></span></div>` : ''
  const spark = props.spark && props.spark.values.length > 1 ? (() => {
    const { area, line } = sparklinePaths(props.spark.values, 120, 28)
    return `<svg class="v2-kpi__spark" role="img" aria-label="${escapeHtml(props.spark.label)}" viewBox="0 0 120 28" preserveAspectRatio="none"><path d="${area}" fill="currentColor" opacity="0.12"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.75" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`
  })() : ''
  return `<article class="v2-kpi"${hookAttrs(props.hooks)}>
<div class="v2-kpi__head"><${h}>${escapeHtml(props.label)}</${h}>${props.icon ? `<span class="v2-tile v2-tile--${tone}" aria-hidden="true">${icon(props.icon)}</span>` : ''}</div>
<p class="v2-kpi__value v2-num"><span${hookAttrs(props.valueHooks)}>${escapeHtml(props.value)}</span>${props.unit ? `<span class="v2-kpi__unit">${escapeHtml(props.unit)}</span>` : ''}</p>
${meter}${spark}${props.note ? `<p class="v2-kpi__note v2-num${props.noteTone ? ` v2-text--${props.noteTone}` : ''}">${escapeHtml(props.note)}</p>` : ''}
</article>`
}

export const KPI_CARD_CSS = `.v2-kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:var(--space-2)}
.v2-kpi{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--v2-panel-padding);border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);min-width:0}
.v2-kpi__head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1)}
.v2-kpi__head>:is(h2,h3){font-size:13px;font-weight:600;color:var(--muted)}
.v2-kpi__value{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.v2-kpi__value>span{unicode-bidi:plaintext}
.v2-kpi__value>:first-child{font-size:30px;line-height:1;font-weight:600;letter-spacing:-.02em}
.v2-kpi__unit{font-size:14px;color:var(--muted)}
.v2-kpi__spark{display:block;width:100%;height:28px;color:var(--accent)}
.v2-kpi__note{font-size:12px;color:var(--muted)}
.v2-tile{flex:none;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--radius-control)}
.v2-tile--info{background:var(--accent-soft);color:var(--accent)}
.v2-tile--ok{background:var(--ok-soft);color:var(--ok)}
.v2-tile--warn{background:var(--warn-soft);color:var(--warn)}
.v2-tile--bad{background:var(--bad-soft);color:var(--bad)}
.v2-tile--neutral{background:var(--sunken);color:var(--muted)}
.v2-text--ok{color:var(--ok)}.v2-text--warn{color:var(--warn)}.v2-text--bad{color:var(--bad)}.v2-text--info{color:var(--accent)}.v2-text--neutral{color:var(--muted)}
.v2-bar{height:6px;border-radius:3px;background:var(--sunken);overflow:hidden}
.v2-bar__fill{display:block;height:100%;border-radius:3px}
.v2-bar--info{background:var(--accent-fill)}.v2-bar--ok{background:var(--ok)}.v2-bar--warn{background:var(--warn)}.v2-bar--bad{background:var(--bad)}.v2-bar--neutral{background:var(--line-strong)}
`
