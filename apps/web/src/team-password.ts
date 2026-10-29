/// <reference lib="dom" />
import { escapeHtml } from './tokens.ts'
import { translator, type Locale } from './i18n.ts'

/** Hidden set-password form on the xPanel sign-in page; TEAM_PASSWORD_CLIENT_BINDING shows it for a team password link. */
export function renderTeamPasswordSection(locale: Locale | undefined): string {
  const t = (message: string): string => escapeHtml(translator(locale)(message))
  return `<section class="xp-login-team-password" data-team-password hidden aria-labelledby="team-password-heading">
        <h2 id="team-password-heading">${t('Set your team password')}</h2>
        <p class="xp-help">${t('Choose the password you will use to sign in as a team member. This link works once.')}</p>
        <form class="xp-form" data-team-password-form novalidate>
          <div class="xp-field"><label class="xp-label" for="team-password-new">${t('New password')}</label><input id="team-password-new" name="newPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" maxlength="1024" required aria-describedby="team-password-help" /><p class="xp-help" id="team-password-help">${t('At least 8 characters on one line.')}</p></div>
          <div class="xp-field"><label class="xp-label" for="team-password-confirm">${t('Confirm new password')}</label><input id="team-password-confirm" name="confirmPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" maxlength="1024" required /></div>
          <button type="submit" class="xp-btn xp-btn--primary" data-team-password-submit>${t('Save password')}</button>
        </form>
        <p class="xp-help" role="status" data-team-password-status hidden></p>
      </section>`
}

function bindTeamPassword(): void {
  const t = (message: string, values?: Record<string, string>): string => xpT(message, values)
  const section = document.querySelector<HTMLElement>('[data-team-password]'), form = document.querySelector<HTMLFormElement>('[data-team-password-form]')
  const status = document.querySelector<HTMLElement>('[data-team-password-status]'), submit = document.querySelector<HTMLButtonElement>('[data-team-password-submit]')
  const next = document.querySelector<HTMLInputElement>('#team-password-new'), confirm = document.querySelector<HTMLInputElement>('#team-password-confirm')
  const signIn = document.querySelector<HTMLFormElement>('[data-login-form]')
  const match = /^#team-password=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)
  if (!section || !form || !status || !submit || !next || !confirm || !match) return
  const token = match[1]!
  // The secret leaves the address bar and the history entry at once; it stays only in this page's memory.
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  section.hidden = false
  if (signIn) signIn.hidden = true
  const note = (state: string, message: string): void => { status.hidden = false; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  let busy = false
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (busy) return
    const password = next.value
    if (password.length < 8 || /[\r\n]/.test(password)) { next.setAttribute('aria-invalid', 'true'); note('failed', t('Use at least 8 characters on one line.')); return }
    if (password !== confirm.value) { confirm.setAttribute('aria-invalid', 'true'); note('failed', t('The new passwords do not match.')); return }
    next.removeAttribute('aria-invalid'); confirm.removeAttribute('aria-invalid')
    busy = true; submit.disabled = true; note('reading', t('Saving the password...'))
    void (async () => {
      try {
        const response = await fetch('/api/auth/team/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) })
        const body = await response.json().catch(() => null) as { ok?: unknown; login?: unknown } | null
        if (response.ok && body?.ok === true && typeof body.login === 'string' && /^[a-z0-9._-]{1,32}@[a-z0-9.-]{1,253}$/.test(body.login)) {
          next.value = ''; confirm.value = ''; form.hidden = true
          note('ok', t('Your password is saved. Sign in as {login}.', { login: body.login }))
          if (signIn) { signIn.hidden = false; const user = signIn.querySelector<HTMLInputElement>('[name="username"]'); if (user) user.value = body.login }
          return
        }
        note('failed', response.status === 404 ? t('This password link is invalid, already used or expired. Ask the account owner for a new link.')
          : response.status === 403 ? t('This team member cannot set a password now. Ask the account owner.')
            : response.status === 400 ? t('The server refused this password. Use at least 8 characters on one line.') : t('The password could not be saved. Try again.'))
      } catch { note('failed', t('The password could not be saved. Try again.')) }
      finally { busy = false; submit.disabled = false }
    })()
  })
}

export const TEAM_PASSWORD_CLIENT_BINDING = `(${bindTeamPassword.toString()})()`
