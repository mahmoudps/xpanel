import {
  assertResellerCapacity,
  hasAcl,
  isXpanelError,
  type Account,
  type Limit,
  type Plan,
  type Principal,
  type Reseller,
  type ShellAccess,
} from '@xpanel/core'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import { isolateLtrRuns } from '../bidi-runs.ts'
import { escapeHtml, formatAsciiNumber, formatBytes } from '../tokens.ts'

const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/

/** A whole sentence, not an identifier that happens to contain Arabic letters. */
const isArabicSentence = (value: string): boolean => {
  const text = value.trim()
  return ARABIC_LETTER.test(text) && !/[A-Za-z@/\\]/.test(text)
}

const ltr = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

const rich = (value: string): string => value.split(/«([^»]*)»/).map((part, index) => index % 2 === 1 ? ltr(part) : isolateLtrRuns(part)).join('')

const TOKEN = /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?(?: ?UTC|Z)?|\d{1,2}:\d{2}(?::\d{2})?(?: ?UTC)?|\d+(?:-\d+)+|\d+(?:[.,]\d+)*/g

/** Dates, dash-joined numbers, and bare numbers each stay in one LTR isolate. */
const isolateTokens = (text: string): string => {
  const pattern = new RegExp(TOKEN.source, 'g')
  let html = ''
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    if (index === undefined) continue
    html += escapeHtml(text.slice(cursor, index))
    html += ltr(match[0])
    cursor = index + match[0].length
  }
  html += escapeHtml(text.slice(cursor))
  return html
}

/** English stays escaped text. Arabic isolates Latin tokens, dates, and numbers. */
const show = (value: string, ar: boolean): string => {
  if (!ar) return escapeHtml(value)
  if (value.includes('«')) return rich(value)
  if (ARABIC_LETTER.test(value)) return isolateTokens(value)
  return ltr(value)
}

/** Arabic prose stays in the sans stack, with numbers isolated inside it. */
const prose = (value: string, ar: boolean): string =>
  ar && isArabicSentence(value) ? `<span class="xp-ar-sentence">${show(value, true)}</span>` : show(value, ar)

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

const ACTIVE = '/whm/accounts/new'
const linkStyle = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; color: #C9D3E1; text-decoration: none; font-size: 14px'
const activeLtr = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset 3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'
const activeRtl = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset -3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'
const fieldsetStyle = 'margin: 0; min-width: 0; padding: 24px; border: 1px solid #E2E6EC; border-radius: 12px; background: #FFFFFF; display: flex; flex-direction: column; gap: 16px'
const legendStyle = 'float: left; width: 100%; padding: 0; margin: 0; font-size: 16px; font-weight: 600'
const fieldStyle = 'display: flex; flex-direction: column; gap: 6px; min-width: 0'
const labelStyle = 'font-size: 13px; font-weight: 600'
const helpStyle = 'font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6; max-width: 68ch'
const inputStyle = "width: 100%; max-width: 420px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #101828"
const selectStyle = "width: 100%; max-width: 420px; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828"
const choiceStyle = 'display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-height: 44px; padding: 14px; border-radius: 10px; border: 1.5px solid #E2E6EC; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; text-align: start; cursor: pointer'
const buttonStyle = 'flex: none; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer'

export interface CreateAccountInput {
  locale?: 'en' | 'ar'
  principal: Principal
  hostname?: string
  version?: string
  generationId?: number
  plans?: Plan[]
  accounts?: Account[]
  resellers?: Reseller[]
  activeReseller?: Reseller | null
  draft?: { username?: string; domain?: string; email?: string }
}

interface PlanView {
  id: string
  name: string
  shell: ShellAccess
  shellLabel: string
  limitsHtml: string
}

interface CapView {
  html: string
  blocked: boolean
  note: string
}

const finiteNumbers = (values: readonly Limit[]): number[] | null => {
  const numbers: number[] = []
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    numbers.push(value)
  }
  return numbers
}

const limitText = (value: Limit, kind: 'mib' | 'count' | 'percent' | 'rate', ar: boolean): string => {
  if (value === 'unlimited') return ar ? 'غير محدود' : 'Unlimited'
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (kind === 'mib') return `${formatAsciiNumber(value)} MiB`
  if (kind === 'percent') return `${formatAsciiNumber(value)}%`
  if (kind === 'rate') return `${formatBytes(value)}/s`
  return formatAsciiNumber(value)
}

const shellLabel = (shell: ShellAccess, ar: boolean): string =>
  shell === 'none' ? (ar ? 'بدون صدفة' : 'No shell') : (ar ? 'صدفة مقيدة' : 'Jailed shell')

const pair = (label: string, value: string, ar: boolean): string =>
  `<div style="min-width: 0"><dt style="font-size: 12px; font-weight: 600; color: #5D6B7E">${show(label, ar)}</dt><dd style="margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere">${show(value, ar)}</dd></div>`

