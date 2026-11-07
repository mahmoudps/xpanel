// Pages and paths the edge answers for an account site without opening its home.
import { fail } from '@xpanel/core'
import type { HostAction, RenderedFile } from '@xpanel/core'
import { block } from './nginx-syntax.ts'
import { XP_PATHS } from './paths.ts'
import { nginxQuote } from './quote.ts'
import { invalid } from './validate.ts'

/** A panel path on account sites and the public origin of that panel. */
export interface PanelRedirect {
  path: '/whm' | '/xpanel' | '/webmail'
  origin: string
}

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/

/** cPanel's /whm, /cpanel and /webmail paths: the panels answer only on their own public host, so that is the target. */
export const panelRedirectLocations = (redirects: readonly PanelRedirect[] = []): string[] => redirects.flatMap(({ path, origin }) => {
  if (!ORIGIN_RE.test(origin)) return invalid('panel redirect origin', origin, 'must be an https origin')
  return block(`location = ${path}`, [`return 302 ${nginxQuote(`${origin}/`)};`])
})

export type AccountPageKind = 'default' | 'suspended'
export const ACCOUNT_PAGE_KINDS: readonly AccountPageKind[] = ['default', 'suspended']
export const ACCOUNT_PAGE_MAX_BYTES = 64 * 1024
/** URL path of the page set inside an account site, outside its document root. */
export const ACCOUNT_PAGE_ALIAS = '/.xpanel-page'
const SCOPE_RE = /^[a-z0-9][a-z0-9-]{0,99}$/

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const frame = (title: string, body: string): string => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + title
  + '</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:48px 24px;color:#1c2733}main{max-width:640px;margin:0 auto}</style></head><body><main><h1>' + title + '</h1>' + body + '</main></body></html>\n'

/** The pages the server ships; %contact% is the owner's public contact address. */
export const SHIPPED_ACCOUNT_PAGES: Readonly<Record<AccountPageKind, string>> = {
  default: frame('Default web site page', '<p>This site has not published any content yet. If you own it, upload your files to public_html.</p><p>Hosting contact: %contact%</p>'),
  suspended: frame('This account has been suspended', '<p>Contact your hosting provider for more information.</p><p>Hosting contact: %contact%</p>'),
}

/** A saved plain-text page in the shipped frame. */
export const textAccountPage = (title: string, body: string): string =>
  frame(escapeText(title), escapeText(body).split('\n').map(line => `<p>${line}</p>`).join(''))

export const renderAccountPage = (template: string, contact: string): string => template.replaceAll('%contact%', escapeText(contact))

/** Where one scope's page lives; the empty scope is the server's own set at the top of each directory. */
export const accountPageDir = (kind: AccountPageKind, scope = ''): string => {
  if (scope !== '' && !SCOPE_RE.test(scope)) return fail('VALIDATION', 'invalid account page scope', { scope })
  const base = kind === 'default' ? XP_PATHS.defaultSiteDir : XP_PATHS.suspendedDir
  return scope ? `${base}/${scope}` : base
}

export interface AccountPageScope { scope: string; pages: Readonly<Record<AccountPageKind, string>> }

/** Root-owned files outside every home: nothing here is writable by an account or its web server identity. */
export const accountPageFiles = (scopes: readonly AccountPageScope[]): { files: RenderedFile[]; dirs: HostAction[] } => ({
  dirs: scopes.filter(item => item.scope).flatMap(item => ACCOUNT_PAGE_KINDS.map((kind): HostAction => ({ kind: 'ensure-dir', path: accountPageDir(kind, item.scope), mode: 0o755, owner: 'root', group: 'root' }))),
  files: scopes.flatMap(item => ACCOUNT_PAGE_KINDS.map((kind): RenderedFile => ({ path: `${accountPageDir(kind, item.scope)}/index.html`, content: item.pages[kind], mode: 0o644, owner: 'root', group: 'root' }))),
})
