/// <reference lib="dom" />
import './i18n.ts'

/** Changes the authenticated sign-in password through the existing CSRF-aware session transport. */
export function bindAccountPassword(navigate: (href: string) => void = href => window.location.assign(href)): void {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const copy = (message: string): string => xpT(message)
  document.querySelectorAll<HTMLElement>('[data-account-password]').forEach(root => {
    if (root.dataset.accountPasswordBound === 'true') return
    root.dataset.accountPasswordBound = 'true'
    // Malformed or unavailable workspaces must never fall back to a native GET form submission.
    root.addEventListener('submit', event => { event.preventDefault() })
    const ownedMatches = (scope: ParentNode, selector: string): Element[] => [...scope.querySelectorAll(selector)]
      .filter(node => node.closest('[data-account-password]') === root)
    const unique = (scope: ParentNode, selector: string): Element | null => {
      const found = ownedMatches(scope, selector)
      return found.length === 1 ? found[0] ?? null : null
    }
    const disable = (markUnavailable = true): void => {
      root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')
        .forEach(control => { if (control.closest('[data-account-password]') === root) control.disabled = true })
      if (markUnavailable) root.dataset.accountPasswordState = 'unavailable'
    }
    const form = unique(root, 'form[data-account-password-form]')
    const status = unique(root, '[data-account-password-status]')
    if (!(form instanceof HTMLFormElement) || !(status instanceof HTMLElement)) { disable(); return }
    const current = unique(form, 'input[name="currentPassword"]')
    const next = unique(form, 'input[name="newPassword"]')
    const confirm = unique(form, 'input[name="confirmPassword"]')
    const submit = unique(form, 'button[data-account-password-submit]')
    const show = unique(root, 'input[data-account-password-show]')
    if ((root.parentElement?.closest('[data-account-password]') ?? null) !== null
      || form.method !== 'post' || form.getAttribute('action') !== '/api/auth/change-password'
      || !(current instanceof HTMLInputElement) || !(next instanceof HTMLInputElement) || !(confirm instanceof HTMLInputElement)
      || !(submit instanceof HTMLButtonElement) || submit.type !== 'submit'
      || [current, next, confirm].some(field => field.type !== 'password' || !field.required)
      || ownedMatches(root, '[data-account-password-show]').length > 1
      || show !== null && (!(show instanceof HTMLInputElement) || show.type !== 'checkbox')) { disable(); return }
    const currentOwnership = (): boolean => document.contains(root)
      && (root.parentElement?.closest('[data-account-password]') ?? null) === null
      && unique(root, 'form[data-account-password-form]') === form
      && form.method === 'post' && form.getAttribute('action') === '/api/auth/change-password'
      && unique(form, 'input[name="currentPassword"]') === current && current.form === form
      && unique(form, 'input[name="newPassword"]') === next && next.form === form
      && unique(form, 'input[name="confirmPassword"]') === confirm && confirm.form === form
      && unique(form, 'button[data-account-password-submit]') === submit && submit.form === form
      && unique(root, '[data-account-password-status]') === status
      && unique(root, 'input[data-account-password-show]') === show
    const transport = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-auth-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => currentOwnership() && root.dataset.accountPasswordCanChange === 'true'
      && !root.closest(denied) && !document.querySelector('[data-impersonation]') && typeof transport === 'function'
      && (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest === transport
    let busy = false, completed = false, uncertain = false
    const fields = [current, next, confirm]
    const note = (state: string, message: string): void => {
      root.dataset.accountPasswordState = state
      status.dataset.state = state
      status.hidden = !message
      status.textContent = message
      status.setAttribute('role', ['invalid', 'failed', 'uncertain'].includes(state) ? 'alert' : 'status')
    }
    const lock = (): void => {
      root.setAttribute('aria-busy', String(busy))
      if (!currentOwnership()) { disable(!busy && !completed && !uncertain); return }
      const blocked = busy || completed || uncertain || !admitted()
      fields.forEach(field => { field.disabled = blocked })
      submit.disabled = blocked
      if (show instanceof HTMLInputElement) show.disabled = blocked
      root.setAttribute('aria-busy', String(busy))
    }
    const lengthRule = (): void => {
      const target = unique(root, '[data-account-password-rule="length"]')
      if (!(target instanceof HTMLElement)) return
      const readable = unique(form, 'input[name="newPassword"]') === next && next.form === form
      const state = !readable || !next.value || next.minLength <= 0 ? 'unknown' : next.value.length >= next.minLength ? 'passed' : 'unmet'
      target.dataset.state = state
      const label = unique(target, '[data-account-password-rule-state]')
      if (label instanceof HTMLElement) label.textContent = copy(state === 'passed' ? 'Valid' : state === 'unmet' ? 'Invalid' : 'Not read')
    }
    const clear = (): void => {
      fields.forEach(field => { if (field.closest('[data-account-password]') === root && field.form === form) { field.value = ''; field.type = 'password' } })
      if (show instanceof HTMLInputElement && show.closest('[data-account-password]') === root) show.checked = false
      lengthRule()
    }
    const inline = (field: HTMLInputElement, selector: string, message: string): void => {
      if (field.closest('[data-account-password]') !== root || field.form !== form) return
      if (message) field.setAttribute('aria-invalid', 'true')
      else field.removeAttribute('aria-invalid')
      const target = unique(root, selector)
      if (target instanceof HTMLElement) { target.textContent = message; target.hidden = !message }
    }
    const clearErrors = (): void => {
      inline(current, '[data-account-password-current-error]', '')
      inline(next, '[data-account-password-new-error]', '')
      inline(confirm, '[data-account-password-confirm-error]', '')
    }
    if (show instanceof HTMLInputElement) show.addEventListener('change', () => {
      if (!admitted() || busy || completed || uncertain) {
        if (show.closest('[data-account-password]') === root) show.checked = false
        return
      }
      fields.forEach(field => { field.type = show.checked ? 'text' : 'password' })
    })
    fields.forEach(field => { field.addEventListener('input', () => { clearErrors(); lengthRule() }) })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (busy || completed || uncertain || !admitted() || !transport) { lock(); return }
      clearErrors()
      if (!form.reportValidity()) {
        inline(current, '[data-account-password-current-error]', current.validity.valid ? '' : current.validationMessage)
        inline(next, '[data-account-password-new-error]', next.validity.valid ? '' : next.validationMessage)
        inline(confirm, '[data-account-password-confirm-error]', confirm.validity.valid ? '' : confirm.validationMessage)
        note('invalid', copy('The request was refused. Nothing was retried.')); return
      }
      if (next.minLength > 0 && next.value.length < next.minLength) {
        inline(next, '[data-account-password-new-error]', copy('The request was refused. Nothing was retried.'))
        note('invalid', copy('The request was refused. Nothing was retried.')); return
      }
      if (next.value !== confirm.value) {
        inline(confirm, '[data-account-password-confirm-error]', copy('The new passwords do not match.'))
        note('invalid', copy('The new passwords do not match.')); return
      }
      const body = { currentPassword: current.value, newPassword: next.value }
      busy = true; lock(); note('pending', copy('Verifying…'))
      let redirect = false
      try {
        const reply = await transport('POST', '/api/auth/change-password', body)
        if (!object(reply) || reply.ok !== true || reply.reauthenticationRequired !== true) throw new Error('unverified_password_change')
        completed = true; clear(); note('saved', copy('Password changed. Sign in again.')); redirect = true
      } catch (error) {
        const details = object(error) && object(error.details) ? error.details : undefined
        const certainStatus = object(error) && (
          error.status === 400 && error.code === 'VALIDATION'
          || error.status === 401 && error.code === 'UNAUTHENTICATED'
          || error.status === 403 && error.code === 'FORBIDDEN'
          || error.status === 404 && error.code === 'NOT_FOUND')
        const refused = object(error) && (error.stateChanged === false || details?.stateChanged === false || certainStatus)
          && error.stateChanged !== true && details?.stateChanged !== true
          && details?.unknownOutcome !== true && details?.verificationRequired !== true
        if (refused) note('failed', copy('The request was refused. Nothing was retried.'))
        else { uncertain = true; note('uncertain', copy('Current state could not be verified. Further writes remain locked.')) }
      } finally { clear(); busy = false; lock() }
      if (redirect) {
        const lang = document.documentElement.lang
        // The server revoked the credential. No return URL or account identity is accepted from the DOM.
        try { navigate('/login?lang=' + encodeURIComponent(lang)) } catch { /* Verified state and sign-in instruction remain visible. */ }
      }
    })
    lengthRule()
    if (admitted()) note('ready', '')
    else { root.dataset.accountPasswordState = 'unavailable'; status.dataset.state = 'unavailable' }
    lock()
  })
}

export const ACCOUNT_PASSWORD_CLIENT_BINDING = '(' + bindAccountPassword.toString() + ')'
