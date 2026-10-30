import { alternateLocales } from '../../../i18n.ts'
import { projectActionState } from '../../../models/action-state.ts'
import type { UiTheme } from '../../contract.ts'
import { actionState } from '../components/action-state.ts'
import { notice } from '../components/notice.ts'
import { escapeHtml } from '../html.ts'
import { v2Messages } from '../messages.ts'
import { renderV2MailCompose } from '../pages/xmail/compose.ts'
import { renderV2MailInbox } from '../pages/xmail/inbox.ts'
import { renderV2MailSidebar } from '../pages/xmail/navigation.ts'
import { renderV2MailWorkspace } from '../pages/xmail/workspaces/index.ts'
import type { V2MailProjector } from '../pages/xmail/types.ts'
import { renderV2Shell } from '../shell/shell.ts'
import { V2_SECURITY_SLOT } from './slots.ts'

export { V2_MAIL_CSS } from '../pages/xmail/styles.ts'
export type { V2MailProjector, V2MailView, V2MailSurfaceView, MailInboxView, MailComposeView, MailWorkspaceView } from '../pages/xmail/types.ts'

/** Core owns the projector, including admission, mailbox authority, catalog and saved-data read states. */
export function createV2MailSurface(project: V2MailProjector, unavailable: UiTheme['renderMail']): UiTheme['renderMail'] {
  return props => {
    const view = project(props)
    if (view === undefined) return unavailable(props)
    const locale = props.locale ?? 'en'
    const t = v2Messages.translator(locale)
    const scheme = props.theme ?? 'light'
    const query = (changes: Record<string, string>): string => {
      const values = new URLSearchParams({ lang: locale, theme: scheme, ...(view.kind === 'inbox' ? { folder: view.folder } : view.kind === 'workspace' && view.route === '/mail/search' ? { folder: view.activeFolder } : {}), ...changes })
      return view.route + '?' + values.toString()
    }
    const breadcrumb = view.kind === 'workspace' ? '' : `<nav class="v2-crumbs" aria-label="${escapeHtml(t('Breadcrumb'))}"><ol><li><a href="/mail/inbox">xMail</a></li><li><span aria-current="page">${escapeHtml(view.title)}</span></li></ol><code dir="ltr">${escapeHtml(view.route)}</code></nav>`
    const content = view.kind === 'inbox' ? renderV2MailInbox(t, view) : view.kind === 'compose' ? renderV2MailCompose(t, view)
      : renderV2MailWorkspace({ ...view, locale, ...(view.route === '/mail/settings/security' ? { securityHtml: V2_SECURITY_SLOT } : {}) })
    if (content === undefined) throw new Error('v2_mail_workspace_renderer_missing')
    const announcement = (view.actionState ? actionState(projectActionState({ ...view.actionState, locale })) : '') + (view.notice ? notice(t, { tone: view.notice.tone, ...(view.notice.title ? { lead: view.notice.title } : {}), text: view.notice.text, urgent: view.notice.tone === 'bad' }) : '')
    const searchHref = view.searchHref ? `${view.searchHref}?${new URLSearchParams({ lang: locale, theme: scheme })}` : undefined
    return renderV2Shell(t, {
      surface: 'xmail', activeRoute: view.route, homeHref: '/mail/inbox',
      ...(props.visibility ? { visibility: props.visibility } : {}), ...(props.catalog ? { catalog: props.catalog } : {}),
      ...(props.branding ? { branding: props.branding } : {}),
      context: { label: t('Mailbox'), title: view.mailbox },
      sidebarHtml: renderV2MailSidebar(t, view, props),
      ...(searchHref ? { searchHtml: `<a class="v2-btn v2-mail-search" href="${escapeHtml(searchHref)}">${escapeHtml(t('Search mail'))}</a>` } : {}),
      realtimeEnabled: props.realtimeEnabled === true,
      languages: alternateLocales(locale).map(info => ({ tag: info.tag, href: query({ lang: info.tag }) })),
      scheme: { current: scheme, toggleHref: query({ theme: scheme === 'dark' ? 'light' : 'dark' }) },
      account: { signedIn: true, username: view.mailbox, ...(view.securityHref ? { securityHref: view.securityHref } : {}) },
      contentHtml: breadcrumb + announcement + content,
    })
  }
}
