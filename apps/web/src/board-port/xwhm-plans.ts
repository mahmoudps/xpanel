import type { Account, Domain, FeatureList, Limit, Plan, Reseller, ServerIpEntry } from '@xpanel/core'
import type { CatalogTool } from '@xpanel/catalog'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import type { Locale } from '../i18n.ts'
import { formatDisplayName } from '../display-name.ts'
import { escapeHtml } from '../tokens.ts'
import { WHM_PLANS_TEMPLATE } from './xwhm-plans.template.ts'

const MIB = 1024 * 1024
const HOST_NOTE_FIXTURE = `Every resource field is enforced on <code style="font-family: 'IBM Plex Mono', monospace">srv1.xpanel.test</code>: cgroup v2 with the cpu, io, memory and pids controllers, IO limits on <code style="font-family: 'IBM Plex Mono', monospace">/dev/sda</code>, filesystem quotas on <code style="font-family: 'IBM Plex Mono', monospace">/home</code>.`
const IP_ALERT_FIXTURE = `Cannot save: 12 accounts would each need an address, and the pool has 3 free (<code style="font-family: 'IBM Plex Mono', monospace">10.0.0.16</code> – <code style="font-family: 'IBM Plex Mono', monospace">10.0.0.18</code>). Add 9 addresses to the pool, or keep the shared <code style="font-family: 'IBM Plex Mono', monospace">10.0.0.12</code>.`
const META_FIXTURE = `Owner <span style="font-family: 'IBM Plex Mono', monospace">root</span> · 12 accounts · last saved 2026-10-14 09:32 UTC by <span style="font-family: 'IBM Plex Mono', monospace">root</span>`

const PORT_STYLE = `<style>
.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:auto;color-scheme:light}
.xp-board-port p{max-inline-size:none;line-height:normal}
.xp-board-port :is(code,kbd,pre){font-variant-numeric:normal}
.xp-board-port a{color:#1D5BD6}
.xp-board-port a:hover{color:#1546A8}
.xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
.xp-board-port nav[aria-label="xWHM navigation"] :focus-visible{outline-color:#6EA0FF}
${ARABIC_TYPE_CSS}
</style>`

type Scope = Record<string, unknown>

const lookup = (scope: Scope, path: string): unknown => {
  let cur: unknown = scope
  for (const part of path.trim().split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Scope)[part]
  }
  return cur
}

const findClose = (source: string, from: number, tag: string): { start: number; end: number } => {
  const open = `<${tag}`
  const close = `</${tag}>`
  let depth = 1
  let i = from
  while (i < source.length) {
    const nextOpen = source.indexOf(open, i)
    const nextClose = source.indexOf(close, i)
    if (nextClose < 0) throw new Error(`unclosed ${tag}`)
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1
      i = nextOpen + open.length
    } else {
      depth -= 1
      if (depth === 0) return { start: nextClose, end: nextClose + close.length }
      i = nextClose + close.length
    }
  }
  throw new Error(`unclosed ${tag}`)
}

const expand = (source: string, scope: Scope): string => {
  let out = ''
  let i = 0
  while (i < source.length) {
    const forAt = source.indexOf('<sc-for', i)
    const ifAt = source.indexOf('<sc-if', i)
    const next = forAt < 0 ? ifAt : ifAt < 0 ? forAt : Math.min(forAt, ifAt)
    if (next < 0) return out + interpolate(source.slice(i), scope)
    out += interpolate(source.slice(i, next), scope)
    const tagEnd = source.indexOf('>', next)
    const tag = source.slice(next, tagEnd + 1)
    const kind = source.startsWith('<sc-for', next) ? 'sc-for' : 'sc-if'
    const close = findClose(source, tagEnd + 1, kind)
    const inner = source.slice(tagEnd + 1, close.start)
    if (kind === 'sc-for') {
      const list = String(/list="\{\{([^}]+)\}\}"/.exec(tag)?.[1] ?? '')
      const as = String(/as="([^"]+)"/.exec(tag)?.[1] ?? 'item')
      const items = lookup(scope, list)
      if (Array.isArray(items)) {
        for (const item of items) out += expand(inner, { ...scope, [as]: item })
      }
    } else {
      const key = String(/value="\{\{([^}]+)\}\}"/.exec(tag)?.[1] ?? '')
      if (lookup(scope, key)) out += expand(inner, scope)
    }
    i = close.end
  }
  return out
}

const interpolate = (source: string, scope: Scope): string => {
  let out = ''
  let i = 0
  let inOption = false
  while (i < source.length) {
    if (source.startsWith('<option', i)) inOption = true
    if (source.startsWith('</option', i)) inOption = false
    if (source.startsWith('{{{', i)) {
      const end = source.indexOf('}}}', i + 3)
      out += String(lookup(scope, source.slice(i + 3, end)) ?? '')
      i = end + 3
      continue
    }
    if (source.startsWith('{{', i)) {
      const end = source.indexOf('}}', i + 2)
      const value = escapeHtml(String(lookup(scope, source.slice(i + 2, end)) ?? ''))
      const lastLt = out.lastIndexOf('<')
      const lastGt = out.lastIndexOf('>')
      const inAttr = lastLt > lastGt
      out += inAttr ? value.replaceAll('"', '&quot;') : inOption ? value : `<span class="sc-interp">${value}</span>`
      i = end + 2
      continue
    }
    out += source[i]
    i += 1
  }
  return out
}

const stripHandlers = (source: string): string => source.replaceAll(/ onClick="\{\{[^"]*\}\}"/g, '')

interface FieldSpec {
  key: string
  label: string
  unit: string
  help: string
  value: string
  unlimited: boolean
  baseUnlimited: boolean
  baseValue: string
}

interface OverSource {
  user: string
  domain: string
  owner: string
  n: number
}

const withUnit = (value: string, unit: string): string => unit ? `${value} ${unit}` : value

const field = (spec: FieldSpec, over: OverSource[], addonVal: number): Scope => {
  const valueChanged = spec.key === 'addon' && spec.value !== spec.baseValue && !spec.unlimited && !spec.baseUnlimited
  const changed = spec.unlimited !== spec.baseUnlimited || valueChanged
  const fromText = spec.baseUnlimited ? 'Unlimited' : withUnit(spec.baseValue, spec.unit)
  const toText = spec.unlimited ? 'Unlimited' : withUnit(spec.value, spec.unit)
  const warn = spec.key === 'addon' && over.length > 0
  const names = over.map(row => `${row.user} (${row.n})`).join(' and ')
  return {
    id: `f-${spec.key}`,
    label: spec.label,
    unit: spec.unit,
    hasUnit: spec.unit !== '',
    help: spec.help,
    value: spec.value,
    helpId: `f-${spec.key}-help`,
    warnId: `f-${spec.key}-warn`,
    describedBy: warn ? `f-${spec.key}-help f-${spec.key}-warn` : `f-${spec.key}-help`,
    limited: !spec.unlimited,
    unlimited: spec.unlimited,
    unlLabel: `Unlimited: ${spec.label}`,
    changed,
    changedNote: `Changed · was ${spec.baseUnlimited ? 'unlimited' : withUnit(spec.baseValue, spec.unit)}`,
    fromText,
    toText,
    warn,
    warnText: warn ? `${names}${over.length === 1 ? ' already has more.' : ' already have more.'}` : '',
    addonVal,
    bytesAttr: spec.key === 'ioR' || spec.key === 'ioW' ? ` data-bytes-scale="${spec.unit === 'B/s' ? 1 : MIB}"` : '',
  }
}

