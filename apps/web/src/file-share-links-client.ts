/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface FileShareLinkRow { id: string; username: string; file: string; sizeBytes: number; expiresAt: string; createdBy: string; state: 'active' | 'expired' }
export interface FileShareLinksView { revision: string; invalid: boolean; links: FileShareLinkRow[] }
export function readFileShareLinks(raw: unknown): FileShareLinksView {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!object(raw) || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision) || typeof raw.invalid !== 'boolean' || !Array.isArray(raw.links)
    || raw.links.some(row => !object(row) || typeof row.id !== 'string' || typeof row.username !== 'string' || typeof row.file !== 'string' || typeof row.expiresAt !== 'string' || typeof row.createdBy !== 'string' || !['active', 'expired'].includes(String(row.state)))) throw new Error('invalid_file_share_links')
  return raw as unknown as FileShareLinksView
}
/** Links are served on the account listener only; the page may be open on the root one. */
export function shareLinkUrl(path: string, href: string): string { const url = new URL(path, href); url.port = '2083'; return url.href }

function bindFileShareLinks(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-file-share-links]').forEach(root => {
    if (root.dataset.fileShareBound === 'true') return
    root.dataset.fileShareBound = 'true'
    const part = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-file-share-' + key + ']')
    const path = part<HTMLInputElement>('path'), hours = part<HTMLSelectElement>('hours'), create = part<HTMLButtonElement>('create'), read = part<HTMLButtonElement>('read'), rows = part('rows'), status = part('status'), result = part('result'), address = part<HTMLInputElement>('url'), copy = part<HTMLButtonElement>('copy')
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    if (!send || root.dataset.fileShareCanManage !== 'true' || !path || !hours || !create || !read || !rows || !result || !address || !copy || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say('unavailable', t('Share links require an authorized root administrator. Nothing was read or changed.')); return
    }
    for (const control of controls) control.disabled = false
    let view: FileShareLinksView | null = null
    const cell = (value: string, technical = false): HTMLTableCellElement => { const td = document.createElement('td'); if (technical) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; td.append(bdi) } else td.textContent = value; return td }
    const paint = (): void => {
      rows.replaceChildren()
      for (const link of view?.links ?? []) {
        const row = document.createElement('tr'), actions = document.createElement('td'), button = cloneClientTemplate(clientTemplate(root, 'file-share-action'), 'button', ['label'])
        clientTemplateSlot(button, 'label').textContent = t('Revoke'); (button as HTMLButtonElement).disabled = false; button.addEventListener('click', () => { void revoke(link) }); actions.append(button)
        row.append(cell(link.file, true), cell(link.username, true), cell(formatDisplayDateTime(link.expiresAt), true), cell(link.state === 'active' ? t('Active') : t('Expired')), actions); rows.append(row)
      }
      if (!view?.links.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 5; td.textContent = t('No share links.'); row.append(td); rows.append(row) }
    }
    const load = async (): Promise<void> => {
      read.disabled = true; say('reading', t('Reading share links…'))
      try { view = readFileShareLinks(await send('GET', '/api/server/file-sharing/links')); paint(); say(view.invalid ? 'failed' : 'read', view.invalid ? t('The saved links could not be read, so no link is served. Review the file on the server.') : t('Share links read.')) }
      catch { say('failed', t('Share links could not be read. Nothing was changed.')) }
      finally { read.disabled = false }
    }
    const revoke = async (link: FileShareLinkRow): Promise<void> => {
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Revoke this link?'), body: t('The link stops working at once. This cannot be undone.'), confirm: t('Revoke'), danger: true }) !== true) return
      try { await send('DELETE', '/api/server/file-sharing/links/' + link.id); result.hidden = true; await load(); say('saved', t('Link revoked.')) }
      catch (error) { say('failed', (error as { details?: { stateChanged?: unknown } } | null)?.details?.stateChanged === true ? t('The link is revoked, but the revocation was not recorded. Review the audit log.') : t('The link was not revoked.')) }
    }
    const submit = async (): Promise<void> => {
      if (!view) await load()
      if (!view) return
      const value = path.value.trim()
      if (!value.startsWith('/')) { say('failed', t('Enter the full path of one file in an account home.')); return }
      create.disabled = true; result.hidden = true; say('saving', t('Creating the link…'))
      try {
        const reply = await send('POST', '/api/server/file-sharing/links', { path: value, expiresHours: Number(hours.value), expectedRevision: view.revision }) as { path?: unknown }
        if (typeof reply?.path !== 'string') throw new Error('invalid_reply')
        address.value = shareLinkUrl(reply.path, location.href); result.hidden = false; path.value = ''
        await load(); say('saved', t('Link created. Copy it now: it is shown only once.'))
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        say('failed', code === 'NOT_FOUND' ? t('That path is not one regular file inside an active account.') : code === 'CONFLICT' ? t('The links changed. Read them again.') : code === 'LIMIT_EXCEEDED' ? t('Too many links are active. Revoke one first.') : t('The link was not created.'))
      } finally { create.disabled = false }
    }
    read.addEventListener('click', () => { void load() }); create.addEventListener('click', () => { void submit() })
    copy.addEventListener('click', () => { void navigator.clipboard?.writeText(address.value).then(() => { say('saved', t('Copied.')) }, () => { address.select() }) })
    void load()
  })
}

export const FILE_SHARE_LINKS_CLIENT_BINDING = `(()=>{${clientTemplate.toString()};${clientTemplateSlot.toString()};${cloneClientTemplate.toString()};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readFileShareLinks=${readFileShareLinks.toString()};const shareLinkUrl=${shareLinkUrl.toString()};return ${bindFileShareLinks.toString()}})()`
