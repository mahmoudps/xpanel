import { formatNumber, isolateTechnical } from '../formatters.ts'
import { createDesignTranslator, escapeAttr, escapeHtml, normalizeAsciiDigits, type TextTranslator } from '../html.ts'
import { renderField } from './field.ts'
import { renderInput } from './input.ts'
import { renderSelect } from './select.ts'

export type CronFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

export interface CronScheduleState {
  readonly frequency: CronFrequency
  readonly minute: number
  readonly hour: number
  readonly dayOfWeek?: number
  readonly dayOfMonth?: number
  readonly customExpression?: string
}

export interface CronBuilderProps {
  readonly id: string
  readonly namePrefix: string
  readonly state: CronScheduleState
  readonly locale?: string
  readonly copy?: TextTranslator
}

const pad2 = (n: number): string => normalizeAsciiDigits(String(Math.max(0, Math.floor(n))).padStart(2, '0'))

function weekdayNames(t: TextTranslator): readonly string[] {
  return [
    t('Sunday'),
    t('Monday'),
    t('Tuesday'),
    t('Wednesday'),
    t('Thursday'),
    t('Friday'),
    t('Saturday'),
  ]
}

export function buildCronExpression(state: CronScheduleState): string {
  const m = Math.min(59, Math.max(0, Math.floor(state.minute)))
  const h = Math.min(23, Math.max(0, Math.floor(state.hour)))
  const dow = Math.min(6, Math.max(0, Math.floor(state.dayOfWeek ?? 0)))
  const dom = Math.min(28, Math.max(1, Math.floor(state.dayOfMonth ?? 1)))

  switch (state.frequency) {
    case 'hourly':
      return `${m} * * * *`
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      return `${m} ${h} * * ${dow}`
    case 'monthly':
      return `${m} ${h} ${dom} * *`
    case 'custom':
      return normalizeAsciiDigits((state.customExpression ?? `${m} ${h} * * *`).trim())
  }
}

export function describeCronSchedule(state: CronScheduleState, locale: string = 'en', copy?: TextTranslator): string {
  const t = createDesignTranslator(copy)
  const m = pad2(Math.min(59, Math.max(0, state.minute)))
  const h = pad2(Math.min(23, Math.max(0, state.hour)))
  const timeText = `${h}:${m}`

  if (state.frequency === 'hourly') {
    return t('Every hour at minute {m}', { m })
  }
  if (state.frequency === 'daily') {
    return t('Every day at {time}', { time: timeText })
  }
  if (state.frequency === 'weekly') {
    const names = weekdayNames(t)
    const dayName = names[Math.min(6, Math.max(0, state.dayOfWeek ?? 0))]!
    return t('Every {day} at {time}', { day: dayName, time: timeText })
  }
  if (state.frequency === 'monthly') {
    const dom = formatNumber(Math.min(28, Math.max(1, state.dayOfMonth ?? 1)), locale)
    return t('Monthly on day {dom} at {time}', { dom, time: timeText })
  }
  return t('Custom schedule ({expr})', { expr: buildCronExpression(state) })
}

