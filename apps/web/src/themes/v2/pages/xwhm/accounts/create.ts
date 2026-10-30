import type { SurfaceAuthority } from '../../../../../models/theme-surface.ts'
import type { Translate } from '../../../../../i18n.ts'
import { accountPlanPreviewModel } from '../../../../../models/account-list.ts'
import { canCreate, principalOf } from '../../../../../models/whm-account-access.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { formField } from '../../../components/form-field.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml } from '../../../html.ts'
import { factList } from '../../../layouts/common.ts'

const ltr = (value: string | number): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`
const json = (value: unknown): string => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')

function identity(t: Translate, enabled: boolean): string {
  return `<fieldset class="v2-whm-create__section" id="v2-create-identity"><legend>${escapeHtml(t(msgctxt('theme:v2', 'Identity and domain')))}</legend><div class="v2-fields"><div class="v2-field"><label for="new-acc-username">${escapeHtml(t('Username'))}</label><input id="new-acc-username" name="username" type="text" dir="ltr" required pattern="[a-z][a-z0-9]{0,15}" maxlength="16" autocomplete="off" autocapitalize="none" spellcheck="false"${enabled ? '' : ' disabled'}><span class="v2-field__help">${escapeHtml(t(msgctxt('theme:v2', 'Lowercase letters and digits, starting with a letter.')))}</span></div>${formField({ id: 'new-acc-domain', label: t('Primary domain'), help: t(msgctxt('theme:v2', 'A DNS zone and a mail domain are requested for this domain.')), control: { kind: 'input', name: 'primaryDomain', required: true, dir: 'ltr', disabled: !enabled } })}</div>${formField({ id: 'new-acc-contact', label: t('Contact email'), help: t(msgctxt('theme:v2', 'Use an address outside this account for quota, suspension and certificate notices.')), control: { kind: 'input', name: 'contactEmail', type: 'email', dir: 'ltr', autocomplete: 'email', disabled: !enabled } })}<div class="v2-field"><label for="new-acc-password">${escapeHtml(t('Password'))}</label><div class="v2-whm-create__password"><input id="new-acc-password" name="password" type="password" required minlength="8" autocomplete="new-password" aria-describedby="new-acc-password-help"${enabled ? '' : ' disabled'}><button type="button" class="v2-btn" data-account-toggle-password data-password-target="new-acc-password" aria-pressed="false" aria-controls="new-acc-password"${enabled ? '' : ' disabled'}>${escapeHtml(t('Reveal password'))}</button><button type="button" class="v2-btn" data-account-generate-password data-password-target="new-acc-password"${enabled ? '' : ' disabled'}>${escapeHtml(t('Generate password'))}</button></div><span id="new-acc-password-help" class="v2-field__help">${escapeHtml(t('At least 8 characters.'))}</span></div></fieldset>`
}

function planSection(t: Translate, props: WhmSurfaceProps, enabled: boolean): string {
  const principal = principalOf(props)
  const plans = principal ? props.plans?.filter(plan => principal.kind === 'root' || plan.ownerId === null || plan.ownerId === principal.id) : undefined
  const preview = principal ? accountPlanPreviewModel({ principal, activeReseller: props.activeReseller, accounts: props.accounts, plans, resellers: props.resellers }) : { plans: [] }
  const root = enabled && principal?.kind === 'root'
  const owners = root ? [{ id: '', username: 'root' }, ...(props.resellers ?? [])] : enabled && principal?.kind === 'reseller' ? [principal] : []
  const ownerChoices = owners.map((owner, index) => `<label class="v2-whm-create__choice"><input type="radio" name="ownerId" value="${escapeHtml(owner.id)}"${index === 0 ? ' checked' : ''}${enabled ? '' : ' disabled'}><span><strong>${ltr(owner.username)}</strong><small>${escapeHtml(t(owner.id === '' ? 'No reseller allocation cap' : 'The server checks this reseller’s capacity when submitted.'))}</small></span></label>`).join('')
  const cap = (value: number | 'unlimited' | undefined, unit = ''): string => value === undefined ? escapeHtml(t('Not read')) : value === 'unlimited' ? escapeHtml(t('Unlimited')) : ltr(`${value}${unit}`)
  const limitRows: readonly { label: string; read: (plan: NonNullable<WhmSurfaceProps['plans']>[number]) => string }[] = [
    { label: t('Disk'), read: plan => cap(plan.resources.diskMb, ' MiB') },
    { label: t('Bandwidth per month'), read: plan => cap(plan.resources.bandwidthMbMonth, ' MiB') },
    { label: t('CPU'), read: plan => cap(plan.resources.cpuPercent, '%') },
    { label: t('Memory'), read: plan => cap(plan.resources.memoryMb, ' MiB') },
    { label: t('Processes'), read: plan => cap(plan.resources.maxProcesses) },
    { label: t('Read bandwidth'), read: plan => cap(plan.resources.ioReadBps, ' B/s') },
    { label: t(msgctxt('theme:v2', 'Write bandwidth')), read: plan => cap(plan.resources.ioWriteBps, ' B/s') },
    { label: t(msgctxt('theme:v2', 'Read IOPS')), read: plan => cap(plan.resources.ioReadIops) },
    { label: t(msgctxt('theme:v2', 'Write IOPS')), read: plan => cap(plan.resources.ioWriteIops) },
    { label: t('Addon domains'), read: plan => cap(plan.caps.addonDomains) },
    { label: t('Subdomains'), read: plan => cap(plan.caps.subdomains) },
    { label: t('Mailboxes'), read: plan => cap(plan.caps.mailboxes) },
    { label: t('Databases'), read: plan => cap(plan.caps.databases) },
    { label: t('FTP accounts'), read: plan => cap(plan.caps.ftpAccounts) },
  ]
  const comparison = plans?.length ? `<div class="v2-table-scroll" role="region" aria-labelledby="v2-plan-comparison" tabindex="0"><table class="v2-table"><caption id="v2-plan-comparison">${escapeHtml(t(msgctxt('theme:v2', 'Configured plan limits')))}</caption><thead><tr><th scope="col">${escapeHtml(t('Limit'))}</th>${plans.map(plan => `<th scope="col">${escapeHtml(plan.name)}</th>`).join('')}</tr></thead><tbody>${limitRows.map(row => `<tr><th scope="row">${escapeHtml(row.label)}</th>${plans.map(plan => `<td>${row.read(plan)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Hosting plans have not been read.')))}</p>`
  return `<section class="v2-whm-create__section" id="v2-create-plan" aria-labelledby="v2-create-plan-heading"><h2 id="v2-create-plan-heading">${escapeHtml(t(msgctxt('theme:v2', 'Plan and resources')))}</h2>${formField({ id: 'new-acc-plan', label: t('Hosting plan'), control: { kind: 'select', name: 'planId', required: true, disabled: !enabled, options: (plans ?? []).map(plan => ({ value: plan.id, label: plan.name })) } })}${comparison}<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Configured limits are desired state. Their active host enforcement must be verified after apply.')))}</p><fieldset class="v2-whm-create__owners"><legend>${escapeHtml(t('Owner'))}</legend><div class="v2-whm-create__choices">${ownerChoices || `<label class="v2-whm-create__choice"><input type="radio" name="ownerId" value="" disabled><span>${escapeHtml(t('Owner unavailable'))}</span></label>`}</div></fieldset><section data-create-owner-capacity aria-labelledby="v2-create-owner-capacity"><h3 id="v2-create-owner-capacity">${escapeHtml(t('Owner after this account'))}</h3>${factList([{ label: t('Accounts after creation'), value: t('Candidate not read') }, { label: t('Assigned disk after creation'), value: t('Candidate not read') }, { label: t('Configured owner caps'), value: t('Candidate not read') }])}<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'The server checks the selected owner and rejects capacity violations when creating the account.')))}</p></section><section class="v2-stack" data-create-plan-preview aria-labelledby="v2-create-plan-preview-heading"><h3 id="v2-create-plan-preview-heading">${escapeHtml(t('Selected plan'))}</h3><script type="application/json" data-plan-preview-model>${json(preview)}</script><dl class="v2-whm-create__preview"><div><dt>${escapeHtml(t('Plan'))}</dt><dd data-preview-plan-name></dd></div>${(['disk', 'memory', 'cpu'] as const).map(key => `<div><dt>${escapeHtml(t(key === 'disk' ? 'Disk (MiB)' : key === 'memory' ? 'Memory (MiB)' : 'CPU (%)'))}</dt><dd><bdi dir="ltr" data-preview-plan-${key}></bdi></dd></div>`).join('')}</dl><p data-preview-plan-capacity role="status" aria-live="polite"></p></section></section>`
}

function network(t: Translate, enabled: boolean): string {
  return `<fieldset class="v2-whm-create__section" id="v2-create-network"><legend>${escapeHtml(t(msgctxt('theme:v2', 'Network and access')))}</legend><div class="v2-field"><label for="new-acc-ipv4">${escapeHtml(t('IPv4 assignment'))}</label><select id="new-acc-ipv4" name="ipAssignment" required aria-describedby="new-acc-ipv4-address new-acc-ipv4-status"${enabled ? '' : ' disabled'}><option value="shared">${escapeHtml(t('Default shared'))}</option><option value="dedicated:auto" disabled>${escapeHtml(t('Dedicated · Automatic'))}</option></select></div><div class="v2-field"><output data-account-ip-preview hidden><bdi id="new-acc-ipv4-address" dir="ltr" data-account-ip-address></bdi></output><p id="new-acc-ipv4-status" data-account-ip-status role="status" aria-live="polite">${escapeHtml(t(msgctxt('theme:v2', 'IP availability has not been read.')))}</p><button type="button" class="v2-btn" data-account-ip-refresh${enabled ? '' : ' disabled'}>${escapeHtml(t('Refresh IP availability'))}</button></div>${formField({ id: 'new-acc-ipv6', label: t('IPv6 address (optional)'), control: { kind: 'input', name: 'ipv6', dir: 'ltr', disabled: !enabled } })}<fieldset class="v2-whm-create__owners"><legend>${escapeHtml(t('Shell access'))}</legend><div class="v2-whm-create__choices">${([{ value: 'none', title: t('No shell'), text: t('Web, mail, databases and file access remain subject to the account’s plan.') }, { value: 'jailed', title: t('Jailed shell'), text: t('Requires a plan that permits a jailed shell. The server checks eligibility.') }] as const).map(item => `<label class="v2-whm-create__choice"><input type="radio" name="shell" value="${item.value}"${item.value === 'jailed' ? ' checked' : ''}${enabled ? '' : ' disabled'}><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.text)}</small></span></label>`).join('')}</div></fieldset></fieldset>`
}

