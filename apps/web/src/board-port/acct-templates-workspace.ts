import { classicAccountLifecycleTemplates } from './account-lifecycle-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-acct-templates{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-acct-templates :is(h2,h3,p,fieldset){margin:0}.xp-acct-templates .xp-whm-detail-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-acct-templates .xp-whm-detail-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.xp-acct-templates fieldset{display:flex;flex-direction:column;gap:16px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px;min-inline-size:0}.xp-acct-templates legend{padding-inline:8px;font-weight:600}.xp-acct-templates__plans{display:flex;flex-wrap:wrap;gap:8px 24px}.xp-acct-templates__plans label{display:inline-flex;gap:8px;align-items:center;min-block-size:44px}.xp-acct-templates textarea{box-sizing:border-box;inline-size:100%;min-block-size:160px;resize:vertical}.xp-acct-templates [data-acct-templates-input="zone"]{font-family:var(--xp-font-mono,"IBM Plex Mono",monospace);text-align:left}.xp-acct-templates code{font-family:var(--xp-font-mono,"IBM Plex Mono",monospace)}.xp-acct-templates [dir=ltr]{unicode-bidi:isolate}.xp-acct-templates[dir=rtl] :is(input,textarea)[dir=auto]{text-align:right}@media(min-width:801px){.xp-acct-templates .xp-whm-detail-card{padding:24px}}</style>`

/** /whm/accounts/templates body: saved templates, editor with zone records and page text, server preview. Root only. */
export function renderWhmAccountTemplatesWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values)), off = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const field = (key: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="acct-templates-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="acct-templates-${key}-help">${help}</p>` : ''}</div>`
  const page = (key: 'defaultPage' | 'suspendedPage', legend: string, help: string): string => `<fieldset${off}><legend>${legend}</legend><p class="xp-help">${help}</p>
        ${field(`${key}-title`, t('Title'), `<input id="acct-templates-${key}-title" class="xp-input" maxlength="140" dir="auto" autocomplete="off" data-acct-templates-input="${key}.title"${off}>`)}
        ${field(`${key}-body`, t('Message'), `<textarea id="acct-templates-${key}-body" class="xp-input" rows="4" maxlength="2000" dir="auto" data-acct-templates-input="${key}.body"${off}></textarea>`)}</fieldset>`
  const placeholders = ['%domain%', '%ipv4%', '%ipv6%', '%mailhost%'].map(item => `<code dir="ltr">${item}</code>`).join(', ')
  return `${styles}<div class="xp-acct-templates" data-acct-templates-workspace data-templates-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <section class="xp-whm-detail-card" aria-labelledby="acct-templates-application-heading">
    <h2 id="acct-templates-application-heading">${t('Where templates apply')}</h2>
    <p class="xp-whm-detail-status" role="status" data-acct-templates-application data-state="ready">${t('A new account whose plan uses a template gets the default zone plus the template records. Existing accounts and zones do not change.')}</p>
    <p class="xp-whm-detail-status" role="status" data-acct-templates-pages data-state="unavailable">${t('The default and suspended page text is saved only. The web server still shows its shipped pages, because this server has no publisher for those pages yet.')}</p>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-templates-list-heading">
    <h2 id="acct-templates-list-heading">${t('Saved templates')}</h2>
    <p class="xp-whm-detail-status" role="status" data-acct-templates-status data-state="unread">${t('Templates have not been read.')}</p>
    <div data-acct-templates-loading aria-busy="true" aria-label="${t('Loading templates')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span></div>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Saved templates')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Account creation templates')}</caption><thead><tr>${[t('Name'), t('Plans'), t('Zone records'), t('Updated (UTC)'), t('Actions')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-acct-templates-rows><tr><td colspan="5">${t('Not read')}</td></tr></tbody></table></div>
    <div data-acct-templates-empty hidden><h3>${t('No templates yet')}</h3><p>${t('Create one below. A plan uses at most one template.')}</p></div>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-acct-templates-refresh${off}>${t('Refresh')}</button></div>
    <p class="xp-whm-detail-status" role="status" data-acct-templates-list-status hidden></p>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-templates-editor-heading">
    <h2 id="acct-templates-editor-heading" data-acct-templates-editor-heading>${t('Create template')}</h2>
    <${container} class="xp-acct-templates" data-acct-templates-form${input.canManage ? ' novalidate' : ''}>
      <div class="xp-whm-detail-fields">${field('name', t('Template name'), `<input id="acct-templates-name" class="xp-input" maxlength="64" dir="auto" autocomplete="off" data-acct-templates-input="name"${off}>`)}</div>
      <fieldset${off}><legend>${t('Plans that use this template')}</legend><div class="xp-acct-templates__plans" data-acct-templates-plans><p class="xp-help">${t('Plans have not been read.')}</p></div></fieldset>
      ${field('zone', t('Extra zone records'), `<textarea id="acct-templates-zone" class="xp-input" rows="8" dir="ltr" spellcheck="false" autocomplete="off" data-acct-templates-input="zone" aria-describedby="acct-templates-zone-help"${off}></textarea>`, t('One record per line: name, TTL in seconds, type, the priority for MX and SRV, then the content, for example: shop 3600 CNAME www.%domain%. These are added to the default zone. Lines starting with ; are ignored. Placeholders: {placeholders}. A line using %ipv6% is left out for an account without IPv6.', { placeholders: '__PLACEHOLDERS__' }).replace('__PLACEHOLDERS__', placeholders))}
      ${page('defaultPage', t('Default website page'), t('Plain text shown on a new site before the owner uploads files.'))}
      ${page('suspendedPage', t('Suspended account page'), t('Plain text shown while an account is suspended.'))}
      <div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-acct-templates-save${off}>${t('Create template')}</button><button type="button" class="xp-btn" data-acct-templates-cancel hidden${off}>${t('Cancel editing')}</button></div>
      <p class="xp-whm-detail-status" role="status" data-acct-templates-save-status hidden></p>
    </${container}>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-templates-preview-heading">
    <h2 id="acct-templates-preview-heading">${t('Zone preview')}</h2>
    <p class="xp-help" data-acct-templates-preview-note>${t('Choose Edit on a saved template to see its full zone for example.com with documentation addresses 192.0.2.10 and 2001:db8::10. Unsaved changes are checked when you save.')}</p>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Zone preview')}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${t('Zone preview')}</caption><thead><tr>${[t('Name'), 'TTL', t('Type'), t('Priority'), t('Content')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-acct-templates-preview><tr><td colspan="5">${t('No template selected')}</td></tr></tbody></table></div>
  </section>
${classicAccountLifecycleTemplates('templates')}</div>`
}
