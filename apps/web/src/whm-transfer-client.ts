/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { ASCII_BYTES_BINDING, formatAsciiBytes as canonicalFormatAsciiBytes } from './display-format.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
const displayDateTime = formatDisplayDateTime
const formatAsciiBytes = canonicalFormatAsciiBytes

/** Self-contained browser binding over the persisted transfer workspace contract. */
function bindWhmTransfer(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const display = (value: unknown): string => String(value ?? '').replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const states = ['created', 'connected', 'inventoried', 'selected', 'reviewed', 'applying', 'completed', 'failed', 'cancelled']
  type Entry = { session: Record<string, unknown>; revision: string; review: Record<string, unknown> | null; digest: string | null; results: Record<string, unknown>; running: boolean; stopRequested: boolean }
  const parseEntry = (value: unknown): Entry => {
    if (!object(value) || !object(value.session) || typeof value.session.id !== 'string' || !uuid.test(value.session.id) || !states.includes(String(value.session.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.session.auth) || !object(value.session.selection)) throw new Error('invalid_transfer_state')
    return { session: value.session, revision: value.revision, review: object(value.review) ? value.review : null, digest: typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) ? value.digest : null,
      results: object(value.results) ? value.results : {}, running: value.running === true, stopRequested: value.stopRequested === true }
  }
  const stateLabel = (state: string): string => {
    const copy: Record<string, string> = { created: msgid('Source review saved'), connected: msgid('Source connection observed'), inventoried: msgid('Inventory read'), selected: msgid('Selection saved'), reviewed: msgid('Review ready'), applying: msgid('Transfer running'), completed: msgid('Transfer finished'), failed: msgid('Failed'), cancelled: msgctxt('whm-transfer-client', 'Cancelled') }
    return ((copy[state]) ? t(copy[state]!) : null) ?? t(msgctxt('whm-transfer-client', 'Not read'))
  }
  document.querySelectorAll<HTMLElement>('[data-transfer-workspace]').forEach(root => {
    if (root.dataset.transferBound === 'true') return
    root.dataset.transferBound = 'true'
    const pageRoot = root.closest<HTMLElement>('[data-whm-detail-route]') ?? root
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const field = (id: string): HTMLInputElement => root.querySelector<HTMLInputElement>('[data-transfer-field="' + id + '"]')!
    const button = (name: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-transfer-' + name + ']')!
    const sessionSelect = root.querySelector<HTMLSelectElement>('[data-transfer-session]')!
    const credential = root.querySelector<HTMLSelectElement>('[data-transfer-credential]')!
    const nodeSelect = root.querySelector<HTMLSelectElement>('[data-transfer-node]')!, liveBox = root.querySelector<HTMLInputElement>('[data-transfer-live]')!, revertAccount = root.querySelector<HTMLSelectElement>('[data-transfer-revert-account]')!, lossBox = root.querySelector<HTMLElement>('[data-transfer-revert-loss]')!
    const conflict = root.querySelector<HTMLSelectElement>('[data-transfer-conflict]')!
    const resolution = root.querySelector<HTMLSelectElement>('[data-transfer-resolution]')!
    const status = root.querySelector<HTMLElement>('[data-transfer-status]')!
    const accounts = root.querySelector<HTMLElement>('[data-transfer-accounts]')!
    const plans = root.querySelector<HTMLElement>('[data-transfer-plans]')!
    const reviewBox = root.querySelector<HTMLElement>('[data-transfer-review-results]')!
    const archiveBox = root.querySelector<HTMLElement>('[data-transfer-archive-review]')!
    const importSelect = root.querySelector<HTMLSelectElement>('[data-transfer-import]')!
    const importPlan = root.querySelector<HTMLSelectElement>('[data-transfer-import-plan]')!
    const keyBox = root.querySelector<HTMLElement>('[data-transfer-ssh-key-value]')!
    if (!sessionSelect || !credential || !nodeSelect || !liveBox || !revertAccount || !lossBox || !conflict || !resolution || !status || !accounts || !plans || !reviewBox || !archiveBox || !importSelect || !importPlan || !keyBox) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true })
      if (status) { status.dataset.state = 'unavailable'; status.textContent = t('Unavailable') }
      return
    }
    let entries: Entry[] = [], selected: Entry | null = null, loaded = false, busy = false, dirty = false, reviewRequired = false
    let capabilities = { discover: false, execute: false, live: false, cpanelImport: false, cpanelUploadMaxBytes: 0 }
    let imports: Record<string, unknown>[] = [], poller: ReturnType<typeof setTimeout> | null = null
    // Whole-server migration: every source account and plan is selected and the choice is not editable.
    const wholeServer = root.dataset.transferScope === 'server'
    const inventoryLayout = root.dataset.transferInventoryLayout, comparison = inventoryLayout === 'comparison'
    const selectAll = root.querySelector<HTMLInputElement>('[data-transfer-select-all]')
    let templateIntact = true
    let inventoryRows: Array<{ row: HTMLElement; select: HTMLInputElement; resolve: HTMLButtonElement; conflicts: string[] }> = []
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => templateIntact && root.isConnected && root.dataset.transferManage === 'true' && !root.closest(denied) && typeof send === 'function'
    const selectionChanged = (): boolean => {
      const selection = object(selected?.session.selection) ? selected.session.selection : {}
      const names = (container: HTMLElement): string[] => [...container.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value).sort()
      return JSON.stringify(names(accounts)) !== JSON.stringify(Array.isArray(selection.accounts) ? [...selection.accounts].sort() : []) || JSON.stringify(names(plans)) !== JSON.stringify(Array.isArray(selection.plans) ? [...selection.plans].sort() : [])
    }
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status') }
    type RecordSpec = { tag: string; slots: Record<string, keyof HTMLElementTagNameMap>; actions?: Record<string, 'input' | 'button'>; columns?: number }
    const recordRows: Record<string, readonly string[]> = {
      'transfer-inventory': comparison ? ['username', 'domain', 'uid', 'plan', 'disk', 'databases', 'mailboxes', 'conflict', 'resolution'] : ['selected', 'username', 'domain', 'plan', 'disk', 'databases', 'mailboxes', 'conflict', 'resolution'],
      'transfer-progress': ['account', 'home', 'databases', 'mail', 'dns', 'state'],
      'transfer-plans': ['source', 'target', 'owner', 'conflict'],
      'transfer-import-part': ['item', 'source', 'target', 'state'],
      'transfer-import-warnings': ['state', 'detail', 'path'],
      'transfer-review': ['source', 'target', 'plan', 'domains', 'mailboxes'],
      'transfer-archive-summary': ['part', 'count'],
      'transfer-archive-conflicts': ['kind', 'value'],
      'transfer-archive-unmapped': ['state', 'detail', 'path'],
      'transfer-revert-loss': ['item', 'observed'],
    }
    const records: Record<string, RecordSpec> = { 'transfer-choice': { tag: 'label', slots: { name: 'bdi' }, actions: { select: 'input' } } }
    for (const [name, fields] of Object.entries(recordRows)) {
      const columns = name === 'transfer-inventory' && comparison ? 8 : fields.length
      const slots: Record<string, keyof HTMLElementTagNameMap> = Object.fromEntries(fields.map(field => [field, 'bdi' as const]))
      if (name === 'transfer-inventory' && comparison) { slots.conflict = 'span'; slots.resolution = 'span' }
      records[name + '-row'] = { tag: 'tr', slots, columns, ...(name === 'transfer-inventory' && comparison ? { actions: { select: 'input', resolve: 'button' } as const } : {}) }
      records[name + '-empty'] = { tag: 'tr', slots: { message: 'td' }, columns }
    }
    for (const name of ['transfer-review', 'transfer-archive-summary', 'transfer-archive-conflicts', 'transfer-archive-unmapped', 'transfer-revert-loss']) records[name + '-table'] = { tag: 'div', slots: { rows: 'tbody' } }
    const disableNative = (): void => { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }) }
    const verifyTemplates = (): boolean => {
      if (!admitted()) { disableNative(); if (!['uncertain', 'stale'].includes(status.dataset.state ?? '')) announce('unavailable', t('Unavailable')); return false }
      try {
        if (inventoryLayout !== undefined && inventoryLayout !== 'comparison' || root.dataset.transferInventoryLayout !== inventoryLayout) throw new Error('invalid_transfer_layout')
        if (pageRoot.hasAttribute('data-whm-detail-route') && !['/whm/transfers', '/whm/transfers/server'].includes(pageRoot.dataset.whmDetailRoute ?? '')) throw new Error('invalid_transfer_owner')
        const unique = (selector: string, expected: HTMLElement, tag?: string): void => {
          const found = [...root.querySelectorAll<HTMLElement>(selector)].filter(node => node.closest('[data-transfer-workspace]') === root)
          if (found.length !== 1 || found[0] !== expected || tag && expected.tagName !== tag) throw new Error('invalid_transfer_control')
        }
        for (const [name, expected] of [['session', sessionSelect], ['credential', credential], ['conflict', conflict], ['resolution', resolution], ['import', importSelect], ['import-plan', importPlan]] as const) unique('[data-transfer-' + name + ']', expected, 'SELECT')
        for (const [name, expected] of [['status', status], ['accounts', accounts], ['plans', plans], ['review-results', reviewBox], ['archive-review', archiveBox], ['ssh-key-value', keyBox]] as const) unique('[data-transfer-' + name + ']', expected)
        for (const name of ['refresh', 'discover', 'cancel', 'create', 'select', 'resolve', 'review', 'run', 'stop', 'inspect', 'ssh-key', 'fetch', 'import-discard', 'import-run']) { const control = button(name); unique('[data-transfer-' + name + ']', control, 'BUTTON'); if (control.type !== 'button') throw new Error('invalid_transfer_control') }
        for (const name of ['transfer-host', 'transfer-port', 'transfer-user', 'transfer-fingerprint', 'transfer-resolution-target', 'transfer-archive', 'transfer-archive-target', 'transfer-cpanel-host', 'transfer-cpanel-port', 'transfer-cpanel-user', 'transfer-cpanel-fingerprint']) {
          const control = field(name); unique('[data-transfer-field="' + name + '"]', control, 'INPUT')
          if (control.type !== (name === 'transfer-archive' ? 'file' : name === 'transfer-port' || name === 'transfer-cpanel-port' ? 'number' : 'text')) throw new Error('invalid_transfer_field')
        }
        if (comparison) {
          unique('[data-transfer-inventory-rows]', accounts, 'TBODY')
          if (!selectAll) throw new Error('missing_transfer_selection')
          unique('[data-transfer-select-all]', selectAll, 'INPUT')
          const table = accounts.closest('table')
          if (selectAll.type !== 'checkbox' || !table || selectAll.closest('thead') !== table.tHead || table.tHead?.rows.length !== 1 || table.tHead.rows[0]?.cells.length !== 8) throw new Error('invalid_transfer_selection')
          for (const row of [...accounts.children]) {
            const cells = [...row.children]
            if (row.tagName !== 'TR' || cells.some(cell => cell.tagName !== 'TD') || !(cells.length === 8 || cells.length === 1 && (cells[0] as HTMLTableCellElement).colSpan === 8)) throw new Error('invalid_transfer_columns')
          }
        } else if (accounts.tagName !== 'DIV' || selectAll) throw new Error('invalid_transfer_selection')
        for (const [name, spec] of Object.entries(records)) {
          const template = clientTemplate(root, name)
          if (template.closest('[data-transfer-workspace]') !== root) throw new Error('foreign_transfer_template')
          const node = cloneViewRecord(root, name, spec.tag, Object.fromEntries(Object.keys(spec.slots).map(key => [key, ''])))
          for (const [slot, tag] of Object.entries(spec.slots)) clientTemplateSlot(node, slot, tag)
          if (node.querySelector('script,style,template,iframe,object,embed,form,textarea,select,a,img,audio,video,source,link,meta,base,[data-transfer-workspace]')) throw new Error('unsafe_transfer_template')
          for (const part of [node, ...node.querySelectorAll<HTMLElement>('*')]) if ([...part.attributes].some(attr => /^on/i.test(attr.name) || attr.name.startsWith('data-transfer-') || ['id', 'style', 'name', 'form', 'api-url', 'data-api-url', 'data-action', 'href', 'src', 'srcset', 'formaction', 'contenteditable', 'data-whm-detail-route'].includes(attr.name))) throw new Error('unsafe_transfer_template')
          const actions = spec.actions ?? {}, present = node.querySelectorAll('[data-xp-action]')
          if (present.length !== Object.keys(actions).length || node.querySelectorAll('input,button').length !== Object.keys(actions).length) throw new Error('invalid_transfer_actions')
          for (const [action, tag] of Object.entries(actions)) {
            const control = viewAction<HTMLInputElement | HTMLButtonElement>(node, action, tag)
            if (!control.disabled || control.type !== (tag === 'input' ? 'checkbox' : 'button')) throw new Error('invalid_transfer_action')
          }
          if (spec.tag === 'tr') {
            const empty = name.endsWith('-empty')
            if (node.children.length !== (empty ? 1 : spec.columns) || [...node.children].some(cell => cell.tagName !== 'TD') || empty && (node.firstElementChild as HTMLTableCellElement).colSpan !== spec.columns) throw new Error('invalid_transfer_columns')
          }
          if (spec.tag === 'div') {
            const table = node.querySelector('table'), fields = recordRows[name.replace(/-table$/, '')]!
            if (node.querySelectorAll('table').length !== 1 || table?.tHead?.rows.length !== 1 || table.tHead.rows[0]?.cells.length !== fields.length) throw new Error('invalid_transfer_columns')
          }
        }
        return true
      } catch { templateIntact = false; disableNative(); if (!['uncertain', 'stale'].includes(status.dataset.state ?? '')) announce('unavailable', t('Unavailable')); return false }
    }
    const controls = (): void => {
      if (!verifyTemplates()) return
      const locked = busy || reviewRequired || !loaded || !admitted(), state = String(selected?.session.state ?? '')
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = locked })
      button('refresh').disabled = busy || !admitted()
      sessionSelect.disabled = busy || !loaded || !admitted()
      credential.disabled = locked || !credential.options.length
      nodeSelect.disabled = locked || !capabilities.live
      liveBox.disabled = locked || !nodeSelect.value
      button('create').disabled = locked || !credential.options.length && !nodeSelect.value
      revertAccount.disabled = locked || !revertAccount.options.length
      button('revert').disabled = locked || !revertAccount.value
      button('discover').disabled = locked || !capabilities.discover || state !== 'created'
      button('select').disabled = locked || !['inventoried', 'selected', 'reviewed'].includes(state)
      button('resolve').disabled = locked || selectionChanged() || !['selected', 'reviewed'].includes(state) || !conflict.options.length
      button('review').disabled = locked || selectionChanged() || state !== 'selected'
      button('run').disabled = locked || selectionChanged() || !capabilities.execute || state !== 'reviewed' || !selected?.digest
      button('stop').disabled = busy || !loaded || !admitted() || state !== 'applying' || selected?.stopRequested === true
      button('cancel').disabled = locked || !['created', 'connected', 'inventoried', 'selected', 'reviewed'].includes(state)
      const chosen = imports.find(item => item.id === importSelect.value)
      button('inspect').disabled = locked || !capabilities.cpanelImport
      button('fetch').disabled = locked || !capabilities.cpanelImport
      button('ssh-key').disabled = locked || !capabilities.cpanelImport
      importSelect.disabled = busy || !imports.length || !admitted()
      importPlan.disabled = locked || chosen?.state !== 'review'
      button('import-run').disabled = locked || chosen?.state !== 'review' || !importPlan.value || (Array.isArray(chosen?.conflicts) && chosen.conflicts.length > 0)
      button('import-discard').disabled = locked || !chosen || ['uploading', 'fetching', 'inspecting', 'importing'].includes(String(chosen.state))
      field('transfer-resolution-target').disabled = locked || !['rename', 'map-plan'].includes(resolution.value)
      if (wholeServer) [accounts, plans].forEach(container => container.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = true }))
      if (comparison) {
        for (const item of inventoryRows) { item.select.disabled = locked || wholeServer; item.resolve.disabled = locked || selectionChanged() || !['selected', 'reviewed'].includes(state) || !item.conflicts.length }
        if (selectAll) { selectAll.disabled = locked || wholeServer || !inventoryRows.length; const chosen = inventoryRows.filter(item => item.select.checked).length; selectAll.checked = inventoryRows.length > 0 && chosen === inventoryRows.length; selectAll.indeterminate = chosen > 0 && chosen < inventoryRows.length }
      }
      root.setAttribute('aria-busy', String(busy))
    }
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!verifyTemplates()) throw { stateChanged: false }
      try {
        const value = body === undefined ? await send!(method, path) : await send!(method, path, body)
        if (!verifyTemplates()) throw { stateChanged: true, unknownOutcome: true }
        return value
      } catch (error) { verifyTemplates(); throw error }
    }
    const ask = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!verifyTemplates()) return false
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      let confirmed = false
      try { confirmed = await askDialog({ title, body, danger, confirm: t('Confirm') }) === true }
      finally { if (!verifyTemplates()) confirmed = false }
      return confirmed
    }
    const sourceLabel = (session: Record<string, unknown>): string => {
      const auth = object(session.auth) ? session.auth : {}
      return typeof auth.host === 'string' ? auth.host : typeof auth.url === 'string' ? auth.url : t('Source unavailable')
    }
    const makeChoices = (container: HTMLElement, values: unknown, selection: unknown, key: string): void => {
      container.textContent = ''
      if (!Array.isArray(values)) return
      const checked = new Set(Array.isArray(selection) ? selection.filter(value => typeof value === 'string') : [])
      for (const value of values) {
        if (!object(value) || typeof value[key] !== 'string') continue
        const label = cloneViewRecord(root, 'transfer-choice', 'label', { name: value[key] as string })
        const input = viewAction<HTMLInputElement>(label, 'select', 'input')
        input.value = value[key] as string; input.checked = wholeServer || checked.has(input.value)
        container.append(label)
      }
    }
    const resolutionLabels: Record<string, string> = { skip: msgid('Skip'), rename: msgid('Rename'), 'new-uid': msgid('Allocate a new UID'), 'drop-domain': msgid('Omit conflicting domain'), 'map-plan': msgid('Map to a local plan') }
    const paintResolution = (): void => {
      const conflicts = Array.isArray(selected?.session.conflicts) ? selected.session.conflicts : []
      const current = conflicts.find(value => object(value) && value.id === conflict.value)
      resolution.textContent = ''
      if (object(current) && Array.isArray(current.choices)) for (const choice of current.choices) {
        if (typeof choice !== 'string' || !resolutionLabels[choice]) continue
        const option = document.createElement('option'); option.value = choice; option.textContent = xpT(resolutionLabels[choice]); resolution.append(option)
      }
      controls()
    }
    type TransferRow = Record<string, unknown>
    const fillBody = (body: Element | null, name: string, values: TransferRow[], empty: string): void => {
      if (!body) return
      if (name === 'transfer-inventory') inventoryRows = []
      body.replaceChildren()
      if (!values.length) { body.append(cloneViewRecord(root, name + '-empty', 'tr', { message: empty })); return }
      for (const value of values) {
        const projection = Object.fromEntries(recordRows[name]!.map(key => [key, display(value[key])]))
        const row = cloneViewRecord(root, name + '-row', 'tr', projection)
        if (name === 'transfer-inventory' && comparison) {
          const choice = viewAction<HTMLInputElement>(row, 'select', 'input'), resolve = viewAction<HTMLButtonElement>(row, 'resolve')
          const sessionId = selected?.session.id, revision = selected?.revision
          choice.value = typeof value.username === 'string' ? value.username : ''; choice.checked = wholeServer || value.checked === true; choice.setAttribute('aria-label', display(value.username))
          const ids = Array.isArray(value.conflicts) ? value.conflicts.filter((id): id is string => typeof id === 'string') : []
          resolve.addEventListener('click', () => {
            if (resolve.disabled || busy || reviewRequired || !row.isConnected || !root.contains(row) || !verifyTemplates() || selected?.session.id !== sessionId || selected?.revision !== revision || selectionChanged()) return
            const id = ids.find(id => [...conflict.options].some(option => option.value === id))
            if (!id) return
            conflict.value = id; paintResolution(); if (!resolution.disabled) resolution.focus()
          })
          inventoryRows.push({ row, select: choice, resolve, conflicts: ids })
        }
        body.append(row)
      }
    }
    const table = (container: HTMLElement, name: string, rows: TransferRow[], append = false): void => {
      if (!append) container.replaceChildren()
      const wrapper = cloneViewRecord(root, name + '-table', 'div', { rows: '' })
      fillBody(clientTemplateSlot(wrapper, 'rows', 'tbody'), name, rows, t('No reviewed records were returned.'))
      container.append(wrapper)
    }
    /** What a revert drops, as the server observed it; a category it could not read stays 'unknown', never zero. */
    type Loss = { digest: string; mail: { mailbox: string; messages: number }[] | 'unknown'; files: number | 'unknown'; databases: { onCopy: number }; zones: { changed: number; total: number } | 'unknown'; edgeNotCarriedBack: string[] | 'unknown' }
    const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
    const parseLoss = (value: unknown): Loss | null => {
      if (!object(value) || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) || !object(value.databases) || !whole(value.databases.onCopy)) return null
      const mail = value.mail === 'unknown' ? 'unknown' : Array.isArray(value.mail) && value.mail.every(item => object(item) && typeof item.mailbox === 'string' && whole(item.messages)) ? value.mail as { mailbox: string; messages: number }[] : null
      const files = value.files === 'unknown' || whole(value.files) ? value.files : null
      const zones = value.zones === 'unknown' ? 'unknown' : object(value.zones) && whole(value.zones.changed) && whole(value.zones.total) ? { changed: value.zones.changed, total: value.zones.total } : null
      const edge = value.edgeNotCarriedBack === 'unknown' ? 'unknown' : Array.isArray(value.edgeNotCarriedBack) && value.edgeNotCarriedBack.every(item => typeof item === 'string') ? value.edgeNotCarriedBack as string[] : null
      return mail === null || files === null || zones === null || edge === null ? null : { digest: value.digest, mail, files, databases: { onCopy: value.databases.onCopy }, zones, edgeNotCarriedBack: edge }
    }
    const lossRows = (loss: Loss): TransferRow[] => {
      const unknown = t('Unknown'), messages = (value: number): string => t('{count, plural, one {# message} other {# messages}}', { count: value })
      const edgeNames: Record<string, string> = { ipBlocker: msgid('IP blocker'), cache: msgid('Cache'), proxyRules: msgid('Proxy rules'), leech: msgid('Leech protection') }
      return [
        { item: t('Mail written since the cutover'), observed: loss.mail === 'unknown' ? unknown : messages(loss.mail.reduce((sum, box) => sum + box.messages, 0)) },
        ...(loss.mail === 'unknown' ? [] : loss.mail.map(box => ({ item: box.mailbox, observed: messages(box.messages) }))),
        { item: t('Files changed since the cutover'), observed: loss.files === 'unknown' ? unknown : t('{count, plural, one {# file} other {# files}}', { count: loss.files }) },
        { item: t('Database changes since the cutover'), observed: t('Unknown; {count, plural, one {# database is} other {# databases are}} removed with the copy', { count: loss.databases.onCopy }) },
        { item: t('DNS zones changed since the cutover'), observed: loss.zones === 'unknown' ? unknown : t('{changed} of {total} zones', loss.zones) },
        { item: t('Edge settings saved since the cutover'), observed: loss.edgeNotCarriedBack === 'unknown' ? unknown : loss.edgeNotCarriedBack.length ? loss.edgeNotCarriedBack.map(name => edgeNames[name] ? t(edgeNames[name]!) : name).join(', ') : t('None') },
      ]
    }
    const paintLoss = (loss: Loss | null): void => { if (loss) table(lossBox, 'transfer-revert-loss', lossRows(loss)); else lossBox.replaceChildren() }
    const paintArchive = (value: unknown): void => {
      archiveBox.textContent = ''
      const approved = pageRoot.querySelector<HTMLElement>('[data-whm-detail-section="transfer-import"]')
      const approvedNotice = approved?.querySelector<HTMLElement>('[data-transfer-import-observation]')
      const partBody = (key: string) => approved?.querySelector(`[data-transfer-import-${key}]`) ?? approved?.querySelector(`[data-transfer-import-part="${key}"] tbody`) ?? null
      const warningsBody = partBody('warnings')
      const absent = t('No parsed archive review was returned.')
      for (const key of ['domains', 'home', 'databases', 'mail', 'dns']) fillBody(partBody(key), 'transfer-import-part', [], absent)
      fillBody(warningsBody, 'transfer-import-warnings', [], absent)
      if (approvedNotice) approvedNotice.textContent = t('No parsed archive review was returned.')
      if (!object(value) || !object(value.plan) || !object(value.plan.account)) return
      if (approvedNotice) approvedNotice.textContent = t('The server parsed this archive. Review what is not imported, choose a plan and import the account.')
      const plan = value.plan, account = plan.account as Record<string, unknown>
      const title = document.createElement('p'); title.textContent = display(account.username) + ' · ' + display(account.primaryDomain); archiveBox.append(title)
      const notRead = t(msgctxt('whm-transfer-client', 'Not read')), reviewOnly = t('Imported')
      const returned = (items: unknown): Record<string, unknown>[] => Array.isArray(items) ? items.filter(object) : []
      const empty = t('No records were returned for this part of the parsed review.')
      fillBody(partBody('domains'), 'transfer-import-part', returned(plan.domains).map(domain => ({ item: domain.name, source: domain.name, target: domain.docRoot, state: reviewOnly })), empty)
      const home = object(plan.home) ? plan.home : {}
      const metrics: Array<readonly [string, string]> = [['files', t('Files')], ['directories', t('Directories')], ['symlinks', t('Symbolic links')], ['bytes', t('Bytes')], ['skipped', t('Skipped entries')]]
      fillBody(partBody('home'), 'transfer-import-part', metrics.filter(([key]) => typeof home[key] === 'number').map(([key, label]) => ({ item: label, source: home[key], target: t('Restored into the new home'), state: reviewOnly })), empty)
      fillBody(partBody('databases'), 'transfer-import-part', [...returned(plan.databases).map(database => ({ item: t(msgctxt('whm-transfer-client', 'Database')), source: database.sourceName, target: database.name, state: reviewOnly })), ...returned(plan.dbUsers).map(user => ({ item: t(msgctxt('whm-transfer-client', 'Database user')), source: user.sourceName, target: user.name, state: t('Password reset required') }))], empty)
      fillBody(partBody('mail'), 'transfer-import-part', returned(plan.mailboxes).map(mailbox => ({ item: mailbox.address, source: mailbox.hasMaildir === true ? mailbox.maildir : t('No archived mail directory'), target: mailbox.maildir, state: t('Password reset required') })), empty)
      fillBody(partBody('dns'), 'transfer-import-part', returned(plan.dnsZones).flatMap(zone => returned(zone.records).map(record => ({ item: display(record.name) + ' · ' + display(record.type), source: record.content ?? notRead, target: zone.zone, state: reviewOnly }))), empty)
      const tags: Record<string, string> = { skipped: msgid('Skipped'), partial: msgid('Partial'), paused: msgid('Paused'), reset: msgid('Reset required') }
      fillBody(warningsBody, 'transfer-import-warnings', returned(value.unmapped).map(item => ({ state: xpT(tags[String(item.tag)] ?? msgid('Skipped')), detail: item.message, path: item.path ?? notRead })), empty)
      const rows = [
        { part: t('Domains'), count: Array.isArray(plan.domains) ? plan.domains.length : notRead },
        { part: t('Databases'), count: Array.isArray(plan.databases) ? plan.databases.length : notRead },
        { part: t('Mailboxes'), count: Array.isArray(plan.mailboxes) ? plan.mailboxes.length : notRead },
        { part: t('Conflicts'), count: Array.isArray(value.conflicts) ? value.conflicts.length : notRead },
      ]
      table(archiveBox, 'transfer-archive-summary', rows, true)
      if (Array.isArray(value.conflicts) && value.conflicts.length) table(archiveBox, 'transfer-archive-conflicts', value.conflicts.filter(object).map(item => ({ kind: item.kind === 'username' ? t('Account name') : t('Domain'), value: item.value })), true)
      const unmapped = returned(value.unmapped)
      if (unmapped.length) table(archiveBox, 'transfer-archive-unmapped', unmapped.map(item => ({ state: xpT(tags[String(item.tag)] ?? msgid('Skipped')), detail: item.message, path: item.path ?? '' })), true)
      const outcome = document.createElement('p')
      outcome.textContent = value.state === 'imported' ? t('Imported as {username}. Owners must set new passwords.', { username: display(object(value.result) ? value.result.username : '') }) : value.state === 'failed' ? t('Import failed: {reason}', { reason: display(value.error) }) : value.state === 'importing' ? t('Importing. The page refreshes while it runs.') : ''
      if (outcome.textContent) archiveBox.append(outcome)
    }
    const importLabel = (item: Record<string, unknown>): string => {
      const states: Record<string, string> = { uploading: msgid('Uploading'), fetching: msgid('Fetching over SSH'), inspecting: msgid('Inspecting'), review: msgid('Ready to import'), importing: msgid('Importing'), imported: msgid('Imported'), failed: msgid('Failed') }
      return display(item.filename) + ' · ' + xpT(states[String(item.state)] ?? msgid('Failed'))
    }
    const paintImports = (): void => {
      const previous = importSelect.value
      importSelect.textContent = ''
      for (const item of imports) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = importLabel(item); importSelect.append(option) }
      if (imports.some(item => item.id === previous)) importSelect.value = previous
      paintArchive(imports.find(item => item.id === importSelect.value) ?? imports.at(-1))
    }
    /** While a transfer or import runs on the server, read its state again every few seconds. */
    const schedulePoll = (): void => {
      if (poller) clearTimeout(poller)
      poller = null
      const active = entries.some(entry => entry.running || entry.session.state === 'applying') || imports.some(item => ['uploading', 'fetching', 'inspecting', 'importing'].includes(String(item.state)))
      if (active && root.isConnected) poller = setTimeout(() => { if (!busy && !dirty && !reviewRequired) void read(String(selected?.session.id ?? '')).catch(() => undefined); else schedulePoll() }, 5000)
    }
    const paint = (target: string): void => {
      selected = entries.find(entry => entry.session.id === target) ?? entries[0] ?? null
      sessionSelect.textContent = ''
      for (const entry of entries) { const option = document.createElement('option'); option.value = String(entry.session.id); const created = typeof entry.session.createdAt === 'string' && Number.isFinite(Date.parse(entry.session.createdAt)) ? displayDateTime(entry.session.createdAt) : t('Date not read'); option.textContent = t('Unnumbered session · {source} · {created} · {state}', { source: sourceLabel(entry.session), created, state: stateLabel(String(entry.session.state)) }); sessionSelect.append(option) }
      sessionSelect.value = String(selected?.session.id ?? '')
      const sourceFact = root.querySelector<HTMLElement>('[data-transfer-source]')!
      sourceFact.textContent = ''
      if (selected) { const sourceValue = document.createElement('bdi'); sourceValue.dir = 'ltr'; sourceValue.textContent = sourceLabel(selected.session); sourceFact.append(sourceValue) }
      else sourceFact.textContent = t('No saved sessions')
      root.querySelector<HTMLElement>('[data-transfer-state]')!.textContent = selected ? stateLabel(String(selected.session.state)) : t('No saved sessions')
      const inventory = object(selected?.session.inventory) ? selected.session.inventory : {}
      const selection = object(selected?.session.selection) ? selected.session.selection : {}
      if (!comparison) makeChoices(accounts, inventory.accounts, selection.accounts, 'username')
      makeChoices(plans, inventory.plans, selection.plans, 'name')
      root.querySelector<HTMLElement>('[data-transfer-inventory-note]')!.textContent = object(selected?.session.inventory) ? t('Authenticated source inventory was returned by the server.') : t('No authenticated source inventory has been read.')
      conflict.textContent = ''
      const conflicts = Array.isArray(selected?.session.conflicts) ? selected.session.conflicts : []
      const conflictLabels: Record<string, string> = { username: t('Account name'), domain: t('Domain'), uid: 'UID', plan: t('Plan') }
      for (const item of conflicts) if (object(item) && typeof item.id === 'string' && typeof item.subject === 'string') { const option = document.createElement('option'); option.value = item.id; option.textContent = item.subject + ' · ' + (conflictLabels[String(item.kind)] ?? t(msgctxt('whm-transfer-client', 'Conflict'))); conflict.append(option) }
      paintResolution()
      const reviewed = Array.isArray(selected?.review?.accounts) ? selected.review.accounts : []
      table(reviewBox, 'transfer-review', reviewed.filter(object).map(item => ({ source: item.source, target: item.target, plan: item.plan, domains: Array.isArray(item.domains) ? item.domains.join(', ') : '', mailboxes: item.mailboxes })))
      const fillApproved = (key: 'transfer-identities' | 'transfer-progress' | 'transfer-plans', values: TransferRow[]): void => {
        const hook = { 'transfer-identities': 'data-transfer-inventory-rows', 'transfer-progress': 'data-transfer-progress-rows', 'transfer-plans': 'data-transfer-plan-rows' }[key]
        fillBody(pageRoot.querySelector('[' + hook + ']'), key === 'transfer-identities' ? 'transfer-inventory' : key, values, t('No observed records are available for this saved session.'))
      }
      fillApproved('transfer-identities', []); fillApproved('transfer-progress', []); fillApproved('transfer-plans', [])
      const planNotice = pageRoot.querySelector<HTMLElement>('[data-transfer-plan-observation]')
      if (planNotice) planNotice.textContent = t('No authenticated source plans were returned for this saved session.')
      const sourceNotice = pageRoot.querySelector<HTMLElement>('[data-transfer-source-observation]')
      if (sourceNotice) sourceNotice.textContent = t('Source identity, inventory and execution facts come only from trusted server adapters. The controls show their current availability.')
      const inventoryNotice = pageRoot.querySelector<HTMLElement>('[data-transfer-identities-observation]')
      if (inventoryNotice) inventoryNotice.textContent = t('No authenticated source inventory was returned for this saved session.')
      const progressNotice = pageRoot.querySelector<HTMLElement>('[data-transfer-progress-state]')
      if (progressNotice) { progressNotice.dataset.transferProgressState = 'not-read'; progressNotice.textContent = t('No native per-account progress was returned for this saved session.') }
      if (object(selected?.session.inventory)) {
        const selectedNames = new Set(Array.isArray(selection.accounts) ? selection.accounts : [])
        const sourceAccounts = Array.isArray(inventory.accounts) ? inventory.accounts.filter(object) : []
        fillApproved('transfer-identities', sourceAccounts.map(account => {
          const notRead = t(msgctxt('whm-transfer-client', 'Not read'))
          const matching = conflicts.filter(value => object(value) && (value.subject === account.username || comparison && typeof account.primaryDomain === 'string' && value.subject === account.primaryDomain)).filter(object)
          const number = (value: unknown): string => Number.isSafeInteger(value) && (value as number) >= 0 ? display(value) : notRead
          return { selected: selectedNames.has(account.username) ? t('Yes') : t('No'), checked: selectedNames.has(account.username), username: account.username, domain: account.primaryDomain,
            uid: comparison ? number(account.uid) : account.uid, plan: comparison && (typeof account.plan !== 'string' || !account.plan) ? notRead : account.plan,
            disk: comparison ? Number.isSafeInteger(account.diskBytes) && (account.diskBytes as number) >= 0 ? formatAsciiBytes(account.diskBytes as number) : notRead : account.diskBytes,
            databases: Array.isArray(account.databases) ? account.databases.length : notRead, mailboxes: comparison ? number(account.mailboxes) : account.mailboxes,
            conflict: matching.map(value => conflictLabels[String(value.kind)] ?? t(msgctxt('whm-transfer-client', 'Conflict'))).join(', ') || (comparison ? notRead : ''),
            conflicts: matching.map(value => value.id), resolution: t('Review selection') }
        }))
        fillApproved('transfer-plans', (Array.isArray(inventory.plans) ? inventory.plans.filter(object) : []).map(plan => {
          const mapped = reviewed.filter(object).find(account => sourceAccounts.some(source => source.username === account.source && source.plan === plan.name))
          return { source: plan.name, target: mapped?.plan ?? t(msgctxt('whm-transfer-client', 'Not read')), owner: t(msgctxt('whm-transfer-client', 'Not read')), conflict: conflicts.filter(value => object(value) && value.kind === 'plan' && value.subject === plan.name).map(() => t('Review selection')).join(', ') }
        }))
        if (planNotice) planNotice.textContent = t('The source plans came from authenticated inventory. Destination mappings appear only after review; ownership has not been read.')
        const notice = pageRoot.querySelector<HTMLElement>('[data-transfer-identities-observation]')
        if (notice) notice.textContent = t('Authenticated source inventory was returned. Save the selection to read current destination conflicts.')
      }
      const progress = object(selected?.session.progress) ? selected.session.progress : {}
      const progressRows = Object.entries(progress).filter(([, value]) => object(value))
      if (progressRows.length) {
        const phases: Record<string, string> = { pending: t(msgctxt('whm-transfer-client', 'Pending')), exporting: t('Exporting'), copying: t('Copying'), importing: t('Importing'), reconciling: t('Reconciling'), syncing: t('Final sync'), cutover: t('Cutting over'), done: t(msgctxt('whm-transfer-client', 'Done')), failed: t('Failed'), skipped: t('Skipped') }
        const results = selected?.results ?? {}
        const moved = Object.entries(results).filter(([, value]) => object(value) && object(value.live) && !value.live.revertedAt).map(([name]) => name)
        revertAccount.textContent = ''
        for (const name of moved) { const option = document.createElement('option'); option.value = name; option.textContent = name; revertAccount.append(option) }
        // the most recent revert keeps showing what it did not carry back
        const reverted = Object.values(results).flatMap(value => object(value) && object(value.live) && typeof value.live.revertedAt === 'string' ? [value.live] : []).sort((left, right) => String(right.revertedAt).localeCompare(String(left.revertedAt)))[0]
        paintLoss(reverted ? parseLoss(reverted.lost) : null)
        const waiting = t(msgctxt('whm-transfer-client', 'Waiting'))
        fillApproved('transfer-progress', progressRows.map(([name, value]) => {
          const result = object(results[name]) ? results[name] as Record<string, unknown> : {}, done = object(value) && value.phase === 'done'
          const count = (key: string): string => Array.isArray(result[key]) ? String((result[key] as unknown[]).length) : typeof result[key] === 'number' ? String(result[key]) : waiting
          return { account: name + (object(value) && typeof value.targetUsername === 'string' && value.targetUsername !== name ? ' → ' + value.targetUsername : ''),
            home: done && object(result.home) ? t('{bytes} bytes, compared', { bytes: Number(result.home.bytes) }) : waiting, databases: done ? count('databases') : waiting, mail: done ? count('mailboxes') : waiting, dns: done ? count('zones') : waiting,
            state: (object(value) ? (phases[String(value.phase)] ?? t(msgctxt('whm-transfer-client', 'Not read'))) + ' · ' + String(value.bytes) + ' / ' + String(value.totalBytes) : '') + (object(value) && typeof value.error === 'string' ? ' · ' + value.error : '') }
        }))
        const note = pageRoot.querySelector<HTMLElement>('[data-transfer-progress-state]')
        if (note) { note.dataset.transferProgressState = 'read'; note.textContent = selected?.stopRequested && selected.session.state === 'applying' ? t('The transfer stops after the current account.') : selected?.session.live === true ? t('Each account is copied while it stays live. The source is then suspended for the final sync, and its sites and mail pass through to this server.') : t('Accounts are copied one at a time. The source is only read; a failed account is removed again.') }
      } else paintLoss(null)
      root.querySelector<HTMLElement>('[data-transfer-execution-note]')!.textContent = capabilities.execute ? t('Accounts are copied one at a time. The source is only read; a failed account is removed again.') : t('Transfers are unavailable here: they need the host agent on this server.')
      root.querySelector<HTMLElement>('[data-transfer-archive-limit]')!.textContent = capabilities.cpanelImport ? t('Maximum archive size: {bytes} bytes', { bytes: capabilities.cpanelUploadMaxBytes }) : t('cPanel import is unavailable here: it needs the host agent on this server.')
      controls()
    }
    /** Stored source credentials by reference: label and token fingerprint only (apps/api/src/acct-transfer-credentials.ts). */
    const fillCredentials = async (): Promise<void> => {
      if (root.dataset.transferCredentials !== 'read') return
      const previous = credential.value
      let value: unknown = null
      try { value = await request('GET', '/api/transfers/credentials') } catch { value = null }
      if (!verifyTemplates()) return
      const list = object(value) && Array.isArray(value.credentials) && value.credentials.every(item => object(item) && typeof item.id === 'string' && uuid.test(item.id) && item.kind === 'api-token'
        && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 80 && typeof item.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(item.fingerprint)) ? value.credentials as Record<string, string>[] : null
      credential.textContent = ''
      root.dataset.transferCredentialState = list ? 'read' : 'unavailable'
      for (const item of list ?? []) { const option = document.createElement('option'); option.value = item.id!; option.dataset.kind = 'api-token'; option.textContent = item.label + ' · ' + item.fingerprint; credential.append(option) }
      if ([...credential.options].some(option => option.value === previous)) credential.value = previous
    }
    /** Linked servers by id only; the credential of a link never reaches this page. */
    const fillNodes = async (): Promise<void> => {
      if (!capabilities.live) return
      const previous = nodeSelect.value
      let value: unknown
      try { value = await request('GET', '/api/server/nodes') } catch { value = null }
      const nodes = object(value) && object(value.config) && Array.isArray(value.config.nodes) ? value.config.nodes.filter(object) : []
      nodeSelect.textContent = ''
      const none = document.createElement('option'); none.value = ''; none.textContent = t('None'); nodeSelect.append(none)
      for (const node of nodes) { const option = document.createElement('option'); option.value = String(node.id); option.textContent = String(node.label) + ' · ' + String(node.hostname); nodeSelect.append(option) }
      if ([...nodeSelect.options].some(option => option.value === previous)) nodeSelect.value = previous
    }
    const read = async (target: string, preloaded?: unknown): Promise<Record<string, unknown>> => {
      if (!verifyTemplates()) throw { stateChanged: false }
      const value = preloaded ?? await request('GET', '/api/transfers/sessions')
      if (!object(value) || !Array.isArray(value.sessions) || !object(value.capabilities) || !Number.isSafeInteger(value.capabilities.cpanelUploadMaxBytes) || (value.capabilities.cpanelUploadMaxBytes as number) < 0) throw new Error('invalid_transfer_workspace')
      entries = value.sessions.map(parseEntry)
      if (new Set(entries.map(entry => entry.session.id)).size !== entries.length) throw new Error('duplicate_transfer_sessions')
      capabilities = { discover: value.capabilities.discover === true, execute: value.capabilities.execute === true, live: value.capabilities.live === true, cpanelImport: value.capabilities.cpanelImport === true, cpanelUploadMaxBytes: value.capabilities.cpanelUploadMaxBytes as number }
      imports = Array.isArray(value.cpanelImports) ? value.cpanelImports.filter(object).filter(item => typeof item.id === 'string' && uuid.test(item.id)) : []
      await fillCredentials()
      await fillNodes()
      if (!verifyTemplates()) throw { stateChanged: true, unknownOutcome: true }
      loaded = true; reviewRequired = false; dirty = false; paint(target)
      if (capabilities.cpanelImport) await fillPlans()
      if (!verifyTemplates()) throw { stateChanged: true, unknownOutcome: true }
      paintImports(); schedulePoll(); controls()
      return value
    }
    const refresh = async (target = String(selected?.session.id ?? '')): Promise<void> => {
      if (busy || !verifyTemplates()) return
      busy = true; controls()
      try {
        if ((dirty || reviewRequired) && !await ask(t('Read saved transfer state?'), t('This discards unsaved selection changes and re-reads the saved outcome. No previous mutation is retried.'), true)) return
        await read(target); announce('read', t('Saved sessions and archive imports read.'))
      } catch { announce('failed', t('Saved transfer state could not be read. Existing edits are preserved.')) }
      finally { busy = false; controls() }
    }
    const perform = async (action: string, body: Record<string, unknown>, create = false): Promise<void> => {
      if (busy || reviewRequired || !loaded || !verifyTemplates()) return
      const previous = selected, previousId = String(previous?.session.id ?? '')
      if (!create && !previous) return
      busy = true; controls(); let submitted = false
      try {
        if (action !== 'revert' && !await ask(action === 'run' ? t('Start transfer?') : t('Confirm transfer review action'), (previous ? sourceLabel(previous.session) + '\n' : '') + (action === 'run' && previous?.session.live === true ? t('Each account is copied while it stays live. The source is then suspended for the final sync, and its sites and mail pass through to this server.') : action === 'run' ? t('Each reviewed account is rebuilt here one at a time. Shared services are only reloaded.') : t('The server verifies the current saved revision and permissions.')), action === 'cancel' || action === 'run' || action === 'stop')) return
        submitted = true
        const value = await request(create ? 'POST' : 'PATCH', create ? '/api/transfers/sessions' : '/api/transfers/sessions/' + encodeURIComponent(previousId), create ? body : { ...body, action, expectedRevision: previous!.revision })
        const acknowledged = parseEntry(value)
        const observed = await request('GET', '/api/transfers/sessions')
        if (!object(observed) || !Array.isArray(observed.sessions)) throw new Error('missing_transfer_readback')
        const found = observed.sessions.map(parseEntry).find(entry => entry.session.id === acknowledged.session.id)
        // a started run keeps writing progress, so only its identity is read back
        if (!found || action !== 'run' && (found.revision !== acknowledged.revision || JSON.stringify(found.session) !== JSON.stringify(acknowledged.session))) throw new Error('transfer_readback_mismatch')
        await read(String(acknowledged.session.id), observed)
        announce('saved', action === 'run' ? t('The transfer started. Progress appears below as each account moves.') : action === 'revert' ? t('The cutover was reverted. What changed here since the cutover was not carried back; it is listed below.') : action === 'stop' ? t('The transfer stops after the current account.') : t('Transfer review state was saved and read back.'))
      } catch (error) {
        const details = object(error) && object(error.details) ? error.details : {}
        // the confirmed list no longer matches what the server sees: show the new one, nothing was reverted
        if (details.reason === 'revert_preview_stale') { paintLoss(parseLoss(details.preview)); announce('stale', t('What the revert drops changed since the preview. Nothing was reverted; review the new list and confirm again.')); return }
        const knownRefusal = object(error) && (error.stateChanged === false || details.stateChanged === false || typeof error.status === 'number' && error.status >= 400 && error.status < 500 && details.stateChanged !== true && details.unknownOutcome !== true)
        reviewRequired = submitted && !knownRefusal
        if (object(error) && error.status === 409) reviewRequired = true
        const stale = object(error) && error.status === 409
        announce(stale ? 'stale' : reviewRequired ? 'uncertain' : 'failed', stale ? t('The saved session changed. Your edits are kept. Read saved state before continuing.') : reviewRequired ? t('The outcome requires review. Your edits are kept; no retry was sent. Read saved state before continuing.') : t('The request was refused. Your edits are kept and no retry was sent.'))
      } finally { busy = false; controls() }
    }
    /** Reads what the revert drops, shows it, and reverts only after the operator types the account name over that list. */
    const revertCutover = async (): Promise<void> => {
      const previous = selected, account = revertAccount.value
      if (busy || reviewRequired || !loaded || !previous || !account || !verifyTemplates()) return
      busy = true; controls()
      let loss: Loss | null = null
      try { const value = await request('PATCH', '/api/transfers/sessions/' + encodeURIComponent(String(previous.session.id)), { action: 'revert-preview', account, expectedRevision: previous.revision }); loss = parseLoss(object(value) ? value.preview : null) }
      catch { loss = null }
      finally { busy = false; controls() }
      paintLoss(loss)
      if (!loss) { announce('failed', t('What the revert drops could not be read. Nothing was reverted.')); return }
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      const seen: Loss = loss, boxes = seen.mail === 'unknown' ? [] : seen.mail.map(box => box.mailbox)
      const summary = lossRows(seen).filter(row => !boxes.includes(String(row.item))).map(row => row.item + ': ' + row.observed).join('; ')
      const typed = await askDialog({ title: t('Revert the cutover?'), body: t('The source serves this account again and its zones point back there. The copy here is removed, and nothing changed here since the cutover is carried back: {summary}.', { summary }),
        input: true, value: '', preserveWhitespace: true, label: t('Type the account name to confirm'), confirm: t('Revert cutover'), danger: true })
      if (!verifyTemplates() || selected !== previous) return
      if (typed !== account) { announce('failed', typed === null ? t('The revert was not confirmed. Nothing was sent.') : t('The account name did not match. Nothing was sent.')); return }
      await perform('revert', { account, confirmation: seen.digest })
    }
    /** Plans on this server for an imported account; read once, kept across refreshes. */
    const fillPlans = async (): Promise<void> => {
      if (importPlan.options.length) return
      let value: unknown = null
      try { value = await request('GET', '/api/plans') } catch { value = null }
      if (!verifyTemplates()) return
      if (!object(value) || !Array.isArray(value.plans)) return
      for (const plan of value.plans) if (object(plan) && typeof plan.id === 'string' && uuid.test(plan.id) && typeof plan.name === 'string') { const option = document.createElement('option'); option.value = plan.id; option.textContent = plan.name; importPlan.append(option) }
    }
    const failure = (error: unknown, refused: string, uncertain: string, submitted: boolean): void => {
      const details = object(error) && object(error.details) ? error.details : {}
      reviewRequired = submitted && !(object(error) && typeof error.status === 'number' && error.status >= 400 && error.status < 500 && details.stateChanged !== true && details.unknownOutcome !== true)
      announce(reviewRequired ? 'uncertain' : 'failed', reviewRequired ? uncertain : refused)
    }
    /** Sends the archive in 4 MiB pieces; the server checks each offset and digests the whole file at the end. */
    const inspect = async (): Promise<void> => {
      if (busy || reviewRequired || !loaded || !admitted() || !capabilities.cpanelImport) return
      const file = field('transfer-archive').files?.[0]
      if (!file || file.size <= 0 || file.size > capabilities.cpanelUploadMaxBytes) { announce('failed', t('Choose a nonempty archive within the import limit. Nothing was sent.')); return }
      busy = true; controls(); let submitted = false
      try {
        const target = field('transfer-archive-target').value.trim()
        submitted = true
        const created = await request('POST', '/api/transfers/cpanel-imports', { filename: file.name, bytes: file.size, ...(target ? { targetUsername: target } : {}) })
        if (!object(created) || !object(created.cpanelImport) || typeof created.cpanelImport.id !== 'string' || !uuid.test(created.cpanelImport.id) || !Number.isSafeInteger(created.chunkBytes)) throw new Error('invalid_import')
        const id = created.cpanelImport.id, size = created.chunkBytes as number
        for (let offset = 0; offset < file.size; offset += size) {
          const bytes = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()); let binary = ''
          if (!verifyTemplates()) throw { stateChanged: true, unknownOutcome: true }
          for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384))
          announce('saving', t('Uploading: {percent}%', { percent: Math.floor(offset / file.size * 100) }))
          await request('PUT', '/api/transfers/cpanel-imports/' + id, { offset, data: btoa(binary) })
        }
        await read(String(selected?.session.id ?? '')); importSelect.value = id; paintArchive(imports.find(item => item.id === id)); controls()
        announce('saved', t('The archive was uploaded and its SHA-256 recorded. The server is reading it now.'))
      } catch (error) { failure(error, t('The upload was refused. No account was imported.'), t('The upload outcome requires inspection. No retry was sent.'), submitted) }
      finally { busy = false; controls() }
    }
    /** pkgacct on the cPanel server over SSH with this server's transfer key and the pinned host key. */
    const fetchArchive = async (): Promise<void> => {
      if (busy || reviewRequired || !loaded || !admitted() || !capabilities.cpanelImport) return
      const body = { host: field('transfer-cpanel-host').value.trim(), port: Number(field('transfer-cpanel-port').value), hostKeyFingerprint: field('transfer-cpanel-fingerprint').value.trim(), cpanelUser: field('transfer-cpanel-user').value.trim(),
        ...(field('transfer-archive-target').value.trim() ? { targetUsername: field('transfer-archive-target').value.trim() } : {}) }
      if (!body.host || !body.cpanelUser || !body.hostKeyFingerprint) { announce('failed', t('Enter the cPanel host, its pinned host key and the cPanel username. Nothing was sent.')); return }
      busy = true; controls(); let submitted = false
      try {
        if (!await ask(t('Fetch the account over SSH?'), body.host + '\n' + t('The cPanel server packages the account with pkgacct; the archive is copied here and checked against its SHA-256.'))) return
        submitted = true
        await request('POST', '/api/transfers/cpanel-imports/ssh', body)
        await read(String(selected?.session.id ?? ''))
        announce('saved', t('The cPanel server is packaging the account. This page refreshes while it runs.'))
      } catch (error) { failure(error, t('The fetch was refused. Nothing was copied.'), t('The fetch outcome requires inspection. No retry was sent.'), submitted) }
      finally { busy = false; controls() }
    }
    const importAction = async (action: 'import' | 'discard'): Promise<void> => {
      const chosen = imports.find(item => item.id === importSelect.value)
      if (busy || reviewRequired || !loaded || !admitted() || !chosen || typeof chosen.revision !== 'string') return
      const account = object(chosen.plan) && object(chosen.plan.account) ? display(chosen.plan.account.username) : display(chosen.filename)
      busy = true; controls(); let submitted = false
      try {
        if (!await ask(action === 'import' ? t('Import {account}?', { account }) : t('Discard this archive?'), action === 'import' ? t('The account is built here with a new UID, slice and vhost, then its files, databases, zones and mail are restored. Owners must set new passwords.') : t('The archive file is removed from this server.'), action === 'discard')) return
        submitted = true
        await request('PATCH', '/api/transfers/cpanel-imports/' + String(chosen.id), { action, expectedRevision: chosen.revision, ...(action === 'import' ? { planId: importPlan.value } : {}) })
        await read(String(selected?.session.id ?? ''))
        announce('saved', action === 'import' ? t('The import started. This page refreshes while it runs.') : t('The archive was discarded.'))
      } catch (error) { failure(error, t('The request was refused. Nothing was changed.'), t('The outcome requires review. No retry was sent.'), submitted) }
      finally { busy = false; controls() }
    }
    const showKey = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls()
      try {
        const value = await request('GET', '/api/transfers/ssh-key')
        if (!object(value) || typeof value.publicKey !== 'string' || typeof value.fingerprint !== 'string') throw new Error('invalid_key')
        keyBox.textContent = value.publicKey + ' · ' + value.fingerprint
        announce('read', t('Add this public key to root on the cPanel server before fetching.'))
      } catch { announce('failed', t('The transfer key could not be read.')) }
      finally { busy = false; controls() }
    }
    if (!send || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); announce('unavailable', t('Transfer review is unavailable here. Nothing was read or changed.')); return }
    if (!verifyTemplates()) return
    selectAll?.addEventListener('input', () => {
      if (selectAll.disabled || busy || reviewRequired || wholeServer || !verifyTemplates()) return
      for (const item of inventoryRows) if (item.row.isConnected && root.contains(item.row) && !item.select.disabled) item.select.checked = selectAll.checked
      dirty = true; controls()
    })
    button('refresh').addEventListener('click', () => { void refresh() })
    sessionSelect.addEventListener('change', () => { const id = sessionSelect.value; sessionSelect.value = String(selected?.session.id ?? ''); void refresh(id) })
    nodeSelect.addEventListener('change', controls)
    revertAccount.addEventListener('change', controls)
    button('revert').addEventListener('click', () => { if (!button('revert').disabled) void revertCutover() })
    button('create').addEventListener('click', () => {
      if (nodeSelect.value) { void perform('create', { node: nodeSelect.value, live: liveBox.checked }, true); return }
      const option = credential.selectedOptions[0]
      if (!option) return
      const auth = option.dataset.kind === 'api-token' ? { kind: 'api-token', url: field('transfer-host').value.trim(), tokenId: option.value, tlsFingerprint: field('transfer-fingerprint').value.trim() || null } : { kind: 'ssh-key', host: field('transfer-host').value.trim(), port: Number(field('transfer-port').value), user: field('transfer-user').value.trim(), keyId: option.value, hostKeyFingerprint: field('transfer-fingerprint').value.trim() }
      void perform('create', { auth }, true)
    })
    button('discover').addEventListener('click', () => { if (!button('discover').disabled) void perform('discover', {}) })
    button('cancel').addEventListener('click', () => { if (!button('cancel').disabled) void perform('cancel', {}) })
    button('select').addEventListener('click', () => { if (!button('select').disabled) void perform('select', { accounts: [...accounts.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value), plans: [...plans.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value) }) })
    conflict.addEventListener('change', paintResolution); resolution.addEventListener('change', controls)
    button('resolve').addEventListener('click', () => { if (!button('resolve').disabled) void perform('resolve', { conflictId: conflict.value, resolution: { action: resolution.value, ...(['rename', 'map-plan'].includes(resolution.value) ? { to: field('transfer-resolution-target').value.trim() } : {}) } }) })
    button('review').addEventListener('click', () => { if (!button('review').disabled) void perform('review', {}) })
    button('run').addEventListener('click', () => { if (!button('run').disabled) void perform('run', { digest: selected?.digest }) })
    button('inspect').addEventListener('click', () => { void inspect() })
    button('fetch').addEventListener('click', () => { void fetchArchive() })
    button('import-run').addEventListener('click', () => { void importAction('import') })
    button('import-discard').addEventListener('click', () => { void importAction('discard') })
    button('ssh-key').addEventListener('click', () => { void showKey() })
    button('stop').addEventListener('click', () => { if (!button('stop').disabled) void perform('stop', {}) })
    importSelect.addEventListener('change', () => { paintArchive(imports.find(item => item.id === importSelect.value)); controls() })
    importPlan.addEventListener('change', controls)
    root.addEventListener('input', () => { dirty = true; controls() })
    root.addEventListener('change', event => { if (event.target !== sessionSelect) { dirty = true; controls() } })
    document.addEventListener('xp-transfer-credentials-changed', () => { if (!busy) void fillCredentials().then(controls) })
    window.addEventListener('beforeunload', event => { if (dirty || reviewRequired) { event.preventDefault(); event.returnValue = '' } })
    void refresh()
  })
}

export const WHM_TRANSFER_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const displayDateTime=${DISPLAY_DATETIME_BINDING};const formatAsciiBytes=${ASCII_BYTES_BINDING};return ${bindWhmTransfer.toString()};})()`
