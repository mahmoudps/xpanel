import type { Account, Plan, Reseller, ResellerAcl } from '@xpanel/core'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import { isolateLtrRuns } from '../bidi-runs.ts'
import type { Locale } from '../i18n.ts'
import { escapeHtml, formatAsciiNumber, formatBytes } from '../tokens.ts'

const PAGE_SIZE = 10
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

const sentence = (value: string, ar: boolean): string =>
  ar && isArabicSentence(value) ? `<span class="xp-ar-sentence">${escapeHtml(value)}</span>` : tech(value, ar)

const tech = (value: string, ar: boolean): string => ar ? ltr(value) : escapeHtml(value)

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

export interface AccountsBoardRow {
  id: string
  user: string
  uid: string
  domain: string
  plan: string
  owner: string
  /** Plain disk text. The artboard includes a measured ratio. The product page does not. */
  disk: string
  /** Percent label such as `11%`. Empty when use was not measured. */
  pct: string
  pctWeight: string
  diskLabel: string
  diskColor: string
  diskText: string
  /** Caption under the ratio. Empty on the artboard. `Coming soon` when use is unmeasured. */
  diskSoon: string
  io: string
  ioNote: string
  checked: boolean
  rowBg: string
  statusKey: 'active' | 'suspended' | 'terminating'
  status: string
  chipBg: string
  chipFg: string
  menuOpen: boolean
  menuPos: string
  suspendLabel: string
  suspendAction: '' | 'suspend-account' | 'unsuspend-account'
  canSuspend: boolean
  canTerminate: boolean
  hidden: boolean
  home: string
  slice: string
  ipv4: string
  extraIps: string
  shell: string
  contact: string
  search: string
}

export interface AccountsBoardModel {
  locale: Locale
  /** Artboard fixture. The product page is the other mode. */
  art: boolean
  hostname: string
  username: string
  versionLabel: string
  generationLabel: string
  generationLive: boolean
  searchLabel: string
  searchPlaceholder: string
  title: string
  ledeHtml: string
  bannerHtml: string
  createLabel: string
  listTitle: string
  searchFieldLabel: string
  searchFieldPlaceholder: string
  ownerLabel: string
  planLabel: string
  statusLabel: string
  allOwners: string
  allPlans: string
  owners: string[]
  plans: string[]
  tabs: Array<{ key: string; label: string; count: string; pressed: boolean }>
  clearLabel: string
  bulkVisible: boolean
  bulkCount: string
  bulkNames: string
  bulkSuspend: string
  bulkUnsuspend: string
  bulkPlan: string
  bulkClear: string
  soon: string
  showTable: boolean
  caption: string
  accountHeader: string
  newest: string
  domainHeader: string
  planHeader: string
  ownerHeader: string
  diskHeader: string
  ioHeader: string
  statusHeader: string
  actionsHeader: string
  rows: AccountsBoardRow[]
  emptyTitle: string
  emptyHtml: string
  showEmpty: boolean
  countText: string
  countAll: string
  countSlice: string
  countEmpty: string
  pages: Array<{ n: string; label: string; current: boolean }>
  previousLabel: string
  nextLabel: string
  hasNext: boolean
  filtersDisabled: boolean
  modifyLabel: string
  changePlanLabel: string
  changeOwnerLabel: string
  resetLabel: string
  signInLabel: string
  terminateLabel: string
  dialogTitle: string
  dialogAccount: string
  dialogDomain: string
  dialogConfirm: string
  dialogConfirmHelp: string
  dialogReason: string
  dialogCancel: string
  dialogSubmit: string
}

const linkStyle = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; color: #C9D3E1; text-decoration: none; font-size: 14px'
const activeStyle = 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset 3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'

const navHtml = (ar: boolean, host: string): string => {
  const index = ar ? 1 : 0
  const active = ar
    ? 'display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; background: #1D2B40; color: #FFFFFF; font-weight: 600; box-shadow: inset -3px 0 0 #6EA0FF; text-decoration: none; font-size: 14px'
    : activeStyle
  const groups = NAV.map(group => {
    const items = group.items.map(item => {
      const current = item.href === '/whm/accounts'
      const label = show(item.label[index] ?? '', ar)
      const labelBody = label.includes('<') ? `<span>${label}</span>` : label
      return `<li><a href="${item.href}"${current ? ' aria-current="page"' : ''} style="${current ? active : linkStyle}">${svg(item.icon)}${labelBody}</a></li>`
    }).join('')
    return `<div style="display: flex; flex-direction: column; gap: 4px">
      <span id="${group.id}" style="padding: 0 12px; font-size: 11px; font-weight: 600; color: #8A99AF; line-height: 1.6">${show(group.label[index] ?? '', ar)}</span>
      <ul aria-labelledby="${group.id}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${items}</ul>
    </div>`
  }).join('')
  return `<nav aria-label="${ar ? 'تنقل xWHM' : 'xWHM navigation'}" style="flex: 1 1 248px; max-width: 100%; background: #0E1726; color: #C9D3E1; padding: 20px 14px; display: flex; flex-direction: column; gap: 18px">
    <div style="display: flex; align-items: center; gap: 10px; padding: 0 6px">
      <span aria-hidden="true" style="flex: none; width: 36px; height: 36px; border-radius: 8px; background: #1D5BD6; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: 'IBM Plex Mono', monospace; font-size: 18px; font-weight: 500">x</span>
      <div style="display: flex; flex-direction: column; min-width: 0">
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 17px; font-weight: 500; color: #FFFFFF; line-height: 1.3">${ar ? ltr('xWHM') : 'xWHM'}</span>
        <span style="font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #8A99AF; line-height: 1.3">${host}</span>
      </div>
    </div>
    ${groups}
  </nav>`
}

const hostnameHtml = (model: AccountsBoardModel): string => {
  if (model.locale === 'ar' && isArabicSentence(model.hostname)) {
    return `<span class="xp-ar-sentence">${escapeHtml(model.hostname)}</span>`
  }
  return show(model.hostname, model.locale === 'ar')
}

