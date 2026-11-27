import { escapeAttr } from '../html.ts'

export interface SparklineProps {
  readonly values: readonly number[]
  readonly label: string
}

export function renderSparkline(props: SparklineProps): string {
  const values = props.values.filter(v => Number.isFinite(v))
  const width = 160
  const height = 40
  if (values.length < 2) {
    return `<svg class="ds-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(props.label)}"><line class="ds-sparkline__line" x1="0" y1="20" x2="${width}" y2="20"></line></svg>`
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const coords = values.map((val, idx) => {
    const x = Math.round((idx / (values.length - 1)) * width * 10) / 10
    const y = Math.round((height - 4 - ((val - min) / span) * (height - 8)) * 10) / 10
    return [x, y] as const
  })
  const linePoints = coords.map(([x, y]) => `${x},${y}`).join(' ')
  const areaPoints = `0,${height} ${linePoints} ${width},${height}`
  return `<svg class="ds-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(props.label)}">` +
    `<polygon class="ds-sparkline__area" points="${areaPoints}"></polygon>` +
    `<polyline class="ds-sparkline__line" points="${linePoints}"></polyline>` +
  `</svg>`
}
