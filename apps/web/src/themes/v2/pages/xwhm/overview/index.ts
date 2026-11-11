import { renderV2WhmHome } from '../accounts/admin.ts'
import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { Translate } from '../../../../../i18n.ts'
import { auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../../../../../audit-labels.ts'
import { formatDisplayDateTime } from '../../../../../display-format.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { lineChart, type LineSeries } from '../../../components/chart.ts'
import { kpiCard, type KpiCardProps } from '../../../components/kpi-card.ts'
import { notice } from '../../../components/notice.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { emptyState } from '../../../components/state-block.ts'
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
      ...(validDisk ? { unit: `/ ${bytes(disk.totalBytes)}`, meter: { percent: 100 * disk.usedBytes / disk.totalBytes } } : { note: missing }) },
    { label: inodes ? t('Inodes on {mount}', { mount: inodes.mount }) : t(msgctxt('theme:v2', 'Inodes')), icon: 'files', value: validInodes ? number(inodes.used) : '—',
      ...(validInodes ? { unit: `/ ${number(inodes.total)}`, meter: { percent: 100 * inodes.used / inodes.total } } : { note: missing }) },
  ]
  return `<section class="v2-kpi-row" aria-label="${escapeHtml(t('Server resources'))}">${items.map(item => kpiCard({ ...item, headingLevel: 2 })).join('')}</section>`
}

/** Stored samples at their bucket positions; missing intervals leave gaps, and the description says how many were read. */
function history(t: Translate, props: WhmSurfaceProps): string {
  const data = props.performanceHistory
  const sample = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value) && value >= 0
  const totalBytes = props.hostSample?.memory?.totalBytes
  const totalMb = finite(totalBytes) && totalBytes > 0 ? totalBytes / 1024 ** 2 : undefined
  const count = data ? Math.max(data.cpuPercent.length, totalMb === undefined ? 0 : data.memoryMb.length) : 0
  const cpuBuckets = Array.from({ length: count }, (_, index) => {
    const value = data?.cpuPercent[index]
    return sample(value) ? value : null
  })
  const memoryBuckets = totalMb === undefined ? [] : Array.from({ length: count }, (_, index) => {
    const value = data?.memoryMb[index]
    return sample(value) ? 100 * value / totalMb : null
  })
  const cpu = cpuBuckets.filter(sample)
  const memory = memoryBuckets.filter(sample)
  const peak = (values: readonly number[]): string => `${number(Math.max(...values))}%`
  const series: LineSeries[] = [
    ...(count > 1 && cpu.length > 0 ? [{ label: t(msgctxt('theme:v2', 'CPU, peak {value}'), { value: peak(cpu) }), values: cpuBuckets }] : []),
    ...(count > 1 && memory.length > 0 ? [{ label: t(msgctxt('theme:v2', 'Memory, peak {value}'), { value: peak(memory) }), values: memoryBuckets, dashed: true }] : []),
  ]
  const link = canOpenRegisteredRoute('/whm/monitoring/performance', props.visibility)
  if (!data || !series.length) return card({ title: t(msgctxt('theme:v2', 'CPU and memory, last 24 hours')), titleId: 'v2-whm-history',
    bodyHtml: `<div class="v2-whm-overview__chart" role="status">${escapeHtml(t('Performance history has not been read.'))}</div>`,
    footerHtml: link ? `<a href="/whm/monitoring/performance">${escapeHtml(t('Performance history'))}</a>` : undefined,
  })
  const sampled = Array.from({ length: count }, (_, index) => cpuBuckets[index] !== null || (memoryBuckets[index] ?? null) !== null).filter(Boolean).length
  const top = Math.max(100, Math.ceil(Math.max(...cpu, ...memory)))
  const from = formatDisplayDateTime(data.from), to = formatDisplayDateTime(data.to)
  return card({ title: t(msgctxt('theme:v2', 'CPU and memory, last 24 hours')), titleId: 'v2-whm-history',
    description: t(msgctxt('theme:v2', '15-minute averages, times in UTC. {read} of {total} intervals have samples.'), { read: sampled, total: count }),
    bodyHtml: lineChart({ label: t(msgctxt('theme:v2', 'CPU and memory use from {from} to {to} UTC'), { from, to }), series, max: top,
      yTicks: [1, 0.75, 0.5, 0.25, 0].map(part => `${number(top * part)}%`), xTicks: [from, to] }),
    footerHtml: link ? `<a href="/whm/monitoring/performance">${escapeHtml(t('Performance history'))}</a>` : undefined,
  })
}

