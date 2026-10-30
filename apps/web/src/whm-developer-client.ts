import { WHM_CLIENT_TEMPLATE_BINDING, clientTemplate as canonicalClientTemplate, clientTemplateSlot as canonicalClientTemplateSlot, cloneClientTemplate as canonicalCloneClientTemplate } from './whm-client-templates.ts'
const clientTemplate = canonicalClientTemplate, clientTemplateSlot = canonicalClientTemplateSlot, cloneClientTemplate = canonicalCloneClientTemplate
/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime as canonicalFormatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatDisplayDateTime = canonicalFormatDisplayDateTime

export type DeveloperBrowserSurface = 'account' | 'administrator' | 'integrations'
export type DeveloperBrowserOperation = 'identity' | 'preferences' | 'tokens'
export interface DeveloperBrowserManifest { surface: DeveloperBrowserSurface; available: boolean; writes: false; rawResponses: false; operations: { operation: DeveloperBrowserOperation; method: 'GET'; path: string }[] }
export interface DeveloperBrowserResult { operation: DeveloperBrowserOperation; request: { method: 'GET'; path: string }; state: 'read' | 'refused'; status: number; observedAt: string; fields: { key: string; value: string | null }[]; tokens: { name: string; scopes: string[]; expiresAt: string; state: string }[] }

/** Browser protocol is finite too; no response/header/body/path entered by the user is executed. */
export function parseDeveloperView(raw: unknown, surface: DeveloperBrowserSurface, operation?: DeveloperBrowserOperation): DeveloperBrowserManifest | DeveloperBrowserResult {
  const bad = (): never => { throw new Error('invalid_developer_reply') }
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
  const exact = (x: Record<string, unknown>, names: string[]) => Object.keys(x).sort().join() === names.sort().join()
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max && x.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(x)
  const time = (x: unknown): x is string => typeof x === 'string' && x.length <= 32 && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x
  const paths: Record<string, string> = surface === 'integrations' ? { tokens: '/api/server/panel/api-tokens' } : { identity: '/api/auth/me', preferences: surface === 'account' ? '/api/account/preferences' : '/api/admin/preferences', ...(surface === 'administrator' ? { tokens: '/api/server/panel/api-tokens' } : {}) }
  if (!obj(raw)) return bad()
  if (operation === undefined) {
    if (!exact(raw, ['surface', 'available', 'writes', 'rawResponses', 'operations']) || raw.surface !== surface || typeof raw.available !== 'boolean' || raw.writes !== false || raw.rawResponses !== false || !Array.isArray(raw.operations) || raw.operations.length !== Object.keys(paths).length) return bad()
    const seen = new Set<string>()
    const operations = raw.operations.map(x => {
      if (!obj(x) || !exact(x, ['operation', 'method', 'path']) || typeof x.operation !== 'string' || !Object.hasOwn(paths, x.operation) || seen.has(x.operation) || x.method !== 'GET' || x.path !== paths[x.operation]) return bad()
      seen.add(x.operation); return { operation: x.operation as DeveloperBrowserOperation, method: 'GET' as const, path: x.path as string }
    })
    return { surface, available: raw.available, writes: false, rawResponses: false, operations }
  }
  if (!Object.hasOwn(paths, operation) || !exact(raw, ['operation', 'request', 'state', 'status', 'observedAt', 'fields', 'tokens']) || raw.operation !== operation || !obj(raw.request) || !exact(raw.request, ['method', 'path']) || raw.request.method !== 'GET' || raw.request.path !== paths[operation]
    || !['read', 'refused'].includes(String(raw.state)) || !Number.isSafeInteger(raw.status) || (raw.state === 'read' ? (raw.status as number) < 200 || (raw.status as number) > 299 : (raw.status as number) < 400 || (raw.status as number) > 599) || !time(raw.observedAt) || !Array.isArray(raw.fields) || !Array.isArray(raw.tokens) || raw.tokens.length > 200) return bad()
  const expected = raw.state === 'refused' ? [] : operation === 'identity' ? ['username', 'role'] : operation === 'tokens' ? ['tokenCount'] : surface === 'account' ? ['contactEmail'] : ['preferenceState', 'language', 'theme', 'density']
  if (raw.fields.length !== expected.length || raw.tokens.length > 0 && (operation !== 'tokens' || raw.state !== 'read')) return bad()
  const fields = raw.fields.map((f, i) => {
    if (!obj(f) || !exact(f, ['key', 'value']) || f.key !== expected[i] || f.value !== null && !text(f.value, 254)) return bad()
    return { key: f.key as string, value: f.value as string | null }
  })
  const tokens = raw.tokens.map(t => {
    if (!obj(t) || !exact(t, ['name', 'scopes', 'expiresAt', 'state']) || !text(t.name, 64) || !/^[a-z0-9][a-z0-9-]*$/.test(t.name) || !Array.isArray(t.scopes) || t.scopes.length > 128 || new Set(t.scopes).size !== t.scopes.length || !t.scopes.every(s => typeof s === 'string' && /^(?:\*|[a-z][a-z0-9-]{0,63}:(?:read|write|\*))$/.test(s)) || !time(t.expiresAt) || !['active', 'expired', 'revoked'].includes(String(t.state))) return bad()
    return { name: t.name, scopes: t.scopes as string[], expiresAt: t.expiresAt, state: t.state as string }
  })
  if (operation === 'tokens' && raw.state === 'read' && fields[0]?.value !== String(tokens.length)) return bad()
  return { operation, request: { method: 'GET', path: paths[operation]! }, state: raw.state as 'read' | 'refused', status: raw.status as number, observedAt: raw.observedAt, fields, tokens }
}

