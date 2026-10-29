/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
export interface PanelSettingsFields { offlineMode: boolean; offlineMessage: string; developerMode: boolean; liveUpdates: boolean; reverseProxyAllowedHosts: string[] }
export interface PanelSettingsView { state: 'default' | 'saved' | 'invalid'; settings: PanelSettingsFields | null; updatedAt: string | null; revision: string }

export function readPanelSettingsView(value: unknown): PanelSettingsView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || Object.keys(value).sort().join() !== 'revision,settings,state,updatedAt' || !['default', 'saved', 'invalid'].includes(value.state as string)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error('invalid_panel_settings')
  if (value.state === 'invalid') {
    if (value.settings !== null || value.updatedAt !== null) throw new Error('invalid_panel_settings')
    return { state: 'invalid', settings: null, updatedAt: null, revision: value.revision }
  }
  const raw = value.settings
  if (!object(raw) || Object.keys(raw).sort().join() !== 'developerMode,liveUpdates,offlineMessage,offlineMode,reverseProxyAllowedHosts'
    || ['offlineMode', 'developerMode', 'liveUpdates'].some(key => typeof raw[key] !== 'boolean') || typeof raw.offlineMessage !== 'string' || raw.offlineMessage.length > 280
    || !Array.isArray(raw.reverseProxyAllowedHosts) || raw.reverseProxyAllowedHosts.length > 32 || raw.reverseProxyAllowedHosts.some(host => typeof host !== 'string' || !/^[0-9a-z.:-]{1,253}$/.test(host))) throw new Error('invalid_panel_settings')
  if ((value.state === 'default') !== (value.updatedAt === null) || (value.updatedAt !== null && (typeof value.updatedAt !== 'string' || new Date(value.updatedAt).toISOString() !== value.updatedAt))) throw new Error('invalid_panel_settings')
  return { state: value.state as 'default' | 'saved', settings: { offlineMode: raw.offlineMode as boolean, offlineMessage: raw.offlineMessage, developerMode: raw.developerMode as boolean,
    liveUpdates: raw.liveUpdates as boolean, reverseProxyAllowedHosts: [...raw.reverseProxyAllowedHosts] as string[] }, updatedAt: value.updatedAt as string | null, revision: value.revision }
}