const limitsHtml = (plan: Plan, ar: boolean): string => {
  const rows = [
    pair(ar ? 'القرص' : 'Disk', limitText(plan.resources.diskMb, 'mib', ar), ar),
    pair(ar ? 'التراسل الشهري' : 'Monthly bandwidth', limitText(plan.resources.bandwidthMbMonth, 'mib', ar), ar),
    pair(ar ? 'الذاكرة' : 'Memory', limitText(plan.resources.memoryMb, 'mib', ar), ar),
    pair(ar ? 'قراءة القرص' : 'Disk read', limitText(plan.resources.ioReadBps, 'rate', ar), ar),
    pair(ar ? 'كتابة القرص' : 'Disk write', limitText(plan.resources.ioWriteBps, 'rate', ar), ar),
    pair(ar ? 'عمليات القراءة' : 'Read operations', limitText(plan.resources.ioReadIops, 'count', ar), ar),
    pair(ar ? 'عمليات الكتابة' : 'Write operations', limitText(plan.resources.ioWriteIops, 'count', ar), ar),
    pair(ar ? 'العمليات' : 'Processes', limitText(plan.resources.maxProcesses, 'count', ar), ar),
    pair(ar ? 'المعالج' : 'CPU', limitText(plan.resources.cpuPercent, 'percent', ar), ar),
    pair(ar ? 'حصة صندوق البريد' : 'Mailbox quota', limitText(plan.defaultMailboxQuotaMb, 'mib', ar), ar),
    pair(ar ? 'النطاقات الإضافية' : 'Addon domains', limitText(plan.caps.addonDomains, 'count', ar), ar),
    pair(ar ? 'النطاقات البديلة' : 'Alias domains', limitText(plan.caps.aliasDomains, 'count', ar), ar),
    pair(ar ? 'النطاقات الفرعية' : 'Subdomains', limitText(plan.caps.subdomains, 'count', ar), ar),
    pair(ar ? 'صناديق البريد' : 'Mailboxes', limitText(plan.caps.mailboxes, 'count', ar), ar),
    pair(ar ? 'قواعد البيانات' : 'Databases', limitText(plan.caps.databases, 'count', ar), ar),
    pair(ar ? 'حسابات نقل الملفات' : 'FTP accounts', limitText(plan.caps.ftpAccounts, 'count', ar), ar),
    pair(ar ? 'عمال «PHP»' : 'PHP workers', limitText(plan.caps.phpWorkers, 'count', ar), ar),
    pair(ar ? 'عنوان مخصص' : 'Dedicated address', plan.dedicatedIp ? (ar ? 'نعم' : 'Yes') : (ar ? 'لا' : 'No'), ar),
  ].join('')
  const feature = ar
    ? `<p style="margin: 0; font-size: 13px; color: #344054">قائمة الميزات ${ltr(plan.featureListId)}</p>`
    : `<p style="margin: 0; font-size: 13px; color: #344054">Feature list ${ltr(plan.featureListId)}</p>`
  return `<div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
    <h2 style="margin: 0; font-size: 14px; font-weight: 600">${ar ? 'الحدود' : 'Limits'}</h2>
    <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${prose(ar ? 'من الخطة' : 'From the plan', ar)}</span>
  </div>
  <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px 16px">${rows}</dl>
  ${feature}
  <a href="/whm/plans" style="font-size: 14px; font-weight: 600">${ar ? 'عرض الخطط' : 'View plans'}</a>`
}

const capNote = (kind: 'fit' | 'blocked' | 'unknown', ar: boolean): string => {
  if (kind === 'blocked') return prose(ar ? 'هذه الخطة تتجاوز سقف المالك.' : 'This plan is over the owner cap.', ar)
  if (kind === 'unknown') return prose(ar ? 'فحص السعة غير متاح.' : 'The capacity check is unavailable.', ar)
  return prose(ar ? 'هذه الخطة تناسب المالك.' : 'This plan fits the owner.', ar)
}

const capHtml = (reseller: Reseller, owned: readonly Plan[], plan: Plan, kind: 'fit' | 'blocked' | 'unknown', ar: boolean): string => {
  const note = capNote(kind, ar)
  if (kind === 'unknown') {
    return `<div style="display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 10px; border: 1px solid #E2E6EC; background: #F8F9FB"><h2 style="margin: 0; font-size: 14px; font-weight: 600">${ar ? 'بعد هذا الحساب' : 'After this account'}</h2><p style="margin: 0; font-size: 13px; color: #344054">${note}</p></div>`
  }
  const accountsAfter = formatAsciiNumber(owned.length + 1)
  const accountsMax = limitText(reseller.maxAccounts, 'count', ar)
  const diskValues = [...owned.map(item => item.resources.diskMb), plan.resources.diskMb]
  const diskNumbers = finiteNumbers(diskValues)
  const diskTotalKnown = reseller.totalDiskMb === 'unlimited' || typeof reseller.totalDiskMb === 'number'
  const bandwidthValues = [...owned.map(item => item.resources.bandwidthMbMonth), plan.resources.bandwidthMbMonth]
  const bandwidthNumbers = finiteNumbers(bandwidthValues)
  const bandwidthTotalKnown = reseller.totalBandwidthMb === 'unlimited' || typeof reseller.totalBandwidthMb === 'number'
  const rows = [
    pair(ar ? 'الحسابات' : 'Accounts', `${accountsAfter} / ${accountsMax}`, ar),
    diskNumbers && diskTotalKnown ? pair(ar ? 'القرص' : 'Disk', `${formatAsciiNumber(diskNumbers.reduce((sum, value) => sum + value, 0))} MiB / ${limitText(reseller.totalDiskMb, 'mib', ar)}`, ar) : '',
    bandwidthNumbers && bandwidthTotalKnown ? pair(ar ? 'التراسل' : 'Bandwidth', `${formatAsciiNumber(bandwidthNumbers.reduce((sum, value) => sum + value, 0))} MiB / ${limitText(reseller.totalBandwidthMb, 'mib', ar)}`, ar) : '',
  ].join('')
  const frame = kind === 'blocked' ? '#F4B8B2' : '#E2E6EC'
  const fill = kind === 'blocked' ? '#FDECEA' : '#F8F9FB'
  const ink = kind === 'blocked' ? '#B42318' : '#344054'
  return `<div style="display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 10px; border: 1px solid ${frame}; background: ${fill}"><h2 style="margin: 0; font-size: 14px; font-weight: 600">${ar ? 'بعد هذا الحساب' : 'After this account'}</h2><dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px 16px">${rows}</dl><p style="margin: 0; font-size: 13px; color: ${ink}">${note}</p></div>`
}

