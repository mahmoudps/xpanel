import { escapeHtml } from '../../../html.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { statusPill } from '../../../components/status-pill.ts'
import { formField } from '../../../components/form-field.ts'
import { hostButton, hostCard, hostContext, hostFacts, hostPage, hostTable, technical, type HostPageProps } from './common.ts'
import { renderV2WhmServiceClientTemplates } from './service-client-templates.ts'

const RESTART_TOOLS = ['restart-web', 'restart-mysql', 'restart-mta', 'restart-imap', 'restart-ftp', 'restart-dns']

/** Service health and actions are separate observations: a saved row never qualifies a restart. */
export function renderV2WhmServices(props: HostPageProps): string {
  const route = '/whm/services'
  const { t, readable } = hostContext(props, route)
  const observed = readable && props.services !== undefined
  const services = observed ? props.services! : []
  const checked = services.filter(service => service.checked !== false)
  const qualified = readable && RESTART_TOOLS.some(id => props.catalog?.some(tool => tool.id === id && tool.status === 'verified' && tool.delivery.status === 'verified'))
  const unread = t(msgid('Not read'))
  const summary = `<div class="v2-kpi-row">${[
    { label: t(msgctxt('theme:v2', 'Total services')), value: observed ? String(services.length) : unread, icon: 'services' as const },
    { label: t(msgid('Running')), value: observed ? String(checked.filter(service => service.active).length) : unread, icon: 'okCircle' as const },
    { label: t(msgid('Needs attention')), value: observed ? String(checked.filter(service => !service.active && service.installed !== false).length) : unread, icon: 'alert' as const },
    { label: t(msgctxt('theme:v2', 'Last check')), value: unread, icon: 'calendar' as const },
  ].map(item => kpiCard({ ...item, note: t(msgctxt('theme:v2', 'Only observed service state is shown.')) })).join('')}</div>`
  const rows = services.map(service => ({
    hooks: { 'data-service-row': service.name },
    cellsHtml: [
      `<div class="v2-cell-lead__text"><strong>${technical(service.name)}</strong><span>${technical(service.unit)}</span></div>`,
      escapeHtml(service.role),
      statusPill({ label: service.checked === false ? unread : service.installed === false ? t(msgid('Not installed')) : service.active ? t(msgid('Running')) : t(msgid('Stopped')), tone: service.checked === false || service.installed === false ? 'neutral' : service.active ? 'ok' : 'bad' }),
      technical(service.version || undefined, unread), escapeHtml(unread),
      service.checked === false ? escapeHtml(unread) : technical(`${service.rssMb} MB`),
    ],
  }))
  const health = hostCard('services', t(msgid('Managed services')), hostTable(t, 'service-health', t(msgid('Managed services')),
    [t(msgid('Service')), t(msgid('Role')), t(msgid('Status')), t(msgid('Version')), t(msgid('Uptime')), t(msgid('Memory'))], rows,
    observed ? t(msgid('No services were reported by the host.')) : t(msgid('Service state has not been read.'))),
  { 'data-section': 'service-health' }, `<a class="v2-btn" href="/whm/services/more?lang=${props.locale ?? 'en'}">${escapeHtml(t(msgid('Service manager')))}</a>`)
  const actions = hostCard('service-actions', t(msgctxt('theme:v2', 'Service actions')),
    `<div data-host-services>${hostTable(t, 'service-actions', t(msgctxt('theme:v2', 'Service actions')), [t(msgid('Service')), t(msgid('Unit')), t(msgid('Status')), t(msgid('Action'))], [], t(msgid('Service state has not been read.')), { 'data-host-service-rows': true })}<p data-host-service-status role="status"></p>${renderV2WhmServiceClientTemplates('host')}</div>`,
    { 'data-capability-unavailable': String(!qualified) })
  const detail = hostCard('service-evidence', t(msgctxt('theme:v2', 'Service details')),
    hostFacts([[msgid('Status'), unread], [msgid('Version'), unread], [msgid('Uptime'), unread], [msgid('Memory'), unread], [msgctxt('theme:v2', 'Enabled at boot'), unread], [msgctxt('theme:v2', 'Tested before reload'), unread]].map(([label, value]) => ({ label: t(label!), valueHtml: escapeHtml(value!) }))))
    + hostCard('service-impact', t(msgctxt('theme:v2', 'Restart impact')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'A restart can interrupt active connections. Review the selected service and confirm before the request is sent.')))}</p><p role="status">${escapeHtml(t(msgctxt('theme:v2', 'No service is selected.')))}</p>`)
    + hostCard('service-dependencies', t(msgctxt('theme:v2', 'Dependencies')), `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Service dependencies have not been read.')))}</p>`)
    + hostCard('service-log', t(msgctxt('theme:v2', 'Recent log')), `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Recent service log lines have not been read.')))}</p><a class="v2-btn" href="/whm/monitoring/logs?lang=${props.locale ?? 'en'}">${escapeHtml(t(msgid('Logs')))}</a>`)
  const optional = hostCard('optional-services', t(msgid('Optional services')), `<p>${escapeHtml(t(msgid('Installation and activation are separate operations. Package inventory, installation progress and activation have not been read for these optional services.')))}</p><div class="v2-host__fields">${[
    { title: 'OpenLiteSpeed', description: t(msgctxt('theme:v2', 'Alternative engine for the whole server. Installing does not switch engines.')), href: '/whm/services/web', label: t(msgid('Engine settings')) },
    { title: 'ModSecurity with OWASP CRS', description: t(msgctxt('theme:v2', 'Adds the OWASP Core Rule Set to the Nginx edge.')), href: '/whm/security/waf', label: t(msgid('WAF settings')) },
  ].map(item => `<section class="v2-host__groups"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p>${statusPill({ label: unread, tone: 'neutral' })}<div class="v2-host__actions"><a class="v2-btn" href="${item.href}?lang=${props.locale ?? 'en'}">${escapeHtml(item.label)}</a>${hostButton(t(msgid('Install')), undefined, { disabled: true })}</div></section>`).join('')}</div>`)
  return hostPage(props, route, t(msgid('Services')), t(msgid('Service versions, memory use and running status.')),
    `${summary}<div class="v2-host__split"><div class="v2-host__stack">${health}${actions}</div><aside class="v2-host__stack" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Service details')))}">${detail}</aside></div>${optional}`,
    { 'data-approved-whm-operations': route, 'data-operation-state': qualified ? 'qualified' : 'unavailable' })
}