function bindWhmDeveloper(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-developer-workspace]').forEach(root => {
    if (root.dataset.developerBound === 'true') return
    root.dataset.developerBound = 'true'
    const surface = root.dataset.developerSurface as DeveloperBrowserSurface
    const endpoint = surface === 'account' ? '/api/account/developer' : surface === 'administrator' ? '/api/server/panel/developer' : surface === 'integrations' ? '/api/server/panel/integrations' : null
    const q = <T extends Element = HTMLElement>(s: string): T | null => root.querySelector<T>(s)
    const form = q<HTMLFormElement>('[data-dev-form]'), select = q<HTMLSelectElement>('[data-dev-operation]'), run = q<HTMLButtonElement>('[data-dev-run]'), refresh = q<HTMLButtonElement>('[data-dev-refresh]'), copy = q<HTMLButtonElement>('[data-dev-copy]'), status = q('[data-dev-status]'), resultFields = q('[data-dev-result-fields]'), tokenRows = q('[data-dev-token-rows]'), tokenTable = q('[data-dev-token-table]')
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    if (!endpoint || !form || !select || !run || !refresh || !copy || !status || !resultFields || !tokenRows || !tokenTable) return
    const denied = '[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.developerEnabled === 'true' && !root.closest(denied) && typeof send === 'function'
    let manifest: DeveloperBrowserManifest | null = null, result: DeveloperBrowserResult | null = null, busy = false
    const labels: Record<string, string> = { identity: t('My signed-in identity'), preferences: t('My saved preferences'), tokens: t('My API token metadata'), username: t('Username'), role: t('Role'), contactEmail: t('Contact email'), preferenceState: t('Preference state'), language: t('Language'), theme: t('Theme'), density: t('Density'), tokenCount: t('Token count') }
    const ascii = (value: string): string => value.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, digit => String('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669'.includes(digit) ? '\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669'.indexOf(digit) : '\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9'.indexOf(digit)))
    const ltr = (value: string): HTMLElement => { const node = document.createElement('bdi'); node.dir = 'ltr'; node.textContent = ascii(value); return node }
    const fact = (key: string, value: string | null): void => { const node = q('[data-dev-fact="' + key + '"]'); if (node) { node.textContent = ''; node.append(value === null ? t('Not read') : ltr(value)) } }
    const note = (state: string, message: string): void => { status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' || state === 'refused' ? 'alert' : 'status') }
    const lock = (): void => { const on = admitted() && !busy; refresh.disabled = !on; select.disabled = !on || !manifest?.available; run.disabled = select.disabled || !manifest?.operations.some(d => d.operation === select.value); copy.disabled = !on || !result || typeof navigator.clipboard?.writeText !== 'function' }
    const selected = (): void => { const descriptor = manifest?.operations.find(d => d.operation === select.value); fact('method', descriptor?.method ?? null); fact('path', descriptor?.path ?? null); lock() }
    const clear = (): void => { result = null; tokenTable.hidden = true; tokenRows.textContent = ''; resultFields.textContent = ''; fact('status', null); fact('observed', null); const p = q('[data-dev-copy-status]'); if (p) { p.hidden = true; p.textContent = '' }; lock() }
    const paint = (value: DeveloperBrowserResult): void => {
      result = value; fact('status', String(value.status)); fact('observed', formatDisplayDateTime(value.observedAt)); resultFields.textContent = ''
      for (const f of value.fields) { const group = cloneClientTemplate(clientTemplate(root, 'whm-developer-field'), 'div', ['label', 'value']); clientTemplateSlot(group, 'label', 'dt').textContent = labels[f.key] ?? f.key; clientTemplateSlot(group, 'value', 'dd').replaceChildren(f.value === null ? t('Unavailable') : ltr(f.value)); resultFields.append(group) }
      tokenTable.hidden = value.operation !== 'tokens' || value.state !== 'read'; tokenRows.textContent = ''
      for (const item of value.tokens) { const row = document.createElement('tr'); for (const v of [item.name, item.scopes.join(', '), formatDisplayDateTime(item.expiresAt), item.state === 'active' ? t('Active') : item.state === 'expired' ? t(msgctxt('whm-developer-client', 'Expired')) : t('Revoked')]) { const td = document.createElement('td'); td.append(ltr(v)); row.append(td) }; tokenRows.append(row) }
      if (!value.tokens.length && !tokenTable.hidden) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 4; td.textContent = t('You have no API tokens.'); row.append(td); tokenRows.append(row) }
      note(value.state, value.state === 'read' ? t('The selected API read completed. The response below contains reviewed fields only.') : t('The selected API refused this read. No response body was exposed.'))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; clear(); lock(); note('reading', t('Reading supported operations…'))
      try { const next = parseDeveloperView(await send!('GET', endpoint), surface) as DeveloperBrowserManifest; if (!admitted()) return; manifest = next; select.textContent = ''; for (const d of next.operations) { const option = document.createElement('option'); option.value = d.operation; option.textContent = labels[d.operation]!; select.append(option) }; selected(); note(next.available ? 'ready' : 'unavailable', next.available ? t('Choose an operation, then run its read request.') : t('The guarded API provider is unavailable. No request can run.')) }
      catch { manifest = null; select.textContent = ''; fact('method', null); fact('path', null); if (admitted()) note('failed', t('Supported operations could not be read. Refresh to retry.')) }
      finally { busy = false; lock() }
    }
    form.addEventListener('submit', event => { event.preventDefault(); if (busy || run.disabled || !admitted()) return; const operation = manifest?.operations.find(d => d.operation === select.value)?.operation; if (!operation) return; busy = true; clear(); lock(); note('reading', t('Running the selected API read…')); void (async () => {
      try { const next = parseDeveloperView(await send!('POST', endpoint, { operation }), surface, operation) as DeveloperBrowserResult; if (admitted()) paint(next) }
      catch { result = null; if (admitted()) note('failed', t('The read could not be verified. No response is shown.')) }
      finally { busy = false; lock() }
    })() })
    refresh.addEventListener('click', () => { void load() }); select.addEventListener('change', () => { clear(); selected() })
    copy.addEventListener('click', () => { if (copy.disabled || !result || !admitted()) return; const captured = JSON.stringify(result, null, 2), node = q('[data-dev-copy-status]'); void navigator.clipboard.writeText(captured).then(() => { if (node) { node.hidden = false; node.textContent = t('Reviewed response copied.') } }).catch(() => { if (node) { node.hidden = false; node.textContent = t('Copy is unavailable. Select the displayed fields to copy them.') } }) })
    if (!admitted()) { lock(); note('unavailable', t('The explorer is unavailable in this session. Nothing was read.')); return }
    void load()
  })
}
export const WHM_DEVELOPER_CLIENT_BINDING = `(()=>{${WHM_CLIENT_TEMPLATE_BINDING}const formatDisplayDateTime=${DISPLAY_DATETIME_BINDING};const parseDeveloperView=${parseDeveloperView.toString()};return ${bindWhmDeveloper.toString()};})()`
