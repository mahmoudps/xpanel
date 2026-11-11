// v2 base element styles, scoped to the v2 root through :where() so they add no specificity: semantic elements
// inserted by core controllers get these defaults, and component classes override them by source order.
// Technical values (.v2-num, .v2-mono, code) use unicode-bidi:plaintext so numbers with units, dates, domains and
// commands keep their own reading order inside right-to-left pages.

const R = '[data-ui-theme="v2"]'
const W = `:where(${R})`
const CONTROL = 'input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=hidden],[type=color])'

// A matrix, or a table whose later columns hold checkboxes, only makes sense under its headers.
// A table keeps its columns when a later cell holds a checkbox (a matrix) or when it lays out its own phone rows.
const PT = `${W} :where(table:not(.v2-matrix,.v2-whm-quotas__table,:has(*+td [type=checkbox]),:is(.v2-identity-rows,.v2-boxtrapper,[data-leech-protection]) *))`
const CB = 'tr:has(>:first-child [type=checkbox])'
/**
 * Phone rows keep two columns: the item name with its other facts under it, opposite the second cell (value or status).
 * A leading checkbox sits beside the name. The headers show only while the table has no cells. Zero specificity lets
 * page rules shape their own rows; only the desktop widths and cell spacing are forced.
 */
export const V2_PHONE_TABLE_ROWS_CSS = `@media(max-width:600px){${PT}{position:relative;min-width:0!important}
${PT}:not(:has(td)) tr{display:table-row}
${PT}:has(td)>thead{position:absolute;top:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
${PT} tr{display:grid;grid-template-columns:minmax(0,1fr) fit-content(50%);gap:8px 16px;padding:10px 16px}
${PT} tr>*{grid-column:1;padding:0!important;border:0;min-width:0!important;white-space:normal;overflow-wrap:anywhere}
${PT} tbody tr:not(:last-child){border-block-end:1px solid var(--line)}
${PT} tr>:nth-child(2):not([colspan]),${PT} ${CB}>:nth-child(3){grid-column:2;grid-row:1;justify-self:end;text-align:end}
${PT} tr>:is([colspan],:nth-child(n+3):has(button,input,select)){grid-column:1/-1}
${PT} ${CB}{position:relative;padding-inline-start:48px}
${PT} ${CB}>:first-child{grid-column:auto;position:absolute;top:10px;inset-inline-start:16px}
${PT} ${CB}>:nth-child(2){grid-column:1;grid-row:1;justify-self:start;text-align:start}}`

