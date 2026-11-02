import { escapeHtml, hookAttrs, type HookAttributes, type Tone } from '../html.ts'

export interface MeterScale {
  /** The measured value and its scale, in the unit of the check (load, percent, days). */
  value: number
  min?: number
  max: number
  /** Where the check turns into a warning and a problem, on the same scale. */
  warn?: number
  bad?: number
  /** The scale ends under the track, such as "0%" and "100%". */
  minText: string
  maxText: string
}

export interface MeterProps {
  label: string
  /** Visible value, such as "3.2 / 10 GB" or "412 MB / unlimited". */
  valueText: string
  /** Secondary text after the value, such as "of 4 processors". */
  unit?: string
  /** 0-100; omit for an unlimited or unread quantity (empty track). */
  percent?: number
  /** Threshold meter: the value on its own scale with warning and problem ticks (TplDashboard). */
  scale?: MeterScale
  /** The quantity is not graded, such as "No swap is configured, so swap is not graded"; shown instead of the track. */
  untracked?: string
  /** The caller applies the product thresholds (80% and 95%, or the check's own); the note says the state in words. */
  tone?: Tone
  /** The value and its thresholds in words, read as the meter's aria-valuetext, such as "Load 0.26; warning at 1,
   *  problem at 2". Defaults to the label, value and unit. */
  valueLabel?: string
  note?: string
  hooks?: HookAttributes
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
const at = (value: number, min: number, max: number): string => `${Math.round((clamp(value, min, max) - min) / (max - min || 1) * 1000) / 10}%`

/** Quota or threshold meter. A measured track is a role="meter" with its range and a text equivalent; the label,
 *  value and note carry the same meaning visibly. */
export function meter(props: MeterProps): string {
  const tone = props.tone ?? 'info'
  const scale = props.scale
  const min = scale?.min ?? 0
  const max = scale?.max ?? 100
  const value = scale ? scale.value : props.percent
  const toneClass = tone === 'warn' || tone === 'bad' ? `v2-text--${tone}` : ''
  const valueText = props.valueLabel ?? [props.label, props.valueText, props.unit].filter(Boolean).join(' ')
  // An unlimited or unread quantity has no value to report: its empty track stays decorative.
  const aria = value === undefined ? 'aria-hidden="true"'
    : `role="meter" aria-label="${escapeHtml(props.label)}" aria-valuenow="${clamp(value, min, max)}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuetext="${escapeHtml(valueText)}"`
  const fill = `<span class="v2-bar__fill v2-bar--${tone}" style="inline-size:${value === undefined ? '0%' : at(value, min, max)}"></span>`
  const tick = (kind: 'warn' | 'bad', mark: number | undefined): string => mark === undefined ? '' : `<span class="v2-meter__tick v2-meter__tick--${kind}" style="inset-inline-start:${at(mark, min, max)}"></span>`
  const track = props.untracked ? `<div class="v2-meter__untracked">${escapeHtml(props.untracked)}</div>`
    : scale ? `<div class="v2-meter__track" ${aria}><div class="v2-bar">${fill}</div>${tick('warn', scale.warn)}${tick('bad', scale.bad)}</div><div class="v2-meter__scale v2-num" aria-hidden="true"><span>${escapeHtml(scale.minText)}</span><span>${escapeHtml(scale.maxText)}</span></div>`
    : `<div class="v2-bar" ${aria}>${fill}</div>`
  const unit = props.unit ? `<span class="v2-meter__unit">${escapeHtml(props.unit)}</span>` : ''
  return `<div class="v2-meter${scale || props.untracked ? ' v2-meter--scale' : ''}"${hookAttrs(props.hooks)}><div class="v2-meter__row"><span class="v2-meter__label">${escapeHtml(props.label)}</span><span class="v2-meter__value v2-num"><span${scale && toneClass ? ` class="${toneClass}"` : ''}>${escapeHtml(props.valueText)}</span>${unit}</span></div>${track}${props.note ? `<span class="v2-meter__note v2-num${toneClass ? ` ${toneClass}` : ''}">${escapeHtml(props.note)}</span>` : ''}</div>`
}

export const METER_CSS = `.v2-meter{display:flex;flex-direction:column;gap:var(--space-1);min-width:0}
.v2-meter__row{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-1);font-size:13px}
.v2-meter__value{display:inline-flex;align-items:baseline;gap:6px;white-space:nowrap;color:var(--text-2)}
.v2-meter__value>span,.v2-meter__scale>span{unicode-bidi:plaintext}
.v2-meter__unit{font-size:12px;color:var(--muted)}
.v2-meter__label{font-weight:600}
.v2-meter__note{font-size:12px;color:var(--muted)}
.v2-meter--scale{gap:10px}
.v2-meter--scale .v2-meter__row{gap:12px}
.v2-meter--scale .v2-meter__value>:first-child{font-size:16px;font-weight:600;color:var(--text)}
.v2-meter--scale .v2-meter__value>.v2-text--warn{color:var(--warn)}
.v2-meter--scale .v2-meter__value>.v2-text--bad{color:var(--bad)}
.v2-meter__track{position:relative;height:18px}
.v2-meter__track>.v2-bar{position:absolute;inset-inline:0;top:6px}
.v2-meter__tick{position:absolute;top:0;width:2px;height:18px;margin-inline-start:-1px;border-radius:1px}
.v2-meter__tick--warn{background:var(--warn)}
.v2-meter__tick--bad{background:var(--bad)}
.v2-meter__scale{display:flex;justify-content:space-between;gap:var(--space-1);font-size:11px;color:var(--muted)}
.v2-meter__untracked{display:flex;align-items:center;min-height:36px;padding:0 12px;border-radius:var(--radius-chip);border:1px dashed var(--line-strong);font-size:12px;color:var(--muted)}
`
