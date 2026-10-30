import type { MessageValues } from './i18n.ts'
import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
import { COMPOSE_ATTACHMENT_LIMITS, type ComposeAttachmentPayload } from '@xpanel/core'

// A local binding keeps serialized functions independent of bundler import rewriting.
const composeAttachmentLimits = COMPOSE_ATTACHMENT_LIMITS

interface ComposeAttachmentState {
  readonly pending: boolean
  readonly error: string | null
  readonly files: readonly ComposeAttachmentPayload[]
}
type ComposeAttachmentGroup = HTMLElement & {
  xpanelReadComposeAttachments?: (requestPayload?: Readonly<Record<string, unknown>>) => readonly ComposeAttachmentPayload[]
}

/** The one collector used by the installed per-form Send and Save draft hook. */
export function readComposeAttachmentPayload(group: ComposeAttachmentGroup, requestPayload?: Readonly<Record<string, unknown>>, stateReader?: () => ComposeAttachmentState): readonly ComposeAttachmentPayload[] {
  if (!stateReader) {
    if (typeof group.xpanelReadComposeAttachments !== 'function') throw new Error('ATTACHMENTS_UNBOUND')
    return group.xpanelReadComposeAttachments(requestPayload)
  }
  const state = stateReader(), limits = composeAttachmentLimits
  if (state.pending) throw new Error('ATTACHMENTS_PENDING')
  if (state.error) throw new Error('ATTACHMENTS_INVALID')
  if (state.files.length > limits.maxFiles) throw new Error('ATTACHMENT_COUNT')
  const encoder = new TextEncoder(), payload: ComposeAttachmentPayload[] = []
  let total = 0
  for (const file of state.files) {
    const { filename, contentType, contentBase64 } = file
    if (!filename || filename !== filename.trim() || filename === '.' || filename === '..' ||
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\\/:*?"<>|]/u.test(filename) ||
      encoder.encode(filename).byteLength > limits.maxFilenameBytes || new TextDecoder().decode(encoder.encode(filename)) !== filename) throw new Error('ATTACHMENT_FILENAME')
    if (contentType.length > limits.maxContentTypeLength || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) throw new Error('ATTACHMENT_CONTENT_TYPE')
    if (contentBase64.length > 4 * Math.ceil(limits.maxDecodedBytes / 3) || contentBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw new Error('ATTACHMENT_ENCODING')
    const decoded = atob(contentBase64)
    if (btoa(decoded) !== contentBase64) throw new Error('ATTACHMENT_ENCODING')
    total += decoded.length
    if (total > limits.maxDecodedBytes) throw new Error('ATTACHMENT_SIZE')
    payload.push(Object.freeze({ filename, contentType, contentBase64 }))
  }
  let serialized: string
  try { serialized = JSON.stringify({ ...requestPayload, attachments: payload }) }
  catch { throw new Error('COMPOSE_REQUEST_INVALID') }
  if (encoder.encode(serialized).byteLength > limits.maxRequestBytes) throw new Error('COMPOSE_REQUEST_TOO_LARGE')
  return Object.freeze(payload)
}

/** Owns only real selected-file state; message body/recipients remain in the shared collector. */
export function bindMailComposeAttachments(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  const digits = (value: string) => value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) <= 0x0669 ? 0x0660 : 0x06f0)))
  document.querySelectorAll<ComposeAttachmentGroup>('[data-compose-form="true"]').forEach(group => {
    const root = group.querySelector<HTMLElement>('[data-compose-attachments]')
    if (!root || root.dataset.composeAttachmentsBound === 'true') return
    const opener = root.querySelector<HTMLButtonElement>('[data-compose-attachment-open]')
    const input = root.querySelector<HTMLInputElement>('[data-compose-attachment-input]')
    const list = root.querySelector<HTMLElement>('[data-compose-attachment-list]')
    const status = root.querySelector<HTMLElement>('[data-compose-attachment-status]')
    const summary = root.querySelector<HTMLElement>('[data-compose-attachment-summary]')
    if (!opener || !input || !list || !status || input.type !== 'file' || Object.prototype.hasOwnProperty.call(group, 'xpanelReadComposeAttachments')) return
    try { mailRequireTemplates(root, [['mail-compose-attachment-row', 'li', ['name', 'size', 'remove']], ['mail-compose-attachment-dismiss', 'button', ['label']]]) }
    catch { opener.disabled = true; input.disabled = true; status.textContent = t('Attachments are unavailable here.'); return }
    root.dataset.composeAttachmentsBound = 'true'
    const state = { pending: false, error: null as string | null, files: [] as readonly ComposeAttachmentPayload[] }
    let generation = 0
    const mailbox = group.dataset.composeMailbox ?? ''
    const enabled = () => Boolean(mailbox) && group.dataset.composeMailbox === mailbox && root.dataset.composeAttachmentEnabled === 'true'
    const sending = () => group.querySelector<HTMLElement>('[data-mail-send]')?.dataset.mailSendBusy === 'true'
    const immutableSnapshot = (requestPayload?: Readonly<Record<string, unknown>>) => {
      if (!enabled()) throw new Error('ATTACHMENTS_UNAVAILABLE')
      return readComposeAttachmentPayload(group, requestPayload, () => state)
    }
    Object.defineProperty(group, 'xpanelReadComposeAttachments', { value: immutableSnapshot, writable: false, configurable: false, enumerable: false })
    const updateControls = () => {
      const blocked = !enabled() || sending() || state.pending
      opener.disabled = blocked; input.disabled = blocked
      root.querySelectorAll<HTMLButtonElement>('[data-compose-attachment-remove],[data-compose-attachment-dismiss]').forEach(button => { button.disabled = blocked })
      root.setAttribute('aria-busy', state.pending ? 'true' : 'false')
    }
    const announce = () => {
      status.replaceChildren()
      const message = document.createElement('span')
      message.textContent = !enabled() ? t('Attachments are unavailable here.')
        : state.pending ? t('Reading file bytes…')
          : state.error ? t('The selected files could not be added. Limit: 10 files, 512 KiB total. Previous files were kept.')
            : t('Up to 10 files, 512 KiB total. Complete message request: 1 MiB.')
      status.append(message)
      if (state.error && enabled()) {
        const dismiss = mailTemplate(root, 'mail-compose-attachment-dismiss', 'button', ['label']) as HTMLButtonElement; dismiss.dataset.composeAttachmentDismiss = ''
        dismiss.textContent = t('Discard failed selection')
        dismiss.addEventListener('click', () => { if (sending() || state.pending) return; state.error = null; announce() })
        status.append(dismiss)
      }
      root.dataset.composeAttachmentState = !enabled() ? 'unavailable' : state.pending ? 'pending' : state.error ? 'invalid' : 'ready'
      updateControls()
      group.dispatchEvent(new CustomEvent('xpanel:compose-attachments-state', { bubbles: true, detail: { state: root.dataset.composeAttachmentState, count: state.files.length } }))
    }
    const render = () => {
      list.replaceChildren()
      if (summary) {
        const count = document.createElement('bdi'), size = document.createElement('bdi')
        count.dir = 'ltr'; count.textContent = String(state.files.length)
        size.dir = 'ltr'; size.textContent = String(state.files.reduce((total, file) => total + atob(file.contentBase64).length, 0)) + ' B'
        summary.replaceChildren(...t('{count} files · {size}').split(/(\{\w+\})/).filter(Boolean).map(part => part === '{count}' ? count : part === '{size}' ? size : document.createTextNode(part)))
      }
      state.files.forEach((file, index) => {
        const row = mailTemplate(root, 'mail-compose-attachment-row', 'li', ['name', 'size', 'remove']), filename = mailSlot(row, 'name', 'bdi'), size = mailSlot(row, 'size', 'bdi'), remove = mailSlot<HTMLButtonElement>(row, 'remove', 'button')
        filename.textContent = digits(file.filename)
        size.textContent = String(atob(file.contentBase64).length) + ' B'
        remove.dataset.composeAttachmentRemove = String(index)
        remove.textContent = t('Remove'); remove.setAttribute('aria-label', t('Remove {file}', { file: digits(file.filename) }))
        remove.addEventListener('click', () => { if (!enabled() || sending() || state.pending) return; state.files = Object.freeze(state.files.filter((_, current) => current !== index)); render(); announce() })
        list.append(row)
      })
    }
    opener.addEventListener('click', () => { if (enabled() && !sending() && !state.pending) input.click() })
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []); input.value = ''
      if (!files.length || !enabled() || sending() || state.pending) return
      const token = ++generation
      state.pending = true; state.error = null; announce()
      void (async () => {
        try {
          if (state.files.length + files.length > composeAttachmentLimits.maxFiles) throw new Error('ATTACHMENT_COUNT')
          let expectedTotal = state.files.reduce((total, file) => total + atob(file.contentBase64).length, 0)
          for (const file of files) {
            if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('ATTACHMENT_SIZE')
            expectedTotal += file.size
            if (expectedTotal > composeAttachmentLimits.maxDecodedBytes) throw new Error('ATTACHMENT_SIZE')
          }
          const loaded: ComposeAttachmentPayload[] = []
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer())
            if (bytes.byteLength !== file.size) throw new Error('ATTACHMENT_READ_FAILED')
            const chunks: string[] = []
            for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
            const contentType = file.type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.type) && file.type.length <= composeAttachmentLimits.maxContentTypeLength ? file.type : 'application/octet-stream'
            loaded.push(Object.freeze({ filename: file.name, contentType, contentBase64: btoa(chunks.join('')) }))
          }
          const snapshot = readComposeAttachmentPayload(group, undefined, () => ({ pending: false, error: null, files: [...state.files, ...loaded] }))
          if (token !== generation) return
          state.files = snapshot
        } catch { if (token === generation) state.error = 'ATTACHMENT_READ_FAILED' }
        finally { if (token === generation) { state.pending = false; render(); announce() } }
      })()
    })
    group.addEventListener('xpanel:mail-send-accepted', event => {
      if ((event as CustomEvent<{ draftCleared?: boolean }>).detail?.draftCleared === false) return
      generation++; state.pending = false; state.error = null; state.files = Object.freeze([]); input.value = ''; render(); announce()
    })
    const observer = new MutationObserver(records => {
      if (records.some(record => record.attributeName === 'data-compose-attachment-enabled' || record.attributeName === 'data-compose-mailbox')) announce()
      else updateControls()
    })
    const sendButton = group.querySelector<HTMLElement>('[data-mail-send]')
    if (sendButton) observer.observe(sendButton, { attributes: true, attributeFilter: ['data-mail-send-busy'] })
    observer.observe(root, { attributes: true, attributeFilter: ['data-compose-attachment-enabled'] })
    observer.observe(group, { attributes: true, attributeFilter: ['data-compose-mailbox'] })
    render(); announce()
  })
}

export const MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING = `(()=>{${MAIL_CLIENT_TEMPLATE_KIT}const composeAttachmentLimits=${JSON.stringify(composeAttachmentLimits)};const readComposeAttachmentPayload=${readComposeAttachmentPayload.toString()};return ${bindMailComposeAttachments.toString()};})()`
