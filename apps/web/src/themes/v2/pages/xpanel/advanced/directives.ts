import { webDirectiveClientTemplates } from './directive-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, area, button, check, deniedPage, esc, facts, field, fields, input, note, page, section, select, settingsContext, split, status, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

type DirectiveKind = 'error-pages' | 'indexes' | 'mime-types' | 'handlers' | 'hotlink' | 'ip-blocker'
interface DirectiveField { key: string; label: string; kind?: 'select' | 'textarea' | 'checkbox'; options?: readonly (readonly [string, string])[]; maxlength?: number; help?: string; technical?: boolean }
interface DirectiveSpec { route: string; title: string; description: string; columns: readonly string[]; formTitle: string; fields: readonly DirectiveField[]; notes: readonly string[]; list?: boolean }

const SPECS: Readonly<Record<DirectiveKind, DirectiveSpec>> = {
  'error-pages': { route: '/advanced/error-pages', title: msgid('Error pages'), description: msgctxt('theme:v2', 'Map common HTTP errors to pages in this domain. Changes replace only the managed block.'),
    columns: [msgid('Status code'), msgid('Page path'), msgid('File check'), msgid('Actions')], formTitle: msgid('Add or update an error page'), list: true,
    fields: [{ key: 'code', label: msgid('Status code'), kind: 'select', options: [['400', '400 · Bad request'], ['401', '401 · Unauthorized'], ['403', '403 · Forbidden'], ['404', '404 · Not found'], ['500', '500 · Internal server error'], ['502', '502 · Bad gateway'], ['503', '503 · Service unavailable']] }, { key: 'path', label: msgid('Page path'), technical: true, maxlength: 512, help: msgctxt('theme:v2', 'A URL path under the document root, such as /errors/404.html.') }],
    notes: [msgctxt('theme:v2', 'Upload the page with the file manager. Saving these rules does not prove that the page file exists.'), msgctxt('theme:v2', 'Paths with parent traversal, spaces, quotes or query strings are refused.')] },
  indexes: { route: '/advanced/indexes', title: msgid('Directory indexes'), description: msgctxt('theme:v2', 'Choose whether Apache lists files when the document root has no index page.'),
    columns: [msgid('Setting'), msgid('Value')], formTitle: msgctxt('theme:v2', 'Document root listing'),
    fields: [{ key: 'listing', label: msgctxt('theme:v2', 'Document root listing'), kind: 'select', options: [['inherit', msgctxt('theme:v2', 'Server default (no managed rule)')], ['enabled', msgctxt('theme:v2', 'Show the file list')], ['disabled', msgctxt('theme:v2', 'Hide the file list')]] }],
    notes: [msgctxt('theme:v2', 'This page manages the document root only. Per-folder settings require that folder’s own file.')] },
  'mime-types': { route: '/advanced/mime-types', title: msgid('MIME types'), description: msgctxt('theme:v2', 'Set the response content type for file extensions on this domain.'),
    columns: [msgid('MIME type'), msgid('Extensions'), msgid('Actions')], formTitle: msgid('Add or update a MIME type'), list: true,
    fields: [{ key: 'type', label: msgid('MIME type'), technical: true, maxlength: 255, help: msgctxt('theme:v2', 'Use type/subtype, such as text/markdown.') }, { key: 'extensions', label: msgid('Extensions'), technical: true, maxlength: 512, help: msgctxt('theme:v2', 'Separate extensions with spaces, such as .md .markdown.') }],
    notes: [msgctxt('theme:v2', 'Executable content types and script extensions are refused. PHP stays with the reviewed domain handler.')] },
  handlers: { route: '/advanced/handlers', title: msgid('Apache handlers'), description: msgctxt('theme:v2', 'Handler mappings choose which server module processes a file extension.'), columns: [msgid('Handler'), msgid('Extensions'), msgid('Actions')], formTitle: msgctxt('theme:v2', 'Add handler'),
    fields: [{ key: 'handler', label: msgid('Handler'), technical: true }, { key: 'extensions', label: msgid('Extensions'), technical: true }],
    notes: [msgctxt('theme:v2', 'Account handler mappings are unavailable. The reviewed file policy does not permit AddHandler. Executable handlers stay with the server PHP setup.')] },
  hotlink: { route: '/security/hotlink', title: msgid('Hotlink protection'), description: msgctxt('theme:v2', 'Control which referring sites may embed this domain’s files.'), columns: [msgid('Setting'), msgid('Value')], formTitle: msgid('Hotlink rules'),
    fields: [{ key: 'enabled', label: msgid('Enable hotlink protection'), kind: 'checkbox' }, { key: 'allowedHosts', label: msgid('Sites allowed to embed'), kind: 'textarea', technical: true, maxlength: 8192, help: msgctxt('theme:v2', 'One host name per line.') }, { key: 'extensions', label: msgid('File types'), technical: true, maxlength: 512 }, { key: 'allowEmptyReferrer', label: msgid('Allow requests with no referrer'), kind: 'checkbox' }, { key: 'action', label: msgid('Blocked requests'), kind: 'select', options: [['forbid', msgid('Refuse with HTTP 403')], ['redirect', msgid('Redirect to a URL')]] }, { key: 'redirectUrl', label: msgid('Redirect URL'), technical: true, maxlength: 2048 }],
    notes: [msgctxt('theme:v2', 'Allowing empty referrers keeps direct visits and privacy-minded browsers working.'), msgctxt('theme:v2', 'Rewriting must remain on. Redirects must not end in a protected file type.')] },
  'ip-blocker': { route: '/security/ip-blocker', title: msgid('IP blocker'), description: msgctxt('theme:v2', 'Refuse website requests from selected addresses and ranges.'), columns: [msgid('Address or range'), msgid('Actions')], formTitle: msgid('Block an address'), list: true,
    fields: [{ key: 'address', label: msgid('Address or range'), technical: true, maxlength: 64, help: msgctxt('theme:v2', 'Use an IPv4 or IPv6 address, or a CIDR range such as 192.0.2.0/24.') }],
    notes: [msgctxt('theme:v2', 'At most 500 entries. Loopback addresses used by the local proxy are refused.'), msgctxt('theme:v2', 'Other access rules in the same file must be resolved before this managed block can be changed.')] },
}