const headerHtml = (model: AccountsBoardModel): string => {
  const ar = model.locale === 'ar'
  const genBg = model.generationLive ? '#E7F5EE' : '#EEF0F3'
  const genFg = model.generationLive ? '#0E7A4E' : '#344054'
  const initial = escapeHtml((model.username.slice(0, 1) || '—').toLowerCase())
  const lang = ar
    ? `<a href="?lang=en" lang="en" hreflang="en" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">English</a>`
    : `<a href="?lang=ar" lang="ar" hreflang="ar" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 10px; border-radius: 8px; font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">العربية</a>`
  return `<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 32px; background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
      <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px; display: flex; align-items: center">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="position: absolute; inset-inline-start: 12px; pointer-events: none"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
        <input type="search" aria-label="${escapeHtml(model.searchLabel)}" placeholder="${escapeHtml(model.searchPlaceholder)}" style="width: 100%; min-height: 40px; padding-inline-start: 36px; padding-inline-end: 40px; border-radius: 8px; border: 1px solid #D0D5DD; background: #F8F9FB; font-family: inherit; font-size: 14px; color: #101828">
        <kbd aria-hidden="true" style="position: absolute; inset-inline-end: 8px; min-width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #475467">/</kbd>
      </div>
      <span style="flex: 1 1 0"></span>
      <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${genBg}; color: ${genFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${genFg}"></span>${show(model.generationLabel, ar)}</span>
      <span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: 'IBM Plex Mono', monospace">${show(model.versionLabel, ar)}</span>
      ${lang}
      <button type="button" aria-label="${escapeHtml(ar ? `قائمة المستخدم ${model.username}` : `User menu for ${model.username}`)}" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding-block: 0; padding-inline: 6px 12px; border-radius: 999px; border: 1px solid #E2E6EC; background: #FFFFFF; color: #101828; font-family: 'IBM Plex Mono', monospace; font-size: 13px; font-weight: 500; cursor: pointer"><span aria-hidden="true" style="width: 32px; height: 32px; border-radius: 50%; background: #0E1726; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 13px">${initial}</span>${show(model.username, ar)}</button>
    </header>`
}

const menuItem = (label: string, extra = ''): string =>
  `<button type="button" role="menuitem"${extra} style="display: flex; align-items: center; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 6px; border: none; background: transparent; color: #101828; font-family: inherit; font-size: 14px; text-align: start; cursor: pointer">${label}</button>`

const soonItem = (label: string, soon: string): string =>
  `<button type="button" role="menuitem" disabled title="${escapeHtml(soon)}" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 6px; border: none; background: transparent; color: #101828; font-family: inherit; font-size: 14px; text-align: start; cursor: not-allowed"><span>${escapeHtml(label)}</span><span style="font-size: 12px; color: #5D6B7E">${escapeHtml(soon)}</span></button>`

