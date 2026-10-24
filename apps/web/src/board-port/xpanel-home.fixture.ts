// Board sample data for tests and the local fidelity script only.
// Product code must not import this module; xpanel-home.test.ts enforces that.
import {
  HOME_SCRIPT, MONO, groupViews, infoRows, mono, monoSpan, navViews, num, plain, renderDesktop, renderPhone,
  renderXpanelHome, totalCount, word, xpanelHomeFromProps,
  type Hint, type HomeChange, type HomeDesktopModel, type HomeMeter, type HomePhoneModel, type ToolDef,
} from './xpanel-home.ts'

const SAMPLE_HINTS: Record<string, [desk: Hint, phone: Hint, ar: Hint]> = {
  'files.manager': [mono('/home/alice'), plain(''), mono('/home/alice')],
  'files.backup': [plain('Last 2026-10-21'), plain('2026-10-21'), word('آخر نسخة 2026-10-21')],
  'files.ftp': [plain('2 users'), plain('2'), word('مستخدمان')],
  'files.disk': [plain('3.2 / 10 GB'), plain('3.2 / 10 GB'), num('3.2 / 10 GB')],
  'files.trash': [plain('6 items'), plain('6 items'), word('6 عناصر')],
  'db.list': [plain('3 / 5'), plain('3 / 5'), num('3 / 5')],
  'db.users': [plain('2 users'), plain('2'), word('مستخدمان')],
  'db.trash': [plain('Empty'), plain('Empty'), word('فارغة')],
  'domains.list': [plain('2 / 5 addon'), plain('2 / 5'), num('2 / 5')],
  'domains.site': [plain('3 sites'), plain('3 sites'), word('3 مواقع')],
  'domains.zone': [plain('3 zones'), plain('3 zones'), word('3 مناطق')],
  'domains.redirect': [plain('1 active'), plain('1'), word('تحويل واحد')],
  'email.accounts': [plain('7 / 25'), plain('7 / 25'), num('7 / 25')],
  'email.forward': [plain('4'), plain('4'), num('4')],
  'email.filters': [plain('2'), plain('2'), num('2')],
  'email.webmail': [plain('Open'), plain(''), word('افتح')],
  'metrics.visitors': [plain('1,431 today'), plain('1,431 today'), word('1,431 اليوم')],
  'metrics.errors': [plain(''), plain(''), word('')],
  'metrics.bandwidth': [plain('86 / 100 GB'), plain('86 / 100 GB'), num('86 / 100 GB')],
  'metrics.logs': [plain('30 days'), plain(''), word('30 يومًا')],
  'security.ssl': [plain('AutoSSL on'), plain('AutoSSL on'), word('AutoSSL مفعّل')],
  'security.2fa': [plain('On'), plain('On'), word('مفعّلة')],
  'security.api': [plain('1 token'), plain('1'), word('رمز واحد')],
  'security.path': [plain('None'), plain(''), word('لا يوجد')],
  'software.php': [mono('8.3 · FPM'), mono('8.3'), mono('8.3 · FPM')],
  'software.ini': [mono('.user.ini'), plain(''), mono('.user.ini')],
  'software.htaccess': [plain(''), plain(''), word('')],
  'software.apps': [plain('1 app'), plain('1'), word('تطبيق واحد')],
  'advanced.cron': [plain('3 jobs'), plain('3'), word('3 مهام')],
  'advanced.resources': [plain(''), plain(''), word('')],
  'advanced.processes': [plain('38 / 128'), plain('38 / 128'), num('38 / 128')],
  'advanced.logs': [plain(''), plain(''), word('')],
  'prefs.language': [plain('English'), plain('English'), word('العربية')],
  'prefs.password': [plain(''), plain(''), word('')],
  'prefs.contact': [plain('Verified'), plain(''), word('مُوثَّق')],
}

const sampleHints = (ar: boolean, phone: boolean) => (item: ToolDef): Hint => {
  const hint = SAMPLE_HINTS[item.id]
  if (!hint) throw new Error(`no sample hint for ${item.id}`)
  return ar ? hint[2] : phone ? hint[1] : hint[0]
}

