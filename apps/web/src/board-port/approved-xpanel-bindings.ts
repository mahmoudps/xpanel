import type { ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts';
import { escapeHtml, normalizeAsciiDigits } from '../tokens.ts';
type Copy = readonly [
    string,
    string
];
const text = (p: ApprovedXpanelWorkspaceProps, x: Copy) => escapeHtml(x[p.locale === 'ar' ? 1 : 0]);
const value = (x: unknown) => escapeHtml(normalizeAsciiDigits(String(x ?? '')));
const control = (p: ApprovedXpanelWorkspaceProps, name: string, label: Copy, x: unknown, type = 'text', required = true) => `<div class="xp-field"><label for="panel-binding-${name.replaceAll('.', '-')}">${text(p, label)}</label><input class="xp-input" id="panel-binding-${name.replaceAll('.', '-')}" name="${name}" type="${type}" dir="ltr" value="${value(x)}"${type === 'number' ? ' min="0" step="1"' : ''}${required ? ' required' : ''}></div>`;
const choice = (p: ApprovedXpanelWorkspaceProps, name: string, label: Copy, x: string, items: readonly [
    string,
    Copy
][]) => `<div class="xp-field"><label for="panel-binding-${name.replaceAll('.', '-')}">${text(p, label)}</label><select class="xp-select" id="panel-binding-${name.replaceAll('.', '-')}" name="${name}" required>${items.map(([key, label]) => `<option value="${key}"${key === x ? ' selected' : ''}>${text(p, label)}</option>`).join('')}</select></div>`;
const available = (p: ApprovedXpanelWorkspaceProps, id: string) => !p.readOnly && p.account?.status === 'active' && p.visibility?.principal.kind === 'user' && p.visibility.principal.accountId === p.account.id && p.catalog?.some(t => t.id === id && t.status === 'verified') === true;
export const renderConnectedPanelPhp = (p: ApprovedXpanelWorkspaceProps): string | undefined => {
    if (p.route !== '/software/php' || !available(p, 'domain-php-settings'))
        return undefined;
    const domains = p.domains?.filter(d => d.accountId === p.account?.id) ?? [];
    const domain = domains.find(d => d.name === p.activeDomain || d.name === p.account?.primaryDomain) ?? domains[0];
    if (!domain)
        return undefined;
    const php = domain.php;
    return `<form class="xp-panel-detail__native" data-domain-php-form data-domain-id="${value(domain.id)}"><section class="xp-panel-detail__card" data-workspace-section="php-domain"><h2>${text(p, ['Domain and version', 'النطاق والإصدار'])}</h2><div class="xp-panel-detail__fields"><div class="xp-field"><label for="panel-binding-domain">${text(p, ['Domain', 'النطاق'])}</label><select id="panel-binding-domain" class="xp-select" name="domainId" data-domain-php-select>${domains.map(d => `<option value="${value(d.id)}"${d.id === domain.id ? ' selected' : ''}>${value(d.name)}</option>`).join('')}</select></div>${control(p, 'version', ['PHP version', 'إصدار PHP'], php.version)}${choice(p, 'handler', ['Handler', 'المعالج'], php.handler, [
        [
            'fpm', ['PHP-FPM', 'PHP-FPM']
        ], [
            'cgi', ['CGI', 'CGI']
        ], [
            'suphp', ['suPHP', 'suPHP']
        ], [
            'lsphp', ['lsphp', 'lsphp']
        ]
    ])}</div><p class="xp-help">${text(p, ['The server validates runtime availability and handler compatibility before saving.', 'يتحقق السيرفر من توفر بيئة التشغيل وتوافق المعالج قبل الحفظ.'])}</p></section><section class="xp-panel-detail__card" data-workspace-section="php-pool"><h2>${text(p, ['PHP-FPM pool', 'مجموعة PHP-FPM'])}</h2><div class="xp-panel-detail__fields">${choice(p, 'fpm.mode', ['Process manager', 'مدير العمليات'], php.fpm.mode, [
        [
            'ondemand', ['ondemand', 'ondemand']
        ], [
            'dynamic', ['dynamic', 'dynamic']
        ], [
            'static', ['static', 'static']
        ]
    ])}${control(p, 'fpm.maxChildren', ['pm.max_children', 'pm.max_children'], php.fpm.maxChildren, 'number')}${control(p, 'fpm.startServers', ['pm.start_servers', 'pm.start_servers'], php.fpm.startServers, 'number')}${control(p, 'fpm.minSpareServers', ['pm.min_spare_servers', 'pm.min_spare_servers'], php.fpm.minSpareServers, 'number')}${control(p, 'fpm.maxSpareServers', ['pm.max_spare_servers', 'pm.max_spare_servers'], php.fpm.maxSpareServers, 'number')}${control(p, 'fpm.maxRequests', ['pm.max_requests', 'pm.max_requests'], php.fpm.maxRequests, 'number')}${control(p, 'fpm.processIdleTimeoutSec', ['Idle timeout (seconds)', 'مهلة الخمول (ثوانٍ)'], php.fpm.processIdleTimeoutSec, 'number')}</div></section><section class="xp-panel-detail__card" data-workspace-section="php-ini"><h2>${text(p, ['INI values', 'قيم INI'])}</h2><div class="xp-panel-detail__fields">${control(p, 'ini.memory_limit', ['memory_limit', 'memory_limit'], php.ini.memory_limit ?? '', 'text', false)}${control(p, 'ini.upload_max_filesize', ['upload_max_filesize', 'upload_max_filesize'], php.ini.upload_max_filesize ?? '', 'text', false)}${control(p, 'ini.post_max_size', ['post_max_size', 'post_max_size'], php.ini.post_max_size ?? '', 'text', false)}${control(p, 'ini.max_execution_time', ['max_execution_time', 'max_execution_time'], php.ini.max_execution_time ?? '', 'text', false)}</div><p class="xp-help">${text(p, ['Leave an INI override blank to inherit the runtime default. Clearing a saved override removes it.', 'اترك قيمة INI فارغة لوراثة إعداد بيئة التشغيل الافتراضي. إفراغ القيمة المحفوظة يزيل التخصيص.'])}</p><p class="xp-help" role="status" data-domain-php-status hidden></p><div class="xp-panel-detail__actions"><button class="xp-btn" type="reset">${text(p, ['Reset', 'إعادة الضبط'])}</button><button class="xp-btn xp-btn--primary" type="submit">${text(p, ['Save PHP settings', 'حفظ إعدادات PHP'])}</button></div></section></form>`;
};
export const renderConnectedPanelDns = (p: ApprovedXpanelWorkspaceProps): string | undefined => {
    if (p.route !== '/domains/zone-editor' || !available(p, 'dns-zone-records'))
        return undefined;
    const domains = p.domains?.filter(d => d.accountId === p.account?.id) ?? [];
    return `<section class="xp-panel-detail__card" data-dns-editor data-workspace-section="dns-add-record"><h2>${text(p, ['Records and zone editor', 'السجلات ومحرر المنطقة'])}</h2><div class="xp-panel-detail__fields"><div class="xp-field"><label for="panel-dns-zone">${text(p, ['Zone', 'المنطقة'])}</label><select id="panel-dns-zone" class="xp-select" data-dns-zone>${domains.map(d => `<option value="${value(d.name)}">${value(d.name)}</option>`).join('')}</select></div><div class="xp-field"><label for="panel-dns-account">${text(p, ['Account', 'الحساب'])}</label><select id="panel-dns-account" class="xp-select" data-dns-account><option value="${value(p.account?.id)}">${value(p.account?.username)}</option></select></div><div class="xp-field"><label for="panel-dns-new-name">${text(p, ['New zone name', 'اسم المنطقة الجديدة'])}</label><input id="panel-dns-new-name" class="xp-input" data-dns-new-name dir="ltr"></div></div><div class="xp-table-wrap" tabindex="0" role="region" aria-label="${text(p, ['DNS records', 'سجلات DNS'])}"><table class="xp-table"><thead><tr><th scope="col">${text(p, ['Name', 'الاسم'])}</th><th scope="col">${text(p, ['Type', 'النوع'])}</th><th scope="col">TTL</th><th scope="col">${text(p, ['Content', 'المحتوى'])}</th><th scope="col">${text(p, ['Priority', 'الأولوية'])}</th><th scope="col">${text(p, ['Action', 'الإجراء'])}</th></tr></thead><tbody data-dns-records></tbody></table></div><p class="xp-help" data-dns-status role="status">${text(p, ['Reading zone records…', 'جار قراءة سجلات المنطقة…'])}</p><div class="xp-panel-detail__actions"><button type="button" class="xp-btn" data-dns-add-record>${text(p, ['Add record', 'إضافة سجل'])}</button><button type="button" class="xp-btn" data-dns-add-zone>${text(p, ['Add zone', 'إضافة منطقة'])}</button><button type="button" class="xp-btn xp-btn--primary" data-dns-save>${text(p, ['Save zone', 'حفظ المنطقة'])}</button><button type="button" class="xp-btn" data-dns-delete>${text(p, ['Delete zone', 'حذف المنطقة'])}</button></div></section>`;
};
