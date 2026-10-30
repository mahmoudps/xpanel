import type { FirewallRule } from '@xpanel/core'
import { escapeHtml } from '../../../html.ts'
import { formField } from '../../../components/form-field.ts'
import { statusPill } from '../../../components/status-pill.ts'
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
    return `<div class="v2-host__field"><label for="${id}">${escapeHtml(t(label))}</label>${type === 'textarea' ? `<textarea id="${id}" name="${name}" dir="ltr" rows="6"${disabled ? ' disabled' : ''}></textarea>` : `<input id="${id}" name="${name}" type="${type}" dir="ltr"${disabled ? ' disabled' : ''}${name === 'port' && !disabled ? ' required' : ''}${type === 'file' ? ' accept="application/json,.json,text/plain"' : ''}>`}</div>`
  }
  const select = (name: string, label: string, options: readonly (readonly [string, string])[], disabled = true): string =>
    formField({ id: `v2-firewall-${name}`, label: t(label), control: { kind: 'select', name, disabled, options: options.map(([value, label]) => ({ value, label: t(label) })) } })
  const headers: Record<FirewallRule['kind'] | 'banned', readonly string[]> = {
    port: [msgid('Position'), msgid('Action'), msgid('Protocol'), msgid('Port'), msgid('Source'), msgid('Note')],
    ip: [msgid('Action'), msgid('Address or range'), msgid('Ports'), msgid('Note'), msgid('Added'), msgid('Expires')],
    forward: [msgid('Protocol'), msgid('Listen port'), msgid('Destination'), msgid('Allowed source'), msgid('Note')],
    icmp: [msgid('Action'), msgid('Source'), msgid('Type and family'), msgid('Rate limit'), msgid('Why')],
    'prefix-list': [msgid('Name'), msgid('Action'), msgid('Entries'), msgid('Ports'), msgid('File'), msgid('Updated')],
    banned: [msgid('Address'), msgid('Reason'), msgid('Source'), msgid('Banned at (UTC)'), msgid('Expires (UTC)')],
  }
  const cells = (rule: FirewallRule): readonly string[] => {
    const source = rule.source === null ? escapeHtml(t(msgid('Any source'))) : technical(rule.source)
    switch (rule.kind) {
      case 'port': return [String(rules!.indexOf(rule) + 1), action(rule), technical(rule.protocol), technical(rule.port), source, escapeHtml(rule.comment)]
      case 'ip': return [action(rule), source, technical(rule.port), escapeHtml(rule.comment), escapeHtml(unread), escapeHtml(unread)]
      case 'forward': return [technical(rule.protocol), technical(rule.port), technical(rule.forwardTo), source, escapeHtml(rule.comment)]
      case 'icmp': return [action(rule), source, escapeHtml(unread), escapeHtml(unread), escapeHtml(rule.comment)]
      case 'prefix-list': return [technical(rule.list), action(rule), escapeHtml(unread), technical(rule.port), escapeHtml(unread), escapeHtml(unread)]
    }
  }
  const categories = CATEGORIES.map(([kind, label]) => {
    const selected = kind === 'banned' ? undefined : rules?.filter(rule => rule.kind === kind)
    const table = hostTable(t, `firewall-${kind}`, t(label), headers[kind].map(heading => t(heading)), (selected ?? []).map(rule => ({ cellsHtml: cells(rule) })),
      selected === undefined ? t(msgid('Nothing has been read yet.')) : t(msgid('No saved rules of this type.')))
    const extras = kind === 'prefix-list' ? `<div class="v2-host__fields">${field('firewall-prefix-name', msgid('List name'))}${field('firewall-prefix-file', msgid('Prefix file'), 'file')}${field('firewall-prefix-ports', msgid('Ports'))}${select('firewall-prefix-action', msgid('Action'), [['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]])}</div><p>${escapeHtml(t(msgid('Plain text, one IPv4 or IPv6 range per line. Each list loads as an nftables interval set, so large lists stay fast.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Upload prefix list')), { 'data-firewall-action': 'upload-list' }, { disabled: true })}${hostButton(t(msgid('Replace file')), { 'data-firewall-action': 'replace-list' }, { disabled: true })}</div>`
      : kind === 'banned' ? `${field('firewall-unban-address', msgid('Address to unban'))}<div class="v2-host__actions">${hostButton(t(msgid('Unban')), { 'data-firewall-action': 'unban' }, { disabled: true })}</div>`
      : kind === 'icmp' ? `<label class="v2-host__choice"><input type="checkbox" disabled><span>${escapeHtml(t(msgid('Answer ping from the internet')))} (${escapeHtml(unread)})</span></label><p role="status">${escapeHtml(t(msgid('The live ICMP and path-MTU protection policy has not been probed.')))}</p>` : ''
    return `<section class="v2-host__groups" id="v2-firewall-panel-${kind}" role="tabpanel" aria-labelledby="v2-firewall-tab-${kind}" data-whm-firewall-panel="${kind}" data-firewall-category="${kind}"><h3>${escapeHtml(t(label))} <span class="v2-muted">(${selected === undefined ? escapeHtml(unread) : selected.length})</span></h3>${table}${extras}</section>`
  }).join('')
  const tabs = `<div class="v2-host__actions" role="tablist" aria-label="${escapeHtml(t(msgid('Rule categories')))}">${CATEGORIES.map(([kind, label], index) => `<button class="v2-btn" type="button" role="tab" id="v2-firewall-tab-${kind}" aria-controls="v2-firewall-panel-${kind}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-whm-firewall-tab="${kind}" disabled>${escapeHtml(t(label))}</button>`).join('')}</div>`
  const overview = hostCard('firewall-overview', t(msgctxt('theme:v2', 'Current ruleset')), hostFacts([
    { label: t(msgid('Generation')), valueHtml: qualified ? technical(props.generationId, unread) : escapeHtml(unread) },
    { label: t(msgid('Enforcement')), valueHtml: escapeHtml(unread) },
    { label: t(msgctxt('theme:v2', 'Input policy')), valueHtml: escapeHtml(unread) },
    { label: t(msgctxt('theme:v2', 'Your session')), valueHtml: qualified ? technical(props.adminSessionIp || undefined, unread) : escapeHtml(unread) },
    { label: t(msgctxt('theme:v2', 'Backend')), valueHtml: qualified ? technical(props.serverSettings?.backendPort, unread) : escapeHtml(unread) },
    { label: t(msgctxt('theme:v2', 'Temporary blocks')), valueHtml: escapeHtml(unread) },
  ]) + `<p>${escapeHtml(t(msgctxt('theme:v2', 'The server checks proposed desired-state rules against the trusted session address and management ports. Stored rules do not establish live enforcement.')))}</p>`)
  const categoryCard = hostCard('firewall-categories', t(msgid('Rules')), `<p data-firewall-manage-status role="status"></p><p>${escapeHtml(t(msgctxt('theme:v2', 'Rules are evaluated in stored order; the first match wins.')))}</p><div class="v2-host__groups" data-whm-firewall-tabs>${tabs}${categories}</div>${renderV2WhmFirewallClientTemplates()}`, { 'data-whm-ops-section': 'firewall-rule-categories' })
  const formBody = `<fieldset><legend>${escapeHtml(t(msgid('Action')))}</legend><div class="v2-host__choices">${[['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]].map(([value, label]) => `<label class="v2-host__choice"><input type="radio" name="action" value="${value}"${qualified ? ' required' : ' disabled'}><span>${escapeHtml(t(label!))}</span></label>`).join('')}</div></fieldset>
<div class="v2-host__fields">${select('protocol', msgid('Protocol'), [['tcp', msgctxt('theme:v2', 'TCP')], ['udp', msgctxt('theme:v2', 'UDP')], ['both', msgid('TCP and UDP')]], !qualified)}${field('port', msgid('Port or range'), 'text', !qualified)}${field('source', msgid('Source'), 'text', !qualified)}${select('position', msgid('Position'), [['end', msgid('At the end')], ['top', msgid('At the top')]], !qualified)}${field('comment', msgid('Note'), 'text', !qualified)}</div>
<p>${escapeHtml(t(msgid('One port or a range such as 8000-8100. Leave source empty for any source.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Cancel')), undefined, { type: 'reset', disabled: !qualified })}${hostButton(t(msgid('Check and save')), undefined, { type: 'submit', disabled: !qualified, primary: true })}</div><p data-firewall-port-rule-status role="status"></p>`
  const create = hostCard('firewall-create', t(msgid('Add a port rule')), qualified
    ? `<form class="v2-host__groups" data-firewall-port-rule-form>${formBody}</form>`
    : `<div class="v2-host__groups" data-firewall-port-rule-unavailable>${formBody}<p role="status">${escapeHtml(t(msgid('Creating a port rule requires the explicitly qualified port-rule capability. No rule has been submitted.')))}</p></div>`)
  const exchange = hostCard('firewall-exchange', t(msgid('Import and export')), `<div class="v2-host__fields">${field('firewall-import-file', msgid('JSON file'), 'file')}${field('firewall-import-json', msgid('JSON ruleset'), 'textarea')}</div><div class="v2-host__actions">${hostButton(t(msgid('Import JSON')), { 'data-firewall-action': 'import' }, { disabled: true })}${hostButton(t(msgid('Export JSON')), { 'data-firewall-action': 'export' }, { disabled: true })}</div>`, { 'data-whm-ops-section': 'firewall-import-export' })
  const review = hostCard('firewall-review', t(msgctxt('theme:v2', 'Review pending changes')), `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'No proposed ruleset has been read. No change is presented as tested or applied.')))}</p>${hostTable(t, 'firewall-review', t(msgctxt('theme:v2', 'Proposed rules')), [t(msgid('Change')), t(msgctxt('theme:v2', 'Rule')), t(msgctxt('theme:v2', 'Match')), t(msgid('Source')), t(msgctxt('theme:v2', 'Lockout check'))], [], t(msgctxt('theme:v2', 'No pending change has been read.')))}<p>${escapeHtml(t(msgctxt('theme:v2', 'Use the operation result and a live enforcement probe before reporting a port as opened or blocked.')))}</p>`)
  return hostPage(props, route, t(msgid('Firewall')), t(msgctxt('theme:v2', 'Review saved rules and the result of the trusted-session lockout check.')), `${overview}${categoryCard}<div class="v2-host__split"><div class="v2-host__stack">${review}${exchange}</div><aside aria-label="${escapeHtml(t(msgid('Add a port rule')))}">${create}</aside></div>`,
    { 'data-approved-whm-operations': route, 'data-operation-state': qualified ? 'qualified' : 'unavailable' })
}
