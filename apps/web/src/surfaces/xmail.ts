import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  renderAsyncActionState,
  renderStatusBadge,
  renderThresholdMeter,
} from '../tokens.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, getSurfaceNavigationLabel, normalizeSurfaceRoute, renderLiveUpdatesIndicator } from '../shell.ts'

export { renderMailExtendedSections } from './extended-views.ts'

export interface MailMessageItem {
  uid: number
  folder: string
  from: string
  to: string
  subject: string
  preview: string
  body: string
  receivedAt: string
  sizeKb: number
  unread: boolean
  dkimPass: boolean
  spfPass: boolean
  dmarcPass: boolean
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
  quotaLimitMb?: number | 'unlimited'
  activeRoute?: string
  activeFolder?: string
  selectedUid?: number
  generationId?: number
  messages?: MailMessageItem[]
  sieveRules?: SieveFilterRule[]
  vacationEnabled?: boolean
  actionState?: AsyncActionBannerProps
}

export const renderMailSurface = (props: MailSurfaceProps = {}): string => {
  const locale = props.locale ?? 'en'
  const isAr = locale === 'ar'
  const theme = props.theme ?? 'dark'
  const mailbox = props.mailbox
  if (!mailbox) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xmail', locale), locale)
  const quotaUsedMb = props.quotaUsedMb
  const quotaLimitMb = props.quotaLimitMb
  const activeFolder = props.activeFolder ?? 'INBOX'
  const activeRoute = normalizeSurfaceRoute('xmail', props.activeRoute ?? '/mail/inbox')
  const section = resolveSurfaceSection('xmail', activeRoute)
  const pageTitle = getSurfacePageTitle('xmail', section, locale, activeRoute)
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const messages = (props.messages ?? []).filter(message => message.folder === activeFolder)
  const sieveRules = props.sieveRules ?? []
  const vacationEnabled = props.vacationEnabled ?? false
  const selectedMessage =
    messages.find((m) => m.uid === props.selectedUid) ?? messages[0]

  const xmailNav = visibleNavigation(props.visibility, props.catalog).find((n) => n.surface === 'xmail')
  const unreadCount = messages.filter((m) => m.unread).length

  const copy = {
    surfaceTitle: isAr ? 'بريد xMail الإلكتروني' : 'xMail Webmail & Sieve Suite',
    quickBar: isAr ? 'بحث' : 'Search',
    wsLive: isAr ? 'متصل لحظياً (/api/ws · IMAP Push)' : 'Live WebSocket (/api/ws · IMAP Push)',
    composeBtn: isAr ? 'إنشاء رسالة جديدة' : 'Compose message',
    foldersHeading: isAr ? 'المجلدات (IMAP)' : 'Folders (Dovecot IMAP)',
    messageListHeading: isAr ? 'قائمة الرسائل' : 'Messages',
    readingPaneHeading: isAr ? 'عرض الرسالة والتحقق الأمني' : 'Reading Pane & Authentication',
    quotaLabel: isAr ? 'حصة صندوق البريد' : 'Mailbox Quota',
    composeHeading: isAr ? 'تحرير وإرسال رسالة (SMTP / DKIM)' : 'Compose & Send Message (SMTP / DKIM)',
    vacationHeading: isAr ? 'الرد التلقائي أثناء الإجازة (Vacation Autoresponder)' : 'Vacation Auto-Responder',
    sieveHeading: isAr ? 'قواعد تصفية البريد (Dovecot Pigeonhole Sieve)' : 'Sieve Mail Filter Rules (Pigeonhole)',
    switchLangLabel: isAr ? 'English' : 'العربية',
    switchLangCode: isAr ? 'en' : 'ar',
    themeLabel: theme === 'dark' ? (isAr ? 'الوضع الفاتح' : 'Light') : isAr ? 'الوضع الداكن' : 'Dark',
    unreadLabel: isAr ? 'غير مقروء' : 'Unread',
    readLabel: isAr ? 'مقروء' : 'Read',
    activeRuleLabel: isAr ? 'مفعل' : 'Active',
    pausedRuleLabel: isAr ? 'متوقف' : 'Paused',
  }

  const folders = [
    { id: 'INBOX', label: isAr ? 'الوارد (Inbox)' : 'Inbox', count: unreadCount },
    { id: 'Starred', label: isAr ? 'المميزة بنجمة' : 'Starred', count: 0 },
    { id: 'Sent', label: isAr ? 'المرسلة' : 'Sent', count: 0 },
    { id: 'Drafts', label: isAr ? 'المسودات' : 'Drafts', count: 0 },
    { id: 'Billing', label: isAr ? 'الفواتير (Billing)' : 'Billing', count: 0 },
    { id: 'Spam Quarantine', label: isAr ? 'حجر الرسائل المزعجة' : 'Spam Quarantine', count: 0 },
    { id: 'Trash', label: isAr ? 'المهملات (.trash)' : 'Trash (.trash)', count: 0 },
  ]

  const navSectionsHtml = (xmailNav?.sections ?? [])
    .map(
      (section) => `
      <details class="xp-nav-section" ${section.pages.some(page => page.route === activeRoute) ? 'open' : ''} data-nav-section="${escapeHtml(section.id)}">
        <summary class="xp-nav-section__title">
          <span>${escapeHtml(getSurfaceNavigationLabel('xmail', 'section', section, locale))}</span>
          <span class="xp-tabular">(${section.pages.length})</span>
        </summary>
        <div class="xp-nav-section__items">
          ${section.pages
            .map(
              (page) => `
            <a href="${escapeHtml(page.route)}" class="xp-nav-item ${page.route === activeRoute ? 'xp-nav-item--active' : ''}" ${page.route === activeRoute ? 'aria-current="page"' : ''} data-nav-route="${escapeHtml(page.route)}">
              <span>${escapeHtml(getSurfaceNavigationLabel('xmail', 'page', page, locale))}</span>
            </a>
          `,
            )
            .join('')}
        </div>
      </details>
    `,
    )
    .join('')

  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  const rawHtml = renderSurfaceShell({
    surface: 'xmail', locale,
    attributes: `data-mailbox="${escapeHtml(mailbox)}"`,
    sidebar: `    <div class="xp-sidebar__brand">
      <span class="xp-brand__mark" aria-hidden="true">xM</span>
      <div>
        <strong>xMail</strong>
        <div><bdi dir="ltr" class="xp-mono">${escapeHtml(mailbox)}</bdi></div>
      </div>
    </div>

    <div class="xp-sidebar__quota">
      <div class="xp-label">${escapeHtml(copy.quotaLabel)}</div>
      ${quotaUsedMb !== undefined && quotaLimitMb !== undefined ? renderThresholdMeter(quotaUsedMb, quotaLimitMb, 'MB') : `<p class="xp-prose">${isAr ? 'غير متاحة' : 'Unavailable'}</p>`}
    </div>

    <nav aria-label="xMail sections">
      ${navSectionsHtml || `<p role="status" data-navigation-empty="true">${escapeHtml(isAr ? 'لا توجد أدوات مثبتة الجاهزية ومتاحة لحسابك.' : 'No verified tools are available for your account.')}</p>`}
    </nav>`,
    topbar: `      <div class="xp-topbar__start">
        <button type="button" class="xp-btn" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K">
          <span>${escapeHtml(copy.quickBar)}</span>
          <kbd class="xp-mono">Ctrl K</kbd>
        </button>
      </div>
      <div class="xp-topbar__end">
        ${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}
        ${generationId !== undefined ? `<span data-generation-chip="${generationId}">
          ${renderStatusBadge('ok', `Gen #${generationId}`)}
        </span>` : ''}
        <a href="?surface=xmail&amp;lang=${copy.switchLangCode}&amp;theme=${theme}" class="xp-btn" lang="${copy.switchLangCode}" data-lang-switch="${copy.switchLangCode}">
          ${escapeHtml(copy.switchLangLabel)}
        </a>
        <a href="?surface=xmail&amp;lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}" class="xp-btn" data-theme-toggle="${theme === 'dark' ? 'light' : 'dark'}">
          ${escapeHtml(copy.themeLabel)}
        </a>
        <a href="/panel?lang=${locale}&amp;theme=${theme}" class="xp-btn xp-btn--ghost">xPanel</a>
        <button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>
      </div>`,
    content: `      ${actionBannerHtml}
${section !== undefined ? `      <div class="xp-card__header">
        <div>
          <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          <p class="xp-prose"><bdi dir="ltr" class="xp-mono">${escapeHtml(mailbox)}</bdi></p>
        </div>
        <a class="xp-btn xp-btn--primary" href="/mail/compose">
          ${escapeHtml(copy.composeBtn)}
        </a>
      </div>

` : ''}
${section === 'inbox' ? `      <!-- Three-Pane Webmail Layout: Folders | Message List | Reading Pane -->
      <section class="xp-mail-tri-pane" aria-label="Three-pane webmail workspace" style="display: grid; grid-template-columns: minmax(190px, 0.9fr) minmax(280px, 1.4fr) minmax(340px, 2fr); gap: var(--xp-space-field); align-items: start;">
        <!-- Pane 1: Folders -->
        <div class="xp-card" data-mail-pane="folders" aria-labelledby="mail-folders-heading">
          <div class="xp-card__header">
            <h2 id="mail-folders-heading">${escapeHtml(copy.foldersHeading)}</h2>
          </div>
          <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px;">
            ${folders
              .map(
                (f) => `
              <li>
                <a href="/mail/inbox?folder=${encodeURIComponent(f.id)}&amp;lang=${locale}&amp;theme=${theme}" class="xp-nav-item ${f.id === activeFolder ? 'xp-nav-item--active' : ''}" data-mail-folder="${escapeHtml(f.id)}">
                  <span>${escapeHtml(f.label)}</span>
                  ${f.count > 0 ? `<strong class="xp-tabular xp-mono" style="margin-inline-start: auto;">${f.count}</strong>` : ''}
                </a>
              </li>
            `,
              )
              .join('')}
          </ul>
        </div>

        <!-- Pane 2: Message List -->
        <div class="xp-card" data-mail-pane="message-list" aria-labelledby="mail-list-heading">
          <div class="xp-card__header">
            <h2 id="mail-list-heading">${escapeHtml(copy.messageListHeading)}</h2>
            ${renderStatusBadge('ok', `${messages.length} msgs`)}
          </div>
          <div class="xp-mail-list" role="list" data-live-mail-list="true" style="display: flex; flex-direction: column; gap: 10px;">
            ${messages
              .map(
                (msg) => `
              <article role="listitem" class="xp-mail-row ${msg.uid === selectedMessage?.uid ? 'is-selected' : ''}" data-mail-uid="${msg.uid}" style="padding: 12px; border: 1px solid var(--xp-border); border-radius: var(--xp-radius-sm);">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                  <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(msg.from)}</bdi></strong>
                  ${renderStatusBadge(msg.unread ? 'warn' : 'ok', msg.unread ? copy.unreadLabel : copy.readLabel)}
                </div>
                <div style="font-weight: 600; margin-block: 4px;">${escapeHtml(msg.subject)}</div>
                <p style="margin: 0 0 6px; font-size: 0.85rem; color: var(--xp-text-secondary);">${escapeHtml(msg.preview)}</p>
                <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--xp-text-muted);">
                  <time datetime="${escapeHtml(msg.receivedAt)}" class="xp-tabular">${escapeHtml(msg.receivedAt)}</time>
                  <span class="xp-tabular">${msg.sizeKb} KB</span>
                </div>
              </article>
            `,
              )
              .join('')}
          </div>
        </div>

        <!-- Pane 3: Reading Pane -->
${selectedMessage ? `        <article class="xp-card" data-mail-pane="reading-pane" aria-labelledby="mail-reading-heading">
          <div class="xp-card__header">
            <div>
              <h2 id="mail-reading-heading">${escapeHtml(selectedMessage.subject)}</h2>
              <div class="xp-mono" style="font-size: 0.85rem;">
                <bdi dir="ltr">From: ${escapeHtml(selectedMessage.from)} → To: ${escapeHtml(selectedMessage.to)}</bdi>
              </div>
            </div>
            <time datetime="${escapeHtml(selectedMessage.receivedAt)}" class="xp-tabular xp-mono">${escapeHtml(selectedMessage.receivedAt)}</time>
          </div>

          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-block-end: 16px;" aria-label="Mail authentication results">
            ${renderStatusBadge(selectedMessage.dkimPass ? 'ok' : 'critical', selectedMessage.dkimPass ? 'DKIM: pass' : 'DKIM: fail')}
            ${renderStatusBadge(selectedMessage.spfPass ? 'ok' : 'critical', selectedMessage.spfPass ? 'SPF: pass' : 'SPF: fail')}
            ${renderStatusBadge(selectedMessage.dmarcPass ? 'ok' : 'critical', selectedMessage.dmarcPass ? 'DMARC: pass' : 'DMARC: fail')}
          </div>

          <pre class="xp-terminal" style="white-space: pre-wrap;">${escapeHtml(selectedMessage.body)}</pre>

          <div style="display: flex; gap: 10px; margin-block-start: 16px;">
            <button type="button" class="xp-btn xp-btn--primary" data-action="reply-message">${isAr ? 'رد' : 'Reply'}</button>
            <button type="button" class="xp-btn" data-action="forward-message">${isAr ? 'إعادة توجيه' : 'Forward'}</button>
            <button type="button" class="xp-btn" data-action="archive-message">${isAr ? 'أرشفة' : 'Archive'}</button>
          </div>
        </article>` : `<div class="xp-card" data-mail-pane="empty" role="status">${isAr ? 'لا توجد رسائل في هذا المجلد.' : 'There are no messages in this folder.'}</div>`}
      </section>

` : ''}
            <!-- Compose Drawer + Vacation Autoresponder + Sieve Filter Rules -->

${section === 'filters' ? `        <section class="xp-card" data-section="sieve-filters" aria-labelledby="sieve-rules-heading">
          <div class="xp-card__header">
            <h2 id="sieve-rules-heading">${escapeHtml(copy.sieveHeading)}</h2>
            ${renderStatusBadge('ok', `${sieveRules.length} active rules`)}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${isAr ? 'القاعدة' : 'Rule Name'}</th>
                  <th>${isAr ? 'الشرط (Match)' : 'Condition'}</th>
                  <th>${isAr ? 'الإجراء (Action)' : 'Sieve Action'}</th>
                  <th>${isAr ? 'الحالة' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                ${sieveRules
                  .map(
                    (rule) => `
                  <tr data-sieve-rule-id="${escapeHtml(rule.id)}">
                    <td><strong>${escapeHtml(rule.name)}</strong></td>
                    <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.condition)}</bdi></code></td>
                    <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.action)}</bdi></code></td>
                    <td>${renderStatusBadge(rule.enabled ? 'ok' : 'suspended', rule.enabled ? copy.activeRuleLabel : copy.pausedRuleLabel)}</td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

</section>` : ''}
${section === 'autoresponder' ? `<section class="xp-card" data-section="vacation-autoresponder">
            <div class="xp-card__header">
              <h3>${escapeHtml(copy.vacationHeading)}</h3>
              ${renderStatusBadge(vacationEnabled ? 'ok' : 'suspended', vacationEnabled ? (isAr ? 'الرد التلقائي مفعل' : 'Auto-Reply Active') : isAr ? 'متوقف' : 'Disabled')}
            </div>
            <form class="xp-form-group" action="/api/mail/autoresponder" method="post">
              <div style="display: flex; align-items: center; gap: 12px;">
                <button type="button" role="switch" aria-checked="${vacationEnabled ? 'true' : 'false'}" class="xp-btn" data-switch="vacation-enabled">
                  ${isAr ? 'تفعيل الرد التلقائي (Sieve vacation)' : 'Enable Sieve vacation responder'}
                </button>
              </div>
              <div>
                <label class="xp-label" for="vacation-subject">${isAr ? 'عنوان الرد التلقائي' : 'Auto-reply Subject'}</label>
                <input id="vacation-subject" name="subject" type="text" class="xp-input" value="" />
              </div>
              <div>
                <label class="xp-label" for="vacation-body">${isAr ? 'نص رسالة الرد التلقائي' : 'Auto-reply Message'}</label>
                <textarea id="vacation-body" name="body" rows="3" class="xp-textarea"></textarea>
              </div>
            </form>
          </section>` : ''}
${section === 'compose' ? `        <!-- Compose Drawer / Panel -->
        <aside class="xp-card" data-section="compose-drawer" aria-labelledby="compose-drawer-heading">
          <div class="xp-card__header">
            <h2 id="compose-drawer-heading">${escapeHtml(copy.composeHeading)}</h2>
            ${renderStatusBadge('ok', 'DKIM + TLS 1.3')}
          </div>
          <form class="xp-form-group" action="/api/mail/send" method="post" data-compose-form="true">
            <div>
              <label class="xp-label" for="compose-from">${isAr ? 'من (From)' : 'From Identity'}</label>
              <input id="compose-from" name="from" type="email" class="xp-input xp-mono" dir="ltr" readonly value="${escapeHtml(mailbox)}" />
            </div>
            <div>
              <label class="xp-label" for="compose-to">${isAr ? 'إلى (To)' : 'Recipient (To)'}</label>
              <input id="compose-to" name="to" type="email" class="xp-input xp-mono" dir="ltr" required placeholder="customer@example.com" />
            </div>
            <div>
              <label class="xp-label" for="compose-subject">${isAr ? 'الموضوع (Subject)' : 'Subject'}</label>
              <input id="compose-subject" name="subject" type="text" class="xp-input" required placeholder="${isAr ? 'الموضوع' : 'Subject'}" />
            </div>
            <div>
              <label class="xp-label" for="compose-body">${isAr ? 'نص الرسالة' : 'Message Body'}</label>
              <textarea id="compose-body" name="body" rows="6" class="xp-textarea" required placeholder="Write your message..."></textarea>
            </div>
            <button type="submit" class="xp-btn xp-btn--primary">
              ${escapeHtml(copy.composeBtn)}
            </button>
          </form>
        </aside>

` : ''}
            ${section === 'overview' ? `<section class="xp-card" data-section="mail-overview"><h2>${escapeHtml(copy.quotaLabel)}</h2><p><bdi dir="ltr">${escapeHtml(mailbox)}</bdi></p>${quotaUsedMb !== undefined && quotaLimitMb !== undefined ? renderThresholdMeter(quotaUsedMb, quotaLimitMb, 'MB') : `<p role="status">${isAr ? 'غير متاحة' : 'Unavailable'}</p>`}</section>` : ''}
${section === undefined ? renderSurfaceUnavailable(locale, '/mail/inbox') : ''}`,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
