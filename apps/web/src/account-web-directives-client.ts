import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
/// <reference lib="dom" />
export type WebDirectiveClientFeature = 'error-pages' | 'indexes' | 'mime-types' | 'hotlink' | 'ip-blocker' | 'redirects'
export interface WebDirectivesClientView {
  feature: WebDirectiveClientFeature
  context: { accountId: string; domainId: string; domainName: string; path: string; engine: string }
  document: { exists: boolean; revision: string; sizeBytes: number; unmanagedLines: number; managedFeatures: string[] }
  managed: boolean; model: Record<string, unknown>; conflict: { code: string; line: number } | null
  capabilities: { canSave: boolean; reason: string | null }
  application: { status: 'read' | 'validated' | 'saved' | 'rolled_back'; syntaxChecked: boolean; httpStatus: number | null; nativeQualified: false }
  validation?: { valid: boolean; nativeChecked: boolean; issues: { line: number; code: string }[] }
  existence?: 'not-checked'
}
export interface WebDirectivesClientState { domainId: string; view: WebDirectivesClientView | null; draft: Record<string, unknown> | null; dirty: boolean; busy: boolean; review: boolean; status: string; message: string; fields: { field: string; code: string }[] }
const WD_FEATURES = ['error-pages', 'indexes', 'mime-types', 'hotlink', 'ip-blocker', 'redirects']
const WD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WD_REVISION = /^[0-9a-f]{64}$/
const wdObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const wdExact = (value: unknown, keys: string[]): value is Record<string, unknown> => wdObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Shape-only checks; the API owns the directive grammar and returns field codes. */
function readWebDirectiveModel(feature: string, value: unknown): Record<string, unknown> {
  const text = (item: unknown, max: number): boolean => typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000- \u007f]/.test(item)
  const strings = (items: unknown, max: number, size: number): boolean => Array.isArray(items) && items.length <= max && items.every(item => text(item, size))
  const entries = wdExact(value, ['entries']) && Array.isArray(value.entries) ? value.entries as unknown[] : null
  const valid = feature === 'indexes' ? wdExact(value, ['listing']) && ['inherit', 'enabled', 'disabled'].includes(String(value.listing))
    : feature === 'hotlink' ? wdExact(value, ['enabled', 'allowedHosts', 'extensions', 'allowEmptyReferrer', 'redirectUrl']) && typeof value.enabled === 'boolean' && typeof value.allowEmptyReferrer === 'boolean' && strings(value.allowedHosts, 32, 253) && strings(value.extensions, 32, 10) && (value.redirectUrl === null || text(value.redirectUrl, 2048))
    : feature === 'error-pages' ? !!entries && entries.length <= 7 && entries.every(entry => wdExact(entry, ['code', 'path']) && [400, 401, 403, 404, 500, 502, 503].includes(entry.code as number) && text(entry.path, 512) && String(entry.path).startsWith('/'))
    : feature === 'mime-types' ? !!entries && entries.length <= 100 && entries.every(entry => wdExact(entry, ['type', 'extensions']) && text(entry.type, 255) && strings(entry.extensions, 16, 17) && (entry.extensions as unknown[]).length > 0)
    : feature === 'ip-blocker' ? !!entries && entries.length <= 500 && entries.every(entry => text(entry, 64))
    : feature === 'redirects' ? !!entries && entries.length <= 200 && entries.every(entry => wdExact(entry, ['status', 'path', 'target']) && (entry.status === 301 || entry.status === 302) && text(entry.path, 512) && String(entry.path).startsWith('/') && text(entry.target, 2048))
    : false
  if (!valid) throw new Error('invalid_web_directive_model')
  return value as Record<string, unknown>
}
export function readWebDirectivesView(value: unknown, feature: string, domainId: string, accountId: string): WebDirectivesClientView {
  if (!WD_FEATURES.includes(feature) || !WD_UUID.test(accountId) || !wdObject(value) || value.feature !== feature || !wdObject(value.context) || value.context.accountId !== accountId || value.context.domainId !== domainId || typeof value.context.domainName !== 'string' || typeof value.context.engine !== 'string' || typeof value.context.path !== 'string' || value.context.path.startsWith('/') || /[\\\u0000-\u001f]/.test(value.context.path) || value.context.path.split('/').some(part => !part || part === '.' || part === '..') || value.context.path.split('/').at(-1) !== '.htaccess') throw new Error('invalid_web_directive_context')
  const document = value.document, caps = value.capabilities, application = value.application, conflict = value.conflict, validation = value.validation
  if (!wdObject(document) || typeof document.exists !== 'boolean' || typeof document.revision !== 'string' || !WD_REVISION.test(document.revision) || !Number.isSafeInteger(document.sizeBytes) || (document.sizeBytes as number) < 0 || (document.sizeBytes as number) > 65536 || !Number.isSafeInteger(document.unmanagedLines) || (document.unmanagedLines as number) < 0 || !Array.isArray(document.managedFeatures) || document.managedFeatures.some(item => !WD_FEATURES.includes(item as string))) throw new Error('invalid_web_directive_document')
  if (typeof value.managed !== 'boolean' || conflict !== null && !(wdExact(conflict, ['code', 'line']) && typeof conflict.code === 'string' && /^[a-z_]{1,40}$/.test(conflict.code) && Number.isSafeInteger(conflict.line))) throw new Error('invalid_web_directive_conflict')
  if (!wdExact(caps, ['canSave', 'reason']) || typeof caps.canSave !== 'boolean' || caps.reason !== null && (typeof caps.reason !== 'string' || !/^[a-z_]{1,40}$/.test(caps.reason)) || caps.canSave !== (caps.reason === null) || !wdObject(application) || !['read', 'validated', 'saved', 'rolled_back'].includes(String(application.status)) || typeof application.syntaxChecked !== 'boolean' || application.nativeQualified !== false || application.httpStatus !== null && !(Number.isInteger(application.httpStatus) && (application.httpStatus as number) >= 100 && (application.httpStatus as number) <= 599)) throw new Error('invalid_web_directive_status')
  if (validation !== undefined && !(wdObject(validation) && typeof validation.valid === 'boolean' && typeof validation.nativeChecked === 'boolean' && Array.isArray(validation.issues) && validation.issues.length <= 50 && validation.issues.every(issue => wdObject(issue) && Number.isSafeInteger(issue.line) && typeof issue.code === 'string' && /^[a-z_]{1,40}$/.test(issue.code)))) throw new Error('invalid_web_directive_validation')
  if (feature === 'error-pages' ? value.existence !== 'not-checked' : value.existence !== undefined) throw new Error('invalid_web_directive_existence')
  readWebDirectiveModel(feature, value.model)
  return value as unknown as WebDirectivesClientView
}
function wdUncertain(error: unknown): boolean {
  const value = wdObject(error) ? error : {}, detail = wdObject(value.details) ? value.details : {}
  if ([value, detail].some(part => ['stateChanged', 'unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => part[key] === true))) return true
  return value.stateChanged !== false && detail.stateChanged !== false
}
export function createWebDirectivesController(options: {
  feature: string; domainId: string; accountId: string; request(method: string, path: string, body?: unknown): Promise<unknown>
  confirm?: (options: Record<string, unknown>) => Promise<unknown>; admitted: () => boolean; changed?: (state: WebDirectivesClientState) => void
}) {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const state: WebDirectivesClientState = { domainId: options.domainId, view: null, draft: null, dirty: false, busy: false, review: false, status: 'unread', message: '', fields: [] }
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
  const emit = (): void => { state.dirty = !!state.view && !same(state.draft, state.view.model); options.changed?.(state) }
  const note = (status: string, message: string): void => { state.status = status; state.message = message; emit() }
  const path = (): string => '/api/domains/' + encodeURIComponent(state.domainId) + '/web-directives/' + options.feature
  const read = async (): Promise<WebDirectivesClientView> => readWebDirectivesView(await options.request('GET', path()), options.feature, state.domainId, options.accountId)
  const install = (view: WebDirectivesClientView, keepDraft = false): void => { state.view = view; if (!keepDraft) state.draft = JSON.parse(JSON.stringify(view.model)) as Record<string, unknown> }
  async function load(domainId = state.domainId): Promise<void> {
    if (state.busy || !options.admitted() || !WD_UUID.test(domainId)) return
    state.busy = true; emit()
    const previous = state.domainId
    try {
      if ((state.dirty || state.review) && await options.confirm?.({ title: copy('Discard draft and read the saved rules?'), body: copy('The draft is replaced only after a successful fresh read. No previous save is retried.'), confirm: copy('Read saved rules'), danger: true }) !== true) return
      if (!options.admitted()) return
      state.domainId = domainId
      const view = await read(); if (!options.admitted()) return
      install(view); state.review = false; state.fields = []
      note('read', copy('The saved rules were read from the actual file.'))
    } catch { state.domainId = previous; note('failed', copy('The protected rules could not be read. The current draft is kept.')) }
    finally { state.busy = false; emit() }
  }
  function edit(model: Record<string, unknown>): void { if (!state.busy && !state.review && state.view?.capabilities.canSave && options.admitted()) { state.draft = model; state.fields = []; note('draft', copy('Unsaved draft.')) } }
  async function save(): Promise<void> {
    const baseline = state.view, draft = state.draft
    if (!baseline || state.busy || state.review || !baseline.capabilities.canSave || !state.dirty || !options.admitted()) return
    state.busy = true; emit(); let submitted = false
    try {
      if (await options.confirm?.({ title: copy('Save and check the site'), body: baseline.context.domainName + '\n' + copy('Only the xPanel block for this page changes. The current file is kept, validated by the protected Apache parser and the site is checked; a failed check restores the kept file.'), confirm: copy('Confirm') }) !== true) return
      if (!options.admitted()) return
      submitted = true
      const reply = readWebDirectivesView(await options.request('PUT', path(), { expectedRevision: baseline.document.revision, model: draft }), options.feature, state.domainId, options.accountId)
      if (!options.admitted() || reply.context.path !== baseline.context.path) throw { stateChanged: true }
      if (reply.application.status === 'validated') {
        if (!reply.validation || reply.validation.valid || reply.document.revision !== baseline.document.revision) throw new Error('invalid_validation_ack')
        install(reply, true)
        note('invalid', copy('The protected Apache check refused the change. The file is unchanged and your draft is kept.'))
        return
      }
      if (!['saved', 'rolled_back'].includes(reply.application.status) || !reply.application.syntaxChecked) throw new Error('invalid_web_directive_ack')
      const observed = await read()
      if (!options.admitted() || observed.document.revision !== reply.document.revision || !same(observed.model, reply.model)) throw new Error('web_directive_readback_mismatch')
      install(observed, reply.application.status === 'rolled_back')
      // Retain the actual action result alongside the separately read current rules.
      state.view!.application = reply.application
      note(reply.application.status, reply.application.status === 'rolled_back'
        ? copy('The site check failed after saving; the previous file was restored and read back. Your draft is kept.')
        : copy('The rules were saved and read back from the actual file.'))
    } catch (error) {
      const failure = wdObject(error) ? error : {}, details = wdObject(failure.details) ? failure.details : {}
      const fields = failure.status === 422 && details.stateChanged === false && Array.isArray(details.fields) ? (details.fields as unknown[]).filter((item): item is { field: string; code: string } => wdObject(item) && typeof item.field === 'string' && typeof item.code === 'string').slice(0, 100) : []
      if (fields.length) { state.fields = fields; note('fields', copy('Some values were refused. Review the marked fields; nothing was saved.')); return }
      const conflict = failure.status === 409
      state.review = conflict || submitted && wdUncertain(error)
      note(state.review ? conflict ? 'stale' : 'uncertain' : 'failed', state.review
        ? copy('The outcome needs review. The draft is kept and no retry was sent. Read the saved rules before continuing.')
        : copy('The request was refused. The draft is kept and no retry was sent.'))
    } finally { state.busy = false; emit() }
  }
  return { state, load, edit, save }
}

function bindAccountWebDirectives(askDialog: unknown): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const pick = (map: Record<string, string>, code: string, fallback: string): string => { const entry = map[code] ?? fallback; return copy(entry) }
  const FIELD: Record<string, string> = {
    required: msgid('This value is required.'), type: msgid('The value has an unsupported form.'), too_many: msgid('There are too many entries for this page.'),
    duplicate: msgid('This value is already listed.'), code: msgid('Choose one of the listed status codes.'),
    path: msgid('Use a path that starts with / without spaces, quotes, .. segments or a query string.'),
    mime_type: msgid('Use type/subtype with a registered top-level type, for example text/markdown.'), executable_type: msgid('Executable content types are not allowed.'),
    extension: msgid('Use letters and digits only, for example .md.'), executable_extension: msgid('Script extensions such as .php are not allowed.'),
    host: msgid('Use a full host name, for example example.com.'), url: msgid('Use a full http or https address without quotes, spaces or parentheses.'),
    redirect_loop: msgid('This target would redirect back to itself.'), address: msgid('Use an IPv4 or IPv6 address or a CIDR range.'),
    protected_address: msgid('Loopback and all-address ranges cannot be blocked.'), status: msgid('Choose 301 or 302.'), listing: msgid('Choose one of the listed options.'),
    unchanged: msgid('There is no change to save.'), too_large: msgid('The .htaccess file would exceed 64 KiB.'),
  }
  const REASON: Record<string, string> = {
    review_required: msgid('A previous file operation requires inspection in the .htaccess editor. Nothing can be saved here.'),
    engine: msgid('These rules need the Apache web server. This domain is served by another engine.'), inactive: msgid('The domain is not an active file-backed site. Nothing can be saved.'),
    validator: msgid('The protected Apache validation service is unavailable. Nothing can be saved.'), policy: msgid('The reviewed account .htaccess policy does not permit these directives yet. Nothing can be saved.'),
  }
  const CONFLICT: Record<string, string> = {
    marker_malformed: msgid('An xPanel marker line in this file is malformed.'), marker_duplicate: msgid('An xPanel block appears twice in this file.'),
    marker_nested: msgid('An xPanel block starts inside another block.'), marker_unbalanced: msgid('An xPanel block is not closed correctly.'),
    marker_scope: msgid('An xPanel block is inside an Apache section or a continued line.'), block_modified: msgid('The xPanel block for this page was edited by hand.'),
    access_rules_present: msgid('Other access rules in this file would combine with blocked addresses.'), rewrite_disabled: msgid('A RewriteEngine Off line in this file would disable these rules.'),
  }
  document.querySelectorAll<HTMLElement>('[data-web-directives]').forEach(root => {
    if (root.dataset.wdBound === 'true') return
    root.dataset.wdBound = 'true'
    const feature = root.dataset.webDirectives ?? ''
    if (!WD_FEATURES.includes(feature)) return
    const q = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const select = q<HTMLSelectElement>('[data-wd-domain]'), status = q<HTMLElement>('[data-wd-status]'), rows = q<HTMLElement>('[data-wd-rows]'), notice = q<HTMLElement>('[data-wd-notice]'), issues = q<HTMLElement>('[data-wd-issues]')
    const button = (key: string): HTMLButtonElement | null => q<HTMLButtonElement>('[data-wd-' + key + ']')
    const inputs = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-wd-field]')]
    const list = feature !== 'indexes' && feature !== 'hotlink'
    if (!select || !status || !rows || !notice || !issues || ['refresh', 'discard', 'save', ...(list ? ['add', 'clear'] : [])].some(key => !button(key))) return
    const template = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(root, name), tag, slots)
    let redirectTemplates: { row: HTMLTemplateElement; action: HTMLTemplateElement; empty: HTMLTemplateElement; error: HTMLTemplateElement } | null = null
    try {
      if (feature === 'redirects') redirectTemplates = {
        row: clientTemplate(root, 'redirect-row'), action: clientTemplate(root, 'redirect-action'), empty: clientTemplate(root, 'redirect-empty'), error: clientTemplate(root, 'redirect-error'),
      }
      if (redirectTemplates) { cloneClientTemplate(redirectTemplates.row, 'tr', ['status', 'path', 'target', 'actions']); cloneClientTemplate(redirectTemplates.action, 'button', ['label']); cloneClientTemplate(redirectTemplates.empty, 'tr', ['message']); cloneClientTemplate(redirectTemplates.error, 'tr', ['message']) }
      for (const [name, tag, slots] of [['web-directive-notice', 'p', ['message']], ['web-directive-issue', 'li', ['message']], ...(!redirectTemplates ? [['web-directive-row', 'tr', ['actions']], ['web-directive-text-cell', 'td', ['value']], ['web-directive-technical-cell', 'td', ['value']], ['web-directive-action', 'button', ['label']], ['web-directive-error', 'tr', ['message']], ['web-directive-empty', 'tr', ['message']], ['web-directive-summary', 'tr', ['label', 'value']]] : [])] as [string, string, string[]][]) template(name, tag, slots)
    } catch {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button').forEach(control => { control.disabled = true })
      status.dataset.state = 'unavailable'; status.textContent = copy('These protected rules are unavailable here. Nothing was read or changed.'); return
    }
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.wdManage === 'true' && !root.closest(denied)
    const checkbox = (input: Element): input is HTMLInputElement => input instanceof HTMLInputElement && input.type === 'checkbox'
    const values = (): Record<string, string | boolean> => Object.fromEntries(inputs.map(input => [input.dataset.wdField!, checkbox(input) ? input.checked : input.value]))
    const fill = (data: Record<string, unknown>): void => { for (const input of inputs) { const value = data[input.dataset.wdField!]; if (value === undefined) continue; if (checkbox(input)) input.checked = value === true; else input.value = String(value) } }
    const words = (value: unknown): string[] => String(value ?? '').split(/\s+/).filter(Boolean)
    type Entry = Record<string, unknown> | string
    // Per-page form adapters. List pages edit draft entries; settings pages edit the draft directly.
    const adapters: Record<string, { key: (entry: Entry) => string; from: (form: Record<string, string | boolean>) => Entry; to: (entry: Entry) => Record<string, unknown>; cells: (entry: Entry) => [string, boolean][]; required: string[] }> = {
      'error-pages': { key: entry => String((entry as Record<string, unknown>).code), from: form => ({ code: Number(form.code), path: String(form.path).trim() }), to: entry => ({ code: String((entry as Record<string, unknown>).code), path: (entry as Record<string, unknown>).path }), cells: entry => [[String((entry as Record<string, unknown>).code), true], [String((entry as Record<string, unknown>).path), true], [copy('Not checked'), false]], required: ['path'] },
      'mime-types': { key: entry => String((entry as Record<string, unknown>).type), from: form => ({ type: String(form.type).trim(), extensions: words(form.extensions) }), to: entry => ({ type: (entry as Record<string, unknown>).type, extensions: ((entry as Record<string, unknown>).extensions as string[]).join(' ') }), cells: entry => [[String((entry as Record<string, unknown>).type), true], [((entry as Record<string, unknown>).extensions as string[]).join(' '), true]], required: ['type', 'extensions'] },
      'ip-blocker': { key: entry => String(entry), from: form => String(form.address).trim(), to: entry => ({ address: entry }), cells: entry => [[String(entry), true]], required: ['address'] },
      redirects: { key: entry => String((entry as Record<string, unknown>).path), from: form => ({ status: Number(form.status), path: String(form.path).trim(), target: String(form.target).trim() }), to: entry => ({ status: String((entry as Record<string, unknown>).status), path: (entry as Record<string, unknown>).path, target: (entry as Record<string, unknown>).target }), cells: entry => [[String((entry as Record<string, unknown>).status), true], [String((entry as Record<string, unknown>).path), true], [String((entry as Record<string, unknown>).target), true]], required: ['path', 'target'] },
    }
    const settings = (form: Record<string, string | boolean>): Record<string, unknown> => feature === 'indexes' ? { listing: form.listing } : { enabled: form.enabled === true, allowedHosts: words(form.allowedHosts), extensions: words(form.extensions), allowEmptyReferrer: form.allowEmptyReferrer === true, redirectUrl: form.action === 'redirect' ? String(form.redirectUrl).trim() : null }
    const settingsForm = (model: Record<string, unknown>): Record<string, unknown> => feature === 'indexes' ? { listing: model.listing } : { enabled: model.enabled, allowedHosts: (model.allowedHosts as string[]).join('\n'), extensions: (model.extensions as string[]).join(' '), allowEmptyReferrer: model.allowEmptyReferrer, action: model.redirectUrl === null ? 'forbid' : 'redirect', redirectUrl: model.redirectUrl ?? '' }
    const yes = (value: unknown): string => value === true ? copy('Yes') : copy('No')
    const summary = (model: Record<string, unknown>): [string, string, boolean][] => feature === 'indexes'
      ? [[copy('Document root listing'), model.listing === 'enabled' ? copy('Shown') : model.listing === 'disabled' ? copy('Hidden') : copy('Server default'), false]]
      : [[copy('Hotlink protection'), yes(model.enabled), false], [copy('Sites allowed to embed'), (model.allowedHosts as string[]).join(' '), true], [copy('File types'), (model.extensions as string[]).join(' '), true], [copy('Requests with no referrer'), yes(model.allowEmptyReferrer), false], [copy('Blocked requests'), model.redirectUrl === null ? 'HTTP 403' : String(model.redirectUrl), true]]
    let local: { field: string; code: string }[] = []
    const cell = (text: string, technical: boolean): HTMLTableCellElement => { const node = template(technical ? 'web-directive-technical-cell' : 'web-directive-text-cell', 'td', ['value']) as HTMLTableCellElement; clientTemplateSlot(node, 'value').textContent = text; return node }
    const line = (text: string): HTMLParagraphElement => { const node = template('web-directive-notice', 'p', ['message']) as HTMLParagraphElement; clientTemplateSlot(node, 'message').textContent = text; return node }
    const paint = (state: WebDirectivesClientState): void => {
      const view = state.view, blocked = state.busy || state.review || !admitted(), editable = !blocked && !!view?.capabilities.canSave
      root.setAttribute('aria-busy', String(state.busy)); status.textContent = state.message; status.dataset.state = state.status
      status.setAttribute('role', ['failed', 'invalid', 'fields', 'stale', 'uncertain', 'rolled_back'].includes(state.status) ? 'alert' : 'status')
      select.disabled = state.busy || !admitted(); if (select.value !== state.domainId) select.value = state.domainId
      for (const [key, text] of [['path', view?.context.path ?? copy(msgctxt('account-web-directives-client', 'Not read'))], ['managed', view ? view.document.managedFeatures.join(' ') || copy('None') : copy(msgctxt('account-web-directives-client', 'Not read'))], ['http', view?.application.httpStatus ? 'HTTP ' + String(view.application.httpStatus) : copy('Not checked')]] as const) { const node = q<HTMLElement>('[data-wd-' + key + ']'); if (node) node.textContent = text }
      notice.textContent = ''
      if (view?.application.status === 'rolled_back') notice.append(line(view.application.httpStatus === null ? copy('The site check returned no answer after saving. The previous file was restored automatically and read back.') : copy('The site check returned HTTP {status} after saving. The previous file was restored automatically and read back.', { status: view.application.httpStatus })))
      if (view?.capabilities.reason === 'conflict' && view.conflict) notice.append(line(pick(CONFLICT, view.conflict.code, msgid('The managed block requires review.')) + ' ' + copy('Line {line}. Review it in the .htaccess editor; nothing can be saved here until then.', { line: view.conflict.line })))
      else if (view?.capabilities.reason) notice.append(line(pick(REASON, view.capabilities.reason, msgid('Saving is unavailable for this domain.'))))
      if (view && view.document.unmanagedLines > 0) notice.append(line(copy('This .htaccess file also has {count} lines that this page does not manage. They are kept unchanged.', { count: view.document.unmanagedLines })))
      notice.hidden = !notice.childElementCount
      const known = new Set<string>(), errors = [...local, ...state.fields]
      rows.textContent = ''
      const draft = state.draft
      if (list) {
        const entries = (draft?.entries ?? []) as Entry[], adapter = adapters[feature]!
        entries.forEach((entry, index) => {
          const row = redirectTemplates ? cloneClientTemplate(redirectTemplates.row, 'tr', ['status', 'path', 'target', 'actions']) : template('web-directive-row', 'tr', ['actions'])
          if (redirectTemplates) { const value = entry as Record<string, unknown>; for (const slot of ['status', 'path', 'target'] as const) clientTemplateSlot(row, slot).textContent = String(value[slot]) }
          else for (const [text, technical] of adapter.cells(entry)) row.insertBefore(cell(text, technical), clientTemplateSlot(row, 'actions'))
          const actions = clientTemplateSlot(row, 'actions', 'td')
          for (const [label, run] of [[copy('Edit'), () => { fill(adapter.to(entry)); local = []; inputs[0]?.focus() }], [copy('Remove'), () => controller.edit({ ...draft, entries: entries.filter((_item, position) => position !== index) })]] as const) {
            const action = (redirectTemplates ? cloneClientTemplate(redirectTemplates.action, 'button', ['label']) : template('web-directive-action', 'button', ['label'])) as HTMLButtonElement; clientTemplateSlot(action, 'label').textContent = label; action.disabled = !editable; action.addEventListener('click', run); actions.append(action)
          }
          rows.append(row)
          const rowErrors = errors.filter(item => item.field === 'entries.' + index || item.field.startsWith('entries.' + index + '.'))
          if (rowErrors.length) {
            rowErrors.forEach(item => known.add(item.field))
            const errorRow = redirectTemplates ? cloneClientTemplate(redirectTemplates.error, 'tr', ['message']) : template('web-directive-error', 'tr', ['message']), errorCell = clientTemplateSlot(errorRow, 'message', 'td') as HTMLTableCellElement; if (!redirectTemplates) errorCell.colSpan = adapter.cells(entry).length + 1; errorCell.textContent = rowErrors.map(item => pick(FIELD, item.code, FIELD.type!)).join(' '); rows.append(errorRow)
          }
        })
        if (!entries.length) { const row = redirectTemplates ? cloneClientTemplate(redirectTemplates.empty, 'tr', ['message']) : template('web-directive-empty', 'tr', ['message']), empty = clientTemplateSlot(row, 'message', 'td') as HTMLTableCellElement; if (!redirectTemplates) empty.colSpan = rows.closest('table')?.querySelectorAll('th').length ?? 1; empty.textContent = view ? copy('No rules are managed for this domain yet.') : copy('The current rules have not been read.'); rows.append(row) }
      } else if (view) {
        for (const [label, text, technical] of summary(view.model)) { const row = template('web-directive-summary', 'tr', ['label', 'value']); clientTemplateSlot(row, 'label').textContent = label; const value = clientTemplateSlot(row, 'value'); value.textContent = text; value.dir = technical ? 'ltr' : 'auto'; rows.append(row) }
        if (draft && JSON.stringify(settings(values())) !== JSON.stringify(draft)) fill(settingsForm(draft))
      }
      for (const node of root.querySelectorAll<HTMLElement>('[data-wd-error-for]')) {
        const name = node.dataset.wdErrorFor!, own = errors.filter(item => !list || local.includes(item) ? item.field === name || item.field.startsWith(name + '.') : false)
        own.forEach(item => known.add(item.field))
        node.textContent = own.map(item => pick(FIELD, item.code, FIELD.type!)).join(' '); node.hidden = !own.length
        const control = inputs.find(input => input.dataset.wdField === name); if (control) control.setAttribute('aria-invalid', String(own.length > 0))
      }
      for (const input of inputs) input.disabled = !editable
      button('refresh')!.disabled = state.busy || !admitted(); button('discard')!.disabled = state.busy || !admitted() || !state.dirty && !state.review
      button('save')!.disabled = !editable || !state.dirty
      if (list) { button('add')!.disabled = !editable; button('clear')!.disabled = !editable }
      issues.textContent = ''
      const messages = [...(state.status === 'invalid' ? (view?.validation?.issues ?? []).map(issue => copy('Line {line}: refused by the protected check ({code})', { line: issue.line, code: issue.code })) : []),
        ...errors.filter(item => !known.has(item.field)).map(item => pick(FIELD, item.code, FIELD.type!))]
      for (const text of messages.length ? messages : [view ? copy('No refusals were reported for the last request.') : copy('Diagnostics have not been read.')]) { const item = template('web-directive-issue', 'li', ['message']); clientTemplateSlot(item, 'message').textContent = text; issues.append(item) }
    }
    const controller = createWebDirectivesController({ feature, domainId: select.value, accountId: root.dataset.wdAccount ?? '', admitted, changed: paint,
      request: (method, path, body) => { if (!transport || !admitted()) return Promise.reject({ stateChanged: false }); return body === undefined ? transport(method, path) : transport(method, path, body) },
      confirm: typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : undefined })
    if (!transport || !admitted() || !WD_UUID.test(select.value)) {
      root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(control => { control.disabled = true })
      status.textContent = copy('These protected rules are unavailable here. Nothing was read or changed.'); status.dataset.state = 'unavailable'; return
    }
    select.addEventListener('change', () => { const id = select.value; select.value = controller.state.domainId; void controller.load(id) })
    button('refresh')!.addEventListener('click', () => { void controller.load() }); button('discard')!.addEventListener('click', () => { void controller.load() }); button('save')!.addEventListener('click', () => { void controller.save() })
    if (list) {
      const adapter = adapters[feature]!
      button('add')!.addEventListener('click', () => {
        const form = values(), draft = controller.state.draft
        local = adapter.required.filter(name => !String(form[name] ?? '').trim()).map(name => ({ field: name, code: 'required' }))
        if (local.length || !draft) { paint(controller.state); return }
        const entry = adapter.from(form), entries = [...(draft.entries as Entry[])], index = entries.findIndex(item => adapter.key(item) === adapter.key(entry))
        if (index >= 0) entries[index] = entry; else entries.push(entry)
        controller.edit({ ...draft, entries })
      })
      button('clear')!.addEventListener('click', () => { for (const input of inputs) { if (checkbox(input)) input.checked = false; else if (input instanceof HTMLSelectElement) input.selectedIndex = 0; else input.value = '' } local = []; paint(controller.state) })
    } else for (const input of inputs) input.addEventListener(checkbox(input) || input instanceof HTMLSelectElement ? 'change' : 'input', () => {
      const form = values()
      local = feature === 'hotlink' && form.action === 'redirect' && !String(form.redirectUrl).trim() ? [{ field: 'redirectUrl', code: 'required' }] : []
      controller.edit(settings(form))
    })
    window.addEventListener('beforeunload', event => { if (controller.state.dirty || controller.state.review) { event.preventDefault(); event.returnValue = '' } })
    void controller.load()
  })
}
export const ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const WD_FEATURES=${JSON.stringify(WD_FEATURES)};const WD_UUID=${WD_UUID.toString()};const WD_REVISION=${WD_REVISION.toString()};const wdObject=${wdObject.toString()};const wdExact=${wdExact.toString()};const readWebDirectiveModel=${readWebDirectiveModel.toString()};const readWebDirectivesView=${readWebDirectivesView.toString()};const wdUncertain=${wdUncertain.toString()};const createWebDirectivesController=${createWebDirectivesController.toString()};return ${bindAccountWebDirectives.toString()};})()`
