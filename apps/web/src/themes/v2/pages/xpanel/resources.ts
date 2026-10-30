import type { SurfaceAuthority } from '../../../../models/theme-surface.ts'
import type { Limit } from '@xpanel/core'
import type { Translate } from '../../../../i18n.ts'
import { card, emptyState, kpiCard, notice, pageHeader, statusPill } from '../../components/index.ts'
import { escapeHtml } from '../../html.ts'
import { v2Messages } from '../../messages.ts'
import { panelBytes, panelCount, panelFact, panelHomeMeters, panelLimit, selectedPanelPlan, scopePrimaryPanelFacts, type PanelPageProps } from './home.ts'

interface LimitRow {
  group: 'slice' | 'account'
  name: string
  stored: string
  applied: string
  used: string
  state: 'measured' | 'unavailable' | 'unread' | 'unmeasured'
}

function limitRows(props: PanelPageProps, t: Translate): LimitRow[] {
  const plan = selectedPanelPlan(props)
  const unknown = t(props.usage === undefined ? msgctxt('resources-board', 'Not read') : msgid('Unavailable'))
  const unread = t(msgctxt('resources-board', 'Not read'))
  const measured = (value: unknown, bytes = false): string => {
    const reading = panelCount(value)
    return reading === undefined ? unknown : bytes ? panelBytes(reading) : String(reading)
  }
  const state = (value: unknown): LimitRow['state'] => panelCount(value) !== undefined ? 'measured' : props.usage === undefined ? 'unread' : 'unavailable'
  const row = (name: string, limit: Limit | undefined, unit: string, value?: unknown, bytes = false): LimitRow => ({
    group: 'slice', name: t(name), stored: panelLimit(limit, t, unit), applied: unread, used: measured(value, bytes), state: state(value),
  })
  const bandwidth = row(msgid('Monthly bandwidth'), plan?.resources.bandwidthMbMonth, 'MiB', props.usage?.bandwidthMonth?.totalBytes, true)
  if (panelCount(props.usage?.bandwidthMonth?.totalBytes) === undefined) {
    bandwidth.used = t('Not measured')
    bandwidth.state = 'unmeasured'
  }
  const rows = [
    row(msgid('Disk space'), plan?.resources.diskMb, 'MiB', props.usage?.diskBytes, true),
    bandwidth,
    row(msgid('Disk read rate'), plan?.resources.ioReadBps, 'B/s'),
    row(msgid('Disk write rate'), plan?.resources.ioWriteBps, 'B/s'),
    row(msgctxt('theme:v2', 'Read IOPS'), plan?.resources.ioReadIops, 'IOPS'),
    row(msgctxt('theme:v2', 'Write IOPS'), plan?.resources.ioWriteIops, 'IOPS'),
    row(msgid('Memory'), plan?.resources.memoryMb, 'MiB', props.usage?.memoryBytes, true),
    row(msgid('Processes'), plan?.resources.maxProcesses, '', props.usage?.processCount),
    row(msgid('CPU'), plan?.resources.cpuPercent, '%'),
  ]
  const account = props.account
  const domains = account ? props.domains?.filter(domain => domain.accountId === account.id && domain.kind === 'addon') : undefined
  const mailboxes = account ? props.serviceUsers?.filter(user => user.accountId === account.id && user.services.email) : undefined
  const databases = account ? props.databases?.filter(database => database.accountId === account.id && database.trashedAt === null) : undefined
  const accountRows = [row(msgid('Addon domains'), plan?.caps.addonDomains, '', domains?.length),
    row(msgid('Mailboxes'), plan?.caps.mailboxes, '', mailboxes?.length),
    row(msgid('MariaDB databases'), plan?.caps.databases, '', databases?.filter(database => database.engine === 'mariadb').length)]
  return [...rows, ...accountRows.map(item => ({ ...item, group: 'account' as const }))]
}

