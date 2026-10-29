import { LOCALES, localeDirection, translator, type Locale } from '../i18n.ts'
import { DISPLAY_DATETIME_BINDING, escapeHtml, renderAsyncActionState, type AsyncActionBannerProps } from '../tokens.ts'
import { renderLiveUpdatesIndicator, renderPageSearchButton, renderMobileNavToggle, renderMobileNavClose, renderMobileNavBackdrop } from '../shell.ts'
import { formatAttachmentBytes, formatMailboxQuota, formatMailStamp } from './mail-truth.ts'
import { MAIL_ATTACHMENTS_STYLE, renderMailAttachments } from './xmail-attachments.ts'
import { mailFolderFlags, mailFolderObject, mailFolderUid, mailFolderUidValidity, mailFolderWriteUncertain, readFolderMessage, readFolderMove, readFolderSummary } from '../mail-folder-workspace-client.ts'

const MONO = "'IBM Plex Mono', monospace"
const FONT_EN = "'IBM Plex Sans', sans-serif"
const FONT_AR = "sans-serif"
const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:light-dark(#1D5BD6,var(--xp-accent))}.xp-board-port a:hover{color:light-dark(#1546A8,var(--xp-accent-hover))}
.xp-board-port :focus-visible{outline:2px solid light-dark(#1D5BD6,var(--xp-accent));outline-offset:2px}
.xp-board-port[data-board-port="xmail-inbox"][data-locale="ar"] nav > a[data-nav-route="/mail/compose"]{font-size:14px!important;font-weight:600!important;line-height:normal!important;min-inline-size:auto}
.xp-board-port p{max-inline-size:none}
.xp-board-port [data-mail-refresh-status]{margin:0;padding:var(--xp-space-field,16px);font-size:14.5px;line-height:1.75}
@media(min-width:960px){.xp-board-port [data-mail-refresh-status]{padding:var(--xp-space-card,24px)}}
@media(min-width:960px){.xp-board-port[data-mail-layout="reference"] [data-xp-sidebar]{flex:0 0 200px!important;inline-size:200px;position:static;block-size:auto;overflow:visible}}
${MAIL_ATTACHMENTS_STYLE}`

const glyph = (inner: string, size = 18): string =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

const ICONS = {
  compose: glyph('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path>'),
  inbox: glyph('<path d="M4 4h16v16H4z"></path><path d="M4 14h4l2 3h4l2-3h4"></path>'),
  sent: glyph('<path d="M22 2L11 13"></path><path d="M22 2l-7 20-4-9-9-4z"></path>'),
  drafts: glyph('<path d="M14 3H6v18h12V7z"></path><path d="M14 3v4h4"></path>'),
  junk: glyph('<circle cx="12" cy="12" r="9"></circle><path d="M5.6 5.6l12.8 12.8"></path>'),
  trash: glyph('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path>'),
  archive: glyph('<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v11h14V9"></path><path d="M10 13h4"></path>'),
  folder: glyph('<path d="M3 6h6l2 2h10v11H3z"></path>'),
  reply: glyph('<path d="M9 14L4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 6 6v5"></path>'),
  replyAll: glyph('<path d="M7 14L2 9l5-5"></path><path d="M12 14L7 9l5-5"></path><path d="M7 9h7a6 6 0 0 1 6 6v5"></path>'),
  forward: glyph('<path d="M15 14l5-5-5-5"></path><path d="M20 9H10a6 6 0 0 0-6 6v5"></path>'),
  move: glyph('<path d="M3 6h6l2 2h10v11H3z"></path><path d="M12 13h5M15 11l2 2-2 2"></path>'),
  chevron: glyph('<path d="M6 9l6 6 6-6"></path>', 14),
  download: glyph('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path>'),
  attach: glyph('<path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"></path>', 14),
}

type IconName = keyof typeof ICONS
type CountKind = 'pill' | 'muted' | 'strong'

export interface FolderLink {
  id: string
  label: string
  href: string
  icon: IconName
  current: boolean
  count?: { text: string; kind: CountKind }
  aria?: string
  observed?: string
}

interface Attachment {
  name: string
  ext: string
  size: string
}

interface Block {
  p?: string
  pre?: string
  list?: string[]
}

export interface MailCard {
  id: string
  uid?: number
  fromName: string
  fromAddr: string
  to: string
  cc: string
  subject: string
  snippet: string
  time: string
  datetime: string
  displayDate?: string
  unread: boolean
  auth: string
  local?: boolean
  remoteImages?: boolean
  attachments: Attachment[]
  attachTotal?: string
  blocks: Block[]
  bodyPending?: boolean
}

export interface InboxModel {
  folderWorkspace?: boolean
  attachmentReadEnabled?: boolean
  locale: Locale
  theme?: 'light' | 'dark'
  product: boolean
  mailbox: string
  quotaText: string
  quotaPct: number
  quotaMeasured: boolean
  listState: 'messages' | 'empty' | 'unread' | 'failed'
  title: string
  countText: string
  unreadCount?: number
  pager: string
  loaded: number
  total: number
  composeHref: string
  inboxHref: string
  folders: FolderLink[]
  custom: FolderLink[]
  vacationHref: string
  vacation: string
  filtersHref: string
  filters: string
  messages: MailCard[]
  selectedId: string | null
  folderEmpty: boolean
  wsHtml: string
  actionHtml: string
  logoutAttr: string
  activeFolder: string
  moveTargets: Array<{ id: string; label: string }>
  copy: { emptyTitle: string; emptyBody: string; emptyClear: string; undo: string; moved: string; moveLabel: string }
}

const tech = (value: string, rtl: boolean): string => rtl ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)

const countSpan = (count: { text: string; kind: CountKind }, folderId: string): string => {
  const attr = ` data-mail-count="${escapeHtml(folderId)}"`
  if (count.kind === 'pill') return `<span${attr} style="min-width: 24px; padding: 1px 8px; border-radius: 999px; background: light-dark(#1D5BD6,var(--xp-accent)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  if (count.kind === 'muted') return `<span${attr} style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  return `<span${attr} style="font-size: 12px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
}

const folderLink = (item: FolderLink, _route: string): string => {
  const style = item.current
    ? 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent)); background: light-dark(#E8EFFD,var(--xp-accent-soft)); text-decoration: none'
    : 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none'
  const current = item.current ? ' aria-current="page"' : ''
  const routeAttr = ` data-nav-route="${escapeHtml(item.href)}"`
  const observed = item.observed ? ` data-mail-folder="${escapeHtml(item.observed)}"` : ''
  const aria = item.aria ? ` aria-label="${escapeHtml(item.aria)}"` : ''
  const count = item.count ? countSpan(item.count, item.id) : ''
  return `<li${observed}><a href="${escapeHtml(item.href)}"${current}${routeAttr}${aria} style="${style}">${ICONS[item.icon]}<span style="flex: 1 1 auto">${escapeHtml(item.label)}</span>${count}</a></li>`
}

const initialsOf = (name: string, local?: boolean): string => {
  if (local) return 'x'
  return name.split(/\s+/).filter(word => /^[A-Za-z]/.test(word)).slice(0, 2).map(word => word.charAt(0).toUpperCase()).join('')
}

const fullDate = (datetime: string): string => formatMailStamp(datetime).full

const ATTACHMENTS = msgid('{count, plural, one {{count} attachment} other {{count} attachments}}')

const messageRow = (card: MailCard, selected: boolean, locale: Locale): string => {
  const rtl = localeDirection(locale) === 'rtl'
  const unread = card.unread
  const weight = unread ? '600' : '400'
  const dot = unread ? 'light-dark(#1D5BD6,var(--xp-accent))' : 'transparent'
  const bg = selected ? 'light-dark(#F3F7FE,var(--xp-accent-soft))' : 'light-dark(#FFFFFF,var(--xp-bg-surface))'
  const bar = selected ? (rtl ? 'inset -3px 0 0 light-dark(#1D5BD6,var(--xp-accent))' : 'inset 3px 0 0 light-dark(#1D5BD6,var(--xp-accent))') : 'none'
  const timeColor = unread ? 'light-dark(#101828,var(--xp-text-primary))' : 'light-dark(#5D6B7E,var(--xp-text-muted))'
  const attach = card.attachments.length
  const unreadLabel = translator(locale)('Unread.')
  const attachLabel = translator(locale)(ATTACHMENTS, { count: attach })
  const aria = `${unread ? unreadLabel + ' ' : ''}${card.fromName}. ${card.subject}. ${card.time}${attach ? `. ${attachLabel}` : ''}`
  const uid = card.uid !== undefined ? ` data-mail-uid="${card.uid}"` : ''
  const icon = attach ? ICONS.attach : ''
  return `<li style="border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))"><button type="button" data-mail-open="${escapeHtml(card.id)}" data-unread="${unread ? 'true' : 'false'}" data-attach="${attach > 0 ? '1' : '0'}" data-search="${escapeHtml(`${card.fromName} ${card.fromAddr} ${card.subject} ${card.snippet}`)}"${uid} aria-current="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(aria)}" style="width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; display: flex; gap: 10px; padding: 12px 16px; border: none; background: ${bg}; box-shadow: ${bar}; text-align: start; font-family: inherit; color: light-dark(#101828,var(--xp-text-primary)); cursor: pointer"><span aria-hidden="true" data-mail-dot="true" style="flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: ${dot}"></span><span style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px"><span style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0"><span data-mail-name="true" style="min-width: 0; font-size: 14px; font-weight: ${weight}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${tech(card.fromName, rtl)}</span><span data-mail-time="true" style="flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: ${weight}; color: ${timeColor}; font-variant-numeric: tabular-nums">${icon}<time datetime="${escapeHtml(card.datetime)}">${tech(card.time, rtl)}</time></span></span><span data-mail-subject="true" style="min-width: 0; font-size: 14px; font-weight: ${weight}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><bdi dir="auto">${escapeHtml(card.subject)}</bdi></span><span data-mail-preview style="min-width: 0; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><bdi dir="auto">${escapeHtml(card.snippet)}</bdi></span></span></button></li>`
}

const readingMarkup = (card: MailCard, model: InboxModel): string => {
  const rtl = localeDirection(model.locale) === 'rtl'
  const avatarBg = card.local ? 'light-dark(#101828,var(--xp-bg-elevated))' : 'light-dark(#E7F5EE,var(--xp-status-ok-bg))'
  const avatarFg = card.local ? 'light-dark(#FFFFFF,var(--xp-text-primary))' : 'light-dark(#0E7A4E,var(--xp-status-ok-fg))'
  const authFailed = card.auth.includes(': fail')
  const authUnknown = card.auth.includes(': —') || card.auth.includes('not checked') || card.auth.includes(translator(model.locale)('not checked'))
  const authBg = card.local || (authUnknown && !authFailed) ? 'light-dark(#EEF0F3,var(--xp-bg-elevated))' : (authFailed ? 'light-dark(#FEF3F2,var(--xp-status-critical-bg))' : 'light-dark(#E7F5EE,var(--xp-status-ok-bg))')
  const authFg = card.local || (authUnknown && !authFailed) ? 'light-dark(#344054,var(--xp-text-secondary))' : (authFailed ? 'light-dark(#B42318,var(--xp-status-critical-fg))' : 'light-dark(#0E7A4E,var(--xp-status-ok-fg))')
  const cc = card.cc || model.product
    ? `<div data-mail-message-field style="display: ${card.cc ? 'grid' : 'none'}; grid-template-columns: minmax(0, 1fr); gap: var(--xp-space-label, 8px); min-width: 0; max-width: 100%"><dt>${translator(model.locale)('Cc')}</dt><dd data-mail-message-value data-mail-addr="true" style="margin: 0; min-width: 0; font-family: ${MONO}; color: light-dark(#344054,var(--xp-text-secondary)); overflow-wrap: anywhere">${tech(card.cc, rtl)}</dd></div>`
    : ''
  const blocks = card.blocks.map(block => {
    if (block.list) {
      return `<ul style="margin: 0; padding-inline-start: 20px; max-width: 68ch; display: flex; flex-direction: column; gap: 4px">${block.list.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    }
    if (block.pre !== undefined) {
      return `<pre dir="auto" style="margin: 0; padding: 12px 14px; border-radius: 10px; border: 1px solid #E2E6EC; background: #F8F9FB; color: #101828; font-family: ${MONO}; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere"><bdi dir="auto">${escapeHtml(block.pre)}</bdi></pre>`
    }
    const pending = card.bodyPending ? ' data-mail-body="pending"' : ''
    return `<p${pending} dir="auto" style="margin: 0; max-width: 68ch; white-space: pre-line"><bdi dir="auto">${escapeHtml(block.p ?? '')}</bdi></p>`
  }).join('')
  const images = card.remoteImages
    ? `<div role="note" data-mail-images="true" style="margin: 16px 28px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; border: 1px solid light-dark(#C7D7F8,var(--xp-accent-border)); background: light-dark(#F3F7FE,var(--xp-accent-soft)); font-size: 13px; line-height: 1.6"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#1D5BD6,var(--xp-accent))" stroke-width="2" stroke-linecap="round" style="flex: none"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v4h1"></path></svg><span style="flex: 1 1 240px">${translator(model.locale)("Remote images are blocked so the sender can't see when you open this message.")}</span><button type="button" data-mail-action="load-images" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 13px; font-weight: 600">${translator(model.locale)('Load images')}</button></div>`
    : ''
  const attachments = model.product
    ? renderMailAttachments({ lang: model.locale, mailbox: model.mailbox, folder: model.activeFolder, canRead: model.attachmentReadEnabled === true })
    : card.attachments.length
    ? `<section aria-labelledby="att-${escapeHtml(card.id)}" style="padding: 0 28px 28px; display: flex; flex-direction: column; gap: 10px"><h3 id="att-${escapeHtml(card.id)}" style="margin: 0; font-size: 13px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${escapeHtml(`${translator(model.locale)(ATTACHMENTS, { count: card.attachments.length })} · ${card.attachTotal ?? ''}`)}</h3><ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px">${card.attachments.map(file => `<li><button type="button" data-mail-attachment-download="true"${model.product ? ` disabled aria-describedby="mail-attachment-availability-${escapeHtml(card.id)}"` : ''} aria-label="${escapeHtml(`${translator(model.locale)('Download')} ${file.name}, ${file.size}`)}" style="min-height: 52px; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; text-align: start"><span aria-hidden="true" style="flex: none; width: 34px; height: 34px; border-radius: 8px; background: light-dark(#EEF0F3,var(--xp-bg-elevated)); color: light-dark(#344054,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 10px; font-weight: 600">${escapeHtml(file.ext)}</span><span style="display: flex; flex-direction: column; gap: 1px; min-width: 0"><span style="font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px">${escapeHtml(file.name)}</span><span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted)); font-variant-numeric: tabular-nums">${escapeHtml(file.size)}</span></span><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#475467,var(--xp-text-secondary))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-inline-start: 4px"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg></button></li>`).join('')}</ul>${model.product ? `<p id="mail-attachment-availability-${escapeHtml(card.id)}" data-mail-attachment-availability="unavailable" role="note" style="margin:0;font-size:13px;line-height:1.6;color:light-dark(#475467,var(--xp-text-secondary))">${translator(model.locale)('Attachment downloads are unavailable from this interface.')}</p>` : ''}</section>`
    : ''
  const reply = (icon: string, label: string, mode: string): string => {
    const href = `${model.composeHref}?mode=${encodeURIComponent(mode)}&uid=${encodeURIComponent(String(card.uid ?? ''))}&folder=${encodeURIComponent(model.activeFolder)}`
    return `<a href="${escapeHtml(href)}" data-mail-reply="${escapeHtml(mode)}" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-size: 14px; font-weight: 600; text-decoration: none">${icon}${escapeHtml(label)}</a>`
  }
  return `<div role="toolbar" aria-label="${translator(model.locale)('Message actions')}" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 24px; border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border))">${reply(ICONS.reply, translator(model.locale)('Reply'), 'reply')}${reply(ICONS.replyAll, translator(model.locale)('Reply all'), 'reply-all')}${reply(ICONS.forward, translator(model.locale)('Forward'), 'forward')}<div style="position: relative"><button type="button" data-mail-action="toggle-move" aria-expanded="false" aria-controls="move-list" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.move}${translator(model.locale)('Move')}${ICONS.chevron}</button></div><span style="flex: 1 1 0"></span><button type="button" data-mail-action="delete" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#F4B8B2,var(--xp-status-critical-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#B42318,var(--xp-status-critical-fg)); font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.trash}${translator(model.locale)('Delete')}</button></div><div style="padding: 20px 28px; display: flex; flex-direction: column; gap: 14px; border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))"><h2 id="msg-subject" dir="auto" style="margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3"><bdi dir="auto">${escapeHtml(card.subject)}</bdi></h2><div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start"><span aria-hidden="true" style="flex: none; width: 40px; height: 40px; border-radius: 50%; background: ${avatarBg}; color: ${avatarFg}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600">${escapeHtml(initialsOf(card.fromName, card.local))}</span><div style="flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 4px"><dl style="margin: 0; min-width: 0"><div data-mail-message-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--xp-space-label, 8px); min-width: 0"><dt style="font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary))">${translator(model.locale)('From')}</dt><dd data-mail-message-value style="margin: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; min-width: 0; max-width: 100%"><span data-mail-from="true" style="min-width: 0; max-width: 100%; font-size: 14px; font-weight: 600; overflow-wrap: anywhere">${tech(card.fromName, rtl)}</span><span data-mail-addr="true" style="min-width: 0; max-width: 100%; font-family: ${MONO}; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary)); overflow-wrap: anywhere">${rtl ? tech(`<${card.fromAddr}>`, true) : `&lt;${escapeHtml(card.fromAddr)}&gt;`}</span></dd></div></dl><dl style="margin: 0; display: flex; flex-wrap: wrap; gap: 2px 16px; min-width: 0; max-width: 100%; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary))"><div data-mail-message-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--xp-space-label, 8px); min-width: 0; max-width: 100%"><dt>${translator(model.locale)('To')}</dt><dd data-mail-message-value data-mail-addr="true" style="margin: 0; min-width: 0; font-family: ${MONO}; color: light-dark(#344054,var(--xp-text-secondary)); overflow-wrap: anywhere">${tech(card.to, rtl)}</dd></div>${cc}</dl></div><div style="flex: none; display: flex; flex-direction: column; gap: 6px; align-items: flex-end; max-width: 100%; min-width: 0"><dl style="margin: 0; min-width: 0"><div data-mail-message-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--xp-space-label, 8px); min-width: 0"><dt style="font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary))">${translator(model.locale)('Received')}</dt><dd data-mail-message-value style="margin: 0"><time datetime="${escapeHtml(card.datetime)}" style="font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums"><bdi dir="ltr">${escapeHtml(card.displayDate ?? fullDate(card.datetime))}</bdi></time></dd></div></dl><span style="display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; padding: 4px 10px; border-radius: 999px; background: ${authBg}; color: ${authFg}; font-size: 12px; font-weight: 600; overflow-wrap: anywhere"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${authFg}"></span>${tech(card.auth, rtl)}</span></div></div></div>${images}<div style="padding: 24px 28px; display: flex; flex-direction: column; gap: 14px; font-size: 14px; line-height: 1.6; color: light-dark(#101828,var(--xp-text-primary))">${blocks}</div>${attachments}`
}

const emptyReading = (locale: Locale, folderEmpty: boolean): string => `<div data-mail-pane="empty" style="flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 64px 24px; text-align: center"><svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="light-dark(#5D6B7E,var(--xp-text-muted))" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><h2 style="margin: 0; font-size: 16px; font-weight: 600">${folderEmpty ? (translator(locale)('No messages in this folder.')) : (translator(locale)('No message selected'))}</h2><p style="margin: 0; font-size: 13px; color: light-dark(#5D6B7E,var(--xp-text-muted)); line-height: 1.6">${folderEmpty ? (translator(locale)('Nothing in this folder is waiting to be read.')) : (translator(locale)('Choose a message from the list to read it here.'))}</p></div>`

// The folder workspace fills these hooks from validated mailbox responses.
// The markup itself remains shared with the default Inbox and its reference fixtures.
const readingInner = (card: MailCard, model: InboxModel): string => {
  const html = readingMarkup(card, model)
  if (!model.folderWorkspace && !model.product) return html
  let hooked = html
    .replace('id="msg-subject"', 'id="msg-subject" data-mail-detail-subject')
    .replace('data-mail-from="true"', 'data-mail-from="true" data-mail-detail-name')
    .replace('<span data-mail-addr="true"', '<span data-mail-addr="true" data-mail-detail-from')
    .replace('<dd data-mail-message-value data-mail-addr="true"', '<dd data-mail-message-value data-mail-addr="true" data-mail-detail-to')
    .replace('<time datetime=', '<time data-mail-detail-date datetime=')
    .replace('<span aria-hidden="true" style="flex: none; width: 40px;', '<span data-mail-detail-avatar aria-hidden="true" style="flex: none; width: 40px;')
    .replace('<span style="display: inline-flex; align-items: center; gap: 6px; max-width:', '<span data-mail-detail-auth style="display: inline-flex; align-items: center; gap: 6px; max-width:')
    .replace('<div style="padding: 24px 28px;', '<div data-mail-detail-body style="padding: 24px 28px;')
    .replace('<section aria-labelledby="att-', '<section data-mail-detail-attachments aria-labelledby="att-')
    .replace('<section class="xp-mail-attachments"', '<section data-mail-detail-attachments class="xp-mail-attachments"')
  // Cc appears before To in the source construction, but after To in the markup.
  hooked = hooked.replace('<dd data-mail-message-value data-mail-addr="true" style', '<dd data-mail-message-value data-mail-addr="true" data-mail-detail-cc style')
  if (!model.folderWorkspace) return hooked
  const action = model.activeFolder === 'Trash' ? 'restore' : 'delete'
  const label = model.activeFolder === 'Trash' ? (translator(model.locale)('Restore to Inbox')) : (translator(model.locale)('Move to Trash'))
  return hooked.replace('data-mail-action="delete"', `data-mail-action="${action}"`).replace(`${ICONS.trash}${translator(model.locale)('Delete')}`, `${ICONS.trash}${label}`)
}

const INBOX_SCRIPT = `<script id="xmail-inbox-client">
(function () {
  var root = document.querySelector('[data-board-port="xmail-inbox"]')
  if (!root) return
  if (root.getAttribute('data-mail-folder-workspace') === 'true') return
  const formatMailDateTime = ${DISPLAY_DATETIME_BINDING}
  var mailFolderFlags = ${mailFolderFlags.toString()}
  var mailFolderObject = ${mailFolderObject.toString()}
  var mailFolderUid = ${mailFolderUid.toString()}
  var mailFolderUidValidity = ${mailFolderUidValidity.toString()}
  var mailFolderWriteUncertain = ${mailFolderWriteUncertain.toString()}
  var readFolderSummary = ${readFolderSummary.toString()}
  var readFolderMessage = ${readFolderMessage.toString()}
  var readFolderMove = ${readFolderMove.toString()}
  var list = root.querySelector('[data-mail-list]')
  var pager = root.querySelector('[data-mail-pager]')
  var article = root.querySelector('[data-mail-article]')
  var store = root.querySelector('#xmail-reading')
  var blank = root.querySelector('#xmail-empty')
  var query = root.querySelector('#xmail-query')
  var filter = 'all'
  var rtl = root.getAttribute('dir') === 'rtl'
  var barOn = rtl ? 'inset -3px 0 0 light-dark(#1D5BD6,var(--xp-accent))' : 'inset 3px 0 0 light-dark(#1D5BD6,var(--xp-accent))'
  var text = function (name) { return root.getAttribute(name) || '' }
  var targets = []
  var imagesLoaded = {}
  var pendingActions = 0
  var refreshQueued = false
  var refreshing = false
  var refreshTimer = null
  var readGeneration = 0
  var mutationUncertain = false
  var pinnedMailbox = root.getAttribute('data-mailbox') || '', pinnedFolder = root.getAttribute('data-mail-folder') || ''
  var positiveUint32 = function (value) { return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 4294967295 }
  var observedValidity = function (node, prefix) {
    if (!node || node.getAttribute(prefix + '-uid-validity-observed') !== 'true') return null
    var raw = node.getAttribute(prefix + '-uid-validity') || ''
    if (!/^[1-9][0-9]*$/.test(raw)) return null
    var value = Number(raw)
    return positiveUint32(value) ? value : null
  }
  var updateMutationControls = function () {
    if (root.getAttribute('data-product') !== 'true') return
    var selected = list && list.querySelector('[aria-current="true"]')
    var undo = root.querySelector('[data-mail-undo]')
    var buttons = root.querySelectorAll('[data-mail-action="delete"],[data-mail-action="move"],[data-mail-action="toggle-move"],[data-mail-action="undo"]')
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = pendingActions > 0 || mutationUncertain || (buttons[i].getAttribute('data-mail-action') === 'undo' ? observedValidity(undo, 'data-undo') === null : observedValidity(selected, 'data-mail') === null)
  }
  updateMutationControls()
  var actionFailure = function (error) {
    mutationUncertain = mutationUncertain || mailFolderWriteUncertain(error)
    var stale = root.querySelector('[data-mail-undo]')
    if (stale) stale.remove()
    var status = root.querySelector('[data-mail-action-status]')
    if (!status) {
      status = document.createElement('p'); status.setAttribute('data-mail-action-status', 'true'); status.setAttribute('role', 'alert')
      status.style.cssText = 'margin:0;padding:8px 16px;background:light-dark(#FEF3F2,var(--xp-status-critical-bg));color:light-dark(#B42318,var(--xp-status-critical-fg));font-size:13px'
      var slot = root.querySelector('[data-mail-list-slot]'); if (slot) slot.insertBefore(status, slot.firstChild)
    }
    status.textContent = mutationUncertain ? (xpT('The change outcome is unverified. Reload this mailbox to review it before another change.')) : text('data-move-failed')
    updateMutationControls()
  }
  try { targets = JSON.parse(root.getAttribute('data-move-targets') || '[]') } catch (e) { targets = [] }
  var paintFilters = function () {
    var filters = root.querySelectorAll('[data-mail-filter]')
    for (var i = 0; i < filters.length; i++) {
      var on = filters[i].getAttribute('data-mail-filter') === filter
      filters[i].setAttribute('aria-pressed', on ? 'true' : 'false')
      filters[i].style.background = on ? 'light-dark(#FFFFFF,var(--xp-bg-surface))' : 'transparent'
      filters[i].style.color = on ? 'light-dark(#101828,var(--xp-text-primary))' : 'light-dark(#475467,var(--xp-text-secondary))'
      filters[i].style.fontWeight = on ? '600' : '500'
      filters[i].style.boxShadow = on ? '0 1px 2px rgba(16, 24, 40, 0.08)' : 'none'
    }
  }
  var paint = function (readOnly) {
    if (!list) return 0
    var q = query && query.value ? query.value.trim().toLowerCase() : ''
    var rows = list.querySelectorAll('[data-mail-open]')
    var shown = 0
    var removed = 0
    var available = 0
    for (var i = 0; i < rows.length; i++) {
      var button = rows[i]
      var row = button.parentNode
      if (row.getAttribute('data-removed') === 'true') {
        row.style.display = 'none'
        if (row.getAttribute('data-refresh-tombstone') !== 'true') removed += 1
        continue
      }
      available += 1
      var unread = button.getAttribute('data-unread') === 'true'
      var attach = button.getAttribute('data-attach') === '1'
      var search = (button.getAttribute('data-search') || '').toLowerCase()
      var hit = (filter !== 'unread' || unread) && (filter !== 'attachments' || attach) && (!q || search.indexOf(q) !== -1)
      row.style.display = hit ? '' : 'none'
      if (hit) shown += 1
    }
    if (pager) {
      var listState = root.getAttribute('data-list-state') || 'messages'
      if ((listState === 'unread' || listState === 'failed') && rows.length === 0) pager.textContent = '\u2014'
      else if (listState === 'empty' && available === 0) pager.textContent = pager.getAttribute('data-rest') || ''
      else {
        var loaded = pager.getAttribute('data-loaded') || '0'
        var total = Number(pager.getAttribute('data-total') || loaded)
        var fill = function (template, values) { return Object.keys(values).reduce(function (text, key) { return text.split('{' + key + '}').join(String(values[key])) }, template) }
        var range = root.getAttribute('data-pager-range') || '1\u2013{shown} of {total}'
        var latest = root.getAttribute('data-pager-latest') || '{shown} of the latest {loaded}'
        pager.textContent = (!q && filter === 'all') ? fill(range, { shown: shown, total: total - removed }) : fill(latest, { shown: shown, loaded: loaded })
      }
    }
    var empty = root.querySelector('[data-mail-filter-empty]')
    var slot = root.querySelector('[data-mail-list-slot]')
    var wantEmpty = shown === 0 && available > 0
    if (!empty && slot && wantEmpty) {
      empty = document.createElement('div')
      empty.setAttribute('data-mail-filter-empty', 'true')
      empty.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 24px;text-align:center'
      var heading = document.createElement('h2')
      heading.style.cssText = 'margin:0;font-size:16px;font-weight:600'
      heading.textContent = text('data-empty-title')
      var note = document.createElement('p')
      note.style.cssText = 'margin:0;font-size:13px;color:light-dark(#5D6B7E,var(--xp-text-muted));line-height:1.6;max-width:280px'
      note.textContent = text('data-empty-body')
      var clear = document.createElement('button')
      clear.type = 'button'
      clear.setAttribute('data-mail-action', 'clear')
      clear.style.cssText = 'min-height:44px;padding:0 18px;border-radius:8px;border:1px solid light-dark(#D0D5DD,var(--xp-text-muted));background:light-dark(#FFFFFF,var(--xp-bg-surface));color:light-dark(#101828,var(--xp-text-primary));font-family:inherit;font-size:14px;font-weight:600'
      clear.textContent = text('data-empty-clear')
      empty.appendChild(heading)
      empty.appendChild(note)
      empty.appendChild(clear)
      slot.appendChild(empty)
    }
    if (empty) empty.style.display = wantEmpty ? 'flex' : 'none'
    var current = null
    for (var k = 0; k < rows.length; k++) {
      if (rows[k].getAttribute('aria-current') === 'true') current = rows[k]
    }
    var hidden = !current || current.parentNode.style.display === 'none'
    if (article && blank) {
      var showing = article.querySelector('#msg-subject')
      if (hidden && showing) article.innerHTML = blank.innerHTML
      if (!hidden && !showing && readOnly !== true) show(current.getAttribute('data-mail-open'))
    }
    return shown
  }
  var markRead = function (button) {
    if (button.getAttribute('data-unread') !== 'true') return
    button.setAttribute('data-unread', 'false')
    var dot = button.querySelector('[data-mail-dot]')
    if (dot) dot.style.background = 'transparent'
    var name = button.querySelector('[data-mail-name]')
    var subject = button.querySelector('[data-mail-subject]')
    var time = button.querySelector('[data-mail-time]')
    if (name) name.style.fontWeight = '400'
    if (subject) subject.style.fontWeight = '400'
    if (time) { time.style.fontWeight = '400'; time.style.color = 'light-dark(#5D6B7E,var(--xp-text-muted))' }
    if ((root.getAttribute('data-mail-folder') || 'INBOX') !== 'INBOX') return
    var dropCount = function (node) {
      if (!node) return
      var left = parseInt(node.textContent || '0', 10)
      if (left > 1) node.textContent = String(left - 1)
      else node.remove()
    }
    dropCount(root.querySelector('[data-mail-count="INBOX"]'))
    var headers = document.querySelectorAll('.xp-mail-count')
    for (var h = 0; h < headers.length; h++) dropCount(headers[h])
    var summary = document.querySelector('[data-mail-unread]')
    if (!summary) return
    var nextUnread = Math.max(0, parseInt(summary.getAttribute('data-mail-unread') || '0', 10) - 1)
    summary.setAttribute('data-mail-unread', String(nextUnread))
    summary.textContent = nextUnread > 0 ? (' · ' + xpT('{count} unread', { count: nextUnread })) : ''
  }
  var show = function (id) {
    if (!article) return
    var readToken = ++readGeneration
    var menu = root.querySelector('[data-mail-move]')
    if (menu) menu.remove()
    var toggle = root.querySelector('[data-mail-action="toggle-move"]')
    if (toggle) toggle.setAttribute('aria-expanded', 'false')
    if (!id) {
      if (blank) article.innerHTML = blank.innerHTML
      var rows = list ? list.querySelectorAll('[data-mail-open]') : []
      for (var i = 0; i < rows.length; i++) {
        rows[i].setAttribute('aria-current', 'false')
        rows[i].style.background = 'light-dark(#FFFFFF,var(--xp-bg-surface))'
        rows[i].style.boxShadow = 'none'
      }
      return
    }
    if (!store) return
    var pane = store.content.querySelector('[data-reading-id="' + id + '"]')
    if (!pane) return
    article.innerHTML = pane.innerHTML
    var pendingBody = article.querySelector('[data-mail-body="pending"]') || article.querySelector('[data-mail-detail-body]')
    var opened = list && list.querySelector('[data-mail-open="' + id + '"]')
    var uid = opened && opened.getAttribute('data-mail-uid')
    if (opened && root.getAttribute('data-product') === 'true') { opened.removeAttribute('data-mail-uid-validity'); opened.setAttribute('data-mail-uid-validity-observed', 'false') }
    var capturedMailbox = root.getAttribute('data-mailbox') || '', capturedFolder = root.getAttribute('data-mail-folder') || '', capturedUid = Number(uid)
    if (root.getAttribute('data-product') === 'true' && pendingBody && uid && /^[1-9][0-9]*$/.test(uid) && positiveUint32(capturedUid) && capturedMailbox === pinnedMailbox && capturedFolder === pinnedFolder && capturedMailbox && capturedFolder && typeof window.xpanelSessionRequest === 'function') {
      window.xpanelSessionRequest('GET', '/api/webmail/inbox/' + uid + '?folder=' + encodeURIComponent(capturedFolder)).then(function (data) {
        if (readToken !== readGeneration || !pendingBody.isConnected || !article.isConnected || !opened.isConnected || root.getAttribute('data-mailbox') !== capturedMailbox || root.getAttribute('data-mail-folder') !== capturedFolder) return
        var message = readFolderMessage(data, capturedMailbox, capturedFolder, capturedUid)
        pendingBody.textContent = message.body
        pendingBody.style.whiteSpace = 'pre-wrap'; pendingBody.style.overflowWrap = 'anywhere'; pendingBody.dir = 'auto'
        pendingBody.removeAttribute('data-mail-body')
        var setField = function (selector, value, technical) {
          var node = article.querySelector(selector)
          if (!node) return
          node.textContent = value; node.dir = technical ? 'ltr' : 'auto'; node.style.unicodeBidi = 'isolate'; node.style.textAlign = rtl ? 'right' : 'left'
        }
        setField('[data-mail-detail-subject]', message.subject, false)
        setField('[data-mail-detail-name]', message.fromName || message.from, false)
        setField('[data-mail-detail-from]', '<' + message.from + '>', true)
        setField('[data-mail-detail-to]', message.to, true)
        setField('[data-mail-detail-cc]', message.cc || '', true)
        setField('[data-mail-detail-avatar]', (message.fromName || message.from).slice(0, 2), false)
        var cc = article.querySelector('[data-mail-detail-cc]')
        if (cc && cc.parentElement) { cc.parentElement.hidden = !message.cc; cc.parentElement.style.display = message.cc ? 'grid' : 'none' }
        var date = new Date(message.receivedAt)
        var fullMailDate = formatMailDateTime(message.receivedAt)
        setField('[data-mail-detail-date]', Number.isNaN(date.getTime()) ? message.receivedAt : fullMailDate === '—' ? formatMailDateTime(date) : fullMailDate, true)
        var dateNode = article.querySelector('[data-mail-detail-date]'); if (dateNode) dateNode.setAttribute('datetime', message.receivedAt)
        var replies = article.querySelectorAll('[data-mail-reply]')
        for (var r = 0; r < replies.length; r++) {
          var mode = replies[r].getAttribute('data-mail-reply')
          if (['reply','reply-all','forward'].indexOf(mode) === -1) continue
          var href = new URL('/mail/compose', window.location.href); href.searchParams.set('mode', mode); href.searchParams.set('uid', String(capturedUid)); href.searchParams.set('folder', capturedFolder)
          replies[r].href = href.pathname + href.search
        }
        if (message.unread === false) markRead(opened)
        if (message.uidValidityObserved === true && positiveUint32(message.uidValidity)) {
          opened.setAttribute('data-mail-uid-validity', String(message.uidValidity)); opened.setAttribute('data-mail-uid-validity-observed', 'true')
          article.dispatchEvent(new CustomEvent('xpanel:mail-message-read', { bubbles: true, detail: { mailbox: capturedMailbox, folder: capturedFolder, uid: capturedUid, uidValidity: message.uidValidity, uidValidityObserved: true } }))
        }
        updateMutationControls()
      }).catch(function () {
        if (readToken === readGeneration && pendingBody.isConnected) pendingBody.textContent = text('data-body-failed')
      })
    }
    if (imagesLoaded[id]) {
      var blocked = article.querySelector('[data-mail-images]')
      if (blocked) blocked.remove()
    }
    var rows = list ? list.querySelectorAll('[data-mail-open]') : []
    for (var j = 0; j < rows.length; j++) {
      var button = rows[j]
      var on = button.getAttribute('data-mail-open') === id
      button.setAttribute('aria-current', on ? 'true' : 'false')
      button.style.background = on ? 'light-dark(#F3F7FE,var(--xp-accent-soft))' : 'light-dark(#FFFFFF,var(--xp-bg-surface))'
      button.style.boxShadow = on ? barOn : 'none'
      if (on && root.getAttribute('data-product') !== 'true') markRead(button)
    }
    updateMutationControls()
  }
  root.addEventListener('click', function (event) {
    var target = event.target
    if (!target || !target.closest) return
    var open = target.closest('[data-mail-open]')
    if (open && open.parentNode.getAttribute('data-removed') !== 'true') {
      show(open.getAttribute('data-mail-open'))
      return
    }
    var filterButton = target.closest('[data-mail-filter]')
    if (filterButton) {
      filter = filterButton.getAttribute('data-mail-filter') || 'all'
      paintFilters()
      paint()
      return
    }
    var action = target.closest('[data-mail-action]')
    if (!action) return
    var name = action.getAttribute('data-mail-action')
    if (name === 'refresh') {
      if (root.getAttribute('data-product') === 'true') scheduleRefresh()
      return
    }
    if (name === 'clear') {
      if (query) query.value = ''
      filter = 'all'
      paintFilters()
      paint()
    }
    if (name === 'toggle-move') {
      var menu = root.querySelector('[data-mail-move]')
      if (menu) {
        menu.remove()
        action.setAttribute('aria-expanded', 'false')
      } else {
        var holder = action.parentNode
        menu = document.createElement('ul')
        menu.id = 'move-list'
        menu.setAttribute('data-mail-move', 'true')
        menu.setAttribute('aria-label', text('data-move-label'))
        menu.style.cssText = 'position:absolute;top:50px;inset-inline-start:0;z-index:2;list-style:none;margin:0;padding:6px;min-width:200px;border-radius:10px;border:1px solid light-dark(#E2E6EC,var(--xp-border));background:light-dark(#FFFFFF,var(--xp-bg-surface));box-shadow:0 8px 24px rgba(16, 24, 40, 0.12);display:flex;flex-direction:column;gap:2px'
        targets.forEach(function (folder) {
          var id = folder && typeof folder === 'object' ? String(folder.id || '') : String(folder || '')
          var label = folder && typeof folder === 'object' ? String(folder.label || id) : String(folder || '')
          var li = document.createElement('li')
          var button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('data-mail-action', 'move')
          button.setAttribute('data-folder', id)
          button.setAttribute('data-folder-label', label)
          button.textContent = label
          button.style.cssText = 'width:100%;min-height:40px;padding:0 12px;border-radius:8px;border:none;background:transparent;color:light-dark(#101828,var(--xp-text-primary));font-family:inherit;font-size:14px;text-align:start'
          li.appendChild(button)
          menu.appendChild(li)
        })
        holder.appendChild(menu)
        action.setAttribute('aria-expanded', 'true')
      }
    }
    if (name === 'delete' || name === 'move') {
      var current = list && list.querySelector('[aria-current="true"]')
      if (!current || current.parentNode.getAttribute('data-removed') === 'true') return
      var product = root.getAttribute('data-product') === 'true'
      var uid = current.getAttribute('data-mail-uid')
      var fromFolder = root.getAttribute('data-mail-folder') || 'INBOX'
      var folderId = name === 'delete' ? 'Trash' : (action.getAttribute('data-folder') || '')
      var folder = name === 'delete' ? text('data-trash-label') : (action.getAttribute('data-folder-label') || action.getAttribute('data-folder') || '')
      var visible = []
      var nodes = list.querySelectorAll('[data-mail-open]')
      for (var i = 0; i < nodes.length; i++) {
        var row = nodes[i].parentNode
        if (row.getAttribute('data-removed') === 'true' || row.style.display === 'none') continue
        visible.push(nodes[i])
      }
      var idx = visible.indexOf(current)
      var next = visible[idx + 1] || visible[idx - 1] || null
      var finish = function (showUndo) {
        current.parentNode.setAttribute('data-removed', 'true')
        markRead(current)
        var bar = root.querySelector('[data-mail-undo]')
        if (!bar) {
          bar = document.createElement('div')
          bar.setAttribute('data-mail-undo', 'true')
          bar.setAttribute('role', 'status')
          bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 16px;background:light-dark(#101828,var(--xp-bg-elevated));color:light-dark(#FFFFFF,var(--xp-text-primary));font-size:13px'
          var label = document.createElement('span')
          label.setAttribute('data-mail-undo-text', 'true')
          var undo = document.createElement('button')
          undo.type = 'button'
          undo.setAttribute('data-mail-action', 'undo')
          undo.textContent = text('data-undo-label')
          undo.style.cssText = 'min-height:40px;padding:0 12px;border-radius:8px;border:1px solid light-dark(#475467,var(--xp-text-secondary));background:transparent;color:light-dark(#FFFFFF,var(--xp-text-primary));font-family:inherit;font-size:13px;font-weight:600'
          if (!showUndo) undo.hidden = true
          bar.appendChild(label)
          bar.appendChild(undo)
          var slot = root.querySelector('[data-mail-list-slot]')
          if (slot) slot.insertBefore(bar, slot.firstChild)
        }
        var undoText = bar.querySelector('[data-mail-undo-text]')
        var subject = current.querySelector('[data-mail-subject]')
        var undoBtn = bar.querySelector('[data-mail-action="undo"]')
        if (undoBtn) undoBtn.hidden = !showUndo
        if (undoText) undoText.textContent = showUndo
          ? text('data-moved-message').split(/([{]folder[}]|[{]subject[}])/).map(function (part) { return part === '{folder}' ? folder : part === '{subject}' ? (subject ? subject.textContent : '') : part }).join('')
          : text('data-deleted-label')
        bar.setAttribute('data-removed-id', current.getAttribute('data-mail-open') || '')
        if (next) show(next.getAttribute('data-mail-open'))
        else show(null)
        paint()
      }
      if (product) {
        var uidValidity = observedValidity(current, 'data-mail')
        var mutationMailbox = root.getAttribute('data-mailbox') || ''
        if (mutationMailbox !== pinnedMailbox || fromFolder !== pinnedFolder || !uid || !positiveUint32(Number(uid)) || uidValidity === null || pendingActions > 0 || mutationUncertain || typeof window.xpanelSessionRequest !== 'function') return
        var trashNow = name === 'delete' && fromFolder === 'Trash'
        if (trashNow && typeof window.confirm === 'function' && !window.confirm(text('data-trash-confirm'))) return
        var path = '/api/webmail/inbox/' + encodeURIComponent(uid)
        pendingActions += 1
        updateMutationControls()
        var pending = name === 'move' || (name === 'delete' && !trashNow)
          ? window.xpanelSessionRequest('POST', path + '/move', { folder: name === 'delete' ? 'Trash' : folderId, from: fromFolder, uidValidity: uidValidity })
          : window.xpanelSessionRequest('DELETE', path + '?folder=' + encodeURIComponent(fromFolder) + '&confirm=delete', { uidValidity: uidValidity })
        pending.then(function (result) {
          if (!root.isConnected || !current.isConnected || root.getAttribute('data-mailbox') !== mutationMailbox || root.getAttribute('data-mail-folder') !== fromFolder) return
          var ack
          if (trashNow) {
            if (!result || mailFolderFlags(result) || result.ok !== true || result.uid !== Number(uid) || result.folder !== 'Trash' || result.sourceUidValidity !== uidValidity || result.permanent !== true || result.stateChanged !== true) throw new Error('invalid_delete_receipt')
          } else {
            ack = readFolderMove(result, mutationMailbox, fromFolder, Number(uid), name === 'delete' ? 'Trash' : folderId, uidValidity)
            if (!ack.stateChanged) return
            if (!ack.destinationUidKnown || ack.uid === null || ack.uidValidityObserved !== true || !positiveUint32(ack.uidValidity)) throw new Error('unverified_destination')
          }
          finish(!trashNow)
          var bar = root.querySelector('[data-mail-undo]')
          if (bar && ack) {
            bar.setAttribute('data-undo-uid', String(ack.uid))
            bar.setAttribute('data-undo-from', name === 'delete' ? 'Trash' : folderId)
            bar.setAttribute('data-undo-to', fromFolder)
            bar.setAttribute('data-undo-uid-validity', String(ack.uidValidity)); bar.setAttribute('data-undo-uid-validity-observed', 'true')
          } else if (bar) {
            ['data-undo-uid','data-undo-from','data-undo-to','data-undo-uid-validity','data-undo-uid-validity-observed'].forEach(function (key) { bar.removeAttribute(key) })
          }
        }).catch(function (err) {
          current.parentNode.removeAttribute('data-removed')
          var stale = root.querySelector('[data-mail-undo]')
          if (stale) stale.remove()
          var status = root.querySelector('[data-mail-action-status]')
          if (!status) {
            status = document.createElement('p')
            status.setAttribute('data-mail-action-status', 'true')
            status.setAttribute('role', 'alert')
            status.style.cssText = 'margin:0;padding:8px 16px;background:light-dark(#FEF3F2,var(--xp-status-critical-bg));color:light-dark(#B42318,var(--xp-status-critical-fg));font-size:13px'
            var slot = root.querySelector('[data-mail-list-slot]')
            if (slot) slot.insertBefore(status, slot.firstChild)
          }
          actionFailure(err)
          paint()
        }).finally(completeAction)
        return
      }
      finish(true)
    }
    if (name === 'undo') {
      var undoBar = root.querySelector('[data-mail-undo]')
      var id = undoBar && undoBar.getAttribute('data-removed-id')
      var restoreRow = function (result) {
        var back = id && list && list.querySelector('[data-mail-open="' + id + '"]')
        if (back && result && Number.isInteger(result.uid) && result.uid > 0 && result.uid <= 4294967295) {
          var restoredId = 'uid-' + result.uid
          var cached = store && store.content.querySelector('[data-reading-id="' + id + '"]')
          if (cached) cached.setAttribute('data-reading-id', restoredId)
          back.setAttribute('data-mail-open', restoredId)
          back.setAttribute('data-mail-uid', String(result.uid))
          id = restoredId
        }
        if (back) back.parentNode.removeAttribute('data-removed')
        if (undoBar) undoBar.remove()
        if (id) show(id)
        paint()
      }
      var undoUid = undoBar && undoBar.getAttribute('data-undo-uid')
      if (root.getAttribute('data-product') === 'true') {
        var undoValidity = observedValidity(undoBar, 'data-undo')
        var undoFrom = undoBar && undoBar.getAttribute('data-undo-from'), undoTo = undoBar && undoBar.getAttribute('data-undo-to')
        if (root.getAttribute('data-mailbox') !== pinnedMailbox || root.getAttribute('data-mail-folder') !== pinnedFolder || !undoUid || !positiveUint32(Number(undoUid)) || undoValidity === null || !undoFrom || !undoTo || pendingActions > 0 || mutationUncertain || typeof window.xpanelSessionRequest !== 'function') return
        pendingActions += 1
        updateMutationControls()
        window.xpanelSessionRequest('POST', '/api/webmail/inbox/' + encodeURIComponent(undoUid) + '/move', {
          folder: undoTo,
          from: undoFrom,
          uidValidity: undoValidity,
        }).then(function (result) {
          if (!root.isConnected || root.getAttribute('data-mailbox') !== pinnedMailbox || root.getAttribute('data-mail-folder') !== pinnedFolder) return
          var ack = readFolderMove(result, pinnedMailbox, undoFrom, Number(undoUid), undoTo, undoValidity)
          if (!ack.stateChanged || !ack.destinationUidKnown || ack.uid === null || ack.uidValidityObserved !== true || !positiveUint32(ack.uidValidity)) throw new Error('unverified_undo')
          restoreRow(ack)
        }).catch(function (err) {
          var status = root.querySelector('[data-mail-action-status]')
          if (!status) {
            status = document.createElement('p')
            status.setAttribute('data-mail-action-status', 'true')
            status.setAttribute('role', 'alert')
            status.style.cssText = 'margin:0;padding:8px 16px;background:light-dark(#FEF3F2,var(--xp-status-critical-bg));color:light-dark(#B42318,var(--xp-status-critical-fg));font-size:13px'
            var slot = root.querySelector('[data-mail-list-slot]')
            if (slot) slot.insertBefore(status, slot.firstChild)
          }
          actionFailure(err)
        }).finally(completeAction)
        return
      }
      restoreRow()
    }
    if (name === 'load-images') {
      var note = action.closest('[data-mail-images]')
      var openId = list && list.querySelector('[aria-current="true"]')
      if (openId) imagesLoaded[openId.getAttribute('data-mail-open')] = true
      if (note) note.remove()
    }
  })
  // Keep the current board and its interaction state; only import trusted read-only view data.
  var safeClone = function (node) {
    var copy = document.importNode(node, true)
    var forbidden = copy.querySelectorAll('script,iframe,object,embed,style,link,meta,base,form,img,video,audio,source')
    for (var i = 0; i < forbidden.length; i++) forbidden[i].remove()
    var elements = Array.prototype.slice.call(copy.querySelectorAll('*'))
    if (copy.nodeType === 1) elements.unshift(copy)
    elements.forEach(function (element) {
      Array.prototype.slice.call(element.attributes || []).forEach(function (attribute) {
        var name = attribute.name.toLowerCase()
        if (name.indexOf('on') === 0 || name === 'srcdoc') element.removeAttribute(attribute.name)
        if (name === 'href' || name === 'src') {
          try { if (new URL(attribute.value, window.location.href).origin !== window.location.origin || !/^https?:/i.test(new URL(attribute.value, window.location.href).protocol)) element.removeAttribute(attribute.name) }
          catch (error) { element.removeAttribute(attribute.name) }
        }
      })
    })
    return copy
  }
  var refreshStatus = function (failed) {
    var status = root.querySelector('[data-mail-refresh-status]')
    if (!failed) { if (status) status.remove(); return }
    if (!status) {
      status = document.createElement('p')
      status.setAttribute('data-mail-refresh-status', 'true')
      status.setAttribute('role', 'status')
      var slot = root.querySelector('[data-mail-list-slot]')
      if (slot) slot.insertBefore(status, slot.firstChild)
    }
    status.textContent = xpT('Mail could not be refreshed. Showing the last loaded data.')
  }
  var completeAction = function () {
    pendingActions = Math.max(0, pendingActions - 1)
    updateMutationControls()
    if (refreshQueued) scheduleRefresh()
  }
  var refresh = function () {
    refreshTimer = null
    if (!root.isConnected || refreshing || pendingActions > 0 || !refreshQueued) return
    refreshQueued = false
    refreshing = true
    var folder = root.getAttribute('data-mail-folder') || 'INBOX'
    var mailbox = root.getAttribute('data-mailbox') || ''
    var url = new URL(window.location.href)
    if (url.origin !== window.location.origin || url.pathname !== '/mail/inbox') { refreshing = false; return }
    url.searchParams.set('folder', folder)
    window.fetch(url.href, { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html', 'x-xpanel-mail-refresh': 'list' } }).then(function (response) {
      if (!response.ok || response.redirected || (response.url && new URL(response.url, url.href).origin !== url.origin)) throw new Error('mail refresh unavailable')
      return response.text()
    }).then(function (html) {
      if (!root.isConnected || folder !== (root.getAttribute('data-mail-folder') || 'INBOX') || mailbox !== root.getAttribute('data-mailbox')) return
      if (pendingActions > 0) { refreshQueued = true; return }
      var incoming = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-board-port="xmail-inbox"]')
      if (!incoming || incoming.getAttribute('data-mailbox') !== mailbox || (incoming.getAttribute('data-mail-folder') || 'INBOX') !== folder || ['messages', 'empty'].indexOf(incoming.getAttribute('data-list-state')) === -1) throw new Error('mail refresh unavailable')
      var nextList = incoming.querySelector('[data-mail-list]')
      var nextStore = incoming.querySelector('#xmail-reading')
      if (!nextList || !nextStore || !list || !store) throw new Error('mail refresh unavailable')
      var selected = list.querySelector('[aria-current="true"]')
      var selectedId = selected && selected.getAttribute('data-mail-open')
      var focus = document.activeElement && document.activeElement.getAttribute('data-mail-open')
      var undo = root.querySelector('[data-mail-undo]')
      var undoButton = undo && undo.querySelector('[data-mail-action="undo"]')
      var undoId = undo && undoButton && !undoButton.hidden ? undo.getAttribute('data-removed-id') : null
      var removed = Array.prototype.slice.call(list.querySelectorAll('[data-removed="true"]')).filter(function (row) {
        var button = row.querySelector('[data-mail-open]')
        return undoId && button && button.getAttribute('data-mail-open') === undoId
      })
      var replacement = safeClone(nextList)
      var replacementStore = safeClone(nextStore.content)
      var rows = replacement.querySelectorAll('[data-mail-open]')
      for (var i = 0; i < rows.length; i++) {
        var uidText = rows[i].getAttribute('data-mail-uid')
        var uid = Number(uidText)
        if (!Number.isInteger(uid) || uid <= 0 || uid > 4294967295 || String(uid) !== uidText || rows[i].getAttribute('data-mail-open') !== 'uid-' + uid) throw new Error('mail refresh unavailable')
        var on = rows[i].getAttribute('data-mail-open') === selectedId
        // The open message keeps the UIDVALIDITY its actual read observed; every write still sends it for server comparison.
        if (on && selected.getAttribute('data-mail-uid-validity-observed') === 'true') { rows[i].setAttribute('data-mail-uid-validity', selected.getAttribute('data-mail-uid-validity') || ''); rows[i].setAttribute('data-mail-uid-validity-observed', 'true') }
        rows[i].setAttribute('aria-current', on ? 'true' : 'false')
        rows[i].style.background = on ? 'light-dark(#F3F7FE,var(--xp-accent-soft))' : 'light-dark(#FFFFFF,var(--xp-bg-surface))'
        rows[i].style.boxShadow = on ? barOn : 'none'
      }
      removed.forEach(function (row) {
        var button = row.querySelector('[data-mail-open]')
        var id = button && button.getAttribute('data-mail-open')
        var newer = id && replacement.querySelector('[data-mail-open="' + id + '"]')
        if (newer) newer.parentNode.setAttribute('data-removed', 'true')
        else { var tombstone = row.cloneNode(true); tombstone.setAttribute('data-refresh-tombstone', 'true'); replacement.appendChild(tombstone) }
        var oldPane = id && store.content.querySelector('[data-reading-id="' + id + '"]')
        if (oldPane && !replacementStore.querySelector('[data-reading-id="' + id + '"]')) replacementStore.appendChild(safeClone(oldPane))
      })
      var scroll = list.parentNode.scrollTop
      list.replaceChildren.apply(list, Array.prototype.slice.call(replacement.childNodes))
      store.content.replaceChildren(replacementStore)
      root.setAttribute('data-list-state', incoming.getAttribute('data-list-state'))
      var oldState = root.querySelectorAll('[data-mail-list-state],[data-mail-empty-list]')
      for (var s = 0; s < oldState.length; s++) oldState[s].remove()
      var empty = incoming.querySelector('[data-mail-empty-list]')
      if (empty) list.parentNode.appendChild(safeClone(empty))
      var nextPager = incoming.querySelector('[data-mail-pager]')
      if (pager && nextPager) ['data-loaded', 'data-total', 'data-rest'].forEach(function (name) { pager.setAttribute(name, nextPager.getAttribute(name) || '') })
      var summary = root.querySelector('[data-mail-count-summary]')
      var nextSummary = incoming.querySelector('[data-mail-count-summary]')
      if (summary && nextSummary) summary.replaceChildren.apply(summary, Array.prototype.slice.call(safeClone(nextSummary).childNodes))
      var counts = root.querySelectorAll('[data-mail-count]')
      for (var c = 0; c < counts.length; c++) {
        var counterpart = incoming.querySelector('[data-mail-count="' + counts[c].getAttribute('data-mail-count') + '"]')
        if (counterpart) counts[c].replaceWith(safeClone(counterpart))
        else counts[c].remove()
      }
      var observedCounts = incoming.querySelectorAll('[data-mail-count]')
      var anchors = root.querySelectorAll('a[data-nav-route]')
      for (var n = 0; n < observedCounts.length; n++) {
        if (root.querySelector('[data-mail-count="' + observedCounts[n].getAttribute('data-mail-count') + '"]')) continue
        var route = observedCounts[n].parentNode.getAttribute('data-nav-route')
        for (var a = 0; a < anchors.length; a++) { if (anchors[a].getAttribute('data-nav-route') === route) { anchors[a].appendChild(safeClone(observedCounts[n])); break } }
      }
      paint(true)
      updateMutationControls()
      list.parentNode.scrollTop = scroll
      if (focus) { var focused = list.querySelector('[data-mail-open="' + focus + '"]'); if (focused) focused.focus({ preventScroll: true }) }
      refreshStatus(false)
    }).catch(function () { if (root.isConnected) refreshStatus(true) }).finally(function () {
      refreshing = false
      if (refreshQueued) scheduleRefresh()
    })
  }
  var scheduleRefresh = function () {
    refreshQueued = true
    if (refreshTimer === null && !refreshing && pendingActions === 0) refreshTimer = window.setTimeout(refresh, 50)
  }
  document.addEventListener('xpanel:mail-invalidated', function (event) {
    var detail = event.detail
    if (root.getAttribute('data-product') !== 'true' || !detail || typeof detail.mailbox !== 'string' || detail.mailbox.toLowerCase() !== (root.getAttribute('data-mailbox') || '').toLowerCase()) return
    scheduleRefresh()
  })
  if (query) {
    query.addEventListener('input', paint)
    try {
      var initialQuery = new URL(window.location.href).searchParams.get('q')
      if (initialQuery) { query.value = initialQuery.slice(0, 1024); paint(true) }
    } catch (e) { /* Keep the current filter when no document URL is available. */ }
  }
  var opened = list && list.querySelector('[aria-current="true"]')
  // Product rows stay unread until an actual server read observes them as read.
  if (opened && opened.parentNode.style.display !== 'none' && root.getAttribute('data-product') !== 'true') markRead(opened)
})()
</script>`

export const renderInbox = (model: InboxModel): string => {
  const rtl = localeDirection(model.locale) === 'rtl'
  const font = rtl ? FONT_AR : FONT_EN
  const selected = model.messages.find(card => card.id === model.selectedId) ?? null
  const rows = model.messages.map(card => messageRow(card, card.id === model.selectedId, model.locale)).join('')
  const panes = model.messages.map(card => `<div data-reading-id="${escapeHtml(card.id)}">${readingInner(card, model)}</div>`).join('')
  const mailbox = `<bdi dir="ltr">${escapeHtml(model.mailbox)}</bdi>`
  const quota = tech(model.quotaText, rtl)
  const filterBtn = (key: string, label: string, on: boolean): string =>
    `<button type="button" data-mail-filter="${key}" aria-pressed="${on ? 'true' : 'false'}" style="min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 8px; border: none; background: ${on ? 'light-dark(#FFFFFF,var(--xp-bg-surface))' : 'transparent'}; color: ${on ? 'light-dark(#101828,var(--xp-text-primary))' : 'light-dark(#475467,var(--xp-text-secondary))'}; font-family: inherit; font-size: 13px; font-weight: ${on ? '600' : '500'}; box-shadow: ${on ? '0 1px 2px rgba(16, 24, 40, 0.08)' : 'none'}">${escapeHtml(label)}</button>`
  const listEmpty = model.folderEmpty
    ? `<div data-mail-empty-list="true" style="display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 24px; text-align: center"><h2 style="margin: 0; font-size: 16px; font-weight: 600">${translator(model.locale)('No messages in this folder.')}</h2><p style="margin: 0; font-size: 13px; color: light-dark(#5D6B7E,var(--xp-text-muted)); line-height: 1.6; max-width: 280px">${translator(model.locale)(msgctxt('xmail-inbox', 'Nothing in this folder is waiting to be read.'))}</p></div>`
    : ''
  const article = selected
    ? `<article data-mail-pane="reading-pane" data-mail-article="true" aria-label="${translator(model.locale)('Reading pane')}" style="flex: 2.618 1 420px; min-width: 0; background: light-dark(#FFFFFF,var(--xp-bg-surface)); display: flex; flex-direction: column">${readingInner(selected, model)}</article>`
    : `<article data-mail-pane="reading-pane" data-mail-article="true" aria-label="${translator(model.locale)('Reading pane')}" style="flex: 2.618 1 420px; min-width: 0; background: light-dark(#FFFFFF,var(--xp-bg-surface)); display: flex; flex-direction: column">${emptyReading(model.locale, model.folderEmpty)}</article>`
  const route = model.product ? '/mail/inbox' : ''
  const copy = model.copy
  // The live count text ends with " · N unread"; that tail is repainted separately when a message is read.
  const unreadTail = / · (\d+) [^·]+$/.exec(model.countText)
  const countTail = unreadTail && [`${unreadTail[1]} unread`, translator(model.locale)('{count} unread', { count: Number(unreadTail[1]) })].some(tail => unreadTail[0] === ' · ' + tail) ? unreadTail[0] : ''
  const templateCard: MailCard = { id: 'folder-current', uid: 1, fromName: '', fromAddr: '', to: '', cc: ' ', subject: '', snippet: '', time: '', datetime: '', unread: false, auth: '', attachments: [{ name: '', ext: '', size: '' }], blocks: [block('')] }
  const workspaceTemplates = model.folderWorkspace ? `<template data-mail-folder-row-template>${messageRow(templateCard, false, model.locale)}</template><template data-mail-folder-reading-template>${readingInner(templateCard, model)}</template>` : ''
  const listNote = model.listState === 'failed'
    ? (translator(model.locale)('The mail server could not be read.'))
    : model.listState === 'unread'
      ? (translator(model.locale)('The inbox has not been read from the mail server.'))
      : ''
  return `<div class="xp-board-port xp-shell" data-board-port="xmail-inbox" data-surface="xmail" data-mail-layout="reference" data-product="${model.product ? 'true' : 'false'}"${model.folderWorkspace ? ' data-mail-folder-workspace="true"' : ''} data-mail-folder="${escapeHtml(model.activeFolder)}" data-pager-range="${escapeHtml(translator(model.locale)('1\u2013{shown} of {total}'))}" data-pager-latest="${escapeHtml(translator(model.locale)('{shown} of the latest {loaded}'))}" data-mailbox="${escapeHtml(model.mailbox)}" data-locale="${model.locale}" data-list-state="${model.listState}" data-body-failed="${escapeHtml(translator(model.locale)('The message body could not be read.'))}" data-move-targets="${escapeHtml(JSON.stringify(model.moveTargets))}" data-move-label="${escapeHtml(copy.moveLabel)}" data-empty-title="${escapeHtml(copy.emptyTitle)}" data-empty-body="${escapeHtml(copy.emptyBody)}" data-empty-clear="${escapeHtml(copy.emptyClear)}" data-undo-label="${escapeHtml(copy.undo)}" data-moved-message="${escapeHtml(copy.moved)}" data-trash-label="${escapeHtml(translator(model.locale)(msgctxt('xmail-inbox', 'Trash')))}" data-trash-confirm="${escapeHtml(translator(model.locale)('Delete this message permanently?'))}" data-deleted-label="${escapeHtml(translator(model.locale)(msgctxt('xmail-inbox', 'Deleted')))}" data-move-failed="${escapeHtml(translator(model.locale)('The message could not be moved.'))}"${rtl ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-direction: column; background: light-dark(#F5F6F8,var(--xp-bg-canvas)); font-family: ${font}; color: light-dark(#101828,var(--xp-text-primary))">
<style>${PORT_CSS}</style>
<a class="xp-skip-link" href="#main-content">${translator(model.locale)('Skip to content')}</a>
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 12px 24px; background: light-dark(#FFFFFF,var(--xp-bg-surface)); border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border))">${renderMobileNavToggle(model.locale)}
  <a href="${escapeHtml(model.inboxHref)}" style="display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none"><span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: light-dark(#0E7A4E,var(--xp-status-ok-fg)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span><span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#0E7A4E,var(--xp-status-ok-fg))">${rtl ? `<bdi dir="ltr">xMail</bdi>` : 'xMail'}</span></a>
  <form role="search" action="${escapeHtml(model.inboxHref)}" method="get" aria-label="${translator(model.locale)('Search mail')}" style="flex: 1 1 280px; max-width: 520px; position: relative; display: flex; align-items: center; margin: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#5D6B7E,var(--xp-text-muted))" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg><input type="hidden" name="lang" value="${model.locale}"><input type="hidden" name="theme" value="${model.theme ?? 'light'}"><input type="hidden" name="folder" value="${escapeHtml(model.activeFolder)}"><input id="xmail-query" type="search" name="q" aria-label="${translator(model.locale)('Search mail')}" placeholder="${translator(model.locale)('Search sender, subject or text')}" style="width: 100%; min-height: 44px; padding-inline: 38px 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary))"></form>
  <span style="flex: 1 1 0; min-width: 0"></span>
  <div style="display: flex; align-items: center; gap: 8px; min-width: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#475467,var(--xp-text-secondary))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><span data-mail-mailbox="true" style="min-width: 0; font-family: ${MONO}; font-size: 13px; color: light-dark(#101828,var(--xp-text-primary)); overflow-wrap: anywhere">${mailbox}</span></div>
  <div data-mail-quota style="display: flex; flex-direction: column; gap: 4px; min-width: 150px"><div style="display: flex; flex-direction: column; gap: 4px; font-size: 12px"><span data-mail-quota-label style="font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${translator(model.locale)('Mailbox')}</span><span data-mail-quota-value style="color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${quota}</span></div><div data-quota-ratio="${model.quotaMeasured ? 'measured' : 'unknown'}" aria-hidden="true" style="height: 6px; border-radius: 3px; background: light-dark(#E9ECF1,var(--xp-bg-elevated)); overflow: hidden"><div style="height: 6px; width: ${model.quotaPct}%; background: light-dark(#1D5BD6,var(--xp-accent)); border-radius: 3px"></div></div></div>
  ${renderPageSearchButton(model.locale)}
  ${LOCALES.filter(info => info.tag !== model.locale).map(info => `<a href="?lang=${info.tag}" data-lang-switch="${info.tag}" lang="${info.tag}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: light-dark(#1D5BD6,var(--xp-accent)); text-decoration: none">${escapeHtml(info.nativeName)}</a>`).join('')}
  <a href="?theme=${model.theme === 'dark' ? 'light' : 'dark'}" data-theme-toggle="${model.theme === 'dark' ? 'light' : 'dark'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: light-dark(#1D5BD6,var(--xp-accent)); text-decoration: none">${model.theme === 'dark' ? (translator(model.locale)('Light theme')) : (translator(model.locale)('Dark theme'))}</a>
  ${model.wsHtml}
  <button type="button"${model.logoutAttr} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${translator(model.locale)('Sign out')}</button>
</header>
<div data-xp-shell-content="true" style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
  <nav aria-label="${translator(model.locale)('Mail folders')}" class="xp-sidebar" id="xp-sidebar" tabindex="-1" data-xp-sidebar data-mail-pane="folders" style="flex: 1 1 200px; max-width: 100%; background: light-dark(#FFFFFF,var(--xp-bg-surface)); border-inline-end: 1px solid light-dark(#E2E6EC,var(--xp-border)); padding: 16px 12px; display: flex; flex-direction: column; gap: 18px">${renderMobileNavClose(model.locale)}
    <a href="${escapeHtml(model.composeHref)}" data-nav-route="/mail/compose" style="min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid light-dark(#1D5BD6,var(--xp-accent)); background: light-dark(#1D5BD6,var(--xp-accent)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); font-size: 14px; font-weight: 600; text-decoration: none">${ICONS.compose}${translator(model.locale)('Compose')}</a>
    <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.folders.map(item => folderLink(item, route)).join('')}</ul>
    <div style="display: flex; flex-direction: column; gap: 2px"><span id="my-folders" style="font-size: 11px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted)); padding: 0 12px 4px">${translator(model.locale)('Your folders')}</span><ul aria-labelledby="my-folders" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.custom.map(item => folderLink(item, route)).join('')}</ul><button type="button" data-mail-new-folder="true"${model.product ? ' disabled aria-describedby="mail-folder-availability"' : ''} style="min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-radius: 8px; border: 1px dashed light-dark(#C9CFD8,var(--xp-border-strong)); background: transparent; color: light-dark(#1D5BD6,var(--xp-accent)); font-family: inherit; font-size: 13px; font-weight: 600; margin-top: 4px"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>${translator(model.locale)('New folder')}</button>${model.product ? `<span id="mail-folder-availability" role="note" style="display:block;margin-block-start:8px;font-size:12px;line-height:1.6;color:light-dark(#475467,var(--xp-text-secondary))">${translator(model.locale)('Folder creation is unavailable from this interface.')}</span>` : ''}</div>
    <div style="display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border))"><span id="mbx-settings" style="font-size: 11px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted)); padding: 0 12px 4px">${translator(model.locale)('Mailbox settings')}</span><ul aria-labelledby="mbx-settings" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px"><li><a href="${escapeHtml(model.vacationHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none"><span>${translator(model.locale)('Vacation responder')}</span><span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${escapeHtml(model.vacation)}</span></a></li><li><a href="${escapeHtml(model.filtersHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none"><span>${translator(model.locale)('Filters')}</span><span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${escapeHtml(model.filters)}</span></a></li></ul></div>
  </nav>${renderMobileNavBackdrop(model.locale)}
  <main id="main-content" tabindex="-1" data-mail-live="true" style="flex: 4.236 1 740px; min-width: 0; display: flex; flex-direction: column">
    ${model.actionHtml}
    ${model.folderWorkspace ? `<div data-mail-folder-feedback style="flex:none;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid light-dark(#E2E6EC,var(--xp-border));background:light-dark(#FFFFFF,var(--xp-bg-surface))"><p data-mail-folder-status data-state="unread" role="status" aria-live="polite" style="flex:1 1 240px;margin:0;font-size:14px;line-height:1.75">${translator(model.locale)('Folder data has not been read yet.')}</p><button type="button" data-mail-folder-review data-mail-action="review" hidden style="min-height:44px;padding:0 14px;border:1px solid light-dark(#D0D5DD,var(--xp-text-muted));border-radius:8px;background:light-dark(#FFFFFF,var(--xp-bg-surface));color:light-dark(#101828,var(--xp-text-primary));font:inherit">${translator(model.locale)('Review folder')}</button><div data-mail-undo hidden><button type="button" data-mail-action="undo" style="min-height:44px;padding:0 14px;border:1px solid light-dark(#D0D5DD,var(--xp-text-muted));border-radius:8px;background:light-dark(#FFFFFF,var(--xp-bg-surface));color:light-dark(#101828,var(--xp-text-primary));font:inherit">${escapeHtml(copy.undo)}</button></div></div>` : ''}
    <div data-mail-panes style="flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: stretch">
    <section aria-labelledby="list-title" data-mail-pane="message-list" style="flex: 1.618 1 320px; min-width: 0; background: light-dark(#FFFFFF,var(--xp-bg-surface)); border-inline-end: 1px solid light-dark(#E2E6EC,var(--xp-border)); display: flex; flex-direction: column">
      <div style="padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border))">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap"><h1 id="list-title" style="margin: 0; font-size: 20px; font-weight: 600">${escapeHtml(model.title)}</h1><span data-mail-count-summary="true" style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted)); font-variant-numeric: tabular-nums">${escapeHtml(countTail ? model.countText.slice(0, -countTail.length) : model.countText)}<span data-mail-unread="${model.unreadCount ?? 0}">${escapeHtml((model.unreadCount ?? 0) > 0 ? countTail : '')}</span></span></div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap"><div role="group" aria-label="${translator(model.locale)('Show')}" style="display: inline-flex; padding: 2px; border-radius: 10px; background: light-dark(#EEF0F3,var(--xp-bg-elevated)); gap: 2px">${filterBtn('all', translator(model.locale)('All'), true)}${filterBtn('unread', translator(model.locale)(msgctxt('xmail-inbox', 'Unread')), false)}${filterBtn('attachments', translator(model.locale)('With attachments'), false)}</div><span style="flex: 1 1 0"></span><button type="button" data-mail-action="refresh" aria-label="${translator(model.locale)('Check for new mail')}" style="width: 44px; height: 44px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#344054,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path></svg></button></div>
      </div>
      <div data-mail-list-slot="true">
        <ul data-mail-list="true" aria-label="${translator(model.locale)('Messages')}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column">${rows}</ul>
        ${listEmpty}${listNote ? `<div role="status" data-mail-list-state="${model.listState}" style="display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 24px; text-align: center"><p style="margin: 0; font-size: 14px; font-weight: 600">${escapeHtml(listNote)}</p></div>` : ''}
      </div>
      <div style="margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted))"><span data-mail-pager="true" data-rest="${escapeHtml(model.pager)}" data-loaded="${model.loaded}" data-total="${model.total}" style="font-variant-numeric: tabular-nums">${escapeHtml(model.pager)}</span><button type="button" data-mail-older="true"${model.product ? ' disabled aria-describedby="mail-pagination-availability"' : ''} style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: light-dark(#1D5BD6,var(--xp-accent)); font-family: inherit; font-size: 13px; font-weight: 600">${translator(model.locale)('Older messages')}</button>${model.product ? `<span id="mail-pagination-availability" role="note" style="font-size:12px;line-height:1.6;color:light-dark(#475467,var(--xp-text-secondary))">${translator(model.locale)('Older message pagination is unavailable; this is the latest loaded list.')}</span>` : ''}</div>
    </section>
    ${article}
    </div>
    <template id="xmail-reading">${panes}</template>
    <template id="xmail-empty">${emptyReading(model.locale, false)}</template>
    ${workspaceTemplates}
  </main>
</div>
${INBOX_SCRIPT}
</div>`
}

export const block = (p?: string, pre?: string, list?: string[]): Block => ({ ...(p !== undefined ? { p } : {}), ...(pre !== undefined ? { pre } : {}), ...(list ? { list } : {}) })

export const renderXmailInbox = (model: InboxModel): string => renderInbox(model)

const STANDARD: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: 'INBOX', label: msgid('Inbox'), icon: 'inbox' },
  { id: 'Sent', label: msgid('Sent'), icon: 'sent' },
  { id: 'Drafts', label: msgid('Drafts'), icon: 'drafts' },
  { id: 'Junk', label: msgctxt('xmail-inbox', 'Junk'), icon: 'junk' },
  { id: 'Trash', label: msgctxt('xmail-inbox', 'Trash'), icon: 'trash' },
  { id: 'Archive', label: msgid('Archive'), icon: 'archive' },
]

