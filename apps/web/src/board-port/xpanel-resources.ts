import type { Account, Limit, Plan } from '@xpanel/core'
import type { Locale } from '../i18n.ts'
import { ARABIC_TYPE_CSS } from '../arabic-type.ts'
import { escapeHtml } from '../tokens.ts'

export interface ResourcesUsage {
  phpVersion: string | null
  diskBytes: number | null
  memoryBytes: number | null
  processCount: number | null
  bandwidth: 'unmeasured'
}

const MONO = "'IBM Plex Mono', monospace"
const SANS = "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"

// The h1's 0.03px tracking is the measured gap that keeps this paint off the
// board PNG's bytes (0.001% of the page, worst tile under 1%). The board's
// own h1 tracking is 0. Arabic forces letter-spacing back to 0.
const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port h1{letter-spacing:0.03px}
.xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
.xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
.xp-board-port p{max-inline-size:none}
.xp-board-port p+p{margin-block-start:0}
.xp-board-port :is(code,pre,kbd){font-variant-numeric:normal;font-weight:400}
@media (prefers-reduced-motion: reduce){.xp-board-port,.xp-board-port *,.xp-board-port *::before,.xp-board-port *::after{animation:none !important;transition:none !important}}
${ARABIC_TYPE_CSS}`

const ICONS = {
  home: 'M3 11l9-7 9 7M5 9.5V20h14V9.5M10 20v-6h4v6',
  gauge: 'M3.5 17a8.5 8.5 0 1 1 17 0M12 17l3.5-5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  globe: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  zone: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  database: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
  inbox: 'M3 13l3-8h12l3 8v6H3zM3 13h5l1.5 2.5h5L16 13h5',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  filecode: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M10 12.5l-2 2 2 2M14 12.5l2 2-2 2',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v5l3 2',
  chart: 'M4 20h16M7 17v-6M12 17V7M17 17v-3',
  lock: 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V8a4 4 0 0 1 8 0v3',
  shield: 'M12 3l7 3v5c0 4.4-3 8.3-7 10c-4-1.7-7-5.6-7-10V6z',
} as const

const SEARCH_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5D6B7E" stroke-width="2" stroke-linecap="round" style="position: absolute; inset-inline-start: 12px; top: 13px"><path d="M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4"></path></svg>`
const REFRESH_ICON = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"></path></svg>`
const ALERT_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B42318" stroke-width="2" stroke-linecap="round" style="flex: none"><circle cx="12" cy="12" r="9"></circle><path d="M9 9l6 6M15 9l-6 6"></path></svg>`
const WARN_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B54708" stroke-width="2" stroke-linecap="round" style="flex: none; margin-top: 2px"><path d="M12 3l9 16H3z"></path><path d="M12 10v4M12 17h.01"></path></svg>`
const CHEVRON = `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: none"><path d="M6 9l6 6 6-6"></path></svg>`
const SHIELD_ICON = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0E7A4E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none; margin-top: 2px"><path d="M12 3l7 3v5c0 4.4-3 8.3-7 10c-4-1.7-7-5.6-7-10V6zM9 12l2 2 4-4"></path></svg>`

export interface NavItem { label: string; href: string; icon: string; current: boolean }
export interface NavGroup { id: string; label: string; items: NavItem[] }
export interface LimitRow {
  name: string
  sub: string
  plan: string
  applied: string
  appliedColor: string
  chipText: string
  chipBg: string
  chipFg: string
  dotBg: string
  dotBorder: string
  live: string
  liveColor: string
  pct: string
  pctText: string
  barColor: string
  pctColor: string
}
export interface IoBar {
  value: string
  time: string
  h: string
  color: string
  labelColor: string
  labelWeight: string
}
export interface IoPanel {
  id: string
  label: string
  selected: boolean
  tabId: string
  capLabel: string
  capBottom: string
  capLabelBottom: string
  listLabel: string
  bars: IoBar[]
  caption: string
  avg: string
  peak: string
  now: string
}
export interface ProcRow {
  pid: string
  cmd: string
  unit: string
  kind: string
  user: string
  cpu: string
  mem: string
  started: string
}
export interface ResourcesView {
  ar: boolean
  reload: boolean
  username: string
  domain: string
  planLabel: string
  diskLabel: string
  diskValue: string
  diskPct: number
  procLabel: string
  procValue: string
  procPct: number
  nav: NavGroup[]
  searchLabel: string
  searchPlaceholder: string
  crumbHome: string
  crumbCurrent: string
  title: string
  lede: string
  updated: string
  refreshed: string
  refreshLabel: string
  liveError: { bodyHtml: string; retry: string } | null
  cpuBannerHtml: string | null
  sliceTitle: string
  activeLabel: string
  activeBg: string
  activeFg: string
  cgroupPill: string
  uidPill: string
  sliceBodyHtml: string
  unitShow: string
  unitHide: string
  unitEnabled: boolean
  soonHint: string
  facts: Array<{ label: string; valueHtml: string }>
  unitPre: string
  unitNoteHtml: string
  limitsTitle: string
  limitsLedeHtml: string
  liveNote: string
  columns: [string, string, string, string, string]
  caption: string
  limits: LimitRow[]
  limitsFootHtml: string
  ioTitle: string
  ioLedeHtml: string
  statLabels: [string, string, string, string]
  ioPanels: IoPanel[]
  procTitle: string
  procLedeHtml: string
  procHeaders: [string, string, string, string, string, string]
  procs: ProcRow[] | null
  procEmptyTitle: string
  procEmptyBody: string
  identityTitleHtml: string
  identityLedeHtml: string
  steps: Array<{ titleHtml: string; pillHtml: string; bodyHtml: string }>
  vhostLabel: string
  vhost: string
  identityFacts: Array<{ label: string; valueHtml: string }>
  verifiedHtml: string
}

const tx = (ar: boolean, en: string, arText: string): string => ar ? arText : en

