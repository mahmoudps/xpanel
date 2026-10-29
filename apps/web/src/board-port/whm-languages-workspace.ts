import { LOCALES, SOURCE_LOCALE, languageName, localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-languages :is(p,h2,ul,fieldset){margin:0}.xp-whm-languages__form{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-languages__offered{display:flex;flex-direction:column;gap:12px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-languages__offered legend{padding-inline:8px;font-weight:600}.xp-whm-languages__fields{grid-template-columns:minmax(0,20rem)}.xp-whm-languages__fields .xp-whm-detail-field>label{padding-inline:13px}.xp-whm-languages__loading{display:flex;flex-direction:column;gap:8px}.xp-whm-languages__notes{display:flex;flex-direction:column;gap:8px;padding-inline-start:20px}.xp-whm-languages__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-whm-languages__setting{display:flex;flex-direction:column;gap:4px}.xp-whm-languages__errors{display:flex;flex-direction:column;gap:4px;padding-inline-start:20px;overflow-wrap:anywhere}.xp-whm-languages [hidden]{display:none!important}.xp-whm-languages :is(button,input,select):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>`

/** Server languages: the release locale registry, uploaded PO catalogs, and which locales the panels offer. */
export function renderWhmLanguagesWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = ' disabled', container = input.canManage ? 'form' : 'div', unread = t('Not read')
  const name = (tag: Locale): string => escapeHtml(languageName(tag, input.locale))
  const rows = LOCALES.map(info => {
    const source = info.tag === SOURCE_LOCALE, label = name(info.tag)
    const actions = source
      ? `<button type="button" class="xp-btn" data-whm-languages-download="${info.tag}" aria-label="${t('Download template for {language}', { language: languageName(info.tag, input.locale) })}"${disabled}>${t('Download template (.pot)')}</button>`
      : `<button type="button" class="xp-btn" data-whm-languages-download="${info.tag}" aria-label="${t('Download catalog for {language}', { language: languageName(info.tag, input.locale) })}"${disabled}>${t('Download catalog (.po)')}</button>`
        + `<button type="button" class="xp-btn" data-whm-languages-upload="${info.tag}" aria-label="${t('Upload catalog for {language}', { language: languageName(info.tag, input.locale) })}"${disabled}>${t('Upload catalog (.po)')}</button>`
        + `<input type="file" accept=".po,text/x-gettext-translation" hidden tabindex="-1" aria-hidden="true" data-whm-languages-file="${info.tag}"${disabled}>`
        + `<button type="button" class="xp-btn xp-btn--danger" data-whm-languages-remove="${info.tag}" aria-label="${t('Remove uploaded catalog for {language}', { language: languageName(info.tag, input.locale) })}"${disabled}>${t('Remove uploaded catalog')}</button>`
    return `<tr data-whm-languages-row="${info.tag}"><th scope="row"><span lang="${info.tag}" dir="${info.dir}">${escapeHtml(info.nativeName)}</span>${info.nativeName === languageName(info.tag, input.locale) ? '' : ` <span class="xp-help">${label}</span>`}</th>`
      + `<td><bdi dir="ltr">${info.tag}</bdi></td><td>${info.dir === 'rtl' ? t('Right to left') : t('Left to right')}</td>`
      + `<td data-whm-languages-messages="${info.tag}">${unread}</td><td><div class="xp-whm-languages__setting" data-whm-languages-setting="${info.tag}">${unread}</div></td>`
      + `<td><div class="xp-whm-languages__actions">${actions}</div></td></tr>`
  }).join('')
  const offered = LOCALES.map(info => `<label class="xp-whm-detail-choice"><input type="checkbox" name="offered" value="${info.tag}" data-whm-languages-offered${disabled}><span lang="${info.tag}" dir="${info.dir}">${escapeHtml(info.nativeName)}</span></label>`).join('')
  return `${styles}<section class="xp-whm-detail xp-whm-languages" data-whm-detail-route="/whm/panel/languages" data-whm-languages-workspace data-languages-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('Languages')}</h1><p>${t('Choose which languages the panels offer, and download or upload the translation catalog of each language.')}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" data-whm-detail-section="languages-locales" aria-labelledby="whm-languages-locales-heading">
      <h2 id="whm-languages-locales-heading">${t('Locales in this release')}</h2>
      <p class="xp-help">${t('From the locale registry built into this release. Locales are added by a release, not on this server.')}</p>
      <p class="xp-whm-detail-status" data-whm-languages-status data-state="unread" role="status">${t('The server\'s language settings have not been read. No setting is assumed.')}</p>
      <div class="xp-whm-languages__loading" data-whm-languages-loading aria-label="${t('Loading language settings')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Locales in this release')}"><table class="xp-whm-detail-table xp-table"><thead><tr>${[t('Language'), t('Tag'), t('Direction'), t('Messages'), t('Server setting'), t('Actions')].map(text => `<th scope="col">${text}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <p class="xp-help" id="whm-languages-catalog-help">${t('Catalogs are gettext .po files of up to 4 MiB. Each upload is checked against this release: its Language header, known messages only, valid ICU messages, the same placeholders and ASCII digits. An empty translation keeps the release text.')}</p>
      <p class="xp-whm-detail-status" data-whm-languages-catalog-status role="status" hidden></p>
      <ul class="xp-whm-languages__errors" data-whm-languages-errors hidden></ul>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="languages-notes" aria-labelledby="whm-languages-notes-heading">
      <h2 id="whm-languages-notes-heading">${t('How languages work')}</h2>
      <ul class="xp-whm-languages__notes">
        <li>${t('Messages are authored in English; every other catalog translates it.')}</li>
        <li>${t('Translations are gettext .po catalogs with ICU message format, shipped with each release. An uploaded catalog is merged over the release catalog when the panel next starts.')}</li>
        <li>${t('Right-to-left languages are laid out right to left. Digits stay ASCII 0-9 in every locale.')}</li>
        <li>${t('Each person switches language from the header. A request asks for one with ?lang=, otherwise the browser\'s language is matched among the offered languages, then the default language is used.')}</li>
      </ul>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="languages-policy" aria-labelledby="whm-languages-policy-heading">
      <h2 id="whm-languages-policy-heading">${t('Application locales')}</h2>
      <p class="xp-help">${t('Which locales the panels offer and which one is used when a browser asks for none of them. Changes apply to the next page that opens.')}</p>
      <${container} class="xp-whm-languages__form" data-whm-languages-form aria-labelledby="whm-languages-policy-heading"${input.canManage ? ' novalidate' : ''}>
        <div class="xp-whm-detail-fields xp-whm-languages__fields"><div class="xp-whm-detail-field"><label for="whm-languages-default">${t('Default language')}</label><select id="whm-languages-default" name="defaultLocale" data-whm-languages-default${disabled}>${LOCALES.map(info => `<option value="${info.tag}">${name(info.tag)}</option>`).join('')}</select></div></div>
        <fieldset class="xp-whm-languages__offered" aria-describedby="whm-languages-offered-help"${disabled}><legend>${t('Offered languages')}</legend><p class="xp-help" id="whm-languages-offered-help">${t('Offer at least one language. The default language must be offered.')}</p><div class="xp-whm-detail-choice-grid">${offered}</div></fieldset>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-languages-save${disabled}>${t('Save locales')}</button><button type="button" class="xp-btn" data-whm-languages-reload${input.canManage ? '' : disabled}>${t('Reload')}</button></div>
        <p class="xp-whm-detail-status" data-whm-languages-save-status role="status" hidden></p>
      </${container}>
    </section>
  </div>
</section>`
}
