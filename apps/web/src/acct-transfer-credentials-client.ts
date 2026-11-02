/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { cloneViewRecord as canonicalCloneViewRecord, viewAction as canonicalViewAction, VIEW_RECORD_HELPERS } from './workspace-view-templates.ts'
const cloneViewRecord = canonicalCloneViewRecord
const viewAction = canonicalViewAction
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface TransferCredentialsView { revision: string; limit: number; credentials: { id: string; label: string; kind: 'api-token'; fingerprint: string; createdAt: string; createdBy: string }[]; changed: string | null }

/** Strict reader for /api/transfers/credentials (apps/api/src/acct-transfer-credentials.ts); a token value is never part of it. */
export function readTransferCredentialsView(value: unknown): TransferCredentialsView {
  const bad = (): never => { throw new Error('invalid_transfer_credentials') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  if (!object(value) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || value.limit !== 50 || !Array.isArray(value.credentials) || value.credentials.length > 50 || !(value.changed === undefined || uuid(value.changed))) return bad()
  const credentials = value.credentials.map(item => {
    if (!object(item) || Object.keys(item).sort().join() !== 'createdAt,createdBy,fingerprint,id,kind,label' || !uuid(item.id) || item.kind !== 'api-token' || typeof item.label !== 'string' || !item.label || [...item.label].length > 80
      || typeof item.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(item.fingerprint) || typeof item.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.createdAt) || typeof item.createdBy !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(item.createdBy)) return bad()
    return { id: item.id, label: item.label, kind: 'api-token' as const, fingerprint: item.fingerprint, createdAt: item.createdAt, createdBy: item.createdBy }
  })
  if (new Set(credentials.map(item => item.id)).size !== credentials.length) return bad()
  return { revision: value.revision, limit: 50, credentials, changed: value.changed === undefined ? null : value.changed as string }
}

