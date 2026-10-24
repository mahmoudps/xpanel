/** Store layout. Determinate progress moves by inline size; shimmer is only the indeterminate state. */
export const STORE_CSS = `
.xp-store { min-inline-size: 0; }
.xp-store .xp-table { min-inline-size: 720px; }
.xp-store-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  border-block-end: 1px solid var(--xp-border);
}
.xp-store-nav a {
  display: inline-flex;
  align-items: center;
  min-block-size: 44px;
  padding-inline: 14px;
  border-block-end: 2px solid transparent;
  color: var(--xp-text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}
.xp-store-nav a[aria-current="page"] {
  border-block-end-color: var(--xp-accent);
  color: var(--xp-accent);
  font-weight: 600;
}
.xp-store-nav a:focus-visible,
.xp-store a:focus-visible,
.xp-store button:focus-visible,
.xp-store input:focus-visible,
.xp-store select:focus-visible {
  outline: var(--xp-focus-width) solid var(--xp-border-focus);
  outline-offset: var(--xp-focus-offset);
}
.xp-store-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.xp-store-toolbar .xp-field { flex: 1 1 220px; min-inline-size: 0; }
.xp-store-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}
.xp-store-shot {
  display: flex;
  align-items: center;
  justify-content: center;
  min-block-size: 180px;
  padding: 24px;
  border: 1px dashed var(--xp-border-strong);
  border-radius: 12px;
  background: var(--xp-bg-subtle);
  color: var(--xp-text-secondary);
  text-align: center;
}
.xp-store-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin: 0;
}
.xp-store-facts div { display: flex; flex-direction: column; gap: 4px; min-inline-size: 0; }
.xp-store-facts dt { color: var(--xp-text-muted); font-size: 12.5px; }
.xp-store-facts dd { margin: 0; }
.xp-store-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.xp-store-steps li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--xp-border);
  border-radius: 10px;
}
.xp-store-progress {
  inline-size: 100%;
  block-size: 8px;
  border-radius: 999px;
  background: var(--xp-border);
  overflow: hidden;
}
.xp-store-progress__fill {
  display: block;
  block-size: 100%;
  inline-size: 0;
  background: var(--xp-accent);
  transition: inline-size 480ms cubic-bezier(0.2, 0, 0, 1);
}
.xp-store-progress[data-progress="indeterminate"] .xp-store-progress__fill {
  inline-size: 40%;
  background-image: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45), transparent);
  background-size: 240px 100%;
  animation: xp-shimmer 1.4s linear infinite;
}
.xp-store-progress__label { margin: 0; color: var(--xp-text-secondary); }
.xp-store-log {
  min-block-size: 140px;
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--xp-bg-code);
  color: var(--xp-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.xp-store-outcomes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 16px;
}
.xp-store-check {
  display: flex;
  align-items: center;
  gap: 10px;
  min-block-size: 44px;
}
.xp-store-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.xp-store-danger {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 20px;
  border: 1px solid var(--xp-status-critical-border);
  border-radius: 12px;
  background: var(--xp-status-critical-bg);
}
@media (max-width: 800px) {
  .xp-store-hero { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .xp-store-progress__fill {
    transition: none;
    animation: none;
  }
}
`
