/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>
export type SecSavedKind = 'waf' | 'flood' | 'panel-access' | 'dns-cluster'
export interface SecSavedView { state: 'default' | 'saved' | 'invalid'; policy: Record<string, unknown> | null; updatedAt: string | null; revision: string; observation: Record<string, unknown> | null; reason: string | null; reconcile: string | null; client: { listener: string | null; address: string | null; admitted: Record<string, boolean> } | null; enforcement: string | null }

/** Strict reader for GET/PUT /api/server/sec/{waf,flood,panel-access,dns-cluster}: the policy must match its grammar's shape exactly. */
export function readSecSavedView(value: unknown, kind: SecSavedKind): SecSavedView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const keys = (item: Record<string, unknown>, expected: string): boolean => Object.keys(item).sort().join() === expected
  const limit = (item: unknown): boolean => item === null || typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
  const strings = (item: unknown, max: number): boolean => Array.isArray(item) && item.length <= max && item.every(entry => typeof entry === 'string' && entry.length <= 256)
  if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !(value.updatedAt === null || typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)))) throw new Error('invalid_sec_view')
  const p = value.policy
  if (value.state === 'invalid' ? p !== null : !object(p)) throw new Error('invalid_sec_view')
  if (object(p)) {
    const valid = kind === 'waf' ? keys(p, 'burst,deniedResponse,denyIps,denyPaths,denyUserAgents,maxBodyMb,modsecurity,requestsPerSecond') && [p.requestsPerSecond, p.burst, p.maxBodyMb].every(limit) && (p.deniedResponse === 403 || p.deniedResponse === 444) && typeof p.modsecurity === 'boolean' && strings(p.denyIps, 1000) && strings(p.denyPaths, 100) && strings(p.denyUserAgents, 100)
      : kind === 'flood' ? keys(p, 'connectionsPerAddress,enabled,newConnectionsBurst,newConnectionsPerSecond,pingPerSecond,webConnectionsPerAddress') && typeof p.enabled === 'boolean' && [p.connectionsPerAddress, p.newConnectionsBurst, p.newConnectionsPerSecond, p.pingPerSecond, p.webConnectionsPerAddress].every(limit)
      : kind === 'panel-access' ? keys(p, 'listeners') && object(p.listeners) && keys(p.listeners, 'xmail,xpanel,xwhm') && Object.values(p.listeners).every(list => Array.isArray(list) && list.length <= 256 && list.every(entry => object(entry) && keys(entry, 'cidr,note') && typeof entry.cidr === 'string' && /^[0-9a-f:./]{2,49}$/.test(entry.cidr) && typeof entry.note === 'string' && entry.note.length <= 64))
      : keys(p, 'peers') && Array.isArray(p.peers) && p.peers.length <= 16 && p.peers.every(peer => object(peer) && keys(peer, 'address,name') && typeof peer.name === 'string' && /^[a-z0-9.-]{1,253}$/.test(peer.name) && typeof peer.address === 'string' && /^[0-9a-f:.]{2,45}$/.test(peer.address))
    if (!valid) throw new Error('invalid_sec_policy')
  }
  const client = value.client
  if (client !== undefined && !(object(client) && (client.listener === null || ['xpanel', 'xwhm', 'xmail'].includes(String(client.listener))) && (client.address === null || typeof client.address === 'string' && client.address.length <= 45) && object(client.admitted))) throw new Error('invalid_sec_view')
  return { state: value.state as SecSavedView['state'], policy: object(p) ? p : null, updatedAt: value.updatedAt as string | null, revision: value.revision, observation: object(value.observation) ? value.observation : null, reason: typeof value.reason === 'string' ? value.reason : null,
    reconcile: typeof value.reconcile === 'string' ? value.reconcile : null, client: object(client) ? client as SecSavedView['client'] : null, enforcement: typeof value.enforcement === 'string' ? value.enforcement : null }
}
export interface SecAccountWafView { server: Record<string, unknown> | null; live: { connector: boolean | null; crsVersion: string | null; active: { lists: boolean | null; modsecurity: boolean | null } } | null; revision: string; domains: { domain: string; modsecurity: boolean }[]; reconcile: string | null }
export function readSecAccountWafView(value: unknown): SecAccountWafView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || !Array.isArray(value.domains) || value.domains.length > 5000 || !(value.server === null || object(value.server)) || !(value.live === null || object(value.live) && object(value.live.active))) throw new Error('invalid_sec_account_waf')
  const domains = value.domains.map(item => { if (!object(item) || typeof item.domain !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(item.domain) || typeof item.modsecurity !== 'boolean') throw new Error('invalid_sec_account_waf'); return { domain: item.domain, modsecurity: item.modsecurity } })
  return { server: value.server as Record<string, unknown> | null, live: value.live as SecAccountWafView['live'], revision: value.revision, domains, reconcile: typeof value.reconcile === 'string' ? value.reconcile : null }
}

