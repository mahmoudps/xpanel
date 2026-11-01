// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH, defaultPlan, type Account } from '@xpanel/core';
import { tools } from '@xpanel/catalog';
import type { AuthPersonalView } from '../themes/contract.ts';
import { classicTheme } from '../themes/classic/index.ts';
import { CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST, renderApprovedXpanelWorkspace, type ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts';

const ready: AuthPersonalView = {
    state: 'ready', canChangePassword: true, canReadSessions: true, canRevokeSessions: true,
    canReadApiTokens: true, canManageApiTokens: true,
};
const account: Account = {
    id: 'private-security-account', username: 'owner', uid: 20042, gid: 20042, home: '/home/owner',
    primaryDomain: 'owner.test', planId: 'private-security-plan', ownerId: null, status: 'active',
    suspendReason: null, contactEmail: 'owner@owner.test', ipv4: '192.0.2.42', shell: 'none',
    createdAt: '2026-10-25T00:00:00Z',
};
const input = (locale: 'en' | 'ar', readOnly: boolean, authPersonal?: AuthPersonalView): ApprovedXpanelWorkspaceProps => ({
    route: '/security/account', locale, readOnly, authPersonal,
});
const html = (locale: 'en' | 'ar', readOnly: boolean, authPersonal?: AuthPersonalView): string =>
    renderApprovedXpanelWorkspace(input(locale, readOnly, authPersonal))!;
const uniqueIds = () => {
    const ids = Array.from(document.querySelectorAll<HTMLElement>('[id]')).map(node => node.id);
    expect(new Set(ids).size).toBe(ids.length);
};
const password = () => document.querySelector<HTMLElement>('[data-account-password]')!;
const sessions = () => document.querySelector<HTMLElement>('[data-account-sessions]')!;
const tokens = () => document.querySelector<HTMLElement>('[data-account-api-tokens]')!;
const assertOutsideNative = (node: HTMLElement) => {
    expect(node.closest('[data-classic-native-security],[data-tool-availability="unverified"],[inert],fieldset[disabled],[aria-disabled="true"]')).toBeNull();
};

afterEach(() => document.body.replaceChildren());

describe('Classic independent personal Security controls', () => {
    it.each((['en', 'ar'] as const).flatMap(locale => [true, false].map(readOnly => ({ locale, readOnly }))))(
        'renders closed SSR controls with independent ready authority in $locale, native-readonly=$readOnly',
        ({ locale, readOnly }) => {
            document.body.innerHTML = html(locale, readOnly, ready);
            expect(document.querySelectorAll('[data-account-password]')).toHaveLength(1);
            expect(document.querySelectorAll('[data-account-sessions]')).toHaveLength(1);
            expect(document.querySelectorAll('[data-account-api-tokens]')).toHaveLength(1);
            for (const node of [password(), sessions(), tokens()]) {
                assertOutsideNative(node);
                expect(node.dataset.authPersonalState).toBe('ready');
                for (const control of node.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) {
                    expect(control.disabled).toBe(true);
                }
            }
            expect(password().dataset.accountPasswordCanChange).toBe('true');
            expect(sessions().dataset.sessionsCanRead).toBe('true');
            expect(sessions().dataset.sessionsCanRevoke).toBe('true');
            expect(tokens().dataset.tokensCanRead).toBe('true');
            expect(tokens().dataset.tokensCanManage).toBe('true');
            const form = password().querySelector<HTMLFormElement>('[data-account-password-form]')!;
            expect(form.getAttribute('method')).toBe('post');
            expect(form.getAttribute('action')).toBe('/api/auth/change-password');
            expect(form.querySelector('[data-auth-password-form]')).toBeNull();
            const current = form.elements.namedItem('currentPassword') as HTMLInputElement;
            const next = form.elements.namedItem('newPassword') as HTMLInputElement;
            const confirm = form.elements.namedItem('confirmPassword') as HTMLInputElement;
            expect(ACCOUNT_SELF_PASSWORD_MIN_LENGTH).toBe(8);
            expect(current.required).toBe(true);
            expect(current.minLength).toBe(-1);
            expect(current.maxLength).toBe(-1);
            for (const field of [next, confirm]) {
                expect(field.required).toBe(true);
                expect(field.minLength).toBe(8);
                expect(field.maxLength).toBe(1024);
                expect(field.autocomplete).toBe('new-password');
                expect(field.value).toBe('');
            }
            expect(current.autocomplete).toBe('current-password');
            expect(current.value).toBe('');
            expect(password().querySelectorAll('.xp-personal-security-rules li')).toHaveLength(3);
            expect(password().querySelector('[data-account-password-rule="length"]')?.getAttribute('data-state')).toBe('unknown');
            expect(password().querySelector('[data-state="passed"]')).toBeNull();
            expect(password().querySelectorAll('[data-account-password-current-error],[data-account-password-new-error],[data-account-password-confirm-error]')).toHaveLength(3);
            const nativeCards = document.querySelectorAll<HTMLElement>('[data-classic-native-security]');
            expect(nativeCards.length).toBeGreaterThan(0);
            for (const native of nativeCards) {
                expect(native.dataset.toolAvailability).toBe('unverified');
                for (const control of native.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')) expect(control.disabled).toBe(true);
            }
            expect(tokens().querySelectorAll('thead th')).toHaveLength(7);
            expect(tokens().querySelectorAll('template')).toHaveLength(8);
            expect(tokens().querySelector('[data-account-tokens-rows]')?.children).toHaveLength(0);
            expect(tokens().querySelector('[data-account-tokens-empty]')?.hasAttribute('hidden')).toBe(true);
            expect(tokens().querySelector('[data-account-tokens-reveal]')?.hasAttribute('hidden')).toBe(true);
            expect(tokens().querySelector('[data-account-tokens-secret]')?.textContent).toBe('');
            expect(tokens().querySelector<HTMLSelectElement>('[data-account-tokens-expiry]')?.value).toBe('90');
            expect(Array.from(tokens().querySelector<HTMLSelectElement>('[data-account-tokens-expiry]')!.options).map(option => option.value)).toEqual(['30', '90', '180', '365']);
            expect(Array.from(tokens().querySelectorAll<HTMLInputElement>('[data-account-tokens-scope]')).map(node => node.value)).toEqual(
                ['files', 'databases', 'dns', 'mail', 'backups', 'cron'].flatMap(resource => ['read', 'write'].map(action => resource + ':' + action)),
            );
            expect(tokens().querySelector<HTMLInputElement>('[data-account-tokens-read-only]')?.checked).toBe(true);
            expect(tokens().querySelector('[data-account-tokens-select-all]')?.getAttribute('aria-label')).toContain('50');
            expect(document.querySelectorAll('[data-auth-error],[data-auth-status]')).toHaveLength(0);
            expect(document.querySelectorAll('[data-classic-account-security-factor-host]')).toHaveLength(1);
            const navigation = document.querySelectorAll<HTMLAnchorElement>('.xp-personal-security-nav a');
            expect(navigation).toHaveLength(7);
            for (const link of navigation) expect(document.getElementById(link.getAttribute('href')!.slice(1))).not.toBeNull();
            uniqueIds();
        },
    );

    it.each((['en', 'ar'] as const).flatMap(locale => ['missing', 'denied', 'unavailable'].map(state => ({ locale, state }))))(
        'keeps $state personal authority closed even when native UI is qualified in $locale',
        ({ locale, state }) => {
            const auth = state === 'missing' ? undefined : { ...ready, state: state as 'denied' | 'unavailable' };
            document.body.innerHTML = html(locale, false, auth);
            expect(password().dataset.accountPasswordCanChange).toBe('false');
            expect(sessions().dataset.sessionsCanRead).toBe('false');
            expect(sessions().dataset.sessionsCanRevoke).toBe('false');
            expect(tokens().dataset.tokensCanRead).toBe('false');
            expect(tokens().dataset.tokensCanManage).toBe('false');
            for (const root of [password(), sessions(), tokens()]) {
                assertOutsideNative(root);
                for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) expect(control.disabled).toBe(true);
            }
        },
    );

    it.each(['canChangePassword', 'canReadSessions', 'canRevokeSessions', 'canReadApiTokens', 'canManageApiTokens'] as const)(
        'does not borrow another personal action flag when only %s is granted',
        flag => {
            const auth = { state: 'ready', canChangePassword: false, canReadSessions: false, canRevokeSessions: false, canReadApiTokens: false, canManageApiTokens: false, [flag]: true } as AuthPersonalView;
            document.body.innerHTML = html('en', true, auth);
            expect(password().dataset.accountPasswordCanChange).toBe(String(flag === 'canChangePassword'));
            expect(sessions().dataset.sessionsCanRead).toBe(String(flag === 'canReadSessions'));
            expect(sessions().dataset.sessionsCanRevoke).toBe(String(flag === 'canRevokeSessions'));
            expect(tokens().dataset.tokensCanRead).toBe(String(flag === 'canReadApiTokens'));
            expect(tokens().dataset.tokensCanManage).toBe(String(flag === 'canManageApiTokens'));
        },
    );

    it.each(['en', 'ar'] as const)('fills the actual standalone MFA host once outside native fences in %s', locale => {
        const bodyHtml = classicTheme.renderUnavailable({
            surface: 'xpanel', locale, theme: 'light', density: 'comfortable', route: '/security/account',
            heading: 'Account security', admitted: true, securityPage: true, qualifiedRoutes: new Set(),
            signedIn: true, authPersonal: ready,
        });
        const filled = classicTheme.slots.accountSecurity({ bodyHtml, security: { locale, surface: 'xpanel', principalKind: 'user', totpEnabled: false, mfaMode: 'disabled' } });
        document.body.innerHTML = filled;
        expect(document.querySelectorAll('[data-account-security="two-factor"]')).toHaveLength(1);
        expect(document.querySelectorAll('[data-classic-account-security-factor-host]')).toHaveLength(0);
        assertOutsideNative(password());
        assertOutsideNative(sessions());
        assertOutsideNative(tokens());
        expect(document.querySelector('[data-account-security="two-factor"]')?.closest('[data-classic-native-security],[data-tool-availability="unverified"],[inert]')).toBeNull();
        uniqueIds();
    });

    it.each(['en', 'ar'] as const)('uses the same helper for qualified live dispatch in %s', locale => {
        const rendered = classicTheme.renderPanel({
            account, plan: defaultPlan({ id: account.planId, name: 'Owner plan' }), activeRoute: '/security/account', locale,
            visibility: { principal: { kind: 'user', id: 'owner-principal', username: account.username, accountId: account.id }, disabledFeatures: new Set() },
            catalog: tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } })),
            authPersonal: ready,
        });
        document.body.innerHTML = rendered;
        expect(document.querySelectorAll('[data-auth-personal-security]')).toHaveLength(1);
        expect(password().dataset.accountPasswordCanChange).toBe('true');
        expect(tokens().dataset.tokensCanManage).toBe('true');
        expect(document.querySelectorAll('[data-classic-account-security-factor-host]')).toHaveLength(1);
        uniqueIds();
    });

    it.each(['duplicate', 'inert-template', 'foreign-namespace'] as const)('rejects a malformed personal MFA host: %s', variant => {
        const bodyHtml = variant === 'duplicate'
            ? '<section data-auth-personal-security data-approved-xpanel-workspace="/security/account" data-surface="xpanel">' + CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST + CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST + '</section>'
            : variant === 'inert-template'
                ? '<section data-auth-personal-security data-approved-xpanel-workspace="/security/account" data-surface="xpanel"><template>' + CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST + '</template></section>'
                : '<section data-auth-personal-security data-approved-xpanel-workspace="/security/account" data-surface="xpanel"><svg><g data-classic-account-security-factor-host></g></svg></section>';
        expect(() => classicTheme.slots.accountSecurity({ bodyHtml, security: { locale: 'en', surface: 'xpanel', principalKind: 'user', totpEnabled: false, mfaMode: 'disabled' } })).toThrow('classic_security_factor_host');
    });
});
