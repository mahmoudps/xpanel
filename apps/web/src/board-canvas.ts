import type { Limit } from '@xpanel/core'
import type { Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

type Copy = readonly [english: string, arabic: string]

const tx = (locale: Locale, copy: Copy): string => (locale === 'ar' ? copy[1] : copy[0])
const h = (value: string): string => escapeHtml(value)

const soon: Copy = ['Coming soon', 'قيد التفعيل']
const unavailable: Copy = ['Unavailable', 'غير متاح']
const zero: Copy = ['0', '0']

const soonBtn = (locale: Locale, label: Copy, quiet = false): string =>
  `<button type="button" class="xp-btn${quiet ? '' : ' xp-btn--primary'}" disabled data-wiring="soon">${h(tx(locale, label))}</button><p class="xp-help" data-wiring-hint="soon">${h(tx(locale, soon))}</p>`

const empty = (locale: Locale, title: Copy, body?: Copy): string =>
  `<div class="xp-design-empty" role="status"><h3>${h(tx(locale, title))}</h3>${body ? `<p>${h(tx(locale, body))}</p>` : ''}</div>`

const card = (id: string, locale: Locale, title: Copy, body: string, lede?: Copy): string =>
  `<section class="xp-board-section" id="${id}" aria-labelledby="${id}-title"><header class="xp-board-section__head"><h2 id="${id}-title">${h(tx(locale, title))}</h2>${lede ? `<p>${h(tx(locale, lede))}</p>` : ''}</header><div class="xp-board-section__body">${body}</div></section>`

const table = (locale: Locale, headers: readonly Copy[], message: Copy): string =>
  `<div class="xp-table-wrap"><table class="xp-table"><thead><tr>${headers.map(column => `<th>${h(tx(locale, column))}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}">${h(tx(locale, message))}</td></tr></tbody></table></div>`

const field = (id: string, locale: Locale, label: Copy, type = 'text'): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><input id="${id}" class="xp-input" type="${type}" value="" disabled data-wiring="soon"></div>`

const select = (id: string, locale: Locale, label: Copy, options: readonly Copy[]): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><select id="${id}" class="xp-select" disabled data-wiring="soon">${options.map(option => `<option>${h(tx(locale, option))}</option>`).join('')}</select></div>`

const note = (locale: Locale, title: Copy, body: Copy): string =>
  `<aside class="xp-board-note" role="note"><h2>${h(tx(locale, title))}</h2><p>${h(tx(locale, body))}</p></aside>`

const legend = (locale: Locale, title: Copy, body: string): string =>
  `<fieldset class="xp-board-legend" disabled><legend>${h(tx(locale, title))}</legend>${body}</fieldset>`

const code = (text: string): string => `<pre class="xp-board-code"><code><bdi dir="ltr">${h(text)}</bdi></code></pre>`

const stats = (locale: Locale, items: readonly (readonly [Copy, Copy])[]): string =>
  `<dl class="xp-board-stats">${items.map(([label, value]) => `<div><dt>${h(tx(locale, label))}</dt><dd>${h(tx(locale, value))}</dd></div>`).join('')}</dl>`

const checks = (locale: Locale, items: readonly Copy[]): string =>
  `<ul class="xp-board-checks">${items.map(item => `<li><label><input type="checkbox" disabled data-wiring="soon"> ${h(tx(locale, item))}</label></li>`).join('')}</ul>`

const radios = (name: string, locale: Locale, items: readonly Copy[]): string =>
  `<div class="xp-board-radios">${items.map(item => `<label class="xp-radio-card"><input type="radio" name="${name}" disabled data-wiring="soon"> ${h(tx(locale, item))}</label>`).join('')}</div>`

const anchors = (locale: Locale, items: readonly (readonly [string, Copy])[]): string =>
  `<nav class="xp-board-anchors" aria-label="${h(tx(locale, ['On this page', 'في هذه الصفحة']))}">${items.map(([href, label]) => `<a href="#${href}">${h(tx(locale, label))}</a>`).join('')}</nav>`

const region = (route: string, body: string): string =>
  `<div class="xp-board-canvas" data-board-layout="${h(route)}">${body}</div>`

