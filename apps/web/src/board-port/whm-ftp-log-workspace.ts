import { translator, type Locale, type Translate, localeDirection } from '../i18n.ts'
type T = Translate
const styles = `<style>.xp-whm-ftp-log{min-inline-size:0}.xp-whm-ftp-log :is(h2,h3,p,dl,dd){margin:0}.xp-whm-ftp-log form{display:flex;flex-direction:column;gap:24px;margin:0}.xp-whm-ftp-log__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px}.xp-whm-ftp-log__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-ftp-log dd{overflow-wrap:anywhere}.xp-whm-ftp-log__tile{padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-whm-ftp-log__tile dd{font-size:24px;line-height:1.4;font-variant-numeric:tabular-nums}.xp-whm-ftp-log td{overflow-wrap:anywhere}.xp-whm-ftp-log [hidden]{display:none}.xp-whm-ftp-log .xp-whm-detail-table button{min-block-size:44px}</style>`
const range = (t: T): string => `<select id="whm-ftp-log-range" name="whm-ftp-log-range" data-ftp-log-range disabled>${[['1', t('Last hour')], ['6', t('Last 6 hours')], ['24', t('Last 24 hours')], ['72', t('Last 3 days')], ['168', t('Last 7 days')], ['custom', t('Custom UTC range')]].map(([value, label]) => `<option value="${value}"${value === '24' ? ' selected' : ''}>${label}</option>`).join('')}</select>`
const field = (id: string, label: string, control: string, help = ''): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label>${control}${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
const text = (id: string, name: string, extra = ''): string => `<input id="${id}" name="${name}" type="text" dir="ltr" autocomplete="off" spellcheck="false" maxlength="254"${extra} disabled>`
const fact = (label: string, key: string, t: T): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-ftp-log-fact="${key}">${t('Not read')}</bdi></dd></div>`
const head = (labels: readonly string[]): string => `<thead><tr>${labels.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead>`
const table = (t: T, key: string, label: string, columns: readonly string[], help = ''): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-ftp-log-${key}"><h2 id="whm-ftp-log-${key}">${label}</h2>${help ? `<p class="xp-help">${help}</p>` : ''}<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table">${head(columns)}<tbody data-ftp-log-table="${key}"><tr><td colspan="${columns.length}">${t('Not read')}</td></tr></tbody></table></div></section>`

/** /whm/services/ftp-log-analysis: pure-ftpd activity summary, searchable events and a per-user drill-down from one journal window. */
export function renderWhmFtpLog(input: { locale: Locale; canRead: boolean }): string {
  const t = translator(input.locale), tag = input.canRead ? 'form' : 'div'
  const kinds = [['', t('Any event')], ['connect', t('Connected')], ['login', t('Signed in')], ['login-failed', t('Sign-in failed')], ['upload', t('Uploaded')], ['download', t('Downloaded')], ['delete', t('Deleted')], ['logout', t('Signed out')], ['timeout', t('Timed out')]]
  const tiles = [['succeeded', t('Successful sign-ins')], ['failed', t(msgctxt('whm-ftp-log-workspace', 'Failed sign-ins'))], ['connections', t('Connections')], ['uploads', t('Uploads')], ['uploadBytes', t('Uploaded bytes')], ['downloads', t('Downloads')], ['downloadBytes', t('Downloaded bytes')], ['deletes', t('Deletions')]]
  const events = [t('Time (UTC)'), t('Event'), t('User'), t('Account'), t('Client'), t('Path'), t('Size (bytes)')]
  return `${styles}<div class="xp-whm-ftp-log xp-whm-detail-grid" data-whm-ftp-log data-ftp-log-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
  <div class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="whm-ftp-log-search"><h2 id="whm-ftp-log-search">${t('Search FTP activity')}</h2>
      <${tag} role="search" data-ftp-log-form aria-labelledby="whm-ftp-log-search">
        <div class="xp-whm-detail-fields">
          ${field('whm-ftp-log-range', t('Time range'), range(t))}
          ${field('whm-ftp-log-kind', t('Event'), `<select id="whm-ftp-log-kind" name="kind" disabled>${kinds.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`)}
          ${field('whm-ftp-log-since', t('From (UTC)'), text('whm-ftp-log-since', 'since', ' placeholder="2026-10-27 08:00" data-ftp-log-custom'), t('Format YYYY-MM-DD HH:MM, for the custom range only.'))}
          ${field('whm-ftp-log-until', t('To (UTC)'), text('whm-ftp-log-until', 'until', ' placeholder="2026-10-27 12:00" data-ftp-log-custom'), t('At most 7 days after the start.'))}
          ${field('whm-ftp-log-user', t('User'), text('whm-ftp-log-user', 'user'), t('Exact FTP user name, as logged.'))}
          ${field('whm-ftp-log-client', t('Client'), text('whm-ftp-log-client', 'client', ' maxlength="253"'), t('Exact client address or host name.'))}
          ${field('whm-ftp-log-text', t('Contains'), text('whm-ftp-log-text', 'text'), t('Matches part of a user, account, client or path.'))}
        </div>
        <div class="xp-whm-detail-actions"><button type="submit" class="xp-btn xp-btn--primary" data-ftp-log-submit disabled>${t('Read FTP activity')}</button><button type="button" class="xp-btn" data-ftp-log-clear disabled>${t(msgctxt('whm-ftp-log-workspace', 'Clear filters'))}</button></div>
      </${tag}>
    </section>
    <section class="xp-whm-detail-card" aria-labelledby="whm-ftp-log-summary"><h2 id="whm-ftp-log-summary">${t('Activity summary')}</h2>
      <p class="xp-whm-detail-status" data-ftp-log-status data-state="unread" role="status">${input.canRead ? t('FTP activity has not been read.') : t('FTP log analysis is unavailable here. Nothing was read.')}</p>
      <dl class="xp-whm-ftp-log__facts">${fact(t('Observed at (UTC)'), 'observed', t)}${fact(t('Window (UTC)'), 'window', t)}${fact(t('Journal records'), 'records', t)}</dl>
      <p class="xp-help" data-ftp-log-integrity hidden></p><p class="xp-help" data-ftp-log-limit hidden role="note">${t('The bounded read reached its line limit, so the oldest part of this window may be missing. Narrow the time range.')}</p>
      <dl class="xp-whm-ftp-log__facts" aria-label="${t('Activity in the whole window')}">${tiles.map(([key, label]) => `<div class="xp-whm-ftp-log__tile"><dt>${label}</dt><dd data-ftp-log-count="${key}">${t('Not read')}</dd></div>`).join('')}</dl>
      <p class="xp-help">${t('Counts cover the whole window and ignore the search filters. pure-ftpd writes these lines only while its syslog logging is on. Client is the address pure-ftpd logged: an IP address, or a host name when reverse lookups are on.')}</p>
    </section>
    ${table(t, 'users', t('Top users'), [t('User'), t('Account'), t('Events'), t('Sign-ins'), t(msgctxt('whm-ftp-log-workspace', 'Failed')), t(msgctxt('whm-ftp-log-workspace', 'Uploads')), t(msgctxt('whm-ftp-log-workspace', 'Downloads')), t('Bytes'), t('Activity')])}
    ${table(t, 'clients', t('Top clients'), [t('Client'), t('Events'), t('Connections'), t('Sign-ins'), t(msgctxt('whm-ftp-log-workspace', 'Failed')), t('Activity')])}
    ${table(t, 'bursts', t('Failed sign-in bursts'), [t('Client'), t(msgctxt('whm-ftp-log-workspace', 'Failures')), t('User names tried'), t('First (UTC)'), t('Last (UTC)')], t('A burst is 5 or more failed sign-ins from one client with at most 10 minutes between attempts.'))}
    <section class="xp-whm-detail-card" aria-labelledby="whm-ftp-log-events"><h2 id="whm-ftp-log-events">${t('Events')}</h2>
      <dl class="xp-whm-ftp-log__facts">${fact(t('Matching events'), 'matched', t)}</dl>
      <p class="xp-help">${t('Paths that start with ~ are relative to the home of the saved account that owns the FTP user. Other paths are shown as logged.')}</p>
      <p class="xp-help" data-ftp-log-omitted hidden></p>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('FTP events')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('FTP events, newest first')}</caption>${head(events)}<tbody data-ftp-log-rows><tr><td colspan="${events.length}">${t('No FTP events have been read.')}</td></tr></tbody></table></div>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ftp-log-page="newer" disabled>${t('Newer')}</button><span class="xp-help" data-ftp-log-page-label></span><button type="button" class="xp-btn" data-ftp-log-page="older" disabled>${t('Older')}</button></div>
    </section>
  </div>
  <aside class="xp-whm-detail-column">
    <section class="xp-whm-detail-card" aria-labelledby="whm-ftp-log-selected" data-ftp-log-detail tabindex="-1"><h2 id="whm-ftp-log-selected">${t('Selected user')}</h2>
      <p class="xp-help" data-ftp-log-detail-empty>${t("Choose View activity on a user, or search for an exact user, to see that user's sign-ins, transfers and clients.")}</p>
      <div data-ftp-log-detail-body hidden>
        <dl class="xp-whm-ftp-log__facts" data-ftp-log-detail-facts></dl>
        <h3>${t('Clients')}</h3>
        <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Clients of the selected user')}"><table class="xp-whm-detail-table">${head([t('Client'), t('Events'), t('Sign-ins'), t(msgctxt('whm-ftp-log-workspace', 'Failed'))])}<tbody data-ftp-log-detail-clients></tbody></table></div>
      </div>
    </section>
  </aside>
</div>`
}