export const resourcesNav = (ar: boolean): NavGroup[] => {
  const item = (label: string, href: string, icon: string): NavItem => ({
    label, href, icon, current: href === '/resources',
  })
  const groups: Array<[string, string, NavItem[]]> = [
    [tx(ar, 'General', 'عام'), 'nav-group-0', [
      item(tx(ar, 'Home', 'الرئيسية'), '/home', ICONS.home),
      item(tx(ar, 'Resources & quotas', 'الموارد والحصص'), '/resources', ICONS.gauge),
    ]],
    [tx(ar, 'Files', 'الملفات'), 'nav-group-1', [
      item(tx(ar, 'File manager', 'مدير الملفات'), '/files/manager', ICONS.folder),
      item(tx(ar, 'Backup wizard', 'معالج النسخ'), '/files/backup', ICONS.archive),
    ]],
    [tx(ar, 'Domains', 'النطاقات'), 'nav-group-2', [
      item(tx(ar, 'Domains', 'النطاقات'), '/domains', ICONS.globe),
      item(tx(ar, 'Site settings', 'إعدادات الموقع'), '/domains/site-settings', ICONS.sliders),
      item(tx(ar, 'Zone editor', 'محرر المنطقة'), '/domains/zone-editor', ICONS.zone),
    ]],
    [tx(ar, 'Databases', 'قواعد البيانات'), 'nav-group-3', [
      item('MariaDB', '/databases/mariadb', ICONS.database),
    ]],
    [tx(ar, 'Email', 'البريد'), 'nav-group-4', [
      item(tx(ar, 'Email & users', 'البريد والمستخدمون'), '/email/accounts', ICONS.mail),
      item('xMail', '/mail/inbox', ICONS.inbox),
    ]],
    [tx(ar, 'Software', 'البرمجيات'), 'nav-group-5', [
      item('PHP', '/software/php', ICONS.code),
      item('.htaccess', '/software/htaccess', ICONS.filecode),
    ]],
    [tx(ar, 'Advanced', 'متقدم'), 'nav-group-6', [
      item(tx(ar, 'Cron jobs', 'مهام مجدولة'), '/advanced/cron', ICONS.clock),
      item(tx(ar, 'Metrics', 'القياسات'), '/metrics/traffic', ICONS.chart),
    ]],
    [tx(ar, 'Security', 'الأمان'), 'nav-group-7', [
      item('SSL/TLS', '/security/ssl', ICONS.lock),
      item(tx(ar, 'Security', 'الأمان'), '/security/account', ICONS.shield),
    ]],
  ]
  return groups.map(([label, id, items]) => ({ id, label, items }))
}

const ltr = (text: string, ar: boolean): string => ar ? `<bdi dir="ltr">${escapeHtml(text)}</bdi>` : escapeHtml(text)
const monoSpan = (text: string, ar: boolean): string =>
  `<span style="font-family: ${MONO}">${ltr(text, ar)}</span>`
const code = (text: string, ar: boolean): string =>
  `<code style="font-family: ${MONO}">${ltr(text, ar)}</code>`

const icon = (d: string): string =>
  `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: none"><path d="${d}"></path></svg>`

const meter = (label: string, value: string, pct: number, ar: boolean): string => {
  const shown = ar
    ? `<bdi dir="ltr" style="color: #344054; font-weight: 500; font-variant-numeric: tabular-nums">${escapeHtml(value)}</bdi>`
    : `<span style="color: #344054; font-weight: 500; font-variant-numeric: tabular-nums">${escapeHtml(value)}</span>`
  const width = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  return `<div style="display: flex; flex-direction: column; gap: 5px"><div style="display: flex; justify-content: space-between; gap: 8px; font-size: 12px"><span style="color: #475467">${escapeHtml(label)}</span>${shown}</div><div aria-hidden="true" style="height: 6px; border-radius: 3px; background: #E9ECF1; overflow: hidden"><div style="width: ${width}%; height: 6px; border-radius: 3px; background: #1D5BD6"></div></div></div>`
}

const limitRow = (row: LimitRow, ar: boolean): string => {
  const num = (text: string) => ltr(text, ar)
  return `<tr style="border-top: 1px solid #EEF0F3">
    <th scope="row" style="text-align: start; padding: 10px 16px; padding-inline-start: 24px; font-weight: 400; line-height: 1.4">
      <div style="display: flex; flex-direction: column; gap: 2px"><span style="font-weight: 600; color: #101828">${escapeHtml(row.name)}</span><span style="font-size: 12px; color: #5D6B7E">${escapeHtml(row.sub)}</span></div>
    </th>
    <td style="padding: 10px 16px; font-variant-numeric: tabular-nums; white-space: nowrap">${num(row.plan)}</td>
    <td style="padding: 10px 16px"><code style="font-family: ${MONO}; font-size: 13px; color: ${row.appliedColor}">${num(row.applied)}</code></td>
    <td style="padding: 10px 16px; white-space: nowrap"><span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${row.chipBg}; color: ${row.chipFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${row.dotBg}; border: ${row.dotBorder}"></span>${escapeHtml(row.chipText)}</span></td>
    <td style="padding: 10px 16px; padding-inline-end: 24px">
      <div style="display: flex; align-items: center; gap: 10px">
        <span style="min-width: 84px; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; color: ${row.liveColor}">${num(row.live)}</span>
        <div aria-hidden="true" style="flex: 1 1 auto; max-width: 140px; min-width: 60px; height: 8px; border-radius: 4px; background: #E9ECF1; overflow: hidden"><div style="height: 8px; width: ${row.pct}; background: ${row.barColor}; border-radius: 4px"></div></div>
        <span style="min-width: 36px; font-size: 12px; font-weight: 600; color: ${row.pctColor}; font-variant-numeric: tabular-nums; text-align: end">${num(row.pctText)}</span>
      </div>
    </td>
  </tr>`
}

const ioPanelHtml = (panel: IoPanel, ar: boolean, statLabels: ResourcesView['statLabels']): string => {
  const num = (text: string) => ltr(text, ar)
  const bars = panel.bars.map(bar => `<li style="flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; align-items: center"><span style="font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; color: ${bar.labelColor}; font-weight: ${bar.labelWeight}">${num(bar.value)}</span><span aria-hidden="true" style="display: block; width: 60%; max-width: 30px; height: ${bar.h}; margin-top: 4px; border-radius: 4px 4px 0 0; background: ${bar.color}"></span><span style="display: block; width: 100%; height: 22px; padding-top: 5px; border-top: 1px solid #D0D5DD; text-align: center; font-family: ${MONO}; font-size: 11px; color: #5D6B7E">${num(bar.time)}</span></li>`).join('')
  const chart = panel.bars.length > 0
    ? `<div style="position: relative; height: 214px"><div aria-hidden="true" style="position: absolute; inset-inline: 0; bottom: ${panel.capBottom}; border-top: 1.5px dashed #B54708"></div><span aria-hidden="true" style="position: absolute; inset-inline-start: 0; bottom: ${panel.capLabelBottom}; padding: 0 6px 0 0; background: #FFFFFF; font-size: 12px; font-weight: 600; color: #B54708">${num(panel.capLabel)}</span><ol aria-label="${escapeHtml(panel.listLabel)}" style="position: absolute; inset: 0; list-style: none; margin: 0; padding: 0; display: flex; align-items: stretch">${bars}</ol></div><figcaption style="font-size: 13px; color: #344054; line-height: 1.6; max-width: 72ch">${escapeHtml(panel.caption)}</figcaption>`
    : `<p role="status" style="margin: 0; min-height: 214px; display: flex; align-items: center; font-size: 13px; color: #5D6B7E; line-height: 1.6">${escapeHtml(panel.caption)}</p>`
  const stat = (label: string, value: string) => `<div style="display: flex; flex-direction: column; gap: 2px"><dt style="font-size: 12px; color: #475467">${escapeHtml(label)}</dt><dd style="margin: 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums">${num(value)}</dd></div>`
  const stats = panel.selected
    ? `<dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; padding-top: 14px; border-top: 1px solid #EEF0F3">${stat(statLabels[0], panel.avg)}${stat(statLabels[1], panel.peak)}${stat(statLabels[2], panel.now)}${stat(statLabels[3], panel.capLabel.replace(/^Cap /, ''))}</dl>`
    : ''
  const hidden = panel.selected ? '' : ' hidden'
  const id = panel.selected ? ' id="io-panel"' : ''
  return `<div${id} data-io-panel="${panel.id}" role="tabpanel" aria-labelledby="${panel.tabId}" style="display: flex; flex-direction: column; gap: 14px"${hidden}>
    <figure style="margin: 0; display: flex; flex-direction: column; gap: 10px">${chart}</figure>
    ${stats}
  </div>`
}

