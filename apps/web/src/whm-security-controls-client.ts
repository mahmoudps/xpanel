/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './client-templates.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'

const formatDisplayDateTime = canonicalFormatDisplayDateTime
const clientTemplate = canonicalClientTemplate
const clientTemplateSlot = canonicalClientTemplateSlot
const cloneClientTemplate = canonicalCloneClientTemplate
const frameRequest = canonicalFrameRequest

export interface WhmPhpExceptionRow {
  account: string
  functions: string[]
  reason: string
}

export interface WhmPhpFunctionsView {
  state: 'default' | 'saved' | 'invalid'
  disabled: string[] | null
  exceptions: WhmPhpExceptionRow[]
  updatedAt: string | null
  revision: string
  reconcile: string | null
}

export interface WhmSshAutobanPolicy {
  enabled: boolean
  failures: number
  windowMin: number
  banMin: number
}

export interface WhmSshBannedRow {
  address: string
  since: string | null
  until: string | null
  reason: string
  jail: string
}

export interface WhmSshAutobanView {
  state: 'default' | 'saved' | 'invalid'
  policy: WhmSshAutobanPolicy | null
  updatedAt: string | null
  revision: string
  banned: WhmSshBannedRow[]
  source: 'agent' | 'state' | 'not_connected'
  reconcile: string | null
}

/** Strict reader for GET/PUT /api/server/sec/php-functions. */
export function readWhmPhpFunctionsView(raw: unknown): WhmPhpFunctionsView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const fnName = (item: unknown): item is string => typeof item === 'string' && /^[a-z_][a-z0-9_]{0,63}$/.test(item)
  const safeText = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item)
  if (!object(raw) || !['default', 'saved', 'invalid'].includes(String(raw.state)) || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)
    || !(raw.updatedAt === null || typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))
    || !Array.isArray(raw.exceptions) || raw.exceptions.length > 5000) {
    throw new Error('invalid_php_functions_view')
  }
  let disabled: string[] | null = null
  if (raw.state === 'invalid') {
    if (raw.disabled !== null) throw new Error('invalid_php_functions_view')
  } else {
    if (!Array.isArray(raw.disabled) || raw.disabled.length > 200 || !raw.disabled.every(fnName)) throw new Error('invalid_php_functions_view')
    disabled = [...raw.disabled]
  }
  const exceptions: WhmPhpExceptionRow[] = raw.exceptions.map(entry => {
    if (!object(entry) || typeof entry.account !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(entry.account)
      || !Array.isArray(entry.functions) || !entry.functions.every(fnName) || !safeText(entry.reason, 200)) {
      throw new Error('invalid_php_functions_exception')
    }
    return { account: entry.account, functions: [...entry.functions], reason: entry.reason }
  })
  return {
    state: raw.state as WhmPhpFunctionsView['state'],
    disabled,
    exceptions,
    updatedAt: raw.updatedAt as string | null,
    revision: raw.revision,
    reconcile: typeof raw.reconcile === 'string' ? raw.reconcile : null,
  }
}

/** Strict reader for GET/PUT /api/server/sec/ssh-autoban. */
export function readWhmSshAutobanView(raw: unknown): WhmSshAutobanView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const boundedInt = (item: unknown, min: number, max: number): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= min && item <= max
  const isoOrNull = (item: unknown): item is string | null => item === null || typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item))
  if (!object(raw) || !['default', 'saved', 'invalid'].includes(String(raw.state)) || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)
    || !(raw.updatedAt === null || typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt)))
    || !['agent', 'state', 'not_connected'].includes(String(raw.source)) || !Array.isArray(raw.banned) || raw.banned.length > 500) {
    throw new Error('invalid_ssh_autoban_view')
  }
  let policy: WhmSshAutobanPolicy | null = null
  if (raw.state === 'invalid') {
    if (raw.policy !== null) throw new Error('invalid_ssh_autoban_view')
  } else {
    const p = raw.policy
    if (!object(p) || typeof p.enabled !== 'boolean' || !boundedInt(p.failures, 1, 500) || !boundedInt(p.windowMin, 1, 1440) || !boundedInt(p.banMin, 1, 10080)) {
      throw new Error('invalid_ssh_autoban_policy')
    }
    policy = { enabled: p.enabled, failures: p.failures, windowMin: p.windowMin, banMin: p.banMin }
  }
  const banned: WhmSshBannedRow[] = raw.banned.map(entry => {
    if (!object(entry) || typeof entry.address !== 'string' || !/^[0-9A-Fa-f:.]{2,45}(?:\/[0-9]{1,3})?$/.test(entry.address)
      || !isoOrNull(entry.since) || !isoOrNull(entry.until)
      || typeof entry.reason !== 'string' || entry.reason.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.reason)
      || (entry.jail !== undefined && (typeof entry.jail !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.jail)))) {
      throw new Error('invalid_ssh_autoban_row')
    }
    return {
      address: entry.address,
      since: entry.since,
      until: entry.until,
      reason: entry.reason,
      jail: typeof entry.jail === 'string' ? entry.jail : 'sshd',
    }
  })
  return {
    state: raw.state as WhmSshAutobanView['state'],
    policy,
    updatedAt: raw.updatedAt as string | null,
    revision: raw.revision,
    banned,
    source: raw.source as WhmSshAutobanView['source'],
    reconcile: typeof raw.reconcile === 'string' ? raw.reconcile : null,
  }
}

