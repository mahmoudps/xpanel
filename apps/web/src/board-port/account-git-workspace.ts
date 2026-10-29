import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Account Git follows the approved Files table, field and action hierarchy. */
export function renderAccountGitWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled'
  const button = (id: string, message: string): string => `<button type="button" class="xp-btn" data-git-${id}${off}>${t(message)}</button>`
  return `<div class="xp-acct-tool" data-account-git data-account="${escapeHtml(input.accountId)}" data-git-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}<style>[data-account-git] label:is([for="git-repository"],[for="git-branch"]){padding-inline:var(--xp-control-content-inset)}[data-account-git] .xp-acct-tool__card{border-radius:var(--xp-radius-md)}[data-account-git] .xp-acct-tool__card>h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}@media(min-width:601px){[data-account-git] .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="git-repositories"><h2 id="git-repositories">${t('Your repositories')}</h2>
      <p>${t('Manage up to 20 repositories within your home directory. Removing an entry keeps its files.')}</p>
      <div class="xp-field"><label for="git-repository">${t('Repository')}</label><select id="git-repository" class="xp-input" dir="ltr" data-git-repository${off}><option value="">${t('Read the list first')}</option></select></div>
      <div class="xp-acct-tool__actions">${button('refresh', 'Read repositories')}${button('inspect', 'Read repository')}${button('remove', 'Remove from list')}</div>
      <p data-git-status role="status">${t('Repositories have not been read.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="git-create"><h2 id="git-create">${t('Create or clone')}</h2>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="git-path">${t('Path relative to home')}</label><input id="git-path" class="xp-input" dir="ltr" autocomplete="off" spellcheck="false" maxlength="240" placeholder="repositories/site" data-git-path${off}></div>
      <div class="xp-field"><label for="git-initial-branch">${t('Initial branch for a new repository')}</label><input id="git-initial-branch" class="xp-input" dir="ltr" value="main" autocomplete="off" spellcheck="false" maxlength="120" data-git-initial-branch${off}></div></div>
      <div class="xp-field"><label for="git-url">${t('Public HTTPS clone URL')}</label><input id="git-url" class="xp-input" type="url" dir="ltr" autocomplete="off" spellcheck="false" maxlength="512" placeholder="https://example.com/team/site.git" data-git-url${off}></div>
      <p class="xp-help">${t('The parent directory must exist. Use a new path. Credentials, SSH URLs, submodules and custom Git commands are not accepted. Large clones may exceed the 60-second limit.')}</p>
      <div class="xp-acct-tool__actions">${button('init', 'Create repository')}${button('clone', 'Clone repository')}</div></section>
    <section class="xp-acct-tool__card" aria-labelledby="git-details"><h2 id="git-details">${t('Repository details')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Path')}</dt><dd><bdi dir="ltr" data-git-selected>-</bdi></dd></div><div><dt>${t('Current branch')}</dt><dd><bdi dir="ltr" data-git-current>-</bdi></dd></div><div><dt>${t('Working tree')}</dt><dd data-git-tree>${t(msgctxt('account-git-workspace', 'Not read'))}</dd></div><div><dt>${t('Origin')}</dt><dd><bdi dir="ltr" data-git-origin>-</bdi></dd></div></dl>
      <div class="xp-field"><label for="git-branch">${t('Existing branch')}</label><select id="git-branch" class="xp-input" dir="ltr" data-git-branch${off}><option value="">-</option></select></div>
      <div class="xp-acct-tool__actions">${button('checkout', 'Switch branch')}${button('pull', 'Pull fast-forward only')}</div>
      <p class="xp-help">${t('Switching and pulling require a clean working tree. Commit or discard your changes through your own Git workflow first.')}</p>
      <div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${t('Recent commits')}"><table class="xp-table"><thead><tr><th scope="col">${t('Commit')}</th><th scope="col">${t('Date')}</th><th scope="col">${t('Message')}</th></tr></thead><tbody data-git-history><tr><td colspan="3">${t('History has not been read.')}</td></tr></tbody></table></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="git-deployment"><h2 id="git-deployment">${t('Deployment tasks')}</h2><p>${t('Deployment tasks and Git web access are unavailable. Repository actions do not publish your website.')}</p><div class="xp-acct-tool__actions"><button class="xp-btn" type="button" disabled>${t('Deploy')}</button></div></section>
  </div>`
}
