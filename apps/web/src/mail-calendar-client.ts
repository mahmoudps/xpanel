import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
interface CalendarEventView { id: string; uid: string; summary: string; description: string; location: string; dtstart: string; dtend: string; timezone: string }
interface CalendarView { id: string; owner: string; name: string; color: string; timezone: string; revision: string; storedBytes: number; canWrite: boolean; canManage: boolean; createdAt: string; events: CalendarEventView[]; shares: { principal: string; permission: 'read' | 'read-write'; sharedAt: string; effective: boolean }[] }
interface CalendarWorkspaceView { calendars: CalendarView[]; revision: string; limits: { calendars: number; events: number; shares: number; icsBytes: number; calendarBytes: number } }

/** Self-contained browser binding over the authorized, persisted calendar family. */
function bindMailCalendar(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, revision = /^[0-9a-f]{64}$/
  const safeText = (value: unknown, maximum: number, multiline = false): value is string => typeof value === 'string' && value.isWellFormed() && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(multiline ? value.replace(/[\r\n]/g, '') : value)
  const email = (value: unknown): value is string => safeText(value, 254) && /^[^\s@/\\]+@[^\s@/\\]+$/.test(value)
  const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{8}(?:T\d{6}Z?)?$/.test(value)
  document.querySelectorAll<HTMLElement>('[data-mail-calendar]').forEach(root => {
    if (root.dataset.calendarBound === 'true') return
    root.dataset.calendarBound = 'true'
    const mailbox = (root.dataset.calendarMailbox ?? '').trim().toLowerCase()
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.calendarManage === 'true' && email(mailbox) && !root.closest(denied)
    const input = (key: string): HTMLInputElement => root.querySelector<HTMLInputElement>('[data-calendar-' + key + ']')!
    const button = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-calendar-' + key + ']')!
    const select = root.querySelector<HTMLSelectElement>('[data-calendar-select]')!, eventSelect = root.querySelector<HTMLSelectElement>('[data-calendar-event-select]')!
    const permission = root.querySelector<HTMLSelectElement>('[data-calendar-share-permission]')!
    const source = root.querySelector<HTMLTextAreaElement>('[data-calendar-ics]')!, exported = root.querySelector<HTMLTextAreaElement>('[data-calendar-exported]')!
    const status = root.querySelector<HTMLElement>('[data-calendar-status]')!, shareRows = root.querySelector<HTMLElement>('[data-calendar-shares]')!
    if (!select || !eventSelect || !permission || !source || !exported || !status || !shareRows || ['refresh', 'new', 'save', 'delete', 'event-new', 'event-save', 'event-delete', 'share', 'import', 'export', 'download'].some(key => !button(key))) return
    const metadata = ['name', 'color', 'timezone'] as const
    const eventFields = ['summary', 'description', 'location', 'start', 'end', 'timezone'] as const
    if (metadata.some(key => !input(key)) || eventFields.some(key => !input('event-' + key)) || !input('share-principal')) return
    try { mailRequireTemplates(root, [['mail-calendar-share', 'li', ['address', 'permission', 'remove']], ['mail-calendar-share-empty', 'li', ['message']]]) } catch { root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea').forEach(control => { control.disabled = true }); status.dataset.state = 'unavailable'; status.textContent = t('Unavailable'); return }
    let workspace: CalendarWorkspaceView | null = null, selected: CalendarView | null = null, selectedEvent: CalendarEventView | null = null
    let busy = false, review = false, downloadSource = ''
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!transport || !admitted()) return Promise.reject({ status: 403, details: { stateChanged: false } })
      return body === undefined ? transport(method, path) : transport(method, path, body)
    }
    const announce = (state: string, value: string): void => { status.dataset.state = state; status.textContent = value; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const eventDraft = (): Omit<CalendarEventView, 'id' | 'uid'> => ({ summary: input('event-summary').value.trim(), description: input('event-description').value.trim(), location: input('event-location').value.trim(), dtstart: input('event-start').value.trim(), dtend: input('event-end').value.trim() || input('event-start').value.trim(), timezone: input('event-timezone').value.trim() || selected?.timezone || 'UTC' })
    const eventComparable = (event: CalendarEventView): Omit<CalendarEventView, 'id' | 'uid'> => ({ summary: event.summary, description: event.description, location: event.location, dtstart: event.dtstart, dtend: event.dtend, timezone: event.timezone })
    const eventDirty = (): boolean => selectedEvent ? JSON.stringify(eventDraft()) !== JSON.stringify(eventComparable(selectedEvent)) : !!input('event-summary').value.trim() || !!input('event-start').value.trim() || !!input('event-description').value.trim() || !!input('event-location').value.trim()
    const dirty = (): boolean => !!workspace && (metadata.some(key => input(key).value !== (selected ? selected[key] : key === 'color' ? '#4f6bed' : key === 'timezone' ? 'UTC' : ''))
      || eventDirty() || !!source.value.trim() || !!input('share-principal').value.trim())
    const lock = (): void => {
      const blocked = busy || review || !admitted() || !workspace
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = blocked })
      exported.disabled = false
      button('refresh').disabled = busy || !admitted()
      select.disabled = busy || !admitted() || !workspace
      button('new').disabled = blocked
      const owner = !selected || selected.canManage, write = !!selected?.canWrite
      const ownCapacity = !!workspace && workspace.calendars.filter(calendar => calendar.canManage).length >= workspace.limits.calendars
      const eventCapacity = !!selected && !!workspace && (selected.events.length >= workspace.limits.events || selected.storedBytes >= workspace.limits.calendarBytes)
      button('new').disabled = blocked || ownCapacity
      metadata.forEach(key => { input(key).disabled = blocked || !owner })
      button('save').disabled = blocked || !owner || !selected && ownCapacity || !input('name').value.trim()
      button('delete').disabled = blocked || !selected?.canManage
      eventSelect.disabled = blocked || !selected
      eventFields.forEach(key => { input('event-' + key).disabled = blocked || !write })
      button('event-new').disabled = blocked || !write || eventCapacity
      button('event-save').disabled = blocked || !write || !selectedEvent && eventCapacity || !input('event-summary').value.trim() || !input('event-start').value.trim()
      button('event-delete').disabled = blocked || !write || !selectedEvent
      input('share-principal').disabled = blocked || !selected?.canManage
      permission.disabled = blocked || !selected?.canManage
      const addingShare = !selected?.shares.some(share => share.principal.toLowerCase() === input('share-principal').value.trim().toLowerCase())
      button('share').disabled = blocked || !selected?.canManage || !input('share-principal').value.trim() || !!selected && !!workspace && addingShare && selected.shares.length >= workspace.limits.shares
      source.disabled = blocked || !write
      button('import').disabled = blocked || !write || !source.value.trim()
      button('export').disabled = blocked || !selected
      button('download').disabled = blocked || !selected || !downloadSource
      root.setAttribute('aria-busy', String(busy))
    }
    const readCalendar = (value: unknown): CalendarView => {
      if (!object(value) || typeof value.id !== 'string' || !id.test(value.id) || !email(value.owner) || !safeText(value.name, 200) || !value.name.trim() || !safeText(value.color, 80) || !safeText(value.timezone, 100) || typeof value.revision !== 'string' || !revision.test(value.revision) || typeof value.canWrite !== 'boolean' || typeof value.canManage !== 'boolean' || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.events) || !Array.isArray(value.shares)) throw new Error('invalid_calendar')
      if (value.canManage !== (value.owner.toLowerCase() === mailbox.toLowerCase()) || value.canManage && !value.canWrite || !value.canManage && value.shares.length) throw new Error('invalid_calendar_scope')
      if (value.events.length > 10000 || value.shares.length > 1000 || typeof value.storedBytes !== 'number' || !Number.isSafeInteger(value.storedBytes) || value.storedBytes < 1) throw new Error('invalid_calendar_capacity')
      const events = value.events.map(raw => {
        if (!object(raw) || typeof raw.id !== 'string' || !id.test(raw.id) || !safeText(raw.uid, 512) || !safeText(raw.summary, 300) || !safeText(raw.description, 5000, true) || !safeText(raw.location, 500) || !timestamp(raw.dtstart) || !timestamp(raw.dtend) || !safeText(raw.timezone, 100)) throw new Error('invalid_event')
        return { id: raw.id, uid: raw.uid, summary: raw.summary, description: raw.description, location: raw.location, dtstart: raw.dtstart, dtend: raw.dtend, timezone: raw.timezone }
      })
      if (new Set(events.map(event => event.id)).size !== events.length || new Set(events.map(event => event.uid)).size !== events.length) throw new Error('duplicate_event')
      const shares = value.shares.map(raw => {
        if (!object(raw) || !email(raw.principal) || !['read', 'read-write'].includes(String(raw.permission)) || typeof raw.sharedAt !== 'string' || !Number.isFinite(Date.parse(raw.sharedAt)) || typeof raw.effective !== 'boolean') throw new Error('invalid_share')
        return { principal: raw.principal, permission: raw.permission as 'read' | 'read-write', sharedAt: raw.sharedAt, effective: raw.effective }
      })
      if (new Set(shares.map(share => share.principal.toLowerCase())).size !== shares.length) throw new Error('duplicate_share')
      return { id: value.id, owner: value.owner, name: value.name, color: value.color, timezone: value.timezone, revision: value.revision, storedBytes: value.storedBytes, canWrite: value.canWrite, canManage: value.canManage, createdAt: value.createdAt, events, shares }
    }
    const context = (value: unknown): Record<string, unknown> => {
      if (!object(value) || !object(value.context) || value.context.mailbox !== mailbox || !object(value.application) || value.application.nativeApplied !== false || value.application.syncVerified !== false) throw new Error('calendar_context_mismatch')
      if (value.unknownOutcome === true || value.verificationRequired === true || object(value.details) && (value.details.unknownOutcome === true || value.details.verificationRequired === true)) throw new Error('calendar_unknown_ack')
      return value
    }
    const readWorkspace = (value: unknown): CalendarWorkspaceView => {
      const data = context(value)
      if (!Array.isArray(data.calendars) || data.calendars.length > 1000 || typeof data.revision !== 'string' || !revision.test(data.revision) || !object(data.limits)) throw new Error('invalid_calendar_workspace')
      const limits = data.limits
      if (['calendars', 'events', 'shares', 'icsBytes', 'calendarBytes'].some(key => typeof limits[key] !== 'number' || !Number.isSafeInteger(limits[key]) || (limits[key] as number) < 1)) throw new Error('invalid_calendar_limits')
      const calendars = data.calendars.map(readCalendar)
      if (new Set(calendars.map(calendar => calendar.id)).size !== calendars.length) throw new Error('duplicate_calendar')
      return { calendars, revision: data.revision, limits: { calendars: limits.calendars as number, events: limits.events as number, shares: limits.shares as number, icsBytes: limits.icsBytes as number, calendarBytes: limits.calendarBytes as number } }
    }
    const fillEvent = (event: CalendarEventView | null): void => {
      selectedEvent = event
      const values = event ? eventComparable(event) : { summary: '', description: '', location: '', dtstart: '', dtend: '', timezone: selected?.timezone ?? 'UTC' }
      for (const key of eventFields) input('event-' + key).value = key === 'start' ? values.dtstart : key === 'end' ? values.dtend : values[key]
      eventSelect.value = event?.id ?? ''
    }
    const clearExport = (): void => { exported.value = ''; downloadSource = '' }
    const install = (value: CalendarWorkspaceView, calendarId?: string | null): void => {
      workspace = value; review = false
      selected = calendarId === null ? null : value.calendars.find(calendar => calendar.id === calendarId) ?? value.calendars[0] ?? null
      select.textContent = ''
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = t('New calendar'); select.append(blank)
      for (const calendar of value.calendars) { const option = document.createElement('option'); option.value = calendar.id; option.textContent = calendar.name + (calendar.canManage ? '' : ' · ' + calendar.owner); select.append(option) }
      select.value = selected?.id ?? ''
      for (const key of metadata) input(key).value = selected ? selected[key] : key === 'color' ? '#4f6bed' : key === 'timezone' ? 'UTC' : ''
      root.querySelector<HTMLElement>('[data-calendar-owner]')!.textContent = selected?.owner ?? mailbox
      root.querySelector<HTMLElement>('[data-calendar-access]')!.textContent = !selected || selected.canManage ? t('Owner') : selected.canWrite ? t('Shared: event editing') : t('Shared: read only')
      const owned = value.calendars.filter(calendar => calendar.canManage).length
      root.querySelector<HTMLElement>('[data-calendar-capacity]')!.textContent = selected
        ? t('{owned} / {calendars} owned calendars · {events} / {eventLimit} events · {bytes} / {byteLimit} bytes', { owned, calendars: value.limits.calendars, events: selected.events.length, eventLimit: value.limits.events, bytes: selected.storedBytes, byteLimit: value.limits.calendarBytes })
        : t('{owned} / {calendars} owned calendars', { owned, calendars: value.limits.calendars })
      eventSelect.textContent = ''
      const newEvent = document.createElement('option'); newEvent.value = ''; newEvent.textContent = t('New event'); eventSelect.append(newEvent)
      for (const event of selected?.events ?? []) { const option = document.createElement('option'); option.value = event.id; option.textContent = event.summary + ' · ' + event.dtstart; eventSelect.append(option) }
      fillEvent(null); shareRows.textContent = ''
      if (!selected?.shares.length) { const row = mailTemplate(root, 'mail-calendar-share-empty', 'li', ['message']); mailSlot(row, 'message').textContent = selected && !selected.canManage ? t('Sharing details are available to the owner.') : t('No mailbox shares were returned.'); shareRows.append(row) }
      for (const share of selected?.shares ?? []) {
        const row = mailTemplate(root, 'mail-calendar-share', 'li', ['address', 'permission', 'remove']), remove = mailSlot<HTMLButtonElement>(row, 'remove', 'button')
        mailSlot(row, 'address', 'bdi').textContent = share.principal
        mailSlot(row, 'permission').textContent = ' · ' + (share.permission === 'read-write' ? t('Read and edit events') : t('Read only')) + (!share.effective ? ' · ' + t('Access withheld; explicitly save this recipient again to grant current access.') : '')
        remove.textContent = t('Revoke sharing'); remove.dataset.calendarRevoke = ''
        remove.addEventListener('click', () => { if (!remove.disabled && selected?.canManage) void mutate('DELETE', '/api/webmail/calendars/' + encodeURIComponent(selected.id) + '/share', { principal: share.principal, expectedRevision: selected.revision }, t('Revoke calendar sharing?'), true) })
        shareRows.append(row)
      }
      input('share-principal').value = ''; permission.value = 'read'; source.value = ''; clearExport(); lock()
    }
    const confirm = async (title: string, message: string, danger = false): Promise<boolean> => {
      if (!askDialog) { announce('failed', t('Confirmation is unavailable; nothing was sent.')); return false }
      try { return await askDialog({ title, body: message, danger, confirm: t('Confirm') }) === true } catch { return false }
    }
    const refresh = async (calendarId?: string | null): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; lock()
      try {
        if ((dirty() || review) && !await confirm(t('Discard edits and read calendars?'), t('Unsaved edits are discarded only after a successful authorized read. A previous write is never retried.'), true)) return
        announce('reading', t('Reading saved calendar records…'))
        install(readWorkspace(await request('GET', '/api/webmail/calendars')), calendarId === undefined ? selected?.id : calendarId)
        announce('read', t('Saved calendars read. Device synchronization remains unverified.'))
      } catch { announce(review ? 'uncertain' : 'failed', t('Calendars could not be read. Your edits are kept and no mutation was sent.')) }
      finally { busy = false; lock() }
    }
    const mutate = async (method: string, path: string, body: Record<string, unknown>, title: string, danger = false): Promise<void> => {
      if (busy || review || !workspace || !admitted()) return
      const target = selected, creating = path === '/api/webmail/calendars'
      const eventRoute = /\/events(?:\/([^/]+))?$/.exec(path)
      const deletion = method === 'DELETE' && !path.endsWith('/share') && !eventRoute
      busy = true; lock(); let submitted = false
      try {
        if (!await confirm(title, (target?.name ?? String(body.name ?? '')) + '\n' + t('This changes stored calendar records. Saved records are reloaded afterward and other unsaved fields are discarded. Device synchronization remains unverified.'), danger)) return
        if (!admitted()) return
        announce('saving', t('Saving and reading back calendar records…'))
        submitted = true
        const reply = context(await request(method, path, body))
        let acknowledged: CalendarView | null = null
        if (deletion) {
          if (reply.ok !== true || reply.calendarId !== target?.id) throw new Error('wrong_calendar_delete_ack')
        } else {
          acknowledged = readCalendar(reply.calendar)
          if (creating ? acknowledged.owner !== mailbox : acknowledged.id !== target?.id) throw new Error('wrong_calendar_ack')
          if (eventRoute) {
            const changedId = eventRoute[1]
            if (method === 'DELETE') {
              if (reply.ok !== true || reply.deletedEventId !== changedId || acknowledged.events.some(event => event.id === changedId)) throw new Error('calendar_event_delete_mismatch')
            } else {
              if (!object(reply.event) || typeof reply.event.id !== 'string') throw new Error('calendar_event_ack_missing')
              const acknowledgedEventId = reply.event.id
              const event = acknowledged.events.find(event => event.id === acknowledgedEventId)
              if (!event || changedId && event.id !== changedId) throw new Error('calendar_event_ack_mismatch')
              for (const key of ['summary', 'description', 'location', 'dtstart', 'dtend', 'timezone'] as const) if (body[key] !== undefined && event[key] !== String(body[key]).trim()) throw new Error('calendar_event_value_mismatch')
            }
            const expectedCount = target!.events.length + (method === 'POST' ? 1 : method === 'DELETE' ? -1 : 0)
            if (acknowledged.events.length !== expectedCount) throw new Error('calendar_event_count_mismatch')
            for (const previous of target!.events) if (previous.id !== changedId && JSON.stringify(acknowledged.events.find(event => event.id === previous.id)) !== JSON.stringify(previous)) throw new Error('unrelated_calendar_event_changed')
          }
          if (!eventRoute) for (const key of metadata) if (body[key] !== undefined && acknowledged[key] !== String(body[key]).trim()) throw new Error('calendar_settings_mismatch')
          if (Array.isArray(body.events)) {
            if (body.events.length !== acknowledged.events.length) throw new Error('calendar_events_mismatch')
            for (let index = 0; index < body.events.length; index++) {
              const desired = body.events[index] as Record<string, unknown>, actual = acknowledged.events[index]!
              if (desired.id !== undefined && desired.id !== actual.id) throw new Error('calendar_event_identity_mismatch')
              for (const key of ['summary', 'description', 'location', 'dtstart', 'dtend', 'timezone'] as const) if (actual[key] !== (desired[key] ?? (key === 'timezone' ? acknowledged.timezone : key === 'dtend' ? desired.dtstart : ''))) throw new Error('calendar_event_readback_mismatch')
            }
          }
          if (path.endsWith('/share')) {
            const shared = acknowledged.shares.find(share => share.principal === body.principal)
            if (method === 'DELETE') {
              if (shared) throw new Error('calendar_share_mismatch')
            } else if (!shared || shared.permission !== body.permission || shared.effective !== true) throw new Error('calendar_share_mismatch')
          }
        }
        const observed = readWorkspace(await request('GET', '/api/webmail/calendars'))
        const found = observed.calendars.find(calendar => calendar.id === (acknowledged?.id ?? target?.id))
        if (deletion ? !!found : !found || JSON.stringify(found) !== JSON.stringify(acknowledged)) throw new Error('calendar_persisted_readback_mismatch')
        install(observed, deletion ? undefined : acknowledged!.id)
        announce(deletion ? 'deleted' : 'saved', t('Calendar records saved and read back. Device synchronization remains unverified.'))
      } catch (error) {
        const failure = object(error) ? error : {}, detail = object(failure.details) ? failure.details : {}
        const noChange = detail.stateChanged === false || failure.stateChanged === false || typeof failure.status === 'number' && [400, 401, 403, 404, 412, 413, 422].includes(failure.status) && detail.stateChanged !== true && detail.unknownOutcome !== true && detail.verificationRequired !== true
        review = submitted && (!noChange || failure.status === 409)
        announce(review ? failure.status === 409 ? 'stale' : 'uncertain' : 'failed', review
          ? t('The result requires review. Your edits are kept; no retry was sent. Read saved calendars before continuing.')
          : t('The request was refused or could not be sent. Your edits are kept; nothing was retried.'))
      } finally { busy = false; lock() }
    }
    const invalid = (): void => announce('failed', t('Check required fields, ASCII dates and event order. Nothing was sent.'))
    button('save').addEventListener('click', () => {
      if (button('save').disabled || selected && !selected.canManage) return
      const color = input('color').value.trim()
      const fields = { name: input('name').value.trim(), color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : color, timezone: input('timezone').value.trim() }
      if (!fields.name || !fields.color || !fields.timezone) { invalid(); return }
      void mutate(selected ? 'PATCH' : 'POST', '/api/webmail/calendars' + (selected ? '/' + encodeURIComponent(selected.id) : ''), { ...fields, expectedRevision: selected?.revision ?? workspace!.revision }, selected ? t('Save calendar settings?') : t('Create calendar?'))
    })
    button('delete').addEventListener('click', () => { if (!button('delete').disabled && selected?.canManage) void mutate('DELETE', '/api/webmail/calendars/' + encodeURIComponent(selected.id), { expectedRevision: selected.revision }, t('Delete this calendar and its events?'), true) })
    button('event-save').addEventListener('click', () => {
      if (button('event-save').disabled || !selected?.canWrite) return
      const draft = eventDraft()
      if (!safeText(draft.summary, 300) || !draft.summary || !timestamp(draft.dtstart) || !timestamp(draft.dtend) || draft.dtstart.length !== draft.dtend.length || draft.dtend < draft.dtstart) { invalid(); return }
      void mutate(selectedEvent ? 'PATCH' : 'POST', '/api/webmail/calendars/' + encodeURIComponent(selected.id) + '/events' + (selectedEvent ? '/' + encodeURIComponent(selectedEvent.id) : ''), { ...draft, expectedRevision: selected.revision }, t('Save calendar event?'))
    })
    button('event-delete').addEventListener('click', () => { if (!button('event-delete').disabled && selected?.canWrite && selectedEvent) void mutate('DELETE', '/api/webmail/calendars/' + encodeURIComponent(selected.id) + '/events/' + encodeURIComponent(selectedEvent.id), { expectedRevision: selected.revision }, t('Delete this event?'), true) })
    const chooseEvent = async (chosen: string): Promise<void> => {
      if (!selected || busy || review || !admitted()) return
      busy = true; lock()
      try { if (eventDirty() && !await confirm(t('Discard event edits?'), t('Unsaved event edits will be discarded.'), true)) return; if (admitted()) fillEvent(selected.events.find(event => event.id === chosen) ?? null) }
      finally { busy = false; lock() }
    }
    button('event-new').addEventListener('click', () => { if (!button('event-new').disabled) void chooseEvent('') })
    eventSelect.addEventListener('change', () => {
      const chosen = eventSelect.value; eventSelect.value = selectedEvent?.id ?? ''
      void chooseEvent(chosen)
    })
    button('share').addEventListener('click', () => { if (!button('share').disabled && selected?.canManage) { const principal = input('share-principal').value.trim().toLowerCase(); if (!email(principal) || !['read', 'read-write'].includes(permission.value)) { invalid(); return }; void mutate('POST', '/api/webmail/calendars/' + encodeURIComponent(selected.id) + '/share', { principal, permission: permission.value, expectedRevision: selected.revision }, t('Save calendar sharing?')) } })
    button('import').addEventListener('click', () => { if (!button('import').disabled && selected?.canWrite) { if (new TextEncoder().encode(source.value).length > workspace!.limits.icsBytes) { invalid(); return }; void mutate('POST', '/api/webmail/calendars/' + encodeURIComponent(selected.id) + '/import', { ics: source.value, expectedRevision: selected.revision }, t('Import and update events by UID?')) } })
    button('export').addEventListener('click', () => {
      if (button('export').disabled || !selected || busy || review) return
      const target = selected; busy = true; lock()
      void request('GET', '/api/webmail/calendars/' + encodeURIComponent(target.id) + '/export').then(reply => {
        const value = context(reply)
        if (value.calendarId !== target.id || value.revision !== target.revision || typeof value.ics !== 'string' || new TextEncoder().encode(value.ics).length > 8 * 1024 * 1024 || typeof value.eventsCount !== 'number' || value.eventsCount !== target.events.length) throw new Error('invalid_export')
        exported.value = value.ics; downloadSource = value.ics
        announce('exported', t('Stored iCalendar source read. Download is ready; device synchronization is unverified.'))
      }).catch(() => { clearExport(); announce('failed', t('Export could not be verified. Read saved calendars before exporting again.')) }).finally(() => { busy = false; lock() })
    })
    button('download').addEventListener('click', () => {
      if (button('download').disabled || !downloadSource || !selected || !admitted()) return
      if (typeof URL.createObjectURL !== 'function') { announce('failed', t('File downloads are unavailable in this browser.')); return }
      const url = URL.createObjectURL(new Blob([downloadSource], { type: 'text/calendar;charset=utf-8' })), link = document.createElement('a')
      link.href = url; link.download = (selected.name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 80) || 'calendar') + '.ics'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
    select.addEventListener('change', () => { const chosen = select.value; select.value = selected?.id ?? ''; void refresh(chosen || null) })
    button('refresh').addEventListener('click', () => { void refresh() })
    button('new').addEventListener('click', () => { if (!button('new').disabled) void refresh(null) })
    root.addEventListener('input', lock); root.addEventListener('change', lock)
    window.addEventListener('beforeunload', event => { if (dirty() || review) { event.preventDefault(); event.returnValue = '' } })
    if (!transport || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true }); announce('unavailable', t('Calendar records are unavailable here. Nothing was read or changed.')); return }
    void refresh()
  })
}

export const MAIL_CALENDAR_CLIENT_BINDING = `(()=>{${MAIL_CLIENT_TEMPLATE_KIT}return ${bindMailCalendar.toString()};})()`