const signInSample = (ar: boolean): string => ar
  ? `<bdi dir="ltr" style="font-size: 13px; font-variant-numeric: tabular-nums">2026-10-22 13:41 UTC</bdi><span style="font-size: 12px; color: #5D6B7E">من <bdi dir="ltr" style="font-family: ${MONO}">198.51.100.24</bdi></span>`
  : `<span style="font-size: 13px; font-variant-numeric: tabular-nums">2026-10-22 13:41 UTC</span><span style="font-size: 12px; color: #5D6B7E">from <span style="font-family: ${MONO}">198.51.100.24</span></span>`

const sampleChanges = (ar: boolean): HomeChange[] => ar
  ? [
      { pill: 'مُطبَّق', pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: `<bdi dir="ltr">PHP 8.3</bdi> للنطاق <bdi dir="ltr" style="font-family: ${MONO}; font-size: 13px">alice-blog.net</bdi>`, detailHtml: `الجيل 142 · نجح <bdi dir="ltr"><code style="font-family: ${MONO}">apachectl configtest</code></bdi> · <bdi dir="ltr">2026-10-22 13:52 UTC</bdi>` },
      { pill: 'مُطبَّق', pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: `إنشاء الصندوق <bdi dir="ltr" style="font-family: ${MONO}; font-size: 13px">orders@alice-shop.com</bdi>`, detailHtml: `الجيل 141 · <bdi dir="ltr">2026-10-21 18:07 UTC</bdi>` },
      { pill: 'فشل الاختبار', pillBg: '#FDECEA', pillFg: '#B42318', titleHtml: `قاعدة إعادة كتابة للنطاق <bdi dir="ltr" style="font-family: ${MONO}; font-size: 13px">alice-studio.org</bdi>`, detailHtml: `<bdi dir="ltr"><code style="font-family: ${MONO}">apachectl configtest</code>: RewriteRule: bad flag delimiters</bdi>. بقي الجيل 140 فعّالًا ولم يُعَد تحميل أي خدمة · <bdi dir="ltr">2026-10-20 09:14 UTC</bdi>`, actionHref: '/domains/site-settings', actionLabel: 'أصلح القاعدة في إعدادات الموقع' },
    ]
  : [
      { pill: 'Applied', pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: `PHP 8.3 for <span style="font-family: ${MONO}; font-size: 13px">alice-blog.net</span>`, detailHtml: `Generation 142 · <code style="font-family: ${MONO}">apachectl configtest</code> passed · 2026-10-22 13:52 UTC` },
      { pill: 'Applied', pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: `Mailbox <span style="font-family: ${MONO}; font-size: 13px">orders@alice-shop.com</span> created`, detailHtml: 'Generation 141 · 2026-10-21 18:07 UTC' },
      { pill: 'Test failed', pillBg: '#FDECEA', pillFg: '#B42318', titleHtml: `Rewrite rule for <span style="font-family: ${MONO}; font-size: 13px">alice-studio.org</span>`, detailHtml: `<code style="font-family: ${MONO}">apachectl configtest</code>: RewriteRule: bad flag delimiters. Generation 140 stayed active, nothing was reloaded · 2026-10-20 09:14 UTC`, actionHref: '/domains/site-settings', actionLabel: 'Fix the rule in site settings' },
    ]

const sampleBanner = (ar: boolean): string => ar
  ? 'استهلكت <bdi dir="ltr">86</bdi> من <bdi dir="ltr">100 GB</bdi> من حركة البيانات الشهرية. يُصفَّر العدّاد في <bdi dir="ltr">2026-11-01 00:00 UTC</bdi>.'
  : 'You have used 86 of 100 GB monthly bandwidth. The counter resets on 2026-11-01 00:00 UTC.'