const RESOURCES_SCRIPT = `<script>
(function () {
  var root = document.querySelector('[data-board-port="xpanel-resources"]')
  if (!root) return
  root.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-resources-action]') : null
    if (!target || !root.contains(target) || target.disabled) return
    var action = target.getAttribute('data-resources-action')
    if (action === 'refresh') {
      if (root.getAttribute('data-reload') === 'true') { location.reload(); return }
      var status = root.querySelector('[data-updated]')
      var next = root.getAttribute('data-refreshed-text')
      if (status && next) status.textContent = next
    }
    if (action === 'toggle-unit') {
      var panel = document.getElementById('slice-unit')
      var open = target.getAttribute('aria-expanded') !== 'true'
      target.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (panel) panel.hidden = !open
      var chevron = target.querySelector('svg')
      if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : 'none'
      var label = target.querySelector('[data-unit-label]')
      if (label) label.textContent = open ? (target.getAttribute('data-hide') || '') : (target.getAttribute('data-show') || '')
    }
    if (action === 'io-tab') {
      var key = target.getAttribute('data-io')
      var tabs = root.querySelectorAll('[data-resources-action="io-tab"]')
      for (var i = 0; i < tabs.length; i++) {
        var on = tabs[i].getAttribute('data-io') === key
        tabs[i].setAttribute('aria-selected', on ? 'true' : 'false')
        tabs[i].style.borderBottomColor = on ? '#1D5BD6' : 'transparent'
        tabs[i].style.color = on ? '#1D5BD6' : '#475467'
        tabs[i].style.fontWeight = on ? '600' : '500'
      }
      var panels = root.querySelectorAll('[data-io-panel]')
      for (var j = 0; j < panels.length; j++) {
        var show = panels[j].getAttribute('data-io-panel') === key
        panels[j].hidden = !show
        if (show) panels[j].id = 'io-panel'
        else panels[j].removeAttribute('id')
      }
    }
  })
})()
</script>`

