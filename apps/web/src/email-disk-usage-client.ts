/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import type { EmailDiskUsageView } from '../../agent/src/mailbox-disk-usage.ts'
import { ASCII_BYTES_BINDING, formatIsolatedBytes as canonicalFormatClientBytes } from './display-format.ts'
// Module-local alias: the binding source defines it again from ASCII_BYTES_BINDING.
const formatClientBytes = canonicalFormatClientBytes
const formatDisplayDateTime = sharedFormatDisplayDateTime

export function readEmailDiskUsage(raw: unknown, mailbox: string): EmailDiskUsageView & { freedBytes?: number | null } {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!object(raw) || raw.mailbox !== mailbox || typeof raw.observedAt !== 'string' || !object(raw.folders) || !['read', 'unavailable'].includes(String(raw.folders.state)) || !Array.isArray(raw.folders.folders)
    || raw.folders.folders.some(folder => !object(folder) || typeof folder.name !== 'string' || typeof folder.messages !== 'number' || typeof folder.vsizeBytes !== 'number')) throw new Error('invalid_email_disk_usage')
  return raw as unknown as EmailDiskUsageView & { freedBytes?: number | null }
}

function bindEmailDiskUsage(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  const bytes = (value: number): string => formatClientBytes(value)
  document.querySelectorAll<HTMLElement>('[data-email-disk-usage]').forEach(root => {
    if (root.dataset.emailDiskUsageBound === 'true') return
    root.dataset.emailDiskUsageBound = 'true'
    const part = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-email-usage-' + key + ']')
    const mailbox = part<HTMLSelectElement>('mailbox'), read = part<HTMLButtonElement>('read'), search = part<HTMLInputElement>('search'), rows = part('rows'), status = part('status'), folder = part<HTMLSelectElement>('folder'), preset = part<HTMLSelectElement>('preset'), query = part<HTMLInputElement>('query'), run = part<HTMLButtonElement>('run'), custom = part('custom')
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    if (!send || root.dataset.emailUsageCanManage !== 'true' || !mailbox || !read || !search || !rows || !folder || !preset || !query || !run || !custom || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say('unavailable', t('Email Disk Usage is unavailable here. Nothing was read.')); return
    }
    for (const control of controls) control.disabled = false
    let folders: { name: string; messages: number; vsizeBytes: number }[] = [], sort: 'name' | 'messages' | 'size' = 'size', descending = true
    const paint = (): void => {
      const term = search.value.trim().toLowerCase(), value = (item: typeof folders[number]): string | number => sort === 'name' ? item.name.toLowerCase() : sort === 'messages' ? item.messages : item.vsizeBytes
      const shown = folders.filter(item => item.name.toLowerCase().includes(term)).sort((left, right) => { const a = value(left), b = value(right), order = a < b ? -1 : a > b ? 1 : 0; return descending ? -order : order })
      rows.replaceChildren()
      for (const item of shown) { const row = document.createElement('tr'); for (const text of [item.name, String(item.messages), bytes(item.vsizeBytes)]) { const td = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = text; td.append(bdi); row.append(td) } rows.append(row) }
      if (!shown.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 3; td.textContent = folders.length ? t('No folders match.') : t('This mailbox has no folders.'); row.append(td); rows.append(row) }
      const chosen = folder.value; folder.replaceChildren(...folders.map(item => new Option(item.name, item.name))); folder.value = folders.some(item => item.name === chosen) ? chosen : folders.find(item => item.name === 'INBOX')?.name ?? folders[0]?.name ?? ''
      run.disabled = !folder.value
    }
    const load = async (freed?: number | null): Promise<void> => {
      if (!mailbox.value) return
      read.disabled = true; say('reading', t('Reading the mailbox…'))
      try {
        const view = readEmailDiskUsage(await send('GET', '/api/account/email/disk-usage?mailbox=' + encodeURIComponent(mailbox.value)), mailbox.value)
        folders = view.folders.folders; paint()
        if (view.folders.state !== 'read') say('unavailable', t('The mail server could not report this mailbox. Nothing was changed.'))
        else say('read', freed === undefined ? t('Read at {time}. Sizes may lag behind recent mail.', { time: formatDisplayDateTime(view.observedAt) }) : t('Deleted. {size} freed.', { size: bytes(freed ?? 0) }))
      } catch { say('failed', t('The mailbox could not be read. Nothing was changed.')) }
      finally { read.disabled = false }
    }
    const clean = async (): Promise<void> => {
      const custom_ = preset.value === 'custom', name = folder.value
      if (custom_ && !query.value.trim()) { say('failed', t('Enter a search. An empty search is refused so nothing is deleted by accident.')); return }
      const entered = typeof askDialog === 'function' ? await askDialog({ title: t('Permanently delete messages?'), body: t('Matching messages in {folder} are deleted and cannot be recovered.', { folder: name }), confirm: t('Delete messages'), danger: true }) : false
      if (entered !== true) return
      run.disabled = true; say('saving', t('Deleting messages…'))
      try {
        const view = readEmailDiskUsage(await send('POST', '/api/account/email/disk-usage/cleanup', { mailbox: mailbox.value, folder: name, preset: preset.value, query: custom_ ? query.value.trim() : null, confirmFolder: name }), mailbox.value)
        await load(view.freedBytes ?? null)
      } catch (error) {
        const detail = (error as { details?: { unknownOutcome?: unknown } } | null)?.details
        say('failed', detail?.unknownOutcome ? t('The result is not confirmed. Read the mailbox before trying again.') : (error as { code?: unknown } | null)?.code === 'VALIDATION' ? t('That search is not supported. Use terms such as LARGER 10M, BEFORE 2025-01-01 or SEEN.') : t('The messages were not deleted.'))
      } finally { run.disabled = !folder.value }
    }
    run.disabled = true
    read.addEventListener('click', () => { void load() }); mailbox.addEventListener('change', () => { void load() }); search.addEventListener('input', paint); run.addEventListener('click', () => { void clean() })
    preset.addEventListener('change', () => { custom.hidden = preset.value !== 'custom' })
    for (const button of root.querySelectorAll<HTMLButtonElement>('button[data-email-usage-sort]')) button.addEventListener('click', () => { const key = button.dataset.emailUsageSort as typeof sort; descending = sort === key ? !descending : key !== 'name'; sort = key; paint() })
    if (!mailbox.options.length || !mailbox.value) { read.disabled = true; say('unavailable', t('This account has no mailboxes.')) }
  })
}

export const EMAIL_DISK_USAGE_CLIENT_BINDING = `(()=>{const formatClientBytes=${ASCII_BYTES_BINDING};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readEmailDiskUsage=${readEmailDiskUsage.toString()};return ${bindEmailDiskUsage.toString()}})()`
