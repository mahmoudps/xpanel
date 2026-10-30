// v2 base element styles, scoped to the v2 root through :where() so they add no specificity: semantic elements
// inserted by core controllers get these defaults, and component classes override them by source order.
// Technical values (.v2-num, .v2-mono, code) use unicode-bidi:plaintext so numbers with units, dates, domains and
// commands keep their own reading order inside right-to-left pages.

const R = '[data-ui-theme="v2"]'
const W = `:where(${R})`
const CONTROL = 'input:not([type=checkbox],[type=radio],[type=range],[type=file],[type=hidden],[type=color])'

export const V2_BASE_CSS = `${R}{--v2-panel-padding:var(--space-3);--v2-control-align:start}
${R}:dir(rtl){--v2-control-align:end}
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
${W} :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
${W} :is(button,input,select,textarea){font:inherit;color:inherit}
${W} ::placeholder{color:var(--muted);opacity:1}
${W} .v2-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
${W} .v2-mono{font-family:var(--font-mono)}
${W} :is(.v2-num,.v2-mono,code,kbd,samp){unicode-bidi:plaintext}
${W} .v2-num{font-variant-numeric:tabular-nums}
${W} .v2-muted{color:var(--muted)}
${W} .v2-icon{flex:none}
${W} .v2-flip:dir(rtl){transform:scaleX(-1)}
${W} .v2-btn{display:inline-flex;align-items:center;justify-content:center;gap:var(--space-1);min-height:var(--target);padding:0 16px;border-radius:var(--radius-control);border:1px solid var(--line-strong);background:var(--surface);color:var(--text);font-size:14px;font-weight:600;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer}
${W} .v2-btn:hover{background:var(--subtle);border-color:var(--muted);color:var(--text)}
${W} .v2-btn--primary{padding:0 18px;border-color:transparent;background:var(--accent-fill);color:var(--on-accent)}
${W} .v2-btn--primary:hover{background:var(--accent-fill-hover);border-color:transparent;color:var(--on-accent)}
${W} .v2-btn--ghost{border-color:transparent;background:transparent;color:var(--accent)}
${W} .v2-btn--ghost:hover{border-color:transparent;background:var(--subtle);color:var(--accent)}
${W} .v2-btn--danger{border-color:var(--bad);background:var(--bad);color:var(--surface)}
${W} .v2-btn--danger:hover{border-color:var(--bad);background:var(--bad);color:var(--surface);filter:brightness(.93)}
${W} .v2-btn--icon{width:var(--target);padding:0;border-color:var(--line);color:var(--text-2)}
${W} .v2-btn:is(:disabled,[aria-disabled="true"]){border-color:var(--line);background:var(--sunken);color:var(--muted);filter:none;cursor:not-allowed}
${W} :is(${CONTROL},select,textarea){min-height:var(--target);max-width:100%;padding:0 12px;border-radius:var(--radius-control);border:1px solid var(--line-strong);background:var(--surface);font-size:14px}
${W} textarea{min-height:96px;padding:12px;line-height:1.5;resize:vertical}
${W} :is(${CONTROL},select,textarea)[aria-invalid="true"]{border:1.5px solid var(--bad)}
${W} :is(${CONTROL},select,textarea):disabled{border-color:var(--line);background:var(--sunken);color:var(--muted)}
${W} input:is([type=checkbox],[type=radio]){width:18px;height:18px;margin:0;accent-color:var(--accent-fill)}
${W} input[type=checkbox][role=switch]{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:40px;height:24px;border-radius:var(--radius-pill);background:var(--line-strong);cursor:pointer;transition:background .15s}
${W} input[type=checkbox][role=switch]::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:18px;height:18px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:inset-inline-start .15s}
${W} input[type=checkbox][role=switch]:checked{background:var(--accent-fill)}
${W} input[type=checkbox][role=switch]:checked::after{inset-inline-start:19px}
${W} input[type=checkbox][role=switch]:disabled{opacity:.5;cursor:not-allowed}
${W} .v2-select{position:relative;display:block}
${W} .v2-select>select{width:100%;appearance:none;-webkit-appearance:none;padding-inline-end:40px}
${W} .v2-select>.v2-icon{position:absolute;inset-inline-end:14px;top:50%;margin-top:-8px;color:var(--muted);pointer-events:none}
${W} table{width:100%;border-collapse:collapse;font-size:14px}
${W} caption{padding:0 0 8px;text-align:start;font-weight:600}
${W} th{padding:12px 16px;background:var(--subtle);color:var(--muted);font-size:12px;font-weight:600;text-align:start;white-space:nowrap}
${W} td{padding:14px 16px;border-top:1px solid var(--line);vertical-align:middle}
${W} :is(th,td):first-child{padding-inline-start:var(--v2-panel-padding)}
${W} :is(th,td):last-child{padding-inline-end:var(--v2-panel-padding)}
${W} tbody tr:hover>td{background:var(--subtle)}
${W} .v2-table-scroll{overflow-x:auto;border-top:1px solid var(--line)}
${W} .v2-table-scroll:focus-visible{outline-offset:-2px}
@keyframes v2-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes v2-spin{to{transform:rotate(360deg)}}
@keyframes v2-drain{from{inline-size:100%}to{inline-size:0}}
@media (max-width:600px){${R}{--v2-panel-padding:var(--space-2)}}
@media (prefers-reduced-motion:reduce){${R} *,${R} *::before,${R} *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`
