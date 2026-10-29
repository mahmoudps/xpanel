/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as sharedFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = sharedFormatDisplayDateTime

export interface WhmcsSettingsView { enabled: boolean; whmcsUrl: string; allowedAddresses: string[]; ssoTarget: 'xpanel' | 'xwhm' | 'xmail'; autoCreate: boolean; planMap: { package: string; planId: string }[] }
export interface WhmcsView {
  state: 'default' | 'saved' | 'invalid'; settings: WhmcsSettingsView | null; apiIdentifier: string | null; token: { hint: string; createdAt: string } | null
  updatedAt: string | null; revision: string; plans: { id: string; name: string; accounts: number }[]
}
export interface WhmcsActivityView { at: string; action: string | null; username: string | null; result: 'ok' | 'refused' | 'failed'; reason: string; ip: string | null }

export function readWhmcsView(value: unknown): WhmcsView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const time = (item: unknown): item is string => typeof item === 'string' && Number.isFinite(Date.parse(item)) && new Date(item).toISOString() === item
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  if (!object(value) || Object.keys(value).sort().join() !== 'apiIdentifier,plans,revision,settings,state,token,updatedAt' || !['default', 'saved', 'invalid'].includes(value.state as string)
    || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || (value.updatedAt !== null && !time(value.updatedAt))
    || (value.apiIdentifier !== null && (typeof value.apiIdentifier !== 'string' || !/^whmcs_[0-9a-f]{12}$/.test(value.apiIdentifier)))
    || !Array.isArray(value.plans) || value.plans.length > 1000) throw new Error('invalid_whmcs')
  const plans = value.plans.map(plan => {
    if (!object(plan) || Object.keys(plan).sort().join() !== 'accounts,id,name' || !text(plan.id, 128) || !plan.id || !text(plan.name, 256) || !Number.isSafeInteger(plan.accounts) || (plan.accounts as number) < 0) throw new Error('invalid_whmcs')
    return { id: plan.id, name: plan.name, accounts: plan.accounts as number }
  })
  const token = value.token
  if (token !== null && (!object(token) || Object.keys(token).sort().join() !== 'createdAt,hint' || typeof token.hint !== 'string' || !/^[A-Za-z0-9_-]{4}$/.test(token.hint) || !time(token.createdAt))) throw new Error('invalid_whmcs')
  const raw = value.settings
  let settings: WhmcsSettingsView | null = null
  if (raw !== null) {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'allowedAddresses,autoCreate,enabled,planMap,ssoTarget,whmcsUrl' || typeof raw.enabled !== 'boolean' || typeof raw.autoCreate !== 'boolean'
      || !text(raw.whmcsUrl, 512) || !['xpanel', 'xwhm', 'xmail'].includes(raw.ssoTarget as string) || !Array.isArray(raw.allowedAddresses) || raw.allowedAddresses.length > 32
      || !raw.allowedAddresses.every(entry => typeof entry === 'string' && /^[0-9A-Fa-f.:]{2,45}(?:\/[0-9]{1,3})?$/.test(entry)) || !Array.isArray(raw.planMap) || raw.planMap.length > 64) throw new Error('invalid_whmcs')
    const planMap = raw.planMap.map(row => {
      if (!object(row) || Object.keys(row).sort().join() !== 'package,planId' || !text(row.package, 64) || !row.package || !text(row.planId, 128) || !row.planId) throw new Error('invalid_whmcs')
      return { package: row.package, planId: row.planId }
    })
    settings = { enabled: raw.enabled, whmcsUrl: raw.whmcsUrl, allowedAddresses: [...raw.allowedAddresses as string[]], ssoTarget: raw.ssoTarget as WhmcsSettingsView['ssoTarget'], autoCreate: raw.autoCreate, planMap }
  }
  if ((value.state === 'invalid') !== (settings === null) || (value.state === 'default' && (value.apiIdentifier !== null || token !== null || value.updatedAt !== null))
    || (value.state === 'saved' && (value.apiIdentifier === null || value.updatedAt === null)) || (value.state === 'invalid' && (token !== null || value.apiIdentifier !== null))) throw new Error('invalid_whmcs')
  return { state: value.state as WhmcsView['state'], settings, apiIdentifier: value.apiIdentifier as string | null, token: token as WhmcsView['token'], updatedAt: value.updatedAt as string | null, revision: value.revision, plans }
}

