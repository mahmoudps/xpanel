/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
const BRANDING_TEXT = ['companyName', 'productName', 'footerText', 'primaryColor', 'accentColor', 'supportUrl', 'supportEmail'] as const
export interface BrandingAssetView { sha256: string; contentType: string; bytes: number; width: number; height: number; uploadedAt: string }
export interface BrandingFields { companyName: string; productName: string; footerText: string; hidePoweredBy: boolean; primaryColor: string; accentColor: string
  supportUrl: string; supportEmail: string; defaultTheme: 'light' | 'dark'; defaultDensity: 'comfortable' | 'compact' }
export interface BrandingView { state: 'default' | 'saved' | 'invalid'; branding: (BrandingFields & { logo: BrandingAssetView | null; favicon: BrandingAssetView | null }) | null; updatedAt: string | null; revision: string }

export function readBrandingView(value: unknown): BrandingView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const stamp = (item: unknown): boolean => typeof item === 'string' && Number.isFinite(Date.parse(item)) && new Date(item).toISOString() === item
  const asset = (item: unknown): boolean => item === null || object(item) && Object.keys(item).sort().join() === 'bytes,contentType,height,sha256,uploadedAt,width'
    && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256) && ['image/png', 'image/jpeg', 'image/x-icon'].includes(item.contentType as string)
    && [item.bytes, item.width, item.height].every(n => Number.isSafeInteger(n) && (n as number) > 0) && stamp(item.uploadedAt)
  if (!object(value) || Object.keys(value).sort().join() !== 'branding,revision,state,updatedAt' || !['default', 'saved', 'invalid'].includes(value.state as string)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)) throw new Error('invalid_branding')
  if (value.state === 'invalid') {
    if (value.branding !== null || value.updatedAt !== null) throw new Error('invalid_branding')
    return { state: 'invalid', branding: null, updatedAt: null, revision: value.revision }
  }
  const b = value.branding
  if (!object(b) || Object.keys(b).sort().join() !== [...BRANDING_TEXT, 'hidePoweredBy', 'defaultTheme', 'defaultDensity', 'logo', 'favicon'].sort().join()
    || BRANDING_TEXT.some(key => typeof b[key] !== 'string' || (b[key] as string).length > 2048) || typeof b.hidePoweredBy !== 'boolean'
    || !['light', 'dark'].includes(b.defaultTheme as string) || !['comfortable', 'compact'].includes(b.defaultDensity as string) || !asset(b.logo) || !asset(b.favicon)
    || (value.state === 'default') !== (value.updatedAt === null) || (value.updatedAt !== null && !stamp(value.updatedAt))) throw new Error('invalid_branding')
  return { state: value.state as 'default' | 'saved', branding: structuredClone(b) as unknown as NonNullable<BrandingView['branding']>, updatedAt: value.updatedAt as string | null, revision: value.revision }
}

