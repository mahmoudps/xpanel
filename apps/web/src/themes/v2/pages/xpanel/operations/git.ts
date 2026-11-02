import type { PanelSurfaceProps } from '../../../../contract.ts'
import { escapeHtml } from '../../../html.ts'
import { gitHistoryClientTemplates } from '../settings/utility-client-templates.ts'
import { deniedOperationAuthority, operationButton, operationCard, operationContext, operationFacts, operationField, operationPage, operationTable, unreadRow, type PanelOperationAuthority } from './common.ts'

/** Repository requests and revision/HEAD guards stay in the existing core controller. */
export function renderV2AccountGitPage(props: PanelSurfaceProps, authority: PanelOperationAuthority = deniedOperationAuthority): string {
  const { t, canManage, account } = operationContext(props, authority, '/files/git')
  props = { ...props, account }
  const unread = t(msgid('Not read'))
  const repositories = operationCard('v2-git-repositories', t(msgid('Your repositories')),
    `${operationField('v2-git-repository', t(msgid('Repository')), `<select id="v2-git-repository" dir="ltr" data-git-repository disabled><option value="">${escapeHtml(t(msgid('Read the list first')))}</option></select>`)}
<div class="v2-panel-operation-actions">${operationButton(t(msgid('Read repositories')), { 'data-git-refresh': true }, !canManage)}${operationButton(t(msgid('Read repository')), { 'data-git-inspect': true })}${operationButton(t(msgid('Remove from list')), { 'data-git-remove': true })}</div><p data-git-status role="status">${escapeHtml(t(msgid('Repositories have not been read.')))}</p>`,
    t(msgid('Manage up to 20 repositories within your home directory. Removing an entry keeps its files.')))
  const create = operationCard('v2-git-create', t(msgid('Create or clone')),
    `<div class="v2-panel-operation-fields">${operationField('v2-git-path', t(msgid('Path relative to home')), '<input id="v2-git-path" dir="ltr" autocomplete="off" spellcheck="false" maxlength="240" data-git-path disabled>')}${operationField('v2-git-initial-branch', t(msgid('Initial branch for a new repository')), '<input id="v2-git-initial-branch" dir="ltr" value="main" autocomplete="off" spellcheck="false" maxlength="120" data-git-initial-branch disabled>')}</div>
${operationField('v2-git-url', t(msgid('Public HTTPS clone URL')), '<input id="v2-git-url" type="url" dir="ltr" autocomplete="off" spellcheck="false" maxlength="512" data-git-url disabled>')}
<p>${escapeHtml(t(msgid('The parent directory must exist. Use a new path. Credentials, SSH URLs, submodules and custom Git commands are not accepted. Large clones may exceed the 60-second limit.')))}</p><div class="v2-panel-operation-actions">${operationButton(t(msgid('Create repository')), { 'data-git-init': true })}${operationButton(t(msgid('Clone repository')), { 'data-git-clone': true })}</div>`)
  const details = operationCard('v2-git-details', t(msgid('Repository details')),
    `${operationFacts([{ label: t(msgid('Path')), valueHtml: '<bdi dir="ltr" data-git-selected>—</bdi>' }, { label: t(msgid('Current branch')), valueHtml: '<bdi dir="ltr" data-git-current>—</bdi>' }, { label: t(msgid('Working tree')), valueHtml: `<span data-git-tree>${escapeHtml(unread)}</span>` }, { label: t(msgid('Origin')), valueHtml: '<bdi dir="ltr" data-git-origin>—</bdi>' }])}
${operationField('v2-git-branch', t(msgid('Existing branch')), '<select id="v2-git-branch" dir="ltr" data-git-branch disabled><option value="">—</option></select>')}<div class="v2-panel-operation-actions">${operationButton(t(msgid('Switch branch')), { 'data-git-checkout': true })}${operationButton(t(msgid('Pull fast-forward only')), { 'data-git-pull': true })}</div>
<p>${escapeHtml(t(msgid('Switching and pulling require a clean working tree. Commit or discard your changes through your own Git workflow first.')))}</p>
${operationTable('v2-git-history', t(msgid('Recent commits')), [t(msgid('Commit')), t(msgid('Date')), t(msgid('Message'))], { 'data-git-history': true }, unreadRow(3, t(msgid('History has not been read.'))))}`)
  const deployment = operationCard('v2-git-deployment', t(msgid('Deployment tasks')), `<p>${escapeHtml(t(msgid('Deployment tasks and Git web access are unavailable. Repository actions do not publish your website.')))}</p>${operationButton(t(msgid('Deploy')))}`)
  return operationPage(props, '/files/git', t(msgid('Git & deployments')), t(msgctxt('theme:v2', 'Inspect account-confined repositories and review each branch or fast-forward change.')),
    `<div data-account-git data-account="${escapeHtml(account?.id ?? '')}" data-git-manage="${canManage}" class="v2-panel-operation-stack">${gitHistoryClientTemplates()}<div class="v2-panel-operation-columns"><div class="v2-panel-operation-stack">${repositories}${create}${details}</div><aside class="v2-panel-operation-stack" aria-label="${escapeHtml(t(msgid('Deployment tasks')))}">${deployment}</aside></div></div>`, undefined, authority)
}
