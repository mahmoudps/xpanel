import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
/**
 * /whm/backups/restore-more wizard body. Accounts, backups, components and results are filled by
 * ACCT_RESTORE_CLIENT_BINDING from authorized reads only; every component row starts unread.
 */
export function renderWhmRestoreMoreWorkspace(input: { locale: Locale; canRead: boolean; canRestore: boolean }): { main: string; aside: string } {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.locale)(message, values))
  const off = ' disabled'
  const card = (key: string, title: string, body: string): string => `<section class="xp-whm-detail-card" data-whm-detail-section="restore-more-${key}" aria-labelledby="whm-detail-restore-more-${key}"><h2 id="whm-detail-restore-more-${key}">${title}</h2>${body}</section>`
  const table = (label: string, marker: string, headers: readonly string[], empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-table xp-whm-detail-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-restore-more-${marker}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const fact = (key: string, label: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-restore-more-${key}>${t('Not read')}</dd></div>`
  const steps = [['account', t('Account')], ['backup', t('Backup')], ['components', t('Components')], ['review', t('Review')], ['result', t('Result')]] as const
  const main = `<div class="xp-whm-restore-more" data-whm-restore-more-workspace data-restore-more-can-read="${input.canRead}" data-restore-more-can-restore="${input.canRead && input.canRestore}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-whm-restore-more{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-restore-more :is(h2,h3,p,dl,dd,ol,ul){margin:0}.xp-whm-restore-more td input[type=checkbox]{inline-size:20px;block-size:20px;margin:0}.xp-whm-restore-more [data-restore-more-steps] li[aria-current=step]{font-weight:600}.xp-whm-restore-more td{overflow-wrap:anywhere}.xp-whm-restore-more .xp-whm-detail-actions:has(>[hidden]:only-child){display:none}.xp-whm-restore-more :is(button,input,select):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}</style>
    <ol class="xp-whm-detail-steps" data-restore-more-steps aria-label="${t('Restore steps')}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><strong>${index + 1}</strong>${label}</li>`).join('')}</ol>
    <p class="xp-whm-detail-status" data-restore-more-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('Accounts have not been read.') : t('Restoring backup components requires an authorized root administrator or a reseller with the list-accounts privilege for its own accounts. Nothing was read or changed.')}</p>
    ${card('source', t('Account and backup'), `<div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="whm-restore-more-account">${t('Account')}</label><select class="xp-select" id="whm-restore-more-account" data-restore-more-account${off}><option value="">${t('Accounts have not been read')}</option></select></div></div>
      <p class="xp-help">${t('Backups are listed from the server backup store. Opening one inspects every member and lists what it contains for each component.')}</p>
      ${table(t('Backups of the selected account'), 'archives', [t('Created (UTC)'), t('Archive'), t('Size'), t('Integrity'), t('Action')], t('No account is selected.'))}`)}
    ${card('components', t('Components in the backup'), `<dl class="xp-whm-detail-fields">${fact('archive', t('Archive'))}${fact('sha256', t('Archive SHA-256'))}</dl>
      ${table(t('Backup components'), 'components', [t('Component'), t('In this backup'), t('Restore here')], t('No backup has been opened.'))}
      <h3>${t('Mailboxes in the backup')}</h3>
      ${table(t('Mailboxes in the backup'), 'mailboxes', [t('Select'), t('Mailbox'), t('Messages'), t('Size'), t('Mailbox now')], t('No backup has been opened.'))}
      <p class="xp-help" data-restore-more-selection role="status">${t('No mailbox is selected. Up to 50 mailboxes can be selected.')}</p>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-restore-more-preview${off}>${t('Review mail restore')}</button></div>`)}
    ${card('review', t('Review'), `<dl class="xp-whm-detail-fields">${fact('count-messages', t('Messages in the backup'))}${fact('count-present', t('Already present, will be skipped'))}${fact('count-batch', t('Messages in this run'))}${fact('count-remaining', t('Left for a later run'))}${fact('count-refused', t('Cannot be restored here'))}${fact('planned', t('Planned size'))}${fact('quota', t('Plan disk quota'))}${fact('writer', t('Account file writer'))}</dl>
      ${table(t('Planned mail restore'), 'review', [t('Message file'), t('Size')], t('No restore has been reviewed.'))}
      <label class="xp-whm-detail-choice"><input type="checkbox" data-restore-more-ack${off}><span>${t('I reviewed this list. Existing messages are never overwritten.')}</span></label>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-restore-more-restore${off}>${t('Restore mail')}</button></div>`)}
    ${card('result', t('Result'), `<dl class="xp-whm-detail-fields">${fact('count-restored', t('Restored'))}${fact('count-skipped', t('Skipped, already present'))}${fact('count-failed', t('Failed'))}${fact('count-pending', t('Not attempted yet'))}</dl>
      ${table(t('Mail restore results'), 'results', [t('Message file'), t('Result'), t('Reason')], t('No restore has run.'))}
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-restore-more-continue hidden${off}>${t('Review the next messages')}</button></div>`)}
  </div>`
  const rule = (message: string): string => `<li>${t(message)}</li>`
  const aside = card('rules', t('What these restores do'), `<style>.xp-whm-restore-more__rules{display:flex;flex-direction:column;gap:16px;margin:0;padding-inline-start:16px;line-height:1.7}</style><ul class="xp-whm-restore-more__rules">${[
    rule('Server account backups contain the account home directory only. Database dumps and DNS zones are not included in them.'),
    rule('Mail restores only message files into mailboxes that exist now. A message that is already present is never replaced.'),
    rule('Each restored message is written as the account by the confined file writer, read back and compared with the archive.'),
    rule('One run restores at most 500 messages within a 20 second budget; review again to restore the next messages.'),
    rule('Account mail settings are rendered from saved configuration and are not restored from a backup.'),
  ].join('')}</ul>`)
  return { main, aside }
}
