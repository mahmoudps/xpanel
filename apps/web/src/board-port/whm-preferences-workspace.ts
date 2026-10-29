import { LOCALES, languageName, localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-preferences :is(p,h2,dl,dd){margin:0}.xp-whm-preferences__form{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-preferences__values{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xp-whm-preferences__fields{grid-template-columns:repeat(3,minmax(0,1fr))}.xp-whm-preferences__fields .xp-whm-detail-field>label{padding-inline:13px}.xp-whm-preferences__loading{display:flex;flex-direction:column;gap:8px}.xp-whm-preferences [hidden]{display:none!important}@media(max-width:700px){.xp-whm-preferences__values,.xp-whm-preferences__fields{grid-template-columns:minmax(0,1fr)}}</style>`

/** Personal display settings: this page never edits server-wide settings or sign-in policy. */
export function renderWhmPreferencesWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = ' disabled', container = input.canManage ? 'form' : 'div'
  const choice = (key: string, label: string, options: readonly (readonly [string, string])[]): string => `<div class="xp-whm-detail-field"><label for="whm-preferences-${key}">${label}</label><select id="whm-preferences-${key}" name="${key}" data-whm-preferences-input="${key}"${disabled}>${options.map(([value, text]) => `<option value="${value}">${text}</option>`).join('')}</select></div>`
  const fact = (key: string, label: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-whm-preferences-field="${key}">${t('Not read')}</dd></div>`
  return `${styles}<section class="xp-whm-detail xp-whm-preferences" data-whm-detail-route="/whm/preferences" data-whm-preferences-workspace data-preferences-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('My preferences')}</h1><p>${t('Choose the language, appearance and table spacing for your own administrator account.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="whm-preferences-saved-heading"><h2 id="whm-preferences-saved-heading">${t('Current saved preferences')}</h2>
      <p class="xp-whm-detail-status" data-whm-preferences-status data-state="unread" role="status">${t('Preferences have not been read. No saved values are assumed.')}</p>
      <div class="xp-whm-preferences__loading" data-whm-preferences-loading aria-label="${t('Loading preferences')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <dl class="xp-whm-preferences__values">${fact('language', t('Language'))}${fact('theme', t('Appearance'))}${fact('density', t('Table spacing'))}${fact('updatedAt', t('Last saved (UTC)'))}</dl>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="whm-preferences-edit-heading"><h2 id="whm-preferences-edit-heading">${t('Display preferences')}</h2>
      <${container} class="xp-whm-preferences__form" data-whm-preferences-form aria-labelledby="whm-preferences-edit-heading"${input.canManage ? ' novalidate' : ''}>
        <div class="xp-whm-detail-fields xp-whm-preferences__fields">
          ${choice('language', t('Language'), LOCALES.map(info => [info.tag, escapeHtml(languageName(info.tag, input.locale))] as const))}
          ${choice('theme', t('Appearance'), [['light', t('Light')], ['dark', t('Dark')]])}
          ${choice('density', t('Table spacing'), [['comfortable', t('Comfortable')], ['compact', t('Compact')]])}
        </div>
        <p class="xp-help" id="whm-preferences-help">${t('Saved preferences apply when you next open a page. A language, appearance or spacing choice in the page URL takes precedence for that visit.')}</p>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-preferences-save aria-describedby="whm-preferences-help" disabled>${t('Save preferences')}</button><button type="button" class="xp-btn" data-whm-preferences-reload${input.canManage ? '' : ' disabled'}>${t('Reload')}</button><a class="xp-btn" href="#" data-whm-preferences-apply hidden>${t('Apply saved preferences')}</a></div>
        <p class="xp-whm-detail-status" data-whm-preferences-save-status role="status" hidden></p>
      </${container}>
    </section>
  </div>
</section>`
}
