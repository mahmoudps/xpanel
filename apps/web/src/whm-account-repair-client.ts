/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface AccountRepairPreviewRow { username: string; ownership: 'ok' | 'problem' | 'unavailable'; sample: string | null }
export function readAccountRepairPreview(raw: unknown): AccountRepairPreviewRow[] {
  const rows = raw && typeof raw === 'object' ? (raw as { accounts?: unknown }).accounts : null
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.username !== 'string' || !['ok', 'problem', 'unavailable'].includes(row.ownership) || row.sample !== null && typeof row.sample !== 'string')) throw new Error('invalid_account_repair')
  return rows as AccountRepairPreviewRow[]
}

function bindAccountRepair(askDialog: ((input: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-whm-account-repair]').forEach(root => {
    if (root.dataset.accountRepairBound === 'true') return
    root.dataset.accountRepairBound = 'true'
    const part = <T extends HTMLElement>(key: string): T | null => root.querySelector<T>('[data-account-repair-' + key + ']')
    const accounts = part<HTMLInputElement>('accounts'), ownership = part<HTMLInputElement>('ownership'), rerender = part<HTMLInputElement>('rerender'), preview = part<HTMLButtonElement>('preview'), run = part<HTMLButtonElement>('run'), rows = part('rows'), status = part('status')
    const say = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')]
    if (!send || root.dataset.accountRepairCanManage !== 'true' || !accounts || !ownership || !rerender || !preview || !run || !rows || root.closest('[data-readonly="true"],[data-capability-state="unavailable"],fieldset:disabled')) {
      for (const control of controls) control.disabled = true
      say('unavailable', t('Account repair requires root. Nothing was read or changed.')); return
    }
    let reviewed = ''
    const names = (): string[] => [...new Set(accounts.value.split(/[\s,]+/).filter(Boolean))]
    const lock = (): void => { run.disabled = !reviewed || reviewed !== names().join() || !ownership.checked && !rerender.checked }
    const load = async (): Promise<void> => {
      const list = names()
      if (!list.length || list.length > 32 || list.some(name => !/^[a-z][a-z0-9]{0,15}$/.test(name))) { say('failed', t('Enter 1 to 32 account usernames.')); return }
      preview.disabled = true; say('reading', t('Checking file ownership. A large home can take a while.'))
      try {
        const report = readAccountRepairPreview(await send('POST', '/api/accounts/repair/preview', { accounts: list }))
        rows.replaceChildren()
        for (const entry of report) {
          const row = document.createElement('tr'), name = document.createElement('td'), state = document.createElement('td'), sample = document.createElement('td'), bdi = document.createElement('bdi')
          name.textContent = entry.username; state.textContent = entry.ownership === 'ok' ? t('Every file belongs to the account') : entry.ownership === 'problem' ? t('Wrong ownership found') : t('Not verified'); bdi.dir = 'ltr'; bdi.textContent = entry.sample ?? ''; sample.append(bdi); row.append(name, state, sample); rows.append(row)
        }
        reviewed = list.join(); say('read', t('Preview ready. Files are changed only when you run the repair.'))
      } catch (error) { reviewed = ''; say('failed', (error as { code?: unknown } | null)?.code === 'NOT_FOUND' ? t('One of those accounts does not exist.') : t('The preview could not be read. Nothing was changed.')) }
      finally { preview.disabled = false; lock() }
    }
    const repair = async (): Promise<void> => {
      const list = names(), fixes = [...(ownership.checked ? ['ownership'] : []), ...(rerender.checked ? ['rerender'] : [])]
      if (typeof askDialog !== 'function' || await askDialog({ title: t('Repair {count} accounts?', { count: list.length }), body: t('Ownership is reset to each account for files in its home. File contents and modes do not change. Rebuilding rewrites the web, PHP, quota and DNS configuration from saved settings.'), confirm: t('Run repair') }) !== true) return
      run.disabled = true; say('saving', t('Starting the repair…'))
      try {
        const result = await send('POST', '/api/accounts/repair/run', { accounts: list, fixes }) as { job?: { id?: unknown } | null; rerender?: unknown }
        const job = typeof result?.job?.id === 'string' ? t('Ownership repair is running as host job {id}.', { id: result.job.id }) : ''
        const built = result?.rerender === 'applied' ? t('Configuration rebuilt.') : result?.rerender === 'failed' ? t('The configuration rebuild failed; review the reconcile status.') : result?.rerender === 'not-connected' ? t('The host agent is not connected, so nothing was rebuilt.') : ''
        reviewed = ''; say(result?.rerender === 'failed' || result?.rerender === 'not-connected' ? 'failed' : 'saved', [job, built, t('Run the checks again to confirm.')].filter(Boolean).join(' '))
      } catch (error) { say('failed', (error as { details?: { unknownOutcome?: unknown } } | null)?.details?.unknownOutcome ? t('The outcome is unknown. Review host jobs before trying again.') : t('The repair did not start. Nothing was changed.')) }
      finally { lock() }
    }
    preview.addEventListener('click', () => { void load() }); run.addEventListener('click', () => { void repair() })
    for (const control of [accounts, ownership, rerender]) control.addEventListener('input', lock)
    lock()
  })
}

export const WHM_ACCOUNT_REPAIR_CLIENT_BINDING = `(()=>{const readAccountRepairPreview=${readAccountRepairPreview.toString()};return ${bindAccountRepair.toString()}})()`
