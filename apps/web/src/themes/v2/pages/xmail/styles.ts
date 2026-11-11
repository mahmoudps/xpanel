import { V2_MAIL_DYNAMIC_CSS } from './client-templates.ts'
const R = '.v2-shell[data-surface="xmail"]'

// The shared compose script paints the chips, toggles, feedback and discard confirmation it creates inline,
// with another theme's tokens: the rules for those elements repaint them, so they need !important.
export const V2_MAIL_CSS =`${R} .v2-page{max-inline-size:none}
${V2_MAIL_DYNAMIC_CSS}
${R} .v2-side{inline-size:264px}
${R} .v2-mail-search{display:flex;justify-content:flex-start;gap:12px;flex:1 1 280px;max-inline-size:520px;min-inline-size:0;padding-inline:14px;background:var(--subtle);color:var(--muted);font-weight:400}
${R} .v2-mail-search>input[type=search]{inline-size:100%}
${R} .v2-mail-navigation{display:flex;flex:1;flex-direction:column;gap:var(--space-3);min-block-size:0}
${R} .v2-mail-navigation ul{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0;margin:0}
${R} .v2-mail-folder{display:flex;align-items:center;gap:12px;min-inline-size:44px;min-block-size:44px;padding:0 12px;border-radius:10px;color:var(--nav-text);text-decoration:none;font-size:14px;font-weight:500;transition:background-color 140ms ease-out,color 140ms ease-out}
${R} a.v2-mail-folder:hover{background:var(--nav-2);color:#fff}
${R} .v2-mail-folder>.v2-icon{flex:none}
${R} .v2-mail-folder>[data-mail-count]{flex:none;min-inline-size:24px;padding:1px 8px;border-radius:var(--radius-pill);font-size:12px;font-variant-numeric:tabular-nums;text-align:center;color:var(--nav-muted)}
${R} .v2-mail-folder[aria-current=page]>[data-mail-count]{background:rgb(255 255 255/.2);color:var(--on-accent);font-weight:600}
${R} .v2-mail-folder>span:first-of-type{flex:1;min-inline-size:0;overflow-wrap:anywhere}
${R} .v2-mail-folder[aria-current=page],${R} a.v2-mail-folder[aria-current=page]:hover{background:var(--accent-fill);color:var(--on-accent);font-weight:600}
${R} .v2-mail-folder:not(a){color:var(--nav-muted)}
${R} .v2-mail-navigation__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1);padding-inline-start:12px}
${R} .v2-mail-navigation__head h2,${R} .v2-mail-storage h2{font-size:12px;color:var(--nav-muted);font-weight:600}
${R} .v2-mail-navigation__head .v2-btn{min-inline-size:44px;min-block-size:44px;padding-inline:12px;border-radius:8px;color:var(--nav-text);font-size:12px;transition:background-color 140ms ease-out,color 140ms ease-out}
${R} .v2-mail-navigation__head .v2-btn:hover{background:var(--nav-2);color:#fff}
${R} .v2-mail-tools{display:flex;flex-direction:column;gap:2px;padding-block-start:var(--space-2);border-block-start:1px solid var(--nav-line)}
${R} .v2-mail-tools summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-inline-size:44px;min-block-size:44px;padding-inline:12px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;list-style:none;transition:background-color 140ms ease-out,color 140ms ease-out}
${R} .v2-mail-tools summary::-webkit-details-marker{display:none}
${R} .v2-mail-tools summary:hover{background:var(--nav-2);color:#fff}
${R} .v2-mail-tools summary .v2-icon{transition:transform 140ms ease-out}
${R} .v2-mail-tools summary .v2-icon:dir(rtl){transform:scaleX(-1)}
${R} .v2-mail-tools details[open]>summary{color:#fff;font-weight:600}
${R} .v2-mail-tools details[open]>summary .v2-icon{transform:rotate(90deg)}
${R} .v2-mail-tools details[open]>summary .v2-icon:dir(rtl){transform:scaleX(-1) rotate(90deg)}
${R} .v2-mail-tools details>ul{margin-inline-start:20px;border-inline-start:1px solid var(--nav-line);padding:4px 0 8px;padding-inline-start:10px}
${R} .v2-mail-tools details>ul .v2-mail-folder{border-radius:8px;font-size:13px}
${R} .v2-mail-storage{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);margin-block-start:auto;padding:var(--space-2) 12px 0;border-block-start:1px solid var(--nav-line);font-size:12px;color:var(--nav-text)}
${R} .v2-mail-storage>bdi{color:#fff;font-variant-numeric:tabular-nums}
${R} .v2-mail-storage__track{align-self:stretch;block-size:6px;background:var(--nav-line);border-radius:3px;overflow:hidden}
${R} .v2-mail-storage__track>span{display:block;block-size:100%;background:var(--accent-fill)}
.v2-mail-inbox{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-mail-folder-feedback{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);padding:var(--space-1) var(--space-2);border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.v2-mail-folder-feedback:has(>[data-state=uncertain]){border-color:var(--warn-line);background:var(--warn-soft)}
.v2-mail-folder-feedback>[data-mail-folder-status]{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-mail-folder-feedback>[data-mail-folder-status]::before{content:"";flex:none;inline-size:8px;block-size:8px;border-radius:50%;background:var(--line-strong)}
.v2-mail-folder-feedback>[data-state=read]::before,.v2-mail-folder-feedback>[data-state=saved]::before{background:var(--ok)}
.v2-mail-folder-feedback>[data-state=reading]::before,.v2-mail-folder-feedback>[data-state=saving]::before{background:var(--accent)}
.v2-mail-folder-feedback>[data-state=failed]::before{content:none}
.v2-mail-folder-feedback>[data-state=uncertain]::before{background:var(--warn)}
.v2-mail-folder-feedback>[data-state=uncertain]{color:var(--text)}
.v2-mail-folder-feedback [data-mail-undo]>.v2-btn{border-color:var(--accent-line);color:var(--accent)}
.v2-mail-folder-feedback [data-mail-bulk-status]{font-size:13px;color:var(--text-2)}
.v2-mail-folder-feedback [hidden]{display:none}
.v2-mail-folder-feedback [data-mail-bulk]{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-mail-folder-feedback [data-mail-bulk-status]:empty{display:none}
.v2-mail-folder-feedback>p{flex:1 1 240px;font-size:13px;color:var(--text-2)}
.v2-mail-panes{display:grid;grid-template-columns:minmax(300px,1fr) minmax(0,1.618fr);gap:var(--space-2);align-items:stretch;min-inline-size:0;min-block-size:640px}
.v2-mail-list,.v2-mail-reader{border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-mail-list{display:flex;flex-direction:column;min-inline-size:0;overflow:hidden}
.v2-mail-list__head{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3) var(--space-3) var(--space-2);border-block-end:1px solid var(--line)}
.v2-mail-list__title{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) 12px}
.v2-mail-list__title h1{font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.01em;min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-list__title>.v2-btn{margin-inline-start:auto;border-color:var(--line-strong)}
.v2-mail-list__title [data-mail-count-summary]{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:var(--radius-pill);background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.v2-mail-list__title [data-mail-count-summary]:empty{display:none}
.v2-mail-list__search{position:relative}
.v2-mail-list__search>.v2-icon{position:absolute;inset-block-start:14px;inset-inline-start:14px;color:var(--muted);pointer-events:none}
.v2-mail-list__search>input[type=search]{inline-size:100%;padding-inline-start:42px}
.v2-mail-filters{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:var(--sunken)}
.v2-mail-filters>button{flex:1 1 auto;min-block-size:var(--target);min-inline-size:var(--target);padding-inline:12px;border:0;border-radius:8px;background:transparent;color:var(--text-2);font-size:13px;white-space:nowrap;cursor:pointer;transition:background-color 140ms ease-out,color 140ms ease-out,box-shadow 140ms ease-out}
.v2-mail-filters>button:hover:not(:disabled,[aria-pressed=true]){color:var(--text)}
.v2-mail-filters>button:disabled{color:var(--muted);cursor:not-allowed}
.v2-mail-filters>button[aria-pressed=true]{background:var(--surface);color:var(--text);font-weight:600;box-shadow:var(--shadow)}
.v2-mail-list [data-mail-list]{list-style:none;display:flex;flex-direction:column;padding:0;margin:0}
.v2-mail-row{display:flex;align-items:flex-start;gap:12px;inline-size:100%;min-block-size:44px;padding:14px var(--space-3);padding-inline-start:14px;border:0;border-block-end:1px solid var(--line);background:var(--surface);color:var(--text);font:inherit;text-align:start;cursor:pointer;transition:background-color 140ms ease-out}
.v2-mail-row:hover:not(:disabled,[aria-current=true]){background:var(--subtle)}
.v2-mail-row:focus-visible{outline-offset:-2px}
.v2-mail-row:disabled{cursor:default}
.v2-mail-row[aria-current=true]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.v2-mail-row[aria-current=true]:dir(rtl){box-shadow:inset -3px 0 0 var(--accent)}
.v2-mail-row__dot{flex:none;inline-size:8px;block-size:8px;border-radius:50%;margin-block-start:14px;background:transparent}
.v2-mail-row[aria-current=true] .v2-mail-row__avatar{background:var(--surface)}
.v2-mail-row[data-unread=true] .v2-mail-row__dot{background:var(--accent)}
.v2-mail-row__avatar{display:grid;place-items:center;flex:none;inline-size:36px;block-size:36px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:600;text-transform:uppercase}
.v2-mail-row__content{display:flex;flex-direction:column;gap:2px;flex:1;min-inline-size:0;font-size:14px}
.v2-mail-row__content>[data-mail-subject]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-mail-row__content [dir=auto],.v2-mail-reader__head :is(h2,[data-mail-detail-name]){text-align:match-parent;text-align:-webkit-match-parent}
.v2-mail-row__top{display:flex;align-items:baseline;gap:8px;justify-content:space-between;min-inline-size:0}
.v2-mail-row__top>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-mail-row__top time{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted)}
.v2-mail-row__time{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted);white-space:nowrap}
.v2-mail-row[data-unread=true] .v2-mail-row__time{color:var(--accent);font-weight:600}
.v2-mail-row__star,.v2-mail-row__clip{display:inline-flex;align-items:center}
.v2-mail-row[data-starred=false] .v2-mail-row__star,.v2-mail-row[data-attach="0"] .v2-mail-row__clip{display:none}
.v2-mail-row[data-starred=true] .v2-mail-row__star{color:var(--warn)}
.v2-mail-row[data-starred=true] .v2-mail-row__star svg{fill:currentColor}
.v2-mail-row[data-unread=true] :is([data-mail-name],[data-mail-subject]){font-weight:600}
.v2-mail-row__preview{font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-mail-row__attachments{display:inline-flex;align-items:center;gap:4px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.v2-mail-list__footer{display:flex;flex-wrap:wrap;align-items:center;gap:4px var(--space-1);margin-block-start:auto;padding:12px var(--space-3);border-block-start:1px solid var(--line);font-size:12px;font-variant-numeric:tabular-nums;line-height:1.6;color:var(--muted)}
.v2-mail-list__footer>[data-mail-action=load-older]{margin-inline-start:auto;min-inline-size:44px;min-block-size:44px;padding-inline:14px;font-size:13px}
.v2-mail-list__footer>[data-mail-action=load-older][hidden]{display:none}
.v2-mail-list__footer>span:last-child{flex-basis:100%}
.v2-mail-reader{display:flex;flex-direction:column;min-inline-size:0}
.v2-mail-reader .v2-mail-actions{gap:var(--space-1);padding:12px var(--space-3);border-block-end:1px solid var(--line)}
.v2-mail-reader .v2-mail-actions .v2-btn{min-inline-size:var(--target);padding-inline:14px;font-size:13px;transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out}
.v2-mail-reader .v2-mail-actions [data-mail-action=star]:not(:disabled,[aria-pressed=true]):hover{border-color:var(--warn-line);background:var(--warn-soft);color:var(--warn)}
.v2-mail-reader .v2-mail-actions [data-mail-action=star][aria-pressed=true]{border-color:var(--warn-line);background:var(--warn-soft);color:var(--warn)}
.v2-mail-reader .v2-mail-actions [data-mail-action=star][aria-pressed=true] svg{fill:currentColor}
.v2-mail-reader .v2-mail-actions [data-mail-reply] .v2-icon:dir(rtl){transform:scaleX(-1)}
.v2-mail-reader .v2-mail-actions :is([data-mail-action=delete],[data-mail-action=restore]){margin-inline-start:auto}
@media(max-width:1499px){.v2-mail-reader .v2-mail-actions .v2-mail-actions__minor{inline-size:var(--target);padding-inline:0}.v2-mail-actions__minor>.v2-mail-actions__label{position:absolute;inline-size:1px;block-size:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}}
@media(max-width:560px),(min-width:768px) and (max-width:1239px){.v2-mail-reader .v2-mail-actions .v2-btn{inline-size:var(--target);padding-inline:0}.v2-mail-reader .v2-mail-actions .v2-mail-actions__label{position:absolute;inline-size:1px;block-size:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.v2-mail-reader .v2-mail-actions{position:relative}.v2-mail-reader .v2-mail-move{position:static}.v2-mail-reader .v2-mail-move-menu{inset-block-start:calc(100% - 4px);inset-inline-start:var(--space-2)}}
.v2-mail-reader .v2-mail-actions [data-mail-action=delete]:not(:disabled){border-color:var(--bad-line);color:var(--bad)}
.v2-mail-reader .v2-mail-actions [data-mail-action=delete]:not(:disabled):hover{background:var(--bad-soft);border-color:var(--bad)}
.v2-mail-sender{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-1) 12px;min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-sender__who{display:flex;flex-direction:column;gap:4px;flex:1 1 220px;min-inline-size:0}
.v2-mail-sender__who>div{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px var(--space-1);font-size:14px}
.v2-mail-sender__who [data-mail-detail-name]{font-weight:600}
.v2-mail-sender__addr,.v2-mail-sender__who dd{font-family:var(--font-mono);font-size:13px;color:var(--text-2)}
.v2-mail-sender__addr:has(>bdi:empty),.v2-mail-sender__who dl>div:is([hidden],:has(>dd>bdi:empty)){display:none}
.v2-mail-sender__who dl{display:flex;flex-direction:column;gap:2px;margin:0}
.v2-mail-sender__who dl>div{display:flex;align-items:baseline;gap:var(--space-1);min-inline-size:0}
.v2-mail-sender__who dt{flex:none;font-size:13px;color:var(--muted)}
.v2-mail-sender__who dd{margin:0;min-inline-size:0}
.v2-mail-sender__date{flex:none;font-size:13px;font-variant-numeric:tabular-nums;line-height:21px;color:var(--muted)}
.v2-mail-sender>.v2-mail-row__avatar{inline-size:40px;block-size:40px;font-size:14px}
.v2-mail-move{position:relative}
.v2-mail-reader__head{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border-block-end:1px solid var(--line)}
.v2-mail-reader__head h2{font-size:18px;line-height:1.35;font-weight:600;letter-spacing:-.01em;overflow-wrap:anywhere}
.v2-mail-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0;margin:0}
.v2-mail-facts>div:is([hidden],:has(>dd>bdi:empty)){display:none}
.v2-mail-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-facts dt{font-size:12px;color:var(--muted);text-box-trim:trim-end;text-box-edge:text}
.v2-mail-facts dd{margin:0;font-size:13px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;text-box-trim:trim-start;text-box-edge:text}
.v2-mail-reader__head .v2-mail-facts dd{font-family:var(--font-mono);color:var(--text-2)}
.v2-mail-facts dd>bdi{unicode-bidi:isolate;text-align:start}
.v2-mail-auth{align-self:flex-start;padding:3px 10px;border-radius:var(--radius-pill);background:var(--sunken);font-size:12px;font-weight:600;color:var(--text-2)}
.v2-mail-auth:empty{display:none}
.v2-mail-remote-notice{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2);margin:var(--space-2) var(--space-3) 0;padding:12px 16px;border:1px solid var(--warn-line);border-radius:12px;background:var(--warn-soft);font-size:13px;color:var(--text)}
.v2-mail-remote-notice[hidden],.v2-mail-remote-images[hidden],.v2-mail-quick-reply[hidden],.v2-mail-quick-reply__status[hidden]{display:none}
.v2-mail-remote-notice__copy{display:inline-flex;align-items:center;gap:var(--space-1);flex:1 1 220px;min-inline-size:0}
.v2-mail-remote-notice__copy>.v2-icon{flex:none;color:var(--warn)}
.v2-mail-remote-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:var(--space-2);padding:0 var(--space-3) var(--space-3)}
.v2-mail-remote-images img{display:block;max-inline-size:100%;block-size:auto;border:1px solid var(--line);border-radius:8px;outline:1px solid rgb(0 0 0/.08);outline-offset:-1px;background:var(--sunken)}
[data-ui-theme="v2"][data-theme="dark"] .v2-mail-remote-images img{outline-color:rgb(255 255 255/.1)}
.v2-mail-reader__body{padding:var(--space-3);white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.6}
.v2-mail-reader__body[data-mail-body=pending]{color:var(--muted)}
.v2-mail-attachments{display:flex;flex-direction:column;gap:12px;margin-block-start:auto;padding:var(--space-3);border-block-start:1px solid var(--line)}
.v2-mail-quick-reply{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border-block-start:1px solid var(--line);border-end-start-radius:var(--radius-card);border-end-end-radius:var(--radius-card);background:var(--subtle)}
.v2-mail-quick-reply__label{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-quick-reply__heading{display:inline-flex;align-items:center;gap:6px;padding-inline:13px;font-size:13px;font-weight:600;color:var(--text-2)}
.v2-mail-quick-reply__heading .v2-icon:dir(rtl){transform:scaleX(-1)}
.v2-mail-quick-reply textarea{inline-size:100%;min-inline-size:0;padding:10px 12px;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:inherit;font-size:14px;line-height:1.5;resize:vertical}
.v2-mail-quick-reply textarea:disabled{background:var(--sunken);color:var(--muted)}
.v2-mail-quick-reply__foot{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-quick-reply__foot>[data-mail-action=quick-reply-send]{margin-inline-start:auto}
.v2-mail-quick-reply__status{font-size:12px;color:var(--text-2);overflow-wrap:anywhere}
.v2-mail-quick-reply__status[data-state=failed]{color:var(--bad)}
.v2-mail-quick-reply__status[data-state=sent]{color:var(--ok)}
.v2-mail-attachments h3{font-size:14px;font-weight:600;color:var(--text)}
.v2-mail-attachments [data-attachment-status]{font-size:13px;color:var(--muted)}
.v2-mail-attachments ul{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:12px;list-style:none;padding:0;margin:0}
.v2-mail-attachments ul:empty{display:none}
.v2-mail-attachments li{display:flex;min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-attachments li>.v2-btn{inline-size:100%;min-block-size:60px;justify-content:flex-start;border-color:var(--line);border-radius:12px;font-size:13px;font-weight:500}
.v2-mail-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;margin:var(--space-3);padding:40px var(--space-3);border:1px dashed var(--line-strong);border-radius:12px;color:var(--muted);font-size:13px;line-height:1.6;text-align:center}
.v2-mail-empty[data-mail-list-state=failed]{border-color:var(--bad-line);background:var(--bad-soft);color:var(--text)}
.v2-mail-reader .v2-mail-empty{flex:1 1 auto;margin:var(--space-3);padding-block:64px}
.v2-mail-empty h2{font-size:16px;font-weight:600;color:var(--text)}
.v2-mail-empty__icon{display:grid;place-items:center;inline-size:48px;block-size:48px;border-radius:50%;background:var(--sunken);color:var(--muted)}
.v2-mail-compose{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-mail-compose-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:var(--space-2) var(--space-3)}
.v2-mail-compose-head>div{display:flex;flex-direction:column;gap:var(--space-1);flex:1 1 320px;min-inline-size:0;max-inline-size:72ch}
.v2-mail-compose-head h1{font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.v2-mail-compose-head p{font-size:14px;color:var(--muted);overflow-wrap:anywhere}
.v2-mail-compose-head p[data-state=failed]{color:var(--bad)}
.v2-mail-compose-head .v2-icon:dir(rtl){transform:scaleX(-1)}
.v2-mail-compose__grid{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(300px,1fr);gap:var(--space-3);align-items:stretch;min-inline-size:0}
.v2-mail-compose-aside [data-mail-storage-card] .v2-card__actions{font-size:13px;font-variant-numeric:tabular-nums;color:var(--text-2)}
.v2-mail-compose-editor{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-mail-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2)}
.v2-mail-card-head h1{font-size:26px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.v2-mail-list__title h1:dir(rtl),.v2-mail-reader__head h2:dir(rtl),.v2-mail-compose-head h1:dir(rtl),.v2-mail-card-head h1:dir(rtl){letter-spacing:0}
.v2-mail-card-head h2{font-size:16px;font-weight:600}
.v2-mail-card-head h2>.v2-num{font-size:13px;font-weight:400;font-variant-numeric:tabular-nums;color:var(--muted)}
.v2-mail-card-head>p{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.v2-mail-card-head>p[data-state=failed]{color:var(--bad)}
.v2-mail-compose-fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--space-2);align-items:start}
.v2-mail-compose-fields>.v2-field{display:grid;grid-template-columns:subgrid;grid-column:1/-1;align-items:center;gap:var(--space-1) var(--space-2)}
.v2-mail-compose-fields>.v2-field>label{padding-inline:0;font-size:13px;font-weight:600}
.v2-mail-compose-fields>.v2-field>:is(input,select){inline-size:100%;min-inline-size:0}
.v2-mail-compose-fields>:is(.v2-mail-identity-tools,#recips-help){grid-column:2}
.v2-mail-compose-fields>#recips-help{margin-block-start:-8px;font-size:12px;line-height:1.6}
.v2-mail-recipient{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-inline-size:0;min-block-size:var(--target);padding:0;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface)}
.v2-mail-recipient:focus-within{outline:2px solid var(--focus);outline-offset:2px}
.v2-mail-recipient:has(input:disabled){background:var(--sunken);border-color:var(--line)}
.v2-mail-recipient:has(input[readonly]:not(:disabled)){background:var(--subtle)}
.v2-mail-recipient input{flex:1 1 160px;min-inline-size:120px;min-block-size:var(--target);padding:0 12px;border:0;border-radius:8px;background:transparent;font-family:var(--font-mono);font-size:13px;text-align:match-parent;text-align:-webkit-match-parent;outline:0}
.v2-mail-recipient>ul{order:-1;display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:6px;margin-inline-end:0}
.v2-mail-recipient>ul:empty{display:none}
.v2-mail-recipient [data-mail-chip]{min-block-size:32px!important;padding:0!important;padding-inline-start:10px!important;border:1px solid var(--line)!important;border-radius:8px!important;background:var(--sunken)!important;color:var(--text)!important}
.v2-mail-recipient [data-mail-chip][data-invalid=true]{border-color:var(--bad-line)!important;background:var(--bad-soft)!important}
.v2-mail-recipient [data-mail-chip]>span{color:var(--text)!important}
.v2-mail-recipient [data-mail-chip]>span:empty{display:none}
.v2-mail-recipient [data-mail-chip]>span:nth-of-type(2){direction:ltr;unicode-bidi:isolate;font-family:var(--font-mono)!important}
.v2-mail-recipient [data-mail-chip]>span:not(:empty)+span:nth-of-type(2){color:var(--muted)!important}
.v2-mail-recipient [data-mail-chip][data-invalid=true]>span{color:var(--bad)!important}
.v2-mail-recipient [data-mail-chip]>button{inline-size:var(--target)!important;block-size:var(--target)!important;padding:0;color:var(--muted)!important;font-size:18px;line-height:1;cursor:pointer}
.v2-mail-recipient [data-mail-chip]>button:hover{background:var(--line)!important;color:var(--text)!important}
.v2-mail-compose-editor>[data-mail-feedback]:not([hidden]){margin:0!important;padding:12px 16px!important;border:1px solid var(--warn-line)!important;border-radius:12px!important;background:var(--warn-soft)!important;font-size:14px!important;overflow-wrap:anywhere}
.v2-mail-compose-editor>[data-mail-feedback][role=alert]{border-color:var(--bad-line)!important;background:var(--bad-soft)!important}
.v2-mail-compose-footer>[data-mail-discard]:has(>span){padding:4px;padding-inline-start:12px;border:1px solid var(--bad-line);border-radius:12px;background:var(--bad-soft)}
.v2-mail-compose-footer>[data-mail-discard]>span{color:var(--bad)!important}
.v2-mail-compose-footer>[data-mail-discard]>:is(button,a):not(.v2-btn){border-radius:var(--radius-control)!important;cursor:pointer}
.v2-mail-compose-footer>[data-mail-discard]>[data-mail-action=discard-cancel]{border:1px solid var(--line-strong)!important;background:var(--surface)!important;color:var(--text)!important}
.v2-mail-compose-footer>[data-mail-discard]>a{border:1px solid var(--bad)!important;background:var(--surface)!important;color:var(--bad)!important}
.v2-mail-compose-footer>[data-mail-discard]>a:hover{background:var(--bad)!important;color:var(--surface)!important}
.v2-mail-editor{display:flex;flex-direction:column;flex:1 1 auto;min-inline-size:0;border:1px solid var(--line-strong);border-radius:12px;overflow:hidden}
.v2-mail-editor:has(>.v2-mail-editor-body:focus-visible){outline:2px solid var(--focus);outline-offset:2px}
.v2-mail-format{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:4px;border-block-end:1px solid var(--line);background:var(--subtle)}
.v2-mail-format .v2-btn{border-color:transparent!important;border-radius:8px;background:transparent!important;color:var(--text-2)!important;transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out}
.v2-mail-format .v2-btn:hover:not(:disabled){background:var(--sunken)!important;color:var(--text)!important}
.v2-mail-format .v2-btn[aria-pressed=true]{border-color:var(--accent-line)!important;background:var(--accent-soft)!important;color:var(--accent)!important}
@media(max-width:767px){.v2-mail-compose-aside>#filters>.v2-card__foot{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.v2-mail-compose-aside>#filters>.v2-card__foot>.v2-btn{min-inline-size:0;padding-inline:8px}}
.v2-mail-editor-body{flex:1 1 auto;min-block-size:300px;padding:var(--space-3);background:var(--surface);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;text-align:match-parent;text-align:-webkit-match-parent;outline:0}
.v2-mail-compose-attachments{display:flex;flex-direction:column;gap:12px}
.v2-mail-size-meter{display:flex;flex-direction:column;gap:var(--space-1);padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--subtle)}
.v2-mail-size-meter[data-tone=warn]{border-color:var(--warn-line);background:var(--warn-soft)}
.v2-mail-size-meter[data-tone=bad]{border-color:var(--bad-line);background:var(--bad-soft)}
.v2-mail-size-meter__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text-2)}
.v2-mail-size-meter__bar{appearance:none;-webkit-appearance:none;display:block;inline-size:100%;block-size:8px;border:0;border-radius:var(--radius-pill);background:var(--sunken);overflow:hidden;accent-color:var(--accent)}
.v2-mail-size-meter__bar::-webkit-progress-bar{background:var(--sunken);border-radius:var(--radius-pill)}
.v2-mail-size-meter__bar::-webkit-progress-value{background:var(--accent-fill);border-radius:var(--radius-pill);transition:inline-size 140ms ease-out}
.v2-mail-size-meter[data-tone=warn] .v2-mail-size-meter__bar{accent-color:var(--warn)}
.v2-mail-size-meter[data-tone=warn] .v2-mail-size-meter__bar::-webkit-progress-value{background:var(--warn)}
.v2-mail-size-meter[data-tone=bad] .v2-mail-size-meter__bar{accent-color:var(--bad)}
.v2-mail-size-meter[data-tone=bad] .v2-mail-size-meter__bar::-webkit-progress-value{background:var(--bad)}
.v2-mail-size-meter__bar::-moz-progress-bar{background:var(--accent-fill);border-radius:var(--radius-pill)}
.v2-mail-size-meter[data-tone=warn] .v2-mail-size-meter__bar::-moz-progress-bar{background:var(--warn)}
.v2-mail-size-meter[data-tone=bad] .v2-mail-size-meter__bar::-moz-progress-bar{background:var(--bad)}
.v2-mail-size-meter__note{margin:0;font-size:12px;font-variant-numeric:tabular-nums}
.v2-mail-compose-attachments>[data-compose-attachment-status]{font-size:12px;line-height:1.6;color:var(--muted)}
.v2-mail-compose-attachments>ul{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px;list-style:none;padding:0;margin:0}
.v2-mail-compose-attachments>ul>li{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--subtle);font-size:13px}
.v2-mail-compose-attachments>ul:empty{display:none}
.v2-mail-compose-footer{display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-mail-compose-footer>[data-mail-discard]{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1);margin-inline-end:auto}
.v2-mail-compose-footer [data-mail-action=discard-ask]:not(:disabled){color:var(--bad)!important}
.v2-mail-compose-footer [data-mail-action=discard-ask]:not(:disabled):hover{background:var(--bad-soft)!important}
.v2-mail-compose-footer>[data-mail-send]{padding-inline:22px}
.v2-mail-compose-footer>.v2-mail-actions{flex:1 1 200px;flex-direction:row-reverse;flex-wrap:nowrap;min-inline-size:0}
.v2-mail-compose-footer>.v2-mail-actions>[role=status]{flex:0 1 auto;min-inline-size:0;text-align:end}
.v2-mail-compose-footer>.v2-mail-actions>.v2-btn{flex:none}
.v2-mail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-actions [role=status]{max-inline-size:32ch;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.v2-mail-compose-aside{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-mail-compose-aside>.v2-card:last-child{flex:1;display:flex;flex-direction:column}
.v2-mail-compose-aside>.v2-card:last-child>.v2-card__body{flex:1}
.v2-mail-compose-aside .v2-mail-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-mail-compose-aside .v2-mail-facts>div:is(:nth-child(-n+3),:last-child:nth-child(even)){grid-column:1/-1}
.v2-mail-vacation{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow);min-inline-size:0}
.v2-mail-vacation p{font-size:13px;line-height:1.6;color:var(--muted)}
.v2-mail-vacation h3{font-size:14px;font-weight:600;color:var(--text)}
.v2-mail-vacation [data-vacation-requested]{display:inline-flex;align-items:center;padding:3px 10px;border-radius:var(--radius-pill);background:var(--sunken);color:var(--text-2);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.v2-mail-vacation>[data-vacation-open]{align-self:flex-end}
.v2-mail-vacation :is(input:not([type=checkbox]),textarea){inline-size:100%;min-inline-size:0}
.v2-mail-vacation .v2-field,.v2-mail-vacation .v2-field:has(textarea){max-inline-size:none}
.v2-mail-vacation input[type=number]{font-variant-numeric:tabular-nums}
.v2-mail-vacation textarea{padding-block:10px;line-height:1.6}
.v2-mail-vacation :is([data-vacation-panel],[data-vacation-form]){display:flex;flex-direction:column;gap:var(--space-2)}
.v2-mail-vacation [hidden]{display:none}
.v2-mail-vacation__dates{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2)}
.v2-mail-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:44px}
.v2-mail-vacation pre{margin:0;padding:var(--space-2);border:1px solid var(--line);border-radius:12px;background:var(--code,var(--nav));color:var(--code-text,var(--nav-text));font:12px/1.7 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;min-inline-size:0;direction:ltr;text-align:start}
.v2-mail-identity-tools{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-mail-identity-tools>p{font-size:12px;line-height:1.6;color:var(--muted)}
.v2-mail-identity-tools .v2-btn{font-size:13px;padding-inline:14px}
.v2-mail-rules{display:flex;flex-direction:column;gap:var(--space-1);list-style:none;padding:0;margin:0}
.v2-mail-rules>li{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--subtle)}
.v2-mail-rules h3{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.v2-mail-compose-aside .v2-card__body>p{font-size:13px;line-height:1.6;color:var(--muted)}
@media(max-width:1199px){.v2-mail-compose__grid{grid-template-columns:minmax(0,1fr)}.v2-mail-compose-aside{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}}
@media(max-width:959px){.v2-mail-inbox input,.v2-mail-compose :is(input,select,textarea,[contenteditable]){font-size:16px}}
@media(max-width:767px){.v2-mail-panes{grid-template-columns:minmax(0,1fr);min-block-size:0}.v2-mail-filters>button{min-block-size:44px}.v2-mail-reader .v2-mail-actions{padding-inline:var(--space-2)}.v2-mail-remote-notice{margin-inline:var(--space-2)}.v2-mail-remote-images{padding:0 var(--space-2) var(--space-2)}.v2-mail-empty{margin:var(--space-2)}.v2-mail-reader .v2-mail-empty{margin:var(--space-2);padding-block:40px}.v2-mail-compose-aside{display:flex;align-items:stretch}.v2-mail-compose-fields{grid-template-columns:minmax(0,1fr)}.v2-mail-compose-fields>.v2-field{display:flex;flex-direction:column;align-items:stretch}.v2-mail-compose-fields>.v2-field>label{padding-inline:13px;line-height:1.25}.v2-mail-compose-fields>:is(.v2-mail-identity-tools,#recips-help){grid-column:1}.v2-mail-compose-fields>#recips-help{margin-block-start:0}.v2-mail-editor-body{padding:var(--space-2)}.v2-mail-compose-footer>[data-mail-send]{flex:1 1 100%;order:3}.v2-mail-compose-editor,.v2-mail-vacation,.v2-mail-reader__head,.v2-mail-reader__body,.v2-mail-attachments,.v2-mail-quick-reply,.v2-mail-list__head{padding:var(--space-2)}.v2-mail-row,.v2-mail-list__footer{padding-inline:var(--space-2)}}
@media(prefers-reduced-motion:reduce){${R} .v2-mail-folder,${R} .v2-mail-navigation__head .v2-btn,${R} .v2-mail-tools summary,${R} .v2-mail-tools summary .v2-icon,.v2-mail-filters>button,.v2-mail-row,.v2-mail-reader .v2-mail-actions .v2-btn,.v2-mail-format .v2-btn,.v2-mail-size-meter__bar::-webkit-progress-value{transition:none}}
`