function observations(t: Translate, props: WhmSurfaceProps): string {
  const createRoute = '/whm/accounts/new?' + new URLSearchParams({ lang: props.locale ?? 'en', theme: props.theme ?? 'dark', density: props.density ?? 'comfortable' }).toString()
  const steps = ['Reserve account identity and assign UID', 'Prepare private home and filesystem quotas', 'Prepare resource slice and plan limits', 'Prepare web virtual host and PHP handler', 'Prepare DNS zone and mail domain', 'Apply configuration and verify the target host']
  const progress = `<p data-account-creation-observation role="status">${escapeHtml(t(msgctxt('theme:v2', 'No account-creation operation has been observed.')))}</p><ol class="v2-whm-create__progress" data-account-creation-progress>${steps.map((label, index) => `<li data-account-creation-step="${index + 1}"><span>${escapeHtml(t(label))}</span><span class="v2-muted" data-account-creation-step-state>${escapeHtml(t('Not observed'))}</span></li>`).join('')}</ol><button type="button" class="v2-btn" data-account-create-another data-create-route="${escapeHtml(createRoute)}" disabled>${escapeHtml(t('Create another account'))}</button>`
  const artifacts = ['Linux user', 'Home', 'Slice', 'Apache vhost', 'Nginx server', 'PHP-FPM pool', 'DNS zone', 'Mail domain', 'Databases']
  return `<aside class="v2-whm-create__aside" data-approved-account-create-status aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Creation result')))}">${card({ title: t('Creation progress'), titleId: 'v2-whm-create-progress', bodyHtml: progress })}${card({ title: t('What will be created'), titleId: 'v2-whm-create-artifacts', bodyHtml: `<p>${escapeHtml(t(msgctxt('theme:v2', 'Expected components, not completed resources. The server allocates identities and paths.')))}</p>${factList(artifacts.map(label => ({ label: t(label), value: t('Not observed') })))}${['slice', 'apache', 'nginx'].map(key => formField({ id: `v2-create-config-${key}`, label: t(msgctxt('theme:v2', 'Configuration preview: {kind}'), { kind: key }), help: t(msgctxt('theme:v2', 'Candidate configuration has not been read.')), control: { kind: 'textarea', dir: 'ltr', mono: true, readonly: true, disabled: true, rows: 4 } })).join('')}` })}</aside>`
}

