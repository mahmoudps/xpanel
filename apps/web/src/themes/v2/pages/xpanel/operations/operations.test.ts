import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account } from '@xpanel/core'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { matchesHook, parseMarkup, type HookSelector } from '../../../../markup.ts'
import { renderV2AccountBackupPage, renderV2AccountFtpPage, renderV2AccountGitPage, renderV2AccountPackagesPage, renderV2AccountRuntimePage, renderV2AccountTerminalPage, renderV2PanelOperationsPage, type PanelOperationAuthority } from './index.ts'

const account: Account = { id: 'a1', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'p1', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', ipv6: null, extraIps: [], shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const plan = defaultPlan({ id: 'p1', name: 'Account plan', featureListId: 'f1' })
plan.shell = 'jailed'
const props = (extra: Partial<PanelSurfaceProps> = {}): PanelSurfaceProps => ({ account, plan, locale: 'en', ...extra })
const allowed: PanelOperationAuthority = { canRead: true, canManage: true, canUseTerminal: true }
const elements = (html: string, selector: HookSelector) => parseMarkup(html).filter(node => matchesHook(node, selector))

describe('v2 account operations', () => {
  it('routes exactly the eight implemented workspaces and leaves other dispatch to core', () => {
    for (const route of ['/files/backup', '/files/ftp', '/files/git', '/advanced/terminal', '/software/apps', '/software/containers', '/software/cache', '/software/packages']) {
      expect(renderV2PanelOperationsPage(props({ activeRoute: route }), allowed)).toContain(`data-v2-operations-route="${route}"`)
    }
    expect(renderV2PanelOperationsPage(props({ activeRoute: '/domains' }), allowed)).toBeUndefined()
  })

  it('keeps all eight unknown-account layouts without synthesizing facts or native authority', () => {
    for (const route of ['/files/backup', '/files/ftp', '/files/git', '/advanced/terminal', '/software/apps', '/software/containers', '/software/cache', '/software/packages']) {
      const html = renderV2PanelOperationsPage(props({ activeRoute: route, account: undefined, plan: { ...plan, name: 'UNTRUSTED_PLAN' } }), allowed)!
      expect(html).toContain(`data-v2-operations-route="${route}"`)
      expect(parseMarkup(html).filter(node => node.tag === 'h1')).toHaveLength(1)
      expect(parseMarkup(html).filter(node => (node.attrs.get('class') ?? '').split(' ').includes('v2-card')).length).toBeGreaterThanOrEqual(2)
      expect(elements(html, '[data-v2-operations-route]')[0]?.attrs.get('data-readonly')).toBe('true')
      expect(html).not.toContain('UNTRUSTED_PLAN')
      expect(html).not.toContain('xpanel-undefined.slice')
      expect(html).not.toContain('data-account="a1"')
      expect(html).not.toMatch(/data-(?:runtime-can-manage|sw-can-manage|git-manage|packages-manage|account-backup-manage|terminal-can-use)="true"/)
    }
  })

  it('fences stored FTP facts by identity and independent tool permission without enabling native operations', () => {
    const visibility = { principal: { kind: 'user' as const, id: 'user-alice', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
    const serviceUsers = [{ id: 'ftp-own', accountId: account.id, login: 'OWN_STORED_FTP', services: { ftp: true, email: false, webdisk: false }, ftpDir: 'public_html', mailboxQuotaMb: 100 }, { id: 'ftp-foreign', accountId: 'foreign', login: 'FOREIGN_FTP', services: { ftp: true, email: false, webdisk: false }, ftpDir: 'secret', mailboxQuotaMb: 100 }]
    const input = props({ activeRoute: '/files/ftp', visibility, catalog: tools, serviceUsers })
    const readOnly: PanelOperationAuthority = { ...allowed, presentation: 'read-only', canReadFacts: true, authorizedTools: new Set(['ftp-accounts']) }
    const html = renderV2AccountFtpPage(input, readOnly)
    expect(html).toContain('OWN_STORED_FTP')
    expect(html).not.toContain('FOREIGN_FTP')
    expect(elements(html, '[data-v2-operations-route]')[0]?.attrs.get('data-readonly')).toBe('true')
    expect(elements(html, '[data-mailbox-password]')[0]?.attrs.get('disabled')).toBeDefined()
    for (const authority of [{ ...readOnly, canReadFacts: false }, { ...readOnly, authorizedTools: new Set<string>() }]) {
      const denied = renderV2AccountFtpPage(input, authority)
      expect(denied).not.toContain('OWN_STORED_FTP')
      expect(denied).not.toContain('FOREIGN_FTP')
      expect(denied).not.toContain('data-account="a1"')
    }
    const wrongAccount = renderV2AccountFtpPage({ ...input, visibility: { ...visibility, principal: { ...visibility.principal, accountId: 'other-account' } } }, readOnly)
    expect(wrongAccount).not.toContain('OWN_STORED_FTP')
    expect(wrongAccount).not.toContain('data-account="a1"')
    expect(renderV2AccountFtpPage({ ...input, serviceUsers: undefined }, readOnly)).toContain('FTP service users have not been read.')
    expect(renderV2AccountFtpPage({ ...input, serviceUsers: [] }, readOnly)).toContain('No FTP service users were returned.')
  })

  it('never enables a terminal from stale read-only flags or reads an unrelated saved plan', () => {
    const visibility = { principal: { kind: 'user' as const, id: 'user-alice', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
    const readOnly: PanelOperationAuthority = { ...allowed, presentation: 'read-only', canReadFacts: true, authorizedTools: new Set(['terminal']) }
    const html = renderV2AccountTerminalPage(props({ visibility, catalog: tools, plan: { ...plan, id: 'foreign-plan' } }), readOnly)
    expect(html).toContain('data-terminal-can-use="false"')
    expect(html).not.toContain('Jailed, from your plan')
    expect(html).toContain('The account plan has not been read.')
    expect(elements(html, '[data-terminal-run]')[0]?.attrs.get('disabled')).toBeDefined()
  })

  it('defaults to no operation authority even when account facts are supplied', () => {
    expect(renderV2AccountBackupPage(props())).toContain('data-account-backup-manage="false"')
    expect(renderV2AccountGitPage(props())).toContain('data-git-manage="false"')
    expect(renderV2AccountRuntimePage(props(), 'apps')).toContain('data-runtime-can-manage="false"')
    expect(renderV2AccountPackagesPage(props())).toContain('data-packages-manage="false"')
    expect(renderV2AccountBackupPage(props({ account: { ...account, status: 'suspended' } }), allowed)).toContain('data-account-backup-manage="false"')
  })

  it('keeps archive differences, explicit acknowledgement and username confirmation separate', () => {
    const html = renderV2AccountBackupPage(props(), allowed)
    expect(elements(html, '[data-account-backup-select]')[0]?.tag).toBe('select')
    expect(elements(html, '[data-account-backup-archives]')[0]?.tag).toBe('tbody')
    expect(elements(html, '[data-account-backup-differences]')[0]?.tag).toBe('tbody')
    expect(elements(html, '[data-account-backup-confirmation]')[0]?.attrs.get('disabled')).toBeDefined()
    expect(elements(html, '[data-account-backup-ack]')[0]?.attrs.get('type')).toBe('checkbox')
    expect(elements(html, '[data-account-backup-restore]')[0]?.attrs.get('disabled')).toBeDefined()
    expect(html).toContain('No archive has been compared.')
    expect(html).not.toContain('Restore finished')
  })

  it('preserves the approved six archive columns with a theme-owned row template', () => {
    const html = renderV2AccountBackupPage(props(), allowed)
    expect(html).toContain('data-xp-template="account-backup-archive-row"')
    for (const slot of ['file', 'created', 'contents', 'bytes', 'location', 'integrity']) expect(html).toContain(`data-xp-slot="${slot}"`)
    expect(html).toContain('colspan="6"')
    expect(html).toContain('Mailbox data and mail settings')
  })

  it('retains real Git field limits, isolated facts and a three-column history body', () => {
    const html = renderV2AccountGitPage(props(), allowed)
    expect(elements(html, '[data-git-path]')[0]?.attrs.get('maxlength')).toBe('240')
    expect(elements(html, '[data-git-url]')[0]?.attrs.get('type')).toBe('url')
    expect(elements(html, '[data-git-initial-branch]')[0]?.attrs.get('value')).toBe('main')
    expect(elements(html, '[data-git-current]')[0]?.tag).toBe('bdi')
    expect(elements(html, '[data-git-history]')[0]?.tag).toBe('tbody')
    expect(html).toContain('History has not been read.')
    expect(html).toContain('Deployment tasks and Git web access are unavailable.')
  })

  it('requires explicit terminal admission plus the current active jailed account and matching plan', () => {
    expect(renderV2AccountTerminalPage(props(), allowed)).toContain('data-terminal-can-use="true"')
    expect(renderV2AccountTerminalPage(props())).toContain('data-terminal-can-use="false"')
    expect(renderV2AccountTerminalPage(props({ account: { ...account, status: 'suspended' } }), allowed)).toContain('data-terminal-can-use="false"')
    expect(renderV2AccountTerminalPage(props({ account: { ...account, shell: 'none' } }), allowed)).toContain('data-terminal-can-use="false"')
    const foreign = renderV2AccountTerminalPage(props({ plan: { ...plan, id: 'foreign' } }), allowed)
    expect(foreign).toContain('data-terminal-can-use="false"')
    expect(foreign).toContain('The account plan has not been read.')
  })

  it('keeps account terminal controls session-gated without root password fields', () => {
    const html = renderV2AccountTerminalPage(props(), allowed)
    expect(elements(html, '[data-terminal-command-form]')[0]?.tag).toBe('form')
    expect(elements(html, '[data-terminal-screen]')[0]?.attrs.get('dir')).toBe('ltr')
    expect(elements(html, '[data-terminal-run]')[0]?.attrs.get('disabled')).toBeDefined()
    expect(elements(html, '[data-terminal-close]')[0]?.attrs.get('hidden')).toBeDefined()
    expect(html).not.toContain('data-terminal-password')
    expect(html).not.toContain('Session open.')
  })

  it('filters FTP rows by account and preserves unknown versus measured empty state', () => {
    const unread = renderV2AccountFtpPage(props(), allowed)
    const empty = renderV2AccountFtpPage(props({ serviceUsers: [] }), allowed)
    expect(unread).toContain('FTP service users have not been read.')
    expect(empty).toContain('No FTP service users were returned.')
    const users = [{ id: 'u1', accountId: 'a1', login: 'alice_ftp', services: { ftp: true, email: false, webdisk: false }, ftpDir: 'public_html', mailboxQuotaMb: 100, createdAt: '2026-10-29T00:00:00Z' }, { id: 'u2', accountId: 'foreign', login: 'secret_foreign', services: { ftp: true, email: false, webdisk: false }, ftpDir: 'private', mailboxQuotaMb: 100, createdAt: '2026-10-29T00:00:00Z' }]
    const html = renderV2AccountFtpPage(props({ serviceUsers: users }), allowed)
    expect(html).toContain('alice_ftp')
    expect(html).not.toContain('secret_foreign')
    expect(html).not.toContain('data-mailbox-form')
    expect(html).not.toContain('data-remove-mailbox')
    expect(html).not.toContain('data-mailbox-quota="u1"')
  })

  it('uses native service-user dialogs and does not present mailbox storage as FTP disk quota', () => {
    const html = renderV2AccountFtpPage(props(), allowed)
    expect(elements(html, '[data-mailbox-password-dialog]')[0]?.tag).toBe('dialog')
    expect(elements(html, '[data-mailbox-quota-dialog]')[0]?.tag).toBe('dialog')
    expect(html).toContain('It is not an FTP disk quota.')
    expect(html).toContain('type="password" dir="ltr" minlength="8"')
  })

  it('preserves signed application choices and all runtime setup panels without fake observations', () => {
    const html = renderV2AccountRuntimePage(props(), 'apps', allowed)
    for (const key of ['domain', 'app', 'version']) expect(elements(html, `[data-sw-apps-${key}-select]`)[0]?.tag).toBe('select')
    for (const key of ['settings', 'variables', 'deploy', 'logs']) expect(html).toContain(`data-runtime-panel="${key}"`)
    for (const key of ['name', 'root', 'startup', 'domain', 'path', 'runtime']) expect(html).toContain(`data-runtime-input="${key}"`)
    expect(html).toContain('Applications have not been read.')
    expect(html).not.toContain('Installed ·')
  })

  it('preserves private container and cache controllers while unsupported network publishing stays disabled', () => {
    const containers = renderV2AccountRuntimePage(props(), 'containers', allowed)
    expect(containers).toContain('data-runtime-containers')
    expect(containers).toContain('data-runtime-env')
    expect(containers).toContain('data-runtime-action="ctr-run" disabled')
    const cache = renderV2AccountRuntimePage(props(), 'cache', allowed)
    expect(cache).toContain('data-runtime-input="memory" disabled')
    expect(cache).toContain('type="number" min="8" step="1"')
    expect(elements(cache, '[data-runtime-input="socket"]')[0]?.attrs.get('readonly')).toBeDefined()
  })

  it('keeps installed and reviewed package inventories separate without inventing packages', () => {
    const html = renderV2AccountPackagesPage(props(), allowed)
    expect(elements(html, '[data-packages-installed]')[0]?.tag).toBe('tbody')
    expect(elements(html, '[data-packages-available]')[0]?.tag).toBe('tbody')
    expect(html).toContain('data-packages-recover disabled')
    expect(html).toContain('Packages have not been read.')
    expect(html).not.toContain('data-package-name=')
  })

  it('escapes account facts, keeps technical values isolated and emits ASCII digits in Arabic', () => {
    const html = renderV2AccountBackupPage(props({ locale: 'ar', account: { ...account, username: '<script>x</script>' } }), allowed)
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('<bdi dir="ltr" class="v2-mono">')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
  })
})
