import { isToolAuthorized, tools as defaultCatalog } from '@xpanel/catalog'
import { htaccessClientTemplates } from '../advanced/directive-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/index.ts'
import { actions, area, button, deniedPage, esc, facts, field, fields, link, note, page, section, select, settingsContext, split, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2PanelHtaccessPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('.htaccess editor')), description = t(msgid('Edit site rules and validate before replacing the saved file.'))
  const canManage = c.editable && props.visibility?.principal.kind === 'user' && props.visibility.principal.accountId === c.account?.id
    && (props.catalog ?? defaultCatalog).some(tool => tool.id === 'domain-htaccess' && tool.status === 'verified' && tool.delivery.status === 'verified' && isToolAuthorized(tool, props.visibility!))
  // The existing controller reads row capabilities before enabling validation/save/restore.
  // No PHP update port is supplied by this bounded contract; migration remains unavailable.
  const context = section('v2-htaccess-context', t(msgid('Domain and file')), `<div class="v2-panel-ht-context">` + field('v2-htaccess-domain', t(msgid('Domain')), select('v2-htaccess-domain', '', (c.domains ?? []).map(domain => [domain.id, domain.name]), ' data-htaccess-domain', true, c.selected?.id))
    + facts([{ label: t(msgid('Account-relative file')), valueHtml: `<bdi dir="ltr" data-htaccess-path>${esc(t(msgid('Not read')))}</bdi>` }, { label: t(msgid('Local site check')), valueHtml: `<bdi dir="ltr" data-htaccess-http>${esc(t(msgid('Not checked')))}</bdi>` }]) + '</div>')
  const editor = card({ id: 'v2-htaccess-editor', title: t(msgid('File editor')), titleId: 'v2-htaccess-editor-heading', flush: true, actionsHtml: button(t(msgid('Read saved file')), { 'data-htaccess-refresh': true }), bodyHtml: `<div class="v2-panel-ht-toolbar">` + field('v2-htaccess-preset', t(msgid('Rewrite template')), select('v2-htaccess-preset', '', [['wordpress', 'WordPress'], ['https', t(msgid('Force HTTPS behind the proxy'))], ['private', t(msgid('Keep configuration files private'))]], ' data-htaccess-preset', true))
    + button(t(msgctxt('theme:v2', 'Insert at cursor')), { 'data-htaccess-insert': true }) + '</div>'
    + `<div class="v2-field"><label class="v2-sr" for="v2-htaccess-content">${esc(t(msgid('File contents')))}</label><div class="v2-settings-code-editor"><pre data-htaccess-gutter aria-hidden="true">1</pre><textarea id="v2-htaccess-content" class="v2-mono" dir="ltr" rows="20" wrap="off" maxlength="65536" spellcheck="false" autocomplete="off" data-htaccess-editor aria-describedby="v2-htaccess-diagnostics" readonly></textarea></div></div>`
    + `<p class="v2-panel-ht-foot"><span>UTF-8 · LF</span><span><bdi dir="ltr" data-htaccess-lines>1</bdi> ${esc(t(msgid('lines')))} · ${esc(t(msgid('64 KiB maximum')))}</span></p>` })
  const apply = `<section class="v2-card v2-panel-ht-apply" aria-label="${esc(t(msgid('Save and check site')))}">${status(t(msgid('The actual file has not been read.')), { 'data-htaccess-status': true })}${actions(button(t(msgid('Discard draft / undo draft changes')), { 'data-htaccess-discard': true }) + button(t(msgid('Save and check site')), { 'data-htaccess-save': true }, true, true))}</section>`
  const test = section('v2-htaccess-test', t(msgctxt('theme:v2', 'Test before the switch')), status(t(msgctxt('theme:v2', 'The current draft has not been tested.')), { 'data-htaccess-test-state': true })
    + note(t(msgctxt('theme:v2', 'The protected Apache parser validates the draft before a file switch. No parser output or site-check result has been read.')))
    + `<pre class="v2-panel-settings__preview v2-mono" dir="ltr" aria-label="${esc(t(msgctxt('theme:v2', 'Apache configuration test output')))}" data-htaccess-test-output>${esc(t(msgctxt('theme:v2', 'Test output has not been read.')))}</pre>`
    + facts([{ label: t(msgctxt('theme:v2', 'Tested')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Result')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Stack')), valueHtml: esc(t(msgid('Not read'))) }]), actions(button(t(msgctxt('theme:v2', 'Test the draft')), { 'data-htaccess-validate': true }) + button(t(msgctxt('theme:v2', 'Copy test output')), { 'data-htaccess-copy-test': true })))
  const changes = section('v2-htaccess-changes', t(msgctxt('theme:v2', 'Changes against the live version')), facts([{ label: t(msgctxt('theme:v2', 'Current · live')), valueHtml: `<span data-htaccess-diff-current>${esc(t(msgid('Not read')))}</span>` }, { label: t(msgctxt('theme:v2', 'Proposed · your draft')), valueHtml: `<span data-htaccess-diff-proposed>${esc(t(msgid('Not read')))}</span>` }])
    + table('v2-htaccess-diff', t(msgctxt('theme:v2', 'Unified diff')), [t(msgctxt('theme:v2', 'Live line')), t(msgctxt('theme:v2', 'Draft line')), t(msgid('Change')), t(msgid('Text'))], unreadRow(4, t(msgctxt('theme:v2', 'The live file and draft have not been compared.'))), { 'data-htaccess-diff-rows': true })
    + `<div class="v2-panel-settings__preview" data-htaccess-diff-clean hidden><h3>${esc(t(msgctxt('theme:v2', 'No pending changes')))}</h3><p>${esc(t(msgctxt('theme:v2', 'Shown only after the read draft is compared with the current file.')))}</p></div>`)
  const php = section('v2-htaccess-php', t(msgid('PHP settings in .htaccess')), note(t(msgid('PHP-FPM does not consume php_value/php_flag here. The move action requires the current domain PHP revision and a guarded update of both the PHP configuration and this file.')))
    + table('v2-htaccess-php-table', t(msgid('PHP directive compatibility')), [t(msgid('Directive')), t(msgid('Value')), t(msgid('Compatibility'))], unreadRow(3, t(msgid('The current draft has not been read.'))), { 'data-htaccess-php-rows': true })
    + fields(`<div class="v2-field"><span id="v2-htaccess-before-label">${esc(t(msgid('Before · PHP lines in the draft')))}</span><p data-htaccess-php-before-note>${esc(t(msgid('Not read')))}</p><pre class="v2-panel-settings__preview v2-mono" dir="ltr" aria-labelledby="v2-htaccess-before-label" data-htaccess-php-before hidden></pre></div><div class="v2-field"><span id="v2-htaccess-after-label">${esc(t(msgid('After · PHP settings preview')))}</span><p data-htaccess-php-after-note>${esc(t(msgid('Not read')))}</p><pre class="v2-panel-settings__preview v2-mono" dir="ltr" aria-labelledby="v2-htaccess-after-label" data-htaccess-php-after hidden></pre></div>`)
    + `<ul id="v2-htaccess-diagnostics" data-htaccess-issues><li>${esc(t(msgid('Diagnostics have not been read.')))}</li></ul>`
    + actions(button(t(msgid('Move PHP settings and save')), { 'data-htaccess-migrate': true }) + button(t(msgid('Undo saved move')), { 'data-htaccess-undo-migration': true }) + (authority.relatedRoutes?.has('/software/php') ? link(t(msgid('Review domain PHP settings')), '/software/php') : '')))
  const versions = section('v2-htaccess-versions', t(msgid('Kept versions')), note(t(msgid('The protected service keeps the latest 30 versions.')))
    + table('v2-htaccess-version-table', t(msgid('Kept versions')), [t(msgid('Saved at (UTC)')), t(msgid('Actor')), t(msgid('Bytes')), t(msgid('State')), t(msgid('Action'))], unreadRow(5, t(msgid('Kept versions have not been read.'))), { 'data-htaccess-versions': true }))
  const save = section('v2-htaccess-save', t(msgid('What a save does')), `<ol class="v2-panel-ht-steps">${[msgid('Checks the current domain, authorization and file revision.'), msgid('Keeps the current file before any replacement.'), msgid('Validates the candidate with the protected Apache parser.'), msgid('Writes the actual file and checks the authoritative site through loopback.'), msgid('Restores the kept content after a failed check only while the written candidate still matches. An unsafe or uncertain outcome stops further writes.')].map(copy => `<li>${esc(t(copy))}</li>`).join('')}</ol>`
    + (canManage ? '' : note(t(msgctxt('theme:v2', 'This route is not qualified for file changes. The editor and workflow remain visible, but no file operation is started.')))))
  return page(props, authority, '/software/htaccess', title, description, context + split(editor + test + changes + versions, php + save) + apply + htaccessClientTemplates(), { 'data-htaccess-workspace': true, 'data-htaccess-account': (c.account?.id ?? ''), 'data-htaccess-manage': String(canManage), 'data-wiring': canManage ? 'connected' : 'soon' })
}