/** Native create-controller hooks are preserved; server allocation and results remain authoritative. */
export function renderV2WhmAccountCreate(t: Translate, props: WhmSurfaceProps, authority?: SurfaceAuthority): string {
  const enabled = canCreate(props) && (authority === undefined || authority.presentation === 'live' && authority.canManage)
  if (authority?.presentation === 'read-only' && (!authority.canReadFacts || !authority.authorizedTools.has('create-account'))) props = { ...props, plans: undefined, accounts: undefined, resellers: undefined }
  const principal = principalOf(props)
  const plans = principal ? props.plans?.filter(plan => principal.kind === 'root' || plan.ownerId === null || plan.ownerId === principal.id) : undefined
  const submit = enabled && plans !== undefined && plans.length > 0
  const anchors = [['identity', t(msgctxt('theme:v2', 'Identity and domain'))], ['plan', t(msgctxt('theme:v2', 'Plan and resources'))], ['network', t('Network')], ['review', t('Review')]] as const
  const review = `<section class="v2-whm-create__section" id="v2-create-review" aria-labelledby="v2-create-review-heading"><h2 id="v2-create-review-heading">${escapeHtml(t('Review'))}</h2><p>${escapeHtml(t(msgctxt('theme:v2', 'The server checks capacity, permissions, address availability and the submitted plan.')))}</p><p data-account-create-status role="status" aria-live="polite" tabindex="-1" hidden></p><div class="v2-whm-create__actions"><button type="reset" class="v2-btn"${enabled ? '' : ' disabled'}>${escapeHtml(t('Discard'))}</button><button type="submit" class="v2-btn v2-btn--primary"${submit ? '' : ' disabled'}>${escapeHtml(t('Create account'))}</button></div></section>`
  return `<div class="v2-layout v2-whm-create" data-accounts-workspace>${pageHeader(t, { breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t('Accounts'), href: '/whm/accounts' }, { label: t('Create account') }], route: '/whm/accounts/new', title: t('Create account'), description: t(msgctxt('theme:v2', 'The account gets its own UID, slice and quotas. Nothing is created until the server applies the request.')), status: { tone: 'neutral', label: t(msgctxt('theme:v2', 'Not created yet')) } })}<nav class="v2-whm-create__steps" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Create account progress')))}"><ol>${anchors.map(([key, label], index) => `<li><a href="#v2-create-${key}"><span class="v2-num">${index + 1}</span>${escapeHtml(label)}</a></li>`).join('')}</ol></nav>${!enabled ? `<p class="v2-muted" role="status">${escapeHtml(t(msgctxt('theme:v2', 'Account creation is not qualified for this host or caller.')))}</p>` : ''}<div class="v2-whm-create__columns"><form class="v2-whm-create__form" id="whm-create-account-drawer" method="post" action="/api/accounts" data-create-account-form>${identity(t, enabled)}${planSection(t, props, enabled)}${network(t, enabled)}${review}</form>${observations(t, props)}</div></div>`
}

