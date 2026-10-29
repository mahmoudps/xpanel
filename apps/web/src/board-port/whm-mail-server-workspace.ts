import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export type WhmMailServerPage = 'server' | 'routing' | 'outbound'
export interface WhmMailServerWorkspaceInput { locale: Locale; page: WhmMailServerPage; canRead: boolean }

/** Read-only Postfix/Dovecot comparison for /whm/email/server, /whm/email/routing and /whm/email/outbound. Rows are painted only from an authorized fresh read. */
export function renderWhmMailServerWorkspace({ locale, page, canRead }: WhmMailServerWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values), id = (name: string): string => `whm-mail-server-${page}-${name}`
  const notRead = t('Not read')
  const fact = (label: string, key: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-mail-server-fact="${key}">${notRead}</bdi></dd></div>`
  const facts = [fact(t('Postfix main.cf'), 'postfix'), ...(page === 'routing' ? [] : [fact(t('Postfix master.cf'), 'master')]),
    ...(page === 'server' ? [fact(t('Dovecot'), 'dovecot')] : []), fact(t('Rendered by xPanel'), 'desired'), fact(t('Observed at (UTC)'), 'observed-at')]
  const table = (key: string, label: string, headers: string[]): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-whm-mail-server-${key}><tr><td colspan="${headers.length}">${t('Nothing has been read.')}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string): string => `<section class="xp-whm-mail-server__card" aria-labelledby="${id(key)}"><h2 id="${id(key)}">${title}</h2>${body}</section>`
  const compared = [t('Observed'), t('Rendered by xPanel'), t('State')]
  const titles: Record<WhmMailServerPage, string> = { server: t('Postfix and Dovecot settings'), routing: t('Routing settings'), outbound: t('Rate and size limits') }
  const settings = card('settings', titles[page], (page === 'outbound' ? `<p class="xp-help">${t('A limit that is not set in main.cf uses the Postfix default.')}</p>` : '')
    + table('settings', titles[page], [t('Source'), t('Setting'), ...compared]))
  const services = page === 'routing' ? '' : card('services', page === 'server' ? t('Listening services (master.cf)') : t('Submission services'),
    `<p class="xp-help">${t('Only reviewed -o overrides are shown; other overrides are counted.')}</p>`
    + table('services', t('Services'), [t('Service'), t('Setting'), ...compared]))
  const domains = page !== 'routing' ? '' : card('domains', t('Hosted mail domains'),
    `<p class="xp-help">${t('MX records come from the saved DNS zones on this server, not from live DNS lookups.')}</p>`
    + `<p class="xp-help" data-whm-mail-server-truncated hidden>${t('Only the first 2000 domains are listed.')}</p>`
    + table('domains', t('Hosted mail domains'), [t('Domain'), t('Account'), t('Mailboxes'), t('Saved zone'), t('Saved MX'), t('Expectation')]))
  return `<section class="xp-whm-mail-server" data-whm-mail-server-workspace data-mail-server-page="${page}" data-mail-server-can-read="${canRead}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="${id('summary')}">
    <style>.xp-whm-mail-server h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-whm-mail-server{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-mail-server :is(h2,p,dl,dd){margin:0}.xp-whm-mail-server__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-mail-server__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-mail-server__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-whm-mail-server__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
    .xp-whm-mail-server dt{font-weight:600}.xp-whm-mail-server dd{overflow-wrap:anywhere}.xp-whm-mail-server button{min-block-size:44px}.xp-whm-mail-server td bdi{unicode-bidi:isolate}.xp-whm-mail-server td[data-state=drift]{font-weight:600}.xp-whm-mail-server [hidden]{display:none}.xp-whm-mail-server :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
    @media(min-width:601px){.xp-whm-mail-server__card{padding:24px}}
    </style>
    ${card('summary', t('Configuration sources'), `<div class="xp-whm-mail-server__heading"><p>${t('Each value is compared with the configuration xPanel renders.')}</p><button type="button" class="xp-btn" data-whm-mail-server-refresh${canRead ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-whm-mail-server-status data-state="unread" role="status">${t('The mail server configuration has not been read.')}</p>
      <dl class="xp-whm-mail-server__facts">${facts.join('')}</dl>
      <p class="xp-help">${t('Observed values come from')} <bdi dir="ltr">postconf -n</bdi>${page === 'routing' ? '' : `, <bdi dir="ltr">postconf -M</bdi>`}${page === 'server' ? ` ${t('and')} <bdi dir="ltr">doveconf -h</bdi>` : ''}. ${t('Passwords, keys and lookup table contents are never read.')}</p>
      <p class="xp-help">${t('Drift means the host differs from the configuration xPanel renders. Correct it through the reviewed reconcile workflow in')} <a href="/whm/monitoring/repair">${t('Repair center')}</a> ${t('or')} <a href="/whm/panel/data">${t('Configuration history')}</a>${t(', not by editing files by hand.')}</p>
      <p class="xp-help">${t('These settings are not editable from this panel yet. No saved server setting models them.')}</p>`)}
    ${settings}${services}${domains}
  </section>`
}
