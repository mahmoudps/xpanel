// v2 design tokens: colors only through these properties, light by default, dark on
// `data-theme="dark"`. The sidebar stays navy and code blocks stay dark in both schemes.
// Mono ends in the sans family, never the generic monospace: that face often carries
// disconnected Arabic glyphs, so Arabic inside a mono run takes the joined Arabic sans.

const ROOT = '[data-ui-theme="v2"]'

export const V2_TOKENS_CSS = `${ROOT}{color-scheme:light;\
--bg:#EEF2F7;--surface:#FFFFFF;--subtle:#F6F8FB;--sunken:#E8EDF5;--line:#DCE3EE;--line-strong:#737F92;\
--text:#0D1626;--text-2:#334155;--muted:#586579;\
--accent:#1D5BD6;--accent-fill:#1D5BD6;--accent-fill-hover:#1546A8;--accent-soft:#EAF1FE;--accent-line:#C3D5FA;--on-accent:#FFFFFF;\
--ok:#0B7A4B;--ok-soft:#E5F4EC;--ok-line:#B0DEC5;--warn:#A84A06;--warn-soft:#FFF3E5;--warn-line:#F5CCA0;\
--bad:#B42318;--bad-soft:#FDECEA;--bad-line:#F4BEBA;\
--nav:#0A1830;--nav-2:#14284B;--nav-line:#1E3660;--nav-text:#C5D0E2;--nav-muted:#8796AE;--nav-strong:#FFFFFF;--nav-ok:#7FD8AC;--nav-focus:#84A9FA;\
--code:#0B1424;--code-text:#D5DEEB;--code-muted:#8796AE;--chart-2:#0E8F7E;\
--shadow:0 1px 2px rgba(14,23,38,.05),0 3px 10px -2px rgba(14,23,38,.04);--scrim:rgba(7,14,26,.48);--focus:#1D5BD6;\
--font-sans:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif;--font-mono:'IBM Plex Mono','IBM Plex Sans Arabic',ui-monospace,Consolas,'Liberation Mono',sans-serif;\
--lh-body:1.5;--lh-head:1.25;\
--space-1:8px;--space-2:16px;--space-3:24px;--space-4:32px;\
--radius-card:12px;--radius-notice:10px;--radius-control:9px;--radius-chip:7px;--radius-pill:999px;--target:44px}
${ROOT}[data-theme="dark"]{color-scheme:dark;\
--bg:#080F1C;--surface:#101A2C;--subtle:#142138;--sunken:#0B1424;--line:#1E2E47;--line-strong:#627491;\
--text:#EAF0F8;--text-2:#BCC8DA;--muted:#8D9CB3;\
--accent:#84A9FA;--accent-fill:#2F6BE6;--accent-fill-hover:#2559C9;--accent-soft:rgba(132,169,250,.15);--accent-line:rgba(132,169,250,.36);\
--ok:#4CC38A;--ok-soft:rgba(76,195,138,.14);--ok-line:rgba(76,195,138,.36);--warn:#F2A33A;--warn-soft:rgba(242,163,58,.14);--warn-line:rgba(242,163,58,.36);\
--bad:#F47067;--bad-soft:rgba(244,112,103,.14);--bad-line:rgba(244,112,103,.36);\
--nav:#060C17;--nav-2:#122038;--nav-line:#1D2E49;--nav-text:#BCC8DA;--nav-muted:#7E8CA3;\
--code:#060D19;--code-muted:#7E8CA3;--chart-2:#3CC4AE;--shadow:0 1px 2px rgba(0,0,0,.4),0 3px 10px -2px rgba(0,0,0,.28);--scrim:rgba(0,0,0,.64);--focus:#84A9FA}
${ROOT}:lang(ar){--font-sans:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif}
${ROOT}:lang(ar){--lh-body:1.65;--lh-head:1.35}
${ROOT} [lang="ar"]{font-family:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif}
`
