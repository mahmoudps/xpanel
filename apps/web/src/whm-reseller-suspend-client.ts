/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

function bindResellerSuspension(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLButtonElement>('[data-reseller-suspend]').forEach(button => {
    if (button.dataset.resellerSuspendBound === 'true') return
    button.dataset.resellerSuspendBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const status = button.parentElement?.querySelector<HTMLElement>('[data-reseller-suspend-status]') ?? null
    const say = (message: string): void => { if (status) status.textContent = message }
    button.addEventListener('click', () => { void (async () => {
      if (!send || typeof askDialog !== 'function' || button.disabled) return
      const suspended = button.dataset.resellerSuspended === 'true', verb = suspended ? 'unsuspend' : 'suspend'
      const ok = await askDialog(suspended
        ? { title: t('Unsuspend this reseller?'), body: t('The reseller can sign in again, and accounts suspended with it return to service.'), confirm: t('Unsuspend reseller') }
        : { title: t('Suspend this reseller?'), body: t('The reseller cannot sign in, and every active account it owns is suspended.'), confirm: t('Suspend reseller'), danger: true })
      if (!ok) return
      button.disabled = true; say(t('Working…'))
      try {
        const result = await send('POST', '/api/resellers/' + encodeURIComponent(button.dataset.resellerSuspend ?? '') + '/' + verb) as { failed?: string[] }
        if (result.failed?.length) { say(t('These accounts did not change: {accounts}', { accounts: result.failed.join(', ') })); return }
        window.location.reload()
      } catch (error) { button.disabled = false; say((error as { message?: string }).message || t('The request was refused. Nothing was changed.')) }
    })() })
  })
}

export const WHM_RESELLER_SUSPEND_CLIENT_BINDING = bindResellerSuspension.toString()
