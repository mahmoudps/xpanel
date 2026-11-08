export const V2_FILES_CSS = `.v2-files{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-file-controls{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
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
.v2-files [data-file-workspace-action]+[data-file-workspace-action]{margin-inline-start:var(--space-1)}
.v2-files .v2-file-purge{color:var(--bad);border-color:transparent;background:transparent}
.v2-file-details{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(0,1fr);gap:var(--space-3)}
.v2-file-editor{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-file-label{font-size:13px;font-weight:600}
.v2-files #jailed-code-editor{inline-size:100%;min-block-size:280px;white-space:pre;tab-size:2;text-align:match-parent;overflow:auto}
.v2-files #chmod-octal-input{text-align:match-parent}
.v2-file-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-files bdi{unicode-bidi:isolate;overflow-wrap:anywhere}
.v2-files .v2-file-time{unicode-bidi:isolate;white-space:nowrap;display:inline-block}
.v2-files [data-state=failed],.v2-files [data-state=uncertain]{color:var(--bad)}
.v2-files [data-trash-empty]{padding:var(--space-3);text-align:center}
.v2-files [data-trash-empty] h2{margin-block-end:var(--space-1)}
.v2-directory-privacy>[data-directory-privacy-preview-wrap]{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-directory-privacy [data-directory-privacy-preview]{display:block;direction:ltr;white-space:pre;overflow:auto;text-align:match-parent}
@media(max-width:1000px){.v2-file-browser,.v2-file-details{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-file-fields{grid-template-columns:minmax(0,1fr)}}
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
@media(max-width:600px){.v2-files[data-file-manager] .v2-file-view-details,.v2-files[data-file-manager] .v2-file-view-uploads,.v2-files[data-file-manager] .v2-file-view-closed{padding:var(--space-2)}.v2-files[data-file-manager] .v2-file-view-details dl{grid-template-columns:1fr}}
.v2-files[data-file-manager] .v2-file-browser{grid-template-columns:minmax(0,1fr)}
.v2-files[data-file-manager] .v2-file-details>div{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-files[data-file-manager] .v2-file-tree-disclosure{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-card)}
.v2-files[data-file-manager] [data-file-manager-table] tr[data-file-selected]{background:var(--accent-soft)}
`
