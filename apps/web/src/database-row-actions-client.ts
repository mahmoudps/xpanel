/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Row actions of the database page: rename, export, import, new password, delete and drop. The list is read again after each. */
function bindDatabaseRowActions(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-database-workspace]').forEach(root => {
    if (root.dataset.rowActionsBound === 'true') return
    root.dataset.rowActionsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest
    const status = root.querySelector<HTMLElement>('[data-db-row-status]')
    const say = (message: string): void => { if (status) { status.hidden = false; status.textContent = message } }
    root.querySelector<HTMLButtonElement>('[data-db-copy-details]')?.addEventListener('click', () => {
      const text = [...root.querySelectorAll<HTMLElement>('[data-db-connection] > div')].map(row => row.textContent?.trim() ?? '').join('\n')
      void navigator.clipboard?.writeText(text).then(() => say(t('Connection details copied.')), () => say(t('The browser refused the copy.')))
    })
    const resetUser = root.querySelector<HTMLSelectElement>('[data-db-reset-user]'), resetPassword = root.querySelector<HTMLInputElement>('[data-db-reset-password]')
    root.querySelector<HTMLButtonElement>('[data-db-reset-save]')?.addEventListener('click', () => { void (async () => {
      if (!send || !resetUser?.value || !resetPassword?.value) { say(t('Choose a user and enter the new password.')); return }
      try {
        await send('POST', '/api/databases/users/' + encodeURIComponent(resetUser.value) + '/password', { password: resetPassword.value })
        resetPassword.value = ''; say(t('Password changed.'))
      } catch (error) { say((error as { message?: string }).message || t('The request was refused. Nothing was changed.')) }
    })() })
    root.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-db-row-action]') : null
      if (!button || button.disabled || !send || typeof askDialog !== 'function') return
      const id = button.closest<HTMLElement>('[data-database-id]')?.dataset.databaseId ?? '', action = button.dataset.dbRowAction, name = button.dataset.dbRowName ?? ''
      const database = '/api/databases/' + encodeURIComponent(id), user = '/api/databases/users/' + encodeURIComponent(id)
      void (async () => {
        if (action === 'export') { window.location.assign(database + '/dump'); return }
        if (action === 'password') { if (resetUser) { resetUser.value = id; resetPassword?.focus() } return }
        const asked = action === 'rename' ? await askDialog({ title: t('Rename database'), body: t('The database is copied to the new name, then the old copy is removed. Update the sites that use it.'), input: true, label: t('New name'), value: name })
          : action === 'import' ? await askDialog({ title: t('Import a dump'), body: t('Enter a .sql or .sql.gz file inside your home. Its statements run inside {name} only.', { name }), input: true, label: t('Dump file'), value: '' })
            : await askDialog({ title: action === 'drop' ? t('Drop this database?') : t('Delete this user?'), code: name, body: t('This cannot be undone.'), confirm: t('Delete'), danger: true })
        if (!asked) return
        button.disabled = true; say(t('Working…'))
        try {
          if (action === 'rename') await send('POST', database + '/rename', { name: String(asked) })
          else if (action === 'import') await send('POST', database + '/import', { path: String(asked) })
          else await send('DELETE', action === 'drop' ? database : user)
          window.location.reload()
        } catch (error) { button.disabled = false; say((error as { message?: string }).message || t('The request was refused. Nothing was changed.')) }
      })()
    })
  })
}

export const DATABASE_ROW_ACTIONS_CLIENT_BINDING = bindDatabaseRowActions.toString()
