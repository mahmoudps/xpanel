import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/tools/track-delivery: the sealed mailbox's own delivery events; other recipients are only a count. */
export function renderMailTrackDelivery(input: { locale: Locale; mailbox: string; canRead: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const ranges = [['1', t('Last hour')], ['6', t('Last 6 hours')], ['24', t('Last 24 hours')], ['72', t('Last 3 days')], ['168', t('Last 7 days')]]
  const statuses = [['', t('Any status')], ['sent', t('Delivered')], ['deferred', t('Deferred')], ['bounced', t('Bounced')], ['expired', t('Expired')], ['rejected', t('Rejected')], ['queued', t('Queued')]]
  const columns = [t('Last event (UTC)'), t('Direction'), t('Correspondent'), t('Status'), t('DSN'), t('Timeline')]
  const select = (id: string, name: string, options: string[][], selected: string): string => `<select id="${id}" name="${name}" class="xp-select" disabled>${options.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('')}</select>`
  return `<section class="xp-card xp-mail-track" data-mail-track-delivery data-track-mailbox="${escapeHtml(input.mailbox)}" data-track-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-track-heading">
    <style>.xp-mail-track{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-track :is(h2,h3,p,dl,dd,ol){margin:0}.xp-mail-track form{display:flex;flex-direction:column;gap:16px;margin:0}.xp-mail-track__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.xp-mail-track .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-track select{inline-size:100%;min-block-size:44px;box-sizing:border-box}.xp-mail-track button{min-block-size:44px}.xp-mail-track__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-track__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-mail-track__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-track dd{overflow-wrap:anywhere}.xp-mail-track__detail{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-mail-track__timeline{display:flex;flex-direction:column;gap:16px;padding:0;list-style:none}.xp-mail-track__timeline li{display:flex;flex-direction:column;gap:8px;padding-inline-start:16px;border-inline-start:2px solid var(--xp-border,#e2e6ec);overflow-wrap:anywhere}.xp-mail-track [hidden]{display:none}@media(min-width:601px){.xp-mail-track{padding:24px}}@media(max-width:639px){.xp-mail-track__fields{grid-template-columns:minmax(0,1fr)}}</style>
    <h2 id="mail-track-heading">${t('Delivery attempts')}</h2>
    <p class="xp-help">${t('Messages this mailbox sent or received, read from the server mail log. Other recipients of a message are shown only as a count.')}</p>
    <form data-mail-track-form aria-labelledby="mail-track-heading">
      <div class="xp-mail-track__fields">
        <div class="xp-field"><label for="mail-track-range">${t('Time range')}</label>${select('mail-track-range', 'range', ranges, '24')}</div>
        <div class="xp-field"><label for="mail-track-status">${t('Status')}</label>${select('mail-track-status', 'status', statuses, '')}</div>
      </div>
      <div class="xp-mail-track__actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-track-submit disabled>${t('Read delivery attempts')}</button></div>
    </form>
    <p class="xp-help" data-mail-track-status data-state="unread" role="status">${input.canRead ? t('Delivery attempts have not been read.') : t('Delivery tracking is unavailable for this mailbox session. Nothing was read.')}</p>
    <dl class="xp-mail-track__facts"><div><dt>${t('Mailbox')}</dt><dd><bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi></dd></div><div><dt>${t('Observed at (UTC)')}</dt><dd><bdi dir="ltr" data-mail-track-fact="observed">${t('Not read')}</bdi></dd></div><div><dt>${t('Window (UTC)')}</dt><dd><bdi dir="ltr" data-mail-track-fact="window">${t('Not read')}</bdi></dd></div></dl>
    <p class="xp-help" data-mail-track-incomplete hidden role="note">${t('Part of the server log could not be read in full, so this list may be incomplete. Narrow the time range.')}</p>
    <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Delivery attempts')}"><table class="xp-table"><caption class="sr-only">${t('Delivery attempts, newest first')}</caption><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-mail-track-rows><tr><td colspan="${columns.length}">${t('No delivery attempts have been read.')}</td></tr></tbody></table></div>
    <div class="xp-mail-track__actions"><button type="button" class="xp-btn" data-mail-track-page="newer" disabled>${t('Newer')}</button><span class="xp-help" data-mail-track-page-label></span><button type="button" class="xp-btn" data-mail-track-page="older" disabled>${t('Older')}</button></div>
    <article class="xp-mail-track__detail" data-mail-track-detail hidden tabindex="-1" aria-labelledby="mail-track-detail-heading">
      <h3 id="mail-track-detail-heading">${t('Selected message')}</h3>
      <dl class="xp-mail-track__facts" data-mail-track-detail-facts></dl>
      <h3>${t('Delivery to this mailbox')}</h3>
      <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Delivery to this mailbox')}"><table class="xp-table"><thead><tr>${[t('Status'), t('DSN'), t('Relay'), t('Attempts'), t('Response')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-mail-track-detail-recipients></tbody></table></div>
      <h3>${t('Timeline')}</h3>
      <ol class="xp-mail-track__timeline" data-mail-track-detail-events></ol>
    </article>
  </section>`
}
