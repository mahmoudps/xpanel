import type { MessageValues } from './i18n.ts'
import './i18n.ts'
interface DefaultSitePolicy { response: 'reject' | 'redirect'; redirectTo: string | null; refuseHttps: boolean }
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime
interface DefaultSiteRead { policy: DefaultSitePolicy; revision: string; qualified: boolean; application: 'unverified' | 'not_requested' | 'global_configuration_applied' }
const defaultSiteObject = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
export function defaultSitePolicy(raw: unknown): DefaultSitePolicy | null {
  if (!defaultSiteObject(raw) || !['reject', 'redirect'].includes(String(raw.response)) || typeof raw.refuseHttps !== 'boolean') return null
  if (raw.response === 'reject') return raw.redirectTo === null ? { response: 'reject', redirectTo: null, refuseHttps: raw.refuseHttps } : null
  if (typeof raw.redirectTo !== 'string' || !raw.redirectTo || raw.redirectTo.length > 2048 || !raw.redirectTo.isWellFormed() || /[\u0000-\u0020\u007f-\u009f\\$]/.test(raw.redirectTo)) return null
  try {
    const target = new URL(raw.redirectTo)
    if (!['http:', 'https:'].includes(target.protocol) || !target.hostname || target.username || target.password || target.href.length > 2048) return null
    return { response: 'redirect', redirectTo: target.href, refuseHttps: raw.refuseHttps }
  } catch { return null }
}
export function readDefaultSite(raw: unknown): DefaultSiteRead | null {
  if (!defaultSiteObject(raw) || !defaultSiteObject(raw.configuration) || !defaultSiteObject(raw.actions) || typeof raw.actions.save !== 'boolean' || !defaultSiteObject(raw.application)
    || raw.application.targetVerified !== false || !['unverified', 'not_requested', 'global_configuration_applied'].includes(String(raw.application.status))) return null
  const view = raw.configuration, policy = defaultSitePolicy(view.policy)
  if (!policy || view.state !== 'read' || view.source !== 'saved-server-settings' || typeof view.explicitPolicy !== 'boolean' || typeof view.revision !== 'string' || !/^[0-9a-f]{64}$/.test(view.revision)) return null
  return { policy, revision: view.revision, qualified: raw.actions.save, application: raw.application.status as DefaultSiteRead['application'] }
}
function bindWhmDefaultSite(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues) => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
  document.querySelectorAll<HTMLElement>('[data-default-site-workspace]').forEach(root => {
    if (root.dataset.defaultSiteBound === 'true') return
    root.dataset.defaultSiteBound = 'true'
    const form = root.querySelector<HTMLElement>('[data-default-site-form]')!, response = root.querySelector<HTMLSelectElement>('[data-default-site-response]')!, redirect = root.querySelector<HTMLInputElement>('[data-default-site-redirect]')!, refuse = root.querySelector<HTMLInputElement>('[data-default-site-refuse-https]')!
    const save = root.querySelector<HTMLButtonElement>('[data-default-site-save]')!, discard = root.querySelector<HTMLButtonElement>('[data-default-site-discard]')!, refresh = root.querySelector<HTMLButtonElement>('[data-default-site-refresh]')!
    const status = root.querySelector<HTMLElement>('[data-default-site-status]')!, logs = root.querySelector<HTMLTableSectionElement>('[data-default-site-requests]')!, logStatus = root.querySelector<HTMLElement>('[data-default-site-observation-status]')!
    if (![form, response, redirect, refuse, save, discard, refresh, status, logs, logStatus].every(Boolean)) return
    const admitted = () => root.isConnected && root.dataset.defaultSiteEnabled === 'true' && !!request && !root.closest('[data-capability-state="unavailable"],[data-capability-state="soon"],[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[aria-disabled="true"],fieldset:disabled')
    let view: DefaultSiteRead | null = null, busy = false, uncertain = false, stale = false, generation = 0
    const draft = () => ({ response: response.value, redirectTo: response.value === 'redirect' ? redirect.value : null, refuseHttps: refuse.checked })
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const dirty = () => !!view && !same(defaultSitePolicy(draft()) ?? draft(), view.policy)
    const announce = (state: string, text: string) => { status.dataset.state = state; status.textContent = text; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const controls = () => {
      const disabled = !admitted() || !view || !view.qualified || busy || uncertain || stale
      response.disabled = disabled; redirect.disabled = disabled || response.value !== 'redirect'; refuse.disabled = disabled
      save.disabled = disabled || !dirty() || !defaultSitePolicy(draft()) || !askDialog
      refresh.disabled = !admitted() || busy; discard.disabled = !admitted() || busy || !dirty() && !uncertain && !stale
      root.setAttribute('aria-busy', String(busy)); root.dataset.dirty = String(dirty())
    }
    const install = (next: DefaultSiteRead) => { view = next; response.value = next.policy.response; redirect.value = next.policy.redirectTo ?? ''; refuse.checked = next.policy.refuseHttps }
    const renderLogs = (raw: unknown) => {
      if (!defaultSiteObject(raw) || !defaultSiteObject(raw.observation)) throw new Error('invalid_observation')
      const data = raw.observation
      if (!['read', 'partial', 'unavailable'].includes(String(data.state)) || data.source !== 'nginx-default-access-log' || data.limit !== 100 || typeof data.observedAt !== 'string' || data.observedAt.length > 40 || !Number.isFinite(Date.parse(data.observedAt)) || typeof data.truncated !== 'boolean' || !Number.isSafeInteger(data.malformedRecords) || Number(data.malformedRecords) < 0 || !Array.isArray(data.items) || data.items.length > 100) throw new Error('invalid_observation')
      if (data.state === 'read' && data.malformedRecords !== 0 || data.state === 'partial' && data.malformedRecords === 0) throw new Error('inconsistent_observation')
      if (data.state === 'unavailable') { if (data.items.length || data.reason !== 'default_log_unavailable') throw new Error('invalid_unavailable'); logs.textContent = ''; const row = logs.insertRow(), cell = row.insertCell(); cell.colSpan = 4; cell.textContent = t('Request observations are unavailable.'); logStatus.dataset.state = 'unavailable'; logStatus.textContent = t('The native default-vhost log was not observed. This is not an empty request history.'); return }
      const rows = data.items.map(raw => {
        if (!defaultSiteObject(raw) || typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at)) || typeof raw.host !== 'string' || !raw.host || raw.host.length > 1024 || !raw.host.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(raw.host)
          || typeof raw.address !== 'string' || !/^[0-9a-fA-F:.]{1,64}$/.test(raw.address) || !Number.isInteger(raw.status) || Number(raw.status) < 100 || Number(raw.status) > 599) throw new Error('invalid_record')
        return [formatDisplayDateTime(raw.at), raw.host, raw.address, String(raw.status)]
      })
      logs.textContent = ''
      for (const values of rows) { const row = logs.insertRow(); for (const value of values) { const cell = row.insertCell(), isolated = document.createElement('bdi'); isolated.dir = 'ltr'; isolated.textContent = value; cell.append(isolated) } }
      if (!rows.length) { const cell = logs.insertRow().insertCell(); cell.colSpan = 4; cell.textContent = t('No complete records were returned in this observed window.') }
      logStatus.dataset.state = String(data.state)
      logStatus.textContent = t('Historical default-vhost HTTP records; bindings at request time and rejected TLS handshakes remain unverified.') + (data.truncated ? ' ' + t('The bounded window is truncated.') : '') + (data.state === 'partial' ? ' ' + t('Some records were incomplete or invalid.') : '')
    }
    const read = async (explicitDiscard = false) => {
      if (!admitted() || busy) return
      if (dirty() && !explicitDiscard && (!askDialog || await askDialog({ title: t('Discard unsaved policy?'), body: t('Reload the saved server policy.'), confirm: t(msgctxt('whm-default-site-client', 'Reload')) }) !== true)) return
      const token = ++generation; busy = true; controls(); announce('reading', t('Reading saved policy and native request observations…'))
      const [configuration, observations] = await Promise.allSettled([Promise.resolve().then(() => request!('GET', '/api/server/default-site')), Promise.resolve().then(() => request!('GET', '/api/server/default-site/requests'))])
      if (token !== generation) return
      busy = false
      if (!admitted()) { controls(); announce('unavailable', t('This workspace is unavailable.')); return }
      if (configuration.status === 'fulfilled') {
        const next = readDefaultSite(configuration.value)
        if (next) { install(next); uncertain = false; stale = false; announce('read', next.qualified ? t('Saved policy read. External serving, DNS and TLS remain unverified.') : t('Saved policy read. This host has not qualified policy changes.')) }
        else announce('failed', t('Saved policy response could not be verified. Your draft is kept.'))
      } else announce('failed', t('Saved policy could not be read. Your draft is kept.'))
      try { if (observations.status !== 'fulfilled') throw new Error('read_failed'); renderLogs(observations.value) }
      catch { logStatus.dataset.state = 'failed'; logStatus.textContent = t('The latest request read failed. Any retained rows are from the previous read.') }
      controls()
    }
    const saving = async () => {
      const submitted = defaultSitePolicy(draft()), before = view
      if (!admitted() || busy || uncertain || stale || !before?.qualified || !submitted || !dirty() || !askDialog) return
      if (await askDialog({ title: t('Save default-site policy?'), body: t('This changes saved global configuration. External serving still requires separate verification.'), confirm: t('Save policy') }) !== true || view !== before || !same(submitted, defaultSitePolicy(draft())) || !admitted() || busy) return
      const token = ++generation; busy = true; controls(); announce('saving', t('Saving and verifying persisted policy…'))
      try {
        const result = await request!('PUT', '/api/server/default-site', { policy: submitted, expectedRevision: before.revision })
        if (!defaultSiteObject(result) || result.stateChanged !== true) throw { details: { stateChanged: true } }
        const ack = readDefaultSite({ ...result, actions: { save: true } })
        if (!ack || ack.application === 'unverified' || !same(ack.policy, submitted)) throw { details: { stateChanged: true } }
        if (token !== generation || !admitted()) { uncertain = true; announce('unavailable', t('Policy outcome needs review after access changed.')); return }
        const actual = readDefaultSite(await request!('GET', '/api/server/default-site'))
        if (!actual || actual.revision !== ack.revision || !same(actual.policy, submitted)) throw { details: { stateChanged: true } }
        if (token !== generation || !admitted()) return
        install(actual); uncertain = false; stale = false
        announce('saved', ack.application === 'global_configuration_applied' ? t('Saved readback and global apply acknowledgement verified. External serving, DNS and TLS remain unverified.') : t('Saved policy and readback verified. Native application was not requested; external serving remains unverified.'))
        root.dispatchEvent(new CustomEvent('xpanel:default-site-saved', { bubbles: true }))
      } catch (error) {
        if (token !== generation) return
        const raw = defaultSiteObject(error) ? error : {}, details = defaultSiteObject(raw.details) ? raw.details : defaultSiteObject(raw.detail) ? raw.detail : {}
        stale = raw.status === 409 || raw.code === 'CONFLICT'; uncertain = !stale && details.stateChanged !== false
        announce(stale ? 'stale' : uncertain ? 'uncertain' : 'failed', stale ? t('Saved settings changed. Your draft is kept; explicitly reload before retrying.') : uncertain ? t('The save outcome requires verification. Your draft is kept and further writes are locked until reload.') : t('The save was refused. Your draft is kept; no automatic retry was sent.'))
      } finally { if (token === generation) { busy = false; controls() } }
    }
    form.addEventListener('input', () => { if (!busy && admitted()) { controls(); announce('dirty', t('Unsaved policy draft.')) } })
    form.addEventListener('change', () => { if (!busy && admitted()) { controls(); announce('dirty', t('Unsaved policy draft.')) } })
    form.addEventListener('submit', event => { event.preventDefault(); if (form instanceof HTMLFormElement && admitted() && form.reportValidity()) void saving() })
    refresh.addEventListener('click', () => { void read() }); discard.addEventListener('click', () => { void read(true) })
    window.addEventListener('beforeunload', event => { if (admitted() && dirty()) { event.preventDefault(); event.returnValue = '' } })
    controls()
    if (admitted()) void read(); else announce('unavailable', t('This root-only workspace is unavailable.'))
  })
}
export const WHM_DEFAULT_SITE_CLIENT_BINDING = `function(askDialog){const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const defaultSiteObject=${defaultSiteObject.toString()};const defaultSitePolicy=${defaultSitePolicy.toString()};const readDefaultSite=${readDefaultSite.toString()};(${bindWhmDefaultSite.toString()})(askDialog);}`