/** Controls stay disabled until the existing controller has read the file revision. */
export function renderV2WebDirectivePage(props: PanelSurfaceProps, kind: DirectiveKind, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, spec = SPECS[kind], id = `v2-wd-${kind}`
  const title = t(spec.title), description = t(spec.description)
  const current = section(`${id}-context`, t(msgctxt('theme:v2', 'Domain and file')), fields(field(`${id}-domain`, t(msgid('Domain')), select(`${id}-domain`, '', (c.domains ?? []).map(domain => [domain.id, domain.name]), ' data-wd-domain', true, c.selected?.id)))
    + facts([{ label: t(msgid('Account-relative file')), valueHtml: `<bdi class="v2-mono" dir="ltr" data-wd-path>${esc(t(msgid('Not read')))}</bdi>` }, { label: t(msgid('Blocks managed by xPanel')), valueHtml: `<bdi dir="ltr" data-wd-managed>${esc(t(msgid('Not read')))}</bdi>` }, { label: t(msgid('Local site check')), valueHtml: `<bdi dir="ltr" data-wd-http>${esc(t(msgid('Not checked')))}</bdi>` }])
    + status(t(msgid('The current rules have not been read.')), { 'data-wd-status': true })
    + '<div class="v2-panel-settings__preview" data-wd-notice role="note" hidden></div>')
  const controls = spec.fields.map(item => {
    const controlId = `${id}-${item.key}`, extra = ` data-wd-field="${esc(item.key)}" aria-describedby="${controlId}-error${item.help ? ` ${controlId}-help` : ''}"${item.technical ? ' dir="ltr" class="v2-mono"' : ''}`
    const control = item.kind === 'checkbox' ? `<label class="v2-panel-settings__check" for="${controlId}"><input id="${controlId}" type="checkbox" data-wd-field="${esc(item.key)}" aria-describedby="${controlId}-error" disabled><span>${esc(t(item.label))}</span></label>`
      : item.kind === 'select' ? select(controlId, '', (item.options ?? []).map(([value, label]) => [value, t(label)]), extra)
      : item.kind === 'textarea' ? area(controlId, '', `${extra} rows="5" maxlength="${item.maxlength ?? 4096}" spellcheck="false" autocomplete="off"`)
      : input(controlId, '', 'text', `${extra} maxlength="${item.maxlength ?? 255}" spellcheck="false" autocomplete="off"`)
    return (item.kind === 'checkbox' ? control : field(controlId, t(item.label), control, item.help ? t(item.help) : undefined)) + `<p class="v2-field__error" id="${controlId}-error" data-wd-error-for="${item.key}" hidden></p>`
  }).join('')
  const draft = section(`${id}-rules`, t(kind === 'error-pages' ? msgctxt('theme:v2', 'Rules in the draft') : msgid('Current rules')), table(`${id}-table`, title, spec.columns.map(label => t(label)), unreadRow(spec.columns.length, t(msgid('The current rules have not been read.'))), { 'data-wd-rows': true }))
  const editor = section(`${id}-editor`, t(spec.formTitle), fields(controls) + (spec.list ? actions(button(t(msgid('Add or update in draft')), { 'data-wd-add': true }) + button(t(msgid('Clear form')), { 'data-wd-clear': true })) : ''))
  const save = section(`${id}-save`, t(msgid('Save changes')), `<ol><li>${esc(t(msgid('Re-reads the current file and its revision.')))}</li><li>${esc(t(msgid('Replaces only the xPanel block for this page; other lines stay byte-for-byte.')))}</li><li>${esc(t(msgctxt('theme:v2', 'Keeps the previous file, validates with the protected Apache parser and checks the site locally. A failed check restores the kept file.')))}</li></ol>`
    + actions(button(t(msgid('Read saved rules')), { 'data-wd-refresh': true }) + button(t(msgid('Discard draft')), { 'data-wd-discard': true }) + button(t(msgid('Save and check site')), { 'data-wd-save': true }, true, true))
    + `<ul data-wd-issues><li>${esc(t(msgid('Diagnostics have not been read.')))}</li></ul>`)
  const limits = section(`${id}-limits`, t(msgid('Limits of this page')), `<ul>${spec.notes.map(copy => `<li>${esc(t(copy))}</li>`).join('')}</ul>`)
  if (kind === 'handlers') {
    return page(props, authority, spec.route, title, description, split(current + draft + editor, limits + status(t(msgid('Apache handler mappings are unavailable for account files.')), { 'data-wd-status': true })), { 'data-web-directives-unavailable': kind })
  }
  return page(props, authority, spec.route, title, description, split(current + draft + editor + save, limits) + webDirectiveClientTemplates(), { 'data-web-directives': kind, 'data-wd-account': (c.account?.id ?? ''), 'data-wd-manage': String(c.editable) })
}

export const V2_WEB_DIRECTIVE_ROUTES: Readonly<Record<string, DirectiveKind>> = Object.freeze(Object.fromEntries(Object.entries(SPECS).map(([kind, spec]) => [spec.route, kind as DirectiveKind])))