function bindWhmSecurityControls(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const note = (el: HTMLElement | null, state: string, message: string): void => {
    if (!el) return
    el.dataset.state = state
    el.textContent = message
    el.setAttribute('role', ['failed', 'unknown'].includes(state) ? 'alert' : 'status')
  }
  const technicalCell = (row: HTMLTableRowElement, value: string): void => {
    const td = document.createElement('td')
    const bdi = document.createElement('bdi')
    bdi.dir = 'ltr'
    bdi.textContent = value
    td.append(bdi)
    row.append(td)
  }
  const textCell = (row: HTMLTableRowElement, value: string): void => {
    const td = document.createElement('td')
    td.textContent = value
    row.append(td)
  }
  const emptyRow = (body: HTMLElement | null, columns: number, message: string): void => {
    if (!body) return
    body.textContent = ''
    const row = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = columns
    td.textContent = message
    row.append(td)
    body.append(row)
  }
  const errorMessage = (error: unknown, fallback: string): string => {
    const record = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}
    if (record.status === 409 || record.code === 'CONFLICT') return t('The saved configuration changed before this save. Reload and review before retrying.')
    if (record.status === 401 || record.status === 403) return t('Authorization is no longer valid. Nothing was changed.')
    if (record.status === 422 || record.code === 'VALIDATION') return t('The server refused the submitted values. Nothing was changed.')
    return fallback
  }

  document.querySelectorAll<HTMLElement>('[data-whm-php-functions]').forEach(root => {
    if (root.dataset.phpFunctionsBound === 'true') return
    root.dataset.phpFunctionsBound = 'true'
    const request = frameRequest(root)
    const boxes = [...root.querySelectorAll<HTMLInputElement>('[data-sec-php-fn]')]
    const save = root.querySelector<HTMLButtonElement>('[data-sec-php-save]')
    const status = root.querySelector<HTMLElement>('[data-sec-php-status]')
    const rows = root.querySelector<HTMLElement>('[data-v2-security-php-exceptions]')
    const admitted = (): boolean => root.isConnected && root.dataset.canRead === 'true' && typeof request === 'function'
    const manageable = (): boolean => admitted() && root.dataset.canManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let view: WhmPhpFunctionsView | null = null
    let busy = false

    const sync = (): void => {
      const editable = !busy && !!view && view.state !== 'invalid' && manageable()
      for (const box of boxes) box.disabled = !editable
      if (save) save.disabled = !editable
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: WhmPhpFunctionsView): void => {
      view = next
      if (next.disabled) {
        const disabledSet = new Set(next.disabled)
        for (const box of boxes) box.checked = disabledSet.has(box.dataset.secPhpFn ?? '')
      }
      if (rows) {
        rows.textContent = ''
        for (const entry of next.exceptions) {
          const row = document.createElement('tr')
          technicalCell(row, entry.account)
          technicalCell(row, entry.functions.join(', '))
          textCell(row, entry.reason)
          rows.append(row)
        }
        if (!next.exceptions.length) emptyRow(rows, 3, t('No per-account PHP function exceptions are saved.'))
      }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; sync(); note(status, 'reading', t('Reading PHP function policy…'))
      try {
        const next = readWhmPhpFunctionsView(await request('GET', '/api/server/sec/php-functions'))
        paint(next)
        note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid'
          ? t('The saved PHP function policy could not be verified. Editing is locked.')
          : t('PHP function policy read from the server.'))
      } catch (error) {
        view = null
        note(status, 'failed', errorMessage(error, t('PHP function policy could not be read. Nothing was changed.')))
      } finally {
        busy = false; sync()
      }
    }
    const store = async (): Promise<void> => {
      if (busy || !view || view.state === 'invalid' || !view.disabled || !manageable() || !request) return
      const managed = new Set(boxes.map(box => box.dataset.secPhpFn ?? '').filter(Boolean))
      const preserved = view.disabled.filter(fn => !managed.has(fn))
      const checked = boxes.filter(box => box.checked).map(box => box.dataset.secPhpFn ?? '').filter(Boolean)
      const disabled = [...preserved, ...checked]
      busy = true; sync(); note(status, 'saving', t('Saving PHP function policy…'))
      try {
        const ack = readWhmPhpFunctionsView(await request('PUT', '/api/server/sec/php-functions', { expectedRevision: view.revision, disabled }))
        const again = readWhmPhpFunctionsView(await request('GET', '/api/server/sec/php-functions'))
        paint(again)
        note(status, 'saved', ack.reconcile === 'requested'
          ? t('Saved and read back. The server was asked to apply the updated PHP pools.')
          : t('PHP function policy saved and read back.'))
      } catch (error) {
        note(status, 'failed', errorMessage(error, t('PHP function policy could not be saved. Nothing was changed.')))
      } finally {
        busy = false; sync()
      }
    }
    if (!admitted()) {
      for (const box of boxes) box.disabled = true
      if (save) save.disabled = true
      note(status, 'unavailable', t('PHP function controls are unavailable here. Nothing was read or changed.'))
      return
    }
    save?.addEventListener('click', () => { void store() })
    sync(); void load()
  })

  document.querySelectorAll<HTMLElement>('[data-whm-ssh-autoban]').forEach(root => {
    if (root.dataset.sshAutobanBound === 'true') return
    root.dataset.sshAutobanBound = 'true'
    const request = frameRequest(root)
    const enabled = root.querySelector<HTMLInputElement>('[data-ssh-autoban-enabled]')
    const failures = root.querySelector<HTMLInputElement>('[data-ssh-autoban-failures]')
    const windowInput = root.querySelector<HTMLInputElement>('[data-ssh-autoban-window]')
    const save = root.querySelector<HTMLButtonElement>('[data-ssh-autoban-save]')
    const refresh = root.querySelector<HTMLButtonElement>('[data-ssh-autoban-refresh]')
    const status = root.querySelector<HTMLElement>('[data-ssh-autoban-status]')
    const bannedBody = root.querySelector<HTMLElement>('[data-v2-ssh-banned]')
    const admitted = (): boolean => root.isConnected && root.dataset.canRead === 'true' && typeof request === 'function'
    const manageable = (): boolean => admitted() && root.dataset.canManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled')
    let view: WhmSshAutobanView | null = null
    let busy = false
    let unbanTemplate: HTMLTemplateElement | null = null
    try {
      unbanTemplate = clientTemplate(root, 'whm-ssh-autoban-unban')
      const probe = cloneClientTemplate(unbanTemplate, 'button', ['label'])
      clientTemplateSlot(probe, 'label', 'span')
    } catch {
      unbanTemplate = null
    }

    const sync = (): void => {
      const editable = !busy && !!view && view.state !== 'invalid' && manageable()
      if (enabled) enabled.disabled = !editable
      if (failures) failures.disabled = !editable
      if (windowInput) windowInput.disabled = !editable
      if (save) save.disabled = !editable
      if (refresh) refresh.disabled = busy || !admitted()
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-ssh-autoban-unban]')) {
        button.disabled = busy || !manageable() || (button.dataset.address ?? '').includes('/')
      }
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: WhmSshAutobanView): void => {
      view = next
      if (next.policy) {
        if (enabled) enabled.checked = next.policy.enabled
        if (failures) failures.value = String(next.policy.failures)
        if (windowInput) windowInput.value = String(next.policy.windowMin)
      }
      if (bannedBody) {
        bannedBody.textContent = ''
        for (const item of next.banned) {
          const row = document.createElement('tr')
          technicalCell(row, item.address)
          if (item.since) technicalCell(row, formatDisplayDateTime(item.since)); else textCell(row, '—')
          if (item.until) technicalCell(row, formatDisplayDateTime(item.until)); else textCell(row, '—')
          textCell(row, item.reason || 'sshd')
          const actionCell = document.createElement('td')
          if (unbanTemplate) {
            const btn = cloneClientTemplate(unbanTemplate, 'button', ['label']) as HTMLButtonElement
            clientTemplateSlot(btn, 'label', 'span').textContent = t('Unban')
            btn.dataset.address = item.address
            btn.dataset.jail = item.jail
            btn.setAttribute('aria-label', t('Unban {address}', { address: item.address }))
            btn.addEventListener('click', () => { if (!btn.disabled) void unban(item.address, item.jail) })
            actionCell.append(btn)
          }
          row.append(actionCell)
          bannedBody.append(row)
        }
        if (!next.banned.length) emptyRow(bannedBody, 5, t('No SSH addresses are currently banned.'))
      }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; sync(); note(status, 'reading', t('Reading SSH auto-ban rule and ban list…'))
      try {
        const next = readWhmSshAutobanView(await request('GET', '/api/server/sec/ssh-autoban'))
        paint(next)
        note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid'
          ? t('The saved SSH auto-ban policy could not be verified. Editing is locked.')
          : t('SSH auto-ban policy and ban list read.'))
      } catch (error) {
        view = null
        note(status, 'failed', errorMessage(error, t('SSH auto-ban settings could not be read. Nothing was changed.')))
      } finally {
        busy = false; sync()
      }
    }
    const store = async (): Promise<void> => {
      if (busy || !view || !view.policy || !manageable() || !request) return
      const failText = (failures?.value ?? '').trim()
      const winText = (windowInput?.value ?? '').trim()
      if (!/^[1-9][0-9]{0,3}$/.test(failText) || !/^[1-9][0-9]{0,3}$/.test(winText) || Number(failText) > 500 || Number(winText) > 1440) {
        note(status, 'failed', t('Enter whole numbers for failures and window minutes.'))
        return
      }
      const nextPolicy: WhmSshAutobanPolicy = {
        enabled: enabled?.checked === true,
        failures: Number(failText),
        windowMin: Number(winText),
        banMin: view.policy.banMin,
      }
      busy = true; sync(); note(status, 'saving', t('Saving SSH auto-ban rule…'))
      try {
        const ack = readWhmSshAutobanView(await request('PUT', '/api/server/sec/ssh-autoban', { expectedRevision: view.revision, policy: nextPolicy }))
        const again = readWhmSshAutobanView(await request('GET', '/api/server/sec/ssh-autoban'))
        paint(again)
        note(status, 'saved', ack.reconcile === 'requested'
          ? t('SSH auto-ban rule saved and read back. Reconcile requested.')
          : t('SSH auto-ban rule saved and read back.'))
      } catch (error) {
        note(status, 'failed', errorMessage(error, t('SSH auto-ban rule could not be saved. Nothing was changed.')))
      } finally {
        busy = false; sync()
      }
    }
    const unban = async (address: string, jail: string): Promise<void> => {
      if (busy || !manageable() || !request) return
      if (askDialog) {
        let confirmed = false
        try { confirmed = await askDialog({ title: t('Unban IP address?'), body: address + ' · ' + jail, confirm: t('Unban') }) === true } catch { confirmed = false }
        if (!confirmed || !manageable()) return
      }
      busy = true; sync(); note(status, 'saving', t('Unbanning address…'))
      try {
        const res = await request('POST', '/api/server/sec/ssh-autoban/unban', { address, jail }) as { outcome?: unknown } | null
        const again = readWhmSshAutobanView(await request('GET', '/api/server/sec/ssh-autoban'))
        paint(again)
        const confirmed = res?.outcome === 'confirmed' && !again.banned.some(item => item.address === address)
        note(status, confirmed ? 'saved' : 'failed', confirmed
          ? t('Unbanned {address} and refreshed the ban list.', { address })
          : t('The address could not be unbanned. Refresh and review.'))
      } catch (error) {
        note(status, 'failed', errorMessage(error, t('The address could not be unbanned. Refresh and review.')))
      } finally {
        busy = false; sync()
      }
    }
    if (!admitted() || !unbanTemplate) {
      if (enabled) enabled.disabled = true
      if (failures) failures.disabled = true
      if (windowInput) windowInput.disabled = true
      if (save) save.disabled = true
      if (refresh) refresh.disabled = true
      note(status, 'unavailable', t('SSH auto-ban controls are unavailable here. Nothing was read or changed.'))
      return
    }
    save?.addEventListener('click', () => { void store() })
    refresh?.addEventListener('click', () => { void load() })
    sync(); void load()
  })
}

export const WHM_SECURITY_CONTROLS_CLIENT_BINDING = withFrameRequest(`(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const clientTemplate=${clientTemplate.toString()};const clientTemplateSlot=${clientTemplateSlot.toString()};const cloneClientTemplate=${cloneClientTemplate.toString()};const readWhmPhpFunctionsView=${readWhmPhpFunctionsView.toString()};const readWhmSshAutobanView=${readWhmSshAutobanView.toString()};return ${bindWhmSecurityControls.toString()};})()`)