const H = '.v2-panel-settings[data-htaccess-workspace]'
export const PANEL_HTACCESS_CSS = `${H} .v2-panel-settings__split{grid-template-columns:minmax(0,1fr) minmax(300px,380px)}
${H} .v2-panel-settings__split>.v2-panel-settings__groups{gap:var(--space-3)}
${H} .v2-card--flush,${H} .v2-card--flush>.v2-card__body{gap:0}
${H} .v2-card--flush>.v2-card__head{align-items:center;padding-block-end:var(--space-2)}
${H} .v2-panel-ht-context{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:var(--space-2) var(--space-3);align-items:start}
${H} .v2-panel-ht-context .v2-select{display:block}
${H} .v2-panel-ht-context select{inline-size:100%;font-family:var(--font-mono);font-size:13px}
${H} .v2-panel-settings__facts{grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr))}
${H} .v2-panel-settings__facts>div{padding-inline-start:12px;border-inline-start:1px solid var(--line)}
${H} .v2-panel-settings__facts dd{font-size:13px;font-weight:500}
${H} .v2-panel-ht-toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-1) var(--space-2);padding:var(--space-2) var(--v2-panel-padding);border-block:1px solid var(--line);background:var(--subtle)}
${H} .v2-panel-ht-toolbar>.v2-field{flex:1 1 220px;max-inline-size:360px;min-inline-size:0}
${H} .v2-panel-ht-toolbar select{inline-size:100%}
${H} .v2-card--flush .v2-settings-code-editor{border:0;border-radius:0}
${H} .v2-panel-ht-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px var(--space-2);padding:12px var(--v2-panel-padding);border-block-start:1px solid var(--line);background:var(--subtle);font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
${H} .v2-panel-ht-apply{flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px var(--space-2);padding-block:var(--space-2)}
${H} .v2-panel-ht-apply>p{flex:1 1 320px;min-inline-size:0;font-size:14px;font-weight:600}
${H} pre.v2-panel-settings__preview{background:var(--code);color:var(--code-text);border-color:transparent;font-size:12px;line-height:1.7}
${H} .v2-card__body>ul{list-style:none;padding:0;font-size:13px;color:var(--muted)}
${H} ol.v2-panel-ht-steps{list-style:none;padding:0;counter-reset:ht-step;gap:12px}
${H} ol.v2-panel-ht-steps>li{counter-increment:ht-step;display:grid;grid-template-columns:24px minmax(0,1fr);gap:12px;font-size:13px;line-height:1.5;color:var(--text-2)}
${H} ol.v2-panel-ht-steps>li::before{content:counter(ht-step);display:flex;align-items:center;justify-content:center;inline-size:24px;block-size:24px;border-radius:50%;background:var(--sunken);color:var(--text-2);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
${H} .v2-field>span[id]{font-size:12px;font-weight:600;color:var(--muted)}
@media(max-width:1000px){${H} .v2-panel-settings__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:700px){${H} .v2-panel-ht-context{grid-template-columns:minmax(0,1fr)}${H} .v2-panel-ht-toolbar>.v2-field{max-inline-size:none}${H} .v2-panel-ht-apply .v2-panel-settings__actions,${H} .v2-panel-ht-apply .v2-panel-settings__actions>button{flex:1 1 auto}${H} .v2-settings-code-editor>:is(pre,textarea){block-size:320px}}
.v2-panel-settings .v2-settings-code-editor{display:grid;grid-template-columns:48px minmax(0,1fr);border:1px solid var(--line);border-radius:var(--radius-control);overflow:hidden;direction:ltr}.v2-panel-settings .v2-settings-code-editor>pre{padding:12px 4px;text-align:end;user-select:none;background:var(--sunken);color:var(--muted);font-family:var(--font-mono);white-space:pre;block-size:420px}.v2-panel-settings .v2-settings-code-editor>textarea{border:0;border-radius:0;padding:12px;white-space:pre;overflow:auto;block-size:420px}
.v2-panel-settings .v2-settings-code-editor>:is(pre,textarea){margin:0;font-family:var(--font-mono);font-size:13px;line-height:20px;padding-block:12px}.v2-panel-settings .v2-settings-code-editor>textarea{text-align:start}`
