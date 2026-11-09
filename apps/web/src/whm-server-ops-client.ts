/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'
import { frameRequest as canonicalFrameRequest } from './read-only-frame.ts'
const frameRequest = canonicalFrameRequest

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
type Reply = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** The server operation cards of both themes. Every success shown here comes from the API reply; a refusal keeps the form as typed. */
function bindWhmServerOps(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const refusals = (): Record<string, string> => ({
    INVALID_HOSTNAME: t('The hostname must be a lowercase fully qualified name of at most 60 characters, must not start with www or a digit, and must not be an account domain or a service subdomain. Nothing was changed.'),
    NO_FREE_IP: t('No free address is left in the IP pool. Add one on the IP page first; nothing was changed.'),
    NO_CHANGES: t('This is the current configuration. Nothing was changed.'),
    role_in_use: t('Hosted accounts use a role this change stops. Move or remove them first; nothing was changed.'),
    resolver_count: t('A primary and a secondary resolver are required. Nothing was saved.'),
    resolver_invalid: t('Each resolver must be an IPv4 or IPv6 address. Nothing was saved.'),
    resolver_duplicate: t('Each resolver may be listed once. Nothing was saved.'),
    forward_url_invalid: t('The target must be an http or https URL without quotes or spaces. Nothing was saved.'),
    forward_domain_hosted: t('This domain is hosted on an account of this server. Nothing was saved.'),
    forward_exists: t('This domain already has a forward. Nothing was saved.'),
    forward_target_invalid: t('Each forward must be an email address or a hosting username. Nothing was saved.'),
    forward_target_unknown: t('A local forward must name a hosting account or root. Nothing was saved.'),
    tls_protocols_invalid: t('Choose at least one protocol. Nothing was saved.'),
    tls_ciphers_invalid: t('The cipher list holds characters OpenSSL does not use. Nothing was saved.'),
    config_test_refused: t('The configuration test refused this change. The previous setting stays saved and running.'),
    schedule_invalid: t('A schedule is five cron fields: minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6. Nothing was saved.'),
    backup_schedule_not_saved: t('Save a backup configuration first; its schedule can then be edited here. Nothing was saved.'),
    update_tier_unknown: t('This release tier is not available. Nothing was saved.'),
    dns_role_disabled: t('The DNS server is disabled on this server. Nothing was changed.'),
    host_agent_unavailable: t('No host agent is connected, so this cannot run. Nothing was changed.'),
    hostname_address_required: t('No main address is saved. Enter an address; nothing was changed.'),
  })
  const object = (value: unknown): Reply => value && typeof value === 'object' && !Array.isArray(value) ? value as Reply : {}
  const uncertain = (): string => t('The outcome is uncertain. Reload the page and review the current state before retrying; no automatic retry was sent.')
  const refusal = (error: unknown): string => {
    const value = object(error), details = object(value.details)
    if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return uncertain()
    const known = refusals()[typeof details.reason === 'string' ? details.reason : '']
    return known ?? (details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 ? t('The server refused the request. Nothing was changed; check the values and try again.') : uncertain())
  }
  const confirm = async (title: string, body: string, label: string, danger = false): Promise<boolean> => typeof askDialog === 'function' && await askDialog({ title, body, confirm: label, danger }) === true
  const optionalRoles = ['postgresql', 'mysql', 'mail', 'dns']
  const jobs: Record<string, string> = { queued: t('Queued'), running: t('Running'), succeeded: t('Finished'), failed: t('Failed'), cancelled: t('Cancelled') }

  document.querySelectorAll<HTMLElement>('[data-server-ops]').forEach(root => {
    const request = frameRequest(root)
    if (root.dataset.serverOpsBound === 'true') return
    root.dataset.serverOpsBound = 'true'
    const key = root.dataset.serverOps ?? '', api = root.dataset.serverOpsApi ?? ''
    const status = root.querySelector<HTMLElement>('[data-server-ops-status]'), submit = root.querySelector<HTMLButtonElement>('[data-server-ops-submit]')
    const rows = root.querySelector<HTMLTableSectionElement>('[data-server-ops-rows]'), jobLink = root.querySelector<HTMLAnchorElement>('[data-server-ops-job]')
    const controls = (): (HTMLInputElement | HTMLSelectElement)[] => Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'))
    const named = (name: string): HTMLInputElement | HTMLSelectElement | undefined => controls().find(control => control.name === name)
    const value = (name: string): string => named(name)?.value.trim() ?? ''
    const set = (name: string, next: unknown): void => { const control = named(name); if (control) control.value = typeof next === 'string' ? next : '' }
    const check = (name: string, next: boolean): void => { const control = named(name); if (control instanceof HTMLInputElement) control.checked = next }
    const checked = (name: string): boolean => { const control = named(name); return control instanceof HTMLInputElement && control.checked }
    const note = (state: string, message: string): void => { if (!status) return; status.dataset.state = state; status.setAttribute('role', state === 'failed' ? 'alert' : 'status'); status.textContent = message }
    // Reads run inside read-only frames too, so closed fields show saved values; writes stay outside them and frameRequest refuses them there.
    const admitted = (): boolean => root.isConnected && typeof request === 'function' && root.dataset.serverOpsCanRead === 'true'
    const manageable = (): boolean => admitted() && root.dataset.serverOpsCanManage === 'true' && !root.closest('[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-state="unavailable"],[aria-disabled="true"],fieldset:disabled')
    let revision: string | null = null, busy = false, state: Reply = {}
    const sync = (): void => { for (const control of controls()) control.disabled = busy || !manageable(); if (submit) submit.disabled = busy || !manageable() }
    const row = (cells: readonly string[], action?: HTMLElement): HTMLTableRowElement => {
      const tr = document.createElement('tr')
      for (const cell of cells) { const td = document.createElement('td'); const bdi = document.createElement('bdi'); bdi.textContent = cell; td.append(bdi); tr.append(td) }
      if (action) { const td = document.createElement('td'); td.append(action); tr.append(td) }
      return tr
    }
    const showJob = (job: Reply | null | undefined): void => { if (jobLink && typeof job?.id === 'string') { jobLink.href = '/whm/jobs?job=' + encodeURIComponent(job.id); jobLink.hidden = false } }
    const roleRows = (changes: readonly Reply[], effective: readonly string[]): void => {
      if (!rows) return
      rows.replaceChildren(...(changes.length ? changes.map(item => row([String(item.role), item.change === 'enable' ? t('Will start') : t('Will stop')])) : effective.map(role => row([role, t('Running role')]))))
    }
    const removeForward = (domain: string): void => {
      void (async () => {
        if (!await confirm(t('Remove this forward?'), t('{domain} stops answering on its forwarder address.', { domain }), t('Remove'), true)) return
        busy = true; sync(); note('loading', t('Saving…'))
        try { apply(object(await request!('DELETE', api + '/' + encodeURIComponent(domain), { expectedRevision: revision }))); note('saved', t('The forward is removed.')) }
        catch (error) { note('failed', refusal(error)) } finally { busy = false; sync() }
      })()
    }
    const issueForwardCertificate = async (domain: string): Promise<void> => {
      if (!await confirm(t('Issue a certificate?'), t('{domain} must already point at its forwarder address, so the certificate authority can reach it.', { domain }), t('Issue certificate'))) return
      busy = true; sync(); note('loading', t('Saving…'))
      try { await request!('POST', api + '/' + encodeURIComponent(domain) + '/certificate', {}); note('saved', t('The certificate is issued and {domain} now answers on HTTPS.', { domain })) }
      catch (error) { note('failed', refusal(error)) } finally { busy = false; sync() }
    }
    const forwardRows = (list: readonly Reply[]): void => {
      if (!rows) return
      rows.replaceChildren(...list.map(item => {
        const remove = document.createElement('button')
        remove.type = 'button'; remove.className = root.closest('.v2-server-ops') ? 'v2-btn v2-btn--danger' : 'xp-btn xp-btn--danger'; remove.textContent = t('Remove'); remove.disabled = !manageable()
        remove.addEventListener('click', () => removeForward(String(item.domain)))
        const secure = document.createElement('button')
        secure.type = 'button'; secure.className = root.closest('.v2-server-ops') ? 'v2-btn' : 'xp-btn'; secure.textContent = t('Issue certificate'); secure.disabled = !manageable()
        secure.addEventListener('click', () => { void issueForwardCertificate(String(item.domain)) })
        const cell = document.createElement('span'); cell.append(secure, remove)
        return row([String(item.domain), String(item.url), String(item.ip)], cell)
      }))
      if (!list.length) { const empty = row([t('No domain forwards are saved.')]); rows.replaceChildren(empty) }
    }
    const fills: Record<string, (reply: Reply) => void> = {
      hostname: reply => set('hostname', object(reply.settings).hostname),
      resolvers: reply => { const list = Array.isArray(reply.resolvers) ? reply.resolvers : []; set('primary', list[0]); set('secondary', list[1]); set('tertiary', list[2]) },
      'domain-forwards': reply => forwardRows(Array.isArray(reply.forwards) ? reply.forwards : []),
      'dns-server': reply => set('dnsServer', object(reply.state).dnsServer),
      'ftp-server': reply => set('ftpServer', object(reply.state).ftpServer),
      'panel-tls': reply => { const policy = object(reply.policy), list: unknown[] = Array.isArray(policy.protocols) ? policy.protocols : []; check('protocols', list.includes('TLSv1.2')); check('protocols13', list.includes('TLSv1.3')); set('ciphers', policy.ciphers) },
      'system-mail': reply => { const forwards = object(reply.forwards); set('root', forwards.root); set('nobody', forwards.nobody); set('xpanel', forwards.xpanel) },
      'role-profile': reply => { const saved = object(reply.state); set('profile', saved.profile); for (const role of optionalRoles) check('role-' + role, Array.isArray(saved.optional) && saved.optional.includes(role)); roleRows([], Array.isArray(reply.effective) ? reply.effective : []) },
      maintenance: reply => { set('updater', reply.updater); set('backup', reply.backup) },
      updates: reply => { set('tier', reply.tier); set('updates', reply.updates); check('securityPatches', reply.securityPatches === true); set('majorDelayDays', String(reply.majorDelayDays ?? 0)) },
    }
    const apply = (reply: Reply): void => { if (typeof reply.revision === 'string') revision = reply.revision; state = reply; fills[key]?.(reply) }
    const describe = (reply: Reply): string => {
      if (key === 'dns-cleanup') return t('{stanzas} catalog entries read: {duplicates} duplicates, {orphans} unsaved entries and {files} orphan zone files.', { stanzas: Number(reply.stanzas ?? 0), duplicates: Array.isArray(reply.duplicates) ? reply.duplicates.length : 0, orphans: Array.isArray(reply.orphanStanzas) ? reply.orphanStanzas.length : 0, files: Array.isArray(reply.orphanFiles) ? reply.orphanFiles.length : 0 })
      if (key === 'mail-auth') { const job = object(reply.job); return job.status ? t('Latest job {reference}: {status}.', { reference: String(job.reference ?? '-'), status: jobs[String(job.status)] ?? String(job.status) }) : t('No job has run on this server.') }
      if (key === 'updates' && object(reply.ledger).outcome) return t('Last updater run: {outcome}.', { outcome: String(object(reply.ledger).outcome) })
      if (key === 'maintenance' && (object(reply.moreThanDaily).updater || object(reply.moreThanDaily).backup)) return t('A job here runs more than once a day.')
      return t('Saved values are shown.')
    }
    const read = async (): Promise<void> => {
      if (!admitted()) { note('unavailable', t('This tool requires root authorization and a connected session. Nothing was read or changed.')); return }
      if (key === 'hostname-record') { busy = false; note('ready', t('Ready.')); sync(); return }
      busy = true; sync(); note('loading', t('Reading…'))
      try { const reply = object(await request!('GET', key === 'hostname' ? '/api/server/settings' : api)); apply(reply); note('read', describe(reply)) }
      catch (error) { note('failed', refusal(error)) } finally { busy = false; sync() }
    }
    const applied = (ok: unknown): string => ok === true ? t('Applied on this server.') : ok === null ? t('Saved. No host agent is connected, so it is not applied yet.') : t('Saved, but the host did not confirm it. Review the host before retrying.')
    const reconciled = (reply: Reply): string => {
      const outcome = object(reply.reconcile).status
      return outcome === 'applied' || outcome === 'noop' ? t('Applied on this server.') : reply.reconcile === null ? t('Saved. No host agent is connected, so it is not applied yet.') : t('Saved, but the apply was not confirmed; review the latest generation.')
    }
    const started = (reply: Reply): string => { showJob(reply.job as Reply | null); return reply.job ? t('The change runs as a background job.') : t('Saved. No service had to change on this server.') }
    const actions: Record<string, () => Promise<[string, string] | null>> = {
      hostname: async () => {
        const hostname = value('hostname')
        if (!await confirm(t('Change the hostname?'), t('This server becomes {hostname}. Services that embed the name reload.', { hostname }), t('Change hostname'))) return null
        const reply = object(await request!('POST', api, { hostname })), done = object(reply.application).nativeApplied === true
        return [done ? 'saved' : 'uncertain', done ? t('The hostname is {hostname}. Add an A record for it next.', { hostname: String(reply.hostname) }) : t('Saved. The host did not confirm the new name yet.')]
      },
      resolvers: async () => {
        const resolvers = [value('primary'), value('secondary'), value('tertiary')].filter(Boolean)
        if (!await confirm(t('Save the resolvers?'), t('This server resolves names through {list}.', { list: resolvers.join(', ') }), t('Save'))) return null
        const reply = object(await request!('PUT', api, { resolvers, expectedRevision: revision })); apply(reply)
        return [reply.applied === true ? 'saved' : 'uncertain', applied(reply.applied)]
      },
      'hostname-record': async () => {
        const ip = value('ip'), reply = object(await request!('POST', api, ip ? { ip } : {}))
        return [reply.verified === true ? 'saved' : 'uncertain', reply.verified === true ? t('The local nameserver answers {hostname} with {ip}.', { hostname: String(reply.hostname), ip: String(reply.ip) }) : t('The record is saved in {zone}; the local nameserver has not answered with it yet.', { zone: String(reply.zone) })]
      },
      'dns-cleanup': async () => {
        if (!await confirm(t('Run the DNS cleanup?'), t('Unsaved catalog entries and orphan zone files are removed and PowerDNS reloads.'), t('Run cleanup'), true)) return null
        const reply = object(await request!('POST', api, {}))
        apply(object(reply.after))
        return ['saved', t('{count} entries cleaned.', { count: Number(reply.cleaned ?? 0) })]
      },
      'domain-forwards': async () => {
        const domain = value('domain'), url = value('url')
        if (!await confirm(t('Add this forward?'), t('{domain} forwards to {url}.', { domain, url }), t('Add forward'))) return null
        const reply = object(await request!('POST', api, { domain, url, expectedRevision: revision })); apply(reply)
        return ['saved', t('Point the A record of {domain} at {ip}.', { domain, ip: String(object(reply.forward).ip) }) + ' ' + reconciled(reply)]
      },
      'mail-auth': async () => {
        if (!await confirm(t('Start the job?'), t('The main address joins the SPF record of every hosted zone and missing DKIM keys are created.'), t('Start job'))) return null
        const reply = object(await request!('POST', api, {}))
        return ['saved', t('Job {reference} is running on {zones} zones.', { reference: String(object(reply.job).reference ?? '-'), zones: Number(reply.zones ?? 0) })]
      },
      'dns-server': async () => {
        const dnsServer = value('dnsServer')
        if (!await confirm(t('Apply this DNS server choice?'), dnsServer === 'disabled' ? t('PowerDNS stops and no longer answers for the zones on this server.') : t('PowerDNS starts and answers for the saved zones.'), t('Apply'), dnsServer === 'disabled')) return null
        const reply = object(await request!('PUT', api, { dnsServer, ftpServer: object(state.state).ftpServer, expectedRevision: revision })); apply(reply)
        return ['saved', started(reply)]
      },
      'ftp-server': async () => {
        const ftpServer = value('ftpServer')
        if (!await confirm(t('Apply this FTP server choice?'), ftpServer === 'disabled' ? t('Pure-FTPd stops, port 21 closes and FTP accounts leave user menus.') : t('Pure-FTPd starts and port 21 answers.'), t('Apply'), ftpServer === 'disabled')) return null
        const reply = object(await request!('PUT', api, { dnsServer: object(state.state).dnsServer, ftpServer, expectedRevision: revision })); apply(reply)
        return ['saved', started(reply)]
      },
      'panel-tls': async () => {
        const protocols = [...(checked('protocols') ? ['TLSv1.2'] : []), ...(checked('protocols13') ? ['TLSv1.3'] : [])], ciphers = value('ciphers')
        if (!await confirm(t('Save the TLS policy?'), t('Ports 2083, 2087 and 2096 reload with {list}.', { list: protocols.join(', ') || '-' }), t('Save'))) return null
        const reply = object(await request!('PUT', api, { protocols, ciphers, expectedRevision: revision })); apply(reply)
        return ['saved', reconciled(reply)]
      },
      'system-mail': async () => {
        const forward = (name: string): string | null => value(name) || null
        const reply = object(await request!('PUT', api, { forwards: { root: forward('root'), nobody: forward('nobody'), xpanel: forward('xpanel') }, expectedRevision: revision })); apply(reply)
        return ['saved', reconciled(reply)]
      },
      'role-profile': async () => {
        const profile = value('profile'), optional = optionalRoles.filter(role => checked('role-' + role))
        const review = object(await request!('POST', api + '/review', { profile, optional })), changes: Reply[] = Array.isArray(review.changes) ? review.changes : []
        roleRows(changes, [])
        if (!await confirm(t('Activate this profile?'), t('{count, plural, one {{count} role changes} other {{count} roles change}}. Each stopped service stays stopped until a profile starts it again.', { count: changes.length }), t('Activate'), true)) return null
        const reply = object(await request!('PUT', api, { profile, optional, expectedRevision: revision })); apply(reply)
        return ['saved', started(reply)]
      },
      maintenance: async () => {
        const reply = object(await request!('PUT', api, { updater: value('updater'), backup: value('backup') || null, expectedRevision: revision })); apply(reply)
        return ['saved', describe(reply)]
      },
      updates: async () => {
        const reply = object(await request!('PUT', api, { tier: value('tier'), updates: value('updates'), securityPatches: checked('securityPatches'), majorDelayDays: Number(value('majorDelayDays')), ...(checked('sendToCluster') ? { sendToCluster: true } : {}), expectedRevision: revision })); apply(reply)
        if (!Object.hasOwn(reply, 'cluster')) return ['saved', t('Preferences saved.')]
        const sent = object(reply.cluster)
        return ['saved', typeof sent.members === 'number' ? t('Preferences saved and pushed to {count, plural, one {# cluster member} other {# cluster members}}.', { count: sent.members }) : t('Preferences saved. There are no cluster members to send them to.')]
      },
    }
    const run = (): void => {
      if (busy || !manageable()) return
      void (async () => {
        busy = true; sync(); note('loading', t('Saving…'))
        try { const done = await actions[key]?.(); if (done) note(done[0], done[1]); else note('cancelled', t('Nothing was sent.')) }
        catch (error) { note('failed', refusal(error)) } finally { busy = false; sync() }
      })()
    }
    submit?.addEventListener('click', run)
    root.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type === 'text') { event.preventDefault(); run() } })
    void read()
  })
}

export const WHM_SERVER_OPS_CLIENT_BINDING = `(()=>{${frameRequest.toString()};return ${bindWhmServerOps.toString()}})()`