const shellOptions = (shell: string): Scope[] => [
  { value: 'none', label: 'No shell' },
  { value: 'jailed', label: 'Jailed shell' },
].map(option => {
  const on = shell === option.value
  return { ...option, checked: on, unchecked: !on, border: on ? '#1D5BD6' : '#D0D5DD', bg: on ? '#F3F7FE' : '#FFFFFF' }
})

const boardFields = (addonVal: number, unl: Record<string, boolean>, base: Record<string, boolean>, addonBase: number): FieldSpec[] => {
  const values: Record<string, string> = { disk: '10', bw: '100', ioR: '50', ioW: '20', iopsR: '2000', iopsW: '1000', mem: '1024', proc: '128', cpu: '100', addon: String(addonVal), alias: '10', sub: '25', mbox: '50', fwd: '100', lists: '5', mquota: '1024', ftp: '10', db: '5', workers: '8' }
  const units: Record<string, string> = { disk: 'GB', bw: 'GB', ioR: 'MB/s', ioW: 'MB/s', iopsR: 'IOPS', iopsW: 'IOPS', mem: 'MB', proc: '', cpu: '%', addon: '', alias: '', sub: '', mbox: '', fwd: '', lists: '', mquota: 'MB', ftp: '', db: '', workers: '' }
  const labels: Record<string, string> = { disk: 'Disk', bw: 'Monthly bandwidth', ioR: 'Read bandwidth', ioW: 'Write bandwidth', iopsR: 'Read IOPS', iopsW: 'Write IOPS', mem: 'Memory', proc: 'Processes', cpu: 'CPU', addon: 'Addon domains', alias: 'Alias domains', sub: 'Subdomains', mbox: 'Mailboxes', fwd: 'Forwarders', lists: 'Mailing lists', mquota: 'Default mailbox quota', ftp: 'FTP accounts', db: 'Databases', workers: 'PHP workers per domain' }
  const help: Record<string, string> = {
    disk: 'Filesystem quota on /home. Uploads stop at the cap.',
    bw: 'Counted from Nginx logs. Resets on the 1st.',
    ioR: 'IOReadBandwidthMax on the slice.',
    ioW: 'IOWriteBandwidthMax on the slice.',
    iopsR: 'IOReadIOPSMax on the slice.',
    iopsW: 'IOWriteIOPSMax on the slice.',
    mem: 'MemoryMax for everything in the slice.',
    proc: 'TasksMax: PHP-FPM, cron, shell and mail together.',
    cpu: 'CPUQuota. 100 % is one full core.',
    addon: 'Separate sites, each with its own docroot.',
    alias: 'Extra names that serve the primary site.',
    sub: 'Explicit names, including ones under a wildcard.',
    mbox: 'Mail users and combined service users.',
    fwd: 'Addresses that only forward mail.',
    lists: 'Lists hosted on the account.',
    mquota: 'For new mailboxes. Owners can change it.',
    ftp: 'FTP service users, jailed to the home.',
    db: 'MariaDB, named with the username prefix.',
    workers: 'pm.max_children for each domain pool.',
  }
  return Object.keys(values).map(key => ({
    key,
    label: labels[key] ?? key,
    unit: units[key] ?? '',
    help: help[key] ?? '',
    value: values[key] ?? '',
    unlimited: !!unl[key],
    baseUnlimited: !!base[key],
    baseValue: key === 'addon' ? String(addonBase) : (values[key] ?? ''),
  }))
}

const group = (fields: Scope[]): { storage: Scope[]; io: Scope[]; compute: Scope[]; domainCaps: Scope[]; emailCaps: Scope[]; serviceCaps: Scope[] } => ({
  storage: fields.slice(0, 2),
  io: fields.slice(2, 6),
  compute: fields.slice(6, 9),
  domainCaps: fields.slice(9, 12),
  emailCaps: fields.slice(12, 16),
  serviceCaps: fields.slice(16, 19),
})

const mono = (value: string): string => `<span style="font-family: 'IBM Plex Mono', monospace">${value}</span>`

const code = (value: string): string => `<code style="font-family: 'IBM Plex Mono', monospace">${value}</code>`

const bdi = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

const countPhrase = (count: number, one: string, many: string, ar: boolean): string => {
  if (ar) return count === 1 ? `${bdi(String(count))} ${one}` : `${bdi(String(count))} ${many}`
  return `${count} ${count === 1 ? one : many}`
}

interface PlanRow {
  nameHtml: string
  rowKey: string
  owner: string
  reseller: boolean
  disk: string
  bw: string
  io: string
  mem: string
  proc: string
  features: string
  accountsHtml: string
  editing: boolean
  notEditing: boolean
  rowBg: string
  mark: string
  editLabel: string
  editKey: string
}

const rowMark = (editing: boolean, ar: boolean): string => editing ? (ar ? 'inset -3px 0 0 #1D5BD6' : 'inset 3px 0 0 #1D5BD6') : 'none'

const nameCell = (name: string, ar: boolean): string => `<span class="sc-interp">${ar ? bdi(name) : escapeHtml(name)}</span>`

const accountCell = (html: string): string => `<span class="sc-interp">${html}</span>`

const fixtureRows = (): PlanRow[] => [
  ['Starter', 'root', false, '5 GB', '50 GB', '20 / 10 MB/s', '512 MB', '64', 'starter', '9 accounts', false, 'Edit plan Starter', 'starter'],
  ['Business', 'root', false, '10 GB', '100 GB', '50 / 20 MB/s', '1024 MB', '128', 'business', '12 accounts', true, 'Edit plan Business', 'business'],
  ['Pro', 'root', false, '50 GB', 'Unlimited', '100 / 50 MB/s', '2048 MB', '256', 'default', '4 accounts', false, 'Edit plan Pro', 'pro'],
  ['r1-basic', 'reseller1', true, '2 GB', '20 GB', '10 / 5 MB/s', '256 MB', '32', 'starter', '6 accounts', false, 'Edit plan r1-basic', 'r1-basic'],
].map(item => ({
  nameHtml: nameCell(String(item[0]), false),
  rowKey: String(item[0]),
  owner: String(item[1]),
  reseller: Boolean(item[2]),
  disk: String(item[3]),
  bw: String(item[4]),
  io: String(item[5]),
  mem: String(item[6]),
  proc: String(item[7]),
  features: String(item[8]),
  accountsHtml: accountCell(String(item[9])),
  editing: Boolean(item[10]),
  notEditing: !item[10],
  rowBg: item[10] ? '#F3F7FE' : '#FFFFFF',
  mark: rowMark(Boolean(item[10]), false),
  editLabel: String(item[11]),
  editKey: String(item[12]),
}))

