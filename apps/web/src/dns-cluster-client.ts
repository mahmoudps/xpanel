/// <reference lib="dom" />
import { DISPLAY_DATETIME_BINDING, formatDisplayDateTime } from './tokens.ts'
import { secKit, SEC_CLIENT_TEMPLATE_HELPERS } from './sec-security-client.ts'
import './i18n.ts'
const displayDateTime = formatDisplayDateTime
// Local alias: serialized bindings must not reference imported names (test transforms rewrite them).
const kitOf = secKit
type Ask = (options: Record<string, unknown>) => Promise<unknown>
export interface DnsClusterMemberRuntime { state: string; failures: number; failureCode: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null; outageSince: string | null; nextAttemptAt: string | null }
export interface DnsClusterMemberRow { name: string; address: string; port: number; pin: string; role: string; runtime: DnsClusterMemberRuntime | null }
export interface DnsClusterInboundRow { name: string; address: string; hint: string; createdAt: string }
export interface DnsClusterConflictRow { member: string; zone: string; state: string; reason: string | null; serial: number; at: string }
export interface DnsClusterView { state: 'default' | 'saved' | 'invalid'; revision: string; enabled: boolean; failureThreshold: number | null; members: DnsClusterMemberRow[]; inbound: DnsClusterInboundRow[]; conflicts: DnsClusterConflictRow[]; pin: string | null; observation: 'read' | 'unavailable' }

/** Strict reader: any row carrying a token or token hash is refused before it can reach the page. */
export function readDnsClusterView(value: unknown): DnsClusterView {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length <= max
  const bad = (): never => { throw new Error('invalid_dns_cluster_view') }
  if (!object(value) || !['default', 'saved', 'invalid'].includes(String(value.state)) || !text(value.revision, 64) || typeof value.enabled !== 'boolean' || !Array.isArray(value.members) || !Array.isArray(value.inbound) || !Array.isArray(value.conflicts) || 'token' in value && !text(value.token, 64)) return bad()
  const members = value.members.map((item): DnsClusterMemberRow => {
    if (!object(item) || 'token' in item || !text(item.name, 253) || !text(item.address, 45) || typeof item.port !== 'number' || !text(item.pin, 64) || !text(item.role, 16) || item.runtime !== null && !object(item.runtime)) return bad()
    return { name: item.name, address: item.address, port: item.port, pin: item.pin, role: item.role, runtime: item.runtime as unknown as DnsClusterMemberRuntime | null }
  })
  const inbound = value.inbound.map((item): DnsClusterInboundRow => object(item) && !('tokenHash' in item) && text(item.name, 253) && text(item.address, 45) && text(item.hint, 4) && text(item.createdAt, 40) ? { name: item.name, address: item.address, hint: item.hint, createdAt: item.createdAt } : bad())
  const conflicts = value.conflicts.map((item): DnsClusterConflictRow => object(item) && text(item.member, 253) && text(item.zone, 253) && text(item.state, 16) && (item.reason === null || text(item.reason, 32)) && typeof item.serial === 'number' && text(item.at, 40) ? item as unknown as DnsClusterConflictRow : bad())
  return { state: value.state as DnsClusterView['state'], revision: value.revision, enabled: value.enabled, failureThreshold: typeof value.failureThreshold === 'number' ? value.failureThreshold : null, members, inbound, conflicts, pin: typeof value.pin === 'string' ? value.pin : null, observation: value.observation === 'read' ? 'read' : 'unavailable' }
}

