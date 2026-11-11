import { V2_PANEL_STORE_ROUTES } from '../store/index.ts'

/** Routes of the account software pages that load this sheet beside the shared settings sheet. */
export const PANEL_SOFTWARE_PAGES_ROUTES: readonly string[] = Object.freeze(['/software/php', '/software/optimize', ...V2_PANEL_STORE_ROUTES])

const P = '.v2-panel-php'
const S = '.v2-panel-settings[data-v2-settings-route^="/software/"]'
/** Page rules of PHP, Optimize and the application store; the shared settings sheet stays the base. */
export const PANEL_SOFTWARE_PAGES_CSS = `.v2-panel-settings .v2-card--flush,.v2-panel-settings .v2-card--flush>.v2-card__body{gap:0}
.v2-panel-settings .v2-card--flush>.v2-card__head{padding-block-end:var(--space-2)}
.v2-panel-settings .v2-card--flush .v2-panel-settings__table{border-block-start:1px solid var(--line)}
.v2-panel-settings .v2-card--flush .v2-panel-settings__table :is(th,td):first-child{padding-inline-start:var(--v2-panel-padding)}
.v2-panel-settings .v2-card--flush .v2-panel-settings__table :is(th,td):last-child{padding-inline-end:var(--v2-panel-padding)}
.v2-panel-settings form${P}{gap:var(--space-3)}
${P} .v2-panel-settings__split{grid-template-columns:minmax(0,1fr) minmax(300px,400px)}
${P} .v2-panel-settings__split>.v2-panel-settings__groups{gap:var(--space-3)}
${P}-status__top{display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--space-3);padding:20px}
${P}-status__tile{flex:1 1 280px;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
${P}-status__tile>div{display:flex;align-items:center;gap:10px;min-inline-size:0}
${P}-status__tile>div>span{flex:none;inline-size:10px;block-size:10px;border-radius:50%;border:2px solid var(--muted)}
${P}-status__tile h2{font-size:16px;font-weight:600;overflow-wrap:anywhere;min-inline-size:0}
${P}-status__tile p{font-size:14px;line-height:1.5}
${P}-status__tile p+p{font-size:12px;color:var(--text-2)}
${P}-status__fields{flex:999 1 420px;min-inline-size:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,170px),1fr));gap:var(--space-2);align-items:start}
${P}-status__fields select[dir=ltr]{font-family:var(--font-mono);font-size:13px}
${P}-status__running{display:flex;flex-direction:column;gap:12px;padding:var(--space-2) 20px 20px;border-block-start:1px solid var(--line)}
${P}-status__running h3{font-size:13px;font-weight:600}
${P} .v2-panel-settings__facts{grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))}
${P} .v2-panel-settings__facts>div{padding-inline-start:12px;border-inline-start:1px solid var(--line);gap:4px}
${P} .v2-panel-settings__facts dd{font-size:13px;font-weight:500;line-height:1.5}
${P}-tabs>.v2-tabs{padding-inline:var(--space-2)}
${P}-tabs>.v2-tabs>[role=tab]{min-block-size:52px}
${P}-tabs>.v2-tabpanel{gap:var(--space-3);padding:var(--v2-panel-padding)}
${P}-tabs>.v2-tabpanel[hidden]{display:none}
${P}-tabs>.v2-tabpanel[hidden]:has(:invalid){display:flex!important;border-block-start:1px solid var(--line)}
${P}-tabs :is(input,select):invalid{border-color:var(--bad)}
${P}-tabs:has(#v2-php-runtime :invalid) #v2-php-tab-runtime,${P}-tabs:has(#v2-php-pool :invalid) #v2-php-tab-pool,${P}-tabs:has(#v2-php-ini :invalid) #v2-php-tab-ini{color:var(--bad);box-shadow:inset 0 -2px 0 var(--bad)}
${P}-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2)}
${P}-head>div{display:flex;flex-direction:column;gap:4px;min-inline-size:0}
${P}-head h2{font-size:16px;font-weight:600}
${P}-head p{font-size:13px;color:var(--muted);line-height:1.6}
${P} .v2-field>label{font-size:13px;font-weight:600}
${P}-tabs .v2-panel-settings__fields{gap:var(--space-2) var(--space-3)}
${P}-tabs .v2-panel-settings__fields label:not([for$=IdleTimeoutSec]),${P}-tabs .v2-panel-settings__table th[scope=row]{font-family:var(--font-mono)}
${P}-tabs .v2-field>:is(input,.v2-select){inline-size:100%}
${P}-unit{display:flex;align-items:stretch;min-inline-size:0}
${P}-unit>input{flex:1 1 auto;inline-size:0;font-family:var(--font-mono);font-size:13px}
${P}-unit>input:not(:last-child){border-start-end-radius:0;border-end-end-radius:0;border-inline-end:0}
${P}-unit>span{flex:none;display:flex;align-items:center;padding:0 12px;border:1px solid var(--line-strong);border-start-end-radius:var(--radius-control);border-end-end-radius:var(--radius-control);background:var(--subtle);font-size:12px;color:var(--muted)}
${P}-tabs input[type=text]{font-family:var(--font-mono);font-size:13px}
${P}-box{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
${P}-box .v2-panel-settings__facts{grid-template-columns:repeat(auto-fit,minmax(min(100%,120px),1fr))}
${P}-box .v2-panel-settings__facts>div{padding:0;border:0}
${P}-memory{display:flex;flex-direction:column;gap:var(--space-1)}
${P}-memory>div:first-child{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1);font-size:13px}
${P}-memory>div:first-child>span{color:var(--muted);font-weight:600}
${P}-memory>.v2-bar{block-size:8px;border-radius:4px;background:var(--sunken)}
${P}-memory>p{font-size:12px;color:var(--muted);line-height:1.5}
${P}-tabs .v2-field>h3{font-size:16px;font-weight:600}
.v2-panel-settings ${P}-handlers{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2)}
${P}-handlers>li{display:flex;flex-wrap:wrap;align-items:center;gap:6px var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);font-size:14px}
${P}-handlers>li>span:last-child{flex:1 1 100%;font-size:12px;color:var(--muted)}
${P}-handlers>li[data-current=true]{border-color:var(--accent-line);background:var(--accent-soft)}
${P}-handlers>li[data-offered=false]{background:var(--subtle);color:var(--muted)}
${P}-save{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px var(--space-3);padding-block:var(--space-2)}
${P}-save>div:first-child{flex:1 1 320px;min-inline-size:0;display:flex;flex-direction:column;gap:4px;font-size:14px}
${P}-save>div:first-child>p{font-size:13px;color:var(--muted);line-height:1.5}
${P}-save>div:first-child>p[role=status]{color:var(--text)}
${P} aside .v2-panel-settings__table :is(th,td){padding-block:10px;font-size:12px}
${P}-blank,.v2-panel-store-blank{padding:var(--space-2);border:1px dashed var(--line-strong);border-radius:var(--radius-notice);background:var(--subtle);color:var(--muted);font-size:13px;line-height:1.6}
@media(min-width:1100px){${P}-status__fields{grid-template-columns:minmax(0,1.5fr) minmax(0,.8fr) minmax(0,1fr)}}
${S} .v2-panel-settings__facts>div{padding-inline-start:12px;border-inline-start:1px solid var(--line);gap:4px}
${S} .v2-panel-settings__facts dd{font-size:14px;font-weight:500}
${S} :is([role=status],[role=alert])[data-state]:is([data-state=uncertain],[data-state=invalid],[data-state=unavailable]):not(:empty),${S} [data-installer-state=unavailable]{padding:12px 16px;border:1px solid var(--warn-line);background:var(--warn-soft);border-radius:var(--radius-notice);font-size:13px;line-height:1.6;color:var(--text)}
${S} [data-installer-progress]{font-size:13px;color:var(--muted)}
.v2-panel-settings[data-panel-store] .v2-panel-settings__tabs{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin}
.v2-panel-settings[data-panel-store] .v2-panel-settings__tabs>a.v2-btn{flex:none;padding-inline:10px;font-size:13px;white-space:nowrap}
.v2-panel-settings[data-panel-store] .v2-panel-settings__split>.v2-panel-settings__groups{gap:var(--space-3)}
.v2-panel-settings[data-panel-store] .v2-panel-settings__steps>li{color:var(--muted);font-weight:500}
.v2-panel-settings[data-panel-store] .v2-panel-settings__steps>li[aria-current=step]{color:var(--text);font-weight:600}
.v2-panel-settings[data-panel-store] .v2-panel-settings__steps>li[aria-current=step]>b{border-color:transparent;background:var(--accent-fill);color:var(--on-accent)}
.v2-panel-settings[data-panel-store] #v2-store-install-target .v2-panel-settings__fields>.v2-field:first-child{grid-column:1/-1}
.v2-panel-settings[data-panel-store] .v2-field>:is(input,.v2-select){inline-size:100%}
.v2-panel-settings[data-panel-store] .v2-panel-settings__facts{grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr))}
.v2-panel-settings[data-panel-store] pre.v2-panel-settings__preview{background:var(--code);color:var(--code-text);border-color:transparent;font-size:12px;line-height:1.7}
@media(max-width:1000px){${P} .v2-panel-settings__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:700px){.v2-panel-settings[data-panel-store] .v2-panel-settings__tabs{flex-wrap:wrap;overflow:visible}}
@media(max-width:600px){${P}-status__top{padding:var(--space-2)}${P}-status__running{padding:var(--space-2)}${P}-save .v2-panel-settings__actions,${P}-save .v2-panel-settings__actions>button{flex:1 1 auto}}
`
