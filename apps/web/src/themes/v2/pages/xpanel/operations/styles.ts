import { phoneLabelCss } from '../settings/common.ts'

export const PANEL_OPERATIONS_CSS = `.v2-panel-operations{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-panel-operation-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-panel-operations .v2-page-header h1{font-size:26px;line-height:1.2}
.v2-panel-operation-dialog h2{font-size:18px;line-height:1.3}
.v2-panel-operations .v2-card h2,.v2-panel-terminal-head h2{font-size:16px;line-height:1.35}
.v2-panel-operations h3{font-size:14px;line-height:1.4}
.v2-panel-operation-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:var(--space-3);align-items:stretch;min-inline-size:0}.v2-panel-operation-columns--even{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-panel-operation-columns>.v2-panel-operation-stack>.v2-card:last-child{display:flex;flex-direction:column;flex:1 1 auto}
.v2-panel-operation-columns>.v2-panel-operation-stack>.v2-card:last-child>.v2-card__body{display:flex;flex-direction:column;flex:1 1 auto}
.v2-panel-operation-columns>.v2-panel-operation-stack>.v2-card:last-child>.v2-card__body>.v2-panel-operation-actions:last-child{margin-block-start:auto}
.v2-panel-operation-fields,.v2-panel-operation-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-operations [data-account-backup]{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-panel-operations [data-backup-files-steps]{list-style:none;margin:0;padding:0;gap:var(--space-1) var(--space-3);font-size:13px;color:var(--muted)}
.v2-panel-operations [data-backup-files-steps]>li{display:flex;align-items:center;gap:var(--space-1)}
.v2-panel-operations [data-backup-files-steps] strong{display:inline-flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;border:1px solid var(--line-strong);border-radius:50%;font-variant-numeric:tabular-nums;flex:none}
.v2-panel-operations [data-backup-files-steps]>[aria-current=step]{color:var(--text);font-weight:600}
.v2-panel-operations [data-backup-files-steps]>[aria-current=step] strong{border-color:transparent;background:var(--accent-fill);color:var(--on-accent)}
.v2-panel-operation-facts{margin:0;grid-template-columns:repeat(auto-fit,minmax(min(100%,130px),1fr))}
.v2-panel-operations .v2-card__body>:is(button,a.v2-btn),.v2-panel-operations [role=tabpanel]>:is(button,a.v2-btn){align-self:flex-start}
.v2-panel-operations .v2-field>p,.v2-panel-operations .v2-field__help{font-size:13px;line-height:1.5;color:var(--muted)}
.v2-panel-operations [role=tabpanel]:not(.v2-tabpanel){display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-operations [role=tabpanel][hidden]{display:none}
.v2-panel-operations [data-runtime-setup]>[role=tablist]{gap:4px;border-block-end:1px solid var(--line)}
.v2-panel-operations [data-runtime-setup]>[role=tablist]>[role=tab]{margin-block-end:-1px;border:0;border-block-end:2px solid transparent;border-radius:0;background:transparent;color:var(--muted);font-weight:500}
.v2-panel-operations [data-runtime-setup]>[role=tablist]>[role=tab][aria-selected=true]{border-block-end-color:var(--accent-fill);color:var(--text);font-weight:600}
.v2-panel-operations :is([data-ftp-sessions-tool],[data-runtime-preflight]){display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-operation-table .v2-pill{margin-inline-end:4px}
.v2-panel-operation-table .v2-panel-operation-actions{flex-wrap:wrap;gap:var(--space-1)}
.v2-card.v2-panel-terminal-session{padding:0;gap:0}
.v2-panel-operations pre:empty{display:none}
.v2-panel-operation-inline{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-1);min-inline-size:0}
.v2-panel-operation-inline>.v2-field{flex:1 1 180px;min-inline-size:0}
.v2-panel-operation-fields:has(>.v2-panel-operation-inline){grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:var(--space-2) var(--space-3)}
.v2-panel-operations .v2-steps--inline>.v2-step{flex:1 1 150px}
.v2-panel-operations .v2-steps--inline .v2-step__label{white-space:nowrap}
.v2-panel-operation-facts>div{display:flex;flex-direction:column;gap:4px;min-inline-size:0;text-align:start;padding-inline-start:12px;border-inline-start:1px solid var(--line)}
.v2-panel-operation-facts dd{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums}
.v2-panel-operation-facts :is(dt,dd){margin:0;overflow-wrap:anywhere}
.v2-panel-operation-facts dt{font-size:12px;color:var(--muted)}
.v2-panel-operation-facts bdi{unicode-bidi:isolate}
.v2-panel-operation-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-operations :is(.v2-btn,[role=tab]),.v2-panel-operation-actions :is(button,a){min-inline-size:44px;min-block-size:44px}
.v2-panel-operations :is(.v2-btn,[role=tab],.v2-panel-operation-options label){transition-property:background-color,border-color,color,box-shadow,opacity,transform;transition-duration:140ms;transition-timing-function:ease-out}
.v2-panel-operation-actions [aria-disabled=true]{pointer-events:none;opacity:.55}
.v2-panel-operations :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-operations :is(input,select,textarea){min-inline-size:0;max-inline-size:100%}
.v2-panel-operation-table{max-inline-size:100%;overflow:auto;min-inline-size:0;border:1px solid var(--line);border-radius:12px}
.v2-panel-operation-table tr:first-child>td{border-block-start:0}
.v2-panel-operation-table td[colspan]{padding-block:var(--space-3);text-align:center;color:var(--muted);font-size:13px}
.v2-panel-operation-table td[colspan]>p{margin:0}
.v2-panel-operation-table:has(tbody:empty){display:none}
.v2-panel-operation-table table{min-inline-size:480px}
.v2-panel-operation-table :is(th,td){text-align:start;vertical-align:top;overflow-wrap:break-word;padding:12px 16px}
.v2-panel-operation-table :is(th,td):first-child{padding-inline-start:16px}
.v2-panel-operation-table :is(th,td):last-child{padding-inline-end:16px}
.v2-panel-operation-table thead th,.v2-panel-operations .v2-tool-card__table thead th{font-size:12px;white-space:normal}
.v2-panel-operation-table :is(bdi,time){unicode-bidi:isolate;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.v2-panel-operations :is(.v2-num,.v2-kpi__value,td,time,[data-account-backup-count],[data-runtime-stat],[data-runtime-version],[data-sw-apps-sequence],[data-sw-apps-expires]),.v2-panel-operations .v2-tool-card__facts dd{font-variant-numeric:tabular-nums}
.v2-panel-operation-table .v2-panel-operation-stack{gap:var(--space-1);align-items:flex-start}
.v2-panel-operation-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:var(--space-1) var(--space-2);margin:0;padding:0;border:0;min-inline-size:0}
.v2-panel-operation-options legend{margin-block-end:var(--space-1);font-size:13px;font-weight:600;padding:0}
.v2-panel-operation-options label{display:flex;align-items:flex-start;gap:12px;padding:12px var(--space-2);border:1px solid var(--line);border-radius:12px;font-size:13px;line-height:1.5;min-block-size:var(--target)}
.v2-panel-operation-options label:has(input:checked){border-color:var(--accent-line);background:var(--accent-soft)}
.v2-panel-operation-options label:has(input:disabled:not(:checked)){background:var(--subtle);color:var(--muted)}
.v2-panel-operation-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);padding-block:10px;font-size:14px;line-height:1.5}
.v2-panel-operation-options input,.v2-panel-operation-check input{flex:none;inline-size:18px;block-size:18px;margin:2px 0 0}
.v2-panel-operations :is(h2,h3,p,dl,dd,ul,ol,pre){margin:0}
.v2-panel-operations .v2-card__body>p:not([role=status],[role=alert],[class]),.v2-panel-operations .v2-card__body>div>p:not([role=status],[role=alert],[class]),.v2-panel-operations [role=tabpanel]>p:not([role=status],[role=alert]){font-size:13px;line-height:1.6;color:var(--muted)}
.v2-panel-operations :is([role=status],[role=alert])[data-state]:not([data-state=failed],[data-state=error]){font-size:13px;color:var(--muted)}
.v2-panel-operations :is([role=status],[role=alert])[data-state]:is([data-state=uncertain],[data-state=invalid],[data-state=unavailable]):not(:empty){padding:12px 16px;border:1px solid var(--warn-line);background:var(--warn-soft);border-radius:12px;color:var(--text)}
.v2-panel-operations .v2-field>:is(input,select,textarea,.v2-select){inline-size:100%}
.v2-panel-operations .v2-field>label{font-size:13px;font-weight:600;padding-inline:13px}
.v2-panel-operations .v2-tabpanel--sections{gap:var(--space-3)}
.v2-panel-operation-dialog{inline-size:min(560px,calc(100% - 32px));padding:var(--v2-panel-padding);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text)}
.v2-panel-operation-dialog form{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-panel-operation-dialog::backdrop{background:var(--scrim)}
.v2-panel-operations pre{white-space:pre-wrap;overflow-wrap:anywhere;max-block-size:360px;overflow:auto;background:var(--code);color:var(--code-text);padding:var(--space-2);border-radius:12px;min-inline-size:0}
.v2-panel-operations [data-html-frame]{inline-size:100%;min-block-size:240px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.v2-panel-operation-unavailable{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--warn-line);border-radius:12px;background:var(--warn-soft)}
.v2-panel-terminal-session{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);overflow:hidden;min-inline-size:0}
.v2-panel-terminal-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);padding:var(--v2-panel-padding)}
.v2-panel-terminal-head h2{flex:1 1 auto}
.v2-panel-terminal-head :is([data-terminal-pill],[data-terminal-exec-pill]){display:inline-flex;align-items:center;gap:var(--space-1);padding:4px var(--space-1);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--subtle);font-size:12px}
.v2-panel-terminal-head [data-tone=ok]{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
.v2-panel-terminal-head [data-tone=warn]{color:var(--warn);background:var(--warn-soft);border-color:var(--warn-line)}
.v2-panel-terminal-head [data-tone=info]{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.v2-panel-operations [data-state-chip]{display:inline-flex;align-items:center;gap:var(--space-1);padding:2px var(--space-1);border:1px solid var(--line);border-radius:var(--radius-pill);font-size:12px}
.v2-panel-operations [data-state-chip=ok]{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
.v2-panel-operations [data-state-chip=problem]{color:var(--bad);background:var(--bad-soft);border-color:var(--bad-line)}
.v2-panel-terminal-pad{display:flex;flex-direction:column;gap:var(--space-3);padding:0 var(--v2-panel-padding) var(--v2-panel-padding)}
.v2-panel-terminal-screen{block-size:clamp(280px,50vh,560px);padding:var(--space-2);background:var(--code);color:var(--code-text);font-family:var(--font-mono);overflow:hidden;min-inline-size:0}
.v2-panel-terminal-screen .xterm{block-size:100%}
.v2-panel-terminal-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);padding:var(--v2-panel-padding);background:var(--subtle);border-block-start:1px solid var(--line)}
.v2-panel-terminal-command{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);flex:1 1 100%;min-inline-size:0}
.v2-panel-terminal-command>.v2-field{flex:1 1 240px}
.v2-panel-operations .v2-tool-card__facts>div{display:flex;flex-direction:column;gap:4px;min-inline-size:0;padding-inline-start:12px;border-inline-start:1px solid var(--line)}
.v2-panel-operations .v2-tool-card__facts dt{font-size:12px;font-weight:400;color:var(--muted)}.v2-panel-operations .v2-tool-card__facts dd{font-size:14px;font-weight:500}
.v2-panel-operations .v2-tool-card__table{border:1px solid var(--line);border-radius:12px}
.v2-panel-operations .v2-tool-card__table :is(th,td){padding:12px 16px;vertical-align:top;border-block-end:0}.v2-panel-operations .v2-tool-card__table tr:first-child>td{border-block-start:0}
.v2-panel-operations:dir(rtl) *,[data-ui-theme="v2"] [dir=rtl] .v2-panel-operations *{letter-spacing:0}
@media(prefers-reduced-motion:reduce){.v2-panel-operations :is(.v2-btn,[role=tab],.v2-panel-operation-options label){transition-duration:0ms}}
@media(max-width:640px){.v2-panel-operations .v2-card,.v2-panel-operation-dialog,.v2-panel-terminal-head,.v2-panel-terminal-bar{padding:var(--space-2)}.v2-panel-terminal-pad{padding:0 var(--space-2) var(--space-2)}}
@media(min-width:601px){.v2-panel-operation-table .v2-btn{padding-inline:12px;font-size:13px}.v2-panel-operation-table .v2-panel-operation-actions:has(>:nth-child(3)){min-inline-size:232px}}
@media(max-width:1000px){.v2-panel-operation-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-operation-fields{grid-template-columns:minmax(0,1fr)}.v2-panel-operation-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-panel-operations .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-panel-operations .v2-kpi-row>.v2-kpi:last-child:nth-child(odd){grid-column:1/-1}}
@media(max-width:600px){.v2-panel-operation-table tr>td:nth-child(2):not([colspan]){grid-column:1/-1;grid-row:auto;justify-self:start;text-align:start}.v2-panel-operation-table td bdi{overflow-wrap:anywhere}}
@media(min-width:601px){.v2-panel-operation-table :is(#v2-runtime-containers-table,#v2-runtime-apps,#v2-ftp-table,#v2-ftp-sessions-table){table-layout:fixed;inline-size:100%}.v2-panel-operation-table :is(#v2-runtime-containers-table,#v2-runtime-apps,#v2-ftp-table) .v2-panel-operation-actions:has(>:nth-child(3)){min-inline-size:0}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(1){inline-size:15%}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(2){inline-size:24%}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(3){inline-size:11%}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(4){inline-size:14%}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(5){inline-size:11%}.v2-panel-operation-table #v2-runtime-containers-table th:nth-child(6){inline-size:25%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(1){inline-size:16%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(2){inline-size:10%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(3){inline-size:22%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(4){inline-size:12%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(5){inline-size:12%}.v2-panel-operation-table #v2-runtime-apps th:nth-child(6){inline-size:28%}.v2-panel-operation-table #v2-ftp-table th:nth-child(1){inline-size:29%}.v2-panel-operation-table #v2-ftp-table th:nth-child(2){inline-size:24%}.v2-panel-operation-table #v2-ftp-table th:nth-child(3){inline-size:10%}.v2-panel-operation-table #v2-ftp-table th:nth-child(4){inline-size:11%}.v2-panel-operation-table #v2-ftp-table th:nth-child(5){inline-size:26%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(1){inline-size:24%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(2){inline-size:17%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(3){inline-size:13%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(4){inline-size:11%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(5){inline-size:11%}.v2-panel-operation-table #v2-ftp-sessions-table th:nth-child(6){inline-size:24%}}
.v2-panel-operation-table #v2-ftp-sessions-table td .v2-btn{white-space:normal}
${phoneLabelCss('.v2-panel-operation-table')}
`