function bindWhmPanelBranding(askDialog?: (options: Record<string, unknown>) => Promise<unknown>): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-branding-workspace]').forEach(root => {
    if (root.dataset.brandingBound === 'true') return
    root.dataset.brandingBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const status = one<HTMLElement>('[data-branding-status]'), saveStatus = one<HTMLElement>('[data-branding-save-status]'), assetStatus = one<HTMLElement>('[data-branding-asset-status]')
    const save = one<HTMLButtonElement>('[data-branding-save]'), reload = one<HTMLButtonElement>('[data-branding-reload]'), stateField = one<HTMLElement>('[data-branding-state]'), updated = one<HTMLElement>('[data-branding-updated]')
    const field = (key: string): HTMLInputElement | HTMLSelectElement | null => one<HTMLInputElement | HTMLSelectElement>('[data-branding-input="' + key + '"]')
    const keys = [...BRANDING_TEXT, 'hidePoweredBy', 'defaultTheme', 'defaultDensity'] as const
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!status || !saveStatus || !assetStatus || !save || !reload || !stateField || !updated || keys.some(key => !field(key))) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.brandingCanManage === 'true' && !root.closest(denied) && typeof request === 'function'
    let view: BrandingView | null = null, busy = false
    const note = (target: HTMLElement, state: string, text: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = text; target.setAttribute('role', state === 'failed' || state === 'stale' ? 'alert' : 'status') }
    const lock = (): void => {
      const off = busy || !view?.branding || !admitted()
      for (const key of keys) field(key)!.disabled = off
      save.disabled = off; reload.disabled = busy || !admitted()
      for (const kind of ['logo', 'favicon'] as const) {
        const upload = one<HTMLButtonElement>('[data-branding-upload="' + kind + '"]'), remove = one<HTMLButtonElement>('[data-branding-remove="' + kind + '"]')
        if (upload) upload.disabled = off
        const picker = one<HTMLInputElement>('[data-branding-file="' + kind + '"]')
        if (picker) picker.disabled = off
        if (remove) remove.disabled = off || !view?.branding?.[kind]
      }
      root.setAttribute('aria-busy', String(busy))
    }
    const paint = (next: BrandingView): void => {
      view = next
      const b = next.branding
      if (b) for (const key of keys) {
        const control = field(key)!
        if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = b[key] as boolean
        else control.value = b[key] as string
      }
      for (const kind of ['logo', 'favicon'] as const) {
        const item = b?.[kind] ?? null, state = one<HTMLElement>('[data-branding-asset-state="' + kind + '"]'), preview = one<HTMLElement>('[data-branding-preview="' + kind + '"]')
        if (state) state.textContent = !b ? t('Unavailable') : item ? t('{width} × {height} pixels, {size} KiB', { width: item.width, height: item.height, size: Math.ceil(item.bytes / 1024) }) : t('None uploaded')
        if (preview) {
          preview.replaceChildren()
          if (item) { const image = document.createElement('img'); image.alt = ''; image.src = '/branding/' + kind + '?v=' + item.sha256.slice(0, 16); preview.append(image) }
        }
      }
      stateField.textContent = next.state === 'saved' ? t('Saved') : next.state === 'default' ? t('Built-in defaults') : t('Requires review')
      updated.replaceChildren()
      if (next.updatedAt) { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = formatDisplayDateTime(next.updatedAt); updated.append(bdi) }
      else updated.textContent = t(msgctxt('whm-panel-branding-client', 'Never saved'))
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'saved' ? t('Saved branding read.') : next.state === 'default'
        ? t('No branding has been saved. The built-in identity is shown.') : t('The saved branding could not be verified. Review the branding file on the server before changing it.'))
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; unknownOutcome?: boolean; stateChanged?: boolean; fields?: { field?: string; code?: string }[] } }
      if (item?.details?.verificationRequired || item?.details?.unknownOutcome || item?.details?.stateChanged === true) return t('The change could not be verified. Reload the branding before changing it again.')
      if (item?.status === 409) return t('The branding changed since it was read. Reload before saving again.')
      if (item?.status === 401 || item?.status === 403) return t('Root access is required to manage branding.')
      const first = item?.details?.fields?.[0]
      if (first?.field === 'logo' || first?.field === 'favicon') return first.code === 'size' ? t('The image is too large.') : first.code === 'dimensions' ? t('The image dimensions are outside the allowed range.') : t('This image type is not accepted.')
      if (first?.field === 'primaryColor' || first?.field === 'accentColor') return t('Colors are written like #1D5BD6, or left empty.')
      if (first?.field === 'supportUrl') return t('The support URL must start with https://.')
      if (first?.field === 'supportEmail') return t('Enter one support email address, like help@example.com.')
      if (first?.field) return t('Names and footer text are plain text without “<” or “>”.')
      return fallback
    }
    const verify = async (ack: BrandingView): Promise<void> => {
      const verified = readBrandingView(await request!('GET', '/api/server/panel/branding'))
      if (verified.revision !== ack.revision || JSON.stringify(verified.branding) !== JSON.stringify(ack.branding)) throw new Error('unverified_save')
      paint(verified)
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; view = null; lock(); note(status, 'reading', t('Reading branding…'))
      try { paint(readBrandingView(await request('GET', '/api/server/panel/branding'))) }
      catch (error) { note(status, 'failed', failure(error, t('Branding could not be read. Nothing was changed.'))) }
      finally { busy = false; lock() }
    }
    if (!admitted()) { lock(); note(status, 'unavailable', t('Branding is unavailable here. Nothing was read or changed.')); return }
    reload.addEventListener('click', () => { saveStatus.hidden = true; assetStatus.hidden = true; void load() })
    save.addEventListener('click', async () => {
      const before = view
      if (busy || !before?.branding || !admitted() || !request) return
      const desired: Record<string, unknown> = {}
      for (const key of keys) { const control = field(key)!; desired[key] = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value.trim() }
      if (typeof desired.primaryColor === 'string') desired.primaryColor = (desired.primaryColor as string).toLowerCase()
      if (typeof desired.accentColor === 'string') desired.accentColor = (desired.accentColor as string).toLowerCase()
      busy = true; lock(); note(saveStatus, 'reading', t('Saving branding…'))
      try {
        const ack = readBrandingView(await request('PUT', '/api/server/panel/branding', { ...desired, expectedRevision: before.revision }))
        if (ack.state !== 'saved' || keys.some(key => ack.branding![key] !== desired[key])) throw new Error('unverified_save')
        await verify(ack); note(saveStatus, 'saved', t('Branding saved and read back. It applies to the next page each person opens.'))
      } catch (error) { view = null; note(saveStatus, (error as { status?: number })?.status === 409 ? 'stale' : 'failed', failure(error, t('The change could not be verified. Reload the branding before changing it again.'))) }
      finally { busy = false; lock() }
    })
    for (const kind of ['logo', 'favicon'] as const) {
      const file = one<HTMLInputElement>('[data-branding-file="' + kind + '"]'), upload = one<HTMLButtonElement>('[data-branding-upload="' + kind + '"]'), remove = one<HTMLButtonElement>('[data-branding-remove="' + kind + '"]')
      if (!file || !upload || !remove) continue
      const limit = kind === 'logo' ? 512 * 1024 : 128 * 1024
      const send = async (method: 'PUT' | 'DELETE', body?: Blob): Promise<void> => {
        const before = view
        if (busy || !before?.branding || !admitted() || !request) return
        busy = true; lock(); note(assetStatus, 'reading', method === 'PUT' ? t('Uploading…') : t('Removing…'))
        try {
          const path = '/api/server/panel/branding/' + kind + '?expectedRevision=' + before.revision
          const ack = readBrandingView(await (body ? request(method, path, body) : request(method, path)))
          if (ack.state !== 'saved' || (method === 'PUT') !== !!ack.branding![kind]) throw new Error('unverified_save')
          await verify(ack); note(assetStatus, 'saved', method === 'PUT' ? t('Image uploaded and read back.') : t('Image removed and read back.'))
        } catch (error) { view = null; note(assetStatus, (error as { status?: number })?.status === 409 ? 'stale' : 'failed', failure(error, t('The change could not be verified. Reload the branding before changing it again.'))) }
        finally { busy = false; lock() }
      }
      upload.addEventListener('click', () => { if (!upload.disabled) file.click() })
      file.addEventListener('change', () => {
        const chosen = file.files?.[0]
        file.value = ''
        if (!chosen) return
        if (chosen.size > limit) { note(assetStatus, 'failed', t('The image is too large.')); return }
        const type = chosen.type || (/\.ico$/i.test(chosen.name) ? 'image/x-icon' : '')
        void send('PUT', type === chosen.type ? chosen : new Blob([chosen], { type }))
      })
      remove.addEventListener('click', async () => {
        if (remove.disabled) return
        if (!askDialog) { note(assetStatus, 'failed', t('Confirmation is unavailable. Nothing was sent.')); return }
        const approved = await askDialog({ title: kind === 'logo' ? t('Remove the panel logo?') : t('Remove the favicon?'), danger: true, confirm: t('Remove'),
          body: t('The built-in image is shown again on the next page each person opens.') }).catch(() => false)
        if (approved === true) void send('DELETE')
      })
    }
    void load()
  })
}
export const WHM_PANEL_BRANDING_CLIENT_BINDING = `(()=>{const BRANDING_TEXT=${JSON.stringify(BRANDING_TEXT)};const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readBrandingView=${readBrandingView.toString()};return ${bindWhmPanelBranding.toString()};})()`
