import { adminStyles } from './common.ts'
export const WHM_SERVER_CSS = adminStyles('.v2-server-page') + `.v2-server-page .v2-server-setup-steps{padding:var(--space-2) var(--v2-panel-padding);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);overflow:auto}
.v2-server-page :is(.v2-server-setup-steps a,.v2-server-setup-choice,.v2-server-setup-review a,[data-tweak-settings] td a){transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out,box-shadow 140ms ease-out,opacity 140ms ease-out,transform 140ms ease-out}
@media(prefers-reduced-motion:reduce){.v2-server-page :is(.v2-server-setup-steps a,.v2-server-setup-choice,.v2-server-setup-review a,[data-tweak-settings] td a){transition:none}}
.v2-server-page [data-setup-wizard-form]{gap:var(--space-4)}
.v2-server-page [data-tweak-settings] .v2-admin-table{max-block-size:min(640px,80vh);border:1px solid var(--line);border-radius:var(--radius-notice)}
.v2-server-page [data-tweak-settings] thead th{position:sticky;inset-block-start:0;z-index:1}
.v2-server-page [data-tweak-settings] td a{display:inline-flex;align-items:center;min-inline-size:var(--target);min-block-size:var(--target)}
.v2-server-page .v2-server-setup-steps ol{display:flex;gap:var(--space-2);list-style:none;padding:0;min-inline-size:760px}
.v2-server-page .v2-server-setup-steps li{flex:1;min-inline-size:0}
.v2-server-page .v2-server-setup-steps a{display:flex;flex-direction:column;align-items:center;gap:var(--space-1);padding:var(--space-1);text-align:center;text-decoration:none;min-inline-size:var(--target);min-block-size:var(--target)}
.v2-server-page .v2-server-setup-steps a>span:first-child{display:grid;place-items:center;inline-size:28px;block-size:28px;border:1px solid var(--line-strong);border-radius:var(--radius-pill);font-variant-numeric:tabular-nums}
.v2-server-page .v2-server-terminal-session{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);overflow:hidden}
.v2-server-page .v2-server-terminal-head,.v2-server-page .v2-server-terminal-bar{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--v2-panel-padding)}
.v2-server-page .v2-server-terminal-screen{block-size:clamp(280px,50vh,560px);padding:var(--space-2);background:var(--code);color:var(--code-text);font-family:var(--font-mono);font-size:13px;overflow:hidden;min-inline-size:0;box-sizing:border-box}
.v2-server-page .v2-server-terminal-screen .xterm{block-size:100%}
.v2-server-page [data-terminal-pill],.v2-server-page [data-terminal-exec-pill]{display:inline-flex;align-items:center;gap:var(--space-1);padding:4px 10px;border:1px solid var(--line);border-radius:8px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.v2-server-page [data-tone=ok]{background:var(--ok-soft);color:var(--ok)}
.v2-server-page [data-tone=warn]{background:var(--warn-soft);color:var(--warn)}
@media(min-width:901px){.v2-server-page [data-setup-stepper]:not(:has(#v2-setup-workers:target,#v2-setup-review:target)) [data-setup-wizard-form]{flex:1}.v2-server-page [data-setup-wizard-form]>[data-setup-step],.v2-server-page [data-setup-stepper] .v2-admin-stack>[data-setup-step]:target{flex:1;display:flex;flex-direction:column}.v2-server-page [data-setup-step]>.v2-card__body{flex:1}.v2-server-page [data-setup-step] .v2-server-setup-foot{margin-block-start:auto}}
.v2-server-page [data-setup-stepper]:has([data-setup-step]:target) [data-setup-step]:not(:target),.v2-server-page [data-setup-stepper]:not(:has([data-setup-step]:target)) [data-setup-step]:not([data-setup-step=identity]){display:none}
.v2-server-page [data-setup-step]{scroll-margin-block-start:240px}
.v2-server-page .v2-server-setup-choices{border:0;padding:0;margin:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-server-page .v2-server-setup-choices>legend{padding:0;margin-block-end:8px;font-size:13px;font-weight:600;color:var(--text-2)}
.v2-server-page .v2-server-setup-choices>div{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:16px}
.v2-server-page .v2-server-setup-choice{display:flex;align-items:flex-start;gap:12px;padding:16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface);cursor:pointer}
.v2-server-page .v2-server-setup-choice:hover{border-color:var(--line-strong);background:var(--subtle)}
.v2-server-page .v2-server-setup-choice:has(:checked){border-color:var(--accent);background:var(--accent-soft)}
.v2-server-page .v2-server-setup-choice:has(:disabled){cursor:not-allowed;background:var(--subtle)}
.v2-server-page .v2-server-setup-choice:has(:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.v2-server-page .v2-server-setup-choice input{flex:none;inline-size:18px;block-size:18px;margin:2px 0 0;accent-color:var(--accent-fill)}
.v2-server-page .v2-server-setup-choice>span{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.v2-server-page .v2-server-setup-choice .v2-muted{font-size:12px;line-height:1.5}
.v2-server-page .v2-server-setup-review{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px;margin:0}
.v2-server-page .v2-server-setup-review>div{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;align-items:center;padding-block:12px;border-block-end:1px solid var(--line);min-inline-size:0}
.v2-server-page .v2-server-setup-review>div:last-child:nth-child(odd){grid-column:1/-1}
.v2-server-page .v2-server-setup-review dt{font-size:12px;color:var(--muted)}
.v2-server-page .v2-server-setup-review dd{grid-column:1;margin:0;overflow-wrap:anywhere;unicode-bidi:plaintext;font-variant-numeric:tabular-nums}
.v2-server-page .v2-server-setup-review a{grid-column:2;grid-row:1/span 2;display:inline-flex;align-items:center;justify-content:center;min-inline-size:var(--target);min-block-size:var(--target);padding-inline:12px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;text-decoration:none}
.v2-server-page .v2-server-setup-review a:hover{border-color:var(--line-strong);background:var(--subtle);color:var(--accent)}
.v2-server-page [data-setup-step=review] h3{margin:0;font-size:14px}
.v2-server-page [data-setup-step=workers] fieldset>.v2-admin-fields{grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr))}
@media(max-width:600px){.v2-server-page .v2-server-setup-review{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-server-page [data-tweak-settings] table{display:block;table-layout:auto;min-inline-size:0}.v2-server-page [data-tweak-settings] thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}.v2-server-page [data-tweak-settings] tbody{display:block}.v2-server-page [data-tweak-settings] tr[data-setting-group],.v2-server-page [data-tweak-settings] tr[data-setting-group]>th{display:block}.v2-server-page [data-tweak-settings] tr[data-setting-row]:not([hidden]){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:center;gap:8px 16px;padding:12px}.v2-server-page [data-tweak-settings] tr[data-setting-row]>*{display:block;position:static;grid-row:auto;grid-column:auto;inline-size:auto;padding:0;margin:0;text-align:start;overflow-wrap:anywhere}.v2-server-page [data-tweak-settings] tr[data-setting-row]>*::before{content:none}.v2-server-page [data-tweak-settings] tr[data-setting-row]>:is(th,td:nth-child(4)){grid-column:1/-1}}
@media(max-width:600px){.v2-server-page #v2-ip-change-many-table tbody tr:not(:has([colspan])){display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 16px}.v2-server-page #v2-ip-change-many-table tbody tr:not(:has([colspan]))>td{display:block;position:static;grid-row:auto;grid-column:auto;inline-size:auto;margin:0;padding:0;text-align:start}.v2-server-page #v2-ip-change-many-table tbody tr:not(:has([colspan]))>td:nth-child(3){grid-column:1/-1}.v2-server-page #v2-ip-change-many-table tbody tr:not(:has([colspan]))>td::before{content:none}.v2-server-page #v2-ip-change-many-table select{inline-size:100%;min-inline-size:0}.v2-server-page #v2-ip-change-many-table tbody tr{padding-block:12px}}
.v2-server-page .v2-server-setup-eyebrow{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-variant-numeric:tabular-nums}
.v2-server-page:dir(rtl) .v2-server-setup-eyebrow,.v2-server-page[dir=rtl] .v2-server-setup-eyebrow,[data-ui-theme="v2"][dir=rtl] .v2-server-page .v2-server-setup-eyebrow{letter-spacing:0;text-transform:none}
.v2-server-page .v2-server-setup-foot{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:var(--space-2);padding-block-start:var(--space-3);border-block-start:1px solid var(--line)}
.v2-server-page .v2-server-setup-foot>a:first-child:not(.v2-btn--primary){margin-inline-end:auto}
.v2-server-page .v2-server-setup-steps a{border-radius:var(--radius-control);color:var(--text-2);font-size:13px}
.v2-server-page .v2-server-setup-steps a:hover{background:var(--subtle)}
.v2-server-page [data-setup-stepper]:has(#v2-setup-identity:target) a[href="#v2-setup-identity"],.v2-server-page [data-setup-stepper]:has(#v2-setup-network:target) a[href="#v2-setup-network"],.v2-server-page [data-setup-stepper]:has(#v2-setup-email:target) a[href="#v2-setup-email"],.v2-server-page [data-setup-stepper]:has(#v2-setup-engine:target) a[href="#v2-setup-engine"],.v2-server-page [data-setup-stepper]:has(#v2-setup-workers:target) a[href="#v2-setup-workers"],.v2-server-page [data-setup-stepper]:has(#v2-setup-review:target) a[href="#v2-setup-review"],.v2-server-page [data-setup-stepper]:not(:has([data-setup-step]:target)) a[href="#v2-setup-identity"]{color:var(--text);font-weight:600}
.v2-server-page [data-setup-stepper]:has(#v2-setup-identity:target) a[href="#v2-setup-identity"]>span:first-child,.v2-server-page [data-setup-stepper]:has(#v2-setup-network:target) a[href="#v2-setup-network"]>span:first-child,.v2-server-page [data-setup-stepper]:has(#v2-setup-email:target) a[href="#v2-setup-email"]>span:first-child,.v2-server-page [data-setup-stepper]:has(#v2-setup-engine:target) a[href="#v2-setup-engine"]>span:first-child,.v2-server-page [data-setup-stepper]:has(#v2-setup-workers:target) a[href="#v2-setup-workers"]>span:first-child,.v2-server-page [data-setup-stepper]:has(#v2-setup-review:target) a[href="#v2-setup-review"]>span:first-child,.v2-server-page [data-setup-stepper]:not(:has([data-setup-step]:target)) a[href="#v2-setup-identity"]>span:first-child{background:var(--accent-fill);border-color:var(--accent-fill);color:var(--on-accent,#fff)}
.v2-server-page .v2-admin-columns>:last-child .v2-admin-table table{min-inline-size:0}
.v2-server-page .v2-admin-columns>:last-child .v2-admin-table :is(th,td){white-space:normal;padding-inline:12px}
.v2-server-page .v2-admin-table thead th{white-space:normal;overflow-wrap:normal;word-break:normal}
.v2-server-page .v2-admin-table td{overflow-wrap:break-word}
.v2-server-page [data-file-share-links]>h2{margin:0;font-size:16px}
.v2-server-page .v2-admin-fields>.v2-field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-server-page .v2-admin-fields>.v2-field :is(input,select){inline-size:100%;box-sizing:border-box}
.v2-server-page [data-tweak-settings] table{table-layout:fixed}
.v2-server-page [data-tweak-settings] thead th:first-child{inline-size:40%}
.v2-server-page [data-tweak-settings] thead th:nth-child(2){inline-size:16%}
.v2-server-page [data-tweak-settings] thead th:nth-child(3){inline-size:18%}
.v2-server-page [data-tweak-settings] td :is(input:not([type=checkbox]),select){inline-size:100%;min-inline-size:0;box-sizing:border-box}
.v2-server-page [data-tweak-settings] th[scope=row]>span{display:block;font-weight:500}
.v2-server-page [data-setting-value]{font-variant-numeric:tabular-nums}
.v2-server-page [data-ip-pool-table] td:first-child bdi{white-space:nowrap}
.v2-server-page :is([data-node-cluster-members],[data-node-cluster-sections]):empty{display:none}
@media(max-width:600px){.v2-server-page .v2-server-setup-steps ol{min-inline-size:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.v2-server-page .v2-server-setup-foot>*{flex:1 1 auto;justify-content:center;text-align:center}}
`