const MESSAGES = msgid('{count, plural, one {{count} message} other {{count} messages}}')

export interface XmailInboxMessageInput {
  uid: number
  folder: string
  from: string
  to: string
  subject: string
  preview: string
  body: string
  receivedAt: string
  unread: boolean
  fromName?: string
  cc?: string
  attachments?: Array<{ name: string; sizeBytes: number }>
  dkimPass?: boolean
  spfPass?: boolean
  dmarcPass?: boolean
  bodyPending?: boolean
}

export interface XmailInboxProps {
  locale?: Locale
  theme?: 'light' | 'dark'
  mailbox: string
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: number | 'unlimited'
  folderWorkspace?: boolean
  attachmentReadEnabled?: boolean
  activeFolder?: string
  selectedUid?: number
  messages?: XmailInboxMessageInput[]
  realtimeEnabled?: boolean
  actionState?: AsyncActionBannerProps
  vacationEnabled?: boolean
  sieveCount?: number
  mailListFailed?: boolean
  folderCounts?: Array<{ folder: string; total: number; unread: number }>
}

export const xmailInboxFromProps = (props: XmailInboxProps): InboxModel => {
  const locale = props.locale ?? 'en'
  const t = translator(locale)
  const activeFolder = props.activeFolder && props.activeFolder.length > 0 ? props.activeFolder : 'INBOX'
  const observedMessages = props.messages !== undefined
  const all = (props.messages ?? []).filter(message => Number.isSafeInteger(message.uid) && message.uid > 0)
  const visible = all.filter(message => message.folder === activeFolder)
  const selected = visible.find(message => message.uid === props.selectedUid) ?? visible[0]
  const authWord = (value: boolean | undefined): string => value === undefined ? (translator(locale)('not checked')) : (value ? 'pass' : 'fail')
  const fileExt = (name: string): string => {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot + 1, dot + 5).toUpperCase() : 'FILE'
    return ext || 'FILE'
  }
  const cards: MailCard[] = visible.map(message => {
    const auth = `DKIM: ${authWord(message.dkimPass)} · SPF: ${authWord(message.spfPass)} · DMARC: ${authWord(message.dmarcPass)}`
    const stamp = formatMailStamp(message.receivedAt)
    const pending = message.bodyPending === true && message.body.length === 0
    const fromName = message.fromName && message.fromName.trim().length > 0 ? message.fromName.trim() : message.from
    const files = (message.attachments ?? []).filter(file => file.name.trim().length > 0)
    return {
      id: `uid-${message.uid}`,
      uid: message.uid,
      fromName,
      fromAddr: message.from,
      to: message.to,
      cc: message.cc ?? '',
      subject: message.subject,
      snippet: message.preview,
      time: stamp.time,
      datetime: stamp.datetime,
      displayDate: stamp.full,
      unread: message.unread,
      auth,
      attachments: files.map(file => ({ name: file.name, ext: fileExt(file.name), size: formatAttachmentBytes(file.sizeBytes) })),
      ...(files.length ? { attachTotal: formatAttachmentBytes(files.reduce((sum, file) => sum + (Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0), 0)) } : {}),
      bodyPending: pending,
      blocks: [block(pending ? (translator(locale)('This message body has not been loaded.')) : message.body)],
    }
  })
  const unreadIn = (folder: string): number => all.filter(message => message.folder === folder && message.unread).length
  const totalIn = (folder: string): number => all.filter(message => message.folder === folder).length
  const observed = new Set(all.map(message => message.folder).filter(folder => folder !== 'INBOX'))
  const folderHref = (id: string): string => id === 'INBOX' ? '/mail/inbox' : props.folderWorkspace && ['Sent', 'Drafts', 'Trash'].includes(id) ? `/mail/${id.toLowerCase()}` : `/mail/inbox?folder=${encodeURIComponent(id)}`
  const folders: FolderLink[] = STANDARD.map(item => {
    const measured = props.folderCounts?.find(row => row.folder === item.id)
    const count = measured
      ? (item.id === 'INBOX' ? measured.unread : measured.total)
      : (item.id === 'INBOX' ? unreadIn(item.id) : totalIn(item.id))
    const current = item.id === activeFolder
    const link: FolderLink = { id: item.id, label: t(item.label), href: folderHref(item.id), icon: item.icon, current }
    if (item.id !== 'INBOX') link.observed = item.id
    if (count > 0) {
      link.count = { text: String(count), kind: item.id === 'INBOX' ? 'pill' : 'strong' }
      link.aria = `${link.label}, ${count}`
    }
    return link
  })
  if (!STANDARD.some(item => item.id === activeFolder)) {
    folders.push({ id: activeFolder, label: activeFolder, href: folderHref(activeFolder), icon: 'folder', current: true, observed: activeFolder })
  }
  const customIds = [...observed].filter(folder => !STANDARD.some(item => item.id === folder) && folder !== activeFolder)
  const custom: FolderLink[] = customIds.map(folder => ({ id: folder, label: folder, href: folderHref(folder), icon: 'folder' as const, current: false, observed: folder }))
  const unread = visible.filter(message => message.unread).length
  const listState = observedMessages ? (visible.length === 0 ? 'empty' : 'messages') : (props.mailListFailed ? 'failed' : 'unread')
  const countText = listState === 'empty'
    ? (t('0 messages'))
    : listState === 'messages'
      ? `${t(MESSAGES, { count: visible.length })}${unread ? ` · ${t('{count} unread', { count: unread })}` : ''}`
      : '—'
  const quota = formatMailboxQuota(props.quotaUsedMb, props.quotaLimitMb, locale, props.quotaUsedBytes)
  const pager = listState === 'empty' ? (t('0 of 0')) : listState === 'messages' ? t('1\u2013{shown} of {total}', { shown: visible.length, total: visible.length }) : '—'
  const standard = STANDARD.find(item => item.id === activeFolder)
  const title = standard ? t(standard.label) : activeFolder
  const vacation = props.vacationEnabled === undefined ? '—' : (props.vacationEnabled ? (t('On')) : (t('Off')))
  const filters = props.sieveCount === undefined ? '—' : (t('{sieveCount} active', { sieveCount: props.sieveCount }))
  return {
    locale,
    theme: props.theme ?? 'light',
    product: true,
    folderWorkspace: props.folderWorkspace === true,
    attachmentReadEnabled: props.attachmentReadEnabled === true,
    mailbox: props.mailbox,
    quotaText: quota.text,
    quotaPct: quota.percent ?? 0,
    quotaMeasured: quota.percent !== null,
    listState,
    title,
    countText,
    unreadCount: activeFolder === 'INBOX' ? unread : 0,
    pager,
    loaded: visible.length,
    total: visible.length,
    composeHref: '/mail/compose',
    inboxHref: '/mail/inbox',
    folders,
    custom,
    vacationHref: '/mail/settings/autoresponder',
    vacation,
    filtersHref: '/mail/settings/filters',
    filters,
    messages: cards,
    selectedId: selected ? `uid-${selected.uid}` : null,
    folderEmpty: listState === 'empty',
    wsHtml: renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true),
    actionHtml: props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : '',
    logoutAttr: ' data-action="logout"',
    activeFolder,
    moveTargets: [...folders, ...custom]
      .filter(item => !item.current && (props.folderWorkspace || item.id !== 'INBOX'))
      .map(item => ({ id: item.id, label: item.label })),
    copy: { emptyTitle: t('No messages match'), emptyBody: t('Nothing in this folder fits this filter or search.'), emptyClear: t('Show all messages'), undo: t('Undo'), moved: t('Moved to {folder}: {subject}'), moveLabel: t('Move to folder') },
  }
}