const cfgLines = (unl: Record<string, boolean>, values: Record<string, string>, units: Record<string, string>, uid: string, device: string | null): string[] => {
  const dev = (key: string): string => {
    if (!device) return ''
    const amount = units[key] === 'MiB/s' || units[key] === 'MB/s' ? `${values[key]}M` : values[key]
    return `"${device} ${amount}"`
  }
  const lines = [
    `systemctl set-property xpanel-${uid}.slice \\`,
    `  CPUQuota=${unl.cpu ? '' : `${values.cpu}%`} \\`,
    `  MemoryMax=${unl.mem ? 'infinity' : `${values.mem}M`} \\`,
    `  TasksMax=${unl.proc ? 'infinity' : values.proc} \\`,
  ]
  if (device) {
    lines.push(
      `  IOReadBandwidthMax=${unl.ioR ? '' : dev('ioR')} \\`,
      `  IOWriteBandwidthMax=${unl.ioW ? '' : dev('ioW')} \\`,
      `  IOReadIOPSMax=${unl.iopsR ? '' : dev('iopsR')} \\`,
      `  IOWriteIOPSMax=${unl.iopsW ? '' : dev('iopsW')}`,
    )
  }
  return lines
}

const assemble = (input: {
  locale: Locale
  fields: FieldSpec[]
  overSource: OverSource[]
  shell: string
  ip: boolean
  genLabel: string
  plans: PlanRow[]
  planName: string
  accountCount: number | null
  chrome: Scope
}): Scope => {
  const unl = Object.fromEntries(input.fields.map(item => [item.key, item.unlimited]))
  const capped = !unl.addon
  const addonVal = Number(input.fields.find(item => item.key === 'addon')?.value ?? '0')
  const over = input.overSource.filter(row => capped && row.n > addonVal).map((row, index) => ({
    user: row.user,
    domain: row.domain,
    owner: `owner ${row.owner}`,
    count: `${row.n} addon domains`,
    cap: `cap ${addonVal}`,
    border: index === 0 ? 'none' : '1px solid #F9C9A0',
    short: `${row.user} (${row.n})`,
  }))
  const built = input.fields.map(item => field(item, input.overSource.filter(row => capped && row.n > addonVal), addonVal))
  const groups = group(built)
  const changes = built.filter(item => item.changed).map(item => ({ label: item.label, from: item.fromText, to: item.toText }))
  const shellName = (value: string): string => value === 'jailed' ? 'Jailed shell' : 'No shell'
  const shellBase = String(input.chrome.shellBase ?? input.shell)
  const ipBase = Boolean(input.chrome.ipBase)
  if (input.shell !== shellBase) changes.push({ label: 'Shell access', from: shellName(shellBase), to: shellName(input.shell) })
  if (input.ip !== ipBase) changes.push({ label: 'Dedicated IP', from: ipBase ? 'On' : 'Off', to: input.ip ? 'On' : 'Off' })
  const n = changes.length
  const values = Object.fromEntries(input.fields.map(item => [item.key, item.value]))
  const units = Object.fromEntries(input.fields.map(item => [item.key, item.unit]))
  const uid = String(input.chrome.sliceUid ?? '20014')
  const device = input.chrome.sliceDevice === undefined ? '/dev/sda' : (input.chrome.sliceDevice as string | null)
  const ar = input.locale === 'ar'
  const usageKnown = input.chrome.usageKnown !== false
  const addonBase = Number(input.fields.find(item => item.key === 'addon')?.baseValue)
  const newCap = addonVal !== addonBase
  const overText = !usageKnown
    ? (ar ? 'استخدام النطاقات الإضافية غير مقروء' : 'addon-domain use was not read')
    : over.length === 0
      ? (ar ? 'لا حساب يتجاوز سقفًا' : 'no account exceeds a cap')
      : ar
        ? `${over.length} ${over.length === 1 ? 'حساب يتجاوز' : 'حسابات تتجاوز'} ${newCap ? 'سقف النطاقات الإضافية الجديد' : 'سقف النطاقات الإضافية'}`
        : `${over.length} ${over.length === 1 ? 'account exceeds' : 'accounts exceed'}${newCap ? ' the new addon-domain cap' : ' the addon-domain cap'}`
  const liveCount = input.accountCount
  const nothingToSaveHtml = ar
    ? `لا شيء للحفظ. القيم أعلاه سارية على ${liveCount === null ? 'الشرائح التي لم يُقرأ عددها' : `<bdi dir="ltr">${liveCount}</bdi> شريحة`}.`
    : liveCount === null
      ? 'Nothing to save. The account count was not read, so this does not name a slice count.'
      : `Nothing to save. The values above are in effect on all ${liveCount} slices.`
  const saveHint = input.chrome.ipProblem
    ? 'Fix the dedicated IP problem to save.'
    : n > 0
      ? (liveCount === null ? 'Applies live after the accounts are read.' : `Applies live to ${liveCount} accounts.`)
      : 'No unsaved changes.'
  return {
    locale: input.locale,
    ...input.chrome,
    ...groups,
    plans: input.plans,
    planName: input.planName,
    shellOpts: shellOptions(input.shell),
    shellHelp: input.shell === 'jailed' ? 'Runs as the account, inside its home and slice. gcc is blocked.' : 'SSH logins are refused. FTP service users still work.',
    ipOn: input.ip,
    ipOff: !input.ip,
    ipHelp: input.ip ? (ar ? 'مفعّل: كل حساب يأخذ عنوانًا حرًا من المجمع.' : 'On: each account gets a free address from the pool.') : String(input.chrome.ipOffHelp ?? (ar ? 'متوقف: الحسابات تشارك عنوانًا مشتركًا.' : 'Off: accounts share 10.0.0.12.')),
    ipProblem: Boolean(input.chrome.ipProblem),
    over,
    hasOver: over.length > 0,
    noOver: over.length === 0 && input.chrome.usageKnown !== false,
    overText,
    overColor: over.length ? '#B54708' : '#0E7A4E',
    capText: String(addonVal),
    changes,
    hasChanges: n > 0,
    noChanges: n === 0,
    changesLabel: n ? `${n} ${n === 1 ? 'unsaved change' : 'unsaved changes'}` : 'All changes saved',
    chipBg: n ? '#E8EFFD' : '#E7F5EE',
    chipFg: n ? '#1D5BD6' : '#0E7A4E',
    canSave: n > 0 && !input.chrome.ipProblem,
    cannotSave: !(n > 0 && !input.chrome.ipProblem),
    saveHint,
    nothingToSaveHtml,
    saveHintColor: input.chrome.ipProblem ? '#B42318' : '#5D6B7E',
    hasResult: false,
    lastGen: 0,
    cfg: cfgLines(unl, values, units, uid, device).map(text => ({ text })),
    generationHtml: input.genLabel,
    navMark: input.locale === 'ar' ? 'inset -3px 0 0 #6EA0FF' : 'inset 3px 0 0 #6EA0FF',
    searchLabel: 'Search tools and accounts',
    searchPlaceholder: 'Search tools and accounts',
    langHref: input.locale === 'ar' ? '?lang=en' : '?lang=ar',
    langCode: input.locale === 'ar' ? 'en' : 'ar',
    langLabelHtml: input.locale === 'ar' ? 'English' : 'العربية',
  }
}

