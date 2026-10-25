import type { ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts';
import { formatBytes } from '../tokens.ts';
type Copy = readonly [
    string,
    string
];
export interface PanelWorkspaceField {
    label: Copy;
    key?: string;
    value?: unknown;
    type?: string;
    choices?: readonly Copy[];
    technicalLabel?: boolean;
    technicalChoices?: boolean;
}
export interface PanelWorkspaceSection {
    id: string;
    title: Copy;
    fields?: PanelWorkspaceField[];
    actions?: Copy[];
    message?: Copy;
    columns?: Copy[];
    rows?: string[][];
    read?: boolean;
    steps?: Copy[];
    binding?: 'php' | 'dns';
    chart?: boolean;
}
export interface PanelWorkspacePage {
    title: Copy;
    description: Copy;
    sections: PanelWorkspaceSection[];
    aside: PanelWorkspaceSection[];
}
const radioFields = new Set(['Handler', 'Process manager', 'Backup type', 'Operation', 'Certificate source', 'Validation', 'Unknown recipient', 'Send output', 'Redirect type', 'Site type', 'Run directory', 'Web Disk access mode']);
const f = (label: Copy, value?: unknown, type?: string, choices?: readonly Copy[], technical?: Pick<PanelWorkspaceField, 'technicalLabel' | 'technicalChoices'>): PanelWorkspaceField => ({
    ...technical,
    label,
    ...(value === undefined ? {} : {
        value
    }),
    ...(type ? {
        type
    } : choices && radioFields.has(label[0]) ? {
        type: 'radio'
    } : {}),
    ...(choices ? {
        choices
    } : {}),
});
const collectionColumns: Record<string, Copy[]> = {
    forwarders: [
        ['Address', 'العنوان'], ['Destination', 'الوجهة']
    ],
    autoresponders: [
        ['Address', 'العنوان'], ['Subject', 'الموضوع'], ['Schedule', 'الجدولة']
    ],
};
const s = (id: string, title: Copy, fields: PanelWorkspaceField[] = [], actions?: Copy[]): PanelWorkspaceSection => ({
    id, title, fields, ...(collectionColumns[id] ? {
        columns: collectionColumns[id]
    } : {}), ...actions ? {
        actions
    } : {}
});
const t = (id: string, title: Copy, columns: Copy[], rows?: string[][], read = false): PanelWorkspaceSection => ({
    id, title, columns, ...rows ? {
        rows
    } : {}, read
});
const d = (id: string, title: Copy, message: Copy): PanelWorkspaceSection => ({
    id, title, message
});
const notRead: Copy = ['Not read', 'لم تُقرأ البيانات'];
const additionalSections = (route: string): PanelWorkspaceSection[] => route === '/email/accounts' ? [
    s('service-access', ['Create a service user', 'إنشاء مستخدم خدمة'], [
        f(['Username', 'اسم المستخدم']), f(['Password', 'كلمة المرور'], undefined, 'password'), f(['Mailbox quota (MB)', 'حصة صندوق البريد (MB)'], undefined, 'number'), f(['Email access', 'الوصول إلى البريد'], undefined, 'checkbox'), f(['FTP access', 'الوصول عبر FTP'], undefined, 'checkbox'), f(['Web Disk access', 'الوصول إلى قرص الويب'], undefined, 'checkbox'), f(['Unlimited mailbox quota', 'حصة بريد غير محدودة'], undefined, 'checkbox'), f(['FTP and Web Disk directory', 'مجلد FTP وقرص الويب']), f(['Web Disk access mode', 'وضع وصول قرص الويب'], undefined, undefined, [
            ['Read and write', 'قراءة وكتابة'], ['Read only', 'قراءة فقط']
        ])
    ], [
        ['Generate password', 'توليد كلمة مرور'], ['Cancel', 'إلغاء'], ['Create user', 'إنشاء مستخدم']
    ]),
    s('forwarder-management', ['Manage forwarder', 'إدارة إعادة التوجيه'], [
        f(['Address', 'العنوان'])
    ], [
        ['Delete forwarder', 'حذف إعادة التوجيه']
    ]),
    s('autoresponder-management', ['Manage autoresponder', 'إدارة الرد التلقائي'], [
        f(['Address', 'العنوان'])
    ], [
        ['Edit autoresponder', 'تعديل الرد التلقائي'], ['Delete autoresponder', 'حذف الرد التلقائي']
    ]),
] : route === '/security/account' ? [
    {
        ...s('token-one-time', ['Save your token', 'احفظ رمزك'], [
            f(['New token (shown once)', 'الرمز الجديد (يظهر مرة واحدة)'], undefined, 'password')
        ], [
            ['Copy token', 'نسخ الرمز'], ['Done', 'تم']
        ]),
        message: ['No token was issued by this workspace. A newly issued secret must be shown only once and must not be reconstructed from the token list.', 'لم يُصدر أي رمز من مساحة العمل هذه. يجب إظهار السر الجديد مرة واحدة فقط وعدم استنتاجه من قائمة الرموز.']
    },
    t('token-list', ['API token list', 'قائمة رموز API'], [
        ['Name', 'الاسم'], ['Scopes', 'النطاقات'], ['Allowed from', 'العناوين المسموحة'], ['Created', 'الإنشاء'], ['Expires', 'الانتهاء'], ['Last used', 'آخر استخدام'], ['Action', 'الإجراء']
    ]),
    s('token-revocation', ['Revoke a token', 'إلغاء رمز'], [
        f(['Token name', 'اسم الرمز'])
    ], [
        ['Keep', 'إبقاء'], ['Revoke', 'إلغاء الرمز']
    ]),
    s('token-scopes', ['Token scopes', 'نطاقات الرمز'], [
        f(['files:read', 'files:read'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['files:write', 'files:write'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['databases:read', 'databases:read'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['dns:write', 'dns:write'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['email:write', 'email:write'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['backups:create', 'backups:create'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f(['cron:write', 'cron:write'], undefined, 'checkbox', undefined, {
            technicalLabel: true
        })
    ]),
    t('ssh-key-list', ['SSH keys', 'مفاتيح SSH'], [
        ['Name', 'الاسم'], ['Fingerprint', 'البصمة'], ['Added', 'الإضافة'], ['Action', 'الإجراء']
    ]),
    s('ssh-key-removal', ['Remove an SSH key', 'إزالة مفتاح SSH'], [
        f(['Key name', 'اسم المفتاح'])
    ], [
        ['Keep', 'إبقاء'], ['Remove key', 'إزالة المفتاح']
    ]),
    s('shell-access', ['Shell access', 'الوصول إلى الطرفية'], [
        f(['Access mode', 'وضع الوصول'])
    ]),
    t('blocked-addresses', ['Blocked addresses', 'العناوين المحظورة'], [
        ['Address or range', 'العنوان أو النطاق'], ['Covers', 'نطاق التغطية']
    ]),
    s('unblock-address', ['Unblock an address', 'إلغاء حظر عنوان'], [
        f(['Address or range', 'العنوان أو النطاق'])
    ], [
        ['Unblock', 'إلغاء الحظر']
    ]),
    s('hotlink-referrer', ['Hotlink request policy', 'سياسة طلبات الربط'], [
        f(['Allow requests with no referrer', 'السماح بطلبات بلا محيل'], undefined, 'checkbox')
    ]),
    t('protected-directory-list', ['Protected folders', 'المجلدات المحمية'], [
        ['Folder', 'المجلد'], ['Prompt', 'رسالة الدخول'], ['Users', 'المستخدمون']
    ]),
    s('remove-directory-protection', ['Remove protection', 'إزالة الحماية'], [
        f(['Folder', 'المجلد'])
    ], [
        ['Keep', 'إبقاء'], ['Remove', 'إزالة']
    ]),
] : [];
const unreadNativeSections = (p: ApprovedXpanelWorkspaceProps): PanelWorkspaceSection[] => {
    if (p.nativeHtml) {
        if (p.route === '/domains')
            return [
                {
                    ...s('domain-create-details', ['Additional domain creation choices', 'خيارات إنشاء النطاق الإضافية'], [
                        f(['Alias name', 'الاسم البديل']), f(['Subdomain', 'النطاق الفرعي']),
                        f(['Under', 'ضمن'], undefined, undefined, (p.account ? p.domains?.filter(row => row.accountId === p.account!.id) : undefined)?.map(row => [
                            row.name, row.name
                        ]) ?? []),
                        f(['Document root', 'مجلد الموقع']), f(['PHP version', 'إصدار PHP']),
                        f(['Site type', 'نوع الموقع'], undefined, 'radio', [
                            ['PHP', 'PHP'], ['Static', 'ملفات ثابتة'], ['Proxy', 'وكيل']
                        ]),
                        f(['Create DNS records', 'إنشاء سجلات DNS'], undefined, 'checkbox'), f(['Issue a TLS certificate', 'إصدار شهادة TLS'], undefined, 'checkbox')
                    ]), message: ['The existing name and type form remains available. These additional choices are not connected to that form and stay disabled; they are not submitted.', 'يبقى نموذج الاسم والنوع الحالي متاحًا. هذه الخيارات الإضافية غير مرتبطة به وتبقى معطّلة ولا تُرسل.']
                }
            ];
        if (p.route === '/databases/mariadb') {
            const unread = p.locale === 'ar' ? notRead[1] : notRead[0];
            const databases = p.account ? p.databases?.filter(row => row.accountId === p.account!.id && !row.trashedAt) : undefined;
            return [
                {
                    ...t('database-list-details', ['Database details', 'تفاصيل قواعد البيانات'], [
                        ['Database', 'قاعدة البيانات'], ['Size', 'الحجم'], ['Tables', 'الجداول'], ['Users with access', 'المستخدمون المسموحون'], ['Collation', 'ترتيب الأحرف'], ['Last write', 'آخر كتابة']
                    ], databases?.map(row => [
                        row.name, unread, unread, unread, unread, unread
                    ]), databases !== undefined),
                    message: ['The existing database actions remain available. Table counts, collation and last-write readings have not been loaded; no values are inferred.', 'تبقى إجراءات قواعد البيانات الحالية متاحة. لم تُحمّل أعداد الجداول وترتيب الأحرف وآخر كتابة، ولا تُفترض قيم لها.']
                }
            ];
        }
        return [];
    }
    switch (p.route) {
        case '/email/accounts': return [
            t('mailbox-users-unread', ['Service users', 'مستخدمو الخدمة'], [
                ['Login', 'اسم الدخول'], ['Services', 'الخدمات'], ['Mailbox quota (MB)', 'حصة صندوق البريد (MB)'], ['File directory', 'مجلد الملفات'], ['Last sign-in', 'آخر دخول']
            ]),
            s('mailbox-create-unread', ['Create mailbox', 'إنشاء صندوق بريد'], [
                f(['Local name', 'الاسم المحلي']), f(['Domain', 'النطاق'], undefined, undefined, []), f(['Password', 'كلمة المرور'], undefined, 'password'), f(['Requested quota (MB)', 'الحصة المطلوبة (MB)'], undefined, 'number')
            ], [
                ['Generate password', 'توليد كلمة مرور'], ['Create mailbox', 'إنشاء صندوق بريد']
            ]),
            s('mailbox-password-unread', ['New mailbox password', 'كلمة مرور صندوق البريد الجديدة'], [
                f(['Password', 'كلمة المرور'], undefined, 'password')
            ], [
                ['Cancel', 'إلغاء'], ['Save', 'حفظ']
            ]),
            s('mailbox-quota-unread', ['Mailbox quota', 'حصة صندوق البريد'], [
                f(['Quota (MB)', 'الحصة (MB)'], undefined, 'number')
            ], [
                ['Cancel', 'إلغاء'], ['Save', 'حفظ']
            ]),
            s('mailbox-delete-unread', ['Delete mailbox', 'حذف صندوق البريد'], [
                f(['Confirmation', 'التأكيد'])
            ], [
                ['Cancel', 'إلغاء'], ['Delete mailbox', 'حذف صندوق البريد']
            ])
        ];
        case '/files/manager':
        case '/files/trash': return [
            s('file-browser-unread', ['Browse files', 'استعراض الملفات'], [
                f(['Path', 'المسار']), f(['Show hidden files', 'إظهار الملفات المخفية'], undefined, 'checkbox')
            ], [
                ['Files', 'الملفات'], ['Trash', 'السلة'], ['Parent folder', 'المجلد الأب'], ['Copy path', 'نسخ المسار'], ['Refresh', 'تحديث'], ['Upload', 'رفع ملف'], ['New file', 'ملف جديد'], ['New folder', 'مجلد جديد'], ['Clear selection', 'إلغاء التحديد']
            ]),
            t('file-list-unread', ['Files', 'الملفات'], [
                ['Name', 'الاسم'], ['Type', 'النوع'], ['Size', 'الحجم'], ['Permissions', 'الصلاحيات'], ['Modified (UTC)', 'التعديل (UTC)'], ['Owner', 'المالك'], ['Actions', 'الإجراءات']
            ]),
            s('file-editor-unread', ['File editor', 'محرر الملفات'], [
                f(['File', 'الملف']), f(['File contents', 'محتوى الملف'], undefined, 'textarea')
            ], [
                ['Close', 'إغلاق'], ['Discard draft', 'تجاهل المسودة'], ['Save', 'حفظ']
            ]),
            s('file-upload-unread', ['Upload files', 'رفع ملفات'], [
                f(['Files to upload', 'الملفات المطلوب رفعها'], undefined, 'file')
            ], [
                ['Cancel', 'إلغاء'], ['Upload', 'رفع ملف']
            ]),
            s('file-folder-unread', ['New folder', 'مجلد جديد'], [
                f(['Folder name', 'اسم المجلد'])
            ], [
                ['Cancel', 'إلغاء'], ['Create folder', 'إنشاء مجلد']
            ]),
            s('file-rename-unread', ['Rename file', 'إعادة تسمية ملف'], [
                f(['New name', 'الاسم الجديد'])
            ], [
                ['Cancel', 'إلغاء'], ['Rename', 'إعادة التسمية']
            ]),
            s('file-permissions-unread', ['File permissions', 'صلاحيات الملف'], [
                f(['Octal mode', 'الصلاحيات بالنظام الثماني'])
            ], [
                ['Cancel', 'إلغاء'], ['Save permissions', 'حفظ الصلاحيات']
            ]),
            {
                ...t('file-trash-unread', ['Trash', 'السلة'], [
                    ['Name', 'الاسم'], ['Was in', 'المكان السابق'], ['Deleted (UTC)', 'الحذف (UTC)'], ['Removed for good on', 'الحذف النهائي في'], ['Actions', 'الإجراءات']
                ]), actions: [
                    ['Empty trash', 'إفراغ السلة']
                ]
            },
            s('file-delete-unread', ['File removal and recovery', 'إزالة الملفات واستعادتها'], [
                f(['Confirmation', 'التأكيد'])
            ], [
                ['Cancel', 'إلغاء'], ['Move to trash', 'نقل إلى السلة'], ['Restore selected', 'استعادة المحدد'], ['Delete for good', 'الحذف نهائيًا']
            ])
        ];
        case '/domains': return [
            t('domain-list-unread', ['Your domains', 'نطاقاتك'], [
                ['Domain', 'النطاق'], ['Type', 'النوع'], ['Document root', 'مجلد الموقع'], ['IPv4', 'IPv4'], ['IPv6', 'IPv6'], ['Runtime', 'بيئة التشغيل'], ['Status', 'الحالة'], ['Actions', 'الإجراءات']
            ]),
            s('domain-create-unread', ['Create domain', 'إنشاء نطاق'], [
                f(['Domain name', 'اسم النطاق']), f(['Type', 'النوع'], undefined, 'radio', [
                    ['Addon domain', 'نطاق إضافي'], ['Subdomain', 'نطاق فرعي'], ['Alias', 'اسم بديل']
                ]), f(['Alias name', 'الاسم البديل']), f(['Subdomain', 'النطاق الفرعي']), f(['Under', 'ضمن'], undefined, undefined, []), f(['Parent domain', 'النطاق الأب'], undefined, undefined, []), f(['Document root', 'مجلد الموقع']), f(['Site type', 'نوع الموقع'], undefined, undefined, [
                    ['PHP', 'PHP'], ['Static', 'ملفات ثابتة'], ['Proxy', 'وكيل']
                ]), f(['IPv4', 'IPv4']), f(['IPv6', 'IPv6']), f(['PHP version', 'إصدار PHP']), f(['Create DNS records', 'إنشاء سجلات DNS'], undefined, 'checkbox'), f(['Issue a TLS certificate', 'إصدار شهادة TLS'], undefined, 'checkbox')
            ], [
                ['Cancel', 'إلغاء'], ['Create domain', 'إنشاء نطاق']
            ])
        ];
        case '/databases/mariadb': return [
            t('database-list-unread', ['Your databases', 'قواعد بياناتك'], [
                ['Database', 'قاعدة البيانات'], ['Size', 'الحجم'], ['Tables', 'الجداول'], ['Users with access', 'المستخدمون المسموحون'], ['Collation', 'ترتيب الأحرف'], ['Last write', 'آخر كتابة'], ['Actions', 'الإجراءات']
            ]),
            s('database-create-unread', ['Create database', 'إنشاء قاعدة بيانات'], [
                f(['Database name', 'اسم قاعدة البيانات'])
            ], [
                ['Create database', 'إنشاء قاعدة بيانات']
            ]),
            t('database-user-list-unread', ['Database users', 'مستخدمو قواعد البيانات'], [
                ['User', 'المستخدم'], ['Database grants', 'صلاحيات القواعد'], ['Last connection', 'آخر اتصال'], ['Actions', 'الإجراءات']
            ]),
            s('database-user-create-unread', ['Create database user', 'إنشاء مستخدم قاعدة بيانات'], [
                f(['Username', 'اسم المستخدم']), f(['Password', 'كلمة المرور'], undefined, 'password'), f(['Database', 'قاعدة البيانات'], undefined, undefined, [])
            ], [
                ['Create user', 'إنشاء مستخدم']
            ])
        ];
        case '/domains/zone-editor': return [
            t('dns-records-unread', ['Zone records', 'سجلات المنطقة'], [
                ['Name', 'الاسم'], ['Type', 'النوع'], ['TTL', 'TTL'], ['Content', 'المحتوى'], ['Priority', 'الأولوية'], ['Actions', 'الإجراءات']
            ])
        ];
        default: return [];
    }
};
export const buildApprovedPanelPage = (p: ApprovedXpanelWorkspaceProps): PanelWorkspacePage => {
    const a = p.account, plan = a && p.plan?.id === a.planId ? p.plan : undefined;
    const domains = a ? p.domains?.filter(x => x.accountId === a.id) : undefined;
    const domain = domains?.find(x => x.name === p.activeDomain || x.name === a?.primaryDomain) ?? domains?.[0];
    const php = domain?.php;
    const account = s('account-context', ['Account and plan', 'الحساب والخطة'], [
        f(['Account', 'الحساب'], a?.username), f(['Domain', 'النطاق'], a?.primaryDomain), f(['Plan', 'الخطة'], plan?.name)
    ]);
    const certificateSections: PanelWorkspaceSection[] = p.route === '/security/ssl' ? [
        s('certificate-names', ['Certificate names', 'أسماء الشهادة'], [
            f(['Name coverage', 'تغطية الأسماء'], undefined, 'radio', [
                ['A single name', 'اسم واحد'], ['Wildcard and base domain', 'البدل الشامل والنطاق الأساسي'], ['Custom names', 'أسماء مخصصة']
            ]), f(['Name', 'الاسم']), f(['Additional names (SAN)', 'أسماء إضافية (SAN)'], undefined, 'textarea')
        ]),
        {
            ...s('certificate-targets', ['Installation targets', 'أهداف التثبيت'], domains?.length ? domains.map(row => f([
                row.name, row.name
            ], undefined, 'checkbox', undefined, {
                technicalLabel: true
            })) : [
                f(['Installation targets not read', 'لم تُقرأ أهداف التثبيت'], undefined, undefined, [])
            ]), message: ['Coverage has not been read from the certificate. No target is assumed to be covered.', 'لم تُقرأ تغطية الأسماء من الشهادة. لا يُفترض أن أي هدف مشمول بالتغطية.']
        },
        {
            ...t('installed-certificates', ['Installed certificates', 'الشهادات المثبتة'], [
                ['Names', 'الأسماء'], ['Issuer', 'الجهة المصدرة'], ['Key', 'المفتاح'], ['Expires', 'الانتهاء'], ['Renewal', 'التجديد'], ['Installed on', 'مثبتة على']
            ]), actions: [
                ['View', 'عرض'], ['Renew now', 'التجديد الآن'], ['Remove', 'إزالة']
            ]
        },
        d('certificate-outcome', ['What happened', 'ماذا حدث'], ['No certificate installation result has been read. The issue or renewal response must confirm the affected names, installation and errors before success is shown.', 'لم تُقرأ نتيجة تثبيت شهادة. يجب أن تؤكد استجابة الإصدار أو التجديد الأسماء المتأثرة والتثبيت والأخطاء قبل إظهار النجاح.']),
    ] : [];
    const page = (title: Copy, description: Copy, sections: PanelWorkspaceSection[], aside: PanelWorkspaceSection[] = []): PanelWorkspacePage => ({
        title, description, sections: [
            ...unreadNativeSections(p), ...sections, ...additionalSections(p.route), ...certificateSections
        ], aside: [
            account, ...aside
        ]
    });
    switch (p.route) {
        case '/resources': return page(['Resources & quotas', 'الموارد والحصص'], ['Your account limits, live readings and the services in its slice.', 'حدود الحساب وقراءاته والخدمات ضمن شريحته.'], [
            s('slice-readings', ['Limits on your slice', 'حدود شريحتك'], [
                f(['Slice', 'الشريحة'], a ? `xpanel-${a.uid}.slice` : undefined), f(['Disk', 'القرص'], p.usage?.diskBytes == null ? undefined : formatBytes(p.usage.diskBytes)), f(['Memory', 'الذاكرة'], p.usage?.memoryBytes == null ? undefined : formatBytes(p.usage.memoryBytes)), f(['Processes', 'العمليات'], p.usage?.processCount)
            ], [
                ['Refresh live values', 'تحديث القراءات الحية']
            ]),
            {
                ...d('disk-io', ['Disk IO, last hour', 'إدخال وإخراج القرص، آخر ساعة'], ['Account IO history has not been read. No chart is inferred from plan limits.', 'لم يُقرأ سجل إدخال وإخراج الحساب. لا يُفترض رسم بياني من حدود الخطة.']), chart: true
            },
            t('resource-limits', ['Plan and applied limits', 'حدود الخطة والحدود المطبقة'], [
                ['Limit', 'الحد'], ['Plan value', 'قيمة الخطة'], ['Applied on host', 'المطبق على المضيف'], ['State', 'الحالة'], ['Live usage', 'الاستخدام الحي']
            ], ([
                ['CPU weight', 'وزن المعالج'], ['CPU quota', 'حصة المعالج'], ['Memory', 'الذاكرة'], ['Processes', 'العمليات'], ['IO weight', 'وزن إدخال القرص وإخراجه'], ['IO read', 'قراءة القرص'], ['IO write', 'كتابة القرص'], ['Bandwidth', 'حركة البيانات']
            ] as const).map(label => [
                label[p.locale === 'ar' ? 1 : 0], ...Array<string>(4).fill(p.locale === 'ar' ? notRead[1] : notRead[0])
            ])),
            s('resource-live', ['CPU, bandwidth and IO', 'المعالج وحركة البيانات وإدخال القرص وإخراجه'], [
                f(['CPU', 'المعالج']), f(['Bandwidth', 'حركة البيانات']), f(['IO read', 'قراءة القرص']), f(['IO write', 'كتابة القرص'])
            ]),
            t('slice-processes', ['Processes in your slice', 'العمليات في شريحتك'], [
                ['PID', 'معرف العملية'], ['Command and unit', 'الأمر والوحدة'], ['User', 'المستخدم'], ['CPU', 'المعالج'], ['Memory', 'الذاكرة'], ['Started (UTC)', 'البدء (UTC)']
            ]), s('resource-actions', ['Resource readings', 'قراءات الموارد'], [], [
                ['Try again', 'إعادة المحاولة'], ['View unit', 'عرض الوحدة']
            ])
        ], [
            s('serving-site', ['Who serves this site', 'من يخدم هذا الموقع'], [
                f(['Domain', 'النطاق'], domain?.name), f(['Document root', 'مجلد الموقع'], domain?.docRoot), f(['PHP version', 'إصدار PHP'], php?.version), f(['Handler', 'المعالج'], php?.handler)
            ])
        ]);
        case '/email/accounts': return page(['Email and service users', 'البريد ومستخدمو الخدمة'], ['Mailboxes, service access, forwarding and automatic replies.', 'صناديق البريد والوصول للخدمات وإعادة التوجيه والردود التلقائية.'], [
            s('forwarders', ['Forwarders', 'إعادة التوجيه'], [
                f(['Address', 'العنوان']), f(['Forward to', 'إعادة التوجيه إلى']), f(['Delivery', 'التسليم'], undefined, undefined, [
                    ['Forward to an address', 'إعادة التوجيه إلى عنوان'], ['Reject with an error', 'الرفض برسالة خطأ']
                ])
            ], [
                ['Add forwarder', 'إضافة إعادة توجيه']
            ]),
            s('autoresponders', ['Autoresponders', 'الردود التلقائية'], [
                f(['Address', 'العنوان']), f(['Subject', 'الموضوع']), f(['Message', 'الرسالة'], undefined, 'textarea'), f(['Starts (UTC)', 'البدء (UTC)'], undefined, 'datetime-local'), f(['Ends (UTC)', 'الانتهاء (UTC)'], undefined, 'datetime-local'), f(['No end date', 'بلا تاريخ انتهاء'], undefined, 'checkbox')
            ], [
                ['Add autoresponder', 'إضافة رد تلقائي']
            ]),
            s('default-address', ['Default address', 'العنوان الافتراضي'], [
                f(['Domain', 'النطاق'], undefined, undefined, (domains ?? []).map(x => [
                    x.name, x.name
                ])), f(['Unknown recipient', 'المستلم غير الموجود'], undefined, undefined, [
                    ['Reject with an error', 'الرفض برسالة خطأ'], ['Forward to an address', 'إعادة التوجيه إلى عنوان'], ['Discard silently', 'التجاهل بصمت']
                ])
            ], [
                ['Save default address', 'حفظ العنوان الافتراضي']
            ])
        ], [
            d('service-user-contract', ['How service users work', 'كيف يعمل مستخدمو الخدمة'], ['Email, FTP and Web Disk credentials are separate from account control-panel access.', 'بيانات دخول البريد وFTP وقرص الويب منفصلة عن الوصول إلى لوحة الحساب.']), s('mail-connections', ['Connection settings', 'إعدادات الاتصال'], [
                f(['Mailbox host', 'مضيف البريد']), f(['IMAP / SMTP', 'IMAP / SMTP']), f(['TLS', 'TLS'])
            ])
        ]);
        case '/files/manager':
        case '/files/trash': return page(['File manager', 'مدير الملفات'], ['Browse, edit and recover files in your account.', 'استعراض ملفات الحساب وتعديلها واستعادتها.'], [
            s('selection-actions', ['Selection actions', 'إجراءات الملفات المحددة'], [], [
                ['Copy', 'نسخ'], ['Move', 'نقل'], ['Compress', 'ضغط'], ['Extract', 'فك الضغط']
            ])
        ], [
            s('file-boundary', ['Your file workspace', 'مساحة ملفاتك'], [
                f(['Home', 'المجلد الرئيسي'], a?.home)
            ]), d('file-permissions', ['Permissions', 'الصلاحيات'], ['File operations stay inside the account home and retain its permission boundaries.', 'تبقى عمليات الملفات داخل المجلد الرئيسي للحساب وتحافظ على حدود صلاحياته.'])
        ]);
        case '/files/directory-privacy': return page(['Directory privacy', 'خصوصية المجلدات'], ['Protect folders with separate credentials.', 'حماية المجلدات ببيانات دخول منفصلة.'], [
            t('protected-folders', ['Protected folders', 'المجلدات المحمية'], [
                ['Folder', 'المجلد'], ['Prompt', 'رسالة الدخول'], ['Users', 'المستخدمون']
            ]),
            s('protect-folder', ['Protect a folder', 'حماية مجلد'], [
                f(['Folder', 'المجلد'], domain?.docRoot), f(['Prompt shown', 'رسالة الدخول']), f(['First user', 'المستخدم الأول']), f(['Password for this user', 'كلمة مرور هذا المستخدم'], undefined, 'password')
            ], [
                ['Protect folder', 'حماية المجلد']
            ])
        ]);
        case '/domains/site-settings': return page(['Site settings', 'إعدادات الموقع'], ['Site names, runtime, redirects, proxy and lifecycle settings.', 'أسماء الموقع وبيئة التشغيل والتحويلات والوكيل وإعدادات حالة الموقع.'], [
            s('site-selector', ['Site', 'الموقع'], [
                f(['Site', 'الموقع'], undefined, undefined, (domains ?? []).map(row => [
                    row.name, row.name
                ]))
            ]),
            s('site-binding', ['Names bound to this site', 'الأسماء المرتبطة بالموقع'], [
                f(['Primary name', 'الاسم الرئيسي'], domain?.name), f(['Bind another name', 'ربط اسم آخر'])
            ], [
                ['Bind name', 'ربط الاسم']
            ]),
            t('site-bound-names', ['Names bound to this site', 'الأسماء المرتبطة بالموقع'], [
                ['Name', 'الاسم'], ['Type', 'النوع'], ['Ports', 'المنافذ'], ['DNS', 'DNS'], ['Document root', 'مجلد الموقع'], ['Action', 'الإجراء']
            ], domains?.map(x => [
                x.name, x.kind, p.locale === 'ar' ? notRead[1] : notRead[0], p.locale === 'ar' ? notRead[1] : notRead[0], x.docRoot, p.locale === 'ar' ? notRead[1] : notRead[0]
            ]), domains !== undefined),
            s('site-name-actions', ['Manage bound names', 'إدارة الأسماء المرتبطة'], [], [
                ['Unbind', 'إلغاء الربط'], ['Edit', 'تعديل'], ['Delete', 'حذف']
            ]),
            t('site-header-rows', ['Custom headers', 'الترويسات المخصصة'], [
                ['Name', 'الاسم'], ['Value', 'القيمة']
            ], p.customConfig ? Object.entries(p.customConfig.customHeaders).map(([name, value]) => [
                name, value
            ]) : undefined, p.customConfig !== undefined),
            s('site-template', ['Template and headers', 'القالب والترويسات'], [
                f(['Template', 'القالب'], undefined, undefined, [
                    ['Default', 'الافتراضي'], ['WordPress', 'WordPress'], ['Laravel', 'Laravel'], ['Custom', 'مخصص']
                ]), f(['Header name', 'اسم الترويسة']), f(['Header value', 'قيمة الترويسة'])
            ], [
                ['Add header', 'إضافة ترويسة'], ['Remove header', 'إزالة الترويسة']
            ]),
            s('site-runtime', ['Runtime and document root', 'بيئة التشغيل ومجلد الموقع'], [
                f(['Document root', 'مجلد الموقع'], domain?.docRoot), f(['Run directory', 'مجلد التشغيل'], undefined, undefined, [
                    ['Document root', 'مجلد الموقع'], ['Subfolder /public', 'المجلد الفرعي /public']
                ]), f(['Site type', 'نوع الموقع'], domain?.siteType, undefined, [
                    ['php', 'PHP'], ['static', 'ملفات ثابتة'], ['proxy', 'وكيل'], ['node', 'Node.js'], ['python', 'Python']
                ]), f(['Node version', 'إصدار Node']), f(['App folder', 'مجلد التطبيق']), f(['Start command', 'أمر التشغيل']), f(['Port', 'المنفذ'], undefined, 'number'), f(['Python version', 'إصدار Python']), f(['Entry point', 'نقطة الدخول']), f(['Server', 'الخادم']), f(['Forward every request to', 'توجيه جميع الطلبات إلى'], domain?.upstream)
            ]),
            t('site-redirect-list', ['Saved redirects', 'التحويلات المحفوظة'], [
                ['From', 'من'], ['To', 'إلى'], ['Query string', 'معاملات الرابط'], ['Status', 'الحالة'], ['Actions', 'الإجراءات']
            ]),
            s('site-redirects', ['Redirects', 'التحويلات'], [
                f(['From path', 'من المسار']), f(['To', 'إلى']), f(['Redirect type', 'نوع التحويل'], undefined, undefined, [
                    ['301 Permanent', '301 دائم'], ['302 Temporary', '302 مؤقت']
                ]), f(['Keep query string', 'الاحتفاظ بمعاملات الرابط'], undefined, 'checkbox')
            ], [
                ['Add redirect', 'إضافة تحويل']
            ]),
            s('site-proxy', ['Proxy', 'الوكيل'], [
                f(['Path on this site', 'المسار على هذا الموقع']), f(['Upstream URL', 'رابط الخدمة الخلفية'], domain?.upstream), f(['Host header sent', 'ترويسة Host المرسلة']), f(['Cache responses', 'تخزين الاستجابات مؤقتًا'], undefined, 'checkbox'), f(['Keep for (seconds)', 'مدة الاحتفاظ (ثوانٍ)'], undefined, 'number'), f(['WebSocket upgrade', 'ترقية WebSocket'], undefined, 'checkbox')
            ]),
            s('site-logs', ['Runtime logs', 'سجلات التشغيل'], [
                f(['Log kind', 'نوع السجل'], undefined, undefined, [
                    ['Access', 'الوصول'], ['Error', 'الأخطاء'], ['Application', 'التطبيق']
                ]), f(['Lines', 'السطور'], undefined, 'number'), f(['Log preview', 'معاينة السجل'], undefined, 'textarea')
            ], [
                ['Refresh', 'تحديث'], ['Download', 'تنزيل']
            ]),
            s('site-lifecycle', ['Stop, expiry and path quota', 'الإيقاف والانتهاء وحصة المسار'], [
                f(['Message on the stopped page', 'رسالة الصفحة الموقوفة'], undefined, 'textarea'), f(['Stop the site on', 'إيقاف الموقع في'], domain?.expiresAt, 'date'), f(['Folder', 'المجلد'], domain?.docRoot), f(['Path quota (MB)', 'حصة المسار (MB)'], domain?.pathQuotaMb), f(['Unlimited path quota', 'حصة مسار غير محدودة'], domain?.pathQuotaMb === 'unlimited', 'checkbox'), f(['No expiry', 'بلا تاريخ انتهاء'], domain?.expiresAt === null, 'checkbox'), f(['Expiry reminder address', 'عنوان تذكير الانتهاء'], a?.contactEmail, 'email'), f(['Reminder days before expiry', 'أيام التذكير قبل الانتهاء'], undefined, 'number')
            ], [
                ['Reset', 'إعادة الضبط'], ['Stop site', 'إيقاف الموقع'], ['Start site', 'تشغيل الموقع'], ['Save site settings', 'حفظ إعدادات الموقع']
            ])
        ], [
            s('site-summary', ['Site binding', 'ربط الموقع'], [
                f(['Name', 'الاسم'], domain?.name), f(['Runtime', 'بيئة التشغيل'], domain?.siteType), f(['PHP', 'PHP'], php?.version)
            ])
        ]);
        case '/files/backup': return page(['Backup', 'النسخ الاحتياطي'], ['Choose contents, then review a restore before replacing data.', 'اختيار المحتويات ومراجعة الاسترجاع قبل استبدال البيانات.'], [
            {
                ...s('backup-wizard', ['Backup wizard', 'معالج النسخ الاحتياطي'], [
                    f(['Operation', 'العملية'], undefined, 'radio', [
                        ['Back up', 'نسخ احتياطي'], ['Restore', 'استعادة']
                    ]), f(['Backup type', 'نوع النسخة'], undefined, 'radio', [
                        ['Full account', 'الحساب كاملًا'], ['Home directory', 'المجلد الرئيسي'], ['Databases', 'قواعد البيانات'], ['Mail config', 'إعداد البريد']
                    ])
                ]), steps: [
                    ['What to include', 'محتوى النسخة'], ['Destination', 'الوجهة'], ['Review', 'المراجعة'], ['Result', 'النتيجة']
                ]
            },
            s('backup-include', ['What do you want to back up?', 'ماذا تريد نسخه؟'], [
                f(['Home directory files', 'ملفات المجلد الرئيسي'], undefined, 'checkbox'),
                f(['Folder', 'المجلد']), f(['Databases', 'قواعد البيانات'], undefined, 'checkbox'),
                f(['Mailboxes', 'صناديق البريد'], undefined, 'checkbox'), f(['Mail config', 'إعداد البريد'], undefined, 'checkbox')
            ]),
            {
                ...t('backup-databases', ['Database selection', 'اختيار قواعد البيانات'], [
                    ['Database', 'قاعدة البيانات'], ['Size', 'الحجم']
                ], (a ? p.databases?.filter(row => row.accountId === a.id && !row.trashedAt) : undefined)?.map(row => [
                    row.name, p.locale === 'ar' ? notRead[1] : notRead[0]
                ]), a !== undefined && p.databases !== undefined),
                fields: (a ? p.databases?.filter(row => row.accountId === a.id && !row.trashedAt) : undefined)?.map(row => f([
                    row.name, row.name
                ], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })) ?? [],
                message: ['A folder selection excludes mailboxes. Database selection and a consistent dump must be confirmed before a backup can run.', 'اختيار مجلد لا يشمل صناديق البريد. يجب تأكيد اختيار قواعد البيانات ونسختها المتسقة قبل تشغيل النسخ.']
            },
            s('backup-destination', ['Where should the archive go?', 'أين يذهب الأرشيف؟'], [
                f(['Destination', 'الوجهة'], undefined, 'radio', [
                    ['Download to this device', 'تنزيل إلى هذا الجهاز'], ['Local storage', 'تخزين محلي'], ['Remote storage', 'تخزين بعيد']
                ]), f(['Remote storage', 'التخزين البعيد'], undefined, undefined, []),
                f(['Email me when it is done', 'إرسال بريد عند الاكتمال'], undefined, 'checkbox'),
                f(['Completion email', 'بريد إشعار الاكتمال'], a?.contactEmail, 'email'), f(['Space check', 'فحص المساحة'])
            ], [
                ['Back', 'رجوع'], ['Review backup', 'مراجعة النسخة']
            ]),
            s('backup-summary', ['Review backup', 'مراجعة النسخة'], [
                f(['Contents', 'المحتويات']), f(['Destination', 'الوجهة']), f(['Estimated size', 'الحجم المتوقع']), f(['Available space', 'المساحة المتاحة'])
            ], [
                ['Create backup', 'إنشاء نسخة احتياطية']
            ]),
            {
                ...t('backup-progress', ['Backup progress and result', 'تقدم النسخ ونتيجته'], [
                    ['Time (UTC)', 'الوقت (UTC)'], ['Event', 'الحدث'], ['Result', 'النتيجة']
                ]), actions: [
                    ['Cancel backup', 'إلغاء النسخ']
                ],
                message: ['No backup run or result has been read. No archive, progress percentage or completed job is assumed.', 'لم تُقرأ عملية نسخ أو نتيجتها. لا يُفترض وجود أرشيف أو نسبة تقدم أو مهمة مكتملة.']
            },
            s('backup-restore', ['Choose an archive', 'اختيار أرشيف'], [
                f(['Archive', 'الأرشيف'], undefined, undefined, []), f(['Upload archive', 'رفع أرشيف'], undefined, 'file'),
                f(['Restore home directory files', 'استعادة ملفات المجلد الرئيسي'], undefined, 'checkbox'),
                f(['Restore databases', 'استعادة قواعد البيانات'], undefined, 'checkbox'),
                f(['Restore mailboxes', 'استعادة صناديق البريد'], undefined, 'checkbox'),
                f(['Restore mail config', 'استعادة إعداد البريد'], undefined, 'checkbox')
            ], [
                ['Review the difference', 'مراجعة الفرق']
            ]),
            s('backup-diff-summary', ['Difference summary', 'ملخص الفروق'], [
                f(['Added', 'المضاف']), f(['Changed', 'المتغير']), f(['Unchanged', 'دون تغيير']), f(['Missing from archive', 'غير الموجود في الأرشيف']),
                f(['Difference filter', 'تصفية الفرق'], undefined, 'radio', [
                    ['All differences', 'كل الفروق'], ['Added', 'المضاف'], ['Changed', 'المتغير'], ['Missing from archive', 'غير الموجود في الأرشيف'], ['Unchanged', 'دون تغيير']
                ])
            ]),
            {
                ...t('backup-diff', ['Review the difference', 'مراجعة الفرق'], [
                    ['Path', 'المسار'], ['Result', 'النتيجة'], ['In archive', 'في الأرشيف'], ['On disk now', 'على القرص الآن'], ['Planned action', 'الإجراء المخطط']
                ]), actions: [
                    ['Download full list (CSV)', 'تنزيل القائمة كاملة (CSV)']
                ],
                message: ['No archive has been selected or compared. Difference counts and planned changes have not been read.', 'لم يُحدد أو يُقارن أي أرشيف. لم تُقرأ أعداد الفروق أو التغييرات المخططة.']
            },
            t('backup-db-diff', ['Database differences', 'فروق قواعد البيانات'], [
                ['Database', 'قاعدة البيانات'], ['Planned action', 'الإجراء المخطط']
            ]),
            t('backup-mail-diff', ['Mailbox differences', 'فروق صناديق البريد'], [
                ['Mailbox', 'صندوق البريد'], ['Missing messages', 'الرسائل الناقصة'], ['Planned action', 'الإجراء المخطط']
            ]),
            t('backup-mail-config-diff', ['Mail config differences', 'فروق إعداد البريد'], [
                ['Setting', 'الإعداد'], ['In archive', 'في الأرشيف'], ['Current', 'الحالي'], ['Planned action', 'الإجراء المخطط']
            ]),
            {
                ...s('backup-restore-review', ['Before a restore', 'قبل الاسترجاع'], [
                    f(['Archive', 'الأرشيف']), f(['Selected parts', 'الأجزاء المحددة']), f(['Destination', 'الوجهة']),
                    f(['Overwrite warning', 'تنبيه الاستبدال']), f(['I reviewed the proposed restore changes', 'راجعت تغييرات الاستعادة المقترحة'], undefined, 'checkbox')
                ], [
                    ['Back', 'رجوع'], ['Restore selected parts', 'استعادة الأجزاء المحددة']
                ]),
                message: ['Acknowledgement stays unavailable until the actual archive, selected parts and proposed changes have been read. An uploaded archive is not proof of a successful restore.', 'يبقى التأكيد غير متاح حتى تُقرأ بيانات الأرشيف والأجزاء المحددة والتغييرات المقترحة. رفع الأرشيف لا يثبت نجاح الاسترجاع.']
            },
            {
                ...t('backup-history', ['Archives', 'الأرشيفات'], [
                    ['Archive', 'الأرشيف'], ['Created (UTC)', 'أُنشئت (UTC)'], ['Contents', 'المحتويات'], ['Size', 'الحجم'], ['Location', 'المكان'], ['Status', 'الحالة']
                ]), actions: [
                    ['Restore selected archive', 'استعادة الأرشيف المحدد'], ['Download selected archive', 'تنزيل الأرشيف المحدد'], ['Delete selected archive', 'حذف الأرشيف المحدد']
                ]
            }
        ], [
            d('backup-safety', ['What a restore never does', 'ما لا تفعله الاستعادة'], ['A restore must show the difference first, keep files missing from the archive, keep newer mail and unrelated mail settings, and restore databases separately from home files. These protections have not been verified by a run here.', 'يجب أن تعرض الاستعادة الفروق أولًا وتحافظ على الملفات غير الموجودة في الأرشيف والبريد الأحدث وإعدادات البريد الأخرى، وأن تستعيد قواعد البيانات منفصلة عن ملفات المجلد الرئيسي. لم تُثبت هذه الضمانات بعملية استعادة هنا.']),
            s('backup-location', ['Where archives live', 'أماكن الأرشيفات'], [
                f(['Account folder', 'مجلد الحساب']), f(['Remote storage', 'التخزين البعيد']), f(['Server backups', 'نسخ السيرفر']), f(['Retention policy', 'سياسة الاحتفاظ'])
            ])
        ]);
        case '/databases/mariadb': return page(['MariaDB databases', 'قواعد بيانات MariaDB'], ['Databases, users and grants within this account.', 'قواعد البيانات والمستخدمون والصلاحيات ضمن الحساب.'], [
            s('database-rename', ['Rename database', 'إعادة تسمية قاعدة بيانات'], [
                f(['Database', 'قاعدة البيانات'], undefined, undefined, []), f(['New database name', 'الاسم الجديد لقاعدة البيانات'])
            ], [
                ['Cancel', 'إلغاء'], ['Rename database', 'إعادة تسمية قاعدة البيانات']
            ]),
            s('database-drop-confirmation', ['Drop database permanently', 'حذف قاعدة البيانات نهائيًا'], [
                f(['Database name to confirm', 'اسم قاعدة البيانات للتأكيد'])
            ], [
                ['Cancel', 'إلغاء'], ['Drop permanently', 'الحذف نهائيًا']
            ]),
            s('database-generate-password', ['New database user password', 'كلمة مرور مستخدم قاعدة البيانات الجديد'], [
                f(['Password', 'كلمة المرور'], undefined, 'password')
            ], [
                ['Generate password', 'توليد كلمة مرور'], ['Clear', 'مسح']
            ]),
            s('database-advanced-privileges', ['Advanced privileges', 'الصلاحيات المتقدمة'], [
                f(['All privileges', 'كل الصلاحيات'], undefined, 'checkbox')
            ], [
                ['Show advanced privileges', 'إظهار الصلاحيات المتقدمة'], ['Hide advanced privileges', 'إخفاء الصلاحيات المتقدمة']
            ]),
            t('remote-database-hosts', ['Allowed database hosts', 'مضيفو قواعد البيانات المسموحون'], [
                ['Host', 'المضيف'], ['Comment', 'الملاحظة'], ['Added', 'الإضافة'], ['Firewall', 'الجدار الناري']
            ]),
            s('remote-database-remove', ['Remove allowed host', 'إزالة مضيف مسموح'], [
                f(['Host', 'المضيف'])
            ], [
                ['Remove', 'إزالة']
            ]),
            s('database-create-options', ['Create database options', 'خيارات إنشاء قاعدة البيانات'], [
                f(['Collation', 'ترتيب الأحرف'], undefined, undefined, [
                    ['Use server default', 'استخدام افتراضي السيرفر'], ['utf8mb4_unicode_ci', 'utf8mb4_unicode_ci'], ['utf8mb4_general_ci', 'utf8mb4_general_ci']
                ]), f(['Create a user with this database', 'إنشاء مستخدم لهذه القاعدة'], undefined, 'checkbox')
            ]),
            s('database-grants-review', ['Desired privileges', 'الصلاحيات المطلوبة'], [
                f(['Database', 'قاعدة البيانات'], undefined, undefined, (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : [])?.map(x => [
                    x.name, x.name
                ]) ?? []), f(['User', 'المستخدم'], undefined, undefined, p.databaseUsers?.map(x => [
                    x.name, x.name
                ]) ?? []), f(['SELECT', 'SELECT'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['INSERT', 'INSERT'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['UPDATE', 'UPDATE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['DELETE', 'DELETE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['CREATE', 'CREATE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['ALTER', 'ALTER'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['DROP', 'DROP'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['INDEX', 'INDEX'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['CREATE VIEW', 'CREATE VIEW'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['SHOW VIEW', 'SHOW VIEW'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['TRIGGER', 'TRIGGER'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['EVENT', 'EVENT'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['EXECUTE', 'EXECUTE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })
            ], [
                ['Discard changes', 'تجاهل التغييرات'], ['Save privileges', 'حفظ الصلاحيات']
            ]),
            s('database-change-password', ['Change user password', 'تغيير كلمة مرور المستخدم'], [
                f(['User', 'المستخدم'], undefined, undefined, p.databaseUsers?.map(x => [
                    x.name, x.name
                ]) ?? []), f(['New password', 'كلمة المرور الجديدة'], undefined, 'password'), f(['Repeat password', 'تكرار كلمة المرور'], undefined, 'password')
            ], [
                ['Change password', 'تغيير كلمة المرور']
            ]),
            s('database-trash-policy', ['Database trash', 'سلة قواعد البيانات'], [], [
                ['Undo deletion', 'التراجع عن الحذف'], ['Restore selected', 'استعادة المحدد'], ['Delete for good', 'الحذف نهائيًا']
            ]),
            t('database-usage', ['Database usage', 'استخدام قواعد البيانات'], [
                ['Database', 'قاعدة البيانات'], ['Engine', 'المحرك'], ['Size', 'الحجم']
            ], (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : undefined)?.map(x => [
                x.name, x.engine, p.locale === 'ar' ? notRead[1] : notRead[0]
            ]), a !== undefined && p.databases !== undefined),
            s('database-privileges', ['User privileges', 'صلاحيات المستخدم'], [
                f(['Database', 'قاعدة البيانات'], undefined, undefined, (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : [])?.map(x => [
                    x.name, x.name
                ]) ?? []), f(['SELECT', 'SELECT'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['INSERT', 'INSERT'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['UPDATE', 'UPDATE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['DELETE', 'DELETE'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f(['CREATE / ALTER / DROP', 'CREATE / ALTER / DROP'], undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })
            ], [
                ['Save privileges', 'حفظ الصلاحيات']
            ]),
            s('database-connection', ['Connection details', 'تفاصيل الاتصال'], [
                f(['Host', 'المضيف']), f(['Port', 'المنفذ']), f(['Database name', 'اسم قاعدة البيانات']), f(['Username', 'اسم المستخدم'])
            ], [
                ['Copy connection details', 'نسخ تفاصيل الاتصال']
            ]),
            s('remote-database-access', ['Remote access', 'الوصول البعيد'], [
                f(['Allowed host or address', 'المضيف أو العنوان المسموح']), f(['Comment (optional)', 'ملاحظة (اختيارية)'])
            ], [
                ['Add host', 'إضافة مضيف']
            ])
        ], [
            d('database-grants', ['Names and grants', 'الأسماء والصلاحيات'], ['Users receive access only to databases included in their saved grants.', 'لا يحصل المستخدم إلا على الوصول إلى قواعد البيانات المحددة في صلاحياته المحفوظة.'])
        ]);
        case '/domains': return page(['Domains', 'النطاقات'], ['Names, document roots, IP addresses and runtimes.', 'الأسماء ومجلدات المواقع وعناوين IP وبيئات التشغيل.'], [
            s('domain-rename-primary', ['Rename primary domain', 'إعادة تسمية النطاق الرئيسي'], [
                f(['Current primary domain', 'النطاق الرئيسي الحالي'], a?.primaryDomain), f(['New primary domain', 'النطاق الرئيسي الجديد']), f(['Keep old domain as an alias', 'الاحتفاظ بالنطاق القديم كاسم بديل'], undefined, 'checkbox'), f(['Type current primary domain to confirm', 'اكتب النطاق الرئيسي الحالي للتأكيد'])
            ], [
                ['Rename primary domain', 'إعادة تسمية النطاق الرئيسي']
            ]),
            d('domain-rename-changes', ['What changes', 'ما الذي يتغير'], ['The reviewed rename plan must list affected mailboxes, certificates and subdomains. No migration plan has been read or applied.', 'يجب أن تسرد خطة إعادة التسمية صناديق البريد والشهادات والنطاقات الفرعية المتأثرة. لم تُقرأ أو تُطبق خطة نقل.']),
            d('domain-rename-stays', ['What stays', 'ما الذي يبقى'], ['The account identity, files and databases must remain intact. No rename is available from this workspace until its scoped migration and rollback are implemented.', 'يجب الحفاظ على هوية الحساب وملفاته وقواعد بياناته. لا تتوفر إعادة التسمية من هذه المساحة حتى تنفيذ النقل المحدد للحساب والتراجع عنه.']),
            d('domain-create-review', ['This will create', 'ما الذي سيُنشأ'], ['The domain, aliases, DNS and certificate changes must be reviewed from an actual plan. No creation plan has been read.', 'يجب مراجعة تغييرات النطاق والأسماء البديلة وDNS والشهادة من خطة فعلية. لم تُقرأ خطة إنشاء.']),
            s('domain-binding', ['How names are served', 'كيف تُخدم الأسماء'], [
                f(['Primary domain', 'النطاق الرئيسي'], a?.primaryDomain), f(['Default IPv4', 'عنوان IPv4 الافتراضي'], a?.ipv4), f(['Default IPv6', 'عنوان IPv6 الافتراضي'], a?.ipv6)
            ])
        ], [
            s('domain-limits', ['Domain limits', 'حدود النطاقات'], [
                f(['Saved domains', 'النطاقات المحفوظة'], domains?.length), f(['Addon-domain limit', 'حد النطاقات الإضافية'], plan?.caps.addonDomains)
            ])
        ]);
        case '/domains/zone-editor': return page(['Zone editor', 'محرر المنطقة'], ['Review records and check deliverability separately.', 'مراجعة السجلات وفحص قابلية التسليم بصورة منفصلة.'], [
            s('email-deliverability', ['Email deliverability', 'قابلية تسليم البريد'], [
                f(['SPF', 'SPF']), f(['DKIM', 'DKIM']), f(['DMARC', 'DMARC']), f(['Reverse DNS', 'DNS العكسي'])
            ], [
                ['Check status', 'فحص الحالة'], ['Check again', 'الفحص مجددًا'], ['Fix', 'إصلاح']
            ]),
            s('dns-record-filter', ['Record type filter', 'تصفية نوع السجل'], [
                f(['Zone', 'المنطقة'], undefined, undefined, (domains ?? []).map(row => [
                    row.name, row.name
                ])), f(['Show record types', 'أنواع السجلات المعروضة'], undefined, 'radio', [
                    ['All', 'الكل'], ['A', 'A'], ['AAAA', 'AAAA'], ['CNAME', 'CNAME'], ['MX', 'MX'], ['TXT', 'TXT'], ['SRV', 'SRV'], ['CAA', 'CAA']
                ], {
                    technicalChoices: true
                })
            ], [
                ['Edit record', 'تعديل سجل'], ['Delete record', 'حذف سجل']
            ]),
            {
                ...s('dns-add-record', ['Records and zone editor', 'السجلات ومحرر المنطقة'], [
                    f(['Type', 'النوع'], undefined, undefined, [
                        ['A', 'A'], ['AAAA', 'AAAA'], ['CNAME', 'CNAME'], ['MX', 'MX'], ['TXT', 'TXT'], ['SRV', 'SRV'], ['CAA', 'CAA']
                    ]), f(['Name', 'الاسم']), f(['Content', 'المحتوى']), f(['TTL', 'TTL'], undefined, 'number'), f(['Priority', 'الأولوية'], undefined, 'number'), f(['Weight', 'الوزن'], undefined, 'number'), f(['Port', 'المنفذ'], undefined, 'number'), f(['Target', 'الهدف']), f(['Flags', 'العلامات'], undefined, 'number'), f(['Tag', 'الوسم'])
                ], [
                    ['Add record', 'إضافة سجل']
                ]), binding: 'dns'
            }
        ], [
            s('zone-facts', ['Zone facts', 'معلومات المنطقة'], [
                f(['Zone', 'المنطقة'], domain?.name), f(['Records read', 'السجلات المقروءة'], p.dnsRecords?.length)
            ]), d('dns-change', ['How a change is applied', 'كيف يُطبّق التغيير'], ['Saving a record is separate from public DNS propagation and mail-delivery checks.', 'حفظ السجل منفصل عن انتشار DNS العام وفحوص تسليم البريد.'])
        ]);
        case '/metrics/traffic': {
            const x = p.websiteAnalytics;
            return page(['Metrics', 'المقاييس'], ['Traffic, response status and bandwidth from log observations.', 'الزيارات وحالات الاستجابة وحركة البيانات من قراءة السجلات.'], [
                s('metrics-scope', ['Traffic selection', 'اختيار حركة البيانات'], [
                    f(['Domain', 'النطاق'], undefined, undefined, (domains ?? []).map(row => [
                        row.name, row.name
                    ])), f(['Range', 'الفترة'], undefined, undefined, [
                        ['Last 7 days', 'آخر 7 أيام'], ['Last 30 days', 'آخر 30 يومًا']
                    ])
                ]),
                {
                    ...s('visitors', ['Unique visitors per day', 'الزوار الفريدون يوميًا'], [
                        f(['Unique visitors', 'الزوار الفريدون'], x?.totals.uniqueVisitors), f(['Requests', 'الطلبات'], x?.totals.requests)
                    ]), chart: true, message: ['Daily visitor readings have not been read. Request totals do not establish a daily visitor series.', 'لم تُقرأ قراءات الزوار اليومية. إجمالي الطلبات لا يثبت سلسلة يومية للزوار.']
                },
                t('top-pages', ['Top pages', 'الصفحات الأكثر زيارة'], [
                    ['Path', 'المسار'], ['Requests', 'الطلبات'], ['Transferred', 'البيانات المنقولة']
                ], x?.topPaths.map(row => [
                    row.key, String(row.requests), formatBytes(row.bytes)
                ]), x !== undefined),
                s('response-status', ['Responses by status', 'الاستجابات حسب الحالة'], [
                    f(['2xx', '2xx'], x?.totals.status2xx), f(['3xx', '3xx'], x?.totals.status3xx), f(['4xx', '4xx'], x?.totals.status4xx), f(['5xx', '5xx'], x?.totals.status5xx)
                ]),
                t('error-paths', ['Errors by path', 'الأخطاء حسب المسار'], [
                    ['Path', 'المسار'], ['Errors', 'الأخطاء']
                ], x?.topPaths.filter(row => (row.errors5xx ?? 0) > 0).map(row => [
                    row.key, String(row.errors5xx)
                ]), x !== undefined)
            ], [
                s('bandwidth', ['Bandwidth by domain', 'حركة البيانات حسب النطاق'], [
                    f(['Domain', 'النطاق'], x?.domain), f(['Transferred', 'البيانات المنقولة'], x ? formatBytes(x.totals.bytes) : undefined)
                ]), s('raw-logs', ['Raw access logs', 'سجلات الوصول الخام'], [], [
                    ['Download logs', 'تنزيل السجلات']
                ])
            ]);
        }
        case '/security/ssl': return page(['SSL/TLS', 'SSL/TLS'], ['Choose the certificate, names and validation, then review installation.', 'اختيار الشهادة والأسماء والتحقق ثم مراجعة التثبيت.'], [
            {
                ...s('certificate-wizard', ['Certificate wizard', 'معالج الشهادة'], [
                    f(['Existing certificate', 'الشهادة الموجودة'], undefined, undefined, []), f(['Certificate source', 'مصدر الشهادة'], undefined, undefined, [
                        ['Issue with ACME', 'الإصدار باستخدام ACME'], ['Use an existing certificate', 'استخدام شهادة موجودة'], ['Upload a private key and certificate', 'رفع مفتاح خاص وشهادة']
                    ]), f(['Domain', 'النطاق'], domain?.name), f(['Private key', 'المفتاح الخاص'], undefined, 'textarea'), f(['Certificate', 'الشهادة'], undefined, 'textarea'), f(['CA bundle (optional)', 'سلسلة الجهة المصدرة (اختيارية)'], undefined, 'textarea'), f(['Validation', 'التحقق'], undefined, undefined, [
                        ['HTTP-01', 'HTTP-01'], ['DNS-01', 'DNS-01']
                    ], {
                        technicalChoices: true
                    })
                ], [
                    ['Cancel', 'إلغاء'], ['Back', 'رجوع'], ['Review choices', 'مراجعة الخيارات'], ['Install or issue certificate', 'تثبيت الشهادة أو إصدارها']
                ]), steps: [
                    ['Source', 'المصدر'], ['Names', 'الأسماء'], ['Validation', 'التحقق'], ['Install', 'التثبيت'], ['Result', 'النتيجة']
                ]
            }
        ], [
            s('certificate-choices', ['Your choices', 'خياراتك'], [
                f(['Domain', 'النطاق'], domain?.name), f(['Installed certificate', 'الشهادة المثبتة'], domain ? domain.certificateId ? p.locale === 'ar' ? 'محفوظة' : 'Stored' : p.locale === 'ar' ? 'غير مضبوطة' : 'Not configured' : undefined)
            ]), d('wildcards', ['About wildcard certificates', 'عن شهادات البدل الشامل'], ['A wildcard covers one label level and requires DNS validation.', 'تغطي شهادة البدل الشامل مستوى اسم واحدًا وتتطلب تحقق DNS.'])
        ]);
        case '/security/account': return page(['Account security', 'أمان الحساب'], ['Sign-in, API credentials, SSH access and site protection.', 'تسجيل الدخول وبيانات API والوصول عبر SSH وحماية الموقع.'], [
            d('sign-in', ['Sign-in', 'تسجيل الدخول'], ['Password and optional two-factor controls are provided by the account authentication panel.', 'توفر لوحة مصادقة الحساب عناصر كلمة المرور والمصادقة الثنائية الاختيارية.']),
            s('account-password', ['Password', 'كلمة المرور'], [
                f(['Current password', 'كلمة المرور الحالية'], undefined, 'password'), f(['New password', 'كلمة المرور الجديدة'], undefined, 'password'), f(['Repeat new password', 'تكرار كلمة المرور الجديدة'], undefined, 'password'), f(['Show passwords', 'إظهار كلمات المرور'], undefined, 'checkbox')
            ], [
                ['Change password', 'تغيير كلمة المرور']
            ]),
            s('ip-blocker', ['IP blocker', 'حظر عناوين الشبكة'], [
                f(['Address or range', 'العنوان أو النطاق'])
            ], [
                ['Block address', 'حظر العنوان']
            ]),
            s('hotlink-protection', ['Hotlink protection', 'حماية الربط المباشر'], [
                f(['Enable hotlink protection', 'تفعيل حماية الربط المباشر'], undefined, 'checkbox'), f(['Sites allowed to embed', 'المواقع المسموح لها بالتضمين']), f(['File types', 'أنواع الملفات']), f(['Allow requests with no referrer', 'السماح بطلبات بلا محيل'], undefined, 'checkbox')
            ], [
                ['Save hotlink rules', 'حفظ قواعد الربط']
            ]),
            s('api-tokens', ['API tokens', 'رموز API'], [
                f(['Name', 'الاسم']), f(['Expires after', 'تنتهي بعد'], undefined, undefined, [
                    ['1 day', 'يوم واحد'], ['30 days', '30 يومًا'], ['90 days', '90 يومًا']
                ]), f(['Allowed addresses (optional)', 'العناوين المسموحة (اختياري)'])
            ], [
                ['Create token', 'إنشاء رمز']
            ]),
            s('account-directory-privacy', ['Directory privacy', 'خصوصية المجلدات'], [
                f(['Folder', 'المجلد']), f(['Prompt shown', 'رسالة الدخول']), f(['First user', 'المستخدم الأول']), f(['Password for this user', 'كلمة مرور هذا المستخدم'], undefined, 'password')
            ], [
                ['Protect folder', 'حماية المجلد']
            ]),
            s('ssh-access', ['SSH access', 'الوصول عبر SSH'], [
                f(['Name', 'الاسم']), f(['Public key', 'المفتاح العام'], undefined, 'textarea')
            ], [
                ['Add key', 'إضافة مفتاح']
            ])
        ], [
            s('site-protection', ['Site protection', 'حماية الموقع'], [
                f(['Address or range', 'العنوان أو النطاق']), f(['Sites allowed to embed', 'المواقع المسموح لها بالتضمين']), f(['File types', 'أنواع الملفات'])
            ], [
                ['Block address', 'حظر العنوان'], ['Save hotlink rules', 'حفظ قواعد الربط']
            ])
        ]);
        case '/software/php': return page(['PHP', 'PHP'], ['Select the domain runtime, worker pool and per-site INI values.', 'اختيار بيئة تشغيل النطاق ومجموعة العمليات وقيم INI الخاصة بالموقع.'], [
            {
                ...s('php-domain', ['Domain and version', 'النطاق والإصدار'], [
                    f(['Domain', 'النطاق'], domain?.name), f(['PHP version', 'إصدار PHP'], php?.version), f(['Handler', 'المعالج'], php?.handler, undefined, [
                        ['fpm', 'PHP-FPM'], ['cgi', 'CGI'], ['suphp', 'suPHP'], ['lsphp', 'lsphp']
                    ])
                ]), binding: 'php'
            },
            s('php-pool', ['PHP-FPM pool', 'مجموعة PHP-FPM'], [
                f(['Process manager', 'مدير العمليات'], php?.fpm.mode, undefined, [
                    ['ondemand', 'ondemand'], ['dynamic', 'dynamic'], ['static', 'static']
                ]), f(['pm.max_children', 'pm.max_children'], php?.fpm.maxChildren, 'number'), f(['pm.start_servers', 'pm.start_servers'], php?.fpm.startServers, 'number'), f(['pm.min_spare_servers', 'pm.min_spare_servers'], php?.fpm.minSpareServers, 'number'), f(['pm.max_spare_servers', 'pm.max_spare_servers'], php?.fpm.maxSpareServers, 'number'), f(['pm.max_requests', 'pm.max_requests'], php?.fpm.maxRequests, 'number'), f(['Idle timeout (seconds)', 'مهلة الخمول (ثوانٍ)'], php?.fpm.processIdleTimeoutSec, 'number')
            ]),
            s('php-extra-ini', ['Additional INI values', 'قيم INI الإضافية'], [
                f(['max_input_vars', 'max_input_vars'], php?.ini.max_input_vars), f(['date.timezone', 'date.timezone'], php?.ini['date.timezone']), f(['display_errors', 'display_errors'], php?.ini.display_errors, undefined, [
                    ['Off', 'إيقاف'], ['On', 'تشغيل']
                ])
            ]),
            s('php-save-target', ['Save to', 'موضع الحفظ'], [
                f(['Configuration target', 'موضع الإعداد'], undefined, 'radio', [
                    ['.user.ini', '.user.ini'], ['PHP-FPM pool', 'مجموعة PHP-FPM']
                ])
            ]),
            {
                ...s('php-config-preview', ['Configuration preview', 'معاينة الإعداد'], [
                    f(['Candidate configuration', 'الإعداد المرشح'], undefined, 'textarea')
                ]), message: ['The effective configuration and candidate preview have not been read. No configuration file is generated or saved by this preview.', 'لم يُقرأ الإعداد الفعلي أو معاينة الإعداد المرشح. لا تُنشأ أو تُحفظ ملفات إعداد من هذه المعاينة.']
            },
            s('php-ini', ['INI values', 'قيم INI'], [
                f(['memory_limit', 'memory_limit'], php?.ini.memory_limit), f(['upload_max_filesize', 'upload_max_filesize'], php?.ini.upload_max_filesize), f(['post_max_size', 'post_max_size'], php?.ini.post_max_size), f(['max_execution_time', 'max_execution_time'], php?.ini.max_execution_time)
            ], [
                ['Reset', 'إعادة الضبط'], ['Save PHP settings', 'حفظ إعدادات PHP']
            ])
        ], [
            s('php-running', ['Running now', 'تعمل الآن'], [
                f(['Domain', 'النطاق'], domain?.name), f(['Version', 'الإصدار'], php?.version), f(['Handler', 'المعالج'], php?.handler)
            ]), d('php-disabled-functions', ['Disabled functions', 'الدوال المعطلة'], ['The effective disabled-function list has not been read.', 'لم تُقرأ قائمة الدوال المعطلة الفعلية.'])
        ]);
        case '/software/htaccess': return page(['.htaccess editor', 'محرر .htaccess'], ['Edit site rules and validate before replacing the saved file.', 'تعديل قواعد الموقع والتحقق قبل استبدال الملف المحفوظ.'], [
            s('htaccess-editor', ['Site rules', 'قواعد الموقع'], [
                f(['File', 'الملف'], domain ? `${domain.docRoot}/.htaccess` : undefined), f(['Insert', 'إدراج'], undefined, undefined, [
                    ['Redirect', 'تحويل'], ['Rewrite rule', 'قاعدة إعادة كتابة'], ['Access restriction', 'تقييد الوصول']
                ]), f(['File contents', 'محتوى الملف'], undefined, 'textarea')
            ], [
                ['Insert at cursor', 'إدراج عند المؤشر'], ['Discard draft', 'تجاهل المسودة'], ['Save and check site', 'الحفظ وفحص الموقع']
            ]),
            {
                ...t('htaccess-php-compatibility', ['PHP directive compatibility', 'توافق تعليمات PHP'], [
                    ['Directive', 'التعليمة'], ['Value', 'القيمة'], ['Compatibility', 'التوافق']
                ]), actions: [
                    ['Move PHP settings to .user.ini', 'نقل إعدادات PHP إلى .user.ini'], ['Undo move', 'التراجع عن النقل']
                ]
            },
            d('htaccess-php', ['PHP settings in .htaccess', 'إعدادات PHP في .htaccess'], ['Read existing directives before moving PHP values to .user.ini.', 'اقرأ التعليمات الموجودة قبل نقل قيم PHP إلى .user.ini.'])
        ], [
            {
                ...t('htaccess-versions', ['Versions', 'الإصدارات'], [
                    ['Version', 'الإصدار'], ['Saved (UTC)', 'الحفظ (UTC)'], ['Author', 'الكاتب'], ['Result', 'النتيجة']
                ]), actions: [
                    ['Restore selected version', 'استعادة الإصدار المحدد']
                ]
            }, d('htaccess-save', ['What a save does', 'ماذا يفعل الحفظ'], ['Validation and site checks must pass; a failure preserves the previous working file.', 'يجب نجاح التحقق وفحص الموقع؛ يحافظ الفشل على الملف العامل السابق.'])
        ]);
        case '/advanced/cron': return page(['Cron jobs', 'مهام Cron'], ['Scheduled commands, run results and output delivery.', 'الأوامر المجدولة ونتائج التشغيل وتسليم المخرجات.'], [
            t('scheduled-jobs', ['Scheduled jobs', 'المهام المجدولة'], [
                ['Job', 'المهمة'], ['Schedule', 'الجدولة'], ['Command', 'الأمر'], ['Last run', 'آخر تشغيل'], ['Duration', 'المدة'], ['Next run', 'التشغيل التالي'], ['Actions', 'الإجراءات']
            ]),
            s('cron-selected-job', ['Selected job', 'المهمة المحددة'], [
                f(['Delete confirmation', 'تأكيد الحذف'])
            ], [
                ['View unit', 'عرض الوحدة'], ['Run selected job now', 'تشغيل المهمة المحددة الآن'], ['Keep', 'إبقاء'], ['Delete job', 'حذف المهمة']
            ]),
            {
                ...s('cron-unit-preview', ['Unit preview', 'معاينة الوحدة'], [
                    f(['Unit contents', 'محتوى الوحدة'], undefined, 'textarea')
                ]), message: ['No job or unit has been selected or read.', 'لم تُحدد أو تُقرأ مهمة أو وحدة.']
            },
            t('cron-next-runs', ['Next runs (UTC)', 'التشغيلات التالية (UTC)'], [
                ['Run', 'التشغيل'], ['Scheduled time', 'الوقت المجدول']
            ]),
            s('add-cron', ['Add a cron job', 'إضافة مهمة Cron'], [
                f(['Common schedules', 'جداول شائعة'], undefined, undefined, [
                    ['Every 5 minutes', 'كل 5 دقائق'], ['Every hour', 'كل ساعة'], ['Twice a day', 'مرتين يوميًا'], ['Every day', 'كل يوم'], ['Every Sunday', 'كل أحد'], ['On the 1st of the month', 'في اليوم الأول من الشهر'], ['Custom schedule', 'جدول مخصص']
                ]), f(['Minute', 'الدقيقة']), f(['Hour', 'الساعة']), f(['Day', 'اليوم']), f(['Month', 'الشهر']), f(['Weekday', 'يوم الأسبوع']), f(['Command to run', 'الأمر المطلوب تشغيله']), f(['Stop after (seconds)', 'الإيقاف بعد (ثوانٍ)'], undefined, 'number'), f(['Unlimited timeout', 'مهلة غير محدودة'], undefined, 'checkbox'), f(['Send output', 'إرسال المخرجات'], undefined, undefined, [
                    ['Only when it fails', 'عند الفشل فقط'], ['After every run', 'بعد كل تشغيل'], ['Never', 'أبدًا']
                ])
            ], [
                ['Reset', 'إعادة الضبط'], ['Add cron job', 'إضافة مهمة Cron']
            ])
        ], [
            d('cron-runtime', ['How a job runs', 'كيف تعمل المهمة'], ['Commands run with the account identity and limits. A schedule does not establish successful execution.', 'تعمل الأوامر بهوية الحساب وحدوده. وجود جدول لا يثبت نجاح التنفيذ.']), s('cron-output', ['Output email', 'بريد المخرجات'], [
                f(['Send job output to', 'إرسال مخرجات المهمة إلى'], a?.contactEmail, 'email')
            ], [
                ['Save address', 'حفظ العنوان']
            ])
        ]);
        default: throw new Error('Unsupported account workspace');
    }
};
