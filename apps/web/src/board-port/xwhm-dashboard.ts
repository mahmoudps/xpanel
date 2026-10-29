import { canOpenRegisteredRoute, type VisibilityContext } from '@xpanel/catalog'
import type { Account, AuditEntry, Certificate, HostLimitObservation, Plan, ServerIpEntry } from '@xpanel/core'
import { ARABIC_TYPE_CSS, isArabicSentence } from '../arabic-type.ts'
import { isolateLtrRuns } from '../bidi-runs.ts'
import { auditActionHtml, auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../audit-labels.ts'
import { LOCALES, localeDirection, translator, type Locale, type Translate } from '../i18n.ts'
import { renderLiveUpdatesIndicator, renderPageSearchButton, renderMobileNavToggle, renderMobileNavClose, renderMobileNavBackdrop } from '../shell.ts'
import { escapeHtml, formatDisplayDateTime, formatAsciiNumber, formatBytes, formatUtcClock, formatUtcDay } from '../tokens.ts'


// Preserve the approved light swatches; dark paint uses the existing semantic theme roles.
// Fixed brand/logo colors are kept by their rendering sites.
type HomeColorRole = 'ink' | 'surface' | 'border'
const HOME_THEME_ROLES: Record<HomeColorRole, Readonly<Record<string, string>>> = {
  "ink": {
    "#101828": "--xp-text-primary",
    "#344054": "--xp-text-secondary",
    "#475467": "--xp-text-secondary",
    "#5D6B7E": "--xp-text-muted",
    "#98A2B3": "--xp-text-muted",
    "#8A99AF": "--xp-text-muted",
    "#C9D3E1": "--xp-text-secondary",
    "#1D5BD6": "--xp-accent",
    "#1546A8": "--xp-accent-hover",
    "#0E7A4E": "--xp-status-ok-fg",
    "#B54708": "--xp-status-warn-fg",
    "#B42318": "--xp-status-critical-fg"
  },
  "surface": {
    "#F5F6F8": "--xp-bg-canvas",
    "#FFFFFF": "--xp-bg-surface",
    "#F8F9FB": "--xp-bg-elevated",
    "#EEF0F3": "--xp-bg-elevated",
    "#E9ECF1": "--xp-border",
    "#E8EFFD": "--xp-accent-soft",
    "#F3F7FE": "--xp-accent-soft",
    "#E7F5EE": "--xp-status-ok-bg",
    "#FDECEA": "--xp-status-critical-bg",
    "#FFF6EE": "--xp-status-warn-bg",
    "#10182866": "--xp-nav-backdrop"
  },
  "border": {
    "#E2E6EC": "--xp-border",
    "#EEF0F3": "--xp-border",
    "#D0D5DD": "--xp-border-strong",
    "#C9CFD8": "--xp-border-strong",
    "#E8EFFD": "--xp-accent-border",
    "#C7D7F8": "--xp-accent-border",
    "#F9C9A0": "--xp-status-warn-border",
    "#1D5BD6": "--xp-border-focus"
  }
}
const themeColor = (value: string, role: HomeColorRole = 'ink'): string => {
  const token = HOME_THEME_ROLES[role][value.toUpperCase()]
  return token ? `light-dark(${value},var(${token},${value}))` : value
}

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
  /** Plan controllers present in cgroup.subtree_control. Absent when that file was not read. */
  enforcedLimits?: { cpu: boolean; memory: boolean; io: boolean; pids: boolean }
  observedLimits?: HostLimitObservation
}

