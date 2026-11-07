import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Read-only history browser inside the Git page; the repository comes from the page's own selector. */
export function renderAccountGitwebCard(lang: Locale, canRead: boolean): string {
  const translate = translator(lang), t = (copy: string): string => escapeHtml(translate(copy))
  const button = (hook: string, copy: string, hidden = false): string => `<button type="button" class="xp-btn" ${hook} disabled${hidden ? ' hidden' : ''}>${t(copy)}</button>`
  const table = (hook: string, title: string, heads: readonly string[]): string => `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t(title)}"><table class="xp-table"><thead><tr>${heads.map(head => `<th scope="col">${t(head)}</th>`).join('')}</tr></thead><tbody ${hook}></tbody></table></div>`
  const fact = (key: string, label: string): string => `<div><dt>${t(label)}</dt><dd><bdi dir="ltr" data-gitweb-fact="${key}">-</bdi></dd></div>`
  const options = [['message', msgid('Commit message')], ['author', msgid('Author')], ['committer', msgid('Committer')], ['pickaxe', msgid('Code added or removed')], ['content', msgid('File content')]].map(([value, label]) => `<option value="${value}">${t(label!)}</option>`).join('')
  return `<section class="xp-acct-tool__card" aria-labelledby="git-history-browser" data-account-gitweb data-gitweb-can-read="${canRead}"><h2 id="git-history-browser">${t(msgid('History browser'))}</h2>
    <template data-xp-template="gitweb-action"><button type="button" class="xp-btn"><span data-xp-slot="label"></span></button></template>
    <p>${t(msgid('Read history, files, branches and tags of the repository chosen above. This view cannot change anything.'))}</p>
    <div class="xp-acct-tool__fields"><div class="xp-field"><label for="gitweb-rev">${t(msgid('Revision'))}</label><select id="gitweb-rev" class="xp-input" dir="ltr" data-gitweb-rev disabled><option value="HEAD">HEAD</option></select></div>
    <div class="xp-field"><label for="gitweb-search-kind">${t(msgid('Search in'))}</label><select id="gitweb-search-kind" class="xp-input" data-gitweb-search-kind disabled>${options}</select></div>
    <div class="xp-field"><label for="gitweb-search-text">${t(msgid('Search for'))}</label><input id="gitweb-search-text" class="xp-input" dir="ltr" maxlength="200" autocomplete="off" spellcheck="false" data-gitweb-search-text disabled></div></div>
    <div class="xp-acct-tool__actions">${button('data-gitweb-log', msgid('Show history'))}${button('data-gitweb-tree', msgid('Show files'))}${button('data-gitweb-refs', msgid('Show branches and tags'))}${button('data-gitweb-search', msgid('Search'))}</div>
    <p data-gitweb-status role="status">${t(msgid('Choose a repository, then what to read.'))}</p>
    <div data-gitweb-panel="log" hidden>${table('data-gitweb-log-rows', msgid('Commits, newest first'), [msgid('Commit'), msgid('Date'), msgid('Author'), msgid('Message')])}<div class="xp-acct-tool__actions">${button('data-gitweb-more', msgid('Show older commits'))}</div></div>
    <div data-gitweb-panel="tree" hidden><p><bdi dir="ltr" data-gitweb-location>/</bdi></p><div class="xp-acct-tool__actions">${button('data-gitweb-up', msgid('Up one level'))}</div>${table('data-gitweb-tree-rows', msgid('Files'), [msgid('Name'), msgid('Size'), msgid('Mode')])}</div>
    <div data-gitweb-panel="refs" hidden>${table('data-gitweb-refs-rows', msgid('Branches and tags'), [msgid('Name'), msgid('Type'), msgid('Commit'), msgid('Date')])}</div>
    <div data-gitweb-panel="grep" hidden>${table('data-gitweb-grep-rows', msgid('Matching lines'), [msgid('File'), msgid('Line'), msgid('Text')])}</div>
    <div data-gitweb-panel="commit" hidden><dl class="xp-acct-tool__facts">${fact('hash', msgid('Commit'))}${fact('author', msgid('Author'))}${fact('date', msgid('Date'))}${fact('parents', msgid('Parents'))}${fact('subject', msgid('Message'))}${fact('body', msgid('Details'))}</dl>${table('data-gitweb-changes-rows', msgid('Changed files'), [msgid('File'), msgid('Lines')])}<div class="xp-acct-tool__actions">${button('data-gitweb-patch-download', msgid('Download patch'))}</div><pre dir="ltr" tabindex="0" data-gitweb-patch></pre></div>
    <div data-gitweb-panel="blob" hidden><p><bdi dir="ltr" data-gitweb-fact="file">-</bdi></p><div class="xp-acct-tool__actions">${button('data-gitweb-file-history', msgid('Show file history'))}${button('data-gitweb-blob-raw', msgid('Download file'))}</div><pre dir="ltr" tabindex="0" data-gitweb-blob></pre></div></section>`
}