function limitsTable(rows: readonly LimitRow[], t: Translate): string {
  const rowHtml = (row: LimitRow): string => `<tr data-resource-state="${row.state}"><th scope="row">${escapeHtml(row.name)}</th><td><bdi dir="ltr">${escapeHtml(row.stored)}</bdi></td><td>${escapeHtml(row.applied)}</td><td>${statusPill({
    tone: row.state === 'measured' ? 'info' : 'neutral',
    label: t(row.state === 'measured' ? msgid('Measured') : row.state === 'unread' ? msgctxt('resources-board', 'Not read') : row.state === 'unmeasured' ? msgid('Not measured') : msgid('Unavailable')),
  })}</td><td><bdi dir="ltr" data-resource-value>${escapeHtml(row.used)}</bdi></td></tr>`
  const groups = [
    { key: 'slice' as const, label: t(msgctxt('theme:v2', 'Slice limits')) },
    { key: 'account' as const, label: t(msgctxt('theme:v2', 'Account quotas')) },
  ]
  const headings = [t('Resource'), t('Stored plan limit'), t(msgctxt('theme:v2', 'Applied limit')), t('State'), t('Current reading')]
  return `<div class="v2-table-scroll" role="region" aria-labelledby="v2-resource-limits-caption" tabindex="0"><table id="v2-resource-limits" class="v2-table v2-resource-limits"><caption class="v2-sr" id="v2-resource-limits-caption">${escapeHtml(t(msgctxt('theme:v2', 'Plan, applied limit and usage')))}</caption><thead><tr>${headings.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead>${groups.map(group => `<tbody><tr class="v2-resource-limit-group"><th scope="rowgroup" colspan="5">${escapeHtml(group.label)}</th></tr>${rows.filter(row => row.group === group.key).map(rowHtml).join('')}</tbody>`).join('')}</table></div>`
}

const unavailablePanel = (title: string, titleId: string, text: string): string =>
  card({ title, titleId, bodyHtml: `<p class="v2-muted" role="status">${escapeHtml(text)}</p>` })

function observations(props: PanelPageProps, t: Translate): string {
  const verification = t(props.usage?.ioEnforced === true ? msgid('Verified for this sample')
    : props.usage?.ioEnforced === false ? msgid('Observed mismatch') : msgctxt('resources-board', 'Not read'))
  return card({ title: t('Resource readings'), titleId: 'v2-resource-reading-title',
    description: t('Stored plan limits are desired configuration. Readings and IO verification are separate observations; no process or service readings are invented.'),
    bodyHtml: `<dl class="v2-panel-facts">${panelFact(t('Plan'), selectedPanelPlan(props)?.name ?? t(msgctxt('resources-board', 'Not read')))}${panelFact(t('Reading state'), t(props.usage === undefined ? msgctxt('resources-board', 'Not read') : msgid('Account usage sample')))}${panelFact(t('Observed at'), t('Not reported by the agent'))}${panelFact(t('IO cap verification'), verification)}</dl>`,
  })
}

