import { phoneRows, type PhoneRow } from '../lifecycle/shared.ts'

const page = '.v2-observation'
/** Each table with its row name and opposite value on a phone; the column headers arrive as --v2-col-N on the table. */
const JOBS = `${page} table:has(>[data-whm-jobs-rows])`, JOB = `${JOBS}>tbody>tr:nth-child(n)`
const TABLES: readonly (readonly [table: string, phone: PhoneRow])[] = [
  ['table:has(>[data-whm-jobs-steps])', { name: 2, value: 3 }],
  ['table:has(>[data-whm-generation-timeline])', { name: 1, value: 6 }],
  ['table.v2-audit__entries', { name: 5, value: 7 }],
  ['table:has(>[data-v2-audit-safe-changes])', {}],
  ['table.v2-audit__generations', { value: 8 }],
  ['table:has(>[data-whm-support-services])', { value: 3 }],
  ['table:has(>[data-whm-support-jobs])', { value: 3 }],
]

/** Page rules of the activity pages (jobs, audit log, support), loaded beside the observation stylesheet on those routes. */
export const WHM_ACTIVITY_CSS = `${page} :is(th,td){overflow-wrap:break-word}
${page} thead th{white-space:nowrap;overflow-wrap:normal}
${page} td,${page} .v2-observation__facts dd,${page} [data-audit-count],${page} .v2-observation__job-progress>bdi{font-variant-numeric:tabular-nums}
${page} td bdi{overflow-wrap:anywhere}
${page} .v2-observation__log{border-radius:var(--radius-notice)}
${page} .v2-observation__log:empty{display:none}
${page} .v2-observation__job-progress>bdi{flex:none;min-inline-size:4ch;text-align:end}
${page} [data-audit-chain]{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle);font-variant-numeric:tabular-nums}
${page} [data-audit-chain][data-chain-status=verified]{border-color:color-mix(in srgb,var(--ok) 28%,var(--line));background:var(--ok-soft)}
${page} [data-audit-chain][data-chain-status=broken]{border-color:color-mix(in srgb,var(--bad) 28%,var(--line));background:var(--bad-soft)}
${page} [data-audit-chain][data-chain-status=partial]{border-color:color-mix(in srgb,var(--warn) 28%,var(--line));background:var(--warn-soft)}
${page} details[data-audit-entry-detail]{padding-inline:16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
${page} details[data-audit-entry-detail]+details[data-audit-entry-detail]{margin-block-start:8px}
${page} details[data-audit-entry-detail][open]{padding-block-end:16px}
${page} details[data-audit-entry-detail]>summary{min-block-size:var(--target);padding-block:10px;align-content:center;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer}
${page} details[data-audit-entry-detail][open]>summary{margin-block-end:12px;border-block-end:1px solid var(--line)}
${page} [data-generation-step]{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
${page} [data-generation-step]::before{content:"";inline-size:8px;block-size:8px;flex:none;border-radius:50%;background:var(--muted)}
${page} [data-generation-step][data-step-status=done]::before{background:var(--ok)}
${page} [data-generation-step][data-step-status=failed]::before{background:var(--bad)}
${page} .v2-observation__charts{align-items:stretch}
${page} .v2-observation__charts>.v2-observation__groups{padding:16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
${page} .v2-audit__generations td>span[title]::after{content:"…"}
${page} [data-whm-jobs-rows]>tr>:is(:first-child,:nth-child(n+6):nth-child(-n+8)){white-space:nowrap}
${page} [data-whm-jobs-rows]>tr>:nth-child(3){min-inline-size:176px}
${page} [data-whm-jobs-rows] .v2-btn{justify-content:flex-start;padding-inline:0;text-align:start;white-space:nowrap;min-block-size:var(--target)}
@media(min-width:601px){${page} .v2-audit__generations td:not(:nth-child(3)){white-space:nowrap}${page} .v2-audit__generations :is(th,td){padding-inline:8px}}
${page} table{${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `--c${n}:var(--v2-col-${n})`).join(';')}}
@media(max-width:640px){${page} .v2-observation__facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:1599px){${phoneRows(JOBS, { name: 2, value: 4 })}
${JOB}{grid-template-columns:repeat(4,minmax(0,1fr))}
${JOB}>:nth-child(2){grid-area:1/1/auto/4}
${JOB}>:nth-child(4){grid-area:1/4}
${page} [data-whm-jobs-rows]>tr>*{min-inline-size:0;white-space:normal}
${page} [data-whm-jobs-rows] .v2-btn{min-block-size:var(--target);white-space:normal;overflow-wrap:anywhere}}
@media(max-width:600px){${JOB}{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
${JOB}>:nth-child(2){grid-area:1/1}
${JOB}>:nth-child(4){grid-area:1/2}
${TABLES.map(([table, phone]) => phoneRows(`${page} ${table}`, phone)).join('\n')}
${page} .v2-audit__generations>tbody>tr>*{min-inline-size:0;white-space:normal}
${page} [data-whm-jobs-rows] .v2-btn{min-block-size:44px}}`