const chromeFixture = (): Scope => ({
  hostnameHtml: 'srv1.xpanel.test',
  versionHtml: 'v1.4.2',
  userMenuLabel: 'User menu: root',
  userInitialHtml: 'r',
  usernameHtml: 'root',
  plansSummaryHtml: '· 4 plans, 31 accounts',
  editTitleHtml: 'Edit plan: Business',
  metaHtml: META_FIXTURE,
  deleteHelpHtml: 'Move its 12 accounts to another plan first.',
  hostNoteHtml: HOST_NOTE_FIXTURE,
  impactLeadHtml: 'Applies to 12 accounts',
  withinHtml: 'Every account on Business is within the caps above.',
  accountsLinkHtml: 'View the 12 accounts on Business',
  slicesPhraseHtml: 'each of the 12 slices',
  commandNoteHtml: 'Command for alice, uid 20014. An empty value removes a limit when you choose Unlimited.',
  ipAlertHtml: IP_ALERT_FIXTURE,
  featureOptions: [
    { value: 'default', labelHtml: 'default · 38 of 38 tools', selectedAttr: '' },
    { value: 'starter', labelHtml: 'starter · 31 of 38 tools', selectedAttr: '' },
    { value: 'business', labelHtml: 'business · 36 of 38 tools', selectedAttr: ' selected=""' },
  ],
  shellBase: 'jailed',
  ipBase: false,
  ipProblem: false,
  sliceUid: '20014',
  sliceDevice: '/dev/sda',
  usageKnown: true,
  canDelete: false,
  cannotDelete: true,
  planId: 'business',
  product: false,
})

/** Board sample. Used only by the pixel fixture, never by the product route. */
export const whmPlansFixtureScope = (): Scope => {
  const unl = { disk: false, bw: false, ioR: false, ioW: false, iopsR: true, iopsW: false, mem: false, proc: false, cpu: false, addon: false, alias: false, sub: false, mbox: false, fwd: true, lists: false, mquota: false, ftp: false, db: false, workers: false }
  const fields = boardFields(5, unl, unl, 10)
  return assemble({
    locale: 'en',
    fields,
    overSource: [
      { user: 'alice', domain: 'alice-shop.com', owner: 'root', n: 7 },
      { user: 'omar', domain: 'omar-clinic.net', owner: 'reseller1', n: 6 },
    ],
    shell: 'jailed',
    ip: false,
    genLabel: 'Generation <span class="sc-interp">142</span> · active',
    plans: fixtureRows(),
    planName: 'Business',
    accountCount: 12,
    chrome: chromeFixture(),
  })
}

const limitText = (value: Limit, unit: string): string => value === 'unlimited' ? 'Unlimited' : unit ? `${value} ${unit}` : String(value)

const bpsText = (value: Limit): string => {
  if (value === 'unlimited') return 'Unlimited'
  if (value % MIB === 0) return `${value / MIB} MiB/s`
  return `${value} B/s`
}

const bpsField = (value: Limit): { value: string; unit: string; unlimited: boolean } => {
  if (value === 'unlimited') return { value: '', unit: 'MiB/s', unlimited: true }
  if (value % MIB === 0) return { value: String(value / MIB), unit: 'MiB/s', unlimited: false }
  return { value: String(value), unit: 'B/s', unlimited: false }
}

const numberField = (value: Limit, unit: string): { value: string; unit: string; unlimited: boolean } => (
  value === 'unlimited' ? { value: '', unit, unlimited: true } : { value: String(value), unit, unlimited: false }
)

export interface PlansSurfaceInput {
  locale: Locale
  hostname?: string
  version?: string
  generationId?: number
  username: string
  plans: readonly Plan[]
  accounts?: readonly Account[]
  resellers?: readonly Reseller[]
  featureLists?: readonly FeatureList[]
  domains?: readonly Domain[]
  catalog?: readonly CatalogTool[]
  ipPool?: readonly ServerIpEntry[]
}

const ownerName = (ownerId: string | null, resellers: readonly Reseller[]): string => {
  if (ownerId === null) return 'root'
  return resellers.find(reseller => reseller.id === ownerId)?.username ?? '—'
}

const featureName = (id: string, lists: readonly FeatureList[] | undefined): string => lists?.find(list => list.id === id)?.name ?? id

const featureOptionLabel = (list: FeatureList, catalog: readonly CatalogTool[] | undefined): string => {
  if (!catalog) return list.name
  const keys = catalog.map(tool => tool.featureKey).filter((key): key is string => typeof key === 'string' && key.length > 0)
  if (keys.length === 0) return list.name
  const disabled = list.disabled.filter(key => keys.includes(key)).length
  return `${list.name} · ${keys.length - disabled} of ${keys.length} tools`
}

