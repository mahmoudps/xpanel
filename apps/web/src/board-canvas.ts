import type { Limit } from '@xpanel/core'
import type { Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

type Copy = readonly [english: string, arabic: string]

const tx = (locale: Locale, copy: Copy): string => (locale === 'ar' ? copy[1] : copy[0])
const h = (value: string): string => escapeHtml(value)

const unavailable: Copy = ['Unavailable', 'غير متاح']
const notRead: Copy = ['Not read', 'غير مقروء']

const soonBtn = (locale: Locale, label: Copy, quiet = false): string =>
  `<button type="button" class="xp-btn${quiet ? '' : ' xp-btn--primary'}" disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason">${h(tx(locale, label))}</button>`

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

const textarea = (id: string, locale: Locale, label: Copy, rows = 6): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><textarea id="${id}" class="xp-input xp-board-editor" rows="${rows}" readonly disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason"></textarea></div>`

const steps = (locale: Locale, items: readonly Copy[]): string =>
  `<ol class="xp-board-steps" aria-label="${h(tx(locale, ['Workflow', 'مراحل العمل']))}">${items.map((item,index) => `<li${index === 0 ? ' aria-current="step"' : ''}><span class="xp-board-step-number" aria-hidden="true">${index + 1}</span><span>${h(tx(locale,item))}</span></li>`).join('')}</ol>`

const fields = (locale: Locale, prefix: string, labels: readonly Copy[]): string =>
  `<div class="xp-board-fields">${labels.map((label,index)=>field(`${prefix}-${index}`,locale,label)).join('')}</div>`

const actions = (locale: Locale, primary: Copy, secondary?: Copy): string =>
  `<div class="xp-board-actions">${secondary ? soonBtn(locale,secondary,true) : ''}${soonBtn(locale,primary)}</div>`

const tabs = (locale: Locale, name: Copy, items: readonly Copy[]): string =>
  `<div class="xp-board-options" role="group" aria-label="${h(tx(locale,name))}">${items.map(item=>`<button type="button" class="xp-btn xp-btn--quiet" disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason">${h(tx(locale,item))}</button>`).join('')}</div>`

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

const region = (route: string, locale: Locale, body: string): string =>
  `<div class="xp-board-canvas" data-board-layout="${h(route)}" data-read-state="unread"><style>.xp-board-steps{display:flex;flex-wrap:wrap;gap:16px;list-style:none;margin:0;padding:0}.xp-board-steps li{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-board-step-number{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border);border-radius:50%;font-variant-numeric:tabular-nums}.xp-board-steps [aria-current="step"]{font-weight:600}.xp-board-options{display:flex;flex-wrap:wrap;gap:16px}.xp-board-editor{box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:160px;resize:vertical;text-align:start}.xp-board-canvas .xp-board-unavailable{display:flex;flex-direction:column;gap:8px}.xp-board-canvas .xp-board-unavailable p{margin:0}.xp-board-canvas .xp-board-section__body>.xp-board-fields{inline-size:100%}.xp-board-canvas .xp-board-checks{gap:16px}</style><aside class="xp-board-note xp-board-unavailable" role="note"><h2>${h(tx(locale,['Coming soon: this operation is not connected','قيد التفعيل: هذه العملية غير موصولة']))}</h2><p id="xp-board-unavailable-reason">${h(tx(locale,['The page structure is available, but its saved configuration and service readings have not been loaded. Controls stay disabled and no change is submitted.','هيكل الصفحة متاح، لكن إعداداتها المحفوظة وقراءات الخدمة لم تُحمّل. تبقى عناصر التحكم معطّلة ولا يُرسل أي تغيير.']))}</p></aside>${body}</div>`

const backup = (locale: Locale): string => region('/files/backup', locale, [
  tabs(locale,['Backup mode','وضع النسخ'],[['Back up','نسخ احتياطي'],['Restore','استعادة']]),
  steps(locale,[['What to include','محتوى النسخة'],['Destination','الوجهة'],['Review','المراجعة'],['Result','النتيجة']]),
  card('backup-include',locale,['What do you want to back up?','ماذا تريد نسخه؟'],`${checks(locale,[['Home directory files','ملفات مجلد المنزل'],['Databases','قواعد البيانات'],['Mailboxes','صناديق البريد'],['Mail config','إعداد البريد']])}${field('backup-folder',locale,['Folder','المجلد'])}${legend(locale,['Databases','قواعد البيانات'],table(locale,[['Database','قاعدة البيانات'],['Size','الحجم']],['The database selection has not been read.','لم تُقرأ قواعد البيانات المتاحة للاختيار.']))}`),
  card('backup-dest',locale,['Where should the archive go?','أين يذهب الأرشيف؟'],`${radios('backup-destination',locale,[['Download to this device','تنزيل إلى هذا الجهاز'],['Local storage','تخزين محلي'],['Remote storage','تخزين بعيد']])}${select('backup-remote',locale,['Remote storage','التخزين البعيد'],[['Destinations not read','الوجهات غير مقروءة']])}${checks(locale,[['Email me when it is done','إرسال بريد عند الاكتمال']])}${actions(locale,['Review backup','مراجعة النسخة'],['Back','رجوع'])}`),
  card('backup-restore',locale,['Choose an archive','اختيار أرشيف'],`${select('backup-archive',locale,['Archive','الأرشيف'],[['Archives not read','الأرشيفات غير مقروءة']])}${legend(locale,['What to restore from it','ما المطلوب استعادته منه'],checks(locale,[['Home directory files','ملفات مجلد المنزل'],['Databases','قواعد البيانات'],['Mailboxes','صناديق البريد'],['Mail config','إعداد البريد']]))}`),
  card('backup-review',locale,['Review the difference','مراجعة الفرق'],`${tabs(locale,['Difference filter','تصفية الفرق'],[['All','الكل'],['New','جديد'],['Changed','متغير'],['Unchanged','دون تغيير']])}${table(locale,[['Path','المسار'],['Current','الحالي'],['Archive','الأرشيف'],['Planned action','الإجراء المخطط']],['No archive has been selected or compared.','لم يُحدد أو يُقارن أي أرشيف.'])}${checks(locale,[['I reviewed the proposed restore changes','راجعت تغييرات الاستعادة المقترحة']])}${actions(locale,['Restore selected parts','استعادة الأجزاء المحددة'],['Back','رجوع'])}`),
  note(locale,['What a restore never does','ما لا تفعله الاستعادة'],['A restore shows the difference first and never deletes a file that is missing from the archive.','تعرض الاستعادة الفرق أولًا ولا تحذف ملفًا غير موجود في الأرشيف.']),
  card('backup-location',locale,['Where archives live','أين تعيش الأرشيفات'],empty(locale,['Archive locations have not been read.','لم تُقرأ أماكن الأرشيفات.'])),
  card('backup-archives',locale,['Archives','الأرشيفات'],`${table(locale,[['Archive','الأرشيف'],['Created','أُنشئ'],['Size','الحجم'],['Status','الحالة']],['The archive list has not been read.','لم تُقرأ قائمة الأرشيفات.'])}${actions(locale,['Create backup','إنشاء نسخة'],['Download selected archive','تنزيل الأرشيف المحدد'])}`),
].join(''))

const privacy = (locale: Locale): string => region('/files/directory-privacy', locale, [
  card('privacy-list', locale, ['Directory privacy', 'خصوصية المجلد'], `${table(locale, [['Folder', 'المجلد'], ['Prompt shown', 'النص الظاهر'], ['Users', 'المستخدمون'], ['Status', 'الحالة']], ['No protected directories', 'لا مجلدات محمية'])}<p>${h(tx(locale, ['Protected folders are served over HTTPS only. Password files stay outside the public site.', 'تُخدم المجلدات المحمية عبر HTTPS فقط. تبقى ملفات كلمات المرور خارج الموقع العام.']))}</p>`),
  card('privacy-add', locale, ['Protect a folder', 'احمِ مجلدًا'], `<div class="xp-board-fields">${field('priv-path', locale, ['Folder', 'المجلد'])}${field('priv-realm', locale, ['Prompt shown', 'النص الظاهر'])}${field('priv-user', locale, ['First user', 'أول مستخدم'])}${field('priv-pass', locale, ['Password for this user', 'كلمة مرور هذا المستخدم'], 'password')}</div>${soonBtn(locale, ['Protect folder', 'احمِ المجلد'])}`),
].join(''))

const panelPhp = (locale: Locale): string => region('/software/php', locale, [
  card('php-domain', locale, ['Domain and version', 'النطاق والإصدار'], `${empty(locale, ['No PHP selection yet', 'لا اختيار لـ PHP بعد'])}<div class="xp-board-fields">${field('php-domain-name', locale, ['Domain', 'النطاق'])}${select('php-version', locale, ['PHP version', 'إصدار PHP'], [['Version not read', 'الإصدار غير مقروء']])}</div>${legend(locale, ['Handler', 'المعالج'], radios('php-handler',locale,[['PHP-FPM', 'PHP-FPM'],['CGI with suexec', 'CGI مع suexec'],['suPHP', 'suPHP'],['lsphp', 'lsphp']]))}<p class="xp-help">${h(tx(locale,['Handler availability depends on the installed engine and host checks; no handler is selected here.','يتوقف توافر المعالج على المحرك المثبّت وفحوص المضيف؛ لا يوجد معالج محدد هنا.']))}</p>`),
  card('php-pool', locale, ['PHP-FPM pool', 'مجمّع PHP'], `${legend(locale,['Process manager pm','مدير العمليات pm'],radios('php-pm',locale,[['ondemand','ondemand'],['dynamic','dynamic'],['static','static']]))}${fields(locale,'php-pool',[['pm.max_children','pm.max_children'],['pm.start_servers','pm.start_servers'],['pm.min_spare_servers','pm.min_spare_servers'],['pm.max_spare_servers','pm.max_spare_servers'],['pm.max_requests','pm.max_requests'],['pm.process_idle_timeout','pm.process_idle_timeout']])}`),
  card('php-ini', locale, ['INI values', 'قيم INI'], `${legend(locale,['Save to','موضع الحفظ'],radios('php-save-target',locale,[['.user.ini','.user.ini'],['PHP-FPM pool','مجمّع PHP-FPM']]))}${fields(locale,'php-ini',[['memory_limit','memory_limit'],['upload_max_filesize','upload_max_filesize'],['post_max_size','post_max_size'],['max_execution_time','max_execution_time'],['max_input_vars','max_input_vars'],['date.timezone','date.timezone']])}${select('php-display-errors',locale,['display_errors','display_errors'],[['Not read','غير مقروء']])}${actions(locale,['Save PHP settings','حفظ إعدادات PHP'],['Reset draft','إعادة ضبط المسودة'])}`),
  card('php-running', locale, ['Running now', 'ما يعمل الآن'], `${table(locale,[['Property','الخاصية'],['Reading','القراءة']],[ 'Runtime readings have not been loaded.', 'لم تُحمّل قراءات التشغيل.'])}${code('')}`),
  card('php-disabled', locale, ['Disabled functions', 'الدوال المعطلة'], table(locale, [['Function', 'الدالة'],['Source','المصدر']], ['The function policy has not been read.', 'لم تُقرأ سياسة الدوال.'])),
].join(''))

const htaccess = (locale: Locale): string => region('/software/htaccess', locale, [
  card('ht-file', locale, ['.htaccess', '.htaccess'], `${field('ht-file-path',locale,['File','الملف'])}${select('ht-snippet',locale,['Insert','إدراج'],[['Choose a snippet','اختر مقطعًا'],['Redirect','إعادة توجيه'],['Cache headers','ترويسات التخزين المؤقت'],['Security headers','ترويسات الأمان']])}${soonBtn(locale,['Insert at cursor','إدراج عند المؤشر'],true)}${textarea('ht-file-editor',locale,['File contents','محتوى الملف'],14)}${actions(locale,['Save and check site','الحفظ وفحص الموقع'],['Discard draft','تجاهل المسودة'])}`),
  card('ht-php', locale, ['PHP settings in .htaccess', 'إعدادات PHP في الملف'], `${table(locale,[['Directive','التوجيه'],['Value','القيمة'],['Compatibility','التوافق']],['The file and its handler compatibility have not been read.','لم يُقرأ الملف أو توافقه مع المعالج.'])}${soonBtn(locale,['Move PHP settings to .user.ini','نقل إعدادات PHP إلى .user.ini'],true)}`),
  card('ht-versions', locale, ['Versions', 'الإصدارات'], `${table(locale, [['Version', 'الإصدار'], ['Saved', 'حُفظ'],['Author','الكاتب'],['Result','النتيجة']], ['Saved versions have not been read.', 'لم تُقرأ الإصدارات المحفوظة.'])}${soonBtn(locale,['Restore selected version','استعادة الإصدار المحدد'],true)}`),
  note(locale, ['What a save does', 'ماذا يفعل الحفظ'], ['A save must validate the selected file and report the site check result. No file is changed from this unavailable editor.', 'يجب أن يتحقق الحفظ من الملف المحدد ويعرض نتيجة فحص الموقع. لا يتغير ملف من هذا المحرر غير المتاح.']),
].join(''))

const cron = (locale: Locale): string => region('/advanced/cron', locale, [
  card('cron-jobs', locale, ['Scheduled jobs', 'المهام المجدولة'], `${table(locale, [['Job', 'المهمة'], ['Schedule', 'الجدول'], ['Command', 'الأمر'], ['Last run', 'آخر تشغيل'], ['Duration', 'المدة'], ['Next run', 'التشغيل التالي']], ['The scheduled job list has not been read.', 'لم تُقرأ قائمة المهام المجدولة.'])}${actions(locale,['Run selected job now','تشغيل المهمة المحددة الآن'],['View unit','عرض الوحدة'])}`),
  card('cron-add', locale, ['Add a cron job', 'إضافة مهمة'], `${legend(locale, ['Schedule', 'الجدول'], `${select('cron-preset', locale, ['Common schedules', 'الجداول الشائعة'], [['Every 5 minutes', 'كل 5 دقائق'],['Every hour, on the hour', 'كل ساعة'],['Twice a day', 'مرتين في اليوم'],['Every day', 'كل يوم'],['Every Sunday', 'كل أحد'],['On the 1st of the month', 'في اليوم الأول من الشهر'],['Custom schedule', 'جدول مخصص']])}${fields(locale,'cron-schedule',[['Minute','الدقيقة'],['Hour','الساعة'],['Day','اليوم'],['Month','الشهر'],['Weekday','يوم الأسبوع']])}`)}${legend(locale,['Command','الأمر'],`${field('cron-command',locale,['Command to run','الأمر المطلوب تشغيله'])}${field('cron-timeout',locale,['Stop the job after','إيقاف المهمة بعد'])}${checks(locale,[['Unlimited','غير محدود']])}`)}${legend(locale,['Email the output','إرسال الناتج بالبريد'],radios('cron-email-mode',locale,[['Only when it fails','عند الفشل فقط'],['After every run','بعد كل تشغيل'],['Never','أبدًا']]))}${actions(locale,['Add cron job','إضافة مهمة مجدولة'],['Reset draft','إعادة ضبط المسودة'])}`),
  note(locale, ['How a job runs', 'كيف تعمل المهمة'], ['Each job runs as this account, inside its slice, through its own timer. Jobs share the plan limits.', 'تعمل كل مهمة بهذا الحساب، داخل شريحته، عبر مؤقتها. تتشارك المهام حدود الخطة.']),
  card('cron-unit',locale,['Unit preview','معاينة الوحدة'],`${empty(locale,['No job is selected.','لا توجد مهمة محددة.'])}${code('')}`),
  card('cron-mail', locale, ['Output email', 'بريد الناتج'], `${field('cron-output-email',locale,['Send job output to','إرسال ناتج المهمة إلى'],'email')}${soonBtn(locale,['Save address','حفظ العنوان'],true)}`),
].join(''))

const setup = (locale: Locale): string => region('/whm/server/setup', locale, [
  steps(locale,[['Host and nameservers','المضيف وخوادم الأسماء'],['Engine and workers','المحرك والعمليات'],['Review','المراجعة'],['Apply','التطبيق']]),
  card('setup-host',locale,['Host and nameservers','المضيف وخوادم الأسماء'],fields(locale,'setup-host',[['Server hostname','اسم مضيف الخادم'],['Nameserver 1','خادم الأسماء 1'],['Nameserver 1 address','عنوان خادم الأسماء 1'],['Nameserver 2','خادم الأسماء 2'],['Nameserver 2 address','عنوان خادم الأسماء 2'],['Admin email','بريد المدير']])),
  card('setup-notices',locale,['Send notices about','إرسال إشعارات حول'],checks(locale,[['Failed configuration tests and rollbacks','فشل فحوص الإعداد والتراجع'],['Certificates that fail to renew','الشهادات التي يفشل تجديدها'],['Upgrade results','نتائج الترقية'],['Paused sign-ins to xWHM','توقّف الدخول إلى xWHM']])),
  card('setup-engine',locale,['Web engine for the whole server','محرك الويب للخادم كله'],`${radios('setup-engine',locale,[['Apache with mpm-itk','Apache مع mpm-itk'],['OpenLiteSpeed','OpenLiteSpeed']])}<p class="xp-help">${h(tx(locale,['Engine availability and isolation checks have not been read. Selecting a different engine affects every site.','لم تُقرأ فحوص توافر المحرك والعزل. تغيير المحرك يؤثر في جميع المواقع.']))}</p>`),
  card('setup-workers',locale,['Workers and account defaults','العمليات والقيم الافتراضية للحسابات'],`${legend(locale,['Nginx at the edge','Nginx على الحافة'],fields(locale,'setup-nginx',[['worker_processes','worker_processes'],['worker_connections','worker_connections'],['worker_rlimit_nofile','worker_rlimit_nofile'],['keepalive_timeout','keepalive_timeout']]))}${legend(locale,['Apache mpm-itk','Apache mpm-itk'],fields(locale,'setup-apache',[['StartServers','StartServers'],['MinSpareServers','MinSpareServers'],['MaxSpareServers','MaxSpareServers'],['MaxRequestWorkers','MaxRequestWorkers'],['ServerLimit','ServerLimit'],['MaxConnectionsPerChild','MaxConnectionsPerChild']]))}${legend(locale,['Default PHP-FPM pool for new accounts','مجمّع PHP-FPM الافتراضي للحسابات الجديدة'],fields(locale,'setup-fpm',[['pm','pm'],['pm.max_children','pm.max_children'],['pm.process_idle_timeout','pm.process_idle_timeout'],['pm.max_requests','pm.max_requests']]))}${legend(locale,['OpenLiteSpeed and lsphp','OpenLiteSpeed وlsphp'],fields(locale,'setup-lsphp',[['Server max connections','الحد الأقصى لاتصالات الخادم'],['lsphp children per account','عمليات lsphp لكل حساب'],['lsphp connections per account','اتصالات lsphp لكل حساب']]))}`),
  card('setup-review',locale,['Tests on the candidate generation','فحوص الجيل المرشح'],`${table(locale,[['Check','الفحص'],['Result','النتيجة']],['No candidate has been prepared or tested.','لم يُجهّز أو يُفحص جيل مرشح.'])}${actions(locale,['Apply first generation','تطبيق الجيل الأول'],['Back','رجوع'])}`),
  card('setup-detected', locale, ['Detected on this host', 'ما كُشف على هذا المضيف'], `${table(locale, [['Check', 'الفحص'], ['Result', 'النتيجة']], ['Host detection has not been read.', 'لم تُقرأ نتائج كشف المضيف.'])}${soonBtn(locale,['Detect again','إعادة الكشف'],true)}`),
  card('setup-php', locale, ['PHP handlers by engine', 'معالجات PHP حسب المحرك'], table(locale, [['Engine', 'المحرك'], ['Handler', 'المعالج'],['Availability','التوافر']], ['Handler availability has not been read.', 'لم يُقرأ توافر المعالجات.'])),
].join(''))

const features = (locale: Locale): string => region('/whm/plans/features', locale, [
  card('feat-lists', locale, ['Lists and the plans that use them', 'القوائم والخطط التي تستخدمها'], `${table(locale, [['List', 'القائمة'], ['Plans', 'الخطط'], ['Accounts', 'الحسابات']], ['Feature lists and plan assignments have not been read.', 'لم تُقرأ قوائم الميزات وتعيينات الخطط.'])}${actions(locale,['Create feature list','إنشاء قائمة ميزات'],['Duplicate a list','تكرار قائمة'])}`),
  card('feat-tools', locale, ['Tools by list', 'الأدوات حسب القائمة'], `${field('feature-search',locale,['Filter tools','تصفية الأدوات'])}${table(locale,[['Tool','الأداة'],['List assignment','التعيين للقائمة'],['Availability','التوافر']],['Tool assignments have not been read. No enabled state is assumed.','لم تُقرأ تعيينات الأدوات. لا تُفترض حالة التفعيل.'])}`),
  card('feat-dirty', locale, ['Unsaved changes', 'تغييرات غير محفوظة'], `${table(locale,[['Tool','الأداة'],['Before','قبل'],['After','بعد']],['No draft is available until the saved lists have been read.','لا تتاح مسودة قبل قراءة القوائم المحفوظة.'])}${actions(locale,['Save feature lists','حفظ قوائم الميزات'],['Discard','تجاهل'])}`),
  note(locale, ['How lists apply', 'كيف تُطبَّق القوائم'], ['Turning a tool off hides it. It does not delete files, mail, or databases. List availability never replaces server authorization.', 'إيقاف أداة يخفيها. لا يحذف الملفات أو البريد أو قواعد البيانات. توافر القائمة لا يحل محل التصريح على الخادم.']),
].join(''))

const whmDomains = (locale: Locale): string => region('/whm/domains', locale, [
  card('whm-domains',locale,['Domains','النطاقات'],`${tabs(locale,['Domain kind','نوع النطاق'],[['All','الكل'],['Primary','أساسي'],['Addon','إضافي'],['Alias','اسم بديل'],['Subdomain','نطاق فرعي']])}<div class="xp-board-fields">${select('whm-domain-account',locale,['Account','الحساب'],[['Accounts not read','الحسابات غير مقروءة']])}${select('whm-domain-ssl',locale,['SSL state','حالة SSL'],[['Any state','أي حالة'],['Valid','سارية'],['Missing','غير موجودة']])}${select('whm-domain-php',locale,['PHP version','إصدار PHP'],[['Versions not read','الإصدارات غير مقروءة']])}</div>${table(locale,[['Domain','النطاق'],['Kind','النوع'],['Account','الحساب'],['Docroot','جذر المستندات'],['PHP','PHP'],['SSL','SSL'],['Status','الحالة']],['Server domains have not been read.','لم تُقرأ نطاقات الخادم.'])}${actions(locale,['Add domain to an account','إضافة نطاق إلى حساب'],['Clear filters','إزالة التصفية'])}`),
  card('whm-default-site',locale,['Default site for unbound names','الموقع الافتراضي للأسماء غير المرتبطة'],`${legend(locale,['Answer with','طريقة الرد'],radios('unbound-answer',locale,[['Default page','الصفحة الافتراضية'],['Redirect','إعادة توجيه'],['Reject the request','رفض الطلب']]))}${field('unbound-redirect',locale,['Redirect to','إعادة التوجيه إلى'],'url')}${checks(locale,[['Refuse HTTPS for unknown names','رفض HTTPS للأسماء غير المعروفة']])}${table(locale,[['Unbound request','الطلب غير المرتبط'],['Last seen','آخر ظهور']],['Unbound request observations have not been read.','لم تُقرأ ملاحظات الطلبات غير المرتبطة.'])}${actions(locale,['Save default site','حفظ الموقع الافتراضي'],['Discard','تجاهل'])}`),
  note(locale,['How a name finds its site','كيف يجد الاسم موقعه'],['The requested hostname is resolved to its stored site and account before serving content. A name without an authorized binding must use the reviewed default-site policy.','يُربط اسم المضيف المطلوب بالموقع والحساب المحفوظين قبل تقديم المحتوى. الاسم الذي لا يملك ربطًا مصرحًا يستخدم سياسة الموقع الافتراضي المراجعة.']),
].join(''))

const dns = (locale: Locale): string => region('/whm/dns', locale, [
  card('dns-zones',locale,['Zones','المناطق'],`${table(locale,[['Zone','المنطقة'],['Account','الحساب'],['Records','السجلات'],['Serial','التسلسل'],['Status','الحالة']],['The zone list has not been read.','لم تُقرأ قائمة المناطق.'])}${actions(locale,['Add zone','إضافة منطقة'],['Edit records','تحرير السجلات'])}`),
  card('dns-import',locale,['Zone file','ملف المنطقة'],`${textarea('dns-bind-zone',locale,['BIND zone file','ملف منطقة BIND'],8)}${actions(locale,['Preview changes','معاينة التغييرات'],['Export zone file','تصدير ملف المنطقة'])}`),
  card('dns-records',locale,['Records in the selected zone','سجلات المنطقة المحددة'],table(locale,[['Name','الاسم'],['Type','النوع'],['TTL','TTL'],['Content','المحتوى'],['Priority','الأولوية']],['No zone has been selected or read.','لم تُحدد أو تُقرأ منطقة.'])),
  card('dns-record',locale,['Add a record','إضافة سجل'],`${tabs(locale,['Record type','نوع السجل'],[['A','A'],['AAAA','AAAA'],['CNAME','CNAME'],['MX','MX'],['TXT','TXT'],['SRV','SRV'],['CAA','CAA']])}${fields(locale,'dns-record',[['Name','الاسم'],['TTL','TTL'],['Content','المحتوى'],['Priority','الأولوية'],['Weight','الوزن'],['Port','المنفذ']])}${actions(locale,['Add record','إضافة سجل'],['Clear','مسح'])}`),
  card('dns-soa',locale,['SOA serial','تسلسل SOA'],empty(locale,['The selected zone serial has not been read.','لم يُقرأ تسلسل المنطقة المحددة.'])),
  card('dns-api',locale,['PowerDNS API','واجهة PowerDNS'],`${empty(locale,['Service availability has not been read.','لم يُقرأ توافر الخدمة.'])}${soonBtn(locale,['Check again','الفحص مجددًا'],true)}`),
].join(''))

const whmSsl = (locale: Locale): string => region('/whm/ssl', locale, [
  stats(locale,[[['Certificates','الشهادات'],notRead],[['In the renewal window','في نافذة التجديد'],notRead],[['Failed renewals','تجديدات فاشلة'],notRead],[['Next AutoSSL run','تشغيل AutoSSL التالي'],notRead]]),
  card('ssl-auto',locale,['AutoSSL','AutoSSL'],`${checks(locale,[['Issue and renew certificates automatically','إصدار الشهادات وتجديدها تلقائيًا']])}${legend(locale,['Certificate authority','جهة إصدار الشهادات'],`${select('ssl-ca',locale,['ACME provider','مزود ACME'],[["Let's Encrypt","Let's Encrypt"],['Custom ACME directory','دليل ACME مخصص']])}${field('ssl-contact',locale,['Account contact','بريد الحساب'],'email')}`)}${legend(locale,['Renewal and validation','التجديد والتحقق'],`${field('ssl-renew-before',locale,['Renew before expiry','التجديد قبل الانتهاء'])}${checks(locale,[["Use the CA renewal window (ARI)",'استخدام نافذة التجديد لدى جهة الإصدار (ARI)']])}${radios('ssl-challenge',locale,[['HTTP validation','التحقق عبر HTTP'],['DNS validation','التحقق عبر DNS']])}`)}${actions(locale,['Save settings','حفظ الإعدادات'],['Discard','تجاهل'])}`),
  card('ssl-host',locale,['Panel hostname certificate','شهادة اسم مضيف اللوحة'],`${table(locale,[['Hostname','اسم المضيف'],['Issuer','المصدر'],['Expires','تنتهي'],['Status','الحالة']],['The panel certificate has not been read.','لم تُقرأ شهادة اللوحة.'])}${actions(locale,['Renew now','التجديد الآن'],['Upload a certificate','رفع شهادة'])}`),
  card('ssl-list',locale,['Certificates','الشهادات'],`${tabs(locale,['Certificate filter','تصفية الشهادات'],[['All','الكل'],['Valid','سارية'],['Renewal due','تحتاج تجديدًا'],['Failed','فاشلة']])}${table(locale,[['Certificate','الشهادة'],['Account','الحساب'],['Issuer','المصدر'],['Expires','تنتهي'],['Status','الحالة']],['Certificates have not been read.','لم تُقرأ الشهادات.'])}`),
  card('ssl-queue',locale,['Renewal queue','طابور التجديد'],`${table(locale,[['Certificate','الشهادة'],['When','الوقت'],['State','الحالة']],['The renewal queue has not been read.','لم يُقرأ طابور التجديد.'])}${soonBtn(locale,['Queue renewal','جدولة التجديد'],true)}`),
  card('ssl-log',locale,['Renewal log','سجل التجديد'],table(locale,[['When','الوقت'],['Certificate','الشهادة'],['Result','النتيجة']],['The renewal log has not been read.','لم يُقرأ سجل التجديد.'])),
].join(''))

const web = (locale: Locale): string => region('/whm/services/web', locale, [
  card('web-engine',locale,['Engine','المحرك'],`${radios('web-engine',locale,[['Apache with mpm-itk','Apache مع mpm-itk'],['OpenLiteSpeed','OpenLiteSpeed']])}<p class="xp-help">${h(tx(locale,['The engine and its installed package state have not been read. An engine change applies to every site.','لم تُقرأ حالة المحرك وحزمه المثبّتة. تغيير المحرك ينطبق على جميع المواقع.']))}</p>`),
  card('web-mpm',locale,['Apache MPM','Apache MPM'],`${radios('web-mpm',locale,[['itk','itk'],['prefork','prefork']])}${empty(locale,['The active MPM has not been read.','لم يُقرأ MPM النشط.'])}`),
  card('web-backend',locale,['Backend connection','اتصال الخلفية'],`${fields(locale,'web-backend',[['Backend address','عنوان الخلفية'],['Backend port','منفذ الخلفية']])}${code('')}`),
  card('web-edge',locale,['Nginx edge','حافة Nginx'],`${soonBtn(locale,['Use suggested values','استخدام القيم المقترحة'],true)}${legend(locale,['Workers','العمليات'],fields(locale,'web-nginx',[['worker_processes','worker_processes'],['worker_connections','worker_connections'],['worker_rlimit_nofile','worker_rlimit_nofile']]))}${legend(locale,['Requests and cache','الطلبات والتخزين المؤقت'],fields(locale,'web-request',[['keepalive_timeout','keepalive_timeout'],['client_max_body_size','client_max_body_size']]))}`),
  card('web-workers',locale,['Apache workers','عمليات Apache'],`${legend(locale,['Spare children','العمليات الاحتياطية'],fields(locale,'web-apache-spare',[['StartServers','StartServers'],['MinSpareServers','MinSpareServers'],['MaxSpareServers','MaxSpareServers']]))}${legend(locale,['Limits','الحدود'],fields(locale,'web-apache-limit',[['MaxRequestWorkers','MaxRequestWorkers'],['ServerLimit','ServerLimit'],['MaxConnectionsPerChild','MaxConnectionsPerChild']]))}`),
  card('web-pending',locale,['Pending change','تغيير معلّق'],`${table(locale,[['Setting','الإعداد'],['Current','الحالي'],['Candidate','المرشح']],['No candidate configuration has been read or tested.','لم يُقرأ أو يُفحص إعداد مرشح.'])}${actions(locale,['Test and apply','الفحص والتطبيق'],['Discard changes','تجاهل التغييرات'])}`),
  card('web-generations',locale,['Generations','الأجيال'],`${table(locale,[['Generation','الجيل'],['When','الوقت'],['Result','النتيجة']],['Generation history has not been read.','لم يُقرأ سجل الأجيال.'])}${soonBtn(locale,['Restore selected generation','استعادة الجيل المحدد'],true)}`),
].join(''))

const whmPhp = (locale: Locale): string => region('/whm/software/php', locale, [
  card('whm-php-versions',locale,['Installed versions','الإصدارات المثبّتة'],`${table(locale,[['Version','الإصدار'],['Domains','النطاقات'],['Support','الدعم'],['State','الحالة']],['Installed PHP versions have not been read.','لم تُقرأ إصدارات PHP المثبّتة.'])}${actions(locale,['Install another version','تثبيت إصدار آخر'],['Set selected version as default','تعيين الإصدار المحدد افتراضيًا'])}`),
  card('whm-php-handlers',locale,['Handlers','المعالجات'],table(locale,[['Handler','المعالج'],['Version','الإصدار'],['Engine','المحرك'],['Availability','التوافر']],['Installed handlers have not been read.','لم تُقرأ المعالجات المثبّتة.'])),
  card('whm-php-config',locale,['Configure a version','ضبط إصدار'],`${select('whm-php-version',locale,['PHP version','إصدار PHP'],[['Versions not read','الإصدارات غير مقروءة']])}${legend(locale,['Extensions','الملحقات'],table(locale,[['Extension','الملحق'],['State','الحالة']],['Extensions have not been read for a selected version.','لم تُقرأ ملحقات إصدار محدد.']))}${tabs(locale,['Global php.ini editor','محرر php.ini العام'],[['Common settings','الإعدادات الشائعة'],['Edit file','تحرير الملف']])}${fields(locale,'whm-php-ini',[['memory_limit','memory_limit'],['upload_max_filesize','upload_max_filesize'],['post_max_size','post_max_size'],['max_execution_time','max_execution_time'],['max_input_vars','max_input_vars']])}${textarea('whm-php-file',locale,['File contents','محتوى الملف'],10)}${actions(locale,['Test and apply','الفحص والتطبيق'],['Discard','تجاهل'])}`),
  card('whm-php-danger',locale,['Dangerous functions','الدوال الخطرة'],`${table(locale,[['Function','الدالة'],['Default policy','السياسة الافتراضية']],['The function policy has not been read.','لم تُقرأ سياسة الدوال.'])}${legend(locale,['New exception','استثناء جديد'],`${field('php-exception-account',locale,['Account','الحساب'])}${field('php-exception-reason',locale,['Reason','السبب'])}${checks(locale,[['exec','exec'],['shell_exec','shell_exec'],['system','system'],['passthru','passthru'],['proc_open','proc_open'],['popen','popen']])}`)}${soonBtn(locale,['Grant exception','منح الاستثناء'],true)}`),
].join(''))

const advisor = (locale: Locale): string => region('/whm/security', locale, [
  anchors(locale,[['sec-access',['Access','الوصول']],['sec-tfa',['Two-factor','التحقق بخطوتين']],['sec-lock',['Sign-in lockout','قفل الدخول']],['sec-tokens',['API tokens','رموز API']],['sec-php',['PHP functions','دوال PHP']],['sec-compiler',['Compiler lock','قفل المصرّف']]]),
  card('sec-access',locale,['Access','الوصول'],`${fields(locale,'sec-access',[['Panel port','منفذ اللوحة'],['Secret entrance path','مسار الدخول الخاص']])}${soonBtn(locale,['Regenerate entrance path','توليد مسار دخول جديد'],true)}${legend(locale,['IP allowlist for xWHM sign-in','قائمة IP المسموح لها بالدخول إلى xWHM'],textarea('sec-ip-allowlist',locale,['Addresses and ranges, one per line','العناوين والمديات، كل واحد في سطر']))}`),
  card('sec-tfa',locale,['Two-factor for root','التحقق بخطوتين للجذر'],`${empty(locale,['The stored factor state has not been read. Enrollment is optional.','لم تُقرأ حالة العامل المحفوظ. التسجيل اختياري.'])}${actions(locale,['Generate new recovery codes','توليد رموز استرجاع جديدة'],['Reset authenticator','إعادة ضبط المصادِق'])}`),
  card('sec-lock',locale,['Sign-in lockout','قفل الدخول'],fields(locale,'sec-lockout',[['Failures','المحاولات الفاشلة'],['Within, minutes','خلال، دقائق'],['Lock for, minutes','مدة القفل، دقائق']])),
  card('sec-locked',locale,['Locked right now','المقفول الآن'],table(locale,[['Account','الحساب'],['Address','العنوان'],['Until','حتى']],['The active lockout list has not been read.','لم تُقرأ قائمة القفل النشط.'])),
  card('sec-tokens',locale,['API tokens','رموز API'],`${table(locale,[['Token name','اسم الرمز'],['Scope','النطاق'],['Last used','آخر استخدام'],['State','الحالة']],['Token metadata has not been read.','لم تُقرأ بيانات وصف رموز API.'])}${fields(locale,'sec-token',[['Token name','اسم الرمز'],['Allowed address ranges','مديات العناوين المسموحة']])}${soonBtn(locale,['Create API token','إنشاء رمز API'],true)}`),
  card('sec-deny',locale,['Request limits and deny lists','حدود الطلبات وقوائم المنع'],`${fields(locale,'sec-request',[['Largest request body','أكبر جسم طلب'],['Answer for denied requests','الرد على الطلبات المرفوضة']])}${textarea('sec-addresses',locale,['Addresses and ranges','العناوين والمديات'])}${textarea('sec-paths',locale,['Path patterns','أنماط المسارات'])}${textarea('sec-agents',locale,['User-agent patterns','أنماط وكلاء المستخدم'])}`),
  card('sec-php',locale,['Dangerous PHP functions','دوال PHP الخطرة'],`${table(locale,[['Function','الدالة'],['Policy','السياسة']],['The function policy has not been read.','لم تُقرأ سياسة الدوال.'])}${soonBtn(locale,['Add exception','إضافة استثناء'],true)}`),
  card('sec-compiler',locale,['Compiler lock','قفل المصرّف'],`${table(locale,[['Account','الحساب'],['Exception','الاستثناء']],['Compiler access and exceptions have not been read.','لم يُقرأ الوصول إلى المصرّف أو استثناءاته.'])}${soonBtn(locale,['Add account','إضافة حساب'],true)}`),
  actions(locale,['Save and apply','الحفظ والتطبيق'],['Discard changes','تجاهل التغييرات']),
].join(''))

const ssh = (locale: Locale): string => region('/whm/security/ssh', locale, [
  stats(locale,[[['Service','الخدمة'],notRead],[['Version','الإصدار'],notRead],[['Open sessions','الجلسات المفتوحة'],notRead]]),
  card('ssh-settings',locale,['Sign-in settings','إعدادات الدخول'],`${field('ssh-port',locale,['Port','المنفذ'])}${legend(locale,['User authentication','مصادقة المستخدم'],radios('ssh-auth',locale,[['Keys only','مفاتيح فقط'],['Keys and password','مفاتيح وكلمة مرور']]))}${legend(locale,['Root sign-in','دخول الجذر'],radios('ssh-root',locale,[['Keys only','مفاتيح فقط'],['Not allowed','غير مسموح'],['Keys and password','مفاتيح وكلمة مرور']]))}${actions(locale,['Test and reload sshd','فحص sshd وإعادة تحميله'],['Discard changes','تجاهل التغييرات'])}`),
  card('ssh-effective',locale,['Effective config','الإعداد الفعّال'],`${empty(locale,['The effective configuration has not been read.','لم يُقرأ الإعداد الفعّال.'])}${code('')}`),
  card('ssh-keys',locale,['Authorized keys for root','مفاتيح الجذر المصرّح بها'],`${table(locale,[['Fingerprint','البصمة'],['Type','النوع'],['Comment','التعليق']],['Authorized key metadata has not been read.','لم تُقرأ بيانات وصف المفاتيح المصرّح بها.'])}${textarea('ssh-new-key',locale,['Add a public key','إضافة مفتاح عام'],4)}${soonBtn(locale,['Add key','إضافة مفتاح'],true)}`),
  card('ssh-failed',locale,['Failed sign-ins','محاولات الدخول الفاشلة'],`${select('ssh-failed-range',locale,['Show','عرض'],[['Last 24 hours','آخر 24 ساعة'],['Last 7 days','آخر 7 أيام']])}${table(locale,[['Address','العنوان'],['User','المستخدم'],['When','الوقت']],['Failed sign-in observations have not been read.','لم تُقرأ ملاحظات محاولات الدخول الفاشلة.'])}`),
  card('ssh-autoban',locale,['Auto-ban rule','قاعدة الحظر التلقائي'],`${checks(locale,[['Enable the SSH auto-ban rule','تفعيل قاعدة الحظر التلقائي لـ SSH']])}${fields(locale,'ssh-autoban',[['Failures','المحاولات الفاشلة'],['Within, minutes','خلال، دقائق'],['Ban for','مدة الحظر']])}`),
  card('ssh-banned',locale,['Banned by SSH','محظور من SSH'],`${table(locale,[['Address','العنوان'],['Since','منذ'],['Until','حتى']],['The SSH ban list has not been read.','لم تُقرأ قائمة حظر SSH.'])}${soonBtn(locale,['Unban selected address','رفع الحظر عن العنوان المحدد'],true)}`),
].join(''))

const backups = (locale: Locale): string => region('/whm/backups', locale, [
  stats(locale,[[['Last run','آخر عملية'],notRead],[['Next run','العملية التالية'],notRead],[['Local copy','النسخة المحلية'],notRead],[['Remote copy','النسخة البعيدة'],notRead]]),
  card('bak-runs',locale,['Runs','العمليات'],`${table(locale,[['Started','البداية'],['Type','النوع'],['Accounts','الحسابات'],['Size','الحجم'],['Status','الحالة']],['Backup runs have not been read.','لم تُقرأ عمليات النسخ.'])}${soonBtn(locale,['Run backup now','بدء النسخ الآن'])}`),
  card('bak-restore',locale,['Restore','الاستعادة'],`${steps(locale,[['Run','العملية'],['Account','الحساب'],['Difference','الفرق'],['Restore','الاستعادة']])}${select('bak-restore-run',locale,['Backup run','عملية النسخ'],[['Runs not read','العمليات غير مقروءة']])}${select('bak-restore-account',locale,['Account','الحساب'],[['Accounts not read','الحسابات غير مقروءة']])}${legend(locale,['Parts to restore','الأجزاء المطلوب استعادتها'],checks(locale,[['Home files','ملفات المنزل'],['Databases','قواعد البيانات'],['Mail','البريد'],['DNS zone','منطقة DNS']]))}${table(locale,[['Path or record','المسار أو السجل'],['Current','الحالي'],['Backup','النسخة'],['Action','الإجراء']],['No backup and account have been compared.','لم تُقارن نسخة وحساب.'])}${actions(locale,['Restore selected account','استعادة الحساب المحدد'],['Back','رجوع'])}`),
  note(locale,['What a restore does','ماذا تفعل الاستعادة'],['A restore must show the exact account-bound difference before applying changes. Newer data must be preserved before a rollback.','يجب أن تعرض الاستعادة الفرق المرتبط بالحساب بدقة قبل تطبيق التغييرات. يجب حفظ البيانات الأحدث قبل التراجع.']),
  card('bak-config',locale,['Configuration','الإعداد'],`${legend(locale,['Schedule','الجدول'],fields(locale,'bak-schedule',[['Frequency','التكرار'],['Start time','وقت البداية']]))}${legend(locale,['Retention','الاحتفاظ'],fields(locale,'bak-retention',[['Daily copies','النسخ اليومية'],['Weekly copies','النسخ الأسبوعية']]))}${legend(locale,['What to include','محتويات النسخة'],checks(locale,[['Home directories','مجلدات المنزل'],['Databases','قواعد البيانات'],['Mail','البريد'],['DNS zones','مناطق DNS'],['Control database snapshot','لقطة قاعدة بيانات التحكم']]))}${legend(locale,['Local destination','الوجهة المحلية'],field('bak-local-path',locale,['Path','المسار']))}${legend(locale,['Remote SFTP','SFTP بعيد'],`${fields(locale,'bak-sftp',[['Host','المضيف'],['Port','المنفذ'],['User','المستخدم'],['Remote path','المسار البعيد'],['Private key file on this server','ملف المفتاح الخاص على هذا الخادم']])}${soonBtn(locale,['Test connection','اختبار الاتصال'],true)}`)}${legend(locale,['Accounts','الحسابات'],`${radios('bak-account-selection',locale,[['All accounts','جميع الحسابات'],['Selected accounts','حسابات محددة']])}${table(locale,[['Account','الحساب'],['Primary domain','النطاق الأساسي']],['Account selections have not been read.','لم تُقرأ الحسابات المتاحة للاختيار.'])}`)}${actions(locale,['Save configuration','حفظ الإعدادات'],['Discard changes','تجاهل التغييرات'])}`),
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
  `<div class="xp-fact"><dt style="color:var(--xp-text-secondary)">${h(tx(locale, label))}</dt><dd><bdi dir="ltr">${h(value)}</bdi></dd></div>`

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
    <style>[data-section="slice-resources"] #xpanel-resources-heading{font-size:var(--xp-type-page)!important;line-height:var(--xp-leading-page)!important}</style>
    <header class="xp-board-head">
      <div>
        <h1 id="xpanel-resources-heading" class="xp-page-title">${h(tx(locale, ['Resources & quotas', 'الموارد والحصص']))}</h1>
        <p class="xp-prose xp-design-page__lede">${h(tx(locale, ['What this plan allows, what this host applies to the slice, and what is in use right now.', 'ما تسمح به الخطة، وما يطبّقه المضيف على الشريحة، وما هو مستخدم الآن.']))}</p>
      </div>
      ${soonBtn(locale, ['Refresh live values', 'تحديث القراءات الحية'], true)}
    </header>
    <p class="xp-prose" id="xp-board-unavailable-reason" role="status" data-resource-metrics="unavailable">${h(tx(locale, ['Resource measurements are not available yet. The plan limits below are still the stored values.', 'قياسات الموارد غير متاحة بعد. حدود الخطة أدناه هي القيم المحفوظة.']))}</p>
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