const rowHtml = (model: AccountsBoardModel, row: AccountsBoardRow): string => {
  const ar = model.locale === 'ar'
  const checked = row.checked ? ' checked=""' : ''
  const selectLabel = ar ? `تحديد ${row.user}` : `Select ${row.user}`
  const menuLabel = ar ? `إجراءات ${row.user}` : `Actions for ${row.user}`
  const diskBody = (): string => {
    if (row.pct) return `${tech(row.disk, ar)} <span style="font-weight: ${row.pctWeight}">· ${tech(row.pct, ar)}</span>`
    const parts = row.disk.split(' / ')
    const limit = parts[1]
    if (ar && parts.length === 2 && limit && isArabicSentence(limit)) return `${ltr(parts[0] ?? '')} / ${sentence(limit, true)}`
    return sentence(row.disk, ar)
  }
  const meter = row.pct
    ? `<div role="meter" aria-label="${escapeHtml(row.diskLabel)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(row.pct.replace('%', ''))}" style="width: 120px; height: 6px; border-radius: 3px; background: #E9ECF1; overflow: hidden"><div style="height: 6px; width: ${escapeHtml(row.pct)}; background: ${row.diskColor}; border-radius: 3px"></div></div>`
    : `<div role="meter" aria-label="${escapeHtml(row.diskLabel)}" aria-disabled="true" aria-valuetext="${escapeHtml(row.diskSoon || row.disk)}" style="width: 120px; height: 6px; border-radius: 3px; background: #E9ECF1; overflow: hidden"></div>`
  const soon = row.diskSoon ? `<span${ar && isArabicSentence(row.diskSoon) ? ' class="xp-ar-sentence"' : ''} style="font-size: 12px; color: #5D6B7E">${sentence(row.diskSoon, ar)}</span>` : ''
  const userStyle = "font-weight: 600; font-family: 'IBM Plex Mono', monospace"
  const uidStyle = "font-size: 12px; color: #5D6B7E; font-family: 'IBM Plex Mono', monospace"
  const attrs = model.art ? '' : ` data-account-id="${escapeHtml(row.id)}" data-username="${escapeHtml(row.user)}" data-domain="${escapeHtml(row.domain)}"`
  const suspend = row.canSuspend && row.suspendAction
    ? menuItem(show(row.suspendLabel, ar), `${attrs} data-action="${row.suspendAction}"`)
    : ''
  const terminate = row.canTerminate
    ? `<button type="button" role="menuitem"${attrs} data-action="terminate-account" style="display: flex; align-items: center; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 6px; border: none; background: transparent; color: #B42318; font-family: inherit; font-size: 14px; font-weight: 600; text-align: start; cursor: pointer">${show(model.terminateLabel, ar)}</button>`
    : ''
  const artMenu = `<div role="menu" aria-label="${escapeHtml(menuLabel)}" style="position: absolute; ${row.menuPos}; inset-inline-end: 16px; z-index: 5; width: 224px; padding: 6px; border-radius: 10px; background: #FFFFFF; border: 1px solid #D0D5DD; box-shadow: 0 8px 24px #1018281F; display: flex; flex-direction: column; text-align: start">
    ${menuItem('Modify')}${menuItem('Change plan')}${menuItem('Change owner')}${menuItem('Reset password')}
    <a href="/home" role="menuitem" style="display: flex; align-items: center; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 6px; color: #101828; font-size: 14px; text-decoration: none">Sign in as owner</a>
    ${menuItem(row.suspendLabel)}
    <div role="separator" style="height: 1px; margin: 6px 4px; background: #EEF0F3"></div>
    <button type="button" role="menuitem" style="display: flex; align-items: center; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 6px; border: none; background: transparent; color: #B42318; font-family: inherit; font-size: 14px; font-weight: 600; text-align: start; cursor: pointer">Terminate…</button>
  </div>`
  const productMenu = `<div data-account-menu-panel role="menu" aria-label="${escapeHtml(menuLabel)}"${row.menuOpen ? '' : ' hidden'} style="position: absolute; ${row.menuPos}; inset-inline-end: 16px; z-index: 5; width: 224px; padding: 6px; border-radius: 10px; background: #FFFFFF; border: 1px solid #D0D5DD; box-shadow: 0 8px 24px #1018281F; display: ${row.menuOpen ? 'flex' : 'none'}; flex-direction: column; text-align: start">
    <div data-account-details>
      <bdi dir="ltr">${escapeHtml(row.home)}</bdi>
      <bdi dir="ltr">${escapeHtml(row.slice)}</bdi>
      <bdi dir="ltr">${escapeHtml(row.ipv4)}</bdi>
      <bdi dir="ltr">${escapeHtml(row.extraIps)}</bdi>
      <bdi dir="ltr">${escapeHtml(row.shell)}</bdi>
      <bdi dir="ltr">${escapeHtml(row.contact)}</bdi>
    </div>
    ${soonItem(model.modifyLabel, model.soon)}
    ${soonItem(model.changePlanLabel, model.soon)}
    ${soonItem(model.changeOwnerLabel, model.soon)}
    ${soonItem(model.resetLabel, model.soon)}
    ${soonItem(model.signInLabel, model.soon)}
    ${suspend}
    ${terminate ? `<div role="separator" style="height: 1px; margin: 6px 4px; background: #EEF0F3"></div>${terminate}` : ''}
  </div>`
  const menu = model.art ? (row.menuOpen ? artMenu : '') : productMenu
  const menuBorder = row.menuOpen ? '#C7D7F8' : '#D0D5DD'
  const menuBg = row.menuOpen ? '#E8EFFD' : '#FFFFFF'
  return `<tr data-account-row="${escapeHtml(row.user)}" data-owner="${escapeHtml(row.owner)}" data-plan="${escapeHtml(row.plan)}" data-account-state="${row.statusKey}" data-search="${escapeHtml(row.search)}"${row.hidden ? ' hidden' : ''} style="border-top: 1px solid #EEF0F3; background: ${row.rowBg}">
    <td style="padding: 10px 16px"><input type="checkbox"${checked} aria-label="${escapeHtml(selectLabel)}" style="width: 18px; height: 18px; accent-color: #1D5BD6"></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column"><span data-account-user style="${userStyle}">${tech(row.user, ar)}</span><span style="${uidStyle}">${tech(`uid ${row.uid}`, ar)}</span></div></td>
    <td data-account-domain style="padding: 10px 16px; font-family: 'IBM Plex Mono', monospace; font-size: 13px">${tech(row.domain, ar)}</td>
    <td style="padding: 10px 16px">${sentence(row.plan, ar)}</td>
    <td style="padding: 10px 16px; color: #475467; font-family: 'IBM Plex Mono', monospace; font-size: 13px">${sentence(row.owner, ar)}</td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column; gap: 4px; min-width: 132px"><span style="font-size: 13px; font-variant-numeric: tabular-nums; color: ${row.diskText}">${diskBody()}</span>${soon}${meter}</div></td>
    <td style="padding: 10px 16px; line-height: 1.4"><div style="display: flex; flex-direction: column"><span style="font-family: 'IBM Plex Mono', monospace; font-size: 13px">${sentence(row.io, ar)}</span>${row.ioNote ? `<span style="font-size: 12px; color: #5D6B7E">${sentence(row.ioNote, ar)}</span>` : ''}</div></td>
    <td style="padding: 10px 16px"><span data-account-status class="xp-badge" style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${row.chipBg}; color: ${row.chipFg}; font-size: 12px; font-weight: 600; white-space: nowrap"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${row.chipFg}"></span><span class="xp-badge__label${ar && isArabicSentence(row.status) ? ' xp-ar-sentence' : ''}">${escapeHtml(row.status)}</span></span></td>
    <td style="position: relative; padding: 6px 16px; text-align: end">
      <button type="button" data-account-menu aria-label="${escapeHtml(menuLabel)}" aria-haspopup="menu" aria-expanded="${row.menuOpen ? 'true' : 'false'}" style="width: 40px; height: 40px; border-radius: 8px; border: 1px solid ${menuBorder}; background: ${menuBg}; color: #344054; display: inline-flex; align-items: center; justify-content: center; cursor: pointer"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg></button>
      ${menu}
    </td>
  </tr>`
}

const dialogHtml = (model: AccountsBoardModel): string => {
  if (model.art) return ''
  const ar = model.locale === 'ar'
  return `<dialog class="xp-account-dialog" data-account-dialog aria-labelledby="xp-account-dialog-title" aria-describedby="xp-account-dialog-description">
    <form method="dialog" data-account-action-form novalidate>
      <div class="xp-account-dialog__header">
        <h2 id="xp-account-dialog-title" data-account-dialog-title>${escapeHtml(model.dialogTitle)}</h2>
        <p id="xp-account-dialog-description" data-account-dialog-description></p>
      </div>
      <dl class="xp-account-dialog__identity">
        <div class="xp-accounts__field"><dt>${escapeHtml(model.dialogAccount)}</dt><dd><bdi dir="ltr" data-account-dialog-username></bdi></dd></div>
        <div class="xp-accounts__field"><dt>${escapeHtml(model.dialogDomain)}</dt><dd><bdi dir="ltr" data-account-dialog-domain></bdi></dd></div>
      </dl>
      <div class="xp-accounts__field" data-account-confirm-field hidden>
        <label class="xp-label" for="terminate-confirm-user">${escapeHtml(model.dialogConfirm)}</label>
        <input id="terminate-confirm-user" name="confirmUsername" type="text" class="xp-input xp-mono" dir="ltr" autocomplete="off" spellcheck="false" data-type-to-confirm="true" aria-describedby="xp-account-confirm-help" />
        <span class="xp-help" id="xp-account-confirm-help">${escapeHtml(model.dialogConfirmHelp)}</span>
      </div>
      <div class="xp-accounts__field" data-account-reason-field hidden>
        <label class="xp-label" for="account-suspend-reason">${escapeHtml(model.dialogReason)}</label>
        <textarea id="account-suspend-reason" name="reason" class="xp-textarea" rows="2" maxlength="500"></textarea>
      </div>
      <p class="xp-account-dialog__status" data-account-action-status role="status" aria-live="polite" tabindex="-1" hidden></p>
      <div class="xp-account-dialog__footer">
        <button type="button" class="xp-btn" data-account-action-cancel>${escapeHtml(model.dialogCancel)}</button>
        <button type="submit" class="xp-btn xp-btn--primary" data-account-action-submit disabled>${escapeHtml(model.dialogSubmit)}</button>
      </div>
    </form>
  </dialog>${ar ? '' : ''}`
}