const backup = (locale: Locale): string => region('/files/backup', [
  legend(locale, ['What do you want to back up?', 'ماذا تريد نسخه؟'], checks(locale, [
    ['Home directory files', 'ملفات مجلد المنزل'],
    ['Databases', 'قواعد البيانات'],
    ['Mailboxes', 'صناديق البريد'],
    ['Mail config', 'إعداد البريد'],
  ])),
  note(locale, ['What a restore never does', 'ما لا تفعله الاستعادة'], ['A restore shows the difference first and never deletes a file that is missing from the archive.', 'تعرض الاستعادة الفرق أولًا ولا تحذف ملفًا غير موجود في الأرشيف.']),
  card('backup-dest', locale, ['Where should the archive go?', 'أين يذهب الأرشيف؟'], empty(locale, ['No destination is stored', 'لا وجه محفوظ'], ['No destination is stored until the backup tool is connected.', 'لا يُحفظ وجه إلى أن تُوصل أداة النسخ.'])),
  card('backup-archives', locale, ['Archives', 'الأرشيفات'], `${table(locale, [['Archive', 'الأرشيف'], ['Created', 'أُنشئ'], ['Size', 'الحجم'], ['Status', 'الحالة']], ['No archives yet', 'لا أرشيف بعد'])}${soonBtn(locale, ['Create backup', 'إنشاء نسخة'])}`),
].join(''))

const privacy = (locale: Locale): string => region('/files/directory-privacy', [
  card('privacy-list', locale, ['Directory privacy', 'خصوصية المجلد'], `${table(locale, [['Folder', 'المجلد'], ['Prompt shown', 'النص الظاهر'], ['Users', 'المستخدمون'], ['Status', 'الحالة']], ['No protected directories', 'لا مجلدات محمية'])}<p>${h(tx(locale, ['Protected folders are served over HTTPS only. Password files stay outside the public site.', 'تُخدم المجلدات المحمية عبر HTTPS فقط. تبقى ملفات كلمات المرور خارج الموقع العام.']))}</p>`),
  card('privacy-add', locale, ['Protect a folder', 'احمِ مجلدًا'], `<div class="xp-board-fields">${field('priv-path', locale, ['Folder', 'المجلد'])}${field('priv-realm', locale, ['Prompt shown', 'النص الظاهر'])}${field('priv-user', locale, ['First user', 'أول مستخدم'])}${field('priv-pass', locale, ['Password for this user', 'كلمة مرور هذا المستخدم'], 'password')}</div>${soonBtn(locale, ['Protect folder', 'احمِ المجلد'])}`),
].join(''))

const panelPhp = (locale: Locale): string => region('/software/php', [
  card('php-domain', locale, ['Domain and version', 'النطاق والإصدار'], `${empty(locale, ['No PHP selection yet', 'لا اختيار لـ PHP بعد'])}<div class="xp-board-fields">${field('php-domain', locale, ['Domain', 'النطاق'])}${select('php-version', locale, ['Version', 'الإصدار'], [['No version reported', 'لا إصدار مبلّغ عنه']])}${select('php-handler', locale, ['Handler', 'المعالج'], [['No handler reported', 'لا معالج مبلّغ عنه']])}</div>${soonBtn(locale, ['Save PHP settings', 'حفظ إعدادات PHP'])}`),
  card('php-pool', locale, ['PHP-FPM pool', 'مجمّع PHP'], `<div class="xp-board-fields">${field('php-mode', locale, ['Mode', 'الوضع'])}${field('php-children', locale, ['Max children', 'الحد الأقصى للعمليات'])}</div>`),
  card('php-ini', locale, ['INI values', 'قيم INI'], table(locale, [['Directive', 'التوجيه'], ['Value', 'القيمة']], ['No directives are stored for this site.', 'لا توجيهات محفوظة لهذا الموقع.'])),
  card('php-running', locale, ['Running now', 'ما يعمل الآن'], empty(locale, ['No process is reporting this selection.', 'لا عملية تبلغ عن هذا الاختيار.'])),
  card('php-disabled', locale, ['Disabled functions', 'الدوال المعطلة'], table(locale, [['Function', 'الدالة']], ['No function list is stored.', 'لا قائمة دوال محفوظة.'])),
].join(''))

