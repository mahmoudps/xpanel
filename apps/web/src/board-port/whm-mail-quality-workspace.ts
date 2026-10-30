import { classicWhmClientTemplates } from '../themes/classic/whm-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export interface WhmMailQualityWorkspaceInput { locale: Locale; canRead: boolean }

/** Live DNS deliverability checks for /whm/email/quality. Read-only: there is no form, and rows are painted only from an authorized fresh read. */
export function renderWhmMailQualityWorkspace({ locale, canRead }: WhmMailQualityWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const notRead = t('Not read')
  const fact = (label: string, key: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-mail-quality-fact="${key}">${notRead}</bdi></dd></div>`
  const headers = [t('Domain'), t('Account'), 'MX', 'SPF', 'DKIM', 'DMARC', t('Reverse DNS'), t('Checked (UTC)')]
  return `<section class="xp-whm-mail-quality" data-whm-mail-quality-workspace data-mail-quality-can-read="${canRead}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="whm-mail-quality-summary-heading">${classicWhmClientTemplates('mail-quality')}
    <style>.xp-whm-mail-quality h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-whm-mail-quality{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-mail-quality :is(h2,p,dl,dd,ul){margin:0}.xp-whm-mail-quality__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-mail-quality__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-mail-quality__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-whm-mail-quality__facts>div,.xp-whm-mail-quality__check{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
    .xp-whm-mail-quality dt{font-weight:600}.xp-whm-mail-quality dd{overflow-wrap:anywhere}.xp-whm-mail-quality__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-whm-mail-quality button{min-block-size:44px}.xp-whm-mail-quality__help{display:flex;flex-direction:column;gap:var(--xp-space-field);padding-inline-start:24px}
    .xp-whm-mail-quality td{vertical-align:top}.xp-whm-mail-quality td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-whm-mail-quality__check strong[data-state=problem]{color:var(--xp-status-critical-fg)}.xp-whm-mail-quality__check strong[data-state=unavailable]{color:var(--xp-status-warn-fg)}.xp-whm-mail-quality [hidden]{display:none}.xp-whm-mail-quality :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}
    @media(min-width:601px){.xp-whm-mail-quality__card{padding:24px}}@media(max-width:639px){.xp-whm-mail-quality__actions>button{flex:1 1 auto}}
    </style>
    <section class="xp-whm-mail-quality__card" aria-labelledby="whm-mail-quality-summary-heading">
      <div class="xp-whm-mail-quality__heading"><h2 id="whm-mail-quality-summary-heading">${t('Sending identity')}</h2><button type="button" class="xp-btn" data-whm-mail-quality-refresh${canRead ? '' : ' disabled'}>${t('Reload domains')}</button></div>
      <p class="xp-whm-detail-status" data-whm-mail-quality-status data-state="unread" role="status">${t('Hosted mail domains have not been read.')}</p>
      <dl class="xp-whm-mail-quality__facts">${fact(t('Server hostname'), 'hostname')}${fact(t('HELO name'), 'helo')}${fact(t('Sending addresses'), 'addresses')}${fact(t('Domains checked'), 'checked')}${fact(t('Domains with problems'), 'problems')}${fact(t('Domains with unavailable checks'), 'unavailable')}${fact(t('Last check (UTC)'), 'checked-at')}</dl>
      <ul class="xp-whm-mail-quality__help">
        <li class="xp-help">${t("Checks query live DNS through this server's resolver and change nothing. Fix problems in")} <a href="/whm/dns">${t('DNS zones')}</a> ${t('or review')} <a href="/whm/email/server">${t('Mail server')}</a>.</li>
        <li class="xp-help">${t('SPF is evaluated for the sending addresses. include: and redirect= are followed one level; ptr, exists and macros are reported as not decidable.')}</li>
        <li class="xp-help">${t('DKIM is compared with the signing key on this server, or with the saved zone record when the key cannot be read. Reverse DNS is set by the provider of each IP address.')}</li>
      </ul>
    </section>
    <section class="xp-whm-mail-quality__card" aria-labelledby="whm-mail-quality-domains-heading">
      <h2 id="whm-mail-quality-domains-heading">${t('Hosted mail domains')}</h2>
      <div class="xp-whm-mail-quality__actions"><span data-whm-mail-quality-selected>${t('Selected: 0')}</span><button type="button" class="xp-btn xp-btn--primary" data-whm-mail-quality-check disabled>${t('Check selected')}</button></div>
      <p class="xp-help">${t('Up to 50 domains per check, 5 at a time, within a bounded time limit.')}${canRead ? '' : ' ' + t('Mail quality checks require root authorization.')}</p>
      <p class="xp-whm-detail-status" data-whm-mail-quality-result role="status" hidden></p>
      <p class="xp-help" data-whm-mail-quality-truncated hidden>${t('Only the first 2000 domains are listed.')}</p>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Hosted mail domains')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Hosted mail domains')}</caption><thead><tr><th scope="col"><input type="checkbox" data-whm-mail-quality-select-all aria-label="${t('Select the first 50 domains')}" disabled></th>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-mail-quality-rows><tr><td colspan="9">${t('No domains have been read.')}</td></tr></tbody></table></div>
    </section>
  </section>`
}
