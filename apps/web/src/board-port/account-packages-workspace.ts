import { renderPerlModulesCard } from './account-owner-tools-cards.ts'
import { type Locale, localeDirection } from '../i18n.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'
import { renderToolCard } from './tool-card-view.ts'
import { pearPackagesCard } from '../models/tool-cards.ts'

/** PEAR for the account owner, then the Perl modules of the same Software group. */
export function renderAccountPackagesWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  return `<div class="xp-acct-tool" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}${renderToolCard({ locale: input.lang, canManage: input.canManage }, pearPackagesCard(input.accountId))}${renderPerlModulesCard(input.lang)}</div>`
}
