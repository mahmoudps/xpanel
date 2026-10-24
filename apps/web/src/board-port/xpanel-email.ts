import type { Limit } from '@xpanel/core'
import { ARABIC_TYPE_CSS, isArabicSentence } from '../arabic-type.ts'
import type { Locale } from '../i18n.ts'
import { t } from '../i18n.ts'
import { escapeHtml, formatAsciiNumber, renderStatusBadge } from '../tokens.ts'

/** Account fields this screen reads. Extra account fields from the panel are ignored. */
export interface EmailAccountFacts {
  username: string
  uid: number
  home: string
  primaryDomain: string
}

/** Plan fields this screen reads. Caps that the plan type does not store stay unknown. */
export interface EmailPlanFacts {
  name: string
  resources?: { diskMb?: Limit; maxProcesses?: Limit }
  caps?: { mailboxes?: Limit; ftpAccounts?: Limit; forwarders?: Limit }
  defaultMailboxQuotaMb?: Limit
}

export interface EmailServiceUserFacts {
  id: string
  login: string
  services: { email: boolean; ftp: boolean; webdisk: boolean }
  mailboxQuotaMb: Limit
  ftpDir: string
}

export interface EmailAccountsInput {
  locale?: Locale
  account: EmailAccountFacts
  plan?: EmailPlanFacts
  domains?: Array<{ id: string; name: string }>
  serviceUsers?: EmailServiceUserFacts[]
  /** Host sample. Absent means disk and process use stay unmeasured. */
  usage?: { diskBytes: number | null; processCount: number | null }
  signOutLabel?: string
}

const MONO = "'IBM Plex Mono', monospace"

const finite = (value: Limit | undefined): number | null => typeof value === 'number' ? value : null

const ltr = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

const prose = (value: string, ar: boolean): string =>
  ar && isArabicSentence(value) ? `<span class="xp-ar-sentence">${escapeHtml(value)}</span>` : escapeHtml(value)

const pendingWord = (ar: boolean): string => ar ? 'قيد التفعيل' : 'Coming soon'

const pending = (ar: boolean): string =>
  `<span class="xp-ar-sentence" style="font-family:${ar ? "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif" : 'inherit'}">${escapeHtml(pendingWord(ar))}</span>`

const mib = (value: number): string => `${formatAsciiNumber(value)} MiB`

const bytesAsMib = (bytes: number): string => {
  const value = bytes / (1024 * 1024)
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return mib(rounded)
}

const icon = (inner: string, size = 18): string =>
  `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none">${inner}</svg>`

