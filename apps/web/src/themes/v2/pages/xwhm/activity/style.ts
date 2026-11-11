import { phoneRows, type PhoneRow } from '../lifecycle/shared.ts'

const page = '.v2-observation'
/** Each table with its row name and opposite value on a phone; the column headers arrive as --v2-col-N on the table. */
const JOBS = `${page} table:has(>[data-whm-jobs-rows])`, JOB = `${JOBS}>tbody>tr:nth-child(n)`
const TABLES: readonly (readonly [table: string, phone: PhoneRow])[] = [
  ['table:has(>[data-whm-jobs-steps])', { name: 2, value: 3 }],
  ['table.v2-audit__entries', { name: 3, value: 5 }],
  ['table:has(>[data-v2-audit-safe-changes])', {}],
  ['table.v2-audit__generations', { value: 8 }],
  ['table:has(>[data-whm-support-services])', { value: 3 }],
  ['table:has(>[data-whm-support-jobs])', { value: 3 }],
]

/** Page rules of the activity pages (jobs, audit log, support), loaded beside the observation stylesheet on those routes. */
export const WHM_ACTIVITY_CSS = `${page} :is(th,td){overflow-wrap:break-word}
${page} thead th{white-space:nowrap;overflow-wrap:normal}
${page} td bdi{overflow-wrap:anywhere}
${page} .v2-observation__log:empty{display:none}
${page} .v2-observation__job-progress>bdi{flex:none;min-inline-size:4ch;text-align:end}
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
