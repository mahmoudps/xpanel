import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const styles = `<style>.xp-acct-enh{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-acct-enh :is(h2,h3,p){margin:0}.xp-acct-enh .xp-whm-detail-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-acct-enh .xp-whm-detail-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-acct-enh form,.xp-acct-enh [data-acct-enh-form]{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-acct-enh [dir=ltr]{unicode-bidi:isolate}.xp-acct-enh[dir=rtl] :is(input,textarea)[dir=auto]{text-align:right}@media(min-width:801px){.xp-acct-enh .xp-whm-detail-card{padding:24px}}</style>`

/** /whm/plans/enhancements body: definitions, plan/account assignments and per-reseller caps. Root only. */
export function renderWhmAccountEnhancementsWorkspace(input: { locale: Locale; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values)), off = input.canManage ? '' : ' disabled'
  const container = input.canManage ? 'form' : 'div'
  const field = (key: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"${key === 'assign-value' ? ' data-acct-enh-value-field' : ''}><label for="acct-enh-${key}">${label}</label>${control}${help ? `<p class="xp-help" id="acct-enh-${key}-help">${help}</p>` : ''}</div>`
  const select = (key: string, extra = ''): string => `<select id="acct-enh-${key}" class="xp-select" data-acct-enh-input="${key}"${extra}${off}><option value="">${t('Not read')}</option></select>`
  const number = (key: string, extra = ''): string => `<input id="acct-enh-${key}" class="xp-input" type="number" inputmode="numeric" dir="ltr" min="0" max="1000000000" step="1" data-acct-enh-input="${key}"${extra}${off}>`
  const table = (key: string, label: string, headers: string[]): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-acct-enh-rows="${key}"><tr><td colspan="${headers.length}">${t('Not read')}</td></tr></tbody></table></div>`
  const form = (key: string, body: string, submit: string): string => `<${container} data-acct-enh-form="${key}"${input.canManage ? ' novalidate' : ''}>${body}<div class="xp-whm-detail-actions"><button type="${input.canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-acct-enh-submit="${key}"${off}>${submit}</button></div></${container}>`
  return `${styles}<div class="xp-acct-enh" data-acct-enh-workspace data-enh-can-manage="${input.canManage}" data-capability-state="${input.canManage ? 'authorized' : 'unavailable'}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <section class="xp-whm-detail-card" aria-labelledby="acct-enh-application-heading">
    <h2 id="acct-enh-application-heading">${t('What enhancements do')}</h2>
    <p class="xp-whm-detail-status" role="status" data-acct-enh-application data-state="unavailable">${t('Enhancements are saved entitlements beyond the plan. No xPanel feature reads them yet, and resellers cannot assign them from their own screens. Saving here changes no account limit.')}</p>
    <p class="xp-whm-detail-status" role="status" data-acct-enh-status data-state="unread">${t('Enhancements have not been read.')}</p>
    <div data-acct-enh-loading aria-busy="true" aria-label="${t('Loading enhancements')}" hidden><span class="xp-skeleton-line"></span><span class="xp-skeleton-line"></span></div>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-acct-enh-refresh${off}>${t('Refresh')}</button></div>
    <p class="xp-whm-detail-status" role="status" data-acct-enh-save-status hidden></p>
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-enh-definitions-heading">
    <h2 id="acct-enh-definitions-heading">${t('Enhancements')}</h2>
    ${table('definitions', t('Defined enhancements'), [t('ID'), t('Label'), t('Kind'), t('Allowed values'), t('Actions')])}
    <div data-acct-enh-empty hidden><h3>${t('No enhancements yet')}</h3><p>${t('Define one below, then assign it to plans or accounts.')}</p></div>
    ${form('definition', `<div class="xp-whm-detail-fields">
      ${field('id', t('ID'), `<input id="acct-enh-id" class="xp-input" dir="ltr" maxlength="48" spellcheck="false" autocomplete="off" data-acct-enh-input="id" aria-describedby="acct-enh-id-help"${off}>`, t('Lowercase letters, digits and hyphens, starting with a letter. Saving an existing ID changes that enhancement.'))}
      ${field('label', t('Label'), `<input id="acct-enh-label" class="xp-input" dir="auto" maxlength="80" autocomplete="off" data-acct-enh-input="label"${off}>`)}
      ${field('kind', t('Kind'), `<select id="acct-enh-kind" class="xp-select" data-acct-enh-input="kind"${off}><option value="flag">${t('On or off')}</option><option value="limit">${t('Number with a range')}</option></select>`)}
      ${field('min', t('Minimum'), number('min'))}
      ${field('max', t('Maximum'), number('max'))}
    </div>`, t('Save enhancement'))}
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-enh-assignments-heading">
    <h2 id="acct-enh-assignments-heading">${t('Assignments')}</h2>
    <p class="xp-help">${t('A plan assignment applies to every account on the plan. An account assignment overrides its plan for that enhancement.')}</p>
    ${table('assignments', t('Assignments'), [t('Applies to'), t('Enhancement'), t('Value'), t('Actions')])}
    ${form('assignment', `<div class="xp-whm-detail-fields">
      ${field('assign-scope', t('Assign to'), `<select id="acct-enh-assign-scope" class="xp-select" data-acct-enh-input="assign-scope"${off}><option value="plan">${t('A plan')}</option><option value="account">${t('An account')}</option></select>`)}
      ${field('assign-target', t('Plan or account'), select('assign-target'))}
      ${field('assign-enhancement', t('Enhancement'), select('assign-enhancement'))}
      ${field('assign-value', t('Value'), number('assign-value'))}
    </div>`, t('Assign'))}
  </section>
  <section class="xp-whm-detail-card" aria-labelledby="acct-enh-limits-heading">
    <h2 id="acct-enh-limits-heading">${t('Reseller limits')}</h2>
    <p class="xp-help">${t("A reseller limit caps how many of the reseller's accounts may hold the enhancement directly. 0 allows none; an empty limit is unlimited. Saving fails when current assignments already exceed the limit.")}</p>
    ${table('limits', t('Reseller limits'), [t('Reseller'), t('Enhancement'), t('Limit'), t('In use'), t('Actions')])}
    ${form('limit', `<div class="xp-whm-detail-fields">
      ${field('limit-reseller', t('Reseller'), select('limit-reseller'))}
      ${field('limit-enhancement', t('Enhancement'), select('limit-enhancement'))}
      ${field('limit-value', t('Limit'), number('limit-value', ' aria-describedby="acct-enh-limit-value-help"'), t('Empty is unlimited.'))}
    </div>`, t('Save limit'))}
  </section>
</div>`
}