function bindTransferCredentials(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-acct-transfer-credentials]').forEach(root => {
    if (root.dataset.bound === 'true') return
    root.dataset.bound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const status = root.querySelector<HTMLElement>('[data-acct-transfer-credentials-status]')!, rows = root.querySelector<HTMLElement>('[data-acct-transfer-credentials-rows]')!
    const loading = root.querySelector<HTMLElement>('[data-acct-transfer-credentials-loading]')!, empty = root.querySelector<HTMLElement>('[data-acct-transfer-credentials-empty]')!
    const label = root.querySelector<HTMLInputElement>('[data-acct-transfer-credential-input="label"]')!, token = root.querySelector<HTMLInputElement>('[data-acct-transfer-credential-input="token"]')!
    const save = root.querySelector<HTMLButtonElement>('[data-acct-transfer-credential-save]')!, refresh = root.querySelector<HTMLButtonElement>('[data-acct-transfer-credentials-refresh]')!
    const form = root.querySelector<HTMLElement>('[data-acct-transfer-credentials-form]')!
    if (!status || !rows || !loading || !empty || !label || !token || !save || !refresh || !form) return
    let view: TransferCredentialsView | null = null, busy = false, reviewRequired = false
    const admitted = (): boolean => !!send && root.isConnected && root.dataset.canManage === 'true' && !root.closest('[data-capability-unavailable="true"],[data-read-only="true"],[data-wiring="unavailable"]')
    const announce = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'uncertain', 'stale'].includes(state) ? 'alert' : 'status') }
    const controls = (): void => {
      const locked = busy || !admitted()
      refresh.disabled = locked
      label.disabled = token.disabled = save.disabled = locked || reviewRequired || !view || view.credentials.length >= view.limit
      rows.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = locked || reviewRequired })
      root.setAttribute('aria-busy', String(busy)); loading.hidden = !busy || view !== null
    }
    const paint = (): void => {
      rows.textContent = ''
      for (const item of view?.credentials ?? []) {
        const row = cloneViewRecord(root, 'transfer-credential-row', 'tr', { label: item.label, fingerprint: item.fingerprint, created: formatDisplayDateTime(item.createdAt), actor: item.createdBy, 'remove-label': t('Remove') })
        const remove = viewAction(row, 'remove')
        remove.setAttribute('aria-label', t('Remove source token {label}', { label: item.label }))
        remove.addEventListener('click', () => { void removeOne(item.id, item.label) })
        rows.append(row)
      }
      empty.hidden = !view || view.credentials.length > 0
      controls()
    }
    const failure = (error: unknown, submitted: boolean): void => {
      const failed = error as { status?: number; details?: { stateChanged?: boolean; unknownOutcome?: boolean; verificationRequired?: boolean } } | null
      const refused = !!failed && typeof failed.status === 'number' && failed.status >= 400 && failed.status < 500 && failed.details?.stateChanged !== true
      if (failed?.status === 409) { announce('stale', t('Stored source tokens changed. Read them again before changing them.')); reviewRequired = true; return }
      reviewRequired = submitted && !refused
      announce(reviewRequired ? 'uncertain' : 'failed', reviewRequired ? t('The outcome requires review. No retry was sent. Read the stored tokens again.') : t('The server refused the change. Nothing was stored.'))
    }
    const read = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); announce('loading', t('Reading stored source tokens.'))
      try { view = readTransferCredentialsView(await send!('GET', '/api/transfers/credentials')); reviewRequired = false; paint(); announce('read', view.credentials.length ? t('{n, plural, one {# source token is stored.} other {# source tokens are stored.}}', { n: view.credentials.length }) : t('No source tokens are stored.')) }
      catch { view = null; rows.textContent = ''; empty.hidden = true; announce('failed', t('Stored source tokens could not be read.')) }
      finally { busy = false; controls() }
    }
    const changed = (): void => { document.dispatchEvent(new CustomEvent('xp-transfer-credentials-changed')) }
    const store = async (): Promise<void> => {
      if (busy || reviewRequired || !view || !admitted()) return
      const name = label.value.trim(), secret = token.value
      if (!name || [...name].length > 80) { announce('failed', t('Enter a label of 1 to 80 characters. Nothing was sent.')); return }
      if (!/^xp_[A-Za-z0-9_-]{43}$/.test(secret)) { token.value = ''; announce('failed', t('Paste the complete xPanel API token from the source. Nothing was sent.')); return }
      if (!askDialog || await askDialog({ title: t('Store source token?'), body: t('The token is kept on this server and is never shown again.'), confirm: t('Store token') }) !== true) { token.value = ''; return }
      busy = true; controls(); let submitted = false
      try {
        submitted = true
        const reply = readTransferCredentialsView(await send!('POST', '/api/transfers/credentials', { label: name, token: secret, expectedRevision: view.revision }))
        token.value = ''
        view = readTransferCredentialsView(await send!('GET', '/api/transfers/credentials'))
        if (!reply.changed || !view.credentials.some(item => item.id === reply.changed && item.label === name)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        label.value = ''; paint(); changed(); announce('saved', t('The source token was stored and read back.'))
      } catch (error) { failure(error, submitted) }
      finally { token.value = ''; busy = false; controls() }
    }
    const removeOne = async (id: string, name: string): Promise<void> => {
      if (busy || reviewRequired || !view || !admitted()) return
      if (!askDialog || await askDialog({ title: t('Remove source token?'), body: t('Saved sessions that use {label} can no longer connect.', { label: name }), danger: true, confirm: t('Remove') }) !== true) return
      busy = true; controls(); let submitted = false
      try {
        submitted = true
        await send!('DELETE', '/api/transfers/credentials/' + encodeURIComponent(id), { expectedRevision: view.revision })
        view = readTransferCredentialsView(await send!('GET', '/api/transfers/credentials'))
        if (view.credentials.some(item => item.id === id)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(); changed(); announce('saved', t('The source token was removed and the list read back.'))
      } catch (error) { failure(error, submitted) }
      finally { busy = false; controls() }
    }
    if (!admitted()) { label.disabled = token.disabled = save.disabled = refresh.disabled = true; announce(root.dataset.canManage === 'true' ? 'unavailable' : 'denied', root.dataset.canManage === 'true' ? t('Source tokens are unavailable here. Nothing was read or changed.') : t('Only the server administrator can manage source tokens.')); return }
    form.addEventListener('submit', event => { event.preventDefault(); void store() })
    save.addEventListener('click', event => { if (form.tagName !== 'FORM') { event.preventDefault(); void store() } })
    refresh.addEventListener('click', () => { reviewRequired = false; void read() })
    void read()
  })
}

export const ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING = `(()=>{${VIEW_RECORD_HELPERS}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readTransferCredentialsView=${readTransferCredentialsView.toString()};return ${bindTransferCredentials.toString()};})()`
