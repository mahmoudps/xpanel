/// <reference lib="dom" />

/** A local creation aid: this value is never applied to an existing credential. */
export function generateMailboxPassword(random: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  if (!random || typeof random.getRandomValues !== 'function') throw new Error('secure_random_unavailable')
  const choose = (size: number): number => {
    const limit = Math.floor(256 / size) * size
    const byte = new Uint8Array(1)
    for (let attempt = 0; attempt < 128; attempt++) {
      random.getRandomValues(byte)
      if (byte[0]! < limit) return byte[0]! % size
    }
    throw new Error('secure_random_unavailable')
  }
  const categories = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$%^&*()-_=+[]{}:,.?']
  const alphabet = categories.join('')
  const chars = categories.map(category => category[choose(category.length)]!)
  while (chars.length < 24) chars.push(alphabet[choose(alphabet.length)]!)
  for (let index = chars.length - 1; index > 0; index--) {
    const other = choose(index + 1)
    const current = chars[index]!
    chars[index] = chars[other]!
    chars[other] = current
  }
  return chars.join('')
}

function bindMailboxPasswordGenerator(): void {
  const unavailable = 'fieldset:disabled,[aria-disabled="true"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[data-wiring="soon"],[data-wiring="unavailable"]'
  document.querySelectorAll<HTMLButtonElement>('button[data-account-toggle-password]').forEach(button => {
    if (button.dataset.passwordRevealBound === 'true') return
    button.dataset.passwordRevealBound = 'true'
    button.addEventListener('click', event => {
      event.preventDefault()
      const form = button.closest<HTMLFormElement>('form[data-create-account-form]')
      const target = button.dataset.passwordTarget ? document.getElementById(button.dataset.passwordTarget) : null
      if (!form || button.disabled || button.closest(unavailable) || !(target instanceof HTMLInputElement) || target.form !== form || target.name !== 'password' || !['password', 'text'].includes(target.type) || target.autocomplete !== 'new-password' || target.readOnly || target.matches(':disabled') || target.closest(unavailable)) return
      const reveal = target.type === 'password'
      target.type = reveal ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(reveal))
      const ar = document.documentElement.lang === 'ar'
      const label = reveal ? (ar ? 'إخفاء كلمة المرور' : 'Hide password') : (ar ? 'إظهار كلمة المرور' : 'Reveal password')
      button.textContent = label; button.title = label; button.setAttribute('aria-label', label)
      target.focus()
    })
  })
  document.querySelectorAll<HTMLButtonElement>('button[data-password-generate],button[data-account-generate-password]').forEach(button => {
    if (button.dataset.passwordGenerateBound === 'true') return
    button.dataset.passwordGenerateBound = 'true'
    button.addEventListener('click', event => {
      event.preventDefault()
      const accountCreation = button.hasAttribute('data-account-generate-password')
      const form = button.closest<HTMLFormElement>(accountCreation ? 'form[data-create-account-form]' : 'form[data-mailbox-form]')
      if (!form || button.disabled || button.closest(unavailable)) return
      const targetId = button.dataset.passwordTarget
      const target = targetId ? document.getElementById(targetId) : null
      if (!(target instanceof HTMLInputElement) || target.form !== form || !['password', 'text'].includes(target.type) || target.name !== 'password' || target.readOnly || target.matches(':disabled') || target.closest(unavailable) || target.autocomplete !== 'new-password') return
      const status = form.querySelector<HTMLElement>(accountCreation ? '[data-account-create-status]' : '[data-mailbox-status]')
      const ar = document.documentElement.lang === 'ar'
      try {
        const password = generateMailboxPassword()
        if ((target.maxLength > 0 && target.maxLength < password.length) || target.minLength > password.length) return
        target.value = password
        target.dispatchEvent(new Event('input', { bubbles: true }))
        target.focus()
        if (status) { status.hidden = false; status.textContent = ar ? 'تم توليد كلمة المرور محليًا. لم تُرسل تغييرات.' : 'Password generated locally. No changes have been sent.'; status.dataset.state = 'idle' }
      } catch {
        if (status) { status.hidden = false; status.textContent = ar ? 'تعذر التوليد الآمن. أدخل كلمة المرور بنفسك.' : 'Secure generation is unavailable. Enter a password yourself.'; status.dataset.state = 'failed' }
      }
    })
  })
}

export const PASSWORD_GENERATOR_CLIENT_BINDING = '(() => { ' + generateMailboxPassword.toString() + '; (' + bindMailboxPasswordGenerator.toString() + ')(); })();'
