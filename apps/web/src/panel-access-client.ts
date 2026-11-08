/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { SEC_CLIENT_TEMPLATE_HELPERS, secKit as canonicalSecKit } from './sec-security-client.ts'
// Local names: bindPanelAccess is serialized, and the binding below defines these two inside the page.
const displayDateTime = formatDisplayDateTime, secKit = canonicalSecKit
type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Row = Record<string, unknown>
export interface PanelAccessView { state: string; gate: Row | null; updatedAt: string | null; revision: string; temporaryLogins: Row[]; host: Row | null; client: Row; publicOrigin: string | null }

/** Strict reader of GET /api/server/panel-access. */
export function readPanelAccessView(value: unknown): PanelAccessView {
  const object = (item: unknown): item is Row => !!item && typeof item === 'object' && !Array.isArray(item)
  if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || !(value.gate === null || object(value.gate)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision)
    || !Array.isArray(value.temporaryLogins) || value.temporaryLogins.length > 64 || !value.temporaryLogins.every(object) || !(value.host === null || object(value.host)) || !object(value.client)) throw new Error('invalid_panel_access_view')
  return { state: value.state as string, gate: value.gate as Row | null, updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null, revision: value.revision, temporaryLogins: value.temporaryLogins as Row[], host: value.host as Row | null, client: value.client, publicOrigin: typeof value.publicOrigin === 'string' ? value.publicOrigin : null }
}

