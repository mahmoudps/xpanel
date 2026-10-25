/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Account, Domain } from '@xpanel/core';
import { tools } from '@xpanel/catalog';
import { mergeWorkspacePhp } from '../approved-workspace-forms.ts';
import { renderApprovedXpanelWorkspace } from './approved-xpanel-workspaces.ts';
import { renderPanelSurface } from '../surfaces/xpanel.ts';
const account: Account = {
    id: 'followup-owner', username: 'owner', uid: 20042, gid: 20042, home: '/home/owner', primaryDomain: 'owner.example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', ipv6: null, shell: 'none', createdAt: '2026-10-25T00:00:00Z'
};
const domain: Domain = {
    id: 'followup-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/owner/public_html', siteType: 'php', upstream: null, redirect: null, php: {
        version: '8.3', handler: 'fpm', fpm: {
            mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10
        }, ini: {}
    }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null
};
const connected = (ini: Record<string, string> = {}) => renderApprovedXpanelWorkspace({
    route: '/software/php', locale: 'en', readOnly: false, account, domains: [
        {
            ...domain, php: {
                ...domain.php, ini
            }
        }
    ], visibility: {
        principal: {
            kind: 'user', id: 'principal', username: account.username, accountId: account.id
        }, disabledFeatures: new Set()
    }, catalog: tools.map(tool => tool.id === 'domain-php-settings' ? {
        ...tool, status: 'verified' as const
    } : tool)
})!;
afterEach(() => document.body.replaceChildren());
const expectUniqueIds = () => {
    const ids = [
        ...document.querySelectorAll('[id]')
    ].map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
};
describe('approved follow-up component and native validation boundaries', () => {
    it('allows a version-only save from the actual default ini={} template and preserves required runtime controls', () => {
        document.body.innerHTML = connected();
        const form = document.querySelector<HTMLFormElement>('form[data-domain-php-form]')!;
        expect(document.querySelectorAll('form')).toHaveLength(1);
        expectUniqueIds();
        for (const name of ['ini.memory_limit', 'ini.upload_max_filesize', 'ini.post_max_size', 'ini.max_execution_time']) {
            const input = form.elements.namedItem(name) as HTMLInputElement;
            expect(input.value).toBe('');
            expect(input.required).toBe(false);
        }
        (form.elements.namedItem('version') as HTMLInputElement).value = '8.4';
        expect(form.checkValidity()).toBe(true);
        expect(form.reportValidity()).toBe(true);
        const version = form.elements.namedItem('version') as HTMLInputElement;
        version.value = '';
        expect(form.checkValidity()).toBe(false);
        version.value = '8.4';
        for (const name of ['version', 'handler', 'fpm.mode', 'fpm.maxChildren', 'fpm.startServers', 'fpm.minSpareServers', 'fpm.maxSpareServers', 'fpm.maxRequests', 'fpm.processIdleTimeoutSec'])
            expect((form.elements.namedItem(name) as HTMLInputElement).required).toBe(true);
    });
    it('allows an existing override to be cleared in the actual template and merges its removal without losing other INI values', () => {
        const ini = {
            memory_limit: '256M', custom_unexposed: 'preserve'
        };
        document.body.innerHTML = connected(ini);
        const form = document.querySelector<HTMLFormElement>('form[data-domain-php-form]')!;
        (form.elements.namedItem('ini.memory_limit') as HTMLInputElement).value = '';
        expect(form.reportValidity()).toBe(true);
        const values: Record<string, string> = {};
        for (const [key, value] of new FormData(form).entries())
            if (typeof value === 'string')
                values[key] = value;
        const merged = mergeWorkspacePhp({
            ...domain.php, ini
        }, values);
        expect(merged.ini).toEqual({
            custom_unexposed: 'preserve'
        });
        expect(ini.memory_limit).toBe('256M');
    });
    it('retains the full backup workflow structure without submitting or inventing archive or difference data', () => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route: '/files/backup', locale: 'en', readOnly: true
        })!;
        for (const id of ['backup-include', 'backup-databases', 'backup-destination', 'backup-summary', 'backup-progress', 'backup-restore', 'backup-diff-summary', 'backup-diff', 'backup-db-diff', 'backup-mail-diff', 'backup-mail-config-diff', 'backup-restore-review', 'backup-history', 'backup-safety', 'backup-location'])
            expect(document.querySelector(`[data-workspace-section="${id}"]`), id).not.toBeNull();
        expect(document.body.textContent).toContain('Missing from archive');
        expect(document.body.textContent).toContain('I reviewed the proposed restore changes');
        expect(document.querySelectorAll('h1')).toHaveLength(1);
        expect(document.querySelector('form')).toBeNull();
        expect(document.querySelector('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')).toBeNull();
        expect(document.body.textContent).not.toMatch(/alice|backup\.example|Restore finished|1\.9 GB/);
        expectUniqueIds();
    });
    it.each([
        [
            '/files/manager', ['file-list-unread', 'file-editor-unread', 'file-rename-unread', 'file-delete-unread']
        ],
        [
            '/email/accounts', ['mailbox-users-unread', 'mailbox-create-unread', 'mailbox-password-unread', 'mailbox-quota-unread']
        ],
        [
            '/domains', ['domain-list-unread', 'domain-create-unread', 'domain-rename-primary']
        ],
        [
            '/databases/mariadb', ['database-list-unread', 'database-create-unread', 'database-user-list-unread', 'database-user-create-unread']
        ],
        [
            '/domains/zone-editor', ['dns-records-unread', 'dns-add-record']
        ]
    ] as const)('preserves unavailable %s anatomy and suppresses private native data', (route, ids) => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route, locale: 'en', readOnly: true, account: {
                ...account, username: 'private-marker'
            }, nativeHtml: '<form>private-native-marker</form>'
        })!;
        for (const id of ids)
            expect(document.querySelector(`[data-workspace-section="${id}"]`), id).not.toBeNull();
        expect(document.body.textContent).toContain('not been read');
        expect(document.body.textContent).not.toMatch(/private-marker|private-native-marker/);
        expect(document.querySelector('form,[data-mailbox-form],[data-domain-form],[data-dns-editor]')).toBeNull();
        expect(document.querySelector('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')).toBeNull();
        expectUniqueIds();
    });
    it.each([
        [
            '/software/php', ['php-extra-ini', 'php-save-target', 'php-config-preview']
        ],
        [
            '/software/htaccess', ['htaccess-editor', 'htaccess-php-compatibility', 'htaccess-versions']
        ],
        [
            '/advanced/cron', ['cron-selected-job', 'cron-unit-preview', 'cron-next-runs']
        ]
    ] as const)('keeps approved %s extras unavailable without changing live form contracts', (route, ids) => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route, locale: 'ar', readOnly: true
        })!;
        for (const id of ids)
            expect(document.querySelector(`[data-workspace-section="${id}"]`), id).not.toBeNull();
        expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/);
        expectUniqueIds();
    });
    it('preserves qualified native domain creation plus disabled additional variants without a second form', () => {
        document.body.innerHTML = renderPanelSurface({
            locale: 'en', account, domains: [
                domain
            ], activeRoute: '/domains', visibility: {
                principal: {
                    kind: 'user', id: 'principal', username: account.username, accountId: account.id
                }, disabledFeatures: new Set()
            }, catalog: tools.map(tool => ['domains', 'create-domain'].includes(tool.id) ? {
                ...tool, status: 'verified' as const
            } : tool)
        });
        const native = document.querySelector<HTMLFormElement>('form[data-domain-form]')!;
        expect(native).not.toBeNull();
        expect(native.querySelector('button[type="submit"]:not([disabled])')).not.toBeNull();
        expect(document.querySelectorAll('form[data-domain-form]')).toHaveLength(1);
        const extra = document.querySelector('[data-workspace-section="domain-create-details"]')!;
        for (const label of ['Alias name', 'Subdomain', 'Under', 'Document root', 'PHP version', 'Site type', 'Create DNS records', 'Issue a TLS certificate'])
            expect(extra.textContent).toContain(label);
        expect(extra.querySelector('form,input:not([disabled]),select:not([disabled])')).toBeNull();
        expect(document.querySelector('[data-workspace-section="domain-create-unread"]')).toBeNull();
        expect(document.querySelectorAll('h1')).toHaveLength(1);
        expectUniqueIds();
    });
    it('retains native database actions and full unread detail columns with scoped database names', () => {
        const databases = [
            {
                id: 'db', accountId: account.id, engine: 'mariadb' as const, name: 'owner_app', trashedAt: null
            }
        ];
        document.body.innerHTML = renderPanelSurface({
            locale: 'en', account, domains: [
                domain
            ], databases, activeRoute: '/databases/mariadb', visibility: {
                principal: {
                    kind: 'user', id: 'principal', username: account.username, accountId: account.id
                }, disabledFeatures: new Set()
            }, catalog: tools.map(tool => ['mysql-databases', 'mysql-users'].includes(tool.id) ? {
                ...tool, status: 'verified' as const
            } : tool)
        });
        const native = document.querySelector<HTMLFormElement>('form[data-database-form]')!;
        expect(native).not.toBeNull();
        expect(native.querySelector('button[type="submit"]:not([disabled])')).not.toBeNull();
        const extra = document.querySelector('[data-workspace-table="database-list-details"]')!;
        for (const label of ['Database', 'Size', 'Tables', 'Users with access', 'Collation', 'Last write', 'owner_app', 'Not read'])
            expect(extra.textContent).toContain(label);
        expect(document.querySelector('[data-workspace-section="database-list-details"] form')).toBeNull();
        expect(document.querySelector('[data-workspace-section="database-list-unread"]')).toBeNull();
        expectUniqueIds();
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route: '/databases/mariadb', locale: 'en', readOnly: false, account, databases: [
                {
                    ...databases[0]!, accountId: 'foreign', name: 'foreign_private'
                }
            ], nativeHtml: '<h1>Native databases</h1>'
        })!;
        expect(document.querySelector('[data-workspace-table="database-list-details"]')?.textContent).not.toContain('foreign_private');
    });
    it('retains resource limit rows, applied-state columns and complete process headers without guessed values', () => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route: '/resources', locale: 'en', readOnly: true
        })!;
        const limit = document.querySelector('[data-workspace-table="resource-limits"]')!;
        for (const label of ['Plan value', 'Applied on host', 'State', 'Live usage', 'CPU weight', 'CPU quota', 'Memory', 'Processes', 'IO read', 'IO write', 'Bandwidth'])
            expect(limit.textContent).toContain(label);
        expect(limit.textContent).not.toMatch(/20014|50 MB|20 MB/);
        const process = document.querySelector('[data-workspace-table="slice-processes"]')!;
        for (const label of ['PID', 'Command and unit', 'User', 'CPU', 'Memory', 'Started'])
            expect(process.textContent).toContain(label);
    });
    it('preserves the exact approved token scope identities and visible site-protection input groups', () => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route: '/security/account', locale: 'ar', readOnly: true
        })!;
        const scopes = [
            ...document.querySelectorAll('[data-workspace-section="token-scopes"] label bdi')
        ].map(node => node.textContent);
        expect(scopes).toEqual(['files:read', 'files:write', 'databases:read', 'dns:write', 'email:write', 'backups:create', 'cron:write']);
        for (const section of ['account-password', 'ip-blocker', 'hotlink-protection']) {
            const group = document.querySelector(`[data-workspace-section="${section}"]`)!;
            expect(group.querySelector('input[disabled]')).not.toBeNull();
            expect(group.querySelector('button[disabled]')).not.toBeNull();
        }
        expect(document.querySelector('[data-workspace-section="token-one-time"]')?.textContent).toContain('تم');
    });
    it('keeps missing certificate targets explicitly unread and preserves picker, cancel and final-install anatomy', () => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route: '/security/ssl', locale: 'en', readOnly: true
        })!;
        const targets = document.querySelector('[data-workspace-section="certificate-targets"]')!;
        expect(targets.querySelector('select[disabled]')).not.toBeNull();
        expect(targets.textContent).toContain('Installation targets not read');
        const wizard = document.querySelector('[data-workspace-section="certificate-wizard"]')!;
        for (const label of ['Existing certificate', 'Cancel', 'Install or issue certificate'])
            expect(wizard.textContent).toContain(label);
        expect(wizard.querySelector('button:not([disabled])')).toBeNull();
    });
    it.each([
        [
            '/domains/site-settings', ['Site', 'Server', 'Forward every request to', 'Unlimited path quota', 'Log kind', 'Log preview']
        ],
        [
            '/domains', ['Alias name', 'Subdomain', 'Under', 'PHP version', 'Create DNS records', 'Issue a TLS certificate', 'Keep old domain as an alias', 'Type current primary domain to confirm', 'What changes', 'What stays']
        ],
        [
            '/databases/mariadb', ['Rename database', 'Comment (optional)', 'Allowed database hosts', 'Generate password', 'Database name to confirm', 'Collation', 'Last write']
        ],
        [
            '/email/accounts', ['Delete forwarder', 'Edit autoresponder', 'Delete autoresponder', 'Cancel', 'Create user']
        ],
        [
            '/domains/zone-editor', ['Record type filter', 'Fix', 'Zone records']
        ]
    ] as const)('retains the final approved controls for unavailable %s', (route, labels) => {
        document.body.innerHTML = renderApprovedXpanelWorkspace({
            route, locale: 'en', readOnly: true
        })!;
        for (const label of labels)
            expect(document.body.textContent, label).toContain(label);
        expect(document.querySelector('form,button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')).toBeNull();
        expectUniqueIds();
    });
    it('isolates authorized domain names and protocol/SQL values while keeping Arabic interface labels translated', () => {
        const render = (route: string) => renderApprovedXpanelWorkspace({
            route, locale: 'ar', readOnly: false, account, domains: [
                domain
            ]
        })!;
        document.body.innerHTML = render('/security/ssl');
        const target = document.querySelector('[data-workspace-section="certificate-targets"] label bdi');
        expect(target?.textContent).toBe(domain.name);
        expect(target?.getAttribute('dir')).toBe('ltr');
        expect(document.querySelector('[data-workspace-section="certificate-wizard"] .xp-panel-detail__radio label bdi')?.textContent).toBe('HTTP-01');
        document.body.innerHTML = render('/databases/mariadb');
        expect(document.querySelector('[data-workspace-section="database-grants-review"] label bdi')?.textContent).toBe('SELECT');
        document.body.innerHTML = render('/email/accounts');
        expect(document.body.textContent).toContain('قرص الويب');
        expect(document.body.textContent).not.toContain('Web Disk');
    });
});
