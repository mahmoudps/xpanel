import { allocated } from '../models/reseller-allocation.ts'
import { canOpenRegisteredRoute, type CatalogTool } from '@xpanel/catalog'
import { canSeeAccount, type ResellerAcl } from '@xpanel/core'
import { escapeHtml, renderLtrValue, renderStatusBadge, renderThresholdMeter } from '../tokens.ts'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { SOURCE_LOCALE, localeDirection, type MessageValues, translator } from '../i18n.ts'
const ACL_GROUPS: readonly { title: string; items: readonly (readonly [ResellerAcl, string])[] }[] = [
  { title: msgid('Accounts'), items: [['list-accounts', msgid('List accounts')], ['create-account', msgid('Create accounts')], ['edit-account', msgid('Modify accounts')], ['suspend-account', msgid('Suspend accounts')], ['terminate-account', msgid('Terminate accounts')], ['change-plan', msgid('Change plan')], ['change-password', msgid('Change passwords')]] },
  { title: msgid('Plans'), items: [['manage-plans', msgid('Manage plans')], ['manage-feature-lists', msgid('Feature lists')], ['allow-unlimited-plans', msgid('Allow unlimited plans')], ['allow-oversell', msgid('Allow overselling')]] },
  { title: msgid('Domains and transfers'), items: [['manage-dns', msgid('Manage DNS')], ['manage-ssl', msgid('Manage SSL/TLS')], ['transfer', msgid('Transfer accounts')]] },
]

const STYLES = `<style>
.xp-reseller-reference{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}
.xp-reseller-reference .xp-reseller-detail{display:flex;flex-direction:column;gap:var(--xp-space-section,32px);min-inline-size:0}
.xp-reseller-reference:has(.xp-reseller-detail:target,.xp-reseller-detail :target) .xp-reseller-detail:not(:target):not(:has(:target)),.xp-reseller-reference:not(:has(.xp-reseller-detail:target,.xp-reseller-detail :target)) .xp-reseller-detail:not([data-reseller-default]){display:none}
.xp-reseller-reference [data-reseller-viewing]{display:none}
.xp-reseller-reference .xp-reseller-header{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding:var(--xp-space-card,24px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface);min-inline-size:0}
.xp-reseller-reference .xp-reseller-header h2,.xp-reseller-reference h3,.xp-reseller-reference h4{margin:0}
.xp-reseller-reference .xp-reseller-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:var(--xp-space-field,16px);margin:0}
.xp-reseller-reference .xp-reseller-facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-reseller-reference .xp-reseller-facts dd{margin:0;overflow-wrap:anywhere}
.xp-reseller-reference .xp-reseller-form,.xp-reseller-reference .xp-reseller-groups{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);min-inline-size:0}
.xp-reseller-reference .xp-reseller-columns{display:grid;grid-template-columns:minmax(0,1.618fr) minmax(260px,1fr);align-items:start;gap:var(--xp-space-group,24px)}
.xp-reseller-reference .xp-reseller-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--xp-space-field,16px);min-inline-size:0}
.xp-reseller-reference .xp-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}
.xp-reseller-reference fieldset{margin:0;padding:0;border:0;min-inline-size:0}
.xp-reseller-reference legend{padding:0;margin-block-end:var(--xp-space-field,16px);font-weight:600}
.xp-reseller-reference .xp-reseller-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--xp-space-field,16px)}
.xp-reseller-reference .xp-reseller-choice{display:flex;align-items:center;gap:8px;min-block-size:44px}
.xp-reseller-reference .xp-reseller-group{display:flex;flex-direction:column;gap:var(--xp-space-group,24px);padding:var(--xp-space-card,24px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface)}
.xp-reseller-reference .xp-reseller-group p{margin:0}
.xp-reseller-reference .xp-reseller-technical{direction:ltr;text-align:start;unicode-bidi:plaintext;align-self:stretch}
.xp-reseller-reference[dir="rtl"] .xp-reseller-technical{text-align:right}
.xp-reseller-reference .xp-reseller-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--xp-space-field,16px)}
.xp-reseller-reference .xp-reseller-meter{display:flex;flex-direction:column;gap:8px}
.xp-reseller-reference .xp-reseller-ownership{display:flex;flex-direction:column;gap:var(--xp-space-field,16px);padding:var(--xp-space-field,16px);border:1px solid var(--xp-accent-border);border-radius:var(--xp-radius-md,12px);background:var(--xp-accent-soft);min-inline-size:0}
.xp-reseller-reference .xp-reseller-ownership__head{display:flex;flex-direction:column;gap:8px}
.xp-reseller-reference .xp-reseller-ownership p,.xp-reseller-reference .xp-reseller-savebar p{margin:0}
.xp-reseller-reference .xp-reseller-savebar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--xp-space-field,16px);padding:var(--xp-space-field,16px) var(--xp-space-card,24px);border:1px solid var(--xp-border);border-radius:var(--xp-radius-lg,12px);background:var(--xp-bg-surface)}
.xp-reseller-reference .xp-reseller-savebar>.xp-reseller-actions{justify-content:flex-end}
.xp-reseller-reference .xp-table th,.xp-reseller-reference .xp-table td{text-align:start}
@media(max-width:959px){.xp-reseller-reference .xp-reseller-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:639px){.xp-reseller-reference .xp-reseller-header,.xp-reseller-reference .xp-reseller-group,.xp-reseller-reference .xp-reseller-savebar{padding:var(--xp-space-field,16px)}}
.xp-reseller-reference .xp-field>label[for]{box-sizing:border-box;padding-inline-start:var(--xp-control-content-inset,13px)}
.xp-reseller-reference #whm-resellers{display:flex;flex-direction:column;gap:var(--xp-space-group,24px)}
.xp-reseller-reference #whm-resellers>.xp-card__header{margin-block-end:0}
.xp-reseller-reference #whm-resellers>[data-reseller-acl-matrix]{margin-block-start:0!important}
.xp-reseller-reference #whm-resellers .xp-card.xp-form-group{gap:var(--xp-space-group,24px)}
@media(min-width:601px){.xp-reseller-reference .xp-reseller-header,.xp-reseller-reference .xp-reseller-group{padding:var(--xp-space-card,24px)}}
</style>`

