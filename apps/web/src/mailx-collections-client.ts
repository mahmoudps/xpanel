/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export type MailxCollectionItemView = { id: string | null; name: string; description: string; isDefault: boolean }
export type MailxCollectionsView = {
  account: string
  mailboxes: { mailbox: string; revision: string; defaultCalendar: string | null; calendars: { id: string; name: string; description: string }[]; addressBooks: MailxCollectionItemView[]; taskLists: MailxCollectionItemView[] }[]
}
export type MailxCalendarsView = { account: string; mailboxes: { mailbox: string; revision: string; calendars: { id: string; name: string; color: string; timezone: string }[] }[] }
type Ask = (options: { title: string; body: string; confirm: string; danger?: boolean }) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict readers for GET /api/account/mailx/collections and the calendar part of GET /api/account/collaboration. */
export function readMailxCollections(value: unknown, kind: 'collections' | 'calendars'): MailxCollectionsView | MailxCalendarsView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mailx_collections_view') }
  const text = (item: unknown, max: number, empty = false): item is string => typeof item === 'string' && item.length <= max && (empty || item.length > 0)
  const id = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{32}$/.test(item)
  const list = <T>(item: unknown, max: number, read: (raw: Record<string, unknown>) => T): T[] => Array.isArray(item) && item.length <= max ? item.map(raw => object(raw) ? read(raw) : bad()) : bad()
  const entries = (item: unknown): MailxCollectionItemView[] => {
    const rows = list(item, 50, raw => id(raw.id) && text(raw.name, 200) && text(raw.description, 500, true) && typeof raw.isDefault === 'boolean' ? { id: raw.id, name: raw.name, description: raw.description, isDefault: raw.isDefault } : bad())
    return rows.length && rows.filter(row => row.isDefault).length !== 1 ? bad() : rows
  }
  if (!object(value) || !object(value.context) || !text(value.context.account, 16)) return bad()
  if (kind === 'collections') {
    if (!object(value.dav) || value.dav.caldav !== 'unavailable' || value.dav.carddav !== 'unavailable' || !object(value.application) || value.application.davServed !== false) return bad()
    return { account: value.context.account, mailboxes: list(value.mailboxes, 1000, raw => {
      if (!text(raw.mailbox, 254) || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)) return bad()
      const calendars = list(raw.calendars, 25, item => id(item.id) && text(item.name, 200) && text(item.description, 500, true) ? { id: item.id, name: item.name, description: item.description } : bad())
      if (!(raw.defaultCalendar === null || calendars.some(item => item.id === raw.defaultCalendar))) return bad()
      return { mailbox: raw.mailbox, revision: raw.revision, defaultCalendar: raw.defaultCalendar as string | null, calendars, addressBooks: entries(raw.addressBooks), taskLists: entries(raw.taskLists) }
    }) }
  }
  return { account: value.context.account, mailboxes: list(value.mailboxes, 1000, raw => text(raw.mailbox, 254) && typeof raw.revision === 'string' && /^[0-9a-f]{64}$/.test(raw.revision)
    ? { mailbox: raw.mailbox, revision: raw.revision, calendars: list(raw.calendars, 25, item => id(item.id) && text(item.name, 200) && text(item.color, 80) && text(item.timezone, 100) ? { id: item.id, name: item.name, color: item.color, timezone: item.timezone } : bad()) } : bad()) }
}