export function renderCronBuilder(props: CronBuilderProps): string {
  const t = createDesignTranslator(props.copy)
  const expr = buildCronExpression(props.state)
  const summary = describeCronSchedule(props.state, props.locale, props.copy)
  const days = weekdayNames(t)
  const freq = props.state.frequency
  const showHour = freq !== 'hourly' && freq !== 'custom'
  const showMinute = freq !== 'custom'
  const showDow = freq === 'weekly'
  const showDom = freq === 'monthly'
  const showCustom = freq === 'custom'

  const freqSelect = renderField({
    id: `${props.id}-freq`,
    label: t('Schedule frequency'),
    controlHtml: renderSelect({
      id: `${props.id}-freq`,
      name: `${props.namePrefix}[frequency]`,
      value: freq,
      options: [
        { value: 'hourly', label: t('Hourly') },
        { value: 'daily', label: t('Daily') },
        { value: 'weekly', label: t('Weekly') },
        { value: 'monthly', label: t('Monthly') },
        { value: 'custom', label: t('Custom schedule') },
      ],
    }),
  })

  const hourSelect = `<div data-cron-field="hour"${showHour ? '' : ' hidden'}>${renderField({
    id: `${props.id}-hour`,
    label: t('Hour'),
    controlHtml: renderInput({
      id: `${props.id}-hour`,
      name: `${props.namePrefix}[hour]`,
      type: 'number',
      min: 0,
      max: 23,
      step: 1,
      value: String(props.state.hour),
      dir: 'ltr',
      disabled: !showHour,
    }),
  })}</div>`

  const minuteSelect = `<div data-cron-field="minute"${showMinute ? '' : ' hidden'}>${renderField({
    id: `${props.id}-minute`,
    label: t('Minute'),
    controlHtml: renderInput({
      id: `${props.id}-minute`,
      name: `${props.namePrefix}[minute]`,
      type: 'number',
      min: 0,
      max: 59,
      step: 1,
      value: String(props.state.minute),
      dir: 'ltr',
      disabled: !showMinute,
    }),
  })}</div>`

  const dowSelect = `<div data-cron-field="dow"${showDow ? '' : ' hidden'}>${renderField({
    id: `${props.id}-dow`,
    label: t('Day of week'),
    controlHtml: renderSelect({
      id: `${props.id}-dow`,
      name: `${props.namePrefix}[dayOfWeek]`,
      value: String(props.state.dayOfWeek ?? 0),
      options: days.map((day, idx) => ({ value: String(idx), label: day })),
      disabled: !showDow,
    }),
  })}</div>`

  const domSelect = `<div data-cron-field="dom"${showDom ? '' : ' hidden'}>${renderField({
    id: `${props.id}-dom`,
    label: t('Day of month'),
    controlHtml: renderInput({
      id: `${props.id}-dom`,
      name: `${props.namePrefix}[dayOfMonth]`,
      type: 'number',
      min: 1,
      max: 28,
      step: 1,
      value: String(props.state.dayOfMonth ?? 1),
      dir: 'ltr',
      disabled: !showDom,
    }),
  })}</div>`

  const customField = `<div data-cron-field="custom"${showCustom ? '' : ' hidden'}>${renderField({
    id: `${props.id}-custom`,
    label: t('Technical cron expression'),
    controlHtml: renderInput({
      id: `${props.id}-custom`,
      name: `${props.namePrefix}[customExpression]`,
      type: 'text',
      value: props.state.customExpression ?? expr,
      dir: 'ltr',
      disabled: !showCustom,
    }),
  })}</div>`

  const templates = JSON.stringify({
    hourly: t('Every hour at minute {m}'),
    daily: t('Every day at {time}'),
    weekly: t('Every {day} at {time}'),
    monthly: t('Monthly on day {dom} at {time}'),
    custom: t('Custom schedule ({expr})'),
    days,
  })

  return `<div class="ds-card ds-card--compact" id="${escapeAttr(props.id)}" data-ds-cron-builder data-ds-cron-templates="${escapeAttr(templates)}">` +
    `<div class="ds-cron">${freqSelect}${hourSelect}${minuteSelect}${dowSelect}${domSelect}${customField}</div>` +
    `<p class="ds-prose" data-ds-cron-summary><strong>${escapeHtml(t('Schedule summary'))}:</strong> <span data-ds-cron-summary-text>${escapeHtml(summary)}</span></p>` +
    `<details class="ds-caption"><summary>${escapeHtml(t('Technical cron expression'))}</summary><div class="ds-mono" data-ds-cron-code>${isolateTechnical(expr)}</div></details>` +
    `<input type="hidden" name="${escapeAttr(props.namePrefix)}[expression]" value="${escapeAttr(expr)}" data-ds-cron-expression>` +
  `</div>`
}
