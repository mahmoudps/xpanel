export const PANEL_OPERATIONS_CSS = `.v2-panel-operations,.v2-panel-operation-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-panel-operation-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-panel-operation-fields,.v2-panel-operation-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-operation-facts{margin:0}
.v2-panel-operation-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-panel-operation-facts :is(dt,dd){margin:0;overflow-wrap:anywhere}
.v2-panel-operation-facts dt{font-size:12px;color:var(--muted)}
.v2-panel-operation-facts bdi{unicode-bidi:isolate}
.v2-panel-operation-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-operation-actions :is(button,a){min-block-size:var(--target)}
.v2-panel-operation-actions [aria-disabled=true]{pointer-events:none;opacity:.55}
.v2-panel-operations :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-operations :is(input,select,textarea){min-inline-size:0;max-inline-size:100%}
.v2-panel-operation-table{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-panel-operation-table table{min-inline-size:620px}
.v2-panel-operation-table :is(th,td){text-align:start;vertical-align:top;overflow-wrap:anywhere;padding:12px 16px}
.v2-panel-operation-table :is(th,td):first-child{padding-inline-start:var(--v2-panel-padding)}
.v2-panel-operation-table :is(th,td):last-child{padding-inline-end:var(--v2-panel-padding)}
.v2-panel-operation-table :is(bdi,time){unicode-bidi:isolate;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.v2-panel-operation-table .v2-panel-operation-stack{gap:var(--space-1);align-items:flex-start}
.v2-panel-operation-options{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding:0;border:0;min-inline-size:0}
.v2-panel-operation-options legend{margin-block-end:var(--space-2);font-weight:600;padding:0}
.v2-panel-operation-options label,.v2-panel-operation-check{display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target)}
.v2-panel-operation-options input,.v2-panel-operation-check input{flex:none;margin:4px 0 0}
.v2-panel-operation-dialog{inline-size:min(560px,calc(100% - 32px));padding:var(--v2-panel-padding);border:1px solid var(--line-strong);border-radius:var(--radius-card);background:var(--surface);color:var(--text)}
.v2-panel-operation-dialog form{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-panel-operation-dialog::backdrop{background:var(--scrim)}
.v2-panel-operations pre{white-space:pre-wrap;overflow-wrap:anywhere;max-block-size:360px;overflow:auto;background:var(--code);color:var(--code-text);padding:var(--space-2);border-radius:var(--radius-control);min-inline-size:0}
.v2-panel-operation-unavailable{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--warn-line);border-radius:var(--radius-control);background:var(--warn-soft)}
.v2-panel-terminal-session{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);overflow:hidden;min-inline-size:0}
.v2-panel-terminal-head{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2);padding:var(--v2-panel-padding)}
.v2-panel-terminal-head h2{flex:1 1 auto}
.v2-panel-terminal-head :is([data-terminal-pill],[data-terminal-exec-pill]){display:inline-flex;align-items:center;gap:var(--space-1);padding:4px var(--space-1);border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--subtle);font-size:12px}
.v2-panel-terminal-head [data-tone=ok]{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
.v2-panel-terminal-head [data-tone=warn]{color:var(--warn);background:var(--warn-soft);border-color:var(--warn-line)}
.v2-panel-terminal-head [data-tone=info]{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.v2-panel-operations [data-state-chip]{display:inline-flex;align-items:center;gap:var(--space-1);padding:2px var(--space-1);border:1px solid var(--line);border-radius:var(--radius-pill);font-size:12px}
.v2-panel-operations [data-state-chip=ok]{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
.v2-panel-operations [data-state-chip=problem]{color:var(--bad);background:var(--bad-soft);border-color:var(--bad-line)}
.v2-panel-terminal-pad{display:flex;flex-direction:column;gap:var(--space-3);padding:0 var(--v2-panel-padding) var(--v2-panel-padding)}
.v2-panel-terminal-screen{block-size:clamp(280px,50vh,560px);padding:var(--space-2);background:var(--code);color:var(--code-text);font-family:var(--font-mono);overflow:hidden;min-inline-size:0}
.v2-panel-terminal-screen .xterm{block-size:100%}
.v2-panel-terminal-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);padding:var(--v2-panel-padding);background:var(--subtle);border-block-start:1px solid var(--line)}
.v2-panel-terminal-command{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);flex:1 1 320px;min-inline-size:0}
.v2-panel-terminal-command>.v2-field{flex:1 1 240px}
@media(max-width:1000px){.v2-panel-operation-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-operation-fields,.v2-panel-operation-facts{grid-template-columns:minmax(0,1fr)}}
`
