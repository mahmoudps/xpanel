/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

export interface ConvertAddonCandidates { candidates: { domainId: string; domain: string; docRoot: string; account: { id: string; username: string; status: string } }[]; plans: { id: string; name: string }[]; capabilities: { preview: boolean; apply: boolean; reason: string } }
export interface ConvertAddonReview {
  revision: string
  plan: { source: { accountId: string; username: string; domainId: string; domain: string; docRoot: string }; target: { username: string; planId: string; planName: string | null; home: string | null; documentRoot: string | null }
    domains: { id: string; name: string; kind: string; docRoot: string }[]; mail: { mailboxes: string[]; otherServiceUsers: string[] }; dns: { zone: string; records: number }[]; certificates: number; conflicts: { kind: string; value: string }[] }
}
const shared = () => {
  const bad = (): never => { throw new Error('invalid_convert_addon') }
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const uuid = (item: unknown): item is string => typeof item === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= max
  const capabilities = (item: unknown) => object(item) && typeof item.preview === 'boolean' && typeof item.apply === 'boolean' && text(item.reason, 64) ? { preview: item.preview, apply: item.apply, reason: item.reason } : bad()
  return { bad, object, uuid, text, capabilities }
}

/** Strict reader for GET /api/transfers/convert-addon (apps/api/src/acct-convert-addon.ts). */
export function readConvertAddonCandidates(value: unknown): ConvertAddonCandidates {
  const { bad, object, uuid, text, capabilities } = shared()
  if (!object(value) || !Array.isArray(value.candidates) || value.candidates.length > 5000 || !Array.isArray(value.plans) || value.plans.length > 1000) return bad()
  const candidates = value.candidates.map(item => object(item) && uuid(item.domainId) && text(item.domain, 253) && text(item.docRoot, 4096) && object(item.account) && uuid(item.account.id) && text(item.account.username, 32) && ['active', 'suspended', 'terminating'].includes(String(item.account.status))
    ? { domainId: item.domainId, domain: item.domain, docRoot: item.docRoot, account: { id: item.account.id, username: item.account.username, status: String(item.account.status) } } : bad())
  const plans = value.plans.map(item => object(item) && uuid(item.id) && text(item.name, 128) ? { id: item.id, name: item.name } : bad())
  return { candidates, plans, capabilities: capabilities(value.capabilities) }
}
/** Strict reader for a completed POST /api/transfers/convert-addon/apply. */
export function readConvertAddonResult(value: unknown): { username: string; files: number } {
  const { bad, object, text } = shared()
  return object(value) && value.converted === true && object(value.account) && text(value.account.username, 32) && object(value.files) && Number.isSafeInteger(value.files.files) && value.sourceCleanup === 'moved-to-trash' && value.passwordResetRequired === true
    ? { username: value.account.username, files: value.files.files as number } : bad()
}
/** Strict reader for POST /api/transfers/convert-addon/preview. */
export function readConvertAddonReview(value: unknown): ConvertAddonReview {
  const { bad, object, uuid, text } = shared()
  if (!object(value) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !object(value.plan)) return bad()
  const plan = value.plan, source = plan.source, target = plan.target, mail = plan.mail
  const names = (item: unknown, max: number): string[] => Array.isArray(item) && item.length <= max && item.every(name => text(name, 320)) ? [...item as string[]] : bad()
  const nullable = (item: unknown, max: number): string | null => item === null ? null : text(item, max) ? item : bad()
  if (!object(source) || !uuid(source.accountId) || !text(source.username, 32) || !uuid(source.domainId) || !text(source.domain, 253) || !text(source.docRoot, 4096)
    || !object(target) || !text(target.username, 32) || !uuid(target.planId) || !object(mail) || !Array.isArray(plan.domains) || plan.domains.length > 5000 || !Array.isArray(plan.dns) || plan.dns.length > 5000
    || typeof plan.certificates !== 'number' || !Number.isSafeInteger(plan.certificates) || plan.certificates < 0 || !Array.isArray(plan.conflicts) || plan.conflicts.length > 5000) return bad()
  return { revision: value.revision, plan: {
    source: { accountId: source.accountId, username: source.username, domainId: source.domainId, domain: source.domain, docRoot: source.docRoot },
    target: { username: target.username, planId: target.planId, planName: nullable(target.planName, 128), home: nullable(target.home, 4096), documentRoot: nullable(target.documentRoot, 4096) },
    domains: plan.domains.map(item => object(item) && uuid(item.id) && text(item.name, 253) && ['addon', 'subdomain', 'alias', 'primary'].includes(String(item.kind)) && text(item.docRoot, 4096) ? { id: item.id, name: item.name, kind: String(item.kind), docRoot: item.docRoot } : bad()),
    mail: { mailboxes: names(mail.mailboxes, 10_000), otherServiceUsers: names(mail.otherServiceUsers, 10_000) },
    dns: plan.dns.map(item => object(item) && text(item.zone, 253) && typeof item.records === 'number' && Number.isSafeInteger(item.records) && item.records >= 0 ? { zone: item.zone, records: item.records } : bad()),
    certificates: plan.certificates,
    conflicts: plan.conflicts.map(item => object(item) && ['username-invalid', 'username-taken', 'plan-missing', 'account-inactive', 'docroot-outside-home', 'docroot-shared', 'subdomain-docroot-outside', 'service-user-not-mail', 'certificate-shared', 'custom-configuration', 'plan-capacity'].includes(String(item.kind)) && typeof item.value === 'string' && item.value.length <= 4096 ? { kind: String(item.kind), value: item.value } : bad()),
  } }
}

