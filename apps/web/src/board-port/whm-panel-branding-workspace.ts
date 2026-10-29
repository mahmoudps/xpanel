import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-whm-branding :is(p,h2,h3,dl,dd){margin:0}.xp-whm-branding__layout{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:24px;align-items:start}.xp-whm-branding__block{display:flex;flex-direction:column;gap:16px;padding-block:16px;border-block-start:1px solid var(--xp-border)}.xp-whm-branding__block:first-of-type{border-block-start:0}.xp-whm-branding__block h3{font-size:var(--xp-type-body);font-weight:var(--xp-weight-semibold)}.xp-whm-branding__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-whm-branding__asset{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.xp-whm-branding__preview{inline-size:96px;block-size:56px;border:1px dashed var(--xp-border);border-radius:8px;display:grid;place-items:center;overflow:hidden}.xp-whm-branding__preview img{max-inline-size:100%;max-block-size:100%}.xp-whm-branding__check{display:flex;gap:8px;align-items:center}.xp-whm-branding [hidden]{display:none!important}@media(max-width:900px){.xp-whm-branding__layout,.xp-whm-branding__grid{grid-template-columns:minmax(0,1fr)}}</style>`

/** Root branding: what users see in the panels, on the sign-in page and in webmail. */
export function renderWhmPanelBrandingWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const text = (key: string, label: string, max: number, technical = false, help = ''): string => `<div class="xp-whm-detail-field"><label for="branding-${key}">${label}</label><input id="branding-${key}" class="xp-input${technical ? ' xp-mono' : ''}"${technical ? ' dir="ltr" spellcheck="false"' : ''} type="text" maxlength="${max}" autocomplete="off" data-branding-input="${key}" disabled>${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
  const asset = (kind: 'logo' | 'favicon', label: string, note: string, accept: string): string => `<div class="xp-whm-branding__asset" data-branding-asset="${kind}">
      <div class="xp-whm-branding__preview" data-branding-preview="${kind}" aria-hidden="true"></div>
      <div><h3>${label}</h3><p class="xp-help">${note}</p><p data-branding-asset-state="${kind}">${t('Not read')}</p></div>
      <input type="file" accept="${accept}" data-branding-file="${kind}" hidden disabled>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-branding-upload="${kind}" aria-label="${kind === 'logo' ? t('Upload panel logo') : t('Upload favicon')}" disabled>${t('Upload')}</button><button type="button" class="xp-btn" data-branding-remove="${kind}" aria-label="${kind === 'logo' ? t('Remove panel logo') : t('Remove favicon')}" disabled>${t('Remove')}</button></div></div>`
  const choice = (key: string, label: string, options: readonly (readonly [string, string])[]): string => `<div class="xp-whm-detail-field"><label for="branding-${key}">${label}</label><select id="branding-${key}" data-branding-input="${key}" disabled>${options.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></div>`
  return `${styles}<section class="xp-whm-detail xp-whm-branding" data-whm-detail-route="/whm/panel/branding" data-branding-workspace data-branding-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <header class="xp-whm-detail-heading"><h1>${t('Branding & themes')}</h1><p>${t('What users see in the panels, on the sign-in page and in webmail.')}</p></header>
  <div class="xp-whm-branding__layout">
    <div class="xp-whm-detail-column">
      <section class="xp-whm-detail-card" aria-labelledby="branding-config-heading"><h2 id="branding-config-heading">${t('Branding configuration')}</h2>
        <p class="xp-whm-detail-status" data-branding-status data-state="unread" role="status">${t('Branding has not been read. No saved values are assumed.')}</p>
        <div class="xp-whm-branding__block"><h3>${t('Brand identity')}</h3><div class="xp-whm-branding__grid">
          ${text('companyName', t('Company name'), 80)}${text('productName', t('Product name'), 40, false, t('Shown in the browser tab instead of xPanel, xWHM or xMail.'))}
          ${text('footerText', t('Footer text'), 200)}
          <label class="xp-whm-branding__check"><input type="checkbox" data-branding-input="hidePoweredBy" disabled> ${t('Hide the “Powered by” line')}</label></div></div>
        <div class="xp-whm-branding__block"><h3>${t('Colors')}</h3><div class="xp-whm-branding__grid">
          ${text('primaryColor', t('Primary color'), 7, true, t('A color like #1D5BD6. Leave empty to keep the theme color.'))}${text('accentColor', t('Accent color'), 7, true)}</div></div>
        <div class="xp-whm-branding__block"><h3>${t('Help and contact')}</h3><div class="xp-whm-branding__grid">
          ${text('supportUrl', t('Support URL'), 2048, true, t('An https:// address, shown as Help in the footer.'))}${text('supportEmail', t('Support email'), 254, true, t('Also shown on the sign-in page and on error pages.'))}</div></div>
        <div class="xp-whm-branding__block"><h3>${t('Default display options')}</h3><p class="xp-help">${t('What a new user sees before choosing their own. The default language is set on the Languages page.')}</p><div class="xp-whm-branding__grid">
          ${choice('defaultTheme', t('Default appearance'), [['light', t('Light')], ['dark', t('Dark')]])}${choice('defaultDensity', t('Default table spacing'), [['comfortable', t('Comfortable')], ['compact', t('Compact')]])}</div></div>
        <p class="xp-whm-detail-status" data-branding-save-status role="status" hidden></p>
        <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-branding-save disabled>${t('Save')}</button><button type="button" class="xp-btn" data-branding-reload${input.canManage ? '' : ' disabled'}>${t('Reload')}</button></div>
      </section>
      <section class="xp-whm-detail-card" aria-labelledby="branding-assets-heading"><h2 id="branding-assets-heading">${t('Logo and favicon')}</h2>
        ${asset('logo', t('Panel logo'), t('PNG or JPEG, up to 512 KiB and 4096 pixels on each side. Shown in the panel header and on the sign-in page.'), 'image/png,image/jpeg')}
        ${asset('favicon', t('Favicon'), t('Square PNG or ICO, up to 128 KiB and 512 pixels. Shown in the browser tab.'), 'image/png,image/x-icon,.ico')}
        <p class="xp-whm-detail-status" data-branding-asset-status role="status" hidden></p>
      </section>
      <section class="xp-whm-detail-card" aria-labelledby="branding-themes-heading"><h2 id="branding-themes-heading">${t('Theme packages')}</h2><p>${t('The theme each interface uses.')}</p>
        <div class="xp-acct-tool__table" tabindex="0" role="region" aria-labelledby="branding-themes-heading"><table class="xp-table"><thead><tr><th scope="col">${t('Interface')}</th><th scope="col">${t('Theme')}</th><th scope="col">${t('Status')}</th></tr></thead><tbody>
          ${['xPanel', 'xWHM', 'xMail', t('Sign-in page')].map(name => `<tr><td><bdi dir="ltr">${name}</bdi></td><td>${t('Classic')}</td><td>${t('Built in')}</td></tr>`).join('')}</tbody></table></div>
        <p class="xp-help">${t('Every theme applies the branding above. No other theme package is installed on this server.')}</p>
      </section>
    </div>
    <aside class="xp-whm-detail-card" aria-labelledby="branding-about-heading"><h2 id="branding-about-heading">${t('About this page')}</h2>
      <dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${t('Access')}</dt><dd>${t('Root only')}</dd></div>
        <div class="xp-whm-detail-field"><dt>${t('Configuration')}</dt><dd data-branding-state>${t('Not read')}</dd></div>
        <div class="xp-whm-detail-field"><dt>${t('Last saved (UTC)')}</dt><dd data-branding-updated>${t('Not read')}</dd></div></dl>
      <p class="xp-help">${t('Changes apply to the next page each person opens. Per-reseller branding is not available in this version.')}</p>
    </aside>
  </div>
</section>`
}
