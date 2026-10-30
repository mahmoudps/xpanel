import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { Translate } from '../../../../../i18n.ts'
import { auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../../../../../audit-labels.ts'
import { formatDisplayDateTime } from '../../../../../display-format.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { kpiCard, type KpiCardProps } from '../../../components/kpi-card.ts'
import { notice } from '../../../components/notice.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { statusPill } from '../../../components/status-pill.ts'
import { dataTable } from '../../../components/data-table.ts'
import { factList } from '../../../layouts/common.ts'
import { escapeHtml, type Tone } from '../../../html.ts'

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0
const integer = (value: number | undefined): value is number => finite(value) && Number.isSafeInteger(value)
const number = (value: number): string => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)
const bytes = (value: number): string => `${number(value / 1024 ** 3)} GiB`
const ltr = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

/** A presentation of the supplied host sample. An absent observation is never a healthy zero. */
function resources(t: Translate, props: WhmSurfaceProps): string {
  const host = props.hostSample
  const missing = t('Not read')
  const cpu = finite(host?.load1) && integer(host?.cores) && host.cores > 0
    ? { value: number(host.load1), note: t(msgctxt('theme:v2', 'Load {load} on {cores} cores'), { load: number(host.load1), cores: host.cores }) }
    : { value: '—', note: missing }
  const memory = host?.memory
  const validMemory = memory && finite(memory.totalBytes) && memory.totalBytes > 0 && finite(memory.availableBytes) && memory.availableBytes <= memory.totalBytes
  const disk = host?.disk
  const validDisk = disk && finite(disk.totalBytes) && disk.totalBytes > 0 && finite(disk.usedBytes) && disk.usedBytes <= disk.totalBytes
  const inodes = host?.inodes
  const validInodes = inodes && integer(inodes.total) && inodes.total > 0 && integer(inodes.used) && inodes.used <= inodes.total
  const items: KpiCardProps[] = [
    { label: t(msgctxt('theme:v2', 'CPU load')), icon: 'cpu', value: cpu.value, note: cpu.note },
    { label: t('Memory'), icon: 'memory', value: validMemory ? bytes(memory.totalBytes - memory.availableBytes) : '—',
      ...(validMemory ? { unit: `/ ${bytes(memory.totalBytes)}`, meter: { percent: 100 * (memory.totalBytes - memory.availableBytes) / memory.totalBytes } } : {}),
      note: validMemory ? t(msgctxt('theme:v2', '{value} available'), { value: bytes(memory.availableBytes) }) : missing },
    { label: disk ? t('Disk on {mount}', { mount: disk.mount }) : t('Disk'), icon: 'disk', value: validDisk ? bytes(disk.usedBytes) : '—',
      ...(validDisk ? { unit: `/ ${bytes(disk.totalBytes)}`, meter: { percent: 100 * disk.usedBytes / disk.totalBytes } } : {}), note: missing },
    { label: inodes ? t('Inodes on {mount}', { mount: inodes.mount }) : t(msgctxt('theme:v2', 'Inodes')), icon: 'files', value: validInodes ? number(inodes.used) : '—',
      ...(validInodes ? { unit: `/ ${number(inodes.total)}`, meter: { percent: 100 * inodes.used / inodes.total } } : {}), note: missing },
  ]
  return `<section class="v2-kpi-row" aria-label="${escapeHtml(t('Server resources'))}">${items.map(item => kpiCard({ ...item, headingLevel: 2 })).join('')}</section>`
}

