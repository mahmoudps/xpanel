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
  const policy = qualified ? props.firewallPolicy : undefined
  const staged = qualified ? props.firewallStaged : undefined
  const applySteps = qualified ? props.firewallApplySteps : undefined
  const applied = qualified && props.generationActivatedAt ? formatDisplayDateTime(props.generationActivatedAt) : ''
  const ports = ([[settings?.panelPort, 'xWHM'], [settings?.sshPort, 'SSH']] as const).filter(([port]) => port !== undefined)
  const tile = (label: string, valueHtml: string, noteHtml = ''): string => `<div class="v2-host__tile"><dt>${escapeHtml(t(label))}</dt><dd class="v2-num">${valueHtml}</dd>${noteHtml ? `<dd class="v2-host__tile-note">${noteHtml}</dd>` : ''}</div>`
  const overview = hostCard('firewall-overview', t(msgctxt('theme:v2', 'Current ruleset')), `<dl class="v2-host__tiles" data-firewall-tiles>${[
    tile(msgid('Generation'), qualified ? technical(props.generationId, unread) : escapeHtml(unread), applied ? `${escapeHtml(t(msgctxt('theme:v2', 'Applied at')))} <bdi class="v2-num" dir="ltr">${escapeHtml(applied)}</bdi>` : ''),
    tile(msgid('Enforcement'), policy ? escapeHtml(t(policy.enabled ? msgid('Enabled') : msgid('Off'))) : escapeHtml(unread)),
    tile(msgctxt('theme:v2', 'Input policy'), policy ? escapeHtml(t(policy.enabled ? msgid('Drop') : msgid('Allow'))) : escapeHtml(unread)),
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
<p>${escapeHtml(t(msgid('One port or a range such as 8000-8100. Leave source empty for any source.')))}</p><div class="v2-host__actions">${hostButton(t(msgid('Cancel')), undefined, { type: 'reset', disabled: !qualified })}${hostButton(t(msgid('Stage for review')), { 'data-firewall-action': 'stage-port' }, { disabled: !qualified })}${hostButton(t(msgid('Check and save')), undefined, { type: 'submit', disabled: !qualified, primary: true })}</div><p data-firewall-port-rule-status role="status"></p>`
  const create = hostCard('firewall-create', t(msgid('Add a port rule')), qualified
    ? `<form class="v2-host__groups" data-firewall-port-rule-form>${formBody}</form>`
    : `<div class="v2-host__groups" data-firewall-port-rule-unavailable>${formBody}<p role="status">${escapeHtml(t(msgid('Creating a port rule requires the explicitly qualified port-rule capability. No rule has been submitted.')))}</p></div>`)
  const exchange = hostCard('firewall-exchange', t(msgid('Import and export')), `<div class="v2-host__fields">${field('firewall-import-file', msgid('JSON file'), 'file')}${field('firewall-import-json', msgid('JSON ruleset'), 'textarea')}</div><div class="v2-host__actions">${hostButton(t(msgid('Stage import')), { 'data-firewall-action': 'stage-import' }, { disabled: true })}${hostButton(t(msgid('Import JSON')), { 'data-firewall-action': 'import' }, { disabled: true })}${hostButton(t(msgid('Export JSON')), { 'data-firewall-action': 'export' }, { disabled: true })}</div>`, { 'data-whm-ops-section': 'firewall-import-export' })
  const actionLabel = (act: FirewallRule['action']): string => t(act === 'accept' ? msgid('Allow') : act === 'reject' ? msgid('Reject') : msgid('Drop'))
  const stagedDiffCount = staged ? staged.counts.added + staged.counts.changed + staged.counts.removed + (staged.counts.moved ? 1 : 0) : 0
  const reviewPill = staged === undefined
    ? statusPill({ label: unread, tone: 'neutral', hooks: { 'data-firewall-review-pill': true } })
    : staged === null
      ? statusPill({ label: t(msgid('No pending changes')), tone: 'neutral', hooks: { 'data-firewall-review-pill': true } })
      : statusPill({ label: t(msgid('{count} staged'), { count: stagedDiffCount }), tone: staged.valid && !staged.stale ? 'warn' : 'bad', hooks: { 'data-firewall-review-pill': true } })
  const reviewStatusText = staged === undefined
    ? t(msgctxt('theme:v2', 'No proposed ruleset has been read. No change is presented as tested or applied.'))
    : staged === null
      ? t(msgctxt('theme:v2', 'No staged ruleset is waiting for review. Stage a port rule or JSON import to compare current and proposed rules before applying.'))
      : staged.stale
        ? t(msgctxt('theme:v2', 'Active rules changed since this draft was staged by {actor}. Restage before applying.'), { actor: staged.actor })
        : staged.lockout.checked && !staged.lockout.passed
          ? t(msgctxt('theme:v2', 'Blocked by self-lockout guard: {reason}'), { reason: staged.lockout.message ?? '' })
          : t(msgctxt('theme:v2', 'Staged by {actor}: {current} current rules -> {proposed} proposed rules (+{added} / ~{changed} / -{removed}).'), {
              actor: staged.actor,
              current: staged.currentRuleCount,
              proposed: staged.proposedRuleCount,
              added: staged.counts.added,
              changed: staged.counts.changed,
              removed: staged.counts.removed,
            })
  const reviewColumns = [t(msgid('Change')), t(msgctxt('theme:v2', 'Rule')), t(msgctxt('theme:v2', 'Match')), t(msgid('Source')), t(msgctxt('theme:v2', 'Lockout check'))]
  const reviewRows = (staged?.items ?? []).map(item => ({
    cellsHtml: [
      statusPill({ label: t(item.change === 'added' ? msgid('Added') : item.change === 'changed' ? msgid('Changed') : msgid('Removed')), tone: item.change === 'added' ? 'ok' : item.change === 'changed' ? 'warn' : 'bad' }),
      item.change === 'changed' && item.beforeAction
        ? `${escapeHtml(actionLabel(item.beforeAction))} -> <strong>${escapeHtml(actionLabel(item.action))}</strong>`
        : escapeHtml(actionLabel(item.action)),
      item.change === 'changed' && item.beforeMatch && item.beforeMatch !== item.match
        ? `${technical(item.beforeMatch)} -> ${technical(item.match)}`
        : technical(item.match),
      item.source === null ? escapeHtml(t(msgid('Any source'))) : technical(item.source),
      statusPill({
        label: t(item.lockoutCheck === 'pass' ? msgid('Pass') : item.lockoutCheck === 'blocked' ? msgid('Blocked') : msgid('Unchecked')),
        tone: item.lockoutCheck === 'pass' ? 'ok' : item.lockoutCheck === 'blocked' ? 'bad' : 'neutral',
      }),
    ].map((cell, index) => `<span data-phone-label="${escapeHtml(reviewColumns[index]!)}">${cell}</span>`),
  }))
  const stepDefs = [
    ['lockout-check', msgctxt('theme:v2', 'Lockout check against your session')],
    ['apply-generation', msgctxt('theme:v2', 'Applied as one generation')],
    ['session-readback', msgctxt('theme:v2', 'Read back from this session')],
    ['confirm-or-revert', msgctxt('theme:v2', 'Kept, or the previous rules return')],
  ] as const
  const stepState = (id: typeof stepDefs[number][0]) => applySteps?.find(item => item.id === id)?.state ?? 'upcoming'
  const compareFacts = hostFacts([
    { label: t(msgid('Current rules')), valueHtml: staged ? technical(staged.currentRuleCount) : rules ? technical(rules.length) : escapeHtml(unread), hooks: { 'data-firewall-compare-current': true } },
    { label: t(msgid('Proposed rules')), valueHtml: staged ? technical(staged.proposedRuleCount) : escapeHtml('—'), hooks: { 'data-firewall-compare-proposed': true } },
    { label: t(msgid('Changes (+ / ~ / -)')), valueHtml: staged ? technical(`+${staged.counts.added} / ~${staged.counts.changed} / -${staged.counts.removed}`) : escapeHtml('—'), hooks: { 'data-firewall-compare-diff': true } },
  ])
  const review = hostCard('firewall-review', t(msgctxt('theme:v2', 'Review pending changes')), `<p role="status" data-firewall-review-status>${escapeHtml(reviewStatusText)}</p>${compareFacts}${hostTable(t, 'firewall-review', t(msgctxt('theme:v2', 'Proposed rules')), reviewColumns, reviewRows, staged === null ? t(msgid('No staged changes.')) : t(msgctxt('theme:v2', 'No pending change has been read.')), { 'data-firewall-review-rows': true })}<div class="v2-host__actions">${hostButton(t(msgid('Discard staged')), { 'data-firewall-action': 'discard-staged' }, { disabled: !qualified || !staged })}${hostButton(t(msgid('Apply staged ruleset')), { 'data-firewall-action': 'apply-staged' }, { disabled: !qualified || !staged || !staged.valid || staged.stale, primary: true })}</div><h3>${escapeHtml(t(msgctxt('theme:v2', 'What a save does')))}</h3>${stepper({ label: t(msgctxt('theme:v2', 'What a save does')), inline: true, hooks: { 'data-firewall-apply-steps': true }, steps: stepDefs.map(([id, label]) => ({ label: t(label), state: stepState(id), hooks: { 'data-firewall-step': id } })) })}<p>${escapeHtml(t(msgctxt('theme:v2', 'Use the operation result and a live enforcement probe before reporting a port as opened or blocked.')))}</p>`, { 'data-whm-ops-section': 'firewall-review' }, reviewPill)
  return hostPage(props, route, t(msgid('Firewall')), t(msgctxt('theme:v2', 'Review saved rules and the result of the trusted-session lockout check.')), `${guard}${power}${overview}${categoryCard}<div class="v2-host__split"><div class="v2-host__stack">${review}</div><aside class="v2-host__stack" aria-label="${escapeHtml(t(msgid('Add a port rule')))}">${create}</aside></div>${exchange}`,
    { 'data-approved-whm-operations': route, 'data-operation-state': qualified ? 'qualified' : 'unavailable' },
    `<a class="v2-btn" href="#v2-host-firewall-exchange-heading">${escapeHtml(t(msgid('Import and export')))}</a><a class="v2-btn v2-btn--primary" href="#v2-host-firewall-create-heading">${escapeHtml(t(msgid('Add a port rule')))}</a>`)
}
