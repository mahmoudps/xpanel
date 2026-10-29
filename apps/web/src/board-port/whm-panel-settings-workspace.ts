import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-panel-settings :is(p,h2,h3,dl,dd,ul){margin:0}.xp-whm-panel-settings__groups{display:flex;flex-direction:column}.xp-whm-panel-settings__group{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;padding-block:16px;border-block-end:1px solid var(--xp-border)}.xp-whm-panel-settings__group:last-child{border-block-end:0}.xp-whm-panel-settings__group h3{font-size:var(--xp-type-body);font-weight:var(--xp-weight-semibold)}.xp-whm-panel-settings__control{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-panel-settings__toggle{display:flex;gap:8px;align-items:center}.xp-whm-panel-settings textarea{inline-size:100%;min-block-size:88px}.xp-whm-panel-settings__control>label[for]{padding-inline:13px}.xp-whm-panel-settings__related{display:grid;gap:12px;padding:0;list-style:none}.xp-whm-panel-settings [hidden]{display:none!important}@media(max-width:700px){.xp-whm-panel-settings__group{grid-template-columns:minmax(0,1fr)}}</style>`

/** Server-wide settings of the panels themselves; each one changes how the running panel behaves. */
export function renderWhmPanelSettingsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const toggle = (key: string, title: string, description: string, label: string, extra = ''): string => `<div class="xp-whm-panel-settings__group" data-panel-settings-group="${key}">
      <div><h3 id="panel-settings-${key}-title">${title}</h3><p class="xp-help">${description}</p></div>
      <div class="xp-whm-panel-settings__control"><label class="xp-whm-panel-settings__toggle"><input type="checkbox" data-panel-settings-input="${key}" aria-describedby="panel-settings-${key}-title" disabled> ${label}</label>${extra}</div></div>`
  const related = [
    ['/whm/server/setup', t('Setup & settings'), t('Hostname, nameservers, admin email and the web engine.')],
    ['/whm/panel/developer', t('Developer tools'), t('Supported API read requests with your current session.')],
    ['/whm/software/php', t('PHP'), t('PHP versions and handlers for hosted sites.')],
    ['/whm/panel/languages', t('Languages'), t('Locales the panels offer.')],
    ['/whm/security', t('Panel security'), t('Sign-in and session policy for the panels.')],
  ]
  return `${styles}<section class="xp-whm-detail xp-whm-panel-settings" data-whm-detail-route="/whm/panel/settings" data-panel-settings-workspace data-panel-settings-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('Panel settings')}</h1><p>${t('Server-wide settings for the xPanel, xWHM and xMail panels themselves.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="panel-settings-heading"><h2 id="panel-settings-heading">${t('Configuration')}</h2>
      <p class="xp-whm-detail-status" data-panel-settings-status data-state="unread" role="status">${t('Panel settings have not been read. No saved values are assumed.')}</p>
      <dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${t('Last saved (UTC)')}</dt><dd data-panel-settings-updated>${t('Not read')}</dd></div></dl>
      <div class="xp-whm-panel-settings__groups" data-panel-settings-form>
        ${toggle('offlineMode', t('Offline mode'), t('Take the panels offline while the server is maintained. Root keeps working; everyone else sees the maintenance page and can only sign out.'), t('Panels are offline'),
          `<label for="panel-settings-offline-message">${t('Message on the maintenance page')}</label><textarea id="panel-settings-offline-message" class="xp-input" maxlength="280" data-panel-settings-input="offlineMessage" disabled></textarea>`)}
        ${toggle('developerMode', t('Developer mode'), t('Every API response carries a Server-Timing header with the time this panel spent on it, for the browser’s network panel.'), t('Developer mode is on'))}
        ${toggle('liveUpdates', t('Live updates'), t('Pages keep a WebSocket channel open for job and configuration updates. Turn it off to save memory on a small server; pages then update when reloaded.'), t('Live updates are on'))}
        <div class="xp-whm-panel-settings__group" data-panel-settings-group="reverseProxyAllowedHosts"><div><h3 id="panel-settings-hosts-title">${t('Remote reverse-proxy hosts')}</h3><p class="xp-help">${t('Hosts account owners may use as a reverse-proxy upstream, one per line: an IP address or a host name. Leave empty to keep every proxy on this server.')}</p></div>
          <div class="xp-whm-panel-settings__control"><textarea class="xp-input xp-mono" dir="ltr" spellcheck="false" aria-labelledby="panel-settings-hosts-title" data-panel-settings-input="reverseProxyAllowedHosts" disabled></textarea><p class="xp-help">${t('Private, link-local and reserved addresses stay refused. Host names need a DNS resolver configured for the web server.')}</p></div></div>
      </div>
      <p class="xp-whm-detail-status" data-panel-settings-save-status role="status" hidden></p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-panel-settings-save disabled>${t('Save settings')}</button><button type="button" class="xp-btn" data-panel-settings-reload${input.canManage ? '' : ' disabled'}>${t('Reload')}</button></div>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="panel-settings-related"><h2 id="panel-settings-related">${t('Settings on other pages')}</h2><p>${t('These server and panel settings are read and changed on their own pages.')}</p>
      <ul class="xp-whm-panel-settings__related">${related.map(([href, label, description]) => `<li><a href="${href}">${label}</a> <span class="xp-help">${description}</span></li>`).join('')}</ul></section>
  </div>
</section>`
}
