/// <reference lib="dom" />

export interface UiThemePreferencesView {
  readonly state: 'default' | 'saved' | 'invalid'
  readonly uiTheme: string | null
  readonly choices: readonly string[]
  readonly revision: string
  readonly updatedAt: string | null
  readonly application: 'next_navigation'
}

/** The server supplies the registered choices and the revision of this session owner's record. */
export function readUiThemePreferencesView(value: unknown): UiThemePreferencesView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || Object.keys(value).sort().join() !== 'application,choices,revision,state,uiTheme,updatedAt'
    || !['default', 'saved', 'invalid'].includes(value.state as string) || value.application !== 'next_navigation'
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Array.isArray(value.choices) || !value.choices.length || value.choices.length > 32
    || value.choices.some(choice => typeof choice !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(choice))
    || new Set(value.choices).size !== value.choices.length) throw new Error('invalid_ui_preferences')
  if (value.state === 'invalid') {
    if (value.uiTheme !== null || value.updatedAt !== null) throw new Error('invalid_ui_preferences')
  } else {
    if (typeof value.uiTheme !== 'string' || !value.choices.includes(value.uiTheme)) throw new Error('invalid_ui_preferences')
    if (value.state === 'default' && value.updatedAt !== null) throw new Error('invalid_ui_preferences')
    if (value.state === 'saved' && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || new Date(value.updatedAt).toISOString() !== value.updatedAt)) throw new Error('invalid_ui_preferences')
  }
  return { state: value.state as UiThemePreferencesView['state'], uiTheme: value.uiTheme as string | null,
    choices: [...value.choices] as string[], revision: value.revision, updatedAt: value.updatedAt as string | null,
    application: 'next_navigation' }
}

/** Presentation comes from the owning theme; this controller supplies session transport and save/readback state. */
export function bindUiThemePreferences(reload: () => void = () => window.location.reload()): void {
  document.querySelectorAll<HTMLElement>('[data-ui-theme-preferences]').forEach(root => {
    if (root.dataset.uiThemeBound === 'true') return
    root.dataset.uiThemeBound = 'true'
    const t = (message: string): string => xpT(message)
    const unique = <T extends Element>(selector: string): T | null => {
      const found = root.querySelectorAll<T>(selector)
      return found.length === 1 ? found[0]! : null
    }
    const form = unique<HTMLFormElement>('form[data-ui-theme-form]')
    const select = unique<HTMLSelectElement>('select[data-ui-theme-choice]')
    const save = unique<HTMLButtonElement>('button[data-ui-theme-save]')
    const refresh = unique<HTMLButtonElement>('button[data-ui-theme-reload]')
    const status = unique<HTMLElement>('[data-ui-theme-status]')
    if (!form || !select || !save || !refresh || !status || save.type !== 'submit' || refresh.type !== 'button') return
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const options = new Map<string, HTMLOptionElement>()
    for (const option of Array.from(select.options)) {
      if (options.has(option.value)) return
      options.set(option.value, option.cloneNode(true) as HTMLOptionElement)
    }
    let view: UiThemePreferencesView | undefined, busy = false, writable = false
    const admitted = (): boolean => root.isConnected && root.dataset.uiThemeCanRead === 'true' && typeof request === 'function'
      && (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest === request
    const personalSession = (): boolean => !document.querySelector('[data-impersonation]')
    const note = (state: string, message: string): void => {
      root.hidden = false
      status.hidden = false
      status.dataset.state = state
      status.textContent = message
      status.setAttribute('role', state === 'failed' ? 'alert' : 'status')
    }
    const lock = (): void => {
      select.disabled = busy || !writable || !admitted() || !personalSession()
      save.disabled = select.disabled || select.value === view?.uiTheme
      refresh.disabled = busy || !admitted()
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: UiThemePreferencesView): void => {
      if (next.choices.some(choice => !options.has(choice))) throw new Error('ui_theme_presentation_unavailable')
      view = next
      writable = next.state !== 'invalid' && next.choices.length > 1 && personalSession()
      select.replaceChildren(...next.choices.map(choice => options.get(choice)!.cloneNode(true)))
      if (next.uiTheme !== null) select.value = next.uiTheme
      form.hidden = next.choices.length <= 1
      refresh.hidden = next.choices.length <= 1 && next.state !== 'invalid'
      root.hidden = next.choices.length <= 1 && next.state !== 'invalid'
      status.hidden = next.state !== 'invalid'
      if (next.state === 'invalid') note('failed', t('The saved interface choice could not be verified. Ask an administrator to review it before changing it.'))
      else if (next.choices.length > 1 && !personalSession()) note('readonly', t('Your personal interface choice cannot be changed from a handed-off session.'))
      lock()
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean; unknownOutcome?: boolean } }
      if (item?.details?.verificationRequired || item?.details?.stateChanged || item?.details?.unknownOutcome) return t('The interface choice save could not be verified. Reload the choice before saving again.')
      if (item?.status === 409) return t('The interface choice changed since it was read. Reload it before saving again.')
      if (item?.status === 401) return t('Sign in again to change your interface choice.')
      if (item?.status === 403) return t('Changing the interface choice is unavailable for this session.')
      return fallback
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; view = undefined; writable = false; form.hidden = true; refresh.hidden = false; lock()
      note('reading', t('Reading your interface choice…'))
      try {
        const next = readUiThemePreferencesView(await request('GET', '/api/auth/ui-preferences'))
        if (!admitted()) return
        paint(next)
      } catch (error) {
        if (root.isConnected) note('failed', failure(error, t('The interface choices could not be read. Nothing was changed.')))
      } finally { busy = false; lock() }
    }
    if (!admitted()) { lock(); return }
    select.addEventListener('change', lock)
    refresh.addEventListener('click', () => { void load() })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (busy || !writable || !view || !admitted() || !personalSession() || !request || !view.choices.includes(select.value) || select.value === view.uiTheme) return
      const desired = select.value, expected = view
      let apply = false
      busy = true; lock(); note('saving', t('Saving your interface choice…'))
      try {
        const ack = readUiThemePreferencesView(await request('PUT', '/api/auth/ui-preferences', { uiTheme: desired, expectedRevision: expected.revision }))
        if (!admitted() || ack.state !== 'saved' || ack.uiTheme !== desired || JSON.stringify(ack.choices) !== JSON.stringify(expected.choices)) throw new Error('unverified_ui_preference_save')
        const readback = readUiThemePreferencesView(await request('GET', '/api/auth/ui-preferences'))
        if (!admitted() || readback.state !== 'saved' || readback.uiTheme !== ack.uiTheme || readback.revision !== ack.revision
          || readback.updatedAt !== ack.updatedAt || JSON.stringify(readback.choices) !== JSON.stringify(ack.choices)) throw new Error('unverified_ui_preference_save')
        paint(readback)
        note('verified', t('Interface choice saved and read back. Reloading this page…'))
        writable = false
        apply = true
      } catch (error) {
        writable = false; view = undefined
        if (root.isConnected) note('failed', failure(error, t('The interface choice save could not be verified. Reload the choice before saving again.')))
      } finally { busy = false; lock() }
      if (apply && admitted()) {
        try { reload() }
        catch { note('verified', t('Interface choice saved and read back. Reload this page to apply it.')) }
      }
    })
    void load()
  })
}

export const UI_THEME_CLIENT_BINDING = `(()=>{const readUiThemePreferencesView=${readUiThemePreferencesView.toString()};return ${bindUiThemePreferences.toString()};})()`
