import { LOCALES, localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml, renderAsyncActionState, type AsyncActionBannerProps } from '../tokens.ts'
import { renderLiveUpdatesIndicator, renderPageSearchButton, renderMobileNavToggle, renderMobileNavClose, renderMobileNavBackdrop } from '../shell.ts'
import { formatMailboxQuota } from './mail-truth.ts'
import {renderMailVacationWorkspace} from './xmail-vacation.ts'

export const MONO = "'IBM Plex Mono', monospace"
const FONT_EN = "'IBM Plex Sans', sans-serif"
const FONT_AR = "sans-serif"
const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:light-dark(#1D5BD6,var(--xp-accent))}.xp-board-port a:hover{color:light-dark(#1546A8,var(--xp-accent-hover))}
.xp-board-port :focus-visible{outline:2px solid light-dark(#1D5BD6,var(--xp-accent));outline-offset:2px}
.xp-board-port p{max-inline-size:none}
@media(min-width:960px){.xp-board-port[data-mail-layout="reference"] [data-xp-sidebar]{flex:0 0 200px!important;inline-size:200px;position:static;block-size:auto;overflow:visible}}
.xp-board-port [data-mail-recip-box] > ul:empty{display:none!important}
.xp-board-port[data-board-port="xmail-compose"] [data-compose-attachment-list]{display:flex;flex-direction:column;gap:var(--xp-space-field,16px)}
.xp-board-port[data-board-port="xmail-compose"] [data-compose-attachment-list]:empty{display:none}
.xp-mail-vacation-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:var(--xp-space-field,16px)}
.xp-mail-vacation-field{display:flex;flex-direction:column;gap:var(--xp-space-label,8px);min-inline-size:0}
.xp-mail-vacation-field label{font-size:13px;font-weight:600;color:var(--xp-text-secondary,#344054)}
.xp-mail-vacation-field input{inline-size:100%;min-inline-size:0;min-block-size:44px;box-sizing:border-box;padding:8px 12px;border:1px solid var(--xp-control-edge,#808b9c);border-radius:8px;background:var(--xp-bg-surface,#FFFFFF);color:var(--xp-text-primary,#101828);font:inherit}
.xp-mail-vacation-preview{margin:0;max-inline-size:100%;white-space:pre-wrap;overflow-wrap:anywhere;padding:var(--xp-space-field,16px);border-radius:8px;background:#0E1726;color:#E6EDF7;font:12px/1.6 'IBM Plex Mono',monospace}
.xp-board-port[data-board-port="xmail-compose"] [data-mail-recip-input]:read-only{background-color:light-dark(#F2F4F7,var(--xp-bg-subtle))!important}
.xp-board-port[data-board-port="xmail-compose"][data-locale="ar"] [data-mail-recip-input]::placeholder{font-family:sans-serif}
.xp-board-port[data-board-port="xmail-compose"] #compose-from{appearance:none;line-height:24px;padding-inline-end:28px!important;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:right 16px center,right 12px center;background-size:4px 4px;background-repeat:no-repeat}
/* The sender follows its option text (an address or a localized sentence); the arrow stays on the left in RTL pages. */
html[dir="rtl"] .xp-board-port[data-board-port="xmail-compose"] #compose-from{padding-left:28px!important;padding-right:12px!important;background-position:left 12px center,left 16px center}
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
  canSend?: boolean
  canSaveDraft?: boolean
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
  vacationCanManage?: boolean
  vacationOpenLabel: string
  filterCount: string
  filterRules: string
  wsHtml: string
  actionHtml: string
  logoutAttr: string
  routeAttr: string
}

const tech = (value: string, rtl: boolean): string => rtl ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)

const countSpan = (count: { text: string; kind: CountKind }): string => {
  if (count.kind === 'pill') return `<span style="min-width: 24px; padding: 1px 8px; border-radius: 999px; background: light-dark(#1D5BD6,var(--xp-accent)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); font-size: 12px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  if (count.kind === 'muted') return `<span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
  return `<span style="font-size: 12px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${escapeHtml(count.text)}</span>`
}

const folderLink = (item: FolderLink): string => {
  const style = item.current
    ? 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent)); background: light-dark(#E8EFFD,var(--xp-accent-soft)); text-decoration: none'
    : 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none'
  const current = item.current ? ' aria-current="page"' : ''
  const observed = item.observed ? ` data-mail-folder="${escapeHtml(item.observed)}"` : ''
  const aria = item.aria ? ` aria-label="${escapeHtml(item.aria)}"` : ''
  return `<li${observed}><a href="${escapeHtml(item.href)}" data-nav-route="${escapeHtml(item.href)}"${current}${aria} style="${style}">${ICONS[item.icon]}<span style="flex: 1 1 auto">${escapeHtml(item.label)}</span>${item.count ? countSpan(item.count) : ''}</a></li>`
}

const TOOLBAR: Array<{ key: string; label: string; title: string; icon: string; action?: boolean; sep?: boolean }> = [
  { key: 'bold', label: msgid('Bold'), title: msgid('Bold (Ctrl+B)'), icon: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z' },
  { key: 'italic', label: msgid('Italic'), title: msgid('Italic (Ctrl+I)'), icon: 'M19 4h-9M14 20H5M15 4L9 20' },
  { key: 'underline', label: msgid('Underline'), title: msgid('Underline (Ctrl+U)'), icon: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14' },
  { key: 'sep1', label: '', title: '', icon: '', sep: true },
  { key: 'bullets', label: msgid('Bulleted list'), title: msgid('Bulleted list'), icon: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01' },
  { key: 'numbers', label: msgid('Numbered list'), title: msgid('Numbered list'), icon: 'M10 6h10M10 12h10M10 18h10M4 5h1v4M6 18H4l2-2.5a1.2 1.2 0 0 0-2-1' },
  { key: 'quote', label: msgid('Quote'), title: msgid('Quote'), icon: 'M6 8h4v4H6zM6 12c0 2.5-.8 4-2.5 5M14 8h4v4h-4zM14 12c0 2.5-.8 4-2.5 5' },
  { key: 'sep2', label: '', title: '', icon: '', sep: true },
  { key: 'link', label: msgid('Insert link'), title: msgid('Insert link (Ctrl+K)'), icon: 'M10 14a4 4 0 0 0 6 .5l3-3a4 4 0 0 0-5.7-5.7L12 7M14 10a4 4 0 0 0-6-.5l-3 3a4 4 0 0 0 5.7 5.7L12 17', action: true },
  { key: 'clear', label: msgid('Remove formatting'), title: msgid('Remove formatting'), icon: 'M5 5h11M10.5 5L8 19M4 20l16-16', action: true },
]

const toolbarHtml = (locale: Locale, numbersOn: boolean): string => TOOLBAR.map(item => {
  if (item.sep) return '<span aria-hidden="true" style="width: 1px; height: 24px; margin: 0 4px; background: light-dark(#D0D5DD,var(--xp-border-strong))"></span>'
  const on = !item.action && item.key === 'numbers' && numbersOn
  const label = translator(locale)(item.label)
  const title = translator(locale)(item.title)
  return `<button type="button" data-mail-format="${item.key}" data-mail-format-action="${item.action ? 'true' : 'false'}" aria-label="${escapeHtml(label)}" aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(title)}" style="width: 44px; height: 44px; border-radius: 8px; border: 1px solid ${on ? 'light-dark(#C7D7F8,var(--xp-accent-border))' : 'transparent'}; background: ${on ? 'light-dark(#E8EFFD,var(--xp-accent-soft))' : 'transparent'}; color: ${on ? 'light-dark(#1D5BD6,var(--xp-accent))' : 'light-dark(#344054,var(--xp-text-secondary))'}; display: flex; align-items: center; justify-content: center"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${item.icon}"></path></svg></button>`
}).join('')

const FIELD_LABELS: Readonly<Record<string, string>> = { to: msgid('To'), cc: msgid('Cc'), bcc: msgid('Bcc') }

const chipHtml = (chip: Chip, locale: Locale): string => {
  const rtl = localeDirection(locale) === 'rtl'
  const bg = chip.invalid ? 'light-dark(#FEF3F2,var(--xp-status-critical-bg))' : 'light-dark(#EEF0F3,var(--xp-bg-elevated))'
  const border = chip.invalid ? 'light-dark(#F4B8B2,var(--xp-status-critical-border))' : 'light-dark(#EEF0F3,var(--xp-border))'
  const addrColor = chip.invalid ? 'light-dark(#B42318,var(--xp-status-critical-fg))' : chip.name ? 'light-dark(#475467,var(--xp-text-secondary))' : 'light-dark(#101828,var(--xp-text-primary))'
  const shown = chip.name ? `<${chip.addr}>` : chip.addr
  const fieldLabel = FIELD_LABELS[chip.field] ? translator(locale)(FIELD_LABELS[chip.field]!) : chip.field
  const invalid = chip.invalid ? `<span style="font-size: 12px; font-weight: 600; color: light-dark(#B42318,var(--xp-status-critical-fg)); white-space: nowrap">${translator(locale)('· check address')}</span>` : ''
  return `<li data-mail-chip="${escapeHtml(chip.field)}" data-addr="${escapeHtml(chip.addr)}" data-invalid="${chip.invalid ? 'true' : 'false'}" style="display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 2px 0 10px; border-radius: 999px; background: ${bg}; border: 1px solid ${border}; font-size: 13px; color: light-dark(#101828,var(--xp-text-primary)); max-width: 100%"><span style="font-weight: 500; white-space: nowrap">${escapeHtml(chip.name)}</span><span style="font-family: ${MONO}; font-size: 12px; color: ${addrColor}; overflow-wrap: anywhere">${tech(shown, rtl)}</span>${invalid}<button type="button" data-mail-action="remove-chip" aria-label="${escapeHtml(`${translator(locale)('Remove')} ${chip.addr} ${translator(locale)('from')} ${fieldLabel}`)}" style="flex: none; width: 44px; height: 44px; border-radius: 50%; border: none; background: transparent; color: light-dark(#475467,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center">${ICONS.close}</button></li>`
}

const recipientRow = (field: string, label: string, inputId: string, chips: Chip[], locale: Locale): string => {
  const mine = chips.filter(chip => chip.field === field)
  const placeholder = mine.length ? (translator(locale)('Add another')) : (translator(locale)('Add a recipient'))
  return `<div data-mail-recip="${field}" style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))"><label for="${inputId}" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${escapeHtml(label)}</label><div data-mail-recip-box="${field}" style="min-width: 0; display: flex; flex-direction: column; gap: 8px"><ul aria-label="${escapeHtml(`${label} ${translator(locale)('recipients')}`)}" style="list-style: none; margin: 0; padding: 0; display: flex; order: 1; flex-wrap: wrap; gap: 6px">${mine.map(chip => chipHtml(chip, locale)).join('')}</ul><input id="${inputId}" data-mail-recip-input="${field}" type="text" dir="ltr" inputmode="email" autocomplete="email" aria-describedby="recips-help" placeholder="${escapeHtml(placeholder)}" style="order: 0; inline-size: 100%; box-sizing: border-box; min-width: 0; min-height: 44px; padding: 0 12px; text-align: ${localeDirection(locale) === 'rtl' ? 'right' : 'left'}; border: 1px solid var(--xp-control-edge, #808b9c); border-radius: 8px; background: light-dark(#FFFFFF,var(--xp-bg-surface)); font-family: ${MONO}; font-size: 13px; color: light-dark(#101828,var(--xp-text-primary))"></div></div>`
}

const attachmentHtml = (file: AttachmentFile): string => `<li data-mail-file="true" style="display: flex; align-items: center; gap: 12px; padding: 6px 6px 6px 10px; border-radius: 10px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface))"><span aria-hidden="true" style="flex: none; width: 34px; height: 34px; border-radius: 8px; background: light-dark(#EEF0F3,var(--xp-bg-elevated)); color: light-dark(#344054,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 10px; font-weight: 600">${escapeHtml(file.ext)}</span><span style="flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px"><span style="display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline"><span style="font-size: 13px; font-weight: 500; overflow-wrap: anywhere">${escapeHtml(file.name)}</span><span data-mail-file-state="true" style="font-size: 12px; color: ${file.stateColor}; font-variant-numeric: tabular-nums">${escapeHtml(file.state)}</span></span>${file.uploading ? `<span aria-hidden="true" style="display: block; height: 4px; border-radius: 2px; background: light-dark(#E9ECF1,var(--xp-bg-elevated)); overflow: hidden; max-width: 320px"><span style="display: block; height: 4px; width: ${escapeHtml(file.pct)}; background: light-dark(#1D5BD6,var(--xp-accent)); border-radius: 2px"></span></span>` : ''}</span><button type="button" data-mail-action="remove-file" aria-label="${escapeHtml(file.removeLabel)}" style="flex: none; width: 44px; height: 44px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: light-dark(#475467,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center">${ICONS.closeLg}</button></li>`

const COMPOSE_SCRIPT = `<script id="xmail-compose-client">
(function () {
  var root = document.querySelector('[data-board-port="xmail-compose"]')
  if (!root) return
  var product = root.getAttribute('data-product') === 'true'
  var text = function (name) { return root.getAttribute(name) || '' }
  var validAddr = function (value) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value) }
  var paintToggle = function (button, on) {
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
    button.style.borderColor = on ? 'light-dark(#C7D7F8,var(--xp-accent-border))' : 'transparent'
    button.style.background = on ? 'light-dark(#E8EFFD,var(--xp-accent-soft))' : 'transparent'
    button.style.color = on ? 'light-dark(#1D5BD6,var(--xp-accent))' : 'light-dark(#344054,var(--xp-text-secondary))'
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
      li.style.cssText = 'display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 2px 0 10px;border-radius:999px;background:' + (invalid ? 'light-dark(#FEF3F2,var(--xp-status-critical-bg))' : 'light-dark(#EEF0F3,var(--xp-bg-elevated))') + ';border:1px solid ' + (invalid ? 'light-dark(#F4B8B2,var(--xp-status-critical-border))' : 'light-dark(#EEF0F3,var(--xp-border))') + ';font-size:13px;color:light-dark(#101828,var(--xp-text-primary));max-width:100%'
      var nameEl = document.createElement('span')
      nameEl.style.cssText = 'font-weight:500;white-space:nowrap'
      nameEl.textContent = name
      var addrEl = document.createElement('span')
      addrEl.style.cssText = "font-family:'IBM Plex Mono',monospace;font-size:12px;color:" + (invalid ? 'light-dark(#B42318,var(--xp-status-critical-fg))' : name ? 'light-dark(#475467,var(--xp-text-secondary))' : 'light-dark(#101828,var(--xp-text-primary))') + ';overflow-wrap:anywhere'
      addrEl.textContent = name ? '<' + addr + '>' : addr
      li.appendChild(nameEl)
      li.appendChild(addrEl)
      if (invalid) {
        var mark = document.createElement('span')
        mark.style.cssText = 'font-size:12px;font-weight:600;color:light-dark(#B42318,var(--xp-status-critical-fg));white-space:nowrap'
        mark.textContent = text('data-check-address')
        li.appendChild(mark)
      }
      var remove = document.createElement('button')
      remove.type = 'button'
      remove.setAttribute('data-mail-action', 'remove-chip')
      remove.setAttribute('aria-label', text('data-remove').replace('{name}', function () { return addr }))
      remove.style.cssText = 'flex:none;width:44px;height:44px;border-radius:50%;border:none;background:transparent;color:light-dark(#475467,var(--xp-text-secondary))'
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
    var colors = { ok: ['light-dark(#A6DCC3,var(--xp-status-ok-border))', 'light-dark(#F1FAF5,var(--xp-status-ok-bg))', 'status'], warn: ['light-dark(#F9C9A0,var(--xp-status-warn-border))', 'light-dark(#FFF6EE,var(--xp-status-warn-bg))', 'status'], error: ['light-dark(#F4B8B2,var(--xp-status-critical-border))', 'light-dark(#FEF3F2,var(--xp-status-critical-bg))', 'alert'] }
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
      group.textContent = ''
      var label = document.createElement('span')
      label.style.cssText = 'font-size:13px;font-weight:600;color:light-dark(#B42318,var(--xp-status-critical-fg))'
      label.textContent = text('data-discard-ask')
      var keep = document.createElement('button')
      keep.type = 'button'
      keep.setAttribute('data-mail-action', 'discard-cancel')
      keep.textContent = text('data-keep')
      keep.style.cssText = 'min-height:44px;padding:0 12px;border-radius:8px;border:1px solid light-dark(#D0D5DD,var(--xp-text-muted));background:light-dark(#FFFFFF,var(--xp-bg-surface));color:light-dark(#101828,var(--xp-text-primary));font-family:inherit;font-size:13px;font-weight:600'
      var go = document.createElement('a')
      go.href = text('data-inbox-href')
      go.textContent = text('data-discard-go')
      go.style.cssText = 'min-height:44px;display:inline-flex;align-items:center;padding:0 12px;border-radius:8px;border:1px solid light-dark(#B42318,var(--xp-status-critical-fg));background:light-dark(#B42318,var(--xp-status-critical-fg));color:light-dark(#FFFFFF,var(--xp-text-on-accent));font-size:13px;font-weight:600;text-decoration:none'
      group.appendChild(label)
      group.appendChild(keep)
      group.appendChild(go)
    }
    if (name === 'discard-cancel') {
      var idle = root.querySelector('[data-mail-discard]')
      if (!idle) return
      idle.textContent = ''
      var button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-mail-action', 'discard-ask')
      button.textContent = text('data-discard')
      button.style.cssText = 'min-height:44px;padding:0 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:light-dark(#B42318,var(--xp-status-critical-fg));font-family:inherit;font-size:14px;font-weight:600'
      idle.appendChild(button)
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
    if (addr && selected) {
      addr.textContent = ''
      var isolated = document.createElement('bdi')
      isolated.dir = 'ltr'
      isolated.textContent = selected.getAttribute('data-addr') || ''
      addr.appendChild(isolated)
    }
  })
  var send = root.querySelector('[data-mail-send="true"]')
  if (send) send.addEventListener('click', function (event) {
    var hasRecipients = ['to', 'cc', 'bcc'].some(function (field) {
      var chips = root.querySelectorAll('[data-mail-chip="' + field + '"]')
      var typed = root.querySelector('#compose-' + field)
      return chips.length > 0 || !!(typed && typed.value.trim())
    })
    var uploading = root.querySelector('[data-mail-file] [data-mail-file-state]')
    var invalid = root.querySelector('[data-mail-chip][data-invalid="true"]')
    if (!hasRecipients) {
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
  const rtl = localeDirection(model.locale) === 'rtl'
  const font = rtl ? FONT_AR : FONT_EN
  const t = (message: string, values?: MessageValues): string => translator(model.locale)(message, values)
  const mailbox = `<bdi dir="ltr">${escapeHtml(model.mailbox)}</bdi>`
  const quota = tech(model.quotaText, rtl)
  const unwired = model.product
    ? `<span style="font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted))">${t(msgctxt('xmail-compose', 'Coming soon'))}</span>`
    : ''
  const copy = [
    ['data-add-another', t('Add another')],
    ['data-add-recipient', t('Add a recipient')],
    ['data-check-address', t('· check address')],
    ['data-remove', t('Remove {name}')],
    ['data-discard', t('Discard')],
    ['data-discard-ask', t(msgctxt('xmail-compose', 'Discard this draft?'))],
    ['data-keep', t('Keep editing')],
    ['data-discard-go', t('Discard draft')],
    ['data-inbox-href', model.inboxHref],
    ['data-format-unavailable', t('Formatting could not be applied. Your message is unchanged.')],
    ['data-format-link-prompt', t('Link address (https://, http:// or mailto:)')],
    ['data-format-link-invalid', t('Use an http, https or mailto link without embedded credentials.')],
    ['data-send-empty', t('Not sent: the To field is empty. Your message is kept as it is.')],
    ['data-send-invalid', t('Not sent: an address is not valid. Fix or remove it and send again.')],
    ['data-send-wait', t('Waiting for the attachment to finish uploading. Send again when it is done, or remove it.')],
    ['data-send-ok', model.feedback?.sendOk ?? t('Sent. A copy is in Sent.')],
    ['data-saved', model.feedback?.saved ?? t('Draft saved')],
    ['data-saved-note', model.feedback?.savedNote ?? t('Draft saved to Drafts.')],
  ].map(([name, value]) => ` ${name}="${escapeHtml(value ?? '')}"`).join('')
  return `<div class="xp-board-port xp-shell" data-board-port="xmail-compose" data-surface="xmail" data-mail-layout="reference" data-mailbox="${escapeHtml(model.mailbox)}" data-locale="${model.locale}" data-product="${model.product ? 'true' : 'false'}"${copy}${rtl ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-direction: column; background: light-dark(#F5F6F8,var(--xp-bg-canvas)); font-family: ${font}; color: light-dark(#101828,var(--xp-text-primary))">
<style>${PORT_CSS}</style>
<a class="xp-skip-link" href="#main-content">${translator(model.locale)('Skip to content')}</a>
<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 12px 24px; background: light-dark(#FFFFFF,var(--xp-bg-surface)); border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border))">${renderMobileNavToggle(model.locale)}
  <a href="${escapeHtml(model.inboxHref)}" style="display: flex; align-items: center; gap: 10px; min-height: 44px; text-decoration: none"><span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: light-dark(#0E7A4E,var(--xp-status-ok-fg)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span><span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: light-dark(#0E7A4E,var(--xp-status-ok-fg))">${rtl ? '<bdi dir="ltr">xMail</bdi>' : 'xMail'}</span></a>
  <form role="search" action="${escapeHtml(model.inboxHref)}" method="get" aria-label="${t('Search mail')}" style="flex: 1 1 280px; max-width: 520px; position: relative; display: flex; align-items: center; margin: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#5D6B7E,var(--xp-text-muted))" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg><input type="hidden" name="lang" value="${model.locale}"><input type="hidden" name="theme" value="${model.theme ?? 'light'}"><input type="search" name="q" aria-label="${t('Search mail')}" placeholder="${t('Search sender, subject or text')}" style="width: 100%; min-height: 44px; padding-inline: 38px 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary))"></form>
  <span style="flex: 1 1 0; min-width: 0"></span>
  <div style="display: flex; align-items: center; gap: 8px; min-width: 0"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="light-dark(#475467,var(--xp-text-secondary))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg><span style="font-family: ${MONO}; font-size: 13px; color: light-dark(#101828,var(--xp-text-primary))">${mailbox}</span></div>
  <div data-mail-quota style="display: flex; flex-direction: column; gap: 4px; min-width: 150px"><div style="display: flex; flex-direction: column; gap: 4px; font-size: 12px"><span data-mail-quota-label style="font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${t('Mailbox')}</span><span data-mail-quota-value style="color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">${quota}</span></div><div data-quota-ratio="${model.quotaMeasured ? 'measured' : 'unknown'}" aria-hidden="true" style="height: 6px; border-radius: 3px; background: light-dark(#E9ECF1,var(--xp-bg-elevated)); overflow: hidden"><div style="height: 6px; width: ${model.quotaPct}%; background: light-dark(#1D5BD6,var(--xp-accent)); border-radius: 3px"></div></div></div>
  ${renderPageSearchButton(model.locale)}
  ${LOCALES.filter(info => info.tag !== model.locale).map(info => `<a href="?lang=${info.tag}" data-lang-switch="${info.tag}" lang="${info.tag}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: light-dark(#1D5BD6,var(--xp-accent)); text-decoration: none">${escapeHtml(info.nativeName)}</a>`).join('')}
  <a href="?theme=${model.theme === 'dark' ? 'light' : 'dark'}" data-theme-toggle="${model.theme === 'dark' ? 'light' : 'dark'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: light-dark(#1D5BD6,var(--xp-accent)); text-decoration: none">${model.theme === 'dark' ? (translator(model.locale)('Light theme')) : (translator(model.locale)('Dark theme'))}</a>
  ${model.wsHtml}
  <button type="button"${model.logoutAttr} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${t('Sign out')}</button>
</header>
<div data-xp-shell-content="true" style="flex: 1 1 auto; display: flex; flex-wrap: wrap; align-items: stretch">
  <nav aria-label="${t('Mail folders')}" class="xp-sidebar" id="xp-sidebar" tabindex="-1" data-xp-sidebar data-mail-pane="folders" style="flex: 1 1 200px; max-width: 100%; background: light-dark(#FFFFFF,var(--xp-bg-surface)); border-inline-end: 1px solid light-dark(#E2E6EC,var(--xp-border)); padding: 16px 12px; display: flex; flex-direction: column; gap: 18px">${renderMobileNavClose(model.locale)}
    <a href="${escapeHtml(model.composeHref)}" aria-current="page"${model.routeAttr} style="min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid light-dark(#1D5BD6,var(--xp-accent)); background: light-dark(#1546A8,var(--xp-accent-hover)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); font-size: 14px; font-weight: 600; text-decoration: none">${ICONS.compose}${t('Compose')}</a>
    <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.folders.map(folderLink).join('')}</ul>
    <div style="display: flex; flex-direction: column; gap: 2px"><span id="my-folders" style="font-size: 11px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted)); padding: 0 12px 4px">${t('Your folders')}</span><ul aria-labelledby="my-folders" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${model.custom.map(folderLink).join('')}</ul></div>
    <div style="display: flex; flex-direction: column; gap: 2px; padding-top: 14px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border))"><span id="mbx-settings" style="font-size: 11px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted)); padding: 0 12px 4px">${t('Mailbox settings')}</span><ul aria-labelledby="mbx-settings" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px"><li><a href="${escapeHtml(model.vacationHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none"><span>${t('Vacation responder')}</span><span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${escapeHtml(model.vacationShort)}</span></a></li><li><a href="${escapeHtml(model.filtersHref)}" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary)); text-decoration: none"><span>${t('Filters')}</span><span style="font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${escapeHtml(model.filtersShort)}</span></a></li></ul></div>
  </nav>${renderMobileNavBackdrop(model.locale)}
  <main id="main-content" tabindex="-1" data-section="compose-drawer" style="flex: 4.236 1 740px; min-width: 0; padding: 24px 24px 52px; display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start">
    ${model.actionHtml}
    <div role="group" aria-labelledby="compose-title" data-compose-form="true" data-mail-send-availability="available"${model.product ? ` data-compose-identities="true" data-compose-mailbox="${escapeHtml(model.mailbox)}" data-compose-identities-state="unread" data-compose-send-enabled="${model.canSend === true}" data-compose-draft-enabled="${model.canSaveDraft === true}"` : ''} style="flex: 1.618 1 0; min-width: min(100%, 460px); display: flex; flex-direction: column; border-radius: 12px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface))">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))">
        <div style="display: flex; flex-direction: column; gap: 2px"><nav aria-label="${t('Breadcrumb')}"><a href="${escapeHtml(model.inboxHref)}" style="display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${t('Inbox')}</a></nav><h1 id="compose-title" style="margin: 0; font-size: 20px; font-weight: 600">${t('New message')}</h1></div>
        <span id="mail-send-status" role="status" style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary))">${ICONS.check}${escapeHtml(model.savedText)}</span>
      </div>
      <div style="display: flex; flex-direction: column; padding: 8px 24px 0">
        <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))"><label for="compose-from" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${t('From')}</label><select id="compose-from" dir="auto"${model.product ? ' disabled aria-describedby="compose-identities-status"' : ''} style="text-align: ${rtl ? 'right' : 'left'}; flex: 1 1 260px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--xp-control-edge, #808b9c); background-color: light-dark(#FFFFFF,var(--xp-bg-surface)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary))">${model.fromOptions.map(option => `<option value="${escapeHtml(option.value)}" data-addr="${escapeHtml(option.value)}"${option.value === model.fromValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select></div>
        ${model.product ? `<div data-compose-identities-tools style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding-block:16px"><div style="display:flex;flex-wrap:wrap;gap:var(--xp-space-field,16px)"><button type="button" class="xp-btn" data-compose-identities-refresh disabled>${t('Read sender identities')}</button><button type="button" class="xp-btn" data-compose-signature-insert disabled>${t('Insert signature')}</button></div><p id="compose-identities-status" data-compose-identities-status role="status" style="margin:0;font-size:13px;line-height:1.6;overflow-wrap:anywhere">${t('Saved sender identities have not been read.')}</p></div>` : ''}
        ${recipientRow('to', t('To'), 'compose-to', model.chips, model.locale)}
        ${recipientRow('cc', t('Cc'), 'compose-cc', model.chips, model.locale)}
        ${recipientRow('bcc', t('Bcc'), 'compose-bcc', model.chips, model.locale)}
        <span id="recips-help" style="padding: 6px 13px 0; font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted))">${t('Press Enter or type a comma after each address. Bcc recipients are hidden from everyone else.')}</span>
        <div style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 8px 0; border-bottom: 1px solid light-dark(#EEF0F3,var(--xp-border))"><label for="compose-subject" style="display: block; padding-inline: 13px; font-size: 13px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${t('Subject')}</label><input id="compose-subject" type="text" dir="auto" value="${escapeHtml(model.subject)}" style="text-align: ${rtl ? 'right' : 'left'}; flex: 1 1 260px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--xp-control-edge, #808b9c); background: light-dark(#FFFFFF,var(--xp-bg-surface)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary))"></div>
      </div>
      <div role="toolbar" aria-label="${t('Formatting')}" aria-controls="compose-body" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 16px 24px 0; padding: 4px; border-radius: 10px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#F8F9FB,var(--xp-bg-elevated))">${toolbarHtml(model.locale, model.numbersOn)}</div>
      <div style="padding: 12px 24px 0"><label id="compose-body-label" for="compose-body" style="display: block; margin-bottom: 8px; padding-inline: 13px; font-size: 13px; font-weight: 600; color: light-dark(#344054,var(--xp-text-secondary))">${t('Message body')}</label><div id="compose-body" role="textbox" dir="auto" aria-labelledby="compose-body-label" aria-multiline="true" aria-label="${t('Message body')}" contenteditable="true" spellcheck="true" style="min-height: 300px; padding: 16px 12px; text-align: ${rtl ? 'right' : 'left'}; border-radius: 10px; border: 1px solid var(--xp-control-edge, #808b9c); background: light-dark(#FFFFFF,var(--xp-bg-surface)); font-size: 14px; line-height: 1.6; color: light-dark(#101828,var(--xp-text-primary)); display: flex; flex-direction: column; gap: 12px">${model.bodyHtml}</div></div>
      <section aria-labelledby="att-title"${model.product ? ` data-compose-attachments data-compose-attachment-enabled="${model.canSend === true || model.canSaveDraft === true}"` : ''} style="display: flex; flex-direction: column; gap: ${model.product ? 'var(--xp-space-group,24px)' : '10px'}; padding: ${model.product ? '24px' : '20px'} 24px 0">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px"><h2 id="att-title" style="margin: 0; font-size: 14px; font-weight: 600">${t('Attachments')} <span${model.product ? ' data-compose-attachment-summary' : ''} style="font-weight: 400; color: light-dark(#475467,var(--xp-text-secondary)); font-variant-numeric: tabular-nums">· ${escapeHtml(model.attachSummary)}</span></h2><span style="display: inline-flex; align-items: center; gap: 8px"><button type="button"${model.product ? ' data-compose-attachment-open disabled aria-controls="compose-file-input" aria-describedby="compose-attachment-status"' : ''} style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.attach}${t('Attach files')}</button>${model.product ? '' : unwired}</span></div>
        ${model.product ? '<input id="compose-file-input" data-compose-attachment-input type="file" multiple hidden disabled>' : ''}
        <ul${model.product ? ' data-compose-attachment-list' : ''} style="list-style: none; margin: 0; padding: 0;${model.product ? '' : ' display: flex; flex-direction: column; gap: 8px'}">${model.product ? '' : model.attachments.map(attachmentHtml).join('')}</ul>
        <span${model.product ? ' id="compose-attachment-status" data-compose-attachment-status role="status"' : ''} style="font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted)); line-height: 1.6">${model.product ? t('Choose up to 10 files, with a combined limit of 512 KiB. Files have not been read.') : escapeHtml(model.attachHelp)}</span>
      </section>
      <div data-mail-feedback="true" hidden></div>
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 20px; padding: 16px 24px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border))">
        <div data-mail-discard="true" role="group" aria-label="${t('Discard draft')}"><button type="button" data-mail-action="discard-ask" style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: light-dark(#B42318,var(--xp-status-critical-fg)); font-family: inherit; font-size: 14px; font-weight: 600">${t('Discard')}</button></div>
        <span style="flex: 1 1 0"></span>
        <span style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px"><button type="button" data-mail-action="save-draft"${model.product ? ' disabled aria-describedby="mail-draft-status"' : ''} style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${t('Save draft')}</button>${model.product ? `<span id="mail-draft-status" data-mail-draft-status role="status" style="font-size:12px;line-height:1.6;max-inline-size:32ch;overflow-wrap:anywhere">${t('Draft saving has not been checked.')}</span>` : ''}</span>
        <button type="button" data-mail-send="true"${model.product ? ' disabled' : ''} aria-describedby="mail-send-status${model.product ? ' compose-identities-status' : ''}" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 20px; border-radius: 8px; border: 1px solid light-dark(#1D5BD6,var(--xp-accent)); background: light-dark(#1D5BD6,var(--xp-accent)); color: light-dark(#FFFFFF,var(--xp-text-on-accent)); font-family: inherit; font-size: 14px; font-weight: 600">${ICONS.sent}${t('Send')}</button>
      </div>
    </div>
    <aside aria-label="${t('Mailbox settings')}" style="flex: 1 1 0; min-width: min(100%, 300px); display: flex; flex-direction: column; gap: 26px">
      <section aria-labelledby="identity-title" style="display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface))">
        <h2 id="identity-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Sending as')}</h2>
        <dl style="margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; font-size: 13px; line-height: 1.4">
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0"><dt style="color: light-dark(#475467,var(--xp-text-secondary))">${t('Address')}</dt><dd data-mail-from-addr="true" style="margin: 0; min-width: 0; font-family: ${MONO}; overflow-wrap: anywhere">${rtl ? `<bdi dir="ltr" style="overflow-wrap: anywhere">${escapeHtml(model.fromAddr)}</bdi>` : escapeHtml(model.fromAddr)}</dd></div>
          ${model.product ? `<div data-mail-identity-field style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0"><dt style="color:light-dark(#475467,var(--xp-text-secondary))">${t('Sender name')}</dt><dd data-compose-identity-label style="margin:0;overflow-wrap:anywhere">${t(msgctxt('xmail-compose', 'Not read'))}</dd></div><div data-mail-identity-field style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0"><dt style="color:light-dark(#475467,var(--xp-text-secondary))">${t('Reply-To')}</dt><dd data-compose-reply-to style="margin:0;overflow-wrap:anywhere">${t(msgctxt('xmail-compose', 'Not read'))}</dd></div>` : ''}
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0"><dt style="color: light-dark(#475467,var(--xp-text-secondary))">DKIM</dt><dd style="margin: 0">${model.identityDkim}</dd></div>
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0"><dt style="color: light-dark(#475467,var(--xp-text-secondary))">SPF, DMARC</dt><dd style="margin: 0">${model.identitySpf}</dd></div>
          <div data-mail-identity-field style="display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; min-width: 0"><dt style="color: light-dark(#475467,var(--xp-text-secondary))">${t('Size limit')}</dt><dd style="margin: 0">${model.identitySize}</dd></div>
        </dl>
      </section>
      ${renderMailVacationWorkspace({locale:model.locale,mailbox:model.mailbox,canManage:model.vacationCanManage===true,compact:true})}
      <section id="filters" aria-labelledby="filters-title" style="display: flex; flex-direction: column; gap: 12px; padding: 20px; border-radius: 12px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); background: light-dark(#FFFFFF,var(--xp-bg-surface))">
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap"><h2 id="filters-title" style="margin: 0; font-size: 16px; font-weight: 600">${t('Filters')}</h2><span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted))">${escapeHtml(model.filterCount)}</span></div>
        <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px">${model.filterRules}</ol>
        <div style="display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap"><button type="button"${model.product ? ' disabled' : ''} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: light-dark(#1D5BD6,var(--xp-accent)); font-family: inherit; font-size: 14px; font-weight: 600">${t('Add filter')}</button><button type="button"${model.product ? ' disabled' : ''} style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-text-muted)); background: light-dark(#FFFFFF,var(--xp-bg-surface)); color: light-dark(#101828,var(--xp-text-primary)); font-family: inherit; font-size: 14px; font-weight: 600">${t('Manage filters')}</button>${unwired}</div>
      </section>
    </aside>
  </main>
</div>
${COMPOSE_SCRIPT}
</div>`
}

export const renderXmailCompose = (model: ComposeModel): string => renderCompose(model)
const STANDARD: ReadonlyArray<{ id: string; label: string; icon: IconName }> = [
  { id: 'INBOX', label: msgid('Inbox'), icon: 'inbox' },
  { id: 'Sent', label: msgid('Sent'), icon: 'sent' },
  { id: 'Drafts', label: msgid('Drafts'), icon: 'drafts' },
  { id: 'Junk', label: msgctxt('xmail-compose', 'Junk'), icon: 'junk' },
  { id: 'Trash', label: msgctxt('xmail-compose', 'Trash'), icon: 'trash' },
  { id: 'Archive', label: msgid('Archive'), icon: 'archive' },
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
  canSend?: boolean
  canSaveDraft?: boolean
  quotaUsedMb?: number
  quotaUsedBytes?: number
  quotaLimitMb?: number | 'unlimited'
  messages?: XmailComposeMessage[]
  realtimeEnabled?: boolean
  actionState?: AsyncActionBannerProps
  vacationEnabled?: boolean
  vacationCanManage?: boolean
  sieveRules?: XmailComposeRule[]
  identityDkim?: string
  identitySpf?: string
  identitySize?: string
  folderCounts?: Array<{ folder: string; total: number; unread: number }>
  draft?: { to?: string; cc?: string; subject?: string; body?: string }
}

const FILES = msgid('{count, plural, one {{count} file} other {{count} files}}')

/** Arabic attachment counts (zero, one, two, few and many forms come from the catalog). Kept for live-truth.test.ts. */
export const arabicFileCount = (count: number): string => translator('ar')(FILES, { count })

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
  const rtl = localeDirection(locale) === 'rtl'
  const messages = props.messages ?? []
  const unread = messages.filter(message => message.folder === 'INBOX' && message.unread).length
  const observed = new Set(messages.map(message => message.folder).filter(folder => folder !== 'INBOX'))
  const folderHref = (id: string): string => id === 'INBOX' ? '/mail/inbox' : `/mail/inbox?folder=${encodeURIComponent(id)}`
  const folders: FolderLink[] = STANDARD.map(item => {
    const measured = props.folderCounts?.find(row => row.folder === item.id)
    const count = measured ? (item.id === 'INBOX' ? measured.unread : measured.total) : (item.id === 'INBOX' ? unread : 0)
    const link: FolderLink = { label: translator(locale)(item.label), href: folderHref(item.id), icon: item.icon, current: false }
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
    const paused = rule.enabled === false ? ' · ' + translator(locale)('paused') : ''
    return `<li style="display: flex; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid light-dark(#E2E6EC,var(--xp-border)); font-size: 13px; line-height: 1.4"><span aria-hidden="true" style="flex: none; width: 22px; height: 22px; border-radius: 50%; background: light-dark(#EEF0F3,var(--xp-bg-elevated)); color: light-dark(#344054,var(--xp-text-secondary)); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600">${index + 1}</span><span>${escapeHtml(rule.name)}${escapeHtml(paused)} <code style="font-family: ${MONO}">${rtl ? `<bdi dir="ltr">${escapeHtml(rule.condition)}</bdi>` : escapeHtml(rule.condition)}</code> ${rtl ? `<bdi dir="ltr">${escapeHtml(rule.action)}</bdi>` : escapeHtml(rule.action)}</span></li>`
  }).join('')
  const shownIdentity = (value: string | undefined): string => value ? `<bdi dir="auto">${escapeHtml(value)}</bdi>` : '—'
  const vacationKnown = props.vacationEnabled !== undefined
  const vacationOn = props.vacationEnabled === true
  const dash = '—'
  return {
    locale,
    theme: props.theme ?? 'light',
    product: true,
    canSend: props.canSend === true,
    canSaveDraft: props.canSaveDraft === true,
    mailbox: props.mailbox,
    quotaText: quota.text,
    quotaPct: quota.percent ?? 0,
    quotaMeasured: quota.percent !== null,
    composeHref: '/mail/compose',
    inboxHref: '/mail/inbox',
    folders,
    custom,
    vacationHref: '#vacation',
    vacationShort: vacationKnown ? (vacationOn ? (translator(locale)('Requested on')) : (translator(locale)('Requested off'))) : dash,
    filtersHref: '#filters',
    filtersShort: knownRules ? (translator(locale)('{activeRules} active', { activeRules })) : dash,
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
      ? `<p dir="auto" style="margin: ${rtl ? '0 0 0 auto' : '0'}; max-width: 68ch; white-space: pre-wrap"><bdi dir="auto">${escapeHtml(props.draft.body)}</bdi></p>`
      : `<p dir="auto" style="margin: ${rtl ? '0 0 0 auto' : '0'}; max-width: 68ch"></p>`,
    numbersOn: false,
    attachments: [],
    attachSummary: translator(locale)(FILES, { count: 0 }),
    attachHelp: dash,
    identityDkim: shownIdentity(props.identityDkim),
    identitySpf: shownIdentity(props.identitySpf),
    identitySize: shownIdentity(props.identitySize),
    vacationStatus: vacationKnown ? (vacationOn ? (translator(locale)('Requested on; activation unverified')) : (translator(locale)('Requested off; activation unverified'))) : (translator(locale)('Not read; activation unverified')),
    vacationOn,
    vacationCanManage: props.vacationCanManage===true,
    vacationOpenLabel: translator(locale)('Set up responder'),
    filterCount: knownRules ? (translator(locale)('{length} Sieve rules', { length: rules.length })) : dash,
    filterRules: ruleHtml,
    wsHtml: renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true),
    actionHtml: props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : '',
    logoutAttr: ' data-action="logout"',
    routeAttr: ' data-nav-route="/mail/compose"',
  }
}
