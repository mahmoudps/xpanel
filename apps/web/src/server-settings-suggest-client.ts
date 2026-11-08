/// <reference lib="dom" />
import './i18n.ts'

function bindServerSettingsDraft(): void {
  const t = (message: string): string => xpT(message)
  const say = (text: string): void => {
    const status = document.querySelector<HTMLElement>('[data-server-settings-status]')
    if (status) { status.hidden = false; status.dataset.state = 'read'; status.textContent = text }
  }
  document.querySelectorAll<HTMLButtonElement>('[data-server-settings-suggest]').forEach(button => {
    if (button.dataset.draftBound === 'true') return
    button.dataset.draftBound = 'true'
    button.addEventListener('click', () => {
      const form = document.querySelector<HTMLFormElement>('[data-server-settings-form]')
      if (!form) return
      let values: Record<string, unknown>
      try { values = JSON.parse(button.dataset.serverSettingsSuggest ?? '') as Record<string, unknown> } catch { return }
      for (const [name, value] of Object.entries(values)) {
        const control = form.elements.namedItem(name)
        if (!(control instanceof HTMLInputElement) || control.disabled) continue
        if (control.type === 'checkbox') control.checked = value === true
        else control.value = String(value)
      }
      say(t('Suggested values are filled in. Nothing changes until you save.'))
    })
  })
  document.querySelectorAll<HTMLButtonElement>('[data-server-settings-discard]').forEach(button => {
    if (button.dataset.draftBound === 'true') return
    button.dataset.draftBound = 'true'
    button.addEventListener('click', () => {
      document.querySelector<HTMLFormElement>('[data-server-settings-form]')?.reset()
      say(t('Unsaved changes were discarded.'))
    })
  })
}

export const SERVER_SETTINGS_SUGGEST_CLIENT_BINDING = `(${bindServerSettingsDraft.toString()})();`