const sampleMeters = (ar: boolean): HomeMeter[] => {
  const rows: Array<[string, string, string, number, string]> = ar
    ? [
        ['القرص', '3.2 / 10 GB', '3.2 / 10 GB', 32, 'حصة نظام الملفات مطبّقة'],
        ['حركة البيانات الشهرية', '86 / 100 GB', '86 / 100 GB', 86, 'تجاوزت 80% · تُصفَّر في 2026-11-01'],
        ['سقف الكتابة على القرص', '20 MB/s', '20 MB/s', 21, 'الكتابة الآن 4.1 MB/s · io.max على شريحتك'],
        ['الذاكرة', '412 / 1024 MB', '412 / 1024 MB', 40, 'MemoryMax على شريحتك'],
        ['العمليات', '38 / 128', '38 / 128', 30, 'TasksMax على شريحتك · الخيوط محسوبة'],
        ['النطاقات الإضافية', '2 / 5', '2 / 5', 40, 'يمكنك إضافة 3 نطاقات'],
        ['صناديق البريد', '7 / 25', '7 / 25', 28, 'يمكنك إضافة 18 صندوقًا'],
        ['قواعد البيانات', '3 / 5', '3 / 5', 60, 'يمكنك إضافة قاعدتين'],
      ]
    : [
        ['Disk', '3.2 / 10 GB', '3.2 / 10 GB', 32, 'Filesystem quota enforced'],
        ['Monthly bandwidth', '86 / 100 GB', '86 / 100 GB', 86, 'Over 80% · resets 2026-11-01'],
        ['IO write cap', '20 MB/s', '20 MB/s', 21, 'Writing 4.1 MB/s now · io.max on your slice'],
        ['Memory', '412 / 1024 MB', '412 / 1024 MB', 40, 'MemoryMax on your slice'],
        ['Processes', '38 / 128', '38 / 128', 30, 'TasksMax on your slice · threads count'],
        ['Addon domains', '2 / 5', '2 / 5', 40, '3 more allowed'],
        ['Mailboxes', '7 / 25', '7 / 25', 28, '18 more allowed'],
        ['Databases', '3 / 5', '3 / 5', 60, '2 more allowed'],
      ]
  return rows.map(row => ({ label: row[0], value: row[1], pct: row[3], note: row[4] }))
}

const samplePhoneMeters = (): HomeMeter[] => [
  { label: 'Monthly bandwidth', value: '86 / 100 GB', pct: 86, note: 'Over 80%' },
  { label: 'Disk', value: '3.2 / 10 GB', pct: 32, note: '32% used' },
  { label: 'Processes', value: '38 / 128', pct: 30, note: 'TasksMax 128' },
  { label: 'Memory', value: '412 / 1024 MB', pct: 40, note: 'MemoryMax 1024 MB' },
  { label: 'Mailboxes', value: '7 / 25', pct: 28, note: '18 more allowed' },
  { label: 'Databases', value: '3 / 5', pct: 60, note: '2 more allowed' },
  { label: 'Addon domains', value: '2 / 5', pct: 40, note: '3 more allowed' },
]

const ledeSample = (ar: boolean): string => ar
  ? `أدوات ${monoSpan('alice-shop.com', true)} ونطاقين إضافيين. قائمة ميزات خطتك تحدد الأدوات التي تظهر هنا.`
  : `Tools for ${monoSpan('alice-shop.com', false)} and 2 addon domains. Your plan’s feature list decides which tools appear here.`

const phoneLedeSample = (): string =>
  `${monoSpan('alice-shop.com', false)} · Business plan · ${monoSpan('uid 20014', false)}`

export const xpanelHomeFixture = (): HomeDesktopModel => {
  const groups = groupViews(false, false, sampleHints(false, false))
  return {
    ar: false,
    username: 'alice', domain: 'alice-shop.com', planLabel: 'Business',
    diskLabel: 'Disk', diskValue: '3.2 / 10 GB', diskPct: 32,
    procLabel: 'Processes', procValue: '38 / 128', procPct: 30,
    nav: navViews(false, 'nav-group-'),
    title: 'Home', ledeHtml: ledeSample(false),
    pill: { label: 'Applied', bg: '#E7F5EE', fg: '#0E7A4E' },
    generationHtml: '<span style="font-variant-numeric: tabular-nums">Generation 142 · 2026-10-22 13:52 UTC</span>',
    bannerHtml: sampleBanner(false), bannerHref: '/metrics/traffic', bannerLabel: 'See bandwidth by domain',
    countText: totalCount(groups, false, false), groups,
    infoTitle: 'General information',
    info: infoRows({ ar: false, username: 'alice', uid: 20014, domain: 'alice-shop.com', home: '/home/alice', ipv4: '10.0.0.12', plan: 'Business', php: '8.3 · PHP-FPM', slice: 'xpanel-20014.slice', signInHtml: signInSample(false) }),
    usageTitle: 'Resource usage', usageLink: 'Details', meters: sampleMeters(false),
    changesTitle: 'Recent changes', changes: sampleChanges(false), emptyChanges: '',
    metricsUnavailable: false, actionHtml: '',
  }
}

