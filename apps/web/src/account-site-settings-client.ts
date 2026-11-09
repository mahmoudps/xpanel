/// <reference lib="dom" />
import { domainCanonicalName, domainObject, domainPhpSettings, domainRoot, domainSafeText, domainStable, domainWriteUncertain, readDomainWorkspace } from './domain-workspace-client.ts'
import type { DomainWorkspaceRow, DomainWorkspaceView } from './domain-workspace-client.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameAccess as canonicalFrameAccess, withFrameRequest } from './read-only-frame.ts'
const frameAccess = canonicalFrameAccess

// Module-local aliases keep the stringified functions free of bundler import rewrites.
const ssObject = domainObject, ssStable = domainStable, ssUncertain = domainWriteUncertain, ssReadWorkspace = readDomainWorkspace
const SS_DOMAIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SS_NAME = /^[A-Za-z0-9_-]{1,32}$/, SS_DIRECTORY = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*)?$/, SS_RUN = /^[A-Za-z0-9_-][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*$/
const SS_TRAFFIC_PRESETS: Record<string, [number, number, number]> = { blog: [300, 25, 512], images: [200, 10, 1024], downloads: [50, 3, 2048] }

export interface SiteDenyDraft { name: string; directory: string; extensions: string[] }
export interface SiteTrafficDraft { siteConnections: number | null; ipConnections: number | null; rateKbPerConnection: number | null }
export interface SiteDraft {
  docRoot: string; runDirectory: string; isolated: boolean; visitorLog: boolean; message: string; expiry: string | null
  quota: number | 'unlimited'; reminderAddress: string; reminderDays: number | null; traffic: SiteTrafficDraft | null; denyRules: SiteDenyDraft[]
}
type SiteRow = DomainWorkspaceRow & { suspended: boolean; expiresAt: string | null; pathQuotaMb: number | 'unlimited'; site?: Record<string, unknown> }

/** Comma or space separated extensions, without dots, lowercase. */
export function siteDenyExtensions(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[\s,]+/).map(item => item.replace(/^\./, '')).filter(Boolean))]
}
/** The saved state of the row, or the same with the draft's values: only changed fields are ever sent. */
export function siteSettingsBody(row: SiteRow, draft: SiteDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (draft.docRoot !== row.docRoot) body.docRoot = draft.docRoot
  const expires = row.expiresAt === null ? null : row.expiresAt.slice(0, 10)
  if (draft.expiry !== expires) body.expiresAt = draft.expiry === null ? null : draft.expiry + 'T00:00:00.000Z'
  if (draft.quota !== row.pathQuotaMb) body.pathQuotaMb = draft.quota
  const saved = ssObject(row.site) ? row.site : {}
  const owned = (source: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(source).filter(([key]) => !['stoppedByOwner', 'category'].includes(key)))
  const site = { ...(draft.runDirectory && { runDirectory: draft.runDirectory }), ...(draft.isolated && { isolated: true }), ...(!draft.visitorLog && { visitorLogOff: true }), ...(draft.denyRules.length && { denyRules: draft.denyRules }),
    ...(draft.traffic && { traffic: draft.traffic }), ...(draft.message.trim() && { stoppedMessage: draft.message.trim() }), ...(draft.reminderAddress && draft.reminderDays !== null && { expiryReminder: { address: draft.reminderAddress, days: draft.reminderDays } }) }
  if (ssStable(site) !== ssStable(owned(saved))) body.site = site
  return body
}
/** A rule the server would refuse, named for the field; null when the draft can be sent. */
export function siteDraftProblem(draft: SiteDraft): 'run' | 'quota' | 'traffic' | 'reminder' | 'message' | null {
  if (draft.runDirectory && !SS_RUN.test(draft.runDirectory)) return 'run'
  if (draft.quota !== 'unlimited' && !(Number.isSafeInteger(draft.quota) && draft.quota >= 1)) return 'quota'
  if (draft.traffic && !Object.values(draft.traffic).some(value => value !== null)) return 'traffic'
  if (draft.traffic && Object.values(draft.traffic).some(value => value !== null && !(Number.isSafeInteger(value) && value >= 1))) return 'traffic'
  if (draft.reminderAddress ? draft.reminderDays === null || draft.reminderDays < 1 || draft.reminderDays > 90 : draft.reminderDays !== null) return 'reminder'
  return draft.message.length > 1000 ? 'message' : null
}
export function siteServingState(row: { suspended: boolean; expiresAt: string | null }, now: number): 'running' | 'stopped' | 'expired' {
  if (row.suspended) return 'stopped'
  return row.expiresAt !== null && Date.parse(row.expiresAt) <= now ? 'expired' : 'running'
}

