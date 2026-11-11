export const V2_FILES_CSS = `.v2-files{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-file-controls{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0;padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-files .v2-file-controls [role=status]:empty{display:none}.v2-files .v2-file-controls [role=status]{font-size:13px}
.v2-file-views{display:flex;flex-wrap:wrap;gap:var(--space-1);border-block-end:1px solid var(--line)}
.v2-file-views>a{display:inline-flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);padding-inline:var(--space-2);border-block-end:2px solid transparent;color:var(--muted);text-decoration:none}
.v2-file-views>a[aria-current=page]{border-color:var(--accent-fill);color:var(--text);font-weight:600}
.v2-file-toolbar,.v2-file-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-file-location{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-file-location>span{display:inline-flex;direction:ltr;unicode-bidi:isolate;max-inline-size:100%;overflow:auto;white-space:nowrap}
.v2-file-browser{display:grid;grid-template-columns:minmax(180px,220px) minmax(0,1fr);gap:var(--space-3)}
.v2-file-tree,.v2-file-tree ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-file-tree li{overflow-wrap:anywhere}.v2-file-tree .v2-icon{margin-inline-end:var(--space-1)}
.v2-file-tree ul{margin-block-start:var(--space-2);padding-inline-start:var(--space-2)}
.v2-file-name{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-file-path{display:block;font-size:12px;color:var(--muted);margin-block-start:var(--space-1)}
.v2-files [data-file-manager-table]{min-inline-size:760px}
.v2-files .v2-table :is(th,td){text-align:start;vertical-align:top;padding-inline:var(--space-2)}
.v2-files .v2-table td:last-child{min-inline-size:180px}
.v2-files [data-file-workspace-action],.v2-files [data-directory-privacy-action]{display:inline-flex;align-items:center;justify-content:center;min-block-size:var(--target);padding:var(--space-1) 12px;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.v2-files [data-file-manager-table] td:last-child>.v2-btn{margin-block:2px;margin-inline-end:var(--space-1)}
.v2-files [data-file-manager-table] td:is(:nth-child(3),:nth-child(5),:nth-child(6)){white-space:nowrap}
@media(min-width:1200px){.v2-files [data-file-manager-table] :is(th,td){padding-inline:8px}.v2-files[data-file-manager=browse] [data-file-manager-table] td:last-child{min-inline-size:376px}.v2-files [data-file-manager-table] td:last-child>.v2-btn{padding-inline:8px}}
@media(min-width:601px){.v2-files [data-file-manager-table] :is(th,td):first-child{padding-inline-end:0}.v2-files [data-file-manager-table] td:last-child>.v2-btn{padding-inline:10px;font-size:13px}}
.v2-files[data-file-manager] .v2-file-tree-disclosure>summary::after{content:"";margin-inline-start:auto;inline-size:8px;block-size:8px;border-inline-end:2px solid var(--muted);border-block-end:2px solid var(--muted);transform:rotate(45deg)}.v2-files[data-file-manager] .v2-file-tree-disclosure[open]>summary::after{transform:rotate(-135deg)}
.v2-file-editor .v2-field>label:has(>input[type=checkbox]){display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);font-weight:400}
.v2-files .v2-file-purge{color:var(--bad);border-color:transparent;background:transparent}
.v2-file-details{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(0,1fr);gap:var(--space-3)}
.v2-file-editor{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-file-label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-files #jailed-code-editor{inline-size:100%;min-block-size:280px;white-space:pre;tab-size:2;text-align:match-parent;text-align:-webkit-match-parent;overflow:auto}
.v2-file-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-files bdi{unicode-bidi:isolate;overflow-wrap:anywhere}
.v2-files .v2-file-time{unicode-bidi:isolate;white-space:nowrap;display:inline-block}
.v2-files [data-state=failed],.v2-files [data-state=uncertain]{color:var(--bad)}
.v2-files [data-trash-empty]{padding:var(--space-3);text-align:center}
.v2-files [data-trash-empty] h2{margin-block-end:var(--space-1)}
.v2-directory-privacy>[data-directory-privacy-preview-wrap]{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-directory-privacy [data-directory-privacy-preview]{display:block;direction:ltr;white-space:pre;overflow:auto;text-align:match-parent;text-align:-webkit-match-parent}
@media(max-width:1000px){.v2-file-browser,.v2-file-details{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-file-fields{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-files [data-file-manager-table] tr>td[data-label]{grid-column:1/-1!important;grid-row:auto!important;justify-self:stretch!important;display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2);text-align:end!important}.v2-files [data-file-manager-table] td[data-label]::before{content:attr(data-label);font-size:12px;color:var(--muted);text-align:start}}
@media(max-width:600px){.v2-files [data-file-manager-table] tbody tr:has(>td:first-child input[type=checkbox]){padding-inline-start:60px}.v2-files [data-file-manager-table] tbody tr>td:first-child:has(input[type=checkbox]){grid-column:auto!important;grid-row:auto!important;inset-inline-start:8px!important}}
@media(max-width:600px){.v2-files[data-leech-protection] tr{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.v2-files[data-leech-protection] tr>:last-child{grid-column:1/-1}.v2-files[data-leech-protection] th:last-child{display:none}}
.v2-files[data-file-manager] .v2-file-view-controls,.v2-files[data-file-manager] .v2-file-view-details,.v2-files[data-file-manager] .v2-file-view-uploads,.v2-files[data-file-manager] .v2-file-view-side{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-files[data-file-manager] .v2-file-view-controls>label{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-files[data-file-manager] .v2-file-view-controls>div,.v2-files[data-file-manager] .v2-file-view-details>div{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.v2-files[data-file-manager] .v2-file-view-details,.v2-files[data-file-manager] .v2-file-view-uploads,.v2-files[data-file-manager] .v2-file-view-closed{padding:var(--space-3);border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.v2-files[data-file-manager] .v2-file-view-details :is(h2,dl,dd),.v2-files[data-file-manager] .v2-file-view-uploads h2,.v2-files[data-file-manager] .v2-file-view-closed h2{margin:0}
.v2-files[data-file-manager] .v2-file-view-details dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-files[data-file-manager] .v2-file-view-details dl>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-files[data-file-manager] .v2-file-view-details dd{overflow-wrap:anywhere}
.v2-files[data-file-manager] .v2-file-view-permissions{inline-size:100%;border-collapse:collapse}
.v2-files[data-file-manager] .v2-file-view-permissions :is(th,td){padding:var(--space-1);text-align:center;border-block-end:1px solid var(--line)}
.v2-files[data-file-manager] .v2-file-view-permissions th:first-child{text-align:start}
.v2-files[data-file-manager] .v2-file-view-uploads ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:var(--space-2)}
.v2-files[data-file-manager] .v2-file-view-upload{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:12px;min-inline-size:0}
.v2-files[data-file-manager] .v2-file-view-upload>bdi{overflow-wrap:anywhere}
.v2-files[data-file-manager] .v2-file-view-upload>[data-xp-slot=state],.v2-files[data-file-manager] .v2-file-view-progress{grid-column:1/-1}
.v2-files[data-file-manager] .v2-file-view-progress{block-size:6px;border:1px dashed currentColor;border-radius:999px;opacity:.7}
.v2-files[data-file-manager] [data-file-manager-table] :is(th,td):nth-child(3){text-align:end}
.v2-files[data-file-manager] [data-file-manager-table] td:first-child label,.v2-files[data-file-manager] [data-file-manager-table] th:first-child label{display:inline-flex;align-items:center;justify-content:center;min-inline-size:44px;min-block-size:44px}
.v2-files[data-file-manager] [data-file-manager-table] :is([data-xp-slot=kind],.v2-file-path){display:block;overflow-wrap:anywhere}
.v2-files[data-file-manager] [data-file-editor-panel][hidden],.v2-files[data-file-manager] [data-file-editor-closed][hidden],.v2-files[data-file-manager] [data-xp-slot=progress][hidden]{display:none!important}
@media(max-width:600px){.v2-files[data-file-manager] .v2-file-view-details,.v2-files[data-file-manager] .v2-file-view-uploads,.v2-files[data-file-manager] .v2-file-view-closed{padding:var(--space-2)}.v2-files[data-file-manager] table.v2-file-view-permissions tr{display:table-row!important}.v2-files[data-file-manager] table.v2-file-view-permissions :is(th,td){display:table-cell!important;padding:var(--space-1) 4px!important}.v2-files[data-file-manager] table.v2-file-view-permissions thead{position:static!important;inline-size:auto!important;block-size:auto!important;clip-path:none!important;display:table-header-group!important}}
.v2-files[data-file-manager] .v2-file-browser{grid-template-columns:minmax(0,1fr)}
.v2-files[data-file-manager] .v2-file-details>div{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-files[data-file-manager] .v2-file-tree-disclosure{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-files[data-file-manager] .v2-file-tree-disclosure>summary{display:flex;align-items:center;min-block-size:var(--target);font-weight:600;cursor:pointer}
.v2-files[data-file-manager] [data-file-manager-table] tr[data-file-selected]{background:var(--accent-soft)}
.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])){grid-template-columns:minmax(0,1fr)}
.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])) .v2-file-view-details dl{grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))}
.v2-files[data-file-manager] .v2-file-side__stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
@media(min-width:1001px){.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden]))>.v2-file-side{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-3);align-items:start}.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])) .v2-file-view-details{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:var(--space-2) var(--space-4);align-items:start}.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])) .v2-file-view-details>:not(dl,table){grid-column:1/-1}.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])) .v2-file-view-details dl{grid-template-columns:repeat(3,minmax(0,1fr))}.v2-files[data-file-manager] .v2-file-details:has(>div>[data-file-editor-closed]:not([hidden])) .v2-file-side__stack{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}}
.v2-files[data-file-manager] .v2-file-view-details>h2,.v2-files[data-file-manager] .v2-file-view-uploads>h2{font-size:16px}
.v2-files[data-file-manager] .v2-file-view-details dt{font-size:12px;color:var(--muted)}.v2-files[data-file-manager] .v2-file-view-details dd{font-size:13px}
.v2-files[data-file-manager] .v2-file-view-permissions{font-size:13px}.v2-files[data-file-manager] .v2-file-view-permissions caption{padding-block-end:var(--space-1);font-size:13px;font-weight:600;text-align:start}
.v2-files[data-file-manager] .v2-file-view-permissions thead th{font-size:12px;color:var(--muted);background:var(--subtle)}
.v2-files[data-file-manager] .v2-file-view-uploads{display:flex;flex-direction:column;gap:var(--space-1)}.v2-files[data-file-manager] .v2-file-view-uploads>p{font-size:13px;color:var(--muted)}.v2-files[data-file-manager] .v2-file-view-uploads>ul:empty{display:none}
.v2-files[data-file-manager] .v2-file-tree-disclosure>.v2-card{margin-block-start:var(--space-1);padding:0;border:0;box-shadow:none;background:transparent}
.v2-files[data-file-manager]~[data-image-tools] .v2-panel-operation-fields,.v2-files[data-file-manager]~* .v2-panel-operation-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--space-2);align-items:start}
.v2-files[data-file-manager]~[data-html-editor] .v2-field{max-inline-size:560px}
.v2-files[data-file-manager]~[data-html-editor] .v2-panel-operation-actions{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-files[data-file-manager] .v2-file-view-closed{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}.v2-files[data-file-manager] .v2-file-view-closed>h2{flex:1 1 auto;font-size:16px}
.v2-files[data-file-manager] .v2-file-view-controls{flex-flow:row wrap;align-items:flex-end;gap:var(--space-2) var(--space-3)}
.v2-files[data-file-manager] .v2-file-view-controls>label{flex:1 1 240px;max-inline-size:360px;font-size:13px;font-weight:600}
.v2-files[data-file-manager] .v2-file-view-controls>label>input{inline-size:100%;font-weight:400}
.v2-files[data-file-manager] .v2-file-view-controls>div{font-size:13px;color:var(--text-2)}
.v2-files[data-file-manager] .v2-file-view-controls>p:not(:empty){flex-basis:100%;font-size:13px;color:var(--muted)}
.v2-directory-privacy-users{display:flex;flex-direction:column;gap:16px}
.v2-directory-privacy-user{display:flex;flex-wrap:wrap;align-items:end;gap:16px}
.v2-directory-privacy-user>.v2-field{flex:1 1 8rem;display:flex;flex-direction:column;gap:8px;min-inline-size:0}.v2-directory-privacy-user>.v2-field:has(input){flex-basis:12rem}
.v2-leech-stack{display:flex;flex-direction:column;align-items:flex-start;gap:8px;min-inline-size:0;overflow-wrap:anywhere}
.v2-files iframe[data-html-frame]{inline-size:100%;min-block-size:320px;border:1px solid var(--line-strong);border-radius:8px}
@media(max-width:600px){.v2-directory-privacy table:has(>[data-directory-privacy-rows]){display:block;min-inline-size:0!important}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>tbody{display:block}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>tbody>tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);padding:var(--space-2);border-block-start:1px solid var(--line)}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>tbody>tr:first-child{border-block-start:0}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>tbody>tr>td{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0;padding:0;border:0}.v2-directory-privacy table:has(>[data-directory-privacy-rows])>tbody>tr>td:is(:first-child,:last-child,[colspan]),.v2-directory-privacy [data-directory-privacy-rows]>tr>td:nth-child(3){grid-column:1/-1}.v2-directory-privacy [data-directory-privacy-rows] td[data-label]::before{content:attr(data-label);font-size:12px;color:var(--muted)}.v2-directory-privacy [data-directory-privacy-rows] td>*{max-inline-size:100%}}
`
