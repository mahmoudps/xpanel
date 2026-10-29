import type { ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts';
import { formatBytes } from '../tokens.ts';
import { translator } from '../i18n.ts'
type Copy = string;
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
    } : choices && radioFields.has(label) ? {
        type: 'radio'
    } : {}),
    ...(choices ? {
        choices
    } : {}),
});
const collectionColumns: Record<string, Copy[]> = {
    forwarders: [
        msgid('Address'), msgid('Destination')
    ],
    autoresponders: [
        msgid('Address'), msgid('Subject'), msgctxt('approved-xpanel-pages', 'Schedule')
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
const notRead: Copy = msgctxt('approved-xpanel-pages', 'Not read');
const additionalSections = (route: string): PanelWorkspaceSection[] => route === '/email/accounts' ? [
    s('service-access', msgid('Create a service user'), [
        f(msgid('Username')), f(msgid('Password'), undefined, 'password'), f(msgid('Mailbox quota (MB)'), undefined, 'number'), f(msgid('Email access'), undefined, 'checkbox'), f(msgid('FTP access'), undefined, 'checkbox'), f(msgid('Web Disk access'), undefined, 'checkbox'), f(msgid('Unlimited mailbox quota'), undefined, 'checkbox'), f(msgid('FTP and Web Disk directory')), f(msgid('Web Disk access mode'), undefined, undefined, [
            msgid('Read and write'), msgid('Read only')
        ])
    ], [
        msgid('Generate password'), msgid('Cancel'), msgid('Create user')
    ]),
    s('forwarder-management', msgid('Manage forwarder'), [
        f(msgid('Address'))
    ], [
        msgid('Delete forwarder')
    ]),
    s('autoresponder-management', msgid('Manage autoresponder'), [
        f(msgid('Address'))
    ], [
        msgid('Edit autoresponder'), msgid('Delete autoresponder')
    ]),
] : route === '/security/account' ? [
    {
        ...s('token-one-time', msgid('Save your token'), [
            f(msgid('New token (shown once)'), undefined, 'password')
        ], [
            msgid('Copy token'), msgid('Done')
        ]),
        message: msgid('No token was issued by this workspace. A newly issued secret must be shown only once and must not be reconstructed from the token list.')
    },
    t('token-list', msgid('API token list'), [
        msgid('Name'), msgid('Scopes'), msgid('Allowed from'), msgctxt('approved-xpanel-pages', 'Created'), msgctxt('approved-xpanel-pages', 'Expires'), msgid('Last used'), msgid('Action')
    ]),
    s('token-revocation', msgid('Revoke a token'), [
        f(msgid('Token name'))
    ], [
        msgid('Keep'), msgid('Revoke')
    ]),
    s('token-scopes', msgid('Token scopes'), [
        f('files:read', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('files:write', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('databases:read', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('dns:write', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('email:write', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('backups:create', undefined, 'checkbox', undefined, {
            technicalLabel: true
        }), f('cron:write', undefined, 'checkbox', undefined, {
            technicalLabel: true
        })
    ]),
    t('ssh-key-list', msgid('SSH keys'), [
        msgid('Name'), msgid('Fingerprint'), msgctxt('approved-xpanel-pages', 'Added'), msgid('Action')
    ]),
    s('ssh-key-removal', msgid('Remove an SSH key'), [
        f(msgid('Key name'))
    ], [
        msgid('Keep'), msgid('Remove key')
    ]),
    s('shell-access', msgid('Shell access'), [
        f(msgid('Access mode'))
    ]),
    t('blocked-addresses', msgid('Blocked addresses'), [
        msgid('Address or range'), msgid('Covers')
    ]),
    s('unblock-address', msgid('Unblock an address'), [
        f(msgid('Address or range'))
    ], [
        msgid('Unblock')
    ]),
    s('hotlink-referrer', msgid('Hotlink request policy'), [
        f(msgid('Allow requests with no referrer'), undefined, 'checkbox')
    ]),
    t('protected-directory-list', msgid('Protected folders'), [
        msgid('Folder'), msgid('Prompt'), msgid('Users')
    ]),
    s('remove-directory-protection', msgid('Remove protection'), [
        f(msgid('Folder'))
    ], [
        msgid('Keep'), msgid('Remove')
    ]),
] : [];
const unreadNativeSections = (p: ApprovedXpanelWorkspaceProps): PanelWorkspaceSection[] => {
    if (p.nativeHtml) {
        if (p.route === '/domains')
            return [
                {
                    ...s('domain-create-details', msgid('Additional domain creation choices'), [
                        f(msgid('Alias name')), f(msgctxt('approved-xpanel-pages', 'Subdomain')),
                        f(msgid('Under'), undefined, undefined, (p.account ? p.domains?.filter(row => row.accountId === p.account!.id) : undefined)?.map(row => row.name) ?? []),
                        f(msgid('Document root')), f(msgid('PHP version')),
                        f(msgid('Site type'), undefined, 'radio', [
                            'PHP', msgid('Static'), msgid('Proxy')
                        ]),
                        f(msgid('Create DNS records'), undefined, 'checkbox'), f(msgid('Issue a TLS certificate'), undefined, 'checkbox')
                    ]), message: msgid('The existing name and type form remains available. These additional choices are not connected to that form and stay disabled; they are not submitted.')
                }
            ];
        if (p.route === '/databases/mariadb') {
            const unread = translator(p.locale)(notRead);
            const databases = p.account ? p.databases?.filter(row => row.accountId === p.account!.id && !row.trashedAt) : undefined;
            return [
                {
                    ...t('database-list-details', msgid('Database details'), [
                        msgid('Database'), msgid('Size'), msgid('Tables'), msgid('Users with access'), msgid('Collation'), msgid('Last write')
                    ], databases?.map(row => [
                        row.name, unread, unread, unread, unread, unread
                    ]), databases !== undefined),
                    message: msgid('The existing database actions remain available. Table counts, collation and last-write readings have not been loaded; no values are inferred.')
                }
            ];
        }
        return [];
    }
    switch (p.route) {
        case '/email/accounts': return [
            t('mailbox-users-unread', msgid('Service users'), [
                msgid('Login'), msgid('Services'), msgid('Mailbox quota (MB)'), msgid('File directory'), msgid('Last sign-in')
            ]),
            s('mailbox-create-unread', msgid('Create mailbox'), [
                f(msgid('Local name')), f(msgid('Domain'), undefined, undefined, []), f(msgid('Password'), undefined, 'password'), f(msgid('Requested quota (MB)'), undefined, 'number')
            ], [
                msgid('Generate password'), msgid('Create mailbox')
            ]),
            s('mailbox-password-unread', msgid('New mailbox password'), [
                f(msgid('Password'), undefined, 'password')
            ], [
                msgid('Cancel'), msgid('Save')
            ]),
            s('mailbox-quota-unread', msgid('Mailbox quota'), [
                f(msgid('Quota (MB)'), undefined, 'number')
            ], [
                msgid('Cancel'), msgid('Save')
            ]),
            s('mailbox-delete-unread', msgid('Delete mailbox'), [
                f(msgid('Confirmation'))
            ], [
                msgid('Cancel'), msgid('Delete mailbox')
            ])
        ];
        case '/files/manager':
        case '/files/trash': return [
            s('file-browser-unread', msgid('Browse files'), [
                f(msgid('Path')), f(msgid('Show hidden files'), undefined, 'checkbox')
            ], [
                msgid('Files'), msgid('Trash'), msgid('Parent folder'), msgid('Copy path'), msgid('Refresh'), msgid('Upload'), msgid('New file'), msgid('New folder'), msgctxt('approved-xpanel-pages', 'Clear selection')
            ]),
            t('file-list-unread', msgid('Files'), [
                msgid('Name'), msgid('Type'), msgid('Size'), msgid('Permissions'), msgid('Modified (UTC)'), msgid('Owner'), msgid('Actions')
            ]),
            s('file-editor-unread', msgctxt('approved-xpanel-pages', 'File editor'), [
                f(msgid('File')), f(msgid('File contents'), undefined, 'textarea')
            ], [
                msgid('Close'), msgid('Discard draft'), msgid('Save')
            ]),
            s('file-upload-unread', msgid('Upload files'), [
                f(msgid('Files to upload'), undefined, 'file')
            ], [
                msgid('Cancel'), msgid('Upload')
            ]),
            s('file-folder-unread', msgid('New folder'), [
                f(msgid('Folder name'))
            ], [
                msgid('Cancel'), msgid('Create folder')
            ]),
            s('file-rename-unread', msgid('Rename file'), [
                f(msgid('New name'))
            ], [
                msgid('Cancel'), msgid('Rename')
            ]),
            s('file-permissions-unread', msgid('File permissions'), [
                f(msgid('Octal mode'))
            ], [
                msgid('Cancel'), msgid('Save permissions')
            ]),
            {
                ...t('file-trash-unread', msgid('Trash'), [
                    msgid('Name'), msgid('Was in'), msgid('Deleted (UTC)'), msgid('Removed for good on'), msgid('Actions')
                ]), actions: [
                    msgctxt('approved-xpanel-pages', 'Empty trash')
                ]
            },
            s('file-delete-unread', msgid('File removal and recovery'), [
                f(msgid('Confirmation'))
            ], [
                msgid('Cancel'), msgid('Move to trash'), msgid('Restore selected'), msgid('Delete for good')
            ])
        ];
        case '/domains': return [
            t('domain-list-unread', msgid('Your domains'), [
                msgid('Domain'), msgid('Type'), msgid('Document root'), 'IPv4', 'IPv6', msgid('Runtime'), msgid('Status'), msgid('Actions')
            ]),
            s('domain-create-unread', msgid('Create domain'), [
                f(msgid('Domain name')), f(msgid('Type'), undefined, 'radio', [
                    msgid('Addon domain'), msgid('Subdomain'), msgid('Alias')
                ]), f(msgid('Alias name')), f(msgctxt('approved-xpanel-pages', 'Subdomain')), f(msgid('Under'), undefined, undefined, []), f(msgid('Parent domain'), undefined, undefined, []), f(msgid('Document root')), f(msgid('Site type'), undefined, undefined, [
                    'PHP', msgid('Static'), msgid('Proxy')
                ]), f('IPv4'), f('IPv6'), f(msgid('PHP version')), f(msgid('Create DNS records'), undefined, 'checkbox'), f(msgid('Issue a TLS certificate'), undefined, 'checkbox')
            ], [
                msgid('Cancel'), msgid('Create domain')
            ])
        ];
        case '/databases/mariadb': return [
            t('database-list-unread', msgid('Your databases'), [
                msgid('Database'), msgid('Size'), msgid('Tables'), msgid('Users with access'), msgid('Collation'), msgid('Last write'), msgid('Actions')
            ]),
            s('database-create-unread', msgid('Create database'), [
                f(msgid('Database name'))
            ], [
                msgid('Create database')
            ]),
            t('database-user-list-unread', msgid('Database users'), [
                msgid('User'), msgid('Database grants'), msgid('Last connection'), msgid('Actions')
            ]),
            s('database-user-create-unread', msgid('Create database user'), [
                f(msgid('Username')), f(msgid('Password'), undefined, 'password'), f(msgid('Database'), undefined, undefined, [])
            ], [
                msgid('Create user')
            ])
        ];
        case '/domains/zone-editor': return [
            t('dns-records-unread', msgid('Zone records'), [
                msgid('Name'), msgid('Type'), 'TTL', msgid('Content'), msgid('Priority'), msgid('Actions')
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
    const account = s('account-context', msgid('Account and plan'), [
        f(msgid('Account'), a?.username), f(msgid('Domain'), a?.primaryDomain), f(msgid('Plan'), plan?.name)
    ]);
    const certificateSections: PanelWorkspaceSection[] = p.route === '/security/ssl' ? [
        s('certificate-names', msgid('Certificate names'), [
            f(msgid('Name coverage'), undefined, 'radio', [
                msgid('A single name'), msgid('Wildcard and base domain'), msgid('Custom names')
            ]), f(msgid('Name')), f(msgid('Additional names (SAN)'), undefined, 'textarea')
        ]),
        {
            ...s('certificate-targets', msgid('Installation targets'), domains?.length ? domains.map(row => f(row.name, undefined, 'checkbox', undefined, {
                technicalLabel: true
            })) : [
                f(msgid('Installation targets not read'), undefined, undefined, [])
            ]), message: msgid('Coverage has not been read from the certificate. No target is assumed to be covered.')
        },
        {
            ...t('installed-certificates', msgid('Installed certificates'), [
                msgid('Names'), msgctxt('approved-xpanel-pages', 'Issuer'), msgid('Key'), msgctxt('approved-xpanel-pages', 'Expires'), msgid('Renewal'), msgid('Installed on')
            ]), actions: [
                msgid('View'), msgid('Renew now'), msgid('Remove')
            ]
        },
        d('certificate-outcome', msgid('What happened'), msgid('No certificate installation result has been read. The issue or renewal response must confirm the affected names, installation and errors before success is shown.')),
    ] : [];
    const page = (title: Copy, description: Copy, sections: PanelWorkspaceSection[], aside: PanelWorkspaceSection[] = []): PanelWorkspacePage => ({
        title, description, sections: [
            ...unreadNativeSections(p), ...sections, ...additionalSections(p.route), ...certificateSections
        ], aside: [
            account, ...aside
        ]
    });
    switch (p.route) {
        case '/resources': return page(msgid('Resources & quotas'), msgid('Your account limits, live readings and the services in its slice.'), [
            s('slice-readings', msgctxt('approved-xpanel-pages', 'Limits on your slice'), [
                f(msgctxt('approved-xpanel-pages', 'Slice'), a ? `xpanel-${a.uid}.slice` : undefined), f(msgid('Disk'), p.usage?.diskBytes == null ? undefined : formatBytes(p.usage.diskBytes)), f(msgid('Memory'), p.usage?.memoryBytes == null ? undefined : formatBytes(p.usage.memoryBytes)), f(msgid('Processes'), p.usage?.processCount)
            ], [
                msgid('Refresh live values')
            ]),
            {
                ...d('disk-io', msgctxt('approved-xpanel-pages', 'Disk IO, last hour'), msgid('Account IO history has not been read. No chart is inferred from plan limits.')), chart: true
            },
            t('resource-limits', msgid('Plan and applied limits'), [
                msgid('Limit'), msgid('Plan value'), msgctxt('approved-xpanel-pages', 'Applied on host'), msgid('State'), msgid('Live usage')
            ], ([
                msgid('CPU weight'), msgid('CPU quota'), msgid('Memory'), msgid('Processes'), msgid('IO weight'), msgid('IO read'), msgid('IO write'), msgctxt('approved-xpanel-pages', 'Bandwidth')
            ] as const).map(label => [
                translator(p.locale)(label), ...Array<string>(4).fill(translator(p.locale)(notRead))
            ])),
            s('resource-live', msgid('CPU, bandwidth and IO'), [
                f(msgid('CPU')), f(msgctxt('approved-xpanel-pages', 'Bandwidth')), f(msgid('IO read')), f(msgid('IO write'))
            ]),
            t('slice-processes', msgctxt('approved-xpanel-pages', 'Processes in your slice'), [
                msgid('PID'), msgid('Command and unit'), msgid('User'), msgid('CPU'), msgid('Memory'), msgid('Started (UTC)')
            ]), s('resource-actions', msgid('Resource readings'), [], [
                msgid('Try again'), msgid('View unit')
            ])
        ], [
            s('serving-site', msgid('Who serves this site'), [
                f(msgid('Domain'), domain?.name), f(msgid('Document root'), domain?.docRoot), f(msgid('PHP version'), php?.version), f(msgid('Handler'), php?.handler)
            ])
        ]);
        case '/email/accounts': return page(msgid('Email and service users'), msgid('Mailboxes, service access, forwarding and automatic replies.'), [
            s('forwarders', msgid('Forwarders'), [
                f(msgid('Address')), f(msgid('Forward to')), f(msgctxt('approved-xpanel-pages', 'Delivery'), undefined, undefined, [
                    msgid('Forward to an address'), msgid('Reject with an error')
                ])
            ], [
                msgid('Add forwarder')
            ]),
            s('autoresponders', msgid('Autoresponders'), [
                f(msgid('Address')), f(msgid('Subject')), f(msgid('Message'), undefined, 'textarea'), f(msgid('Starts (UTC)'), undefined, 'datetime-local'), f(msgid('Ends (UTC)'), undefined, 'datetime-local'), f(msgid('No end date'), undefined, 'checkbox')
            ], [
                msgid('Add autoresponder')
            ]),
            s('default-address', msgid('Default address'), [
                f(msgid('Domain'), undefined, undefined, (domains ?? []).map(x => x.name)), f(msgid('Unknown recipient'), undefined, undefined, [
                    msgid('Reject with an error'), msgid('Forward to an address'), msgid('Discard silently')
                ])
            ], [
                msgid('Save default address')
            ])
        ], [
            d('service-user-contract', msgid('How service users work'), msgid('Email, FTP and Web Disk credentials are separate from account control-panel access.')), s('mail-connections', msgid('Connection settings'), [
                f(msgid('Mailbox host')), f('IMAP / SMTP'), f('TLS')
            ])
        ]);
        case '/files/manager':
        case '/files/trash': return page(msgid('File manager'), msgid('Browse, edit and recover files in your account.'), [
            s('selection-actions', msgid('Selection actions'), [], [
                msgid('Copy'), msgid('Move'), msgid('Compress'), msgid('Extract')
            ])
        ], [
            s('file-boundary', msgid('Your file workspace'), [
                f(msgctxt('approved-xpanel-pages', 'Home'), a?.home)
            ]), d('file-permissions', msgid('Permissions'), msgid('File operations stay inside the account home and retain its permission boundaries.'))
        ]);
        case '/files/directory-privacy': return page(msgctxt('approved-xpanel-pages', 'Directory privacy'), msgid('Protect folders with separate credentials.'), [
            t('protected-folders', msgid('Protected folders'), [
                msgid('Folder'), msgid('Prompt'), msgid('Users')
            ]),
            s('protect-folder', msgctxt('approved-xpanel-pages', 'Protect a folder'), [
                f(msgid('Folder'), domain?.docRoot), f(msgid('Prompt shown')), f(msgid('First user')), f(msgid('Password for this user'), undefined, 'password')
            ], [
                msgid('Protect folder')
            ])
        ]);
        case '/domains/site-settings': return page(msgid('Site settings'), msgid('Site names, runtime, redirects, proxy and lifecycle settings.'), [
            s('site-selector', msgid('Site'), [
                f(msgid('Site'), undefined, undefined, (domains ?? []).map(row => row.name))
            ]),
            s('site-binding', msgid('Names bound to this site'), [
                f(msgid('Primary name'), domain?.name), f(msgid('Bind another name'))
            ], [
                msgid('Bind name')
            ]),
            t('site-bound-names', msgid('Names bound to this site'), [
                msgid('Name'), msgid('Type'), msgid('Ports'), 'DNS', msgid('Document root'), msgid('Action')
            ], domains?.map(x => [
                x.name, x.kind, translator(p.locale)(notRead), translator(p.locale)(notRead), x.docRoot, translator(p.locale)(notRead)
            ]), domains !== undefined),
            s('site-name-actions', msgid('Manage bound names'), [], [
                msgid('Unbind'), msgid('Edit'), msgid('Delete')
            ]),
            t('site-header-rows', msgid('Custom headers'), [
                msgid('Name'), msgid('Value')
            ], p.customConfig ? Object.entries(p.customConfig.customHeaders).map(([name, value]) => [
                name, value
            ]) : undefined, p.customConfig !== undefined),
            s('site-template', msgid('Template and headers'), [
                f(msgid('Template'), undefined, undefined, [
                    msgid('Default'), 'WordPress', 'Laravel', msgid('Custom')
                ]), f(msgid('Header name')), f(msgid('Header value'))
            ], [
                msgid('Add header'), msgid('Remove header')
            ]),
            s('site-runtime', msgid('Runtime and document root'), [
                f(msgid('Document root'), domain?.docRoot), f(msgid('Run directory'), undefined, undefined, [
                    msgid('Document root'), msgid('Subfolder /public')
                ]), f(msgid('Site type'), domain?.siteType, undefined, [
                    msgid('php'), msgid('static'), msgid('proxy'), msgid('node'), msgid('python')
                ]), f(msgid('Node version')), f(msgid('App folder')), f(msgid('Start command')), f(msgid('Port'), undefined, 'number'), f(msgid('Python version')), f(msgid('Entry point')), f(msgid('Server')), f(msgid('Forward every request to'), domain?.upstream)
            ]),
            t('site-redirect-list', msgid('Saved redirects'), [
                msgid('From'), msgid('To'), msgid('Query string'), msgid('Status'), msgid('Actions')
            ]),
            s('site-redirects', msgctxt('approved-xpanel-pages', 'Redirects'), [
                f(msgid('From path')), f(msgid('To')), f(msgid('Redirect type'), undefined, undefined, [
                    msgid('301 Permanent'), msgid('302 Temporary')
                ]), f(msgid('Keep query string'), undefined, 'checkbox')
            ], [
                msgid('Add redirect')
            ]),
            s('site-proxy', msgctxt('approved-xpanel-pages', 'Proxy'), [
                f(msgid('Path on this site')), f(msgid('Upstream URL'), domain?.upstream), f(msgid('Host header sent')), f(msgid('Cache responses'), undefined, 'checkbox'), f(msgid('Keep for (seconds)'), undefined, 'number'), f(msgid('WebSocket upgrade'), undefined, 'checkbox')
            ]),
            s('site-logs', msgid('Runtime logs'), [
                f(msgid('Log kind'), undefined, undefined, [
                    msgid('Access'), msgctxt('approved-xpanel-pages', 'Error'), msgid('Application')
                ]), f(msgid('Lines'), undefined, 'number'), f(msgid('Log preview'), undefined, 'textarea')
            ], [
                msgid('Refresh'), msgid('Download')
            ]),
            s('site-lifecycle', msgid('Stop, expiry and path quota'), [
                f(msgid('Message on the stopped page'), undefined, 'textarea'), f(msgid('Stop the site on'), domain?.expiresAt, 'date'), f(msgid('Folder'), domain?.docRoot), f(msgid('Path quota (MB)'), domain?.pathQuotaMb), f(msgid('Unlimited path quota'), domain?.pathQuotaMb === 'unlimited', 'checkbox'), f(msgid('No expiry'), domain?.expiresAt === null, 'checkbox'), f(msgid('Expiry reminder address'), a?.contactEmail, 'email'), f(msgid('Reminder days before expiry'), undefined, 'number')
            ], [
                msgid('Reset'), msgid('Stop site'), msgid('Start site'), msgid('Save site settings')
            ])
        ], [
            s('site-summary', msgid('Site binding'), [
                f(msgid('Name'), domain?.name), f(msgid('Runtime'), domain?.siteType), f('PHP', php?.version)
            ])
        ]);
        case '/files/backup': return page(msgctxt('approved-xpanel-pages', 'Backup'), msgid('Choose contents, then review a restore before replacing data.'), [
            {
                ...s('backup-wizard', msgctxt('approved-xpanel-pages', 'Backup wizard'), [
                    f(msgid('Operation'), undefined, 'radio', [
                        msgid('Back up'), msgid('Restore')
                    ]), f(msgid('Backup type'), undefined, 'radio', [
                        msgid('Full account'), msgctxt('approved-xpanel-pages', 'Home directory'), msgid('Databases'), msgid('Mail config')
                    ])
                ]), steps: [
                    msgid('What to include'), msgid('Destination'), msgid('Review'), msgid('Result')
                ]
            },
            s('backup-include', msgid('What do you want to back up?'), [
                f(msgctxt('approved-xpanel-pages', 'Home directory files'), undefined, 'checkbox'),
                f(msgid('Folder')), f(msgid('Databases'), undefined, 'checkbox'),
                f(msgid('Mailboxes'), undefined, 'checkbox'), f(msgid('Mail config'), undefined, 'checkbox')
            ]),
            {
                ...t('backup-databases', msgid('Database selection'), [
                    msgid('Database'), msgid('Size')
                ], (a ? p.databases?.filter(row => row.accountId === a.id && !row.trashedAt) : undefined)?.map(row => [
                    row.name, translator(p.locale)(notRead)
                ]), a !== undefined && p.databases !== undefined),
                fields: (a ? p.databases?.filter(row => row.accountId === a.id && !row.trashedAt) : undefined)?.map(row => f(row.name, undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })) ?? [],
                message: msgid('A folder selection excludes mailboxes. Database selection and a consistent dump must be confirmed before a backup can run.')
            },
            s('backup-destination', msgid('Where should the archive go?'), [
                f(msgid('Destination'), undefined, 'radio', [
                    msgid('Download to this device'), msgid('Local storage'), msgctxt('approved-xpanel-pages', 'Remote storage')
                ]), f(msgid('Remote storage'), undefined, undefined, []),
                f(msgid('Email me when it is done'), undefined, 'checkbox'),
                f(msgid('Completion email'), a?.contactEmail, 'email'), f(msgid('Space check'))
            ], [
                msgid('Back'), msgid('Review backup')
            ]),
            s('backup-summary', msgid('Review backup'), [
                f(msgid('Contents')), f(msgid('Destination')), f(msgid('Estimated size')), f(msgid('Available space'))
            ], [
                msgctxt('approved-xpanel-pages', 'Create backup')
            ]),
            {
                ...t('backup-progress', msgid('Backup progress and result'), [
                    msgid('Time (UTC)'), msgid('Event'), msgid('Result')
                ]), actions: [
                    msgid('Cancel backup')
                ],
                message: msgid('No backup run or result has been read. No archive, progress percentage or completed job is assumed.')
            },
            s('backup-restore', msgid('Choose an archive'), [
                f(msgid('Archive'), undefined, undefined, []), f(msgid('Upload archive'), undefined, 'file'),
                f(msgid('Restore home directory files'), undefined, 'checkbox'),
                f(msgid('Restore databases'), undefined, 'checkbox'),
                f(msgid('Restore mailboxes'), undefined, 'checkbox'),
                f(msgid('Restore mail config'), undefined, 'checkbox')
            ], [
                msgid('Review the difference')
            ]),
            s('backup-diff-summary', msgid('Difference summary'), [
                f(msgid('Added')), f(msgid('Changed')), f(msgid('Unchanged')), f(msgid('Missing from archive')),
                f(msgid('Difference filter'), undefined, 'radio', [
                    msgid('All differences'), msgid('Added'), msgid('Changed'), msgid('Missing from archive'), msgid('Unchanged')
                ])
            ]),
            {
                ...t('backup-diff', msgid('Review the difference'), [
                    msgid('Path'), msgid('Result'), msgid('In archive'), msgid('On disk now'), msgid('Planned action')
                ]), actions: [
                    msgid('Download full list (CSV)')
                ],
                message: msgid('No archive has been selected or compared. Difference counts and planned changes have not been read.')
            },
            t('backup-db-diff', msgid('Database differences'), [
                msgid('Database'), msgid('Planned action')
            ]),
            t('backup-mail-diff', msgid('Mailbox differences'), [
                msgid('Mailbox'), msgid('Missing messages'), msgid('Planned action')
            ]),
            t('backup-mail-config-diff', msgid('Mail config differences'), [
                msgid('Setting'), msgid('In archive'), msgid('Current'), msgid('Planned action')
            ]),
            {
                ...s('backup-restore-review', msgctxt('approved-xpanel-pages', 'Before a restore'), [
                    f(msgid('Archive')), f(msgid('Selected parts')), f(msgid('Destination')),
                    f(msgid('Overwrite warning')), f(msgid('I reviewed the proposed restore changes'), undefined, 'checkbox')
                ], [
                    msgid('Back'), msgid('Restore selected parts')
                ]),
                message: msgid('Acknowledgement stays unavailable until the actual archive, selected parts and proposed changes have been read. An uploaded archive is not proof of a successful restore.')
            },
            {
                ...t('backup-history', msgid('Archives'), [
                    msgid('Archive'), msgctxt('approved-xpanel-pages', 'Created (UTC)'), msgid('Contents'), msgid('Size'), msgid('Location'), msgid('Status')
                ]), actions: [
                    msgid('Restore selected archive'), msgid('Download selected archive'), msgid('Delete selected archive')
                ]
            }
        ], [
            d('backup-safety', msgid('What a restore never does'), msgid('A restore must show the difference first, keep files missing from the archive, keep newer mail and unrelated mail settings, and restore databases separately from home files. These protections have not been verified by a run here.')),
            s('backup-location', msgctxt('approved-xpanel-pages', 'Where archives live'), [
                f(msgid('Account folder')), f(msgid('Remote storage')), f(msgctxt('approved-xpanel-pages', 'Server backups')), f(msgid('Retention policy'))
            ])
        ]);
        case '/databases/mariadb': return page(msgid('MariaDB databases'), msgid('Databases, users and grants within this account.'), [
            s('database-rename', msgid('Rename database'), [
                f(msgid('Database'), undefined, undefined, []), f(msgid('New database name'))
            ], [
                msgid('Cancel'), msgctxt('approved-xpanel-pages', 'Rename database')
            ]),
            s('database-drop-confirmation', msgid('Drop database permanently'), [
                f(msgid('Database name to confirm'))
            ], [
                msgid('Cancel'), msgid('Drop permanently')
            ]),
            s('database-generate-password', msgid('New database user password'), [
                f(msgid('Password'), undefined, 'password')
            ], [
                msgid('Generate password'), msgid('Clear')
            ]),
            s('database-advanced-privileges', msgid('Advanced privileges'), [
                f(msgid('All privileges'), undefined, 'checkbox')
            ], [
                msgid('Show advanced privileges'), msgid('Hide advanced privileges')
            ]),
            t('remote-database-hosts', msgid('Allowed database hosts'), [
                msgid('Host'), msgctxt('approved-xpanel-pages', 'Comment'), msgctxt('approved-xpanel-pages', 'Added'), msgid('Firewall')
            ]),
            s('remote-database-remove', msgid('Remove allowed host'), [
                f(msgid('Host'))
            ], [
                msgid('Remove')
            ]),
            s('database-create-options', msgid('Create database options'), [
                f(msgid('Collation'), undefined, undefined, [
                    msgid('Use server default'), 'utf8mb4_unicode_ci', 'utf8mb4_general_ci'
                ]), f(msgid('Create a user with this database'), undefined, 'checkbox')
            ]),
            s('database-grants-review', msgid('Desired privileges'), [
                f(msgid('Database'), undefined, undefined, (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : [])?.map(x => x.name) ?? []), f(msgid('User'), undefined, undefined, p.databaseUsers?.map(x => x.name) ?? []), f('SELECT', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('INSERT', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('UPDATE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('DELETE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('CREATE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('ALTER', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('DROP', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('INDEX', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('CREATE VIEW', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('SHOW VIEW', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('TRIGGER', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('EVENT', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('EXECUTE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })
            ], [
                msgid('Discard changes'), msgid('Save privileges')
            ]),
            s('database-change-password', msgid('Change user password'), [
                f(msgid('User'), undefined, undefined, p.databaseUsers?.map(x => x.name) ?? []), f(msgid('New password'), undefined, 'password'), f(msgid('Repeat password'), undefined, 'password')
            ], [
                msgid('Change password')
            ]),
            s('database-trash-policy', msgid('Database trash'), [], [
                msgid('Undo deletion'), msgid('Restore selected'), msgid('Delete for good')
            ]),
            t('database-usage', msgid('Database usage'), [
                msgid('Database'), msgid('Engine'), msgid('Size')
            ], (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : undefined)?.map(x => [
                x.name, x.engine, translator(p.locale)(notRead)
            ]), a !== undefined && p.databases !== undefined),
            s('database-privileges', msgid('User privileges'), [
                f(msgid('Database'), undefined, undefined, (a ? p.databases?.filter(x => x.accountId === a.id && !x.trashedAt) : [])?.map(x => x.name) ?? []), f('SELECT', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('INSERT', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('UPDATE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('DELETE', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                }), f('CREATE / ALTER / DROP', undefined, 'checkbox', undefined, {
                    technicalLabel: true
                })
            ], [
                msgid('Save privileges')
            ]),
            s('database-connection', msgid('Connection details'), [
                f(msgid('Host')), f(msgid('Port')), f(msgid('Database name')), f(msgid('Username'))
            ], [
                msgid('Copy connection details')
            ]),
            s('remote-database-access', msgid('Remote access'), [
                f(msgid('Allowed host or address')), f(msgctxt('approved-xpanel-pages', 'Comment (optional)'))
            ], [
                msgid('Add host')
            ])
        ], [
            d('database-grants', msgid('Names and grants'), msgid('Users receive access only to databases included in their saved grants.'))
        ]);
        case '/domains': return page(msgid('Domains'), msgid('Names, document roots, IP addresses and runtimes.'), [
            s('domain-rename-primary', msgid('Rename primary domain'), [
                f(msgid('Current primary domain'), a?.primaryDomain), f(msgid('New primary domain')), f(msgid('Keep old domain as an alias'), undefined, 'checkbox'), f(msgid('Type current primary domain to confirm'))
            ], [
                msgid('Rename primary domain')
            ]),
            d('domain-rename-changes', msgid('What changes'), msgid('The reviewed rename plan must list affected mailboxes, certificates and subdomains. No migration plan has been read or applied.')),
            d('domain-rename-stays', msgid('What stays'), msgid('The account identity, files and databases must remain intact. No rename is available from this workspace until its scoped migration and rollback are implemented.')),
            d('domain-create-review', msgid('This will create'), msgid('The domain, aliases, DNS and certificate changes must be reviewed from an actual plan. No creation plan has been read.')),
            s('domain-binding', msgid('How names are served'), [
                f(msgctxt('approved-xpanel-pages', 'Primary domain'), a?.primaryDomain), f(msgid('Default IPv4'), a?.ipv4), f(msgid('Default IPv6'), a?.ipv6)
            ])
        ], [
            s('domain-limits', msgid('Domain limits'), [
                f(msgid('Saved domains'), domains?.length), f(msgid('Addon-domain limit'), plan?.caps.addonDomains)
            ])
        ]);
        case '/domains/zone-editor': return page(msgid('Zone editor'), msgid('Review records and check deliverability separately.'), [
            s('email-deliverability', msgid('Email deliverability'), [
                f('SPF'), f('DKIM'), f('DMARC'), f(msgid('Reverse DNS'))
            ], [
                msgid('Check status'), msgid('Check again'), msgid('Fix')
            ]),
            s('dns-record-filter', msgid('Record type filter'), [
                f(msgid('Zone'), undefined, undefined, (domains ?? []).map(row => row.name)), f(msgid('Show record types'), undefined, 'radio', [
                    msgid('All'), 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'
                ], {
                    technicalChoices: true
                })
            ], [
                msgid('Edit record'), msgid('Delete record')
            ]),
            {
                ...s('dns-add-record', msgid('Records and zone editor'), [
                    f(msgid('Type'), undefined, undefined, [
                        'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'
                    ]), f(msgid('Name')), f(msgid('Content')), f('TTL', undefined, 'number'), f(msgid('Priority'), undefined, 'number'), f(msgid('Weight'), undefined, 'number'), f(msgid('Port'), undefined, 'number'), f(msgid('Target')), f(msgid('Flags'), undefined, 'number'), f(msgid('Tag'))
                ], [
                    msgid('Add record')
                ]), binding: 'dns'
            }
        ], [
            s('zone-facts', msgid('Zone facts'), [
                f(msgid('Zone'), domain?.name), f(msgid('Records read'), p.dnsRecords?.length)
            ]), d('dns-change', msgid('How a change is applied'), msgid('Saving a record is separate from public DNS propagation and mail-delivery checks.'))
        ]);
        case '/metrics/traffic': {
            const x = p.websiteAnalytics;
            return page(msgid('Metrics'), msgid('Traffic, response status and bandwidth from log observations.'), [
                s('metrics-scope', msgid('Traffic selection'), [
                    f(msgid('Domain'), undefined, undefined, (domains ?? []).map(row => row.name)), f(msgid('Range'), undefined, undefined, [
                        msgid('Last 7 days'), msgid('Last 30 days')
                    ])
                ]),
                {
                    ...s('visitors', msgid('Unique visitors per day'), [
                        f(msgid('Unique visitors'), x?.totals.uniqueVisitors), f(msgid('Requests'), x?.totals.requests)
                    ]), chart: true, message: msgid('Daily visitor readings have not been read. Request totals do not establish a daily visitor series.')
                },
                t('top-pages', msgid('Top pages'), [
                    msgid('Path'), msgid('Requests'), msgid('Transferred')
                ], x?.topPaths.map(row => [
                    row.key, String(row.requests), formatBytes(row.bytes)
                ]), x !== undefined),
                s('response-status', msgid('Responses by status'), [
                    f('2xx', x?.totals.status2xx), f('3xx', x?.totals.status3xx), f('4xx', x?.totals.status4xx), f('5xx', x?.totals.status5xx)
                ]),
                t('error-paths', msgid('Errors by path'), [
                    msgid('Path'), msgid('Errors')
                ], x?.topPaths.filter(row => (row.errors5xx ?? 0) > 0).map(row => [
                    row.key, String(row.errors5xx)
                ]), x !== undefined)
            ], [
                s('bandwidth', msgid('Bandwidth by domain'), [
                    f(msgid('Domain'), x?.domain), f(msgid('Transferred'), x ? formatBytes(x.totals.bytes) : undefined)
                ]), s('raw-logs', msgid('Raw access logs'), [], [
                    msgid('Download logs')
                ])
            ]);
        }
        case '/security/ssl': return page('SSL/TLS', msgid('Choose the certificate, names and validation, then review installation.'), [
            {
                ...s('certificate-wizard', msgid('Certificate wizard'), [
                    f(msgid('Existing certificate'), undefined, undefined, []), f(msgid('Certificate source'), undefined, undefined, [
                        msgid('Issue with ACME'), msgid('Use an existing certificate'), msgid('Upload a private key and certificate')
                    ]), f(msgid('Domain'), domain?.name), f(msgid('Private key'), undefined, 'textarea'), f(msgid('Certificate'), undefined, 'textarea'), f(msgid('CA bundle (optional)'), undefined, 'textarea'), f(msgid('Validation'), undefined, undefined, [
                        'HTTP-01', 'DNS-01'
                    ], {
                        technicalChoices: true
                    })
                ], [
                    msgid('Cancel'), msgid('Back'), msgid('Review choices'), msgid('Install or issue certificate')
                ]), steps: [
                    msgid('Source'), msgid('Names'), msgid('Validation'), msgctxt('approved-xpanel-pages', 'Install'), msgid('Result')
                ]
            }
        ], [
            s('certificate-choices', msgid('Your choices'), [
                f(msgid('Domain'), domain?.name), f(msgid('Installed certificate'), domain ? domain.certificateId ? translator(p.locale)('Stored') : translator(p.locale)(msgctxt('approved-xpanel-pages', 'Not configured')) : undefined)
            ]), d('wildcards', msgid('About wildcard certificates'), msgid('A wildcard covers one label level and requires DNS validation.'))
        ]);
        case '/security/account': return page(msgid('Account security'), msgid('Sign-in, API credentials, SSH access and site protection.'), [
            d('sign-in', msgid('Sign-in'), msgid('Password and optional two-factor controls are provided by the account authentication panel.')),
            s('account-password', msgid('Password'), [
                f(msgid('Current password'), undefined, 'password'), f(msgid('New password'), undefined, 'password'), f(msgid('Repeat new password'), undefined, 'password'), f(msgid('Show passwords'), undefined, 'checkbox')
            ], [
                msgid('Change password')
            ]),
            s('ip-blocker', msgid('IP blocker'), [
                f(msgid('Address or range'))
            ], [
                msgid('Block address')
            ]),
            s('hotlink-protection', msgid('Hotlink protection'), [
                f(msgid('Enable hotlink protection'), undefined, 'checkbox'), f(msgid('Sites allowed to embed')), f(msgid('File types')), f(msgid('Allow requests with no referrer'), undefined, 'checkbox')
            ], [
                msgid('Save hotlink rules')
            ]),
            s('api-tokens', msgid('API tokens'), [
                f(msgid('Name')), f(msgid('Expires after'), undefined, undefined, [
                    msgid('1 day'), msgid('30 days'), msgid('90 days')
                ]), f(msgid('Allowed addresses (optional)'))
            ], [
                msgid('Create token')
            ]),
            s('account-directory-privacy', msgctxt('approved-xpanel-pages', 'Directory privacy'), [
                f(msgid('Folder')), f(msgid('Prompt shown')), f(msgid('First user')), f(msgid('Password for this user'), undefined, 'password')
            ], [
                msgid('Protect folder')
            ]),
            s('ssh-access', msgid('SSH access'), [
                f(msgid('Name')), f(msgid('Public key'), undefined, 'textarea')
            ], [
                msgid('Add key')
            ])
        ], [
            s('site-protection', msgid('Site protection'), [
                f(msgid('Address or range')), f(msgid('Sites allowed to embed')), f(msgid('File types'))
            ], [
                msgid('Block address'), msgid('Save hotlink rules')
            ])
        ]);
        case '/software/php': return page('PHP', msgid('Select the domain runtime, worker pool and per-site INI values.'), [
            {
                ...s('php-domain', msgid('Domain and version'), [
                    f(msgid('Domain'), domain?.name), f(msgid('PHP version'), php?.version), f(msgid('Handler'), php?.handler, undefined, [
                        msgid('fpm'), msgid('cgi'), msgid('suphp'), 'lsphp'
                    ])
                ]), binding: 'php'
            },
            s('php-pool', msgid('PHP-FPM pool'), [
                f(msgid('Process manager'), php?.fpm.mode, undefined, [
                    'ondemand', 'dynamic', 'static'
                ]), f('pm.max_children', php?.fpm.maxChildren, 'number'), f('pm.start_servers', php?.fpm.startServers, 'number'), f('pm.min_spare_servers', php?.fpm.minSpareServers, 'number'), f('pm.max_spare_servers', php?.fpm.maxSpareServers, 'number'), f('pm.max_requests', php?.fpm.maxRequests, 'number'), f(msgid('Idle timeout (seconds)'), php?.fpm.processIdleTimeoutSec, 'number')
            ]),
            s('php-extra-ini', msgid('Additional INI values'), [
                f('max_input_vars', php?.ini.max_input_vars), f('date.timezone', php?.ini['date.timezone']), f('display_errors', php?.ini.display_errors, undefined, [
                    msgctxt('approved-xpanel-pages', 'Off'), msgctxt('approved-xpanel-pages', 'On')
                ])
            ]),
            s('php-save-target', msgid('Save to'), [
                f(msgid('Configuration target'), undefined, 'radio', [
                    '.user.ini', msgid('PHP-FPM pool')
                ])
            ]),
            {
                ...s('php-config-preview', msgid('Configuration preview'), [
                    f(msgid('Candidate configuration'), undefined, 'textarea')
                ]), message: msgid('The effective configuration and candidate preview have not been read. No configuration file is generated or saved by this preview.')
            },
            s('php-ini', msgid('INI values'), [
                f('memory_limit', php?.ini.memory_limit), f('upload_max_filesize', php?.ini.upload_max_filesize), f('post_max_size', php?.ini.post_max_size), f('max_execution_time', php?.ini.max_execution_time)
            ], [
                msgid('Reset'), msgid('Save PHP settings')
            ])
        ], [
            { ...s('php-running', msgid('Saved PHP assignment'), [
                f(msgid('Domain'), domain?.name), f(msgid('Version'), php?.version), f(msgid('Handler'), php?.handler)
            ]), message: msgid('Stored assignment only. The running PHP service has not been observed here.') }, d('php-disabled-functions', msgid('Disabled functions'), msgid('The effective disabled-function list has not been read.'))
        ]);
        case '/software/htaccess': return page(msgid('.htaccess editor'), msgid('Edit site rules and validate before replacing the saved file.'), [
            s('htaccess-editor', msgid('Site rules'), [
                f(msgid('File'), domain ? `${domain.docRoot}/.htaccess` : undefined), f(msgid('Insert'), undefined, undefined, [
                    msgctxt('approved-xpanel-pages', 'Redirect'), msgid('Rewrite rule'), msgid('Access restriction')
                ]), f(msgid('File contents'), undefined, 'textarea')
            ], [
                msgid('Insert at cursor'), msgid('Discard draft'), msgid('Save and check site')
            ]),
            {
                ...t('htaccess-php-compatibility', msgid('PHP directive compatibility'), [
                    msgctxt('approved-xpanel-pages', 'Directive'), msgid('Value'), msgid('Compatibility')
                ]), actions: [
                    msgid('Move PHP settings to .user.ini'), msgid('Undo move')
                ]
            },
            d('htaccess-php', msgctxt('approved-xpanel-pages', 'PHP settings in .htaccess'), msgid('Read existing directives before moving PHP values to .user.ini.'))
        ], [
            {
                ...t('htaccess-versions', msgid('Versions'), [
                    msgid('Version'), msgid('Saved (UTC)'), msgid('Author'), msgid('Result')
                ]), actions: [
                    msgid('Restore selected version')
                ]
            }, d('htaccess-save', msgid('What a save does'), msgid('Validation and site checks must pass; a failure preserves the previous working file.'))
        ]);
        case '/advanced/cron': return page(msgid('Cron jobs'), msgid('Scheduled commands, run results and output delivery.'), [
            t('scheduled-jobs', msgid('Scheduled jobs'), [
                msgid('Job'), msgctxt('approved-xpanel-pages', 'Schedule'), msgid('Command'), msgid('Last run'), msgid('Duration'), msgid('Next run'), msgid('Actions')
            ]),
            s('cron-selected-job', msgid('Selected job'), [
                f(msgid('Delete confirmation'))
            ], [
                msgid('View unit'), msgid('Run selected job now'), msgid('Keep'), msgid('Delete job')
            ]),
            {
                ...s('cron-unit-preview', msgid('Unit preview'), [
                    f(msgid('Unit contents'), undefined, 'textarea')
                ]), message: msgid('No job or unit has been selected or read.')
            },
            t('cron-next-runs', msgid('Next runs (UTC)'), [
                msgctxt('approved-xpanel-pages', 'Run'), msgid('Scheduled time')
            ]),
            s('add-cron', msgctxt('approved-xpanel-pages', 'Add a cron job'), [
                f(msgctxt('approved-xpanel-pages', 'Common schedules'), undefined, undefined, [
                    msgid('Every 5 minutes'), msgid('Every hour'), msgctxt('approved-xpanel-pages', 'Twice a day'), msgid('Every day'), msgid('Every Sunday'), msgid('On the 1st of the month'), msgid('Custom schedule')
                ]), f(msgid('Minute')), f(msgid('Hour')), f(msgid('Day')), f(msgid('Month')), f(msgid('Weekday')), f(msgid('Command to run')), f(msgid('Stop after (seconds)'), undefined, 'number'), f(msgid('Unlimited timeout'), undefined, 'checkbox'), f(msgid('Send output'), undefined, undefined, [
                    msgid('Only when it fails'), msgid('After every run'), msgid('Never')
                ])
            ], [
                msgid('Reset'), msgctxt('approved-xpanel-pages', 'Add cron job')
            ])
        ], [
            d('cron-runtime', msgid('How a job runs'), msgid('Commands run with the account identity and limits. A schedule does not establish successful execution.')), s('cron-output', msgctxt('approved-xpanel-pages', 'Output email'), [
                f(msgctxt('approved-xpanel-pages', 'Send job output to'), a?.contactEmail, 'email')
            ], [
                msgid('Save address')
            ])
        ]);
        default: throw new Error('Unsupported account workspace');
    }
};
