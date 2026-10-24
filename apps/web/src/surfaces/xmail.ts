import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import {
  type AsyncActionBannerProps, ensureAccessibleSurfaceHtml, escapeHtml, formatAsciiDate,
  renderAsyncActionState, renderStatusBadge, renderThresholdMeter,
} from '../tokens.ts'
import { accountSecurityRoute, renderSecurityNavLink } from '../chrome.ts'
import {
  getSurfaceNavigationLabel, getSurfacePageTitle, normalizeSurfaceRoute,
  renderLiveUpdatesIndicator, renderPageSearchButton, renderMobileNavBackdrop, renderMobileNavClose,
  renderMobileNavToggle, renderSurfaceUnavailable, renderUnavailableSurfaceShell,
  resolveSurfaceSection,
} from '../shell.ts'
import { renderXmailCompose, xmailComposeFromProps } from '../board-port/xmail-compose.ts'
import { renderXmailInbox, xmailInboxFromProps } from '../board-port/xmail-inbox.ts'

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
  locale?: 'en' | 'ar'
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
  const isAr = locale === 'ar'
  const text = (en: string, ar: string): string => isAr ? ar : en
  const theme = props.theme ?? 'dark'
  const mailbox = props.mailbox
  if (!mailbox) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xmail', locale), locale)
  const activeRoute = normalizeSurfaceRoute('xmail', props.activeRoute ?? '/mail/inbox')
  const section = resolveSurfaceSection('xmail', activeRoute)
  const pageTitle = getSurfacePageTitle('xmail', section, locale, activeRoute)
  const activeFolder = props.activeFolder ?? 'INBOX'
  const allMessages = (props.messages ?? []).filter(message => Number.isSafeInteger(message.uid) && message.uid > 0)
  const messages = allMessages.filter(message => message.folder === activeFolder)
  const selectedMessage = messages.find(message => message.uid === props.selectedUid) ?? messages[0]
  const quota = props.quotaUsedMb !== undefined || props.quotaLimitMb !== undefined
    ? renderThresholdMeter(props.quotaUsedMb, props.quotaLimitMb, { unit: 'MiB', locale, label: text('Mailbox quota', 'حصة صندوق البريد') })
    : ''
  const xmailNav = visibleNavigation(props.visibility, props.catalog).find(nav => nav.surface === 'xmail')
  const navSectionsHtml = (xmailNav?.sections ?? []).map(navSection => `
    <details class="xp-nav-section xp-mail-nav-section" ${navSection.pages.some(page => page.route === activeRoute) ? 'open' : ''} data-nav-section="${escapeHtml(navSection.id)}">
      <summary class="xp-nav-section__title">${escapeHtml(getSurfaceNavigationLabel('xmail', 'section', navSection, locale))}</summary>
      <div class="xp-nav-section__items">${navSection.pages.map(page => {
        const current = page.route === activeRoute
        const compose = page.route === '/mail/compose'
        const unread = page.route === '/mail/inbox' ? allMessages.filter(message => message.folder === 'INBOX' && message.unread).length : 0
        return `<a href="${escapeHtml(page.route)}" class="xp-nav-item ${current ? 'xp-nav-item--active' : ''} ${compose ? 'xp-mail-compose-link' : ''}" ${current ? 'aria-current="page"' : ''} data-nav-route="${escapeHtml(page.route)}">${compose ? icons.compose : page.route === '/mail/inbox' ? icons.inbox : icons.folder}<span>${escapeHtml(getSurfaceNavigationLabel('xmail', 'page', page, locale))}</span>${unread ? `<span class="xp-mail-count xp-tabular" aria-label="${escapeHtml(text('Unread', 'غير مقروء'))}">${unread}</span>` : ''}</a>`
      }).join('')}</div>
    </details>`).join('')
  // Folder observations do not grant a working folder-selection or mutation endpoint.
  const observedFolders = [...new Set(allMessages.map(message => message.folder))].filter(folder => folder !== 'INBOX')
  const observedFolderHtml = observedFolders.length ? `<section class="xp-mail-nav-section" aria-labelledby="mail-observed-folders"><h2 id="mail-observed-folders" class="xp-label">${text('Folders', 'المجلدات')}</h2><ul class="xp-mail-observed-folders">${observedFolders.map(folder => `<li data-mail-folder="${escapeHtml(folder)}">${icons.folder}<span>${escapeHtml(folder)}</span></li>`).join('')}</ul></section>` : ''
  const actionBanner = props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : ''

  if (section === 'inbox') {
    return ensureAccessibleSurfaceHtml(renderXmailInbox(xmailInboxFromProps({
      locale,
      theme,
      mailbox,
      ...(props.quotaUsedMb !== undefined ? { quotaUsedMb: props.quotaUsedMb } : {}),
      ...(props.quotaUsedBytes !== undefined ? { quotaUsedBytes: props.quotaUsedBytes } : {}),
      ...(props.quotaLimitMb !== undefined ? { quotaLimitMb: props.quotaLimitMb } : {}),
      activeFolder,
      ...(props.selectedUid !== undefined ? { selectedUid: props.selectedUid } : {}),
      ...(props.messages !== undefined ? { messages: allMessages } : {}),
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
      ...(props.quotaUsedMb !== undefined ? { quotaUsedMb: props.quotaUsedMb } : {}),
      ...(props.quotaUsedBytes !== undefined ? { quotaUsedBytes: props.quotaUsedBytes } : {}),
      ...(props.quotaLimitMb !== undefined ? { quotaLimitMb: props.quotaLimitMb } : {}),
      ...(props.messages !== undefined ? { messages: allMessages } : {}),
      realtimeEnabled: props.realtimeEnabled === true,
      ...(props.actionState ? { actionState: props.actionState } : {}),
      ...(props.vacationEnabled !== undefined ? { vacationEnabled: props.vacationEnabled } : {}),
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
    <div class="xp-mail-pane-heading"><h1 id="mail-list-heading" class="xp-page-title">${escapeHtml(activeFolder === 'INBOX' ? pageTitle : activeFolder)}</h1><span class="xp-help xp-tabular">${messages.length} ${text('messages', 'رسالة')}</span></div>
    <div class="xp-mail-list" role="list" data-live-mail-list="true">${messages.map(message => `
      <article role="listitem" class="xp-mail-row ${message.uid === selectedMessage?.uid ? 'is-selected' : ''} ${message.unread ? 'is-unread' : ''}" data-mail-uid="${message.uid}">
        <span class="xp-mail-read-mark" aria-label="${text(message.unread ? 'Unread' : 'Read', message.unread ? 'غير مقروء' : 'مقروء')}"></span>
        <div class="xp-mail-row-content"><strong class="xp-mail-sender"><bdi dir="ltr">${escapeHtml(message.from)}</bdi></strong><span class="xp-mail-subject">${escapeHtml(message.subject)}</span><p class="xp-mail-preview">${escapeHtml(message.preview)}</p><time datetime="${escapeHtml(message.receivedAt)}" class="xp-mail-time xp-tabular"><bdi dir="ltr">${escapeHtml(formatAsciiDate(message.receivedAt, { includeTime: true }))}</bdi></time></div>
      </article>`).join('')}${messages.length ? '' : `<p class="xp-mail-empty" role="status">${text('No messages in this folder.', 'لا توجد رسائل في هذا المجلد.')}</p>`}</div>
  </section>`
  const readingHtml = selectedMessage ? `<article class="xp-mail-reader" data-mail-pane="reading-pane" aria-labelledby="mail-reading-heading">
    <header class="xp-mail-message-heading"><h2 id="mail-reading-heading">${escapeHtml(selectedMessage.subject)}</h2><dl class="xp-mail-message-meta">${field(text('From', 'من'), selectedMessage.from)}${field(text('To', 'إلى'), selectedMessage.to)}${field(text('Received', 'الاستلام'), formatAsciiDate(selectedMessage.receivedAt, { includeTime: true }))}</dl></header>
    <details class="xp-mail-auth-results"><summary>${text('Message authentication', 'التحقق من الرسالة')}</summary><div>${renderStatusBadge(selectedMessage.dkimPass ? 'ok' : 'critical', selectedMessage.dkimPass ? 'DKIM: pass' : 'DKIM: fail')}${renderStatusBadge(selectedMessage.spfPass ? 'ok' : 'critical', selectedMessage.spfPass ? 'SPF: pass' : 'SPF: fail')}${renderStatusBadge(selectedMessage.dmarcPass ? 'ok' : 'critical', selectedMessage.dmarcPass ? 'DMARC: pass' : 'DMARC: fail')}</div></details>
    <div class="xp-mail-message-body" dir="auto">${escapeHtml(selectedMessage.body)}</div>
  </article>` : `<div class="xp-mail-reader xp-mail-empty" data-mail-pane="empty" role="status">${text('No message selected.', 'لم تُحدد رسالة.')}</div>`

  const composeHtml = `<div class="xp-mail-compose-layout"><section class="xp-mail-editor" data-section="compose-drawer" aria-labelledby="compose-drawer-heading">
    <header class="xp-mail-editor-heading"><a href="/mail/inbox" class="xp-mail-back-link">${text('Inbox', 'الوارد')}</a><h1 class="xp-page-title" id="compose-drawer-heading">${text('New message', 'رسالة جديدة')}</h1></header>
    <div role="group" aria-labelledby="compose-drawer-heading" data-compose-form="true" class="xp-mail-compose-form" data-mail-send-availability="available">
      <div class="xp-mail-compose-fields"><div class="xp-mail-field"><label class="xp-label" for="compose-from">${text('From', 'من')}</label><input id="compose-from" name="from" type="email" class="xp-input xp-mono" dir="ltr" readonly value="${escapeHtml(mailbox)}" /></div><div class="xp-mail-field"><label class="xp-label" for="compose-to">${text('To', 'إلى')}</label><input id="compose-to" name="to" type="email" class="xp-input xp-mono" dir="ltr" required autocomplete="email" /></div><div class="xp-mail-field xp-mail-field--wide"><label class="xp-label" for="compose-subject">${text('Subject', 'الموضوع')}</label><input id="compose-subject" name="subject" type="text" dir="auto" class="xp-input" required /></div></div>
      <div class="xp-mail-field xp-mail-compose-body"><label class="xp-label" for="compose-body">${text('Message', 'الرسالة')}</label><textarea id="compose-body" name="body" rows="12" dir="auto" class="xp-textarea" required spellcheck="true"></textarea></div>
      <footer class="xp-mail-editor-actions"><span class="xp-help" id="mail-send-status" role="status">${text('Send through the local mail server.', 'أرسل عبر خادم البريد المحلي.')}</span><button type="button" class="xp-btn xp-btn--primary" data-mail-send="true" aria-describedby="mail-send-status">${icons.send}${text('Send', 'إرسال')}</button></footer>
    </div>
  </section><aside class="xp-mail-compose-aside" aria-labelledby="mail-sender-heading"><section class="xp-card"><h2 id="mail-sender-heading">${text('Sending as', 'عنوان المرسل')}</h2><dl>${field(text('Address', 'العنوان'), mailbox)}</dl></section>${quota ? `<section class="xp-card"><h2>${text('Mailbox quota', 'حصة صندوق البريد')}</h2>${quota}</section>` : ''}</aside></div>`

  const sieveRules = props.sieveRules ?? []
  const filtersHtml = `<section class="xp-card" data-section="sieve-filters" aria-labelledby="sieve-rules-heading"><div class="xp-card__header"><h2 id="sieve-rules-heading">${text('Filters', 'الفلاتر')}</h2><span class="xp-help xp-tabular">${sieveRules.length} ${text('rules', 'قاعدة')}</span></div><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${text('Rule', 'القاعدة')}</th><th>${text('Condition', 'الشرط')}</th><th>${text('Action', 'الإجراء')}</th><th>${text('Status', 'الحالة')}</th></tr></thead><tbody>${sieveRules.map(rule => `<tr data-sieve-rule-id="${escapeHtml(rule.id)}"><td><strong>${escapeHtml(rule.name)}</strong></td><td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.condition)}</bdi></code></td><td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.action)}</bdi></code></td><td>${renderStatusBadge(rule.enabled ? 'ok' : 'suspended', rule.enabled ? text('Active', 'مفعل') : text('Paused', 'متوقف'))}</td></tr>`).join('')}</tbody></table></div></section>`
  const vacationEnabled = props.vacationEnabled ?? false
  const vacationHtml = `<section class="xp-card" data-section="vacation-autoresponder"><div class="xp-card__header"><h2>${text('Vacation responder', 'الرد التلقائي')}</h2>${renderStatusBadge(vacationEnabled ? 'ok' : 'suspended', vacationEnabled ? text('Enabled', 'مفعل') : text('Disabled', 'متوقف'))}</div></section>`
  const content = section === 'inbox' ? `<section class="xp-mail-tri-pane" data-mail-live="true" aria-label="${text('Mail workspace', 'مساحة البريد')}">${listHtml}${readingHtml}</section>`
    : section === 'compose' ? composeHtml
    : section === 'filters' ? filtersHtml
    : section === 'autoresponder' ? vacationHtml
    : section === 'overview' ? `<section class="xp-card" data-section="mail-overview"><h2>${text('Mailbox quota', 'حصة صندوق البريد')}</h2>${quota || `<p role="status">${text('Unavailable', 'غير متاحة')}</p>`}</section>`
    : section === 'security' ? ''
    : renderSurfaceUnavailable(locale, '/mail/inbox')

  const rawHtml = `<div class="xp-shell xp-mail-shell" data-surface="xmail" data-mail-layout="reference" data-mailbox="${escapeHtml(mailbox)}">
    <a class="xp-skip-link" href="#main-content">${text('Skip to content', 'انتقل إلى المحتوى')}</a>
    <header class="xp-topbar xp-mail-topbar" role="banner">${renderMobileNavToggle(locale)}<a class="xp-mail-brand" href="/mail/inbox"><span class="xp-mail-brand-mark" aria-hidden="true">x</span><strong>xMail</strong></a><details class="xp-toolbar-options" open data-xp-toolbar-options><summary class="xp-btn">${text('Search & account', 'البحث والحساب')}</summary><div class="xp-toolbar-options__content"><div class="xp-topbar__start">${renderPageSearchButton(locale)}</div><div class="xp-topbar__end"><span class="xp-mail-account"><bdi dir="ltr">${escapeHtml(mailbox)}</bdi></span>${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}<a href="${escapeHtml(activeRoute)}?lang=${isAr ? 'en' : 'ar'}&amp;theme=${theme}" class="xp-btn xp-btn--ghost" lang="${isAr ? 'en' : 'ar'}" data-lang-switch="${isAr ? 'en' : 'ar'}">${text('العربية', 'English')}</a><a href="${escapeHtml(activeRoute)}?lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}" class="xp-btn xp-btn--ghost" data-theme-toggle="${theme === 'dark' ? 'light' : 'dark'}">${theme === 'dark' ? text('Light', 'الوضع الفاتح') : text('Dark', 'الوضع الداكن')}</a><a class="xp-btn xp-btn--ghost" href="${escapeHtml(accountSecurityRoute('xmail'))}" data-security-link="true">${text('Security', 'الأمان')}</a><button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${text('Sign out', 'تسجيل الخروج')}</button></div></div></details></header>
    <aside class="xp-sidebar xp-mail-folders" id="xp-sidebar" data-xp-sidebar data-mail-pane="folders" tabindex="-1" aria-label="${text('xMail navigation', 'التنقل في xMail')}">${renderMobileNavClose(locale)}<nav aria-label="${text('Mail navigation', 'التنقل في البريد')}">${navSectionsHtml || `<p class="xp-help" role="status" data-navigation-empty="true">${text('No verified tools are available for your account.', 'لا توجد أدوات مثبتة الجاهزية ومتاحة لحسابك.')}</p>`}${renderSecurityNavLink('xmail', locale, activeRoute, (xmailNav?.sections ?? []).some(section => section.pages.some(page => page.route === accountSecurityRoute('xmail'))))}${observedFolderHtml}</nav>${quota && section !== 'compose' ? `<div class="xp-mail-sidebar-quota"><span class="xp-label">${text('Mailbox quota', 'حصة صندوق البريد')}</span>${quota}</div>` : ''}</aside>${renderMobileNavBackdrop(locale)}
    <div class="xp-workspace" data-xp-shell-content><main id="main-content" class="xp-main xp-mail-main ${section === 'inbox' ? 'xp-mail-main--inbox' : ''}" role="main" tabindex="-1">${actionBanner}${section !== undefined && section !== 'inbox' && section !== 'compose' ? `<h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>` : ''}${content}</main></div>
  </div>`
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