/** Shared DOM kit for the sec bindings: safe text-only painting, outcome mapping and single-flight guards. */
export function secKit(root: HTMLElement, askDialog: Ask | undefined, displayDateTime: (value: string) => string) {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const q = <T extends Element = HTMLElement>(selector: string): T | null => root.querySelector<T>(selector)
  const all = <T extends Element = HTMLElement>(selector: string): T[] => [...root.querySelectorAll<T>(selector)]
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const admitted = (): boolean => root.isConnected && root.dataset.secCanRead === 'true' && !root.closest(denied) && typeof request === 'function'
  const manageable = (): boolean => admitted() && root.dataset.secCanManage === 'true'
  const status = q('[data-sec-status]'), banner = q('[data-sec-result]')
  const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.textContent = message; status.setAttribute('role', state === 'failed' ? 'alert' : 'status') }
  const show = (kind: string, message: string): void => { if (!banner) return; banner.hidden = false; banner.dataset.outcome = kind; banner.textContent = message; banner.setAttribute('role', ['unknown', 'denied', 'failed'].includes(kind) ? 'alert' : 'status') }
  const technical = (value: string): HTMLElement => { const bdi = document.createElement('bdi'); bdi.dir = 'ltr'; bdi.textContent = value; return bdi }
  const field = (key: string, value: string | null, tone?: string): void => { const node = q('[data-sec-field="' + key + '"]'); if (!node) return; node.textContent = value ?? t('Not read'); if (tone) node.dataset.tone = tone }
  const when = (value: unknown): string | null => typeof value === 'string' ? displayDateTime(value) : null
  const input = <T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement = HTMLInputElement>(key: string): T | null => q<T>('[data-sec-input="' + key + '"]')
  const yesNo = (value: unknown): string => value === true ? t('Yes') : value === false ? t('No') : t('Not read')
  const rows = (key: string, data: (string | Node)[][], empty: string, columns: number): void => {
    const body = q('[data-sec-rows="' + key + '"]')
    if (!body) return
    body.textContent = ''
    for (const cells of data) { const row = document.createElement('tr'); for (const content of cells) { const td = document.createElement('td'); td.append(content); row.append(td) } body.append(row) }
    if (!data.length) { const row = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns; td.textContent = empty; row.append(td); body.append(row) }
  }
  const actionButton = (label: string, accessible: string, onClick: () => void, disabled: boolean): HTMLButtonElement => { const b = document.createElement('button'); b.type = 'button'; b.className = 'xp-btn'; b.textContent = label; b.setAttribute('aria-label', accessible); b.disabled = disabled; b.addEventListener('click', onClick); return b }
  const group = (...items: Node[]): HTMLElement => { const div = document.createElement('div'); div.className = 'xp-sec__actions'; div.append(...items); return div }
  const outcome = (error: unknown): string => {
    const problem = error && typeof error === 'object' ? error as { status?: number; code?: string; details?: Record<string, unknown> } : {}, details = problem.details && typeof problem.details === 'object' ? problem.details : {}
    if (details.rolledBack === true) return 'rolled_back'
    if (details.unknownOutcome === true || details.verificationRequired === true) return 'unknown'
    if (details.reason === 'self_lockout') return 'lockout'
    if (problem.status === 401 || problem.status === 403) return 'denied'
    if (problem.status === 409 || problem.code === 'CONFLICT') return 'conflict'
    if (problem.status === 422 || problem.code === 'VALIDATION') return 'invalid'
    return details.stateChanged === false ? 'refused' : 'unknown'
  }
  const failure = (kind: string): string => kind === 'denied' ? t('Authorization is no longer valid. Nothing was changed.')
    : kind === 'conflict' ? t('The saved configuration changed before this action. Nothing was changed; reload and review.')
    : kind === 'lockout' ? t('This change would lock out your current address, so nothing was saved.')
    : kind === 'invalid' ? t('The server refused the values. Nothing was changed; check the fields and try again.')
    : kind === 'rolled_back' ? t('The change could not be confirmed and the previous configuration was restored.')
    : kind === 'refused' ? t('The request was refused. Nothing was changed.')
    : t('The outcome is unknown. Reload and review before trying again.')
  const reconcileText = (value: string | null): string => value === 'requested' ? t('Saved. The server was asked to apply it; refresh to read the running configuration.')
    : value === 'not_connected' ? t('Saved. No host agent is connected, so nothing was applied.')
    : value === 'failed' ? t('Saved, but the server reported that applying it failed. The previous generation stays active.')
    : value === 'unknown' ? t('Saved, but the apply outcome is unknown. Refresh before trying again.') : t('Saved.')
  const confirm = async (options: Record<string, unknown>): Promise<boolean> => {
    if (!askDialog) { show('refused', t('Confirmation is unavailable; nothing was changed.')); return false }
    try { return await askDialog(options) === true } catch { return false }
  }
  let busy = false
  const controls: (() => void)[] = []
  const lock = (): void => { root.setAttribute('aria-busy', String(busy)); for (const control of controls) control() }
  const guarded = async (work: () => Promise<void>): Promise<void> => { if (busy || !admitted()) return; busy = true; lock(); try { await work() } finally { busy = false; lock() } }
  const isBusy = (): boolean => busy
  const send = (method: string, path: string, body?: unknown): Promise<unknown> => request!(method, path, body)
  return { t, q, all, admitted, manageable, note, show, technical, field, when, input, yesNo, rows, actionButton, group, outcome, failure, reconcileText, confirm, guarded, controls, lock, isBusy, send }
}

