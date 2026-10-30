import { adminStyles } from '../server/common.ts'
export const WHM_PANEL_CSS = adminStyles('.v2-panel-page') + `.v2-panel-page .v2-panel-branding-asset{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-page [data-whm-whmcs-form]{gap:var(--space-4)}
.v2-panel-page .v2-panel-branding-preview{display:grid;place-items:center;inline-size:96px;block-size:56px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);overflow:hidden}
.v2-panel-page .v2-panel-branding-preview img{max-inline-size:100%;max-block-size:100%}
.v2-panel-page .v2-admin-warning{padding:var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-control);color:var(--bad);background:var(--bad-soft)}
.v2-panel-page .v2-panel-module-ops{display:flex;flex-direction:column;list-style:none;padding:0}
.v2-panel-page .v2-panel-module-ops li{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);min-block-size:var(--target);border-block-end:1px solid var(--line)}
`