const htaccess = (locale: Locale): string => region('/software/htaccess', [
  card('ht-file', locale, ['.htaccess', '.htaccess'], `${empty(locale, ['No .htaccess yet', 'لا ملف .htaccess بعد'])}${code('')}${soonBtn(locale, ['Save .htaccess', 'حفظ .htaccess'])}`),
  card('ht-php', locale, ['PHP settings in .htaccess', 'إعدادات PHP في الملف'], `<div class="xp-board-fields">${field('ht-memory', locale, ['memory_limit', 'memory_limit'])}${field('ht-time', locale, ['max_execution_time', 'max_execution_time'])}</div>`),
  card('ht-versions', locale, ['Versions', 'الإصدارات'], table(locale, [['Version', 'الإصدار'], ['Saved', 'حُفظ']], ['No saved versions yet.', 'لا إصدارات محفوظة بعد.'])),
  note(locale, ['What a save does', 'ماذا يفعل الحفظ'], ['Saving writes that one file. It does not run from this empty editor.', 'الحفظ يكتب هذا الملف وحده. لا شيء يعمل من هذا المحرر الفارغ.']),
].join(''))

const cron = (locale: Locale): string => region('/advanced/cron', [
  note(locale, ['How a job runs', 'كيف تعمل المهمة'], ['Each job runs as this account, inside its slice, through its own timer. Jobs share the plan limits.', 'تعمل كل مهمة بهذا الحساب، داخل شريحته، عبر مؤقتها. تتشارك المهام حدود الخطة.']),
  card('cron-jobs', locale, ['Scheduled jobs', 'المهام المجدولة'], `${table(locale, [['Job', 'المهمة'], ['Schedule', 'الجدول'], ['Command', 'الأمر'], ['Last run', 'آخر تشغيل'], ['Duration', 'المدة'], ['Next run', 'التشغيل التالي']], ['No cron jobs yet', 'لا مهام مجدولة'])}${empty(locale, ['No cron jobs yet', 'لا مهام مجدولة'], ['Pick a preset below, enter a command and add the job. It starts on its next scheduled time.', 'اختر إعدادًا جاهزًا أدناه، أدخل أمرًا وأضف المهمة. تبدأ في موعدها التالي.'])}`),
  card('cron-add', locale, ['Add a cron job', 'إضافة مهمة'], `${legend(locale, ['Schedule', 'الجدول'], select('cron-preset', locale, ['Common schedules', 'الجداول الشائعة'], [
    ['Every 5 minutes', 'كل 5 دقائق'],
    ['Every hour, on the hour', 'كل ساعة'],
    ['Twice a day', 'مرتين في اليوم'],
    ['Every day', 'كل يوم'],
    ['Every Sunday', 'كل أحد'],
    ['On the 1st of the month', 'في اليوم الأول من الشهر'],
    ['Custom schedule', 'جدول مخصص'],
  ]))}<div class="xp-board-fields">${field('cron-minute', locale, ['Minute', 'الدقيقة'])}${field('cron-hour', locale, ['Hour', 'الساعة'])}${field('cron-day', locale, ['Day', 'اليوم'])}${field('cron-month', locale, ['Month', 'الشهر'])}${field('cron-weekday', locale, ['Weekday', 'يوم الأسبوع'])}</div>${field('cron-command', locale, ['Command', 'الأمر'])}<p>${h(tx(locale, ['The preview shows the timer only after a schedule and a command are stored.', 'تظهر المعاينة بعد حفظ الجدول والأمر.']))}</p>${code('')}${soonBtn(locale, ['Add a cron job', 'إضافة مهمة'])}`),
  card('cron-mail', locale, ['Output email', 'بريد الناتج'], empty(locale, ['No output address is stored.', 'لا عنوان ناتج محفوظ.'])),
].join(''))

const setup = (locale: Locale): string => region('/whm/server/setup', [
  card('setup-host', locale, ['Detected on this host', 'ما كُشف على هذا المضيف'], `${empty(locale, ['Setup has not run', 'لم يبدأ الإعداد'])}${table(locale, [['Check', 'الفحص'], ['Result', 'النتيجة']], ['Setup has not run', 'لم يبدأ الإعداد'])}${soonBtn(locale, ['Continue setup', 'متابعة الإعداد'])}`),
  card('setup-php', locale, ['PHP handlers by engine', 'معالجات PHP حسب المحرك'], table(locale, [['Engine', 'المحرك'], ['Handler', 'المعالج']], ['Handlers appear when the setup tool is connected.', 'تظهر المعالجات عند وصل أداة الإعداد.'])),
].join(''))

