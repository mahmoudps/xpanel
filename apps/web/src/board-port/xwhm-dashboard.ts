import type { Account, AuditEntry, Certificate, Plan, ServerIpEntry } from '@xpanel/core'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import { isolateLtrRuns } from '../bidi-runs.ts'
import { auditActionLabel, auditOutcomeLabel, auditTargetLabel } from '../audit-labels.ts'
import type { Locale } from '../i18n.ts'
import { escapeHtml, formatAsciiDate, formatAsciiNumber, formatBytes, formatUtcClock, formatUtcDay } from '../tokens.ts'

interface DashboardServiceInput {
  name: string
  version: string
  active: boolean
  installed?: boolean
  /** False when this row was not probed. Omitted means the probe returned a state. */
  checked?: boolean
}

export interface DashboardHostSample {
  hostname?: string
  load1?: number
  load5?: number
  load15?: number
  cores?: number
  cpuModel?: string
  memory?: { totalBytes: number; availableBytes: number }
  disk?: { mount: string; totalBytes: number; usedBytes: number; availableBytes: number }
  inodes?: { mount: string; total: number; used: number; homeOnRoot?: boolean }
  system?: string
  kernel?: string
  uptimeSeconds?: number
  engine?: string
  panelVersion?: string
  /** DNS name from the panel certificate. */
  panelDomain?: string
  /** ISO time of the host probe. Empty when the sample was not taken. */
  sampledAt?: string
  nginxTest?: { ok: boolean; at: string }
  apacheTest?: { ok: boolean; at: string }
}

interface DashboardProps {
  locale?: Locale
  principal?: { username: string }
  hostname?: string
  /** Panel vhost, shown beside the system hostname when the two differ. */
  panelHostname?: string
  version?: string
  availableVersion?: string
  generationId?: number
  accounts?: Account[]
  resellers?: readonly unknown[]
  ipPool?: ServerIpEntry[]
  services?: DashboardServiceInput[]
  auditEntries?: AuditEntry[]
  plans?: readonly Plan[]
  hostSample?: DashboardHostSample | null
  /** Null when drift was not read. A number is the count reported by the host. */
  driftCount?: number | null
  /** Previous superseded generation, the rollback target. */
  rollbackGenerationId?: number
  /** When the active generation was activated. */
  generationActivatedAt?: string
  certificates?: readonly Pick<Certificate, 'names' | 'notAfter'>[]
  /** Computed near-limit rows. Omit when usage was not measured. An empty list is none. */
  nearLimits?: Array<{ name: string; note: string }>
  /** Fixed clock for certificate day counts. Tests pass this; live pages use the current time. */
  now?: number
}

export interface DashboardChip {
  label: string
  bg: string
  fg: string
  dot?: string
  borderedDot?: boolean
}

export interface DashboardAuditRow {
  time: string
  datetime: string
  actor: string
  from: string
  action: string
  target: string
  result: DashboardChip
  detail: string
}

export interface DashboardServiceRow {
  name: string
  version: string
  note: string
  status: DashboardChip
}

export interface DashboardMeter {
  label: string
  value: string
  now: string
  pct: string
  color: string
  note: string
  noteColor: string
  /** False when the reading is not a percentage. The bar is omitted. */
  showBar?: boolean
}

export interface DashboardNotice {
  tone: 'warn' | 'info'
  html: string
}

export interface WhmDashboardModel {
  locale: Locale
  hostname: string
  username: string
  versionLabel: string
  generationLabel: string
  generationTone: 'live' | 'empty'
  activeHref: string
  title: string
  crumbRoot: string
  crumbPage: string
  ledeHost: string
  ledeRest: string
  ledeTime: string
  ledeDatetime: string
  createLabel: string
  searchLabel: string
  searchPlaceholder: string
  notices: DashboardNotice[]
  reconcilerTitle: string
  reconcilerStatus: DashboardChip
  reconcilerLede: string
  reconcilerTiles: Array<{ label: string; value: string; note: string; chip?: DashboardChip; monoLabel?: boolean }>
  driftButton: string
  driftLink: string
  driftStatus: string
  resourcesTitle: string
  resourcesSampled: string
  meters: DashboardMeter[]
  resourcesFoot: string
  auditTitle: string
  auditWhen: string
  audit: DashboardAuditRow[]
  auditLink: string
  auditHeads: [string, string, string, string]
  accountsTitle: string
  accountTiles: Array<{ label: string; value: string; dot: string; ring?: boolean }>
  accountsSentence: string
  nearTitle: string
  near: Array<{ name: string; note: string; color: string }>
  viewAccounts: string
  resellersLink: string
  hostTitle: string
  hostIp: string
  hostRows: Array<{ label: string; value: string; ddStyle: string }>
  controllersTitle: string
  controllers: string[]
  controllersNote: string
  servicesTitle: string
  servicesMeta: string
  services: DashboardServiceRow[]
  servicesLink: string
  signOutLabel?: string
}

const okChip = (label: string): DashboardChip => ({ label, bg: '#E7F5EE', fg: '#0E7A4E' })
const badChip = (label: string): DashboardChip => ({ label, bg: '#FDECEA', fg: '#B42318' })
const emptyChip = (label: string): DashboardChip => ({ label, bg: '#EEF0F3', fg: '#344054', dot: 'transparent', borderedDot: true })

const svg = (inner: string, size = 18, flex = true): string =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${flex ? ' style="flex: none"' : ''}>${inner}</svg>`

const NAV: Array<{ id: string; label: [string, string]; items: Array<{ href: string; label: [string, string]; icon: string }> }> = [
  { id: 'nav-g-server', label: ['Server', 'الخادم'], items: [
    { href: '/whm', label: ['Dashboard', 'اللوحة'], icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>' },
    { href: '/whm/server/setup', label: ['Setup wizard', 'معالج الإعداد'], icon: '<path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"></path>' },
  ] },
  { id: 'nav-g-accounts', label: ['Accounts', 'الحسابات'], items: [
    { href: '/whm/accounts', label: ['Accounts', 'الحسابات'], icon: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2"></path>' },
    { href: '/whm/accounts/new', label: ['Create account', 'إنشاء حساب'], icon: '<circle cx="10" cy="8" r="3.5"></circle><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M19 8v6M16 11h6"></path>' },
    { href: '/whm/plans', label: ['Plans', 'الخطط'], icon: '<path d="M12 3l9 5-9 5-9-5z"></path><path d="M3 13l9 5 9-5"></path>' },
    { href: '/whm/plans/features', label: ['Feature lists', 'قوائم الميزات'], icon: '<rect x="3" y="7" width="18" height="10" rx="5"></rect><circle cx="16" cy="12" r="2.5"></circle>' },
    { href: '/whm/resellers', label: ['Resellers', 'الموزعون'], icon: '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"></path>' },
    { href: '/whm/domains', label: ['Domains', 'النطاقات'], icon: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"></path>' },
  ] },
  { id: 'nav-g-web', label: ['Web', 'الويب'], items: [
    { href: '/whm/services/web', label: ['Web server', 'خادم الويب'], icon: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>' },
    { href: '/whm/software/php', label: ['PHP', 'PHP'], icon: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"></path>' },
    { href: '/whm/ssl', label: ['SSL/TLS', 'SSL/TLS'], icon: '<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>' },
    { href: '/whm/dns', label: ['DNS zones', 'مناطق «DNS»'], icon: '<circle cx="12" cy="5" r="2"></circle><circle cx="5" cy="19" r="2"></circle><circle cx="19" cy="19" r="2"></circle><path d="M12 7v5M12 12l-5.5 5.5M12 12l5.5 5.5"></path>' },
    { href: '/whm/services', label: ['Services', 'الخدمات'], icon: '<path d="M3 12h4l3-8 4 16 3-8h4"></path>' },
  ] },
  { id: 'nav-g-security', label: ['Security', 'الأمان'], items: [
    { href: '/whm/security/firewall', label: ['Firewall', 'الجدار الناري'], icon: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"></path>' },
    { href: '/whm/security', label: ['Panel security', 'أمان اللوحة'], icon: '<circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9M17 6l3 3M14 9l2 2"></path>' },
    { href: '/whm/security/ssh', label: ['SSH', 'SSH'], icon: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3M13 15h4"></path>' },
  ] },
  { id: 'nav-g-ops', label: ['Operations', 'التشغيل'], items: [
    { href: '/whm/backups', label: ['Backups', 'النسخ'], icon: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"></path>' },
    { href: '/whm/transfers', label: ['Transfer tool', 'أداة النقل'], icon: '<path d="M4 8h14l-4-4M20 16H6l4 4"></path>' },
    { href: '/whm/upgrade', label: ['Upgrade', 'الترقية'], icon: '<circle cx="12" cy="12" r="9"></circle><path d="M12 16V8M8.5 11.5L12 8l3.5 3.5"></path>' },
    { href: '/whm/audit', label: ['Audit log', 'سجل التدقيق'], icon: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"></path><path d="M14 3v5h5M8.5 13h7M8.5 17h7"></path>' },
  ] },
]

const plain = (value: string): string => value.replace(/«|»/g, '')

const arUnit = (n: number, one: string, two: string, few: string, many: string): string => {
  if (n === 0 || (n >= 3 && n <= 10)) return few
  if (n === 1) return one
  if (n === 2) return two
  return many
}

const enUnit = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Days and hours from a probed uptime. A missing reading stays empty at the call site. */
const formatUptime = (seconds: number, ar: boolean): string => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (ar) {
    const parts = [
      days > 0 ? `«${days}» ${arUnit(days, 'يوم', 'يومين', 'أيام', 'يوماً')}` : '',
      hours > 0 ? `«${hours}» ${arUnit(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة')}` : '',
      days === 0 && hours === 0 ? `«${minutes}» ${arUnit(minutes, 'دقيقة', 'دقيقتين', 'دقائق', 'دقيقة')}` : '',
    ].filter(part => part.length > 0)
    return parts.join(' و')
  }
  const parts = [
    days > 0 ? enUnit(days, 'day', 'days') : '',
    hours > 0 ? enUnit(hours, 'hour', 'hours') : '',
    days === 0 && hours === 0 ? enUnit(minutes, 'minute', 'minutes') : '',
  ].filter(part => part.length > 0)
  return parts.join(', ')
}

