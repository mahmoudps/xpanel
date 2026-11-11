import { msgctxt } from '@xpanel/core'
import { escapeHtml } from './html.ts'
import { pageScript, pageScriptTag } from './page-scripts.ts'

// Compose behaviour shared by every theme: formatting, recipient chips, discard confirmation and send guards.
// It is keyed on data-* hooks under [data-board-port="xmail-compose"]; a theme styles what it creates.
const COMPOSE_SOURCE = `
(function () {
  var root = document.querySelector('[data-board-port="xmail-compose"]')
  if (!root) return
  var product = root.getAttribute('data-product') === 'true'
  var text = function (name) { return root.getAttribute(name) || '' }
  var notifyComposeInput = function () { var host = root.querySelector('[data-compose-identities]') || root; if (host && typeof host.dispatchEvent === 'function' && typeof Event === 'function') host.dispatchEvent(new Event('input', { bubbles: true })) }
  // The theme's own discard control (icon and all) comes back on Keep editing.
  var idleDiscard = null
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
    notifyComposeInput()
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
      if (typeof editor.dispatchEvent === 'function' && typeof Event === 'function') editor.dispatchEvent(new Event('input', { bubbles: true }))
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
      if (typeof editor.dispatchEvent === 'function' && typeof Event === 'function') editor.dispatchEvent(new Event('input', { bubbles: true }))
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
      if (chip) notifyComposeInput()
    }
    if (name === 'remove-file') {
      var file = action.closest('[data-mail-file]')
      if (file) {
        file.remove()
        notifyComposeInput()
      }
    }
    if (name === 'discard-ask') {
      var group = root.querySelector('[data-mail-discard]')
      if (!group) return
      idleDiscard = Array.prototype.slice.call(group.childNodes)
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
      if (idleDiscard) { idleDiscard.forEach(function (node) { idle.appendChild(node) }); return }
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
        if (last) notifyComposeInput()
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
`

/** The script tag a compose document ends with. */
export const MAIL_COMPOSE_EDITOR_SCRIPT = pageScriptTag(pageScript('xmail-compose', COMPOSE_SOURCE), 'xmail-compose-client')

/** The sentences and the inbox link the script reads from the compose root, as its data-* attributes. */
export function mailComposeEditorCopy(t: (message: string) => string, inboxHref: string, feedback?: { sendOk: string; saved: string; savedNote: string }): string {
  return [
    ['data-add-another', t('Add another')],
    ['data-add-recipient', t('Add a recipient')],
    ['data-check-address', t('· check address')],
    ['data-remove', t('Remove {name}')],
    ['data-discard', t('Discard')],
    ['data-discard-ask', t(msgctxt('xmail-compose', 'Discard this draft?'))],
    ['data-keep', t('Keep editing')],
    ['data-discard-go', t('Discard draft')],
    ['data-inbox-href', inboxHref],
    ['data-format-unavailable', t('Formatting could not be applied. Your message is unchanged.')],
    ['data-format-link-prompt', t('Link address (https://, http:// or mailto:)')],
    ['data-format-link-invalid', t('Use an http, https or mailto link without embedded credentials.')],
    ['data-send-empty', t('Not sent: the To field is empty. Your message is kept as it is.')],
    ['data-send-invalid', t('Not sent: an address is not valid. Fix or remove it and send again.')],
    ['data-send-wait', t('Waiting for the attachment to finish uploading. Send again when it is done, or remove it.')],
    ['data-send-ok', feedback?.sendOk ?? t('Sent. A copy is in Sent.')],
    ['data-saved', feedback?.saved ?? t('Draft saved')],
    ['data-saved-note', feedback?.savedNote ?? t('Draft saved to Drafts.')],
  ].map(([name, value]) => ` ${name}="${escapeHtml(value ?? '')}"`).join('')
}
