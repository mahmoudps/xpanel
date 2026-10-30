export const WHM_RESELLERS_CSS = `.v2-resellers,.v2-reseller-detail,.v2-reseller-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-reseller-header{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--v2-panel-padding,24px);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-reseller-facts,.v2-reseller-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--space-2);margin:0;min-inline-size:0}
.v2-reseller-facts>div,.v2-reseller-field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-reseller-facts dt,.v2-reseller-field>label{font-weight:600;font-size:13px;color:var(--text-2)}
.v2-reseller-facts dd{margin:0;overflow-wrap:anywhere}.v2-reseller-facts bdi{unicode-bidi:isolate}
.v2-reseller-field :is(input,select,textarea){inline-size:100%;min-inline-size:0}.v2-reseller-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-reseller-columns{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-reseller-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--space-2)}
.v2-reseller-choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-resellers fieldset{padding:0;margin:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-resellers legend{padding:0;margin-block-end:var(--space-2);font-weight:600}
.v2-resellers .v2-meter__row{flex-direction:column;align-items:stretch;gap:var(--space-1)}
.v2-resellers .v2-meter__value{justify-content:flex-start;flex-wrap:wrap;white-space:normal;min-inline-size:0;overflow-wrap:anywhere}
.v2-reseller-actions{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2)}
.v2-reseller-savebar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--space-2);padding:var(--space-2) var(--v2-panel-padding,24px);border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-reseller-details:has(>.v2-reseller-detail:target)>.v2-reseller-detail:not(:target),.v2-reseller-details:not(:has(>.v2-reseller-detail:target))>.v2-reseller-detail:not(:first-child){display:none}
@media(max-width:960px){.v2-reseller-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-reseller-header{padding:var(--space-2)}.v2-reseller-savebar{padding:var(--space-2)}}
`