const capacity = (reseller: Reseller, plan: Plan, plans: readonly Plan[], accounts: readonly Account[] | undefined, ar: boolean): CapView => {
  const unknown = (html = capHtml(reseller, [], plan, 'unknown', ar)): CapView => ({ html, blocked: false, note: capNote('unknown', ar) })
  if (!accounts) return unknown()
  const owned: Plan[] = []
  for (const account of accounts) {
    if (account.ownerId !== reseller.id) continue
    const ownedPlan = plans.find(item => item.id === account.planId)
    if (!ownedPlan) return unknown()
    owned.push(ownedPlan)
  }
  try {
    assertResellerCapacity({ reseller, ownedAccounts: owned.map(item => ({ plan: item })), newPlan: plan })
    return { html: capHtml(reseller, owned, plan, 'fit', ar), blocked: false, note: capNote('fit', ar) }
  } catch (error) {
    if (isXpanelError(error) && (error.code === 'OVERSELL_BLOCKED' || error.code === 'LIMIT_EXCEEDED')) {
      return { html: capHtml(reseller, owned, plan, 'blocked', ar), blocked: true, note: capNote('blocked', ar) }
    }
    return unknown()
  }
}

const chip = (label: string, bg: string, fg: string, ar: boolean): string =>
  `<span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${bg}; color: ${fg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${fg}"></span>${prose(label, ar)}</span>`

