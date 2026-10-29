/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailDateTime = formatDisplayDateTime

export interface MailToolsQuota { state: 'read' | 'no-storage-limit' | 'not-advertised' | 'unavailable'; usedBytes: number | null; limitBytes: number | null; observedAt: string }
export function readMailToolsQuota(value: unknown, mailbox: string): MailToolsQuota {
  const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw), count = (raw: unknown): raw is number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
  if (!object(value) || value.mailbox !== mailbox || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || new Date(value.observedAt).toISOString() !== value.observedAt || !object(value.quota)) throw new Error('invalid_tools_quota')
  const quota = value.quota
  if (quota.state === 'read' && count(quota.usedBytes) && (quota.limitBytes === null || count(quota.limitBytes))) return { state: 'read', usedBytes: quota.usedBytes, limitBytes: quota.limitBytes, observedAt: value.observedAt }
  if (['no-storage-limit', 'not-advertised', 'unavailable'].includes(String(quota.state))) return { state: quota.state as MailToolsQuota['state'], usedBytes: null, limitBytes: null, observedAt: value.observedAt }
  throw new Error('invalid_tools_quota')
}
function bindMailTools(_askDialog: unknown): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mail-tools-quota]').forEach(root => {
    if (root.dataset.toolsBound === 'true') return; root.dataset.toolsBound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string) => Promise<unknown> }).xpanelSessionRequest, mailbox = root.dataset.toolsMailbox ?? '', used = root.querySelector<HTMLElement>('[data-tools-used]')!, limit = root.querySelector<HTMLElement>('[data-tools-limit]')!, observed = root.querySelector<HTMLElement>('[data-tools-observed]')!, status = root.querySelector<HTMLElement>('[data-tools-status]')!, refresh = root.querySelector<HTMLButtonElement>('[data-tools-refresh]')!
    if (![used, limit, observed, status, refresh].every(Boolean)) return
    const admitted = (): boolean => root.isConnected && root.dataset.toolsAvailable === 'true' && root.dataset.toolsMailbox === mailbox && !!mailbox && !!send && !root.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let busy = false
    const load = async (): Promise<void> => { if (busy || !admitted()) return; busy = true; refresh.disabled = true; status.textContent = t('Reading mailbox quota…'); root.setAttribute('aria-busy', 'true'); try { const result = readMailToolsQuota(await send!('GET', '/api/webmail/disk-usage'), mailbox); if (!admitted()) throw new Error('mailbox_changed'); used.textContent = result.usedBytes === null ? t(msgctxt('mail-tools-client', 'Not observed')) : String(result.usedBytes); limit.textContent = result.state === 'read' && result.limitBytes === null || result.state === 'no-storage-limit' ? t('No storage limit reported') : result.limitBytes === null ? t(msgctxt('mail-tools-client', 'Not observed')) : String(result.limitBytes); observed.textContent = formatMailDateTime(result.observedAt); status.textContent = result.state === 'read' ? t('Current quota read from the mailbox server.') : t('The mailbox server did not report a measurable storage quota.'); status.dataset.state = 'read'; status.setAttribute('role', 'status') } catch { for (const item of [used, limit, observed]) item.textContent = t('Unavailable'); status.textContent = t('The quota could not be verified. Read it again.'); status.dataset.state = 'failed'; status.setAttribute('role', 'alert') } finally { busy = false; root.setAttribute('aria-busy', 'false'); refresh.disabled = !admitted() } }
    refresh.addEventListener('click', () => { void load() }); refresh.disabled = !admitted()
    if (!admitted()) { status.textContent = t('Quota is unavailable for this mailbox session. Nothing was read.'); status.dataset.state = 'unavailable'; return } void load()
  })
}
export const MAIL_TOOLS_CLIENT_BINDING = `(()=>{const formatMailDateTime=${DISPLAY_DATETIME_BINDING};const readMailToolsQuota=${readMailToolsQuota.toString()};return ${bindMailTools.toString()};})()`