const tile = (label: string, value: string, options: { href?: string; warn?: boolean } = {}): string => {
  const body = `<span>${escapeHtml(label)}</span><strong class="v2-num"${options.warn ? ' data-tone="warn"' : ''}>${ltr(value)}</strong>`
  return options.href ? `<a class="v2-whm-overview__tile" href="${escapeHtml(options.href)}">${body}</a>` : `<div class="v2-whm-overview__tile">${body}</div>`
}

function reconciler(t: Translate, props: WhmSurfaceProps): string {
  const gen = integer(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const knownDrift = integer(props.driftCount ?? undefined)
  const inSync = knownDrift && props.driftCount === 0 && gen !== undefined
  const check = (value: { ok: boolean; at: string } | undefined): string => value ? t(value.ok ? 'Passed' : 'Failed') : t('Not read')
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: 'nginx -t', value: check(props.hostSample?.nginxTest), mono: true },
    { label: 'apachectl configtest', value: check(props.hostSample?.apacheTest), mono: true },
    { label: t('Rollback target'), value: integer(props.rollbackGenerationId) ? String(props.rollbackGenerationId) : t('Not read') },
    { label: t(msgctxt('theme:v2', 'Last drift check')), value: props.driftCheckedAt ? formatDisplayDateTime(props.driftCheckedAt) : t('Not read') },
  ]
  const state = !knownDrift ? { tone: 'neutral' as const, label: t('Not read') }
    : inSync ? { tone: 'ok' as const, label: t('In sync') }
      : { tone: 'warn' as const, label: t('Review required') }
  // "Desired = applied" is stated only for a read drift count of zero; otherwise the tile names the generation alone.
  const generation = inSync ? tile(t(msgctxt('theme:v2', 'Desired = applied')), `${gen} = ${gen}`) : tile(t('Active generation'), gen === undefined ? '\u2014' : String(gen))
  return card({ title: t('Reconciler'), titleId: 'v2-whm-reconciler', actionsHtml: statusPill(state),
    bodyHtml: `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'Changes are applied as tested configuration generations.')))}</p><div class="v2-whm-overview__tiles">${generation}${tile(t('Drift'), knownDrift ? String(props.driftCount) : '\u2014', { warn: knownDrift && props.driftCount !== 0 })}</div><dl class="v2-whm-overview__rows">${rows.map(row => `<div><dt>${row.mono ? `<span class="v2-mono">${ltr(row.label)}</span>` : escapeHtml(row.label)}</dt><dd class="v2-mono v2-num">${ltr(row.value)}</dd></div>`).join('')}</dl><p class="v2-muted v2-whm-overview__reconciler-note" role="status">${escapeHtml(knownDrift ? t(msgctxt('theme:v2', 'This is the last supplied observation.')) : t(msgctxt('theme:v2', 'The applied state has not been read.')))}</p>`,
    footerHtml: canOpenRegisteredRoute('/whm/audit', props.visibility) ? `<a href="/whm/audit">${escapeHtml(t(msgctxt('theme:v2', 'View generations')))}</a>` : undefined,
  })
}

