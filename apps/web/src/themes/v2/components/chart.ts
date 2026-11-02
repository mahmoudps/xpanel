import { escapeHtml } from '../html.ts'

// Small inline SVG charts. Paths are computed here deterministically; axis labels are HTML outside the SVG and the
// time axis keeps data order (dir="ltr") in every locale, like other technical values. The
// legend never relies on color alone (solid vs dashed line plus text).

const round = (value: number): number => Math.round(value * 100) / 100
const ratio = (value: number, max: number): number => (max > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0)

/** Line and area paths of a series scaled into a width x height box (0 at the bottom). */
export function seriesPaths(values: readonly number[], width: number, height: number, max = Math.max(...values, 0)): { line: string; area: string } {
  const step = values.length > 1 ? width / (values.length - 1) : 0
  const points = values.map((value, index) => `${round(index * step)} ${round(height - ratio(value, max) * height)}`)
  const line = `M${points.join('L')}`
  return { line, area: `${line}L${round((values.length - 1) * step)} ${height}L0 ${height}Z` }
}

export const sparklinePaths = (values: readonly number[], width: number, height: number): { line: string; area: string } =>
  seriesPaths(values, width, height - 2)

export interface LineSeries {
  label: string
  values: readonly number[]
  /** The second series is dashed so it reads without color. */
  dashed?: boolean
}

export interface LineChartProps {
  /** Text summary of what the chart shows (role="img"). */
  label: string
  series: readonly LineSeries[]
  max: number
  /** Y axis labels from top to bottom, such as 100% .. 0%. */
  yTicks?: readonly string[]
  xTicks?: readonly string[]
  height?: number
}

export function lineChart(props: LineChartProps): string {
  const W = 288, H = 100
  const grid = (props.yTicks ?? []).length > 1
    ? `<path d="${props.yTicks!.map((_, i, all) => `M0 ${round((i / (all.length - 1)) * H)}H${W}`).join('')}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" fill="none"/>` : ''
  // Later series are drawn first so the primary series stays on top.
  const layers = [...props.series].reverse().filter(series => series.values.length > 1).map(series => {
    const { line, area } = seriesPaths(series.values, W, H, props.max)
    const color = series.dashed ? 'var(--chart-2)' : 'var(--accent)'
    return `<path d="${area}" fill="${color}" opacity="${series.dashed ? '0.10' : '0.14'}"/><path d="${line}" fill="none" stroke="${color}" stroke-width="2"${series.dashed ? ' stroke-dasharray="5 4"' : ''} vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`
  }).join('')
  const height = props.height ?? 240
  const legend = props.series.map(series => `<li><svg aria-hidden="true" width="20" height="8" viewBox="0 0 20 8"><path d="M0 4h20" stroke="${series.dashed ? 'var(--chart-2)' : 'var(--accent)'}" stroke-width="2.5"${series.dashed ? ' stroke-dasharray="5 3"' : ''}/></svg>${escapeHtml(series.label)}</li>`).join('')
  return `<figure class="v2-chart">
<div class="v2-chart__plot" dir="ltr">${props.yTicks?.length ? `<div class="v2-chart__y v2-num" aria-hidden="true" style="block-size:${height}px">${props.yTicks.map(tick => `<span>${escapeHtml(tick)}</span>`).join('')}</div>` : ''}
<div class="v2-chart__area"><svg role="img" aria-label="${escapeHtml(props.label)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="block-size:${height}px">${grid}${layers}</svg>${props.xTicks?.length ? `<div class="v2-chart__x v2-num" aria-hidden="true">${props.xTicks.map(tick => `<span>${escapeHtml(tick)}</span>`).join('')}</div>` : ''}</div></div>
<ul class="v2-chart__legend">${legend}</ul>
</figure>`
}

export interface BarChartProps {
  label: string
  bars: readonly { label: string; value: number }[]
  max: number
  height?: number
}

export function barChart(props: BarChartProps): string {
  const n = Math.max(props.bars.length, 1), H = 100, slot = 10
  const rects = props.bars.map((bar, i) => {
    const h = round(ratio(bar.value, props.max) * H)
    return `<rect x="${i * slot + 2}" y="${round(H - h)}" width="${slot - 4}" height="${h}" rx="1.5" fill="var(--accent-fill)"/>`
  }).join('')
  return `<figure class="v2-chart v2-chart--bars" dir="ltr"><svg role="img" aria-label="${escapeHtml(props.label)}" viewBox="0 0 ${n * slot} ${H}" preserveAspectRatio="none" style="block-size:${props.height ?? 120}px"><path d="M0 ${H}H${n * slot}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>${rects}</svg><div class="v2-chart__x v2-num" aria-hidden="true">${props.bars.map(bar => `<span>${escapeHtml(bar.label)}</span>`).join('')}</div></figure>`
}

export const CHART_CSS = `.v2-chart{display:flex;flex-direction:column;gap:var(--space-2);margin:0;min-width:0}
.v2-chart__plot{display:flex;gap:var(--space-1)}
.v2-chart__y{display:flex;flex-direction:column;justify-content:space-between;font-size:11px;color:var(--muted);text-align:end}
.v2-chart__area{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:var(--space-1)}
.v2-chart svg[role=img]{display:block;inline-size:100%}
.v2-chart__x{display:flex;justify-content:space-between;gap:4px;font-size:11px;color:var(--muted)}
.v2-chart--bars .v2-chart__x>span{flex:1 1 0;text-align:center}
.v2-chart__legend{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-3);font-size:13px;color:var(--text-2)}
.v2-chart__legend li{display:inline-flex;align-items:center;gap:var(--space-1)}
`
