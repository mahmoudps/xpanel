/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const formatMailxDateTime = formatDisplayDateTime

export type MailxSectionName = 'spam' | 'relay' | 'bcc' | 'marketing'
export type MailxSectionView = {
  section: MailxSectionName
  saved: boolean
  revision: string
  compositeRevision: string | null
  policy: Record<string, unknown>
  host: 'connected' | 'not-connected' | 'unverified'
  observedAt: string | null
  state: 'not-saved' | 'applied' | 'pending' | 'unavailable'
  updatedAt: string | null
  updatedBy: string | null
  engine: { engine: 'rspamd' | 'spamassassin' | null; wiring: 'wired' | 'not-wired' | 'unknown' } | null
  application: { outcome: 'applied' | 'rolled-back' | 'nothing' | 'refused' | 'unknown' | 'not-connected'; verificationRequired: boolean; spam: string | null } | null
}
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>

/** Strict reader for GET/PUT /api/server/mailx/{section}; unknown fields are dropped and a password never survives. */
export function readMailxSectionView(value: unknown, section: string): MailxSectionView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const bad = (): never => { throw new Error('invalid_mailx_view') }
  const hex = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{64}$/.test(item)
  const iso = (item: unknown): item is string => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item) && Number.isFinite(Date.parse(item))
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const num = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 1000000
  const nullableText = (item: unknown, max: number): item is string | null => item === null || text(item, max)
  const strings = (item: unknown, max: number): string[] => Array.isArray(item) && item.length <= max && item.every(entry => text(entry, 254)) ? [...item] as string[] : bad()
  const rules = (item: unknown): { match: string; copyTo: string }[] => Array.isArray(item) && item.length <= 500 ? item.map(rule => object(rule) && text(rule.match, 254) && text(rule.copyTo, 254) ? { match: rule.match, copyTo: rule.copyTo } : bad()) : bad()
  const policy = (raw: unknown): Record<string, unknown> => {
    if (!object(raw)) return bad()
    if (section === 'spam') return typeof raw.enabled === 'boolean' && num(raw.rejectScore) && num(raw.headerScore) && (raw.greylistScore === null || num(raw.greylistScore))
      ? { enabled: raw.enabled, rejectScore: raw.rejectScore, headerScore: raw.headerScore, greylistScore: raw.greylistScore, blockedDomains: strings(raw.blockedDomains, 500) } : bad()
    if (section === 'relay') return typeof raw.enabled === 'boolean' && nullableText(raw.host, 253) && num(raw.port) && nullableText(raw.username, 128) && typeof raw.passwordSet === 'boolean'
      ? { enabled: raw.enabled, host: raw.host, port: raw.port, username: raw.username, passwordSet: raw.passwordSet } : bad()
    if (section === 'bcc') return nullableText(raw.alwaysBcc, 254) ? { alwaysBcc: raw.alwaysBcc, recipient: rules(raw.recipient), sender: rules(raw.sender) } : bad()
    const keys = ['messageRateLimit', 'recipientRateLimit', 'recipientsPerMessage', 'destinationRateDelay', 'destinationConcurrency', 'rateWindow']
    return keys.every(key => num(raw[key])) ? Object.fromEntries(keys.map(key => [key, raw[key]])) : bad()
  }
  if (!object(value) || value.section !== section || !['spam', 'relay', 'bcc', 'marketing'].includes(section) || typeof value.saved !== 'boolean' || !hex(value.revision)
    || !(value.compositeRevision === undefined || hex(value.compositeRevision)) || !['connected', 'not-connected', 'unverified'].includes(String(value.host))
    || !(value.observedAt === null || iso(value.observedAt)) || !['not-saved', 'applied', 'pending', 'unavailable'].includes(String(value.state))
    || !(value.updatedAt === null || iso(value.updatedAt)) || !nullableText(value.updatedBy, 128) || (value.state === 'not-saved') === value.saved) return bad()
  const engine = value.engine === null || value.engine === undefined ? null : object(value.engine) && [null, 'rspamd', 'spamassassin'].includes(value.engine.engine as string) && ['wired', 'not-wired', 'unknown'].includes(String(value.engine.wiring))
    ? { engine: value.engine.engine as 'rspamd' | null, wiring: value.engine.wiring as 'wired' } : bad()
  const app = value.application
  const application = app === null || app === undefined ? null : object(app) && ['applied', 'rolled-back', 'nothing', 'refused', 'unknown', 'not-connected'].includes(String(app.outcome)) && typeof app.verificationRequired === 'boolean' && nullableText(app.spam, 32)
    ? { outcome: app.outcome as 'applied', verificationRequired: app.verificationRequired, spam: app.spam as string | null } : bad()
  return { section: section as MailxSectionName, saved: value.saved, revision: value.revision, compositeRevision: (value.compositeRevision as string | undefined) ?? null, policy: policy(value.policy),
    host: value.host as 'connected', observedAt: value.observedAt as string | null, state: value.state as 'applied', updatedAt: value.updatedAt as string | null, updatedBy: value.updatedBy as string | null, engine, application }
}

