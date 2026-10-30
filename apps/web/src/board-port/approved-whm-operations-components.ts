import { canOpenRegisteredRoute, type CatalogTool } from '@xpanel/catalog'
import type { FirewallRule } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { escapeHtml, renderLtrValue } from '../tokens.ts'
import { SOURCE_LOCALE, localeDirection, translator, type Locale } from '../i18n.ts'
import { renderWhmFirewallClientTemplates } from './whm-firewall-client-templates.ts'
type Copy = string
type Context = { locale: Locale; readOnly: boolean; text(copy: Copy): string }
const notRead = msgid('Not read')
const RESTART_TOOLS = ['restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-ftp', 'restart-dns'] as const
const qualified = (catalog: readonly CatalogTool[] | undefined, id: string): boolean => catalog?.some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified') === true

const STYLE = `<style>
.xp-whm-ops{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}.xp-whm-ops :is(h2,h3,p,dl,dd){margin:0}.xp-whm-ops-card{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}.xp-whm-ops-card h2{font-size:18px;line-height:1.6}.xp-whm-ops-card h3{font-size:16px;line-height:1.6}.xp-whm-ops p{line-height:1.8;overflow-wrap:anywhere}.xp-whm-ops-groups{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}.xp-whm-ops-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--xp-space-field,16px);min-inline-size:0}.xp-whm-ops-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}.xp-whm-ops-field label,.xp-whm-ops-field dt{font-weight:600}.xp-whm-ops-field>label[for]{box-sizing:border-box;padding-inline-start:var(--xp-control-content-inset,13px)}.xp-whm-ops-field dd{overflow-wrap:anywhere}.xp-whm-ops-field :is(input,select,textarea){box-sizing:border-box;inline-size:100%;min-block-size:44px;padding:10px 12px;font:inherit;color:inherit;background:var(--xp-bg-surface);border:1px solid var(--xp-border-strong);border-radius:8px}.xp-whm-ops-field textarea{min-block-size:96px;resize:vertical}.xp-whm-ops-field [dir=ltr]{text-align:start}.xp-whm-ops[dir=rtl] .xp-whm-ops-field [dir=ltr]{text-align:right}.xp-whm-ops-choice{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-whm-ops-choice input{inline-size:20px;block-size:20px;flex:none;margin:0}.xp-whm-ops-actions{display:flex;flex-wrap:wrap;gap:var(--xp-space-field,16px);align-items:center}.xp-whm-ops fieldset{margin:0;padding:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--xp-space-field,16px)}.xp-whm-ops legend{font-weight:600;margin-block-end:var(--xp-space-field,16px);padding:0}.xp-whm-ops-scroll{max-inline-size:100%;overflow-x:auto;border:1px solid var(--xp-border);border-radius:8px}.xp-whm-ops table{inline-size:100%;border-collapse:collapse;text-align:start}.xp-whm-ops :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere}.xp-whm-ops thead{background:var(--xp-bg-elevated)}.xp-whm-ops tbody tr{border-block-start:1px solid var(--xp-border)}.xp-whm-ops-status{padding:16px;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-elevated);color:var(--xp-text-secondary)}.xp-whm-ops details{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}.xp-whm-ops summary{cursor:pointer;font-weight:600;min-block-size:44px;align-content:center}.xp-whm-ops details[open]>:not(summary){margin-block-start:var(--xp-space-group,24px)}.xp-whm-ops-tabs{display:flex;flex-wrap:wrap;gap:8px}.xp-whm-ops-tabs [aria-selected=true]{background:var(--xp-bg-elevated);font-weight:600}.xp-whm-ops-panel{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}.xp-whm-ops-panel[hidden]{display:none}.xp-whm-ops-catalog{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--xp-space-group,24px)}.xp-whm-ops-catalog>section{padding:16px;display:flex;flex-direction:column;gap:var(--xp-space-group,24px);border:1px solid var(--xp-border);border-radius:8px;min-inline-size:0}.xp-whm-ops :disabled{cursor:not-allowed;opacity:.75}.xp-whm-ops :is(a,button,input,select,textarea,summary):focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
@media(min-width:801px){.xp-whm-ops-card{padding:24px}}@media(max-width:639px){.xp-whm-ops-fields,.xp-whm-ops-catalog{grid-template-columns:minmax(0,1fr)}}
</style>`

