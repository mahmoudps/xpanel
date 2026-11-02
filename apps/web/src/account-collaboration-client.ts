import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
interface CollaborationCalendar { name: string; color: string; timezone: string; eventCount: number; shares: { mailbox: string; permission: 'read' | 'read-write' }[] }
interface CollaborationMailbox { mailbox: string; revision: string; calendars: CollaborationCalendar[]; contacts: { count: number; groupCount: number }; canCreateCalendar: boolean }
interface CollaborationView { account: string; mailboxes: CollaborationMailbox[] }
const collaborationObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const collaborationText = (raw: unknown, max: number): raw is string => typeof raw === 'string' && !!raw.trim() && raw.length <= max && raw.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(raw)
const collaborationMailbox = (raw: unknown): raw is string => collaborationText(raw, 254) && /^[^\s@/\\<>]+@[A-Za-z0-9.-]+$/.test(raw)
export function readAccountCollaboration(raw: unknown): CollaborationView | null {
  if (!collaborationObject(raw) || raw.source !== 'saved-mailbox-metadata' || !collaborationObject(raw.context) || !collaborationText(raw.context.account, 16) || !Array.isArray(raw.mailboxes) || raw.mailboxes.length > 1000
    || !collaborationObject(raw.capabilities) || raw.capabilities.createCalendar !== true || ['caldav', 'carddav', 'addressBookCollections', 'taskLists', 'protectedDefaults'].some(key => (raw.capabilities as Record<string, unknown>)[key] !== false)
    || !collaborationObject(raw.application) || raw.application.status !== 'saved_metadata' || raw.application.nativeApplied !== false || raw.application.syncVerified !== false) return null
  const names = new Set<string>()
  for (const mailbox of raw.mailboxes) {
    if (!collaborationObject(mailbox) || !collaborationMailbox(mailbox.mailbox) || names.has(mailbox.mailbox) || typeof mailbox.revision !== 'string' || !/^[0-9a-f]{64}$/.test(mailbox.revision) || typeof mailbox.canCreateCalendar !== 'boolean'
      || !Array.isArray(mailbox.calendars) || mailbox.calendars.length > 25 || !collaborationObject(mailbox.contacts) || !Number.isSafeInteger(mailbox.contacts.count) || Number(mailbox.contacts.count) < 0 || Number(mailbox.contacts.count) > 10000 || !Number.isSafeInteger(mailbox.contacts.groupCount) || Number(mailbox.contacts.groupCount) < 0 || Number(mailbox.contacts.groupCount) > 2560000) return null
    names.add(mailbox.mailbox)
    for (const calendar of mailbox.calendars) {
      if (!collaborationObject(calendar) || !collaborationText(calendar.name, 200) || !collaborationText(calendar.color, 80) || !collaborationText(calendar.timezone, 100) || !Number.isSafeInteger(calendar.eventCount) || Number(calendar.eventCount) < 0 || Number(calendar.eventCount) > 1000 || !Array.isArray(calendar.shares) || calendar.shares.length > 100) return null
      for (const share of calendar.shares) if (!collaborationObject(share) || !collaborationMailbox(share.mailbox) || !['read', 'read-write'].includes(String(share.permission))) return null
    }
  }
  for (const mailbox of raw.mailboxes as unknown as CollaborationMailbox[]) for (const calendar of mailbox.calendars) for (const share of calendar.shares) if (!names.has(share.mailbox) || share.mailbox === mailbox.mailbox) return null
  return { account: raw.context.account, mailboxes: raw.mailboxes as unknown as CollaborationMailbox[] }
}
const collaborationAscii = (raw: string) => raw.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))
function bindAccountCollaboration(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-account-collaboration]').forEach(root => {
    if (root.dataset.collaborationBound === 'true') return
    root.dataset.collaborationBound = 'true'
    const mailbox = root.querySelector<HTMLSelectElement>('[data-collaboration-mailbox]')!, name = root.querySelector<HTMLInputElement>('[data-collaboration-name]')!, color = root.querySelector<HTMLInputElement>('[data-collaboration-color]')!, timezone = root.querySelector<HTMLInputElement>('[data-collaboration-timezone]')!
    const create = root.querySelector<HTMLButtonElement>('[data-collaboration-create]')!, refresh = root.querySelector<HTMLButtonElement>('[data-collaboration-refresh]')!, status = root.querySelector<HTMLElement>('[data-collaboration-status]')!, rows = root.querySelector<HTMLTableSectionElement>('[data-collaboration-collections]')!, shares = root.querySelector<HTMLTableSectionElement>('[data-collaboration-shares]')!
    if (![mailbox, name, color, timezone, create, refresh, status, rows, shares].every(Boolean)) return
    let view: CollaborationView | null = null, busy = false, locked = false
    const admitted = () => root.isConnected && root.dataset.collaborationEnabled === 'true' && !!request && !root.closest('[data-capability-state="unavailable"],[data-capability-state="soon"],[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[aria-disabled="true"],fieldset:disabled')
    const selected = () => view?.mailboxes.find(item => item.mailbox === mailbox.value)
    const draft = () => {
      if (!collaborationText(name.value, 200) || !/^#[0-9a-f]{6}$/i.test(color.value) || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone.value) || timezone.value.length > 100) return null
      try { new Intl.DateTimeFormat('en', { timeZone: timezone.value }).format(0) } catch { return null }
      return { name: name.value.trim(), color: color.value.toLowerCase(), timezone: timezone.value }
    }
    const message = (state: string, text: string) => { status.dataset.state = state; status.textContent = text }
    const controls = () => {
      const off = !admitted() || busy
      refresh.disabled = off
      for (const field of [mailbox, name, color, timezone]) field.disabled = off || locked || !view?.mailboxes.length
      create.disabled = off || locked || !selected()?.canCreateCalendar || !draft() || !askDialog
    }
    const counters = new WeakMap<HTMLElement, number>()
    const rowFor = (count: number): HTMLTableRowElement => cloneClientTemplate(clientTemplate(root, 'account-collaboration-row-' + count), 'tr', Array.from({length:count}, (_, i) => 'value-' + i)) as HTMLTableRowElement
    const cell = (row: HTMLTableRowElement, text: string, technical = false) => {
      const index = counters.get(row) ?? 0, span = clientTemplateSlot(row, 'value-' + index, 'bdi')
      span.dir = technical ? 'ltr' : 'auto'; span.textContent = collaborationAscii(text); counters.set(row, index + 1)
    }
    const empty = (body: HTMLTableSectionElement, count: number, text: string) => { const row = cloneClientTemplate(clientTemplate(root, 'account-collaboration-empty-' + count), 'tr', ['message']); clientTemplateSlot(row, 'message').textContent = text; body.append(row) }
    try { for (const count of [4,5]) { rowFor(count); cloneClientTemplate(clientTemplate(root, 'account-collaboration-empty-' + count), 'tr', ['message']) } }
    catch { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => {control.disabled=true}); status.dataset.state='unavailable'; status.textContent=t('Unavailable'); return }
    const paint = (next: CollaborationView) => {
      const previous = mailbox.value; view = next; mailbox.replaceChildren(); rows.replaceChildren(); shares.replaceChildren()
      for (const item of next.mailboxes) {
        const option = document.createElement('option'); option.value = item.mailbox; option.textContent = item.mailbox; mailbox.append(option)
        for (const calendar of item.calendars) {
          const row = rowFor(5); cell(row, item.mailbox, true); cell(row, calendar.name); cell(row, t(msgctxt('account-collaboration-client', 'Calendar'))); cell(row, String(calendar.eventCount), true); cell(row, calendar.timezone + ' / ' + calendar.color, true); rows.append(row)
          for (const share of calendar.shares) { const shared = rowFor(4); cell(shared, item.mailbox, true); cell(shared, calendar.name); cell(shared, share.mailbox, true); cell(shared, share.permission === 'read-write' ? t('Read and write') : t('Read only')); shares.append(shared) }
        }
        const contacts = rowFor(5); cell(contacts, item.mailbox, true); cell(contacts, t('Saved contacts')); cell(contacts, t('Contacts')); cell(contacts, String(item.contacts.count), true); cell(contacts, t('{count} groups', { count: item.contacts.groupCount })); rows.append(contacts)
      }
      if (next.mailboxes.some(item => item.mailbox === previous)) mailbox.value = previous
      if (!rows.children.length) empty(rows, 5, t('No current email-enabled mailboxes are saved for this account.'))
      if (!shares.children.length) empty(shares, 4, t('No current same-account calendar grants were found in the authorized collections.'))
    }
    const load = async () => {
      if (!admitted() || busy) return
      busy = true; controls(); message('loading', t('Reading current mailbox collections…'))
      try {
        const next = readAccountCollaboration(await request!('GET', '/api/account/collaboration'))
        if (!next || view && next.account !== view.account) throw new Error('invalid_collaboration_view')
        if (!admitted()) return
        paint(next); locked = false; message(next.mailboxes.length ? 'read' : 'empty', t('Current saved mailbox metadata read. Device synchronization remains unverified.'))
      } catch { locked = true; message('failed', t('Collections could not be verified. The draft is retained; explicitly reload.')) }
      finally { busy = false; controls() }
    }
    for (const field of [name, color, timezone]) field.addEventListener('input', controls)
    mailbox.addEventListener('change', controls); refresh.addEventListener('click', () => { void load() })
    create.addEventListener('click', async () => {
      if (!admitted() || busy || locked || !askDialog || !view) return
      const before = view, owner = selected(), fields = draft()
      if (!owner?.canCreateCalendar || !fields) return
      if (await askDialog({ title: t('Create this calendar?'), body: owner.mailbox + '\n' + fields.name, confirm: t('Create calendar') }) !== true || !admitted() || busy || locked || view !== before || mailbox.value !== owner.mailbox || JSON.stringify(draft()) !== JSON.stringify(fields)) return
      busy = true; controls(); message('saving', t('Creating saved calendar…'))
      try {
        const raw = await request!('POST', '/api/account/collaboration/calendars', { mailbox: owner.mailbox, expectedRevision: owner.revision, ...fields }), ack = readAccountCollaboration(raw)
        if (!ack || !collaborationObject(raw) || raw.stateChanged !== true || !collaborationObject(raw.created) || raw.created.mailbox !== owner.mailbox || raw.created.name !== fields.name || raw.created.color !== fields.color || raw.created.timezone !== fields.timezone || ack.account !== before.account) throw new Error('invalid_calendar_ack')
        const after = readAccountCollaboration(await request!('GET', '/api/account/collaboration')), saved = after?.mailboxes.find(item => item.mailbox === owner.mailbox), acknowledged = ack.mailboxes.find(item => item.mailbox === owner.mailbox)
        if (!after || after.account !== before.account || !saved || saved.revision !== acknowledged?.revision || !saved.calendars.some(calendar => calendar.name === fields.name && calendar.color === fields.color && calendar.timezone === fields.timezone && calendar.eventCount === 0 && calendar.shares.length === 0)) throw new Error('calendar_readback_mismatch')
        if (!admitted()) return
        paint(after); name.value = ''; locked = false; message('saved', t('Calendar created and read back from the existing saved collection. DAV discovery and synchronization remain unverified.'))
      } catch (error) {
        locked = true
        const details = collaborationObject(error) && collaborationObject(error.details) ? error.details : collaborationObject(error) && collaborationObject(error.detail) ? error.detail : {}
        const unchanged = details.stateChanged === false && details.verificationRequired !== true && details.unknownOutcome !== true
        message(unchanged ? 'stale' : 'uncertain', unchanged ? t('The request was refused. Keep the draft and explicitly reload before retrying.') : t('The creation outcome is uncertain. Keep the draft and explicitly read saved collections before retrying.'))
      } finally { busy = false; controls() }
    })
    window.addEventListener('beforeunload', event => { if (admitted() && (busy || !!name.value.trim())) { event.preventDefault(); event.returnValue = '' } })
    controls(); if (admitted()) void load()
  })
}
export const ACCOUNT_COLLABORATION_CLIENT_BINDING = `function(askDialog){const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const collaborationObject=${collaborationObject.toString()};const collaborationText=${collaborationText.toString()};const collaborationMailbox=${collaborationMailbox.toString()};const readAccountCollaboration=${readAccountCollaboration.toString()};const collaborationAscii=${collaborationAscii.toString()};(${bindAccountCollaboration.toString()})(askDialog);}`
