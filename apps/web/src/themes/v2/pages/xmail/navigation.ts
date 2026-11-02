import { visibleNavigation } from '@xpanel/catalog'
import { catalogText, type Translate } from '../../../../i18n.ts'
import type { MailSurfaceProps } from '../../../contract.ts'
import { escapeHtml } from '../../html.ts'
import { icon } from '../../icons.ts'
import { mailIcon } from './icons.ts'
import type { MailFolderFacts, MailPageFacts } from './types.ts'

function folder(item: MailFolderFacts): string {
  const label = `<span>${escapeHtml(item.label)}</span>${item.count === undefined ? '' : `<span class="v2-num" data-mail-count="${escapeHtml(item.id)}">${item.count}</span>`}`
  const attrs = ` data-mail-folder="${escapeHtml(item.id)}"${item.current ? ' aria-current="page"' : ''}`
  return `<li>${item.href ? `<a class="v2-mail-folder" href="${escapeHtml(item.href)}" data-nav-route="${escapeHtml(item.href)}"${attrs}>${icon('folder')}${label}</a>` : `<span class="v2-mail-folder"${attrs}>${icon('folder')}${label}</span>`}</li>`
}

/** Only core-qualified folder links are interactive; observed names alone never grant folder access. */
export function renderV2MailSidebar(t: Translate, view: MailPageFacts, access: Pick<MailSurfaceProps, 'visibility' | 'catalog'>): string {
  const compose = view.canCompose ? `<a class="v2-btn v2-btn--primary" href="/mail/compose" data-nav-route="/mail/compose"${view.route === '/mail/compose' ? ' aria-current="page"' : ''}>${mailIcon('compose')}${escapeHtml(t('Compose'))}</a>` : ''
  const manage = view.folderManageHref ? `<a class="v2-btn v2-btn--ghost" href="${escapeHtml(view.folderManageHref)}">${escapeHtml(t('Manage'))}</a>` : ''
  const quota = view.quota.percent === null ? '' : `<div class="v2-mail-storage__track" role="meter" aria-label="${escapeHtml(t('Mailbox quota'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0, Math.min(100, view.quota.percent))}"><span style="inline-size:${Math.max(0, Math.min(100, view.quota.percent))}%"></span></div>`
  const folderRoutes = new Set(['/mail/inbox', '/mail/compose', ...view.folders.flatMap(item => item.href ? [item.href] : [])])
  const nav = visibleNavigation(access.visibility, access.catalog).find(item => item.surface === 'xmail')
  const tools = (nav?.sections ?? []).map(group => {
    const pages = group.pages.filter(page => !folderRoutes.has(page.route))
    if (!pages.length) return ''
    const label = catalogText(t.locale, `nav.section.xmail.${group.id}.name`, group.name)
    return `<details${pages.some(page => page.route === view.route) ? ' open' : ''}><summary>${escapeHtml(label)}${icon('chevRight', 14)}</summary><ul>${pages.map(page => `<li><a class="v2-mail-folder" href="${escapeHtml(page.route)}" data-nav-route="${escapeHtml(page.route)}"${page.route === view.route ? ' aria-current="page"' : ''}>${escapeHtml(catalogText(t.locale, `nav.page.xmail.${page.id}.name`, page.name))}</a></li>`).join('')}</ul></details>`
  }).join('')
  return `<div class="v2-mail-navigation">${compose}<ul aria-label="${escapeHtml(t('Mail folders'))}">${view.folders.map(folder).join('')}</ul><section aria-labelledby="v2-mail-custom-title"><div class="v2-mail-navigation__head"><h2 id="v2-mail-custom-title">${escapeHtml(t('Your folders'))}</h2>${manage}</div><ul>${view.customFolders.map(folder).join('')}</ul></section><nav class="v2-mail-tools" aria-label="${escapeHtml(t('Mail tools'))}">${tools}</nav><section class="v2-mail-storage" data-mail-quota aria-labelledby="v2-mail-storage-title"><h2 id="v2-mail-storage-title" data-mail-quota-label>${escapeHtml(t('Mailbox quota'))}</h2><bdi class="v2-num" dir="ltr" data-mail-quota-value>${escapeHtml(view.quota.text)}</bdi>${quota}</section></div>`
}
