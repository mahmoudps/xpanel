/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest
const formatDisplayDateTime = sharedFormatDisplayDateTime

/** Policy fields a page may show, by dotted key, with how their control text becomes a value. */
export const SIGN_IN_POLICY_FIELDS: Readonly<Record<string, 'integer' | 'optional-integer' | 'lines'>> = {
  'lockout.username.attempts': 'integer', 'lockout.username.windowMin': 'integer', 'lockout.username.durationMin': 'integer',
  'lockout.ip.attempts': 'integer', 'lockout.ip.windowMin': 'integer', 'lockout.ip.durationMin': 'integer',
  'lockout.ipAllow': 'lines', 'lockout.ipDeny': 'lines', 'passwordStrength.default': 'integer',
  'passwordStrength.perService.panel': 'optional-integer', 'passwordStrength.perService.mail': 'optional-integer', 'passwordStrength.perService.ftp': 'optional-integer',
  'passwordStrength.perService.database': 'optional-integer', 'passwordStrength.perService.webdisk': 'optional-integer', 'passwordStrength.perService.directory': 'optional-integer',
  'session.idleMin': 'integer', 'session.absoluteHours': 'integer',
}

export interface SignInPolicyView { state: 'default' | 'saved' | 'invalid'; policy: Record<string, unknown> | null; updatedAt: string | null; revision: string }
export interface SignInLockout { username: string | null; ip: string | null; failures: number; lockedUntil: string }

/** Strict reader for GET/PUT /api/server/sec/sign-in. */
export function readSignInPolicyView(value: unknown): SignInPolicyView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !(value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))) throw new Error('invalid_sign_in_view')
  const p = value.policy
  if (value.state === 'invalid' ? p !== null : !(object(p) && object(p.lockout) && object(p.passwordStrength) && object(p.session))) throw new Error('invalid_sign_in_view')
  return { state: value.state as SignInPolicyView['state'], policy: object(p) ? p : null, updatedAt: value.updatedAt as string | null, revision: value.revision }
}

/** Strict reader for GET /api/server/sec/sign-in/lockouts. */
export function readSignInLockouts(value: unknown): SignInLockout[] {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !Array.isArray(value.lockouts) || value.lockouts.length > 500) throw new Error('invalid_lockouts')
  return value.lockouts.map(item => {
    if (!object(item) || !(item.username === null || typeof item.username === 'string' && item.username.length <= 128) || !(item.ip === null || typeof item.ip === 'string' && /^[0-9a-f:.]{2,45}$/.test(item.ip))
      || (item.username === null) === (item.ip === null) || typeof item.failures !== 'number' || !Number.isSafeInteger(item.failures) || typeof item.lockedUntil !== 'string' || !Number.isFinite(Date.parse(item.lockedUntil))) throw new Error('invalid_lockouts')
    return { username: item.username as string | null, ip: item.ip as string | null, failures: item.failures, lockedUntil: item.lockedUntil }
  })
}

/** The saved policy with the page's fields applied; a field the page does not show keeps its saved value. */
export function buildSignInPolicy(current: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(current)) as Record<string, unknown>
  for (const [key, raw] of Object.entries(values)) {
    const kind = SIGN_IN_POLICY_FIELDS[key]
    if (!kind) throw new Error('unknown_field')
    const text = raw.trim()
    const value = kind === 'lines' ? text.split(/[\r\n,]+/).map(line => line.trim()).filter(Boolean)
      : kind === 'optional-integer' && text === '' ? null
        : /^(?:0|[1-9][0-9]{0,5})$/.test(text) ? Number(text) : (() => { throw new Error('integer') })()
    const parts = key.split('.'), last = parts.pop()!
    let parent = next
    for (const part of parts) parent = parent[part] as Record<string, unknown>
    parent[last] = value
  }
  return next
}