function bindMailxCollections(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mailx-collections]').forEach(root => {
    if (root.dataset.mailxCollectionsBound === 'true') return
    root.dataset.mailxCollectionsBound = 'true'
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    const get = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-mailx-' + key + ']')!
    const calMailbox = get<HTMLSelectElement>('calendar-mailbox'), calTarget = get<HTMLSelectElement>('calendar-target'), calName = get<HTMLInputElement>('calendar-name'), calColor = get<HTMLInputElement>('calendar-color'), calZone = get<HTMLInputElement>('calendar-timezone')
    const calSave = get<HTMLButtonElement>('calendar-save'), calDelete = get<HTMLButtonElement>('calendar-delete'), calStatus = get<HTMLElement>('calendar-status')
    const form = get<HTMLElement>('collections-form'), boxSelect = get<HTMLSelectElement>('collections-mailbox'), defaultSelect = get<HTMLSelectElement>('collections-default'), descriptions = get<HTMLElement>('descriptions')
    const save = get<HTMLButtonElement>('collections-save'), refresh = get<HTMLButtonElement>('collections-refresh'), status = get<HTMLElement>('collections-status')
    const bodies = { 'address-books': get<HTMLElement>('address-books'), 'task-lists': get<HTMLElement>('task-lists') }
    if (![calMailbox, calTarget, calName, calColor, calZone, calSave, calDelete, calStatus, form, boxSelect, defaultSelect, descriptions, save, refresh, status, bodies['address-books'], bodies['task-lists']].every(Boolean)) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailxCanManage === 'true' && !root.closest(denied) && !!request
    let collections: MailxCollectionsView | null = null, calendars: MailxCalendarsView | null = null, busy = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const options = (target: HTMLSelectElement, items: { value: string; label: string }[], keep: string): void => {
      target.replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.value; option.textContent = item.label; return option }))
      if (items.some(item => item.value === keep)) target.value = keep
    }
    const calendarBox = () => calendars?.mailboxes.find(item => item.mailbox === calMailbox.value)
    const calendar = () => calendarBox()?.calendars.find(item => item.id === calTarget.value)
    const draft = (): { name: string; color: string; timezone: string } | null => {
      const name = calName.value.trim(), color = calColor.value.trim().toLowerCase(), timezone = calZone.value.trim()
      if (!name || name.length > 200 || !/^#[0-9a-f]{6}$/.test(color) || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) return null
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0) } catch { return null }
      return { name, color, timezone }
    }
    const controls = (): void => {
      const off = busy || !admitted()
      for (const control of [calMailbox, calTarget, boxSelect, defaultSelect]) control.disabled = off || !(control === calMailbox || control === calTarget ? calendars : collections)?.mailboxes.length
      for (const control of [calName, calColor, calZone]) control.disabled = off || !calendar()
      calSave.disabled = off || !calendar() || !draft() || !askDialog; calDelete.disabled = off || !calendar() || !askDialog
      save.disabled = off || !collections?.mailboxes.length; refresh.disabled = off
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('[data-mailx-descriptions] textarea,[data-mailx-address-books] :is(input,button),[data-mailx-task-lists] :is(input,button),[data-mailx-add]')
        .forEach(control => { control.disabled = off || !collections?.mailboxes.length })
    }
    const paintCalendar = (): void => {
      options(calTarget, (calendarBox()?.calendars ?? []).map(item => ({ value: item.id, label: item.name })), calTarget.value)
      const current = calendar()
      calName.value = current?.name ?? ''; calColor.value = current?.color ?? ''; calZone.value = current?.timezone ?? ''
      controls()
    }
    const row = (kind: 'address-books' | 'task-lists', item: MailxCollectionItemView): HTMLTableRowElement => {
      const tr = document.createElement('tr'); tr.dataset.itemId = item.id ?? ''
      const cell = (content: HTMLElement): void => { const td = document.createElement('td'); td.append(content); tr.append(td) }
      const name = document.createElement('input'); name.type = 'text'; name.className = 'xp-input'; name.maxLength = 200; name.value = item.name; name.dataset.itemName = ''; name.setAttribute('aria-label', t('Name'))
      const description = document.createElement('input'); description.type = 'text'; description.className = 'xp-input'; description.maxLength = 500; description.value = item.description; description.dataset.itemDescription = ''; description.setAttribute('aria-label', t('Description'))
      const fallback = document.createElement('input'); fallback.type = 'radio'; fallback.name = 'mailx-default-' + kind; fallback.checked = item.isDefault; fallback.dataset.itemDefault = ''; fallback.setAttribute('aria-label', t('Default'))
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'xp-btn'; remove.textContent = t('Remove')
      remove.addEventListener('click', () => { tr.remove(); if (!bodies[kind].querySelector('tr[data-item-id]')) empty(kind) })
      cell(name); cell(description); cell(fallback); cell(remove)
      return tr
    }
    const empty = (kind: 'address-books' | 'task-lists'): void => { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 4; td.textContent = kind === 'address-books' ? t('No address books are saved.') : t('No task lists are saved.'); tr.append(td); bodies[kind].replaceChildren(tr) }
    const paintSettings = (): void => {
      const box = collections?.mailboxes.find(item => item.mailbox === boxSelect.value)
      options(defaultSelect, [{ value: '', label: t('No default calendar') }, ...(box?.calendars ?? []).map(item => ({ value: item.id, label: item.name }))], box?.defaultCalendar ?? '')
      descriptions.replaceChildren(...(box?.calendars ?? []).map(item => {
        const wrap = document.createElement('div'); wrap.className = 'xp-mailx__field'
        const label = document.createElement('label'), area = document.createElement('textarea'); area.className = 'xp-input'; area.rows = 2; area.maxLength = 500; area.id = 'mailx-description-' + item.id; area.dataset.calendarId = item.id; area.value = item.description
        label.htmlFor = area.id; label.textContent = t('Description of {calendar}', { calendar: item.name }); wrap.append(label, area); return wrap
      }))
      if (!box?.calendars.length) { const p = document.createElement('p'); p.className = 'xp-help'; p.textContent = t('This mailbox has no calendars.'); descriptions.append(p) }
      for (const kind of ['address-books', 'task-lists'] as const) {
        const items = (kind === 'address-books' ? box?.addressBooks : box?.taskLists) ?? []
        if (items.length) bodies[kind].replaceChildren(...items.map(item => row(kind, item))); else empty(kind)
      }
      controls()
    }
    const load = async (after?: string): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); note(status, 'reading', t('Reading collection settings…'))
      try {
        const nextCollections = readMailxCollections(await request!('GET', '/api/account/mailx/collections'), 'collections') as MailxCollectionsView
        const nextCalendars = readMailxCollections(await request!('GET', '/api/account/collaboration'), 'calendars') as MailxCalendarsView
        if (!admitted() || nextCollections.account !== nextCalendars.account) throw new Error('account_mismatch')
        collections = nextCollections; calendars = nextCalendars
        const boxes = nextCollections.mailboxes.map(item => ({ value: item.mailbox, label: item.mailbox }))
        options(boxSelect, boxes, boxSelect.value); options(calMailbox, nextCalendars.mailboxes.map(item => ({ value: item.mailbox, label: item.mailbox })), calMailbox.value)
        if (after) note(status, 'saved', after)
        else note(status, boxes.length ? 'read' : 'empty', boxes.length ? t('Collection settings read. They are not served to devices until a DAV server is connected.') : t('No current email-enabled mailboxes are saved for this account.'))
        // A just-reported calendar outcome stays visible across the readback.
        if (!['saved', 'failed'].includes(calStatus.dataset.state ?? '')) note(calStatus, 'read', nextCalendars.mailboxes.some(item => item.calendars.length) ? t('Choose a calendar to edit or delete.') : t('No saved calendars were found.'))
        busy = false; paintCalendar(); paintSettings()
      } catch { note(status, 'failed', t('Collection settings could not be read. Explicitly reload before changing anything.')) }
      finally { busy = false; controls() }
    }
    const failure = (error: unknown): string => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
      return details.unknownOutcome === true || details.verificationRequired === true ? t('The outcome is unknown. Reload and review before retrying.')
        : problem.status === 409 || problem.code === 'CONFLICT' ? t('These collections changed since they were read. Reload and review before saving.')
          : problem.status === 422 || problem.code === 'VALIDATION' ? t('Some values are not valid. Nothing was saved.') : t('The request failed. Reload to see what was saved.')
    }
    const change = async (method: 'PATCH' | 'DELETE'): Promise<void> => {
      const box = calendarBox(), current = calendar(), fields = method === 'PATCH' ? draft() : null
      if (busy || !admitted() || !askDialog || !box || !current || method === 'PATCH' && !fields) return
      const confirmed = await askDialog(method === 'PATCH' ? { title: t('Save calendar changes?'), body: current.name, confirm: t('Edit collection') }
        : { title: t('Delete this calendar?'), body: t('The calendar {calendar} and its events will be deleted from {mailbox}.', { calendar: current.name, mailbox: box.mailbox }), confirm: t('Delete collection'), danger: true }).catch(() => false)
      if (confirmed !== true || calendar() !== current) return
      busy = true; controls(); note(calStatus, 'saving', method === 'PATCH' ? t('Saving the calendar…') : t('Deleting the calendar…'))
      try {
        await request!(method, '/api/account/collaboration/calendars/' + current.id, { mailbox: box.mailbox, ...(fields ?? {}), expectedRevision: box.revision })
        note(calStatus, 'saved', method === 'PATCH' ? t('Calendar saved and read back.') : t('Calendar deleted and read back.'))
      } catch (error) { note(calStatus, 'failed', failure(error)) }
      finally { busy = false; controls() }
      await load()
    }
    const collect = (kind: 'address-books' | 'task-lists'): MailxCollectionItemView[] => [...bodies[kind].querySelectorAll<HTMLTableRowElement>('tr[data-item-id]')].map(tr => ({
      id: tr.dataset.itemId || null, name: tr.querySelector<HTMLInputElement>('[data-item-name]')!.value.trim(), description: tr.querySelector<HTMLInputElement>('[data-item-description]')!.value.trim(), isDefault: tr.querySelector<HTMLInputElement>('[data-item-default]')!.checked }))
    calMailbox.addEventListener('change', paintCalendar); calTarget.addEventListener('change', paintCalendar)
    for (const control of [calName, calColor, calZone]) control.addEventListener('input', controls)
    calSave.addEventListener('click', () => { void change('PATCH') }); calDelete.addEventListener('click', () => { void change('DELETE') })
    boxSelect.addEventListener('change', paintSettings); refresh.addEventListener('click', () => { void load() })
    root.querySelectorAll<HTMLButtonElement>('[data-mailx-add]').forEach(button => button.addEventListener('click', () => {
      const kind = button.dataset.mailxAdd as 'address-books' | 'task-lists'
      if (!bodies[kind].querySelector('tr[data-item-id]')) bodies[kind].replaceChildren()
      bodies[kind].append(row(kind, { id: null, name: '', description: '', isDefault: !bodies[kind].querySelector('tr[data-item-id]') })); controls()
    }))
    // A read-only document renders this block as a <div>, which never submits.
    if (form instanceof HTMLFormElement) form.addEventListener('submit', event => {
      event.preventDefault()
      const box = collections?.mailboxes.find(item => item.mailbox === boxSelect.value)
      if (busy || !admitted() || !box) return
      const body = { mailbox: box.mailbox, expectedRevision: box.revision, defaultCalendar: defaultSelect.value || null,
        descriptions: Object.fromEntries([...descriptions.querySelectorAll<HTMLTextAreaElement>('textarea[data-calendar-id]')].map(area => [area.dataset.calendarId!, area.value.trim()])),
        addressBooks: collect('address-books'), taskLists: collect('task-lists') }
      busy = true; controls(); note(status, 'saving', t('Saving collection settings…'))
      void (async () => {
        let saved = false
        try { await request!('PUT', '/api/account/mailx/collections', body); saved = true }
        catch (error) { note(status, 'failed', failure(error)) }
        finally { busy = false; controls() }
        if (saved) await load(t('Collection settings saved and read back.'))
      })()
    })
    if (!admitted()) { controls(); note(status, 'unavailable', t('Collection settings are unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const MAILX_COLLECTIONS_CLIENT_BINDING = `(()=>{const readMailxCollections=${readMailxCollections.toString()};return ${bindMailxCollections.toString()};})()`