export const WHM_ACCOUNT_CREATE_CSS = `.v2-whm-create__columns{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);align-items:start;gap:var(--space-3)}
.v2-whm-create__form,.v2-whm-create__aside{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-create__section{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--space-3);margin:0;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface);min-inline-size:0}
.v2-whm-create__section>legend{font-size:18px;font-weight:600;padding-inline:var(--space-1)}
.v2-whm-create__password,.v2-whm-create__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-create__password>input{flex:1 1 200px;min-inline-size:0}
.v2-whm-create__steps>ol{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));list-style:none;padding:0;margin:0;gap:var(--space-2)}
.v2-whm-create__steps a{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);color:var(--text)}
.v2-whm-create__steps a>span{display:grid;place-items:center;inline-size:28px;block-size:28px;border:1px solid var(--line-strong);border-radius:50%}
.v2-whm-create__choices,.v2-whm-create__preview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-create__owners{display:flex;flex-direction:column;gap:var(--space-2);padding:0;border:0;margin:0}
.v2-whm-create__owners>legend{padding-block-end:var(--space-1);font-weight:600}
.v2-whm-create__choice{display:flex;align-items:flex-start;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-whm-create__choice>input{flex:none;margin-block-start:3px}
.v2-whm-create__choice>span,.v2-whm-create__preview>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-create__choice small{color:var(--muted)}
.v2-whm-create__preview dd{margin:0;overflow-wrap:anywhere}
.v2-whm-create__progress{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding-inline-start:24px}
.v2-whm-create__progress>li{padding-inline-start:var(--space-1)}
.v2-whm-create__progress>li>span{display:block}
.v2-whm-create :is(td,th){text-align:start}
@media(max-width:1100px){.v2-whm-create__columns{grid-template-columns:1fr}}
@media(max-width:700px){.v2-whm-create__steps>ol{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-whm-create__section{padding:var(--space-2)}.v2-whm-create__choices,.v2-whm-create__preview{grid-template-columns:1fr}}
`