const PRODUCT_SCRIPT = `<script>
(function () {
  var root = document.querySelector('[data-board-port="xwhm-accounts"][data-product="true"]');
  if (!root) return;
  var search = root.querySelector('#acc-search');
  var owner = root.querySelector('#acc-owner');
  var plan = root.querySelector('#acc-plan');
  var count = root.querySelector('[data-account-count]');
  var pageSize = 10;
  var page = 1;
  function rows() { return Array.prototype.slice.call(root.querySelectorAll('[data-account-row]')); }
  function status() {
    var on = root.querySelector('[data-status-tab][aria-pressed="true"]');
    return on ? on.getAttribute('data-status-tab') : 'all';
  }
  function matched() {
    var q = (search && search.value || '').trim().toLowerCase();
    var own = owner ? owner.value : '';
    var pl = plan ? plan.value : '';
    var st = status();
    return rows().filter(function (row) {
      if (q && (row.getAttribute('data-search') || '').toLowerCase().indexOf(q) === -1) return false;
      if (own && row.getAttribute('data-owner') !== own) return false;
      if (pl && row.getAttribute('data-plan') !== pl) return false;
      if (st !== 'all' && row.getAttribute('data-account-state') !== st) return false;
      return true;
    });
  }
  function paint() {
    var list = matched();
    var pages = Math.max(1, Math.ceil(list.length / pageSize) || 1);
    if (page > pages) page = pages;
    var start = (page - 1) * pageSize;
    var all = rows();
    for (var i = 0; i < all.length; i++) all[i].hidden = true;
    var shown = list.slice(start, start + pageSize);
    for (var j = 0; j < shown.length; j++) shown[j].hidden = false;
    if (count) {
      var text = list.length === 0
        ? count.getAttribute('data-empty')
        : list.length <= pageSize
          ? String(count.getAttribute('data-all') || '').replace('__N__', String(list.length))
          : String(count.getAttribute('data-slice') || '').replace('__A__', String(start + 1)).replace('__B__', String(start + shown.length)).replace('__N__', String(list.length));
      var safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      count.innerHTML = root.getAttribute('dir') === 'rtl'
        ? safe.replace(/(\\d+(?:[.,]\\d+)*)/g, '<bdi dir="ltr">$1</bdi>')
        : safe;
    }
    var buttons = root.querySelectorAll('[data-page]');
    for (var n = 0; n < buttons.length; n++) {
      var num = Number(buttons[n].getAttribute('data-page'));
      buttons[n].hidden = num > pages;
      var current = num === page;
      buttons[n].setAttribute('aria-current', current ? 'page' : 'false');
      buttons[n].style.background = current ? '#1D5BD6' : '#FFFFFF';
      buttons[n].style.color = current ? '#FFFFFF' : '#101828';
      buttons[n].style.borderColor = current ? '#1D5BD6' : '#D0D5DD';
    }
    var prev = root.querySelector('[data-page-prev]');
    var next = root.querySelector('[data-page-next]');
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= pages;
    var table = root.querySelector('[data-account-scroll]');
    var empty = root.querySelector('[data-account-empty]');
    if (table) table.hidden = list.length === 0;
    if (empty) empty.style.display = list.length === 0 ? 'flex' : 'none';
  }
  root.addEventListener('click', function (event) {
    var node = event.target && event.target.closest ? event.target : null;
    if (!node || !node.closest) return;
    var menu = node.closest('[data-account-menu]');
    if (menu && root.contains(menu)) {
      var row = menu.closest('[data-account-row]');
      var panel = row && row.querySelector('[data-account-menu-panel]');
      if (!panel) return;
      var open = panel.hasAttribute('hidden');
      var panels = root.querySelectorAll('[data-account-menu-panel]');
      for (var i = 0; i < panels.length; i++) { panels[i].setAttribute('hidden', ''); panels[i].style.display = 'none'; }
      var toggles = root.querySelectorAll('[data-account-menu]');
      for (var k = 0; k < toggles.length; k++) toggles[k].setAttribute('aria-expanded', 'false');
      if (open) { panel.style.display = 'flex'; panel.removeAttribute('hidden'); menu.setAttribute('aria-expanded', 'true'); }
      else panel.style.display = 'none';
      return;
    }
    var tab = node.closest('[data-status-tab]');
    if (tab && root.contains(tab)) {
      var tabs = root.querySelectorAll('[data-status-tab]');
      for (var t = 0; t < tabs.length; t++) {
        var on = tabs[t] === tab;
        tabs[t].setAttribute('aria-pressed', on ? 'true' : 'false');
        tabs[t].style.background = on ? '#FFFFFF' : 'transparent';
        tabs[t].style.borderColor = on ? '#D0D5DD' : 'transparent';
        tabs[t].style.color = on ? '#101828' : '#344054';
        tabs[t].style.fontWeight = on ? '600' : '500';
      }
      page = 1; paint(); return;
    }
    if (node.closest('[data-page-prev]')) { if (page > 1) page -= 1; paint(); return; }
    if (node.closest('[data-page-next]')) { page += 1; paint(); return; }
    var pageBtn = node.closest('[data-page]');
    if (pageBtn) { page = Number(pageBtn.getAttribute('data-page')) || 1; paint(); return; }
    if (node.closest('[data-clear-filters]')) {
      if (search) search.value = '';
      if (owner) owner.value = '';
      if (plan) plan.value = '';
      var all = root.querySelector('[data-status-tab="all"]');
      if (all && all.getAttribute('aria-pressed') !== 'true') all.click();
      else { page = 1; paint(); }
    }
  });
  if (search) search.addEventListener('input', function () { page = 1; paint(); });
  if (owner) owner.addEventListener('change', function () { page = 1; paint(); });
  if (plan) plan.addEventListener('change', function () { page = 1; paint(); });
})();
</script>`