function reconciler(t: Translate, props: WhmSurfaceProps): string {
  const gen = integer(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const knownDrift = integer(props.driftCount ?? undefined)
  const check = (value: { ok: boolean; at: string } | undefined): string => value ? t(value.ok ? 'Passed' : 'Failed') : t('Not read')
  const facts = [
    { label: t('Active generation'), value: gen === undefined ? t('Not read') : String(gen), mono: true },
    { label: 'nginx -t', value: check(props.hostSample?.nginxTest), mono: true },
    { label: 'apachectl configtest', value: check(props.hostSample?.apacheTest), mono: true },
    { label: t('Rollback target'), value: integer(props.rollbackGenerationId) ? String(props.rollbackGenerationId) : t('Not read'), mono: true },
    { label: t(msgctxt('theme:v2', 'Last drift check')), value: props.driftCheckedAt || t('Not read'), mono: true },
  ]
  const state = !knownDrift ? { tone: 'neutral' as const, label: t('Not read') }
    : props.driftCount === 0 && gen !== undefined ? { tone: 'ok' as const, label: t('In sync') }
      : { tone: 'warn' as const, label: t('Review required') }
  return card({ title: t('Reconciler'), titleId: 'v2-whm-reconciler', actionsHtml: statusPill(state),
    bodyHtml: `<p>${escapeHtml(t(msgctxt('theme:v2', 'Changes are applied as tested configuration generations.')))}</p><div class="v2-whm-overview__reconcile"><span>${escapeHtml(t('Drift'))}</span>${ltr(knownDrift ? String(props.driftCount) : '—')}</div>${factList(facts)}<p class="v2-muted" role="status">${escapeHtml(knownDrift ? t(msgctxt('theme:v2', 'This is the last supplied observation.')) : t(msgctxt('theme:v2', 'The applied state has not been read.')))}</p>`,
    footerHtml: canOpenRegisteredRoute('/whm/audit', props.visibility) ? `<a href="/whm/audit">${escapeHtml(t(msgctxt('theme:v2', 'View generations')))}</a>` : undefined,
  })
}

function services(t: Translate, props: WhmSurfaceProps): string {
  const rows = props.services?.map(service => {
    const tone: Tone = service.checked === false || service.installed === false ? 'neutral' : service.active ? 'ok' : 'bad'
    const state = service.checked === false ? t('Not checked') : service.installed === false ? t('Not installed') : service.active ? t('Running') : t('Stopped')
    return `<li class="v2-whm-overview__service"><span><strong>${ltr(service.name)}</strong><span class="v2-mono v2-muted">${ltr(service.version)}</span></span>${statusPill({ tone, label: state })}</li>`
  })
  return card({ title: t('Services'), titleId: 'v2-whm-services', flush: true,
    actionsHtml: canOpenRegisteredRoute('/whm/services', props.visibility) ? `<a href="/whm/services">${escapeHtml(t('Manage services'))}</a>` : undefined,
    bodyHtml: rows?.length ? `<ul class="v2-whm-overview__services">${rows.join('')}</ul>` : `<p class="v2-inset" role="status">${escapeHtml(props.services === undefined ? t(msgctxt('theme:v2', 'Service status has not been read.')) : t('No services were reported.'))}</p>`,
  })
}

function hostFacts(t: Translate, props: WhmSurfaceProps): string {
  const sample = props.hostSample
  const missing = t('Not read')
  return card({ title: t(msgctxt('theme:v2', 'Host facts')), titleId: 'v2-whm-host-facts', bodyHtml: factList([
    { label: t('Host'), value: sample?.hostname || props.hostname || missing, mono: true },
    { label: t('System'), value: sample?.system || missing },
    { label: t('Kernel'), value: sample?.kernel || missing, mono: true },
    { label: t('Uptime'), value: finite(sample?.uptimeSeconds) ? t(msgctxt('theme:v2', '{value} seconds'), { value: number(sample.uptimeSeconds) }) : missing },
    { label: t('CPU'), value: sample?.cpuModel || missing },
    { label: t('Engine'), value: sample?.engine || missing, mono: true },
    { label: 'xPanel', value: sample?.panelVersion || props.version || missing, mono: true },
  ]) })
}

function auditEvents(t: Translate, props: WhmSurfaceProps): string {
  const rows = props.auditEntries?.slice(0, 8).map(entry => {
    const clock = formatDisplayDateTime(entry.at)
    const time = clock === '—' ? clock : `<time datetime="${escapeHtml(entry.at)}">${ltr(clock)}</time>`
    const actor = auditActorLabel(entry.actor)
    const target = auditTargetLabel(entry.target, t.locale)
    return { cellsHtml: [time, actor ? ltr(actor) : '—', escapeHtml(auditActionLabel(entry.action, t.locale, entry)), target ? ltr(target) : '—', statusPill({ tone: entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'bad', label: auditOutcomeLabel(entry.action, entry.outcome, t.locale) })] }
  })
  const bodyHtml = rows === undefined ? `<p class="v2-inset" role="status">${escapeHtml(t('Not read'))}</p>`
    : dataTable(t, { id: 'v2-whm-audit-table', caption: t(msgctxt('theme:v2', 'Recent audit events')), columns: [t('Time'), t('Actor'), t(msgctxt('xwhm', 'Action')), t('Target'), t('Result')].map(label => ({ label })), rows, emptyText: t('No audit entries yet') })
  return card({ title: t(msgctxt('theme:v2', 'Recent audit events')), titleId: 'v2-whm-recent-audit', flush: true, bodyHtml,
    footerHtml: `<a href="/whm/audit">${escapeHtml(t('Audit log'))}</a>`,
  })
}

/** Body renderer; the surface owner supplies the v2 shell and core document slots once. */
export function renderV2WhmOverview(t: Translate, props: WhmSurfaceProps): string {
  const principal = props.visibility?.principal ?? props.principal
  if (!principal || principal.kind === 'user' || props.capabilityUnavailable) return notice(t, { tone: 'warn', lead: t('Unavailable'), text: t(msgctxt('theme:v2', 'The server overview is unavailable for this caller.')) })
  const open = (route: string): boolean => canOpenRegisteredRoute(route, props.visibility)
  const actions = `${open('/whm/audit') ? `<a class="v2-btn" href="/whm/audit">${escapeHtml(t('Audit log'))}</a>` : ''}${open('/whm/accounts/new') ? `<a class="v2-btn v2-btn--primary" href="/whm/accounts/new">${escapeHtml(t('Create account'))}</a>` : ''}`
  const missingHistory = card({ title: t(msgctxt('theme:v2', 'CPU and memory, last 24 hours')), titleId: 'v2-whm-history',
    actionsHtml: `<div class="v2-whm-overview__ranges" role="group" aria-label="${escapeHtml(t('Time range'))}">${['1h', '24h', '7d'].map(range => `<button class="v2-btn" type="button" disabled aria-pressed="${range === '24h'}">${range}</button>`).join('')}</div>`,
    bodyHtml: `<div class="v2-whm-overview__chart" role="status">${escapeHtml(t('Performance history has not been read.'))}</div>`,
    footerHtml: open('/whm/monitoring/performance') ? `<a href="/whm/monitoring/performance">${escapeHtml(t('Performance history'))}</a>` : undefined,
  })
  const near = props.nearLimits
  const nearLimits = card({ title: t(msgctxt('theme:v2', 'Accounts near a limit')), titleId: 'v2-whm-near-limits',
    bodyHtml: near?.length ? `<ul class="v2-whm-overview__services">${near.map(item => `<li><strong>${ltr(item.name)}</strong><p>${escapeHtml(item.note)}</p></li>`).join('')}</ul>`
      : `<p role="status">${escapeHtml(near === undefined ? t(msgctxt('theme:v2', 'Account usage has not been read.')) : t(msgctxt('theme:v2', 'No accounts are near a limit in the supplied observation.')))}</p>`,
  })
  const jobs = card({ title: t(msgctxt('theme:v2', 'Background jobs')), titleId: 'v2-whm-background-jobs',
    bodyHtml: `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Background jobs have not been read.')))}</p>`,
    footerHtml: open('/whm/jobs') ? `<a href="/whm/jobs">${escapeHtml(t(msgctxt('theme:v2', 'View jobs')))}</a>` : undefined,
  })
  const audit = open('/whm/audit') ? auditEvents(t, props) : ''
  return `<div class="v2-layout v2-whm-overview" data-whm-overview>${pageHeader(t, { breadcrumb: [{ label: t('Home') }, { label: t('Dashboard') }], route: '/whm', title: t('Server dashboard'), description: t(msgctxt('theme:v2', 'The reconciler, accounts, resources and services.')), actionsHtml: actions })}${resources(t, props)}<div class="v2-whm-overview__primary">${missingHistory}${reconciler(t, props)}</div><div class="v2-whm-overview__secondary">${open('/whm/services') ? services(t, props) : ''}<div class="v2-stack">${open('/whm/accounts') ? nearLimits : ''}${jobs}</div></div><div class="v2-whm-overview__primary">${audit}${hostFacts(t, props)}</div></div>`
}

export const WHM_OVERVIEW_CSS = `.v2-whm-overview__primary{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:var(--space-3)}
.v2-whm-overview__secondary{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:var(--space-3)}
.v2-whm-overview__ranges{display:flex;gap:var(--space-1)}
.v2-whm-overview__chart{min-block-size:220px;display:grid;place-items:center;padding:var(--space-3);border:1px dashed var(--line);border-radius:var(--radius-control);color:var(--muted);text-align:center}
.v2-whm-overview__reconcile{display:flex;justify-content:space-between;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-whm-overview__services{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.v2-whm-overview__services>li{padding:var(--space-2) var(--space-3);border-block-end:1px solid var(--line)}
.v2-whm-overview__services>li:last-child{border-block-end:0}
.v2-whm-overview__service{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}
.v2-whm-overview__service>span:first-child{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;overflow-wrap:anywhere}
@media(max-width:1050px){.v2-whm-overview__primary,.v2-whm-overview__secondary{grid-template-columns:1fr}}
@media(max-width:600px){.v2-whm-overview__services>li{padding:var(--space-2)}}
`
