import { adminStyles } from './common.ts'
export const WHM_SERVER_CSS = adminStyles('.v2-server-page') + `.v2-server-page .v2-server-setup-steps{padding:var(--space-2) var(--v2-panel-padding);background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);overflow:auto}
.v2-server-page [data-setup-wizard-form]{gap:var(--space-4)}
.v2-server-page .v2-server-setup-steps ol{display:flex;gap:var(--space-2);list-style:none;padding:0;min-inline-size:760px}
.v2-server-page .v2-server-setup-steps li{flex:1;min-inline-size:0}
.v2-server-page .v2-server-setup-steps a{display:flex;flex-direction:column;align-items:center;gap:var(--space-1);padding:var(--space-1);text-align:center;text-decoration:none;min-block-size:var(--target)}
.v2-server-page .v2-server-setup-steps a>span:first-child{display:grid;place-items:center;inline-size:28px;block-size:28px;border:1px solid var(--line-strong);border-radius:var(--radius-pill)}
.v2-server-page .v2-server-terminal-session{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-card);overflow:hidden}
.v2-server-page .v2-server-terminal-head,.v2-server-page .v2-server-terminal-bar{display:flex;flex-direction:column;gap:var(--space-2);padding:var(--v2-panel-padding)}
.v2-server-page .v2-server-terminal-screen{block-size:clamp(280px,50vh,560px);padding:var(--space-2);background:var(--code);color:var(--code-text);font-family:var(--font-mono);font-size:13px;overflow:hidden;min-inline-size:0;box-sizing:border-box}
.v2-server-page .v2-server-terminal-screen .xterm{block-size:100%}
.v2-server-page [data-terminal-pill],.v2-server-page [data-terminal-exec-pill]{display:inline-flex;align-items:center;gap:var(--space-1);padding:4px var(--space-1);border:1px solid var(--line);border-radius:var(--radius-pill);font-size:12px}
.v2-server-page [data-tone=ok]{background:var(--ok-soft);color:var(--ok)}
.v2-server-page [data-tone=warn]{background:var(--warn-soft);color:var(--warn)}
`
