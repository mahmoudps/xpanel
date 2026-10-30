import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

export interface HtaccessClientView {
  context: { accountId: string; domainId: string; domainName: string; path: string; engine: string; phpHandler: string }
  document: { exists: boolean; content: string; sizeBytes: number; mtime: string | null; revision: string }
  versions: { id: string; at: string; actor: string; sizeBytes: number; revision: string; state: string; current: boolean; canRestore: boolean }[]
  capabilities: { canValidate: boolean; canSave: boolean; canRestore: boolean; canMigrate: boolean; reason: string | null }
  application: { status: string; nativeQualified: false; syntaxChecked: boolean; httpStatus: number | null }
  policy: { valid: boolean; issues: { line: number; code: string; message: string; key?: string; value?: string }[]; phpLines: { line: number; key?: string; value?: string }[] }
  validation?: { valid: boolean; nativeChecked: boolean; issues: { line: number; code: string; message: string }[] }
  phpRevision?: string
  migration?: { phpRevision: string; keys: string[]; status: 'applied' | 'restored' }
  reviewRequired: boolean
}
export interface HtaccessClientState { domainId: string; view: HtaccessClientView | null; draft: string; dirty: boolean; busy: boolean; review: boolean; status: string; message: string }
const HTACCESS_UI_BYTES = 64 * 1024
const HTACCESS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HTACCESS_REVISION = /^[0-9a-f]{64}$/
const htaccessObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function readHtaccessView(value: unknown, domainId: string, accountId: string): HtaccessClientView {
  if (!HTACCESS_UUID.test(accountId) || !htaccessObject(value) || !htaccessObject(value.context) || value.context.domainId !== domainId || value.context.accountId !== accountId || typeof value.context.domainName !== 'string' || typeof value.context.path !== 'string' || value.context.path.startsWith('/') || /[\\\u0000-\u001f]/.test(value.context.path) || value.context.path.split('/').some(part => !part || part === '.' || part === '..') || value.context.path.split('/').at(-1) !== '.htaccess') throw new Error('invalid_htaccess_context')
  const document = value.document, caps = value.capabilities, application = value.application, policy = value.policy
  if (!htaccessObject(document) || typeof document.exists !== 'boolean' || typeof document.content !== 'string' || !document.content.isWellFormed() || new TextEncoder().encode(document.content).length !== document.sizeBytes || (document.sizeBytes as number) > HTACCESS_UI_BYTES || typeof document.revision !== 'string' || !HTACCESS_REVISION.test(document.revision) || document.exists && (typeof document.mtime !== 'string' || !Number.isFinite(Date.parse(document.mtime))) || !document.exists && (document.content !== '' || document.mtime !== null)) throw new Error('invalid_htaccess_document')
  if (!htaccessObject(caps) || ['canValidate', 'canSave', 'canRestore', 'canMigrate'].some(key => typeof caps[key] !== 'boolean') || !htaccessObject(application) || !['read', 'validated', 'saved', 'restored', 'rolled_back'].includes(String(application.status)) || application.nativeQualified !== false || typeof application.syntaxChecked !== 'boolean' || typeof value.reviewRequired !== 'boolean' || !htaccessObject(policy) || typeof policy.valid !== 'boolean' || !Array.isArray(policy.issues) || !Array.isArray(policy.phpLines)) throw new Error('invalid_htaccess_status')
  if (!Array.isArray(value.versions) || value.versions.length > 30 || value.versions.some(row => !htaccessObject(row) || typeof row.id !== 'string' || !HTACCESS_UUID.test(row.id) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || typeof row.actor !== 'string' || !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 0 || typeof row.canRestore !== 'boolean' || typeof row.current !== 'boolean')) throw new Error('invalid_htaccess_versions')
  if (value.validation !== undefined && (!htaccessObject(value.validation) || typeof value.validation.valid !== 'boolean' || typeof value.validation.nativeChecked !== 'boolean' || !Array.isArray(value.validation.issues) || value.validation.valid && !value.validation.nativeChecked)) throw new Error('invalid_htaccess_validation')
  return value as unknown as HtaccessClientView
}
function htaccessUncertain(error: unknown): boolean {
  const value = htaccessObject(error) ? error : {}, detail = htaccessObject(value.details) ? value.details : {}
  if ([value, detail].some(part => ['stateChanged', 'unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => part[key] === true))) return true
  return value.stateChanged !== false && detail.stateChanged !== false
}
export function createHtaccessController(options: {
  domainId: string; accountId: string; request(method: string, path: string, body?: unknown): Promise<unknown>
  confirm?: (options: Record<string, unknown>) => Promise<unknown>; admitted: () => boolean
  changed?: (state: HtaccessClientState) => void
}) {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  const state: HtaccessClientState = { domainId: options.domainId, view: null, draft: '', dirty: false, busy: false, review: false, status: 'unread', message: '' }
  const emit = (): void => { state.dirty = !!state.view && state.draft !== state.view.document.content; options.changed?.(state) }
  const note = (status: string, message: string): void => { state.status = status; state.message = message; emit() }
  const path = (): string => '/api/domains/' + encodeURIComponent(state.domainId) + '/htaccess'
  const read = async (): Promise<HtaccessClientView> => readHtaccessView(await options.request('GET', path()), state.domainId, options.accountId)
  const checkDraft = (): void => { if (!state.draft.isWellFormed() || new TextEncoder().encode(state.draft).length > HTACCESS_UI_BYTES) throw { stateChanged: false } }
  const install = (view: HtaccessClientView, keepDraft = false): void => { state.view = view; if (!keepDraft) state.draft = view.document.content; state.review = view.reviewRequired }
  async function load(domainId = state.domainId): Promise<void> {
    if (state.busy || !options.admitted() || !HTACCESS_UUID.test(domainId)) return
    state.busy = true; emit()
    const previous = state.domainId
    try {
      if ((state.dirty || state.review) && await options.confirm?.({ title: copy('Discard draft and read the saved file?'), body: copy('The draft is replaced only after a successful fresh read. No previous write is retried.'), confirm: copy('Read saved file'), danger: true }) !== true) return
      if (!options.admitted()) return
      state.domainId = domainId
      const view = await read(); if (!options.admitted()) return; install(view)
      note(view.reviewRequired ? 'uncertain' : 'read', view.capabilities.reason ?? copy('The actual file and kept versions were read.'))
    } catch { state.domainId = previous; note('failed', copy('The protected file could not be read. The current draft is kept.')) }
    finally { state.busy = false; emit() }
  }
  function edit(content: string): void { if (!state.busy && !state.review && state.view?.capabilities.canSave && options.admitted()) { state.draft = content; note('draft', copy('Unsaved draft.')) } }
  async function run(operation: 'validate' | 'save' | 'restore' | 'migrate-php', versionId?: string): Promise<void> {
    const baseline = state.view
    if (!baseline || state.busy || state.review || !options.admitted()) return
    if (operation === 'validate' ? !baseline.capabilities.canValidate : operation === 'restore' ? !baseline.capabilities.canRestore : operation === 'migrate-php' ? !baseline.capabilities.canMigrate : !baseline.capabilities.canSave || !state.dirty) return
    const version = operation === 'restore' ? baseline.versions.find(item => item.id === versionId && item.canRestore) : null
    if (operation === 'restore' && !version) return
    if (operation === 'migrate-php' && (!baseline.phpRevision || !HTACCESS_REVISION.test(baseline.phpRevision))) { note('failed', copy('The current PHP configuration revision has not been read. Nothing was sent.')); return }
    const content = state.draft
    try { checkDraft() } catch { note('failed', copy('The editor accepts well-formed UTF-8 within 64 KiB. Nothing was sent.')); return }
    state.busy = true; emit(); let submitted = false
    try {
      if (operation !== 'validate' && await options.confirm?.({ title: operation === 'restore' ? copy('Restore kept file') : operation === 'migrate-php' ? copy('Move PHP settings and save') : copy('Save and check the site'), body: baseline.context.domainName + (version ? '\n' + formatDisplayDateTime(version.at) : '') + '\n' + copy('The current file is kept. The protected backend validates the candidate, writes it and checks the site; a failed check triggers guarded restoration.'), confirm: copy('Confirm'), danger: operation === 'restore' }) !== true) return
      if (!options.admitted()) return
      const body = operation === 'restore' ? { versionId, expectedRevision: baseline.document.revision } : operation === 'migrate-php' ? { content, expectedRevision: baseline.document.revision, expectedPhpRevision: baseline.phpRevision } : { content, expectedRevision: baseline.document.revision }
      submitted = operation !== 'validate'
      const reply = readHtaccessView(await options.request(operation === 'save' ? 'PUT' : 'POST', path() + (operation === 'restore' ? '/restore' : operation === 'migrate-php' ? '/migrate-php' : ''), body), state.domainId, options.accountId)
      if (!options.admitted() || reply.context.path !== baseline.context.path) throw { stateChanged: submitted }
      if (operation === 'validate' || reply.application.status === 'validated') {
        if (!reply.validation || reply.document.revision !== baseline.document.revision) throw new Error('invalid_validation_ack')
        install(reply, true)
        note(reply.validation.valid ? 'validated' : 'invalid', reply.validation.valid ? copy('This draft passed the protected Apache parser. The file has not been saved.') : copy('The draft was refused. Review the reported lines; the file is unchanged.'))
        return
      }
      if (!['saved', 'restored', 'rolled_back'].includes(reply.application.status) || !reply.application.syntaxChecked || operation === 'save' && reply.application.status === 'saved' && (!reply.document.exists || reply.document.content !== content)) throw new Error('invalid_file_ack')
      if (operation === 'migrate-php' && (!reply.migration || !HTACCESS_REVISION.test(reply.migration.phpRevision))) throw new Error('unverified_php_migration')
      const observed = await read()
      if (!options.admitted() || JSON.stringify(observed.document) !== JSON.stringify(reply.document)) throw new Error('file_readback_mismatch')
      install(observed, reply.application.status === 'rolled_back')
      // Retain the actual action result alongside the separately checked current file.
      state.view!.application = reply.application
      note(reply.application.status, reply.application.status === 'rolled_back'
        ? copy('The site check failed; the kept file was restored and read back. Your draft is kept.')
        : copy('The actual file was saved and read back. The local site check is shown below.'))
    } catch (error) {
      const conflict = htaccessObject(error) && error.status === 409
      state.review = conflict || submitted && htaccessUncertain(error)
      note(state.review ? conflict ? 'stale' : 'uncertain' : 'failed', state.review
        ? copy('The outcome needs review. The draft is kept and no retry was sent. Read the saved file before continuing.')
        : copy('The request was refused. The draft is kept and no retry was sent.'))
    } finally { state.busy = false; emit() }
  }
  return { state, load, edit, validate: () => run('validate'), save: () => run('save'), restore: (id: string) => run('restore', id), migratePhp: () => run('migrate-php') }
}

function bindAccountHtaccess(askDialog: unknown): void {
  const copy = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-htaccess-workspace]').forEach(root => {
    if (root.dataset.htaccessBound === 'true') return
    root.dataset.htaccessBound = 'true'
    const select = root.querySelector<HTMLSelectElement>('[data-htaccess-domain]')!, editor = root.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!, status = root.querySelector<HTMLElement>('[data-htaccess-status]')!
    const history = root.querySelector<HTMLElement>('[data-htaccess-versions]')!, issues = root.querySelector<HTMLElement>('[data-htaccess-issues]')!
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.htaccessManage === 'true' && !root.closest(denied)
    const button = (key: string): HTMLButtonElement => root.querySelector<HTMLButtonElement>('[data-htaccess-' + key + ']')!
    if (!select || !editor || !status || !history || !issues || ['refresh', 'validate', 'save', 'migrate', 'discard', 'insert'].some(key => !button(key))) return
    const template = (name: string, tag: string, slots: readonly string[]): HTMLElement => cloneClientTemplate(clientTemplate(root, name), tag, slots)
    try {
      for (const [name, tag, slots] of [['htaccess-php-row', 'tr', ['directive', 'value', 'compatibility']], ['htaccess-empty-php', 'tr', ['message']], ['htaccess-issue', 'li', ['message']], ['htaccess-version', 'tr', ['time', 'actor', 'size', 'state', 'restore']], ['htaccess-empty-versions', 'tr', ['message']]] as const) template(name, tag, slots)
      clientTemplateSlot(template('htaccess-version', 'tr', ['restore']), 'restore', 'button')
      clientTemplateSlot(template('htaccess-version', 'tr', ['time']), 'time', 'time')
      for (const slot of ['directive', 'value']) clientTemplateSlot(template('htaccess-php-row', 'tr', [slot]), slot, 'bdi')
    } catch {
      root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(control => { control.disabled = true }); editor.readOnly = true
      status.dataset.state = 'unavailable'; status.textContent = copy('The protected .htaccess workspace is unavailable here. Nothing was read or changed.'); return
    }
    const controller = createHtaccessController({ domainId: select.value, accountId: root.dataset.htaccessAccount ?? '', request: (method, path, body) => { if (!transport || !admitted()) return Promise.reject({ stateChanged: false }); return body === undefined ? transport(method, path) : transport(method, path, body) }, admitted,
      confirm: typeof askDialog === 'function' ? askDialog as (options: Record<string, unknown>) => Promise<unknown> : undefined,
      changed: state => {
        const view = state.view, blocked = state.busy || state.review || !admitted()
        root.setAttribute('aria-busy', String(state.busy)); status.textContent = state.message; status.dataset.state = state.status
        status.setAttribute('role', ['failed', 'invalid', 'stale', 'uncertain', 'rolled_back'].includes(state.status) ? 'alert' : 'status')
        select.disabled = state.busy || !admitted(); if (select.value !== state.domainId) select.value = state.domainId
        editor.readOnly = blocked || !view?.capabilities.canSave
        if (editor.value !== state.draft) editor.value = state.draft
        button('refresh').disabled = state.busy || !admitted()
        button('validate').disabled = blocked || !view?.capabilities.canValidate
        button('save').disabled = blocked || !view?.capabilities.canSave || !state.dirty
        button('migrate').disabled = blocked || !view?.capabilities.canMigrate || !/^\s*php_(?:value|flag)\b/im.test(state.draft) || !view.phpRevision
        const phpSource = state.draft.split(/\r\n|\n|\r/).map((text, index) => ({ text, line: index + 1 })).filter(row => /^\s*php_(?:value|flag)\b/i.test(row.text))
        const phpRows = phpSource.map(row => ({ ...row, match: /^\s*(php_(?:value|flag))\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(.+?)\s*$/i.exec(row.text) }))
        const seenKeys = new Set<string>()
        const literal = phpRows.every(row => {
          const key = row.match?.[2], rawValue = row.match?.[3]
          if (!key || !rawValue || seenKeys.has(key) || !/^(?:"[^"\\]*"|'[^'\\]*'|[^\s"'\\]+)$/.test(rawValue)) return false
          seenKeys.add(key); return true
        })
        // Source previews hold only directives; status sentences stay outside the code panel.
        const preview = (name: 'before' | 'after', source: string | null, message: string): void => {
          const panel = root.querySelector<HTMLElement>('[data-htaccess-php-' + name + ']'), note = root.querySelector<HTMLElement>('[data-htaccess-php-' + name + '-note]')
          if (panel) { panel.textContent = source ?? ''; panel.hidden = source === null }
          if (note) { note.textContent = source === null ? message : ''; note.hidden = source !== null }
        }
        preview('before', phpSource.length ? phpSource.map(row => row.text).join('\n') : null, copy('No PHP directives in the current draft.'))
        preview('after', phpSource.length && literal ? phpRows.map(row => row.match![2] + ' = ' + row.match![3]!.replace(/^(['"])(.*)\1$/, '$2')).join('\n') : null, !phpSource.length ? copy('No PHP settings to move.') : copy('These PHP lines need manual review before a preview can be made.'))
        const compatibility = root.querySelector<HTMLElement>('[data-htaccess-php-rows]')
        if (compatibility) {
          compatibility.textContent = ''
          for (const item of phpRows) {
            const row = template('htaccess-php-row', 'tr', ['directive', 'value', 'compatibility'])
            clientTemplateSlot(row, 'directive').textContent = item.match ? item.match[1] + ' ' + item.match[2] : item.text
            clientTemplateSlot(row, 'value').textContent = item.match?.[3] ?? copy('Needs review')
            clientTemplateSlot(row, 'compatibility').textContent = copy('Requires guarded domain PHP configuration.')
            compatibility.append(row)
          }
          if (!phpRows.length) { const row = template('htaccess-empty-php', 'tr', ['message']); clientTemplateSlot(row, 'message').textContent = copy('No PHP directives in the current draft.'); compatibility.append(row) }
        }
        button('discard').disabled = state.busy || !admitted() || !state.dirty && !state.review
        button('insert').disabled = blocked || !view?.capabilities.canSave
        const path = root.querySelector<HTMLElement>('[data-htaccess-path]'), check = root.querySelector<HTMLElement>('[data-htaccess-http]')
        if (path) path.textContent = view?.context.path ?? copy(msgctxt('account-htaccess-client', 'Not read'))
        if (check) check.textContent = view?.application.httpStatus === null || !view ? copy('Not checked') : 'HTTP ' + String(view.application.httpStatus)
        const gutter = root.querySelector<HTMLElement>('[data-htaccess-gutter]')
        if (gutter) gutter.textContent = state.draft.split(/\r\n|\n|\r/).map((_line, index) => String(index + 1)).join('\n')
        const count = root.querySelector<HTMLElement>('[data-htaccess-lines]'); if (count) count.textContent = String(state.draft.split(/\r\n|\n|\r/).length)
        issues.textContent = ''
        const diagnostics = state.status === 'draft' ? [] : view?.validation?.issues ?? view?.policy.issues ?? []
        for (const issue of diagnostics) { const item = template('htaccess-issue', 'li', ['message']); clientTemplateSlot(item, 'message').textContent = copy('Line {line}: {message}', { line: issue.line, message: issue.message }); issues.append(item) }
        if (!diagnostics.length) { const item = template('htaccess-issue', 'li', ['message']); clientTemplateSlot(item, 'message').textContent = state.status === 'draft' ? copy('The current draft has not been validated. Validate it before saving.') : view ? copy('No policy issues were reported for the last checked content. Validate the current draft before saving.') : copy('Diagnostics have not been read.'); issues.append(item) }
        history.textContent = ''
        for (const version of view?.versions ?? []) {
          const row = template('htaccess-version', 'tr', ['time', 'actor', 'size', 'state', 'restore'])
          const time = clientTemplateSlot(row, 'time', 'time') as HTMLTimeElement
          time.dateTime = version.at; time.textContent = formatDisplayDateTime(version.at)
          clientTemplateSlot(row, 'actor').textContent = version.actor
          clientTemplateSlot(row, 'size').textContent = String(version.sizeBytes)
          clientTemplateSlot(row, 'state').textContent = version.current ? copy(msgctxt('account-htaccess-client', 'Current')) : version.state === 'failed' ? copy('Check failed; kept') : copy('Kept')
          const restore = clientTemplateSlot(row, 'restore', 'button') as HTMLButtonElement
          restore.textContent = copy('Restore'); restore.disabled = blocked || !version.canRestore
          restore.addEventListener('click', () => { void controller.restore(version.id) }); history.append(row)
        }
        if (!view?.versions.length) { const row = template('htaccess-empty-versions', 'tr', ['message']); clientTemplateSlot(row, 'message').textContent = view ? copy('No kept versions were returned. The first save preserves the current file.') : copy('Kept versions have not been read.'); history.append(row) }
      } })
    if (!transport || !admitted() || !HTACCESS_UUID.test(select.value)) {
      root.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(control => { control.disabled = true }); editor.readOnly = true
      status.textContent = copy('The protected .htaccess workspace is unavailable here. Nothing was read or changed.'); status.dataset.state = 'unavailable'; return
    }
    select.addEventListener('change', () => { const id = select.value; select.value = controller.state.domainId; void controller.load(id) })
    editor.addEventListener('input', () => controller.edit(editor.value))
    editor.addEventListener('scroll', () => { const gutter = root.querySelector<HTMLElement>('[data-htaccess-gutter]'); if (gutter) gutter.scrollTop = editor.scrollTop })
    button('refresh').addEventListener('click', () => { void controller.load() }); button('discard').addEventListener('click', () => { void controller.load() })
    button('validate').addEventListener('click', () => { void controller.validate() }); button('save').addEventListener('click', () => { void controller.save() }); button('migrate').addEventListener('click', () => { void controller.migratePhp() })
    button('insert').addEventListener('click', () => {
      if (button('insert').disabled) return
      const preset = root.querySelector<HTMLSelectElement>('[data-htaccess-preset]')?.value
      const snippets: Record<string, string> = { wordpress: '<IfModule mod_rewrite.c>\nRewriteEngine On\nRewriteBase /\nRewriteRule ^index\\.php$ - [L]\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n</IfModule>\n', https: 'RewriteEngine On\nRewriteCond %{HTTP:X-Forwarded-Proto} !=https\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]\n', private: '<FilesMatch "^(wp-config\\.php|\\.user\\.ini|readme\\.html)$">\nRequire all denied\n</FilesMatch>\n' }
      if (!preset || !snippets[preset]) return
      editor.setRangeText(snippets[preset], editor.selectionStart, editor.selectionEnd, 'end'); controller.edit(editor.value); editor.focus()
    })
    window.addEventListener('beforeunload', event => { if (controller.state.dirty || controller.state.review) { event.preventDefault(); event.returnValue = '' } })
    void controller.load()
  })
}
export const ACCOUNT_HTACCESS_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const HTACCESS_UI_BYTES=${HTACCESS_UI_BYTES};const HTACCESS_UUID=${HTACCESS_UUID.toString()};const HTACCESS_REVISION=${HTACCESS_REVISION.toString()};const htaccessObject=${htaccessObject.toString()};const readHtaccessView=${readHtaccessView.toString()};const htaccessUncertain=${htaccessUncertain.toString()};const createHtaccessController=${createHtaccessController.toString()};return ${bindAccountHtaccess.toString()};})()`
