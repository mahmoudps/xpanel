import { classicWhmClientTemplates } from './whm-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export type WhmMailServerPage = 'server' | 'routing' | 'outbound'
/** `canManage` defaults to `canRead`: both pages are root-only, and the API re-checks root on every save. */
export interface WhmMailServerWorkspaceInput { locale: Locale; page: WhmMailServerPage; canRead: boolean; canManage?: boolean }
type SettingField = { key: string; source: 'postfix' | 'dovecot'; options?: readonly (readonly [string, string])[]; list?: boolean }

const TLS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const
/** Postfix exclusion lists the server policy accepts, one per protocol floor (packages/os mailx-command MAILX_TLS_PROTOCOLS). */
const TLS_EXCLUDES = ['!SSLv2, !SSLv3', '!SSLv2, !SSLv3, !TLSv1', '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1', '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1, !TLSv1.2'] as const

/** Postfix/Dovecot settings of the server mail policy, grouped as the page edits them; outbound edits the limits only. */
export function mailSettingGroups(page: WhmMailServerPage, t: (message: string, values?: MessageValues) => string): { id: string; legend: string; fields: SettingField[] }[] {
  const pick = (...values: string[]) => values.map(value => [value, value] as const)
  const floors = TLS.map((version, index) => [TLS_EXCLUDES[index]!, t('{version} or later', { version })] as const)
  const text = (key: string, source: 'postfix' | 'dovecot' = 'postfix', list = false): SettingField => ({ key, source, list })
  const choose = (key: string, options: readonly (readonly [string, string])[], source: 'postfix' | 'dovecot' = 'postfix'): SettingField => ({ key, source, options })
  if (page === 'outbound') return [{ id: 'limits', legend: t('Rate and size limits'), fields: ['message_size_limit', 'smtpd_client_connection_rate_limit', 'smtpd_client_connection_count_limit',
    'default_destination_recipient_limit', 'smtp_destination_concurrency_limit', 'default_process_limit'].map(key => text(key)).concat(text('smtpd_client_event_limit_exceptions', 'postfix', true)) }]
  if (page === 'routing') return []
  return [
    { id: 'identity', legend: t('Identity and networks'), fields: [text('myhostname'), text('mydomain'), text('myorigin'), text('smtpd_banner'), text('inet_interfaces', 'postfix', true),
      choose('inet_protocols', pick('all', 'ipv4', 'ipv6', 'ipv4, ipv6')), text('mynetworks', 'postfix', true), choose('smtpd_helo_required', pick('yes', 'no'))] },
    { id: 'smtpd-tls', legend: t('Incoming SMTP TLS'), fields: [choose('smtpd_tls_protocols', floors), choose('smtpd_tls_mandatory_protocols', floors), choose('smtpd_tls_ciphers', pick('medium', 'high')),
      choose('smtpd_tls_mandatory_ciphers', pick('medium', 'high')), text('smtpd_tls_exclude_ciphers', 'postfix', true), choose('tls_preempt_cipherlist', pick('yes', 'no'))] },
    { id: 'smtp-tls', legend: t('Outgoing SMTP TLS'), fields: [choose('smtp_tls_security_level', pick('none', 'may', 'encrypt')), choose('smtp_tls_protocols', floors), choose('smtp_tls_mandatory_protocols', floors),
      choose('smtp_tls_ciphers', pick('medium', 'high'))] },
    { id: 'dovecot', legend: t('Dovecot (IMAP and POP3)'), fields: [text('protocols', 'dovecot'), choose('ssl_min_protocol', pick(...TLS), 'dovecot'), text('ssl_cipher_list', 'dovecot'),
      choose('ssl_prefer_server_ciphers', pick('yes', 'no'), 'dovecot')] },
  ]
}