function bindMailxWhm(): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-mailx-whm]').forEach(root => {
    if (root.dataset.mailxBound === 'true') return
    root.dataset.mailxBound = 'true'
    const section = root.dataset.mailxPage ?? '', status = root.querySelector<HTMLElement>('[data-mailx-status]'), refresh = root.querySelector<HTMLButtonElement>('[data-mailx-refresh]')
    const form = root.querySelector<HTMLElement>('[data-mailx-form]'), save = root.querySelector<HTMLButtonElement>('[data-mailx-save]'), again = root.querySelector<HTMLButtonElement>('[data-mailx-apply]')
    const formStatus = root.querySelector<HTMLElement>('[data-mailx-form-status]')
    const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
    if (!['spam', 'relay', 'bcc', 'marketing'].includes(section) || !status || !refresh || !form || !save || !again || !formStatus) return
    const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
    const admitted = (): boolean => root.isConnected && root.dataset.mailxCanRead === 'true' && !root.closest(denied) && !!request
    const manage = (): boolean => admitted() && root.dataset.mailxCanManage === 'true'
    const field = (key: string): HTMLInputElement | HTMLTextAreaElement | null => root.querySelector('[data-mailx-field="' + key + '"]')
    let view: MailxSectionView | null = null, busy = false
    const note = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
    const controls = (): void => {
      const writable = manage() && !!view && !busy
      refresh.disabled = busy || !admitted(); save.disabled = !writable; again.disabled = !writable || !view?.saved || view?.compositeRevision === null || view?.host !== 'connected'
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-mailx-field]').forEach(input => { if (input.dataset.mailxField !== 'countries') input.disabled = !writable })
    }
    const fact = (key: string, content: string | Node): void => { const cell = root.querySelector<HTMLElement>('[data-mailx-fact="' + key + '"]'); if (cell) { cell.textContent = ''; cell.append(content) } }
    const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
    const set = (key: string, value: unknown): void => {
      const input = field(key)
      if (!input) return
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = value === true
      else input.value = value === null || value === undefined ? '' : Array.isArray(value) ? value.join('\n') : String(value)
    }
    const lines = (key: string): string[] => (field(key)?.value ?? '').split('\n').map(line => line.trim()).filter(Boolean)
    const number = (key: string): number => { const raw = (field(key)?.value ?? '').trim(); return raw === '' ? Number.NaN : Number(raw) }
    const checked = (key: string): boolean => (field(key) as HTMLInputElement | null)?.checked === true
    const outcomes: Record<string, string> = {
      applied: t('Saved and applied. Postfix confirmed the change.'), 'rolled-back': t('Saved, but the new settings failed the configuration check, so the previous settings were restored.'),
      nothing: t('Saved. There was nothing to apply.'), refused: t('Saved, but the host refused to apply it. Check the state above.'),
      unknown: t('Saved, but the apply outcome is unknown. Review the mail service before retrying.'), 'not-connected': t('Saved. No host agent is connected, so it is not applied yet.'),
    }
    const paint = (next: MailxSectionView): void => {
      view = next
      const states: Record<string, string> = { 'not-saved': t('Not managed by xPanel'), applied: t('Applied'), pending: t('Not applied yet'), unavailable: t('Unavailable') }
      const hosts: Record<string, string> = { connected: t('Connected'), 'not-connected': t('Not connected'), unverified: t('Not verified') }
      fact('saved', next.saved ? t('Saved') : t('Not saved; defaults are shown'))
      fact('host', hosts[next.host]!); fact('state', states[next.state]!)
      fact('observed-at', next.observedAt === null ? t('Not read') : formatMailxDateTime(next.observedAt))
      fact('updated', next.updatedAt === null ? t('Never') : t('{when} by {who}', { when: formatMailxDateTime(next.updatedAt), who: next.updatedBy ?? '' }))
      if (section === 'spam') {
        fact('engine', next.engine === null ? t('Not read') : next.engine.engine === null ? t('No supported filter is running') : technical(next.engine.engine))
        fact('wiring', next.engine === null || next.engine.wiring === 'unknown' ? t('Not verified') : next.engine.wiring === 'wired' ? t('Yes') : t('No. Postfix gets the filter after the saved policy is applied with filtering on and a supported filter installed.'))
      }
      const policy = next.policy
      for (const [key, value] of Object.entries(policy)) set(key, value)
      if (section === 'spam') { set('greylisting', policy.greylistScore !== null); if (policy.greylistScore === null) set('greylistScore', '') }
      if (section === 'relay') { set('password', ''); const password = field('password'); if (password) password.placeholder = policy.passwordSet ? t('A password is saved') : '' }
      if (section === 'bcc') for (const key of ['recipient', 'sender']) set(key, (policy[key] as { match: string; copyTo: string }[]).map(rule => rule.match + ' ' + rule.copyTo))
      if (next.host !== 'connected') note(status, 'unavailable', next.host === 'not-connected' ? t('No protected host agent is connected. The saved policy is shown without a host observation.') : t('The host observation could not be verified. The saved policy is shown without it.'))
      else if (next.state === 'pending') note(status, 'drift', t('The saved policy is not applied on this server yet.'))
      else if (next.state === 'unavailable') note(status, 'partial', section === 'spam' ? t('No supported spam filter is running, so the saved thresholds cannot be applied.') : t('The host configuration could not be read.'))
      else note(status, 'read', next.saved ? t('The saved policy is applied on this server.') : t('xPanel does not manage these settings yet. Saving takes over these settings.'))
    }
    const collect = (): Record<string, unknown> | null => {
      if (section === 'spam') return { enabled: checked('enabled'), rejectScore: number('rejectScore'), headerScore: number('headerScore'), greylistScore: checked('greylisting') ? number('greylistScore') : null, blockedDomains: lines('blockedDomains').map(item => item.toLowerCase()) }
      if (section === 'relay') { const host = (field('host')?.value ?? '').trim().toLowerCase(), username = (field('username')?.value ?? '').trim(); return { enabled: checked('enabled'), host: host || null, port: number('port'), username: username || null } }
      if (section === 'bcc') {
        const parse = (key: string): { match: string; copyTo: string }[] | null => { const rows = lines(key).map(line => line.toLowerCase().split(/\s+/)); return rows.every(row => row.length === 2) ? rows.map(([match, copyTo]) => ({ match: match!, copyTo: copyTo! })) : null }
        const recipient = parse('recipient'), sender = parse('sender'), always = (field('alwaysBcc')?.value ?? '').trim().toLowerCase()
        return recipient && sender ? { alwaysBcc: always || null, recipient, sender } : null
      }
      return Object.fromEntries(['messageRateLimit', 'recipientRateLimit', 'recipientsPerMessage', 'destinationRateDelay', 'destinationConcurrency', 'rateWindow'].map(key => [key, number(key)]))
    }
    const load = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); root.setAttribute('aria-busy', 'true'); note(status, 'reading', t('Reading the saved mail policy…'))
      try { const next = readMailxSectionView(await request!('GET', '/api/server/mailx/' + section), section); if (admitted()) paint(next) }
      catch { if (admitted()) note(status, 'failed', t('The mail policy could not be read. Values shown are from the last successful read.')) }
      finally { busy = false; controls(); root.setAttribute('aria-busy', 'false') }
    }
    const send = async (method: string, path: string, body: unknown, saved: boolean): Promise<void> => {
      busy = true; controls(); note(formStatus, 'saving', saved ? t('Saving and applying…') : t('Applying the saved policy…'))
      try {
        const reply = await request!(method, path, body) as { application?: { outcome?: string; reconcile?: string } } | null
        const outcome = String(reply?.application?.outcome ?? 'unknown')
        // The milter is rendered by a reconciler generation; a refused generation leaves Postfix without the filter.
        if ((outcome === 'applied' || outcome === 'nothing') && reply?.application?.reconcile === 'failed') note(formStatus, 'partial', t('Saved, but the configuration generation that adds the filter to Postfix failed and was rolled back. Check the generation history.'))
        else note(formStatus, outcome === 'applied' || outcome === 'nothing' ? 'saved' : outcome === 'unknown' ? 'failed' : 'partial', saved ? outcomes[outcome] ?? outcomes.unknown! : outcome === 'applied' ? t('Applied. Postfix confirmed the change.') : outcomes[outcome] ?? outcomes.unknown!)
      } catch (error) {
        const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
        note(formStatus, 'failed', details.unknownOutcome === true || details.verificationRequired === true ? t('The save outcome is unknown. Reload and review before retrying.')
          : problem.status === 401 || problem.status === 403 ? t('You are not allowed to change this policy. Nothing was saved.')
            : problem.status === 409 || problem.code === 'CONFLICT' ? t('The policy changed since it was read. Reload and review before saving.')
              : problem.status === 422 || problem.code === 'VALIDATION' ? t('Some values are not valid. Nothing was saved.') : t('The request failed. Reload to see what was saved.'))
      } finally { busy = false; controls() }
      await load()
    }
    // A read-only document renders the fields in a <div>, which never submits.
    if (form instanceof HTMLFormElement) form.addEventListener('submit', event => {
      event.preventDefault()
      if (busy || !manage() || !view) return
      const policy = collect()
      if (!policy) { note(formStatus, 'failed', t('Each rule needs an address or @domain and one copy address. Nothing was saved.')); return }
      const password = section === 'relay' ? (field('password')?.value ?? '') : ''
      void send('PUT', '/api/server/mailx/' + section, { policy, expectedRevision: view.revision, ...(section === 'relay' ? { password: password === '' ? null : password } : {}) }, true)
    })
    again.addEventListener('click', () => { if (!busy && manage() && view?.compositeRevision) void send('POST', '/api/server/mailx/apply', { expectedRevision: view.compositeRevision }, false) })
    refresh.addEventListener('click', () => { void load() })
    if (!admitted()) { controls(); note(status, 'unavailable', t('The mail policy is unavailable here. Nothing was read.')); return }
    void load()
  })
}

export const MAILX_WHM_CLIENT_BINDING = `(()=>{const formatMailxDateTime=${DISPLAY_DATETIME_BINDING};const readMailxSectionView=${readMailxSectionView.toString()};return ${bindMailxWhm.toString()};})()`