export const renderWhmAccounts = (model: AccountsBoardModel): string => {
  const ar = model.locale === 'ar'
  const disabled = model.filtersDisabled ? ' disabled' : ''
  const tabs = model.tabs.map(tab => {
    const border = tab.pressed ? '#D0D5DD' : 'transparent'
    const bg = tab.pressed ? '#FFFFFF' : 'transparent'
    const fg = tab.pressed ? '#101828' : '#344054'
    const weight = tab.pressed ? '600' : '500'
    return `<button type="button" data-status-tab="${escapeHtml(tab.key)}" aria-pressed="${tab.pressed ? 'true' : 'false'}"${disabled} style="min-height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid ${border}; background: ${bg}; color: ${fg}; font-family: inherit; font-size: 14px; font-weight: ${weight}; white-space: nowrap; cursor: pointer">${show(tab.label, ar)} <span style="font-variant-numeric: tabular-nums; color: #475467">${tech(tab.count, ar)}</span></button>`
  }).join('')
  const owners = [`<option value="" selected="">${escapeHtml(model.allOwners)}</option>`]
    .concat(model.owners.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)).join('')
  const plans = [`<option value="" selected="">${escapeHtml(model.allPlans)}</option>`]
    .concat(model.plans.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)).join('')
  const bulkDisabled = model.art ? '' : ' disabled'
  const bulkTitle = model.art ? '' : ` title="${escapeHtml(model.soon)}"`
  const bulk = model.bulkVisible ? `<div data-bulk role="region" aria-label="${ar ? 'إجراءات جماعية' : 'Bulk actions'}" style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 16px; background: #F3F7FE; border-top: 1px solid #C7D7F8; border-bottom: 1px solid #C7D7F8">
    <span style="font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums">${tech(model.bulkCount, ar)} ${show(ar ? 'محدد' : 'selected', ar)}</span>
    <span style="font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: #475467; min-width: 0; overflow-wrap: anywhere">${tech(model.bulkNames, ar)}</span>
    <span style="flex: 1 1 0"></span>
    <button type="button"${bulkDisabled}${bulkTitle} style="min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.bulkSuspend, ar)}</button>
    <button type="button"${bulkDisabled}${bulkTitle} style="min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.bulkUnsuspend, ar)}</button>
    <button type="button"${model.art ? '' : ` disabled title="${escapeHtml(model.soon)}"`} style="min-height: 44px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.bulkPlan, ar)}</button>
    <button type="button" data-clear-selection style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${show(model.bulkClear, ar)}</button>
  </div>` : ''
  const pages = model.pages.map(page => {
    const bg = page.current ? '#1D5BD6' : '#FFFFFF'
    const fg = page.current ? '#FFFFFF' : '#101828'
    const border = page.current ? '#1D5BD6' : '#D0D5DD'
    return `<li><button type="button" data-page="${escapeHtml(page.n)}" aria-current="${page.current ? 'page' : 'false'}" aria-label="${escapeHtml(page.label)}" style="min-width: 44px; min-height: 44px; padding: 0 8px; border-radius: 8px; border: 1px solid ${border}; background: ${bg}; color: ${fg}; font-family: inherit; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; cursor: pointer">${tech(page.n, ar)}</button></li>`
  }).join('')
  const prevStyle = 'min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #E2E6EC; background: #F0F2F5; color: #5D6B7E; font-family: inherit; font-size: 14px; font-weight: 600'
  const nextStyle = model.hasNext
    ? 'min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer'
    : prevStyle
  const crumb = ar
    ? `<li><a href="/whm" style="color: #475467">${ltr('xWHM')}</a></li><li aria-hidden="true">/</li><li aria-current="page">${show(model.title, true)}</li>`
    : `<li style="display: flex; gap: 6px"><a href="/whm" style="color: #475467">xWHM</a><span aria-hidden="true">/</span></li><li aria-current="page">${escapeHtml(model.title)}</li>`
  const host = hostnameHtml(model)
  const boardFace = ar
    ? "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"
    : "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
  return `<div class="xp-board-port" data-board-port="xwhm-accounts" data-section="accounts-isolation" data-accounts-workspace id="whm-accounts"${model.art ? '' : ' data-product="true"'}${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: #F5F6F8; font-family: ${boardFace}; color: #101828">
  <style>
    .xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
    .xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
    .xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
    .xp-board-port nav[aria-label="xWHM navigation"] :focus-visible{outline-color:#6EA0FF}
    .xp-ar-sentence{font-family:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif !important}
    [data-account-details]{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    ${ARABIC_TYPE_CSS}
    @media (max-width: 390px) {
      [data-board-port="xwhm-accounts"],
      [data-board-port="xwhm-accounts"] > nav,
      [data-board-port="xwhm-accounts"] > main,
      [data-board-port="xwhm-accounts"] > main > header,
      [data-board-port="xwhm-accounts"] > main > div,
      [data-board-port="xwhm-accounts"] section,
      [data-board-port="xwhm-accounts"] [data-account-scroll] {
        min-width: 0;
        max-width: 100%;
      }
      [data-board-port="xwhm-accounts"] [data-account-user],
      [data-board-port="xwhm-accounts"] [data-account-domain],
      [data-board-port="xwhm-accounts"] [data-account-scroll] bdi[dir="ltr"] {
        white-space: normal !important;
        overflow-wrap: anywhere !important;
        max-width: 100%;
      }
    }
  </style>
  ${navHtml(ar, host)}
  <main id="main-content" style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    ${headerHtml(model)}
    <div style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px 32px 52px; display: flex; flex-direction: column; gap: 24px">
      <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px">
        <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1 1 420px">
          <nav aria-label="${ar ? 'مسار التنقل' : 'Breadcrumb'}">
            <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #5D6B7E">${crumb}</ol>
          </nav>
          <h1 id="whm-accounts-heading" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${show(model.title, ar)}</h1>
          <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6; max-width: 68ch">${model.ledeHtml}</p>
        </div>
        <a href="/whm/accounts/new" style="display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${svg('<path d="M12 5v14M5 12h14"></path>', 18, false)}${show(model.createLabel, ar)}</a>
      </div>
      <div style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #C7D7F8; background: #F3F7FE; font-size: 13px; line-height: 1.6"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D5BD6" stroke-width="2" stroke-linecap="round" style="flex: none; margin-top: 2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v4h1"></path></svg><span>${model.bannerHtml}</span></div>
      <section aria-labelledby="list-title" style="display: flex; flex-direction: column; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
        <h2 id="list-title" style="position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap">${escapeHtml(model.listTitle)}</h2>
        <div style="display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; padding: 16px">
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 1 1 240px; min-width: 0; max-width: 360px">
            <label for="acc-search" style="font-size: 13px; font-weight: 600">${escapeHtml(model.searchFieldLabel)}</label>
            <input id="acc-search" type="search" placeholder="${escapeHtml(model.searchFieldPlaceholder)}"${disabled} style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828">
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 0 1 160px; min-width: 0">
            <label for="acc-owner" style="font-size: 13px; font-weight: 600">${escapeHtml(model.ownerLabel)}</label>
            <select id="acc-owner"${disabled} style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828">${owners}</select>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; flex: 0 1 160px; min-width: 0">
            <label for="acc-plan" style="font-size: 13px; font-weight: 600">${escapeHtml(model.planLabel)}</label>
            <select id="acc-plan"${disabled} style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: inherit; font-size: 14px; color: #101828">${plans}</select>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0">
            <span id="acc-status-label" style="font-size: 13px; font-weight: 600">${escapeHtml(model.statusLabel)}</span>
            <div role="group" aria-labelledby="acc-status-label" style="display: flex; gap: 4px; padding: 3px; border-radius: 10px; background: #EEF0F3">${tabs}</div>
          </div>
          <span style="flex: 1 1 0"></span>
          <button type="button" data-clear-filters${disabled} style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${escapeHtml(model.clearLabel)}</button>
        </div>
        ${bulk}
        <div data-account-scroll class="xp-table-wrap" style="position: relative; overflow-x: auto; border-top: 1px solid #E2E6EC; min-width: 0; max-width: 100%; border-inline: 0; border-bottom: 0; border-radius: 0; background: transparent"${model.showTable ? '' : ' hidden'}>
          <table aria-busy="false" style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: 1040px">
            <caption style="position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap">${escapeHtml(model.caption)}</caption>
            <thead>
              <tr style="background: #F8F9FB">
                <th scope="col" style="text-align: start; padding: 12px 16px; width: 48px"><input type="checkbox" aria-label="${escapeHtml(ar ? 'تحديد كل الحسابات في هذه الصفحة' : 'Select all accounts on this page')}" style="width: 18px; height: 18px; accent-color: #1D5BD6"></th>
                <th scope="col" aria-sort="descending" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.accountHeader)} <span style="font-weight: 500; color: #5D6B7E">· ${escapeHtml(model.newest)}</span></th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.domainHeader)}</th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.planHeader)}</th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.ownerHeader)}</th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.diskHeader)}</th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.ioHeader)}</th>
                <th scope="col" style="text-align: start; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.statusHeader)}</th>
                <th scope="col" style="padding: 12px 16px; width: 72px"><span style="position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap">${escapeHtml(model.actionsHeader)}</span></th>
              </tr>
            </thead>
            <tbody>${model.rows.map(row => rowHtml(model, row)).join('')}</tbody>
          </table>
        </div>
        <div data-account-empty style="display: ${model.showEmpty ? 'flex' : 'none'}; flex-direction: column; align-items: center; justify-content: center; gap: 10px; margin: 16px; padding: 40px 24px; border-radius: 12px; border: 1px dashed #C9CFD8; text-align: center">
          ${svg('<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"></path><path d="M16 11l5 5M21 11l-5 5"></path>', 40, false).replace('stroke-width="2"', 'stroke-width="1.6" stroke="#5D6B7E"')}
          <h3 style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.emptyTitle)}</h3>
          <p style="margin: 0; font-size: 13px; color: #5D6B7E; max-width: 380px; line-height: 1.6">${model.emptyHtml}</p>
          <button type="button" data-clear-filters style="min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${escapeHtml(model.clearLabel)}</button>
        </div>
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid #E2E6EC">
          <span data-account-count data-empty="${escapeHtml(model.countEmpty)}" data-all="${escapeHtml(model.countAll)}" data-slice="${escapeHtml(model.countSlice)}" aria-live="polite" style="font-size: 13px; color: #475467; font-variant-numeric: tabular-nums">${show(model.countText, ar)}</span>
          <nav aria-label="${ar ? 'ترقيم الصفحات' : 'Pagination'}" data-account-pages>
            <ul style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px">
              <li><button type="button" data-page-prev disabled style="${prevStyle}">${escapeHtml(model.previousLabel)}</button></li>
              ${pages}
              <li><button type="button" data-page-next${model.hasNext ? '' : ' disabled'} style="${nextStyle}">${escapeHtml(model.nextLabel)}</button></li>
            </ul>
          </nav>
        </div>
      </section>
    </div>
  </main>
  ${dialogHtml(model)}
  ${model.art ? '' : PRODUCT_SCRIPT}
</div>`
}

