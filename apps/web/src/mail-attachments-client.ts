import type { MessageValues } from './i18n.ts'
import { MAIL_CLIENT_TEMPLATE_KIT, mailTemplate as canonicalMailTemplate, mailSlot as canonicalMailSlot, mailRequireTemplates as canonicalMailRequireTemplates } from './mail-client-template-kit.ts'
const mailTemplate = canonicalMailTemplate
const mailSlot = canonicalMailSlot
const mailRequireTemplates = canonicalMailRequireTemplates
/// <reference lib="dom" />
interface AttachmentView { filename: string; contentType: string; sizeBytes: number; sha256: string; downloadPath: string; expiresAt: string }
interface AttachmentManifest { context: { mailbox: string; folder: string; uid: number; uidValidity: number }; attachments: AttachmentView[] }

export function readAttachmentManifest(value: unknown, expected: { mailbox: string; folder: string; uid: number; uidValidity?: number }): AttachmentManifest {
  const object = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input)
  if (!object(value) || !object(value.context) || !Array.isArray(value.attachments) || value.attachments.length > 64
    || value.context.mailbox !== expected.mailbox || value.context.folder !== expected.folder || value.context.uid !== expected.uid
    || !Number.isSafeInteger(value.context.uidValidity) || (value.context.uidValidity as number) < 1 || (value.context.uidValidity as number) > 0xffffffff || (expected.uidValidity !== undefined && expected.uidValidity !== value.context.uidValidity)) throw new Error('invalid_attachment_manifest')
  const attachments = value.attachments.map(raw => {
    if (!object(raw) || typeof raw.filename !== 'string' || !raw.filename.trim() || raw.filename.length > 255 || /[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw.filename)
      || typeof raw.contentType !== 'string' || raw.contentType.length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(raw.contentType) || typeof raw.sizeBytes !== 'number' || !Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0 || raw.sizeBytes > 10 * 1024 * 1024
      || typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256) || typeof raw.downloadPath !== 'string' || raw.downloadPath.length > 2100
      || !/^\/api\/webmail\/attachment-download\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(raw.downloadPath)
      || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))) throw new Error('invalid_attachment_manifest')
    return { filename: raw.filename, contentType: raw.contentType, sizeBytes: raw.sizeBytes, sha256: raw.sha256, downloadPath: raw.downloadPath, expiresAt: raw.expiresAt }
  })
  if (attachments.reduce((sum, item) => sum + item.sizeBytes, 0) > 25 * 1024 * 1024) throw new Error('invalid_attachment_manifest')
  if (new Set(attachments.map(item => item.downloadPath)).size !== attachments.length) throw new Error('invalid_attachment_manifest')
  return { context: { mailbox: expected.mailbox, folder: expected.folder, uid: expected.uid, uidValidity: value.context.uidValidity as number }, attachments }
}