const features = (locale: Locale): string => region('/whm/plans/features', [
  card('feat-lists', locale, ['Lists and the plans that use them', 'القوائم والخطط التي تستخدمها'], `${table(locale, [['List', 'القائمة'], ['Plans', 'الخطط'], ['Accounts', 'الحسابات']], ['No feature lists yet', 'لا قوائم ميزات بعد'])}${soonBtn(locale, ['Create feature list', 'إنشاء قائمة'])}`),
  card('feat-tools', locale, ['Tools by list', 'الأدوات حسب القائمة'], empty(locale, ['No tools are assigned until a list exists.', 'لا تُسند أدوات إلى أن توجد قائمة.'])),
  card('feat-dirty', locale, ['Unsaved changes', 'تغييرات غير محفوظة'], empty(locale, ['Nothing is waiting to be saved.', 'لا شيء بانتظار الحفظ.'])),
  note(locale, ['How lists apply', 'كيف تُطبَّق القوائم'], ['Turning a tool off hides it. It does not delete files, mail, or databases. Saving does nothing until the tool is connected.', 'إيقاف أداة يخفيها. لا يحذف الملفات أو البريد أو قواعد البيانات. الحفظ لا يفعل شيئًا إلى أن تُوصل الأداة.']),
].join(''))

const whmDomains = (locale: Locale): string => region('/whm/domains', [
  card('whm-domains', locale, ['Domains', 'النطاقات'], `<div class="xp-board-fields">${select('whm-domain-account', locale, ['Account', 'الحساب'], [['No accounts yet', 'لا حسابات بعد']])}${select('whm-domain-ssl', locale, ['SSL state', 'حالة SSL'], [['Any state', 'أي حالة'], ['Valid', 'سارية'], ['Missing', 'غير موجودة']])}${select('whm-domain-php', locale, ['PHP version', 'إصدار PHP'], [['Any version', 'أي إصدار']])}</div>${table(locale, [['Domain', 'النطاق'], ['Kind', 'النوع'], ['Account', 'الحساب'], ['Docroot', 'جذر المستندات'], ['PHP', 'PHP'], ['SSL', 'SSL'], ['Status', 'الحالة']], ['No server domains yet', 'لا نطاقات للخادم بعد'])}${soonBtn(locale, ['Add domain', 'إضافة نطاق'])}`),
  card('whm-default-site', locale, ['Default site for unbound names', 'الموقع الافتراضي للأسماء غير المرتبطة'], empty(locale, ['The default site is not set from this empty screen.', 'لا يُضبط الموقع الافتراضي من هذه الشاشة الفارغة.'])),
  note(locale, ['How a name finds its site', 'كيف يجد الاسم موقعه'], ['No route is stored until the domain tool is connected.', 'لا مسار محفوظ إلى أن تُوصل أداة النطاقات.']),
].join(''))

const dns = (locale: Locale): string => region('/whm/dns', [
  card('dns-zones', locale, ['Zones', 'المناطق'], `${table(locale, [['Zone', 'المنطقة'], ['Account', 'الحساب'], ['Records', 'السجلات'], ['Serial', 'التسلسل'], ['Status', 'الحالة']], ['No zones yet', 'لا مناطق بعد'])}${soonBtn(locale, ['Add zone', 'إضافة منطقة'])}`),
  card('dns-record', locale, ['Add a record', 'إضافة سجل'], `<div class="xp-board-fields">${field('dns-name', locale, ['Name', 'الاسم'])}${select('dns-type', locale, ['Type', 'النوع'], [['A', 'A'], ['AAAA', 'AAAA'], ['CNAME', 'CNAME'], ['MX', 'MX'], ['TXT', 'TXT']])}${field('dns-value', locale, ['Value', 'القيمة'])}${field('dns-ttl', locale, ['TTL', 'TTL'])}</div>${soonBtn(locale, ['Add a record', 'إضافة سجل'], true)}`),
  card('dns-soa', locale, ['SOA serial', 'تسلسل SOA'], empty(locale, ['No serial until a zone is stored.', 'لا تسلسل إلى أن تُحفظ منطقة.'])),
  note(locale, ['PowerDNS API', 'واجهة PowerDNS'], ['The DNS tool is not connected. No zone file is imported from this screen.', 'أداة DNS غير موصولة. لا يُستورد ملف منطقة من هذه الشاشة.']),
].join(''))

