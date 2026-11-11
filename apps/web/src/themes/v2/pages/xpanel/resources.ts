import { projectConfiguredAccountSlice, type SurfaceAuthority } from '../../../../models/theme-surface.ts'
import type { Limit } from '@xpanel/core'
import type { Translate } from '../../../../i18n.ts'
import { card, kpiCard, notice, pageHeader, statusPill } from '../../components/index.ts'
import { escapeHtml } from '../../html.ts'
import { formatAsciiBytes } from '../../../../display-format.ts'
import { v2Messages } from '../../messages.ts'
import { panelCount, panelFact, panelHomeMeters, panelLimit, panelMib, panelRate, selectedPanelPlan, scopePrimaryPanelFacts, type PanelPageProps } from './home.ts'

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
    return reading === undefined ? unknown : bytes ? formatAsciiBytes(reading) : String(reading)
  }
  const state = (value: unknown): LimitRow['state'] => panelCount(value) !== undefined ? 'measured' : props.usage === undefined ? 'unread' : 'unavailable'
  const row = (name: string, limit: Limit | undefined, unit: string, value?: unknown, bytes = false): LimitRow => ({
    group: 'slice', name: t(name), stored: unit === 'MiB' ? panelMib(limit, t) : unit === 'B/s' ? panelRate(limit, t) : panelLimit(limit, t, unit), applied: unread, used: measured(value, bytes), state: state(value),
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
  const headings = [t('Resource'), t('Stored plan limit'), t(msgctxt('theme:v2', 'Applied limit')), t('State'), t('Current reading')]
  const rowHtml = (row: LimitRow): string => `<tr data-resource-state="${row.state}"><th scope="row">${escapeHtml(row.name)}</th><td data-label="${escapeHtml(headings[1]!)}"><bdi dir="ltr">${escapeHtml(row.stored)}</bdi></td><td data-label="${escapeHtml(headings[2]!)}">${escapeHtml(row.applied)}</td><td>${statusPill({
    tone: row.state === 'measured' ? 'info' : 'neutral',
    label: t(row.state === 'measured' ? msgid('Measured') : row.state === 'unread' ? msgctxt('resources-board', 'Not read') : row.state === 'unmeasured' ? msgid('Not measured') : msgid('Unavailable')),
  })}</td><td><bdi dir="ltr" data-resource-value>${escapeHtml(row.used)}</bdi></td></tr>`
  const groups = [
    { key: 'slice' as const, label: t(msgctxt('theme:v2', 'Slice limits')) },
    { key: 'account' as const, label: t(msgctxt('theme:v2', 'Account quotas')) },
  ]
  return `<div class="v2-table-scroll" role="region" aria-labelledby="v2-resource-limits-caption" tabindex="0"><table id="v2-resource-limits" class="v2-table v2-resource-limits"><caption class="v2-sr" id="v2-resource-limits-caption">${escapeHtml(t(msgctxt('theme:v2', 'Plan, applied limit and usage')))}</caption><thead><tr>${headings.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead>${groups.map(group => `<tbody><tr class="v2-resource-limit-group"><th scope="rowgroup" colspan="5">${escapeHtml(group.label)}</th></tr>${rows.filter(row => row.group === group.key).map(rowHtml).join('')}</tbody>`).join('')}</table></div>`
}

const resourceFacts = (items: readonly (readonly [string, string, boolean?])[]): string => `<dl class="v2-resource-stats">${items.map(([label, value, technical]) => panelFact(label, value, technical === true)).join('')}</dl>`
function unreadTable(titleId: string, headings: readonly string[], message: string): string {
  return `<div class="v2-table-scroll" role="region" tabindex="0" aria-labelledby="${titleId}"><table class="v2-table v2-resource-observation-table"><thead><tr>${headings.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody><tr data-resource-observation="unread"><td colspan="${headings.length}"><p role="status">${escapeHtml(message)}</p></td></tr></tbody></table></div>`
}
function historyPanel(t: Translate, title: string, titleId: string, message: string, current: string, configured: string): string {
  const unread = t(msgctxt('resources-board', 'Not read'))
  return card({ title, titleId, bodyHtml: `<div class="v2-resource-plot" data-resource-observation="unread"><p role="status">${escapeHtml(message)}</p></div>`
    + resourceFacts([[t(msgctxt('resources-board', 'Average')), unread], [t(msgctxt('resources-board', 'Peak')), unread], [t('Current reading'), current, /^[0-9]/.test(current)], [t('Stored plan limit'), configured, /^[0-9]/.test(configured)]]) })
}

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
  const configuredSlice = projectConfiguredAccountSlice(account)
  const plan = selectedPanelPlan(props)
  const meters = panelHomeMeters(props, t)
  const unavailable = t('Unavailable')
  const kpis = [
    { label: t('CPU'), value: '—', unit: panelLimit(plan?.resources.cpuPercent, t, '%'), icon: 'cpu' as const, note: t('Not reported by the agent') },
    { label: t('Memory'), value: panelCount(props.usage?.memoryBytes) === undefined ? '—' : formatAsciiBytes(props.usage!.memoryBytes!), icon: 'memory' as const, note: meters[3]!.valueText },
    { label: t('Disk'), value: panelCount(props.usage?.diskBytes) === undefined ? '—' : formatAsciiBytes(props.usage!.diskBytes!), icon: 'disk' as const, note: meters[0]!.valueText },
    { label: t('Processes'), value: panelCount(props.usage?.processCount) === undefined ? '—' : String(props.usage!.processCount), icon: 'activity' as const, note: meters[4]!.valueText },
    { label: t('Disk write rate'), value: '—', unit: panelRate(plan?.resources.ioWriteBps, t), icon: 'activity' as const, note: t('Not reported by the agent') },
  ]
  const rows = limitRows(props, t)
  const limitTable = card({ title: t(msgctxt('theme:v2', 'Plan, applied limit and usage')), titleId: 'v2-resource-limits-title', flush: true,
    description: t(msgctxt('theme:v2', 'Applied values need host readback. A saved plan or an IO verification flag does not establish each applied limit.')),
    bodyHtml: limitsTable(rows, t),
  })
  const missingHistory = t(msgctxt('theme:v2', 'No account history was supplied. No samples or peak values are inferred from a current reading.'))
  const missingProcesses = t(msgctxt('theme:v2', 'An account process list was not supplied. The task count does not identify processes or grant a process action.'))
  const unread = t(msgctxt('resources-board', 'Not read'))
  const slice = card({ title: t(msgctxt('resources-board', 'Account isolation slice')), titleId: 'v2-resource-slice-title', bodyHtml: `<p class="v2-muted">${escapeHtml(t(msgctxt('resources-board', 'Stored configuration is not a running-unit or applied-limit observation.')))}</p><dl class="v2-panel-facts">${panelFact(t(msgctxt('resources-board', 'Configured isolation slice')), configuredSlice ?? unread, !!account)}${panelFact(t(msgctxt('resources-board', 'Observed unit state')), unread)}</dl><details class="v2-resource-unit"><summary>${escapeHtml(t(msgctxt('resources-board', 'Service unit details')))}</summary><pre class="v2-resource-code-unread">${escapeHtml(t(msgctxt('resources-board', 'Unit file has not been read.')))}</pre></details>` })
  const history = `<div class="v2-resource-charts">${historyPanel(t, t(msgctxt('theme:v2', 'CPU usage')), 'v2-resource-cpu-title', missingHistory, unread, panelLimit(plan?.resources.cpuPercent, t, '%'))}${historyPanel(t, t(msgctxt('theme:v2', 'Memory usage')), 'v2-resource-memory-title', missingHistory, panelCount(props.usage?.memoryBytes) === undefined ? unread : formatAsciiBytes(props.usage!.memoryBytes!), panelMib(plan?.resources.memoryMb, t))}</div>`
  const io = card({ title: t(msgctxt('theme:v2', 'Disk IO history')), titleId: 'v2-resource-io-title', bodyHtml: `<div class="v2-resource-ranges" role="group" aria-label="${escapeHtml(t(msgctxt('resources-board', 'IO direction')))}"><button type="button" class="v2-btn" aria-pressed="false" disabled>${escapeHtml(t('Read'))}</button><button type="button" class="v2-btn" aria-pressed="true" disabled>${escapeHtml(t('Write'))}</button></div><div class="v2-resource-plot" data-resource-observation="unread"><p role="status">${escapeHtml(missingHistory)}</p></div>` + resourceFacts([[t(msgctxt('resources-board', 'Average')), unread], [t(msgctxt('resources-board', 'Peak')), unread], [t(msgctxt('resources-board', 'Configured read cap')), panelRate(plan?.resources.ioReadBps, t), typeof plan?.resources.ioReadBps === 'number'], [t(msgctxt('resources-board', 'Configured write cap')), panelRate(plan?.resources.ioWriteBps, t), typeof plan?.resources.ioWriteBps === 'number']]) })
  const events = card({ title: t(msgctxt('theme:v2', 'Limit events')), titleId: 'v2-resource-events-title', bodyHtml: `<p class="v2-muted">${escapeHtml(t(msgctxt('resources-board', 'Event counters and their observation times have not been read.')))}</p><ol class="v2-resource-list" data-resource-observation="unread">${[msgctxt('resources-board', 'Memory events'), msgctxt('resources-board', 'Process limit events'), msgctxt('resources-board', 'IO throttling'), msgctxt('resources-board', 'Bandwidth limit events')].map(label => `<li><strong>${escapeHtml(t(label))}</strong>${resourceFacts([[t('State'), unread], [t(msgctxt('resources-board', 'Last observed')), unread]])}</li>`).join('')}</ol>` })
  const service = card({ title: t(msgctxt('theme:v2', 'Site service configuration')), titleId: 'v2-resource-service-title', bodyHtml: `<dl class="v2-panel-facts">${panelFact(t('Primary domain'), account?.primaryDomain ?? t('Not read'), true)}${panelFact(t(msgctxt('resources-board', 'Configured isolation slice')), configuredSlice ?? t('Not read'), true)}${panelFact(t('Default PHP'), props.usage?.phpVersion ?? t('Not reported by the agent'), !!props.usage?.phpVersion)}${panelFact(t('State'), unavailable)}</dl><p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'A service-unit readback was not supplied. The saved configuration does not establish a running worker or its unit file.')))}</p><ol class="v2-resource-list" aria-label="${escapeHtml(t(msgctxt('resources-board', 'Request path')))}" data-resource-observation="unread">${[msgctxt('resources-board', 'Web proxy'), msgctxt('resources-board', 'Account web worker'), msgctxt('resources-board', 'PHP worker')].map(label => `<li><strong>${escapeHtml(t(label))}</strong><span>${escapeHtml(unread)}</span></li>`).join('')}</ol><h3>${escapeHtml(t(msgctxt('resources-board', 'Virtual host')))}</h3><pre class="v2-resource-code-unread">${escapeHtml(t(msgctxt('resources-board', 'Virtual-host configuration has not been read.')))}</pre>` + resourceFacts([[t(msgctxt('resources-board', 'Runtime identity')), unread], [t(msgctxt('resources-board', 'Home permissions')), unread], [t(msgctxt('resources-board', 'Private temporary directory')), unread], [t(msgctxt('resources-board', 'Database access')), unread]]) })
  const processes = card({ title: t(msgctxt('theme:v2', 'Processes in your slice')), titleId: 'v2-resource-processes-title', bodyHtml: `<p class="v2-muted">${escapeHtml(missingProcesses)}</p>` + unreadTable('v2-resource-processes-title', [t(msgctxt('resources-board', 'Command and unit')), 'PID', t('User'), t('CPU'), t('Memory'), t('Started (UTC)')], unread) })
  const folders = card({ title: t(msgctxt('theme:v2', 'Disk usage by folder')), titleId: 'v2-resource-folders-title', actionsHtml: `<a class="v2-btn" href="/files/manager">${escapeHtml(t('File manager'))}</a>`, bodyHtml: `<p class="v2-muted" id="v2-resource-folder-navigation-note">${escapeHtml(t(msgctxt('resources-board', 'Use the authorized workspace navigation to open the file manager.')))}</p>` + unreadTable('v2-resource-folders-title', [t('Path'), t('Size'), t('Share')], t(msgctxt('theme:v2', 'No directory-size observation was supplied. A file listing is not a recursive quota measurement.'))) })
  return `<div class="v2-layout v2-panel-resources" ${account ? `data-account="${escapeHtml(account.id)}" data-uid="${account.uid}"` : ''} data-resource-reading="${props.usage === undefined ? 'unread' : 'read'}">
${pageHeader(t, { breadcrumb: [{ label: t('Home'), href: '/home' }, { label: t('Resources & quotas') }], route: '/resources', title: t('Resources & quotas'),
    description: t('What this plan allows, what this host applies to the slice, and what is in use right now.') })}
${notice(t, { tone: 'info', text: t(msgctxt('theme:v2', 'This is the supplied account sample. Refresh and detailed host observations require an available reader.')), hooks: { 'data-resource-refresh-note': true } })}
${props.usage?.bandwidthMonth?.limited === true ? notice(t, { tone: 'warn', lead: t('Limit page served'), text: t(msgctxt('theme:v2', 'The account is over its enforced monthly bandwidth limit.')) }) : ''}
<p class="v2-sr" id="v2-resource-refresh-note">${escapeHtml(t(msgctxt('theme:v2', 'An on-demand account resource reader is unavailable.')))}</p>
<section class="v2-kpi-row" aria-label="${escapeHtml(t('Resource usage'))}">${kpis.map(kpi => kpiCard({ headingLevel: 2, ...kpi })).join('')}</section>
<div class="v2-resource-pair">${observations(props, t)}${slice}</div>
${history}${limitTable}
<div class="v2-resource-workspace"><div class="v2-resource-main">${io}${events}</div><aside class="v2-resource-service">${service}</aside></div>
${processes}${folders}
</div>`
}