const copy = (ar: boolean) => ({
  searchLabel: ar ? 'بحث في الأدوات والحسابات' : 'Search tools and accounts',
  searchPlaceholder: ar ? 'بحث في الأدوات والحسابات' : 'Search tools and accounts',
  title: ar ? 'الحسابات' : 'Accounts',
  createLabel: ar ? 'إنشاء حساب' : 'Create account',
  listTitle: ar ? 'قائمة الحسابات' : 'Account list',
  searchFieldLabel: ar ? 'بحث' : 'Search',
  searchFieldPlaceholder: ar ? 'اسم المستخدم أو النطاق أو المعرف' : 'Username, domain or uid',
  ownerLabel: ar ? 'المالك' : 'Owner',
  planLabel: ar ? 'الخطة' : 'Plan',
  statusLabel: ar ? 'الحالة' : 'Status',
  allOwners: ar ? 'كل المالكين' : 'All owners',
  allPlans: ar ? 'كل الخطط' : 'All plans',
  clearLabel: ar ? 'مسح التصفية' : 'Clear filters',
  soon: ar ? 'قيد التفعيل' : 'Coming soon',
  accountHeader: ar ? 'الحساب' : 'Account',
  newest: ar ? 'الأحدث أولاً' : 'newest first',
  domainHeader: ar ? 'النطاق الأساسي' : 'Primary domain',
  planHeader: ar ? 'الخطة' : 'Plan',
  ownerHeader: ar ? 'المالك' : 'Owner',
  diskHeader: ar ? 'القرص' : 'Disk',
  ioHeader: ar ? 'سقف الكتابة' : 'IO write cap',
  statusHeader: ar ? 'الحالة' : 'Status',
  actionsHeader: ar ? 'الإجراءات' : 'Actions',
  previousLabel: ar ? 'السابق' : 'Previous',
  nextLabel: ar ? 'التالي' : 'Next',
  modifyLabel: ar ? 'تعديل' : 'Modify',
  changePlanLabel: ar ? 'تغيير الخطة' : 'Change plan',
  changeOwnerLabel: ar ? 'تغيير المالك' : 'Change owner',
  resetLabel: ar ? 'إعادة تعيين كلمة المرور' : 'Reset password',
  signInLabel: ar ? 'الدخول كمالك' : 'Sign in as owner',
  terminateLabel: ar ? 'إنهاء…' : 'Terminate…',
  bulkSuspend: ar ? 'تعليق' : 'Suspend',
  bulkUnsuspend: ar ? 'إلغاء التعليق' : 'Unsuspend',
  bulkPlan: ar ? 'تغيير الخطة' : 'Change plan',
  bulkClear: ar ? 'مسح التحديد' : 'Clear selection',
  dialogTitle: ar ? 'إجراء الحساب' : 'Account action',
  dialogAccount: ar ? 'الحساب' : 'Account',
  dialogDomain: ar ? 'النطاق الأساسي' : 'Primary domain',
  dialogConfirm: ar ? 'اكتب اسم المستخدم للتأكيد' : 'Type the username to confirm',
  dialogConfirmHelp: ar ? 'يجب أن يطابق اسم الحساب أعلاه تمامًا.' : 'Must exactly match the account above.',
  dialogReason: ar ? 'سبب التعليق' : 'Suspension reason',
  dialogCancel: ar ? 'إلغاء' : 'Cancel',
  dialogSubmit: ar ? 'تأكيد' : 'Confirm',
})

