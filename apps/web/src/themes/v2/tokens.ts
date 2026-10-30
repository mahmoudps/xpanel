// v2 design tokens: colors only through these properties, light by default, dark on
// `data-theme="dark"`. The sidebar stays navy and code blocks stay dark in both schemes.

const ROOT = '[data-ui-theme="v2"]'

export const V2_TOKENS_CSS = `${ROOT}{color-scheme:light;\
--bg:#F3F5F9;--surface:#FFFFFF;--subtle:#F7F9FC;--sunken:#EDF1F6;--line:#E2E7EF;--line-strong:#CDD5E1;\
--text:#0E1726;--text-2:#344256;--muted:#5A6678;\
--accent:#1D5BD6;--accent-fill:#1D5BD6;--accent-fill-hover:#1546A8;--accent-soft:#EAF1FE;--accent-line:#C7D7F8;--on-accent:#FFFFFF;\
--ok:#0B7A4B;--ok-soft:#E5F4EC;--ok-line:#B5DFC8;--warn:#A84A06;--warn-soft:#FFF3E5;--warn-line:#F6CFA3;\
--bad:#B42318;--bad-soft:#FDECEA;--bad-line:#F5C2BD;\
--nav:#0B1A33;--nav-2:#14284B;--nav-line:#1E3560;--nav-text:#C3CEDF;--nav-muted:#8796AE;--nav-strong:#FFFFFF;--nav-ok:#7FD8AC;--nav-focus:#84A9FA;\
--code:#0B1424;--code-text:#D5DEEB;--code-muted:#8796AE;--chart-2:#0E8F7E;\
--shadow:0 1px 2px rgba(14,23,38,.05),0 1px 3px rgba(14,23,38,.04);--scrim:rgba(7,14,26,.48);--focus:#1D5BD6;\
--font-sans:'IBM Plex Sans',system-ui,sans-serif;--font-mono:'IBM Plex Mono',ui-monospace,monospace;\
--space-1:8px;--space-2:16px;--space-3:24px;--space-4:32px;\
--radius-card:14px;--radius-notice:12px;--radius-control:10px;--radius-chip:8px;--radius-pill:999px;--target:44px}
${ROOT}[data-theme="dark"]{color-scheme:dark;\
--bg:#0A1220;--surface:#111C2E;--subtle:#0E1828;--sunken:#0B1524;--line:#1F2D44;--line-strong:#2C3D59;\
--text:#E7EDF6;--text-2:#BAC6D8;--muted:#8F9DB3;\
--accent:#84A9FA;--accent-fill:#2F6BE6;--accent-fill-hover:#2559C9;--accent-soft:rgba(132,169,250,.14);--accent-line:rgba(132,169,250,.38);\
--ok:#4CC38A;--ok-soft:rgba(76,195,138,.13);--ok-line:rgba(76,195,138,.38);--warn:#F2A33A;--warn-soft:rgba(242,163,58,.13);--warn-line:rgba(242,163,58,.38);\
--bad:#F47067;--bad-soft:rgba(244,112,103,.13);--bad-line:rgba(244,112,103,.38);\
--nav:#070E1A;--nav-2:#14213A;--nav-line:#1F2D44;--nav-text:#BAC6D8;--nav-muted:#7E8CA3;\
--code:#070E1A;--code-muted:#7E8CA3;--chart-2:#3CC4AE;--shadow:0 1px 2px rgba(0,0,0,.35);--scrim:rgba(0,0,0,.6);--focus:#84A9FA}
${ROOT}:lang(ar){--font-sans:sans-serif}
${ROOT} [lang="ar"]{font-family:sans-serif}
`