export const V2_PANEL_RESOURCES_CSS = `.v2-panel-resources>.v2-kpi-row{grid-template-columns:repeat(5,minmax(0,1fr))}
.v2-panel-resources .v2-kpi__value>:first-child{font-size:26px}.v2-panel-resources .v2-kpi__unit{overflow-wrap:anywhere}
.v2-panel-resources .v2-resource-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:stretch;min-inline-size:0}
.v2-panel-resources .v2-panel-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr));gap:var(--space-2);margin:0;min-inline-size:0}
.v2-panel-resources .v2-panel-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-panel-resources .v2-panel-facts dt,.v2-panel-resources .v2-resource-stats dt{text-box-trim:trim-end;text-box-edge:text}
.v2-panel-resources .v2-panel-facts dd,.v2-panel-resources .v2-resource-stats dd{text-box-trim:trim-start;text-box-edge:text}
.v2-panel-resources .v2-panel-facts dt{font-size:12px;color:var(--muted)}.v2-panel-resources .v2-panel-facts dd{margin:0;font-size:13px;min-inline-size:0;overflow-wrap:anywhere;text-align:start}
.v2-panel-resources .v2-card h3{font-size:14px}.v2-panel-resources .v2-card p.v2-muted{font-size:13px;line-height:1.6}
.v2-resource-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);align-items:stretch}
.v2-resource-charts>.v2-card{min-block-size:180px}
.v2-panel-resources .v2-resource-workspace{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-panel-resources .v2-resource-main{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-panel-resources .v2-resource-service{min-inline-size:0}
.v2-panel-resources .v2-resource-ranges{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-panel-resources .v2-resource-plot{display:grid;align-content:center;justify-items:center;gap:var(--space-2);min-block-size:140px;padding:var(--space-3);border:1px dashed var(--line-strong);border-radius:var(--radius-control);background:var(--subtle);color:var(--muted);font-size:13px;line-height:1.6;text-align:center}
.v2-panel-resources .v2-resource-plot>p{max-inline-size:52ch}
.v2-panel-resources .v2-resource-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);margin:0}
.v2-panel-resources .v2-resource-stats>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start;overflow-wrap:anywhere}
.v2-panel-resources .v2-resource-stats dt{font-size:12px;color:var(--muted)}.v2-panel-resources .v2-resource-stats dd{margin:0;text-align:start;overflow-wrap:anywhere}
.v2-panel-resources .v2-resource-list{display:grid;gap:var(--space-2);list-style:none;margin:0;padding:0}
.v2-panel-resources .v2-resource-list{gap:0}.v2-panel-resources .v2-resource-list>li{display:grid;gap:var(--space-1);padding-block:12px;border-block-start:1px solid var(--line);font-size:13px}
.v2-panel-resources .v2-resource-list>li>span{color:var(--muted)}
.v2-panel-resources ol.v2-resource-list[aria-label]>li{grid-template-columns:minmax(0,1fr) auto;align-items:baseline}
.v2-panel-resources .v2-resource-unit{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-panel-resources .v2-resource-unit>summary{min-block-size:var(--target);align-content:center;cursor:pointer;font-weight:600}
.v2-panel-resources .v2-resource-code-unread{margin:0;color:var(--muted);font-size:13px;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle);font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-panel-resources .v2-resource-observation-table{min-inline-size:640px}
@media(max-width:1100px){.v2-panel-resources .v2-resource-workspace{grid-template-columns:minmax(0,1fr)}}
.v2-panel-resources .v2-table td{overflow-wrap:anywhere}.v2-panel-resources .v2-table bdi{display:inline;unicode-bidi:isolate}
.v2-resource-limits{min-inline-size:760px}.v2-resource-limits td{font-size:13px}
.v2-resource-limits .v2-resource-limit-group th{padding:12px var(--v2-panel-padding);border-block-start:1px solid var(--line);background:var(--subtle);color:var(--text-2)}
@media(min-width:1101px) and (max-width:1440px){.v2-panel-resources .v2-kpi__value>:first-child{font-size:22px;white-space:nowrap}}
@media(max-width:1100px){.v2-panel-resources>.v2-kpi-row{grid-template-columns:repeat(6,minmax(0,1fr))}.v2-panel-resources>.v2-kpi-row>*{grid-column:span 2}.v2-panel-resources>.v2-kpi-row>:nth-child(n+4){grid-column:span 3}}
@media(max-width:800px){.v2-resource-charts,.v2-panel-resources .v2-resource-pair{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-resources>.v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-panel-resources>.v2-kpi-row>*,.v2-panel-resources>.v2-kpi-row>:nth-child(n+4){grid-column:auto}.v2-panel-resources>.v2-kpi-row>:last-child:nth-child(odd){grid-column:1/-1}
.v2-resource-limits{display:block;min-inline-size:0}.v2-resource-limits thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}.v2-resource-limits tbody{display:block}
.v2-resource-limits .v2-resource-limit-group,.v2-resource-limits .v2-resource-limit-group>th{display:block}
.v2-resource-limits tr[data-resource-state]{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:12px var(--v2-panel-padding);border-block-start:1px solid var(--line);border-block-end:0}
.v2-resource-limits tr[data-resource-state]>:is(th,td){display:block;padding:0;border:0}
.v2-resource-limits tr[data-resource-state]>td:last-child{grid-area:1/2;justify-self:end;font-weight:600}
.v2-resource-limits tr[data-resource-state]>th{grid-area:1/1}.v2-resource-limits tr[data-resource-state]>td[data-label]{grid-column:1;grid-row:auto;justify-self:start;text-align:start;font-size:12px;color:var(--muted)}.v2-resource-limits td[data-label]::before{content:attr(data-label) ": "}
.v2-resource-limits tr[data-resource-state]>td:nth-child(4){grid-area:2/2/span 2;justify-self:end}}
`
