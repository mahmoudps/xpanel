/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest, withFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest

/** Strict reader for GET /api/server/settings-index. */
export function readSettingsIndexValues(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_settings_index')
  const values = (value as { values?: unknown }).values
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 1000) throw new Error('invalid_settings_index')
  return values as Record<string, unknown>
}

/** Strict reader for GET/PUT /api/server/tweak-settings. */
export function readTweakSettingsView(value: unknown): { state: string; revision: string; values: Record<string, boolean | number | string | null> | null } {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !(value.values === null || object(value.values) && Object.values(value.values).every(item => item === null || ['boolean', 'number', 'string'].includes(typeof item)))) throw new Error('invalid_tweak_settings')
  return { state: String(value.state), revision: value.revision, values: value.values as Record<string, boolean | number | string | null> | null }
}

function bindWhmTweakSettings(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-tweak-settings]').forEach(root => {
    if (root.dataset.tweakBound === 'true') return
    root.dataset.tweakBound = 'true'
    const request = frameRequest(root)
    const status = root.querySelector<HTMLElement>('[data-tweak-status]'), save = root.querySelector<HTMLButtonElement>('[data-tweak-save]'), refresh = root.querySelector<HTMLButtonElement>('[data-tweak-refresh]')
    const search = root.querySelector<HTMLInputElement>('[data-tweak-search]'), empty = root.querySelector<HTMLElement>('[data-tweak-empty]')
    const rows = [...root.querySelectorAll<HTMLElement>('[data-setting-row]')], groups = [...root.querySelectorAll<HTMLElement>('[data-setting-group]')], cells = [...root.querySelectorAll<HTMLElement>('[data-setting-value]')]
    const inputs = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-tweak-input]')]
    const admitted = (): boolean => root.isConnected && root.dataset.tweakCanRead === 'true' && typeof request === 'function'
    const manageable = (): boolean => admitted() && root.dataset.tweakCanManage === 'true'
      && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    let revision: string | null = null, busy = false
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', ['failed', 'unknown'].includes(state) ? 'alert' : 'status') }
    const sync = (): void => {
      for (const input of inputs) input.disabled = busy || !revision || !manageable()
      if (save) save.disabled = busy || !revision || !manageable()
      if (refresh) refresh.disabled = busy || !admitted()
      root.setAttribute('aria-busy', String(busy))
    }
    const shown = (value: unknown): string => value === null || value === undefined ? t('Not set') : value === true ? t('On') : value === false ? t('Off')
      : Array.isArray(value) ? value.join(', ') : typeof value === 'string' && value.length > 80 ? value.slice(0, 80) + '…' : typeof value === 'string' && value.includes('\n') ? value.split('\n')[0] + '…' : String(value)
    const filter = (): void => {
      const query = (search?.value ?? '').trim().toLowerCase()
      let visible = 0
      for (const row of rows) { row.hidden = !!query && !(row.dataset.settingText ?? '').includes(query); if (!row.hidden) visible++ }
      for (const heading of groups) heading.hidden = !rows.some(row => !row.hidden && row.dataset.settingIn === heading.dataset.settingGroup)
      if (empty) empty.hidden = visible > 0
    }
    const paintInputs = (values: Record<string, boolean | number | string | null>): void => {
      for (const input of inputs) {
        const value = values[input.dataset.tweakInput ?? '']
        if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true
        else input.value = value === null || value === undefined ? '' : String(value)
      }
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; sync(); note('reading', t('Reading the saved settings…'))
      try {
        const [index, tweaks] = await Promise.all([request('GET', '/api/server/settings-index').then(readSettingsIndexValues), request('GET', '/api/server/tweak-settings').then(readTweakSettingsView)])
        for (const cell of cells) { const value = index[cell.dataset.settingValue ?? '']; cell.textContent = shown(value) }
        revision = tweaks.state === 'invalid' ? null : tweaks.revision
        if (tweaks.values) paintInputs(tweaks.values)
        note(tweaks.state === 'invalid' ? 'failed' : 'read', tweaks.state === 'invalid' ? t('The saved Tweak Settings file cannot be read and needs review; the defaults apply.') : t('Saved settings read. Each setting changes on the page named beside it.'))
      } catch { revision = null; note('failed', t('The saved settings could not be read. Nothing was changed.')) }
      finally { busy = false; sync() }
    }
    const store = async (): Promise<void> => {
      if (busy || !revision || !manageable() || !request) return
      const values: Record<string, boolean | number | null | string> = {}
      for (const input of inputs) {
        const key = input.dataset.tweakInput ?? ''
        if (input instanceof HTMLInputElement && input.type === 'checkbox') values[key] = input.checked
        else if (input instanceof HTMLInputElement && input.type === 'number') {
          if (input.value.trim() === '') values[key] = null
          else if (/^(?:0|[1-9][0-9]{0,9})$/.test(input.value.trim())) values[key] = Number(input.value.trim())
          else { note('failed', t('Enter whole numbers in the number fields. Nothing was sent.')); return }
        } else values[key] = input.value
      }
      busy = true; sync(); note('saving', t('Saving Tweak Settings…'))
      try {
        const saved = readTweakSettingsView(await request('PUT', '/api/server/tweak-settings', { expectedRevision: revision, values }))
        revision = saved.revision
        if (saved.values) paintInputs(saved.values)
        busy = false
        await load()
        note('saved', t('Tweak Settings were saved and read back. Each consumer reads its value on its next run.'))
      } catch (error) {
        const problem = error && typeof error === 'object' ? error as { status?: number; details?: Record<string, unknown> } : {}
        note(problem.status === 409 ? 'refused' : problem.details?.stateChanged === false ? 'refused' : 'unknown', problem.status === 409 ? t('The settings changed before this save. Nothing was changed; read them again and review.')
          : problem.details?.stateChanged === false ? t('The server refused the values. Nothing was changed; check the fields and try again.') : t('The outcome is unknown. Read the settings again before retrying.'))
      } finally { busy = false; sync() }
    }
    search?.addEventListener('input', filter)
    if (!admitted()) { for (const input of inputs) input.disabled = true; if (save) save.disabled = true; if (refresh) refresh.disabled = true; note('unavailable', t('Saved settings are unavailable here. Nothing was read or changed.')); return }
    save?.addEventListener('click', () => { void store() })
    refresh?.addEventListener('click', () => { void load() })
    void load()
  })
}

export const WHM_TWEAK_SETTINGS_CLIENT_BINDING = withFrameRequest(`(()=>{const readSettingsIndexValues=${readSettingsIndexValues.toString()};const readTweakSettingsView=${readTweakSettingsView.toString()};return ${bindWhmTweakSettings.toString()};})()`)
