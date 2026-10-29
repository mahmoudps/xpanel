// Board sample data for tests and the local fidelity script only.
// Product code must not import this module; xpanel-home.test.ts enforces that.
import {
  HOME_SCRIPT, MONO, groupViews, homeLede, infoRows, mono, monoSpan, navViews, num, plain, renderDesktop, renderPhone,
  renderXpanelHome, totalCount, xpanelHomeFromProps,
  type Hint, type HomeChange, type HomeDesktopModel, type HomeMeter, type HomePhoneModel, type ToolDef,
} from './xpanel-home.ts'
import { inlineScriptMessageKeys, localeDirection, localeInfo, renderClientI18nScript, translator, type Locale } from '../i18n.ts'
const sampleHints = (locale: Locale, phone: boolean) => {
  const t = translator(locale)
  const dir = localeDirection(locale)
  // Sample words read in the page language and direction; numbers and paths stay LTR.
  const say = (message: string): Hint => ({ text: t(message), mono: false, dir })
  const blank: Hint = { text: '', mono: false, dir }
  const hints: Record<string, [desk: Hint, phone: Hint]> = {
    'files.manager': [mono('/home/alice'), plain('')],
    'files.backup': [say(msgid('Last 2026-10-21')), plain('2026-10-21')],
    'files.ftp': [say(msgid('2 users')), plain('2')],
    'files.disk': [plain('3.2 / 10 GB'), plain('3.2 / 10 GB')],
    'files.trash': [say(msgid('6 items')), say(msgid('6 items'))],
    'db.list': [plain('3 / 5'), plain('3 / 5')],
    'db.users': [say(msgid('2 users')), plain('2')],
    'db.trash': [say(msgctxt('xpanel-home.fixture', 'Empty')), say(msgctxt('xpanel-home.fixture', 'Empty'))],
    'domains.list': [num(t(msgid('2 / 5 addon'))), plain('2 / 5')],
    'domains.site': [say(msgid('3 sites')), say(msgid('3 sites'))],
    'domains.zone': [say(msgid('3 zones')), say(msgid('3 zones'))],
    'domains.redirect': [say(msgid('1 active')), plain('1')],
    'email.accounts': [plain('7 / 25'), plain('7 / 25')],
    'email.forward': [plain('4'), plain('4')],
    'email.filters': [plain('2'), plain('2')],
    'email.webmail': [say(msgctxt('xpanel-home', 'Open')), plain('')],
    'metrics.visitors': [say(msgid('1,431 today')), say(msgid('1,431 today'))],
    'metrics.errors': [blank, blank],
    'metrics.bandwidth': [plain('86 / 100 GB'), plain('86 / 100 GB')],
    'metrics.logs': [say(msgid('30 days')), plain('')],
    'security.ssl': [say(msgid('AutoSSL on')), say(msgid('AutoSSL on'))],
    'security.2fa': [say(msgctxt('xpanel-home.fixture', 'On')), say(msgctxt('xpanel-home.fixture', 'On'))],
    'security.api': [say(msgid('1 token')), plain('1')],
    'security.path': [say(msgid('None')), plain('')],
    'software.php': [mono('8.3 · FPM'), mono('8.3')],
    'software.ini': [mono('.user.ini'), plain('')],
    'software.htaccess': [blank, blank],
    'software.apps': [say(msgid('1 app')), plain('1')],
    'advanced.cron': [say(msgid('3 jobs')), plain('3')],
    'advanced.resources': [blank, blank],
    'advanced.processes': [plain('38 / 128'), plain('38 / 128')],
    'advanced.logs': [blank, blank],
    'prefs.language': [{ text: localeInfo(locale).nativeName, mono: false, dir }, { text: localeInfo(locale).nativeName, mono: false, dir }],
    'prefs.password': [blank, blank],
    'prefs.contact': [say(msgctxt('xpanel-home.fixture', 'Verified')), plain('')],
  }
  return (item: ToolDef): Hint => {
    const hint = hints[item.id]
    if (!hint) throw new Error(`no sample hint for ${item.id}`)
    return phone ? hint[1] : hint[0]
  }
}