const statusChip = (status: Account['status'], ar: boolean): Pick<AccountsBoardRow, 'statusKey' | 'status' | 'chipBg' | 'chipFg' | 'suspendLabel' | 'suspendAction'> => {
  if (status === 'suspended') return { statusKey: 'suspended', status: ar ? 'موقوف' : 'Suspended', chipBg: '#FEF0E6', chipFg: '#B54708', suspendLabel: ar ? 'إلغاء التعليق' : 'Unsuspend', suspendAction: 'unsuspend-account' }
  if (status === 'terminating') return { statusKey: 'terminating', status: ar ? 'قيد الإنهاء' : 'Terminating', chipBg: '#E8EFFD', chipFg: '#1D5BD6', suspendLabel: '', suspendAction: '' }
  return { statusKey: 'active', status: ar ? 'نشط' : 'Active', chipBg: '#E7F5EE', chipFg: '#0E7A4E', suspendLabel: ar ? 'تعليق' : 'Suspend', suspendAction: 'suspend-account' }
}

const limitText = (value: number | 'unlimited' | undefined, ar: boolean, unit: 'mib' | 'bps'): string => {
  if (value === undefined) return ar ? 'غير متاحة' : 'Unavailable'
  if (value === 'unlimited') return ar ? 'غير محدود' : 'Unlimited'
  if (unit === 'mib') return `${formatAsciiNumber(value)} MiB`
  return `${formatBytes(value)}/s`
}

const countLine = (total: number, ar: boolean): { text: string; all: string; slice: string; empty: string; pages: number } => {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1)
  const end = Math.min(PAGE_SIZE, total)
  const empty = ar ? 'لا حسابات تطابق' : 'No accounts match'
  const all = total === 1
    ? (ar ? 'عرض حساب واحد' : 'Showing 1 of 1 account')
    : (ar ? 'عرض __N__ من __N__ حسابًا' : 'Showing __N__ of __N__ accounts')
  const slice = ar ? 'عرض __A__–__B__ من __N__ حسابًا' : 'Showing __A__–__B__ of __N__ accounts'
  const text = total === 0
    ? empty
    : total <= PAGE_SIZE
      ? all.replaceAll('__N__', String(total))
      : slice.replace('__A__', '1').replace('__B__', String(end)).replace('__N__', String(total))
  return { text, all, slice, empty, pages }
}

export interface AccountsListInput {
  locale?: Locale
  principal?: { kind: string; username: string }
  isRoot?: boolean
  acls?: readonly ResellerAcl[]
  hostname?: string
  version?: string
  generationId?: number
  accounts?: readonly Account[]
  plans?: readonly Plan[]
  resellers?: readonly Reseller[]
}