function bindSecSecurity(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-sec-workspace]').forEach(root => {
    const page = root.dataset.secPage ?? ''
    if (root.dataset.secBound === 'true' || !['waf', 'flood', 'panel-access', 'account-waf'].includes(page)) return
    root.dataset.secBound = 'true'
    const k = secKit(root, askDialog, displayDateTime), t = k.t
    const refresh = k.q<HTMLButtonElement>('[data-sec-action="refresh"]'), save = k.q<HTMLButtonElement>('[data-sec-action="save"]')
    if (!k.admitted()) { if (refresh) refresh.disabled = true; k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    const editors = k.all<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-sec-input]')
    let loaded = false
    k.controls.push(() => { if (refresh) refresh.disabled = k.isBusy(); const editable = loaded && !k.isBusy() && k.manageable(); for (const editor of editors) editor.disabled = !editable; if (save) save.disabled = !editable })
    const num = (key: string): number | null => { const raw = k.input(key)?.value.trim() ?? ''; if (raw === '') return null; if (!/^[0-9]{1,6}$/.test(raw)) throw new Error('number'); return Number(raw) }
    const lines = (key: string): string[] => (k.input<HTMLTextAreaElement>(key)?.value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const setValue = (key: string, value: unknown): void => { const node = k.input(key); if (!node) return; if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = value === true; else node.value = value === null || value === undefined ? '' : String(value) }

    if (page === 'account-waf') {
      let view: SecAccountWafView | null = null
      const paint = (next: SecAccountWafView): void => {
        view = next; loaded = true
        const s = next.server, live = next.live
        k.field('modsec', !live ? t('Not read') : live.active.modsecurity ? t('Active') : live.connector ? t('Installed, not active') : t(msgctxt('sec-security-client', 'Not installed')), live?.active.modsecurity ? 'good' : 'neutral')
        k.field('crs-version', live?.crsVersion ?? null)
        k.field('rate', s ? (s.requestsPerSecond === null ? t('Unlimited') : String(s.requestsPerSecond) + ' / ' + String(s.burst)) : null)
        k.field('body', s ? (s.maxBodyMb === null ? t('Unlimited') : String(s.maxBodyMb)) : null)
        k.field('denied', s ? String(s.deniedResponse) : null)
        const lists = s?.lists as Record<string, number> | undefined
        k.field('lists', lists ? t('{addresses} addresses, {paths} paths, {agents} user agents', { addresses: lists.addresses ?? 0, paths: lists.paths ?? 0, agents: lists.userAgents ?? 0 }) : null)
        k.rows('domains', next.domains.map(row => [k.technical(row.domain), row.modsecurity ? t('On') : t('Off'),
          k.group(k.actionButton(row.modsecurity ? t('Turn off') : t('Turn on'), (row.modsecurity ? t('Turn off ModSecurity for {domain}', { domain: row.domain }) : t('Turn on ModSecurity for {domain}', { domain: row.domain })), () => void toggle(row.domain, !row.modsecurity), !k.manageable()))]),
          t('You have no domains.'), 3)
        k.note('read', t('Read from this server.'))
      }
      const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readSecAccountWafView(await k.send('GET', '/api/account/sec/waf'))) } catch (error) { view = null; k.note('failed', k.failure(k.outcome(error))) } })
      const toggle = (domain: string, enabled: boolean): Promise<void> => k.guarded(async () => {
        if (!view) return
        if (!enabled && !await k.confirm({ title: t('Turn off ModSecurity?'), body: domain + '\n' + t('Rule checks stop for this domain. The server deny lists and limits still apply.'), confirm: t('Turn off') })) return
        try {
          const ack = readSecAccountWafView(await k.send('PUT', '/api/account/sec/waf', { domain, modsecurity: enabled, expectedRevision: view.revision }))
          const again = readSecAccountWafView(await k.send('GET', '/api/account/sec/waf'))
          if (again.revision !== ack.revision || again.domains.find(row => row.domain === domain)?.modsecurity !== enabled) throw new Error('readback')
          paint(again); k.show('read', k.reconcileText(ack.reconcile))
        } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
      })
      refresh?.addEventListener('click', () => void load())
      void load()
      return
    }

    const kind = page as 'waf' | 'flood' | 'panel-access', path = '/api/server/sec/' + kind
    let view: SecSavedView | null = null
    // The API reports the apply outcome only on PUT; GET carries just the saved time, so the outcome stays known only for the revision this page saved.
    let applied: { revision: string; reconcile: string | null; at: string | null } | null = null
    const applyFact = (next: SecSavedView): string | null => {
      const time = applied?.revision === next.revision ? k.when(applied.at) : null
      if (time) return applied!.reconcile === 'requested' ? t('{time}: the server was asked to apply it', { time }) : applied!.reconcile === 'not_connected' ? t('{time}: not sent; no host agent is connected', { time })
        : applied!.reconcile === 'failed' ? t('{time}: the server reported that applying failed', { time }) : applied!.reconcile === null ? t('No apply request was sent with the last save.') : t('{time}: the outcome is unknown', { time })
      return next.state === 'default' ? t('No apply request has been made.') : next.updatedAt ? t('{time} (with the last save; the result is not stored)', { time: k.when(next.updatedAt)! }) : null
    }
    const paintPolicy = (p: Record<string, unknown>): void => {
      if (kind === 'waf') {
        setValue('rate', p.requestsPerSecond); setValue('burst', p.burst); setValue('rate-unlimited', p.requestsPerSecond === null); setValue('body', p.maxBodyMb); setValue('body-unlimited', p.maxBodyMb === null)
        setValue('denied', p.deniedResponse); setValue('deny-ips', (p.denyIps as string[]).join('\n')); setValue('deny-paths', (p.denyPaths as string[]).join('\n')); setValue('deny-agents', (p.denyUserAgents as string[]).join('\n')); setValue('modsecurity', p.modsecurity)
      } else if (kind === 'flood') {
        setValue('enabled', p.enabled); setValue('conn', p.connectionsPerAddress); setValue('rate', p.newConnectionsPerSecond); setValue('burst', p.newConnectionsBurst); setValue('ping', p.pingPerSecond); setValue('web-conn', p.webConnectionsPerAddress)
      } else {
        const listeners = p.listeners as Record<string, { cidr: string; note: string }[]>
        for (const name of ['xpanel', 'xwhm', 'xmail']) setValue(name, listeners[name]!.map(entry => entry.note ? entry.cidr + '  # ' + entry.note : entry.cidr).join('\n'))
      }
    }
    const paintHost = (next: SecSavedView): void => {
      const o = next.observation as Record<string, any> | null
      if (kind === 'waf') {
        k.field('lists-active', o ? k.yesNo(o.active?.lists) : t('Not read'))
        const connector = o?.connector?.nginx, active = o?.active?.modsecurity
        k.field('modsec-state', !o ? t('Not read') : active ? t('Active') : connector ? t('Installed, not active') : t(msgctxt('sec-security-client', 'Not installed')), active ? 'good' : connector ? 'warn' : 'neutral')
        k.field('nginx-connector', o ? (connector === true ? t(msgctxt('sec-security-client', 'Installed')) : connector === false ? t(msgctxt('sec-security-client', 'Not installed')) : t('Not read')) : null)
        k.field('apache-module', o ? (o.connector?.apache === true ? t(msgctxt('sec-security-client', 'Installed')) : o.connector?.apache === false ? t(msgctxt('sec-security-client', 'Not installed')) : t('Not read')) : null)
        k.field('rule-engine', o?.engineConf?.ruleEngine ?? null); k.field('crs-version', o?.crs?.version ?? null); k.field('modsec-active', o ? k.yesNo(active) : null); k.field('observed-at', k.when(o?.observedAt))
        const install = k.q('[data-sec-install]'); if (install) install.hidden = !(o && connector === false)
      } else if (kind === 'flood') {
        const state = o?.state
        k.field('kernel-state', !o ? t('Not read') : state === 'read' ? t(msgctxt('sec-security-client', 'Read')) : state === 'not_installed' ? t('nftables is not installed') : state === 'not_applied' ? t('The xPanel firewall table is not loaded') : t('Unavailable'))
        k.field('observed-at', k.when(o?.observedAt))
        const tracked = (o?.tracked ?? []) as { set: string; elements: number }[], sum = (prefix: string): string => String(tracked.filter(item => item.set.startsWith(prefix)).reduce((total, item) => total + item.elements, 0))
        k.rows('kernel', state === 'read' ? [[t('Connections per address'), String(o!.rules.connections), sum('xpanel_flood_conn')], [t('New connections per second per address'), String(o!.rules.rate), sum('xpanel_flood_rate')], [t('Ping requests per second'), String(o!.rules.ping), '-']] : [],
          !o ? t('The running firewall has not been read.') : t('The running firewall could not be read.'), 3)
      } else {
        const c = next.client
        k.field('listener', c?.listener ? ({ xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' } as Record<string, string>)[c.listener]! : t('Not known'))
        k.field('address', c?.address ?? t('Not known'))
        k.field('enforcement', next.enforcement === 'api_listener' ? t('Checked on every request') : t('Not connected; saved lists are not enforced yet'), next.enforcement === 'api_listener' ? 'good' : 'warn')
      }
    }
    const paint = (next: SecSavedView): void => {
      view = next; loaded = next.state !== 'invalid'
      if (next.policy) paintPolicy(next.policy)
      k.field('updated', next.updatedAt ? k.when(next.updatedAt) : t('Never saved'))
      if (kind !== 'panel-access') k.field('reconcile', applyFact(next))
      paintHost(next)
      k.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved configuration could not be verified. Editing is locked pending review.') : next.observation || kind === 'panel-access' ? t('Read from this server.') : t('Saved configuration read. The host observation is unavailable.'))
    }
    const build = (): Record<string, unknown> => {
      if (kind === 'waf') {
        const unlimitedRate = (k.input('rate-unlimited') as HTMLInputElement | null)?.checked === true, unlimitedBody = (k.input('body-unlimited') as HTMLInputElement | null)?.checked === true
        return { requestsPerSecond: unlimitedRate ? null : num('rate'), burst: unlimitedRate ? null : num('burst') ?? 0, maxBodyMb: unlimitedBody ? null : num('body'), deniedResponse: Number(k.input<HTMLSelectElement>('denied')?.value ?? '403'),
          denyIps: lines('deny-ips'), denyPaths: lines('deny-paths'), denyUserAgents: lines('deny-agents'), modsecurity: (k.input('modsecurity') as HTMLInputElement | null)?.checked === true }
      }
      if (kind === 'flood') { const rate = num('rate'); return { enabled: (k.input('enabled') as HTMLInputElement | null)?.checked === true, connectionsPerAddress: num('conn'), newConnectionsPerSecond: rate, newConnectionsBurst: rate === null ? null : num('burst'), pingPerSecond: num('ping'), webConnectionsPerAddress: num('web-conn') } }
      const listeners: Record<string, { cidr: string; note: string }[]> = {}
      for (const name of ['xpanel', 'xwhm', 'xmail']) listeners[name] = lines(name).map(line => { const at = line.indexOf('#'); return at < 0 ? { cidr: line, note: '' } : { cidr: line.slice(0, at).trim(), note: line.slice(at + 1).trim() } })
      return { listeners }
    }
    const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readSecSavedView(await k.send('GET', path), kind)) } catch (error) { view = null; loaded = false; k.note('failed', k.failure(k.outcome(error))) } })
    save?.addEventListener('click', () => void k.guarded(async () => {
      if (!view || view.state === 'invalid' || !k.manageable()) return
      let policy: Record<string, unknown>
      try { policy = build() } catch { k.show('invalid', t('Enter whole numbers in the limit fields, or leave them empty.')); return }
      try {
        const ack = readSecSavedView(await k.send('PUT', path, { policy, expectedRevision: view.revision }), kind)
        const again = readSecSavedView(await k.send('GET', path), kind)
        if (ack.state !== 'saved' || again.revision !== ack.revision || JSON.stringify(again.policy) !== JSON.stringify(ack.policy)) throw new Error('readback')
        applied = { revision: ack.revision, reconcile: ack.reconcile, at: ack.updatedAt }
        paint(again); k.show('read', kind === 'panel-access' ? (again.enforcement === 'api_listener' ? t('Saved and read back. The lists apply to the next request.') : t('Saved and read back. The lists are not enforced until the request gate is connected.')) : k.reconcileText(ack.reconcile))
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    }))
    refresh?.addEventListener('click', () => void load())
    void load()
  })
}
export const SEC_SECURITY_CLIENT_BINDING = `(()=>{const displayDateTime=${DISPLAY_DATETIME_BINDING};const readSecSavedView=${readSecSavedView.toString()};const readSecAccountWafView=${readSecAccountWafView.toString()};const secKit=${secKit.toString()};return ${bindSecSecurity.toString()};})()`
