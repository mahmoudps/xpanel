import { join } from 'node:path'
import type { Account, Reseller, ServerSettings } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'

interface SavedTemplate { id: string; planIds: string[]; defaultPage: { title: string; body: string }; suspendedPage: { title: string; body: string } }
type SavedPages = Partial<Record<edge.AccountPageKind, { html: string }>>
export interface AccountPages { scopes: edge.AccountPageScope[]; scopeOf: ReadonlyMap<string, string> }

const read = async (path: string): Promise<unknown> => { try { return await readJsonIfExists<unknown>(path) } catch { return null } }
const savedPages = (raw: unknown): SavedPages => {
  const value = raw && typeof raw === 'object' ? raw as Record<string, { html?: unknown }> : {}
  return Object.fromEntries(edge.ACCOUNT_PAGE_KINDS.flatMap(kind => typeof value[kind]?.html === 'string' && Buffer.byteLength(value[kind].html as string) <= edge.ACCOUNT_PAGE_MAX_BYTES ? [[kind, { html: value[kind].html as string }]] : []))
}
const savedTemplates = (raw: unknown): SavedTemplate[] => Array.isArray(raw) ? raw.filter((item): item is SavedTemplate => !!item && typeof item === 'object' && typeof item.id === 'string' && Array.isArray(item.planIds) && !!item.defaultPage && !!item.suspendedPage) : []

/** Page text of a plan template wins, then the owner's Web Template Editor pages, then root's, then the shipped page. */
export function resolveAccountPages(input: { accounts: readonly Pick<Account, 'id' | 'planId' | 'ownerId'>[]; resellers: readonly Pick<Reseller, 'id' | 'contactEmail'>[]; adminEmail: string; root: SavedPages; byReseller: ReadonlyMap<string, SavedPages>; templates: readonly SavedTemplate[] }): AccountPages {
  const pages = (owner: string | null, template: SavedTemplate | null): edge.AccountPageScope['pages'] => {
    const reseller = owner === null ? null : input.resellers.find(item => item.id === owner), contact = reseller?.contactEmail || input.adminEmail
    const pick = (kind: edge.AccountPageKind): string => {
      const text = template && (kind === 'default' ? template.defaultPage : template.suspendedPage)
      if (text && (text.title || text.body)) return edge.textAccountPage(text.title, text.body)
      return edge.renderAccountPage((owner !== null ? input.byReseller.get(owner)?.[kind]?.html : undefined) ?? input.root[kind]?.html ?? edge.SHIPPED_ACCOUNT_PAGES[kind], contact)
    }
    return { default: pick('default'), suspended: pick('suspended') }
  }
  const scopes = new Map<string, edge.AccountPageScope>([['', { scope: '', pages: pages(null, null) }]]), scopeOf = new Map<string, string>()
  for (const account of input.accounts) {
    const owner = account.ownerId !== null && input.byReseller.has(account.ownerId) ? account.ownerId : null
    const template = input.templates.find(item => item.planIds.includes(account.planId)) ?? null
    const scope = template ? `t-${template.id}${owner ? '-' + owner : ''}` : owner ? `r-${owner}` : ''
    if (!scopes.has(scope)) scopes.set(scope, { scope, pages: pages(owner, template) })
    scopeOf.set(account.id, scope)
  }
  return { scopes: [...scopes.values()], scopeOf }
}

export async function readAccountPages(stateRoot: string, snapshot: { accounts: readonly Pick<Account, 'id' | 'planId' | 'ownerId'>[]; resellers: readonly Pick<Reseller, 'id' | 'contactEmail'>[]; settings: Pick<ServerSettings, 'adminEmail'> }): Promise<AccountPages> {
  const dir = join(stateRoot, 'extended', 'accounts')
  const byReseller = new Map<string, SavedPages>()
  for (const reseller of snapshot.resellers) { const saved = savedPages(await read(join(dir, 'web-templates', reseller.id + '.json'))); if (Object.keys(saved).length) byReseller.set(reseller.id, saved) }
  return resolveAccountPages({ accounts: snapshot.accounts, resellers: snapshot.resellers, adminEmail: snapshot.settings.adminEmail, root: savedPages(await read(join(dir, 'web-templates', 'root.json'))), byReseller, templates: savedTemplates(await read(join(dir, 'templates.json'))) })
}
