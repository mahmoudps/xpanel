import { dnsEditorTemplates } from '../../../client-templates/data-workspaces.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { card, statusPill } from '../../../components/index.ts'
import { escapeHtml } from '../../../html.ts'
import { renderV2DnssecCard } from './dnssec.ts'
import { listFilter, listFilterEmpty, missingServiceAccount, phoneLabels, serviceButton, serviceFacts, serviceField, serviceHeader, technical, type PanelServiceAuthority } from './common.ts'

/** Desired-state editor. Public DNS answers and mail delivery are separate observations. */
export function renderV2DnsPage(props: PanelSurfaceProps, authority: PanelServiceAuthority = { canManage: false }): string {
  const t = v2Messages.translator(props.locale ?? 'en')
  const readOnly = authority.presentation === 'read-only'
  const missing = readOnly ? undefined : missingServiceAccount(t, props)
  if (missing) return missing
  const principal = props.visibility?.principal
  const account = !readOnly || authority.canReadFacts === true && principal?.kind === 'user' && props.account?.id === principal.accountId ? props.account : undefined
  const domains = (account && (!readOnly || authority.authorizedTools?.has('domains')) ? props.domains ?? [] : []).filter(domain => domain.accountId === (account?.id ?? ''))
  const selected = domains.find(domain => domain.name === props.activeDomain)
    ?? domains.find(domain => domain.name === (account?.primaryDomain ?? '')) ?? domains[0]
  const canManage = !!account && !readOnly && authority.canManage && domains.length > 0
  const disabled = canManage ? '' : ' disabled'
  const zoneOptions = domains.map(domain => `<option value="${escapeHtml(domain.name)}"${domain.id === selected?.id ? ' selected' : ''}>${escapeHtml(domain.name)}</option>`).join('')
  // Board header: the zone picker and Add record. They stay inside the editor scope the controller reads.
  const zonePicker = `<div class="v2-panel-service__head-field"><label for="v2-dns-zone">${escapeHtml(t('Zone'))}</label><select id="v2-dns-zone" data-dns-zone dir="ltr"${disabled}>${zoneOptions}</select></div>`
  const heads = [t('Name'), t('Type'), 'TTL', t('Content'), t('Priority'), t('Actions')]
  // Board record filter: each record row names its type through the type select (data-list-field="type").
  const filter = listFilter(t, { id: 'v2-dns-filter', label: t(msgctxt('theme:v2', 'Filter records')), group: t('Record type'), key: 'type', open: canManage,
    options: [['', t('All')], ...['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map(type => [type, type] as const)] })
  const accountPicker = serviceField('v2-dns-account', t('Account'), `<select id="v2-dns-account" data-dns-account disabled><option value="${escapeHtml((account?.id ?? ''))}">${escapeHtml((account?.username ?? ''))}</option></select>`)
  const newZone = serviceField('v2-dns-new-name', t('New zone name'), `<input id="v2-dns-new-name" data-dns-new-name dir="ltr" type="text" autocomplete="off" disabled>`)
  const table = `<div class="v2-panel-service__table" tabindex="0" role="region" aria-label="${escapeHtml(t('DNS records'))}"><table class="v2-table"${phoneLabels(heads)}><thead><tr>${heads.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-dns-records><tr><td colspan="6">${escapeHtml(t('Zone records have not been read.'))}</td></tr></tbody></table></div>`
  const editor = card({
    title: t('Records and zone editor'), titleId: 'v2-dns-records-heading',
    description: t(msgctxt('theme:v2', 'Changes are saved as desired state. Saving does not prove public DNS propagation.')),
    hooks: { 'data-list-filter': true },
    bodyHtml: `${filter}${table}${listFilterEmpty(t('No records match the current filter.'))}<p data-dns-status data-state="unread" role="status">${escapeHtml(canManage ? t('Zone records have not been read.') : t('Zone editing is unavailable here. Saved zone records were not read and no change is possible.'))}</p><div class="v2-panel-service__actions">${serviceButton(t('Save zone'), { 'data-dns-save': true }, true, true)}${serviceButton(t('Delete zone'), { 'data-dns-delete': true }, true)}</div><fieldset><legend>${escapeHtml(t('Add zone'))}</legend><div class="v2-panel-service__fields">${accountPicker}${newZone}</div><div class="v2-panel-service__actions">${serviceButton(t('Add zone'), { 'data-dns-add-zone': true }, true)}</div></fieldset>${dnsEditorTemplates(message => escapeHtml(t(message)))}`,
  })
  const summary = card({
    title: selected?.name ?? t('Zone'), titleId: 'v2-dns-summary-heading',
    actionsHtml: statusPill({ tone: 'neutral', label: t(msgctxt('theme:v2', 'Serving state not read')) }),
    bodyHtml: serviceFacts([
      { label: t('Zone'), valueHtml: selected ? technical(selected.name) : escapeHtml(t('Not read')) },
      { label: t(msgctxt('theme:v2', 'Name servers')), valueHtml: escapeHtml(t('Not read')) },
      { label: t('Serial'), valueHtml: escapeHtml(t('Not read')) },
      { label: t(msgctxt('theme:v2', 'Last update')), valueHtml: escapeHtml(t('Not read')) },
    ]),
  })
  const delivery = card({
    title: t('Email deliverability'), titleId: 'v2-dns-delivery-heading',
    description: t(msgctxt('theme:v2', 'Public SPF, DKIM, DMARC and reverse DNS have not been checked by this page.')),
    bodyHtml: `<div class="v2-panel-service__fields">${['SPF', 'DKIM', 'DMARC'].map(label => `<div class="v2-panel-service__note"><h3>${label}</h3>${statusPill({ tone: 'neutral', label: t('Not observed') })}</div>`).join('')}</div>`,
  })
  const process = card({
    title: t('How a change is applied'), titleId: 'v2-dns-how-heading',
    bodyHtml: `<div class="v2-panel-service__note"><p>${escapeHtml(t(msgctxt('theme:v2', 'The saved desired state is checked and reconciled on the host. A refused request keeps the draft for review; an uncertain result is read back before another change.')))}</p><p>${escapeHtml(t(msgctxt('theme:v2', 'Resolvers can continue serving a cached answer until its TTL expires. Saving records does not confirm what public resolvers serve.')))}</p></div>`,
  })
  const reference = card({
    title: t(msgctxt('theme:v2', 'Record types')), titleId: 'v2-dns-types-heading',
    bodyHtml: `<div class="v2-panel-service__note"><p>${escapeHtml(t(msgctxt('theme:v2', 'A and AAAA point to addresses. CNAME points to another host name. MX and SRV include a priority; TXT and CAA store their record content.')))}</p><p>${escapeHtml(t(msgctxt('theme:v2', 'The row editor validates the name, type, content, TTL and priority before saving the zone.')))}</p></div>`,
  })
  return `<section class="v2-panel-service"${readOnly || !account ? ' data-readonly="true"' : ''} data-v2-panel-service="dns"><div class="v2-panel-service__editor" data-dns-editor${canManage ? '' : ' data-readonly="true"'}>${serviceHeader(t, '/domains/zone-editor', t('Zone editor'), t('Review records and check deliverability separately.'), { actionsHtml: zonePicker + serviceButton(t('Add record'), { 'data-dns-add-record': true }, true, true) })}${summary}${delivery}${editor}</div>${account ? renderV2DnssecCard(t, { zones: domains.map(domain => domain.name), ...(selected ? { selected: selected.name } : {}), connected: !readOnly && authority.qualifiedTools?.has('dnssec') === true }) : ''}<aside class="v2-panel-service__pair" aria-label="${escapeHtml(t('Workspace information'))}">${process}${reference}</aside></section>`
}
