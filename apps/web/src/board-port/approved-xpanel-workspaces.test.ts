// @vitest-environment jsdom
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { defaultPlan } from '@xpanel/core';
import type { Account, Domain } from '@xpanel/core';
import { tools } from '@xpanel/catalog';
import { approvedXpanelWorkspaceRoutes, renderApprovedXpanelWorkspace } from './approved-xpanel-workspaces.ts';
import { groupViews, mono, xpanelHomeFromProps } from './xpanel-home.ts';
import { renderEmailAccountsExtension } from './extensions/email-accounts.ts';
import { renderPanelSurface } from '../surfaces/xpanel.ts';
const account: Account = {
    id: 'workspace-account', username: 'owner', uid: 20042, gid: 20042, home: '/home/owner', primaryDomain: 'owner.example.test', planId: 'workspace-plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', ipv6: null, shell: 'none', createdAt: '2026-10-25T00:00:00Z'
};
const domain: Domain = {
    id: 'workspace-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/owner/public_html', siteType: 'php', upstream: null, redirect: null, php: {
        version: '8.3', handler: 'fpm', fpm: {
            mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10
        }, ini: {
            memory_limit: '256M', custom_setting: 'preserved'
        }
    }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null
};
const qualify = (...ids: string[]) => tools.map(tool => ids.includes(tool.id) ? {
    ...tool, status: 'verified' as const
} : tool);
const owner = {
    principal: {
        kind: 'user' as const, id: 'principal', username: account.username, accountId: account.id
    }, disabledFeatures: new Set<string>()
};
describe('account workspace structures and native binding boundaries', () => {
    it('connects the guarded domain workspace once inside its existing surface heading', () => {
        const html = renderPanelSurface({ activeRoute: '/domains', locale: 'en', account, visibility: owner, catalog: qualify('domains') });
        assert.match(html, /data-domain-workspace/);
        assert.match(html, /data-domain-account="workspace-account"/);
        assert.match(html, /data-domain-primary-rename/);
        assert.doesNotMatch(html, /data-domain-form="true"|data-remove-domain=/);
        assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    });
    it('retains all approved workspace sections without forms or private state in unqualified documents', () => {
        for (const route of approvedXpanelWorkspaceRoutes) {
            const html = renderApprovedXpanelWorkspace({
                route, locale: 'en', readOnly: true
            })!;
            assert.match(html, /data-approved-xpanel-workspace=/);
            assert.match(html, /data-workspace-section=/);
            assert.doesNotMatch(html, /data-domain-php-form|data-dns-editor/);
            const document = new DOMParser().parseFromString(html, 'text/html');
            const forms = [...document.querySelectorAll<HTMLFormElement>('form')];
            if (route !== '/security/account') {
                assert.equal(forms.length, 0, route);
            } else {
                // Keep complete personal components closed without granting self or native operations.
                assert.equal(document.querySelectorAll('[data-auth-personal-security]').length, 1);
                assert.equal(forms.length, 2);
                const roots = [
                    { selector: '[data-account-password]', flags: ['data-account-password-can-change'] },
                    { selector: '[data-account-sessions]', flags: ['data-sessions-can-read', 'data-sessions-can-revoke'] },
                    { selector: '[data-account-api-tokens]', flags: ['data-tokens-can-read', 'data-tokens-can-manage'] },
                ];
                for (const specification of roots) {
                    const found = document.querySelectorAll<HTMLElement>(specification.selector);
                    assert.equal(found.length, 1, specification.selector);
                    const root = found.item(0);
                    if (!root) throw new Error('Missing closed personal component');
                    assert.equal(root.getAttribute('data-auth-personal-state'), 'unavailable');
                    for (const flag of specification.flags) assert.equal(root.getAttribute(flag), 'false', flag);
                }
                const ownedForms = [
                    { hook: 'data-account-password-form', owner: '[data-account-password]', action: '/api/auth/change-password' },
                    { hook: 'data-account-tokens-create', owner: '[data-account-api-tokens]', action: '/api/auth/api-tokens' },
                ];
                for (const form of forms) assert.equal(ownedForms.filter(specification => form.hasAttribute(specification.hook)).length, 1);
                for (const specification of ownedForms) {
                    const found = forms.filter(form => form.hasAttribute(specification.hook));
                    assert.equal(found.length, 1, specification.hook);
                    const form = found[0];
                    if (!form) throw new Error('Missing closed personal form');
                    assert.ok(form.closest(specification.owner));
                    assert.equal(form.closest('[data-classic-native-security]'), null);
                    assert.equal(form.getAttribute('method'), 'post');
                    assert.equal(form.getAttribute('action'), specification.action);
                }
                const native = document.querySelectorAll<HTMLElement>('[data-classic-native-security]');
                assert.ok(native.length > 0);
                for (const section of native) {
                    assert.equal(section.getAttribute('data-workspace-mode'), 'read-only');
                    assert.equal(section.getAttribute('aria-disabled'), 'true');
                    assert.equal(section.querySelectorAll('form').length, 0);
                }
                for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')) {
                    assert.equal(control.disabled, true);
                }
            }
            assert.equal((html.match(/<h1\b/g) ?? []).length, 1, route);
            assert.doesNotMatch(html, /\{\{|alice-shop|20014|1\.4\.2/);
        }
    });
    it('keeps all home tools visible while their actions remain unavailable', () => {
        const groups = groupViews('en', false, () => mono(''), new Set());
        assert.equal(groups.length, 9);
        assert.equal(groups.reduce((n, g) => n + g.tools.length, 0), 35);
        const enabled = groups.flatMap(g => g.tools).filter(t => t.enabled);
        assert.ok(enabled.every(t => t.href === '/security/account' || t.href === '?lang=ar'));
        assert.ok(groups.flatMap(g => g.tools).filter(t => !enabled.includes(t)).every(t => t.enabled === false));
        const home = xpanelHomeFromProps({
            locale: 'en', account, qualifiedRoutes: new Set()
        });
        assert.equal(home.desktop.groups.reduce((n, g) => n + g.tools.length, 0), 35);
        assert.equal(home.phone.groups.reduce((n, g) => n + g.tools.length, 0), 35);
    });
    it('requires the narrow PHP capability and the selected active owner before exposing the PATCH form', () => {
        const base = {
            route: '/software/php', locale: 'en' as const, readOnly: false, account, domains: [
                domain
            ], visibility: owner
        };
        assert.doesNotMatch(renderApprovedXpanelWorkspace(base)!, /data-domain-php-form/);
        assert.doesNotMatch(renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('php-version-selector')
        })!, /data-domain-php-form/);
        const html = renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('domain-php-settings')
        })!;
        assert.match(html, /data-domain-php-form/);
        assert.match(html, /data-domain-id="workspace-domain"/);
        for (const name of ['version', 'handler', 'fpm.mode', 'fpm.maxChildren', 'fpm.startServers', 'fpm.minSpareServers', 'fpm.maxSpareServers', 'fpm.maxRequests', 'fpm.processIdleTimeoutSec', 'ini.memory_limit'])
            assert.ok(html.includes(`name="${name}"`), name);
        assert.doesNotMatch(renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('domain-php-settings'), account: {
                ...account, status: 'suspended'
            }
        })!, /data-domain-php-form/);
        assert.doesNotMatch(renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('domain-php-settings'), visibility: {
                ...owner, principal: {
                    ...owner.principal, accountId: 'other'
                }
            }
        })!, /data-domain-php-form/);
    });
    it('never borrows a foreign domain or template example for the current account', () => {
        const html = renderApprovedXpanelWorkspace({
            route: '/software/php', locale: 'en', readOnly: false, account, domains: [
                {
                    ...domain, accountId: 'foreign', name: 'private.foreign.test'
                }
            ], visibility: owner, catalog: qualify('domain-php-settings')
        })!;
        assert.doesNotMatch(html, /private\.foreign\.test|data-domain-php-form/);
        assert.match(html, /Not read/);
    });
    it('exposes the existing DNS controller only with its narrow capability', () => {
        const base = {
            route: '/domains/zone-editor', locale: 'en' as const, readOnly: false, account, domains: [
                domain
            ], visibility: owner
        };
        assert.doesNotMatch(renderApprovedXpanelWorkspace(base)!, /data-dns-editor/);
        const html = renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('dns-zone-records')
        })!;
        for (const marker of ['data-dns-editor', 'data-dns-zone', 'data-dns-records', 'data-dns-account', 'data-dns-new-name', 'data-dns-add-record', 'data-dns-add-zone', 'data-dns-save', 'data-dns-delete', 'data-dns-status'])
            assert.ok(html.includes(marker), marker);
        assert.match(html, /<tbody data-dns-records>/);
        assert.doesNotMatch(html, /<textarea[^>]*data-dns-records/);
    });
    it('escapes account facts and PHP values while preserving ASCII glyphs', () => {
        const html = renderApprovedXpanelWorkspace({
            route: '/software/php', locale: 'ar', readOnly: false, account: {
                ...account, username: '<img src=x onerror=alert(1)>'
            }, domains: [
                {
                    ...domain, php: {
                        ...domain.php, ini: {
                            memory_limit: '"><script>alert(1)</script>'
                        }
                    }
                }
            ], visibility: owner, catalog: qualify('domain-php-settings')
        })!;
        assert.doesNotMatch(html, /<img src=x|<script>alert\(1\)/);
        assert.match(html, /&lt;img/);
        assert.match(html, /&quot;&gt;&lt;script&gt;/);
        assert.doesNotMatch(html, /[٠-٩۰-۹]/);
    });
    it('rejects private DTO data even if passed to an unqualified renderer', () => {
        const html = renderApprovedXpanelWorkspace({
            route: '/resources', locale: 'en', readOnly: true, account: {
                ...account, username: 'private-account-marker'
            }, nativeHtml: '<form>private-form-marker</form>'
        })!;
        assert.doesNotMatch(html, /private-account-marker|private-form-marker|<form\b/);
    });
    it('retains certificate name choices and honest result and token microstates', () => {
        const ssl = renderApprovedXpanelWorkspace({
            route: '/security/ssl', locale: 'en', readOnly: true
        })!;
        for (const label of ['Custom names', 'Additional names (SAN)', 'What happened'])
            assert.ok(ssl.includes(label), label);
        assert.match(ssl, /No certificate installation result has been read/);
        const security = renderApprovedXpanelWorkspace({
            route: '/security/account', locale: 'en', readOnly: true
        })!;
        const securityDocument = new DOMParser().parseFromString(security, 'text/html');
        const tokenRoots = securityDocument.querySelectorAll<HTMLElement>('[data-account-api-tokens]');
        assert.equal(tokenRoots.length, 1);
        const tokenRoot = tokenRoots[0]!;
        assert.equal(tokenRoot.dataset.authPersonalState, 'unavailable');
        assert.equal(tokenRoot.dataset.tokensCanRead, 'false');
        assert.equal(tokenRoot.dataset.tokensCanManage, 'false');
        assert.equal(tokenRoot.querySelector<HTMLElement>('[data-account-tokens-reveal]')?.hidden, true);
        assert.equal(tokenRoot.querySelector('[data-account-tokens-secret]')?.textContent, '');
        assert.equal(tokenRoot.querySelector<HTMLButtonElement>('[data-account-tokens-copy]')?.disabled, true);
        assert.equal(tokenRoot.querySelector('[data-account-tokens-rows]')?.children.length, 0);
        for (const control of tokenRoot.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) assert.equal(control.disabled, true);
        assert.doesNotMatch(security, /tokenHash|token_hash/);
        const mail = renderApprovedXpanelWorkspace({
            route: '/email/accounts', locale: 'en', readOnly: true
        })!;
        assert.match(mail, /No end date/);
        assert.doesNotMatch(mail, /data-password-generate/);
    });
    it('offers local password generation only in an authorized new mailbox form', () => {
        const input = {
            locale: 'en' as const, principal: owner.principal, account, domains: {
                state: 'read' as const, items: [
                    domain
                ]
            }, mutationsQualified: true
        };
        const html = renderEmailAccountsExtension(input);
        assert.match(html, /<form[^>]*data-mailbox-form="true"/);
        assert.match(html, /<button type="button" class="xp-btn" data-password-generate data-password-target="mailbox-password">Generate password/);
        assert.doesNotMatch(renderEmailAccountsExtension({
            ...input, mutationsQualified: false
        }), /data-password-generate/);
        assert.match(renderEmailAccountsExtension({
            ...input, domains: {
                state: 'read', items: []
            }
        }), /data-password-target="mailbox-password" disabled/);
        assert.match(renderEmailAccountsExtension({
            ...input, locale: 'ar'
        }), /توليد كلمة مرور/);
    });
    it('keeps unsupported component actions disabled without hiding their structure', () => {
        const html = renderApprovedXpanelWorkspace({
            route: '/advanced/cron', locale: 'en', readOnly: true
        })!;
        for (const label of ['Scheduled jobs', 'Add a cron job', 'Command to run', 'Output email', 'How a job runs'])
            assert.ok(html.includes(label), label);
        assert.match(html, /data-wiring="soon"/);
        assert.doesNotMatch(html, /<button\b(?![^>]*disabled)[^>]*>/);
        assert.equal(renderApprovedXpanelWorkspace({
            route: '/not-a-route', locale: 'en', readOnly: true
        }), undefined);
    });

    it('requires the narrow directory-privacy capability and the selected active owner before exposing the rule editor', () => {
        const base = {
            route: '/files/directory-privacy', locale: 'en' as const, readOnly: false, account, visibility: owner
        };
        const privacyHooks = ['data-directory-privacy', 'data-directory-privacy-rows', 'data-directory-privacy-status', 'data-directory-privacy-add', 'data-directory-privacy-save', 'data-directory-privacy-path', 'data-directory-privacy-prompt', 'data-directory-privacy-username', 'data-directory-privacy-password', 'data-directory-privacy-preview'];
        const assertNoPrivacyEditor = (html: string): void => {
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            assert.equal(parsed.querySelectorAll(privacyHooks.map(hook => `[${hook}]`).join(',')).length, 0);
        };
        assertNoPrivacyEditor(renderApprovedXpanelWorkspace(base)!);
        assertNoPrivacyEditor(renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('file-manager')
        })!);
        assertNoPrivacyEditor(renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('directory-privacy'), readOnly: true
        })!);
        const html = renderApprovedXpanelWorkspace({
            ...base, catalog: qualify('directory-privacy')
        })!;
        assert.match(html, /data-directory-privacy data-account-username="owner"/);
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        assert.equal(parsed.querySelectorAll('[data-directory-privacy]').length, 1);
        assert.equal(parsed.querySelector('[data-directory-privacy]')!.getAttribute('data-account-username'), account.username);
        for (const hook of privacyHooks.slice(1)) assert.equal(parsed.querySelectorAll(`[data-directory-privacy] [${hook}]`).length, 1, hook);
        for (const hook of ['data-directory-privacy-rows', 'data-directory-privacy-status', 'data-directory-privacy-add', 'data-directory-privacy-save', 'data-directory-privacy-path', 'data-directory-privacy-prompt', 'data-directory-privacy-username', 'data-directory-privacy-password', 'data-directory-privacy-preview'])
            assert.ok(html.includes(hook), hook);
        assert.doesNotMatch(html, /<form\b/);
        assert.match(html, /A folder counts as protected only after the web server asked for a password/);
        assert.match(html, /placeholder="public_html\/private"/);
    });

    it('requires the ssl-tls-status and ssl-install capabilities and renders installed certificates, upload and actions without served-TLS claims', () => {
        const certificate = {
            id: 'certificate-workspace-1', accountId: account.id, names: [account.primaryDomain], source: 'acme' as const,
            challenge: 'http-01' as const, notAfter: '2027-01-01T00:00:00.000Z', autoRenew: true
        };
        const assigned = { ...domain, certificateId: certificate.id };
        const base = {
            route: '/security/ssl', locale: 'en' as const, readOnly: false, account, domains: [assigned], visibility: owner, certificates: [certificate]
        };
        assert.doesNotMatch(renderApprovedXpanelWorkspace(base)!, /data-account-ssl/);
        for (const partial of [qualify('ssl-certificates'), qualify('ssl-tls-status'), qualify('ssl-install')])
            assert.doesNotMatch(renderApprovedXpanelWorkspace({ ...base, catalog: partial })!, /data-account-ssl/);
        const html = renderApprovedXpanelWorkspace({ ...base, catalog: qualify('ssl-tls-status', 'ssl-install') })!;
        assert.match(html, /data-account-ssl/);
        assert.match(html, /data-certificate-form/);
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        assert.equal(parsed.querySelectorAll('[data-account-ssl]').length, 1);
        assert.equal(parsed.querySelector('[data-account-ssl]')!.getAttribute('data-account-username'), account.username);
        for (const hook of ['rows', 'autossl', 'autossl-chip', 'status', 'detail', 'facts', 'domain', 'key', 'cert', 'bundle', 'install'])
            assert.equal(parsed.querySelectorAll('[data-account-ssl-' + hook + ']').length, 1, hook);
        assert.deepEqual([...parsed.querySelectorAll('[data-account-ssl-rows] button')].map(button => button.textContent), ['View', 'Renew now', 'Remove']);
        assert.equal(parsed.querySelectorAll('[data-workspace-section="installed-certificates"]').length, 0);
        assert.equal(parsed.querySelectorAll('form[data-certificate-form="true"]').length, 1);
        assert.equal(parsed.querySelector('form[data-certificate-form]')!.getAttribute('data-account-username'), account.username);
        assert.match(html, /Installed certificates/);
        assert.match(html, /Upload a private key and certificate/);
        assert.match(html, /CA bundle \(optional\)/);
        assert.doesNotMatch(html, /AutoSSL on/);
        assert.match(html, /2027-01-01/);
        assert.doesNotMatch(html, /certificate-workspace-1/);
        const empty = renderApprovedXpanelWorkspace({ ...base, domains: [], certificates: [], catalog: qualify('ssl-tls-status', 'ssl-install') })!;
        assert.match(empty, /Add a domain before issuing a certificate/);
        const emptyDocument = new DOMParser().parseFromString(empty, 'text/html');
        assert.equal(emptyDocument.querySelectorAll('[data-certificate-form]').length, 0);
        assert.equal(emptyDocument.forms.length, 0);
    });

    it('connects the logs workspace from visitors and errors, not from the raw-access download', () => {
        const logs = (catalog: ReturnType<typeof qualify>) => renderApprovedXpanelWorkspace({ route: '/metrics/logs', locale: 'en', readOnly: false, account, domains: [domain], visibility: owner, catalog })!;
        const download = logs(qualify('raw-access'));
        assert.match(download, /data-workspace-mode="read-only"/);
        assert.match(download, /data-logs-kinds=""/);
        const tail = logs(qualify('visitors'));
        assert.match(tail, /data-workspace-mode="connected"/);
        assert.match(tail, /data-logs-kinds="access"/);
        assert.match(logs(qualify('visitors', 'errors')), /data-logs-kinds="access error"/);
    });

    it('renders self sessions from explicit personal authority independently of native qualification', () => {
        const base = { route: '/security/account', locale: 'en' as const, readOnly: false, account, domains: [domain], visibility: owner };
        const authPersonal = { state: 'ready' as const, canChangePassword: false, canReadSessions: true, canRevokeSessions: true, canReadApiTokens: false, canManageApiTokens: false };
        for (const readOnly of [false, true]) {
            const html = renderApprovedXpanelWorkspace({ ...base, readOnly, authPersonal })!;
            const page = new DOMParser().parseFromString(html, 'text/html');
            const roots = page.querySelectorAll<HTMLElement>('[data-account-sessions]');
            assert.equal(roots.length, 1);
            const root = roots[0]!;
            assert.equal(root.dataset.authPersonalState, 'ready');
            assert.equal(root.dataset.sessionsCanRead, 'true');
            assert.equal(root.dataset.sessionsCanRevoke, 'true');
            assert.equal(root.closest('[data-classic-native-security],[data-tool-availability="unverified"],[inert],fieldset[disabled],[aria-disabled="true"]'), null);
            assert.equal(root.querySelector('[data-sessions-rows]')?.children.length, 0);
            assert.equal(root.querySelector<HTMLButtonElement>('[data-sessions-revoke-others]')?.disabled, true);
            const nativeRoots = page.querySelectorAll('[data-classic-native-security]');
            assert.ok(nativeRoots.length > 0);
            for (const native of nativeRoots) {
                assert.equal(native.querySelectorAll('form').length, 0);
                for (const control of native.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')) assert.equal(control.disabled, true);
            }
            assert.doesNotMatch(html, /tokenHash|token_hash/);
        }
        for (const supplied of [undefined, { ...authPersonal, state: 'denied' as const }, { ...authPersonal, state: 'unavailable' as const }]) {
            const html = renderApprovedXpanelWorkspace({ ...base, authPersonal: supplied })!;
            const page = new DOMParser().parseFromString(html, 'text/html');
            const roots = page.querySelectorAll<HTMLElement>('[data-account-sessions]');
            assert.equal(roots.length, 1);
            const root = roots[0]!;
            assert.equal(root.dataset.sessionsCanRead, 'false');
            assert.equal(root.dataset.sessionsCanRevoke, 'false');
            for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) assert.equal(control.disabled, true);
            assert.doesNotMatch(html, /tokenHash|token_hash/);
        }
    });
});