/** Stable, CSS-safe anchor for one reseller detail; independent of list order. Disallowed characters are hex-encoded so distinct ids stay distinct. */
export const resellerDetailAnchor = (id: string): string => 'whm-reseller-' + id.replace(/[^A-Za-z0-9-]/g, c => `_${c.codePointAt(0)!.toString(16)}_`)

const qualified = (catalog: readonly CatalogTool[] | undefined, id: string): boolean => catalog?.some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified') === true

/* Production document authentication and route qualification precede this renderer.
 * It also checks its own role and capability boundary to remain safe as a direct helper.
 * No prototype data or simulated operation result is used. */
export const renderApprovedWhmResellers = (props: WhmSurfaceProps, nativeHtml = ''): string => {
  const locale = props.locale ?? SOURCE_LOCALE
  const text = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const principal = props.visibility?.principal ?? props.principal
  const admitted = principal?.kind === 'root' && canOpenRegisteredRoute('/whm/resellers', { ...props.visibility, principal })
  const readOnly = props.capabilityUnavailable === true || !qualified(props.catalog, 'reseller-center')
  if (!readOnly && !admitted) return `<section class="xp-card" data-reseller-admission="denied"><h1>${text('Resellers')}</h1><p>${text('Root authorization is required for reseller administration.')}</p></section>`
  const readable = admitted && !readOnly
  const resellers = readable ? props.resellers : undefined
  const accounts = readable ? props.accounts : undefined
  const plans = readable ? props.plans : undefined
  const pool = readable ? props.ipPool : undefined
  const all = resellers?.length ? resellers : [undefined]
  const notRead = text('Not read')
  const value = (content: string | number | undefined): string => content === undefined ? `<span class="xp-help">${notRead}</span>` : escapeHtml(String(content))
  const fact = (label: string, content: string): string => `<div><dt class="xp-label">${label}</dt><dd>${content}</dd></div>`
  const status = (content: string): string => `<p class="xp-help" role="status">${content}</p>`
  const heading = (id: string, label: string): string => `<h3 id="${id}">${label}</h3>`
  const unavailable = (label: string): string => `<button class="xp-btn" type="button" disabled data-wiring="soon">${label}</button>`
  const html = all.map((reseller, index) => {
    const prefix = `whm-reseller-detail-${index}`
    const owned = reseller && accounts !== undefined ? accounts.filter(account => account.ownerId === reseller.id && principal && canSeeAccount(principal, account)) : undefined
    const ownPlans = reseller && plans !== undefined ? plans.filter(plan => plan.ownerId === reseller.id) : undefined
    const canEdit = readable && reseller !== undefined
    const canMove = canEdit && qualified(props.catalog, 'modify-account') && owned !== undefined && owned.length > 0
    const disabled = canEdit ? '' : ' disabled data-wiring="soon"'
    const limits = ([['maxAccounts', text('Maximum accounts'), reseller?.maxAccounts, owned?.length, text('accounts')], ['totalDiskMb', text('Total disk'), reseller?.totalDiskMb, allocated(owned, plans, 'diskMb'), 'MiB'], ['totalBandwidthMb', text('Total bandwidth per month'), reseller?.totalBandwidthMb, allocated(owned, plans, 'bandwidthMbMonth'), 'MiB']] as const).map(([name, label, limit, assigned, unit]) => {
      const unlimited = limit === 'unlimited'
      const numericDisabled = !canEdit || unlimited ? ' disabled' : ''
      return `<div class="xp-reseller-groups"><div class="xp-field"><label class="xp-label" for="${prefix}-${name}">${label} (${unit})</label><input class="xp-input xp-reseller-technical" id="${prefix}-${name}" name="${name}" type="number" min="0" step="1" inputmode="numeric" value="${typeof limit === 'number' ? escapeHtml(String(limit)) : ''}"${numericDisabled}${!canEdit ? ' data-wiring="soon"' : ''}${unlimited ? ` placeholder="${text('Unlimited')}"` : ''}/><label class="xp-reseller-choice" for="${prefix}-${name}-unlimited"><input type="checkbox" id="${prefix}-${name}-unlimited" name="${name}Unlimited" data-reseller-unlimited-field="${name}"${unlimited ? ' checked' : ''}${disabled}/>${text('Unlimited')}</label></div><div class="xp-reseller-meter">${renderThresholdMeter(typeof assigned === 'number' ? assigned : undefined, limit, { locale, unit, label: name === 'maxAccounts' ? text('Owned accounts') : text('Assigned plan limits'), configuredLimit: limit !== undefined })}${assigned === 'unlimited' ? status(text('Assigned plans include an unlimited allocation.')) : ''}</div>${name === 'maxAccounts' ? status(text('Creation is refused when the configured account cap is reached.')) : status(text('Allocated plan limits are shown above. Actual disk use and current-month traffic have not been read.'))}</div>`
    }).join('')
    const acl = ACL_GROUPS.map(group => `<fieldset><legend>${escapeHtml(text(group.title))}</legend><div class="xp-reseller-checks">${group.items.map(([key, label]) => `<label class="xp-reseller-choice" for="${prefix}-acl-${key}"><input type="checkbox" id="${prefix}-acl-${key}" name="acl" value="${key}"${reseller?.acl.includes(key) ? ' checked' : ''}${disabled}/><span>${escapeHtml(text(label))}</span></label>`).join('')}</div></fieldset>`).join('')
    const nameservers = `<div class="xp-field"><label class="xp-label" for="${prefix}-nameservers">${text('Nameservers, one per line')}</label><textarea class="xp-input xp-reseller-technical" id="${prefix}-nameservers" name="nameservers" rows="3"${disabled}>${escapeHtml(reseller?.nameservers.join('\n') ?? '')}</textarea></div>${status(text('Resolution has not been probed. Existing zones keep their current NS records; use DNS zones to change them.'))}`
    const assignedIps = reseller?.delegatedIps.map(address => {
      const assignedAccounts = owned?.filter(account => [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].includes(address))
      const knownPool = pool?.some(item => item.address === address)
      const assignment = assignedAccounts?.length ? assignedAccounts.map(account => account.username).join(', ') : knownPool && owned !== undefined ? text('No owned account assignment is recorded') : notRead
      return `<li>${renderLtrValue(address)}<span>${escapeHtml(assignment)}</span></li>`
    }).join('')
    const ips = `${reseller ? `<ul class="xp-reseller-groups" style="list-style:none;margin:0;padding:0">${assignedIps || `<li>${text('No delegated addresses are configured.')}</li>`}</ul>` : status(notRead)}<div class="xp-field"><label class="xp-label" for="${prefix}-delegatedIps">${text('Delegated IP addresses, one per line')}</label><textarea class="xp-input xp-reseller-technical" id="${prefix}-delegatedIps" name="delegatedIps" rows="3"${disabled}>${escapeHtml(reseller?.delegatedIps.join('\n') ?? '')}</textarea></div>${status(text('Saving validates existing account assignments. This list does not prove an address is routed or free on the host.'))}`
    const group = (key: string, label: string, content: string): string => `<section class="xp-reseller-group" aria-labelledby="${prefix}-${key}">${heading(`${prefix}-${key}`, label)}${content}</section>`
    const formOpen = canEdit ? `<form class="xp-reseller-form" data-reseller-update-form="true" data-reseller-id="${escapeHtml(reseller.id)}">` : '<div class="xp-reseller-form" data-reseller-editor="unavailable">'
    const formClose = canEdit ? '</form>' : '</div>'
    const edit = `${formOpen}<div class="xp-reseller-columns"><div class="xp-reseller-groups">${group('privileges', text('Privileges'), `<p>${text('Privileges are scoped to owned accounts. Server administration remains root-only.')}</p>${acl}${reseller ? '' : status(text('No privilege assignment has been read.'))}`)}${group('nameservers-heading', text('Nameservers'), nameservers)}${group('delegated-heading', text('Delegated IP addresses'), ips)}</div><div class="xp-reseller-groups">${group('limits', text('Capacity and usage'), limits)}${group('overselling', text('Overselling'), `<label class="xp-reseller-choice" for="${prefix}-oversell"><input type="checkbox" id="${prefix}-oversell" name="oversell"${reseller?.oversell ? ' checked' : ''}${disabled}/>${text('Allow overselling')}</label>${status(reseller ? reseller.oversell ? text('Overselling is configured on. Actual current resource usage has not been read; it cannot be inferred from plan allocations.') : text('Overselling is configured off. Assigned plan limits are constrained by the reseller totals when accounts or plans change.') : notRead)}`)}</div></div><div class="xp-reseller-savebar" data-reseller-savebar>${unavailable(text('Suspend reseller'))}<div class="xp-reseller-actions">${canEdit ? `<p class="xp-help" data-reseller-update-status role="status"></p><button type="reset" class="xp-btn">${text('Discard changes')}</button><button type="submit" class="xp-btn xp-btn--primary">${text('Save reseller')}</button>` : `${unavailable(text('Discard changes'))}${unavailable(text('Save reseller'))}`}</div></div>${formClose}`
    const tableRows = owned?.map(account => {
      const plan = plans?.find(item => item.id === account.planId)
      return `<tr><th scope="row">${renderLtrValue(account.username)}<span class="xp-help">${text('Linux UID')}: ${value(account.uid)}</span></th><td>${renderLtrValue(account.primaryDomain)}</td><td>${plan ? escapeHtml(plan.name) : notRead}</td><td>${plan ? plan.resources.diskMb === 'unlimited' ? text('Unlimited allocation') : `${value(plan.resources.diskMb)} MiB` : notRead}<span class="xp-help">${text('Actual use not read')}</span></td><td>${renderStatusBadge(account.status === 'active' ? 'ok' : 'suspended', escapeHtml(account.status === 'active' ? text('Active') : text('Suspended')))}</td></tr>`
    }).join('')
    const ownership = owned?.map(account => `<form class="xp-reseller-fields" data-reseller-owner-form="true" data-account-username="${escapeHtml(account.username)}"><div class="xp-field"><label class="xp-label" for="${prefix}-owner-${escapeHtml(account.username)}">${text('New owner of')} ${renderLtrValue(account.username)}</label><select class="xp-input" id="${prefix}-owner-${escapeHtml(account.username)}" name="ownerId"${canMove ? '' : ' disabled data-wiring="soon"'}><option value="">${text('Root')}</option>${resellers?.map(item => `<option value="${escapeHtml(item.id)}"${item.id === reseller?.id ? ' selected' : ''}>${escapeHtml(item.username)}</option>`).join('') ?? ''}</select></div><div class="xp-reseller-actions"><button type="submit" class="xp-btn"${canMove ? '' : ' disabled data-wiring="soon"'}>${text('Change owner')}</button><p class="xp-help" data-reseller-owner-status role="status"></p></div></form>`).join('')
    const ownerBody = canMove ? ownership : `<div class="xp-reseller-fields"><div class="xp-field"><label class="xp-label" for="${prefix}-owner-account">${text('Account')}</label><select id="${prefix}-owner-account" class="xp-input" disabled data-wiring="soon"><option>${text('Select an account')}</option>${owned?.map(account => `<option>${escapeHtml(account.username)}</option>`).join('') ?? ''}</select></div><div class="xp-field"><label class="xp-label" for="${prefix}-owner-target">${text('New owner')}</label><select id="${prefix}-owner-target" class="xp-input" disabled data-wiring="soon"><option>${text('Not qualified')}</option></select></div>${unavailable(text('Change owner'))}</div>`
    const ownershipSection = `<section class="xp-reseller-ownership" id="${prefix}-ownership" data-reseller-ownership aria-labelledby="${prefix}-ownership-heading"><div class="xp-reseller-ownership__head"><h4 id="${prefix}-ownership-heading">${text('Change ownership')}</h4><p class="xp-help">${text('Moves an account to another owner. Only who manages the account changes.')}</p></div>${ownerBody}${status(text('The server validates the destination capacity, plan access and current account configuration. No transfer has been performed by this view.'))}</section>`
    const ownerIcon = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h14l-3-3M20 16H6l3 3"></path></svg>'
    // The header control reaches the in-detail section; the selection CSS keeps this detail shown for that target.
    const ownerControl = canMove ? `<a class="xp-btn" href="#${prefix}-ownership">${ownerIcon}${text('Change ownership')}</a>` : `<button class="xp-btn" type="button" disabled data-wiring="soon">${ownerIcon}${text('Change ownership')}</button>`
    const accountList = group('owned', text('Owned accounts'), `<div class="xp-reseller-actions"><strong>${owned === undefined ? notRead : `${owned.length} ${text('accounts')}`}</strong>${readable ? `<a class="xp-btn" href="/whm/accounts">${text('Open in Accounts')}</a>` : ''}</div>${ownershipSection}<div class="xp-table-wrap"><table class="xp-table"><thead><tr>${[text('Account'), text('Domain'), text('Plan'), text('Disk allocation'), text('Status')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${tableRows || `<tr><td colspan="5">${owned === undefined ? notRead : text('No accounts are owned by this reseller.')}</td></tr>`}</tbody></table></div>`)
    return `<section class="xp-reseller-detail"${reseller ? ` id="${resellerDetailAnchor(reseller.id)}"` : ''} data-reseller-detail="${index}"${index === 0 ? ' data-reseller-default' : ''} aria-labelledby="${prefix}-heading"><header class="xp-reseller-header"><h2 id="${prefix}-heading">${reseller ? renderLtrValue(reseller.username) : text('Reseller details')}</h2><div class="xp-reseller-actions">${reseller ? renderStatusBadge(reseller.oversell ? 'warn' : 'ok', reseller.oversell ? text('Overselling on') : text('Overselling off')) : ''}<span class="xp-help">${text('Sign-in state not read')}</span>${ownerControl}</div><dl class="xp-reseller-facts">${fact(text('Contact'), notRead)}${fact(text(msgctxt('approved-whm-resellers', 'Created')), notRead)}${fact(text('Owns'), value(owned?.length))}${fact(text('Own plans'), ownPlans ? ownPlans.map(plan => escapeHtml(plan.name)).join(', ') || text('None') : notRead)}${fact(text(msgctxt('approved-whm-resellers', 'Last sign-in')), notRead)}</dl></header>${accountList}${edit}</section>`
  }).join('')
  // The native list's Open links select a detail through :target; detail 0 is the default selection.
  const selection = resellers?.length ? `<style>${resellers.map((item, index) => {
    const anchor = resellerDetailAnchor(item.id), scopes = [`.xp-reseller-reference:has(#${anchor}:target,#${anchor} :target)`, ...(index === 0 ? ['.xp-reseller-reference:not(:has(.xp-reseller-detail:target,.xp-reseller-detail :target))'] : [])]
    return `${scopes.map(scope => `${scope} [data-reseller-open="${anchor}"]`).join(',')}{display:none}${scopes.map(scope => `${scope} [data-reseller-viewing="${anchor}"]`).join(',')}{display:inline-flex}`
  }).join('')}</style>` : ''
  return `<div class="xp-reseller-reference" data-approved-whm-resellers="true" data-workspace-mode="${readable ? 'qualified' : 'read-only'}"${localeDirection(locale) === 'rtl' ? ' dir="rtl"' : ''}>${STYLES}${readable && nativeHtml ? nativeHtml : `<header><h1>${text('Resellers')}</h1><p class="xp-help">${resellers ? text('Select a reseller to review its accounts, privileges and limits.') : text('Reseller data has not been read. Unavailable actions are disabled.')}</p></header>`}${selection}${html}</div>`
}
