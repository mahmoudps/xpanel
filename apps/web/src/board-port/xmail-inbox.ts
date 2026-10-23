import type { Locale } from '../i18n.ts'
import { escapeHtml, renderAsyncActionState, type AsyncActionBannerProps } from '../tokens.ts'
import { renderLiveUpdatesIndicator } from '../shell.ts'
import { formatAttachmentBytes, formatMailboxQuota, formatMailStamp } from './mail-truth.ts'

const MONO = "'IBM Plex Mono', monospace"
const FONT_EN = "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
const FONT_AR = "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"
const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
.xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
.xp-board-port p{max-inline-size:none}`

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
  locale: Locale
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

const tech = (value: string, ar: boolean): string => ar ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)

const countSpan = (count: { text: string; kind: CountKind }, folderId: string): string => {
  const attr = ` data-mail-count="${escapeHtml(folderId)}"`
  if (count.kind === 'pill') return `<span${attr} style="min-width: 24px; padding: 1px 8px; border-radius: 999px; background: #1D5BD6; color: #FFFFFF; font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  if (count.kind === 'muted') return `<span${attr} style="font-size: 12px; color: #475467; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  return `<span${attr} style="font-size: 12px; font-weight: 600; color: #344054; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
}

const folderLink = (item: FolderLink, route: string): string => {
  const style = item.current
    ? 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: #1D5BD6; background: #E8EFFD; text-decoration: none'
    : 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none'
  const current = item.current ? ' aria-current="page"' : ''
  const routeAttr = item.current && route ? ` data-nav-route="${escapeHtml(route)}"` : ''
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

const messageRow = (card: MailCard, selected: boolean, ar: boolean): string => {
  const unread = card.unread
  const weight = unread ? '600' : '400'
  const dot = unread ? '#1D5BD6' : 'transparent'
  const bg = selected ? '#F3F7FE' : '#FFFFFF'
  const bar = selected ? (ar ? 'inset -3px 0 0 #1D5BD6' : 'inset 3px 0 0 #1D5BD6') : 'none'
  const timeColor = unread ? '#101828' : '#5D6B7E'
  const attach = card.attachments.length
  const unreadLabel = ar ? 'غير مقروءة. ' : 'Unread. '
  const attachLabel = ar
    ? (attach === 1 ? 'مرفق واحد' : attach === 2 ? 'مرفقان' : `${attach} مرفقات`)
    : `${attach} ${attach === 1 ? 'attachment' : 'attachments'}`
  const aria = `${unread ? unreadLabel : ''}${card.fromName}. ${card.subject}. ${card.time}${attach ? `. ${attachLabel}` : ''}`
  const uid = card.uid !== undefined ? ` data-mail-uid="${card.uid}"` : ''
  const icon = attach ? ICONS.attach : ''
  return `<li style="border-bottom: 1px solid #EEF0F3"><button type="button" data-mail-open="${escapeHtml(card.id)}" data-unread="${unread ? 'true' : 'false'}" data-attach="${attach > 0 ? '1' : '0'}" data-search="${escapeHtml(`${card.fromName} ${card.fromAddr} ${card.subject} ${card.snippet}`)}"${uid} aria-current="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(aria)}" style="width: 100%; display: flex; gap: 10px; padding: 12px 16px; border: none; background: ${bg}; box-shadow: ${bar}; text-align: start; font-family: inherit; color: #101828; cursor: pointer"><span aria-hidden="true" data-mail-dot="true" style="flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: ${dot}"></span><span style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px"><span style="display: flex; justify-content: space-between; align-items: baseline; gap: 8px"><span data-mail-name="true" style="font-size: 14px; font-weight: ${weight}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${tech(card.fromName, ar)}</span><span data-mail-time="true" style="flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: ${weight}; color: ${timeColor}; font-variant-numeric: tabular-nums">${icon}<time datetime="${escapeHtml(card.datetime)}">${tech(card.time, ar)}</time></span></span><span data-mail-subject="true" style="font-size: 14px; font-weight: ${weight}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><bdi dir="auto">${escapeHtml(card.subject)}</bdi></span><span style="font-size: 13px; color: #475467; white-space: nowrap; overflow: hidden; text-overflow: ellipsis"><bdi dir="auto">${escapeHtml(card.snippet)}</bdi></span></span></button></li>`
}

const readingInner = (card: MailCard, model: InboxModel): string => {
  const ar = model.locale === 'ar'
  const avatarBg = card.local ? '#101828' : '#E7F5EE'
  const avatarFg = card.local ? '#FFFFFF' : '#0E7A4E'
  const authFailed = card.auth.includes(': fail')
  const authUnknown = card.auth.includes(': —') || card.auth.includes('not checked') || card.auth.includes('غير مفحوص')
  const authBg = card.local || (authUnknown && !authFailed) ? '#EEF0F3' : (authFailed ? '#FEF3F2' : '#E7F5EE')
  const authFg = card.local || (authUnknown && !authFailed) ? '#344054' : (authFailed ? '#B42318' : '#0E7A4E')
  const cc = card.cc
    ? `<div style="display: flex; gap: 6px"><dt>${ar ? 'نسخة' : 'Cc'}</dt><dd style="margin: 0; font-family: ${MONO}; color: #344054">${tech(card.cc, ar)}</dd></div>`
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
    ? `<div role="note" data-mail-images="true" style="margin: 16px 28px 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; border: 1px solid #C7D7F8; background: #F3F7FE; font-size: 13px; line-height: 1.6"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D5BD6" stroke-width="2" stroke-linecap="round" style="flex: none"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v4h1"></path></svg><span style="flex: 1 1 240px">${ar ? 'الصور البعيدة محجوبة حتى لا يرى المرسل أنك فتحت الرسالة.' : 'Remote images are blocked so the sender can\'t see when you open this message.'}</span><button type="button" data-mail-action="load-images" style="min-height: 40px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 13px; font-weight: 600">${ar ? 'تحميل الصور' : 'Load images'}</button></div>`
    : ''
  const attachments = card.attachments.length
    ? `<section aria-labelledby="att-${escapeHtml(card.id)}" style="padding: 0 28px 28px; display: flex; flex-direction: column; gap: 10px"><h3 id="att-${escapeHtml(card.id)}" style="margin: 0; font-size: 13px; font-weight: 600; color: #344054">${escapeHtml(`${card.attachments.length} ${card.attachments.length === 1 ? 'attachment' : 'attachments'} · ${card.attachTotal ?? ''}`)}</h3><ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 10px">${card.attachments.map(file => `<li><button type="button" aria-label="${escapeHtml(`Download ${file.name}, ${file.size}`)}" style="min-height: 52px; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px; border: 1px solid #E2E6EC; background: #FFFFFF; color: #101828; font-family: inherit; text-align: start"><span aria-hidden="true" style="flex: none; width: 34px; height: 34px; border-radius: 8px; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 10px; font-weight: 600">${escapeHtml(file.ext)}</span><span style="display: flex; flex-direction: column; gap: 1px; min-width: 0"><span style="font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px">${escapeHtml(file.name)}</span><span style="font-size: 12px; color: #5D6B7E; font-variant-numeric: tabular-nums">${escapeHtml(file.size)}</span></span><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#475467" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-inline-start: 4px"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg></button></li>`).join('')}</ul></section>`
    : ''
  const reply = (icon: string, label: string, mode: string): string => {
    const href = `${model.composeHref}?mode=${encodeURIComponent(mode)}&uid=${encodeURIComponent(String(card.uid ?? ''))}&folder=${encodeURIComponent(model.activeFolder)}`
    return `<a href="${escapeHtml(href)}" data-mail-reply="${escapeHtml(mode)}" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-size: 14px; font-weight: 600; text-decoration: none">${icon}${escapeHtml(label)}</a>`
  }
  return `<div role="toolbar" aria-label="${ar ? 'إجراءات الرسالة' : 'Message actions'}" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 24px; border-bottom: 1px solid #E2E6EC">${reply(ICONS.reply, ar ? 'رد' : 'Reply', 'reply')}${reply(ICONS.replyAll, ar ? 'رد على الكل' : 'Reply all', 'reply-all')}${reply(ICONS.forward, ar ? 'إعادة التوجيه' : 'Forward', 'forward')}<div style="position: relative"><button type="button" data-mail-action="toggle-move" aria-expanded="false" aria-controls="move-list" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.move}${ar ? 'نقل' : 'Move'}${ICONS.chevron}</button></div><span style="flex: 1 1 0"></span><button type="button" data-mail-action="delete" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid #F4B8B2; background: #FFFFFF; color: #B42318; font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.trash}${ar ? 'حذف' : 'Delete'}</button></div><div style="padding: 20px 28px; display: flex; flex-direction: column; gap: 14px; border-bottom: 1px solid #EEF0F3"><h2 id="msg-subject" dir="auto" style="margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3"><bdi dir="auto">${escapeHtml(card.subject)}</bdi></h2><div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start"><span aria-hidden="true" style="flex: none; width: 40px; height: 40px; border-radius: 50%; background: ${avatarBg}; color: ${avatarFg}; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 600">${escapeHtml(initialsOf(card.fromName, card.local))}</span><div style="flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 4px"><div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline"><span style="font-size: 14px; font-weight: 600">${tech(card.fromName, ar)}</span><span style="font-family: ${MONO}; font-size: 13px; color: #475467">${ar ? tech(`<${card.fromAddr}>`, true) : `&lt;${escapeHtml(card.fromAddr)}&gt;`}</span></div><dl style="margin: 0; display: flex; flex-wrap: wrap; gap: 2px 16px; font-size: 13px; color: #475467"><div style="display: flex; gap: 6px"><dt>${ar ? 'إلى' : 'To'}</dt><dd style="margin: 0; font-family: ${MONO}; color: #344054">${tech(card.to, ar)}</dd></div>${cc}</dl></div><div style="flex: none; display: flex; flex-direction: column; gap: 6px; align-items: flex-end"><time datetime="${escapeHtml(card.datetime)}" style="font-size: 13px; color: #475467; font-variant-numeric: tabular-nums">${tech(fullDate(card.datetime), ar)}</time><span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${authBg}; color: ${authFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${authFg}"></span>${tech(card.auth, ar)}</span></div></div></div>${images}<div style="padding: 24px 28px; display: flex; flex-direction: column; gap: 14px; font-size: 14px; line-height: 1.6; color: #101828">${blocks}</div>${attachments}`
}

const emptyReading = (ar: boolean, folderEmpty: boolean): string => `<div data-mail-pane="empty" style="flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 64px 24px; text-align: center"><svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><h2 style="margin: 0; font-size: 16px; font-weight: 600">${folderEmpty ? (ar ? 'لا توجد رسائل في هذا المجلد.' : 'No messages in this folder.') : (ar ? 'لم تُحدد رسالة' : 'No message selected')}</h2><p style="margin: 0; font-size: 13px; color: #5D6B7E; line-height: 1.6">${folderEmpty ? (ar ? 'صندوق هذا المجلد فارغ.' : 'Nothing in this folder is waiting to be read.') : (ar ? 'اختر رسالة من القائمة لقراءتها هنا.' : 'Choose a message from the list to read it here.')}</p></div>`

const INBOX_SCRIPT = `<script id="xmail-inbox-client">
(function () {
  var root = document.querySelector('[data-board-port="xmail-inbox"]')
  if (!root) return
  var list = root.querySelector('[data-mail-list]')
  var pager = root.querySelector('[data-mail-pager]')
  var article = root.querySelector('[data-mail-article]')
  var store = root.querySelector('#xmail-reading')
  var blank = root.querySelector('#xmail-empty')
  var query = root.querySelector('#xmail-query')
  var filter = 'all'
  var rtl = root.getAttribute('data-locale') === 'ar'
  var barOn = rtl ? 'inset -3px 0 0 #1D5BD6' : 'inset 3px 0 0 #1D5BD6'
  var text = function (name) { return root.getAttribute(name) || '' }
  var targets = []
  var imagesLoaded = {}
  try { targets = JSON.parse(root.getAttribute('data-move-targets') || '[]') } catch (e) { targets = [] }
  var paintFilters = function () {
    var filters = root.querySelectorAll('[data-mail-filter]')
    for (var i = 0; i < filters.length; i++) {
      var on = filters[i].getAttribute('data-mail-filter') === filter
      filters[i].setAttribute('aria-pressed', on ? 'true' : 'false')
      filters[i].style.background = on ? '#FFFFFF' : 'transparent'
      filters[i].style.color = on ? '#101828' : '#475467'
      filters[i].style.fontWeight = on ? '600' : '500'
      filters[i].style.boxShadow = on ? '0 1px 2px rgba(16, 24, 40, 0.08)' : 'none'
    }
  }
  var paint = function () {
    if (!list) return 0
    var q = query && query.value ? query.value.trim().toLowerCase() : ''
    var rows = list.querySelectorAll('[data-mail-open]')
    var shown = 0
    var removed = 0
    for (var i = 0; i < rows.length; i++) {
      var button = rows[i]
      var row = button.parentNode
      if (row.getAttribute('data-removed') === 'true') {
        row.style.display = 'none'
        removed += 1
        continue
      }
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
      else {
        var loaded = pager.getAttribute('data-loaded') || '0'
        var total = Number(pager.getAttribute('data-total') || loaded)
        var ofWord = root.getAttribute('data-pager-of') || 'of'
        var latest = root.getAttribute('data-pager-latest') || 'of the latest'
        pager.textContent = (!q && filter === 'all') ? ('1\u2013' + shown + ' ' + ofWord + ' ' + (total - removed)) : (shown + ' ' + latest + ' ' + loaded)
      }
    }
    var empty = root.querySelector('[data-mail-filter-empty]')
    var slot = root.querySelector('[data-mail-list-slot]')
    var wantEmpty = shown === 0 && rows.length > 0
    if (!empty && slot && wantEmpty) {
      empty = document.createElement('div')
      empty.setAttribute('data-mail-filter-empty', 'true')
      empty.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 24px;text-align:center'
      var heading = document.createElement('h2')
      heading.style.cssText = 'margin:0;font-size:16px;font-weight:600'
      heading.textContent = text('data-empty-title')
      var note = document.createElement('p')
      note.style.cssText = 'margin:0;font-size:13px;color:#5D6B7E;line-height:1.6;max-width:280px'
      note.textContent = text('data-empty-body')
      var clear = document.createElement('button')
      clear.type = 'button'
      clear.setAttribute('data-mail-action', 'clear')
      clear.style.cssText = 'min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#101828;font-family:inherit;font-size:14px;font-weight:600'
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
      if (!hidden && !showing) show(current.getAttribute('data-mail-open'))
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
    if (time) { time.style.fontWeight = '400'; time.style.color = '#5D6B7E' }
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
    var sentence = summary.textContent || ''
    summary.textContent = nextUnread > 0
      ? sentence.replace(/ · (\d+)( unread| غير مقروء)/, ' · ' + nextUnread + '$2')
      : sentence.replace(/ · \d+( unread| غير مقروء)/, '')
  }
  var show = function (id) {
    if (!article) return
    var menu = root.querySelector('[data-mail-move]')
    if (menu) menu.remove()
    var toggle = root.querySelector('[data-mail-action="toggle-move"]')
    if (toggle) toggle.setAttribute('aria-expanded', 'false')
    if (!id) {
      if (blank) article.innerHTML = blank.innerHTML
      var rows = list ? list.querySelectorAll('[data-mail-open]') : []
      for (var i = 0; i < rows.length; i++) {
        rows[i].setAttribute('aria-current', 'false')
        rows[i].style.background = '#FFFFFF'
        rows[i].style.boxShadow = 'none'
      }
      return
    }
    if (!store) return
    var pane = store.content.querySelector('[data-reading-id="' + id + '"]')
    if (!pane) return
    article.innerHTML = pane.innerHTML
    var pendingBody = article.querySelector('[data-mail-body="pending"]')
    var opened = list && list.querySelector('[data-mail-open="' + id + '"]')
    var uid = opened && opened.getAttribute('data-mail-uid')
    if (pendingBody && uid && typeof window.xpanelSessionRequest === 'function') {
      var folderQuery = encodeURIComponent(root.getAttribute('data-mail-folder') || 'INBOX')
      window.xpanelSessionRequest('GET', '/api/webmail/inbox/' + uid + '?folder=' + folderQuery).then(function (data) {
        var message = data && data.message ? data.message : null
        if (!message || !pendingBody.isConnected) return
        pendingBody.textContent = message.body || ''
        pendingBody.removeAttribute('data-mail-body')
      }).catch(function () {
        if (pendingBody.isConnected) pendingBody.textContent = text('data-body-failed')
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
      button.style.background = on ? '#F3F7FE' : '#FFFFFF'
      button.style.boxShadow = on ? barOn : 'none'
      if (on) markRead(button)
    }
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
        menu.style.cssText = 'position:absolute;top:50px;inset-inline-start:0;z-index:2;list-style:none;margin:0;padding:6px;min-width:200px;border-radius:10px;border:1px solid #E2E6EC;background:#FFFFFF;box-shadow:0 8px 24px rgba(16, 24, 40, 0.12);display:flex;flex-direction:column;gap:2px'
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
          button.style.cssText = 'width:100%;min-height:40px;padding:0 12px;border-radius:8px;border:none;background:transparent;color:#101828;font-family:inherit;font-size:14px;text-align:start'
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
          bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 16px;background:#101828;color:#FFFFFF;font-size:13px'
          var label = document.createElement('span')
          label.setAttribute('data-mail-undo-text', 'true')
          var undo = document.createElement('button')
          undo.type = 'button'
          undo.setAttribute('data-mail-action', 'undo')
          undo.textContent = text('data-undo-label')
          undo.style.cssText = 'min-height:40px;padding:0 12px;border-radius:8px;border:1px solid #475467;background:transparent;color:#FFFFFF;font-family:inherit;font-size:13px;font-weight:600'
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
          ? text('data-moved-prefix') + folder + ': ' + (subject ? subject.textContent : '')
          : text('data-deleted-label')
        bar.setAttribute('data-removed-id', current.getAttribute('data-mail-open') || '')
        if (next) show(next.getAttribute('data-mail-open'))
        else show(null)
        paint()
      }
      if (product) {
        if (!uid || typeof window.xpanelSessionRequest !== 'function') return
        var trashNow = name === 'delete' && fromFolder === 'Trash'
        if (trashNow && typeof window.confirm === 'function' && !window.confirm(text('data-trash-confirm'))) return
        current.parentNode.setAttribute('data-removed', 'true')
        paint()
        var path = '/api/webmail/inbox/' + encodeURIComponent(uid)
        var pending = name === 'move' || (name === 'delete' && !trashNow)
          ? window.xpanelSessionRequest('POST', path + '/move', { folder: name === 'delete' ? 'Trash' : folderId, from: fromFolder })
          : window.xpanelSessionRequest('DELETE', path + '?folder=' + encodeURIComponent(fromFolder) + '&confirm=delete')
        pending.then(function (result) {
          finish(name === 'move' || (name === 'delete' && !trashNow))
          var bar = root.querySelector('[data-mail-undo]')
          if (bar && result && result.uid) {
            bar.setAttribute('data-undo-uid', String(result.uid))
            bar.setAttribute('data-undo-from', name === 'delete' ? 'Trash' : folderId)
            bar.setAttribute('data-undo-to', fromFolder)
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
            status.style.cssText = 'margin:0;padding:8px 16px;background:#FEF3F2;color:#B42318;font-size:13px'
            var slot = root.querySelector('[data-mail-list-slot]')
            if (slot) slot.insertBefore(status, slot.firstChild)
          }
          var arabic = root.getAttribute('data-locale') === 'ar'
          var detail = err && err.details && arabic && err.details.messageAr ? err.details.messageAr : ''
          status.textContent = detail || (err && err.message ? err.message : text('data-move-failed'))
          paint()
        })
        return
      }
      finish(true)
    }
    if (name === 'undo') {
      var undoBar = root.querySelector('[data-mail-undo]')
      var id = undoBar && undoBar.getAttribute('data-removed-id')
      var restoreRow = function () {
        var back = id && list && list.querySelector('[data-mail-open="' + id + '"]')
        if (back) back.parentNode.removeAttribute('data-removed')
        if (undoBar) undoBar.remove()
        if (id) show(id)
        paint()
      }
      var undoUid = undoBar && undoBar.getAttribute('data-undo-uid')
      if (root.getAttribute('data-product') === 'true' && undoUid && typeof window.xpanelSessionRequest === 'function') {
        window.xpanelSessionRequest('POST', '/api/webmail/inbox/' + encodeURIComponent(undoUid) + '/move', {
          folder: undoBar.getAttribute('data-undo-to') || 'INBOX',
          from: undoBar.getAttribute('data-undo-from') || 'Trash',
        }).then(restoreRow).catch(function (err) {
          var status = root.querySelector('[data-mail-action-status]')
          if (!status) {
            status = document.createElement('p')
            status.setAttribute('data-mail-action-status', 'true')
            status.setAttribute('role', 'alert')
            status.style.cssText = 'margin:0;padding:8px 16px;background:#FEF3F2;color:#B42318;font-size:13px'
            var slot = root.querySelector('[data-mail-list-slot]')
            if (slot) slot.insertBefore(status, slot.firstChild)
          }
          status.textContent = err && err.message ? err.message : text('data-move-failed')
        })
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
  if (query) query.addEventListener('input', paint)
})()
</script>`

export const renderInbox = (model: InboxModel): string => {
  const ar = model.locale === 'ar'
  const font = ar ? FONT_AR : FONT_EN
  const selected = model.messages.find(card => card.id === model.selectedId) ?? null
  const rows = model.messages.map(card => messageRow(card, card.id === model.selectedId, ar)).join('')
  const panes = model.messages.map(card => `<div data-reading-id="${escapeHtml(card.id)}">${readingInner(card, model)}</div>`).join('')
  const mailbox = tech(model.mailbox, ar)
  const quota = tech(model.quotaText, ar)
  const filterBtn = (key: string, label: string, on: boolean): string =>
    `<button type="button" data-mail-filter="${key}" aria-pressed="${on ? 'true' : 'false'}" style="min-height: 40px; padding: 0 12px; border-radius: 8px; border: none; background: ${on ? '#FFFFFF' : 'transparent'}; color: ${on ? '#101828' : '#475467'}; font-family: inherit; font-size: 13px; font-weight: ${on ? '600' : '500'}; box-shadow: ${on ? '0 1px 2px rgba(16, 24, 40, 0.08)' : 'none'}">${escapeHtml(label)}</button>`
  const listEmpty = model.folderEmpty
    ? `<div style="display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 24px; text-align: center"><h2 style="margin: 0; font-size: 16px; font-weight: 600">${ar ? 'لا توجد رسائل في هذا المجلد.' : 'No messages in this folder.'}</h2><p style="margin: 0; font-size: 13px; color: #5D6B7E; line-height: 1.6; max-width: 280px">${ar ? 'لا رسائل في هذا المجلد.' : 'Nothing in this folder is waiting to be read.'}</p></div>`
    : ''
  const article = selected
    ? `<article data-mail-pane="reading-pane" data-mail-article="true" aria-label="${ar ? 'لوحة القراءة' : 'Reading pane'}" style="flex: 2.618 1 420px; min-width: 0; background: #FFFFFF; display: flex; flex-direction: column">${readingInner(selected, model)}</article>`
    : `<article data-mail-pane="reading-pane" data-mail-article="true" aria-label="${ar ? 'لوحة القراءة' : 'Reading pane'}" style="flex: 2.618 1 420px; min-width: 0; background: #FFFFFF; display: flex; flex-direction: column">${emptyReading(ar, model.folderEmpty)}</article>`
  const route = model.product ? '/mail/inbox' : ''
  const copy = model.copy
  const listNote = model.listState === 'failed'
    ? (ar ? 'تعذر قراءة خادم البريد.' : 'The mail server could not be read.')
    : model.listState === 'unread'
      ? (ar ? 'لم تُقرأ الرسائل من خادم البريد بعد.' : 'The inbox has not been read from the mail server.')
      : ''
  return `<div class="xp-board-port" data-board-port="xmail-inbox" data-surface="xmail" data-mail-layout="reference" data-product="${model.product ? 'true' : 'false'}" data-mail-folder="${escapeHtml(model.activeFolder)}" data-pager-of="${escapeHtml(ar ? 'من' : 'of')}" data-pager-latest="${escapeHtml(ar ? 'من أصل' : 'of the latest')}" data-mailbox="${escapeHtml(model.mailbox)}" data-locale="${model.locale}" data-list-state="${model.listState}" data-body-failed="${escapeHtml(ar ? 'تعذر قراءة نص الرسالة.' : 'The message body could not be read.')}" data-move-targets="${escapeHtml(JSON.stringify(model.moveTargets))}" data-move-label="${escapeHtml(copy.moveLabel)}" data-empty-title="${escapeHtml(copy.emptyTitle)}" data-empty-body="${escapeHtml(copy.emptyBody)}" data-empty-clear="${escapeHtml(copy.emptyClear)}" data-undo-label="${escapeHtml(copy.undo)}" data-moved-prefix="${escapeHtml(copy.moved)}" data-trash-label="${escapeHtml(ar ? 'المحذوفات' : 'Trash')}" data-trash-confirm="${escapeHtml(ar ? 'حذف هذه الرسالة نهائياً؟' : 'Delete this message permanently?')}" data-deleted-label="${escapeHtml(ar ? 'حُذفت' : 'Deleted')}" data-move-failed="${escapeHtml(ar ? 'تعذر نقل الرسالة.' : 'The message could not be moved.')}"${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-direction: column; background: #F5F6F8; font-family: ${font}; color: #101828">
<style>${PORT_CSS}</style>
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 12px 24px; background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
  <a href="${escapeHtml(model.inboxHref)}" style="display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none"><span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: #0E7A4E; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span><span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: #0E7A4E">${ar ? `<bdi dir="ltr">xMail</bdi>` : 'xMail'}</span></a>
  <form role="search" aria-label="${ar ? 'البحث في البريد' : 'Search mail'}" style="flex: 1 1 280px; max-width: 520px; position: relative; display: flex; align-items: center; margin: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg><input id="xmail-query" type="search" aria-label="${ar ? 'البحث في البريد' : 'Search mail'}" placeholder="${ar ? 'ابحث عن المرسل أو الموضوع أو النص' : 'Search sender, subject or text'}" style="width: 100%; min-height: 44px; padding-inline: 38px 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828"></form>
  <span style="flex: 1 1 0; min-width: 0"></span>
  <div style="display: flex; align-items: center; gap: 8px; min-width: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#475467" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><span style="font-family: ${MONO}; font-size: 13px; color: #101828">${mailbox}</span></div>
  <div style="display: flex; flex-direction: column; gap: 4px; min-width: 150px"><div style="display: flex; justify-content: space-between; gap: 10px; font-size: 12px"><span style="font-weight: 600; color: #344054">${ar ? 'صندوق البريد' : 'Mailbox'}</span><span style="color: #475467; font-variant-numeric: tabular-nums">${quota}</span></div><div data-quota-ratio="${model.quotaMeasured ? 'measured' : 'unknown'}" aria-hidden="true" style="height: 6px; border-radius: 3px; background: #E9ECF1; overflow: hidden"><div style="height: 6px; width: ${model.quotaPct}%; background: #1D5BD6; border-radius: 3px"></div></div></div>
  ${model.wsHtml}
  <button type="button"${model.logoutAttr} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${ar ? 'تسجيل الخروج' : 'Sign out'}</button>
</header>
<div data-xp-shell-content="true" style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
  <nav aria-label="${ar ? 'مجلدات البريد' : 'Mail folders'}" data-xp-sidebar data-mail-pane="folders" style="flex: 1 1 200px; max-width: 100%; background: #FFFFFF; border-inline-end: 1px solid #E2E6EC; padding: 16px 12px; display: flex; flex-direction: column; gap: 18px">
    <a href="${escapeHtml(model.composeHref)}" style="min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${ICONS.compose}${ar ? 'إنشاء رسالة' : 'Compose'}</a>
    <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.folders.map(item => folderLink(item, route)).join('')}</ul>
    <div style="display: flex; flex-direction: column; gap: 2px"><span id="my-folders" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">${ar ? 'مجلداتك' : 'Your folders'}</span><ul aria-labelledby="my-folders" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.custom.map(item => folderLink(item, route)).join('')}</ul><button type="button" style="min-height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-radius: 8px; border: 1px dashed #C9CFD8; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 13px; font-weight: 600; margin-top: 4px"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>${ar ? 'مجلد جديد' : 'New folder'}</button></div>
    <div style="display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid #EEF0F3"><span id="mbx-settings" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">${ar ? 'إعدادات الصندوق' : 'Mailbox settings'}</span><ul aria-labelledby="mbx-settings" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px"><li><a href="${escapeHtml(model.vacationHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none"><span>${ar ? 'الرد التلقائي' : 'Vacation responder'}</span><span style="font-size: 12px; color: #475467">${escapeHtml(model.vacation)}</span></a></li><li><a href="${escapeHtml(model.filtersHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none"><span>${ar ? 'الفلاتر' : 'Filters'}</span><span style="font-size: 12px; color: #475467">${escapeHtml(model.filters)}</span></a></li></ul></div>
  </nav>
  <main id="main-content" data-mail-live="true" style="flex: 4.236 1 740px; min-width: 0; display: flex; flex-wrap: wrap; align-items: stretch">
    ${model.actionHtml}
    <section aria-labelledby="list-title" data-mail-pane="message-list" style="flex: 1.618 1 320px; min-width: 0; background: #FFFFFF; border-inline-end: 1px solid #E2E6EC; display: flex; flex-direction: column">
      <div style="padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 12px; border-bottom: 1px solid #E2E6EC">
        <div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap"><h1 id="list-title" style="margin: 0; font-size: 20px; font-weight: 600">${escapeHtml(model.title)}</h1><span${model.unreadCount && model.unreadCount > 0 ? ` data-mail-unread="${model.unreadCount}"` : ''} style="font-size: 12px; color: #5D6B7E; font-variant-numeric: tabular-nums">${escapeHtml(model.countText)}</span></div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap"><div role="group" aria-label="${ar ? 'عرض' : 'Show'}" style="display: inline-flex; padding: 2px; border-radius: 10px; background: #EEF0F3; gap: 2px">${filterBtn('all', ar ? 'الكل' : 'All', true)}${filterBtn('unread', ar ? 'غير المقروء' : 'Unread', false)}${filterBtn('attachments', ar ? 'مع مرفقات' : 'With attachments', false)}</div><span style="flex: 1 1 0"></span><button type="button" aria-label="${ar ? 'التحقق من البريد الجديد' : 'Check for new mail'}" style="width: 44px; height: 44px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #344054; display: flex; align-items: center; justify-content: center"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path></svg></button></div>
      </div>
      <div data-mail-list-slot="true">
        <ul data-mail-list="true" aria-label="${ar ? 'الرسائل' : 'Messages'}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column">${rows}</ul>
        ${listEmpty}${listNote ? `<div role="status" data-mail-list-state="${model.listState}" style="display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 24px; text-align: center"><p style="margin: 0; font-size: 14px; font-weight: 600">${escapeHtml(listNote)}</p></div>` : ''}
      </div>
      <div style="margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; font-size: 12px; color: #5D6B7E"><span data-mail-pager="true" data-rest="${escapeHtml(model.pager)}" data-loaded="${model.loaded}" data-total="${model.total}" style="font-variant-numeric: tabular-nums">${escapeHtml(model.pager)}</span><button type="button" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 13px; font-weight: 600">${ar ? 'رسائل أقدم' : 'Older messages'}</button></div>
    </section>
    ${article}
    <template id="xmail-reading">${panes}</template>
    <template id="xmail-empty">${emptyReading(ar, false)}</template>
  </main>
</div>
${INBOX_SCRIPT}
</div>`
}

export const block = (p?: string, pre?: string, list?: string[]): Block => ({ ...(p !== undefined ? { p } : {}), ...(pre !== undefined ? { pre } : {}), ...(list ? { list } : {}) })

export const renderXmailInbox = (model: InboxModel): string => renderInbox(model)

const STANDARD: ReadonlyArray<{ id: string; en: string; ar: string; icon: IconName }> = [
  { id: 'INBOX', en: 'Inbox', ar: 'الوارد', icon: 'inbox' },
  { id: 'Sent', en: 'Sent', ar: 'المرسل', icon: 'sent' },
  { id: 'Drafts', en: 'Drafts', ar: 'المسودات', icon: 'drafts' },
  { id: 'Junk', en: 'Junk', ar: 'غير المرغوب', icon: 'junk' },
  { id: 'Trash', en: 'Trash', ar: 'المحذوفات', icon: 'trash' },
  { id: 'Archive', en: 'Archive', ar: 'الأرشيف', icon: 'archive' },
]

const phrase = (count: number, ar: boolean, one: string, two: string, few: string, many: string, en: string, zero = ''): string => {
  if (!ar) return `${count} ${en}${count === 1 ? '' : 's'}`
  const rule = new Intl.PluralRules('ar').select(count)
  if (rule === 'zero') return zero || `لا ${few}`
  if (rule === 'one') return one
  if (rule === 'two') return two
  if (rule === 'few') return `${count} ${few}`
  return `${count} ${many}`
}

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
  mailbox: string
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: number | 'unlimited'
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
  const ar = locale === 'ar'
  const activeFolder = props.activeFolder && props.activeFolder.length > 0 ? props.activeFolder : 'INBOX'
  const observedMessages = props.messages !== undefined
  const all = (props.messages ?? []).filter(message => Number.isSafeInteger(message.uid) && message.uid > 0)
  const visible = all.filter(message => message.folder === activeFolder)
  const selected = visible.find(message => message.uid === props.selectedUid) ?? visible[0]
  const authWord = (value: boolean | undefined): string => value === undefined ? (ar ? 'غير مفحوص' : 'not checked') : (value ? 'pass' : 'fail')
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
      unread: message.unread,
      auth,
      attachments: files.map(file => ({ name: file.name, ext: fileExt(file.name), size: formatAttachmentBytes(file.sizeBytes) })),
      ...(files.length ? { attachTotal: formatAttachmentBytes(files.reduce((sum, file) => sum + (Number.isFinite(file.sizeBytes) ? file.sizeBytes : 0), 0)) } : {}),
      bodyPending: pending,
      blocks: [block(pending ? (ar ? 'لم يُحمّل نص هذه الرسالة بعد.' : 'This message body has not been loaded.') : message.body)],
    }
  })
  const unreadIn = (folder: string): number => all.filter(message => message.folder === folder && message.unread).length
  const totalIn = (folder: string): number => all.filter(message => message.folder === folder).length
  const observed = new Set(all.map(message => message.folder).filter(folder => folder !== 'INBOX'))
  const folderHref = (id: string): string => id === 'INBOX' ? '/mail/inbox' : `/mail/inbox?folder=${encodeURIComponent(id)}`
  const folders: FolderLink[] = STANDARD.map(item => {
    const measured = props.folderCounts?.find(row => row.folder === item.id)
    const count = measured
      ? (item.id === 'INBOX' ? measured.unread : measured.total)
      : (item.id === 'INBOX' ? unreadIn(item.id) : totalIn(item.id))
    const current = item.id === activeFolder
    const link: FolderLink = { id: item.id, label: ar ? item.ar : item.en, href: folderHref(item.id), icon: item.icon, current }
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
    ? (ar ? '0 رسائل' : '0 messages')
    : listState === 'messages'
      ? `${phrase(visible.length, ar, 'رسالة واحدة', 'رسالتان', 'رسائل', 'رسالة', 'message', 'لا رسائل')}${unread ? ` · ${unread} ${ar ? 'غير مقروء' : 'unread'}` : ''}`
      : '—'
  const quota = formatMailboxQuota(props.quotaUsedMb, props.quotaLimitMb, locale, props.quotaUsedBytes)
  const ofWord = ar ? 'من' : 'of'
  const pager = listState === 'empty' ? (ar ? '0 من 0' : '0 of 0') : listState === 'messages' ? `1\u2013${visible.length} ${ofWord} ${visible.length}` : '—'
  const title = STANDARD.find(item => item.id === activeFolder)?.[ar ? 'ar' : 'en'] ?? activeFolder
  const vacation = props.vacationEnabled === undefined ? '—' : (props.vacationEnabled ? (ar ? 'يعمل' : 'On') : (ar ? 'متوقف' : 'Off'))
  const filters = props.sieveCount === undefined ? '—' : (ar ? `${props.sieveCount} نشطة` : `${props.sieveCount} active`)
  return {
    locale,
    product: true,
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
      .filter(item => !item.current && item.id !== 'INBOX')
      .map(item => ({ id: item.id, label: item.label })),
    copy: ar
      ? { emptyTitle: 'لا توجد رسائل مطابقة', emptyBody: 'لا شيء في هذا المجلد يطابق عامل التصفية أو البحث.', emptyClear: 'عرض كل الرسائل', undo: 'تراجع', moved: 'نُقلت إلى ', moveLabel: 'نقل إلى مجلد' }
      : { emptyTitle: 'No messages match', emptyBody: 'Nothing in this folder fits this filter or search.', emptyClear: 'Show all messages', undo: 'Undo', moved: 'Moved to ', moveLabel: 'Move to folder' },
  }
}