function bindConvertAddon(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-acct-convert-addon]').forEach(root => {
    if (root.dataset.bound === 'true') return
    root.dataset.bound = 'true'
    const send = (window as Window & { xpanelSessionRequest?: (method: string, path: string, body?: unknown) => Promise<unknown> }).xpanelSessionRequest
    const $ = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!
    const status = $<HTMLElement>('[data-acct-convert-status]'), reviewStatus = $<HTMLElement>('[data-acct-convert-review-status]'), capability = $<HTMLElement>('[data-acct-convert-capability]')
    const domain = $<HTMLSelectElement>('[data-acct-convert-input="domainId"]'), username = $<HTMLInputElement>('[data-acct-convert-input="username"]'), plan = $<HTMLSelectElement>('[data-acct-convert-input="planId"]')
    const confirm = $<HTMLInputElement>('[data-acct-convert-input="confirm"]'), preview = $<HTMLButtonElement>('[data-acct-convert-preview]'), apply = $<HTMLButtonElement>('[data-acct-convert-apply]'), refresh = $<HTMLButtonElement>('[data-acct-convert-refresh]')
    const form = $<HTMLElement>('[data-acct-convert-form]'), facts = $<HTMLElement>('[data-acct-convert-facts]'), loading = $<HTMLElement>('[data-acct-convert-loading]'), empty = $<HTMLElement>('[data-acct-convert-empty]')
    if (!status || !reviewStatus || !capability || !domain || !username || !plan || !confirm || !preview || !apply || !refresh || !form || !facts || !loading || !empty) return
    let data: ConvertAddonCandidates | null = null, review: ConvertAddonReview | null = null, reviewed = '', busy = false
    const admitted = (): boolean => !!send && root.isConnected && root.dataset.canManage === 'true' && !root.closest('[data-capability-unavailable="true"],[data-read-only="true"],[data-wiring="unavailable"]')
    const announce = (target: HTMLElement, state: string, message: string): void => { target.dataset.state = state; target.textContent = message; target.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(state) ? 'alert' : 'status') }
    const current = (): string => JSON.stringify([domain.value, username.value.trim(), plan.value])
    const controls = (): void => {
      const locked = busy || !admitted() || !data
      refresh.disabled = busy || !admitted()
      domain.disabled = username.disabled = plan.disabled = preview.disabled = locked || !data?.candidates.length || !data.capabilities.preview
      const ready = !!review && reviewed === current() && review.plan.conflicts.length === 0
      confirm.disabled = locked || !ready || !data!.capabilities.apply
      apply.disabled = confirm.disabled || confirm.value !== 'convert ' + review!.plan.source.domain
      root.setAttribute('aria-busy', String(busy)); loading.hidden = !busy || data !== null
    }
    const rows = (key: string, values: string[][], none: string): void => {
      const body = $<HTMLElement>('[data-acct-convert-rows="' + key + '"]'), columns = body.closest('table')?.querySelectorAll('thead th').length ?? 1
      body.textContent = ''
      if (!values.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns; cell.textContent = none; row.append(cell); body.append(row); return }
      for (const value of values) { const row = document.createElement('tr'); for (const [index, text] of value.entries()) { const cell = document.createElement('td'), bdi = document.createElement('bdi'); bdi.dir = index === 0 || key === 'dns' ? 'ltr' : 'auto'; bdi.textContent = text; cell.append(bdi); row.append(cell) } body.append(row) }
    }
    const kinds: Record<string, string> = { addon: msgid('Addon domain'), subdomain: msgid('Subdomain'), alias: msgid('Alias'), primary: msgid('Primary domain') }
    const conflicts: Record<string, string> = {
      'username-invalid': msgid('This username is not allowed'), 'username-taken': msgid('This username is already in use'), 'plan-missing': msgid('The plan no longer exists'),
      'account-inactive': msgid('The owner account is not active'), 'docroot-outside-home': msgid("The document root is outside the owner's home directory"), 'docroot-shared': msgid('The document root is shared with another domain of the owner'),
      'subdomain-docroot-outside': msgid('This subdomain keeps its files outside the addon document root'), 'service-user-not-mail': msgid('This user has FTP or WebDisk access; move or remove it first'),
      'certificate-shared': msgid('This domain shares a certificate with the addon domain'), 'custom-configuration': msgid('This domain has a custom web server configuration; remove it first'),
      'plan-capacity': msgid('The plan of the new account does not allow this many'),
    }
    const paintReview = (): void => {
      facts.textContent = ''
      const notRead = t('Not read')
      const fact = (label: string, value: string | null, ltr = true): void => { const wrap = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'), bdi = document.createElement('bdi'); wrap.className = 'xp-whm-detail-field'; dt.textContent = label; bdi.dir = ltr ? 'ltr' : 'auto'; bdi.textContent = value ?? notRead; dd.append(bdi); wrap.append(dt, dd); facts.append(wrap) }
      if (review) {
        const p = review.plan
        fact(t('Owner account'), p.source.username); fact(t('Current document root'), p.source.docRoot); fact(t('New home directory'), p.target.home); fact(t('New document root'), p.target.documentRoot)
        fact(t('Plan'), p.target.planName, false); fact(t('Certificates that move'), String(p.certificates))
      }
      const none = t('Nothing to list for this conversion.')
      rows('domains', (review?.plan.domains ?? []).map(item => [item.name, t(kinds[item.kind] ?? msgid('Domain')), item.docRoot]), none)
      rows('mail', review ? [...review.plan.mail.mailboxes.map(login => [login, t('Email')]), ...review.plan.mail.otherServiceUsers.map(login => [login, t('FTP or Web Disk')])] : [], none)
      rows('dns', (review?.plan.dns ?? []).map(item => [item.zone, String(item.records)]), none)
      rows('conflicts', (review?.plan.conflicts ?? []).map(item => [t(conflicts[item.kind]!), item.value]), t('No conflicts were found.'))
      controls()
    }
    const read = async (): Promise<void> => {
      if (busy || !admitted()) return
      busy = true; controls(); announce(status, 'loading', t('Reading addon domains.'))
      try {
        data = readConvertAddonCandidates(await send!('GET', '/api/transfers/convert-addon'))
        const keep = [domain.value, plan.value]
        domain.textContent = ''; plan.textContent = ''
        for (const item of data.candidates) { const option = document.createElement('option'); option.value = item.domainId; option.textContent = item.domain + ' · ' + item.account.username; domain.append(option) }
        for (const item of data.plans) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; plan.append(option) }
        if (data.candidates.some(item => item.domainId === keep[0])) domain.value = keep[0]!
        if (data.plans.some(item => item.id === keep[1])) plan.value = keep[1]!
        empty.hidden = data.candidates.length > 0
        capability.textContent = data.capabilities.apply ? t('Converting is available after a review without conflicts and the typed confirmation.') : t('Converting is unavailable on this server: it needs the host agent and the confined account file runner. The review stays available and nothing is changed.')
        announce(status, data.candidates.length ? 'read' : 'empty', data.candidates.length ? t('{n, plural, one {# addon domain can be reviewed.} other {# addon domains can be reviewed.}}', { n: data.candidates.length }) : t('No addon domains were found.'))
      } catch { data = null; empty.hidden = true; announce(status, 'failed', t('Addon domains could not be read.')) }
      finally { busy = false; controls() }
    }
    const runPreview = async (): Promise<void> => {
      if (busy || !data || !admitted()) return
      const name = username.value.trim()
      if (!/^[a-z][a-z0-9]{0,15}$/.test(name)) { announce(reviewStatus, 'failed', t('Enter a username of lower-case letters and digits that starts with a letter. Nothing was sent.')); return }
      busy = true; controls(); const sent = current()
      try {
        review = readConvertAddonReview(await send!('POST', '/api/transfers/convert-addon/preview', { domainId: domain.value, username: name, planId: plan.value }))
        reviewed = sent; confirm.value = ''
        announce(reviewStatus, review.plan.conflicts.length ? 'conflicts' : 'read', review.plan.conflicts.length ? t('The review lists conflicts. Resolve them before converting.') : t('Review read from saved state. Nothing has changed.'))
      } catch { review = null; reviewed = ''; announce(reviewStatus, 'failed', t('The conversion could not be reviewed. Nothing has changed.')) }
      finally { busy = false; paintReview() }
    }
    const runApply = async (): Promise<void> => {
      if (busy || apply.disabled || !review || !admitted()) return
      if (!askDialog || await askDialog({ title: t('Convert {domain} to its own account?', { domain: review.plan.source.domain }), body: t('The server checks the reviewed state again before changing anything.'), danger: true, confirm: t('Convert to account') }) !== true) return
      busy = true; controls()
      try {
        const source = review.plan.source
        let result: { username: string; files: number } | null = null
        try { result = readConvertAddonResult(await send!('POST', '/api/transfers/convert-addon/apply', { domainId: source.domainId, username: review.plan.target.username, planId: review.plan.target.planId, expectedRevision: review.revision, confirm: confirm.value })) } catch (error) { if (!(error instanceof Error) || error.message !== 'invalid_convert_addon') throw error }
        if (result) announce(reviewStatus, 'done', t('{domain} is now the account {username}. {files, plural, one {# file was} other {# files were}} copied and read back, and the old copies are in the trash of {source}. Set a password for {username} before its owner signs in.', { domain: source.domain, username: result.username, files: result.files, source: source.username }))
        else announce(reviewStatus, 'uncertain', t('The server answered, but the result could not be verified. Read the accounts again to confirm it.'))
      } catch (error) {
        const failed = error as { status?: number; details?: { stateChanged?: boolean; rolledBack?: boolean } } | null
        announce(reviewStatus, failed?.status === 409 ? 'stale' : failed?.details?.stateChanged === false ? 'failed' : 'uncertain', failed?.status === 409 ? t('Saved state changed since the review. Review again.') : failed?.details?.stateChanged === false ? t('The server refused the conversion. Nothing was changed.')
          : failed?.details?.rolledBack === true ? t('The conversion failed and its saved settings were restored. A system user for the new account may remain on the server; review it before retrying.') : t('The outcome requires review. No retry was sent.'))
        review = null; reviewed = ''
      } finally { busy = false; paintReview() }
    }
    if (!admitted()) { [domain, username, plan, preview, refresh].forEach(control => { control.disabled = true }); announce(status, root.dataset.canManage === 'true' ? 'unavailable' : 'denied', root.dataset.canManage === 'true' ? t('Addon conversion is unavailable here. Nothing was read or changed.') : t('Only the server administrator can convert addon domains.')); return }
    form.addEventListener('submit', event => { event.preventDefault(); void runPreview() })
    preview.addEventListener('click', event => { if (form.tagName !== 'FORM') { event.preventDefault(); void runPreview() } })
    const edited = (): void => { if (review && reviewed !== current()) announce(reviewStatus, 'stale', t('The choices changed. Review the conversion again.')); controls() }
    for (const control of [domain, username, plan]) { control.addEventListener('input', edited); control.addEventListener('change', edited) }
    confirm.addEventListener('input', controls)
    apply.addEventListener('click', () => { void runApply() })
    refresh.addEventListener('click', () => { void read() })
    void read()
  })
}

export const ACCT_CONVERT_ADDON_CLIENT_BINDING = `(()=>{const readConvertAddonCandidates=${readConvertAddonCandidates.toString()};const readConvertAddonReview=${readConvertAddonReview.toString()};const readConvertAddonResult=${readConvertAddonResult.toString()};const shared=${shared.toString()};return ${bindConvertAddon.toString()};})()`
