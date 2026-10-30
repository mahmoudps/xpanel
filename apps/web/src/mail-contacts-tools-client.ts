import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />

/**
 * Mailbox Contacts tools: vCard import, vCard export and same-account sharing.
 * All transports go through window.xpanelSessionRequest to the real contacts routes.
 * Nothing here claims delivery, synchronisation or CardDAV; imported/shared rows are
 * stored contact configuration and are verified by re-reading the contacts list.
 */

const contactToolsUnsafe = /<script\b|javascript:|vbscript:|data:text\/html|on[a-z]+\s*=|\0/i
const contactToolsEmail = /^[^\s@/\\]+@[^\s@/\\]+$/
const IMPORT_LIMIT = 256 * 1024

export interface ContactToolsPreview { cards: number; errors: string[] }
export interface ContactsToolsContact { id: string; owner: string; fullName: string; email: string; shares: { principal: string; permission: 'read' | 'read-write' }[] }

export function contactsToolsObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Strict local preview of a vCard document; the server remains the authority. */
export function contactsToolsVcardPreview(text: unknown): ContactToolsPreview {
  const errors: string[] = []
  if (typeof text !== 'string' || !text.trim()) return { cards: 0, errors: ['empty'] }
  if (new TextEncoder().encode(text).length > IMPORT_LIMIT) return { cards: 0, errors: ['too_large'] }
  if (contactToolsUnsafe.test(text)) return { cards: 0, errors: ['unsafe'] }
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  let cards = 0, open = false, fullName = '', email = ''
  for (const line of lines) {
    if (line === 'BEGIN:VCARD') {
      if (open) { errors.push('nested'); return { cards, errors } }
      open = true; fullName = ''; email = ''
      continue
    }
    if (line === 'END:VCARD') {
      if (!open) { errors.push('unmatched'); return { cards, errors } }
      if (!fullName || !contactToolsEmail.test(email)) { errors.push('missing_name_or_email:' + (cards + 1)); }
      cards++; open = false
      continue
    }
    if (!open) continue
    if (line.startsWith('FN:')) fullName = line.slice(3).trim()
    else if (/^EMAIL(?:;[^:]*)?:/i.test(line)) email = line.slice(line.indexOf(':') + 1).trim().toLowerCase()
  }
  if (open) errors.push('unterminated')
  return { cards, errors }
}

export function contactsToolsSharePayload(principal: unknown, permission: unknown): { principal: string; permission: 'read' | 'read-write' } {
  if (typeof principal !== 'string' || !contactToolsEmail.test(principal.trim().toLowerCase())) throw new Error('invalid_share_principal')
  if (permission !== 'read' && permission !== 'read-write') throw new Error('invalid_share_permission')
  return { principal: principal.trim().toLowerCase(), permission }
}

/** Reads the contacts list shape used by the tools and refuses malformed rows. */
export function contactsToolsList(value: unknown, mailbox: string): ContactsToolsContact[] {
  if (!contactsToolsObject(value) || !contactsToolsObject(value.context) || value.context.mailbox !== mailbox || !Array.isArray(value.contacts)) throw new Error('invalid_contacts_list')
  return value.contacts.map(raw => {
    if (!contactsToolsObject(raw) || typeof raw.id !== 'string' || typeof raw.owner !== 'string' || typeof raw.fullName !== 'string' || typeof raw.email !== 'string') throw new Error('invalid_contacts_list')
    const shares = Array.isArray(raw.shares) ? raw.shares : []
    const visited = new Set<string>()
    const parsedShares = shares.map(share => {
      if (!contactsToolsObject(share) || typeof share.principal !== 'string' || !contactToolsEmail.test(share.principal.toLowerCase()) || (share.permission !== 'read' && share.permission !== 'read-write')) throw new Error('invalid_contacts_list')
      const principal = share.principal.toLowerCase()
      if (visited.has(principal)) throw new Error('invalid_contacts_list')
      visited.add(principal)
      return { principal, permission: share.permission as 'read' | 'read-write' }
    })
    return { id: raw.id, owner: raw.owner, fullName: raw.fullName, email: raw.email, shares: parsedShares }
  })
}

