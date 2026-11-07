/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Listed = { uid: number; uidValidity: number }

/** The messages of one folder page that a write can name. A row whose UIDVALIDITY was not observed is left out. */
export function bulkTargets(value: unknown): Listed[] {
  const messages = (value as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messages)) throw new Error('invalid_folder_list')
  return messages.flatMap(item => { const row = item as { uid?: unknown; uidValidity?: unknown }; return Number.isSafeInteger(row.uid) && Number.isSafeInteger(row.uidValidity) ? [{ uid: row.uid as number, uidValidity: row.uidValidity as number }] : [] })
}

/** Bulk junk marking of the open page and Empty Junk. Each message keeps its own route, audit and training. */
function bindMailBulk(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-bulk]').forEach(root => {
    if (root.dataset.mailBulkBound === 'true') return
    root.dataset.mailBulkBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
    const folder = root.dataset.mailBulkFolder ?? '', status = root.querySelector<HTMLElement>('[data-mail-bulk-status]')
    const say = (message: string): void => { if (status) status.textContent = message }
    const list = async (): Promise<Listed[]> => bulkTargets(await send!('GET', '/api/webmail/inbox?folder=' + encodeURIComponent(folder)))
    root.querySelectorAll<HTMLButtonElement>('[data-mail-bulk-action]').forEach(button => {
      button.disabled = !send || typeof askDialog !== 'function'
      button.addEventListener('click', () => { void (async () => {
        if (!send || typeof askDialog !== 'function') return
        const empty = button.dataset.mailBulkAction === 'empty'
        const ok = await askDialog(empty ? { title: t('Empty Junk?'), body: t('Messages in Junk are deleted for good. This cannot be undone.'), confirm: t('Delete'), danger: true }
          : { title: button.textContent ?? '', body: t('This applies to the messages on this page. The filter learns from each one.'), confirm: t('Continue') })
        if (!ok) return
        button.disabled = true; say(t('Working…'))
        let done = 0
        try {
          // Empty Junk reads page after page, because a folder may hold more than one page.
          for (let pages = 0; pages < (empty ? 20 : 1); pages++) {
            const targets = await list()
            if (!targets.length) break
            for (const target of targets) {
              if (empty) await send('DELETE', `/api/webmail/inbox/${target.uid}?folder=${encodeURIComponent(folder)}&confirm=delete`, { uidValidity: target.uidValidity })
              else await send('POST', `/api/webmail/inbox/${target.uid}/report`, { folder: folder === 'Junk' ? 'INBOX' : 'Junk', from: folder, uidValidity: target.uidValidity })
              done++
            }
          }
          window.location.reload()
        } catch (error) { button.disabled = false; say(t('{done} messages were changed, then the server refused: {reason}', { done, reason: (error as { message?: string }).message || t('unknown') })) }
      })() })
    })
  })
}

export const MAIL_BULK_CLIENT_BINDING = `((askDialog)=>{const bulkTargets=${bulkTargets.toString()};(${bindMailBulk.toString()})(askDialog)})`
