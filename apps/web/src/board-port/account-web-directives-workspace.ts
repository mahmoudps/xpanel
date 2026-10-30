import { webDirectiveClientTemplates } from './account-directive-client-templates.ts'
import { redirectClientTemplates } from './domain-client-templates.ts'
import type { Domain } from '@xpanel/core'
import { type Locale, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

type Copy = string
export type AccountWebDirectivePage = 'error-pages' | 'indexes' | 'mime-types' | 'handlers' | 'hotlink' | 'ip-blocker' | 'redirects'
export interface AccountWebDirectivesInput { locale: Locale; accountId: string; domains: readonly Pick<Domain, 'id' | 'accountId' | 'name'>[]; selectedDomainId?: string; canManage: boolean }
interface Field { name: string; label: Copy; kind: 'text' | 'select' | 'checkbox' | 'textarea'; options?: readonly (readonly [string, Copy])[]; technical?: boolean; help?: Copy; max?: number }
interface Page { route: string; title: Copy; lede: Copy; columns: Copy[]; list: boolean; formTitle: Copy; fields: Field[]; notes: Copy[] }

const ACTIONS: Copy = msgid('Actions'), SETTING: Copy = msgid('Setting'), VALUE: Copy = msgid('Value')
const PAGES: Readonly<Record<AccountWebDirectivePage, Page>> = {
  'error-pages': { route: '/advanced/error-pages', title: msgid('Error pages'), lede: msgid('Show your own page for common HTTP errors on this domain. xPanel writes Apache ErrorDocument rules into its marked block in the domain .htaccess file.'),
    columns: [msgid('Status code'), msgid('Page path'), msgid('File check'), ACTIONS], list: true, formTitle: msgid('Add or update an error page'),
    fields: [{ name: 'code', label: msgid('Status code'), kind: 'select', technical: true, options: [['400', msgid('400 · Bad request')], ['401', msgid('401 · Unauthorized')], ['403', msgid('403 · Forbidden')], ['404', msgid('404 · Not found')], ['500', msgid('500 · Internal server error')], ['502', msgid('502 · Bad gateway')], ['503', msgid('503 · Service unavailable')]] },
      { name: 'path', label: msgid('Page path'), kind: 'text', technical: true, max: 512, help: msgid('A URL path under the document root, for example /errors/404.html.') }],
    notes: [msgid('xPanel does not check that the page file exists. Upload it with the file manager; when it is missing, Apache shows its own message.'), msgid('Paths with .., spaces, quotes or a query string are refused.')] },
  indexes: { route: '/advanced/indexes', title: msgid('Directory indexes'), lede: msgid('Choose whether Apache lists the files of the document root when it has no index page.'),
    columns: [SETTING, VALUE], list: false, formTitle: msgid('Directory listing'),
    fields: [{ name: 'listing', label: msgid('Document root listing'), kind: 'select', options: [['inherit', msgid('Server default (no xPanel rule)')], ['enabled', msgid('Show the file list')], ['disabled', msgid('Hide the file list')]] }],
    notes: [msgid("This page manages the document root .htaccess file only. Per-folder settings need that folder's own file and are unavailable here.")] },
  'mime-types': { route: '/advanced/mime-types', title: msgid('MIME types'), lede: msgid('Tell browsers how to treat file extensions on this domain. xPanel writes Apache AddType rules into its marked block.'),
    columns: [msgid('MIME type'), msgid('Extensions'), ACTIONS], list: true, formTitle: msgid('Add or update a MIME type'),
    fields: [{ name: 'type', label: msgid('MIME type'), kind: 'text', technical: true, max: 255, help: msgid('type/subtype, for example text/markdown.') },
      { name: 'extensions', label: msgid('Extensions'), kind: 'text', technical: true, max: 512, help: msgid('Separate with spaces, for example .md .markdown.') }],
    notes: [msgid('Executable content types and script extensions are refused. PHP stays with the reviewed domain PHP handler.')] },
  handlers: { route: '/advanced/handlers', title: msgid('Apache handlers'), lede: msgid('Handler mappings decide which Apache module processes a file extension.'), columns: [], list: false, formTitle: '', fields: [],
    notes: [msgid("Handler mappings are unavailable. The reviewed account .htaccess policy does not permit AddHandler, and executable handlers stay with the server's reviewed PHP-FPM setup. Nothing was read or changed."), msgid('Use MIME types to change how browsers treat an extension.')] },
  hotlink: { route: '/security/hotlink', title: msgid('Hotlink protection'), lede: msgid('Stop other sites from embedding your files. xPanel writes Apache rewrite rules that check the referring site.'),
    columns: [SETTING, VALUE], list: false, formTitle: msgid('Hotlink rules'),
    fields: [{ name: 'enabled', label: msgid('Enable hotlink protection'), kind: 'checkbox' },
      { name: 'allowedHosts', label: msgid('Sites allowed to embed'), kind: 'textarea', technical: true, max: 8192, help: msgid('One host name per line, for example example.com.') },
      { name: 'extensions', label: msgid('File types'), kind: 'text', technical: true, max: 512, help: msgid('Extensions separated by spaces, for example jpg png.') },
      { name: 'allowEmptyReferrer', label: msgid('Allow requests with no referrer'), kind: 'checkbox' },
      { name: 'action', label: msgid('Blocked requests'), kind: 'select', options: [['forbid', msgid('Refuse with HTTP 403')], ['redirect', msgid('Redirect to a URL')]] },
      { name: 'redirectUrl', label: msgid('Redirect URL'), kind: 'text', technical: true, max: 2048, help: msgid('Used only for redirects. It must not end in a protected file type.') }],
    notes: [msgid('Rewriting must stay on for this file. A RewriteEngine Off line elsewhere in the file blocks this page.'), msgid('Browsers may omit the referrer; allowing empty referrers keeps direct visits working.')] },
  'ip-blocker': { route: '/security/ip-blocker', title: msgid('IP blocker'), lede: msgid('Refuse requests from specific addresses or ranges on this domain with Apache access rules.'),
    columns: [msgid('Address or range'), ACTIONS], list: true, formTitle: msgid('Block an address'),
    fields: [{ name: 'address', label: msgid('Address or range'), kind: 'text', technical: true, max: 64, help: msgid('IPv4 or IPv6 address, or a CIDR range such as 192.0.2.0/24.') }],
    notes: [msgid('At most 500 entries. Loopback addresses used by the local proxy are refused.'), msgid('Other access rules in the same file would combine with these rules, so the page refuses to edit while they exist.')] },
  redirects: { route: '/domains/redirects', title: msgid('Redirects'), lede: msgid('Send visitors from a path on this domain to another address with a permanent or temporary redirect.'),
    columns: [msgid('Type'), msgid('From path'), msgid('To URL'), ACTIONS], list: true, formTitle: msgid('Add or update a redirect'),
    fields: [{ name: 'status', label: msgid('Type'), kind: 'select', options: [['301', msgid('301 · Permanent')], ['302', msgid('302 · Temporary')]] },
      { name: 'path', label: msgid('From path'), kind: 'text', technical: true, max: 512, help: msgid('A path on this domain, for example /old-page.') },
      { name: 'target', label: msgid('To URL'), kind: 'text', technical: true, max: 2048, help: msgid('A full http or https address.') }],
    notes: [msgid('A redirect also applies to every path below it. More specific paths are checked first.'), msgid('Pattern redirects (RedirectMatch) are unavailable in this version.')] },
}
export const ACCOUNT_WEB_DIRECTIVE_ROUTES: Readonly<Record<string, AccountWebDirectivePage>> = Object.fromEntries(Object.entries(PAGES).map(([page, spec]) => [spec.route, page as AccountWebDirectivePage]))

const STYLE = '<style>.xp-wd{display:grid;gap:var(--xp-space-section);min-inline-size:0;text-align:start}.xp-wd :is(h1,h2,p,dl,dd,ol,ul){margin:0}.xp-wd__card{display:grid;gap:var(--xp-space-group);padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-md);min-inline-size:0;background:var(--xp-bg-surface)}.xp-wd__fields,.xp-wd__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--xp-space-field);min-inline-size:0}.xp-wd .xp-field{display:flex;flex-direction:column;gap:var(--xp-space-label);min-inline-size:0}.xp-wd :is(label,dt){margin:0;font-weight:600}.xp-wd :is(input:not([type=checkbox]),select,textarea){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:var(--xp-hit-target)}.xp-wd textarea{min-block-size:112px;resize:vertical}.xp-wd .xp-check{display:flex;align-items:center;gap:var(--xp-space-label);min-block-size:var(--xp-hit-target)}.xp-wd button{min-block-size:var(--xp-hit-target)}.xp-wd__actions{display:flex;flex-wrap:wrap;gap:var(--xp-space-field)}.xp-wd__table{overflow-x:auto;max-inline-size:100%}.xp-wd table{inline-size:100%;border-collapse:collapse}.xp-wd :is(th,td){padding:12px 8px;text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-wd :is(ol,ul){padding-inline-start:24px;display:grid;gap:var(--xp-space-field)}.xp-wd__notice{display:grid;gap:var(--xp-space-label);padding:var(--xp-space-field);border:1px solid var(--xp-status-warn-border,var(--xp-border));border-radius:var(--xp-radius-sm);background:var(--xp-status-warn-bg,var(--xp-bg-elevated));overflow-wrap:anywhere}.xp-wd__error{color:var(--xp-status-critical-fg)}.xp-wd[dir=rtl] :is(input,textarea)[dir=ltr]{text-align:right}.xp-wd [dir=ltr]{unicode-bidi:isolate}.xp-wd dd{overflow-wrap:anywhere}.xp-wd :disabled{cursor:not-allowed}.xp-wd :is(button,input,select,textarea):focus-visible{outline:var(--xp-focus-width) solid var(--xp-accent);outline-offset:var(--xp-focus-offset)}.xp-wd [hidden]{display:none}@media(min-width:601px){.xp-wd__card{padding:var(--xp-space-card)}}@media print{.xp-wd__actions{display:none}}.xp-wd__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-wd .xp-field:has(>textarea)>label{padding-inline:var(--xp-control-content-inset)}</style>'

function render(page: AccountWebDirectivePage, input: AccountWebDirectivesInput): string {
  const t = (copy: Copy): string => escapeHtml(translator(input.locale)(copy)), spec = PAGES[page], id = 'wd-' + page
  const domains = input.domains.filter(domain => domain.accountId === input.accountId)
  const head = `<div class="xp-wd__card"><h1>${t(spec.title)}</h1><p>${t(spec.lede)}</p>`
  const notes = `<section class="xp-wd__card" role="note" aria-labelledby="${id}-notes"><h2 id="${id}-notes">${t(msgid('Limits of this page'))}</h2><ul>${spec.notes.map(note => `<li>${t(note)}</li>`).join('')}</ul></section>`
  const root = `lang="${input.locale}" dir="${localeDirection(input.locale)}"`
  if (page === 'handlers') return `<section class="xp-wd" data-web-directives-unavailable="handlers" ${root}>${STYLE}${head}</div><p data-wd-status role="status" data-state="unavailable">${t(msgid('Apache handler mappings are unavailable for account files.'))}</p>${notes}</section>`
  const field = (item: Field): string => {
    const control = id + '-' + item.name, describe = `${item.help ? control + '-help ' : ''}${control}-error`, technical = item.technical ? ' dir="ltr"' : ''
    const help = item.help ? `<p class="xp-help" id="${control}-help">${t(item.help)}</p>` : '', error = `<p class="xp-wd__error" id="${control}-error" data-wd-error-for="${item.name}" hidden></p>`
    if (item.kind === 'checkbox') return `<div class="xp-field"><label class="xp-check" for="${control}"><input id="${control}" type="checkbox" data-wd-field="${item.name}" aria-describedby="${describe}" disabled>${t(item.label)}</label>${error}</div>`
    const label = `<label for="${control}">${t(item.label)}</label>`
    if (item.kind === 'select') return `<div class="xp-field">${label}<select id="${control}" class="xp-select" data-wd-field="${item.name}" aria-describedby="${describe}" disabled>${(item.options ?? []).map(([value, copy]) => `<option value="${escapeHtml(value)}">${t(copy)}</option>`).join('')}</select>${help}${error}</div>`
    if (item.kind === 'textarea') return `<div class="xp-field">${label}<textarea id="${control}" class="xp-input xp-mono"${technical} data-wd-field="${item.name}" maxlength="${item.max ?? 4096}" spellcheck="false" aria-describedby="${describe}" disabled></textarea>${help}${error}</div>`
    return `<div class="xp-field">${label}<input id="${control}" class="xp-input${item.technical ? ' xp-mono' : ''}"${technical} type="text" data-wd-field="${item.name}" maxlength="${item.max ?? 255}" spellcheck="false" autocomplete="off" aria-describedby="${describe}" disabled>${help}${error}</div>`
  }
  return `<section class="xp-wd" data-web-directives="${page}" data-wd-account="${escapeHtml(input.accountId)}" data-wd-manage="${input.canManage}" ${root}>${STYLE}${head}
    <div class="xp-field"><label for="${id}-domain">${t(msgid('Domain'))}</label><select id="${id}-domain" class="xp-select" data-wd-domain disabled>${domains.map(domain => `<option value="${escapeHtml(domain.id)}"${domain.id === input.selectedDomainId ? ' selected' : ''}>${escapeHtml(domain.name)}</option>`).join('')}</select></div>
    <dl class="xp-wd__facts"><div class="xp-field"><dt>${t(msgid('Account-relative file'))}</dt><dd><bdi dir="ltr" data-wd-path>${t(msgctxt('account-web-directives-workspace', 'Not read'))}</bdi></dd></div><div class="xp-field"><dt>${t(msgid('Blocks managed by xPanel'))}</dt><dd><bdi dir="ltr" data-wd-managed>${t(msgctxt('account-web-directives-workspace', 'Not read'))}</bdi></dd></div><div class="xp-field"><dt>${t(msgid('Local site check'))}</dt><dd><bdi dir="ltr" data-wd-http>${t(msgid('Not checked'))}</bdi></dd></div></dl></div>
    <p data-wd-status role="status" data-state="unread">${t(msgid('The current rules have not been read.'))}</p>
    <div class="xp-wd__notice" data-wd-notice role="note" hidden></div>
    <section class="xp-wd__card" aria-labelledby="${id}-current"><h2 id="${id}-current">${t(msgid('Current rules'))}</h2><div class="xp-wd__table" role="region" tabindex="0" aria-labelledby="${id}-current"><table class="xp-table"><thead><tr>${spec.columns.map(column => `<th scope="col">${t(column)}</th>`).join('')}</tr></thead><tbody data-wd-rows><tr><td colspan="${spec.columns.length}">${t(msgid('The current rules have not been read.'))}</td></tr></tbody></table></div></section>
    <section class="xp-wd__card" aria-labelledby="${id}-form"><h2 id="${id}-form">${t(spec.formTitle)}</h2><div class="xp-wd__fields">${spec.fields.map(field).join('')}</div>${spec.list ? `<div class="xp-wd__actions"><button type="button" class="xp-btn" data-wd-add disabled>${t(msgid('Add or update in draft'))}</button><button type="button" class="xp-btn" data-wd-clear disabled>${t(msgid('Clear form'))}</button></div>` : ''}</section>
    <section class="xp-wd__card" aria-labelledby="${id}-save"><h2 id="${id}-save">${t(msgid('Save changes'))}</h2><ol><li>${t(msgid('Re-reads the current file and its revision.'))}</li><li>${t(msgid('Replaces only the xPanel block for this page; other lines stay byte-for-byte.'))}</li><li>${t(msgid('Keeps the previous file, validates with the protected Apache parser and checks the site locally. A failed check restores the kept file.'))}</li></ol>
      <div class="xp-wd__actions"><button type="button" class="xp-btn" data-wd-refresh disabled>${t(msgid('Read saved rules'))}</button><button type="button" class="xp-btn" data-wd-discard disabled>${t(msgid('Discard draft'))}</button><button type="button" class="xp-btn xp-btn--primary" data-wd-save disabled>${t(msgid('Save and check site'))}</button></div>
      <ul data-wd-issues><li>${t(msgid('Diagnostics have not been read.'))}</li></ul></section>
    ${notes}${webDirectiveClientTemplates()}${page === 'redirects' ? redirectClientTemplates() : ''}</section>`
}

export const renderAccountErrorPagesWorkspace = (input: AccountWebDirectivesInput): string => render('error-pages', input)
export const renderAccountIndexesWorkspace = (input: AccountWebDirectivesInput): string => render('indexes', input)
export const renderAccountMimeTypesWorkspace = (input: AccountWebDirectivesInput): string => render('mime-types', input)
export const renderAccountHandlersWorkspace = (input: AccountWebDirectivesInput): string => render('handlers', input)
export const renderAccountHotlinkWorkspace = (input: AccountWebDirectivesInput): string => render('hotlink', input)
export const renderAccountIpBlockerWorkspace = (input: AccountWebDirectivesInput): string => render('ip-blocker', input)
export const renderAccountRedirectsWorkspace = (input: AccountWebDirectivesInput): string => render('redirects', input)
export const renderAccountWebDirectivePage = (page: AccountWebDirectivePage, input: AccountWebDirectivesInput): string => render(page, input)
