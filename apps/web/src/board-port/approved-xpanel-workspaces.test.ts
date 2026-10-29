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
const qualify = (id: string) => tools.map(tool => tool.id === id ? {
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
            assert.doesNotMatch(html, /<form\b|data-domain-php-form|data-dns-editor/);
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
        assert.match(security, /data-workspace-section="token-one-time"/);
        assert.match(security, /No token was issued/);
        assert.match(security, /disabled data-wiring="soon">Copy token/);
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
        assert.match(html, /Saved rules are account configuration only/);
    });

    it('requires the ssl-certificates capability and renders installed certificates, upload and actions without served-TLS claims', () => {
        const certificate = {
            id: 'certificate-workspace-1', accountId: account.id, names: [account.primaryDomain], source: 'acme' as const,
            challenge: 'http-01' as const, notAfter: '2027-01-01T00:00:00.000Z', autoRenew: true
        };
        const assigned = { ...domain, certificateId: certificate.id };
        const base = {
            route: '/security/ssl', locale: 'en' as const, readOnly: false, account, domains: [assigned], visibility: owner, certificates: [certificate]
        };
        assert.doesNotMatch(renderApprovedXpanelWorkspace(base)!, /data-account-ssl/);
        const html = renderApprovedXpanelWorkspace({ ...base, catalog: qualify('ssl-certificates') })!;
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
        const empty = renderApprovedXpanelWorkspace({ ...base, domains: [], certificates: [], catalog: qualify('ssl-certificates') })!;
        assert.match(empty, /Add a domain before issuing a certificate/);
        const emptyDocument = new DOMParser().parseFromString(empty, 'text/html');
        assert.equal(emptyDocument.querySelectorAll('[data-certificate-form]').length, 0);
        assert.equal(emptyDocument.forms.length, 0);
    });

    it('renders the trusted-self session section only for the active owner account-security page', () => {
        const base = { route: '/security/account', locale: 'en' as const, readOnly: false, account, domains: [domain], visibility: owner };
        const html = renderApprovedXpanelWorkspace(base)!;
        assert.match(html, /data-account-sessions/);
        assert.match(html, /data-sessions-rows/);
        assert.match(html, /data-sessions-revoke-others/);
        assert.doesNotMatch(html, /tokenHash|token_hash/);
        assert.equal(renderApprovedXpanelWorkspace({ ...base, readOnly: true }), renderApprovedXpanelWorkspace({ ...base, readOnly: true })!.replace(/<section[^>]*data-account-sessions[\s\S]*?<\/section>/, ''), 'read-only workspace omits session controls');
        const readOnlyHtml = renderApprovedXpanelWorkspace({ ...base, readOnly: true })!;
        assert.doesNotMatch(readOnlyHtml, /data-account-sessions/);
    });
});
