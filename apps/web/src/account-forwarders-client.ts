import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime

export type RoutingState = 'applied' | 'pending' | 'failed'
export interface RoutingApplication { state: RoutingState; reason: string | null }
export interface ForwarderRecord { id: string; sourceAddress: string; action: 'forward' | 'reject'; destinations: string[]; rejectMessage?: string; createdAt?: string; application: RoutingApplication }

/** The host state of one record; anything else is not evidence and fails closed. */
export function readRoutingApplication(value: unknown): RoutingApplication {
  const app = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!app || !['applied', 'pending', 'failed'].includes(String(app.state)) || !(app.reason === null || typeof app.reason === 'string')) throw new Error('unverified_application_state')
  return { state: app.state as RoutingState, reason: app.reason as string | null }
}
export function readForwarderRecords(value: unknown): ForwarderRecord[] {
  const rows = value && typeof value === 'object' ? (value as Record<string, unknown>).forwarders : undefined
  if (!Array.isArray(rows)) throw new Error('invalid_forwarder_read')
  return rows.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || typeof row.sourceAddress !== 'string' || !Array.isArray(row.destinations) || row.destinations.some((item: unknown) => typeof item !== 'string')) throw new Error('invalid_forwarder_read')
    const action = row.action === 'reject' ? 'reject' : row.action === 'forward' ? 'forward' : null
    if (!action || (action === 'forward' ? !row.destinations.length : typeof row.rejectMessage !== 'string')) throw new Error('invalid_forwarder_read')
    return { id: row.id, sourceAddress: row.sourceAddress, action, destinations: [...row.destinations], ...(action === 'reject' ? { rejectMessage: row.rejectMessage } : {}),
      ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}), application: readRoutingApplication(row.application) }
  })
}
export function forwarderWriteUncertain(error: unknown): boolean {
  const failure = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const details = failure.details && typeof failure.details === 'object' ? failure.details as Record<string, unknown> : {}
  if (['verificationRequired', 'stateChanged', 'unknownOutcome', 'needsAttention'].some(key => failure[key] === true || details[key] === true)) return true
  return !(details.stateChanged === false || (typeof failure.status === 'number' && failure.status >= 400 && failure.status < 500 && failure.status !== 408))
}
/** A datetime-local value read as UTC, in the canonical whole-second form the API stores. */
export function utcInstant(local: string): string | null {
  if (!local) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('invalid_time')
  const value = local + ':00.000Z'
  if (new Date(value).toISOString() !== value) throw new Error('invalid_time')
  return value
}