function bindMailAttachments(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const digits = (text: string): string => text.replace(/[\u0660-\u0669\u06f0-\u06f9]/g, character => String(character.charCodeAt(0) - (character.charCodeAt(0) >= 0x06f0 ? 0x06f0 : 0x0660)))
  document.querySelectorAll<HTMLElement>('[data-mail-attachments]').forEach(root => {
    if (root.dataset.attachmentsBound === 'true') return
    root.dataset.attachmentsBound = 'true'
    const status = root.querySelector<HTMLElement>('[data-attachment-status]'), list = root.querySelector<HTMLElement>('[data-attachment-list]'), refresh = root.querySelector<HTMLButtonElement>('[data-attachment-refresh]')
    if (!status || !list || !refresh) return
    try { mailRequireTemplates(root, [['mail-attachment-row', 'li', ['link', 'badge', 'name', 'size']]]) }
    catch { refresh.disabled = true; status.dataset.state = 'unavailable'; status.textContent = t('Attachment reading is unavailable here.'); return }
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const eligible = (): boolean => root.isConnected && root.dataset.attachmentCanRead === 'true' && !root.closest(denied)
    let generation = 0, busy = false
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const selected = (): { mailbox: string; folder: string; uid: number; uidValidity?: number } | null => {
      const raw = root.dataset.uid ?? '', folder = root.dataset.folder ?? 'INBOX', mailbox = root.dataset.mailbox ?? ''
      const validity = root.dataset.uidValidity ?? ''
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 0xffffffff || !mailbox || !/^(?:INBOX|Sent|Drafts|Junk|Trash|Archive|[A-Za-z][A-Za-z0-9._-]{0,40})$/.test(folder)) return null
      if (validity && (!/^[1-9][0-9]*$/.test(validity) || !Number.isSafeInteger(Number(validity)) || Number(validity) > 0xffffffff)) return null
      return { mailbox, folder, uid: Number(raw), ...(validity ? { uidValidity: Number(validity) } : {}) }
    }
    const load = async (): Promise<void> => {
      const token = ++generation, expected = selected()
      list.textContent = ''
      const heading = root.querySelector<HTMLElement>('[data-attachment-heading]')
      if (heading) heading.textContent = t('Attachments')
      if (!transport || !eligible()) { busy = false; root.setAttribute('aria-busy', 'false'); refresh.disabled = true; announce('unavailable', t('Attachment reading is unavailable here.')); return }
      if (!expected) { busy = false; root.setAttribute('aria-busy', 'false'); refresh.disabled = true; announce('unread', t('Select a message to read its attachments.')); return }
      busy = true; refresh.disabled = true; root.setAttribute('aria-busy', 'true')
      announce('reading', t('Reading message attachments…'))
      try {
        const manifest = readAttachmentManifest(await transport('GET', '/api/webmail/attachment-workspace?uid=' + expected.uid + '&folder=' + encodeURIComponent(expected.folder) + (expected.uidValidity === undefined ? '' : '&uidValidity=' + expected.uidValidity)), expected)
        if (token !== generation || !eligible() || JSON.stringify(selected()) !== JSON.stringify(expected)) return
        if (!manifest.attachments.length) { announce('empty', t('The message has no attachments.')); return }
        if (heading) heading.textContent = t('Attachments · {count} · {bytes} B', { count: manifest.attachments.length, bytes: manifest.attachments.reduce((sum, item) => sum + item.sizeBytes, 0) })
        for (const attachment of manifest.attachments) {
          const row = mailTemplate(root, 'mail-attachment-row', 'li', ['link', 'badge', 'name', 'size'])
          const link = mailSlot<HTMLAnchorElement>(row, 'link', 'a'), badge = mailSlot(row, 'badge'), name = mailSlot(row, 'name', 'bdi'), sizeValue = mailSlot(row, 'size', 'bdi')
          name.textContent = digits(attachment.filename); sizeValue.textContent = String(attachment.sizeBytes) + ' B'
          const extension = attachment.filename.includes('.') ? attachment.filename.split('.').at(-1)! : ''
          badge.textContent = /^[a-z0-9]{1,6}$/i.test(extension) ? extension.toUpperCase() : 'FILE'
          link.href = attachment.downloadPath
          link.setAttribute('aria-label', t('Download {file}', { file: digits(attachment.filename) }))
          link.addEventListener('click', event => {
            if (!eligible() || Date.parse(attachment.expiresAt) <= Date.now() || JSON.stringify(selected()) !== JSON.stringify(expected)) {
              event.preventDefault(); announce('failed', t('Read attachments again before downloading.'))
            }
          })
          list.append(row)
        }
        announce('read', t('Attachments read from this message. Download links expire after 5 minutes.'))
      } catch { if (token === generation) announce('failed', t('Attachments could not be read. No file was downloaded.')) }
      finally { if (token === generation) { busy = false; root.setAttribute('aria-busy', 'false'); refresh.disabled = !eligible() || !selected() } }
    }
    refresh.addEventListener('click', () => { if (!busy && eligible()) void load() })
    const observer = new MutationObserver(() => { void load() })
    observer.observe(root, { attributes: true, attributeFilter: ['data-uid', 'data-uid-validity', 'data-folder', 'data-mailbox', 'data-attachment-can-read'] })
    void load()
  })
}

export const MAIL_ATTACHMENTS_CLIENT_BINDING = `(()=>{${MAIL_CLIENT_TEMPLATE_KIT}const readAttachmentManifest=${readAttachmentManifest.toString()};return ${bindMailAttachments.toString()};})()`