const whmSsl = (locale: Locale): string => region('/whm/ssl', [
  stats(locale, [
    [['Certificates', 'الشهادات'], zero],
    [['In the renewal window', 'في نافذة التجديد'], zero],
    [['Failed renewals', 'تجديدات فاشلة'], zero],
    [['Next AutoSSL run', 'تشغيل AutoSSL التالي'], unavailable],
  ]),
  card('ssl-auto', locale, ['AutoSSL', 'AutoSSL'], `${empty(locale, ['AutoSSL does not run from this empty queue.', 'لا يعمل AutoSSL من هذا الطابور الفارغ.'])}${select('ssl-ca', locale, ['ACME provider', 'مزود ACME'], [["Let's Encrypt", "Let's Encrypt"], ['Custom ACME directory', 'دليل ACME مخصص']])}${field('ssl-contact', locale, ['Account contact', 'بريد الحساب'], 'email')}${soonBtn(locale, ['Save settings', 'حفظ الإعدادات'])}`),
  card('ssl-host', locale, ['Panel hostname certificate', 'شهادة اسم مضيف اللوحة'], empty(locale, ['No hostname certificate is stored.', 'لا شهادة لاسم المضيف محفوظة.'])),
  card('ssl-list', locale, ['Certificates', 'الشهادات'], table(locale, [['Certificate', 'الشهادة'], ['Expires', 'تنتهي']], ['No certificates yet', 'لا شهادات بعد'])),
  card('ssl-queue', locale, ['Renewal queue', 'طابور التجديد'], `${table(locale, [['Certificate', 'الشهادة'], ['When', 'الوقت']], ['The queue is empty.', 'الطابور فارغ.'])}${soonBtn(locale, ['Queue renewal', 'جدولة التجديد'], true)}`),
  card('ssl-log', locale, ['Renewal log', 'سجل التجديد'], table(locale, [['When', 'الوقت'], ['Result', 'النتيجة']], ['No renewal has been recorded.', 'لا تجديد مسجّل.'])),
].join(''))

const web = (locale: Locale): string => region('/whm/services/web', [
  card('web-engine', locale, ['Engine', 'المحرك'], radios('web-engine', locale, [['Apache', 'Apache'], ['Nginx', 'Nginx'], ['OpenLiteSpeed', 'OpenLiteSpeed']])),
  card('web-mpm', locale, ['Apache MPM', 'Apache MPM'], empty(locale, ['No MPM is selected.', 'لا MPM محدد.'])),
  card('web-backend', locale, ['Backend connection', 'اتصال الخلفية'], empty(locale, ['No backend is stored.', 'لا خلفية محفوظة.'])),
  card('web-edge', locale, ['Nginx edge', 'حافة Nginx'], empty(locale, ['No edge setting is stored.', 'لا إعداد للحافة محفوظ.'])),
  card('web-workers', locale, ['Apache workers', 'عمال Apache'], table(locale, [['Setting', 'الإعداد'], ['Value', 'القيمة']], ['No worker row is reported.', 'لا صف عمال مبلّغ عنه.'])),
  card('web-pending', locale, ['Pending change', 'تغيير معلّق'], `${empty(locale, ['No pending change', 'لا تغيير معلّق'])}${soonBtn(locale, ['Apply web server change', 'تطبيق تغيير خادم الويب'])}`),
  card('web-generations', locale, ['Generations', 'الأجيال'], table(locale, [['Generation', 'الجيل'], ['Result', 'النتيجة']], ['No generations are recorded for the web server.', 'لا أجيال مسجّلة لخادم الويب.'])),
].join(''))