function bindSignInPolicy(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-sign-in-policy]').forEach(root => {
    if (root.dataset.signInBound === 'true') return
    root.dataset.signInBound = 'true'
    const request = frameRequest(root)
    const status = root.querySelector<HTMLElement>('[data-sign-in-status]'), save = root.querySelector<HTMLButtonElement>('[data-sign-in-save]'), refresh = root.querySelector<HTMLButtonElement>('[data-sign-in-refresh]')
    const rows = root.querySelector<HTMLElement>('[data-sign-in-lockouts]'), target = root.querySelector<HTMLSelectElement>('[data-sign-in-unlock-target]')
    const unlockButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-sign-in-unlock]')]
    const fields = [...root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-sign-in-field]')]
    const admitted = (): boolean => root.isConnected && root.dataset.signInCanRead === 'true' && typeof request === 'function'
    const manageable = (): boolean => admitted() && root.dataset.signInCanManage === 'true'
      && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    let view: SignInPolicyView | null = null, locks: SignInLockout[] = [], busy = false
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'unknown'].includes(state) ? 'alert' : 'status') }
    const sync = (): void => {
      const ready = !busy && !!view && view.state !== 'invalid' && manageable()
      for (const field of fields) field.disabled = !ready
      if (save) save.disabled = !ready
      if (refresh) refresh.disabled = busy || !admitted()
      if (target) target.disabled = busy || !manageable() || !locks.length
      const kind = target?.value.split(':')[0]
      for (const button of unlockButtons) button.disabled = busy || !manageable() || button.dataset.signInUnlock !== kind
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (): void => {
      const policy = view?.policy
      for (const field of fields) {
        let value: unknown = policy
        for (const part of (field.dataset.signInField ?? '').split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
        field.value = Array.isArray(value) ? value.join('\n') : value === null || value === undefined ? '' : String(value)
      }
    }
    const paintLocks = (): void => {
      if (rows) {
        rows.textContent = ''
        for (const lock of locks) {
          const row = document.createElement('tr')
          for (const text of [lock.username ?? lock.ip ?? '', String(lock.failures), formatDisplayDateTime(lock.lockedUntil)]) {
            const cell = document.createElement('td'), content = document.createElement('bdi')
            content.dir = 'ltr'; content.textContent = text; cell.append(content); row.append(cell)
          }
          rows.append(row)
        }
        if (!locks.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 3; cell.textContent = t('No username or address is locked right now.'); row.append(cell); rows.append(row) }
      }
      if (target) {
        const previous = target.value
        target.textContent = ''
        for (const lock of locks) {
          const option = document.createElement('option')
          option.value = lock.username !== null ? 'username:' + lock.username : 'ip:' + lock.ip
          option.textContent = lock.username !== null ? t('Username {name}', { name: lock.username }) : t('Address {address}', { address: lock.ip ?? '' })
          target.append(option)
        }
        if ([...target.options].some(option => option.value === previous)) target.value = previous
      }
    }
    const failure = (error: unknown): [string, string] => {
      const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details ?? {}
      if (details.reason === 'self_lockout') return ['refused', t('The denied addresses include the address of this session, so nothing was saved.')]
      if (problem.status === 409) return ['refused', t('The sign-in policy changed before this save. Nothing was changed; read it again and review.')]
      if (problem.status === 401 || problem.status === 403) return ['refused', t('Authorization is no longer valid. Nothing was changed.')]
      if (problem.code === 'VALIDATION' || problem.status === 422 || problem.status === 400) return ['refused', t('The server refused the values. Nothing was changed; check the fields and try again.')]
      return details.stateChanged === false ? ['refused', t('The request was refused. Nothing was changed.')] : ['unknown', t('The outcome is unknown. Read the policy again before retrying.')]
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; sync(); note('reading', t('Reading the sign-in policy…'))
      try {
        view = readSignInPolicyView(await request('GET', '/api/server/sec/sign-in'))
        if (rows || target) locks = readSignInLockouts(await request('GET', '/api/server/sec/sign-in/lockouts'))
        paint(); paintLocks()
        note(view.state === 'invalid' ? 'failed' : 'read', view.state === 'invalid' ? t('The saved sign-in policy cannot be read and needs review. Sign-in uses the default limits.')
          : view.state === 'default' ? t('No sign-in policy is saved; the default limits apply.') : t('Saved sign-in policy read.'))
      } catch { view = null; note('failed', t('The sign-in policy could not be read. Nothing was changed.')) }
      finally { busy = false; sync() }
    }
    const store = async (): Promise<void> => {
      if (busy || !view?.policy || !manageable() || !request) return
      let policy: Record<string, unknown>
      try { policy = buildSignInPolicy(view.policy, Object.fromEntries(fields.map(field => [field.dataset.signInField ?? '', field.value]))) }
      catch { note('failed', t('Enter whole numbers in the number fields and one address or range per line.')); return }
      busy = true; sync(); note('saving', t('Saving the sign-in policy…'))
      try {
        view = readSignInPolicyView(await request('PUT', '/api/server/sec/sign-in', { expectedRevision: view.revision, policy }))
        paint(); note('saved', t('Saved and read back. New sign-ins, sessions and passwords follow this policy.'))
      } catch (error) { const [state, message] = failure(error); note(state, message) }
      finally { busy = false; sync() }
    }
    const unlock = async (kind: string): Promise<void> => {
      const [selected, ...rest] = (target?.value ?? '').split(':'), value = rest.join(':')
      if (busy || !manageable() || !request || selected !== kind || !value) return
      if (askDialog && await askDialog({ title: t('Lift this lock?'), body: t('Sign-in from {target} is allowed again and its failure count starts over.', { target: value }), confirm: t('Lift lock') }) !== true) return
      busy = true; sync()
      try {
        await request('POST', '/api/server/sec/sign-in/unlock', kind === 'username' ? { username: value } : { ip: value })
        locks = readSignInLockouts(await request('GET', '/api/server/sec/sign-in/lockouts'))
        paintLocks(); note('saved', t('The lock on {target} was lifted.', { target: value }))
      } catch (error) { const [state, message] = failure(error); note(state, message) }
      finally { busy = false; sync() }
    }
    if (!admitted()) { for (const field of fields) field.disabled = true; if (save) save.disabled = true; if (refresh) refresh.disabled = true; note('unavailable', t('The sign-in policy is unavailable here. Nothing was read or changed.')); return }
    save?.addEventListener('click', () => { void store() })
    refresh?.addEventListener('click', () => { void load() })
    target?.addEventListener('change', sync)
    for (const button of unlockButtons) button.addEventListener('click', () => { void unlock(button.dataset.signInUnlock ?? '') })
    void load()
  })
}

export const SIGN_IN_POLICY_CLIENT_BINDING = withFrameRequest(`(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const SIGN_IN_POLICY_FIELDS=${JSON.stringify(SIGN_IN_POLICY_FIELDS)};const readSignInPolicyView=${readSignInPolicyView.toString()};const readSignInLockouts=${readSignInLockouts.toString()};const buildSignInPolicy=${buildSignInPolicy.toString()};return ${bindSignInPolicy.toString()};})()`)
