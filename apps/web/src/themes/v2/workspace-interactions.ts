// Workspace interaction styles: operations dock, sticky unsaved-changes save bar,
// multi-step wizard navigation, file dropzones, sortable handles, table pagination,
// password strength indicator, cron preview, and skeleton shimmer.

export const WORKSPACE_INTERACTIONS_CSS = `.v2-skeleton-block{display:inline-block;border-radius:6px;background:linear-gradient(90deg,var(--sunken) 25%,var(--subtle) 50%,var(--sunken) 75%);background-size:200% 100%;animation:v2-shimmer 1.4s ease-in-out infinite}
@keyframes v2-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.v2-ops-dock{position:fixed;bottom:16px;inset-inline-start:16px;z-index:85;display:flex;flex-direction:column;gap:8px;inline-size:min(380px,calc(100vw - 32px));max-block-size:50dvh;overflow-y:auto}
@media(min-width:960px){.v2-ops-dock{inset-inline-start:280px}}
.v2-ops-item{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:var(--radius-notice);background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--v2-elev)}
.v2-ops-item[data-ops-state="running"]{border-inline-start:3px solid var(--accent-fill)}
.v2-ops-item[data-ops-state="succeeded"]{border-inline-start:3px solid var(--ok)}
.v2-ops-item[data-ops-state="failed"]{border-inline-start:3px solid var(--bad)}
.v2-ops-item__head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.v2-ops-item__title{font-size:13px;font-weight:600;color:var(--text);min-inline-size:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v2-ops-item__meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
.v2-ops-item__bar{height:6px;border-radius:3px;background:var(--sunken);overflow:hidden}
.v2-ops-item__fill{display:block;height:100%;border-radius:3px;background:var(--accent-fill);transition:inline-size .2s ease-out}
.v2-ops-item[data-ops-state="succeeded"] .v2-ops-item__fill{background:var(--ok)}
.v2-ops-item[data-ops-state="failed"] .v2-ops-item__fill{background:var(--bad)}
.v2-ops-item__log{margin:0;padding:8px 10px;border-radius:var(--radius-chip);background:var(--code);color:var(--code-text);font:12px/1.5 var(--font-mono);max-block-size:140px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-save-bar{position:sticky;bottom:16px;z-index:45;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;border-radius:var(--radius-card);background:var(--nav);color:var(--nav-strong);border:1px solid var(--nav-line);box-shadow:var(--v2-elev)}
.v2-save-bar__info{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600}
.v2-save-bar__dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
.v2-save-bar__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.v2-save-bar .v2-btn:not(.v2-btn--primary){background:var(--nav-2);border-color:var(--nav-line);color:var(--nav-strong)}
.v2-save-bar .v2-btn:not(.v2-btn--primary):hover{background:var(--nav-line)}
.v2-wizard-nav{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px var(--v2-panel-padding);border-radius:var(--radius-card);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.v2-wizard-panel[data-wizard-hidden="true"],[data-ui-theme="v2"] [data-wizard-step][data-wizard-hidden="true"]{display:none}
.v2-dropzone{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-block-size:112px;padding:16px 20px;border-radius:var(--radius-card);border:2px dashed var(--line-strong);background:var(--subtle);color:var(--text-2);text-align:center;cursor:pointer;transition:border-color .15s,background-color .15s}
.v2-dropzone:hover,.v2-dropzone[data-drag-over="true"]{border-color:var(--accent-fill);background:var(--accent-soft);color:var(--accent)}
.v2-dropzone__title{font-size:14px;font-weight:600;color:var(--text)}
.v2-dropzone__hint{font-size:12px;color:var(--muted)}
.v2-dropzone__queue{display:flex;flex-direction:column;gap:8px;inline-size:100%;margin-top:8px}
.v2-dropzone__file{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-radius:var(--radius-control);border:1px solid var(--line);background:var(--surface);text-align:start;font-size:12px}
.v2-dropzone__file-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.v2-sort-item[data-dragging="true"]{opacity:.55;background:var(--accent-soft);outline:2px solid var(--accent-fill)}
.v2-sort-item[data-drag-target="true"]{border-top:2px solid var(--accent-fill)}
.v2-pagination-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px var(--v2-panel-padding);border-top:1px solid var(--line);background:var(--subtle);font-size:13px;color:var(--muted)}
.v2-pagination-bar__controls{display:inline-flex;align-items:center;gap:6px}
.v2-field-check{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.v2-field-check[data-check="ok"]{color:var(--ok)}.v2-field-check[data-check="bad"]{color:var(--bad)}.v2-field-check[data-check="checking"]{color:var(--muted)}
.v2-password-meter{display:flex;flex-direction:column;gap:4px}
.v2-password-meter__track{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;height:5px}
.v2-password-meter__seg{border-radius:3px;background:var(--sunken);transition:background-color .15s}
.v2-password-meter[data-strength="1"] .v2-password-meter__seg:nth-child(1){background:var(--bad)}
.v2-password-meter[data-strength="2"] .v2-password-meter__seg:nth-child(-n+2){background:var(--warn)}
.v2-password-meter[data-strength="3"] .v2-password-meter__seg:nth-child(-n+3){background:var(--accent-fill)}
.v2-password-meter[data-strength="4"] .v2-password-meter__seg{background:var(--ok)}
.v2-password-meter__label{font-size:12px;color:var(--muted)}
.v2-cron-preview{display:inline-flex;align-items:center;gap:6px;margin-top:4px;padding:4px 10px;border-radius:var(--radius-chip);background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600}
.v2-nav-progress{position:fixed;top:0;inset-inline:0;z-index:110;height:2.5px;background:var(--accent-fill);transform-origin:0 50%;opacity:0;pointer-events:none;transition:opacity .15s}
.v2-nav-progress[data-loading="true"]{opacity:1}
[data-ui-theme="v2"] :is([id],section,h1,h2,h3){scroll-margin-block-start:72px}
.v2-side__collapse{border-color:var(--nav-line);background:transparent;color:var(--nav-text)}
.v2-side__collapse:hover{background:var(--nav-2);color:var(--nav-strong)}
@media(max-width:959px){.v2-side__collapse{display:none}}
.v2-tz{display:flex;flex-direction:column;gap:var(--space-1);padding:8px 10px;border-block:1px solid var(--line)}
.v2-tz>label{padding-inline:13px;font-size:12px;font-weight:600;color:var(--muted)}
@media(min-width:960px){.v2-shell[data-sidebar-collapsed="true"]>.v2-side{flex:0 0 72px;inline-size:72px;padding-inline:10px}.v2-shell[data-sidebar-collapsed="true"] :is(.v2-brand__text,.v2-ctx,.v2-nav summary>span,.v2-nav__chev,.v2-nav details>ul,.v2-side__foot){display:none}.v2-shell[data-sidebar-collapsed="true"] .v2-side__top{flex-direction:column;gap:6px}.v2-shell[data-sidebar-collapsed="true"] .v2-nav summary{justify-content:center;padding-inline:0}.v2-shell[data-sidebar-collapsed="true"] .v2-side__collapse svg{transform:rotate(180deg)}.v2-shell[data-sidebar-collapsed="true"] .v2-ops-dock{inset-inline-start:88px}}
`
