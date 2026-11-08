/// <reference lib="dom" />
import type { MessageValues } from './i18n.ts'
import './i18n.ts'

type Ask = (options: Record<string, unknown>) => Promise<unknown>
type Transport = (method: string, path: string, body?: unknown) => Promise<unknown>
const ACL_LIST_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** "old new" per line; a malformed line rejects the whole wizard input. */
export function parseIpMigrationPairs(text: string): { from: string; to: string }[] {
  const pairs = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.split(/\s+/))
  if (!pairs.length || pairs.length > 256 || pairs.some(parts => parts.length !== 2 || parts.some(part => !/^[0-9A-Fa-f:.]{2,45}$/.test(part)))) throw new Error('invalid_ip_pairs')
  return pairs.map(([from, to]) => ({ from: from!, to: to! }))
}

/** Root IP tools and reseller tools. Each request is confirmed by its API reply before any success is shown. */
function bindWhmNetwork(askDialog: Ask | undefined): void {
  const t = (message: string, values?: MessageValues): string => xpT(message, values)
  const request = (window as Window & { xpanelSessionRequest?: Transport }).xpanelSessionRequest
  const denied = '[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled'
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const note = (node: HTMLElement | null, state: string, message: string): void => {
    if (!node) return
    node.hidden = false; node.dataset.state = state; node.setAttribute('role', state === 'failed' || state === 'uncertain' ? 'alert' : 'status'); node.textContent = message
  }
  // Each stable refusal code has its own truthful text; anything else is a generic refusal or an uncertain outcome.
  const refusal = (error: unknown): string => {
    const value = object(error), details = object(value.details)
    if ([value, details].some(part => part.unknownOutcome === true || part.verificationRequired === true)) return ''
    const reason = typeof details.reason === 'string' ? details.reason : ''
    const known: Record<string, string> = {
      ip_reserved: t('The address is reserved and is never offered for assignment. Nothing was changed.'),
      remote_service_ip_invalid: t('Each line must be one IPv4 or IPv6 address or a network of /8 (IPv6 /16) or longer. Nothing was saved.'),
      remote_service_ips_too_many: t('Each list holds at most 64 addresses or networks. Nothing was saved.'),
      nat_mapping_unknown: t('The public NAT address of this private address is unknown. Set it on the IP page first; nothing was changed.'),
      nat_not_private: t('Only a private local address has a NAT public address. Nothing was changed.'),
      ip_releasing: t('The address is held until the agent verifies that its previous site has left it. Nothing was changed.'),
      ip_unavailable: t('The new address is reserved or held. Nothing was changed.'),
      ip_in_use: t('The new address is already in use. Nothing was changed.'),
      host_unavailable: t('No host agent is connected, so the host interfaces could not be read. Nothing was changed.'),
      interfaces_unavailable: t('The host interfaces could not be read. The pool was not changed.'),
      ip_interface_unknown: t('No default address names the interface for the IPv6 range. Nothing was changed.'),
      ipv6_range_full: t('The IPv6 range has no free address. Nothing was changed.'),
      reseller_contact_unavailable: t('No reseller has a contact email address. Nothing was sent.'),
      dedicated_ip_change_required: t("Move the account to a shared address with Change a Site's IP Address first. Nothing was changed."),
    }
    if (known[reason]) return known[reason]!
    return details.stateChanged === false || typeof value.status === 'number' && value.status >= 400 && value.status < 500 && value.status !== 408
      ? t('The server refused the request. Nothing was changed; check the values and try again.') : ''
  }
  const uncertain = t('The outcome is uncertain. Reload the page and review the current state before retrying; no automatic retry was sent.')
  const confirm = async (title: string, body: string, label: string, danger = false): Promise<boolean> => typeof askDialog === 'function' && await askDialog({ title, body, confirm: label, danger }) === true
  const field = (form: HTMLFormElement, name: string): string => { const item = form.elements.namedItem(name); return item instanceof HTMLInputElement || item instanceof HTMLSelectElement || item instanceof HTMLTextAreaElement ? item.value.trim() : '' }
  const checked = (form: HTMLFormElement, name: string): string[] => Array.from(form.elements).filter((item): item is HTMLInputElement => item instanceof HTMLInputElement && item.name === name && item.checked).map(item => item.value)

  const bindRoot = (root: HTMLElement, status: HTMLElement | null): ((work: () => Promise<void>, node?: HTMLElement | null) => Promise<void>) | null => {
    if (root.dataset.networkBound === 'true') return null
    root.dataset.networkBound = 'true'
    const editable = (): boolean => root.isConnected && root.dataset.networkEditable === 'true' && !root.closest(denied) && typeof request === 'function'
    let busy = false
    root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(control => { if (!editable()) control.disabled = true })
    if (!editable()) { note(status, 'unavailable', t('These tools require root authorization and a connected session. Nothing was changed.')); return null }
    return async (work, node = status) => {
      if (busy) return
      busy = true; root.setAttribute('aria-busy', 'true')
      try { await work() } catch (error) { const text = refusal(error); note(node, text ? 'failed' : 'uncertain', text || uncertain) }
      finally { busy = false; root.setAttribute('aria-busy', 'false') }
    }
  }

  document.querySelectorAll<HTMLElement>('[data-whm-ip-tools]').forEach(root => {
    const status = root.querySelector<HTMLElement>('[data-ip-tools-status]')
    const run = bindRoot(root, status)
    if (!run) return
    const send = request!
    root.querySelector<HTMLFormElement>('[data-ip-change-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement, node = form.querySelector<HTMLElement>('[data-ip-change-status]')
      void run(async () => {
        const accountId = field(form, 'accountId'), ipv4 = field(form, 'ipv4'), ipv6 = field(form, 'ipv6')
        const body: Record<string, unknown> = { ...(ipv4 && { ipv4 }), ...(ipv6 === '-' ? { ipv6: null } : ipv6 ? { ipv6 } : {}) }
        if (!accountId || !Object.keys(body).length) { note(node, 'failed', t('Choose an account and a new address. Nothing was sent.')); return }
        const label = form.querySelector<HTMLSelectElement>('select[name="accountId"]')?.selectedOptions[0]?.textContent ?? accountId
        if (!await confirm(t("Change the site's IP address?"), label + ' → ' + [ipv4, ipv6 === '-' ? t('no IPv6') : ipv6].filter(Boolean).join(', '), t('Change address'))) { note(node, 'cancelled', t('Nothing was sent.')); return }
        note(node, 'loading', t('Changing the address…'))
        const reply = object(await send('POST', '/api/accounts/' + encodeURIComponent(accountId) + '/ip', body)), account = object(reply.account)
        if ((ipv4 && account.ipv4 !== ipv4) || !Array.isArray(reply.held)) throw new Error('unverified')
        note(node, 'saved', t('The site now uses {address} in saved state and its DNS records moved with it. {count, plural, =0 {No address is held.} one {The old dedicated address stays held until the agent verifies the new binding.} other {The old dedicated addresses stay held until the agent verifies the new binding.}} Reload to read the updated pool.', { address: String(account.ipv4), count: reply.held.length }))
      }, node)
    })
    root.querySelector<HTMLFormElement>('[data-ip-change-many-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement, node = form.querySelector<HTMLElement>('[data-ip-change-many-status]')
      void run(async () => {
        const all = field(form, 'ipv4All')
        const changes = checked(form, 'accountId').map(accountId => ({ accountId, ipv4: field(form, 'ipv4:' + accountId) || all }))
        if (!changes.length || changes.some(change => !change.ipv4)) { note(node, 'failed', t('Choose at least one account and a new IPv4 address for each. Nothing was sent.')); return }
        const names = new Map(Array.from(form.querySelectorAll<HTMLInputElement>('input[name="accountId"]')).map(input => [input.value, input.dataset.ipAccountName ?? input.value]))
        if (!await confirm(t("Change these sites' IP addresses?"), changes.map(change => names.get(change.accountId) + ' → ' + change.ipv4).join('\n'), t('Change addresses'))) { note(node, 'cancelled', t('Nothing was sent.')); return }
        note(node, 'loading', t('Changing the addresses…'))
        const results = object(await send('POST', '/api/ips/change-many', { changes })).results
        if (!Array.isArray(results) || results.length !== changes.length) throw new Error('unverified')
        note(node, 'saved', results.map(object).map(result => t('{name}: now {address}{held, plural, =0 {} other {; the old dedicated address stays held until the agent verifies the new binding}}.', { name: String(object(result.account).username), address: String(object(result.account).ipv4), held: Array.isArray(result.held) ? result.held.length : 0 })).join('\n'))
      }, node)
    })
    root.querySelector<HTMLFormElement>('[data-remote-ips-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement, node = form.querySelector<HTMLElement>('[data-remote-ips-status]')
      const lines = (name: string): string[] => field(form, name).split('\n').map(line => line.trim()).filter(Boolean)
      void run(async () => {
        const smtp = lines('smtp'), nameservers = lines('nameservers')
        if (!await confirm(t('Save the remote service IPs?'), t('{smtp} remote SMTP servers and {ns} remote nameservers. Mail is reconciled and the PowerDNS transfer list is re-applied.', { smtp: smtp.length, ns: nameservers.length }), t('Save'))) { note(node, 'cancelled', t('Nothing was sent.')); return }
        note(node, 'loading', t('Saving…'))
        const reply = object(await send('PUT', '/api/server/remote-service-ips', { smtp, nameservers })), lists = object(reply.lists), dns = object(reply.dns)
        if (!Array.isArray(lists.smtp) || !Array.isArray(lists.nameservers)) throw new Error('unverified')
        const mail = object(reply.reconcile).status, dnsText = typeof dns.refused === 'string' ? t('The PowerDNS transfer list was not applied ({code}).', { code: dns.refused }) : dns.outcome === 'applied' || dns.outcome === 'unchanged' ? t('The PowerDNS transfer list is applied.') : t('The PowerDNS transfer list was not re-applied: no host agent is connected.')
        note(node, mail === 'applied' || mail === 'noop' ? 'saved' : 'uncertain', t('Saved {smtp} remote SMTP servers and {ns} remote nameservers.', { smtp: lists.smtp.length, ns: lists.nameservers.length }) + ' ' + (mail === 'applied' || mail === 'noop' ? t('The mail configuration is applied.') : t('The mail configuration apply was not confirmed; review the latest generation.')) + ' ' + dnsText)
      }, node)
    })
    root.querySelectorAll<HTMLFormElement>('[data-ip-reserve-form]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault()
      const node = root.querySelector<HTMLElement>('[data-ip-reserve-status]'), id = form.dataset.ipReserveId ?? ''
      void run(async () => {
        const reserved = (form.elements.namedItem('reserved') as HTMLInputElement | null)?.checked === true, ptrHostname = field(form, 'ptrHostname')
        const nat = form.elements.namedItem('publicAddress') !== null, publicAddress = field(form, 'publicAddress')
        note(node, 'loading', t('Saving…'))
        const ip = object(object(await send('PATCH', '/api/ips/' + encodeURIComponent(id), { reserved, ptrHostname: ptrHostname || null, ...(nat && { publicAddress: publicAddress || null }) })).ip)
        if (ip.id !== id || (ip.reserved === true) !== reserved || (ip.ptrHostname ?? '') !== ptrHostname.toLowerCase().replace(/\.$/, '') || nat && (ip.publicAddress ?? '') !== publicAddress.toLowerCase()) throw new Error('unverified')
        note(node, 'saved', t('{address}: the reservation and reverse DNS name were saved. Reverse DNS itself is set at the address provider.', { address: String(ip.address) }))
      }, node)
    }))
    root.querySelector<HTMLButtonElement>('[data-ip-usage-refresh]')?.addEventListener('click', () => {
      const node = root.querySelector<HTMLElement>('[data-ip-usage-status]')
      void run(async () => {
        note(node, 'loading', t('Reading the host report…'))
        const reply = object(await send('GET', '/api/ips/usage')), rows = Array.isArray(reply.ips) ? reply.ips.map(object) : []
        const labels: Record<string, string> = { configured: t('Bound'), 'other-interface': t('Bound on another interface'), missing: t('Not bound'), unverified: t('Not read') }
        root.querySelectorAll<HTMLElement>('[data-ip-binding]').forEach(cell => {
          const row = rows.find(item => item.address === cell.dataset.ipBinding)
          cell.textContent = labels[String(row?.binding)] ?? t('Not read'); cell.dataset.state = String(row?.binding ?? 'unverified')
        })
        note(node, reply.observed === true ? 'saved' : 'unavailable', reply.observed === true ? t('Binding was read from the host interfaces just now.') : t('The host was not read; binding stays unverified.'))
      }, node)
    })
    root.querySelector<HTMLButtonElement>('[data-ip-rebuild]')?.addEventListener('click', () => {
      const node = root.querySelector<HTMLElement>('[data-ip-rebuild-status]')
      void run(async () => {
        if (!await confirm(t('Rebuild the IP address pool?'), t('Addresses the host reports that the pool lacks are added as free dedicated addresses. Nothing is removed.'), t('Rebuild'))) { note(node, 'cancelled', t('Nothing was sent.')); return }
        note(node, 'loading', t('Reading the host interfaces…'))
        const added = object(await send('POST', '/api/ips/rebuild', {})).added
        if (!Array.isArray(added)) throw new Error('unverified')
        note(node, 'saved', t('{count, plural, =0 {The host reports no address that the pool lacks.} one {{count} address was added from the host report. Reload to see it.} other {{count} addresses were added from the host report. Reload to see them.}}', { count: added.length }))
      }, node)
    })
    root.querySelector<HTMLFormElement>('[data-ip-migrate-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement, node = form.querySelector<HTMLElement>('[data-ip-migrate-status]')
      void run(async () => {
        let mappings: { from: string; to: string }[]
        try { mappings = parseIpMigrationPairs(field(form, 'mappings')) } catch { note(node, 'failed', t('Enter one old and one new address per line, separated by a space. Nothing was sent.')); return }
        if (!await confirm(t('Migrate these addresses?'), mappings.map(pair => pair.from + ' → ' + pair.to).join('\n'), t('Migrate'), true)) { note(node, 'cancelled', t('Nothing was sent.')); return }
        note(node, 'loading', t('Migrating…'))
        const reply = object(await send('POST', '/api/ips/migrate', { mappings }))
        if (!Array.isArray(reply.moved) || reply.moved.length !== mappings.length || !Array.isArray(reply.held)) throw new Error('unverified')
        note(node, 'saved', t('{count, plural, one {{count} address moved} other {{count} addresses moved}} with every account, zone, mail and reseller reference. Old dedicated addresses stay held until the agent verifies the new binding.', { count: reply.moved.length }))
      }, node)
    })
    const rangeStatus = root.querySelector<HTMLElement>('[data-ip-range-status]')
    const saveRanges = async (change: (ranges: Record<string, unknown>[]) => Record<string, unknown>[], done: string): Promise<void> => {
      const current = object(await send('GET', '/api/ips/ranges')).ranges
      if (!Array.isArray(current)) throw new Error('unread')
      const next = change(current.map(object))
      const saved = object(await send('PUT', '/api/ips/ranges', { ranges: next })).ranges
      if (!Array.isArray(saved) || saved.length !== next.length) throw new Error('unverified')
      note(rangeStatus, 'saved', done); location.reload()
    }
    root.querySelector<HTMLFormElement>('[data-ip-range-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      void run(async () => {
        const ownerKind = field(form, 'ownerKind') || 'root', ownerId = field(form, 'ownerId'), cidr = field(form, 'cidr')
        if (!/^[0-9A-Fa-f:]{2,39}\/[0-9]{1,3}$/.test(cidr) || (ownerKind !== 'root') !== !!ownerId) { note(rangeStatus, 'failed', t('Enter an IPv6 network such as 2001:db8:1::/64 and choose an owner. Nothing was sent.')); return }
        note(rangeStatus, 'loading', t('Saving…'))
        await saveRanges(ranges => [...ranges, { id: crypto.randomUUID(), cidr, ownerKind, ownerId: ownerKind === 'root' ? null : ownerId, notes: field(form, 'notes') }], t('The IPv6 range was saved.'))
      }, rangeStatus)
    })
    root.querySelectorAll<HTMLButtonElement>('[data-ip-range-remove]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.ipRangeRemove ?? ''
      void run(async () => {
        if (!await confirm(t('Remove this IPv6 range?'), button.dataset.ipRangeCidr ?? '', t('Remove'), true)) { note(rangeStatus, 'cancelled', t('Nothing was sent.')); return }
        note(rangeStatus, 'loading', t('Removing…'))
        await saveRanges(ranges => ranges.filter(range => range.id !== id), t('The IPv6 range was removed. Addresses already assigned from it stay with their accounts.'))
      }, rangeStatus)
    }))
    root.querySelector<HTMLFormElement>('[data-ip-assign6-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      void run(async () => {
        const accountId = field(form, 'accountId'), rangeId = field(form, 'rangeId')
        if (!accountId || !rangeId) { note(rangeStatus, 'failed', t('Choose an account and a range. Nothing was sent.')); return }
        note(rangeStatus, 'loading', t('Assigning…'))
        const reply = object(await send('POST', '/api/accounts/' + encodeURIComponent(accountId) + '/ipv6', { rangeId })), ip = object(reply.ip)
        if (typeof ip.address !== 'string' || object(reply.account).ipv6 !== ip.address) throw new Error('unverified')
        note(rangeStatus, 'saved', t('{address} was assigned with AAAA records beside the A records. The agent binds it at the next generation.', { address: ip.address }))
      }, rangeStatus)
    })
  })

  document.querySelectorAll<HTMLElement>('[data-whm-reseller-lists]').forEach(root => {
    const status = root.querySelector<HTMLElement>('[data-acl-list-status]')
    const run = bindRoot(root, status)
    if (!run) return
    const send = request!
    root.querySelector<HTMLFormElement>('[data-acl-list-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      void run(async () => {
        const name = field(form, 'name'), acl = checked(form, 'acl')
        if (!ACL_LIST_NAME.test(name)) { note(status, 'failed', t('A list name has 1-64 letters, digits, "_" or "-". Nothing was sent.')); return }
        note(status, 'loading', t('Saving…'))
        const list = object(object(await send('PUT', '/api/resellers/acl-lists/' + encodeURIComponent(name), { acl })).list)
        if (list.name !== name || !Array.isArray(list.acl) || list.acl.length !== new Set(acl).size) throw new Error('unverified')
        note(status, 'saved', t('The privilege list {name} was saved.', { name })); location.reload()
      })
    })
    root.querySelectorAll<HTMLButtonElement>('[data-acl-list-delete]').forEach(button => button.addEventListener('click', () => {
      const name = button.dataset.aclListDelete ?? ''
      void run(async () => {
        if (!ACL_LIST_NAME.test(name) || !await confirm(t('Delete this privilege list?'), name, t('Delete'), true)) { note(status, 'cancelled', t('Nothing was sent.')); return }
        if (object(await send('DELETE', '/api/resellers/acl-lists/' + encodeURIComponent(name))).ok !== true) throw new Error('unverified')
        note(status, 'saved', t('The privilege list {name} was deleted. Resellers keep their current privileges.', { name })); location.reload()
      })
    }))
    root.querySelector<HTMLFormElement>('[data-acl-list-apply-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      void run(async () => {
        const name = field(form, 'list'), resellerIds = checked(form, 'resellerId')
        if (!ACL_LIST_NAME.test(name) || !resellerIds.length) { note(status, 'failed', t('Choose a privilege list and at least one reseller. Nothing was sent.')); return }
        if (!await confirm(t('Reset these resellers?'), t('{count, plural, one {{count} reseller takes} other {{count} resellers take}} exactly the privileges of {name}.', { count: resellerIds.length, name }), t('Apply list'), true)) { note(status, 'cancelled', t('Nothing was sent.')); return }
        note(status, 'loading', t('Applying…'))
        const resellers = object(await send('POST', '/api/resellers/acl-lists/' + encodeURIComponent(name) + '/apply', { resellerIds })).resellers
        if (!Array.isArray(resellers) || resellers.length !== resellerIds.length) throw new Error('unverified')
        note(status, 'saved', t('{count, plural, one {{count} reseller now has} other {{count} resellers now have}} the privileges of {name}.', { count: resellers.length, name })); location.reload()
      })
    })
  })

  document.querySelectorAll<HTMLElement>('[data-whm-reseller-email]').forEach(root => {
    const status = root.querySelector<HTMLElement>('[data-reseller-email-status]')
    const run = bindRoot(root, status)
    if (!run) return
    const send = request!
    root.querySelector<HTMLFormElement>('[data-reseller-email-form]')?.addEventListener('submit', event => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      void run(async () => {
        const subject = field(form, 'subject'), body = (form.elements.namedItem('body') as HTMLTextAreaElement | null)?.value ?? ''
        if (!subject || !body.trim()) { note(status, 'failed', t('Enter a subject and a message. Nothing was sent.')); return }
        if (!await confirm(t('Email all resellers?'), subject, t('Send'))) { note(status, 'cancelled', t('Nothing was sent.')); return }
        note(status, 'loading', t('Sending…'))
        const reply = object(await send('POST', '/api/resellers/email', { subject, body }))
        if (!Array.isArray(reply.sent) || !Array.isArray(reply.failed) || !Array.isArray(reply.withoutContact)) throw new Error('unverified')
        note(status, reply.failed.length ? 'failed' : 'saved', t('The local mail server accepted {sent, plural, one {{sent} message} other {{sent} messages}}. {failed, plural, =0 {} other {{failed} could not be delivered to the mail server.}} {without, plural, =0 {} one {{without} reseller has no contact address.} other {{without} resellers have no contact address.}}', { sent: reply.sent.length, failed: reply.failed.length, without: reply.withoutContact.length }))
      })
    })
  })
}

export const WHM_NETWORK_CLIENT_BINDING = `(()=>{const ACL_LIST_NAME=${ACL_LIST_NAME.toString()};const parseIpMigrationPairs=${parseIpMigrationPairs.toString()};return ${bindWhmNetwork.toString()};})()`