function bindAccountSiteSettings(askDialog: ((options: Record<string, unknown>) => Promise<unknown>) | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  document.querySelectorAll<HTMLElement>('[data-site-settings]').forEach(root => {
    if (root.dataset.siteBound === 'true') return
    root.dataset.siteBound = 'true'
    const access = frameAccess(root, 'data-site-can-read', 'data-site-manage'), send = access.request
    const accountId = root.dataset.siteAccount ?? '', home = root.dataset.siteHome ?? '', id = root.dataset.siteDomain ?? ''
    const find = <T extends HTMLElement>(key: string): T => root.querySelector<T>('[data-site-' + key + ']')!
    const status = find('status'), state = find('state'), quotaState = find('quota-state'), stop = find<HTMLButtonElement>('stop'), start = find<HTMLButtonElement>('start'), save = find<HTMLButtonElement>('save'), reset = find<HTMLButtonElement>('reset')
    const docRoot = find<HTMLInputElement>('docroot'), run = find<HTMLInputElement>('run-directory'), isolated = find<HTMLInputElement>('isolated'), visitorLog = find<HTMLInputElement>('visitor-log')
    const message = find<HTMLTextAreaElement>('stopped-message'), expiry = find<HTMLInputElement>('expiry'), noExpiry = find<HTMLInputElement>('no-expiry'), quota = find<HTMLInputElement>('quota'), unlimited = find<HTMLInputElement>('quota-unlimited')
    const reminderAddress = find<HTMLInputElement>('reminder-address'), reminderDays = find<HTMLInputElement>('reminder-days')
    const trafficOn = find<HTMLInputElement>('traffic-enabled'), preset = find<HTMLSelectElement>('traffic-preset'), trafficSite = find<HTMLInputElement>('traffic-site'), trafficIp = find<HTMLInputElement>('traffic-ip'), trafficRate = find<HTMLInputElement>('traffic-rate')
    const denyRows = find('deny-rows'), denyName = find<HTMLInputElement>('deny-name'), denyDirectory = find<HTMLInputElement>('deny-directory'), denyExtensions = find<HTMLInputElement>('deny-extensions'), denyAdd = find<HTMLButtonElement>('deny-add')
    const reviewRows = find('review-rows'), ack = find<HTMLInputElement>('review-ack'), chooser = root.querySelector<HTMLSelectElement>('[data-site-selector]')
    let view: DomainWorkspaceView | null = null, rules: SiteDenyDraft[] = [], busy = false, uncertain = false
    const row = (): SiteRow | undefined => view?.domains.find(entry => entry.id === id) as SiteRow | undefined
    // Reads run in a read-only frame too; changes need the manage flag outside one.
    const readable = access.readable, eligible = access.writable
    const note = (kind: string, text: string): void => { status.dataset.state = kind; status.textContent = text; status.setAttribute('role', ['failed', 'stale', 'uncertain'].includes(kind) ? 'alert' : 'status') }
    const number = (input: HTMLInputElement): number | null => input.value.trim() === '' ? null : Number(input.value)
    const draft = (): SiteDraft => ({ docRoot: docRoot.value.trim(), runDirectory: run.value.trim().replace(/^\/+|\/+$/g, ''), isolated: isolated.checked, visitorLog: visitorLog.checked, message: message.value.replace(/\s*\n\s*/g, ' '),
      expiry: noExpiry.checked || !expiry.value ? null : expiry.value, quota: unlimited.checked ? 'unlimited' : Number(quota.value), reminderAddress: reminderAddress.value.trim(), reminderDays: number(reminderDays),
      traffic: trafficOn.checked ? { siteConnections: number(trafficSite), ipConnections: number(trafficIp), rateKbPerConnection: number(trafficRate) } : null, denyRules: rules })
    const lock = (): void => {
      const target = row(), alias = target?.kind === 'alias', blocked = !eligible() || !target || busy || uncertain, edit = blocked || alias
      for (const control of [docRoot, run, message, expiry, noExpiry, quota, unlimited, reminderAddress, reminderDays, trafficOn, denyName, denyDirectory, denyExtensions, denyAdd, visitorLog, isolated, preset, trafficSite, trafficIp, trafficRate] as (HTMLInputElement & HTMLButtonElement)[]) control.disabled = edit
      isolated.disabled = edit || target?.siteType !== 'php'
      run.disabled = edit || !['php', 'static'].includes(target?.siteType ?? '')
      expiry.disabled = edit || noExpiry.checked; quota.disabled = edit || unlimited.checked
      for (const control of [preset, trafficSite, trafficIp, trafficRate]) control.disabled = edit || !trafficOn.checked
      denyRows.querySelectorAll('button').forEach(button => { button.disabled = edit })
      const body = target && !edit ? siteSettingsBody(target, draft()) : {}
      ack.disabled = !Object.keys(body).length; save.disabled = edit || !Object.keys(body).length || !ack.checked; reset.disabled = edit
      stop.disabled = blocked || target?.suspended !== false; start.disabled = blocked || target?.suspended !== true || !target.site?.stoppedByOwner
      root.setAttribute('aria-busy', String(busy))
    }
    const paintRules = (): void => {
      denyRows.textContent = ''
      for (const rule of rules) {
        const tr = document.createElement('tr')
        for (const text of [rule.name, rule.directory, rule.extensions.join(', ')]) { const cell = document.createElement('td'), value = document.createElement('bdi'); value.dir = 'ltr'; value.textContent = text; cell.append(value); tr.append(cell) }
        const cell = document.createElement('td'), remove = document.createElement('button')
        remove.type = 'button'; remove.className = denyAdd.className; remove.textContent = t('Remove'); remove.setAttribute('aria-label', t('Remove rule {name}', { name: rule.name }))
        remove.addEventListener('click', () => { if (remove.disabled) return; rules = rules.filter(item => item !== rule); paintRules(); changed() })
        cell.append(remove); tr.append(cell); denyRows.append(tr)
      }
      if (!rules.length) { const tr = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = t('No deny rules are saved for this site.'); tr.append(cell); denyRows.append(tr) }
    }
    const LABELS: Record<string, string> = { docRoot: t('Document root'), expiresAt: t('Stop the site on'), pathQuotaMb: t('Path quota (MB)'), site: t('Site options') }
    const shown = (value: unknown): string => value === null || value === undefined ? t('Not set') : typeof value === 'object' ? JSON.stringify(value) : String(value)
    function changed(): void {
      const target = row(), body = target ? siteSettingsBody(target, draft()) : {}
      ack.checked = false; reviewRows.textContent = ''
      for (const key of Object.keys(body)) {
        const tr = document.createElement('tr')
        const current = key === 'expiresAt' ? target!.expiresAt : (target as unknown as Record<string, unknown>)[key]
        for (const text of [LABELS[key] ?? key, shown(current), shown(body[key])]) { const cell = document.createElement('td'); cell.textContent = text; tr.append(cell) }
        reviewRows.append(tr)
      }
      if (!Object.keys(body).length) { const tr = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 3; cell.textContent = t('There are no changes to review.'); tr.append(cell); reviewRows.append(tr) }
      lock()
    }
    const fill = (): void => {
      const target = row(), site: Record<string, unknown> = ssObject(target?.site) ? target.site : {}, traffic = site.traffic as SiteTrafficDraft | undefined, reminder = site.expiryReminder as { address: string; days: number } | undefined
      if (!target) return
      docRoot.value = target.docRoot; run.value = typeof site.runDirectory === 'string' ? site.runDirectory : ''; isolated.checked = site.isolated === true; visitorLog.checked = site.visitorLogOff !== true
      message.value = typeof site.stoppedMessage === 'string' ? site.stoppedMessage : ''; expiry.value = target.expiresAt?.slice(0, 10) ?? ''; noExpiry.checked = target.expiresAt === null
      unlimited.checked = target.pathQuotaMb === 'unlimited'; quota.value = target.pathQuotaMb === 'unlimited' ? '' : String(target.pathQuotaMb)
      reminderAddress.value = reminder?.address ?? ''; reminderDays.value = reminder ? String(reminder.days) : ''
      trafficOn.checked = !!traffic; preset.value = 'custom'; trafficSite.value = String(traffic?.siteConnections ?? ''); trafficIp.value = String(traffic?.ipConnections ?? ''); trafficRate.value = String(traffic?.rateKbPerConnection ?? '')
      rules = Array.isArray(site.denyRules) ? site.denyRules as SiteDenyDraft[] : []
      const serving = siteServingState(target, Date.now())
      state.textContent = serving === 'running' ? t('Running') : serving === 'expired' ? t('Expired') : target.site?.stoppedByOwner ? t('Stopped') : t('Stopped by the server administrator')
      paintRules(); changed()
    }
    const request = (method: string, path: string, body?: unknown): Promise<unknown> => !send || !(method === 'GET' ? readable() : eligible()) ? Promise.reject({ details: { stateChanged: false } }) : body === undefined ? send(method, path) : send(method, path, body)
    const QUOTA: Record<string, string> = { filesystem: t('This site is not on an XFS filesystem, so a path quota cannot be enforced here.'), mount_option: t('The filesystem is not mounted with project quota, so a path quota cannot be enforced here.'), unread: t('Path quota support could not be read.') }
    const read = async (): Promise<void> => {
      view = ssReadWorkspace(await request('GET', '/api/domains'), { accountId, home })
      const reply = await request('GET', '/api/domains/' + id + '/site-settings').catch(() => null), observed = ssObject(reply) && ssObject(reply.quota) ? reply.quota : null
      const ready = observed?.state === 'ready'
      quotaState.textContent = ready ? t('Path quotas are enforced on this filesystem.') : QUOTA[String(observed?.reason)] ?? QUOTA.unread!
      unlimited.dataset.siteQuotaReady = String(ready)
      fill()
    }
    async function refresh(): Promise<void> {
      if (!readable() || busy) return
      busy = true; lock(); note('reading', t('Reading saved domain configuration…'))
      try { await read(); note('read', t('Saved domain configuration read.')) }
      catch { note('failed', t('Domains could not be read. Nothing was changed.')) }
      finally { busy = false; lock() }
    }
    const FIELD: Record<string, string> = { run: t('The run directory is a subfolder of the document root, such as public.'), quota: t('Enter a path quota in MB, or choose unlimited.'), traffic: t('Enter at least one limit, each 1 or higher, or turn traffic control off.'),
      reminder: t('An expiry reminder needs an address and 1 to 90 days.'), message: t('The stopped page message can have up to 1000 characters.') }
    const failed = (dispatched: boolean, cause: unknown): void => {
      const value = ssObject(cause) ? cause : {}, details = ssObject(value.details) ? value.details : {}, reason = details.reason
      if (details.rolledBack === true) { note('failed', t('The web server test failed and the site settings were rolled back. The previous configuration remains active.')); return }
      if (reason === 'QUOTA_UNSUPPORTED_FS') { note('failed', t('This filesystem cannot enforce a path quota. Nothing was changed.')); return }
      if (reason === 'stopped_by_administrator') { note('failed', t('The server administrator stopped this site. Ask them to start it.')); return }
      if (reason === 'isolation_engine') { note('failed', t('Site isolation needs the Apache web server. Nothing was changed.')); return }
      if (value.status === 409) { note('stale', t('The domain configuration changed elsewhere. Nothing was saved. Read domains before trying again.')); return }
      if (dispatched && ssUncertain(cause)) { uncertain = true; note('uncertain', t('The outcome requires review: the change may be saved while the server configuration is not applied. No retry was sent. Read domains before continuing.')); return }
      note('failed', t('The request was refused. Nothing was changed.'))
    }
    async function submit(body: Record<string, unknown>): Promise<void> {
      if (!view || busy || uncertain) return
      busy = true; lock(); note('saving', t('Checking the saved configuration, then saving…'))
      let dispatched = false
      try {
        const current = ssReadWorkspace(await request('GET', '/api/domains'), { accountId, home })
        if (current.revision !== view.revision) { note('stale', t('The domain configuration changed elsewhere. Nothing was saved. Read domains before trying again.')); return }
        dispatched = true
        const reply = await request('PUT', '/api/domains/' + id + '/site-settings', { expectedRevision: view.revision, ...body })
        await read()
        const generation = ssObject(reply) && ssObject(reply.reconcile) && ssObject(reply.reconcile.generation) ? reply.reconcile.generation.id : null
        note('saved', typeof generation === 'number' ? t('Saved and applied as generation {generation} after the web server test passed.', { generation }) : t('Saved. The server configuration was not applied by this request.'))
      } catch (error) { failed(dispatched, error) } finally { busy = false; lock() }
    }
    const lifecycle = async (suspended: boolean): Promise<void> => {
      const target = row()
      if (!target) return
      if (!askDialog) { note('failed', t('Confirmation is unavailable. Nothing was sent.')); return }
      const approved = await askDialog({ title: suspended ? t('Stop this site?') : t('Start this site?'), danger: suspended, confirm: suspended ? t('Stop site') : t('Start site'),
        body: target.name + '\n' + (suspended ? t('Every request gets the stopped page until you start the site. Mail, FTP and files keep working.') : t('The site serves its content again.')) }).catch(() => false)
      if (approved) await submit({ suspended })
    }
    if (!readable() || !SS_DOMAIN_ID.test(id) || !home.startsWith('/')) { note('unavailable', t('Site settings are unavailable here. Nothing was read or changed.')); return }
    root.addEventListener('input', event => { if (event.target instanceof Element && !event.target.matches('[data-site-deny-name],[data-site-deny-directory],[data-site-deny-extensions],[data-site-review-ack]')) changed() })
    root.addEventListener('change', event => { if (event.target instanceof Element && event.target.matches('[data-site-no-expiry],[data-site-quota-unlimited],[data-site-traffic-enabled],[data-site-isolated],[data-site-visitor-log]')) changed() })
    ack.addEventListener('change', lock)
    preset.addEventListener('change', () => { const values = SS_TRAFFIC_PRESETS[preset.value]; if (values) { [trafficSite.value, trafficIp.value, trafficRate.value] = values.map(String) as [string, string, string]; changed() } })
    denyAdd.addEventListener('click', () => {
      const rule = { name: denyName.value.trim(), directory: denyDirectory.value.trim() || '/', extensions: siteDenyExtensions(denyExtensions.value) }
      if (!SS_NAME.test(rule.name) || rules.some(item => item.name === rule.name)) { note('fields', t('Give the rule its own name: letters, digits, "-" and "_".')); denyName.focus(); return }
      if (!SS_DIRECTORY.test(rule.directory)) { note('fields', t('The directory is a site path such as /uploads.')); denyDirectory.focus(); return }
      if (!rule.extensions.length || rule.extensions.some(item => !/^[a-z0-9]{1,16}$/.test(item))) { note('fields', t('List the file extensions, such as php, phtml.')); denyExtensions.focus(); return }
      rules = [...rules, rule]; denyName.value = denyDirectory.value = denyExtensions.value = ''; paintRules(); changed()
    })
    stop.addEventListener('click', () => { if (!stop.disabled) void lifecycle(true) })
    start.addEventListener('click', () => { if (!start.disabled) void lifecycle(false) })
    reset.addEventListener('click', () => { if (!reset.disabled) fill() })
    save.addEventListener('click', () => {
      const target = row(), current = draft(), problem = siteDraftProblem(current)
      if (save.disabled || !target) return
      if (problem) { note('fields', FIELD[problem]!); return }
      if (current.quota !== target.pathQuotaMb && current.quota !== 'unlimited' && unlimited.dataset.siteQuotaReady !== 'true') { note('failed', t('This filesystem cannot enforce a path quota. Nothing was changed.')); return }
      void submit(siteSettingsBody(target, current))
    })
    chooser?.addEventListener('change', () => { if (SS_DOMAIN_ID.test(chooser.value)) { const next = new URL(window.location.href); next.searchParams.set('domainId', chooser.value); window.location.assign(next.pathname + next.search) } })
    lock(); void refresh()
  })
}

