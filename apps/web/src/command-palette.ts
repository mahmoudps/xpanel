import { catalogKeys, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { canSeeAccount, type Account, type Domain } from '@xpanel/core'
import { getSurfaceNavigationLabel } from './shell.ts'
import { escapeHtml, normalizeAsciiDigits } from './tokens.ts'
import { catalogKeywords, translator, type Locale, type MessageValues } from './i18n.ts'
export type CommandPaletteSurface = 'login' | 'xpanel' | 'xwhm' | 'xmail'
export type CommandPaletteKind = 'page' | 'action' | 'account' | 'domain'
export interface CommandPaletteRecords {
  accounts?: readonly Pick<Account, 'id' | 'ownerId' | 'username' | 'primaryDomain'>[]
  domains?: readonly Pick<Domain, 'id' | 'accountId' | 'name'>[]
}
export interface CommandPaletteEntry {
  key: string
  kind: CommandPaletteKind
  label: string
  section: string
  route: string
  href: string
  hint: string
  search: string
  persistable: boolean
}
const actionRoutes = new Set(['/whm/accounts/new', '/mail/compose', '/security/ssl/issue', '/whm/ssl/install'])
const text = (locale: Locale, message: string, values?: MessageValues): string => translator(locale)(message, values)

/** Record results use only the supplied authorized read models and an available destination. */
export function commandPaletteEntries(surface: CommandPaletteSurface, locale: Locale, visibility?: VisibilityContext, catalog?: readonly CatalogTool[], records: CommandPaletteRecords = {}): CommandPaletteEntry[] {
  if (surface === 'login' || !visibility) return []
  const nav = visibleNavigation(visibility, catalog).find(item => item.surface === surface)
  const entries: CommandPaletteEntry[] = (nav?.sections ?? []).flatMap(section => section.pages.map(page => {
    const label = getSurfaceNavigationLabel(surface, 'page', page, locale)
    const group = getSurfaceNavigationLabel(surface, 'section', section, locale)
    return { key: `page:${page.route}`, kind: actionRoutes.has(page.route) ? 'action' as const : 'page' as const,
      label, section: group, route: page.route, href: page.route, hint: page.route,
      search: [label, group, page.route, ...page.keywords, ...catalogKeywords(locale, catalogKeys.pageKeywords(surface, page.id))].join(' '), persistable: true }
  }))
  if (surface === 'xmail') return entries
  const paths = new Set(entries.map(item => item.route))
  const principal = visibility.principal
  const mayReadAccounts = principal.kind === 'root' || principal.kind === 'user'
    || (principal.kind === 'reseller' && visibility.reseller?.acl.includes('list-accounts') === true)
  const accounts = mayReadAccounts ? (records.accounts ?? []).filter(account => canSeeAccount(principal, account)) : []
  const accountPath = surface === 'xwhm' ? '/whm/accounts' : '/home'
  const accountReady = paths.has(accountPath)
  if (accountReady) {
    for (const account of accounts) entries.push({ key: `account:${account.username}`, kind: 'account', label: account.username,
      section: text(locale, 'Accounts'), route: accountPath,
      href: principal.kind === 'user' ? accountPath : `${accountPath}?${new URLSearchParams({ accountId: account.id })}`, hint: account.primaryDomain,
      search: `${account.username} ${account.primaryDomain}`, persistable: false })
  }
  const accountById = new Map(accounts.map(account => [account.id, account]))
  const domainPath = (surface === 'xwhm' ? ['/whm/domains', '/whm/dns'] : ['/domains', '/domains/zone-editor']).find(path => paths.has(path))
  if (domainPath) {
    for (const domain of records.domains ?? []) {
      const account = accountById.get(domain.accountId)
      if (!account || !canSeeAccount(principal, account)) continue
      entries.push({ key: `domain:${domain.name}:${account.username}`, kind: 'domain', label: domain.name,
        section: text(locale, 'Domains'), route: domainPath,
        href: principal.kind === 'user' ? domainPath : `${domainPath}?${new URLSearchParams({ accountId: account.id, domain: domain.name })}`, hint: account.username,
        search: `${domain.name} ${account.username}`, persistable: false })
    }
  }
  return entries
}

const star = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/></svg>'

export function renderCommandPaletteModal(surface: CommandPaletteSurface, locale: Locale, visibility?: VisibilityContext, catalog?: readonly CatalogTool[], records: CommandPaletteRecords = {}): string {
  const entries = commandPaletteEntries(surface, locale, visibility, catalog, records)
  const label = translator(locale)
  const groups: readonly [CommandPaletteKind, string][] = [['page', label('Tools')], ['action', label('Actions')], ['account', label('Accounts')], ['domain', label('Domains')]]
  const scopeButtons = [['all', label('All')], ['action', label('> Actions')], ['account', label('@ Accounts')], ['domain', label('# Domains')]].map(([kind, name]) => `<button type="button" class="xp-cmdk-scope" data-cmdk-scope="${kind}" aria-pressed="${kind === 'all'}">${escapeHtml(name!)}</button>`).join('')
  let index = 0
  const rows = groups.map(([kind, name]) => {
    const matches = entries.filter(entry => entry.kind === kind)
    if (!matches.length) return ''
    return `<li data-cmdk-group="${kind}" role="presentation" class="xp-cmdk-group"><span class="xp-cmdk-group__label">${escapeHtml(name)}</span><ul role="group" aria-label="${escapeHtml(name)}">${matches.map(item => {
      const id = `xp-cmdk-option-${index++}`
      const favorite = item.persistable ? `<button type="button" class="xp-cmdk-favorite" data-cmdk-favorite="${escapeHtml(item.route)}" aria-pressed="false" aria-label="${escapeHtml(label('Favorite page'))}: ${escapeHtml(item.label)}">${star}</button>` : ''
      return `<li data-cmdk-row role="presentation" class="xp-cmdk-row"><a id="${id}" href="${escapeHtml(item.href)}" class="xp-nav-item xp-cmdk-result" data-cmdk-item="${escapeHtml(item.route)}" data-cmdk-kind="${item.kind}" data-cmdk-key="${escapeHtml(item.key)}" data-cmdk-persistable="${item.persistable}" data-cmdk-search-text="${escapeHtml(normalizeAsciiDigits(item.search))}" role="option" aria-selected="false" tabindex="-1"><span class="xp-cmdk-result__copy"><strong>${escapeHtml(normalizeAsciiDigits(item.label))}</strong><span class="xp-cmdk-result__section">${escapeHtml(item.section)}</span></span><code class="xp-mono xp-cmdk-result__route"><bdi dir="ltr">${escapeHtml(normalizeAsciiDigits(item.hint))}</bdi></code></a>${favorite}</li>`
    }).join('')}</ul></li>`
  }).join('')
  return `<style>
.xp-cmdk-dialog{--xp-cmdk-panel-padding:var(--xp-space-card);padding:var(--xp-cmdk-panel-padding);display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}.xp-cmdk-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.xp-cmdk-header h2{margin:0;font-size:18px}.xp-cmdk-search{display:flex;flex-direction:column;gap:8px}.xp-cmdk-scopes{display:flex;flex-wrap:wrap;gap:8px}.xp-cmdk-scope{min-block-size:44px;padding:4px 12px;border:1px solid var(--xp-border-strong);border-radius:999px;background:var(--xp-bg-surface);color:var(--xp-text-secondary);font:inherit;cursor:pointer}.xp-cmdk-scope[aria-pressed="true"]{border-color:var(--xp-accent-border);background:var(--xp-accent-soft);color:var(--xp-accent)}.xp-cmdk-results,.xp-cmdk-group>ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}.xp-cmdk-results{max-block-size:min(360px,45dvh);overflow-y:auto;overscroll-behavior:contain;gap:16px}.xp-cmdk-group>ul{gap:4px}.xp-cmdk-group__label{display:block;padding:0 8px 8px;color:var(--xp-text-muted);font-size:var(--xp-type-caption);font-weight:600}.xp-cmdk-row{display:flex;align-items:center;gap:8px;min-inline-size:0}.xp-cmdk-row>.xp-cmdk-result{flex:1 1 auto;min-inline-size:0;display:flex;flex-wrap:wrap;gap:8px}.xp-cmdk-result__copy{display:flex;flex-direction:column;gap:4px;min-inline-size:0}.xp-cmdk-result__section{font-size:var(--xp-type-caption);color:var(--xp-text-muted)}.xp-cmdk-result__route{margin-inline-start:auto;overflow-wrap:anywhere}.xp-cmdk-favorite{display:inline-flex;align-items:center;justify-content:center;flex:none;min-inline-size:44px;min-block-size:44px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--xp-text-muted);cursor:pointer}.xp-cmdk-favorite[aria-pressed="true"]{color:var(--xp-status-warn-fg);background:var(--xp-status-warn-bg)}.xp-cmdk-favorite[aria-pressed="true"] svg{fill:currentColor}.xp-cmdk-history{display:grid;gap:16px}.xp-cmdk-history-section{display:flex;flex-direction:column;gap:8px}.xp-cmdk-history-section>strong{font-size:var(--xp-type-caption);color:var(--xp-text-muted)}.xp-cmdk-history-links{display:flex;flex-wrap:wrap;gap:8px}.xp-cmdk-history-links>a{display:inline-flex;align-items:center;min-block-size:44px;padding:4px 12px;border:1px solid var(--xp-border);border-radius:8px;color:var(--xp-text-primary);text-decoration:none}.xp-cmdk-footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;color:var(--xp-text-muted);font-size:var(--xp-type-caption)}.xp-cmdk-footer p{margin:0}.xp-cmdk-footer kbd{font:inherit;font-family:var(--xp-font-mono)}#xp-cmdk-modal [hidden]{display:none!important}
@media(max-width:600px){.xp-cmdk-dialog{--xp-cmdk-panel-padding:var(--xp-space-field)}}
@media(max-width:959px){.xp-cmdk-result__route{flex-basis:100%;margin-inline-start:0;direction:inherit;text-align:start}}
</style><div id="xp-cmdk-modal" class="xp-modal-backdrop" data-xp-cmdk="true" data-cmdk-surface="${surface === 'login' ? 'xpanel' : surface}" hidden role="dialog" aria-modal="true" aria-labelledby="xp-cmdk-title"><div class="xp-cmdk-dialog"><div class="xp-cmdk-header"><h2 id="xp-cmdk-title">${label('Quick bar')}</h2><button type="button" class="xp-btn" data-action="close-cmdk">${label('Close')}</button></div><div class="xp-cmdk-search"><label class="xp-sr-only" for="xp-cmdk-input">${label('Search tools, accounts and domains')}</label><input id="xp-cmdk-input" type="search" class="xp-input" data-xp-filter-input="true" data-cmdk-search="true" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="xp-cmdk-results" autocomplete="off" maxlength="160" placeholder="${label('Search tools, @account, #domain or >action')}"/></div><div class="xp-cmdk-scopes" role="group" aria-label="${label('Search scope')}">${scopeButtons}</div><div class="xp-cmdk-history" data-cmdk-history hidden><div class="xp-cmdk-history-section" data-cmdk-favorites-section hidden><strong>${label('Favorites')}</strong><div class="xp-cmdk-history-links" data-cmdk-favorites></div></div><div class="xp-cmdk-history-section" data-cmdk-recents-section hidden><strong>${label('Recent pages')}</strong><div class="xp-cmdk-history-links" data-cmdk-recents></div></div></div><ul id="xp-cmdk-results" class="xp-cmdk-results" data-cmdk-results role="listbox" aria-label="${label('Results')}">${rows}</ul><p data-cmdk-empty role="status" style="margin:0"${entries.length ? ' hidden' : ''}>${label('No matching pages.')}</p><div class="xp-cmdk-footer"><p><kbd>↑ ↓</kbd> ${label('move')} · <kbd>Enter</kbd> ${label('open')} · <kbd>Ctrl Enter</kbd> ${label('new tab')}</p><p data-cmdk-status aria-live="polite" aria-atomic="true" data-count-label="${label('Results')}"></p></div></div></div>`
}
