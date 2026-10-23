/** Mail workspace layout. Authentication, mailbox authority and delivery remain adapter responsibilities. */
export const MAIL_LAYOUT_CSS = /* css */ `
.xp-shell[data-mail-layout="reference"] {
  grid-template-columns: 200px minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  align-items: stretch;
}
.xp-mail-shell > .xp-mail-topbar {
  grid-column: 1 / -1;
  gap: var(--xp-space-md) var(--xp-space-field);
  padding: var(--xp-space-sm) var(--xp-space-card);
}
.xp-mail-brand {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--xp-space-sm);
  min-block-size: 44px;
  min-inline-size: 152px;
  text-decoration: none;
  color: var(--xp-status-ok-fg);
  font-family: var(--xp-font-sans-ltr);
  font-size: var(--xp-type-card);
  line-height: var(--xp-leading-card);
  font-weight: var(--xp-weight-semibold);
}
.xp-mail-brand > strong { font-weight: inherit; }
.xp-mail-brand:hover { color: var(--xp-status-ok-fg); }
.xp-mail-brand-mark {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  inline-size: 36px;
  block-size: 36px;
  border-radius: 8px;
  background: var(--xp-status-ok-fg);
  color: var(--xp-bg-surface);
  font-size: var(--xp-type-card);
  font-weight: var(--xp-weight-semibold);
}
.xp-mail-account {
  min-inline-size: 0;
  max-inline-size: 30ch;
  overflow-wrap: anywhere;
  font-family: var(--xp-font-mono);
  font-size: var(--xp-type-label);
  line-height: var(--xp-leading-label);
}
.xp-mail-folders nav { display: flex; flex-direction: column; gap: var(--xp-space-xs); }
.xp-mail-nav-section { min-inline-size: 0; margin-block-end: 0; }
.xp-mail-nav-section > .xp-nav-section__title { text-transform: none; letter-spacing: normal; font-size: var(--xp-type-label); font-weight: var(--xp-weight-medium); line-height: var(--xp-leading-label); padding-inline: var(--xp-space-md); }
.xp-mail-nav-section > .xp-label { display: block; margin: 0; padding-inline: 12px; }
.xp-mail-nav-section .xp-nav-item { gap: var(--xp-space-sm); border-inline-start: 0; padding-inline: 12px; }
.xp-mail-nav-section .xp-nav-item > svg { flex: none; }
.xp-mail-nav-section .xp-nav-item > span:first-of-type { flex: 1; min-inline-size: 0; overflow-wrap: anywhere; }
.xp-mail-nav-section .xp-mail-compose-link {
  background: var(--xp-accent);
  color: var(--xp-text-on-accent);
  justify-content: center;
  margin-block-end: 8px;
}
.xp-mail-nav-section .xp-mail-compose-link[aria-current="page"] {
  background: #1546a8;
  color: #ffffff;
  box-shadow: none;
}
.xp-mail-nav-section .xp-mail-compose-link > span:first-of-type { flex: initial; }
.xp-mail-count { padding: 2px 8px; border-radius: 999px; background: var(--xp-accent-soft); font-size: var(--xp-type-caption); line-height: var(--xp-leading-caption); }
.xp-mail-observed-folders { display: flex; flex-direction: column; list-style: none; margin: 4px 0 0; padding: 0; }
.xp-mail-observed-folders li { display: flex; gap: var(--xp-space-sm); padding: 8px 12px; min-inline-size: 0; color: var(--xp-text-secondary); }
.xp-mail-observed-folders svg { flex: none; }
.xp-mail-observed-folders span { overflow-wrap: anywhere; }
.xp-mail-sidebar-quota { display: flex; flex-direction: column; gap: 8px; margin-block-start: auto; padding: 16px 4px 0; border-block-start: 1px solid var(--xp-border); }
/* Fragment and skip-link focus must clear the full-width header, including a wrapped toolbar. */
.xp-mail-main { padding: var(--xp-space-card) var(--xp-space-card) var(--xp-space-section); scroll-margin-block-start: 128px; }
.xp-mail-main--inbox { padding: 0; gap: 0; flex: 1; }
.xp-mail-main--inbox > [role="status"] { margin: 16px; }
.xp-mail-shell .xp-mail-tri-pane {
  display: grid;
  grid-template-columns: minmax(280px, 1.618fr) minmax(0, 2.618fr);
  flex: 1;
  gap: 0;
  align-items: stretch;
}
.xp-mail-messages, .xp-mail-reader { min-inline-size: 0; background: var(--xp-bg-surface); }
.xp-mail-messages { border-inline-end: 1px solid var(--xp-border); }
.xp-mail-pane-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--xp-space-sm) var(--xp-space-md); justify-content: space-between; padding: var(--xp-space-card); border-block-end: 1px solid var(--xp-border); }
.xp-mail-shell .xp-page-title { margin: 0; font-size: var(--xp-type-page); font-weight: var(--xp-weight-semibold); line-height: var(--xp-leading-page); overflow-wrap: anywhere; }
.xp-mail-message-heading h2 { margin: 0; font-size: var(--xp-type-card); font-weight: var(--xp-weight-semibold); line-height: var(--xp-leading-card); overflow-wrap: anywhere; }
.xp-mail-list { display: flex; flex-direction: column; }
.xp-mail-row { display: flex; align-items: flex-start; gap: var(--xp-space-md); padding: var(--xp-space-field) var(--xp-space-card); border-block-end: 1px solid var(--xp-border); }
.xp-mail-row.is-selected { background: #f3f7fe; box-shadow: inset 3px 0 0 #1d5bd6; }
[data-theme="dark"] .xp-mail-row.is-selected { background: var(--xp-bg-elevated); box-shadow: inset 3px 0 0 var(--xp-accent); }
html[dir="rtl"] .xp-mail-row.is-selected { box-shadow: inset -3px 0 var(--xp-accent); }
.xp-mail-read-mark { flex: none; inline-size: 7px; block-size: 7px; margin-block-start: 7px; border-radius: 50%; background: transparent; }
.xp-mail-row.is-unread .xp-mail-read-mark { background: var(--xp-accent); }
.xp-mail-row-content { display: flex; flex-direction: column; gap: var(--xp-space-xs); min-inline-size: 0; flex: 1; }
.xp-mail-sender, .xp-mail-subject { display: block; overflow-wrap: anywhere; font-size: var(--xp-type-body); line-height: var(--xp-leading-body); font-weight: var(--xp-weight-medium); }
.xp-mail-row.is-unread :is(.xp-mail-sender, .xp-mail-subject) { font-weight: 600; }
.xp-mail-preview { margin: 0; overflow-wrap: anywhere; color: var(--xp-text-secondary); font-size: var(--xp-type-caption); line-height: var(--xp-leading-caption); }
.xp-mail-time { font-size: var(--xp-type-caption); line-height: var(--xp-leading-caption); color: var(--xp-text-muted); overflow-wrap: anywhere; margin-block-start: var(--xp-space-xs); }
.xp-mail-message-heading { display: flex; flex-direction: column; gap: var(--xp-space-card); padding: var(--xp-space-card); border-block-end: 1px solid var(--xp-border); }
.xp-mail-message-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0; }
.xp-mail-message-meta > :last-child { grid-column: 1 / -1; }
.xp-mail-field { display: flex; flex-direction: column; min-inline-size: 0; gap: var(--xp-space-sm); align-items: stretch; }
.xp-mail-field :is(dt, dd) { margin: 0; }
.xp-mail-field dd { font-family: var(--xp-font-mono); font-size: var(--xp-type-label); line-height: var(--xp-leading-label); overflow-wrap: anywhere; }
.xp-mail-field dd > bdi { display: block; text-align: left; }
html[dir="rtl"] .xp-mail-field dd > bdi { text-align: right; }
.xp-mail-message-body { padding: var(--xp-space-card); font-size: var(--xp-type-body); line-height: var(--xp-leading-body); white-space: pre-wrap; overflow-wrap: anywhere; }
.xp-mail-auth-results { border-block-end: 1px solid var(--xp-border); padding-inline: var(--xp-space-card); }
.xp-mail-auth-results > summary { display: flex; align-items: center; min-block-size: 44px; cursor: pointer; color: var(--xp-text-secondary); font-size: var(--xp-type-label); line-height: var(--xp-leading-label); gap: var(--xp-space-sm); }
.xp-mail-auth-results > summary::before { content: '+'; font-family: var(--xp-font-mono); font-size: 16px; }
.xp-mail-auth-results[open] > summary::before { content: '−'; }
.xp-mail-auth-results > div { display: flex; flex-wrap: wrap; gap: 8px; padding-block: 0 16px; }
.xp-mail-empty { margin: 0; padding: var(--xp-space-section) var(--xp-space-card); font-size: var(--xp-type-body); line-height: var(--xp-leading-body); color: var(--xp-text-muted); }
.xp-mail-compose-layout { display: grid; grid-template-columns: minmax(0, 1.618fr) minmax(240px, 1fr); gap: var(--xp-space-card); align-items: start; }
.xp-mail-editor { min-inline-size: 0; border: 1px solid var(--xp-border); border-radius: 12px; background: var(--xp-bg-surface); overflow: clip; }
.xp-mail-editor-heading { display: flex; flex-wrap: wrap; align-items: center; gap: var(--xp-space-sm) var(--xp-space-field); padding: var(--xp-space-field) var(--xp-space-card); border-block-end: 1px solid var(--xp-border); }
.xp-mail-editor-heading > .xp-page-title { min-inline-size: 0; flex: 1; }
.xp-mail-back-link { display: inline-flex; align-items: center; align-self: start; min-block-size: 44px; min-inline-size: 44px; font-size: var(--xp-type-body); line-height: var(--xp-leading-body); color: var(--xp-text-secondary); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.xp-mail-compose-form { display: flex; flex-direction: column; gap: var(--xp-space-field); }
.xp-mail-compose-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--xp-space-field); padding: var(--xp-space-card) var(--xp-space-card) 0; }
.xp-mail-field--wide { grid-column: 1 / -1; }
.xp-mail-compose-body { padding-inline: var(--xp-space-card); }
.xp-mail-compose-form :is(input[dir="auto"], textarea[dir="auto"]) { text-align: left; }
html[dir="rtl"] .xp-mail-compose-form :is(input[dir="auto"], textarea[dir="auto"]) { text-align: right; }
.xp-mail-compose-body textarea { min-block-size: 300px; resize: vertical; }
.xp-mail-editor-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--xp-space-md); padding: var(--xp-space-field) var(--xp-space-card); border-block-start: 1px solid var(--xp-border); }
.xp-mail-compose-aside { display: flex; flex-direction: column; min-inline-size: 0; gap: var(--xp-space-card); }
.xp-mail-compose-aside .xp-card { display: flex; flex-direction: column; gap: var(--xp-space-field); padding: var(--xp-space-card); }
.xp-mail-compose-aside h2 { margin: 0; font-size: var(--xp-type-card); line-height: var(--xp-leading-card); font-weight: var(--xp-weight-semibold); }
.xp-mail-compose-aside dl { margin: 0; }
@media (width >= 960px) {
  .xp-shell[data-mail-layout="reference"] > .xp-sidebar { position: static; inline-size: 200px; block-size: auto; padding: 16px 12px; }
  .xp-mail-shell > .xp-workspace { min-block-size: 0; }
}
@media (width < 1200px) {
  .xp-mail-compose-layout { grid-template-columns: minmax(0, 1fr); }
  .xp-mail-compose-aside { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (width < 960px) {
  .xp-shell[data-mail-layout="reference"] { grid-template-columns: minmax(0, 1fr); }
  .xp-mail-shell > .xp-mail-topbar { gap: 8px; padding: 8px 16px; }
  .xp-mail-brand { min-inline-size: 0; gap: var(--xp-space-sm); }
  .xp-mail-brand-mark { display: none; }
  .xp-mail-main { padding: var(--xp-space-card) var(--xp-space-field) var(--xp-space-section); }
  .xp-mail-main--inbox { padding: 0; }
  .xp-mail-shell .xp-mail-tri-pane { grid-template-columns: minmax(260px, 1.618fr) minmax(0, 2.618fr) !important; }
  .xp-mail-message-heading, .xp-mail-message-body { padding-inline: var(--xp-space-field); }
  .xp-mail-auth-results { padding-inline: var(--xp-space-field); }
}
@media (width < 640px) {
  .xp-mail-shell .xp-mail-tri-pane { grid-template-columns: minmax(0, 1fr) !important; }
  .xp-mail-messages { border-inline-end: 0; border-block-end: 1px solid var(--xp-border); }
  .xp-mail-message-meta { grid-template-columns: minmax(0, 1fr); }
  .xp-mail-compose-layout { gap: var(--xp-space-card); }
  .xp-mail-compose-fields { grid-template-columns: minmax(0, 1fr); }
  .xp-mail-compose-fields, .xp-mail-editor-heading, .xp-mail-editor-actions { padding-inline: 16px; }
  .xp-mail-compose-body { padding-inline: 16px; }
  .xp-mail-compose-aside { display: flex; gap: var(--xp-space-card); }
  .xp-mail-compose-aside .xp-card { padding: var(--xp-space-field); }
  .xp-mail-pane-heading { padding-inline: var(--xp-space-field); }
}
`
