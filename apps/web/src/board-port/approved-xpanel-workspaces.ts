import type { PanelSurfaceProps } from '../surfaces/xpanel.ts';
import type { Locale } from '../i18n.ts';
import { escapeHtml, normalizeAsciiDigits } from '../tokens.ts';
import { buildApprovedPanelPage } from './approved-xpanel-pages.ts';
import { renderConnectedPanelPhp, renderConnectedPanelDns } from './approved-xpanel-bindings.ts';
type Copy = readonly [
    string,
    string
];
export interface ApprovedXpanelWorkspaceProps extends Omit<PanelSurfaceProps, 'locale'> {
    route: string;
    locale: Locale;
    readOnly: boolean;
    nativeHtml?: string;
}
export const approvedXpanelWorkspaceRoutes: ReadonlySet<string> = new Set(['/resources', '/email/accounts', '/files/manager', '/files/trash', '/files/directory-privacy', '/domains/site-settings', '/files/backup', '/databases/mariadb', '/domains', '/domains/zone-editor', '/metrics/traffic', '/security/ssl', '/security/account', '/software/php', '/software/htaccess', '/advanced/cron']);
const copy = (p: ApprovedXpanelWorkspaceProps, x: Copy): string => escapeHtml(x[p.locale === 'ar' ? 1 : 0]);
const value = (x: unknown): string => escapeHtml(normalizeAsciiDigits(x == null ? '' : String(x)));
const unread: Copy = ['Not read', 'لم تُقرأ البيانات'];
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
    const choiceCopy = (choice: Copy) => field.technicalChoices && choice[0] === choice[1] ? `<bdi dir="ltr">${copy(p, choice)}</bdi>` : copy(p, choice);
    if (field.type === 'radio' && field.choices) {
        return `<fieldset class="xp-panel-detail__radio" disabled><legend>${label}</legend>${field.choices.map((choice, choiceIndex) => `<label class="xp-check" for="${id}-${choiceIndex}"><input id="${id}-${choiceIndex}" name="${id}" type="radio" value="${value(choice[0])}" disabled><span>${choiceCopy(choice)}</span></label>`).join('')}</fieldset>`;
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
    const chart = section.chart ? `<div class="xp-panel-detail__plot" role="img" aria-label="${title}" data-chart-state="unread">${copy(p, ['No observed series is available.', 'لا تتوفر سلسلة قراءات مرصودة.'])}</div>` : '';
    const fields = !section.fields ? '' : aside ? facts(p, section.fields) : `<div class="xp-panel-detail__fields">${section.fields.map((field, index) => control(p, section.id, field, index)).join('')}</div>`;
    let table = '';
    if (section.columns) {
        const columns = section.columns;
        const rows = section.rows?.length ? section.rows.map(row => `<tr>${columns.map((_, index) => tableCell(p, section, row, index)).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">${copy(p, section.read ? ['No records were returned.', 'لم تُرجع القراءة أي سجلات.'] : ['These records have not been read.', 'لم تُقرأ هذه السجلات.'])}</td></tr>`;
        table = `<div class="xp-table-wrap" tabindex="0" role="region" aria-label="${title}"><table class="xp-table" data-workspace-table="${section.id}"><thead><tr>${columns.map(column => `<th scope="col">${copy(p, column)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
    const actions = section.actions ? `<div class="xp-panel-detail__actions">${section.actions.map((action, index) => `<button type="button" class="xp-btn${index === section.actions!.length - 1 ? ' xp-btn--primary' : ''}" disabled data-wiring="soon">${copy(p, action)}</button>`).join('')}</div><p class="xp-help" role="status">${copy(p, ['This control is unavailable until its service and permissions are confirmed. No change has been made.', 'هذا العنصر غير متاح حتى تُؤكد خدمته وصلاحياته. لم يُجرَ أي تغيير.'])}</p>` : '';
    return `<section class="xp-panel-detail__card" data-workspace-section="${section.id}" aria-labelledby="panel-detail-${section.id}"><h2 id="panel-detail-${section.id}">${title}</h2>${steps}${message}${chart}${table}${fields}${actions}</section>`;
};
const styles = `<style>.xp-approved-panel{display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}.xp-approved-panel h1,.xp-approved-panel h2,.xp-approved-panel p,.xp-approved-panel dl,.xp-approved-panel dd{margin:0}.xp-panel-detail__heading{display:flex;flex-direction:column;gap:8px}.xp-panel-detail__heading h1{font-size:26px;line-height:34px}.xp-panel-detail__layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:24px;align-items:start;min-inline-size:0}.xp-panel-detail__main,.xp-panel-detail__aside,.xp-panel-detail__native{display:flex;flex-direction:column;gap:24px;min-inline-size:0}.xp-panel-detail__card{display:flex;flex-direction:column;gap:24px;min-inline-size:0;padding:24px;border:1px solid var(--xp-border,#e2e6ec);border-radius:12px;background:var(--xp-bg-surface)}.xp-panel-detail__card h2{font-size:18px;line-height:28px}.xp-panel-detail__card p{line-height:1.6}.xp-panel-detail__facts,.xp-panel-detail__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px;min-inline-size:0}.xp-panel-detail__facts>div,.xp-approved-panel .xp-field{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-inline-size:0}.xp-panel-detail__facts dt{font-size:14px;color:var(--xp-text-muted,#5d6b7e)}.xp-panel-detail__facts dd{overflow-wrap:anywhere;text-align:start}.xp-panel-detail__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-approved-panel input,.xp-approved-panel select,.xp-approved-panel textarea{text-align:match-parent;max-inline-size:100%;min-inline-size:0}.xp-approved-panel bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-approved-panel .xp-table-wrap{min-inline-size:0;max-inline-size:100%;overflow:auto}.xp-approved-panel .xp-table{inline-size:100%}.xp-approved-panel .xp-table th,.xp-approved-panel .xp-table td{text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-panel-detail__steps{display:flex;flex-wrap:wrap;gap:16px;margin:0;padding:0;list-style:none}.xp-panel-detail__steps li{display:flex;align-items:center;gap:8px}.xp-panel-detail__steps b{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border,#e2e6ec);border-radius:50%}.xp-panel-detail__radio{display:flex;flex-direction:column;gap:16px;border:0;padding:0;margin:0;min-inline-size:0}.xp-panel-detail__radio legend{margin-block-end:8px;font-weight:600}.xp-panel-detail__radio .xp-check{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-panel-detail__plot{display:flex;align-items:center;justify-content:center;min-block-size:160px;padding:16px;border:1px dashed var(--xp-border,#e2e6ec);border-radius:8px;text-align:center}.xp-panel-detail__aside .xp-panel-detail__facts{grid-template-columns:minmax(0,1fr)}.xp-approved-panel .xp-panel-detail__technical-cell{direction:ltr;unicode-bidi:isolate;white-space:nowrap;overflow-wrap:normal;word-break:normal}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-board-dl{display:grid;gap:16px;min-inline-size:0}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact{flex-direction:column;align-items:stretch;gap:8px;padding:0;border:0}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact dd{min-inline-size:0;max-inline-size:100%;text-align:start;overflow-x:auto}.xp-approved-panel[data-approved-xpanel-workspace="/resources"] [data-section="slice-resources"] .xp-fact dd bdi{white-space:nowrap;overflow-wrap:normal;word-break:normal}@media(max-width:1100px){.xp-panel-detail__layout{grid-template-columns:minmax(0,1fr)}}@media(max-width:800px){.xp-panel-detail__card{padding:16px}.xp-panel-detail__heading h1{line-height:36px}.xp-panel-detail__fields{grid-template-columns:minmax(0,1fr)}}</style>`;
export const renderApprovedXpanelWorkspace = (p: ApprovedXpanelWorkspaceProps): string | undefined => {
    if (!approvedXpanelWorkspaceRoutes.has(p.route))
        return undefined;
    p = p.readOnly ? {
        route: p.route, locale: p.locale, readOnly: true
    } : p;
    const page = pageFor(p);
    const php = renderConnectedPanelPhp(p);
    const dns = renderConnectedPanelDns(p);
    const replacesNative = p.route === '/software/php' || dns !== undefined;
    const nativeHtml = !p.readOnly && !replacesNative ? p.nativeHtml : undefined;
    const sections = page.sections.filter(section => php === undefined || !['php-domain', 'php-pool', 'php-ini'].includes(section.id))
        .filter(section => dns === undefined || !['dns-add-record', 'dns-records-unread'].includes(section.id));
    const heading = nativeHtml ? '' : `<header class="xp-panel-detail__heading"><h1>${copy(p, page.title)}</h1><p>${copy(p, page.description)}</p></header>`;
    return `${styles}<section class="xp-approved-panel" data-approved-xpanel-workspace="${escapeHtml(p.route)}" data-workspace-mode="${p.readOnly ? 'read-only' : 'connected'}">${heading}<div class="xp-panel-detail__layout"><div class="xp-panel-detail__main">${nativeHtml ? `<div class="xp-panel-detail__native">${nativeHtml}</div>` : ''}${php ?? ''}${dns ?? ''}${sections.map(section => renderSection(p, section)).join('')}</div><aside class="xp-panel-detail__aside" aria-label="${copy(p, ['Workspace information', 'معلومات مساحة العمل'])}">${page.aside.map(section => renderSection(p, section, true)).join('')}</aside></div></section>`;
};
const pageFor = buildApprovedPanelPage;
