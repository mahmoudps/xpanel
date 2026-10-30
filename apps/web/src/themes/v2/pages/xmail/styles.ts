import { V2_MAIL_DYNAMIC_CSS } from './client-templates.ts'
const R = '.v2-shell[data-surface="xmail"]'

export const V2_MAIL_CSS = `${R} .v2-page{max-inline-size:none}
${V2_MAIL_DYNAMIC_CSS}
${R} .v2-side{inline-size:264px}
${R} .v2-mail-search{display:flex;flex:1 1 280px;max-inline-size:520px;min-inline-size:0}
${R} .v2-mail-search>input[type=search]{inline-size:100%}
${R} .v2-mail-navigation{display:flex;flex:1;flex-direction:column;gap:var(--space-3);min-block-size:0}
${R} .v2-mail-navigation ul{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0;margin:0}
${R} .v2-mail-folder{display:flex;align-items:center;gap:12px;min-block-size:44px;padding:0 12px;border-radius:8px;color:var(--nav-text);text-decoration:none;font-size:14px}
${R} .v2-mail-folder>span:first-of-type{flex:1;min-inline-size:0;overflow-wrap:anywhere}
${R} .v2-mail-folder[aria-current=page]{background:var(--accent-fill);color:var(--on-accent);font-weight:600}
${R} .v2-mail-folder:not(a){color:var(--nav-muted)}
${R} .v2-mail-navigation__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1);padding-inline:12px}
${R} .v2-mail-navigation__head h2,${R} .v2-mail-storage h2{font-size:12px;color:var(--nav-muted);font-weight:600}
${R} .v2-mail-navigation__head .v2-btn{min-block-size:44px;padding-inline:8px;color:var(--nav-text)}
${R} .v2-mail-tools{display:flex;flex-direction:column;gap:var(--space-1)}
${R} .v2-mail-tools summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-block-size:44px;padding-inline:12px;cursor:pointer;font-size:14px;font-weight:500}
${R} .v2-mail-tools details[open]>summary .v2-icon{transform:rotate(90deg)}
${R} .v2-mail-tools details>ul{margin-inline-start:20px;border-inline-start:1px solid var(--nav-line);padding-inline-start:10px}
${R} .v2-mail-storage{display:flex;flex-direction:column;gap:var(--space-1);margin-block-start:auto;padding-block-start:var(--space-2);border-block-start:1px solid var(--nav-line);font-size:12px;color:var(--nav-text)}
${R} .v2-mail-storage__track{block-size:6px;background:var(--nav-line);border-radius:3px;overflow:hidden}
${R} .v2-mail-storage__track>span{display:block;block-size:100%;background:var(--accent-fill)}
.v2-mail-inbox{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-mail-folder-feedback{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-folder-feedback>p{flex:1 1 240px;font-size:13px;color:var(--muted)}
.v2-mail-panes{display:grid;grid-template-columns:minmax(280px,1.618fr) minmax(0,2.618fr);min-inline-size:0;min-block-size:680px;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-mail-list{display:flex;flex-direction:column;min-inline-size:0;border-inline-end:1px solid var(--line)}
.v2-mail-list__head{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border-block-end:1px solid var(--line)}
.v2-mail-list__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-mail-list__title h1{font-size:20px;flex:1;min-inline-size:0}
.v2-mail-list__title [data-mail-count-summary]{color:var(--muted);font-size:12px}
.v2-mail-filters{display:flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:10px;background:var(--sunken);inline-size:fit-content}
.v2-mail-filters>button{min-block-size:44px;padding-inline:12px;border:0;border-radius:8px;background:transparent;color:var(--text-2);font-size:13px;cursor:pointer}
.v2-mail-filters>button[aria-pressed=true]{background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow)}
.v2-mail-list [data-mail-list]{list-style:none;display:flex;flex-direction:column;padding:0;margin:0}
.v2-mail-row{display:flex;align-items:flex-start;gap:12px;inline-size:100%;min-block-size:112px;padding:var(--space-2) var(--space-3);border:0;border-block-end:1px solid var(--line);background:var(--surface);color:var(--text);text-align:start;cursor:pointer}
.v2-mail-row[aria-current=true]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.v2-mail-row[aria-current=true]:dir(rtl){box-shadow:inset -3px 0 0 var(--accent)}
.v2-mail-row__dot{flex:none;inline-size:6px;block-size:6px;border-radius:50%;margin-block-start:7px;background:transparent}
.v2-mail-row[data-unread=true] .v2-mail-row__dot{background:var(--accent)}
.v2-mail-row__avatar{display:grid;place-items:center;flex:none;inline-size:34px;block-size:34px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600}
.v2-mail-row__content{display:flex;flex-direction:column;gap:4px;flex:1;min-inline-size:0;font-size:13px;overflow-wrap:anywhere}
.v2-mail-row__top{display:flex;align-items:baseline;gap:8px;justify-content:space-between;min-inline-size:0}
.v2-mail-row__top>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-mail-row__top time{flex:none;font-size:11px;color:var(--muted)}
.v2-mail-row__time{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);white-space:nowrap}
.v2-mail-row[data-attach="0"] .v2-mail-row__time>.v2-icon{display:none}
.v2-mail-row[data-unread=true] :is([data-mail-name],[data-mail-subject]){font-weight:600}
.v2-mail-row__preview{color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.v2-mail-row__attachments{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:11px}
.v2-mail-list__footer{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);margin-block-start:auto;padding:var(--space-2) var(--space-3);font-size:12px;color:var(--muted)}
.v2-mail-list__footer>span:last-child{flex-basis:100%}
.v2-mail-reader{display:flex;flex-direction:column;min-inline-size:0}
.v2-mail-reader>.v2-mail-actions{padding:var(--space-2) var(--space-3);border-block-end:1px solid var(--line)}
.v2-mail-sender{display:flex;align-items:center;gap:12px}
.v2-mail-move{position:relative}
.v2-mail-reader__head{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-3);border-block-end:1px solid var(--line)}
.v2-mail-reader__head h2{font-size:20px;overflow-wrap:anywhere}
.v2-mail-facts{display:grid;gap:var(--space-2);min-inline-size:0;margin:0}
.v2-mail-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-facts dt{font-size:12px;color:var(--muted)}
.v2-mail-facts dd{margin:0;font-size:13px;overflow-wrap:anywhere}
.v2-mail-facts dd>bdi{unicode-bidi:isolate;text-align:start}
.v2-mail-auth{font-size:12px;color:var(--text-2)}
.v2-mail-reader__body{padding:var(--space-3);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
.v2-mail-attachments{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border-block-start:1px solid var(--line)}
.v2-mail-attachments ul{display:flex;flex-direction:column;gap:var(--space-2);list-style:none;padding:0;margin:0}
.v2-mail-attachments li{display:flex;align-items:center;gap:var(--space-2);min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-empty{display:flex;flex-direction:column;align-items:center;gap:var(--space-2);padding:var(--space-4) var(--space-3);color:var(--muted);text-align:center}
.v2-mail-compose{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-mail-compose-editor{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-mail-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2)}
.v2-mail-card-head h1{font-size:20px}
.v2-mail-card-head>p{font-size:12px;color:var(--muted)}
.v2-mail-compose-fields{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-mail-recipient{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-recipient input{inline-size:100%;text-align:start}
.v2-mail-recipient>ul{display:flex;flex-wrap:wrap;gap:var(--space-1);list-style:none;padding:0;margin:0}
.v2-mail-recipient>ul:empty{display:none}
.v2-mail-format{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px;border:1px solid var(--line);border-radius:10px;background:var(--subtle)}
.v2-mail-format .v2-btn{border-color:transparent;background:transparent}
.v2-mail-editor-body{min-block-size:300px;padding:var(--space-2);border:1px solid var(--line-strong);border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
.v2-mail-field-label{font-size:13px;font-weight:600}
.v2-mail-compose-attachments{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-mail-compose-attachments>ul{display:flex;flex-direction:column;gap:var(--space-2);list-style:none;padding:0;margin:0}
.v2-mail-compose-attachments>ul:empty{display:none}
.v2-mail-compose-footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-mail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-actions [role=status]{max-inline-size:32ch;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.v2-mail-compose-aside{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-mail-vacation{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);min-inline-size:0}
.v2-mail-vacation :is([data-vacation-panel],[data-vacation-form]){display:flex;flex-direction:column;gap:var(--space-3)}
.v2-mail-vacation__dates{display:grid;grid-template-columns:minmax(0,1fr);gap:var(--space-2)}
.v2-mail-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:44px}
.v2-mail-vacation pre{padding:var(--space-2);border-radius:8px;background:var(--nav);color:var(--nav-text);white-space:pre-wrap;overflow-wrap:anywhere;min-inline-size:0;direction:ltr;text-align:start}
.v2-mail-identity-tools{display:flex;flex-direction:column;gap:var(--space-2)}
.v2-mail-rules{display:flex;flex-direction:column;gap:var(--space-3);list-style:none;padding:0;margin:0}
.v2-mail-rules>li{display:flex;flex-direction:column;gap:var(--space-2)}
@media(max-width:1199px){.v2-mail-compose{grid-template-columns:minmax(0,1fr)}.v2-mail-compose-aside{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:767px){.v2-mail-panes{grid-template-columns:minmax(0,1fr)}.v2-mail-list{border-inline-end:0;border-block-end:1px solid var(--line)}.v2-mail-compose-aside{display:flex}.v2-mail-compose-editor,.v2-mail-vacation,.v2-mail-reader__head,.v2-mail-reader__body,.v2-mail-attachments,.v2-mail-list__head{padding:var(--space-2)}.v2-mail-row,.v2-mail-list__footer{padding-inline:var(--space-2)}.v2-mail-inbox input,.v2-mail-compose :is(input,select,textarea,[contenteditable]){font-size:16px}}
`