const hostText = (value: string | undefined): string => value && value.length > 0 ? value : '—'

const hardwareLine = (cores: number | null, model: string | null, bytes: string | null, ar: boolean): string => {
  const parts = [
    cores === null ? '' : ar ? `«${cores}» ${arUnit(cores, 'نواة', 'نواتين', 'أنوية', 'نواة')}` : `${cores} ${cores === 1 ? 'core' : 'cores'}`,
    model ? (ar ? `«${model}»` : model) : '',
    bytes ? (ar ? `«${bytes}»` : bytes) : '',
  ].filter(part => part.length > 0)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

const agentRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : null

const agentNumber = (record: Record<string, unknown> | null, key: string): number | undefined => {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

const agentText = (record: Record<string, unknown> | null, key: string): string | undefined => {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined
}

/** Copies `GET /host/info` into the dashboard sample. A missing object stays empty. */
export const mapAgentHostInfo = (info: unknown): DashboardHostSample | null => {
  const record = agentRecord(info)
  if (!record) return null
  const load = agentRecord(record.load)
  const memory = agentRecord(record.memory)
  const disk = agentRecord(record.disk)
  const inodes = agentRecord(record.inodes)
  const identity = agentRecord(record.identity)
  const totalBytes = agentNumber(memory, 'totalBytes')
  const availableBytes = agentNumber(memory, 'availableBytes')
  const diskTotal = agentNumber(disk, 'totalBytes')
  const diskUsed = agentNumber(disk, 'usedBytes')
  const diskFree = agentNumber(disk, 'availableBytes')
  const inodeTotal = agentNumber(inodes, 'total')
  const inodeUsed = agentNumber(inodes, 'used')
  const inodeMount = agentText(inodes, 'mount')
  const uptimeRaw = identity?.uptimeSeconds
  const uptimeSeconds = typeof uptimeRaw === 'number' && Number.isFinite(uptimeRaw) && uptimeRaw >= 0 ? Math.floor(uptimeRaw) : undefined
  const coresRaw = identity?.cores
  const cores = typeof coresRaw === 'number' && Number.isInteger(coresRaw) && coresRaw >= 1 && coresRaw <= 4096 ? coresRaw : undefined
  const homeOnRoot = record.homeOnRoot === true || inodeMount === '/'
  const configChecks = agentRecord(record.configChecks)
  const configCheck = (name: string): { ok: boolean; at: string } | undefined => {
    const check = agentRecord(configChecks?.[name])
    const at = agentText(check, 'at')
    if (!check || typeof check.ok !== 'boolean' || !at || Number.isNaN(Date.parse(at))) return undefined
    return { ok: check.ok, at }
  }
  const sampledAt = agentText(record, 'sampledAt')
  const nginxTest = configCheck('nginx')
  const apacheTest = configCheck('apache')
  const sample: DashboardHostSample = {
    ...(agentNumber(load, 'load1') !== undefined ? { load1: agentNumber(load, 'load1') } : {}),
    ...(agentNumber(load, 'load5') !== undefined ? { load5: agentNumber(load, 'load5') } : {}),
    ...(agentNumber(load, 'load15') !== undefined ? { load15: agentNumber(load, 'load15') } : {}),
    ...(totalBytes !== undefined && availableBytes !== undefined ? { memory: { totalBytes, availableBytes } } : {}),
    ...(typeof disk?.mount === 'string' && disk.mount.startsWith('/') && disk.mount.length <= 200 && diskTotal !== undefined && diskUsed !== undefined && diskFree !== undefined
      ? { disk: { mount: disk.mount, totalBytes: diskTotal, usedBytes: diskUsed, availableBytes: diskFree } }
      : {}),
    ...(inodeMount && inodeMount.startsWith('/') && inodeTotal !== undefined && inodeUsed !== undefined && Number.isSafeInteger(inodeTotal) && Number.isSafeInteger(inodeUsed) && inodeUsed <= inodeTotal
      ? { inodes: { mount: inodeMount, total: inodeTotal, used: inodeUsed, ...(homeOnRoot ? { homeOnRoot: true } : {}) } }
      : {}),
    ...(agentText(identity, 'hostname') ? { hostname: agentText(identity, 'hostname') } : {}),
    ...(cores !== undefined ? { cores } : {}),
    ...(agentText(identity, 'model') ? { cpuModel: agentText(identity, 'model') } : {}),
    ...(agentText(identity, 'system') ? { system: agentText(identity, 'system') } : {}),
    ...(agentText(identity, 'kernel') ? { kernel: agentText(identity, 'kernel') } : {}),
    ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
    ...(agentText(identity, 'engine') ? { engine: agentText(identity, 'engine') } : {}),
    ...(agentText(identity, 'version') ? { panelVersion: agentText(identity, 'version') } : {}),
    ...(agentText(identity, 'panelDomain') ? { panelDomain: agentText(identity, 'panelDomain') } : {}),
    ...(sampledAt && !Number.isNaN(Date.parse(sampledAt)) ? { sampledAt } : {}),
    ...(nginxTest ? { nginxTest } : {}),
    ...(apacheTest ? { apacheTest } : {}),
  }
  return sample
}

export interface MappedHostService {
  name: string
  unit: string
  version: string
  active: boolean
  enabled: boolean
  rssMb: number
  role: string
  installed: boolean
  checked: boolean
}

/** Copies `GET /host/services` into dashboard rows. Uninstalled and unchecked rows stay in the list. */
export const mapAgentServices = (payload: unknown): MappedHostService[] | null => {
  const services = agentRecord(payload)?.services
  if (!Array.isArray(services)) return null
  return services.flatMap(row => {
    const service = agentRecord(row)
    if (!service || typeof service.label !== 'string' || service.label.length === 0 || service.label.length > 80) return []
    const state = service.state
    const installed = state === 'active' || state === 'inactive' || state === 'failed'
    const checked = installed || state === 'not-installed'
    return [{
      name: service.label,
      unit: typeof service.unit === 'string' ? service.unit : '',
      version: '',
      active: state === 'active',
      enabled: state === 'active',
      rssMb: 0,
      role: '',
      installed,
      checked,
    }]
  })
}

const ltr = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

const rich = (value: string): string => value.split(/«([^»]*)»/).map((part, index) => index % 2 === 1 ? ltr(part) : isolateLtrRuns(part)).join('')

/** English stays escaped text so the approved LTR pixels do not move. Arabic isolates Latin tokens and dates. */
const show = (value: string, ar: boolean): string => {
  if (!ar) return escapeHtml(value)
  if (value.includes('«')) return rich(value)
  if (/[\u0600-\u06FF]/.test(value)) return isolateLtrRuns(value)
  return ltr(value)
}

const pill = (chip: DashboardChip, mono = false): string => {
  const dot = chip.dot ?? chip.fg
  const border = chip.borderedDot ? `border: 1.5px solid ${chip.fg};` : ''
  const font = mono ? " font-family: 'IBM Plex Mono', monospace;" : ''
  return `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${chip.bg}; color: ${chip.fg}; font-size: 12px; font-weight: 600;${font}"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${dot}; ${border}"></span>${escapeHtml(chip.label)}</span>`
}

const linkStyle = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; color: #C9D3E1; text-decoration: none; font-size: 14px'
const activeStyle = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset 3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'

const navHtml = (model: WhmDashboardModel): string => {
  const ar = model.locale === 'ar'
  const index = ar ? 1 : 0
  const active = ar
    ? 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset -3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'
    : activeStyle
  const groups = NAV.map(group => {
    const items = group.items.map(item => {
      const current = item.href === model.activeHref
      const label = show(item.label[index] ?? '', ar)
      const labelBody = label.includes('<') ? `<span>${label}</span>` : label
      return `<li><a href="${item.href}"${current ? ' aria-current="page"' : ''} style="${current ? active : linkStyle}">${svg(item.icon)}${labelBody}</a></li>`
    }).join('')
    return `<div style="display: flex; flex-direction: column; gap: 4px">
      <span id="${group.id}" style="padding: 0 12px; font-size: 11px; font-weight: 600; color: #8A99AF; line-height: 1.6">${show(group.label[index] ?? '', ar)}</span>
      <ul aria-labelledby="${group.id}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${items}</ul>
    </div>`
  }).join('')
  const brand = ar ? '<bdi dir="ltr">xWHM</bdi>' : 'xWHM'
  return `<nav aria-label="xWHM navigation" style="flex: 1 1 248px; max-width: 100%; background: #0E1726; color: #C9D3E1; padding: 20px 14px; display: flex; flex-direction: column; gap: 18px">
    <div style="display: flex; align-items: center; gap: 10px; padding: 0 6px">
      <span aria-hidden="true" style="flex: none; width: 36px; height: 36px; border-radius: 8px; background: #1D5BD6; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 500">x</span>
      <div style="display: flex; flex-direction: column; min-width: 0">
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 500; color: #FFFFFF; line-height: 1.3">${brand}</span>
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #8A99AF; line-height: 1.3">${show(model.hostname, ar)}</span>
      </div>
    </div>
    ${groups}
  </nav>`
}

const headerHtml = (model: WhmDashboardModel): string => {
  const ar = model.locale === 'ar'
  const genBg = model.generationTone === 'live' ? '#E7F5EE' : '#EEF0F3'
  const genFg = model.generationTone === 'live' ? '#0E7A4E' : '#344054'
  const initial = escapeHtml((model.username.slice(0, 1) || '—').toLowerCase())
  const generation = show(model.generationLabel, ar)
  const generationBody = generation.includes('<bdi') ? `<span>${generation}</span>` : generation
  const lang = model.locale === 'ar'
    ? `<a href="?lang=en" lang="en" hreflang="en" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">English</a>`
    : `<a href="?lang=ar" lang="ar" hreflang="ar" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">العربية</a>`
  return `<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 32px; background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
      <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px; display: flex; align-items: center">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; inset-inline-start: 12px; pointer-events: none"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
        <input type="search" aria-label="${escapeHtml(model.searchLabel)}" placeholder="${escapeHtml(model.searchPlaceholder)}" style="width: 100%; min-height: 40px; padding-inline-start: 36px; padding-inline-end: 40px; border-radius: 8px; border: 1px solid #D0D5DD; background: #F8F9FB; font-family: inherit; font-size: 14px; color: #101828">
        <kbd aria-hidden="true" style="position: absolute; inset-inline-end: 8px; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #475467">/</kbd>
      </div>
      <span style="flex: 1 1 0"></span>
      <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${genBg}; color: ${genFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${genFg}"></span>${generationBody}</span>
      <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(model.versionLabel, ar)}</span>
      ${lang}
      ${model.signOutLabel ? `<button type="button" data-action="logout" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #344054; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${escapeHtml(model.signOutLabel)}</button>` : ''}
      <button type="button" aria-label="${escapeHtml(model.locale === 'ar' ? `قائمة المستخدم ${model.username}` : `User menu for ${model.username}`)}" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding-block: 0; padding-inline: 6px 12px; border-radius: 999px; border: 1px solid #E2E6EC; background: #FFFFFF; color: #101828; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; cursor: pointer"><span aria-hidden="true" style="width: 32px; height: 32px; border-radius: 50%; background: #0E1726; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 13px">${initial}</span>${show(model.username, ar)}</button>
    </header>`
}

const noticeHtml = (notice: DashboardNotice): string => {
  const warn = notice.tone === 'warn'
  const border = warn ? '#F9C9A0' : '#C7D7F8'
  const bg = warn ? '#FFF6EE' : '#F3F7FE'
  const stroke = warn ? '#B54708' : '#1D5BD6'
  const icon = warn
    ? '<path d="M12 3l9 16H3z"></path><path d="M12 10v4M12 17h.01"></path>'
    : '<circle cx="12" cy="12" r="9"></circle><path d="M12 16V8M8.5 11.5L12 8l3.5 3.5"></path>'
  return `<div style="flex: 1 1 360px; min-width: 0; display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid ${border}; background: ${bg}; font-size: 13px; line-height: 1.6"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-top: 2px">${icon}</svg>${notice.html}</div>`
}

const tile = (label: string, value: string, note: string, ar: boolean, chip?: DashboardChip, monoLabel = false): string => {
  const labelStyle = monoLabel
    ? "font-size: 12px; font-weight: 600; color: #5D6B7E; font-family: 'IBM Plex Mono', monospace"
    : 'font-size: 12px; font-weight: 600; color: #5D6B7E'
  const valueHtml = chip
    ? pill(chip)
    : `<dd style="margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums">${show(value, ar)}</dd>`
  return `<div style="display: flex; flex-direction: column; gap: ${chip ? '6px' : '4px'}; padding: 12px 14px; border-radius: 10px; border: 1px solid #EEF0F3; background: #F8F9FB"><dt style="${labelStyle}">${show(label, ar)}</dt>${chip ? `<dd style="margin: 0">${valueHtml}</dd>` : valueHtml}<dd style="margin: 0; font-size: 12px; color: #5D6B7E">${show(note, ar)}</dd></div>`
}

export const renderWhmDashboard = (model: WhmDashboardModel): string => {
  const ar = model.locale === 'ar'
  const auditRows = model.audit.map(row => `<tr style="border-top: 1px solid #EEF0F3; vertical-align: top">
    <td style="padding: 10px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-variant-numeric: tabular-nums; line-height: 1.4"><time datetime="${escapeHtml(row.datetime)}">${show(row.time, ar)}</time></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column"><span style="font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 13px">${show(row.actor, ar)}</span><span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #5D6B7E">${show(row.from, ar)}</span></div></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column"><span>${show(row.action, ar)}</span><span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #5D6B7E; overflow-wrap: anywhere">${show(row.target, ar)}</span></div></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column; align-items: flex-start; gap: 4px">${pill(row.result)}<span style="font-size: 12px; color: #5D6B7E">${show(row.detail, ar)}</span></div></td>
  </tr>`).join('')
  const meters = model.meters.map(meter => `<div style="display: flex; flex-direction: column; gap: 6px">
    <div style="display: flex; justify-content: space-between; gap: 8px; font-size: 13px"><span style="font-weight: 600">${show(meter.label, ar)}</span><span style="color: #475467; font-variant-numeric: tabular-nums">${show(meter.value, ar)}</span></div>
    ${meter.showBar === false ? '' : `<div role="meter" aria-label="${escapeHtml(plain(meter.label))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(meter.now)}" aria-valuetext="${escapeHtml(meter.value)}" style="height: 8px; border-radius: 4px; background: #E9ECF1; overflow: hidden"><div style="height: 8px; width: ${escapeHtml(meter.pct)}; background: ${escapeHtml(meter.color)}; border-radius: 4px"></div></div>`}
    <span style="font-size: 12px; color: ${escapeHtml(meter.noteColor)}">${show(meter.note, ar)}</span>
  </div>`).join('')
  const accountTiles = model.accountTiles.map(item => `<div style="display: flex; flex-direction: column; gap: 2px">
    <dt style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #475467"><span aria-hidden="true" style="width: 8px; height: 8px; border-radius: 50%; ${item.ring ? `border: 1.5px solid ${item.dot}` : `background: ${item.dot}`}"></span>${show(item.label, ar)}</dt>
    <dd style="margin: 0; font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums">${show(item.value, ar)}</dd>
  </div>`).join('')
  const near = model.near.map((item, index) => `<li style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 13px;${index ? ' border-top: 1px solid #EEF0F3' : ''}"><span style="font-family: 'IBM Plex Mono', monospace">${show(item.name, ar)}</span><span style="color: ${escapeHtml(item.color)}; font-weight: 600; font-variant-numeric: tabular-nums">${show(item.note, ar)}</span></li>`).join('')
  const hostRows = model.hostRows.map(row => {
    let value = show(row.value, ar)
    if (ar && row.ddStyle.includes('overflow-wrap')) {
      value = value.replaceAll('<bdi dir="ltr">', '<bdi dir="ltr" style="overflow-wrap: anywhere">')
    }
    return `<dt style="color: #5D6B7E">${show(row.label, ar)}</dt><dd style="${row.ddStyle}">${value}</dd>`
  }).join('')
  const controllers = model.controllers.map(name => `<li style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: #E7F5EE; color: #0E7A4E; font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: #0E7A4E"></span>${show(name, ar)}</li>`).join('')
  const services = model.services.map((row, index) => `<li style="display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 4px 20px; border-top: 1px solid ${index === 0 ? 'transparent' : '#EEF0F3'}">
    <span style="display: flex; flex-direction: column; min-width: 0; line-height: 1.4"><span style="font-size: 14px; font-weight: 500">${show(row.name, ar)} <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #5D6B7E">${show(row.version, ar)}</span></span>${row.note ? `<span style="font-size: 12px; color: #5D6B7E">${show(row.note, ar)}</span>` : ''}</span>
    <span style="flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${row.status.bg}; color: ${row.status.fg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${row.status.dot ?? row.status.fg}; border: 1.5px solid ${row.status.fg}"></span>${escapeHtml(row.status.label)}</span>
  </li>`).join('')
  const crumb = ar
    ? `<li><a href="/whm" style="color: #475467"><bdi dir="ltr">${escapeHtml(model.crumbRoot)}</bdi></a></li><li aria-hidden="true">/</li><li aria-current="page">${show(model.crumbPage, true)}</li>`
    : `<li style="display: flex; gap: 6px"><a href="/whm" style="color: #475467">${escapeHtml(model.crumbRoot)}</a><span aria-hidden="true">/</span></li><li aria-current="page">${escapeHtml(model.crumbPage)}</li>`
  const lede = ar
    ? `<p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6; max-width: 68ch"><span style="font-family: 'IBM Plex Mono', monospace">${ltr(model.ledeHost)}</span> ${rich(model.ledeRest)}<time datetime="${escapeHtml(model.ledeDatetime)}"><bdi dir="ltr" style="white-space: nowrap">${escapeHtml(model.ledeTime)}</bdi></time></p>`
    : `<p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6; max-width: 68ch"><span style="font-family: 'IBM Plex Mono', monospace">${escapeHtml(model.ledeHost)}</span> ${escapeHtml(model.ledeRest)}<time datetime="${escapeHtml(model.ledeDatetime)}">${escapeHtml(model.ledeTime)}</time>.</p>`
  return `<div class="xp-board-port" data-board-port="xwhm-dashboard" data-section="overview-attention"${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: #F5F6F8; color: #101828">
  <style>
    .xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
    .xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
    .xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
    .xp-board-port nav[aria-label="xWHM navigation"] :focus-visible{outline-color:#6EA0FF}
    ${ARABIC_TYPE_CSS}
  </style>
  ${navHtml(model)}
  <main id="main-content" style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    ${headerHtml(model)}
    <div style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px 32px 52px; display: flex; flex-direction: column; gap: 24px">
      <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px">
        <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 420px">
          <nav aria-label="Breadcrumb">
            <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #5D6B7E">
              ${crumb}
            </ol>
          </nav>
          <h1 style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${show(model.title, ar)}</h1>
          ${lede}
        </div>
        <a href="/whm/accounts/new" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${svg('<path d="M12 5v14M5 12h14"></path>', 18, false)}${show(model.createLabel, ar)}</a>
      </div>
      <section aria-label="Notices" style="display: flex; flex-wrap: wrap; gap: 16px">${model.notices.map(noticeHtml).join('')}</section>
      <div style="display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start">
        <div style="flex: 1.618 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="rec-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
              <h2 id="rec-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.reconcilerTitle, ar)}</h2>
              ${pill(model.reconcilerStatus)}
            </div>
            <p style="margin: 0; font-size: 14px; color: #344054; line-height: 1.6; max-width: 68ch">${show(model.reconcilerLede, ar)}</p>
            <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px">${model.reconcilerTiles.map(item => tile(item.label, item.value, item.note, ar, item.chip, item.monoLabel)).join('')}</dl>
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: auto">
              <button type="button" style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.driftButton, ar)}</button>
              <a href="/whm/audit" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: #1D5BD6">${show(model.driftLink, ar)}</a>
              <span role="status" style="font-size: 12px; font-weight: 500; color: #0E7A4E">${show(model.driftStatus, ar)}</span>
            </div>
          </section>
          <section aria-labelledby="res-title" data-host-observation="${model.meters.every(meter => meter.value === '—' && meter.now === '0') ? 'unavailable' : 'observed'}" style="min-width: 0; display: flex; flex-direction: column; gap: 20px; padding: 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px">
              <h2 id="res-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.resourcesTitle, ar)}</h2>
              <span style="font-size: 12px; color: #5D6B7E">${show(model.resourcesSampled, ar)}</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 22px 26px">${meters}</div>
            <p style="margin: 0; font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${model.resourcesFoot}</p>
          </section>
          <section aria-labelledby="audit-title" style="min-width: 0; display: flex; flex-direction: column; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 20px 24px 16px">
              <h2 id="audit-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.auditTitle, ar)}</h2>
              <span style="font-size: 12px; color: #5D6B7E">${show(model.auditWhen, ar)}</span>
            </div>
            <div style="overflow-x: auto; border-top: 1px solid #E2E6EC">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: 620px">
                <thead><tr style="background: #F8F9FB">${model.auditHeads.map((head, index) => `<th scope="col" style="text-align: start; padding: 10px 16px; font-size: 12px; font-weight: 600; color: #475467;${index === 0 ? ' width: 72px' : ''}">${show(head, ar)}</th>`).join('')}</tr></thead>
                <tbody>${auditRows}</tbody>
              </table>
            </div>
            <div style="display: flex; padding: 8px 18px; border-top: 1px solid #EEF0F3">
              <a href="/whm/audit" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: #1D5BD6">${show(model.auditLink, ar)}</a>
            </div>
          </section>
        </div>
        <div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="acc-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <h2 id="acc-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.accountsTitle, ar)}</h2>
            <dl style="margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px">${accountTiles}</dl>
            <p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${show(model.accountsSentence, ar)}</p>
            <div style="display: flex; flex-direction: column; gap: 8px">
              <h3 style="margin: 0; font-size: 13px; font-weight: 600">${show(model.nearTitle, ar)}</h3>
              <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid #EEF0F3; border-radius: 10px">${near}</ul>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: auto">
              <a href="/whm/accounts" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-size: 14px; font-weight: 600; text-decoration: none">${show(model.viewAccounts, ar)}</a>
              <a href="/whm/resellers" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: #1D5BD6">${show(model.resellersLink, ar)}</a>
            </div>
          </section>
          <section aria-labelledby="host-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
              <h2 id="host-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.hostTitle, ar)}</h2>
              <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(model.hostIp, ar)}</span>
            </div>
            <dl style="margin: 0; display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 8px 16px; font-size: 13px; line-height: 1.4">${hostRows}</dl>
            <div style="display: flex; flex-direction: column; gap: 8px">
              <span style="font-size: 13px; font-weight: 600">${show(model.controllersTitle, ar)}</span>
              <ul aria-label="${escapeHtml(plain(model.controllersTitle))}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px">${controllers}</ul>
              <span style="font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${show(model.controllersNote, ar)}</span>
            </div>
          </section>
          <section aria-labelledby="svc-title" style="min-width: 0; display: flex; flex-direction: column; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 20px 24px 16px">
              <h2 id="svc-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.servicesTitle, ar)}</h2>
              <span style="font-size: 12px; color: #5D6B7E">${show(model.servicesMeta, ar)}</span>
            </div>
            <ul style="list-style: none; margin: 0; padding: 0; border-top: 1px solid #E2E6EC">${services}</ul>
            <div style="display: flex; padding: 8px 18px; border-top: 1px solid #EEF0F3">
              <a href="/whm/services" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: #1D5BD6">${show(model.servicesLink, ar)}</a>
            </div>
          </section>
        </div>
      </div>
    </div>
  </main>
</div>`
}

const mono = (text: string): string => `<span style="font-family: 'IBM Plex Mono', monospace">${escapeHtml(text)}</span>`

const running = (label = 'Running'): DashboardChip => ({ label, bg: '#E7F5EE', fg: '#0E7A4E', dot: '#0E7A4E', borderedDot: true })

export const whmDashboardFixture = (): WhmDashboardModel => ({
  locale: 'en',
  hostname: 'srv1.xpanel.test',
  username: 'root',
  versionLabel: 'v1.4.2',
  generationLabel: 'Generation 142 · active',
  generationTone: 'live',
  activeHref: '/whm',
  title: 'Server dashboard',
  crumbRoot: 'xWHM',
  crumbPage: 'Dashboard',
  ledeHost: 'srv1.xpanel.test',
  ledeRest: 'at a glance: the reconciler, accounts, resources and services. Updated ',
  ledeTime: '2026-10-22 14:05 UTC',
  ledeDatetime: '2026-10-22T14:05Z',
  createLabel: 'Create account',
  searchLabel: 'Search tools and accounts',
  searchPlaceholder: 'Search tools and accounts',
  notices: [
    { tone: 'warn', html: `<span><strong style="font-weight: 600">3 certificates renew within 30 days:</strong> ${mono('alice-shop.com')} (2026-11-04), ${mono('nour.dev')} (2026-11-12), ${mono('omar-clinic.net')} (2026-11-19). AutoSSL renews them; check any domain that no longer points here. <a href="/whm/ssl" style="color: #1D5BD6; font-weight: 600">Review certificates</a></span>` },
    { tone: 'info', html: `<span><strong style="font-weight: 600">Upgrade ${mono('v1.5.0')} is available</strong> (this server runs ${mono('v1.4.2')}). It installs side by side with a snapshot and a health check, and rolls back automatically if the check fails. Homes, mail and customer databases are not touched. <a href="/whm/upgrade" style="color: #1D5BD6; font-weight: 600">Review the upgrade</a></span>` },
  ],
  reconcilerTitle: 'Reconciler',
  reconcilerStatus: okChip('In sync'),
  reconcilerLede: 'The desired state equals the applied state. Every change is written as a new generation, tested, and switched only when the tests pass.',
  reconcilerTiles: [
    { label: 'Desired and applied', value: '142 = 142', note: 'Equal' },
    { label: 'Active generation', value: '142', note: 'Applied 13:48 UTC by root' },
    { label: 'Drift', value: '0', note: 'Checked 14:04 UTC' },
    { label: 'nginx -t', value: '', note: '13:48 UTC · generation 142', chip: okChip('Passed'), monoLabel: true },
    { label: 'apachectl configtest', value: '', note: 'Syntax OK · 13:48 UTC', chip: okChip('Passed'), monoLabel: true },
    { label: 'Rollback target', value: '141', note: 'Kept on disk' },
  ],
  driftButton: 'Check for drift now',
  driftLink: 'View generations in the audit log',
  driftStatus: '',
  resourcesTitle: 'Server resources',
  resourcesSampled: 'Sampled 14:05 UTC',
  meters: [
    { label: 'CPU', value: '28%', now: '28', pct: '28%', color: '#1D5BD6', note: 'Load 1.12 on 4 cores', noteColor: '#5D6B7E' },
    { label: 'Memory', value: '3.4 / 8 GB', now: '43', pct: '43%', color: '#1D5BD6', note: '4.6 GB available', noteColor: '#5D6B7E' },
    { label: 'Disk on /home', value: '142 / 400 GB', now: '36', pct: '36%', color: '#1D5BD6', note: 'Filesystem quotas enforced', noteColor: '#5D6B7E' },
    { label: 'Inodes on /home', value: '1.9 M / 26.2 M', now: '7', pct: '7%', color: '#1D5BD6', note: 'ext4', noteColor: '#5D6B7E' },
  ],
  resourcesFoot: 'Each account is limited inside its own <code style="font-family: \'IBM Plex Mono\', monospace">xpanel-&lt;uid&gt;.slice</code>, so one busy site cannot take the whole server.',
  auditTitle: 'Recent audit entries',
  auditWhen: 'Today, 2026-10-22 · times in UTC',
  auditHeads: ['Time', 'Actor', 'Action', 'Result'],
  audit: [
    { time: '13:48', datetime: '2026-10-22T13:48Z', actor: 'root', from: '203.0.113.7', action: 'Changed plan', target: 'alice: Starter → Business', result: okChip('Applied'), detail: 'Generation 142' },
    { time: '13:31', datetime: '2026-10-22T13:31Z', actor: 'reseller1', from: '198.51.100.24', action: 'Created account', target: 'omar · uid 20016 · omar-clinic.net', result: okChip('Applied'), detail: 'Generation 141' },
    { time: '13:02', datetime: '2026-10-22T13:02Z', actor: 'root', from: '203.0.113.7', action: 'Edited Nginx include', target: 'nour.dev', result: badChip('Test failed'), detail: 'nginx -t failed; generation 140 kept' },
    { time: '12:20', datetime: '2026-10-22T12:20Z', actor: 'root', from: '203.0.113.7', action: 'Added firewall rule', target: 'drop panel port from 0.0.0.0/0', result: badChip('Not saved'), detail: 'Would lock out 203.0.113.7' },
    { time: '11:05', datetime: '2026-10-22T11:05Z', actor: 'reseller1', from: '198.51.100.24', action: 'Suspended account', target: 'karim', result: okChip('Applied'), detail: 'Generation 140' },
  ],
  auditLink: 'Open the audit log',
  accountsTitle: 'Accounts',
  accountTiles: [
    { label: 'Active', value: '41', dot: '#0E7A4E' },
    { label: 'Suspended', value: '3', dot: '#B54708' },
    { label: 'Resellers', value: '2', dot: '#344054', ring: true },
  ],
  accountsSentence: '44 accounts in total. Resellers see only the accounts they own.',
  nearTitle: 'Near a limit',
  near: [
    { name: 'karim', note: 'Disk 92% of 5 GB', color: '#B42318' },
    { name: 'yousef', note: 'Disk 89% of 10 GB', color: '#B54708' },
  ],
  viewAccounts: 'View accounts',
  resellersLink: 'Resellers',
  hostTitle: 'Host',
  hostIp: '10.0.0.12',
  hostRows: [
    { label: 'System', value: 'Ubuntu 24.04.1 LTS', ddStyle: 'margin: 0' },
    { label: 'Kernel', value: '6.8.0-45-generic', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
    { label: 'Uptime', value: '41 days, 6 hours', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
    { label: 'Hardware', value: '4 cores · 8 GB', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
    { label: 'Engine', value: 'nginx 1.24.0 → apache2 2.4.58 · mpm-itk', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" },
    { label: 'xPanel', value: 'v1.4.2 · control schema 37', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
  ],
  controllersTitle: 'cgroup v2 controllers',
  controllers: ['cpu', 'io', 'memory', 'pids'],
  controllersNote: 'All plan limits are enforced on this host.',
  servicesTitle: 'Services',
  servicesMeta: '10 running · 1 not installed',
  services: [
    { name: 'Nginx', version: '1.24.0', note: '', status: running() },
    { name: 'Apache', version: '2.4.58 mpm-itk', note: 'Children run as the account UID', status: running() },
    { name: 'PHP-FPM', version: '8.1 · 8.2 · 8.3', note: '43 pools, each inside its account slice', status: running() },
    { name: 'MariaDB', version: '10.11.8', note: '', status: running() },
    { name: 'PostgreSQL', version: '16.4', note: 'Desired state of the panel', status: running() },
    { name: 'Postfix', version: '3.8.6', note: '', status: running() },
    { name: 'Dovecot', version: '2.3.21', note: '', status: running() },
    { name: 'PowerDNS', version: '4.8.3', note: '', status: running() },
    { name: 'Redis', version: '7.0.15', note: '', status: running() },
    { name: 'xpanel-agent', version: 'v1.4.2', note: 'The reconciler', status: running() },
    { name: 'ModSecurity', version: '', note: 'OWASP CRS is attached once it is installed', status: { label: 'Not installed', bg: '#EEF0F3', fg: '#344054', dot: 'transparent', borderedDot: true } },
  ],
  servicesLink: 'Manage services',
})

const domain = (name: string): string => `<bdi dir="ltr"><span style="font-family: 'IBM Plex Mono', monospace">${escapeHtml(name)}</span></bdi>`

export const whmDashboardFixtureAr = (): WhmDashboardModel => ({
  locale: 'ar',
  hostname: 'srv1.xpanel.test',
  username: 'root',
  versionLabel: 'v1.4.2',
  generationLabel: 'الجيل «142» · نشط',
  generationTone: 'live',
  activeHref: '/whm',
  title: 'لوحة الخادم',
  crumbRoot: 'xWHM',
  crumbPage: 'اللوحة',
  ledeHost: 'srv1.xpanel.test',
  ledeRest: 'نظرة على الموفّق والحسابات والموارد والخدمات. آخر تحديث ',
  ledeTime: '2026-10-22 14:05 UTC.',
  ledeDatetime: '2026-10-22T14:05Z',
  createLabel: 'إنشاء حساب',
  searchLabel: 'ابحث في الأدوات والحسابات',
  searchPlaceholder: 'ابحث في الأدوات والحسابات',
  notices: [
    { tone: 'warn', html: `<span><strong style="font-weight: 600"><bdi dir="ltr">3</bdi> شهادات تُجدَّد خلال <bdi dir="ltr">30</bdi> يوماً:</strong> ${domain('alice-shop.com')} <bdi dir="ltr">(2026-11-04)</bdi>، ${domain('nour.dev')} <bdi dir="ltr">(2026-11-12)</bdi>، ${domain('omar-clinic.net')} <bdi dir="ltr">(2026-11-19)</bdi>. يجددها <bdi dir="ltr">AutoSSL</bdi>؛ راجع أي نطاق لم يعد يشير إلى هنا. <a href="/whm/ssl" style="color: #1D5BD6; font-weight: 600">مراجعة الشهادات</a></span>` },
    { tone: 'info', html: `<span><strong style="font-weight: 600">الترقية <bdi dir="ltr">v1.5.0</bdi> متاحة</strong> (هذا الخادم يعمل <bdi dir="ltr">v1.4.2</bdi>). تُثبَّت إلى جانب لقطة وفحص سلامة، وتتراجع تلقائياً إذا فشل الفحص. لا تُمس المنازل ولا البريد ولا قواعد بيانات العملاء. <a href="/whm/upgrade" style="color: #1D5BD6; font-weight: 600">مراجعة الترقية</a></span>` },
  ],
  reconcilerTitle: 'الموفّق',
  reconcilerStatus: okChip('متزامن'),
  reconcilerLede: 'الحالة المطلوبة تساوي الحالة المطبّقة. كل تغيير يُكتب جيلاً جديداً، ويُختبر، ولا يُبدَّل إلا بعد نجاح الاختبارات.',
  reconcilerTiles: [
    { label: 'المطلوب والمطبّق', value: '142 = 142', note: 'متساويان' },
    { label: 'الجيل النشط', value: '142', note: 'طُبّق «13:48 UTC» بواسطة «root»' },
    { label: 'الانحراف', value: '0', note: 'فُحص «14:04 UTC»' },
    { label: 'nginx -t', value: '', note: '«13:48 UTC» · الجيل «142»', chip: okChip('نجح'), monoLabel: true },
    { label: 'apachectl configtest', value: '', note: 'الصياغة سليمة · «13:48 UTC»', chip: okChip('نجح'), monoLabel: true },
    { label: 'هدف التراجع', value: '141', note: 'محفوظ على القرص' },
  ],
  driftButton: 'افحص الانحراف الآن',
  driftLink: 'الأجيال في سجل التدقيق',
  driftStatus: '',
  resourcesTitle: 'موارد الخادم',
  resourcesSampled: 'العينة «14:05 UTC»',
  meters: [
    { label: 'المعالج', value: '28%', now: '28', pct: '28%', color: '#1D5BD6', note: 'الحمل «1.12» على «4» أنوية', noteColor: '#5D6B7E' },
    { label: 'الذاكرة', value: '3.4 / 8 GB', now: '43', pct: '43%', color: '#1D5BD6', note: '«4.6 GB» متاحة', noteColor: '#5D6B7E' },
    { label: 'القرص على «/home»', value: '142 / 400 GB', now: '36', pct: '36%', color: '#1D5BD6', note: 'حصص نظام الملفات مفروضة', noteColor: '#5D6B7E' },
    { label: 'العقد على «/home»', value: '1.9 M / 26.2 M', now: '7', pct: '7%', color: '#1D5BD6', note: '«ext4»', noteColor: '#5D6B7E' },
  ],
  resourcesFoot: 'كل حساب محصور داخل شريحته <bdi dir="ltr"><code style="font-family: \'IBM Plex Mono\', monospace">xpanel-&lt;uid&gt;.slice</code></bdi>، فلا يأخذ موقع واحد الخادم كله.',
  auditTitle: 'آخر التدقيق',
  auditWhen: 'اليوم، «2026-10-22» · الأوقات بتوقيت «UTC»',
  auditHeads: ['الوقت', 'الفاعل', 'الإجراء', 'النتيجة'],
  audit: [
    { time: '13:48', datetime: '2026-10-22T13:48Z', actor: 'root', from: '203.0.113.7', action: 'غيّر الخطة', target: 'alice: Starter → Business', result: okChip('مطبّق'), detail: 'الجيل «142»' },
    { time: '13:31', datetime: '2026-10-22T13:31Z', actor: 'reseller1', from: '198.51.100.24', action: 'أنشأ حساباً', target: 'omar · uid 20016 · omar-clinic.net', result: okChip('مطبّق'), detail: 'الجيل «141»' },
    { time: '13:02', datetime: '2026-10-22T13:02Z', actor: 'root', from: '203.0.113.7', action: 'عدّل تضمين «Nginx»', target: 'nour.dev', result: badChip('فشل الاختبار'), detail: 'فشل «nginx -t»؛ بقي الجيل «140»' },
    { time: '12:20', datetime: '2026-10-22T12:20Z', actor: 'root', from: '203.0.113.7', action: 'أضاف قاعدة جدار ناري', target: 'drop panel port from 0.0.0.0/0', result: badChip('لم يُحفظ'), detail: 'كانت ستحجب «203.0.113.7»' },
    { time: '11:05', datetime: '2026-10-22T11:05Z', actor: 'reseller1', from: '198.51.100.24', action: 'أوقف الحساب', target: 'karim', result: okChip('مطبّق'), detail: 'الجيل «140»' },
  ],
  auditLink: 'افتح سجل التدقيق',
  accountsTitle: 'الحسابات',
  accountTiles: [
    { label: 'النشطة', value: '41', dot: '#0E7A4E' },
    { label: 'الموقوفة', value: '3', dot: '#B54708' },
    { label: 'الموزعون', value: '2', dot: '#344054', ring: true },
  ],
  accountsSentence: '«44» حساباً في المجموع. الموزعون يرون الحسابات التي يملكونها فقط.',
  nearTitle: 'قرب الحد',
  near: [
    { name: 'karim', note: '«Disk 92% of 5 GB»', color: '#B42318' },
    { name: 'yousef', note: '«Disk 89% of 10 GB»', color: '#B54708' },
  ],
  viewAccounts: 'عرض الحسابات',
  resellersLink: 'الموزعون',
  hostTitle: 'المضيف',
  hostIp: '10.0.0.12',
  hostRows: [
    { label: 'النظام', value: 'Ubuntu 24.04.1 LTS', ddStyle: 'margin: 0' },
    { label: 'النواة', value: '6.8.0-45-generic', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
    { label: 'مدة التشغيل', value: '41 days, 6 hours', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
    { label: 'العتاد', value: '4 cores · 8 GB', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
    { label: 'المحرك', value: 'nginx 1.24.0 → apache2 2.4.58 · mpm\u2011itk', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" },
    { label: 'xPanel', value: 'v1.4.2 · control schema 37', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
  ],
  controllersTitle: 'متحكمات «cgroup v2»',
  controllers: ['cpu', 'io', 'memory', 'pids'],
  controllersNote: 'كل حدود الخطط مفروضة على هذا المضيف.',
  servicesTitle: 'الخدمات',
  servicesMeta: '«10» تعمل · «1» غير مثبّتة',
  services: [
    { name: 'Nginx', version: '1.24.0', note: '', status: running('يعمل') },
    { name: 'Apache', version: '2.4.58 mpm-itk', note: 'العمليات الفرعية تعمل بهوية الحساب', status: running('يعمل') },
    { name: 'PHP-FPM', version: '8.1 · 8.2 · 8.3', note: '«43» مجمعاً، كل منها داخل شريحة حسابه', status: running('يعمل') },
    { name: 'MariaDB', version: '10.11.8', note: '', status: running('يعمل') },
    { name: 'PostgreSQL', version: '16.4', note: 'الحالة المطلوبة للوحة', status: running('يعمل') },
    { name: 'Postfix', version: '3.8.6', note: '', status: running('يعمل') },
    { name: 'Dovecot', version: '2.3.21', note: '', status: running('يعمل') },
    { name: 'PowerDNS', version: '4.8.3', note: '', status: running('يعمل') },
    { name: 'Redis', version: '7.0.15', note: '', status: running('يعمل') },
    { name: 'xpanel-agent', version: 'v1.4.2', note: 'الموفّق', status: running('يعمل') },
    { name: 'ModSecurity', version: '', note: 'تُربط «OWASP CRS» بعد التثبيت', status: { label: 'غير مثبّت', bg: '#EEF0F3', fg: '#344054', dot: 'transparent', borderedDot: true } },
  ],
  servicesLink: 'إدارة الخدمات',
})

const countAccounts = (accounts: Account[] | undefined, status: Account['status']): string =>
  accounts ? String(accounts.filter(account => account.status === status).length) : '—'

const meterPercent = (used: number, total: number): { now: string; pct: string } => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return { now: '0', pct: '0%' }
  const value = Math.max(0, Math.min(100, Math.round((used / total) * 100)))
  return { now: String(value), pct: `${value}%` }
}

const certificateRows = (
  certificates: readonly Pick<Certificate, 'names' | 'notAfter'>[],
  now: number,
): { name: string; date: string; days: number }[] => {
  const rows: { name: string; date: string; days: number }[] = []
  for (const certificate of certificates) {
    const when = Date.parse(certificate.notAfter)
    if (!Number.isFinite(when)) continue
    const name = certificate.names.find(item => item.length > 0)
    if (!name) continue
    rows.push({ name, date: formatUtcDay(certificate.notAfter), days: Math.ceil((when - now) / 86_400_000) })
  }
  return rows
}

const arAccountCount = (count: number): string => {
  const rule = new Intl.PluralRules('ar').select(count)
  if (rule === 'zero') return 'لا حسابات'
  if (rule === 'one') return 'حساب واحد'
  if (rule === 'two') return 'حسابان'
  if (rule === 'few') return `«${count}» حسابات`
  return `«${count}» حساباً`
}

const arDayCount = (count: number): string => {
  const rule = new Intl.PluralRules('ar').select(count)
  if (rule === 'zero') return '«0» يوم'
  if (rule === 'one') return 'يوم واحد'
  if (rule === 'two') return 'يومان'
  if (rule === 'few') return `«${count}» أيام`
  return `«${count}» يوماً`
}

const arPlanCount = (count: number): string => {
  const rule = new Intl.PluralRules('ar').select(count)
  if (rule === 'zero') return ''
  if (rule === 'one') return ' وخطة واحدة'
  if (rule === 'two') return ' وخطتان'
  if (rule === 'few') return ` و«${count}» خطط`
  return ` و«${count}» خطة`
}

export const whmDashboardFromProps = (props: DashboardProps): WhmDashboardModel => {
  const locale: Locale = props.locale ?? 'en'
  const ar = locale === 'ar'
  const accounts = props.accounts
  const active = countAccounts(accounts, 'active')
  const suspended = countAccounts(accounts, 'suspended')
  const resellerCount = props.resellers ? String(props.resellers.length) : '—'
  const total = accounts ? accounts.length : null
  const planCount = props.plans ? props.plans.length : null
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const readableName = (value: string | undefined): string | null =>
    value && value !== 'Server' && value !== 'الخادم' ? value : null
  const hostname = readableName(props.hostSample?.hostname) ?? readableName(props.hostname) ?? '—'
  const panelDomain = readableName(props.hostSample?.panelDomain) ?? readableName(props.panelHostname)
  const panelRow = panelDomain && panelDomain !== hostname ? panelDomain : null
  const probedVersion = hostText(props.hostSample?.panelVersion)
  const version = probedVersion !== '—'
    ? probedVersion
    : (props.version && props.version !== 'Unavailable' && props.version !== 'غير متاح' ? props.version : '—')
  const ip = (props.ipPool ?? []).find((entry: ServerIpEntry) => entry.isPrimary)?.address ?? (props.ipPool ?? [])[0]?.address ?? '—'
  const serviceRoster = props.services ?? []
  const services = serviceRoster.map((service): DashboardServiceRow => ({
    name: service.name,
    version: service.version,
    note: '',
    status: service.checked === false
      ? emptyChip(ar ? 'غير مفحوص' : 'Not checked')
      : service.installed === false
        ? emptyChip(ar ? 'غير مثبت' : 'Not installed')
        : service.active ? running(ar ? 'يعمل' : 'Running') : emptyChip(ar ? 'متوقف' : 'Stopped'),
  }))
  const existingServices = serviceRoster.filter(service => service.checked !== false && service.installed !== false)
  const runningServices = existingServices.filter(service => service.active).length
  const driftKnown = typeof props.driftCount === 'number' && Number.isSafeInteger(props.driftCount) && props.driftCount >= 0
  const driftValue = driftKnown ? String(props.driftCount) : '—'
  const inSync = driftKnown && props.driftCount === 0 && generationId !== undefined
  const memory = props.hostSample?.memory
  const disk = props.hostSample?.disk
  const memoryMeter = memory && memory.totalBytes > 0
    ? meterPercent(memory.totalBytes - memory.availableBytes, memory.totalBytes)
    : { now: '0', pct: '0%' }
  const diskMeter = disk && disk.totalBytes > 0 ? meterPercent(disk.usedBytes, disk.totalBytes) : { now: '0', pct: '0%' }
  const finiteLoad = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const loadParts = [finiteLoad(props.hostSample?.load1), finiteLoad(props.hostSample?.load5), finiteLoad(props.hostSample?.load15)].filter((value): value is number => value !== null)
  const loadValue = loadParts.length > 0 ? loadParts.map(value => value.toFixed(2)).join(' / ') : null
  const cores = typeof props.hostSample?.cores === 'number' && Number.isInteger(props.hostSample.cores) && props.hostSample.cores >= 1 ? props.hostSample.cores : null
  const cpuModel = props.hostSample?.cpuModel && props.hostSample.cpuModel.length > 0 ? props.hostSample.cpuModel : null
  const inodes = props.hostSample?.inodes && props.hostSample.inodes.total > 0 && props.hostSample.inodes.used >= 0 && props.hostSample.inodes.used <= props.hostSample.inodes.total
    ? props.hostSample.inodes
    : null
  const homeOnRoot = inodes ? inodes.homeOnRoot === true || inodes.mount === '/' : false
  const listedCertificates = props.certificates === undefined ? null : certificateRows(props.certificates, props.now ?? Date.now())
  const soon = listedCertificates?.filter(item => item.days < 30) ?? []
  const certificateNotice: DashboardNotice = listedCertificates === null
    ? { tone: 'info', html: '<span>—</span>' }
    : listedCertificates.length === 0
      ? { tone: 'info', html: `<span>${ar ? rich('لا شهادات تُجدَّد خلال «30» يوماً.') : escapeHtml('No certificates renew within 30 days.')}</span>` }
      : {
          tone: soon.length > 0 ? 'warn' : 'info',
          html: `<span>${soon.length > 0
            ? (ar
              ? rich(soon.length === 1 ? '«1» شهادة تُجدَّد خلال «30» يوماً:' : `«${soon.length}» شهادات تُجدَّد خلال «30» يوماً:`)
              : escapeHtml(soon.length === 1 ? '1 certificate renews within 30 days:' : `${soon.length} certificates renew within 30 days:`))
            : ''} ${listedCertificates.map(item => {
            if (ar) return `<bdi dir="ltr">${mono(item.name)}</bdi> · ${rich(arDayCount(item.days))} <bdi dir="ltr">(${escapeHtml(item.date)})</bdi>`
            return `${mono(item.name)} · ${escapeHtml(item.days === 1 ? '1 day' : `${item.days} days`)} (${mono(item.date)})`
          }).join(', ')}</span>`,
        }
  const planPhrase = planCount === null
    ? ''
    : ar
      ? arPlanCount(planCount)
      : (planCount === 1 ? ' and 1 plan' : ` and ${planCount} plans`)
  const accountsSentence = total === null
    ? '—'
    : ar
      ? `${arAccountCount(total)}${planPhrase}. الموزعون يرون الحسابات التي يملكونها فقط.`
      : `${total} ${total === 1 ? 'account' : 'accounts'}${planPhrase}. Resellers see only the accounts they own.`
  const audit = (props.auditEntries ?? []).slice(0, 8).map((entry: AuditEntry): DashboardAuditRow => {
    const target = auditTargetLabel(entry.target, locale)
    const outcome = auditOutcomeLabel(entry.action, entry.outcome, locale)
    const chip = entry.outcome === 'ok'
      ? okChip(outcome)
      : entry.outcome === 'denied'
        ? emptyChip(outcome)
        : badChip(outcome)
    return {
      time: formatUtcClock(entry.at),
      datetime: entry.at,
      actor: entry.actor,
      from: '—',
      action: auditActionLabel(entry.action, locale),
      target,
      result: chip,
      detail: target,
    }
  })
  const sampledAt = props.hostSample?.sampledAt && !Number.isNaN(Date.parse(props.hostSample.sampledAt)) ? props.hostSample.sampledAt : ''
  const utcMinute = (iso: string): string => formatAsciiDate(iso, { includeTime: true }).replace(/:\d{2} UTC$/, ' UTC')
  const clock = (iso: string): string => formatUtcClock(iso)
  const rollbackId = typeof props.rollbackGenerationId === 'number' && Number.isSafeInteger(props.rollbackGenerationId) && props.rollbackGenerationId > 0
    ? props.rollbackGenerationId
    : null
  const configTile = (label: string, check: { ok: boolean; at: string } | undefined, kind: 'nginx' | 'apache') => {
    if (!check) return { label, value: '', note: '—', chip: emptyChip('—'), monoLabel: true }
    const when = clock(check.at)
    if (!check.ok) return { label, value: '', note: ar ? `«${when}»` : when, chip: badChip(ar ? 'فشل' : 'Failed'), monoLabel: true }
    if (kind === 'apache') {
      return { label, value: '', note: ar ? `الصياغة سليمة · «${when}»` : `Syntax OK · ${when}`, chip: okChip(ar ? 'نجح' : 'Passed'), monoLabel: true }
    }
    const note = generationId !== undefined
      ? (ar ? `«${when}» · الجيل «${generationId}»` : `${when} · generation ${generationId}`)
      : (ar ? `«${when}»` : when)
    return { label, value: '', note, chip: okChip(ar ? 'نجح' : 'Passed'), monoLabel: true }
  }
  const emptyAudit: DashboardAuditRow = { time: '—', datetime: '', actor: '—', from: '—', action: '—', target: '—', result: emptyChip('—'), detail: '—' }
  const emptyService: DashboardServiceRow = { name: '—', version: '', note: '', status: emptyChip('—') }
  const meter = (label: string): DashboardMeter => ({ label, value: '—', now: '0', pct: '0%', color: '#1D5BD6', note: '—', noteColor: '#5D6B7E' })
  return {
    locale,
    hostname,
    username: props.principal?.username ?? '—',
    versionLabel: version,
    generationLabel: generationId !== undefined ? (ar ? `الجيل «${generationId}» · نشط` : `Generation ${generationId} · active`) : '—',
    generationTone: generationId !== undefined ? 'live' : 'empty',
    activeHref: '/whm',
    title: ar ? 'لوحة الخادم' : 'Server dashboard',
    crumbRoot: 'xWHM',
    crumbPage: ar ? 'اللوحة' : 'Dashboard',
    ledeHost: hostname,
    ledeRest: ar ? 'نظرة على الموفّق والحسابات والموارد والخدمات. آخر تحديث ' : 'at a glance: the reconciler, accounts, resources and services. Updated ',
    ledeTime: sampledAt ? utcMinute(sampledAt) : '—',
    ledeDatetime: sampledAt ? new Date(sampledAt).toISOString() : '',
    signOutLabel: ar ? 'تسجيل الخروج' : 'Sign out',
    createLabel: ar ? 'إنشاء حساب' : 'Create account',
    searchLabel: ar ? 'ابحث في الأدوات والحسابات' : 'Search tools and accounts',
    searchPlaceholder: ar ? 'ابحث في الأدوات والحسابات' : 'Search tools and accounts',
    notices: [
      certificateNotice,
      { tone: 'info', html: `<span>${escapeHtml(ar ? 'لا ترقية منشورة.' : 'No upgrade is published.')} ${props.availableVersion ? mono(props.availableVersion) : ''}</span>` },
    ],
    reconcilerTitle: ar ? 'الموفّق' : 'Reconciler',
    reconcilerStatus: inSync ? okChip(ar ? 'متزامن' : 'In sync') : emptyChip('—'),
    reconcilerLede: ar ? 'الحالة المطلوبة تساوي الحالة المطبّقة عندما ينجح الفحص.' : 'The desired state equals the applied state when the drift check reports none.',
    reconcilerTiles: [
      { label: ar ? 'المطلوب والمطبّق' : 'Desired and applied', value: inSync ? `${generationId} = ${generationId}` : '—', note: inSync ? (ar ? 'متساويان' : 'Equal') : '—' },
      { label: ar ? 'الجيل النشط' : 'Active generation', value: generationId !== undefined ? String(generationId) : '—', note: props.generationActivatedAt && !Number.isNaN(Date.parse(props.generationActivatedAt)) ? (ar ? `فُعّل «${clock(props.generationActivatedAt)}»` : `Activated ${clock(props.generationActivatedAt)}`) : '—' },
      { label: ar ? 'الانحراف' : 'Drift', value: driftValue, note: '—' },
      configTile('nginx -t', props.hostSample?.nginxTest, 'nginx'),
      configTile('apachectl configtest', props.hostSample?.apacheTest, 'apache'),
      { label: ar ? 'هدف التراجع' : 'Rollback target', value: rollbackId ? String(rollbackId) : '—', note: rollbackId ? (ar ? 'الجيل السابق' : 'Previous generation') : '—' },
    ],
    driftButton: ar ? 'افحص الانحراف الآن' : 'Check for drift now',
    driftLink: ar ? 'الأجيال في سجل التدقيق' : 'View generations in the audit log',
    driftStatus: '',
    resourcesTitle: ar ? 'موارد الخادم' : 'Server resources',
    resourcesSampled: sampledAt ? (ar ? `العينة «${clock(sampledAt)}»` : `Sampled ${clock(sampledAt)}`) : '—',
    meters: [
      loadValue === null
        ? meter(ar ? 'المعالج' : 'CPU')
        : {
            label: ar ? 'المعالج' : 'CPU',
            value: loadValue,
            now: '',
            pct: '0%',
            color: '#1D5BD6',
            note: cores
              ? (ar ? `«${cores}» ${arUnit(cores, 'نواة', 'نواتين', 'أنوية', 'نواة')}` : `${cores} ${cores === 1 ? 'core' : 'cores'}`)
              : (ar ? `الحمل «${loadValue}»` : `load ${loadValue}`),
            noteColor: '#5D6B7E',
            showBar: false,
          },
      memory && memory.totalBytes > 0
        ? { label: ar ? 'الذاكرة' : 'Memory', value: `${formatBytes(memory.totalBytes - memory.availableBytes)} / ${formatBytes(memory.totalBytes)}`, ...memoryMeter, color: '#1D5BD6', note: ar ? `«${formatBytes(memory.availableBytes)}» متاحة` : `${formatBytes(memory.availableBytes)} available`, noteColor: '#5D6B7E' }
        : meter(ar ? 'الذاكرة' : 'Memory'),
      disk && disk.totalBytes > 0
        ? { label: ar ? `القرص على «${disk.mount}»` : `Disk on ${disk.mount}`, value: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`, ...diskMeter, color: '#1D5BD6', note: diskMeter.pct, noteColor: '#5D6B7E' }
        : meter(ar ? 'القرص على «/home»' : 'Disk on /home'),
      inodes
        ? {
            label: homeOnRoot ? (ar ? 'العقد على «/»' : 'Inodes on /') : (ar ? `العقد على «${inodes.mount}»` : `Inodes on ${inodes.mount}`),
            value: `${formatAsciiNumber(inodes.used)} / ${formatAsciiNumber(inodes.total)}`,
            ...meterPercent(inodes.used, inodes.total),
            color: '#1D5BD6',
            note: homeOnRoot ? (ar ? '«/home» على «/»' : '/home is on /') : '—',
            noteColor: '#5D6B7E',
          }
        : meter(ar ? 'العقد على «/home»' : 'Inodes on /home'),
    ],
    resourcesFoot: ar
      ? 'كل حساب محصور داخل شريحته <bdi dir="ltr"><code style="font-family: \'IBM Plex Mono\', monospace">xpanel-&lt;uid&gt;.slice</code></bdi>، فلا يأخذ موقع واحد الخادم كله.'
      : 'Each account is limited inside its own <code style="font-family: \'IBM Plex Mono\', monospace">xpanel-&lt;uid&gt;.slice</code>, so one busy site cannot take the whole server.',
    auditTitle: ar ? 'آخر التدقيق' : 'Recent audit entries',
    auditWhen: audit.length ? (ar ? 'الأوقات بتوقيت «UTC»' : 'Times in UTC') : '—',
    auditHeads: ar ? ['الوقت', 'الفاعل', 'الإجراء', 'النتيجة'] : ['Time', 'Actor', 'Action', 'Result'],
    audit: audit.length ? audit : [emptyAudit],
    auditLink: ar ? 'افتح السجل' : 'Open the audit log',
    accountsTitle: ar ? 'الحسابات' : 'Accounts',
    accountTiles: [
      { label: ar ? 'النشطة' : 'Active', value: active, dot: '#0E7A4E' },
      { label: ar ? 'الموقوفة' : 'Suspended', value: suspended, dot: '#B54708' },
      { label: ar ? 'الموزعون' : 'Resellers', value: resellerCount, dot: '#344054', ring: true },
    ],
    accountsSentence,
    nearTitle: ar ? 'قرب الحد' : 'Near a limit',
    near: props.nearLimits === undefined
      ? [{ name: '—', note: '—', color: '#5D6B7E' }]
      : props.nearLimits.length === 0
        ? [{ name: ar ? 'لا حسابات قرب الحد' : 'None', note: '—', color: '#5D6B7E' }]
        : props.nearLimits.map(row => ({ name: row.name, note: row.note, color: '#B54708' })),
    viewAccounts: ar ? 'عرض الحسابات' : 'View accounts',
    resellersLink: ar ? 'الموزعون' : 'Resellers',
    hostTitle: ar ? 'المضيف' : 'Host',
    hostIp: ip,
    hostRows: [
      { label: ar ? 'النظام' : 'System', value: hostText(props.hostSample?.system), ddStyle: 'margin: 0' },
      { label: ar ? 'النواة' : 'Kernel', value: hostText(props.hostSample?.kernel), ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
      { label: ar ? 'مدة التشغيل' : 'Uptime', value: typeof props.hostSample?.uptimeSeconds === 'number' && Number.isFinite(props.hostSample.uptimeSeconds) && props.hostSample.uptimeSeconds >= 0 ? formatUptime(Math.floor(props.hostSample.uptimeSeconds), ar) : '—', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      { label: ar ? 'العتاد' : 'Hardware', value: hardwareLine(cores, cpuModel, memory && memory.totalBytes > 0 ? formatBytes(memory.totalBytes) : null, ar), ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      { label: ar ? 'المحرك' : 'Engine', value: hostText(props.hostSample?.engine), ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" },
      { label: 'xPanel', value: version, ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
      ...(panelRow ? [{ label: ar ? 'نطاق اللوحة' : 'Panel domain', value: panelRow, ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" }] : []),
    ],
    controllersTitle: ar ? 'متحكمات «cgroup v2»' : 'cgroup v2 controllers',
    controllers: ['cpu', 'io', 'memory', 'pids'],
    controllersNote: ar ? 'حدود الخطط تُفرَض على هذا المضيف عندما يبلغ عنها.' : 'All plan limits are enforced on this host.',
    servicesTitle: ar ? 'الخدمات' : 'Services',
    servicesMeta: serviceRoster.length ? (ar ? `«${runningServices} / ${existingServices.length}»` : `${runningServices} / ${existingServices.length}`) : '—',
    services: services.length ? services : [emptyService],
    servicesLink: ar ? 'إدارة الخدمات' : 'Manage services',
  }
}

const documentShell = (model: WhmDashboardModel): string => {
  const ar = model.locale === 'ar'
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${ar ? 'لوحة الخادم — xWHM' : 'Server dashboard — xWHM'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
*{box-sizing:border-box}
a{color:#1D5BD6}a:hover{color:#1546A8}
:focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
nav[aria-label="xWHM navigation"] :focus-visible{outline-color:#6EA0FF}
${ARABIC_TYPE_CSS}
</style>
</head>
<body>
${renderWhmDashboard(model)}
</body>
</html>`
}

export const renderFidelityDocument = (dir: 'ltr' | 'rtl' = 'ltr'): string =>
  documentShell(dir === 'rtl' ? whmDashboardFixtureAr() : whmDashboardFixture())

export const renderLiveDocument = (dir: 'ltr' | 'rtl' = 'ltr'): string =>
  documentShell(whmDashboardFromProps({ locale: dir === 'rtl' ? 'ar' : 'en', principal: { username: 'root' } }))
