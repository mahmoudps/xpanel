export const PANEL_DATABASES_CSS = `.v2-db-page{display:grid;gap:var(--space-4);min-inline-size:0}
.v2-db-workspace{display:grid;gap:var(--space-4);min-inline-size:0}
.v2-db-stack,.v2-db-form{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-db-columns{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-db-columns--stack,.v2-db-columns--strip{grid-template-columns:minmax(0,1fr)}.v2-db-columns--strip>aside{order:-1}.v2-db-columns--strip>aside .v2-db-check-list{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:var(--space-1) var(--space-4)}
.v2-db-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-db-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-db-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--space-2);margin:0}
.v2-db-facts>div{display:grid;gap:var(--space-1);min-inline-size:0}
.v2-db-facts :is(dt,dd){margin:0;text-align:start;overflow-wrap:anywhere}
.v2-db-facts dt{font-size:12px;color:var(--muted);text-box-trim:trim-end;text-box-edge:text}
.v2-db-facts dd{text-box-trim:trim-start;text-box-edge:text}
.v2-db-facts bdi{unicode-bidi:isolate}
.v2-db-workspace .v2-field{align-items:stretch;min-inline-size:0}
.v2-db-workspace .v2-field>label{text-align:start;text-box-trim:trim-end;text-box-edge:text}
.v2-db-workspace .v2-card p{font-size:13px;line-height:1.6}.v2-db-workspace .v2-card h3{font-size:14px}
.v2-db-columns .v2-db-table-region table{min-inline-size:0}.v2-db-columns .v2-db-table-region th{white-space:normal}
.v2-db-workspace :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-db-workspace :is(input,select,textarea):not([type=checkbox]){inline-size:100%;min-inline-size:0}
.v2-db-workspace :is(fieldset,legend){border:0;margin:0;padding:0;min-inline-size:0}
.v2-db-workspace fieldset{display:grid;gap:var(--space-2)}
.v2-db-workspace legend{margin-block-end:var(--space-1);font-weight:600}
.v2-db-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--space-2)}
.v2-db-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);min-inline-size:0}
.v2-db-check>input{flex:none;margin:0}
.v2-db-table-region{min-inline-size:0;max-inline-size:100%;overflow:auto}
.v2-db-table-region table{min-inline-size:840px}
.v2-db-table-region :is(th,td){padding:12px 16px;text-align:start;vertical-align:top}
.v2-db-table-region th{white-space:nowrap}
.v2-db-table-region bdi{display:inline-block;max-inline-size:100%;unicode-bidi:isolate;overflow-wrap:anywhere}
.v2-db-table-region .v2-db-actions{gap:var(--space-1)}
.v2-db-unread{color:var(--muted)}
.v2-db-table-region td[data-label]:empty{display:none}
@media(min-width:601px){.v2-db-table-region th:first-child{min-inline-size:180px}.v2-db-table-region :is(th,td){padding-inline:12px}.v2-db-table-region td[data-label]{white-space:nowrap}.v2-db-table-region td[data-label] bdi{white-space:nowrap}.v2-db-table-region td[data-label]:has(>[data-xp-slot=state]){white-space:normal}.v2-db-table-region .v2-db-actions>.v2-btn{padding-inline:10px;font-size:13px}.v2-db-table-region .v2-db-actions:has(>:nth-child(4)){display:grid;grid-template-columns:repeat(2,max-content);justify-content:start}}
@media(max-width:600px){.v2-db-table-region tr>td[data-label]{grid-column:1/-1!important;grid-row:auto!important;justify-self:stretch!important;display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2);text-align:end!important}
.v2-db-table-region td[data-label]::before{content:attr(data-label);max-inline-size:50%;font-size:12px;color:var(--muted);text-align:start}
.v2-db-table-region td[data-label]:has(.v2-btn){display:block}.v2-db-table-region td[data-label]:has(.v2-btn)::before{content:none}}
.v2-db-workspace .v2-card__body>.v2-btn,.v2-db-workspace .v2-card__body>div>.v2-btn{justify-self:start;align-self:flex-start}
.v2-db-workspace [data-db-wizard],.v2-db-workspace [data-db-wizard-step]:not([hidden]){display:grid;gap:var(--space-2);min-inline-size:0}
.v2-db-workspace [data-db-wizard] .v2-field{max-inline-size:480px}.v2-db-workspace [data-db-wizard-status]:empty{display:none}
.v2-db-notes{display:grid;gap:var(--space-1);color:var(--muted);line-height:1.6}
.v2-db-workspace [data-db-counts]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-2)}
.v2-db-workspace [data-db-counts]>div{display:grid;gap:var(--space-1);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow);min-inline-size:0}
.v2-db-workspace [data-db-counts] dt{font-size:13px;font-weight:600;color:var(--muted)}
.v2-db-workspace [data-db-counts] dd,.v2-db-workspace [data-db-counts] dd *{font-family:var(--font-sans);font-variant-numeric:tabular-nums}
.v2-db-workspace [data-db-counts] dd{font-size:26px;font-weight:600;line-height:1.2;letter-spacing:-.02em}
.v2-db-workspace [data-db-counts] dd:not(:has(bdi)){font-size:18px;line-height:31px;letter-spacing:0;color:var(--text-2)}
.v2-db-workspace .v2-code{overflow:auto}
.v2-db-workspace [data-dbu-secret-note]:empty{display:none}
.v2-db-workspace [data-db-grant-current],.v2-db-workspace [data-db-grant-preview]{overflow-wrap:anywhere;min-inline-size:0}
.v2-db-check-list{display:grid;gap:var(--space-2);margin:0;padding-inline-start:var(--space-3)}
.v2-db-code{margin:0;padding:var(--space-2);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:12px/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.v2-db-legend{display:flex;flex-wrap:wrap;gap:var(--space-1) var(--space-3);margin:0;padding:0;list-style:none;color:var(--muted);font-size:12px}
.v2-db-legend li{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-db-legend__mark{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:18px;block-size:18px;border-radius:50%;background:var(--sunken);color:var(--muted);font-weight:600}
.v2-db-legend__mark--granted{background:var(--ok-soft);color:var(--ok)}
@media(max-width:1100px){.v2-db-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:800px){.v2-db-workspace [data-db-counts]{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-db-fields,.v2-db-options{grid-template-columns:minmax(0,1fr)}.v2-db-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-db-workspace .v2-card:not(.v2-card--flush){padding:var(--space-2)}.v2-db-workspace [data-db-counts] dd{font-size:22px;overflow-wrap:anywhere}.v2-db-actions>.v2-btn{flex:1 1 auto}}
@media(min-width:601px){.v2-db-table-region #v2-db-remote-hosts{table-layout:fixed;inline-size:100%;min-inline-size:0}.v2-db-table-region #v2-db-remote-hosts td{white-space:normal}.v2-db-table-region #v2-db-remote-hosts th:nth-child(1){inline-size:18%}.v2-db-table-region #v2-db-remote-hosts th:nth-child(2){inline-size:26%}.v2-db-table-region #v2-db-remote-hosts th:nth-child(3){inline-size:16%}.v2-db-table-region #v2-db-remote-hosts th:nth-child(4){inline-size:14%}.v2-db-table-region #v2-db-remote-hosts th:nth-child(5){inline-size:12%}.v2-db-table-region #v2-db-remote-hosts th:nth-child(6){inline-size:14%}}
`