const navHtml = (ar: boolean, hostnameHtml: string): string => {
  const active = ar ? activeRtl : activeLtr
  const index = ar ? 1 : 0
  const groups = NAV.map(group => {
    const items = group.items.map(item => {
      const current = item.href === ACTIVE
      const label = show(item.label[index] ?? '', ar)
      return `<li><a href="${item.href}"${current ? ' aria-current="page"' : ''} style="${current ? active : linkStyle}">${svg(item.icon)}${label.includes('<') ? `<span>${label}</span>` : label}</a></li>`
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
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #8A99AF; line-height: 1.3; min-width: 0; max-width: 100%; overflow-wrap: anywhere">${hostnameHtml}</span>
      </div>
    </div>
    ${groups}
  </nav>`
}

const headerHtml = (ar: boolean, username: string, generationHtml: string, generationAttr: string, version: string): string => {
  const initial = escapeHtml((username.slice(0, 1) || '—').toLowerCase())
  const lang = ar
    ? `<a href="?lang=en" lang="en" hreflang="en" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">English</a>`
    : `<a href="?lang=ar" lang="ar" hreflang="ar" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">العربية</a>`
  return `<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 32px; background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
    <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px; min-width: 0; display: flex; align-items: center">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; inset-inline-start: 12px; pointer-events: none"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
      <input type="search" aria-label="${escapeHtml(ar ? 'بحث' : 'Search')}" placeholder="${escapeHtml(ar ? 'بحث' : 'Search')}" style="width: 100%; min-width: 0; min-height: 40px; padding-inline-start: 36px; padding-inline-end: 40px; border-radius: 8px; border: 1px solid #D0D5DD; background: #F8F9FB; font-family: inherit; font-size: 14px; color: #101828">
      <kbd aria-hidden="true" style="position: absolute; inset-inline-end: 8px; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #475467">/</kbd>
    </div>
    <span style="flex: 1 1 0"></span>
    <span${generationAttr} style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${generationAttr ? '#E7F5EE' : '#EEF0F3'}; color: ${generationAttr ? '#0E7A4E' : '#344054'}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${generationAttr ? '#0E7A4E' : '#344054'}"></span>${generationHtml}</span>
    <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(version, ar)}</span>
    ${lang}
    <button type="button" data-action="logout" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #344054; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${ar ? 'تسجيل الخروج' : 'Sign out'}</button>
    <button type="button" aria-label="${escapeHtml(ar ? `قائمة المستخدم ${username}` : `User menu for ${username}`)}" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding-block: 0; padding-inline: 6px 12px; border-radius: 999px; border: 1px solid #E2E6EC; background: #FFFFFF; color: #101828; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; cursor: pointer"><span aria-hidden="true" style="width: 32px; height: 32px; border-radius: 50%; background: #0E1726; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 13px">${initial}</span>${show(username, ar)}</button>
  </header>`
}

const clientScript = (json: string): string => `<script type="application/json" id="xp-create-model">${json}</script>
<script>
(function () {
  var root = document.querySelector('[data-board-port="xwhm-account-create"]');
  var modelNode = document.getElementById('xp-create-model');
  if (!root || !modelNode) return;
  var model = JSON.parse(modelNode.textContent || '{}');
  var form = root.querySelector('[data-create-account-form]');
  if (!form) return;
  form.addEventListener('submit', function (event) {
    var button = form.querySelector('[data-create-submit]');
    if (button && button.getAttribute('data-blocked') === 'true') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  function planById(id) {
    var plans = model.plans || [];
    for (var i = 0; i < plans.length; i++) if (plans[i].id === id) return plans[i];
    return null;
  }
  function selectChoice(attr, value) {
    var nodes = form.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('aria-pressed', nodes[i].getAttribute(attr) === value ? 'true' : 'false');
  }
  function setText(selector, value) {
    var node = root.querySelector(selector);
    if (node) node.textContent = value || '—';
  }
  function paintMeter(value) {
    var meter = root.querySelector('[data-password-meter]');
    var bars = root.querySelectorAll('[data-password-bar]');
    var length = value.length;
    var filled = length === 0 ? 0 : length < 8 ? 1 : 4;
    var color = length < 8 ? '#B54708' : '#0E7A4E';
    for (var i = 0; i < bars.length; i++) bars[i].style.background = i < filled ? color : '#E2E6EC';
    if (meter) {
      var template = length === 0 ? model.meterEmpty : length < 8 ? model.meterShort : model.meterOk;
      meter.innerHTML = String(template || '').replace('__N__', '<bdi dir="ltr">' + String(length) + '</bdi>');
    }
  }
  function paint(planId) {
    var plan = planById(planId);
    var limits = root.querySelector('#xp-plan-limits');
    if (limits && plan) limits.innerHTML = plan.limitsHtml;
    if (plan) {
      selectChoice('data-shell-choice', plan.shell);
      setText('[data-preview-plan]', plan.name);
      setText('[data-preview-shell]', plan.shellLabel);
    }
    var owner = form.querySelector('[data-owner-choice][aria-pressed="true"]');
    var ownerId = owner ? owner.getAttribute('data-owner-choice') : '';
    setText('[data-preview-owner]', owner ? owner.getAttribute('data-owner-name') : '');
    var cap = ownerId && plan ? (model.caps || {})[ownerId + '\\n' + plan.id] : null;
    var host = root.querySelector('#xp-owner-cap');
    if (host) host.innerHTML = cap ? cap.html : '';
    var note = root.querySelector('#submit-note');
    if (note) note.innerHTML = cap && cap.note ? cap.note : (model.note || '');
    var button = form.querySelector('[data-create-submit]');
    if (button && !button.disabled) {
      if (cap && cap.blocked) button.setAttribute('data-blocked', 'true');
      else button.removeAttribute('data-blocked');
    }
    var previewChip = root.querySelector('[data-preview-chip]');
    if (previewChip) previewChip.innerHTML = cap && cap.blocked ? model.blockedChip : model.readyChip;
  }
  form.addEventListener('click', function (event) {
    var node = event.target;
    var target = node && node.closest ? node.closest('[data-plan-choice],[data-owner-choice],[data-shell-choice],[data-toggle-password],[data-generate-password]') : null;
    if (!target || !form.contains(target)) return;
    if (target.hasAttribute('data-toggle-password')) {
      var password = form.querySelector('[name="password"]');
      var showing = password.type === 'password';
      password.type = showing ? 'text' : 'password';
      target.setAttribute('aria-pressed', showing ? 'true' : 'false');
      return;
    }
    if (target.hasAttribute('data-generate-password')) {
      var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      var bytes = new Uint8Array(20);
      crypto.getRandomValues(bytes);
      var generated = '';
      for (var i = 0; i < bytes.length; i++) generated += alphabet[bytes[i] % alphabet.length];
      var field = form.querySelector('[name="password"]');
      field.value = generated;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      paintMeter(generated);
      return;
    }
    if (target.hasAttribute('data-plan-choice')) {
      var id = target.getAttribute('data-plan-choice');
      var select = form.querySelector('[name="planId"]');
      if (select && id) {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      selectChoice('data-plan-choice', id);
      paint(id);
      return;
    }
    if (target.hasAttribute('data-owner-choice')) {
      selectChoice('data-owner-choice', target.getAttribute('data-owner-choice'));
      var current = form.querySelector('[name="planId"]');
      paint(current ? current.value : '');
      return;
    }
    if (target.hasAttribute('data-shell-choice')) {
      selectChoice('data-shell-choice', target.getAttribute('data-shell-choice'));
      setText('[data-preview-shell]', target.getAttribute('data-shell-label'));
    }
  });
  form.addEventListener('input', function (event) {
    var field = event.target;
    if (!field || !field.name) return;
    if (field.name === 'username') setText('[data-preview-user]', field.value);
    if (field.name === 'primaryDomain') setText('[data-preview-domain]', field.value);
    if (field.name === 'password') paintMeter(field.value);
  });
})();
</script>`

export const whmAccountCreateFromProps = (input: CreateAccountInput): CreateAccountInput => input

export const renderWhmAccountCreate = (input: CreateAccountInput): string => {
  const ar = input.locale === 'ar'
  const principal = input.principal
  const plans = input.plans
  const selected = plans?.[0]
  const allowed = hasAcl(principal, input.activeReseller ?? null, 'create-account')
  const catalogMissing = plans === undefined
  const catalogEmpty = plans !== undefined && plans.length === 0
  const submitDisabled = !allowed || catalogMissing || catalogEmpty
  const generationLive = typeof input.generationId === 'number' && Number.isSafeInteger(input.generationId) && input.generationId > 0
  const generationLabel = generationLive
    ? (ar ? `الجيل «${input.generationId}» · نشط` : `Generation ${input.generationId} · active`)
    : '—'
  const generationAttr = generationLive ? ` data-generation-chip="${input.generationId}"` : ''
  const hostnameHtml = input.hostname ? show(input.hostname, ar) : (ar ? prose('الخادم', true) : '—')
  const version = input.version && input.version.trim() ? input.version : '—'
  const font = ar
    ? "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"
    : "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
  const owners: Array<{ id: string; username: string }> = []
  let ownersNote = ''
  if (principal.kind === 'root') {
    owners.push({ id: '', username: principal.username })
    if (input.resellers === undefined) ownersNote = ar ? 'قائمة الموزعين غير متاحة.' : 'The reseller list is unavailable.'
    else for (const reseller of input.resellers) owners.push({ id: reseller.id, username: reseller.username })
  } else if (principal.kind === 'reseller' && input.activeReseller?.id === principal.id) {
    owners.push({ id: principal.id, username: principal.username })
  } else if (principal.kind === 'reseller') {
    ownersNote = ar ? 'سجل الموزع غير متاح.' : 'The reseller record is unavailable.'
  }
  const selectedOwner = principal.kind === 'reseller' ? principal.id : ''
  const baseNote = !allowed
    ? (ar ? 'لا تملك صلاحية إنشاء الحسابات.' : 'You do not have permission to create accounts.')
    : catalogMissing
      ? (ar ? 'قائمة الخطط غير متاحة.' : 'The plan list is unavailable.')
      : catalogEmpty
        ? (ar ? 'لا توجد خطط.' : 'No plans are available.')
        : (ar ? 'يُنشأ الحساب عند إرسال النموذج.' : 'The account is created when you submit this form.')
  const planViews: PlanView[] = (plans ?? []).map(plan => ({
    id: plan.id,
    name: plan.name,
    shell: plan.shell,
    shellLabel: shellLabel(plan.shell, ar),
    limitsHtml: limitsHtml(plan, ar),
  }))
  const caps: Record<string, CapView> = {}
  if (plans) {
    for (const owner of owners) {
      if (!owner.id) continue
      const reseller = owner.id === input.activeReseller?.id ? input.activeReseller : input.resellers?.find(item => item.id === owner.id)
      if (!reseller) continue
      for (const plan of plans) caps[`${owner.id}\n${plan.id}`] = capacity(reseller, plan, plans, input.accounts, ar)
    }
  }
  const initialCap = selected && selectedOwner ? caps[`${selectedOwner}\n${selected.id}`] : undefined
  const blocked = initialCap?.blocked === true && !submitDisabled
  const noteHtml = initialCap?.note ?? prose(baseNote, ar)
  const readyChip = chip(ar ? 'لم يُنشأ بعد' : 'Not created yet', '#EEF0F3', '#344054', ar)
  const blockedChip = chip(ar ? 'محظور' : 'Blocked', '#FDECEA', '#B42318', ar)
  const model = {
    note: prose(baseNote, ar),
    blockedChip,
    readyChip,
    plans: planViews,
    caps,
    meterEmpty: prose(ar ? 'لم تُضبط كلمة المرور.' : 'Password is empty.', ar),
    meterShort: prose(ar ? 'أقصر من 8 أحرف. الطول __N__.' : '__N__ characters. At least 8.', ar),
    meterOk: prose(ar ? 'الطول __N__ وهو كافٍ للإرسال.' : '__N__ characters. Ready to submit.', ar),
  }
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const draftUser = input.draft?.username ?? ''
  const draftDomain = input.draft?.domain ?? ''
  const draftEmail = input.draft?.email ?? ''
  const soon = prose(ar ? 'قيد التفعيل' : 'Coming soon', ar)
  const previewRow = (label: string, value: string): string =>
    `<div style="min-width: 0"><dt style="font-size: 12px; font-weight: 600; color: #5D6B7E">${show(label, ar)}</dt><dd style="margin: 0; overflow-wrap: anywhere">${value}</dd></div>`
  const planCards = planViews.map(plan => `<button type="button" data-choice data-plan-choice="${escapeHtml(plan.id)}" aria-pressed="${plan.id === selected?.id ? 'true' : 'false'}" style="${choiceStyle}"><bdi dir="ltr">${escapeHtml(plan.name)}</bdi><span style="font-weight: 500; color: #5D6B7E">${show(limitText(plans?.find(item => item.id === plan.id)?.resources.diskMb ?? 'unlimited', 'mib', ar), ar)}</span></button>`).join('')
  const ownerCards = owners.map(owner => `<button type="button" data-choice data-owner-choice="${escapeHtml(owner.id)}" data-owner-name="${escapeHtml(owner.username)}" aria-pressed="${owner.id === selectedOwner ? 'true' : 'false'}" style="${choiceStyle}">${ltr(owner.username)}</button>`).join('')
  const shells: ShellAccess[] = ['none', 'jailed']
  const shellCards = shells.map(shell => `<button type="button" data-choice data-shell-choice="${shell}" data-shell-label="${escapeHtml(shellLabel(shell, ar))}" aria-pressed="${selected?.shell === shell ? 'true' : 'false'}" style="${choiceStyle}">${ar ? shellLabel(shell, true) : escapeHtml(shellLabel(shell, false))}</button>`).join('')
  const title = ar ? 'إنشاء حساب' : 'Create account'
  return `<div class="xp-board-port" data-board-port="xwhm-account-create"${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: #F5F6F8; color: #101828; font-family: ${font}">
  <style>
    .xp-board-port, .xp-board-port * { box-sizing: border-box; }
    .xp-board-port { line-height: normal; font-size: 16px; font-kerning: auto; font-feature-settings: normal; -webkit-font-smoothing: antialiased; }
    .xp-board-port a { color: #1D5BD6; } .xp-board-port a:hover { color: #1546A8; }
    .xp-board-port :focus-visible { outline: 2px solid #1D5BD6; outline-offset: 2px; }
    .xp-board-port nav[aria-label="xWHM navigation"] :focus-visible { outline-color: #6EA0FF; }
    .xp-ar-sentence, .xp-board-port select, .xp-board-port option { font-family: 'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif !important; }
    html[lang="ar"] .xp-ar-sentence, html[lang="ar"] .xp-board-port select, html[lang="ar"] .xp-board-port option, .xp-board-port[dir="rtl"] select, .xp-board-port[dir="rtl"] option { font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif !important; }
    .xp-board-port [data-choice][aria-pressed="true"] { border-color: #1D5BD6 !important; background: #F3F7FE !important; box-shadow: inset 0 0 0 1px #1D5BD6; }
    .xp-board-port [data-create-submit][data-blocked="true"], .xp-board-port [data-create-submit]:disabled { border-color: #E2E6EC !important; background: #F0F2F5 !important; color: #5D6B7E !important; cursor: not-allowed; }
    html[lang="ar"] .xp-board-port legend, .xp-board-port[dir="rtl"] legend { float: right; }
    @media (max-width: 390px) {
      .xp-board-port, .xp-board-port nav, .xp-board-port main, .xp-board-port form, .xp-board-port aside, .xp-board-port fieldset, .xp-board-port header { min-width: 0 !important; max-width: 100% !important; }
      .xp-board-port input, .xp-board-port select, .xp-board-port button { max-width: 100% !important; }
      .xp-board-port [data-create-pad], .xp-board-port header { padding-left: 16px !important; padding-right: 16px !important; }
      .xp-board-port fieldset { padding: 16px !important; }
      .xp-board-port [data-choice-grid] { grid-template-columns: minmax(0, 1fr) !important; }
      html[lang="ar"] .xp-board-port bdi[dir="ltr"], .xp-board-port[dir="rtl"] bdi[dir="ltr"] { white-space: normal !important; overflow-wrap: anywhere !important; }
    }
    ${ARABIC_TYPE_CSS}
  </style>
  ${navHtml(ar, hostnameHtml)}
  <main id="main-content" style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    ${headerHtml(ar, principal.username, show(generationLabel, ar), generationAttr, version)}
    <div data-create-pad style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px 32px 52px; display: flex; flex-direction: column; gap: 24px">
      <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0">
        <nav aria-label="Breadcrumb">
          <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #5D6B7E">
            <li style="display: flex; gap: 6px"><a href="/whm" style="color: #475467">${ar ? '<bdi dir="ltr">xWHM</bdi>' : 'xWHM'}</a><span aria-hidden="true">/</span></li>
            <li style="display: flex; gap: 6px"><a href="/whm/accounts" style="color: #475467">${ar ? 'الحسابات' : 'Accounts'}</a><span aria-hidden="true">/</span></li>
            <li aria-current="page">${title}</li>
          </ol>
        </nav>
        <h1 id="page-title" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3" class="xp-page-title">${title}</h1>
        <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6; max-width: 68ch">${prose(ar ? 'لا يُنشأ شيء قبل إرسال النموذج. يعيّن الخادم مستخدم النظام بعد ذلك.' : 'Nothing is created until you submit this form. The server assigns the system user after that.', ar)}</p>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 26px; align-items: flex-start">
        <form action="/api/accounts" method="post" data-create-account-form="true" aria-labelledby="page-title" style="flex: 1.618 1 420px; min-width: 0; margin: 0; display: flex; flex-direction: column; gap: 26px">
          <fieldset style="${fieldsetStyle}">
            <legend style="${legendStyle}">${ar ? 'الهوية' : 'Identity'}</legend>
            <div style="${fieldStyle}">
              <label for="new-acc-username" style="${labelStyle}">${ar ? 'اسم المستخدم' : 'Username'}</label>
              <input id="new-acc-username" name="username" type="text" required maxlength="16" pattern="[a-z][a-z0-9]{0,15}" autocomplete="off" autocapitalize="none" spellcheck="false" dir="ltr" value="${escapeHtml(draftUser)}" aria-describedby="new-acc-username-help" style="${inputStyle}; max-width: 320px">
              <span id="new-acc-username-help" style="${helpStyle}">${prose(ar ? 'من 1 إلى 16 حرفاً. يبدأ بحرف لاتيني صغير ثم أحرف أو أرقام. يُفحص الاسم عند إنشاء الحساب.' : '1 to 16 characters. Starts with a lowercase letter, then lowercase letters or digits. Checked when the account is created.', ar)}</span>
            </div>
            <div style="${fieldStyle}">
              <label for="new-acc-domain" style="${labelStyle}">${ar ? 'النطاق الأساسي' : 'Primary domain'}</label>
              <input id="new-acc-domain" name="primaryDomain" type="text" required autocomplete="off" autocapitalize="none" spellcheck="false" dir="ltr" value="${escapeHtml(draftDomain)}" aria-describedby="new-acc-domain-help" style="${inputStyle}">
              <span id="new-acc-domain-help" style="${helpStyle}">${prose(ar ? 'يُفحص النطاق عند إنشاء الحساب.' : 'Checked when the account is created.', ar)}</span>
            </div>
            <div style="${fieldStyle}">
              <label for="new-acc-contact" style="${labelStyle}">${ar ? 'بريد التواصل' : 'Contact email'}</label>
              <input id="new-acc-contact" name="contactEmail" type="email" autocomplete="email" inputmode="email" spellcheck="false" dir="ltr" value="${escapeHtml(draftEmail)}" style="${inputStyle}">
            </div>
            <div style="${fieldStyle}">
              <label for="new-acc-password" style="${labelStyle}">${ar ? 'كلمة المرور' : 'Password'}</label>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0">
                <input id="new-acc-password" name="password" type="password" required minlength="8" autocomplete="new-password" spellcheck="false" dir="ltr" aria-describedby="new-acc-password-help" style="${inputStyle}; flex: 1 1 220px; max-width: 360px">
                <button type="button" data-toggle-password aria-pressed="false" aria-controls="new-acc-password" aria-label="${escapeHtml(ar ? 'إظهار كلمة المرور' : 'Show password')}" style="flex: none; width: 44px; height: 44px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #344054; display: flex; align-items: center; justify-content: center; cursor: pointer">${svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>', 18, false)}</button>
                <button type="button" data-generate-password style="${buttonStyle}">${svg('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"></path>', 16, false)}${ar ? 'توليد' : 'Generate'}</button>
              </div>
              <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px">
                <span aria-hidden="true" style="display: flex; gap: 4px; flex: 0 0 160px; max-width: 100%">${[0, 1, 2, 3].map(() => '<span data-password-bar style="flex: 1 1 0; height: 6px; border-radius: 3px; background: #E2E6EC"></span>').join('')}</span>
                <span data-password-meter style="font-size: 12px; font-weight: 600; color: #5D6B7E">${model.meterEmpty}</span>
              </div>
              <span id="new-acc-password-help" style="${helpStyle}">${prose(ar ? '8 أحرف على الأقل.' : 'At least 8 characters.', ar)}</span>
            </div>
          </fieldset>
          <fieldset style="${fieldsetStyle}">
            <legend style="${legendStyle}">${ar ? 'الخطة' : 'Plan'}</legend>
            <div style="position: relative; height: 0; overflow: hidden">
              <select id="new-acc-plan" name="planId" required${plans && plans.length > 0 ? '' : ' disabled'} style="position: absolute; inset: 0; width: 1px; height: 1px">${(plans ?? []).map(plan => `<option value="${escapeHtml(plan.id)}"${plan.id === selected?.id ? ' selected' : ''}>${escapeHtml(plan.name)}</option>`).join('')}</select>
            </div>
            ${planCards ? `<div data-choice-grid style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px">${planCards}</div>` : `<p style="margin: 0; font-size: 14px; color: #344054">${prose(baseNote, ar)}</p>`}
            <div id="xp-plan-limits" style="display: flex; flex-direction: column; gap: 12px; min-width: 0">${selected ? limitsHtml(selected, ar) : ''}</div>
          </fieldset>
          <fieldset style="${fieldsetStyle}">
            <legend style="${legendStyle}">${ar ? 'المالك' : 'Owner'}</legend>
            ${ownerCards ? `<div data-choice-grid style="display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px">${ownerCards}</div>` : ''}
            ${ownersNote ? `<p style="margin: 0; font-size: 14px; color: #344054">${prose(ownersNote, ar)}</p>` : ''}
            <div id="xp-owner-cap">${initialCap?.html ?? ''}</div>
          </fieldset>
          <div style="display: flex; flex-wrap: wrap; gap: 26px">
            <fieldset style="${fieldsetStyle}; flex: 1 1 260px">
              <legend style="${legendStyle}">${show(ar ? 'عنوان «IPv4»' : 'IPv4 address', ar)}</legend>
              <label for="new-acc-ipv4" style="${labelStyle}">${show(ar ? 'تعيين «IPv4»' : 'IPv4 assignment', ar)}</label>
              <select id="new-acc-ipv4" name="ipAssignment" required aria-describedby="new-acc-ipv4-address new-acc-ipv4-status" style="${selectStyle}">
                <option value="shared">${ar ? 'المشترك الافتراضي' : 'Default shared'}</option>
                <option value="dedicated:auto" disabled>${ar ? 'مخصص تلقائي' : 'Dedicated · Automatic'}</option>
              </select>
              <div class="xp-help" style="${helpStyle}">
                <output data-account-ip-preview hidden><bdi id="new-acc-ipv4-address" dir="ltr" data-account-ip-address></bdi></output>
                <span id="new-acc-ipv4-status" data-account-ip-status role="status" aria-live="polite">${prose(ar ? 'جارٍ تحميل العناوين.' : 'Loading IP availability.', ar)}</span>
              </div>
              <button type="button" data-account-ip-refresh style="${buttonStyle}">${ar ? 'تحديث العناوين' : 'Refresh IP availability'}</button>
              <label for="new-acc-ipv6" style="${labelStyle}">${show(ar ? 'عنوان «IPv6» الاختياري' : 'IPv6 address, optional', ar)}</label>
              <input id="new-acc-ipv6" name="ipv6" type="text" autocomplete="off" spellcheck="false" dir="ltr" value="" style="${inputStyle}">
            </fieldset>
            <fieldset style="${fieldsetStyle}; flex: 1 1 260px">
              <legend style="${legendStyle}">${ar ? 'الصدفة' : 'Shell access'}</legend>
              <div data-choice-grid style="display: grid; grid-template-columns: 1fr; gap: 12px">${shellCards}</div>
              <p style="margin: 0; font-size: 12px; font-weight: 500; color: #5D6B7E">${prose(ar ? 'الاختيار يبدأ من صدفة الخطة، ويمكن تغييره قبل الإرسال.' : 'The selection starts from the plan shell and can be changed before submit.', ar)}</p>
            </fieldset>
          </div>
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px">
            <a href="/whm/accounts" style="display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; font-size: 14px; font-weight: 600">${ar ? 'إلغاء' : 'Cancel'}</a>
            <span id="submit-note" style="flex: 1 1 220px; min-width: 0; font-size: 13px; color: ${blocked ? '#B42318' : '#475467'}">${noteHtml}</span>
            <button type="submit" data-create-submit${submitDisabled ? ' disabled' : ''}${blocked ? ' data-blocked="true"' : ''} style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${title}</button>
          </div>
          <p data-account-create-status role="status" aria-live="polite" tabindex="-1" hidden></p>
        </form>
        <aside data-preview aria-labelledby="preview-title" style="flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
          <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
            <h2 id="preview-title" style="margin: 0; font-size: 16px; font-weight: 600">${ar ? 'ما سيُنشأ' : 'What will be created'}</h2>
            <span data-preview-chip>${blocked ? blockedChip : readyChip}</span>
          </div>
          <p style="margin: 0; font-size: 14px; color: #344054; line-height: 1.6">${prose(ar ? 'هذه القيم تُكتب عند الإرسال. ما لا يعرفه الخادم بعد يبقى قيد التفعيل.' : 'These values are written when you submit. Anything the server does not know yet stays pending.', ar)}</p>
          <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px">
            ${previewRow(ar ? 'المستخدم' : 'User', `<bdi dir="ltr" data-preview-user>${escapeHtml(draftUser || '—')}</bdi>`)}
            ${previewRow(ar ? 'النطاق' : 'Domain', `<bdi dir="ltr" data-preview-domain>${escapeHtml(draftDomain || '—')}</bdi>`)}
            ${previewRow(ar ? 'المالك' : 'Owner', `<bdi dir="ltr" data-preview-owner>${escapeHtml(owners.find(owner => owner.id === selectedOwner)?.username || '—')}</bdi>`)}
            ${previewRow(ar ? 'الخطة' : 'Plan', `<bdi dir="ltr" data-preview-plan>${escapeHtml(selected?.name || '—')}</bdi>`)}
            ${previewRow(ar ? 'الصدفة' : 'Shell', `<span data-preview-shell>${escapeHtml(selected ? shellLabel(selected.shell, ar) : '—')}</span>`)}
            ${previewRow(ar ? 'المعرف' : 'UID', soon)}
            ${previewRow(ar ? 'المنزل' : 'Home', soon)}
            ${previewRow(ar ? 'الشريحة' : 'Slice', soon)}
            ${previewRow(ar ? 'الويب' : 'Web', soon)}
            ${previewRow(ar ? '«DNS»' : 'DNS', soon)}
            ${previewRow(ar ? 'البريد' : 'Mail', soon)}
            ${previewRow(ar ? 'قواعد البيانات' : 'Databases', soon)}
          </dl>
        </aside>
      </div>
    </div>
  </main>
  ${clientScript(json)}
</div>`
}

const documentShell = (body: string, ar: boolean): string => `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${ar ? 'إنشاء حساب — xWHM' : 'Create account — xWHM'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
*{box-sizing:border-box}
</style>
</head>
<body>
${body}
</body>
</html>`

export const renderCreateDocument = (input: CreateAccountInput): string =>
  documentShell(renderWhmAccountCreate(input), input.locale === 'ar')

export const renderLiveDocument = (dir: 'ltr' | 'rtl' = 'ltr'): string =>
  renderCreateDocument(whmAccountCreateFromProps({
    locale: dir === 'rtl' ? 'ar' : 'en',
    principal: { kind: 'root', id: 'root', username: 'root' },
  }))