export const whmAccountsFromProps = (props: AccountsListInput): AccountsBoardModel => {
  const ar = props.locale === 'ar'
  const labels = copy(ar)
  const accounts = props.accounts
  const ready = accounts !== undefined
  const plans = props.plans ?? []
  const resellers = props.resellers ?? []
  const isRoot = props.isRoot === true || props.principal?.kind === 'root'
  const acls = new Set(props.acls ?? [])
  const canSuspend = isRoot || acls.has('suspend-account')
  const canTerminate = isRoot || acls.has('terminate-account')
  const hostname = props.hostname && props.hostname.trim() ? props.hostname.trim() : (ar ? 'الخادم' : '—')
  const username = props.principal?.username?.trim() || '—'
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const sorted = ready ? [...accounts].sort((a, b) => {
    const at = Date.parse(a.createdAt)
    const bt = Date.parse(b.createdAt)
    const aOk = !Number.isNaN(at)
    const bOk = !Number.isNaN(bt)
    if (aOk && bOk && at !== bt) return bt - at
    if (aOk !== bOk) return aOk ? -1 : 1
    return a.username < b.username ? -1 : a.username > b.username ? 1 : 0
  }) : []
  const ownerOf = (account: Account): string => {
    if (account.ownerId === null) return 'root'
    return resellers.find(reseller => reseller.id === account.ownerId)?.username ?? (ar ? 'غير متاح' : 'Unavailable')
  }
  const rows: AccountsBoardRow[] = sorted.map((account, index) => {
    const plan = plans.find(item => item.id === account.planId)
    const chip = statusChip(account.status, ar)
    const diskLimit = plan ? limitText(plan.resources.diskMb, ar, 'mib') : (ar ? 'غير متاحة' : 'Unavailable')
    const io = plan ? limitText(plan.resources.ioWriteBps, ar, 'bps') : (ar ? 'غير متاحة' : 'Unavailable')
    const visible = index < PAGE_SIZE
    return {
      id: account.id,
      user: account.username,
      uid: String(account.uid),
      domain: account.primaryDomain,
      plan: plan?.name ?? (ar ? 'غير متاحة' : 'Unavailable'),
      owner: ownerOf(account),
      disk: plan ? `— / ${diskLimit}` : diskLimit,
      pct: '',
      pctWeight: '400',
      diskLabel: ar ? `مساحة ${account.username} غير مقاسة` : `Disk used by ${account.username} is not measured`,
      diskColor: '#1D5BD6',
      diskText: '#344054',
      diskSoon: ar ? 'قيد التفعيل' : 'Coming soon',
      io,
      ioNote: plan ? (ar ? 'من الخطة' : 'From plan') : '',
      checked: false,
      rowBg: '#FFFFFF',
      ...chip,
      canSuspend: canSuspend && account.status !== 'terminating',
      canTerminate: canTerminate && account.status !== 'terminating',
      menuOpen: false,
      menuPos: 'top: 100%',
      hidden: !visible,
      home: account.home,
      slice: `xpanel-${account.uid}.slice`,
      ipv4: account.ipv4,
      extraIps: account.extraIps?.join(', ') ?? '',
      shell: account.shell,
      contact: account.contactEmail,
      search: `${account.username} ${account.primaryDomain} ${account.uid}`,
    }
  })
  const total = rows.length
  const active = rows.filter(row => row.statusKey === 'active').length
  const suspended = rows.filter(row => row.statusKey === 'suspended').length
  const counts = countLine(ready ? total : 0, ar)
  const pageCount = ready ? counts.pages : 1
  const hostHtml = isArabicSentence(hostname) ? `<span class="xp-ar-sentence">${escapeHtml(hostname)}</span>` : ltr(hostname)
  const ledeHost = isArabicSentence(hostname)
    ? hostHtml
    : `<span style="font-family: 'IBM Plex Mono', monospace">${ar ? hostHtml : escapeHtml(hostname)}</span>`
  const ledeHtml = !ready
    ? (ar ? 'قائمة الحسابات غير متاحة.' : 'The account list is unavailable.')
    : ar
      ? `${ltr(String(total))} حسابًا على ${ledeHost}. تعليق الحساب يوقف مواقعه ومهامه المجدولة وبريده في خطوة واحدة.`
      : `${total} account${total === 1 ? '' : 's'} on ${ledeHost}. Suspending an account stops its sites, scheduled jobs and mail in one step.`
  const bannerHtml = isRoot
    ? (ar
      ? `<strong style="font-weight: 600">الموزعون يرون الحسابات التي يملكونها فقط.</strong> أنت داخل بصفتك ${ltr(username)}، لذا تظهر حسابات كل المالكين.`
      : `<strong style="font-weight: 600">Resellers only see accounts they own.</strong> You are signed in as ${escapeHtml(username)}, so accounts of every owner are listed.`)
    : (ar
      ? `<strong style="font-weight: 600">ترى الحسابات التي تملكها فقط.</strong>`
      : `<strong style="font-weight: 600">You see only the accounts you own.</strong>`)
  const emptyTitle = !ready ? (ar ? 'القائمة غير متاحة' : 'List unavailable') : total === 0 ? (ar ? 'لا توجد حسابات' : 'No accounts') : (ar ? 'لا حسابات تطابق هذه التصفية' : 'No accounts match these filters')
  const emptyHtml = !ready
    ? (ar ? 'تعذر قراءة الحسابات من الخادم.' : 'The server did not return the account list.')
    : total === 0
      ? (ar ? 'لم يُنشأ أي حساب بعد.' : 'No account has been created yet.')
      : (ar ? 'امسح التصفية لرؤية كل الحسابات.' : 'Clear the filters to see every account.')
  return {
    locale: ar ? 'ar' : 'en',
    art: false,
    hostname,
    username,
    versionLabel: props.version && props.version.trim() ? props.version.trim() : '—',
    generationLabel: generationId !== undefined ? (ar ? `الجيل ${generationId} · نشط` : `Generation ${generationId} · active`) : '—',
    generationLive: generationId !== undefined,
    ...labels,
    ledeHtml,
    bannerHtml,
    owners: [...new Set(rows.map(row => row.owner).filter(owner => owner !== (ar ? 'غير متاح' : 'Unavailable')))],
    plans: [...new Set(plans.map(plan => plan.name))],
    tabs: [
      { key: 'all', label: ar ? 'الكل' : 'All', count: String(total), pressed: true },
      { key: 'active', label: ar ? 'النشطة' : 'Active', count: String(active), pressed: false },
      { key: 'suspended', label: ar ? 'الموقوفة' : 'Suspended', count: String(suspended), pressed: false },
    ],
    bulkVisible: false,
    bulkCount: '0',
    bulkNames: '',
    showTable: ready && total > 0,
    caption: ar ? `الحسابات على ${hostname}، الأحدث أولاً` : `Accounts on ${hostname}, newest first`,
    rows,
    emptyTitle,
    emptyHtml,
    showEmpty: !ready || total === 0,
    countText: ready ? counts.text : (ar ? 'القائمة غير متاحة' : 'List unavailable'),
    countAll: counts.all,
    countSlice: counts.slice,
    countEmpty: counts.empty,
    pages: Array.from({ length: pageCount }, (_, index) => {
      const n = String(index + 1)
      return { n, label: ar ? `صفحة ${n}` : `Page ${n}`, current: index === 0 }
    }),
    hasNext: pageCount > 1,
    filtersDisabled: !ready,
  }
}

export const renderAccountsDocument = (model: AccountsBoardModel): string => {
  const ar = model.locale === 'ar'
  return `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${ar ? 'الحسابات — xWHM' : 'Accounts — xWHM'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
*{box-sizing:border-box}
</style>
</head>
<body>
${renderWhmAccounts(model)}
</body>
</html>`
}

export const renderLiveDocument = (dir: 'ltr' | 'rtl' = 'ltr'): string =>
  renderAccountsDocument(whmAccountsFromProps({
    locale: dir === 'rtl' ? 'ar' : 'en',
    principal: { kind: 'root', username: 'root' },
    isRoot: true,
    hostname: dir === 'rtl' ? 'الخادم' : '—',
  }))
