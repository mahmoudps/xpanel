/// <reference lib="dom" />
import './i18n.ts'

function bindFtpRemoval(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string): string => xpT(message)
  document.querySelectorAll<HTMLElement>('[data-ftp-create]').forEach(root => {
    const button = root.parentElement?.querySelector<HTMLButtonElement>('[data-ftp-create-submit]')
    if (!button || button.dataset.ftpCreateBound === 'true') return
    button.dataset.ftpCreateBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    button.addEventListener('click', () => { void (async () => {
      if (!send || button.disabled) return
      button.disabled = true
      try {
        await send('POST', '/api/service-users', { login: root.querySelector<HTMLInputElement>('[name="login"]')?.value.trim() ?? '', password: root.querySelector<HTMLInputElement>('[name="password"]')?.value ?? '', ftpDir: root.querySelector<HTMLInputElement>('[name="ftpDir"]')?.value.trim() ?? '', services: { email: false, ftp: true, webdisk: false } })
        window.location.reload()
      } catch (error) {
        button.disabled = false
        const status = root.parentElement?.querySelector<HTMLElement>('[data-ftp-remove-status]')
        if (status) { status.hidden = false; status.textContent = (error as { message?: string }).message || t('The login could not be created.') }
      }
    })() })
  })
  document.querySelectorAll<HTMLButtonElement>('[data-ftp-remove]').forEach(button => {
    if (button.dataset.ftpRemoveBound === 'true') return
    button.dataset.ftpRemoveBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    button.addEventListener('click', () => { void (async () => {
      if (!send || typeof askDialog !== 'function' || button.disabled) return
      const keep = button.dataset.ftpRemoveKeep, path = '/api/service-users/' + encodeURIComponent(button.dataset.ftpRemove ?? '')
      if (!await askDialog({ title: t('Delete FTP login'), body: t('FTP access for this login ends. Files stay in place. This cannot be undone.'), confirm: t('Delete'), danger: true })) return
      button.disabled = true
      try {
        if (keep) await send('PATCH', path, { services: JSON.parse(keep) })
        else await send('DELETE', path)
        window.location.reload()
      } catch (error) {
        button.disabled = false
        const status = document.querySelector<HTMLElement>('[data-ftp-remove-status]')
        if (status) { status.hidden = false; status.textContent = (error as { message?: string }).message || t('The login could not be deleted.') }
      }
    })() })
  })
}

export const ACCOUNT_FTP_REMOVE_CLIENT_BINDING = bindFtpRemoval.toString()