function bindContactsTools(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-contacts-tools]').forEach(root => {
    if (root.dataset.contactsToolsBound === 'true') return
    root.dataset.contactsToolsBound = 'true'
    const mailbox = root.dataset.contactsToolsMailbox ?? ''
    const manageable = root.dataset.contactsToolsManage === 'true'
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const importFile = root.querySelector<HTMLInputElement>('[data-contacts-import-file]')
    const importText = root.querySelector<HTMLTextAreaElement>('[data-contacts-import-text]')
    const importPreview = root.querySelector<HTMLElement>('[data-contacts-import-preview]')
    const importStatus = root.querySelector<HTMLElement>('[data-contacts-import-status]')
    const importButton = root.querySelector<HTMLButtonElement>('[data-contacts-import]')
    const exportButton = root.querySelector<HTMLButtonElement>('[data-contacts-export]')
    const exportStatus = root.querySelector<HTMLElement>('[data-contacts-export-status]')
    const contactSelect = root.querySelector<HTMLSelectElement>('[data-contacts-share-contact]')
    const sharePrincipal = root.querySelector<HTMLInputElement>('[data-contacts-share-principal]')
    const sharePermission = root.querySelector<HTMLSelectElement>('[data-contacts-share-permission]')
    const shareAdd = root.querySelector<HTMLButtonElement>('[data-contacts-share-add]')
    const sharesList = root.querySelector<HTMLElement>('[data-contacts-shares]')
    const shareStatus = root.querySelector<HTMLElement>('[data-contacts-share-status]')
    if (!importText || !importButton || !exportButton || !sharesList) return
    try { mailRequireTemplates(root, [['mail-contact-share', 'li', ['address', 'permission', 'remove']], ['mail-contact-share-empty', 'li', ['message']]]) }
    catch { root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea').forEach(control => { control.disabled = true }); if (shareStatus) { shareStatus.dataset.state = 'unavailable'; shareStatus.textContent = copy('Unavailable') }; return }
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && manageable && !root.closest(denied) && contactToolsEmail.test(mailbox)
    let pendingVcard = ''
    let contacts: ContactsToolsContact[] = []
    let busy = false, uncertain = false
    const setStatus = (node: HTMLElement | null, message: string, kind: string): void => {
      if (!node) return
      node.hidden = !message
      node.dataset.state = kind
      node.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status')
      node.textContent = message
    }
    const lock = (): void => {
      const blocked = busy || uncertain || !eligible()
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button,input,textarea,select').forEach(node => { node.disabled = blocked })
      if (exportButton) exportButton.disabled = busy || !eligible()
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport) return Promise.reject(Object.assign(new Error('transport_unavailable'), { stateChanged: false }))
      return transport(method, path, body)
    }
    const preview = (): void => {
      const result = contactsToolsVcardPreview(importText.value || pendingVcard)
      if (!result.cards && !result.errors.length) { setStatus(importPreview, copy('No vCard content has been read.'), 'idle'); return }
      const summary = result.errors.length
        ? copy('{cards} card(s) parsed with {length} problem(s): {value}. Nothing can be imported until every card is valid.', { cards: result.cards, length: result.errors.length, value: result.errors.slice(0, 3).join(', ') })
        : copy('{cards} card(s) are ready to import after confirmation.', { cards: result.cards })
      setStatus(importPreview, summary, result.errors.length ? 'failed' : 'ready')
    }
    const loadContacts = async (): Promise<void> => {
      const list = contactsToolsList(await request('GET', '/api/webmail/contacts'), mailbox)
      contacts = list.filter(contact => contact.owner.toLowerCase() === mailbox)
      if (contactSelect) {
        const previous = contactSelect.value
        contactSelect.textContent = ''
        if (!contacts.length) {
          const option = document.createElement('option'); option.value = ''; option.textContent = copy('No owned contacts yet')
          contactSelect.appendChild(option)
        }
        for (const contact of contacts) {
          const option = document.createElement('option'); option.value = contact.id; option.textContent = contact.fullName + ' — ' + contact.email
          option.textContent = option.textContent
          contactSelect.appendChild(option)
        }
        contactSelect.value = contacts.some(contact => contact.id === previous) ? previous : (contacts[0]?.id ?? '')
      }
      paintShares()
    }
    const paintShares = (): void => {
      sharesList.textContent = ''
      const selected = contacts.find(contact => contact.id === contactSelect?.value)
      if (!selected) {
        const empty = mailTemplate(root, 'mail-contact-share-empty', 'li', ['message']); mailSlot(empty, 'message').textContent = copy('Choose an owned contact to review its sharing.')
        sharesList.appendChild(empty)
        return
      }
      if (!selected.shares.length) {
        const empty = mailTemplate(root, 'mail-contact-share-empty', 'li', ['message']); mailSlot(empty, 'message').textContent = copy('This contact is not shared with another mailbox.')
        sharesList.appendChild(empty)
        return
      }
      for (const share of selected.shares) {
        const item = mailTemplate(root, 'mail-contact-share', 'li', ['address', 'permission', 'remove'])
        mailSlot(item, 'address', 'bdi').textContent = share.principal
        mailSlot(item, 'permission').textContent = ' · ' + (share.permission === 'read-write' ? copy('Read and edit') : copy('Read only'))
        const remove = mailSlot<HTMLButtonElement>(item, 'remove', 'button'); remove.textContent = copy('Remove sharing')
        remove.addEventListener('click', async () => { if (busy || uncertain || !eligible()) return; await removeShare(selected, share.principal) })
        sharesList.appendChild(item)
      }
    }
    const runWrite = async (work: () => Promise<void>, targetStatus: HTMLElement | null = shareStatus): Promise<void> => {
      if (busy || uncertain || !eligible()) return
      busy = true; lock()
      let dispatched = false
      try {
        dispatched = true
        await work()
      } catch (error) {
        const detail = contactsToolsObject(error) && contactsToolsObject(error.details) ? error.details : {}
        const certain = contactsToolsObject(error) && (error.stateChanged === false || detail.stateChanged === false) && detail.unknownOutcome !== true && detail.verificationRequired !== true
        if (!certain) {
          uncertain = true
          setStatus(targetStatus, copy('The outcome is uncertain. Reload the page and inspect stored contacts before retrying; no automatic retry was sent.'), 'uncertain')
        } else {
          setStatus(targetStatus, copy('The action was refused or its result did not verify. Nothing was retried.'), 'failed')
        }
      } finally { busy = false; lock(); void dispatched }
    }
    const importContacts = async (): Promise<void> => {
      if (!eligible() || busy || uncertain) return
      const vcard = (importText.value || pendingVcard).trim()
      const review = contactsToolsVcardPreview(vcard)
      if (!vcard || review.errors.length) { setStatus(importStatus, copy('Fix every card in the preview before importing. Nothing was sent.'), 'failed'); return }
      if (typeof askDialog !== 'function') { setStatus(importStatus, copy('Import confirmation is unavailable; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Import contacts'), body: copy('{cards} card(s) will be stored in this mailbox.', { cards: review.cards }), confirm: copy('Import') })
      if (confirmed !== true) { setStatus(importStatus, copy('Import was cancelled. Nothing was sent.'), 'cancelled'); return }
      await runWrite(async () => {
        const result = await request('POST', '/api/webmail/contacts/import', { vcard })
        if (!contactsToolsObject(result) || !Array.isArray(result.contacts) || typeof result.importedCount !== 'number' || result.importedCount !== result.contacts.length || !result.importedCount) throw new Error('invalid_import_ack')
        const ids = result.contacts.map(entry => contactsToolsObject(entry) ? String(entry.id ?? '') : '').filter(Boolean)
        const observed = contactsToolsList(await request('GET', '/api/webmail/contacts'), mailbox)
        if (ids.some(id => !observed.some(contact => contact.id === id))) throw new Error('import_not_observed')
        await loadContacts()
        window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-tools', mailbox } }))
        importText.value = ''; pendingVcard = ''
        setStatus(importPreview, copy('No vCard content has been read.'), 'idle')
        setStatus(importStatus, copy('{length} card(s) were stored and read back. Synchronisation is not claimed.', { length: ids.length }), 'saved')
      }, importStatus)
    }
    const exportContacts = async (): Promise<void> => {
      if (busy || !eligible()) return
      setStatus(exportStatus, copy('Reading the export…'), 'reading')
      try {
        const result = await request('GET', '/api/webmail/contacts/export')
        if (!contactsToolsObject(result) || result.mailbox !== mailbox || typeof result.vcard !== 'string' || typeof result.count !== 'number') throw new Error('invalid_export')
        if (typeof URL.createObjectURL === 'function' && typeof document.createElement === 'function' && typeof Blob === 'function') {
          const blob = new Blob([result.vcard], { type: 'text/vcard' })
          const url = URL.createObjectURL(blob)
          try { const link = document.createElement('a'); link.href = url; link.download = 'contacts-' + mailbox.replace(/[^a-z0-9._-]/gi, '_') + '.vcf'; link.click() } finally { URL.revokeObjectURL(url) }
        }
        setStatus(exportStatus, copy('Exported {count} contact(s) from the server document.', { count: result.count }), 'saved')
      } catch {
        setStatus(exportStatus, copy('The export could not be read. Nothing is claimed.'), 'failed')
      }
    }
    const addShare = async (): Promise<void> => {
      if (!eligible() || busy || uncertain) return
      const selected = contacts.find(contact => contact.id === contactSelect?.value)
      if (!selected) { setStatus(shareStatus, copy('Choose an owned contact first.'), 'failed'); return }
      let payload: { principal: string; permission: 'read' | 'read-write' }
      try { payload = contactsToolsSharePayload(sharePrincipal?.value, sharePermission?.value) } catch {
        setStatus(shareStatus, copy('Enter a valid teammate mailbox and choose read-only or read-and-edit.'), 'failed'); return
      }
      await runWrite(async () => {
        const result = await request('POST', '/api/webmail/contacts/' + encodeURIComponent(selected.id) + '/share', payload)
        if (!contactsToolsObject(result) || !contactsToolsObject(result.contact) || !Array.isArray(result.contact.shares)) throw new Error('invalid_share_ack')
        const shares = result.contact.shares
        const granted = shares.some(share => contactsToolsObject(share) && typeof share.principal === 'string' && share.principal.toLowerCase() === payload.principal && share.permission === payload.permission)
        if (!granted) throw new Error('share_not_observed')
        await loadContacts()
        window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-tools', mailbox } }))
        if (sharePrincipal) sharePrincipal.value = ''
        setStatus(shareStatus, copy('Sharing was stored and read back. Shared rows stay visible to their mailbox only.'), 'saved')
      })
    }
    const removeShare = async (selected: ContactsToolsContact, principal: string): Promise<void> => {
      if (typeof askDialog !== 'function') { setStatus(shareStatus, copy('Removing sharing needs confirmation; nothing was sent.'), 'failed'); return }
      const confirmed = await askDialog({ title: copy('Remove sharing'), body: principal, confirm: copy('Remove sharing'), danger: true })
      if (confirmed !== true) { setStatus(shareStatus, copy('Removal was cancelled. Nothing was sent.'), 'cancelled'); return }
      await runWrite(async () => {
        const result = await request('DELETE', '/api/webmail/contacts/' + encodeURIComponent(selected.id) + '/share', { principal })
        if (!contactsToolsObject(result) || !contactsToolsObject(result.contact) || !Array.isArray(result.contact.shares)) throw new Error('invalid_share_ack')
        if (result.contact.shares.some(share => contactsToolsObject(share) && String(share.principal).toLowerCase() === principal)) throw new Error('share_still_present')
        await loadContacts()
        window.dispatchEvent(new CustomEvent('xpanel:contacts-changed', { detail: { source: 'contact-tools', mailbox } }))
        setStatus(shareStatus, copy('The sharing entry was removed and verified.'), 'saved')
      })
    }
    if (!transport || !eligible()) {
      root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('button,input,textarea,select').forEach(node => { node.disabled = true })
      setStatus(importStatus, copy('Contact tools are unavailable here. Nothing was read or changed.'), 'unavailable')
      return
    }
    importText.addEventListener('input', () => { pendingVcard = ''; preview() })
    importFile?.addEventListener('change', () => {
      const file = importFile.files?.[0]; if (!file) return
      if (!Number.isSafeInteger(file.size) || file.size > IMPORT_LIMIT) { setStatus(importPreview, copy('The vCard file exceeds the 256 KiB import limit.'), 'failed'); return }
      const reader = typeof FileReader === 'function' ? new FileReader() : null
      if (!reader) { setStatus(importPreview, copy('Reading the selected file is unavailable in this browser.'), 'failed'); return }
      reader.onload = () => { pendingVcard = typeof reader.result === 'string' ? reader.result : ''; importText.value = pendingVcard; preview() }
      reader.onerror = () => setStatus(importPreview, copy('The selected vCard file could not be read.'), 'failed')
      reader.readAsText(file)
    })
    importButton.addEventListener('click', event => { event.preventDefault(); void importContacts() })
    exportButton.addEventListener('click', event => { event.preventDefault(); void exportContacts() })
    shareAdd?.addEventListener('click', event => { event.preventDefault(); void addShare() })
    contactSelect?.addEventListener('change', paintShares)
    lock()
    void loadContacts().catch(() => setStatus(shareStatus, copy('Owned contacts could not be read; sharing stays unavailable.'), 'failed'))
  })
}

export const MAIL_CONTACTS_TOOLS_CLIENT_BINDING = `(function(askDialog){${MAIL_CLIENT_TEMPLATE_KIT}const contactToolsUnsafe=${contactToolsUnsafe.toString()};const contactToolsEmail=${contactToolsEmail.toString()};const IMPORT_LIMIT=${IMPORT_LIMIT};const contactsToolsObject=${contactsToolsObject.toString()};const contactsToolsVcardPreview=${contactsToolsVcardPreview.toString()};const contactsToolsSharePayload=${contactsToolsSharePayload.toString()};const contactsToolsList=${contactsToolsList.toString()};(${bindContactsTools.toString()})(askDialog);})`