const status = (v: Context, copy: Copy): string => `<p class="xp-whm-ops-status" role="status">${v.text(copy)}</p>`
const actions = (body: string): string => `<div class="xp-whm-ops-actions">${body}</div>`
const button = (v: Context, copy: Copy, enabled = false, type: 'button' | 'reset' | 'submit' = 'button', attrs = ''): string => `<button class="xp-btn${type === 'submit' ? ' xp-btn--primary' : ''}" type="${type}"${attrs ? ` ${attrs}` : ''}${!enabled || v.readOnly ? ' disabled data-wiring="soon"' : ''}>${v.text(copy)}</button>`
const card = (v: Context, key: string, title: Copy, body: string): string => `<section class="xp-whm-ops-card" data-whm-ops-section="${key}" aria-labelledby="whm-ops-${key}"><h2 id="whm-ops-${key}">${v.text(title)}</h2>${body}</section>`
const field = (v: Context, name: string, title: Copy, options: { enabled?: boolean; type?: string; required?: boolean; value?: string; choices?: readonly (readonly [string, Copy])[] } = {}): string => {
  const id = `whm-ops-${name}`
  const unavailable = v.readOnly || !options.enabled ? ' disabled data-wiring="soon"' : ''
  const attributes = `${unavailable}${options.required && !unavailable ? ' required' : ''}`
  const value = escapeHtml(options.value ?? '')
  const control = options.choices ? `<select id="${id}" name="${name}"${attributes}><option value="">${v.text(msgid('Choose…'))}</option>${options.choices.map(([key, label]) => `<option value="${key}"${key === options.value ? ' selected' : ''}>${v.text(label)}</option>`).join('')}</select>`
    : options.type === 'textarea' ? `<textarea id="${id}" name="${name}" dir="ltr"${attributes}>${value}</textarea>`
      : `<input id="${id}" name="${name}" type="${options.type ?? 'text'}" dir="ltr"${options.type === 'file' ? '' : ` value="${value}"`}${attributes}>`
  return `<div class="xp-whm-ops-field"><label for="${id}">${v.text(title)}</label>${control}</div>`
}
const table = (v: Context, title: Copy, columns: readonly Copy[], rows: readonly (readonly string[])[], empty: Copy): string => `<div class="xp-whm-ops-scroll" role="region" tabindex="0" aria-label="${v.text(title)}"><table><caption class="sr-only">${v.text(title)}</caption><thead><tr>${columns.map(col => `<th scope="col">${v.text(col)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${columns.map((_, index) => `<td>${row[index] ?? v.text(notRead)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">${v.text(empty)}</td></tr>`}</tbody></table></div>`
const technical = (raw: string | null | undefined): string => raw === null || raw === undefined ? '' : renderLtrValue(raw)
const actionName = (v: Context, action: FirewallRule['action']): string => v.text(action === 'accept' ? msgid('Allow') : action === 'reject' ? msgid('Reject') : msgid('Drop'))
const kindName: readonly (readonly [FirewallRule['kind'] | 'banned', Copy])[] = [['port', msgid('Ports')], ['ip', msgid('Addresses')], ['forward', msgid('Port forwarding')], ['icmp', 'ICMP'], ['prefix-list', msgid('Prefix lists')], ['banned', msgid('Banned')]]

function firewall(v: Context, props: WhmSurfaceProps, readable: boolean, canCreate: boolean): string {
  const rules = readable ? props.firewallRules : undefined
  const observed = (copy: Copy): string => status(v, copy)
  const categories = kindName.map(([kind, title], index) => {
    const selected = kind === 'banned' ? undefined : rules?.filter(rule => rule.kind === kind)
    const number = selected === undefined ? v.text(notRead) : String(selected.length)
    let body: string
    if (kind === 'port') body = table(v, msgid('Port rules'), [msgid('Position'), msgid('Action'), msgid('Protocol'), msgid('Port'), msgid('Source'), msgid('Note')], (selected ?? []).map(rule => [String(rules!.indexOf(rule) + 1), actionName(v, rule.action), technical(rule.protocol), technical(rule.port), rule.source === null ? v.text(msgid('Any source')) : technical(rule.source), escapeHtml(rule.comment)]), rules === undefined ? msgid('Port rules have not been read.') : msgid('No saved port rules.'))
    else if (kind === 'ip') body = table(v, msgid('Address rules'), [msgid('Action'), msgid('Address or range'), msgid('Ports'), msgid('Note'), msgid(msgctxt('approved-whm-operations-components', 'Added')), msgid(msgctxt('approved-whm-operations-components', 'Expires'))], (selected ?? []).map(rule => [actionName(v, rule.action), technical(rule.source), technical(rule.port), escapeHtml(rule.comment), v.text(notRead), v.text(notRead)]), rules === undefined ? msgid('Address rules have not been read.') : msgid('No saved address rules.'))
    else if (kind === 'forward') body = table(v, msgid('Port forwarding'), [msgid('Protocol'), msgid('Listen port'), msgid('Destination'), msgid('Allowed source'), msgid('Note')], (selected ?? []).map(rule => [technical(rule.protocol), technical(rule.port), technical(rule.forwardTo), rule.source === null ? v.text(msgid('Any source')) : technical(rule.source), escapeHtml(rule.comment)]), rules === undefined ? msgid('Forwarding rules have not been read.') : msgid('No saved forwarding rules.'))
    else if (kind === 'icmp') body = `<label class="xp-whm-ops-choice"><input type="checkbox" disabled data-wiring="soon"><span>${v.text(msgid('Answer ping from the internet'))} (${v.text(notRead)})</span></label>${table(v, msgid('ICMP policy'), [msgid('Action'), msgid('Source'), msgid('Type and family'), msgid('Rate limit'), msgid('Why')], (selected ?? []).map(rule => [actionName(v, rule.action), technical(rule.source), v.text(notRead), v.text(notRead), escapeHtml(rule.comment)]), rules === undefined ? msgid('ICMP policy has not been read.') : msgid('No saved ICMP rules.'))}${observed(msgid('The live ICMP and path-MTU protection policy has not been probed.'))}`
    else if (kind === 'prefix-list') body = `${table(v, msgid('Prefix lists'), [msgid('Name'), msgid('Action'), msgid(msgctxt('approved-whm-operations-components', 'Entries')), msgid('Ports'), msgid('File'), msgid('Updated')], (selected ?? []).map(rule => [technical(rule.list), actionName(v, rule.action), v.text(notRead), technical(rule.port), v.text(notRead), v.text(notRead)]), msgid('Prefix-list entries and files have not been read.'))}<div class="xp-whm-ops-fields">${field(v, 'firewall-prefix-name', msgid('List name'))}${field(v, 'firewall-prefix-file', msgid('Prefix file'), { type: 'file' })}${field(v, 'firewall-prefix-ports', msgid('Ports'))}${field(v, 'firewall-prefix-action', msgid('Action'), { choices: [['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]] })}</div><p>${v.text(msgid('Plain text, one IPv4 or IPv6 range per line. Each list loads as an nftables interval set, so large lists stay fast.'))}</p>${actions(button(v, msgid('Upload prefix list'), false, 'button', 'data-firewall-action="upload-list"') + button(v, msgid('Replace file'), false, 'button', 'data-firewall-action="replace-list"'))}`
    else body = `${table(v, msgid('Banned addresses'), [msgid('Address'), msgid('Reason'), msgid('Source'), msgid('Banned at (UTC)'), msgid('Expires (UTC)')], [], msgid('The live ban set and its timeouts have not been read.'))}${field(v, 'firewall-unban-address', msgid('Address to unban'))}${actions(button(v, msgid('Unban'), false, 'button', 'data-firewall-action="unban"'))}`
    // live Edit, Move and Delete actions are added to each saved row by whm-firewall-client
    const management = ''
    return `<section class="xp-whm-ops-panel" id="whm-ops-firewall-panel-${kind}" role="tabpanel" aria-labelledby="whm-ops-firewall-tab-${kind}" data-whm-firewall-panel="${kind}" data-firewall-category="${kind}"><h3>${v.text(title)} <span class="xp-help">(${number})</span></h3>${body}${management}</section>`
  }).join('')
  const live = { ...v, readOnly: !canCreate }
  const createBody = `<fieldset><legend>${v.text(msgid('Action'))}</legend><div class="xp-whm-ops-actions">${([['accept', msgid('Allow')], ['drop', msgid('Drop')], ['reject', msgid('Reject')]] as const).map(([value, label]) => `<label class="xp-whm-ops-choice"><input type="radio" name="action" value="${value}"${canCreate ? ' required' : ' disabled data-wiring="soon"'}><span>${v.text(label)}</span></label>`).join('')}</div></fieldset><div class="xp-whm-ops-fields">${field(live, 'protocol', msgid('Protocol'), { enabled: canCreate, required: true, choices: [['tcp', 'TCP'], ['udp', 'UDP'], ['both', msgid('TCP and UDP')]] })}${field(live, 'port', msgid('Port or range'), { enabled: canCreate, required: true })}${field(live, 'source', msgid('Source'), { enabled: canCreate })}${field(live, 'position', msgid('Position'), { enabled: canCreate, value: 'end', choices: [['end', msgid('At the end')], ['top', msgid('At the top')]] })}${field(live, 'comment', msgid('Note'), { enabled: canCreate })}</div><p class="xp-help">${v.text(msgid('One port or a range such as 8000-8100. Leave source empty for any source.'))}</p>${actions(button(live, msgid('Cancel'), canCreate, 'reset') + button(live, msgid('Check and save'), canCreate, 'submit'))}<p class="xp-help" data-firewall-port-rule-status role="status"></p>`
  const create = canCreate ? `<form class="xp-whm-ops-groups" data-firewall-port-rule-form>${createBody}</form>` : `<div class="xp-whm-ops-groups" data-firewall-port-rule-unavailable>${createBody}</div>${status(v, msgid('Creating a port rule requires the explicitly qualified port-rule capability. No rule has been submitted.'))}`
  return card(v, 'firewall-rule-categories', msgid('Rules by type'), `<p class="xp-whm-ops-status" data-firewall-manage-status role="status"></p><p>${v.text(msgid('Open a category to review its saved rules. Rules are evaluated in stored order; the first match wins.'))}</p><div class="xp-whm-ops-groups" data-whm-firewall-tabs><div class="xp-whm-ops-tabs" role="tablist" aria-label="${v.text(msgid('Rule categories'))}">${kindName.map(([kind, title], index) => `<button type="button" class="xp-btn" role="tab" id="whm-ops-firewall-tab-${kind}" aria-controls="whm-ops-firewall-panel-${kind}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-whm-firewall-tab="${kind}" disabled>${v.text(title)}</button>`).join('')}</div>${categories}</div>${renderWhmFirewallClientTemplates()}`)
    + card(v, 'firewall-add-port', msgid('Add a port rule'), create)
    + card(v, 'firewall-import-export', msgid('Import and export'), `<div class="xp-whm-ops-fields">${field(v, 'firewall-import-file', msgid('JSON file'), { type: 'file' })}${field(v, 'firewall-import-json', msgid('JSON ruleset'), { type: 'textarea' })}</div>${actions(button(v, msgid('Import JSON'), false, 'button', 'data-firewall-action="import"') + button(v, msgid('Export JSON'), false, 'button', 'data-firewall-action="export"'))}`)
    + card(v, 'firewall-save-contract', msgid(msgctxt('approved-whm-operations-components', 'What a save does')), `<p>${v.text(msgid('The server checks proposed desired-state rules against the trusted session address and management ports. A stored rule and a reconcile request do not establish that the live firewall accepted or enforced the change.'))}</p>${status(v, msgid('Use the operation result and a live enforcement probe before reporting a port as opened or blocked. This view does not invent a generation number or activation receipt.'))}`)
}

function services(v: Context, props: WhmSurfaceProps): string {
  const query = new URLSearchParams({ lang: v.locale, theme: props.theme ?? 'dark', density: props.density ?? 'comfortable' }).toString()
  const optional = [
    ['ols', 'OpenLiteSpeed', msgid('Alternative engine for the whole server. Installing does not switch engines. Choose the engine in Web server; Apache handlers and lsphp have different compatibility requirements.'), 'openlitespeed · lsphp', '/whm/services/web', msgid('Engine settings')],
    ['modsecurity', msgid('ModSecurity with OWASP CRS'), msgid('Adds the OWASP Core Rule Set at the Nginx edge. Its installation and detection mode have not been read. The panel’s own request limits and deny lists are separate settings.'), 'libmodsecurity3 · modsecurity-crs', '/whm/security', msgid('WAF settings')],
  ] as const
  return card(v, 'services-restart-confirmation', msgid('Restart confirmation'), `<p>${v.text(msgid('Choose Restart beside a managed service to review its name and confirm before the request is sent. Cancel leaves its current state unchanged. A restart can interrupt every account using that service; a successful request alone does not prove that application connections recovered.'))}</p><h3>${v.text(msgid('Restart selected service?'))}</h3>${status(v, msgid('No service is selected in this confirmation preview. Use its Restart action in the managed-services table to open the real confirmation.'))}${actions(button(v, msgid('Cancel')) + button(v, msgid('Reload instead')) + button(v, msgid('Restart selected service')))}${status(v, msgid('The connected service action is restart. A separate reload endpoint is not connected, so reload is unavailable here. Optional installation never appears as a completed restart.'))}`)
    + card(v, 'services-optional', msgid('Optional services'), `<p>${v.text(msgid('Installation and activation are separate operations. Package inventory, installation progress and activation have not been read for these optional services.'))}</p><div class="xp-whm-ops-catalog">${optional.map(([key, title, description, packages, href, link]) => `<section aria-labelledby="whm-ops-optional-${key}"><h3 id="whm-ops-optional-${key}">${v.text(title)}</h3><p>${v.text(description)}</p><dl class="xp-whm-ops-fields"><div class="xp-whm-ops-field"><dt>${v.text(msgid('Installation state'))}</dt><dd>${v.text(notRead)}</dd></div><div class="xp-whm-ops-field"><dt>${v.text(msgid('Package family'))}</dt><dd>${renderLtrValue(packages).replace('<bdi dir="ltr"', '<bdi dir="ltr" style="overflow-wrap: anywhere"')}</dd></div></dl>${actions(`<a class="xp-btn" href="${escapeHtml(`${href}?${query}`)}">${v.text(link)}</a>` + button(v, key === 'ols' ? msgid('Install OpenLiteSpeed') : msgid('Install ModSecurity')))}${status(v, msgid('There is no connected package-install operation for this card. No installation has been requested or queued.'))}</section>`).join('')}</div>`)
}

/** Body-only supplement: native controllers remain the sole owners of their existing tables/actions. */
export function renderApprovedWhmOperationsSupplement(props: WhmSurfaceProps): string {
  const route = props.activeRoute
  if (route !== '/whm/security/firewall' && route !== '/whm/services') return ''
  const principal = props.visibility?.principal ?? props.principal
  const admitted = principal?.kind === 'root' && canOpenRegisteredRoute(route, { ...props.visibility, principal })
  const locale = props.locale ?? SOURCE_LOCALE
  const text = (copy: Copy): string => escapeHtml(translator(props.locale)(copy))
  if (!props.capabilityUnavailable && !admitted) return `<section class="xp-card" data-whm-ops-denied role="status"><p>${text(msgid('Root authorization is required for server operations.'))}</p></section>`
  const portCapability = qualified(props.catalog, 'aapanel-port-rules')
  const readOnly = props.capabilityUnavailable === true || !admitted
  const readable = !readOnly && (route === '/whm/security/firewall' ? portCapability : RESTART_TOOLS.some(id => qualified(props.catalog, id)))
  const v: Context = { locale, readOnly, text }
  return `${STYLE}<div class="xp-whm-ops" dir="${localeDirection(locale)}" data-approved-whm-operations="${route}" data-operation-state="${readOnly || !readable ? 'unavailable' : 'qualified'}">${route === '/whm/security/firewall' ? firewall(v, props, readable, !readOnly && portCapability) : services(v, props)}</div>`
}


/** UI-only tabs: viewing a rule category never calls or qualifies a host operation. */
export function bindWhmOperationsCategories(): void {
  document.querySelectorAll<HTMLElement>('[data-whm-firewall-tabs]').forEach(root => {
    if (root.dataset.whmTabsBound === 'true') return
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-whm-firewall-tab]'))
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-whm-firewall-panel]'))
    if (tabs.length !== 6 || panels.length !== tabs.length || tabs.some(tab => !panels.some(panel => panel.dataset.whmFirewallPanel === tab.dataset.whmFirewallTab))) return
    root.dataset.whmTabsBound = 'true'
    const pick = (tab: HTMLButtonElement, focus = false) => {
      tabs.forEach(item => { item.setAttribute('aria-selected', item === tab ? 'true' : 'false'); item.tabIndex = item === tab ? 0 : -1 })
      panels.forEach(panel => { panel.hidden = panel.dataset.whmFirewallPanel !== tab.dataset.whmFirewallTab })
      if (focus) tab.focus()
    }
    tabs.forEach((tab, index) => {
      tab.disabled = false
      tab.addEventListener('click', () => pick(tab))
      tab.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
        const rtl = root.closest('[dir]')?.getAttribute('dir') === 'rtl'
        let next: number | undefined
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = tabs.length - 1
        else if (event.key === 'ArrowRight') next = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length
        else if (event.key === 'ArrowLeft') next = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length
        if (next === undefined) return
        event.preventDefault()
        pick(tabs[next]!, true)
      })
    })
    pick(tabs.find(tab => tab.getAttribute('aria-selected') === 'true') ?? tabs[0]!)
  })
}

export const APPROVED_WHM_OPERATIONS_TABS_CLIENT = bindWhmOperationsCategories.toString()