/** Product scope. Sample names from the board are not used here. */
export const whmPlansFromSurface = (input: PlansSurfaceInput): Scope => {
  const ar = input.locale === 'ar'
  const plans = input.plans
  const accounts = input.accounts
  const editing = plans[0]
  const accountCount = (planId: string): number | null => accounts ? accounts.filter(account => account.planId === planId).length : null
  const totalAccounts = accounts ? accounts.length : null
  const rows: PlanRow[] = plans.map(plan => {
    const count = accountCount(plan.id)
    const editingRow = editing?.id === plan.id
    return {
      nameHtml: nameCell(formatDisplayName(plan.name), ar),
      rowKey: plan.name,
      owner: ownerName(plan.ownerId, input.resellers ?? []),
      reseller: plan.ownerId !== null,
      disk: limitText(plan.resources.diskMb, 'MiB'),
      bw: limitText(plan.resources.bandwidthMbMonth, 'MB'),
      io: `${bpsText(plan.resources.ioReadBps)} / ${bpsText(plan.resources.ioWriteBps)}`,
      mem: limitText(plan.resources.memoryMb, 'MiB'),
      proc: limitText(plan.resources.maxProcesses, ''),
      features: featureName(plan.featureListId, input.featureLists),
      accountsHtml: accountCell(count === null ? '—' : countPhrase(count, ar ? 'حساب' : 'account', ar ? 'حسابات' : 'accounts', ar)),
      editing: editingRow,
      notEditing: !editingRow,
      rowBg: editingRow ? '#F3F7FE' : '#FFFFFF',
      mark: rowMark(editingRow, ar),
      editLabel: ar ? `تعديل الخطة ${plan.name}` : `Edit plan ${plan.name}`,
      editKey: plan.id,
    }
  })
  const empty = !editing
  const resources = editing?.resources
  const caps = editing?.caps
  const spec = (key: string, label: string, unit: string, help: string, value: Limit | undefined): FieldSpec => {
    const shown = value === undefined ? numberField('unlimited', unit) : numberField(value, unit)
    const io = key === 'ioR' || key === 'ioW'
    const display = value === undefined ? { value: '', unit, unlimited: true } : io ? bpsField(value) : shown
    return { key, label, unit: display.unit, help, value: display.value, unlimited: display.unlimited, baseUnlimited: display.unlimited, baseValue: display.value }
  }
  const fields: FieldSpec[] = [
    spec('disk', 'Disk', 'MiB', 'Filesystem quota on /home. Uploads stop at the cap.', resources?.diskMb),
    spec('bw', 'Monthly bandwidth', 'MB', 'Counted from Nginx logs. Resets on the 1st.', resources?.bandwidthMbMonth),
    spec('ioR', 'Read bandwidth', 'MiB/s', 'IOReadBandwidthMax on the slice.', resources?.ioReadBps),
    spec('ioW', 'Write bandwidth', 'MiB/s', 'IOWriteBandwidthMax on the slice.', resources?.ioWriteBps),
    spec('iopsR', 'Read IOPS', 'IOPS', 'IOReadIOPSMax on the slice.', resources?.ioReadIops),
    spec('iopsW', 'Write IOPS', 'IOPS', 'IOWriteIOPSMax on the slice.', resources?.ioWriteIops),
    spec('mem', 'Memory', 'MiB', 'MemoryMax for everything in the slice.', resources?.memoryMb),
    spec('proc', 'Processes', '', 'TasksMax: PHP-FPM, cron, shell and mail together.', resources?.maxProcesses),
    spec('cpu', 'CPU', '%', 'CPUQuota. 100 % is one full core.', resources?.cpuPercent),
    spec('addon', 'Addon domains', '', 'Separate sites, each with its own docroot.', caps?.addonDomains),
    spec('alias', 'Alias domains', '', 'Extra names that serve the primary site.', caps?.aliasDomains),
    spec('sub', 'Subdomains', '', 'Explicit names, including ones under a wildcard.', caps?.subdomains),
    spec('mbox', 'Mailboxes', '', 'Mail users and combined service users.', caps?.mailboxes),
    spec('fwd', 'Forwarders', '', 'Addresses that only forward mail.', caps?.forwarders),
    spec('lists', 'Mailing lists', '', 'Lists hosted on the account.', caps?.mailingLists),
    spec('mquota', 'Default mailbox quota', 'MiB', 'For new mailboxes. Owners can change it.', editing?.defaultMailboxQuotaMb),
    spec('ftp', 'FTP accounts', '', 'FTP service users, jailed to the home.', caps?.ftpAccounts),
    spec('db', 'Databases', '', 'MariaDB, named with the username prefix.', caps?.databases),
    spec('workers', 'PHP workers per domain', '', 'pm.max_children for each domain pool.', caps?.phpWorkers),
  ]
  const usageKnown = input.domains !== undefined && accounts !== undefined && editing !== undefined
  const overSource: OverSource[] = usageKnown && editing ? accounts!.filter(account => account.planId === editing.id).map(account => ({
    user: account.username,
    domain: account.primaryDomain,
    owner: ownerName(account.ownerId, input.resellers ?? []),
    n: input.domains!.filter(domain => domain.accountId === account.id && domain.kind === 'addon').length,
  })) : []
  const count = editing && accounts ? accounts.filter(account => account.planId === editing.id).length : null
  const shared = input.ipPool?.find(ip => ip.role === 'shared' && ip.version === 4)?.address
  const free = input.ipPool?.filter(ip => ip.version === 4 && !ip.ownerId).length
  const host = input.hostname ? code(ar ? bdi(input.hostname) : escapeHtml(input.hostname)) : '—'
  const hostNote = input.hostname
    ? (ar
      ? `كل حقل مورد يُفرض على ${host} كشريحة عندما تكون متحكمات المعالج والذاكرة والدخل والعمليات موجودة. حصص الملفات تُطبق على منزل الحساب. لم يُقرأ جهاز الكتل لحدود الدخل والخرج.`
      : `Every resource field is enforced on ${host} as a cgroup v2 slice (cpu, memory, io, pids) when those controllers are present. Filesystem quotas apply on the account home. The block device for IO limits was not read.`)
    : (ar ? 'لم يُقرأ اسم المضيف، لذلك لا تسمّي هذه الملاحظة خادمًا.' : 'The host name was not read, so this note does not name a server.')
  const lists = input.featureLists ?? []
  const featureOptions = (lists.length > 0 ? lists : editing ? [{ id: editing.featureListId, name: editing.featureListId, ownerId: null, disabled: [] }] : []).map(list => ({
    value: list.id,
    labelHtml: escapeHtml(featureOptionLabel(list, input.catalog)),
    selectedAttr: editing && list.id === editing.featureListId ? ' selected=""' : '',
  }))
  const shownName = editing ? formatDisplayName(editing.name) : ''
  const planTitle = editing ? (ar ? `تعديل الخطة: ${bdi(shownName)}` : `Edit plan: ${escapeHtml(shownName)}`) : (ar ? 'لا توجد خطة للتعديل' : 'No plan to edit')
  const summary = totalAccounts === null
    ? (ar ? `· ${bdi(String(plans.length))} خطط` : `· ${plans.length} plans`)
    : (ar ? `· ${bdi(String(plans.length))} خطط، ${bdi(String(totalAccounts))} حسابات` : `· ${plans.length} plans, ${totalAccounts} accounts`)
  const saved = ar ? `${bdi('—')}` : '—'
  const meta = editing ? (ar
    ? `المالك ${mono(bdi(ownerName(editing.ownerId, input.resellers ?? [])))} · ${count === null ? bdi('—') : countPhrase(count, 'حساب', 'حسابات', true)} · آخر حفظ ${saved}`
    : `Owner ${mono(escapeHtml(ownerName(editing.ownerId, input.resellers ?? [])))} · ${count === null ? '—' : countPhrase(count, 'account', 'accounts', false)} · last saved ${saved}`)
    : (ar ? 'لا توجد خطة محفوظة.' : 'No plan is saved.')
  const within = !usageKnown
    ? (ar ? 'لم تُقرأ النطاقات الإضافية، لذلك لا تُعرض الحسابات المتجاوزة.' : 'Addon-domain use was not read, so accounts over the cap are not listed.')
    : (ar ? `كل الحسابات على ${bdi(shownName)} ضمن الحدود أعلاه.` : `Every account on ${escapeHtml(shownName)} is within the caps above.`)
  const sample = editing && accounts ? accounts.find(account => account.planId === editing.id) : undefined
  return assemble({
    locale: input.locale,
    fields,
    overSource,
    shell: editing?.shell ?? 'none',
    ip: editing?.dedicatedIp ?? false,
    genLabel: input.generationId ? `Generation <span class="sc-interp">${escapeHtml(String(input.generationId))}</span> · active` : `Generation <span class="sc-interp">—</span>`,
    plans: rows,
    planName: editing?.name ?? '',
    accountCount: count,
    chrome: {
      hostnameHtml: input.hostname ? (ar ? bdi(input.hostname) : escapeHtml(input.hostname)) : '—',
      versionHtml: input.version ? (ar ? bdi(input.version) : escapeHtml(input.version)) : '—',
      userMenuLabel: ar ? `قائمة المستخدم ${input.username}` : `User menu: ${input.username}`,
      userInitialHtml: escapeHtml((input.username.slice(0, 1) || '—').toLowerCase()),
      usernameHtml: ar ? bdi(input.username) : escapeHtml(input.username),
      plansSummaryHtml: summary,
      editTitleHtml: planTitle,
      metaHtml: meta,
      deleteHelpHtml: count === null ? (ar ? 'عدد الحسابات غير مقروء.' : 'The account count was not read.') : count > 0 ? (ar ? `انقل ${bdi(String(count))} حسابات إلى خطة أخرى أولًا.` : `Move its ${count} accounts to another plan first.`) : (ar ? 'لا حسابات على هذه الخطة.' : 'No accounts are on this plan.'),
      hostNoteHtml: hostNote,
      impactLeadHtml: count === null ? (ar ? 'الحسابات غير مقروءة' : 'Accounts were not read') : (ar ? `يسري على ${bdi(String(count))} حسابات` : `Applies to ${count} accounts`),
      withinHtml: within,
      accountsLinkHtml: !editing
        ? (ar ? 'لا حسابات للعرض' : 'No accounts to show')
        : count === null
          ? (ar ? 'عدد الحسابات غير مقروء' : 'The account count was not read')
          : (ar ? `عرض الحسابات على ${bdi(shownName)}` : `View the ${count} accounts on ${escapeHtml(shownName)}`),
      slicesPhraseHtml: count === null ? (ar ? 'كل شريحة' : 'each of the slices') : (ar ? `كل واحدة من ${bdi(String(count))} شريحة` : `each of the ${count} slices`),
      commandNoteHtml: sample
        ? (ar
          ? `الأمر للحساب ${bdi(sample.username)}، المعرف ${bdi(String(sample.uid))}. القيمة الفارغة تزيل الحد عند اختيار غير محدود.`
          : `Command for ${escapeHtml(sample.username)}, uid ${sample.uid}. An empty value removes a limit when you choose Unlimited.`)
        : (ar ? 'لا حساب على هذه الخطة له معرف، لذلك لا يوجد أمر شريحة.' : 'No account on this plan has a uid, so there is no slice command.'),
      ipAlertHtml: 'Dedicated IP cannot be saved until the free pool covers every account on this plan.',
      ipOffHelp: shared ? (ar ? `متوقف: الحسابات تشارك ${shared}.` : `Off: accounts share ${shared}.`) : (ar ? 'متوقف: لم يُقرأ عنوان مشترك.' : 'Off: a shared address was not read.'),
      featureOptions,
      shellBase: editing?.shell ?? 'none',
      ipBase: editing?.dedicatedIp ?? false,
      ipProblem: false,
      sliceUid: sample ? String(sample.uid) : '—',
      sliceDevice: null,
      usageKnown,
      canDelete: count === 0,
      cannotDelete: count !== 0,
      planId: editing?.id ?? '',
      product: true,
      freeIps: free ?? null,
    },
  })
}

