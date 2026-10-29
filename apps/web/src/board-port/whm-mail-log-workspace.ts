import { translator, type Locale, type Translate, localeDirection } from '../i18n.ts'
type T = Translate
const styles = `<style>.xp-whm-mail-log{display:flex;flex-direction:column;align-items:stretch;gap:32px;min-inline-size:0}.xp-whm-mail-log :is(h2,h3,p,dl,dd,ol){margin:0}.xp-whm-mail-log [data-mail-log-form]{display:flex;flex-direction:column;gap:24px;margin:0}.xp-whm-mail-log__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-whm-mail-log__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-mail-log dd{overflow-wrap:anywhere}.xp-whm-mail-log__tile{padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-whm-mail-log__tile dd{font-size:24px;line-height:1.4;font-variant-numeric:tabular-nums}.xp-whm-mail-log__timeline{display:flex;flex-direction:column;gap:16px;padding:0;list-style:none}.xp-whm-mail-log__timeline li{display:flex;flex-direction:column;gap:8px;padding-inline-start:16px;border-inline-start:2px solid var(--xp-border,#e2e6ec);overflow-wrap:anywhere}.xp-whm-mail-log [hidden]{display:none}.xp-whm-mail-log .xp-whm-detail-table button{min-block-size:44px}.xp-whm-mail-log [data-mail-log-detail-body]:not([hidden]){display:grid;gap:var(--xp-space-group)}.xp-whm-mail-log h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}.xp-whm-mail-log h3{font-size:var(--xp-type-body);line-height:var(--xp-leading-body)}@media(min-width:601px){.xp-whm-mail-log .xp-whm-detail-card,.xp-whm-mail-log__tile{padding:var(--xp-space-card)}}</style>`
const range = (t: T, name: string, custom: boolean): string => `<select class="xp-select" id="${name}" name="${name}" data-mail-log-range disabled>${[['1', t('Last hour')], ['6', t('Last 6 hours')], ['24', t('Last 24 hours')], ['72', t('Last 3 days')], ['168', t('Last 7 days')], ...(custom ? [['custom', t('Custom UTC range')]] : [])].map(([value, label]) => `<option value="${value}"${value === '24' ? ' selected' : ''}>${label}</option>`).join('')}</select>`
const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label>${control}${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
const text = (id: string, name: string, extra = ''): string => `<input class="xp-input" id="${id}" name="${name}" type="text" dir="ltr" autocomplete="off" spellcheck="false" maxlength="254"${extra} disabled>`
const fact = (label: string, key: string, t: T): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-mail-log-fact="${key}">${t('Not read')}</bdi></dd></div>`
const integrity = (t: T): string => `<p class="xp-help" data-mail-log-integrity hidden></p><p class="xp-help" data-mail-log-limit hidden role="note">${t('The bounded read reached its line or size limit, so this view may be incomplete. Narrow the time range.')}</p>`
const head = (labels: readonly string[]): string => `<thead><tr>${labels.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead>`

/** /whm/email/delivery: searchable Postfix delivery report with a per-message timeline panel. */
export function renderWhmMailDelivery(input: { locale: Locale; canRead: boolean }): string {
  const t = translator(input.locale)
  const statuses = [['', t('Any status')], ['sent', t('Delivered')], ['deferred', t('Deferred')], ['bounced', t('Bounced')], ['expired', t('Expired')], ['rejected', t('Rejected')], ['queued', t('Queued')]]
  const columns = [t('Last event (UTC)'), t('Queue ID'), t('Sender'), t('Recipients'), t('Status'), t('DSN'), t('Timeline')]
  return `${styles}<div class="xp-whm-mail-log xp-whm-detail-grid" data-whm-mail-log="delivery" data-mail-log-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="whm-mail-delivery-search"><h2 id="whm-mail-delivery-search">${t('Search deliveries')}</h2>
      <${input.canRead ? 'form' : 'div'} role="search" data-mail-log-form aria-labelledby="whm-mail-delivery-search">
        <div class="xp-whm-detail-fields">
          ${field('whm-mail-delivery-range', t('Time range'), range(t, 'whm-mail-delivery-range', true))}
          ${field('whm-mail-delivery-status', t('Status'), `<select class="xp-select" id="whm-mail-delivery-status" name="status" disabled>${statuses.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`)}
          ${field('whm-mail-delivery-since', t('From (UTC)'), text('whm-mail-delivery-since', 'since', ' placeholder="2026-10-27 08:00" data-mail-log-custom'), t('Format YYYY-MM-DD HH:MM, for the custom range only.'))}
          ${field('whm-mail-delivery-until', t('To (UTC)'), text('whm-mail-delivery-until', 'until', ' placeholder="2026-10-27 12:00" data-mail-log-custom'), t('At most 7 days after the start.'))}
          ${field('whm-mail-delivery-sender', t('Sender contains'), text('whm-mail-delivery-sender', 'sender'))}
          ${field('whm-mail-delivery-recipient', t('Recipient contains'), text('whm-mail-delivery-recipient', 'recipient'))}
          ${field('whm-mail-delivery-domain', t('Domain'), text('whm-mail-delivery-domain', 'domain'), t('Exact sender or recipient domain.'))}
          ${field('whm-mail-delivery-dsn', t('DSN code'), text('whm-mail-delivery-dsn', 'dsn', ' placeholder="5.1.1" maxlength="9"'), t('A class such as 5 or 4.4 matches every code inside it.'))}
        </div>
        <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-log-submit disabled>${t(msgctxt('whm-mail-log-workspace', 'Apply filters'))}</button><button type="button" class="xp-btn" data-mail-log-clear disabled>${t(msgctxt('whm-mail-log-workspace', 'Clear filters'))}</button></div>
      </${input.canRead ? 'form' : 'div'}>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="whm-mail-delivery-results"><h2 id="whm-mail-delivery-results">${t('Messages')}</h2>
      <p class="xp-whm-detail-status" data-mail-log-status data-state="unread" role="status">${input.canRead ? t('Delivery events have not been read.') : t('Delivery reports are unavailable here. Nothing was read.')}</p>
      <dl class="xp-whm-mail-log__facts">${fact(t('Observed at (UTC)'), 'observed', t)}${fact(t('Window (UTC)'), 'window', t)}${fact(t('Matching messages'), 'matched', t)}</dl>
      ${integrity(t)}<p class="xp-help" data-mail-log-omitted hidden></p>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Delivery messages')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Delivery messages, newest first')}</caption>${head(columns)}<tbody data-mail-log-rows><tr><td colspan="${columns.length}">${t('No delivery events have been read.')}</td></tr></tbody></table></div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-mail-log-page="newer" disabled>${t('Newer')}</button><span class="xp-help" data-mail-log-page-label></span><button type="button" class="xp-btn" data-mail-log-page="older" disabled>${t('Older')}</button></div>
    </section>
  </div>
  <aside class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="whm-mail-delivery-selected" data-mail-log-detail tabindex="-1"><h2 id="whm-mail-delivery-selected">${t('Selected message')}</h2>
      <p class="xp-help" data-mail-log-detail-empty>${t('Choose a message to see its recipients and timeline.')}</p>
      <div data-mail-log-detail-body hidden>
        <dl class="xp-whm-mail-log__facts" data-mail-log-detail-facts></dl>
        <h3>${t('Recipients')}</h3>
        <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Recipients of the selected message')}"><table class="xp-whm-detail-table xp-table">${head([t('Recipient'), t('Status'), t('DSN'), t('Relay'), t('Attempts'), t('Response')])}<tbody data-mail-log-detail-recipients></tbody></table></div>
        <h3>${t('Timeline')}</h3>
        <ol class="xp-whm-mail-log__timeline" data-mail-log-detail-events></ol>
      </div>
    </section>
  </aside>
