import { canOpenRegisteredRoute, navigation, registeredDocumentAliases, visibleRegisteredNavigation, type VisibilityContext } from '@xpanel/catalog'
import type { Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'
import { renderBoardCanvas } from './board-canvas.ts'
import { getSurfaceNavigationLabel } from './shell.ts'

type Copy = readonly [english: string, string]

export interface DesignPage {
  readonly route: string
  readonly surface: 'xpanel' | 'xwhm' | 'xmail'
  readonly group: Copy
  readonly label: Copy
  readonly title: Copy
  readonly lede: Copy
  readonly emptyTitle: Copy
  readonly emptyBody: Copy
  readonly columns: readonly Copy[]
  readonly action: Copy
  /** A qualified catalog page already has a renderer. Unqualified visits still use the empty board. */
  readonly live: boolean
}

export interface DesignPageData<T> {
  readonly wired: boolean
  readonly records: readonly T[]
}

const empty = <T>(): DesignPageData<T> => ({ wired: false, records: [] })

/** One function per unwired board. Replace the body when that tool is connected. */
export const readBackupPage = (): DesignPageData<never> => empty()
export const readDirectoryPrivacyPage = (): DesignPageData<never> => empty()
export const readPanelPhpPage = (): DesignPageData<never> => empty()
export const readHtaccessPage = (): DesignPageData<never> => empty()
export const readCronPage = (): DesignPageData<never> => empty()
export const readDesignSystemPage = (): DesignPageData<never> => empty()
export const readComponentsPage = (): DesignPageData<never> => empty()
export const readNavigationMapPage = (): DesignPageData<never> => empty()
export const readSetupPage = (): DesignPageData<never> => empty()
export const readFeatureListsPage = (): DesignPageData<never> => empty()
export const readWhmDomainsPage = (): DesignPageData<never> => empty()
export const readDnsZonesPage = (): DesignPageData<never> => empty()
export const readWhmSslPage = (): DesignPageData<never> => empty()
export const readWebServerPage = (): DesignPageData<never> => empty()
export const readWhmPhpPage = (): DesignPageData<never> => empty()
export const readSecurityAdvisorPage = (): DesignPageData<never> => empty()
export const readSshPage = (): DesignPageData<never> => empty()
export const readBackupsPage = (): DesignPageData<never> => empty()

const adapters: Readonly<Record<string, () => DesignPageData<never>>> = {
  '/files/backup': readBackupPage,
  '/files/directory-privacy': readDirectoryPrivacyPage,
  '/software/php': readPanelPhpPage,
  '/software/htaccess': readHtaccessPage,
  '/advanced/cron': readCronPage,
  '/design/system': readDesignSystemPage,
  '/design/components': readComponentsPage,
  '/design/navigation': readNavigationMapPage,
  '/whm/server/setup': readSetupPage,
  '/whm/plans/features': readFeatureListsPage,
  '/whm/domains': readWhmDomainsPage,
  '/whm/dns': readDnsZonesPage,
  '/whm/ssl': readWhmSslPage,
  '/whm/services/web': readWebServerPage,
  '/whm/software/php': readWhmPhpPage,
  '/whm/security': readSecurityAdvisorPage,
  '/whm/security/ssh': readSshPage,
  '/whm/backups': readBackupsPage,
}

export const readDesignAdapter = (route: string): DesignPageData<never> => (adapters[route] ?? empty)()

const soon: Copy = ['Coming soon', 'قيد التفعيل']
const noneBody: Copy = ['This screen is on the server. It stays empty until its tool is connected.', 'هذه الشاشة على الخادم. تبقى فارغة إلى أن تُوصل أداتها.']

interface BoardSection {
  readonly title: Copy
  readonly body: Copy
  readonly kind: 'note' | 'table' | 'fields' | 'empty'
  readonly columns?: readonly Copy[]
  readonly fields?: readonly Copy[]
  readonly action?: Copy
}

const section = (
  title: Copy,
  body: Copy,
  kind: BoardSection['kind'],
  extra: { columns?: readonly Copy[]; fields?: readonly Copy[]; action?: Copy } = {},
): BoardSection => ({ title, body, kind, ...extra })

const boardSections: Readonly<Record<string, readonly BoardSection[]>> = {
  '/files/backup': [
    section(['What to include', 'ماذا يُضمَّن'], ['Choose home files, databases, mailboxes or mail config. Nothing is selected, and nothing is archived from this screen.', 'اختر ملفات المنزل أو قواعد البيانات أو صناديق البريد أو إعداد البريد. لا شيء محدد، ولا يُؤرشف شيء من هذه الشاشة.'], 'fields', { fields: [['Home directory files', 'ملفات مجلد المنزل'], ['Databases', 'قواعد البيانات'], ['Mailboxes', 'صناديق البريد'], ['Mail config', 'إعداد البريد']] }),
    section(['What a restore never does', 'ما لا تفعله الاستعادة'], ['A restore shows the difference first and never deletes a file that is missing from the archive.', 'تعرض الاستعادة الفرق أولًا ولا تحذف ملفًا غير موجود في الأرشيف.'], 'note'),
    section(['Where archives live', 'أين تعيش الأرشيفات'], ['No destination is stored until the backup tool is connected.', 'لا يُحفظ وجه إلى أن تُوصل أداة النسخ.'], 'empty'),
    section(['Archives', 'الأرشيفات'], ['No archives yet', 'لا أرشيف بعد'], 'table', { columns: [['Archive', 'الأرشيف'], ['Created', 'أُنشئ']], action: ['Create backup', 'إنشاء نسخة'] }),
  ],
  '/files/directory-privacy': [
    section(['Protect a folder', 'احمِ مجلدًا'], ['No protected directories', 'لا مجلدات محمية'], 'fields', { fields: [['Path', 'المسار'], ['User', 'المستخدم'], ['Password', 'كلمة المرور']], action: ['Protect a directory', 'احمِ مجلدًا'] }),
    section(['Protected directories', 'المجلدات المحمية'], ['Protected paths appear here when the tool is connected.', 'تظهر المسارات المحمية هنا عند وصل الأداة.'], 'table', { columns: [['Path', 'المسار'], ['Users', 'المستخدمون']] }),
  ],
  '/software/php': [
    section(['Domain and version', 'النطاق والإصدار'], ['No PHP selection yet', 'لا اختيار لـ PHP بعد'], 'fields', { fields: [['Domain', 'النطاق'], ['Version', 'الإصدار'], ['Handler', 'المعالج']], action: ['Save PHP settings', 'حفظ إعدادات PHP'] }),
    section(['PHP-FPM pool', 'مجمّع PHP'], ['The pool stays unset until a domain has a version.', 'يبقى المجمّع غير مضبوط إلى أن يملك النطاق إصدارًا.'], 'fields', { fields: [['Mode', 'الوضع'], ['Max children', 'الحد الأقصى للعمليات']] }),
    section(['INI values', 'قيم INI'], ['No directives are stored for this site.', 'لا توجيهات محفوظة لهذا الموقع.'], 'table', { columns: [['Directive', 'التوجيه'], ['Value', 'القيمة']] }),
    section(['Running now', 'ما يعمل الآن'], ['No process is reporting this selection.', 'لا عملية تبلغ عن هذا الاختيار.'], 'empty'),
    section(['Disabled functions', 'الدوال المعطلة'], ['No function list is stored.', 'لا قائمة دوال محفوظة.'], 'table', { columns: [['Function', 'الدالة']] }),
  ],
  '/software/htaccess': [
    section(['.htaccess', '.htaccess'], ['No .htaccess yet', 'لا ملف .htaccess بعد'], 'empty', { action: ['Save .htaccess', 'حفظ .htaccess'] }),
    section(['PHP settings in .htaccess', 'إعدادات PHP في الملف'], ['The editor stays blank until the file tool can read that path.', 'يبقى المحرر فارغًا إلى أن تستطيع أداة الملفات قراءة هذا المسار.'], 'fields', { fields: [['memory_limit', 'memory_limit'], ['max_execution_time', 'max_execution_time']] }),
    section(['Versions', 'الإصدارات'], ['No saved versions yet.', 'لا إصدارات محفوظة بعد.'], 'table', { columns: [['Version', 'الإصدار'], ['Saved', 'حُفظ']] }),
    section(['What a save does', 'ماذا يفعل الحفظ'], ['Saving writes that one file. It does not run from this empty editor.', 'الحفظ يكتب هذا الملف وحده. لا شيء يعمل من هذا المحرر الفارغ.'], 'note'),
  ],
  '/advanced/cron': [
    section(['How a job runs', 'كيف تعمل المهمة'], ['Each job runs as this account, inside its slice, through its own timer. Jobs share the plan limits.', 'تعمل كل مهمة بهذا الحساب، داخل شريحته، عبر مؤقتها. تتشارك المهام حدود الخطة.'], 'note'),
    section(['Scheduled jobs', 'المهام المجدولة'], ['No cron jobs yet', 'لا مهام مجدولة'], 'table', { columns: [['Job', 'المهمة'], ['Schedule', 'الجدول'], ['Command', 'الأمر'], ['Last run', 'آخر تشغيل'], ['Next run', 'التشغيل التالي']] }),
    section(['Add a cron job', 'إضافة مهمة'], ['Pick a schedule and a command. Nothing is stored from this empty form.', 'اختر جدولًا وأمرًا. لا يُحفظ شيء من هذا النموذج الفارغ.'], 'fields', { fields: [['Common schedules', 'الجداول الشائعة'], ['Minute', 'الدقيقة'], ['Hour', 'الساعة'], ['Day', 'اليوم'], ['Month', 'الشهر'], ['Weekday', 'يوم الأسبوع'], ['Command', 'الأمر']], action: ['Add a cron job', 'إضافة مهمة'] }),
    section(['Output email', 'بريد الناتج'], ['No output address is stored.', 'لا عنوان ناتج محفوظ.'], 'empty'),
  ],
  '/whm/server/setup': [
    section(['Detected on this host', 'ما كُشف على هذا المضيف'], ['Setup has not run', 'لم يبدأ الإعداد'], 'table', { columns: [['Check', 'الفحص'], ['Result', 'النتيجة']], action: ['Continue setup', 'متابعة الإعداد'] }),
    section(['PHP handlers by engine', 'معالجات PHP حسب المحرك'], ['Handlers appear when the setup tool is connected.', 'تظهر المعالجات عند وصل أداة الإعداد.'], 'table', { columns: [['Engine', 'المحرك'], ['Handler', 'المعالج']] }),
  ],
  '/whm/plans/features': [
    section(['Lists and the plans that use them', 'القوائم والخطط التي تستخدمها'], ['No feature lists yet', 'لا قوائم ميزات بعد'], 'table', { columns: [['List', 'القائمة'], ['Plans', 'الخطط']], action: ['Create list', 'إنشاء قائمة'] }),
    section(['Tools by list', 'الأدوات حسب القائمة'], ['No tools are assigned until a list exists.', 'لا تُسند أدوات إلى أن توجد قائمة.'], 'empty'),
    section(['Unsaved changes', 'تغييرات غير محفوظة'], ['Nothing is waiting to be saved.', 'لا شيء بانتظار الحفظ.'], 'empty'),
    section(['How lists apply', 'كيف تُطبَّق القوائم'], ['Saving a list does not change account data until the tool is connected.', 'حفظ قائمة لا يغيّر بيانات الحساب إلى أن تُوصل الأداة.'], 'note'),
  ],
  '/whm/domains': [
    section(['Domains', 'النطاقات'], ['No server domains yet', 'لا نطاقات للخادم بعد'], 'table', { columns: [['Domain', 'النطاق'], ['Account', 'الحساب']], action: ['Add domain', 'إضافة نطاق'] }),
    section(['Default site for unbound names', 'الموقع الافتراضي للأسماء غير المرتبطة'], ['The default site is not set from this empty screen.', 'لا يُضبط الموقع الافتراضي من هذه الشاشة الفارغة.'], 'empty'),
    section(['How a name finds its site', 'كيف يجد الاسم موقعه'], ['No route is stored until the domain tool is connected.', 'لا مسار محفوظ إلى أن تُوصل أداة النطاقات.'], 'note'),
  ],
  '/whm/services/web': [
    section(['Engine', 'المحرك'], ['No web server selection is stored.', 'لا اختيار لخادم الويب محفوظ.'], 'fields', { fields: [['Engine', 'المحرك']] }),
    section(['Apache MPM', 'Apache MPM'], ['No MPM is selected.', 'لا MPM محدد.'], 'empty'),
    section(['Backend connection', 'اتصال الخلفية'], ['No backend is stored.', 'لا خلفية محفوظة.'], 'empty'),
    section(['Nginx edge', 'حافة Nginx'], ['No edge setting is stored.', 'لا إعداد للحافة محفوظ.'], 'empty'),
    section(['Apache workers', 'عمال Apache'], ['No worker row is reported.', 'لا صف عمال مبلّغ عنه.'], 'table', { columns: [['Setting', 'الإعداد'], ['Value', 'القيمة']] }),
    section(['Pending change', 'تغيير معلّق'], ['No pending change', 'لا تغيير معلّق'], 'empty', { action: ['Apply web server change', 'تطبيق تغيير خادم الويب'] }),
    section(['Generations', 'الأجيال'], ['No generations are recorded for the web server.', 'لا أجيال مسجّلة لخادم الويب.'], 'table', { columns: [['Generation', 'الجيل'], ['Result', 'النتيجة']] }),
  ],
  '/whm/software/php': [
    section(['Installed versions', 'الإصدارات المثبّتة'], ['No PHP versions reported', 'لا إصدارات PHP مبلّغ عنها'], 'table', { columns: [['Version', 'الإصدار'], ['Domains', 'النطاقات'], ['Life', 'الدعم']], action: ['Install PHP', 'تثبيت PHP'] }),
    section(['Handlers', 'المعالجات'], ['Handlers stay blank until the package tool is connected.', 'تبقى المعالجات فارغة إلى أن تُوصل أداة الحزم.'], 'table', { columns: [['Handler', 'المعالج'], ['Version', 'الإصدار']] }),
    section(['Configure a version', 'ضبط إصدار'], ['No version is selected.', 'لا إصدار محدد.'], 'empty'),
    section(['Dangerous functions', 'الدوال الخطرة'], ['No function list is stored.', 'لا قائمة دوال محفوظة.'], 'table', { columns: [['Function', 'الدالة']] }),
  ],
  '/whm/ssl': [
    section(['AutoSSL', 'AutoSSL'], ['AutoSSL does not run from this empty queue.', 'لا يعمل AutoSSL من هذا الطابور الفارغ.'], 'empty', { action: ['Queue renewal', 'جدولة التجديد'] }),
    section(['Panel hostname certificate', 'شهادة اسم مضيف اللوحة'], ['No hostname certificate is stored.', 'لا شهادة لاسم المضيف محفوظة.'], 'empty'),
    section(['Certificates', 'الشهادات'], ['No certificates yet', 'لا شهادات بعد'], 'table', { columns: [['Certificate', 'الشهادة'], ['Expires', 'تنتهي']] }),
    section(['Renewal queue', 'طابور التجديد'], ['The queue is empty.', 'الطابور فارغ.'], 'table', { columns: [['Certificate', 'الشهادة'], ['When', 'الوقت']] }),
    section(['Renewal log', 'سجل التجديد'], ['No renewal has been recorded.', 'لا تجديد مسجّل.'], 'table', { columns: [['When', 'الوقت'], ['Result', 'النتيجة']] }),
  ],
  '/whm/dns': [
    section(['Zones', 'المناطق'], ['No zones yet', 'لا مناطق بعد'], 'table', { columns: [['Zone', 'المنطقة'], ['Serial', 'التسلسل']], action: ['Add a record', 'إضافة سجل'] }),
    section(['Add a record', 'إضافة سجل'], ['The record form stays blank until a zone exists.', 'يبقى نموذج السجل فارغًا إلى أن توجد منطقة.'], 'fields', { fields: [['Name', 'الاسم'], ['Type', 'النوع'], ['Value', 'القيمة']] }),
    section(['SOA serial', 'تسلسل SOA'], ['No serial until a zone is stored.', 'لا تسلسل إلى أن تُحفظ منطقة.'], 'empty'),
    section(['PowerDNS API', 'واجهة PowerDNS'], ['The DNS tool is not connected.', 'أداة DNS غير موصولة.'], 'note'),
  ],
  '/whm/security': [
    section(['Access', 'الوصول'], ['No panel security policy yet', 'لا سياسة أمان للوحة بعد'], 'empty', { action: ['Save panel security', 'حفظ أمان اللوحة'] }),
    section(['Two-factor for root', 'التحقق بخطوتين للجذر'], ['No second factor is stored for root.', 'لا عامل ثانٍ محفوظ للجذر.'], 'empty'),
    section(['Sign-in lockout', 'قفل الدخول'], ['No lockout rule is stored.', 'لا قاعدة قفل محفوظة.'], 'fields', { fields: [['Attempts', 'المحاولات'], ['Window', 'النافذة']] }),
    section(['Locked right now', 'المقفول الآن'], ['Nobody is locked.', 'لا أحد مقفول.'], 'table', { columns: [['Account', 'الحساب'], ['Until', 'حتى']] }),
    section(['API tokens', 'رموز API'], ['No tokens are stored.', 'لا رموز محفوظة.'], 'table', { columns: [['Token', 'الرمز'], ['State', 'الحالة']] }),
    section(['Dangerous PHP functions', 'دوال PHP الخطرة'], ['No function list is stored.', 'لا قائمة دوال محفوظة.'], 'table', { columns: [['Function', 'الدالة']] }),
    section(['Compiler lock', 'قفل المصرّف'], ['No compiler exception is stored.', 'لا استثناء مصرّف محفوظ.'], 'empty'),
  ],
  '/whm/security/ssh': [
    section(['Sign-in settings', 'إعدادات الدخول'], ['No SSH policy is stored.', 'لا سياسة SSH محفوظة.'], 'fields', { fields: [['Port', 'المنفذ'], ['Root login', 'دخول الجذر'], ['Password login', 'دخول كلمة المرور']], action: ['Save SSH settings', 'حفظ إعدادات SSH'] }),
    section(['Effective config', 'الإعداد الفعّال'], ['The effective file is not loaded.', 'الملف الفعّال غير محمّل.'], 'empty'),
    section(['Authorized keys for root', 'مفاتيح الجذر'], ['No keys are stored.', 'لا مفاتيح محفوظة.'], 'table', { columns: [['Key', 'المفتاح'], ['Comment', 'التعليق']] }),
    section(['Failed sign-ins', 'محاولات فاشلة'], ['No failed sign-ins are recorded.', 'لا محاولات فاشلة مسجّلة.'], 'table', { columns: [['Address', 'العنوان'], ['When', 'الوقت']] }),
    section(['Banned by SSH', 'محظور من SSH'], ['No addresses banned by SSH', 'لا عناوين محظورة من SSH'], 'table', { columns: [['Address', 'العنوان'], ['State', 'الحالة']] }),
  ],
  '/whm/backups': [
    section(['Runs', 'العمليات'], ['No backup runs yet', 'لا عمليات نسخ بعد'], 'table', { columns: [['Run', 'العملية'], ['Result', 'النتيجة']], action: ['Start backup', 'بدء النسخ'] }),
    section(['Restore', 'الاستعادة'], ['A restore is not offered from an empty history.', 'لا تُعرض استعادة من سجل فارغ.'], 'empty'),
    section(['What a restore does', 'ماذا تفعل الاستعادة'], ['A restore shows the difference first.', 'تعرض الاستعادة الفرق أولًا.'], 'note'),
    section(['Configuration', 'الإعداد'], ['No backup destination is stored.', 'لا وجه للنسخ محفوظ.'], 'fields', { fields: [['Destination', 'الوجه'], ['Schedule', 'الجدول']] }),
  ],
}

const page = (
  route: string,
  surface: DesignPage['surface'],
  group: Copy,
  label: Copy,
  title: Copy,
  lede: Copy,
  emptyTitle: Copy,
  emptyBody: Copy,
  columns: readonly Copy[],
  action: Copy,
  live = false,
): DesignPage => ({ route, surface, group, label, title, lede, emptyTitle, emptyBody, columns, action, live })

const general: Copy = ['General', 'عام']
const files: Copy = ['Files', 'الملفات']
const domains: Copy = ['Domains', 'النطاقات']
const databases: Copy = ['Databases', 'قواعد البيانات']
const email: Copy = ['Email', 'البريد']
const software: Copy = ['Software', 'البرمجيات']
const advanced: Copy = ['Advanced', 'متقدم']
const security: Copy = ['Security', 'الأمان']
const foundations: Copy = ['Foundations', 'الأسس']
const server: Copy = ['Server', 'الخادم']
const accounts: Copy = ['Accounts', 'الحسابات']
const web: Copy = ['Web', 'الويب']
const operations: Copy = ['Operations', 'التشغيل']
const mail: Copy = ['Mail', 'البريد']

export const designPages: readonly DesignPage[] = [
  page('/home', 'xpanel', general, ['Home', 'الرئيسية'], ['Home', 'الرئيسية'], ['Tools for this account. The plan’s feature list decides which tools appear here.', 'أدوات هذا الحساب. قائمة ميزات الخطة تحدد ما يظهر هنا.'], ['No tools to list yet', 'لا أدوات للعرض بعد'], ['Tool groups appear when this account’s plan can run them.', 'تظهر مجموعات الأدوات عندما تستطيع خطة هذا الحساب تشغيلها.'], [], ['Open a tool', 'افتح أداة'], true),
  page('/resources', 'xpanel', general, ['Resources & quotas', 'الموارد والحصص'], ['Resources & quotas', 'الموارد والحصص'], ['Limits on this account’s slice.', 'حدود شريحة هذا الحساب.'], ['No measurements yet', 'لا قياسات بعد'], ['CPU, memory, IO and process samples appear when the slice reports them.', 'تظهر عينات المعالج والذاكرة والقرص والعمليات عندما تبلغ عنها الشريحة.'], [['Limit', 'الحد'], ['Value', 'القيمة']], ['Refresh', 'تحديث'], true),
  page('/files/manager', 'xpanel', files, ['File manager', 'مدير الملفات'], ['File manager', 'مدير الملفات'], ['Files in this account’s home.', 'ملفات مجلد الحساب.'], ['This directory is empty', 'هذا المجلد فارغ'], ['Nothing is listed until the file tool returns a directory.', 'لا يُعرض شيء إلى أن تعيد أداة الملفات مجلدًا.'], [['Name', 'الاسم'], ['Size', 'الحجم'], ['Modified', 'آخر تعديل']], ['New file', 'ملف جديد'], true),
  page('/files/backup', 'xpanel', files, ['Backup wizard', 'معالج النسخ'], ['Backup wizard', 'معالج النسخ'], ['Archives for this account.', 'أرشيفات هذا الحساب.'], ['No archives yet', 'لا أرشيف بعد'], ['A restore never invents files that were not in an archive.', 'الاستعادة لا تخترع ملفات لم تكن في الأرشيف.'], [['Archive', 'الأرشيف'], ['Created', 'أُنشئ']], ['Create backup', 'إنشاء نسخة']),
  page('/files/directory-privacy', 'xpanel', files, ['Directory privacy', 'خصوصية المجلد'], ['Directory privacy', 'خصوصية المجلد'], ['Password protection for a directory.', 'حماية مجلد بكلمة مرور.'], ['No protected directories', 'لا مجلدات محمية'], ['Protected paths appear here when the tool is connected.', 'تظهر المسارات المحمية هنا عند وصل الأداة.'], [['Path', 'المسار'], ['Users', 'المستخدمون']], ['Protect a directory', 'احمِ مجلدًا']),
  page('/domains', 'xpanel', domains, ['Domains', 'النطاقات'], ['Domains', 'النطاقات'], ['Names this account serves.', 'الأسماء التي يخدمها هذا الحساب.'], ['No domains yet', 'لا نطاقات بعد'], ['The primary domain is shown only when the account record includes it.', 'يظهر النطاق الأساسي فقط عندما يتضمن سجل الحساب ذلك.'], [['Domain', 'النطاق'], ['Kind', 'النوع']], ['Create a domain', 'إنشاء نطاق'], true),
  page('/domains/site-settings', 'xpanel', domains, ['Site settings', 'إعدادات الموقع'], ['Site settings', 'إعدادات الموقع'], ['How this name is served.', 'كيف يُخدم هذا الاسم.'], ['No site configuration yet', 'لا إعداد للموقع بعد'], ['Document root and handlers appear when a domain is selected.', 'يظهر جذر المستندات والمعالج عند اختيار نطاق.'], [['Setting', 'الإعداد'], ['Value', 'القيمة']], ['Save', 'حفظ'], true),
  page('/domains/zone-editor', 'xpanel', domains, ['Zone editor', 'محرر المنطقة'], ['Zone editor', 'محرر المنطقة'], ['DNS records for this account’s zones.', 'سجلات DNS لمناطق هذا الحساب.'], ['No records yet', 'لا سجلات بعد'], ['The zone stays empty until a record is stored.', 'تبقى المنطقة فارغة إلى أن يُحفظ سجل.'], [['Name', 'الاسم'], ['Type', 'النوع'], ['Value', 'القيمة']], ['Add a record', 'إضافة سجل'], true),
  page('/databases/mariadb', 'xpanel', databases, ['MariaDB', 'MariaDB'], ['MariaDB', 'MariaDB'], ['Databases owned by this account.', 'قواعد البيانات التي يملكها هذا الحساب.'], ['No databases yet', 'لا قواعد بيانات بعد'], ['Users and privileges appear with the databases that exist.', 'يظهر المستخدمون والصلاحيات مع قواعد البيانات الموجودة.'], [['Database', 'قاعدة البيانات'], ['Users', 'المستخدمون']], ['Create a database', 'إنشاء قاعدة'], true),
  page('/email/accounts', 'xpanel', email, ['Email & users', 'البريد والمستخدمون'], ['Email and service users', 'البريد ومستخدمون الخدمة'], ['Mailboxes and service logins for this account.', 'صناديق البريد ودخول الخدمة لهذا الحساب.'], ['No service users yet', 'لا مستخدمي خدمة بعد'], ['Forwarders and quotas stay blank until a user exists.', 'تبقى إعادات التوجيه والحصص فارغة إلى أن يوجد مستخدم.'], [['Login', 'اسم الدخول'], ['Services', 'الخدمات']], ['Create a user', 'إنشاء مستخدم'], true),
  page('/software/php', 'xpanel', software, ['PHP', 'PHP'], ['PHP', 'PHP'], ['The PHP version and handler for this site.', 'إصدار PHP والمعالج لهذا الموقع.'], ['No PHP selection yet', 'لا اختيار لـ PHP بعد'], ['Version, pool and ini values appear when the runtime is connected.', 'يظهر الإصدار والمجمّع وقيم ini عند وصل بيئة التشغيل.'], [['Domain', 'النطاق'], ['Version', 'الإصدار'], ['Handler', 'المعالج']], ['Save PHP settings', 'حفظ إعدادات PHP']),
  page('/software/htaccess', 'xpanel', software, ['.htaccess', '.htaccess'], ['.htaccess editor', 'محرر .htaccess'], ['The .htaccess file for this site.', 'ملف .htaccess لهذا الموقع.'], ['No .htaccess yet', 'لا ملف .htaccess بعد'], ['The editor stays blank until the file tool can read that path.', 'يبقى المحرر فارغًا إلى أن تستطيع أداة الملفات قراءة هذا المسار.'], [['Version', 'الإصدار'], ['Saved', 'حُفظ']], ['Save .htaccess', 'حفظ .htaccess']),
  page('/advanced/cron', 'xpanel', advanced, ['Cron jobs', 'مهام مجدولة'], ['Cron jobs', 'المهام المجدولة'], ['Scheduled commands for this account.', 'أوامر مجدولة لهذا الحساب.'], ['No scheduled jobs', 'لا مهام مجدولة'], ['A job appears only after it is stored. Nothing runs from this empty list.', 'تظهر المهمة فقط بعد حفظها. لا شيء يعمل من هذه القائمة الفارغة.'], [['Schedule', 'الجدول'], ['Command', 'الأمر']], ['Add a cron job', 'إضافة مهمة']),
  page('/metrics/traffic', 'xpanel', advanced, ['Metrics', 'القياسات'], ['Metrics', 'القياسات'], ['Traffic for this account’s sites.', 'الزيارات لمواقع هذا الحساب.'], ['No requests logged for this selection yet', 'لا طلبات مسجّلة لهذا الاختيار بعد'], ['Visitors, errors and bandwidth stay at zero until logs exist.', 'يبقى الزوار والأخطاء والنطاق عند الصفر إلى أن توجد سجلات.'], [['Path', 'المسار'], ['Requests', 'الطلبات']], ['Refresh', 'تحديث'], true),
  page('/security/ssl', 'xpanel', security, ['SSL/TLS', 'SSL/TLS'], ['SSL/TLS', 'SSL/TLS'], ['Certificates stored for this account.', 'الشهادات المحفوظة لهذا الحساب.'], ['No certificates installed', 'لا شهادات مثبّتة'], ['Issuing a certificate needs an ACME client, and that client is not connected yet.', 'إصدار شهادة يحتاج عميل ACME، وهذا العميل غير موصول بعد.'], [['Domain', 'النطاق'], ['Certificate', 'الشهادة']], ['Run certificate wizard', 'تشغيل معالج الشهادة'], true),
  page('/security/account', 'xpanel', security, ['Security', 'الأمان'], ['Account security', 'أمان الحساب'], ['Sign-in, tokens and site protection for this account.', 'الدخول والرموز وحماية الموقع لهذا الحساب.'], ['No extra protection yet', 'لا حماية إضافية بعد'], ['Tokens and directory rules appear when they are stored.', 'تظهر الرموز وقواعد المجلدات عند حفظها.'], [['Item', 'العنصر'], ['State', 'الحالة']], ['Add a token', 'إضافة رمز'], true),
  page('/design/system', 'xpanel', foundations, ['Design system', 'نظام التصميم'], ['xPanel design system', 'نظام تصميم xPanel'], ['Color, type, buttons, status and fields used by every screen.', 'اللون والخط والأزرار والحالة والحقول التي تستخدمها كل الشاشات.'], ['Reference only', 'مرجع فقط'], ['These samples are the system. They are not account data.', 'هذه العينات هي النظام. ليست بيانات حساب.'], [['Token', 'الرمز'], ['Use', 'الاستخدام']], ['Copy token', 'نسخ الرمز']),
  page('/design/components', 'xpanel', foundations, ['Premium components', 'المكوّنات'], ['Premium components', 'المكوّنات المتقدمة'], ['Shared controls: search, progress, skeleton, toast and menus.', 'عناصر مشتركة: البحث والتقدم والهيكل والتنبيه والقوائم.'], ['No live example data', 'لا بيانات مثال حية'], ['Progress and lists stay empty here. Motion still uses the component timings.', 'يبقى التقدم والقوائم فارغة هنا. الحركة تستخدم توقيت المكوّنات.'], [], ['Open quick bar', 'فتح الشريط السريع']),
  page('/design/navigation', 'xpanel', foundations, ['Navigation map', 'خريطة التنقل'], ['Navigation map', 'خريطة التنقل'], ['The screen index. Opening a row goes to that route.', 'فهرس الشاشات. فتح صف ينتقل إلى ذلك المسار.'], ['Map', 'الخريطة'], ['Only the screens in this product are linked. Counts are not invented.', 'فقط شاشات هذا المنتج مربوطة. لا تُخترع أعداد.'], [['Screen', 'الشاشة'], ['Route', 'المسار']], ['Filter screens', 'تصفية الشاشات']),
  page('/whm', 'xwhm', server, ['Dashboard', 'اللوحة'], ['Server dashboard', 'لوحة الخادم'], ['What this server is doing.', 'ماذا يفعل هذا الخادم.'], ['No server sample yet', 'لا عينة للخادم بعد'], ['CPU, memory, disk and service rows appear when the host reports them.', 'تظهر صفوف المعالج والذاكرة والقرص والخدمات عندما يبلغ عنها المضيف.'], [['Resource', 'المورد'], ['Value', 'القيمة']], ['Refresh', 'تحديث'], true),
  page('/whm/server/setup', 'xwhm', server, ['Setup wizard', 'معالج الإعداد'], ['Set up this server', 'إعداد هذا الخادم'], ['Host detection and the services this panel will manage.', 'كشف المضيف والخدمات التي ستديرها هذه اللوحة.'], ['Setup has not run', 'لم يبدأ الإعداد'], ['Nothing is written until the setup tool is connected.', 'لا يُكتب شيء إلى أن تُوصل أداة الإعداد.'], [['Check', 'الفحص'], ['Result', 'النتيجة']], ['Continue setup', 'متابعة الإعداد']),
  page('/whm/accounts', 'xwhm', accounts, ['Accounts', 'الحسابات'], ['Accounts', 'الحسابات'], ['Hosting accounts on this server.', 'حسابات الاستضافة على هذا الخادم.'], ['No accounts yet', 'لا حسابات بعد'], ['The list stays empty until an account is stored.', 'تبقى القائمة فارغة إلى أن يُحفظ حساب.'], [['Username', 'اسم المستخدم'], ['Domain', 'النطاق'], ['Plan', 'الخطة']], ['Create account', 'إنشاء حساب'], true),
  page('/whm/accounts/new', 'xwhm', accounts, ['Create account', 'إنشاء حساب'], ['Create account', 'إنشاء حساب'], ['Username, primary domain, contact email and plan.', 'اسم المستخدم والنطاق الأساسي وبريد التواصل والخطة.'], ['Waiting for input', 'بانتظار الإدخال'], ['Nothing is created from an empty form.', 'لا يُنشأ شيء من نموذج فارغ.'], [], ['Create account', 'إنشاء حساب'], true),
  page('/whm/plans', 'xwhm', accounts, ['Plans', 'الخطط'], ['Plans', 'الخطط'], ['Hosting plans and the limits they apply.', 'خطط الاستضافة والحدود التي تطبّقها.'], ['No plans yet', 'لا خطط بعد'], ['Accounts cannot be assigned a plan that is not stored.', 'لا يمكن إسناد حساب إلى خطة غير محفوظة.'], [['Plan', 'الخطة'], ['Accounts', 'الحسابات']], ['Create plan', 'إنشاء خطة'], true),
  page('/whm/plans/features', 'xwhm', accounts, ['Feature lists', 'قوائم الميزات'], ['Feature lists', 'قوائم الميزات'], ['Which tools a plan shows.', 'أي الأدوات تعرضها الخطة.'], ['No feature lists yet', 'لا قوائم ميزات بعد'], ['Saving a list does not change account data until the tool is connected.', 'حفظ قائمة لا يغيّر بيانات الحساب إلى أن تُوصل الأداة.'], [['List', 'القائمة'], ['Plans', 'الخطط']], ['Create list', 'إنشاء قائمة']),
  page('/whm/resellers', 'xwhm', accounts, ['Resellers', 'الموزعون'], ['Resellers', 'الموزعون'], ['Reseller privileges and the accounts they own.', 'صلاحيات الموزع والحسابات التي يملكها.'], ['No resellers yet', 'لا موزعين بعد'], ['Privileges stay off until a reseller record exists.', 'تبقى الصلاحيات متوقفة إلى أن يوجد سجل موزع.'], [['Reseller', 'الموزع'], ['Accounts', 'الحسابات']], ['Create reseller', 'إنشاء موزع'], true),
  page('/whm/domains', 'xwhm', accounts, ['Domains', 'النطاقات'], ['Domains', 'النطاقات'], ['How a name finds its site on this server.', 'كيف يجد الاسم موقعه على هذا الخادم.'], ['No server domains yet', 'لا نطاقات للخادم بعد'], ['The default site for unbound names is not set from this empty screen.', 'لا يُضبط الموقع الافتراضي للأسماء غير المرتبطة من هذه الشاشة الفارغة.'], [['Domain', 'النطاق'], ['Account', 'الحساب']], ['Add domain', 'إضافة نطاق']),
  page('/whm/services/web', 'xwhm', web, ['Web server', 'خادم الويب'], ['Web server', 'خادم الويب'], ['The edge and the backend that serve sites.', 'الحافة والخلفية التي تخدم المواقع.'], ['No pending change', 'لا تغيير معلّق'], ['Engine, MPM and worker rows appear when the web server tool is connected.', 'تظهر صفوف المحرك وMPM والعمال عند وصل أداة خادم الويب.'], [['Setting', 'الإعداد'], ['Value', 'القيمة']], ['Apply web server change', 'تطبيق تغيير خادم الويب']),
  page('/whm/software/php', 'xwhm', web, ['PHP', 'PHP'], ['PHP versions and handlers', 'إصدارات PHP والمعالجات'], ['Versions installed for this server.', 'الإصدارات المثبّتة لهذا الخادم.'], ['No PHP versions reported', 'لا إصدارات PHP مبلّغ عنها'], ['Handlers and disabled functions stay blank until the package tool is connected.', 'تبقى المعالجات والدوال المعطلة فارغة إلى أن تُوصل أداة الحزم.'], [['Version', 'الإصدار'], ['Domains', 'النطاقات'], ['Life', 'الدعم']], ['Install PHP', 'تثبيت PHP']),
  page('/whm/ssl', 'xwhm', web, ['SSL/TLS', 'SSL/TLS'], ['SSL/TLS', 'SSL/TLS'], ['Certificates this server can issue and renew.', 'الشهادات التي يستطيع هذا الخادم إصدارها وتجديدها.'], ['No certificates yet', 'لا شهادات بعد'], ['AutoSSL does not run from this empty queue.', 'لا يعمل AutoSSL من هذا الطابور الفارغ.'], [['Certificate', 'الشهادة'], ['Expires', 'تنتهي']], ['Queue renewal', 'جدولة التجديد']),
  page('/whm/dns', 'xwhm', web, ['DNS zones', 'مناطق DNS'], ['DNS zones', 'مناطق DNS'], ['Zones served by this server.', 'المناطق التي يخدمها هذا الخادم.'], ['No zones yet', 'لا مناطق بعد'], ['Serial and records appear when a zone is stored.', 'يظهر التسلسل والسجلات عند حفظ منطقة.'], [['Zone', 'المنطقة'], ['Serial', 'التسلسل']], ['Add a record', 'إضافة سجل'], true),
  page('/whm/services', 'xwhm', web, ['Services', 'الخدمات'], ['Services', 'الخدمات'], ['Units this panel is allowed to reload.', 'الوحدات التي يُسمح لهذه اللوحة بإعادة تحميلها.'], ['No service report yet', 'لا تقرير خدمات بعد'], ['A reload is not offered until a unit is observed.', 'لا تُعرض إعادة التحميل إلى أن تُلاحظ وحدة.'], [['Service', 'الخدمة'], ['State', 'الحالة']], ['Reload service', 'إعادة تحميل الخدمة'], true),
  page('/whm/security/firewall', 'xwhm', security, ['Firewall', 'جدار الحماية'], ['Firewall', 'جدار الحماية'], ['The packet rules on this host.', 'قواعد الحزم على هذا المضيف.'], ['No firewall rules yet', 'لا قواعد جدار حماية بعد'], ['Saving does nothing until the firewall tool is connected.', 'الحفظ لا يفعل شيئًا إلى أن تُوصل أداة الجدار.'], [['Action', 'الإجراء'], ['Port', 'المنفذ']], ['Add a port rule', 'إضافة قاعدة منفذ'], true),
  page('/whm/security', 'xwhm', security, ['Panel security', 'أمان اللوحة'], ['Panel security', 'أمان اللوحة'], ['Who can reach this panel, and how sign-in is limited.', 'من يصل إلى هذه اللوحة، وكيف يُقيَّد الدخول.'], ['No panel security policy yet', 'لا سياسة أمان للوحة بعد'], ['Lockouts and tokens stay empty until the advisor is connected.', 'تبقى عمليات القفل والرموز فارغة إلى أن يُوصل المستشار.'], [['Check', 'الفحص'], ['State', 'الحالة']], ['Save panel security', 'حفظ أمان اللوحة']),
  page('/whm/security/ssh', 'xwhm', security, ['SSH', 'SSH'], ['SSH', 'SSH'], ['Sign-in settings for the host shell.', 'إعدادات الدخول إلى صدفة المضيف.'], ['No addresses banned by SSH', 'لا عناوين محظورة من SSH'], ['Keys and failed sign-ins appear when the SSH tool is connected.', 'تظهر المفاتيح ومحاولات الدخول الفاشلة عند وصل أداة SSH.'], [['Address', 'العنوان'], ['State', 'الحالة']], ['Save SSH settings', 'حفظ إعدادات SSH']),
  page('/whm/backups', 'xwhm', operations, ['Backups', 'النسخ الاحتياطي'], ['Server backups', 'نسخ الخادم'], ['Backup runs for this server.', 'عمليات النسخ لهذا الخادم.'], ['No backup runs yet', 'لا عمليات نسخ بعد'], ['A restore is not offered from an empty history.', 'لا تُعرض استعادة من سجل فارغ.'], [['Run', 'العملية'], ['Result', 'النتيجة']], ['Start backup', 'بدء النسخ'], true),
  page('/whm/monitoring/server-info', 'xwhm', server, ['Server information', 'معلومات الخادم'], ['Server information', 'معلومات الخادم'], ['Load, memory and disk from this host.', 'الحمل والذاكرة والقرص من هذا المضيف.'], ['No host sample yet', 'لا عينة للمضيف بعد'], ['Readings appear when the host answers.', 'تظهر القراءات عندما يجيب المضيف.'], [], ['Refresh', 'تحديث'], true),
  page('/whm/transfers', 'xwhm', operations, ['Transfer tool', 'أداة النقل'], ['Transfer tool', 'أداة النقل'], ['Move an account from another server or a backup.', 'انقل حسابًا من خادم آخر أو من نسخة.'], ['No transfer is running', 'لا نقل قيد التشغيل'], ['Import stays disabled until the transfer tool is connected.', 'يبقى الاستيراد معطلاً إلى أن تُوصل أداة النقل.'], [['Source', 'المصدر'], ['State', 'الحالة']], ['Start transfer', 'بدء النقل'], true),
  page('/whm/server/upgrade', 'xwhm', operations, ['Upgrade', 'الترقية'], ['Upgrade', 'الترقية'], ['A newer panel build, when one is published.', 'بناء أحدث للوحة، عند نشره.'], ['No upgrade is queued', 'لا ترقية في الانتظار'], ['Preflight stays unread until the upgrade tool reports a version.', 'يبقى الفحص الأولي غير مقروء إلى أن تبلغ أداة الترقية عن إصدار.'], [['Version', 'الإصدار'], ['Result', 'النتيجة']], ['Check upgrade', 'فحص الترقية'], true),
  page('/whm/audit', 'xwhm', operations, ['Audit log', 'سجل التدقيق'], ['Audit log', 'سجل التدقيق'], ['Actions recorded for this server.', 'الإجراءات المسجّلة لهذا الخادم.'], ['No audit entries yet', 'لا مدخلات تدقيق بعد'], ['Generations appear beside the entries that produced them.', 'تظهر الأجيال بجانب المدخلات التي أنتجتها.'], [['When', 'الوقت'], ['Actor', 'الفاعل'], ['Action', 'الإجراء']], ['Refresh', 'تحديث'], true),
  page('/mail/inbox', 'xmail', mail, ['Inbox', 'الوارد'], ['Inbox', 'البريد الوارد'], ['Messages observed for this mailbox.', 'الرسائل المرصودة لصندوق البريد هذا.'], ['No messages in this folder.', 'لا توجد رسائل في هذا المجلد.'], ['Folders and unread counts are not invented.', 'لا تُخترع المجلدات ولا أعداد غير المقروء.'], [['From', 'من'], ['Subject', 'الموضوع']], ['Refresh', 'تحديث'], true),
  page('/mail/compose', 'xmail', mail, ['Compose', 'إنشاء'], ['New message', 'رسالة جديدة'], ['Write a message from this mailbox.', 'اكتب رسالة من صندوق البريد هذا.'], ['Sending is not connected', 'الإرسال غير موصول'], ['This screen does not submit a message.', 'هذه الشاشة لا ترسل رسالة.'], [], ['Send', 'إرسال'], true),
]

const byRoute = new Map(designPages.map(item => [item.route, item]))

/** Specimen routes. They stay out of the product sidebar unless a development checkout sets this flag. Release builds leave it unset. */
const REFERENCE_DESIGN_ROUTES = new Set(['/design/system', '/design/components', '/design/navigation'])

export const designReferenceRoutesEnabled = (): boolean => process.env.XPANEL_DESIGN_PAGES === '1'

const productDesignPages = (): readonly DesignPage[] =>
  designReferenceRoutesEnabled() ? designPages : designPages.filter(item => !REFERENCE_DESIGN_ROUTES.has(item.route))

export const designPage = (route: string): DesignPage | undefined => byRoute.get(route)

export const designHeading = (route: string, locale: Locale): string | undefined => {
  const item = byRoute.get(route)
  if (!item || item.live) return undefined
  return locale === 'ar' ? item.title[1] : item.title[0]
}

const copy = (value: Copy, locale: Locale): string => locale === 'ar' ? value[1] : value[0]

export const renderDesignNav = (surface: DesignPage['surface'], locale: Locale, activeRoute: string, qualifiedRoutes: ReadonlySet<string>, visibility?: VisibilityContext): string => {
  const admittedRoutes = new Set(visibleRegisteredNavigation(visibility).filter(item => item.surface === surface).flatMap(item => item.sections.flatMap(section => section.pages.map(page => page.route))))
  const pages = productDesignPages().filter(item => item.surface === surface && admittedRoutes.has(item.route))
  const groups: { name: string; id: string; items: DesignPage[] }[] = []
  for (const item of pages) {
    const name = copy(item.group, locale)
    const existing = groups.find(group => group.name === name)
    if (existing) existing.items.push(item)
    else groups.push({ name, id: `${surface}-${groups.length}`, items: [item] })
  }
  const soonLabel = copy(soon, locale)
  return `<nav class="xp-nav-groups" aria-label="${escapeHtml(surface === 'xwhm' ? 'xWHM' : surface === 'xmail' ? 'xMail' : 'xPanel')}">${groups.map(group => `<div class="xp-nav-group" data-nav-section="${escapeHtml(group.id)}"><span class="xp-nav-group__label" id="${escapeHtml(group.id)}">${escapeHtml(group.name)}</span><ul class="xp-nav-group__items" aria-labelledby="${escapeHtml(group.id)}">${group.items.map(item => {
    const current = item.route === activeRoute
    const live = item.live && qualifiedRoutes.has(item.route)
    const label = copy(item.label, locale)
    const security = item.route === '/security/account' || item.route === '/whm/security'
    return `<li><a class="xp-nav-item${current ? ' xp-nav-item--active' : ''}${item.route === '/mail/compose' ? ' xp-mail-compose-link' : ''}" href="${escapeHtml(item.route)}" data-nav-route="${escapeHtml(item.route)}" data-nav-wiring="${live ? 'live' : 'soon'}"${security ? ' data-security-link="true"' : ''}${current ? ' aria-current="page"' : ''}><span>${escapeHtml(label)}</span>${live ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>`
  }).join('')}${surface === 'xpanel' && canOpenRegisteredRoute('/mail/inbox', visibility) && group.items.some(item => item.route === '/email/accounts') ? `<li><a class="xp-nav-item${activeRoute === '/mail/inbox' ? ' xp-nav-item--active' : ''}" href="/mail/inbox" data-nav-route="/mail/inbox" data-nav-wiring="${qualifiedRoutes.has('/mail/inbox') ? 'live' : 'soon'}"${activeRoute === '/mail/inbox' ? ' aria-current="page"' : ''}><span>xMail</span>${qualifiedRoutes.has('/mail/inbox') ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>` : ''}</ul></div>`).join('')}</nav>`
}

const disabledControl = (id: string, label: string): string => `<div class="xp-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label><input id="${escapeHtml(id)}" type="text" value="" disabled data-wiring="soon"></div>`

/** Empty document for a registered route without a dedicated data adapter. */
export const renderDisabledScreen = (title: string, locale: Locale): string => {
  const label = copy(soon, locale), body = copy(noneBody, locale)
  return `<section class="xp-design-page" data-wiring="soon" data-catalog-screen="true"><header class="xp-board-head"><div><h1 class="xp-page-title">${escapeHtml(title)}</h1><p class="xp-prose xp-design-page__lede">${escapeHtml(body)}</p></div><div class="xp-board-actions"><button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(label)}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(label)}</p></div></header><div class="xp-design-empty" role="status"><h2>${escapeHtml(label)}</h2><p class="xp-prose">${escapeHtml(body)}</p></div></section>`
}

const renderBoardSection = (route: string, block: BoardSection, index: number, locale: Locale): string => {
  const title = copy(block.title, locale)
  const headingId = `${route.replace(/[^a-z0-9]+/gi, '-')}-s${index}`
  const action = block.action
    ? `<button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(block.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p>`
    : ''
  if (block.kind === 'note') {
    return `<aside class="xp-board-note" role="note"><h2 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h2><p class="xp-prose">${escapeHtml(copy(block.body, locale))}</p></aside>`
  }
  const columns = block.columns ?? []
  const table = block.kind === 'table'
    ? `<div class="xp-table-wrap"><table class="xp-table" aria-labelledby="${escapeHtml(headingId)}"><thead><tr>${columns.map(column => `<th>${escapeHtml(copy(column, locale))}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${Math.max(columns.length, 1)}">${escapeHtml(copy(block.body, locale))}</td></tr></tbody></table></div>`
    : ''
  const fields = block.kind === 'fields'
    ? `<div class="xp-board-fields">${(block.fields ?? []).map((field, fieldIndex) => disabledControl(`${headingId}-f${fieldIndex}`, copy(field, locale))).join('')}</div>`
    : ''
  const empty = block.kind === 'empty' || block.kind === 'fields'
    ? `<div class="xp-design-empty" role="status"><h3>${escapeHtml(copy(block.body, locale))}</h3>${action}</div>`
    : action ? `<div class="xp-board-actions">${action}</div>` : ''
  return `<section class="xp-board-section" aria-labelledby="${escapeHtml(headingId)}"><header class="xp-board-section__head"><h2 id="${escapeHtml(headingId)}">${escapeHtml(title)}</h2></header><div class="xp-board-section__body">${table}${fields}${empty}</div></section>`
}

const renderTokenBoard = (locale: Locale): string => {
  const isAr = locale === 'ar'
  const swatches: readonly [string, string, string][] = [
    ['#F5F6F8', isAr ? 'القماش' : 'Canvas', 'canvas'],
    ['#101828', isAr ? 'النص' : 'Text', 'text'],
    ['#1D5BD6', isAr ? 'التمييز' : 'Accent', 'accent'],
    ['#0E7A4E', isAr ? 'سليم' : 'Ok', 'ok'],
    ['#B54708', isAr ? 'تحذير' : 'Warn', 'warn'],
    ['#B42318', isAr ? 'حرج' : 'Critical', 'critical'],
  ]
  return `<section class="xp-board-section" aria-labelledby="design-color"><header class="xp-board-section__head"><h2 id="design-color">${escapeHtml(isAr ? 'اللون' : 'Color')}</h2></header><div class="xp-board-section__body"><ul class="xp-swatches">${swatches.map(([color, name, id]) => `<li><span class="xp-swatch" style="background:${color}" data-token="${id}"></span><span>${escapeHtml(name)}</span><code><bdi dir="ltr">${color}</bdi></code></li>`).join('')}</ul></div></section>
  <section class="xp-board-section" aria-labelledby="design-type"><header class="xp-board-section__head"><h2 id="design-type">${escapeHtml(isAr ? 'الخط' : 'Type')}</h2></header><div class="xp-board-section__body"><p class="xp-type-sample xp-type-sample--page">${escapeHtml(isAr ? 'عنوان الصفحة' : 'Page title')}</p><p class="xp-type-sample">${escapeHtml(isAr ? 'نص الصفحة' : 'Body')}</p><p class="xp-mono">IBM Plex Mono</p></div></section>
  <section class="xp-board-section" aria-labelledby="design-buttons"><header class="xp-board-section__head"><h2 id="design-buttons">${escapeHtml(isAr ? 'الأزرار' : 'Buttons')}</h2></header><div class="xp-board-section__body xp-board-actions"><button type="button" class="xp-btn xp-btn--primary">${escapeHtml(isAr ? 'أساسي' : 'Primary')}</button><button type="button" class="xp-btn">${escapeHtml(isAr ? 'ثانوي' : 'Secondary')}</button><button type="button" class="xp-btn" disabled data-wiring="soon">${escapeHtml(isAr ? 'معطّل' : 'Disabled')}</button></div></section>
  <section class="xp-board-section" aria-labelledby="design-meter"><header class="xp-board-section__head"><h2 id="design-meter">${escapeHtml(isAr ? 'التقدم' : 'Progress')}</h2></header><div class="xp-board-section__body"><div class="xp-meter__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${escapeHtml(isAr ? 'فارغ' : 'Empty')}"><span class="xp-meter__fill" style="width:0%"></span></div><div class="xp-meter__track" aria-hidden="true"><span class="xp-meter__indet"></span></div><div class="xp-skeleton" aria-hidden="true"></div></div></section>`
}

const renderReferenceDetails = (locale: Locale): string => {
  const t = (en: string, ar: string): string => escapeHtml(locale === 'ar' ? ar : en)
  const specimen = (id: string, en: string, ar: string, body: string): string => `<section class="xp-board-section" data-component-specimen="${id}" aria-labelledby="comp-${id}"><header class="xp-board-section__head"><h2 id="comp-${id}">${t(en, ar)}</h2></header><div class="xp-board-section__body">${body}</div></section>`
  const disabledButton = (en: string, ar: string): string => `<button type="button" class="xp-btn" disabled>${t(en, ar)}</button>`
  const quickPages = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.filter(page => ['/whm/accounts', '/domains', '/software/php'].includes(page.route)).map(page => ({ surface: surface.surface, page }))))
  return `<aside class="xp-board-note" role="note"><h2>${t('Component specimens', 'نماذج المكونات')}</h2><p>${t('These examples describe interface states. They do not authenticate, write a file, transfer data, or report a real host operation.', 'تشرح هذه النماذج حالات الواجهة. لا تصادق على الدخول ولا تكتب ملفًا ولا تنقل بيانات ولا تعرض عملية فعلية على المضيف.')}</p></aside>
  ${specimen('quickbar', 'Quick bar, favorites and recents', 'شريط البحث والمفضلة والصفحات الأخيرة', `<div class="xp-field"><label for="spec-quickbar">${t('Search tools, accounts and domains', 'البحث في الأدوات والحسابات والنطاقات')}</label><input class="xp-input" id="spec-quickbar" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="spec-quickbar-results" type="search" disabled></div><div id="spec-quickbar-results" role="listbox" aria-label="${t('Registered pages', 'الصفحات المسجّلة')}">${quickPages.map(({ surface, page }) => `<div role="option" aria-selected="false"><span>${escapeHtml(getSurfaceNavigationLabel(surface, 'page', page, locale))}</span> <bdi dir="ltr">${escapeHtml(page.route)}</bdi></div>`).join('')}</div><p><kbd>↑</kbd> <kbd>↓</kbd> ${t('move', 'تنقّل')} · <kbd>Enter</kbd> ${t('open', 'فتح')} · <kbd>Esc</kbd> ${t('close', 'إغلاق')}</p><dl class="xp-board-stats"><div><dt>${t('Favorites', 'المفضلة')}</dt><dd>${t('Saved by the user', 'يحفظها المستخدم')}</dd></div><div><dt>${t('Recent pages', 'الصفحات الأخيرة')}</dt><dd>${t('Recorded after navigation', 'تُسجّل بعد التنقل')}</dd></div></dl>`)}
  ${specimen('verification', 'Verification code and recovery', 'رمز التحقق والاسترجاع', `<div class="xp-field"><label for="spec-otp">${t('Verification code', 'رمز التحقق')}</label><input class="xp-input" id="spec-otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" disabled aria-describedby="spec-otp-note"><p id="spec-otp-note" class="xp-help">${t('Paste and password managers remain available in the actual sign-in flow. Enrollment is optional.', 'يبقى اللصق ومديرو كلمات المرور متاحين في مسار الدخول الفعلي. التسجيل اختياري.')}</p></div>${disabledButton('Use a recovery code', 'استخدام رمز استرجاع')}`)}
  ${specimen('steps', 'Tabs and workflow steps', 'التبويبات ومراحل العمل', `<div class="xp-board-actions" role="tablist" aria-label="${t('Site configuration', 'إعدادات الموقع')}">${[['Domains', 'النطاقات'], ['Rewrite', 'إعادة الكتابة'], ['Proxy', 'الوكيل']].map(([en, ar], index) => `<button type="button" class="xp-btn" role="tab" aria-selected="${index === 0}" disabled>${t(en!, ar!)}</button>`).join('')}</div><ol class="xp-board-steps"><li><span>1</span><span>${t('Source', 'المصدر')}</span></li><li aria-current="step"><span>2</span><span>${t('Names and type', 'الأسماء والنوع')}</span></li><li><span>3</span><span>${t('Validation', 'التحقق')}</span></li></ol>`)}
  ${specimen('table', 'Dense table and selection', 'الجدول الكثيف والتحديد', `<div class="xp-table-wrap"><table class="xp-table"><caption class="sr-only">${t('Table structure', 'هيكل الجدول')}</caption><thead><tr><th scope="col"><input type="checkbox" disabled aria-label="${t('Select all', 'تحديد الكل')}"></th><th scope="col">${t('Account', 'الحساب')}</th><th scope="col">${t('Domain', 'النطاق')}</th><th scope="col">${t('Plan', 'الخطة')}</th><th scope="col">${t('Status', 'الحالة')}</th></tr></thead><tbody><tr><td colspan="5">${t('No host records are loaded in this specimen.', 'لا تُحمّل سجلات مضيف في هذا النموذج.')}</td></tr></tbody></table></div><div class="xp-board-actions">${disabledButton('Previous', 'السابق')}${disabledButton('Next', 'التالي')}</div>`)}
  ${specimen('upload', 'Upload, progress and cancellation', 'الرفع والتقدم والإلغاء', `<div class="xp-dropzone"><p>${t('Drop files here or use the file picker.', 'أفلت الملفات هنا أو استخدم منتقي الملفات.')}</p><label for="spec-upload">${t('Choose files', 'اختيار ملفات')}</label><input id="spec-upload" type="file" disabled></div><p role="status">${t('No upload is in progress.', 'لا توجد عملية رفع جارية.')}</p><div class="xp-meter__track" role="progressbar" aria-label="${t('Upload progress specimen', 'نموذج تقدم الرفع')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span class="xp-meter__fill" style="width:0%"></span></div>${disabledButton('Cancel upload', 'إلغاء الرفع')}`)}
  ${specimen('drawer', 'Drawer and confirmation', 'اللوحة الجانبية والتأكيد', `<details><summary>${t('Open drawer specimen', 'فتح نموذج اللوحة الجانبية')}</summary><div class="xp-board-section__body"><h3>${t('Review the selected record', 'مراجعة السجل المحدد')}</h3><p>${t('The real drawer preserves context, keyboard focus and a close action. No record is selected here.', 'تحافظ اللوحة الفعلية على السياق وتركيز لوحة المفاتيح وإجراء الإغلاق. لا يوجد سجل محدد هنا.')}</p><div class="xp-field"><label for="spec-confirm">${t('Type the account name to confirm', 'اكتب اسم الحساب للتأكيد')}</label><input class="xp-input" id="spec-confirm" disabled></div><div class="xp-board-actions">${disabledButton('Keep account', 'إبقاء الحساب')}${disabledButton('Confirm action', 'تأكيد الإجراء')}</div></div></details>`)}
  ${specimen('errors', 'Validation and operation feedback', 'التحقق ونتائج العمليات', `<div class="xp-field"><label for="spec-invalid">${t('Primary domain', 'النطاق الأساسي')}</label><input class="xp-input" id="spec-invalid" aria-invalid="true" aria-describedby="spec-invalid-help" disabled><p id="spec-invalid-help" class="xp-help">${t('A validation error identifies the affected field and explains how to correct it.', 'يحدد خطأ التحقق الحقل المتأثر ويوضح كيفية تصحيحه.')}</p></div><aside role="note"><p>${t('Pending work remains pending until its target is verified. A transport failure does not imply that the action completed.', 'يبقى العمل المعلّق كذلك إلى أن يُتحقق من هدفه. فشل الاتصال لا يعني أن الإجراء اكتمل.')}</p></aside>`)}
  ${specimen('code', 'Configuration block and technical values', 'كتلة الإعداد والقيم التقنية', `<pre class="xp-board-code"><code><bdi dir="ltr"># ${t('Configuration appears after an authorized read.', 'يظهر الإعداد بعد قراءة مصرح بها.')}</bdi></code></pre><p>${t('Paths, addresses and references keep their own direction inside the surrounding locale.', 'تحافظ المسارات والعناوين والمراجع على اتجاهها داخل لغة الواجهة المحيطة.')}</p>`)}
  ${specimen('shortcuts', 'Keyboard shortcuts', 'اختصارات لوحة المفاتيح', `<dl class="xp-board-stats"><div><dt>${t('Find a page', 'البحث عن صفحة')}</dt><dd><kbd>Ctrl</kbd> + <kbd>K</kbd></dd></div><div><dt>${t('Close a panel', 'إغلاق لوحة')}</dt><dd><kbd>Esc</kbd></dd></div><div><dt>${t('Move through controls', 'التنقل بين عناصر التحكم')}</dt><dd><kbd>Tab</kbd></dd></div></dl>`)} `
}


const renderComponentBoard = (locale: Locale): string => {
  const isAr = locale === 'ar'
  const t = (en: string, ar: string) => escapeHtml(isAr ? ar : en)
  const spinner = `<svg class="xp-status-icon xp-status-icon--spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D5BD6" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9"></path></svg>`
  return `<section class="xp-board-section" aria-labelledby="comp-buttons"><header class="xp-board-section__head"><h2 id="comp-buttons">${t('Buttons', 'الأزرار')}</h2></header><div class="xp-board-section__body xp-board-actions"><button type="button" class="xp-btn xp-btn--primary">${t('Primary', 'أساسي')}</button><button type="button" class="xp-btn">${t('Secondary', 'ثانوي')}</button><button type="button" class="xp-btn xp-btn--danger">${t('Danger', 'إنهاء')}</button><button type="button" class="xp-btn xp-btn--quiet">${t('View log', 'عرض السجل')}</button><button type="button" class="xp-btn" disabled>${t('Disabled', 'معطّل')}</button></div></section>
  <section class="xp-board-section" aria-labelledby="comp-pressed"><header class="xp-board-section__head"><h2 id="comp-pressed">${t('Pressed, switch, and segmented', 'مضغوط ومفتاح وتقسيم')}</h2></header><div class="xp-board-section__body"><div class="xp-board-actions"><button type="button" class="xp-chip" aria-pressed="true">${t('Pressed', 'مضغوط')}</button><button type="button" class="xp-chip" aria-pressed="false">${t('Idle', 'غير مضغوط')}</button></div><div class="xp-board-actions"><button type="button" class="xp-switch" role="switch" aria-checked="true" aria-label="${t('On', 'يعمل')}"></button><button type="button" class="xp-switch" role="switch" aria-checked="false" aria-label="${t('Off', 'متوقف')}"></button></div><div class="xp-segment" role="radiogroup" aria-label="${t('Segmented control', 'تحكم مقسّم')}"><button type="button" role="radio" aria-checked="false">${t('First', 'الأول')}</button><button type="button" role="radio" aria-checked="true">${t('Selected', 'محدد')}</button><button type="button" role="radio" aria-checked="false">${t('Last', 'الأخير')}</button></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-choice"><header class="xp-board-section__head"><h2 id="comp-choice">${t('Radio cards', 'بطاقات الاختيار')}</h2></header><div class="xp-board-section__body"><label class="xp-radio-card"><input type="radio" name="specimen-choice" checked>${t('Selected', 'محدد')}</label><label class="xp-radio-card"><input type="radio" name="specimen-choice">${t('Unselected', 'غير محدد')}</label><label class="xp-radio-card"><input type="radio" name="specimen-choice" disabled>${t('Unavailable', 'غير متاح')}</label></div></section>
  <section class="xp-board-section" aria-labelledby="comp-fields"><header class="xp-board-section__head"><h2 id="comp-fields">${t('Empty, disabled, error, and focus', 'فارغ ومعطّل وخطأ وتركيز')}</h2></header><div class="xp-board-section__body"><label for="specimen-empty">${t('Empty', 'فارغ')}</label><input id="specimen-empty" class="xp-specimen" value=""><label for="specimen-disabled">${t('Disabled', 'معطّل')}</label><input id="specimen-disabled" class="xp-specimen" value="" disabled placeholder="${t('Disabled', 'معطّل')}"><label for="specimen-error">${t('Error', 'خطأ')}</label><input id="specimen-error" class="xp-specimen" value="" aria-invalid="true" aria-describedby="specimen-error-text"><p id="specimen-error-text" class="xp-field-error">${t('This value is not valid.', 'هذه القيمة غير صالحة.')}</p><div class="xp-focus-sample">${t('Focus', 'التركيز')}</div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-tabs"><header class="xp-board-section__head"><h2 id="comp-tabs">${t('Tabs', 'التبويبات')}</h2></header><div class="xp-board-section__body"><div class="xp-tabs" role="tablist"><button type="button" role="tab" aria-selected="true">${t('Selected', 'محدد')}</button><button type="button" role="tab" aria-selected="false">${t('Idle', 'آخر')}</button></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-progress"><header class="xp-board-section__head"><h2 id="comp-progress">${t('Progress, quota, and loading', 'التقدم والحصة والتحميل')}</h2></header><div class="xp-board-section__body"><div class="xp-meter__track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${t('Empty', 'فارغ')}"><span class="xp-meter__fill" style="width:0%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('Below 80%', 'أقل من 80٪')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"><span class="xp-meter__fill xp-meter__fill--ok" style="width:40%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('At 80%', 'عند 80٪')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="80"><span class="xp-meter__fill xp-meter__fill--warn" style="width:80%"></span></div><div class="xp-meter__track" role="progressbar" aria-label="${t('At 95%', 'عند 95٪')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="95"><span class="xp-meter__fill xp-meter__fill--critical" style="width:95%"></span></div><div class="xp-meter__track" role="progressbar" aria-busy="true" aria-label="${t('Indeterminate', 'غير محدد')}"><span class="xp-meter__indet"></span></div><div class="xp-meter__track xp-meter__track--compact" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${t('Empty', 'فارغ')}"><span class="xp-meter__fill" style="width:0%"></span></div><p role="status">${spinner} ${t('Saving', 'جارٍ الحفظ')}</p></div></section>
  <section class="xp-board-section" aria-labelledby="comp-skeleton"><header class="xp-board-section__head"><h2 id="comp-skeleton">${t('Skeleton loading', 'التحميل الهيكلي')}</h2></header><div class="xp-board-section__body"><div class="xp-skeleton-stack" aria-busy="true" aria-label="${t('Loading', 'جارٍ التحميل')}">${[0, 1, 2].map(() => `<div class="xp-skeleton-row"><span class="xp-skeleton xp-skeleton-avatar"></span><span class="xp-skeleton-copy"><span class="xp-skeleton xp-skeleton-line"></span><span class="xp-skeleton xp-skeleton-line xp-skeleton-line--short"></span></span><span class="xp-skeleton xp-skeleton-pill"></span></div>`).join('')}</div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-toast"><header class="xp-board-section__head"><h2 id="comp-toast">${t('Toasts', 'التنبيهات')}</h2></header><div class="xp-board-section__body"><div class="xp-card xp-toast" role="status"><div class="xp-toast__body xp-toast__row"><span class="xp-toast__mark xp-toast__mark--ok" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M5 12l5 5 9-10"></path></svg></span><p>${t('No success notice is waiting.', 'لا يوجد إشعار نجاح بانتظار العرض.')}</p></div></div><div class="xp-card xp-toast" role="alert" data-toast-level="critical"><div class="xp-toast__body xp-toast__row"><span class="xp-toast__mark xp-toast__mark--critical" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6M12 17h.01"></path></svg></span><p>${t('No error notice is waiting.', 'لا يوجد إشعار خطأ بانتظار العرض.')}</p></div></div><div class="xp-card xp-toast xp-toast--undo" role="status"><p class="xp-toast__body">${t('No action is waiting to undo.', 'لا إجراء بانتظار التراجع.')}</p><span class="xp-toast__drain" aria-hidden="true"></span></div></div></section>
  <section class="xp-board-section" aria-labelledby="comp-empty"><header class="xp-board-section__head"><h2 id="comp-empty">${t('Empty and drop zone', 'فارغ ومنطقة الإفلات')}</h2></header><div class="xp-board-section__body"><div class="xp-design-empty" role="status"><h3>${t('Nothing here yet', 'لا شيء هنا بعد')}</h3><p>${t('This region stays empty until a tool is connected.', 'تبقى هذه المنطقة فارغة إلى أن تُربط الأداة.')}</p></div><div class="xp-dropzone"><span>${t('Drop files here', 'أفلت الملفات هنا')}</span><button type="button" class="xp-btn xp-btn--quiet">${t('Browse', 'استعراض')}</button></div></div></section>${renderReferenceDetails(locale)}`
}

