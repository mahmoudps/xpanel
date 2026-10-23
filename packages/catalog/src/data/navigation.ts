// Navigation: surface → sections → pages → catalog tools. Every in-scope tool is delivered by exactly one page.
// Designed 2026-10-22 from the full catalog (familiar cPanel/WHM structure, aaPanel features re-homed, duplicates folded).
import type { NavSurface } from '../types.ts'

export const navigation: NavSurface[] = [
  {
    "surface": "xpanel",
    "sections": [
      {
        "id": "general",
        "name": "General",
        "icon": "LayoutDashboard",
        "pages": [
          {
            "id": "home",
            "name": "Home",
            "route": "/home",
            "template": "dashboard",
            "artboard": "PanelHome",
            "primaryAction": "Add domain",
            "roles": [
              "owner"
            ],
            "tools": [
              "xpanel-tools-home",
              "xpanel-general-info",
              "xpanel-usage-stats-panel",
              "xpanel-notifications",
              "xpanel-global-search",
              "xpanel-onboarding-assistant"
            ],
            "keywords": [
              "Home",
              "Dashboard",
              "Tools",
              "General Information",
              "Statistics",
              "Notifications",
              "Find a tool",
              "Search",
              "Quick bar",
              "Getting started",
              "End-User Overview",
              "الرئيسية",
              "لوحة المعلومات"
            ],
            "summary": "Start here: what needs attention, your sites, pinned and recent tools, the tool index, general information and usage against your plan."
          },
          {
            "id": "resources",
            "name": "Resources & quotas",
            "route": "/resources",
            "template": "dashboard",
            "artboard": "PanelResources",
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "resource-usage",
              "account-usage-stats",
              "disk-usage"
            ],
            "keywords": [
              "Resource Usage",
              "CPU and Concurrent Connection Usage",
              "Disk Usage",
              "IO usage",
              "IO monitor",
              "IOPS",
              "Memory usage",
              "Processes",
              "LVE",
              "Account Usage Statistics",
              "Statistics",
              "Quota",
              "Limits",
              "Limit faults",
              "Slice",
              "استهلاك الموارد"
            ],
            "summary": "See live and historical CPU, memory, IO and process use of your account against its limits, the limit hits that slowed your sites, and what fills your disk."
          },
          {
            "id": "site-health",
            "name": "Site health",
            "route": "/health",
            "template": "dashboard",
            "artboard": "PanelHealth",
            "primaryAction": "Check again",
            "roles": [
              "owner"
            ],
            "tools": [
              "account-health-overview"
            ],
            "keywords": [
              "Site health",
              "Account health",
              "Health check",
              "Diagnostics",
              "SSL check",
              "DNS check",
              "Mail authentication check",
              "Backup status",
              "فحص الصحة"
            ],
            "summary": "Run health checks on every site you own (limits, errors, certificates, DNS, mail authentication, PHP, backups) and fix each finding from one place."
          },
          {
            "id": "server-information",
            "name": "Server information",
            "route": "/server-information",
            "template": "custom",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "xpanel-server-information"
            ],
            "keywords": [
              "Server Information",
              "Server status",
              "Service status",
              "Software versions",
              "Plan details",
              "Hosting package"
            ],
            "summary": "Read your plan, the server's software versions and the live status of each service your sites depend on."
          }
        ]
      },
      {
        "id": "email",
        "name": "Email",
        "icon": "Mail",
        "pages": [
          {
            "id": "email-accounts",
            "name": "Email accounts",
            "route": "/email/accounts",
            "template": "list",
            "artboard": "PanelEmail",
            "primaryAction": "Create mailbox",
            "roles": [
              "owner"
            ],
            "tools": [
              "email-accounts",
              "email-account-create",
              "email-account-manage"
            ],
            "keywords": [
              "Email Accounts",
              "Mailboxes",
              "Create email account",
              "Manage Email Account",
              "Check Email",
              "Open in xMail",
              "Connect Devices",
              "Mail Client Configuration",
              "Email Disk Usage",
              "Address Importer",
              "Import mailboxes",
              "Restrictions",
              "Mailbox quota"
            ],
            "summary": "Create and manage the account's mailboxes: quota, password and restrictions, device setup, mailbox clean-up, bulk import and opening a mailbox in xMail."
          },
          {
            "id": "forwarders",
            "name": "Forwarders & autoresponders",
            "route": "/email/forwarders",
            "template": "list",
            "artboard": "PanelEmail",
            "primaryAction": "Add forwarder",
            "roles": [
              "owner"
            ],
            "tools": [
              "forwarders",
              "domain-forwarders",
              "default-address",
              "autoresponders"
            ],
            "keywords": [
              "Forwarders",
              "Email forwarding",
              "Domain Forwarders",
              "Default Address",
              "Catch-all",
              "Unrouted mail",
              "Mail Forwarding",
              "Pipe to program",
              "Autoresponders",
              "Auto Responder",
              "Mail Auto Responder",
              "Vacation reply",
              "Out of office",
              "Away message"
            ],
            "summary": "Decide what happens to your account's mail: forward one address or a whole domain, send scheduled automatic replies, and choose where mail for addresses that do not exist goes."
          },
          {
            "id": "mailing-lists",
            "name": "Mailing lists",
            "route": "/email/mailing-lists",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create list",
            "roles": [
              "owner"
            ],
            "tools": [
              "mailing-lists"
            ],
            "keywords": [
              "Mailing Lists",
              "Mailman",
              "Discussion list",
              "Announcement list",
              "Subscribers"
            ],
            "summary": "Manage your account's discussion and announcement mailing lists, their subscribers and moderation settings."
          },
          {
            "id": "email-filters",
            "name": "Email filters",
            "route": "/email/filters",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create filter",
            "roles": [
              "owner"
            ],
            "tools": [
              "global-email-filters",
              "email-filters",
              "connect-devices",
              "email-disk-usage",
              "address-importer"
            ],
            "keywords": [
              "Email Filters",
              "Global Email Filters",
              "Account-level filtering",
              "User-level filtering",
              "Mail rules",
              "Sieve",
              "Wildcard redirect"
            ],
            "summary": "Write ordered rules that act on incoming mail, either for every mailbox on the account or for one mailbox."
          },
          {
            "id": "deliverability",
            "name": "Deliverability & routing",
            "route": "/email/deliverability",
            "template": "matrix",
            "artboard": "PanelEmail",
            "primaryAction": "Check again",
            "roles": [
              "owner"
            ],
            "tools": [
              "email-deliverability",
              "email-routing"
            ],
            "keywords": [
              "Email Deliverability",
              "Email Routing",
              "MX Entry",
              "Mail exchanger",
              "DKIM",
              "SPF",
              "DMARC",
              "PTR",
              "Reverse DNS",
              "HELO",
              "Mail Domains",
              "Mail DNS Records",
              "Remote mail exchanger"
            ],
            "summary": "For each domain, check and repair SPF, DKIM, DMARC, reverse DNS and MX, and set whether this server, a backup or a remote service receives its mail."
          },
          {
            "id": "spam-filters",
            "name": "Spam filters",
            "route": "/email/spam-filters",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "spam-filters",
              "greylisting",
              "sender-verification"
            ],
            "keywords": [
              "Spam Filters",
              "Apache SpamAssassin",
              "SpamAssassin",
              "Spam score",
              "Spam threshold",
              "Spam Box",
              "Allow list",
              "Block list",
              "Greylisting",
              "BoxTrapper",
              "Sender Verification",
              "Challenge-response"
            ],
            "summary": "Tune spam scoring, the spam folder, auto-delete and allow and block lists, and turn on greylisting per domain or sender verification per mailbox."
          },
          {
            "id": "spam-quarantine",
            "name": "Spam quarantine",
            "route": "/email/spam-quarantine",
            "template": "list",
            "artboard": "PanelQuarantine",
            "primaryAction": "Release selected",
            "roles": [
              "owner"
            ],
            "tools": [
              "spam-quarantine"
            ],
            "keywords": [
              "Spam quarantine",
              "Quarantine",
              "Held mail",
              "Release message",
              "False positive",
              "Not spam",
              "Mail quality",
              "حجر"
            ],
            "summary": "Review mail the spam filter held, release false positives and teach the filter from your corrections."
          },
          {
            "id": "email-archive",
            "name": "Email archive",
            "route": "/email/archive",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "email-archive"
            ],
            "keywords": [
              "Archive",
              "Email Archiving",
              "Mail retention",
              "Compliance archive"
            ],
            "summary": "Archive incoming, outgoing and list mail per domain with retention periods, read-only IMAP access and downloads."
          },
          {
            "id": "encryption",
            "name": "Encryption",
            "route": "/email/encryption",
            "template": "list",
            "artboard": null,
            "primaryAction": "Generate key",
            "roles": [
              "owner"
            ],
            "tools": [
              "email-encryption"
            ],
            "keywords": [
              "Encryption",
              "GnuPG",
              "GnuPG Keys",
              "GPG",
              "PGP",
              "OpenPGP",
              "Sign email"
            ],
            "summary": "Generate, import, view and delete the OpenPGP key pairs used to sign and encrypt mail."
          },
          {
            "id": "calendars-contacts",
            "name": "Calendars & contacts",
            "route": "/email/calendars-contacts",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create calendar",
            "roles": [
              "owner"
            ],
            "tools": [
              "calendars-contacts-management",
              "calendars-contacts-sharing",
              "calendars-contacts-config"
            ],
            "keywords": [
              "Calendars and Contacts",
              "Calendars and Contacts Management",
              "Calendars and Contacts Sharing",
              "Calendars and Contacts Configuration",
              "CalDAV",
              "CardDAV",
              "Address books",
              "Task lists"
            ],
            "summary": "Create calendars, address books and task lists for mailboxes, share them between mailboxes and get the sync settings for devices."
          }
        ]
      },
      {
        "id": "files",
        "name": "Files",
        "icon": "FolderOpen",
        "pages": [
          {
            "id": "file-manager",
            "name": "File manager",
            "route": "/files/manager",
            "template": "custom",
            "artboard": "PanelFiles",
            "primaryAction": "Upload",
            "roles": [
              "owner"
            ],
            "tools": [
              "file-manager",
              "file-text-editor"
            ],
            "keywords": [
              "File Manager",
              "File Editor",
              "Code Editor",
              "HTML Editor",
              "Images",
              "Thumbnailer",
              "Image Scaler",
              "Image Converter",
              "Upload",
              "Remote download",
              "Permissions",
              "chmod",
              "Compress",
              "Extract",
              "Search file contents",
              "Favorites",
              "إدارة الملفات",
              "File Browser",
              "Upload and Remote Download",
              "File Operations",
              "Permissions and Ownership",
              "Search File Contents",
              "Path Favorites",
              "Online File Editor"
            ],
            "summary": "Browse, upload, fetch from a URL, edit, search inside, compress, extract and set permissions on files in your home folder, and resize or convert images."
          },
          {
            "id": "trash",
            "name": "Trash",
            "route": "/files/trash",
            "template": "list",
            "artboard": "PanelFiles",
            "primaryAction": "Restore selected",
            "roles": [
              "owner"
            ],
            "tools": [
              "file-trash",
              "html-editor",
              "images"
            ],
            "keywords": [
              "Trash",
              "Recycle Bin",
              "Deleted files",
              "Restore deleted files",
              "Empty trash",
              "سلة"
            ],
            "summary": "Restore deleted files, folders and site roots to their original paths, or purge them, before the retention period ends."
          },
          {
            "id": "directory-privacy",
            "name": "Directory privacy",
            "route": "/files/directory-privacy",
            "template": "list",
            "artboard": "PanelSite",
            "primaryAction": "Protect a directory",
            "roles": [
              "owner"
            ],
            "tools": [
              "directory-privacy",
              "leech-protection"
            ],
            "keywords": [
              "Directory Privacy",
              "Password Protect Directories",
              "Directory Password Protection",
              "Basic auth",
              "htpasswd",
              "Leech Protection",
              "Shared passwords"
            ],
            "summary": "Password-protect web folders and automatically lock protected-folder users whose credentials are being shared."
          },
          {
            "id": "web-disk",
            "name": "Web Disk",
            "route": "/files/web-disk",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create Web Disk account",
            "roles": [
              "owner"
            ],
            "tools": [
              "web-disk"
            ],
            "keywords": [
              "Web Disk",
              "WebDAV",
              "Network drive",
              "Map drive"
            ],
            "summary": "Reach your files as a network drive over WebDAV, and give extra users read-write or read-only access to one folder."
          },
          {
            "id": "ftp",
            "name": "FTP accounts",
            "route": "/files/ftp",
            "template": "list",
            "artboard": "PanelFtp",
            "primaryAction": "Create FTP account",
            "roles": [
              "owner"
            ],
            "tools": [
              "ftp-accounts",
              "ftp-connections",
              "anonymous-ftp"
            ],
            "keywords": [
              "FTP Accounts",
              "FTP Connections",
              "FTP Sessions",
              "Anonymous FTP",
              "FTP Quota",
              "Change FTP Home Directory",
              "SFTP"
            ],
            "summary": "Create FTP users locked to one folder with optional quota, see and end live sessions, and control anonymous FTP for your account."
          },
          {
            "id": "backup",
            "name": "Backup",
            "route": "/files/backup",
            "template": "wizard",
            "artboard": "PanelBackup",
            "primaryAction": "Back up now",
            "roles": [
              "owner"
            ],
            "tools": [
              "backup",
              "website-backups",
              "file-restoration"
            ],
            "keywords": [
              "Backup",
              "Backup Wizard",
              "Website Backups",
              "Site Backup",
              "Database Backup and Restore",
              "File and Directory Restoration",
              "Restore",
              "Partial backup",
              "Download backup",
              "Restore points"
            ],
            "summary": "Back up the whole account, one site or one part (home, a database, mail, forwarders and filters), and restore from your archives or the server's restore points with a preview."
          },
          {
            "id": "git",
            "name": "Git & deployments",
            "route": "/files/git",
            "template": "list",
            "artboard": "PanelGit",
            "primaryAction": "Create repository",
            "roles": [
              "owner"
            ],
            "tools": [
              "git-version-control",
              "gitweb",
              "git-deployments"
            ],
            "keywords": [
              "Git Version Control",
              "Gitweb",
              "Git deployment",
              "Create Site from Git",
              "Clone repository",
              "Deploy",
              "Pull",
              "Deploy",
              "Push to deploy",
              "Releases",
              "Rollback",
              "CI"
            ],
            "summary": "Create or clone repositories, switch branches, pull updates, deploy with a repository task file and browse history."
          }
        ]
      },
      {
        "id": "databases",
        "name": "Databases",
        "icon": "Database",
        "pages": [
          {
            "id": "phpmyadmin",
            "name": "phpMyAdmin",
            "route": "/databases/phpmyadmin",
            "template": "custom",
            "artboard": "PanelPhpMyAdmin",
            "primaryAction": "Open phpMyAdmin",
            "roles": [
              "owner"
            ],
            "tools": [
              "phpmyadmin",
              "database-wizard"
            ],
            "keywords": [
              "phpMyAdmin",
              "Web SQL client",
              "SQL query",
              "Browse tables",
              "Import SQL",
              "Export SQL"
            ],
            "summary": "Open phpMyAdmin with single sign-on, limited to this account's own MariaDB databases."
          },
          {
            "id": "mariadb",
            "name": "MariaDB databases",
            "route": "/databases/mariadb",
            "template": "list",
            "artboard": "PanelDatabases",
            "primaryAction": "Create database",
            "roles": [
              "owner"
            ],
            "tools": [
              "mysql-databases",
              "mysql-users"
            ],
            "keywords": [
              "MySQL Databases",
              "MySQL Database Wizard",
              "Database Wizard",
              "MySQL Users",
              "Database users",
              "Privileges",
              "MariaDB",
              "Database Import",
              "Database Recycle Bin",
              "Bulk Database Password Change",
              "Rename database"
            ],
            "summary": "Create, import, rename, repair and delete the account's MariaDB databases and users, grant privileges and recover dropped databases while they wait for purge."
          },
          {
            "id": "database-insights",
            "name": "Database insights",
            "route": "/databases/insights",
            "template": "dashboard",
            "artboard": "PanelDbInsights",
            "primaryAction": "Run analysis",
            "roles": [
              "owner"
            ],
            "tools": [
              "database-insights"
            ],
            "keywords": [
              "Database insights",
              "Slow queries",
              "Missing indexes",
              "Table health",
              "Optimize tables",
              "Repair tables",
              "Table Maintenance Tools",
              "Engine conversion",
              "Database size"
            ],
            "summary": "See size, growth, slow queries, missing indexes and table health for your databases, and optimize, repair or convert tables."
          },
          {
            "id": "remote-database-access",
            "name": "Remote database access",
            "route": "/databases/remote-access",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add host",
            "roles": [
              "owner"
            ],
            "tools": [
              "remote-database-access"
            ],
            "keywords": [
              "Remote Database Access",
              "Remote MySQL",
              "Database Access Scope",
              "Access hosts",
              "Allow remote connections"
            ],
            "summary": "Choose which outside hosts may connect to your MariaDB databases."
          },
          {
            "id": "postgresql",
            "name": "PostgreSQL databases",
            "route": "/databases/postgresql",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create database",
            "roles": [
              "owner"
            ],
            "tools": [
              "postgresql-databases",
              "postgresql-database-wizard"
            ],
            "keywords": [
              "PostgreSQL Databases",
              "PostgreSQL Database Wizard",
              "Postgres",
              "pgsql",
              "PostgreSQL users"
            ],
            "summary": "Create, rename and delete PostgreSQL databases and users, link them and resynchronize grants."
          },
          {
            "id": "phppgadmin",
            "name": "phpPgAdmin",
            "route": "/databases/phppgadmin",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Open phpPgAdmin",
            "roles": [
              "owner"
            ],
            "tools": [
              "phppgadmin"
            ],
            "keywords": [
              "phpPgAdmin",
              "PostgreSQL web client",
              "SQL query"
            ],
            "summary": "Open phpPgAdmin with single sign-on, limited to this account's own PostgreSQL databases."
          }
        ]
      },
      {
        "id": "domains",
        "name": "Domains",
        "icon": "Globe",
        "pages": [
          {
            "id": "domains",
            "name": "Domains",
            "route": "/domains",
            "template": "list",
            "artboard": "PanelDomains",
            "primaryAction": "Add domain",
            "roles": [
              "owner"
            ],
            "tools": [
              "domains",
              "create-domain"
            ],
            "keywords": [
              "Domains",
              "Addon Domains",
              "Subdomains",
              "Aliases",
              "Parked Domains",
              "Temporary Domains",
              "Create a New Domain",
              "Force HTTPS Redirect",
              "Websites",
              "Site List",
              "Add Site",
              "Batch Site Creation",
              "Subdirectory Binding",
              "Domain Manager",
              "Site categories",
              "Alias Domains",
              "Site Categories"
            ],
            "summary": "See every domain, addon, subdomain and alias with its document root, PHP, certificate and HTTPS redirect, add domains one at a time or in bulk, and act on several at once."
          },
          {
            "id": "site-settings",
            "name": "Site settings",
            "route": "/domains/site-settings",
            "template": "settings",
            "artboard": "PanelSite",
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "force-https-redirect",
              "manage-domain",
              "aapanel-site-start-stop",
              "aapanel-site-expiry",
              "aapanel-site-directory",
              "aapanel-site-quota",
              "aapanel-traffic-control",
              "aapanel-deny-access",
              "aapanel-site-config-editor"
            ],
            "keywords": [
              "Site settings",
              "Manage the Domain",
              "Website settings",
              "Document root",
              "Run directory",
              "Rename domain",
              "Start and Stop Site",
              "Suspend site",
              "Site Expiry Date",
              "Site Disk Quota",
              "Traffic Control",
              "Concurrency limit",
              "Deny File Access",
              "Site Config File",
              "Custom directives",
              "Open basedir"
            ],
            "summary": "Manage one site: document root and run directory, rename or remove the domain, stop or schedule expiry, disk and traffic caps, blocked file types and custom directives, with history."
          },
          {
            "id": "staging",
            "name": "Staging sites",
            "route": "/domains/staging",
            "template": "list",
            "artboard": "PanelStaging",
            "primaryAction": "Create staging site",
            "roles": [
              "owner"
            ],
            "tools": [
              "site-staging"
            ],
            "keywords": [
              "Staging",
              "Clone site",
              "Push to live",
              "Test site"
            ],
            "summary": "Clone a site to a staging subdomain, test changes, then push files or databases back to live."
          },
          {
            "id": "redirects",
            "name": "Redirects",
            "route": "/domains/redirects",
            "template": "list",
            "artboard": "PanelSite",
            "primaryAction": "Add redirect",
            "roles": [
              "owner"
            ],
            "tools": [
              "redirects"
            ],
            "keywords": [
              "Redirects",
              "301 redirect",
              "302 redirect",
              "URL redirect",
              "Wildcard redirect",
              "www redirect",
              "Redirect"
            ],
            "summary": "Send a domain or path to another address with a permanent (301) or temporary (302) redirect."
          },
          {
            "id": "reverse-proxy",
            "name": "Reverse proxy",
            "route": "/domains/reverse-proxy",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add proxy",
            "roles": [
              "owner"
            ],
            "tools": [
              "aapanel-site-reverse-proxy",
              "aapanel-proxy-project"
            ],
            "keywords": [
              "Reverse Proxy",
              "Proxy Project",
              "Proxy pass",
              "Backend",
              "Upstream",
              "Proxy site"
            ],
            "summary": "Forward a whole domain or one path to another backend, or create a proxy-only site, with host, timeout and caching options."
          },
          {
            "id": "zone-editor",
            "name": "Zone editor",
            "route": "/domains/zone-editor",
            "template": "editor",
            "artboard": "PanelDns",
            "primaryAction": "Add record",
            "roles": [
              "owner"
            ],
            "tools": [
              "zone-editor",
              "dnssec"
            ],
            "keywords": [
              "Zone Editor",
              "Advanced DNS Zone Editor",
              "Simple Zone Editor",
              "DNS records",
              "A record",
              "CNAME",
              "MX",
              "TXT",
              "DNSSEC",
              "DS record",
              "Provider DNS Records"
            ],
            "summary": "Edit the DNS records of your zones, here or at a connected DNS provider, and sign zones with DNSSEC."
          },
          {
            "id": "dynamic-dns",
            "name": "Dynamic DNS",
            "route": "/domains/dynamic-dns",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create hostname",
            "roles": [
              "owner"
            ],
            "tools": [
              "dynamic-dns"
            ],
            "keywords": [
              "Dynamic DNS",
              "DDNS",
              "DynDNS",
              "Changing IP"
            ],
            "summary": "Keep a hostname pointing at a device on a changing IP through a secret update URL."
          },
          {
            "id": "cloudflare",
            "name": "Cloudflare",
            "route": "/domains/cloudflare",
            "template": "settings",
            "artboard": "PanelCloudflare",
            "primaryAction": "Connect Cloudflare",
            "roles": [
              "owner"
            ],
            "tools": [
              "cloudflare-account"
            ],
            "keywords": [
              "Cloudflare",
              "Cloudflare account",
              "CDN",
              "Proxy status",
              "Orange cloud",
              "SSL mode",
              "Purge cache",
              "DNS sync"
            ],
            "summary": "Connect your own Cloudflare account to your domains to sync DNS, switch the proxy, set the SSL mode and purge the cache."
          },
          {
            "id": "site-publisher",
            "name": "Site publisher",
            "route": "/domains/site-publisher",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Publish site",
            "roles": [
              "owner"
            ],
            "tools": [
              "site-publisher"
            ],
            "keywords": [
              "Site Publisher",
              "Placeholder site",
              "Coming soon page",
              "Template site"
            ],
            "summary": "Publish a simple placeholder site from a template into a domain, with automatic backup and rollback of what was there."
          }
        ]
      },
      {
        "id": "metrics",
        "name": "Metrics",
        "icon": "BarChart3",
        "pages": [
          {
            "id": "traffic",
            "name": "Traffic & bandwidth",
            "route": "/metrics/traffic",
            "template": "dashboard",
            "artboard": "PanelMetrics",
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "traffic-monitor-account",
              "bandwidth"
            ],
            "keywords": [
              "Live traffic",
              "Traffic monitor",
              "Bandwidth",
              "Data transfer",
              "Requests",
              "Top pages",
              "Top visitors",
              "5xx rate"
            ],
            "summary": "Watch live requests, top pages, top visitors and errors for your domains, and data transfer by domain and protocol over time."
          },
          {
            "id": "logs",
            "name": "Logs",
            "route": "/metrics/logs",
            "template": "log",
            "artboard": "PanelLogs",
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "visitors",
              "errors",
              "raw-access",
              "track-delivery"
            ],
            "keywords": [
              "Visitors",
              "Errors",
              "Error Log",
              "Raw Access",
              "Raw Access Logs",
              "Access log",
              "Site Logs",
              "Log Analysis",
              "Access Log Security Analysis",
              "Attack scan",
              "Track Delivery",
              "Mail delivery",
              "PHP slow log",
              "Site Logs and Log Analysis"
            ],
            "summary": "Search, filter, tail and download your sites' access and error logs, scan them for attacks, and trace mail delivery."
          },
          {
            "id": "web-statistics",
            "name": "Web statistics",
            "route": "/metrics/web-stats",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "web-stats-awstats",
              "web-stats-webalizer",
              "web-stats-analog",
              "web-stats-ftp",
              "metrics-editor"
            ],
            "keywords": [
              "Awstats",
              "Webalizer",
              "Analog Stats",
              "Webalizer FTP",
              "FTP Statistics",
              "Metrics Editor",
              "Web stats",
              "Visitor statistics"
            ],
            "summary": "Read monthly, daily and hourly traffic reports per domain and for FTP, and choose which log analyzers run for each domain."
          }
        ]
      },
      {
        "id": "security",
        "name": "Security",
        "icon": "ShieldCheck",
        "pages": [
          {
            "id": "ssl",
            "name": "SSL/TLS",
            "route": "/security/ssl",
            "template": "list",
            "artboard": "PanelSsl",
            "primaryAction": "Add certificate",
            "roles": [
              "owner"
            ],
            "tools": [
              "ssl-tls-status"
            ],
            "keywords": [
              "SSL/TLS",
              "SSL/TLS Status",
              "AutoSSL",
              "Let's Encrypt",
              "Free certificate",
              "Install SSL",
              "Manage SSL sites",
              "Private Keys",
              "CSR",
              "Certificate Signing Requests",
              "Certificates",
              "Site SSL",
              "Certificate Manager",
              "Default key type",
              "Wildcard certificate",
              "HTTPS",
              "SSL/TLS Certificates (Unified View and Default Key Type)"
            ],
            "summary": "See the stored certificate state for every hostname on this account."
          },
          {
            "id": "issue-certificate",
            "name": "Issue certificate",
            "route": "/security/ssl/issue",
            "template": "custom",
            "artboard": "PanelSsl",
            "primaryAction": "Issue certificate",
            "roles": [
              "owner"
            ],
            "tools": [
              "ssl-install"
            ],
            "keywords": [
              "Install SSL",
              "Let's Encrypt",
              "HTTP-01",
              "Issue certificate"
            ],
            "summary": "Issue or renew a certificate for one of this account's domains."
          },
          {
            "id": "certificate-files",
            "name": "Certificate files",
            "route": "/security/ssl/files",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "ssl-certificates",
              "ssl-private-keys",
              "ssl-csrs"
            ],
            "keywords": [
              "Private Keys",
              "CSR",
              "Install SSL"
            ],
            "summary": "Stored keys, requests and certificate files."
          },
          {
            "id": "account-security",
            "name": "Account security",
            "route": "/security/account",
            "template": "settings",
            "artboard": "PanelSecurity",
            "primaryAction": "Set up two-factor",
            "roles": [
              "owner"
            ],
            "tools": [
              "password-security",
              "two-factor-auth",
              "api-tokens",
              "security-policy",
              "team-audit-log"
            ],
            "keywords": [
              "Password & Security",
              "Change password",
              "Two-Factor Authentication",
              "2FA",
              "Manage API Tokens",
              "API Tokens",
              "Sessions",
              "Security Policy",
              "Security questions",
              "Trusted IPs",
              "Team Audit Log",
              "Activity log",
              "Login history"
            ],
            "summary": "Change your password, enrol two-factor sign-in, manage sessions and API tokens, set login protection and review who did what in your account."
          },
          {
            "id": "waf",
            "name": "Web application firewall",
            "route": "/security/waf",
            "template": "settings",
            "artboard": "PanelWaf",
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "modsecurity"
            ],
            "keywords": [
              "ModSecurity",
              "Web Application Firewall",
              "WAF",
              "OWASP CRS",
              "Core Rule Set",
              "mod_security",
              "Firewall"
            ],
            "summary": "Turn the web application firewall rules on or off for all your domains or one domain."
          },
          {
            "id": "ip-blocker",
            "name": "IP blocker",
            "route": "/security/ip-blocker",
            "template": "list",
            "artboard": "PanelSite",
            "primaryAction": "Block an address",
            "roles": [
              "owner"
            ],
            "tools": [
              "ip-blocker"
            ],
            "keywords": [
              "IP Blocker",
              "IP Deny Manager",
              "Block IP",
              "Deny access",
              "Ban IP range"
            ],
            "summary": "Stop given IP addresses, ranges or hostnames from reaching your websites."
          },
          {
            "id": "hotlink-protection",
            "name": "Hotlink protection",
            "route": "/security/hotlink",
            "template": "settings",
            "artboard": "PanelSite",
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "hotlink-protection"
            ],
            "keywords": [
              "Hotlink Protection",
              "Anti-leech",
              "Referrer protection",
              "Bandwidth theft",
              "Image hotlinking"
            ],
            "summary": "Stop other sites from embedding your files by allowing only chosen referrers per file type."
          },
          {
            "id": "ssh-access",
            "name": "SSH access",
            "route": "/security/ssh",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add key",
            "roles": [
              "owner"
            ],
            "tools": [
              "ssh-access"
            ],
            "keywords": [
              "SSH Access",
              "Manage SSH Keys",
              "SSH keys",
              "Public key",
              "Private key",
              "Authorize key"
            ],
            "summary": "Generate, import, authorize, download and delete the SSH keys used to sign in to your account's shell."
          },
          {
            "id": "virus-scanner",
            "name": "Virus scanner",
            "route": "/security/virus-scanner",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Start scan",
            "roles": [
              "owner"
            ],
            "tools": [
              "virus-scanner"
            ],
            "keywords": [
              "Virus Scanner",
              "Malware scan",
              "Antivirus",
              "ClamAV",
              "Infected files"
            ],
            "summary": "Scan your files, mail or public folders for malware and decide what happens to each infected file."
          }
        ]
      },
      {
        "id": "software",
        "name": "Software",
        "icon": "Code",
        "pages": [
          {
            "id": "php",
            "name": "PHP",
            "route": "/software/php",
            "template": "list",
            "artboard": "PanelPhp",
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "php-version-selector",
              "multiphp-ini-editor"
            ],
            "keywords": [
              "PHP version selector",
              "Select PHP Version",
              "PHP Selector",
              "MultiPHP Manager",
              "MultiPHP INI Editor",
              "PHP version",
              "PHP extensions",
              "php.ini",
              "PHP-FPM",
              "Site PHP Version",
              "End-User PHP Manager",
              "Disabled functions",
              "memory_limit",
              "upload_max_filesize"
            ],
            "summary": "Choose each domain's PHP version, handler and extensions and set PHP directives for the account or one domain, with the effective value and its source."
          },
          {
            "id": "app-installer",
            "name": "App installer",
            "route": "/software/installer",
            "template": "list",
            "artboard": "PanelApps",
            "primaryAction": "Install app",
            "roles": [
              "owner"
            ],
            "tools": [
              "app-installer"
            ],
            "keywords": [
              "Site Software",
              "One-click install",
              "WordPress installer",
              "Install CMS",
              "App catalog"
            ],
            "summary": "Install common open-source web applications into your account domains from the catalog your provider allows."
          },
          {
            "id": "applications",
            "name": "Applications",
            "route": "/software/apps",
            "template": "list",
            "artboard": "PanelRuntimeApps",
            "primaryAction": "Create application",
            "roles": [
              "owner"
            ],
            "tools": [
              "nodejs-apps",
              "python-apps",
              "ruby-apps",
              "application-manager",
              "web-apps"
            ],
            "keywords": [
              "Node.js apps",
              "Python apps",
              "Ruby apps",
              "Setup Node.js App",
              "Setup Python App",
              "Setup Ruby App",
              "Application Manager",
              "Node.js Projects",
              "Python Projects",
              "Web Apps",
              "Passenger",
              "WSGI",
              "ASGI",
              "npm install",
              "Virtual environment"
            ],
            "summary": "Create, deploy and manage Node.js, Python and Ruby applications under your account, with the runtime and web-application controls your provider allows."
          },
          {
            "id": "containers",
            "name": "Containers",
            "route": "/software/containers",
            "template": "list",
            "artboard": "PanelContainers",
            "primaryAction": "Run container",
            "roles": [
              "owner"
            ],
            "tools": [
              "account-containers"
            ],
            "keywords": [
              "Docker",
              "Podman",
              "Containers",
              "Images"
            ],
            "summary": "Run rootless containers as your account inside its limits and publish them through your domains."
          },
          {
            "id": "cache",
            "name": "Redis & Memcached",
            "route": "/software/cache",
            "template": "settings",
            "artboard": "PanelCache",
            "primaryAction": "Enable",
            "roles": [
              "owner"
            ],
            "tools": [
              "account-cache-services"
            ],
            "keywords": [
              "Redis",
              "Memcached",
              "Object cache",
              "Cache"
            ],
            "summary": "A private Redis or Memcached for your account on a socket in your home, capped by your plan."
          },
          {
            "id": "htaccess",
            "name": ".htaccess editor",
            "route": "/software/htaccess",
            "template": "editor",
            "artboard": "PanelHtaccess",
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "aapanel-url-rewrite"
            ],
            "keywords": [
              "htaccess",
              ".htaccess",
              "URL Rewrite",
              "Rewrite rules",
              "mod_rewrite",
              "Pseudo-static",
              "WordPress rewrite",
              "Laravel rewrite"
            ],
            "summary": "Edit a site's .htaccess with ready rewrite templates, a config test before saving and automatic rollback if the site breaks."
          },
          {
            "id": "optimize-website",
            "name": "Optimize website",
            "route": "/software/optimize",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "optimize-website",
              "nginx-cache-control"
            ],
            "keywords": [
              "Optimize Website",
              "Compression",
              "gzip",
              "deflate",
              "NGINX Caching",
              "Reverse-Proxy Cache Control",
              "Website Acceleration Cache",
              "Page cache",
              "Clear cache",
              "Purge cache"
            ],
            "summary": "Speed up your sites with response compression and the Nginx page cache, including per-site cache rules and cache purge."
          },
          {
            "id": "packages",
            "name": "Packages & modules",
            "route": "/software/packages",
            "template": "list",
            "artboard": null,
            "primaryAction": "Install package",
            "roles": [
              "owner"
            ],
            "tools": [
              "php-pear-packages",
              "perl-modules"
            ],
            "keywords": [
              "PHP PEAR Packages",
              "PEAR",
              "Perl Modules",
              "CPAN"
            ],
            "summary": "Install PHP PEAR packages and Perl modules into your account's private libraries."
          }
        ]
      },
      {
        "id": "advanced",
        "name": "Advanced",
        "icon": "Wrench",
        "pages": [
          {
            "id": "terminal",
            "name": "Terminal",
            "route": "/advanced/terminal",
            "template": "custom",
            "artboard": "PanelTerminal",
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "terminal"
            ],
            "keywords": [
              "Terminal",
              "Shell",
              "Command line",
              "SSH terminal",
              "Web SSH",
              "Open Terminal Here",
              "Console"
            ],
            "summary": "Open a command line in the browser that runs as your account user inside its isolation, optionally in the current folder."
          },
          {
            "id": "cron",
            "name": "Cron jobs",
            "route": "/advanced/cron",
            "template": "list",
            "artboard": "PanelCron",
            "primaryAction": "Add cron job",
            "roles": [
              "owner"
            ],
            "tools": [
              "cron-jobs"
            ],
            "keywords": [
              "Cron Jobs",
              "Scheduled Tasks",
              "crontab",
              "Cron",
              "Run command on schedule",
              "Scheduled backup"
            ],
            "summary": "Schedule commands, URL calls and site or database backups as your account user, run them now and read their output."
          },
          {
            "id": "network-tools",
            "name": "Network tools",
            "route": "/advanced/network-tools",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Run lookup",
            "roles": [
              "owner"
            ],
            "tools": [
              "track-dns"
            ],
            "keywords": [
              "Track DNS",
              "Domain Lookup",
              "Trace Route",
              "traceroute",
              "dig",
              "nslookup",
              "DNS lookup"
            ],
            "summary": "Look up a domain's addresses, mail servers and zone data, and trace the route between you and the server."
          },
          {
            "id": "indexes",
            "name": "Directory indexes",
            "route": "/advanced/indexes",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "indexes"
            ],
            "keywords": [
              "Indexes",
              "Index Manager",
              "Directory listing"
            ],
            "summary": "Choose whether folders without an index page list their contents within your account."
          },
          {
            "id": "error-pages",
            "name": "Error pages",
            "route": "/advanced/error-pages",
            "template": "editor",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "owner"
            ],
            "tools": [
              "error-pages"
            ],
            "keywords": [
              "Error Pages",
              "Custom 404",
              "404 page",
              "403 page",
              "500 page"
            ],
            "summary": "Write your own pages for HTTP error codes per domain."
          },
          {
            "id": "apache-handlers",
            "name": "Apache handlers",
            "route": "/advanced/handlers",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add handler",
            "roles": [
              "owner"
            ],
            "tools": [
              "apache-handlers"
            ],
            "keywords": [
              "Apache Handlers",
              "AddHandler",
              "Handlers",
              "CGI",
              "Server-side includes"
            ],
            "summary": "Map file extensions to one of the web server's handlers, such as CGI or server-side includes."
          },
          {
            "id": "mime-types",
            "name": "MIME types",
            "route": "/advanced/mime-types",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add MIME type",
            "roles": [
              "owner"
            ],
            "tools": [
              "mime-types"
            ],
            "keywords": [
              "MIME Types",
              "AddType",
              "Content type",
              "File type"
            ],
            "summary": "Add content types for file extensions so browsers know how to handle new file formats."
          },
          {
            "id": "api-shell",
            "name": "API shell",
            "route": "/advanced/api-shell",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Run call",
            "roles": [
              "owner"
            ],
            "tools": [
              "api-shell"
            ],
            "keywords": [
              "API Shell",
              "UAPI",
              "API console",
              "Developer console",
              "API explorer"
            ],
            "summary": "Run panel API functions interactively against your account and see each request and response."
          }
        ]
      },
      {
        "id": "preferences",
        "name": "Preferences",
        "icon": "UserCog",
        "pages": [
          {
            "id": "account-preferences",
            "name": "Account preferences",
            "route": "/preferences",
            "template": "settings",
            "artboard": "PanelPreferences",
            "primaryAction": "Save",
            "roles": [
              "owner"
            ],
            "tools": [
              "account-preferences",
              "change-style"
            ],
            "keywords": [
              "Account Preferences",
              "Contact Information",
              "Contact email",
              "Notifications",
              "Notification preferences",
              "Change Style",
              "Theme",
              "Appearance",
              "Dark mode",
              "Density",
              "Keyboard shortcuts",
              "Home layout",
              "Reset page settings"
            ],
            "summary": "Set your contact addresses and which events notify you and how, plus appearance, keyboard shortcuts and home layout."
          },
          {
            "id": "language",
            "name": "Language",
            "route": "/preferences/language",
            "template": "settings",
            "artboard": "PanelPreferences",
            "primaryAction": "Save",
            "roles": [
              "owner"
            ],
            "tools": [
              "change-language"
            ],
            "keywords": [
              "Change Language",
              "Language",
              "Locale",
              "Interface language",
              "Arabic",
              "English",
              "العربية",
              "اللغة"
            ],
            "summary": "Choose the interface language and how digits are shown; English is the default and Arabic is fully right-to-left."
          },
          {
            "id": "user-manager",
            "name": "User manager",
            "route": "/preferences/users",
            "template": "list",
            "artboard": "PanelEmail",
            "primaryAction": "Add user",
            "roles": [
              "owner"
            ],
            "tools": [
              "user-manager"
            ],
            "keywords": [
              "User Manager",
              "Subaccounts",
              "Service users",
              "Email FTP and Web Disk user",
              "Shared login"
            ],
            "summary": "Give people one login for email, FTP and Web Disk without access to the panel."
          },
          {
            "id": "manage-team",
            "name": "Manage team",
            "route": "/preferences/team",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add team user",
            "roles": [
              "owner"
            ],
            "tools": [
              "manage-team"
            ],
            "keywords": [
              "Manage Team",
              "Team users",
              "Roles",
              "Delegate access",
              "Collaborators",
              "Developer access"
            ],
            "summary": "Invite team users who sign in to the panel with their own credentials and a role that limits what they can do."
          }
        ]
      }
    ]
  },
  {
    "surface": "xwhm",
    "sections": [
      {
        "id": "home",
        "name": "Home",
        "icon": "LayoutDashboard",
        "pages": [
          {
            "id": "dashboard",
            "name": "Dashboard",
            "route": "/whm",
            "template": "dashboard",
            "artboard": "WhmDashboard",
            "primaryAction": "Create account",
            "roles": [
              "root",
              "reseller"
            ],
            "tools": [
              "whm-home-favorites",
              "aapanel-dashboard",
              "whm-global-search",
              "whm-notifications"
            ],
            "keywords": [
              "Home",
              "WHM Home",
              "Favorites",
              "Server Dashboard",
              "Search",
              "Feature search",
              "Find account",
              "Notifications",
              "Needs attention"
            ],
            "summary": "Server status first: health strip, needs attention, running jobs, accounts near limits; pinned tools, global search and the notification bell live here."
          },
          {
            "id": "jobs",
            "name": "Jobs",
            "route": "/whm/jobs",
            "template": "log",
            "artboard": "WhmJobs",
            "primaryAction": null,
            "roles": [
              "root",
              "reseller"
            ],
            "tools": [
              "task-queue-monitor",
              "aapanel-task-messages"
            ],
            "keywords": [
              "Task Queue Monitor",
              "Background tasks",
              "Task and Message Box",
              "Activity",
              "Queue",
              "Install progress"
            ],
            "summary": "Every long operation as a job with steps, progress, heartbeat, log and result, for root and for a reseller's own jobs."
          },
          {
            "id": "audit-log",
            "name": "Audit log",
            "route": "/whm/audit",
            "template": "log",
            "artboard": "WhmAudit",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-panel-logs",
              "tweak-logging"
            ],
            "keywords": [
              "Panel logs",
              "Operation logs",
              "Access log",
              "API log",
              "Account activity logs",
              "Logging (Tweak Settings)",
              "History",
              "Account Activity Logs"
            ],
            "summary": "Who changed what, from where, with the before/after diff and the generation it produced; also the audit log verbosity settings."
          },
          {
            "id": "support",
            "name": "Support",
            "route": "/whm/support",
            "template": "custom",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root",
              "reseller"
            ],
            "tools": [
              "support-center",
              "tweak-support"
            ],
            "keywords": [
              "Support Center",
              "Help",
              "Documentation",
              "Support (Tweak Settings)",
              "Error reports"
            ],
            "summary": "Help resources the provider configured, documentation links and error-report sharing settings."
          }
        ]
      },
      {
        "id": "accounts",
        "name": "Accounts",
        "icon": "Users",
        "pages": [
          {
            "id": "accounts",
            "name": "Accounts",
            "route": "/whm/accounts",
            "template": "list",
            "artboard": "WhmAccounts",
            "primaryAction": "Create account",
            "roles": [
              "root",
              "reseller:list-accounts"
            ],
            "tools": [
              "list-accounts",
              "modify-account",
              "password-modification",
              "manage-account-suspension",
              "terminate-accounts"
            ],
            "keywords": [
              "List Accounts",
              "Modify an Account",
              "Terminate Accounts",
              "Manage Account Suspension",
              "List Suspended Accounts",
              "Show Accounts Over Quota",
              "Password Modification",
              "Force Password Change",
              "Quota Modification",
              "Upgrade/Downgrade an Account",
              "Modify/Upgrade Multiple Accounts",
              "Rearrange an Account",
              "Manage Demo Mode",
              "Limit Bandwidth Usage",
              "Sub-Panel Accounts",
              "Suspend",
              "Unsuspend",
              "Change plan"
            ],
            "summary": "One table of every account in scope with saved views (suspended, over quota, near limits), the edit drawer, row actions and the bulk bar for plan, owner, suspension, password, quota and termination."
          },
          {
            "id": "create-account",
            "name": "Create account",
            "route": "/whm/accounts/new",
            "template": "wizard",
            "artboard": "WhmAccountCreate",
            "primaryAction": "Create account",
            "roles": [
              "root",
              "reseller:create-account"
            ],
            "tools": [
              "create-account"
            ],
            "keywords": [
              "Create a New Account",
              "Add account",
              "New hosting account",
              "Add user"
            ],
            "summary": "Provisions a hosting account (UID, home, slice, vhost, DNS, mail) from a plan, with a live preflight of caps, IP and nameservers."
          },
          {
            "id": "account-health",
            "name": "Account health & repair",
            "route": "/whm/accounts/health",
            "template": "list",
            "artboard": "WhmAccountHealth",
            "primaryAction": "Check again",
            "roles": [
              "root"
            ],
            "tools": [
              "account-health",
              "account-repair",
              "list-suspended-accounts",
              "show-accounts-over-quota",
              "force-password-change",
              "quota-modification",
              "limit-bandwidth-usage",
              "upgrade-downgrade-account",
              "modify-upgrade-multiple-accounts",
              "rearrange-account",
              "manage-demo-mode"
            ],
            "keywords": [
              "Account health",
              "Site health",
              "Health score",
              "Account checks",
              "Site quality",
              "Account repair",
              "Fix permissions",
              "Rebuild account"
            ],
            "summary": "Health score per account with the reasons behind it: limits, errors, SSL, DNS, mail authentication, PHP version and backups."
          },
          {
            "id": "bandwidth",
            "name": "Bandwidth",
            "route": "/whm/accounts/bandwidth",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root",
              "reseller:list-accounts"
            ],
            "tools": [
              "view-bandwidth-usage",
              "reset-account-bandwidth-limit",
              "unsuspend-bandwidth-exceeders"
            ],
            "keywords": [
              "View Bandwidth Usage",
              "Reset Account Bandwidth Limit",
              "Unsuspend Bandwidth Exceeders",
              "Data transfer",
              "Traffic usage"
            ],
            "summary": "Monthly data transfer per account and protocol, with resetting custom limits and re-enabling sites blocked for exceeding them."
          },
          {
            "id": "announcements",
            "name": "Announcements",
            "route": "/whm/accounts/announcements",
            "template": "editor",
            "artboard": null,
            "primaryAction": "Send announcement",
            "roles": [
              "root"
            ],
            "tools": [
              "email-all-users",
              "email-all-resellers",
              "panel-news"
            ],
            "keywords": [
              "Email All Users",
              "Email All Resellers",
              "cPanel News",
              "Panel News",
              "Broadcast",
              "Message customers"
            ],
            "summary": "The one broadcast channel: email every account or every reseller and edit the news shown on users' home pages."
          },
          {
            "id": "templates",
            "name": "Templates",
            "route": "/whm/accounts/templates",
            "template": "editor",
            "artboard": null,
            "primaryAction": "Save template",
            "roles": [
              "root"
            ],
            "tools": [
              "skeleton-directory",
              "zone-templates",
              "web-template-editor",
              "notification-templates"
            ],
            "keywords": [
              "Skeleton Directory",
              "Zone Templates",
              "Edit Zone Templates",
              "Web Template Editor",
              "Default Pages",
              "Suspended page",
              "Notification templates",
              "Email templates"
            ],
            "summary": "Everything a new or changed account is built from in one place: skeleton directory, DNS zone templates, web placeholder pages and notification templates (English and Arabic)."
          }
        ]
      },
      {
        "id": "plans",
        "name": "Plans",
        "icon": "Package",
        "pages": [
          {
            "id": "plans",
            "name": "Plans",
            "route": "/whm/plans",
            "template": "list",
            "artboard": "WhmPlans",
            "primaryAction": "Create plan",
            "roles": [
              "root",
              "reseller:manage-plans"
            ],
            "tools": [
              "add-package",
              "edit-package",
              "delete-package"
            ],
            "keywords": [
              "Packages",
              "Add a Package",
              "Edit a Package",
              "Delete a Package",
              "Hosting plans",
              "Resource Packages",
              "Plan defaults",
              "LVE limits"
            ],
            "summary": "Hosting plans with their limits (disk, IO, IOPS, memory, processes, CPU), feature list and extensions, impact preview on save, and the defaults new plans start from."
          },
          {
            "id": "feature-lists",
            "name": "Feature lists",
            "route": "/whm/plans/features",
            "template": "matrix",
            "artboard": "WhmFeatures",
            "primaryAction": "Create feature list",
            "roles": [
              "root",
              "reseller:manage-plans"
            ],
            "tools": [
              "feature-manager",
              "tweak-packages"
            ],
            "keywords": [
              "Feature Manager",
              "Feature list",
              "Disabled features",
              "Enable feature"
            ],
            "summary": "Named lists that switch xPanel tools on or off for the plans that use them, with a preview of the resulting xPanel."
          },
          {
            "id": "account-enhancements",
            "name": "Account enhancements",
            "route": "/whm/plans/enhancements",
            "template": "list",
            "artboard": null,
            "primaryAction": "Assign enhancement",
            "roles": [
              "root"
            ],
            "tools": [
              "account-enhancements"
            ],
            "keywords": [
              "Account Enhancements",
              "Entitlements",
              "Add-on flags"
            ],
            "summary": "Entitlement flags assigned to accounts independently of their plan, with per-reseller caps."
          }
        ]
      },
      {
        "id": "resellers",
        "name": "Resellers",
        "icon": "Store",
        "pages": [
          {
            "id": "resellers",
            "name": "Resellers",
            "route": "/whm/resellers",
            "template": "list",
            "artboard": "WhmResellers",
            "primaryAction": "Add reseller",
            "roles": [
              "root"
            ],
            "tools": [
              "reseller-center"
            ],
            "keywords": [
              "Reseller Center",
              "Show Reseller Accounts",
              "View Reseller Usage and Manage Account Status",
              "Reseller limits",
              "Overselling",
              "Change Ownership of Multiple Accounts",
              "Package limits"
            ],
            "summary": "List resellers and create one with a username, password and the ACL flags that reseller may use."
          },
          {
            "id": "resellers-more",
            "name": "More reseller tools",
            "route": "/whm/resellers/more",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "show-reseller-accounts",
              "view-reseller-usage-and-account-status",
              "reseller-account-limits",
              "reseller-package-limits",
              "change-ownership-multiple-accounts"
            ],
            "keywords": [
              "Show Reseller Accounts",
              "Reseller limits"
            ],
            "summary": "Reseller usage, account lists, package limits and bulk ownership changes."
          },
          {
            "id": "reseller-privileges",
            "name": "Reseller privileges",
            "route": "/whm/resellers/privileges",
            "template": "matrix",
            "artboard": "WhmResellers",
            "primaryAction": "Save",
            "roles": [
              "root"
            ],
            "tools": [
              "reseller-privileges",
              "reseller-acl-lists",
              "reset-resellers"
            ],
            "keywords": [
              "Edit Reseller Nameservers and Privileges",
              "ACL",
              "Reseller ACL",
              "Manage Reseller ACL lists",
              "Saved privilege lists",
              "Reset Resellers"
            ],
            "summary": "Privilege matrix grouped by risk tier, saved privilege lists and applying a list to many resellers at once."
          },
          {
            "id": "reseller-ips-nameservers",
            "name": "IPs & nameservers",
            "route": "/whm/resellers/ips-nameservers",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root",
              "reseller:manage-dns"
            ],
            "tools": [
              "manage-reseller-ip-delegation",
              "manage-reseller-shared-ip",
              "reseller-nameservers"
            ],
            "keywords": [
              "Manage Reseller's IP Delegation",
              "Manage Reseller's Shared IP",
              "Reseller Nameservers",
              "Private nameservers"
            ],
            "summary": "Which IPs a reseller may hand out, the shared IP its accounts use and its own nameserver hostnames."
          }
        ]
      },
      {
        "id": "domains",
        "name": "Domains, DNS & SSL",
        "icon": "Globe",
        "pages": [
          {
            "id": "domains",
            "name": "Domains",
            "route": "/whm/domains",
            "template": "list",
            "artboard": "WhmDomains",
            "primaryAction": "Add alias domain",
            "roles": [
              "root",
              "reseller:manage-dns"
            ],
            "tools": [
              "aapanel-site-list",
              "aapanel-site-bulk-actions",
              "list-parked-domains",
              "list-subdomains",
              "park-domain",
              "domain-forwarding",
              "tweak-domains"
            ],
            "keywords": [
              "List Parked Domains",
              "List Subdomains",
              "Park a Domain",
              "Domain Forwarding",
              "Site List",
              "Website management",
              "Bulk site actions",
              "Domains (Tweak Settings)",
              "Addon domains"
            ],
            "summary": "Every site and domain on the server (primary, addon, alias, subdomain) with owner, delegation and certificate state, bulk site actions, alias domains, domain forwarding and the rules for which domains users may add."
          },
          {
            "id": "dns-zones",
            "name": "DNS zones",
            "route": "/whm/dns",
            "template": "editor",
            "artboard": "WhmDns",
            "primaryAction": "Add zone",
            "roles": [
              "root",
              "reseller:manage-dns"
            ],
            "tools": [
              "dns-zone-manager",
              "add-dns-zone",
              "delete-dns-zone"
            ],
            "keywords": [
              "Edit DNS Zone",
              "DNS Zone Manager",
              "Add a DNS Zone",
              "Delete a DNS Zone",
              "Set Zone Time to Live (TTL)",
              "Add an A Entry for Your Hostname",
              "Perform a DNS Cleanup",
              "DNSSEC",
              "Zone editor"
            ],
            "summary": "List, add, edit and delete DNS zones. Saving a zone reconciles it to the local PowerDNS server."
          },
          {
            "id": "dns-more",
            "name": "More DNS tools",
            "route": "/whm/dns/more",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root",
              "reseller:manage-dns"
            ],
            "tools": [
              "zone-ttl-bulk",
              "hostname-a-record",
              "dns-config-cleanup"
            ],
            "keywords": [
              "Set Zone Time to Live (TTL)",
              "DNS cleanup"
            ],
            "summary": "Bulk TTL, the hostname A record and nameserver cleanup."
          },
          {
            "id": "ssl-certificates",
            "name": "SSL certificates",
            "route": "/whm/ssl",
            "template": "list",
            "artboard": "WhmSsl",
            "primaryAction": "Run automatic SSL",
            "roles": [
              "root",
              "reseller:manage-ssl"
            ],
            "tools": [
              "auto-ssl",
              "ssl-hosts",
              "ssl-storage",
              "default-key-type"
            ],
            "keywords": [
              "Manage AutoSSL",
              "SSL/TLS",
              "Manage SSL Hosts",
              "SSL Storage Manager",
              "Default Key Type",
              "Certificate Manager",
              "Let's Encrypt",
              "AutoSSL"
            ],
            "summary": "Server-wide needs-action table of failing and expiring certificates, automatic certificate runs with preflight, installed SSL hosts, the key and certificate store and the default key type."
          },
          {
            "id": "install-ssl",
            "name": "Install certificate",
            "route": "/whm/ssl/install",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Install certificate",
            "roles": [
              "root",
              "reseller:manage-ssl"
            ],
            "tools": [
              "install-ssl",
              "generate-csr"
            ],
            "keywords": [
              "Install an SSL Certificate on a Domain",
              "Generate an SSL Certificate and Signing Request",
              "CSR",
              "Upload certificate"
            ],
            "summary": "Install a certificate, key and CA bundle on any domain or the hostname, or generate a key, self-signed certificate and CSR."
          },
          {
            "id": "cloudflare-dns-providers",
            "name": "Cloudflare & DNS providers",
            "route": "/whm/dns/providers",
            "template": "list",
            "artboard": "WhmCloudflare",
            "primaryAction": "Connect provider",
            "roles": [
              "root"
            ],
            "tools": [
              "cloudflare-integration",
              "aapanel-dns-provider-accounts",
              "aapanel-provider-domains",
              "aapanel-provider-dns-records",
              "aapanel-auto-dns-on-site-create"
            ],
            "keywords": [
              "Cloudflare",
              "Cloudflare integration",
              "CDN",
              "Proxy status",
              "SSL mode",
              "Cache purge",
              "Zone sync",
              "DNS Provider Accounts",
              "Domain management",
              "DNS API",
              "External DNS",
              "Provider Domains",
              "Provider DNS Records",
              "Automatic DNS on Site Creation"
            ],
            "summary": "Connect Cloudflare and other DNS providers by API: sync their zones and records, set the Cloudflare proxy, SSL mode and cache purge for accounts that opt in, limit what each connection may change, and create A records automatically when a site is created."
          },
          {
            "id": "dns-cluster",
            "name": "DNS cluster",
            "route": "/whm/dns/cluster",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Add cluster member",
            "roles": [
              "root"
            ],
            "tools": [
              "dns-cluster",
              "dns-cluster-sync",
              "nameserver-report"
            ],
            "keywords": [
              "DNS Cluster",
              "Configure Cluster",
              "Synchronize DNS Records",
              "Nameserver Record Report",
              "Nameservers"
            ],
            "summary": "Nameservers that share zone data, each member's sync role, record synchronisation and the nightly nameserver report."
          }
        ]
      },
      {
        "id": "email",
        "name": "Email",
        "icon": "Mail",
        "pages": [
          {
            "id": "mail-monitor",
            "name": "Mail monitor",
            "route": "/whm/email/monitor",
            "template": "dashboard",
            "artboard": "WhmMailMonitor",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "mail-monitor"
            ],
            "keywords": [
              "Mail monitor",
              "Mail Statistics Summary",
              "Mail flow",
              "Email statistics",
              "Top senders"
            ],
            "summary": "Live and summarised mail flow: accepted, delivered, deferred, bounced and rejected messages, queue size and top senders and hosts."
          },
          {
            "id": "mail-queue",
            "name": "Mail queue",
            "route": "/whm/email/queue",
            "template": "list",
            "artboard": "WhmMailQueue",
            "primaryAction": "Retry all",
            "roles": [
              "root"
            ],
            "tools": [
              "mail-queue-manager"
            ],
            "keywords": [
              "Mail Queue Manager",
              "Exim queue",
              "Frozen messages",
              "Deferred mail"
            ],
            "summary": "Messages waiting in the outbound queue with delete, retry and unfreeze."
          },
          {
            "id": "delivery-reports",
            "name": "Delivery reports",
            "route": "/whm/email/delivery",
            "template": "log",
            "artboard": null,
            "primaryAction": "Trace an address",
            "roles": [
              "root"
            ],
            "tools": [
              "mail-delivery-reports",
              "mail-troubleshooter"
            ],
            "keywords": [
              "Mail Delivery Reports",
              "Track Delivery",
              "Mail Troubleshooter",
              "Email route trace",
              "Send test message",
              "Admin Mail Viewer"
            ],
            "summary": "Search delivery history of mail sent and received on the server, and trace how an address routes to find the failing step."
          },
          {
            "id": "outbound-spam",
            "name": "Outbound spam protection",
            "route": "/whm/email/outbound",
            "template": "settings",
            "artboard": "WhmOutboundSpam",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "outbound-spam-protection",
              "view-sent-summary",
              "view-relayers",
              "smtp-restrictions"
            ],
            "keywords": [
              "Outbound spam protection",
              "View Sent Summary",
              "View Relayers",
              "SMTP Restrictions",
              "Max hourly emails",
              "Sending limits",
              "Compromised account"
            ],
            "summary": "Per-account and per-mailbox sending limits that hold suspicious mail, per-domain sent summaries, relayer reports and the rule that only the MTA may reach remote SMTP."
          },
          {
            "id": "inbound-spam",
            "name": "Inbound spam protection",
            "route": "/whm/email/spam",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "whm-greylisting",
              "incoming-mail-country-filter",
              "incoming-mail-domain-filter",
              "spam-daemon-startup"
            ],
            "keywords": [
              "Greylisting",
              "Filter Incoming Emails by Country",
              "Filter Incoming Emails by Domain",
              "Apache SpamAssassin",
              "spamd Startup Configuration",
              "Inbound spam"
            ],
            "summary": "Inbound protection for the whole server: greylisting with its timing and trusted senders, country and sender-domain blocks at SMTP time, and the spam scanner's daemon options."
          },
          {
            "id": "mail-quality",
            "name": "Mail quality",
            "route": "/whm/email/quality",
            "template": "dashboard",
            "artboard": "WhmMailQuality",
            "primaryAction": "Check again",
            "roles": [
              "root"
            ],
            "tools": [
              "mail-quality",
              "email-dns-records",
              "dkim-spf-bulk"
            ],
            "keywords": [
              "Email Deliverability",
              "Server-wide Email Deliverability",
              "DKIM",
              "SPF",
              "DMARC",
              "Reverse DNS",
              "Mail DNS Records",
              "Enable DKIM/SPF Globally",
              "Reputation"
            ],
            "summary": "Reputation and authentication health of every mail domain with repair, DMARC aggregate reports, spam-filter accuracy, and bulk DMARC and DKIM/SPF provisioning."
          },
          {
            "id": "mail-routing",
            "name": "Mail routing",
            "route": "/whm/email/routing",
            "template": "list",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root",
              "reseller:manage-dns"
            ],
            "tools": [
              "xwhm-email-routing"
            ],
            "keywords": [
              "Email Routing",
              "MX Entry",
              "Mail Domains",
              "Remote mail exchanger",
              "Backup MX"
            ],
            "summary": "Per-domain choice of whether this server accepts mail (auto, local, backup or remote) with MX editing."
          },
          {
            "id": "smtp-relay",
            "name": "SMTP relay",
            "route": "/whm/email/relay",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "smtp-relay"
            ],
            "keywords": [
              "SMTP relay",
              "Smarthost",
              "Outbound SMTP Relay",
              "Port 25 blocked"
            ],
            "summary": "Send outbound mail through an external relay for the whole server or chosen domains."
          },
          {
            "id": "mail-server",
            "name": "Mail server",
            "route": "/whm/email/server",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "mta-basic-editor",
              "mta-config-manager",
              "mailbox-server-config",
              "tweak-mail"
            ],
            "keywords": [
              "Exim Configuration Manager",
              "Mailserver Configuration",
              "Dovecot",
              "Mail Server Settings",
              "Mail (Tweak Settings)",
              "RBL",
              "Mail TLS"
            ],
            "summary": "The MTA's common and advanced options with backup and reset, IMAP/POP/LMTP daemon settings and server-wide mail limits and defaults."
          },
          {
            "id": "mailbox-maintenance",
            "name": "Mailbox maintenance",
            "route": "/whm/email/maintenance",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Repair permissions",
            "roles": [
              "root"
            ],
            "tools": [
              "mailbox-format-conversion",
              "repair-mailbox-permissions",
              "mailing-list-password-reset"
            ],
            "keywords": [
              "Mailbox Conversion",
              "Repair Mailbox Permissions",
              "Reset a Mailman Password",
              "maildir",
              "mdbox"
            ],
            "summary": "Repair jobs for mail storage: format conversion, ownership and mode repair, and resetting a mailing list's admin password."
          },
          {
            "id": "mail-bcc",
            "name": "Mail BCC copies",
            "route": "/whm/email/bcc",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-mail-bcc"
            ],
            "keywords": [
              "Mail BCC Copies",
              "BCC"
            ],
            "summary": "Server administrator BCC copy rules; unavailable until the capability and its task screen are qualified."
          },
          {
            "id": "mail-marketing",
            "name": "Mail campaigns & automation",
            "route": "/whm/email/marketing",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-mail-subscribers",
              "aapanel-mail-campaigns",
              "aapanel-mail-automation"
            ],
            "keywords": [
              "Mail Campaigns",
              "Templates",
              "Subscribers",
              "Suppression List",
              "Mail Automation Flows",
              "Welcome email"
            ],
            "summary": "Server administrator subscriber groups, suppression lists, campaigns and automation flows; unavailable until every capability and its task screen are qualified."
          }
        ]
      },
      {
        "id": "security",
        "name": "Security center",
        "icon": "ShieldCheck",
        "pages": [
          {
            "id": "security-advisor",
            "name": "Security advisor",
            "route": "/whm/security",
            "template": "dashboard",
            "artboard": "WhmSecurity",
            "primaryAction": "Check again",
            "roles": [
              "root"
            ],
            "tools": [
              "security-advisor"
            ],
            "keywords": [
              "Security Advisor",
              "Security Center",
              "Security Risk Scanner",
              "Security checks",
              "Hardening"
            ],
            "summary": "Security checks for the server and its sites, each finding with severity, why it matters and one fix button; accepted risks need a reason and expiry."
          },
          {
            "id": "firewall",
            "name": "Firewall",
            "route": "/whm/security/firewall",
            "template": "list",
            "artboard": "WhmFirewall",
            "primaryAction": "Add rule",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-firewall-switch",
              "aapanel-port-rules",
              "aapanel-ip-rules",
              "aapanel-region-rules",
              "aapanel-port-forward",
              "aapanel-icmp-block",
              "aapanel-firewall-import-export",
              "host-access-control"
            ],
            "keywords": [
              "System Firewall",
              "CSF",
              "ConfigServer Firewall",
              "Host Access Control",
              "nftables",
              "iptables",
              "Port rules",
              "IP rules",
              "Block country",
              "Region blocking",
              "Port forwarding",
              "Block ping",
              "Import rules",
              "Authorized IPs"
            ],
            "summary": "nftables default-deny firewall: port and IP rules, country blocks, port forwarding, ping, per-service access rules and JSON import/export, with the guard that refuses to lock out the current session."
          },
          {
            "id": "intrusion-detection",
            "name": "Intrusion detection",
            "route": "/whm/security/intrusion",
            "template": "list",
            "artboard": "WhmIntrusion",
            "primaryAction": "Check an address",
            "roles": [
              "root"
            ],
            "tools": [
              "intrusion-detection"
            ],
            "keywords": [
              "cPHulk Brute Force Protection",
              "Brute force",
              "CSF LFD",
              "Login Failure Daemon",
              "fail2ban",
              "Panel Login Lockout",
              "Blocked IPs",
              "Why is this IP blocked",
              "Ban list",
              "Brute Force Protection",
              "Brute-Force Protection",
              "Log-Based Intrusion Ban"
            ],
            "summary": "Watches login failures across SSH, FTP, mail, the panel and web logins and bans attackers by IP, with allow and deny lists, country rules, history and the why-is-this-IP-blocked lookup."
          },
          {
            "id": "flood-protection",
            "name": "Flood protection",
            "route": "/whm/security/flood",
            "template": "settings",
            "artboard": "WhmFlood",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "flood-protection"
            ],
            "keywords": [
              "Connection limits",
              "CSF CT_LIMIT",
              "Port flood",
              "SYN flood",
              "ICMP flood",
              "DDoS protection",
              "Rate limiting"
            ],
            "summary": "Connection limits per address and per port, new-connection rate limits and SYN and ICMP flood protection."
          },
          {
            "id": "waf",
            "name": "Web application firewall",
            "route": "/whm/security/waf",
            "template": "settings",
            "artboard": "WhmWaf",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "waf-settings",
              "waf-rules",
              "waf-vendors"
            ],
            "keywords": [
              "ModSecurity",
              "ModSecurity Configuration",
              "ModSecurity Tools",
              "ModSecurity Vendors",
              "OWASP CRS",
              "Core Rule Set",
              "WAF",
              "Rule hits"
            ],
            "summary": "ModSecurity engine options, OWASP CRS and other vendor rule sets with auto-update, custom rules with staged deployment and the hit history."
          },
          {
            "id": "account-isolation",
            "name": "Account isolation",
            "route": "/whm/security/isolation",
            "template": "list",
            "artboard": "WhmIsolation",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "account-isolation",
              "manage-shell-access",
              "fork-bomb-protection",
              "compiler-access",
              "traceroute-toggle",
              "userdir-protection"
            ],
            "keywords": [
              "CageFS",
              "Account isolation",
              "Manage Shell Access",
              "Jailed shell",
              "Shell Fork Bomb Protection",
              "Compiler Access",
              "Compilers Tweak",
              "Traceroute",
              "Apache mod_userdir Tweak",
              "Private /tmp",
              "Compiler Access Control"
            ],
            "summary": "What each account can see and run: filesystem isolation and private /tmp, shell mode (off, jailed, normal), process limits for shells, and restricted compilers, traceroute and /~user URLs."
          },
          {
            "id": "antivirus",
            "name": "Antivirus",
            "route": "/whm/security/antivirus",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Start scan",
            "roles": [
              "root"
            ],
            "tools": [
              "antivirus-scanner-config",
              "aapanel-clamav"
            ],
            "keywords": [
              "ClamAV",
              "Configure ClamAV Scanner",
              "Antivirus Scanner",
              "Malware scan",
              "Virus scanner",
              "Quarantine"
            ],
            "summary": "What the virus scanner may scan globally and per user, on-demand scans and the quarantine."
          },
          {
            "id": "ssh",
            "name": "SSH",
            "route": "/whm/security/ssh",
            "template": "settings",
            "artboard": "WhmSsh",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-ssh-settings",
              "root-ssh-keys",
              "aapanel-ssh-service",
              "aapanel-ssh-login-logs",
              "aapanel-ssh-login-alarm",
              "change-root-password",
              "wheel-group-users",
              "sudo-group-users"
            ],
            "keywords": [
              "Manage root's SSH Keys",
              "SSH Password Authorization Tweak",
              "SSH Login Settings",
              "Change Root Password",
              "Manage Wheel Group Users",
              "sudo",
              "SSH port",
              "Root login",
              "SSH login log",
              "SSH login alert",
              "SSH Password Login",
              "Root Password and Key",
              "Panel Username and Password"
            ],
            "summary": "Root access to the server: SSH port, password and key login, root login policy, root keys, root password, wheel/sudo members, the login log and root-login alerts."
          },
          {
            "id": "panel-access",
            "name": "Panel access",
            "route": "/whm/security/panel-access",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-panel-port",
              "aapanel-security-entrance",
              "aapanel-unauth-response",
              "aapanel-panel-domain",
              "aapanel-basic-auth",
              "aapanel-subpanel-service",
              "tweak-security",
              "tweak-redirection",
              "aapanel-temporary-login",
              "aapanel-recovery-cli"
            ],
            "keywords": [
              "Panel Port",
              "Security Entrance",
              "Panel domain binding",
              "BasicAuth",
              "Session timeout",
              "Security (Tweak Settings)",
              "Redirection (Tweak Settings)",
              "Temporary login",
              "Recovery commands",
              "Unauthenticated response",
              "Panel lockout recovery",
              "Session Timeout and Binding"
            ],
            "summary": "How the panels are reached: ports, secret entrance path, bound domains, basic auth, session and transport hardening, shortcut URL redirects, time-limited helper links and the root commands that undo a lockout."
          },
          {
            "id": "sign-in",
            "name": "Sign-in & 2FA",
            "route": "/whm/security/sign-in",
            "template": "settings",
            "artboard": "WhmSecurity",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "security-policies",
              "password-strength",
              "xwhm-two-factor-auth",
              "security-questions",
              "external-authentication"
            ],
            "keywords": [
              "Security Policies",
              "Password Strength Configuration",
              "Two-Factor Authentication",
              "2FA",
              "Security Questions",
              "Manage External Authentications",
              "OpenID Connect",
              "Password policy",
              "Password age",
              "Password Policy",
              "Panel Two-Factor Authentication"
            ],
            "summary": "Who may sign in and how: password rules and age, two-factor policy and enrolments, verified-IP security questions and external identity providers."
          }
        ]
      },
      {
        "id": "monitoring",
        "name": "Monitoring",
        "icon": "Activity",
        "pages": [
          {
            "id": "server-health",
            "name": "Server health",
            "route": "/whm/monitoring/health",
            "template": "dashboard",
            "artboard": "WhmServerHealth",
            "primaryAction": "Check again",
            "roles": [
              "root"
            ],
            "tools": [
              "server-health"
            ],
            "keywords": [
              "Server health",
              "Health checks",
              "System Health",
              "Status"
            ],
            "summary": "One page of host health checks, each with status, evidence and a fix."
          },
          {
            "id": "alerts",
            "name": "Alerts",
            "route": "/whm/monitoring/alerts",
            "template": "list",
            "artboard": "WhmAlerts",
            "primaryAction": "Create rule",
            "roles": [
              "root"
            ],
            "tools": [
              "alert-rules"
            ],
            "keywords": [
              "Alerts",
              "Alert rules",
              "Service down",
              "Thresholds",
              "Maintenance window",
              "chkservd notifications"
            ],
            "summary": "Turn health checks, service failures, security events and limits into deduplicated notifications, with maintenance windows."
          },
          {
            "id": "repair-center",
            "name": "Repair center",
            "route": "/whm/monitoring/repair",
            "template": "custom",
            "artboard": "WhmRepair",
            "primaryAction": "Scan now",
            "roles": [
              "root"
            ],
            "tools": [
              "server-repair"
            ],
            "keywords": [
              "Repair",
              "Fix",
              "Broken packages",
              "dpkg",
              "apt",
              "dnf",
              "Disk full",
              "Service will not start",
              "Self-repair",
              "Doctor"
            ],
            "summary": "Scan for common server problems and fix each one with a preview, a job log and a verification step."
          },
          {
            "id": "performance-history",
            "name": "Performance history",
            "route": "/whm/monitoring/performance",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-system-monitor"
            ],
            "keywords": [
              "System Monitor",
              "Load history",
              "CPU graph",
              "Memory graph",
              "Network graph",
              "Monitor",
              "Server monitor"
            ],
            "summary": "Recorded load, CPU, memory, disk IO and network history charted over time."
          },
          {
            "id": "traffic-monitor",
            "name": "Traffic monitor",
            "route": "/whm/monitoring/traffic",
            "template": "dashboard",
            "artboard": "WhmTraffic",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "traffic-monitor"
            ],
            "keywords": [
              "Traffic monitor",
              "Live traffic",
              "Bandwidth live",
              "Nginx traffic",
              "Top domains",
              "Requests per second"
            ],
            "summary": "Live and historical HTTP and network traffic per server, account and domain."
          },
          {
            "id": "io-monitor",
            "name": "IO monitor",
            "route": "/whm/monitoring/io",
            "template": "dashboard",
            "artboard": "WhmIo",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "io-monitor"
            ],
            "keywords": [
              "IO monitor",
              "Disk IO",
              "IOPS",
              "iotop",
              "I/O usage",
              "IO throttling"
            ],
            "summary": "Per-account disk IO bandwidth, IOPS and throttling from each slice, with the processes behind it."
          },
          {
            "id": "resource-limits",
            "name": "Resource limits",
            "route": "/whm/monitoring/limits",
            "template": "list",
            "artboard": "WhmResourceLimits",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "resource-limits-manager"
            ],
            "keywords": [
              "Resource limits manager",
              "LVE Manager",
              "CloudLinux limits",
              "CPU limits",
              "Memory limits",
              "Faults",
              "Account slices",
              "Limit hits"
            ],
            "summary": "Every account slice: applied CPU, memory, process and IO limits with their source, current usage, fault counts and history."
          },
          {
            "id": "processes",
            "name": "Processes",
            "route": "/whm/monitoring/processes",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "process-manager",
              "daily-process-log",
              "background-process-killer"
            ],
            "keywords": [
              "Process Manager",
              "Show Current Running Processes",
              "Daily Process Log",
              "Background Process Killer",
              "top",
              "kill process",
              "Running Processes Snapshot"
            ],
            "summary": "Running processes as a list or tree with kill and trace, per-user daily averages, and the nightly killer for forbidden background programs."
          },
          {
            "id": "disk-usage",
            "name": "Disk usage",
            "route": "/whm/monitoring/disk",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "current-disk-usage"
            ],
            "keywords": [
              "Show Current Disk Usage",
              "df",
              "Filesystems",
              "Disk space"
            ],
            "summary": "Size, used and free space of every mounted filesystem with IO statistics."
          },
          {
            "id": "logs",
            "name": "Logs",
            "route": "/whm/monitoring/logs",
            "template": "log",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-os-log-audit",
              "aapanel-software-logs",
              "aapanel-log-security-analysis",
              "raw-apache-log-download",
              "raw-nginx-log-download",
              "raw-ftp-log-download",
              "web-log-retention",
              "panel-log-rotation",
              "tweak-stats-logs",
              "web-stats-engines",
              "aapanel-log-cleanup"
            ],
            "keywords": [
              "OS Log Audit",
              "Service Logs",
              "Slow query log",
              "FTP logs",
              "Access log security analysis",
              "Raw Apache Log Download",
              "Raw NGINX Log Download",
              "Raw FTP Log Download",
              "Web Log Retention",
              "cPanel Log Rotation Configuration",
              "Stats and Logs (Tweak Settings)",
              "Statistics Software Configuration",
              "Log Cleanup",
              "Website Log Usage",
              "Stats Program Toggles"
            ],
            "summary": "Server and service logs in one browser (OS, FTP activity, database slow and error logs), attack-pattern scans across every site's access logs, raw per-domain downloads, retention, rotation, statistics processing and cleanup."
          },
          {
            "id": "server-information",
            "name": "Server information",
            "route": "/whm/monitoring/server-info",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": "Run benchmark",
            "roles": [
              "root"
            ],
            "tools": [
              "server-information"
            ],
            "keywords": [
              "Server Information",
              "Hardware",
              "Performance Benchmark",
              "CPU benchmark",
              "Disk benchmark"
            ],
            "summary": "Load average, memory and root filesystem space on this server."
          },
          {
            "id": "performance-benchmark",
            "name": "Performance benchmark",
            "route": "/whm/monitoring/benchmark",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": "Run benchmark",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-performance-test"
            ],
            "keywords": [
              "Performance Benchmark",
              "CPU benchmark"
            ],
            "summary": "CPU, disk and network benchmarks."
          }
        ]
      },
      {
        "id": "services",
        "name": "Services",
        "icon": "ServerCog",
        "pages": [
          {
            "id": "services",
            "name": "Services",
            "route": "/whm/services",
            "template": "list",
            "artboard": "WhmServices",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "restart-web",
              "restart-mta",
              "restart-imap",
              "restart-dns",
              "restart-mysql",
              "restart-ftp"
            ],
            "keywords": [
              "Service Manager",
              "Service Status",
              "Restart Services",
              "Installed Services",
              "Startup Items",
              "Process Supervisor",
              "Graceful Server Reboot",
              "Forceful Server Reboot",
              "systemctl"
            ],
            "summary": "Status and restart for Apache, MariaDB, Postfix, Dovecot, pure-ftpd and PowerDNS."
          },
          {
            "id": "services-more",
            "name": "More service tools",
            "route": "/whm/services/more",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "service-manager",
              "restart-php-fpm",
              "restart-postgresql",
              "restart-ssh",
              "restart-mailing-lists",
              "aapanel-boot-items",
              "aapanel-supervisor",
              "system-reboot",
              "service-watchdog"
            ],
            "keywords": [
              "Service Manager",
              "Server reboot"
            ],
            "summary": "The wider service manager, startup items, supervised processes and server reboot."
          },
          {
            "id": "web-server",
            "name": "Web server",
            "route": "/whm/services/web",
            "template": "settings",
            "artboard": "WhmWebServer",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "web-stack-builder",
              "apache-global-config",
              "nginx-proxy-manager",
              "aapanel-openlitespeed-manager",
              "directory-index-priority",
              "web-config-includes",
              "process-memory-limit",
              "web-log-rotation",
              "piped-logging",
              "web-server-status",
              "aapanel-default-site",
              "aapanel-https-protection"
            ],
            "keywords": [
              "EasyApache 4",
              "Apache Configuration",
              "Global Configuration",
              "Include Editor",
              "DirectoryIndex Priority",
              "Memory Usage Restrictions",
              "Log Rotation",
              "Piped Log Configuration",
              "Apache Status",
              "NGINX Manager",
              "Nginx cache",
              "OpenLiteSpeed",
              "Web Server Selection",
              "Default Site",
              "Website Acceleration Cache",
              "Web Server Configuration Hub",
              "Web Server Manager (Apache)",
              "Web Server Manager (Nginx family)"
            ],
            "summary": "Nginx edge and Apache (mpm-itk) or OpenLiteSpeed: the web stack profile, global directives, includes, index priority, process memory, logging, cache, default site and status, all through review and apply."
          },
          {
            "id": "config-health",
            "name": "Configuration health",
            "route": "/whm/services/health",
            "template": "list",
            "artboard": "WhmConfigHealth",
            "primaryAction": "Check again",
            "roles": [
              "root"
            ],
            "tools": [
              "service-config-health"
            ],
            "keywords": [
              "Service configuration health",
              "Config check",
              "Configuration drift",
              "Baseline",
              "nginx -t",
              "apachectl configtest",
              "Config drift",
              "Desired state"
            ],
            "summary": "Checks every service's live configuration files against the panel's records and a security baseline, shows each drift with the file and line, and fixes it through Review & apply."
          },
          {
            "id": "ftp-server",
            "name": "FTP server",
            "route": "/whm/services/ftp",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "ftp-server-selection",
              "ftp-server-config"
            ],
            "keywords": [
              "FTP Server Selection",
              "FTP Server Configuration",
              "FTP Server Management",
              "Pure-FTPd",
              "ProFTPD",
              "FTP port",
              "FTP Service Port"
            ],
            "summary": "Which FTP daemon runs (or none), its port, TLS, anonymous access and connection limits."
          },
          {
            "id": "dns-server",
            "name": "DNS server",
            "route": "/whm/services/dns",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "nameserver-selection"
            ],
            "keywords": [
              "Nameserver Selection",
              "PowerDNS",
              "BIND",
              "Self-Hosted DNS Server",
              "Authoritative DNS"
            ],
            "summary": "Chooses the authoritative DNS daemon or disables DNS on this server."
          },
          {
            "id": "service-certificates",
            "name": "Service certificates",
            "route": "/whm/services/certificates",
            "template": "list",
            "artboard": null,
            "primaryAction": "Install certificate",
            "roles": [
              "root"
            ],
            "tools": [
              "service-ssl-certificates",
              "panel-web-tls",
              "webdisk-tls"
            ],
            "keywords": [
              "Manage Service SSL Certificates",
              "Panel SSL",
              "Hostname certificate",
              "TLS Cipher Suites",
              "Web Disk TLS",
              "cpsrvd TLS"
            ],
            "summary": "Certificates and TLS protocol and cipher lists for the panels, webmail, mail, FTP and Web Disk services."
          },
          {
            "id": "ftp-log-analysis",
            "name": "FTP log analysis",
            "route": "/whm/services/ftp-log-analysis",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-ftp-logs"
            ],
            "keywords": [
              "FTP Logs",
              "FTP log analysis",
              "FTP activity"
            ],
            "summary": "Server administrator FTP activity and log analysis; unavailable until the capability and its task screen are qualified."
          },
          {
            "id": "default-index",
            "name": "Default index files",
            "route": "/whm/services/default-index",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-default-index"
            ],
            "keywords": [
              "Default Index Files",
              "DirectoryIndex",
              "index.php",
              "index.html"
            ],
            "summary": "Server administrator ordering of default index filenames; unavailable until the capability and its task screen are qualified."
          }
        ]
      },
      {
        "id": "backups",
        "name": "Backups & transfers",
        "icon": "ArchiveRestore",
        "pages": [
          {
            "id": "backups",
            "name": "Backups",
            "route": "/whm/backups",
            "template": "settings",
            "artboard": "WhmBackups",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "backup-config",
              "backup-user-selection",
              "tweak-compression"
            ],
            "keywords": [
              "Backup Configuration",
              "Backup User Selection",
              "Mail Store Backup",
              "Compression (Tweak Settings)",
              "pigz",
              "Backup schedule"
            ],
            "summary": "Scheduled backup policy (type, timing, retention, contents, database mode), which accounts are included, compression and per-account restore points."
          },
          {
            "id": "backup-destinations",
            "name": "Backup destinations",
            "route": "/whm/backups/destinations",
            "template": "list",
            "artboard": "WhmBackups",
            "primaryAction": "Add destination",
            "roles": [
              "root"
            ],
            "tools": [
              "backup-destinations"
            ],
            "keywords": [
              "Additional Destinations",
              "Remote Backup Destinations",
              "S3",
              "SFTP",
              "FTP backup",
              "Cloud storage"
            ],
            "summary": "Local and remote targets that receive backup files, with validation and send test."
          },
          {
            "id": "restore-accounts",
            "name": "Restore accounts",
            "route": "/whm/backups/restore",
            "template": "wizard",
            "artboard": "WhmRestore",
            "primaryAction": "Restore account",
            "roles": [
              "root"
            ],
            "tools": [
              "backup-restoration"
            ],
            "keywords": [
              "Backup Restoration",
              "Restore a Full Backup/cpmove File",
              "Transfer or Restore a cPanel Account",
              "Restore account"
            ],
            "summary": "Create an account archive in the local backup directory and restore that archive into the account home."
          },
          {
            "id": "restore-more",
            "name": "More restore tools",
            "route": "/whm/backups/restore-more",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "transfer-or-restore-account",
              "account-restore-progress"
            ],
            "keywords": [
              "Transfer or Restore a cPanel Account"
            ],
            "summary": "Remote account transfer and restore progress for archives this server did not create."
          },
          {
            "id": "restore-files",
            "name": "Restore files",
            "route": "/whm/backups/files",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Restore files",
            "roles": [
              "root"
            ],
            "tools": [
              "file-restore"
            ],
            "keywords": [
              "File and Directory Restoration",
              "Restore file",
              "Restore folder"
            ],
            "summary": "Restore single files or folders of an account from local backups."
          },
          {
            "id": "transfer-tool",
            "name": "Transfer tool",
            "route": "/whm/transfers",
            "template": "wizard",
            "artboard": "WhmTransfer",
            "primaryAction": "Start transfer",
            "roles": [
              "root"
            ],
            "tools": [
              "transfer-tool",
              "transfer-tool-selection",
              "live-transfer",
              "account-transfer-progress",
              "review-transfers-and-restores"
            ],
            "keywords": [
              "Transfer Tool",
              "Review Transfers and Restores",
              "Live Transfer",
              "Import from another panel",
              "cPanel import",
              "One-click migration",
              "Site Migration",
              "Site Migration to Another Server",
              "Import from Another Panel"
            ],
            "summary": "Connect to a source server, select accounts, plans and service settings with conflicts found up front, run with live per-account progress and review past sessions."
          },
          {
            "id": "convert-addon",
            "name": "Convert addon domain",
            "route": "/whm/transfers/convert-addon",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Convert domain",
            "roles": [
              "root"
            ],
            "tools": [
              "convert-addon-to-account"
            ],
            "keywords": [
              "Convert Addon Domain to Account",
              "Split account"
            ],
            "summary": "Turn an addon domain into its own account, copying or moving its site, mail, DNS, databases and sub-accounts."
          },
          {
            "id": "server-migration",
            "name": "Server migration",
            "route": "/whm/transfers/server",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Start migration",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-server-migrate"
            ],
            "keywords": [
              "Whole-Server Migration",
              "Server move",
              "Move to new server"
            ],
            "summary": "Back up this whole server and restore it onto a fresh server, installing the panel there."
          }
        ]
      },
      {
        "id": "databases",
        "name": "Databases",
        "icon": "Database",
        "pages": [
          {
            "id": "databases",
            "name": "Databases",
            "route": "/whm/databases",
            "template": "list",
            "artboard": "WhmDatabases",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "databases-admin",
              "db-ownership-map",
              "aapanel-db-quota",
              "db-repair"
            ],
            "keywords": [
              "Manage Databases",
              "Database Map Tool",
              "Repair a MySQL Database",
              "Database quota",
              "Sync database inventory",
              "Table maintenance",
              "MySQL Databases",
              "Sync Database Inventory"
            ],
            "summary": "Every customer database on the service engines with engine, owner, size limit, safe rename, repair and assigning orphaned databases to an account."
          },
          {
            "id": "database-users",
            "name": "Database users",
            "route": "/whm/databases/users",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "db-users-admin",
              "db-access-hosts"
            ],
            "keywords": [
              "Manage Database Users",
              "Change MySQL User Password",
              "Additional MySQL Access Hosts",
              "Remote MySQL hosts",
              "Bulk password change",
              "Bulk Database Password Change",
              "Change Database User Password"
            ],
            "summary": "Every database user with rename and password reset (one or many), plus the remote hosts granted server-wide access."
          },
          {
            "id": "phpmyadmin",
            "name": "phpMyAdmin",
            "route": "/whm/databases/phpmyadmin",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Open phpMyAdmin",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-phpmyadmin-access"
            ],
            "keywords": [
              "phpMyAdmin",
              "Web SQL client",
              "phpPgAdmin",
              "Database browser"
            ],
            "summary": "Open the web database client as root and control its exposure: public access, port, password protection and PHP version."
          },
          {
            "id": "database-tuning",
            "name": "Database tuning",
            "route": "/whm/databases/tuning",
            "template": "settings",
            "artboard": "WhmDbTuning",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "database-tuning"
            ],
            "keywords": [
              "Edit Database Configuration",
              "Database Server Configuration",
              "MySQL tuner",
              "my.cnf",
              "postgresql.conf"
            ],
            "summary": "Analyses MariaDB and PostgreSQL on this host and recommends, previews and applies tunables, with ranges and the restart it needs."
          },
          {
            "id": "database-processes",
            "name": "Database processes",
            "route": "/whm/databases/processes",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "db-process-list"
            ],
            "keywords": [
              "Show MySQL Processes",
              "Process list",
              "Running queries",
              "Connections"
            ],
            "summary": "Current database connections and statements on the server."
          },
          {
            "id": "database-servers",
            "name": "Database servers",
            "route": "/whm/databases/servers",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Add server profile",
            "roles": [
              "root"
            ],
            "tools": [
              "db-server-profiles",
              "db-root-password",
              "postgresql-setup",
              "aapanel-mysql-service",
              "aapanel-postgresql-service",
              "tweak-sql"
            ],
            "keywords": [
              "Manage MySQL Profiles",
              "MySQL Root Password",
              "Configure PostgreSQL",
              "Remote MySQL",
              "Remote Database Servers",
              "MySQL Server Management",
              "PostgreSQL Server Management",
              "SQL (Tweak Settings)",
              "Database Root Password"
            ],
            "summary": "The customer database engines only (local and remote profiles, MariaDB and PostgreSQL daemons, superuser passwords, naming prefix and accounting policy); the panel's own data store is not managed here."
          },
          {
            "id": "database-upgrade",
            "name": "Database upgrade",
            "route": "/whm/databases/upgrade",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Start upgrade",
            "roles": [
              "root"
            ],
            "tools": [
              "db-engine-upgrade"
            ],
            "keywords": [
              "MySQL/MariaDB Upgrade",
              "MariaDB upgrade",
              "Engine upgrade"
            ],
            "summary": "Guided MySQL or MariaDB upgrade with pre-checks, acknowledgements and a live log, run as a job."
          },
          {
            "id": "redis",
            "name": "Redis",
            "route": "/whm/databases/redis",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-redis-service",
              "aapanel-redis-keys"
            ],
            "keywords": [
              "Redis",
              "Key-value store",
              "Key-Value Store Browser",
              "Object cache"
            ],
            "summary": "The shared key-value service: version, configuration, password, memory limit, persistence and a key browser per logical database."
          },
          {
            "id": "mongodb",
            "name": "MongoDB",
            "route": "/whm/databases/mongodb",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Create database",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-mongodb",
              "aapanel-mongodb-service"
            ],
            "keywords": [
              "MongoDB",
              "Document database",
              "MongoDB Databases"
            ],
            "summary": "Optional document database: service control, configuration, logs, authentication and its databases and users."
          }
        ]
      },
      {
        "id": "software",
        "name": "Software",
        "icon": "Boxes",
        "pages": [
          {
            "id": "php",
            "name": "PHP",
            "route": "/whm/software/php",
            "template": "list",
            "artboard": "WhmPhp",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "php-manager-system",
              "php-manager-domains",
              "php-ini-editor",
              "php-fpm-service",
              "aapanel-php-guardian"
            ],
            "keywords": [
              "MultiPHP Manager",
              "MultiPHP INI Editor",
              "PHP Version Manager",
              "PHP-FPM",
              "Command-Line PHP Version",
              "PHP Worker Guardian",
              "php.ini",
              "Select PHP Version"
            ],
            "summary": "Installed PHP versions and the system default, per-domain version and handler, php.ini per version, PHP-FPM pool defaults and the guardian that restarts unhealthy pools."
          },
          {
            "id": "app-runtimes",
            "name": "App runtimes",
            "route": "/whm/software/runtimes",
            "template": "list",
            "artboard": "WhmRuntimes",
            "primaryAction": "Install version",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-nodejs-versions",
              "aapanel-python-versions",
              "aapanel-go-sdk"
            ],
            "keywords": [
              "Node.js Version Manager",
              "Python Versions",
              "Go SDK Manager",
              "Application Manager",
              "Setup Node.js App",
              "Setup Python App",
              "nvm"
            ],
            "summary": "Node.js, Python and Go versions available to account applications, with global modules and base virtual environments."
          },
          {
            "id": "software-catalog",
            "name": "Software center",
            "route": "/whm/software/catalog",
            "template": "list",
            "artboard": "WhmSoftwareCenter",
            "primaryAction": "Import plugin",
            "roles": [
              "root"
            ],
            "tools": [
              "software-center",
              "aapanel-app-catalog",
              "aapanel-third-party-plugin-import"
            ],
            "keywords": [
              "App Store",
              "Software Catalog",
              "Manage Plugins",
              "Server plugins",
              "Install plugin",
              "FFmpeg",
              "Media toolkit",
              "Software center",
              "Install Redis",
              "Install Memcached",
              "Runtimes",
              "App store",
              "Server Plugins",
              "Media Toolkit Installer"
            ],
            "summary": "Installable server software and plugins with install, update, settings and uninstall, plus importing an uploaded plugin package."
          },
          {
            "id": "site-software",
            "name": "Site software",
            "route": "/whm/software/site-software",
            "template": "list",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "root"
            ],
            "tools": [
              "site-software-catalog",
              "site-software-instances"
            ],
            "keywords": [
              "Site Software",
              "Softaculous",
              "One-click installer",
              "Installed Site Software",
              "WordPress installer"
            ],
            "summary": "Which web applications users may install, and every installed instance with upgrade and remove."
          },
          {
            "id": "module-installers",
            "name": "Module installers",
            "route": "/whm/software/modules",
            "template": "list",
            "artboard": null,
            "primaryAction": "Install module",
            "roles": [
              "root"
            ],
            "tools": [
              "module-installers",
              "xwhm-perl-modules",
              "pear-packages",
              "pecl-extensions"
            ],
            "keywords": [
              "Module Installers",
              "Perl Modules",
              "CPAN",
              "PHP PEAR Packages",
              "PHP PECL",
              "Ruby gems"
            ],
            "summary": "Perl, PEAR and PECL modules per runtime: search, install, update, reinstall and remove."
          },
          {
            "id": "addon-services",
            "name": "Add-on services",
            "route": "/whm/software/addon-services",
            "template": "list",
            "artboard": null,
            "primaryAction": "Install service",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-memcached-manager",
              "aapanel-elasticsearch-manager",
              "aapanel-rabbitmq-manager"
            ],
            "keywords": [
              "Memcached",
              "Elasticsearch",
              "Search engine service",
              "RabbitMQ",
              "Message queue"
            ],
            "summary": "Optional shared services from the catalog: memory cache, search engine and message broker, each with service control and configuration."
          },
          {
            "id": "containers",
            "name": "Containers",
            "route": "/whm/software/containers",
            "template": "list",
            "artboard": "WhmContainers",
            "primaryAction": "Create container",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-docker-overview",
              "aapanel-docker-containers",
              "aapanel-docker-container-detail",
              "aapanel-docker-apps",
              "aapanel-docker-compose"
            ],
            "keywords": [
              "Docker",
              "Containers",
              "Docker Compose",
              "One-Click Container Apps",
              "Container stacks",
              "Container resource usage"
            ],
            "summary": "Containers and compose stacks with resource usage, one-click container apps and a page per container."
          },
          {
            "id": "container-engine",
            "name": "Container engine",
            "route": "/whm/software/containers/engine",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Pull image",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-docker-images",
              "aapanel-docker-registries",
              "aapanel-docker-networks",
              "aapanel-docker-volumes",
              "aapanel-docker-settings"
            ],
            "keywords": [
              "Docker images",
              "Image registries",
              "Docker networks",
              "Docker volumes",
              "Docker daemon",
              "Container Engine Settings"
            ],
            "summary": "Images, private registries, networks, volumes and the container daemon's own settings."
          },
          {
            "id": "system-updates",
            "name": "System updates",
            "route": "/whm/software/updates",
            "template": "custom",
            "artboard": "WhmUpdates",
            "primaryAction": "Update system",
            "roles": [
              "root"
            ],
            "tools": [
              "os-update",
              "server-software-update",
              "distro-packages",
              "package-db-rebuild"
            ],
            "keywords": [
              "System Update",
              "Update Server Software",
              "Install an RPM",
              "OS Package Installer",
              "Rebuild RPM Database",
              "apt",
              "dnf",
              "Kernel update"
            ],
            "summary": "Operating-system updates with or without the kernel, panel dependency updates, package installs from configured repositories and package database repair, run as jobs."
          },
          {
            "id": "application-deployments",
            "name": "Application deployments",
            "route": "/whm/software/deployments",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-one-click-deploy"
            ],
            "keywords": [
              "One-Click App Deploy",
              "Server app deployment"
            ],
            "summary": "Server administrator application deployment; unavailable until the capability and its task screen are qualified."
          },
          {
            "id": "application-projects",
            "name": "Go & Java projects",
            "route": "/whm/software/application-projects",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-go-project",
              "aapanel-java-project"
            ],
            "keywords": [
              "Go Projects",
              "Java Projects"
            ],
            "summary": "Server administrator Go and Java projects; unavailable until both capabilities and their task screen are qualified."
          },
          {
            "id": "composer",
            "name": "Composer",
            "route": "/whm/software/composer",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-composer"
            ],
            "keywords": [
              "Composer",
              "composer install",
              "composer update"
            ],
            "summary": "Server administrator Composer package operations; unavailable until the capability and its task screen are qualified."
          }
        ]
      },
      {
        "id": "server",
        "name": "Server",
        "icon": "Server",
        "pages": [
          {
            "id": "terminal",
            "name": "Terminal",
            "route": "/whm/server/terminal",
            "template": "custom",
            "artboard": "WhmTerminal",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "root-web-terminal",
              "aapanel-web-terminal",
              "aapanel-saved-commands"
            ],
            "keywords": [
              "Terminal",
              "Web SSH Terminal",
              "Root shell",
              "Console",
              "Saved commands",
              "Remote SSH hosts"
            ],
            "summary": "Browser root shell on this server, saved remote SSH hosts and a library of one-click commands."
          },
          {
            "id": "file-sharing",
            "name": "File sharing links",
            "route": "/whm/server/file-sharing",
            "template": "list",
            "artboard": "TemplateList",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-file-share"
            ],
            "keywords": [
              "Share link",
              "File Sharing Links",
              "Directory sharing",
              "مشاركة الملفات"
            ],
            "summary": "Server administrator management of file and directory sharing links; unavailable until the capability and its task screen are qualified."
          },
          {
            "id": "setup",
            "name": "Setup & settings",
            "route": "/whm/server/setup",
            "template": "settings",
            "artboard": "WhmSetup",
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "initial-setup-wizard",
              "basic-server-setup",
              "advanced-settings-browser",
              "tweak-system",
              "disk-quota-setup",
              "aapanel-linux-tools"
            ],
            "keywords": [
              "Tweak Settings",
              "Initial Setup Assistant",
              "Basic WebHost Manager Setup",
              "Initial Quota Setup",
              "All settings",
              "System (Tweak Settings)",
              "Time zone",
              "Swap",
              "Hosts file",
              "Account Storage Disks",
              "Linux System Tools"
            ],
            "summary": "First-run wizard, contacts, shared IPs, home roots, default nameservers and TTLs, disk quotas, OS basics, and the searchable index of every server setting with its on-disk value and default."
          },
          {
            "id": "networking",
            "name": "Networking",
            "route": "/whm/server/networking",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "change-hostname",
              "resolver-configuration",
              "aapanel-ddns",
              "aapanel-frp-manager"
            ],
            "keywords": [
              "Change Hostname",
              "Resolver Configuration",
              "Dynamic DNS Updater",
              "Reverse Tunnel Manager",
              "FRP",
              "Nameservers resolv.conf"
            ],
            "summary": "Server hostname, recursive resolvers, dynamic DNS for the server's own name and reverse tunnels."
          },
          {
            "id": "ip-addresses",
            "name": "IP addresses",
            "route": "/whm/server/ips",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add IP address",
            "roles": [
              "root"
            ],
            "tools": [
              "ip-addresses-list",
              "add-ip",
              "ipv6-ranges",
              "assign-ipv6",
              "reserved-ips",
              "rebuild-ip-pool",
              "ip-usage-report",
              "change-site-ip",
              "change-multiple-sites-ip",
              "remote-service-ips",
              "ip-migration-wizard"
            ],
            "keywords": [
              "Show or Delete Current IP Addresses",
              "Add a New IP Address",
              "IPv6 Ranges",
              "Assign IPv6 Address",
              "Show/Edit Reserved IPs",
              "Rebuild the IP Address Pool",
              "Show IP Address Usage",
              "Change Site's IP Address",
              "Change Multiple Sites' IP Addresses",
              "Configure Remote Service IPs",
              "IP Migration Wizard",
              "NAT",
              "Server IP Setup",
              "Web Server Reserved IPs"
            ],
            "summary": "The IP pool: bound addresses and NAT mappings, IPv6 ranges, reserved IPs, usage per IP, moving sites between IPs, remote service IPs and the migration wizard."
          },
          {
            "id": "trusted-proxies",
            "name": "Trusted proxies",
            "route": "/whm/server/trusted-proxies",
            "template": "list",
            "artboard": "WhmTrustedProxies",
            "primaryAction": "Add proxy",
            "roles": [
              "root"
            ],
            "tools": [
              "trusted-proxies"
            ],
            "keywords": [
              "Trusted proxies",
              "Real IP",
              "CDN Real Visitor IP",
              "X-Forwarded-For",
              "Cloudflare IPs",
              "Load balancer",
              "mod_remoteip"
            ],
            "summary": "Upstream proxies allowed to set the real client address, so logs, bans and limits see the visitor and not the proxy."
          },
          {
            "id": "scheduled-tasks",
            "name": "Scheduled tasks",
            "route": "/whm/server/cron",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add task",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-cron-tasks",
              "system-maintenance-schedule",
              "aapanel-task-chaining",
              "aapanel-event-triggers",
              "aapanel-script-library",
              "aapanel-webhook"
            ],
            "keywords": [
              "Cron",
              "Root cron jobs",
              "Configure cPanel Cron Jobs",
              "Scheduled Tasks",
              "Task chains",
              "Result triggers",
              "Script library",
              "Webhooks"
            ],
            "summary": "Root's scheduled jobs and the panel's own nightly schedule, with run now and logs, task chains, result triggers, reusable scripts and URL-triggered webhooks."
          },
          {
            "id": "server-nodes",
            "name": "Server nodes",
            "route": "/whm/server/nodes",
            "template": "list",
            "artboard": null,
            "primaryAction": "Link server",
            "roles": [
              "root"
            ],
            "tools": [
              "linked-server-nodes",
              "aapanel-node-management",
              "aapanel-node-file-transfer",
              "configuration-cluster"
            ],
            "keywords": [
              "Link Server Nodes",
              "Multi-Server Nodes",
              "Configuration Cluster",
              "Cluster",
              "Cross-node file transfer",
              "Mail node"
            ],
            "summary": "Other servers linked to this one: offloaded service roles, monitored nodes, cross-node file copy and pushing this server's settings to secondaries."
          },
          {
            "id": "server-role",
            "name": "Server role",
            "route": "/whm/server/role",
            "template": "wizard",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "server-role-profile"
            ],
            "keywords": [
              "Server Profile",
              "Role",
              "DNS-only",
              "Mail-only",
              "Database server role"
            ],
            "summary": "Which service roles this server runs (full stack, DNS, mail or database), reviewed and applied as a job."
          },
          {
            "id": "upgrade",
            "name": "Upgrade",
            "route": "/whm/server/upgrade",
            "template": "custom",
            "artboard": "WhmUpgrade",
            "primaryAction": "Upgrade panel",
            "roles": [
              "root"
            ],
            "tools": [
              "panel-upgrade",
              "update-preferences",
              "panel-change-log"
            ],
            "keywords": [
              "Upgrade to Latest Version",
              "Update Preferences",
              "Change Log",
              "Panel Update and Repair",
              "Release notes",
              "Rollback"
            ],
            "summary": "Release channel and automatic patches, preflight-gated side-by-side upgrade with automatic rollback, repair, history and release notes."
          }
        ]
      },
      {
        "id": "panel",
        "name": "Panel & integrations",
        "icon": "SlidersHorizontal",
        "pages": [
          {
            "id": "panel-settings",
            "name": "Panel settings",
            "route": "/whm/panel/settings",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Review & apply",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-panel-general",
              "tweak-software",
              "tweak-panel-php"
            ],
            "keywords": [
              "General Panel Settings",
              "Panel Runtime Options",
              "Offline mode",
              "Developer mode",
              "Software (Tweak Settings)",
              "cPanel PHP",
              "Panel PHP"
            ],
            "summary": "How the panel itself runs: IPv6, offline mode, identity, default paths, memory saving, integrity checks and its internal PHP limits."
          },
          {
            "id": "panel-data",
            "name": "Panel data & recovery",
            "route": "/whm/panel/data",
            "template": "custom",
            "artboard": "WhmPanelData",
            "primaryAction": "Back up now",
            "roles": [
              "root"
            ],
            "tools": [
              "aapanel-panel-backup-restore",
              "config-as-code"
            ],
            "keywords": [
              "Panel Backup and Restore",
              "Panel database",
              "Configuration backup",
              "Disaster recovery",
              "Panel state",
              "Rebuild from configuration files",
              "Panel store",
              "Internal database"
            ],
            "summary": "The panel's own data store, kept apart from the customer database servers: its health and location, backup and restore with overwrite control, and a rebuild from the configuration files on disk, which stay the source of truth if the store is lost."
          },
          {
            "id": "branding",
            "name": "Branding & themes",
            "route": "/whm/panel/branding",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "root"
            ],
            "tools": [
              "panel-branding",
              "theme-manager",
              "tweak-display"
            ],
            "keywords": [
              "Customization",
              "cPanel Branding",
              "Theme Manager",
              "Display (Tweak Settings)",
              "Logo",
              "Panel Page Customization"
            ],
            "summary": "Logos, accent, favicon, help links and contact details users see, theme packages for the panels, login and webmail, and default display options."
          },
          {
            "id": "languages",
            "name": "Languages",
            "route": "/whm/panel/languages",
            "template": "list",
            "artboard": "WhmLanguages",
            "primaryAction": "Add locale",
            "roles": [
              "root"
            ],
            "tools": [
              "application-locales",
              "locale-list",
              "locale-edit",
              "locale-copy",
              "locale-xml-import",
              "locale-xml-export",
              "locale-delete"
            ],
            "keywords": [
              "Locales",
              "Configure Application Locales",
              "View Available Locales",
              "Edit a Locale",
              "Copy a Locale",
              "Locale XML Upload",
              "Locale XML Download",
              "Delete a Locale",
              "Translation",
              "Arabic",
              "RTL"
            ],
            "summary": "Which languages each interface offers, installed locales with direction, string overrides, copies, import/export and removal of custom locales."
          },
          {
            "id": "notifications",
            "name": "Notifications",
            "route": "/whm/panel/notifications",
            "template": "matrix",
            "artboard": "WhmNotifications",
            "primaryAction": "Save",
            "roles": [
              "root"
            ],
            "tools": [
              "notification-center",
              "tweak-notifications",
              "tweak-status",
              "system-mail-forwarding",
              "notification-channels"
            ],
            "keywords": [
              "Contact Manager",
              "Notification Center",
              "Notification channels",
              "Alert tasks",
              "Panel Security Alerts",
              "Notification thresholds",
              "Load threshold",
              "Edit System Mail Preferences",
              "Forward root mail"
            ],
            "summary": "Per-event importance and channels with send test, the warning thresholds and load level, and forwarding of root and system mailboxes."
          },
          {
            "id": "integrations",
            "name": "Integrations",
            "route": "/whm/panel/integrations",
            "template": "list",
            "artboard": "WhmIntegrations",
            "primaryAction": "Connect service",
            "roles": [
              "root"
            ],
            "tools": [
              "integrations-hub",
              "error-reporting"
            ],
            "keywords": [
              "Integrations",
              "Billing",
              "Webhooks",
              "Connected services",
              "Third-party connections"
            ],
            "summary": "Every third-party connection in one place: billing, Cloudflare, backup storage, SMTP relay, notification channels and webhooks."
          },
          {
            "id": "whmcs",
            "name": "WHMCS",
            "route": "/whm/panel/whmcs",
            "template": "settings",
            "artboard": "WhmWhmcs",
            "primaryAction": "Connect WHMCS",
            "roles": [
              "root"
            ],
            "tools": [
              "whmcs-integration"
            ],
            "keywords": [
              "WHMCS",
              "Billing provisioning",
              "Provisioning module",
              "Billing system"
            ],
            "summary": "Provision and manage hosting from WHMCS with xPanel's provisioning module and a scoped API token."
          },
          {
            "id": "api-tokens",
            "name": "API tokens",
            "route": "/whm/panel/api-tokens",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create token",
            "roles": [
              "root"
            ],
            "tools": [
              "xwhm-api-tokens"
            ],
            "keywords": [
              "Manage API Tokens",
              "Panel API Access",
              "API keys",
              "Remote access key"
            ],
            "summary": "Admin API tokens with privilege subsets, expiry and IP restrictions."
          },
          {
            "id": "developer-tools",
            "name": "Developer tools",
            "route": "/whm/panel/developer",
            "template": "custom",
            "artboard": "WhmDeveloper",
            "primaryAction": null,
            "roles": [
              "root"
            ],
            "tools": [
              "xwhm-api-shell",
              "hooks-manager",
              "registered-apps",
              "plugin-generator",
              "tweak-development",
              "metrics-export",
              "api-explorer"
            ],
            "keywords": [
              "API Shell",
              "Manage Hooks",
              "AppConfig",
              "Registered applications",
              "cPanel Plugin File Generator",
              "Development (Tweak Settings)",
              "Debug"
            ],
            "summary": "API console, event hooks, the app registry, the user-panel plugin generator and debug switches."
          },
          {
            "id": "my-preferences",
            "name": "My preferences",
            "route": "/whm/preferences",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "root",
              "reseller"
            ],
            "tools": [
              "aapanel-language-theme"
            ],
            "keywords": [
              "Change Language",
              "Dark Mode",
              "Theme",
              "Appearance",
              "Profile",
              "Language and Dark Mode"
            ],
            "summary": "The signed-in admin's own language, theme and appearance, opened from the avatar menu."
          }
        ]
      }
    ]
  },
  {
    "surface": "xmail",
    "sections": [
      {
        "id": "mail",
        "name": "Mail",
        "icon": "Inbox",
        "pages": [
          {
            "id": "inbox",
            "name": "Inbox",
            "route": "/mail/inbox",
            "template": "custom",
            "artboard": "MailInbox",
            "primaryAction": "Compose",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-message-list",
              "webmail-message-read"
            ],
            "keywords": [
              "Inbox",
              "Webmail",
              "Messages",
              "Read mail",
              "Threads",
              "Reply",
              "Forward",
              "Attachments",
              "Search mail",
              "Mark as junk",
              "Not junk",
              "Quota",
              "Rebuild search index"
            ],
            "summary": "List, read and delete the messages in this mailbox."
          },
          {
            "id": "compose",
            "name": "Compose",
            "route": "/mail/compose",
            "template": "editor",
            "artboard": "MailCompose",
            "primaryAction": "Send",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-compose"
            ],
            "keywords": [
              "Compose",
              "New message",
              "Write email",
              "Send mail",
              "Draft"
            ],
            "summary": "Write a plain-text message and send it through the local mail server."
          },
          {
            "id": "folders",
            "name": "Folders",
            "route": "/mail/folders",
            "template": "list",
            "artboard": null,
            "primaryAction": "Create folder",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-folders"
            ],
            "keywords": [
              "Folders",
              "Manage folders",
              "IMAP folders",
              "Subscribe",
              "Subfolders"
            ],
            "summary": "Create, nest, rename, subscribe to and delete mail folders; system folders stay protected."
          },
          {
            "id": "mail-later",
            "name": "More mail tools",
            "route": "/mail/later",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-reply-forward",
              "webmail-attachments",
              "webmail-search",
              "webmail-spam-marking",
              "webmail-quota",
              "webmail-search-index"
            ],
            "keywords": [
              "Reply",
              "Forward",
              "Attachments",
              "Search mail",
              "Quota"
            ],
            "summary": "Reply, attachments, search, junk marking and mailbox quota."
          }
        ]
      },
      {
        "id": "calendar-contacts",
        "name": "Calendar & contacts",
        "icon": "CalendarDays",
        "pages": [
          {
            "id": "calendar",
            "name": "Calendar",
            "route": "/mail/calendar",
            "template": "custom",
            "artboard": "MailCalendar",
            "primaryAction": "New event",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-calendar"
            ],
            "keywords": [
              "Calendar",
              "Web calendar",
              "Events",
              "Meetings",
              "Shared calendars"
            ],
            "summary": "View and edit events in your own and shared calendars."
          },
          {
            "id": "contacts",
            "name": "Contacts",
            "route": "/mail/contacts",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add contact",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-address-book"
            ],
            "keywords": [
              "Address Book",
              "Contacts",
              "Contact groups",
              "Import contacts"
            ],
            "summary": "Keep your contacts and contact groups, used for compose autocomplete and synced to your devices."
          },
          {
            "id": "calendar-contact-settings",
            "name": "Calendars & address books",
            "route": "/mail/settings/calendars",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Create calendar",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-dav-collections",
              "webmail-dav-sharing",
              "webmail-dav-config"
            ],
            "keywords": [
              "Calendars and Contacts",
              "Calendars and Contacts Management",
              "Calendars and Contacts Sharing",
              "Calendars and Contacts Configuration",
              "CalDAV",
              "CardDAV",
              "Sync calendar",
              "Share calendar",
              "Task lists"
            ],
            "summary": "Create and manage your calendars, address books and task lists, share them with other mailboxes and get the settings to sync them on devices."
          }
        ]
      },
      {
        "id": "rules-spam",
        "name": "Rules & spam",
        "icon": "ListFilter",
        "pages": [
          {
            "id": "filters",
            "name": "Email filters",
            "route": "/mail/settings/filters",
            "template": "list",
            "artboard": "MailFilters",
            "primaryAction": "Create filter",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-email-filters",
              "webmail-filter-test"
            ],
            "keywords": [
              "Email Filters",
              "Filter test",
              "Test filters",
              "Rules",
              "Sieve",
              "Move to folder"
            ],
            "summary": "Define ordered rules that act on incoming mail and test them against a sample message."
          },
          {
            "id": "spam",
            "name": "Spam filters",
            "route": "/mail/settings/spam",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-spam-box",
              "webmail-spam-autodelete",
              "webmail-boxtrapper"
            ],
            "keywords": [
              "Spam Filters",
              "Spam Box",
              "Junk folder",
              "Auto-delete spam",
              "Spam threshold",
              "BoxTrapper",
              "Sender verification",
              "Challenge-response"
            ],
            "summary": "Send flagged mail to Junk, auto-delete high-scoring spam and hold mail from unknown senders until they verify."
          },
          {
            "id": "autoresponder",
            "name": "Autoresponder",
            "route": "/mail/settings/autoresponder",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-autoresponder"
            ],
            "keywords": [
              "Autoresponders",
              "Vacation reply",
              "Out of office",
              "Away message"
            ],
            "summary": "Set your away reply with a schedule and per-sender throttling."
          },
          {
            "id": "forwarders",
            "name": "Forwarders",
            "route": "/mail/settings/forwarders",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add forwarder",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-forwarders"
            ],
            "keywords": [
              "Forwarders",
              "Forward mail",
              "Mailbox forwarders",
              "Copy to another address"
            ],
            "summary": "Send copies of your incoming mail to other addresses and see how it is routed."
          }
        ]
      },
      {
        "id": "mailbox",
        "name": "Mailbox",
        "icon": "HardDrive",
        "pages": [
          {
            "id": "overview",
            "name": "Overview",
            "route": "/mail/overview",
            "template": "dashboard",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-home"
            ],
            "keywords": [
              "Webmail Home",
              "Home",
              "Mailbox overview",
              "Mailbox usage",
              "Settings"
            ],
            "summary": "See your mailbox usage and reach every self-service mail tool from one place."
          },
          {
            "id": "disk-usage",
            "name": "Disk usage",
            "route": "/mail/tools/disk-usage",
            "template": "list",
            "artboard": null,
            "primaryAction": "Clean up",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-disk-cleanup"
            ],
            "keywords": [
              "Manage Disk Usage",
              "Email Disk Usage",
              "Clean up mailbox",
              "Delete old mail",
              "Folder sizes"
            ],
            "summary": "See folders by size and message count and bulk-delete messages by age, size, read state or a custom query."
          },
          {
            "id": "connect-devices",
            "name": "Connect devices",
            "route": "/mail/tools/connect-devices",
            "template": "custom",
            "artboard": null,
            "primaryAction": "Download setup file",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-mail-client-setup"
            ],
            "keywords": [
              "Configure Mail Client",
              "Connect Devices",
              "Mail client setup",
              "IMAP settings",
              "SMTP settings",
              "POP3",
              "Autoconfig",
              "iPhone mail setup",
              "Outlook setup"
            ],
            "summary": "Get server settings and automatic setup files for desktop and mobile mail apps."
          },
          {
            "id": "track-delivery",
            "name": "Track delivery",
            "route": "/mail/tools/track-delivery",
            "template": "log",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-track-delivery"
            ],
            "keywords": [
              "Track Delivery",
              "Delivery report",
              "Bounce",
              "Why was my mail rejected",
              "Route trace"
            ],
            "summary": "See delivery attempts for your sent and received mail and trace how an address would be routed."
          },
          {
            "id": "mailing-lists",
            "name": "Mailing lists",
            "route": "/mail/tools/mailing-lists",
            "template": "list",
            "artboard": null,
            "primaryAction": null,
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-mailing-lists"
            ],
            "keywords": [
              "Mailing Lists",
              "List admin",
              "Manage list"
            ],
            "summary": "See the mailing lists you administer and open their management."
          }
        ]
      },
      {
        "id": "account",
        "name": "Account",
        "icon": "UserCog",
        "pages": [
          {
            "id": "preferences",
            "name": "Preferences",
            "route": "/mail/settings/preferences",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Save",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-preferences",
              "webmail-plus-addressing",
              "webmail-contact-info"
            ],
            "keywords": [
              "Preferences",
              "Display preferences",
              "Compose preferences",
              "Language",
              "Theme",
              "Plus Addressing",
              "Subaddressing",
              "Contact Information",
              "Login alerts",
              "Notifications"
            ],
            "summary": "Set display, language and compose preferences, plus-addressing behaviour, where notices go and new-login alerts."
          },
          {
            "id": "identities",
            "name": "Identities & signatures",
            "route": "/mail/settings/identities",
            "template": "list",
            "artboard": null,
            "primaryAction": "Add identity",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-identities"
            ],
            "keywords": [
              "Identities",
              "Signatures",
              "Send as",
              "From address",
              "Email signature"
            ],
            "summary": "Manage the sender identities you can use in compose and the signature attached to each."
          },
          {
            "id": "security",
            "name": "Password & security",
            "route": "/mail/settings/security",
            "template": "settings",
            "artboard": null,
            "primaryAction": "Change password",
            "roles": [
              "owner"
            ],
            "tools": [
              "webmail-password",
              "webmail-two-factor",
              "webmail-external-auth",
              "webmail-signin"
            ],
            "keywords": [
              "Password & Security",
              "Change password",
              "Two-Factor Authentication",
              "2FA",
              "External Authentication",
              "Linked External Logins",
              "OpenID Connect",
              "Sign in",
              "Sessions",
              "Sign out everywhere"
            ],
            "summary": "Change your mailbox password, enrol two-factor sign-in, link approved external logins and manage your signed-in sessions."
          }
        ]
      }
    ]
  }
]
