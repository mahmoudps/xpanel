import type { MessageValues } from './i18n.ts'
/// <reference lib="dom" />
import { tools } from '@xpanel/catalog'
import { RESELLER_ACLS } from '@xpanel/core'

type FormValues = Record<string, string | boolean>
type JsonRecord = Record<string, unknown>
type SessionRequest = (method: string, path: string, body?: unknown) => Promise<unknown>
type ConfirmDelete = (options: Record<string, unknown>) => Promise<string | boolean | null>
const WORKSPACE_FEATURE_KEYS = [...new Set(tools.flatMap(tool => tool.featureKey ? [tool.featureKey] : []))]
const WORKSPACE_RESELLER_ACLS: readonly string[] = [...RESELLER_ACLS]

const SERVER_FIELD_TYPES = {
  hostname: 'text', adminEmail: 'text', nameservers: 'lines', engine: 'engine', apacheMpm: 'mpm',
  panelPort: 'integer', sshPort: 'integer', backendPort: 'integer', backendTlsPort: 'integer',
  'nginx.workerProcesses': 'workers', 'nginx.workerConnections': 'integer',
  'nginx.workerRlimitNofile': 'integer', 'nginx.multiAccept': 'boolean', 'nginx.keepaliveTimeoutSec': 'integer',
  'apache.startServers': 'integer', 'apache.minSpareServers': 'integer', 'apache.maxSpareServers': 'integer',
  'apache.maxRequestWorkers': 'integer', 'apache.maxConnectionsPerChild': 'integer', 'apache.serverLimit': 'integer',
} as const
const PHP_FIELD_TYPES = {
  version: 'text', handler: 'handler', 'fpm.mode': 'mode', 'fpm.maxChildren': 'integer',
  'fpm.startServers': 'integer', 'fpm.minSpareServers': 'integer', 'fpm.maxSpareServers': 'integer',
  'fpm.maxRequests': 'integer', 'fpm.processIdleTimeoutSec': 'integer',
  'ini.memory_limit': 'ini', 'ini.upload_max_filesize': 'ini', 'ini.post_max_size': 'ini', 'ini.max_execution_time': 'ini',
} as const