const ARABIC_TEXT: Record<string, string> = {
  'Server': 'الخادم',
  'Dashboard': 'اللوحة',
  'Setup wizard': 'معالج الإعداد',
  'Accounts': 'الحسابات',
  'Create account': 'إنشاء حساب',
  'Plans': 'الخطط',
  'Feature lists': 'قوائم الميزات',
  'Resellers': 'الموزعون',
  'Domains': 'النطاقات',
  'Web': 'الويب',
  'Web server': 'خادم الويب',
  'PHP': 'PHP',
  'SSL/TLS': 'SSL/TLS',
  'DNS zones': 'نطاقات DNS',
  'Services': 'الخدمات',
  'Security': 'الأمان',
  'Firewall': 'الجدار',
  'Panel security': 'أمان اللوحة',
  'SSH': 'SSH',
  'Operations': 'التشغيل',
  'Backups': 'النسخ',
  'Transfer tool': 'أداة النقل',
  'Upgrade': 'الترقية',
  'Audit log': 'سجل التدقيق',
  'Create plan': 'إنشاء خطة',
  'All plans': 'كل الخطط',
  'A plan sets the slice limits, caps and feature list for every account on it. Saving a plan updates the accounts already on it, live, without a restart.': 'تحدد الخطة حدود الشريحة والسقوف وقائمة الميزات لكل حساب عليها. حفظ الخطة يحدّث الحسابات الموجودة فورًا دون إعادة تشغيل.',
  'Reseller plans are visible to their reseller and to root, and count against the reseller\'s totals.': 'خطط الموزع ظاهرة له وللجذر، وتُحتسب ضمن حصته.',
  'Plan': 'الخطة',
  'Owner': 'المالك',
  'Disk': 'القرص',
  'Bandwidth / month': 'النقل / شهر',
  'Disk IO read / write': 'قراءة / كتابة القرص',
  'Memory': 'الذاكرة',
  'Processes': 'العمليات',
  'Feature list': 'قائمة الميزات',
  'Action': 'إجراء',
  'Edit': 'تعديل',
  'General': 'عام',
  'Plan name': 'اسم الخطة',
  'Shell access': 'وصول الصدفة',
  'Dedicated IP': 'عنوان مخصص',
  'Own address for each account': 'عنوان خاص لكل حساب',
  'Resources': 'الموارد',
  'Limits on each account\'s': 'حدود شريحة كل حساب',
  'Storage and bandwidth': 'التخزين والنقل',
  'Monthly bandwidth': 'النقل الشهري',
  'Disk IO': 'دخل وخرج القرص',
  'Read bandwidth': 'سرعة القراءة',
  'Write bandwidth': 'سرعة الكتابة',
  'Read IOPS': 'عمليات القراءة',
  'Write IOPS': 'عمليات الكتابة',
  'Memory, processes and CPU': 'الذاكرة والعمليات والمعالج',
  'CPU': 'المعالج',
  'Caps': 'السقوف',
  'Addon domains': 'النطاقات الإضافية',
  'Alias domains': 'النطاقات البديلة',
  'Subdomains': 'النطاقات الفرعية',
  'Email': 'البريد',
  'Mailboxes': 'صناديق البريد',
  'Forwarders': 'المحوّلات',
  'Mailing lists': 'القوائم البريدية',
  'Default mailbox quota': 'حصة الصندوق الافتراضية',
  'FTP, databases and PHP': 'النقل وقواعد البيانات وPHP',
  'FTP accounts': 'حسابات النقل',
  'Databases': 'قواعد البيانات',
  'PHP workers per domain': 'عمال PHP لكل نطاق',
  'Unlimited': 'غير محدود',
  'Delete plan': 'حذف الخطة',
  'Discard changes': 'تجاهل التغييرات',
  'Save plan': 'حفظ الخطة',
  'Impact': 'الأثر',
  'Unsaved changes': 'تغييرات غير محفوظة',
  'How saving applies': 'كيف يُطبَّق الحفظ',
  'No shell': 'بلا صدفة',
  'Jailed shell': 'صدفة معزولة',
  'Reseller plan': 'خطة موزع',
  'Editing below': 'التعديل أدناه',
  'Shown to account owners. Renaming does not move accounts.': 'يظهر لأصحاب الحسابات. تغيير الاسم لا ينقل الحسابات.',
  'Hides xPanel tools; never deletes data.': 'يخفي أدوات اللوحة ولا يحذف البيانات.',
  'Edit feature lists': 'تعديل قوائم الميزات',
  'The plan is stored as desired state and written to the audit log.': 'تُحفظ الخطة كحالة مطلوبة وتُكتب في سجل التدقيق.',
  'Caps apply from the next create request. Nothing that exists is removed.': 'تُطبق السقوف من طلب الإنشاء التالي. لا يُحذف شيء موجود.',
  'No unsaved changes.': 'لا تغييرات غير محفوظة.',
  'All changes saved': 'كل التغييرات محفوظة',
  'Nothing to save. The values above are in effect on all 12 slices.': 'لا شيء للحفظ. القيم أعلاه سارية.',
  'Filesystem quota on /home. Uploads stop at the cap.': 'حصة الملفات على المنزل. يتوقف الرفع عند السقف.',
  'Counted from Nginx logs. Resets on the 1st.': 'يُحسب من سجلات الخادم. يصفَّر في أول الشهر.',
  'IOReadBandwidthMax on the slice.': 'حد سرعة القراءة على الشريحة.',
  'IOWriteBandwidthMax on the slice.': 'حد سرعة الكتابة على الشريحة.',
  'IOReadIOPSMax on the slice.': 'حد عمليات القراءة على الشريحة.',
  'IOWriteIOPSMax on the slice.': 'حد عمليات الكتابة على الشريحة.',
  'MemoryMax for everything in the slice.': 'حد الذاكرة لكل ما داخل الشريحة.',
  'TasksMax: PHP-FPM, cron, shell and mail together.': 'حد العمليات للغة PHP والمهام والصدفة والبريد معًا.',
  'CPUQuota. 100 % is one full core.': 'حصة المعالج. 100٪ نواة كاملة.',
  'Separate sites, each with its own docroot.': 'مواقع منفصلة، لكل منها جذر مستندات.',
  'Extra names that serve the primary site.': 'أسماء إضافية تخدم الموقع الأساسي.',
  'Explicit names, including ones under a wildcard.': 'أسماء صريحة، بما فيها ما تحت البدل.',
  'Mail users and combined service users.': 'مستخدمو البريد ومستخدمو الخدمة.',
  'Addresses that only forward mail.': 'عناوين تعيد توجيه البريد فقط.',
  'Lists hosted on the account.': 'قوائم مستضافة على الحساب.',
  'For new mailboxes. Owners can change it.': 'للصناديق الجديدة. يمكن للمالك تغييرها.',
  'FTP service users, jailed to the home.': 'مستخدمو النقل، محصورون في المنزل.',
  'MariaDB, named with the username prefix.': 'قواعد بيانات بالبادئة اسم المستخدم.',
  'pm.max_children for each domain pool.': 'الحد الأقصى لعمال كل نطاق.',
  'Runs as the account, inside its home and slice. gcc is blocked.': 'تعمل باسم الحساب داخل منزله وشريحته. المترجم محظور.',
  'SSH logins are refused. FTP service users still work.': 'يُرفض دخول SSH. مستخدمو النقل يبقون.',
  'No plan to edit': 'لا توجد خطة للتعديل',
  'No plan is saved.': 'لا توجد خطة محفوظة.',
  'Addon-domain use was not read, so accounts over the cap are not listed.': 'لم تُقرأ النطاقات الإضافية، لذلك لا تُعرض الحسابات المتجاوزة.',
  'No accounts are on this plan.': 'لا حسابات على هذه الخطة.',
  'The account count was not read.': 'عدد الحسابات غير مقروء.',
  'No accounts to show': 'لا حسابات للعرض',
  'Accounts were not read': 'الحسابات غير مقروءة',
  'No account on this plan has a uid, so there is no slice command.': 'لا حساب على هذه الخطة له معرف، لذلك لا يوجد أمر شريحة.',
  'The host name was not read, so this note does not name a server.': 'لم يُقرأ اسم المضيف، لذلك لا تسمّي هذه الملاحظة خادمًا.',
  '. PHP-FPM pools, CGI, cron, shell, Node, Python and mail delivery all share them.': '. أحواض المعالجة والمهام والصدفة والبريد تتشاركها.',
  'Counts checked on every create request. Lowering a cap never removes what an account already has; it only refuses the next one.': 'تُفحص الأعداد عند كل طلب إنشاء. خفض السقف لا يحذف ما يملكه الحساب؛ يرفض الطلب التالي فقط.',
  'Their existing addon domains stay online. Adding another is refused while they have': 'تبقى النطاقات الإضافية الحالية تعمل. يُرفض إضافة أخرى ما دام لديهم',
  'or more, with the message "You have used': 'أو أكثر، مع الرسالة «استخدمت',
  'addon domains."': 'نطاقات إضافية».',
  'Nothing to save. The account count was not read, so this does not name a slice count.': 'لا شيء للحفظ. لم يُقرأ عدد الحسابات، لذلك لا يُذكر عدد الشرائح.',
  'Applies live after the accounts are read.': 'يُطبَّق فورًا بعد قراءة الحسابات.',
  'Fix the dedicated IP problem to save.': 'أصلح مشكلة العنوان المخصص قبل الحفظ.',
  'Dedicated IP cannot be saved until the free pool covers every account on this plan.': 'لا يمكن حفظ العنوان المخصص قبل أن يغطي المجمع الحر كل حساب على هذه الخطة.',
  'Off: a shared address was not read.': 'متوقف: لم يُقرأ عنوان مشترك.',
  'Search tools and accounts': 'ابحث في الأدوات والحسابات',
}