/** Auxiliary host jobs retain their own admission flags and read-back lifecycle. */
export function renderV2WhmServiceManager(props: HostPageProps): string {
  const route = '/whm/services/more'
  const { t, readable } = hostContext(props, route)
  const fact = (key: string, label: string) => ({ label: t(label), valueHtml: escapeHtml(t(msgid('Not read'))), hooks: { 'data-sm-fact': key } })
  const manager = hostCard('service-manager', t(msgid('Service manager')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'Actions run as host jobs; the job must read back the result before it can confirm success.')))}</p>
<p data-sm-status data-state="unread" role="status">${escapeHtml(t(msgid('Service state has not been read.')))}</p><p data-sm-result role="status" hidden></p>
<p data-sm-job hidden><a href="/whm/jobs" data-sm-job-link>${escapeHtml(t(msgid('Review host jobs')))}</a></p>
${hostFacts([fact('services', msgid('Observed services')), fact('active', msgid('Active services')), fact('boot-time', msgid('Server boot time (UTC)')), fact('observed-at', msgid('Observed at (UTC)'))])}
<div class="v2-host__fields">${formField({ id: 'v2-sm-search', label: t(msgid('Search service units')), control: { kind: 'input', type: 'search', disabled: true, mono: true, dir: 'ltr', hooks: { 'data-sm-search': true } } })}
${formField({ id: 'v2-sm-state', label: t(msgid('Service state')), control: { kind: 'select', disabled: true, hooks: { 'data-sm-filter': true }, options: [{ value: '', label: t(msgid('All services')) }, { value: 'active', label: t(msgid('Active')) }, { value: 'attention', label: t(msgid('Needs attention')) }, { value: 'editable', label: t(msgid('Editable boot items')) }] } })}</div>
${hostTable(t, 'managed-units', t(msgid('Observed service units')), [t(msgid('Service unit')), t(msgid('Load state')), t(msgid('Active state')), t(msgid('Substate')), t(msgid('Start at boot')), t(msgid('Actions'))], [], t(msgid('No services have been read.')), { 'data-sm-rows': true })}
<p>${escapeHtml(t(msgctxt('theme:v2', 'Only reviewed auxiliary units allow boot changes. Panel, SSH, networking, web, database, mail and DNS services stay protected.')))}</p>`, undefined,
  hostButton(t(msgid('Read service state')), { 'data-sm-refresh': true }, { disabled: true }))
  const reboot = hostCard('service-reboot', t(msgid('Reboot server')), `<p>${escapeHtml(t(msgctxt('theme:v2', 'A reboot disconnects active sessions and stops hosted services temporarily. After reconnecting, read the server boot time to confirm that it changed.')))}</p>
<div class="v2-host__field"><label for="v2-sm-confirm">${escapeHtml(t(msgid('Type the confirmation phrase')))}: <bdi dir="ltr">REBOOT SERVER</bdi></label><input id="v2-sm-confirm" type="text" dir="ltr" autocomplete="off" spellcheck="false" maxlength="13" data-sm-confirm disabled></div>
<div class="v2-host__actions">${hostButton(t(msgid('Submit reboot job')), { 'data-sm-reboot': true }, { danger: true, disabled: true })}</div>`)
  return hostPage(props, route, t(msgid('Service manager')), t(msgctxt('theme:v2', 'Review observed system services and their start-at-boot state.')), `${manager}${reboot}${renderV2WhmServiceClientTemplates('manager')}`,
    { 'data-whm-service-manager': true, 'data-sm-can-read': String(readable), 'data-sm-can-manage': String(readable) })
}