export function workspaceRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function workspaceFieldValue(raw: string | boolean, kind: string): unknown {
  if (kind === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error('boolean')
    return raw
  }
  if (typeof raw !== 'string') throw new Error('text')
  const value = raw.trim()
  if (kind === 'ini') {
    if (value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('ini')
    return value
  }
  if (kind === 'lines') {
    const lines = value.split(/[\r\n,]+/).map(line => line.trim()).filter(Boolean)
    if (!lines.length || lines.length > 16) throw new Error('nameservers')
    return lines
  }
  if (kind === 'workers' && value === 'auto') return value
  if (kind === 'integer' || kind === 'workers') {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('integer')
    return Number(value)
  }
  const allowed: Record<string, readonly string[]> = {
    engine: ['apache', 'openlitespeed'], mpm: ['itk', 'prefork'],
    handler: ['fpm', 'cgi', 'suphp', 'lsphp'], mode: ['ondemand', 'dynamic', 'static'],
  }
  if (!value || value.length > 1024 || /[\r\n\0]/.test(value) || (allowed[kind] && !allowed[kind]!.includes(value))) throw new Error(kind)
  return value
}

/** Only displayed, enabled fields are merged; unrelated settings stay byte-for-byte values. */
export function mergeWorkspaceFields(current: JsonRecord, values: FormValues, fields: Record<string, string>): JsonRecord {
  const result = JSON.parse(JSON.stringify(current)) as JsonRecord
  for (const [path, raw] of Object.entries(values)) {
    if (!Object.hasOwn(fields, path)) continue
    const next = workspaceFieldValue(raw, fields[path]!)
    const [parent, child] = path.split('.')
    if (child) {
      if (!workspaceRecord(result[parent!])) throw new Error(path)
      if (fields[path] === 'ini' && next === '') delete (result[parent!] as JsonRecord)[child]
      else (result[parent!] as JsonRecord)[child] = next
    } else result[parent!] = next
  }
  return result
}

export function mergeWorkspaceServerSettings(current: unknown, values: FormValues): JsonRecord {
  if (!workspaceRecord(current) || typeof current.hostname !== 'string' || !workspaceRecord(current.nginx) || !workspaceRecord(current.apache)) throw new Error('unread')
  return { ...mergeWorkspaceFields(current, values, SERVER_FIELD_TYPES), markSetupComplete: false }
}

export function mergeWorkspacePhp(current: unknown, values: FormValues): JsonRecord {
  if (!workspaceRecord(current) || typeof current.version !== 'string' || typeof current.handler !== 'string' || !workspaceRecord(current.fpm) || !workspaceRecord(current.ini)) throw new Error('unread')
  return mergeWorkspaceFields(current, values, PHP_FIELD_TYPES)
}

export function workspaceValuesMatch(expected: unknown, observed: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(observed) && expected.length === observed.length && expected.every((row, index) => workspaceValuesMatch(row, observed[index]))
  if (workspaceRecord(expected)) return workspaceRecord(observed) && Object.entries(expected).every(([key, value]) => key === 'markSetupComplete' || workspaceValuesMatch(value, observed[key]))
  return expected === observed
}

export function workspaceFeatureReceipt(observed: unknown, name: string, disabled: readonly string[], id?: string): boolean {
  if (!workspaceRecord(observed) || !workspaceRecord(observed.featureList)) return false
  const featureList = observed.featureList
  const expected = new Set(disabled)
  const actual = Array.isArray(featureList.disabled) && featureList.disabled.every(value => typeof value === 'string') ? new Set(featureList.disabled) : undefined
  return typeof featureList.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(featureList.id)
    && (!id || featureList.id === id) && featureList.name === name && actual !== undefined
    && expected.size === actual.size && [...expected].every(feature => actual.has(feature))
}

export function workspaceDisabledFeatures(current: unknown, editable: readonly string[], selected: readonly string[]): string[] {
  if (!Array.isArray(current) || !current.every(value => typeof value === 'string')) throw new Error('unread')
  const editableKeys = new Set(editable)
  return [...new Set([...current.filter(value => !editableKeys.has(value)), ...selected])]
}

export function workspaceResellerPatch(current: unknown, values: FormValues, editableAcl: readonly string[], selectedAcl: readonly string[]): JsonRecord {
  if (!workspaceRecord(current) || !Array.isArray(current.acl) || !current.acl.every(value => typeof value === 'string')) throw new Error('unread')
  const patch: JsonRecord = {}
  if (selectedAcl.some(value => !WORKSPACE_RESELLER_ACLS.includes(value))) throw new Error('acl')
  if (editableAcl.length) patch.acl = workspaceDisabledFeatures(current.acl, editableAcl, selectedAcl)
  for (const key of ['maxAccounts', 'totalDiskMb', 'totalBandwidthMb']) {
    if (values[key + 'Unlimited'] === true) patch[key] = 'unlimited'
    else if (values[key] !== undefined) patch[key] = workspaceFieldValue(values[key]!, 'integer')
    else if (values[key + 'Unlimited'] === false) throw new Error(key)
  }
  if (values.oversell !== undefined) patch.oversell = workspaceFieldValue(values.oversell, 'boolean')
  for (const key of ['nameservers', 'delegatedIps']) {
    const raw = values[key]
    if (raw === undefined) continue
    if (typeof raw !== 'string') throw new Error(key)
    const lines = raw.split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean)
    if (lines.some(value => value.length > 255 || /[\0]/.test(value)) || lines.length > 100) throw new Error(key)
    patch[key] = lines
  }
  return patch
}