const translateVisible = (html: string): string => html.replace(/>([^<]+)</g, (full, text: string) => {
  const leading = text.match(/^\s*/)?.[0] ?? ''
  const trailing = text.match(/\s*$/)?.[0] ?? ''
  const core = text.trim()
  const translated = ARABIC_TEXT[core]
  return translated === undefined ? full : `>${leading}${translated}${trailing}<`
})

const plansScript = (product: boolean): string => `<script>
(function () {
  var root = document.querySelector('[data-board-port="xwhm-plans"]');
  if (!root) return;
  var product = ${product ? 'true' : 'false'};
  var form = root.querySelector('form');
  if (form) form.addEventListener('submit', function (event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  root.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    if (target.name === 'shell') {
      root.querySelectorAll('input[name="shell"]').forEach(function (input) {
        var label = input.closest('label');
        if (!label) return;
        var on = input.checked;
        label.style.borderColor = on ? '#1D5BD6' : '#D0D5DD';
        label.style.background = on ? '#F3F7FE' : '#FFFFFF';
      });
      return;
    }
    if (target.getAttribute('role') === 'switch') {
      var knob = target.parentElement && target.parentElement.querySelector('span');
      if (target.checked) {
        target.style.borderColor = '#1D5BD6';
        target.style.background = '#1D5BD6';
        if (knob) { knob.style.insetInlineStart = '22px'; knob.style.background = '#FFFFFF'; }
      } else {
        target.style.borderColor = '#5D6B7E';
        target.style.background = '#FFFFFF';
        if (knob) { knob.style.insetInlineStart = '4px'; knob.style.background = '#5D6B7E'; }
      }
      return;
    }
    var label = target.getAttribute('aria-label') || '';
    if (label.indexOf('Unlimited') !== 0 && label.indexOf('غير محدود') !== 0) return;
    var wrap = target.closest('div');
    var input = wrap && wrap.querySelector('input[type="text"]');
    if (!input) return;
    if (target.checked) {
      input.disabled = true;
      input.value = '';
      input.placeholder = 'Unlimited';
      input.style.background = '#F0F2F5';
      input.style.borderColor = '#E2E6EC';
      input.style.color = '#5D6B7E';
    } else {
      input.disabled = false;
      input.placeholder = '';
      input.style.background = '#FFFFFF';
      input.style.borderColor = '#D0D5DD';
      input.style.color = '#101828';
    }
  });
  root.addEventListener('click', function (event) {
    var remove = event.target && event.target.closest ? event.target.closest('[data-plan-delete]') : null;
    if (remove && product && window.xpanelSessionRequest && !remove.disabled) {
      event.preventDefault();
      Promise.resolve(window.xpanelSessionRequest('DELETE', '/api/plans/' + remove.getAttribute('data-plan-delete'))).then(function () { location.reload(); });
      return;
    }
    var button = event.target && event.target.closest ? event.target.closest('[data-plans-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-plans-action');
    if (action === 'discard' && product) location.reload();
    if (!product || !window.xpanelSessionRequest) return;
    if (action === 'edit') {
      var key = button.getAttribute('data-plan-key');
      if (key) location.href = '/whm/plans?plan=' + encodeURIComponent(key);
    }
    if (action === 'save' && button.disabled) return;
    if (action !== 'save') return;
    event.preventDefault();
    var value = function (id) {
      var el = root.querySelector('#' + id);
      if (!el || el.disabled) return 'unlimited';
      var number = Number(el.value);
      return Number.isFinite(number) ? number : 'unlimited';
    };
    var bytes = function (id) {
      var el = root.querySelector('#' + id);
      var amount = value(id);
      if (amount === 'unlimited') return 'unlimited';
      var scale = el && el.getAttribute('data-bytes-scale');
      var factor = scale ? Number(scale) : 1;
      return amount * (Number.isFinite(factor) && factor > 0 ? factor : 1);
    };
    var shell = (root.querySelector('input[name="shell"]:checked') || {}).value || 'none';
    var body = {
      name: (root.querySelector('#f-name') || {}).value || '',
      featureListId: (root.querySelector('#f-features') || {}).value || '',
      shell: shell,
      dedicatedIp: !!((root.querySelector('[role="switch"]') || {}).checked),
      resources: {
        diskMb: value('f-disk'), bandwidthMbMonth: value('f-bw'),
        ioReadBps: bytes('f-ioR'), ioWriteBps: bytes('f-ioW'),
        ioReadIops: value('f-iopsR'), ioWriteIops: value('f-iopsW'),
        memoryMb: value('f-mem'), maxProcesses: value('f-proc'), cpuPercent: value('f-cpu')
      },
      caps: {
        addonDomains: value('f-addon'), aliasDomains: value('f-alias'), subdomains: value('f-sub'),
        mailboxes: value('f-mbox'), forwarders: value('f-fwd'), mailingLists: value('f-lists'),
        ftpAccounts: value('f-ftp'), databases: value('f-db'), phpWorkers: value('f-workers')
      },
      defaultMailboxQuotaMb: value('f-mquota')
    };
    var id = root.getAttribute('data-plan-id');
    var request = id ? window.xpanelSessionRequest('PATCH', '/api/plans/' + id, body) : window.xpanelSessionRequest('POST', '/api/plans', body);
    Promise.resolve(request).then(function () { location.reload(); });
  });
})();
</script>`

export const renderWhmPlans = (scope: Scope): string => {
  const locale = scope.locale === 'ar' ? 'ar' : 'en'
  const expanded = expand(stripHandlers(WHM_PLANS_TEMPLATE), scope)
  const dir = locale === 'ar' ? ' dir="rtl"' : ''
  const product = scope.product === true ? ' data-product="true"' : ''
  const planId = typeof scope.planId === 'string' && scope.planId ? ` data-plan-id="${escapeHtml(scope.planId)}"` : ''
  const open = expanded.indexOf('>')
  const html = `${expanded.slice(0, open)}${dir}${product}${planId}>${PORT_STYLE}${expanded.slice(open + 1)}`
  const translated = locale === 'ar' ? translateVisible(html) : html
  return `${translated}${plansScript(scope.product === true)}`
}

export const renderWhmPlansFixture = (): string => renderWhmPlans(whmPlansFixtureScope())