/** Counts come from the accounts this caller may list; an unread list shows a dash, never a zero. */
function accountsCard(t: Translate, props: WhmSurfaceProps): string {
  const accounts = props.accounts
  const count = (status: 'active' | 'suspended'): string => accounts ? String(accounts.filter(account => account.status === status).length) : '\u2014'
  const root = (props.visibility?.principal ?? props.principal)?.kind === 'root'
  const resellers = root && canOpenRegisteredRoute('/whm/resellers', props.visibility)
    ? tile(t('Resellers'), props.resellers ? String(props.resellers.length) : '\u2014', { href: '/whm/resellers' }) : ''
  const total = accounts ? `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', '{count, plural, one {# account in total.} other {# accounts in total.}}'), { count: accounts.length }))}${root ? ' ' + escapeHtml(t(msgctxt('theme:v2', 'Resellers see only the accounts they own.'))) : ''}</p>` : ''
  const near = props.nearLimits
  const attention = near?.length
    ? `<ul class="v2-whm-overview__attention">${near.map(item => `<li><strong class="v2-mono">${ltr(item.name)}</strong><span>${escapeHtml(item.note)}</span><a class="v2-btn" href="/whm/accounts" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Review {account}'), { account: item.name }))}">${escapeHtml(t('Review'))}</a></li>`).join('')}</ul>`
    : `<p class="v2-muted" role="status">${escapeHtml(near === undefined ? t(msgctxt('theme:v2', 'Account usage has not been read.')) : t(msgctxt('theme:v2', 'No accounts are near a limit in the supplied observation.')))}</p>`
  const suspended = count('suspended')
  return card({ title: t('Accounts'), titleId: 'v2-whm-accounts', actionsHtml: `<a href="/whm/accounts">${escapeHtml(t('View accounts'))}</a>`,
    bodyHtml: `<div class="v2-whm-overview__tiles v2-whm-overview__tiles--auto">${tile(t('Active'), count('active'), { href: '/whm/accounts' })}${tile(t('Suspended'), suspended, { href: '/whm/accounts', warn: suspended !== '0' && suspended !== '\u2014' })}${resellers}</div>${total}<h3 class="v2-whm-overview__sub">${escapeHtml(t(msgctxt('theme:v2', 'Need attention')))}</h3>${attention}`,
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
    { label: t('Uptime'), value: finite(sample?.uptimeSeconds) ? t('{days} d {hours} h', { days: Math.floor(sample.uptimeSeconds / 86400), hours: Math.floor(sample.uptimeSeconds % 86400 / 3600) }) : missing },
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

function certificateRenewalStrip(t: Translate, props: WhmSurfaceProps, canOpenTls: boolean): string {
  const certs = props.certificates
  const autoSsl = props.autoSsl
  if (certs === undefined && autoSsl === undefined) return ''
  const nowMs = Date.now()
  const windowMs = 30 * 86_400_000
  const seen = new Set<string>()
  let healthy = 0
  let expiringSoon = 0
  let expired = 0
  for (const cert of certs ?? []) {
    const key = `${[...cert.names].sort().join(',')}|${cert.notAfter}`
    if (seen.has(key)) continue
    seen.add(key)
    const exp = Date.parse(cert.notAfter)
    if (!Number.isFinite(exp)) continue
    if (exp <= nowMs) expired++
    else if (exp - nowMs <= windowMs) expiringSoon++
    else healthy++
  }
  const tone: Tone = expired > 0 ? 'bad' : expiringSoon > 0 ? 'warn' : certs !== undefined ? 'ok' : 'info'
  const lead = certs === undefined
    ? t(msgid('TLS certificate renewal'))
    : expired > 0 || expiringSoon > 0
      ? t(msgid('{expiring} expiring within 30 days · {healthy} healthy'), { expiring: expired + expiringSoon, healthy })
      : t(msgid('{healthy} TLS certificates healthy (0 expiring within 30 days)'), { healthy })
  const nextRun = autoSsl?.nextRunAt ? formatDisplayDateTime(autoSsl.nextRunAt) : '—'
  const text = autoSsl?.state === 'active' && nextRun !== '—'
    ? t(msgid('Next AutoSSL renewal check: {at}'), { at: nextRun })
    : autoSsl?.state === 'disabled'
      ? t(msgid('AutoSSL automatic renewal is disabled.'))
      : t(msgid('AutoSSL renewal schedule has not been verified on this host.'))
  return `<div data-cert-renewal-strip>${notice(t, {
    tone,
    lead,
    text,
    ...(canOpenTls ? { action: { label: t('SSL/TLS'), href: '/whm/tls' } } : {}),
  })}</div>`
}

/** Body renderer; the surface owner supplies the v2 shell and core document slots once. */
export function renderV2WhmOverview(t: Translate, props: WhmSurfaceProps): string {
  const principal = props.visibility?.principal ?? props.principal
  if (!principal || principal.kind === 'user' || props.capabilityUnavailable) return notice(t, { tone: 'warn', lead: t('Unavailable'), text: t(msgctxt('theme:v2', 'The server overview is unavailable for this caller.')) })
  const open = (route: string): boolean => canOpenRegisteredRoute(route, props.visibility)
  const actions = `${open('/whm/audit') ? `<a class="v2-btn" href="/whm/audit">${escapeHtml(t('Audit log'))}</a>` : ''}${open('/whm/accounts/new') ? `<a class="v2-btn v2-btn--primary" href="/whm/accounts/new">${escapeHtml(t('Create account'))}</a>` : ''}`
  const upgrade = principal.kind === 'root' && props.availableVersion && props.version && props.availableVersion !== props.version
    ? notice(t, { tone: 'info', lead: t(msgctxt('theme:v2', 'Upgrade {version} is available.'), { version: props.availableVersion }),
      text: t(msgctxt('theme:v2', 'This server runs {version}.'), { version: props.version }),
      ...(open('/whm/server/upgrade') ? { action: { label: t('Review the upgrade'), href: '/whm/server/upgrade' } } : {}) }) : ''
  const certStrip = principal.kind === 'root' ? certificateRenewalStrip(t, props, open('/whm/tls')) : ''
  const jobs = card({ title: t(msgctxt('theme:v2', 'Background jobs')), titleId: 'v2-whm-background-jobs',
    bodyHtml: `<div class="v2-whm-overview__unread" role="status">${emptyState({ icon: 'clock', title: t('Not read'), text: t(msgctxt('theme:v2', 'Background jobs have not been read.')),
      ...(open('/whm/jobs') ? { actionHtml: `<a class="v2-btn" href="/whm/jobs">${escapeHtml(t(msgctxt('theme:v2', 'View jobs')))}</a>` } : {}) })}</div>`,
  })
  const audit = open('/whm/audit') ? auditEvents(t, props) : ''
  return `<div class="v2-layout v2-whm-overview" data-whm-overview>${pageHeader(t, { breadcrumb: [{ label: t('Home') }, { label: t('Dashboard') }], route: '/whm', title: t('Server dashboard'), description: t(msgctxt('theme:v2', 'The reconciler, accounts, resources and services.')), actionsHtml: actions })}${upgrade}${certStrip}${renderV2WhmHome(t)}${resources(t, props)}<div class="v2-whm-overview__primary">${history(t, props)}${reconciler(t, props)}</div><div class="v2-whm-overview__secondary">${open('/whm/services') ? services(t, props) : ''}<div class="v2-stack">${open('/whm/accounts') ? accountsCard(t, props) : ''}${jobs}</div></div>${hostFacts(t, props)}${audit}</div>`
}

export const WHM_OVERVIEW_CSS = `.v2-whm-overview{gap:var(--space-4)}
.v2-whm-overview>.v2-kpi-row{grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))}
.v2-whm-overview :is(.v2-card__actions,.v2-card__footer)>a:not(.v2-btn){display:inline-flex;align-items:center;min-inline-size:var(--target);min-block-size:var(--target);font-size:13px;font-weight:600;transition:color 140ms ease-out}
.v2-whm-overview :is(.v2-chart__x,.v2-chart__y){font-size:12px;font-variant-numeric:tabular-nums}
.v2-whm-overview [data-cert-renewal-strip],.v2-whm-overview .v2-whm-overview__service .v2-mono,.v2-whm-overview #v2-whm-audit-table time,.v2-whm-overview #v2-whm-host-facts dd{font-variant-numeric:tabular-nums}
.v2-whm-overview__primary{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:var(--space-3);align-items:stretch}
.v2-whm-overview__secondary{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:var(--space-3);align-items:stretch}
.v2-whm-overview__ranges{display:flex;gap:var(--space-1)}
.v2-whm-overview__primary>.v2-card>.v2-card__body,.v2-whm-overview__secondary>.v2-card>.v2-card__body{flex:1 1 auto}
.v2-whm-overview__secondary>.v2-stack{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-overview__secondary>.v2-stack>.v2-card:last-child{flex:1 1 auto}
.v2-whm-overview__secondary>.v2-stack>.v2-card:last-child>.v2-card__body{flex:1 1 auto;justify-content:center}
.v2-whm-overview__reconciler-note{margin-block-start:auto}
.v2-whm-overview__chart{flex:1 1 auto;min-block-size:220px;display:grid;place-items:center;padding:var(--space-3);border:1px dashed var(--line);border-radius:var(--radius-notice);color:var(--muted);text-align:center}
.v2-whm-overview__tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-overview__tiles--auto{grid-template-columns:repeat(auto-fit,minmax(0,1fr))}
.v2-whm-overview__tile{display:flex;flex-direction:column;justify-content:center;gap:4px;min-inline-size:var(--target);min-block-size:var(--target);padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle);color:var(--text);text-decoration:none;transition:background-color 140ms ease-out,border-color 140ms ease-out}
.v2-whm-overview__tile:is(a){background:var(--surface)}.v2-whm-overview__tile:is(a):hover{background:var(--subtle);border-color:var(--line-strong)}
.v2-whm-overview__tile>span{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
@media(max-width:400px){.v2-whm-overview__tile{padding-inline:12px}.v2-whm-overview__tiles{gap:var(--space-1)}}
.v2-whm-overview__tile>strong{font-size:20px;font-weight:600;line-height:1.25;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.v2-whm-overview__tile>strong[data-tone=warn]{color:var(--warn)}
.v2-whm-overview__rows{margin:0;display:flex;flex-direction:column}
.v2-whm-overview__rows>div{display:flex;justify-content:space-between;align-items:center;gap:var(--space-2);min-block-size:var(--target);border-block-start:1px solid var(--line);font-size:13px}
.v2-whm-overview__rows dt{color:var(--text-2)}.v2-whm-overview__rows dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums;text-align:end;overflow-wrap:anywhere}
.v2-whm-overview__sub{margin:0;font-size:14px;font-weight:600;color:var(--text-2)}
.v2-whm-overview__attention{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.v2-whm-overview__attention>li{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1) var(--space-2);min-block-size:56px;padding-block:var(--space-1);border-block-start:1px solid var(--line);font-size:13px}
.v2-whm-overview__attention>li>span{flex:1 1 200px;color:var(--warn)}
.v2-whm-overview__services{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border-block-start:1px solid var(--line)}
.v2-whm-overview__services>li{padding:12px var(--space-3);border-block-end:1px solid var(--line)}
.v2-whm-overview__services>li:last-child{border-block-end:0}
.v2-whm-overview__service{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2)}
.v2-whm-overview__service>span:first-child{display:flex;flex-direction:column;gap:2px;font-size:14px;min-inline-size:0;overflow-wrap:anywhere}
.v2-whm-overview__unread>.v2-state--empty{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;justify-items:start;gap:4px 12px;padding:var(--space-2);border-radius:var(--radius-notice);text-align:start}
.v2-whm-overview__unread .v2-state__icon{grid-row:1/3}
.v2-whm-overview__unread :is(h2,h3,p){grid-column:2}
.v2-whm-overview__unread .v2-btn{grid-column:3;grid-row:1/3}
@media(prefers-reduced-motion:reduce){.v2-whm-overview__tile,.v2-whm-overview :is(.v2-card__actions,.v2-card__footer)>a:not(.v2-btn){transition:none}}
@media(max-width:1050px){.v2-whm-overview__primary,.v2-whm-overview__secondary{grid-template-columns:1fr}}
@media(max-width:640px){.v2-whm-overview{gap:var(--space-3)}.v2-whm-overview__unread .v2-btn{grid-column:1/-1;grid-row:auto;justify-self:stretch;margin-block-start:var(--space-1)}.v2-whm-overview__services>li{padding:10px var(--space-2)}.v2-whm-overview>.v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