</div>`
}

/** /whm/email/monitor: aggregate counts from the same parsed journal window. */
export function renderWhmMailMonitor(input: { locale: Locale; canRead: boolean }): string {
  const t = translator(input.locale)
  const tiles = [['sent', t('Delivered')], ['deferred', t('Deferred')], ['bounced', t('Bounced')], ['rejected', t('Rejected')], ['expired', t('Expired')], ['queued', t('Still queued')]]
  const table = (key: string, label: string, columns: readonly string[]): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-mail-monitor-${key}"><h2 id="whm-mail-monitor-${key}">${label}</h2><div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table xp-table">${head(columns)}<tbody data-mail-monitor-table="${key}"><tr><td colspan="${columns.length}">${t('Not read')}</td></tr></tbody></table></div></section>`
  return `${styles}<div class="xp-whm-mail-log" data-whm-mail-log="monitor" data-mail-log-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <section class="xp-whm-detail-card" aria-labelledby="whm-mail-monitor-window"><h2 id="whm-mail-monitor-window">${t('Mail flow')}</h2>
    <${input.canRead ? 'form' : 'div'} data-mail-log-form aria-labelledby="whm-mail-monitor-window"><div class="xp-whm-detail-fields">${field('whm-mail-monitor-range', t('Time range'), range(t, 'whm-mail-monitor-range', false))}</div>
      <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-mail-log-submit disabled>${t('Read mail flow')}</button></div></${input.canRead ? 'form' : 'div'}>
    <p class="xp-whm-detail-status" data-mail-log-status data-state="unread" role="status">${input.canRead ? t('Mail flow has not been read.') : t('The mail monitor is unavailable here. Nothing was read.')}</p>
    <dl class="xp-whm-mail-log__facts">${fact(t('Observed at (UTC)'), 'observed', t)}${fact(t('Window (UTC)'), 'window', t)}${fact(t('Messages'), 'messages', t)}${fact(t('Journal records'), 'records', t)}</dl>
    ${integrity(t)}
    <dl class="xp-whm-mail-log__facts" aria-label="${t('Messages by final status')}">${tiles.map(([key, label]) => `<div class="xp-whm-mail-log__tile"><dt>${label}</dt><dd data-mail-monitor-count="${key}">${t('Not read')}</dd></div>`).join('')}</dl>
    <p class="xp-help">${t('Counts are messages by their latest observed state inside the window; a deferred message may still be delivered later.')}</p>
  </section>
  ${table('senders', t('Top senders'), [t('Sender'), t('Messages')])}
  ${table('domains', t('Top recipient domains'), [t('Domain'), t('Recipients')])}
  ${table('deferrals', t('Deferral reasons'), [t('DSN'), t('Reason'), t('Attempts')])}
</div>`
}