const renderNavigationMap = (locale: Locale): string => {
  const title = (en: string, ar: string): string => escapeHtml(locale === 'ar' ? ar : en)
  const count = navigation.reduce((total, surface) => total + surface.sections.reduce((subtotal, section) => subtotal + section.pages.length, 0), 0)
  const notice = `<aside class="xp-board-note" role="note"><h2>${title('Registered navigation', 'التنقل المسجّل')}</h2><p>${count} ${title('registered pages. Route registration does not grant access or certify that its host capability is available.', 'صفحة مسجّلة. تسجيل المسار لا يمنح صلاحية الوصول ولا يثبت توافر قدرة المضيف.')}</p></aside>`
  const groups = navigation.map(surface => `<section class="xp-board-section" data-reference-surface="${surface.surface}"><header class="xp-board-section__head"><h2>${surface.surface === 'xwhm' ? 'xWHM' : surface.surface === 'xmail' ? 'xMail' : 'xPanel'}</h2></header><div class="xp-board-section__body">${surface.sections.map(section => `<section aria-labelledby="map-${surface.surface}-${escapeHtml(section.id)}"><h3 id="map-${surface.surface}-${escapeHtml(section.id)}">${escapeHtml(getSurfaceNavigationLabel(surface.surface, 'section', section, locale))}</h3><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th scope="col">${title('Page', 'الصفحة')}</th><th scope="col">${title('Route', 'المسار')}</th><th scope="col">${title('Layout', 'التخطيط')}</th><th scope="col">${title('Required roles', 'الأدوار المطلوبة')}</th></tr></thead><tbody>${section.pages.map(page => `<tr data-reference-route="${escapeHtml(page.route)}"><td><a href="${escapeHtml(page.route)}">${escapeHtml(getSurfaceNavigationLabel(surface.surface, 'page', page, locale))}</a></td><td><bdi dir="ltr">${escapeHtml(page.route)}</bdi></td><td><bdi dir="ltr">${escapeHtml(page.template)}</bdi></td><td><bdi dir="ltr">${escapeHtml(page.roles.join(', '))}</bdi></td></tr>`).join('')}</tbody></table></div></section>`).join('')}</div></section>`).join('')
  const aliases = `<section class="xp-board-section"><header class="xp-board-section__head"><h2>${title('Additional document destinations', 'وجهات المستندات الإضافية')}</h2></header><div class="xp-table-wrap"><table class="xp-table"><thead><tr><th scope="col">${title('Route', 'المسار')}</th><th scope="col">${title('Parent page', 'الصفحة الأصلية')}</th></tr></thead><tbody>${registeredDocumentAliases.map(alias => `<tr><td><a href="${escapeHtml(alias.route)}"><bdi dir="ltr">${escapeHtml(alias.route)}</bdi></a></td><td><bdi dir="ltr">${escapeHtml(alias.parentRoute)}</bdi></td></tr>`).join('')}</tbody></table></div></section>`
  return `${notice}${groups}${aliases}`
}

