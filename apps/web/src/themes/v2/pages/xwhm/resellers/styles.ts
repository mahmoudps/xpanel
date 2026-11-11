export const WHM_RESELLERS_CSS = `.v2-resellers,.v2-reseller-detail{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-reseller-stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-card .v2-reseller-stack{gap:var(--space-2)}
.v2-reseller-stack>.v2-btn{align-self:flex-start}
.v2-resellers .v2-card p:not([role=status]){font-size:13px;line-height:1.6;color:var(--muted)}
.v2-reseller-header{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);padding:var(--v2-panel-padding,24px);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-reseller-header>h2{font-size:18px}
.v2-reseller-header>.v2-muted{font-size:13px}
.v2-reseller-header>.v2-reseller-facts{flex:1 1 100%;grid-template-columns:repeat(auto-fit,minmax(min(110px,100%),1fr));padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-reseller-facts,.v2-reseller-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));align-items:start;gap:var(--space-2);margin:0;min-inline-size:0}
.v2-reseller-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-reseller-facts dt{font-size:12px;color:var(--muted)}
.v2-reseller-facts dd{margin:0;font-size:14px;overflow-wrap:anywhere}.v2-reseller-facts bdi{unicode-bidi:isolate}
.v2-resellers>.v2-reseller-facts{grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr))}
.v2-resellers>.v2-reseller-facts>div{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-resellers>.v2-reseller-facts dd{font-size:20px;font-weight:600;line-height:1.3}
.v2-reseller-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-1) 12px;min-inline-size:0;text-align:start}
.v2-reseller-field>:not(.v2-reseller-choice,input,select,textarea),.v2-reseller-field>:is(input,select,textarea):not(:has(+.v2-reseller-choice)){grid-column:1/-1}
.v2-reseller-field>label:not(.v2-reseller-choice){padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-reseller-field>label.v2-reseller-choice{font-weight:400;white-space:nowrap}
.v2-reseller-field :is(input:not([type=checkbox]),select,textarea){inline-size:100%;min-inline-size:0}.v2-reseller-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-reseller-fields>.v2-btn{align-self:end;justify-self:start}
.v2-reseller-fields>.v2-reseller-stack{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.v2-reseller-fields>.v2-reseller-stack+.v2-reseller-stack{padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-reseller-columns{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-reseller-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(200px,100%),1fr));gap:0 var(--space-2)}
.v2-reseller-choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);font-size:14px}
.v2-reseller-choice>input{flex:none}
.v2-resellers fieldset{padding:0;margin:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-1)}
.v2-resellers legend{float:inline-start;inline-size:100%;padding:0;font-size:14px;font-weight:600}
.v2-resellers [data-reseller-ownership]>h3{font-size:14px;font-weight:600}
.v2-resellers .v2-meter__row{flex-direction:column;align-items:stretch;gap:var(--space-1)}
.v2-resellers .v2-meter__value{justify-content:flex-start;flex-wrap:wrap;white-space:normal;min-inline-size:0;overflow-wrap:anywhere}
.v2-reseller-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.v2-reseller-stack[data-whm-reseller-lists] .v2-reseller-field{max-inline-size:480px}
.v2-reseller-savebar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2);padding:var(--space-2) var(--v2-panel-padding,24px);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow)}
.v2-reseller-savebar p:empty,.v2-reseller-actions>p:empty{display:none}
.v2-reseller-details:has(>.v2-reseller-detail:target)>.v2-reseller-detail:not(:target),.v2-reseller-details:not(:has(>.v2-reseller-detail:target))>.v2-reseller-detail:not(:first-child){display:none}
@media(max-width:960px){.v2-reseller-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-reseller-header{padding:var(--space-2)}.v2-reseller-savebar{padding:var(--space-2)}.v2-reseller-fields>.v2-reseller-stack{grid-template-columns:minmax(0,1fr)}.v2-reseller-header>.v2-reseller-facts,.v2-resellers>.v2-reseller-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
.v2-reseller-name{display:flex;flex-direction:column;gap:2px;min-inline-size:0}
.v2-reseller-name>small{font-size:12px}
.v2-resellers #v2-reseller-list td .v2-reseller-ns{overflow-wrap:normal}
.v2-reseller-cell{display:contents}
@media(max-width:600px){.v2-resellers td:has(>.v2-reseller-cell){grid-column:1/-1}.v2-reseller-cell{display:flex;align-items:baseline;justify-content:flex-end;gap:var(--space-2)}.v2-reseller-cell::before{content:attr(data-phone-label);margin-inline-end:auto;font-size:13px;color:var(--muted)}.v2-reseller-cell>span{text-align:end;min-inline-size:0}}
.v2-reseller-name--pills{align-items:flex-start;gap:var(--space-1)}
.v2-resellers #v2-reseller-list :is(th,td){padding-inline:12px}
.v2-resellers #v2-reseller-list td{white-space:normal}
.v2-resellers #v2-reseller-list td bdi{white-space:normal;overflow-wrap:anywhere}
.v2-resellers #v2-reseller-list td:last-child{white-space:nowrap}
.v2-resellers #v2-reseller-list td:first-child bdi{white-space:nowrap}
.v2-resellers #v2-reseller-list td:first-child small bdi{white-space:normal}
.v2-resellers td>span.v2-muted{display:block;font-size:12px}
`