function bindWhmPanelSettings(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-panel-settings-workspace]').forEach(root => {
    if (root.dataset.panelSettingsBound === 'true') return
    root.dataset.panelSettingsBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-panel-settings-status]'), saveStatus = one<HTMLElement>('[data-panel-settings-save-status]'), updated = one<HTMLElement>('[data-panel-settings-updated]')
    const save = one<HTMLButtonElement>('[data-panel-settings-save]'), reload = one<HTMLButtonElement>('[data-panel-settings-reload]')
    const input = <T extends HTMLElement>(key: string): T | null => one<T>('[data-panel-settings-input="' + key + '"]')
    const offline = input<HTMLInputElement>('offlineMode'), message = input<HTMLTextAreaElement>('offlineMessage'), developer = input<HTMLInputElement>('developerMode')
    const live = input<HTMLInputElement>('liveUpdates'), hosts = input<HTMLTextAreaElement>('reverseProxyAllowedHosts')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !saveStatus || !updated || !save || !reload || !offline || !message || !developer || !live || !hosts) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.panelSettingsCanManage === 'true' && !root.closest(denied) && typeof request === 'function'
    let view: PanelSettingsView | null = null, busy = false
    const note = (target: HTMLElement, state: string, text: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = text; target.setAttribute('role', state === 'failed' || state === 'stale' ? 'alert' : 'status') }
    const lock = (): void => {
      const off = busy || !view?.settings || view.state === 'invalid' || !admitted()
      for (const control of [offline, developer, live, hosts, save]) control.disabled = off
      message.disabled = off || !offline.checked
      reload.disabled = busy || !admitted(); root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: PanelSettingsView): void => {
      view = next
      if (next.settings) {
        offline.checked = next.settings.offlineMode; message.value = next.settings.offlineMessage; developer.checked = next.settings.developerMode
        live.checked = next.settings.liveUpdates; hosts.value = next.settings.reverseProxyAllowedHosts.join('\n')
      }
      updated.replaceChildren()
      if (next.updatedAt) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = formatDisplayDateTime(next.updatedAt); updated.append(bdi) }
      else updated.textContent = t(msgctxt('whm-panel-settings-client', 'Never saved'))
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'saved' ? t('Saved panel settings read.') : next.state === 'default'
        ? t('No panel settings have been saved. The built-in defaults are in effect.')
        : t('The saved panel settings could not be verified. Review the settings file on the server before changing them.'))
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; unknownOutcome?: boolean; stateChanged?: boolean; fields?: { field?: string }[] } }
      if (item?.details?.verificationRequired || item?.details?.unknownOutcome || item?.details?.stateChanged === true) return t('The save could not be verified. Reload the settings before saving again.')
      if (item?.status === 409) return t('The settings changed since they were read. Reload before saving again.')
      if (item?.status === 401 || item?.status === 403) return t('Root access is required to manage panel settings.')
      const field = item?.details?.fields?.[0]?.field
      if (field === 'reverseProxyAllowedHosts') return t('Each remote host must be an IP address or a host name, listed once, at most 32.')
      if (field === 'offlineMessage') return t('The maintenance message is plain text of at most 280 characters.')
      if (item?.status === 400 || item?.status === 422) return t('The server refused these settings. Nothing was changed.')
      return fallback
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; view = null; lock(); note(status, 'reading', t('Reading panel settings…'))
      try { paint(readPanelSettingsView(await request('GET', '/api/server/panel/settings'))) }
      catch (error) { note(status, 'failed', failure(error, t('Panel settings could not be read. Nothing was changed.'))) }
      finally { busy = false; lock() }
    }
    if (!admitted()) { lock(); note(status, 'unavailable', t('Panel settings are unavailable here. Nothing was read or changed.')); return }
    offline.addEventListener('change', lock)
    reload.addEventListener('click', () => { saveStatus.hidden = true; void load() })
    save.addEventListener('click', async () => {
      const before = view
      if (busy || !before?.settings || before.state === 'invalid' || !admitted() || !request) return
      const desired: PanelSettingsFields = { offlineMode: offline.checked, offlineMessage: message.value.trim(), developerMode: developer.checked, liveUpdates: live.checked,
        reverseProxyAllowedHosts: hosts.value.split('\n').map(line => line.trim()).filter(Boolean) }
      if (desired.offlineMode && !before.settings.offlineMode) {
        if (!askDialog) { note(saveStatus, 'failed', t('Confirmation is unavailable. Nothing was sent.')); return }
        const approved = await askDialog({ title: t('Take the panels offline?'), danger: true, confirm: t('Go offline'),
          body: t('Everyone except root sees the maintenance page and can only sign out until you turn offline mode off.') }).catch(() => false)
        if (approved !== true || view !== before) return
      }
      busy = true; lock(); note(saveStatus, 'reading', t('Saving panel settings…'))
      try {
        const ack = readPanelSettingsView(await request('PUT', '/api/server/panel/settings', { ...desired, expectedRevision: before.revision }))
        const verified = readPanelSettingsView(await request('GET', '/api/server/panel/settings'))
        if (ack.state !== 'saved' || verified.revision !== ack.revision || JSON.stringify(verified.settings) !== JSON.stringify(ack.settings)
          || ack.settings!.offlineMode !== desired.offlineMode || ack.settings!.developerMode !== desired.developerMode || ack.settings!.liveUpdates !== desired.liveUpdates) throw new Error('unverified_save')
        paint(verified); note(saveStatus, 'saved', t('Panel settings saved and read back. They apply to the next request.'))
      } catch (error) { view = null; note(saveStatus, (error as { status?: number })?.status === 409 ? 'stale' : 'failed', failure(error, t('The save could not be verified. Reload the settings before saving again.'))) }
      finally { busy = false; lock() }
    })
    void load()
  })
}
export const WHM_PANEL_SETTINGS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readPanelSettingsView=${readPanelSettingsView.toString()};return ${bindWhmPanelSettings.toString()};})()`