function bindAccountForwarders(askDialog?: (options: Record<string, unknown>) => Promise<string | boolean | null>): void {
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const copy = (message: string, values?: MessageValues) => xpT(message, values)
  const unavailable = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const stateText = (app: RoutingApplication) => app.state === 'applied' ? copy('Applied')
    : app.state === 'pending' ? copy('Saved, not applied yet')
    : app.reason ? copy('Not applied: {reason}', { reason: app.reason }) : copy('Not applied')
  const failureText = (error: unknown) => {
    const details = error && typeof error === 'object' && (error as Record<string, unknown>).details && typeof (error as Record<string, unknown>).details === 'object' ? (error as { details: Record<string, unknown> }).details : {}
    return details.rolledBack === true ? (typeof details.reason === 'string' ? copy('The mail server refused the change and kept the previous configuration: {reason}', { reason: details.reason }) : copy('The mail server refused the change and kept the previous configuration.'))
      : copy('The request was refused. Your input is kept.')
  }
  const rowRoots = new WeakMap<HTMLElement, HTMLElement>()
  const routingRow = (root: HTMLElement): HTMLTableRowElement => { const row=cloneClientTemplate(clientTemplate(root,'account-routing-row'),'tr',[]) as HTMLTableRowElement;rowRoots.set(row,root);return row }
  const routingAction = (root: HTMLElement): HTMLTableCellElement => cloneClientTemplate(clientTemplate(root,'account-routing-action'),'td',[]) as HTMLTableCellElement
  const routingButton = (root: HTMLElement): HTMLButtonElement => cloneClientTemplate(clientTemplate(root,'account-routing-button'),'button',[]) as HTMLButtonElement
  const cell = (row: HTMLTableRowElement, values: string[], technical: boolean) => {
    const root=rowRoots.get(row)!, td=cloneClientTemplate(clientTemplate(root,'account-routing-cell'),'td',[])
    values.forEach((value,index)=>{ if(index)td.append(cloneClientTemplate(clientTemplate(root,'account-routing-break'),'br',[])); const token=cloneClientTemplate(clientTemplate(root,technical?'account-routing-technical':'account-routing-text'),technical?'bdi':'span',[]);token.textContent=value;td.append(token) })
    row.append(td);return td
  }
  /** One section: read, paint, and serialized writes that lock after an uncertain outcome. */
  const section = (root: HTMLElement, key: string, read: () => Promise<void>) => {
    const status = root.querySelector<HTMLElement>(`[data-${key}-status]`)
    try { for(const [name,tag] of [['row','tr'],['action','td'],['button','button'],['cell','td'],['break','br'],['technical','bdi'],['text','span']] as const) cloneClientTemplate(clientTemplate(root,'account-routing-'+name),tag,[]) }
    catch { root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(control=>{control.disabled=true});if(status){status.dataset.state='unavailable';status.textContent=copy('Unavailable')}return {load:async()=>{},write:async()=>{}} }
    const state = { busy: false, review: false, read: false, manage: root.dataset[`${key}Manage`] === 'true' }
    const note = (text: string, kind: string) => { if (status) { status.textContent = text; status.dataset.state = kind; status.setAttribute('role', kind === 'uncertain' || kind === 'failed' ? 'alert' : 'status') } }
    const controls = () => {
      root.setAttribute('aria-busy', String(state.busy))
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = Boolean(root.closest(unavailable)) || state.busy || (!button.hasAttribute('data-forwarder-refresh') && (!state.manage || !state.read || state.review)) })
    }
    const load = async () => {
      if (state.busy || root.closest(unavailable) || !request) return
      state.busy = true; controls(); note(copy('Reading…'), 'pending')
      try { await read(); state.read = true; state.review = false; note(copy('Read from the server.'), 'read') }
      catch { state.read = false; note(copy('Records could not be read. Editing is unavailable.'), 'failed') }
      finally { state.busy = false; controls() }
    }
    const write = async (method: string, path: string, body: unknown, done: () => void) => {
      if (!request || state.busy || !state.manage || !state.read || state.review || root.closest(unavailable)) return
      state.busy = true; controls(); note(copy('Saving and applying…'), 'pending')
      let acknowledged = false
      try {
        await request(method, path, body)
        acknowledged = true
        await read(); done()
        note(copy('Saved. The table shows what the mail server runs.'), 'saved')
      } catch (error) {
        state.review = acknowledged || forwarderWriteUncertain(error)
        note(state.review ? copy('The saved state is uncertain. Refresh and review before another change. Your input is kept.') : failureText(error), state.review ? 'uncertain' : 'failed')
      } finally { state.busy = false; controls() }
    }
    controls(); void load()
    return { load, write }
  }
  const confirmRemove = async (title: string, detail: string) => {
    const accepted = askDialog ? await askDialog({ title, body: detail, confirm: title, danger: true }) : window.confirm(title + '\n' + detail)
    return accepted === true
  }

  document.querySelectorAll<HTMLElement>('[data-forwarder-workspace]').forEach(root => {
    if (root.dataset.forwarderBound === 'true') return
    root.dataset.forwarderBound = 'true'
    const rows = root.querySelector<HTMLTableSectionElement>('[data-forwarder-rows]')
    const empty = root.querySelector<HTMLElement>('[data-forwarder-empty]')
    const form = root.querySelector<HTMLFormElement>('[data-forwarder-create]')
    const manage = root.dataset.forwarderManage === 'true'
    const ui = section(root, 'forwarder', async () => {
      const items = readForwarderRecords(await request!('GET', '/api/mail/forwarders'))
      if (!rows) return
      rows.textContent = ''
      for (const item of items) {
        const row = routingRow(root)
        cell(row, [item.sourceAddress], true)
        if (item.action === 'reject') cell(row, [copy('Rejected with an error: {message}', { message: item.rejectMessage ?? '' })], false)
        else cell(row, item.destinations, true)
        cell(row, [item.createdAt === undefined ? copy(msgctxt('account-forwarders-client', 'Not read')) : displayDateTime(item.createdAt)], true)
        cell(row, [stateText(item.application)], false).dataset.routingState = item.application.state
        const action = routingAction(root)
        if (manage) { const button = routingButton(root); button.dataset.forwarderDelete = item.id; button.dataset.forwarderSource = item.sourceAddress; button.textContent = copy('Delete forwarder'); action.appendChild(button) }
        else action.textContent = copy(msgctxt('account-forwarders-client', 'Read only'))
        row.appendChild(action); rows.appendChild(row)
      }
      if (empty) { empty.hidden = items.length > 0; empty.textContent = copy('No forwarders.') }
    })
    const mode = () => (form?.querySelector<HTMLInputElement>('input[name="forwarder-mode"]:checked')?.value ?? 'forward') as 'forward' | 'reject'
    const syncMode = () => {
      if (!form) return
      const reject = mode() === 'reject'
      const destination = form.querySelector<HTMLElement>('[data-forwarder-destination-field]'), message = form.querySelector<HTMLElement>('[data-forwarder-reject-field]')
      if (destination) destination.hidden = reject
      if (message) message.hidden = !reject
      ;(form.elements.namedItem('destinations') as HTMLInputElement).required = !reject
      ;(form.elements.namedItem('rejectMessage') as HTMLInputElement).required = reject
    }
    form?.addEventListener('change', syncMode); syncMode()
    root.querySelector('[data-forwarder-refresh]')?.addEventListener('click', () => { void ui.load() })
    form?.addEventListener('submit', event => {
      event.preventDefault()
      if (!form.reportValidity()) return
      const source = (form.elements.namedItem('source') as HTMLInputElement).value.trim().toLowerCase()
      const body = mode() === 'reject'
        ? { sourceAddress: source, action: 'reject', rejectMessage: (form.elements.namedItem('rejectMessage') as HTMLInputElement).value.trim() }
        : { sourceAddress: source, action: 'forward', destinations: [...new Set((form.elements.namedItem('destinations') as HTMLInputElement).value.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))] }
      void ui.write('POST', '/api/mail/forwarders', body, () => { form.reset(); syncMode() })
    })
    root.addEventListener('click', async event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-forwarder-delete]') : null
      if (!button || button.disabled || !root.contains(button)) return
      if (!await confirmRemove(copy('Delete forwarder'), button.dataset.forwarderSource ?? '')) return
      void ui.write('DELETE', '/api/mail/forwarders/' + encodeURIComponent(button.dataset.forwarderDelete ?? ''), {}, () => undefined)
    })
  })

  document.querySelectorAll<HTMLElement>('[data-autoresponder-workspace]').forEach(root => {
    if (root.dataset.autoresponderBound === 'true') return
    root.dataset.autoresponderBound = 'true'
    const rows = root.querySelector<HTMLTableSectionElement>('[data-autoresponder-rows]')
    const empty = root.querySelector<HTMLElement>('[data-autoresponder-empty]')
    const form = root.querySelector<HTMLFormElement>('[data-autoresponder-form]')
    const manage = root.dataset.autoresponderManage === 'true'
    // a mailbox answers with its own vacation (/api/webmail/vacation); any other address through /api/mail/autoresponders
    let records = new Map<string, Record<string, unknown>>(), mailboxes: string[] = [], editing: Record<string, unknown> | null = null
    const field = (name: string) => form!.elements.namedItem(name) as HTMLInputElement
    const localTime = (value: unknown) => typeof value === 'string' ? value.slice(0, 16) : ''
    const stopEditing = () => {
      editing = null
      if (!form) return
      form.reset(); field('address').readOnly = false
      form.querySelector<HTMLElement>('[data-autoresponder-form-title]')!.textContent = copy('Add an autoresponder')
      form.querySelector<HTMLElement>('[data-autoresponder-submit]')!.textContent = copy('Add autoresponder')
      form.querySelector<HTMLElement>('[data-autoresponder-cancel]')!.hidden = true
    }
    const ui = section(root, 'autoresponder', async () => {
      const value = await request!('GET', '/api/mail/autoresponders') as Record<string, unknown>
      if (!value || !Array.isArray(value.autoresponders) || !Array.isArray(value.mailboxes)) throw new Error('invalid_autoresponder_read')
      const next = new Map<string, Record<string, unknown>>()
      for (const item of value.autoresponders as Record<string, unknown>[]) {
        if ((item.kind !== 'mailbox' && item.kind !== 'address') || typeof item.address !== 'string' || typeof item.subject !== 'string' || typeof item.body !== 'string' || typeof item.revision !== 'string' || typeof item.replyIntervalHours !== 'number') throw new Error('invalid_autoresponder_read')
        readRoutingApplication(item.application)
        next.set(item.address, item)
      }
      records = next; mailboxes = (value.mailboxes as unknown[]).filter((item): item is string => typeof item === 'string')
      if (editing && records.get(String(editing.address))?.revision !== editing.revision) stopEditing()
      if (!rows) return
      rows.textContent = ''
      for (const item of records.values()) {
        const app = readRoutingApplication(item.application)
        const start = typeof item.startDate === 'string' ? displayDateTime(item.startDate) : null
        const end = typeof item.endDate === 'string' ? displayDateTime(item.endDate) : null
        const row = routingRow(root)
        cell(row, [String(item.address)], true)
        cell(row, [String(item.subject)], false)
        cell(row, [start && end ? copy('{start} to {end}', { start, end }) : start ? copy('Since {start}, no end date', { start }) : end ? copy('Until {end}', { end }) : copy('Always, no end date'),
          copy('Once per sender every {hours, plural, one {# hour} other {# hours}}', { hours: item.replyIntervalHours as number })], false)
        cell(row, [stateText(app)], false).dataset.routingState = app.state
        const action = routingAction(root)
        if (manage) for (const [kind, label] of [['edit', copy('Edit autoresponder')], ['delete', copy('Delete autoresponder')]] as const) {
          const button = routingButton(root)
          button.dataset.autoresponderAction = kind; button.dataset.autoresponderAddress = String(item.address); button.textContent = label; action.appendChild(button)
        }
        row.appendChild(action); rows.appendChild(row)
      }
      if (empty) { empty.hidden = records.size > 0; empty.textContent = copy('No autoresponders.') }
    })
    form?.addEventListener('submit', event => {
      event.preventDefault()
      if (!form.reportValidity()) return
      let startDate: string | null, endDate: string | null
      try { startDate = utcInstant(field('start').value); endDate = field('noEnd').checked ? null : utcInstant(field('end').value) }
      catch { field('start').setCustomValidity(copy('Enter a valid time.')); form.reportValidity(); field('start').setCustomValidity(''); return }
      const address = field('address').value.trim().toLowerCase()
      const fields = { enabled: true, subject: field('subject').value, body: field('body').value, htmlBody: editing && typeof editing.htmlBody === 'string' ? editing.htmlBody : '',
        startDate, endDate, replyIntervalHours: Number(field('interval').value) }
      const kind = editing ? editing.kind : mailboxes.includes(address) ? 'mailbox' : 'address'
      const revision = editing ? String(editing.revision) : null
      void (kind === 'mailbox'
        ? ui.write('PUT', '/api/webmail/vacation', { mailbox: address, ...fields, ...(revision ? { expectedRevision: revision } : {}) }, stopEditing)
        : ui.write('PUT', '/api/mail/autoresponders', { address, ...fields, expectedRevision: revision }, stopEditing))
    })
    form?.querySelector('[data-autoresponder-cancel]')?.addEventListener('click', stopEditing)
    root.addEventListener('click', async event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-autoresponder-action]') : null
      if (!button || button.disabled || !root.contains(button)) return
      const item = records.get(button.dataset.autoresponderAddress ?? '')
      if (!item) return
      if (button.dataset.autoresponderAction === 'edit') {
        if (!form) return
        editing = item
        field('address').value = String(item.address); field('address').readOnly = true
        field('subject').value = String(item.subject); (form.elements.namedItem('body') as HTMLTextAreaElement).value = String(item.body)
        field('interval').value = String(item.replyIntervalHours)
        field('start').value = localTime(item.startDate); field('end').value = localTime(item.endDate); field('noEnd').checked = item.endDate === null
        form.querySelector<HTMLElement>('[data-autoresponder-form-title]')!.textContent = copy('Edit the autoresponder of {address}', { address: String(item.address) })
        form.querySelector<HTMLElement>('[data-autoresponder-submit]')!.textContent = copy('Save autoresponder')
        form.querySelector<HTMLElement>('[data-autoresponder-cancel]')!.hidden = false
        field('subject').focus()
        return
      }
      if (!await confirmRemove(copy('Delete autoresponder'), String(item.address))) return
      void (item.kind === 'mailbox'
        ? ui.write('PUT', '/api/webmail/vacation', { mailbox: item.address, enabled: false, expectedRevision: item.revision }, () => undefined)
        : ui.write('DELETE', '/api/mail/autoresponders', { address: item.address, expectedRevision: item.revision }, () => undefined))
    })
  })
  document.querySelectorAll<HTMLElement>('[data-default-workspace]').forEach(root => {
    if (root.dataset.defaultBound === 'true') return
    root.dataset.defaultBound = 'true'
    const form = root.querySelector<HTMLFormElement>('[data-default-form]')
    const current = root.querySelector<HTMLElement>('[data-default-current]')
    let records: Record<string, unknown>[] = []
    const kind = () => form?.querySelector<HTMLInputElement>('input[name="default-kind"]:checked')?.value ?? 'reject'
    const show = () => {
      if (!form) return
      const domain = (form.elements.namedItem('domain') as HTMLSelectElement).value
      const record = records.find(item => item.domain === domain)
      const destinationField = form.querySelector<HTMLElement>('[data-default-destination-field]')
      if (destinationField) destinationField.hidden = kind() !== 'forward'
      ;(form.elements.namedItem('destination') as HTMLInputElement).required = kind() === 'forward'
      if (!current) return
      // Postfix answers unknown addresses of a reject-default domain with this reply (recipient access map)
      const reply = '550 No such user here'
      if (!record) { current.textContent = copy('Current: reject with {reply}', { reply }); return }
      const host = stateText(readRoutingApplication(record.application))
      current.textContent = record.kind === 'forward' ? copy('Current: forward to {destination} ({state})', { destination: String(record.destination), state: host })
        : record.kind === 'discard' ? copy('Current: discard silently ({state})', { state: host }) : copy('Current: reject with {reply} ({state})', { reply, state: host })
    }
    const ui = section(root, 'default', async () => {
      const value = await request!('GET', '/api/mail/default-addresses') as Record<string, unknown>
      if (!value || !Array.isArray(value.defaultAddresses)) throw new Error('invalid_default_address_read')
      records = value.defaultAddresses as Record<string, unknown>[]
      const domain = form ? (form.elements.namedItem('domain') as HTMLSelectElement).value : ''
      const record = records.find(item => item.domain === domain)
      const radio = form?.querySelector<HTMLInputElement>(`input[name="default-kind"][value="${String(record?.kind ?? 'reject')}"]`)
      if (radio) radio.checked = true
      if (form && record?.kind === 'forward') (form.elements.namedItem('destination') as HTMLInputElement).value = String(record.destination ?? '')
      show()
    })
    form?.addEventListener('change', event => {
      if (event.target instanceof HTMLSelectElement) {
        const record = records.find(item => item.domain === (event.target as HTMLSelectElement).value)
        const radio = form.querySelector<HTMLInputElement>(`input[name="default-kind"][value="${String(record?.kind ?? 'reject')}"]`)
        if (radio) radio.checked = true
      }
      show()
    })
    form?.addEventListener('submit', event => {
      event.preventDefault()
      if (!form.reportValidity()) return
      const destination = (form.elements.namedItem('destination') as HTMLInputElement).value.trim().toLowerCase()
      void ui.write('PUT', '/api/mail/default-addresses', { domain: (form.elements.namedItem('domain') as HTMLSelectElement).value, kind: kind(), ...(kind() === 'forward' ? { destination } : {}) }, () => undefined)
    })
  })
}

export const ACCOUNT_FORWARDERS_CLIENT_BINDING = `(function(askDialog) { const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()}; const displayDateTime=${DISPLAY_DATETIME_BINDING}; ${readRoutingApplication.toString()}; ${readForwarderRecords.toString()}; ${forwarderWriteUncertain.toString()}; ${utcInstant.toString()}; (${bindAccountForwarders.toString()})(askDialog); })`
