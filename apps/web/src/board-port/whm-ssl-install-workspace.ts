import { sslInstallTemplates } from './data-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
/** Manual certificate installation wizard body; every control starts disabled until the client binding reads authorized data. */
export function renderWhmSslInstallWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const area = (key: string, label: string, help: string) => `<div class="xp-whm-ssl-install__field"><label for="whm-ssl-install-${key}">${label}</label><textarea id="whm-ssl-install-${key}" class="xp-textarea xp-mono" dir="ltr" data-ssl-install-${key} spellcheck="false" autocomplete="off" aria-describedby="whm-ssl-install-${key}-help" disabled></textarea><p class="xp-help" id="whm-ssl-install-${key}-help">${help}</p></div>`
  const steps = [t('Domain and names'), t('Certificate and key'), t('Result')]
  return `<div class="xp-whm-ssl-install" data-whm-ssl-install data-ssl-install-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-whm-ssl-install{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-ssl-install :is(p,h3,dl,dd,ul){margin:0}.xp-whm-ssl-install fieldset{display:flex;flex-direction:column;gap:16px;min-inline-size:0;margin:0;padding:0;border:0}.xp-whm-ssl-install legend{padding:0;margin-block-end:16px;font-weight:600}.xp-whm-ssl-install__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-ssl-install label{margin:0;text-align:start}.xp-whm-ssl-install :is(select,textarea){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;font:inherit}.xp-whm-ssl-install textarea{min-block-size:160px;resize:vertical;font-family:var(--xp-font-mono,monospace)}.xp-whm-ssl-install[dir=rtl] [dir=ltr]{text-align:right}.xp-whm-ssl-install__steps{display:flex;flex-wrap:wrap;gap:16px;list-style:none;margin:0;padding:0}.xp-whm-ssl-install__steps li{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-whm-ssl-install__steps span:first-child{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border,#e2e6ec);border-radius:50%;font-variant-numeric:tabular-nums}.xp-whm-ssl-install__steps [aria-current=step]{font-weight:600}.xp-whm-ssl-install__names{display:flex;flex-direction:column;gap:8px}.xp-whm-ssl-install__names label{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-whm-ssl-install__checks{display:flex;flex-direction:column;gap:8px;padding-inline-start:16px}.xp-whm-ssl-install dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.xp-whm-ssl-install dl>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-ssl-install dd{overflow-wrap:anywhere}.xp-whm-ssl-install [hidden]{display:none}</style>
    <ol class="xp-whm-ssl-install__steps" aria-label="${t('Installation steps')}">${steps.map((label, index) => `<li data-ssl-install-step="${index + 1}"${index === 0 ? ' aria-current="step"' : ''}><span aria-hidden="true">${index + 1}</span><span>${label}</span></li>`).join('')}</ol>
    <p class="xp-whm-detail-status" data-ssl-install-status data-state="unread" role="status">${t('Hosted domains have not been read. Nothing will be uploaded until you install.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ssl-install-refresh disabled>${t('Read hosted domains')}</button></div>
    <fieldset aria-describedby="whm-ssl-install-target-help"><legend>${t('1. Domain and names')}</legend>
      <div class="xp-whm-ssl-install__field"><label for="whm-ssl-install-domain">${t('Hosted domain')}</label><select id="whm-ssl-install-domain" class="xp-select" dir="ltr" data-ssl-install-domain disabled><option value="">${t('Not read')}</option></select></div>
      <fieldset class="xp-whm-ssl-install__names" data-ssl-install-names><legend>${t('Names the certificate must also cover')}</legend><p class="xp-help" data-ssl-install-names-empty>${t('Choose a domain to list its www name and the other domains of its account.')}</p></fieldset>
      <p class="xp-help" id="whm-ssl-install-target-help">${t('The selected domain is always required. Every name the certificate lists must belong to the same account.')}</p>
    </fieldset>
    <fieldset><legend>${t('2. Certificate and key')}</legend>
      ${area('certificate', t('Site certificate (PEM)'), t('Begins with <bdi dir="ltr">-----BEGIN CERTIFICATE-----</bdi>. You may paste the whole chain here and leave the CA bundle empty.'))}
      ${area('chain', t(msgctxt('whm-ssl-install-workspace', 'CA bundle (optional)')), t('Intermediate certificates in order, starting with the one that signed your certificate. Nothing is fetched to complete a missing chain.'))}
      ${area('key', t('Private key (PEM)'), t('Without a passphrase. It is sent once, stored on this server readable only by root and never shown again.'))}
      <ul class="xp-whm-ssl-install__checks" data-ssl-install-checks aria-live="polite"><li>${t('No certificate material entered.')}</li></ul>
      <p class="xp-help">${t('These are structural checks only. Before anything is written, the server checks the validity dates, the names, the chain order and signatures, the key strength and that the key matches the certificate.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ssl-install-submit disabled>${t('Install certificate')}</button><button type="button" class="xp-btn" data-ssl-install-clear disabled>${t('Clear form')}</button></div>
    </fieldset>
    <section class="xp-whm-ssl-install__result" data-ssl-install-result aria-labelledby="whm-ssl-install-result-heading" hidden><h3 id="whm-ssl-install-result-heading">${t('3. Result')}</h3><dl data-ssl-install-facts></dl></section>
  ${sslInstallTemplates()}</div>`
}

/** "Your choices" summary for the page aside; values are painted by the same binding. */
export function renderWhmSslInstallChoices(input: { locale: Locale }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const rows: [string, string][] = [['domain', t('Domain')], ['names', t('Names to cover')], ['certificates', t('Certificates entered')], ['key', t('Private key')]]
  return `<dl class="xp-whm-detail-fields" data-ssl-install-choices lang="${input.locale}" dir="${localeDirection(input.locale)}">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-ssl-install-choice="${key}">${t('Not chosen')}</dd></div>`).join('')}</dl>`
}