/** Wraps an LTR value in an isolate on RTL pages; on LTR pages it keeps the plain styled span. */
const isolator = (locale: Locale) => (html: string, style = ''): string => localeDirection(locale) === 'rtl'
  ? `<bdi dir="ltr"${style ? ` style="${style}"` : ''}>${html}</bdi>`
  : style ? `<span style="${style}">${html}</span>` : html

const signInSample = (locale: Locale): string => {
  const iso = isolator(locale)
  return `${iso('2026-10-22 13:41 UTC', 'font-size: 13px; font-variant-numeric: tabular-nums')}<span style="font-size: 12px; color: #5D6B7E">${translator(locale)('from {address}', { address: iso('198.51.100.24', `font-family: ${MONO}`) })}</span>`
}

const sampleChanges = (locale: Locale): HomeChange[] => {
  const t = translator(locale)
  const iso = isolator(locale)
  const name = (value: string): string => iso(value, `font-family: ${MONO}; font-size: 13px`)
  const configtest = `<code style="font-family: ${MONO}">apachectl configtest</code>`
  const applied = t(msgctxt('xpanel-home.fixture', 'Applied'))
  return [
    { pill: applied, pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: t('{php} for {domain}', { php: iso('PHP 8.3'), domain: name('alice-blog.net') }), detailHtml: t('Generation {id} · {command} passed · {time}', { id: 142, command: iso(configtest), time: iso('2026-10-22 13:52 UTC') }) },
    { pill: applied, pillBg: '#E7F5EE', pillFg: '#0E7A4E', titleHtml: t('Mailbox {address} created', { address: name('orders@alice-shop.com') }), detailHtml: t('Generation {id} · {time}', { id: 141, time: iso('2026-10-21 18:07 UTC') }) },
    { pill: t('Test failed'), pillBg: '#FDECEA', pillFg: '#B42318', titleHtml: t('Rewrite rule for {domain}', { domain: name('alice-studio.org') }), detailHtml: t('{error}. Generation {id} stayed active, nothing was reloaded · {time}', { error: iso(`${configtest}: RewriteRule: bad flag delimiters`), id: 140, time: iso('2026-10-20 09:14 UTC') }), actionHref: '/domains/site-settings', actionLabel: t('Fix the rule in site settings') },
  ]
}

const sampleBanner = (locale: Locale): string => {
  const iso = isolator(locale)
  return translator(locale)('You have used {used} of {limit} monthly bandwidth. The counter resets on {time}.', { used: iso('86'), limit: iso('100 GB'), time: iso('2026-11-01 00:00 UTC') })
}

