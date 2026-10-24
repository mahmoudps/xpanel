import type { Account, ServerIpEntry } from '@xpanel/core'
import { renderServerIoMonitorChart, renderWebsiteAnalyticsChart } from '../../charts.ts'
import type { Locale } from '../../i18n.ts'
import { t } from '../../i18n.ts'
import {
  escapeHtml,
  formatAsciiDate,
  formatBytes,
  renderStatusBadge,
} from '../../tokens.ts'
import type { ComposedContext } from './context.ts'
import { copyOf, type ComposedRoute, type Copy } from './types.ts'

const soon: Copy = ['Coming soon', 'قيد التفعيل']
const notMeasured: Copy = ['Not measured', 'غير مقاس']
const notRead: Copy = ['Not read', 'لم تُقرأ']

const tx = (locale: Locale, value: Copy): string => escapeHtml(copyOf(value, locale))
const ltr = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`

const soonButton = (locale: Locale, label: Copy): string =>
  `<button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${tx(locale, label)}</button><p class="xp-help" data-wiring-hint="soon">${tx(locale, soon)}</p>`

const emptyBlock = (locale: Locale, title: Copy, body?: Copy, unavailable = false): string =>
  `<div class="xp-design-empty"${unavailable ? ' data-screen="unavailable"' : ''} role="status"><h2>${tx(locale, title)}</h2>${body ? `<p>${tx(locale, body)}</p>` : ''}</div>`

const note = (locale: Locale, title: Copy, body: Copy): string =>
  `<aside class="xp-board-note" role="note"><h2>${tx(locale, title)}</h2><p>${tx(locale, body)}</p></aside>`

const card = (id: string, locale: Locale, title: Copy, body: string): string =>
  `<section class="xp-board-section" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title"><header class="xp-board-section__head"><h2 id="${escapeHtml(id)}-title">${tx(locale, title)}</h2></header><div class="xp-board-section__body">${body}</div></section>`

interface TableRow {
  attr?: string
  cells: string[]
}