const NAV: Array<{ en: string; ar: string; items: Array<{ href: string; en: string; ar: string; icon: string }> }> = [
  { en: 'General', ar: 'عام', items: [
    { href: '/home', en: 'Home', ar: 'الرئيسية', icon: '<path d="M3 11l9-7 9 7"></path><path d="M5 10v10h14V10"></path>' },
    { href: '/resources', en: 'Resources & quotas', ar: 'الموارد والحصص', icon: '<path d="M4 18a8 8 0 1 1 16 0"></path><path d="M12 18l4-5"></path>' },
  ] },
  { en: 'Files', ar: 'الملفات', items: [
    { href: '/files/manager', en: 'File manager', ar: 'مدير الملفات', icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>' },
    { href: '/files/backup', en: 'Backup wizard', ar: 'معالج النسخ الاحتياطي', icon: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10h14V9"></path><path d="M10 13h4"></path>' },
  ] },
  { en: 'Domains', ar: 'النطاقات', items: [
    { href: '/domains', en: 'Domains', ar: 'النطاقات', icon: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9s1.3-6.3 3.8-9z"></path>' },
    { href: '/domains/site-settings', en: 'Site settings', ar: 'إعدادات الموقع', icon: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"></path><circle cx="15" cy="6" r="2"></circle><circle cx="9" cy="12" r="2"></circle><circle cx="17" cy="18" r="2"></circle>' },
    { href: '/domains/zone-editor', en: 'Zone editor', ar: 'محرر المنطقة', icon: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>' },
  ] },
  { en: 'Databases', ar: 'قواعد البيانات', items: [
    { href: '/databases/mariadb', en: 'MariaDB', ar: 'MariaDB', icon: '<ellipse cx="12" cy="6" rx="8" ry="3"></ellipse><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>' },
  ] },
  { en: 'Email', ar: 'البريد', items: [
    { href: '/email/accounts', en: 'Email & users', ar: 'البريد والمستخدمون', icon: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20a6.5 6.5 0 0 1 13 0"></path><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"></path><path d="M18.5 14.5a6.5 6.5 0 0 1 3 5.5"></path>' },
    { href: '/mail/inbox', en: 'xMail', ar: 'xMail', icon: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path>' },
  ] },
  { en: 'Software', ar: 'البرمجيات', items: [
    { href: '/software/php', en: 'PHP', ar: 'PHP', icon: '<path d="M8 8l-4 4 4 4"></path><path d="M16 8l4 4-4 4"></path>' },
    { href: '/software/htaccess', en: '.htaccess', ar: '.htaccess', icon: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h4"></path>' },
  ] },
  { en: 'Advanced', ar: 'متقدم', items: [
    { href: '/advanced/cron', en: 'Cron jobs', ar: 'مهام Cron', icon: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>' },
    { href: '/metrics/traffic', en: 'Metrics', ar: 'المقاييس', icon: '<path d="M3 20h18"></path><path d="M7 16v-4M12 16V7M17 16v-6"></path>' },
  ] },
  { en: 'Security', ar: 'الأمان', items: [
    { href: '/security/ssl', en: 'SSL/TLS', ar: 'SSL/TLS', icon: '<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>' },
    { href: '/security/account', en: 'Security', ar: 'الأمان', icon: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"></path>' },
  ] },
]

const PORT_CSS = `.xp-board-port{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:antialiased}
.xp-board-port a{color:#1D5BD6}.xp-board-port a:hover{color:#1546A8}
.xp-board-port :focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
.xp-board-port p{max-inline-size:none}
.xp-board-port select,.xp-board-port option{font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif !important}
html[lang="ar"] .xp-board-port select,html[lang="ar"] .xp-board-port option,.xp-board-port[dir=rtl] select,.xp-board-port[dir=rtl] option{font-family:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif !important}
.xp-email-scroll{position:relative;max-width:100%}
@media (max-width:390px){
  .xp-board-port{max-width:100%}
  .xp-board-port > nav,.xp-board-port > main{flex-basis:100% !important;max-width:100%;min-width:0}
  .xp-email-scroll{max-width:100%;min-width:0}
  #create-user, #create-user form, #create-user fieldset, #create-user [data-login-row]{min-width:0 !important;max-width:100%}
  .xp-board-port [data-wrap], .xp-board-port #new-local-help, .xp-board-port #new-local-help code{min-width:0;max-width:100%;overflow-wrap:anywhere;white-space:normal !important}
  .xp-board-port select{max-width:100%;min-width:0}
  html[lang="ar"] .xp-board-port bdi[dir="ltr"],.xp-board-port[dir=rtl] bdi[dir="ltr"]{white-space:normal !important;overflow-wrap:anywhere !important;overflow:hidden !important;flex-shrink:1 !important;min-width:0 !important;max-width:100%}
}
${ARABIC_TYPE_CSS}`

const capText = (cap: Limit | undefined, ar: boolean): string => {
  if (cap === 'unlimited') return ar ? 'بلا حد' : 'Unlimited'
  if (typeof cap === 'number') return `${ar ? 'من' : 'of'} ${formatAsciiNumber(cap)}`
  return '—'
}

const limitCard = (label: string, used: number | null, cap: Limit | undefined, note: string, ar: boolean): string => {
  const known = used !== null && typeof cap === 'number' && cap > 0
  const width = known ? `${Math.max(0, Math.min(100, Math.round((used / cap) * 100)))}%` : '0%'
  const usedHtml = used === null ? '—' : ltr(formatAsciiNumber(used))
  const capHtml = cap === 'unlimited'
    ? prose(ar ? 'بلا حد' : 'Unlimited', ar)
    : typeof cap === 'number' ? ltr(capText(cap, ar)) : '—'
  return `<div style="flex:1 1 200px;min-width:0;display:flex;flex-direction:column;gap:8px;padding:20px;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC">
    <span style="font-size:13px;font-weight:600;color:#475467">${escapeHtml(label)}</span>
    <span style="font-size:24px;font-weight:600;font-variant-numeric:tabular-nums">${usedHtml} <span style="font-size:14px;font-weight:500;color:#475467">${capHtml}</span></span>
    <div aria-hidden="true" style="height:8px;border-radius:4px;background:#E9ECF1;overflow:hidden"><div style="height:8px;width:${width};background:#1D5BD6;border-radius:4px"></div></div>
    <span style="font-size:12px;font-weight:500;color:#5D6B7E">${note}</span>
  </div>`
}

const sideMeter = (label: string, valueHtml: string, width: string): string =>
  `<div style="display:flex;flex-direction:column;gap:4px">
    <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px"><span style="color:#475467">${escapeHtml(label)}</span><span data-wrap style="color:#344054;font-variant-numeric:tabular-nums;min-width:0">${valueHtml}</span></div>
    <div aria-hidden="true" style="height:6px;border-radius:3px;background:#E9ECF1;overflow:hidden"><div style="height:6px;width:${width};background:#1D5BD6;border-radius:3px"></div></div>
  </div>`

const measuredWidth = (used: number | null, cap: number | null): string =>
  used !== null && cap !== null && cap > 0 ? `${Math.max(0, Math.min(100, Math.round((used / cap) * 100)))}%` : '0%'

const chip = (label: string): string =>
  `<span style="display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;background:#EEF0F3;color:#344054;font-size:12px;font-weight:600;white-space:nowrap">${escapeHtml(label)}</span>`

const switchRow = (key: string, name: string, desc: string, on: boolean): string => {
  const border = on ? '#C7D7F8' : '#E2E6EC'
  const bg = on ? '#F3F7FE' : '#FFFFFF'
  const track = on ? '#1D5BD6' : '#7A8699'
  const knob = on ? '31px' : '7px'
  const state = on ? '#1D5BD6' : '#475467'
  return `<div data-service-row="${key}" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 8px 8px 14px;border-radius:10px;border:1px solid ${border};background:${bg}">
    <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
      <span id="svc-${key}" style="font-size:14px;font-weight:600">${escapeHtml(name)}</span>
      <span id="svc-${key}-desc" style="font-size:12px;font-weight:500;color:#5D6B7E;line-height:1.5">${desc}</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none">
      <span data-service-state style="font-size:12px;font-weight:600;color:${state};min-width:24px;text-align:end"></span>
      <button type="button" role="switch" data-service-choice="${key}" aria-checked="${on ? 'true' : 'false'}" aria-labelledby="svc-${key}" aria-describedby="svc-${key}-desc" style="position:relative;width:56px;height:44px;border:none;border-radius:8px;background:transparent;padding:0">
        <span aria-hidden="true" data-service-track style="position:absolute;top:10px;inset-inline-start:4px;width:48px;height:24px;border-radius:999px;background:${track}"></span>
        <span aria-hidden="true" data-service-knob style="position:absolute;top:13px;inset-inline-start:${knob};width:18px;height:18px;border-radius:50%;background:#FFFFFF"></span>
      </button>
    </div>
  </div>`
}

const fieldButton = (label: string, extra = ''): string =>
  `<button type="button" style="min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#101828;font-family:inherit;font-size:14px;font-weight:600"${extra}>${escapeHtml(label)}</button>`

const primaryButton = (label: string, extra = ''): string =>
  `<button type="submit" style="min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #1D5BD6;background:#1D5BD6;color:#FFFFFF;font-family:inherit;font-size:14px;font-weight:600"${extra}>${escapeHtml(label)}</button>`

const soonPanel = (id: string, title: string, copy: string, ar: boolean): string =>
  `<div role="tabpanel" id="panel-${id}" data-email-panel="${id}" aria-labelledby="tab-${id}" hidden style="display:none">
    <section style="display:flex;flex-direction:column;gap:12px;padding:20px 24px;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC;max-width:720px">
      <h2 style="margin:0;font-size:16px;font-weight:600">${escapeHtml(title)}</h2>
      <p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:13px;color:#475467;line-height:1.6">${prose(copy, ar)}</p>
      <button type="button" disabled aria-disabled="true" style="align-self:flex-start;min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #E2E6EC;background:#F0F2F5;color:#5D6B7E;font-family:inherit;font-size:14px;font-weight:600">${escapeHtml(pendingWord(ar))}</button>
    </section>
  </div>`

const clientScript = (): string => `<script>
(function () {
  var root = document.querySelector('[data-board-port="xpanel-email"]');
  if (!root) return;
  var ar = document.documentElement.lang === 'ar';
  function paintTab(button, on) {
    button.setAttribute('aria-selected', on ? 'true' : 'false');
    button.style.borderBottomColor = on ? '#1D5BD6' : 'transparent';
    button.style.color = on ? '#1D5BD6' : '#475467';
    button.style.fontWeight = on ? '600' : '500';
  }
  root.querySelectorAll('[data-email-tab]').forEach(function (button) {
    button.addEventListener('click', function () {
      var key = button.getAttribute('data-email-tab');
      root.querySelectorAll('[data-email-tab]').forEach(function (item) { paintTab(item, item === button); });
      root.querySelectorAll('[data-email-panel]').forEach(function (panel) {
        var show = panel.getAttribute('data-email-panel') === key;
        panel.hidden = !show;
        panel.style.display = show ? 'flex' : 'none';
      });
    });
  });
  var filter = 'all';
  function applyRows() {
    var query = (root.querySelector('[data-user-query]') || {}).value || '';
    query = String(query).trim().toLowerCase();
    var shown = 0;
    root.querySelectorAll('[data-service-row-login]').forEach(function (row) {
      var services = (row.getAttribute('data-services') || '').split(' ');
      var login = row.getAttribute('data-service-row-login') || '';
      var ok = (filter === 'all' || services.indexOf(filter) >= 0) && (!query || login.indexOf(query) >= 0);
      row.hidden = !ok;
      row.style.display = ok ? '' : 'none';
      if (ok) shown += 1;
    });
    var empty = root.querySelector('[data-email-empty]');
    if (empty) { empty.hidden = shown !== 0; empty.style.display = shown === 0 ? '' : 'none'; }
  }
  root.querySelectorAll('[data-user-filter]').forEach(function (button) {
    button.addEventListener('click', function () {
      filter = button.getAttribute('data-user-filter') || 'all';
      root.querySelectorAll('[data-user-filter]').forEach(function (item) {
        var on = item === button;
        item.setAttribute('aria-pressed', on ? 'true' : 'false');
        item.style.background = on ? '#FFFFFF' : 'transparent';
        item.style.color = on ? '#1D5BD6' : '#344054';
        item.style.borderColor = on ? '#C7D7F8' : 'transparent';
        item.style.fontWeight = on ? '600' : '500';
      });
      applyRows();
    });
  });
  var query = root.querySelector('[data-user-query]');
  if (query) query.addEventListener('input', applyRows);
  function checked(name) {
    var el = root.querySelector('[data-service-choice="' + name + '"]');
    return !!(el && el.getAttribute('aria-checked') === 'true');
  }
  function paintSwitch(button) {
    var on = button.getAttribute('aria-checked') === 'true';
    var row = button.closest('[data-service-row]');
    if (!row) return;
    row.style.borderColor = on ? '#C7D7F8' : '#E2E6EC';
    row.style.background = on ? '#F3F7FE' : '#FFFFFF';
    var track = button.querySelector('[data-service-track]');
    var knob = button.querySelector('[data-service-knob]');
    var state = row.querySelector('[data-service-state]');
    if (track) track.style.background = on ? '#1D5BD6' : '#7A8699';
    if (knob) knob.style.insetInlineStart = on ? '31px' : '7px';
    if (state) { state.textContent = on ? (ar ? 'تشغيل' : 'On') : (ar ? 'إيقاف' : 'Off'); state.style.color = on ? '#1D5BD6' : '#475467'; }
  }
  function syncServices() {
    var email = checked('email');
    var files = checked('ftp') || checked('webdisk');
    var mailbox = root.querySelector('[data-mailbox-fields]');
    var dir = root.querySelector('[data-dir-fields]');
    if (mailbox) { mailbox.hidden = !email; mailbox.style.display = email ? 'flex' : 'none'; }
    if (dir) { dir.hidden = !files; dir.style.display = files ? 'flex' : 'none'; }
    var quota = root.querySelector('#mailbox-quota');
    var unlimited = root.querySelector('[data-quota-unlimited]');
    if (quota) quota.required = email && !(unlimited && unlimited.checked);
  }
  root.querySelectorAll('[data-service-choice]').forEach(function (button) {
    paintSwitch(button);
    button.addEventListener('click', function () {
      button.setAttribute('aria-checked', button.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
      paintSwitch(button);
      syncServices();
    });
  });
  var unlimited = root.querySelector('[data-quota-unlimited]');
  var quota = root.querySelector('#mailbox-quota');
  function paintQuota() {
    var on = !!(unlimited && unlimited.checked);
    if (quota) { quota.disabled = on; quota.required = checked('email') && !on; }
  }
  if (unlimited) unlimited.addEventListener('change', paintQuota);
  paintQuota();
  function preview() {
    var local = root.querySelector('#mailbox-local');
    var domain = root.querySelector('#mailbox-domain');
    var out = root.querySelector('[data-login-preview]');
    if (!local || !out) return;
    var name = (local.value || (ar ? 'اسم' : 'name')).trim().toLowerCase();
    var host = domain && domain.selectedOptions && domain.selectedOptions[0] ? domain.selectedOptions[0].textContent : '';
    out.textContent = host ? name + '@' + host : name;
  }
  var local = root.querySelector('#mailbox-local');
  var domain = root.querySelector('#mailbox-domain');
  if (local) local.addEventListener('input', preview);
  if (domain) domain.addEventListener('change', preview);
  preview();
  var generate = root.querySelector('[data-generate-password]');
  if (generate) generate.addEventListener('click', function () {
    var input = root.querySelector('#mailbox-password');
    if (!input || !window.crypto || !window.crypto.getRandomValues) return;
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    var chars = '';
    for (var i = 0; i < bytes.length; i += 1) chars += alphabet[bytes[i] % alphabet.length];
    input.value = chars;
    input.type = 'text';
  });
  var form = root.querySelector('[data-mailbox-form]');
  if (form) form.addEventListener('submit', function (event) {
    if (checked('email') || checked('ftp') || checked('webdisk')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    var status = form.querySelector('[data-mailbox-status]');
    if (!status) return;
    status.hidden = false;
    status.textContent = ar ? 'شغّل خدمة واحدة على الأقل.' : 'Turn on at least one service.';
  }, true);
  syncServices();
})();
</script>`

export const renderXpanelEmail = (input: EmailAccountsInput): string => {
  const ar = input.locale === 'ar'
  const sans = ar
    ? "'IBM Plex Sans Arabic', 'IBM Plex Sans', system-ui, sans-serif"
    : "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
  const account = input.account
  const plan = input.plan
  const domains = input.domains ?? []
  const users = [...(input.serviceUsers ?? [])].sort((a, b) => a.login.localeCompare(b.login))
  const emailCount = users.filter(user => user.services.email).length
  const ftpCount = users.filter(user => user.services.ftp).length
  const webCount = users.filter(user => user.services.webdisk).length
  const diskCap = finite(plan?.resources?.diskMb)
  const processCap = finite(plan?.resources?.maxProcesses)
  const diskUsed = input.usage?.diskBytes ?? null
  const processUsed = input.usage?.processCount ?? null
  const diskCapBytes = diskCap === null ? null : diskCap * 1024 * 1024
  const unmeasured = ar ? 'لم يُقاس بعد' : 'not measured yet'
  const diskValue = diskUsed === null
    ? `${ltr('—')} / ${plan?.resources?.diskMb === 'unlimited' ? prose(ar ? 'بلا حد' : 'Unlimited', ar) : diskCap === null ? '—' : ltr(mib(diskCap))}`
    : `${ltr(bytesAsMib(diskUsed))} / ${plan?.resources?.diskMb === 'unlimited' ? prose(ar ? 'بلا حد' : 'Unlimited', ar) : diskCap === null ? '—' : ltr(mib(diskCap))}`
  const processValue = processUsed === null
    ? `${ltr('—')} / ${plan?.resources?.maxProcesses === 'unlimited' ? prose(ar ? 'بلا حد' : 'Unlimited', ar) : processCap === null ? '—' : ltr(formatAsciiNumber(processCap))}`
    : `${ltr(formatAsciiNumber(processUsed))} / ${plan?.resources?.maxProcesses === 'unlimited' ? prose(ar ? 'بلا حد' : 'Unlimited', ar) : processCap === null ? '—' : ltr(formatAsciiNumber(processCap))}`
  const mailboxCap = plan?.caps?.mailboxes
  const ftpCap = plan?.caps?.ftpAccounts
  const forwarderCap = plan?.caps?.forwarders
  const preset = plan?.defaultMailboxQuotaMb
  const quotaUnlimited = preset === 'unlimited'
  const quotaValue = typeof preset === 'number' ? String(preset) : quotaUnlimited ? '' : '1024'
  const homePrefix = account.home.endsWith('/') ? account.home : `${account.home}/`
  const slice = `xpanel-${account.uid}.slice`
  const initial = account.username.slice(0, 1) || '?'
  const domainOptions = domains.length > 0
    ? domains.map(domain => `<option value="${escapeHtml(domain.id)}">${escapeHtml(domain.name)}</option>`).join('')
    : `<option value="" disabled selected>${escapeHtml(ar ? 'لا توجد نطاقات' : 'No domains')}</option>`
  const firstDomain = domains[0]?.name ?? ''
  const preview = firstDomain ? `name@${firstDomain}` : 'name'
  const quotaHelp = typeof preset === 'number'
    ? (ar ? `الحصة الافتراضية في الخطة ${formatAsciiNumber(preset)} MiB، ولا تتجاوز حصة القرص.` : `The plan default is ${formatAsciiNumber(preset)} MiB, and it cannot exceed the account disk quota.`)
    : preset === 'unlimited'
      ? (ar ? 'الحصة الافتراضية في الخطة بلا حد، ضمن حصة القرص.' : 'The plan default mailbox quota is unlimited, within the account disk quota.')
      : (ar ? 'يرسل النموذج 1024 MiB. يستخدم الخادم هذا الرقم عندما يُحذف الحقل.' : 'This form sends 1024 MiB. The server uses that number when the field is omitted.')
  const filters: Array<{ key: string; label: string }> = [
    { key: 'all', label: `${ar ? 'الكل' : 'All'} ${formatAsciiNumber(users.length)}` },
    { key: 'email', label: `${ar ? 'البريد' : 'Email'} ${formatAsciiNumber(emailCount)}` },
    { key: 'ftp', label: `FTP ${formatAsciiNumber(ftpCount)}` },
    { key: 'webdisk', label: `${ar ? 'قرص الويب' : 'Web Disk'} ${formatAsciiNumber(webCount)}` },
  ]
  const rows = users.map(user => {
    const services = [
      user.services.email ? 'email' : '',
      user.services.ftp ? 'ftp' : '',
      user.services.webdisk ? 'webdisk' : '',
    ].filter(Boolean)
    const chips = [
      user.services.email ? chip(ar ? 'البريد' : 'Email') : '',
      user.services.ftp ? chip('FTP') : '',
      user.services.webdisk ? chip(ar ? 'قرص الويب' : 'Web Disk') : '',
    ].join('')
    const limitHtml = user.mailboxQuotaMb === 'unlimited'
      ? prose(ar ? 'بلا حد' : 'Unlimited', ar)
      : ltr(mib(user.mailboxQuotaMb))
    const mailbox = user.services.email
      ? `<div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:13px"><span>${limitHtml}</span>${pending(ar)}</div>
          <div aria-hidden="true" style="height:6px;border-radius:3px;background:#E9ECF1;overflow:hidden"><div style="height:6px;width:0;background:#1D5BD6;border-radius:3px"></div></div>
        </div>`
      : `<span style="font-size:13px;color:#5D6B7E">${escapeHtml(ar ? 'لا صندوق بريد' : 'No mailbox')}</span>`
    const directory = user.services.ftp || user.services.webdisk
      ? ltr(user.ftpDir === '' ? account.home : `${homePrefix}${user.ftpDir}`)
      : `<span style="font-size:13px;color:#5D6B7E">${escapeHtml(ar ? 'لا وصول للملفات' : 'No file access')}</span>`
    const quotaButton = user.services.email
      ? `<button type="button" data-mailbox-quota="${escapeHtml(user.id)}"${typeof user.mailboxQuotaMb === 'number' ? ` data-mailbox-quota-value="${user.mailboxQuotaMb}"` : ''} style="min-height:44px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:#1D5BD6;font-family:inherit;font-size:14px;font-weight:600">${escapeHtml(ar ? 'الحصة' : 'Quota')}</button>`
      : ''
    return `<tr data-service-row-login="${escapeHtml(user.login.toLowerCase())}" data-services="${services.join(' ')}" style="border-top:1px solid #EEF0F3">
      <td style="padding:10px 16px;line-height:1.4"><span style="font-family:${MONO};font-weight:600">${ltr(user.login)}</span></td>
      <td style="padding:10px 16px"><div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div></td>
      <td style="padding:10px 16px">${mailbox}</td>
      <td style="padding:10px 16px">${directory}</td>
      <td style="padding:10px 16px">${pending(ar)}</td>
      <td style="padding:0 8px"><div style="display:flex;justify-content:flex-end;flex-wrap:wrap;gap:4px">
        <button type="button" data-mailbox-password="${escapeHtml(user.id)}" aria-label="${escapeHtml(ar ? `كلمة المرور ${user.login}` : `Password for ${user.login}`)}" style="min-height:44px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:#1D5BD6;font-family:inherit;font-size:14px;font-weight:600">${escapeHtml(ar ? 'كلمة المرور' : 'Password')}</button>
        ${quotaButton}
        <button type="button" data-remove-mailbox="${escapeHtml(user.id)}" aria-label="${escapeHtml(ar ? `حذف ${user.login}` : `Delete ${user.login}`)}" style="min-height:44px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:#B42318;font-family:inherit;font-size:14px;font-weight:600">${escapeHtml(ar ? 'حذف' : 'Delete')}</button>
      </div></td>
    </tr>`
  }).join('')
  const nav = NAV.map(group => `<div style="display:flex;flex-direction:column;gap:2px">
    <p style="margin:0;padding:0 12px 4px;font-size:11px;font-weight:600;color:#5D6B7E">${escapeHtml(ar ? group.ar : group.en)}</p>
    ${group.items.map(item => {
      const current = item.href === '/email/accounts'
      return `<a href="${item.href}"${current ? ' aria-current="page"' : ''} style="display:flex;align-items:center;gap:10px;min-height:40px;padding:0 12px;border-radius:8px;text-decoration:none;font-size:14px;${current ? 'background:#E8EFFD;color:#1D5BD6;font-weight:600' : 'color:#344054'}">${icon(item.icon)}<span>${escapeHtml(ar ? item.ar : item.en)}</span></a>`
    }).join('')}
  </div>`).join('')
  const ftpLeft = typeof ftpCap === 'number' ? Math.max(0, ftpCap - ftpCount) : null
  const ftpNote = ftpLeft !== null
    ? (ar ? `${prose('متبقٍ على الخطة', ar)} ${ltr(formatAsciiNumber(ftpLeft))}` : `${ltr(formatAsciiNumber(ftpLeft))} left on this plan`)
    : prose(ftpCap === 'unlimited' ? (ar ? 'الخطة لا تضع حدًا عدديًا.' : 'The plan sets no finite cap.') : unmeasured, ar)
  return `<div class="xp-board-port" data-board-port="xpanel-email" dir="${ar ? 'rtl' : 'ltr'}" style="min-height:100vh;display:flex;flex-wrap:wrap;background:#F5F6F8;font-family:${sans};color:#101828">
<style>${PORT_CSS}</style>
<nav aria-label="${ar ? 'تنقل xPanel' : 'xPanel navigation'}" style="flex:1 1 248px;max-width:100%;background:#FFFFFF;border-inline-end:1px solid #E2E6EC;padding:20px 14px;display:flex;flex-direction:column;gap:16px">
  <a href="/home" style="display:flex;align-items:center;gap:10px;padding:0 4px;text-decoration:none">
    <span aria-hidden="true" style="width:36px;height:36px;border-radius:8px;background:#101828;color:#FFFFFF;display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:18px;font-weight:500">x</span>
    <span style="font-family:${MONO};font-size:17px;font-weight:500;color:#1D5BD6">xPanel</span>
  </a>
  <div style="display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;border:1px solid #E2E6EC;background:#F8F9FB">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span data-wrap style="font-family:${MONO};font-size:14px;font-weight:600;min-width:0;max-width:100%;overflow-wrap:anywhere">${ltr(account.username)}</span>
        <span data-wrap style="font-family:${MONO};font-size:12px;color:#5D6B7E;min-width:0;max-width:100%;overflow-wrap:anywhere">${ltr(account.primaryDomain)}</span>
      </div>
      <span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:#EEF0F3;color:#344054;font-size:12px;font-weight:600;max-width:100%;overflow-wrap:anywhere">${plan ? ltr(plan.name) : '—'}</span>
    </div>
    ${sideMeter(ar ? 'القرص' : 'Disk', diskValue, measuredWidth(diskUsed, diskCapBytes))}
    ${sideMeter(ar ? 'العمليات' : 'Processes', processValue, measuredWidth(processUsed, processCap))}
  </div>
  ${nav}
</nav>
<main id="main-content" style="flex:999 1 560px;min-width:0;display:flex;flex-direction:column">
  <header style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:12px clamp(16px, 4vw, 32px);background:#FFFFFF;border-bottom:1px solid #E2E6EC">
    <button type="button" data-action="open-cmdk" aria-label="${ar ? 'ابحث عن أداة' : 'Find a tool'}" style="position:relative;flex:1 1 260px;max-width:420px;min-height:40px;display:flex;align-items:center;gap:8px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#F8F9FB;color:#101828;font-family:inherit;font-size:14px;text-align:start">
      ${icon('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>')}
      <span style="flex:1">${escapeHtml(ar ? 'ابحث عن أداة' : 'Find a tool')}</span>
      <kbd style="min-width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid #D0D5DD;background:#FFFFFF;font-family:${MONO};font-size:12px;color:#475467">Ctrl K</kbd>
    </button>
    <div style="flex:1 1 0"></div>
    <span data-wrap style="display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:4px 10px;border-radius:999px;background:#EEF0F3;color:#344054;font-size:12px;font-weight:600;font-family:${MONO};overflow-wrap:anywhere">${ltr(account.primaryDomain)}</span>
    <a href="?lang=${ar ? 'en' : 'ar'}" lang="${ar ? 'en' : 'ar'}" hreflang="${ar ? 'en' : 'ar'}" style="display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 10px;border-radius:8px;font-size:14px;font-weight:500;color:#1D5BD6;text-decoration:none">${ar ? 'English' : 'العربية'}</a>
    <button type="button" data-action="logout" aria-label="${escapeHtml(input.signOutLabel ?? (ar ? 'تسجيل الخروج' : 'Sign out'))}" style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:1px solid #D0D5DD;background:#FFFFFF;padding:0">
      <span aria-hidden="true" style="width:32px;height:32px;border-radius:50%;background:#E8EFFD;color:#1D5BD6;display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:14px;font-weight:600">${escapeHtml(initial)}</span>
    </button>
  </header>
  <div style="width:100%;max-width:1180px;margin:0 auto;padding:24px clamp(16px, 4vw, 32px) 52px;display:flex;flex-direction:column;gap:24px">
    <div style="display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px">
      <div style="display:flex;flex-direction:column;gap:6px;min-width:0">
        <nav aria-label="${ar ? 'مسار التنقل' : 'Breadcrumb'}">
          <ol style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:#5D6B7E">
            <li><a href="/home" style="color:#5D6B7E">${ar ? 'الرئيسية' : 'Home'}</a></li>
            <li aria-hidden="true">/</li>
            <li>${ar ? 'البريد' : 'Email'}</li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" style="color:#344054">${ar ? 'البريد والمستخدمون' : 'Email & users'}</li>
          </ol>
        </nav>
        <h1 class="xp-page-title" style="margin:0;font-size:22px;font-weight:600">${ar ? 'البريد ومستخدمو الخدمة' : 'Email and service users'}</h1>
        <p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:14px;color:#475467;line-height:1.6;max-width:68ch">${ar
          ? `دخول واحد لكل شخص للبريد وFTP وقرص الويب. يعمل كل مستخدم بحساب ${ltr(account.username)} (${ltr(`uid ${formatAsciiNumber(account.uid)}`)} )، ولا يدخل إلى xPanel.`
          : `One login per person for email, FTP and Web Disk. Every user runs as ${ltr(account.username)} (${ltr(`uid ${formatAsciiNumber(account.uid)}`)}) and cannot sign in to xPanel.`}</p>
      </div>
      <a href="#create-user" style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #1D5BD6;background:#1D5BD6;color:#FFFFFF;font-size:14px;font-weight:600;text-decoration:none">${icon('<path d="M12 5v14M5 12h14"></path>')} ${ar ? 'إنشاء مستخدم' : 'Create user'}</a>
    </div>
    <section aria-label="${ar ? 'حدود الخطة' : 'Plan limits'}" style="display:flex;flex-wrap:wrap;gap:16px">
      ${limitCard(ar ? 'صناديق البريد' : 'Mailboxes', emailCount, mailboxCap, prose(ar ? 'حجم البريد لم يُقاس بعد.' : 'Mailbox size is not measured yet.', ar), ar)}
      ${limitCard(ar ? 'حسابات FTP' : 'FTP accounts', ftpCount, ftpCap, ftpNote, ar)}
      ${limitCard(ar ? 'مستخدمو قرص الويب' : 'Web Disk users', webCount, undefined, prose(ar ? 'الخطة لا تحفظ حدًا لقرص الويب.' : 'The plan stores no Web Disk cap.', ar), ar)}
      ${limitCard(ar ? 'إعادة التوجيه' : 'Forwarders', null, forwarderCap, prose(ar ? 'قائمة إعادة التوجيه غير محمّلة.' : 'The forwarder list is not loaded.', ar), ar)}
    </section>
    <div style="display:flex;flex-direction:column;gap:16px">
      <div role="tablist" aria-label="${ar ? 'أقسام البريد والمستخدمين' : 'Email and users sections'}" style="display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #E2E6EC">
        <button type="button" role="tab" id="tab-users" data-email-tab="users" aria-controls="panel-users" aria-selected="true" style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:none;border-bottom:2px solid #1D5BD6;background:transparent;color:#1D5BD6;font-family:inherit;font-size:14px;font-weight:600">${ar ? 'المستخدمون' : 'Users'}<span style="padding:1px 8px;border-radius:999px;background:#E8EFFD;color:#1D5BD6;font-size:12px;font-weight:600">${ltr(formatAsciiNumber(users.length))}</span></button>
        <button type="button" role="tab" id="tab-forwarders" data-email-tab="forwarders" aria-controls="panel-forwarders" aria-selected="false" style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;color:#475467;font-family:inherit;font-size:14px;font-weight:500">${ar ? 'إعادة التوجيه' : 'Forwarders'}</button>
        <button type="button" role="tab" id="tab-auto" data-email-tab="auto" aria-controls="panel-auto" aria-selected="false" style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;color:#475467;font-family:inherit;font-size:14px;font-weight:500">${ar ? 'الردود الآلية' : 'Autoresponders'}</button>
        <button type="button" role="tab" id="tab-default" data-email-tab="default" aria-controls="panel-default" aria-selected="false" style="display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 14px;border:none;border-bottom:2px solid transparent;background:transparent;color:#475467;font-family:inherit;font-size:14px;font-weight:500">${ar ? 'العنوان الافتراضي' : 'Default address'}</button>
      </div>
      <div role="tabpanel" id="panel-users" data-email-panel="users" aria-labelledby="tab-users" style="display:flex;flex-direction:column;gap:24px">
        <section aria-labelledby="users-title" style="display:flex;flex-direction:column;min-width:0;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC">
          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:20px 24px">
            <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
              <h2 id="users-title" style="margin:0;font-size:16px;font-weight:600">${ar ? 'المستخدمون' : 'Users'}</h2>
              <p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:13px;color:#475467;line-height:1.6">${ar
                ? `${ltr(formatAsciiNumber(users.length))} تسجيلات دخول للخدمات على هذا الحساب، مرتبة حسب اسم الدخول.`
                : `${ltr(formatAsciiNumber(users.length))} service logins on this account, sorted by login.`}</p>
              ${renderStatusBadge('ok', t(ar ? 'ar' : 'en', 'email.serviceLogins', { count: users.length }))}
            </div>
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
              <div role="group" aria-label="${ar ? 'إظهار المستخدمين' : 'Show users with'}" style="display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:10px;background:#F0F2F5">
                ${filters.map((item, index) => `<button type="button" data-user-filter="${item.key}" aria-pressed="${index === 0 ? 'true' : 'false'}" style="min-height:44px;padding:0 12px;border-radius:8px;border:1px solid ${index === 0 ? '#C7D7F8' : 'transparent'};background:${index === 0 ? '#FFFFFF' : 'transparent'};color:${index === 0 ? '#1D5BD6' : '#344054'};font-family:inherit;font-size:13px;font-weight:${index === 0 ? '600' : '500'}">${escapeHtml(item.label)}</button>`).join('')}
              </div>
              <div style="position:relative;flex:0 1 240px;min-width:0;display:flex;align-items:center">
                ${icon('<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>', 16).replace('style="flex:none"', 'style="position:absolute;inset-inline-start:12px;pointer-events:none;flex:none"')}
                <input data-user-query type="search" aria-label="${ar ? 'تصفية المستخدمين باسم الدخول' : 'Filter users by login'}" placeholder="${ar ? 'تصفية باسم الدخول' : 'Filter by login'}" style="width:100%;min-height:44px;padding-block:0;padding-inline:36px 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;font-family:inherit;font-size:14px;color:#101828">
              </div>
            </div>
          </div>
          <div class="xp-email-scroll" style="overflow-x:auto;border-top:1px solid #E2E6EC;position:relative">
            <table aria-labelledby="users-title" style="width:100%;border-collapse:collapse;font-size:14px;min-width:1000px">
              <thead><tr style="background:#F8F9FB">
                <th scope="col" style="text-align:start;padding:12px 16px;font-size:12px;font-weight:600;color:#475467">${ar ? 'تسجيل الدخول' : 'Login'}</th>
                <th scope="col" style="text-align:start;padding:12px 16px;font-size:12px;font-weight:600;color:#475467">${ar ? 'الخدمات' : 'Services'}</th>
                <th scope="col" style="text-align:start;padding:12px 16px;font-size:12px;font-weight:600;color:#475467;width:200px">${ar ? 'حصة صندوق البريد' : 'Mailbox quota'}</th>
                <th scope="col" style="text-align:start;padding:12px 16px;font-size:12px;font-weight:600;color:#475467">${ar ? 'دليل الملفات' : 'FTP and Web Disk directory'}</th>
                <th scope="col" style="text-align:start;padding:12px 16px;font-size:12px;font-weight:600;color:#475467">${ar ? 'آخر دخول' : 'Last sign-in'}</th>
                <th scope="col" style="text-align:end;padding:12px 16px;font-size:12px;font-weight:600;color:#475467">${ar ? 'الإجراءات' : 'Actions'}</th>
              </tr></thead>
              <tbody>
                ${rows}
                <tr data-email-empty ${users.length > 0 ? 'hidden style="display:none"' : 'style="border-top:1px solid #EEF0F3"'}><td colspan="6" style="padding:24px 16px;text-align:center;font-size:13px;color:#5D6B7E">${escapeHtml(users.length > 0 ? (ar ? 'لا مستخدمين يطابقون هذا التصفية.' : 'No users match this filter.') : (ar ? 'لا مستخدمي خدمة بعد.' : 'No service users yet.'))}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
        <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start">
          <section id="create-user" aria-labelledby="create-title" style="flex:1.618 1 0;min-width:min(100%, 360px);display:flex;flex-direction:column;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC">
            <form data-mailbox-form="true" style="display:flex;flex-direction:column">
              <div style="display:flex;flex-direction:column;gap:4px;padding:20px 24px 16px">
                <h2 id="create-title" style="margin:0;font-size:16px;font-weight:600">${ar ? 'إنشاء مستخدم' : 'Create a user'}</h2>
                <p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:13px;color:#475467;line-height:1.6;max-width:68ch">${prose(ar ? 'اختر الخدمات التي يحتاجها هذا الشخص. يمكن تشغيل خدمة أو إيقافها لاحقًا دون تغيير كلمة المرور.' : 'Pick the services this person needs. You can turn services on or off later without changing the password.', ar)}</p>
              </div>
              <div style="display:flex;flex-direction:column;gap:24px;padding:0 24px 24px">
                <fieldset style="margin:0;padding:0;border:none;display:flex;flex-direction:column;gap:16px">
                  <legend style="padding:0 0 12px;font-size:14px;font-weight:600">${ar ? 'تسجيل الدخول' : 'Login'}</legend>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <label for="mailbox-local" style="font-size:13px;font-weight:600">${ar ? 'اسم المستخدم' : 'Username'}</label>
                    <div data-login-row style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;max-width:100%">
                      <input id="mailbox-local" name="localPart" type="text" autocomplete="off" spellcheck="false" required pattern="[a-z0-9][a-z0-9._-]{0,63}" maxlength="64" style="flex:1 1 160px;min-width:0;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;font-family:${MONO};font-size:14px;color:#101828">
                      <span aria-hidden="true" style="font-family:${MONO};font-size:14px;color:#475467">@</span>
                      <span style="flex:1 1 180px;min-width:0;max-width:100%"><select id="mailbox-domain" name="domainId" aria-label="${ar ? 'النطاق' : 'Domain'}" required style="width:100%;max-width:100%;min-width:0;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;font-size:14px;color:#101828">${domainOptions}</select></span>
                    </div>
                    <span id="new-local-help" style="display:block;min-width:0;max-width:100%;font-size:12px;font-weight:500;color:#5D6B7E;line-height:1.5;overflow-wrap:anywhere">${ar ? 'اسم الدخول هو' : 'The login is'} <code data-login-preview style="font-family:${MONO};color:#344054;overflow-wrap:anywhere">${escapeHtml(preview)}</code> ${ar ? 'لكل خدمة.' : 'for every service.'}</span>
                    ${domains.length === 0 ? `<p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:12px;font-weight:500;color:#B42318">${prose(ar ? 'أضف نطاقًا قبل إنشاء مستخدم.' : 'Add a domain before creating a user.', ar)}</p>` : ''}
                  </div>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <label for="mailbox-password" style="font-size:13px;font-weight:600">${ar ? 'كلمة المرور' : 'Password'}</label>
                    <div style="display:flex;flex-wrap:wrap;gap:8px">
                      <input id="mailbox-password" name="password" type="password" autocomplete="new-password" minlength="8" required aria-describedby="new-pass-help" style="flex:1 1 220px;min-width:0;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;font-family:${MONO};font-size:14px;color:#101828">
                      ${fieldButton(ar ? 'توليد' : 'Generate', ' data-generate-password="true"')}
                    </div>
                    <span id="new-pass-help" class="${ar ? 'xp-ar-sentence' : ''}" style="font-size:12px;font-weight:500;color:#5D6B7E">${prose(ar ? 'ثمانية أحرف على الأقل. كلمة المرور نفسها لكل خدمة مفعّلة.' : 'At least 8 characters. The same password works for every service you turn on.', ar)}</span>
                  </div>
                </fieldset>
                <fieldset style="margin:0;padding:0;border:none;display:flex;flex-direction:column;gap:8px">
                  <legend style="padding:0 0 12px;font-size:14px;font-weight:600">${ar ? 'الخدمات' : 'Services'}</legend>
                  ${switchRow('email', ar ? 'البريد' : 'Email', prose(ar ? 'صندوق بريد. يُحسب ضمن حد الصناديق في الخطة.' : 'A mailbox. It counts toward the plan mailbox cap.', ar), true)}
                  ${switchRow('ftp', 'FTP', prose(ar ? 'ملفات عبر FTP مع TLS، مقفلة على دليل واحد.' : 'Files over FTP with TLS, locked to one directory.', ar), false)}
                  ${switchRow('webdisk', ar ? 'قرص الويب' : 'Web Disk', prose(ar ? 'ملفات عبر WebDAV على دليل الحساب. عنوان الخادم غير محمّل.' : 'Files over WebDAV in the account directory. The server address is not loaded.', ar), false)}
                </fieldset>
                <fieldset data-mailbox-fields style="margin:0;padding:0;border:none;display:flex;flex-direction:column;gap:16px">
                  <legend style="padding:0 0 12px;font-size:14px;font-weight:600">${ar ? 'صندوق البريد' : 'Mailbox'}</legend>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <label for="mailbox-quota" style="font-size:13px;font-weight:600">${ar ? 'حصة صندوق البريد' : 'Mailbox quota'}</label>
                    <div style="display:flex;gap:8px;align-items:center">
                      <input id="mailbox-quota" name="mailboxQuotaMb" type="number" inputmode="decimal" min="1" ${quotaUnlimited ? 'disabled' : 'required'} value="${escapeHtml(quotaValue)}" style="flex:1 1 auto;min-width:0;min-height:44px;padding:0 12px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;font-family:${MONO};font-size:14px">
                      <span style="font-size:13px;color:#475467;min-width:56px">${ltr('MiB')}</span>
                    </div>
                    <label style="display:flex;align-items:center;gap:8px;font-size:13px;min-height:44px"><input data-quota-unlimited type="checkbox"${quotaUnlimited ? ' checked' : ''} style="width:18px;height:18px;accent-color:#1D5BD6">${ar ? 'بلا حد' : 'Unlimited'}</label>
                    <span class="${ar ? 'xp-ar-sentence' : ''}" style="font-size:12px;font-weight:500;color:#5D6B7E;line-height:1.5">${prose(quotaHelp, ar)}</span>
                  </div>
                </fieldset>
                <fieldset data-dir-fields hidden style="display:none;margin:0;padding:0;border:none;flex-direction:column;gap:16px">
                  <legend style="padding:0 0 12px;font-size:14px;font-weight:600">${ar ? 'الملفات' : 'Files'}</legend>
                  <div style="display:flex;flex-direction:column;gap:6px">
                    <label for="mailbox-dir" style="font-size:13px;font-weight:600">${ar ? 'دليل FTP وقرص الويب' : 'FTP and Web Disk directory'}</label>
                    <div style="display:flex;align-items:stretch;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;overflow:hidden;min-width:0">
                      <span data-wrap style="display:flex;align-items:center;padding:0 12px;background:#F0F2F5;border-inline-end:1px solid #D0D5DD;font-family:${MONO};font-size:14px;color:#344054;min-width:0;max-width:46%;overflow-wrap:anywhere">${ltr(homePrefix)}</span>
                      <input id="mailbox-dir" name="ftpDir" value="public_html" autocomplete="off" spellcheck="false" style="flex:1 1 auto;min-width:0;min-height:44px;padding:0 12px;border:none;background:#FFFFFF;font-family:${MONO};font-size:14px;color:#101828">
                    </div>
                    <span class="${ar ? 'xp-ar-sentence' : ''}" style="font-size:12px;font-weight:500;color:#5D6B7E;line-height:1.5">${ar
                      ? `المسار نسبي إلى منزل الحساب. الجلسات تعمل على ${ltr(`uid ${formatAsciiNumber(account.uid)}`)} داخل ${ltr(slice)}. يحفظ الخادم public_html عندما يُحذف الحقل.`
                      : `The path is relative to the account home. Sessions run as ${ltr(`uid ${formatAsciiNumber(account.uid)}`)} inside ${ltr(slice)}. The server stores public_html when this field is omitted.`}</span>
                  </div>
                  <p class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;font-size:12px;font-weight:500;color:#5D6B7E">${prose(ar ? 'اختيار القراءة فقط لقرص الويب غير محفوظ.' : 'A read-only Web Disk choice is not stored.', ar)}</p>
                </fieldset>
              </div>
              <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px;border-top:1px solid #EEF0F3">
                <span class="${ar ? 'xp-ar-sentence' : ''}" style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:#344054">${icon('<rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path>', 16)} ${prose(ar ? 'هؤلاء المستخدمون لا يدخلون إلى xPanel.' : 'These users cannot sign in to xPanel.', ar)}</span>
                <div style="display:flex;flex-wrap:wrap;gap:8px">
                  <button type="reset" style="min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#101828;font-family:inherit;font-size:14px;font-weight:600">${ar ? 'إلغاء' : 'Cancel'}</button>
                  ${domains.length === 0
                    ? `<button type="submit" disabled aria-disabled="true" style="min-height:44px;padding:0 18px;border-radius:8px;border:1px solid #E2E6EC;background:#F0F2F5;color:#5D6B7E;font-family:inherit;font-size:14px;font-weight:600">${escapeHtml(pendingWord(ar))}</button>`
                    : primaryButton(ar ? 'إنشاء مستخدم' : 'Create user')}
                </div>
              </div>
              <p data-mailbox-status role="status" hidden></p>
            </form>
          </section>
          <aside aria-label="${ar ? 'عن مستخدمي الخدمة' : 'About service users'}" style="flex:1 1 0;min-width:min(100%, 280px);display:flex;flex-direction:column;gap:24px">
            <section aria-labelledby="how-title" style="display:flex;flex-direction:column;gap:12px;padding:20px 24px;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC">
              <h2 id="how-title" style="margin:0;font-size:16px;font-weight:600">${ar ? 'كيف يعمل مستخدمو الخدمة' : 'How service users work'}</h2>
              <dl style="margin:0;display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.6">
                <div><dt style="font-weight:600">${ar ? 'دخول واحد' : 'One login'}</dt><dd style="margin:0;color:#475467">${ar ? `نفس ${ltr('user@domain')} وكلمة المرور لكل خدمة مفعّلة.` : `The same ${ltr('user@domain')} and password for every service you turn on.`}</dd></div>
                <div><dt style="font-weight:600">${ar ? 'ليس مستخدم لينكس' : 'Not a separate Linux user'}</dt><dd style="margin:0;color:#475467">${ar ? `دخول على ${ltr(`uid ${formatAsciiNumber(account.uid)}`)} بلا صدفة وبلا دخول إلى xPanel.` : `A login on ${ltr(`uid ${formatAsciiNumber(account.uid)}`)}, with no shell and no access to xPanel.`}</dd></div>
                <div><dt style="font-weight:600">${ar ? 'مقفول على دليل' : 'Locked to a directory'}</dt><dd class="${ar ? 'xp-ar-sentence' : ''}" style="margin:0;color:#475467">${prose(ar ? 'FTP وقرص الويب لا يريان شيئًا خارج الدليل الذي تختاره.' : 'FTP and Web Disk never see anything outside the directory you choose.', ar)}</dd></div>
                <div><dt style="font-weight:600">${ar ? 'يُحسب على القرص' : 'Counts toward disk'}</dt><dd style="margin:0;color:#475467">${diskCap === null
                  ? prose(ar ? 'حصة القرص غير محمّلة، والمساحة المستخدمة لم تُقاس.' : 'The disk quota is not loaded, and used space is not measured.', ar)
                  : (ar ? `الصناديق والملفات تستخدم حصة القرص ${ltr(plan?.resources?.diskMb === 'unlimited' ? (ar ? 'بلا حد' : 'Unlimited') : mib(diskCap))}. المساحة المستخدمة لم تُقاس.` : `Mailboxes and uploads use the ${ltr(plan?.resources?.diskMb === 'unlimited' ? 'unlimited' : mib(diskCap))} disk quota. Used space is not measured.`)}</dd></div>
              </dl>
            </section>
            <section aria-labelledby="client-title" style="display:flex;flex-direction:column;gap:12px;padding:20px 24px;border-radius:12px;background:#FFFFFF;border:1px solid #E2E6EC">
              <h2 id="client-title" style="margin:0;font-size:16px;font-weight:600">${ar ? 'إعدادات الاتصال' : 'Connection settings'}</h2>
              <dl style="margin:0;display:flex;flex-direction:column;font-size:13px">
                ${['IMAP', 'POP3', 'SMTP', 'FTP', ar ? 'قرص الويب' : 'Web Disk'].map((label, index, all) => `<div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:8px 0;${index < all.length - 1 ? 'border-bottom:1px solid #EEF0F3' : ''}"><dt style="color:#475467">${escapeHtml(label)}</dt><dd style="margin:0">${pending(ar)}</dd></div>`).join('')}
              </dl>
              <a href="/mail/inbox" style="display:inline-flex;align-items:center;min-height:44px;font-size:14px;font-weight:600">${ar ? 'افتح بريد xMail' : 'Open xMail webmail'}</a>
            </section>
          </aside>
        </div>
      </div>
      ${soonPanel('forwarders', ar ? 'إعادة التوجيه' : 'Forwarders', ar ? 'لا تُقرأ معيدات التوجيه من الخادم على هذه الصفحة.' : 'Forwarders are not read from the server on this page.', ar)}
      ${soonPanel('auto', ar ? 'الردود الآلية' : 'Autoresponders', ar ? 'لا تُقرأ الردود الآلية من الخادم على هذه الصفحة.' : 'Autoresponders are not read from the server on this page.', ar)}
      ${soonPanel('default', ar ? 'العنوان الافتراضي' : 'Default address', ar ? 'لا يُقرأ عنوان الالتقاط من الخادم على هذه الصفحة.' : 'The catch-all address is not read from the server on this page.', ar)}
    </div>
  </div>
  <dialog data-mailbox-password-dialog aria-labelledby="mailbox-password-title">
    <form method="dialog">
      <h2 id="mailbox-password-title">${ar ? 'كلمة مرور صندوق البريد' : 'Mailbox password'}</h2>
      <p class="${ar ? 'xp-ar-sentence' : ''}">${prose(ar ? 'تُحفظ كلمة المرور الجديدة بعد التأكيد.' : 'The new password is saved after you confirm.', ar)}</p>
      <label for="mailbox-password-next">${ar ? 'كلمة المرور الجديدة' : 'New password'}</label>
      <input id="mailbox-password-next" name="password" type="password" minlength="8" required autocomplete="new-password">
      <p data-dialog-status role="status" hidden></p>
      <button type="button" data-dialog-cancel>${ar ? 'إلغاء' : 'Cancel'}</button>
      <button type="submit">${ar ? 'حفظ' : 'Save'}</button>
    </form>
  </dialog>
  <dialog data-mailbox-quota-dialog aria-labelledby="mailbox-quota-title">
    <form method="dialog">
      <h2 id="mailbox-quota-title">${ar ? 'حصة صندوق البريد' : 'Mailbox quota'}</h2>
      <label for="mailbox-quota-next">${ar ? 'الحصة' : 'Quota'} ${ltr('MiB')}</label>
      <input id="mailbox-quota-next" name="mailboxQuotaMb" type="number" min="1" required>
      <p data-dialog-status role="status" hidden></p>
      <button type="button" data-dialog-cancel>${ar ? 'إلغاء' : 'Cancel'}</button>
      <button type="submit">${ar ? 'حفظ' : 'Save'}</button>
    </form>
  </dialog>
</main>
</div>
${clientScript()}`
}

const documentShell = (body: string, ar: boolean): string => `<!doctype html>
<html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${ar ? 'البريد ومستخدمو الخدمة — xPanel' : 'Email and service users — xPanel'}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>body{margin:0;background:#F5F6F8;color:#101828}*{box-sizing:border-box}</style>
</head>
<body>
${body}
</body>
</html>`

export const renderEmailDocument = (input: EmailAccountsInput): string =>
  documentShell(renderXpanelEmail(input), input.locale === 'ar')

export const renderLiveDocument = (dir: 'ltr' | 'rtl' = 'ltr'): string =>
  renderEmailDocument({
    locale: dir === 'rtl' ? 'ar' : 'en',
    account: { username: 'owner', uid: 21000, home: '/home/owner', primaryDomain: 'example.test' },
    signOutLabel: dir === 'rtl' ? 'تسجيل الخروج' : 'Sign out',
  })