const whmPhp = (locale: Locale): string => region('/whm/software/php', [
  card('whm-php-versions', locale, ['Installed versions', 'الإصدارات المثبّتة'], `${table(locale, [['Version', 'الإصدار'], ['Domains', 'النطاقات'], ['Life', 'الدعم']], ['No PHP versions reported', 'لا إصدارات PHP مبلّغ عنها'])}${soonBtn(locale, ['Install PHP', 'تثبيت PHP'])}`),
  card('whm-php-handlers', locale, ['Handlers', 'المعالجات'], table(locale, [['Handler', 'المعالج'], ['Version', 'الإصدار']], ['Handlers stay blank until the package tool is connected.', 'تبقى المعالجات فارغة إلى أن تُوصل أداة الحزم.'])),
  card('whm-php-config', locale, ['Configure a version', 'ضبط إصدار'], empty(locale, ['No version is selected.', 'لا إصدار محدد.'])),
  card('whm-php-danger', locale, ['Dangerous functions', 'الدوال الخطرة'], table(locale, [['Function', 'الدالة']], ['No function list is stored.', 'لا قائمة دوال محفوظة.'])),
].join(''))

const advisor = (locale: Locale): string => region('/whm/security', [
  anchors(locale, [
    ['sec-access', ['Access', 'الوصول']],
    ['sec-tfa', ['Two-factor', 'التحقق بخطوتين']],
    ['sec-lock', ['Sign-in lockout', 'قفل الدخول']],
    ['sec-tokens', ['API tokens', 'رموز API']],
    ['sec-php', ['PHP functions', 'دوال PHP']],
    ['sec-compiler', ['Compiler lock', 'قفل المصرّف']],
  ]),
  card('sec-access', locale, ['Access', 'الوصول'], `${empty(locale, ['No panel security policy yet', 'لا سياسة أمان للوحة بعد'])}${field('sec-port', locale, ['Panel port', 'منفذ اللوحة'])}${soonBtn(locale, ['Save panel security', 'حفظ أمان اللوحة'])}`),
  card('sec-tfa', locale, ['Two-factor for root', 'التحقق بخطوتين للجذر'], empty(locale, ['No second factor is stored for root.', 'لا عامل ثانٍ محفوظ للجذر.'])),
  card('sec-lock', locale, ['Sign-in lockout', 'قفل الدخول'], `<div class="xp-board-fields">${field('sec-attempts', locale, ['Attempts', 'المحاولات'])}${field('sec-window', locale, ['Window', 'النافذة'])}</div>`),
  card('sec-locked', locale, ['Locked right now', 'المقفول الآن'], table(locale, [['Account', 'الحساب'], ['Until', 'حتى']], ['Nobody is locked.', 'لا أحد مقفول.'])),
  card('sec-tokens', locale, ['API tokens', 'رموز API'], table(locale, [['Token', 'الرمز'], ['State', 'الحالة']], ['No tokens are stored.', 'لا رموز محفوظة.'])),
  card('sec-php', locale, ['Dangerous PHP functions', 'دوال PHP الخطرة'], table(locale, [['Function', 'الدالة']], ['No function list is stored.', 'لا قائمة دوال محفوظة.'])),
  card('sec-compiler', locale, ['Compiler lock', 'قفل المصرّف'], empty(locale, ['No compiler exception is stored.', 'لا استثناء مصرّف محفوظ.'])),
].join(''))

const ssh = (locale: Locale): string => region('/whm/security/ssh', [
  stats(locale, [
    [['Service', 'الخدمة'], unavailable],
    [['Version', 'الإصدار'], unavailable],
    [['Open sessions', 'الجلسات المفتوحة'], zero],
  ]),
  card('ssh-settings', locale, ['Sign-in settings', 'إعدادات الدخول'], `${field('ssh-port', locale, ['Port', 'المنفذ'])}${radios('ssh-auth', locale, [['Keys only', 'مفاتيح فقط'], ['Keys and password', 'مفاتيح وكلمة مرور']])}${radios('ssh-root', locale, [['Keys only', 'مفاتيح فقط'], ['Not allowed', 'غير مسموح']])}${soonBtn(locale, ['Save SSH settings', 'حفظ إعدادات SSH'])}`),
  card('ssh-effective', locale, ['Effective config', 'الإعداد الفعّال'], `${empty(locale, ['The effective file is not loaded.', 'الملف الفعّال غير محمّل.'])}${code('')}`),
  card('ssh-keys', locale, ['Authorized keys for root', 'مفاتيح الجذر'], table(locale, [['Fingerprint', 'البصمة'], ['Type', 'النوع'], ['Comment', 'التعليق']], ['No keys are stored.', 'لا مفاتيح محفوظة.'])),
  card('ssh-failed', locale, ['Failed sign-ins', 'محاولات فاشلة'], table(locale, [['Address', 'العنوان'], ['When', 'الوقت']], ['No failed sign-ins are recorded.', 'لا محاولات فاشلة مسجّلة.'])),
  card('ssh-banned', locale, ['Banned by SSH', 'محظور من SSH'], table(locale, [['Address', 'العنوان'], ['State', 'الحالة']], ['No addresses banned by SSH', 'لا عناوين محظورة من SSH'])),
].join(''))

