import type { Locale } from '../i18n.ts'
import { escapeHtml, renderAsyncActionState, type AsyncActionBannerProps } from '../tokens.ts'
import { renderLiveUpdatesIndicator, renderPageSearchButton } from '../shell.ts'
import { formatMailboxQuota } from './mail-truth.ts'

export const MONO = "'IBM Plex Mono', monospace"
const FONT_EN = "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
const FONT_AR = "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"
const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
.xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
.xp-board-port p{max-inline-size:none}
@media(min-width:960px){.xp-board-port[data-mail-layout="reference"] [data-xp-sidebar]{flex:0 0 200px!important;inline-size:200px}}
.xp-board-port [data-mail-recip-box] > ul:empty{display:none}
.xp-mail-vacation-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:var(--xp-space-field,16px)}
.xp-mail-vacation-field{display:flex;flex-direction:column;gap:var(--xp-space-label,8px);min-inline-size:0}
.xp-mail-vacation-field label{font-size:13px;font-weight:600;color:var(--xp-text-secondary,#344054)}
.xp-mail-vacation-field input{inline-size:100%;min-inline-size:0;min-block-size:44px;box-sizing:border-box;padding:8px 12px;border:1px solid var(--xp-control-edge,#808b9c);border-radius:8px;background:var(--xp-bg-surface,#FFFFFF);color:var(--xp-text-primary,#101828);font:inherit}
.xp-mail-vacation-preview{margin:0;max-inline-size:100%;white-space:pre-wrap;overflow-wrap:anywhere;padding:var(--xp-space-field,16px);border-radius:8px;background:#0E1726;color:#E6EDF7;font:12px/1.6 'IBM Plex Mono',monospace}
.xp-board-port[data-board-port="xmail-compose"] [data-mail-recip-box]:has(> input:read-only){background-color:#F2F4F7!important}
.xp-board-port[data-board-port="xmail-compose"] #compose-from{appearance:none;line-height:24px;padding-inline-end:28px!important;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:right 16px center,right 12px center;background-size:4px 4px;background-repeat:no-repeat}
html[dir="rtl"] .xp-board-port[data-board-port="xmail-compose"] #compose-from{padding-inline-start:28px!important;padding-inline-end:12px!important;background-position:left 12px center,left 16px center}
@media(forced-colors:active){.xp-board-port[data-board-port="xmail-compose"] #compose-from{appearance:auto;background-image:none;padding-inline:12px!important}}
@media(max-width:959px){.xp-board-port[data-board-port="xmail-compose"] :is(input:not([type="hidden"]),select,[contenteditable="true"]){font-size:16px!important}}
`

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
  check: glyph('<path d="M5 12l5 5 9-10"></path>', 14),
  attach: glyph('<path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"></path>'),
  close: glyph('<path d="M6 6l12 12M18 6L6 18"></path>', 14),
  closeLg: glyph('<path d="M6 6l12 12M18 6L6 18"></path>'),
}

type IconName = keyof typeof ICONS
type CountKind = 'pill' | 'muted' | 'strong'

export interface FolderLink {
  label: string
  href: string
  icon: IconName
  current: boolean
  count?: { text: string; kind: CountKind }
  aria?: string
  observed?: string
}

interface Chip {
  field: string
  name: string
  addr: string
  invalid: boolean
}

interface AttachmentFile {
  name: string
  ext: string
  state: string
  stateColor: string
  uploading: boolean
  pct: string
  removeLabel: string
}

export interface ComposeModel {
  /** Board copy overrides; live screens use the neutral sentences. */
  feedback?: { sendOk: string; saved: string; savedNote: string }
  locale: Locale
  theme?: 'light' | 'dark'
  product: boolean
  mailbox: string
  quotaText: string
  quotaPct: number
  quotaMeasured: boolean
  composeHref: string
  inboxHref: string
  folders: FolderLink[]
  custom: FolderLink[]
  vacationHref: string
  vacationShort: string
  filtersHref: string
  filtersShort: string
  savedText: string
  fromOptions: Array<{ value: string; label: string }>
  fromValue: string
  fromAddr: string
  chips: Chip[]
  subject: string
  bodyHtml: string
  numbersOn: boolean
  attachments: AttachmentFile[]
  attachSummary: string
  attachHelp: string
  identityDkim: string
  identitySpf: string
  identitySize: string
  vacationStatus: string
  vacationOn: boolean
  vacationOpenLabel: string
  filterCount: string
  filterRules: string
  wsHtml: string
  actionHtml: string
  logoutAttr: string
  routeAttr: string
}

const tech = (value: string, ar: boolean): string => ar ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)

const countSpan = (count: { text: string; kind: CountKind }): string => {
  if (count.kind === 'pill') return `<span style="min-width: 24px; padding: 1px 8px; border-radius: 999px; background: #1D5BD6; color: #FFFFFF; font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  if (count.kind === 'muted') return `<span style="font-size: 12px; color: #475467; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  return `<span style="font-size: 12px; font-weight: 600; color: #344054; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
}

const folderLink = (item: FolderLink): string => {
  const style = item.current
    ? 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: #1D5BD6; background: #E8EFFD; text-decoration: none'
    : 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none'
  const current = item.current ? ' aria-current="page"' : ''
  const observed = item.observed ? ` data-mail-folder="${escapeHtml(item.observed)}"` : ''
  const aria = item.aria ? ` aria-label="${escapeHtml(item.aria)}"` : ''
  return `<li${observed}><a href="${escapeHtml(item.href)}" data-nav-route="${escapeHtml(item.href)}"${current}${aria} style="${style}">${ICONS[item.icon]}<span style="flex: 1 1 auto">${escapeHtml(item.label)}</span>${item.count ? countSpan(item.count) : ''}</a></li>`
}

const TOOLBAR: Array<{ key: string; label: string; title: string; icon: string; action?: boolean; sep?: boolean }> = [
  { key: 'bold', label: 'Bold', title: 'Bold (Ctrl+B)', icon: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z' },
  { key: 'italic', label: 'Italic', title: 'Italic (Ctrl+I)', icon: 'M19 4h-9M14 20H5M15 4L9 20' },
  { key: 'underline', label: 'Underline', title: 'Underline (Ctrl+U)', icon: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14' },
  { key: 'sep1', label: '', title: '', icon: '', sep: true },
  { key: 'bullets', label: 'Bulleted list', title: 'Bulleted list', icon: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01' },
  { key: 'numbers', label: 'Numbered list', title: 'Numbered list', icon: 'M10 6h10M10 12h10M10 18h10M4 5h1v4M6 18H4l2-2.5a1.2 1.2 0 0 0-2-1' },
  { key: 'quote', label: 'Quote', title: 'Quote', icon: 'M6 8h4v4H6zM6 12c0 2.5-.8 4-2.5 5M14 8h4v4h-4zM14 12c0 2.5-.8 4-2.5 5' },
  { key: 'sep2', label: '', title: '', icon: '', sep: true },
  { key: 'link', label: 'Insert link', title: 'Insert link (Ctrl+K)', icon: 'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7L12 7M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7L12 17', action: true },
  { key: 'clear', label: 'Remove formatting', title: 'Remove formatting', icon: 'M5 5h11M10.5 5L8 19M4 20l16-16', action: true },
]

const toolbarHtml = (ar: boolean, numbersOn: boolean): string => TOOLBAR.map(item => {
  if (item.sep) return '<span aria-hidden="true" style="width: 1px; height: 24px; margin: 0 4px; background: #D0D5DD"></span>'
  const on = !item.action && item.key === 'numbers' && numbersOn
  const label = ar ? ({ bold: 'عريض', italic: 'مائل', underline: 'تسطير', bullets: 'قائمة نقطية', numbers: 'قائمة رقمية', quote: 'اقتباس', link: 'إدراج رابط', clear: 'إزالة التنسيق' }[item.key] ?? item.label) : item.label
  const title = ar ? label : item.title
  return `<button type="button" data-mail-format="${item.key}" data-mail-format-action="${item.action ? 'true' : 'false'}" aria-label="${escapeHtml(label)}" aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(title)}" style="width: 44px; height: 44px; border-radius: 8px; border: 1px solid ${on ? '#C7D7F8' : 'transparent'}; background: ${on ? '#E8EFFD' : 'transparent'}; color: ${on ? '#1D5BD6' : '#344054'}; display: flex; align-items: center; justify-content: center"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${item.icon}"></path></svg></button>`
}).join('')

const chipHtml = (chip: Chip, ar: boolean): string => {
  const bg = chip.invalid ? '#FEF3F2' : '#EEF0F3'
  const border = chip.invalid ? '#F4B8B2' : '#EEF0F3'
  const addrColor = chip.invalid ? '#B42318' : chip.name ? '#475467' : '#101828'
  const shown = chip.name ? `<${chip.addr}>` : chip.addr
  const fieldLabel = ar ? ({ to: 'إلى', cc: 'نسخة', bcc: 'نسخة مخفية' }[chip.field] ?? chip.field) : ({ to: 'To', cc: 'Cc', bcc: 'Bcc' }[chip.field] ?? chip.field)
  const invalid = chip.invalid ? `<span style="font-size: 12px; font-weight: 600; color: #B42318; white-space: nowrap">${ar ? '· راجع العنوان' : '· check address'}</span>` : ''
  return `<li data-mail-chip="${escapeHtml(chip.field)}" data-addr="${escapeHtml(chip.addr)}" data-invalid="${chip.invalid ? 'true' : 'false'}" style="display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 2px 0 10px; border-radius: 999px; background: ${bg}; border: 1px solid ${border}; font-size: 13px; color: #101828; max-width: 100%"><span style="font-weight: 500; white-space: nowrap">${escapeHtml(chip.name)}</span><span style="font-family: ${MONO}; font-size: 12px; color: ${addrColor}; overflow-wrap: anywhere">${tech(shown, ar)}</span>${invalid}<button type="button" data-mail-action="remove-chip" aria-label="${escapeHtml(`${ar ? 'إزالة' : 'Remove'} ${chip.addr} ${ar ? 'من' : 'from'} ${fieldLabel}`)}" style="flex: none; width: 44px; height: 44px; border-radius: 50%; border: none; background: transparent; color: #475467; display: flex; align-items: center; justify-content: center">${ICONS.close}</button></li>`
}

const recipientRow = (field: string, label: string, inputId: string, chips: Chip[], ar: boolean): string => {
  const mine = chips.filter(chip => chip.field === field)
  const placeholder = mine.length ? (ar ? 'أضف عنواناً آخر' : 'Add another') : (ar ? 'أضف مستلماً' : 'Add a recipient')
  return `<div data-mail-recip="${field}" style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid #EEF0F3"><label for="${inputId}" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: #344054">${escapeHtml(label)}</label><div data-mail-recip-box="${field}" style="flex: 1 1 260px; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 44px; padding: 4px 6px; border-radius: 8px; border: 1px solid var(--xp-control-edge, #808b9c); background: #FFFFFF"><ul aria-label="${escapeHtml(`${label} ${ar ? 'المستلمون' : 'recipients'}`)}" style="list-style: none; margin: 0; padding: 0; display: flex; flex: 1 1 100%; flex-wrap: wrap; gap: 6px">${mine.map(chip => chipHtml(chip, ar)).join('')}</ul><input id="${inputId}" data-mail-recip-input="${field}" type="text" dir="ltr" inputmode="email" autocomplete="email" aria-describedby="recips-help" placeholder="${escapeHtml(placeholder)}" style="flex: 1 1 160px; min-width: 120px; min-height: 44px; padding: 0 6px; text-align: ${ar ? 'right' : 'left'}; border: none; background: transparent; font-family: ${MONO}; font-size: 13px; color: #101828"></div></div>`
}

const attachmentHtml = (file: AttachmentFile): string => `<li data-mail-file="true" style="display: flex; align-items: center; gap: 12px; padding: 6px 6px 6px 10px; border-radius: 10px; border: 1px solid #E2E6EC; background: #FFFFFF"><span aria-hidden="true" style="flex: none; width: 34px; height: 34px; border-radius: 8px; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 10px; font-weight: 600">${escapeHtml(file.ext)}</span><span style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px"><span style="display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline"><span style="font-size: 13px; font-weight: 500; overflow-wrap: anywhere">${escapeHtml(file.name)}</span><span data-mail-file-state="true" style="font-size: 12px; color: ${file.stateColor}; font-variant-numeric: tabular-nums">${escapeHtml(file.state)}</span></span>${file.uploading ? `<span aria-hidden="true" style="display: block; height: 4px; border-radius: 2px; background: #E9ECF1; overflow: hidden; max-width: 320px"><span style="display: block; height: 4px; width: ${escapeHtml(file.pct)}; background: #1D5BD6; border-radius: 2px"></span></span>` : ''}</span><button type="button" data-mail-action="remove-file" aria-label="${escapeHtml(file.removeLabel)}" style="flex: none; width: 44px; height: 44px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #475467; display: flex; align-items: center; justify-content: center">${ICONS.closeLg}</button></li>`

const COMPOSE_SCRIPT = `<script id="xmail-compose-client">
(function () {
  var root = document.querySelector('[data-board-port="xmail-compose"]')
  if (!root) return
  var ar = root.getAttribute('data-locale') === 'ar'
  var product = root.getAttribute('data-product') === 'true'
  var text = function (name) { return root.getAttribute(name) || '' }
  var validAddr = function (value) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value) }
  var paintToggle = function (button, on) {
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
    button.style.borderColor = on ? '#C7D7F8' : 'transparent'
    button.style.background = on ? '#E8EFFD' : 'transparent'
    button.style.color = on ? '#1D5BD6' : '#344054'
  }
  var placeholder = function (field) {
    var box = root.querySelector('[data-mail-recip="' + field + '"]')
    var input = box && box.querySelector('[data-mail-recip-input]')
    var count = box ? box.querySelectorAll('[data-mail-chip]').length : 0
    if (input) input.placeholder = count ? text('data-add-another') : text('data-add-recipient')
  }
  var addChip = function (field, raw) {
    var parts = String(raw).split(/[,;]/).map(function (part) { return part.trim() }).filter(Boolean)
    if (!parts.length) return
    var list = root.querySelector('[data-mail-recip="' + field + '"] ul')
    var input = root.querySelector('[data-mail-recip-input="' + field + '"]')
    parts.forEach(function (part) {
      var named = /^(.*)<([^>]+)>$/.exec(part)
      var name = named ? named[1].trim().replace(/^"|"$/g, '') : ''
      var addr = named ? named[2].trim() : part
      var invalid = !validAddr(addr)
      var li = document.createElement('li')
      li.setAttribute('data-mail-chip', field)
      li.setAttribute('data-addr', addr)
      li.setAttribute('data-invalid', invalid ? 'true' : 'false')
      li.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 2px 0 10px;border-radius:999px;background:' + (invalid ? '#FEF3F2' : '#EEF0F3') + ';border:1px solid ' + (invalid ? '#F4B8B2' : '#EEF0F3') + ';font-size:13px;color:#101828;max-width:100%'
      var nameEl = document.createElement('span')
      nameEl.style.cssText = 'font-weight:500;white-space:nowrap'
      nameEl.textContent = name
      var addrEl = document.createElement('span')
      addrEl.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:12px;color:" + (invalid ? '#B42318' : name ? '#475467' : '#101828') + ';overflow-wrap:anywhere'
      addrEl.textContent = name ? '<' + addr + '>' : addr
      li.appendChild(nameEl)
      li.appendChild(addrEl)
      if (invalid) {
        var mark = document.createElement('span')
        mark.style.cssText = 'font-size:12px;font-weight:600;color:#B42318;white-space:nowrap'
        mark.textContent = text('data-check-address')
        li.appendChild(mark)
      }
      var remove = document.createElement('button')
      remove.type = 'button'
      remove.setAttribute('data-mail-action', 'remove-chip')
      remove.setAttribute('aria-label', text('data-remove') + ' ' + addr)
      remove.style.cssText = 'flex:none;width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:#475467'
      remove.textContent = '\\u00d7'
      li.appendChild(remove)
      if (list) list.appendChild(li)
    })
    if (input) input.value = ''
    placeholder(field)
  }
  var showFeedback = function (kind, message) {
    var host = root.querySelector('[data-mail-feedback]')
    if (!host) return
    var colors = { ok: ['#A6DCC3', '#F1FAF5', 'status'], warn: ['#F9C9A0', '#FFF6EE', 'status'], error: ['#F4B8B2', '#FEF3F2', 'alert'] }
    var tone = colors[kind] || colors.error
    host.setAttribute('role', tone[2])
    host.style.cssText = 'margin:16px 24px 0;display:flex;gap:10px;padding:12px 14px;border-radius:10px;border:1px solid ' + tone[0] + ';background:' + tone[1] + ';font-size:13px;line-height:1.6'
    host.hidden = false
    host.textContent = message
  }
  var editor = root.querySelector('#compose-body')
  var savedRange = null
  var selectionInsideEditor = function (range) {
    return !!editor && !!range && editor.contains(range.startContainer) && editor.contains(range.endContainer)
  }
  var rememberSelection = function () {
    if (!editor || typeof window.getSelection !== 'function') return
    var selection = window.getSelection()
    if (!selection || !selection.rangeCount) return
    var range = selection.getRangeAt(0)
    if (selectionInsideEditor(range)) savedRange = range.cloneRange()
  }
  var restoreSelection = function () {
    if (!editor || typeof window.getSelection !== 'function') return false
    var selection = window.getSelection()
    if (!selection) return false
    var range = savedRange && selectionInsideEditor(savedRange) ? savedRange.cloneRange() : document.createRange()
    if (!savedRange || !selectionInsideEditor(savedRange)) { range.selectNodeContents(editor); range.collapse(false) }
    editor.focus({ preventScroll: true })
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }
  var quoteSelected = function () {
    if (typeof window.getSelection !== 'function') return false
    var selection = window.getSelection()
    var node = selection && selection.anchorNode
    var element = node && (node.nodeType === 1 ? node : node.parentElement)
    var quote = element && element.closest && element.closest('blockquote')
    return !!quote && !!editor && editor.contains(quote)
  }
  var syncFormatting = function () {
    if (typeof window.getSelection !== 'function') return
    var selection = window.getSelection()
    if (!selection || !selection.rangeCount || !selectionInsideEditor(selection.getRangeAt(0))) return
    var commands = { bold: 'bold', italic: 'italic', underline: 'underline', bullets: 'insertUnorderedList', numbers: 'insertOrderedList' }
    root.querySelectorAll('[data-mail-format]').forEach(function (button) {
      var key = button.getAttribute('data-mail-format')
      if (button.getAttribute('data-mail-format-action') === 'true') return
      var on = key === 'quote' ? quoteSelected() : typeof document.queryCommandState === 'function' && !!commands[key] && document.queryCommandState(commands[key])
      paintToggle(button, !!on)
    })
  }
  var applyFormat = function (key) {
    var commands = { bold: 'bold', italic: 'italic', underline: 'underline', bullets: 'insertUnorderedList', numbers: 'insertOrderedList', quote: 'formatBlock', link: 'createLink', clear: 'removeFormat' }
    if (!Object.prototype.hasOwnProperty.call(commands, key)) return
    if (!editor || typeof document.execCommand !== 'function') { showFeedback('error', text('data-format-unavailable')); return }
    rememberSelection()
    var value = null
    if (key === 'link') {
      if (typeof window.prompt !== 'function') { showFeedback('error', text('data-format-unavailable')); return }
      var input = window.prompt(text('data-format-link-prompt'), 'https://')
      if (input === null) return
      try {
        var url = new URL(String(input).trim())
        if (['http:', 'https:', 'mailto:'].indexOf(url.protocol) === -1 || url.username || url.password) throw new Error('unsafe link')
        value = url.href
      } catch (error) { showFeedback('error', text('data-format-link-invalid')); return }
    }
    if (!restoreSelection()) { showFeedback('error', text('data-format-unavailable')); return }
    if (key === 'quote') value = quoteSelected() ? 'p' : 'blockquote'
    try {
      if (!document.execCommand(commands[key], false, value)) { showFeedback('error', text('data-format-unavailable')); return }
      rememberSelection()
      syncFormatting()
    } catch (error) { showFeedback('error', text('data-format-unavailable')) }
  }
  if (editor) {
    ;['mouseup', 'keyup', 'input', 'blur'].forEach(function (name) { editor.addEventListener(name, function () { rememberSelection(); syncFormatting() }) })
    // Pasting plain text preserves normal paste while excluding remote images and active HTML.
    editor.addEventListener('paste', function (event) {
      if (!event.clipboardData || typeof window.getSelection !== 'function') return
      event.preventDefault()
      rememberSelection()
      if (!restoreSelection()) return
      var selection = window.getSelection()
      if (!selection || !selection.rangeCount) return
      var range = selection.getRangeAt(0)
      if (!selectionInsideEditor(range)) return
      var content = event.clipboardData.getData('text/plain')
      var fragment = document.createDocumentFragment()
      String(content).split(/\\r?\\n/).forEach(function (line, index) {
        if (index) fragment.appendChild(document.createElement('br'))
        fragment.appendChild(document.createTextNode(line))
      })
      var last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range) }
      rememberSelection()
    })
    if (typeof document.addEventListener === 'function') document.addEventListener('selectionchange', function () { rememberSelection(); syncFormatting() })
    root.addEventListener('mousedown', function (event) {
      if (event.target && event.target.closest && event.target.closest('[data-mail-format]')) { rememberSelection(); event.preventDefault() }
    })
  }
  root.addEventListener('click', function (event) {
    var target = event.target
    if (!target || !target.closest) return
    var format = target.closest('[data-mail-format]')
    if (format) {
      event.preventDefault()
      applyFormat(format.getAttribute('data-mail-format'))
      return
    }
    var action = target.closest('[data-mail-action]')
    if (!action) return
    var name = action.getAttribute('data-mail-action')
    if (name === 'remove-chip') {
      var chip = action.closest('[data-mail-chip]')
      var field = chip && chip.getAttribute('data-mail-chip')
      if (chip) chip.remove()
      if (field) placeholder(field)
    }
    if (name === 'remove-file') {
      var file = action.closest('[data-mail-file]')
      if (file) file.remove()
    }
    if (name === 'discard-ask') {
      var group = root.querySelector('[data-mail-discard]')
      if (!group) return
      group.innerHTML = ''
      var label = document.createElement('span')
      label.style.cssText = 'font-size:13px;font-weight:600;color:#B42318'
      label.textContent = text('data-discard-ask')
      var keep = document.createElement('button')
      keep.type = 'button'
      keep.setAttribute('data-mail-action', 'discard-cancel')
      keep.textContent = text('data-keep')
      keep.style.cssText = 'min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#101828;font-family:inherit;font-size:13px;font-weight:600'
      var go = document.createElement('a')
      go.href = text('data-inbox-href')
      go.textContent = text('data-discard-go')
      go.style.cssText = 'min-height:44px;display:inline-flex;align-items:center;padding:0 12px;border-radius:8px;border:1px solid #B42318;background:#B42318;color:#FFFFFF;font-size:13px;font-weight:600;text-decoration:none'
      group.appendChild(label)
      group.appendChild(keep)
      group.appendChild(go)
    }
    if (name === 'discard-cancel') {
      var idle = root.querySelector('[data-mail-discard]')
      if (!idle) return
      idle.innerHTML = ''
      var button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-mail-action', 'discard-ask')
      button.textContent = text('data-discard')
      button.style.cssText = 'min-height:44px;padding:0 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:#B42318;font-family:inherit;font-size:14px;font-weight:600'
      idle.appendChild(button)
    }
    if (name === 'vacation-open') {
      var panel = root.querySelector('[data-mail-vacation-panel]')
      if (panel) panel.style.display = 'flex'
      action.setAttribute('aria-expanded', 'true')
    }
    if (name === 'vacation-cancel') {
      var openPanel = root.querySelector('[data-mail-vacation-panel]')
      if (openPanel) openPanel.style.display = 'none'
      var opener = root.querySelector('[data-mail-action="vacation-open"]')
      if (opener) opener.setAttribute('aria-expanded', 'false')
    }
    if (name === 'vacation-save') {
      if (product) {
        showFeedback('error', text('data-vacation-unavailable'))
        return
      }
      var chip = root.querySelector('[data-mail-vacation-status]')
      if (chip) chip.textContent = text('data-vacation-on')
      var savedPanel = root.querySelector('[data-mail-vacation-panel]')
      if (savedPanel) savedPanel.style.display = 'none'
    }
  })
  root.querySelectorAll('[data-mail-recip-input]').forEach(function (input) {
    input.addEventListener('input', function () {
      if (/[,;]/.test(input.value)) addChip(input.getAttribute('data-mail-recip-input'), input.value)
    })
    input.addEventListener('keydown', function (event) {
      var field = input.getAttribute('data-mail-recip-input')
      if (event.key === 'Enter') {
        event.preventDefault()
        addChip(field, input.value)
      } else if (event.key === 'Backspace' && !input.value) {
        var chips = root.querySelectorAll('[data-mail-chip="' + field + '"]')
        var last = chips[chips.length - 1]
        if (last) last.remove()
        placeholder(field)
      }
    })
  })
  var from = root.querySelector('#compose-from')
  if (from) from.addEventListener('change', function () {
    var addr = root.querySelector('[data-mail-from-addr]')
    var selected = from.options[from.selectedIndex]
    if (addr && selected) addr.textContent = selected.getAttribute('data-addr') || selected.value
  })
  var send = root.querySelector('[data-mail-send="true"]')
  if (send) send.addEventListener('click', function (event) {
    var toChips = root.querySelectorAll('[data-mail-chip="to"]')
    var typed = root.querySelector('#compose-to')
    var uploading = root.querySelector('[data-mail-file] [data-mail-file-state]')
    var invalid = root.querySelector('[data-mail-chip][data-invalid="true"]')
    if (!toChips.length && !(typed && typed.value.trim())) {
      event.stopImmediatePropagation()
      showFeedback('error', text('data-send-empty'))
      return
    }
    if (invalid) {
      event.stopImmediatePropagation()
      showFeedback('error', text('data-send-invalid'))
      return
    }
    if (uploading && uploading.textContent.indexOf('%') >= 0) {
      event.stopImmediatePropagation()
      showFeedback('warn', text('data-send-wait'))
      return
    }
    if (!product) {
      event.stopImmediatePropagation()
      showFeedback('ok', text('data-send-ok'))
    }
  })
  var save = root.querySelector('[data-mail-action="save-draft"]')
  if (save) save.addEventListener('click', function () {
    if (product) return
    var status = document.getElementById('mail-send-status')
    if (status) status.textContent = text('data-saved')
    showFeedback('ok', text('data-saved-note'))
  })
})()
</script>`

export const renderCompose = (model: ComposeModel): string => {
  const ar = model.locale === 'ar'
  const font = ar ? FONT_AR : FONT_EN
  const t = (en: string, arabic: string): string => ar ? arabic : en
  const mailbox = `<bdi dir="ltr">${escapeHtml(model.mailbox)}</bdi>`
  const quota = tech(model.quotaText, ar)
  const vacBg = model.vacationOn ? '#E7F5EE' : '#EEF0F3'
  const vacFg = model.vacationOn ? '#0E7A4E' : '#344054'
  const vacDot = model.vacationOn ? '#0E7A4E' : 'transparent'
  const unwired = model.product
    ? `<span style="font-size: 12px; font-weight: 500; color: #5D6B7E">${t('Coming soon', 'قيد التفعيل')}</span>`
    : ''
  const copy = [
    ['data-add-another', t('Add another', 'أضف عنواناً آخر')],
    ['data-add-recipient', t('Add a recipient', 'أضف مستلماً')],
    ['data-check-address', t('· check address', '· راجع العنوان')],
    ['data-remove', t('Remove', 'إزالة')],
    ['data-discard', t('Discard', 'تجاهل')],
    ['data-discard-ask', t('Discard this draft?', 'هل تريد تجاهل هذه المسودة؟')],
    ['data-keep', t('Keep editing', 'متابعة التحرير')],
    ['data-discard-go', t('Discard draft', 'تجاهل المسودة')],
    ['data-inbox-href', model.inboxHref],
    ['data-vacation-on', t('On', 'يعمل')],
    ['data-format-unavailable', t('Formatting could not be applied. Your message is unchanged.', 'تعذر تطبيق التنسيق. بقيت الرسالة دون تغيير.')],
    ['data-format-link-prompt', t('Link address (https://, http:// or mailto:)', 'عنوان الرابط (https:// أو http:// أو mailto:)')],
    ['data-format-link-invalid', t('Use an http, https or mailto link without embedded credentials.', 'استخدم رابط http أو https أو mailto دون بيانات دخول مضمنة.')],
    ['data-vacation-unavailable', t('The responder was not saved. Saving responder rules is unavailable on this server.', 'لم يُحفظ الرد. حفظ قواعد الرد التلقائي غير متاح على هذا الخادم.')],
    ['data-send-empty', t('Not sent: the To field is empty. Your message is kept as it is.', 'لم تُرسل: حقل إلى فارغ. بقيت الرسالة كما هي.')],
    ['data-send-invalid', t('Not sent: an address is not valid. Fix or remove it and send again.', 'لم تُرسل: أحد العناوين غير صالح. صححه أو أزله ثم أعد الإرسال.')],
    ['data-send-wait', t('Waiting for the attachment to finish uploading. Send again when it is done, or remove it.', 'بانتظار اكتمال رفع المرفق. أعد الإرسال عند انتهائه، أو أزله.')],
    ['data-send-ok', model.feedback?.sendOk ?? t('Sent. A copy is in Sent.', 'أُرسلت الرسالة. توجد نسخة في المرسلة.')],
    ['data-saved', model.feedback?.saved ?? t('Draft saved', 'حُفظت المسودة')],
    ['data-saved-note', model.feedback?.savedNote ?? t('Draft saved to Drafts.', 'حُفظت المسودة في المسودات.')],
  ].map(([name, value]) => ` ${name}="${escapeHtml(value ?? '')}"`).join('')
  return `<div class="xp-board-port" data-board-port="xmail-compose" data-surface="xmail" data-mail-layout="reference" data-mailbox="${escapeHtml(model.mailbox)}" data-locale="${model.locale}" data-product="${model.product ? 'true' : 'false'}"${copy}${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-direction: column; background: #F5F6F8; font-family: ${font}; color: #101828">
<style>${PORT_CSS}</style>
<a class="xp-skip-link" href="#main-content">${ar ? 'انتقل إلى المحتوى' : 'Skip to content'}</a>
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 12px 24px; background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
  <a href="${escapeHtml(model.inboxHref)}" style="display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none"><span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: #0E7A4E; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span><span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: #0E7A4E">${ar ? '<bdi dir="ltr">xMail</bdi>' : 'xMail'}</span></a>
  <form role="search" action="${escapeHtml(model.inboxHref)}" method="get" aria-label="${t('Search mail', 'البحث في البريد')}" style="flex: 1 1 280px; max-width: 520px; position: relative; display: flex; align-items: center; margin: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg><input type="hidden" name="lang" value="${model.locale}"><input type="hidden" name="theme" value="${model.theme ?? 'light'}"><input type="search" name="q" aria-label="${t('Search mail', 'البحث في البريد')}" placeholder="${t('Search sender, subject or text', 'ابحث عن المرسل أو الموضوع أو النص')}" style="width: 100%; min-height: 44px; padding-inline: 38px 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828"></form>
  <span style="flex: 1 1 0; min-width: 0"></span>
  <div style="display: flex; align-items: center; gap: 8px; min-width: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#475467" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><span style="font-family: ${MONO}; font-size: 13px; color: #101828">${mailbox}</span></div>
  <div data-mail-quota style="display: flex; flex-direction: column; gap: 4px; min-width: 150px"><div style="display: flex; flex-direction: column; gap: 4px; font-size: 12px"><span data-mail-quota-label style="font-weight: 600; color: #344054">${t('Mailbox', 'صندوق البريد')}</span><span data-mail-quota-value style="color: #475467; font-variant-numeric: tabular-nums">${quota}</span></div><div data-quota-ratio="${model.quotaMeasured ? 'measured' : 'unknown'}" aria-hidden="true" style="height: 6px; border-radius: 3px; background: #E9ECF1; overflow: hidden"><div style="height: 6px; width: ${model.quotaPct}%; background: #1D5BD6; border-radius: 3px"></div></div></div>
  ${renderPageSearchButton(model.locale)}
  <a href="?lang=${ar ? 'en' : 'ar'}" data-lang-switch="${ar ? 'en' : 'ar'}" lang="${ar ? 'en' : 'ar'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: #1D5BD6; text-decoration: none">${ar ? 'English' : 'العربية'}</a>
  <a href="?theme=${model.theme === 'dark' ? 'light' : 'dark'}" data-theme-toggle="${model.theme === 'dark' ? 'light' : 'dark'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: #1D5BD6; text-decoration: none">${model.theme === 'dark' ? (ar ? 'الوضع الفاتح' : 'Light theme') : (ar ? 'الوضع الداكن' : 'Dark theme')}</a>
  ${model.wsHtml}
  <button type="button"${model.logoutAttr} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${t('Sign out', 'تسجيل الخروج')}</button>
</header>
<div data-xp-shell-content="true" style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
  <nav aria-label="${t('Mail folders', 'مجلدات البريد')}" data-xp-sidebar data-mail-pane="folders" style="flex: 1 1 200px; max-width: 100%; background: #FFFFFF; border-inline-end: 1px solid #E2E6EC; padding: 16px 12px; display: flex; flex-direction: column; gap: 18px">
    <a href="${escapeHtml(model.composeHref)}" aria-current="page"${model.routeAttr} style="min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1546A8; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${ICONS.compose}${t('Compose', 'إنشاء رسالة')}</a>
    <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.folders.map(folderLink).join('')}</ul>
    <div style="display: flex; flex-direction: column; gap: 2px"><span id="my-folders" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">${t('Your folders', 'مجلداتك')}</span><ul aria-labelledby="my-folders" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.custom.map(folderLink).join('')}</ul></div>
    <div style="display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid #EEF0F3"><span id="mbx-settings" style="font-size: 11px; font-weight: 600; color: #5D6B7E; padding: 0 12px 4px">${t('Mailbox settings', 'إعدادات الصندوق')}</span><ul aria-labelledby="mbx-settings" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px"><li><a href="${escapeHtml(model.vacationHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none"><span>${t('Vacation responder', 'الرد التلقائي')}</span><span style="font-size: 12px; color: #475467">${escapeHtml(model.vacationShort)}</span></a></li><li><a href="${escapeHtml(model.filtersHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: #344054; text-decoration: none"><span>${t('Filters', 'الفلاتر')}</span><span style="font-size: 12px; color: #475467">${escapeHtml(model.filtersShort)}</span></a></li></ul></div>
  </nav>
  <main id="main-content" tabindex="-1" data-section="compose-drawer" style="flex: 4.236 1 740px; min-width: 0; padding: 24px 24px 52px; display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start">
    ${model.actionHtml}
    <div role="group" aria-labelledby="compose-title" data-compose-form="true" data-mail-send-availability="available" style="flex: 1.618 1 0; min-width: min(100%, 460px); display: flex; flex-direction: column; border-radius: 12px; border: 1px solid #E2E6EC; background: #FFFFFF">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; border-bottom: 1px solid #EEF0F3">
        <div style="display: flex; flex-direction: column; gap: 2px"><nav aria-label="${t('Breadcrumb', 'مسار التنقل')}"><a href="${escapeHtml(model.inboxHref)}" style="display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; font-size: 12px; color: #475467">${t('Inbox', 'الوارد')}</a></nav><h1 id="compose-title" style="margin: 0; font-size: 20px; font-weight: 600">${t('New message', 'رسالة جديدة')}</h1></div>
        <span id="mail-send-status" role="status" style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #475467">${ICONS.check}${escapeHtml(model.savedText)}</span>
      </div>
      <div style="display: flex; flex-direction: column; padding: 8px 24px 0">
        <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid #EEF0F3"><label for="compose-from" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: #344054">${t('From', 'من')}</label><select id="compose-from" dir="ltr" style="text-align: ${ar ? 'right' : 'left'}; flex: 1 1 260px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--xp-control-edge, #808b9c); background-color: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828">${model.fromOptions.map(option => `<option value="${escapeHtml(option.value)}" data-addr="${escapeHtml(option.value)}"${option.value === model.fromValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></div>
        ${recipientRow('to', t('To', 'إلى'), 'compose-to', model.chips, ar)}
        ${recipientRow('cc', t('Cc', 'نسخة'), 'compose-cc', model.chips, ar)}
        ${recipientRow('bcc', t('Bcc', 'نسخة مخفية'), 'compose-bcc', model.chips, ar)}
        <span id="recips-help" style="padding: 6px 13px 0; font-size: 12px; font-weight: 500; color: #5D6B7E">${t('Press Enter or type a comma after each address. Bcc recipients are hidden from everyone else.', 'اضغط Enter أو اكتب فاصلة بعد كل عنوان. تبقى نسخة مخفية مخفية عن بقية المستلمين.')}</span>
        <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid #EEF0F3"><label for="compose-subject" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: #344054">${t('Subject', 'الموضوع')}</label><input id="compose-subject" type="text" dir="auto" value="${escapeHtml(model.subject)}" style="text-align: ${ar ? 'right' : 'left'}; flex: 1 1 260px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--xp-control-edge, #808b9c); background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828"></div>
      </div>
      <div role="toolbar" aria-label="${t('Formatting', 'التنسيق')}" aria-controls="compose-body" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 16px 24px 0; padding: 4px; border-radius: 10px; border: 1px solid #E2E6EC; background: #F8F9FB">${toolbarHtml(ar, model.numbersOn)}</div>
      <div style="padding: 12px 24px 0"><label id="compose-body-label" for="compose-body" style="display: block; margin-bottom: 8px; padding-inline: 13px; font-size: 13px; font-weight: 600; color: #344054">${t('Message body', 'نص الرسالة')}</label><div id="compose-body" role="textbox" dir="auto" aria-labelledby="compose-body-label" aria-multiline="true" aria-label="${t('Message body', 'نص الرسالة')}" contenteditable="true" spellcheck="true" style="min-height: 300px; padding: 16px 12px; text-align: ${ar ? 'right' : 'left'}; border-radius: 10px; border: 1px solid var(--xp-control-edge, #808b9c); background: #FFFFFF; font-size: 14px; line-height: 1.6; color: #101828; display: flex; flex-direction: column; gap: 12px">${model.bodyHtml}</div></div>
      <section aria-labelledby="att-title" style="display: flex; flex-direction: column; gap: 10px; padding: 20px 24px 0">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px"><h2 id="att-title" style="margin: 0; font-size: 14px; font-weight: 600">${t('Attachments', 'المرفقات')} <span style="font-weight: 400; color: #475467; font-variant-numeric: tabular-nums">· ${escapeHtml(model.attachSummary)}</span></h2><span style="display: inline-flex; align-items: center; gap: 8px"><button type="button"${model.product ? ' disabled' : ''} style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.attach}${t('Attach files', 'إرفاق ملفات')}</button>${unwired}</span></div>
        <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px">${model.attachments.map(attachmentHtml).join('')}</ul>
        <span style="font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${escapeHtml(model.attachHelp)}</span>
      </section>
      <div data-mail-feedback="true" hidden></div>
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 20px; padding: 16px 24px; border-top: 1px solid #EEF0F3">
        <div data-mail-discard="true" role="group" aria-label="${t('Discard draft', 'تجاهل المسودة')}"><button type="button" data-mail-action="discard-ask" style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #B42318; font-family: inherit; font-size: 14px; font-weight: 600">${t('Discard', 'تجاهل')}</button></div>
        <span style="flex: 1 1 0"></span>
        <span style="display: inline-flex; align-items: center; gap: 8px"><button type="button" data-mail-action="save-draft"${model.product ? ' disabled' : ''} style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${t('Save draft', 'حفظ المسودة')}</button>${unwired}</span>
        <button type="button" data-mail-send="true" aria-describedby="mail-send-status" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 20px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.sent}${t('Send', 'إرسال')}</button>
      </div>
    </div>
    <aside aria-label="${t('Mailbox settings', 'إعدادات الصندوق')}" style="flex: 1 1 0; min-width: min(100%, 300px); display: flex; flex-direction: column; gap: 26px">
      <section aria-labelledby="identity-title" style="display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid #E2E6EC; background: #FFFFFF">
        <h2 id="identity-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Sending as', 'عنوان المرسل')}</h2>
        <dl style="margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; font-size: 13px; line-height: 1.4">
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0"><dt style="color: #475467">${t('Address', 'العنوان')}</dt><dd data-mail-from-addr="true" style="margin: 0; min-width: 0; font-family: ${MONO}; overflow-wrap: anywhere">${ar ? `<bdi dir="ltr" style="overflow-wrap: anywhere">${escapeHtml(model.fromAddr)}</bdi>` : escapeHtml(model.fromAddr)}</dd></div>
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0"><dt style="color: #475467">DKIM</dt><dd style="margin: 0">${model.identityDkim}</dd></div>
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0"><dt style="color: #475467">SPF, DMARC</dt><dd style="margin: 0">${model.identitySpf}</dd></div>
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0"><dt style="color: #475467">${t('Size limit', 'حد الحجم')}</dt><dd style="margin: 0">${model.identitySize}</dd></div>
        </dl>
      </section>
      <section id="vacation" aria-labelledby="vac-title" style="display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid #E2E6EC; background: #FFFFFF">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap"><h2 id="vac-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Vacation responder', 'الرد التلقائي')}</h2><span data-mail-vacation-status="true" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${vacBg}; color: ${vacFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${vacDot}; border: 1.5px solid ${vacFg}"></span>${escapeHtml(model.vacationStatus)}</span></div>
        <p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${t('Replies while you are away. Each sender gets at most one reply every 7 days. Saved as a Sieve vacation rule (RFC 5230) and run on delivery.', 'يرد أثناء غيابك. يحصل كل مرسل على رد واحد كل 7 أيام على الأكثر. يُحفظ كقاعدة Sieve vacation (RFC 5230) ويعمل عند التسليم.')}</p>
        <div style="display: flex; justify-content: flex-end"><button type="button" data-mail-action="vacation-open" aria-expanded="false" aria-controls="vac-form" style="min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${escapeHtml(model.vacationOpenLabel)}</button></div>
        <div id="vac-form" data-mail-vacation-panel="true" style="display: none; flex-direction: column; gap: var(--xp-space-field,16px)">
          <div class="xp-mail-vacation-fields"><div class="xp-mail-vacation-field"><label for="vac-from">${t('First day', 'اليوم الأول')}</label><input id="vac-from" type="date" dir="ltr"${model.product ? ' readonly aria-describedby="mail-vacation-availability"' : ''} style="text-align:${ar ? 'right' : 'left'}"></div><div class="xp-mail-vacation-field"><label for="vac-to">${t('Last day', 'اليوم الأخير')}</label><input id="vac-to" type="date" dir="ltr"${model.product ? ' readonly aria-describedby="mail-vacation-availability"' : ''} style="text-align:${ar ? 'right' : 'left'}"></div></div>
          <div class="xp-mail-vacation-field"><label for="vac-subject">${t('Reply subject', 'موضوع الرد')}</label><input id="vac-subject" type="text" dir="auto"${model.product ? ' readonly aria-describedby="mail-vacation-availability"' : ''}></div>
          <pre class="xp-mail-vacation-preview" data-mail-vacation-preview="unavailable" aria-label="${t('Sieve rule preview', 'معاينة قاعدة Sieve')}">${t('No responder configuration has been read.', 'لم تُقرأ إعدادات الرد التلقائي.')}</pre>
          ${model.product ? `<p id="mail-vacation-availability" role="note" style="margin:0;font-size:13px;line-height:1.6;color:#475467">${t('The schedule and rule are not available to edit here. Saving responder rules is unavailable on this server; no changes have been made.', 'الجدول والقاعدة غير متاحين للتحرير هنا. حفظ قواعد الرد التلقائي غير متاح على هذا الخادم؛ لم تُجرَ أي تغييرات.')}</p>` : ''}
          <div style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap"><button type="button" data-mail-action="vacation-cancel" style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${t('Cancel', 'إلغاء')}</button><button type="button" data-mail-action="vacation-save"${model.product ? ' disabled aria-describedby="mail-vacation-availability"' : ''} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${t('Save responder', 'حفظ الرد')}</button></div></div>
      </section>
      <section id="filters" aria-labelledby="filters-title" style="display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid #E2E6EC; background: #FFFFFF">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap"><h2 id="filters-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Filters', 'الفلاتر')}</h2><span style="font-size: 12px; color: #5D6B7E">${escapeHtml(model.filterCount)}</span></div>
        <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px">${model.filterRules}</ol>
        <div style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap"><button type="button"${model.product ? ' disabled' : ''} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600">${t('Add filter', 'إضافة فلتر')}</button><button type="button"${model.product ? ' disabled' : ''} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${t('Manage filters', 'إدارة الفلاتر')}</button>${unwired}</div>
      </section>
    </aside>
  </main>
</div>
${COMPOSE_SCRIPT}
</div>`
}

export const renderXmailCompose = (model: ComposeModel): string => renderCompose(model)
const STANDARD: ReadonlyArray<{ id: string; en: string; ar: string; icon: IconName }> = [
  { id: 'INBOX', en: 'Inbox', ar: 'الوارد', icon: 'inbox' },
  { id: 'Sent', en: 'Sent', ar: 'المرسل', icon: 'sent' },
  { id: 'Drafts', en: 'Drafts', ar: 'المسودات', icon: 'drafts' },
  { id: 'Junk', en: 'Junk', ar: 'غير المرغوب', icon: 'junk' },
  { id: 'Trash', en: 'Trash', ar: 'المحذوفات', icon: 'trash' },
  { id: 'Archive', en: 'Archive', ar: 'الأرشيف', icon: 'archive' },
]

export interface XmailComposeMessage {
  uid: number
  folder: string
  unread: boolean
}

export interface XmailComposeRule {
  name: string
  condition: string
  action: string
  /** Omitted rules in the fixture count as active. An explicit false is a paused stored rule. */
  enabled?: boolean
}

export interface XmailComposeProps {
  locale?: Locale
  theme?: 'light' | 'dark'
  mailbox: string
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: number | 'unlimited'
  messages?: XmailComposeMessage[]
  realtimeEnabled?: boolean
  actionState?: AsyncActionBannerProps
  vacationEnabled?: boolean
  sieveRules?: XmailComposeRule[]
  identityDkim?: string
  identitySpf?: string
  identitySize?: string
  folderCounts?: Array<{ folder: string; total: number; unread: number }>
  draft?: { to?: string; cc?: string; subject?: string; body?: string }
}

/** Arabic file counts: لا ملفات، ملف واحد، ملفان، ٣ ملفات، ١١ ملفاً. */
export const arabicFileCount = (count: number): string => {
  const rule = new Intl.PluralRules('ar').select(count)
  if (rule === 'zero') return 'لا ملفات'
  if (rule === 'one') return 'ملف واحد'
  if (rule === 'two') return 'ملفان'
  if (rule === 'few') return `${count} ملفات`
  return `${count} ملفاً`
}

const addressList = (value: string | undefined): string[] => {
  const parts: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of value ?? '') {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(part => part.includes('@'))
}

const chipOf = (field: 'to' | 'cc', raw: string): { field: 'to' | 'cc'; name: string; addr: string; invalid: boolean } => {
  const angle = /<([^>]+)>/.exec(raw)
  if (!angle?.[1]) return { field, name: raw, addr: raw, invalid: false }
  const addr = angle[1].trim()
  const name = raw.slice(0, angle.index).replace(/^"(.*)"$/, '$1').trim() || addr
  return { field, name, addr, invalid: false }
}

export const xmailComposeFromProps = (props: XmailComposeProps): ComposeModel => {
  const locale = props.locale ?? 'en'
  const ar = locale === 'ar'
  const messages = props.messages ?? []
  const unread = messages.filter(message => message.folder === 'INBOX' && message.unread).length
  const observed = new Set(messages.map(message => message.folder).filter(folder => folder !== 'INBOX'))
  const folderHref = (id: string): string => id === 'INBOX' ? '/mail/inbox' : `/mail/inbox?folder=${encodeURIComponent(id)}`
  const folders: FolderLink[] = STANDARD.map(item => {
    const measured = props.folderCounts?.find(row => row.folder === item.id)
    const count = measured ? (item.id === 'INBOX' ? measured.unread : measured.total) : (item.id === 'INBOX' ? unread : 0)
    const link: FolderLink = { label: ar ? item.ar : item.en, href: folderHref(item.id), icon: item.icon, current: false }
    if (item.id !== 'INBOX') link.observed = item.id
    if (count > 0) link.count = { text: String(count), kind: item.id === 'INBOX' ? 'pill' : 'strong' }
    return link
  })
  const custom: FolderLink[] = [...observed].filter(folder => !STANDARD.some(item => item.id === folder)).map(folder => ({
    label: folder, href: folderHref(folder), icon: 'folder' as const, current: false, observed: folder,
  }))
  const quota = formatMailboxQuota(props.quotaUsedMb, props.quotaLimitMb, locale, props.quotaUsedBytes)
  const rules = props.sieveRules ?? []
  const knownRules = props.sieveRules !== undefined
  const activeRules = rules.filter(rule => rule.enabled !== false).length
  const ruleHtml = rules.map((rule, index) => {
    const paused = rule.enabled === false ? (ar ? ' · متوقف' : ' · paused') : ''
    return `<li style="display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid #E2E6EC; font-size: 13px; line-height: 1.4"><span aria-hidden="true" style="flex: none; width: 22px; height: 22px; border-radius: 50%; background: #EEF0F3; color: #344054; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600">${index + 1}</span><span>${escapeHtml(rule.name)}${escapeHtml(paused)} <code style="font-family: ${MONO}">${ar ? `<bdi dir="ltr">${escapeHtml(rule.condition)}</bdi>` : escapeHtml(rule.condition)}</code> ${ar ? `<bdi dir="ltr">${escapeHtml(rule.action)}</bdi>` : escapeHtml(rule.action)}</span></li>`
  }).join('')
  const shownIdentity = (value: string | undefined): string => value ? `<bdi dir="auto">${escapeHtml(value)}</bdi>` : '—'
  const vacationKnown = props.vacationEnabled !== undefined
  const vacationOn = props.vacationEnabled === true
  const dash = '—'
  return {
    locale,
    theme: props.theme ?? 'light',
    product: true,
    mailbox: props.mailbox,
    quotaText: quota.text,
    quotaPct: quota.percent ?? 0,
    quotaMeasured: quota.percent !== null,
    composeHref: '/mail/compose',
    inboxHref: '/mail/inbox',
    folders,
    custom,
    vacationHref: '#vacation',
    vacationShort: vacationKnown ? (vacationOn ? (ar ? 'يعمل' : 'On') : (ar ? 'متوقف' : 'Off')) : dash,
    filtersHref: '#filters',
    filtersShort: knownRules ? (ar ? `${activeRules} نشطة` : `${activeRules} active`) : dash,
    savedText: dash,
    fromOptions: [{ value: props.mailbox, label: props.mailbox }],
    fromValue: props.mailbox,
    fromAddr: props.mailbox,
    chips: [
      ...addressList(props.draft?.to).map(addr => chipOf('to', addr)),
      ...addressList(props.draft?.cc).map(addr => chipOf('cc', addr)),
    ],
    subject: props.draft?.subject ?? '',
    bodyHtml: props.draft?.body
      ? `<p dir="auto" style="margin: 0; max-width: 68ch; white-space: pre-wrap"><bdi dir="auto">${escapeHtml(props.draft.body)}</bdi></p>`
      : '<p dir="auto" style="margin: 0; max-width: 68ch"></p>',
    numbersOn: false,
    attachments: [],
    attachSummary: ar ? arabicFileCount(0) : '0 files',
    attachHelp: dash,
    identityDkim: shownIdentity(props.identityDkim),
    identitySpf: shownIdentity(props.identitySpf),
    identitySize: shownIdentity(props.identitySize),
    vacationStatus: vacationKnown ? (vacationOn ? (ar ? 'يعمل' : 'On') : (ar ? 'متوقف' : 'Off')) : dash,
    vacationOn,
    vacationOpenLabel: ar ? 'إعداد الرد' : 'Set up responder',
    filterCount: knownRules ? (ar ? `${rules.length} قواعد Sieve` : `${rules.length} Sieve rules`) : dash,
    filterRules: ruleHtml,
    wsHtml: renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true),
    actionHtml: props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : '',
    logoutAttr: ' data-action="logout"',
    routeAttr: ' data-nav-route="/mail/compose"',
  }
}