function bindApprovedWorkspaceForms(confirmDelete?: ConfirmDelete): void {
  const copy = (message: string, values?: MessageValues) => xpT(message, values)
  const uuid = (value: string | undefined | null): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  const request = (): SessionRequest | undefined => (window as Window & { xpanelSessionRequest?: SessionRequest }).xpanelSessionRequest
  const statusFor = (root: Element): HTMLElement => {
    const existing = root.querySelector<HTMLElement>('[data-workspace-form-status],[data-feature-list-status],[data-server-settings-status],[data-setup-wizard-status],[data-domain-php-status],[data-reseller-update-status],[data-reseller-owner-status],[data-account-plan-status],[data-firewall-port-rule-status]')
    if (existing) return existing
    const status = document.createElement('p')
    status.className = 'xp-help'; status.dataset.workspaceFormStatus = ''; root.appendChild(status)
    return status
  }
  const note = (status: HTMLElement, message: string, state: string) => {
    status.textContent = message; status.hidden = false; status.dataset.state = state
    status.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status')
  }
  const unavailable = (element: Element): boolean => Boolean(element.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[aria-disabled="true"],[data-capability-unavailable="true"],fieldset:disabled'))
  const enabledValues = (form: HTMLFormElement): FormValues => {
    const values: FormValues = {}
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[name],select[name],textarea[name]').forEach(control => {
      if (control.matches(':disabled') || !control.name) return
      if (control instanceof HTMLInputElement && control.type === 'radio' && !control.checked) return
      values[control.name] = control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value
    })
    return values
  }
  const selectedFeatures = (form: HTMLFormElement): string[] => Array.from(form.querySelectorAll<HTMLInputElement>('input[name="disabled"]')).filter(input => input.checked && !input.matches(':disabled')).map(input => input.value)
  const definiteRefusal = (error: unknown): boolean => {
    if (!workspaceRecord(error)) return false
    if (error.stateChanged === true || error.verificationRequired === true || error.unknownOutcome === true || error.needsAttention === true) return false
    if (workspaceRecord(error.details) && (error.details.stateChanged === true || error.details.verificationRequired === true || error.details.unknownOutcome === true || error.details.needsAttention === true)) return false
    if (workspaceRecord(error.details) && error.details.stateChanged === false) return true
    return typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408
  }

  const forms = document.querySelectorAll<HTMLFormElement>('[data-feature-list-create-form],[data-feature-list-update-form],[data-server-settings-form],[data-setup-wizard-form],[data-domain-php-form],[data-reseller-update-form],[data-reseller-owner-form],[data-account-plan-form],[data-firewall-port-rule-form]')
  forms.forEach(form => {
    if (form.dataset.workspaceBinding === 'true') return
    form.dataset.workspaceBinding = 'true'
    let busy = false, reviewRequired = false
    const unlimitedToggles = form.querySelectorAll<HTMLInputElement>('[data-reseller-unlimited-field]')
    const syncUnlimited = (toggle: HTMLInputElement) => {
      if (busy || reviewRequired || unavailable(form)) return
      const field = form.elements.namedItem(toggle.dataset.resellerUnlimitedField ?? '')
      if (field instanceof HTMLInputElement) { field.disabled = toggle.checked; field.required = !toggle.checked }
    }
    unlimitedToggles.forEach(toggle => toggle.addEventListener('change', () => syncUnlimited(toggle)))
    // A native reset restores checkbox values without firing change; resync once the values are back.
    if (unlimitedToggles.length) form.addEventListener('reset', () => setTimeout(() => unlimitedToggles.forEach(syncUnlimited)))
    const domainSelect = form.querySelector<HTMLSelectElement>('[data-domain-php-select]')
    if (form.hasAttribute('data-domain-php-form')) form.addEventListener('reset', event => {
      if (busy || reviewRequired) event.preventDefault()
    })
    if (form.hasAttribute('data-domain-php-form') && domainSelect) domainSelect.addEventListener('change', async () => {
      if (busy || reviewRequired || domainSelect.disabled || unavailable(form)) return
      const status = statusFor(form), send = request(), id = domainSelect.value
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
      if (!uuid(id) || typeof send !== 'function' || !submit) return
      busy = true; submit.disabled = true; domainSelect.disabled = true; form.setAttribute('aria-busy', 'true')
      note(status, copy('Reading the selected domain configuration…'), 'pending')
      try {
        const snapshot = await send('GET', '/api/domains')
        const domain = workspaceRecord(snapshot) && Array.isArray(snapshot.domains) ? snapshot.domains.find(item => workspaceRecord(item) && item.id === id) : undefined
        const php = mergeWorkspacePhp(workspaceRecord(domain) ? domain.php : null, {})
        if (domainSelect.value !== id) throw new Error('selection-changed')
        form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]').forEach(control => {
          if (!Object.hasOwn(PHP_FIELD_TYPES, control.name)) return
          const [parent, child] = control.name.split('.')
          const value = child && workspaceRecord(php[parent!]) ? (php[parent!] as JsonRecord)[child] : php[parent!]
          control.value = value === null || value === undefined ? '' : String(value)
          if (control instanceof HTMLInputElement) control.defaultValue = control.value
          else Array.from(control.options).forEach(option => { option.defaultSelected = option.selected })
        })
        Array.from(domainSelect.options).forEach(option => { option.defaultSelected = option.value === id })
        form.dataset.domainId = id
        note(status, copy('Selected domain configuration was read. Changes have not been sent.'), 'read')
        submit.disabled = false
      } catch {
        delete form.dataset.domainId
        note(status, copy('The selected domain could not be read. Saving is unavailable.'), 'failed')
      } finally { busy = false; domainSelect.disabled = false; form.removeAttribute('aria-busy') }
    })
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"],input[type="submit"]')
      if (busy || reviewRequired || unavailable(form) || !submit || submit.disabled || !form.reportValidity()) return
      const status = statusFor(form)
      const send = request()
      if (typeof send !== 'function') { note(status, copy('Saving is unavailable. No changes were sent.'), 'failed'); return }
      const values = enabledValues(form)
      const disabledFeatures = selectedFeatures(form)
      const editableFeatures = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="disabled"]')).filter(input => !input.matches(':disabled')).map(input => input.value)
      const editableAcl = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="acl"]')).filter(input => !input.matches(':disabled')).map(input => input.value)
      const selectedAcl = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="acl"]')).filter(input => input.checked && !input.matches(':disabled')).map(input => input.value)
      const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea')).map(control => ({ control, disabled: control.disabled }))
      let mutationStarted = false
      let verificationPending = false
      busy = true; form.setAttribute('aria-busy', 'true'); controls.forEach(({ control }) => { control.disabled = true })
      note(status, copy('Saving the requested configuration…'), 'pending')
      try {
        let result: unknown, verified = false, savedMessage = copy('Configuration was stored. Host activation still requires verification.')
        if (form.hasAttribute('data-feature-list-create-form') || form.hasAttribute('data-feature-list-update-form')) {
          const name = typeof values.name === 'string' ? values.name.trim() : ''
          if (!name || name.length > 128 || disabledFeatures.some(key => !key || key.length > 256 || /[\r\n\0]/.test(key))) throw new Error('fields')
          const id = form.dataset.featureListId
          const creating = form.hasAttribute('data-feature-list-create-form')
          if (!creating && !uuid(id)) throw new Error('identity')
          let submittedFeatures = [...new Set(disabledFeatures)]
          let storedFeatures: unknown[] = []
          if (!creating) {
            const snapshot = await send('GET', '/api/feature-lists')
            const featureList = workspaceRecord(snapshot) && Array.isArray(snapshot.featureLists) ? snapshot.featureLists.find(item => workspaceRecord(item) && item.id === id) : undefined
            storedFeatures = workspaceRecord(featureList) && Array.isArray(featureList.disabled) ? featureList.disabled : []
            submittedFeatures = workspaceDisabledFeatures(workspaceRecord(featureList) ? featureList.disabled : null, editableFeatures, disabledFeatures)
          }
          if (disabledFeatures.some(key => !WORKSPACE_FEATURE_KEYS.includes(key) && !storedFeatures.includes(key))) throw new Error('features')
          const payload = { name, disabled: submittedFeatures }
          mutationStarted = true
          result = await send(creating ? 'POST' : 'PATCH', creating ? '/api/feature-lists' : '/api/feature-lists/' + id, payload)
          verified = workspaceFeatureReceipt(result, name, submittedFeatures, id)
          savedMessage = copy('The feature list was stored. Reload this page to read the updated list.')
        } else if (form.hasAttribute('data-server-settings-form')) {
          const snapshot = await send('GET', '/api/server/settings')
          const payload = mergeWorkspaceServerSettings(workspaceRecord(snapshot) ? snapshot.settings : null, values)
          mutationStarted = true
          result = await send('PUT', '/api/server/settings', payload)
          verified = workspaceRecord(result) && workspaceValuesMatch(payload, result.settings)
        } else if (form.hasAttribute('data-setup-wizard-form')) {
          const payload: JsonRecord = { initQuotas: false }
          for (const key of ['hostname', 'adminEmail', 'engine', 'apacheMpm', 'panelPort', 'sshPort', 'nameservers', 'quotaFilesystem']) {
            if (values[key] === undefined) continue
            payload[key] = workspaceFieldValue(values[key]!, key === 'quotaFilesystem' ? 'text' : SERVER_FIELD_TYPES[key as keyof typeof SERVER_FIELD_TYPES])
          }
          if (typeof values.primaryIpv4 === 'string' && values.primaryIpv4.trim()) {
            const address = values.primaryIpv4.trim()
            const octets = address.split('.')
            if (octets.length !== 4 || octets.some(octet => !/^(?:0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255)) throw new Error('primaryIpv4')
            payload.primaryIpv4 = address
          }
          mutationStarted = true
          result = await send('POST', '/api/setup/wizard', payload)
          const savedSettings = workspaceRecord(result) && workspaceRecord(result.settings) ? result.settings : undefined
          verified = workspaceRecord(result) && result.ok === true && savedSettings !== undefined && (payload.primaryIpv4 === undefined || (workspaceRecord(result.primaryIp) && result.primaryIp.address === payload.primaryIpv4 && result.primaryIp.version === 4)) && Object.entries(payload).filter(([key]) => key !== 'initQuotas' && key !== 'quotaFilesystem' && key !== 'primaryIpv4').every(([key, value]) => workspaceValuesMatch(value, savedSettings[key]))
          savedMessage = copy('Setup configuration was recorded. Filesystem quotas and host activation are not verified by this acknowledgement.')
        } else if (form.hasAttribute('data-account-plan-form')) {
          const username = form.dataset.accountUsername, planId = values.planId
          if (!username || !/^[a-z][a-z0-9]{0,15}$/.test(username) || typeof planId !== 'string' || !uuid(planId)) throw new Error('identity')
          const path = '/api/accounts/' + encodeURIComponent(username)
          const snapshot = await send('GET', path)
          if (!workspaceRecord(snapshot) || !workspaceRecord(snapshot.account) || snapshot.account.username !== username) throw new Error('unread')
          if (snapshot.account.planId === planId) { note(status, copy('The account already uses this plan. No changes were sent.'), 'unchanged'); return }
          if (typeof confirmDelete !== 'function') throw new Error('confirmation')
          const confirmed = await confirmDelete({ title: copy('Change account plan'), body: copy('Type the account username to confirm the plan change: {username}', { username }), input: true, label: copy('Account username'), confirm: copy('Change plan'), danger: true })
          if (confirmed !== username) { note(status, copy('The plan was not changed.'), 'cancelled'); return }
          mutationStarted = true
          result = await send('PATCH', path, { planId })
          verificationPending = true
          if (!workspaceRecord(result) || !workspaceRecord(result.account) || result.account.username !== username || result.account.planId !== planId) throw new Error('unverified')
          const readback = await send('GET', path)
          verified = workspaceRecord(readback) && workspaceRecord(readback.account) && readback.account.username === username && readback.account.planId === planId
          savedMessage = copy('The account plan was stored and read back. Hosting changes still require verification.')
        } else if (form.hasAttribute('data-firewall-port-rule-form')) {
          const action = values.action, protocol = values.protocol, port = values.port
          if (typeof action !== 'string' || !['accept', 'drop', 'reject'].includes(action) || typeof protocol !== 'string' || !['tcp', 'udp', 'both'].includes(protocol) || typeof port !== 'string' || !/^[1-9][0-9]{0,4}(?:-[1-9][0-9]{0,4})?$/.test(port.trim())) throw new Error('rule')
          const ports = port.trim().split('-').map(Number)
          if (ports.some(value => value > 65535) || (ports.length === 2 && ports[0]! > ports[1]!)) throw new Error('port')
          const source = typeof values.source === 'string' ? values.source.trim() : ''
          const comment = typeof values.comment === 'string' ? values.comment.trim() : ''
          if (source.length > 255 || /[\r\n\0]/.test(source) || comment.length > 4096 || /[\r\n\0]/.test(comment)) throw new Error('text')
          const payload = { kind: 'port', action, protocol, port: port.trim(), source: source || null, forwardTo: null, list: null, comment, enabled: true }
          mutationStarted = true
          result = await send('POST', '/api/firewall/rules', payload)
          verificationPending = true
          if (!workspaceRecord(result) || !workspaceRecord(result.rule) || typeof result.rule.id !== 'string' || !workspaceValuesMatch(payload, result.rule)) throw new Error('unverified')
          const ruleId = result.rule.id
          const readback = await send('GET', '/api/firewall')
          const stored = workspaceRecord(readback) && Array.isArray(readback.rules) ? readback.rules.find(item => workspaceRecord(item) && item.id === ruleId) : undefined
          verified = workspaceValuesMatch(payload, stored)
          savedMessage = copy('The firewall rule was stored and read back. Host activation and traffic enforcement are not verified.')
        } else if (form.hasAttribute('data-reseller-update-form')) {
          const id = form.dataset.resellerId
          if (!uuid(id)) throw new Error('identity')
          const snapshot = await send('GET', '/api/resellers')
          const current = workspaceRecord(snapshot) && Array.isArray(snapshot.resellers) ? snapshot.resellers.find(item => workspaceRecord(item) && item.id === id) : undefined
          const payload = workspaceResellerPatch(current, values, editableAcl, selectedAcl)
          if (!Object.keys(payload).length) throw new Error('fields')
          mutationStarted = true
          result = await send('PATCH', '/api/resellers/' + id, payload)
          verificationPending = true
          if (!workspaceRecord(result) || !workspaceRecord(result.reseller) || result.reseller.id !== id) throw new Error('unverified')
          const readback = await send('GET', '/api/resellers')
          const saved = workspaceRecord(readback) && Array.isArray(readback.resellers) ? readback.resellers.find(item => workspaceRecord(item) && item.id === id) : undefined
          const { acl: expectedAcl, ...expectedFields } = payload
          const observedAcl = workspaceRecord(saved) && Array.isArray(saved.acl) ? saved.acl : undefined
          verified = workspaceValuesMatch(expectedFields, saved) && (expectedAcl === undefined || (Array.isArray(expectedAcl) && observedAcl !== undefined && new Set(expectedAcl).size === new Set(observedAcl).size && expectedAcl.every(value => observedAcl.includes(value))))
          savedMessage = copy('The reseller privileges and limits were stored and read back. Reload to read updated state.')
        } else if (form.hasAttribute('data-reseller-owner-form')) {
          const username = form.dataset.accountUsername
          if (!username || !/^[a-z][a-z0-9_]{0,31}$/.test(username)) throw new Error('identity')
          const rawOwner = values.ownerId
          if (typeof rawOwner !== 'string' || (rawOwner !== '' && !uuid(rawOwner))) throw new Error('owner')
          const payload = { ownerId: rawOwner || null }
          const path = '/api/accounts/' + encodeURIComponent(username)
          const snapshot = await send('GET', path)
          if (!workspaceRecord(snapshot) || !workspaceRecord(snapshot.account) || snapshot.account.username !== username) throw new Error('unread')
          if (snapshot.account.ownerId === payload.ownerId) { note(status, copy('The account already has this owner. No changes were sent.'), 'unchanged'); return }
          if (typeof confirmDelete !== 'function') throw new Error('confirmation')
          const confirmed = await confirmDelete({ title: copy('Change account owner'), body: copy('Type the account username to confirm the ownership change: {username}', { username }), input: true, label: copy('Account username'), confirm: copy('Change owner'), danger: true })
          if (confirmed !== username) { note(status, copy('Ownership was not changed.'), 'cancelled'); return }
          mutationStarted = true
          result = await send('PATCH', path, payload)
          verificationPending = true
          if (!workspaceRecord(result) || !workspaceRecord(result.account) || result.account.username !== username || result.account.ownerId !== payload.ownerId) throw new Error('unverified')
          const readback = await send('GET', path)
          verified = workspaceRecord(readback) && workspaceRecord(readback.account) && readback.account.username === username && readback.account.ownerId === payload.ownerId
          savedMessage = copy('The account owner was stored and read back. Dependent host configuration still requires verification.')
        } else {
          const id = form.dataset.domainId
          if (!uuid(id) || (domainSelect && domainSelect.value !== id)) throw new Error('identity')
          const snapshot = await send('GET', '/api/domains')
          const domain = workspaceRecord(snapshot) && Array.isArray(snapshot.domains) ? snapshot.domains.find(item => workspaceRecord(item) && item.id === id) : undefined
          const revision = workspaceRecord(snapshot) && typeof snapshot.revision === 'string' && /^[0-9a-f]{64}$/.test(snapshot.revision) ? snapshot.revision : null
          if (!revision) throw new Error('unread')
          const php = mergeWorkspacePhp(workspaceRecord(domain) ? domain.php : null, values)
          mutationStarted = true
          result = await send('PATCH', '/api/domains/' + id, { php, expectedRevision: revision })
          verified = workspaceRecord(result) && workspaceRecord(result.domain) && result.domain.id === id && workspaceValuesMatch(php, result.domain.php)
        }
        if (!verified) { reviewRequired = true; note(status, copy('The response could not be verified. Refresh and inspect stored state before retrying.'), 'uncertain'); return }
        reviewRequired = true
        note(status, savedMessage, 'stored')
        const refresh = document.createElement('a'); refresh.href = window.location.pathname + window.location.search; refresh.textContent = copy('Reload page'); refresh.className = 'xp-btn'; status.insertAdjacentElement('afterend', refresh)
        window.dispatchEvent(new CustomEvent('xpanel:workspace-stored', { detail: { form: form.hasAttribute('data-domain-php-form') ? 'domain-php' : form.hasAttribute('data-server-settings-form') ? 'server-settings' : form.hasAttribute('data-setup-wizard-form') ? 'setup' : form.hasAttribute('data-reseller-update-form') ? 'reseller' : form.hasAttribute('data-reseller-owner-form') ? 'account-owner' : form.hasAttribute('data-account-plan-form') ? 'account-plan' : form.hasAttribute('data-firewall-port-rule-form') ? 'firewall-port-rule' : 'feature-list' } }))
      } catch (error) {
        reviewRequired = mutationStarted && (verificationPending || !definiteRefusal(error))
        note(status, reviewRequired
          ? copy('The operation outcome is unknown. Inspect stored state before retrying; no automatic retry was sent.')
          : copy('The request was refused or its fields could not be read. No automatic retry was sent.'), reviewRequired ? 'uncertain' : 'failed')
      } finally {
        busy = false; form.removeAttribute('aria-busy')
        controls.forEach(({ control, disabled }) => { control.disabled = disabled || reviewRequired })
      }
    })
  })

  document.querySelectorAll<HTMLButtonElement>('[data-feature-list-delete]').forEach(button => {
    if (button.dataset.workspaceBinding === 'true') return
    button.dataset.workspaceBinding = 'true'
    let busy = false, reviewRequired = false
    button.addEventListener('click', async () => {
      if (busy || reviewRequired || button.disabled || unavailable(button)) return
      const id = button.dataset.featureListId
      const root = button.closest('[data-feature-list-row],article,section') ?? button.parentElement!
      const status = statusFor(root)
      const send = request()
      if (!uuid(id) || typeof send !== 'function' || typeof confirmDelete !== 'function') { note(status, copy('Deletion is unavailable. No changes were sent.'), 'failed'); return }
      busy = true; button.disabled = true
      let mutationStarted = false
      try {
        const confirmed = await confirmDelete({ title: copy('Delete feature list'), body: copy('Delete this feature list? Plans using it may prevent deletion.'), confirm: copy('Delete'), danger: true })
        if (!confirmed) return
        note(status, copy('Deleting the requested feature list…'), 'pending')
        mutationStarted = true
        const result = await send('DELETE', '/api/feature-lists/' + id)
        if (!workspaceRecord(result) || result.ok !== true) throw new Error('unverified')
        reviewRequired = true
        note(status, copy('The feature list was deleted. Reload to read the updated list.'), 'stored')
      } catch (error) {
        reviewRequired = mutationStarted && !definiteRefusal(error)
        note(status, reviewRequired ? copy('The deletion outcome is unknown. Inspect stored state before retrying.') : copy('Deletion was refused. The list has not been confirmed deleted.'), reviewRequired ? 'uncertain' : 'failed')
      } finally { busy = false; button.disabled = reviewRequired }
    })
  })
}

/** Shares the exact parsing and receipt checks with the browser, rather than a second implementation. */
export const APPROVED_WORKSPACE_FORMS_CLIENT = `(function(confirmDelete) { const WORKSPACE_RESELLER_ACLS = ${JSON.stringify(WORKSPACE_RESELLER_ACLS)}; const WORKSPACE_FEATURE_KEYS = ${JSON.stringify(WORKSPACE_FEATURE_KEYS)}; const SERVER_FIELD_TYPES = ${JSON.stringify(SERVER_FIELD_TYPES)}; const PHP_FIELD_TYPES = ${JSON.stringify(PHP_FIELD_TYPES)}; ${workspaceRecord.toString()}; ${workspaceFieldValue.toString()}; ${mergeWorkspaceFields.toString()}; ${mergeWorkspaceServerSettings.toString()}; ${mergeWorkspacePhp.toString()}; ${workspaceValuesMatch.toString()}; ${workspaceFeatureReceipt.toString()}; ${workspaceDisabledFeatures.toString()}; ${workspaceResellerPatch.toString()}; (${bindApprovedWorkspaceForms.toString()})(confirmDelete); })`