const backups = (locale: Locale): string => region('/whm/backups', [
  stats(locale, [
    [['Last run', 'آخر عملية'], unavailable],
    [['Next run', 'العملية التالية'], unavailable],
    [['Local copy', 'النسخة المحلية'], unavailable],
    [['Remote copy', 'النسخة البعيدة'], unavailable],
  ]),
  card('bak-runs', locale, ['Runs', 'العمليات'], `${table(locale, [['Started', 'البداية'], ['Type', 'النوع'], ['Accounts', 'الحسابات'], ['Size', 'الحجم'], ['Status', 'الحالة']], ['No backup runs yet', 'لا عمليات نسخ بعد'])}${soonBtn(locale, ['Run backup now', 'بدء النسخ'])}`),
  card('bak-restore', locale, ['Restore', 'الاستعادة'], empty(locale, ['A restore is not offered from an empty history.', 'لا تُعرض استعادة من سجل فارغ.'])),
  note(locale, ['What a restore does', 'ماذا تفعل الاستعادة'], ['A restore shows the difference first.', 'تعرض الاستعادة الفرق أولًا.']),
  card('bak-config', locale, ['Configuration', 'الإعداد'], `<div class="xp-board-fields">${field('bak-dest', locale, ['Destination', 'الوجه'])}${field('bak-schedule', locale, ['Schedule', 'الجدول'])}</div>`),
].join(''))

const canvases: Readonly<Record<string, (locale: Locale) => string>> = {
  '/files/backup': backup,
  '/files/directory-privacy': privacy,
  '/software/php': panelPhp,
  '/software/htaccess': htaccess,
  '/advanced/cron': cron,
  '/whm/server/setup': setup,
  '/whm/plans/features': features,
  '/whm/domains': whmDomains,
  '/whm/dns': dns,
  '/whm/ssl': whmSsl,
  '/whm/services/web': web,
  '/whm/software/php': whmPhp,
  '/whm/security': advisor,
  '/whm/security/ssh': ssh,
  '/whm/backups': backups,
}

/** Board body for an unwired route. Foundations keep their own specimen renderer. */
export const renderBoardCanvas = (route: string, locale: Locale): string => canvases[route]?.(locale) ?? ''

const fact = (locale: Locale, label: Copy, value: string): string =>
  `<div class="xp-fact"><dt>${h(tx(locale, label))}</dt><dd><bdi dir="ltr">${h(value)}</bdi></dd></div>`

export interface ResourceLimitRow {
  readonly label: Copy
  readonly plan: string
}

const limitText = (value: Limit, suffix: string): string => (value === 'unlimited' ? 'unlimited' : `${value} ${suffix}`)

export const resourceRowsFromPlan = (resources: {
  diskMb: Limit
  bandwidthMbMonth: Limit
  cpuPercent: Limit
  memoryMb: Limit
  maxProcesses: Limit
  ioReadBps: Limit
  ioWriteBps: Limit
} | null): ResourceLimitRow[] => {
  if (!resources) {
    const blank = '—'
    return [
      { label: ['Disk', 'القرص'], plan: blank },
      { label: ['Bandwidth / month', 'النطاق الشهري'], plan: blank },
      { label: ['CPU', 'المعالج'], plan: blank },
      { label: ['Memory', 'الذاكرة'], plan: blank },
      { label: ['Processes', 'العمليات'], plan: blank },
      { label: ['Disk read', 'قراءة القرص'], plan: blank },
      { label: ['Disk write', 'كتابة القرص'], plan: blank },
    ]
  }
  return [
    { label: ['Disk', 'القرص'], plan: limitText(resources.diskMb, 'MB') },
    { label: ['Bandwidth / month', 'النطاق الشهري'], plan: limitText(resources.bandwidthMbMonth, 'MB') },
    { label: ['CPU', 'المعالج'], plan: limitText(resources.cpuPercent, '%') },
    { label: ['Memory', 'الذاكرة'], plan: limitText(resources.memoryMb, 'MB') },
    { label: ['Processes', 'العمليات'], plan: limitText(resources.maxProcesses, '') },
    { label: ['Disk read', 'قراءة القرص'], plan: limitText(resources.ioReadBps, 'B/s') },
    { label: ['Disk write', 'كتابة القرص'], plan: limitText(resources.ioWriteBps, 'B/s') },
  ]
}

