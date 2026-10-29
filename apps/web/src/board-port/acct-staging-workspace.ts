import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /domains/staging body. Domains, staging records, reviews and results are filled by ACCT_STAGING_CLIENT_BINDING from authorized reads only. */
export function renderAccountStagingWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values))
  const table = (label: string, marker: string, headers: readonly string[], empty: string): string => `<div class="xp-account-staging__table" role="region" tabindex="0" aria-label="${label}"><table class="xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-staging-${marker}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const fact = (key: string, label: string): string => `<div class="xp-field"><dt>${label}</dt><dd data-staging-${key}>${t('Not read')}</dd></div>`
  return `<div class="xp-account-staging" data-account-staging data-account="${escapeHtml(input.accountId)}" data-staging-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">
    <style>.xp-account-staging{display:grid;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-account-staging :is(h2,h3,p,dl,dd,ul){margin:0}.xp-account-staging__card{display:grid;gap:var(--xp-space-group,24px);min-inline-size:0;padding:var(--xp-space-field,16px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-md,8px);background:var(--xp-bg-surface)}@media (min-width:960px){.xp-account-staging__card{padding:24px}}.xp-account-staging__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-account-staging__facts .xp-field{display:grid;gap:8px;text-align:start}.xp-account-staging__table{overflow-x:auto;min-inline-size:0}.xp-account-staging td{overflow-wrap:anywhere}.xp-account-staging__actions{display:flex;flex-wrap:wrap;gap:8px}.xp-account-staging__rules{display:grid;gap:16px;padding-inline-start:16px;line-height:1.7}.xp-account-staging :is(button,input):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>
    <p data-staging-status role="status" data-state="${input.canManage ? 'unread' : 'unavailable'}">${input.canManage ? t('Staging copies have not been read.') : t('Staging sites are not available for this account. Nothing was read or changed.')}</p>
    <section class="xp-account-staging__card" aria-labelledby="account-staging-list"><h2 id="account-staging-list">${t('Staging copies')}</h2>
      <p class="xp-help">${t('A staging copy holds the files of one site in a private folder of your home directory. Change it, review the differences, then promote them to the live site.')}</p>
      ${table(t('Sites and their staging copies'), 'rows', [t('Domain'), t('Staging folder'), t('State'), t('Files'), t('Created (UTC)'), t('Last promoted (UTC)'), t('Actions')], t('Not read'))}
      <div class="xp-account-staging__actions"><button type="button" class="xp-btn" data-staging-refresh${input.canManage ? '' : ' disabled'}>${t('Refresh')}</button></div>
    </section>
    <section class="xp-account-staging__card" aria-labelledby="account-staging-review"><h2 id="account-staging-review">${t('Review changes')}</h2>
      <dl class="xp-account-staging__facts">${fact('domain', t('Domain'))}${fact('live', t('Live files'))}${fact('staging', t('Staging files'))}${fact('changes', t('Changes'))}</dl>
      ${table(t('Changes to promote'), 'review', [t('File'), t('Change'), t('Size')], t('No changes have been reviewed.'))}
      <label class="xp-check"><input type="checkbox" data-staging-ack disabled><span>${t('I reviewed these changes. Replaced and removed live files are moved to the trash first.')}</span></label>
      <div class="xp-account-staging__actions"><button type="button" class="xp-btn xp-btn--primary" data-staging-promote disabled>${t('Promote to live')}</button></div>
    </section>
    <section class="xp-account-staging__card" aria-labelledby="account-staging-result"><h2 id="account-staging-result">${t('Result')}</h2>
      ${table(t('Staging results'), 'results', [t('File'), t('Change'), t('Result')], t('No change has run.'))}
    </section>
    <section class="xp-account-staging__card" role="note" aria-labelledby="account-staging-how"><h2 id="account-staging-how">${t('How staging works')}</h2><ul class="xp-account-staging__rules">${[
      t('Only files are staged. Databases are not copied; a site that uses a database keeps using the live one.'),
      t('A staging copy holds up to 500 regular files of up to 2 MiB each and 64 MiB in total. Sites with links cannot be staged.'),
      t('To preview the staging copy on its own address, add a subdomain whose document root is the staging folder.'),
      t('Promoting moves every replaced or removed live file to the trash, where you can restore it. Files added by the promotion are not removed by a restore.'),
      t('Discarding moves the staging folder to the trash.'),
    ].map(item => `<li>${item}</li>`).join('')}</ul></section>
  </div>`
}
