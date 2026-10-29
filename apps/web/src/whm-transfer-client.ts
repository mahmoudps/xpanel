/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime

/** Self-contained browser binding over the persisted transfer workspace contract. */
function bindWhmTransfer(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const display = (value: unknown): string => String(value ?? '').replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const states = ['created', 'connected', 'inventoried', 'selected', 'reviewed', 'applying', 'completed', 'failed', 'cancelled']
  type Entry = { session: Record<string, unknown>; revision: string; review: Record<string, unknown> | null; digest: string | null }
  const parseEntry = (value: unknown): Entry => {
    if (!object(value) || !object(value.session) || typeof value.session.id !== 'string' || !uuid.test(value.session.id) || !states.includes(String(value.session.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.session.auth) || !object(value.session.selection)) throw new Error('invalid_transfer_state')
    return { session: value.session, revision: value.revision, review: object(value.review) ? value.review : null, digest: typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) ? value.digest : null }
  }
  const stateLabel = (state: string): string => {
    const copy: Record<string, string> = { created: msgid('Source review saved'), connected: msgid('Source connection observed'), inventoried: msgid('Inventory read'), selected: msgid('Selection saved'), reviewed: msgid('Review ready'), applying: msgid('Execution pending observation'), completed: msgid('Executor reported completion'), failed: msgid('Failed'), cancelled: msgctxt('whm-transfer-client', 'Cancelled') }
    return ((copy[state]) ? t(copy[state]!) : null) ?? t(msgctxt('whm-transfer-client', 'Not read'))
  }
  document.querySelectorAll<HTMLElement>('[data-transfer-workspace]').forEach(root => {
    if (root.dataset.transferBound === 'true') return
    root.dataset.transferBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const field = (id: string): HTMLInputElement => root.querySelector<HTMLInputElement>('[data-transfer-field="' + id + '"]')!
    const button = (name: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-transfer-' + name + ']')!
    const sessionSelect = root.querySelector<HTMLSelectElement>('[data-transfer-session]')!
    const credential = root.querySelector<HTMLSelectElement>('[data-transfer-credential]')!
    const conflict = root.querySelector<HTMLSelectElement>('[data-transfer-conflict]')!
    const resolution = root.querySelector<HTMLSelectElement>('[data-transfer-resolution]')!
    const status = root.querySelector<HTMLElement>('[data-transfer-status]')!
    const accounts = root.querySelector<HTMLElement>('[data-transfer-accounts]')!
    const plans = root.querySelector<HTMLElement>('[data-transfer-plans]')!
    const reviewBox = root.querySelector<HTMLElement>('[data-transfer-review-results]')!
    const archiveBox = root.querySelector<HTMLElement>('[data-transfer-archive-review]')!
    if (!sessionSelect || !credential || !conflict || !resolution || !status || !accounts || !plans || !reviewBox || !archiveBox) return
    let entries: Entry[] = [], selected: Entry | null = null, loaded = false, busy = false, dirty = false, reviewRequired = false
    let capabilities = { discover: false, execute: false, archiveReview: false, archiveMaxBytes: 0 }
    // Whole-server migration: every source account and plan is selected and the choice is not editable.
    const wholeServer = root.dataset.transferScope === 'server'
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.transferManage === 'true' && !root.closest(denied)
    const selectionChanged = (): boolean => {
      const selection = object(selected?.session.selection) ? selected.session.selection : {}
      const names = (container: HTMLElement): string[] => [...container.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value).sort()
      return JSON.stringify(names(accounts)) !== JSON.stringify(Array.isArray(selection.accounts) ? [...selection.accounts].sort() : []) || JSON.stringify(names(plans)) !== JSON.stringify(Array.isArray(selection.plans) ? [...selection.plans].sort() : [])
    }
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status') }
    const controls = (): void => {
      const locked = busy || reviewRequired || !loaded || !admitted(), state = String(selected?.session.state ?? '')
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = locked })
      button('refresh').disabled = busy || !admitted()
      sessionSelect.disabled = busy || !loaded || !admitted()
      credential.disabled = locked || !credential.options.length
      button('create').disabled = locked || !credential.options.length
      button('discover').disabled = locked || !capabilities.discover || state !== 'created'
      button('select').disabled = locked || !['inventoried', 'selected', 'reviewed'].includes(state)
      button('resolve').disabled = locked || selectionChanged() || !['selected', 'reviewed'].includes(state) || !conflict.options.length
      button('review').disabled = locked || selectionChanged() || state !== 'selected'
      button('run').disabled = locked || selectionChanged() || !capabilities.execute || state !== 'reviewed' || !selected?.digest
      button('cancel').disabled = locked || !['created', 'connected', 'inventoried', 'selected', 'reviewed'].includes(state)
      button('inspect').disabled = locked || !capabilities.archiveReview
      field('transfer-resolution-target').disabled = locked || !['rename', 'map-plan'].includes(resolution.value)
      if (wholeServer) [accounts, plans].forEach(container => container.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.disabled = true }))
      root.setAttribute('aria-busy', String(busy))
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => {
      if (!send || !admitted()) return Promise.reject({ stateChanged: false })
      return body === undefined ? send(method, path) : send(method, path, body)
    }
    const ask = async (title: string, body: string, danger = false): Promise<boolean> => {
      if (!askDialog) { announce('failed', t('Confirmation is unavailable. Nothing was sent.')); return false }
      return await askDialog({ title, body, danger, confirm: t('Confirm') }) === true
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
        const label = document.createElement('label'), input = document.createElement('input'), name = document.createElement('bdi')
        label.className = 'xp-transfer-workspace__choice'; input.type = 'checkbox'; input.value = value[key] as string; input.checked = wholeServer || checked.has(input.value)
        name.dir = 'ltr'; name.textContent = input.value; label.append(input, name); container.append(label)
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
    const table = (container: HTMLElement, headers: string[], rows: unknown[][]): void => {
      container.textContent = ''
      if (!rows.length) { const note = document.createElement('p'); note.textContent = t('No reviewed records were returned.'); container.append(note); return }
      const wrapper = document.createElement('div'), element = document.createElement('table'), thead = document.createElement('thead'), heading = document.createElement('tr'), tbody = document.createElement('tbody')
      wrapper.className = 'xp-transfer-workspace__scroll'
      element.className = 'xp-table'
      for (const value of headers) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = value; heading.append(cell) }
      thead.append(heading)
      for (const values of rows) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'), content = document.createElement('bdi'); content.dir = /[\u0600-\u06ff]/.test(display(value)) ? 'auto' : 'ltr'; content.textContent = display(value); cell.append(content); row.append(cell) } tbody.append(row) }
      element.append(thead, tbody); wrapper.append(element); container.append(wrapper)
    }
    const fillBody = (body: Element | null, values: unknown[][], empty: string): void => {
      if (!body) return
      body.textContent = ''
      if (!values.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = body.closest('table')?.querySelectorAll('thead th').length || 1; cell.textContent = empty; row.append(cell); body.append(row); return }
      for (const valuesRow of values) { const row = document.createElement('tr'); for (const value of valuesRow) { const cell = document.createElement('td'), content = document.createElement('bdi'); content.dir = /[\u0600-\u06ff]/.test(display(value)) ? 'auto' : 'ltr'; content.textContent = display(value); cell.append(content); row.append(cell) } body.append(row) }
    }
    const paintArchive = (value: unknown): void => {
      archiveBox.textContent = ''
      const approved = document.querySelector<HTMLElement>('[data-whm-detail-section="transfer-import"]')
      const approvedNotice = approved?.querySelector<HTMLElement>('.xp-whm-detail-status')
      const detailBodies = [...(approved?.querySelectorAll('details table tbody') ?? [])]
      const warningsBody = [...(approved?.querySelectorAll('table tbody') ?? [])].at(-1) ?? null
      const absent = t('No parsed archive review was returned.')
      for (const body of detailBodies) fillBody(body, [], absent)
      fillBody(warningsBody, [], absent)
      if (approvedNotice) approvedNotice.textContent = t('No parsed archive review was returned. Native archive import remains unavailable.')
      if (!object(value) || !object(value.plan) || !object(value.plan.account)) return
      if (approvedNotice) approvedNotice.textContent = t('The server parsed this archive review. Archive bytes are not retained; account import still requires archive custody and qualified execution.')
      const plan = value.plan, account = plan.account as Record<string, unknown>
      const title = document.createElement('p'); title.textContent = display(account.username) + ' · ' + display(account.primaryDomain); archiveBox.append(title)
      const notRead = t(msgctxt('whm-transfer-client', 'Not read')), reviewOnly = t('Parsed review only')
      const returned = (items: unknown): Record<string, unknown>[] => Array.isArray(items) ? items.filter(object) : []
      const empty = t('No records were returned for this part of the parsed review.')
      fillBody(detailBodies[0] ?? null, returned(plan.domains).map(domain => [domain.name, domain.name, domain.docRoot, reviewOnly]), empty)
      const home = object(plan.home) ? plan.home : {}
      const metrics: Array<readonly [string, string]> = [['files', t('Files')], ['directories', t('Directories')], ['symlinks', t('Symbolic links')], ['bytes', t('Bytes')], ['skipped', t('Skipped entries')]]
      fillBody(detailBodies[1] ?? null, metrics.filter(([key]) => typeof home[key] === 'number').map(([key, label]) => [label, home[key], t('Archive bytes not retained'), reviewOnly]), empty)
      fillBody(detailBodies[2] ?? null, [...returned(plan.databases).map(database => [t(msgctxt('whm-transfer-client', 'Database')), database.sourceName, database.name, reviewOnly]), ...returned(plan.dbUsers).map(user => [t(msgctxt('whm-transfer-client', 'Database user')), user.sourceName, user.name, t('Password reset required; parsed review only')])], empty)
      fillBody(detailBodies[3] ?? null, returned(plan.mailboxes).map(mailbox => [mailbox.address, mailbox.hasMaildir === true ? mailbox.maildir : t('No archived mail directory'), mailbox.maildir, t('Password reset required; parsed review only')]), empty)
      fillBody(detailBodies[4] ?? null, returned(plan.dnsZones).flatMap(zone => returned(zone.records).map(record => [display(record.name) + ' · ' + display(record.type), record.content ?? notRead, zone.zone, reviewOnly])), empty)
      fillBody(warningsBody, returned(plan.warnings).map(warning => [t('Archive warning'), warning.message, warning.path ?? notRead]), empty)
      const rows = [
        [t('Domains'), Array.isArray(plan.domains) ? plan.domains.length : notRead],
        [t('Databases'), Array.isArray(plan.databases) ? plan.databases.length : notRead],
        [t('Mailboxes'), Array.isArray(plan.mailboxes) ? plan.mailboxes.length : notRead],
        [t('Conflicts'), Array.isArray(value.conflicts) ? value.conflicts.length : notRead],
      ]
      const summary = document.createElement('div'); table(summary, [t(msgctxt('whm-transfer-client', 'Part')), t('Count')], rows); archiveBox.append(summary)
      if (Array.isArray(value.conflicts) && value.conflicts.length) { const details = document.createElement('div'); table(details, [t('Conflict'), t('Value')], value.conflicts.filter(object).map(item => [item.kind === 'username' ? t('Account name') : t('Domain'), item.value])); archiveBox.append(details) }
      if (Array.isArray(plan.warnings)) { const list = document.createElement('ul'); for (const warning of plan.warnings) if (object(warning) && typeof warning.message === 'string') { const item = document.createElement('li'); item.textContent = display(warning.message); list.append(item) } archiveBox.append(list) }
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
      makeChoices(accounts, inventory.accounts, selection.accounts, 'username'); makeChoices(plans, inventory.plans, selection.plans, 'name')
      root.querySelector<HTMLElement>('[data-transfer-inventory-note]')!.textContent = object(selected?.session.inventory) ? t('Authenticated source inventory was returned by the server.') : t('No authenticated source inventory has been read.')
      conflict.textContent = ''
      const conflicts = Array.isArray(selected?.session.conflicts) ? selected.session.conflicts : []
      const conflictLabels: Record<string, string> = { username: t('Account name'), domain: t('Domain'), uid: 'UID', plan: t('Plan') }
      for (const item of conflicts) if (object(item) && typeof item.id === 'string' && typeof item.subject === 'string') { const option = document.createElement('option'); option.value = item.id; option.textContent = item.subject + ' · ' + (conflictLabels[String(item.kind)] ?? t(msgctxt('whm-transfer-client', 'Conflict'))); conflict.append(option) }
      paintResolution()
      const reviewed = Array.isArray(selected?.review?.accounts) ? selected.review.accounts : []
      table(reviewBox, [t('Source account'), t('Destination account'), t('Plan'), t('Domains'), t('Mailboxes')], reviewed.filter(object).map(item => [item.source, item.target, item.plan, Array.isArray(item.domains) ? item.domains.join(', ') : '', item.mailboxes]))
      const fillApproved = (key: string, values: unknown[][]): void => {
        fillBody(document.querySelector('[data-whm-detail-section="' + key + '"] table tbody'), values, t('No observed records are available for this saved session.'))
      }
      fillApproved('transfer-identities', []); fillApproved('transfer-progress', []); fillApproved('transfer-plans', [])
      const planNotice = document.querySelector<HTMLElement>('[data-whm-detail-section="transfer-plans"] .xp-whm-detail-status')
      if (planNotice) planNotice.textContent = t('No authenticated source plans were returned for this saved session.')
      const sourceNotice = document.querySelector<HTMLElement>('[data-whm-detail-section="transfer-source"] .xp-whm-detail-status')
      if (sourceNotice) sourceNotice.textContent = t('Source identity, inventory and execution facts come only from trusted server adapters. The controls show their current availability.')
      const inventoryNotice = document.querySelector<HTMLElement>('[data-whm-detail-section="transfer-identities"] .xp-whm-detail-status')
      if (inventoryNotice) inventoryNotice.textContent = t('No authenticated source inventory was returned for this saved session.')
      const progressNotice = document.querySelector<HTMLElement>('[data-transfer-progress-state]')
      if (progressNotice) { progressNotice.dataset.transferProgressState = 'not-read'; progressNotice.textContent = t('No native per-account progress was returned for this saved session.') }
      if (object(selected?.session.inventory)) {
        const selectedNames = new Set(Array.isArray(selection.accounts) ? selection.accounts : [])
        const sourceAccounts = Array.isArray(inventory.accounts) ? inventory.accounts.filter(object) : []
        fillApproved('transfer-identities', sourceAccounts.map(account => [selectedNames.has(account.username) ? t('Yes') : t('No'), account.username, account.primaryDomain, account.plan, account.diskBytes, Array.isArray(account.databases) ? account.databases.length : t(msgctxt('whm-transfer-client', 'Not read')), account.mailboxes, conflicts.filter(value => object(value) && value.subject === account.username).map(value => object(value) ? conflictLabels[String(value.kind)] ?? t(msgctxt('whm-transfer-client', 'Conflict')) : '').join(', '), t('Review selection')]))
        fillApproved('transfer-plans', (Array.isArray(inventory.plans) ? inventory.plans.filter(object) : []).map(plan => {
          const mapped = reviewed.filter(object).find(account => sourceAccounts.some(source => source.username === account.source && source.plan === plan.name))
          return [plan.name, mapped?.plan ?? t(msgctxt('whm-transfer-client', 'Not read')), t(msgctxt('whm-transfer-client', 'Not read')), conflicts.filter(value => object(value) && value.kind === 'plan' && value.subject === plan.name).map(() => t('Review selection')).join(', ')]
        }))
        if (planNotice) planNotice.textContent = t('The source plans came from authenticated inventory. Destination mappings appear only after review; ownership has not been read.')
        const notice = document.querySelector<HTMLElement>('[data-whm-detail-section="transfer-identities"] .xp-whm-detail-status')
        if (notice) notice.textContent = t('Authenticated source inventory was returned. Save the selection to read current destination conflicts.')
      }
      const progress = object(selected?.session.progress) ? selected.session.progress : {}
      const progressRows = Object.entries(progress).filter(([, value]) => object(value))
      if (progressRows.length) {
        const phases: Record<string, string> = { pending: t(msgctxt('whm-transfer-client', 'Pending')), exporting: t('Exporting'), copying: t('Copying'), importing: t('Importing'), reconciling: t('Reconciling'), done: t(msgctxt('whm-transfer-client', 'Done')), failed: t('Failed'), skipped: t('Skipped') }
        fillApproved('transfer-progress', progressRows.map(([name, value]) => [name, t(msgctxt('whm-transfer-client', 'Not read')), t(msgctxt('whm-transfer-client', 'Not read')), t(msgctxt('whm-transfer-client', 'Not read')), t(msgctxt('whm-transfer-client', 'Not read')), object(value) ? (phases[String(value.phase)] ?? t(msgctxt('whm-transfer-client', 'Not read'))) + ' · ' + String(value.bytes) + ' / ' + String(value.totalBytes) : '']))
        const note = document.querySelector<HTMLElement>('[data-transfer-progress-state]')
        if (note) { note.dataset.transferProgressState = 'read'; note.textContent = t('Saved account progress was reported by the trusted transfer runner. Separate file, database, mail and DNS results have not been read.') }
      }
      root.querySelector<HTMLElement>('[data-transfer-execution-note]')!.textContent = capabilities.execute ? t('Execution still requires fresh lifecycle admission and the current review digest. Reported progress comes from the trusted runner.') : t('Native transfer execution is unavailable until qualified lifecycle admission and a trusted runner are configured.')
      root.querySelector<HTMLElement>('[data-transfer-archive-limit]')!.textContent = t('Maximum archive inspection upload: {bytes} bytes', { bytes: capabilities.archiveMaxBytes })
      controls()
    }
    /** Stored source credentials by reference: label and token fingerprint only (apps/api/src/acct-transfer-credentials.ts). */
    const fillCredentials = async (): Promise<void> => {
      if (root.dataset.transferCredentials !== 'read') return
      const previous = credential.value
      let value: unknown = null
      try { value = await request('GET', '/api/transfers/credentials') } catch { value = null }
      const list = object(value) && Array.isArray(value.credentials) && value.credentials.every(item => object(item) && typeof item.id === 'string' && uuid.test(item.id) && item.kind === 'api-token'
        && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 80 && typeof item.fingerprint === 'string' && /^[0-9a-f]{16}$/.test(item.fingerprint)) ? value.credentials as Record<string, string>[] : null
      credential.textContent = ''
      root.dataset.transferCredentialState = list ? 'read' : 'unavailable'
      for (const item of list ?? []) { const option = document.createElement('option'); option.value = item.id!; option.dataset.kind = 'api-token'; option.textContent = item.label + ' · ' + item.fingerprint; credential.append(option) }
      if ([...credential.options].some(option => option.value === previous)) credential.value = previous
    }
    const read = async (target: string, preloaded?: unknown): Promise<Record<string, unknown>> => {
      const value = preloaded ?? await request('GET', '/api/transfers/sessions')
      if (!object(value) || !Array.isArray(value.sessions) || !object(value.capabilities) || typeof value.capabilities.archiveMaxBytes !== 'number' || !Number.isSafeInteger(value.capabilities.archiveMaxBytes) || value.capabilities.archiveMaxBytes <= 0) throw new Error('invalid_transfer_workspace')
      entries = value.sessions.map(parseEntry)
      if (new Set(entries.map(entry => entry.session.id)).size !== entries.length) throw new Error('duplicate_transfer_sessions')
      capabilities = { discover: value.capabilities.discover === true, execute: value.capabilities.execute === true, archiveReview: value.capabilities.archiveReview === true, archiveMaxBytes: value.capabilities.archiveMaxBytes }
      await fillCredentials()
      loaded = true; reviewRequired = false; dirty = false; paint(target)
      if (Array.isArray(value.archiveReviews)) paintArchive(value.archiveReviews.at(-1))
      return value
    }
    const refresh = async (target = String(selected?.session.id ?? '')): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls()
      try {
        if ((dirty || reviewRequired) && !await ask(t('Read saved transfer state?'), t('This discards unsaved selection changes and re-reads the saved outcome. No previous mutation is retried.'), true)) return
        await read(target); announce('read', t('Saved sessions and archive reviews read. Native qualification remains unchanged.'))
      } catch { announce('failed', t('Saved transfer state could not be read. Existing edits are preserved.')) }
      finally { busy = false; controls() }
    }
    const perform = async (action: string, body: Record<string, unknown>, create = false): Promise<void> => {
      if (busy || reviewRequired || !loaded || !admitted()) return
      const previous = selected, previousId = String(previous?.session.id ?? '')
      if (!create && !previous) return
      busy = true; controls(); let submitted = false
      try {
        if (!await ask(t('Confirm transfer review action'), (previous ? sourceLabel(previous.session) + '\n' : '') + t('The server verifies the current saved revision and permissions. Native execution requires its own trusted admission.'), action === 'cancel' || action === 'run')) return
        submitted = true
        const value = await request(create ? 'POST' : 'PATCH', create ? '/api/transfers/sessions' : '/api/transfers/sessions/' + encodeURIComponent(previousId), create ? body : { ...body, action, expectedRevision: previous!.revision })
        const acknowledged = parseEntry(value)
        const observed = await request('GET', '/api/transfers/sessions')
        if (!object(observed) || !Array.isArray(observed.sessions)) throw new Error('missing_transfer_readback')
        const found = observed.sessions.map(parseEntry).find(entry => entry.session.id === acknowledged.session.id)
        if (!found || found.revision !== acknowledged.revision || JSON.stringify(found.session) !== JSON.stringify(acknowledged.session)) throw new Error('transfer_readback_mismatch')
        await read(String(acknowledged.session.id), observed)
        announce('saved', t('Transfer review state was saved and read back. Native qualification remains unchanged.'))
      } catch (error) {
        const details = object(error) && object(error.details) ? error.details : {}
        const knownRefusal = object(error) && (error.stateChanged === false || details.stateChanged === false || typeof error.status === 'number' && error.status >= 400 && error.status < 500 && details.stateChanged !== true && details.unknownOutcome !== true)
        reviewRequired = submitted && !knownRefusal
        if (object(error) && error.status === 409) reviewRequired = true
        const stale = object(error) && error.status === 409
        announce(stale ? 'stale' : reviewRequired ? 'uncertain' : 'failed', stale ? t('The saved session changed. Your edits are kept. Read saved state before continuing.') : reviewRequired ? t('The outcome requires review. Your edits are kept; no retry was sent. Read saved state before continuing.') : t('The request was refused. Your edits are kept and no retry was sent.'))
      } finally { busy = false; controls() }
    }
    const inspect = async (): Promise<void> => {
      if (busy || reviewRequired || !loaded || !admitted() || !capabilities.archiveReview) return
      const file = field('transfer-archive').files?.[0]
      if (!file || file.size <= 0 || file.size > capabilities.archiveMaxBytes) { announce('failed', t('Choose a nonempty archive within the server inspection limit. Nothing was sent.')); return }
      busy = true; controls(); let submitted = false
      const pendingSelection = { accounts: [...accounts.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value), plans: [...plans.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value), dirty }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384))
        const body = { filename: file.name, archiveBase64: btoa(binary), ...(field('transfer-archive-target').value.trim() ? { targetUsername: field('transfer-archive-target').value.trim() } : {}), ...(field('transfer-archive-source').value.trim() ? { expectedSourceUsername: field('transfer-archive-source').value.trim() } : {}) }
        submitted = true
        const value = await request('POST', '/api/transfers/cpanel-review', body)
        if (!object(value) || !object(value.archiveReview) || typeof value.archiveReview.id !== 'string' || !uuid.test(value.archiveReview.id) || value.archiveReview.archiveRetained !== false || value.archiveReview.nativeApplied !== false || value.archiveReview.filename !== file.name) throw new Error('invalid_archive_review')
        const observed = await request('GET', '/api/transfers/sessions')
        if (!object(observed) || !Array.isArray(observed.archiveReviews) || !observed.archiveReviews.some(review => object(review) && review.id === (value.archiveReview as Record<string, unknown>).id && review.archiveSha256 === (value.archiveReview as Record<string, unknown>).archiveSha256)) throw new Error('archive_review_readback_mismatch')
        await read(String(selected?.session.id ?? ''), observed)
        for (const [container, values] of [[accounts, pendingSelection.accounts], [plans, pendingSelection.plans]] as const) container.querySelectorAll<HTMLInputElement>('input').forEach(input => { input.checked = values.includes(input.value) })
        dirty = pendingSelection.dirty
        paintArchive(value.archiveReview); announce('saved', t('The archive was parsed and its review was saved and read back. No account was imported.'))
      } catch (error) {
        const details = object(error) && object(error.details) ? error.details : {}
        reviewRequired = submitted && !(object(error) && typeof error.status === 'number' && error.status >= 400 && error.status < 500 && details.stateChanged !== true && details.unknownOutcome !== true)
        announce(reviewRequired ? 'uncertain' : 'failed', reviewRequired ? t('The archive review outcome requires inspection. No retry was sent.') : t('Archive inspection was refused. No account was imported.'))
      } finally { busy = false; controls() }
    }
    if (!send || !admitted()) { root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button').forEach(control => { control.disabled = true }); announce('unavailable', t('Transfer review is unavailable here. Nothing was read or changed.')); return }
    button('refresh').addEventListener('click', () => { void refresh() })
    sessionSelect.addEventListener('change', () => { const id = sessionSelect.value; sessionSelect.value = String(selected?.session.id ?? ''); void refresh(id) })
    button('create').addEventListener('click', () => {
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
    root.addEventListener('input', () => { dirty = true; controls() })
    root.addEventListener('change', event => { if (event.target !== sessionSelect) { dirty = true; controls() } })
    document.addEventListener('xp-transfer-credentials-changed', () => { if (!busy) void fillCredentials().then(controls) })
    window.addEventListener('beforeunload', event => { if (dirty || reviewRequired) { event.preventDefault(); event.returnValue = '' } })
    void refresh()
  })
}

export const WHM_TRANSFER_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};return ${bindWhmTransfer.toString()};})()`