/** Resources board. Plan values are the stored plan. Live usage stays empty until the host reports it. */
export const renderAccountResources = (locale: Locale, uid: number, rows: readonly ResourceLimitRow[]): string => {
  const applied = tx(locale, unavailable)
  const live = tx(locale, ['No reading yet', 'لا قراءة بعد'])
  return `<section class="xp-board-canvas" data-section="slice-resources" data-board-layout="/resources" aria-labelledby="xpanel-resources-heading">
    <header class="xp-board-head">
      <div>
        <h1 id="xpanel-resources-heading" class="xp-page-title">${h(tx(locale, ['Resources & quotas', 'الموارد والحصص']))}</h1>
        <p class="xp-prose xp-design-page__lede">${h(tx(locale, ['What this plan allows, what this host applies to the slice, and what is in use right now.', 'ما تسمح به الخطة، وما يطبّقه المضيف على الشريحة، وما هو مستخدم الآن.']))}</p>
      </div>
      ${soonBtn(locale, ['Refresh live values', 'تحديث القراءات الحية'], true)}
    </header>
    <p class="xp-prose" role="status" data-resource-metrics="unavailable">${h(tx(locale, ['Resource measurements are not available yet. The plan limits below are still the stored values.', 'قياسات الموارد غير متاحة بعد. حدود الخطة أدناه هي القيم المحفوظة.']))}</p>
    <section class="xp-board-section" aria-labelledby="slice-title">
      <header class="xp-board-section__head"><h2 id="slice-title"><bdi dir="ltr">xpanel-${uid}.slice</bdi></h2></header>
      <dl class="xp-board-dl">
        ${fact(locale, ['Identity', 'الهوية'], `uid ${uid}`)}
        ${fact(locale, ['cgroup path', 'مسار cgroup'], `/sys/fs/cgroup/xpanel.slice/xpanel-${uid}.slice`)}
      </dl>
    </section>
    <section class="xp-board-section" aria-labelledby="limits-title">
      <header class="xp-board-section__head"><h2 id="limits-title">${h(tx(locale, ['Limits on your slice', 'حدود الشريحة']))}</h2></header>
      <div class="xp-table-wrap"><table class="xp-table"><thead><tr>
        <th>${h(tx(locale, ['Limit', 'الحد']))}</th>
        <th>${h(tx(locale, ['Plan value', 'قيمة الخطة']))}</th>
        <th>${h(tx(locale, ['Applied on host', 'المطبَّق على المضيف']))}</th>
        <th>${h(tx(locale, ['Live usage', 'الاستخدام الحي']))}</th>
      </tr></thead><tbody>
        ${rows.map(row => `<tr><th scope="row">${h(tx(locale, row.label))}</th><td><bdi dir="ltr">${h(row.plan)}</bdi></td><td>${h(applied)}</td><td>${h(live)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="xp-board-section" aria-labelledby="io-title">
      <header class="xp-board-section__head"><h2 id="io-title">${h(tx(locale, ['Disk IO, last hour', 'إدخال وإخراج القرص، الساعة الأخيرة']))}</h2></header>
      <div class="xp-board-section__body">${empty(locale, ['No IO sample yet', 'لا عينة قرص بعد'])}</div>
    </section>
    <section class="xp-board-section" aria-labelledby="procs-title">
      <header class="xp-board-section__head"><h2 id="procs-title">${h(tx(locale, ['Processes in your slice', 'عمليات الشريحة']))}</h2></header>
      <div class="xp-board-section__body">${table(locale, [['PID', 'PID'], ['Command', 'الأمر']], ['No processes reported.', 'لا عمليات مبلّغ عنها.'])}</div>
    </section>
  </section>`
}
