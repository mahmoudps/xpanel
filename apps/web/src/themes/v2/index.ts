// v2 UI theme: the foundation (assets, document frame, shell and component kit) and the page layouts.
// Surface renderers and their controller contracts are required before this foundation becomes a registered UiTheme.

export { v2Assets, v2Stylesheet, v2FontsHref } from './assets.ts'
export { renderV2Document, type V2DocumentProps } from './document.ts'
export { v2Messages } from './messages.ts'
export { renderV2Shell, type NavContext, type V2ShellProps } from './shell/shell.ts'
export { activityDrawer, commandPalette, reconcileBanner, type PaletteEntry, type ReconcileStage, type V2Surface } from './shell/overlays.ts'
export { escapeHtml, hookAttrs, xpTemplate, type HookAttributes, type Tone } from './html.ts'
export { icon, type IconName } from './icons.ts'
export * from './components/index.ts'
export * from './layouts/index.ts'
