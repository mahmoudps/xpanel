import { tools as defaultCatalog, visibleNavigation, visibleTools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { renderMailTrackDelivery } from '../board-port/xmail-track-delivery.ts'
import { renderMailFolders } from '../board-port/xmail-folders.ts'
import { renderMailDiskUsage } from '../board-port/xmail-disk-usage.ts'
import { renderMailConnectDevices } from '../board-port/xmail-connect-devices.ts'
import { renderMailForwarders } from '../board-port/xmail-mailbox-forwarders.ts'
import { renderMailPreferences } from '../board-port/xmail-mailbox-preferences.ts'
import { renderMailTools } from '../board-port/xmail-tools.ts'
import { renderMailSpam } from '../board-port/xmail-spam.ts'
import { renderMailMailingLists } from '../board-port/xmail-mailing-lists.ts'
import {
  type AsyncActionBannerProps, ensureAccessibleSurfaceHtml, escapeHtml, formatAsciiDate,
  renderAsyncActionState, renderStatusBadge, renderThresholdMeter,
} from '../tokens.ts'
import { accountSecurityRoute, renderSecurityNavLink } from '../chrome.ts'
import {
  getSurfaceNavigationLabel, getSurfacePageTitle, hasRoutePageTitle, normalizeSurfaceRoute,
  renderLiveUpdatesIndicator, renderPageSearchButton, renderMobileNavBackdrop, renderMobileNavClose,
  renderMobileNavToggle, renderSurfaceUnavailable, renderUnavailableSurfaceShell,
  resolveSurfaceSection,
} from '../shell.ts'
import { renderXmailCompose, xmailComposeFromProps } from '../board-port/xmail-compose.ts'
import { renderXmailInbox, xmailInboxFromProps } from '../board-port/xmail-inbox.ts'
import { renderMailContactsWorkspace } from '../board-port/xmail-contacts.ts'
import { renderMailContactsTools } from '../board-port/xmail-contacts-tools.ts'
import { renderMailIdentitiesWorkspace } from '../board-port/xmail-identities.ts'
import { renderMailVacationWorkspace } from '../board-port/xmail-vacation.ts'
import { renderMailSearchWorkspace } from '../board-port/xmail-search.ts'
import { renderMailCalendarWorkspace } from '../board-port/xmail-calendar.ts'
import { renderMailCalendarView } from '../board-port/xmail-calendar-view.ts'
import { renderMailAttachments } from '../board-port/xmail-attachments.ts'
import { alternateLocales, localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
export interface MailMessageItem {
  uid: number
  folder: string
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  attachments?: Array<{ name: string; sizeBytes: number }>
  preview: string
  body: string
  receivedAt: string
  sizeKb?: number
  unread: boolean
  /** Absent when the message was not authenticated by this server. */
  dkimPass?: boolean
  spfPass?: boolean
  dmarcPass?: boolean
  /** True when the body was not part of this response and must be read by UID. */
  bodyPending?: boolean
}

export interface SieveFilterRule {
  id: string
  name: string
  condition: string
  action: string
  enabled: boolean
}

export interface MailSurfaceProps {
  visibility?: VisibilityContext
  catalog?: readonly CatalogTool[]
  locale?: Locale
  theme?: 'dark' | 'light'
  realtimeEnabled?: boolean
  mailbox?: string
  domain?: string
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: number | 'unlimited'
  activeRoute?: string
  activeFolder?: string
  selectedUid?: number
  generationId?: number
  messages?: MailMessageItem[]
  sieveRules?: SieveFilterRule[]
  vacationEnabled?: boolean
  /** The IMAP list was attempted and failed. Distinct from an empty folder. */
  mailListFailed?: boolean
  /** Stored DKIM selector sentence. Absent when no email-auth file exists. */
  identityDkim?: string
  /** Stored SPF and DMARC sentence. Absent when no email-auth file exists. */
  identitySpf?: string
  /** Saved message size limit, labelled by the caller. Absent when settings were never saved. */
  identitySize?: string
  folderCounts?: Array<{ folder: string; total: number; unread: number }>
  composeDraft?: { to: string; cc: string; subject: string; body: string }
  actionState?: AsyncActionBannerProps
}


const icon = (path: string): string => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`
const icons = {
  compose: icon('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'),
  inbox: icon('M4 4h16v16H4zM4 14h4l2 3h4l2-3h4'),
  folder: icon('M3 6h6l2 2h10v11H3z'),
  send: icon('M22 2L11 13M22 2l-7 20-4-9-9-4z'),
}

export const renderMailSurface = (props: MailSurfaceProps = {}): string => {
  const locale = props.locale ?? 'en'
  const rtl = localeDirection(locale) === 'rtl'
  const text = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const theme = props.theme ?? 'dark'
  const mailbox = props.mailbox
  if (!mailbox) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xmail', locale), locale)
  const activeRoute = normalizeSurfaceRoute('xmail', props.activeRoute ?? '/mail/inbox')
  const section = resolveSurfaceSection('xmail', activeRoute)
  const routeFolder = ({ '/mail/sent': 'Sent', '/mail/drafts': 'Drafts', '/mail/trash': 'Trash' } as Record<string, string | undefined>)[activeRoute]
  const activeFolder = routeFolder ?? props.activeFolder ?? 'INBOX'
  const folderWorkspace = (activeRoute === '/mail/inbox' || routeFolder !== undefined) && ['INBOX', 'Sent', 'Drafts', 'Trash'].includes(activeFolder)
  const allMessages = (props.messages ?? []).filter(message => Number.isSafeInteger(message.uid) && message.uid > 0)
  const messages = allMessages.filter(message => message.folder === activeFolder)
  const selectedMessage = messages.find(message => message.uid === props.selectedUid) ?? messages[0]
  const quota = props.quotaUsedMb !== undefined || props.quotaLimitMb !== undefined
    ? renderThresholdMeter(props.quotaUsedMb, props.quotaLimitMb, { unit: 'MiB', locale, label: text('Mailbox quota') })
    : ''
  const xmailNav = visibleNavigation(props.visibility, props.catalog).find(nav => nav.surface === 'xmail')
  const titlePage = xmailNav?.sections.flatMap(group => group.pages).find(page => page.route === activeRoute)
  // An explicit route title names the implemented page, matching its unavailable rendering.
  const pageTitle = titlePage && !hasRoutePageTitle(activeRoute) ? getSurfaceNavigationLabel('xmail', 'page', titlePage, locale) : getSurfacePageTitle('xmail', section, locale, activeRoute)
  const qualifiedMailRoutes = new Set((xmailNav?.sections ?? []).flatMap(group => group.pages.map(page => page.route)))
  const visibleMailToolIds = new Set(props.visibility === undefined ? [] : visibleTools(props.catalog ?? defaultCatalog, props.visibility).filter(tool => tool.surface === 'xmail').map(tool => tool.id))
  const canSearchMailbox = visibleMailToolIds.has('webmail-search')
  const attachmentReadEnabled = visibleMailToolIds.has('webmail-message-read') && visibleMailToolIds.has('webmail-attachments')
  const navSectionsHtml = (xmailNav?.sections ?? []).map(navSection => `
    <details class="xp-nav-section xp-mail-nav-section" ${navSection.pages.some(page => page.route === activeRoute) ? 'open' : ''} data-nav-section="${escapeHtml(navSection.id)}">
      <summary class="xp-nav-section__title">${escapeHtml(getSurfaceNavigationLabel('xmail', 'section', navSection, locale))}</summary>
      <div class="xp-nav-section__items">${navSection.pages.map(page => {
        const current = page.route === activeRoute
        const compose = page.route === '/mail/compose'
        const unread = page.route === '/mail/inbox' ? allMessages.filter(message => message.folder === 'INBOX' && message.unread).length : 0
        return `<a href="${escapeHtml(page.route)}" class="xp-nav-item ${current ? 'xp-nav-item--active' : ''} ${compose ? 'xp-mail-compose-link' : ''}" ${current ? 'aria-current="page"' : ''} data-nav-route="${escapeHtml(page.route)}">${compose ? icons.compose : page.route === '/mail/inbox' ? icons.inbox : icons.folder}<span>${escapeHtml(getSurfaceNavigationLabel('xmail', 'page', page, locale))}</span>${unread ? `<span class="xp-mail-count xp-tabular" aria-label="${escapeHtml(text(msgctxt('xmail', 'Unread')))}">${unread}</span>` : ''}</a>`
      }).join('')}</div>
    </details>`).join('')
  // Folder observations do not grant a working folder-selection or mutation endpoint.
  const observedFolders = [...new Set(allMessages.map(message => message.folder))].filter(folder => folder !== 'INBOX')
  const observedFolderHtml = observedFolders.length ? `<section class="xp-mail-nav-section" aria-labelledby="mail-observed-folders"><h2 id="mail-observed-folders" class="xp-label">${text('Folders')}</h2><ul class="xp-mail-observed-folders">${observedFolders.map(folder => `<li data-mail-folder="${escapeHtml(folder)}">${icons.folder}<span>${escapeHtml(folder)}</span></li>`).join('')}</ul></section>` : ''
  const actionBanner = props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : ''

  if (section === 'inbox' || routeFolder !== undefined) {
    return ensureAccessibleSurfaceHtml(renderXmailInbox(xmailInboxFromProps({
      locale,
      theme,
      mailbox,
      ...(props.quotaUsedMb !== undefined ? { quotaUsedMb: props.quotaUsedMb } : {}),
      ...(props.quotaUsedBytes !== undefined ? { quotaUsedBytes: props.quotaUsedBytes } : {}),
      ...(props.quotaLimitMb !== undefined ? { quotaLimitMb: props.quotaLimitMb } : {}),
      activeFolder,
      folderWorkspace,
      attachmentReadEnabled,
      ...(props.selectedUid !== undefined ? { selectedUid: props.selectedUid } : {}),
      ...(props.messages !== undefined && (routeFolder === undefined || props.activeFolder === activeFolder) ? { messages: allMessages } : {}),
      realtimeEnabled: props.realtimeEnabled === true,
      ...(props.actionState ? { actionState: props.actionState } : {}),
      ...(props.mailListFailed ? { mailListFailed: true } : {}),
      ...(props.vacationEnabled !== undefined ? { vacationEnabled: props.vacationEnabled } : {}),
      ...(props.sieveRules ? { sieveCount: props.sieveRules.filter(rule => rule.enabled).length } : {}),
      ...(props.folderCounts ? { folderCounts: props.folderCounts } : {}),
    })), locale)
  }

  if (section === 'compose') {
    return ensureAccessibleSurfaceHtml(renderXmailCompose(xmailComposeFromProps({
      locale,
      theme,
      mailbox,
      canSend: qualifiedMailRoutes.has('/mail/compose'),
      canSaveDraft: qualifiedMailRoutes.has('/mail/compose'),
      ...(props.quotaUsedMb !== undefined ? { quotaUsedMb: props.quotaUsedMb } : {}),
      ...(props.quotaUsedBytes !== undefined ? { quotaUsedBytes: props.quotaUsedBytes } : {}),
      ...(props.quotaLimitMb !== undefined ? { quotaLimitMb: props.quotaLimitMb } : {}),
      ...(props.messages !== undefined ? { messages: allMessages } : {}),
      realtimeEnabled: props.realtimeEnabled === true,
      ...(props.actionState ? { actionState: props.actionState } : {}),
      ...(props.vacationEnabled !== undefined ? { vacationEnabled: props.vacationEnabled } : {}),
      vacationCanManage: mailbox.length > 0,
      ...(props.sieveRules ? { sieveRules: props.sieveRules.map(rule => ({ name: rule.name, condition: rule.condition, action: rule.action, enabled: rule.enabled })) } : {}),
      ...(props.identityDkim ? { identityDkim: props.identityDkim } : {}),
      ...(props.identitySpf ? { identitySpf: props.identitySpf } : {}),
      ...(props.identitySize ? { identitySize: props.identitySize } : {}),
      ...(props.folderCounts ? { folderCounts: props.folderCounts } : {}),
      ...(props.composeDraft ? { draft: props.composeDraft } : {}),
    })), locale)
  }
  const field = (label: string, value: string): string => `<div class="xp-mail-field"><dt class="xp-label">${escapeHtml(label)}</dt><dd><bdi dir="ltr">${escapeHtml(value)}</bdi></dd></div>`

  const listHtml = `<section class="xp-mail-messages" data-mail-pane="message-list" aria-labelledby="mail-list-heading">
    <div class="xp-mail-pane-heading"><h1 id="mail-list-heading" class="xp-page-title">${escapeHtml(activeFolder === 'INBOX' ? pageTitle : activeFolder)}</h1><span class="xp-help xp-tabular">${messages.length} ${text(msgctxt('xmail', 'messages'))}</span></div>
    <div class="xp-mail-list" role="list" data-live-mail-list="true">${messages.map(message => `
      <article role="listitem" class="xp-mail-row ${message.uid === selectedMessage?.uid ? 'is-selected' : ''} ${message.unread ? 'is-unread' : ''}" data-mail-uid="${message.uid}">
        <span class="xp-mail-read-mark" aria-label="${(message.unread ? text(msgctxt('xmail', 'Unread')) : text(msgctxt('xmail', 'Read')))}"></span>
        <div class="xp-mail-row-content"><strong class="xp-mail-sender"><bdi dir="ltr">${escapeHtml(message.from)}</bdi></strong><span class="xp-mail-subject">${escapeHtml(message.subject)}</span><p class="xp-mail-preview">${escapeHtml(message.preview)}</p><time datetime="${escapeHtml(message.receivedAt)}" class="xp-mail-time xp-tabular"><bdi dir="ltr">${escapeHtml(formatAsciiDate(message.receivedAt, { includeTime: true }))}</bdi></time></div>
      </article>`).join('')}${messages.length ? '' : `<p class="xp-mail-empty" role="status">${text('No messages in this folder.')}</p>`}</div>
  </section>`
  const readingHtml = selectedMessage ? `<article class="xp-mail-reader" data-mail-pane="reading-pane" aria-labelledby="mail-reading-heading">
    <header class="xp-mail-message-heading"><h2 id="mail-reading-heading">${escapeHtml(selectedMessage.subject)}</h2><dl class="xp-mail-message-meta">${field(text('From'), selectedMessage.from)}${field(text('To'), selectedMessage.to)}${field(text('Received'), formatAsciiDate(selectedMessage.receivedAt, { includeTime: true }))}</dl></header>
    <details class="xp-mail-auth-results"><summary>${text('Message authentication')}</summary><div>${renderStatusBadge(selectedMessage.dkimPass ? 'ok' : 'critical', selectedMessage.dkimPass ? 'DKIM: pass' : 'DKIM: fail')}${renderStatusBadge(selectedMessage.spfPass ? 'ok' : 'critical', selectedMessage.spfPass ? 'SPF: pass' : 'SPF: fail')}${renderStatusBadge(selectedMessage.dmarcPass ? 'ok' : 'critical', selectedMessage.dmarcPass ? 'DMARC: pass' : 'DMARC: fail')}</div></details>
    <div class="xp-mail-message-body" dir="auto">${escapeHtml(selectedMessage.body)}</div>
  </article>` : `<div class="xp-mail-reader xp-mail-empty" data-mail-pane="empty" role="status">${text('No message selected.')}</div>`

  const composeHtml = `<div class="xp-mail-compose-layout"><section class="xp-mail-editor" data-section="compose-drawer" aria-labelledby="compose-drawer-heading">
    <header class="xp-mail-editor-heading"><a href="/mail/inbox" class="xp-mail-back-link">${text('Inbox')}</a><h1 class="xp-page-title" id="compose-drawer-heading">${text('New message')}</h1></header>
    <div role="group" aria-labelledby="compose-drawer-heading" data-compose-form="true" class="xp-mail-compose-form" data-mail-send-availability="available">
      <div class="xp-mail-compose-fields"><div class="xp-mail-field"><label class="xp-label" for="compose-from">${text('From')}</label><input id="compose-from" name="from" type="email" class="xp-input xp-mono" dir="ltr" readonly value="${escapeHtml(mailbox)}" /></div><div class="xp-mail-field"><label class="xp-label" for="compose-to">${text('To')}</label><input id="compose-to" name="to" type="email" class="xp-input xp-mono" dir="ltr" required autocomplete="email" /></div><div class="xp-mail-field xp-mail-field--wide"><label class="xp-label" for="compose-subject">${text('Subject')}</label><input id="compose-subject" name="subject" type="text" dir="auto" class="xp-input" required /></div></div>
      <div class="xp-mail-field xp-mail-compose-body"><label class="xp-label" for="compose-body">${text('Message')}</label><textarea id="compose-body" name="body" rows="12" dir="auto" class="xp-textarea" required spellcheck="true"></textarea></div>
      <footer class="xp-mail-editor-actions"><span class="xp-help" id="mail-send-status" role="status">${text('Send through the local mail server.')}</span><button type="button" class="xp-btn xp-btn--primary" data-mail-send="true" aria-describedby="mail-send-status">${icons.send}${text('Send')}</button></footer>
    </div>
  </section><aside class="xp-mail-compose-aside" aria-labelledby="mail-sender-heading"><section class="xp-card"><h2 id="mail-sender-heading">${text('Sending as')}</h2><dl>${field(text('Address'), mailbox)}</dl></section>${quota ? `<section class="xp-card"><h2>${text('Mailbox quota')}</h2>${quota}</section>` : ''}</aside></div>`

  const sieveRules = props.sieveRules ?? []
  const filtersHtml = `<section class="xp-card" data-section="sieve-filters" aria-labelledby="sieve-rules-heading"><div class="xp-card__header" style="margin-block-end:var(--xp-space-group,24px)"><h2 id="sieve-rules-heading">${text('Filters')}</h2><span class="xp-help xp-tabular">${sieveRules.length} ${text('rules')}</span></div><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${text('Rule')}</th><th>${text('Condition')}</th><th>${text('Action')}</th><th>${text('Status')}</th></tr></thead><tbody>${sieveRules.map(rule => `<tr data-sieve-rule-id="${escapeHtml(rule.id)}"><td><strong>${escapeHtml(rule.name)}</strong></td><td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.condition)}</bdi></code></td><td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.action)}</bdi></code></td><td>${renderStatusBadge(rule.enabled ? 'ok' : 'suspended', rule.enabled ? text(msgctxt('xmail', 'Active')) : text('Paused'))}</td></tr>`).join('')}</tbody></table></div></section>`
  const mailboxCanManage = mailbox.length > 0
  const content = activeRoute === '/mail/later' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailTools({ locale, mailbox, canManage: mailbox.length > 0, searchAvailable: canSearchMailbox, attachmentsAvailable: attachmentReadEnabled, quotaAvailable: visibleMailToolIds.has('webmail-disk-cleanup') })}`
    : activeRoute === '/mail/settings/spam' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailSpam({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-spam-box') })}`
    : activeRoute === '/mail/tools/mailing-lists' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailMailingLists({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-mailing-lists') })}`
    : activeRoute === '/mail/search' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailSearchWorkspace({ locale, mailbox, available: canSearchMailbox, attachmentPanel: renderMailAttachments({ lang: locale, mailbox, canRead: canSearchMailbox && attachmentReadEnabled }) })}`
    : activeRoute === '/mail/settings/calendars' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailCalendarWorkspace({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) })}`
    : activeRoute === '/mail/calendar' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailCalendarView({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-calendar') })}`
    : activeRoute === '/mail/tools/track-delivery' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailTrackDelivery({ locale, mailbox, canRead: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-track-delivery') })}`
    : activeRoute === '/mail/folders' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailFolders({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-folders') })}`
    : activeRoute === '/mail/tools/disk-usage' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailDiskUsage({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-disk-cleanup') })}`
    : activeRoute === '/mail/tools/connect-devices' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailConnectDevices({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-mail-client-setup') })}`
    : activeRoute === '/mail/settings/forwarders' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailForwarders({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-forwarders') })}`
    : activeRoute === '/mail/settings/preferences' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>${renderMailPreferences({ locale, mailbox, canManage: qualifiedMailRoutes.has(activeRoute) && visibleMailToolIds.has('webmail-preferences') })}`
    : activeRoute === '/mail/contacts' ? `${section === undefined ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>` : ''}<div style="display:grid;gap:24px;min-inline-size:0">${renderMailContactsWorkspace({ locale, mailbox, canManage: mailbox.length > 0 })}${renderMailContactsTools({ locale, mailbox, canManage: mailbox.length > 0 })}</div>`
    : section === 'inbox' ? `<section class="xp-mail-tri-pane" data-mail-live="true" aria-label="${text('Mail workspace')}">${listHtml}${readingHtml}</section>`
    : section === 'compose' ? composeHtml
    : section === 'filters' ? filtersHtml
    : section === 'autoresponder' ? renderMailVacationWorkspace({ locale, mailbox, canManage: mailboxCanManage })
    : section === 'identities' ? renderMailIdentitiesWorkspace({ locale, mailbox, canManage: mailboxCanManage })
    : section === 'overview' ? `<section class="xp-card" data-section="mail-overview" style="display:grid;gap:var(--xp-space-group,24px)"><h2 style="margin:0">${text('Mailbox quota')}</h2>${quota || `<p role="status">${text(msgctxt('xmail', 'Unavailable'))}</p>`}</section>`
    : section === 'security' ? ''
    : renderSurfaceUnavailable(locale, '/mail/inbox')

  const contentHasPageHeading = /<h1\b/.test(content)
  const rawHtml = `<div class="xp-shell xp-mail-shell" data-surface="xmail" data-mail-layout="reference" data-mailbox="${escapeHtml(mailbox)}">
    <a class="xp-skip-link" href="#main-content">${text('Skip to content')}</a>
    <header class="xp-topbar xp-mail-topbar" role="banner">${renderMobileNavToggle(locale)}<a class="xp-mail-brand" href="/mail/inbox"><span class="xp-mail-brand-mark" aria-hidden="true">x</span><strong>xMail</strong></a><details class="xp-toolbar-options" open data-xp-toolbar-options><summary class="xp-btn">${text('Search & account')}</summary><div class="xp-toolbar-options__content"><div class="xp-topbar__start">${renderPageSearchButton(locale)}</div><div class="xp-topbar__end"><span class="xp-mail-account"><bdi dir="ltr">${escapeHtml(mailbox)}</bdi></span>${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}${alternateLocales(locale).map(info => `<a href="${escapeHtml(activeRoute)}?lang=${info.tag}&amp;theme=${theme}" class="xp-btn xp-btn--ghost" lang="${info.tag}" data-lang-switch="${info.tag}">${escapeHtml(info.nativeName)}</a>`).join('')}<a href="${escapeHtml(activeRoute)}?lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}" class="xp-btn xp-btn--ghost" data-theme-toggle="${theme === 'dark' ? 'light' : 'dark'}">${theme === 'dark' ? text(msgctxt('xmail', 'Light')) : text(msgctxt('xmail', 'Dark'))}</a><a class="xp-btn xp-btn--ghost" href="${escapeHtml(accountSecurityRoute('xmail'))}" data-security-link="true">${text('Security')}</a><button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${text('Sign out')}</button></div></div></details></header>
    <aside class="xp-sidebar xp-mail-folders" id="xp-sidebar" data-xp-sidebar data-mail-pane="folders" tabindex="-1" aria-label="${text('xMail navigation')}">${renderMobileNavClose(locale)}<nav aria-label="${text('Mail navigation')}">${navSectionsHtml || `<p class="xp-help" role="status" data-navigation-empty="true">${text('No verified tools are available for your account.')}</p>`}${renderSecurityNavLink('xmail', locale, activeRoute, (xmailNav?.sections ?? []).some(section => section.pages.some(page => page.route === accountSecurityRoute('xmail'))))}${observedFolderHtml}</nav>${quota && section !== 'compose' ? `<div class="xp-mail-sidebar-quota"><span class="xp-label">${text('Mailbox quota')}</span>${quota}</div>` : ''}</aside>${renderMobileNavBackdrop(locale)}
    <div class="xp-workspace" data-xp-shell-content><main id="main-content" class="xp-main xp-mail-main ${section === 'inbox' ? 'xp-mail-main--inbox' : ''}" role="main" tabindex="-1">${actionBanner}${section !== undefined && section !== 'inbox' && section !== 'compose' && !contentHasPageHeading ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>` : ''}${content}</main></div>
  </div>`
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}

/** Preserves the existing mailbox layout without accepting private mailbox data or active actions. */
export const renderUnavailableMailBody = (options: { route: string; locale: Locale; theme?: 'dark' | 'light' }): string | undefined => {
  const route = normalizeSurfaceRoute('xmail', options.route)
  if (route === '/mail/contacts') return `<div data-mail-read-only="true" data-mail-unavailable="contacts">${renderMailContactsWorkspace({ locale: options.locale, mailbox: '', canManage: false })}</div>`
  const mailboxTool = ({ '/mail/later': [renderMailTools, msgid('Mailbox tools')], '/mail/settings/spam': [renderMailSpam, msgid('Spam preferences')], '/mail/tools/mailing-lists': [renderMailMailingLists, msgid('Mailing lists')] } as Record<string, readonly [(input: { locale: Locale; mailbox: string; canManage: boolean }) => string, string] | undefined>)[route]
  if (mailboxTool) return `<div data-mail-read-only="true" data-mail-unavailable="tools"><h1 class="xp-page-title">${escapeHtml(translator(options.locale)(mailboxTool[1]))}</h1>${mailboxTool[0]({ locale: options.locale, mailbox: '', canManage: false })}</div>`
  const toolPage = ({ '/mail/folders': [renderMailFolders, msgid('Folders')], '/mail/tools/disk-usage': [renderMailDiskUsage, msgctxt('xmail', 'Disk usage')], '/mail/tools/connect-devices': [renderMailConnectDevices, msgid('Connect devices')], '/mail/settings/forwarders': [renderMailForwarders, msgctxt('xmail', 'Forwarders')], '/mail/settings/preferences': [renderMailPreferences, msgid('Preferences')] } as Record<string, readonly [(input: { locale: Locale; mailbox: string; canManage: boolean }) => string, string] | undefined>)[route]
  if (toolPage) return `<div data-mail-read-only="true" data-mail-unavailable="tools"><h1 class="xp-page-title">${escapeHtml(translator(options.locale)(toolPage[1]))}</h1>${toolPage[0]({ locale: options.locale, mailbox: '', canManage: false })}</div>`
  if (route === '/mail/search' || route === '/mail/settings/calendars') {
    const search = route === '/mail/search', { locale } = options
    const heading = search ? (translator(locale)('Search mail')) : (translator(locale)('Calendars and events'))
    const rendered = search
      ? renderMailSearchWorkspace({ locale, mailbox: '', available: false, attachmentPanel: renderMailAttachments({ lang: locale, mailbox: '', canRead: false }) })
      : renderMailCalendarWorkspace({ locale, mailbox: '', canManage: false })
    const readonly = rendered.replace(/<form\b/g, '<div style="display:flex;flex-direction:column;gap:16px;margin:0"').replace(/<\/form>/g, '</div>')
      .replace(/<(button|input|select|textarea)\b([^>]*)>/g, (_match, tag: string, attributes: string) => `<${tag}${/\bdisabled\b/.test(attributes) ? '' : ' disabled'}${attributes}>`)
    return `<div data-mail-read-only="true" data-mail-unavailable="${search ? 'search' : 'calendars'}"><h1 class="xp-page-title">${escapeHtml(heading)}</h1>${readonly}</div>`
  }
  const folder = ({ '/mail/sent': 'Sent', '/mail/drafts': 'Drafts', '/mail/trash': 'Trash' } as Record<string, string | undefined>)[route]
  if (route !== '/mail/inbox' && route !== '/mail/compose' && folder === undefined) return undefined
  const { locale } = options
  const theme = options.theme ?? 'light'
  const compose = route === '/mail/compose'
  // Missing payload stays missing: neither a synthetic address nor an empty loaded inbox is supplied.
  const rendered = compose
    ? renderXmailCompose(xmailComposeFromProps({ mailbox: '', locale, theme }))
    : renderXmailInbox(xmailInboxFromProps({ mailbox: '', locale, theme, activeFolder: folder ?? 'INBOX' }))
  const start = rendered.indexOf('<div data-xp-shell-content="true"')
  const end = rendered.indexOf('<script id="xmail-')
  if (start < 0 || end <= start) throw new Error('Mail document content boundary is unavailable')
  const styles = rendered.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? ''
  const content = rendered.slice(start, end)
    .replace(/<template\b[\s\S]*?<\/template>/g, '')
    .replace(/<input\b[^>]*type="hidden"[^>]*>/g, '')
    .replace(/<main\b/g, '<section').replace(/<\/main>/g, '</section>')
    .replace(/\bid="main-content"/g, 'id="mail-unavailable-content"')
    .replace(/<h1\b/g, '<h2').replace(/<\/h1>/g, '</h2>')
    .replace(/<form\b/g, '<div').replace(/<\/form>/g, '</div>')
    .replace(/\s(?:action|method|href|data-action|data-nav-route|data-mail-action|data-mail-send|data-mail-format|data-mail-format-action|data-mail-recip-input|data-mail-filter|data-mail-open)="[^"]*"/g, '')
    .replace(/<a\b([^>]*)>/g, '<button type="button" disabled$1>').replace(/<\/a>/g, '</button>')
    .replace(/<(button|input|select|textarea)\b([^>]*)>/g, (_match, tag: string, attributes: string) => `<${tag}${/\bdisabled\b/.test(attributes) ? '' : ' disabled'}${attributes}${tag === 'button' ? ' data-wiring="soon"' : ''}>`)
    .replace(/contenteditable="true"/g, 'contenteditable="false" aria-disabled="true"')
  const unavailable = translator(locale)('Mail tools are not qualified for this account. Mailbox data has not been read and actions are unavailable here.')
  const quota = translator(locale)('Mailbox quota: not read')
  return `<div class="xp-board-port" data-board-port="${compose ? 'xmail-compose' : 'xmail-inbox'}" data-mail-layout="reference" data-mail-read-only="true" data-mail-unavailable="${compose ? 'compose' : 'inbox'}" data-locale="${locale}" dir="${localeDirection(locale)}">${styles}<style>[data-mail-read-only="true"] button{font-family:inherit}</style><div role="status" class="xp-help" style="padding:var(--xp-space-field,16px);display:flex;flex-direction:column;gap:8px"><p style="margin:0">${escapeHtml(unavailable)}</p><span data-quota-ratio="unknown">${escapeHtml(quota)}</span></div>${content}</div>`
}
