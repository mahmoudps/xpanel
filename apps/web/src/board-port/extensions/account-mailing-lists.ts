import { type Locale, type MessageValues, translator, localeDirection } from '../../i18n.ts'
import { escapeHtml } from '../../tokens.ts'

/** Account mailing lists workspace (presentation only; controller uses the real route). */
export function renderAccountMailingLists(input: { lang: Locale; expectedAccountId: string; canManage: boolean; domains: readonly string[] }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const disabled = input.canManage ? '' : ' disabled'
  const domains = [...input.domains]
  return `<div class="xp-extension xp-mailing-lists" data-mailing-lists data-account="${escapeHtml(input.expectedAccountId)}" data-mailing-can-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">
    <style>.xp-mailing-lists{display:grid;gap:var(--xp-space-section);min-inline-size:0}.xp-mailing-lists__form{display:grid;gap:var(--xp-space-group);min-inline-size:0;padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-sm);background:var(--xp-bg-surface)}.xp-mailing-lists__form h3{margin:0;font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}.xp-mailing-lists__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field);min-inline-size:0}.xp-mailing-lists textarea{inline-size:100%;min-inline-size:0;box-sizing:border-box;min-block-size:96px;resize:vertical}.xp-mailing-lists__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--xp-space-field)}.xp-mailing-lists [data-mailing-list-status]{overflow-wrap:anywhere}.xp-mailing-lists [data-mailing-list-status][data-state=failed],.xp-mailing-lists [data-mailing-list-status][data-state=uncertain]{padding:var(--xp-space-field);border:1px solid var(--xp-status-critical-border);border-radius:var(--xp-radius-sm);color:var(--xp-status-critical-fg);background:var(--xp-status-critical-bg)}.xp-mailing-lists [data-mailing-list-status][data-state=uncertain]{color:var(--xp-status-warn-fg);border-color:var(--xp-status-warn-border);background:var(--xp-status-warn-bg)}@media(min-width:601px){.xp-mailing-lists__form{padding:var(--xp-space-card)}}@media(max-width:600px){.xp-mailing-lists__actions>button{flex:1 1 auto}}</style>
    <div class="xp-table-wrap" tabindex="0" role="region" aria-label="${t('Mailing lists')}"><table class="xp-table"><thead><tr><th scope="col">${t('Address')}</th><th scope="col">${t('Members')}</th><th scope="col">${t('Moderation')}</th><th scope="col">${t('Archive')}</th><th scope="col">${t('Action')}</th></tr></thead><tbody data-mailing-lists-rows></tbody></table></div>
    <p class="xp-help" data-mailing-list-status role="status">${t('Reading mailing lists…')}</p>
    <div class="xp-mailing-lists__form" data-mailing-list-form role="group" aria-label="${t('Create mailing list')}">
      <h3>${t('Create mailing list')}</h3>
      <div class="xp-mailing-lists__fields">
        <div class="xp-field"><label for="mailing-list-name">${t('List name')}</label><input id="mailing-list-name" class="xp-input xp-mono" dir="ltr" maxlength="64" data-ml-name${disabled}></div>
        <div class="xp-field"><label for="mailing-list-domain">${t('Domain')}</label><select id="mailing-list-domain" class="xp-select xp-mono" data-ml-domain${disabled}>${domains.length ? domains.map(domain => `<option value="${escapeHtml(domain)}">${escapeHtml(domain)}</option>`).join('') : `<option value="">${t('No account domain is available')}</option>`}</select></div>
        <div class="xp-field"><label for="mailing-list-moderation">${t('Moderation')}</label><select id="mailing-list-moderation" class="xp-select" data-ml-moderation${disabled}><option value="members">${t('Members')}</option><option value="open">${t('Open')}</option><option value="moderated">${t('Moderated')}</option></select></div>
        <div class="xp-field"><label for="mailing-list-archive">${t('Archive messages')}</label><label class="xp-check" for="mailing-list-archive"><input id="mailing-list-archive" type="checkbox" checked data-ml-archive${disabled}> ${t('Keep an archive')}</label></div>
      </div>
      <div class="xp-field"><label for="mailing-list-members">${t('Members (one address per line, optional)')}</label><textarea id="mailing-list-members" class="xp-textarea xp-mono" dir="ltr" data-ml-members${disabled}></textarea></div>
      <p class="xp-help">${t('List membership and moderation are stored configuration only; mail delivery to the list is not verified here.')}</p>
      <div class="xp-mailing-lists__actions"><button type="button" class="xp-btn xp-btn--primary" data-ml-create${disabled}>${t(msgctxt('account-mailing-lists', 'Create list'))}</button></div>
    </div>
  </div>`
}