interface DashboardProps {
  visibility?: VisibilityContext
  locale?: Locale
  theme?: 'light' | 'dark'
  realtimeEnabled?: boolean
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
  /** When the host last answered the drift check. Empty when that read failed. */
  driftCheckedAt?: string | null
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
  /** Escaped action sentence. Fixture rows leave this empty and use `action`. */
  actionHtml?: string
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
  visibility?: VisibilityContext
  locale: Locale
  theme: 'light' | 'dark'
  realtimeEnabled: boolean
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
  /** Whole lede message; {host} and {time} mark where the hostname and the sample time go. */
  lede: string
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

const NAV: Array<{ id: string; label: string; items: Array<{ href: string; label: string; icon: string }> }> = [
  { id: 'nav-g-server', label: msgid('Server'), items: [
    { href: '/whm', label: msgid('Dashboard'), icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>' },
    { href: '/whm/server/setup', label: msgid('Setup wizard'), icon: '<path d="M9 6h11M9 12h11M9 18h11"></path><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"></path>' },
  ] },
  { id: 'nav-g-accounts', label: msgid('Accounts'), items: [
    { href: '/whm/accounts', label: msgid('Accounts'), icon: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.4 3.5 5.2"></path>' },
    { href: '/whm/accounts/new', label: msgid('Create account'), icon: '<circle cx="10" cy="8" r="3.5"></circle><path d="M3.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M19 8v6M16 11h6"></path>' },
    { href: '/whm/plans', label: msgid('Plans'), icon: '<path d="M12 3l9 5-9 5-9-5z"></path><path d="M3 13l9 5 9-5"></path>' },
    { href: '/whm/plans/features', label: msgid('Feature lists'), icon: '<rect x="3" y="7" width="18" height="10" rx="5"></rect><circle cx="16" cy="12" r="2.5"></circle>' },
    { href: '/whm/resellers', label: msgid('Resellers'), icon: '<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"></path>' },
    { href: '/whm/domains', label: msgid('Domains'), icon: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"></path>' },
  ] },
  { id: 'nav-g-web', label: msgid('Web'), items: [
    { href: '/whm/services/web', label: msgid('Web server'), icon: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>' },
    { href: '/whm/software/php', label: 'PHP', icon: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"></path>' },
    { href: '/whm/ssl', label: msgctxt('xwhm-dashboard', 'SSL/TLS'), icon: '<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>' },
    { href: '/whm/dns', label: msgctxt('xwhm-dashboard', 'DNS zones'), icon: '<circle cx="12" cy="5" r="2"></circle><circle cx="5" cy="19" r="2"></circle><circle cx="19" cy="19" r="2"></circle><path d="M12 7v5M12 12l-5.5 5.5M12 12l5.5 5.5"></path>' },
    { href: '/whm/services', label: msgid('Services'), icon: '<path d="M3 12h4l3-8 4 16 3-8h4"></path>' },
  ] },
  { id: 'nav-g-security', label: msgid('Security'), items: [
    { href: '/whm/security/firewall', label: msgid('Firewall'), icon: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"></path>' },
    { href: '/whm/security', label: msgid('Panel security'), icon: '<circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9M17 6l3 3M14 9l2 2"></path>' },
    { href: '/whm/security/ssh', label: 'SSH', icon: '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M7 9l3 3-3 3M13 15h4"></path>' },
  ] },
  { id: 'nav-g-ops', label: msgid('Operations'), items: [
    { href: '/whm/backups', label: msgctxt('xwhm-dashboard', 'Backups'), icon: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"></path>' },
    { href: '/whm/transfers', label: msgid('Transfer tool'), icon: '<path d="M4 8h14l-4-4M20 16H6l4 4"></path>' },
    { href: '/whm/server/upgrade', label: msgid('Upgrade'), icon: '<circle cx="12" cy="12" r="9"></circle><path d="M12 16V8M8.5 11.5L12 8l3.5 3.5"></path>' },
    { href: '/whm/audit', label: msgid('Audit log'), icon: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"></path><path d="M14 3v5h5M8.5 13h7M8.5 17h7"></path>' },
  ] },
]

const plain = (value: string): string => value.replace(/«|»/g, '')

// Counts are inserted as `{name}`, not `#`: locale number formatting would add grouping and bidi marks.
const DAYS = msgid('{days, plural, one {{days} day} other {{days} days}}')
const HOURS = msgid('{hours, plural, one {{hours} hour} other {{hours} hours}}')
const MINUTES = msgid('{minutes, plural, one {{minutes} minute} other {{minutes} minutes}}')
const CORES = msgid('{cores, plural, one {{cores} core} other {{cores} cores}}')
const CERTIFICATES_SOON = msgid('{count, plural, one {{count} certificate renews within 30 days:} other {{count} certificates renew within 30 days:}}')
const ACCOUNTS_SENTENCE = msgid('{accounts, plural, one {{accounts} account} other {{accounts} accounts}}. Resellers see only the accounts they own.')
const ACCOUNTS_PLANS_SENTENCE = msgid('{accounts, plural, one {{accounts} account} other {{accounts} accounts}} and {plans, plural, one {{plans} plan} other {{plans} plans}}. Resellers see only the accounts they own.')

/** Days and hours from a probed uptime. A missing reading stays empty at the call site. */
const formatUptime = (seconds: number, t: Translate): string => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0 && hours > 0) return t('{days}, {hours}', { days: t(DAYS, { days }), hours: t(HOURS, { hours }) })
  if (days > 0) return t(DAYS, { days })
  if (hours > 0) return t(HOURS, { hours })
  return t(MINUTES, { minutes })
}

const hostText = (value: string | undefined): string => value && value.length > 0 ? value : '—'

const hardwareLine = (cores: number | null, model: string | null, bytes: string | null, t: Translate): string => {
  // RTL lines mark Latin values with «» so `show` isolates each one.
  const isolated = (value: string): string => localeDirection(t.locale) === 'rtl' ? `«${value}»` : value
  const parts = [
    cores === null ? '' : t(CORES, { cores }),
    model ? isolated(model) : '',
    bytes ? isolated(bytes) : '',
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
  const limits = agentRecord(identity?.enforcedLimits)
  const limitFlag = (key: string): boolean | undefined => typeof limits?.[key] === 'boolean' ? limits[key] as boolean : undefined
  const cpuEnforced = limitFlag('cpu')
  const memoryEnforced = limitFlag('memory')
  const ioEnforced = limitFlag('io')
  const pidsEnforced = limitFlag('pids')
  const enforcedLimits = cpuEnforced !== undefined && memoryEnforced !== undefined && ioEnforced !== undefined && pidsEnforced !== undefined
    ? { cpu: cpuEnforced, memory: memoryEnforced, io: ioEnforced, pids: pidsEnforced }
    : undefined
  const observed = agentRecord(identity?.observedLimits)
  const checked = agentNumber(observed, 'checkedAccounts'), unread = agentNumber(observed, 'unavailableAccounts')
  const gapKeys = new Set(['memory', 'pids', 'io', 'cpu', 'disk'])
  const gaps = Array.isArray(observed?.gaps) && observed.gaps.every(value => typeof value === 'string' && gapKeys.has(value)) ? observed.gaps as HostLimitObservation['gaps'] : undefined
  const status = observed?.status
  const observedLimits: HostLimitObservation | undefined = checked !== undefined && unread !== undefined && Number.isSafeInteger(checked) && Number.isSafeInteger(unread) && checked >= 0 && unread >= 0 && gaps
    && (status === 'unavailable' || (checked > 0 && unread === 0 && (status === 'verified' && gaps.length === 0 || status === 'gaps' && gaps.length > 0)))
    ? { status, checkedAccounts: checked, unavailableAccounts: unread, gaps } : undefined
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
    ...(enforcedLimits ? { enforcedLimits } : {}),
    ...(observedLimits ? { observedLimits } : {}),
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

/** LTR stays escaped text so the approved LTR pixels do not move. RTL isolates Latin tokens and dates. */
const show = (value: string, rtl: boolean): string => {
  if (!rtl) return escapeHtml(value)
  if (value.includes('«')) return rich(value)
  if (/[\u0600-\u06FF]/.test(value)) return isolateLtrRuns(value)
  return ltr(value)
}

/** Identifiers stay mono. A whole Arabic sentence uses the sans stack, not a per-glyph fallback. */
const monoSpan = (plain: string, inner: string, style: string): string => {
  if (!isArabicSentence(plain)) return `<span style="${style}">${inner}</span>`
  const sans = style.replace("'IBM Plex Mono', monospace", "sans-serif")
  return `<span class="xp-ar-sentence" style="${sans}">${inner}</span>`
}

const pill = (chip: DashboardChip, mono = false): string => {
  const dot = chip.dot ?? chip.fg
  const border = chip.borderedDot ? `border: 1.5px solid ${themeColor(chip.fg)};` : ''
  const font = mono ? " font-family: 'IBM Plex Mono', monospace;" : ''
  return `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${themeColor(chip.bg, 'surface')}; color: ${themeColor(chip.fg)}; font-size: 12px; font-weight: 600;${font}"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${themeColor(dot)}; ${border}"></span>${escapeHtml(chip.label)}</span>`
}

const linkStyle = 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; color: light-dark(#C9D3E1,var(--xp-text-secondary,#C9D3E1)); text-decoration: none; font-size: 14px'
const activeStyle = 'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset 3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'

const canOpen = (model: WhmDashboardModel, route: string): boolean => canOpenRegisteredRoute(route, model.visibility)

const navHtml = (model: WhmDashboardModel): string => {
  const rtl = localeDirection(model.locale) === 'rtl'
  const t = translator(model.locale)
  const active = rtl
    ?'display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset -3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'
    : activeStyle
  const groups = NAV.map(group => {
    const admitted = group.items.filter(item => canOpen(model, item.href))
    if (admitted.length === 0) return ''
    const items = admitted.map(item => {
      const current = item.href === model.activeHref
      const label = show(t(item.label), rtl)
      const labelBody = label.includes('<') ? `<span>${label}</span>` : label
      return `<li><a href="${item.href}" data-nav-route="${item.href}"${current ? ' aria-current="page"' : ''} style="${current ? active : linkStyle}">${svg(item.icon)}${labelBody}</a></li>`
    }).join('')
    return `<div style="display: flex; flex-direction: column; gap: 4px">
      <span id="${group.id}" style="padding: 0 12px; font-size: 11px; font-weight: 600; color: #8A99AF; line-height: 1.6">${show(t(group.label), rtl)}</span>
      <ul aria-labelledby="${group.id}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${items}</ul>
    </div>`
  }).join('')
  const brand = rtl ? '<bdi dir="ltr">xWHM</bdi>' : 'xWHM'
  return `<nav class="xp-sidebar" id="xp-sidebar" tabindex="-1" data-xp-sidebar aria-label="xWHM navigation" style="flex: 1 1 248px; max-width: 100%; background: #0E1726; color: #C9D3E1; padding: 20px 14px; display: flex; flex-direction: column; gap: 18px">
    ${renderMobileNavClose(model.locale)}
    <div style="display: flex; align-items: center; gap: 10px; padding: 0 6px">
      <span aria-hidden="true" style="flex: none; width: 36px; height: 36px; border-radius: 8px; background: #1D5BD6; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 500">x</span>
      <div style="display: flex; flex-direction: column; min-width: 0">
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 500; color: #FFFFFF; line-height: 1.3">${brand}</span>
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #8A99AF; line-height: 1.3">${show(model.hostname, rtl).replaceAll('<bdi dir="ltr">', '<bdi dir="ltr" style="overflow-wrap: anywhere">')}</span>
      </div>
    </div>
    ${groups}
  </nav>`
}

const headerHtml = (model: WhmDashboardModel): string => {
  const rtl = localeDirection(model.locale) === 'rtl'
  const genBg = model.generationTone === 'live' ? '#E7F5EE' : '#EEF0F3'
  const genFg = model.generationTone === 'live' ? '#0E7A4E' : '#344054'
  const initial = escapeHtml((model.username.slice(0, 1) || '—').toLowerCase())
  const generation = show(model.generationLabel, rtl)
  const generationBody = generation.includes('<bdi') ? `<span>${generation}</span>` : generation
  const lang = LOCALES.filter(info => info.tag !== model.locale).map(info =>
    `<a href="?lang=${info.tag}" data-lang-switch="${info.tag}" lang="${info.tag}" hreflang="${info.tag}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: ${info.dir === 'rtl' ? 'sans-serif' : "'IBM Plex Sans', sans-serif"}; font-size: 14px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); text-decoration: none">${escapeHtml(info.nativeName)}</a>`).join('')
  return `<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 32px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border-bottom: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
      ${renderMobileNavToggle(model.locale)}
      <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px; display: flex; align-items: center">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; inset-inline-start: 12px; pointer-events: none"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
        <input type="search" aria-label="${escapeHtml(model.searchLabel)}" placeholder="${escapeHtml(model.searchPlaceholder)}" style="width: 100%; min-height: 44px; padding-inline-start: 36px; padding-inline-end: 40px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB)); font-family: inherit; font-size: 14px; color: light-dark(#101828,var(--xp-text-primary,#101828))">
        <kbd aria-hidden="true" style="position: absolute; inset-inline-end: 8px; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: light-dark(#475467,var(--xp-text-secondary,#475467))">/</kbd>
      </div>
      <span style="flex: 1 1 0"></span>
      <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${themeColor(genBg, 'surface')}; color: ${themeColor(genFg)}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${themeColor(genFg)}"></span>${generationBody}</span>
      <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: light-dark(#EEF0F3,var(--xp-bg-elevated,#EEF0F3)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(model.versionLabel, rtl)}</span>
      ${renderPageSearchButton(model.locale)}
      ${renderLiveUpdatesIndicator(model.locale, model.realtimeEnabled)}
      ${lang}
      <a href="?theme=${model.theme === 'dark' ? 'light' : 'dark'}" data-theme-toggle="${model.theme === 'dark' ? 'light' : 'dark'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); text-decoration: none">${model.theme === 'dark' ? (translator(model.locale)('Light theme')) : (translator(model.locale)('Dark theme'))}</a>
      ${model.signOutLabel ? `<button type="button" data-action="logout" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${escapeHtml(model.signOutLabel)}</button>` : ''}
      <button type="button" aria-label="${escapeHtml(translator(model.locale)('User menu for {username}', { username: model.username }))}" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding-block: 0; padding-inline: 6px 12px; border-radius: 999px; border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#101828,var(--xp-text-primary,#101828)); font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; cursor: pointer"><span aria-hidden="true" style="width: 32px; height: 32px; border-radius: 50%; background: #0E1726; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 13px">${initial}</span>${show(model.username, rtl)}</button>
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
  return `<div style="flex: 1 1 360px; min-width: 0; display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid ${themeColor(border, 'border')}; background: ${themeColor(bg, 'surface')}; font-size: 13px; line-height: 1.6"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${themeColor(stroke)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-top: 2px">${icon}</svg>${notice.html}</div>`
}

const tile = (label: string, value: string, note: string, rtl: boolean, chip?: DashboardChip, monoLabel = false): string => {
  const labelStyle = monoLabel
    ? "font-size: 12px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); font-family: 'IBM Plex Mono', monospace"
    : 'font-size: 12px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))'
  const valueHtml = chip
    ? pill(chip)
    : `<dd style="margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 500; font-variant-numeric: tabular-nums">${show(value, rtl)}</dd>`
  return `<div style="display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 10px; border: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3)); background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB))"><dt style="${labelStyle}">${show(label, rtl)}</dt>${chip ? `<dd style="margin: 0">${valueHtml}</dd>` : valueHtml}<dd style="margin: 0; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(note, rtl)}</dd></div>`
}

export const renderWhmDashboard = (model: WhmDashboardModel): string => {
  const rtl = localeDirection(model.locale) === 'rtl'
  const auditRows = model.audit.map(row => `<tr style="border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3)); vertical-align: top">
    <td style="padding: 10px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-variant-numeric: tabular-nums; line-height: 1.4"><time datetime="${escapeHtml(row.datetime)}">${show(row.time, rtl)}</time></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column">${monoSpan(row.actor, show(row.actor, rtl), "font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 13px")}${monoSpan(row.from, show(row.from, rtl), "font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))")}</div></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column"><span>${row.actionHtml ?? show(row.action, rtl)}</span>${row.target ? monoSpan(row.target, show(row.target, rtl), "font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); overflow-wrap: anywhere") : ''}</div></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column; align-items: flex-start; gap: 4px">${pill(row.result)}${row.detail ? `<span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(row.detail, rtl)}</span>` : ''}</div></td>
  </tr>`).join('')
  const meters = model.meters.map(meter => `<div style="display: flex; flex-direction: column; gap: 6px">
    <div style="display: flex; justify-content: space-between; gap: 8px; font-size: 13px"><span style="font-weight: 600">${show(meter.label, rtl)}</span><span style="color: light-dark(#475467,var(--xp-text-secondary,#475467)); font-variant-numeric: tabular-nums">${show(meter.value, rtl)}</span></div>
    ${meter.showBar === false ? '' : `<div role="meter" aria-label="${escapeHtml(plain(meter.label))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(meter.now)}" aria-valuetext="${escapeHtml(meter.value)}" style="height: 8px; border-radius: 4px; background: light-dark(#E9ECF1,var(--xp-border,#E9ECF1)); overflow: hidden"><div style="height: 8px; width: ${escapeHtml(meter.pct)}; background: ${escapeHtml(themeColor(meter.color))}; border-radius: 4px"></div></div>`}
    <span style="font-size: 12px; color: ${escapeHtml(themeColor(meter.noteColor))}">${show(meter.note, rtl)}</span>
  </div>`).join('')
  const accountTiles = model.accountTiles.map(item => `<div style="display: flex; flex-direction: column; gap: 8px">
    <dt style="display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: light-dark(#475467,var(--xp-text-secondary,#475467))"><span aria-hidden="true" style="width: 8px; height: 8px; border-radius: 50%; ${item.ring ? `border: 1.5px solid ${themeColor(item.dot)}` : `background: ${themeColor(item.dot)}`}"></span>${show(item.label, rtl)}</dt>
    <dd style="margin: 0; font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums">${show(item.value, rtl)}</dd>
  </div>`).join('')
  const near = model.near.map((item, index) => `<li style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; font-size: 13px;${index ? ' border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))' : ''}">${monoSpan(item.name, show(item.name, rtl), "font-family: 'IBM Plex Mono', monospace")}<span style="color: ${escapeHtml(themeColor(item.color))}; font-weight: 600; font-variant-numeric: tabular-nums">${show(item.note, rtl)}</span></li>`).join('')
  const hostRows = model.hostRows.map(row => {
    let value = show(row.value, rtl)
    if (rtl && row.ddStyle.includes('overflow-wrap')) {
      value = value.replaceAll('<bdi dir="ltr">', '<bdi dir="ltr" style="overflow-wrap: anywhere">')
    }
    return `<div class="xp-whm-dashboard-host-fact"><dt style="color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(row.label, rtl)}</dt><dd style="${row.ddStyle}">${value}</dd></div>`
  }).join('')
  const controllers = model.controllers.map(name => `<li style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: light-dark(#E7F5EE,var(--xp-status-ok-bg,#E7F5EE)); color: light-dark(#0E7A4E,var(--xp-status-ok-fg,#0E7A4E)); font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: #0E7A4E"></span>${show(name, rtl)}</li>`).join('')
  const services = model.services.map((row, index) => `<li style="display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 4px 20px; border-top: 1px solid ${themeColor(index === 0 ? 'transparent' : '#EEF0F3', 'border')}">
    <span style="display: flex; flex-direction: column; min-width: 0; line-height: 1.4"><span style="font-size: 14px; font-weight: 500">${show(row.name, rtl)} <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(row.version, rtl)}</span></span>${row.note ? `<span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(row.note, rtl)}</span>` : ''}</span>
    <span style="flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${themeColor(row.status.bg, 'surface')}; color: ${themeColor(row.status.fg)}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${themeColor(row.status.dot ?? row.status.fg)}; border: 1.5px solid ${themeColor(row.status.fg)}"></span>${escapeHtml(row.status.label)}</span>
  </li>`).join('')
  const crumb = rtl
    ? `<li><a href="/whm" style="color: light-dark(#475467,var(--xp-text-secondary,#475467))"><bdi dir="ltr">${escapeHtml(model.crumbRoot)}</bdi></a></li><li aria-hidden="true">/</li><li aria-current="page">${show(model.crumbPage, true)}</li>`
    : `<li style="display: flex; gap: 6px"><a href="/whm" style="color: light-dark(#475467,var(--xp-text-secondary,#475467))">${escapeHtml(model.crumbRoot)}</a><span aria-hidden="true">/</span></li><li aria-current="page">${escapeHtml(model.crumbPage)}</li>`
  const ledeHost = `<span style="font-family: 'IBM Plex Mono', monospace">${ltr(model.ledeHost)}</span>`
  const ledeTime = `<time datetime="${escapeHtml(model.ledeDatetime)}">${rtl ? `<bdi dir="ltr" style="white-space: nowrap">${escapeHtml(model.ledeTime)}</bdi>` : escapeHtml(model.ledeTime)}</time>`
  const lede = `<p style="margin: 0; font-size: 14px; color: light-dark(#475467,var(--xp-text-secondary,#475467)); line-height: 1.6; max-width: 68ch">${model.lede.split(/(\{host\}|\{time\})/).map(part => part === '{host}' ? ledeHost : part === '{time}' ? ledeTime : rtl ? rich(part) : escapeHtml(part)).join('')}</p>`
  return `<div class="xp-board-port xp-shell" data-board-port="xwhm-dashboard" data-section="overview-attention"${rtl ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: light-dark(#F5F6F8,var(--xp-bg-canvas,#F5F6F8)); color: light-dark(#101828,var(--xp-text-primary,#101828))">
  <style>
    .xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
    .xp-board-port .xp-btn{font-family:inherit}
    .xp-board-port a{color:light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))}.xp-board-port a:hover{color:light-dark(#1546A8,var(--xp-accent-hover,#1546A8))}
    .xp-board-port :focus-visible{outline:2px solid light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6));outline-offset:2px}
    .xp-board-port nav[aria-label="xWHM navigation"] :focus-visible{outline-color:#6EA0FF}
    [data-board-port="xwhm-dashboard"] .xp-whm-dashboard-host-fact{display:flex;flex-direction:column;gap:var(--xp-space-label,8px);min-inline-size:0}
    [data-board-port="xwhm-dashboard"] .xp-whm-dashboard-host-fact dd{min-inline-size:0;text-align:start;overflow-wrap:anywhere}
    @media(max-width:600px){[data-board-port="xwhm-dashboard"] :is(section[aria-labelledby="rec-title"],section[aria-labelledby="res-title"],section[aria-labelledby="acc-title"],section[aria-labelledby="host-title"]){padding:var(--xp-space-field,16px)!important}}
    ${ARABIC_TYPE_CSS}
  </style>
  ${navHtml(model)}
  ${renderMobileNavBackdrop(model.locale)}
  <main id="main-content" tabindex="-1" data-xp-shell-content style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    ${headerHtml(model)}
    <div style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px 32px 52px; display: flex; flex-direction: column; gap: 24px">
      <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px">
        <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 420px">
          <nav aria-label="Breadcrumb">
            <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">
              ${crumb}
            </ol>
          </nav>
          <h1 style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${show(model.title, rtl)}</h1>
          ${lede}
        </div>
        ${canOpen(model, '/whm/accounts/new') ? `<a href="/whm/accounts/new" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6)); background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${svg('<path d="M12 5v14M5 12h14"></path>', 18, false)}${show(model.createLabel, rtl)}</a>` : ''}
      </div>
      <section aria-label="Notices" style="display: flex; flex-wrap: wrap; gap: 16px">${model.notices.map(noticeHtml).join('')}</section>
      <div style="display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start">
        <div style="flex: 1.618 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="rec-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
              <h2 id="rec-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.reconcilerTitle, rtl)}</h2>
              ${pill(model.reconcilerStatus)}
            </div>
            <p style="margin: 0; font-size: 14px; color: light-dark(#344054,var(--xp-text-secondary,#344054)); line-height: 1.6; max-width: 68ch">${show(model.reconcilerLede, rtl)}</p>
            <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px">${model.reconcilerTiles.map(item => tile(item.label, item.value, item.note, rtl, item.chip, item.monoLabel)).join('')}</dl>
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: auto">
              ${canOpen(model, '/whm/audit') ? `<button type="button" style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#101828,var(--xp-text-primary,#101828)); font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.driftButton, rtl)}</button>` : ''}
              ${canOpen(model, '/whm/audit') ? `<a href="/whm/audit" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">${show(model.driftLink, rtl)}</a>` : ''}
              <span role="status" style="font-size: 12px; font-weight: 500; color: light-dark(#0E7A4E,var(--xp-status-ok-fg,#0E7A4E))">${show(model.driftStatus, rtl)}</span>
            </div>
          </section>
          <section aria-labelledby="res-title" data-host-observation="${model.meters.every(meter => meter.value === '—' && meter.now === '0') ? 'unavailable' : 'observed'}" style="min-width: 0; display: flex; flex-direction: column; gap: 20px; padding: 24px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px">
              <h2 id="res-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.resourcesTitle, rtl)}</h2>
              <span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(model.resourcesSampled, rtl)}</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 22px 26px">${meters}</div>
            <p style="margin: 0; font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); line-height: 1.6">${model.resourcesFoot}</p>
          </section>
          <section aria-labelledby="audit-title" style="min-width: 0; display: flex; flex-direction: column; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 20px 24px 16px">
              <h2 id="audit-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.auditTitle, rtl)}</h2>
              <span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(model.auditWhen, rtl)}</span>
            </div>
            <div role="region" tabindex="0" aria-labelledby="audit-title" style="overflow-x: auto; border-top: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: 620px">
                <thead><tr style="background: light-dark(#F8F9FB,var(--xp-bg-elevated,#F8F9FB))">${model.auditHeads.map((head, index) => `<th scope="col" style="text-align: start; padding: 10px 16px; font-size: 12px; font-weight: 600; color: light-dark(#475467,var(--xp-text-secondary,#475467));${index === 0 ? ' width: 72px' : ''}">${show(head, rtl)}</th>`).join('')}</tr></thead>
                <tbody>${auditRows}</tbody>
              </table>
            </div>
            <div style="display: flex; padding: 8px 18px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))">
              ${canOpen(model, '/whm/audit') ? `<a href="/whm/audit" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">${show(model.auditLink, rtl)}</a>` : ''}
            </div>
          </section>
        </div>
        <div style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="acc-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <h2 id="acc-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.accountsTitle, rtl)}</h2>
            <dl style="margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px">${accountTiles}</dl>
            <p style="margin: 0; font-size: 13px; color: light-dark(#475467,var(--xp-text-secondary,#475467)); line-height: 1.6">${show(model.accountsSentence, rtl)}</p>
            <div style="display: flex; flex-direction: column; gap: 8px">
              <h3 style="margin: 0; font-size: 13px; font-weight: 600">${show(model.nearTitle, rtl)}</h3>
              <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3)); border-radius: 10px">${near}</ul>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 12px; margin-top: auto">
              ${canOpen(model, '/whm/accounts') ? `<a href="/whm/accounts" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid light-dark(#D0D5DD,var(--xp-border-strong,#D0D5DD)); background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); color: light-dark(#101828,var(--xp-text-primary,#101828)); font-size: 14px; font-weight: 600; text-decoration: none">${show(model.viewAccounts, rtl)}</a>` : ''}
              ${canOpen(model, '/whm/resellers') ? `<a href="/whm/resellers" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">${show(model.resellersLink, rtl)}</a>` : ''}
            </div>
          </section>
          <section aria-labelledby="host-title" style="min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
              <h2 id="host-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.hostTitle, rtl)}</h2>
              <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: light-dark(#EEF0F3,var(--xp-bg-elevated,#EEF0F3)); color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(model.hostIp, rtl)}</span>
            </div>
            <dl class="xp-whm-dashboard-host-facts" style="margin: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; font-size: 13px; line-height: 1.4">${hostRows}</dl>
            <div style="display: flex; flex-direction: column; gap: 8px">
              <span style="font-size: 13px; font-weight: 600">${show(model.controllersTitle, rtl)}</span>
              <ul aria-label="${escapeHtml(plain(model.controllersTitle))}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px">${controllers}</ul>
              <span style="font-size: 12px; font-weight: 500; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E)); line-height: 1.6">${show(model.controllersNote, rtl)}</span>
            </div>
          </section>
          <section aria-labelledby="svc-title" style="min-width: 0; display: flex; flex-direction: column; border-radius: 12px; background: light-dark(#FFFFFF,var(--xp-bg-surface,#FFFFFF)); border: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">
            <div style="display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; padding: 20px 24px 16px">
              <h2 id="svc-title" style="margin: 0; font-size: 16px; font-weight: 600">${show(model.servicesTitle, rtl)}</h2>
              <span style="font-size: 12px; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))">${show(model.servicesMeta, rtl)}</span>
            </div>
            <ul style="list-style: none; margin: 0; padding: 0; border-top: 1px solid light-dark(#E2E6EC,var(--xp-border,#E2E6EC))">${services}</ul>
            <div style="display: flex; padding: 8px 18px; border-top: 1px solid light-dark(#EEF0F3,var(--xp-border,#EEF0F3))">
              ${canOpen(model, '/whm/services') ? `<a href="/whm/services" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 6px; font-size: 14px; font-weight: 600; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">${show(model.servicesLink, rtl)}</a>` : ''}
            </div>
          </section>
        </div>
      </div>
    </div>
  </main>
</div>`
}

const mono = (text: string): string => monoSpan(text, escapeHtml(text), "font-family: 'IBM Plex Mono', monospace")

const running = (label: string): DashboardChip => ({ label, bg: '#E7F5EE', fg: '#0E7A4E', dot: '#0E7A4E', borderedDot: true })

const domain = (name: string): string => `<bdi dir="ltr"><span style="font-family: 'IBM Plex Mono', monospace">${escapeHtml(name)}</span></bdi>`

/** The approved design specimen in any locale. Copy comes from the catalog; RTL isolates Latin values. */
export const whmDashboardFixture = (locale: Locale = 'en'): WhmDashboardModel => {
  const t = translator(locale)
  const rtl = localeDirection(locale) === 'rtl'
  const version = (value: string): string => rtl ? ltr(value) : mono(value)
  const certificates = ([['alice-shop.com', '2026-11-04'], ['nour.dev', '2026-11-12'], ['omar-clinic.net', '2026-11-19']] as const)
    .map(([name, date]) => rtl ? `${domain(name)} <bdi dir="ltr">(${date})</bdi>` : `${mono(name)} (${date})`)
    .join(t(msgctxt('xwhm-dashboard', ',')) + ' ')
  const slice = '<code style="font-family: \'IBM Plex Mono\', monospace">xpanel-&lt;uid&gt;.slice</code>'
  const link = 'color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6)); font-weight: 600'
  const runningChip = (): DashboardChip => running(t(msgctxt('xwhm-dashboard', 'Running')))
  return {
    visibility: { principal: { kind: 'root', id: 'fixture-root', username: 'root' } },
    locale,
    theme: 'light',
    realtimeEnabled: false,
    hostname: 'srv1.xpanel.test',
    username: 'root',
    versionLabel: 'v1.4.2',
    generationLabel: t('Generation {generationId} · active', { generationId: 142 }),
    generationTone: 'live',
    activeHref: '/whm',
    title: t('Server dashboard'),
    crumbRoot: 'xWHM',
    crumbPage: t('Dashboard'),
    ledeHost: 'srv1.xpanel.test',
    lede: t('{host} at a glance: the reconciler, accounts, resources and services. Updated {time}.'),
    ledeTime: '2026-10-22 14:05 UTC',
    ledeDatetime: '2026-10-22T14:05Z',
    createLabel: t('Create account'),
    searchLabel: t('Search tools and accounts'),
    searchPlaceholder: t('Search tools and accounts'),
    notices: [
      { tone: 'warn', html: `<span><strong style="font-weight: 600">${show(t(CERTIFICATES_SOON, { count: 3 }), rtl)}</strong> ${certificates}. ${show(t('AutoSSL renews them; check any domain that no longer points here.'), rtl)} <a href="/whm/ssl" style="${link}">${escapeHtml(t('Review certificates'))}</a></span>` },
      { tone: 'info', html: `<span><strong style="font-weight: 600">${t('Upgrade {version} is available', { version: version('v1.5.0') })}</strong> ${t('(this server runs {version}).', { version: version('v1.4.2') })} ${escapeHtml(t('It installs side by side with a snapshot and a health check, and rolls back automatically if the check fails. Homes, mail and customer databases are not touched.'))} <a href="/whm/server/upgrade" style="${link}">${escapeHtml(t('Review the upgrade'))}</a></span>` },
    ],
    reconcilerTitle: t('Reconciler'),
    reconcilerStatus: okChip(t(msgctxt('xwhm-dashboard', 'In sync'))),
    reconcilerLede: t('The desired state equals the applied state. Every change is written as a new generation, tested, and switched only when the tests pass.'),
    reconcilerTiles: [
      { label: t('Desired and applied'), value: '142 = 142', note: t('Equal') },
      { label: t('Active generation'), value: '142', note: t('Applied {time} by {actor}', { time: '13:48 UTC', actor: 'root' }) },
      { label: t(msgctxt('xwhm-dashboard', 'Drift')), value: '0', note: t('Checked {driftChecked}', { driftChecked: '14:04 UTC' }) },
      { label: 'nginx -t', value: '', note: t('{when} · generation {generationId}', { when: '13:48 UTC', generationId: 142 }), chip: okChip(t('Passed')), monoLabel: true },
      { label: 'apachectl configtest', value: '', note: t('Syntax OK · {when}', { when: '13:48 UTC' }), chip: okChip(t('Passed')), monoLabel: true },
      { label: t('Rollback target'), value: '141', note: t('Kept on disk') },
    ],
    driftButton: t('Check for drift now'),
    driftLink: t('View generations in the audit log'),
    driftStatus: '',
    resourcesTitle: t('Server resources'),
    resourcesSampled: t('Sampled {sampledAt}', { sampledAt: '14:05 UTC' }),
    meters: [
      { label: t('CPU'), value: '28%', now: '28', pct: '28%', color: '#1D5BD6', note: t('Load {load} on {cores}', { load: '1.12', cores: t(CORES, { cores: 4 }) }), noteColor: '#5D6B7E' },
      { label: t('Memory'), value: '3.4 / 8 GB', now: '43', pct: '43%', color: '#1D5BD6', note: t('{availableBytes} available', { availableBytes: '4.6 GB' }), noteColor: '#5D6B7E' },
      { label: t('Disk on /home'), value: '142 / 400 GB', now: '36', pct: '36%', color: '#1D5BD6', note: t('Filesystem quotas enforced'), noteColor: '#5D6B7E' },
      { label: t('Inodes on /home'), value: '1.9 M / 26.2 M', now: '7', pct: '7%', color: '#1D5BD6', note: 'ext4', noteColor: '#5D6B7E' },
    ],
    resourcesFoot: t('Each account is limited inside its own {slice}, so one busy site cannot take the whole server.', { slice: rtl ? `<bdi dir="ltr">${slice}</bdi>` : slice }),
    auditTitle: t('Recent audit entries'),
    auditWhen: t('Today, {date} · times in UTC', { date: '2026-10-22' }),
    auditHeads: [t('Time'), t('Actor'), t('Action'), t('Result')],
    audit: [
      { time: '13:48', datetime: '2026-10-22T13:48Z', actor: 'root', from: '203.0.113.7', action: t('Changed plan'), target: 'alice: Starter → Business', result: okChip(t('Applied')), detail: t('Generation {generationId}', { generationId: 142 }) },
      { time: '13:31', datetime: '2026-10-22T13:31Z', actor: 'reseller1', from: '198.51.100.24', action: t('Created account'), target: 'omar · uid 20016 · omar-clinic.net', result: okChip(t('Applied')), detail: t('Generation {generationId}', { generationId: 141 }) },
      { time: '13:02', datetime: '2026-10-22T13:02Z', actor: 'root', from: '203.0.113.7', action: t('Edited Nginx include'), target: 'nour.dev', result: badChip(t('Test failed')), detail: t('nginx -t failed; generation {generationId} kept', { generationId: 140 }) },
      { time: '12:20', datetime: '2026-10-22T12:20Z', actor: 'root', from: '203.0.113.7', action: t('Added firewall rule'), target: 'drop panel port from 0.0.0.0/0', result: badChip(t(msgctxt('xwhm-dashboard', 'Not saved'))), detail: t('Would lock out {address}', { address: '203.0.113.7' }) },
      { time: '11:05', datetime: '2026-10-22T11:05Z', actor: 'reseller1', from: '198.51.100.24', action: t('Suspended account'), target: 'karim', result: okChip(t('Applied')), detail: t('Generation {generationId}', { generationId: 140 }) },
    ],
    auditLink: t(msgctxt('xwhm-dashboard', 'Open the audit log')),
    accountsTitle: t('Accounts'),
    accountTiles: [
      { label: t(msgctxt('xwhm-dashboard', 'Active')), value: '41', dot: '#0E7A4E' },
      { label: t(msgctxt('xwhm-dashboard', 'Suspended')), value: '3', dot: '#B54708' },
      { label: t('Resellers'), value: '2', dot: '#344054', ring: true },
    ],
    accountsSentence: t('{accounts, plural, one {{accounts} account} other {{accounts} accounts}} in total. Resellers see only the accounts they own.', { accounts: 44 }),
    nearTitle: t('Near a limit'),
    near: [
      { name: 'karim', note: 'Disk 92% of 5 GB', color: '#B42318' },
      { name: 'yousef', note: 'Disk 89% of 10 GB', color: '#B54708' },
    ],
    viewAccounts: t('View accounts'),
    resellersLink: t('Resellers'),
    hostTitle: t('Host'),
    hostIp: '10.0.0.12',
    hostRows: [
      { label: t('System'), value: 'Ubuntu 24.04.1 LTS', ddStyle: 'margin: 0' },
      { label: t('Kernel'), value: '6.8.0-45-generic', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
      { label: t('Uptime'), value: '41 days, 6 hours', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      { label: t('Hardware'), value: '4 cores · 8 GB', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      // RTL keeps "mpm-itk" on one line with a non-breaking hyphen.
      { label: t('Engine'), value: `nginx 1.24.0 → apache2 2.4.58 · mpm${rtl ? '‑' : '-'}itk`, ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" },
      { label: 'xPanel', value: 'v1.4.2 · control schema 37', ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
    ],
    controllersTitle: t('cgroup v2 controllers'),
    controllers: ['cpu', 'io', 'memory', 'pids'],
    controllersNote: t('All plan limits are enforced on this host.'),
    servicesTitle: t('Services'),
    servicesMeta: t('{running} running · {missing} not installed', { running: 10, missing: 1 }),
    services: [
      { name: 'Nginx', version: '1.24.0', note: '', status: runningChip() },
      { name: 'Apache', version: '2.4.58 mpm-itk', note: t('Children run as the account UID'), status: runningChip() },
      { name: 'PHP-FPM', version: '8.1 · 8.2 · 8.3', note: t('43 pools, each inside its account slice'), status: runningChip() },
      { name: 'MariaDB', version: '10.11.8', note: '', status: runningChip() },
      { name: 'PostgreSQL', version: '16.4', note: t('Desired state of the panel'), status: runningChip() },
      { name: 'Postfix', version: '3.8.6', note: '', status: runningChip() },
      { name: 'Dovecot', version: '2.3.21', note: '', status: runningChip() },
      { name: 'PowerDNS', version: '4.8.3', note: '', status: runningChip() },
      { name: 'Redis', version: '7.0.15', note: '', status: runningChip() },
      { name: 'xpanel-agent', version: 'v1.4.2', note: t('The reconciler'), status: runningChip() },
      { name: 'ModSecurity', version: '', note: t('OWASP CRS is attached once it is installed'), status: { label: t(msgctxt('xwhm-dashboard-fixture', 'Not installed')), bg: '#EEF0F3', fg: '#344054', dot: 'transparent', borderedDot: true } },
    ],
    servicesLink: t('Manage services'),
  }
}

export const whmDashboardFixtureAr = (): WhmDashboardModel => whmDashboardFixture('ar')

const countAccounts = (accounts: Account[] | undefined, status: Account['status']): string =>
  accounts ? String(accounts.filter(account => account.status === status).length) : '—'

const meterPercent = (used: number, total: number): { now: string; pct: string } => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return { now: '0', pct: '0%' }
  const value = Math.max(0, Math.min(100, Math.round((used / total) * 100)))
  return { now: String(value), pct: `${value}%` }
}

const controllersNoteFromLimits = (
  limits: DashboardHostSample['observedLimits'],
  locale: Locale,
): string => {
  if (!limits || limits.status === 'unavailable' || limits.checkedAccounts < 1 || limits.unavailableAccounts > 0) return translator(locale)('Plan-limit verification is unavailable.')
  if (limits.status === 'verified' && limits.gaps.length === 0) return translator(locale)('Observed account caps match assigned plan limits.')
  return translator(locale)('Observed account caps do not match all assigned plan limits.')
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

export const whmDashboardFromProps = (props: DashboardProps): WhmDashboardModel => {
  const locale: Locale = props.locale ?? 'en'
  const t = translator(locale)
  const rtl = localeDirection(locale) === 'rtl'
  const accounts = props.accounts
  const active = countAccounts(accounts, 'active')
  const suspended = countAccounts(accounts, 'suspended')
  const resellerCount = props.resellers ? String(props.resellers.length) : '—'
  const total = accounts ? accounts.length : null
  const planCount = props.plans ? props.plans.length : null
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const readableName = (value: string | undefined): string | null =>
    value && value !== 'Server' && value !== t('Server') ? value : null
  const hostname = readableName(props.hostSample?.hostname) ?? readableName(props.hostname) ?? '—'
  const panelDomain = readableName(props.hostSample?.panelDomain) ?? readableName(props.panelHostname)
  const panelRow = panelDomain && panelDomain !== hostname ? panelDomain : null
  const probedVersion = hostText(props.hostSample?.panelVersion)
  const version = probedVersion !== '—'
    ? probedVersion
    : (props.version && props.version !== 'Unavailable' && props.version !== t('Unavailable') ? props.version : '—')
  const ip = (props.ipPool ?? []).find((entry: ServerIpEntry) => entry.isPrimary)?.address ?? (props.ipPool ?? [])[0]?.address ?? '—'
  const serviceRoster = props.services ?? []
  const services = serviceRoster.map((service): DashboardServiceRow => ({
    name: service.name,
    version: service.version,
    note: '',
    status: service.checked === false
      ? emptyChip(t(msgctxt('xwhm-dashboard', 'Not checked')))
      : service.installed === false
        ? emptyChip(t(msgctxt('xwhm-dashboard', 'Not installed')))
        : service.active ? running(t(msgctxt('xwhm-dashboard', 'Running'))) : emptyChip(t(msgctxt('xwhm-dashboard', 'Stopped'))),
  }))
  const existingServices = serviceRoster.filter(service => service.checked !== false && service.installed !== false)
  const runningServices = existingServices.filter(service => service.active).length
  const driftKnown = typeof props.driftCount === 'number' && Number.isSafeInteger(props.driftCount) && props.driftCount >= 0
  const driftValue = driftKnown ? String(props.driftCount) : '—'
  const driftChecked = props.driftCheckedAt && !Number.isNaN(Date.parse(props.driftCheckedAt)) ? props.driftCheckedAt : ''
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
      ? { tone: 'info', html: `<span>${show(t('No certificates renew within 30 days.'), rtl)}</span>` }
      : {
          tone: soon.length > 0 ? 'warn' : 'info',
          html: `<span>${soon.length > 0 ? show(t(CERTIFICATES_SOON, { count: soon.length }), rtl) : ''} ${listedCertificates.map(item => {
            const days = show(t(DAYS, { days: item.days }), rtl)
            return rtl
              ? `<bdi dir="ltr">${mono(item.name)}</bdi> · ${days} <bdi dir="ltr">(${escapeHtml(item.date)})</bdi>`
              : `${mono(item.name)} · ${days} (${mono(item.date)})`
          }).join(t(msgctxt('xwhm-dashboard', ',')) + ' ')}</span>`,
        }
  const accountsSentence = total === null
    ? '—'
    : planCount === null
      ? t(ACCOUNTS_SENTENCE, { accounts: total })
      : t(ACCOUNTS_PLANS_SENTENCE, { accounts: total, plans: planCount })
  const audit = (props.auditEntries ?? []).slice(0, 8).map((entry: AuditEntry): DashboardAuditRow => {
    const target = auditTargetLabel(entry.target, locale)
    const outcome = auditOutcomeLabel(entry.action, entry.outcome, locale)
    const chip = entry.outcome === 'ok'
      ? okChip(outcome)
      : entry.outcome === 'denied'
        ? emptyChip(outcome)
        : badChip(outcome)
    const actor = auditActorLabel(entry.actor)
    return {
      time: formatUtcClock(entry.at),
      datetime: entry.at,
      actor: actor || '—',
      from: '—',
      action: auditActionLabel(entry.action, locale, entry),
      actionHtml: auditActionHtml(entry.action, locale, entry),
      target,
      result: chip,
      detail: '',
    }
  })
  const sampledAt = props.hostSample?.sampledAt && !Number.isNaN(Date.parse(props.hostSample.sampledAt)) ? props.hostSample.sampledAt : ''

  const clock = (iso: string): string => formatUtcClock(iso)
  const rollbackId = typeof props.rollbackGenerationId === 'number' && Number.isSafeInteger(props.rollbackGenerationId) && props.rollbackGenerationId > 0
    ? props.rollbackGenerationId
    : null
  const configTile = (label: string, check: { ok: boolean; at: string } | undefined, kind: 'nginx' | 'apache') => {
    if (!check) return { label, value: '', note: '—', chip: emptyChip('—'), monoLabel: true }
    const when = clock(check.at)
    if (!check.ok) return { label, value: '', note: when, chip: badChip(t('Failed')), monoLabel: true }
    if (kind === 'apache') {
      return { label, value: '', note: t('Syntax OK · {when}', { when }), chip: okChip(t('Passed')), monoLabel: true }
    }
    const note = generationId !== undefined ? t('{when} · generation {generationId}', { when, generationId }) : when
    return { label, value: '', note, chip: okChip(t('Passed')), monoLabel: true }
  }
  const emptyAudit: DashboardAuditRow = { time: '—', datetime: '', actor: '—', from: '—', action: '—', target: '—', result: emptyChip('—'), detail: '—' }
  const emptyService: DashboardServiceRow = { name: '—', version: '', note: '', status: emptyChip('—') }
  const meter = (label: string): DashboardMeter => ({ label, value: '—', now: '0', pct: '0%', color: '#1D5BD6', note: '—', noteColor: '#5D6B7E' })
  return {
    locale,
    visibility: props.visibility,
    theme: props.theme ?? 'light',
    realtimeEnabled: props.realtimeEnabled === true,
    hostname,
    username: props.principal?.username ?? '—',
    versionLabel: version,
    generationLabel: generationId !== undefined ? (translator(locale)('Generation {generationId} · active', { generationId })) : '—',
    generationTone: generationId !== undefined ? 'live' : 'empty',
    activeHref: '/whm',
    title: translator(locale)('Server dashboard'),
    crumbRoot: 'xWHM',
    crumbPage: translator(locale)('Dashboard'),
    ledeHost: hostname,
    lede: translator(locale)('{host} at a glance: the reconciler, accounts, resources and services. Updated {time}.'),
    ledeTime: sampledAt ? formatDisplayDateTime(sampledAt) : '—',
    ledeDatetime: sampledAt ? new Date(sampledAt).toISOString() : '',
    signOutLabel: translator(locale)('Sign out'),
    createLabel: translator(locale)('Create account'),
    searchLabel: translator(locale)('Search tools and accounts'),
    searchPlaceholder: translator(locale)('Search tools and accounts'),
    notices: [
      certificateNotice,
      { tone: 'info', html: `<span>${escapeHtml(translator(locale)('No upgrade is published.'))} ${props.availableVersion ? mono(props.availableVersion) : ''}</span>` },
    ],
    reconcilerTitle: translator(locale)('Reconciler'),
    reconcilerStatus: inSync ? okChip(translator(locale)(msgctxt('xwhm-dashboard', 'In sync'))) : emptyChip('—'),
    reconcilerLede: translator(locale)('The desired state equals the applied state when the drift check reports none.'),
    reconcilerTiles: [
      { label: translator(locale)('Desired and applied'), value: inSync ? `${generationId} = ${generationId}` : '—', note: inSync ? (translator(locale)('Equal')) : '—' },
      { label: translator(locale)('Active generation'), value: generationId !== undefined ? String(generationId) : '—', note: props.generationActivatedAt && !Number.isNaN(Date.parse(props.generationActivatedAt)) ? (translator(locale)('Activated {generationActivatedAt}', { generationActivatedAt: clock(props.generationActivatedAt) })) : '—' },
      {
        label: translator(locale)(msgctxt('xwhm-dashboard', 'Drift')),
        value: driftValue,
        note: !driftKnown || !driftChecked
          ? '—'
          : props.driftCount === 0
            ? (translator(locale)('Checked {driftChecked}', { driftChecked: clock(driftChecked) }))
            : (translator(locale)('{driftCount} drifted · {driftChecked}', { driftCount: driftValue, driftChecked: clock(driftChecked) })),
      },
      configTile('nginx -t', props.hostSample?.nginxTest, 'nginx'),
      configTile('apachectl configtest', props.hostSample?.apacheTest, 'apache'),
      { label: translator(locale)('Rollback target'), value: rollbackId ? String(rollbackId) : '—', note: rollbackId ? (translator(locale)('Previous generation')) : '—' },
    ],
    driftButton: translator(locale)('Check for drift now'),
    driftLink: translator(locale)('View generations in the audit log'),
    driftStatus: '',
    resourcesTitle: translator(locale)('Server resources'),
    resourcesSampled: sampledAt ? (translator(locale)('Sampled {sampledAt}', { sampledAt: clock(sampledAt) })) : '—',
    meters: [
      loadValue === null
        ? meter(translator(locale)('CPU'))
        : {
            label: translator(locale)('CPU'),
            value: loadValue,
            now: '',
            pct: '0%',
            color: '#1D5BD6',
            note: cores
              ? t(CORES, { cores })
              : (translator(locale)('load {loadValue}', { loadValue })),
            noteColor: '#5D6B7E',
            showBar: false,
          },
      memory && memory.totalBytes > 0
        ? { label: translator(locale)('Memory'), value: `${formatBytes(memory.totalBytes - memory.availableBytes)} / ${formatBytes(memory.totalBytes)}`, ...memoryMeter, color: '#1D5BD6', note: translator(locale)('{availableBytes} available', { availableBytes: formatBytes(memory.availableBytes) }), noteColor: '#5D6B7E' }
        : meter(translator(locale)('Memory')),
      disk && disk.totalBytes > 0
        ? { label: translator(locale)('Disk on {mount}', { mount: disk.mount }), value: `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`, ...diskMeter, color: '#1D5BD6', note: diskMeter.pct, noteColor: '#5D6B7E' }
        : meter(translator(locale)('Disk on /home')),
      inodes
        ? {
            label: homeOnRoot ? (translator(locale)('Inodes on /')) : (translator(locale)('Inodes on {mount}', { mount: inodes.mount })),
            value: `${formatAsciiNumber(inodes.used)} / ${formatAsciiNumber(inodes.total)}`,
            ...meterPercent(inodes.used, inodes.total),
            color: '#1D5BD6',
            note: homeOnRoot ? (translator(locale)('/home is on /')) : '—',
            noteColor: '#5D6B7E',
          }
        : meter(translator(locale)('Inodes on /home')),
    ],
    resourcesFoot: translator(locale)('Account resource caps are configured in per-account slices. Host verification is reported separately.'),
    auditTitle: translator(locale)('Recent audit entries'),
    auditWhen: audit.length ? (translator(locale)(msgctxt('xwhm-dashboard', 'Times in UTC'))) : '—',
    auditHeads: [t('Time'), t('Actor'), t('Action'), t('Result')],
    audit: audit.length ? audit : [emptyAudit],
    auditLink: translator(locale)('Open the audit log'),
    accountsTitle: translator(locale)('Accounts'),
    accountTiles: [
      { label: translator(locale)(msgctxt('xwhm-dashboard', 'Active')), value: active, dot: '#0E7A4E' },
      { label: translator(locale)(msgctxt('xwhm-dashboard', 'Suspended')), value: suspended, dot: '#B54708' },
      { label: translator(locale)('Resellers'), value: resellerCount, dot: '#344054', ring: true },
    ],
    accountsSentence,
    nearTitle: translator(locale)('Near a limit'),
    near: props.nearLimits === undefined
      ? [{ name: '—', note: '—', color: '#5D6B7E' }]
      : props.nearLimits.length === 0
        ? [{ name: translator(locale)(msgctxt('xwhm-dashboard', 'None')), note: '—', color: '#5D6B7E' }]
        : props.nearLimits.map(row => ({ name: row.name, note: row.note, color: '#B54708' })),
    viewAccounts: translator(locale)('View accounts'),
    resellersLink: translator(locale)('Resellers'),
    hostTitle: translator(locale)('Host'),
    hostIp: ip,
    hostRows: [
      { label: translator(locale)('System'), value: hostText(props.hostSample?.system), ddStyle: 'margin: 0' },
      { label: translator(locale)('Kernel'), value: hostText(props.hostSample?.kernel), ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
      { label: translator(locale)('Uptime'), value: typeof props.hostSample?.uptimeSeconds === 'number' && Number.isFinite(props.hostSample.uptimeSeconds) && props.hostSample.uptimeSeconds >= 0 ? formatUptime(Math.floor(props.hostSample.uptimeSeconds), t) : '—', ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      { label: translator(locale)('Hardware'), value: hardwareLine(cores, cpuModel, memory && memory.totalBytes > 0 ? formatBytes(memory.totalBytes) : null, t), ddStyle: 'margin: 0; font-variant-numeric: tabular-nums' },
      { label: translator(locale)('Engine'), value: hostText(props.hostSample?.engine), ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" },
      { label: 'xPanel', value: version, ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace" },
      ...(panelRow ? [{ label: translator(locale)('Panel domain'), value: panelRow, ddStyle: "margin: 0; font-family: 'IBM Plex Mono', monospace; overflow-wrap: anywhere" }] : []),
    ],
    controllersTitle: translator(locale)('cgroup v2 controllers'),
    controllers: ['cpu', 'io', 'memory', 'pids'],
    controllersNote: controllersNoteFromLimits(props.hostSample?.observedLimits, locale),
    servicesTitle: translator(locale)('Services'),
    servicesMeta: serviceRoster.length ? `${runningServices} / ${existingServices.length}` : '—',
    services: services.length ? services : [emptyService],
    servicesLink: translator(locale)('Manage services'),
  }
}

const documentShell = (model: WhmDashboardModel): string => {
  const t = translator(model.locale)
  return `<!doctype html>
<html lang="${model.locale}" dir="${localeDirection(model.locale)}">
<head>
<meta charset="utf-8">
<title>${escapeHtml(t('Server dashboard — xWHM'))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:light-dark(#F5F6F8,var(--xp-bg-canvas,#F5F6F8));color:light-dark(#101828,var(--xp-text-primary,#101828));font-family:'IBM Plex Sans',sans-serif}
*{box-sizing:border-box}
a{color:light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))}a:hover{color:light-dark(#1546A8,var(--xp-accent-hover,#1546A8))}
:focus-visible{outline:2px solid light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6));outline-offset:2px}
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
  documentShell(whmDashboardFromProps({ locale: dir === 'rtl' ? 'ar' : 'en', principal: { username: 'root' }, visibility: { principal: { kind: 'root', id: 'fixture-root', username: 'root' } } }))