function bindDnsCluster(askDialog: Ask | undefined): void {
  document.querySelectorAll<HTMLElement>('[data-dns-cluster-workspace]').forEach(root => {
    if (root.dataset.dnsClusterBound === 'true') return
    root.dataset.dnsClusterBound = 'true'
    const k = kitOf(root, askDialog, displayDateTime), t = k.t
    const refresh = k.q<HTMLButtonElement>('[data-sec-action="cluster-refresh"]')
    if (!k.admitted()) { if (refresh) refresh.disabled = true; k.note('unavailable', t('This page is unavailable here. Nothing was read or changed.')); return }
    if (!k.prepareTemplates()) return
    const editors = k.all<HTMLInputElement | HTMLSelectElement>('[data-sec-input]'), buttons = k.all<HTMLButtonElement>('[data-sec-action]:not([data-sec-action="cluster-refresh"])')
    let view: DnsClusterView | null = null
    k.controls.push(() => {
      const open = k.manageable() && !k.isBusy() && !!view && view.state !== 'invalid'
      for (const control of editors) control.disabled = !open
      for (const button of buttons) button.disabled = !open
      if (refresh) refresh.disabled = k.isBusy()
    })
    const value = (key: string): string => k.input(key)?.value.trim() ?? ''
    const states: Record<string, string> = { never_contacted: t('Not contacted yet'), online: t('Online'), outage: t('Outage'), pin_mismatch: t('Key does not match the pin'), unauthorized: t('Token refused'), refused: t('Refused by the member'), auto_disabled: t('Disabled after repeated failures') }
    const roles: Record<string, string> = { standalone: t('Standalone'), synchronize: t('Synchronize'), 'write-only': t('Write-only') }
    const reasons: Record<string, string> = { owned_locally: t('An account on the member holds this zone'), other_origin: t('The member holds a copy from another server'), modified_here: t('The copy was edited on the member'), same_serial: t('Same serial with different records'), older_serial: t('This server is behind the member'), rejected: t('The member refused the records') }
    const zoneStates: Record<string, string> = { conflict: t('Conflict'), rejected: t('Refused'), dnssec_signed: t('Not copied: the zone is DNSSEC-signed') }
    const memberState = (row: DnsClusterMemberRow): string => {
      const state = row.runtime?.state
      if (!state) return t('Not read')
      const label = states[state] ?? t('Not read')
      return row.runtime!.outageSince ? t('{state} since {time}', { state: label, time: k.when(row.runtime!.outageSince) ?? '' }) : label
    }
    const paint = (next: DnsClusterView): void => {
      view = next
      k.field('cluster-state', next.state === 'invalid' ? t('The saved configuration could not be verified. Editing is locked pending review.') : next.enabled ? t('On') : t('Off'), next.enabled ? 'good' : 'warn')
      k.field('cluster-pin', next.pin ?? t('Not read'))
      const enabled = k.input('cluster-enabled'), threshold = k.input('cluster-threshold')
      if (enabled) enabled.checked = next.enabled
      if (threshold && next.failureThreshold !== null) threshold.value = String(next.failureThreshold)
      k.rows('members', next.members.map(row => [k.technical(row.name), k.technical(row.address + ':' + row.port), roles[row.role] ?? row.role, memberState(row), k.technical(String(row.runtime?.failures ?? 0)), k.when(row.runtime?.lastSuccessAt ?? null) ?? t('Never'),
        k.group(
          k.actionButton(t('Synchronize'), t('Synchronize {name}', { name: row.name }), () => void run({ mode: 'push', zone: null, member: row.name, includeMissing: false, force: false }), !k.manageable() || row.role === 'standalone' || !next.enabled),
          k.actionButton(t('Re-enable'), t('Re-enable {name}', { name: row.name }), () => void reset(row.name), !k.manageable() || row.runtime?.state !== 'auto_disabled'),
          k.actionButton(t('Remove'), t('Remove {name}', { name: row.name }), () => void remove('members', row.name), !k.manageable()))]),
      t('No members are saved. This server works alone.'), 7)
      k.rows('inbound', next.inbound.map(row => [k.technical(row.name), k.technical(row.address), k.technical('…' + row.hint), k.when(row.createdAt) ?? '-', k.group(k.actionButton(t('Revoke'), t('Revoke {name}', { name: row.name }), () => void remove('inbound', row.name), !k.manageable()))]),
        t('No member may call this server.'), 5)
      k.rows('conflicts', next.conflicts.map(row => [k.technical(row.member), k.technical(row.zone), zoneStates[row.state] ?? row.state, row.reason ? reasons[row.reason] ?? row.reason : '-', k.technical(String(row.serial)), k.when(row.at) ?? '-',
        k.group(k.actionButton(t('Overwrite the copy'), t('Overwrite the copy of {zone} on {member}', { zone: row.zone, member: row.member }), () => void overwrite(row), !k.manageable() || !['modified_here', 'same_serial', 'older_serial'].includes(row.reason ?? '')))]),
      t('No zone needs attention.'), 7)
      k.note(next.state === 'invalid' ? 'failed' : 'read', next.state === 'invalid' ? t('The saved configuration could not be verified. Editing is locked pending review.') : next.observation === 'read' ? t('Read from this server.') : t('Saved configuration read. The host observation is unavailable.'))
      k.lock()
    }
    const load = (): Promise<void> => k.guarded(async () => { k.note('reading', t('Reading…')); try { paint(readDnsClusterView(await k.send('GET', '/api/server/dns-cluster'))) } catch (error) { view = null; k.note('failed', k.failure(k.outcome(error))) } })
    const change = (method: string, path: string, body: Record<string, unknown>, done: string): Promise<void> => k.guarded(async () => {
      if (!view) return
      try {
        const next = readDnsClusterView(await k.send(method, path, { ...body, expectedRevision: view.revision }))
        paint(next); k.show('read', done)
      } catch (error) { k.show(k.outcome(error), memberFailure(error) ?? k.failure(k.outcome(error))) }
    })
    const memberFailure = (error: unknown): string | null => {
      const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason
      const texts: Record<string, string> = { pin_mismatch: t('The member presented a different key than this pin. Nothing was saved.'), token_invalid: t('The member refused this token. Nothing was saved.'), member_unreachable: t('The member could not be reached. Nothing was saved.'), tls_failed: t('The TLS connection to the member failed. Nothing was saved.'), cluster_disabled: t('Clustering is turned off on that server. Nothing was saved.'), address_not_allowed: t('The member does not allow calls from this address. Nothing was saved.'), protocol_mismatch: t('The member speaks a different cluster protocol. Nothing was saved.') }
      return typeof reason === 'string' ? texts[reason] ?? null : null
    }
    const remove = async (kind: 'members' | 'inbound', name: string): Promise<void> => {
      if (!await k.confirm({ title: kind === 'members' ? t('Remove {name}?', { name }) : t('Revoke the token of {name}?', { name }), body: kind === 'members' ? t('This server stops sending zones to the member. Copies already on the member stay there.') : t('The member can no longer call this server. Zone copies held here stay.'), danger: true, confirm: kind === 'members' ? t('Remove') : t('Revoke') })) return
      await change('DELETE', `/api/server/dns-cluster/${kind}/` + encodeURIComponent(name), {}, kind === 'members' ? t('Member removed.') : t('Token revoked.'))
    }
    const reset = (name: string): Promise<void> => k.guarded(async () => {
      try { paint(readDnsClusterView(await k.send('POST', '/api/server/dns-cluster/members/' + encodeURIComponent(name) + '/reset', {}))); k.show('read', t('The member is enabled again and retries on the next minute.')) }
      catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })
    const summary = (raw: { members?: { member: string; written: number; removed: number; unchanged: number; conflicts: unknown[]; failure: string | null; skipped: string | null; verified: { serial: number | null; inSync: boolean } | null }[] }): void => {
      const skipped: Record<string, string> = { standalone: t('Skipped: standalone'), auto_disabled: t('Skipped: disabled after repeated failures'), write_only: t('Skipped: write-only members are never read') }
      k.rows('sync', (raw.members ?? []).map(row => [k.technical(row.member), k.technical(String(row.written)), k.technical(String(row.removed)), k.technical(String(row.unchanged)), k.technical(String(row.conflicts.length)),
        row.skipped ? skipped[row.skipped] ?? row.skipped : row.failure ? t('Failed: {code}', { code: row.failure }) : row.verified ? (row.verified.inSync ? t('Served with serial {serial}', { serial: row.verified.serial ?? '-' }) : t('Saved, but the member answers another serial')) : t('Done')]),
      t('No member was contacted.'), 6)
    }
    const run = (request: Record<string, unknown>): Promise<void> => k.guarded(async () => {
      try {
        const raw = await k.send('POST', '/api/server/dns-cluster/sync', request) as Parameters<typeof summary>[0]
        summary(raw); paint(readDnsClusterView(await k.send('GET', '/api/server/dns-cluster')))
        k.show('read', t('Synchronisation finished. Read the result per member.'))
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    })
    const overwrite = async (row: DnsClusterConflictRow): Promise<void> => {
      if (await k.confirm({ title: t('Overwrite the copy of {zone}?', { zone: row.zone }), body: t('The copy on {member} is replaced with this server\'s records, even if it was edited there.', { member: row.member }), danger: true, confirm: t('Overwrite the copy') }))
        await run({ mode: 'push', zone: row.zone, member: row.member, includeMissing: false, force: true })
    }
    k.q('[data-sec-action="cluster-save"]')?.addEventListener('click', () => void change('PUT', '/api/server/dns-cluster', { enabled: k.input('cluster-enabled')?.checked === true, failureThreshold: Number(value('cluster-threshold')) }, t('Saved.')))
    k.q('[data-sec-action="member-add"]')?.addEventListener('click', () => {
      const token = k.input('member-token')
      void change('POST', '/api/server/dns-cluster/members', { name: value('member-name').toLowerCase(), address: value('member-address').toLowerCase(), port: Number(value('member-port')), pin: value('member-pin').toLowerCase(), token: value('member-token'), role: value('member-role') }, t('Member added. Its key and token were proved first.'))
        .finally(() => { if (token) token.value = '' })
    })
    k.q('[data-sec-action="inbound-issue"]')?.addEventListener('click', () => void k.guarded(async () => {
      if (!view) return
      const out = k.q('[data-sec-field="issued-token"]')
      try {
        const reply = await k.send('POST', '/api/server/dns-cluster/inbound', { name: value('inbound-name').toLowerCase(), address: value('inbound-address').toLowerCase(), expectedRevision: view.revision }) as { token?: unknown }
        paint(readDnsClusterView(reply))
        if (out && typeof reply.token === 'string') out.textContent = reply.token
        k.show('read', t('Token issued. Copy it now; it is not shown again.'))
      } catch (error) { k.show(k.outcome(error), k.failure(k.outcome(error))) }
    }))
    k.q('[data-sec-action="sync-run"]')?.addEventListener('click', () => {
      const mode = value('sync-mode'), zone = value('sync-zone').toLowerCase() || null, one = mode.startsWith('one-')
      if (one && !zone) { k.show('invalid', t('Enter the zone to synchronize.')); return }
      void run({ mode: mode.endsWith('-here') ? 'pull' : 'push', zone: one ? zone : null, member: null, includeMissing: k.input('sync-missing')?.checked === true, force: false })
    })
    refresh?.addEventListener('click', () => void load()); void load()
  })
}
export const DNS_CLUSTER_CLIENT_BINDING = `(()=>{${SEC_CLIENT_TEMPLATE_HELPERS}const displayDateTime=${DISPLAY_DATETIME_BINDING};const readDnsClusterView=${readDnsClusterView.toString()};const kitOf=${secKit.toString()};return ${bindDnsCluster.toString()};})()`