export const renderHomeToolGrid = (locale: Locale, qualifiedRoutes: ReadonlySet<string>): string => {
  const pages = productDesignPages().filter(item => item.surface === 'xpanel' && item.route !== '/home' && item.group[0] !== 'Foundations')
  const groups: { name: string; items: DesignPage[] }[] = []
  for (const item of pages) {
    const name = copy(item.group, locale)
    const existing = groups.find(group => group.name === name)
    if (existing) existing.items.push(item)
    else groups.push({ name, items: [item] })
  }
  const soonLabel = copy(soon, locale)
  return `<div class="xp-home-tools">${groups.map(group => `<section class="xp-board-section xp-tool-card" data-tool-card="true"><header class="xp-board-section__head"><h3>${escapeHtml(group.name)}</h3></header><ul class="xp-home-tool-list">${group.items.map(item => {
    const wired = item.live && qualifiedRoutes.has(item.route)
    return `<li><a class="xp-home-tool" href="${escapeHtml(item.route)}"><span>${escapeHtml(copy(item.label, locale))}</span>${wired ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>`
  }).join('')}${group.name === copy(email, locale) ? `<li><a class="xp-home-tool" href="/mail/inbox"><span>xMail</span>${qualifiedRoutes.has('/mail/inbox') ? '' : `<span class="xp-nav-soon">${escapeHtml(soonLabel)}</span>`}</a></li>` : ''}</ul></section>`).join('')}</div>`
}