export function readWhmcsActivity(value: unknown): WhmcsActivityView[] {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || Object.keys(value).join() !== 'entries' || !Array.isArray(value.entries) || value.entries.length > 100) throw new Error('invalid_whmcs_activity')
  return value.entries.map(entry => {
    if (!object(entry) || Object.keys(entry).sort().join() !== 'action,at,ip,reason,result,username' || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || (entry.action !== null && (typeof entry.action !== 'string' || !/^[a-z_]{1,32}$/.test(entry.action))) || (entry.username !== null && (typeof entry.username !== 'string' || entry.username.length > 64))
      || !['ok', 'refused', 'failed'].includes(entry.result as string) || typeof entry.reason !== 'string' || !/^[a-z0-9_]{1,48}$/.test(entry.reason)
      || (entry.ip !== null && (typeof entry.ip !== 'string' || !/^[0-9A-Fa-f.:]{2,45}$/.test(entry.ip)))) throw new Error('invalid_whmcs_activity')
    return { at: entry.at, action: entry.action as string | null, username: entry.username as string | null, result: entry.result as WhmcsActivityView['result'], reason: entry.reason, ip: entry.ip as string | null }
  })
}

function bindWhmWhmcs(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-whm-whmcs-workspace]').forEach(root => {
    if (root.dataset.whmcsBound === 'true') return
    root.dataset.whmcsBound = 'true'
    const one = <T extends Element>(selector: string): T | null => root.querySelector<T>(selector)
    const form = one<HTMLFormElement>('[data-whm-whmcs-form]'), status = one<HTMLElement>('[data-whm-whmcs-status]'), loading = one<HTMLElement>('[data-whm-whmcs-loading]')
    const save = one<HTMLButtonElement>('[data-whm-whmcs-save]'), reload = one<HTMLButtonElement>('[data-whm-whmcs-reload]'), saveStatus = one<HTMLElement>('[data-whm-whmcs-save-status]')
    const enabled = one<HTMLInputElement>('[data-whm-whmcs-input="enabled"]'), url = one<HTMLInputElement>('[data-whm-whmcs-input="whmcsUrl"]'), addresses = one<HTMLTextAreaElement>('[data-whm-whmcs-input="allowedAddresses"]')
    const sso = one<HTMLSelectElement>('[data-whm-whmcs-input="ssoTarget"]'), autoCreate = one<HTMLInputElement>('[data-whm-whmcs-input="autoCreate"]'), identifier = one<HTMLInputElement>('[data-whm-whmcs-identifier]')
    const updated = one<HTMLElement>('[data-whm-whmcs-updated]'), planRows = one<HTMLElement>('[data-whm-whmcs-plan-rows]'), planAdd = one<HTMLButtonElement>('[data-whm-whmcs-plan-add]')
    const download = one<HTMLButtonElement>('[data-whm-whmcs-download]'), downloadStatus = one<HTMLElement>('[data-whm-whmcs-download-status]')
    const tokenView = one<HTMLElement>('[data-whm-whmcs-token]'), tokenCreated = one<HTMLElement>('[data-whm-whmcs-token-created]'), rotate = one<HTMLButtonElement>('[data-whm-whmcs-rotate]'), tokenStatus = one<HTMLElement>('[data-whm-whmcs-token-status]')
    const reveal = one<HTMLElement>('[data-whm-whmcs-reveal]'), secretView = one<HTMLElement>('[data-whm-whmcs-secret]'), copy = one<HTMLButtonElement>('[data-whm-whmcs-copy]'), done = one<HTMLButtonElement>('[data-whm-whmcs-done]'), copyStatus = one<HTMLElement>('[data-whm-whmcs-copy-status]')
    const logRows = one<HTMLElement>('[data-whm-whmcs-log-rows]'), logRefresh = one<HTMLButtonElement>('[data-whm-whmcs-log-refresh]'), logStatus = one<HTMLElement>('[data-whm-whmcs-log-status]')
    const request = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!form || !status || !save || !reload || !saveStatus || !enabled || !url || !addresses || !sso || !autoCreate || !identifier || !updated || !planRows || !planAdd || !download || !downloadStatus
      || !tokenView || !tokenCreated || !rotate || !tokenStatus || !reveal || !secretView || !copy || !done || !copyStatus || !logRows || !logRefresh || !logStatus) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.whmcsCanManage === 'true' && form.tagName === 'FORM' && !root.closest(denied) && typeof request === 'function'
    const ROUTE = '/api/server/panel/whmcs'
    let view: WhmcsView | null = null, revision = '', busy = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.hidden = false; target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const ltr = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = value; return node }
    const message = (row: HTMLElement, colSpan: number, text: string): void => { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = colSpan; td.textContent = text; tr.append(td); row.replaceChildren(tr) }
    const editable = (): boolean => !busy && !!revision && !!view?.settings && admitted()
    const lock = (): void => {
      const on = editable()
      for (const control of [enabled, url, addresses, sso, autoCreate, save, planAdd]) control.disabled = !on
      for (const control of Array.from(planRows.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button'))) control.disabled = !on
      reload.disabled = busy || !admitted(); rotate.disabled = busy || !revision || view?.state === 'invalid' || !admitted() || typeof askDialog !== 'function'
      download.disabled = !admitted(); logRefresh.disabled = !admitted(); root.setAttribute('aria-busy', String(busy))
    }
    const failure = (error: unknown, fallback: string): string => {
      const item = error as { status?: number; details?: { verificationRequired?: boolean; stateChanged?: boolean; unknownOutcome?: boolean } }
      if (item?.details?.verificationRequired || item?.details?.stateChanged || item?.details?.unknownOutcome) return t('The result could not be verified. Reload the WHMCS integration before changing it again.')
      if (item?.status === 409) return t('The WHMCS integration changed since it was read. Reload before saving again.')
      if (item?.status === 401 || item?.status === 403) return t('Root authorization is required to manage the WHMCS integration.')
      if (item?.status === 412) return t('The server refused the change: create an API token before enabling the integration, or review the saved settings.')
      if (item?.status === 400 || item?.status === 422) return t('The server refused these settings. Check the URL, addresses and plan mapping.')
      return fallback
    }
    const planOptions = (select: HTMLSelectElement, selected: string): void => {
      select.replaceChildren()
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('Choose a plan'); select.append(placeholder)
      for (const plan of view?.plans ?? []) { const option = document.createElement('option'); option.value = plan.id; option.textContent = plan.name; select.append(option) }
      if (selected && !(view?.plans ?? []).some(plan => plan.id === selected)) { const option = document.createElement('option'); option.value = selected; option.textContent = t('Missing plan {id}', { id: selected }); select.append(option) }
      select.value = selected
    }
    const addPlanRow = (mapping: { package: string; planId: string }): void => {
      if (planRows.querySelector('[data-whm-whmcs-plan-empty]')) planRows.replaceChildren()
      const row = document.createElement('tr'), index = planRows.children.length + 1
      const name = document.createElement('input'); name.type = 'text'; name.dir = 'auto'; name.maxLength = 64; name.value = mapping.package; name.dataset.whmWhmcsPlanPackage = ''; name.setAttribute('aria-label', t('WHMCS package, row {index}', { index }))
      const plan = document.createElement('select'); plan.dataset.whmWhmcsPlanId = ''; plan.setAttribute('aria-label', t('xPanel plan, row {index}', { index })); planOptions(plan, mapping.planId)
      const count = document.createElement('td'); count.dataset.whmWhmcsPlanAccounts = ''
      const showCount = (): void => { const found = view?.plans.find(item => item.id === plan.value); count.textContent = found ? String(found.accounts) : '—' }
      plan.addEventListener('change', showCount); showCount()
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'xp-btn'; remove.textContent = t('Remove'); remove.setAttribute('aria-label', t('Remove mapping, row {index}', { index }))
      remove.addEventListener('click', () => { row.remove(); if (!planRows.children.length) emptyPlans() })
      for (const content of [name, plan]) { const td = document.createElement('td'); td.append(content); row.append(td) }
      row.append(count); const action = document.createElement('td'); action.append(remove); row.append(action)
      planRows.append(row)
    }
    const emptyPlans = (): void => { message(planRows, 4, t('No package is mapped. Every call that names a package is refused.')); planRows.querySelector('tr')!.dataset.whmWhmcsPlanEmpty = '' }
    const paint = (next: WhmcsView): void => {
      view = next; revision = next.state === 'invalid' ? '' : next.revision
      const settings = next.settings
      if (settings) {
        enabled.checked = settings.enabled; url.value = settings.whmcsUrl; addresses.value = settings.allowedAddresses.join('\n'); sso.value = settings.ssoTarget; autoCreate.checked = settings.autoCreate
        planRows.replaceChildren(); for (const mapping of settings.planMap) addPlanRow(mapping); if (!settings.planMap.length) emptyPlans()
      } else message(planRows, 4, t('Unavailable'))
      identifier.value = next.apiIdentifier ?? ''; identifier.placeholder = next.apiIdentifier ? '' : t('Created with the first API token')
      updated.replaceChildren(next.updatedAt ? ltr(formatDisplayDateTime(next.updatedAt)) : t('Never saved'))
      tokenView.replaceChildren(next.token ? ltr('xpw_…' + next.token.hint) : t('No token'))
      tokenCreated.replaceChildren(next.token ? ltr(formatDisplayDateTime(next.token.createdAt)) : t('Never'))
      rotate.textContent = next.token ? t('Replace the token') : t('Create a new token')
      note(status, next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved WHMCS integration could not be verified. Review the saved file before changing it.')
        : !settings?.enabled ? t('The WHMCS integration is off. xPanel refuses every call from WHMCS.')
          : t('The WHMCS integration is on. Calls are accepted only from the allowed addresses with the current token.'))
    }
    const desired = (): { enabled: boolean; whmcsUrl: string; allowedAddresses: string[]; ssoTarget: string; autoCreate: boolean; planMap: { package: string; planId: string }[] } => ({
      enabled: enabled.checked, whmcsUrl: url.value.trim(), allowedAddresses: addresses.value.split('\n').map(line => line.trim()).filter(Boolean), ssoTarget: sso.value, autoCreate: autoCreate.checked,
      planMap: Array.from(planRows.querySelectorAll('tr')).filter(row => row.querySelector('[data-whm-whmcs-plan-package]')).map(row => ({
        package: (row.querySelector<HTMLInputElement>('[data-whm-whmcs-plan-package]')!.value).trim(), planId: row.querySelector<HTMLSelectElement>('[data-whm-whmcs-plan-id]')!.value })),
    })
    const problem = (values: ReturnType<typeof desired>): string => {
      if (values.whmcsUrl && !/^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(values.whmcsUrl)) return t('Enter the WHMCS URL as an https:// address.')
      if (values.allowedAddresses.length > 32 || !values.allowedAddresses.every(entry => /^[0-9A-Fa-f.:]{2,45}(?:\/[0-9]{1,3})?$/.test(entry))) return t('Enter up to 32 IPv4 or IPv6 addresses or CIDR ranges, one per line.')
      if (values.enabled && (!values.whmcsUrl || !values.allowedAddresses.length)) return t('Turning the integration on needs the WHMCS URL and at least one allowed address.')
      if (values.enabled && !view?.token) return t('Create an API token before turning the integration on.')
      if (values.planMap.some(row => !row.package || row.package.length > 64 || !row.planId)) return t('Give every mapping row a package name of up to 64 characters and a plan.')
      if (new Set(values.planMap.map(row => row.package.toLowerCase())).size !== values.planMap.length) return t('Map each WHMCS package only once.')
      return ''
    }
    const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
    const load = async (): Promise<void> => {
      if (busy || !admitted() || !request) return
      busy = true; revision = ''; lock(); if (loading) loading.hidden = false
      note(status, 'reading', t('Reading the WHMCS integration…'))
      try { paint(readWhmcsView(await request('GET', ROUTE))) }
      catch (error) { view = null; note(status, 'failed', failure(error, t('The WHMCS integration could not be read. Nothing was changed.'))) }
      finally { busy = false; lock(); if (loading) loading.hidden = true }
    }
    const loadLog = async (): Promise<void> => {
      if (!admitted() || !request) return
      logRefresh.disabled = true; note(logStatus, 'reading', t('Reading the activity log…'))
      try {
        const entries = readWhmcsActivity(await request('GET', ROUTE + '/activity'))
        const labels: Record<string, string> = { test: t('Test connection'), create: t('Create'), suspend: t('Suspend'), unsuspend: t('Unsuspend'), terminate: t('Terminate'), change_package: t('Change package') }
        const results: Record<string, [string, string]> = { ok: [t('Completed'), 'ok'], refused: [t('Refused'), 'warn'], failed: [t('Failed'), 'critical'] }
        logRows.replaceChildren()
        for (const entry of entries) {
          const row = document.createElement('tr'), cell = (content: Node | string): void => { const td = document.createElement('td'); td.append(content); row.append(td) }
          cell(ltr(formatDisplayDateTime(entry.at))); cell(entry.action ? labels[entry.action] ?? ltr(entry.action) : t('Unknown'))
          cell(entry.username ? ltr(entry.username) : '—')
          const [label, tone] = results[entry.result]!, badge = document.createElement('span'), result = document.createElement('span')
          badge.className = 'xp-badge xp-badge--' + tone; badge.textContent = label; result.append(badge, ' ', ltr(entry.reason)); cell(result)
          cell(entry.ip ? ltr(entry.ip) : t('Unknown'))
          logRows.append(row)
        }
        if (!entries.length) message(logRows, 5, t('WHMCS has not called this server yet.'))
        note(logStatus, 'read', t('Activity log read. Entries: {count}.', { count: entries.length }))
      } catch (error) { note(logStatus, 'failed', failure(error, t('The activity log could not be read.'))) }
      finally { logRefresh.disabled = !admitted() }
    }
    const hideSecret = (): void => { secretView.textContent = ''; copyStatus.hidden = true; reveal.hidden = true }
    if (!admitted()) { lock(); note(status, 'unavailable', t('The WHMCS integration is unavailable here. Nothing was read or changed.')); return }
    reload.addEventListener('click', () => { saveStatus.hidden = true; void load() })
    logRefresh.addEventListener('click', () => { void loadLog() })
    planAdd.addEventListener('click', () => { if (editable()) { addPlanRow({ package: '', planId: '' }); lock(); planRows.querySelector<HTMLInputElement>('tr:last-child [data-whm-whmcs-plan-package]')?.focus() } })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      if (!editable() || !request) return
      const values = desired(), refused = problem(values)
      if (refused) { note(saveStatus, 'failed', refused); return }
      busy = true; lock(); note(saveStatus, 'reading', t('Saving the WHMCS integration…'))
      try {
        const ack = readWhmcsView(await request('PUT', ROUTE, { ...values, expectedRevision: revision }))
        if (ack.state !== 'saved' || !same(ack.settings, values)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        const verified = readWhmcsView(await request('GET', ROUTE))
        if (verified.revision !== ack.revision || !same(verified.settings, ack.settings)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(verified); note(saveStatus, 'read', t('Settings saved and read back.'))
      } catch (error) {
        revision = ''
        const code = (error as { status?: number })?.status
        note(saveStatus, code === 409 ? 'stale' : 'failed', failure(error, t('The settings were not saved.')))
      } finally { busy = false; lock() }
    })
    rotate.addEventListener('click', async () => {
      if (busy || !revision || !admitted() || !request || typeof askDialog !== 'function') return
      const replacing = !!view?.token
      let confirmed = false
      try {
        confirmed = await askDialog({ title: replacing ? t('Replace the API token?') : t('Create an API token?'), danger: replacing, confirm: replacing ? t('Replace token') : t('Create token'), cancel: t('Cancel'),
          body: replacing ? t('The current token stops working at once. WHMCS calls fail until you enter the new token as the server Access Hash.') : t('The token is shown once. Enter it as the server Access Hash in WHMCS.') }) === true
      } catch { confirmed = false }
      if (!confirmed) return
      busy = true; lock(); hideSecret(); note(tokenStatus, 'reading', t('Creating the token…'))
      try {
        const issued = await request('POST', ROUTE + '/token', { expectedRevision: revision }) as Record<string, unknown> | null
        const secret = issued && typeof issued.secret === 'string' && /^xpw_[A-Za-z0-9_-]{43}$/.test(issued.secret) ? issued.secret : ''
        const { secret: _secret, ...rest } = issued ?? {}
        const ack = readWhmcsView(rest)
        if (!secret || ack.token?.hint !== secret.slice(-4)) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        secretView.textContent = secret; copyStatus.hidden = true; reveal.hidden = false
        const verified = readWhmcsView(await request('GET', ROUTE))
        if (verified.revision !== ack.revision || verified.token?.hint !== ack.token?.hint) throw Object.assign(new Error('unverified'), { details: { verificationRequired: true } })
        paint(verified); note(tokenStatus, 'read', t('Token created. The previous token, if any, no longer works.'))
      } catch (error) {
        revision = ''
        note(tokenStatus, (error as { status?: number })?.status === 409 ? 'stale' : 'failed', failure(error, t('The token was not created.')))
      } finally { busy = false; lock() }
    })
    done.addEventListener('click', hideSecret)
    copy.addEventListener('click', () => {
      const secret = secretView.textContent ?? '', clipboard = navigator.clipboard
      if (!secret) return
      if (!clipboard?.writeText) { note(copyStatus, 'failed', t('Copying is not available in this browser. Select the token and copy it.')); return }
      clipboard.writeText(secret).then(() => note(copyStatus, 'read', t('Copied.')), () => note(copyStatus, 'failed', t('The token could not be copied. Select it and copy it.')))
    })
    download.addEventListener('click', async () => {
      if (!admitted()) return
      if (typeof URL.createObjectURL !== 'function') { note(downloadStatus, 'failed', t('File downloads are unavailable in this browser.')); return }
      download.disabled = true; note(downloadStatus, 'reading', t('Preparing the module…'))
      try {
        const response = await fetch(ROUTE + '/module', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok || !/attachment/.test(response.headers.get('content-disposition') ?? '')) throw Object.assign(new Error('download'), { status: response.status })
        const blobUrl = URL.createObjectURL(await response.blob()), link = document.createElement('a')
        try { link.href = blobUrl; link.download = 'xpanel.php'; link.click() } finally { URL.revokeObjectURL(blobUrl) }
        note(downloadStatus, 'read', t('Module downloaded as xpanel.php.'))
      } catch (error) { note(downloadStatus, 'failed', failure(error, t('The module could not be downloaded.'))) }
      finally { download.disabled = !admitted() }
    })
    window.addEventListener('pagehide', hideSecret)
    void load().then(loadLog)
  })
}

export const WHM_WHMCS_CLIENT_BINDING = `(()=>{const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const readWhmcsView=${readWhmcsView.toString()};const readWhmcsActivity=${readWhmcsActivity.toString()};return ${bindWhmWhmcs.toString()};})()`