/** Read-only resources: saved limits remain visible even when host observations are missing. */
export function renderV2PanelResources(props: PanelPageProps, authority?: SurfaceAuthority): string {
  const t = v2Messages.translator(props.locale ?? 'en')
  props = scopePrimaryPanelFacts(props, authority)
  const account = props.account
  const plan = selectedPanelPlan(props)
  const meters = panelHomeMeters(props, t)
  const unavailable = t('Unavailable')
  const kpis = [
    { label: t('CPU'), value: '—', unit: panelLimit(plan?.resources.cpuPercent, t, '%'), icon: 'cpu' as const, note: t('Not reported by the agent') },
    { label: t('Memory'), value: panelCount(props.usage?.memoryBytes) === undefined ? '—' : panelBytes(props.usage!.memoryBytes!), icon: 'memory' as const, note: meters[3]!.valueText },
    { label: t('Disk'), value: panelCount(props.usage?.diskBytes) === undefined ? '—' : panelBytes(props.usage!.diskBytes!), icon: 'disk' as const, note: meters[0]!.valueText },
    { label: t('Processes'), value: panelCount(props.usage?.processCount) === undefined ? '—' : String(props.usage!.processCount), icon: 'activity' as const, note: meters[4]!.valueText },
    { label: t('Disk write rate'), value: '—', unit: panelLimit(plan?.resources.ioWriteBps, t, 'B/s'), icon: 'activity' as const, note: t('Not reported by the agent') },
  ]
  const rows = limitRows(props, t)
  const limitTable = card({ title: t(msgctxt('theme:v2', 'Plan, applied limit and usage')), titleId: 'v2-resource-limits-title', flush: true,
    description: t(msgctxt('theme:v2', 'Applied values need host readback. A saved plan or an IO verification flag does not establish each applied limit.')),
    bodyHtml: limitsTable(rows, t),
  })
  const missingHistory = t(msgctxt('theme:v2', 'No account history was supplied. No samples or peak values are inferred from a current reading.'))
  const missingProcesses = t(msgctxt('theme:v2', 'An account process list was not supplied. The task count does not identify processes or grant a process action.'))
  return `<div class="v2-layout v2-panel-resources" ${account ? `data-account="${escapeHtml(account.id)}" data-uid="${account.uid}"` : ''} data-resource-reading="${props.usage === undefined ? 'unread' : 'read'}">
${pageHeader(t, { breadcrumb: [{ label: t('Home'), href: '/home' }, { label: t('Resources & quotas') }], route: '/resources', title: t('Resources & quotas'),
    description: t('What this plan allows, what this host applies to the slice, and what is in use right now.'),
    actionsHtml: `<button type="button" class="v2-btn" disabled data-wiring="soon" aria-describedby="v2-resource-refresh-note">${escapeHtml(t('Refresh'))}</button>` })}
${notice(t, { tone: 'info', text: t(msgctxt('theme:v2', 'This is the supplied account sample. Refresh and detailed host observations require an available reader.')), hooks: { 'data-resource-refresh-note': true } })}
${props.usage?.bandwidthMonth?.limited === true ? notice(t, { tone: 'warn', lead: t('Limit page served'), text: t(msgctxt('theme:v2', 'The account is over its enforced monthly bandwidth limit.')) }) : ''}
<p class="v2-sr" id="v2-resource-refresh-note">${escapeHtml(t(msgctxt('theme:v2', 'An on-demand account resource reader is unavailable.')))}</p>
<section class="v2-kpi-row" aria-label="${escapeHtml(t('Resource usage'))}">${kpis.map(kpi => kpiCard({ headingLevel: 2, ...kpi })).join('')}</section>
${observations(props, t)}
<div class="v2-resource-charts">${unavailablePanel(t(msgctxt('theme:v2', 'CPU usage')), 'v2-resource-cpu-title', missingHistory)}${unavailablePanel(t(msgctxt('theme:v2', 'Memory usage')), 'v2-resource-memory-title', missingHistory)}</div>
${limitTable}
<div class="v2-resource-charts">${unavailablePanel(t(msgctxt('theme:v2', 'Disk IO history')), 'v2-resource-io-title', missingHistory)}${unavailablePanel(t(msgctxt('theme:v2', 'Limit events')), 'v2-resource-events-title', t(msgctxt('theme:v2', 'No account limit-event counters or history were supplied.')))}</div>
${card({ title: t(msgctxt('theme:v2', 'Site service configuration')), titleId: 'v2-resource-service-title', bodyHtml: `<dl class="v2-panel-facts">${panelFact(t('Primary domain'), account?.primaryDomain ?? t('Not read'), true)}${panelFact(t('Isolation slice'), account ? `xpanel-${account.uid}.slice` : t('Not read'), true)}${panelFact(t('Default PHP'), props.usage?.phpVersion ?? t('Not reported by the agent'), true)}${panelFact(t('State'), unavailable)}</dl><p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'A service-unit readback was not supplied. The saved configuration does not establish a running worker or its unit file.')))}</p>` })}
${unavailablePanel(t(msgctxt('theme:v2', 'Processes in your slice')), 'v2-resource-processes-title', missingProcesses)}
${unavailablePanel(t(msgctxt('theme:v2', 'Disk usage by folder')), 'v2-resource-folders-title', t(msgctxt('theme:v2', 'No directory-size observation was supplied. A file listing is not a recursive quota measurement.')))}
</div>`
}

export const V2_PANEL_RESOURCES_CSS = `.v2-resource-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:stretch}
.v2-resource-charts>.v2-card{min-block-size:180px}
.v2-panel-resources .v2-table td{overflow-wrap:anywhere}.v2-panel-resources .v2-table bdi{display:inline;unicode-bidi:isolate}
.v2-resource-limits{min-inline-size:980px}.v2-resource-limits tbody th[scope=row]{padding:14px 16px;padding-inline-start:var(--v2-panel-padding);border-block-start:1px solid var(--line);background:transparent;color:var(--text);font-size:14px;font-weight:600;white-space:normal}
.v2-resource-limits .v2-resource-limit-group th{padding:12px var(--v2-panel-padding);border-block-start:1px solid var(--line);background:var(--subtle);color:var(--text-2)}
@media(max-width:800px){.v2-resource-charts{grid-template-columns:minmax(0,1fr)}}
`
