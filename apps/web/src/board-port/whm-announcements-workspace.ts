import { classicWhmClientTemplates } from './whm-client-templates.ts'
import { LOCALES, languageName, localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS, ACCOUNT_ANNOUNCEMENT_STYLES } from './account-announcements-banner.ts'
import type { AccountAnnouncementLabels } from './account-announcements-banner-client.ts'

const styles = `<style>.xp-whm-announcements :is(h3,p,fieldset){margin:0}.xp-whm-announcements__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-announcements__heading{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between}.xp-whm-announcements__loading,.xp-whm-announcements__empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}.xp-whm-announcements__set{display:flex;flex-direction:column;gap:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;padding:16px;min-inline-size:0}.xp-whm-announcements .xp-whm-detail-table th{white-space:nowrap}.xp-whm-announcements[dir="ltr"] .xp-whm-announcements__set :is(input,textarea)[dir="rtl"]{text-align:left}.xp-whm-announcements[dir="rtl"] .xp-whm-announcements__set :is(input,textarea)[dir="rtl"]{text-align:right}.xp-whm-announcements__set legend{padding-inline:8px;font-weight:600}.xp-whm-announcements__preview{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-whm-announcements__preview-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-whm-announcements__cell{display:flex;flex-direction:column;gap:8px}.xp-whm-announcements__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-whm-announcements [hidden]{display:none}@media(max-width:800px){.xp-whm-announcements__preview-pair{grid-template-columns:minmax(0,1fr)}}</style>`

/** Languages an announcement is written in, one title and message each (the authored-content model). */
const CONTENT_LOCALES: readonly Locale[] = LOCALES.map(info => info.tag)

/** Notice chrome in the preview's own language, so each preview reads as account owners will see it. */
const previewLabels = (language: Locale): AccountAnnouncementLabels => {
  const tr = translator(language)
  return { info: tr('Notice'), warning: tr('Warning'), maintenance: tr('Maintenance'), until: tr('Until {end}'), dismiss: tr('Dismiss'), dismissFor: tr('Dismiss announcement: {title}') }
}