export const renderDesignMain = (route: string, locale: Locale): string => {
  if (REFERENCE_DESIGN_ROUTES.has(route) && !designReferenceRoutesEnabled()) return ''
  const item = byRoute.get(route)
  if (!item) return ''
  const data = readDesignAdapter(route)
  const records = data.wired ? data.records : []
  const canvas = renderBoardCanvas(route, locale)
  const sections = canvas ? [] : (boardSections[route] ?? [])
  const crumb = `<nav class="xp-board-crumb" aria-label="${escapeHtml(locale === 'ar' ? 'مسار التنقل' : 'Breadcrumb')}"><ol><li>${escapeHtml(copy(item.group, locale))}</li><li aria-current="page">${escapeHtml(copy(item.label, locale))}</li></ol></nav>`
  const mapped = route === '/design/navigation' ? renderNavigationMap(locale) : ''
  const foundation = route === '/design/system' ? renderTokenBoard(locale) : route === '/design/components' ? renderComponentBoard(locale) : ''
  const blocks = canvas || sections.map((block, index) => renderBoardSection(route, block, index, locale)).join('')
  const fallback = canvas || sections.length || mapped || foundation ? '' : `<div class="xp-design-empty" role="status"><h2>${escapeHtml(copy(item.emptyTitle, locale))}</h2><p class="xp-prose">${escapeHtml(copy(records.length ? noneBody : item.emptyBody, locale))}</p><button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(item.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p></div>`
  const headerAction = canvas || sections.some(block => block.action) ? '' : `<button type="button" class="xp-btn xp-btn--primary" disabled data-wiring="soon">${escapeHtml(copy(item.action, locale))}</button><p class="xp-help" data-wiring-hint="soon">${escapeHtml(copy(soon, locale))}</p>`
  return `<section class="xp-design-page" data-design-page="${escapeHtml(route)}" data-design-adapter="${escapeHtml(route)}" data-wiring="${data.wired && records.length ? 'live' : 'soon'}">
    <header class="xp-board-head">
      <div>
        ${crumb}
        <h1 class="xp-page-title">${escapeHtml(copy(item.title, locale))}</h1>
        <p class="xp-prose xp-design-page__lede">${escapeHtml(copy(item.lede, locale))}</p>
      </div>
      <div class="xp-board-actions">${headerAction}</div>
    </header>
    ${foundation}${mapped}${blocks}${fallback}
  </section>`
}