export const ACCOUNT_SITE_SETTINGS_CLIENT_BINDING = withFrameRequest(`(()=>{const domainObject=${domainObject.toString()};const domainSafeText=${domainSafeText.toString()};const domainCanonicalName=${domainCanonicalName.toString()};const domainRoot=${domainRoot.toString()};const domainStable=${domainStable.toString()};const domainWriteUncertain=${domainWriteUncertain.toString()};const domainPhpSettings=${domainPhpSettings.toString()};const readDomainWorkspace=${readDomainWorkspace.toString()};const ssObject=domainObject;const ssStable=domainStable;const ssUncertain=domainWriteUncertain;const ssReadWorkspace=readDomainWorkspace;const SS_DOMAIN_ID=${SS_DOMAIN_ID.toString()};const SS_NAME=${SS_NAME.toString()};const SS_DIRECTORY=${SS_DIRECTORY.toString()};const SS_RUN=${SS_RUN.toString()};const SS_TRAFFIC_PRESETS=${JSON.stringify(SS_TRAFFIC_PRESETS)};const siteDenyExtensions=${siteDenyExtensions.toString()};const siteSettingsBody=${siteSettingsBody.toString()};const siteDraftProblem=${siteDraftProblem.toString()};const siteServingState=${siteServingState.toString()};return ${bindAccountSiteSettings.toString()}})()`)