/** Complete /whm/accounts/announcements page body: list, bilingual editor with preview, archive. Root only (catalog navigation roles). */
export function renderWhmAnnouncementsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const disabled = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const headers = [t('Title'), t('Severity'), t('Audience'), t('Shown (UTC)'), t('State'), t('Updated (UTC)'), t('Actions')]
  const field = (key: string, label: string, control: string, help = '', hidden = false): string => `<div class="xp-whm-detail-field"${key.startsWith('audience-') ? ` data-whm-announcements-audience-field="${key.slice(9)}"` : ''}${hidden ? ' hidden' : ''}><label for="whm-announcements-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="whm-announcements-${key}-help">${help}</p>` : ''}</div>`
  const described = (key: string, help: string): string => help ? ` aria-describedby="whm-announcements-${key}-help"` : ''
  const text = (language: Locale) => {
    const dir = localeDirection(language)
    return `<fieldset class="xp-whm-announcements__set"${disabled}><legend>${escapeHtml(languageName(language, input.locale))}</legend>
          ${field(`title-${language}`, t('Title'), `<input id="whm-announcements-title-${language}" type="text" name="title-${language}" lang="${language}" dir="${dir}" maxlength="140" autocomplete="off" required aria-describedby="whm-announcements-text-help" data-whm-announcements-input="title-${language}"${disabled}>`)}
          ${field(`body-${language}`, t('Message'), `<textarea id="whm-announcements-body-${language}" name="body-${language}" lang="${language}" dir="${dir}" rows="5" maxlength="2000" required aria-describedby="whm-announcements-text-help" data-whm-announcements-input="body-${language}"${disabled}></textarea>`)}
        </fieldset>`
  }
  const option = (value: string, label: string): string => `<option value="${value}">${label}</option>`
  const severities = Object.entries(ACCOUNT_ANNOUNCEMENT_SEVERITY_LABELS).map(([key, label]) => option(key, t(label))).join('')
  const usernamesHelp = t('Account usernames, one per line or comma-separated, up to 100. Each must exist.')
  const startsHelp = t('Empty starts as soon as it is saved.'), endsHelp = t('Empty keeps it shown until you archive it.')
  return `${ACCOUNT_ANNOUNCEMENT_STYLES}${styles}<section class="xp-whm-detail xp-whm-announcements" data-whm-detail-route="/whm/accounts/announcements" data-whm-announcements-workspace data-announcements-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${classicWhmClientTemplates('announcements')}
  <header class="xp-whm-detail-heading"><h1>${t('Announcements')}</h1><p>${t("Notices shown on account owners' xPanel home page while they are live, in English and Arabic. Owners can dismiss a notice for their own account. Nothing is emailed.")}</p></header>
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" data-whm-detail-section="announcements-list" aria-labelledby="whm-announcements-list-heading">
      <div class="xp-whm-announcements__heading"><h2 id="whm-announcements-list-heading">${t('Saved announcements')}</h2><span class="xp-help">${t('Times in UTC')}</span></div>
      <p class="xp-whm-detail-status" data-whm-announcements-status data-state="unread" role="status">${t('Announcements have not been read. No announcement is assumed to be shown.')}</p>
      <div class="xp-whm-announcements__loading" data-whm-announcements-loading aria-busy="true" aria-label="${t('Loading announcements')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span><span class="xp-skeleton-line xp-skeleton-line--short"></span></div>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Saved announcements')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('Announcements, newest first')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-announcements-rows><tr><td colspan="7">${t('Not read')}</td></tr></tbody></table></div>
      <div class="xp-whm-announcements__empty" data-whm-announcements-empty hidden><h3>${t('No announcements yet')}</h3><p>${t('Create one below. Account owners see no notice until then.')}</p></div>
      <p class="xp-help">${t('Newest first. Up to 50 announcements can be active. Archived ones are kept as history, up to 100 records in all; past that, the oldest archived record is removed.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-announcements-refresh${disabled}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-whm-announcements-list-status role="status" hidden></p>
    </section>
    <section class="xp-whm-detail-card" data-whm-detail-section="announcements-editor" aria-labelledby="whm-announcements-editor-heading">
      <h2 id="whm-announcements-editor-heading" data-whm-announcements-editor-heading>${t('Create announcement')}</h2>
      <${container} class="xp-whm-announcements__group" data-whm-announcements-form aria-labelledby="whm-announcements-editor-heading"${input.canManage ? ' novalidate' : ''}>
        ${CONTENT_LOCALES.map(text).join('\n        ')}
        <p class="xp-help" id="whm-announcements-text-help">${t('Plain text only: HTML is refused and links are not made clickable. Titles up to 140 characters, messages up to 2000. Both languages are required.')}</p>
        <div class="xp-whm-detail-fields">
          ${field('severity', t('Severity'), `<select id="whm-announcements-severity" name="severity" data-whm-announcements-input="severity"${disabled}>${severities}</select>`)}
          ${field('audience', t('Audience'), `<select id="whm-announcements-audience" name="audience" data-whm-announcements-input="audience"${disabled}>${option('all', t('All accounts'))}${option('plan', t('Accounts on a plan'))}${option('reseller', t("A reseller's accounts"))}${option('accounts', t('Listed accounts'))}</select>`)}
          ${field('audience-plan', t('Plan'), `<select id="whm-announcements-audience-plan" name="plan" data-whm-announcements-input="plan"${disabled}><option value="">${t('Not read')}</option></select>`, '', true)}
          ${field('audience-reseller', t('Reseller'), `<select id="whm-announcements-audience-reseller" name="reseller" data-whm-announcements-input="reseller"${disabled}><option value="">${t('Not read')}</option></select>`, '', true)}
          ${field('audience-accounts', t('Accounts'), `<textarea id="whm-announcements-audience-accounts" name="usernames" dir="ltr" rows="3" maxlength="1800" spellcheck="false" autocomplete="off" placeholder="alice" data-whm-announcements-input="usernames"${described('audience-accounts', usernamesHelp)}${disabled}></textarea>`, usernamesHelp, true)}
        </div>
        <div class="xp-whm-detail-fields">
          ${field('starts', t(msgctxt('whm-announcements-workspace', 'Starts (UTC)')), `<input id="whm-announcements-starts" type="datetime-local" name="starts" dir="ltr" data-whm-announcements-input="starts"${described('starts', startsHelp)}${disabled}>`, startsHelp)}
          ${field('ends', t(msgctxt('whm-announcements-workspace', 'Ends (UTC)')), `<input id="whm-announcements-ends" type="datetime-local" name="ends" dir="ltr" data-whm-announcements-input="ends"${described('ends', endsHelp)}${disabled}>`, endsHelp)}
        </div>
        <section class="xp-whm-announcements__preview" aria-labelledby="whm-announcements-preview-heading">
          <h3 id="whm-announcements-preview-heading">${t('Preview')}</h3>
          <p class="xp-help" data-whm-announcements-preview-empty>${t('Fill in both titles and messages to see how account owners will see the notice.')}</p>
          <div class="xp-whm-announcements__preview-pair">${CONTENT_LOCALES.map(language => `<div class="xp-account-announcements" data-whm-announcements-preview="${language}" lang="${language}" dir="${localeDirection(language)}" data-whm-announcements-labels="${escapeHtml(JSON.stringify(previewLabels(language)))}" aria-label="${t('{language} preview', { language: languageName(language, input.locale) })}" hidden></div>`).join('')}</div>
        </section>
        <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-whm-announcements-save${disabled}>${t('Create announcement')}</button><button type="button" class="xp-btn" data-whm-announcements-cancel hidden${disabled}>${t('Cancel editing')}</button></div>
        <p class="xp-whm-detail-status" data-whm-announcements-save-status role="status" hidden></p>
      </${container}>
    </section>
  </div>
</section>`
}
