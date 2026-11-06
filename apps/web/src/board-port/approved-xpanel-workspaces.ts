import type { PanelSurfaceProps } from '../surfaces/xpanel.ts';
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH } from '@xpanel/core';
import type { AuthPersonalView } from '../themes/contract.ts';
import { accountApiTokenClientTemplates } from '../account-api-tokens-templates.ts';
import { isToolAuthorized } from '@xpanel/catalog'
import { type Locale, translator } from '../i18n.ts'
import { escapeHtml, normalizeAsciiDigits } from '../tokens.ts';
import { contextualizeNavigationHref } from '../document-routes.ts';
import { parseWebsiteAnalyticsSnapshot, WEBSITE_ANALYTICS_WINDOWS } from '../models/website-analytics.ts';
import { buildApprovedPanelPage } from './approved-xpanel-pages.ts';
import { renderAccountBackupWorkspace } from './account-backup-workspace.ts';
import { renderAccountCronWorkspace } from './account-cron-workspace.ts';
import { renderAccountHtaccessWorkspace } from './account-htaccess-workspace.ts';
import { ACCOUNT_WEB_DIRECTIVE_ROUTES, renderAccountWebDirectivePage } from './account-web-directives-workspace.ts';
import { renderAccountSshWorkspace } from './account-ssh-workspace.ts';
import { renderAccountLogsWorkspace } from './account-logs-workspace.ts';
import { renderAccountVirusScanWorkspace } from './account-virus-scan-workspace.ts';
import { renderAccountNetworkToolsWorkspace } from './account-network-tools-workspace.ts';
import { renderAccountDatabaseInsightsWorkspace } from './account-database-insights-workspace.ts';
import { renderAccountDynamicDnsWorkspace } from './account-dynamic-dns-workspace.ts';
import { renderAccountSitePublisherWorkspace } from './account-site-publisher-workspace.ts';
import { renderAccountGitWorkspace } from './account-git-workspace.ts';
import { renderAccountReverseProxyWorkspace } from './account-reverse-proxy-workspace.ts';
import { renderAccountPgpWorkspace } from './account-pgp-workspace.ts';
import { renderAccountPackagesWorkspace } from './account-packages-workspace.ts';
import { renderAccountDatabaseRemoteWorkspace } from './account-database-remote-workspace.ts';
import { renderAccountCollaborationWorkspace } from './account-collaboration-workspace.ts';
import { renderMailxArchiveWorkspace } from './mailx-archive-workspace.ts';
import { renderMailxCollectionsWorkspace } from './mailx-collections-workspace.ts';
import { renderSwApplicationsWorkspace } from './sw-applications-workspace.ts';
import { renderAccountCacheWorkspace, renderAccountContainersWorkspace } from './account-runtime-workspace.ts';
import { renderSwOptimizeWorkspace } from './sw-optimize-workspace.ts';
import { renderAccountDbEngineWorkspace } from './db-engines-workspace.ts';
import type { AccountDbEnginePage } from './db-engines-workspace.ts';
import { renderAccountStagingWorkspace } from './acct-staging-workspace.ts';
import { renderAccountTeamWorkspace } from './acct-team-workspace.ts';
import { renderWhmDeveloperWorkspace } from './whm-developer-workspace.ts';
import { renderSiteHealthWorkspace } from './site-health-workspace.ts';
import { renderSecWorkspace } from './sec-workspace.ts';
import { renderConnectedPanelPhp, renderConnectedPanelDns, renderConnectedPanelDirectoryPrivacy, renderConnectedPanelSsl, renderConnectedPanelSessions } from './approved-xpanel-bindings.ts';
type Copy = string;
export interface ApprovedXpanelWorkspaceProps extends Omit<PanelSurfaceProps, 'locale'> {
    route: string;
    locale: Locale;
    readOnly: boolean;
    nativeHtml?: string;
    authPersonal?: AuthPersonalView;
}
export const approvedXpanelWorkspaceRoutes: ReadonlySet<string> = new Set(['/domains/reverse-proxy', '/resources', '/email/accounts', '/files/manager', '/files/trash', '/files/directory-privacy', '/domains/site-settings', '/files/backup', '/databases/mariadb', '/domains', '/domains/zone-editor', '/metrics/traffic', '/metrics/web-stats', '/security/ssl', '/security/account', '/software/php', '/software/htaccess', '/advanced/cron', '/advanced/error-pages', '/advanced/indexes', '/advanced/mime-types', '/advanced/handlers', '/security/hotlink', '/security/ip-blocker', '/domains/redirects', '/security/ssh', '/metrics/logs', '/health', '/security/virus-scanner', '/advanced/network-tools', '/databases/insights', '/domains/dynamic-dns', '/domains/site-publisher', '/files/git', '/email/encryption', '/software/packages', '/databases/remote-access', '/email/calendars-contacts', '/advanced/api-shell', '/email/archive', '/domains/staging', '/preferences/team', '/databases/phpmyadmin', '/databases/postgresql', '/databases/phppgadmin', '/software/apps', '/software/containers', '/software/cache', '/software/optimize', '/security/waf', '/domains/cloudflare']);
const copy = (p: ApprovedXpanelWorkspaceProps, x: Copy): string => escapeHtml(translator(p.locale)(x));
const value = (x: unknown): string => escapeHtml(normalizeAsciiDigits(x == null ? '' : String(x)));
const unread: Copy = msgctxt('approved-xpanel-workspaces', 'Not read');
interface Field {
    label: Copy;
    key?: string;
    value?: unknown;
    type?: string;
    choices?: readonly Copy[];
    technicalLabel?: boolean;
    technicalChoices?: boolean;
}
interface Section {
    id: string;
    title: Copy;
    fields?: Field[];
    actions?: Copy[];
    message?: Copy;
    columns?: Copy[];
    rows?: string[][];
    read?: boolean;
    steps?: Copy[];
    chart?: boolean;
    /** Connected actions: label to file selection action; the remaining actions stay unavailable. */
    actionHooks?: Readonly<Record<Copy, string>>;
}
interface Page {
    title: Copy;
    description: Copy;
    sections: Section[];
    aside: Section[];
}
const facts = (p: ApprovedXpanelWorkspaceProps, fields: readonly Field[]): string => `<dl class="xp-panel-detail__facts">${fields.map(f => `<div><dt>${copy(p, f.label)}</dt><dd>${f.value == null ? copy(p, unread) : `<bdi dir="ltr">${value(f.value)}</bdi>`}</dd></div>`).join('')}</dl>`;
const control = (p: ApprovedXpanelWorkspaceProps, section: string, field: Field, index: number): string => {
    const id = `panel-detail-${section}-${index}`;
    const label = field.technicalLabel ? `<bdi dir="ltr">${copy(p, field.label)}</bdi>` : copy(p, field.label);
    const choiceCopy = (choice: Copy) => field.technicalChoices ? `<bdi dir="ltr">${copy(p, choice)}</bdi>` : copy(p, choice);
    if (field.type === 'radio' && field.choices) {
        return `<fieldset class="xp-panel-detail__radio" disabled><legend>${label}</legend>${field.choices.map((choice, choiceIndex) => `<label class="xp-check" for="${id}-${choiceIndex}"><input id="${id}-${choiceIndex}" name="${id}" type="radio" value="${value(choice)}" disabled><span>${choiceCopy(choice)}</span></label>`).join('')}</fieldset>`;
    }
    let input: string;
    if (field.choices) {
        input = `<select id="${id}" class="xp-select" disabled><option>${copy(p, unread)}</option>${field.choices.map(choice => `<option>${copy(p, choice)}</option>`).join('')}</select>`;
    }
    else if (field.type === 'textarea') {
        input = `<textarea id="${id}" class="xp-textarea xp-mono" dir="ltr" rows="6" disabled>${value(field.value)}</textarea>`;
    }
    else {
        const password = field.type === 'password' ? ' autocomplete="new-password"' : '';
        const storedValue = field.value == null ? '' : ` value="${value(field.value)}"`;
        const checked = field.type === 'checkbox' && field.value === true ? ' checked' : '';
        input = `<input id="${id}" class="xp-input" dir="ltr" type="${field.type ?? 'text'}"${password}${storedValue}${checked} disabled>`;
    }
    return `<div class="xp-field"><label for="${id}">${label}</label>${input}</div>`;
};
const technicalTableColumns: Readonly<Record<string, readonly number[]>> = {
    'top-pages': [0, 1, 2],
    'error-paths': [0, 1],
};
const tableCell = (p: ApprovedXpanelWorkspaceProps, section: Section, row: readonly string[], index: number): string => {
    const raw = row[index];
    const technical = raw !== undefined && raw !== '' && raw !== unread[0] && raw !== unread[1]
        && technicalTableColumns[section.id]?.includes(index) === true;
    return technical
        ? `<td data-technical-value="true"><bdi dir="ltr" class="xp-mono xp-chart-technical-value xp-panel-detail__technical-cell">${value(raw)}</bdi></td>`
        : `<td>${value(raw)}</td>`;
};
const renderSection = (p: ApprovedXpanelWorkspaceProps, section: Section, aside = false): string => {
    const title = copy(p, section.title);
    const steps = section.steps ? `<ol class="xp-panel-detail__steps">${section.steps.map((step, index) => `<li><b>${index + 1}</b>${copy(p, step)}</li>`).join('')}</ol>` : '';
    const message = section.message ? `<p>${copy(p, section.message)}</p>` : '';
    const chart = section.chart ? `<div class="xp-panel-detail__plot" role="img" aria-label="${title}" data-chart-state="unread">${copy(p, msgid('No observed series is available.'))}</div>` : '';
    const fields = !section.fields?.length ? '' : aside ? facts(p, section.fields) : `<div class="xp-panel-detail__fields">${section.fields.map((field, index) => control(p, section.id, field, index)).join('')}</div>`;
    let table = '';
    if (section.columns) {
        const columns = section.columns;
        const rows = section.rows?.length ? section.rows.map(row => `<tr>${columns.map((_, index) => tableCell(p, section, row, index)).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">${copy(p, section.read ? msgid('No records were returned.') : msgid('These records have not been read.'))}</td></tr>`;
        table = `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${title}"><table class="xp-table" data-workspace-table="${section.id}"><thead><tr>${columns.map(column => `<th scope="col">${copy(p, column)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    const hook = (action: Copy): string => section.actionHooks?.[action] === undefined ? ' data-wiring="soon"' : ` data-file-selection-action="${escapeHtml(section.actionHooks[action])}"`;
    const actionHelp = section.actionHooks ? msgid('Copy, Move and Extract act on the one item selected in the file list; Compress takes every selected item. Extract needs a zip, tar, gz, bz2 or zst file.') : msgid('This control is unavailable until its service and permissions are confirmed. No change has been made.');
    const actions = section.actions ? `<div class="xp-panel-detail__actions">${section.actions.map((action, index) => `<button type="button" class="xp-btn${index === section.actions!.length - 1 ? ' xp-btn--primary' : ''}" disabled${hook(action)}>${copy(p, action)}</button>`).join('')}</div><p class="xp-help" role="status">${copy(p, actionHelp)}</p>` : '';
    return `<section class="xp-panel-detail__card" data-workspace-section="${section.id}" aria-labelledby="panel-detail-${section.id}"><h2 id="panel-detail-${section.id}">${title}</h2>${steps}${message}${chart}${table}${fields}${actions}</section>`;
};
const styles = `<style>.xp-approved-panel{display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}.xp-approved-panel h1,.xp-approved-panel h2,.xp-approved-panel p,.xp-approved-panel dl,.xp-approved-panel dd{margin:0}.xp-panel-detail__heading{display:flex;flex-direction:column;gap:8px}.xp-panel-detail__heading h1{font-size:26px;line-height:34px}.xp-panel-detail__layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:24px;align-items:start;min-inline-size:0}.xp-panel-detail__main,.xp-panel-detail__aside,.xp-panel-detail__native{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-panel-detail__card{display:flex;flex-direction:column;gap:24px;min-inline-size:0;padding:24px;border:1px solid var(--xp-border,#e2e6ec);border-radius:12px;background:var(--xp-bg-surface)}.xp-panel-detail__card h2{font-size:18px;line-height:28px}.xp-panel-detail__card p{line-height:1.6}.xp-panel-detail__facts,.xp-panel-detail__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px;min-inline-size:0}.xp-panel-detail__facts>div,.xp-approved-panel .xp-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-inline-size:0}.xp-panel-detail__facts dt{font-size:14px;color:var(--xp-text-muted,#5d6b7e)}.xp-panel-detail__facts dd{overflow-wrap:anywhere;text-align:start}.xp-panel-detail__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-approved-panel input,.xp-approved-panel select,.xp-approved-panel textarea{text-align:left;max-inline-size:100%;min-inline-size:0}.xp-approved-panel:lang(ar) :is(input,select,textarea){text-align:right}.xp-approved-panel bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-approved-panel .xp-table-wrap{min-inline-size:0;max-inline-size:100%;overflow:auto}.xp-approved-panel .xp-table{inline-size:100%}.xp-approved-panel .xp-table th,.xp-approved-panel .xp-table td{text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-panel-detail__steps{display:flex;flex-wrap:wrap;gap:16px;margin:0;padding:0;list-style:none}.xp-panel-detail__steps li{display:flex;align-items:center;gap:8px}.xp-panel-detail__steps b{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border,#e2e6ec);border-radius:50%}.xp-panel-detail__radio{display:flex;flex-direction:column;gap:16px;border:0;padding:0;margin:0;min-inline-size:0}.xp-panel-detail__radio legend{margin-block-end:8px;font-weight:600}.xp-panel-detail__radio .xp-check{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-panel-detail__plot{display:flex;align-items:center;justify-content:center;min-block-size:160px;padding:16px;border:1px dashed var(--xp-border,#e2e6ec);border-radius:8px;text-align:center}.xp-panel-detail__aside .xp-panel-detail__facts{grid-template-columns:minmax(0,1fr)}.xp-approved-panel .xp-panel-detail__technical-cell{direction:ltr;unicode-bidi:isolate;white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-board-dl{display:grid;gap:16px;min-inline-size:0}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact{flex-direction:column;align-items:stretch;gap:8px;padding:0;border:0}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact dd{min-inline-size:0;max-inline-size:100%;text-align:start;overflow-x:auto}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact dd bdi{white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] .xp-panel-detail__main{gap:32px}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] #xpanel-file-manager .xp-field>label{text-box-trim:trim-end;text-box-edge:text}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] [data-file-manager-table] td:nth-child(2){white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] #jailed-code-editor{direction:ltr;text-align:left;white-space:pre;tab-size:2;overflow:auto}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] [data-file-manager-table] td:last-child{white-space:nowrap}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] [data-file-manager-table] .xp-btn{white-space:nowrap;overflow-wrap:normal;word-break:normal;inline-size:max-content;min-inline-size:44px;max-inline-size:none;flex:none}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] .xp-file-location{display:inline-flex;direction:ltr;unicode-bidi:isolate;white-space:nowrap;gap:0;min-inline-size:0;max-inline-size:100%;overflow:auto}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] .xp-file-location>*{flex:none}@media(max-width:1100px){.xp-panel-detail__layout{grid-template-columns:minmax(0,1fr)}}@media(max-width:600px){.xp-panel-detail__card{padding:16px}}@media(max-width:800px){.xp-panel-detail__heading h1{line-height:36px}.xp-panel-detail__fields{grid-template-columns:minmax(0,1fr)}}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] #xpanel-file-manager>.xp-card__header,.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] #xpanel-file-manager [data-in-browser-editor]>.xp-card__header,.xp-approved-panel[data-approved-xpanel-workspace="/files/trash"] #xpanel-file-manager>.xp-card__header{margin-block-end:var(--xp-space-group)}.xp-approved-panel[data-approved-xpanel-workspace="/files/manager"] #xpanel-file-manager [data-chmod-policy-modal]{gap:var(--xp-space-group)}.xp-approved-panel:dir(rtl)[data-approved-xpanel-workspace="/files/directory-privacy"] [data-directory-privacy-prompt]{text-align:right}.xp-approved-panel:dir(rtl)[data-approved-xpanel-workspace="/files/manager"] #jailed-code-editor{text-align:right}.xp-approved-panel[data-approved-xpanel-workspace="/files/trash"] [data-file-manager-table] :is(td:first-child,td:nth-child(3),td:nth-child(4),td:nth-child(5),td:last-child){white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-approved-panel[data-approved-xpanel-workspace="/files/trash"] [data-file-manager-table] .xp-btn{white-space:nowrap;overflow-wrap:normal;word-break:normal;inline-size:max-content;min-inline-size:var(--xp-hit-target);max-inline-size:none;flex:none}.xp-approved-panel[data-approved-xpanel-workspace="/security/ssl"] [data-certificate-form]>h3{margin:0;font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}
.xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__layout {
  grid-template-columns: minmax(0, 1fr);
  gap: var(--xp-space-section);
}
.xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__main {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--xp-space-section);
  align-items: start;
}
.xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__native {
  grid-column: 1 / -1;
}
.xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__aside {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--xp-space-group);
  align-items: start;
}
.xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__card h2 {
  font-size: var(--xp-type-card);
  line-height: var(--xp-leading-card);
}
@media (min-width: 1101px) {
  .xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__main {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .xp-approved-panel[data-approved-xpanel-workspace="/email/accounts"] .xp-panel-detail__aside {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>`;
const renderClassicTrafficSelection = (p: ApprovedXpanelWorkspaceProps): { html: string; nativeAllowed: boolean } => {
    const domains = p.account ? (p.domains ?? []).filter(domain => domain.accountId === p.account!.id) : [];
    const selected = p.activeDomain !== undefined ? domains.find(domain => domain.name === p.activeDomain)
        : domains.find(domain => domain.name === p.account?.primaryDomain) ?? domains.find(domain => domain.kind === 'primary') ?? domains[0];
    const window = p.websiteAnalyticsWindow && WEBSITE_ANALYTICS_WINDOWS.includes(p.websiteAnalyticsWindow) ? p.websiteAnalyticsWindow : undefined;
    const labels = { '1h': msgid('Last hour'), '24h': msgid('Last 24 hours'), '7d': msgid('Last 7 days'), '30d': msgid('Last 30 days') };
    const enabled = !p.readOnly && p.websiteAnalyticsDomainSelectionAvailable === true && selected !== undefined;
    const contextHref = contextualizeNavigationHref(p.route, { locale: p.locale, theme: p.theme ?? 'dark', density: p.density ?? 'comfortable',
        ...(p.account && p.visibility?.principal.kind !== 'user' && p.visibility !== undefined ? { accountId: p.account.id } : {}),
    });
    const context = new URL(contextHref, 'http://xpanel.invalid').searchParams;
    const hiddenContext = [...context].map(([name, content]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(content)}">`).join('');
    const domainButtons = domains.map(domain => `<button type="submit" name="domain" value="${escapeHtml(domain.name)}" class="xp-btn${domain.name === selected?.name ? ' xp-btn--primary' : ''}" aria-pressed="${domain.name === selected?.name}"${enabled ? '' : ' disabled'}><bdi dir="ltr" class="xp-mono">${escapeHtml(domain.name)}</bdi></button>`).join('');
    const rangeButtons = WEBSITE_ANALYTICS_WINDOWS.map(value => `<button type="submit" name="window" value="${value}" class="xp-btn${value === window ? ' xp-btn--primary' : ''}" aria-pressed="${value === window}"${enabled ? '' : ' disabled'}>${copy(p, labels[value])}</button>`).join('');
    const fieldOpen = (labelledBy: string): string => p.readOnly
        ? `<div class="xp-field" aria-labelledby="${labelledBy}">`
        : `<form method="get" action="${escapeHtml(p.route)}" class="xp-field" aria-labelledby="${labelledBy}">`;
    const fieldClose = p.readOnly ? '</div>' : '</form>';
    const reading = selected && p.account ? parseWebsiteAnalyticsSnapshot(p.websiteAnalytics, { accountId: p.account.id, domain: selected.name }) : null;
    return {
        nativeAllowed: p.websiteAnalytics === undefined || reading !== null && p.websiteAnalyticsUnavailable !== true,
        html: `<section class="xp-panel-detail__card" data-workspace-section="metrics-scope" aria-labelledby="panel-detail-metrics-scope"><h2 id="panel-detail-metrics-scope">${copy(p, msgid('Traffic selection'))}</h2><div class="xp-panel-detail__fields">${fieldOpen('panel-traffic-domain-label')}${hiddenContext}${window ? `<input type="hidden" name="window" value="${window}">` : ''}<span id="panel-traffic-domain-label" class="xp-label">${copy(p, msgid('Domain'))}</span><div class="xp-panel-detail__actions" role="group" aria-labelledby="panel-traffic-domain-label">${domainButtons || `<span>${copy(p, unread)}</span>`}</div>${fieldClose}${fieldOpen('panel-traffic-range-label')}${hiddenContext}${selected ? `<input type="hidden" name="domain" value="${escapeHtml(selected.name)}">` : ''}<span id="panel-traffic-range-label" class="xp-label">${copy(p, msgid('Range'))}</span><div class="xp-panel-detail__actions" role="group" aria-labelledby="panel-traffic-range-label">${rangeButtons}</div>${fieldClose}</div></section>`,
    };
};
export const renderApprovedXpanelWorkspace = (p: ApprovedXpanelWorkspaceProps): string | undefined => {
    if (!approvedXpanelWorkspaceRoutes.has(p.route))
        return undefined;
    if (p.route === '/security/account')
        return renderClassicAccountSecurityWorkspace(p);
    if (p.route === '/domains/reverse-proxy') {
        const principal = p.visibility?.principal;
        const canManage = !p.readOnly && p.account?.status === 'active' && principal?.kind === 'user' && principal.accountId === p.account.id && p.catalog?.some(tool => tool.id === 'domains' && tool.status === 'verified') === true;
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="/domains/reverse-proxy" data-workspace-section="workspace" data-workspace-mode="${canManage ? 'connected' : 'read-only'}"${canManage ? '' : ' data-wiring="soon"'}><header class="xp-panel-detail__heading"><h1>${copy(p, msgid('Reverse proxy'))}</h1><p>${copy(p, msgid('Send a domain’s requests to an application, with WebSocket and header options.'))}</p></header>${renderAccountReverseProxyWorkspace({ lang: p.locale, accountId: canManage ? p.account!.id : '', home: canManage ? p.account!.home : '', canManage })}</section>`;
    }
    if (p.route === '/advanced/cron') {
        const page = pageFor(p), principal = p.visibility?.principal;
        const canManage = !p.readOnly && p.account?.status === 'active' && principal?.kind === 'user' && principal.accountId === p.account.id && p.catalog?.some(tool => tool.id === 'cron-jobs' && tool.status === 'verified') === true;
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="/advanced/cron" data-workspace-section="workspace" data-workspace-mode="${canManage ? 'connected' : 'read-only'}"${canManage ? '' : ' data-wiring="soon"'}><header class="xp-panel-detail__heading"><h1>${copy(p, page.title)}</h1><p>${copy(p, page.description)}</p></header>${renderAccountCronWorkspace({ lang: p.locale, expectedAccountId: p.account?.id ?? '', canManage })}</section>`;
    }
    const webDirective = ACCOUNT_WEB_DIRECTIVE_ROUTES[p.route];
    if (webDirective) {
        const principal = p.visibility?.principal, toolId = ({ 'error-pages': 'error-pages', indexes: 'indexes', 'mime-types': 'mime-types', handlers: 'apache-handlers', hotlink: 'hotlink-protection', 'ip-blocker': 'ip-blocker', redirects: 'redirects' } as const)[webDirective];
        const canManage = !p.readOnly && p.account?.status === 'active' && principal?.kind === 'user' && principal.accountId === p.account.id
            && ['aapanel-url-rewrite', toolId].every(id => p.catalog?.some(tool => tool.id === id && tool.status === 'verified') === true);
        const domains = p.readOnly ? [] : p.domains ?? [], selected = domains.find(domain => domain.accountId === p.account?.id && domain.name === p.activeDomain);
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="${p.route}" data-workspace-section="workspace" data-workspace-mode="${canManage ? 'connected' : 'read-only'}"${canManage ? '' : ' data-wiring="soon"'}>${renderAccountWebDirectivePage(webDirective, { locale: p.locale, accountId: p.readOnly ? '' : p.account?.id ?? '', domains, ...(selected ? { selectedDomainId: selected.id } : {}), canManage })}</section>`;
    }
    const ACCOUNT_TOOL_PAGES: Readonly<Record<string, readonly [Copy, Copy]>> = {
        '/software/packages': [msgid('Account packages'), msgid('Inspect reviewed account PHP libraries and their recovery state.')],
        '/databases/remote-access': [msgid('Remote database access'), msgid('Review the saved account host policy and native SQL and firewall availability.')],
        '/domains/staging': [msgid('Staging sites'), msgid('Copy a site to a private staging folder, review the changes and promote them to the live site.')],
        '/preferences/team': [msgid('Account team'), msgid('Record who works on this account and which tools their roles cover.')],
        '/databases/phpmyadmin': ['phpMyAdmin', msgid('Open phpMyAdmin for your own databases with a single-use sign-on.')],
        '/databases/postgresql': [msgid('PostgreSQL databases'), msgid('Create PostgreSQL databases and users for your account and manage their passwords and trash.')],
        '/databases/phppgadmin': ['phpPgAdmin', msgid('See whether the PostgreSQL web client can be opened for your account.')],
        '/software/apps': [msgid('Applications'), msgid('Install signed-catalog applications on your domains as verified jobs.')],
        '/software/containers': [msgid('Containers'), msgid('Containers that run under your own user, with their images and logs.')],
        '/software/cache': [msgid('Redis & Memcached'), msgid('A private Redis or Memcached for your account on a socket in your home, capped by your plan.')],
        '/software/optimize': [msgid('Optimize website'), msgid('See the compression and response cache that serve your sites.')],
        '/email/archive': [msgid('Email archive'), msgid('Keep copies of incoming and outgoing mail for your domains in a mailbox you choose.')],
        '/email/calendars-contacts': [msgid('Calendars and contacts'), msgid('Manage supported collections in your existing mailbox stores.')],
        '/advanced/api-shell': [msgid('API explorer'), msgid('Run supported API reads with your current account session.')],
        '/security/ssh': [msgid('SSH access'), msgid('Manage the public keys that can sign in to this account over SSH.')],
        '/metrics/logs': [msgid('Logs'), msgid('Read recent web access and error logs for your domains.')],
        '/health': [msgid('Site health'), msgid('Check DNS, website, certificate and PHP for every site you own.')],
        '/security/virus-scanner': [msgid('Virus scanner'), msgid('Scan the files in your home directory for malware with ClamAV.')],
        '/advanced/network-tools': [msgid('Network tools'), msgid('Look up DNS records, ping a host, trace the route or check a port from this server.')],
        '/databases/insights': [msgid('Database insights'), msgid('See the size, largest tables and server state of your own MariaDB databases and database users.')],
        '/domains/dynamic-dns': [msgid('Dynamic DNS'), msgid('Manage update credentials for DNS records in your own zones.')],
        '/domains/site-publisher': [msgid('Site publisher'), msgid('Preview a template and inspect publication and recovery availability for your domains.')],
        '/files/git': [msgid('Git version control'), msgid('Manage registered repositories within your account. Native operations require a qualified runner.')],
        '/email/encryption': [msgid('OpenPGP keys'), msgid('Manage your account keyring. Message encryption is unavailable.')],
        '/security/waf': [msgid('Web application firewall'), msgid('See the protection that applies to your sites and switch ModSecurity per domain.')],
        '/domains/cloudflare': [msgid('Cloudflare'), msgid('Inspect the Cloudflare zone of your connected domains and purge their cache.')],
    };
    const accountTool = ACCOUNT_TOOL_PAGES[p.route];
    if (accountTool) {
        const principal = p.visibility?.principal, accountId = p.readOnly ? '' : p.account?.id ?? '', domains = p.readOnly ? [] : p.domains ?? [];
        const owner = !p.readOnly && p.account?.status === 'active' && principal?.kind === 'user' && principal.accountId === p.account.id;
        const verified = (id: string): boolean => owner && p.catalog?.some(tool => tool.id === id && tool.status === 'verified') === true;
        const selected = domains.find(domain => domain.accountId === accountId && domain.name === p.activeDomain);
        const newTool = ({ '/domains/dynamic-dns': 'dynamic-dns', '/domains/site-publisher': 'site-publisher', '/files/git': 'git-version-control', '/email/encryption': 'email-encryption', '/software/packages': 'php-pear-packages', '/databases/remote-access': 'remote-database-access', '/email/calendars-contacts': 'calendars-contacts-management', '/email/archive': 'email-archive', '/domains/staging': 'site-staging', '/preferences/team': 'manage-team', '/databases/phpmyadmin': 'phpmyadmin', '/databases/postgresql': 'postgresql-databases', '/databases/phppgadmin': 'phppgadmin', '/software/apps': 'application-manager', '/software/containers': 'account-containers', '/software/cache': 'account-cache-services', '/software/optimize': 'optimize-website', '/advanced/api-shell': 'api-shell', '/security/waf': 'modsecurity', '/domains/cloudflare': 'cloudflare-account' } as Readonly<Record<string, string>>)[p.route];
        if (newTool) {
            const canManage = verified(newTool), body = p.route === '/domains/dynamic-dns' ? renderAccountDynamicDnsWorkspace({ lang: p.locale, accountId, canManage })
                : p.route === '/domains/site-publisher' ? renderAccountSitePublisherWorkspace({ lang: p.locale, accountId, domains: domains.filter(domain => domain.accountId === accountId), canManage })
                : p.route === '/files/git' ? renderAccountGitWorkspace({ lang: p.locale, accountId, canManage })
                : p.route === '/email/encryption' ? renderAccountPgpWorkspace({ lang: p.locale, accountId, username: p.readOnly ? '' : p.account?.username ?? '', canManage })
                : p.route === '/software/packages' ? renderAccountPackagesWorkspace({ lang: p.locale, accountId, canManage })
                : p.route === '/databases/remote-access' ? renderAccountDatabaseRemoteWorkspace({ lang: p.locale, accountId, username: p.readOnly ? '' : p.account?.username ?? '', canManage })
                : p.route === '/email/archive' ? renderMailxArchiveWorkspace({ locale: p.locale, canManage })
                : ['/databases/phpmyadmin', '/databases/postgresql', '/databases/phppgadmin'].includes(p.route) ? renderAccountDbEngineWorkspace({ page: p.route.slice(11) as AccountDbEnginePage, lang: p.locale, accountId, username: p.readOnly ? '' : p.account?.username ?? '', canManage })
                : p.route === '/software/apps' ? renderSwApplicationsWorkspace({ lang: p.locale, canManage })
                : p.route === '/software/containers' ? renderAccountContainersWorkspace({ lang: p.locale, canManage })
                : p.route === '/software/cache' ? renderAccountCacheWorkspace({ lang: p.locale, canManage })
                : p.route === '/software/optimize' ? renderSwOptimizeWorkspace({ lang: p.locale, canRead: canManage })
                : p.route === '/email/calendars-contacts' ? renderAccountCollaborationWorkspace({ locale: p.locale, canManage }) + renderMailxCollectionsWorkspace({ locale: p.locale, canManage })
                : p.route === '/domains/staging' ? renderAccountStagingWorkspace({ lang: p.locale, accountId, canManage })
                : p.route === '/preferences/team' ? renderAccountTeamWorkspace({ lang: p.locale, accountId, canManage })
                : p.route === '/security/waf' || p.route === '/domains/cloudflare' ? renderSecWorkspace({ page: p.route === '/security/waf' ? 'account-waf' : 'account-cloudflare', locale: p.locale, canRead: canManage, canManage })
                : renderWhmDeveloperWorkspace({ locale: p.locale, surface: 'account', canRead: canManage });
            return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="${p.route}" data-workspace-section="workspace" data-workspace-mode="${canManage ? 'connected' : 'read-only'}"${canManage ? '' : ' data-wiring="soon"'}><header class="xp-panel-detail__heading"><h1>${copy(p, accountTool[0])}</h1><p>${copy(p, accountTool[1])}</p></header>${body}</section>`;
        }
        const connected = p.route === '/security/ssh' ? verified('ssh-access') : p.route === '/metrics/logs' ? verified('visitors') || verified('errors') : p.route === '/security/virus-scanner' ? verified('virus-scanner') : p.route === '/advanced/network-tools' ? verified('track-dns') : p.route === '/databases/insights' ? verified('database-insights') : verified('account-health-overview');
        const body = p.route === '/security/ssh' ? renderAccountSshWorkspace({ lang: p.locale, accountId, username: p.readOnly ? '' : p.account?.username ?? '', canManage: verified('ssh-access') })
            : p.route === '/metrics/logs' ? renderAccountLogsWorkspace({ lang: p.locale, accountId, domains, ...(selected ? { selectedDomainId: selected.id } : {}), kinds: [...(verified('visitors') ? ['access' as const] : []), ...(verified('errors') ? ['error' as const] : [])] })
            : p.route === '/security/virus-scanner' ? renderAccountVirusScanWorkspace({ lang: p.locale, accountId, canManage: verified('virus-scanner') })
            : p.route === '/advanced/network-tools' ? renderAccountNetworkToolsWorkspace({ lang: p.locale, accountId, canManage: verified('track-dns') })
            : p.route === '/databases/insights' ? renderAccountDatabaseInsightsWorkspace({ lang: p.locale, accountId, canManage: verified('database-insights') })
            : renderSiteHealthWorkspace({ lang: p.locale, accountId, canManage: verified('account-health-overview') });
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="${p.route}" data-workspace-section="workspace" data-workspace-mode="${connected ? 'connected' : 'read-only'}"${connected ? '' : ' data-wiring="soon"'}><header class="xp-panel-detail__heading"><h1>${copy(p, accountTool[0])}</h1><p>${copy(p, accountTool[1])}</p></header>${body}</section>`;
    }
    p = p.readOnly ? {
        route: p.route, locale: p.locale, readOnly: true
    } : p;
    const page = pageFor(p);
    if (p.route === '/domains' && !p.readOnly && p.nativeHtml?.includes('data-domain-workspace')) {
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="/domains" data-workspace-mode="connected"><header class="xp-panel-detail__heading"><h1>${copy(p, page.title)}</h1><p>${copy(p, page.description)}</p></header>${p.nativeHtml}</section>`;
    }
    if (p.route === '/databases/mariadb' && !p.readOnly && p.nativeHtml?.includes('data-database-workspace')) {
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="/databases/mariadb" data-workspace-mode="connected"><header class="xp-panel-detail__heading"><h1>${copy(p, page.title)}</h1><p>${copy(p, page.description)}</p></header>${p.nativeHtml}</section>`;
    }
    const accountBackup = p.route === '/files/backup' && !p.readOnly && p.account
        && p.visibility?.principal.kind === 'user' && p.visibility.principal.accountId === p.account.id
        ? renderAccountBackupWorkspace({ lang: p.locale, accountId: p.account.id, username: p.account.username,
            canManage: p.account.status === 'active' && ['backup', 'backup-restoration'].every(id => p.catalog?.some(tool => tool.id === id && tool.status === 'verified') === true) })
        : undefined;
    if (p.route === '/software/htaccess' && !p.readOnly && p.account) {
        const canManage = p.account.status === 'active' && p.visibility?.principal.kind === 'user' && p.visibility.principal.accountId === p.account.id
            && p.catalog?.some(tool => tool.id === 'domain-htaccess' && tool.status === 'verified' && tool.delivery.status === 'verified' && isToolAuthorized(tool, p.visibility!)) === true;
        const selected = p.domains?.find(domain => domain.accountId === p.account!.id && domain.name === p.activeDomain);
        return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="/software/htaccess" data-workspace-mode="connected">${renderAccountHtaccessWorkspace({ locale: p.locale, accountId: p.account.id,
            domains: p.domains ?? [], ...(selected ? { selectedDomainId: selected.id } : {}), canManage })}</section>`;
    }
    const php = renderConnectedPanelPhp(p);
    const dns = renderConnectedPanelDns(p);
    const directoryPrivacy = renderConnectedPanelDirectoryPrivacy(p);
    const ssl = renderConnectedPanelSsl(p);
    const sessions = renderConnectedPanelSessions(p);
    const replacesNative = p.route === '/software/php' || p.route === '/files/backup' || dns !== undefined || directoryPrivacy !== undefined || ssl !== undefined;
    const trafficSelection = p.route === '/metrics/traffic' || p.route === '/metrics/web-stats' ? renderClassicTrafficSelection(p) : undefined;
    const nativeHtml = !p.readOnly && !replacesNative && trafficSelection?.nativeAllowed !== false ? p.nativeHtml : undefined;
    const sections = page.sections.filter(section => php === undefined || !['php-domain', 'php-pool', 'php-ini'].includes(section.id))
        .filter(section => dns === undefined || !['dns-add-record', 'dns-records-unread'].includes(section.id))
        .filter(section => directoryPrivacy === undefined || !['protected-folders', 'protect-folder'].includes(section.id))
        .filter(section => ssl === undefined || !['certificate-wizard', 'installed-certificates'].includes(section.id))
        .filter(section => trafficSelection === undefined || section.id !== 'metrics-scope');
    // The selection actions connect only behind the same catalog gate as the native file manager they act on.
    const fileSelection = p.route === '/files/manager' && nativeHtml?.includes('data-file-manager="browse"') === true && p.account?.status === 'active' && p.visibility !== undefined
        && p.catalog?.some(tool => tool.id === 'file-manager' && tool.status === 'verified' && tool.delivery.status === 'verified' && isToolAuthorized(tool, p.visibility!)) === true;
    const heading = nativeHtml ? '' : `<header class="xp-panel-detail__heading"><h1>${copy(p, page.title)}</h1><p>${copy(p, page.description)}</p></header>`;
    return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="${escapeHtml(p.route)}" data-workspace-mode="${p.readOnly ? 'read-only' : 'connected'}">${heading}<div class="xp-panel-detail__layout"><div class="xp-panel-detail__main">${trafficSelection?.html ?? ''}${nativeHtml ? `<div class="xp-panel-detail__native">${nativeHtml}</div>` : ''}${php ?? ''}${dns ?? ''}${directoryPrivacy ?? ''}${ssl ?? ''}${sessions ?? ''}${accountBackup ?? ''}${sections.map(section => renderSection(p, fileSelection && section.id === 'selection-actions' ? { ...section, actionHooks: { [msgid('Copy')]: 'copy', [msgid('Move')]: 'move', [msgid('Compress')]: 'compress', [msgid('Extract')]: 'extract' } } : section)).join('')}</div><aside class="xp-panel-detail__aside" aria-label="${copy(p, msgid('Workspace information'))}">${page.aside.map(section => renderSection(p, section, true)).join('')}</aside></div></section>`;
};
const pageFor = buildApprovedPanelPage;

// Independent personal authentication controls; native site operations retain their unavailable fences.
export const CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST = '<div data-classic-account-security-factor-host></div>';

const personalSecurityStyles = '<style id="classic-personal-security-styles">' + [
    '.xp-personal-security-page{display:flex;flex-direction:column;gap:32px;min-inline-size:0}',
    '.xp-personal-security-page .xp-personal-security-grid{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(0,1fr);gap:24px;align-items:start}',
    '.xp-personal-security-page .xp-personal-security-factor{min-inline-size:0}',
    '.xp-personal-security-page #classic-sign-in-title{margin:0 0 24px;font-size:18px;font-weight:600}',
    '.xp-personal-security-page [data-account-password] h3,.xp-personal-security-page [data-account-api-tokens] h3{font-size:16px;font-weight:600}',
    '.xp-personal-security-page .xp-personal-security-nav{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}',
    '.xp-personal-security-page .xp-personal-security-nav a{display:inline-flex;align-items:center;min-block-size:44px;padding:0 14px;border:1px solid var(--xp-border-strong,#D0D5DD);border-radius:999px;background:var(--xp-bg-surface,#FFFFFF);color:inherit;font-size:13px;font-weight:500;text-decoration:none}',
    '.xp-personal-security-page [hidden]{display:none!important}',
    ".xp-personal-security-page [data-account-api-tokens] :is([data-xp-slot=name],[data-xp-slot=scopes],[data-xp-slot=addresses],[data-xp-slot=created],[data-xp-slot=expires],[data-xp-slot=used]){font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}",
    '.xp-personal-security-page .xp-personal-security-form,.xp-personal-security-page .xp-personal-security-field{display:flex;flex-direction:column;min-inline-size:0}',
    '.xp-personal-security-page .xp-personal-security-form{gap:16px}',
    '.xp-personal-security-page .xp-personal-security-field{gap:8px}',
    '.xp-personal-security-page .xp-personal-security-row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end}',
    '.xp-personal-security-page .xp-personal-security-row>.xp-personal-security-field{flex:1 1 220px}',
    '.xp-personal-security-page .xp-personal-security-form label,.xp-personal-security-page .xp-personal-security-form legend{font-size:13px;font-weight:600}',
    '.xp-personal-security-page .xp-personal-security-form input:not([type="checkbox"]),.xp-personal-security-page .xp-personal-security-form select{inline-size:100%;min-inline-size:0;min-block-size:44px;padding:0 12px;border:1px solid var(--xp-border-strong,#D0D5DD);border-radius:8px;background:var(--xp-bg-surface,#FFFFFF);color:inherit;font:inherit}',
    '.xp-personal-security-page .xp-personal-security-check{display:flex;align-items:center;gap:8px;min-block-size:44px;font-size:13px}',
    '.xp-personal-security-page .xp-personal-security-check input{inline-size:18px;block-size:18px;flex:none}',
    '.xp-personal-security-page .xp-personal-security-actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}',
    '.xp-personal-security-page .xp-personal-security-help{margin:0;font-size:13px;line-height:1.6;color:var(--xp-text-secondary,#475467)}',
    '.xp-personal-security-page .xp-personal-security-rules{display:grid;gap:8px;margin:0;padding-inline-start:20px;font-size:12px;color:var(--xp-text-secondary,#475467)}',
    '.xp-personal-security-page .xp-personal-security-scopes{border:0;padding:0;margin:0;min-inline-size:0;display:grid;gap:16px}',
    '.xp-personal-security-page .xp-personal-security-scope-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:16px}',
    '.xp-personal-security-page .xp-personal-security-token-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px}',
    '.xp-personal-security-page .xp-personal-security-token-head>div{display:grid;gap:8px;min-inline-size:0}',
    '.xp-personal-security-page .xp-personal-security-token-table{overflow-x:auto;max-inline-size:100%;min-inline-size:0}',
    '.xp-personal-security-page .xp-personal-security-token-table table{min-inline-size:980px}',
    '.xp-personal-security-page .xp-personal-security-token-create{padding-block-start:24px;border-block-start:1px solid var(--xp-border,#E2E6EC)}',
    '.xp-personal-security-page .xp-personal-security-reveal{display:grid;gap:16px;padding:16px;border:1px solid var(--xp-border-strong,#D0D5DD);border-radius:10px;background:var(--xp-bg-elevated,#F8F9FB)}',
    '.xp-personal-security-page .xp-personal-security-secret{display:block;min-inline-size:0;overflow-wrap:anywhere;padding:12px;background:var(--xp-bg-surface,#FFFFFF);border:1px solid var(--xp-border,#E2E6EC);border-radius:8px}',
    ".xp-personal-security-page .xp-personal-security-mono{font-family:'IBM Plex Mono',monospace}",
    '.xp-personal-security-page .xp-personal-security-error{margin:0;font-size:12px;color:var(--xp-danger,#B42318)}',
    '.xp-personal-security-page [data-classic-native-security]{min-inline-size:0}',
    '.xp-personal-security-page [data-account-password],.xp-personal-security-page [data-account-api-tokens]{display:flex;flex-direction:column;gap:24px;padding:24px;min-inline-size:0}',
    '.xp-personal-security-page [data-account-password] h3,.xp-personal-security-page [data-account-api-tokens] h2,.xp-personal-security-page [data-account-api-tokens] h3{margin:0}',
    '@media(max-width:959px){.xp-personal-security-page .xp-personal-security-grid{grid-template-columns:minmax(0,1fr)}}',
    '@media(max-width:640px){.xp-personal-security-page [data-account-password],.xp-personal-security-page [data-account-api-tokens]{padding:16px}}',
].join('') + '</style>';

const personalState = (auth: AuthPersonalView | undefined): 'ready' | 'denied' | 'unavailable' =>
    auth?.state === 'ready' ? 'ready' : auth?.state === 'denied' ? 'denied' : 'unavailable';

const renderClassicApiTokens = (p: ApprovedXpanelWorkspaceProps): string => {
    const auth = p.authPersonal, state = personalState(auth), ready = state === 'ready';
    const canRead = ready && auth?.canReadApiTokens === true, canManage = ready && auth?.canManageApiTokens === true;
    const headers = [
        msgid('Name'), msgid('Scopes'), msgid('Allowed from'),
        msgctxt('approved-xpanel-pages', 'Created'), msgctxt('approved-xpanel-pages', 'Expires'),
        msgid('Last used'), msgid('Action'),
    ];
    const scopes = ['files', 'databases', 'dns', 'mail', 'backups', 'cron'].flatMap(resource =>
        ['read', 'write'].map(action => {
            const scope = resource + ':' + action, id = 'classic-token-scope-' + resource + '-' + action;
            return '<label class="xp-personal-security-check" for="' + id + '"><input id="' + id + '" type="checkbox" value="' + scope + '" data-account-tokens-scope disabled><bdi dir="ltr" class="xp-personal-security-mono">' + scope + '</bdi></label>';
        })).join('');
    return [
        '<section id="classic-api-tokens" class="xp-panel-detail__card" data-account-api-tokens data-auth-personal-state="' + state + '" data-tokens-can-read="' + canRead + '" data-tokens-can-manage="' + canManage + '" data-workspace-section="api-tokens" aria-labelledby="classic-api-tokens-title">',
        '<div class="xp-personal-security-token-head"><div><h2 id="classic-api-tokens-title">' + copy(p, msgid('API tokens')) + '</h2>',
        '<p class="xp-personal-security-help">' + copy(p, msgid('For scripts and CI. Tokens are scoped, always expire and are stored only as hashes.')) + '</p>',
        '<p class="xp-personal-security-help"><code class="xp-personal-security-mono" dir="ltr">Authorization: Bearer &lt;token&gt;</code></p></div>',
        '<span class="xp-badge" data-account-tokens-count>' + copy(p, unread) + '</span></div>',
        '<div class="xp-personal-security-actions"><button type="button" class="xp-btn" data-account-tokens-refresh disabled>' + copy(p, msgid('Refresh')) + '</button>',
        '<button type="button" class="xp-btn" data-account-tokens-bulk-revoke disabled>' + copy(p, msgid('Revoke selected')) + '</button>',
        '<span class="xp-personal-security-help">' + copy(p, msgid('Times in UTC')) + '</span></div>',
        '<p class="xp-personal-security-help" data-account-tokens-status role="status" aria-live="polite">' + copy(p, canRead ? unread : msgid('Unavailable')) + '</p>',
        '<p class="xp-personal-security-help" data-account-tokens-loading hidden>' + copy(p, msgid('Loading…')) + '</p>',
        '<p class="xp-personal-security-help" data-account-tokens-empty hidden>' + copy(p, msgid('No API tokens yet')) + '</p>',
        '<p class="xp-personal-security-help" data-account-tokens-mutation-status role="status" aria-live="polite" hidden></p>',
        '<div class="xp-personal-security-reveal" data-account-tokens-reveal hidden><p class="xp-personal-security-help" data-account-tokens-reveal-text></p>',
        '<code class="xp-personal-security-secret xp-personal-security-mono" dir="ltr" data-account-tokens-secret></code>',
        '<div class="xp-personal-security-actions"><button type="button" class="xp-btn" data-account-tokens-copy disabled>' + copy(p, msgid('Copy token')) + '</button>',
        '<button type="button" class="xp-btn" data-account-tokens-done disabled>' + copy(p, msgid('Done')) + '</button></div>',
        '<p class="xp-personal-security-help" data-account-tokens-copy-status role="status" aria-live="polite"></p></div>',
        '<div class="xp-personal-security-token-table xp-table-wrap" tabindex="0" role="region" aria-label="' + copy(p, msgid('API token list')) + '"><table class="xp-table" aria-labelledby="classic-api-tokens-title"><thead><tr>',
        '<th scope="col"><label class="xp-personal-security-check"><input type="checkbox" data-account-tokens-select-all disabled aria-label="' + copy(p, msgid('Select up to 50 tokens')) + '"><span>' + copy(p, headers[0]!) + '</span></label></th>',
        ...headers.slice(1).map(header => '<th scope="col">' + copy(p, header) + '</th>'),
        '</tr></thead><tbody data-account-tokens-rows></tbody></table></div>',
        '<form class="xp-personal-security-form xp-personal-security-token-create" method="post" action="/api/auth/api-tokens" data-account-tokens-create aria-labelledby="classic-token-create-title">',
        '<h3 id="classic-token-create-title">' + copy(p, msgid('Create a token')) + '</h3><div class="xp-personal-security-row">',
        '<div class="xp-personal-security-field"><label for="classic-token-name">' + copy(p, msgid('Name')) + '</label><input id="classic-token-name" name="name" type="text" required maxlength="50" autocomplete="off" spellcheck="false" dir="ltr" class="xp-personal-security-mono" data-account-tokens-name disabled aria-describedby="classic-token-name-help">',
        '<p id="classic-token-name-help" class="xp-personal-security-help">' + copy(p, msgid('Letters, digits, dashes and underscores.')) + '</p></div>',
        '<div class="xp-personal-security-field"><label for="classic-token-expiry">' + copy(p, msgid('Expires after')) + '</label><select id="classic-token-expiry" name="expiresInDays" data-account-tokens-expiry disabled aria-describedby="classic-token-expiry-help">',
        '<option value="30">' + copy(p, msgid('30 days')) + '</option><option value="90" selected>' + copy(p, msgid('90 days')) + '</option><option value="180">' + copy(p, msgid('180 days')) + '</option><option value="365">' + copy(p, msgid('1 year')) + '</option></select>',
        '<p id="classic-token-expiry-help" class="xp-personal-security-help">' + copy(p, msgid('Tokens always expire. The longest is one year.')) + '</p></div>',
        '<div class="xp-personal-security-field"><label for="classic-token-ips">' + copy(p, msgid('Allowed addresses (optional)')) + '</label><input id="classic-token-ips" name="allowedIps" type="text" autocomplete="off" spellcheck="false" dir="ltr" class="xp-personal-security-mono" data-account-tokens-allowed-ips disabled aria-describedby="classic-token-ips-help" placeholder="198.51.100.24, 2001:db8::/32">',
        '<p id="classic-token-ips-help" class="xp-personal-security-help">' + copy(p, msgid('IPv4 or IPv6 addresses or CIDR ranges, comma-separated. Empty allows any address.')) + '</p></div></div>',
        '<label class="xp-personal-security-check" for="classic-token-read-only"><input id="classic-token-read-only" type="checkbox" checked data-account-tokens-read-only disabled><span>' + copy(p, msgid('Read only')) + '</span></label>',
        '<fieldset class="xp-personal-security-scopes" aria-describedby="classic-token-scopes-help"><legend>' + copy(p, msgid('Scopes')) + '</legend>',
        '<p id="classic-token-scopes-help" class="xp-personal-security-help">' + copy(p, msgid('Only the selected actions are allowed.')) + '</p><div class="xp-personal-security-scope-grid">' + scopes + '</div></fieldset>',
        '<div class="xp-personal-security-actions"><button type="submit" class="xp-btn xp-btn--primary" data-account-tokens-submit disabled>' + copy(p, msgid('Create token')) + '</button>',
        '<button type="button" class="xp-btn" data-account-tokens-clear disabled>' + copy(p, msgid('Clear')) + '</button></div></form>',
        accountApiTokenClientTemplates({ buttonClass: 'xp-btn', badgeClass: 'xp-badge' }),
        '</section>',
    ].join('');
};

export const renderClassicAccountSecurityWorkspace = (p: ApprovedXpanelWorkspaceProps): string => {
    const page = buildApprovedPanelPage(p);
    const personalIds = new Set(['sign-in', 'account-password', 'api-tokens', 'token-one-time', 'token-list', 'token-revocation', 'token-scopes']);
    const nativeSections = page.sections.filter(section => !personalIds.has(section.id));
    const nativeCard = (html: string): string => '<div data-classic-native-security data-tool-availability="unverified" data-workspace-mode="read-only" aria-disabled="true">' + html + '</div>';
    return [
        styles, personalSecurityStyles,
        '<section class="xp-approved-panel xp-personal-security-page" data-approved-xpanel-workspace="/security/account" data-workspace-section="workspace" data-security-page="true" data-auth-personal-security data-surface="xpanel">',
        '<header class="xp-panel-detail__heading"><h1 class="xp-page-title">' + copy(p, page.title) + '</h1><p>' + copy(p, page.description) + '</p></header>',
        '<nav aria-label="' + copy(p, msgid('On this page')) + '"><ul class="xp-personal-security-nav">',
        ...[
            ['classic-two-factor', msgid('Two-factor sign-in')], ['classic-password', msgid('Password')], ['classic-api-tokens', msgid('API tokens')],
            ['panel-detail-ssh-access', msgid('SSH access')], ['panel-detail-ip-blocker', msgid('IP blocker')],
            ['panel-detail-hotlink-protection', msgid('Hotlink protection')], ['panel-detail-account-directory-privacy', msgctxt('approved-xpanel-pages', 'Directory privacy')],
        ].map(([id, label]) => '<li><a href="#' + id + '">' + copy(p, label!) + '</a></li>'),
        '</ul></nav>',
        '<section aria-labelledby="classic-sign-in-title"><h2 id="classic-sign-in-title">' + copy(p, msgid('Sign-in')) + '</h2><div class="xp-personal-security-grid"><div id="classic-two-factor" class="xp-personal-security-factor">' + CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST + '</div>',
        renderClassicPasswordCard(p), '</div></section>',
        renderConnectedPanelSessions(p) ?? '',
        renderClassicApiTokens(p),
        '<div class="xp-panel-detail__layout"><div class="xp-panel-detail__main">',
        ...nativeSections.map(section => nativeCard(renderSection(p, section))),
        '</div><aside class="xp-panel-detail__aside" aria-label="' + copy(p, msgid('Workspace information')) + '">',
        ...page.aside.map(section => nativeCard(renderSection(p, section, true))),
        '</aside></div>',
        '</section>',
    ].join('');
};

const renderClassicPasswordCard = (p: ApprovedXpanelWorkspaceProps): string => {
    const state = personalState(p.authPersonal);
    const canChange = state === 'ready' && p.authPersonal?.canChangePassword === true;
    const minimum = String(ACCOUNT_SELF_PASSWORD_MIN_LENGTH);
    const lengthRule = escapeHtml(translator(p.locale)(msgid('At least {minimum} characters'), { minimum }));
    const formState = canChange ? 'ready' : 'unavailable';
    return [
        '<section id="classic-password" class="xp-panel-detail__card" data-account-password data-auth-personal-state="' + state + '" data-account-password-can-change="' + canChange + '" data-account-password-state="' + formState + '" aria-busy="false" data-workspace-section="account-password" aria-labelledby="classic-password-title">',
        '<div class="xp-personal-security-token-head"><div><h3 id="classic-password-title">' + copy(p, msgid('Password')) + '</h3>',
        '<p class="xp-personal-security-help">' + copy(p, msgid('Your xPanel sign-in.')) + ' <a href="/email/accounts">' + copy(p, msgid('Mailbox and FTP passwords are set in Email & users.')) + '</a></p></div></div>',
        '<form class="xp-personal-security-form" method="post" action="/api/auth/change-password" data-account-password-form aria-labelledby="classic-password-title">',
        '<div class="xp-personal-security-field"><label for="classic-password-current">' + copy(p, msgid('Current password')) + '</label>',
        '<input id="classic-password-current" name="currentPassword" type="password" autocomplete="current-password" required disabled aria-describedby="classic-password-current-error">',
        '<p id="classic-password-current-error" class="xp-personal-security-error" data-account-password-current-error hidden></p></div>',
        '<div class="xp-personal-security-field"><label for="classic-password-new">' + copy(p, msgid('New password')) + '</label>',
        '<input id="classic-password-new" name="newPassword" type="password" autocomplete="new-password" required minlength="' + minimum + '" maxlength="1024" disabled aria-describedby="classic-password-rules classic-password-new-error">',
        '<ul id="classic-password-rules" class="xp-personal-security-rules"><li data-account-password-rule="length" data-state="unknown">' + lengthRule + '</li>',
        '<li>' + copy(p, msgid('Account name check')) + ' · ' + copy(p, msgid('Unavailable')) + '</li>',
        '<li>' + copy(p, msgid('Breach check')) + ' · ' + copy(p, msgid('Unavailable')) + '</li></ul>',
        '<p id="classic-password-new-error" class="xp-personal-security-error" data-account-password-new-error hidden></p></div>',
        '<div class="xp-personal-security-field"><label for="classic-password-confirm">' + copy(p, msgid('Repeat new password')) + '</label>',
        '<input id="classic-password-confirm" name="confirmPassword" type="password" autocomplete="new-password" required minlength="' + minimum + '" maxlength="1024" disabled aria-describedby="classic-password-confirm-error">',
        '<p id="classic-password-confirm-error" class="xp-personal-security-error" data-account-password-confirm-error hidden></p></div>',
        '<label class="xp-personal-security-check" for="classic-password-show"><input id="classic-password-show" type="checkbox" data-account-password-show disabled><span>' + copy(p, msgid('Show passwords')) + '</span></label>',
        '<p class="xp-personal-security-help">' + copy(p, msgid('Last changed')) + ': ' + copy(p, unread) + '. ' + copy(p, msgid('Sign in again after changing your password.')) + '</p>',
        '<div class="xp-personal-security-actions"><button type="submit" class="xp-btn xp-btn--primary" data-account-password-submit disabled>' + copy(p, msgid('Change password')) + '</button></div>',
        '<p class="xp-personal-security-help" data-account-password-status data-state="' + formState + '" role="status" aria-live="polite">' + copy(p, canChange ? msgid('Ready') : msgid('Unavailable')) + '</p>',
        '</form></section>',
    ].join('');
};