const table = (locale: Locale, columns: readonly Copy[], rows: readonly TableRow[], empty: Copy): string => {
  const head = columns.map(column => `<th>${tx(locale, column)}</th>`).join('')
  const body = rows.length
    ? rows.map(row => `<tr${row.attr ? ` ${row.attr}` : ''}>${row.cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${Math.max(columns.length, 1)}">${tx(locale, empty)}</td></tr>`
  return `<div class="xp-table-wrap"><table class="xp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

const disabledField = (id: string, locale: Locale, label: Copy): string =>
  `<div class="xp-field"><label class="xp-label" for="${escapeHtml(id)}">${tx(locale, label)}</label><input id="${escapeHtml(id)}" class="xp-input" type="text" value="" disabled data-wiring="soon"></div>`

const fields = (route: string, locale: Locale, labels: readonly Copy[]): string =>
  `<div class="xp-board-fields">${labels.map((label, index) => disabledField(`${route.replace(/[^a-z0-9]+/gi, '-')}-f${index}`, locale, label)).join('')}</div>`

const limitLabel = (value: number | 'unlimited', locale: Locale): string =>
  value === 'unlimited' ? tx(locale, ['Unlimited', 'غير محدود']) : ltr(String(value))

const accountStatus = (account: Account, locale: Locale): string =>
  account.status === 'active'
    ? renderStatusBadge('ok', locale === 'ar' ? 'نشط' : 'Active')
    : renderStatusBadge('suspended', locale === 'ar' ? 'موقوف' : 'Suspended')

const headerAction = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'trash') {
    const count = (ctx.files ?? []).filter(file => file.trashed).length
    const disabled = count === 0 ? ' disabled' : ''
    return `<button type="button" class="xp-btn xp-btn--primary" data-action="empty-trash"${disabled}>${tx(locale, ['Empty trash', 'إفراغ السلة'])}</button>`
  }
  const liveBody = new Set(['site-settings', 'terminal', 'ssl-issue', 'ips', 'mail-ips', 'backups', 'generations', 'io', 'host-info', 'web-stats'])
  if (liveBody.has(spec.bind)) return ''
  if (!spec.action) return ''
  return soonButton(locale, spec.action)
}

const frame = (spec: ComposedRoute, ctx: ComposedContext, body: string, wiring: 'live' | 'soon'): string => {
  const locale = ctx.locale
  const id = spec.route.replace(/[^a-z0-9]+/gi, '-')
  return `<section class="xp-design-page xp-board-port" data-composed-route="${escapeHtml(spec.route)}" data-composed-template="${escapeHtml(spec.template)}" data-composed-bind="${escapeHtml(spec.bind)}" data-wiring="${wiring}">
    <header class="xp-board-head">
      <div>
        <nav class="xp-board-crumb" aria-label="${tx(locale, ['Breadcrumb', 'مسار التنقل'])}"><ol><li>${tx(locale, spec.group)}</li><li aria-current="page">${tx(locale, spec.title)}</li></ol></nav>
        <h1 id="${escapeHtml(id)}-title" class="xp-page-title">${tx(locale, spec.title)}</h1>
        <p class="xp-prose xp-design-page__lede">${tx(locale, spec.lede)}</p>
      </div>
      <div class="xp-board-actions">${headerAction(spec, ctx)}</div>
    </header>
    <div class="xp-board-canvas" data-board-layout="${escapeHtml(spec.layout)}">${body}</div>
  </section>`
}

const filesBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  const home = ctx.account?.home ?? ''
  const username = ctx.account?.username ?? ''
  if (spec.bind === 'trash') {
    const rows = (ctx.files ?? []).filter(file => file.trashed)
    const tableRows: TableRow[] = rows.map(file => ({
      attr: `data-file-path="${escapeHtml(file.path)}"`,
      cells: [
        `<strong class="xp-mono">${ltr(file.name)}</strong><div class="xp-mono">${ltr(file.path)}</div>`,
        ltr(formatBytes(file.sizeBytes)),
        `<time datetime="${escapeHtml(file.modifiedAt)}">${ltr(formatAsciiDate(file.modifiedAt, { includeTime: true }))}</time>`,
        `<code class="xp-mono">${ltr(file.modeOctal)}</code>`,
        ltr(username),
        `<button type="button" class="xp-btn" data-action="restore-file" data-path="${escapeHtml(file.path)}">${tx(locale, ['Restore', 'استعادة'])}</button>`,
      ],
    }))
    return `<div class="xp-tabs" role="tablist" aria-label="${tx(locale, ['File manager views', 'عروض مدير الملفات'])}">
        <a role="tab" href="/files/manager" aria-selected="false">${tx(locale, ['Files', 'الملفات'])}</a>
        <button type="button" role="tab" aria-selected="true">${tx(locale, ['Trash', 'سلة المحذوفات'])}</button>
      </div>
      <nav aria-label="${tx(locale, ['Current folder', 'المجلد الحالي'])}" class="xp-board-crumb"><ol><li>${ltr(home)}</li><li aria-current="page">${ltr('.trash')}</li></ol></nav>
      ${card('composed-trash', locale, ['Trash', 'سلة المحذوفات'], table(locale, spec.columns, tableRows, ['Trash is empty', 'سلة المحذوفات فارغة']))}`
  }
  if (spec.bind === 'ftp' || spec.bind === 'webdisk') {
    const rows = (ctx.serviceUsers ?? []).filter(user => spec.bind === 'ftp' ? user.services.ftp : user.services.webdisk)
    const tableRows: TableRow[] = rows.map(user => ({
      attr: `data-service-user="${escapeHtml(user.login)}"`,
      cells: [
        ltr(user.login),
        ltr(user.ftpDir),
        typeof user.mailboxQuotaMb === 'number' ? ltr(`${user.mailboxQuotaMb} MiB`) : tx(locale, ['Unlimited', 'غير محدود']),
        spec.bind === 'ftp' ? ltr('FTP') : ltr('WebDAV'),
      ],
    }))
    const empty: Copy = spec.bind === 'ftp'
      ? ['No FTP accounts are stored', 'لا حسابات FTP محفوظة']
      : ['No Web Disk accounts are stored', 'لا حسابات قرص ويب محفوظة']
    const path = home ? `${home}` : ''
    return `${path ? `<nav aria-label="${tx(locale, ['Home', 'المنزل'])}" class="xp-board-crumb"><ol><li aria-current="page">${ltr(path)}</li></ol></nav>` : ''}
      ${card('composed-service-users', locale, spec.title, table(locale, spec.columns, tableRows, empty))}
      ${note(locale, ['What stays off', 'ما يبقى متوقفًا'], ['Creating an account from this screen is not connected. The rows above are the accounts already stored.', 'إنشاء حساب من هذه الشاشة غير موصول. الصفوف أعلاه هي الحسابات المحفوظة فعلًا.'])}`
  }
  return `${card('composed-files', locale, spec.title, table(locale, spec.columns, [], ['Nothing is stored for this screen', 'لا شيء محفوظ لهذه الشاشة']))}
    ${emptyBlock(locale, ['No file is open', 'لا ملف مفتوح'], ['The editor stays blank until a file tool returns a path.', 'يبقى المحرر فارغًا إلى أن تعيد أداة الملفات مسارًا.'])}`
}

const siteBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'site-settings') {
    const config = ctx.customConfig
    const account = ctx.account
    if (!config || !account) {
      return emptyBlock(locale, ['No site configuration was read', 'لم يُقرأ إعداد الموقع'], ['Nothing is shown until the site tool returns this domain’s configuration.', 'لا يُعرض شيء إلى أن تعيد أداة الموقع إعداد هذا النطاق.'], true)
    }
    const userIni = Object.entries(config.userIni).map(([key, value]) => `${key} = ${value}`).join('\n')
    const headers = Object.entries(config.customHeaders).map(([key, value]) => `${key}: ${value}`).join('\n')
    return `${note(locale, ['Configuration checks before applying', 'فحص الإعدادات قبل التطبيق'], ['Privilege and isolation directives are blocked: user, pid, root, alias, include, SuexecUserGroup, AssignUserId, LoadModule, Listen. Failed checks keep the previous configuration active.', 'توجيهات الصلاحيات والعزل محظورة: user وpid وroot وalias وinclude وSuexecUserGroup وAssignUserId وLoadModule وListen. عند فشل الفحص تبقى الإعدادات السابقة نشطة.'])}
      <p class="xp-help">${ltr('nginx -t')} · ${ltr('apachectl configtest')}</p>
      <form class="xp-form-group" action="/api/xpanel/domains/custom-config" method="post" data-userdata-form="true">
        <div class="xp-field">
          <label class="xp-label" for="userdata-nginx-include">${tx(locale, ['Nginx include', 'تضمين Nginx'])}</label>
          <div class="xp-mono">${ltr(`/etc/xpanel/userdata/${account.username}/${config.domainName}/nginx.conf`)}</div>
          <textarea id="userdata-nginx-include" name="nginxInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(config.nginxInclude)}</textarea>
        </div>
        <div class="xp-field">
          <label class="xp-label" for="userdata-apache-include">${tx(locale, ['Apache include', 'تضمين Apache'])}</label>
          <div class="xp-mono">${ltr(`/etc/xpanel/userdata/${account.username}/${config.domainName}/apache.conf`)}</div>
          <textarea id="userdata-apache-include" name="apacheInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(config.apacheInclude)}</textarea>
        </div>
        <div class="xp-field">
          <label class="xp-label" for="userdata-user-ini">${tx(locale, ['PHP user.ini', 'ملف user.ini'])}</label>
          <div class="xp-mono">${ltr(`/home/${account.username}/public_html/.user.ini`)}</div>
          <textarea id="userdata-user-ini" name="userIni" rows="4" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(userIni)}</textarea>
        </div>
        <div class="xp-field">
          <label class="xp-label" for="userdata-custom-headers">${tx(locale, ['Headers and cache bypass', 'الترويسات وتجاوز التخزين'])}</label>
          <textarea id="userdata-custom-headers" name="customHeaders" rows="3" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(`${headers}\nBypass: ${config.cacheBypassPaths.join(', ')}`)}</textarea>
        </div>
        <button type="submit" class="xp-btn xp-btn--primary" data-action="apply-userdata">${tx(locale, ['Review and apply', 'مراجعة وتطبيق'])}</button>
      </form>`
  }
  return `${card('composed-site-list', locale, spec.title, table(locale, spec.columns, [], ['Nothing is stored for this screen', 'لا شيء محفوظ لهذه الشاشة']))}
    ${card('composed-site-form', locale, spec.action ?? ['Save', 'حفظ'], fields(spec.route, locale, spec.fields))}
    ${note(locale, ['What a save does not do', 'ما لا يفعله الحفظ'], ['A disabled field is not a saved setting. Nothing is written from this screen until the tool is connected.', 'الحقل المعطّل ليس إعدادًا محفوظًا. لا يُكتب شيء من هذه الشاشة إلى أن تُوصل الأداة.'])}`
}

const databaseBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.layout === 'launch') {
    return `    ${emptyBlock(locale, ['No admin address is configured', 'لا عنوان إدارة مضبوط'], ['Opening this tool needs an address from the server. None was returned.', 'فتح هذه الأداة يحتاج عنوانًا من الخادم. لم يُرجع عنوان.'])}`
  }
  return `${note(locale, ['Names on this account', 'الأسماء في هذا الحساب'], ['PostgreSQL rows appear only when that engine is connected. MariaDB databases stay on the MariaDB screen.', 'تظهر صفوف PostgreSQL فقط عند وصل ذلك المحرك. تبقى قواعد MariaDB في شاشة MariaDB.'])}
    ${card('composed-databases', locale, spec.title, table(locale, spec.columns, [], ['No databases are connected for this engine', 'لا قواعد متصلة لهذا المحرك']))}
    ${card('composed-db-users', locale, ['Database users', 'مستخدمو قاعدة البيانات'], table(locale, [['User', 'المستخدم'], ['Grants', 'الصلاحيات']], [], ['No users are stored for this engine', 'لا مستخدمون محفوظون لهذا المحرك']))}`
}

const metricsBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'web-stats' && ctx.websiteAnalytics) {
    return renderWebsiteAnalyticsChart(ctx.websiteAnalytics, locale)
  }
  const domains = ctx.domains ?? []
  const domainField = `<div class="xp-field"><label class="xp-label" for="composed-metric-domain">${tx(locale, ['Domain', 'النطاق'])}</label><select id="composed-metric-domain" class="xp-select" disabled data-wiring="soon">${domains.length ? domains.map(domain => `<option>${escapeHtml(domain.name)}</option>`).join('') : `<option>${tx(locale, ['No domain was read', 'لم يُقرأ نطاق'])}</option>`}</select></div>`
  return `${domainField}
    ${emptyBlock(locale, ['No requests logged for this selection yet', 'لا طلبات مسجّلة لهذا الاختيار بعد'], ['Visitors, errors and bandwidth are not measured until logs exist. They are not shown as zero.', 'لا تُقاس الزيارات والأخطاء والنطاق إلى أن توجد سجلات. لا تُعرض كصفر.'])}
    ${card('composed-metrics', locale, spec.title, table(locale, spec.columns, [], ['No rows for this selection', 'لا صفوف لهذا الاختيار']))}`
}

const sslBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  const domains = ctx.domains ?? []
  const rows: TableRow[] = domains.map(domain => ({
    cells: [
      ltr(domain.name),
      domain.certificateId
        ? renderStatusBadge('ok', locale === 'ar' ? 'محفوظة' : 'Stored')
        : renderStatusBadge('suspended', locale === 'ar' ? 'لا توجد شهادة' : 'No certificate'),
    ],
  }))
  const form = spec.bind === 'ssl-issue' && domains.length > 0 && ctx.account
    ? `<form class="xp-form-group" data-certificate-form="true" data-account-username="${escapeHtml(ctx.account.username)}">
        <div class="xp-field"><label class="xp-label" for="certificate-domain">${tx(locale, ['Domain', 'النطاق'])}</label>
          <select id="certificate-domain" name="domain" class="xp-input" required>${domains.map(domain => `<option value="${escapeHtml(domain.name)}">${escapeHtml(domain.name)}</option>`).join('')}</select>
        </div>
        <p class="xp-help" data-certificate-status role="status" hidden></p>
        <button type="submit" class="xp-btn xp-btn--primary">${tx(locale, ['Issue or renew', 'إصدار أو تجديد'])}</button>
      </form>`
    : spec.bind === 'ssl-issue' ? `<p class="xp-help">${tx(locale, ['Add a domain before issuing a certificate.', 'أضف نطاقًا قبل إصدار شهادة.'])}</p>` : ''
  return `${card('composed-ssl', locale, spec.title, `${table(locale, spec.columns, rows, ['No domains were read', 'لم تُقرأ نطاقات'])}${form}`)}
    ${spec.bind === 'ssl-files' ? note(locale, ['Certificate files', 'ملفات الشهادة'], ['Key and chain files are not listed until the certificate tool returns them.', 'لا تُعرض ملفات المفتاح والسلسلة إلى أن تعيدها أداة الشهادات.']) : ''}`
}

const terminalBody = (ctx: ComposedContext): string => {
  const locale = ctx.locale
  const account = ctx.account
  if (!account) {
    return `${emptyBlock(locale, ['No server terminal session was read', 'لم تُقرأ جلسة طرفية للخادم'], ['This screen does not send commands until a server terminal tool is connected.', 'لا ترسل هذه الشاشة أوامر إلى أن تُوصل أداة طرفية للخادم.'], true)}
      ${disabledField('server-terminal-command', locale, ['Command', 'الأمر'])}`
  }
  if (!ctx.shellEnabled) {
    return `<div class="xp-reconcile-banner" role="status" data-terminal-disabled="true">${renderStatusBadge('suspended', locale === 'ar' ? 'وصول الطرفية معطل' : 'Shell access disabled')}<p class="xp-prose">${tx(locale, ['Terminal access is disabled on your current plan.', 'وصول الطرفية غير مفعل في خطتك الحالية.'])}</p></div>`
  }
  const bins = ['php', 'composer', 'wp', 'git', 'node', 'npm', 'python3', 'tar', 'gzip', 'mysql', 'mysqldump']
  return `<p class="xp-prose">${tx(locale, ['Commands run as this account, inside its slice.', 'تعمل الأوامر بهذا الحساب داخل شريحته.'])}</p>
    <p class="xp-label">${tx(locale, ['Allowed commands', 'الأوامر المسموحة'])}</p>
    <p>${bins.map(bin => `<code class="xp-mono">${ltr(bin)}</code>`).join(' · ')}</p>
    <pre class="xp-terminal" dir="ltr" data-terminal-output="${escapeHtml(ctx.terminalSessionId ?? '')}">${escapeHtml(locale === 'ar' ? 'لم تبدأ جلسة طرفية بعد.' : 'No terminal session has started.')}</pre>
    <form class="xp-form-group" action="/api/xpanel/terminal/exec" method="post" data-terminal-form="true">
      <label class="xp-label" for="terminal-command-input">${tx(locale, ['Command', 'الأمر'])}</label>
      <input id="terminal-command-input" name="command" type="text" class="xp-input xp-mono" dir="ltr" placeholder="composer status --no-interaction">
      <button type="submit" class="xp-btn xp-btn--primary">${tx(locale, ['Run', 'تشغيل'])}</button>
    </form>`
}

const usageBody = (ctx: ComposedContext): string => {
  const locale = ctx.locale
  const usage = ctx.usage
  const row = (label: Copy, value: string | null): string =>
    `<div><dt>${tx(locale, label)}</dt><dd>${value === null ? tx(locale, notMeasured) : ltr(value)}</dd></div>`
  const php = usage?.phpVersion ?? null
  const disk = usage?.diskBytes ?? null
  const memory = usage?.memoryBytes ?? null
  const processes = usage?.processCount ?? null
  return `<dl class="xp-board-stats">
      ${row(['Plan', 'الخطة'], ctx.plan?.name ?? null)}
      ${row(['PHP', 'PHP'], php)}
      ${row(['Disk', 'القرص'], disk === null ? null : formatBytes(disk))}
      ${row(['Memory', 'الذاكرة'], memory === null ? null : formatBytes(memory))}
      ${row(['Processes', 'العمليات'], processes === null ? null : String(processes))}
      ${row(['Bandwidth', 'النطاق'], null)}
    </dl>
    ${note(locale, ['Bandwidth', 'النطاق'], ['Bandwidth for this account is not measured. It is not shown as zero.', 'نطاق هذا الحساب غير مقاس. لا يُعرض كصفر.'])}`
}

const accountRows = (accounts: readonly Account[], locale: Locale, extra: (account: Account) => string): TableRow[] =>
  accounts.map(account => ({
    attr: `data-account-row="${escapeHtml(account.username)}"`,
    cells: [ltr(account.username), ltr(account.primaryDomain), accountStatus(account, locale), extra(account)],
  }))

const listBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'accounts') {
    const accounts = ctx.accounts ?? []
    const extra = spec.route.endsWith('/bandwidth')
      ? () => tx(locale, notMeasured)
      : () => tx(locale, ['No extra reading', 'لا قراءة إضافية'])
    const columns: readonly Copy[] = spec.route.endsWith('/bandwidth')
      ? [['Account', 'الحساب'], ['Domain', 'النطاق'], ['Status', 'الحالة'], ['Bandwidth', 'النطاق']]
      : spec.columns
    return `${spec.route.endsWith('/announcements') ? card('composed-announcements', locale, ['Announcements', 'الإعلانات'], table(locale, [['Announcement', 'الإعلان'], ['Sent', 'أُرسل']], [], ['No announcements are stored', 'لا إعلانات محفوظة'])) : ''}
      ${card('composed-accounts', locale, spec.title, table(locale, columns, accountRows(accounts, locale, extra), ['No accounts yet', 'لا حسابات بعد']))}
      ${spec.route.endsWith('/bandwidth') ? note(locale, ['Bandwidth', 'النطاق'], ['Per-account bandwidth is not measured on this screen. It is not shown as zero.', 'نطاق كل حساب غير مقاس في هذه الشاشة. لا يُعرض كصفر.']) : ''}`
  }
  if (spec.bind === 'resellers' || spec.bind === 'reseller-acl') {
    const resellers = ctx.resellers ?? []
    if (spec.bind === 'reseller-acl') {
      const rows: TableRow[] = resellers.map(reseller => ({
        cells: [ltr(reseller.username), reseller.acl.length ? reseller.acl.map(acl => ltr(acl)).join(' ') : tx(locale, ['No privileges stored', 'لا صلاحيات محفوظة'])],
      }))
      return card('composed-acl', locale, spec.title, table(locale, spec.columns, rows, ['No resellers yet', 'لا موزعين بعد']))
    }
    const rows: TableRow[] = resellers.map(reseller => ({
      cells: [ltr(reseller.username), limitLabel(reseller.maxAccounts, locale), reseller.nameservers.length ? reseller.nameservers.map(ns => ltr(ns)).join(' ') : tx(locale, notRead)],
    }))
    return card('composed-resellers', locale, spec.title, table(locale, spec.columns, rows, ['No resellers yet', 'لا موزعين بعد']))
  }
  if (spec.bind === 'services') {
    const services = ctx.services ?? []
    const rows: TableRow[] = services.map(service => ({
      attr: `data-service-row="${escapeHtml(service.name)}"`,
      cells: [
        ltr(service.name),
        ltr(service.unit),
        ltr(service.version),
        service.active ? renderStatusBadge('ok', locale === 'ar' ? 'يعمل' : 'Running') : renderStatusBadge('critical', locale === 'ar' ? 'متوقف' : 'Stopped'),
      ],
    }))
    return `${card('composed-services', locale, spec.title, table(locale, spec.columns, rows, ['No service report yet', 'لا تقرير خدمات بعد']))}
      <div class="xp-table-wrap" data-host-services="true"><table class="xp-table"><thead><tr><th>${tx(locale, ['Service', 'الخدمة'])}</th><th>${tx(locale, ['Unit', 'الوحدة'])}</th><th>${tx(locale, ['Status', 'الحالة'])}</th><th>${tx(locale, ['Action', 'إجراء'])}</th></tr></thead><tbody data-host-service-rows="true"><tr><td colspan="4">${tx(locale, ['Reading service status.', 'جار قراءة حالة الخدمات.'])}</td></tr></tbody></table><p class="xp-help" data-host-service-status role="status"></p></div>`
  }
  return card('composed-list', locale, spec.title, table(locale, spec.columns, [], ['Nothing is stored for this screen', 'لا شيء محفوظ لهذه الشاشة']))
}

const settingsBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'mail-ips') {
    const config = ctx.mailIpConfig
    if (!config) {
      return emptyBlock(locale, ['Outbound mail routing was not read', 'لم يُقرأ توجيه البريد الصادر'], ['Nothing is shown until the mail routing tool returns a configuration.', 'لا يُعرض شيء إلى أن تعيد أداة التوجيه إعدادًا.'], true)
    }
    const modeLabel = locale === 'ar' ? 'توجيه البريد الصادر' : 'Outbound mail routing'
    return `<form class="xp-form-group" action="/api/whm/mail-ips" method="post" data-mail-ip-config-form="true">
      <div class="xp-field"><label class="xp-label" for="mail-outbound-mode">${escapeHtml(modeLabel)}</label>
        <select id="mail-outbound-mode" name="mode" class="xp-select">
          ${(['server-default', 'account-ip', 'domain-ip', 'custom-map'] as const).map(mode => `<option value="${mode}" ${config.mode === mode ? 'selected' : ''}>${escapeHtml(mode)} (${escapeHtml(t(locale, `mailIp.mode.${mode}`))})</option>`).join('')}
        </select>
      </div>
      <div class="xp-field"><label class="xp-label" for="mail-default-ipv4">${tx(locale, ['Default outbound IPv4', 'عنوان IPv4 الصادر الافتراضي'])}</label><input id="mail-default-ipv4" name="defaultIpv4" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(config.defaultIpv4 ?? '')}"></div>
      <div class="xp-field"><label class="xp-label" for="mail-default-ipv6">${tx(locale, ['Default outbound IPv6', 'عنوان IPv6 الصادر الافتراضي'])}</label><input id="mail-default-ipv6" name="defaultIpv6" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(config.defaultIpv6 ?? '')}"></div>
      <div class="xp-field"><label class="xp-label" for="mail-default-helo">${escapeHtml(t(locale, 'mailIp.defaultHelo'))}</label><input id="mail-default-helo" name="defaultHelo" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(config.defaultHelo ?? '')}"></div>
      <pre class="xp-terminal" dir="ltr">${config.domainOverrides.length ? config.domainOverrides.map(override => ltr([override.domainName, override.ipv4, override.ipv6, override.heloHostname].filter(Boolean).join(' · '))).join('\n') : tx(locale, ['No domain overrides are configured.', 'لا توجد إعدادات خاصة بالنطاقات.'])}</pre>
      <button type="submit" class="xp-btn xp-btn--primary">${tx(locale, ['Review and apply', 'مراجعة وتطبيق'])}</button>
    </form>`
  }
  return card('composed-settings', locale, spec.title, `${fields(spec.route, locale, spec.fields)}${table(locale, spec.columns, [], ['No saved values', 'لا قيم محفوظة'])}`)
}

const ipOwner = (ip: ServerIpEntry, ctx: ComposedContext, locale: Locale): string => {
  if (!ip.ownerId) return ltr(ip.ownerKind)
  const named = ip.ownerKind === 'account'
    ? ctx.accounts?.find(account => account.id === ip.ownerId)?.username
    : ctx.resellers?.find(reseller => reseller.id === ip.ownerId)?.username
  return ltr(`${ip.ownerKind} (${named ?? (locale === 'ar' ? 'المالك غير متاح' : 'Owner unavailable')})`)
}

const ipsBody = (ctx: ComposedContext): string => {
  const locale = ctx.locale
  const rows: TableRow[] = (ctx.ipPool ?? []).map(ip => ({
    attr: `data-ip-row="${escapeHtml(ip.address)}"`,
    cells: [
      ltr(`${ip.address}/${ip.prefixLength}`),
      ltr(`IPv${ip.version}`),
      ltr(ip.interfaceName),
      renderStatusBadge(ip.role === 'mail' ? 'warn' : 'ok', ip.role),
      ipOwner(ip, ctx, locale),
      ip.ptrHostname ? ltr(ip.ptrHostname) : tx(locale, ['Not set', 'غير مضبوط']),
      renderStatusBadge(ip.isPrimary ? 'ok' : 'suspended', ip.isPrimary ? (locale === 'ar' ? 'أساسي' : 'Primary') : (locale === 'ar' ? 'ثانوي' : 'Secondary')),
    ],
  }))
  return `<div class="xp-table-wrap"><table class="xp-table" data-ip-pool-table="true"><thead><tr>
      <th>${tx(locale, ['Address', 'العنوان'])}</th><th>${ltr('IPv4 / IPv6')}</th><th>${tx(locale, ['Interface', 'الواجهة'])}</th><th>${tx(locale, ['Role', 'الدور'])}</th><th>${tx(locale, ['Owner', 'المالك'])}</th><th>${tx(locale, ['PTR', 'PTR'])}</th><th>${tx(locale, ['Primary', 'أساسي'])}</th>
    </tr></thead><tbody>${rows.length ? rows.map(row => `<tr ${row.attr}>${row.cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="7">${tx(locale, ['No addresses were read', 'لم تُقرأ عناوين'])}</td></tr>`}</tbody></table></div>
    <form class="xp-form-group" action="/api/whm/ips" method="post" data-add-ip-form="true">
      <h2>${tx(locale, ['Add an address', 'إضافة عنوان'])}</h2>
      <div class="xp-field"><label class="xp-label" for="add-ip-address">${tx(locale, ['Address', 'العنوان'])}</label><input id="add-ip-address" name="address" type="text" class="xp-input xp-mono" dir="ltr"></div>
      <div class="xp-field"><label class="xp-label" for="add-ip-prefix">${tx(locale, ['Prefix length', 'طول البادئة'])}</label><input id="add-ip-prefix" name="prefixLength" type="number" class="xp-input xp-mono" required min="0" max="128"></div>
      <div class="xp-field"><label class="xp-label" for="add-ip-role">${tx(locale, ['Role', 'الدور'])}</label><select id="add-ip-role" name="role" class="xp-select"><option value="shared">shared</option><option value="dedicated">dedicated</option><option value="mail">mail</option></select></div>
      <div class="xp-field"><label class="xp-label" for="add-ip-owner">${tx(locale, ['Owner', 'المالك'])}</label><select id="add-ip-owner" name="ownerKind" class="xp-select"><option value="root">root</option><option value="reseller">reseller</option><option value="account">account</option></select></div>
      <div class="xp-field"><label class="xp-label" for="add-ip-ptr">${tx(locale, ['PTR', 'PTR'])}</label><input id="add-ip-ptr" name="ptrHostname" type="text" class="xp-input xp-mono" dir="ltr"></div>
      <button type="submit" class="xp-btn xp-btn--primary">${tx(locale, ['Add address', 'إضافة العنوان'])}</button>
    </form>`
}

const generationsBody = (ctx: ComposedContext): string => {
  const locale = ctx.locale
  const rows = ctx.generations ?? []
  const body = rows.length
    ? rows.map(gen => `<tr data-generation-row="${gen.generationId}"><td class="xp-mono">${ltr(`#${gen.generationId}`)}</td><td>${escapeHtml(gen.summary)}</td><td>${ltr(`sha256:${gen.stateChecksum}`)} · ${ltr(`${gen.filesCount}`)}</td><td>${renderStatusBadge(gen.status === 'active' ? 'ok' : 'suspended', gen.status)}</td><td><button type="button" class="xp-btn" data-action="rollback-generation" data-generation-id="${gen.generationId}" ${gen.status === 'active' ? 'disabled' : ''}>${escapeHtml(locale === 'ar' ? `التراجع إلى #${gen.generationId}` : `Rollback to #${gen.generationId}`)}</button></td></tr>`).join('')
    : `<tr><td colspan="5">${tx(locale, ['No generations were read', 'لم تُقرأ أجيال'])}</td></tr>`
  return `<div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${tx(locale, ['Generation', 'الجيل'])}</th><th>${tx(locale, ['Summary', 'الملخص'])}</th><th>${tx(locale, ['Checksum', 'البصمة'])}</th><th>${tx(locale, ['Status', 'الحالة'])}</th><th>${tx(locale, ['Rollback', 'التراجع'])}</th></tr></thead><tbody>${body}</tbody></table></div>`
}

const backupsBody = (ctx: ComposedContext): string => {
  const locale = ctx.locale
  const accounts = ctx.accounts ?? []
  return `<section data-account-backups="true">
    <p class="xp-prose">${tx(locale, ['The archive is stored in the local backup directory and restored only into that account home.', 'يُحفظ الأرشيف في مجلد النسخ المحلي ويُستعاد إلى مجلد ذلك الحساب فقط.'])}</p>
    <div class="xp-field"><label class="xp-label" for="backup-account">${tx(locale, ['Account', 'الحساب'])}</label><select id="backup-account" class="xp-select" data-backup-account="true">${accounts.map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>
    <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${tx(locale, ['File', 'الملف'])}</th><th>${tx(locale, ['Size', 'الحجم'])}</th><th>${tx(locale, ['Action', 'إجراء'])}</th></tr></thead><tbody data-backup-files="true"></tbody></table></div>
    <p class="xp-help" data-backup-status role="status"></p>
    <button type="button" class="xp-btn xp-btn--primary" data-backup-create="true">${tx(locale, ['Create backup', 'إنشاء نسخة'])}</button>
  </section>`
}

const hostInfoBody = (locale: Locale): string =>
  `<div data-host-info="true"><dl class="xp-board-stats">
    <div><dt>${tx(locale, ['Load', 'الحمل'])}</dt><dd data-host-load="true">${tx(locale, ['Reading', 'جار القراءة'])}</dd></div>
    <div><dt>${tx(locale, ['Memory', 'الذاكرة'])}</dt><dd data-host-memory="true">${tx(locale, ['Reading', 'جار القراءة'])}</dd></div>
    <div><dt>${tx(locale, ['Disk', 'القرص'])}</dt><dd data-host-disk="true">${tx(locale, ['Reading', 'جار القراءة'])}</dd></div>
  </dl><p class="xp-help" data-host-info-status role="status"></p></div>`

const dashboardBody = (spec: ComposedRoute, ctx: ComposedContext): string => {
  const locale = ctx.locale
  if (spec.bind === 'panel-usage') return usageBody(ctx)
  if (spec.bind === 'io') {
    return ctx.ioSnapshot
      ? renderServerIoMonitorChart(ctx.ioSnapshot, locale)
      : emptyBlock(locale, ['No IO sample was read', 'لم تُقرأ عينة قرص'], ['Disk IO is not shown until the host returns a sample. It is not shown as zero.', 'لا تُعرض عمليات القرص إلى أن يعيد المضيف عينة. لا تُعرض كصفر.'], true)
  }
  if (spec.bind === 'host-info') return hostInfoBody(locale)
  if (spec.bind === 'web-stats') return metricsBody(spec, ctx)
  return `${emptyBlock(locale, ['No sample was read', 'لم تُقرأ عينة'], ['Meters stay empty until the host reports them. They are not filled with zero.', 'تبقى المقاييس فارغة إلى أن يبلغ عنها المضيف. لا تُملأ بالصفر.'])}
    ${card('composed-dash', locale, spec.title, table(locale, spec.columns, [], ['No rows were read', 'لم تُقرأ صفوف']))}`
}

const bodyFor = (spec: ComposedRoute, ctx: ComposedContext): string => {
  if (spec.bind === 'terminal' || spec.layout === 'terminal') return terminalBody(ctx)
  if (spec.bind === 'ips') return ipsBody(ctx)
  if (spec.bind === 'generations') return generationsBody(ctx)
  if (spec.bind === 'backups') return backupsBody(ctx)
  if (spec.bind === 'host-info') return hostInfoBody(ctx.locale)
  switch (spec.layout) {
    case 'files':
      return filesBody(spec, ctx)
    case 'site':
      return siteBody(spec, ctx)
    case 'database':
    case 'launch':
      return databaseBody(spec, ctx)
    case 'metrics':
      return metricsBody(spec, ctx)
    case 'ssl':
      return sslBody(spec, ctx)
    case 'security':
    case 'php':
    case 'cron':
    case 'settings':
      return settingsBody(spec, ctx)
    case 'editor':
      return `${emptyBlock(ctx.locale, ['The editor is empty', 'المحرر فارغ'], ['Nothing is loaded until the file tool returns this path.', 'لا يُحمّل شيء إلى أن تعيد أداة الملفات هذا المسار.'])}<textarea class="xp-textarea xp-mono" dir="ltr" rows="8" disabled data-wiring="soon" aria-label="${tx(ctx.locale, spec.title)}"></textarea>`
    case 'log':
      return `${fields(spec.route, ctx.locale, spec.fields)}${card('composed-log', ctx.locale, spec.title, table(ctx.locale, spec.columns, [], ['No entries were read', 'لم تُقرأ مدخلات']))}`
    case 'wizard':
      return card('composed-wizard', ctx.locale, spec.title, `${fields(spec.route, ctx.locale, spec.fields)}${emptyBlock(ctx.locale, ['Nothing is waiting to publish', 'لا شيء بانتظار النشر'], ['This wizard does not store a draft until the tool is connected.', 'لا يحفظ هذا المعالج مسودة إلى أن تُوصل الأداة.'])}`)
    case 'matrix':
    case 'list':
      return listBody(spec, ctx)
    case 'dashboard':
      return dashboardBody(spec, ctx)
    default:
      return emptyBlock(ctx.locale, ['Nothing is stored for this screen', 'لا شيء محفوظ لهذه الشاشة'])
  }
}

const wiringFor = (spec: ComposedRoute, ctx: ComposedContext): 'live' | 'soon' => {
  if (spec.bind === 'soon' || spec.bind === 'git') return 'soon'
  if (spec.bind === 'site-settings') return ctx.customConfig ? 'live' : 'soon'
  if (spec.bind === 'mail-ips') return ctx.mailIpConfig ? 'live' : 'soon'
  if (spec.bind === 'io') return ctx.ioSnapshot ? 'live' : 'soon'
  if (spec.bind === 'web-stats') return ctx.websiteAnalytics ? 'live' : 'soon'
  if (spec.bind === 'panel-usage') return ctx.usage ? 'live' : 'soon'
  return 'live'
}

export const renderComposedRoutes = (routes: readonly ComposedRoute[], ctx: ComposedContext & { route: string }): string | undefined => {
  const spec = routes.find(item => item.route === ctx.route)
  if (!spec) return undefined
  return frame(spec, ctx, bodyFor(spec, ctx), wiringFor(spec, ctx))
}
