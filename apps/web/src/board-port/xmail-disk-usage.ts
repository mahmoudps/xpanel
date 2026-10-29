import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/tools/disk-usage: per-folder usage and quota of the sealed mailbox, cleanup preview, move to Trash and permanent delete from Trash. */
export function renderMailDiskUsage(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const notRead = t('Not read')
  const columns = [t('Folder'), t('Messages'), t('Unread'), t('Size'), t('Measured by')]
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-mail-usage-fact="${key}">${notRead}</bdi></dd></div>`
  return `<section class="xp-card xp-mail-usage" data-mail-disk-usage data-usage-mailbox="${escapeHtml(input.mailbox)}" data-usage-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-usage-heading">
    <style>.xp-mail-usage{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-usage :is(h2,h3,p,dl,dd){margin:0}.xp-mail-usage form{display:flex;flex-direction:column;gap:16px;margin:0}.xp-mail-usage__fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xp-mail-usage .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-usage :is(input:not([type=checkbox]),select){inline-size:100%;min-block-size:44px;box-sizing:border-box}.xp-mail-usage button{min-block-size:44px}.xp-mail-usage__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-usage__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-mail-usage__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-usage dd,.xp-mail-usage td{overflow-wrap:anywhere}.xp-mail-usage__check{display:flex;gap:8px;align-items:flex-start}.xp-mail-usage__preview{display:flex;flex-direction:column;gap:24px;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-mail-usage meter{inline-size:100%}.xp-mail-usage [hidden]{display:none}@media(min-width:601px){.xp-mail-usage{padding:24px}}@media(max-width:799px){.xp-mail-usage__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <h2 id="mail-usage-heading">${t('Mailbox disk usage')}</h2>
    <p class="xp-help">${t('Folder sizes and message counts are read from the mail server. Cleanup moves messages to Trash; only messages already in Trash can be deleted permanently.')}</p>
    <p class="xp-help" data-mail-usage-status data-state="unread" role="status">${input.canManage ? t('Disk usage has not been read.') : t('Disk usage is unavailable for this mailbox session. Nothing was read.')}</p>
    <dl class="xp-mail-usage__facts"><div><dt>${t('Mailbox')}</dt><dd><bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi></dd></div>${fact('observed', t('Observed at (UTC)'))}${fact('quota-used', t('Quota used'))}${fact('quota-limit', t('Quota limit'))}${fact('total', t('Measured folders total'))}</dl>
    <meter min="0" max="1" value="0" data-mail-usage-meter hidden aria-label="${t('Quota used')}"></meter>
    <p class="xp-help" data-mail-usage-quota-note hidden role="note"></p>
    <div class="xp-mail-usage__actions"><button type="button" class="xp-btn" data-mail-usage-reload disabled>${t('Read usage again')}</button></div>
    <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Folders by size')}"><table class="xp-table"><caption class="sr-only">${t('Folders by size, largest first')}</caption><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-mail-usage-rows><tr><td colspan="${columns.length}">${t('Disk usage has not been read.')}</td></tr></tbody></table></div>
    <form data-mail-usage-cleanup aria-labelledby="mail-usage-cleanup-heading">
      <h3 id="mail-usage-cleanup-heading">${t('Clean up a folder')}</h3>
      <p class="xp-help">${t('Choose at least one criterion. Messages that match all chosen criteria are included. An empty cleanup is refused.')}</p>
      <div class="xp-mail-usage__fields">
        <div class="xp-field"><label for="mail-usage-folder">${t('Folder')}</label><select id="mail-usage-folder" name="folder" class="xp-select" disabled></select></div>
        <div class="xp-field"><label for="mail-usage-age">${t('Older than (days)')}</label><input id="mail-usage-age" name="olderThanDays" type="number" inputmode="numeric" min="1" max="36500" step="1" class="xp-input" dir="ltr" disabled></div>
        <div class="xp-field"><label for="mail-usage-size">${t('Larger than (MB)')}</label><input id="mail-usage-size" name="largerThanMb" type="number" inputmode="numeric" min="1" max="10240" step="1" class="xp-input" dir="ltr" disabled></div>
      </div>
      <label class="xp-mail-usage__check"><input type="checkbox" name="seen" disabled><span>${t('Only messages already read')}</span></label>
      <div class="xp-mail-usage__actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-usage-preview-submit disabled>${t('Preview cleanup')}</button></div>
    </form>
    <article class="xp-mail-usage__preview" data-mail-usage-preview hidden tabindex="-1" aria-labelledby="mail-usage-preview-heading">
      <h3 id="mail-usage-preview-heading">${t('Cleanup preview')}</h3>
      <dl class="xp-mail-usage__facts" data-mail-usage-preview-facts></dl>
      <p class="xp-help" data-mail-usage-preview-note role="note"></p>
      <label class="xp-mail-usage__check" data-mail-usage-purge-field hidden><input type="checkbox" name="purgeConfirm"><span data-mail-usage-purge-text></span></label>
      <div class="xp-mail-usage__actions"><button type="button" class="xp-btn xp-btn--primary" data-mail-usage-apply></button><button type="button" class="xp-btn" data-mail-usage-discard>${t('Discard preview')}</button></div>
    </article>
  </section>`
}
