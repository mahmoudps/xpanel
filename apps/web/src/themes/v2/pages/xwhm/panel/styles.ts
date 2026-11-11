import { adminStyles } from '../server/common.ts'
export const WHM_PANEL_CSS = adminStyles('.v2-panel-page') + `.v2-panel-page .v2-panel-branding-asset{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-page [data-whm-whmcs-form]{gap:var(--space-4)}
.v2-panel-page #v2-panel-whmcs-plan-table td :is(input,select){inline-size:100%;min-inline-size:0}
.v2-panel-page #v2-panel-whmcs-plan-table td{vertical-align:middle}
@media(min-width:1280px){.v2-panel-page #v2-panel-token-table :is(th,td){padding-inline:8px}.v2-panel-page #v2-panel-token-table td *{overflow-wrap:break-word}.v2-panel-page #v2-panel-token-table ul{padding-inline-start:16px}}
.v2-panel-page .v2-panel-branding-preview{display:grid;place-items:center;inline-size:96px;block-size:56px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);overflow:hidden}
.v2-panel-page .v2-panel-branding-preview img{max-inline-size:100%;max-block-size:100%}
.v2-panel-page .v2-admin-warning{padding:var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-control);color:var(--bad);background:var(--bad-soft)}
.v2-panel-page .v2-panel-module-ops{display:flex;flex-direction:column;list-style:none;padding:0}
.v2-panel-page .v2-panel-module-ops li{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-block-size:var(--target);border-block-end:1px solid var(--line)}
.v2-panel-page .v2-card__body:has(>.v2-panel-branding-asset){display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:var(--space-3);align-items:start}
.v2-panel-page .v2-panel-data__tools{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--space-3);align-items:start}
.v2-panel-page .v2-panel-data__rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:var(--space-2) var(--space-4)}
.v2-panel-page [data-generation-rows] td:nth-child(2){min-inline-size:200px}
.v2-panel-page [data-generation-rows] td:is(:first-child,:nth-child(4),:last-child){white-space:nowrap}
.v2-panel-page [data-whm-languages-row]>th>span{display:block}
.v2-panel-page [data-whm-languages-row]>th>.v2-muted{font-size:12px;font-weight:400}
.v2-panel-page [data-whm-languages-row] .v2-admin-actions{gap:var(--space-1)}
.v2-panel-page [data-locale-copy-form]{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-panel-page [data-locale-copy-form] .v2-account-tool__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-panel-page [data-locale-copy-form] .v2-account-tool__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-panel-page [data-locale-copy-form] label{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-panel-page [data-locale-copy-form] :is(input,select){inline-size:100%;min-inline-size:0}
@media(max-width:900px){.v2-panel-page .v2-panel-data__tools{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-page .v2-admin-table :is(th,td){border-block-end:0}
.v2-panel-page .v2-admin-table tbody>tr{border-block-end:1px solid var(--line)}
.v2-panel-page td[data-phone-label]{grid-column:1/-1;display:flex;justify-content:space-between;gap:var(--space-2);text-align:end}
.v2-panel-page td[data-phone-label]::before{content:attr(data-phone-label);flex:none;font-size:13px;color:var(--muted);text-align:start}}
@media(max-width:640px){.v2-panel-page [data-locale-copy-form] .v2-account-tool__fields{grid-template-columns:minmax(0,1fr)}.v2-panel-page #v2-panel-token-scopes,.v2-panel-page #v2-panel-token-scopes :is(thead,tbody){display:block;inline-size:100%;min-inline-size:0}
.v2-panel-page #v2-panel-token-scopes tr{display:grid;grid-template-columns:minmax(0,1fr) 56px 56px;align-items:center;column-gap:var(--space-1);border-block-end:1px solid var(--line)}
.v2-panel-page #v2-panel-token-scopes tr>*{min-inline-size:0;padding:var(--space-1) 0;border:0}
.v2-panel-page #v2-panel-token-scopes thead th:nth-child(2){position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
.v2-panel-page #v2-panel-token-scopes tr>:nth-child(3){grid-area:1/2/3/3;text-align:center}
.v2-panel-page #v2-panel-token-scopes tr>:nth-child(4){grid-area:1/3/3/4;text-align:center}
.v2-panel-page #v2-panel-token-scopes tbody th{grid-area:1/1;padding-block-end:0}
.v2-panel-page #v2-panel-token-scopes tbody td:nth-child(2){grid-area:2/1;padding-block-start:0;font-size:12px;color:var(--muted)}
.v2-panel-page #v2-panel-token-scopes input[type=checkbox]{inline-size:20px;block-size:20px}}
.v2-panel-page [data-dev-result-fields]:empty{display:none}
`