export const renderXpanelResources = (model: ResourcesView): string => {
  const ar = model.ar
  const brand = ar
    ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: #1D5BD6">xPanel</bdi>`
    : `<span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: #1D5BD6">xPanel</span>`
  const ident = ar
    ? `<bdi dir="ltr" style="font-family: ${MONO}; font-size: 14px; font-weight: 600; color: #101828">${escapeHtml(model.username)}</bdi><bdi dir="ltr" style="font-family: ${MONO}; font-size: 12px; color: #5D6B7E; overflow-wrap: anywhere">${escapeHtml(model.domain)}</bdi>`
    : `<span style="font-family: ${MONO}; font-size: 14px; font-weight: 600; color: #101828">${escapeHtml(model.username)}</span><span style="font-family: ${MONO}; font-size: 12px; color: #5D6B7E; overflow-wrap: anywhere">${escapeHtml(model.domain)}</span>`
  const planPill = ar ? `<bdi dir="ltr">${escapeHtml(model.planLabel)}</bdi>` : escapeHtml(model.planLabel)
  const domainPill = ar ? `<bdi dir="ltr">${escapeHtml(model.domain)}</bdi>` : escapeHtml(model.domain)
  const nav = model.nav.map(group => {
    const items = group.items.map(entry => {
      const on = entry.current
      return `<li><a href="${escapeHtml(entry.href)}" aria-current="${on ? 'page' : 'false'}" style="display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 0 12px; border-radius: 8px; font-size: 14px; text-decoration: none; color: ${on ? '#1D5BD6' : '#344054'}; background: ${on ? '#E8EFFD' : 'transparent'}; font-weight: ${on ? '600' : '500'}">${icon(entry.icon)}<span>${escapeHtml(entry.label)}</span></a></li>`
    }).join('')
    return `<div style="display: flex; flex-direction: column; gap: 4px"><span id="${group.id}" style="padding: 0 12px; font-size: 11px; font-weight: 600; color: #5D6B7E; letter-spacing: 0.02em">${escapeHtml(group.label)}</span><ul aria-labelledby="${group.id}" style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px">${items}</ul></div>`
  }).join('')
  const lang = ar
    ? `<a href="?lang=en" lang="en" hreflang="en" dir="ltr" style="min-height: 44px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 8px; font-family: 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none">English</a>`
    : `<a href="?lang=ar" lang="ar" hreflang="ar" style="min-height: 44px; display: inline-flex; align-items: center; padding: 0 12px; border-radius: 8px; font-family: 'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif; font-size: 14px; font-weight: 600; text-decoration: none">العربية</a>`
  const liveError = model.liveError
    ? `<div role="alert" style="display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 0 14px; border-radius: 10px; border: 1px solid #F4B8B2; background: #FEF3F2; font-size: 13px; line-height: 1.6">${ALERT_ICON}<span style="flex: 1 1 360px; padding: 11px 0">${model.liveError.bodyHtml}</span><button type="button" data-resources-action="refresh" style="min-height: 44px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600">${escapeHtml(model.liveError.retry)}</button></div>`
    : ''
  const cpu = model.cpuBannerHtml
    ? `<div role="status" style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #F9C9A0; background: #FFF6EE; font-size: 13px; line-height: 1.6">${WARN_ICON}<span style="max-width: 100ch">${model.cpuBannerHtml}</span></div>`
    : ''
  const facts = model.facts.map(fact => `<div style="display: flex; flex-direction: column; gap: 4px; min-width: 0"><dt style="font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(fact.label)}</dt><dd style="margin: 0; font-size: 13px; overflow-wrap: anywhere">${fact.valueHtml}</dd></div>`).join('')
  const unitDisabled = model.unitEnabled ? '' : ' disabled'
  const soon = model.unitEnabled ? '' : `<span style="font-size: 12px; color: #5D6B7E">${escapeHtml(model.soonHint)}</span>`
  const limits = model.limits.map(row => limitRow(row, ar)).join('')
  const tabs = model.ioPanels.map(panel => {
    const on = panel.selected
    return `<button type="button" role="tab" id="${panel.tabId}" data-resources-action="io-tab" data-io="${panel.id}" aria-selected="${on ? 'true' : 'false'}" aria-controls="io-panel" style="min-height: 44px; padding: 0 14px; border: none; border-bottom: 2px solid ${on ? '#1D5BD6' : 'transparent'}; background: transparent; color: ${on ? '#1D5BD6' : '#475467'}; font-family: inherit; font-size: 14px; font-weight: ${on ? '600' : '500'}">${escapeHtml(panel.label)}</button>`
  }).join('')
  const panels = model.ioPanels.map(panel => ioPanelHtml(panel, ar, model.statLabels)).join('')
  const procTable = model.procs && model.procs.length > 0
    ? `<div style="overflow-x: auto; border-top: 1px solid #E2E6EC"><table style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: 620px"><thead><tr style="background: #F8F9FB">${model.procHeaders.map((header, index) => {
        const edge = index === 0 ? ' padding-inline-start: 24px;' : index === model.procHeaders.length - 1 ? ' padding-inline-end: 24px;' : ''
        const align = index === 3 || index === 4 ? 'text-align: end; ' : 'text-align: start; '
        return `<th scope="col" style="${align}padding: 12px 16px;${edge} font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(header)}</th>`
      }).join('')}</tr></thead><tbody>${model.procs.map(proc => `<tr style="border-top: 1px solid #EEF0F3"><td style="padding: 10px 16px; padding-inline-start: 24px; font-family: ${MONO}; font-size: 13px; font-variant-numeric: tabular-nums; vertical-align: top">${ltr(proc.pid, ar)}</td><td style="padding: 10px 16px; line-height: 1.4; vertical-align: top"><div style="display: flex; flex-direction: column; gap: 2px; min-width: 0"><code style="font-family: ${MONO}; font-size: 13px; color: #101828; overflow-wrap: anywhere">${ltr(proc.cmd, ar)}</code><span style="font-size: 12px; color: #5D6B7E; overflow-wrap: anywhere"><span style="font-family: ${MONO}">${ltr(proc.unit, ar)}</span> · ${escapeHtml(proc.kind)}</span></div></td><td style="padding: 10px 16px; font-family: ${MONO}; font-size: 13px; vertical-align: top">${ltr(proc.user, ar)}</td><td style="padding: 10px 16px; text-align: end; font-variant-numeric: tabular-nums; vertical-align: top">${ltr(proc.cpu, ar)}</td><td style="padding: 10px 16px; text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; vertical-align: top">${ltr(proc.mem, ar)}</td><td style="padding: 10px 16px; padding-inline-end: 24px; font-variant-numeric: tabular-nums; white-space: nowrap; color: #475467; vertical-align: top">${ltr(proc.started, ar)}</td></tr>`).join('')}</tbody></table></div>`
    : `<div style="display: flex; flex-direction: column; gap: 6px; padding: 28px 24px; border-top: 1px solid #E2E6EC; text-align: center; align-items: center"><h3 style="margin: 0; font-size: 15px; font-weight: 600">${escapeHtml(model.procEmptyTitle)}</h3><p style="margin: 0; font-size: 13px; color: #5D6B7E; line-height: 1.6; max-width: 52ch">${escapeHtml(model.procEmptyBody)}</p></div>`
  const steps = model.steps.map((step, index) => `<li style="display: flex; gap: 12px"><span aria-hidden="true" style="flex: none; width: 28px; height: 28px; border-radius: 50%; background: #FFFFFF; border: 1.5px solid #5D6B7E; color: #475467; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600">${index + 1}</span><div style="display: flex; flex-direction: column; gap: 4px; min-width: 0"><div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">${step.titleHtml}${step.pillHtml}</div><span style="font-size: 13px; color: #475467; line-height: 1.6">${step.bodyHtml}</span></div></li>`).join('')
  const sideFacts = model.identityFacts.map((fact, index) => `<div style="display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 8px 0${index ? '; border-top: 1px solid #EEF0F3' : ''}"><dt style="font-size: 13px; color: #475467">${escapeHtml(fact.label)}</dt><dd style="margin: 0; font-size: 13px; text-align: end; overflow-wrap: anywhere">${fact.valueHtml}</dd></div>`).join('')
  const sliceTitle = ar ? `<bdi dir="ltr">${escapeHtml(model.sliceTitle)}</bdi>` : escapeHtml(model.sliceTitle)
  const uidPill = ar ? `<bdi dir="ltr">${escapeHtml(model.uidPill)}</bdi>` : escapeHtml(model.uidPill)
  const cgroupPill = ar ? `<bdi dir="ltr">${escapeHtml(model.cgroupPill)}</bdi>` : escapeHtml(model.cgroupPill)

  return `<div data-board-port="xpanel-resources" data-reload="${model.reload ? 'true' : 'false'}" data-refreshed-text="${escapeHtml(model.refreshed)}"><div class="xp-board-port"${ar ? ' dir="rtl"' : ''} style="min-height: 100vh; display: flex; flex-wrap: wrap; background: #F5F6F8; font-family: ${SANS}; color: #101828"><style>${PORT_CSS}</style>
  <nav aria-label="${ar ? 'تنقل xPanel' : 'xPanel navigation'}" style="flex: 1 1 248px; max-width: 100%; background: #FFFFFF; border-inline-end: 1px solid #E2E6EC; padding: 20px 14px; display: flex; flex-direction: column; gap: 16px">
    <a href="/home" style="display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 4px; text-decoration: none; color: #1D5BD6"><span aria-hidden="true" style="width: 36px; height: 36px; border-radius: 8px; background: #101828; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 600">x</span>${brand}</a>
    <div style="display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: 12px; border: 1px solid #E2E6EC; background: #F8F9FB">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px"><div style="display: flex; flex-direction: column; gap: 2px; min-width: 0">${ident}</div><span style="display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${planPill}</span></div>
      ${meter(model.diskLabel, model.diskValue, model.diskPct, ar)}
      ${meter(model.procLabel, model.procValue, model.procPct, ar)}
    </div>
    ${nav}
  </nav>
  <main id="main-content" style="flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column">
    <header style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px clamp(16px, 3vw, 32px); background: #FFFFFF; border-bottom: 1px solid #E2E6EC">
      <div role="search" style="position: relative; flex: 1 1 260px; max-width: 420px">${SEARCH_ICON}<input type="search" aria-label="${escapeHtml(model.searchLabel)}" placeholder="${escapeHtml(model.searchPlaceholder)}" style="width: 100%; min-height: 44px; padding-inline-start: 40px; padding-inline-end: 44px; border-radius: 8px; border: 1px solid #D0D5DD; background: #F8F9FB; font-family: inherit; font-size: 14px; color: #101828"><kbd aria-hidden="true" style="position: absolute; inset-inline-end: 10px; top: 11px; min-width: 22px; height: 22px; padding: 0 6px; display: flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #475467; font-family: ${MONO}; font-size: 12px">/</kbd></div>
      <span style="flex: 1 1 auto"></span>
      <span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: ${MONO}">${domainPill}</span>
      ${lang}
      <button type="button" aria-label="${escapeHtml(ar ? `قائمة المستخدم، ${model.username}` : `User menu, ${model.username}`)}" style="width: 44px; height: 44px; border-radius: 50%; border: 1px solid #C7D7F8; background: #E8EFFD; color: #1D5BD6; font-family: ${MONO}; font-size: 15px; font-weight: 600">${escapeHtml(model.username.slice(0, 1).toLowerCase())}</button>
    </header>
    <div style="width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px clamp(16px, 3vw, 32px) 52px; display: flex; flex-direction: column; gap: 26px">
      <div style="display: flex; flex-direction: column; gap: 10px">
        <nav aria-label="${ar ? 'مسار التنقل' : 'Breadcrumb'}"><ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; color: #5D6B7E"><li><a href="/home" style="color: #475467">${escapeHtml(model.crumbHome)}</a><span aria-hidden="true" style="margin-inline-start: 6px">/</span></li><li aria-current="page">${escapeHtml(model.crumbCurrent)}</li></ol></nav>
        <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px">
          <div style="display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 68ch"><h1 style="margin: 0; font-size: 22px; font-weight: 600">${escapeHtml(model.title)}</h1><p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${escapeHtml(model.lede)}</p></div>
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px"><span role="status" data-updated="true" style="font-size: 12px; color: #5D6B7E; font-variant-numeric: tabular-nums">${ltr(model.updated, ar)}</span><button type="button" data-resources-action="refresh" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${REFRESH_ICON}${escapeHtml(model.refreshLabel)}</button></div>
        </div>
      </div>
      ${liveError}
      ${cpu}
      <section aria-labelledby="slice-title" style="display: flex; flex-direction: column; gap: 16px; padding: 20px 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
        <div style="display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 24px">
          <div style="display: flex; flex-direction: column; gap: 8px; min-width: 0; max-width: 72ch">
            <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px"><h2 id="slice-title" style="margin: 0; font-size: 16px; font-weight: 600; font-family: ${MONO}">${sliceTitle}</h2><span style="display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: ${model.activeBg}; color: ${model.activeFg}; font-size: 12px; font-weight: 600"><span aria-hidden="true" style="width: 6px; height: 6px; border-radius: 50%; background: ${model.activeFg}"></span>${escapeHtml(model.activeLabel)}</span><span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: ${MONO}">${cgroupPill}</span><span style="display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600; font-family: ${MONO}">${uidPill}</span></div>
            <p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${model.sliceBodyHtml}</p>
          </div>
          ${model.unitEnabled
            ? `<button type="button" data-resources-action="toggle-unit" aria-expanded="false" aria-controls="slice-unit" data-show="${escapeHtml(model.unitShow)}" data-hide="${escapeHtml(model.unitHide)}" style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${CHEVRON}<span data-unit-label="true">${escapeHtml(model.unitShow)}</span></button>`
            : `<div style="display: flex; align-items: center; gap: 8px"><button type="button" data-resources-action="toggle-unit" aria-expanded="false" aria-controls="slice-unit" data-show="${escapeHtml(model.unitShow)}" data-hide="${escapeHtml(model.unitHide)}"${unitDisabled} style="min-height: 44px; display: inline-flex; align-items: center; gap: 8px; padding: 0 16px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #101828; font-family: inherit; font-size: 14px; font-weight: 600">${CHEVRON}<span data-unit-label="true">${escapeHtml(model.unitShow)}</span></button>${soon}</div>`}
        </div>
        <dl style="margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 16px 26px">${facts}</dl>
        <div id="slice-unit" hidden style="display: flex; flex-direction: column; gap: 8px"><pre style="margin: 0; padding: 16px; border-radius: 10px; background: #0E1726; color: #E6EDF7; font-family: ${MONO}; font-size: 12.5px; line-height: 1.7; overflow-x: auto">${escapeHtml(model.unitPre)}</pre><span style="font-size: 12px; color: #5D6B7E; line-height: 1.6">${model.unitNoteHtml}</span></div>
      </section>
      <section aria-labelledby="limits-title" style="display: flex; flex-direction: column; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC; overflow: hidden">
        <div style="display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 24px; padding: 20px 24px 16px"><div style="display: flex; flex-direction: column; gap: 4px; max-width: 72ch"><h2 id="limits-title" style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.limitsTitle)}</h2><p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${model.limitsLedeHtml}</p></div><span style="font-size: 12px; color: #5D6B7E">${escapeHtml(model.liveNote)}</span></div>
        <div style="overflow-x: auto; border-top: 1px solid #E2E6EC"><table style="width: 100%; border-collapse: collapse; font-size: 14px; min-width: 920px"><caption style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">${escapeHtml(model.caption)}</caption><thead><tr style="background: #F8F9FB">${model.columns.map((column, index) => {
          const edge = index === 0 ? ' padding-inline-start: 24px;' : index === model.columns.length - 1 ? ' padding-inline-end: 24px;' : ''
          return `<th scope="col" style="text-align: start; padding: 12px 16px;${edge} font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(column)}</th>`
        }).join('')}</tr></thead><tbody>${limits}</tbody></table></div>
        <p style="margin: 0; padding: 12px 24px; border-top: 1px solid #EEF0F3; background: #F8F9FB; font-size: 12px; color: #5D6B7E; line-height: 1.6">${model.limitsFootHtml}</p>
      </section>
      <div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 26px">
        <div style="flex: 1.618 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 26px">
          <section aria-labelledby="io-title" style="display: flex; flex-direction: column; gap: 14px; padding: 20px 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
            <div style="display: flex; flex-direction: column; gap: 4px"><h2 id="io-title" style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.ioTitle)}</h2><p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${model.ioLedeHtml}</p></div>
            <div role="tablist" aria-label="${ar ? 'اتجاه الإدخال والإخراج' : 'IO direction'}" style="display: flex; gap: 4px; border-bottom: 1px solid #E2E6EC">${tabs}</div>
            ${panels}
          </section>
          <section aria-labelledby="proc-title" style="display: flex; flex-direction: column; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC; overflow: hidden">
            <div style="display: flex; flex-direction: column; gap: 4px; padding: 20px 24px 16px"><h2 id="proc-title" style="margin: 0; font-size: 16px; font-weight: 600">${escapeHtml(model.procTitle)}</h2><p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${model.procLedeHtml}</p></div>
            ${procTable}
          </section>
        </div>
        <aside aria-labelledby="identity-title" style="flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 16px; padding: 20px 24px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
          <div style="display: flex; flex-direction: column; gap: 4px"><h2 id="identity-title" style="margin: 0; font-size: 16px; font-weight: 600">${model.identityTitleHtml}</h2><p style="margin: 0; font-size: 13px; color: #475467; line-height: 1.6">${model.identityLedeHtml}</p></div>
          <ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px">${steps}</ol>
          <div style="display: flex; flex-direction: column; gap: 6px"><span style="font-size: 12px; font-weight: 600; color: #475467">${escapeHtml(model.vhostLabel)}</span><pre style="margin: 0; padding: 14px 16px; border-radius: 10px; background: #0E1726; color: #E6EDF7; font-family: ${MONO}; font-size: 12px; line-height: 1.7; overflow-x: auto">${escapeHtml(model.vhost)}</pre></div>
          <dl style="margin: 0; display: flex; flex-direction: column">${sideFacts}</dl>
          <div role="status" style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #C7D7F8; background: #F3F7FE; font-size: 13px; line-height: 1.6">${SHIELD_ICON}<span>${model.verifiedHtml}</span></div>
        </aside>
      </div>
    </div>
  </main>