/** Postfix/Dovecot comparison for /whm/email/server, /whm/email/routing and /whm/email/outbound, with the saved server mail policy editor. Rows are painted only from an authorized fresh read. */
export function renderWhmMailServerWorkspace({ locale, page, canRead, canManage = canRead }: WhmMailServerWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values), id = (name: string): string => `whm-mail-server-${page}-${name}`
  const notRead = t('Not read'), manage = canRead && canManage
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
    + table('domains', t('Hosted mail domains'), [t('Domain'), t('Account'), t('Mailboxes'), t('Saved zone'), t('Saved MX'), t('Expectation'), ...(manage ? [t('Routing')] : [])]))
  const unmanaged = t('Not managed (keep the host value)')
  const input = (field: SettingField): string => {
    const name = id('field-' + field.key), hint = field.list ? ` aria-describedby="${id('list-hint')}"` : ''
    const control = field.options
      ? `<select class="xp-input" id="${name}" dir="ltr" data-mail-setting="${field.key}" data-mail-setting-source="${field.source}"><option value="">${unmanaged}</option>${field.options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>`
      : `<input class="xp-input" id="${name}" dir="ltr" type="text" autocomplete="off" spellcheck="false" placeholder="${unmanaged}" data-mail-setting="${field.key}" data-mail-setting-source="${field.source}"${field.list ? ' data-mail-setting-list="true"' : ''}${hint}>`
    return `<div class="xp-whm-mail-server__field"><label for="${name}"><bdi dir="ltr">${field.key}</bdi></label>${control}</div>`
  }
  const certificate = (key: 'smtp' | 'submission' | 'imap', label: string): string => `<div class="xp-whm-mail-server__field"><label for="${id('certificate-' + key)}">${label}</label><select class="xp-input" id="${id('certificate-' + key)}" data-mail-certificate="${key}"><option value="">${t('Default certificate')}</option></select></div>`
  const groups = mailSettingGroups(page, t).map(group => `<fieldset class="xp-whm-mail-server__group"><legend>${group.legend}</legend><div class="xp-whm-mail-server__fields">${group.fields.map(input).join('')}</div></fieldset>`).join('')
  const extras = page !== 'server' ? '' : `<fieldset class="xp-whm-mail-server__group"><legend>${t('DNS blocklists (RBL)')}</legend>
      <div class="xp-whm-mail-server__check"><input type="checkbox" id="${id('rbl-managed')}" data-mail-rbl-managed><label for="${id('rbl-managed')}">${t('Manage smtpd_client_restrictions with these blocklists')}</label></div>
      <div class="xp-whm-mail-server__field"><label for="${id('rbl')}">${t('Blocklist zones')}</label><textarea class="xp-input" id="${id('rbl')}" dir="ltr" rows="4" spellcheck="false" data-mail-rbl aria-describedby="${id('rbl-hint')}"></textarea><p class="xp-help" id="${id('rbl-hint')}">${t('One DNS zone per line, checked in order after trusted networks and signed-in senders.')}</p></div></fieldset>
    <fieldset class="xp-whm-mail-server__group"><legend>${t('Certificates')}</legend><div class="xp-whm-mail-server__fields">${certificate('smtp', t('Incoming SMTP (port 25)'))}${certificate('submission', t('Mail clients sending (ports 587 and 465)'))}${certificate('imap', t('Mail clients reading (IMAP and POP3)'))}</div></fieldset>`
  const editor = !manage ? '' : card('editor', page === 'routing' ? t('Change routing') : t('Change settings'), `<form class="xp-whm-mail-server__form" data-whm-mail-settings novalidate>
    <p class="xp-help">${page === 'routing' ? t('Choose a route for each domain in the table above. Local delivers here; backup MX accepts mail and relays it to the primary exchanger; remote sends mail to the MX of the domain.') : t('An empty value is not managed and keeps the host value. Each change is previewed, checked with postfix check and doveconf -n, and restored automatically when a check fails.')}</p>
    ${page === 'routing' ? '' : `<p class="xp-help" id="${id('list-hint')}">${t('Separate list entries with a comma and a space.')}</p>`}${groups}${extras}
    <p class="xp-whm-detail-status" data-whm-mail-settings-status data-state="unread" role="status">${t('The saved policy has not been read.')}</p>
    <div data-whm-mail-settings-preview hidden><h3>${t('Changes to apply')}</h3>${table('changes', t('Changes to apply'), [t('Where'), t('Setting'), t('Now'), t('After')])}</div>
    <div class="xp-whm-mail-server__actions"><button type="button" class="xp-btn" data-whm-mail-settings-preview-button disabled>${t('Preview changes')}</button><button type="submit" class="xp-btn xp-btn--primary" data-whm-mail-settings-save disabled>${t('Save and apply')}</button></div>
  </form>`)
  const listed = `${t('Observed values come from')} <bdi dir="ltr">postconf -n</bdi>${page === 'routing' ? '' : `, <bdi dir="ltr">postconf -M</bdi>`}${page === 'server' ? ` ${t('and')} <bdi dir="ltr">doveconf -h</bdi>` : ''}. ${t('Passwords, keys and lookup table contents are never read.')}`
  return `<section class="xp-whm-mail-server" data-whm-mail-server-workspace data-mail-server-page="${page}" data-mail-server-can-read="${canRead}" data-mail-server-can-manage="${manage}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="${id('summary')}">${classicWhmClientTemplates('mail-server')}
    <style>.xp-whm-mail-server h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-whm-mail-server{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-mail-server :is(h2,h3,p,dl,dd,fieldset){margin:0}.xp-whm-mail-server__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-mail-server__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-mail-server__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-whm-mail-server__facts>div,.xp-whm-mail-server__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
    .xp-whm-mail-server__form,[data-whm-mail-settings-preview]{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-whm-mail-server__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0;padding:0;border:0}.xp-whm-mail-server legend,.xp-whm-mail-server h3{font-weight:600;padding:0;margin-block-end:16px}
    .xp-whm-mail-server__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}.xp-whm-mail-server__field>label[for]{box-sizing:border-box;padding-inline-start:var(--xp-control-content-inset,13px)}.xp-whm-mail-server__check{display:flex;align-items:center;gap:8px}.xp-whm-mail-server input[type=checkbox]{inline-size:20px;block-size:20px}.xp-whm-mail-server__actions{display:flex;flex-wrap:wrap;gap:16px}
    .xp-whm-mail-server :is(dt,label){font-weight:600}.xp-whm-mail-server dd{overflow-wrap:anywhere}.xp-whm-mail-server :is(button,.xp-input){min-block-size:44px}.xp-whm-mail-server td bdi{unicode-bidi:isolate}.xp-whm-mail-server td[data-state=drift]{font-weight:600}.xp-whm-mail-server [hidden]{display:none}.xp-whm-mail-server :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
    @media(min-width:601px){.xp-whm-mail-server__card{padding:24px}}
    </style>
    ${card('summary', t('Configuration sources'), `<div class="xp-whm-mail-server__heading"><p>${t('Each value is compared with the configuration xPanel renders.')}</p><button type="button" class="xp-btn" data-whm-mail-server-refresh${canRead ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-whm-mail-server-status data-state="unread" role="status">${t('The mail server configuration has not been read.')}</p>
      <dl class="xp-whm-mail-server__facts">${facts.join('')}</dl>
      <p class="xp-help">${listed}</p>
      <p class="xp-help">${t('Drift means the host differs from the configuration xPanel renders. Correct it through the reviewed reconcile workflow in')} <a href="/whm/monitoring/repair">${t('Repair center')}</a> ${t('or')} <a href="/whm/panel/data">${t('Configuration history')}</a>${t(', not by editing files by hand.')}</p>`)}
    ${settings}${services}${domains}${editor}
  </section>`
}