export const V2_BASE_CSS = `${R}{--v2-panel-padding:var(--space-3);--v2-control-align:-webkit-match-parent;--v2-elev:0 20px 44px rgba(7,14,26,.22),0 2px 6px rgba(7,14,26,.08)}
${R} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased;text-size-adjust:100%}
${R} *,${R} *::before,${R} *::after{box-sizing:border-box}
${R} [hidden]{display:none!important}
${W} :is(h1,h2,h3,h4,p,figure,dl,dd,pre){margin:0}
${W} h1{font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
${W} h2{font-size:16px;line-height:1.4;font-weight:600}
${W} h3{font-size:14px;line-height:1.4;font-weight:600}
${W} a{color:var(--accent);text-underline-offset:2px}
${W} a:hover{color:var(--text)}
${W} :is(code,kbd,pre,samp){font-family:var(--font-mono);font-size:.93em}
${W} kbd{flex:none;display:inline-flex;align-items:center;height:22px;padding:0 6px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);font-size:11px;color:var(--text-2)}
${W} :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
${W} :is(button,input,select,textarea){font:inherit;color:inherit}
${W} ::placeholder{color:var(--muted);opacity:1}
${W} .v2-sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
${W} .v2-mono{font-family:var(--font-mono)}
${W} :is(.v2-num,.v2-mono,code,kbd,samp):not([dir]){unicode-bidi:plaintext}
${W} select.v2-mono:not([dir=ltr]){font-family:var(--font-sans)}
${W} .v2-num{font-variant-numeric:tabular-nums}
${W} .v2-muted{color:var(--muted)}
${W} .v2-icon{flex:none}
${W} .v2-flip:dir(rtl){transform:scaleX(-1)}
${W} .v2-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1);min-height:var(--target);min-inline-size:var(--target);padding:0 16px;border-radius:var(--radius-control);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font-size:14px;font-weight:600;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color .14s ease-out,border-color .14s ease-out,color .14s ease-out}
${W} .v2-btn:hover{background:var(--subtle);border-color:var(--muted);color:var(--text)}
${W} .v2-btn--primary{padding:0 18px;border-color:transparent;background:var(--accent-fill);color:var(--on-accent)}
${W} .v2-btn--primary:hover{background:var(--accent-fill-hover);border-color:transparent;color:var(--on-accent)}
${W} .v2-btn--ghost{border-color:transparent;background:transparent;color:var(--accent)}
${W} .v2-btn--ghost:hover{border-color:transparent;background:var(--subtle);color:var(--accent)}
${W} .v2-btn--danger{border-color:var(--bad);background:var(--bad);color:var(--surface)}
${W} .v2-btn--danger:hover{border-color:var(--bad);background:var(--bad);color:var(--surface);filter:brightness(.93)}
${W} .v2-btn--soft-danger{border-color:var(--bad-line);background:var(--bad-soft);color:var(--bad)}
${W} .v2-btn--soft-danger:hover{border-color:var(--bad);background:var(--bad-soft);color:var(--bad)}
${W} .v2-btn--icon{width:var(--target);padding:0;border-color:var(--line);color:var(--text-2)}
${W} .v2-btn:is(:disabled,[aria-disabled="true"]){border-color:var(--line-strong);border-style:dashed;background:var(--sunken);color:var(--muted);filter:none;transition:none;cursor:not-allowed}
${W} :is(${CONTROL},select,textarea){min-height:var(--target);max-width:100%;padding:0 12px;border-radius:var(--radius-control);border:1px solid var(--line-strong);background:var(--surface);font-size:14px;text-align:match-parent;text-align:-webkit-match-parent}
${W} :is(${CONTROL},textarea)[readonly]:not(:disabled){background-color:var(--subtle)}
${W} :is(${CONTROL},select,textarea):focus-visible{box-shadow:0 0 0 4px var(--accent-soft)}
${W} textarea{min-height:96px;padding:12px;line-height:1.5;resize:vertical}
${W} :is(${CONTROL},select,textarea)[aria-invalid="true"]{border:1.5px solid var(--bad)}
${W} :is(${CONTROL},select,textarea):disabled{border-color:var(--line-strong);border-style:dashed;background-color:var(--sunken);color:var(--muted);cursor:not-allowed}
${W} label:has(input:is([type=checkbox],[type=radio]):disabled){color:var(--muted);cursor:not-allowed}
${W} input:is([type=checkbox],[type=radio]):not([role=switch]):disabled{opacity:.55}
${W} input:is([type=checkbox],[type=radio]){width:18px;height:18px;margin:0;accent-color:var(--accent-fill)}
${W} input[type=checkbox][role=switch]{appearance:none;position:relative;flex:none;width:40px;height:24px;border-radius:var(--radius-pill);background:var(--line-strong);cursor:pointer;transition:background .15s}
${W} input[type=checkbox][role=switch]::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:18px;height:18px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:inset-inline-start .15s}
${W} input[type=checkbox][role=switch]:checked{background:var(--accent-fill)}
${W} input[type=checkbox][role=switch]:checked::after{inset-inline-start:19px}
${W} input[type=checkbox][role=switch]:disabled{opacity:.5;cursor:not-allowed}
${W} select:not([multiple],[size]){appearance:none;padding-inline-end:36px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='none' stroke='%237E8CA3' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
${W} select:dir(rtl){background-position:left 12px center}
${W}:dir(rtl) select:dir(ltr):not([multiple],[size]){padding-inline:36px 12px;background-position:left 12px center}
${W} .v2-select{position:relative;display:block}
${W} .v2-select>select{width:100%;padding-inline-end:40px;background-image:none}
${W}:dir(rtl) .v2-select>select:dir(ltr){padding-inline:40px 12px}
${W} .v2-select>.v2-icon{position:absolute;inset-inline-end:14px;top:50%;margin-top:-8px;color:var(--muted);pointer-events:none}
${W} :is(meter,progress){inline-size:100%;block-size:6px;border:0;border-radius:3px;background:var(--sunken);vertical-align:middle}
${W} progress{appearance:none;overflow:hidden}
${W} ::-webkit-meter-bar,${W} ::-webkit-progress-bar{block-size:6px;border:0;border-radius:3px;background:var(--sunken)}
${W} ::-webkit-progress-value,${W} ::-webkit-meter-optimum-value{background:var(--accent-fill)}
${W} ::-webkit-meter-suboptimum-value{background:var(--warn)}
${W} ::-webkit-meter-even-less-good-value{background:var(--bad)}
${W} ::-moz-meter-bar,${W} ::-moz-progress-bar{background:var(--accent-fill)}
${W} input[type=file]{max-inline-size:100%;font-size:13px;color:var(--text-2)}
${W} ::file-selector-button{min-height:var(--target);margin-inline-end:12px;padding:0 16px;border-radius:var(--radius-control);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
${W} ::file-selector-button:hover{background:var(--subtle);border-color:var(--muted)}
${W} table{width:100%;border-collapse:collapse;font-size:14px}
${W} caption{padding:0 0 8px;text-align:start;font-weight:600}
${W} thead th{padding:12px 16px;background:var(--subtle);color:var(--muted);border-bottom:1px solid var(--line);font-size:12px;font-weight:600;text-align:start;white-space:nowrap}
${W} :where(td,tbody th){padding:14px 16px;border-top:1px solid var(--line);vertical-align:middle}
${W} tbody th{font-weight:400;text-align:start}
${W} tbody th[scope=row]{font-weight:600}
${W} tbody th[scope=rowgroup]{padding-block:12px;background:var(--subtle);color:var(--muted);font-size:12px;font-weight:600}
${W} :is(th,td):first-child{padding-inline-start:var(--v2-panel-padding)}
${W} :is(th,td):last-child{padding-inline-end:var(--v2-panel-padding)}
${W} tbody tr:hover>td{background:var(--subtle)}
${W} :where(p:is([role=alert],[data-state=failed],[data-state=error]):not(:empty)){padding:12px 16px;border:1px solid var(--bad-line);border-radius:var(--radius-notice);background:var(--bad-soft);color:var(--text)}
${W} :where(td[data-table-empty]){padding-block:24px;text-align:center;color:var(--muted)}
${W} :where(td[data-label])::before{flex:0 1 auto;max-inline-size:45%;overflow-wrap:anywhere}
${W} .v2-table-scroll{overflow-x:auto;border-top:1px solid var(--line)}
${W} .v2-table-scroll:focus-visible{outline-offset:-2px}
@keyframes v2-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes v2-spin{to{transform:rotate(360deg)}}
@keyframes v2-drain{from{inline-size:100%}to{inline-size:0}}
@media(max-width:959px){${W} :is(${CONTROL},select,textarea,[contenteditable="true"]){font-size:16px}}
@media(max-width:600px){${R}{--v2-panel-padding:var(--space-2)}}
@media(forced-colors:active){${W} select{appearance:auto!important;padding-inline:12px!important;background-image:none!important}${W} .v2-select>.v2-icon{display:none}}
@media (prefers-reduced-motion:reduce){${R} *,${R} *::before,${R} *::after{animation:none!important;transition:none!important}}
`