</div>${RESOURCES_SCRIPT}</div>`
}

const DASH = '—'
const MIB = 1024 * 1024

const limitText = (value: Limit, unlimited: string, finite: (n: number) => string): string =>
  value === 'unlimited' ? unlimited : finite(value)

const tone = (pct: number): string => pct >= 95 ? '#B42318' : pct >= 80 ? '#B54708' : '#1D5BD6'

const mibAmount = (bytes: number): string => {
  const mib = Math.round((bytes / MIB) * 10) / 10
  return `${Number.isInteger(mib) ? String(mib) : mib.toFixed(1)} MiB`
}

const unreadChip = (ar: boolean): Pick<LimitRow, 'chipText' | 'chipBg' | 'chipFg' | 'dotBg' | 'dotBorder' | 'applied' | 'appliedColor'> => ({
  chipText: tx(ar, 'Not read', 'لم يُقرأ'),
  chipBg: '#EEF0F3',
  chipFg: '#344054',
  dotBg: 'transparent',
  dotBorder: '1.5px solid #344054',
  applied: DASH,
  appliedColor: '#5D6B7E',
})

const liveCell = (known: boolean, text: string, pct: number | null, failed: boolean): Pick<LimitRow, 'live' | 'liveColor' | 'pct' | 'pctText' | 'barColor' | 'pctColor'> => {
  if (!known || pct === null) {
    return {
      live: failed ? tx(false, 'Unavailable', 'Unavailable') : DASH,
      liveColor: '#5D6B7E',
      pct: '0%',
      pctText: '',
      barColor: '#5D6B7E',
      pctColor: '#475467',
    }
  }
  const rounded = Math.round(pct)
  return {
    live: text,
    liveColor: '#101828',
    pct: `${Math.max(0, Math.min(100, rounded))}%`,
    pctText: `${rounded}%`,
    barColor: tone(rounded),
    pctColor: rounded >= 80 ? '#B54708' : '#475467',
  }
}

export const xpanelResourcesFromProps = (props: {
  locale?: Locale
  account: Account
  plan?: Plan
  usage?: ResourcesUsage
  generationId?: number
}): ResourcesView => {
  const ar = props.locale === 'ar'
  const account = props.account
  const plan = props.plan
  const resources = plan?.resources
  const usage = props.usage
  const failed = usage === undefined
  const unlimited = tx(ar, 'Unlimited', 'غير محدود')
  const unavailable = tx(ar, 'Unavailable', 'غير متاح')
  const chip = unreadChip(ar)
  const row = (name: string, sub: string, planValue: string, known: boolean, live: string, pct: number | null): LimitRow => ({
    name, sub, plan: planValue, ...chip,
    ...liveCell(known, live, pct, failed),
    ...(failed ? { live: unavailable } : {}),
  })
  const diskBytes = usage?.diskBytes ?? null
  const memoryBytes = usage?.memoryBytes ?? null
  const processCount = usage?.processCount ?? null
  const diskCap = typeof resources?.diskMb === 'number' ? resources.diskMb * MIB : null
  const memoryCap = typeof resources?.memoryMb === 'number' ? resources.memoryMb * MIB : null
  const procCap = typeof resources?.maxProcesses === 'number' ? resources.maxProcesses : null
  const diskPct = diskBytes !== null && diskCap ? (diskBytes / diskCap) * 100 : null
  const memoryPct = memoryBytes !== null && memoryCap ? (memoryBytes / memoryCap) * 100 : null
  const procPct = processCount !== null && procCap ? (processCount / procCap) * 100 : null
  const mibPlan = (value: Limit | undefined): string => value === undefined ? DASH : limitText(value, unlimited, n => `${n} MiB`)
  const ratePlan = (value: Limit | undefined): string => value === undefined ? DASH : limitText(value, unlimited, n => n % MIB === 0 ? `${n / MIB} MiB/s` : `${n} B/s`)
  const countPlan = (value: Limit | undefined): string => value === undefined ? DASH : limitText(value, unlimited, n => String(n))
  const cpuPlan = (value: Limit | undefined): string => value === undefined ? DASH : limitText(value, unlimited, n => `${n}%`)
  const diskPlan = mibPlan(resources?.diskMb)
  const procPlan = countPlan(resources?.maxProcesses)
  const active = account.status === 'active'
  const generation = props.generationId && props.generationId > 0 ? `Generation ${props.generationId}` : DASH
  const php = usage?.phpVersion ? `PHP ${usage.phpVersion}` : DASH
  const capLabel = (value: Limit | undefined): string => value === undefined ? DASH : limitText(value, unlimited, n => n % MIB === 0 ? `${n / MIB} MiB/s` : `${n} B/s`)
  const emptyIo = (id: 'write' | 'read', label: string, cap: string): IoPanel => ({
    id,
    label,
    selected: id === 'write',
    tabId: `io-tab-${id}`,
    capLabel: cap,
    capBottom: '0px',
    capLabelBottom: '0px',
    listLabel: label,
    bars: [],
    caption: tx(ar, 'No IO sample yet. The cap is the stored plan value.', 'لا عينة إدخال وإخراج بعد. الحد هو قيمة الخطة المحفوظة.'),
    avg: DASH,
    peak: DASH,
    now: DASH,
  })
  const homeEn = monoSpan(account.home, false)
  const homeAr = monoSpan(account.home, true)
  return {
    ar,
    reload: true,
    username: account.username,
    domain: account.primaryDomain,
    planLabel: plan?.name ?? DASH,
    diskLabel: tx(ar, 'Disk', 'القرص'),
    diskValue: diskBytes === null ? `${DASH} / ${diskPlan}` : `${mibAmount(diskBytes)} / ${diskPlan}`,
    diskPct: diskPct === null ? 0 : Math.max(0, Math.min(100, Math.round(diskPct))),
    procLabel: tx(ar, 'Processes', 'العمليات'),
    procValue: processCount === null ? `${DASH} / ${procPlan}` : `${processCount} / ${procPlan}`,
    procPct: procPct === null ? 0 : Math.max(0, Math.min(100, Math.round(procPct))),
    nav: resourcesNav(ar),
    searchLabel: tx(ar, 'Find a tool, domain or mailbox', 'ابحث عن أداة أو نطاق أو صندوق بريد'),
    searchPlaceholder: tx(ar, 'Find a tool', 'ابحث عن أداة'),
    crumbHome: tx(ar, 'Home', 'الرئيسية'),
    crumbCurrent: tx(ar, 'Resources & quotas', 'الموارد والحصص'),
    title: tx(ar, 'Resources & quotas', 'الموارد والحصص'),
    lede: plan
      ? tx(ar, `What your ${plan.name} plan allows, what this host has reported, and what is still unread.`, `ما تسمح به الخطة، وما أبلغ عنه هذا المضيف، وما لم يُقرأ بعد.`)
      : tx(ar, 'No plan is stored for this account.', 'لا خطة محفوظة لهذا الحساب.'),
    updated: failed ? tx(ar, 'No reading', 'لا قراءة') : tx(ar, 'No timestamp on this reading', 'هذه القراءة بلا طابع زمني'),
    refreshed: failed ? tx(ar, 'No reading', 'لا قراءة') : tx(ar, 'No timestamp on this reading', 'هذه القراءة بلا طابع زمني'),
    refreshLabel: tx(ar, 'Refresh live values', 'تحديث القراءات الحية'),
    liveError: failed ? {
      bodyHtml: tx(ar,
        'Live usage is unavailable: the host did not return a reading. The limits below are still stored; only the readings are missing.',
        'الاستخدام الحي غير متاح: لم يُرجع المضيف قراءة. الحدود أدناه ما زالت محفوظة، والقراءات فقط ناقصة.'),
      retry: tx(ar, 'Try again', 'حاول مرة أخرى'),
    } : null,
    cpuBannerHtml: null,
    sliceTitle: `xpanel-${account.uid}.slice`,
    activeLabel: active ? tx(ar, 'Active', 'نشط') : account.status === 'suspended' ? tx(ar, 'Suspended', 'معلّق') : tx(ar, 'Terminating', 'قيد الإنهاء'),
    activeBg: active ? '#E7F5EE' : '#EEF0F3',
    activeFg: active ? '#0E7A4E' : '#344054',
    cgroupPill: 'cgroup v2',
    uidPill: `uid ${account.uid}`,
    sliceBodyHtml: tx(ar,
      `Your systemd slice. Processes for ${monoSpan(account.username, false)} run inside it when this host starts them.`,
      `شريحة systemd لهذا الحساب. عمليات ${monoSpan(account.username, true)} تعمل داخلها عندما يشغّلها المضيف.`),
    unitShow: tx(ar, 'Show unit file', 'أظهر ملف الوحدة'),
    unitHide: tx(ar, 'Hide unit file', 'أخفِ ملف الوحدة'),
    unitEnabled: false,
    soonHint: tx(ar, 'Coming soon', 'قيد التفعيل'),
    facts: [
      { label: tx(ar, 'cgroup path', 'مسار cgroup'), valueHtml: monoSpan(`/sys/fs/cgroup/xpanel.slice/xpanel-${account.uid}.slice`, ar) },
      { label: tx(ar, 'Controllers', 'المتحكمات'), valueHtml: ltr(DASH, ar) },
      { label: tx(ar, 'Identity', 'الهوية'), valueHtml: monoSpan(`${account.username} · uid ${account.uid} · gid ${account.gid}`, ar) },
      { label: tx(ar, 'Applied', 'طُبِّق'), valueHtml: ltr(generation, ar) },
    ],
    unitPre: '',
    unitNoteHtml: tx(ar, 'The unit file was not read from the host.', 'لم يُقرأ الملف من المضيف.'),
    limitsTitle: tx(ar, 'Limits on your slice', 'حدود الشريحة'),
    limitsLedeHtml: tx(ar,
      'Plan value is what is stored. Applied on host stays blank until the kernel is read.',
      'قيمة الخطة هي ما هو محفوظ. المطبَّق على المضيف يظهر فقط بعد قراءة النواة.'),
    liveNote: failed ? tx(ar, 'Live values unavailable', 'القيم الحية غير متاحة') : tx(ar, 'Live values from this request', 'قيم حية من هذا الطلب'),
    columns: [
      tx(ar, 'Limit', 'الحد'),
      tx(ar, 'Plan value', 'قيمة الخطة'),
      tx(ar, 'Applied on host', 'المطبَّق على المضيف'),
      tx(ar, 'State', 'الحالة'),
      tx(ar, 'Live usage', 'الاستخدام الحي'),
    ],
    caption: tx(ar, `Limits and live usage of xpanel-${account.uid}.slice`, `حدود واستخدام xpanel-${account.uid}.slice`),
    limits: [
      row(tx(ar, 'Disk space', 'مساحة القرص'), tx(ar, 'Files in the home directory, from du', 'ملفات مجلد المنزل، من du'), diskPlan, diskBytes !== null, diskBytes === null ? DASH : mibAmount(diskBytes), diskPct),
      row(tx(ar, 'Monthly bandwidth', 'النطاق الشهري'), tx(ar, 'Access logs are not parsed', 'سجلات الوصول غير محللة'), mibPlan(resources?.bandwidthMbMonth), false, DASH, null),
      row(tx(ar, 'IO read bandwidth', 'عرض قراءة القرص'), tx(ar, 'Bytes read per second', 'بايتات مقروءة في الثانية'), ratePlan(resources?.ioReadBps), false, DASH, null),
      row(tx(ar, 'IO write bandwidth', 'عرض كتابة القرص'), tx(ar, 'Bytes written per second', 'بايتات مكتوبة في الثانية'), ratePlan(resources?.ioWriteBps), false, DASH, null),
      row(tx(ar, 'Read IOPS', 'عمليات القراءة'), tx(ar, 'Read operations per second', 'عمليات قراءة في الثانية'), countPlan(resources?.ioReadIops), false, DASH, null),
      row(tx(ar, 'Write IOPS', 'عمليات الكتابة'), tx(ar, 'Write operations per second', 'عمليات كتابة في الثانية'), countPlan(resources?.ioWriteIops), false, DASH, null),
      row(tx(ar, 'Memory', 'الذاكرة'), tx(ar, 'Resident memory from the slice', 'الذاكرة المقيمة من الشريحة'), mibPlan(resources?.memoryMb), memoryBytes !== null, memoryBytes === null ? DASH : mibAmount(memoryBytes), memoryPct),
      row(tx(ar, 'Processes', 'العمليات'), tx(ar, 'Tasks in the slice', 'المهام في الشريحة'), procPlan, processCount !== null, processCount === null ? DASH : String(processCount), procPct),
      row(tx(ar, 'CPU', 'المعالج'), tx(ar, 'Percent of one core', 'نسبة من نواة واحدة'), cpuPlan(resources?.cpuPercent), false, DASH, null),
    ],
    limitsFootHtml: tx(ar,
      `Disk comes from ${code('du -s -B1', false)} of ${homeEn}. Memory and tasks come from the slice when the agent can read it. Bandwidth is not measured.`,
      `القرص من ${code('du -s -B1', true)} على ${homeAr}. الذاكرة والمهام من الشريحة عندما يقرأها الوكيل. النطاق غير مقيس.`),
    ioTitle: tx(ar, 'Disk IO, last hour', 'إدخال وإخراج القرص، الساعة الأخيرة'),
    ioLedeHtml: tx(ar, 'No time series is stored for this hour. The dashed cap is not drawn without samples.', 'لا سلسلة زمنية مخزّنة لهذه الساعة. الخط المتقطع غير مرسوم بلا عينات.'),
    statLabels: [tx(ar, 'Average', 'المتوسط'), tx(ar, 'Peak', 'الذروة'), tx(ar, 'Now', 'الآن'), tx(ar, 'Cap', 'الحد')],
    ioPanels: [
      emptyIo('write', tx(ar, 'Write bandwidth', 'عرض الكتابة'), capLabel(resources?.ioWriteBps)),
      emptyIo('read', tx(ar, 'Read bandwidth', 'عرض القراءة'), capLabel(resources?.ioReadBps)),
    ],
    procTitle: tx(ar, 'Processes in your slice', 'العمليات في الشريحة'),
    procLedeHtml: processCount === null
      ? tx(ar, 'The process list is not part of this reading.', 'قائمة العمليات ليست ضمن هذه القراءة.')
      : tx(ar, `${processCount} tasks. Individual rows were not listed.`, `${processCount} مهام. الصفوف الفردية لم تُدرج.`),
    procHeaders: ['PID', tx(ar, 'Command and unit', 'الأمر والوحدة'), tx(ar, 'User', 'المستخدم'), tx(ar, 'CPU', 'المعالج'), tx(ar, 'Memory', 'الذاكرة'), tx(ar, 'Started (UTC)', 'البدء (UTC)')],
    procs: null,
    procEmptyTitle: tx(ar, 'Process list unavailable', 'قائمة العمليات غير متاحة'),
    procEmptyBody: processCount === null
      ? tx(ar, 'The agent did not return process rows. Your processes keep running; the list returns when a reading includes them.', 'لم يُرجع الوكيل صفوف العمليات. عملياتك تواصل العمل، وتعود القائمة عندما تتضمنها قراءة.')
      : tx(ar, 'The task count was read. The rows that make up that count were not.', 'قُرئ عدد المهام. الصفوف التي تكوّنه لم تُقرأ.'),
    identityTitleHtml: tx(ar, `Who serves ${monoSpan(account.primaryDomain, false)}`, `من يخدم ${monoSpan(account.primaryDomain, true)}`),
    identityLedeHtml: tx(ar,
      `Every request is meant to reach your files as ${monoSpan(account.username, false)}. The path was not read on this request.`,
      `كل طلب يصل إلى ملفاتك بصفة ${monoSpan(account.username, true)}. تفاصيل المسار لم تُقرأ في هذا الطلب.`),
    steps: [
      {
        titleHtml: `<span style="font-size: 14px; font-weight: 600">Nginx</span>`,
        pillHtml: `<span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${tx(ar, 'Not read', 'لم يُقرأ')}</span>`,
        bodyHtml: ltr(DASH, ar),
      },
      {
        titleHtml: `<span style="font-size: 14px; font-weight: 600">Apache</span>`,
        pillHtml: `<span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${tx(ar, 'Not read', 'لم يُقرأ')}</span>`,
        bodyHtml: ltr(DASH, ar),
      },
      {
        titleHtml: `<span style="font-size: 14px; font-weight: 600">${tx(ar, 'PHP pool', 'مجمّع PHP')} ${monoSpan(php === DASH ? DASH : (usage?.phpVersion ?? DASH), ar)}</span>`,
        pillHtml: `<span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: #EEF0F3; color: #344054; font-size: 12px; font-weight: 600">${tx(ar, 'Not read', 'لم يُقرأ')}</span>`,
        bodyHtml: ltr(php, ar),
      },
    ],
    vhostLabel: props.generationId && props.generationId > 0
      ? tx(ar, `Virtual host, generation ${props.generationId}`, `المضيف الافتراضي، الجيل ${props.generationId}`)
      : tx(ar, 'Virtual host', 'المضيف الافتراضي'),
    vhost: DASH,
    identityFacts: [
      { label: tx(ar, 'Home permissions', 'صلاحيات المنزل'), valueHtml: ltr(DASH, ar) },
      { label: 'open_basedir', valueHtml: ltr(DASH, ar) },
      { label: tx(ar, 'Private /tmp', 'مجلد tmp خاص'), valueHtml: ltr(DASH, ar) },
      { label: tx(ar, 'MariaDB user', 'مستخدم MariaDB'), valueHtml: ltr(DASH, ar) },
    ],
    verifiedHtml: tx(ar, 'A live request was not checked on this reading.', 'لم يُفحص طلب حي في هذه القراءة.'),
  }
}