function bindPanelAccess(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-panel-access]').forEach(root => {
    if (root.dataset.secBound === 'true') return
    root.dataset.secBound = 'true'
    const k = secKit(root, askDialog, displayDateTime), t = k.t, path = '/api/server/panel-access', names = ['xpanel', 'xwhm', 'xmail']
    if (!k.admitted()) { k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    const value = (key: string): string => k.input<HTMLInputElement>(key)?.value.trim() ?? ''
    const checked = (key: string): boolean => k.input<HTMLInputElement>(key)?.checked === true
    const set = (key: string, next: string | boolean): void => { const node = k.input<HTMLInputElement>(key); if (!node) return; if (typeof next === 'boolean') node.checked = next; else node.value = next }
    const listed = (prefix: string): string[] => names.filter(name => checked(`${prefix}-${name}`))
    const action = (key: string): HTMLButtonElement | null => k.q<HTMLButtonElement>(`[data-sec-action="${key}"]`)
    let view: PanelAccessView | null = null, createdUrl = ''
    const paintGate = (gate: Row): void => {
      const entrance = gate.entrance as { path: string; listeners: string[] } | null, basic = gate.basicAuth as { username: string; listeners: string[] } | null, response = gate.response as { kind: string; url: string | null }
      set('pa-entrance-on', !!entrance); set('pa-entrance-path', entrance?.path ?? '')
      set('pa-basic-on', !!basic); set('pa-basic-username', basic?.username ?? ''); set('pa-basic-password', '')
      for (const name of names) { set(`pa-entrance-${name}`, entrance ? entrance.listeners.includes(name) : name === 'xwhm'); set(`pa-basic-${name}`, basic ? basic.listeners.includes(name) : name === 'xwhm') }
      set('pa-response', response.kind); set('pa-response-url', response.url ?? '')
      for (const name of ['xpanel', 'xmail']) set(`pa-stop-${name}`, (gate.stopped as string[]).includes(name))
      k.field('pa-entrance-url', entrance && view?.publicOrigin ? `${view.publicOrigin}/${entrance.path}` : t('Off'))
    }
    const paintHost = (host: Row | null): void => {
      const binding = host?.binding as { ports: Record<string, number>; hosts: Record<string, string | null> } | undefined, origins = host?.origins as Record<string, string | null> | undefined
      for (const name of names) { k.field(`pa-origin-${name}`, origins?.[name] ?? null); set(`pa-port-${name}`, binding ? String(binding.ports[name]) : ''); set(`pa-host-${name}`, binding?.hosts[name] ?? '') }
      const trial = host?.trial as { deadline: string } | null | undefined, life = host?.lifecycle as Row | null | undefined
      k.field('pa-trial', host ? trial ? t('Waiting for you to keep it until {time} UTC; otherwise the previous address returns.', { time: k.when(trial.deadline)! }) : host.applying ? t('A change is running.') : t('No change is waiting.') : t('The host agent is not connected.'))
      k.field('pa-lifecycle', !life ? null : life.status === 'failed' ? t('The last change failed ({reason}). The previous address stayed active.', { reason: String(life.reason ?? '') }) : String(life.status ?? ''))
      const cert = host?.certificate as Row | null | undefined
      k.field('pa-cert-names', cert ? (cert.names as string[]).join(', ') : null); k.field('pa-cert-issuer', cert ? String(cert.issuer).replaceAll('\n', ', ') : null); k.field('pa-cert-until', cert ? k.when(cert.validTo) : null); k.field('pa-cert-fingerprint', cert ? String(cert.fingerprint) : null); k.field('pa-cert-pem', cert ? String(cert.pem) : null)
    }
    const paint = (next: PanelAccessView): void => {
      view = next
      if (next.gate) paintGate(next.gate)
      paintHost(next.host)
      k.field('pa-updated', next.updatedAt ? k.when(next.updatedAt) : t('Not saved yet'))
      const states: Record<string, string> = { unused: t('Not used yet'), used: t('Used'), revoked: t('Revoked'), expired: t('Expired') }
      k.rows('pa-temporary', next.temporaryLogins.map(link => [String(link.note || '—'), states[String(link.state)] ?? String(link.state), k.technical(k.when(link.expiresAt) ?? ''), k.technical(link.usedAt ? k.when(link.usedAt)! : '—')]), t('No temporary links.'), 4)
      const picker = k.input<HTMLSelectElement>('pa-temp-pick')
      if (picker) picker.replaceChildren(...next.temporaryLogins.map(link => { const option = document.createElement('option'); option.value = String(link.id); option.textContent = `${String(link.note || link.id)} (${states[String(link.state)] ?? ''})`; return option }))
      k.field('pa-temp-url', createdUrl || t('A new link is shown here once.'))
      if (!value('pa-temp-lifetime')) set('pa-temp-lifetime', '60')
      k.lock()
      k.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved rules could not be verified. Reset them from the server shell.') : t('Read from this server.'))
    }
    const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readPanelAccessView(await k.send('GET', path))) } catch (error) { view = null; k.lock(); k.note('failed', k.failure(k.outcome(error))) } })
    const refused = (error: unknown): string => {
      const reason = (error as { details?: Row } | null)?.details?.reason
      return reason === 'PORT_IN_USE' ? t('That port is in use on this server. Nothing was changed.') : reason === 'INVALID_PORT' ? t('A port must be a whole number from 1 to 65535.')
        : reason === 'ENTRANCE_TOO_SHORT' ? t('The entrance must be at least 8 characters.') : reason === 'ENTRANCE_INVALID' ? t('The entrance needs letters and a digit, and may hold hyphens and underscores.')
        : reason === 'management_tls_not_prepared' ? t('Management TLS is not prepared on this server.') : reason === 'trial_active' ? t('Keep or undo the waiting change first.') : k.failure(k.outcome(error))
    }
    const run = (work: () => Promise<void>): Promise<void> => k.guarded(async () => { try { await work(); paint(readPanelAccessView(await k.send('GET', path))) } catch (error) { k.show(k.outcome(error), refused(error)) } })
    const manageable = (): boolean => !!view && k.manageable() && !k.isBusy()
    const gateBody = (): Row => ({
      expectedRevision: view!.revision,
      entrance: checked('pa-entrance-on') ? { path: value('pa-entrance-path'), listeners: listed('pa-entrance') } : null,
      response: { kind: value('pa-response'), url: value('pa-response') === 'redirect' ? value('pa-response-url') : null },
      basicAuth: checked('pa-basic-on') ? { username: value('pa-basic-username'), password: k.input<HTMLInputElement>('pa-basic-password')?.value ?? '', listeners: listed('pa-basic') } : null,
      stopped: ['xpanel', 'xmail'].filter(name => checked(`pa-stop-${name}`)),
    })
    action('pa-refresh')?.addEventListener('click', () => void load())
    action('pa-entrance-generate')?.addEventListener('click', () => void run(async () => { set('pa-entrance-path', String((await k.send('POST', `${path}/entrance`, {}) as Row).path)) }))
    action('pa-gate-save')?.addEventListener('click', () => void run(async () => {
      const body = gateBody(), entrance = body.entrance as { path: string } | null
      if (!await k.confirm({ title: t('Save these access rules?'), body: entrance ? t('After saving, sign-in opens only at {url}. Keep this address safe.', { url: `${view!.publicOrigin ?? ''}/${entrance.path}` }) : t('The rules apply to the next request.'), confirm: t('Save') })) return
      await k.send('PUT', `${path}/gate`, body)
      k.show('read', t('Saved. The rules apply to the next request.'))
    }))
    action('pa-binding-save')?.addEventListener('click', () => void run(async () => {
      const ports: Record<string, number> = {}, hosts: Record<string, string | null> = {}
      for (const name of names) { ports[name] = Number(value(`pa-port-${name}`)); hosts[name] = value(`pa-host-${name}`) || null }
      if (!await k.confirm({ title: t('Move the panel to this address?'), body: t('The panel restarts. Open the new address within 10 minutes and keep it, or the previous address returns by itself. Open the new ports at your cloud provider first.'), confirm: t('Move the panel') })) return
      const done = await k.send('PUT', `${path}/binding`, { ports, hosts }) as { origins?: Record<string, string> }
      k.show('read', t('The panel is moving. Open {url} and keep the address.', { url: `${done.origins?.xwhm ?? ''}/whm/security/panel-access` }))
    }))
    action('pa-confirm')?.addEventListener('click', () => void run(async () => { await k.send('POST', `${path}/binding/confirm`, {}); k.show('read', t('This address is kept. The old port closes.')) }))
    action('pa-revert')?.addEventListener('click', () => void run(async () => { await k.send('POST', `${path}/binding/revert`, {}); k.show('read', t('The previous address is coming back. The panel restarts.')) }))
    for (const service of ['reload', 'restart']) action(`pa-${service}`)?.addEventListener('click', () => void run(async () => { await k.send('POST', `${path}/service`, { action: service }); k.show('read', service === 'reload' ? t('The web server reloaded.') : t('The panel restarts in a moment.')) }))
    action('pa-temp-create')?.addEventListener('click', () => void run(async () => {
      const done = await k.send('POST', `${path}/temporary-logins`, { lifetimeMinutes: Number(value('pa-temp-lifetime')), note: value('pa-temp-note') }) as { url: string }
      createdUrl = done.url
      k.show('read', t('Link created. Copy it now: it is shown only once.'))
    }))
    action('pa-temp-revoke')?.addEventListener('click', () => void run(async () => { await k.send('DELETE', `${path}/temporary-logins/${value('pa-temp-pick')}`); k.show('read', t('The link is revoked. Its session ends on the next request.')) }))
    action('pa-temp-activity')?.addEventListener('click', () => void run(async () => {
      const rows = (await k.send('GET', `${path}/temporary-logins/${value('pa-temp-pick')}/activity`) as { rows: Row[] }).rows
      k.rows('pa-activity', rows.map(row => [k.technical(k.when(row.at) ?? ''), k.technical(String(row.target)), String(row.outcome)]), t('No activity.'), 3)
    }))
    k.controls.push(() => {
      for (const node of k.all<HTMLButtonElement>('[data-sec-action]')) node.disabled = node.dataset.secAction === 'pa-refresh' ? k.isBusy() : !manageable()
      for (const node of k.all<HTMLInputElement>('[data-sec-input]')) node.disabled = !manageable()
    })
    void load()
  })
}
export const PANEL_ACCESS_CLIENT_BINDING = `(()=>{${SEC_CLIENT_TEMPLATE_HELPERS}const displayDateTime=${DISPLAY_DATETIME_BINDING};const readPanelAccessView=${readPanelAccessView.toString()};const secKit=${secKit.toString()};return ${bindPanelAccess.toString()};})()`
