import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml } from '../../../html.ts'
import { operationButton, operationCard, operationField, operationSelect, operationTable } from './common.ts'

/** Read-only history browser; account-gitweb-client.ts owns the behaviour. The repository comes from the page's own selector. */
export function renderV2GitHistoryBrowser(t: Translate, canRead: boolean): string {
  const text = (copy: string): string => escapeHtml(t(copy))
  const fact = (key: string, label: string): string => `<div><dt>${text(label)}</dt><dd><bdi dir="ltr" data-gitweb-fact="${key}">—</bdi></dd></div>`
  const hidden = (html: string): string => html.replace('<button ', '<button hidden ')
  const options = [['message', msgid('Commit message')], ['author', msgid('Author')], ['committer', msgid('Committer')], ['pickaxe', msgid('Code added or removed')], ['content', msgid('File content')]].map(([value, label]) => `<option value="${value}">${text(label!)}</option>`).join('')
  const empty = text(msgid('Nothing read yet.'))
  const row = (columns: number): string => `<tr><td colspan="${columns}">${empty}</td></tr>`
  return `<div data-account-gitweb data-gitweb-can-read="${canRead}">${operationCard('v2-git-history-browser', t(msgid('History browser')),
    `<template data-xp-template="gitweb-action"><button type="button" class="v2-btn"><span data-xp-slot="label"></span></button></template>
<div class="v2-panel-operation-fields">${operationField('v2-gitweb-rev', t(msgid('Revision')), operationSelect('<select id="v2-gitweb-rev" dir="ltr" data-gitweb-rev disabled><option value="HEAD">HEAD</option></select>'))}${operationField('v2-gitweb-search-kind', t(msgid('Search in')), operationSelect(`<select id="v2-gitweb-search-kind" data-gitweb-search-kind disabled>${options}</select>`))}${operationField('v2-gitweb-search-text', t(msgid('Search for')), '<input id="v2-gitweb-search-text" dir="ltr" maxlength="200" autocomplete="off" spellcheck="false" data-gitweb-search-text disabled>')}</div>
<div class="v2-panel-operation-actions">${operationButton(t(msgid('Show history')), { 'data-gitweb-log': true })}${operationButton(t(msgid('Show files')), { 'data-gitweb-tree': true })}${operationButton(t(msgid('Show branches and tags')), { 'data-gitweb-refs': true })}${operationButton(t(msgid('Search')), { 'data-gitweb-search': true })}</div>
<p data-gitweb-status role="status">${text(msgid('Choose a repository, then what to read.'))}</p>
<div data-gitweb-panel="log" hidden>${operationTable('v2-gitweb-log', t(msgid('Commits, newest first')), [t(msgid('Commit')), t(msgid('Date')), t(msgid('Author')), t(msgid('Message'))], { 'data-gitweb-log-rows': true }, row(4))}<div class="v2-panel-operation-actions">${operationButton(t(msgid('Show older commits')), { 'data-gitweb-more': true })}</div></div>
<div data-gitweb-panel="tree" hidden><p><bdi dir="ltr" data-gitweb-location>/</bdi></p><div class="v2-panel-operation-actions">${operationButton(t(msgid('Up one level')), { 'data-gitweb-up': true })}</div>${operationTable('v2-gitweb-tree', t(msgid('Files')), [t(msgid('Name')), t(msgid('Size')), t(msgid('Mode'))], { 'data-gitweb-tree-rows': true }, row(3))}</div>
<div data-gitweb-panel="refs" hidden>${operationTable('v2-gitweb-refs', t(msgid('Branches and tags')), [t(msgid('Name')), t(msgid('Type')), t(msgid('Commit')), t(msgid('Date'))], { 'data-gitweb-refs-rows': true }, row(4))}</div>
<div data-gitweb-panel="grep" hidden>${operationTable('v2-gitweb-grep', t(msgid('Matching lines')), [t(msgid('File')), t(msgid('Line')), t(msgid('Text'))], { 'data-gitweb-grep-rows': true }, row(3))}</div>
<div data-gitweb-panel="commit" hidden><dl class="v2-panel-operation-facts">${fact('hash', msgid('Commit'))}${fact('author', msgid('Author'))}${fact('date', msgid('Date'))}${fact('parents', msgid('Parents'))}${fact('subject', msgid('Message'))}${fact('body', msgid('Details'))}</dl>${operationTable('v2-gitweb-changes', t(msgid('Changed files')), [t(msgid('File')), t(msgid('Lines'))], { 'data-gitweb-changes-rows': true }, row(2))}<div class="v2-panel-operation-actions">${hidden(operationButton(t(msgid('Download patch')), { 'data-gitweb-patch-download': true }))}</div><pre dir="ltr" tabindex="0" data-gitweb-patch></pre></div>
<div data-gitweb-panel="blob" hidden><p><bdi dir="ltr" data-gitweb-fact="file">—</bdi></p><div class="v2-panel-operation-actions">${operationButton(t(msgid('Show file history')), { 'data-gitweb-file-history': true })}${hidden(operationButton(t(msgid('Download file')), { 'data-gitweb-blob-raw': true }))}</div><pre dir="ltr" tabindex="0" data-gitweb-blob></pre></div>`,
    t(msgid('Read history, files, branches and tags of the repository chosen above. This view cannot change anything.')))}</div>`
}
