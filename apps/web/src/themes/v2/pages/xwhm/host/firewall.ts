import type { FirewallRule } from '@xpanel/core'
import { escapeHtml } from '../../../html.ts'
import { formField } from '../../../components/form-field.ts'
import { statusPill } from '../../../components/status-pill.ts'
import { notice } from '../../../components/notice.ts'
import { stepper } from '../../../components/stepper.ts'
import { filterBar } from '../../../components/filter-bar.ts'
import { formatDisplayDateTime } from '../../../../../display-format.ts'
import { hostButton, hostCard, hostContext, hostFacts, hostPage, hostTable, technical, type HostPageProps } from './common.ts'
import { renderV2WhmFirewallClientTemplates } from './firewall-client-templates.ts'

const CATEGORIES = [
  ['port', msgid('Ports')], ['ip', msgid('IP addresses')], ['forward', msgid('Port forwarding')], ['banned', msgctxt('theme:v2', 'Temporary blocks')], ['icmp', msgctxt('theme:v2', 'ICMP')], ['prefix-list', msgid('Prefix lists')],
] as const

/** The session lockout guard and enforcement outcome remain authoritative in the core API. */
export function renderV2WhmFirewall(props: HostPageProps): string {
  const route = '/whm/security/firewall'
  const { t, readable } = hostContext(props, route)
  const qualified = readable && props.catalog?.some(tool => tool.id === 'aapanel-port-rules' && tool.status === 'verified' && tool.delivery.status === 'verified') === true
  const rules = qualified ? props.firewallRules : undefined
  const unread = t(msgid('Not read'))
  const action = (rule: FirewallRule): string => statusPill({ label: t(rule.action === 'accept' ? msgid('Allow') : rule.action === 'reject' ? msgid('Reject') : msgid('Drop')), tone: rule.action === 'accept' ? 'ok' : 'bad' })
  const field = (name: string, label: string, type: 'text' | 'textarea' | 'file' = 'text', disabled = true): string => {
    const id = `v2-firewall-${name}`
    return `<div class="v2-host__field"><label for="${id}">${escapeHtml(t(label))}</label>${type === 'textarea' ? `<textarea id="${id}" name="${name}" dir="ltr" rows="4"${disabled ? ' disabled' : ''}></textarea>` : `<input id="${id}" name="${name}" type="${type}" dir="ltr"${disabled ? ' disabled' : ''}${name === 'port' && !disabled ? ' required' : ''}${type === 'file' ? ' accept="application/json,.json,text/plain"' : ''}>`}</div>`
  }
  const select = (name: string, label: string, options: readonly (readonly [string, string])[], disabled = true): string =>
    formField({ id: `v2-firewall-${name}`, label: t(label), control: { kind: 'select', name, disabled, options: options.map(([value, label]) => ({ value, label: t(label) })) } })
  const headers: Record<FirewallRule['kind'] | 'banned', readonly string[]> = {
    port: [msgid('Position'), msgid('Action'), msgid('Protocol'), msgid('Port'), msgid('Source'), msgctxt('theme:v2', 'Purpose'), msgctxt('theme:v2', 'Origin'), msgid('Note'), msgid('Manage')],
    ip: [msgid('Action'), msgid('Address or range'), msgid('Ports'), msgid('Note'), msgid('Added'), msgid('Expires')],
    forward: [msgid('Protocol'), msgid('Listen port'), msgid('Destination'), msgid('Allowed source'), msgid('Note')],
    icmp: [msgid('Action'), msgid('Source'), msgid('Type and family'), msgid('Rate limit'), msgid('Why')],
    'prefix-list': [msgid('Name'), msgid('Action'), msgid('Entries'), msgid('Ports'), msgid('File'), msgid('Updated')],
    banned: [msgid('Address'), msgid('Reason'), msgid('Source'), msgid('Banned at (UTC)'), msgid('Expires (UTC)')],
  }
  const cells = (rule: FirewallRule): readonly string[] => {
    const source = rule.source === null ? escapeHtml(t(msgid('Any source'))) : technical(rule.source)
    switch (rule.kind) {
      case 'port': return [String(rules!.indexOf(rule) + 1), action(rule), technical(rule.protocol), technical(rule.port), source, escapeHtml(unread), escapeHtml(unread), escapeHtml(rule.comment), hostButton(t(msgid('Manage')), undefined, { disabled: true })]
      case 'ip': return [action(rule), source, technical(rule.port), escapeHtml(rule.comment), escapeHtml(unread), escapeHtml(unread)]
      case 'forward': return [technical(rule.protocol), technical(rule.port), technical(rule.forwardTo), source, escapeHtml(rule.comment)]
      case 'icmp': return [action(rule), source, escapeHtml(unread), escapeHtml(unread), escapeHtml(rule.comment)]
      case 'prefix-list': return [technical(rule.list), action(rule), escapeHtml(unread), technical(rule.port), escapeHtml(unread), escapeHtml(unread)]
    }
  }
  const saved = (kind: typeof CATEGORIES[number][0]) => kind === 'banned' ? undefined : rules?.filter(rule => rule.kind === kind)
  const categories = CATEGORIES.map(([kind, label]) => {
    const selected = saved(kind)
    const table = hostTable(t, `firewall-${kind}`, t(label), headers[kind].map(heading => t(heading)), (selected ?? []).map(rule => ({ hooks: { 'data-list-row': true, 'data-list-action': rule.kind === 'prefix-list' ? undefined : rule.action }, cellsHtml: cells(rule).map((cell, index) => `<span data-phone-label="${escapeHtml(t(headers[kind][index]!))}">${cell}</span>`) })),
      selected === undefined ? t(msgid('Nothing has been read yet.')) : t(msgid('No saved rules of this type.')))
    // The generic list filter: a search on every list, and action chips where the rows carry data-list-action (prefix lists and bans do not).
    const chips = kind === 'port' || kind === 'ip' || kind === 'icmp'
    const filter = filterBar({ search: { id: `v2-firewall-${kind}-search`, label: t(msgid('Search')), hooks: { 'data-list-filter-search': true } },
      ...(chips ? { hooks: { 'data-list-filter-key': 'action' }, segments: { label: t(msgid('Action')), options: ([['', msgid('All')], ['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]] as const).map(([value, label]) => ({ label: t(label), pressed: value === '', hooks: { 'data-list-filter-value': value } })) } } : {}) })
    const extras = kind === 'prefix-list' ? `<div class="v2-host__fields">${field('firewall-prefix-name', msgid('List name'))}${field('firewall-prefix-file', msgid('Prefix file'), 'file')}${field('firewall-prefix-ports', msgid('Ports'))}${select('firewall-prefix-action', msgid('Action'), [['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]])}</div><p>${escapeHtml(t(msgid('Plain text, one IPv4 or IPv6 range per line. Each list loads as an nftables interval set, so large lists stay fast.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Upload prefix list')), { 'data-firewall-action': 'upload-list' }, { disabled: true })}${hostButton(t(msgid('Replace file')), { 'data-firewall-action': 'replace-list' }, { disabled: true })}</div>`
      : kind === 'banned' ? `${field('firewall-unban-address', msgid('Address to unban'))}<div class="v2-host__actions">${hostButton(t(msgid('Unban')), { 'data-firewall-action': 'unban' }, { disabled: true })}</div>`
      : kind === 'icmp' ? `<label class="v2-host__choice"><input type="checkbox" role="switch" data-whm-firewall-ping disabled><span>${escapeHtml(t(msgid('Answer ping from the internet')))}</span></label><p>${escapeHtml(t(msgid('When off, the server ignores ping from every address, with the firewall on or off, and ICMP rules below do not apply to ping. Error messages that IPv6 and path MTU discovery need are always allowed.')))}</p>` : ''
    return `<section class="v2-host__groups" id="v2-firewall-panel-${kind}" role="tabpanel" aria-labelledby="v2-firewall-tab-${kind}" data-whm-firewall-panel="${kind}" data-firewall-category="${kind}" data-list-filter><h3 class="v2-sr">${escapeHtml(t(label))} <span class="v2-muted">(${selected === undefined ? escapeHtml(unread) : selected.length})</span></h3>${filter}${table}<p class="v2-muted" data-list-filter-empty hidden>${escapeHtml(t(msgid('No loaded rows match these filters.')))}</p><p class="v2-host__rowcount">${escapeHtml(t(msgctxt('theme:v2', 'Rules in this list')))} <span class="v2-num" data-firewall-rule-count>${selected === undefined ? escapeHtml(unread) : selected.length}</span></p>${extras}</section>`
  }).join('')
  const tabs = `<div class="v2-tabs" role="tablist" aria-label="${escapeHtml(t(msgid('Rule categories')))}">${CATEGORIES.map(([kind, label], index) => `<button type="button" role="tab" id="v2-firewall-tab-${kind}" aria-controls="v2-firewall-panel-${kind}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-whm-firewall-tab="${kind}" disabled>${escapeHtml(t(label))}${saved(kind) === undefined ? '' : `<span class="v2-count v2-num">${saved(kind)!.length}</span>`}</button>`).join('')}</div>`
  const power = hostCard('firewall-switch', t(msgid('Firewall')), `<div class="v2-host__power" data-whm-firewall-policy data-whm-firewall-can-manage="${qualified}"><div class="v2-host__groups"><label class="v2-host__choice"><input type="checkbox" role="switch" data-whm-firewall-enabled disabled><span>${escapeHtml(t(msgid('Filter inbound traffic')))}</span></label><p role="status" data-state="unread" data-whm-firewall-policy-status>${escapeHtml(unread)}</p></div><p>${escapeHtml(t(msgid('On drops what no rule allows. A first switch-on writes rules for the panel, SSH, sites, mail, DNS and FTP. Turning it off leaves the rules saved.')))}</p></div>`)
  const settings = qualified ? props.serverSettings : undefined
  const applied = qualified && props.generationActivatedAt ? formatDisplayDateTime(props.generationActivatedAt) : ''
  const ports = ([[settings?.panelPort, 'xWHM'], [settings?.sshPort, 'SSH']] as const).filter(([port]) => port !== undefined)
  const tile = (label: string, valueHtml: string, noteHtml = ''): string => `<div class="v2-host__tile"><dt>${escapeHtml(t(label))}</dt><dd class="v2-num">${valueHtml}</dd>${noteHtml ? `<dd class="v2-host__tile-note">${noteHtml}</dd>` : ''}</div>`
  const overview = hostCard('firewall-overview', t(msgctxt('theme:v2', 'Current ruleset')), `<dl class="v2-host__tiles">${[
    tile(msgid('Generation'), qualified ? technical(props.generationId, unread) : escapeHtml(unread), applied ? `${escapeHtml(t(msgctxt('theme:v2', 'Applied at')))} <bdi class="v2-num" dir="ltr">${escapeHtml(applied)}</bdi>` : ''),
    tile(msgid('Enforcement'), escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Input policy'), escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Your session'), qualified ? technical(props.adminSessionIp || undefined, unread) : escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Management ports'), ports.length ? `<span class="v2-host__ports">${ports.map(([port, name]) => `<span><bdi class="v2-mono" dir="ltr">${escapeHtml(port!)}</bdi> ${name}</span>`).join('')}</span>` : escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Backend'), qualified ? technical(settings?.backendPort, unread) : escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Saved rules'), rules ? technical(rules.length) : escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Temporary blocks'), escapeHtml(unread)),
  ].join('')}</dl>`, undefined, qualified && props.generationId !== undefined ? statusPill({ label: `${t(msgid('Generation'))} ${props.generationId}`, tone: 'neutral' }) : statusPill({ label: unread, tone: 'neutral', hollow: true }))
  const guard = notice(t, { tone: 'info', text: t(msgctxt('theme:v2', 'The server checks proposed desired-state rules against the trusted session address and management ports. Stored rules do not establish live enforcement.')) })
  const categoryCard = hostCard('firewall-categories', t(msgid('Rules')), `<p data-firewall-manage-status role="status"></p><p>${escapeHtml(t(msgctxt('theme:v2', 'Rules are evaluated in stored order; the first match wins.')))}</p><div class="v2-host__groups" data-whm-firewall-tabs>${tabs}${categories}</div>${renderV2WhmFirewallClientTemplates({ port: headers.port, ip: headers.ip, forward: headers.forward, prefix: headers['prefix-list'], ban: headers.banned }, t)}`, { 'data-whm-ops-section': 'firewall-rule-categories' })
  const formBody = `<fieldset><legend>${escapeHtml(t(msgid('Action')))}</legend><div class="v2-host__choices">${[['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]].map(([value, label]) => `<label class="v2-host__choice"><input type="radio" name="action" value="${value}"${qualified ? ' required' : ' disabled'}><span>${escapeHtml(t(label!))}</span></label>`).join('')}</div></fieldset>
<div class="v2-host__fields">${select('protocol', msgid('Protocol'), [['tcp', msgctxt('theme:v2', 'TCP')], ['udp', msgctxt('theme:v2', 'UDP')], ['both', msgid('TCP and UDP')]], !qualified)}${field('port', msgid('Port or range'), 'text', !qualified)}${field('source', msgid('Source'), 'text', !qualified)}${select('position', msgid('Position'), [['end', msgid('At the end')], ['top', msgid('At the top')]], !qualified)}${field('comment', msgid('Note'), 'text', !qualified)}</div>
<p>${escapeHtml(t(msgid('One port or a range such as 8000-8100. Leave source empty for any source.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Cancel')), undefined, { type: 'reset', disabled: !qualified })}${hostButton(t(msgid('Check and save')), undefined, { type: 'submit', disabled: !qualified, primary: true })}</div><p data-firewall-port-rule-status role="status"></p>`
  const create = hostCard('firewall-create', t(msgid('Add a port rule')), qualified
    ? `<form class="v2-host__groups" data-firewall-port-rule-form>${formBody}</form>`
    : `<div class="v2-host__groups" data-firewall-port-rule-unavailable>${formBody}<p role="status">${escapeHtml(t(msgid('Creating a port rule requires the explicitly qualified port-rule capability. No rule has been submitted.')))}</p></div>`)
  const exchange = hostCard('firewall-exchange', t(msgid('Import and export')), `<div class="v2-host__fields">${field('firewall-import-file', msgid('JSON file'), 'file')}${field('firewall-import-json', msgid('JSON ruleset'), 'textarea')}</div><div class="v2-host__actions">${hostButton(t(msgid('Import JSON')), { 'data-firewall-action': 'import' }, { disabled: true })}${hostButton(t(msgid('Export JSON')), { 'data-firewall-action': 'export' }, { disabled: true })}</div>`, { 'data-whm-ops-section': 'firewall-import-export' })
  const review = hostCard('firewall-review', t(msgctxt('theme:v2', 'Review pending changes')), `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'No proposed ruleset has been read. No change is presented as tested or applied.')))}</p>${hostTable(t, 'firewall-review', t(msgctxt('theme:v2', 'Proposed rules')), [t(msgid('Change')), t(msgctxt('theme:v2', 'Rule')), t(msgctxt('theme:v2', 'Match')), t(msgid('Source')), t(msgctxt('theme:v2', 'Lockout check'))], [], t(msgctxt('theme:v2', 'No pending change has been read.')))}<h3>${escapeHtml(t(msgctxt('theme:v2', 'What a save does')))}</h3>${stepper({ label: t(msgctxt('theme:v2', 'What a save does')), inline: true, steps: [msgctxt('theme:v2', 'Lockout check against your session'), msgctxt('theme:v2', 'Applied as one generation'), msgctxt('theme:v2', 'Read back from this session'), msgctxt('theme:v2', 'Kept, or the previous rules return')].map(label => ({ label: t(label), state: 'upcoming' as const })) })}<p>${escapeHtml(t(msgctxt('theme:v2', 'Use the operation result and a live enforcement probe before reporting a port as opened or blocked.')))}</p>`, undefined, statusPill({ label: unread, tone: 'neutral' }))
  return hostPage(props, route, t(msgid('Firewall')), t(msgctxt('theme:v2', 'Review saved rules and the result of the trusted-session lockout check.')), `${guard}${power}${overview}${categoryCard}<div class="v2-host__split"><div class="v2-host__stack">${review}${exchange}</div><aside aria-label="${escapeHtml(t(msgid('Add a port rule')))}">${create}</aside></div>`,
    { 'data-approved-whm-operations': route, 'data-operation-state': qualified ? 'qualified' : 'unavailable' },
    `<a class="v2-btn" href="#v2-host-firewall-exchange-heading">${escapeHtml(t(msgid('Import and export')))}</a><a class="v2-btn v2-btn--primary" href="#v2-host-firewall-create-heading">${escapeHtml(t(msgid('Add a port rule')))}</a>`)
}
