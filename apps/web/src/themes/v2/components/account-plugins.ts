import { localeDirection, type Translate } from '../../../i18n.ts'
import { escapeHtml } from '../html.ts'

/** Core supplies read authority; the shared client fills the groups from /api/account/plugins and shows them only when there are items. */
export function renderV2AccountPlugins(t: Translate, canRead: boolean): string {
  return `<section class="v2-account-plugins" data-account-plugins data-state="${canRead ? 'unread' : 'unavailable'}"${canRead ? '' : ' data-readonly="true"'} lang="${t.locale}" dir="${localeDirection(t.locale)}" aria-label="${escapeHtml(t('Plugins'))}" hidden><template data-xp-template="account-plugin-group"><section class="v2-account-plugins__group"><h2 data-xp-slot="title"></h2><ul class="v2-account-plugins__list" data-xp-slot="items"></ul></section></template><template data-xp-template="account-plugin-link"><li><a class="v2-account-plugins__link" data-xp-slot="link"><img data-xp-slot="icon" alt="" width="48" height="48"><span data-xp-slot="name"></span></a></li></template><div data-account-plugins-list></div><p class="v2-muted" data-account-plugins-status role="status" hidden></p></section>`
}

export const V2_HOME_PLUGINS_CSS = `
.v2-panel-home .v2-account-plugins,.v2-panel-home [data-account-plugins-list]{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-panel-home .v2-account-plugins[hidden],.v2-panel-home .v2-account-plugins [hidden]{display:none}
.v2-panel-home .v2-account-plugins__group{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-panel-home .v2-account-plugins__group h2{margin:0;font-size:16px;font-weight:600}
.v2-panel-home .v2-account-plugins__list{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:var(--space-2);margin:0;padding:0;list-style:none}
.v2-panel-home .v2-account-plugins__link{display:flex;align-items:center;gap:var(--space-1);min-inline-size:0;color:inherit;overflow-wrap:anywhere}
.v2-panel-home .v2-account-plugins__link img{flex:none;inline-size:48px;block-size:48px}
`