const sampleMeters = (locale: Locale): HomeMeter[] => {
  const t = translator(locale)
  const rows: Array<[label: string, value: string, pct: number, note: string]> = [
    [msgid('Disk'), '3.2 / 10 GB', 32, msgid('Filesystem quota enforced')],
    [msgid('Monthly bandwidth'), '86 / 100 GB', 86, msgid('Over 80% · resets 2026-11-01')],
    [msgid('IO write cap'), '20 MB/s', 21, msgid('Writing 4.1 MB/s now · io.max on your slice')],
    [msgid('Memory'), '412 / 1024 MB', 40, msgid('MemoryMax on your slice')],
    [msgid('Processes'), '38 / 128', 30, msgid('TasksMax on your slice · threads count')],
    [msgid('Addon domains'), '2 / 5', 40, msgid('3 more allowed')],
    [msgid('Mailboxes'), '7 / 25', 28, msgid('18 more allowed')],
    [msgid('Databases'), '3 / 5', 60, msgid('2 more allowed')],
  ]
  return rows.map(([label, value, pct, note]) => ({ label: t(label), value, pct, note: t(note) }))
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

const generationSample = (locale: Locale): string => {
  const t = translator(locale)
  return localeDirection(locale) === 'rtl'
    ? `<span>${t('Generation {id} · {time}', { id: 142, time: '<bdi dir="ltr" style="font-variant-numeric: tabular-nums">2026-10-22 13:52 UTC</bdi>' })}</span>`
    : `<span style="font-variant-numeric: tabular-nums">${t('Generation {id} · {time}', { id: 142, time: '2026-10-22 13:52 UTC' })}</span>`
}

const phoneLedeSample = (): string =>
  `${monoSpan('alice-shop.com', false)} · Business plan · ${monoSpan('uid 20014', false)}`

const desktopFixture = (locale: Locale): HomeDesktopModel => {
  const t = translator(locale)
  const groups = groupViews(locale, false, sampleHints(locale, false))
  return {
    locale,
    username: 'alice', domain: 'alice-shop.com', planLabel: 'Business',
    diskLabel: t('Disk'), diskValue: '3.2 / 10 GB', diskPct: 32,
    procLabel: t('Processes'), procValue: '38 / 128', procPct: 30,
    nav: navViews(locale, 'nav-group-'),
    title: t('Home'), ledeHtml: homeLede(locale, monoSpan('alice-shop.com', localeDirection(locale) === 'rtl'), 2),
    pill: { label: t(msgctxt('xpanel-home.fixture', 'Applied')), bg: '#E7F5EE', fg: '#0E7A4E' },
    generationHtml: generationSample(locale),
    bannerHtml: sampleBanner(locale), bannerHref: '/metrics/traffic', bannerLabel: t('See bandwidth by domain'),
    countText: totalCount(groups, locale, false), groups,
    infoTitle: t('General information'),
    info: infoRows({ locale, username: 'alice', uid: 20014, domain: 'alice-shop.com', home: '/home/alice', ipv4: '10.0.0.12', plan: 'Business', php: '8.3 · PHP-FPM', slice: 'xpanel-20014.slice', signInHtml: signInSample(locale) }),
    usageTitle: t('Resource usage'), usageLink: t('Details'), meters: sampleMeters(locale),
    changesTitle: t('Recent changes'), changes: sampleChanges(locale), emptyChanges: '',
    metricsUnavailable: false, actionHtml: '',
  }
}

export const xpanelHomeFixture = (): HomeDesktopModel => desktopFixture('en')

export const xpanelHomeFixtureAr = (): HomeDesktopModel => desktopFixture('ar')

export const xpanelHomeFixturePhone = (): HomePhoneModel => {
  const groups = groupViews('en', true, sampleHints('en', true)).map((group, index) => ({ ...group, open: index === 0 }))
  return {
    locale: 'en', username: 'alice', domain: 'alice-shop.com', planLabel: 'Business',
    title: 'Home', titleTag: 'h1', ledeHtml: phoneLedeSample(),
    countText: totalCount(groups, 'en', true), groups, meters: samplePhoneMeters(),
    nav: navViews('en', 'm-nav-group-'), metricsUnavailable: false, actionHtml: '',
  }
}

const documentShell = (body: string, locale: Locale, title: string): string => {
  return `<!doctype html>
<html lang="${locale}" dir="${localeDirection(locale)}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{margin:0;background:#F5F6F8;color:#101828;font-family:'IBM Plex Sans',sans-serif}
*{box-sizing:border-box}
a{color:#1D5BD6}a:hover{color:#1546A8}
:focus-visible{outline:2px solid #1D5BD6;outline-offset:2px}
</style>
${renderClientI18nScript(locale, inlineScriptMessageKeys(body))}
</head>
<body>
${body}
</body>
</html>`
}

export const renderFidelityDocument = (kind: 'ltr' | 'ar' | 'phone' = 'ltr'): string => {
  if (kind === 'phone') return documentShell(`${renderPhone(xpanelHomeFixturePhone())}${HOME_SCRIPT}`, 'en', 'Home on phone — xPanel')
  if (kind === 'ar') return documentShell(`${renderDesktop(xpanelHomeFixtureAr())}${HOME_SCRIPT}`, 'ar', translator('ar')('Home — xPanel'))
  return documentShell(`${renderDesktop(xpanelHomeFixture())}${HOME_SCRIPT}`, 'en', 'Home — xPanel')
}

export const renderLiveDocument = (kind: 'ltr' | 'ar' | 'phone' = 'ltr'): string => {
  const locale: Locale = kind === 'ar' ? 'ar' : 'en'
  const model = xpanelHomeFromProps({
    locale,
    account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
  })
  if (kind === 'phone') return documentShell(`${renderPhone({ ...model.phone, titleTag: 'h1' })}${HOME_SCRIPT}`, 'en', 'Home on phone — xPanel')
  return documentShell(renderXpanelHome(model), locale, translator(locale)('Home — xPanel'))
}