export const xpanelHomeFixtureAr = (): HomeDesktopModel => {
  const groups = groupViews(true, false, sampleHints(true, false))
  return {
    ar: true,
    username: 'alice', domain: 'alice-shop.com', planLabel: 'Business',
    diskLabel: 'القرص', diskValue: '3.2 / 10 GB', diskPct: 32,
    procLabel: 'العمليات', procValue: '38 / 128', procPct: 30,
    nav: navViews(true, 'nav-group-'),
    title: 'الرئيسية', ledeHtml: ledeSample(true),
    pill: { label: 'مُطبَّق', bg: '#E7F5EE', fg: '#0E7A4E' },
    generationHtml: `<span>الجيل 142 · <bdi dir="ltr" style="font-variant-numeric: tabular-nums">2026-10-22 13:52 UTC</bdi></span>`,
    bannerHtml: sampleBanner(true), bannerHref: '/metrics/traffic', bannerLabel: 'اعرض الاستهلاك لكل نطاق',
    countText: totalCount(groups, true, false), groups,
    infoTitle: 'معلومات عامة',
    info: infoRows({ ar: true, username: 'alice', uid: 20014, domain: 'alice-shop.com', home: '/home/alice', ipv4: '10.0.0.12', plan: 'Business', php: '8.3 · PHP-FPM', slice: 'xpanel-20014.slice', signInHtml: signInSample(true) }),
    usageTitle: 'استخدام الموارد', usageLink: 'التفاصيل', meters: sampleMeters(true),
    changesTitle: 'آخر التغييرات', changes: sampleChanges(true), emptyChanges: '',
    metricsUnavailable: false, actionHtml: '',
  }
}

export const xpanelHomeFixturePhone = (): HomePhoneModel => {
  const groups = groupViews(false, true, sampleHints(false, true)).map((group, index) => ({ ...group, open: index === 0 }))
  return {
    ar: false, username: 'alice', domain: 'alice-shop.com', planLabel: 'Business',
    title: 'Home', titleTag: 'h1', ledeHtml: phoneLedeSample(),
    countText: totalCount(groups, false, true), groups, meters: samplePhoneMeters(),
    nav: navViews(false, 'm-nav-group-'), metricsUnavailable: false, actionHtml: '',
  }
}

const documentShell = (body: string, locale: 'en' | 'ar', title: string): string => {
  return `<!doctype html>
<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans','IBM Plex Sans Arabic',system-ui,sans-serif}
*{box-sizing:border-box}
a{color:#1D5BD6}a:hover{color:#1546A8}
:focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
</style>
</head>
<body>
${body}
</body>
</html>`
}

export const renderFidelityDocument = (kind: 'ltr' | 'ar' | 'phone' = 'ltr'): string => {
  if (kind === 'phone') return documentShell(`${renderPhone(xpanelHomeFixturePhone())}${HOME_SCRIPT}`, 'en', 'Home on phone — xPanel')
  if (kind === 'ar') return documentShell(`${renderDesktop(xpanelHomeFixtureAr())}${HOME_SCRIPT}`, 'ar', 'الرئيسية — xPanel')
  return documentShell(`${renderDesktop(xpanelHomeFixture())}${HOME_SCRIPT}`, 'en', 'Home — xPanel')
}

/** Live-shaped home for no-scroll and truth checks. Not the board sample. */
export const liveShapedHome = (kind: 'ltr' | 'ar' | 'phone' = 'ltr') => {
  const locale = kind === 'ar' ? 'ar' : 'en'
  return xpanelHomeFromProps({
    locale,
    account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
  })
}

export const renderLiveDocument = (kind: 'ltr' | 'ar' | 'phone' = 'ltr'): string => {
  const locale = kind === 'ar' ? 'ar' : 'en'
  const model = liveShapedHome(kind)
  if (kind === 'phone') return documentShell(`${renderPhone({ ...model.phone, titleTag: 'h1' })}${HOME_SCRIPT}`, 'en', 'Home on phone — xPanel')
  return documentShell(renderXpanelHome(model), locale, locale === 'ar' ? 'الرئيسية — xPanel' : 'Home — xPanel')
}
